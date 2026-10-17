// Diagnostic log ring buffer for user feedback (task 158).
//
// The local runtime installs the buffer once at startup: console.warn/error
// and [MOSA]-prefixed console.info/log keep flowing to the real console while
// a "ISO time + level + text" line is kept in a bounded ring (400 lines or
// 120 KB, oldest dropped). redactDiagnostics() runs before anything is shown
// in the feedback panel or forwarded to the collection service: library and
// home paths, tokens, long secrets, and emails are masked, and any line that
// might carry asset wording (prompt/instruction/提示词) is dropped entirely.
// The desktop shell main process (desktop/) does not route its logs here.

import { Buffer } from "node:buffer";

const MAX_LINES = 400;
const MAX_BYTES = 120 * 1024;
const MAX_LINE_CHARS = 2000;
const TRUNCATION_MARKER = "…(已截断)";
const MOSA_PREFIX = "[MOSA]";
const SECRET_PLACEHOLDER = "<已隐藏>";

const MATERIAL_LINE_RE = /prompt|instruction|提示词/i;
const MATERIAL_LINE_REPLACEMENT = "<此行已省略：可能含素材文字>";
const TOKEN_ASSIGN_RE = /\b(["']?)(access[_-]?token|refresh[_-]?token|mosa-client-token|client[_-]?token|token)(["']?)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&"',]+)/gi;
const AUTHORIZATION_RE = /\b(authorization)(\s*:\s*).*$/gi;
const BEARER_RE = /\b(bearer)(\s+)(\S+)/gi;
const CODE_PARAM_RE = /\b(code)(=)("[^"]*"|'[^']*'|[^\s&"',]+)/gi;
const LONG_HEX_RE = /\b[0-9a-f]{32,}\b/gi;
const LONG_BASE64_RE = /[A-Za-z0-9+/_-]{40,}/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

let installed = false;
let originalMethods = null;
const lines = [];
let bufferedBytes = 0;

/**
 * Wraps the console methods feeding the ring buffer. Idempotent: a second
 * call never double-wraps. Only the local service process installs this.
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

/** The raw buffered text, one "ISO time level text" line per entry. */
export function getDiagnosticLogText() {
  return lines.join("\n");
}

/**
 * Masks everything the feedback channel must never carry. Applied both when
 * the panel reads the buffer and again at submission time (the forwarded
 * text is never trusted, whoever produced it).
 */
export function redactDiagnostics(text, { homeDir = "", libraryDir = "" } = {}) {
  const source = String(text ?? "");
  if (!source) return "";
  const pathPatterns = [];
  if (libraryDir) pathPatterns.push([pathPattern(libraryDir), "<素材库>"]);
  // Library first: it usually lives inside the home directory, and the more
  // specific replacement must win.
  if (homeDir) pathPatterns.push([pathPattern(homeDir), "~"]);
  return source
    .split(/\r?\n/)
    .map((line) => redactLine(line, pathPatterns))
    .join("\n");
}

function redactLine(line, pathPatterns) {
  // One suspect word retires the whole line: partial masking could still
  // leave asset wording in the panel or on the wire.
  if (MATERIAL_LINE_RE.test(line)) return MATERIAL_LINE_REPLACEMENT;
  let result = line;
  for (const [pattern, replacement] of pathPatterns) result = result.replace(pattern, replacement);
  return result
    .replace(TOKEN_ASSIGN_RE, (_match, openQuote, name, closeQuote, separator) => `${openQuote}${name}${closeQuote}${separator}${SECRET_PLACEHOLDER}`)
    .replace(AUTHORIZATION_RE, (_match, name, separator) => `${name}${separator}${SECRET_PLACEHOLDER}`)
    .replace(BEARER_RE, (_match, name, separator) => `${name}${separator}${SECRET_PLACEHOLDER}`)
    .replace(CODE_PARAM_RE, "code=<已隐藏>")
    .replace(LONG_HEX_RE, SECRET_PLACEHOLDER)
    .replace(LONG_BASE64_RE, SECRET_PLACEHOLDER)
    .replace(EMAIL_RE, "<邮箱>");
}

/**
 * A path pattern that matches with either separator, so a Windows log line
 * using forward slashes is masked the same as one using backslashes. A root
 * separator (POSIX "/...", UNC "\\\\...") is part of the match so it does not
 * survive the replacement.
 */
function pathPattern(path) {
  const value = String(path);
  const rootPrefix = /^[\\/]/.test(value) ? "[\\\\/]" : "";
  const segments = value.split(/[\\/]+/).filter(Boolean).map(escapeRegExp);
  return new RegExp(rootPrefix + segments.join("[\\\\/]"), "gi");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function record(level, text) {
  const time = new Date().toISOString();
  // A multi-line console call occupies one buffered line per physical line,
  // so the 400-line cap means 400 lines in the exported text.
  for (const line of String(text).split(/\r?\n/)) {
    let stored = line;
    if (stored.length > MAX_LINE_CHARS) stored = stored.slice(0, MAX_LINE_CHARS) + TRUNCATION_MARKER;
    const rendered = `${time} ${level} ${stored}`;
    lines.push(rendered);
    bufferedBytes += Buffer.byteLength(rendered, "utf8") + 1;
  }
  while (lines.length > MAX_LINES || bufferedBytes > MAX_BYTES) {
    const dropped = lines.shift();
    bufferedBytes -= Buffer.byteLength(dropped, "utf8") + 1;
  }
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
