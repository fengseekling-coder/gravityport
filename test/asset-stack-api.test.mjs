import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { uniquePngBytes } from "./helpers/unique-image.mjs";

function mutationHeaders(runtime) {
  return { "content-type": "application/json", "x-mosa-client-token": runtime.clientToken };
}

async function startStackRuntime(t) {
  const root = await mkdtemp(join(tmpdir(), "mosa-stack-api-"));
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

  const create = async (id, extra = {}) => {
    const response = await fetch(`${runtime.url}/api/assets/create`, {
      method: "POST",
      headers: mutationHeaders(runtime),
      body: JSON.stringify({
        projectId: "default",
        assetId: id,
        imagePath: join(generated, `${id}.png`),
        prompt: `prompt ${id}`,
        ...extra,
      }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).asset;
  };
  return { runtime, create, generated };
}

test("Stack API keeps raw assets complete while gallery view collapses to one logical node", async (t) => {
  const { runtime, create } = await startStackRuntime(t);
  await create("a", { source: { type: "web-chatgpt" } });
  await create("b", { source: { type: "web-flow", media_kind: "video" }, favorite: true, prompt: "hidden needle" });
  await create("c", { source: { type: "local-file" } });

  const stacked = await fetch(`${runtime.url}/api/asset-stacks`, {
    method: "POST",
    headers: mutationHeaders(runtime),
    body: JSON.stringify({ projectId: "default", assetIds: ["a", "b"], coverAssetId: "a" }),
  });
  assert.equal(stacked.status, 201);
  const stack = (await stacked.json()).stack;
  assert.equal(stack.count, 2);

  const stackPageOne = await (await fetch(`${runtime.url}/api/asset-stacks/${encodeURIComponent(stack.id)}/assets?project=default&limit=1`)).json();
  assert.deepEqual(stackPageOne.assets.map((asset) => asset.id), ["a"]);
  assert.equal(stackPageOne.page.total, 2);
  assert.equal(typeof stackPageOne.page.nextCursor, "string");
  const stackPageTwo = await (await fetch(`${runtime.url}/api/asset-stacks/${encodeURIComponent(stack.id)}/assets?project=default&limit=1&cursor=${encodeURIComponent(stackPageOne.page.nextCursor)}`)).json();
  assert.deepEqual(stackPageTwo.assets.map((asset) => asset.id), ["b"]);
  assert.equal(stackPageTwo.page.nextCursor, null);

  const raw = await (await fetch(`${runtime.url}/api/assets?project=default&limit=100`)).json();
  assert.deepEqual(raw.assets.map((asset) => asset.id).sort(), ["a", "b", "c"]);

  const gallery = await (await fetch(`${runtime.url}/api/assets?project=default&view=gallery&limit=100`)).json();
  assert.deepEqual(gallery.assets.map((asset) => asset.id).sort(), ["a", "c"]);
  assert.deepEqual(gallery.assets.find((asset) => asset.id === "a").stack, { id: stack.id, count: 2, name: "" });

  for (const query of [
    "view=gallery&source=web-flow",
    "view=gallery&favorite=1",
    "view=gallery&mediaKind=video",
  ]) {
    const result = await (await fetch(`${runtime.url}/api/assets?project=default&limit=100&${query}`)).json();
    assert.deepEqual(result.assets.map((asset) => asset.id), ["b"]);
    assert.deepEqual(result.assets[0].stack, { id: stack.id, count: 2, match_count: 1, name: "" });
    assert.equal(result.page.total, 1);
  }

  // A search query flattens the stack instead of surfacing a stack node: the
  // matching image is listed on its own with no stack annotation.
  const searched = await (await fetch(`${runtime.url}/api/assets?project=default&limit=100&view=gallery&q=hidden%20needle`)).json();
  assert.deepEqual(searched.assets.map((asset) => asset.id), ["b"]);
  assert.equal(searched.assets[0].stack, undefined);
  assert.equal(searched.page.total, 1);

  const inside = await (await fetch(`${runtime.url}/api/asset-stacks/${encodeURIComponent(stack.id)}/assets?project=default&q=hidden%20needle`)).json();
  assert.deepEqual(inside.assets.map((asset) => asset.id), ["b"]);

  const dissolved = await fetch(`${runtime.url}/api/asset-stacks/${encodeURIComponent(stack.id)}`, {
    method: "DELETE",
    headers: mutationHeaders(runtime),
    body: JSON.stringify({ projectId: "default" }),
  });
  assert.equal(dissolved.status, 200);
  assert.deepEqual((await dissolved.json()).assetIds, ["a", "b"]);
  const afterDissolve = await (await fetch(`${runtime.url}/api/assets?project=default&view=gallery&limit=100`)).json();
  assert.deepEqual(afterDissolve.assets.map((asset) => asset.id).sort(), ["a", "b", "c"]);
});

test("gallery search flattens stack members until the query clears", async (t) => {
  const { runtime, create } = await startStackRuntime(t);
  await create("a", { prompt: "harbor night sky", favorite: true });
  await create("b", { prompt: "aurora dawn mist" });
  await create("c", { prompt: "aurora night fog" });
  await create("d", { prompt: "city shoreline" });

  const stacked = await fetch(`${runtime.url}/api/asset-stacks`, {
    method: "POST",
    headers: mutationHeaders(runtime),
    body: JSON.stringify({ projectId: "default", assetIds: ["a", "b", "c"], coverAssetId: "a" }),
  });
  assert.equal(stacked.status, 201);
  const stack = (await stacked.json()).stack;
  assert.equal(stack.count, 3);

  // Without a query the gallery view still collapses the stack into one node.
  const gallery = await (await fetch(`${runtime.url}/api/assets?project=default&view=gallery&limit=100`)).json();
  assert.deepEqual(gallery.assets.map((asset) => asset.id).sort(), ["a", "d"]);
  assert.deepEqual(gallery.assets.find((asset) => asset.id === "a").stack, { id: stack.id, count: 3, name: "" });

  // Searching "aurora" matches the two stacked images; each hit is listed on
  // its own and no stack node appears anywhere.
  const searched = await (await fetch(`${runtime.url}/api/assets?project=default&view=gallery&limit=100&q=aurora`)).json();
  assert.deepEqual(searched.assets.map((asset) => asset.id).sort(), ["b", "c"]);
  assert.equal(searched.page.total, 2);
  assert.ok(searched.assets.every((asset) => !asset.stack), "search results carry no stack node");

  // The incremental reconciliation endpoint must agree with the list endpoint
  // under the same query: affected stack members reconcile as flat assets.
  const searchedRows = await (await fetch(`${runtime.url}/api/gallery-rows`, {
    method: "POST",
    headers: mutationHeaders(runtime),
    body: JSON.stringify({
      projectId: "default",
      assetIds: ["b", "c"],
      request: { query: "aurora", view: "gallery", scope: "all", sort: "newest" },
    }),
  })).json();
  assert.deepEqual(searchedRows.rows.map((row) => row.id).sort(), ["b", "c"]);
  assert.deepEqual(searchedRows.rowByAssetId, { b: "b", c: "c" });
  assert.ok(searchedRows.rows.every((row) => !row.stack), "reconciled search rows are flat assets");

  // A query matching the stack cover must also flatten: the cover is listed as
  // a plain image on both endpoints, with no stack annotation anywhere.
  const coverHit = await (await fetch(`${runtime.url}/api/assets?project=default&view=gallery&limit=100&q=harbor`)).json();
  assert.deepEqual(coverHit.assets.map((asset) => asset.id), ["a"]);
  assert.equal(coverHit.assets[0].stack, undefined);
  assert.equal(coverHit.page.total, 1);

  const coverHitRows = await (await fetch(`${runtime.url}/api/gallery-rows`, {
    method: "POST",
    headers: mutationHeaders(runtime),
    body: JSON.stringify({
      projectId: "default",
      assetIds: ["a"],
      request: { query: "harbor", view: "gallery", scope: "all", sort: "newest" },
    }),
  })).json();
  assert.deepEqual(coverHitRows.rows.map((row) => row.id), ["a"]);
  assert.deepEqual(coverHitRows.rowByAssetId, { a: "a" });
  assert.ok(coverHitRows.rows.every((row) => !row.stack), "reconciled cover hit is a flat asset");

  // The raw asset list (no view=gallery) keeps the cover annotation for its
  // data-oriented callers (exports, audits): suppressing it is search-only.
  const raw = await (await fetch(`${runtime.url}/api/assets?project=default&limit=100`)).json();
  assert.deepEqual(raw.assets.find((asset) => asset.id === "a").stack, { id: stack.id, count: 3, name: "" });
  assert.equal(raw.assets.find((asset) => asset.id === "b").stack, undefined);

  // Filters without a query keep the collapsing behavior on both endpoints.
  const favorites = await (await fetch(`${runtime.url}/api/assets?project=default&view=gallery&limit=100&favorite=1`)).json();
  assert.deepEqual(favorites.assets.map((asset) => asset.id), ["a"]);
  assert.deepEqual(favorites.assets[0].stack, { id: stack.id, count: 3, match_count: 1, name: "" });

  const noQueryRows = await (await fetch(`${runtime.url}/api/gallery-rows`, {
    method: "POST",
    headers: mutationHeaders(runtime),
    body: JSON.stringify({
      projectId: "default",
      assetIds: ["b"],
      request: { query: "", view: "gallery", scope: "all", sort: "newest" },
    }),
  })).json();
  assert.deepEqual(noQueryRows.rowByAssetId, { b: "a" });
  assert.deepEqual(noQueryRows.rows.find((row) => row.id === "a").stack, { id: stack.id, count: 3, name: "" });
});

test("manual imports can target the currently open Stack", async (t) => {
  const { runtime, create, generated } = await startStackRuntime(t);
  await create("a");
  await create("b");

  const stacked = await fetch(`${runtime.url}/api/asset-stacks`, {
    method: "POST",
    headers: mutationHeaders(runtime),
    body: JSON.stringify({ projectId: "default", assetIds: ["a", "b"], coverAssetId: "a" }),
  });
  const stack = (await stacked.json()).stack;

  const single = await fetch(`${runtime.url}/api/assets/create`, {
    method: "POST",
    headers: mutationHeaders(runtime),
    body: JSON.stringify({
      projectId: "default",
      stackId: stack.id,
      assetId: "c",
      imagePath: join(generated, "c.png"),
    }),
  });
  assert.equal(single.status, 200);

  const batch = await fetch(`${runtime.url}/api/assets/import-batch`, {
    method: "POST",
    headers: mutationHeaders(runtime),
    body: JSON.stringify({
      projectId: "default",
      stackId: stack.id,
      items: [{ assetId: "d", imagePath: join(generated, "d.png"), fileName: "d.png" }],
    }),
  });
  assert.equal(batch.status, 200);
  assert.equal((await batch.json()).imported, 1);

  const inside = await (await fetch(
    `${runtime.url}/api/asset-stacks/${encodeURIComponent(stack.id)}/assets?project=default&limit=100`,
  )).json();
  assert.deepEqual(inside.assets.map((asset) => asset.id), ["a", "b", "c", "d"]);
});

test("Stack rename PATCH persists a display name and surfaces it on gallery nodes", async (t) => {
  const { runtime, create } = await startStackRuntime(t);
  await create("a");
  await create("b");

  const stacked = await fetch(`${runtime.url}/api/asset-stacks`, {
    method: "POST",
    headers: mutationHeaders(runtime),
    body: JSON.stringify({ projectId: "default", assetIds: ["a", "b"], coverAssetId: "a" }),
  });
  const stack = (await stacked.json()).stack;

  const renamed = await fetch(`${runtime.url}/api/asset-stacks/${encodeURIComponent(stack.id)}`, {
    method: "PATCH",
    headers: mutationHeaders(runtime),
    body: JSON.stringify({ projectId: "default", name: "  Mood board  " }),
  });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).stack.name, "Mood board");

  const reread = await (await fetch(`${runtime.url}/api/asset-stacks/${encodeURIComponent(stack.id)}?project=default`)).json();
  assert.equal(reread.stack.name, "Mood board");

  const gallery = await (await fetch(`${runtime.url}/api/assets?project=default&view=gallery&limit=100`)).json();
  assert.equal(gallery.assets.find((asset) => asset.id === "a").stack.name, "Mood board");

  const empty = await fetch(`${runtime.url}/api/asset-stacks/${encodeURIComponent(stack.id)}`, {
    method: "PATCH",
    headers: mutationHeaders(runtime),
    body: JSON.stringify({ projectId: "default", name: "   " }),
  });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).code, "STACK_NAME_EMPTY");
});

test("Stack navigation-group assignment moves the whole logical Stack and survives hidden-member restore", async (t) => {
  const { runtime, create } = await startStackRuntime(t);
  await create("a");
  await create("b");
  await create("c");

  for (const name of ["Big A", "Big B"]) {
    const created = await fetch(`${runtime.url}/api/groups`, {
      method: "POST",
      headers: mutationHeaders(runtime),
      body: JSON.stringify({ projectId: "default", name }),
    });
    assert.equal(created.status, 201);
  }

  const stacked = await fetch(`${runtime.url}/api/asset-stacks`, {
    method: "POST",
    headers: mutationHeaders(runtime),
    body: JSON.stringify({ projectId: "default", assetIds: ["a", "b"], coverAssetId: "a" }),
  });
  const stack = (await stacked.json()).stack;

  const assignedA = await fetch(`${runtime.url}/api/asset-stacks/${encodeURIComponent(stack.id)}/group`, {
    method: "POST",
    headers: mutationHeaders(runtime),
    body: JSON.stringify({ projectId: "default", group: "Big A" }),
  });
  assert.equal(assignedA.status, 200);
  assert.deepEqual((await assignedA.json()).stack.assetIds, ["a", "b"]);

  const galleryA = await (await fetch(
    `${runtime.url}/api/assets?project=default&view=gallery&group=${encodeURIComponent("Big A")}&limit=100`,
  )).json();
  assert.deepEqual(galleryA.assets.map((asset) => asset.id), ["a"]);
  assert.equal(galleryA.assets[0].stack.id, stack.id);
  assert.equal(galleryA.assets[0].stack.count, 2);

  const trashed = await fetch(`${runtime.url}/api/assets/batch`, {
    method: "POST",
    headers: mutationHeaders(runtime),
    body: JSON.stringify({ action: "trash", projectId: "default", assetIds: ["b"] }),
  });
  assert.equal(trashed.status, 200);

  const assignedB = await fetch(`${runtime.url}/api/asset-stacks/${encodeURIComponent(stack.id)}/group`, {
    method: "POST",
    headers: mutationHeaders(runtime),
    body: JSON.stringify({ projectId: "default", group: "Big B" }),
  });
  assert.equal(assignedB.status, 200);
  assert.deepEqual((await assignedB.json()).stack.assetIds, ["a", "b"]);

  const restored = await fetch(`${runtime.url}/api/assets/default/b/restore`, {
    method: "POST",
    headers: mutationHeaders(runtime),
  });
  assert.equal(restored.status, 200);

  const raw = await (await fetch(`${runtime.url}/api/assets?project=default&limit=100`)).json();
  assert.equal(raw.assets.find((asset) => asset.id === "a").group, "Big B");
  assert.equal(raw.assets.find((asset) => asset.id === "b").group, "Big B");

  const galleryB = await (await fetch(
    `${runtime.url}/api/assets?project=default&view=gallery&group=${encodeURIComponent("Big B")}&limit=100`,
  )).json();
  assert.deepEqual(galleryB.assets.map((asset) => asset.id), ["a"]);
  assert.equal(galleryB.assets[0].stack.id, stack.id);
  assert.equal(galleryB.assets[0].stack.count, 2);
});
