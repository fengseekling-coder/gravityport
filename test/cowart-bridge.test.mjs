import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { removeTestPath as rm, deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createAssetStore } from "../lib/asset-store.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { ingestWebCapture } from "../lib/web-capture-ingest.js";
import { createCowartAssetBridge, reconcileCowartAssets } from "../lib/cowart-bridge.js";

test("archives Cowart page assets once and keeps MOSA-origin images out", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const canvasDir = join(root, "cowart-data", "mosa");
  const pageAssetsDir = join(canvasDir, "pages", "page", "assets");
  await mkdir(pageAssetsDir, { recursive: true });
  await writeFile(join(pageAssetsDir, "bear.png"), "fixture Cowart image", "utf8");
  await writeFile(join(pageAssetsDir, "from-library.png"), "fixture library image", "utf8");
  await writeFile(join(canvasDir, "pages", "page", "cowart-canvas.json"), JSON.stringify({
    store: {
      "asset:bear": { id: "asset:bear", typeName: "asset", type: "image", props: { name: "bear.png", src: "/page-assets/page/bear.png" }, meta: {} },
      "shape:bear": { id: "shape:bear", typeName: "shape", type: "image", props: { assetId: "asset:bear", w: 2160, h: 2160, altText: "草原背景的小熊" }, meta: { cowartGeneratedForAiImageHolder: "shape:holder", cowartAnnotationSourceShapeId: "shape:source" } },
      "asset:from-library": { id: "asset:from-library", typeName: "asset", type: "image", props: { name: "from-library.png", src: "/page-assets/page/from-library.png" }, meta: { mosaAssetId: "existing-library-asset" } },
    },
  }), "utf8");

  const store = createAssetStore({ projectRoot, managerDir, cowartCanvasDir: canvasDir });
  const first = await reconcileCowartAssets({ store, canvasDir });
  assert.equal(first.imported.length, 1);
  assert.equal(first.skipped.length, 1);
  assert.equal(first.imported[0].source.cowart_shape_id, "shape:bear");
  assert.equal(first.imported[0].source.replaced_ai_image_holder, "shape:holder");
  assert.equal(first.imported[0].source.cowart_annotation_source_shape_id, "shape:source");
  assert.equal(first.imported[0].ratio, "1:1");

  await store.archiveAsset("default", first.imported[0].id);
  const second = await reconcileCowartAssets({ store, canvasDir });
  assert.equal(second.imported.length, 0);
  assert.equal(second.skipped.filter((item) => item.reason === "already-archived").length, 1);
});

test("skips unchanged Cowart candidates without re-querying the asset store", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-signature-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const canvasDir = join(root, "cowart-data", "mosa");
  const pageDir = join(canvasDir, "pages", "page");
  const pageAssetsDir = join(pageDir, "assets");
  const imagePath = join(pageAssetsDir, "stable.png");
  await mkdir(pageAssetsDir, { recursive: true });
  await writeFile(imagePath, "stable-cowart-bytes", "utf8");
  await writeFile(join(pageDir, "cowart-canvas.json"), JSON.stringify({
    store: {
      "asset:stable": { id: "asset:stable", typeName: "asset", type: "image", props: { name: "stable.png", src: "/page-assets/page/stable.png" }, meta: {} },
      "shape:stable": { id: "shape:stable", typeName: "shape", type: "image", props: { assetId: "asset:stable", w: 100, h: 100, altText: "stable" }, meta: {} },
    },
  }), "utf8");

  let sourceLookups = 0;
  let listCalls = 0;
  const store = {
    cowartCanvasDir: canvasDir,
    async listAssets() { listCalls += 1; return []; },
    async findAssetBySourcePath() { sourceLookups += 1; return { id: "existing", source: { path: imagePath } }; },
    async findAssetByContentHash() { throw new Error("content lookup should not run"); },
    async findAssetByPixelHash() { throw new Error("pixel lookup should not run"); },
    async createAsset() { throw new Error("create should not run"); },
  };
  const processedSignatures = new Map();
  const first = await reconcileCowartAssets({ store, canvasDir, processedSignatures });
  const second = await reconcileCowartAssets({ store, canvasDir, processedSignatures });
  assert.equal(first.skipped[0].reason, "already-archived");
  assert.equal(second.skipped[0].reason, "unchanged");
  assert.equal(sourceLookups, 1);
  assert.equal(listCalls, 0);
});

test("deduplicates Cowart copies by content even when their page asset paths differ", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-content-dedupe-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const canvasDir = join(root, "cowart-data", "mosa");
  const pageDir = join(canvasDir, "pages", "page");
  const pageAssetsDir = join(pageDir, "assets");
  await mkdir(pageAssetsDir, { recursive: true });
  const bytes = Buffer.from("same Cowart image bytes under two file names");
  await writeFile(join(pageAssetsDir, "first.png"), bytes);
  await writeFile(join(pageAssetsDir, "renamed-copy.png"), bytes);
  await writeFile(join(pageDir, "cowart-canvas.json"), JSON.stringify({
    store: {
      "asset:first": { id: "asset:first", typeName: "asset", type: "image", props: { name: "first.png", src: "/page-assets/page/first.png" }, meta: {} },
      "shape:first": { id: "shape:first", typeName: "shape", type: "image", props: { assetId: "asset:first", w: 100, h: 100, altText: "first" }, meta: {} },
      "asset:copy": { id: "asset:copy", typeName: "asset", type: "image", props: { name: "renamed-copy.png", src: "/page-assets/page/renamed-copy.png" }, meta: {} },
      "shape:copy": { id: "shape:copy", typeName: "shape", type: "image", props: { assetId: "asset:copy", w: 100, h: 100, altText: "copy" }, meta: {} },
    },
  }), "utf8");

  const store = createAssetStore({ projectRoot, managerDir, cowartCanvasDir: canvasDir });
  const result = await reconcileCowartAssets({ store, canvasDir });
  assert.equal(result.imported.length, 1);
  assert.equal(result.skipped.filter((item) => item.reason === "already-archived-same-content").length, 1);
  assert.equal((await store.listAssets({ projectId: "default" })).length, 1);
});

test("deduplicates Cowart re-encodes by current display pixels", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-pixel-dedupe-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const canvasDir = join(root, "cowart-data", "mosa");
  const pageDir = join(canvasDir, "pages", "page");
  const pageAssetsDir = join(pageDir, "assets");
  await mkdir(pageAssetsDir, { recursive: true });
  const raw = Buffer.alloc(64 * 48 * 4);
  for (let i = 0; i < raw.length; i += 4) {
    raw[i] = (i * 11) & 255;
    raw[i + 1] = (i * 23) & 255;
    raw[i + 2] = (i * 47) & 255;
    raw[i + 3] = i % 28 === 0 ? 144 : 255;
  }
  const firstBytes = await sharp(raw, { raw: { width: 64, height: 48, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
  const secondBytes = await sharp(raw, { raw: { width: 64, height: 48, channels: 4 } }).png({ compressionLevel: 1 }).toBuffer();
  await writeFile(join(pageAssetsDir, "first.png"), firstBytes);
  await writeFile(join(pageAssetsDir, "reencoded.png"), secondBytes);
  await writeFile(join(pageDir, "cowart-canvas.json"), JSON.stringify({
    store: {
      "asset:first": { id: "asset:first", typeName: "asset", type: "image", props: { name: "first.png", src: "/page-assets/page/first.png" }, meta: {} },
      "shape:first": { id: "shape:first", typeName: "shape", type: "image", props: { assetId: "asset:first", w: 64, h: 48, altText: "first" }, meta: {} },
      "asset:copy": { id: "asset:copy", typeName: "asset", type: "image", props: { name: "reencoded.png", src: "/page-assets/page/reencoded.png" }, meta: {} },
      "shape:copy": { id: "shape:copy", typeName: "shape", type: "image", props: { assetId: "asset:copy", w: 64, h: 48, altText: "copy" }, meta: {} },
    },
  }), "utf8");

  const store = createAssetStore({ projectRoot, managerDir, cowartCanvasDir: canvasDir });
  const result = await reconcileCowartAssets({ store, canvasDir });
  assert.equal(result.imported.length, 1);
  assert.equal(result.skipped.filter((item) => item.reason === "already-archived-same-pixels").length, 1);
  assert.equal((await store.listAssets({ projectId: "default" })).length, 1);
});

test("continues Cowart reconciliation after one asset import fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-import-failure-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const canvasDir = join(root, "cowart-data", "mosa");
  const pageDir = join(canvasDir, "pages", "page");
  const pageAssetsDir = join(pageDir, "assets");
  const failedPath = join(pageAssetsDir, "a-fails.png");
  const succeedingPath = join(pageAssetsDir, "b-succeeds.png");
  await mkdir(pageAssetsDir, { recursive: true });
  await writeFile(failedPath, "fixture failed Cowart image", "utf8");
  await writeFile(succeedingPath, "fixture succeeding Cowart image", "utf8");
  await writeFile(join(pageDir, "cowart-canvas.json"), JSON.stringify({
    store: {
      "asset:a-fails": { id: "asset:a-fails", typeName: "asset", type: "image", props: { name: "a-fails.png", src: "/page-assets/page/a-fails.png" }, meta: {} },
      "shape:a-fails": { id: "shape:a-fails", typeName: "shape", type: "image", props: { assetId: "asset:a-fails", w: 100, h: 100, altText: "失败候选" }, meta: {} },
      "asset:b-succeeds": { id: "asset:b-succeeds", typeName: "asset", type: "image", props: { name: "b-succeeds.png", src: "/page-assets/page/b-succeeds.png" }, meta: {} },
      "shape:b-succeeds": { id: "shape:b-succeeds", typeName: "shape", type: "image", props: { assetId: "asset:b-succeeds", w: 100, h: 100, altText: "继续归档候选" }, meta: {} },
    },
  }), "utf8");

  const createCalls = [];
  const createOptions = [];
  const store = {
    cowartCanvasDir: canvasDir,
    async listAssets() { return []; },
    async createAsset(params, options) {
      createCalls.push(params.imagePath);
      createOptions.push(options);
      if (params.imagePath === failedPath) throw new Error("fixture import failure");
      return { id: "succeeded", image_path: params.imagePath };
    },
  };

  const result = await reconcileCowartAssets({ store, canvasDir });
  assert.deepEqual(createCalls, [failedPath, succeedingPath]);
  assert.deepEqual(createOptions, [
    { trustedSourceRoots: [join(canvasDir, "pages")], ingestMode: "automatic" },
    { trustedSourceRoots: [join(canvasDir, "pages")], ingestMode: "automatic" },
  ]);
  assert.deepEqual(result.skipped, [{ path: failedPath, reason: "import-failed" }]);
  assert.deepEqual(result.imported, [{ id: "succeeded", image_path: succeedingPath }]);
});

test("skips a suppressed Cowart asset and continues to the next candidate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-suppressed-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const canvasDir = join(root, "cowart-data", "mosa");
  const pageDir = join(canvasDir, "pages", "page");
  const pageAssetsDir = join(pageDir, "assets");
  const firstPath = join(pageAssetsDir, "a-suppressed.png");
  const secondPath = join(pageAssetsDir, "b-imported.png");
  await mkdir(pageAssetsDir, { recursive: true });
  await writeFile(firstPath, "fixture suppressed Cowart image", "utf8");
  await writeFile(secondPath, "fixture imported Cowart image", "utf8");
  await writeFile(join(pageDir, "cowart-canvas.json"), JSON.stringify({
    store: {
      "asset:a-suppressed": { id: "asset:a-suppressed", typeName: "asset", type: "image", props: { name: "a-suppressed.png", src: "/page-assets/page/a-suppressed.png" }, meta: {} },
      "shape:a-suppressed": { id: "shape:a-suppressed", typeName: "shape", type: "image", props: { assetId: "asset:a-suppressed", w: 100, h: 100, altText: "已删除后抑制" }, meta: {} },
      "asset:b-imported": { id: "asset:b-imported", typeName: "asset", type: "image", props: { name: "b-imported.png", src: "/page-assets/page/b-imported.png" }, meta: {} },
      "shape:b-imported": { id: "shape:b-imported", typeName: "shape", type: "image", props: { assetId: "asset:b-imported", w: 100, h: 100, altText: "继续归档" }, meta: {} },
    },
  }), "utf8");

  const calls = [];
  const store = {
    cowartCanvasDir: canvasDir,
    async listAssets() { return []; },
    async createAsset(params, options) {
      calls.push({ params, options });
      if (params.imagePath === firstPath) throw Object.assign(new Error("suppressed"), { code: "AUTOMATIC_IMPORT_SUPPRESSED" });
      return { id: "cowart-imported", image_path: params.imagePath };
    },
  };

  const result = await reconcileCowartAssets({ store, canvasDir });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.options), [
    { trustedSourceRoots: [join(canvasDir, "pages")], ingestMode: "automatic" },
    { trustedSourceRoots: [join(canvasDir, "pages")], ingestMode: "automatic" },
  ]);
  assert.deepEqual(result.skipped, [{ path: firstPath, reason: "suppressed-after-delete" }]);
  assert.deepEqual(result.imported, [{ id: "cowart-imported", image_path: secondPath }]);
});

test("watches a Cowart page directory and archives a later image", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-"));

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const canvasDir = join(root, "cowart-data", "mosa");
  const pageDir = join(canvasDir, "pages", "page");
  const pageAssetsDir = join(pageDir, "assets");
  await mkdir(pageAssetsDir, { recursive: true });
  await writeFile(join(pageDir, "cowart-canvas.json"), JSON.stringify({ store: {} }), "utf8");

  const store = createAssetStore({ projectRoot, managerDir, cowartCanvasDir: canvasDir });
  const bridge = createCowartAssetBridge({ store, canvasDir, debounceMs: 10, pollIntervalMs: 100 });
  t.after(async () => { await bridge.stop(); await rm(root, { recursive: true, force: true }); });
  await bridge.start();

  await writeFile(join(pageAssetsDir, "watch-bear.png"), "fixture watched Cowart image", "utf8");
  await writeFile(join(pageDir, "cowart-canvas.json"), JSON.stringify({
    store: {
      "asset:watch-bear": { id: "asset:watch-bear", typeName: "asset", type: "image", props: { name: "watch-bear.png", src: "/page-assets/page/watch-bear.png" }, meta: {} },
      "shape:watch-bear": { id: "shape:watch-bear", typeName: "shape", type: "image", props: { assetId: "asset:watch-bear", w: 2160, h: 2160, altText: "自动归档测试图" }, meta: {} },
    },
  }), "utf8");

  await waitFor(() => bridge.status().totalImported === 1);
  const assets = await store.listAssets({ projectId: "default" });
  assert.equal(assets.length, 1);
  assert.equal(assets[0].source.cowart_shape_id, "shape:watch-bear");
});

test("waits for an active Cowart archive before cleanup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-stop-"));
  const canvasDir = join(root, "cowart-data", "mosa");
  const pageDir = join(canvasDir, "pages", "page");
  const pageAssetsDir = join(pageDir, "assets");
  let allowCreate;
  let signalCreate;
  const createStarted = new Promise((resolve) => { signalCreate = resolve; });
  const store = {
    cowartCanvasDir: canvasDir,
    async listAssets() { return []; },
    async createAsset() { signalCreate(); await new Promise((resolve) => { allowCreate = resolve; }); return {}; },
  };
  const bridge = createCowartAssetBridge({ store, canvasDir, debounceMs: 0, pollIntervalMs: 60_000 });
  t.after(async () => { await bridge.stop(); await rm(root, { recursive: true, force: true }); });
  await mkdir(pageAssetsDir, { recursive: true });
  await writeFile(join(pageDir, "cowart-canvas.json"), JSON.stringify({ store: {} }), "utf8");
  await bridge.start();

  await writeFile(join(pageAssetsDir, "stop-bear.png"), "fixture watched Cowart image", "utf8");
  await writeFile(join(pageDir, "cowart-canvas.json"), JSON.stringify({
    store: {
      "asset:stop-bear": { id: "asset:stop-bear", typeName: "asset", type: "image", props: { name: "stop-bear.png", src: "/page-assets/page/stop-bear.png" }, meta: {} },
      "shape:stop-bear": { id: "shape:stop-bear", typeName: "shape", type: "image", props: { assetId: "asset:stop-bear", w: 2160, h: 2160, altText: "停止时正在归档" }, meta: {} },
    },
  }), "utf8");

  const reconciling = bridge.reconcile();
  await createStarted;
  let stopped = false;
  const stopping = bridge.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopped, false, "stop waits for the active asset archive");
  allowCreate();
  await reconciling;
  await stopping;
  assert.equal(bridge.status().enabled, false);
});

test("archives a registered external Cowart canvas through the SQLite store only within its pages root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-sqlite-external-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "workspace");
  const managerDir = join(projectRoot, "mosa");
  const cowartProjectDir = join(root, "external-project");
  const canvasDir = join(cowartProjectDir, "canvas");
  const pageDir = join(canvasDir, "pages", "page");
  const imagePath = join(pageDir, "assets", "external.png");
  await mkdir(join(pageDir, "assets"), { recursive: true });
  await writeFile(imagePath, "fixture external Cowart image", "utf8");
  await writeFile(join(pageDir, "cowart-canvas.json"), JSON.stringify({
    store: {
      "asset:external": { id: "asset:external", typeName: "asset", type: "image", props: { name: "external.png", src: "/page-assets/page/external.png" }, meta: {} },
      "shape:external": { id: "shape:external", typeName: "shape", type: "image", props: { assetId: "asset:external", w: 1200, h: 800, altText: "External Cowart image" }, meta: {} },
    },
  }), "utf8");

  const store = createSqliteAssetStore({ projectRoot, managerDir, libraryDir: join(root, "library") });
  t.after(() => store.close());
  await assert.rejects(store.createAsset({ imagePath }), /Refusing to import outside the project roots/);

  const result = await reconcileCowartAssets({
    store,
    canvasDir,
    cowartProjectDir,
    sourceId: "registered-external-project",
  });
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].source.cowart_project_dir, cowartProjectDir);
  assert.equal(result.imported[0].source.cowart_source_id, "registered-external-project");
});

async function waitFor(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Cowart bridge file watch.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// Large deterministic fixture so the web-capture path accepts it (it rejects
// captures under 20 KiB) and the same bytes can seed a Cowart canvas.
async function noisyPngFixture(width = 320, height = 240) {
  const raw = Buffer.alloc(width * height * 3);
  for (let index = 0; index < raw.length; index += 1) raw[index] = (index * 29 + Math.floor(index / width) * 19) & 255;
  return sharp(raw, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
}

function canvasFixture(records) {
  return JSON.stringify({ store: records });
}

test("a Cowart rematch of another channel's image only records an occurrence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-other-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  t.after(() => store.close?.());
  await store.ensureProject("default");

  const imageBytes = await noisyPngFixture();
  const web = await ingestWebCapture({
    store,
    tempRoot: join(libraryDir, ".web-capture-tmp"),
    projectId: "default",
    input: {
      provider: "chatgpt",
      imageBase64: imageBytes.toString("base64"),
      mimeType: "image/png",
      prompt: "web caption prompt A",
      prompt_status: "visible-caption",
      conversationId: "conv-web-1",
    },
  });
  assert.equal(web.status, "imported");

  const canvasDir = join(root, "cowart-data", "mosa");
  const pageDir = join(canvasDir, "pages", "page");
  const pageAssetsDir = join(pageDir, "assets");
  await mkdir(pageAssetsDir, { recursive: true });
  await writeFile(join(pageAssetsDir, "web-copy.png"), imageBytes);
  await writeFile(join(pageDir, "cowart-canvas.json"), canvasFixture({
    "asset:web-copy": { id: "asset:web-copy", typeName: "asset", type: "image", props: { name: "web-copy.png", src: "/page-assets/page/web-copy.png" }, meta: {} },
    "shape:web-copy": { id: "shape:web-copy", typeName: "shape", type: "image", props: { assetId: "asset:web-copy", w: 320, h: 240, altText: "canvas alt text" }, meta: {} },
  }), "utf8");

  const first = await reconcileCowartAssets({ store, canvasDir });
  assert.equal(first.imported.length, 0);
  assert.equal(first.skipped.some((item) => item.reason === "already-archived-same-content"), true);
  assert.equal((await store.listAssets({ projectId: "default" })).length, 1, "no second asset is built");

  const asset = await store.getAsset("default", web.asset.id);
  assert.equal(asset.prompt, "web caption prompt A");
  assert.equal(asset.source.prompt_status, "visible-caption");
  const cowartOccurrences = asset.source.capture_occurrences.filter((entry) => entry.provider === "cowart");
  assert.equal(cowartOccurrences.length, 1);
  assert.equal(cowartOccurrences[0].conversation_id, "page:page");

  await reconcileCowartAssets({ store, canvasDir });
  const reread = await store.getAsset("default", web.asset.id);
  assert.equal(reread.source.capture_occurrences.filter((entry) => entry.provider === "cowart").length, 1, "the same observation is recorded once");
});

test("a Cowart page asset whose file bytes changed at the same path archives as a new asset", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-replace-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const canvasDir = join(root, "cowart-data", "mosa");
  const pageDir = join(canvasDir, "pages", "page");
  const pageAssetsDir = join(pageDir, "assets");
  await mkdir(pageAssetsDir, { recursive: true });
  const imagePath = join(pageAssetsDir, "bear.png");
  await writeFile(imagePath, await noisyPngFixture(64, 48));
  await writeFile(join(pageDir, "cowart-canvas.json"), canvasFixture({
    "asset:bear": { id: "asset:bear", typeName: "asset", type: "image", props: { name: "bear.png", src: "/page-assets/page/bear.png" }, meta: {} },
    "shape:bear": { id: "shape:bear", typeName: "shape", type: "image", props: { assetId: "asset:bear", w: 64, h: 48, altText: "草原背景的小熊" }, meta: {} },
  }), "utf8");

  const store = createAssetStore({ projectRoot, managerDir, cowartCanvasDir: canvasDir });
  const first = await reconcileCowartAssets({ store, canvasDir });
  assert.equal(first.imported.length, 1);

  // Same canvas path, new bytes: a fresh asset is archived, never a version.
  await writeFile(imagePath, await noisyPngFixture(96, 64));
  const second = await reconcileCowartAssets({ store, canvasDir });
  assert.equal(second.imported.length, 1);
  const assets = await store.listAssets({ projectId: "default" });
  assert.equal(assets.length, 2);
  assert.notEqual(second.imported[0].id, first.imported[0].id);
});
