// Group stats description tests.
import { execFileSync } from "node:child_process";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");

let gs; // group-stats exports

before(async () => {
  const compileRoot = await mkdtemp(join(tmpdir(), "mosa-gp-gs-"));
  const sources = [join(uiRoot, "src", "group-stats.ts")];
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    ...sources,
    "--outDir", compileRoot,
    "--module", "esnext",
    "--target", "es2022",
    "--moduleResolution", "bundler",
    "--skipLibCheck",
  ], { stdio: "pipe" });
  gs = await import(join(compileRoot, "group-stats.js"));
  after(async () => { await rm(compileRoot, { recursive: true, force: true }); });
});

describe("describeGroupStats — normal data", () => {
  it("returns all six overview fields in fixed order", () => {
    const result = gs.describeGroupStats({
      total: 42,
      favorites: 7,
      images: 30,
      videos: 5,
      versionChildren: 3,
      trashed: 2,
    });
    assert.equal(result.overview.length, 6);
    assert.equal(result.overview[0].label, "素材总数");
    assert.equal(result.overview[0].value, 42);
    assert.equal(result.overview[1].label, "收藏");
    assert.equal(result.overview[1].value, 7);
  });

  it("returns two facets with correct titles", () => {
    const result = gs.describeGroupStats({});
    assert.equal(result.facets.length, 2);
    assert.equal(result.facets[0].title, "按分类");
    assert.equal(result.facets[1].title, "按来源");
  });
});

describe("describeGroupStats — field variations", () => {
  it("missing fields default to 0", () => {
    const result = gs.describeGroupStats({});
    for (const entry of result.overview) {
      assert.equal(entry.value, 0);
    }
  });

  it("negative numbers clamp to 0", () => {
    const result = gs.describeGroupStats({
      total: -5,
      favorites: -1,
      images: -100,
    });
    assert.equal(result.overview[0].value, 0);
    assert.equal(result.overview[1].value, 0);
    assert.equal(result.overview[2].value, 0);
  });

  it("string numbers are parsed", () => {
    const result = gs.describeGroupStats({ total: "25" });
    assert.equal(result.overview[0].value, 25);
  });
});

describe("describeGroupStats — invalid stats", () => {
  it("null → all zeros, empty facets", () => {
    const result = gs.describeGroupStats(null);
    for (const entry of result.overview) {
      assert.equal(entry.value, 0);
    }
    assert.equal(result.facets[0].entries.length, 0);
    assert.equal(result.facets[1].entries.length, 0);
  });

  it("array → all zeros, empty facets", () => {
    const result = gs.describeGroupStats([1, 2, 3]);
    for (const entry of result.overview) {
      assert.equal(entry.value, 0);
    }
  });

  it("string → all zeros, empty facets", () => {
    const result = gs.describeGroupStats("not an object");
    for (const entry of result.overview) {
      assert.equal(entry.value, 0);
    }
  });
});

describe("describeGroupStats — facets", () => {
  it("bad entries are filtered out", () => {
    const result = gs.describeGroupStats({
      categories: [
        ["Valid", 5],
        "not an array",
        null,
        ["Also Valid", 3],
        ["Missing Count"],
        123,
        ["", 1], // empty name filtered
        { name: "obj", count: 2 }, // not [string, number]
      ],
    });
    assert.equal(result.facets[0].entries.length, 2);
    assert.equal(result.facets[0].entries[0].name, "Valid");
    assert.equal(result.facets[0].entries[0].count, 5);
    assert.equal(result.facets[0].entries[1].name, "Also Valid");
    assert.equal(result.facets[0].entries[1].count, 3);
  });

  it("empty facets show emptyText", () => {
    const result = gs.describeGroupStats({});
    assert.equal(result.facets[0].emptyText, "未记录");
    assert.equal(result.facets[1].emptyText, "未记录");
    assert.equal(result.facets[0].entries.length, 0);
  });
});

describe("describeGroupStats — sorting", () => {
  it("sorts by count descending", () => {
    const result = gs.describeGroupStats({
      sources: [
        ["Low", 1],
        ["High", 100],
        ["Mid", 50],
      ],
    });
    assert.equal(result.facets[1].entries[0].name, "High");
    assert.equal(result.facets[1].entries[0].count, 100);
    assert.equal(result.facets[1].entries[1].name, "Mid");
    assert.equal(result.facets[1].entries[1].count, 50);
    assert.equal(result.facets[1].entries[2].name, "Low");
    assert.equal(result.facets[1].entries[2].count, 1);
  });

  it("equal counts sorted by name ascending", () => {
    const result = gs.describeGroupStats({
      categories: [
        ["Zebra", 10],
        ["Apple", 10],
        ["Mango", 10],
      ],
    });
    assert.equal(result.facets[0].entries[0].name, "Apple");
    assert.equal(result.facets[0].entries[1].name, "Mango");
    assert.equal(result.facets[0].entries[2].name, "Zebra");
  });
});

describe("describeGroupStats — entries must be [string, number]", () => {
  it("drops pairs whose name is not a string or whose count is not a number", () => {
    const result = gs.describeGroupStats({
      sources: [["chatgpt", 4], [5, 2], ["gemini", "x"], ["codex", Number.NaN], ["grok", 1]],
    });
    assert.deepEqual(result.facets[1].entries.map((entry) => entry.name), ["chatgpt", "grok"]);
  });
});
