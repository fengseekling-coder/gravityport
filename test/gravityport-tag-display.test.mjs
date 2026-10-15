// GravityPort inspector tag-display logic tests.
//
// tag-display.ts is compiled with tsc into a temp dir and imported — the real
// module is under test, never a hand-copied version (gravityport-library-actions
// pattern, single source file, no imports).
import { execFileSync } from "node:child_process";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");

let td; // tag-display exports

before(async () => {
  const compileRoot = await mkdtemp(join(tmpdir(), "mosa-gp-tags-"));
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    join(uiRoot, "src", "tag-display.ts"),
    "--outDir", compileRoot,
    "--module", "esnext",
    "--target", "es2022",
    "--moduleResolution", "bundler",
    "--skipLibCheck",
  ], { stdio: "pipe" });
  td = await import(join(compileRoot, "tag-display.js"));
  after(async () => {
    await rm(compileRoot, { recursive: true, force: true });
  });
});

describe("SMART_SOURCE_GROUPS", () => {
  it("carries the seven sidebar smart groups intact", () => {
    assert.deepEqual(td.SMART_SOURCE_GROUPS, [
      ["web-chatgpt", "ChatGPT"], ["web-gemini", "Gemini"],
      ["web-flow", "Flow"], ["web-google-ai-studio", "Google AI Studio"],
      ["codex-generated", "Codex"], ["grok-generated", "Grok"],
      ["cowart-generated", "Cowart"],
    ]);
  });
});

describe("vendorLabelFor", () => {
  it("maps every smart source to its sidebar display name", () => {
    const expected = {
      "web-chatgpt": "ChatGPT",
      "web-gemini": "Gemini",
      "web-flow": "Flow",
      "web-google-ai-studio": "Google AI Studio",
      "codex-generated": "Codex",
      "grok-generated": "Grok",
      "cowart-generated": "Cowart",
    };
    for (const [source, label] of Object.entries(expected)) {
      assert.equal(td.vendorLabelFor(source), label, source);
    }
  });

  it("returns null for unknown and manual sources", () => {
    assert.equal(td.vendorLabelFor("local-file"), null);
    assert.equal(td.vendorLabelFor(""), null);
    assert.equal(td.vendorLabelFor("some-legacy-source"), null);
  });
});

describe("visibleTags", () => {
  it("hides every system tag of a captured asset, leaving the vendor only", () => {
    assert.deepEqual(td.visibleTags(["auto-archived", "chatgpt", "web-capture"], "web-chatgpt"), []);
  });

  it("drops the vendor-duplicate tag case-insensitively and keeps the rest in order", () => {
    assert.deepEqual(
      td.visibleTags(["ChatGPT", "风景", "manual-capture", "video", "风景"], "web-chatgpt"),
      ["风景", "video"],
    );
  });

  it("keeps video and user tags for a known source", () => {
    assert.deepEqual(
      td.visibleTags(["grok", "web-capture", "auto-archived", "video", "我的标签"], "grok-generated"),
      ["video", "我的标签"],
    );
  });

  it("hides the provider-key spelling of a multi-word vendor", () => {
    assert.deepEqual(
      td.visibleTags(["google-ai-studio", "web-capture", "auto-archived", "海边"], "web-google-ai-studio"),
      ["海边"],
    );
    assert.deepEqual(td.visibleTags(["codex", "auto-archived", "海边"], "codex-generated"), ["海边"]);
  });

  it("hides system tags even without a vendor (unknown source)", () => {
    assert.deepEqual(td.visibleTags(["web-capture", "manual-capture", "风景"], "local-file"), ["风景"]);
  });

  it("returns an empty list for empty or malformed input", () => {
    assert.deepEqual(td.visibleTags([], "web-chatgpt"), []);
    assert.deepEqual(td.visibleTags(undefined, "web-chatgpt"), []);
  });
});

describe("removeTagFromStored", () => {
  it("removes exactly the visible tag and keeps hidden tags and order", () => {
    const stored = ["auto-archived", "chatgpt", "web-capture", "风景", "video"];
    assert.deepEqual(
      td.removeTagFromStored(stored, "风景"),
      ["auto-archived", "chatgpt", "web-capture", "video"],
    );
    // The input list itself is untouched.
    assert.deepEqual(stored, ["auto-archived", "chatgpt", "web-capture", "风景", "video"]);
  });

  it("removes case-insensitive duplicates the row collapsed into one label", () => {
    assert.deepEqual(td.removeTagFromStored(["风景", "video", "风景", "Sky", "sky"], "风景"), ["video", "Sky", "sky"]);
    assert.deepEqual(td.removeTagFromStored(["Sky", "video", "sky"], "Sky"), ["video"]);
  });

  it("returns an equal copy when the tag is absent", () => {
    assert.deepEqual(td.removeTagFromStored(["a", "b"], "missing"), ["a", "b"]);
    assert.deepEqual(td.removeTagFromStored(undefined, "a"), []);
  });
});

describe("fitTagsInTwoLines", () => {
  const add = 90;
  const toggle = 34;

  it("returns every item when all of them fit with the add button", () => {
    const count = td.fitTagsInTwoLines({
      itemWidths: [60, 50, 40, 30], containerWidth: 800, gap: 4, toggleWidth: toggle, addWidth: add,
    });
    assert.equal(count, 4);
  });

  it("folds items so +N and the add button still end the second line", () => {
    // Five 100px items, 300px container: three per line is impossible with the
    // tail, two items + toggle + add = 100+4+100+4+34+4+90 = 336 > 300, so the
    // row must stop after the first line-2 item.
    const widths = [100, 100, 100, 100, 100];
    const count = td.fitTagsInTwoLines({
      itemWidths: widths, containerWidth: 300, gap: 4, toggleWidth: toggle, addWidth: add,
    });
    assert.ok(count < widths.length, `expected folding, got ${count}`);
    // Whatever count is chosen, replay its layout: at most two lines and the
    // trailing elements fit on the last line.
    let x = 0;
    let line = 1;
    for (let i = 0; i < count; i++) {
      const next = x === 0 ? widths[i] : x + 4 + widths[i];
      if (next <= 300) { x = next; continue; }
      line += 1;
      x = widths[i];
    }
    assert.ok(line <= 2, `count ${count} needs ${line} lines`);
    const trailing = (4 + toggle) + 4 + add; // folded, so +N is present
    assert.ok(x + trailing <= 300, `trailing overflow at count ${count}`);
  });

  it("lets the add button wrap to line 2 instead of folding a tag that fits", () => {
    // Three 96px items fill a 300px line exactly (96*3+4*2 = 296); the add
    // button starts line 2, so nothing needs folding.
    assert.equal(td.fitTagsInTwoLines({
      itemWidths: [96, 96, 96], containerWidth: 300, gap: 4, toggleWidth: toggle, addWidth: add,
    }), 3);
  });

  it("shows at least the vendor item in a container too narrow for one item", () => {
    const count = td.fitTagsInTwoLines({
      itemWidths: [200, 200, 200], containerWidth: 50, gap: 4, toggleWidth: toggle, addWidth: add,
    });
    assert.equal(count, 1);
  });

  it("survives zero, negative, and non-numeric widths without throwing", () => {
    assert.doesNotThrow(() => {
      assert.equal(td.fitTagsInTwoLines({ itemWidths: [50, 50], containerWidth: 0, gap: 4, toggleWidth: 10, addWidth: 10 }), 1);
      assert.equal(td.fitTagsInTwoLines({ itemWidths: [50, 50], containerWidth: -5, gap: 4, toggleWidth: 10, addWidth: 10 }), 1);
      assert.equal(td.fitTagsInTwoLines({ itemWidths: [50, 50], containerWidth: Number.NaN, gap: 4, toggleWidth: 10, addWidth: 10 }), 1);
      assert.equal(td.fitTagsInTwoLines({ itemWidths: [], containerWidth: 300, gap: 4, toggleWidth: 10, addWidth: 10 }), 0);
    });
  });

  it("keeps a single item without any toggle", () => {
    const count = td.fitTagsInTwoLines({
      itemWidths: [80], containerWidth: 300, gap: 4, toggleWidth: toggle, addWidth: add,
    });
    assert.equal(count, 1);
  });
});
