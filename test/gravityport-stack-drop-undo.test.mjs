import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after, before } from "node:test";
import Database from "better-sqlite3";

import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const srcRoot = join(repositoryRoot, "web", "gravityport", "src");
const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

let undoModule;
let tempTscDir;

before(async () => {
  tempTscDir = await mkdtemp(join(tmpdir(), "mosa-gp-stack-undo-"));
  const entry = join(srcRoot, "stack-drop-undo.ts");
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    entry, "--outDir", tempTscDir, "--module", "esnext", "--target", "es2022",
    "--moduleResolution", "bundler", "--skipLibCheck",
  ], { stdio: "pipe" });
  undoModule = await import(join(tempTscDir, "stack-drop-undo.js"));
});

after(async () => {
  if (tempTscDir) {
    await rm(tempTscDir, { recursive: true, force: true });
  }
});

async function createFixtureStore(t, assetIds = ["a1", "a2", "a3", "b1", "b2", "c1", "c2", "p", "q"]) {
  const root = await mkdtemp(join(tmpdir(), "mosa-stack-undo-"));
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
      prompt: `stack undo fixture ${id}`,
      created_at: `2026-08-29T12:0${index}:00.000Z`,
      source: { type: "local-file" },
    });
  }
  return { store, sourcePath, libraryDir };
}

function makeOps(store, reorderTracker = { count: 0 }) {
  return {
    async moveAssetsToStack(project, assetIds, targetStackId) {
      await store.moveAssetsToStack(project, assetIds, targetStackId);
      return { total: assetIds.length, succeeded: assetIds.length, failed: 0, failedIds: [], firstError: "" };
    },
    async createStack(project, ids, coverAssetId) {
      const summary = await store.createAssetStack(project, ids, { coverAssetId });
      return { id: summary.id, name: summary.name };
    },
    async renameStack(project, stackId, name) {
      return store.renameAssetStack(project, stackId, name);
    },
    async reorderStack(project, stackId, memberIds) {
      reorderTracker.count += 1;
      return store.reorderAssetStack(project, stackId, memberIds);
    },
    async listStackMemberIds(project, stackId) {
      const list = await store.listAssetStackAssets(project, stackId);
      return list.assets.map((a) => a.id);
    },
    async dissolveStack(project, stackId) {
      return store.dissolveAssetStack(project, stackId);
    },
  };
}

async function captureState(store, projectId = "default") {
  const page = await store.listAssetPage({ projectId, limit: 0, collapseStacks: false });
  const allActiveAssetIds = [];
  for (const asset of page.assets) {
    if (asset.deleted_at || asset.archived) continue;
    allActiveAssetIds.push(asset.id);
  }

  // Get all stacks directly from database table rather than inferring from covers
  const db = new Database(store.databasePath, { readonly: true });
  let stackRows;
  try {
    stackRows = db.prepare("SELECT id FROM asset_stacks WHERE project_id = ? ORDER BY id").all(projectId);
  } finally {
    db.close();
  }

  const stacks = [];
  const stackedAssetIds = new Set();
  for (const row of stackRows) {
    const stackInfo = await store.getAssetStack(projectId, row.id);
    const members = (await store.listAssetStackAssets(projectId, row.id)).assets.map((a) => a.id);
    for (const mId of members) {
      stackedAssetIds.add(mId);
    }
    stacks.push({
      name: stackInfo.name || "",
      coverAssetId: stackInfo.cover_asset_id,
      memberIds: members,
    });
  }

  // Loose assets = all active assets minus all stacked members
  const looseAssetIds = allActiveAssetIds.filter((id) => !stackedAssetIds.has(id));

  // Assertion: no stacked member may appear in looseAssetIds
  for (const id of looseAssetIds) {
    assert.ok(!stackedAssetIds.has(id), `Loose asset ${id} must not be in any stack`);
  }

  stacks.sort((a, b) => a.memberIds[0].localeCompare(b.memberIds[0]));
  looseAssetIds.sort();

  return { looseAssetIds, stacks };
}

test("1. undo 9.1 item 1: moving a2 from A to B restores a2 to 2nd position in A", async (t) => {
  const { store } = await createFixtureStore(t);
  const stackA = await store.createAssetStack("default", ["a1", "a2", "a3"], { coverAssetId: "a1" });
  await store.renameAssetStack("default", stackA.id, "甲");
  await store.createAssetStack("default", ["b1", "b2"], { coverAssetId: "b1" });

  const stateBefore = await captureState(store);

  const dropResult = await store.dropAssetsOnAsset("default", ["a2"], "b1");
  const plan = undoModule.planStackDropUndo("default", dropResult);
  assert.ok(plan);

  await undoModule.runStackDropUndo(plan, makeOps(store));

  const stateAfter = await captureState(store);
  assert.deepEqual(stateAfter, stateBefore);
});

test("2. undo 9.1 item 3: drop onto loose asset creates stack; undo dissolves it and restores original stack and loose card", async (t) => {
  const { store } = await createFixtureStore(t);
  await store.createAssetStack("default", ["a1", "a2", "a3"], { coverAssetId: "a1" });

  const stateBefore = await captureState(store);

  const dropResult = await store.dropAssetsOnAsset("default", ["a1"], "p");
  const plan = undoModule.planStackDropUndo("default", dropResult);
  assert.ok(plan);

  await undoModule.runStackDropUndo(plan, makeOps(store));

  const stateAfter = await captureState(store);
  assert.deepEqual(stateAfter, stateBefore);
});

test("3. undo 9.1 item 4: source stack dissolved; undo recreates it with original name and cover", async (t) => {
  const { store } = await createFixtureStore(t);
  const stackC = await store.createAssetStack("default", ["c1", "c2"], { coverAssetId: "c1" });
  await store.renameAssetStack("default", stackC.id, "丙堆叠");
  await store.createAssetStack("default", ["b1", "b2"], { coverAssetId: "b1" });

  const stateBefore = await captureState(store);

  const dropResult = await store.dropAssetsOnAsset("default", ["c1"], "b1");
  const plan = undoModule.planStackDropUndo("default", dropResult);
  assert.ok(plan);

  await undoModule.runStackDropUndo(plan, makeOps(store));

  const stateAfter = await captureState(store);
  assert.deepEqual(stateAfter, stateBefore);
});

test("4. multi-drag from two stacks and one loose card restores all to exact positions", async (t) => {
  const { store } = await createFixtureStore(t, ["a1", "a2", "b1", "b2", "t1", "t2", "p"]);
  const stackA = await store.createAssetStack("default", ["a1", "a2"], { coverAssetId: "a1" });
  await store.renameAssetStack("default", stackA.id, "堆叠A");
  const stackB = await store.createAssetStack("default", ["b1", "b2"], { coverAssetId: "b1" });
  await store.renameAssetStack("default", stackB.id, "堆叠B");
  await store.createAssetStack("default", ["t1", "t2"], { coverAssetId: "t1" });

  const stateBefore = await captureState(store);

  // Drag a2 (from A), b2 (from B), and loose p onto t1
  const dropResult = await store.dropAssetsOnAsset("default", ["a2", "b2", "p"], "t1");
  const plan = undoModule.planStackDropUndo("default", dropResult);
  assert.ok(plan);

  await undoModule.runStackDropUndo(plan, makeOps(store));

  const stateAfter = await captureState(store);
  assert.deepEqual(stateAfter, stateBefore);
});

test("5. unlocked auto stack undo does not invoke reorderStack and preserves order", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-stack-undo-auto-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  const generatedDir = join(projectRoot, "generated-images");
  await mkdir(generatedDir, { recursive: true });
  const sourcePath = join(generatedDir, "fixture.png");
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => store.close());

  // Ingest 3 assets for same session
  for (let i = 1; i <= 3; i += 1) {
    await store.createAsset({
      assetId: `g${i}`,
      imagePath: sourcePath,
      prompt: `auto stack ${i}`,
      created_at: `2026-06-0${i}T00:00:00.000Z`,
      source: { type: "web-chatgpt", conversation_id: "conv-auto" },
    });
  }

  // Target stack B
  await store.createAsset({
    assetId: "b1",
    imagePath: sourcePath,
    prompt: "b1",
    created_at: "2026-07-01T00:00:00.000Z",
    source: { type: "local-file" },
  });
  await store.createAsset({
    assetId: "b2",
    imagePath: sourcePath,
    prompt: "b2",
    created_at: "2026-07-02T00:00:00.000Z",
    source: { type: "local-file" },
  });
  await store.createAssetStack("default", ["b1", "b2"], { coverAssetId: "b1" });

  const stateBefore = await captureState(store);

  // Assert premise: stateBefore must contain the unlocked auto stack [g3, g2, g1] with cover g3
  const autoStack = stateBefore.stacks.find((s) => s.memberIds.join(",") === "g3,g2,g1");
  assert.ok(autoStack, "auto stack with members [g3, g2, g1] must exist in stateBefore");
  assert.equal(autoStack.coverAssetId, "g3", "auto stack cover must be g3");
  const db = new Database(store.databasePath, { readonly: true });
  try {
    const row = db.prepare("SELECT order_locked, origin FROM asset_stacks WHERE project_id = ? AND session_key = ?").get("default", "web-chatgpt:conv-auto");
    assert.equal(row?.origin, "auto", "origin must be auto");
    assert.equal(Number(row?.order_locked || 0), 0, "order_locked must be 0 (unlocked)");
  } finally {
    db.close();
  }

  const dropResult = await store.dropAssetsOnAsset("default", ["g2"], "b1");
  const plan = undoModule.planStackDropUndo("default", dropResult);
  assert.ok(plan);

  const reorderTracker = { count: 0 };
  const ops = makeOps(store, reorderTracker);

  await undoModule.runStackDropUndo(plan, ops);

  assert.equal(reorderTracker.count, 0, "reorderStack was not called for unlocked auto stack");
  const stateAfter = await captureState(store);
  assert.deepEqual(stateAfter, stateBefore);
});

test("6. undo combination: drop onto loose asset creates stack and dissolves source; undo restores both", async (t) => {
  const { store } = await createFixtureStore(t, ["c1", "c2", "x"]);
  const stackC = await store.createAssetStack("default", ["c1", "c2"], { coverAssetId: "c1" });
  await store.renameAssetStack("default", stackC.id, "丙");

  const stateBefore = await captureState(store);
  assert.equal(stateBefore.stacks.length, 1);
  assert.deepEqual(stateBefore.stacks[0].memberIds, ["c1", "c2"]);
  assert.equal(stateBefore.stacks[0].coverAssetId, "c1");
  assert.equal(stateBefore.stacks[0].name, "丙");
  assert.deepEqual(stateBefore.looseAssetIds, ["x"]);

  const dropResult = await store.dropAssetsOnAsset("default", ["c2"], "x");
  assert.equal(dropResult.mode, "created");
  assert.deepEqual(dropResult.movedAssetIds, ["c2"]);
  assert.equal(dropResult.sources.length, 1);
  assert.equal(dropResult.sources[0].dissolved, true);
  assert.equal(dropResult.sources[0].remainingAssetId, "c1");

  const plan = undoModule.planStackDropUndo("default", dropResult);
  assert.ok(plan);

  await undoModule.runStackDropUndo(plan, makeOps(store));

  const stateAfter = await captureState(store);
  assert.deepEqual(stateAfter, stateBefore);
});

test("7. planStackDropUndo returns null on noop or empty moves", () => {
  assert.equal(undoModule.planStackDropUndo("default", {
    mode: "noop",
    stack: null,
    sources: [],
    movedAssetIds: [],
    previouslyLooseAssetIds: [],
  }), null);

  assert.equal(undoModule.planStackDropUndo("default", {
    mode: "joined",
    stack: null,
    sources: [],
    movedAssetIds: [],
    previouslyLooseAssetIds: [],
  }), null);
});
