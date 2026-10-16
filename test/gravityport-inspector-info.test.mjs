// Inspector info module contract tests: reference resolution, source description,
// and prompt notice logic. The module ships as TypeScript inside web/gravityport,
// so it is bundled to a temporary ESM module with the project's own tsc before import.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");

let inspectorInfoModule;
let tempRoot;
before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "mosa-gp-inspector-info-"));
  const entry = join(uiRoot, "src", "inspector-info.ts");
  // Compile TypeScript to ESM with dependencies
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    entry, "--outDir", tempRoot, "--module", "esnext", "--target", "es2022",
    "--moduleResolution", "bundler", "--skipLibCheck",
  ], { stdio: "pipe" });
  inspectorInfoModule = await import(join(tempRoot, "inspector-info.js"));
});
after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("resolveReferences", () => {
  it("uses active snapshot references when recipe history is loaded", () => {
    const asset = {
      id: "a1",
      project_id: "default",
      references: [{ role: "asset-reference", attachment_url: "/asset-ref.jpg" }],
    };
    const recipeHistory = {
      asset_id: "a1",
      project_id: "default",
      active_snapshot_id: "snap1",
      snapshots: [
        { snapshot_id: "snap1", references: [{ role: "snapshot-ref", attachment_url: "/snap-ref.jpg" }] },
      ],
    };
    const result = inspectorInfoModule.resolveReferences(asset, recipeHistory, []);
    assert.notEqual(result, null);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].label, "snapshot-ref");
    assert.equal(result.total, 1);
  });

  it("uses last snapshot when active_snapshot_id is missing", () => {
    const asset = {
      id: "a1",
      project_id: "default",
      references: [],
    };
    const recipeHistory = {
      asset_id: "a1",
      project_id: "default",
      snapshots: [
        { snapshot_id: "snap1", references: [{ role: "first" }] },
        { snapshot_id: "snap2", references: [{ role: "last" }] },
      ],
    };
    const result = inspectorInfoModule.resolveReferences(asset, recipeHistory, []);
    assert.notEqual(result, null);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].label, "last");
  });

  it("returns null when recipeHistory is undefined and source is web-*", () => {
    const asset = {
      id: "a1",
      project_id: "default",
      source: { type: "web-chatgpt" },
      references: [],
    };
    const result = inspectorInfoModule.resolveReferences(asset, undefined, []);
    assert.equal(result, null);
  });

  it("ignores a history that belongs to another asset in the same project", () => {
    const asset = { id: "b1", project_id: "default", source: { type: "web-chatgpt" }, references: [] };
    const otherHistory = {
      asset_id: "a1",
      project_id: "default",
      active_snapshot_id: "snap1",
      snapshots: [{ snapshot_id: "snap1", references: [{ role: "other-asset-ref" }] }],
    };
    assert.equal(inspectorInfoModule.resolveReferences(asset, otherHistory, []), null);
    const local = { ...asset, source: { type: "local-file" } };
    assert.deepEqual(inspectorInfoModule.resolveReferences(local, otherHistory, []), { items: [], total: 0 });
  });

  it("returns empty array when recipeHistory is null and asset has no references", () => {
    const asset = {
      id: "a1",
      project_id: "default",
      references: [],
    };
    const result = inspectorInfoModule.resolveReferences(asset, null, []);
    assert.notEqual(result, null);
    assert.equal(result.items.length, 0);
    assert.equal(result.total, 0);
  });

  it("prioritizes thumbnail URLs: linked asset thumbnail > attachment_url > linked asset image_url > empty", () => {
    const asset = {
      id: "a1",
      project_id: "default",
      references: [
        { asset_id: "linked1", role: "ref1" },
        { attachment_url: "/attach.jpg", role: "ref2" },
        { asset_id: "linked3", role: "ref3" },
        { role: "ref4" },
      ],
    };
    const libraryAssets = [
      { id: "linked1", thumbnail_url: "/thumb1.jpg", image_url: "/img1.jpg" },
      { id: "linked3", image_url: "/img3.jpg" },
    ];
    const result = inspectorInfoModule.resolveReferences(asset, null, libraryAssets);
    assert.equal(result.items[0].thumbnailUrl, "/thumb1.jpg");
    assert.equal(result.items[1].thumbnailUrl, "/attach.jpg");
    assert.equal(result.items[2].thumbnailUrl, "/img3.jpg");
    assert.equal(result.items[3].thumbnailUrl, "");
    // Ensure empty thumbnail item is still in results
    assert.equal(result.items.length, 4);
  });

  it("limits to 8 items but reports total count", () => {
    const asset = {
      id: "a1",
      project_id: "default",
      references: Array.from({ length: 12 }, (_, i) => ({ role: `ref${i + 1}` })),
    };
    const result = inspectorInfoModule.resolveReferences(asset, null, []);
    assert.equal(result.items.length, 8);
    assert.equal(result.total, 12);
  });

  it("generates fallback labels for references without role", () => {
    const asset = {
      id: "a1",
      project_id: "default",
      references: [{ attachment_url: "/ref1.jpg" }, { attachment_url: "/ref2.jpg" }],
    };
    const result = inspectorInfoModule.resolveReferences(asset, null, []);
    assert.equal(result.items[0].label, "参考图 1");
    assert.equal(result.items[1].label, "参考图 2");
  });
});

describe("describeSource", () => {
  it("describes local image with date and group", () => {
    const asset = {
      mediaKind: "image",
      source: { type: "local-file" },
      created_at: "2024-03-15T10:30:00Z",
      group: "MyGroup",
    };
    const result = inspectorInfoModule.describeSource(asset, "zh");
    assert.equal(result.kindLabel, "图片");
    assert.equal(result.sourceLabel, "手动导入");
    assert.match(result.dateLabel, /2024/);
    assert.equal(result.groupLabel, "MyGroup");
  });

  it("describes web-collected image", () => {
    const asset = {
      mediaKind: "image",
      source: { type: "web-gemini" },
      created_at: "2024-03-15T10:30:00Z",
      group: "",
    };
    const result = inspectorInfoModule.describeSource(asset, "zh");
    assert.equal(result.kindLabel, "图片");
    assert.equal(result.sourceLabel, "Gemini 网页版");
    assert.equal(result.groupLabel, "");
  });

  it("describes video asset", () => {
    const asset = {
      mediaKind: "video",
      source: { type: "codex-generated" },
      created_at: "2024-03-15T10:30:00Z",
      group: "",
    };
    const result = inspectorInfoModule.describeSource(asset, "zh");
    assert.equal(result.kindLabel, "视频");
    assert.equal(result.sourceLabel, "Codex");
  });

  it("handles invalid date", () => {
    const asset = {
      mediaKind: "image",
      source: { type: "local-file" },
      created_at: "invalid-date",
      group: "",
    };
    const result = inspectorInfoModule.describeSource(asset, "zh");
    assert.equal(result.dateLabel, "");
  });

  it("handles missing group", () => {
    const asset = {
      mediaKind: "image",
      source: { type: "local-file" },
      created_at: "2024-03-15T10:30:00Z",
      group: "",
    };
    const result = inspectorInfoModule.describeSource(asset, "zh");
    assert.equal(result.groupLabel, "");
  });

  it("falls back to unknown source when source type is empty", () => {
    const asset = {
      mediaKind: "image",
      source: {},
      created_at: "2024-03-15T10:30:00Z",
      group: "",
    };
    const result = inspectorInfoModule.describeSource(asset, "zh");
    assert.equal(result.sourceLabel, "未知来源");
  });

  it("returns unrecognized source types verbatim", () => {
    const asset = {
      mediaKind: "image",
      source: { type: "web-sora" },
      created_at: "2024-03-15T10:30:00Z",
      group: "",
    };
    const result = inspectorInfoModule.describeSource(asset, "zh");
    assert.equal(result.sourceLabel, "web-sora");
  });

  it("formats the date label in English for language en", () => {
    const asset = {
      mediaKind: "image",
      source: { type: "local-file" },
      created_at: "2024-03-15T10:30:00Z",
      group: "",
    };
    const result = inspectorInfoModule.describeSource(asset, "en");
    assert.equal(result.dateLabel, "Mar 15, 2024");
  });
});

describe("promptNotice", () => {
  it("returns webPromptUnavailable when web source has no prompt", () => {
    const asset = {
      prompt: "",
      source: { type: "web-chatgpt", prompt_status: "not-available" },
    };
    const result = inspectorInfoModule.promptNotice(asset);
    assert.notEqual(result, null);
    assert.equal(result.key, "webPromptUnavailable");
    assert.equal(result.text, "网页来源未暴露原始生图提示词");
  });

  it("returns geminiVisibleUserPromptUnverified for Gemini provider-visible prompt", () => {
    const asset = {
      prompt: "user prompt",
      source: { type: "web-gemini", prompt_status: "provider-visible-prompt", provider: "gemini" },
    };
    const result = inspectorInfoModule.promptNotice(asset);
    assert.notEqual(result, null);
    assert.equal(result.key, "geminiVisibleUserPromptUnverified");
    assert.match(result.text, /Gemini/);
  });

  it("returns googleAiStudioVisibleUserPromptUnverified for Google AI Studio", () => {
    const asset = {
      prompt: "user prompt",
      source: { type: "web-google-ai-studio", prompt_status: "provider-visible-prompt", provider: "google-ai-studio" },
    };
    const result = inspectorInfoModule.promptNotice(asset);
    assert.notEqual(result, null);
    assert.equal(result.key, "googleAiStudioVisibleUserPromptUnverified");
    assert.match(result.text, /Google AI Studio/);
  });

  it("returns flowProviderVisiblePromptUnverified for Flow", () => {
    const asset = {
      prompt: "user prompt",
      source: { type: "web-flow", prompt_status: "provider-visible-prompt", provider: "flow" },
    };
    const result = inspectorInfoModule.promptNotice(asset);
    assert.notEqual(result, null);
    assert.equal(result.key, "flowProviderVisiblePromptUnverified");
    assert.match(result.text, /Flow/);
  });

  it("returns null when asset has normal prompt", () => {
    const asset = {
      prompt: "normal prompt",
      source: { type: "codex-generated" },
    };
    const result = inspectorInfoModule.promptNotice(asset);
    assert.equal(result, null);
  });

  it("returns null when asset has no prompt but is not web source", () => {
    const asset = {
      prompt: "",
      source: { type: "local-file" },
    };
    const result = inspectorInfoModule.promptNotice(asset);
    assert.equal(result, null);
  });
});
