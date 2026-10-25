// video-poster-frame.test.mjs — unit tests for the renderer's poster frame
// picker (task 248): luma statistics, black-frame rejection with
// brightest-frame fallback, and the candidate seek-time schedule. The module
// ships as TypeScript inside web/gravityport; it is compiled to a temp tree
// with tsc (same approach as gravityport-release-notes-view.test.mjs) and
// only its pure functions are exercised here — DOM-dependent extraction is
// covered by the video-poster e2e flow.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");

let poster;

before(async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "mosa-gp-video-poster-"));
  const outDir = join(tempRoot, "out");
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    join(uiRoot, "src", "video-poster.ts"),
    "--outDir", outDir,
    "--module", "commonjs",
    "--moduleResolution", "node",
    "--target", "es2022",
    "--skipLibCheck",
  ], { stdio: "pipe" });
  poster = await import(join(outDir, "video-poster.js"));
  after(async () => rm(tempRoot, { recursive: true, force: true }));
});

// RGBA pixels for a uniform colour frame.
function solidFrame(r, g, b, pixels = 64) {
  const buffer = new Uint8ClampedArray(pixels * 4);
  for (let index = 0; index < pixels; index += 1) {
    buffer[index * 4] = r;
    buffer[index * 4 + 1] = g;
    buffer[index * 4 + 2] = b;
    buffer[index * 4 + 3] = 255;
  }
  return buffer;
}

// Half black / half bright colour so mean sits mid-range with high variance.
function halfBlackHalfColourFrame() {
  const buffer = new Uint8ClampedArray(64 * 4);
  for (let index = 0; index < 64; index += 1) {
    const bright = index >= 32;
    buffer[index * 4] = bright ? 220 : 0;
    buffer[index * 4 + 1] = bright ? 140 : 0;
    buffer[index * 4 + 2] = bright ? 40 : 0;
    buffer[index * 4 + 3] = 255;
  }
  return buffer;
}

describe("frameLumaStats", () => {
  it("scores a pure black frame as zero mean and zero variance", () => {
    const stats = poster.frameLumaStats(solidFrame(0, 0, 0));
    assert.equal(stats.mean, 0);
    assert.equal(stats.variance, 0);
  });

  it("scores a bright textured frame well above the poster thresholds", () => {
    const stats = poster.frameLumaStats(halfBlackHalfColourFrame());
    assert.ok(stats.mean > poster.POSTER_MIN_MEAN_LUMA, `mean ${stats.mean} should clear the dark threshold`);
    assert.ok(stats.variance > poster.POSTER_MIN_LUMA_VARIANCE, `variance ${stats.variance} should clear the flat threshold`);
  });

  it("scores a solid white frame as flat colour despite high brightness", () => {
    const stats = poster.frameLumaStats(solidFrame(255, 255, 255));
    assert.ok(stats.mean >= poster.POSTER_MIN_MEAN_LUMA);
    assert.ok(stats.variance < poster.POSTER_MIN_LUMA_VARIANCE, "solid white must stay below the flat threshold");
    assert.equal(poster.isUsablePosterStats(stats), false);
  });

  it("returns zeros for an empty buffer instead of dividing by zero", () => {
    assert.deepEqual(poster.frameLumaStats(new Uint8ClampedArray(0)), { mean: 0, variance: 0 });
  });
});

describe("selectPosterSample", () => {
  it("skips black intro frames and picks the first usable one", () => {
    const samples = [
      { time: 0.4, frame: "black", stats: poster.frameLumaStats(solidFrame(0, 0, 0)) },
      { time: 1, frame: "still-black", stats: poster.frameLumaStats(solidFrame(10, 8, 6)) },
      { time: 2, frame: "colour", stats: poster.frameLumaStats(halfBlackHalfColourFrame()) },
      { time: 2.5, frame: "also-colour", stats: poster.frameLumaStats(halfBlackHalfColourFrame()) },
    ];
    assert.equal(poster.selectPosterSample(samples), "colour");
  });

  it("falls back to the brightest frame when every candidate is black", () => {
    const samples = [
      { time: 0.5, frame: "black", stats: poster.frameLumaStats(solidFrame(0, 0, 0)) },
      { time: 1, frame: "dark-grey", stats: poster.frameLumaStats(solidFrame(18, 18, 18)) },
      { time: 2, frame: "slightly-less-dark", stats: poster.frameLumaStats(solidFrame(24, 24, 24)) },
    ];
    assert.equal(poster.selectPosterSample(samples), "slightly-less-dark");
  });

  it("rejects solid non-black frames too (flat colour, bright or not)", () => {
    const samples = [
      { time: 0.5, frame: "flat-grey", stats: poster.frameLumaStats(solidFrame(120, 120, 120)) },
      { time: 2, frame: "textured", stats: poster.frameLumaStats(halfBlackHalfColourFrame()) },
    ];
    assert.equal(poster.selectPosterSample(samples), "textured");
  });

  it("returns null only when nothing decoded at all", () => {
    assert.equal(poster.selectPosterSample([]), null);
  });
});

describe("posterSeekTimes", () => {
  it("schedules 1s plus 10/25/50% of a 4s clip in try order, deduplicated", () => {
    // Try order is the task contract (1 s first); 25% of 4s is exactly the
    // 1s probe, so it must not repeat.
    assert.deepEqual(poster.posterSeekTimes(4), [1, 0.4, 2]);
  });

  it("keeps every probe inside the playable range on short clips", () => {
    for (const time of poster.posterSeekTimes(0.3)) {
      assert.ok(time >= 0.05, `${time} below the 0.05s floor`);
      assert.ok(time <= 0.3 - 0.15, `${time} past the last usable moment`);
    }
    assert.ok(poster.posterSeekTimes(0.3).length >= 1);
  });

  it("falls back to a single mid-early probe when duration is unknown", () => {
    assert.deepEqual(poster.posterSeekTimes(null), [0.5]);
    assert.deepEqual(poster.posterSeekTimes(Number.NaN), [0.5]);
    assert.deepEqual(poster.posterSeekTimes(0), [0.5]);
  });
});
