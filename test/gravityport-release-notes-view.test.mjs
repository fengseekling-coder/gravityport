// gravityport-release-notes-view.test.mjs — unit tests for the About page's
// release-note blocks. The module ships as TypeScript inside web/gravityport
// and statically imports the repository-root release-notes.json, so it is
// compiled to a temp tree that mirrors the repository layout (tempRoot as the
// repo root) with a copy of release-notes.json at its top; the emitted
// `../../../release-notes.json` import then resolves inside the temp tree
// (same approach as gravityport-lifecycle.test.mjs, plus JSON support).
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");

let view;
let translate;
let tempRoot;
const identity = (text) => text;

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "mosa-gp-release-notes-"));
  // tsc keeps each source's path below the program's common root (the
  // repository root, because the bundled JSON is part of the program), so the
  // emitted files land at <outDir>/web/gravityport/src/. A copy of
  // release-notes.json at <outDir>/ makes the emitted `../../../` import
  // resolve exactly like it does in the real tree.
  const outDir = join(tempRoot, "out");
  await mkdir(outDir, { recursive: true });
  await copyFile(join(repositoryRoot, "release-notes.json"), join(outDir, "release-notes.json"));
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    join(uiRoot, "src", "release-notes-view.ts"),
    join(uiRoot, "src", "app-lifecycle.ts"),
    join(uiRoot, "src", "i18n.ts"),
    "--outDir", outDir,
    "--module", "commonjs",
    "--moduleResolution", "node",
    "--target", "es2022",
    "--esModuleInterop",
    "--resolveJsonModule",
    "--skipLibCheck",
  ], { stdio: "pipe" });
  view = await import(join(outDir, "web", "gravityport", "src", "release-notes-view.js"));
  ({ translate } = await import(join(outDir, "web", "gravityport", "src", "i18n.js")));
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const fixtureData = {
  schema: 1,
  unreleased: {
    zh: ["下一版会更快", "下一版更省电"],
    en: ["The next version is faster", "It also uses less power"],
  },
  releases: [
    { version: "1.1.0", date: "2026-10-16", zh: ["当前版本的说明"], en: ["Current version note"] },
    { version: "1.0.0", date: "2026-09-01", zh: ["旧版说明"], en: ["Old note"] },
  ],
};

const availableState = {
  phase: "available",
  latestVersion: "1.2.0",
  publishedAt: "2026-10-16T12:00:00Z",
  canInstallInApp: false,
  notes: {
    zh: "• 新版第一条\n- 新版第二条\n\n  * 新版第三条",
    en: "• English first\n- English second",
  },
};

// Expected display date for the full-ISO publishedAt above, computed with the
// same Intl options so the assertion holds in every CI timezone (a fixed
// string would shift a day in timezones behind UTC).
const expectedAvailableDate = (locale) => new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" })
  .format(new Date(availableState.publishedAt));

describe("buildReleaseNoteBlocks", () => {
  it("development: one block titled 下个版本（开发中） with the unreleased sentences", () => {
    const blocks = view.buildReleaseNoteBlocks({
      productVersion: "1.1.0",
      distribution: "development",
      language: "zh",
      t: identity,
      data: fixtureData,
    });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].title, "下个版本（开发中）");
    assert.deepEqual(blocks[0].lines, ["下一版会更快", "下一版更省电"]);
  });

  it("development with an empty unreleased: shows the nothing-recorded sentence", () => {
    const blocks = view.buildReleaseNoteBlocks({
      productVersion: "1.1.0",
      distribution: "development",
      language: "en",
      t: identity,
      data: { ...fixtureData, unreleased: { zh: [], en: [] } },
    });
    assert.deepEqual(blocks[0].lines, ["还没有记录"]);
  });

  it("released version recorded in release-notes.json: one block with the entry and its date", () => {
    const blocks = view.buildReleaseNoteBlocks({
      productVersion: "1.1.0",
      distribution: "preview",
      language: "zh",
      t: identity,
      data: fixtureData,
    });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].title, "当前版本 1.1.0 更新内容");
    assert.equal(blocks[0].date, "2026年10月16日");
    assert.deepEqual(blocks[0].lines, ["当前版本的说明"]);
  });

  it("released version missing from release-notes.json: shows the no-notes sentence", () => {
    const blocks = view.buildReleaseNoteBlocks({
      productVersion: "9.9.9",
      distribution: "production",
      language: "zh",
      t: identity,
      data: fixtureData,
    });
    assert.deepEqual(blocks[0].lines, ["这个版本没有更新说明"]);
    assert.equal(blocks[0].date, "");
  });

  it("update available: the new-version block comes first, the current-version block second", () => {
    const blocks = view.buildReleaseNoteBlocks({
      productVersion: "1.1.0",
      distribution: "preview",
      language: "zh",
      t: identity,
      updateState: availableState,
      data: fixtureData,
    });
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].title, "新版本 1.2.0 更新内容");
    assert.equal(blocks[0].date, expectedAvailableDate("zh-CN"));
    assert.deepEqual(blocks[0].lines, ["新版第一条", "新版第二条", "新版第三条"]);
    assert.equal(blocks[1].title, "当前版本 1.1.0 更新内容");
    // The release entry carries a date-only value, which must render as that
    // calendar day regardless of the viewer's timezone.
    assert.equal(blocks[1].date, "2026年10月16日");
  });

  it("downloading keeps the new-version block", () => {
    const blocks = view.buildReleaseNoteBlocks({
      productVersion: "1.1.0",
      distribution: "preview",
      language: "zh",
      t: identity,
      updateState: { ...availableState, phase: "downloading", percent: 40 },
      data: fixtureData,
    });
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].title, "新版本 1.2.0 更新内容");
  });

  it("manifest notes without newlines become one sentence", () => {
    const blocks = view.buildReleaseNoteBlocks({
      productVersion: "1.1.0",
      distribution: "preview",
      language: "zh",
      t: identity,
      updateState: { ...availableState, notes: { zh: "整段就是一句话", en: "" } },
      data: fixtureData,
    });
    assert.deepEqual(blocks[0].lines, ["整段就是一句话"]);
  });

  it("falls back to the other language when the current one has no notes", () => {
    const blocks = view.buildReleaseNoteBlocks({
      productVersion: "1.1.0",
      distribution: "preview",
      language: "zh",
      t: identity,
      updateState: { ...availableState, notes: { zh: "  ", en: "• English only" } },
      data: fixtureData,
    });
    assert.deepEqual(blocks[0].lines, ["English only"]);
  });

  it("no new-version block when the update carries no notes at all", () => {
    const blocks = view.buildReleaseNoteBlocks({
      productVersion: "1.1.0",
      distribution: "preview",
      language: "zh",
      t: identity,
      updateState: { ...availableState, notes: undefined },
      data: fixtureData,
    });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].title, "当前版本 1.1.0 更新内容");
  });

  it("idle update state never produces a new-version block", () => {
    const blocks = view.buildReleaseNoteBlocks({
      productVersion: "1.1.0",
      distribution: "preview",
      language: "zh",
      t: identity,
      updateState: { phase: "idle" },
      data: fixtureData,
    });
    assert.equal(blocks.length, 1);
  });

  it("English interface: English titles and the Oct 16, 2026 date format", () => {
    const blocks = view.buildReleaseNoteBlocks({
      productVersion: "1.1.0",
      distribution: "preview",
      language: "en",
      t: (text) => translate(text, "en"),
      updateState: availableState,
      data: fixtureData,
    });
    assert.equal(blocks[0].title, "What’s new in 1.2.0");
    assert.equal(blocks[0].date, expectedAvailableDate("en"));
    assert.deepEqual(blocks[0].lines, ["English first", "English second"]);
    assert.equal(blocks[1].title, "What’s new in 1.1.0");
    assert.equal(blocks[1].date, "Oct 16, 2026");
    assert.deepEqual(blocks[1].lines, ["Current version note"]);
  });

  it("English development title comes from i18n", () => {
    const blocks = view.buildReleaseNoteBlocks({
      productVersion: "1.1.0",
      distribution: "development",
      language: "en",
      t: (text) => translate(text, "en"),
      data: fixtureData,
    });
    assert.equal(blocks[0].title, "Next version (in development)");
    assert.deepEqual(blocks[0].lines, ["The next version is faster", "It also uses less power"]);
  });

  it("works against the real bundled release-notes.json", () => {
    const blocks = view.buildReleaseNoteBlocks({
      productVersion: "0.0.0-no-such-version",
      distribution: "production",
      language: "zh",
      t: identity,
    });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].title, "当前版本 0.0.0-no-such-version 更新内容");
    assert.deepEqual(blocks[0].lines, ["这个版本没有更新说明"]);
  });
});
