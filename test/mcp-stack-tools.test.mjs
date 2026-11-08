import assert from "node:assert/strict";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createAssetStore } from "../lib/asset-store.mjs";
import { createMcpWorkspace, startMcpServer, writePngFixture } from "./helpers/mcp-server-harness.mjs";

let colorIndex = 1;
function nextColor() {
  const hex = (colorIndex * 1357911).toString(16).slice(-6).padStart(6, "0");
  colorIndex += 1;
  return `#${hex}`;
}

async function createFixtureAsset(server, workspace, { prompt = "fixture image", color } = {}) {
  const c = color || nextColor();
  const filePath = join(workspace.imagesDir, `asset-${colorIndex}.png`);
  await writePngFixture(filePath, { color: c });
  const result = await server.callToolStrict("asset_create", { imagePath: filePath, prompt });
  return result.structuredContent.asset;
}

test("1. stack_create: 3 assets A, B, C with coverAssetId B and name ' 第 3 期 '", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const a = await createFixtureAsset(server, workspace, { prompt: "img A" });
  const b = await createFixtureAsset(server, workspace, { prompt: "img B" });
  const c = await createFixtureAsset(server, workspace, { prompt: "img C" });

  const created = await server.callToolStrict("stack_create", {
    assetIds: [a.id, b.id, c.id],
    coverAssetId: b.id,
    name: " 第 3 期 ",
  });

  const stack = created.structuredContent.stack;
  assert.equal(stack.count, 3);
  assert.equal(stack.cover_asset_id, b.id);
  assert.equal(stack.name, "第 3 期");

  const getRes = await server.callToolStrict("stack_get", { stackId: stack.id });
  const members = getRes.structuredContent.members;
  assert.deepEqual(members.map((m) => m.id), [b.id, a.id, c.id]);
});

test("2. created stack is readable from direct createAssetStore and recorded in library changes", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const baselineStore = createAssetStore({
    projectRoot: workspace.root,
    managerDir: workspace.root,
    libraryDir: workspace.libraryDir,
    explicitLibraryDir: workspace.libraryDir,
    assetsRoot: join(workspace.libraryDir, "assets"),
    generatedImagesDir: join(workspace.libraryDir, "imports"),
  });
  const { revision: baselineRevision } = await baselineStore.libraryChangeState("default");
  baselineStore.close();

  const a = await createFixtureAsset(server, workspace);
  const b = await createFixtureAsset(server, workspace);

  const created = await server.callToolStrict("stack_create", {
    assetIds: [a.id, b.id],
  });
  const stackId = created.structuredContent.stack.id;

  const directStore = createAssetStore({
    projectRoot: workspace.root,
    managerDir: workspace.root,
    libraryDir: workspace.libraryDir,
    explicitLibraryDir: workspace.libraryDir,
    assetsRoot: join(workspace.libraryDir, "assets"),
    generatedImagesDir: join(workspace.libraryDir, "imports"),
  });
  t.after(() => directStore.close());

  const readStack = await directStore.getAssetStack("default", stackId);
  assert.equal(readStack.id, stackId);
  assert.equal(readStack.count, 2);

  const changes = await directStore.listLibraryChangesSince("default", baselineRevision);
  const found = changes.changes.find((c) => c.kind === "stack-created" && c.entityId === stackId);
  assert.ok(found, "changes list has kind: stack-created for new stack");
});

test("3. stack_create with single asset fails with STACK_NEEDS_MULTIPLE_ASSETS and asset stack is null", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const a = await createFixtureAsset(server, workspace);
  const res = await server.callTool("stack_create", { assetIds: [a.id] });
  assert.equal(res.isError, true);
  assert.equal(res.structuredContent.error.code, "STACK_NEEDS_MULTIPLE_ASSETS");

  const getA = await server.callToolStrict("asset_get", { assetId: a.id });
  assert.equal(getA.structuredContent.asset.stack, null);
});

test("4. stack_create with coverAssetId not in assetIds fails with STACK_COVER_NOT_MEMBER", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const a = await createFixtureAsset(server, workspace);
  const b = await createFixtureAsset(server, workspace);
  const res = await server.callTool("stack_create", {
    assetIds: [a.id, b.id],
    coverAssetId: "nonexistent-cover",
  });
  assert.equal(res.isError, true);
  assert.equal(res.structuredContent.error.code, "STACK_COVER_NOT_MEMBER");
});

test("5. stack_create with empty whitespace name fails with STACK_NAME_EMPTY without creating a stack", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const a = await createFixtureAsset(server, workspace);
  const b = await createFixtureAsset(server, workspace);

  const res = await server.callTool("stack_create", {
    assetIds: [a.id, b.id],
    name: "   ",
  });
  assert.equal(res.isError, true);
  assert.equal(res.structuredContent.error.code, "STACK_NAME_EMPTY");

  const list = await server.callToolStrict("stack_list", {});
  assert.deepEqual(list.structuredContent.stacks, []);

  const getA = await server.callToolStrict("asset_get", { assetId: a.id });
  const getB = await server.callToolStrict("asset_get", { assetId: b.id });
  assert.equal(getA.structuredContent.asset.stack, null);
  assert.equal(getB.structuredContent.asset.stack, null);
});

test("6. stack_create with 81 character name returns protocol error -32602 without creating a stack", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const a = await createFixtureAsset(server, workspace);
  const b = await createFixtureAsset(server, workspace);

  const response = await server.request("tools/call", {
    name: "stack_create",
    arguments: { assetIds: [a.id, b.id], name: "x".repeat(81) },
  });
  assert.equal(response.error?.code, -32602);

  const list = await server.callToolStrict("stack_list", {});
  assert.deepEqual(list.structuredContent.stacks, []);
});

test("7. stack_create with asset already in stack fails with ASSET_ALREADY_STACKED and rolls back", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const c = await createFixtureAsset(server, workspace);
  const d = await createFixtureAsset(server, workspace);
  const e = await createFixtureAsset(server, workspace);

  const s1Res = await server.callToolStrict("stack_create", { assetIds: [c.id, d.id] });
  const s1Id = s1Res.structuredContent.stack.id;

  const res = await server.callTool("stack_create", { assetIds: [d.id, e.id] });
  assert.equal(res.isError, true);
  assert.equal(res.structuredContent.error.code, "ASSET_ALREADY_STACKED");
  assert.match(res.structuredContent.error.message, new RegExp(s1Id));

  const getE = await server.callToolStrict("asset_get", { assetId: e.id });
  assert.equal(getE.structuredContent.asset.stack, null);
});

test("8. stack_create with archived asset fails STACK_ASSET_ARCHIVED, missing asset fails ASSET_NOT_FOUND", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const a = await createFixtureAsset(server, workspace);
  const b = await createFixtureAsset(server, workspace);
  const directStore = createAssetStore({
    projectRoot: workspace.root,
    managerDir: workspace.root,
    libraryDir: workspace.libraryDir,
    explicitLibraryDir: workspace.libraryDir,
    assetsRoot: join(workspace.libraryDir, "assets"),
    generatedImagesDir: join(workspace.libraryDir, "imports"),
  });
  await directStore.archiveAsset("default", b.id);
  directStore.close();

  const resArchived = await server.callTool("stack_create", { assetIds: [a.id, b.id] });
  assert.equal(resArchived.isError, true);
  assert.equal(resArchived.structuredContent.error.code, "STACK_ASSET_ARCHIVED");

  const resNotFound = await server.callTool("stack_create", { assetIds: [a.id, "ghost-asset-id"] });
  assert.equal(resNotFound.isError, true);
  assert.equal(resNotFound.structuredContent.error.code, "ASSET_NOT_FOUND");
});

test("9. stack_add_assets reports added and alreadyInStack, rejects foreign stack asset, rejects missing stack", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const a = await createFixtureAsset(server, workspace);
  const b = await createFixtureAsset(server, workspace);
  const c = await createFixtureAsset(server, workspace);
  const stackRes = await server.callToolStrict("stack_create", { assetIds: [a.id, b.id, c.id] });
  const stackId = stackRes.structuredContent.stack.id;

  const f = await createFixtureAsset(server, workspace);
  const addRes = await server.callToolStrict("stack_add_assets", { stackId, assetIds: [f.id, a.id] });
  assert.equal(addRes.structuredContent.stack.count, 4);
  assert.deepEqual(addRes.structuredContent.added, [f.id]);
  assert.deepEqual(addRes.structuredContent.alreadyInStack, [a.id]);

  const g = await createFixtureAsset(server, workspace);
  const h = await createFixtureAsset(server, workspace);
  await server.callToolStrict("stack_create", { assetIds: [g.id, h.id] });

  const failAdd = await server.callTool("stack_add_assets", { stackId, assetIds: [g.id] });
  assert.equal(failAdd.isError, true);
  assert.equal(failAdd.structuredContent.error.code, "ASSET_ALREADY_STACKED");

  const getStack = await server.callToolStrict("stack_get", { stackId });
  assert.equal(getStack.structuredContent.stack.count, 4);

  const failMissing = await server.callTool("stack_add_assets", { stackId: "missing-stack", assetIds: [a.id] });
  assert.equal(failMissing.isError, true);
  assert.equal(failMissing.structuredContent.error.code, "STACK_NOT_FOUND");
});

test("10. stack_rename updates name, rejects empty name with parameter error, rejects missing stack", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const a = await createFixtureAsset(server, workspace);
  const b = await createFixtureAsset(server, workspace);
  const stackRes = await server.callToolStrict("stack_create", { assetIds: [a.id, b.id] });
  const stackId = stackRes.structuredContent.stack.id;

  const renameRes = await server.callToolStrict("stack_rename", { stackId, name: "新名称" });
  assert.equal(renameRes.structuredContent.stack.name, "新名称");

  const getRes = await server.callToolStrict("stack_get", { stackId });
  assert.equal(getRes.structuredContent.stack.name, "新名称");

  const emptyResponse = await server.request("tools/call", {
    name: "stack_rename",
    arguments: { stackId, name: "" },
  });
  assert.equal(emptyResponse.error?.code, -32602);

  const failMissing = await server.callTool("stack_rename", { stackId: "missing-stack", name: "有效名称" });
  assert.equal(failMissing.isError, true);
  assert.equal(failMissing.structuredContent.error.code, "STACK_NOT_FOUND");
});

test("11. stack_remove_assets rejects non-member with ASSET_NOT_IN_STACK, decrements count, dissolves when 1 left", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const a = await createFixtureAsset(server, workspace);
  const b = await createFixtureAsset(server, workspace);
  const c = await createFixtureAsset(server, workspace);
  const x = await createFixtureAsset(server, workspace);

  const stackRes = await server.callToolStrict("stack_create", { assetIds: [a.id, b.id, c.id] });
  const stackId = stackRes.structuredContent.stack.id;

  const failRemove = await server.callTool("stack_remove_assets", { stackId, assetIds: [a.id, x.id] });
  assert.equal(failRemove.isError, true);
  assert.equal(failRemove.structuredContent.error.code, "ASSET_NOT_IN_STACK");

  const getBefore = await server.callToolStrict("stack_get", { stackId });
  assert.equal(getBefore.structuredContent.stack.count, 3);
  assert.ok(getBefore.structuredContent.members.some((m) => m.id === a.id));

  const removeA = await server.callToolStrict("stack_remove_assets", { stackId, assetIds: [a.id] });
  assert.equal(removeA.structuredContent.dissolved, false);
  assert.equal(removeA.structuredContent.stack.count, 2);

  const removeB = await server.callToolStrict("stack_remove_assets", { stackId, assetIds: [b.id] });
  assert.equal(removeB.structuredContent.dissolved, true);
  assert.equal(removeB.structuredContent.stack, null);

  const getB = await server.callToolStrict("asset_get", { assetId: b.id });
  const getC = await server.callToolStrict("asset_get", { assetId: c.id });
  assert.equal(getB.structuredContent.asset.stack, null);
  assert.equal(getC.structuredContent.asset.stack, null);
});

test("12. stack_dissolve dissolves stack, members stay active with stack null, stack_list drops it", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const a = await createFixtureAsset(server, workspace);
  const b = await createFixtureAsset(server, workspace);
  const stackRes = await server.callToolStrict("stack_create", { assetIds: [a.id, b.id] });
  const stackId = stackRes.structuredContent.stack.id;

  const dissolveRes = await server.callToolStrict("stack_dissolve", { stackId });
  assert.equal(dissolveRes.structuredContent.dissolved, true);
  assert.equal(dissolveRes.structuredContent.id, stackId);
  assert.deepEqual(dissolveRes.structuredContent.assetIds.sort(), [a.id, b.id].sort());

  const getA = await server.callToolStrict("asset_get", { assetId: a.id });
  const getB = await server.callToolStrict("asset_get", { assetId: b.id });
  assert.equal(getA.structuredContent.asset.archived, false);
  assert.equal(getA.structuredContent.asset.stack, null);
  assert.equal(getB.structuredContent.asset.archived, false);
  assert.equal(getB.structuredContent.asset.stack, null);

  const list = await server.callToolStrict("stack_list", {});
  assert.equal(list.structuredContent.stacks.some((s) => s.id === stackId), false);
});

test("13. stack field in asset_list and asset_search: slim { id, name } with unstacked key dropped; asset_get keeps the full shape", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const a = await createFixtureAsset(server, workspace, { prompt: "cat sitting on roof" });
  const b = await createFixtureAsset(server, workspace, { prompt: "cat sleeping in basket" });
  const c = await createFixtureAsset(server, workspace, { prompt: "dog running in park" });

  const stackRes = await server.callToolStrict("stack_create", {
    assetIds: [a.id, b.id],
    coverAssetId: a.id,
    name: "Cats Stack",
  });
  const stackId = stackRes.structuredContent.stack.id;

  const listRes = await server.callToolStrict("asset_list", {});
  const listMap = new Map(listRes.structuredContent.assets.map((item) => [item.id, item]));
  // Task 376: list/search summaries keep only { id, name } on the stack.
  assert.deepEqual(listMap.get(a.id).stack, { id: stackId, name: "Cats Stack" });
  assert.deepEqual(listMap.get(b.id).stack, { id: stackId, name: "Cats Stack" });
  assert.equal("stack" in listMap.get(c.id), false);

  const searchCats = await server.callToolStrict("asset_search", { query: "cat" });
  const searchMap = new Map(searchCats.structuredContent.results.map((entry) => [entry.asset.id, entry.asset]));
  assert.deepEqual(searchMap.get(a.id).stack, { id: stackId, name: "Cats Stack" });
  assert.deepEqual(searchMap.get(b.id).stack, { id: stackId, name: "Cats Stack" });

  const searchDog = await server.callToolStrict("asset_search", { query: "dog" });
  assert.equal("stack" in searchDog.structuredContent.results[0].asset, false);

  // The full stack summary (count, is_cover, unstacked null) stays on asset_get.
  const coverGet = await server.callToolStrict("asset_get", { assetId: a.id });
  assert.deepEqual(coverGet.structuredContent.asset.stack, { id: stackId, name: "Cats Stack", count: 2, is_cover: true });
  const memberGet = await server.callToolStrict("asset_get", { assetId: b.id });
  assert.deepEqual(memberGet.structuredContent.asset.stack, { id: stackId, name: "Cats Stack", count: 2, is_cover: false });
  const unstackedGet = await server.callToolStrict("asset_get", { assetId: c.id });
  assert.equal(unstackedGet.structuredContent.asset.stack, null);
});

test("14. stack_list filters by query with character escaping and orders properly", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const a1 = await createFixtureAsset(server, workspace);
  const a2 = await createFixtureAsset(server, workspace);
  const b1 = await createFixtureAsset(server, workspace);
  const b2 = await createFixtureAsset(server, workspace);

  await server.callToolStrict("stack_create", { assetIds: [a1.id, a2.id], name: "第 1 期" });
  await server.callToolStrict("stack_create", { assetIds: [b1.id, b2.id], name: "花絮" });

  const queryDi = await server.callToolStrict("stack_list", { query: "第" });
  assert.equal(queryDi.structuredContent.stacks.length, 1);
  assert.equal(queryDi.structuredContent.stacks[0].name, "第 1 期");

  const queryPct = await server.callToolStrict("stack_list", { query: "%" });
  assert.equal(queryPct.structuredContent.stacks.length, 0);
});

test("15. legacy JSON store answers ASSET_STACKS_UNAVAILABLE for stack_create and asset stack is null", async (t) => {
  const workspace = await createMcpWorkspace(t, { jsonLibrary: true });
  const server = startMcpServer(t, workspace);

  const createRes = await server.callTool("stack_create", { assetIds: ["legacy-asset", "other-asset"] });
  assert.equal(createRes.isError, true);
  assert.equal(createRes.structuredContent.error.code, "ASSET_STACKS_UNAVAILABLE");
  assert.equal(createRes.structuredContent.error.message, "Asset stacks are unavailable.");

  const getRes = await server.callToolStrict("asset_get", { assetId: "legacy-asset" });
  assert.equal(getRes.structuredContent.asset.stack, null);
});

test("16. user scenario: 3 episodes share the same closing page PNG", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const ep1Dir = join(workspace.root, "ep1");
  const ep2Dir = join(workspace.root, "ep2");
  const ep3Dir = join(workspace.root, "ep3");
  await mkdir(ep1Dir, { recursive: true });
  await mkdir(ep2Dir, { recursive: true });
  await mkdir(ep3Dir, { recursive: true });

  // Each folder has 4 distinct PNGs
  for (let i = 1; i <= 4; i += 1) {
    await writePngFixture(join(ep1Dir, `0${i}.png`), { color: nextColor() });
    await writePngFixture(join(ep2Dir, `0${i}.png`), { color: nextColor() });
    await writePngFixture(join(ep3Dir, `0${i}.png`), { color: nextColor() });
  }

  // 5th image in all 3 folders has the exact same bytes
  const sharedPath1 = join(ep1Dir, "05_last.png");
  await writePngFixture(sharedPath1, { color: "#3498db" });
  await copyFile(sharedPath1, join(ep2Dir, "05_last.png"));
  await copyFile(sharedPath1, join(ep3Dir, "05_last.png"));

  const res1 = await server.callToolStrict("asset_import_folder", { folderPath: ep1Dir });
  assert.equal(res1.structuredContent.imported, 5);
  assert.deepEqual(res1.structuredContent.duplicates, []);

  const res2 = await server.callToolStrict("asset_import_folder", { folderPath: ep2Dir });
  assert.equal(res2.structuredContent.imported, 4);
  assert.equal(res2.structuredContent.deduplicated, 1);
  assert.equal(res2.structuredContent.duplicates.length, 1);
  assert.equal(res2.structuredContent.duplicates[0].file, "05_last.png");
  const originalLastAssetId = res2.structuredContent.duplicates[0].assetId;
  assert.ok(originalLastAssetId);

  const res3 = await server.callToolStrict("asset_import_folder", { folderPath: ep3Dir });
  assert.equal(res3.structuredContent.imported, 4);
  assert.equal(res3.structuredContent.deduplicated, 1);
  assert.equal(res3.structuredContent.duplicates.length, 1);
  assert.equal(res3.structuredContent.duplicates[0].file, "05_last.png");
  assert.equal(res3.structuredContent.duplicates[0].assetId, originalLastAssetId);

  // Duplicate the closing page twice
  const dup1 = await server.callToolStrict("asset_duplicate", { assetId: originalLastAssetId });
  const dup2 = await server.callToolStrict("asset_duplicate", { assetId: originalLastAssetId });
  const copyId1 = dup1.structuredContent.asset.id;
  const copyId2 = dup2.structuredContent.asset.id;

  // Stack 3 episodes
  const ep1Assets = res1.structuredContent.assetIds;
  const ep2Assets = [...res2.structuredContent.assetIds, copyId1];
  const ep3Assets = [...res3.structuredContent.assetIds, copyId2];

  await server.callToolStrict("stack_create", { assetIds: ep1Assets, coverAssetId: ep1Assets[0], name: "第 1 期" });
  await server.callToolStrict("stack_create", { assetIds: ep2Assets, coverAssetId: ep2Assets[0], name: "第 2 期" });
  await server.callToolStrict("stack_create", { assetIds: ep3Assets, coverAssetId: ep3Assets[0], name: "第 3 期" });

  const stacksList = await server.callToolStrict("stack_list", {});
  assert.equal(stacksList.structuredContent.stacks.length, 3);
  for (const s of stacksList.structuredContent.stacks) {
    assert.equal(s.count, 5);
  }

  const origAsset = await server.callToolStrict("asset_get", { assetId: originalLastAssetId });
  assert.equal(origAsset.structuredContent.asset.stack.name, "第 1 期");

  const copy1Asset = await server.callToolStrict("asset_get", { assetId: copyId1 });
  assert.equal(copy1Asset.structuredContent.asset.stack.name, "第 2 期");

  const copy2Asset = await server.callToolStrict("asset_get", { assetId: copyId2 });
  assert.equal(copy2Asset.structuredContent.asset.stack.name, "第 3 期");

  // Attempting to stack original closing page into another stack fails ASSET_ALREADY_STACKED
  const extraAsset = await createFixtureAsset(server, workspace);
  const failStack = await server.callTool("stack_create", { assetIds: [originalLastAssetId, extraAsset.id] });
  assert.equal(failStack.isError, true);
  assert.equal(failStack.structuredContent.error.code, "ASSET_ALREADY_STACKED");
});

test("17. division of labor with session auto-stacking", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const file1 = join(workspace.imagesDir, "session-1.png");
  const file2 = join(workspace.imagesDir, "session-2.png");
  await writePngFixture(file1, { color: nextColor() });
  await writePngFixture(file2, { color: nextColor() });

  const s1 = await server.callToolStrict("asset_create", {
    imagePath: file1,
    prompt: "session asset 1",
    source: { generation_session_id: "s-371", generation_session_title: "会话 371" },
  });
  const s2 = await server.callToolStrict("asset_create", {
    imagePath: file2,
    prompt: "session asset 2",
    source: { generation_session_id: "s-371", generation_session_title: "会话 371" },
  });

  const getS1 = await server.callToolStrict("asset_get", { assetId: s1.structuredContent.asset.id });
  assert.ok(getS1.structuredContent.asset.stack);
  assert.equal(getS1.structuredContent.asset.stack.name, "会话 371");
  const autoStackId = getS1.structuredContent.asset.stack.id;

  const extra = await createFixtureAsset(server, workspace);
  const failStack = await server.callTool("stack_create", { assetIds: [s1.structuredContent.asset.id, extra.id] });
  assert.equal(failStack.isError, true);
  assert.equal(failStack.structuredContent.error.code, "ASSET_ALREADY_STACKED");

  const removeRes = await server.callToolStrict("stack_remove_assets", {
    stackId: autoStackId,
    assetIds: [s1.structuredContent.asset.id],
  });
  assert.equal(removeRes.structuredContent.dissolved, true);

  const newStack = await server.callToolStrict("stack_create", {
    assetIds: [s1.structuredContent.asset.id, extra.id],
    name: "新重组堆叠",
  });
  assert.equal(newStack.structuredContent.stack.count, 2);
  assert.equal(newStack.structuredContent.stack.name, "新重组堆叠");
});
