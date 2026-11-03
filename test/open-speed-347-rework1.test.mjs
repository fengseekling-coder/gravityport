// Task 347 rework 1: shutdown must interrupt background maintenance between
// batches (exit never hangs, the update handoff keeps its 5s window); the
// upgrade-verify record must distinguish damage from infrastructure trouble
// and survive reruns; stack sort keys must refresh on the three paths that
// change stack membership or member trash state without a stack record; the
// background passes must invalidate same-connection caches, announce their
// rows, run with per-pass default batch sizes, and a media replacement must
// not clobber fields a repair fixed while it was running.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";

import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import {
  SCHEMA_UPGRADE_VERIFY_KEY,
  classifySchemaVerifyFailure,
  runSchemaUpgradeVerify,
} from "../lib/schema-upgrade-verify.mjs";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { assetSortName } from "../lib/asset-sort.js";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CREATED = "2026-05-01T00:00:00.000Z";

async function createLibraryRoot(t, prefix = "mosa-347r1-") {
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

function insertAssetRow(database, {
  id,
  projectId = "default",
  createdAt = CREATED,
  epoch = Date.parse(CREATED),
  deletedAt = null,
  prompt = `fixture ${id}`,
  searchText = prompt,
  sourceType = "local-file",
  sourceJson = JSON.stringify({ type: "local-file" }),
  conversationId = "",
  sessionKey = "",
  sourcePath = "",
  originalPath = "/src",
  groupName = "",
  asset: assetName = `${id}.png`,
}) {
  database.prepare(`
    INSERT INTO assets (
      project_id, id, asset, original_path, content_sha256, pixel_sha256, prompt, skill, style, ratio, business_fields_json, theme,
      favorite, archived, group_name, category, rating, version_change, source_type, source_json, source_path, metadata_json, search_text,
      tags_text, business_search_text, source_search_text, media_kind, source_group, conversation_id, generation_session_key, generation_batch,
      created_at, created_at_epoch, updated_at, sort_name
    ) VALUES (
      @projectId, @id, @asset, @originalPath, @hash, '', @prompt, '', '', '', '{}', '',
      0, 0, @groupName, '', 0, '', @sourceType, @sourceJson, @sourcePath, '{}', @searchText,
      '', '', '', 'image', @sourceType, @conversationId, @sessionKey, '',
      @createdAt, @epoch, @createdAt, @sortName
    )
  `).run({
    projectId, id, asset: assetName, hash: `hash-${id}`, prompt, sourceType, sourceJson,
    sourcePath, searchText, conversationId, sessionKey, groupName, createdAt, epoch, originalPath,
    sortName: assetSortName({ theme: "", asset: assetName, id }),
  });
  if (deletedAt) {
    database.prepare("UPDATE assets SET deleted_at = ? WHERE project_id = ? AND id = ?").run(deletedAt, projectId, id);
  }
}

function insertStackRow(database, { id, createdAt = CREATED, sortCreatedAt = "" }) {
  database.prepare(`
    INSERT INTO asset_stacks (project_id, id, created_at, updated_at, sort_created_at, sort_name, name)
    VALUES ('default', @id, @createdAt, @createdAt, @sortCreatedAt, @id, '')
  `).run({ id, createdAt, sortCreatedAt });
}

function insertStackMember(database, { stackId, assetId, position }) {
  database.prepare(`
    INSERT INTO asset_stack_members (project_id, stack_id, asset_id, position, added_at)
    VALUES ('default', @stackId, @assetId, @position, @addedAt)
  `).run({ stackId, assetId, position, addedAt: CREATED });
}

// --- 1: shutdown stops background maintenance between batches -------------------

function searchScopeSnapshot(libraryDir) {
  return withRawDatabase(libraryDir, (database) => ({
    rows: database.prepare("SELECT project_id, id, search_text, source_search_text, business_search_text FROM assets ORDER BY project_id, id").all(),
    fts: database.prepare("SELECT project_id, asset_id, content FROM asset_fts ORDER BY project_id, asset_id").all(),
    terms: database.prepare("SELECT project_id, asset_id, term FROM asset_short_terms ORDER BY project_id, asset_id, term").all(),
  }));
}

function buildLegacySearchLibrary(libraryDir, rows) {
  const filler = "整理 灯笼 研究灯笼 red lantern study detail ".repeat(24); // ≈2KB
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      for (let index = 0; index < rows; index += 1) {
        const legacy = `lantern study ${index} /tmp/zqx9-${index}/lamp-${index}.png deadbeef${index} ${filler}`;
        insertAssetRow(database, {
          id: `legacy-${index}`,
          prompt: `lantern study ${index} ${filler}`,
          searchText: legacy,
          sourceJson: JSON.stringify({ type: "local-file", path: `/tmp/zqx9-${index}/lamp-${index}.png` }),
          sourcePath: `/tmp/zqx9-${index}/lamp-${index}.png`,
        });
      }
      // startMosaRuntime only serves migration-complete libraries.
      database.prepare("UPDATE library_meta SET value = 'completed' WHERE key = 'migration_state'").run();
    })();
  });
}

test("an aborted background maintenance stops between batches and the next open finishes it identically", async (t) => {
  const a = await createLibraryRoot(t, "mosa-347r1-stop-a-");
  const b = await createLibraryRoot(t, "mosa-347r1-stop-ref-");
  for (const lib of [a, b]) bootstrapLibrary(lib.projectRoot, lib.libraryDir);
  buildLegacySearchLibrary(a.libraryDir, 2400);
  buildLegacySearchLibrary(b.libraryDir, 2400);

  process.env.MOSA_TEST_DEFERRED_MAINTENANCE_BATCH_SIZE = "100";
  try {
    const store = createSqliteAssetStore({ projectRoot: a.projectRoot, managerDir: join(a.projectRoot, "mosa"), libraryDir: a.libraryDir });
    t.after(() => { try { store.close(); } catch { /* closed */ } });
    const controller = new AbortController();
    const settled = store.startDeferredMaintenance({ signal: controller.signal });
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    const abortStarted = performance.now();
    controller.abort();
    await settled;
    const stopMs = performance.now() - abortStarted;
    assert.ok(stopMs < 1500, `the stop must land between two batches (took ${stopMs.toFixed(0)}ms)`);
    assert.equal(markerValue(a.libraryDir, "search_scope_v3"), null, "the interrupted run wrote no completion marker");
    store.close();

    // Reference: the same library, uninterrupted.
    const reference = createSqliteAssetStore({ projectRoot: b.projectRoot, managerDir: join(b.projectRoot, "mosa"), libraryDir: b.libraryDir });
    await reference.startDeferredMaintenance();
    reference.close();

    // The interrupted library resumes on the next open and converges.
    const resumed = createSqliteAssetStore({ projectRoot: a.projectRoot, managerDir: join(a.projectRoot, "mosa"), libraryDir: a.libraryDir });
    await resumed.startDeferredMaintenance();
    resumed.close();
    assert.ok(markerValue(a.libraryDir, "search_scope_v3"), "the resumed run completes the marker");
    assert.deepEqual(searchScopeSnapshot(a.libraryDir), searchScopeSnapshot(b.libraryDir),
      "the interrupted-then-resumed result equals an uninterrupted run");
  } finally {
    delete process.env.MOSA_TEST_DEFERRED_MAINTENANCE_BATCH_SIZE;
  }
});

test("runtime stop interrupts the background sweep instead of hanging exit", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-347r1-stop-rt-");
  bootstrapLibrary(projectRoot, libraryDir);
  buildLegacySearchLibrary(libraryDir, 8000);

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
  assert.equal((await fetch(`${runtime.url}/api/health`)).status, 200);
  // The maintenance chain starts ~1.8s after listen; by 2.4s the search-scope
  // sweep (8000 rows, marker absent) is mid-flight.
  await new Promise((resolveWait) => setTimeout(resolveWait, 2400));
  assert.equal(markerValue(libraryDir, "search_scope_v3"), null, "the sweep is still running when stop arrives");
  const started = performance.now();
  await runtime.stop();
  const stopMs = performance.now() - started;
  assert.ok(stopMs < 3000, `stop must only wait out the batch in flight (took ${stopMs.toFixed(0)}ms; an uninterrupted sweep of this library takes many seconds)`);
  assert.equal(markerValue(libraryDir, "search_scope_v3"), null, "the sweep did not finish before exit");
});

// --- 2: the upgrade-verify record is reliable ------------------------------------

function makeFakeWorker() {
  const worker = new EventEmitter();
  worker.postMessage = (message) => { worker.queue = worker.queue || []; worker.queue.push(message); };
  worker.terminate = () => {};
  return worker;
}

async function flushAsync() {
  await new Promise((resolveFlush) => setTimeout(resolveFlush, 20));
}

test("a verify worker that exits without answering — any exit code — stays pending", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-347r1-verify-exit-");
  bootstrapLibrary(projectRoot, libraryDir);
  setMarker(libraryDir, SCHEMA_UPGRADE_VERIFY_KEY, JSON.stringify({ status: "pending", targetVersion: 17, backupPath: "/snap/x.db", checkedAt: "2026-01-01T00:00:00.000Z" }));
  const raw = new Database(join(libraryDir, "mosa.db"));
  t.after(() => { try { raw.close(); } catch { /* closed */ } });

  for (const exitCode of [0, 1]) {
    const worker = makeFakeWorker();
    const run = runSchemaUpgradeVerify(raw, {
      databasePath: join(libraryDir, "mosa.db"),
      targetVersion: null,
      backupPath: null,
      spawnWorker: () => worker,
    });
    await flushAsync();
    worker.emit("exit", exitCode);
    const result = await run;
    assert.equal(result?.status, "pending", `exit code ${exitCode} without a message is infrastructure trouble, not damage`);
    const stored = JSON.parse(markerValue(libraryDir, SCHEMA_UPGRADE_VERIFY_KEY));
    assert.equal(stored.status, "pending", `exit code ${exitCode} keeps the record pending for the next open`);
    assert.equal(stored.backupPath, "/snap/x.db");
    // the pending record is refreshed so the next open re-runs it
    setMarker(libraryDir, SCHEMA_UPGRADE_VERIFY_KEY, JSON.stringify({ status: "pending", targetVersion: 17, backupPath: "/snap/x.db", checkedAt: "2026-01-01T00:00:00.000Z" }));
  }
});

test("the verify record distinguishes damage from infrastructure trouble and reruns keep the snapshot path", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-347r1-verify-class-");
  bootstrapLibrary(projectRoot, libraryDir);
  setMarker(libraryDir, SCHEMA_UPGRADE_VERIFY_KEY, JSON.stringify({ status: "pending", targetVersion: 17, backupPath: "/snap/keep-me.db", checkedAt: "2026-01-01T00:00:00.000Z" }));
  const raw = new Database(join(libraryDir, "mosa.db"));
  t.after(() => { try { raw.close(); } catch { /* closed */ } });

  // (a) infrastructure trouble (cannot open / busy / I/O, with or without a
  // SQLite code) keeps the record pending for the next open.
  const busyWorker = makeFakeWorker();
  const busy = runSchemaUpgradeVerify(raw, {
    databasePath: join(libraryDir, "mosa.db"),
    targetVersion: 17,
    spawnWorker: () => busyWorker,
  });
  await flushAsync();
  busyWorker.emit("message", { ran: false, ok: false, integrity: null, foreignKeyViolations: 0, error: "database is locked", errorCode: "SQLITE_BUSY" });
  const busyResult = await busy;
  assert.equal(busyResult?.status, "pending", "SQLITE_BUSY stays pending");
  assert.equal(JSON.parse(markerValue(libraryDir, SCHEMA_UPGRADE_VERIFY_KEY)).status, "pending");

  const plainWorker = makeFakeWorker();
  const plain = runSchemaUpgradeVerify(raw, {
    databasePath: join(libraryDir, "mosa.db"),
    targetVersion: 17,
    spawnWorker: () => plainWorker,
  });
  await flushAsync();
  plainWorker.emit("message", { ran: false, ok: false, integrity: null, foreignKeyViolations: 0, error: "require is not defined", errorCode: "" });
  const plainResult = await plain;
  assert.equal(plainResult?.status, "pending", "a no-code worker crash stays pending");

  // (b) a rerun keeps the interrupted record's targetVersion and backupPath —
  // the caller passes null for both on a plain reopen.
  const okWorker = makeFakeWorker();
  const okRun = runSchemaUpgradeVerify(raw, {
    databasePath: join(libraryDir, "mosa.db"),
    targetVersion: null,
    backupPath: null,
    spawnWorker: () => okWorker,
  });
  await flushAsync();
  okWorker.emit("message", { ran: true, ok: true, integrity: "ok", foreignKeyViolations: 0, error: null, errorCode: "" });
  const okResult = await okRun;
  assert.equal(okResult?.status, "ok");
  assert.equal(okResult.backupPath, "/snap/keep-me.db", "the rerun keeps the interrupted record's backupPath");
  assert.equal(okResult.targetVersion, 17, "the rerun keeps the interrupted record's targetVersion");
  const stored = JSON.parse(markerValue(libraryDir, SCHEMA_UPGRADE_VERIFY_KEY));
  assert.equal(stored.status, "ok");
  assert.equal(stored.backupPath, "/snap/keep-me.db");

  // (a, damage side) the checks themselves saying no is terminal failed, and
  // a direct SQLITE_CORRUPT from the worker too.
  const damagedWorker = makeFakeWorker();
  setMarker(libraryDir, SCHEMA_UPGRADE_VERIFY_KEY, JSON.stringify({ status: "pending", targetVersion: 17, backupPath: "/snap/keep-me.db" }));
  const damaged = runSchemaUpgradeVerify(raw, {
    databasePath: join(libraryDir, "mosa.db"),
    targetVersion: 17,
    spawnWorker: () => damagedWorker,
  });
  await flushAsync();
  damagedWorker.emit("message", { ran: true, ok: false, integrity: "corrupt", foreignKeyViolations: 0, error: null, errorCode: "" });
  assert.equal((await damaged)?.status, "failed");

  const notadbWorker = makeFakeWorker();
  setMarker(libraryDir, SCHEMA_UPGRADE_VERIFY_KEY, JSON.stringify({ status: "pending", targetVersion: 17, backupPath: "/snap/keep-me.db" }));
  const notadb = runSchemaUpgradeVerify(raw, {
    databasePath: join(libraryDir, "mosa.db"),
    targetVersion: 17,
    spawnWorker: () => notadbWorker,
  });
  await flushAsync();
  notadbWorker.emit("message", { ran: false, ok: false, integrity: null, foreignKeyViolations: 0, error: "file is not a database", errorCode: "SQLITE_NOTADB" });
  assert.equal((await notadb)?.status, "failed", "SQLITE_NOTADB at open is damage, not infrastructure");

  // classification unit edges
  assert.equal(classifySchemaVerifyFailure({ ran: true }), "corrupt");
  assert.equal(classifySchemaVerifyFailure({ ran: false, errorCode: "SQLITE_BUSY" }), "infra");
  assert.equal(classifySchemaVerifyFailure({ ran: false, errorCode: "" }), "infra");
});

test("the pending verify record is written synchronously at the upgrade open", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-347r1-verify-pending-");
  bootstrapLibrary(projectRoot, libraryDir);
  withRawDatabase(libraryDir, (database) => {
    database.prepare("UPDATE library_meta SET value = '16' WHERE key = 'schema_version'").run();
  });
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  // Before any background maintenance ran, the record must already exist and
  // name the snapshot, so a kill (or an MCP/CLI upgrade that never runs
  // maintenance) cannot leave the snapshot unverified forever.
  const record = JSON.parse(markerValue(libraryDir, SCHEMA_UPGRADE_VERIFY_KEY));
  assert.equal(record.status, "pending");
  assert.ok(record.backupPath && existsSync(record.backupPath), "the pending record names the pre-upgrade snapshot");
  assert.equal(record.targetVersion, 17);
  await store.startDeferredMaintenance();
  assert.equal(JSON.parse(markerValue(libraryDir, SCHEMA_UPGRADE_VERIFY_KEY)).status, "ok", "the App's maintenance finishes the pending check");
});

// --- 3: stack sort keys refresh on the three membership-changing paths ----------

async function buildStackGroupFixture(t, { projectRoot, libraryDir }) {
  const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  const ingest = (assetId, createdAt) => store.createAsset({ assetId, imagePath: sourcePath, created_at: createdAt, source: { type: "local-file", path: `/src/${assetId}.png` } });
  await ingest("newest", "2026-05-03T00:00:00.000Z");
  await ingest("middle", "2026-05-02T00:00:00.000Z");
  await ingest("older", "2026-05-01T00:00:00.000Z");
  await ingest("extra", "2026-04-30T00:00:00.000Z");
  await store.createGroup({ projectId: "default", name: "g1" });
  // Group membership via the raw column (the group row is what deleteGroup needs).
  withRawDatabase(libraryDir, (database) => {
    database.prepare("UPDATE assets SET group_name = 'g1' WHERE id IN ('newest', 'middle')").run();
  });
  // Cover = "middle" (position 0), so the non-cover edits below really
  // exercise the refresh that the cover-only stack-updated record misses.
  const stack = await store.createAssetStack("default", ["middle", "older", "extra", "newest"]);
  return { store, stack, sourcePath };
}

function stackSortOf(libraryDir, stackId) {
  return withRawDatabase(libraryDir, (database) =>
    database.prepare("SELECT sort_created_at FROM asset_stacks WHERE project_id = 'default' AND id = ?").get(stackId)?.sort_created_at);
}

test("trashing a group refreshes the stacks holding its members (and survives reopen + maintenance)", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-347r1-stack-trash-");
  const { store, stack } = await buildStackGroupFixture(t, { projectRoot, libraryDir });
  assert.equal(stackSortOf(libraryDir, stack.id), "2026-05-03T00:00:00.000Z", "the stack sorts by its newest member before the trash");
  await store.deleteGroup("default", "g1", { deleteAssets: true });
  assert.equal(stackSortOf(libraryDir, stack.id), "2026-05-01T00:00:00.000Z", "both trashed group members stop counting immediately");
  store.close();
  const reopened = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  await reopened.startDeferredMaintenance();
  assert.equal(stackSortOf(libraryDir, stack.id), "2026-05-01T00:00:00.000Z", "the corrected key survives reopen + maintenance");
  const page = await reopened.listAssetPage({ projectId: "default", limit: 0, collapseStacks: true, sort: "newest" });
  const stackNode = page.assets.find((asset) => asset.stack?.id === stack.id);
  assert.ok(stackNode, "the stack is still on the page");
  reopened.close();
});

test("permanently deleting a legacy group refreshes the compacted stacks", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-347r1-stack-hard-");
  const { store, stack } = await buildStackGroupFixture(t, { projectRoot, libraryDir });
  await store.deleteGroup("default", "g1", { deleteAssets: "legacy-hard-delete" });
  // "newest" and "middle" are gone; the stack keeps "oldest" and must sort by it.
  assert.equal(stackSortOf(libraryDir, stack.id), "2026-05-01T00:00:00.000Z", "the compacted stack sorts by its surviving member");
  store.close();
  const reopened = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  await reopened.startDeferredMaintenance();
  assert.equal(stackSortOf(libraryDir, stack.id), "2026-05-01T00:00:00.000Z", "the corrected key survives reopen + maintenance");
  reopened.close();
});

test("a metadata edit that changes a non-cover member's created_at refreshes its stack", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-347r1-stack-meta-");
  const { store, stack } = await buildStackGroupFixture(t, { projectRoot, libraryDir });
  await store.updateMetadata("default", "older", { created_at: "2026-06-01T00:00:00.000Z" });
  assert.equal(stackSortOf(libraryDir, stack.id), "2026-06-01T00:00:00.000Z", "the moved member's new date drives the stack sort immediately");
  store.close();
  const reopened = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  await reopened.startDeferredMaintenance();
  assert.equal(stackSortOf(libraryDir, stack.id), "2026-06-01T00:00:00.000Z", "the corrected key survives reopen + maintenance");
  reopened.close();
});

// --- 4: per-pass default batch sizes are runnable --------------------------------

test("background maintenance runs with the per-pass default batch sizes (no env override)", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-347r1-default-batch-");
  bootstrapLibrary(projectRoot, libraryDir);
  // A file-bytes candidate: the pass would hit its (previously undefined)
  // default batch size the moment it runs without an explicit override.
  await mkdir(projectRoot, { recursive: true });
  const imagePath = join(projectRoot, "sized.png");
  writeFileSync(imagePath, Buffer.from("png-bytes-for-size"));
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertAssetRow(database, {
        id: "sized-1",
        originalPath: imagePath,
        sourceJson: JSON.stringify({ type: "local-file", path: imagePath }),
        sourcePath: imagePath,
      });
    })();
  });
  assert.equal(process.env.MOSA_TEST_DEFERRED_MAINTENANCE_BATCH_SIZE, undefined, "no env override in this test");
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  await store.startDeferredMaintenance();
  assert.ok(markerValue(libraryDir, "file_bytes_backfill_v1"), "the file-bytes pass completed with its default batch size");
  const row = withRawDatabase(libraryDir, (database) =>
    database.prepare("SELECT business_fields_json FROM assets WHERE id = 'sized-1'").get());
  assert.equal(JSON.parse(row.business_fields_json).file_bytes, Buffer.byteLength("png-bytes-for-size"));
  assert.ok(markerValue(libraryDir, "video_metadata_backfill_v1"), "the video pass completed with its default batch size too");
});

// --- 5: cached pages and counts follow the repaired rows -------------------------

test("a page cached before the background repair returns the repaired order afterwards", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-347r1-cache-");
  bootstrapLibrary(projectRoot, libraryDir);
  // Legacy created_at text with NULL epochs: until the background repair
  // normalises them, the gallery's newest-first order is the raw id order.
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertAssetRow(database, { id: "aaa-legacy", createdAt: "Sat, 01 Jan 2000 00:00:00 GMT", epoch: null });
      insertAssetRow(database, { id: "bbb-recent", createdAt: "2026-05-02T00:00:00.000Z", epoch: null });
      insertAssetRow(database, { id: "ccc-middle", createdAt: "2026-05-01T00:00:00.000Z", epoch: null });
    })();
  });
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  const idsOf = async () => (await store.listAssetPage({ projectId: "default", limit: 10, sort: "newest" })).assets.map((asset) => asset.id);
  const before = await idsOf();
  assert.deepEqual(before, ["aaa-legacy", "bbb-recent", "ccc-middle"],
    "pre-repair the page orders by the raw created_at text, and \"Sat,\" sorts above ISO");
  clearDerivedCreatedMarker(libraryDir);
  await store.startDeferredMaintenance();
  const after = await idsOf();
  assert.deepEqual(after, ["bbb-recent", "ccc-middle", "aaa-legacy"], "the same page reflects the repaired created_at ordering");
});

function clearDerivedCreatedMarker(libraryDir) {
  withRawDatabase(libraryDir, (database) => {
    database.prepare("DELETE FROM library_meta WHERE key = 'derived:created_at_epoch'").run();
  });
}

// --- 5b: the two stack sort passes report the rows they repair ------------------

// One standalone asset plus a two-member stack. Which stack pass has work is
// set by the stack row alone: an empty sort_created_at belongs to the columns
// pass (it copies the cover's date), a stale non-empty one to the created_at
// pass (it recomputes the newest member's date). Either way the stack starts
// below the standalone asset and ends above it, so the page read before the
// repair and the one read after it must differ. Both passes drive their rows
// through the batched runner, which only calls onBatchResult — and so only
// invalidates caches and announces library-backfilled — when applyBatch
// returns the number of rows it changed.
async function expectStackPassReportsRepair(t, {
  prefix,
  reason,
  otherReason,
  stack,
  coverCreatedAt,
  secondCreatedAt,
  keyBefore,
  keyAfter,
}) {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, prefix);
  bootstrapLibrary(projectRoot, libraryDir);
  const soloCreatedAt = "2026-05-02T00:00:00.000Z";
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      for (const [id, createdAt] of [["solo", soloCreatedAt], ["cover", coverCreatedAt], ["second", secondCreatedAt]]) {
        insertAssetRow(database, { id, createdAt, epoch: Date.parse(createdAt) });
      }
      insertStackRow(database, { id: "stk", ...stack });
      insertStackMember(database, { stackId: "stk", assetId: "cover", position: 0 });
      insertStackMember(database, { stackId: "stk", assetId: "second", position: 1 });
    })();
  });
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  const nodesOf = async () => (await store.listAssetPage({
    projectId: "default", limit: 10, collapseStacks: true, sort: "newest",
  })).assets;
  const labelsOf = (nodes) => nodes.map((node) => node.stack?.id ?? node.id);
  const stackKeyOf = (nodes) => nodes.find((node) => node.stack?.id === "stk")?.node_sort?.createdAt;

  // The page (and the stack-node table behind it) is cached on this connection
  // before the repair runs.
  const before = await nodesOf();
  assert.deepEqual(labelsOf(before), ["solo", "stk"], "pre-repair the stack sorts below the standalone asset");
  assert.equal(stackKeyOf(before), keyBefore, "pre-repair the stack carries its unrepaired sort key");

  await store.startDeferredMaintenance();

  const after = await nodesOf();
  assert.deepEqual(labelsOf(after), ["stk", "solo"], "the same page reflects the repaired stack order");
  assert.equal(stackKeyOf(after), keyAfter, "the repaired sort key drives the page");
  assert.equal(markerValue(libraryDir, "derived:stack_sort_columns"), "1", "the columns pass ran to completion");
  assert.equal(markerValue(libraryDir, "derived:stack_sort_created_at"), "1", "the created_at pass ran to completion");

  const { changes } = await store.listLibraryChangesSince("default", 0);
  const backfilled = changes.filter((change) => change.kind === "library-backfilled");
  const announcement = backfilled.find((change) => change.detail?.reason === reason);
  assert.ok(announcement, `the repaired stack row is announced as library-backfilled (${reason})`);
  assert.equal(announcement.detail.rowsChanged, 1, "exactly the one repaired stack row is counted");
  assert.equal(
    backfilled.some((change) => change.detail?.reason === otherReason),
    false,
    "the other stack pass had nothing to repair and announces nothing",
  );
}

test("the stack columns pass reports its repaired rows: cached page refreshed and backfill announced", async (t) => {
  await expectStackPassReportsRepair(t, {
    prefix: "mosa-347r1-stack-columns-",
    reason: "derived:stack_sort_columns",
    otherReason: "derived:stack_sort_created_at",
    // Empty sort key: the page falls back to the stack's own created_at until
    // the pass copies the cover's date in.
    stack: { createdAt: "2026-04-01T00:00:00.000Z", sortCreatedAt: "" },
    coverCreatedAt: "2026-05-03T00:00:00.000Z",
    secondCreatedAt: "2026-05-01T00:00:00.000Z",
    keyBefore: "2026-04-01T00:00:00.000Z",
    keyAfter: "2026-05-03T00:00:00.000Z",
  });
});

test("the stack sort_created_at pass reports its repaired rows: cached page refreshed and backfill announced", async (t) => {
  await expectStackPassReportsRepair(t, {
    prefix: "mosa-347r1-stack-created-at-",
    reason: "derived:stack_sort_created_at",
    otherReason: "derived:stack_sort_columns",
    // Stale non-empty key: older than the stack's newest member, so only the
    // created_at pass has a row to fix.
    stack: { createdAt: "2026-04-01T00:00:00.000Z", sortCreatedAt: "2026-04-15T00:00:00.000Z" },
    coverCreatedAt: "2026-05-01T00:00:00.000Z",
    secondCreatedAt: "2026-05-04T00:00:00.000Z",
    keyBefore: "2026-04-15T00:00:00.000Z",
    keyAfter: "2026-05-04T00:00:00.000Z",
  });
});

// --- 6: a media replacement must not clobber fields a repair fixed ---------------

test("a media replacement keeps fields fixed between its row read and its write", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-347r1-replace-merge-");
  bootstrapLibrary(projectRoot, libraryDir);
  const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const replacementPath = join(projectRoot, "replacement.png");
  await writeFile(replacementPath, Buffer.from("replacement-png-bytes"));
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  await store.createAsset({
    assetId: "replace-me",
    imagePath: sourcePath,
    created_at: CREATED,
    business_fields: { source_note: "original" },
    source: { type: "web-chatgpt", conversation_id: "conv-r" },
  });

  process.env.MOSA_TEST_REPLACE_MEDIA_STALL_MS = "400";
  try {
    const replacement = store.replaceAssetMedia("default", "replace-me", {
      imagePath: replacementPath,
      business_fields: { quality: "sharper" },
    });
    // While the replace is parked in its stall (row read done, write
    // transaction not started), a background repair fixes two fields.
    await new Promise((resolveWait) => setTimeout(resolveWait, 120));
    withRawDatabase(libraryDir, (database) => {
      database.transaction(() => {
        const row = database.prepare("SELECT business_fields_json, source_json FROM assets WHERE id = 'replace-me'").get();
        const fields = JSON.parse(row.business_fields_json);
        fields.file_bytes = 123456;
        const source = JSON.parse(row.source_json);
        source.user_message = "restored by the repair";
        database.prepare("UPDATE assets SET business_fields_json = ?, source_json = ? WHERE id = 'replace-me'")
          .run(JSON.stringify(fields), JSON.stringify(source));
      })();
    });
    await replacement;
  } finally {
    delete process.env.MOSA_TEST_REPLACE_MEDIA_STALL_MS;
  }

  const row = withRawDatabase(libraryDir, (database) =>
    database.prepare("SELECT * FROM assets WHERE id = 'replace-me'").get());
  const fields = JSON.parse(row.business_fields_json);
  const source = JSON.parse(row.source_json);
  assert.equal(fields.file_bytes, 123456, "the repair's business_fields fix survives the replacement");
  assert.equal(source.user_message, "restored by the repair", "the repair's source fix survives the replacement");
  assert.equal(fields.quality, "sharper", "the replacement's own business_fields patch still applies");
  assert.notEqual(row.asset, "replace-me.png", "the replacement media did land");
  assert.equal(source.storage_mode, "copy");
});
