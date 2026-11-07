import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { removeTestPath as rm, deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectLegacyLibrary, migrateLegacyLibrary, verifySqliteLibrary } from "../lib/library-migration.js";
import { createAssetStore, createJsonAssetStore } from "../lib/asset-store.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

test("migration copies legacy JSON assets, preserves unknown fields, and verifies hashes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-migrate-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const managerDir = join(root, "mosa");
  const imagePath = join(managerDir, "assets", "default", "images", "legacy.png");
  const metadataPath = join(managerDir, "assets", "default", "metadata", "legacy.json");
  await mkdir(join(managerDir, "assets", "default", "metadata"), { recursive: true });
  await mkdir(join(managerDir, "assets", "default", "images"), { recursive: true });
  await writeFile(join(managerDir, "assets", "default", "groups.json"), JSON.stringify(["Empty collection"]));
  await writeFile(imagePath, PNG);
  await writeFile(metadataPath, JSON.stringify({
    id: "legacy",
    project_id: "default",
    asset: "legacy.png",
    prompt: "preserve every prompt exactly",
    tags: ["archive"],
    source: { type: "codex-generated", path: "/old/generated.png", model: "test" },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    legacy_note: "must survive migration",
  }, null, 2));

  const libraryDir = join(root, "library");
  const report = await migrateLegacyLibrary({ managerDir, projectRoot: root, libraryDir });
  assert.equal(report.completed, true);
  assert.equal(report.discovered, 1);
  assert.equal(report.imported, 1);
  assert.equal(report.importedGroups, 1);
  assert.equal(report.verified, 1);
  assert.equal((await readFile(join(libraryDir, ".sqlite-migration-completed"), "utf8")).trim(), "completed");
  assert.equal(report.issues.length, 0);
  const verification = await verifySqliteLibrary({ managerDir, projectRoot: root, libraryDir });
  assert.equal(verification.ok, true);
  assert.equal(verification.assets, 1);
  const store = createSqliteAssetStore({ managerDir, projectRoot: root, libraryDir });
  const migrated = await store.getAsset("default", "legacy");
  const groups = await store.listGroups("default");
  store.close();
  assert.equal(migrated.legacy_note, "must survive migration");
  assert.deepEqual(groups.groups, [{ name: "Empty collection", count: 0, color: "", position: 0 }]);
  assert.equal(JSON.parse(verification.migration.migration_details).completed, true);

  const backup = await readFile(join(report.backupPath, "default", "metadata", "legacy.json"), "utf8");
  assert.match(backup, /must survive migration/);
  const resumed = await migrateLegacyLibrary({ managerDir, projectRoot: root, libraryDir, resume: true });
  assert.equal(resumed.skipped, 1);
  assert.equal(resumed.skippedGroups, 1);
});

// 任务 366 返工 1：迁移搬的是内容门槛（366）之前就存在的旧数据，旧库里一张
// 「文本改名 .png」不许拦住整个迁移；假图照搬，和它在旧库里的状态一致。
test("migration skips the content sniff and carries pre-gate fake media over", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-migrate-sniff-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const managerDir = join(root, "mosa");
  const imageDir = join(managerDir, "assets", "default", "images");
  const metadataDir = join(managerDir, "assets", "default", "metadata");
  await mkdir(imageDir, { recursive: true });
  await mkdir(metadataDir, { recursive: true });
  await writeFile(join(imageDir, "real.png"), PNG);
  await writeFile(join(metadataDir, "real.json"), JSON.stringify({ id: "real", asset: "real.png", project_id: "default" }));
  await writeFile(join(imageDir, "old-fake.png"), "plain text that predates the content gate");
  await writeFile(join(metadataDir, "old-fake.json"), JSON.stringify({ id: "old-fake", asset: "old-fake.png", project_id: "default" }));

  const libraryDir = join(root, "library");
  const report = await migrateLegacyLibrary({ managerDir, projectRoot: root, libraryDir });
  assert.equal(report.completed, true);
  assert.equal(report.imported, 2, "both the real image and the legacy fake migrate");
  assert.equal(report.issues.length, 0);

  const store = createSqliteAssetStore({ managerDir, projectRoot: root, libraryDir });
  const migratedFake = await store.getAsset("default", "old-fake");
  const storedBytes = await readFile(migratedFake.image_path);
  store.close();
  assert.equal(storedBytes.toString("utf8"), "plain text that predates the content gate", "the legacy file is carried over as it was");
});

test("without the migration flag the same fake media is still rejected by the sniff", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-migrate-noflag-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const managerDir = join(root, "mosa");
  const libraryDir = join(root, "library");
  const store = createSqliteAssetStore({ projectRoot: root, managerDir, libraryDir });
  t.after(() => store.close());

  const fakePath = join(root, "old-fake.png");
  await writeFile(fakePath, "plain text that predates the content gate");
  await assert.rejects(store.createAsset({ imagePath: fakePath }), (error) => {
    assert.equal(error.code, "IMAGE_CONTENT_NOT_MEDIA");
    assert.equal(error.statusCode, 400);
    return true;
  });
  assert.equal((await store.listAssets({ projectId: "default" })).length, 0);
});

test("completed migrations fail closed when mosa.db disappears instead of reopening stale JSON", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-migrate-missing-db-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const managerDir = join(root, "mosa");
  const imageDir = join(managerDir, "assets", "default", "images");
  const metadataDir = join(managerDir, "assets", "default", "metadata");
  await mkdir(imageDir, { recursive: true });
  await mkdir(metadataDir, { recursive: true });
  await writeFile(join(imageDir, "legacy.png"), PNG);
  await writeFile(join(metadataDir, "legacy.json"), JSON.stringify({ id: "legacy", asset: "legacy.png", project_id: "default" }));
  const libraryDir = join(root, "library");
  const report = await migrateLegacyLibrary({ managerDir, projectRoot: root, libraryDir });
  assert.equal(report.completed, true);
  await rm(join(libraryDir, "mosa.db"), { force: true });
  await rm(join(libraryDir, "mosa.db-wal"), { force: true });
  await rm(join(libraryDir, "mosa.db-shm"), { force: true });
  assert.throws(
    () => createAssetStore({ projectRoot: root, managerDir, libraryDir }),
    (error) => error?.code === "SQLITE_LIBRARY_MISSING",
  );
});

test("a backup directory alone does not claim a failed migration completed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-migrate-backup-only-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const managerDir = join(root, "mosa");
  const imageDir = join(managerDir, "assets", "default", "images");
  const metadataDir = join(managerDir, "assets", "default", "metadata");
  await mkdir(imageDir, { recursive: true });
  await mkdir(metadataDir, { recursive: true });
  await writeFile(join(imageDir, "legacy.png"), PNG);
  await writeFile(join(metadataDir, "legacy.json"), JSON.stringify({ id: "legacy", asset: "legacy.png", project_id: "default" }));
  const libraryDir = join(root, "library");
  await mkdir(join(libraryDir, "legacy-json-backup", "failed-attempt"), { recursive: true });

  const store = createAssetStore({ projectRoot: root, managerDir, libraryDir, explicitLibraryDir: null });
  assert.equal(store.storageKind, "json");
  assert.equal((await store.listAssets({ projectId: "default" })).length, 1);
});

test("corrupt legacy JSON blocks migration and identifies the exact file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-migrate-corrupt-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const managerDir = join(root, "mosa");
  const corruptPath = join(managerDir, "assets", "default", "metadata", "broken.json");
  await mkdir(join(managerDir, "assets", "default", "metadata"), { recursive: true });
  await writeFile(corruptPath, "{ not json");
  const inspection = await inspectLegacyLibrary({ managerDir });
  assert.deepEqual(inspection.issues.map((issue) => issue.kind), ["corrupt-json"]);
  assert.equal(inspection.issues[0].path, corruptPath);
  const report = await migrateLegacyLibrary({ managerDir, projectRoot: root, libraryDir: join(root, "library") });
  assert.equal(report.completed, false);
  assert.equal(report.issues[0].path, corruptPath);
});

test("corrupt groups JSON blocks migration and identifies the exact file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-migrate-groups-corrupt-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const managerDir = join(root, "mosa");
  const groupsPath = join(managerDir, "assets", "default", "groups.json");
  await mkdir(join(managerDir, "assets", "default"), { recursive: true });
  await writeFile(groupsPath, "{ not json");
  const report = await migrateLegacyLibrary({ managerDir, projectRoot: root, libraryDir: join(root, "library") });
  assert.equal(report.completed, false);
  assert.deepEqual(report.issues.map((issue) => issue.kind), ["corrupt-groups-json"]);
  assert.equal(report.issues[0].path, groupsPath);
});

test("migration orders version parents before children and preserves the tree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-migrate-versions-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const managerDir = join(root, "mosa");
  const metadataDir = join(managerDir, "assets", "default", "metadata");
  const imagesDir = join(managerDir, "assets", "default", "images");
  await mkdir(metadataDir, { recursive: true });
  await mkdir(imagesDir, { recursive: true });
  await writeFile(join(imagesDir, "parent.png"), PNG);
  await writeFile(join(imagesDir, "child.png"), PNG);
  await writeFile(join(metadataDir, "a-child.json"), JSON.stringify({
    id: "child",
    project_id: "default",
    asset: "child.png",
    prompt: "child prompt",
    parent_asset_id: "parent",
    version_change: "palette pass",
  }));
  await writeFile(join(metadataDir, "z-parent.json"), JSON.stringify({
    id: "parent",
    project_id: "default",
    asset: "parent.png",
    prompt: "parent prompt",
  }));

  const libraryDir = join(root, "library");
  const report = await migrateLegacyLibrary({ managerDir, projectRoot: root, libraryDir });
  assert.equal(report.completed, true);
  assert.equal(report.imported, 2);
  const store = createSqliteAssetStore({ managerDir, projectRoot: root, libraryDir });
  const history = await store.getAssetVersionHistory("default", "child");
  store.close();
  assert.deepEqual(history.versions.map((asset) => asset.id), ["parent", "child"]);
  assert.equal(history.versions[1].version_change, "palette pass");
});

test("migration reports invalid legacy version relationships without writing SQLite assets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-migrate-invalid-version-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const managerDir = join(root, "mosa");
  const metadataDir = join(managerDir, "assets", "default", "metadata");
  const imagesDir = join(managerDir, "assets", "default", "images");
  await mkdir(metadataDir, { recursive: true });
  await mkdir(imagesDir, { recursive: true });
  await writeFile(join(imagesDir, "orphan.png"), PNG);
  await writeFile(join(metadataDir, "orphan.json"), JSON.stringify({
    id: "orphan",
    project_id: "default",
    asset: "orphan.png",
    parent_asset_id: "missing",
  }));

  const report = await migrateLegacyLibrary({ managerDir, projectRoot: root, libraryDir: join(root, "library") });
  assert.equal(report.completed, false);
  assert.deepEqual(report.issues.map((issue) => issue.kind), ["version-parent-missing"]);
  assert.equal(report.backupPath, null);
});

test("migration blocks duplicate asset IDs before and after normalization", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-migrate-duplicate-ids-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const cases = [
    ["same", "same"],
    ["same value", "same@value"],
  ];

  for (const [index, ids] of cases.entries()) {
    const managerDir = join(root, `case-${index}`, "mosa");
    const metadataDir = join(managerDir, "assets", "default", "metadata");
    const imagesDir = join(managerDir, "assets", "default", "images");
    await mkdir(metadataDir, { recursive: true });
    await mkdir(imagesDir, { recursive: true });
    await Promise.all([
      writeFile(join(imagesDir, "first.png"), PNG),
      writeFile(join(imagesDir, "second.png"), PNG),
      writeFile(join(metadataDir, "first.json"), JSON.stringify({ id: ids[0], project_id: "default", asset: "first.png" })),
      writeFile(join(metadataDir, "second.json"), JSON.stringify({ id: ids[1], project_id: "default", asset: "second.png" })),
    ]);

    const inspection = await inspectLegacyLibrary({ managerDir });
    assert.equal(inspection.records.length, 2);
    assert.deepEqual(inspection.issues.map((issue) => issue.kind), ["duplicate-asset-id"]);
    assert.match(inspection.issues[0].detail, /after normalization/);
    const report = await migrateLegacyLibrary({ managerDir, projectRoot: join(root, `case-${index}`), libraryDir: join(root, `library-${index}`) });
    assert.equal(report.completed, false);
    assert.equal(report.backupPath, null);
  }
});

test("migration allows the same asset ID in distinct projects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-migrate-cross-project-ids-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const managerDir = join(root, "mosa");
  for (const projectId of ["alpha", "beta"]) {
    const metadataDir = join(managerDir, "assets", projectId, "metadata");
    const imagesDir = join(managerDir, "assets", projectId, "images");
    await mkdir(metadataDir, { recursive: true });
    await mkdir(imagesDir, { recursive: true });
    await writeFile(join(imagesDir, "shared.png"), PNG);
    await writeFile(join(metadataDir, "shared.json"), JSON.stringify({ id: "shared", project_id: projectId, asset: "shared.png" }));
  }
  const inspection = await inspectLegacyLibrary({ managerDir });
  assert.equal(inspection.records.length, 2);
  assert.deepEqual(inspection.issues, []);
});

test("migration reports cross-project parents and multi-node cycles", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-migrate-invalid-graphs-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const managerDir = join(root, "mosa");
  const records = [
    ["default", "a", "b"],
    ["default", "b", "a"],
    ["default", "cross", "foreign"],
    ["other", "foreign", null],
  ];
  for (const [projectId, assetId, parentAssetId] of records) {
    const metadataDir = join(managerDir, "assets", projectId, "metadata");
    const imagesDir = join(managerDir, "assets", projectId, "images");
    await mkdir(metadataDir, { recursive: true });
    await mkdir(imagesDir, { recursive: true });
    await writeFile(join(imagesDir, `${assetId}.png`), PNG);
    await writeFile(join(metadataDir, `${assetId}.json`), JSON.stringify({
      id: assetId,
      project_id: projectId,
      asset: `${assetId}.png`,
      ...(parentAssetId ? { parent_asset_id: parentAssetId } : {}),
    }));
  }

  const inspection = await inspectLegacyLibrary({ managerDir });
  const kinds = inspection.issues.map((issue) => issue.kind);
  assert.ok(kinds.includes("version-project-mismatch"));
  assert.ok(kinds.includes("version-cycle"));
  const report = await migrateLegacyLibrary({ managerDir, projectRoot: root, libraryDir: join(root, "library") });
  assert.equal(report.completed, false);
  assert.equal(report.backupPath, null);
});

test("migration turns hard-linked Codex assets into copies that re-linking reclaims", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-migrate-hardlink-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const codexImagesDir = join(root, ".codex", "generated_images");
  const codexPath = join(codexImagesDir, "task-1", "generated.png");
  await mkdir(join(codexImagesDir, "task-1"), { recursive: true });
  await writeFile(codexPath, PNG);

  const legacy = createJsonAssetStore({ projectRoot, managerDir, codexImagesDir });
  const imported = await legacy.createAsset({ assetId: "codex-legacy", imagePath: codexPath, prompt: "a linked import" });
  assert.equal(imported.source.storage_mode, "hard-link");
  assert.equal((await stat(imported.image_path)).ino, (await stat(codexPath)).ino);

  // Migration re-imports each record from the legacy *library* file, not from the Codex path,
  // so `createAsset` sees a non-Codex source and copies. Every previously linked asset lands
  // in the new library as a second set of bytes.
  const libraryDir = join(root, "library");
  const report = await migrateLegacyLibrary({ managerDir, projectRoot, libraryDir });
  assert.equal(report.completed, true);

  const store = createAssetStore({ projectRoot, managerDir, libraryDir });
  t.after(() => store.close());
  assert.equal(store.storageKind, "sqlite", "a completed migration must route the maintenance pass to SQLite");
  const migrated = await store.getAsset("default", "codex-legacy");
  assert.equal(migrated.source.type, "codex-generated");
  assert.equal(migrated.source.storage_mode, "copy");
  assert.notEqual((await stat(migrated.image_path)).ino, (await stat(codexPath)).ino);

  const result = await store.migrateCodexAssetsToHardLinks("default");
  assert.deepEqual(result.migrated, ["codex-legacy"]);
  assert.equal((await stat(migrated.image_path)).ino, (await stat(codexPath)).ino, "the duplicated bytes are reclaimed");
  assert.equal((await store.getAsset("default", "codex-legacy")).source.storage_mode, "hard-link");
  assert.equal((await verifySqliteLibrary({ managerDir, projectRoot, libraryDir })).ok, true);
});
