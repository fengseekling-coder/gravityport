import assert from "node:assert/strict";
import { access, copyFile, mkdtemp, mkdir, readFile, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import sharp from "sharp";
import { createAssetStore, createJsonAssetStore } from "../lib/asset-store.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { PIXEL_HASH_VERSION, safePixelDigest } from "../lib/image-pixel-hash.js";

// createAssetStore falls back to process.env.MOSA_LIBRARY_DIR, so path-selection
// tests must neutralise it; node:test runs tests in-file sequentially, and each
// test restores the variable before its own assertions run.
function withoutMosaLibraryDir(t) {
  const saved = process.env.MOSA_LIBRARY_DIR;
  delete process.env.MOSA_LIBRARY_DIR;
  t.after(() => {
    if (saved === undefined) delete process.env.MOSA_LIBRARY_DIR;
    else process.env.MOSA_LIBRARY_DIR = saved;
  });
}

test("JSON runtime without any libraryDir keeps assets under managerDir/assets", async (t) => {
  withoutMosaLibraryDir(t);
  const root = await mkdtemp(join(tmpdir(), "mosa-paths-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const store = createAssetStore({ projectRoot, managerDir });

  assert.equal(store.storageKind, "json");
  assert.equal(store.libraryDir, null);
  assert.equal(store.assetsRoot, join(managerDir, "assets"));
  assert.equal(store.projectDir("default"), join(managerDir, "assets", "default"));
});

test("library revision changes for local and external writes without listing assets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-library-revision-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const jsonProjectRoot = join(root, "json-project");
  const jsonStore = createAssetStore({ projectRoot: jsonProjectRoot, managerDir: join(jsonProjectRoot, "mosa") });
  const jsonBefore = await jsonStore.libraryRevision("default");
  await jsonStore.createGroup({ projectId: "default", name: "Revision Group" });
  const jsonAfter = await jsonStore.libraryRevision("default");
  assert.notEqual(jsonAfter, jsonBefore);

  const sqliteProjectRoot = join(root, "sqlite-project");
  const libraryDir = join(root, "sqlite-library");
  const sqliteStore = createSqliteAssetStore({ projectRoot: sqliteProjectRoot, managerDir: join(sqliteProjectRoot, "mosa"), libraryDir, initializeFreshLibrary: true });
  const sqlitePeer = createSqliteAssetStore({ projectRoot: sqliteProjectRoot, managerDir: join(sqliteProjectRoot, "mosa"), libraryDir });
  t.after(() => { try { sqliteStore.close(); } catch {} try { sqlitePeer.close(); } catch {} });

  const sqliteBefore = await sqliteStore.libraryRevision("default");
  await sqliteStore.createGroup({ projectId: "default", name: "Local Revision" });
  const sqliteLocal = await sqliteStore.libraryRevision("default");
  assert.notEqual(sqliteLocal, sqliteBefore, "same-connection writes advance the local revision");

  await sqlitePeer.createGroup({ projectId: "default", name: "External Revision" });
  const sqliteExternal = await sqliteStore.libraryRevision("default");
  assert.notEqual(sqliteExternal, sqliteLocal, "another SQLite connection advances PRAGMA data_version");
});

test("JSON group stats expose automatic source buckets for sidebar navigation", async (t) => {
  withoutMosaLibraryDir(t);
  const root = await mkdtemp(join(tmpdir(), "mosa-source-groups-json-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, "fixture", "utf8");
  const store = createAssetStore({ projectRoot, managerDir });

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

  assert.equal(stats.unorganized, 4, "assets without a manual group are counted as unorganized");
  await store.createGroup({ projectId: "default", name: "Reviewed" });
  await store.updateMetadata("default", "gemini-1", { group: "Reviewed" });
  const afterGrouping = await store.listGroups("default");
  assert.equal(afterGrouping.unorganized, 3, "assigning a manual group removes the asset from Unorganized");
  assert.deepEqual(
    (await store.listAssets({ projectId: "default", unorganized: true })).map((asset) => asset.id).sort(),
    ["chatgpt-1", "chatgpt-2", "chatgpt-legacy"],
  );
});

test("JSON favorite toggle is serialized and does not create a recipe revision", async (t) => {
  withoutMosaLibraryDir(t);
  const root = await mkdtemp(join(tmpdir(), "mosa-favorite-json-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sourcePath = join(projectRoot, "fixture.png");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(sourcePath, "fixture", "utf8");
  const store = createAssetStore({ projectRoot, managerDir });
  const created = await store.createAsset({ assetId: "favorite-json", imagePath: sourcePath, favorite: false });
  const initialHistory = await store.getRecipeSnapshotHistory("default", created.id);

  const [first, second] = await Promise.all([
    store.toggleFavorite("default", created.id),
    store.toggleFavorite("default", created.id),
  ]);
  const final = await store.getAsset("default", created.id);
  const finalHistory = await store.getRecipeSnapshotHistory("default", created.id);

  assert.notEqual(first.favorite, second.favorite, "concurrent flips commit as two serialized state transitions");
  assert.equal(final.favorite, false, "two concurrent flips return the asset to its original state");
  assert.equal(final.updated_at, created.updated_at, "favorite does not bump content updated_at");
  assert.equal(finalHistory.snapshots.length, initialHistory.snapshots.length, "favorite does not append recipe history");
});

test("SQLite favorite toggle is atomic and leaves content revision metadata untouched", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-favorite-sqlite-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const libraryDir = join(root, "library");
  const sourcePath = join(projectRoot, "fixture.png");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(sourcePath, "fixture", "utf8");
  const store = createSqliteAssetStore({ projectRoot, managerDir, libraryDir });
  t.after(() => store.close());
  const created = await store.createAsset({ assetId: "favorite-sqlite", imagePath: sourcePath, favorite: false });
  const initialHistory = await store.getRecipeSnapshotHistory("default", created.id);

  const [first, second] = await Promise.all([
    store.toggleFavorite("default", created.id),
    store.toggleFavorite("default", created.id),
  ]);
  const final = await store.getAsset("default", created.id);
  const finalHistory = await store.getRecipeSnapshotHistory("default", created.id);

  assert.notEqual(first.favorite, second.favorite, "each atomic UPDATE observes the prior committed favorite value");
  assert.equal(final.favorite, false, "two concurrent flips return the asset to its original state");
  assert.equal(final.updated_at, created.updated_at, "favorite does not bump content updated_at");
  assert.equal(finalHistory.snapshots.length, initialHistory.snapshots.length, "favorite does not append recipe history");
});

test("a fresh explicit options.libraryDir starts directly in SQLite", async (t) => {
  withoutMosaLibraryDir(t);
  const root = await mkdtemp(join(tmpdir(), "mosa-paths-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const libraryDir = join(root, "library");
  const store = createAssetStore({ projectRoot, managerDir, libraryDir });
  t.after(() => store.close());

  assert.equal(store.storageKind, "sqlite");
  assert.equal(store.libraryDir, resolve(libraryDir));
  assert.equal(store.assetsRoot, join(resolve(libraryDir), "assets"));
  assert.equal(store.databasePath, join(resolve(libraryDir), "mosa.db"));
});

test("a fresh MOSA_LIBRARY_DIR starts directly in SQLite", async (t) => {
  const saved = process.env.MOSA_LIBRARY_DIR;
  const root = await mkdtemp(join(tmpdir(), "mosa-paths-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  process.env.MOSA_LIBRARY_DIR = join(root, "env-library");
  t.after(() => {
    if (saved === undefined) delete process.env.MOSA_LIBRARY_DIR;
    else process.env.MOSA_LIBRARY_DIR = saved;
  });

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const store = createAssetStore({ projectRoot, managerDir });
  t.after(() => store.close());

  assert.equal(store.storageKind, "sqlite");
  assert.equal(store.libraryDir, resolve(join(root, "env-library")));
  assert.equal(store.assetsRoot, join(resolve(join(root, "env-library")), "assets"));
});

test("a runtime-style fresh default libraryDir starts directly in SQLite", async (t) => {
  withoutMosaLibraryDir(t);
  const root = await mkdtemp(join(tmpdir(), "mosa-paths-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  // startMosaRuntime always resolves a default libraryDir. A genuinely fresh
  // library now goes straight to SQLite; explicitLibraryDir only helps locate
  // legacy JSON data and no longer forces a JSON birth for new users.
  const libraryDir = join(root, "default-library");
  const store = createAssetStore({
    projectRoot,
    managerDir,
    libraryDir,
    explicitLibraryDir: null,
  });
  t.after(() => store.close());

  assert.equal(store.storageKind, "sqlite");
  assert.equal(store.libraryDir, resolve(libraryDir));
  assert.equal(store.assetsRoot, join(resolve(libraryDir), "assets"));
});

test("a fresh explicit explicitLibraryDir also starts directly in SQLite", async (t) => {
  withoutMosaLibraryDir(t);
  const root = await mkdtemp(join(tmpdir(), "mosa-paths-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const libraryDir = join(root, "library");
  const store = createAssetStore({
    projectRoot,
    managerDir,
    libraryDir,
    explicitLibraryDir: libraryDir,
  });
  t.after(() => store.close());

  assert.equal(store.storageKind, "sqlite");
  assert.equal(store.libraryDir, resolve(libraryDir));
  assert.equal(store.assetsRoot, join(resolve(libraryDir), "assets"));
});

test("legacy JSON data keeps an explicit library on JSON until migration completes", async (t) => {
  withoutMosaLibraryDir(t);
  const root = await mkdtemp(join(tmpdir(), "mosa-paths-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const libraryDir = join(root, "library");
  await mkdir(join(libraryDir, "assets", "default", "metadata"), { recursive: true });
  await writeFile(join(libraryDir, "assets", "default", "groups.json"), "[]\n", "utf8");

  const store = createAssetStore({ projectRoot, managerDir, libraryDir, explicitLibraryDir: libraryDir });
  assert.equal(store.storageKind, "json");
  assert.equal(store.libraryDir, resolve(libraryDir));
});

test("a default libraryDir still selects a completed SQLite library when nothing is explicit", async (t) => {
  withoutMosaLibraryDir(t);
  const root = await mkdtemp(join(tmpdir(), "mosa-paths-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const timestamp = new Date().toISOString();
  const legacy = new Database(join(libraryDir, "mosa.db"));
  legacy.exec(`
    CREATE TABLE library_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
  `);
  legacy.prepare("INSERT INTO library_meta (key, value, updated_at) VALUES ('schema_version', '1', ?)").run(timestamp);
  legacy.prepare("INSERT INTO library_meta (key, value, updated_at) VALUES ('migration_state', 'completed', ?)").run(timestamp);
  legacy.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(timestamp);
  legacy.close();

  // The implicit default location still wins SQLite selection even though it must
  // never reroot a JSON fallback.
  const store = createAssetStore({
    projectRoot,
    managerDir,
    libraryDir,
    explicitLibraryDir: null,
  });
  t.after(() => store.close());

  assert.equal(store.storageKind, "sqlite");
  assert.equal(store.libraryDir, resolve(libraryDir));
  assert.equal(store.assetsRoot, join(resolve(libraryDir), "assets"));
});

test("imports a Codex default generated image and preserves its provenance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const codexImagesDir = join(root, ".codex", "generated_images");
  const taskId = "019f-codex-task";
  const sourcePath = join(codexImagesDir, taskId, "generated.png");
  await mkdir(join(codexImagesDir, taskId), { recursive: true });
  await writeFile(sourcePath, "fixture image", "utf8");

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const store = createAssetStore({ projectRoot, managerDir, codexImagesDir });
  const asset = await store.createAsset({
    projectId: "default",
    assetId: "codex-fixture",
    imagePath: sourcePath,
    prompt: "A verified Codex test image",
    source: { generation_tool: "imagegen", model: "gpt-5.6" }
  });

  assert.equal(asset.source.type, "codex-generated");
  assert.equal(asset.source.path, sourcePath);
  assert.equal(asset.source.codex_generated_images_root, codexImagesDir);
  assert.equal(asset.source.codex_task_id, taskId);
  assert.equal(asset.source.codex_relative_path, `${taskId}/generated.png`);
  assert.equal(asset.source.generation_tool, "imagegen");
  assert.equal(asset.source.model, "gpt-5.6");
  assert.equal(asset.source.storage_mode, "hard-link");
  assert.match(asset.image_path, /mosa[\\/]assets[\\/]default[\\/]images[\\/]codex-fixture\.png$/);
  const [sourceStat, libraryStat] = await Promise.all([stat(sourcePath), stat(asset.image_path)]);
  assert.equal(sourceStat.ino, libraryStat.ino);

  const storedMetadata = JSON.parse(await readFile(join(managerDir, "assets", "default", "metadata", "codex-fixture.json"), "utf8"));
  assert.equal(storedMetadata.source.path, sourcePath);
  assert.equal(storedMetadata.prompt, "A verified Codex test image");

  // Existing copy-based Codex entries can be converted safely after checking
  // both paths still contain identical bytes.
  await unlink(asset.image_path);
  await copyFile(sourcePath, asset.image_path);
  const migration = await store.migrateCodexAssetsToHardLinks("default");
  assert.deepEqual(migration.migrated, ["codex-fixture"]);
  const [relinkedSourceStat, relinkedLibraryStat] = await Promise.all([stat(sourcePath), stat(asset.image_path)]);
  assert.equal(relinkedSourceStat.ino, relinkedLibraryStat.ino);

  const localImagesDir = join(projectRoot, "generated-images");
  const localPath = join(localImagesDir, "local.png");
  await mkdir(localImagesDir, { recursive: true });
  await writeFile(localPath, "local fixture image", "utf8");
  await store.createAsset({ assetId: "local-fixture", imagePath: localPath });

  const codexOnly = await store.listAssets({ projectId: "default", source: "codex-generated" });
  assert.deepEqual(codexOnly.map((item) => item.id), ["codex-fixture"]);
});

for (const kind of ["json", "sqlite"]) {
  test(`${kind} deleteAsset moves assets to Trash, restores them, and only permanent deletion removes managed files`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `mosa-delete-${kind}-`));
    deferTestPathRemoval(root, { recursive: true, force: true });
    const projectRoot = join(root, "project");
    const managerDir = join(projectRoot, "mosa");
    const libraryDir = join(root, "library");
    const sourcePath = join(projectRoot, "generated-images", "delete-source.png");
    await mkdir(join(projectRoot, "generated-images"), { recursive: true });
    await writeFile(sourcePath, "delete fixture");
    const store = kind === "sqlite"
      ? createSqliteAssetStore({ projectRoot, managerDir, libraryDir })
      : createAssetStore({ projectRoot, managerDir });
    if (kind === "sqlite") t.after(() => store.close());

    const asset = await store.createAsset({ assetId: `delete-${kind}`, imagePath: sourcePath, prompt: "remove me" });
    await store.deleteAsset("default", asset.id);
    assert.equal((await store.listAssets({ projectId: "default" })).some((item) => item.id === asset.id), false);
    const trashed = await store.listAssets({ projectId: "default", trash: true });
    assert.equal(trashed.length, 1);
    assert.equal(trashed[0].id, asset.id);
    assert.ok(trashed[0].deleted_at);
    assert.equal((await store.listAutomaticIngestSuppressions("default")).length, 1,
      "Trash keeps automatic collectors from immediately re-importing the same asset");
    await stat(asset.image_path);
    if (asset.prompt_path) await stat(asset.prompt_path);

    const restored = await store.restoreAsset("default", asset.id);
    assert.equal(restored.deleted_at, null);
    assert.equal((await store.listAssets({ projectId: "default" })).some((item) => item.id === asset.id), true);
    assert.deepEqual(await store.listAutomaticIngestSuppressions("default"), [],
      "restoring an asset clears the deletion suppression that belongs to it");

    await store.deleteAsset("default", asset.id);
    const deletedAtMs = Date.parse((await store.getAsset("default", asset.id)).deleted_at);
    const earlyPurge = await store.purgeExpiredTrash({ nowMs: deletedAtMs + (89 * 24 * 60 * 60 * 1000) });
    assert.equal(earlyPurge.removed, 0, "Trash retention is per-asset and lasts the full 90 days");
    await stat(asset.image_path);
    const duePurge = await store.purgeExpiredTrash({ nowMs: deletedAtMs + (90 * 24 * 60 * 60 * 1000) });
    assert.equal(duePurge.removed, 1);
    await assert.rejects(store.getAsset("default", asset.id), /not found/i);
    await assert.rejects(stat(asset.image_path), { code: "ENOENT" });
    if (asset.prompt_path) await assert.rejects(stat(asset.prompt_path), { code: "ENOENT" });
    await stat(sourcePath);
  });
}

test("JSON recipe snapshots change only with generation inputs and remain immutable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-recipes-json-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, "recipe fixture", "utf8");
  const store = createAssetStore({ projectRoot, managerDir });

  const asset = await store.createAsset({
    assetId: "recipe-fixture",
    imagePath: sourcePath,
    prompt: "A red city at dusk",
    negative_prompt: "text, watermark",
    references: [{ asset_id: "moodboard", sha256: "a".repeat(64), role: "palette" }],
    source: {
      generation_tool: "imagegen",
      model: "gpt-image-1",
      prompt_status: "generation-tool-prompt",
      codex_task_id: "task-1",
    },
  });
  const initialHistory = await store.getRecipeSnapshotHistory("default", asset.id);
  assert.equal(initialHistory.snapshots.length, 1);
  assert.equal(initialHistory.active_snapshot_id, initialHistory.snapshots[0].snapshot_id);
  assert.equal(initialHistory.snapshots[0].negative_prompt, "text, watermark");
  // Every reference carries its rights and permitted-use fields, all unknown
  // until somebody records them, so an unreviewed reference is visible in the
  // stored recipe rather than missing from it. See lib/reference-rights.mjs.
  assert.deepEqual(initialHistory.snapshots[0].references, [{
    asset_id: "moodboard",
    sha256: "a".repeat(64),
    role: "palette",
    scope: [],
    applied: true,
    allowed_uses: [],
    forbidden_uses: [],
    rights: { copyright: "unknown", portrait_consent: "unknown", redistribution: "unknown", attribution: "" },
  }]);
  const frozenInitial = structuredClone(initialHistory.snapshots[0]);

  await store.updateMetadata("default", asset.id, { rating: 4, group: "Keepers" });
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
});

test("JSON history synthesizes an initial snapshot for legacy metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-recipes-json-legacy-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, "legacy recipe fixture", "utf8");
  const store = createAssetStore({ projectRoot, managerDir });
  const asset = await store.createAsset({ assetId: "legacy", imagePath: sourcePath, prompt: "Legacy prompt" });
  const metadataPath = join(managerDir, "assets", "default", "metadata", `${asset.id}.json`);
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  delete metadata.recipe_snapshots;
  delete metadata.active_recipe_snapshot_id;
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  const history = await store.getRecipeSnapshotHistory("default", asset.id);
  assert.equal(history.snapshots.length, 1);
  assert.equal(history.snapshots[0].effective_prompt, "Legacy prompt");
  assert.equal(history.active_snapshot_id, history.snapshots[0].snapshot_id);
});

test("JSON pagination remains stable when the cursor asset is archived", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cursor-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  const createdAt = "2026-01-01T00:00:00.000Z";
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, "fixture image", "utf8");
  const store = createAssetStore({ projectRoot, managerDir });
  for (const assetId of ["alpha", "bravo", "charlie"]) await store.createAsset({ assetId, imagePath: sourcePath, created_at: createdAt });

  const first = await store.listAssetPage({ projectId: "default", limit: 1 });
  assert.equal(first.assets[0].id, "charlie");
  await store.archiveAsset("default", "charlie");
  await store.createAsset({ assetId: "delta", imagePath: sourcePath, created_at: createdAt });
  const second = await store.listAssetPage({ projectId: "default", limit: 1, cursor: first.page.nextCursor });
  assert.equal(second.assets[0].id, "bravo");
  await assert.rejects(store.listAssetPage({ projectId: "default", cursor: Buffer.from("{}").toString("base64url") }), /Invalid asset cursor/);
});

test("corrupt canonical JSON metadata cannot be hidden or overwritten", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-corrupt-metadata-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  const store = createAssetStore({ projectRoot, managerDir });
  await Promise.all([
    mkdir(join(projectRoot, "generated-images"), { recursive: true }),
    store.ensureProject("default"),
  ]);
  await writeFile(sourcePath, "fixture image", "utf8");
  const metadataPath = join(managerDir, "assets", "default", "metadata", "broken.json");
  const corruptMetadata = "{ not valid json\n";
  await writeFile(metadataPath, corruptMetadata, "utf8");

  await assert.rejects(store.getAsset("default", "broken"), SyntaxError);
  await assert.rejects(store.getAssetVersionHistory("default", "broken"), SyntaxError);
  await assert.rejects(
    store.createAsset({ assetId: "broken", imagePath: sourcePath }),
    (error) => error?.code === "ASSET_ALREADY_EXISTS",
  );
  assert.equal(await readFile(metadataPath, "utf8"), corruptMetadata);
});

test("persists manually created groups, including empty groups", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const store = createAssetStore({ projectRoot, managerDir });
  await store.createGroup({ projectId: "default", name: "  Inspiration   board " });

  let stats = await store.listGroups("default");
  assert.deepEqual(stats.groups, [{ name: "Inspiration board", count: 0, color: "", position: 0 }]);
  await assert.rejects(store.createGroup({ projectId: "default", name: "inspiration board" }), /Group already exists/);

  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, "fixture image", "utf8");
  await store.createAsset({ assetId: "grouped-fixture", imagePath: sourcePath, group: "Inspiration board" });

  await store.renameGroup("default", "Inspiration board", "Mood board");
  assert.equal((await store.getAsset("default", "grouped-fixture")).group, "Mood board");
  await assert.rejects(store.renameGroup("default", "Missing", "Other"), /Group not found/);

  stats = await createAssetStore({ projectRoot, managerDir }).listGroups("default");
  assert.deepEqual(stats.groups, [{ name: "Mood board", count: 1, color: "", position: 0 }]);
});

test("JSON group deletion moves every asset in the group to Trash and keeps them restorable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-delete-group-assets-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sourceDir = join(projectRoot, "generated-images");
  const sourcePath = join(sourceDir, "fixture.png");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(sourcePath, "fixture image", "utf8");
  const store = createAssetStore({ projectRoot, managerDir });
  await store.createGroup({ projectId: "default", name: "Disposable" });
  const first = await store.createAsset({ assetId: "group-delete-a", imagePath: sourcePath, group: "Disposable" });
  const second = await store.createAsset({ assetId: "group-delete-b", imagePath: sourcePath, group: "Disposable" });

  const result = await store.deleteGroup("default", "Disposable", { deleteAssets: true });

  assert.equal(result.deletedAssets, 2);
  assert.equal((await store.listAssets({ projectId: "default" })).length, 0);
  assert.deepEqual((await store.listAssets({ projectId: "default", trash: true })).map((item) => item.id).sort(), [first.id, second.id].sort());
  assert.equal((await store.listAutomaticIngestSuppressions("default")).length, 1,
    "group Trash moves suppress automatic re-import of the deleted content");
  assert.deepEqual((await store.listGroups("default")).groups, []);
  await store.restoreAsset("default", first.id);
  assert.equal((await store.getAsset("default", first.id)).group, "Disposable");
  assert.deepEqual((await store.listGroups("default")).groups, [{ name: "Disposable", count: 1, color: "", position: 0 }]);
});

test("JSON group deletion rolls metadata back when a later logical write fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-delete-group-assets-rollback-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sourceDir = join(projectRoot, "generated-images");
  const sourcePath = join(sourceDir, "fixture.png");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(sourcePath, "fixture image", "utf8");
  const store = createAssetStore({ projectRoot, managerDir });
  await store.createGroup({ projectId: "default", name: "Atomic" });
  const first = await store.createAsset({ assetId: "group-rollback-a", imagePath: sourcePath, group: "Atomic" });
  const second = await store.createAsset({ assetId: "group-rollback-b", imagePath: sourcePath, group: "Atomic" });

  const originalGroupsFile = store.groupsFile.bind(store);
  store.groupsFile = (projectId) => store.projectDir(projectId);

  await assert.rejects(store.deleteGroup("default", "Atomic", { deleteAssets: true }));
  store.groupsFile = originalGroupsFile;

  assert.equal((await store.getAsset("default", first.id)).group, "Atomic");
  assert.equal((await store.getAsset("default", first.id)).deleted_at, null);
  assert.equal((await store.getAsset("default", second.id)).group, "Atomic");
  assert.equal((await store.getAsset("default", second.id)).deleted_at, null);
  assert.deepEqual((await store.listGroups("default")).groups, [{ name: "Atomic", count: 2, color: "", position: 0 }]);
});

test("keeps concurrent group creations from independent store instances", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const firstStore = createAssetStore({ projectRoot, managerDir });
  const secondStore = createAssetStore({ projectRoot, managerDir });

  await Promise.all([
    firstStore.createGroup({ projectId: "default", name: "alpha" }),
    secondStore.createGroup({ projectId: "default", name: "beta" }),
  ]);

  const stats = await firstStore.listGroups("default");
  // Concurrent creations race for positions; assert the set, not the order.
  assert.deepEqual(
    stats.groups.map((group) => group.name).sort(),
    ["alpha", "beta"],
  );
  assert.deepEqual(stats.groups.map((group) => group.position).sort((a, b) => a - b), [0, 1]);
});

test("does not reclaim a stale-looking lock held by a live group writer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const store = createAssetStore({ projectRoot, managerDir });
  await store.ensureProject("default");

  // Simulate a live writer at the exact file level the store uses: the lock
  // owner pid is this (alive) test process, but the mtime looks 31s stale.
  const lockPath = join(managerDir, "assets", "default", ".groups.lock");
  await writeFile(lockPath, JSON.stringify({ token: "live-owner", pid: process.pid }), "utf8");
  const staleTime = new Date(Date.now() - 31_000);
  await utimes(lockPath, staleTime, staleTime);

  const write = store.createGroup({ projectId: "default", name: "beta" });
  await delay(300);
  // A buggy waiter would have reclaimed the lock, finished its write, and
  // released (unlinked) the lock file. Neither may have happened.
  assert.equal(await access(lockPath).then(() => true, () => false), true, "live owner's lock must survive");
  assert.equal(write instanceof Promise, true);

  // The live owner releases: the waiter completes normally.
  await unlink(lockPath);
  await write;
  const stats = await store.listGroups("default");
  assert.deepEqual(stats.groups, [{ name: "beta", count: 0, color: "", position: 0 }]);
});

test("recovers a stale group lock whose owner has exited", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const store = createAssetStore({ projectRoot, managerDir });
  await store.ensureProject("default");
  const lockPath = join(managerDir, "assets", "default", ".groups.lock");
  await writeFile(lockPath, JSON.stringify({ token: "dead-owner", pid: 999_999_999 }), "utf8");
  const staleTime = new Date(Date.now() - 31_000);
  await utimes(lockPath, staleTime, staleTime);

  await store.createGroup({ projectId: "default", name: "recovered" });
  const stats = await store.listGroups("default");
  assert.deepEqual(stats.groups, [{ name: "recovered", count: 0, color: "", position: 0 }]);
});

test("continues to reject image paths outside approved source roots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const outsidePath = join(root, "outside", "not-allowed.png");
  await mkdir(join(root, "outside"), { recursive: true });
  await writeFile(outsidePath, "fixture image", "utf8");

  const store = createAssetStore({
    projectRoot: join(root, "project"),
    managerDir: join(root, "project", "mosa"),
    codexImagesDir: join(root, ".codex", "generated_images")
  });

  await assert.rejects(store.createAsset({ imagePath: outsidePath }), /Refusing to import outside the project roots/);
});

test("rejects symbolic links even when their link path is inside an approved root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const outsidePath = join(root, "outside", "secret.txt");
  const linkedImagePath = join(projectRoot, "generated-images", "linked.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await mkdir(join(root, "outside"), { recursive: true });
  await writeFile(outsidePath, "not an image", "utf8");
  await symlink(outsidePath, linkedImagePath);

  const store = createAssetStore({ projectRoot, managerDir });
  await assert.rejects(store.createAsset({ imagePath: linkedImagePath }), /Refusing to import symbolic links/);
});

test("rejects a regular file reached through a symbolic-link directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const outsideDir = join(root, "outside");
  const linkedDir = join(projectRoot, "generated-images", "linked");
  const linkedImagePath = join(linkedDir, "escape.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(outsideDir, "escape.png"), "not an image", "utf8");
  await symlink(outsideDir, linkedDir);

  const store = createAssetStore({ projectRoot, managerDir });
  await assert.rejects(store.createAsset({ imagePath: linkedImagePath }), /Refusing to import outside the project roots/);
});

test("imports Cowart page assets from the configured external canvas directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "project");
  const canvasDir = join(root, "cowart-data", "mosa");
  const sourcePath = join(canvasDir, "pages", "page", "assets", "cowart-bear.png");
  await mkdir(join(canvasDir, "pages", "page", "assets"), { recursive: true });
  await writeFile(sourcePath, "fixture Cowart image", "utf8");

  const store = createAssetStore({
    projectRoot,
    managerDir: join(projectRoot, "mosa"),
    cowartCanvasDir: canvasDir
  });
  const asset = await store.createAsset({
    assetId: "cowart-bear",
    imagePath: sourcePath,
    sourceType: "cowart-generated"
  });

  assert.equal(asset.source.type, "cowart-generated");
  assert.equal(asset.source.path, sourcePath);
  assert.match(asset.image_path, /mosa[\\/]assets[\\/]default[\\/]images[\\/]cowart-bear\.png$/);
});

test("JSON store listAssets combines multiple filters with AND semantics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-multi-filter-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  const store = createAssetStore({ projectRoot, managerDir });

  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, "fixture image", "utf8");

  const now = new Date().toISOString();
  const longAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  // --- Core dimension assets for source/group/category/style combinations ---
  await store.createAsset({ assetId: "all-match", imagePath: sourcePath, sourceType: "codex-generated", group: "g1", category: "c1", style: "s1", created_at: longAgo });
  await store.createAsset({ assetId: "wrong-source", imagePath: sourcePath, sourceType: "local-file", group: "g1", category: "c1", style: "s1", created_at: longAgo });
  await store.createAsset({ assetId: "wrong-group", imagePath: sourcePath, sourceType: "codex-generated", group: "g2", category: "c1", style: "s1", created_at: longAgo });
  await store.createAsset({ assetId: "wrong-category", imagePath: sourcePath, sourceType: "codex-generated", group: "g1", category: "c2", style: "s1", created_at: longAgo });
  await store.createAsset({ assetId: "wrong-style", imagePath: sourcePath, sourceType: "codex-generated", group: "g1", category: "c1", style: "s2", created_at: longAgo });
  await store.createAsset({ assetId: "all-wrong", imagePath: sourcePath, sourceType: "local-file", group: "g2", category: "c2", style: "s2", created_at: longAgo });

  // --- Favorite / rating assets ---
  // These share source=codex-generated, group=g1, category=c1, style=s1 so we can test combos
  await store.createAsset({ assetId: "fav-true-recent", imagePath: sourcePath, sourceType: "codex-generated", group: "g1", category: "c1", style: "s1", favorite: true, created_at: now });
  await store.createAsset({ assetId: "fav-true-old", imagePath: sourcePath, sourceType: "codex-generated", group: "g1", category: "c1", style: "s1", favorite: true, created_at: longAgo });
  await store.createAsset({ assetId: "rating-fav-recent", imagePath: sourcePath, sourceType: "codex-generated", group: "g1", category: "c1", style: "s1", rating: 3, created_at: now });
  await store.createAsset({ assetId: "not-fav-but-recent", imagePath: sourcePath, sourceType: "codex-generated", group: "g1", category: "c1", style: "s1", favorite: false, created_at: now });

  // 1. Single filter: source
  const bySource = await store.listAssets({ projectId: "default", source: "codex-generated" });
  assert.equal(bySource.length, 8);
  assert.ok(bySource.every((a) => a.source?.type === "codex-generated"));

  // 2. Single filter: group
  const byGroup = await store.listAssets({ projectId: "default", group: "g1" });
  assert.equal(byGroup.length, 8);
  assert.ok(byGroup.every((a) => a.group === "g1"));

  // 3. source + group (AND): only assets where source=codex-generated AND group=g1
  const sourceGroup = await store.listAssets({ projectId: "default", source: "codex-generated", group: "g1" });
  assert.equal(sourceGroup.length, 7); // all-match, wrong-category, wrong-style, fav-true-recent, fav-true-old, rating-fav-recent, not-fav-but-recent
  assert.ok(sourceGroup.every((a) => a.source?.type === "codex-generated" && a.group === "g1"));

  // 4. source + group + category + style
  const allFour = await store.listAssets({ projectId: "default", source: "codex-generated", group: "g1", category: "c1", style: "s1" });
  // all-match, fav-true-recent, fav-true-old, rating-fav-recent, not-fav-but-recent
  assert.equal(allFour.length, 5);
  assert.ok(allFour.every((a) => a.source?.type === "codex-generated" && a.group === "g1" && a.category === "c1" && a.style === "s1"));

  // 5. favorite alone
  const byFav = await store.listAssets({ projectId: "default", favorite: true });
  assert.equal(byFav.length, 3); // fav-true-recent, fav-true-old, rating-fav-recent
  assert.ok(byFav.every((a) => a.rating > 0 || a.favorite === true));

  // 6. favorite + source + group
  const favSourceGroup = await store.listAssets({ projectId: "default", favorite: true, source: "codex-generated", group: "g1" });
  assert.equal(favSourceGroup.length, 3);
  assert.ok(favSourceGroup.every((a) => (a.rating > 0 || a.favorite === true) && a.source?.type === "codex-generated" && a.group === "g1"));

  // 7. recent alone
  const byRecent = await store.listAssets({ projectId: "default", recent: true });
  assert.equal(byRecent.length, 3); // fav-true-recent, rating-fav-recent, not-fav-but-recent
  assert.ok(byRecent.every((a) => a.created_at >= new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()));

  // 8. recent + source + group
  const recentSourceGroup = await store.listAssets({ projectId: "default", recent: true, source: "codex-generated", group: "g1" });
  assert.equal(recentSourceGroup.length, 3);
  assert.ok(recentSourceGroup.every((a) => a.created_at >= new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() && a.source?.type === "codex-generated" && a.group === "g1"));

  // 9. listAssetPage().page.total uses combined filter count
  const page = await store.listAssetPage({ projectId: "default", source: "codex-generated", group: "g1", category: "c1", style: "s1" });
  assert.equal(page.page.total, 5);

  // 10. distractor assets that match some but not all filters are excluded
  const noDistractors = await store.listAssets({ projectId: "default", source: "codex-generated", group: "g1", category: "c1", style: "s1" });
  const distractorIds = ["wrong-source", "wrong-group", "wrong-category", "wrong-style", "all-wrong"];
  for (const distId of distractorIds) {
    assert.equal(noDistractors.findIndex((a) => a.id === distId), -1, `distractor ${distId} should not appear`);
  }

  // 11. query + source (query filter from separate .filter() must also compose with AND)
  const querySource = await store.listAssets({ projectId: "default", query: "all-match", source: "codex-generated" });
  assert.equal(querySource.length, 1);
  assert.equal(querySource[0].id, "all-match");

  // 12. archived + source (archived filter from separate .filter() must also compose with AND)
  // Archive "all-match" then query with archived:true + source
  await store.archiveAsset("default", "all-match");
  const archivedSource = await store.listAssets({ projectId: "default", archived: true, source: "codex-generated" });
  assert.ok(archivedSource.some((a) => a.id === "all-match"));
  assert.ok(archivedSource.every((a) => a.source?.type === "codex-generated"));
  // Unarchive so other assertions below aren't affected
  await store.updateMetadata("default", "all-match", { archived: false });
});

test("JSON store recent filter excludes legacy assets with null, missing, or invalid created_at", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-recent-bad-date-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  const store = createAssetStore({ projectRoot, managerDir });

  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, "fixture image", "utf8");

  // Create a valid recent asset through the normal path
  const recentNow = new Date().toISOString();
  await store.createAsset({ assetId: "valid-recent", imagePath: sourcePath, sourceType: "local-file", created_at: recentNow });

  // Create assets with valid metadata, then overwrite with bad created_at values
  for (const assetId of ["legacy-null", "legacy-empty", "legacy-invalid", "legacy-absent"]) {
    await store.createAsset({ assetId, imagePath: sourcePath, sourceType: "local-file", created_at: recentNow });
  }

  const metadataDir = join(managerDir, "assets", "default", "metadata");

  // Overwrite legacy-null: created_at → null
  const nullMeta = JSON.parse(await readFile(join(metadataDir, "legacy-null.json"), "utf8"));
  nullMeta.created_at = null;
  await writeFile(join(metadataDir, "legacy-null.json"), `${JSON.stringify(nullMeta, null, 2)}\n`, "utf8");

  // Overwrite legacy-empty: created_at → ""
  const emptyMeta = JSON.parse(await readFile(join(metadataDir, "legacy-empty.json"), "utf8"));
  emptyMeta.created_at = "";
  await writeFile(join(metadataDir, "legacy-empty.json"), `${JSON.stringify(emptyMeta, null, 2)}\n`, "utf8");

  // Overwrite legacy-invalid: created_at → non-date string
  const invalidMeta = JSON.parse(await readFile(join(metadataDir, "legacy-invalid.json"), "utf8"));
  invalidMeta.created_at = "not-a-real-date";
  await writeFile(join(metadataDir, "legacy-invalid.json"), `${JSON.stringify(invalidMeta, null, 2)}\n`, "utf8");

  // Overwrite legacy-absent: remove created_at entirely
  const absentMeta = JSON.parse(await readFile(join(metadataDir, "legacy-absent.json"), "utf8"));
  delete absentMeta.created_at;
  await writeFile(join(metadataDir, "legacy-absent.json"), `${JSON.stringify(absentMeta, null, 2)}\n`, "utf8");

  // 1. Unfiltered listAssets returns everything
  const all = await store.listAssets({ projectId: "default" });
  const allIds = all.map((a) => a.id);
  assert.ok(allIds.includes("valid-recent"), "valid-recent should be listed");
  assert.ok(allIds.includes("legacy-null"), "legacy-null should be listed");
  assert.ok(allIds.includes("legacy-empty"), "legacy-empty should be listed");
  assert.ok(allIds.includes("legacy-invalid"), "legacy-invalid should be listed");
  assert.ok(allIds.includes("legacy-absent"), "legacy-absent should be listed");

  // 2. recent:true excludes all bad-date assets
  const recent = await store.listAssets({ projectId: "default", recent: true });
  const recentIds = recent.map((a) => a.id);
  assert.ok(recentIds.includes("valid-recent"), "valid-recent should appear with recent:true");
  assert.equal(recentIds.includes("legacy-null"), false, "legacy-null must be excluded from recent");
  assert.equal(recentIds.includes("legacy-empty"), false, "legacy-empty must be excluded from recent");
  assert.equal(recentIds.includes("legacy-invalid"), false, "legacy-invalid must be excluded from recent");
  assert.equal(recentIds.includes("legacy-absent"), false, "legacy-absent must be excluded from recent");

  // 3. Only the truly-recent asset passes
  assert.equal(recent.length, 1, "only valid-recent should pass recent:true");
  assert.equal(recent[0].id, "valid-recent");
});

test("JSON store recent filter compares parsed timestamps, not raw created_at strings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-recent-numeric-date-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  const store = createAssetStore({ projectRoot, managerDir });

  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, "fixture image", "utf8");

  const metadataDir = join(managerDir, "assets", "default", "metadata");
  const rewriteLegacyCreatedAt = async (assetId, mutate) => {
    const filePath = join(metadataDir, `${assetId}.json`);
    const metadata = JSON.parse(await readFile(filePath, "utf8"));
    mutate(metadata);
    await writeFile(filePath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  };

  const now = new Date();
  const nowIso = now.toISOString();
  // Every legacy format below is one ECMA-262 requires Date.parse to accept, so the test does
  // not depend on engine-specific heuristics or on the machine's timezone.
  // RFC 1123 form (Date.prototype.toUTCString output), e.g. "Sun, 26 Jul 2026 07:12:45 GMT".
  const recentRfc = now.toUTCString();
  // Date.prototype.toString output, e.g. "Sun Jul 26 2026 00:12:45 GMT-0700 (…)".
  const recentLocalString = now.toString();
  // Expanded-year ISO form, e.g. "+002026-07-26T07:12:45.970Z": same instant as nowIso, but it
  // starts with "+" and therefore sorts lexicographically *below* the ISO cutoff, so a string
  // comparison would wrongly drop it.
  const recentExpandedIso = `+00${nowIso}`;
  assert.equal(Date.parse(recentExpandedIso), Date.parse(nowIso), "expanded-year ISO must parse to the same instant");
  assert.ok(recentExpandedIso < new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), "expanded-year ISO must sort below the ISO cutoff");

  const legacyIds = [
    "legacy-old-rfc",
    "legacy-recent-rfc",
    "legacy-recent-local-string",
    "legacy-recent-expanded-iso",
    "legacy-null",
    "legacy-empty",
    "legacy-invalid",
    "legacy-absent",
  ];
  await store.createAsset({ assetId: "valid-recent-iso", imagePath: sourcePath, sourceType: "local-file", created_at: nowIso });
  for (const assetId of legacyIds) {
    await store.createAsset({ assetId, imagePath: sourcePath, sourceType: "local-file", created_at: nowIso });
  }

  // Parseable but very old RFC 1123 date. Lexicographically it beats the ISO cutoff
  // ("S" > "2"), so only a numeric timestamp comparison can exclude it.
  await rewriteLegacyCreatedAt("legacy-old-rfc", (metadata) => { metadata.created_at = "Sat, 01 Jan 2000 00:00:00 GMT"; });
  // Parseable and recent RFC 1123 date: must still be accepted.
  await rewriteLegacyCreatedAt("legacy-recent-rfc", (metadata) => { metadata.created_at = recentRfc; });
  // Parseable and recent Date.prototype.toString date: must still be accepted.
  await rewriteLegacyCreatedAt("legacy-recent-local-string", (metadata) => { metadata.created_at = recentLocalString; });
  // Parseable and recent expanded-year ISO date: must still be accepted.
  await rewriteLegacyCreatedAt("legacy-recent-expanded-iso", (metadata) => { metadata.created_at = recentExpandedIso; });
  // Regression coverage retained for the unusable values.
  await rewriteLegacyCreatedAt("legacy-null", (metadata) => { metadata.created_at = null; });
  await rewriteLegacyCreatedAt("legacy-empty", (metadata) => { metadata.created_at = ""; });
  await rewriteLegacyCreatedAt("legacy-invalid", (metadata) => { metadata.created_at = "not-a-real-date"; });
  await rewriteLegacyCreatedAt("legacy-absent", (metadata) => { delete metadata.created_at; });

  // 1. The unfiltered listing still surfaces every legacy record.
  const all = await store.listAssets({ projectId: "default" });
  const allIds = all.map((asset) => asset.id);
  for (const assetId of ["valid-recent-iso", ...legacyIds]) {
    assert.ok(allIds.includes(assetId), `${assetId} should be listed without filters`);
  }
  assert.equal(all.length, 9);

  // 2. recent:true keeps exactly the entries whose parsed timestamp is inside the window.
  const recent = await store.listAssets({ projectId: "default", recent: true });
  const recentIds = recent.map((asset) => asset.id).sort();
  assert.deepEqual(recentIds, [
    "legacy-recent-expanded-iso",
    "legacy-recent-local-string",
    "legacy-recent-rfc",
    "valid-recent-iso",
  ]);

  // 3. Old-but-parseable and unusable created_at values are both excluded.
  for (const assetId of ["legacy-old-rfc", "legacy-null", "legacy-empty", "legacy-invalid", "legacy-absent"]) {
    assert.equal(recentIds.includes(assetId), false, `${assetId} must be excluded from recent`);
  }

  // 4. Every surviving asset parses to a numeric timestamp inside the 7-day window.
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  assert.ok(recent.every((asset) => Number.isFinite(Date.parse(asset.created_at)) && Date.parse(asset.created_at) >= cutoff));

  // 5. listGroups().recent reuses the same date semantics as listAssets({ recent: true }).
  const groups = await store.listGroups("default");
  assert.equal(groups.total, 9);
  assert.equal(groups.recent, recent.length);
  assert.equal(groups.recent, 4);

  // 6. An explicit cutoff is honoured. listGroups() relies on this to derive its counter and its
  //    asset scan from a single Date.now() reading instead of reading the clock twice.
  const widened = await store.listAssets({
    projectId: "default",
    recent: true,
    recentSince: Date.parse("1999-12-31T00:00:00.000Z"),
  });
  assert.deepEqual(widened.map((asset) => asset.id).sort(), [
    "legacy-old-rfc",
    "legacy-recent-expanded-iso",
    "legacy-recent-local-string",
    "legacy-recent-rfc",
    "valid-recent-iso",
  ]);
  const narrowed = await store.listAssets({ projectId: "default", recent: true, recentSince: Date.now() + 60_000 });
  assert.deepEqual(narrowed, [], "a cutoff in the future must exclude every asset");
  const ignored = await store.listAssets({ projectId: "default", recent: true, recentSince: "not-a-number" });
  assert.equal(ignored.length, recent.length, "a non-numeric recentSince falls back to the default window");
});

test("JSON store normalizes parseable created_at to ISO 8601 on write", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-created-at-normalize-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  const store = createAssetStore({ projectRoot, managerDir });

  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, "fixture image", "utf8");

  const metadataDir = join(managerDir, "assets", "default", "metadata");
  const storedCreatedAt = async (assetId) => JSON.parse(await readFile(join(metadataDir, `${assetId}.json`), "utf8")).created_at;

  // 1. A parseable non-ISO date is canonicalised, in the returned asset and on disk, so sorting
  //    and cursor pagination — which still compare strings — cannot disagree with the instant.
  const rfc = "Sat, 01 Jan 2000 00:00:00 GMT";
  const fromRfc = await store.createAsset({ assetId: "from-rfc", imagePath: sourcePath, created_at: rfc });
  assert.equal(fromRfc.created_at, "2000-01-01T00:00:00.000Z");
  assert.equal(await storedCreatedAt("from-rfc"), "2000-01-01T00:00:00.000Z");

  // 2. Expanded-year ISO and offset forms collapse to the same canonical UTC form.
  const offsetForm = await store.createAsset({ assetId: "from-offset", imagePath: sourcePath, created_at: "2026-01-02T00:00:00.000+02:00" });
  assert.equal(offsetForm.created_at, "2026-01-01T22:00:00.000Z");
  const expandedForm = await store.createAsset({ assetId: "from-expanded", imagePath: sourcePath, created_at: "+002026-01-03T04:05:06.700Z" });
  assert.equal(expandedForm.created_at, "2026-01-03T04:05:06.700Z");

  // 3. Values the runtime cannot parse are preserved verbatim instead of being discarded.
  const unparseable = await store.createAsset({ assetId: "from-garbage", imagePath: sourcePath, created_at: "not-a-real-date" });
  assert.equal(unparseable.created_at, "not-a-real-date");
  assert.equal(await storedCreatedAt("from-garbage"), "not-a-real-date");

  // 4. A blank value still falls back to "now".
  const blank = await store.createAsset({ assetId: "from-blank", imagePath: sourcePath, created_at: "" });
  assert.ok(Number.isFinite(Date.parse(blank.created_at)), "a blank created_at falls back to a real timestamp");

  // 5. Editing a legacy record self-heals it: rewrite metadata on disk with a recent RFC date,
  //    then update any unrelated field.
  await store.createAsset({ assetId: "legacy-edit", imagePath: sourcePath });
  const legacyPath = join(metadataDir, "legacy-edit.json");
  const legacyMetadata = JSON.parse(await readFile(legacyPath, "utf8"));
  const recentRfc = new Date().toUTCString();
  legacyMetadata.created_at = recentRfc;
  await writeFile(legacyPath, `${JSON.stringify(legacyMetadata, null, 2)}\n`, "utf8");
  assert.equal(await storedCreatedAt("legacy-edit"), recentRfc, "the legacy value is on disk before the edit");
  const healed = await store.updateMetadata("default", "legacy-edit", { style: "cyberpunk" });
  assert.equal(healed.created_at, new Date(Date.parse(recentRfc)).toISOString());
  assert.equal(await storedCreatedAt("legacy-edit"), new Date(Date.parse(recentRfc)).toISOString());
  assert.equal(healed.style, "cyberpunk");

  // 6. Editing a record whose date cannot be parsed leaves the value untouched.
  const keptGarbage = await store.updateMetadata("default", "from-garbage", { style: "kept" });
  assert.equal(keptGarbage.created_at, "not-a-real-date");

  // 7. Normalisation does not change which assets the recent filter returns.
  const recentIds = (await store.listAssets({ projectId: "default", recent: true })).map((asset) => asset.id).sort();
  assert.deepEqual(recentIds, ["from-blank", "legacy-edit"]);
  const groups = await store.listGroups("default");
  assert.equal(groups.recent, recentIds.length);
});

test("JSON store presents legacy created_at in canonical form without rewriting the file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-created-at-read-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  const store = createAssetStore({ projectRoot, managerDir });

  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, "fixture image", "utf8");

  await store.createAsset({ assetId: "modern", imagePath: sourcePath, created_at: "2020-05-05T00:00:00.000Z" });
  await store.createAsset({ assetId: "ancient", imagePath: sourcePath, created_at: "2020-05-05T00:00:00.000Z" });
  await store.createAsset({ assetId: "broken", imagePath: sourcePath, created_at: "2020-05-05T00:00:00.000Z" });

  // Rewrite two records the way an older build would have written them.
  const metadataDir = join(managerDir, "assets", "default", "metadata");
  const rewrite = async (assetId, createdAt) => {
    const filePath = join(metadataDir, `${assetId}.json`);
    const metadata = JSON.parse(await readFile(filePath, "utf8"));
    metadata.created_at = createdAt;
    await writeFile(filePath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  };
  await rewrite("ancient", "Sat, 01 Jan 2000 00:00:00 GMT");
  await rewrite("broken", "not-a-real-date");

  // 1. Reads report the canonical instant, so sorting no longer believes the year 2000 record is
  //    the newest one just because "S" sorts above "2". Before this, the order was
  //    ["broken", "ancient", "modern"].
  const listed = await store.listAssets({ projectId: "default" });
  const listedIds = listed.map((asset) => asset.id);
  assert.ok(listedIds.indexOf("modern") < listedIds.indexOf("ancient"), "the 2020 record must sort above the 2000 one");
  // "broken" still floats to the front: its text cannot be parsed, so nothing can place it by
  // instant and the sort falls back to comparing "not-a-real-date" as a string. Pinned here so the
  // remaining limitation is visible rather than surprising.
  assert.deepEqual(listedIds, ["broken", "modern", "ancient"]);
  assert.equal(listed.find((asset) => asset.id === "ancient").created_at, "2000-01-01T00:00:00.000Z");
  assert.equal((await store.getAsset("default", "ancient")).created_at, "2000-01-01T00:00:00.000Z");

  // 2. Unparseable text is passed through untouched.
  assert.equal(listed.find((asset) => asset.id === "broken").created_at, "not-a-real-date");

  // 3. The files themselves are not rewritten by reading.
  const storedCreatedAt = async (assetId) => JSON.parse(await readFile(join(metadataDir, `${assetId}.json`), "utf8")).created_at;
  assert.equal(await storedCreatedAt("ancient"), "Sat, 01 Jan 2000 00:00:00 GMT");
  assert.equal(await storedCreatedAt("broken"), "not-a-real-date");

  // 4. Cursor pagination walks the canonical order.
  const firstPage = await store.listAssetPage({ projectId: "default", limit: 2 });
  assert.deepEqual(firstPage.assets.map((asset) => asset.id), ["broken", "modern"]);
  const secondPage = await store.listAssetPage({ projectId: "default", limit: 2, cursor: firstPage.page.nextCursor });
  assert.deepEqual(secondPage.assets.map((asset) => asset.id), ["ancient"]);
});

test("readProjectAssets warns again when corrupt content changes but size and mtime do not", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-corrupt-rehash-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, "fixture image", "utf8");

  const warnings = [];
  const store = createAssetStore({ projectRoot, managerDir, onWarning: (warning) => warnings.push(warning) });
  await store.createAsset({ assetId: "valid-asset", imagePath: sourcePath });

  const badPath = join(managerDir, "assets", "default", "metadata", "bad.json");
  const frozen = new Date("2026-07-01T00:00:00.000Z");
  await writeFile(badPath, "not json {{{", "utf8");
  await utimes(badPath, frozen, frozen);
  const firstStat = await stat(badPath);

  await store.listAssets({ projectId: "default" });
  await store.listAssets({ projectId: "default" });
  assert.equal(warnings.length, 1, "the same bytes warn once");

  // Same byte length, same modification time, different content: only a content-addressed key
  // notices this.
  await writeFile(badPath, "not json }}}", "utf8");
  await utimes(badPath, frozen, frozen);
  const secondStat = await stat(badPath);
  assert.equal(secondStat.size, firstStat.size, "the fixture must keep the same size");
  assert.equal(secondStat.mtimeMs, firstStat.mtimeMs, "the fixture must keep the same mtime");

  await store.listAssets({ projectId: "default" });
  assert.equal(warnings.length, 2, "different corrupt bytes must be reported");
  await store.listAssets({ projectId: "default" });
  assert.equal(warnings.length, 2, "and then only once");
});

test("JSON store looks assets up by content hash without listing the project", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-content-hash-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  const otherPath = join(projectRoot, "generated-images", "other.png");
  const store = createAssetStore({ projectRoot, managerDir });

  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, "fixture image", "utf8");
  await writeFile(otherPath, "a different image", "utf8");

  // Duplicating an asset copies its bytes, so several records legitimately share one hash.
  const oldest = await store.createAsset({ assetId: "same-oldest", imagePath: sourcePath, created_at: "2026-01-01T00:00:00.000Z" });
  await store.createAsset({ assetId: "same-newest", imagePath: sourcePath, created_at: "2026-03-01T00:00:00.000Z" });
  await store.createAsset({ assetId: "same-archived", imagePath: sourcePath, created_at: "2026-06-01T00:00:00.000Z" });
  const different = await store.createAsset({ assetId: "different", imagePath: otherPath });
  await store.archiveAsset("default", "same-archived");

  const hash = oldest.source.content_sha256;
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.notEqual(different.source.content_sha256, hash);

  // 1. Active beats archived, then newest wins — the same order listAssets sorts by, which is
  //    what the previous full-scan implementation happened to return.
  const found = await store.findAssetByContentHash("default", hash);
  assert.equal(found.id, "same-newest");
  assert.equal(found.image_url, `/library/default/images/${found.asset}`, "the match is decorated like getAsset");
  assert.deepEqual(found, await store.getAsset("default", "same-newest"));
  assert.equal((await store.findAssetBySourcePath("default", sourcePath)).id, "same-newest");

  // 2. It agrees with what a full scan of both listings would have found.
  const scanned = [
    ...(await store.listAssets({ projectId: "default" })),
    ...(await store.listAssets({ projectId: "default", archived: true })),
  ].find((asset) => asset.source?.content_sha256 === hash);
  assert.equal(scanned.id, found.id);

  // 3. Archived records are still reachable once the active ones are gone.
  await store.archiveAsset("default", "same-newest");
  await store.archiveAsset("default", "same-oldest");
  assert.equal((await store.findAssetByContentHash("default", hash)).id, "same-archived");

  // 4. Misses and unusable input return null rather than throwing.
  assert.equal(await store.findAssetByContentHash("default", "0".repeat(64)), null);
  for (const empty of ["", null, undefined]) {
    assert.equal(await store.findAssetByContentHash("default", empty), null);
  }
  assert.equal(await store.findAssetByContentHash("no-such-project", hash), null, "an unknown project must not create anything");
});

test("JSON pixel-hash lookup ignores obsolete hash versions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-json-pixel-version-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sourcePath = join(projectRoot, "generated-images", "pixel.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toFile(sourcePath);
  const store = createAssetStore({ projectRoot, managerDir });
  const pixelHash = await safePixelDigest(sourcePath);
  const created = await store.createAsset({
    assetId: "pixel-version",
    imagePath: sourcePath,
    source: { pixel_sha256: pixelHash, pixel_hash_version: PIXEL_HASH_VERSION },
  });
  assert.ok(pixelHash);
  assert.equal((await store.findAssetByPixelHash("default", pixelHash)).id, created.id);
  await store.updateMetadata("default", created.id, { source: { ...created.source, pixel_hash_version: "legacy-pixel-v0" } });
  assert.equal(await store.findAssetByPixelHash("default", pixelHash), null);
});

test("readProjectAssets warns on corrupt JSON and still returns valid assets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-corrupt-warn-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, "fixture image", "utf8");

  const warnings = [];
  const store = createAssetStore({
    projectRoot,
    managerDir,
    onWarning: (warning) => warnings.push(warning),
  });

  await store.createAsset({ assetId: "valid-one", imagePath: sourcePath });
  await store.createAsset({ assetId: "valid-two", imagePath: sourcePath });

  const metadataDir = join(managerDir, "assets", "default", "metadata");
  const corruptContent = "{ this is not valid json {{{\n";
  await writeFile(join(metadataDir, "corrupt-file.json"), corruptContent, "utf8");

  const assets = await store.listAssets({ projectId: "default" });
  const ids = assets.map((a) => a.id);
  assert.ok(ids.includes("valid-one"), "valid-one should be returned");
  assert.ok(ids.includes("valid-two"), "valid-two should be returned");
  assert.equal(ids.includes("corrupt-file"), false, "corrupt file should not appear in results");

  assert.equal(warnings.length, 1, "should emit exactly one warning for the corrupt file");
  const warning = warnings[0];
  assert.equal(typeof warning.code, "string");
  assert.ok(warning.code.length > 0, "warning must have a stable error code");
  assert.equal(warning.projectId, "default");
  assert.equal(typeof warning.filePath, "string");
  assert.ok(warning.filePath.includes("corrupt-file.json"), "filePath should reference the corrupt file");
  assert.equal(typeof warning.message, "string");
  assert.ok(warning.message.length > 0, "warning must include a safe error summary");
});

test("readProjectAssets warning does not leak corrupt file content", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-corrupt-no-leak-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, "fixture image", "utf8");

  const warnings = [];
  const store = createAssetStore({
    projectRoot,
    managerDir,
    onWarning: (warning) => warnings.push(warning),
  });

  await store.createAsset({ assetId: "safe-asset", imagePath: sourcePath });

  // Corrupt on purpose, and corrupt in the way that makes JSON parser messages quote the head of
  // the file: the store must emit its own summary instead of forwarding error.message.
  const sensitiveContent = 'hunter2 secret api key abc123 {"prompt": "secret api key abc123"';
  const metadataDir = join(managerDir, "assets", "default", "metadata");
  await writeFile(join(metadataDir, "sensitive.json"), sensitiveContent, "utf8");

  await store.listAssets({ projectId: "default" });

  assert.equal(warnings.length, 1, "should emit exactly one warning");
  const warning = warnings[0];
  assert.ok(!JSON.stringify(warning).includes("secret api key"), "warning must not contain the raw file content");
  assert.ok(!JSON.stringify(warning).includes("hunter2"), "warning must not contain sensitive data from the file");
  assert.ok(!JSON.stringify(warning).includes(sensitiveContent), "warning must not contain the original JSON string");
  assert.equal(warning.code, "CORRUPT_METADATA");
  assert.ok(warning.filePath.includes("sensitive.json"), "the warning still identifies the offending file");
  assert.ok(warning.message.length > 0, "warning must still carry a safe summary");
});

test("readProjectAssets isolates synchronous and asynchronous warning sink failures", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-corrupt-warning-sink-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, "fixture image", "utf8");

  const setupStore = createAssetStore({ projectRoot, managerDir });
  await setupStore.createAsset({ assetId: "valid-asset", imagePath: sourcePath });
  await writeFile(join(managerDir, "assets", "default", "metadata", "bad.json"), "not json {{{", "utf8");

  const handlers = [
    () => { throw new Error("synchronous warning sink failure"); },
    async () => { throw new Error("asynchronous warning sink failure"); },
  ];
  for (const onWarning of handlers) {
    const store = createAssetStore({ projectRoot, managerDir, onWarning });
    const assets = await store.listAssets({ projectId: "default" });
    assert.deepEqual(assets.map((asset) => asset.id), ["valid-asset"], "warning delivery cannot break a tolerant scan");
  }
});

test("readProjectAssets warns only once per corrupt file per scan", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-corrupt-dedup-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, "fixture image", "utf8");

  const warnings = [];
  const store = createAssetStore({
    projectRoot,
    managerDir,
    onWarning: (warning) => warnings.push(warning),
  });

  await store.createAsset({ assetId: "valid-asset", imagePath: sourcePath });

  const metadataDir = join(managerDir, "assets", "default", "metadata");
  await writeFile(join(metadataDir, "bad.json"), "not json {{{", "utf8");

  await store.listAssets({ projectId: "default" });
  await store.listAssets({ projectId: "default" });

  const badFileWarnings = warnings.filter((w) => typeof w.filePath === "string" && w.filePath.includes("bad.json"));
  assert.equal(badFileWarnings.length, 1, "each corrupt file should only warn once per store instance, not once per scan");

  // The suppression is scoped to the store instance, so a freshly created store still reports it.
  const secondWarnings = [];
  const secondStore = createAssetStore({
    projectRoot,
    managerDir,
    onWarning: (warning) => secondWarnings.push(warning),
  });
  await secondStore.listAssets({ projectId: "default" });
  await secondStore.listAssets({ projectId: "default" });
  const secondBadFileWarnings = secondWarnings.filter((w) => typeof w.filePath === "string" && w.filePath.includes("bad.json"));
  assert.equal(secondBadFileWarnings.length, 1, "a new store instance reports the corrupt file exactly once");

  // Repairing the file produces no further warning, and it becomes listable again.
  await writeFile(join(metadataDir, "bad.json"), `${JSON.stringify({ id: "bad", project_id: "default", asset: "bad.png", image_path: join(projectRoot, "generated-images", "fixture.png"), prompt_path: join(metadataDir, "bad.md"), created_at: new Date().toISOString() }, null, 2)}\n`, "utf8");
  const repaired = await store.listAssets({ projectId: "default" });
  assert.ok(repaired.map((asset) => asset.id).includes("bad"), "the repaired file is listed");
  assert.equal(warnings.filter((w) => w.filePath.includes("bad.json")).length, 1, "repairing a file must not warn");

  // Damaging it again is a new revision, so suppression must not hide it.
  await writeFile(join(metadataDir, "bad.json"), "not json again {{{ and longer than before", "utf8");
  await store.listAssets({ projectId: "default" });
  assert.equal(warnings.filter((w) => w.filePath.includes("bad.json")).length, 2, "a file damaged again must warn again");
  await store.listAssets({ projectId: "default" });
  assert.equal(warnings.filter((w) => w.filePath.includes("bad.json")).length, 2, "but still only once per revision");
});

test("getAsset still throws on corrupt metadata when onWarning is configured", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-corrupt-get-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, "fixture image", "utf8");

  const warnings = [];
  const store = createAssetStore({
    projectRoot,
    managerDir,
    onWarning: (warning) => warnings.push(warning),
  });

  const metadataDir = join(managerDir, "assets", "default", "metadata");
  await mkdir(metadataDir, { recursive: true });
  await writeFile(join(metadataDir, "broken.json"), "{ bad json\n", "utf8");

  await assert.rejects(store.getAsset("default", "broken"), SyntaxError);
  await assert.rejects(store.getAssetVersionHistory("default", "broken"), SyntaxError);
});

test("SQLite store: excludeProjectRoot drops the working directory from the trusted roots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-exclude-root-sqlite-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  await mkdir(projectRoot, { recursive: true });
  const sourcePath = join(projectRoot, "fixture.png");
  await writeFile(sourcePath, "fixture", "utf8");
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => store.close());

  await assert.rejects(
    store.createAsset({ assetId: "excluded", imagePath: sourcePath }, { excludeProjectRoot: true }),
    (error) => error.code === "IMAGE_PATH_NOT_READABLE",
  );
  // Without the switch the same import keeps working (HTTP routes, bridges).
  const created = await store.createAsset({ assetId: "included", imagePath: sourcePath });
  assert.equal(created.id, "included");
});

test("JSON store: excludeProjectRoot drops the working directory from the trusted roots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-exclude-root-json-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  const sourcePath = join(projectRoot, "fixture.png");
  await writeFile(sourcePath, "fixture", "utf8");
  const store = createJsonAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa") });

  await assert.rejects(
    store.createAsset({ assetId: "excluded", imagePath: sourcePath }, { excludeProjectRoot: true }),
    (error) => error.code === "IMAGE_PATH_NOT_READABLE",
  );
  const created = await store.createAsset({ assetId: "included", imagePath: sourcePath });
  assert.equal(created.id, "included");
});

async function waitForPath(path) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await delay(10);
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
