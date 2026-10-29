// Remembers installs that did not finish, so a failed update is shown to the
// user instead of looping silently: the helper leaves a reason code in
// apply-update-error.log, and the next launch reads it here. Only codes and
// timestamps are stored, never the log text (it carries user paths).
//
// Every entry point swallows its own errors. A broken record must never stop
// the App from starting, so failures degrade to "nothing recorded".
import { readFileSync } from "node:fs";
import { readFile as defaultReadFile, rename as defaultRename, rm as defaultRm, writeFile as defaultWriteFile, mkdir as defaultMkdir } from "node:fs/promises";
import { join } from "node:path";
import { compareVersions } from "./update-service.mjs";

export const UPDATE_FAILURE_CODES = Object.freeze([
  "INSTALL_DIR_BUSY",
  "TARGET_EXISTS",
  "EXTRACT_FAILED",
  "VERIFY_FAILED",
  "REPLACE_FAILED",
  "NEW_VERSION_FAILED",
  "UNKNOWN",
]);
export const UPDATE_FAILURE_CONFIRMED_THRESHOLD = 2;

const MAX_RECORDED_VERSIONS = 5;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PLATFORMS = Object.freeze(["macos", "windows"]);
const FAILURE_LINE = /^GP_UPDATE_FAILURE code=([A-Z_]+) exit=\d+$/;

function updatesRoot(userDataDir) {
  return join(userDataDir, "updates");
}

function attemptFile(userDataDir) {
  return join(updatesRoot(userDataDir), "update-attempt.json");
}

function failuresFile(userDataDir) {
  return join(updatesRoot(userDataDir), "update-failures.json");
}

function failureLogFile({ userDataDir, platform, version }) {
  return join(updatesRoot(userDataDir), platform, version, "apply-update-error.log");
}

// Reads the first line of the helper's log. Anything unreadable, unknown or
// marked as "kept the new version" is UNKNOWN: the old version is still running.
export function failureCodeFromLog(text) {
  // Windows PowerShell writes UTF-8 with a byte-order mark; it is not part of the line.
  const firstLine = String(text ?? "").replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0].trim();
  const match = FAILURE_LINE.exec(firstLine);
  if (!match) return "UNKNOWN";
  return UPDATE_FAILURE_CODES.includes(match[1]) ? match[1] : "UNKNOWN";
}

function sanitizeRecords(value) {
  const records = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return records;
  for (const [version, entry] of Object.entries(value)) {
    if (!VERSION_PATTERN.test(version) || !entry || typeof entry !== "object") continue;
    const count = Number(entry.count);
    if (!Number.isSafeInteger(count) || count < 1) continue;
    records[version] = {
      count,
      lastCode: UPDATE_FAILURE_CODES.includes(entry.lastCode) ? entry.lastCode : "UNKNOWN",
      lastAt: typeof entry.lastAt === "string" ? entry.lastAt : "",
    };
  }
  return records;
}

async function readRecords(userDataDir, fs) {
  try {
    return sanitizeRecords(JSON.parse(await fs.readFile(failuresFile(userDataDir), "utf8")));
  } catch {
    return {};
  }
}

async function writeRecords(userDataDir, records, fs) {
  const newest = Object.entries(records)
    .sort(([, left], [, right]) => String(right.lastAt).localeCompare(String(left.lastAt)))
    .slice(0, MAX_RECORDED_VERSIONS);
  const target = failuresFile(userDataDir);
  await fs.mkdir(updatesRoot(userDataDir), { recursive: true });
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(Object.fromEntries(newest), null, 2), "utf8");
  await fs.rename(temporary, target);
}

async function removeQuietly(path, fs) {
  await fs.rm(path, { force: true }).catch(() => {});
}

/**
 * Notes that an install was handed to the helper. Called right before the App
 * exits so the next launch can tell whether the new version actually came up.
 */
export async function recordUpdateAttempt({ userDataDir, version, platform, now = Date.now(), fs = defaultFs() } = {}) {
  try {
    if (!VERSION_PATTERN.test(String(version)) || !PLATFORMS.includes(platform)) return false;
    await fs.mkdir(updatesRoot(userDataDir), { recursive: true });
    const record = { version, platform, startedAt: new Date(now).toISOString() };
    await fs.writeFile(attemptFile(userDataDir), JSON.stringify(record), "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Settles a recorded install attempt at launch. Returns null when nothing
 * failed, or { version, count, code } for a failure that was just counted.
 */
export async function settleUpdateAttempt({ userDataDir, currentVersion, now = Date.now(), fs = defaultFs() } = {}) {
  try {
    let attempt;
    try {
      attempt = JSON.parse(await fs.readFile(attemptFile(userDataDir), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      await removeQuietly(attemptFile(userDataDir), fs);
      return null;
    }
    const valid = attempt && typeof attempt === "object"
      && VERSION_PATTERN.test(String(attempt.version))
      && PLATFORMS.includes(attempt.platform);
    if (!valid) {
      await removeQuietly(attemptFile(userDataDir), fs);
      return null;
    }
    const { version, platform } = attempt;
    const records = await readRecords(userDataDir, fs);

    // Running the recorded version or newer: the install landed. Its failure
    // count is cleared, so an old failure never outlives a success.
    if (compareVersions(currentVersion, version) >= 0) {
      delete records[version];
      await writeRecords(userDataDir, records, fs);
      await removeQuietly(attemptFile(userDataDir), fs);
      return null;
    }

    // Still on the old version: the install failed. Its reason code is the
    // helper's first log line; a missing or unreadable log counts as UNKNOWN.
    const logText = await fs.readFile(failureLogFile({ userDataDir, platform, version }), "utf8").catch(() => "");
    const code = failureCodeFromLog(logText);
    const count = (records[version]?.count ?? 0) + 1;
    records[version] = { count, lastCode: code, lastAt: new Date(now).toISOString() };
    await writeRecords(userDataDir, records, fs);
    await removeQuietly(attemptFile(userDataDir), fs);
    await removeQuietly(failureLogFile({ userDataDir, platform, version }), fs);
    return { version, count, code };
  } catch (error) {
    console.warn(`[GravityPort] update install record unavailable: ${error?.code || "UNKNOWN"}`);
    return null;
  }
}

/**
 * Synchronous on purpose: the update scheduler asks while deciding whether to
 * download or announce, and that decision cannot wait on a promise.
 */
export function failureRecordFor({ userDataDir, version, readFile = readFileSync } = {}) {
  try {
    const records = sanitizeRecords(JSON.parse(readFile(failuresFile(userDataDir), "utf8")));
    return records[version] ?? null;
  } catch {
    return null;
  }
}

/** How many installs of this version have failed so far (0 when unknown). */
export function failureCountFor(options = {}) {
  return failureRecordFor(options)?.count ?? 0;
}

function defaultFs() {
  return {
    mkdir: defaultMkdir,
    readFile: defaultReadFile,
    writeFile: defaultWriteFile,
    rename: defaultRename,
    rm: defaultRm,
  };
}
