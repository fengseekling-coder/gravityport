import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const srcRoot = join(repositoryRoot, "web", "gravityport", "src");

let marquee;
let galleryWindow;
let tempRoot;
before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "mosa-gp-marquee-"));
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    join(srcRoot, "marquee.ts"), join(srcRoot, "gallery-window.ts"), "--outDir", tempRoot, "--module", "esnext", "--target", "es2022",
    "--moduleResolution", "bundler", "--skipLibCheck",
  ], { stdio: "pipe" });
  marquee = await import(join(tempRoot, "marquee.js"));
  galleryWindow = await import(join(tempRoot, "gallery-window.js"));
});
after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("boxFromPoints / boxesIntersect", () => {
  it("normalizes a sweep in any direction", () => {
    assert.deepEqual(marquee.boxFromPoints(50, 80, 10, 20), { left: 10, top: 20, right: 50, bottom: 80 });
  });
  it("treats touching edges as no overlap", () => {
    const a = { left: 0, top: 0, right: 10, bottom: 10 };
    assert.equal(marquee.boxesIntersect(a, { left: 10, top: 0, right: 20, bottom: 10 }), false);
    assert.equal(marquee.boxesIntersect(a, { left: 9, top: 9, right: 20, bottom: 20 }), true);
  });
});

describe("marqueeAutoScrollStep", () => {
  it("is zero away from the edges", () => {
    assert.equal(marquee.marqueeAutoScrollStep(300, 0, 600), 0);
  });
  it("scrolls up near the top and down near the bottom, faster at the edge", () => {
    const nearTop = marquee.marqueeAutoScrollStep(40, 0, 600);
    const atTop = marquee.marqueeAutoScrollStep(0, 0, 600);
    assert.ok(nearTop < 0 && atTop < nearTop);
    assert.equal(atTop, -marquee.MARQUEE_AUTO_SCROLL_MAX_PX);
    assert.equal(marquee.marqueeAutoScrollStep(900, 0, 600), marquee.MARQUEE_AUTO_SCROLL_MAX_PX);
    assert.ok(marquee.marqueeAutoScrollStep(560, 0, 600) > 0);
  });
  it("ignores a degenerate grid", () => {
    assert.equal(marquee.marqueeAutoScrollStep(10, 100, 100), 0);
    assert.equal(marquee.marqueeAutoScrollStep(Number.NaN, 0, 600), 0);
  });
});

describe("marqueeAutoScrollDelta", () => {
  it("scrolls one tick's worth on time, and for the time that actually passed", () => {
    assert.equal(marquee.marqueeAutoScrollDelta(10, 16), 10);
    assert.equal(marquee.marqueeAutoScrollDelta(10, 32), 20);
    assert.equal(marquee.marqueeAutoScrollDelta(-10, 32), -20);
  });
  it("never moves less than one tick or more than four", () => {
    assert.equal(marquee.marqueeAutoScrollDelta(10, 0), 10);
    assert.equal(marquee.marqueeAutoScrollDelta(10, 1000), 40);
    assert.equal(marquee.marqueeAutoScrollDelta(10, Number.NaN), 10);
    assert.equal(marquee.marqueeAutoScrollDelta(0, 32), 0);
  });
});

describe("masonryCardBoxes", () => {
  it("matches the masonry placement formula, including the gap", () => {
    const model = galleryWindow.buildMasonryModel([1, 1, 1, 2], 3, 100, 8, { spanWide: true });
    const boxes = marquee.masonryCardBoxes(model, 100);
    assert.deepEqual(boxes[0], { left: 0, top: 0, right: 100, bottom: 100 });
    assert.deepEqual(boxes[1], { left: 108, top: 0, right: 208, bottom: 100 });
    assert.deepEqual(boxes[2], { left: 216, top: 0, right: 316, bottom: 100 });
    // The fourth card sits under the first row, one gap below it.
    assert.equal(boxes[3].top, 108);
    assert.equal(boxes[3].bottom - boxes[3].top, 200);
  });
});

describe("marqueeSelection", () => {
  it("is exactly the swept cards for a plain marquee", () => {
    assert.deepEqual(marquee.marqueeSelection({ base: [], startId: "", hits: ["b", "c"] }), ["b", "c"]);
  });
  it("keeps the starting selection and the start card for a Shift marquee", () => {
    assert.deepEqual(marquee.marqueeSelection({ base: ["a", "b"], startId: "c", hits: ["b", "d"] }), ["a", "b", "c", "d"]);
  });
});
