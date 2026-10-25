import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
// @ts-ignore - better-sqlite3 is consumed as an untyped runtime dependency in this repository.
import Database from "better-sqlite3";
import { isUserPrompt, stripAttachmentPreamble, type CodexGenerationMetadata } from "./codex-session-index.js";

/** Marks generation metadata recovered from Codex's thread-history database. */
export const CODEX_THREAD_HISTORY_ORIGIN = "codex-thread-history";

/** Minimal surface the session index consumes; keeps the reader substitutable in tests. */
export interface CodexThreadHistorySource {
  imageEventsForThread(taskId: string): Map<string, CodexGenerationMetadata>;
  warnings(): string[];
}

export interface CodexThreadHistoryStats {
  dbOpens: number;
  threadQueries: number;
  cacheHits: number;
}

const DB_FILE_RE = /^thread_history_(\d+)\.sqlite$/;

interface DbFingerprint {
  dbPath: string;
  size: number;
  mtimeMs: number;
  walSize: number;
  walMtimeMs: number;
}

export function createCodexThreadHistoryReader(options: { dir?: string | null; dbPath?: string | null } = {}): CodexThreadHistorySource & { stats(): CodexThreadHistoryStats } {
  const fixedDbPath = options.dbPath ? resolve(options.dbPath) : null;
  const dir = options.dir ? resolve(options.dir) : null;
  const warnings = new Set<string>();
  const cache = new Map<string, Map<string, CodexGenerationMetadata>>();
  let fingerprint: DbFingerprint | null = null;
  const stats: CodexThreadHistoryStats = { dbOpens: 0, threadQueries: 0, cacheHits: 0 };

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

  function imageEventsForThread(taskId: string): Map<string, CodexGenerationMetadata> {
    const cleanTaskId = String(taskId || "").trim();
    if (!cleanTaskId) return new Map();
    const dbPath = currentDbPath();
    const nextFingerprint = dbPath ? currentFingerprint(dbPath) : null;
    if (!dbPath || !nextFingerprint) {
      if (dbPath) warnOnce("codex thread history unavailable: database could not be read");
      if (cache.size) cache.clear();
      fingerprint = null;
      return new Map();
    }
    if (
      !fingerprint
      || fingerprint.dbPath !== nextFingerprint.dbPath
      || fingerprint.size !== nextFingerprint.size
      || fingerprint.mtimeMs !== nextFingerprint.mtimeMs
      || fingerprint.walSize !== nextFingerprint.walSize
      || fingerprint.walMtimeMs !== nextFingerprint.walMtimeMs
    ) {
      cache.clear();
      fingerprint = nextFingerprint;
    }
    const cached = cache.get(cleanTaskId);
    if (cached) {
      stats.cacheHits += 1;
      return cached;
    }
    stats.threadQueries += 1;
    const events = queryThreadEvents(dbPath, cleanTaskId);
    cache.set(cleanTaskId, events);
    return events;
  }

  function queryThreadEvents(dbPath: string, taskId: string): Map<string, CodexGenerationMetadata> {
    const events = new Map<string, CodexGenerationMetadata>();
    let db: InstanceType<typeof Database>;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 250 });
    } catch (error) {
      warnOnce(`codex thread history unavailable: could not open the database (${errorCategory(error)})`);
      return events;
    }
    stats.dbOpens += 1;
    try {
      verifySchema(db);
      loadThread(db, taskId, events);
    } catch (error) {
      warnOnce(`codex thread history unavailable: ${errorCategory(error)}`);
      return new Map();
    } finally {
      db.close();
    }
    return events;
  }

  return {
    imageEventsForThread,
    warnings: () => [...warnings],
    stats: () => ({ ...stats }),
  };
}

interface ImageGenerationRow {
  turnId: string;
  itemId: string;
  ordinal: number;
  createdAtMs: number | null;
  completedAtMs: number | null;
  savedPath: string;
  revisedPrompt: string;
}

interface UserMessageRow {
  turnId: string;
  itemId: string;
  ordinal: number;
  text: string;
}

function verifySchema(db: InstanceType<typeof Database>): void {
  db.prepare("SELECT thread_id, turn_id, item_id, item_type, rollout_ordinal, created_at_ms, completed_at_ms, json_extract(item_json, '$.savedPath') FROM thread_items LIMIT 0").all();
  db.prepare("SELECT thread_id, turn_id, first_user_item_id FROM thread_turns LIMIT 0").all();
}

function loadThread(db: InstanceType<typeof Database>, taskId: string, events: Map<string, CodexGenerationMetadata>): void {
  const generations = db.prepare([
    "SELECT turn_id AS turnId, item_id AS itemId, rollout_ordinal AS ordinal,",
    "created_at_ms AS createdAtMs, completed_at_ms AS completedAtMs,",
    "json_extract(item_json, '$.savedPath') AS savedPath,",
    "json_extract(item_json, '$.revisedPrompt') AS revisedPrompt",
    "FROM thread_items WHERE thread_id = ? AND item_type = 'imageGeneration'",
  ].join(" ")).all(taskId) as unknown as Array<Record<string, unknown>>;
  if (!generations.length) return;

  const userMessages = new Map<string, UserMessageRow[]>();
  for (const row of db.prepare([
    "SELECT turn_id AS turnId, item_id AS itemId, rollout_ordinal AS ordinal, item_json AS itemJson",
    "FROM thread_items WHERE thread_id = ? AND item_type = 'userMessage'",
  ].join(" ")).all(taskId) as unknown as Array<Record<string, unknown>>) {
    const text = userMessageText(String(row.itemJson ?? ""));
    if (!text) continue;
    const turnId = String(row.turnId || "");
    const list = userMessages.get(turnId) || [];
    list.push({ turnId, itemId: String(row.itemId || ""), ordinal: Number(row.ordinal ?? 0), text });
    userMessages.set(turnId, list);
  }
  for (const list of userMessages.values()) list.sort((left, right) => left.ordinal - right.ordinal);

  const firstUserItemIds = new Map<string, string>();
  for (const row of db.prepare("SELECT turn_id AS turnId, first_user_item_id AS firstUserItemId FROM thread_turns WHERE thread_id = ?").all(taskId) as unknown as Array<Record<string, unknown>>) {
    const first = typeof row.firstUserItemId === "string" && row.firstUserItemId.trim() ? row.firstUserItemId.trim() : "";
    if (first) firstUserItemIds.set(String(row.turnId || ""), first);
  }

  for (const generation of generations) {
    const savedPath = cleanText(generation.savedPath);
    if (!savedPath || !isAbsolute(savedPath)) continue;
    const row: ImageGenerationRow = {
      turnId: String(generation.turnId || ""),
      itemId: String(generation.itemId || ""),
      ordinal: Number(generation.ordinal ?? 0),
      createdAtMs: finiteOrNull(generation.createdAtMs),
      completedAtMs: finiteOrNull(generation.completedAtMs),
      savedPath: resolve(savedPath),
      revisedPrompt: cleanText(generation.revisedPrompt),
    };
    events.set(row.savedPath, {
      taskId,
      prompt: row.revisedPrompt,
      promptStatus: row.revisedPrompt ? "image-generation-revised-prompt" : "image-generation-prompt-unavailable",
      userMessage: userMessageForGeneration(row, userMessages, firstUserItemIds),
      sessionPath: null,
      sessionUpdatedAt: null,
      callId: row.itemId || null,
      eventKey: null,
      generatedAt: isoFromMs(row.completedAtMs ?? row.createdAtMs),
      model: null,
      origin: CODEX_THREAD_HISTORY_ORIGIN,
    });
  }
}

function userMessageForGeneration(
  generation: ImageGenerationRow,
  userMessages: Map<string, UserMessageRow[]>,
  firstUserItemIds: Map<string, string>,
): string | null {
  const turnMessages = userMessages.get(generation.turnId);
  if (!turnMessages?.length) return null;
  const firstItemId = firstUserItemIds.get(generation.turnId);
  if (firstItemId) {
    const first = turnMessages.find((message) => message.itemId === firstItemId);
    if (first) return first.text;
  }
  let fallback: UserMessageRow | null = null;
  for (const message of turnMessages) {
    if (message.ordinal >= generation.ordinal) break;
    fallback = message;
  }
  return fallback?.text || null;
}

/** Codex wraps a user turn that carries pasted files in a preamble; the same
 * cleanup as the JSONL session index applies (last qualifying text part wins). */
function userMessageText(itemJson: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(itemJson); } catch { return ""; }
  const content = parsed && typeof parsed === "object" && Array.isArray((parsed as { content?: unknown }).content)
    ? (parsed as { content: unknown[] }).content
    : [];
  let last = "";
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const item = part as { type?: unknown; text?: unknown };
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (item.type === "text" && isUserPrompt(text)) last = stripAttachmentPreamble(text);
  }
  return last;
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

function errorCategory(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0].slice(0, 160);
}
