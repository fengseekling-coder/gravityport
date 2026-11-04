// Task 347 (audit 261 batch 5, 中-新8 + 中24 + 规矩 27): the open-speed work.
// - the stack sort expression plans through the assets primary key and still
//   derives the newest-live-member date;
// - the two session stacking queries pin the session-key index;
// - the pre-upgrade gate uses quick_check, the post-upgrade verification runs
//   in a worker thread after listen and records its verdict in library_meta;
// - the six one-time repairs and the derived-column re-derivations run from
//   startDeferredMaintenance in idempotent batches that survive SIGKILL;
// - the derived-column probes are marker-gated and stop re-scanning;
// - the startup splash reveals its organizing note by timer or early hook.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { performance } from "node:perf_hooks";
import vm from "node:vm";
import Database from "better-sqlite3";

import {
  STACK_SORT_CREATED_AT_SQL,
  createSqliteAssetStore,
  searchScopeRebuildHelpers,
} from "../lib/sqlite-asset-store.mjs";
import { rebuildSearchScopeTexts } from "../lib/asset-search-scope.mjs";
import { SCHEMA_UPGRADE_VERIFY_KEY, runSchemaUpgradeVerify } from "../lib/schema-upgrade-verify.mjs";
import { ensureSchemaUpgradeBackup } from "../lib/schema-upgrade-backup.mjs";
import { assetSortName } from "../lib/asset-sort.js";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CREATED = "2026-05-01T00:00:00.000Z";

async function createLibraryRoot(t, prefix = "mosa-open-speed-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  return { projectRoot, libraryDir };
}

function bootstrapLibrary(projectRoot, libraryDir) {
  const bootstrap = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  bootstrap.close();
}

// Opens a store with console.warn captured for the whole lifetime of the
// returned capture (the deferred maintenance warns fire after the open, so
// the capture must outlive it). Callers must run stop() before the test ends.
function openStoreWithWarnCapture(t, projectRoot, libraryDir) {
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...parts) => { warns.push(parts.map(String).join(" ")); };
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    console.warn = originalWarn;
  });
  return { store, warns };
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

function clearMarker(libraryDir, key) {
  withRawDatabase(libraryDir, (database) => {
    database.prepare("DELETE FROM library_meta WHERE key = ?").run(key);
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
  pixel = "",
  sourcePath = "",
  asset: assetName = `${id}.png`,
}) {
  database.prepare(`
    INSERT INTO assets (
      project_id, id, asset, original_path, content_sha256, pixel_sha256, prompt, skill, style, ratio, business_fields_json, theme,
      favorite, archived, group_name, category, rating, version_change, source_type, source_json, source_path, metadata_json, search_text,
      tags_text, business_search_text, source_search_text, media_kind, source_group, conversation_id, generation_session_key, generation_batch,
      created_at, created_at_epoch, updated_at, sort_name
    ) VALUES (
      @projectId, @id, @asset, '/src', @hash, @pixel, @prompt, '', '', '', '{}', '',
      0, 0, '', '', 0, '', @sourceType, @sourceJson, @sourcePath, '{}', @searchText,
      '', '', '', 'image', @sourceType, @conversationId, @sessionKey, '',
      @createdAt, @epoch, @createdAt, NULL
    )
  `).run({
    projectId, id, asset: assetName, hash: `hash-${id}`, pixel, prompt, sourceType, sourceJson,
    sourcePath, searchText, conversationId, sessionKey, createdAt, epoch,
  });
  if (deletedAt) {
    database.prepare("UPDATE assets SET deleted_at = ? WHERE project_id = ? AND id = ?").run(deletedAt, projectId, id);
  }
}

function insertStackRow(database, { id, createdAt = CREATED, sortCreatedAt = "", sortName = "", name = "" }) {
  database.prepare(`
    INSERT INTO asset_stacks (project_id, id, created_at, updated_at, sort_created_at, sort_name, name)
    VALUES ('default', @id, @createdAt, @createdAt, @sortCreatedAt, @sortName, @name)
  `).run({ id, createdAt, sortCreatedAt, sortName, name });
}

function insertStackMember(database, { stackId, assetId, position, addedAt = CREATED }) {
  database.prepare(`
    INSERT INTO asset_stack_members (project_id, stack_id, asset_id, position, added_at)
    VALUES ('default', @stackId, @assetId, @position, @addedAt)
  `).run({ stackId, assetId, position, addedAt });
}

// --- 中-新8: the stack sort expression -------------------------------------------------

test("the stack sort expression plans through the assets primary key and derives the newest live member date", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-open-speed-stack-sort-");
  bootstrapLibrary(projectRoot, libraryDir);
  // 2000 assets in 200 stacks of 10. Stacks 0-49 keep live members and lose
  // 1-3 to the trash; stacks 50-59 lose all members; the rest stay untouched.
  // Every member carries its own created_at so the expected value per stack is
  // unambiguous.
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      for (let index = 0; index < 2000; index += 1) {
        const createdAt = new Date(Date.parse(CREATED) + index * 1000).toISOString();
        insertAssetRow(database, { id: `asset-${index}`, createdAt, epoch: Date.parse(createdAt) });
      }
      for (let stack = 0; stack < 200; stack += 1) {
        insertStackRow(database, { id: `stack-${stack}` });
        const trashedCount = stack < 50 ? 1 + (stack % 3) : (stack >= 50 && stack < 60 ? 10 : 0);
        for (let position = 0; position < 10; position += 1) {
          const assetIndex = stack * 10 + position;
          insertStackMember(database, { stackId: `stack-${stack}`, assetId: `asset-${assetIndex}`, position });
          if (position < trashedCount) {
            database.prepare("UPDATE assets SET deleted_at = ? WHERE project_id = 'default' AND id = ?")
              .run("2026-06-01T00:00:00.000Z", `asset-${assetIndex}`);
          }
        }
      }
    })();
  });

  const { store } = openStoreWithWarnCapture(t, projectRoot, libraryDir);
  // The rederivation is marker-gated background work now; clear the marker so
  // this first deferred run has the whole sweep to do.
  clearMarker(libraryDir, "derived:stack_sort_created_at");
  await store.startDeferredMaintenance();

  const expected = new Map();
  const stored = withRawDatabase(libraryDir, (database) => {
    const memberRows = database.prepare(`
      SELECT s.id, a.created_at, a.deleted_at
      FROM asset_stacks s
      JOIN asset_stack_members sm ON sm.project_id = s.project_id AND sm.stack_id = s.id
      JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
    `).all();
    for (const row of memberRows) {
      const entry = expected.get(row.id) || { live: [], all: [] };
      if (!row.deleted_at) entry.live.push(row.created_at);
      entry.all.push(row.created_at);
      expected.set(row.id, entry);
    }
    return new Map(database.prepare("SELECT id, sort_created_at FROM asset_stacks").all().map((row) => [row.id, row.sort_created_at]));
  });
  assert.equal(expected.size, 200, "every stack has members");
  for (const [stackId, entry] of expected) {
    const newest = (values) => values.reduce((a, b) => (a > b ? a : b));
    const want = entry.live.length ? newest(entry.live) : newest(entry.all);
    assert.equal(stored.get(stackId), want, `stack ${stackId} sorts by its newest live member (or newest member when all are trashed)`);
  }

  // The plan of the exact expression the store runs: the per-stack subqueries
  // must reach assets through its primary key, never through the trash-time
  // index that made the sweep quadratic (audit 261 mid-8).
  const plan = withRawDatabase(libraryDir, (database) =>
    database.prepare(`EXPLAIN QUERY PLAN SELECT ${STACK_SORT_CREATED_AT_SQL} FROM asset_stacks LIMIT 3`)
      .all().map((row) => row.detail).join("\n"));
  assert.match(plan, /sqlite_autoindex_assets_1 \(project_id=\? AND id=\?\)/, `subqueries join assets by primary key: ${plan}`);
  assert.doesNotMatch(plan, /assets_project_deleted_idx/, `the planner must not pick the deleted_at index: ${plan}`);
});

// --- 中24: the session stacking queries pin their index --------------------------------

test("the session stacking queries pin the session-key index and behave unchanged across three session shapes", async (t) => {
  // The INDEXED BY pin is what keeps the planner off project-wide scans; the
  // queries themselves live inside the store, so the pin is asserted at the
  // source (the same technique as the BEGIN IMMEDIATE source assertions), and
  // a missing or renamed index would make every stacking write fail loudly.
  const source = readFileSync(join(REPO_ROOT, "lib", "sqlite-asset-store.mjs"), "utf8");
  const pins = [...source.matchAll(/INDEXED BY assets_project_session_key_idx/g)].length;
  assert.equal(pins, 2, "exactly the two session stacking queries pin the index");

  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-open-speed-session-index-");
  const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const { store } = openStoreWithWarnCapture(t, projectRoot, libraryDir);
  const indexName = withRawDatabase(libraryDir, (database) =>
    database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'assets_project_session_key_idx'").get()?.name);
  assert.equal(indexName, "assets_project_session_key_idx", "the pinned index exists on a fresh library");

  const ingest = (assetId, conversationId, createdAt) => store.createAsset({
    assetId,
    imagePath: sourcePath,
    created_at: createdAt,
    source: { type: "web-chatgpt", conversation_id: conversationId },
  });

  // Session 1: an existing auto stack absorbs the third image.
  await ingest("live-1", "conv-live", "2026-05-01T00:00:00.000Z");
  await ingest("live-2", "conv-live", "2026-05-02T00:00:00.000Z");
  await ingest("live-3", "conv-live", "2026-05-03T00:00:00.000Z");
  // Session 2: three images stack, then one is pulled out (exclusion row);
  // two remain, so the stack survives and later images still join it.
  await ingest("excl-1", "conv-excluded", "2026-05-01T00:00:00.000Z");
  await ingest("excl-2", "conv-excluded", "2026-05-02T00:00:00.000Z");
  await ingest("excl-3", "conv-excluded", "2026-05-03T00:00:00.000Z");
  // Session 3: two images stack, one goes to the trash.
  await ingest("trash-1", "conv-trash", "2026-05-01T00:00:00.000Z");
  await ingest("trash-2", "conv-trash", "2026-05-02T00:00:00.000Z");

  const stackIdFor = (sessionKey) => withRawDatabase(libraryDir, (database) =>
    database.prepare("SELECT id FROM asset_stacks WHERE session_key = ?").get(sessionKey)?.id);
  assert.ok(stackIdFor("web-chatgpt:conv-live"), "the auto stack exists");

  await store.removeAssetsFromStack("default", stackIdFor("web-chatgpt:conv-excluded"), ["excl-1"]);
  await store.deleteAsset("default", "trash-2");

  // Session 1 grows: targetStackForSession must answer with the existing stack.
  await ingest("live-4", "conv-live", "2026-05-04T00:00:00.000Z");
  // Session 2 keeps stacking around the remaining members; the excluded image
  // never comes back.
  await ingest("excl-4", "conv-excluded", "2026-05-04T00:00:00.000Z");
  // Session 3: the trashed image does not count, but the live one still
  // anchors the stack for the next arrival.
  await ingest("trash-3", "conv-trash", "2026-05-03T00:00:00.000Z");

  // Live members only: trashing an image keeps its membership row, but the
  // stacking queries (and the gallery) count the live ones.
  const members = (sessionKey) => withRawDatabase(libraryDir, (database) =>
    database.prepare(`
      SELECT sm.asset_id FROM asset_stack_members sm
      JOIN asset_stacks s ON s.project_id = sm.project_id AND s.id = sm.stack_id
      JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
      WHERE s.session_key = ? AND a.deleted_at IS NULL ORDER BY sm.asset_id
    `).all(sessionKey).map((row) => row.asset_id));
  assert.deepEqual(members("web-chatgpt:conv-live"), ["live-1", "live-2", "live-3", "live-4"], "the existing stack absorbed the new image");
  assert.deepEqual(members("web-chatgpt:conv-excluded"), ["excl-2", "excl-3", "excl-4"], "the excluded image stays out of the stack");
  assert.deepEqual(members("web-chatgpt:conv-trash"), ["trash-1", "trash-3"], "the trashed image left the stack and the next image still joins it");
  const exclusions = withRawDatabase(libraryDir, (database) =>
    database.prepare("SELECT asset_id FROM auto_stack_exclusions ORDER BY asset_id").all().map((row) => row.asset_id));
  assert.deepEqual(exclusions, ["excl-1"], "exactly the pulled-out image is excluded");
});

// --- quick_check before the upgrade ----------------------------------------------------

test("the pre-upgrade gate runs quick_check and refuses a damaged source", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mosa-open-speed-quickcheck-"));
  t.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

  function fakeDatabase(quickCheckResult) {
    const pragmas = [];
    return {
      pragmas,
      prepare(sql) {
        if (sql.includes("sqlite_master")) return { get: () => ({ present: 1 }) };
        return { get: () => ({ value: "16" }) };
      },
      pragma(name) {
        pragmas.push(name);
        return quickCheckResult;
      },
      exec(sql) {
        // VACUUM INTO '<path>': create the file so the rename step works like
        // the real database would.
        const match = String(sql).match(/VACUUM INTO '(.+)'/);
        if (match) writeFileSync(match[1], "");
      },
    };
  }

  const ok = fakeDatabase("ok");
  const result = ensureSchemaUpgradeBackup(ok, { libraryDir: join(root, "library"), targetVersion: 17, databaseExisted: true });
  assert.equal(result.created, true, "the backup is taken after a passing check");
  assert.ok(ok.pragmas.includes("quick_check"), "the gate runs quick_check");
  assert.equal(ok.pragmas.includes("integrity_check"), false, "the gate never runs the full integrity_check");
  assert.ok(existsSync(result.path), "the snapshot exists");

  const damaged = fakeDatabase("failed at page 1");
  assert.throws(
    () => ensureSchemaUpgradeBackup(damaged, { libraryDir: join(root, "other"), targetVersion: 17, databaseExisted: true }),
    /failed SQLite quick_check/,
    "a failing quick_check still refuses the upgrade",
  );
  assert.equal(existsSync(join(root, "other", ".schema-backups")), false, "no backup is taken from a damaged source");
});

// --- post-upgrade verification in a worker thread ---------------------------------------

function seedSchemaVersion(libraryDir, version) {
  withRawDatabase(libraryDir, (database) => {
    database.prepare("UPDATE library_meta SET value = ? WHERE key = 'schema_version'").run(String(version));
  });
}

test("a schema upgrade verifies in the background: an inherited orphan passes, a grown one records failed", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-open-speed-verify-bad-");
  bootstrapLibrary(projectRoot, libraryDir);
  seedSchemaVersion(libraryDir, 16);
  withRawDatabase(libraryDir, (database) => {
    // Audit 261 中-新9 style foreign-key orphan: a recipe snapshot pointing at
    // an asset that does not exist. Orphans can only get in with enforcement
    // off — the exact damage the check exists to catch.
    database.pragma("foreign_keys = OFF");
    database.prepare(`
      INSERT INTO recipe_snapshots (
        project_id, asset_id, snapshot_id, schema_version, recipe_digest, prompt_digest, effective_prompt, user_prompt,
        negative_prompt, prompt_status, generation_tool, model, provider, skill, style, ratio, theme,
        references_json, provenance_json, change_summary, created_at
      ) VALUES (
        'default', 'missing-asset', 'orphan-s1', '1', '', '', '', '',
        '', '', '', '', 'chatgpt', '', '', '', '',
        '[]', '{}', '', '2026-05-01T00:00:00.000Z'
      )
    `).run();
  });

  const { store, warns } = openStoreWithWarnCapture(t, projectRoot, libraryDir);
  // Before the fix the open itself ran the check and threw; now it returns.
  await store.startDeferredMaintenance();

  // Task 350: violations the pre-upgrade snapshot already carried are the
  // library's own baseline — the check passes, with both counts recorded.
  const record = JSON.parse(markerValue(libraryDir, SCHEMA_UPGRADE_VERIFY_KEY));
  assert.equal(record.status, "ok", "the snapshot baseline covers the pre-existing orphan");
  assert.equal(record.foreignKeyViolations, 1, "the orphan is counted on the current side");
  assert.equal(record.foreignKeyBaselineViolations, 1, "the same orphan is counted on the baseline side");
  assert.equal(record.targetVersion, 17, "the record names the target version");
  assert.ok(record.backupPath, "the record keeps the backup path");
  assert.ok(!existsSync(record.backupPath), "the ok verdict deleted the snapshot (task 350)");
  store.close();

  // A violation group that GREW against a baseline still records the terminal
  // failed and warns exactly once.
  const baselineCopy = join(libraryDir, ".schema-backups", "mosa-before-v17-from-v16.db");
  mkdirSync(join(libraryDir, ".schema-backups"), { recursive: true });
  withRawDatabase(libraryDir, (database) => {
    database.exec(`VACUUM INTO '${baselineCopy}'`);
  });
  withRawDatabase(libraryDir, (database) => {
    database.pragma("foreign_keys = OFF");
    database.prepare(`
      INSERT INTO recipe_snapshots (
        project_id, asset_id, snapshot_id, schema_version, recipe_digest, prompt_digest, effective_prompt, user_prompt,
        negative_prompt, prompt_status, generation_tool, model, provider, skill, style, ratio, theme,
        references_json, provenance_json, change_summary, created_at
      ) VALUES (
        'default', 'missing-asset', 'orphan-s2', '1', '', '', '', '',
        '', '', '', '', 'chatgpt', '', '', '', '',
        '[]', '{}', '', '2026-05-01T00:00:00.000Z'
      )
    `).run();
  });
  const raw = new Database(join(libraryDir, "mosa.db"));
  try {
    const rerun = await runSchemaUpgradeVerify(raw, {
      databasePath: join(libraryDir, "mosa.db"),
      targetVersion: 17,
      backupPath: baselineCopy,
      force: true,
    });
    assert.equal(rerun.status, "failed", "the grown violation group is recorded as failed");
    assert.equal(rerun.foreignKeyViolations, 2);
    assert.equal(rerun.foreignKeyBaselineViolations, 1);
  } finally {
    raw.close();
  }
  assert.ok(
    warns.some((line) => line.includes("[MOSA] schema upgrade verify failed")),
    `one [MOSA] warning for the failure, got: ${JSON.stringify(warns)}`,
  );
});

test("a clean upgrade records ok, and a pending record reruns on the next open", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-open-speed-verify-ok-");
  bootstrapLibrary(projectRoot, libraryDir);
  seedSchemaVersion(libraryDir, 16);
  const { store } = openStoreWithWarnCapture(t, projectRoot, libraryDir);
  await store.startDeferredMaintenance();
  const record = JSON.parse(markerValue(libraryDir, SCHEMA_UPGRADE_VERIFY_KEY));
  assert.equal(record.status, "ok");
  assert.equal(record.foreignKeyViolations, 0);
  assert.ok(record.backupPath, "the record names the snapshot");
  assert.ok(!existsSync(record.backupPath), "task 350: the ok verdict deleted the snapshot");
  store.close();

  // Simulate a process killed mid-check: the pending record must rerun.
  setMarker(libraryDir, SCHEMA_UPGRADE_VERIFY_KEY, JSON.stringify({ status: "pending", targetVersion: 17, checkedAt: "2026-01-01T00:00:00.000Z" }));
  const { store: reopened } = openStoreWithWarnCapture(t, projectRoot, libraryDir);
  await reopened.startDeferredMaintenance();
  const rerun = JSON.parse(markerValue(libraryDir, SCHEMA_UPGRADE_VERIFY_KEY));
  assert.equal(rerun.status, "ok", "the interrupted check reran to completion");
});

test("the background verification never stalls the main thread", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, "mosa-open-speed-verify-timer-");
  bootstrapLibrary(projectRoot, libraryDir);
  seedSchemaVersion(libraryDir, 16);
  // Calibrate: add rows until a direct integrity_check takes at least 400ms,
  // so a synchronous main-thread check could not possibly stay under budget.
  const filler = "整理 " + "x".repeat(1024) + " 整理";
  let calibrationMs = 0;
  const probe = (database) => {
    const started = performance.now();
    database.pragma("integrity_check", { simple: true });
    calibrationMs = performance.now() - started;
    return calibrationMs >= 400;
  };
  withRawDatabase(libraryDir, (database) => {
    const insert = database.prepare(`
      INSERT INTO assets (
        project_id, id, asset, original_path, content_sha256, prompt, skill, style, ratio, business_fields_json, theme,
        favorite, archived, group_name, category, rating, version_change, source_type, source_json, metadata_json, search_text,
        tags_text, business_search_text, source_search_text, media_kind, source_group, conversation_id, generation_batch,
        created_at, created_at_epoch, updated_at, sort_name
      ) VALUES (
        'default', @id, @asset, '/bench', 'bench', @filler, '', '', '', '{}', '',
        0, 0, '', '', 0, '', 'web-chatgpt', '{"type":"web-chatgpt"}', '{}', @filler,
        '', '', 'web-chatgpt', 'image', 'web-chatgpt', 'conv', 'batch',
        @created, @epoch, @created, NULL
      )
    `);
    database.transaction(() => {
      for (let batch = 0; batch < 14 && !probe(database); batch += 1) {
        for (let index = 0; index < 4000; index += 1) {
          const n = batch * 4000 + index;
          insert.run({ id: `bench-${n}`, asset: `bench-${n}.png`, filler, created: CREATED, epoch: Date.parse(CREATED) });
        }
      }
    })();
  });

  // Pre-set every marker so the deferred chain under measurement is the
  // verify alone: the repair passes have their own (task-sanctioned, 348)
  // main-thread cost that this test must not fold into the check's budget.
  for (const key of [
    "derived:created_at_epoch", "derived:sort_name", "derived:stack_sort_columns", "derived:stack_sort_created_at",
    "search_scope_v3", "repair_capture_user_message_v1", "generation_message_backfill_v1",
    "repair_cleared_capture_prompt_v1", "video_metadata_backfill_v1", "file_bytes_backfill_v1",
    "fts_trash_row_cleanup_v1",
  ]) {
    setMarker(libraryDir, key, "1");
  }
  const { store } = openStoreWithWarnCapture(t, projectRoot, libraryDir);
  const settled = store.startDeferredMaintenance();
  const tickDurations = [];
  let last = performance.now();
  await new Promise((resolveTimer) => {
    let ticks = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      tickDurations.push(now - last);
      last = now;
      if (++ticks >= 24) {
        clearInterval(timer);
        resolveTimer();
      }
    }, 50);
  });
  await settled;
  const record = JSON.parse(markerValue(libraryDir, SCHEMA_UPGRADE_VERIFY_KEY));
  assert.equal(record.status, "ok", "the check completed");
  const slowest = Math.max(...tickDurations);
  if (calibrationMs >= 400) {
    assert.ok(slowest < 200, `every 50ms timer fired within 200ms while the worker checked (slowest ${slowest.toFixed(1)}ms, direct check ${calibrationMs.toFixed(0)}ms)`);
  } else {
    t.diagnostic(`calibration did not reach 400ms (direct check ${calibrationMs.toFixed(0)}ms); the timer assertion is only advisory this run`);
    assert.ok(slowest < 200, `timers stay responsive (slowest ${slowest.toFixed(1)}ms)`);
  }
});

// --- one-time repairs: batched, resumable, identical to the whole-table pass -----------------

const SEARCH_SCOPE_ROWS = 1000;

async function buildSearchScopeLibrary(t, prefix) {
  const { projectRoot, libraryDir } = await createLibraryRoot(t, prefix);
  bootstrapLibrary(projectRoot, libraryDir);
  // Legacy-style rows: paths and hashes in search_text (what the whitelist
  // strips), correct derived scalars, no stacks.
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      for (let index = 0; index < SEARCH_SCOPE_ROWS; index += 1) {
        const legacy = `lantern study ${index} /tmp/zqx9-${index}/lamp-${index}.png deadbeef${index}`;
        insertAssetRow(database, {
          id: `legacy-${index}`,
          prompt: `lantern study ${index}`,
          searchText: legacy,
          sourceJson: JSON.stringify({ type: "local-file", path: `/tmp/zqx9-${index}/lamp-${index}.png` }),
          sourcePath: `/tmp/zqx9-${index}/lamp-${index}.png`,
        });
      }
    })();
  });
  return { projectRoot, libraryDir };
}

function searchScopeSnapshot(libraryDir) {
  return withRawDatabase(libraryDir, (database) => ({
    rows: database.prepare("SELECT project_id, id, search_text, source_search_text, business_search_text FROM assets ORDER BY project_id, id").all(),
    fts: database.prepare("SELECT project_id, asset_id, content FROM asset_fts ORDER BY project_id, asset_id").all(),
    terms: database.prepare("SELECT project_id, asset_id, term FROM asset_short_terms ORDER BY project_id, asset_id, term").all(),
  }));
}

test("the batched search-scope rebuild produces exactly the whole-table rebuild's rows", async (t) => {
  const { projectRoot: aProject, libraryDir: aLibrary } = await buildSearchScopeLibrary(t, "mosa-open-speed-scope-a-");
  const { projectRoot: bProject, libraryDir: bLibrary } = await buildSearchScopeLibrary(t, "mosa-open-speed-scope-b-");

  // A: the deferred batched driver.
  const aStore = createSqliteAssetStore({ projectRoot: aProject, managerDir: join(aProject, "mosa"), libraryDir: aLibrary });
  t.after(() => { try { aStore.close(); } catch { /* already closed */ } });
  assert.equal(markerValue(aLibrary, "search_scope_v3"), null, "the open no longer rebuilds");
  await aStore.startDeferredMaintenance();
  assert.ok(markerValue(aLibrary, "search_scope_v3"), "the deferred run writes the marker");

  // B: the whole-table original with the store's own helpers.
  const bStore = createSqliteAssetStore({ projectRoot: bProject, managerDir: join(bProject, "mosa"), libraryDir: bLibrary });
  t.after(() => { try { bStore.close(); } catch { /* already closed */ } });
  withRawDatabase(bLibrary, (database) => {
    const stats = rebuildSearchScopeTexts(database, searchScopeRebuildHelpers(database));
    assert.equal(stats.assetsRebuilt, SEARCH_SCOPE_ROWS, "every legacy row is rewritten once");
  });

  assert.deepEqual(searchScopeSnapshot(aLibrary), searchScopeSnapshot(bLibrary),
    "A (batched) and B (whole-table) end with identical rows, FTS entries and short terms");
});

test("a SIGKILL mid-rebuild resumes on the next open and converges on the same rows", async (t) => {
  const { projectRoot, libraryDir } = await buildSearchScopeLibrary(t, "mosa-open-speed-scope-kill-");
  const reference = await buildSearchScopeLibrary(t, "mosa-open-speed-scope-ref-");
  const referenceStore = createSqliteAssetStore({
    projectRoot: reference.projectRoot, managerDir: join(reference.projectRoot, "mosa"), libraryDir: reference.libraryDir,
  });
  t.after(() => { try { referenceStore.close(); } catch { /* already closed */ } });
  await referenceStore.startDeferredMaintenance();
  const referenceSnapshot = searchScopeSnapshot(reference.libraryDir);

  const childScript = join(dirname(libraryDir), "deferred-child.mjs");
  writeFileSync(childScript, `
    import { join } from "node:path";
    import { pathToFileURL } from "node:url";
    const { createSqliteAssetStore } = await import(pathToFileURL(${JSON.stringify(join(REPO_ROOT, "lib", "sqlite-asset-store.mjs"))}).href);
    const projectRoot = process.argv[2];
    const libraryDir = process.argv[3];
    const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
    await store.startDeferredMaintenance();
    console.log("child-done");
    process.exit(0);
  `);
  const child = spawn(process.execPath, [childScript, projectRoot, libraryDir], {
    env: {
      ...process.env,
      MOSA_TEST_DEFERRED_MAINTENANCE_BATCH_SIZE: "200",
      MOSA_TEST_DEFERRED_MAINTENANCE_KILL_AFTER_BATCH: "search_scope:3",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childStderr = "";
  child.stderr.on("data", (chunk) => { childStderr += String(chunk); });
  const exit = await new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })));
  assert.equal(exit.signal, "SIGKILL", `the test hook killed the child after three batches (code ${exit?.code}) ${childStderr}`);
  assert.equal(markerValue(libraryDir, "search_scope_v3"), null, "the killed run wrote no marker");

  const { store } = openStoreWithWarnCapture(t, projectRoot, libraryDir);
  await store.startDeferredMaintenance();
  assert.ok(markerValue(libraryDir, "search_scope_v3"), "the resumed run completes the marker");
  assert.deepEqual(searchScopeSnapshot(libraryDir), referenceSnapshot, "the resumed result equals an uninterrupted run");
  assert.equal(withRawDatabase(libraryDir, (database) => database.pragma("integrity_check", { simple: true })), "ok", "the killed library stays integral");
});

// --- marker-gated ensure* probes ---------------------------------------------------------

const DERIVED_CASES = [
  {
    name: "created_at_epoch",
    marker: "derived:created_at_epoch",
    seed: (database) => {
      insertAssetRow(database, { id: "d1", createdAt: "Sat, 01 Jan 2000 00:00:00 GMT", epoch: null });
    },
    corrupt: (database) => {
      database.prepare("UPDATE assets SET created_at = 'Sun, 02 Jan 2000 00:00:00 GMT', created_at_epoch = 424242 WHERE id = 'd1'").run();
    },
    fixed: (database) => {
      const row = database.prepare("SELECT created_at, created_at_epoch FROM assets WHERE id = 'd1'").get();
      return row.created_at === "2000-01-02T00:00:00.000Z" && row.created_at_epoch === Date.parse("2000-01-02T00:00:00.000Z");
    },
  },
  {
    name: "sort_name",
    marker: "derived:sort_name",
    seed: (database) => {
      insertAssetRow(database, { id: "d2", asset: "d2.png" });
    },
    corrupt: (database) => {
      database.prepare("UPDATE assets SET sort_name = 'zzz-wrong' WHERE id = 'd2'").run();
    },
    fixed: (database) => {
      const row = database.prepare("SELECT theme, asset, id, sort_name FROM assets WHERE id = 'd2'").get();
      return row.sort_name === assetSortName({ theme: row.theme, asset: row.asset, id: row.id });
    },
  },
  {
    name: "stack sort columns",
    marker: "derived:stack_sort_columns",
    seed: (database) => {
      insertAssetRow(database, { id: "d3" });
      insertStackRow(database, { id: "stack-d3", sortCreatedAt: "", sortName: "" });
      insertStackMember(database, { stackId: "stack-d3", assetId: "d3", position: 0 });
    },
    corrupt: (database) => {
      database.prepare("UPDATE asset_stacks SET sort_created_at = '', sort_name = '' WHERE id = 'stack-d3'").run();
    },
    fixed: (database) =>
      database.prepare("SELECT sort_created_at FROM asset_stacks WHERE id = 'stack-d3'").get().sort_created_at === CREATED,
  },
  {
    name: "stack sort_created_at",
    marker: "derived:stack_sort_created_at",
    seed: (database) => {
      insertAssetRow(database, { id: "d4a", createdAt: "2026-05-01T00:00:00.000Z", epoch: Date.parse("2026-05-01T00:00:00.000Z") });
      insertAssetRow(database, { id: "d4b", createdAt: "2026-05-02T00:00:00.000Z", epoch: Date.parse("2026-05-02T00:00:00.000Z") });
      insertStackRow(database, { id: "stack-d4" });
      insertStackMember(database, { stackId: "stack-d4", assetId: "d4a", position: 0 });
      insertStackMember(database, { stackId: "stack-d4", assetId: "d4b", position: 1 });
    },
    corrupt: (database) => {
      database.prepare("UPDATE asset_stacks SET sort_created_at = '2001-01-01T00:00:00.000Z' WHERE id = 'stack-d4'").run();
    },
    fixed: (database) =>
      database.prepare("SELECT sort_created_at FROM asset_stacks WHERE id = 'stack-d4'").get().sort_created_at === "2026-05-02T00:00:00.000Z",
  },
];

for (const testCase of DERIVED_CASES) {
  test(`the ${testCase.name} repair is marker-gated: skipped with the marker, repaired after clearing or downgrading it`, async (t) => {
    const { projectRoot, libraryDir } = await createLibraryRoot(t, `mosa-open-speed-marker-${testCase.name.replace(/\W+/g, "-")}-`);
    bootstrapLibrary(projectRoot, libraryDir);
    withRawDatabase(libraryDir, (database) => { database.transaction(() => testCase.seed(database))(); });
    // First open + deferred run: repairs whatever the seed left and writes the
    // marker, so the following open runs against a steady-state library.
    const first = openStoreWithWarnCapture(t, projectRoot, libraryDir);
    clearMarker(libraryDir, testCase.marker);
    await first.store.startDeferredMaintenance();
    assert.equal(markerValue(libraryDir, testCase.marker), "1", "the deferred run writes the version marker");

    withRawDatabase(libraryDir, (database) => testCase.corrupt(database));
    {
      const reopened = openStoreWithWarnCapture(t, projectRoot, libraryDir);
      await reopened.store.startDeferredMaintenance();
      assert.ok(!withRawDatabase(libraryDir, (database) => testCase.fixed(database)),
        "the open + deferred run no longer probes once the marker is current");
    }

    clearMarker(libraryDir, testCase.marker);
    {
      const reopened = openStoreWithWarnCapture(t, projectRoot, libraryDir);
      await reopened.store.startDeferredMaintenance();
      assert.ok(withRawDatabase(libraryDir, (database) => testCase.fixed(database)), "clearing the marker re-derives in the background");
    }

    setMarker(libraryDir, testCase.marker, "0");
    withRawDatabase(libraryDir, (database) => testCase.corrupt(database));
    {
      const reopened = openStoreWithWarnCapture(t, projectRoot, libraryDir);
      await reopened.store.startDeferredMaintenance();
      assert.ok(withRawDatabase(libraryDir, (database) => testCase.fixed(database)), "an older marker version re-derives too");
    }
  });
}

const SYNC_CASES = [
  {
    name: "pixel_sha256",
    marker: "derived:pixel_sha256",
    seed: (database) => {
      insertAssetRow(database, {
        id: "s1",
        sourceJson: JSON.stringify({ type: "local-file", pixel_sha256: "cafe1234cafe1234" }),
        pixel: "cafe1234cafe1234",
      });
    },
    corrupt: (database) => {
      database.prepare("UPDATE assets SET pixel_sha256 = '' WHERE id = 's1'").run();
    },
    fixed: (database) =>
      database.prepare("SELECT pixel_sha256 FROM assets WHERE id = 's1'").get().pixel_sha256 === "cafe1234cafe1234",
  },
  {
    name: "source_path",
    marker: "derived:source_path",
    seed: (database) => {
      insertAssetRow(database, { id: "s2", sourceJson: JSON.stringify({ type: "local-file", path: "/src/s2.png" }) });
    },
    corrupt: (database) => {
      database.prepare("UPDATE assets SET source_path = '' WHERE id = 's2'").run();
    },
    fixed: (database) =>
      database.prepare("SELECT source_path FROM assets WHERE id = 's2'").get().source_path === "/src/s2.png",
  },
  {
    name: "generation_session_key",
    marker: "derived:generation_session_key",
    seed: (database) => {
      insertAssetRow(database, {
        id: "s3",
        sourceType: "web-chatgpt",
        sourceJson: JSON.stringify({ type: "web-chatgpt", conversation_id: "conv-9" }),
      });
    },
    corrupt: (database) => {
      database.prepare("UPDATE assets SET generation_session_key = '' WHERE id = 's3'").run();
    },
    fixed: (database) =>
      database.prepare("SELECT generation_session_key FROM assets WHERE id = 's3'").get().generation_session_key === "web-chatgpt:conv-9",
  },
];

for (const testCase of SYNC_CASES) {
  test(`the ${testCase.name} repair stays on the open path but only while its marker is missing`, async (t) => {
    const { projectRoot, libraryDir } = await createLibraryRoot(t, `mosa-open-speed-sync-${testCase.name}-`);
    bootstrapLibrary(projectRoot, libraryDir);
    // The bootstrap open wrote the sync markers on the empty library.
    withRawDatabase(libraryDir, (database) => { database.transaction(() => testCase.seed(database))(); });

    withRawDatabase(libraryDir, (database) => testCase.corrupt(database));
    {
      const reopened = openStoreWithWarnCapture(t, projectRoot, libraryDir);
      assert.ok(!withRawDatabase(libraryDir, (database) => testCase.fixed(database)), "no probe while the marker is current");
    }

    clearMarker(libraryDir, testCase.marker);
    {
      const reopened = openStoreWithWarnCapture(t, projectRoot, libraryDir);
      assert.ok(withRawDatabase(libraryDir, (database) => testCase.fixed(database)), "a missing marker repairs at open, synchronously");
      assert.equal(markerValue(libraryDir, testCase.marker), "1", "the repair rewrites the marker");
    }

    setMarker(libraryDir, testCase.marker, "0");
    withRawDatabase(libraryDir, (database) => testCase.corrupt(database));
    {
      const reopened = openStoreWithWarnCapture(t, projectRoot, libraryDir);
      assert.ok(withRawDatabase(libraryDir, (database) => testCase.fixed(database)), "an older marker version re-derives at open");
    }
  });
}

// --- the startup splash organizing note --------------------------------------------------

test("the startup splash reveals the organizing note after 1.5s or on the early-upgrade hook", () => {
  const html = readFileSync(join(REPO_ROOT, "desktop", "startup.html"), "utf8");
  assert.match(html, /<p id="startup-organizing"[^>]*>正在整理素材库…<\/p>/, "the note text is exactly「正在整理素材库…」");
  const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
  assert.ok(script, "the splash carries its timer script inline");

  function boot() {
    const note = { hidden: true };
    let timerCallback = null;
    let timerDelay = null;
    let cleared = 0;
    const sandbox = {
      document: { getElementById: (id) => (id === "startup-organizing" ? note : null) },
      setTimeout: (callback, delay) => { timerCallback = callback; timerDelay = delay; return 7; },
      clearTimeout: () => { cleared += 1; timerCallback = null; },
    };
    sandbox.window = sandbox;
    vm.runInNewContext(script, sandbox);
    return {
      note,
      delay: timerDelay,
      fireTimer() { if (timerCallback) timerCallback(); },
      hook: sandbox.window.__gravityportShowOrganizingNote,
      get clearedCount() { return cleared; },
    };
  }

  const slow = boot();
  assert.equal(slow.delay, 1500, "the timer waits about 1.5 seconds");
  assert.equal(slow.note.hidden, true, "the note is hidden during a fast open");
  slow.fireTimer();
  assert.equal(slow.note.hidden, false, "the note shows once the open drags past the timer");

  const early = boot();
  assert.equal(typeof early.hook, "function", "the early-upgrade hook exists");
  early.hook();
  assert.equal(early.note.hidden, false, "the upgrade launch shows the note immediately");
  assert.equal(early.clearedCount, 1, "the timer is cancelled so the note never double-fires");
  early.fireTimer();
  assert.equal(early.note.hidden, false, "firing the timer afterwards stays a no-op");
});
