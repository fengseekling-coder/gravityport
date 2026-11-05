// Task 350: lifecycle for the pre-upgrade database snapshots in
// <libraryDir>/.schema-backups/. The old rule kept every snapshot forever
// (a 603 MB copy on the user's real library, shipped on every relocation).
// The new rule, decided 2026-10-28 (rule 28) with the dialog wording fixed
// 2026-11-03:
// - the verify verdict "ok" deletes every matching snapshot (and .partial
//   residue) except the ones on the kept list, and records the deletion time
//   and freed bytes on the verify record;
// - a "failed" verdict keeps its snapshot, adds it to the kept list (those
//   files are never auto-deleted, whatever later upgrades verify), and the
//   App shows the explanation dialog;
// - a library upgraded before the verify record existed (pre-347) gets ONE
//   background check against the newest-version snapshot, then follows the
//   same two paths.
// Deletion only ever happens from startDeferredMaintenance (the App process
// and the background capture service) — MCP and CLI processes never call it,
// so their opens never delete anything. Anything that is not a matching
// regular file — other files, folders, symlinked names (lstat test) — is left
// untouched, and a failed delete (Windows file lock) only logs one line and
// retries on the next open.

import { basename, join, resolve } from "node:path";
import { existsSync, lstatSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import {
  readSchemaUpgradeVerifyRecord,
  runSchemaUpgradeVerify,
  writeSchemaUpgradeVerifyRecord,
} from "./schema-upgrade-verify.mjs";

export const SCHEMA_UPGRADE_KEPT_BACKUPS_KEY = "schema_upgrade_kept_backups";
export const SCHEMA_BACKUP_DIRNAME = ".schema-backups";
// Final snapshots (`mosa-before-v17-from-v16.db`) and their in-flight or
// crashed partial residue (`....db.partial-<pid>-<hex>` from task 350's
// always-fresh snapshots, or the legacy fixed `....db.partial`).
export const SCHEMA_UPGRADE_BACKUP_FILE_RE = /^mosa-before-v(\d+)-from-v(\d+)\.db(\.partial(?:-.*)?)?$/;

// Test-only hook (task 350): the SIGKILL-resume test picks its kill point by
// name — "after-backup", "mid-upgrade", "after-commit", "mid-backup-delete".
// Never set outside that test.
export function maybeKillSchemaUpgradeTestProcess(point) {
  if (String(process.env.MOSA_TEST_SCHEMA_UPGRADE_KILL || "") === point) {
    process.kill(process.pid, "SIGKILL");
  }
}

/** Matching snapshot files under .schema-backups — regular files only. */
export function listSchemaUpgradeBackupFiles(libraryDir) {
  const root = join(resolve(libraryDir), SCHEMA_BACKUP_DIRNAME);
  if (!existsSync(root)) return [];
  let entries = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const files = [];
  for (const name of entries) {
    const match = SCHEMA_UPGRADE_BACKUP_FILE_RE.exec(name);
    if (!match) continue;
    let stat;
    try {
      // lstat, not stat: a symlink named like a snapshot is never followed,
      // never deleted, and never counted.
      stat = lstatSync(join(root, name));
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    files.push({
      name,
      path: join(root, name),
      size: Number(stat.size || 0),
      toVersion: Number(match[1]),
      fromVersion: Number(match[2]),
      isPartial: Boolean(match[3]),
    });
  }
  return files;
}

export function readKeptSchemaBackups(database) {
  const raw = database.prepare("SELECT value FROM library_meta WHERE key = ?").get(SCHEMA_UPGRADE_KEPT_BACKUPS_KEY)?.value;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry.name === "string") : [];
  } catch {
    return [];
  }
}

/** Adds one entry keyed by file name; returns false when it was already there. */
export function addKeptSchemaBackup(database, { name, targetVersion = null, checkedAt = null }) {
  const kept = readKeptSchemaBackups(database);
  if (kept.some((entry) => entry.name === name)) return false;
  const timestamp = new Date().toISOString();
  const next = [...kept, { name, targetVersion: targetVersion == null ? null : Number(targetVersion), checkedAt: checkedAt || null }];
  database.prepare(`
    INSERT INTO library_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(SCHEMA_UPGRADE_KEPT_BACKUPS_KEY, JSON.stringify(next), timestamp);
  return true;
}

// Rework 1: a `.partial-<pid>-<hex>` whose pid is still alive is somebody's
// in-flight VACUUM INTO — deleting it under the writer would break their
// rename (or worse, race their own cleanup). A dead pid's partial is crashed
// residue and stays deletable.
export function isPartialFileBeingWritten(name) {
  const match = /\.partial-(\d+)-[0-9a-f]+$/.exec(String(name || ""));
  if (!match) return false;
  const pid = Number(match[1]);
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else — still alive.
    return error?.code === "EPERM";
  }
}

/** Deletes the given snapshot files; a per-file failure never stops the rest. */
export function deleteSchemaUpgradeBackupFiles(paths) {
  const deleted = [];
  const failures = [];
  for (const path of paths) {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) continue;
      const size = Number(stat.size || 0);
      rmSync(path, { force: true });
      deleted.push({ path, size });
      maybeKillSchemaUpgradeTestProcess("mid-backup-delete");
    } catch (error) {
      failures.push({ path, name: basename(path), error: String((error && error.message) || error).slice(0, 160) });
    }
  }
  return { deleted, failures };
}

function removeBackupDirIfEmpty(libraryDir) {
  try {
    const root = join(resolve(libraryDir), SCHEMA_BACKUP_DIRNAME);
    if (!existsSync(root) || readdirSync(root).length > 0) return;
    rmdirSync(root);
  } catch {
    // The next open retries; an undeletable folder is never worth an error.
  }
}

/**
 * Runs after the verification step inside startDeferredMaintenance. Never
 * throws; resolves with { status, deleted, freedBytes }. `announce` receives
 * one { reason } when a NEW failure lands in the kept list (the App then
 * re-asks the notice endpoint and shows the dialog without a restart).
 */
export async function settleSchemaUpgradeBackupCleanup(database, {
  libraryDir,
  databasePath,
  signal = null,
  spawnWorker = null,
  announce = null,
} = {}) {
  if (!libraryDir) return { status: "none", deleted: 0, freedBytes: 0 };
  let record = readSchemaUpgradeVerifyRecord(database);
  let files = listSchemaUpgradeBackupFiles(libraryDir);

  // Legacy snapshots (upgrades from before the verify record existed): one
  // background check against the newest-version copy, real worker. If it
  // fails on infrastructure the record stays pending and every later step
  // below skips — nothing is deleted unverified.
  if ((!record || !record.status) && files.length) {
    const baseline = files
      .filter((file) => !file.isPartial)
      .filter((file) => !readKeptSchemaBackups(database).some((kept) => kept.name === file.name))
      .sort((a, b) => (b.toVersion - a.toVersion) || (b.fromVersion - a.fromVersion))[0];
    if (baseline) {
      record = await runSchemaUpgradeVerify(database, {
        databasePath,
        targetVersion: baseline.toVersion,
        backupPath: baseline.path,
        force: true,
        signal,
        ...(spawnWorker ? { spawnWorker } : {}),
      });
      files = listSchemaUpgradeBackupFiles(libraryDir);
    }
  }

  if (!record || record.status === "pending") {
    return { status: record?.status || "none", deleted: 0, freedBytes: 0 };
  }

  if (record.status === "failed") {
    // The failed snapshot joins the kept list once; announce only on the
    // first add so open windows learn about it exactly once.
    const failedName = record.backupPath ? basename(record.backupPath) : "";
    if (failedName && SCHEMA_UPGRADE_BACKUP_FILE_RE.test(failedName) && !failedName.includes(".partial")) {
      const added = addKeptSchemaBackup(database, {
        name: failedName,
        targetVersion: record.targetVersion,
        checkedAt: record.checkedAt,
      });
      if (added && announce) announce({ reason: "schema_upgrade_verify_failed" });
    }
    return { status: "failed", deleted: 0, freedBytes: 0 };
  }

  // ok: delete every matching snapshot the kept list does not name. Rework 1:
  // never touch a version pair NEWER than the verified record's target (a
  // file dropped in later must not be judged by an older verdict), and skip
  // .partial files whose writer pid is still alive — it is vacuuming right
  // now, and the next open deletes the residue.
  const keptNames = new Set(readKeptSchemaBackups(database).map((entry) => entry.name));
  const verifiedTargetVersion = Number(record.targetVersion ?? Number.MAX_SAFE_INTEGER);
  const deletable = files.filter((file) => !keptNames.has(file.name))
    .filter((file) => file.toVersion <= verifiedTargetVersion)
    .filter((file) => !isPartialFileBeingWritten(file.name));
  if (!deletable.length) return { status: "ok", deleted: 0, freedBytes: 0 };
  const result = deleteSchemaUpgradeBackupFiles(deletable.map((file) => file.path));
  const freedBytes = result.deleted.reduce((sum, file) => sum + file.size, 0);
  if (result.deleted.length) {
    recordSchemaBackupDeletion(database, {
      at: new Date().toISOString(),
      count: result.deleted.length,
      bytes: freedBytes,
    });
    const freedMb = (freedBytes / (1024 * 1024)).toFixed(1);
    console.warn(`[MOSA] deleted ${result.deleted.length} pre-upgrade schema backup file(s), freed ${freedMb} MB.`);
  }
  if (result.failures.length) {
    // Windows file lock and friends: one line, retry on the next open.
    console.warn(`[MOSA] schema backup cleanup could not delete ${result.failures.length} file(s); it retries on the next open: ${result.failures[0].name} (${result.failures[0].error})`);
  }
  removeBackupDirIfEmpty(libraryDir);
  return { status: "ok", deleted: result.deleted.length, freedBytes };
}

function recordSchemaBackupDeletion(database, { at, count, bytes }) {
  const record = readSchemaUpgradeVerifyRecord(database);
  if (!record) return;
  writeSchemaUpgradeVerifyRecord(database, {
    ...record,
    backupsDeletedAt: at,
    backupsDeletedCount: count,
    backupsFreedBytes: bytes,
  });
}
