/**
 * ChatGPT desktop conversation tracker.
 *
 * The ChatGPT desktop app (bundle `com.openai.codex`, which also hosts Codex)
 * renders its chats from `app://-` and never writes generated images or chat
 * text to disk, so neither the Codex session bridge nor the browser capture
 * extension sees them. What the app does persist, in
 * `~/.codex/.codex-global-state.json`, is enough to know *which* ChatGPT
 * conversation the user just used:
 *
 * - `client-thread-bindings-v1`: `local-chatgpt:<local id>` -> ChatGPT
 *   conversation id, one per chat started in the desktop app;
 * - `chatgpt-conversation-resume-tokens-v1`: keyed by the conversation that is
 *   currently open (the key is a JSON array ending with the conversation id);
 * - `prompt-history["chatgpt-global"]`: the composer's up-arrow history, which
 *   changes every time the user sends a chat message.
 *
 * This module turns those into "conversation X had activity at T". Once a
 * conversation has been quiet for `quietMs`, it is handed to the paired
 * capture extension, which opens it in the user's own browser session and
 * captures it through the normal ChatGPT page pipeline. Only conversation ids
 * and timestamps are kept; prompt text is reduced to a hash and never stored.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const STATE_VERSION = 1;
const CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
const DEFAULT_POLL_MS = 10_000;
const DEFAULT_QUIET_MS = 90_000;
const DEFAULT_LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
const MAX_PENDING = 2;
const MAX_TRACKED = 200;
export const DESKTOP_SYNC_OUTCOMES = Object.freeze(["captured", "no-images", "failed", "timeout"]);

function validConversationId(value) {
  const id = String(value || "").trim();
  return CONVERSATION_ID_RE.test(id) ? id : "";
}

/** Reduce the desktop app's global state to the fields this tracker needs. */
export function readDesktopChatSignals(globalState) {
  const atoms = globalState?.["electron-persisted-atom-state"];
  const bindings = [];
  const seen = new Set();
  const rawBindings = atoms?.["client-thread-bindings-v1"];
  if (rawBindings && typeof rawBindings === "object") {
    for (const [key, value] of Object.entries(rawBindings)) {
      if (!key.startsWith("local-chatgpt:")) continue;
      const id = validConversationId(value);
      if (id && !seen.has(id)) {
        seen.add(id);
        bindings.push(id);
      }
    }
  }
  const active = [];
  const resumeTokens = atoms?.["chatgpt-conversation-resume-tokens-v1"];
  if (resumeTokens && typeof resumeTokens === "object") {
    for (const key of Object.keys(resumeTokens)) {
      let parsed;
      try { parsed = JSON.parse(key); } catch { continue; }
      const id = Array.isArray(parsed) ? validConversationId(parsed[parsed.length - 1]) : "";
      if (id && !active.includes(id)) active.push(id);
    }
  }
  const history = atoms?.["prompt-history"]?.["chatgpt-global"];
  const promptSignature = Array.isArray(history)
    ? createHash("sha256").update(JSON.stringify([history.length, history[history.length - 1] ?? null])).digest("hex").slice(0, 32)
    : "";
  return { bindings, active, promptSignature };
}

function emptyState() {
  return { version: STATE_VERSION, initialized: false, promptSignature: "", conversations: {} };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== "object" || raw.version !== STATE_VERSION) return emptyState();
  const conversations = {};
  for (const [id, entry] of Object.entries(raw.conversations || {})) {
    if (!validConversationId(id) || !entry || typeof entry !== "object") continue;
    conversations[id] = {
      activityAt: Number(entry.activityAt) || 0,
      syncedAt: Number(entry.syncedAt) || 0,
      attempts: Math.max(0, Number(entry.attempts) || 0),
      leaseUntil: Number(entry.leaseUntil) || 0,
    };
  }
  return {
    version: STATE_VERSION,
    initialized: raw.initialized === true,
    promptSignature: String(raw.promptSignature || ""),
    conversations,
  };
}

/**
 * Apply one observation of the desktop app's signals to the tracker state.
 * Pure: returns the next state. The first observation (fresh state) marks every
 * bound conversation once so existing desktop chats get a single catch-up sync.
 */
export function applyDesktopChatSignals(previous, signals, now) {
  const state = normalizeState(previous);
  const conversations = { ...state.conversations };
  const touch = (id) => {
    const entry = conversations[id] || { activityAt: 0, syncedAt: 0, attempts: 0, leaseUntil: 0 };
    conversations[id] = { ...entry, activityAt: now, attempts: 0, leaseUntil: 0 };
  };
  if (!state.initialized) {
    for (const id of signals.bindings) touch(id);
  } else {
    for (const id of signals.bindings) {
      if (!conversations[id]) touch(id);
    }
    if (signals.promptSignature && signals.promptSignature !== state.promptSignature) {
      const targets = signals.active.length ? signals.active : signals.bindings.slice(-1);
      for (const id of targets) touch(id);
    }
  }
  const ids = Object.keys(conversations);
  if (ids.length > MAX_TRACKED) {
    const keep = new Set(ids.sort((a, b) => conversations[b].activityAt - conversations[a].activityAt).slice(0, MAX_TRACKED));
    for (const id of ids) if (!keep.has(id)) delete conversations[id];
  }
  return { version: STATE_VERSION, initialized: true, promptSignature: signals.promptSignature, conversations };
}

/** Conversations quiet for at least `quietMs` with activity newer than their last sync. */
export function pendingDesktopConversations(state, now, { quietMs = DEFAULT_QUIET_MS, limit = MAX_PENDING } = {}) {
  return Object.entries(normalizeState(state).conversations)
    .filter(([, entry]) => entry.activityAt > entry.syncedAt
      && now - entry.activityAt >= quietMs
      && entry.leaseUntil <= now
      && entry.attempts < MAX_ATTEMPTS)
    .sort((a, b) => a[1].activityAt - b[1].activityAt)
    .slice(0, limit)
    .map(([id]) => id);
}

export function createChatgptDesktopSync({
  globalStatePath,
  statePath,
  pollMs = DEFAULT_POLL_MS,
  quietMs = DEFAULT_QUIET_MS,
  leaseMs = DEFAULT_LEASE_MS,
  now = () => Date.now(),
  logger = console,
} = {}) {
  let state = emptyState();
  let loaded = false;
  let lastMtimeMs = -1;
  let timer = null;
  let polling = null;
  let writeChain = Promise.resolve();

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      state = normalizeState(JSON.parse(await readFile(statePath, "utf8")));
    } catch {
      state = emptyState();
    }
  }

  function persist() {
    const snapshot = JSON.stringify(state);
    writeChain = writeChain.then(async () => {
      await mkdir(dirname(statePath), { recursive: true });
      const temporaryPath = `${statePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, snapshot);
      await rename(temporaryPath, statePath);
    }).catch((error) => {
      logger?.warn?.(`[MOSA] ChatGPT desktop sync state write failed: ${error?.message || error}`);
    });
    return writeChain;
  }

  async function poll() {
    if (polling) return polling;
    polling = (async () => {
      await load();
      let info;
      try { info = await stat(globalStatePath); } catch { return; }
      if (info.mtimeMs === lastMtimeMs) return;
      let globalState;
      try {
        globalState = JSON.parse(await readFile(globalStatePath, "utf8"));
      } catch {
        // The desktop app rewrites the file in place; a torn read retries next poll.
        return;
      }
      lastMtimeMs = info.mtimeMs;
      const next = applyDesktopChatSignals(state, readDesktopChatSignals(globalState), now());
      if (JSON.stringify(next) !== JSON.stringify(state)) {
        state = next;
        await persist();
      }
    })().finally(() => { polling = null; });
    return polling;
  }

  return {
    async start() {
      await poll();
      if (timer) return;
      timer = setInterval(() => { void poll(); }, pollMs);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await polling;
      await writeChain;
    },
    poll,
    /** Hand out quiet conversations; each is leased so the next status poll does not repeat it. */
    claimPending() {
      if (!loaded || !state.initialized) return [];
      const at = now();
      const ids = pendingDesktopConversations(state, at, { quietMs });
      if (!ids.length) return [];
      for (const id of ids) {
        state.conversations[id] = { ...state.conversations[id], leaseUntil: at + leaseMs };
      }
      void persist();
      return ids;
    },
    acknowledge(conversationId, outcome) {
      const id = validConversationId(conversationId);
      const entry = id ? state.conversations[id] : null;
      if (!entry || !DESKTOP_SYNC_OUTCOMES.includes(outcome)) return { ok: false };
      const done = outcome === "captured" || outcome === "no-images" || entry.attempts + 1 >= MAX_ATTEMPTS;
      state.conversations[id] = done
        ? { ...entry, syncedAt: entry.activityAt, attempts: 0, leaseUntil: 0 }
        : { ...entry, attempts: entry.attempts + 1, leaseUntil: 0 };
      void persist();
      return { ok: true };
    },
    status() {
      const entries = Object.values(state.conversations);
      return {
        tracked: entries.length,
        pending: entries.filter((entry) => entry.activityAt > entry.syncedAt).length,
      };
    },
  };
}
