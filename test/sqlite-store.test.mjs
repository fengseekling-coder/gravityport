import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { chmod, copyFile, mkdtemp, mkdir, readFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createDerivativeWorker, processDerivativeJob } from "../lib/derivative-worker.js";
import { createAssetStore } from "../lib/asset-store.mjs";
import { PIXEL_HASH_VERSION, safePixelDigest } from "../lib/image-pixel-hash.js";
import { normalizeCreatedAt } from "../lib/recent-window.js";
import { CURRENT_SCHEMA_VERSION, createSqliteAssetStore, sqliteDatabasePath } from "../lib/sqlite-asset-store.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

test("SQLite managed-file cleanup removes only stale unreferenced files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-sqlite-orphan-cleanup-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir: join(root, "library"), initializeFreshLibrary: true });
  t.after(() => store.close());
  await store.ensureProject("default");
  const stale = join(store.imagesDir("default"), "stale-orphan.png");
  const fresh = join(store.imagesDir("default"), "fresh-orphan.png");
  await writeFile(stale, "stale");
  await writeFile(fresh, "fresh");
  const now = Date.now();
  const staleTime = new Date(now - 48 * 60 * 60 * 1000);
  await utimes(stale, staleTime, staleTime);
  const result = await store.cleanupOrphanedManagedFiles({ olderThanMs: 24 * 60 * 60 * 1000 });
  assert.equal(result.removed, 1);
  await assert.rejects(stat(stale), /ENOENT/);
  assert.equal((await stat(fresh)).isFile(), true);
});

test("SQLite managed-file cleanup can skip derivative trees already owned by derivative maintenance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-sqlite-orphan-originals-only-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir: join(root, "library"), initializeFreshLibrary: true });
  t.after(() => store.close());
  await store.ensureProject("default");
  const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const orphanOriginal = join(store.imagesDir("default"), "orphan.png");
  const orphanPreview = join(store.previewsDir("default"), "orphan.webp");
  await writeFile(orphanOriginal, "orphan");
  await writeFile(orphanPreview, "orphan");
  await utimes(orphanOriginal, staleTime, staleTime);
  await utimes(orphanPreview, staleTime, staleTime);

  const result = await store.cleanupOrphanedManagedFiles({ olderThanMs: 24 * 60 * 60 * 1000, includeDerivatives: false });
  assert.equal(result.removed, 1);
  await assert.rejects(stat(orphanOriginal), /ENOENT/);
  assert.equal((await stat(orphanPreview)).isFile(), true);
});

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

test("SQLite read-only library queries do not materialize project asset directories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-read-only-project-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir: join(root, "library"), initializeFreshLibrary: true });
  t.after(() => store.close());
  const projectId = "read-only-project";
  const projectDir = store.projectDir(projectId);

  const page = await store.listAssetPage({ projectId, limit: 20 });
  const groups = await store.listGroups(projectId);
  assert.deepEqual(page.assets, []);
  assert.deepEqual(groups.groups, []);
  await assert.rejects(stat(projectDir), /ENOENT/,
    "read paths must not pay mkdir/INSERT project setup costs");
});

test("SQLite materializes search and filter scalars without changing search semantics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-search-scalars-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });

  await store.createAsset({
    assetId: "scalar-search",
    imagePath: sourcePath,
    prompt: "minimal identity study",
    tags: ["LaunchMark"],
    business_fields: { user_message: "AuroraCampaign" },
    group: "Brand",
    category: "identity",
    style: "minimal",
    favorite: true,
    source: {
      type: "local-file", provider: "chatgpt", media_kind: "video", model: "NebulaSource",
      conversation_id: "conversation-scalar", message_id: "batch-scalar",
    },
  });
  assert.deepEqual((await store.listAssets({ projectId: "default", query: "launchmark" })).map((asset) => asset.id), ["scalar-search"]);
  assert.deepEqual((await store.listAssets({ projectId: "default", query: "auroracampaign" })).map((asset) => asset.id), ["scalar-search"]);
  assert.deepEqual((await store.listAssets({ projectId: "default", query: "nebulasource" })).map((asset) => asset.id), ["scalar-search"]);
  // Search-scope whitelist: internal source values (raw type, conversation id,
  // message id) stay out of text search even though the structured filters
  // below still find the row by them.
  assert.deepEqual((await store.listAssets({ projectId: "default", query: "conversation-scalar" })).map((asset) => asset.id), []);
  assert.deepEqual((await store.listAssets({ projectId: "default", query: "batch-scalar" })).map((asset) => asset.id), []);
  assert.deepEqual((await store.listAssets({ projectId: "default", query: "local-file" })).map((asset) => asset.id), []);
  assert.deepEqual((await store.listAssets({ projectId: "default", source: "web-chatgpt" })).map((asset) => asset.id), ["scalar-search"]);
  assert.deepEqual((await store.listAssets({ projectId: "default", mediaKind: "video" })).map((asset) => asset.id), ["scalar-search"]);
  assert.deepEqual((await store.listAssets({ projectId: "default", conversation: "conversation-scalar" })).map((asset) => asset.id), ["scalar-search"]);
  assert.deepEqual((await store.listAssets({ projectId: "default", conversation: "conversation-scalar", generationBatch: "batch-scalar" })).map((asset) => asset.id), ["scalar-search"]);
  store.close();

  const database = new Database(sqliteDatabasePath(libraryDir), { readonly: true });
  const row = database.prepare(`
    SELECT tags_text, business_search_text, source_search_text, media_kind, source_group, conversation_id, generation_batch
    FROM assets WHERE project_id = 'default' AND id = 'scalar-search'
  `).get();
  const planDetails = (sql, ...params) => database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((entry) => entry.detail).join("\n");
  const conversationPlan = planDetails(
    "SELECT id FROM assets WHERE project_id = ? AND archived = 0 AND conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 101",
    "default", "conversation-scalar",
  );
  const batchPlan = planDetails(
    "SELECT id FROM assets WHERE project_id = ? AND archived = 0 AND conversation_id = ? AND generation_batch = ? ORDER BY created_at DESC, id DESC LIMIT 101",
    "default", "conversation-scalar", "batch-scalar",
  );
  const mediaPlan = planDetails(
    "SELECT id FROM assets WHERE project_id = ? AND archived = 0 AND media_kind = ? ORDER BY created_at DESC, id DESC LIMIT 101",
    "default", "video",
  );
  const sourcePlan = planDetails(
    "SELECT id FROM assets WHERE project_id = ? AND archived = 0 AND source_group = ? ORDER BY created_at DESC, id DESC LIMIT 101",
    "default", "web-chatgpt",
  );
  const groupPlan = planDetails(
    "SELECT id FROM assets WHERE project_id = ? AND archived = 0 AND group_name = ? ORDER BY created_at DESC, id DESC LIMIT 101",
    "default", "Brand",
  );
  const categoryPlan = planDetails(
    "SELECT id FROM assets WHERE project_id = ? AND archived = 0 AND category = ? ORDER BY created_at DESC, id DESC LIMIT 101",
    "default", "identity",
  );
  const stylePlan = planDetails(
    "SELECT id FROM assets WHERE project_id = ? AND archived = 0 AND style = ? ORDER BY created_at DESC, id DESC LIMIT 101",
    "default", "minimal",
  );
  const favoritePlan = planDetails(
    "SELECT id FROM assets WHERE project_id = ? AND archived = 0 AND (rating > 0 OR favorite = 1) ORDER BY created_at DESC, id DESC LIMIT 101",
    "default",
  );
  const defaultPlan = planDetails(
    "SELECT id FROM assets WHERE project_id = ? AND archived = 0 ORDER BY created_at DESC, id DESC LIMIT 101",
    "default",
  );
  const namePlan = planDetails(
    "SELECT id FROM assets WHERE project_id = ? AND archived = 0 ORDER BY sort_name ASC, id ASC LIMIT 101",
    "default",
  );
  const ftsPlan = planDetails(`
    WITH ranked AS MATERIALIZED (
      SELECT a.id, a.created_at, 1 AS _search_score
      FROM asset_fts f JOIN assets a ON a.project_id = f.project_id AND a.id = f.asset_id
      WHERE a.project_id = ? AND a.archived = 0 AND f.project_id = ? AND f.content MATCH ?
    )
    SELECT * FROM ranked WHERE _search_score > 0
    ORDER BY _search_score DESC, created_at DESC, id DESC LIMIT 101
  `, "default", "default", '"launchmark"');
  database.close();
  assert.match(row.tags_text, /LaunchMark/);
  assert.match(row.business_search_text, /AuroraCampaign/);
  assert.match(row.source_search_text, /NebulaSource/);
  assert.equal(row.media_kind, "video");
  assert.equal(row.source_group, "web-chatgpt");
  assert.equal(row.conversation_id, "conversation-scalar");
  assert.equal(row.generation_batch, "batch-scalar");
  assert.match(conversationPlan, /assets_project_conversation_idx/);
  assert.match(batchPlan, /assets_project_conversation_batch_idx/);
  assert.match(mediaPlan, /assets_project_media_kind_idx/);
  assert.match(sourcePlan, /assets_project_source_group_idx/);
  assert.match(groupPlan, /assets_project_group_created_idx/);
  assert.match(categoryPlan, /assets_project_category_created_idx/);
  assert.match(stylePlan, /assets_project_style_created_idx/);
  assert.match(favoritePlan, /assets_project_favorite_created_idx/);
  assert.match(defaultPlan, /assets_project_created_idx/);
  assert.match(namePlan, /assets_project_name_idx/);
  assert.match(ftsPlan, /VIRTUAL TABLE INDEX/);
  for (const plan of [conversationPlan, batchPlan, mediaPlan, sourcePlan, groupPlan, categoryPlan, stylePlan, favoritePlan, defaultPlan, namePlan]) {
    assert.doesNotMatch(plan, /USE TEMP B-TREE FOR ORDER BY/);
  }
});

test("SQLite store keeps archive, duplicate, version, and cursor contracts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-sqlite-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir: join(root, "library") });
  t.after(() => store.close());

  const parent = await store.createAsset({ assetId: "parent", imagePath: sourcePath, prompt: "red mechanical future city", group: "Ideas", tags: ["red", "future"] });
  await assert.rejects(store.createGroup({ projectId: "default", name: "ideas" }), /Group already exists/);
  await store.updateMetadata("default", parent.id, { style: "cyberpunk", favorite: true });
  const child = await store.createAsset({ assetId: "child", imagePath: sourcePath, prompt: "red mechanical future city variant", parent_asset_id: parent.id, version_change: "color pass" });
  const duplicate = await store.duplicateAsset("default", parent.id, { assetId: "parent-copy" });
  assert.equal(duplicate.source.duplicated_from, parent.id);

  const searched = await store.listAssetPage({ projectId: "default", query: "mechanical", limit: 2 });
  assert.equal(searched.assets.length, 2);
  assert.equal(searched.page.total, 3);
  assert.ok(searched.page.nextCursor);
  assert.equal(Object.hasOwn(searched.assets[0], "recipe_snapshots"), false, "gallery rows keep heavyweight recipe relations lazy");
  assert.equal(Object.hasOwn(searched.assets[0], "child_asset_ids"), true);
  assert.deepEqual(searched.assets[0].child_asset_ids, []);
  assert.equal(Array.isArray((await store.getAsset("default", parent.id)).recipe_snapshots), true, "asset details still include recipe history");
  const secondPage = await store.listAssetPage({ projectId: "default", query: "mechanical", limit: 2, cursor: searched.page.nextCursor });
  assert.equal(secondPage.assets.length, 1);
  assert.equal(secondPage.page.total, 3, "FTS cursor pages retain the total before the cursor");
  await assert.rejects(store.listAssetPage({ projectId: "default", cursor: Buffer.from("{}").toString("base64url") }), /Invalid asset cursor/);

  const updatedParent = await store.getAsset("default", parent.id);
  assert.equal(updatedParent.style, "cyberpunk");
  assert.deepEqual(updatedParent.child_asset_ids, [child.id]);
  await store.archiveAsset("default", duplicate.id);
  const active = await store.listAssets({ projectId: "default" });
  assert.deepEqual(active.map((asset) => asset.id).sort(), [child.id, parent.id].sort());
  const activeSearch = await store.listAssetPage({ projectId: "default", query: "mechanical", limit: 2 });
  assert.equal(activeSearch.page.total, 2, "an archived match invalidates the cached FTS count");
});

test("SQLite group stats expose automatic source buckets for sidebar navigation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-source-groups-sqlite-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir: join(root, "library") });
  t.after(() => store.close());

  await store.createAsset({ assetId: "chatgpt-1", imagePath: sourcePath, sourceType: "web-chatgpt" });
  await store.createAsset({ assetId: "chatgpt-2", imagePath: sourcePath, sourceType: "web-chatgpt" });
  await store.createAsset({ assetId: "gemini-1", imagePath: sourcePath, sourceType: "web-gemini" });
  await store.createAsset({
    assetId: "chatgpt-legacy",
    imagePath: sourcePath,
    sourceType: "mosa-preserved-copy",
    source: { provider: "chatgpt", generation_tool: "web-ui" },
  });

  const stats = await store.listGroups("default");
  assert.deepEqual(stats.sourceTypes, [["web-chatgpt", 3], ["web-gemini", 1]]);
  assert.deepEqual(
    (await store.listAssets({ projectId: "default", source: "web-chatgpt" })).map((asset) => asset.id).sort(),
    ["chatgpt-1", "chatgpt-2", "chatgpt-legacy"],
  );
});

test("SQLite deleting a group clears asset assignments and its search index", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-sqlite-delete-group-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir: join(root, "library") });
  t.after(() => store.close());

  await store.createGroup({ projectId: "default", name: "Aurora" });
  const asset = await store.createAsset({ assetId: "grouped-fixture", imagePath: sourcePath, prompt: "group deletion fixture", group: "Aurora" });
  assert.equal((await store.listAssetPage({ projectId: "default", query: "Aurora", limit: 10 })).page.total, 1);

  await store.renameGroup("default", "Aurora", "Nebula");
  assert.equal((await store.getAsset("default", asset.id)).group, "Nebula");
  assert.deepEqual((await store.listGroups("default")).groups, [{ name: "Nebula", count: 1, color: "", position: 0 }]);
  assert.equal((await store.listAssetPage({ projectId: "default", query: "Nebula", limit: 10 })).page.total, 1);
  assert.equal((await store.listAssetPage({ projectId: "default", query: "Aurora", limit: 10 })).page.total, 0);
  await store.renameGroup("default", "Nebula", "Aurora");

  await store.deleteGroup("default", "Aurora");

  assert.equal((await store.getAsset("default", asset.id)).group, "");
  assert.equal((await store.listAssetPage({ projectId: "default", query: "Aurora", limit: 10 })).page.total, 0, "the removed group is no longer searchable");
  assert.deepEqual((await store.listGroups("default")).groups, []);

  await store.createGroup({ projectId: "default", name: "Aurora" });
  assert.deepEqual((await store.listGroups("default")).groups, [{ name: "Aurora", count: 0, color: "", position: 0 }]);
});

test("SQLite group deletion moves every asset in the group to Trash and keeps them restorable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-sqlite-delete-group-assets-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir: join(root, "library") });
  t.after(() => store.close());

  await store.createGroup({ projectId: "default", name: "Disposable" });
  const first = await store.createAsset({ assetId: "group-delete-a", imagePath: sourcePath, group: "Disposable" });
  const second = await store.createAsset({ assetId: "group-delete-b", imagePath: sourcePath, group: "Disposable" });

  const result = await store.deleteGroup("default", "Disposable", { deleteAssets: true });

  assert.equal(result.deletedAssets, 2);
  assert.equal((await store.listAssetPage({ projectId: "default", limit: 10 })).page.total, 0);
  assert.deepEqual((await store.listAssetPage({ projectId: "default", trash: true, limit: 10 })).assets.map((item) => item.id).sort(), [first.id, second.id].sort());
  assert.equal((await store.listAutomaticIngestSuppressions("default")).length, 1,
    "group Trash moves suppress automatic re-import of the deleted content");
  assert.deepEqual((await store.listGroups("default")).groups, []);
  await store.restoreAsset("default", first.id);
  assert.equal((await store.getAsset("default", first.id)).group, "Disposable");
  assert.deepEqual((await store.listGroups("default")).groups, [{ name: "Disposable", count: 1, color: "", position: 0 }]);
});

test("SQLite group Trash move is atomic metadata work and does not touch managed files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-sqlite-delete-group-atomic-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const libraryDir = join(root, "library");
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => store.close());

  await store.createGroup({ projectId: "default", name: "Atomic" });
  const first = await store.createAsset({ assetId: "group-atomic-a", imagePath: sourcePath, group: "Atomic" });
  const second = await store.createAsset({ assetId: "group-atomic-b", imagePath: sourcePath, group: "Atomic" });

  // Trash is a logical state transition. Even an unavailable managed path must
  // not turn the operation into a partial hard delete.
  const inspect = new Database(sqliteDatabasePath(libraryDir));
  inspect.prepare("UPDATE assets SET original_path = ? WHERE project_id = ? AND id = ?")
    .run(sourcePath, "default", second.id);
  inspect.close();

  const result = await store.deleteGroup("default", "Atomic", { deleteAssets: true });

  assert.equal(result.deletedAssets, 2);
  assert.equal((await store.listAssetPage({ projectId: "default", limit: 10 })).page.total, 0);
  assert.equal((await store.listAssetPage({ projectId: "default", trash: true, limit: 10 })).page.total, 2);
  await stat(first.image_path);
});

test("SQLite deleteAsset is a soft-delete and permanent deletion stages files before removing the row", async (t) => {
  const source = await readFile(new URL("../lib/sqlite-asset-store.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async deleteAsset(projectId, assetId)");
  const end = source.indexOf("async restoreAsset(projectId, assetId)", start);
  assert.ok(start > -1 && end > start, "deleteAsset is present");
  const body = source.slice(start, end);
  assert.match(body, /UPDATE assets SET deleted_at/);
  assert.doesNotMatch(body, /unlink\(/);
  const permanentStart = source.indexOf("async permanentlyDeleteAsset(projectId, assetId)");
  const permanentEnd = source.indexOf("async purgeExpiredTrash", permanentStart);
  const permanentBody = source.slice(permanentStart, permanentEnd);
  assert.match(permanentBody, /stageFilesForPermanentDeletion/);
  assert.match(permanentBody, /await staged\.rollback\(\)/);
  assert.match(permanentBody, /await staged\.commit\(\)/);

  const root = await mkdtemp(join(tmpdir(), "mosa-sqlite-delete-asset-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir: join(root, "library") });
  t.after(() => store.close());

  const asset = await store.createAsset({ assetId: "delete-row-first", imagePath: sourcePath, prompt: "delete order fixture" });
  await store.deleteAsset("default", asset.id);
  assert.ok((await store.getAsset("default", asset.id)).deleted_at);
  await stat(asset.image_path);
});

test("SQLite recipe snapshots change only with generation inputs and remain immutable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-recipes-sqlite-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({
    projectRoot,
    managerDir: join(projectRoot, "mosa"),
    libraryDir: join(root, "library"),
  });
  t.after(() => store.close());

  const asset = await store.createAsset({
    assetId: "recipe-fixture",
    imagePath: sourcePath,
    prompt: "A red city at dusk",
    negative_prompt: "text, watermark",
    references: [{ asset_id: "moodboard", sha256: "b".repeat(64), role: "palette" }],
    source: {
      generation_tool: "imagegen",
      model: "gpt-image-1",
      prompt_status: "generation-tool-prompt",
      codex_task_id: "task-1",
    },
  });
  const initialHistory = await store.getRecipeSnapshotHistory("default", asset.id);
  assert.equal(initialHistory.snapshots.length, 1);
  // The SQLite twin of the JSON pinned shape. SQLite returns snapshot rows
  // directly rather than through ensureRecipeSnapshots, so without read-time
  // normalisation a row would come back with no rights fields at all and the
  // two stores would disagree on the backend production actually uses.
  assert.deepEqual(initialHistory.snapshots[0].references, [{
    asset_id: "moodboard",
    sha256: "b".repeat(64),
    role: "palette",
    scope: [],
    applied: true,
    allowed_uses: [],
    forbidden_uses: [],
    rights: { copyright: "unknown", portrait_consent: "unknown", redistribution: "unknown", attribution: "" },
  }]);
  const frozenInitial = structuredClone(initialHistory.snapshots[0]);

  await store.updateMetadata("default", asset.id, { rating: 5, group: "Keepers" });
  assert.equal((await store.getRecipeSnapshotHistory("default", asset.id)).snapshots.length, 1);

  const updated = await store.updateMetadata("default", asset.id, {
    prompt: "A blue city at dawn",
    source: { model: "gpt-image-2" },
    recipe_change_summary: "Changed palette, time, and model",
  });
  const updatedHistory = await store.getRecipeSnapshotHistory("default", asset.id);
  assert.equal(updated.source.generation_tool, "imagegen");
  assert.equal(updated.source.codex_task_id, "task-1");
  assert.equal(updatedHistory.snapshots.length, 2);
  assert.deepEqual(updatedHistory.snapshots[0], frozenInitial);
  assert.equal(updatedHistory.snapshots[1].effective_prompt, "A blue city at dawn");
  assert.equal(updatedHistory.snapshots[1].model, "gpt-image-2");
  assert.equal(updatedHistory.snapshots[1].change_summary, "Changed palette, time, and model");
  assert.equal(updatedHistory.active_snapshot_id, updatedHistory.snapshots[1].snapshot_id);
  assert.deepEqual(updated.recipe_snapshots, updatedHistory.snapshots);
});

test("SQLite carries reference rights recorded after archival into the stored snapshot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-recipe-rights-sqlite-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({
    projectRoot,
    managerDir: join(projectRoot, "mosa"),
    libraryDir: join(root, "library"),
  });
  t.after(() => store.close());

  const asset = await store.createAsset({
    assetId: "rights-fixture",
    imagePath: sourcePath,
    prompt: "A quiet window portrait",
    references: [{ asset_id: "portrait-ref", sha256: "c".repeat(64), role: "identity" }],
  });
  const before = await store.getRecipeSnapshotHistory("default", asset.id);
  assert.equal(before.snapshots[0].references[0].rights.portrait_consent, "unknown");

  // Recording a refusal is digest-inert, so it must append nothing and still
  // reach the stored row. The former INSERT OR IGNORE silently dropped it.
  await store.updateMetadata("default", asset.id, {
    references: [{
      asset_id: "portrait-ref",
      sha256: "c".repeat(64),
      role: "identity",
      forbidden_uses: ["composition"],
      rights: { copyright: "third-party", portrait_consent: "denied", redistribution: "forbidden", attribution: "Studio" },
    }],
  });

  const after = await store.getRecipeSnapshotHistory("default", asset.id);
  assert.equal(after.snapshots.length, 1, "a rights annotation is not a new recipe");
  assert.equal(after.snapshots[0].recipe_digest, before.snapshots[0].recipe_digest);
  assert.equal(after.snapshots[0].references[0].rights.portrait_consent, "denied");
  assert.equal(after.snapshots[0].references[0].rights.attribution, "Studio");
  assert.deepEqual(after.snapshots[0].references[0].forbidden_uses, ["composition"]);
});

test("SQLite recent filter and counter share the JSON store's date semantics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-sqlite-recent-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const now = new Date();
  const nowIso = now.toISOString();
  // Legacy created_at values, in the formats ECMA-262 guarantees Date.parse accepts.
  const legacyCreatedAt = {
    "legacy-old-rfc": "Sat, 01 Jan 2000 00:00:00 GMT",   // parseable, ancient, sorts ABOVE an ISO cutoff
    "legacy-recent-rfc": now.toUTCString(),               // parseable, recent
    "legacy-recent-expanded-iso": `+00${nowIso}`,         // parseable, recent, sorts BELOW an ISO cutoff
    "legacy-empty": "",                                   // unusable
    "legacy-invalid": "not-a-real-date",                  // unusable
  };
  const assetIds = ["valid-recent-iso", ...Object.keys(legacyCreatedAt)];

  // ---- SQLite store -------------------------------------------------------------------------
  const sqliteProjectRoot = join(root, "sqlite-project");
  const sqliteSourcePath = join(sqliteProjectRoot, "generated-images", "fixture.png");
  await mkdir(join(sqliteProjectRoot, "generated-images"), { recursive: true });
  await writeFile(sqliteSourcePath, ONE_PIXEL_PNG);
  const libraryDir = join(root, "library");
  const openStores = [];
  const openStore = () => {
    const opened = createSqliteAssetStore({ projectRoot: sqliteProjectRoot, managerDir: join(sqliteProjectRoot, "mosa"), libraryDir });
    openStores.push(opened);
    return opened;
  };
  t.after(() => { for (const opened of openStores) { try { opened.close(); } catch { /* already closed */ } } });
  const seedStore = openStore();

  for (const assetId of assetIds) {
    await seedStore.createAsset({ assetId, imagePath: sqliteSourcePath, created_at: nowIso });
  }
  seedStore.close();

  // created_at is declared TEXT NOT NULL, so SQL NULL can never be stored — but the column carries
  // no format validation, so writing legacy text straight into it, and clearing the derived epoch,
  // reproduces exactly what a library written by an older build looks like.
  const database = new Database(sqliteDatabasePath(libraryDir));
  const setCreatedAt = database.prepare("UPDATE assets SET created_at = ?, created_at_epoch = ? WHERE project_id = 'default' AND id = ?");
  for (const [assetId, createdAt] of Object.entries(legacyCreatedAt)) {
    // Include both missing and non-NULL stale derived values. Startup repair must not trust an
    // epoch merely because an older or external writer happened to leave one populated.
    const staleEpoch = assetId === "legacy-old-rfc" || assetId === "legacy-invalid"
      ? Date.parse(nowIso)
      : null;
    assert.equal(setCreatedAt.run(createdAt, staleEpoch, assetId).changes, 1, `${assetId} row must be rewritten`);
  }
  database.close();

  // Reopening repairs the derived column, exactly as upgrading from an older build would.
  const store = openStore();
  const inspect = new Database(sqliteDatabasePath(libraryDir), { readonly: true });
  t.after(() => { try { inspect.close(); } catch { /* already closed */ } });
  const repairedRows = Object.fromEntries(inspect.prepare("SELECT id, created_at, created_at_epoch FROM assets WHERE project_id = 'default'").all().map((row) => [row.id, row]));
  assert.equal(repairedRows["legacy-old-rfc"].created_at, "2000-01-01T00:00:00.000Z", "parseable legacy text is canonicalised on open");
  assert.equal(repairedRows["legacy-old-rfc"].created_at_epoch, Date.parse("2000-01-01T00:00:00.000Z"), "a stale non-NULL epoch is repaired");
  assert.equal(repairedRows["legacy-empty"].created_at_epoch, null, "an unusable date stays NULL");
  assert.equal(repairedRows["legacy-invalid"].created_at_epoch, null, "an unusable date clears a stale non-NULL epoch");
  assert.equal(
    inspect.prepare("SELECT created_at FROM asset_versions WHERE project_id = ? AND asset_id = ?").get("default", "legacy-old-rfc").created_at,
    "2000-01-01T00:00:00.000Z",
    "startup repair also keeps version ordering on the canonical timestamp",
  );
  const plan = inspect.prepare("EXPLAIN QUERY PLAN SELECT a.id FROM assets a WHERE a.project_id = ? AND a.archived = 0 AND a.created_at_epoch >= ?").all("default", 0);
  assert.ok(plan.map((row) => row.detail).join(" | ").includes("assets_project_epoch_idx"), "the recent filter must use the derived index");

  const sqliteAll = await store.listAssets({ projectId: "default" });
  assert.equal(sqliteAll.length, assetIds.length, "every legacy row is still listed without filters");
  const sqliteRecent = await store.listAssets({ projectId: "default", recent: true });
  const sqliteRecentIds = sqliteRecent.map((asset) => asset.id).sort();
  assert.deepEqual(sqliteRecentIds, ["legacy-recent-expanded-iso", "legacy-recent-rfc", "valid-recent-iso"]);

  const sqliteGroups = await store.listGroups("default");
  assert.equal(sqliteGroups.total, assetIds.length);
  assert.equal(sqliteGroups.recent, sqliteRecent.length, "the counter must agree with the filter");
  assert.equal(sqliteGroups.recent, 3);

  // An explicit cutoff is honoured here too, and only the unparseable values stay out.
  const widened = await store.listAssets({ projectId: "default", recent: true, recentSince: Date.parse("1999-12-31T00:00:00.000Z") });
  assert.deepEqual(widened.map((asset) => asset.id).sort(), [
    "legacy-old-rfc",
    "legacy-recent-expanded-iso",
    "legacy-recent-rfc",
    "valid-recent-iso",
  ]);

  // ---- JSON store, same data ----------------------------------------------------------------
  const jsonProjectRoot = join(root, "json-project");
  const jsonManagerDir = join(jsonProjectRoot, "mosa");
  const jsonSourcePath = join(jsonProjectRoot, "generated-images", "fixture.png");
  await mkdir(join(jsonProjectRoot, "generated-images"), { recursive: true });
  await writeFile(jsonSourcePath, ONE_PIXEL_PNG);
  const jsonStore = createAssetStore({ projectRoot: jsonProjectRoot, managerDir: jsonManagerDir });
  assert.equal(jsonStore.storageKind, "json");

  for (const assetId of assetIds) {
    await jsonStore.createAsset({ assetId, imagePath: jsonSourcePath, created_at: nowIso });
  }
  const jsonMetadataDir = join(jsonManagerDir, "assets", "default", "metadata");
  for (const [assetId, createdAt] of Object.entries(legacyCreatedAt)) {
    const filePath = join(jsonMetadataDir, `${assetId}.json`);
    const metadata = JSON.parse(await readFile(filePath, "utf8"));
    metadata.created_at = createdAt;
    await writeFile(filePath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  }

  // ---- Both stores must answer identically ---------------------------------------------------
  const jsonRecent = await jsonStore.listAssets({ projectId: "default", recent: true });
  assert.deepEqual(jsonRecent.map((asset) => asset.id).sort(), sqliteRecentIds, "both stores select the same assets");
  const jsonGroups = await jsonStore.listGroups("default");
  assert.equal(jsonGroups.recent, sqliteGroups.recent, "both stores count the same number of recent assets");
});

test("SQLite content-hash lookup uses its index and matches the JSON store's choice", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-sqlite-content-hash-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "project");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const libraryDir = join(root, "library");
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => { try { store.close(); } catch { /* already closed */ } });

  const oldest = await store.createAsset({ assetId: "same-oldest", imagePath: sourcePath, created_at: "2026-01-01T00:00:00.000Z" });
  await store.createAsset({ assetId: "same-newest", imagePath: sourcePath, created_at: "2026-03-01T00:00:00.000Z" });
  await store.createAsset({ assetId: "same-archived", imagePath: sourcePath, created_at: "2026-06-01T00:00:00.000Z" });
  await store.archiveAsset("default", "same-archived");

  const hash = oldest.source.content_sha256;
  assert.match(hash, /^[a-f0-9]{64}$/);

  // Simulate a legacy writer after this store was opened. Raw TEXT ordering would put this
  // ancient RFC date above every ISO date and choose the wrong duplicate.
  const rewrite = new Database(sqliteDatabasePath(libraryDir));
  rewrite.prepare("UPDATE assets SET created_at = ?, created_at_epoch = ? WHERE project_id = ? AND id = ?")
    .run("Sat, 01 Jan 2000 00:00:00 GMT", Date.parse("2000-01-01T00:00:00.000Z"), "default", "same-oldest");
  rewrite.close();

  // Same tie-break as the JSON store: active before archived, then newest.
  const found = await store.findAssetByContentHash("default", hash);
  assert.equal(found.id, "same-newest");
  assert.deepEqual(found, await store.getAsset("default", "same-newest"));
  assert.equal((await store.findAssetBySourcePath("default", sourcePath)).id, "same-newest");

  // Any normal metadata edit heals both stored representations of a legacy created_at value.
  const healed = await store.updateMetadata("default", "same-oldest", { rating: 1 });
  assert.equal(healed.created_at, "2000-01-01T00:00:00.000Z");
  const healedRow = new Database(sqliteDatabasePath(libraryDir), { readonly: true });
  assert.deepEqual(
    healedRow.prepare("SELECT created_at, created_at_epoch FROM assets WHERE project_id = ? AND id = ?").get("default", "same-oldest"),
    { created_at: "2000-01-01T00:00:00.000Z", created_at_epoch: Date.parse("2000-01-01T00:00:00.000Z") },
  );
  assert.equal(
    healedRow.prepare("SELECT created_at FROM asset_versions WHERE project_id = ? AND asset_id = ?").get("default", "same-oldest").created_at,
    "2000-01-01T00:00:00.000Z",
    "the version-order copy of created_at heals with the asset row",
  );
  healedRow.close();

  await store.archiveAsset("default", "same-newest");
  await store.archiveAsset("default", "same-oldest");
  assert.equal((await store.findAssetByContentHash("default", hash)).id, "same-archived");

  assert.equal(await store.findAssetByContentHash("default", "0".repeat(64)), null);
  for (const empty of ["", null, undefined]) {
    assert.equal(await store.findAssetByContentHash("default", empty), null);
  }

  // The point of the method is that it is served by the hash index rather than by walking the
  // project. Without the INDEXED BY clause the planner picks assets_project_created_idx, because
  // that index also satisfies the ORDER BY, and scans every row — so assert both directions.
  const inspect = new Database(sqliteDatabasePath(libraryDir), { readonly: true });
  t.after(() => { try { inspect.close(); } catch { /* already closed */ } });
  inspect.function("mosa_normalize_created_at", { deterministic: true }, (value) => normalizeCreatedAt(value, value));
  const planFor = (sql) => inspect.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("default", hash).map((row) => row.detail).join(" | ");
  const plan = planFor(`SELECT * FROM assets INDEXED BY assets_project_hash_idx
    WHERE project_id = ? AND content_sha256 = ? ORDER BY archived ASC, mosa_normalize_created_at(created_at) DESC, id DESC LIMIT 1`);
  assert.ok(plan.includes("assets_project_hash_idx"), `expected the content-hash index to be used, got: ${plan}`);
  assert.equal(plan.includes("assets_project_created_idx"), false, `the project-order index must not be walked, got: ${plan}`);
  const pathPlan = inspect.prepare(`EXPLAIN QUERY PLAN SELECT * FROM assets INDEXED BY assets_project_source_path_idx
    WHERE project_id = ? AND source_path = ? ORDER BY archived ASC, mosa_normalize_created_at(created_at) DESC, id DESC LIMIT 1`)
    .all("default", sourcePath).map((row) => row.detail).join(" | ");
  assert.ok(pathPlan.includes("assets_project_source_path_idx"), `expected the source-path index to be used, got: ${pathPlan}`);
});

test("SQLite pixel-hash lookup ignores obsolete hash versions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-sqlite-pixel-version-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const sourcePath = join(projectRoot, "generated-images", "pixel.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toFile(sourcePath);
  const libraryDir = join(root, "library");
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => { try { store.close(); } catch { /* already closed */ } });

  const pixelHash = await safePixelDigest(sourcePath);
  const asset = await store.createAsset({
    assetId: "pixel-version",
    imagePath: sourcePath,
    source: { pixel_sha256: pixelHash, pixel_hash_version: PIXEL_HASH_VERSION },
  });
  assert.ok(pixelHash);
  assert.equal((await store.findAssetByPixelHash("default", pixelHash)).id, asset.id);

  const rewrite = new Database(sqliteDatabasePath(libraryDir));
  const row = rewrite.prepare("SELECT source_json FROM assets WHERE project_id = ? AND id = ?").get("default", asset.id);
  const source = JSON.parse(row.source_json);
  source.pixel_hash_version = "legacy-pixel-v0";
  rewrite.prepare("UPDATE assets SET source_json = ? WHERE project_id = ? AND id = ?").run(JSON.stringify(source), "default", asset.id);
  rewrite.close();

  assert.equal(await store.findAssetByPixelHash("default", pixelHash), null);
});

test("runtime storage selection cannot bypass migration completion", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-storage-selection-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const libraryDir = join(root, "library");

  const setup = createSqliteAssetStore({ projectRoot, managerDir, libraryDir });
  await setup.setMigrationState("migrating", { verified: false });
  setup.close();

  const beforeMigration = createAssetStore({ projectRoot, managerDir, libraryDir, storage: "sqlite" });
  assert.equal(beforeMigration.storageKind, "json");

  const completed = createSqliteAssetStore({ projectRoot, managerDir, libraryDir });
  await completed.setMigrationState("completed", { verified: true });
  completed.close();
  const afterMigration = createAssetStore({ projectRoot, managerDir, libraryDir, storage: "json" });
  assert.equal(afterMigration.storageKind, "sqlite");
  afterMigration.close();
});

test("SQLite schema v1 upgrades once without changing completed migration state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-schema-upgrade-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  const databasePath = join(libraryDir, "mosa.db");
  const originalTimestamp = "2026-01-01T00:00:00.000Z";
  await mkdir(libraryDir, { recursive: true });

  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE library_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
  `);
  legacy.prepare("INSERT INTO library_meta (key, value, updated_at) VALUES ('schema_version', '1', ?)").run(originalTimestamp);
  legacy.prepare("INSERT INTO library_meta (key, value, updated_at) VALUES ('migration_state', 'completed', ?)").run(originalTimestamp);
  legacy.prepare("INSERT INTO library_meta (key, value, updated_at) VALUES ('migration_details', '{\"verified\":true}', ?)").run(originalTimestamp);
  legacy.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(originalTimestamp);
  legacy.close();

  createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir }).close();
  const upgraded = new Database(databasePath, { readonly: true });
  const schemaAfterUpgrade = upgraded.prepare("SELECT value, updated_at FROM library_meta WHERE key = 'schema_version'").get();
  const migrationState = upgraded.prepare("SELECT value, updated_at FROM library_meta WHERE key = 'migration_state'").get();
  const migrationDetails = upgraded.prepare("SELECT value, updated_at FROM library_meta WHERE key = 'migration_details'").get();
  const migrationVersions = upgraded.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => row.version);
  const parentIndex = upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'asset_versions_parent_idx'").get();
  const pixelColumn = upgraded.prepare("SELECT name FROM pragma_table_info('assets') WHERE name = 'pixel_sha256'").get();
  const pixelIndex = upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'assets_project_pixel_hash_idx'").get();
  upgraded.close();

  assert.equal(schemaAfterUpgrade.value, String(CURRENT_SCHEMA_VERSION));
  assert.notEqual(schemaAfterUpgrade.updated_at, originalTimestamp);
  assert.deepEqual(migrationState, { value: "completed", updated_at: originalTimestamp });
  assert.deepEqual(migrationDetails, { value: '{"verified":true}', updated_at: originalTimestamp });
  assert.deepEqual(migrationVersions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 17]);
  assert.equal(parentIndex.name, "asset_versions_parent_idx");
  assert.equal(pixelColumn.name, "pixel_sha256");
  assert.equal(pixelIndex.name, "assets_project_pixel_hash_idx");

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir }).close();
  const reopened = new Database(databasePath, { readonly: true });
  assert.deepEqual(
    reopened.prepare("SELECT value, updated_at FROM library_meta WHERE key = 'schema_version'").get(),
    schemaAfterUpgrade,
  );
  reopened.close();
});

test("SQLite schema v5 upgrades suppression identity to include pixel hash version", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-schema-v5-suppression-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  const databasePath = join(libraryDir, "mosa.db");
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  await store.recordAutomaticIngestSuppression("default", {
    pixel_sha256: "d".repeat(64),
    pixel_hash_version: "opaque-static-v1",
    deleted_at: "2026-08-20T00:00:00.000Z",
  });
  store.close();

  const legacy = new Database(databasePath);
  legacy.exec(`
    DROP INDEX automatic_suppressions_project_content_idx;
    DROP INDEX automatic_suppressions_project_pixel_idx;
    DROP INDEX automatic_suppressions_project_deleted_idx;
    ALTER TABLE automatic_ingest_suppressions RENAME TO automatic_ingest_suppressions_v6;
    CREATE TABLE automatic_ingest_suppressions (
      project_id TEXT NOT NULL,
      content_sha256 TEXT NOT NULL DEFAULT '',
      pixel_sha256 TEXT NOT NULL DEFAULT '',
      pixel_hash_version TEXT NOT NULL DEFAULT '',
      deleted_at TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'user-deleted',
      PRIMARY KEY (project_id, content_sha256, pixel_sha256),
      CHECK (content_sha256 != '' OR pixel_sha256 != '')
    );
    INSERT INTO automatic_ingest_suppressions
      SELECT project_id, content_sha256, pixel_sha256, pixel_hash_version, deleted_at, reason
      FROM automatic_ingest_suppressions_v6;
    DROP TABLE automatic_ingest_suppressions_v6;
    CREATE INDEX automatic_suppressions_project_content_idx ON automatic_ingest_suppressions(project_id, content_sha256, deleted_at DESC);
    CREATE INDEX automatic_suppressions_project_pixel_idx ON automatic_ingest_suppressions(project_id, pixel_sha256, deleted_at DESC);
    CREATE INDEX automatic_suppressions_project_deleted_idx ON automatic_ingest_suppressions(project_id, deleted_at DESC, content_sha256, pixel_sha256);
    DELETE FROM schema_migrations WHERE version = 6;
    UPDATE library_meta SET value = '5' WHERE key = 'schema_version';
  `);
  legacy.close();

  const upgradedStore = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  upgradedStore.close();
  const upgraded = new Database(databasePath, { readonly: true });
  const primaryKey = upgraded.prepare("SELECT name FROM pragma_table_info('automatic_ingest_suppressions') WHERE pk > 0 ORDER BY pk").all().map((row) => row.name);
  const row = upgraded.prepare("SELECT pixel_sha256, pixel_hash_version, deleted_at FROM automatic_ingest_suppressions").get();
  const schemaVersion = upgraded.prepare("SELECT value FROM library_meta WHERE key = 'schema_version'").get().value;
  upgraded.close();

  assert.deepEqual(primaryKey, ["project_id", "content_sha256", "pixel_sha256", "pixel_hash_version"]);
  assert.deepEqual(row, {
    pixel_sha256: "d".repeat(64),
    pixel_hash_version: "opaque-static-v1",
    deleted_at: "2026-08-20T00:00:00.000Z",
  });
  assert.equal(schemaVersion, String(CURRENT_SCHEMA_VERSION));
});

test("SQLite suppression migration recovers an interrupted legacy-table rebuild", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-schema-suppression-recovery-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  const databasePath = join(libraryDir, "mosa.db");
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  await store.recordAutomaticIngestSuppression("default", {
    pixel_sha256: "e".repeat(64),
    pixel_hash_version: "recovery-v1",
    deleted_at: "2026-09-01T00:00:00.000Z",
  });
  store.close();

  const interrupted = new Database(databasePath);
  interrupted.exec(`
    DROP INDEX automatic_suppressions_project_content_idx;
    DROP INDEX automatic_suppressions_project_pixel_idx;
    DROP INDEX automatic_suppressions_project_deleted_idx;
    ALTER TABLE automatic_ingest_suppressions RENAME TO automatic_ingest_suppressions_legacy;
    CREATE TABLE automatic_ingest_suppressions (
      project_id TEXT NOT NULL,
      content_sha256 TEXT NOT NULL DEFAULT '',
      pixel_sha256 TEXT NOT NULL DEFAULT '',
      pixel_hash_version TEXT NOT NULL DEFAULT '',
      deleted_at TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'user-deleted',
      PRIMARY KEY (project_id, content_sha256, pixel_sha256, pixel_hash_version),
      CHECK (content_sha256 != '' OR pixel_sha256 != '')
    );
  `);
  interrupted.close();

  createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir }).close();
  const recovered = new Database(databasePath, { readonly: true });
  const suppression = recovered.prepare("SELECT pixel_sha256, pixel_hash_version FROM automatic_ingest_suppressions").get();
  const legacyTable = recovered.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'automatic_ingest_suppressions_legacy'").get();
  const indexes = recovered.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'automatic_suppressions_project_%' ORDER BY name").all().map((row) => row.name);
  recovered.close();

  assert.deepEqual(suppression, { pixel_sha256: "e".repeat(64), pixel_hash_version: "recovery-v1" });
  assert.equal(legacyTable, undefined);
  assert.deepEqual(indexes, [
    "automatic_suppressions_project_content_idx",
    "automatic_suppressions_project_deleted_idx",
    "automatic_suppressions_project_pixel_idx",
  ]);
});

test("SQLite schema v7 backfills conversation and generation-batch scalars", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-schema-v7-query-scalars-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);

  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  await store.createAsset({
    assetId: "legacy-query-scalars",
    imagePath: sourcePath,
    source: { type: "web-chatgpt", conversation_id: "legacy-conversation", message_id: "legacy-batch" },
  });
  store.close();

  const databasePath = sqliteDatabasePath(libraryDir);
  const legacy = new Database(databasePath);
  legacy.exec(`
    UPDATE assets SET conversation_id = '', generation_batch = '' WHERE id = 'legacy-query-scalars';
    DELETE FROM schema_migrations WHERE version = 8;
    UPDATE library_meta SET value = '7' WHERE key = 'schema_version';
  `);
  legacy.close();

  const upgraded = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  assert.deepEqual(
    (await upgraded.listAssets({ projectId: "default", conversation: "legacy-conversation", generationBatch: "legacy-batch" })).map((asset) => asset.id),
    ["legacy-query-scalars"],
  );
  upgraded.close();

  const inspected = new Database(databasePath, { readonly: true });
  const scalars = inspected.prepare("SELECT conversation_id, generation_batch FROM assets WHERE id = 'legacy-query-scalars'").get();
  const schemaVersion = inspected.prepare("SELECT value FROM library_meta WHERE key = 'schema_version'").get().value;
  const migrations = inspected.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => row.version);
  inspected.close();
  assert.deepEqual(scalars, { conversation_id: "legacy-conversation", generation_batch: "legacy-batch" });
  assert.equal(schemaVersion, String(CURRENT_SCHEMA_VERSION));
  assert.ok(migrations.includes(8));
  assert.ok(migrations.includes(9));
  assert.ok(migrations.includes(10));
  assert.ok(migrations.includes(11));
  assert.ok(migrations.includes(12));
  assert.ok(migrations.includes(13));
});

test("SQLite upgrades a legacy assets table before creating the source-path index", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-schema-source-path-order-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);

  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  await store.createAsset({
    assetId: "legacy-source-path",
    imagePath: sourcePath,
    source: { type: "web-chatgpt", path: sourcePath },
  });
  store.close();

  const databasePath = sqliteDatabasePath(libraryDir);
  const legacy = new Database(databasePath);
  legacy.exec(`
    DROP INDEX IF EXISTS assets_project_source_path_idx;
    ALTER TABLE assets DROP COLUMN source_path;
    UPDATE library_meta SET value = '11' WHERE key = 'schema_version';
    DELETE FROM schema_migrations WHERE version = 12;
  `);
  legacy.close();

  const upgraded = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  const restored = await upgraded.findAssetBySourcePath("default", sourcePath);
  upgraded.close();

  const inspected = new Database(databasePath, { readonly: true });
  const columns = inspected.prepare("PRAGMA table_info(assets)").all().map((row) => row.name);
  const indexes = inspected.prepare("PRAGMA index_list(assets)").all().map((row) => row.name);
  inspected.close();
  assert.ok(columns.includes("source_path"));
  assert.ok(indexes.includes("assets_project_source_path_idx"));
  assert.equal(restored?.id, "legacy-source-path");
});

test("SQLite schema v2 migration backfills current recipes for existing assets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-recipe-backfill-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  await store.createAsset({
    assetId: "legacy-recipe",
    imagePath: sourcePath,
    prompt: "Prompt retained from schema v2",
    source: { model: "legacy-model" },
  });
  store.close();

  const legacy = new Database(join(libraryDir, "mosa.db"));
  legacy.exec(`
    DROP TABLE recipe_snapshots;
    DELETE FROM schema_migrations WHERE version = 3;
    UPDATE library_meta SET value = '2' WHERE key = 'schema_version';
  `);
  legacy.close();

  const upgraded = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  const history = await upgraded.getRecipeSnapshotHistory("default", "legacy-recipe");
  upgraded.close();
  assert.equal(history.snapshots.length, 1);
  assert.equal(history.snapshots[0].effective_prompt, "Prompt retained from schema v2");
  assert.equal(history.snapshots[0].model, "legacy-model");
  assert.equal(history.snapshots[0].change_summary, "Backfilled current recipe");
  assert.equal(history.active_snapshot_id, history.snapshots[0].snapshot_id);
});

test("SQLite refuses to downgrade a newer schema", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-schema-future-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  const databasePath = join(libraryDir, "mosa.db");
  await mkdir(libraryDir, { recursive: true });
  const future = new Database(databasePath);
  future.exec(`
    CREATE TABLE library_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
  `);
  future.prepare("INSERT INTO library_meta (key, value, updated_at) VALUES ('schema_version', ?, 'future')")
    .run(String(CURRENT_SCHEMA_VERSION + 1));
  future.close();

  assert.throws(
    () => createSqliteAssetStore({ projectRoot: root, managerDir: join(root, "mosa"), libraryDir }),
    new RegExp(`schema version ${CURRENT_SCHEMA_VERSION + 1} is newer than supported version ${CURRENT_SCHEMA_VERSION}`),
  );
  const inspected = new Database(databasePath, { readonly: true });
  assert.deepEqual(inspected.prepare("SELECT value, updated_at FROM library_meta WHERE key = 'schema_version'").get(), { value: String(CURRENT_SCHEMA_VERSION + 1), updated_at: "future" });
  inspected.close();
});

test("concurrent SQLite creates with the same ID cannot overwrite the winner", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-sqlite-create-race-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const generatedDir = join(projectRoot, "generated-images");
  const firstPath = join(generatedDir, "first.png");
  const secondPath = join(generatedDir, "second.png");
  await mkdir(generatedDir, { recursive: true });
  await Promise.all([
    sharp({ create: { width: 4, height: 4, channels: 4, background: "#c33c32" } }).png().toFile(firstPath),
    sharp({ create: { width: 4, height: 4, channels: 4, background: "#2e6db4" } }).png().toFile(secondPath),
  ]);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir: join(root, "library") });
  t.after(() => store.close());

  const results = await Promise.allSettled([
    store.createAsset({ assetId: "same-id", imagePath: firstPath, prompt: "first" }),
    store.createAsset({ assetId: "same-id", imagePath: secondPath, prompt: "second" }),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "ASSET_ALREADY_EXISTS");

  const winner = fulfilled[0].value;
  const stored = await store.getAsset("default", "same-id");
  assert.equal(stored.prompt, winner.prompt);
  assert.equal(stored.source.path, winner.source.path);
  assert.deepEqual(await readFile(stored.image_path), await readFile(winner.source.path));
});

test("derivative job writes WebP previews without changing the original", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivatives-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const sourcePath = join(projectRoot, "generated-images", "image.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await sharp({ create: { width: 1200, height: 800, channels: 4, background: { r: 12, g: 25, b: 40, alpha: 1 } } }).png().toFile(sourcePath);
  const before = await readFile(sourcePath);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir: join(root, "library") });
  t.after(() => store.close());

  const asset = await store.createAsset({ assetId: "image", imagePath: sourcePath, prompt: "A derivative test" });
  const job = await store.claimDerivativeJob();
  const result = await processDerivativeJob(store, job);
  assert.equal(result.ok, true);
  const updated = await store.getAsset("default", asset.id);
  assert.match(updated.thumbnail_url, /thumbnails\/image\.webp$/);
  assert.match(updated.medium_url, /mediums\/image\.webp$/);
  assert.match(updated.preview_url, /previews\/image\.webp$/);
  assert.equal(updated.business_fields.width, 1200);
  assert.equal(updated.business_fields.height, 800);
  const [thumbnail, medium, preview] = await Promise.all([
    sharp(updated.thumbnail_path).metadata(),
    sharp(updated.medium_path).metadata(),
    sharp(updated.preview_path).metadata(),
  ]);
  assert.equal(thumbnail.format, "webp");
  assert.ok(thumbnail.width <= 400 && thumbnail.height <= 400);
  assert.equal(medium.format, "webp");
  assert.ok(medium.width <= 960 && medium.height <= 960);
  assert.equal(preview.format, "webp");
  assert.ok(preview.width <= 1600 && preview.height <= 1600);
  assert.deepEqual(await readFile(sourcePath), before);

  const worker = createDerivativeWorker({ store });
  worker.start();
  worker.stop();
});

test("failed derivative jobs retry with backoff and stop after three attempts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-retry-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const sourcePath = join(projectRoot, "generated-images", "broken.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, Buffer.from("not-an-image"));
  const libraryDir = join(root, "library");
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => store.close());

  await store.createAsset({ assetId: "broken", imagePath: sourcePath });
  const first = await store.claimDerivativeJob();
  assert.ok(first);
  const failed = await processDerivativeJob(store, first);
  assert.equal(failed.ok, false);
  assert.equal(await store.claimDerivativeJob(), null, "failed work must respect the retry backoff");

  const database = new Database(sqliteDatabasePath(libraryDir));
  database.prepare("UPDATE derivative_jobs SET updated_at = ? WHERE project_id = 'default' AND asset_id = 'broken'")
    .run("2000-01-01T00:00:00.000Z");
  database.close();
  assert.ok(await store.claimDerivativeJob(), "a failed job becomes eligible after the backoff");

  const capDatabase = new Database(sqliteDatabasePath(libraryDir));
  capDatabase.prepare("UPDATE derivative_jobs SET status = 'failed', attempts = 3, updated_at = ? WHERE project_id = 'default' AND asset_id = 'broken'")
    .run("2000-01-01T00:00:00.000Z");
  capDatabase.close();
  assert.equal(await store.claimDerivativeJob(), null, "failed derivatives stop retrying after three attempts");
});

test("SQLite store re-links copied Codex assets, archived ones included, and explains each skip", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-sqlite-hardlink-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const codexImagesDir = join(root, ".codex", "generated_images");
  await mkdir(join(codexImagesDir, "task-1"), { recursive: true });
  const codexPath = join(codexImagesDir, "task-1", "generated.png");
  const orphanPath = join(codexImagesDir, "task-1", "orphan.png");
  await writeFile(codexPath, ONE_PIXEL_PNG);
  await writeFile(orphanPath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({
    projectRoot,
    managerDir: join(projectRoot, "mosa"),
    libraryDir: join(root, "library"),
    codexImagesDir,
  });
  t.after(() => store.close());

  const active = await store.createAsset({ assetId: "codex-active", imagePath: codexPath });
  const archived = await store.createAsset({ assetId: "codex-archived", imagePath: codexPath });
  const orphan = await store.createAsset({ assetId: "codex-orphan", imagePath: orphanPath });
  assert.equal(active.source.storage_mode, "hard-link", "ingest already links; only older copies need this pass");
  await store.archiveAsset("default", archived.id);

  // Stand in for a library that predates hard-linked ingest, or one carried over by
  // `gravityport migrate`: same bytes, separate inode.
  for (const asset of [active, archived, orphan]) {
    await unlink(asset.image_path);
    await copyFile(codexPath, asset.image_path);
  }
  await unlink(orphanPath);

  const result = await store.migrateCodexAssetsToHardLinks("default");
  assert.deepEqual(result.migrated.sort(), ["codex-active", "codex-archived"]);
  assert.deepEqual(result.skipped, [{ assetId: "codex-orphan", reason: "source-or-library-file-missing" }]);
  const [codexStat, activeStat, archivedStat] = await Promise.all([
    stat(codexPath), stat(active.image_path), stat(archived.image_path),
  ]);
  assert.equal(activeStat.ino, codexStat.ino);
  assert.equal(archivedStat.ino, codexStat.ino, "an archived asset still holds a reclaimable copy");

  const relinked = await store.getAsset("default", "codex-active");
  assert.equal(relinked.source.storage_mode, "hard-link");
  assert.ok(relinked.source.storage_linked_at, "the pass records when it took the link");
  assert.equal(relinked.source.codex_task_id, "task-1", "the rest of the provenance survives untouched");
  assert.equal((await store.verifyLibrary()).ok, true, "re-linking must not disturb the recorded hashes");

  const second = await store.migrateCodexAssetsToHardLinks("default");
  assert.deepEqual(second.migrated, [], "a second pass has nothing left to reclaim");
  assert.deepEqual(second.alreadyLinked.sort(), ["codex-active", "codex-archived"]);
});

test("derivative stream rejects inherited kind names", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-kind-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const store = createSqliteAssetStore({
    projectRoot: root,
    managerDir: join(root, "mosa"),
    libraryDir: join(root, "library"),
  });
  t.after(() => store.close());

  await assert.rejects(
    () => store.derivativeReadStream("default", "asset", "toString"),
    /Invalid derivative kind: toString/,
  );
});

test("SQLite metadata writes cannot resurrect a trashed asset into the search index", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-sqlite-trash-fts-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir: join(root, "library") });
  t.after(() => store.close());

  const asset = await store.createAsset({ assetId: "quartz-keeper", imagePath: sourcePath, prompt: "quartzfallback lantern glow" });
  const search = () => store.listAssetPage({ projectId: "default", query: "quartz", limit: 10 });
  assert.equal((await search()).page.total, 1);

  await store.deleteAsset("default", asset.id);
  assert.equal((await search()).page.total, 0, "trashing removes the asset from the search index");

  await store.updateMetadata("default", asset.id, { theme: "quartzfallback-edited", tags: ["quartzfallback"] });
  const patched = await search();
  assert.equal(patched.page.total, 0, "a metadata edit must not re-index a trashed asset");
  assert.equal(patched.assets.length, 0);

  const batch = await store.assignAssetsToGroup("default", [asset.id], "QuartzVault");
  assert.deepEqual(batch.results, [{ id: asset.id, group: "QuartzVault" }]);
  const afterBatch = await search();
  assert.equal(afterBatch.page.total, 0, "a batch group move must not re-index a trashed asset");
  assert.equal(afterBatch.assets.length, 0);

  await store.restoreAsset("default", asset.id);
  const restored = await search();
  assert.equal(restored.page.total, 1, "restore re-indexes the asset");
  assert.deepEqual(restored.assets.map((item) => item.id), [asset.id]);
});

test("SQLite one-time FTS cleanup purges legacy trashed-asset rows exactly once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-sqlite-trash-fts-cleanup-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const libraryDir = join(root, "library");
  const dbPath = sqliteDatabasePath(libraryDir);
  const ftsRowCount = (assetId) => {
    const raw = new Database(dbPath, { readonly: true });
    try {
      return raw.prepare("SELECT COUNT(*) AS count FROM asset_fts WHERE project_id = 'default' AND asset_id = ?").get(assetId).count;
    } finally {
      raw.close();
    }
  };
  const openStore = () => createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });

  const store = openStore();
  const asset = await store.createAsset({ assetId: "quartz-legacy", imagePath: sourcePath, prompt: "quartzfallback legacy dust" });
  await store.deleteAsset("default", asset.id);
  await store.close();

  // Simulate a library written before the invariant existed: no cleanup marker
  // in library_meta and a dirty FTS row left behind by a trashed-asset edit.
  {
    const raw = new Database(dbPath);
    try {
      raw.prepare("DELETE FROM library_meta WHERE key = 'fts_trash_row_cleanup_v1'").run();
      raw.prepare("INSERT INTO asset_fts (project_id, asset_id, content) VALUES (?, ?, ?)")
        .run("default", asset.id, "quartzfallback legacy dust");
      // Same asset id under another project: the cleanup must match on
      // (project_id, asset_id), never on the id alone.
      raw.prepare("INSERT INTO asset_fts (project_id, asset_id, content) VALUES (?, ?, ?)")
        .run("other-project", asset.id, "quartzfallback other project");
    } finally {
      raw.close();
    }
  }

  const reopened = openStore();
  const meta = await reopened.migrationStatus();
  assert.ok(meta.fts_trash_row_cleanup_v1, "the cleanup records its completion in library_meta");
  {
    const raw = new Database(dbPath, { readonly: true });
    try {
      const counts = Object.fromEntries(raw.prepare("SELECT project_id, COUNT(*) AS count FROM asset_fts WHERE asset_id = ? GROUP BY project_id").all(asset.id).map((row) => [row.project_id, row.count]));
      assert.equal(counts.default, undefined, "the dirty FTS row is purged on reopen");
      assert.equal(counts["other-project"], 1, "a same-id row in another project is left alone");
    } finally {
      raw.close();
    }
  }
  await reopened.close();

  // With the marker present, reopening must not run the cleanup again — even
  // if a dirty row reappears, the steady-state open leaves it alone.
  {
    const raw = new Database(dbPath);
    try {
      raw.prepare("INSERT INTO asset_fts (project_id, asset_id, content) VALUES (?, ?, ?)")
        .run("default", asset.id, "quartzfallback legacy dust");
    } finally {
      raw.close();
    }
  }
  const third = openStore();
  const metaAfterThirdOpen = await third.migrationStatus();
  assert.equal(metaAfterThirdOpen.fts_trash_row_cleanup_v1, meta.fts_trash_row_cleanup_v1, "the marker is written only once");
  assert.equal(ftsRowCount(asset.id), 1, "the guard key prevents a second cleanup pass");
  await third.close();
});

test("updateMetadata merges business_fields key-by-key and never drops recorded dimensions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-business-fields-merge-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const sourcePath = join(projectRoot, "generated-images", "bf-merge.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({
    projectRoot,
    managerDir: join(projectRoot, "mosa"),
    libraryDir: join(root, "library"),
  });
  t.after(() => store.close());

  await store.createAsset({
    assetId: "bf-merge",
    imagePath: sourcePath,
    prompt: "dimension keeper",
    business_fields: { width: 1024, height: 768, file_bytes: 12345, auto_archived: true },
  });

  // A partial patch keeps every key it did not mention — the recorded
  // dimensions survive a writer that only names its own fields.
  const partial = await store.updateMetadata("default", "bf-merge", { business_fields: { auto_archived: false } });
  assert.equal(partial.business_fields.auto_archived, false);
  assert.equal(partial.business_fields.width, 1024);
  assert.equal(partial.business_fields.height, 768);
  assert.equal(partial.business_fields.file_bytes, 12345);

  // A null value deletes exactly its key and nothing else.
  const deleted = await store.updateMetadata("default", "bf-merge", { business_fields: { some_key: null } });
  assert.equal(Object.hasOwn(deleted.business_fields, "some_key"), false);
  assert.equal(deleted.business_fields.width, 1024);
  assert.equal(deleted.business_fields.file_bytes, 12345);
  assert.equal(deleted.business_fields.auto_archived, false);

  // Absent, null, or non-object business_fields leaves the stored object
  // untouched; there is no whole-column clear through updateMetadata.
  const absent = await store.updateMetadata("default", "bf-merge", { rating: 3 });
  assert.equal(absent.business_fields.width, 1024);
  const nullPatch = await store.updateMetadata("default", "bf-merge", { business_fields: null });
  assert.equal(nullPatch.business_fields.width, 1024);
  assert.equal(nullPatch.business_fields.auto_archived, false);
  const arrayPatch = await store.updateMetadata("default", "bf-merge", { business_fields: ["not", "an", "object"] });
  assert.equal(arrayPatch.business_fields.width, 1024);
  assert.equal(Object.hasOwn(arrayPatch.business_fields, "some_key"), false);
});
