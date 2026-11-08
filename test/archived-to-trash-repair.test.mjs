import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createAssetStore } from "../lib/asset-store.mjs";
import { createMcpWorkspace, writePngFixture } from "./helpers/mcp-server-harness.mjs";

test("archived-to-trash repair moves archived assets to trash, unsets archived, respects version dependencies, and writes marker", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const store = createAssetStore({
    projectRoot: workspace.root,
    managerDir: workspace.root,
    libraryDir: workspace.libraryDir,
    explicitLibraryDir: workspace.libraryDir,
    assetsRoot: join(workspace.libraryDir, "assets"),
    generatedImagesDir: join(workspace.libraryDir, "imports"),
  });
  t.after(() => store.close());

  const pathA = await writePngFixture(join(workspace.imagesDir, "a.png"), { color: "#111111" });
  const pathB = await writePngFixture(join(workspace.imagesDir, "b.png"), { color: "#222222" });
  const pathBChild = await writePngFixture(join(workspace.imagesDir, "b-child.png"), { color: "#333333" });
  const pathC = await writePngFixture(join(workspace.imagesDir, "c.png"), { color: "#444444" });
  const pathD = await writePngFixture(join(workspace.imagesDir, "d.png"), { color: "#555555" });

  // A: Archived
  await store.createAsset({ assetId: "asset-a", imagePath: pathA });
  await store.archiveAsset("default", "asset-a");

  // B: Archived version parent with active child
  await store.createAsset({ assetId: "asset-b", imagePath: pathB });
  await store.createAssetVersion("default", "asset-b", { assetId: "asset-b-child", imagePath: pathBChild, version_change: "child of b" });
  await store.archiveAsset("default", "asset-b");

  // C: Archived and already in trash
  await store.createAsset({ assetId: "asset-c", imagePath: pathC });
  await store.archiveAsset("default", "asset-c");
  const cDeleted = await store.deleteAsset("default", "asset-c", { reason: "prior-trash" });

  // D: Normal asset
  await store.createAsset({ assetId: "asset-d", imagePath: pathD });

  const metaBefore = await store.migrationStatus();
  assert.equal(metaBefore.archived_to_trash_repair_v1, undefined);

  // Run repair
  await store.startDeferredMaintenance();

  // A: in Trash, archived is false, restorable and visible in library
  const a = await store.getAsset("default", "asset-a");
  assert.equal(a.archived, false, "A archived is false");
  assert.ok(a.deleted_at, "A is in trash");
  const aRestored = await store.restoreAsset("default", "asset-a");
  assert.equal(aRestored.archived, false);
  assert.equal(aRestored.deleted_at, null);
  const activeList = await store.listAssets({ projectId: "default" });
  assert.ok(activeList.some((x) => x.id === "asset-a"), "restored A visible in active list");

  // B: in library, archived is false
  const b = await store.getAsset("default", "asset-b");
  assert.equal(b.archived, false, "B archived is false");
  assert.equal(b.deleted_at, null, "B deleted_at is null");
  assert.ok(activeList.some((x) => x.id === "asset-b"), "B visible in active list");

  // C: in trash, deleted_at unchanged, archived is false
  const c = await store.getAsset("default", "asset-c");
  assert.equal(c.archived, false, "C archived is false");
  assert.equal(c.deleted_at, cDeleted.deleted_at, "C deleted_at unchanged");

  // D: untouched
  const d = await store.getAsset("default", "asset-d");
  assert.equal(d.archived, false);
  assert.equal(d.deleted_at, null);

  const metaAfter = await store.migrationStatus();
  assert.ok(metaAfter.archived_to_trash_repair_v1, "marker is written");

  // Reopening does not change anything
  await store.close();
  const store2 = createAssetStore({
    projectRoot: workspace.root,
    managerDir: workspace.root,
    libraryDir: workspace.libraryDir,
    explicitLibraryDir: workspace.libraryDir,
    assetsRoot: join(workspace.libraryDir, "assets"),
    generatedImagesDir: join(workspace.libraryDir, "imports"),
  });
  t.after(() => store2.close());
  await store2.startDeferredMaintenance();
  const metaReopened = await store2.migrationStatus();
  assert.equal(metaReopened.archived_to_trash_repair_v1, metaAfter.archived_to_trash_repair_v1, "marker is written only once");
});

function openStore(workspace) {
  return createAssetStore({
    projectRoot: workspace.root,
    managerDir: workspace.root,
    libraryDir: workspace.libraryDir,
    explicitLibraryDir: workspace.libraryDir,
    assetsRoot: join(workspace.libraryDir, "assets"),
    generatedImagesDir: join(workspace.libraryDir, "imports"),
  });
}

test("archived-to-trash repair keeps an asset it cannot trash visible in the library and still finishes", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const store = openStore(workspace);

  for (const [id, color] of [["keep-1", "#444444"], ["keep-2", "#555555"], ["keep-3", "#666666"]]) {
    const imagePath = await writePngFixture(join(workspace.imagesDir, `${id}.png`), { color });
    await store.createAsset({ assetId: id, imagePath });
    await store.archiveAsset("default", id);
  }

  // Moving keep-2 to Trash fails; the repair must neither hide it again nor stop.
  const realDelete = store.deleteAsset.bind(store);
  store.deleteAsset = async (projectId, assetId, context) => {
    if (assetId === "keep-2") {
      const error = new Error("Injected move-to-trash failure");
      error.code = "INJECTED_TRASH_FAILURE";
      throw error;
    }
    return realDelete(projectId, assetId, context);
  };

  await store.startDeferredMaintenance();
  const meta = await store.migrationStatus();
  assert.ok(meta.archived_to_trash_repair_v1, "marker written: nothing is left hidden");

  for (const id of ["keep-1", "keep-3"]) {
    const asset = await store.getAsset("default", id);
    assert.equal(asset.archived, false, `${id} archived is false`);
    assert.ok(asset.deleted_at, `${id} is in trash`);
  }
  const kept = await store.getAsset("default", "keep-2");
  assert.equal(kept.archived, false, "keep-2 is no longer hidden");
  assert.ok(!kept.deleted_at, "keep-2 stays in the library");
  const visibleIds = (await store.listAssets({ projectId: "default" })).map((asset) => asset.id);
  assert.ok(visibleIds.includes("keep-2"), "keep-2 shows in the library listing");

  await store.close();
  const reopened = openStore(workspace);
  t.after(() => reopened.close());
  await reopened.startDeferredMaintenance();
  const metaReopened = await reopened.migrationStatus();
  assert.equal(metaReopened.archived_to_trash_repair_v1, meta.archived_to_trash_repair_v1, "repair does not run again");
  const keptAfterReopen = await reopened.getAsset("default", "keep-2");
  assert.ok(!keptAfterReopen.deleted_at, "keep-2 still in the library after reopening");
});

test("archived-to-trash repair mid-way failure does not write marker and completes on next open", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const store = createAssetStore({
    projectRoot: workspace.root,
    managerDir: workspace.root,
    libraryDir: workspace.libraryDir,
    explicitLibraryDir: workspace.libraryDir,
    assetsRoot: join(workspace.libraryDir, "assets"),
    generatedImagesDir: join(workspace.libraryDir, "imports"),
  });

  const p1 = await writePngFixture(join(workspace.imagesDir, "f1.png"), { color: "#111111" });
  const p2 = await writePngFixture(join(workspace.imagesDir, "f2.png"), { color: "#222222" });
  const p3 = await writePngFixture(join(workspace.imagesDir, "f3.png"), { color: "#333333" });

  await store.createAsset({ assetId: "fail-1", imagePath: p1 });
  await store.archiveAsset("default", "fail-1");

  await store.createAsset({ assetId: "fail-2", imagePath: p2 });
  await store.archiveAsset("default", "fail-2");

  await store.createAsset({ assetId: "fail-3", imagePath: p3 });
  await store.archiveAsset("default", "fail-3");

  // A failure before fail-2 is un-hidden (reading it) aborts the whole repair.
  const realGetAsset = store.getAsset.bind(store);
  let injected = false;
  store.getAsset = async (projectId, assetId, ...rest) => {
    if (assetId === "fail-2" && !injected) {
      injected = true;
      throw new Error("Injected transient failure reading fail-2");
    }
    return realGetAsset(projectId, assetId, ...rest);
  };

  await store.startDeferredMaintenance();
  assert.equal(injected, true, "the failure was injected");
  const meta = await store.migrationStatus();
  assert.equal(meta.archived_to_trash_repair_v1, undefined, "marker not written on failure");
  const untouched = await realGetAsset("default", "fail-2");
  assert.equal(untouched.archived, true, "fail-2 untouched until the next open");
  assert.ok(!untouched.deleted_at, "fail-2 not trashed yet");

  await store.close();

  // Reopen cleanly and finish remaining work
  const store2 = createAssetStore({
    projectRoot: workspace.root,
    managerDir: workspace.root,
    libraryDir: workspace.libraryDir,
    explicitLibraryDir: workspace.libraryDir,
    assetsRoot: join(workspace.libraryDir, "assets"),
    generatedImagesDir: join(workspace.libraryDir, "imports"),
  });
  t.after(() => store2.close());

  await store2.startDeferredMaintenance();
  const meta2 = await store2.migrationStatus();
  assert.ok(meta2.archived_to_trash_repair_v1, "marker written after second open completes");

  for (const id of ["fail-1", "fail-2", "fail-3"]) {
    const asset = await store2.getAsset("default", id);
    assert.equal(asset.archived, false, `${id} archived is false`);
    assert.ok(asset.deleted_at, `${id} is in trash`);
  }
});
