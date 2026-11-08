import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { createAssetStore } from "../lib/asset-store.mjs";
import { removeTestPath } from "./test-cleanup.mjs";
import { createMcpWorkspace, startMcpServer, writePngFixture } from "./helpers/mcp-server-harness.mjs";

// Task 376: asset_list / asset_search answers carry slim per-asset summaries
// (fixed field set), a readable content summary, totals and cursor paging;
// asset_get keeps the full payload. The suite seeds one throwaway library
// with 100 assets (500-character CJK prompts, recipes, tags, dimensions) and
// talks to a real mcp/server.mjs over stdio.

const ASSET_COUNT = 100;
// Exactly 500 CJK characters: the worst-case prompt the slim excerpts must cut.
const PROMPT_500 = "红橙黄绿青蓝紫".repeat(72).slice(0, 500);
const COLORS = ["#101010", "#243047", "#404040", "#506070", "#606060", "#704020", "#803010", "#905030"];
// The fixed slim field order from the task order (keys may be absent, never extra).
const SLIM_FIELD_ORDER = ["id", "file_name", "media_kind", "width", "height", "prompt_excerpt", "group", "tags", "rating", "favorite", "created_at", "stack", "image_path"];
const SEEDED_IDS = Array.from({ length: ASSET_COUNT }, (_, i) => `slim-${String(i).padStart(3, "0")}`);

function createSeedStore(workspace) {
  return createAssetStore({
    projectRoot: workspace.root,
    managerDir: workspace.root,
    libraryDir: workspace.libraryDir,
    explicitLibraryDir: workspace.libraryDir,
    assetsRoot: join(workspace.libraryDir, "assets"),
    generatedImagesDir: join(workspace.libraryDir, "imports"),
  });
}

let shared;
async function setupOnce() {
  if (!shared) {
    shared = (async () => {
      // The workspace helper owns cleanup through t.after; pass a stub so the
      // single shared workspace lives until this file's after() hook instead.
      const workspace = await createMcpWorkspace({ after: () => {} });
      const store = createSeedStore(workspace);
      for (let i = 0; i < ASSET_COUNT; i++) {
        const assetId = SEEDED_IDS[i];
        const imagePath = await writePngFixture(join(workspace.imagesDir, `${assetId}.png`), { color: COLORS[i % COLORS.length] });
        await store.createAsset({
          assetId,
          imagePath,
          prompt: PROMPT_500,
          tags: ["slimtag", `tag${i}`],
          rating: (i % 5) + 1,
          favorite: i % 2 === 0,
          group: "瘦身测试组",
          business_fields: { width: 64 + i, height: 32 + i },
        });
      }
      store.close();
      const server = startMcpServer({ after: () => {} }, workspace);
      await server.request("initialize", { protocolVersion: "2025-11-25" });
      const stacked = await server.callToolStrict("stack_create", {
        assetIds: ["slim-000", "slim-001"],
        name: "瘦身堆叠",
      });
      return { workspace, server, stackId: stacked.structuredContent.stack.id };
    })().catch((error) => {
      shared = null;
      throw error;
    });
  }
  return shared;
}

after(async () => {
  if (!shared) return;
  const { workspace, server } = await shared;
  server.terminateIfRunning();
  await removeTestPath(workspace.root, { recursive: true, force: true });
});

function assertSlimFields(asset, label) {
  assert.deepEqual(Object.keys(asset), SLIM_FIELD_ORDER.filter((key) => key in asset), `slim field order for ${label}`);
  assert.ok(Object.prototype.hasOwnProperty.call(asset, "prompt_excerpt"), "prompt_excerpt is always present");
  assert.ok([...asset.prompt_excerpt].length <= 81, `prompt_excerpt of ${label} is at most 80 characters plus an ellipsis`);
}

test("1+2. asset_list answers stay small and every asset carries exactly the slim fields in order", async () => {
  const { server } = await setupOnce();

  const big = await server.request("tools/call", { name: "asset_list", arguments: { limit: 100 } });
  const bigBytes = Buffer.byteLength(JSON.stringify(big));
  assert.ok(bigBytes < 80000, `100-asset page must stay under 80000 bytes, measured ${bigBytes}`);
  assert.equal(big.result.structuredContent.assets.length, 100);
  console.log(`[mcp-slim] asset_list limit:100 response bytes: ${bigBytes}`);

  const defaults = await server.request("tools/call", { name: "asset_list", arguments: {} });
  const defaultBytes = Buffer.byteLength(JSON.stringify(defaults));
  assert.ok(defaultBytes < 18000, `default page must stay under 18000 bytes, measured ${defaultBytes}`);
  assert.equal(defaults.result.structuredContent.assets.length, 20);
  console.log(`[mcp-slim] asset_list {} (default 20) response bytes: ${defaultBytes}`);

  for (const asset of [...big.result.structuredContent.assets, ...defaults.result.structuredContent.assets]) {
    assertSlimFields(asset, asset.id);
    assert.ok(asset.prompt_excerpt.length > 0, "the seeded prompts are non-empty");
  }
  assert.equal(big.result.structuredContent.total, ASSET_COUNT);
  assert.equal(big.result.structuredContent.next_cursor, null, "a page holding everything has no next cursor");
});

test("3. asset_list pages through all 100 assets without gaps or repeats", async () => {
  const { server } = await setupOnce();

  const seen = [];
  let cursor;
  let lastTotal = null;
  let pages = 0;
  do {
    const response = await server.request("tools/call", { name: "asset_list", arguments: cursor ? { limit: 20, cursor } : { limit: 20 } });
    lastTotal = response.result.structuredContent.total;
    seen.push(...response.result.structuredContent.assets.map((asset) => asset.id));
    cursor = response.result.structuredContent.next_cursor;
    pages += 1;
    assert.ok(pages <= 6, "pagination terminates after 5 pages");
  } while (cursor);

  assert.equal(pages, 5, "100 assets at 20 per page need exactly 5 pages");
  assert.equal(seen.length, ASSET_COUNT);
  assert.equal(new Set(seen).size, ASSET_COUNT, "no asset id repeats across pages");
  assert.equal(lastTotal, ASSET_COUNT, "total stays 100 on every page");
  assert.deepEqual([...seen].sort(), [...SEEDED_IDS].sort());
});

test("4. asset_search pages through all 100 matches without gaps or repeats", async () => {
  const { server } = await setupOnce();

  const seen = [];
  let cursor;
  let total = null;
  do {
    const response = await server.request("tools/call", { name: "asset_search", arguments: cursor ? { query: "slimtag", limit: 20, cursor } : { query: "slimtag", limit: 20 } });
    total = response.result.structuredContent.total;
    const results = response.result.structuredContent.results;
    assert.ok(results.every((entry) => entry.match && entry.match.lexical_rank >= 1), "the match scoring layer survives");
    seen.push(...results.map((entry) => entry.asset.id));
    cursor = response.result.structuredContent.next_cursor;
    assert.ok(seen.length <= ASSET_COUNT, "pagination terminates");
  } while (cursor);

  assert.equal(total, ASSET_COUNT, "search total equals the seeded asset count");
  assert.equal(seen.length, ASSET_COUNT);
  assert.equal(new Set(seen).size, ASSET_COUNT, "no asset id repeats across search pages");
});

test("5. stacked assets carry stack { id, name } in slim results; unstacked ones omit the key", async () => {
  const { server, stackId } = await setupOnce();

  const listed = await server.request("tools/call", { name: "asset_list", arguments: { limit: 100 } });
  const byId = new Map(listed.result.structuredContent.assets.map((asset) => [asset.id, asset]));
  assert.deepEqual(byId.get("slim-000").stack, { id: stackId, name: "瘦身堆叠" });
  assert.deepEqual(byId.get("slim-001").stack, { id: stackId, name: "瘦身堆叠" });
  assert.equal("stack" in byId.get("slim-002"), false, "unstacked assets omit the stack key");

  const searched = await server.request("tools/call", { name: "asset_search", arguments: { query: "slimtag", limit: 100 } });
  const searchById = new Map(searched.result.structuredContent.results.map((entry) => [entry.asset.id, entry.asset]));
  for (const asset of searchById.values()) assertSlimFields(asset, `search:${asset.id}`);
  assert.deepEqual(searchById.get("slim-000").stack, { id: stackId, name: "瘦身堆叠" });
  assert.equal("stack" in searchById.get("slim-002"), false);
});

test("6. content text leads with the bilingual summary and one line per asset on the page", async () => {
  const { server } = await setupOnce();

  let cursor;
  let firstText = null;
  let lastText = null;
  let pages = 0;
  do {
    const response = await server.request("tools/call", { name: "asset_list", arguments: cursor ? { limit: 20, cursor } : { limit: 20 } });
    firstText ??= response.result.content[0].text;
    lastText = response.result.content[0].text;
    cursor = response.result.structuredContent.next_cursor;
    pages += 1;
    assert.ok(pages <= 6, "pagination terminates");
  } while (cursor);
  assert.equal(pages, 5);

  const firstLines = firstText.split("\n");
  assert.match(firstLines[0], /^共 100 张，这页 20 张。\/ 100 assets, 20 on this page\. 还有更多，传 cursor 翻页。\/ More results: pass cursor\.$/);
  assert.equal(firstLines.length - 1, 20, "one line per asset on this page below the summary");

  const lastLines = lastText.split("\n");
  assert.match(lastLines[0], /^共 100 张，这页 20 张。\/ 100 assets, 20 on this page\.$/, "no paging hint on the last page");
  assert.equal(lastLines.length - 1, 20);

  const searched = await server.request("tools/call", { name: "asset_search", arguments: { query: "slimtag", limit: 20 } });
  const searchLines = searched.result.content[0].text.split("\n");
  assert.match(searchLines[0], /^找到 100 张，这页 20 张。\/ 100 matches, 20 on this page\. 还有更多，传 cursor 翻页。\/ More results: pass cursor\.$/);
  assert.equal(searchLines.length - 1, 20);
  assert.match(searchLines[1], /^slim-\d{3} · slim-\d{3}\.png$/, `asset lines are "<id> · <file_name>", got ${JSON.stringify(searchLines[1])}`);
});

test("7. a 400000-character query echoes back at most 201 characters in a small answer", async () => {
  const { server } = await setupOnce();

  const hugeQuery = "红".repeat(400000);
  const requestId = server.send("tools/call", { name: "asset_search", arguments: { query: hugeQuery, limit: 20 } });
  const response = await server.waitForResponse(requestId, { timeoutMs: 60000 });
  const bytes = Buffer.byteLength(JSON.stringify(response));
  assert.ok(bytes < 10000, `a huge-query answer must stay under 10000 bytes, measured ${bytes}`);
  const echoed = [...response.result.structuredContent.query];
  assert.ok(echoed.length <= 201, "the echoed query is at most 200 characters plus an ellipsis");
  assert.ok(echoed.at(-1) === "…", "the echoed query is cut with an ellipsis");
  console.log(`[mcp-slim] asset_search 400000-char query response bytes: ${bytes}, echoed query characters: ${echoed.length}`);
});

test("8. asset_get still returns the full payload with recipe snapshots", async () => {
  const { server } = await setupOnce();

  const fetched = await server.callToolStrict("asset_get", { assetId: "slim-006" });
  const asset = fetched.structuredContent.asset;
  assert.equal(asset.id, "slim-006");
  assert.equal(asset.prompt, PROMPT_500, "the full 500-character prompt survives on asset_get");
  assert.ok(Array.isArray(asset.recipe_snapshots) && asset.recipe_snapshots.length >= 1, "the recipe snapshot is present");
  assert.deepEqual(asset.tags, ["slimtag", "tag6"]);
  assert.equal(asset.rating, 2);
  assert.equal(asset.favorite, true);
  assert.equal(asset.stack, null, "asset_get keeps the full stack shape (null when unstacked)");

  const stacked = await server.callToolStrict("asset_get", { assetId: "slim-000" });
  assert.ok(stacked.structuredContent.asset.stack.id, "asset_get stack summary carries the stack id");
  assert.equal(typeof stacked.structuredContent.asset.stack.count, "number", "asset_get keeps count on the stack summary");
});

test("9. slim list/search schemas: default 20, maximum 100, cursor accepted on search", async () => {
  const { server } = await setupOnce();

  const tools = (await server.request("tools/list")).result.tools;
  const listTool = tools.find((tool) => tool.name === "asset_list");
  const searchTool = tools.find((tool) => tool.name === "asset_search");
  const getTool = tools.find((tool) => tool.name === "asset_get");
  assert.equal(listTool.inputSchema.properties.limit.maximum, 100);
  assert.equal(listTool.inputSchema.properties.limit.default, 20);
  assert.equal("cursor" in searchTool.inputSchema.properties, true, "asset_search accepts cursor");
  assert.match(getTool.description, /asset_list and asset_search return only compact summaries/);
  assert.match(listTool.description, /use asset_get for an asset's full recipe and metadata/);

  const overLimit = await server.request("tools/call", { name: "asset_list", arguments: { limit: 101 } });
  assert.equal(overLimit.error?.code, -32602);
  assert.match(overLimit.error.message, /must be <= 100/);
});
