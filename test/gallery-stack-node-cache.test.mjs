// gallery-stack-node-cache.test.mjs — cache-contract test for the collapsed
// gallery's stack-node cache (review 265 中-2 / task 320). The temp-table
// cache must produce byte-identical pages to a cacheless recomputation after
// every stack/trash/archive mutation, and a write from ANOTHER store instance
// (different connection) must invalidate through PRAGMA data_version.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const SORTS = ["newest", "oldest", "name"];
const PAGE_SIZE = 3;

function pageSignature(page) {
  return JSON.stringify({
    ids: page.assets.map(asset => asset.id),
    counts: page.assets.map(asset => asset.stack?.count ?? 1),
    matchCounts: page.assets.map(asset => asset.stack?.match_count ?? null),
    nodeSort: page.assets.map(asset => asset.node_sort ?? null),
    total: page.page.total,
    nextCursor: page.page.nextCursor,
  });
}

// Walks the whole collapsed view page by page (cursor-driven, like the
// gallery does) and folds every page into one signature.
async function pageThrough(store, sort) {
  const signatures = [];
  let cursor;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await store.listAssetPage({
      projectId: "default", collapseStacks: true, sort, cursor, limit: PAGE_SIZE, includeTotal: true,
    });
    signatures.push(pageSignature(page));
    if (!page.page.nextCursor) break;
    cursor = page.page.nextCursor;
  }
  return signatures;
}

async function createStorePair(t) {
  const root = await mkdtemp(join(tmpdir(), "mosa-stack-node-cache-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const generated = join(root, "generated-images");
  await mkdir(generated, { recursive: true });
  await writeFile(join(generated, "pixel.png"), ONE_PIXEL_PNG);
  // A and B share one mosa.db: B's writes must reach A through data_version.
  const options = { projectRoot: root, managerDir: root, libraryDir: join(root, "library"), initializeFreshLibrary: true };
  const a = createSqliteAssetStore(options);
  const b = createSqliteAssetStore(options);
  t.after(() => { try { a.close(); } catch { /* closed */ } try { b.close(); } catch { /* closed */ } });
  await a.ensureProject("default");
  const imagePath = join(generated, "pixel.png");
  const makeAsset = async (id, theme) => (await a.createAsset({ assetId: id, imagePath, theme }));
  return { a, b, makeAsset, root };
}

test("cached collapsed pages equal cacheless pages through every mutation", async (t) => {
  const { a, b, makeAsset } = await createStorePair(t);
  const ids = [];
  for (let i = 0; i < 7; i += 1) ids.push((await makeAsset(`cache-${i}`, `Asset ${String(7 - i)}`)).id);

  // Helper: cached run (A, cache on) vs cacheless run (B, cache off via env)
  // over the same db state.
  const compare = async (label) => {
    process.env.MOSA_GALLERY_STACK_NODES_CACHE = "off";
    const uncached = {};
    for (const sort of SORTS) uncached[sort] = await pageThrough(b, sort);
    process.env.MOSA_GALLERY_STACK_NODES_CACHE = "on";
    const cached = {};
    for (const sort of SORTS) cached[sort] = await pageThrough(a, sort);
    for (const sort of SORTS) {
      assert.deepEqual(cached[sort], uncached[sort], `${label} · sort ${sort}: cached pages differ`);
    }
  };

  await compare("no stacks");
  const stack1 = await a.createAssetStack("default", [ids[0], ids[1], ids[2]], { coverAssetId: ids[0] });
  await compare("after create stack");
  await compare("same state again (cache hit)");
  await a.addAssetsToStack("default", stack1.id, [ids[3]]);
  await compare("after add member");
  await a.reorderAssetStack("default", stack1.id, [ids[3], ids[0], ids[1], ids[2]]);
  await compare("after reorder");
  await a.deleteAsset("default", ids[1]);
  await compare("after trash member");
  await a.restoreAsset("default", ids[1]);
  await compare("after restore");
  await a.toggleFavorite("default", ids[4], true);
  await compare("after favorite (metadata only)");
  await a.removeAssetsFromStack("default", stack1.id, [ids[3]]);
  await compare("after remove member");
  // 跨连接写：堆叠必须存活，否则折叠路径整体退出、缓存不再参与对照。
  await b.addAssetsToStack("default", stack1.id, [ids[6]]);
  await compare("after cross-store add member");
  const stack2 = await a.createAssetStack("default", [ids[4], ids[5]], { coverAssetId: ids[4] });
  await a.moveAssetsToStack("default", [ids[6]], stack2.id);
  await compare("after move-into-stack");
  await a.archiveAsset("default", ids[5]);
  await compare("after archive member");
  await b.addAssetsToStack("default", stack2.id, [ids[3]]);
  await compare("after second cross-store add");
  await b.dissolveAssetStack("default", stack1.id);
  await compare("after cross-store dissolve (folds back to flat)");
});

test("a second page request with no intervening write is served from the cache unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-stack-node-cache-hit-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const generated = join(root, "generated-images");
  await mkdir(generated, { recursive: true });
  await writeFile(join(generated, "pixel.png"), ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({
    projectRoot: root, managerDir: root, libraryDir: join(root, "library"), initializeFreshLibrary: true,
  });
  try {
    await store.ensureProject("default");
    const imagePath = join(generated, "pixel.png");
    const ids = [];
    for (let i = 0; i < 8; i += 1) {
      ids.push((await store.createAsset({ assetId: `hit-${i}`, imagePath, theme: `Hit ${i}` })).id);
    }
    await store.createAssetStack("default", [ids[0], ids[1], ids[2]]);
    process.env.MOSA_GALLERY_STACK_NODES_CACHE = "on";
    const first = [];
    let cursor;
    for (;;) {
      const page = await store.listAssetPage({ projectId: "default", collapseStacks: true, sort: "newest", cursor, limit: 3, includeTotal: true });
      first.push(pageSignature(page));
      if (!page.page.nextCursor) break;
      cursor = page.page.nextCursor;
    }
    const second = [];
    cursor = undefined;
    for (;;) {
      const page = await store.listAssetPage({ projectId: "default", collapseStacks: true, sort: "newest", cursor, limit: 3, includeTotal: true });
      second.push(pageSignature(page));
      if (!page.page.nextCursor) break;
      cursor = page.page.nextCursor;
    }
    assert.deepEqual(second, first, "the cached second pass must be identical");
  } finally {
    delete process.env.MOSA_GALLERY_STACK_NODES_CACHE;
    try { store.close(); } catch { /* closed */ }
  }
});

test("two projects sharing one connection page identically with the cache on (320 补充 1)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-stack-cache-multiproject-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const generated = join(root, "generated-images");
  await mkdir(generated, { recursive: true });
  await writeFile(join(generated, "pixel.png"), ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({
    projectRoot: root, managerDir: root, libraryDir: join(root, "library"), initializeFreshLibrary: true,
  });
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  await store.ensureProject("default");
  await store.ensureProject("p2");
  const imagePath = join(generated, "pixel.png");
  const make = async (projectId, assetId, theme) =>
    store.createAsset({ projectId, assetId, imagePath, theme });
  // p2：先建 3 张、2 张成堆叠；default：后建 6 张、3 个两两堆叠。
  // default 的行更新（newest 排前、name 的 D 排前），无过滤时会占满 LIMIT。
  const p2Ids = [];
  for (const [id, theme] of [["shared-1", "P2 One"], ["shared-2", "P2 Two"], ["p2-c", "P2 Three"]]) {
    p2Ids.push((await make("p2", id, theme)).id);
  }
  await store.createAssetStack("p2", [p2Ids[0], p2Ids[1]]);
  const defIds = [];
  for (let i = 0; i < 6; i += 1) defIds.push((await make("default", `def-${i}`, `Def ${String.fromCharCode(65 + i)}`)).id);
  await store.createAssetStack("default", [defIds[0], defIds[1]]);
  await store.createAssetStack("default", [defIds[2], defIds[3]]);
  await store.createAssetStack("default", [defIds[4], defIds[5]]);

  const walk = async (project, sort) => {
    const pages = [];
    let cursor;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await store.listAssetPage({ projectId: project, collapseStacks: true, sort, cursor, limit: 2, includeTotal: true });
      pages.push(page.assets.map(a => a.id));
      if (!page.page.nextCursor) break;
      cursor = page.page.nextCursor;
    }
    return pages;
  };
  // 先翻 default 暖缓存，再翻 p2——别的项目的行不得挤占/串项目。
  for (const sort of SORTS) {
    process.env.MOSA_GALLERY_STACK_NODES_CACHE = "on";
    const cachedDefault = await walk("default", sort);
    const cachedP2 = await walk("p2", sort);
    process.env.MOSA_GALLERY_STACK_NODES_CACHE = "off";
    const uncachedDefault = await walk("default", sort);
    const uncachedP2 = await walk("p2", sort);
    assert.deepEqual(cachedDefault, uncachedDefault, `default · sort ${sort}: cached pages differ`);
    assert.deepEqual(cachedP2, uncachedP2, `p2 · sort ${sort}: cached pages differ`);
    for (const id of cachedP2.flat()) {
      assert.ok(id.startsWith("p2") || id.startsWith("shared"), `p2 page leaked a foreign row: ${id}`);
    }
    assert.ok(cachedP2.flat().includes("p2-c"), `p2 plain card missing under cache (sort ${sort})`);
    // 关键断言：p2 的堆叠节点卡必须在页里（cover = shared-1）。去掉项目过滤
    // 后 default 的节点占满 LIMIT，这张卡会被挤掉——cached/uncached 一起错，
    // deepEqual 抓不到，只有这条能红。
    assert.ok(cachedP2.flat().includes(p2Ids[0]), `p2 stack node card missing under cache (sort ${sort})`);
  }
});
