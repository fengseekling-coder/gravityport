import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { uniquePngBytes } from "./helpers/unique-image.mjs";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

async function createFixtureStore(t, assetIds = ["a", "b", "c", "d", "e", "f", "g", "h"]) {
  const root = await mkdtemp(join(tmpdir(), "mosa-stack-move-"));
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
      prompt: `stack move fixture ${id}`,
      created_at: `2026-08-29T12:0${index}:00.000Z`,
      source: { type: "local-file" },
    });
  }
  return { store, sourcePath, libraryDir };
}

function chatgptSource(conversationId) {
  return { type: "web-chatgpt", conversation_id: conversationId };
}

async function ingest(store, sourcePath, assetId, createdAt, source) {
  return store.createAsset({ assetId, imagePath: sourcePath, prompt: `fixture ${assetId}`, created_at: createdAt, source });
}

async function stackNodesOf(store, projectId) {
  const page = await store.listAssetPage({ projectId, limit: 0, collapseStacks: true });
  return page.assets.filter((asset) => asset.stack).map((asset) => asset.stack);
}

async function memberIds(store, projectId, stackId) {
  return (await store.listAssetStackAssets(projectId, stackId)).assets.map((asset) => asset.id);
}

async function memberPositions(store, projectId, stackId) {
  return (await store.listAssetStackAssets(projectId, stackId)).assets.map((asset) => asset.stack_position);
}

// The exclusion table has no store API on purpose; tests read it through a
// second connection, the same pattern the auto-session-stack tests use.
function exclusionRows(libraryDir) {
  const database = new Database(join(libraryDir, "mosa.db"));
  try {
    return database.prepare("SELECT asset_id, session_key FROM auto_stack_exclusions ORDER BY asset_id").all();
  } finally {
    database.close();
  }
}

// --- store level ---

test("moving two assets between stacks appends them in input order and compacts the source", async (t) => {
  const { store } = await createFixtureStore(t);
  const stackA = await store.createAssetStack("default", ["a", "b", "c", "d"], { coverAssetId: "a" });
  const stackB = await store.createAssetStack("default", ["e", "f"], { coverAssetId: "e" });

  const result = await store.moveAssetsToStack("default", ["c", "d"], stackB.id);

  assert.equal(result.target.id, stackB.id);
  assert.equal(result.target.count, 4);
  assert.equal(result.target.cover_asset_id, "e", "the target keeps its own cover");
  assert.deepEqual(result.movedAssetIds, ["c", "d"]);
  assert.deepEqual(result.sources, [{ stackId: stackA.id, dissolved: false, remainingAssetId: null }]);

  assert.deepEqual(await memberIds(store, "default", stackB.id), ["e", "f", "c", "d"], "moved assets append at the target tail in input order");
  assert.deepEqual(await memberPositions(store, "default", stackB.id), [0, 1, 2, 3]);
  assert.deepEqual(await memberIds(store, "default", stackA.id), ["a", "b"], "the source loses the moved members");
  assert.deepEqual(await memberPositions(store, "default", stackA.id), [0, 1], "source positions are compacted");
  const sourceSummary = await store.getAssetStack("default", stackA.id);
  assert.equal(sourceSummary.count, 2);
  assert.equal(sourceSummary.cover_asset_id, "a");
});

test("a source left with one member auto-dissolves and tombstones the moved and the surviving asset", async (t) => {
  const { store, sourcePath, libraryDir } = await createFixtureStore(t, ["x1", "x2"]);
  await ingest(store, sourcePath, "s1", "2026-06-01T00:00:00.000Z", chatgptSource("conv-move-tombstone"));
  await ingest(store, sourcePath, "s2", "2026-06-02T00:00:00.000Z", chatgptSource("conv-move-tombstone"));
  const [sessionStack] = await stackNodesOf(store, "default");
  const stackB = await store.createAssetStack("default", ["x1", "x2"], { coverAssetId: "x1" });

  const result = await store.moveAssetsToStack("default", ["s1"], stackB.id);

  assert.deepEqual(result.sources, [{ stackId: sessionStack.id, dissolved: true, remainingAssetId: "s2" }]);
  await assert.rejects(
    store.getAssetStack("default", sessionStack.id),
    (error) => error.code === "STACK_NOT_FOUND",
    "a source left with a single active member dissolves",
  );
  assert.deepEqual(await memberIds(store, "default", stackB.id), ["x1", "x2", "s1"]);
  assert.deepEqual(
    exclusionRows(libraryDir).filter((row) => ["s1", "s2"].includes(row.asset_id)).map((row) => [row.asset_id, row.session_key]),
    [["s1", "web-chatgpt:conv-move-tombstone"], ["s2", "web-chatgpt:conv-move-tombstone"]],
    "the moved asset and the dissolution survivor are both excluded from auto-restacking",
  );
});

test("one move gathers members of several stacks and a loose asset into the target in input order", async (t) => {
  const { store } = await createFixtureStore(t);
  const stackA = await store.createAssetStack("default", ["a", "b", "c"], { coverAssetId: "a" });
  const stackB = await store.createAssetStack("default", ["d", "h"], { coverAssetId: "d" });
  const stackC = await store.createAssetStack("default", ["e", "f"], { coverAssetId: "e" });

  const result = await store.moveAssetsToStack("default", ["c", "f", "g"], stackB.id);

  assert.deepEqual(result.movedAssetIds, ["c", "f", "g"]);
  assert.deepEqual(result.sources, [
    { stackId: stackA.id, dissolved: false, remainingAssetId: null },
    { stackId: stackC.id, dissolved: true, remainingAssetId: "e" },
  ], "sources follow the input's first appearance, whatever stack the assets came from");
  assert.deepEqual(await memberIds(store, "default", stackB.id), ["d", "h", "c", "f", "g"]);
  assert.deepEqual(await memberIds(store, "default", stackA.id), ["a", "b"]);
  await assert.rejects(store.getAssetStack("default", stackC.id), (error) => error.code === "STACK_NOT_FOUND");
});

test("moving to a null target un-stacks members and skips assets that are already loose", async (t) => {
  const { store } = await createFixtureStore(t);
  const stackA = await store.createAssetStack("default", ["a", "b", "c"], { coverAssetId: "a" });

  const result = await store.moveAssetsToStack("default", ["b", "d"], null);

  assert.equal(result.target, null);
  assert.deepEqual(result.movedAssetIds, ["b"], "the already-loose asset is skipped, not re-reported");
  assert.deepEqual(result.sources, [{ stackId: stackA.id, dissolved: false, remainingAssetId: null }]);
  assert.deepEqual(await memberIds(store, "default", stackA.id), ["a", "c"]);
  const gallery = await store.listAssetPage({ projectId: "default", limit: 0, sort: "oldest", collapseStacks: true });
  assert.equal(gallery.assets.find((asset) => asset.id === "b").stack, undefined, "the un-stacked asset renders flat");
  assert.equal(gallery.assets.find((asset) => asset.id === "d").stack, undefined);

  const again = await store.moveAssetsToStack("default", ["b"], "");
  assert.deepEqual(again.movedAssetIds, [], "an empty-string target un-stacks too, and a loose asset is skipped");
});

test("a move that changes nothing stays silent", async (t) => {
  const { store } = await createFixtureStore(t);
  const stackA = await store.createAssetStack("default", ["a", "b"], { coverAssetId: "a" });
  const stackB = await store.createAssetStack("default", ["c", "d"], { coverAssetId: "c" });

  const revisionBefore = await store.libraryRevision("default");
  const result = await store.moveAssetsToStack("default", ["c", "d"], stackB.id);

  assert.deepEqual(result.movedAssetIds, []);
  assert.deepEqual(result.sources, []);
  assert.equal(result.target.id, stackB.id);
  assert.equal(await store.libraryRevision("default"), revisionBefore, "a no-op move writes no change journal entry");
  assert.deepEqual(await memberIds(store, "default", stackB.id), ["c", "d"]);
  assert.deepEqual(await memberIds(store, "default", stackA.id), ["a", "b"]);
});

test("one invalid asset or a missing target aborts the whole batch untouched", async (t) => {
  const { store } = await createFixtureStore(t);
  const stackA = await store.createAssetStack("default", ["a", "b", "c"], { coverAssetId: "a" });
  const stackB = await store.createAssetStack("default", ["d", "e"], { coverAssetId: "d" });
  await assert.rejects(
    store.moveAssetsToStack("default", ["a", "ghost"], stackB.id),
    (error) => error.code === "ASSET_NOT_FOUND",
  );
  await assert.rejects(
    store.moveAssetsToStack("default", ["a"], "stack-nope"),
    (error) => error.code === "STACK_NOT_FOUND",
  );
  await store.archiveAsset("default", "b");
  const snapshotA = await memberIds(store, "default", stackA.id);
  const snapshotB = await memberIds(store, "default", stackB.id);
  const revisionBefore = await store.libraryRevision("default");
  await assert.rejects(
    store.moveAssetsToStack("default", ["a", "b"], stackB.id),
    (error) => error.code === "STACK_ASSET_ARCHIVED",
    "an archived member aborts the batch, exactly as addAssetsToStack rejects it",
  );

  assert.deepEqual(await memberIds(store, "default", stackA.id), snapshotA);
  assert.deepEqual(await memberIds(store, "default", stackB.id), snapshotB);
  assert.equal(await store.libraryRevision("default"), revisionBefore, "no journal entries survive the aborted batches");
});

test("assets moved out of a session stack are never auto-restacked by a later session ingest", async (t) => {
  const { store, sourcePath, libraryDir } = await createFixtureStore(t, ["y1"]);
  await ingest(store, sourcePath, "m1", "2026-06-01T00:00:00.000Z", chatgptSource("conv-move-out"));
  await ingest(store, sourcePath, "m2", "2026-06-02T00:00:00.000Z", chatgptSource("conv-move-out"));
  const [sessionStack] = await stackNodesOf(store, "default");
  assert.equal(sessionStack.count, 2, "precondition: the session auto-stacked");

  await store.moveAssetsToStack("default", ["m1", "m2"], null);
  assert.equal((await stackNodesOf(store, "default")).length, 0, "un-stacking dissolved the session stack");

  await ingest(store, sourcePath, "m3", "2026-06-03T00:00:00.000Z", chatgptSource("conv-move-out"));

  assert.equal((await stackNodesOf(store, "default")).length, 0, "the later ingest does not rebuild a stack around the moved assets");
  assert.deepEqual(
    exclusionRows(libraryDir).filter((row) => ["m1", "m2"].includes(row.asset_id)).map((row) => row.asset_id),
    ["m1", "m2"],
  );
});

test("the move announces one change per source stack and one for the target, using the existing kinds", async (t) => {
  const { store } = await createFixtureStore(t);

  const stackA = await store.createAssetStack("default", ["a", "b", "c", "h"], { coverAssetId: "a" });
  const stackB = await store.createAssetStack("default", ["d", "g"], { coverAssetId: "d" });
  let revisionBefore = (await store.listLibraryChangesSince("default", 0)).currentRevision;
  await store.moveAssetsToStack("default", ["b"], stackB.id);
  let changes = (await store.listLibraryChangesSince("default", revisionBefore)).changes.filter((change) => change.entityType === "stack");
  assert.deepEqual(changes.map((change) => change.kind), ["stack-members-changed", "stack-members-changed"]);
  assert.deepEqual(changes.map((change) => change.entityId), [stackA.id, stackB.id], "one entry for the source, one for the target");
  assert.deepEqual(changes[0].assetIds, ["b", "a"], "the source entry names the moved asset and its cover, as removeAssetsFromStack announces them");
  assert.deepEqual(changes[1].assetIds, ["b"]);

  // Moving the source cover uses the existing cover-change kind on the source.
  revisionBefore = (await store.listLibraryChangesSince("default", 0)).currentRevision;
  await store.moveAssetsToStack("default", ["a"], stackB.id);
  changes = (await store.listLibraryChangesSince("default", revisionBefore)).changes.filter((change) => change.entityType === "stack");
  assert.deepEqual(changes.map((change) => change.kind), ["stack-cover-changed", "stack-members-changed"]);
  assert.equal((await store.getAssetStack("default", stackA.id)).cover_asset_id, "c");

  // A source that dissolves announces the existing dissolve kind.
  const stackC = await store.createAssetStack("default", ["e", "f"], { coverAssetId: "e" });
  revisionBefore = (await store.listLibraryChangesSince("default", 0)).currentRevision;
  await store.moveAssetsToStack("default", ["e"], stackB.id);
  changes = (await store.listLibraryChangesSince("default", revisionBefore)).changes.filter((change) => change.entityType === "stack");
  assert.deepEqual(changes.map((change) => change.kind), ["stack-dissolved", "stack-members-changed"]);
  assert.deepEqual(changes[0].entityId, stackC.id);
});

// --- API level ---

function mutationHeaders(runtime) {
  return { "content-type": "application/json", "x-mosa-client-token": runtime.clientToken };
}

async function startMoveRuntime(t) {
  const root = await mkdtemp(join(tmpdir(), "mosa-stack-move-api-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const generated = join(root, "generated-images");
  await mkdir(generated, { recursive: true });
  const ids = ["a", "b", "c", "d"];
  for (let index = 0; index < ids.length; index += 1) {
    await writeFile(join(generated, `${ids[index]}.png`), await uniquePngBytes(index + 1));
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
  assert.equal(runtime.storage, "sqlite");

  const create = async (id) => {
    const response = await fetch(`${runtime.url}/api/assets/create`, {
      method: "POST",
      headers: mutationHeaders(runtime),
      body: JSON.stringify({
        projectId: "default",
        assetId: id,
        imagePath: join(generated, `${id}.png`),
        prompt: `prompt ${id}`,
      }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).asset;
  };
  const createStack = async (assetIds, coverAssetId) => {
    const response = await fetch(`${runtime.url}/api/asset-stacks`, {
      method: "POST",
      headers: mutationHeaders(runtime),
      body: JSON.stringify({ projectId: "default", assetIds, coverAssetId }),
    });
    assert.equal(response.status, 201);
    return (await response.json()).stack;
  };
  const move = async (body) => fetch(`${runtime.url}/api/asset-stacks/move`, {
    method: "POST",
    headers: mutationHeaders(runtime),
    body: JSON.stringify(body),
  });
  const stackAssets = async (stackId) => (await (await fetch(
    `${runtime.url}/api/asset-stacks/${encodeURIComponent(stackId)}/assets?project=default&limit=100`,
  )).json()).assets.map((asset) => asset.id);
  return { runtime, create, createStack, move, stackAssets };
}

test("the move API relocates members between stacks and reports the outcome", async (t) => {
  const { runtime, create, createStack, move, stackAssets } = await startMoveRuntime(t);
  for (const id of ["a", "b", "c", "d"]) await create(id);
  const stackA = await createStack(["a", "b"], "a");
  const stackB = await createStack(["c", "d"], "c");

  const response = await move({ project: "default", assetIds: ["a"], targetStackId: stackB.id });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.target.id, stackB.id);
  assert.deepEqual(body.movedAssetIds, ["a"]);
  assert.deepEqual(body.sources, [{ stackId: stackA.id, dissolved: true, remainingAssetId: "b" }],
    "stack A is left with a single member and dissolves, exactly as a removal would");
  assert.deepEqual(await stackAssets(stackB.id), ["c", "d", "a"]);

  const unstack = await move({ project: "default", assetIds: ["a"], targetStackId: null });
  assert.equal(unstack.status, 200);
  assert.equal((await unstack.json()).target, null);
  assert.deepEqual(await stackAssets(stackB.id), ["c", "d"]);
});

test("the move API validates the batch size, the payload and the target", async (t) => {
  const { runtime, create, createStack, move, stackAssets } = await startMoveRuntime(t);
  for (const id of ["a", "b"]) await create(id);
  const stackA = await createStack(["a", "b"], "a");

  for (const assetIds of [[], Array.from({ length: 2001 }, (_, index) => `asset-${index}`)]) {
    const response = await move({ project: "default", assetIds, targetStackId: stackA.id });
    assert.equal(response.status, 400, `batch of ${assetIds.length} is rejected`);
    assert.equal((await response.json()).code, "STACK_MOVE_BATCH_SIZE_INVALID");
  }

  const missing = await move({ project: "default", assetIds: ["a"], targetStackId: "stack-nope" });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "STACK_NOT_FOUND");
  assert.deepEqual(await stackAssets(stackA.id), ["a", "b"], "the rejected batch left the stack untouched");
});
