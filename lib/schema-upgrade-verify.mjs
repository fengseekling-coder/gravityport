// Post-upgrade whole-library verification, off the open path (audit 261
// mid-23, rule 27 of 2026-10-28). A full integrity_check reads and verifies
// every page of the database; on a large library that blocks whatever thread
// runs it for seconds. The upgrade transaction itself stays synchronous (see
// createSqliteAssetStore), and this module runs the deep check afterwards in
// a worker thread on a separate read-only connection, so the main process
// keeps serving requests while it runs.
//
// The verdict lands in library_meta under SCHEMA_UPGRADE_VERIFY_KEY as JSON:
// { targetVersion, status: "ok" | "failed" | "pending", integrity,
//   foreignKeyViolations, error?, backupPath, checkedAt }. Rules (task 347
// rework 1):
// - a NEW upgrade writes "pending" synchronously at open (createSqliteAssetStore),
//   so even a process killed before maintenance starts — or an upgrade done by
//   an MCP/CLI process that never runs maintenance — leaves a due record.
// - only real damage (SQLITE_CORRUPT / SQLITE_NOTADB, or the checks themselves
//   failing) records the terminal "failed". Infrastructure trouble (cannot
//   open, SQLITE_BUSY, I/O errors, a worker that dies before answering — any
//   exit code) keeps the record "pending" and retries on the next open.
// - a rerun keeps the interrupted record's targetVersion and backupPath: the
//   caller passes null for both on a plain reopen.
// - an abort signal (shutdown) terminates the worker and leaves "pending".
//
// Worker shape copied from lib/codex-thread-history.ts: an eval worker that
// requires better-sqlite3 by its resolved entry path. That works inside the
// packaged asar (no extra file to ship) and has been proven in production by
// the thread-history reader.

import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

export const SCHEMA_UPGRADE_VERIFY_KEY = "schema_upgrade_verify";

const VERIFY_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const Database = require(workerData.betterSqliteEntry);
try {
  const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true, timeout: 250 });
  try {
    const integrity = db.pragma("integrity_check", { simple: true });
    const foreignKeys = db.pragma("foreign_key_check");
    const foreignKeyViolations = Array.isArray(foreignKeys) ? foreignKeys.length : 0;
    const damaged = integrity !== "ok" || foreignKeyViolations > 0;
    parentPort.postMessage({
      // Result-class failure: the check itself ran and said no (either half of
      // the old synchronous verifySchemaUpgradeResult). "ran: true" tells the
      // main process this was a verdict, not a worker-side crash.
      ran: true,
      ok: !damaged,
      integrity: String(integrity),
      foreignKeyViolations,
      error: null,
      errorCode: "",
    });
  } finally { db.close(); }
} catch (error) {
  // Infrastructure-class failure: the worker could not open or read the
  // database at all. The error code travels to the main process, which
  // decides damage (CORRUPT/NOTADB) versus a retryable infrastructure fault.
  parentPort.postMessage({
    ran: false,
    ok: false,
    integrity: null,
    foreignKeyViolations: 0,
    error: String((error && error.message) || error).split("\n")[0].slice(0, 200),
    errorCode: String((error && error.code) || ""),
  });
}
`;

function writeVerifyRecord(database, record) {
  database.prepare(`
    INSERT INTO library_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(SCHEMA_UPGRADE_VERIFY_KEY, JSON.stringify(record), record.checkedAt);
}

function readVerifyRecord(database) {
  const raw = database.prepare("SELECT value FROM library_meta WHERE key = ?").get(SCHEMA_UPGRADE_VERIFY_KEY)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A NEW schema upgrade invalidates any earlier verdict: the just-taken
 * snapshot has to be verified, whatever the previous upgrade recorded.
 * Called synchronously from createSqliteAssetStore right after
 * initializeSchema, so a process killed before background maintenance starts
 * (or an upgrade performed by an MCP/CLI process, which never runs
 * maintenance) still leaves a due "pending" record.
 */
export function markPendingSchemaUpgradeVerify(database, { targetVersion, backupPath }) {
  const checkedAt = new Date().toISOString();
  const record = {
    targetVersion: Number(targetVersion),
    status: "pending",
    integrity: null,
    foreignKeyViolations: 0,
    backupPath: backupPath ?? null,
    checkedAt,
  };
  writeVerifyRecord(database, record);
}

/**
 * Classifies a verification failure: real database damage is terminal
 * ("failed"), everything else (cannot open, SQLITE_BUSY, I/O trouble, a
 * worker that died before answering) is infrastructure and must stay
 * "pending" so the next open retries. "ran: true" means the check itself
 * completed and returned a negative verdict — damage by definition.
 */
export function classifySchemaVerifyFailure({ ran = false, errorCode = "", integrity = null, foreignKeyViolations = 0 } = {}) {
  // The check itself ran and said no — that is damage, whatever it found.
  if (ran) return "corrupt";
  // Opening or reading the database hit damage directly.
  if (errorCode && /^(SQLITE_CORRUPT|SQLITE_NOTADB)/.test(String(errorCode))) return "corrupt";
  // Everything else (cannot open, SQLITE_BUSY, I/O errors, a no-code crash
  // inside the worker) is infrastructure: retry, never call it corruption.
  return "infra";
}

/**
 * Runs the deferred upgrade verification when it is due:
 * - an upgrade happened on this open (the synchronous pending record was
 *   just written), or
 * - an earlier attempt is still "pending" (interrupted, or infrastructure
 *   trouble on a previous run).
 * A finished record (ok/failed) is terminal and skips the check. Resolves
 * with the record that is in library_meta when the function returns (or null
 * when no check was due / the attempt was interrupted). Never throws: an
 * infrastructure failure logs one line and leaves the pending record for the
 * next open. `signal` (shutdown) terminates the worker and leaves the
 * pending record; `spawnWorker` is injectable for tests.
 */
export async function runSchemaUpgradeVerify(database, {
  databasePath,
  targetVersion,
  backupPath = null,
  upgradeHappenedThisOpen = false,
  signal = null,
  spawnWorker = defaultSpawnWorker,
} = {}) {
  if (!databasePath) throw new Error("schema upgrade verify requires databasePath");
  const existing = readVerifyRecord(database);
  // Due when this open upgraded the schema, or when an earlier attempt is
  // still pending. A library that never upgraded — and has no pending
  // attempt — has nothing to verify.
  const verifyIsDue = upgradeHappenedThisOpen || (existing && existing.status === "pending");
  if (!verifyIsDue) return null;
  if (signal?.aborted) return { ...(existing?.status === "pending" ? existing : {}), status: "pending" };

  // A rerun after a kill must keep the original snapshot path and target:
  // on a plain reopen the caller has neither (backupPath null), and losing
  // them would orphan the pre-upgrade snapshot's record (task 347 rework 1).
  const effectiveTarget = upgradeHappenedThisOpen
    ? Number(targetVersion)
    : Number(existing?.targetVersion ?? targetVersion);
  const effectiveBackupPath = upgradeHappenedThisOpen
    ? (backupPath ?? null)
    : (existing?.backupPath ?? backupPath ?? null);

  const checkedAt = new Date().toISOString();
  const pending = {
    targetVersion: effectiveTarget,
    status: "pending",
    integrity: null,
    foreignKeyViolations: 0,
    backupPath: effectiveBackupPath,
    checkedAt,
  };
  // Rewriting the pending record is idempotent for a rerun after a kill.
  writeVerifyRecord(database, pending);

  let betterSqliteEntry;
  try {
    betterSqliteEntry = createRequire(import.meta.url).resolve("better-sqlite3");
  } catch (error) {
    console.warn(`[MOSA] schema upgrade verify could not load better-sqlite3; it retries on the next open: ${error instanceof Error ? error.message : String(error)}`);
    return { ...pending };
  }

  const result = await new Promise((resolve) => {
    // Any exit before a message counts as an infrastructure failure — a
    // worker that exits cleanly (code 0) without answering must not hang the
    // await forever (task 347 rework 1). settle-guarded so the exit event
    // after an error cannot double-resolve.
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        // Shutdown aborts are normal and stay quiet; real faults log one line.
        if (!signal?.aborted) {
          console.warn(`[MOSA] schema upgrade verify worker failed; it retries on the next open: ${String((error && error.message) || error).split("\n")[0].slice(0, 200)}`);
        }
        resolve(null);
        return;
      }
      resolve(value);
    };
    let worker = null;
    const onAbort = () => {
      if (worker && !settled) {
        try { worker.terminate(); } catch { /* already stopped */ }
      }
    };
    const cleanup = () => {
      signal?.removeEventListener?.("abort", onAbort);
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    try {
      worker = spawnWorker({ dbPath: databasePath, betterSqliteEntry });
    } catch (error) {
      finish(null, error);
      return;
    }
    worker.once("message", (message) => {
      finish(message && typeof message === "object" ? message : null, null);
    });
    worker.once("error", (error) => finish(null, error));
    worker.once("exit", (code) => {
      if (!settled) finish(null, new Error(`verify worker exited before answering (code ${code})`));
    });
  });

  if (!result) {
    // Interrupted or infrastructure trouble: the pending record stays for the
    // next open. A shutdown abort refreshed its timestamp; leave it as is.
    if (signal?.aborted) {
      writeVerifyRecord(database, { ...pending, checkedAt: new Date().toISOString() });
    }
    return { ...pending };
  }

  if (!result.ok) {
    const classification = classifySchemaVerifyFailure({
      ran: result.ran === true,
      errorCode: result.errorCode,
      integrity: result.integrity,
      foreignKeyViolations: result.foreignKeyViolations,
    });
    if (classification === "infra") {
      // Cannot open / busy / I/O: not evidence of damage. Keep the pending
      // record (with the failure reason for the log) and retry next open.
      console.warn(`[MOSA] schema upgrade verify could not run (keeps pending; retries on the next open): ${String(result.errorCode || result.error || "unknown error").slice(0, 200)}`);
      writeVerifyRecord(database, { ...pending, error: String(result.error || "").slice(0, 200), checkedAt: new Date().toISOString() });
      return { ...pending };
    }
  }

  const record = {
    targetVersion: pending.targetVersion,
    status: result.ok ? "ok" : "failed",
    integrity: result.integrity ?? null,
    foreignKeyViolations: Number(result.foreignKeyViolations || 0),
    backupPath: pending.backupPath,
    checkedAt: new Date().toISOString(),
  };
  if (!result.ok && result.error) record.error = String(result.error).slice(0, 200);
  writeVerifyRecord(database, record);
  // One line, codes and counts only — never row content from the database.
  if (record.status === "failed") {
    const detail = record.error
      ? `integrity=${record.integrity} error=${record.error}`
      : `integrity=${record.integrity} foreign_key_check violations=${record.foreignKeyViolations}`;
    console.warn(`[MOSA] schema upgrade verify failed after upgrading to v${record.targetVersion}: ${detail}. The pre-upgrade snapshot is kept at ${record.backupPath || "(none)"}.`);
  }
  return record;
}

function defaultSpawnWorker(workerData) {
  return new Worker(VERIFY_WORKER_SOURCE, { eval: true, workerData });
}
