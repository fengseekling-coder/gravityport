// Task 385 — live deletion requests: the small file protocol between the App's
// local service process and a requester outside it (an MCP AI assistant, or
// the provider-deletion sync inside the service itself) that asks the user
// before an asset the user is currently viewing moves to the Trash.
//
// Every piece of state is a plain JSON file under <libraryDir>/.live/:
//   viewer.json                    — which asset the App viewer shows right now
//   delete-requests/<id>.json      — one delete confirmation request
//   provider-deletion-deferred.json — provider deletions the user did not
//                                    answer in time (re-judged on the next
//                                    report; see lib/provider-deletion-sync.mjs)
// The service process (the one the App window talks to) writes viewer.json and
// polls delete-requests/; the MCP server process creates its own request files
// and waits for a decision. Everything crosses process boundaries through the
// shared library directory, so every write is atomic (temp file + rename) and
// every read treats unparsable JSON as absent — a torn file must never look
// like a decision.
//
// Pure Node: no store, no HTTP. `now`, `isPidAlive` and the timeout are
// injectable so tests can drive the clock.
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const LIVE_DIR_NAME = ".live";
export const VIEWER_FILE_NAME = "viewer.json";
export const DELETE_REQUESTS_DIR_NAME = "delete-requests";
// A viewer record older than this counts as "nobody is watching" even when its
// process still lives: the reporter re-posts every 10 s, so 30 s is three
// missed beats.
export const VIEWER_FRESH_MS = 30_000;
// Finished or abandoned request files are swept 10 minutes after creation.
export const REQUEST_RETENTION_MS = 10 * 60_000;
export const DEFAULT_CONFIRM_TIMEOUT_MS = 60_000;

const STATUS_VALUES = new Set(["pending", "allowed", "denied", "timeout", "cancelled"]);

export function liveDeletionDir(libraryDir) {
  return join(String(libraryDir || ""), LIVE_DIR_NAME);
}

/**
 * The confirmation window. The 60 s default is only shortened for tests:
 * MOSA_DELETE_CONFIRM_TIMEOUT_MS is honored exclusively under MOSA_QA_RUN=1 so
 * a stray environment variable can never silently weaken the real product.
 */
export function confirmTimeoutMs(env = process.env) {
  if (env.MOSA_QA_RUN === "1") {
    const parsed = Number.parseInt(String(env.MOSA_DELETE_CONFIRM_TIMEOUT_MS || ""), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_CONFIRM_TIMEOUT_MS;
}

/** Default pid liveness: signal 0 probes existence without delivering anything. */
export function defaultIsPidAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readJsonFile(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    // A torn or hand-edited file behaves exactly like a missing one.
    return null;
  }
}

async function writeJsonFileAtomic(path, value) {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

/**
 * One protocol instance bound to a library's .live directory. Tests inject
 * `now` and `isPidAlive`; production uses the wall clock and process.kill.
 */
export function createLiveDeletionRequests(options = {}) {
  const dir = liveDeletionRequestsRoot(options);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const isPidAlive = typeof options.isPidAlive === "function" ? options.isPidAlive : defaultIsPidAlive;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : confirmTimeoutMs(options.env);

  const viewerPath = () => join(dir, VIEWER_FILE_NAME);
  const requestsDir = () => join(dir, DELETE_REQUESTS_DIR_NAME);
  const requestPath = (id) => join(requestsDir(), `${encodeURIComponent(String(id || ""))}.json`);

  async function ensureDirs() {
    await mkdir(requestsDir(), { recursive: true });
  }

  // ---- viewer presence ------------------------------------------------------

  /** The App service process records which asset its viewer shows. */
  async function writeViewer({ projectId, assetId, pid = process.pid }) {
    await ensureDirs();
    await writeJsonFileAtomic(viewerPath(), {
      pid: Number(pid),
      projectId: String(projectId || "default"),
      assetId: String(assetId || ""),
      updatedAt: now(),
    });
  }

  /**
   * Clears the presence record — but only when this process owns it, so a
   * service that never wrote the record cannot erase another's.
   */
  async function clearViewer(pid = process.pid) {
    const viewer = await readViewer();
    if (!viewer || Number(viewer.pid) !== Number(pid)) return false;
    await rm(viewerPath(), { force: true });
    return true;
  }

  async function readViewer() {
    return readJsonFile(viewerPath());
  }

  /** Fresh = reported within the last 30 s by a process that still exists. */
  function isViewerFresh(viewer) {
    if (!viewer || typeof viewer !== "object") return false;
    const updatedAt = Number(viewer.updatedAt);
    if (!Number.isFinite(updatedAt)) return false;
    if (now() - updatedAt > VIEWER_FRESH_MS) return false;
    return isPidAlive(Number(viewer.pid));
  }

  // ---- delete requests ------------------------------------------------------

  async function listRequests() {
    let names;
    try {
      names = await readdir(requestsDir());
    } catch {
      return [];
    }
    const requests = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json") || name.includes(".tmp-")) continue;
      const request = await readJsonFile(join(requestsDir(), name));
      if (request && typeof request.id === "string" && request.id) requests.push(request);
    }
    return requests;
  }

  async function readRequest(id) {
    return readJsonFile(requestPath(id));
  }

  /** A requester removes the request file it created once it holds the result. */
  async function deleteRequest(id) {
    await rm(requestPath(id), { force: true });
  }

  /**
   * Creates a request, or returns the still-pending one this requester already
   * has for the same asset (same requester kind + name, same project + asset):
   * a retrying requester must not stack dialogs (DESIGN.md 授权确认框).
   */
  async function createDeleteRequest({ projectId, assetId, requester, extra } = {}) {
    await ensureDirs();
    const cleanProjectId = String(projectId || "default");
    const cleanAssetId = String(assetId || "");
    const kind = String(requester?.kind || "");
    const name = String(requester?.name || "");
    for (const request of await listRequests()) {
      if (request.status !== "pending") continue;
      if (request.projectId !== cleanProjectId || request.assetId !== cleanAssetId) continue;
      if (String(request.requester?.kind || "") !== kind || String(request.requester?.name || "") !== name) continue;
      return { request, merged: true, created: false };
    }
    const createdAt = now();
    const request = {
      id: randomBytes(9).toString("base64url"),
      projectId: cleanProjectId,
      assetId: cleanAssetId,
      requester: { kind, name, pid: Number(requester?.pid || process.pid) },
      createdAt,
      expiresAt: createdAt + timeoutMs,
      status: "pending",
      decidedAt: null,
      ...(extra && typeof extra === "object" ? extra : {}),
    };
    await writeJsonFileAtomic(requestPath(request.id), request);
    return { request, merged: false, created: true };
  }

  /**
   * Writes a one-way decision. `pending` never changes once it has left —
   * and an `allowed` that lands after the window closed is rewritten to
   * `timeout`: the requester treats any post-expiry allow as no answer, so
   * the file must not carry a decision that would be read as one.
   * Pass `enforceExpiry: false` for the requester-side timeout write (the MCP
   * process writing its own expiry), which is by definition past the deadline.
   */
  async function writeDecision(id, status, { enforceExpiry = true } = {}) {
    const request = await readRequest(id);
    if (!request) return { request: null, changed: false };
    if (!STATUS_VALUES.has(status)) throw new Error(`Invalid live-deletion decision status: ${status}`);
    if (request.status !== "pending") return { request, changed: false };
    let finalStatus = status;
    if (enforceExpiry && status === "allowed" && now() > Number(request.expiresAt)) {
      finalStatus = "timeout";
    }
    const next = { ...request, status: finalStatus, decidedAt: now() };
    await writeJsonFileAtomic(requestPath(id), next);
    return { request: next, changed: true };
  }

  async function listPendingRequests() {
    const current = now();
    return (await listRequests())
      .filter((request) => request.status === "pending" && current <= Number(request.expiresAt))
      .sort((a, b) => Number(a.createdAt) - Number(b.createdAt) || String(a.id).localeCompare(String(b.id)));
  }

  /**
   * Maintenance sweep: request files vanish 10 minutes after creation. The
   * caller decides what a timed-out pending row means (the runtime hands
   * jimeng ones to the provider-deletion sync; MCP handles its own).
   */
  async function cleanupOldRequests({ maxAgeMs = REQUEST_RETENTION_MS } = {}) {
    let names;
    try {
      names = await readdir(requestsDir());
    } catch {
      return 0;
    }
    const cutoff = now() - maxAgeMs;
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith(".json") || name.includes(".tmp-")) continue;
      const request = await readJsonFile(join(requestsDir(), name));
      if (!request || Number(request.createdAt) > cutoff) continue;
      await rm(join(requestsDir(), name), { force: true });
      removed += 1;
    }
    return removed;
  }

  /**
   * Poll-side expiry: pending requests past their window become `timeout` in
   * the file. Returns the requests that flipped on this call so the runtime
   * can process jimeng ones (deferred re-judgement) immediately.
   */
  async function markExpiredPendingAsTimeout() {
    const current = now();
    const flipped = [];
    for (const request of await listRequests()) {
      if (request.status !== "pending") continue;
      if (current <= Number(request.expiresAt)) continue;
      const { request: next, changed } = await writeDecision(request.id, "timeout", { enforceExpiry: false });
      if (changed && next) flipped.push(next);
    }
    return flipped;
  }

  return {
    dir,
    timeoutMs,
    viewerPath,
    requestsDir,
    requestPath,
    writeViewer,
    clearViewer,
    readViewer,
    isViewerFresh,
    listRequests,
    readRequest,
    deleteRequest,
    createDeleteRequest,
    writeDecision,
    listPendingRequests,
    cleanupOldRequests,
    markExpiredPendingAsTimeout,
  };
}

function liveDeletionRequestsRoot(options) {
  if (typeof options.dir === "string" && options.dir) return options.dir;
  if (options.libraryDir) return liveDeletionDir(options.libraryDir);
  throw new Error("createLiveDeletionRequests requires dir or libraryDir.");
}
