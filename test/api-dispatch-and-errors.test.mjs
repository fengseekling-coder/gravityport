import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { uniquePngBytes } from "./helpers/unique-image.mjs";
import { createMcpWorkspace, startMcpServer } from "./helpers/mcp-server-harness.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

function mutationHeaders(runtime) {
  return { "content-type": "application/json", "x-mosa-client-token": runtime.clientToken };
}

async function startDispatchRuntime(t) {
  const root = await mkdtemp(join(tmpdir(), "mosa-dispatch-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const generated = join(root, "generated-images");
  await mkdir(generated, { recursive: true });
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
  return { runtime, generated };
}

// 任务 398（建7 第 3 条）：接口分发顺序是行为契约。generation 排在 asset
// 前面，/api/assets/:p/:a/generation-history 必须由 generation 路由应答
// （200 + history 数组）；分发顺序坏了它会落进 asset 兜底之外的 404。
test("a generation route answers inside the asset namespace before the dispatch falls through", async (t) => {
  const { runtime, generated } = await startDispatchRuntime(t);
  await writeFile(join(generated, "order.png"), await uniquePngBytes(1));
  const create = await fetch(`${runtime.url}/api/assets/create`, {
    method: "POST",
    headers: mutationHeaders(runtime),
    body: JSON.stringify({
      projectId: "default",
      assetId: "dispatch-order",
      imagePath: join(generated, "order.png"),
      prompt: "dispatch order probe",
    }),
  });
  assert.equal(create.status, 200);

  const history = await fetch(`${runtime.url}/api/assets/default/dispatch-order/generation-history`);
  assert.equal(history.status, 200);
  const body = await history.json();
  // generation 路由的应答形状：素材级 lineage 汇总对象（asset 兜底永远到不了这里）。
  assert.equal(body.history?.project_id, "default");
  assert.equal(body.history?.asset_id, "dispatch-order");
  assert.ok(Array.isArray(body.history?.events), `generation route must answer with a lineage object, got: ${JSON.stringify(body)}`);

  // 同一路径、不存在的素材：generation 路由的按码 404（ASSET_NOT_FOUND），
  // 不是分发兜底的 NOT_FOUND。
  const missing = await fetch(`${runtime.url}/api/assets/default/no-such-asset/generation-history`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "Asset not found: no-such-asset", code: "ASSET_NOT_FOUND" });
});

// 任务 398（低4 ②）：打错的 API 路径回 404 JSON，不是 200 HTML。两处分别
// 是 mosa-runtime 的 /api/ 分发兜底与 asset 路由全部不命中后的落点。
test("unknown API paths answer 404 JSON", async (t) => {
  const { runtime } = await startDispatchRuntime(t);
  for (const pathname of ["/api/no-such-route", "/api/assets/x/y/no-such-action"]) {
    const response = await fetch(`${runtime.url}${pathname}`);
    assert.equal(response.status, 404, `${pathname} must be a 404`);
    assert.match(response.headers.get("content-type") || "", /application\/json/, `${pathname} must be JSON`);
    assert.deepEqual(await response.json(), { error: "Not found", code: "NOT_FOUND" });
  }
});

// 任务 398（甲）：本轮补上的错误代号抽查——同一种错误同一个代号，error
// 文字保持原文。
test("newly added error codes keep their error text and identify the failure", async (t) => {
  const { runtime, generated } = await startDispatchRuntime(t);
  await writeFile(join(generated, "codes.png"), await uniquePngBytes(2));

  const unknownAction = await fetch(`${runtime.url}/api/assets/batch`, {
    method: "POST",
    headers: mutationHeaders(runtime),
    body: JSON.stringify({ action: "explode", assetIds: ["a"] }),
  });
  assert.equal(unknownAction.status, 400);
  assert.deepEqual(await unknownAction.json(), { error: "Unknown batch action: explode", code: "BATCH_ACTION_UNKNOWN" });

  const emptyIds = await fetch(`${runtime.url}/api/assets/batch`, {
    method: "POST",
    headers: mutationHeaders(runtime),
    body: JSON.stringify({ action: "favorite", assetIds: [] }),
  });
  assert.equal(emptyIds.status, 400);
  assert.deepEqual(await emptyIds.json(), { error: "assetIds must be a non-empty array", code: "ASSET_IDS_INVALID" });

  const badGroup = await fetch(`${runtime.url}/api/assets/batch`, {
    method: "POST",
    headers: mutationHeaders(runtime),
    body: JSON.stringify({ action: "group", assetIds: ["a"], group: 42 }),
  });
  assert.equal(badGroup.status, 400);
  assert.deepEqual(await badGroup.json(), { error: "group must be a string", code: "GROUP_FIELD_INVALID" });

  const badCurated = await fetch(`${runtime.url}/api/assets/batch`, {
    method: "POST",
    headers: mutationHeaders(runtime),
    body: JSON.stringify({ action: "curate", assetIds: ["a"], curated: "yes" }),
  });
  assert.equal(badCurated.status, 400);
  assert.deepEqual(await badCurated.json(), { error: "curated must be a boolean", code: "CURATED_FIELD_INVALID" });

  const badStagedPath = await fetch(`${runtime.url}/api/import/stage`, {
    method: "DELETE",
    headers: mutationHeaders(runtime),
    body: JSON.stringify({ path: 123 }),
  });
  assert.equal(badStagedPath.status, 400);
  assert.deepEqual(await badStagedPath.json(), { error: "Missing or invalid staged path.", code: "STAGING_PATH_INVALID" });

  const emptyRows = await fetch(`${runtime.url}/api/gallery-rows`, {
    method: "POST",
    headers: mutationHeaders(runtime),
    body: JSON.stringify({ assetIds: [] }),
  });
  assert.equal(emptyRows.status, 400);
  assert.deepEqual(await emptyRows.json(), { error: "assetIds must be a non-empty array", code: "ASSET_IDS_INVALID" });
});

// 任务 398（低4 ⑥）：asset_import_folder 传不存在的文件夹时，工具在动手前
// 就失败，临时库里不能留下任何新建的空项目目录。前后各拍一次库目录树对比。
test("a failed asset_import_folder on a missing folder leaves no new project directory", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);
  await server.request("initialize", {});

  const snapshot = async () => (await readdir(workspace.libraryDir, { recursive: true })).sort();
  const before = await snapshot();

  const missing = await server.callTool("asset_import_folder", { folderPath: join(workspace.root, "does-not-exist") });
  assert.equal(missing.isError, true, "the missing folder is a tool-level failure");
  assert.equal(missing.structuredContent?.error?.code, "IMPORT_FOLDER_NOT_FOUND");

  const after = await snapshot();
  assert.deepEqual(after, before);
});
