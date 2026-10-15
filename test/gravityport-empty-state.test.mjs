// Empty state derivation tests.
import { execFileSync } from "node:child_process";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");

let es; // empty-state exports

before(async () => {
  const compileRoot = await mkdtemp(join(tmpdir(), "mosa-gp-es-"));
  const sources = [join(uiRoot, "src", "empty-state.ts")];
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    ...sources,
    "--outDir", compileRoot,
    "--module", "esnext",
    "--target", "es2022",
    "--moduleResolution", "bundler",
    "--skipLibCheck",
  ], { stdio: "pipe" });
  es = await import(join(compileRoot, "empty-state.js"));
  after(async () => { await rm(compileRoot, { recursive: true, force: true }); });
});

function makeCtx(overrides = {}) {
  return {
    loading: false,
    error: null,
    visibleCount: 0,
    active: "所有素材",
    query: "",
    assetType: "all",
    libraryTotal: 0,
    insideStack: false,
    ...overrides,
  };
}

describe("deriveEmptyState — rule 1: loading / error / visible results", () => {
  it("returns null when loading is true", () => {
    assert.equal(es.deriveEmptyState(makeCtx({ loading: true })), null);
  });

  it("returns null when error is set", () => {
    assert.equal(es.deriveEmptyState(makeCtx({ error: new Error("oops") })), null);
  });

  it("returns null when visibleCount > 0", () => {
    assert.equal(es.deriveEmptyState(makeCtx({ visibleCount: 5 })), null);
  });
});

describe("deriveEmptyState — rule 2: refinements", () => {
  it("search query → no-results with clearAction", () => {
    const result = es.deriveEmptyState(makeCtx({ query: "cat" }));
    assert.equal(result?.kind, "no-results");
    assert.equal(result?.clearAction, true);
  });

  it("assetType filter → no-results with clearAction", () => {
    const result = es.deriveEmptyState(makeCtx({ assetType: "images" }));
    assert.equal(result?.kind, "no-results");
    assert.equal(result?.clearAction, true);
  });

  it("both query and assetType → still no-results", () => {
    const result = es.deriveEmptyState(makeCtx({ query: "dog", assetType: "videos" }));
    assert.equal(result?.kind, "no-results");
  });
});

describe("deriveEmptyState — rule 3: trash", () => {
  it('active "回收站" → trash-empty', () => {
    const result = es.deriveEmptyState(makeCtx({ active: "回收站" }));
    assert.equal(result?.kind, "trash-empty");
    assert.equal(result?.clearAction, false);
  });

  it("回收站 with search → no-results (refinements take priority)", () => {
    const result = es.deriveEmptyState(makeCtx({ active: "回收站", query: "x" }));
    assert.equal(result?.kind, "no-results");
  });
});

describe("deriveEmptyState — rule 4: favorites", () => {
  it('active "收藏" → favorites-empty', () => {
    const result = es.deriveEmptyState(makeCtx({ active: "收藏" }));
    assert.equal(result?.kind, "favorites-empty");
    assert.equal(result?.clearAction, false);
  });
});

describe("deriveEmptyState — rule 5: unorganized", () => {
  it('active "待整理" → unorganized-empty', () => {
    const result = es.deriveEmptyState(makeCtx({ active: "待整理" }));
    assert.equal(result?.kind, "unorganized-empty");
  });
});

describe("deriveEmptyState — rule 6: group", () => {
  it('active "group:Travel" → group-empty', () => {
    const result = es.deriveEmptyState(makeCtx({ active: "group:Travel" }));
    assert.equal(result?.kind, "group-empty");
    assert.equal(result?.clearAction, false);
  });

  it("group with no refinements → group-empty", () => {
    const result = es.deriveEmptyState(makeCtx({ active: "group:Landscapes", query: "" }));
    assert.equal(result?.kind, "group-empty");
  });
});

describe("deriveEmptyState — rule 7: library empty", () => {
  it('所有素材 + libraryTotal === 0 → library-empty', () => {
    const result = es.deriveEmptyState(makeCtx({ active: "所有素材", libraryTotal: 0 }));
    assert.equal(result?.kind, "library-empty");
  });

  it("所有素材 + insideStack → NOT library-empty (must be false)", () => {
    const result = es.deriveEmptyState(makeCtx({ active: "所有素材", libraryTotal: 0, insideStack: true }));
    assert.notEqual(result?.kind, "library-empty");
    assert.equal(result?.kind, "no-results"); // falls through to fallback
  });

  it("所有素材 + libraryTotal undefined → NOT library-empty", () => {
    const result = es.deriveEmptyState(makeCtx({ active: "所有素材", libraryTotal: undefined }));
    assert.notEqual(result?.kind, "library-empty");
  });

  it("所有素材 + libraryTotal NaN → NOT library-empty", () => {
    const result = es.deriveEmptyState(makeCtx({ active: "所有素材", libraryTotal: NaN }));
    assert.notEqual(result?.kind, "library-empty");
  });

  it("所有素材 + libraryTotal Infinity → NOT library-empty", () => {
    const result = es.deriveEmptyState(makeCtx({ active: "所有素材", libraryTotal: Infinity }));
    assert.notEqual(result?.kind, "library-empty");
  });
});

describe("deriveEmptyState — rule 8: fallback", () => {
  it("Pinterest view → no-results with clearAction false", () => {
    const result = es.deriveEmptyState(makeCtx({ active: "Pinterest" }));
    assert.equal(result?.kind, "no-results");
    assert.equal(result?.clearAction, false);
  });

  it("source view with no matches → no-results", () => {
    const result = es.deriveEmptyState(makeCtx({ active: "source:Twitter" }));
    assert.equal(result?.kind, "no-results");
  });

  it("insideStack with no other signal → no-results", () => {
    const result = es.deriveEmptyState(makeCtx({ active: "所有素材", insideStack: true }));
    assert.equal(result?.kind, "no-results");
  });
});

describe("deriveEmptyState — priority checks", () => {
  it("回收站 + search → no-results (refinements beat fixed views)", () => {
    const result = es.deriveEmptyState(makeCtx({ active: "回收站", query: "lost" }));
    assert.equal(result?.kind, "no-results");
    assert.equal(result?.clearAction, true);
  });

  it("收藏 + assetType filter → no-results", () => {
    const result = es.deriveEmptyState(makeCtx({ active: "收藏", assetType: "videos" }));
    assert.equal(result?.kind, "no-results");
  });

  it("所有素材 + insideStack → NOT library-empty", () => {
    const result = es.deriveEmptyState(makeCtx({ active: "所有素材", libraryTotal: 0, insideStack: true }));
    assert.notEqual(result?.kind, "library-empty");
  });
});

describe("deriveEmptyState — copy content", () => {
  it("no-results has correct title and description", () => {
    const result = es.deriveEmptyState(makeCtx({ query: "test" }));
    assert.equal(result?.title, "没有找到匹配的素材");
    assert.equal(result?.description, "试试别的搜索词，或清除筛选条件");
  });

  it("trash-empty has correct copy", () => {
    const result = es.deriveEmptyState(makeCtx({ active: "回收站" }));
    assert.equal(result?.title, "回收站是空的");
    assert.equal(result?.description, "移到回收站的素材会在这里保留 90 天");
  });

  it("library-empty has correct copy", () => {
    const result = es.deriveEmptyState(makeCtx({ active: "所有素材", libraryTotal: 0 }));
    assert.equal(result?.title, "素材库还是空的");
    assert.equal(result?.description, "把图片或文件夹拖进窗口，或直接粘贴剪贴板图片即可导入");
  });
});
