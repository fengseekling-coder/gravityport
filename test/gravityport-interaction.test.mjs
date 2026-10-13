// GravityPort interaction-model contract tests: selection unity, keyboard
// edit-surface guarding, prompt draft binding and gallery window geometry.
// The modules ship as TypeScript inside web/gravityport, so they are bundled
// to a temporary ESM module with the project's own tsc before import (same
// approach as gravityport-ui.test.mjs).
import { execFileSync } from "node:child_process";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");

let modules;
let tempRoot;
before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "mosa-gp-interaction-"));
  const sources = ["selection.ts", "prompt-edit.ts", "keyboard.ts", "gallery-window.ts"]
    .map(name => join(uiRoot, "src", name));
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    ...sources, "--outDir", tempRoot, "--module", "esnext", "--target", "es2022",
    "--moduleResolution", "bundler", "--skipLibCheck",
  ], { stdio: "pipe" });
  modules = {
    selection: await import(join(tempRoot, "selection.js")),
    promptEdit: await import(join(tempRoot, "prompt-edit.js")),
    keyboard: await import(join(tempRoot, "keyboard.js")),
    galleryWindow: await import(join(tempRoot, "gallery-window.js")),
  };
});
after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("selection unity", () => {
  let logicalSelection, toggleModifierSelection, replaceSelection;
  before(() => { ({ logicalSelection, toggleModifierSelection, replaceSelection } = modules.selection); });

  it("falls back to the inspected asset when no multi-selection exists", () => {
    assert.deepEqual(logicalSelection([], "a"), ["a"]);
    assert.deepEqual(logicalSelection(["a", "b"], "a"), ["a", "b"]);
    assert.deepEqual(logicalSelection([], ""), []);
  });

  it("keeps ctrl/cmd selection and inspector focus in the same set", () => {
    // Plain-selected A, then ctrl-click B: the modifier click re-targets the
    // selection onto B and the inspector follows — the logical selection and
    // the highlighted cards can never drift apart.
    let state = toggleModifierSelection([], "a", "b");
    assert.deepEqual(state.selectedIds, ["b"]);
    assert.equal(state.selected, "b");
    assert.deepEqual(logicalSelection(state.selectedIds, state.selected), ["b"]);

    // Ctrl-clicking another card accumulates it.
    state = toggleModifierSelection(["b"], "b", "a");
    assert.deepEqual(state.selectedIds, ["b", "a"]);
    assert.equal(state.selected, "a");

    // Ctrl-click B again removes it and moves the inspector to the survivor.
    state = toggleModifierSelection(["a", "b"], "b", "b");
    assert.deepEqual(state.selectedIds, ["a"]);
    assert.equal(state.selected, "a");

    // Removing a non-inspected member keeps the inspector.
    state = toggleModifierSelection(["a", "b"], "a", "b");
    assert.deepEqual(state.selectedIds, ["a"]);
    assert.equal(state.selected, "a");

    // Removing the last member clears the selection entirely.
    state = toggleModifierSelection(["a"], "a", "a");
    assert.deepEqual(state.selectedIds, []);
    assert.equal(state.selected, "");
  });

  it("keeps the inspector inside a replaced (marquee / select-all) set", () => {
    assert.equal(replaceSelection(["a", "b"], "a"), "a");
    assert.equal(replaceSelection(["a", "b"], "z"), "a");
    assert.equal(replaceSelection(["a", "b"], ""), "a");
    assert.equal(replaceSelection([], "a"), "");
    assert.equal(replaceSelection([], ""), "");
  });
});

describe("keyboard edit-surface guard", () => {
  let isEditableTarget;
  before(() => { ({ isEditableTarget } = modules.keyboard); });

  // The module resolves HTMLElement from the global scope at call time, so a
  // minimal DOM stand-in is enough to exercise both branches.
  class FakeElement {
    constructor({ editable = false, matches = null } = {}) {
      this.isContentEditable = editable;
      this.closest = () => matches;
    }
  }
  const withGlobalHTMLElement = (run) => {
    const previous = globalThis.HTMLElement;
    globalThis.HTMLElement = FakeElement;
    try { return run(); } finally {
      if (previous === undefined) delete globalThis.HTMLElement;
      else globalThis.HTMLElement = previous;
    }
  };

  it("treats inputs, textareas, selects and contenteditables as editable", () => {
    withGlobalHTMLElement(() => {
      assert.equal(isEditableTarget(new FakeElement({ matches: {} })), true, "input via closest");
      assert.equal(isEditableTarget(new FakeElement({ editable: true })), true, "contenteditable");
    });
  });

  it("leaves plain grid surfaces to the gallery shortcuts", () => {
    withGlobalHTMLElement(() => {
      assert.equal(isEditableTarget(new FakeElement()), false);
      assert.equal(isEditableTarget({}), false);
      assert.equal(isEditableTarget(null), false);
    });
  });
});

describe("prompt draft binding", () => {
  let promptEditorActive, resolvePromptSaveTarget;
  before(() => { ({ promptEditorActive, resolvePromptSaveTarget } = modules.promptEdit); });

  const assets = [
    { id: "a", project_id: "default", prompt: "alpha" },
    { id: "b", project_id: "default", prompt: "beta" },
    { id: "c", project_id: "other", prompt: "gamma" },
  ];

  it("is only active while the bound project+asset is on screen", () => {
    const edit = { project: "default", assetId: "a" };
    assert.equal(promptEditorActive(edit, "default", "a"), true);
    assert.equal(promptEditorActive(edit, "default", "b"), false, "asset switched");
    assert.equal(promptEditorActive(edit, "other", "a"), false, "project switched");
    assert.equal(promptEditorActive(edit, "default", undefined), false);
    assert.equal(promptEditorActive(null, "default", "a"), false);
  });

  it("resolves the save target to the bound asset and nothing else", () => {
    assert.equal(resolvePromptSaveTarget({ project: "default", assetId: "b" }, assets), assets[1]);
    assert.equal(resolvePromptSaveTarget({ project: "other", assetId: "c" }, assets), assets[2]);
    assert.equal(resolvePromptSaveTarget({ project: "default", assetId: "missing" }, assets), null);
    assert.equal(resolvePromptSaveTarget({ project: "other", assetId: "a" }, assets), null, "cross-project id must never match");
    assert.equal(resolvePromptSaveTarget(null, assets), null);
  });
});

describe("gallery window geometry", () => {
  let buildGalleryRowModel, rowsIntersecting, locateGalleryWindow, gallerySpacerHeights;
  before(() => { ({ buildGalleryRowModel, rowsIntersecting, locateGalleryWindow, gallerySpacerHeights } = modules.galleryWindow); });

  it("sizes rows by the tallest ratio and accumulates offsets with the gap", () => {
    const model = buildGalleryRowModel([1, 1, 1, 1, 1, 1], 2, 100, 10);
    assert.deepEqual(model.rowHeight, [100, 100, 100]);
    assert.deepEqual(model.rowOffset, [0, 110, 220, 330]);
    assert.equal(model.totalHeight, 320);
    const mixed = buildGalleryRowModel([2, 1], 2, 100, 0);
    assert.deepEqual(mixed.rowHeight, [200]);
    assert.equal(mixed.totalHeight, 200);
  });

  it("finds the rows intersecting a viewport range", () => {
    const model = buildGalleryRowModel([1, 1, 1, 1], 1, 100, 10);
    assert.deepEqual(rowsIntersecting(model, 0, 100), { startRow: 0, endRow: 0 });
    assert.deepEqual(rowsIntersecting(model, 110, 220), { startRow: 1, endRow: 1 });
    assert.deepEqual(rowsIntersecting(model, 50, 250), { startRow: 0, endRow: 2 });
    assert.deepEqual(rowsIntersecting(model, 400, 2000), { startRow: 3, endRow: 3 }, "clamps past the end");
    assert.equal(rowsIntersecting(buildGalleryRowModel([], 2, 100, 0), 0, 500), null, "empty grid has no rows");
  });

  it("keeps the viewport rows mounted and caps the window budget", () => {
    const model = buildGalleryRowModel(Array.from({ length: 100 }, () => 1), 1, 100, 0);
    const viewport = { scrollTop: 5000, height: 100 };
    const wide = locateGalleryWindow(model, viewport.scrollTop, viewport.height, 1200, 1000);
    assert.ok(wide.startRow <= 50 && wide.endRow >= 50, "viewport row 50 stays mounted");
    assert.ok(wide.endRow - wide.startRow + 1 <= 62, "warm zone stays bounded");
    const tight = locateGalleryWindow(model, viewport.scrollTop, viewport.height, 1200, 6);
    assert.equal(tight.endRow - tight.startRow + 1, 6, "budget clamps the window");
    assert.ok(tight.startRow <= 50 && tight.endRow >= 50, "clamping keeps the viewport");
  });

  it("reconstructs the full scroll extent from spacers plus the window", () => {
    const model = buildGalleryRowModel(Array.from({ length: 40 }, () => 1), 2, 100, 8);
    const window = locateGalleryWindow(model, 400, 200, 300, 1000);
    const spacers = gallerySpacerHeights(model, window.startRow, window.endRow);
    const windowContent = model.rowHeight
      .slice(window.startRow, window.endRow + 1)
      .reduce((sum, height) => sum + height, 0)
      + (window.endRow - window.startRow) * model.gap;
    const extent = spacers.top + model.gap + windowContent + model.gap + spacers.bottom;
    assert.equal(extent, model.totalHeight);
    assert.deepEqual(gallerySpacerHeights(model, 0, model.rowHeight.length - 1), { top: 0, bottom: 0 });
  });
});
