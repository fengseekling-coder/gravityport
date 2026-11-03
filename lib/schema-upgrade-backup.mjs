import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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
  if (existsSync(backupPath)) {
    return { created: false, reason: "existing", fromVersion: current, targetVersion: target, path: backupPath };
  }

  mkdirSync(dirname(backupPath), { recursive: true });
  const partialPath = `${backupPath}.partial`;
  rmSync(partialPath, { force: true });
  try {
    database.exec(`VACUUM INTO ${sqliteStringLiteral(partialPath)}`);
    renameSync(partialPath, backupPath);
  } catch (error) {
    rmSync(partialPath, { force: true });
    throw error;
  }
  return { created: true, reason: "upgrade", fromVersion: current, targetVersion: target, path: backupPath };
}
