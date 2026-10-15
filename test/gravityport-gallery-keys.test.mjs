import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const srcRoot = join(repositoryRoot, "web", "gravityport", "src");

let galleryKeysModule;
let tempRoot;
before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "mosa-gp-gallery-keys-"));
  const entry = join(srcRoot, "gallery-keys.ts");
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    entry, "--outDir", tempRoot, "--module", "esnext", "--target", "es2022",
    "--moduleResolution", "bundler", "--skipLibCheck",
  ], { stdio: "pipe" });
  galleryKeysModule = await import(join(tempRoot, "gallery-keys.js"));
});
after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("resolveNavHistoryShortcut", () => {
  it("returns -1 for Cmd+[ on mac", () => {
    assert.equal(galleryKeysModule.resolveNavHistoryShortcut({ key: "[", metaKey: true }, "mac"), -1);
  });

  it("returns 1 for Cmd+] on mac", () => {
    assert.equal(galleryKeysModule.resolveNavHistoryShortcut({ key: "]", metaKey: true }, "mac"), 1);
  });

  it("returns -1 for Ctrl+[ on mac", () => {
    assert.equal(galleryKeysModule.resolveNavHistoryShortcut({ key: "[", ctrlKey: true }, "mac"), -1);
  });

  it("returns -1 for Alt+ArrowLeft on non-mac", () => {
    assert.equal(galleryKeysModule.resolveNavHistoryShortcut({ key: "ArrowLeft", altKey: true }, "other"), -1);
  });

  it("returns 1 for Alt+ArrowRight on non-mac", () => {
    assert.equal(galleryKeysModule.resolveNavHistoryShortcut({ key: "ArrowRight", altKey: true }, "other"), 1);
  });

  it("returns 0 when target is editable", () => {
    assert.equal(galleryKeysModule.resolveNavHistoryShortcut({ key: "[", metaKey: true, targetIsEditable: true }, "mac"), 0);
  });

  it("returns 0 for Alt+ArrowLeft with Ctrl on non-mac", () => {
    assert.equal(galleryKeysModule.resolveNavHistoryShortcut({ key: "ArrowLeft", altKey: true, ctrlKey: true }, "other"), 0);
  });

  it("returns 0 for Alt+ArrowLeft with Meta on non-mac", () => {
    assert.equal(galleryKeysModule.resolveNavHistoryShortcut({ key: "ArrowLeft", altKey: true, metaKey: true }, "other"), 0);
  });

  it("returns 0 for unrelated keys", () => {
    assert.equal(galleryKeysModule.resolveNavHistoryShortcut({ key: "a" }, "mac"), 0);
    assert.equal(galleryKeysModule.resolveNavHistoryShortcut({ key: "ArrowLeft" }, "other"), 0);
  });
});

describe("isFocusSearchKey", () => {
  it("returns true for / in library without overlay", () => {
    assert.equal(galleryKeysModule.isFocusSearchKey(
      { key: "/" },
      { viewIsLibrary: true, hasBlockingOverlay: false, targetIsTextEntry: false, platform: "mac" }
    ), true);
  });

  it("returns true for Cmd+F in library on mac", () => {
    assert.equal(galleryKeysModule.isFocusSearchKey(
      { key: "f", metaKey: true },
      { viewIsLibrary: true, hasBlockingOverlay: false, targetIsTextEntry: false, platform: "mac" }
    ), true);
  });

  it("returns true for Ctrl+F in library on non-mac", () => {
    assert.equal(galleryKeysModule.isFocusSearchKey(
      { key: "F", ctrlKey: true },
      { viewIsLibrary: true, hasBlockingOverlay: false, targetIsTextEntry: false, platform: "other" }
    ), true);
  });

  it("returns false when target is text entry", () => {
    assert.equal(galleryKeysModule.isFocusSearchKey(
      { key: "/" },
      { viewIsLibrary: true, hasBlockingOverlay: false, targetIsTextEntry: true, platform: "mac" }
    ), false);
  });

  it("returns false when overlay is blocking", () => {
    assert.equal(galleryKeysModule.isFocusSearchKey(
      { key: "/" },
      { viewIsLibrary: true, hasBlockingOverlay: true, targetIsTextEntry: false, platform: "mac" }
    ), false);
  });

  it("returns false when not in library view", () => {
    assert.equal(galleryKeysModule.isFocusSearchKey(
      { key: "/" },
      { viewIsLibrary: false, hasBlockingOverlay: false, targetIsTextEntry: false, platform: "mac" }
    ), false);
  });

  it("returns false for / with modifiers", () => {
    assert.equal(galleryKeysModule.isFocusSearchKey(
      { key: "/", metaKey: true },
      { viewIsLibrary: true, hasBlockingOverlay: false, targetIsTextEntry: false, platform: "mac" }
    ), false);
  
  it("Cmd+F reaches search from a text field; Ctrl+F on mac and Cmd+F elsewhere do not", () => {
    const ctx = { viewIsLibrary: true, hasBlockingOverlay: false, targetIsTextEntry: true };
    assert.equal(galleryKeysModule.isFocusSearchKey({ key: "f", metaKey: true }, { ...ctx, platform: "mac" }), true);
    assert.equal(galleryKeysModule.isFocusSearchKey({ key: "f", ctrlKey: true }, { ...ctx, platform: "mac" }), false);
    assert.equal(galleryKeysModule.isFocusSearchKey({ key: "f", metaKey: true }, { ...ctx, platform: "other" }), false);
  });
});
});

describe("neighbourAssetId", () => {
  // Three-column waterfall layout with staggered heights
  const cards = [
    // Column 1 (left: 0)
    { id: "a1", left: 0, top: 0, bottom: 100, centerX: 50, centerY: 50 },
    { id: "a2", left: 0, top: 110, bottom: 250, centerX: 50, centerY: 180 },
    { id: "a3", left: 0, top: 260, bottom: 340, centerX: 50, centerY: 300 },
    // Column 2 (left: 110)
    { id: "b1", left: 110, top: 0, bottom: 150, centerX: 160, centerY: 75 },
    { id: "b2", left: 110, top: 160, bottom: 220, centerX: 160, centerY: 190 },
    { id: "b3", left: 110, top: 230, bottom: 380, centerX: 160, centerY: 305 },
    // Column 3 (left: 220)
    { id: "c1", left: 220, top: 0, bottom: 80, centerX: 270, centerY: 40 },
    { id: "c2", left: 220, top: 90, bottom: 200, centerX: 270, centerY: 145 },
    { id: "c3", left: 220, top: 210, bottom: 290, centerX: 270, centerY: 250 },
  ];

  it("moves right within overlapping vertical range", () => {
    assert.equal(galleryKeysModule.neighbourAssetId(cards, "a1", "ArrowRight"), "b1");
  });

  it("moves left within overlapping vertical range", () => {
    assert.equal(galleryKeysModule.neighbourAssetId(cards, "b1", "ArrowLeft"), "a1");
  });

  it("moves right to nearest when no vertical overlap", () => {
    assert.equal(galleryKeysModule.neighbourAssetId(cards, "a3", "ArrowRight"), "b3");
  });

  it("moves down within same column", () => {
    assert.equal(galleryKeysModule.neighbourAssetId(cards, "a1", "ArrowDown"), "a2");
  });

  it("moves up within same column", () => {
    assert.equal(galleryKeysModule.neighbourAssetId(cards, "a2", "ArrowUp"), "a1");
  });

  it("returns null at right edge", () => {
    assert.equal(galleryKeysModule.neighbourAssetId(cards, "c1", "ArrowRight"), null);
  });

  it("returns null at left edge", () => {
    assert.equal(galleryKeysModule.neighbourAssetId(cards, "a1", "ArrowLeft"), null);
  });

  it("returns null at top edge", () => {
    assert.equal(galleryKeysModule.neighbourAssetId(cards, "a1", "ArrowUp"), null);
  });

  it("returns null at bottom edge", () => {
    assert.equal(galleryKeysModule.neighbourAssetId(cards, "a3", "ArrowDown"), null);
  });

  it("returns null when current id not found", () => {
    assert.equal(galleryKeysModule.neighbourAssetId(cards, "missing", "ArrowRight"), null);
  });
});

describe("galleryKeyAction", () => {
  it("returns enter-stack when asset is a stack", () => {
    assert.equal(galleryKeysModule.galleryKeyAction(
      { key: "Enter" },
      { viewIsLibrary: true, hasSelection: false, targetIsTextEntry: false, currentAsset: { stackId: "s1" } }
    ), "enter-stack");
  });

  it("returns open when asset is not a stack", () => {
    assert.equal(galleryKeysModule.galleryKeyAction(
      { key: "Enter" },
      { viewIsLibrary: true, hasSelection: false, targetIsTextEntry: false, currentAsset: {} }
    ), "open");
  });

  it("returns none when not Enter key", () => {
    assert.equal(galleryKeysModule.galleryKeyAction(
      { key: "a" },
      { viewIsLibrary: true, hasSelection: false, targetIsTextEntry: false, currentAsset: {} }
    ), "none");
  });

  it("returns none when not in library", () => {
    assert.equal(galleryKeysModule.galleryKeyAction(
      { key: "Enter" },
      { viewIsLibrary: false, hasSelection: false, targetIsTextEntry: false, currentAsset: {} }
    ), "none");
  });

  it("returns none when has selection", () => {
    assert.equal(galleryKeysModule.galleryKeyAction(
      { key: "Enter" },
      { viewIsLibrary: true, hasSelection: true, targetIsTextEntry: false, currentAsset: {} }
    ), "none");
  });

  it("returns none when target is text entry", () => {
    assert.equal(galleryKeysModule.galleryKeyAction(
      { key: "Enter" },
      { viewIsLibrary: true, hasSelection: false, targetIsTextEntry: true, currentAsset: {} }
    ), "none");
  });

  it("opens a stack cover instead of re-entering when already inside the stack", () => {
    assert.equal(galleryKeysModule.galleryKeyAction(
      { key: "Enter" },
      { viewIsLibrary: true, hasSelection: false, targetIsTextEntry: false, insideStack: true, currentAsset: { stackId: "st1" } }
    ), "open");
  });

  it("returns none when no current asset", () => {
    assert.equal(galleryKeysModule.galleryKeyAction(
      { key: "Enter" },
      { viewIsLibrary: true, hasSelection: false, targetIsTextEntry: false, currentAsset: null }
    ), "none");
  });
});
