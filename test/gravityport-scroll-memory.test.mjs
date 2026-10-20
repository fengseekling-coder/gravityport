// GravityPort gallery scroll memory (task 152): anchor picking at the viewport
// top edge, anchor-based position restore across rebuilt masonry models,
// minimal reveal scrolling for the focused card, and the capped LRU table.
// The modules ship as TypeScript inside web/gravityport, so they are compiled
// to a temporary ESM module with the project's own tsc before import (same
// approach as gravityport-masonry-span.test.mjs).
import { execFileSync } from "node:child_process";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");

let masonry, memory;
let tempRoot;
before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "mosa-gp-scroll-memory-"));
  const outDir = join(tempRoot, "out");
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    join(uiRoot, "src", "gallery-window.ts"), join(uiRoot, "src", "gallery-scroll-memory.ts"),
    "--outDir", outDir, "--module", "esnext", "--target", "es2022",
    "--moduleResolution", "bundler", "--skipLibCheck",
  ], { stdio: "pipe" });
  memory = await import(join(outDir, "gallery-scroll-memory.js"));
  masonry = await import(join(outDir, "gallery-window.js"));
});
after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

/** One-column model with 100px cards and 10px gaps: ratio r at index i sits at
 * top i·(100·? +10) — heights vary per ratio, so helpers build explicit
 * ratio lists. */
const build = (ratios, columns = 1, colWidth = 100, gap = 10) =>
  masonry.buildMasonryModel(ratios, columns, colWidth, gap, { spanWide: false });

describe("pickScrollAnchor", () => {
  const ratios = [1, 2, 0.5]; // tops 0 (h100), 110 (h200), 320 (h50)
  it("picks the card intersecting the viewport top edge (offset may be negative)", () => {
    const model = build(ratios);
    const anchor = memory.pickScrollAnchor(model, ["a", "b", "c"], 120);
    assert.deepEqual(anchor, { anchorId: "b", anchorOffset: -10 });
  });
  it("picks the closest card below the edge when none intersects", () => {
    const model = build(ratios);
    const anchor = memory.pickScrollAnchor(model, ["a", "b", "c"], 105);
    assert.deepEqual(anchor, { anchorId: "b", anchorOffset: 5 });
  });
  it("breaks equal tops by the smaller index", () => {
    const model = build([1, 1], 2); // both cards top 0
    const anchor = memory.pickScrollAnchor(model, ["a", "b"], 0);
    assert.deepEqual(anchor, { anchorId: "a", anchorOffset: 0 });
  });
  it("returns null for an empty model", () => {
    assert.equal(memory.pickScrollAnchor(build([]), [], 0), null);
  });
});

describe("resolveRestoredScrollTop", () => {
  const ratios = [1, 2, 0.5, 1, 1];
  it("lands the anchor card at the recorded offset in the same model", () => {
    const model = build(ratios);
    const ids = ["a", "b", "c", "d", "e"];
    const scrollTop = model.placements[2].top - 7;
    const record = { ...memory.buildScrollRecord(model, ids, scrollTop, 5, "c") };
    const restored = memory.resolveRestoredScrollTop(model, ids, record, 200);
    assert.equal(model.placements[2].top - restored, record.anchorOffset);
    assert.ok(Math.abs(restored - scrollTop) <= 1e-9);
  });
  it("lands the anchor card at the recorded offset after a rebuild with another column count", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const model = build(ratios);
    const record = memory.buildScrollRecord(model, ids, model.placements[2].top - 7, 5, "c");
    const rebuilt = build(ratios, 2, 80); // different geometry, same order
    const restored = memory.resolveRestoredScrollTop(rebuilt, ids, record, 150);
    assert.equal(rebuilt.placements[2].top - restored, record.anchorOffset);
  });
  it("falls back to the recorded scrollTop when the anchor card is gone", () => {
    const model = build(ratios);
    const record = { anchorId: "missing", anchorOffset: -10, scrollTop: 130, loaded: 5, selected: "" };
    assert.equal(memory.resolveRestoredScrollTop(model, ["a", "b", "c", "d", "e"], record, 300), 130);
  });
  it("clamps to the bottom of the content and never goes negative", () => {
    const model = build(ratios);
    const viewport = 100;
    const maxScroll = model.totalHeight - viewport;
    const deep = { anchorId: "missing", anchorOffset: 0, scrollTop: 100000, loaded: 5, selected: "" };
    assert.equal(memory.resolveRestoredScrollTop(model, ["a", "b", "c", "d", "e"], deep, viewport), maxScroll);
    const negative = { anchorId: "a", anchorOffset: 5, scrollTop: -50, loaded: 5, selected: "" };
    assert.equal(memory.resolveRestoredScrollTop(model, ["a", "b", "c", "d", "e"], negative, viewport), 0);
  });
  it("clamps to the scroller's real limit when given, not the model's shorter extent", () => {
    // The grid's trailing pagination sentinel adds one row gap below the
    // masonry extent: a position held at the very bottom must come back there.
    const model = build(ratios);
    const viewport = 100;
    const realMax = model.totalHeight - viewport + 8;
    const bottom = { anchorId: "missing", anchorOffset: 0, scrollTop: realMax, loaded: 5, selected: "" };
    assert.equal(memory.resolveRestoredScrollTop(model, ["a", "b", "c", "d", "e"], bottom, viewport, realMax), realMax);
    assert.equal(memory.resolveRestoredScrollTop(model, ["a", "b", "c", "d", "e"], bottom, viewport), realMax - 8);
  });
});

describe("revealCardScrollTop", () => {
  const viewport = 100;
  it("keeps a fully visible card exactly where it is", () => {
    const model = build([1, 2, 0.5, 1, 1, 1]); // tops 0, 110, 320, 380, 490, 600
    assert.equal(memory.revealCardScrollTop(model, 0, 0, viewport), 0);
    assert.equal(memory.revealCardScrollTop(model, 3, 380, viewport), 380); // 380..480 fills the 100px viewport exactly
  });
  it("scrolls down just far enough to reveal a card hanging below", () => {
    const model = build([1, 2, 0.5, 1, 1, 1]);
    assert.equal(memory.revealCardScrollTop(model, 4, 300, viewport), model.placements[4].top + model.placements[4].height + 8 - viewport);
  });
  it("scrolls up just far enough to reveal a card sitting above", () => {
    const model = build([1, 2, 0.5, 1, 1, 1]);
    assert.equal(memory.revealCardScrollTop(model, 1, 400, viewport), model.placements[1].top - 8);
  });
  it("aligns the top edge of a card taller than the viewport", () => {
    const model = build([1, 2, 0.5, 1, 1, 1]);
    assert.equal(memory.revealCardScrollTop(model, 1, 125, viewport), model.placements[1].top - 8);
  });
  it("clamps the target into the valid range", () => {
    const model = build([1, 2, 0.5, 1, 1, 1]);
    assert.equal(memory.revealCardScrollTop(model, 0, 30, viewport), 0);
  });
});

describe("GalleryScrollMemory", () => {
  const entry = (n) => ({ anchorId: `id-${n}`, anchorOffset: 0, scrollTop: n, loaded: 1, selected: "" });
  it("drops the least recently used entry past 30", () => {
    const table = new memory.GalleryScrollMemory(30);
    for (let n = 0; n < 30; n += 1) table.set(`k${n}`, entry(n));
    table.set("k30", entry(30));
    assert.equal(table.get("k0"), null);
    assert.ok(table.get("k1"));
  });
  it("keeps a read entry over untouched older ones", () => {
    const table = new memory.GalleryScrollMemory(30);
    for (let n = 0; n < 30; n += 1) table.set(`k${n}`, entry(n));
    assert.ok(table.get("k0")); // touch k0 -> k1 becomes the least recently used
    table.set("k30", entry(30));
    table.set("k31", entry(31));
    assert.ok(table.get("k0"));
    assert.equal(table.get("k1"), null);
  });
  it("replaces a view's record in place", () => {
    const table = new memory.GalleryScrollMemory(30);
    table.set("view", entry(1));
    table.set("view", entry(2));
    assert.equal(table.get("view").scrollTop, 2);
  });
});

describe("listChangedInPlace", () => {
  it("ignores an identical list and a page appended at the end", () => {
    assert.equal(memory.listChangedInPlace(["a", "b"], ["a", "b"]), false);
    assert.equal(memory.listChangedInPlace(["a", "b"], ["a", "b", "c", "d"]), false);
    assert.equal(memory.listChangedInPlace([], ["a"]), false);
  });
  it("reports removals, insertions and reorders", () => {
    assert.equal(memory.listChangedInPlace(["a", "b", "c"], ["a", "c"]), true);
    assert.equal(memory.listChangedInPlace(["a", "c"], ["a", "b", "c"]), true);
    assert.equal(memory.listChangedInPlace(["b", "c"], ["a", "b", "c"]), true);
    assert.equal(memory.listChangedInPlace(["a", "b"], ["b", "a"]), true);
  });
});
