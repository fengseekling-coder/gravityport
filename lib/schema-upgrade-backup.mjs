import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";

function integerVersion(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
}

export function readSqliteSchemaVersion(database) {
  const table = database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'library_meta' LIMIT 1",
  ).get();
  if (!table) return 0;
  const row = database.prepare("SELECT value FROM library_meta WHERE key = 'schema_version'").get();
  if (!row) return 0;
  const version = integerVersion(row.value);
  if (version == null) throw new Error(`Invalid GravityPort schema version before upgrade: ${row.value ?? ""}`);
  return version;
}

export function schemaUpgradeBackupPath({ libraryDir, fromVersion, toVersion }) {
  const root = resolve(String(libraryDir || ""));
  if (!libraryDir) throw new Error("libraryDir is required for schema upgrade backup.");
  const from = integerVersion(fromVersion);
  const to = integerVersion(toVersion);
  if (from == null || to == null || from >= to) throw new Error("Invalid schema upgrade backup version range.");
  return join(root, ".schema-backups", `mosa-before-v${to}-from-v${from}.db`);
}

function sqliteStringLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function verifyDatabaseIntegrity(database, label, mode = "integrity_check") {
  const result = database.pragma(mode, { simple: true });
  if (result !== "ok") throw new Error(`${label} failed SQLite ${mode}: ${result}`);
}

export function verifySchemaUpgradeResult(database, backup = null) {
  try {
    verifyDatabaseIntegrity(database, "Upgraded GravityPort database");
    const foreignKeys = database.pragma("foreign_key_check");
    if (Array.isArray(foreignKeys) && foreignKeys.length) {
      throw new Error(`Upgraded GravityPort database failed foreign_key_check with ${foreignKeys.length} violation(s).`);
    }
    return true;
  } catch (error) {
    throw schemaUpgradeRecoveryError(error, backup);
  }
}

export function schemaUpgradeRecoveryError(error, backup = null) {
  if (!backup?.created || !backup?.path) return error instanceof Error ? error : new Error(String(error));
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(backup.path)) return error instanceof Error ? error : new Error(message);
  return new Error(`${message} Pre-upgrade snapshot: ${backup.path}`, { cause: error });
}

export function ensureSchemaUpgradeBackup(database, {
  libraryDir,
  targetVersion,
  databaseExisted = true,
} = {}) {
  const target = integerVersion(targetVersion);
  if (target == null) throw new Error("targetVersion is required for schema upgrade backup.");
  if (!databaseExisted) return { created: false, reason: "new-database", fromVersion: 0, targetVersion: target, path: null };

  const current = readSqliteSchemaVersion(database);
  if (current >= target) return { created: false, reason: "current", fromVersion: current, targetVersion: target, path: null };

  // quick_check, not integrity_check: the pre-upgrade gate only has to prove
  // the source is sane enough to VACUUM INTO a snapshot, and quick_check skips
  // the per-index cross-verification that made this pragma a multi-second
  // whole-library read on large libraries (audit 261 mid-23). The upgraded
  // database still gets a full integrity_check after the migration — deferred
  // to background maintenance (see startDeferredMaintenance), so the open
  // itself never waits for it.
  verifyDatabaseIntegrity(database, "Source GravityPort database", "quick_check");
  const backupPath = schemaUpgradeBackupPath({ libraryDir, fromVersion: current, toVersion: target });

  // Task 350: every real upgrade takes a FRESH snapshot, even when a file at
  // the final name already exists. The old reuse rule (created: false) made a
  // reused upgrade skip both the pending check record and the verification —
  // and the stale file could predate the current library content entirely.
  // The library is still on `current` here, so a snapshot taken now is always
  // a valid pre-upgrade image. The partial name carries the pid and a random
  // suffix so two processes upgrading the same library never vacuum into (and
  // delete) the same in-flight file.
  mkdirSync(dirname(backupPath), { recursive: true });
  // Test-only hook (task 350 rework 1): parks the process between the version
  // read and the VACUUM INTO, so a concurrent process can complete the whole
  // upgrade in that window and the test can prove the snapshot gate below.
  // Never set outside that test.
  const readGatePath = String(process.env.MOSA_TEST_SCHEMA_BACKUP_READ_GATE || "");
  if (readGatePath) {
    writeFileSync(readGatePath, String(process.pid), "utf8");
    for (let wait = 0; wait < 3000; wait += 1) {
      if (existsSync(`${readGatePath}.go`)) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  const partialPath = `${backupPath}.partial-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    database.exec(`VACUUM INTO ${sqliteStringLiteral(partialPath)}`);
  } catch (error) {
    try { rmSync(partialPath, { force: true }); } catch { /* nothing to clean */ }
    throw error;
  }
  // Task 350 rework 1: the version was read BEFORE the vacuum — a concurrent
  // process may have committed the whole upgrade in between (App and the
  // background capture service nearly always start together). Vacuuming the
  // ALREADY-UPGRADED library and renaming it over the winner's true
  // pre-upgrade snapshot would feed the verify a post-upgrade baseline (grown
  // FK violations cancel out) and delete the only real recovery copy. Read
  // the snapshot's own version before it earns the final name; a snapshot
  // that is already current is discarded instead of renamed.
  const partialDatabase = new Database(partialPath, { readonly: true, fileMustExist: true });
  let snapshotVersion;
  try {
    snapshotVersion = readSqliteSchemaVersion(partialDatabase);
  } finally {
    partialDatabase.close();
  }
  if (snapshotVersion >= target) {
    try { rmSync(partialPath, { force: true }); } catch { /* nothing to clean */ }
    return { created: false, reason: "current", fromVersion: current, targetVersion: target, path: null };
  }
  try {
    renameSync(partialPath, backupPath);
  } catch (error) {
    // Windows: another process (verify worker, concurrent opener) holding the
    // previous snapshot open blocks the replace. That file is still a valid
    // pre-upgrade snapshot of this same version, so keep it rather than fail
    // the open; the pending record from the process that wins the upgrade
    // lock keeps pointing at it.
    try { rmSync(partialPath, { force: true }); } catch { /* nothing to clean */ }
    if (existsSync(backupPath)) {
      return { created: false, reason: "existing", fromVersion: current, targetVersion: target, path: backupPath };
    }
    throw error;
  }
  return { created: true, reason: "upgrade", fromVersion: current, targetVersion: target, path: backupPath };
}
