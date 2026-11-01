// Diagnostic log ring buffer for user feedback (task 158; task 315 hardening).
//
// The local runtime installs the buffer once at startup, and the desktop shell
// installs it even earlier so the main process's own logs and crash records
// reach the buffer from the first moment (both installs are idempotent; the
// first wrapper wins). console.warn/error and [MOSA]-prefixed console.info/log
// keep flowing to the real console while a "ISO time + level + text" entry is
// kept in a bounded ring (400 entries or 120 KB, oldest dropped). One console
// call is one entry: embedded newlines are stored as a visible ⏎ so no part of
// a call can shed into a line that dodges the redaction applied to the rest.
// redactDiagnostics() runs before anything is shown in the feedback panel or
// forwarded to the collection service. The desktop main process logs through
// this buffer too; renderer console messages arrive only as a one-line summary
// without their text (writeConsoleOnly sends the full text to the real console
// alone). attachDiagnosticLogFile mirrors warn/error into a local rotated file
// after the same redaction; only the desktop shell attaches it, so several
// processes never race on one file.

import { Buffer } from "node:buffer";
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

const MAX_RECORDS = 400;
const MAX_BYTES = 120 * 1024;
const MAX_RECORD_CHARS = 2000;
const TRUNCATION_MARKER = "…(已截断)";
const MOSA_PREFIX = "[MOSA]";
const SECRET_PLACEHOLDER = "<已隐藏>";
const PATH_PLACEHOLDER = "<路径>";
const LIBRARY_PLACEHOLDER = "<素材库>";
const HOME_PLACEHOLDER = "~";
const NUMBER_PLACEHOLDER = "<号码>";
const HOST_PLACEHOLDER = "<主机名>";
const NEWLINE_MARKER = "⏎";
const LOG_FILE_NAME = "gravityport.log";
const LOG_ROTATE_BYTES = 2 * 1024 * 1024;
const LOG_KEEP = 2;

const MATERIAL_LINE_RE = /prompt|instruction|提示词/i;
const MATERIAL_LINE_REPLACEMENT = "<此行已省略：可能含素材文字>";
const TOKEN_ASSIGN_RE = /\b(["']?)(access[_-]?token|refresh[_-]?token|mosa-client-token|client[_-]?token|token)(["']?)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&"',]+)/gi;
const AUTHORIZATION_RE = /\b(authorization)(\s*:\s*).*$/gi;
const BEARER_RE = /\b(bearer)(\s+)(\S+)/gi;
const CODE_PARAM_RE = /\b(code)(=)("[^"]*"|'[^']*'|[^\s&"',]+)/gi;
const LONG_HEX_RE = /\b[0-9a-f]{32,}\b/gi;
const LONG_BASE64_RE = /[A-Za-z0-9+/_-]{40,}/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Mainland-China phone number and 18-digit resident ID, each bounded by
// non-digits so they never fire inside timestamps or longer numbers.
const ID_NUMBER_RE = /(?<!\d)\d{17}[\dXx](?!\d)/g;
const PHONE_NUMBER_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
// file:// URLs always name a local file; mask them whole.
const FILE_URL_RE = new RegExp(String.raw`\bfile:\/\/[^\s"'` + "`" + String.raw`<>()\[\]{}]+`, "gi");

// ---- Path grammar ---------------------------------------------------------
// One path segment: no separators, whitespace, quotes or prose punctuation.
// Everything else (including CJK) belongs to file and directory names.
const BACKTICK = "`";
const SEGMENT_CHARS = String.raw`[^\\/\s"'` + BACKTICK + String.raw`<>()\[\]{}|;:,?#]`;
const SEGMENT = String.raw`(?:` + SEGMENT_CHARS + String.raw`+)`;
// Either separator, in raw and JSON-escaped spellings.
const SEPARATOR = String.raw`(?:\\\\|\\|/)`;
const DRIVE_ROOT = String.raw`[A-Za-z]:(?:\\\\|\\|/)`;
// A UNC root: two backslashes, or four when the path went through JSON.
const UNC_ROOT = String.raw`(?:\\\\\\\\|\\\\)`;
const PCT_ROOT = String.raw`(?:%2F|%5C)`;
const POSIX_TWO_SEGMENTS = String.raw`/` + SEGMENT + String.raw`(?:` + SEPARATOR + SEGMENT + String.raw`)+`;
// Chars allowed after a root inside quotes or a spaced run: spaces and both
// separators included, quotes and prose punctuation still stop the match.
const SPACED_REST_CHARS = String.raw`[^"'` + BACKTICK + String.raw`<>()\[\]{}|;:,?#]`;
// The space-free variant for the cleanup pass (same class as one segment).
const TIGHT_REST_CHARS = SEGMENT_CHARS;
// A match must not start in the middle of a word, a URL host or a percent
// escape, which is what keeps scheme://host/... paths out of scope.
const NOT_IN_PATH_PREFIX = String.raw`(?<![A-Za-z0-9+.%~\\/\-:])`;

// A path body: a drive, UNC or percent-encoded root plus at least one rest
// character, or a POSIX path of at least two segments plus any remainder.
function pathBody(restClass) {
  return String.raw`(?:(?:` + DRIVE_ROOT + String.raw`|` + UNC_ROOT + String.raw`|` + PCT_ROOT + String.raw`)(?:` + restClass + String.raw`+)`
    + String.raw`|` + POSIX_TWO_SEGMENTS + String.raw`(?:` + restClass + String.raw`*))`;
}
// Quoted (JSON or shell) paths may contain spaces; the closing quote ends them.
const QUOTED_PATH_RE = new RegExp(String.raw`(["'])` + String.raw`(` + pathBody(SPACED_REST_CHARS) + String.raw`)` + String.raw`\1`, "gi");
// Free-standing paths: spaces are allowed so macOS names like "Application
// Support" stay covered, and the trailing prose is cut back off again below.
const SPACED_PATH_RE = new RegExp(NOT_IN_PATH_PREFIX + String.raw`(` + pathBody(SPACED_REST_CHARS) + String.raw`)`, "gi");
// Space-free cleanup pass: it re-sweeps the tails the spaced pass cut loose
// without swallowing any prose around them.
const TIGHT_PATH_RE = new RegExp(NOT_IN_PATH_PREFIX + String.raw`(` + pathBody(TIGHT_REST_CHARS) + String.raw`)`, "gi");

// JSON string values under name-like keys, snake_case or camelCase.
const NAME_KEY_RE = new RegExp(
  String.raw`(")((?:group_?name|stack_?name|session_?title|session_?key|conversation_?id|conversation_?title|host_?name|user_?name|name|title|theme|group|host|user))("\s*:\s*")((?:[^"\\]|\\.)*)(")`,
  "gi",
);

let installed = false;
let originalMethods = null;
const lines = [];
let bufferedBytes = 0;
let fileSink = null;

/**
 * Wraps the console methods feeding the ring buffer. Idempotent: a second
 * call never double-wraps. Both the local service process and the desktop
 * shell call this; whoever installs first owns the wrapper.
 */
export function installDiagnosticLog() {
  if (installed) return;
  installed = true;
  originalMethods = {
    warn: console.warn,
    error: console.error,
    info: console.info,
    log: console.log,
  };
  console.warn = (...args) => {
    record("warn", formatArgs(args));
    originalMethods.warn.apply(console, args);
  };
  console.error = (...args) => {
    record("error", formatArgs(args));
    originalMethods.error.apply(console, args);
  };
  console.info = (...args) => {
    const text = formatArgs(args);
    if (text.startsWith(MOSA_PREFIX)) record("info", text);
    originalMethods.info.apply(console, args);
  };
  console.log = (...args) => {
    const text = formatArgs(args);
    if (text.startsWith(MOSA_PREFIX)) record("log", text);
    originalMethods.log.apply(console, args);
  };
}

/**
 * Restores the original console methods and clears the buffer. Test-only;
 * production keeps the buffer for the lifetime of the service process.
 */
export function uninstallDiagnosticLog() {
  if (!installed) return;
  console.warn = originalMethods.warn;
  console.error = originalMethods.error;
  console.info = originalMethods.info;
  console.log = originalMethods.log;
  originalMethods = null;
  installed = false;
  lines.length = 0;
  bufferedBytes = 0;
}

export function isDiagnosticLogInstalled() {
  return installed;
}

/** The raw buffered text, one "ISO time level text" entry per console call. */
export function getDiagnosticLogText() {
  return lines.join("\n");
}

/**
 * Writes `text` straight to the real console without touching the buffer or
 * the local log file. Used for content that must never be buffered, such as
 * the full renderer console message behind the one-line summary.
 */
export function writeConsoleOnly(level, text) {
  const writer = originalMethods ? originalMethods[level] : console[level];
  if (typeof writer === "function") writer.call(console, String(text));
}

/**
 * Mirrors warn/error records into `<dir>/gravityport.log`, redacted with the
 * same rules, rotating at ~2 MB with two kept generations (~6 MB total).
 * Desktop-only: exactly one process owns a userData directory, so several
 * processes never race on one file. `redactContext` is called on every write
 * (or read as a plain object), so a moved library is followed automatically.
 * Every failure is swallowed: the sink just switches itself off quietly.
 */
export function attachDiagnosticLogFile({ dir, redactContext }) {
  detachDiagnosticLogFile();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    cleanupAgedRotationFiles(dir);
    const path = join(dir, LOG_FILE_NAME);
    const fd = openSync(path, "a", 0o600);
    try {
      chmodSync(path, 0o600);
    } catch {
      // A freshly created file already carries mode 0600.
    }
    fileSink = { fd, dir, redactContext };
  } catch {
    fileSink = null;
  }
}

/** Test-only counterpart of attachDiagnosticLogFile. */
export function detachDiagnosticLogFile() {
  if (!fileSink) return;
  try {
    closeSync(fileSink.fd);
  } catch {
    // Already closed.
  }
  fileSink = null;
}

function cleanupAgedRotationFiles(dir) {
  // Older runs may have left more generations than the cap; remove .3 and up.
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const match = /^gravityport\.log\.(\d+)$/.exec(name);
    if (match && Number(match[1]) >= LOG_KEEP + 1) {
      try {
        unlinkSync(join(dir, name));
      } catch {
        // Keep sweeping the rest.
      }
    }
  }
}

function writeFileSinkLine(rendered) {
  const sink = fileSink;
  if (!sink) return;
  let context = { homeDir: "", libraryDir: "" };
  try {
    const provided = typeof sink.redactContext === "function" ? sink.redactContext() : sink.redactContext;
    if (provided) context = provided;
  } catch {
    // Redact with empty roots rather than skipping the write.
  }
  let line;
  try {
    line = redactDiagnostics(rendered, context) + "\n";
  } catch {
    return;
  }
  try {
    if (statSync(join(sink.dir, LOG_FILE_NAME)).size >= LOG_ROTATE_BYTES) rotateLogFile(sink);
    writeSync(sink.fd, line);
  } catch {
    // Disk full, permissions, vanished directory: give up quietly. Logging
    // must never throw or recurse into the console wrappers it wraps.
    detachDiagnosticLogFile();
  }
}

function rotateLogFile(sink) {
  try {
    closeSync(sink.fd);
  } catch {
    // Reopening below regardless.
  }
  const path = join(sink.dir, LOG_FILE_NAME);
  try {
    unlinkSync(`${path}.${LOG_KEEP}`);
  } catch {
    // No oldest generation yet.
  }
  for (let index = LOG_KEEP - 1; index >= 1; index -= 1) {
    try {
      renameSync(`${path}.${index}`, `${path}.${index + 1}`);
    } catch {
      // Missing generation, keep shifting.
    }
  }
  try {
    renameSync(path, `${path}.1`);
  } catch {
    // Nothing to rotate.
  }
  sink.fd = openSync(path, "a", 0o600);
}

/**
 * Masks everything the feedback channel must never carry. Applied both when
 * the panel reads the buffer and again at submission time (the forwarded
 * text is never trusted, whoever produced it). Every rule must work without
 * homeDir/libraryDir being passed — callers that only forward text still
 * get the full path, number and host masking.
 */
export function redactDiagnostics(text, { homeDir = "", libraryDir = "" } = {}) {
  const source = String(text ?? "");
  if (!source) return "";
  const rootPatterns = [];
  if (libraryDir) rootPatterns.push([rootPattern(libraryDir), LIBRARY_PLACEHOLDER]);
  // Library first: it usually lives inside the home directory, and the more
  // specific replacement must win.
  if (homeDir) rootPatterns.push([rootPattern(homeDir), HOME_PLACEHOLDER]);
  const context = { rootPatterns, hostPatterns: hostnamePatterns() };
  return source
    .split(/\r?\n/)
    .map((line) => redactLine(line, context))
    .join("\n");
}

function redactLine(line, context) {
  // One suspect word retires the whole entry: partial masking could still
  // leave asset wording in the panel or on the wire.
  if (MATERIAL_LINE_RE.test(line)) return MATERIAL_LINE_REPLACEMENT;
  let result = line
    .replace(NAME_KEY_RE, (_match, openQuote, key, mid, _value, closeQuote) => `${openQuote}${key}${mid}${SECRET_PLACEHOLDER}${closeQuote}`);
  result = result.replace(/「([^」]*)」/g, `「${SECRET_PLACEHOLDER}」`).replace(/『([^』]*)』/g, `『${SECRET_PLACEHOLDER}』`);
  result = result.replace(FILE_URL_RE, (match) => PATH_PLACEHOLDER + pathExtensionOf(match.replace(/^file:\/\//i, "")));
  for (const [pattern, placeholder] of context.rootPatterns) {
    result = result.replace(pattern, rootReplacer(placeholder));
  }
  result = maskGenericPaths(result);
  result = result
    .replace(ID_NUMBER_RE, NUMBER_PLACEHOLDER)
    .replace(PHONE_NUMBER_RE, NUMBER_PLACEHOLDER);
  for (const hostRe of context.hostPatterns) {
    result = result.replace(hostRe, HOST_PLACEHOLDER);
  }
  return result
    .replace(TOKEN_ASSIGN_RE, (_match, openQuote, name, closeQuote, separator) => `${openQuote}${name}${closeQuote}${separator}${SECRET_PLACEHOLDER}`)
    .replace(AUTHORIZATION_RE, (_match, name, separator) => `${name}${separator}${SECRET_PLACEHOLDER}`)
    .replace(BEARER_RE, (_match, name, separator) => `${name}${separator}${SECRET_PLACEHOLDER}`)
    .replace(CODE_PARAM_RE, "code=<已隐藏>")
    .replace(LONG_HEX_RE, SECRET_PLACEHOLDER)
    .replace(LONG_BASE64_RE, SECRET_PLACEHOLDER)
    .replace(EMAIL_RE, "<邮箱>");
}

function rootReplacer(placeholder) {
  return (_match, remainder) => {
    if (!remainder) return placeholder;
    const cut = cutPathRun(remainder);
    return placeholder + PATH_PLACEHOLDER + cut.extension + remainder.slice(cut.kept.length);
  };
}

function maskGenericPaths(line) {
  return line
    .replace(QUOTED_PATH_RE, (_match, _quote, body) => PATH_PLACEHOLDER + pathExtensionOf(body))
    .replace(SPACED_PATH_RE, (match) => {
      const cut = cutPathRun(match);
      return PATH_PLACEHOLDER + cut.extension + match.slice(cut.kept.length);
    })
    .replace(TIGHT_PATH_RE, (_match, body) => PATH_PLACEHOLDER + pathExtensionOf(body));
}

/**
 * A spaced run may have picked up trailing prose ("…/a.png done"). Cut it
 * back to the last token that still carries a file extension; when no token
 * has one, keep only the first token so a sentence never disappears. A run
 * without spaces is a real path and stays whole.
 */
function cutPathRun(run) {
  if (!run.includes(" ")) return { kept: run, extension: pathExtensionOf(run) };
  const tokens = run.split(" ");
  let lastExtensionIndex = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    if (/(\.[A-Za-z0-9]{1,8})[)\].,;:!?'"]*$/.test(tokens[index])) lastExtensionIndex = index;
  }
  if (lastExtensionIndex < 0) return { kept: tokens[0], extension: pathExtensionOf(tokens[0]) };
  const kept = tokens.slice(0, lastExtensionIndex + 1).join(" ");
  return { kept, extension: pathExtensionOf(kept) };
}

/**
 * The final path extension of a matched path, percent-decoded first so
 * %2F…%2Fa.png keeps ".png". Anything else yields no extension.
 */
function pathExtensionOf(rawPath) {
  let decoded = String(rawPath);
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    decoded = decoded.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  const lastSegment = decoded.split(/[\\/]/).filter(Boolean).pop() || "";
  const cleaned = lastSegment.split(/[?#]/)[0].replace(/[)\].,;:!?'"]+$/, "");
  const extension = /(\.[A-Za-z0-9]{1,8})$/.exec(cleaned);
  return extension ? extension[1] : "";
}

/**
 * Root pattern for a known directory: matches the directory itself with a
 * trailing boundary (so /Users/zhangsan2 never matches /Users/zhangsan) plus
 * the remainder of the path behind it. The remainder is masked as <路径> by
 * the replacer, because file names are private too.
 */
function rootPattern(root) {
  const value = String(root);
  const rootPrefix = /^[\\/]/.test(value) ? SEPARATOR : "";
  const segments = value.split(/[\\/]+/).filter(Boolean).map(escapeRegExp).join(SEPARATOR);
  return new RegExp(
    String.raw`(?<![A-Za-z0-9_.])` + rootPrefix + segments
    + String.raw`(?=$|[^A-Za-z0-9_.~-])((?:` + SEPARATOR + String.raw`)` + SPACED_REST_CHARS + String.raw`*)?`,
    "gi",
  );
}

/**
 * The local host name (and its bare label when hostname() returns an FQDN),
 * masked on word boundaries. Very short names are skipped to avoid masking
 * whole words by accident.
 */
function hostnamePatterns() {
  let value = "";
  try {
    value = String(hostname() || "").trim();
  } catch {
    return [];
  }
  if (value.length < 3) return [];
  const names = new Set([value]);
  const dotIndex = value.indexOf(".");
  if (dotIndex >= 3) names.add(value.slice(0, dotIndex));
  return [...names]
    .filter((name) => name.length >= 3)
    .map((name) => new RegExp(String.raw`(?<![A-Za-z0-9._-])` + escapeRegExp(name) + String.raw`(?![A-Za-z0-9_-])`, "gi"));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function record(level, text) {
  const time = new Date().toISOString();
  // One console call is one buffered entry: physical newlines become visible
  // ⏎ markers so a multi-line call can never shed a line that dodges the
  // whole-entry redaction of the rest.
  let stored = String(text).replace(/\r?\n/g, NEWLINE_MARKER);
  if (stored.length > MAX_RECORD_CHARS) stored = stored.slice(0, MAX_RECORD_CHARS) + TRUNCATION_MARKER;
  const rendered = `${time} ${level} ${stored}`;
  lines.push(rendered);
  bufferedBytes += Buffer.byteLength(rendered, "utf8") + 1;
  while (lines.length > MAX_RECORDS || bufferedBytes > MAX_BYTES) {
    const dropped = lines.shift();
    bufferedBytes -= Buffer.byteLength(dropped, "utf8") + 1;
  }
  if (level === "warn" || level === "error") writeFileSinkLine(rendered);
}

function formatArgs(args) {
  return args.map((value) => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack || `${value.name || "Error"}: ${value.message}`;
    try {
      const json = JSON.stringify(value);
      return json === undefined ? String(value) : json;
    } catch {
      return String(value);
    }
  }).join(" ");
}
