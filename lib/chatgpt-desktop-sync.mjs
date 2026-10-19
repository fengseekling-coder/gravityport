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
 * - `chatgpt-conversation-resume-tokens-v1`: one entry per conversation the
 *   user sent a prompt in (the key is a JSON array ending with the conversation
 *   id); its `promptMessageId` changes with every prompt sent there.
 *
 * This module turns those into "conversation X had activity at T". Once a
 * conversation has been quiet for `quietMs`, it is handed to the paired
 * capture extension, which opens it in the user's own browser session and
 * captures it through the normal ChatGPT page pipeline. Only conversation ids,
 * timestamps and a hash of the last prompt's message id are kept; no prompt
 * text or resume token is read into the state.
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
// One at a time: the extension opens one window at a time, and a conversation
// it cannot take now would otherwise sit out its whole lease.
const MAX_PENDING = 1;
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
  // conversation id -> hash of the id of the last prompt sent there.
  const promptMarks = {};
  const resumeTokens = atoms?.["chatgpt-conversation-resume-tokens-v1"];
  if (resumeTokens && typeof resumeTokens === "object") {
    for (const [key, value] of Object.entries(resumeTokens)) {
      let parsed;
      try { parsed = JSON.parse(key); } catch { continue; }
      const id = Array.isArray(parsed) ? validConversationId(parsed[parsed.length - 1]) : "";
      const promptMessageId = typeof value?.promptMessageId === "string" ? value.promptMessageId : "";
      if (!id || !promptMessageId) continue;
      promptMarks[id] = createHash("sha256").update(promptMessageId).digest("hex").slice(0, 32);
    }
  }
  return { bindings, promptMarks };
}

function emptyState() {
  return { version: STATE_VERSION, initialized: false, conversations: {} };
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
      // "" = no prompt seen yet; null only on entries written before prompt
      // marks existed, which record their first mark without counting it.
      promptMark: typeof entry.promptMark === "string" ? entry.promptMark : null,
    };
  }
  return { version: STATE_VERSION, initialized: raw.initialized === true, conversations };
}

/**
 * Apply one observation of the desktop app's signals to the tracker state.
 * Pure: returns the next state. The first observation (fresh state) marks every
 * bound conversation once so existing desktop chats get a single catch-up sync.
 * Afterwards a conversation counts as active when it is newly bound or when
 * the last prompt sent in it changed.
 */
export function applyDesktopChatSignals(previous, signals, now) {
  const state = normalizeState(previous);
  const conversations = { ...state.conversations };
  const blank = { activityAt: 0, syncedAt: 0, attempts: 0, leaseUntil: 0, promptMark: "" };
  const touch = (id) => {
    conversations[id] = { ...(conversations[id] || blank), activityAt: now, attempts: 0, leaseUntil: 0 };
  };
  const marks = signals.promptMarks || {};
  for (const id of signals.bindings) {
    if (!state.initialized || !conversations[id]) touch(id);
  }
  for (const [id, mark] of Object.entries(marks)) {
    const entry = conversations[id];
    if (!entry) {
      touch(id);
    } else if (state.initialized && entry.promptMark !== null && entry.promptMark !== mark) {
      touch(id);
    }
    conversations[id] = { ...conversations[id], promptMark: mark };
  }
  const ids = Object.keys(conversations);
  if (ids.length > MAX_TRACKED) {
    const keep = new Set(ids.sort((a, b) => conversations[b].activityAt - conversations[a].activityAt).slice(0, MAX_TRACKED));
    for (const id of ids) if (!keep.has(id)) delete conversations[id];
  }
  return { version: STATE_VERSION, initialized: true, conversations };
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
