// Repo hygiene gate: keeps secrets, private machine paths, working documents,
// oversized files and stray images/video out of what git commits. GitHub push
// protection only knows common platform token formats; this covers the rest.
//
//   node scripts/check-repo-hygiene.mjs            every tracked file (CI)
//   node scripts/check-repo-hygiene.mjs --staged   staged files only (pre-commit hook)
//
// Findings list file and line, never the matched value. Exit code: 0 clean,
// 1 findings, 2 the check itself could not run. Exceptions go in
// scripts/repo-hygiene-allow.txt, one line each, with a reason.
//
// The website repo carries the same logic; only MEDIA_ALLOWED_PATHS differs.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const ALLOW_FILE = "scripts/repo-hygiene-allow.txt";

// Images and video may only live here. An entry ending in "/" is a directory,
// anything else is one exact file.
export const MEDIA_ALLOWED_PATHS = [
  "docs/images/",
  "test/fixtures/",
  "desktop/assets/",
  "web/gravityport/public/",
];

export const RULES = ["secret", "private-path", "work-doc", "big-file", "media"];

const MEDIA_EXTENSION = /\.(?:png|jpe?g|webp|gif|mp4|mov)$/i;
// Never worth reading as text.
const BINARY_EXTENSION = /\.(?:png|jpe?g|webp|gif|mp4|mov|ico|icns|pdf|zip|gz|woff2?|ttf|otf|mp3|wav|webm)$/i;

// Segments or words that mark a working document. Chinese words match anywhere
// in the path; "tasks" and "宣传" must be a whole directory name.
const WORK_DOC_WORDS = ["交接", "任务单", "任务书"];
const WORK_DOC_DIRECTORIES = new Set(["tasks", "宣传"]);
const ENV_TEMPLATE = /^\.env\.(?:example|sample|template)$/i;

const SECRET_PATTERNS = [
  { detail: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { detail: "GitHub fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/ },
  { detail: "AWS access key id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { detail: "Slack token", pattern: /\bxox[bpas]-[A-Za-z0-9-]{10,}/ },
  {
    detail: "sk- API key",
    pattern: /(?<![A-Za-z0-9_-])sk-([A-Za-z0-9_-]{32,})/,
    // Kebab-case prose such as "sk-some-long-feature-name" has no digit.
    accept: (match) => /\d/.test(match[1]),
  },
  { detail: "private key block", pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  {
    detail: "secret-like name assigned a long literal",
    pattern: /(?:token|secret|passw(?:or)?d|api[_-]?key)[A-Za-z0-9_-]*["']?\s*[:=]\s*(["'`])([^"'`\s]{24,})\1/i,
    accept: (match) => looksLikeSecretValue(match[2]),
  },
];

const PLACEHOLDER_VALUE = /x{6,}|\*{3,}|0123456789|example|placeholder|changeme|change-me|your[_-]|redacted|dummy/i;

function looksLikeSecretValue(value) {
  if (!/\d/.test(value) || !/[A-Za-z]/.test(value)) return false;
  if (/^(?:https?:|\.{0,2}\/|\$|process\.|file:)/i.test(value)) return false;
  return !PLACEHOLDER_VALUE.test(value) && !looksLikeIdentifier(value);
}

// "mosa_e2e_client_token_..." is a made-up name, not a random secret: random
// secrets do not split into mostly lowercase English-looking words.
function looksLikeIdentifier(value) {
  const parts = value.split(/[_-]+/).filter(Boolean);
  if (parts.length < 3) return false;
  return parts.filter((part) => /^[a-z]{3,}$/.test(part)).length / parts.length >= 0.5;
}

const POSIX_HOME = /(?<![A-Za-z0-9_.~-])\/Users\/([A-Za-z0-9._-]+)(?=\/)/g;
const WINDOWS_HOME = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}([A-Za-z0-9._-]+)(?=[\\/])/gi;
// Obvious stand-ins and system folders, not real accounts. Anything else after
// /Users/ is treated as a real user name.
const PLACEHOLDER_USERS = new Set([
  "user", "username", "name", "you", "yourname", "your-name", "your_name", "me", "someone",
  "example", "shared", "public", "default", "alice", "bob", "test", "tester", "dev", "zhangsan", "lisi",
]);

function isPlaceholderUser(name) {
  const lower = name.toLowerCase();
  return lower.length <= 1
    || PLACEHOLDER_USERS.has(lower.replace(/\d+$/, ""))
    || /^example[-_]/.test(lower)
    || /^\.+$/.test(lower)
    || /^x+$/.test(lower);
}

/** Findings for one file's text: [{ line, rule, detail }]. Lines are 1-based. */
export function scanText(text) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const { detail, pattern, accept } of SECRET_PATTERNS) {
      const match = pattern.exec(line);
      if (match && (!accept || accept(match))) findings.push({ line: index + 1, rule: "secret", detail });
    }
    if (hasRealHome(line, POSIX_HOME)) findings.push({ line: index + 1, rule: "private-path", detail: "macOS/Linux home path with a user name" });
    if (hasRealHome(line, WINDOWS_HOME)) findings.push({ line: index + 1, rule: "private-path", detail: "Windows home path with a user name" });
  }
  return findings;
}

function hasRealHome(line, pattern) {
  for (const match of line.matchAll(pattern)) {
    if (!isPlaceholderUser(match[1])) return true;
  }
  return false;
}

/** Findings that depend only on the path and size: [{ rule, detail }]. */
export function checkPath(path, size = 0) {
  const findings = [];
  const segments = path.split("/");
  const name = segments[segments.length - 1];
  const directories = segments.slice(0, -1);

  const word = WORK_DOC_WORDS.find((candidate) => path.includes(candidate));
  const directory = directories.find((segment) => WORK_DOC_DIRECTORIES.has(segment));
  if (word) findings.push({ rule: "work-doc", detail: `path contains "${word}"` });
  else if (directory) findings.push({ rule: "work-doc", detail: `path is inside a "${directory}/" folder` });
  else if (isEnvFile(name)) findings.push({ rule: "work-doc", detail: "environment file" });
  else if (/\.log$/i.test(name)) findings.push({ rule: "work-doc", detail: "log file" });

  if (size > MAX_FILE_BYTES) {
    findings.push({ rule: "big-file", detail: `${(size / 1024 / 1024).toFixed(1)} MB, limit is ${MAX_FILE_BYTES / 1024 / 1024} MB` });
  }
  if (MEDIA_EXTENSION.test(name) && !isMediaAllowed(path)) {
    findings.push({ rule: "media", detail: "image/video outside the allowed folders" });
  }
  return findings;
}

function isEnvFile(name) {
  if (ENV_TEMPLATE.test(name)) return false;
  return name === ".env" || name.startsWith(".env.") || name.endsWith(".env");
}

function isMediaAllowed(path) {
  return MEDIA_ALLOWED_PATHS.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));
}

/**
 * Parses the exception list. Lines are `path | reason` (every rule) or
 * `path | rule,rule | reason`. Blank lines and `#` comments are ignored.
 */
export function parseAllowList(text) {
  const entries = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split("|").map((field) => field.trim());
    const where = `${ALLOW_FILE}:${index + 1}`;
    if (fields.length < 2 || !fields[0]) throw new Error(`${where}: expected "path | reason" or "path | rules | reason".`);
    let rules = ["*"];
    let reason = fields.slice(1).join(" | ");
    if (fields.length >= 3) {
      rules = fields[1].split(",").map((rule) => rule.trim()).filter(Boolean);
      reason = fields.slice(2).join(" | ");
      const unknown = rules.filter((rule) => rule !== "*" && !RULES.includes(rule));
      if (rules.length === 0 || unknown.length > 0) {
        throw new Error(`${where}: unknown rule ${unknown.join(", ") || "(empty)"}; use ${RULES.join(", ")} or *.`);
      }
    }
    if (!reason) throw new Error(`${where}: every exception needs a reason.`);
    entries.push({ path: fields[0], rules, reason });
  }
  return entries;
}

function isAllowed(entries, path, rule) {
  return entries.some((entry) => {
    const pathMatches = entry.path.endsWith("/") ? path.startsWith(entry.path) : path === entry.path;
    return pathMatches && (entry.rules.includes("*") || entry.rules.includes(rule));
  });
}

function git(root, args, options = {}) {
  return execFileSync("git", args, { cwd: root, maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], ...options });
}

/** Files git would commit, with blob ids: [{ path, sha }]. */
function listFiles(root, staged) {
  const wanted = staged
    ? new Set(git(root, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"]).toString("utf8").split("\0").filter(Boolean))
    : null;
  const files = [];
  const seen = new Set();
  for (const record of git(root, ["ls-files", "-s", "-z"]).toString("utf8").split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    const [mode, sha] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (mode === "160000" || seen.has(path) || (wanted && !wanted.has(path))) continue;
    seen.add(path);
    files.push({ path, sha });
  }
  return files;
}

function blobSizes(root, shas) {
  const lines = git(root, ["cat-file", "--batch-check"], { input: `${shas.join("\n")}\n` }).toString("utf8").split("\n");
  return new Map(shas.map((sha, index) => [sha, Number(lines[index].split(" ")[2])]));
}

function readBlobs(root, shas) {
  const blobs = new Map();
  if (shas.length === 0) return blobs;
  const output = git(root, ["cat-file", "--batch"], { input: `${shas.join("\n")}\n` });
  let position = 0;
  for (const sha of shas) {
    const newline = output.indexOf(0x0a, position);
    const size = Number(output.toString("utf8", position, newline).split(" ")[2]);
    blobs.set(sha, output.subarray(newline + 1, newline + 1 + size));
    position = newline + 1 + size + 1;
  }
  return blobs;
}

/** Runs every rule over tracked (or staged) files. Returns [{ path, line, rule, detail }]. */
export function collectFindings({ root, staged = false }) {
  const allowPath = join(root, ALLOW_FILE);
  const allowList = existsSync(allowPath) ? parseAllowList(readFileSync(allowPath, "utf8")) : [];
  const files = listFiles(root, staged);
  const sizes = blobSizes(root, [...new Set(files.map((file) => file.sha))]);
  const textShas = new Set(files
    .filter((file) => !BINARY_EXTENSION.test(file.path) && sizes.get(file.sha) <= MAX_FILE_BYTES)
    .map((file) => file.sha));
  const blobs = readBlobs(root, [...textShas]);

  const findings = [];
  for (const { path, sha } of files) {
    findings.push(...checkPath(path, sizes.get(sha)).map((found) => ({ path, line: 0, ...found })));
    const content = blobs.get(sha);
    if (content && !content.subarray(0, 8000).includes(0)) {
      findings.push(...scanText(content.toString("utf8")).map((found) => ({ path, ...found })));
    }
  }
  return findings
    .filter((found) => !isAllowed(allowList, found.path, found.rule))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || a.rule.localeCompare(b.rule)));
}

const HOW_TO_FIX = [
  "",
  "How to fix / 怎么处理:",
  "  secret        replace it with a placeholder or an env var, and rotate the real one / 换成占位符或环境变量，真密钥要作废重发",
  "  private-path  write /Users/<name>/..., $HOME or ~ instead / 改成 /Users/<name>/...、$HOME 或 ~",
  "  work-doc      move it out of the repo (handover notes, tasks, promo, logs, .env belong elsewhere) / 挪到仓库外",
  "  big-file      keep it out of git (release assets live in R2/GitHub Releases) / 不要放进仓库",
  "  media         put it in one of the allowed folders (MEDIA_ALLOWED_PATHS at the top of this script) / 放进允许的目录",
  `  If a hit is genuinely needed, add a line to ${ALLOW_FILE}: path | rule | reason / 确实需要才加例外，并写明原因`,
];

function main(argv) {
  const known = new Set(["--staged", "--help", "-h"]);
  const unknown = argv.filter((arg) => !known.has(arg));
  if (unknown.length > 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log("Usage: node scripts/check-repo-hygiene.mjs [--staged]");
    return unknown.length > 0 ? 2 : 0;
  }
  const staged = argv.includes("--staged");
  let findings;
  try {
    const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
    findings = collectFindings({ root, staged });
  } catch (error) {
    console.error(`Repo hygiene check could not run: ${error.stderr?.toString().trim() || error.message}`);
    return 2;
  }
  if (findings.length === 0) {
    console.log(`Repo hygiene check passed (${staged ? "staged files" : "all tracked files"}).`);
    return 0;
  }
  console.error(`Repo hygiene check found ${findings.length} problem${findings.length === 1 ? "" : "s"}:`);
  for (const { path, line, rule, detail } of findings) {
    console.error(`  ${path}${line ? `:${line}` : ""}  [${rule}] ${detail}`);
  }
  console.error(HOW_TO_FIX.join("\n"));
  return 1;
}

// Importing the module (tests) must not run the check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
