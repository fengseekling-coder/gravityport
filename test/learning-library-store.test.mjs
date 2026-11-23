// Learning-library store tests (task 459). Every case drives the real
// createSqliteAssetStore against a temporary on-disk library — no test doubles,
// no copied implementation. Covers: v19→v20 table creation and upgrade, the
// "joining never moves an asset out of its group or stack" guarantee (full-row
// comparison), the three add sources with dedupe, trash hiding/restore and the
// FK cascade on permanent delete, name normalization, navigation-stats cache
// freshness, and the learningLibrary gallery filter (stacks unfolded).
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CURRENT_SCHEMA_VERSION,
  createSqliteAssetStore,
  sqliteDatabasePath,
} from "../lib/sqlite-asset-store.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

async function createStore(t, prefix = "mosa-learning-library-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  const generatedDir = join(projectRoot, "generated-images");
  await mkdir(generatedDir, { recursive: true });
  const sourcePath = join(generatedDir, "fixture.png");
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir, initializeFreshLibrary: true });
  t.after(() => store.close());
  return { root, projectRoot, libraryDir, sourcePath, store };
}

async function seedImage(store, sourcePath, id, prompt = id) {
  const created = await store.createAsset({ assetId: id, imagePath: sourcePath, prompt, source: { type: "local-file" } });
  return created.asset.id;
}

// Read-only side connection: full-row snapshots of every table the joins must
// never touch (assets row, stack membership, stacks, groups).
function snapshotUntouchedTables(libraryDir) {
  const db = new Database(sqliteDatabasePath(libraryDir), { readonly: true });
  try {
    return JSON.stringify({
      assets: db.prepare("SELECT * FROM assets ORDER BY project_id, id").all(),
      asset_stack_members: db.prepare("SELECT * FROM asset_stack_members ORDER BY project_id, stack_id, asset_id").all(),
      asset_stacks: db.prepare("SELECT * FROM asset_stacks ORDER BY project_id, id").all(),
      groups: db.prepare("SELECT * FROM groups ORDER BY project_id, name").all(),
    });
  } finally {
    db.close();
  }
}

function memberRows(libraryDir, { libraryId, assetId } = {}) {
  const db = new Database(sqliteDatabasePath(libraryDir), { readonly: true });
  try {
    const where = [];
    const params = [];
    if (libraryId) { where.push("library_id = ?"); params.push(libraryId); }
    if (assetId) { where.push("asset_id = ?"); params.push(assetId); }
    return db.prepare(
      `SELECT project_id, library_id, asset_id, added_at FROM learning_library_members ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY library_id, asset_id`,
    ).all(...params);
  } finally {
    db.close();
  }
}

function tableList(libraryDir) {
  const db = new Database(sqliteDatabasePath(libraryDir), { readonly: true });
  try {
    return {
      tables: db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('learning_libraries', 'learning_library_members') ORDER BY name").all().map((row) => row.name),
      indexes: db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('learning_libraries_project_name_ci_idx', 'learning_library_members_asset_idx') ORDER BY name").all().map((row) => row.name),
      columns: {
        libraries: db.prepare("SELECT name FROM pragma_table_info('learning_libraries') ORDER BY name").all().map((row) => row.name),
        members: db.prepare("SELECT name FROM pragma_table_info('learning_library_members') ORDER BY name").all().map((row) => row.name),
      },
    };
  } finally {
    db.close();
  }
}

test("CURRENT_SCHEMA_VERSION is at least 20 and a fresh library carries both learning-library tables and indexes", async (t) => {
  // 任务 463：版本升到 21（learning-guide 表），这里放宽为 >= 20，=== 21 由
  // test/learning-guide-store.test.mjs 接替钉住。
  assert.ok(CURRENT_SCHEMA_VERSION >= 20);
  const { libraryDir, store } = await createStore(t);
  await store.ensureProject("default");
  const { tables, indexes, columns } = tableList(libraryDir);
  assert.deepEqual(tables, ["learning_libraries", "learning_library_members"]);
  assert.deepEqual(indexes, ["learning_libraries_project_name_ci_idx", "learning_library_members_asset_idx"]);
  assert.deepEqual(columns.libraries, ["created_at", "id", "name", "project_id", "updated_at"]);
  assert.deepEqual(columns.members, ["added_at", "asset_id", "library_id", "project_id"]);
});

test("a v19 library upgrades to v20 on open and keeps every pre-existing row intact", async (t) => {
  const { libraryDir, sourcePath, store } = await createStore(t, "mosa-learning-upgrade-");
  await store.ensureProject("default");
  await seedImage(store, sourcePath, "old-a");
  await store.createGroup({ projectId: "default", name: "旧分组" });
  await store.assignAssetsToGroup("default", ["old-a"], "旧分组");

  const before = snapshotUntouchedTables(libraryDir);
  // Roll the on-disk schema back to exactly v19 (asset_canvas_state era): drop
  // the two learning-library tables + indexes and stamp the old version.
  const raw = new Database(sqliteDatabasePath(libraryDir));
  raw.exec("DROP TABLE learning_library_members; DROP TABLE learning_libraries;");
  raw.exec("DROP INDEX IF EXISTS learning_libraries_project_name_ci_idx; DROP INDEX IF EXISTS learning_library_members_asset_idx;");
  raw.prepare("UPDATE library_meta SET value = '19' WHERE key = 'schema_version'").run();
  raw.close();

  // A fresh store on the same library performs the v19 → v20 upgrade on open.
  const reopened = createSqliteAssetStore({
    projectRoot: join(libraryDir, "..", "project"),
    managerDir: join(libraryDir, "..", "project", "mosa"),
    libraryDir,
  });
  t.after(() => reopened.close());
  const after = snapshotUntouchedTables(libraryDir);
  assert.equal(after, before, "the upgrade must not touch assets, groups or stacks");
  const { tables, indexes } = tableList(libraryDir);
  assert.deepEqual(tables, ["learning_libraries", "learning_library_members"]);
  assert.deepEqual(indexes, ["learning_libraries_project_name_ci_idx", "learning_library_members_asset_idx"]);
  const version = new Database(sqliteDatabasePath(libraryDir), { readonly: true })
    .prepare("SELECT value FROM library_meta WHERE key = 'schema_version'").get().value;
  // 任务 463：版本升到 21，这个升级测试的落点跟着 CURRENT 走（=== 21 由
  // test/learning-guide-store.test.mjs 钉住）。
  assert.equal(version, "21");
  const groups = await reopened.listGroups("default");
  assert.equal(groups.groups.find((group) => group.name === "旧分组")?.count, 1, "pre-existing data survives");
});

test("joining a grouped, stacked image to two libraries leaves assets/stacks/groups byte-identical; removing and deleting never frees the image", async (t) => {
  const { libraryDir, sourcePath, store } = await createStore(t, "mosa-learning-untouched-");
  await seedImage(store, sourcePath, "p1");
  await seedImage(store, sourcePath, "p2");
  await store.createGroup({ projectId: "default", name: "海报" });
  await store.assignAssetsToGroup("default", ["p1", "p2"], "海报");
  const stack = await store.createAssetStack("default", ["p1", "p2"], "p1");

  const libA = await store.createLearningLibrary({ projectId: "default", name: "A" });
  const libB = await store.createLearningLibrary({ projectId: "default", name: "B" });

  const before = snapshotUntouchedTables(libraryDir);
  const addA = await store.addToLearningLibrary("default", libA.id, { assetIds: ["p1"] });
  const addB = await store.addToLearningLibrary("default", libB.id, { assetIds: ["p1"] });
  assert.deepEqual(addA, { added: 1, alreadyIn: 0, skippedVideos: 0, missing: 0 });
  assert.deepEqual(addB, { added: 1, alreadyIn: 0, skippedVideos: 0, missing: 0 });
  assert.equal((await store.getLearningLibrary("default", libA.id)).count, 1);
  assert.equal((await store.getLearningLibrary("default", libB.id)).count, 1);
  assert.equal(snapshotUntouchedTables(libraryDir), before, "assets rows, stack rows and groups must be identical after joining");

  // Removing from A keeps the membership in B and never touches the group/stack.
  const removed = await store.removeFromLearningLibrary("default", libA.id, ["p1"]);
  assert.deepEqual(removed, { removed: 1 });
  assert.equal((await store.getLearningLibrary("default", libB.id)).count, 1, "B still holds the image");
  assert.equal(snapshotUntouchedTables(libraryDir), before, "group/stack rows still identical after removal");

  // Deleting library A frees nothing: the image stays grouped, stacked, alive.
  await store.deleteLearningLibrary("default", libA.id);
  const page = await store.listAssetPage({ projectId: "default", query: "", sort: "newest", limit: 50 });
  assert.ok(page.assets.some((asset) => asset.id === "p1"), "the image is still in the library");
  assert.equal(snapshotUntouchedTables(libraryDir), before, "still no touch after deleting a library");
  assert.equal(memberRows(libraryDir, { libraryId: libA.id }).length, 0, "A's member rows are gone");
  assert.equal(memberRows(libraryDir, { libraryId: libB.id }).length, 1, "B's member rows survive");
  assert.equal((await store.getLearningLibrary("default", libB.id)).groupCount, 1, "groupCount counts the group");
});

test("three add sources expand, dedupe and count: group (with stack members), stack, mixed re-add", async (t) => {
  const { sourcePath, store } = await createStore(t, "mosa-learning-sources-");
  await seedImage(store, sourcePath, "g1");
  await seedImage(store, sourcePath, "g2");
  await seedImage(store, sourcePath, "outside");
  // A video-shaped asset: media_kind wins over the extension.
  const video = (await store.createAsset({ assetId: "vid", imagePath: sourcePath, prompt: "vid", source: { type: "local-file" }, business_fields: { media_kind: "video" } })).asset.id;
  await store.createGroup({ projectId: "default", name: "海报" });
  await store.assignAssetsToGroup("default", ["g1", "g2"], "海报");
  const stack = await store.createAssetStack("default", ["g1", "g2"], "g1");
  const library = await store.createLearningLibrary({ projectId: "default", name: "来源" });

  // Group source: every live image of the group (stack members included);
  // the video is skipped and counted; trashed assets never join.
  await store.deleteAsset("default", "g2", { reason: "test" });
  const byGroup = await store.addToLearningLibrary("default", library.id, { groupName: "海报" });
  assert.deepEqual(byGroup, { added: 1, alreadyIn: 0, skippedVideos: 0, missing: 0 }, "trashed g2 is not added, only live g1");
  await store.restoreAsset("default", "g2");
  const byGroupAfterRestore = await store.addToLearningLibrary("default", library.id, { groupName: "海报" });
  assert.deepEqual(byGroupAfterRestore, { added: 1, alreadyIn: 1, skippedVideos: 0, missing: 0 });

  // Video skip counts, whether direct or via the group.
  const withVideo = await store.addToLearningLibrary("default", library.id, { assetIds: ["vid"] });
  assert.deepEqual(withVideo, { added: 0, alreadyIn: 0, skippedVideos: 1, missing: 0 });
  const videoGroup = await store.createLearningLibrary({ projectId: "default", name: "视频组" });
  await store.assignAssetsToGroup("default", ["vid"], "视频组");
  const videoViaGroup = await store.addToLearningLibrary("default", videoGroup.id, { groupName: "视频组" });
  assert.deepEqual(videoViaGroup, { added: 0, alreadyIn: 0, skippedVideos: 1, missing: 0 });

  // Stack source: the whole stack joins.
  const stackLibrary = await store.createLearningLibrary({ projectId: "default", name: "整叠" });
  const byStack = await store.addToLearningLibrary("default", stackLibrary.id, { stackIds: [stack.id] });
  assert.deepEqual(byStack, { added: 2, alreadyIn: 0, skippedVideos: 0, missing: 0 });

  // Mixed sources with overlap dedupe to one membership each.
  const mixedLibrary = await store.createLearningLibrary({ projectId: "default", name: "混合" });
  const mixed = await store.addToLearningLibrary("default", mixedLibrary.id, {
    assetIds: ["g1", "outside", "ghost"],
    stackIds: [stack.id],
    groupName: "海报",
  });
  assert.deepEqual(mixed, { added: 3, alreadyIn: 0, skippedVideos: 0, missing: 1 }, "g1+g2+outside once each, ghost is missing");
  // Re-adding everything reports alreadyIn, added 0.
  const again = await store.addToLearningLibrary("default", mixedLibrary.id, {
    assetIds: ["g1", "g2", "outside"],
    stackIds: [stack.id],
    groupName: "海报",
  });
  assert.deepEqual(again, { added: 0, alreadyIn: 3, skippedVideos: 0, missing: 0 });
});

test("trash hides members from list and page; restore brings them back; emptying the trash cascades the membership rows away", async (t) => {
  const { libraryDir, sourcePath, store } = await createStore(t, "mosa-learning-trash-");
  await seedImage(store, sourcePath, "t1");
  const library = await store.createLearningLibrary({ projectId: "default", name: "回收站库" });
  await store.addToLearningLibrary("default", library.id, { assetIds: ["t1"] });
  assert.equal((await store.listLearningLibraries("default"))[0].count, 1);

  await store.deleteAsset("default", "t1", { reason: "test" });
  const listed = await store.listLearningLibraries("default");
  assert.equal(listed[0].count, 0, "trashed member stops counting");
  const page = await store.listAssetPage({ projectId: "default", query: "", learningLibrary: library.id, sort: "newest", limit: 50 });
  assert.equal(page.assets.length, 0, "trashed member leaves the learning-library page");

  await store.restoreAsset("default", "t1");
  assert.equal((await store.listLearningLibraries("default"))[0].count, 1, "restore brings the member back");
  const membership = memberRows(libraryDir, { libraryId: library.id });
  assert.equal(membership.length, 1, "membership row survived the trash round-trip");

  // Emptying the trash is a plain DELETE FROM assets: the FK cascade must
  // remove the membership rows.
  await store.deleteAsset("default", "t1", { reason: "test" });
  await store.emptyTrash("default");
  assert.equal(memberRows(libraryDir).length, 0, "cascade removed the membership rows");
  assert.equal((await store.listLearningLibraries("default"))[0].count, 0);
});

test("names follow the group rules: empty refused, case/whitespace duplicates refused, 80-char cap", async (t) => {
  const { store } = await createStore(t, "mosa-learning-names-");
  await store.createLearningLibrary({ projectId: "default", name: "海报" });
  await assert.rejects(
    () => store.createLearningLibrary({ projectId: "default", name: "   " }),
    (error) => error.code === "LEARNING_LIBRARY_NAME_EMPTY" && error.statusCode === 400,
  );
  await assert.rejects(
    () => store.createLearningLibrary({ projectId: "default", name: " 海报 " }),
    (error) => error.code === "LEARNING_LIBRARY_NAME_TAKEN" && error.statusCode === 409,
  );
  // Case-insensitive uniqueness (COLLATE NOCASE), like groups.
  await store.createLearningLibrary({ projectId: "default", name: "Poster" });
  await assert.rejects(
    () => store.createLearningLibrary({ projectId: "default", name: "poster" }),
    (error) => error.code === "LEARNING_LIBRARY_NAME_TAKEN",
  );
  const other = await store.createLearningLibrary({ projectId: "default", name: "第二个" });
  await assert.rejects(
    () => store.renameLearningLibrary("default", other.id, "海报"),
    (error) => error.code === "LEARNING_LIBRARY_NAME_TAKEN",
  );
  const long = "长".repeat(90);
  const created = await store.createLearningLibrary({ projectId: "default", name: long });
  assert.equal(created.name.length, 80, "normalizeGroupName caps at 80 characters");
  await assert.rejects(
    () => store.getLearningLibrary("default", "ll_missing"),
    (error) => error.code === "LEARNING_LIBRARY_NOT_FOUND" && error.statusCode === 404,
  );
});

test("navigation stats pick up learning libraries immediately after every kind of change (cache invalidated)", async (t) => {
  const { sourcePath, store } = await createStore(t, "mosa-learning-nav-");
  await seedImage(store, sourcePath, "n1");
  // Warm the stats cache.
  assert.deepEqual(await store.listNavigationStats("default").then((stats) => stats.learningLibraries), []);

  const library = await store.createLearningLibrary({ projectId: "default", name: "统计" });
  const navLibraries = () => store.listNavigationStats("default").then((stats) => stats.learningLibraries);
  const afterCreate = await navLibraries();
  assert.deepEqual(afterCreate, [{ id: library.id, name: "统计", count: 0 }]);

  await store.addToLearningLibrary("default", library.id, { assetIds: ["n1"] });
  assert.equal((await navLibraries())[0].count, 1, "add refreshes the cached stats");

  await store.renameLearningLibrary("default", library.id, "统计改名");
  assert.equal((await navLibraries())[0].name, "统计改名", "rename refreshes the cached stats");

  await store.deleteAsset("default", "n1", { reason: "test" });
  assert.equal((await navLibraries())[0].count, 0, "trashing a member refreshes the cached stats");

  await store.deleteLearningLibrary("default", library.id);
  assert.deepEqual(await navLibraries(), [], "delete refreshes the cached stats");
});

test("the learningLibrary gallery filter lists exactly the library's images with stacks unfolded; search stays inside the library", async (t) => {
  const { sourcePath, store } = await createStore(t, "mosa-learning-filter-");
  await seedImage(store, sourcePath, "f1", "filter f1 独有提示词");
  await seedImage(store, sourcePath, "f2", "filter f2");
  await seedImage(store, sourcePath, "elsewhere", "filter elsewhere");
  await store.createGroup({ projectId: "default", name: "海报" });
  await store.assignAssetsToGroup("default", ["f1", "f2"], "海报");
  const stack = await store.createAssetStack("default", ["f1", "f2"], "f1");
  const lib = await store.createLearningLibrary({ projectId: "default", name: "过滤" });
  await store.addToLearningLibrary("default", lib.id, { stackIds: [stack.id] });

  // Both stack members list separately: stacks do not collapse under the
  // filter, and covers stay plain images (the routes pass
  // stackCoverAnnotations: false for the learning-library view — task 459).
  const page = await store.listAssetPage({ projectId: "default", query: "", learningLibrary: lib.id, sort: "newest", limit: 50, collapseStacks: false, stackCoverAnnotations: false });
  assert.deepEqual(page.assets.map((asset) => asset.id).sort(), ["f1", "f2"]);
  assert.ok(page.assets.every((asset) => !asset.stack), "no stack nodes inside a learning-library view");

  // Search narrows within the library, not across the whole project.
  const searched = await store.listAssetPage({ projectId: "default", query: "独有提示词", learningLibrary: lib.id, sort: "newest", limit: 50 });
  assert.deepEqual(searched.assets.map((asset) => asset.id), ["f1"]);
  const searchMiss = await store.listAssetPage({ projectId: "default", query: "elsewhere", learningLibrary: lib.id, sort: "newest", limit: 50 });
  assert.equal(searchMiss.assets.length, 0, "a match outside the library does not leak in");
});
