// GravityPort paste-to-import (task 239) tests: the pure decision logic in
// paste-import.ts plus the blank-area menu wiring in context-menus.ts.
//
// The real modules are compiled with tsc into a temp directory and imported
// from there (gravityport-context-menus.test.mjs pattern) — nothing is
// hand-copied into this file. paste-import.ts references the DOM File type,
// so the compile needs the dom lib.
import { execFileSync } from "node:child_process";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");

let buildContextMenu;
let pasteImportDecision;
let importVisibleInActiveView;
let pasteDisplayName;
let renameSynthesizedPasteFiles;
let formatPasteTimestamp;
let SYNTHESIZED_PASTE_NAME;

before(async () => {
  const compileRoot = await mkdtemp(join(tmpdir(), "mosa-gp-paste-"));
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    join(uiRoot, "src", "paste-import.ts"),
    join(uiRoot, "src", "context-menus.ts"),
    "--outDir", compileRoot,
    "--module", "esnext",
    "--target", "es2022",
    "--moduleResolution", "bundler",
    "--lib", "es2022,dom",
    "--skipLibCheck",
  ], { stdio: "pipe" });
  ({
    pasteImportDecision, importVisibleInActiveView, pasteDisplayName, renameSynthesizedPasteFiles,
    formatPasteTimestamp, SYNTHESIZED_PASTE_NAME,
  } = await import(join(compileRoot, "paste-import.js")));
  ({ buildContextMenu } = await import(join(compileRoot, "context-menus.js")));
  after(async () => {
    await rm(compileRoot, { recursive: true, force: true });
  });
});

// 固定注入的时钟：不依赖当前时间。
const FIXED_NOW = new Date(2026, 9, 24, 5, 34, 47);
const FIXED_STAMP = "2026-10-24 05.34.47";

const decision = (overrides = {}) => pasteImportDecision({
  targetIsEditable: false,
  settingsOpen: false,
  pinterestActive: false,
  hasOverlay: false,
  cutActive: false,
  trashView: false,
  hasFiles: true,
  ...overrides,
});

const visible = (overrides = {}) => importVisibleInActiveView({
  active: "所有素材",
  query: "",
  assetType: "all",
  stackId: "",
  ...overrides,
});

const baseCtx = (overrides = {}) => ({
  target: "gallery-blank",
  scope: "all",
  selectionCount: 0,
  selectionHasStacks: false,
  anyGrouped: false,
  favorite: false,
  insideStackId: null,
  cutActive: false,
  groups: [],
  pageTotal: 5,
  isMac: true,
  trashCount: 0,
  canCopyFiles: true,
  clipboardImportable: false,
  ...overrides,
});

const menuIds = (entries) => entries.filter((entry) => entry.kind === "item").map((entry) => entry.id);

// ---------------------------------------------------------------------------
// 接不接这次粘贴
// ---------------------------------------------------------------------------
describe("paste-import / decision", () => {
  it("focus in a text field: ignore", () => {
    assert.equal(decision({ targetIsEditable: true }), "ignore");
  });

  it("settings, Pinterest and overlays: ignore", () => {
    assert.equal(decision({ settingsOpen: true }), "ignore");
    assert.equal(decision({ pinterestActive: true }), "ignore");
    assert.equal(decision({ hasOverlay: true }), "ignore");
  });

  it("trash view with files: trash-blocked", () => {
    assert.equal(decision({ trashView: true }), "trash-blocked");
  });

  it("no files: ignore (even in the trash — no spurious toast for text pastes)", () => {
    assert.equal(decision({ hasFiles: false }), "ignore");
    assert.equal(decision({ hasFiles: false, trashView: true }), "ignore");
  });

  it("a pending cut reserves the paste for pasteCut", () => {
    assert.equal(decision({ cutActive: true }), "ignore");
  });

  it("大图页开着 (no viewer flag exists) and every library view: import", () => {
    // The disposition has no viewer input on purpose: the viewer never
    // blocks an import.
    assert.equal(decision(), "import");
    assert.equal(decision({ trashView: false }), "import");
  });

  it("所有素材 / 待整理 / group: a:b / inside a stack: import", () => {
    assert.equal(visible({ active: "所有素材" }), true);
    assert.equal(visible({ active: "待整理" }), true);
    assert.equal(visible({ active: "group:a:b" }), true);
    assert.equal(visible({ active: "所有素材", stackId: "stack-1" }), true);
  });
});

// ---------------------------------------------------------------------------
// 导入后当前画面看得到吗
// ---------------------------------------------------------------------------
describe("paste-import / visibility", () => {
  it("收藏 and 智能分组 source: views cannot show fresh imports", () => {
    assert.equal(visible({ active: "收藏" }), false);
    assert.equal(visible({ active: "source:codex" }), false);
  });

  it("a search term or the 视频 filter hides them", () => {
    assert.equal(visible({ query: "风景" }), false);
    assert.equal(visible({ assetType: "video" }), false);
    assert.equal(visible({ assetType: "image" }), false);
  });

  it("an open stack always shows them, refinements still win there", () => {
    assert.equal(visible({ stackId: "stack-1" }), true);
    assert.equal(visible({ stackId: "stack-1", query: "风景" }), false);
  });

  it("所有素材 without refinements, group:风景 and 待整理 show them", () => {
    assert.equal(visible({ active: "所有素材" }), true);
    assert.equal(visible({ active: "group:风景" }), true);
    assert.equal(visible({ active: "待整理" }), true);
  });
});

// ---------------------------------------------------------------------------
// 图片数据的文件名
// ---------------------------------------------------------------------------
describe("paste-import / synthesized file names", () => {
  it("image.png becomes 粘贴的图片 <固定时间>.png", () => {
    const file = { name: "image.png", type: "image/png" };
    assert.equal(pasteDisplayName(file, 0, "zh", FIXED_NOW), `粘贴的图片 ${FIXED_STAMP}.png`);
  });

  it("the second renamed file of one paste carries the  2 suffix", () => {
    const file = { name: "image.png", type: "image/png" };
    assert.equal(pasteDisplayName(file, 1, "zh", FIXED_NOW), `粘贴的图片 ${FIXED_STAMP} 2.png`);
  });

  it("the extension follows the MIME type (image/jpeg → .jpg)", () => {
    assert.equal(pasteDisplayName({ name: "image.png", type: "image/jpeg" }, 0, "zh", FIXED_NOW), `粘贴的图片 ${FIXED_STAMP}.jpg`);
  });

  it("the English interface names them Pasted image", () => {
    assert.equal(pasteDisplayName({ name: "image.png", type: "image/png" }, 0, "en", FIXED_NOW), `Pasted image ${FIXED_STAMP}.png`);
    assert.equal(pasteDisplayName({ name: "image.png", type: "image/png" }, 2, "en", FIXED_NOW), `Pasted image ${FIXED_STAMP} 3.png`);
  });

  it("a file with a real name (风景.mp4) keeps its original name", () => {
    assert.equal(pasteDisplayName({ name: "风景.mp4", type: "video/mp4" }, 0, "zh", FIXED_NOW), "风景.mp4");
    assert.equal(SYNTHESIZED_PASTE_NAME, "image.png");
  });

  it("formatPasteTimestamp is local, padded and dot-separated", () => {
    assert.equal(formatPasteTimestamp(new Date(2026, 0, 2, 3, 4, 5)), "2026-01-02 03.04.05");
    assert.equal(formatPasteTimestamp(new Date(2026, 10, 25, 13, 45, 59)), "2026-11-25 13.45.59");
  });

  it("renameSynthesizedPasteFiles renames in place order and keeps bytes", async () => {
    const first = new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });
    const named = new File([new Uint8Array([4])], "风景.mp4", { type: "video/mp4" });
    const second = new File([new Uint8Array([5, 6])], "image.png", { type: "image/png" });
    const [outFirst, outNamed, outSecond] = renameSynthesizedPasteFiles([first, named, second], "zh", FIXED_NOW);
    assert.equal(outFirst.name, `粘贴的图片 ${FIXED_STAMP}.png`);
    assert.equal(outFirst.type, "image/png");
    assert.equal(outFirst.lastModified, first.lastModified);
    assert.deepEqual([...new Uint8Array(await outFirst.arrayBuffer())], [1, 2, 3]);
    assert.equal(outNamed.name, "风景.mp4");
    assert.equal(outSecond.name, `粘贴的图片 ${FIXED_STAMP} 2.png`);
  });
});

// ---------------------------------------------------------------------------
// 空白处右键菜单的「粘贴」
// ---------------------------------------------------------------------------
describe("paste-import / blank-area menu", () => {
  it("cutActive: 粘贴 is the cut-moving paste", () => {
    const gallery = menuIds(buildContextMenu(baseCtx({ cutActive: true })));
    assert.ok(gallery.includes("paste"));
    assert.ok(!gallery.includes("paste-import"));
    const stackBlank = menuIds(buildContextMenu(baseCtx({ target: "stack-blank", insideStackId: "s", cutActive: true })));
    assert.ok(stackBlank.includes("paste"));
    assert.ok(!stackBlank.includes("paste-import"));
  });

  it("cutActive false + clipboardImportable true: paste-import is offered in both blank menus", () => {
    const gallery = menuIds(buildContextMenu(baseCtx({ clipboardImportable: true })));
    assert.ok(gallery.includes("paste-import"));
    assert.ok(!gallery.includes("paste"));
    const stackBlank = menuIds(buildContextMenu(baseCtx({ target: "stack-blank", insideStackId: "s", clipboardImportable: true })));
    assert.ok(stackBlank.includes("paste-import"));
    assert.ok(!stackBlank.includes("paste"));
  });

  it("both false: no paste entry at all", () => {
    assert.ok(!menuIds(buildContextMenu(baseCtx())).includes("paste"));
    assert.ok(!menuIds(buildContextMenu(baseCtx())).includes("paste-import"));
  });

  it("the trash blank menu never offers paste-import", () => {
    const trash = buildContextMenu(baseCtx({ scope: "trash", trashCount: 2, clipboardImportable: true }));
    const ids = menuIds(trash);
    assert.ok(!ids.includes("paste"));
    assert.ok(!ids.includes("paste-import"));
  });

  it("cutActive wins over clipboardImportable and the label stays 粘贴", () => {
    const entries = buildContextMenu(baseCtx({ cutActive: true, clipboardImportable: true }));
    const paste = entries.filter((entry) => entry.kind === "item" && entry.label === "粘贴");
    assert.equal(paste.length, 1);
    assert.equal(paste[0].id, "paste");
  });
});
