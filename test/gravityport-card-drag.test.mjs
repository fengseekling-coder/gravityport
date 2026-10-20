import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const srcRoot = join(repositoryRoot, "web", "gravityport", "src");

let cardDragModule;
let tempRoot;
before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "mosa-gp-card-drag-"));
  const entry = join(srcRoot, "card-drag.ts");
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    entry, "--outDir", tempRoot, "--module", "esnext", "--target", "es2022",
    "--moduleResolution", "bundler", "--skipLibCheck",
  ], { stdio: "pipe" });
  cardDragModule = await import(join(tempRoot, "card-drag.js"));
});
after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("dragIdsForCard", () => {
  it("returns selected ids when dragging a card in the selection", () => {
    const selected = new Set(["a", "b", "c"]);
    const result = cardDragModule.dragIdsForCard(selected, "b");
    assert.deepEqual(result, ["a", "b", "c"]);
  });

  it("returns only the dragged card when not in selection", () => {
    const selected = new Set(["a", "b"]);
    const result = cardDragModule.dragIdsForCard(selected, "c");
    assert.deepEqual(result, ["c"]);
  });

  it("returns single card when selection is size 1", () => {
    const selected = new Set(["a"]);
    const result = cardDragModule.dragIdsForCard(selected, "a");
    assert.deepEqual(result, ["a"]);
  });

  it("returns empty array when assetId is empty", () => {
    const selected = new Set(["a", "b"]);
    const result = cardDragModule.dragIdsForCard(selected, "");
    assert.deepEqual(result, []);
  });
});

describe("dragGhostCount", () => {
  it("returns 1 for stack drag", () => {
    assert.equal(cardDragModule.dragGhostCount({ stackId: "s1" }), 1);
  });

  it("returns asset count for multi-asset drag", () => {
    assert.equal(cardDragModule.dragGhostCount({ assetIds: ["a", "b", "c"] }), 3);
  });

  it("returns at least 1 for empty assetIds", () => {
    assert.equal(cardDragModule.dragGhostCount({ assetIds: [] }), 1);
  });
});

describe("dragGestureOwner", () => {
  it("returns marquee when not starting on card", () => {
    assert.equal(cardDragModule.dragGestureOwner({}, { startsOnCard: false }), "marquee");
  });

  it("returns marquee when shift key is held", () => {
    assert.equal(cardDragModule.dragGestureOwner({ shiftKey: true }, { startsOnCard: true }), "marquee");
  });

  it("returns internal-asset for normal card drag", () => {
    assert.equal(cardDragModule.dragGestureOwner({}, { startsOnCard: true }), "internal-asset");
  });
});

describe("pointOutsideWindow", () => {
  const metrics = { screenX: 100, screenY: 100, outerWidth: 800, outerHeight: 600 };

  it("returns false when point is inside window", () => {
    assert.equal(cardDragModule.pointOutsideWindow({ screenX: 400, screenY: 300 }, metrics), false);
  });

  it("returns false when point is within margin", () => {
    assert.equal(cardDragModule.pointOutsideWindow({ screenX: 99, screenY: 300 }, metrics, 2), false);
    assert.equal(cardDragModule.pointOutsideWindow({ screenX: 901, screenY: 300 }, metrics, 2), false);
  });

  it("returns true when point is left of window", () => {
    assert.equal(cardDragModule.pointOutsideWindow({ screenX: 95, screenY: 300 }, metrics, 2), true);
  });

  it("returns true when point is right of window", () => {
    assert.equal(cardDragModule.pointOutsideWindow({ screenX: 905, screenY: 300 }, metrics, 2), true);
  });

  it("returns true when point is above window", () => {
    assert.equal(cardDragModule.pointOutsideWindow({ screenX: 400, screenY: 95 }, metrics, 2), true);
  });

  it("returns true when point is below window", () => {
    assert.equal(cardDragModule.pointOutsideWindow({ screenX: 400, screenY: 705 }, metrics, 2), true);
  });

  it("returns false when coordinates are invalid", () => {
    assert.equal(cardDragModule.pointOutsideWindow({ screenX: NaN, screenY: 300 }, metrics), false);
    assert.equal(cardDragModule.pointOutsideWindow({ screenX: 400, screenY: NaN }, metrics), false);
  });
});

describe("nativeDragPaths", () => {
  it("extracts paths in order of ids", () => {
    const assets = [
      { id: "a", image_path: "/path/a.jpg" },
      { id: "b", image_path: "/path/b.jpg" },
      { id: "c", image_path: "/path/c.jpg" },
    ];
    const result = cardDragModule.nativeDragPaths(assets, ["c", "a"]);
    assert.deepEqual(result, ["/path/c.jpg", "/path/a.jpg"]);
  });

  it("filters out empty paths", () => {
    const assets = [
      { id: "a", image_path: "/path/a.jpg" },
      { id: "b", image_path: "" },
      { id: "c" },
    ];
    const result = cardDragModule.nativeDragPaths(assets, ["a", "b", "c"]);
    assert.deepEqual(result, ["/path/a.jpg"]);
  });

  it("deduplicates paths", () => {
    const assets = [
      { id: "a", image_path: "/path/same.jpg" },
      { id: "b", image_path: "/path/same.jpg" },
    ];
    const result = cardDragModule.nativeDragPaths(assets, ["a", "b"]);
    assert.deepEqual(result, ["/path/same.jpg"]);
  });

  it("skips ids not found in assets", () => {
    const assets = [{ id: "a", image_path: "/path/a.jpg" }];
    const result = cardDragModule.nativeDragPaths(assets, ["a", "missing", "b"]);
    assert.deepEqual(result, ["/path/a.jpg"]);
  });
});

describe("moveBlockRelative", () => {
  it("moves a single card before the target", () => {
    assert.deepEqual(
      cardDragModule.moveBlockRelative(["a", "b", "c", "d"], ["c"], "a", "before"),
      ["c", "a", "b", "d"],
    );
  });

  it("moves a single card after the target", () => {
    assert.deepEqual(
      cardDragModule.moveBlockRelative(["a", "b", "c", "d"], ["a"], "b", "after"),
      ["b", "a", "c", "d"],
    );
  });

  it("moves a non-contiguous block after the target, keeping inner order", () => {
    assert.deepEqual(
      cardDragModule.moveBlockRelative(["a", "b", "c", "d", "e", "f"], ["a", "c"], "d", "after"),
      ["b", "d", "a", "c", "e", "f"],
    );
  });

  it("parks the block at the end when the target is inside the block", () => {
    assert.deepEqual(
      cardDragModule.moveBlockRelative(["a", "b", "c"], ["a", "b"], "a", "before"),
      ["c", "a", "b"],
    );
  });

  it("parks the block at the end when the target does not exist", () => {
    assert.deepEqual(
      cardDragModule.moveBlockRelative(["a", "b", "c"], ["b"], "missing", "before"),
      ["a", "c", "b"],
    );
  });

  it("returns the original order when nothing moves", () => {
    assert.deepEqual(
      cardDragModule.moveBlockRelative(["a", "b", "c"], ["a"], "b", "before"),
      ["a", "b", "c"],
    );
  });
});

describe("stackMemberPaths", () => {
  it("keeps stack order and maps members to their paths", () => {
    const result = cardDragModule.stackMemberPaths([
      { id: "c", imagePath: "/path/c.jpg" },
      { id: "a", imagePath: "/path/a.jpg" },
      { id: "b", imagePath: "/path/b.jpg" },
    ]);
    assert.deepEqual(result, ["/path/c.jpg", "/path/a.jpg", "/path/b.jpg"]);
  });

  it("deduplicates paths", () => {
    const result = cardDragModule.stackMemberPaths([
      { id: "a", imagePath: "/path/same.jpg" },
      { id: "b", imagePath: "/path/same.jpg" },
      { id: "c", imagePath: "/path/other.jpg" },
    ]);
    assert.deepEqual(result, ["/path/same.jpg", "/path/other.jpg"]);
  });

  it("skips members without a usable path", () => {
    const result = cardDragModule.stackMemberPaths([
      { id: "a", imagePath: "" },
      { id: "b" },
      { id: "c", imagePath: "/path/c.jpg" },
      { id: "d", imagePath: "   " },
    ]);
    assert.deepEqual(result, ["/path/c.jpg"]);
  });

  it("returns an empty array for empty or missing input", () => {
    assert.deepEqual(cardDragModule.stackMemberPaths([]), []);
    assert.deepEqual(cardDragModule.stackMemberPaths(null), []);
  });
});

describe("undoPlanForStackDrop", () => {
  it("plans a dissolve for a newly created stack", () => {
    assert.deepEqual(
      cardDragModule.undoPlanForStackDrop({ kind: "created-stack", project: "p", stackId: "s1" }),
      { kind: "dissolve-stack", project: "p", stackId: "s1" },
    );
  });

  it("plans to move out exactly the added ids, never the cover", () => {
    assert.deepEqual(
      cardDragModule.undoPlanForStackDrop({
        kind: "added-to-stack", project: "p", stackId: "s1",
        addedIds: ["c", "d"], coverId: "cover",
      }),
      { kind: "remove-from-stack", project: "p", stackId: "s1", assetIds: ["c", "d"] },
    );
  });

  it("excludes the cover id even when it slips into the added ids", () => {
    assert.deepEqual(
      cardDragModule.undoPlanForStackDrop({
        kind: "added-to-stack", project: "p", stackId: "s1",
        addedIds: ["c", "cover", "d"], coverId: "cover",
      }),
      { kind: "remove-from-stack", project: "p", stackId: "s1", assetIds: ["c", "d"] },
    );
  });

  it("returns null when nothing would actually be undone", () => {
    assert.equal(cardDragModule.undoPlanForStackDrop({
      kind: "added-to-stack", project: "p", stackId: "s1",
      addedIds: ["cover"], coverId: "cover",
    }), null);
    assert.equal(cardDragModule.undoPlanForStackDrop(null), null);
    assert.equal(cardDragModule.undoPlanForStackDrop({ kind: "created-stack", project: "", stackId: "s1" }), null);
  });
});

describe("createNativeDragController", () => {
  it("treats a missing api object as unsupported instead of throwing", () => {
    const controller = cardDragModule.createNativeDragController({ api: undefined, onError: () => {} });
    assert.equal(controller.supported(), false);
    assert.equal(controller.begin(["a"], ["/a.png"]), false);
  });

  it("returns supported false when api is missing", () => {
    const controller = cardDragModule.createNativeDragController({ api: {}, onError: () => {} });
    assert.equal(controller.supported(), false);
  });

  it("returns supported true when api.startNativeDrag exists", () => {
    const controller = cardDragModule.createNativeDragController({
      api: { startNativeDrag: async () => ({}) },
      onError: () => {},
    });
    assert.equal(controller.supported(), true);
  });

  it("does not trigger drag when point is inside window", () => {
    let callCount = 0;
    const controller = cardDragModule.createNativeDragController({
      api: { startNativeDrag: async () => { callCount++; return {}; } },
      onError: () => {},
    });
    controller.begin(["a"], ["/path/a.jpg"]);
    controller.startIfOutside({ screenX: 400, screenY: 300 }, { screenX: 100, screenY: 100, outerWidth: 800, outerHeight: 600 });
    assert.equal(callCount, 0);
  });

  it("triggers drag once when point moves outside window", () => {
    let callCount = 0;
    const controller = cardDragModule.createNativeDragController({
      api: { startNativeDrag: async () => { callCount++; return {}; } },
      onError: () => {},
    });
    controller.begin(["a"], ["/path/a.jpg"]);
    const metrics = { screenX: 100, screenY: 100, outerWidth: 800, outerHeight: 600 };
    controller.startIfOutside({ screenX: 50, screenY: 300 }, metrics);
    controller.startIfOutside({ screenX: 40, screenY: 300 }, metrics);
    assert.equal(callCount, 1);
  });

  it("calls onError when api is not supported", () => {
    let errorCalled = false;
    const controller = cardDragModule.createNativeDragController({
      api: {},
      onError: () => { errorCalled = true; },
    });
    controller.begin(["a"], ["/path/a.jpg"]);
    assert.equal(errorCalled, false);
  });

  it("calls onError when result.ok is false", async () => {
    let errorCalled = false;
    const controller = cardDragModule.createNativeDragController({
      api: { startNativeDrag: async () => ({ ok: false }) },
      onError: () => { errorCalled = true; },
    });
    controller.begin(["a"], ["/path/a.jpg"]);
    controller.startIfOutside({ screenX: 50, screenY: 300 }, { screenX: 100, screenY: 100, outerWidth: 800, outerHeight: 600 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(errorCalled, true);
  });

  it("calls onError when startNativeDrag throws", async () => {
    let errorCalled = false;
    const controller = cardDragModule.createNativeDragController({
      api: { startNativeDrag: async () => { throw new Error("test"); } },
      onError: () => { errorCalled = true; },
    });
    controller.begin(["a"], ["/path/a.jpg"]);
    controller.startIfOutside({ screenX: 50, screenY: 300 }, { screenX: 100, screenY: 100, outerWidth: 800, outerHeight: 600 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(errorCalled, true);
  });

  it("clearCandidate prevents drag from triggering", () => {
    let callCount = 0;
    const controller = cardDragModule.createNativeDragController({
      api: { startNativeDrag: async () => { callCount++; return {}; } },
      onError: () => {},
    });
    controller.begin(["a"], ["/path/a.jpg"]);
    controller.clearCandidate();
    controller.startIfOutside({ screenX: 50, screenY: 300 }, { screenX: 100, screenY: 100, outerWidth: 800, outerHeight: 600 });
    assert.equal(callCount, 0);
  });
});

describe("planStackMerge", () => {
  const stacks = new Map([["coverA", { id: "sA", name: "甲" }], ["coverB", { id: "sB", name: "" }]]);
  const members = new Map([["sA", ["coverA", "a2", "a3"]], ["sB", ["coverB", "b2"]]]);

  it("expands stack cards to their members in stack order, plain cards as themselves", () => {
    assert.deepEqual(cardDragModule.planStackMerge(["coverB", "p1", "coverA"], stacks, members), {
      movedIds: ["coverB", "b2", "p1", "coverA", "a2", "a3"],
      sources: [{ name: "", memberIds: ["coverB", "b2"] }, { name: "甲", memberIds: ["coverA", "a2", "a3"] }],
    });
  });

  it("records each stack once and drops duplicate ids", () => {
    assert.deepEqual(cardDragModule.planStackMerge(["coverA", "coverA", "a2"], stacks, members), {
      movedIds: ["coverA", "a2", "a3"],
      sources: [{ name: "甲", memberIds: ["coverA", "a2", "a3"] }],
    });
  });
});
