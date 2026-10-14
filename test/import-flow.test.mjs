import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createJsonAssetStore, SUPPORTED_MEDIA_EXTENSIONS } from "../lib/asset-store.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";

const root = resolve(import.meta.dirname, "..");
const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

async function makeWorkspace(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(dir, { recursive: true, force: true });
  const projectRoot = join(dir, "project");
  const generated = join(projectRoot, "generated-images");
  await mkdir(generated, { recursive: true });
  const imagePath = join(generated, "fixture.png");
  await writeFile(imagePath, ONE_PIXEL_PNG);
  return { dir, projectRoot, generated, imagePath };
}

for (const kind of ["json", "sqlite"]) {
  test(`${kind} store tags every import rejection with the field that caused it`, async (t) => {
    const { dir, projectRoot, generated, imagePath } = await makeWorkspace(t, `mosa-import-${kind}-`);
    const store = kind === "sqlite"
      ? createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir: join(dir, "library") })
      : createJsonAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa") });
    if (kind === "sqlite") t.after(() => store.close());

    // Codes let the form place each message; the prose stays as it was.
    await assert.rejects(store.createAsset({}), (error) => {
      assert.equal(error.code, "IMAGE_PATH_REQUIRED");
      assert.equal(error.statusCode, 400);
      return true;
    });

    await assert.rejects(store.createAsset({ imagePath: join(generated, "missing.png") }), (error) => {
      assert.equal(error.code, "IMAGE_PATH_NOT_FOUND");
      assert.equal(error.statusCode, 400);
      return true;
    });

    const textPath = join(generated, "notes.txt");
    await writeFile(textPath, "not an image");
    await assert.rejects(store.createAsset({ imagePath: textPath }), (error) => {
      assert.equal(error.code, "IMAGE_PATH_UNSUPPORTED_TYPE");
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /Unsupported media type/);
      return true;
    });

    const linkPath = join(generated, "link.png");
    await symlink(imagePath, linkPath);
    await assert.rejects(store.createAsset({ imagePath: linkPath }), (error) => {
      assert.equal(error.code, "IMAGE_PATH_NOT_READABLE");
      assert.match(error.message, /Refusing to import symbolic links/);
      return true;
    });

    const outsideDir = await mkdtemp(join(tmpdir(), `mosa-import-outside-${kind}-`));
    deferTestPathRemoval(outsideDir, { recursive: true, force: true });
    const outsidePath = join(outsideDir, "outside.png");
    await writeFile(outsidePath, ONE_PIXEL_PNG);
    await assert.rejects(store.createAsset({ imagePath: outsidePath }), (error) => {
      assert.equal(error.code, "IMAGE_PATH_NOT_READABLE");
      assert.match(error.message, /Refusing to import outside the project roots/);
      return true;
    });

    // A valid import still succeeds with only a path.
    const asset = await store.createAsset({ imagePath });
    assert.ok(asset.id);
  });
}

test("import rejections reach the client as 400 with a code, and the format list is served", async (t) => {
  const { dir, projectRoot, generated, imagePath } = await makeWorkspace(t, "mosa-import-api-");
  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: dir,
    libraryDir: join(dir, "library"),
    assetsRoot: join(dir, "assets"),
    generatedImagesDir: generated,
    codexImagesDir: join(dir, "codex-images"),
    codexSessionsDir: join(dir, "sessions"),
    grokSessionsDir: join(dir, "grok-sessions"),
    cowartCanvasDir: join(dir, "cowart-data"),
    cowartRegistryPath: join(dir, "state", "cowart-projects.json"),
  });
  t.after(() => runtime.stop());

  const post = (body) => fetch(`${runtime.url}/api/assets/create`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  const missingPath = await post({ projectId: "default" });
  assert.equal(missingPath.status, 400);
  assert.equal((await missingPath.json()).code, "IMAGE_PATH_REQUIRED");

  const notFound = await post({ projectId: "default", imagePath: join(generated, "nope.png") });
  assert.equal(notFound.status, 400);
  assert.equal((await notFound.json()).code, "IMAGE_PATH_NOT_FOUND");

  const textPath = join(generated, "notes.txt");
  await writeFile(textPath, "not an image");
  const unsupported = await post({ projectId: "default", imagePath: textPath });
  assert.equal(unsupported.status, 400);
  assert.equal((await unsupported.json()).code, "IMAGE_PATH_UNSUPPORTED_TYPE");

  // The hint is served rather than duplicated in the client, so it cannot claim
  // a format the store would reject.
  const library = await (await fetch(`${runtime.url}/api/library-path`)).json();
  assert.deepEqual(library.supportedMediaExtensions, SUPPORTED_MEDIA_EXTENSIONS);
  assert.ok(library.supportedMediaExtensions.includes(".png"));
  assert.ok(library.supportedMediaExtensions.includes(".mp4"));

  const created = await post({ projectId: "default", imagePath });
  assert.equal(created.status, 200);
  const asset = (await created.json()).asset;

  // Quick collection accepts a bounded batch and isolates individual failures
  // instead of aborting the whole drop when one file is bad.
  const batchImageA = join(generated, "batch-a.png");
  const batchImageB = join(generated, "batch-b.png");
  await writeFile(batchImageA, ONE_PIXEL_PNG);
  await writeFile(batchImageB, ONE_PIXEL_PNG);
  const importedBatch = await fetch(`${runtime.url}/api/assets/import-batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: "default",
      items: [
        { imagePath: batchImageA, fileName: "batch-a.png" },
        { imagePath: join(generated, "missing-batch.png"), fileName: "missing-batch.png" },
        { imagePath: batchImageB, fileName: "batch-b.png" },
      ],
    }),
  });
  assert.equal(importedBatch.status, 200);
  const importedBatchBody = await importedBatch.json();
  assert.equal(importedBatchBody.imported, 2);
  assert.equal(importedBatchBody.failed, 1);
  assert.deepEqual(importedBatchBody.results.map((item) => item.ok), [true, false, true]);
  assert.equal(importedBatchBody.results[1].code, "IMAGE_PATH_NOT_FOUND");

  const batch = (body) => fetch(`${runtime.url}/api/assets/batch`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  // A batch "Favorite" is idempotent. It never unfavorites a selected asset.
  const favorite = await batch({ action: "favorite", projectId: "default", assetIds: [asset.id] });
  assert.equal(favorite.status, 200);
  assert.deepEqual((await favorite.json()).results, [{ id: asset.id, favorite: true }]);
  const favoriteAgain = await batch({ action: "favorite", projectId: "default", assetIds: [asset.id] });
  assert.equal(favoriteAgain.status, 200);
  assert.deepEqual((await favoriteAgain.json()).results, [{ id: asset.id, favorite: true }]);
  const unfavorite = await batch({ action: "favorite", favorite: false, projectId: "default", assetIds: [asset.id] });
  assert.equal(unfavorite.status, 200);
  assert.deepEqual((await unfavorite.json()).results, [{ id: asset.id, favorite: false }]);

  const grouped = await batch({ action: "group", projectId: "default", assetIds: [asset.id], group: "Selected" });
  assert.equal(grouped.status, 200);
  assert.deepEqual((await grouped.json()).results, [{ id: asset.id, group: "Selected" }]);
  const groupedAsset = await (await fetch(`${runtime.url}/api/assets/default/${encodeURIComponent(asset.id)}`)).json();
  assert.equal(groupedAsset.asset.group, "Selected");
  const invalidGroup = await batch({ action: "group", projectId: "default", assetIds: [asset.id], group: { invalid: true } });
  assert.equal(invalidGroup.status, 400);
  assert.match((await invalidGroup.json()).error, /group must be a string/);

  const invalidBatch = await batch({ action: "delete", projectId: "default", assetIds: [asset.id] });
  assert.equal(invalidBatch.status, 400);
  const archive = await batch({ action: "archive", projectId: "default", assetIds: [asset.id] });
  assert.equal(archive.status, 200);
  assert.deepEqual((await archive.json()).results, [{ id: asset.id, archived: true }]);

  const deleted = await fetch(`${runtime.url}/api/assets/default/${encodeURIComponent(asset.id)}`, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  const deletedResult = (await deleted.json()).result;
  assert.deepEqual({ ...deletedResult, deleted_at: Boolean(deletedResult.deleted_at) }, {
    id: asset.id,
    project_id: "default",
    deleted: true,
    trashed: true,
    deleted_at: true,
  });
  const retained = await fetch(`${runtime.url}/api/assets/default/${encodeURIComponent(asset.id)}`);
  assert.equal(retained.status, 200);
  assert.equal(Boolean((await retained.json()).asset.deleted_at), true);
});

test("Trash HTTP lifecycle hides, restores, and permanently deletes an asset", async (t) => {
  const { dir, generated, imagePath } = await makeWorkspace(t, "mosa-trash-api-");
  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: dir,
    libraryDir: join(dir, "library"),
    assetsRoot: join(dir, "assets"),
    generatedImagesDir: generated,
    codexImagesDir: join(dir, "codex-images"),
    codexSessionsDir: join(dir, "sessions"),
    grokSessionsDir: join(dir, "grok-sessions"),
    cowartCanvasDir: join(dir, "cowart-data"),
    cowartRegistryPath: join(dir, "state", "cowart-projects.json"),
  });
  t.after(() => runtime.stop());

  const createdResponse = await fetch(`${runtime.url}/api/assets/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "default", imagePath }),
  });
  assert.equal(createdResponse.status, 200);
  const asset = (await createdResponse.json()).asset;
  const assetUrl = `${runtime.url}/api/assets/default/${encodeURIComponent(asset.id)}`;

  assert.equal((await fetch(assetUrl, { method: "DELETE" })).status, 200);
  const activeAfterDelete = await (await fetch(`${runtime.url}/api/assets?project=default&limit=100`)).json();
  assert.equal(activeAfterDelete.assets.some((item) => item.id === asset.id), false);
  const trashAfterDelete = await (await fetch(`${runtime.url}/api/assets?project=default&trash=1&limit=100`)).json();
  assert.equal(trashAfterDelete.assets.some((item) => item.id === asset.id), true);
  assert.ok(trashAfterDelete.assets.find((item) => item.id === asset.id)?.deleted_at);

  const restored = await fetch(`${assetUrl}/restore`, { method: "POST" });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).asset.deleted_at, null);
  const activeAfterRestore = await (await fetch(`${runtime.url}/api/assets?project=default&limit=100`)).json();
  assert.equal(activeAfterRestore.assets.some((item) => item.id === asset.id), true);

  assert.equal((await fetch(assetUrl, { method: "DELETE" })).status, 200);
  const permanent = await fetch(`${assetUrl}/permanent`, { method: "DELETE" });
  assert.equal(permanent.status, 200);
  assert.equal((await permanent.json()).result.permanent, true);
  assert.equal((await fetch(assetUrl)).status, 404);
  const trashAfterPermanentDelete = await (await fetch(`${runtime.url}/api/assets?project=default&trash=1&limit=100`)).json();
  assert.equal(trashAfterPermanentDelete.assets.some((item) => item.id === asset.id), false);
});

test("batch Trash removes a selected version chain child-first in one request", async (t) => {
  const { dir, generated, imagePath } = await makeWorkspace(t, "mosa-trash-batch-api-");
  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: dir,
    libraryDir: join(dir, "library"),
    assetsRoot: join(dir, "assets"),
    generatedImagesDir: generated,
    codexImagesDir: join(dir, "codex-images"),
    codexSessionsDir: join(dir, "sessions"),
    grokSessionsDir: join(dir, "grok-sessions"),
    cowartCanvasDir: join(dir, "cowart-data"),
    cowartRegistryPath: join(dir, "state", "cowart-projects.json"),
  });
  t.after(() => runtime.stop());

  const createdResponse = await fetch(`${runtime.url}/api/assets/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "default", imagePath, assetId: "trash-parent" }),
  });
  assert.equal(createdResponse.status, 200);
  const parent = (await createdResponse.json()).asset;
  const childResponse = await fetch(`${runtime.url}/api/assets/default/${encodeURIComponent(parent.id)}/versions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assetId: "trash-child", imagePath, version_change: "Batch Trash child" }),
  });
  assert.equal(childResponse.status, 201);
  const child = (await childResponse.json()).asset;

  // Deliberately submit parent first. The batch route must still trash the
  // child first so the parent's version-dependency guard remains intact.
  const batchResponse = await fetch(`${runtime.url}/api/assets/batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "trash", projectId: "default", assetIds: [parent.id, child.id] }),
  });
  assert.equal(batchResponse.status, 200);
  const batch = await batchResponse.json();
  assert.equal(batch.partial, false);
  assert.deepEqual(batch.results.map((item) => [item.id, item.trashed]), [[parent.id, true], [child.id, true]]);

  const active = await (await fetch(`${runtime.url}/api/assets?project=default&limit=100`)).json();
  assert.equal(active.assets.some((item) => item.id === parent.id || item.id === child.id), false);
  const trash = await (await fetch(`${runtime.url}/api/assets?project=default&trash=1&limit=100`)).json();
  assert.deepEqual(trash.assets.filter((item) => item.id === parent.id || item.id === child.id).map((item) => item.id).sort(), [parent.id, child.id].sort());
});




