import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import type { CodexThreadHistorySource, CodexThreadHistoryThreadRequest } from "./codex-thread-history.js";

export interface CodexGenerationMetadata {
  taskId: string;
  prompt: string;
  promptStatus: string;
  userMessage: string | null;
  sessionPath: string | null;
  sessionUpdatedAt: string | null;
  callId: string | null;
  eventKey: string | null;
  generatedAt: string | null;
  model: string | null;
  /** Where the generation record was recovered from (e.g. the thread-history database). */
  origin?: string | null;
}

export interface CodexTaskMetadata {
  taskId: string;
  fallback: CodexGenerationMetadata;
  imageEvents: Map<string, CodexGenerationMetadata>;
}

export interface CodexSessionImageEvent extends CodexGenerationMetadata {
  eventKey: string;
  sessionPath: string;
  savedPath: string | null;
  status: string;
  resultAvailable: boolean;
  lineStart: number;
  lineLength: number;
}

export interface CodexSessionScanResult {
  files: number;
  changedFiles: number;
  bytesRead: number;
  pendingResults: number;
}

interface SessionState {
  sessionPath: string;
  taskId: string;
  inode: number;
  offset: number;
  size: number;
  mtimeMs: number;
  currentModel: string | null;
  lastUserPrompt: string;
  imageEvents: Map<string, CodexGenerationMetadata>;
  partialLineStart: number;
  partialLineBytes: number;
  partialLineParts: Buffer[];
  partialLineTooLarge: boolean;
}

interface ImageEventPayload {
  callId: string | null;
  revisedPrompt: string;
  resultAvailable: boolean;
  savedPath: string | null;
  status: string;
}

const UUID_SESSION_RE = /([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.jsonl$/i;
export const MAX_CODEX_SESSION_EVENT_LINE_BYTES = 192 * 1024 * 1024;

export interface CodexSessionIndex {
  scan(): Promise<CodexSessionScanResult>;
  /** Warm the thread-history cache for the given tasks (async, yields the
   * event loop between threads); metadataForTask afterwards reads only cache. */
  prefetchThreadHistory(requests: CodexThreadHistoryThreadRequest[]): Promise<void>;
  metadataForTask(taskId: string): CodexTaskMetadata;
  pendingResults(): CodexSessionImageEvent[];
  acknowledgeResult(eventKey: string): void;
  loadResult(event: CodexSessionImageEvent): Promise<string>;
  reset(): void;
}

export function createCodexSessionIndex({ sessionsDir, threadHistory }: { sessionsDir: string; threadHistory?: CodexThreadHistorySource | null }): CodexSessionIndex {
  const root = resolve(sessionsDir);
  const states = new Map<string, SessionState>();
  const pending = new Map<string, CodexSessionImageEvent>();

  async function scan(): Promise<CodexSessionScanResult> {
    const files = await walkJsonlFiles(root);
    const live = new Set(files);
    let changedFiles = 0;
    let bytesRead = 0;

    for (const filePath of files) {
      let info: Stats;
      try { info = await stat(filePath); } catch { continue; }
      if (!info.isFile()) continue;
      let state = states.get(filePath);
      const replaced = Boolean(state && state.inode && info.ino && state.inode !== Number(info.ino));
      const truncated = Boolean(state && info.size < state.offset);
      const rewrittenAtSameSize = Boolean(state && info.size === state.offset && info.mtimeMs !== state.mtimeMs);
      if (!state || replaced || truncated || rewrittenAtSameSize) {
        removePendingForSession(pending, filePath);
        state = newSessionState(filePath, Number(info.ino || 0));
        states.set(filePath, state);
      }
      if (info.size > state.offset) {
        const read = await scanSessionAppend(state, info, pending);
        if (read > 0) changedFiles += 1;
        bytesRead += read;
      }
      state.size = info.size;
      state.mtimeMs = info.mtimeMs;
    }

    for (const sessionPath of [...states.keys()]) {
      if (live.has(sessionPath)) continue;
      states.delete(sessionPath);
      removePendingForSession(pending, sessionPath);
    }
    return { files: files.length, changedFiles, bytesRead, pendingResults: pending.size };
  }

  function metadataForTask(taskId: string): CodexTaskMetadata {
    const cleanTaskId = String(taskId || "").trim();
    const matching: SessionState[] = [];
    for (const state of states.values()) {
      if (state.taskId === cleanTaskId) matching.push(state);
    }
    // One conversation may be paginated across several JSONL files; merge their
    // image events, letting the file with the newer mtime win a savedPath clash.
    const imageEvents = new Map<string, CodexGenerationMetadata>();
    for (const state of [...matching].sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      for (const [savedPath, metadata] of state.imageEvents) imageEvents.set(savedPath, metadata);
    }
    // Conversations migrated off JSONL live only in the thread-history database;
    // its records fill savedPaths the session files never saw (JSONL wins clashes).
    const historyEvents = threadHistory ? threadHistory.imageEventsForThread(cleanTaskId) : null;
    if (historyEvents) {
      for (const [savedPath, metadata] of historyEvents) {
        if (!imageEvents.has(savedPath)) imageEvents.set(savedPath, metadata);
      }
    }
    if (!matching.length && !imageEvents.size) return emptyTaskMetadata(cleanTaskId);
    let selected: SessionState | null = null;
    for (const state of matching) {
      if (!selected || state.mtimeMs > selected.mtimeMs) selected = state;
    }
    if (!selected) {
      return {
        taskId: cleanTaskId,
        fallback: {
          taskId: cleanTaskId,
          prompt: "",
          promptStatus: "not-available",
          userMessage: null,
          sessionPath: null,
          sessionUpdatedAt: null,
          callId: null,
          eventKey: null,
          generatedAt: null,
          model: null,
        },
        imageEvents,
      };
    }
    return {
      taskId: cleanTaskId,
      fallback: {
        taskId: cleanTaskId,
        // The fallback prompt keeps its JSONL meaning, but the user message is
        // only recorded for images that matched a generation record; the task's
        // last utterance must not be attributed to unmatched images.
        prompt: selected.lastUserPrompt,
        promptStatus: selected.lastUserPrompt ? "task-user-prompt" : "not-available-in-session",
        userMessage: null,
        sessionPath: selected.sessionPath,
        sessionUpdatedAt: selected.mtimeMs ? new Date(selected.mtimeMs).toISOString() : null,
        callId: null,
        eventKey: null,
        generatedAt: null,
        model: null,
      },
      imageEvents,
    };
  }
  function pendingResults(): CodexSessionImageEvent[] {
    return [...pending.values()].sort((left, right) => {
      const time = String(left.generatedAt || "").localeCompare(String(right.generatedAt || ""));
      return time || left.eventKey.localeCompare(right.eventKey);
    });
  }
  function acknowledgeResult(eventKey: string): void { pending.delete(eventKey); }
  async function loadResult(event: CodexSessionImageEvent): Promise<string> {
    if (!event.resultAvailable) return "";
    if (event.lineLength <= 0 || event.lineLength > MAX_CODEX_SESSION_EVENT_LINE_BYTES) {
      throw sessionIndexError("CODEX_SESSION_EVENT_TOO_LARGE", "Codex image-generation event exceeds the recovery size limit.");
    }
    const handle = await open(event.sessionPath, "r");
    try {
      const buffer = Buffer.alloc(event.lineLength);
      const read = await handle.read(buffer, 0, event.lineLength, event.lineStart);
      if (read.bytesRead !== event.lineLength) {
        throw sessionIndexError("CODEX_SESSION_EVENT_CHANGED", "Codex session changed while GravityPort was reading an image-generation result.");
      }
      const parsed = JSON.parse(buffer.toString("utf8")) as Record<string, unknown>;
      const payload = extractImageEventPayload(parsed);
      if (!payload) return "";
      if (event.callId && payload.callId && event.callId !== payload.callId) {
        throw sessionIndexError("CODEX_SESSION_EVENT_CHANGED", "Codex image-generation event identity changed while GravityPort was reading it.");
      }
      const item = imageEventObject(parsed);
      return typeof item?.result === "string" ? item.result.trim() : "";
    } finally {
      await handle.close();
    }
  }
  function reset(): void { states.clear(); pending.clear(); }

  async function prefetchThreadHistory(requests: CodexThreadHistoryThreadRequest[]): Promise<void> {
    if (!threadHistory) return;
    await threadHistory.prefetchThreads(requests);
  }

  return { scan, prefetchThreadHistory, metadataForTask, pendingResults, acknowledgeResult, loadResult, reset };
}

async function scanSessionAppend(state: SessionState, info: Stats, pending: Map<string, CodexSessionImageEvent>): Promise<number> {
  const start = state.offset;
  let bytesRead = 0;
  let absoluteOffset = start;
  const stream = createReadStream(state.sessionPath, { start, end: info.size - 1 });
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytesRead += bytes.length;
    let chunkOffset = 0;
    while (chunkOffset < bytes.length) {
      const newline = bytes.indexOf(0x0a, chunkOffset);
      const end = newline < 0 ? bytes.length : newline;
      appendPartialLine(state, bytes.subarray(chunkOffset, end));
      if (newline < 0) break;
      if (state.partialLineBytes > 0 && !state.partialLineTooLarge) {
        const line = state.partialLineParts.length === 1
          ? state.partialLineParts[0]
          : Buffer.concat(state.partialLineParts, state.partialLineBytes);
        parseSessionLine(state, line, state.partialLineStart, pending, info.mtimeMs);
      }
      resetPartialLine(state, absoluteOffset + newline + 1);
      chunkOffset = newline + 1;
    }
    absoluteOffset += bytes.length;
  }
  state.offset = info.size;
  return bytesRead;
}

function appendPartialLine(state: SessionState, segment: Buffer): void {
  if (!segment.length) return;
  state.partialLineBytes += segment.length;
  if (state.partialLineTooLarge || state.partialLineBytes > MAX_CODEX_SESSION_EVENT_LINE_BYTES) {
    state.partialLineTooLarge = true;
    state.partialLineParts = [];
    return;
  }
  state.partialLineParts.push(segment);
}

function resetPartialLine(state: SessionState, nextStart: number): void {
  state.partialLineStart = nextStart;
  state.partialLineBytes = 0;
  state.partialLineParts = [];
  state.partialLineTooLarge = false;
}

function parseSessionLine(state: SessionState, line: Buffer, lineStart: number, pending: Map<string, CodexSessionImageEvent>, sessionMtimeMs: number): void {
  let event: Record<string, unknown>;
  try { event = JSON.parse(line.toString("utf8")); } catch { return; }

  const sessionMeta = event.type === "session_meta" ? asObject(event.payload) : null;
  if (sessionMeta) {
    const sessionId = cleanText(sessionMeta.id || sessionMeta.session_id || sessionMeta.thread_id);
    if (sessionId) state.taskId = sessionId;
  }

  const turnContext = event.type === "turn_context" ? asObject(event.payload) : null;
  if (turnContext) {
    state.currentModel = cleanText(turnContext.model) || state.currentModel;
    return;
  }

  const message = event.type === "response_item" ? asObject(event.payload) : null;
  if (message?.type === "message" && message.role === "user") {
    for (const part of Array.isArray(message.content) ? message.content : []) {
      const item = asObject(part);
      if (item?.type !== "input_text") continue;
      const cleaned = cleanUserPromptText(cleanText(item?.text));
      if (cleaned) state.lastUserPrompt = cleaned;
    }
    return;
  }

  const imagePayload = extractImageEventPayload(event);
  if (!imagePayload) return;
  const generatedAt = cleanText(event.timestamp) || null;
  const callIdentity = imagePayload.callId || `offset-${lineStart}`;
  const eventKey = `${state.sessionPath}::${callIdentity}`;
  const prompt = imagePayload.revisedPrompt;
  const metadata: CodexGenerationMetadata = {
    taskId: state.taskId,
    prompt,
    promptStatus: prompt ? "image-generation-revised-prompt" : "image-generation-prompt-unavailable",
    userMessage: state.lastUserPrompt || null,
    sessionPath: state.sessionPath,
    sessionUpdatedAt: sessionMtimeMs ? new Date(sessionMtimeMs).toISOString() : null,
    callId: imagePayload.callId,
    eventKey,
    generatedAt,
    model: state.currentModel,
  };
  if (imagePayload.savedPath) state.imageEvents.set(imagePayload.savedPath, metadata);
  if (!imagePayload.resultAvailable && !imagePayload.savedPath) return;

  const next: CodexSessionImageEvent = {
    ...metadata,
    eventKey,
    sessionPath: state.sessionPath,
    savedPath: imagePayload.savedPath,
    status: imagePayload.status,
    resultAvailable: imagePayload.resultAvailable,
    lineStart,
    lineLength: line.length,
  };
  const previous = pending.get(eventKey);
  pending.set(eventKey, previous ? mergeSessionImageEvent(previous, next) : next);
}

function extractImageEventPayload(event: Record<string, unknown>): ImageEventPayload | null {
  const item = imageEventObject(event);
  if (!item) return null;
  const type = cleanText(item.type);
  const extension = isImageGenExtensionItem(item);
  if (!extension && type !== "image_generation_end" && type !== "image_generation_call") return null;
  const rawSavedPath = cleanText(item.saved_path || item.savedPath);
  return {
    callId: cleanText(item.call_id || item.id) || null,
    revisedPrompt: cleanText(item.revised_prompt || item.revisedPrompt),
    resultAvailable: typeof item.result === "string" && item.result.trim().length > 0,
    savedPath: rawSavedPath && isAbsolute(rawSavedPath) ? resolve(rawSavedPath) : null,
    status: cleanText(item.status) || (type === "image_generation_end" ? "completed" : ""),
  };
}

function imageEventObject(event: Record<string, unknown>): Record<string, unknown> | null {
  if (event.type === "event_msg" || event.type === "response_item") {
    const payload = asObject(event.payload);
    // Codex 26.x code mode reports image_gen through a generic item event:
    // { type: "item_completed", item: { type: "Extension", kind: "image_gen.generation", revisedPrompt, savedPath, result } }.
    const item = asObject(payload?.item);
    if (item && isImageGenExtensionItem(item)) return item;
    return payload;
  }
  if (event.type === "image_generation_call" || event.type === "image_generation_end") return event;
  return null;
}

function isImageGenExtensionItem(item: Record<string, unknown>): boolean {
  return item.type === "Extension" && item.kind === "image_gen.generation";
}

/** Codex wraps a user turn that carries pasted files in a preamble listing them;
 * the user's own words follow the "## My request:" heading. */
export function stripAttachmentPreamble(text: string): string {
  if (!text.startsWith("# Files mentioned by the user")) return text;
  const marker = text.indexOf("## My request:");
  if (marker < 0) return text;
  return text.slice(marker + "## My request:".length).trim() || text;
}

function mergeSessionImageEvent(previous: CodexSessionImageEvent, next: CodexSessionImageEvent): CodexSessionImageEvent {
  const useNextLine = next.resultAvailable || !previous.resultAvailable;
  return {
    ...previous,
    ...next,
    prompt: next.prompt || previous.prompt,
    promptStatus: next.prompt ? next.promptStatus : previous.promptStatus,
    userMessage: next.userMessage || previous.userMessage,
    savedPath: next.savedPath || previous.savedPath,
    resultAvailable: next.resultAvailable || previous.resultAvailable,
    model: next.model || previous.model,
    generatedAt: next.generatedAt || previous.generatedAt,
    status: next.status || previous.status,
    lineStart: useNextLine ? next.lineStart : previous.lineStart,
    lineLength: useNextLine ? next.lineLength : previous.lineLength,
  };
}

function newSessionState(sessionPath: string, inode: number): SessionState {
  const fileTaskId = UUID_SESSION_RE.exec(sessionPath)?.[1] || basename(sessionPath, extname(sessionPath));
  return {
    sessionPath,
    taskId: fileTaskId,
    inode,
    offset: 0,
    size: 0,
    mtimeMs: 0,
    currentModel: null,
    lastUserPrompt: "",
    imageEvents: new Map(),
    partialLineStart: 0,
    partialLineBytes: 0,
    partialLineParts: [],
    partialLineTooLarge: false,
  };
}

function emptyTaskMetadata(taskId: string): CodexTaskMetadata {
  return {
    taskId,
    fallback: {
      taskId,
      prompt: "",
      promptStatus: "not-available",
      userMessage: null,
      sessionPath: null,
      sessionUpdatedAt: null,
      callId: null,
      eventKey: null,
      generatedAt: null,
      model: null,
    },
    imageEvents: new Map(),
  };
}

async function walkJsonlFiles(root: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return []; throw error; }
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkJsonlFiles(entryPath));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === ".jsonl") files.push(entryPath);
  }
  return files.sort();
}

function removePendingForSession(pending: Map<string, CodexSessionImageEvent>, sessionPath: string): void {
  const prefix = `${sessionPath}::`;
  for (const key of pending.keys()) if (key.startsWith(prefix)) pending.delete(key);
}

/** Codex prepends generated context blocks to some user turns (e.g.
 * `<in-app-browser-context>…</in-app-browser-context>` for its built-in
 * browser); strip every leading paired tag block so only the user's own words
 * remain. An opening tag without its closer stops the stripping, and the
 * unchanged text then fails isUserPrompt as before. */
export function stripLeadingContextTags(text: string): string {
  let rest = text.trim();
  for (;;) {
    const open = /^<([A-Za-z][A-Za-z0-9_-]*)\b[^>]*>/.exec(rest);
    if (!open) return rest;
    const tagName = open[1];
    const closeTag = `</${tagName}>`;
    const close = rest.indexOf(closeTag);
    if (close < 0) return rest;
    rest = rest.slice(close + closeTag.length).trim();
  }
}

/** Shared cleanup for user-message text on both the JSONL and the
 * thread-history database paths: strip leading context tags, reject what is
 * not a user prompt (empty, unclosed tag prefix, environment noise), then
 * drop the attachment preamble. Returns "" when the text must be ignored. */
export function cleanUserPromptText(text: string): string {
  const stripped = stripLeadingContextTags(text);
  if (!isUserPrompt(stripped)) return "";
  return stripAttachmentPreamble(stripped);
}

export function isUserPrompt(text: string): boolean {
  return Boolean(text)
    && text.length <= 12000
    && !text.startsWith("<")
    && !text.startsWith("# AGENTS.md instructions")
    && !text.startsWith("<environment_context>")
    && !text.startsWith("<recommended_plugins>");
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sessionIndexError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
