// Task 350 (audit 5-2): upgrade-check wrap-up. The pre-upgrade snapshot is
// retaken on every real upgrade (task 350 #3), the whole upgrade commits in
// one immediate transaction that re-reads the version under the lock, an ok
// verdict deletes every non-kept snapshot while a failed verdict keeps its
// snapshot on the kept list (and the App shows the dialog), foreign-key
// violations are judged against the snapshot baseline (task 350 #4), column
// additions and their backfills commit together (task 350 #5), the degenerate
// all-equal group positions get exactly one re-rank (task 350 #6), a library
// newer than this build is refused before any byte changes (task 350 #7),
// migration rows 14–16 exist and the pre-v10 candidate sync is inside the
// transaction (task 350 #8), and trashed Jimeng captures rejoin their session
// stack (task 350 #9).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { addColumnIfMissing, createSqliteAssetStore, CURRENT_SCHEMA_VERSION } from "../lib/sqlite-asset-store.mjs";
import {
  SCHEMA_UPGRADE_VERIFY_KEY,
  readSchemaUpgradeVerifyRecord,
  runSchemaUpgradeVerify,
} from "../lib/schema-upgrade-verify.mjs";
import {
  isPartialFileBeingWritten,
  listSchemaUpgradeBackupFiles,
  readKeptSchemaBackups,
  settleSchemaUpgradeBackupCleanup,
} from "../lib/schema-backup-cleanup.mjs";
import { readSqliteSchemaVersion } from "../lib/schema-upgrade-backup.mjs";
import { getLibraryStartupFailureText } from "../desktop/notification-i18n.mjs";
import { assetSortName } from "../lib/asset-sort.js";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const CREATED = "2026-05-01T00:00:00.000Z";
const REPO_ROOT = resolve(import.meta.dirname, "..");

async function createLibraryRoot(t, prefix = "mosa-350-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  return { root, projectRoot, libraryDir };
}

function bootstrapLibrary(projectRoot, libraryDir) {
  const bootstrap = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  bootstrap.close();
}

function withRawDatabase(libraryDir, task) {
  const database = new Database(join(libraryDir, "mosa.db"));
  try {
    return task(database);
  } finally {
    database.close();
  }
}

async function withRawDatabasePromise(libraryDir, task) {
  const database = new Database(join(libraryDir, "mosa.db"));
  try {
    return await task(database);
  } finally {
    database.close();
  }
}

function markerValue(libraryDir, key) {
  return withRawDatabase(libraryDir, (database) =>
    database.prepare("SELECT value FROM library_meta WHERE key = ?").get(key)?.value || null);
}

function setMarker(libraryDir, key, value) {
  withRawDatabase(libraryDir, (database) => {
    database.prepare(`
      INSERT INTO library_meta (key, value, updated_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value);
  });
}

function downgradeSchemaVersion(libraryDir, version) {
  withRawDatabase(libraryDir, (database) => {
    database.prepare("UPDATE library_meta SET value = ? WHERE key = 'schema_version'").run(String(version));
  });
}

function verifyRecord(libraryDir) {
  const raw = markerValue(libraryDir, SCHEMA_UPGRADE_VERIFY_KEY);
  return raw ? JSON.parse(raw) : null;
}

function backupDir(libraryDir) {
  return join(libraryDir, ".schema-backups");
}

function backupNames(libraryDir) {
  const dir = backupDir(libraryDir);
  return existsSync(dir) ? readdirSync(dir) : [];
}

function keptEntries(libraryDir) {
  return withRawDatabase(libraryDir, (database) => readKeptSchemaBackups(database));
}

/** Real snapshot file, exactly like the real backup path produces. */
function vacuumSnapshotInto(libraryDir, fromVersion, toVersion) {
  const dir = backupDir(libraryDir);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `mosa-before-v${toVersion}-from-v${fromVersion}.db`);
  withRawDatabase(libraryDir, (database) => {
    database.exec(`VACUUM INTO '${target}'`);
  });
  return target;
}

function insertAssetRow(database, {
  id,
  projectId = "default",
  createdAt = CREATED,
  epoch = Date.parse(CREATED),
  deletedAt = null,
  groupName = "",
  sessionKey = "",
  sourceType = "local-file",
  sourceJson = JSON.stringify({ type: "local-file" }),
  asset: assetName = `${id}.png`,
}) {
  database.prepare(`
    INSERT INTO assets (
      project_id, id, asset, original_path, content_sha256, pixel_sha256, prompt, skill, style, ratio, business_fields_json, theme,
      favorite, archived, group_name, category, rating, version_change, source_type, source_json, source_path, metadata_json, search_text,
      tags_text, business_search_text, source_search_text, media_kind, source_group, conversation_id, generation_session_key, generation_batch,
      created_at, created_at_epoch, updated_at, sort_name
    ) VALUES (
      @projectId, @id, @asset, '/src', @hash, '', @prompt, '', '', '', '{}', '',
      0, 0, @groupName, '', 0, '', @sourceType, @sourceJson, '', '{}', @prompt,
      '', '', '', 'image', @sourceType, '', @sessionKey, '',
      @createdAt, @epoch, @createdAt, @sortName
    )
  `).run({
    projectId, id, asset: assetName, hash: `hash-${id}`, prompt: `fixture ${id}`,
    sourceType, sourceJson, groupName, sessionKey, createdAt, epoch,
    sortName: assetSortName({ theme: "", asset: assetName, id }),
  });
  if (deletedAt) {
    database.prepare("UPDATE assets SET deleted_at = ? WHERE project_id = ? AND id = ?").run(deletedAt, projectId, id);
  }
}

/** FK violation seeded with foreign_keys OFF — exactly the shape the verify
 * worker's foreign_key_check finds. The asset row is real, so only the stack
 * FK is violated: one orphan row = one violation row (a row violating both
 * FKs counts twice in foreign_key_check). */
function insertOrphanStackMember(libraryDir, stackId, assetId) {
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertAssetRow(database, { id: assetId });
    })();
    database.pragma("foreign_keys = OFF");
    database.prepare(`
      INSERT INTO asset_stack_members (project_id, stack_id, asset_id, position, added_at)
      VALUES ('default', ?, ?, 0, ?)
    `).run(stackId, assetId, CREATED);
    database.pragma("foreign_keys = ON");
  });
}

function foreignKeyViolationCount(libraryDir) {
  return withRawDatabase(libraryDir, (database) => database.pragma("foreign_key_check").length);
}

/** Rework 1: reads a snapshot file's own schema_version (read-only). */
function snapshotSchemaVersion(path) {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return readSqliteSchemaVersion(database);
  } finally {
    database.close();
  }
}

async function runMaintenance(store, { spawnWorker } = {}) {
  await store.startDeferredMaintenance(spawnWorker ? { spawnWorker } : undefined);
}

function makeCountingWorker(okResult = null) {
  let calls = 0;
  const factory = () => {
    calls += 1;
    const worker = new EventEmitter();
    worker.postMessage = () => {};
    worker.terminate = () => {};
    setImmediate(() => worker.emit("message", okResult || {
      ran: true, ok: true, integrity: "ok", foreignKeyViolations: 0, foreignKeyBaselineViolations: 0, error: null, errorCode: "",
    }));
    return worker;
  };
  return { factory, calls: () => calls };
}

// --- 1: ok verdict deletes snapshots, touches nothing else (task 350 #1) -----

test("an ok upgrade deletes its snapshot; notes.txt and a symlink stay", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-350-delete-keep-");
  bootstrapLibrary(projectRoot, libraryDir);
  downgradeSchemaVersion(libraryDir, 16);
  mkdirSync(backupDir(libraryDir), { recursive: true });
  writeFileSync(join(backupDir(libraryDir), "notes.txt"), "keep me");
  writeFileSync(join(backupDir(libraryDir), "target.txt"), "symlink target");
  symlinkSync(join(backupDir(libraryDir), "target.txt"), join(backupDir(libraryDir), "mosa-before-v18-from-v16.db"));

  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  await runMaintenance(store);

  assert.equal(verifyRecord(libraryDir)?.status, "ok");
  const names = backupNames(libraryDir);
  assert.deepEqual(names, ["notes.txt", "target.txt"], `only the foreign names survive (got ${JSON.stringify(names)})`);
  const record = verifyRecord(libraryDir);
  assert.equal(record.backupsDeletedCount, 1, "the fresh pre-upgrade snapshot is deleted; the symlink is not");
  assert.ok(record.backupsFreedBytes > 0, "the freed bytes are recorded");
  assert.ok(record.backupsDeletedAt, "the deletion time is recorded");
  store.close();

  // A snapshot left behind by a previous failed delete is removed on the next
  // ok open WITHOUT re-running the check (spawnWorker stays silent).
  const snapshot = vacuumSnapshotInto(libraryDir, 16, 18);
  const reopened = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => { try { reopened.close(); } catch { /* closed */ } });
  const counting = makeCountingWorker();
  await runMaintenance(reopened, { spawnWorker: counting.factory });
  assert.equal(counting.calls(), 0, "a terminal ok record never re-runs the check");
  assert.ok(!existsSync(snapshot), "the leftover snapshot is deleted without a new check");
  assert.deepEqual(backupNames(libraryDir), ["notes.txt", "target.txt"]);
  assert.equal(verifyRecord(libraryDir).backupsDeletedCount, 1, "this pass deleted the one leftover");
});

test("legacy snapshots from before the verify record get one background check, then are deleted", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-350-legacy-");
  bootstrapLibrary(projectRoot, libraryDir);
  const first = vacuumSnapshotInto(libraryDir, 14, 15);
  const second = vacuumSnapshotInto(libraryDir, 16, 18);
  assert.equal(verifyRecord(libraryDir), null, "the fixture starts without a verify record");

  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  const counting = makeCountingWorker();
  await runMaintenance(store, { spawnWorker: counting.factory });

  assert.equal(counting.calls(), 1, "exactly one legacy check runs (baseline = newest-version copy)");
  const record = verifyRecord(libraryDir);
  assert.equal(record.status, "ok");
  assert.equal(record.targetVersion, 18, "the baseline is the newest-version snapshot");
  assert.equal(record.trigger, "legacy-recheck");
  assert.ok(!existsSync(first), "the older snapshot is deleted with the rest");
  assert.ok(!existsSync(second), "the checked baseline snapshot is deleted too");
  assert.ok(record.backupsDeletedCount >= 2);
});

test("a failed verdict never deletes nor re-checks; its snapshot lands on the kept list", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-350-failed-terminal-");
  bootstrapLibrary(projectRoot, libraryDir);
  const snapshot = vacuumSnapshotInto(libraryDir, 16, 18);
  setMarker(libraryDir, SCHEMA_UPGRADE_VERIFY_KEY, JSON.stringify({
    targetVersion: 18, status: "failed", integrity: "ok", foreignKeyViolations: 3,
    foreignKeyBaselineViolations: 0, trigger: "upgrade", backupPath: snapshot, checkedAt: CREATED,
  }));

  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  const counting = makeCountingWorker();
  await runMaintenance(store, { spawnWorker: counting.factory });

  assert.equal(counting.calls(), 0, "failed is terminal: no re-check, no deletion");
  assert.ok(existsSync(snapshot), "the failed snapshot stays");
  assert.ok(keptEntries(libraryDir).some((entry) => entry.name === "mosa-before-v18-from-v16.db"),
    "the snapshot is on the kept list");
});

// --- 2: failed verdict keeps the snapshot, kept list, dialog state (task 350 #2/4) --

test("a grown violation fails the check, keeps its snapshot and drives the notice state", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-350-failed-");
  bootstrapLibrary(projectRoot, libraryDir);
  downgradeSchemaVersion(libraryDir, 16);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  await runMaintenance(store);
  assert.equal(verifyRecord(libraryDir)?.status, "ok", "the upgrade check passed (baseline covers pre-existing violations)");
  const snapshot = verifyRecord(libraryDir).backupPath;
  store.close();

  // One violation grew after the upgrade: the next check against the same
  // snapshot must fail (task 350 #4 — the group is larger than the baseline).
  insertOrphanStackMember(libraryDir, "ghost-stack", "ghost-asset");
  assert.ok(foreignKeyViolationCount(libraryDir) > 0);
  const failedRecord = await withRawDatabasePromise(libraryDir, (database) => runSchemaUpgradeVerify(database, {
    databasePath: join(libraryDir, "mosa.db"),
    targetVersion: 18,
    backupPath: snapshot,
    force: true,
  }));
  assert.equal(failedRecord.status, "failed", "a grown violation group fails the check");
  assert.equal(failedRecord.foreignKeyViolations, failedRecord.foreignKeyBaselineViolations + 1,
    "the record carries both counts");
  assert.equal(failedRecord.trigger, "legacy-recheck");

  // The maintenance pass files the failed snapshot on the kept list; the
  // notice state says show; acknowledging latches it across reopens.
  const reopened = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => { try { reopened.close(); } catch { /* closed */ } });
  await runMaintenance(reopened);
  assert.ok(keptEntries(libraryDir).some((entry) => entry.name === snapshot.split("/").pop()),
    "the failed snapshot is on the kept list");
  assert.equal(reopened.schemaUpgradeNoticeState().shouldShow, true);
  assert.equal(reopened.schemaUpgradeNoticeState().backupPath, snapshot);
  assert.equal(reopened.acknowledgeSchemaUpgradeNotice(), true);
  assert.equal(reopened.schemaUpgradeNoticeState().shouldShow, false);
  reopened.close();
  const again = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => { try { again.close(); } catch { /* closed */ } });
  assert.equal(again.schemaUpgradeNoticeState().shouldShow, false, "the acknowledgement survives a reopen");
  assert.ok(JSON.parse(markerValue(libraryDir, SCHEMA_UPGRADE_VERIFY_KEY)).noticeDismissedAt,
    "the latch lives on the verify record");

  // A NEW upgrade re-snapshots (with the extra violation, matching the
  // library) and passes. The fresh snapshot lands on the SAME official name
  // as the kept one (both are the 16→18 pair) — the kept-list rule wins and
  // the file stays, exactly as the kept-list contract demands ("名单里的文件
  // 以后怎么升级、检查通过都不自动删").
  downgradeSchemaVersion(libraryDir, 16);
  again.close();
  const upgraded = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => { try { upgraded.close(); } catch { /* closed */ } });
  await runMaintenance(upgraded);
  const afterRecord = verifyRecord(libraryDir);
  assert.equal(afterRecord.status, "ok", "the new upgrade check passes (baseline includes the extra violation)");
  assert.ok(existsSync(afterRecord.backupPath), "the kept name is never auto-deleted, whatever later upgrades verify");
  assert.ok(existsSync(snapshot), "the kept snapshot is still there");
  assert.equal(keptEntries(libraryDir).filter((entry) => entry.name === "mosa-before-v18-from-v16.db").length, 1,
    "exactly the original entry stays on the kept list");
});

// --- 3: every upgrade re-snapshots (task 350 #3) -------------------------------

test("a stale file at the official snapshot name is replaced by a fresh pre-upgrade image", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-350-fresh-snap-");
  bootstrapLibrary(projectRoot, libraryDir);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      for (let index = 0; index < 12; index += 1) insertAssetRow(database, { id: `keep-${index}` });
    })();
  });
  // The stale snapshot the old code would have reused: same official name,
  // but 10 assets fewer than the real library.
  const officialName = "mosa-before-v18-from-v16.db";
  mkdirSync(backupDir(libraryDir), { recursive: true });
  const stalePath = join(backupDir(libraryDir), officialName);
  withRawDatabase(libraryDir, (database) => {
    database.exec(`VACUUM INTO '${stalePath}'`);
  });
  const staleDatabase = new Database(stalePath);
  staleDatabase.prepare("DELETE FROM assets WHERE id IN ('keep-0', 'keep-1')").run();
  assert.equal(staleDatabase.prepare("SELECT COUNT(*) AS count FROM assets").get().count, 10,
    "the stale snapshot holds 10 assets (12 minus 2)");
  staleDatabase.close();

  downgradeSchemaVersion(libraryDir, 16);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  const record = verifyRecord(libraryDir);
  assert.equal(record?.status, "pending", "the upgrade wrote its pending check record");
  assert.ok(record.backupPath.endsWith(officialName), `the pending record names the official snapshot (${record.backupPath})`);

  const snapDatabase = new Database(record.backupPath, { readonly: true });
  const snapCount = snapDatabase.prepare("SELECT COUNT(*) AS count FROM assets").get().count;
  snapDatabase.close();
  assert.equal(snapCount, 12, "the snapshot was retaken from the real pre-upgrade library");
  await runMaintenance(store);
  assert.equal(verifyRecord(libraryDir)?.status, "ok");
  assert.ok(!existsSync(record.backupPath), "the snapshot is deleted once the check passes");
});

// --- 4: concurrent first-time openers (task 350 #3) ----------------------------

async function writeChildScript(root) {
  const scriptPath = join(root, "child-open.mjs");
  await writeFile(scriptPath, `
import { createSqliteAssetStore } from ${JSON.stringify(join(REPO_ROOT, "lib", "sqlite-asset-store.mjs"))};
const { existsSync } = await import("node:fs");
const libraryDir = process.env.MOSA_TEST_CHILD_LIBRARY;
const projectRoot = process.env.MOSA_TEST_CHILD_PROJECT_ROOT;
const goFile = process.env.MOSA_TEST_CHILD_GO_FILE;
for (let i = 0; i < 1500 && !existsSync(goFile); i += 1) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
const store = createSqliteAssetStore({
  projectRoot,
  managerDir: (await import("node:path")).join(projectRoot, "mosa"),
  libraryDir,
});
if (process.env.MOSA_TEST_CHILD_RUN_MAINTENANCE === "1") {
  await store.startDeferredMaintenance();
}
store.close();
console.log("child-ok");
`);
  return scriptPath;
}

function runChild(scriptPath, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

const COMPARED_TABLES = ["projects", "assets", "groups", "asset_stacks", "asset_stack_members"];

function tableRows(libraryDir, table) {
  return withRawDatabase(libraryDir, (database) => database.prepare(`SELECT * FROM ${table}`).all());
}

/** schema_migrations rows carry per-run timestamps; compare versions only. */
function migrationVersions(libraryDir) {
  return withRawDatabase(libraryDir, (database) =>
    database.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => row.version));
}

test("three concurrent first-time openers all succeed with identical results and no partial residue", async (t) => {
  const a = await createLibraryRoot(t, "mosa-350-conc-a-");
  const b = await createLibraryRoot(t, "mosa-350-conc-ref-");
  for (const lib of [a, b]) {
    bootstrapLibrary(lib.projectRoot, lib.libraryDir);
    withRawDatabase(lib.libraryDir, (database) => {
      database.transaction(() => {
        for (let index = 0; index < 6; index += 1) insertAssetRow(database, { id: `shared-${index}` });
      })();
    });
    downgradeSchemaVersion(lib.libraryDir, 16);
  }
  const scriptPath = await writeChildScript(a.root);
  const goFile = join(a.root, "go");
  const children = [1, 2, 3].map(() => runChild(scriptPath, {
    MOSA_TEST_CHILD_LIBRARY: a.libraryDir,
    MOSA_TEST_CHILD_PROJECT_ROOT: a.projectRoot,
    MOSA_TEST_CHILD_GO_FILE: goFile,
    // Deterministic loser path: the upgrade transaction holds the write lock
    // for 2.5s, so every opener takes its snapshot while the library is still
    // on v16 and the two losers reach the in-lock re-read after the winner
    // committed — exactly the state the concurrency rules exist for.
    MOSA_TEST_SCHEMA_UPGRADE_HOLD_MS: "2500",
  }));
  // Barrier: every child is parked on the go-file poll before any may open.
  await new Promise((resolveWait) => setTimeout(resolveWait, 800));
  writeFileSync(goFile, "go");
  const results = await Promise.all(children);
  for (const [index, result] of results.entries()) {
    assert.equal(result.code, 0, `child ${index + 1} exited cleanly (${result.stderr.slice(0, 300)})`);
    assert.ok(result.stdout.includes("child-ok"));
  }
  assert.equal(withRawDatabase(a.libraryDir, (database) => database.prepare("SELECT value FROM library_meta WHERE key = 'schema_version'").get()?.value), "18");
  const migrations = withRawDatabase(a.libraryDir, (database) =>
    database.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => row.version));
  assert.deepEqual(migrations, Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, index) => index + 1), "migrations 1..CURRENT_SCHEMA_VERSION");
  assert.deepEqual(backupNames(a.libraryDir).filter((name) => name.includes(".partial")), [],
    "no .partial residue after the concurrent snapshots");
  // The lock re-read: the losers that found the version already current in
  // the lock abandoned their upgrade — and never touched the winner's
  // snapshot, which its pending record still names.
  const pendingRecord = JSON.parse(markerValue(a.libraryDir, SCHEMA_UPGRADE_VERIFY_KEY));
  assert.ok(pendingRecord?.backupPath, "the winner wrote the pending record");
  assert.ok(existsSync(pendingRecord.backupPath), "the winner's pending snapshot survives the losers' abort");
  // Rework 1: the file at the final name must be the winner's PRE-upgrade
  // image — a loser that vacuumed the already-upgraded library and renamed it
  // over the winner's snapshot would make this read 18.
  assert.equal(snapshotSchemaVersion(pendingRecord.backupPath), 16, "the surviving snapshot is a v16 (pre-upgrade) image");

  // Reference: a single uninterrupted upgrade of the same library.
  const reference = createSqliteAssetStore({ projectRoot: b.projectRoot, managerDir: join(b.projectRoot, "mosa"), libraryDir: b.libraryDir });
  reference.close();
  for (const table of COMPARED_TABLES) {
    assert.deepEqual(tableRows(a.libraryDir, table), tableRows(b.libraryDir, table),
      `table ${table} matches the single-process reference`);
  }
  assert.deepEqual(migrationVersions(a.libraryDir), migrationVersions(b.libraryDir),
    "schema_migrations versions match the single-process reference");
  assert.equal(foreignKeyViolationCount(a.libraryDir), 0);
});

// --- 5: kill points converge (task 350 #3) --------------------------------------

test("a kill at each upgrade point reopens to the same state as an uninterrupted run", async (t) => {
  for (const point of ["after-backup", "mid-upgrade", "after-commit"]) {
    await t.test(`kill at ${point}`, async (t2) => {
      const a = await createLibraryRoot(t2, `mosa-350-kill-${point}-`);
      const b = await createLibraryRoot(t2, `mosa-350-kill-${point}-ref-`);
      for (const lib of [a, b]) {
        bootstrapLibrary(lib.projectRoot, lib.libraryDir);
        withRawDatabase(lib.libraryDir, (database) => {
          database.transaction(() => {
            for (let index = 0; index < 4; index += 1) insertAssetRow(database, { id: `kill-${index}` });
          })();
        });
        downgradeSchemaVersion(lib.libraryDir, 16);
      }
      const scriptPath = await writeChildScript(a.root);
      writeFileSync(join(a.root, "go"), "go");
      const killed = await runChild(scriptPath, {
        MOSA_TEST_CHILD_LIBRARY: a.libraryDir,
        MOSA_TEST_CHILD_PROJECT_ROOT: a.projectRoot,
        MOSA_TEST_CHILD_GO_FILE: join(a.root, "go"),
        MOSA_TEST_SCHEMA_UPGRADE_KILL: point,
      });
      assert.equal(killed.signal, "SIGKILL", `the child died at ${point} (code ${killed.code}, stderr ${killed.stderr.slice(0, 200)})`);

      // The store reopens and the interrupted upgrade completes.
      const store = createSqliteAssetStore({ projectRoot: a.projectRoot, managerDir: join(a.projectRoot, "mosa"), libraryDir: a.libraryDir });
      t2.after(() => { try { store.close(); } catch { /* closed */ } });
      await runMaintenance(store);

      const reference = createSqliteAssetStore({ projectRoot: b.projectRoot, managerDir: join(b.projectRoot, "mosa"), libraryDir: b.libraryDir });
      await runMaintenance(reference);
      reference.close();

      for (const table of COMPARED_TABLES) {
        assert.deepEqual(tableRows(a.libraryDir, table), tableRows(b.libraryDir, table),
          `table ${table} matches the reference after a ${point} kill`);
      }
      assert.deepEqual(migrationVersions(a.libraryDir), migrationVersions(b.libraryDir),
        `schema_migrations versions match the reference after a ${point} kill`);
      assert.equal(withRawDatabase(a.libraryDir, (database) => database.pragma("integrity_check", { simple: true })), "ok");
      assert.equal(verifyRecord(a.libraryDir)?.status, "ok");
    });
  }
});

test("a kill mid-snapshot-deletion resumes and finishes the cleanup", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-350-kill-delete-");
  bootstrapLibrary(projectRoot, libraryDir);
  // Terminal ok record + two stale snapshots: the cleanup pass deletes the
  // first, then the test hook kills the process.
  setMarker(libraryDir, SCHEMA_UPGRADE_VERIFY_KEY, JSON.stringify({
    targetVersion: 18, status: "ok", integrity: "ok", foreignKeyViolations: 0,
    foreignKeyBaselineViolations: 0, trigger: "upgrade", backupPath: null, checkedAt: CREATED,
  }));
  const first = vacuumSnapshotInto(libraryDir, 14, 15);
  const second = vacuumSnapshotInto(libraryDir, 16, 18);

  mkdirSync(projectRoot, { recursive: true });
  const scriptPath = await writeChildScript(projectRoot);
  writeFileSync(join(projectRoot, "go"), "go");
  const killed = await runChild(scriptPath, {
    MOSA_TEST_CHILD_LIBRARY: libraryDir,
    MOSA_TEST_CHILD_PROJECT_ROOT: projectRoot,
    MOSA_TEST_CHILD_GO_FILE: join(projectRoot, "go"),
    MOSA_TEST_CHILD_RUN_MAINTENANCE: "1",
    MOSA_TEST_SCHEMA_UPGRADE_KILL: "mid-backup-delete",
  });
  assert.equal(killed.signal, "SIGKILL", `the child died mid-deletion (code ${killed.code})`);
  const afterKill = backupNames(libraryDir);
  assert.ok(afterKill.length < 3, `at least one snapshot was already deleted (left: ${JSON.stringify(afterKill)})`);

  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  await runMaintenance(store);
  assert.equal(backupNames(libraryDir).length, 0, `the resumed pass deleted the rest (left: ${JSON.stringify(backupNames(libraryDir))})`);
  assert.ok(!existsSync(first) && !existsSync(second));
  assert.ok(verifyRecord(libraryDir).backupsDeletedAt, "the deletion is recorded");
});

// --- 6: foreign-key baseline (task 350 #4) --------------------------------------

test("pre-upgrade foreign-key violations no longer fail the upgrade check", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-350-fk-baseline-");
  bootstrapLibrary(projectRoot, libraryDir);
  // Seeded BEFORE the snapshot exists: the pre-upgrade image carries the same
  // two violations, so the upgrade check must pass where the old rule failed.
  insertOrphanStackMember(libraryDir, "ghost-a", "orphan-a");
  insertOrphanStackMember(libraryDir, "ghost-b", "orphan-b");
  assert.equal(foreignKeyViolationCount(libraryDir), 2);
  downgradeSchemaVersion(libraryDir, 16);

  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  await runMaintenance(store);
  const record = verifyRecord(libraryDir);
  assert.equal(record.status, "ok", "violations inherited from the snapshot pass");
  assert.equal(record.foreignKeyViolations, 2);
  assert.equal(record.foreignKeyBaselineViolations, 2);
  store.close();

  // One MORE violation, then a fresh snapshot of that state, then one more
  // still: the check against the 3-violation baseline fails with both counts
  // in the record. (The maintenance pass already deleted the upgrade's own
  // snapshot after the ok verdict, so this check uses a fresh baseline copy.)
  insertOrphanStackMember(libraryDir, "ghost-c", "orphan-c");
  const baselineCopy = vacuumSnapshotInto(libraryDir, 16, 18);
  insertOrphanStackMember(libraryDir, "ghost-d", "orphan-d");
  const afterRecord = await withRawDatabasePromise(libraryDir, (database) => runSchemaUpgradeVerify(database, {
    databasePath: join(libraryDir, "mosa.db"),
    targetVersion: 18,
    backupPath: baselineCopy,
    force: true,
  }));
  assert.equal(afterRecord.status, "failed", "a violation group that grew fails the check");
  assert.equal(afterRecord.foreignKeyViolations, 4);
  assert.equal(afterRecord.foreignKeyBaselineViolations, 3);
});

// --- 7: column additions and backfills commit together (task 350 #5) ------------

test("dropping derived columns re-adds and backfills them on the next open", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-350-drop-col-");
  bootstrapLibrary(projectRoot, libraryDir);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertAssetRow(database, { id: "web-a", sourceType: "web-chatgpt", sourceJson: JSON.stringify({ type: "web-chatgpt", provider_asset_id: "pa-1", logical_output_id: "lo-1" }) });
      insertAssetRow(database, { id: "web-b", sourceType: "web-chatgpt", sourceJson: JSON.stringify({ type: "web-chatgpt", provider_asset_id: "pa-2" }) });
      // tags for the tags_text backfill
      database.prepare("INSERT INTO tags (id, normalized_name, name) VALUES ('t1', 'sunset', 'sunset')").run();
      database.prepare("INSERT INTO asset_tags (project_id, asset_id, tag_id) VALUES ('default', 'web-a', 't1')").run();
    })();
  });
  // Drop each derived column with its indexes (one per function from the
  // audit), then reopen: every value must be derived again.
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      database.exec("DROP INDEX IF EXISTS assets_project_provider_asset_idx");
      database.exec("DROP INDEX IF EXISTS assets_project_logical_output_idx");
      database.exec("ALTER TABLE assets DROP COLUMN provider_asset_id");
      database.exec("ALTER TABLE assets DROP COLUMN logical_output_id");
      database.exec("ALTER TABLE assets DROP COLUMN tags_text");
    })();
  });
  const reopened = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => { try { reopened.close(); } catch { /* closed */ } });
  withRawDatabase(libraryDir, (database) => {
    const a = database.prepare("SELECT provider_asset_id, logical_output_id, tags_text FROM assets WHERE id = 'web-a'").get();
    assert.equal(a.provider_asset_id, "pa-1");
    assert.equal(a.logical_output_id, "lo-1");
    assert.equal(a.tags_text, "sunset");
    const b = database.prepare("SELECT provider_asset_id, logical_output_id, tags_text FROM assets WHERE id = 'web-b'").get();
    assert.equal(b.provider_asset_id, "pa-2");
    assert.equal(b.logical_output_id, "");
    assert.equal(b.tags_text, "");
  });
});

test("dropping the groups position column re-adds it with the whole-project ranking", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-350-group-rank-");
  bootstrapLibrary(projectRoot, libraryDir);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      // Member counts 5 / 3 / 8; the upgrade ranks most-members-first.
      for (const [name, count] of [["alpha", 5], ["beta", 3], ["gamma", 8]]) {
        database.prepare("INSERT INTO groups (project_id, name, created_at, position, color) VALUES ('default', ?, ?, 0, '')").run(name, CREATED);
        for (let index = 0; index < count; index += 1) {
          insertAssetRow(database, { id: `${name}-${index}`, groupName: name });
        }
      }
    })();
  });
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      database.exec("DROP INDEX IF EXISTS groups_project_position_idx");
      database.exec("ALTER TABLE groups DROP COLUMN position");
    })();
  });
  const reopened = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => { try { reopened.close(); } catch { /* closed */ } });
  const positions = withRawDatabase(libraryDir, (database) =>
    database.prepare("SELECT name, position FROM groups ORDER BY position").all());
  assert.deepEqual(positions.map((row) => row.name), ["gamma", "alpha", "beta"], "most members first (8 → 5 → 3)");
  assert.deepEqual(positions.map((row) => row.position), [0, 1, 2], "positions rank over the whole project, 0-based");
});

// --- 8: degenerate all-equal positions re-rank once (task 350 #6) ---------------

test("all-equal group positions re-rank once under the repair marker", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-350-repair-pos-");
  bootstrapLibrary(projectRoot, libraryDir);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      for (const [name, count] of [["aaa", 2], ["bbb", 4], ["ccc", 1]]) {
        database.prepare("INSERT INTO groups (project_id, name, created_at, position, color) VALUES ('default', ?, ?, 0, '')").run(name, CREATED);
        for (let index = 0; index < count; index += 1) insertAssetRow(database, { id: `${name}-${index}`, groupName: name });
      }
    })();
  });
  // The bootstrap open already wrote the marker; simulate the pre-350 hole.
  withRawDatabase(libraryDir, (database) => {
    database.prepare("DELETE FROM library_meta WHERE key = 'repair:group_position_v1'").run();
  });
  const reopened = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => { try { reopened.close(); } catch { /* closed */ } });
  const positions = withRawDatabase(libraryDir, (database) =>
    database.prepare("SELECT name, position FROM groups ORDER BY position").all());
  assert.deepEqual(positions.map((row) => [row.name, row.position]), [["bbb", 0], ["aaa", 1], ["ccc", 2]],
    "the degenerate 0/0/0 sidebar order is re-ranked by the legacy rule");
  assert.ok(markerValue(libraryDir, "repair:group_position_v1"), "the marker is written");
  reopened.close();

  // Dragged (distinct) positions are never touched.
  withRawDatabase(libraryDir, (database) => {
    database.prepare("UPDATE groups SET position = 5 WHERE name = 'aaa'").run();
    database.prepare("UPDATE groups SET position = 9 WHERE name = 'bbb'").run();
    database.prepare("DELETE FROM library_meta WHERE key = 'repair:group_position_v1'").run();
  });
  const again = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => { try { again.close(); } catch { /* closed */ } });
  const after = withRawDatabase(libraryDir, (database) =>
    database.prepare("SELECT name, position FROM groups ORDER BY name").all());
  assert.deepEqual(after.map((row) => [row.name, row.position]), [["aaa", 5], ["bbb", 9], ["ccc", 2]],
    "distinct (dragged) positions stay exactly as they are");
  assert.ok(markerValue(libraryDir, "repair:group_position_v1"), "the marker is written once even without repairs");
});

// --- 9: migration rows and the pre-v10 sync (task 350 #8) -----------------------

test("migration rows 1..CURRENT_SCHEMA_VERSION exist on a new library and after a v13 upgrade; missing rows are filled", async (t) => {
  const fresh = await createLibraryRoot(t, "mosa-350-mig-fresh-");
  bootstrapLibrary(fresh.projectRoot, fresh.libraryDir);
  const rowsOf = (libraryDir) => withRawDatabase(libraryDir, (database) =>
    database.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => row.version));
  assert.deepEqual(rowsOf(fresh.libraryDir), Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, index) => index + 1));

  const upgraded = await createLibraryRoot(t, "mosa-350-mig-v13-");
  bootstrapLibrary(upgraded.projectRoot, upgraded.libraryDir);
  withRawDatabase(upgraded.libraryDir, (database) => {
    database.prepare("DELETE FROM schema_migrations WHERE version >= 14").run();
    database.prepare("UPDATE library_meta SET value = '13' WHERE key = 'schema_version'").run();
  });
  const store = createSqliteAssetStore({ projectRoot: upgraded.projectRoot, managerDir: join(upgraded.projectRoot, "mosa"), libraryDir: upgraded.libraryDir });
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  assert.deepEqual(rowsOf(upgraded.libraryDir), Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, index) => index + 1),
    "the v13 upgrade writes every row including 14–16");
  store.close();

  const currentMissing = await createLibraryRoot(t, "mosa-350-mig-fill-");
  bootstrapLibrary(currentMissing.projectRoot, currentMissing.libraryDir);
  withRawDatabase(currentMissing.libraryDir, (database) => {
    database.prepare("DELETE FROM schema_migrations WHERE version IN (14, 15, 16)").run();
  });
  const reopened = createSqliteAssetStore({ projectRoot: currentMissing.projectRoot, managerDir: join(currentMissing.projectRoot, "mosa"), libraryDir: currentMissing.libraryDir });
  t.after(() => { try { reopened.close(); } catch { /* closed */ } });
  assert.deepEqual(rowsOf(currentMissing.libraryDir), Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, index) => index + 1),
    "a current-version library missing 14–16 gets them on open");
});

test("the pre-v10 candidate sync survives a kill that used to land after the migration commit", async (t) => {
  const a = await createLibraryRoot(t, "mosa-350-v9-kill-");
  const b = await createLibraryRoot(t, "mosa-350-v9-ref-");
  const seed = (lib) => {
    bootstrapLibrary(lib.projectRoot, lib.libraryDir);
    withRawDatabase(lib.libraryDir, (database) => {
      database.transaction(() => {
        database.prepare("INSERT OR IGNORE INTO projects (id, created_at) VALUES ('default', ?)").run(CREATED);
        insertAssetRow(database, { id: "root-a" });
        insertAssetRow(database, { id: "root-b" });
        for (const [id, assetId, createdAt, refs] of [
          ["ev-parent", "root-a", "2026-05-01T00:00:00.000Z", "[]"],
          ["ev-child", "root-b", "2026-05-02T00:00:00.000Z", JSON.stringify([{ reference_id: "ev-parent" }])],
        ]) {
          database.prepare(`
            INSERT INTO generation_events (
              project_id, id, output_asset_id, provider, capture_context_id, provider_tool_call_id, provider_generation_call_id,
              provider_response_id, provider_asset_id, conversation_id, message_id, batch_id, model, user_prompt, effective_prompt,
              prompt_status, prompt_scope, generation_status, capture_channel, verification_level, references_json, evidence_json, created_at
            ) VALUES (
              'default', @id, @assetId, 'chatgpt', '', '', '',
              '', @providerAssetId, 'conv-1', @messageId, '', 'gpt-5', '', @prompt,
              '', '', 'unknown', '', 'observed', @refs, '{}', @createdAt
            )
          `).run({ id, assetId, providerAssetId: `pa-${id}`, messageId: `msg-${id}`, prompt: `prompt ${id}`, refs, createdAt });
        }
      })();
    });
    downgradeSchemaVersion(lib.libraryDir, 9);
  };
  seed(a);
  seed(b);

  const scriptPath = await writeChildScript(a.root);
  writeFileSync(join(a.root, "go"), "go");
  const killed = await runChild(scriptPath, {
    MOSA_TEST_CHILD_LIBRARY: a.libraryDir,
    MOSA_TEST_CHILD_PROJECT_ROOT: a.projectRoot,
    MOSA_TEST_CHILD_GO_FILE: join(a.root, "go"),
    MOSA_TEST_SCHEMA_UPGRADE_KILL: "mid-upgrade",
  });
  assert.equal(killed.signal, "SIGKILL", "the child died mid-upgrade (the old code had already committed here)");

  // The reference library runs the same upgrade uninterrupted.
  const referenceStore = createSqliteAssetStore({ projectRoot: b.projectRoot, managerDir: join(b.projectRoot, "mosa"), libraryDir: b.libraryDir });
  referenceStore.close();
  const store = createSqliteAssetStore({ projectRoot: a.projectRoot, managerDir: join(a.projectRoot, "mosa"), libraryDir: a.libraryDir });
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  const candidates = (libraryDir) => withRawDatabase(libraryDir, (database) =>
    database.prepare("SELECT child_generation_id, parent_generation_id FROM generation_relation_candidates ORDER BY child_generation_id").all());
  assert.deepEqual(candidates(a.libraryDir), candidates(b.libraryDir),
    "the relation candidates match the uninterrupted reference");
  assert.ok(candidates(a.libraryDir).length >= 1, `the resolver produced candidates (${JSON.stringify(candidates(a.libraryDir))})`);
  assert.equal(withRawDatabase(a.libraryDir, (database) => database.pragma("integrity_check", { simple: true })), "ok");
});

// --- 10: trashed Jimeng captures rejoin their stack (task 350 #9) ---------------

test("a trashed Jimeng capture rejoins its session stack after the upgrade", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-350-jimeng-");
  bootstrapLibrary(projectRoot, libraryDir);
  const jimengSource = JSON.stringify({ type: "web-jimeng", workspace_id: "w-1", conversation_id: "jm-1" });
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      for (const [id, deletedAt] of [["jm-a", null], ["jm-b", null], ["jm-c", "2026-05-03T00:00:00.000Z"]]) {
        insertAssetRow(database, {
          id,
          deletedAt,
          sessionKey: "web-jimeng:w-1:jm-1",
          sourceType: "web-jimeng",
          sourceJson: jimengSource,
        });
      }
    })();
  });
  downgradeSchemaVersion(libraryDir, 16);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  const stacksOf = () => withRawDatabase(libraryDir, (database) =>
    database.prepare(`
      SELECT sm.asset_id, sm.stack_id FROM asset_stack_members sm
      JOIN asset_stacks s ON s.project_id = sm.project_id AND s.id = sm.stack_id
      WHERE s.origin = 'auto'
      ORDER BY sm.asset_id
    `).all());
  const members = stacksOf();
  assert.equal(members.length, 3, `all three captures (trash included) joined the session stack (${JSON.stringify(members)})`);
  assert.deepEqual(members.map((row) => row.asset_id), ["jm-a", "jm-b", "jm-c"]);

  // Restoring the trashed member keeps it in the stack.
  await store.restoreAsset("default", "jm-c");
  const restored = stacksOf().find((row) => row.asset_id === "jm-c");
  assert.ok(restored, "the restored capture is still a stack member");
  assert.equal(restored.stack_id, members.find((row) => row.asset_id === "jm-a").stack_id);
});

// --- 11: a library newer than this build is refused untouched (task 350 #7) -----

test("a newer-schema library is refused before anything writes, with the right error and text", async (t) => {
  const { rmSync } = await import("node:fs");
  const { readFile } = await import("node:fs/promises");
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-350-newer-");
  bootstrapLibrary(projectRoot, libraryDir);
  downgradeSchemaVersion(libraryDir, CURRENT_SCHEMA_VERSION + 1);
  const databasePath = join(libraryDir, "mosa.db");
  // A non-WAL database makes the "nothing may write" contract byte-visible:
  // any write-mode open converts the journal mode in the file header. The
  // probe must refuse the library before openDatabase ever gets there.
  withRawDatabase(libraryDir, (database) => {
    database.pragma("journal_mode = DELETE");
  });
  // Simulate a cleanly closed library: the refused open itself must not leave
  // any journal files.
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  const sha256Of = async () => createHash("sha256").update(await readFile(databasePath)).digest("hex");
  const sha256Before = await sha256Of();

  assert.throws(
    () => createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir }),
    (error) => {
      assert.equal(error.code, "MOSA_LIBRARY_SCHEMA_NEWER");
      assert.match(error.message, /newer version of GravityPort/);
      assert.match(error.message, /latest GravityPort/i);
      return true;
    },
    "the open is refused with the fixed error code",
  );
  assert.equal(await sha256Of(), sha256Before, "mosa.db is byte-identical after the refused open");
  assert.ok(!existsSync(`${databasePath}-wal`), "no -wal file was left behind");
  assert.ok(!existsSync(`${databasePath}-shm`), "no -shm file was left behind");

  const zh = getLibraryStartupFailureText({ code: "MOSA_LIBRARY_SCHEMA_NEWER" }, "zh");
  assert.equal(zh.title, "需要更新 GravityPort");
  assert.match(zh.body, /请到官网下载最新版/);
  assert.match(zh.body, /你的素材没有被改动/);
  const en = getLibraryStartupFailureText({ code: "MOSA_LIBRARY_SCHEMA_NEWER" }, "en");
  assert.match(en.title, /Update GravityPort/);
  assert.match(en.body, /latest version from the website/);
  assert.match(en.body, /assets were not modified/);
});

// --- 12: the notice endpoints (task 350 #2) -------------------------------------

test("the schema-upgrade notice endpoints answer and latch", async (t) => {
  const { startMosaRuntime } = await import("../lib/mosa-runtime.mjs");
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-350-endpoint-");
  bootstrapLibrary(projectRoot, libraryDir);
  const snapshot = vacuumSnapshotInto(libraryDir, 16, 18);
  setMarker(libraryDir, "migration_state", "completed");
  setMarker(libraryDir, SCHEMA_UPGRADE_VERIFY_KEY, JSON.stringify({
    targetVersion: 18, status: "failed", integrity: "ok", foreignKeyViolations: 1,
    foreignKeyBaselineViolations: 0, trigger: "upgrade", backupPath: snapshot, checkedAt: CREATED,
  }));

  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot,
    managerDir: REPO_ROOT,
    libraryDir,
    assetsRoot: join(libraryDir, "assets"),
    generatedImagesDir: join(projectRoot, "generated-images"),
    codexImagesDir: join(projectRoot, "codex-images"),
    codexSessionsDir: join(projectRoot, "codex-sessions"),
    grokSessionsDir: join(projectRoot, "grok-sessions"),
    cowartCanvasDir: join(projectRoot, "cowart-canvas"),
    cowartRegistryPath: join(projectRoot, "state", "cowart-projects.json"),
    appDir: join(REPO_ROOT, "web", "gravityport", "dist"),
  });
  t.after(() => { try { void runtime.stop(); } catch { /* stopped */ } });
  const headers = { "x-mosa-client-token": runtime.clientToken };
  const get = () => fetch(`${runtime.url}/api/schema-upgrade-notice`, { headers });
  const initial = await (await get()).json();
  assert.equal(initial.shouldShow, true, "the failed record says show");
  assert.equal(initial.backupPath, snapshot);
  assert.equal(initial.targetVersion, 18);

  const post = await fetch(`${runtime.url}/api/schema-upgrade-notice`, { method: "POST", headers });
  assert.equal((await post.json()).ok, true);
  assert.equal((await (await get()).json()).shouldShow, false, "the acknowledgement latches");
  assert.ok(JSON.parse(markerValue(libraryDir, SCHEMA_UPGRADE_VERIFY_KEY)).noticeDismissedAt,
    "the latch lives on the verify record");

  // Without a valid client token the endpoint answers 401 like every other
  // non-public route. (clean-test-env auto-attaches the shared test token to
  // loopback /api/ fetches; an explicit wrong header is preserved.)
  const anonymous = await fetch(`${runtime.url}/api/schema-upgrade-notice`, {
    headers: { "x-mosa-client-token": "definitely-not-the-token" },
  });
  assert.equal(anonymous.status, 401);
});

// --- 13: the snapshot must be a PRE-upgrade image (rework 1 #1) ------------------

test("a snapshot vacuumed after another process upgraded is discarded, not renamed over the true pre-upgrade image", async (t) => {
  const a = await createLibraryRoot(t, "mosa-350r1-stale-snap-");
  bootstrapLibrary(a.projectRoot, a.libraryDir);
  withRawDatabase(a.libraryDir, (database) => {
    database.transaction(() => {
      for (let index = 0; index < 3; index += 1) insertAssetRow(database, { id: `stale-${index}` });
    })();
  });
  downgradeSchemaVersion(a.libraryDir, 16);

  // The loser parks between its version read and its VACUUM INTO.
  const gateFile = join(a.root, "read-gate");
  const scriptPath = await writeChildScript(a.root);
  const loser = runChild(scriptPath, {
    MOSA_TEST_CHILD_LIBRARY: a.libraryDir,
    MOSA_TEST_CHILD_PROJECT_ROOT: a.projectRoot,
    MOSA_TEST_CHILD_GO_FILE: join(a.root, "already-there"),
    MOSA_TEST_SCHEMA_BACKUP_READ_GATE: gateFile,
  });
  const gateDeadline = Date.now() + 30000;
  while (!existsSync(gateFile) && Date.now() < gateDeadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.ok(existsSync(gateFile), "the loser parked at the read gate");

  // While it waits, another process completes the ENTIRE upgrade: v18, its
  // own true pre-upgrade snapshot, and the pending record.
  const winner = createSqliteAssetStore({ projectRoot: a.projectRoot, managerDir: join(a.projectRoot, "mosa"), libraryDir: a.libraryDir });
  winner.close();
  const winnerRecord = JSON.parse(markerValue(a.libraryDir, SCHEMA_UPGRADE_VERIFY_KEY));
  assert.equal(winnerRecord?.status, "pending", "the winner upgraded and wrote its pending record");
  assert.equal(snapshotSchemaVersion(winnerRecord.backupPath), 16, "the winner's snapshot is a genuine v16 image");

  // Release the loser: its vacuum now reads a v18 library.
  writeFileSync(`${gateFile}.go`, "go");
  const loserResult = await loser;
  assert.equal(loserResult.code, 0, `the loser still opened the library (${loserResult.stderr.slice(0, 200)})`);

  // The discarded vacuum left no partial and never overwrote the winner's
  // snapshot — the final-name file is still the v16 image.
  assert.deepEqual(backupNames(a.libraryDir).filter((name) => name.includes(".partial")), [], "no partial residue");
  assert.equal(snapshotSchemaVersion(winnerRecord.backupPath), 16, "the winner's pre-upgrade snapshot was not replaced");
  const finalFiles = listSchemaUpgradeBackupFiles(a.libraryDir).filter((file) => !file.isPartial);
  for (const file of finalFiles) {
    assert.equal(snapshotSchemaVersion(file.path), 16, `final-name snapshot ${file.name} is still a v16 image`);
  }
});

// --- 14: cleanup guards (rework 1 #2) --------------------------------------------

test("cleanup skips a live writer's partial and never deletes newer version pairs", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-350r1-cleanup-guard-");
  bootstrapLibrary(projectRoot, libraryDir);
  setMarker(libraryDir, SCHEMA_UPGRADE_VERIFY_KEY, JSON.stringify({
    targetVersion: 16, status: "ok", integrity: "ok", foreignKeyViolations: 0,
    foreignKeyBaselineViolations: 0, trigger: "upgrade", backupPath: null, checkedAt: CREATED,
  }));
  const dir = backupDir(libraryDir);
  mkdirSync(dir, { recursive: true });
  const deletable = join(dir, "mosa-before-v15-from-v14.db");
  const newerPair = join(dir, "mosa-before-v18-from-v16.db");
  const livePartial = join(dir, `mosa-before-v16-from-v15.db.partial-${process.pid}-c0ffee`);
  const deadPartial = join(dir, "mosa-before-v16-from-v15.db.partial-999999999-deadbeef");
  for (const path of [deletable, newerPair, livePartial, deadPartial]) {
    writeFileSync(path, "snapshot bytes");
  }

  const raw = new Database(join(libraryDir, "mosa.db"));
  let result;
  try {
    result = await settleSchemaUpgradeBackupCleanup(raw, {
      libraryDir,
      databasePath: join(libraryDir, "mosa.db"),
    });
  } finally {
    raw.close();
  }
  assert.equal(result.status, "ok");
  assert.equal(result.deleted, 2, `the in-range snapshot and the dead pid's partial are deleted (${JSON.stringify(result)})`);
  assert.ok(!existsSync(deletable), "the toVersion<=target snapshot is deleted");
  assert.ok(existsSync(newerPair), "a newer version pair is never touched by an older verdict");
  assert.ok(existsSync(livePartial), "the live writer's partial is skipped this pass");
  assert.ok(!existsSync(deadPartial), "a dead pid's partial is crashed residue and gets deleted");
  assert.equal(isPartialFileBeingWritten(`mosa-before-v18-from-v16.db.partial-${process.pid}-c0ffee`), true);
  assert.equal(isPartialFileBeingWritten("mosa-before-v18-from-v16.db.partial-999999999-deadbeef"), false);
  assert.equal(isPartialFileBeingWritten("mosa-before-v18-from-v16.db"), false);
});

// --- 15: concurrent column repairs cannot lock a process out (rework 1 #3) -------

test("two concurrent openers of a current-version library missing columns both succeed", async (t) => {
  const a = await createLibraryRoot(t, "mosa-350r1-addcol-a-");
  bootstrapLibrary(a.projectRoot, a.libraryDir);
  withRawDatabase(a.libraryDir, (database) => {
    database.transaction(() => {
      insertAssetRow(database, { id: "race-a", sourceType: "web-chatgpt", sourceJson: JSON.stringify({ type: "web-chatgpt", provider_asset_id: "pa-a", logical_output_id: "lo-a" }) });
      insertAssetRow(database, { id: "race-b", sourceType: "web-chatgpt", sourceJson: JSON.stringify({ type: "web-chatgpt", provider_asset_id: "pa-b" }) });
      database.prepare("INSERT INTO tags (id, normalized_name, name) VALUES ('t-race', 'sunset', 'sunset')").run();
      database.prepare("INSERT INTO asset_tags (project_id, asset_id, tag_id) VALUES ('default', 'race-a', 't-race')").run();
    })();
  });
  // Break the columns on an already-current library (indexes first: SQLite
  // refuses to drop indexed columns).
  withRawDatabase(a.libraryDir, (database) => {
    database.transaction(() => {
      database.exec("DROP INDEX IF EXISTS assets_project_provider_asset_idx");
      database.exec("DROP INDEX IF EXISTS assets_project_logical_output_idx");
      database.exec("DROP INDEX IF EXISTS assets_project_epoch_idx");
      database.exec("ALTER TABLE assets DROP COLUMN provider_asset_id");
      database.exec("ALTER TABLE assets DROP COLUMN logical_output_id");
      database.exec("ALTER TABLE assets DROP COLUMN tags_text");
      // created_at_epoch is added by a bare ALTER OUTSIDE any transaction
      // (ensureCreatedAtEpoch) — the only shape that can truly race into
      // "duplicate column name" between two openers.
      database.exec("ALTER TABLE assets DROP COLUMN created_at_epoch");
    })();
  });

  const scriptPath = await writeChildScript(a.root);
  const goFile = join(a.root, "go");
  const children = [1, 2].map(() => runChild(scriptPath, {
    MOSA_TEST_CHILD_LIBRARY: a.libraryDir,
    MOSA_TEST_CHILD_PROJECT_ROOT: a.projectRoot,
    MOSA_TEST_CHILD_GO_FILE: goFile,
  }));
  await new Promise((resolveWait) => setTimeout(resolveWait, 800));
  writeFileSync(goFile, "go");
  const results = await Promise.all(children);
  for (const [index, result] of results.entries()) {
    assert.equal(result.code, 0, `opener ${index + 1} must succeed despite the racing column adds (${result.stderr.slice(0, 300)})`);
    assert.ok(result.stdout.includes("child-ok"));
  }
  withRawDatabase(a.libraryDir, (database) => {
    const info = database.prepare("SELECT name FROM pragma_table_info('assets')").all().map((row) => row.name);
    for (const column of ["provider_asset_id", "logical_output_id", "tags_text", "created_at_epoch"]) {
      assert.ok(info.includes(column), `column ${column} is back`);
    }
    const winner = database.prepare("SELECT provider_asset_id, logical_output_id, tags_text FROM assets WHERE id = 'race-a'").get();
    assert.equal(winner.provider_asset_id, "pa-a");
    assert.equal(winner.logical_output_id, "lo-a");
    assert.equal(winner.tags_text, "sunset");
    const loser = database.prepare("SELECT provider_asset_id, logical_output_id, tags_text FROM assets WHERE id = 'race-b'").get();
    assert.equal(loser.provider_asset_id, "pa-b");
    assert.equal(loser.logical_output_id, "");
    assert.equal(loser.tags_text, "");
  });
});

// Rework 1, deterministic half of the racing-column test above: the race
// itself is timing-dependent, so pin the helper's contract directly — a column
// another process already added is success, anything else still throws.
test("addColumnIfMissing treats an already-added column as success and rethrows other errors", () => {
  const database = new Database(":memory:");
  try {
    database.exec("CREATE TABLE t (id TEXT)");
    assert.equal(addColumnIfMissing(database, "t", "extra", "TEXT NOT NULL DEFAULT ''"), true, "first add creates it");
    assert.equal(addColumnIfMissing(database, "t", "extra", "TEXT NOT NULL DEFAULT ''"), false, "a duplicate add is success, not an error");
    assert.throws(() => addColumnIfMissing(database, "missing_table", "extra", "TEXT"), /no such table/);
  } finally {
    database.close();
  }
});

test("a partial whose writer pid exists but is not ours (EPERM) counts as still being written", () => {
  const original = process.kill;
  process.kill = () => { const error = new Error("operation not permitted"); error.code = "EPERM"; throw error; };
  try {
    assert.equal(isPartialFileBeingWritten("mosa-before-v18-from-v16.db.partial-4242-c0ffee"), true);
  } finally {
    process.kill = original;
  }
  process.kill = () => { const error = new Error("no such process"); error.code = "ESRCH"; throw error; };
  try {
    assert.equal(isPartialFileBeingWritten("mosa-before-v18-from-v16.db.partial-4242-c0ffee"), false);
  } finally {
    process.kill = original;
  }
});
