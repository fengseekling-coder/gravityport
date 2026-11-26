import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJsonAssetStore } from "../lib/asset-store.mjs";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

const FIXTURES = [
  { assetId: "asset-a", theme: "Zebra crossing", style: "poster", created_at: "2026-01-05T00:00:00.000Z", source: { conversation_id: "session-a", message_id: "turn-1" } },
  { assetId: "asset-b", theme: "Alpine ridge", style: "poster", created_at: "2026-03-05T00:00:00.000Z", source: { conversation_id: "session-a", message_id: "turn-1" } },
  { assetId: "asset-c", theme: "Meadow light", style: "collage", created_at: "2026-02-05T00:00:00.000Z", source: { conversation_id: "session-a", message_id: "turn-2" } },
  { assetId: "asset-d", theme: "beacon dusk", style: "collage", created_at: "2026-05-05T00:00:00.000Z", source: { conversation_id: "session-b", message_id: "turn-1" } },
  { assetId: "asset-e", theme: "Canyon wall", style: "poster", created_at: "2026-04-05T00:00:00.000Z", source: { conversation_id: "session-a" } },
];

async function startSeededRuntime(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const assetsRoot = join(root, "assets");
  const store = createJsonAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), assetsRoot });
  for (const fixture of FIXTURES) await store.createAsset({ ...fixture, imagePath: sourcePath });

  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: root,
    libraryDir: join(root, "library"),
    assetsRoot,
    generatedImagesDir: join(projectRoot, "generated-images"),
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "sessions"),
    codexThreadHistoryDir: join(root, "codex-thread-history"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-data"),
    cowartRegistryPath: join(root, "state", "cowart-projects.json"),
  });
  t.after(() => runtime.stop());
  return runtime;
}

/** Follows nextCursor so assertions describe the full result set. */
async function drain(url, params) {
  const ids = [];
  const search = new URLSearchParams(params);
  let cursor = null;
  for (let guard = 0; guard < 20; guard += 1) {
    if (cursor) search.set("cursor", cursor); else search.delete("cursor");
    const response = await fetch(`${url}/api/assets?${search}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    ids.push(...body.assets.map((asset) => asset.id));
    if (!body.page.nextCursor) return { ids, total: body.page.total, sort: body.page.sort };
    cursor = body.page.nextCursor;
  }
  throw new Error("pagination did not terminate");
}

test("GET /api/assets sorts the whole query and keeps the order across pages", async (t) => {
  const runtime = await startSeededRuntime(t, "mosa-sort-api-");

  const newest = await drain(runtime.url, { sort: "newest", limit: "2" });
  assert.deepEqual(newest.ids, ["asset-d", "asset-e", "asset-b", "asset-c", "asset-a"]);
  assert.equal(newest.total, 5);
  assert.equal(newest.sort, "newest");

  const oldest = await drain(runtime.url, { sort: "oldest", limit: "2" });
  assert.deepEqual(oldest.ids, ["asset-a", "asset-c", "asset-b", "asset-e", "asset-d"]);

  const byName = await drain(runtime.url, { sort: "name", limit: "2" });
  assert.deepEqual(byName.ids, ["asset-b", "asset-d", "asset-e", "asset-c", "asset-a"]);
  assert.equal(byName.sort, "name");

  // An unknown or absent sort keeps the historical newest-first contract.
  assert.deepEqual((await drain(runtime.url, { limit: "2" })).ids, newest.ids);
  assert.deepEqual((await drain(runtime.url, { sort: "rating", limit: "2" })).ids, newest.ids);
});

test("GET /api/assets combines facets with sort and rejects a mismatched cursor", async (t) => {
  const runtime = await startSeededRuntime(t, "mosa-sort-api-facets-");

  // style narrows the set; sort orders what is left.
  const posters = await drain(runtime.url, { style: "poster", sort: "name", limit: "2" });
  assert.deepEqual(posters.ids, ["asset-b", "asset-e", "asset-a"]);
  assert.equal(posters.total, 3);

  const postersOldest = await drain(runtime.url, { style: "poster", sort: "oldest", limit: "2" });
  assert.deepEqual(postersOldest.ids, ["asset-a", "asset-b", "asset-e"]);

  // A search term composes with both instead of replacing them.
  const searched = await drain(runtime.url, { style: "poster", q: "Alpine", sort: "name", limit: "2" });
  assert.deepEqual(searched.ids, ["asset-b"]);

  const firstPage = await (await fetch(`${runtime.url}/api/assets?sort=newest&limit=2`)).json();
  assert.ok(firstPage.page.nextCursor);
  const mismatched = await fetch(`${runtime.url}/api/assets?sort=name&limit=2&cursor=${encodeURIComponent(firstPage.page.nextCursor)}`);
  assert.equal(mismatched.status, 400, "a cursor from another order must not silently page the wrong ordering");
});

test("GET /api/assets exposes session and batch navigation as composable filters", async (t) => {
  const runtime = await startSeededRuntime(t, "mosa-generation-api-");

  const session = await drain(runtime.url, { conversation: "session-a", limit: "2" });
  assert.deepEqual(session.ids, ["asset-e", "asset-b", "asset-c", "asset-a"]);
  assert.equal(session.total, 4);

  const batch = await drain(runtime.url, { conversation: "session-a", generationBatch: "turn-1", limit: "1" });
  assert.deepEqual(batch.ids, ["asset-b", "asset-a"]);
  assert.equal(batch.total, 2);
});

test("GET /api/assets can skip exact totals on prefetched cursor pages", async (t) => {
  const runtime = await startSeededRuntime(t, "mosa-prefetch-api-");
  const first = await (await fetch(`${runtime.url}/api/assets?sort=newest&limit=2`)).json();
  assert.equal(first.page.total, 5);
  assert.ok(first.page.nextCursor);

  const prefetched = await (await fetch(`${runtime.url}/api/assets?sort=newest&limit=2&includeTotal=0&cursor=${encodeURIComponent(first.page.nextCursor)}`)).json();
  assert.equal(prefetched.page.total, null);
  assert.deepEqual(prefetched.assets.map((asset) => asset.id), ["asset-b", "asset-c"]);
  assert.ok(prefetched.page.nextCursor, "skipping COUNT must not change cursor pagination");
});

test("GET /api/groups reports the true style total behind a capped facet list", async (t) => {
  const runtime = await startSeededRuntime(t, "mosa-sort-api-groups-");
  const groups = await (await fetch(`${runtime.url}/api/groups`)).json();
  assert.equal(groups.groups.styleTotal, 2);
  assert.deepEqual(groups.groups.styles.map(([name]) => name).sort(), ["collage", "poster"]);
});

test("GET /api/navigation exposes only the sidebar counts without changing the full groups contract", async (t) => {
  const runtime = await startSeededRuntime(t, "mosa-navigation-api-");
  const response = await fetch(`${runtime.url}/api/navigation`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body.navigation).sort(), ["favorites", "groups", "sourceTypes", "total", "trash", "unorganized"]);
  assert.equal(body.navigation.total, 5);
  assert.equal(body.navigation.unorganized, 5);
  assert.equal(body.navigation.trash, 0);
});
