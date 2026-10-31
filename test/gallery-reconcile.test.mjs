// gallery-reconcile.test.mjs — unit tests for the pure reconcile logic
// (review 2-6 B): code-point ordering (against the real server's ORDER BY for
// tricky names), list merge, viewer stepping and focus fallback.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");

let reconcile;
let api;
let tempRoot;

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "mosa-gallery-reconcile-"));
  const outDir = join(tempRoot, "out");
  await mkdir(outDir, { recursive: true });
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    join(uiRoot, "src", "gallery-reconcile.ts"),
    join(uiRoot, "src", "mosa-api.ts"),
    "--outDir", outDir,
    "--rootDir", join(uiRoot, "src"),
    "--module", "commonjs",
    "--moduleResolution", "node",
    "--target", "es2022",
    "--esModuleInterop",
    "--skipLibCheck",
  ], { stdio: "pipe" });
  reconcile = await import(join(outDir, "gallery-reconcile.js"));
  api = await import(join(outDir, "mosa-api.js"));
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const card = (id, { createdAt = id, sortName = id, searchScore = null, stack = null, stackPosition } = {}) => ({
  id,
  created_at: createdAt,
  name: id,
  child_asset_ids: [],
  favorite: false,
  ...(stack ? { stack } : {}),
  ...(stackPosition != null ? { stack_position: stackPosition } : {}),
  node_sort: { createdAt, sortName, searchScore },
});

describe("compareCodePointStrings", () => {
  it("orders astral characters like SQLite's UTF-8 byte order, not UTF-16", () => {
    // U+E000 (private use) must sort BEFORE U+10000 (astral): JS `<` on
    // surrogates gets this wrong.
    assert.ok(reconcile.compareCodePointStrings("\uE000", "\u{10000}") < 0);
    assert.ok("\uE000" < "\u{10000}" === false); // the JS pitfall itself
    assert.ok(reconcile.compareCodePointStrings("😀", "😆") < 0);
    assert.equal(reconcile.compareCodePointStrings("a", "a"), 0);
    assert.ok(reconcile.compareCodePointStrings("ab", "b") < 0);
  });
});

describe("compareGalleryNodes", () => {
  it("matches the real server's name order on Chinese, emoji and case", async () => {
    const { createSqliteAssetStore } = await import(join(repositoryRoot, "lib", "sqlite-asset-store.mjs"));
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const root = mkdtempSync(join(tmpdir(), "mosa-reconcile-server-"));
    const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir: root });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const names = ["zebra", "Apple", "中村", "中华", "😀 emoji", "\uE000 private", "apple", "画像", "zzz"];
    const byName = {};
    for (const name of names) {
      const file = join(root, `img-${Math.random().toString(36).slice(2)}.png`);
      writeFileSync(file, png);
      const asset = await store.createAsset({ projectId: "default", imagePath: file, theme: name });
      byName[asset.id] = name;
    }
    const serverRows = (await store.listAssetPage({ projectId: "default", sort: "name", limit: 0 })).assets
      .map(asset => ({ id: asset.id, name: byName[asset.id] }));
    const serverOrder = serverRows.map(row => row.name);
    // The server's node_sort carries the same key its ORDER BY uses:
    // assets.sort_name = assetSortName = lowercased theme (mosa_sort_name).
    // Equal keys break ties by id, so the client sort uses the rows' real ids.
    const clientOrder = [...serverRows].sort((a, b) => reconcile.compareGalleryNodes(
      card(a.id, { sortName: a.name.toLocaleLowerCase() }),
      card(b.id, { sortName: b.name.toLocaleLowerCase() }),
      { sort: "name", stackView: false },
    )).map(row => row.name);
    store.close();
    assert.deepEqual(clientOrder, serverOrder);
  });

  it("sorts newest/oldest by createdAt then id, and manual stacks by position", () => {
    const a = card("a", { createdAt: "2026-01-01T00:00:01Z" });
    const b = card("b", { createdAt: "2026-01-01T00:00:01Z" });
    const c = card("c", { createdAt: "2026-01-01T00:00:02Z" });
    const newest = [a, b, c].sort((x, y) => reconcile.compareGalleryNodes(x, y, { sort: "newest", stackView: false }));
    assert.deepEqual(newest.map(item => item.id), ["c", "b", "a"]);
    const oldest = [a, b, c].sort((x, y) => reconcile.compareGalleryNodes(x, y, { sort: "oldest", stackView: false }));
    assert.deepEqual(oldest.map(item => item.id), ["a", "b", "c"]);
    const s1 = card("s1", { stackPosition: 1 });
    const s0 = card("s0", { stackPosition: 0 });
    const manual = [s1, s0].sort((x, y) => reconcile.compareGalleryNodes(x, y, { sort: "manual", stackView: true }));
    assert.deepEqual(manual.map(item => item.id), ["s0", "s1"]);
  });

  it("ranks search scores before the secondary key, like the server's ORDER BY", () => {
    const high = card("low-key", { createdAt: "2026-01-01T00:00:01Z", searchScore: 10 });
    const low = card("high-key", { createdAt: "2026-01-01T00:00:09Z", searchScore: 1 });
    const ranked = [low, high].sort((x, y) => reconcile.compareGalleryNodes(x, y, { sort: "newest", stackView: false }));
    assert.deepEqual(ranked.map(item => item.id), ["low-key", "high-key"]);
  });
});

describe("reconcileGalleryList", () => {
  const response = (rows, extra = {}) => ({
    rows, rowByAssetId: Object.fromEntries(rows.map(row => [row.id, row.id])),
    afterCursorRowIds: [], total: null, stack: null, ...extra,
  });

  it("inserts new cards at their comparator position without touching the rest", () => {
    const list = [card("a", { createdAt: "T3" }), card("b", { createdAt: "T2" })];
    const fresh = card("c", { createdAt: "T2.5" });
    const result = reconcile.reconcileGalleryList(list, response([fresh]), {
      requestedIds: ["c"], affectedStackIds: [], sort: "newest", stackView: false,
    });
    assert.deepEqual(result.cards.map(item => item.id), ["a", "c", "b"]);
    assert.deepEqual(result.removedIds, []);
  });

  it("removes requested ids and never leaves a duplicate", () => {
    const list = [card("a", { createdAt: "T3" }), card("b", { createdAt: "T2" }), card("c", { createdAt: "T1" })];
    const updatedB = card("b", { createdAt: "T2", sortName: "b2" });
    const result = reconcile.reconcileGalleryList(list, response([updatedB]), {
      requestedIds: ["b"], affectedStackIds: [], sort: "newest", stackView: false,
    });
    assert.deepEqual(result.cards.map(item => item.id), ["a", "b", "c"]);
    // b was replaced by its fresh row: no card net-left the window.
    assert.deepEqual(result.removedIds, []);
    assert.equal(result.cards.filter(item => item.id === "b").length, 1);
    assert.equal(result.cards[1].node_sort.sortName, "b2");
  });

  it("drops rows after the loaded window's boundary cursor", () => {
    const list = [card("a", { createdAt: "T3" }), card("b", { createdAt: "T2" })];
    const beyond = card("z", { createdAt: "T0" });
    const result = reconcile.reconcileGalleryList(list, response([beyond], { afterCursorRowIds: ["z"] }), {
      requestedIds: ["z"], affectedStackIds: [], sort: "newest", stackView: false,
    });
    assert.deepEqual(result.cards.map(item => item.id), ["a", "b"]);
    // z was never in the window; nothing to remove.
    assert.deepEqual(result.removedIds, []);
  });

  it("removes cards whose requested id has no row anymore", () => {
    const list = [card("a", { createdAt: "T3" }), card("b", { createdAt: "T2" })];
    const result = reconcile.reconcileGalleryList(list, response([]), {
      requestedIds: ["b"], affectedStackIds: [], sort: "newest", stackView: false,
    });
    assert.deepEqual(result.cards.map(item => item.id), ["a"]);
    assert.deepEqual(result.removedIds, ["b"]);
  });

  it("replaces a stack's old cover card and reports the follow mapping", () => {
    const oldCover = card("cover1", { createdAt: "T3", stack: { id: "st1", count: 2, name: "S" } });
    const plain = card("p", { createdAt: "T2" });
    const newCover = card("cover2", { createdAt: "T3", stack: { id: "st1", count: 2, name: "S" } });
    const result = reconcile.reconcileGalleryList([oldCover, plain], response([newCover]), {
      requestedIds: ["cover1"], affectedStackIds: [], sort: "newest", stackView: false,
    });
    assert.deepEqual(result.cards.map(item => item.id), ["cover2", "p"]);
    assert.deepEqual(result.replacedStackCards, { cover1: "cover2" });
  });

  it("drops cards of stacks that appear in the response but were not requested", () => {
    const staleCover = card("cover1", { createdAt: "T3", stack: { id: "st1", count: 2, name: "S" } });
    const newCover = card("cover2", { createdAt: "T3", stack: { id: "st1", count: 2, name: "S" } });
    const result = reconcile.reconcileGalleryList([staleCover], response([newCover]), {
      requestedIds: ["member9"], // the member was requested, not the cover
      affectedStackIds: [], sort: "newest", stackView: false,
    });
    assert.deepEqual(result.cards.map(item => item.id), ["cover2"]);
    assert.deepEqual(result.replacedStackCards, { cover1: "cover2" });
  });

  it("keeps a pinned card without a fresh row in place, merges one with a row", () => {
    const pinned = card("p", { createdAt: "T2" });
    const other = card("a", { createdAt: "T3" });
    const tail = card("z", { createdAt: "T1" });
    // Rowless: stays exactly where it is.
    const kept = reconcile.reconcileGalleryList([other, pinned, tail], response([]), {
      requestedIds: ["p"], affectedStackIds: [], sort: "newest", stackView: false, pinnedIds: ["p"],
    });
    assert.deepEqual(kept.cards.map(item => item.id), ["a", "p", "z"]);
    assert.deepEqual(kept.removedIds, []);
    // With a fresh row it merges through the normal path (data refreshed).
    const fresh = card("p", { createdAt: "T2", sortName: "p-new" });
    const merged = reconcile.reconcileGalleryList([other, pinned], response([fresh]), {
      requestedIds: ["p"], affectedStackIds: [], sort: "newest", stackView: false, pinnedIds: ["p"],
    });
    assert.deepEqual(merged.cards.map(item => item.id), ["a", "p"]);
    assert.equal(merged.cards[1].node_sort.sortName, "p-new");
  });

  it("preserves detail-only fields from the previous card via mergeGalleryRow", () => {
    const previous = { ...card("a", { createdAt: "T2" }), child_asset_ids: ["child1"] };
    const row = card("a", { createdAt: "T2" });
    const result = reconcile.reconcileGalleryList([previous], response([row]), {
      requestedIds: ["a"], affectedStackIds: [], sort: "newest", stackView: false,
    });
    assert.deepEqual(result.cards[0].child_asset_ids, ["child1"]);
    assert.equal(api.mergeGalleryRow(undefined, row), row); // no previous → row wins
  });

  it("lets the row's stack annotation win: a moved-out cover loses its badge", () => {
    // The oracle scenario: a row without an annotation means the asset is no
    // longer a stack node in this view — keeping the old badge would turn the
    // card into a ghost that the next stack merge wrongly removes.
    const nodePrevious = { ...card("cover", { createdAt: "T2" }), stack: { id: "st9", count: 3, name: "X" } };
    const looseRow = card("cover", { createdAt: "T2" });
    const movedOut = reconcile.reconcileGalleryList([nodePrevious], response([looseRow]), {
      requestedIds: ["cover"], affectedStackIds: [], sort: "newest", stackView: false,
    });
    assert.equal(movedOut.cards[0].stack, undefined);
    // A fresh node row over a plain card keeps (carries) its own annotation.
    const plainPrevious = { ...card("cover", { createdAt: "T2" }) };
    const nodeRow = card("cover", { createdAt: "T2", stack: { id: "st1", count: 2, name: "S" } });
    const becameNode = reconcile.reconcileGalleryList([plainPrevious], response([nodeRow]), {
      requestedIds: ["cover"], affectedStackIds: [], sort: "newest", stackView: false,
    });
    assert.deepEqual(becameNode.cards[0].stack, { id: "st1", count: 2, name: "S" });
  });
});

describe("viewerAfterReconcile", () => {
  it("stays when the viewed card is still listed or already pinned", () => {
    assert.deepEqual(reconcile.viewerAfterReconcile({
      previousIds: ["a", "b"], nextIds: ["a", "b"], viewedId: "b", goneIds: [], pinned: [],
    }), { action: "stay" });
    assert.deepEqual(reconcile.viewerAfterReconcile({
      previousIds: ["a", "b"], nextIds: ["a"], viewedId: "b", goneIds: [], pinned: ["b"],
    }), { action: "stay" });
  });

  it("moves to the position's current card when the viewed one left the library, closes on empty", () => {
    // Deleted from the middle: the next card slides into the slot.
    assert.deepEqual(reconcile.viewerAfterReconcile({
      previousIds: ["a", "b", "c"], nextIds: ["a", "c"], viewedId: "b", goneIds: ["b"], pinned: [],
    }), { action: "move", id: "c" });
    // Deleted last: the previous card.
    assert.deepEqual(reconcile.viewerAfterReconcile({
      previousIds: ["a", "b", "c"], nextIds: ["a", "b"], viewedId: "c", goneIds: ["c"], pinned: [],
    }), { action: "move", id: "b" });
    // Empty list closes the viewer.
    assert.deepEqual(reconcile.viewerAfterReconcile({
      previousIds: ["b"], nextIds: [], viewedId: "b", goneIds: ["b"], pinned: [],
    }), { action: "close" });
  });

  it("pins a card that only left the current view (never treats it as deleted)", () => {
    assert.deepEqual(reconcile.viewerAfterReconcile({
      previousIds: ["a", "b"], nextIds: ["a"], viewedId: "b", goneIds: [], pinned: [],
    }), { action: "stay", pin: true });
  });
});

describe("focusAfterRemoval", () => {
  it("falls to the slot's current card, then the previous, then empty", () => {
    assert.equal(reconcile.focusAfterRemoval(["a", "b", "c"], ["a", "c"], "b"), "c");
    assert.equal(reconcile.focusAfterRemoval(["a", "b", "c"], ["a", "b"], "c"), "b");
    assert.equal(reconcile.focusAfterRemoval(["b"], [], "b"), "");
    assert.equal(reconcile.focusAfterRemoval(["a", "b"], ["a", "b"], "b"), "b"); // untouched
  });
});
