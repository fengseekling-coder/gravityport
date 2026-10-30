import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==",
  "base64",
);

async function createFixtureStore(t, prefix = "mosa-stack-cover-order-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  const generatedDir = join(projectRoot, "generated-images");
  await mkdir(generatedDir, { recursive: true });
  const sourcePath = join(generatedDir, "fixture.png");
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      store.close();
    }
  };
  t.after(close);
  return { store, close, sourcePath, root, projectRoot, libraryDir };
}

function sessionSource(sessionId, extra = {}) {
  return { type: "web-chatgpt", conversation_id: sessionId, ...extra };
}

async function createSessionAsset(store, sourcePath, assetId, createdAt, sessionId, extra = {}) {
  const { prompt = `prompt ${assetId}`, favorite = false, group = "", sourceExtra = {} } = extra;
  return store.createAsset({
    assetId,
    imagePath: sourcePath,
    prompt,
    favorite,
    group,
    created_at: createdAt,
    source: sessionSource(sessionId, sourceExtra),
  });
}

async function createPlainAsset(store, sourcePath, assetId, createdAt, extra = {}) {
  const { prompt = `prompt ${assetId}`, favorite = false, group = "", source = { type: "local-file" } } = extra;
  return store.createAsset({
    assetId,
    imagePath: sourcePath,
    prompt,
    favorite,
    group,
    created_at: createdAt,
    source,
  });
}

async function memberIdsOf(store, stackId) {
  const listed = await store.listAssetStackAssets("default", stackId);
  return listed.assets.map((asset) => asset.id);
}

test("same-session 3 captures auto-stack with newest as cover and newest-to-oldest member order", async (t) => {
  const { store, sourcePath, libraryDir } = await createFixtureStore(t);
  await createSessionAsset(store, sourcePath, "s1", "2026-10-01T10:00:00.000Z", "conv-auto-3", { prompt: "alpha first" });
  await createSessionAsset(store, sourcePath, "s2", "2026-10-01T10:05:00.000Z", "conv-auto-3", { prompt: "beta second" });
  await createSessionAsset(store, sourcePath, "s3", "2026-10-01T10:10:00.000Z", "conv-auto-3", { prompt: "gamma third" });

  const page = await store.listAssetPage({ projectId: "default", collapseStacks: true, limit: 100 });
  assert.equal(page.assets.length, 1);
  assert.equal(page.assets[0].id, "s3", "gallery card shows the newest member");
  const stackId = page.assets[0].stack.id;

  const summary = await store.getAssetStack("default", stackId);
  assert.equal(summary.origin, "auto");
  assert.equal(summary.order_locked, false);
  assert.equal(summary.cover_asset_id, "s3");
  assert.deepEqual(await memberIdsOf(store, stackId), ["s3", "s2", "s1"]);

  // Tie-break when created_at timestamps are equal: asset_id ASC.
  await createSessionAsset(store, sourcePath, "t-b", "2026-10-02T00:00:00.000Z", "conv-tie");
  await createSessionAsset(store, sourcePath, "t-a", "2026-10-02T00:00:00.000Z", "conv-tie");
  const tiePage = await store.listAssetPage({ projectId: "default", collapseStacks: true, limit: 100 });
  const tieStack = tiePage.assets.find((asset) => asset.id === "t-a")?.stack;
  assert.ok(tieStack, "tie-broken cover is asset_id ASC ('t-a')");
  assert.deepEqual(await memberIdsOf(store, tieStack.id), ["t-a", "t-b"]);

  const raw = new Database(join(libraryDir, "mosa.db"), { readonly: true });
  try {
    const stackRow = raw.prepare("SELECT sort_created_at FROM asset_stacks WHERE project_id = 'default' AND id = ?").get(stackId);
    assert.equal(stackRow.sort_created_at, "2026-10-01T10:10:00.000Z");
  } finally {
    raw.close();
  }
});

test("appending a 4th same-session capture promotes it to cover and emits stack-cover-changed with old and new ids", async (t) => {
  const { store, sourcePath, libraryDir } = await createFixtureStore(t);
  await createSessionAsset(store, sourcePath, "a1", "2026-10-01T10:00:00.000Z", "conv-append", { prompt: "first prompt" });
  await createSessionAsset(store, sourcePath, "a2", "2026-10-01T10:01:00.000Z", "conv-append", { prompt: "second prompt" });
  await createSessionAsset(store, sourcePath, "a3", "2026-10-01T10:02:00.000Z", "conv-append", { prompt: "third prompt" });

  const initialPage = await store.listAssetPage({ projectId: "default", collapseStacks: true, limit: 100 });
  const stackId = initialPage.assets[0].stack.id;
  assert.equal(initialPage.assets[0].id, "a3");

  const rawBefore = new Database(join(libraryDir, "mosa.db"), { readonly: true });
  const sortNameBefore = rawBefore.prepare("SELECT sort_name FROM asset_stacks WHERE project_id = 'default' AND id = ?").get(stackId).sort_name;
  rawBefore.close();

  const beforeDelta = await store.listLibraryChangesSince("default", 0);
  const revisionBefore = beforeDelta.currentRevision;

  await createSessionAsset(store, sourcePath, "a4", "2026-10-01T10:03:00.000Z", "conv-append", { prompt: "fourth prompt" });

  const summary = await store.getAssetStack("default", stackId);
  assert.equal(summary.cover_asset_id, "a4");
  assert.equal(summary.order_locked, false);
  assert.deepEqual(await memberIdsOf(store, stackId), ["a4", "a3", "a2", "a1"]);

  const delta = await store.listLibraryChangesSince("default", revisionBefore);
  const stackEvents = delta.changes.filter((change) => change.entityType === "stack" && change.entityId === stackId);
  assert.equal(stackEvents.length, 1, "exactly one stack event emitted on append (no duplicate event)");
  assert.equal(stackEvents[0].kind, "stack-cover-changed");
  assert.ok(stackEvents[0].assetIds.includes("a3"), "event assetIds includes previous cover id");
  assert.ok(stackEvents[0].assetIds.includes("a4"), "event assetIds includes new cover id");
  assert.deepEqual(stackEvents[0].detail, { coverAssetId: "a4", previousCoverAssetId: "a3" });

  const rawAfter = new Database(join(libraryDir, "mosa.db"), { readonly: true });
  const sortNameAfter = rawAfter.prepare("SELECT sort_name FROM asset_stacks WHERE project_id = 'default' AND id = ?").get(stackId).sort_name;
  rawAfter.close();
  assert.equal(sortNameAfter, sortNameBefore, "unnamed stack sort_name does not change when cover rotates on append");
});

test("reordering an auto stack locks its order so later ingests append at the end without changing cover", async (t) => {
  const { store, sourcePath } = await createFixtureStore(t);
  await createSessionAsset(store, sourcePath, "r1", "2026-10-01T10:00:00.000Z", "conv-reorder");
  await createSessionAsset(store, sourcePath, "r2", "2026-10-01T10:01:00.000Z", "conv-reorder");
  await createSessionAsset(store, sourcePath, "r3", "2026-10-01T10:02:00.000Z", "conv-reorder");

  const page = await store.listAssetPage({ projectId: "default", collapseStacks: true, limit: 100 });
  const stackId = page.assets[0].stack.id;
  assert.deepEqual(await memberIdsOf(store, stackId), ["r3", "r2", "r1"]);

  const reordered = await store.reorderAssetStack("default", stackId, ["r1", "r3", "r2"]);
  assert.equal(reordered.cover_asset_id, "r1");

  const revBefore = (await store.listLibraryChangesSince("default", 0)).currentRevision;
  await createSessionAsset(store, sourcePath, "r4", "2026-10-01T10:05:00.000Z", "conv-reorder");

  const after = await store.getAssetStack("default", stackId);
  assert.equal(after.cover_asset_id, "r1", "user-chosen cover stays fixed");
  assert.deepEqual(await memberIdsOf(store, stackId), ["r1", "r3", "r2", "r4"], "new capture appends at the end");
  assert.equal(reordered.order_locked, true);
  assert.equal(after.order_locked, true);

  const delta = await store.listLibraryChangesSince("default", revBefore);
  const stackEvents = delta.changes.filter((change) => change.entityType === "stack" && change.entityId === stackId);
  assert.equal(stackEvents.length, 1);
  assert.equal(stackEvents[0].kind, "stack-members-changed");
});

test("manual stack keeps its chosen cover and appends later additions at the end", async (t) => {
  const { store, sourcePath } = await createFixtureStore(t);
  await createPlainAsset(store, sourcePath, "m1", "2026-10-01T10:00:00.000Z");
  await createPlainAsset(store, sourcePath, "m2", "2026-10-01T10:01:00.000Z");
  await createPlainAsset(store, sourcePath, "m3", "2026-10-01T10:10:00.000Z");

  const manual = await store.createAssetStack("default", ["m1", "m2"], { coverAssetId: "m2" });
  assert.equal(manual.origin, "manual");
  assert.equal(manual.order_locked, true);
  assert.equal(manual.cover_asset_id, "m2");
  assert.deepEqual(await memberIdsOf(store, manual.id), ["m2", "m1"]);

  const updated = await store.addAssetsToStack("default", manual.id, ["m3"]);
  assert.equal(updated.order_locked, true);
  assert.equal(updated.cover_asset_id, "m2", "cover stays m2 even when a newer asset is added");
  assert.deepEqual(await memberIdsOf(store, manual.id), ["m2", "m1", "m3"]);
});

test("dragging a newer loose image into an unlocked auto stack promotes it to cover", async (t) => {
  const { store, sourcePath } = await createFixtureStore(t);
  await createSessionAsset(store, sourcePath, "u1", "2026-10-01T10:00:00.000Z", "conv-drag");
  await createSessionAsset(store, sourcePath, "u2", "2026-10-01T10:02:00.000Z", "conv-drag");
  await createPlainAsset(store, sourcePath, "loose-newer", "2026-10-01T10:10:00.000Z");
  await createPlainAsset(store, sourcePath, "loose-newest", "2026-10-01T10:20:00.000Z");
  await createPlainAsset(store, sourcePath, "loose-older", "2026-10-01T09:50:00.000Z");

  const page = await store.listAssetPage({ projectId: "default", collapseStacks: true, limit: 100 });
  const stackId = page.assets.find((asset) => asset.stack).stack.id;

  const revBeforeAdd = (await store.listLibraryChangesSince("default", 0)).currentRevision;
  const afterAdd = await store.addAssetsToStack("default", stackId, ["loose-newer"]);
  assert.equal(afterAdd.order_locked, false, "adding a card does not lock an auto stack");
  assert.equal(afterAdd.cover_asset_id, "loose-newer");
  assert.deepEqual(await memberIdsOf(store, stackId), ["loose-newer", "u2", "u1"]);

  const addEvents = (await store.listLibraryChangesSince("default", revBeforeAdd)).changes
    .filter((change) => change.entityType === "stack" && change.entityId === stackId);
  assert.equal(addEvents.length, 1);
  assert.equal(addEvents[0].kind, "stack-cover-changed");
  assert.ok(addEvents[0].assetIds.includes("u2") && addEvents[0].assetIds.includes("loose-newer"));

  // moveAssetsToStack into the unlocked auto stack also promotes a newer card and places an older card at the back.
  const revBeforeMove = (await store.listLibraryChangesSince("default", 0)).currentRevision;
  const moveOutcome = await store.moveAssetsToStack("default", ["loose-older", "loose-newest"], stackId);
  assert.equal(moveOutcome.target.order_locked, false);
  assert.equal(moveOutcome.target.cover_asset_id, "loose-newest");
  assert.deepEqual(await memberIdsOf(store, stackId), ["loose-newest", "loose-newer", "u2", "u1", "loose-older"]);

  const moveEvents = (await store.listLibraryChangesSince("default", revBeforeMove)).changes
    .filter((change) => change.entityType === "stack" && change.entityId === stackId);
  assert.equal(moveEvents.length, 1);
  assert.equal(moveEvents[0].kind, "stack-cover-changed");
  assert.ok(moveEvents[0].assetIds.includes("loose-newer") && moveEvents[0].assetIds.includes("loose-newest"));
});

test("trashing the cover promotes the next newest member, and restoring brings it back as cover", async (t) => {
  const { store, sourcePath } = await createFixtureStore(t);
  await createSessionAsset(store, sourcePath, "d1", "2026-10-01T10:00:00.000Z", "conv-trash");
  await createSessionAsset(store, sourcePath, "d2", "2026-10-01T10:05:00.000Z", "conv-trash");
  await createSessionAsset(store, sourcePath, "d3", "2026-10-01T10:10:00.000Z", "conv-trash");

  const page = await store.listAssetPage({ projectId: "default", collapseStacks: true, limit: 100 });
  const stackId = page.assets[0].stack.id;
  assert.equal(page.assets[0].id, "d3");

  await store.deleteAsset("default", "d3");
  const afterTrash = await store.getAssetStack("default", stackId);
  assert.equal(afterTrash.order_locked, false);
  assert.equal(afterTrash.cover_asset_id, "d2");
  assert.deepEqual(await memberIdsOf(store, stackId), ["d2", "d1"]);

  await store.restoreAsset("default", "d3");
  const afterRestore = await store.getAssetStack("default", stackId);
  assert.equal(afterRestore.order_locked, false);
  assert.equal(afterRestore.cover_asset_id, "d3");
  assert.deepEqual(await memberIdsOf(store, stackId), ["d3", "d2", "d1"]);
});

test("one-time migration reorders untouched auto stacks, locks touched auto and manual stacks, runs once, and keeps legacy INSERT working", async (t) => {
  const { store, close, sourcePath, projectRoot, libraryDir } = await createFixtureStore(t, "mosa-stack-order-migration-");
  await createPlainAsset(store, sourcePath, "auto-u1", "2026-09-01T10:00:00.000Z");
  await createPlainAsset(store, sourcePath, "auto-u2", "2026-09-01T10:05:00.000Z");
  await createPlainAsset(store, sourcePath, "auto-u3", "2026-09-01T10:10:00.000Z");

  await createPlainAsset(store, sourcePath, "auto-t1", "2026-09-02T10:00:00.000Z");
  await createPlainAsset(store, sourcePath, "auto-t2", "2026-09-02T10:05:00.000Z");
  await createPlainAsset(store, sourcePath, "auto-t3", "2026-09-02T10:10:00.000Z");

  await createPlainAsset(store, sourcePath, "man-1", "2026-09-03T10:00:00.000Z");
  await createPlainAsset(store, sourcePath, "man-2", "2026-09-03T10:05:00.000Z");
  await createPlainAsset(store, sourcePath, "man-3", "2026-09-03T10:10:00.000Z");
  close();

  // Rebuild asset_stacks with the exact pre-305 DDL (no order_locked column) and seed legacy stacks.
  const legacyDb = new Database(join(libraryDir, "mosa.db"));
  legacyDb.pragma("foreign_keys = OFF");
  legacyDb.transaction(() => {
    legacyDb.exec("DELETE FROM asset_stack_members");
    legacyDb.exec("DROP TABLE asset_stacks");
    legacyDb.exec(`
      CREATE TABLE asset_stacks (
        project_id TEXT NOT NULL,
        id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sort_created_at TEXT NOT NULL DEFAULT '',
        sort_name TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        origin TEXT NOT NULL DEFAULT 'manual',
        session_key TEXT NOT NULL DEFAULT '',
        name_locked INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_id, id)
      );
      CREATE UNIQUE INDEX asset_stacks_project_auto_session_idx
        ON asset_stacks(project_id, session_key) WHERE origin = 'auto';
    `);
    const ts = "2026-09-05T00:00:00.000Z";
    const insertStack = legacyDb.prepare(`
      INSERT INTO asset_stacks (project_id, id, created_at, updated_at, sort_created_at, sort_name, name, origin, session_key, name_locked)
      VALUES ('default', ?, ?, ?, ?, '', '', ?, ?, 0)
    `);
    const insertMember = legacyDb.prepare(`
      INSERT INTO asset_stack_members (project_id, stack_id, asset_id, position, added_at)
      VALUES ('default', ?, ?, ?, ?)
    `);

    // 1) Untouched auto stack: strictly oldest-to-newest (auto-u1 -> auto-u2 -> auto-u3)
    insertStack.run("stack-auto-untouched", ts, ts, "2026-09-01T10:10:00.000Z", "auto", "web-chatgpt:s-untouched");
    insertMember.run("stack-auto-untouched", "auto-u1", 0, ts);
    insertMember.run("stack-auto-untouched", "auto-u2", 1, ts);
    insertMember.run("stack-auto-untouched", "auto-u3", 2, ts);

    // 2) User-reordered / non-chronological auto stack: auto-t2 (0), auto-t1 (1), auto-t3 (2)
    insertStack.run("stack-auto-touched", ts, ts, "2026-09-02T10:10:00.000Z", "auto", "web-chatgpt:s-touched");
    insertMember.run("stack-auto-touched", "auto-t2", 0, ts);
    insertMember.run("stack-auto-touched", "auto-t1", 1, ts);
    insertMember.run("stack-auto-touched", "auto-t3", 2, ts);

    // 3) Manual stack (even with chronological oldest-to-newest members): must lock and never reorder
    insertStack.run("stack-manual-legacy", ts, ts, "2026-09-03T10:10:00.000Z", "manual", "");
    insertMember.run("stack-manual-legacy", "man-1", 0, ts);
    insertMember.run("stack-manual-legacy", "man-2", 1, ts);
    insertMember.run("stack-manual-legacy", "man-3", 2, ts);

    legacyDb.exec("DELETE FROM library_changes");
    legacyDb.prepare("UPDATE library_meta SET value = '0' WHERE key = 'library_revision'").run();
  })();
  legacyDb.pragma("foreign_keys = ON");
  legacyDb.close();

  const migrated = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  let migratedClosed = false;
  const closeMigrated = () => {
    if (!migratedClosed) {
      migratedClosed = true;
      migrated.close();
    }
  };
  t.after(closeMigrated);

  const untouchedSummary = await migrated.getAssetStack("default", "stack-auto-untouched");
  assert.equal(untouchedSummary.order_locked, false);
  assert.equal(untouchedSummary.cover_asset_id, "auto-u3");
  assert.deepEqual(await memberIdsOf(migrated, "stack-auto-untouched"), ["auto-u3", "auto-u2", "auto-u1"]);

  const touchedSummary = await migrated.getAssetStack("default", "stack-auto-touched");
  assert.equal(touchedSummary.order_locked, true, "non-chronological auto stack is marked order_locked = 1");
  assert.equal(touchedSummary.cover_asset_id, "auto-t2");
  assert.deepEqual(await memberIdsOf(migrated, "stack-auto-touched"), ["auto-t2", "auto-t1", "auto-t3"], "non-chronological auto stack members are untouched");

  const manualSummary = await migrated.getAssetStack("default", "stack-manual-legacy");
  assert.equal(manualSummary.order_locked, true, "manual stack is marked order_locked = 1");
  assert.equal(manualSummary.cover_asset_id, "man-1");
  assert.deepEqual(await memberIdsOf(migrated, "stack-manual-legacy"), ["man-1", "man-2", "man-3"], "manual stack members are untouched");

  // Migration uses the unified backfill refresh rather than per-stack cover/member events.
  const deltaAfterFirstOpen = await migrated.listLibraryChangesSince("default", 0);
  assert.equal(
    deltaAfterFirstOpen.changes.filter((change) => change.kind === "stack-cover-changed" || change.kind === "stack-members-changed").length,
    0,
  );
  assert.equal(
    deltaAfterFirstOpen.changes.filter((change) => change.kind === "library-backfilled").length,
    1,
  );
  closeMigrated();

  const snapshot = () => {
    const raw = new Database(join(libraryDir, "mosa.db"), { readonly: true });
    try {
      return JSON.stringify({
        revision: raw.prepare("SELECT value FROM library_meta WHERE key = 'library_revision'").get()?.value || "0",
        stacks: raw.prepare("SELECT id, origin, order_locked FROM asset_stacks ORDER BY id").all(),
        members: raw.prepare("SELECT stack_id, asset_id, position FROM asset_stack_members ORDER BY stack_id, position").all(),
      });
    } finally {
      raw.close();
    }
  };
  const afterFirst = snapshot();

  // Reopen a second time: no row or revision changes.
  const second = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  second.close();
  const afterSecond = snapshot();
  assert.equal(afterSecond, afterFirst, "second open does not touch any rows or advance library_revision");

  // Legacy code opening the migrated DB and issuing INSERT without order_locked must succeed.
  const oldWriter = new Database(join(libraryDir, "mosa.db"));
  try {
    oldWriter.prepare(`
      INSERT INTO asset_stacks (project_id, id, created_at, updated_at, sort_created_at, sort_name)
      VALUES ('default', 'legacy-insert-stack', '2026-09-10T00:00:00.000Z', '2026-09-10T00:00:00.000Z', '', '')
    `).run();
    const inserted = oldWriter.prepare("SELECT id, origin, order_locked FROM asset_stacks WHERE id = 'legacy-insert-stack'").get();
    assert.deepEqual(inserted, { id: "legacy-insert-stack", origin: "manual", order_locked: 0 });
  } finally {
    oldWriter.close();
  }
});

test("filtered collapsed views show the front-most matching member while unfiltered view shows whole-stack cover", async (t) => {
  const { store, sourcePath } = await createFixtureStore(t);
  await createSessionAsset(store, sourcePath, "f1", "2026-10-05T10:00:00.000Z", "conv-filter");
  await createSessionAsset(store, sourcePath, "f2", "2026-10-05T10:05:00.000Z", "conv-filter");
  await createSessionAsset(store, sourcePath, "f3", "2026-10-05T10:10:00.000Z", "conv-filter");

  // Stack order is [f3 (pos 0), f2 (pos 1), f1 (pos 2)].
  // Mark f3 as organized via group ("Brand") and favorite f1 only:
  // - All assets (unfiltered): card is f3 (whole-stack cover).
  // - Favorites (favorite: true): only f1 is favorited -> card is f1.
  // - Unsorted (unorganized: true): f3 is grouped (organized), f1 is favorited (organized), only f2 is unorganized -> card is f2.
  // Now also add f0 (older, unorganized) so Unsorted has TWO unorganized members [f2 (pos 1), f0 (pos 3)] -> card is f2 (front-most unorganized).
  await createSessionAsset(store, sourcePath, "f0", "2026-10-05T09:55:00.000Z", "conv-filter");
  await store.updateMetadata("default", "f3", { group: "Brand" });
  await store.updateMetadata("default", "f1", { favorite: true });

  const allPage = await store.listAssetPage({ projectId: "default", collapseStacks: true, limit: 100 });
  assert.deepEqual(allPage.assets.map((asset) => asset.id), ["f3"]);
  assert.equal(allPage.assets[0].stack.count, 4);
  assert.equal(allPage.assets[0].stack.match_count, undefined);

  const favPage = await store.listAssetPage({ projectId: "default", collapseStacks: true, favorite: true, limit: 100 });
  assert.deepEqual(favPage.assets.map((asset) => asset.id), ["f1"]);
  assert.equal(favPage.assets[0].stack.count, 4);
  assert.equal(favPage.assets[0].stack.match_count, 1);

  const unsortedPage = await store.listAssetPage({ projectId: "default", collapseStacks: true, unorganized: true, limit: 100 });
  assert.deepEqual(unsortedPage.assets.map((asset) => asset.id), ["f2"]);
  assert.equal(unsortedPage.assets[0].stack.count, 4);
  assert.equal(unsortedPage.assets[0].stack.match_count, 2);
});

test("incremental gallery reconciliation (listGalleryRowsForAssets) matches full-page collapsed cards across every stack and filter", async (t) => {
  const { store, sourcePath } = await createFixtureStore(t);

  // Stack 1: unlocked auto stack [s1-3, s1-2, s1-1]
  // s1-3 (cover) in group "Alpha", s1-2 favorited, s1-1 unorganized.
  await createSessionAsset(store, sourcePath, "s1-1", "2026-10-06T10:00:00.000Z", "conv-inc-1");
  await createSessionAsset(store, sourcePath, "s1-2", "2026-10-06T10:05:00.000Z", "conv-inc-1", { favorite: true });
  await createSessionAsset(store, sourcePath, "s1-3", "2026-10-06T10:10:00.000Z", "conv-inc-1", { group: "Alpha" });

  // Stack 2: manual stack [m2-cover, m2-mid, m2-end]
  // m2-cover plain (in manual stack -> organized), m2-mid in group "Alpha" + favorited, m2-end favorited + web-flow.
  await createPlainAsset(store, sourcePath, "m2-cover", "2026-10-06T11:00:00.000Z");
  await createPlainAsset(store, sourcePath, "m2-mid", "2026-10-06T11:05:00.000Z", { favorite: true, group: "Alpha" });
  await createPlainAsset(store, sourcePath, "m2-end", "2026-10-06T11:10:00.000Z", {
    favorite: true,
    source: { type: "web-flow" },
  });
  const manualStack = await store.createAssetStack("default", ["m2-cover", "m2-mid", "m2-end"], { coverAssetId: "m2-cover" });

  // Stack 3: reordered auto stack [r3-pick, r3-new, r3-old]
  // r3-pick unorganized, r3-new unorganized, r3-old favorited.
  await createSessionAsset(store, sourcePath, "r3-old", "2026-10-06T12:00:00.000Z", "conv-inc-3", { favorite: true });
  await createSessionAsset(store, sourcePath, "r3-pick", "2026-10-06T12:05:00.000Z", "conv-inc-3");
  await createSessionAsset(store, sourcePath, "r3-new", "2026-10-06T12:10:00.000Z", "conv-inc-3");
  const allInitial = await store.listAssetPage({ projectId: "default", collapseStacks: true, limit: 100 });
  const stack1Id = allInitial.assets.find((asset) => asset.id === "s1-3").stack.id;
  const stack3Id = allInitial.assets.find((asset) => asset.id === "r3-new").stack.id;
  await store.reorderAssetStack("default", stack3Id, ["r3-pick", "r3-new", "r3-old"]);

  const membersByStack = new Map([
    [stack1Id, ["s1-3", "s1-2", "s1-1"]],
    [manualStack.id, ["m2-cover", "m2-mid", "m2-end"]],
    [stack3Id, ["r3-pick", "r3-new", "r3-old"]],
  ]);
  const allAssetIds = [...membersByStack.values()].flat();

  const filterCases = [
    { label: "all", filters: {} },
    { label: "favorite", filters: { favorite: true } },
    { label: "unorganized", filters: { unorganized: true } },
    { label: "group:Alpha", filters: { group: "Alpha" } },
    { label: "source:web-flow", filters: { source: "web-flow" } },
  ];

  for (const { label, filters } of filterCases) {
    const page = await store.listAssetPage({
      projectId: "default",
      collapseStacks: true,
      sort: "newest",
      limit: 100,
      ...filters,
    });
    const reconciled = await store.listGalleryRowsForAssets(
      { projectId: "default", collapseStacks: true, sort: "newest", ...filters },
      allAssetIds,
    );

    assert.deepEqual(
      reconciled.rows.map((row) => ({ id: row.id, stack: row.stack })),
      page.assets.map((asset) => ({ id: asset.id, stack: asset.stack })),
      `[${label}] reconciled rows match full-page collapsed cards`,
    );

    for (const card of page.assets) {
      assert.ok(card.stack, `[${label}] expected stack card`);
      const members = membersByStack.get(card.stack.id);
      for (const memberId of members) {
        assert.equal(
          reconciled.rowByAssetId[memberId],
          card.id,
          `[${label}] member ${memberId} of stack ${card.stack.id} maps to displayed card ${card.id}`,
        );
      }
    }
  }
});
