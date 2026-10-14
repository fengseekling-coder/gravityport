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
  const sources = ["selection.ts", "prompt-edit.ts", "keyboard.ts", "gallery-window.ts", "version-tree.ts", "feature-parity.ts"]
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
    versionTree: await import(join(tempRoot, "version-tree.js")),
    featureParity: await import(join(tempRoot, "feature-parity.js")),
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

describe("explicit focus switch selection unity", () => {
  let focusSelection, logicalSelection;
  before(() => { ({ focusSelection, logicalSelection } = modules.selection); });

  it("collapses a multi-selection onto a focus outside it", () => {
    // Multi-select A/B, then the inspector moves to C (version row, related
    // recommendation, viewer arrow): the batch target becomes the visible C —
    // never the out-of-sight A/B.
    const next = focusSelection(["a", "b"], "a", "c");
    assert.deepEqual(next.selectedIds, []);
    assert.equal(next.selected, "c");
    assert.deepEqual(logicalSelection(next.selectedIds, next.selected), ["c"]);
  });

  it("keeps the multi-selection when the focus stays inside it", () => {
    // Right-clicking a member of the selection refocuses the inspector while
    // the whole selection stays the batch target.
    const next = focusSelection(["a", "b"], "a", "b");
    assert.deepEqual(next.selectedIds, ["a", "b"]);
    assert.equal(next.selected, "b");
  });

  it("lands a single focus without inventing a set", () => {
    const next = focusSelection([], "", "d");
    assert.deepEqual(next.selectedIds, []);
    assert.equal(next.selected, "d");
    assert.deepEqual(logicalSelection(next.selectedIds, next.selected), ["d"]);
  });
});

describe("selection pruning on same-view refresh", () => {
  let pruneSelection;
  before(() => { ({ pruneSelection } = modules.selection); });

  it("keeps entries that are still visible in the refreshed view", () => {
    const valid = (id) => id === "a" || id === "c";
    const pruned = pruneSelection(["a", "b", "c"], "a", valid);
    assert.deepEqual(pruned.selectedIds, ["a", "c"]);
    assert.equal(pruned.selected, "a");
    assert.equal(pruned.changed, true);
  });

  it("drops the inspector target when its asset left the view", () => {
    const pruned = pruneSelection(["a"], "gone", (id) => id === "a");
    assert.deepEqual(pruned.selectedIds, ["a"]);
    assert.equal(pruned.selected, "", "the caller re-lands the inspector on a visible card");
    assert.equal(pruned.changed, true);
  });

  it("reports no change when every entry survived", () => {
    const pruned = pruneSelection(["a", "b"], "b", () => true);
    assert.deepEqual(pruned.selectedIds, ["a", "b"]);
    assert.equal(pruned.selected, "b");
    assert.equal(pruned.changed, false);
  });

  it("handles an empty selection", () => {
    const pruned = pruneSelection([], "", () => false);
    assert.deepEqual(pruned.selectedIds, []);
    assert.equal(pruned.selected, "");
    assert.equal(pruned.changed, false);
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
  let buildGalleryRowModel, rowsIntersecting, locateGalleryWindow, gallerySpacerHeights, galleryModelSignature;
  before(() => { ({ buildGalleryRowModel, rowsIntersecting, locateGalleryWindow, gallerySpacerHeights, galleryModelSignature } = modules.galleryWindow); });

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

  it("cache signature reacts to reorder and ratio changes a plain sum would miss", () => {
    const signatureOf = (ratios, columns = 5, colWidth = 200) => galleryModelSignature(ratios, columns, colWidth);
    const base = [1, 2, 0.5, 1.5];
    assert.equal(signatureOf([...base]), signatureOf([...base]), "identical ratios keep the cache");
    // Same multiset, swapped order: a plain sum sees no difference, the
    // positional checksum must.
    assert.notEqual(signatureOf(base), signatureOf([2, 1, 0.5, 1.5]), "swap changes the signature");
    assert.notEqual(signatureOf(base), signatureOf([0.5, 2, 1, 1.5]), "rotation changes the signature");
    // A single ratio change with an equal total (above the 1/1000 rounding).
    assert.notEqual(signatureOf([1, 1, 1, 1]), signatureOf([1, 1, 1, 1.02]));
    // Column count and column width are part of the key.
    assert.notEqual(signatureOf(base, 5), signatureOf(base, 4));
    assert.notEqual(signatureOf(base, 5, 200), signatureOf(base, 5, 210));
  });

  it("keeps [3,1,2,1] and [2,3,1,1] apart — the pair the weighted checksum folded into one number", () => {
    // Σ(i+1)·r = 15000 for BOTH rows, so the old positional checksum served
    // the second layout's cache hit from the first one's row model.
    const left = [3, 1, 2, 1];
    const right = [2, 3, 1, 1];
    assert.notEqual(
      galleryModelSignature(left, 2, 200),
      galleryModelSignature(right, 2, 200),
      "a cache hit across these two arrays silently served the wrong row heights",
    );
    // With the key distinct, the rebuild must produce the real geometry of
    // each layout: in two columns the tall card leads row 0 either way, but
    // the trailing pair differs — so do the row heights and scroll extent.
    const modelLeft = buildGalleryRowModel(left, 2, 200, 4);
    const modelRight = buildGalleryRowModel(right, 2, 200, 4);
    assert.deepEqual(modelLeft.rowHeight, [600, 400]);
    assert.deepEqual(modelRight.rowHeight, [600, 200]);
    assert.deepEqual(modelLeft.rowOffset, [0, 604, 1008]);
    assert.deepEqual(modelRight.rowOffset, [0, 604, 808]);
    assert.notEqual(modelLeft.totalHeight, modelRight.totalHeight);
    // ...and the spacers of the same window follow the rebuilt model.
    const spacersLeft = gallerySpacerHeights(modelLeft, 0, 0);
    const spacersRight = gallerySpacerHeights(modelRight, 0, 0);
    assert.deepEqual(spacersLeft, { top: 0, bottom: 400 });
    assert.deepEqual(spacersRight, { top: 0, bottom: 200 });
  });
});

describe("production masonry geometry", () => {
  it("preserves every source ratio and places into the shortest column", () => {
    const { buildMasonryModel } = modules.galleryWindow;
    const model = buildMasonryModel([2, 0.5, 1, 0.8, 3], 2, 100, 4);
    assert.deepEqual(model.placements.map(item => item.column), [0, 1, 1, 1, 0]);
    assert.deepEqual(model.placements.map(item => item.height), [200, 50, 100, 80, 300]);
    assert.deepEqual(model.placements.map(item => item.top), [0, 0, 54, 158, 204]);
    assert.equal(model.totalHeight, 504);
  });

  it("has no overlap or unfilled gap inside each column", () => {
    const { buildMasonryModel } = modules.galleryWindow;
    const model = buildMasonryModel([1.8, 0.5, 1, 2.3, 0.6, 0.75, 1.5, 0.4, 1.9], 3, 240, 5);
    for (let column = 0; column < 3; column++) {
      const cards = model.placements.filter(item => item.column === column);
      for (let i = 1; i < cards.length; i++)
        assert.ok(Math.abs(cards[i].top - cards[i - 1].top - cards[i - 1].height - 5) < 0.001);
    }
  });

  it("retains viewport cards in bounded 4249-item virtual windows", () => {
    const { buildMasonryModel, locateMasonryWindow } = modules.galleryWindow;
    const model = buildMasonryModel(Array.from({ length: 4249 }, (_, i) => 0.5 + (i % 7) / 3), 5, 200, 4);
    for (const scroll of [0, 1500, 12000, model.totalHeight - 900]) {
      const ids = locateMasonryWindow(model, scroll, 900, 1200, 380);
      assert.ok(ids.length > 0 && ids.length <= 380);
      const visible = model.placements.flatMap((p, i) => p.top < scroll + 900 && p.top + p.height > scroll ? [i] : []);
      for (const id of visible) assert.ok(ids.includes(id), `missing visible card ${id}`);
    }
  });
});

describe("generation relationship tree parity", () => {
  it("orders proven relationships by depth without treating context as ancestry", () => {
    const events = [{ id: "child" }, { id: "root" }, { id: "sibling" }];
    const rows = modules.versionTree.generationTreeRows({
      events, context_events: [{ id: "candidate" }],
      relations: [
        { parent_generation_id: "root", child_generation_id: "child", relation_type: "edited_from" },
        { parent_generation_id: "root", child_generation_id: "sibling", relation_type: "derived_from" },
      ],
    });
    assert.deepEqual(rows.map(row => [row.event.id, row.depth]), [["root", 0], ["child", 1], ["sibling", 1]]);
    assert.equal(rows[1].relationTypes[0], "edited_from");
    assert.ok(!rows.some(row => row.event.id === "candidate"));
  });

  it("bounds cyclic data and shows multi-parent events only once", () => {
    const events = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const rows = modules.versionTree.generationTreeRows({ events, relations: [
      { parent_generation_id: "a", child_generation_id: "b" },
      { parent_generation_id: "b", child_generation_id: "a" },
      { parent_generation_id: "c", child_generation_id: "b" },
    ] });
    assert.deepEqual(new Set(rows.map(row => row.event.id)), new Set(["a", "b", "c"]));
    assert.equal(rows.length, 3);
  });
});

describe("legacy feature parity helpers", () => {
  it("group export removes local paths and media URLs without rewriting authored text", () => {
    const input = {
      id: "asset-1", prompt: "/Users/this-is-user-authored-text",
      image_path: "/Users/test/private.png", image_url: "/library/default/images/private.png",
      business_fields: { note: "https://example.com/keep-as-text", cowart_project_dir: "/Users/me/secret" },
      source: { path: "/Users/me/private", prompt_file: "/Users/me/prompt.txt", user_message: "Keep this" },
      references: [{ attachment_url: "/library/default/attachments/private", rights: { attribution: "Artist" } }],
    };
    const exported = modules.featureParity.sanitizeAssetForExport(input);
    assert.deepEqual(exported, {
      id: "asset-1", prompt: input.prompt,
      business_fields: { note: "https://example.com/keep-as-text" },
      source: { user_message: "Keep this" },
      references: [{ rights: { attribution: "Artist" } }],
    });
    assert.equal(input.image_path, "/Users/test/private.png", "must not mutate the input");
  });

  it("reference-use permissions remain exclusive and preserve recipe identity", () => {
    const original = {
      asset_id: "source-A", sha256: "digest", role: "identity", scope: ["shot-1"], applied: true,
      rights: { copyright: "licensed" },
      allowed_uses: ["subject", "identity"], forbidden_uses: ["style"],
    };
    const next = modules.featureParity.setReferencePermission(original, "identity", "forbidden");
    assert.equal(modules.featureParity.referencePermission(next, "identity"), "forbidden");
    assert.deepEqual(next.allowed_uses, ["subject"]);
    assert.deepEqual(next.forbidden_uses, ["identity", "style"]);
    const cleared = modules.featureParity.setReferencePermission(next, "identity", "undeclared");
    assert.equal(modules.featureParity.referencePermission(cleared, "identity"), "undeclared");
    for (const field of ["asset_id", "sha256", "role", "scope", "applied", "rights"]) {
      assert.deepEqual(next[field], original[field], `rights edit cannot alter ${field}`);
    }
    assert.deepEqual(original.allowed_uses, ["subject", "identity"]);
  });
});
