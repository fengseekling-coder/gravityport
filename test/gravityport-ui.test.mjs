// GravityPort React UI contract tests: the MOSA API adapter's normalization
// and query behavior, plus i18n key completeness for every translated string
// the React tree uses. The adapter ships as TypeScript inside web/gravityport,
// so it is bundled to a temporary ESM module with the project's own esbuild
// before import.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");

let adapterModule;
let tempRoot;
before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "mosa-gp-ui-"));
  const entry = join(uiRoot, "src", "mosa-api.ts");
  // The adapter is dependency-free, so a one-file tsc emission is enough.
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    entry, "--outDir", tempRoot, "--module", "esnext", "--target", "es2022",
    "--moduleResolution", "bundler", "--skipLibCheck",
  ], { stdio: "pipe" });
  adapterModule = await import(join(tempRoot, "mosa-api.js"));
});
after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("normalizeAsset", () => {
  it("maps the server media kind vocabulary (img) onto image/video", () => {
    const image = adapterModule.normalizeAsset({ id: "a", business_fields: { media_kind: "img", width: 10, height: 5 } });
    assert.equal(image.mediaKind, "image");
    const video = adapterModule.normalizeAsset({ id: "b", business_fields: { media_kind: "video" } });
    assert.equal(video.mediaKind, "video");
    const extensionFallback = adapterModule.normalizeAsset({ id: "c", asset: "clip.MOV" });
    assert.equal(extensionFallback.mediaKind, "video");
  });

  it("prefers runtime URLs and never fabricates missing metadata", () => {
    const asset = adapterModule.normalizeAsset({
      id: "a",
      project_id: "default",
      asset: "photo.png",
      image_url: "/library/default/images/photo.png",
      thumbnail_url: "/library/default/thumbnails/a.webp",
      preview_url: "/library/default/previews/a.webp",
      favorite: true,
      palette: ["#112233", 42, null],
      tags: ["海", 7],
      business_fields: { width: 32, height: 32 },
      stack: { id: "s1", count: "3", name: "" },
      references: [{ attachment_url: "/library/default/attachments/x" }],
    });
    assert.equal(asset.thumbnail_url, "/library/default/thumbnails/a.webp");
    assert.equal(asset.preview_url, "/library/default/previews/a.webp");
    assert.equal(asset.favorite, true);
    assert.deepEqual(asset.palette, ["#112233"]);
    assert.deepEqual(asset.tags, ["海"]);
    assert.equal(asset.format, "PNG");
    assert.deepEqual(asset.stack, { id: "s1", count: 3, name: "" });
    assert.equal(asset.references.length, 1);
    const empty = adapterModule.normalizeAsset({ id: "z" });
    assert.equal(empty.prompt, "");
    assert.deepEqual(empty.palette, []);
    assert.equal(empty.stack, null);
    assert.equal(empty.width >= 1 && empty.height >= 1, true);
  });

  it("preserves both provenance prompts and sizes responsive derivatives correctly", () => {
    const asset = adapterModule.normalizeAsset({
      id: "a", prompt: "Main caption", source: {
        generation_request_prompt: "Tool prompt", user_message: "Draw a forest",
      }, thumbnail_url: "/t.webp", medium_url: "/m.webp", preview_url: "/p.webp",
      thumbnail_ready: true, medium_ready: true, preview_ready: true,
      business_fields: { width: 941, height: 1672 },
    });
    assert.equal(asset.prompt, "Main caption");
    assert.equal(asset.prompt2, "Tool prompt");
    assert.equal(asset.user_instruction, "Draw a forest");
    const srcset = adapterModule.galleryImageSrcSet(asset);
    assert.match(srcset, /\/t\.webp 225w/);
    assert.match(srcset, /\/m\.webp 540w/);
    assert.match(srcset, /\/p\.webp 900w/);
    const legacy = adapterModule.normalizeAsset({ id: "legacy", business_fields: { user_message: "Old instruction" } });
    assert.equal(legacy.user_instruction, "Old instruction");
  });
});

describe("fetchAssetPage query mapping", () => {
  it("sends the backend media vocabulary and scope flags, and reads the page envelope", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          assets: [{ id: "a", business_fields: { media_kind: "img" } }],
          page: { total: 7, nextCursor: "cur-1" },
          revision: "r9",
        }),
      };
    };
    try {
      const page = await adapterModule.fetchAssetPage({
        project: "default", q: "harbor", sort: "newest", scope: "favorite",
        mediaKind: "img", source: "web-chatgpt", group: "灵感收集", stackId: "",
      }, { limit: 42 });
      const url = new URL(calls[0], "http://127.0.0.1");
      assert.equal(url.pathname, "/api/assets");
      assert.equal(url.searchParams.get("view"), "gallery");
      assert.equal(url.searchParams.get("mediaKind"), "img", "the backend vocabulary is img, not image");
      assert.equal(url.searchParams.get("favorite"), "1");
      assert.equal(url.searchParams.get("source"), "web-chatgpt");
      assert.equal(url.searchParams.get("group"), "灵感收集");
      assert.equal(url.searchParams.get("limit"), "42");
      assert.equal(page.total, 7);
      assert.equal(page.nextCursor, "cur-1");
      assert.equal(page.revision, "r9");
      assert.equal(page.assets.length, 1);

      calls.length = 0;
      await adapterModule.fetchAssetPage({
        project: "default", q: "", sort: "name", scope: "trash",
        mediaKind: "all", stackId: "st-1",
      }, { cursor: "cur-1", includeTotal: false });
      const stackUrl = new URL(calls[0], "http://127.0.0.1");
      assert.equal(stackUrl.pathname, "/api/asset-stacks/st-1/assets");
      assert.equal(stackUrl.searchParams.get("trash"), "1");
      assert.equal(stackUrl.searchParams.get("includeTotal"), "0");
      assert.equal(stackUrl.searchParams.get("cursor"), "cur-1");
      assert.equal(stackUrl.searchParams.get("view"), null, "stack members are the raw collection");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("batch mutations", () => {
  it("surfaces a partial trash failure as counts, never as a full success", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 207,
      text: async () => JSON.stringify({
        results: [
          { id: "a", trashed: true },
          { id: "b", ok: false, error: "asset is pinned" },
        ],
        partial: true,
      }),
    });
    try {
      const outcome = await adapterModule.moveAssetsToTrash("default", ["a", "b"]);
      assert.deepEqual(outcome, {
        total: 2,
        succeeded: 1,
        failed: 1,
        failedIds: ["b"],
        firstError: "asset is pinned",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps a failed chunk from masking the others and never invents confirmations", async () => {
    const originalFetch = globalThis.fetch;
    const bodies = [];
    globalThis.fetch = async (input, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body.assetIds);
      if (body.assetIds.length === 1000) {
        // First chunk lands; second chunk dies at the transport level.
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            results: body.assetIds.map((id) => ({ id, trashed: true })),
          }),
        };
      }
      throw new Error("socket hung up");
    };
    try {
      const ids = Array.from({ length: 1001 }, (_, index) => `id-${index}`);
      const outcome = await adapterModule.moveAssetsToTrash("default", ids);
      assert.equal(bodies.length, 2, "the selection was submitted in chunks");
      assert.deepEqual(bodies[0].length, 1000);
      assert.deepEqual(bodies[1], ["id-1000"]);
      assert.equal(outcome.succeeded, 1000);
      assert.deepEqual(outcome.failedIds, ["id-1000"]);
      assert.equal(outcome.firstError, "socket hung up");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps silent for an empty batch", async () => {
    const originalFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = async () => { called += 1; throw new Error("must not fetch"); };
    try {
      await adapterModule.moveAssetsToTrash("default", []);
      await adapterModule.setAssetsGroup("default", [], "g");
      await adapterModule.setAssetsFavorite("default", [], true);
      await adapterModule.moveAssetsToStack("default", [], "st-1");
      assert.equal(called, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("feature parity API contracts", () => {
  it("exports all unique group pages and rejects repeated cursors", async () => {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url) => {
      const parsed = new URL(String(url), "http://localhost");
      calls.push(parsed);
      const cursor = parsed.searchParams.get("cursor");
      const payload = cursor === "next" ? { assets: [{ id: "b" }, { id: "c" }], page: { nextCursor: null } }
        : { assets: [{ id: "a" }, { id: "b" }], page: { nextCursor: "next" } };
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    };
    try {
      const results = await adapterModule.fetchRawGroupAssets("default", "灵感");
      assert.deepEqual(results.map(x => x.id), ["a", "b", "c"]);
      assert.equal(calls[0].searchParams.get("group"), "灵感");
      assert.equal(calls[1].searchParams.get("cursor"), "next");
      globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ assets: [], page: { nextCursor: "loop" } }) });
      await assert.rejects(adapterModule.fetchRawGroupAssets("default", "group"), /pagination stalled/);
    } finally { globalThis.fetch = original; }
  });

  it("uses explicit user-confirmed generation relation endpoints", async () => {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method, body: JSON.parse(init.body || "{}") });
      return { ok: true, status: 200, text: async () => JSON.stringify({ relation: {}, candidate: {} }) };
    };
    try {
      const item = { childGenerationId: "child", parentGenerationId: "parent", relationType: "edited_from" };
      await adapterModule.createGenerationRelation("default", item);
      await adapterModule.editGenerationRelation("default", { ...item, previousRelationType: "derived_from" });
      await adapterModule.removeGenerationRelation("default", item);
      await adapterModule.dismissGenerationCandidate("default", "child", "parent");
      assert.deepEqual(calls.map(c => [c.method, c.url]), [
        ["POST", "/api/generation-relations"], ["PATCH", "/api/generation-relations"],
        ["DELETE", "/api/generation-relations"], ["PATCH", "/api/generation-relation-candidates"],
      ]);
      assert.equal(calls[0].body.verificationLevel, "user_confirmed");
      assert.equal(calls[0].body.evidence.user_confirmed_relation, true);
      assert.equal(calls[1].body.previousRelationType, "derived_from");
      assert.equal(calls[3].body.status, "dismissed");
    } finally { globalThis.fetch = original; }
  });
});

describe("i18n coverage", () => {
  it("every translated string in the React tree has a translation entry", async () => {
    const files = ["App.tsx", "ImageViewer.tsx", "ColumnControl.tsx"];
    const used = new Set();
    for (const file of files) {
      const source = await readFile(join(uiRoot, "src", file), "utf8");
      for (const match of source.matchAll(/(?:tr|translate|notify)\("([^"]+)"/g)) {
        used.add(match[1]);
      }
    }
    assert.ok(used.size >= 40, `expected a substantial translated surface, found ${used.size}`);
    const i18nSource = await readFile(join(uiRoot, "src", "i18n.ts"), "utf8");
    const missing = [...used].filter((key) => !new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}":`).test(i18nSource));
    assert.deepEqual(missing, [], "every used string needs an English mapping (or the 新分组 regex)");
  });

  it("keeps the zh/en vocabularies free of empty mappings", async () => {
    const i18nSource = await readFile(join(uiRoot, "src", "i18n.ts"), "utf8");
    for (const match of i18nSource.matchAll(/"([^"]+)":\s*"([^"]*)"/g)) {
      assert.ok(match[2].length > 0, `empty English mapping for "${match[1]}"`);
    }
  });
});

describe("the built shell", () => {
  it("references only same-origin hashed bundles and the design favicon", async () => {
    const shell = await readFile(join(uiRoot, "dist", "index.html"), "utf8");
    for (const match of shell.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const url = match[1];
      const allowed = url.startsWith("/assets/") || url === "/favicon.svg";
      assert.ok(allowed, `every shell reference must be same-origin root-absolute: ${url}`);
    }
    assert.match(shell, /<div id="root"><\/div>/, "React mounts into #root");
  });
});
