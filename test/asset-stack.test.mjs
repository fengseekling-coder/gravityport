import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

async function createFixtureStore(t) {
  const root = await mkdtemp(join(tmpdir(), "mosa-asset-stack-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  const generatedDir = join(projectRoot, "generated-images");
  await mkdir(generatedDir, { recursive: true });
  const sourcePath = join(generatedDir, "fixture.png");
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => store.close());
  for (const [index, id] of ["a", "b", "c", "d"].entries()) {
    await store.createAsset({
      assetId: id,
      imagePath: sourcePath,
      prompt: `stack fixture ${id}`,
      created_at: `2026-08-29T12:0${index}:00.000Z`,
      source: { type: "local-file" },
    });
  }
  return store;
}

test("asset stacks collapse to one gallery node and use the first member as cover", async (t) => {
  const store = await createFixtureStore(t);
  const stack = await store.createAssetStack("default", ["a", "b", "c"], { coverAssetId: "b" });
  assert.equal(stack.count, 3);
  assert.equal(stack.cover_asset_id, "b");

  const rootPage = await store.listAssetPage({ projectId: "default", limit: 0, sort: "oldest", collapseStacks: true });
  assert.deepEqual(rootPage.assets.map((asset) => asset.id), ["b", "d"]);
  assert.deepEqual(rootPage.assets[0].stack, { id: stack.id, count: 3, name: "" });

  const allAssets = await store.listAssets({ projectId: "default", sort: "oldest" });
  assert.deepEqual(allAssets.map((asset) => asset.id), ["a", "b", "c", "d"]);

  const inside = await store.listAssetStackAssets("default", stack.id);
  assert.deepEqual(inside.assets.map((asset) => asset.id), ["b", "a", "c"]);
  assert.deepEqual(inside.assets.map((asset) => asset.stack_position), [0, 1, 2]);
});

test("Unorganized excludes both manually grouped assets and assets already organized into a stack", async (t) => {
  const store = await createFixtureStore(t);
  await store.createGroup({ projectId: "default", name: "Reviewed" });
  await store.updateMetadata("default", "d", { group: "Reviewed" });
  await store.createAssetStack("default", ["a", "b"], { coverAssetId: "a" });

  const raw = await store.listAssets({ projectId: "default", unorganized: true, sort: "oldest" });
  assert.deepEqual(raw.map((asset) => asset.id), ["c"]);

  const gallery = await store.listAssetPage({ projectId: "default", unorganized: true, collapseStacks: true, limit: 0, sort: "oldest" });
  assert.deepEqual(gallery.assets.map((asset) => asset.id), ["c"]);
  assert.equal(gallery.page.total, 1);

  const stats = await store.listGroups("default");
  assert.equal(stats.unorganized, 1);
});

test("stack members page by stable manual position without changing the total", async (t) => {
  const store = await createFixtureStore(t);
  const stack = await store.createAssetStack("default", ["a", "b", "c", "d"], { coverAssetId: "b" });

  const first = await store.listAssetStackAssets("default", stack.id, { limit: 2 });
  assert.deepEqual(first.assets.map((asset) => asset.id), ["b", "a"]);
  assert.equal(first.page.total, 4);
  assert.equal(typeof first.page.nextCursor, "string");

  const second = await store.listAssetStackAssets("default", stack.id, { limit: 2, cursor: first.page.nextCursor });
  assert.deepEqual(second.assets.map((asset) => asset.id), ["c", "d"]);
  assert.equal(second.page.total, 4);
  assert.equal(second.page.nextCursor, null);

  await assert.rejects(
    store.listAssetStackAssets("default", stack.id, { limit: 2, cursor: first.page.nextCursor, query: "different" }),
    /Invalid Stack cursor/,
  );
});

// Once a project has a Stack, the plain root gallery takes the collapsed fast
// path. Its cursors must carry the same time-filter key the parser checks, or
// page two and boundary-aware row reconciliation both fail with 400.
test("collapsed root gallery cursors page and bound row reconciliation once a Stack exists", async (t) => {
  const store = await createFixtureStore(t);
  await store.createAssetStack("default", ["a", "b"], { coverAssetId: "a" });

  for (const sort of ["newest", "oldest", "name"]) {
    const first = await store.listAssetPage({ projectId: "default", limit: 2, sort, collapseStacks: true });
    assert.equal(first.assets.length, 2, `${sort}: first page`);
    assert.equal(typeof first.page.nextCursor, "string", `${sort}: first page has a cursor`);

    const second = await store.listAssetPage({ projectId: "default", limit: 2, sort, cursor: first.page.nextCursor, collapseStacks: true });
    assert.equal(second.assets.length, 1, `${sort}: second page holds the remaining node`);
    assert.equal(second.page.nextCursor, null, `${sort}: second page is the last`);
    const seen = [...first.assets, ...second.assets].map((asset) => asset.id).sort();
    assert.deepEqual(seen, ["a", "c", "d"], `${sort}: every root node appears exactly once`);

    const bounded = await store.listGalleryRowsForAssets(
      { projectId: "default", sort, collapseStacks: true, boundaryCursor: first.page.nextCursor },
      [second.assets[0].id],
    );
    assert.deepEqual(bounded.afterCursorRowIds, [second.assets[0].id], `${sort}: row past the boundary is deferred`);
  }
});

test("reordering changes the cover, adding appends, and one remaining member dissolves automatically", async (t) => {
  const store = await createFixtureStore(t);
  const stack = await store.createAssetStack("default", ["a", "b", "c"], { coverAssetId: "b" });

  const reordered = await store.reorderAssetStack("default", stack.id, ["c", "b", "a"]);
  assert.equal(reordered.cover_asset_id, "c");
  await store.addAssetsToStack("default", stack.id, ["d"]);
  assert.deepEqual((await store.listAssetStackAssets("default", stack.id)).assets.map((asset) => asset.id), ["c", "b", "a", "d"]);

  const removal = await store.removeAssetsFromStack("default", stack.id, ["c", "b", "d"]);
  assert.equal(removal.dissolved, true);
  assert.equal(removal.remainingAssetId, "a");
  assert.deepEqual((await store.listAssetPage({ projectId: "default", limit: 0, sort: "oldest", collapseStacks: true })).assets.map((asset) => asset.id), ["a", "b", "c", "d"]);
});

test("reordering visible Stack members ignores trashed members and preserves their restore slot", async (t) => {
  const store = await createFixtureStore(t);
  const stack = await store.createAssetStack("default", ["a", "b", "c", "d"], { coverAssetId: "a" });

  await store.deleteAsset("default", "b");
  assert.deepEqual(
    (await store.listAssetStackAssets("default", stack.id)).assets.map((asset) => asset.id),
    ["a", "c", "d"],
    "Trash hides the member from the reorderable Stack view while retaining membership for restore",
  );

  const reordered = await store.reorderAssetStack("default", stack.id, ["d", "a", "c"]);
  assert.equal(reordered.cover_asset_id, "d");
  assert.deepEqual(
    (await store.listAssetStackAssets("default", stack.id)).assets.map((asset) => asset.id),
    ["d", "a", "c"],
  );

  await store.restoreAsset("default", "b");
  assert.deepEqual(
    (await store.listAssetStackAssets("default", stack.id)).assets.map((asset) => asset.id),
    ["d", "b", "a", "c"],
    "restored members return to their retained hidden slot instead of invalidating active-member ordering",
  );
});

test("archiving a stack member compacts the stack and promotes a new cover", async (t) => {
  const store = await createFixtureStore(t);
  const stack = await store.createAssetStack("default", ["a", "b", "c"], { coverAssetId: "b" });
  await store.archiveAsset("default", "b");
  const summary = await store.getAssetStack("default", stack.id);
  assert.equal(summary.count, 2);
  assert.equal(summary.cover_asset_id, "a");
  assert.deepEqual((await store.listAssetStackAssets("default", stack.id)).assets.map((asset) => asset.id), ["a", "c"]);
});

test("root search maps hidden member matches back to one stack cover node", async (t) => {
  const store = await createFixtureStore(t);
  await store.updateMetadata("default", "b", { prompt: "neon orchid hidden member" });
  await store.updateMetadata("default", "c", { prompt: "neon orchid second hidden member" });
  const stack = await store.createAssetStack("default", ["a", "b", "c"], { coverAssetId: "a" });

  const page = await store.listAssetPage({ projectId: "default", query: "neon orchid", limit: 100, collapseStacks: true });
  assert.equal(page.page.total, 1);
  assert.deepEqual(page.assets.map((asset) => asset.id), ["b"]);
  assert.deepEqual(page.assets[0].stack, { id: stack.id, count: 3, match_count: 2, name: "" });

  const inside = await store.listAssetStackAssets("default", stack.id, { query: "neon orchid" });
  assert.deepEqual(inside.assets.map((asset) => asset.id), ["b", "c"]);
});

test("root search finds a collapsed Stack by its custom name without changing member-search semantics", async (t) => {
  const store = await createFixtureStore(t);
  await store.updateMetadata("default", "b", { group: "Campaign" });
  const stack = await store.createAssetStack("default", ["a", "b", "c"], { coverAssetId: "a" });
  await store.renameAssetStack("default", stack.id, "Autumn Launch Visuals");

  const page = await store.listAssetPage({ projectId: "default", query: "autumn launch", limit: 100, collapseStacks: true });
  assert.equal(page.page.total, 1);
  assert.deepEqual(page.assets.map((asset) => asset.id), ["a"]);
  assert.deepEqual(page.assets[0].stack, { id: stack.id, count: 3, name: "Autumn Launch Visuals" });

  const filtered = await store.listAssetPage({
    projectId: "default",
    query: "autumn launch",
    group: "Campaign",
    limit: 100,
    collapseStacks: true,
  });
  assert.deepEqual(filtered.assets.map((asset) => asset.id), ["b"], "the Stack name match still respects member facets");
  assert.equal(filtered.assets[0].stack.match_count, 1);

  const inside = await store.listAssetStackAssets("default", stack.id, { query: "autumn launch" });
  assert.deepEqual(inside.assets, [], "Stack-interior search continues to match member metadata, not the container name");
  const raw = await store.listAssetPage({ projectId: "default", query: "autumn launch", limit: 100 });
  assert.deepEqual(raw.assets, [], "raw asset queries do not manufacture asset matches from the Stack label");
});

test("root and Stack-interior searches share the same asset-kind intent semantics", async (t) => {
  const store = await createFixtureStore(t);
  await store.updateMetadata("default", "b", { prompt: "logo mark exploration" });
  await store.updateMetadata("default", "c", { prompt: "poster layout exploration" });
  const stack = await store.createAssetStack("default", ["a", "b", "c"], { coverAssetId: "a" });

  const rootLogo = await store.listAssetPage({ projectId: "default", query: "logo", collapseStacks: true, limit: 100 });
  assert.deepEqual(rootLogo.assets.map((asset) => asset.id), ["b"]);
  assert.deepEqual(rootLogo.assets[0].stack, { id: stack.id, count: 3, match_count: 1, name: "" });

  const insideLogo = await store.listAssetStackAssets("default", stack.id, { query: "logo" });
  assert.deepEqual(insideLogo.assets.map((asset) => asset.id), ["b"]);
  const insidePoster = await store.listAssetStackAssets("default", stack.id, { query: "poster" });
  assert.deepEqual(insidePoster.assets.map((asset) => asset.id), ["c"]);
});

test("gallery filters match hidden members while raw asset queries keep every member", async (t) => {
  const store = await createFixtureStore(t);
  const sourcePath = (await store.getAsset("default", "a")).image_path;
  await store.createAsset({
    assetId: "hidden-flow-video",
    imagePath: sourcePath,
    prompt: "hidden flow video",
    favorite: true,
    created_at: "2026-08-29T12:01:30.000Z",
    source: { type: "web-flow", media_kind: "video" },
  });
  const stack = await store.createAssetStack("default", ["a", "hidden-flow-video"], { coverAssetId: "a" });

  for (const filters of [
    { source: "web-flow" },
    { favorite: true },
    { mediaKind: "video" },
    { source: "web-flow", query: "hidden flow" },
  ]) {
    const page = await store.listAssetPage({ projectId: "default", collapseStacks: true, limit: 100, ...filters });
    assert.deepEqual(page.assets.map((asset) => asset.id), ["hidden-flow-video"]);
    assert.deepEqual(page.assets[0].stack, { id: stack.id, count: 2, match_count: 1, name: "" });
    assert.equal(page.page.total, 1);
  }

  const raw = await store.listAssetPage({ projectId: "default", source: "web-flow", limit: 100 });
  assert.deepEqual(raw.assets.map((asset) => asset.id), ["hidden-flow-video"]);
});

test("changing the first member changes the cover without moving the stack's gallery sort anchor (its newest member)", async (t) => {
  const store = await createFixtureStore(t);
  const sourcePath = (await store.getAsset("default", "a")).image_path;
  await store.createAsset({
    assetId: "between",
    imagePath: sourcePath,
    prompt: "between",
    created_at: "2026-08-29T12:01:30.000Z",
    source: { type: "local-file" },
  });
  const stack = await store.createAssetStack("default", ["a", "b", "c"], { coverAssetId: "b" });
  const before = await store.listAssetPage({ projectId: "default", collapseStacks: true, sort: "newest", limit: 0 });
  // The stack sorts by its newest member (c, 12:02), ahead of "between".
  assert.deepEqual(before.assets.map((asset) => asset.id), ["d", "b", "between"]);

  const reordered = await store.reorderAssetStack("default", stack.id, ["c", "b", "a"]);
  assert.equal(reordered.cover_asset_id, "c");
  const after = await store.listAssetPage({ projectId: "default", collapseStacks: true, sort: "newest", limit: 0 });
  assert.deepEqual(after.assets.map((asset) => asset.id), ["d", "c", "between"]);
});

test("a stack sorts by its newest live member: a fresh member lifts it, trashing that member drops it back", async (t) => {
  const store = await createFixtureStore(t);
  const sourcePath = (await store.getAsset("default", "a")).image_path;
  // An old cover with a newer member, as when old images are stacked with new ones.
  const stack = await store.createAssetStack("default", ["a", "b"], { coverAssetId: "a" });
  const newest = async () => (await store.listAssetPage({ projectId: "default", collapseStacks: true, sort: "newest", limit: 0 }))
    .assets.map((asset) => asset.id);
  assert.deepEqual(await newest(), ["d", "c", "a"]);

  await store.createAsset({
    assetId: "fresh",
    imagePath: sourcePath,
    prompt: "fresh",
    created_at: "2026-08-30T09:00:00.000Z",
    source: { type: "local-file" },
  });
  await store.addAssetsToStack("default", stack.id, ["fresh"]);
  assert.deepEqual(await newest(), ["a", "d", "c"]);

  await store.deleteAsset("default", "fresh");
  assert.deepEqual(await newest(), ["d", "c", "a"]);

  await store.restoreAsset("default", "fresh");
  assert.deepEqual(await newest(), ["a", "d", "c"]);
});

test("name ordering follows the visible Stack cover and its later metadata edits", async (t) => {
  const store = await createFixtureStore(t);
  await store.updateMetadata("default", "a", { theme: "Omega" });
  await store.updateMetadata("default", "b", { theme: "Zulu" });
  await store.updateMetadata("default", "c", { theme: "Alpha" });
  await store.updateMetadata("default", "d", { theme: "Middle" });
  const stack = await store.createAssetStack("default", ["a", "b", "c"], { coverAssetId: "b" });

  const before = await store.listAssetPage({ projectId: "default", collapseStacks: true, sort: "name", limit: 0 });
  assert.deepEqual(before.assets.map((asset) => asset.id), ["d", "b"]);

  await store.reorderAssetStack("default", stack.id, ["c", "b", "a"]);
  const afterReorder = await store.listAssetPage({ projectId: "default", collapseStacks: true, sort: "name", limit: 0 });
  assert.deepEqual(afterReorder.assets.map((asset) => asset.id), ["c", "d"]);

  await store.updateMetadata("default", "c", { theme: "Zzz Cover" });
  const afterRename = await store.listAssetPage({ projectId: "default", collapseStacks: true, sort: "name", limit: 0 });
  assert.deepEqual(afterRename.assets.map((asset) => asset.id), ["d", "c"]);
});

test("renaming a stack persists a display name and retargets name sorting", async (t) => {
  const store = await createFixtureStore(t);
  await store.updateMetadata("default", "d", { theme: "Paris" });
  const stack = await store.createAssetStack("default", ["a", "b", "c"], { coverAssetId: "b" });

  const named = await store.renameAssetStack("default", stack.id, "  Neon set  ");
  assert.equal(named.name, "Neon set", "display name is trimmed but not case-mangled");

  const reread = await store.getAssetStack("default", stack.id);
  assert.equal(reread.name, "Neon set", "rename persists across store re-reads");

  const page = await store.listAssetPage({ projectId: "default", collapseStacks: true, limit: 0, sort: "newest" });
  assert.equal(page.assets.find((asset) => asset.id === "b").stack.name, "Neon set",
    "collapsed gallery nodes carry the custom name");

  // "paris" sorts after "neon set" but before a cover-derived file name and
  // before any "stack-…" id key, so this order discriminates every wrong
  // sort-key source at once.
  const nameSorted = await store.listAssetPage({ projectId: "default", collapseStacks: true, limit: 0, sort: "name" });
  assert.deepEqual(nameSorted.assets.map((asset) => asset.id), ["b", "d"],
    "the node sorts by its custom display name");

  await store.updateMetadata("default", "b", { theme: "Zed" });
  const afterCoverEdit = await store.listAssetPage({ projectId: "default", collapseStacks: true, limit: 0, sort: "name" });
  assert.deepEqual(afterCoverEdit.assets.map((asset) => asset.id), ["b", "d"],
    "the key stays pinned to the custom name instead of following the renamed cover");

  await assert.rejects(
    store.renameAssetStack("default", stack.id, "   "),
    (error) => error.code === "STACK_NAME_EMPTY",
    "an empty final name is rejected instead of silently clearing",
  );
  await assert.rejects(
    store.renameAssetStack("default", "stack-missing", "whatever"),
    (error) => error.code === "STACK_NOT_FOUND",
  );
});

test("trashing every member hides the stack node and restoring members rebuilds it", async (t) => {
  const store = await createFixtureStore(t);
  const stack = await store.createAssetStack("default", ["a", "b", "c"], { coverAssetId: "b" });
  await store.reorderAssetStack("default", stack.id, ["c", "b", "a"]);

  await Promise.all(["a", "b", "c"].map((id) => store.deleteAsset("default", id)));
  const trashedGallery = await store.listAssetPage({ projectId: "default", collapseStacks: true, limit: 0, sort: "oldest" });
  assert.deepEqual(trashedGallery.assets.map((asset) => asset.id), ["d"],
    "the collapsed node disappears once no active member remains");
  assert.equal((await store.getAssetStack("default", stack.id)).count, 0);

  const trashScope = await store.listAssetPage({ projectId: "default", trash: true, limit: 0, sort: "oldest" });
  assert.deepEqual(trashScope.assets.map((asset) => asset.id), ["a", "b", "c"],
    "members surface individually in the Trash scope");

  for (const id of ["a", "b", "c"]) await store.restoreAsset("default", id);
  const restored = await store.listAssetPage({ projectId: "default", collapseStacks: true, limit: 0, sort: "oldest" });
  assert.deepEqual(restored.assets.map((asset) => asset.id), ["c", "d"],
    "restoring the members brings back one stack node (row id = current cover)");
  assert.deepEqual(restored.assets[0].stack, { id: stack.id, count: 3, name: "" });
  assert.deepEqual(
    (await store.listAssetStackAssets("default", stack.id)).assets.map((asset) => asset.id),
    ["c", "b", "a"],
    "membership survives Trash so the restored stack keeps its manual order",
  );
});

test("a single restored member stays a plain asset while its retained membership blocks restacking", async (t) => {
  const store = await createFixtureStore(t);
  const stack = await store.createAssetStack("default", ["a", "b"], { coverAssetId: "a" });
  await Promise.all(["a", "b"].map((id) => store.deleteAsset("default", id)));
  await store.restoreAsset("default", "a");

  const page = await store.listAssetPage({ projectId: "default", collapseStacks: true, limit: 0, sort: "oldest" });
  assert.equal(page.assets.find((asset) => asset.id === "a").stack, undefined,
    "one active member no longer renders as a stack node");
  await assert.rejects(
    store.createAssetStack("default", ["a", "d"], { coverAssetId: "a" }),
    (error) => error.code === "ASSET_ALREADY_STACKED",
    "the retained hidden membership still owns the asset (existing semantics)",
  );
});

test("permanently deleting every trashed member leaves no orphan stack rows or ghost node", async (t) => {
  const store = await createFixtureStore(t);
  const stack = await store.createAssetStack("default", ["a", "b"], { coverAssetId: "a" });

  await Promise.all(["a", "b"].map((id) => store.deleteAsset("default", id)));
  // Documented mid-state: the stack row survives with 0 active members so
  // Restore can rebuild the group; it merely stops rendering in the gallery.
  assert.equal((await store.getAssetStack("default", stack.id)).count, 0);

  for (const id of ["a", "b"]) await store.permanentlyDeleteAsset("default", id);

  await assert.rejects(
    store.getAssetStack("default", stack.id),
    (error) => error.code === "STACK_NOT_FOUND",
    "no orphan asset_stacks row survives its last member's permanent deletion",
  );
  const gallery = await store.listAssetPage({ projectId: "default", collapseStacks: true, limit: 0, sort: "oldest" });
  assert.deepEqual(gallery.assets.map((asset) => asset.id), ["c", "d"], "no ghost stack node remains");
  assert.equal(gallery.assets[0].stack, undefined);

  // Membership rows cascade with the deleted asset rows (foreign_keys = ON),
  // so the surviving assets can form a fresh stack without
  // ASSET_ALREADY_STACKED interference from the removed one.
  const restacked = await store.createAssetStack("default", ["c", "d"], { coverAssetId: "c" });
  assert.equal(restacked.count, 2);
  assert.equal(restacked.cover_asset_id, "c");
});
