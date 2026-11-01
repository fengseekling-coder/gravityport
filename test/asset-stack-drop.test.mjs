import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { uniquePngBytes } from "./helpers/unique-image.mjs";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

async function createFixtureStore(t, assetIds = ["a1", "a2", "a3", "b1", "b2", "c1", "c2", "p", "q"]) {
  const root = await mkdtemp(join(tmpdir(), "mosa-stack-drop-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  const generatedDir = join(projectRoot, "generated-images");
  await mkdir(generatedDir, { recursive: true });
  const sourcePath = join(generatedDir, "fixture.png");
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => store.close());
  for (const [index, id] of assetIds.entries()) {
    await store.createAsset({
      assetId: id,
      imagePath: sourcePath,
      prompt: `stack drop fixture ${id}`,
      created_at: `2026-08-29T12:0${index}:00.000Z`,
      source: { type: "local-file" },
    });
  }
  return { store, sourcePath, libraryDir };
}

async function memberIds(store, projectId, stackId) {
  return (await store.listAssetStackAssets(projectId, stackId)).assets.map((asset) => asset.id);
}

test("1. dropAssetsOnAsset moves an asset from stack A to stack B", async (t) => {
  const { store } = await createFixtureStore(t);
  const stackA = await store.createAssetStack("default", ["a1", "a2", "a3"], { coverAssetId: "a1" });
  await store.renameAssetStack("default", stackA.id, "甲");
  const stackB = await store.createAssetStack("default", ["b1", "b2"], { coverAssetId: "b1" });

  const result = await store.dropAssetsOnAsset("default", ["a2"], "b1");

  assert.equal(result.mode, "joined");
  assert.equal(result.stack.id, stackB.id);
  assert.deepEqual(result.movedAssetIds, ["a2"]);
  assert.deepEqual(result.previouslyLooseAssetIds, []);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].stackId, stackA.id);
  assert.equal(result.sources[0].name, "甲");
  assert.deepEqual(result.sources[0].memberIdsBefore, ["a1", "a2", "a3"]);
  assert.deepEqual(result.sources[0].movedAssetIds, ["a2"]);
  assert.equal(result.sources[0].dissolved, false);
  assert.equal(result.sources[0].remainingAssetId, null);

  assert.deepEqual(await memberIds(store, "default", stackB.id), ["b1", "b2", "a2"]);
  assert.deepEqual(await memberIds(store, "default", stackA.id), ["a1", "a3"]);
});

test("2. target is a non-cover member in a stack, drop joins that stack", async (t) => {
  const { store } = await createFixtureStore(t);
  const stackA = await store.createAssetStack("default", ["a1", "a2", "a3"], { coverAssetId: "a1" });
  const stackB = await store.createAssetStack("default", ["b1", "b2"], { coverAssetId: "b1" });

  const result = await store.dropAssetsOnAsset("default", ["a1"], "b2");

  assert.equal(result.mode, "joined");
  assert.equal(result.stack.id, stackB.id);
  assert.deepEqual(result.movedAssetIds, ["a1"]);
  assert.deepEqual(await memberIds(store, "default", stackB.id), ["b1", "b2", "a1"]);
  assert.deepEqual(await memberIds(store, "default", stackA.id), ["a2", "a3"]);
});

test("3. target is a loose asset, drop creates a new stack", async (t) => {
  const { store } = await createFixtureStore(t);
  const stackA = await store.createAssetStack("default", ["a1", "a2", "a3"], { coverAssetId: "a1" });

  const result = await store.dropAssetsOnAsset("default", ["a1"], "p");

  assert.equal(result.mode, "created");
  assert.equal(result.stack.cover_asset_id, "p");
  assert.deepEqual(result.movedAssetIds, ["a1"], "created does not contain target asset in movedAssetIds");
  assert.deepEqual(await memberIds(store, "default", result.stack.id), ["p", "a1"]);
  assert.deepEqual(await memberIds(store, "default", stackA.id), ["a2", "a3"]);
});

test("4. source stack left with one member dissolves", async (t) => {
  const { store } = await createFixtureStore(t);
  const stackC = await store.createAssetStack("default", ["c1", "c2"], { coverAssetId: "c1" });
  const stackB = await store.createAssetStack("default", ["b1", "b2"], { coverAssetId: "b1" });

  const result = await store.dropAssetsOnAsset("default", ["c1"], "b1");

  assert.equal(result.mode, "joined");
  assert.equal(result.sources[0].dissolved, true);
  assert.equal(result.sources[0].remainingAssetId, "c2");
  assert.deepEqual(result.sources[0].memberIdsBefore, ["c1", "c2"]);
  await assert.rejects(store.getAssetStack("default", stackC.id), (err) => err.code === "STACK_NOT_FOUND");
  assert.deepEqual(await memberIds(store, "default", stackB.id), ["b1", "b2", "c1"]);
});

test("5. asset already in target stack yields noop with untouched library", async (t) => {
  const { store } = await createFixtureStore(t);
  const stackB = await store.createAssetStack("default", ["b1", "b2"], { coverAssetId: "b1" });

  const result = await store.dropAssetsOnAsset("default", ["b2"], "b1");

  assert.ok(result.mode === "noop" || result.movedAssetIds.length === 0);
  assert.deepEqual(await memberIds(store, "default", stackB.id), ["b1", "b2"]);
});

test("6. memberIdsBefore matches listAssetStackAssets and excludes trashed members", async (t) => {
  const { store } = await createFixtureStore(t);
  const stackA = await store.createAssetStack("default", ["a1", "a2", "a3"], { coverAssetId: "a1" });
  const stackB = await store.createAssetStack("default", ["b1", "b2"], { coverAssetId: "b1" });

  // Move a3 to trash
  await store.deleteAsset("default", "a3");

  const listBefore = (await store.listAssetStackAssets("default", stackA.id)).assets.map((a) => a.id);
  assert.deepEqual(listBefore, ["a1", "a2"]);

  const result = await store.dropAssetsOnAsset("default", ["a2"], "b1");
  assert.deepEqual(result.sources[0].memberIdsBefore, listBefore);
  assert.ok(!result.sources[0].memberIdsBefore.includes("a3"), "trashed asset excluded from memberIdsBefore");
});

test("7. route POST /api/asset-stacks/drop validates batch size and target", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-stack-drop-route-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const generated = join(root, "generated-images");
  await mkdir(generated, { recursive: true });
  for (const id of ["r1", "r2"]) {
    await writeFile(join(generated, `${id}.png`), await uniquePngBytes(1));
  }

  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: root,
    libraryDir: join(root, "library"),
    generatedImagesDir: generated,
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "sessions"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-data"),
    cowartRegistryPath: join(root, "state", "cowart-projects.json"),
  });
  t.after(() => runtime.stop());

  const headers = { "content-type": "application/json", "x-mosa-client-token": runtime.clientToken };

  // Empty array -> 400 STACK_MOVE_BATCH_SIZE_INVALID
  const emptyRes = await fetch(`${runtime.url}/api/asset-stacks/drop`, {
    method: "POST",
    headers,
    body: JSON.stringify({ projectId: "default", assetIds: [], targetAssetId: "r1" }),
  });
  assert.equal(emptyRes.status, 400);
  assert.equal((await emptyRes.json()).code, "STACK_MOVE_BATCH_SIZE_INVALID");

  // Non-existent target -> 404 ASSET_NOT_FOUND
  const notFoundRes = await fetch(`${runtime.url}/api/asset-stacks/drop`, {
    method: "POST",
    headers,
    body: JSON.stringify({ projectId: "default", assetIds: ["r1"], targetAssetId: "missing-target" }),
  });
  assert.equal(notFoundRes.status, 404);
  assert.equal((await notFoundRes.json()).code, "ASSET_NOT_FOUND");
});

test("8. moveAssetsToStack new fields: previouslyLooseAssetIds and sources details", async (t) => {
  const { store } = await createFixtureStore(t);
  const stackA = await store.createAssetStack("default", ["a1", "a2", "a3"], { coverAssetId: "a1" });
  await store.renameAssetStack("default", stackA.id, "源堆叠");
  const stackB = await store.createAssetStack("default", ["b1", "b2"], { coverAssetId: "b1" });

  // Move a2 from stackA and p (loose) into stackB
  const result = await store.moveAssetsToStack("default", ["a2", "p"], stackB.id);

  assert.deepEqual(result.movedAssetIds, ["a2", "p"]);
  assert.deepEqual(result.previouslyLooseAssetIds, ["p"]);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].stackId, stackA.id);
  assert.equal(result.sources[0].name, "源堆叠");
  assert.deepEqual(result.sources[0].memberIdsBefore, ["a1", "a2", "a3"]);
  assert.deepEqual(result.sources[0].movedAssetIds, ["a2"]);
});
