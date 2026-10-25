import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
// @ts-ignore - better-sqlite3 is consumed as an untyped runtime dependency in this repository.
import Database from "better-sqlite3";
import { cleanUserPromptText, type CodexGenerationMetadata } from "./codex-session-index.js";

/** Marks generation metadata recovered from Codex's thread-history database. */
export const CODEX_THREAD_HISTORY_ORIGIN = "codex-thread-history";

export interface CodexThreadHistoryThreadRequest {
  taskId: string;
  /** Image paths seen this scan under the task's folder. */
  seenPaths: string[];
}

/** Minimal surface the session index consumes; keeps the reader substitutable in tests. */
export interface CodexThreadHistorySource {
  prefetchThreads(requests: CodexThreadHistoryThreadRequest[]): Promise<void>;
  imageEventsForThread(taskId: string): Map<string, CodexGenerationMetadata>;
  warnings(): string[];
}

export interface CodexThreadHistoryStats {
  dbOpens: number;
  threadQueries: number;
  cacheReads: number;
  workerQueries: number;
  syncQueries: number;
}

const DB_FILE_RE = /^thread_history_(\d+)\.sqlite$/;

interface DbFingerprint {
  dbPath: string;
  size: number;
  mtimeMs: number;
  walSize: number;
  walMtimeMs: number;
}

interface ThreadCacheEntry {
  events: Map<string, CodexGenerationMetadata>;
  /** Fingerprint the thread was last queried under; a gap re-query only
   * happens when the database changed since this value was recorded. */
  queriedFingerprint: DbFingerprint | null;
}

/** Raw per-thread rows fetched from the database (by the worker or the
 * fallback sync path); all text cleanup and event assembly stays on the main
 * thread so both paths share one implementation. */
interface ThreadQueryPayload {
  ok: true;
  opens: number;
  generations: Array<{ turnId: string; itemId: string; ordinal: number; createdAtMs: number | null; completedAtMs: number | null; savedPath: string; revisedPrompt: string }>;
  userMessages: Array<{ turnId: string; itemId: string; ordinal: number; texts: string[] }>;
  turns: Array<{ turnId: string; firstUserItemId: string | null }>;
}

interface ThreadQueryFailure {
  ok: false;
  error: string;
}

type ThreadQueryResult = ThreadQueryPayload | ThreadQueryFailure | null;

// The worker runs the synchronous SQLite I/O off the main thread: opening the
// multi-gigabyte database can block for hundreds of milliseconds on a cold
// page cache, far above the event-loop budget. It is CJS source evaluated
// inline, and the better-sqlite3 entry is resolved on the main thread. Workers
// in the packaged app read app.asar like the main thread does (and Electron
// loads the native binary from app.asar.unpacked itself), so the resolved
// path is passed through unchanged: only the .node prebuild is unpacked, the
// package's JS entry exists inside app.asar only.
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const Database = require(workerData.betterSqliteEntry);
function category(error) { return String((error && error.message) || error).split("\n")[0].slice(0, 160); }
parentPort.on("message", (request) => {
  const taskId = request.taskId;
  let db;
  try { db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true, timeout: 250 }); }
  catch (error) { parentPort.postMessage({ taskId, ok: false, error: category(error) }); return; }
  try {
    db.prepare("SELECT thread_id, turn_id, item_id, item_type, rollout_ordinal, created_at_ms, completed_at_ms, json_extract(item_json, '$.savedPath') FROM thread_items LIMIT 0").all();
    db.prepare("SELECT thread_id, turn_id, first_user_item_id FROM thread_turns LIMIT 0").all();
    const generations = db.prepare("SELECT turn_id AS turnId, item_id AS itemId, rollout_ordinal AS ordinal, created_at_ms AS createdAtMs, completed_at_ms AS completedAtMs, json_extract(item_json, '$.savedPath') AS savedPath, json_extract(item_json, '$.revisedPrompt') AS revisedPrompt FROM thread_items WHERE thread_id = ? AND item_type = 'imageGeneration'").all(taskId);
    const payload = { taskId, ok: true, opens: 1, generations, userMessages: [], turns: [] };
    if (generations.length) {
      for (const row of db.prepare("SELECT turn_id AS turnId, item_id AS itemId, rollout_ordinal AS ordinal, item_json AS itemJson FROM thread_items WHERE thread_id = ? AND item_type = 'userMessage'").all(taskId)) {
        let texts = [];
        try {
          const parsed = JSON.parse(row.itemJson);
          if (parsed && Array.isArray(parsed.content)) {
            for (const part of parsed.content) if (part && part.type === "text" && typeof part.text === "string") texts.push(part.text);
          }
        } catch {}
        payload.userMessages.push({ turnId: row.turnId, itemId: row.itemId, ordinal: row.ordinal, texts });
      }
      payload.turns = db.prepare("SELECT turn_id AS turnId, first_user_item_id AS firstUserItemId FROM thread_turns WHERE thread_id = ?").all(taskId);
    }
    parentPort.postMessage(payload);
  } catch (error) {
    parentPort.postMessage({ taskId, ok: false, error: category(error) });
  } finally { db.close(); }
});
`;

function resolveBetterSqliteEntry(): string | null {
  try {
    return createRequire(import.meta.url).resolve("better-sqlite3");
  } catch {
    return null;
  }
}

export function createCodexThreadHistoryReader(options: { dir?: string | null; dbPath?: string | null } = {}): CodexThreadHistorySource & { stats(): CodexThreadHistoryStats } {
  const fixedDbPath = options.dbPath ? resolve(options.dbPath) : null;
  const dir = options.dir ? resolve(options.dir) : null;
  const warnings = new Set<string>();
  const cache = new Map<string, ThreadCacheEntry>();
  const stats: CodexThreadHistoryStats = { dbOpens: 0, threadQueries: 0, cacheReads: 0, workerQueries: 0, syncQueries: 0 };
  let worker: { instance: Worker } | null = null;
  let workerPermanentlyFailed = false;

  function currentDbPath(): string | null {
    if (fixedDbPath) return fixedDbPath;
    if (!dir) return null;
    let best: { path: string; version: number } | null = null;
    try {
      for (const name of readdirSync(dir)) {
        const match = DB_FILE_RE.exec(name);
        if (!match) continue;
        const version = Number(match[1]);
        if (!Number.isFinite(version)) continue;
        if (!best || version > best.version) best = { path: join(dir, name), version };
      }
    } catch {
      // Missing or unreadable directory: no thread-history database source.
    }
    return best?.path || null;
  }

  function currentFingerprint(dbPath: string): DbFingerprint | null {
    try {
      const db = statSync(dbPath);
      let walSize = -1;
      let walMtimeMs = -1;
      try {
        const wal = statSync(`${dbPath}-wal`);
        walSize = wal.size;
        walMtimeMs = wal.mtimeMs;
      } catch {
        // No WAL sidecar (or it disappeared mid-stat): the main file still identifies the source.
      }
      return { dbPath, size: db.size, mtimeMs: db.mtimeMs, walSize, walMtimeMs };
    } catch {
      return null;
    }
  }

  function warnOnce(message: string): void {
    warnings.add(message);
  }

  /** Query scheduling rule: generation records never change once written, so a
   * cached thread is only re-queried when a scan saw an image the cache does
   * not cover AND the database changed since that thread was last queried. An
   * image that never matches must therefore not cause a query storm. */
  async function prefetchThreads(requests: CodexThreadHistoryThreadRequest[]): Promise<void> {
    const dbPath = currentDbPath();
    const fingerprint = dbPath ? currentFingerprint(dbPath) : null;
    if (!dbPath || !fingerprint) {
      if (dbPath) warnOnce("codex thread history unavailable: database could not be read");
      return;
    }
    for (const request of requests) {
      const taskId = String(request.taskId || "").trim();
      if (!taskId) continue;
      const seenPaths = Array.isArray(request.seenPaths) ? request.seenPaths : [];
      const entry = cache.get(taskId);
      if (entry) {
        if (entry.queriedFingerprint && sameFingerprint(entry.queriedFingerprint, fingerprint)) continue;
        const cacheCoversEverything = seenPaths.every((seenPath) => entry.events.has(resolve(seenPath)));
        if (cacheCoversEverything) continue;
      }
      const result = await queryThread(dbPath, taskId);
      stats.threadQueries += 1;
      if (result && result.ok === false) warnOnce(`codex thread history unavailable: ${result.error}`);
      if (result?.ok) stats.dbOpens += result.opens || 1;
      cache.set(taskId, {
        // A failed re-query keeps the previously cached events rather than
        // discarding them; the fingerprint is still recorded so the failure is
        // not retried until the database changes again.
        events: result?.ok ? assembleEvents(taskId, result) : entry?.events || new Map(),
        queriedFingerprint: fingerprint,
      });
    }
  }

  async function queryThread(dbPath: string, taskId: string): Promise<ThreadQueryResult> {
    if (!workerPermanentlyFailed) {
      const viaWorker = await queryThreadViaWorker(dbPath, taskId);
      if (viaWorker !== null) {
        stats.workerQueries += 1;
        return viaWorker;
      }
    }
    stats.syncQueries += 1;
    return queryThreadSync(dbPath, taskId);
  }

  async function queryThreadViaWorker(dbPath: string, taskId: string): Promise<ThreadQueryResult> {
    let current = worker;
    if (!current) {
      const betterSqliteEntry = resolveBetterSqliteEntry();
      if (!betterSqliteEntry) {
        workerPermanentlyFailed = true;
        return null;
      }
      try {
        const instance = new Worker(WORKER_SOURCE, {
          eval: true,
          workerData: { dbPath, betterSqliteEntry },
        });
        instance.unref();
        current = worker = { instance };
      } catch {
        workerPermanentlyFailed = true;
        return null;
      }
    }
    const instance = current.instance;
    return await new Promise<ThreadQueryResult>((resolvePromise) => {
      const fail = (message: string) => {
        cleanup();
        worker = null;
        // A worker that failed once (missing module, crashed) is not respawned
        // for every thread of every scan; this run uses the sync path.
        workerPermanentlyFailed = true;
        warnOnce(`codex thread history worker failed (${message}); retrying synchronously`);
        resolvePromise(null);
      };
      const onMessage = (message: { taskId?: unknown; ok?: unknown }) => {
        if (message?.taskId !== taskId) return;
        cleanup();
        resolvePromise(message as unknown as ThreadQueryResult);
      };
      const cleanup = () => {
        instance.off("message", onMessage);
        instance.off("error", onError);
        instance.off("exit", onExit);
      };
      const onError = (error: Error) => fail(error.message);
      const onExit = (code: number) => {
        if (code !== 0) fail(`worker exited with code ${code}`);
        else cleanup();
      };
      instance.on("message", onMessage);
      instance.on("error", onError);
      instance.on("exit", onExit);
      instance.postMessage({ taskId });
    });
  }

  /** Fallback for environments where the worker cannot start; identical
   * queries, run on the calling (async) thread. */
  function queryThreadSync(dbPath: string, taskId: string): ThreadQueryResult {
    let db: InstanceType<typeof Database>;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 250 });
    } catch (error) {
      warnOnce(`codex thread history unavailable: could not open the database (${errorCategory(error)})`);
      return null;
    }
    stats.dbOpens += 1;
    try {
      verifySchema(db);
      return assemblePayload(db, taskId);
    } catch (error) {
      warnOnce(`codex thread history unavailable: ${errorCategory(error)}`);
      return null;
    } finally {
      db.close();
    }
  }

  function imageEventsForThread(taskId: string): Map<string, CodexGenerationMetadata> {
    const cleanTaskId = String(taskId || "").trim();
    if (!cleanTaskId) return new Map();
    stats.cacheReads += 1;
    return cache.get(cleanTaskId)?.events || new Map();
  }

  return {
    prefetchThreads,
    imageEventsForThread,
    warnings: () => [...warnings],
    stats: () => ({ ...stats }),
  };
}

function verifySchema(db: InstanceType<typeof Database>): void {
  db.prepare("SELECT thread_id, turn_id, item_id, item_type, rollout_ordinal, created_at_ms, completed_at_ms, json_extract(item_json, '$.savedPath') FROM thread_items LIMIT 0").all();
  db.prepare("SELECT thread_id, turn_id, first_user_item_id FROM thread_turns LIMIT 0").all();
}

/** Synchronous twin of the worker's payload assembly. */
function assemblePayload(db: InstanceType<typeof Database>, taskId: string): ThreadQueryPayload {
  const generations = db.prepare([
    "SELECT turn_id AS turnId, item_id AS itemId, rollout_ordinal AS ordinal,",
    "created_at_ms AS createdAtMs, completed_at_ms AS completedAtMs,",
    "json_extract(item_json, '$.savedPath') AS savedPath,",
    "json_extract(item_json, '$.revisedPrompt') AS revisedPrompt",
    "FROM thread_items WHERE thread_id = ? AND item_type = 'imageGeneration'",
  ].join(" ")).all(taskId) as unknown as Array<Record<string, unknown>>;
  const payload: ThreadQueryPayload = {
    ok: true,
    opens: 1,
    generations: generations.map((row) => ({
      turnId: String(row.turnId || ""),
      itemId: String(row.itemId || ""),
      ordinal: Number(row.ordinal ?? 0),
      createdAtMs: finiteOrNull(row.createdAtMs),
      completedAtMs: finiteOrNull(row.completedAtMs),
      savedPath: cleanText(row.savedPath),
      revisedPrompt: cleanText(row.revisedPrompt),
    })),
    userMessages: [],
    turns: [],
  };
  if (!payload.generations.length) return payload;
  for (const row of db.prepare([
    "SELECT turn_id AS turnId, item_id AS itemId, rollout_ordinal AS ordinal, item_json AS itemJson",
    "FROM thread_items WHERE thread_id = ? AND item_type = 'userMessage'",
  ].join(" ")).all(taskId) as unknown as Array<Record<string, unknown>>) {
    payload.userMessages.push({ turnId: String(row.turnId || ""), itemId: String(row.itemId || ""), ordinal: Number(row.ordinal ?? 0), texts: messageTexts(String(row.itemJson ?? "")) });
  }
  for (const row of db.prepare("SELECT turn_id AS turnId, first_user_item_id AS firstUserItemId FROM thread_turns WHERE thread_id = ?").all(taskId) as unknown as Array<Record<string, unknown>>) {
    payload.turns.push({ turnId: String(row.turnId || ""), firstUserItemId: typeof row.firstUserItemId === "string" && row.firstUserItemId.trim() ? row.firstUserItemId.trim() : null });
  }
  return payload;
}

/** Main-thread assembly shared by both query paths. */
function assembleEvents(taskId: string, payload: ThreadQueryPayload): Map<string, CodexGenerationMetadata> {
  const events = new Map<string, CodexGenerationMetadata>();
  if (!payload.generations.length) return events;
  const userMessages = new Map<string, Array<{ itemId: string; ordinal: number; text: string }>>();
  for (const message of payload.userMessages) {
    // Same rule as the JSONL path: the last qualifying text part wins.
    let last = "";
    for (const text of message.texts) {
      const cleaned = cleanUserPromptText(text);
      if (cleaned) last = cleaned;
    }
    if (!last) continue;
    const list = userMessages.get(message.turnId) || [];
    list.push({ itemId: message.itemId, ordinal: message.ordinal, text: last });
    userMessages.set(message.turnId, list);
  }
  for (const list of userMessages.values()) list.sort((left, right) => left.ordinal - right.ordinal);
  const firstUserItemIds = new Map<string, string>();
  for (const turn of payload.turns) {
    if (turn.firstUserItemId) firstUserItemIds.set(turn.turnId, turn.firstUserItemId);
  }
  for (const generation of payload.generations) {
    if (!generation.savedPath || !isAbsolute(generation.savedPath)) continue;
    const savedPath = resolve(generation.savedPath);
    events.set(savedPath, {
      taskId,
      prompt: generation.revisedPrompt,
      promptStatus: generation.revisedPrompt ? "image-generation-revised-prompt" : "image-generation-prompt-unavailable",
      userMessage: userMessageForGeneration(generation, userMessages, firstUserItemIds),
      sessionPath: null,
      sessionUpdatedAt: null,
      callId: generation.itemId || null,
      eventKey: null,
      generatedAt: isoFromMs(generation.completedAtMs ?? generation.createdAtMs),
      model: null,
      origin: CODEX_THREAD_HISTORY_ORIGIN,
    });
  }
  return events;
}

function userMessageForGeneration(
  generation: ThreadQueryPayload["generations"][number],
  userMessages: Map<string, Array<{ itemId: string; ordinal: number; text: string }>>,
  firstUserItemIds: Map<string, string>,
): string | null {
  const turnMessages = userMessages.get(generation.turnId);
  if (!turnMessages?.length) return null;
  const firstItemId = firstUserItemIds.get(generation.turnId);
  if (firstItemId) {
    const first = turnMessages.find((message) => message.itemId === firstItemId);
    if (first) return first.text;
  }
  let fallback: { itemId: string; ordinal: number; text: string } | null = null;
  for (const message of turnMessages) {
    if (message.ordinal >= generation.ordinal) break;
    fallback = message;
  }
  return fallback?.text || null;
}

/** Extract the raw text parts of a userMessage item; cleanup happens later on
 * the main thread. */
function messageTexts(itemJson: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(itemJson); } catch { return []; }
  const content = parsed && typeof parsed === "object" && Array.isArray((parsed as { content?: unknown }).content)
    ? (parsed as { content: unknown[] }).content
    : [];
  const texts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const item = part as { type?: unknown; text?: unknown };
    if (item.type === "text" && typeof item.text === "string") texts.push(item.text);
  }
  return texts;
}

function isoFromMs(value: number | null): string | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function finiteOrNull(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sameFingerprint(left: DbFingerprint, right: DbFingerprint): boolean {
  return left.dbPath === right.dbPath
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.walSize === right.walSize
    && left.walMtimeMs === right.walMtimeMs;
}

function errorCategory(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0].slice(0, 160);
}
