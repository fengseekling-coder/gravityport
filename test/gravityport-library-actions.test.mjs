// GravityPort library-actions (trash + stack) tests.
//
// Mock-fetch tests: replace globalThis.fetch to verify request format.
// Real-server tests: use startMosaRuntime + direct fetch calls to verify
// end-to-end behavior without depending on the library-actions module loading
// its own copy of globalThis.fetch.
//
// Module compilation follows gravityport-interaction.test.mjs pattern.
import { execFileSync } from "node:child_process";
import { rm, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");

// Save the true native fetch once before any test can touch it.
const ORIGINAL_FETCH = globalThis.fetch;

// ---------------------------------------------------------------------------
// TypeScript compilation (shared across mock tests)
// ---------------------------------------------------------------------------
let la; // library-actions exports

before(async () => {
  const compileRoot = await mkdtemp(join(tmpdir(), "mosa-gp-la-"));
  const sources = [
    join(uiRoot, "src", "mosa-api.ts"),
    join(uiRoot, "src", "library-actions.ts"),
  ];
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    ...sources,
    "--outDir", compileRoot,
    "--module", "esnext",
    "--target", "es2022",
    "--moduleResolution", "bundler",
    "--skipLibCheck",
  ], { stdio: "pipe" });
  la = await import(join(compileRoot, "library-actions.js"));
  after(async () => {
    await rm(compileRoot, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==",
  "base64",
);

function mutationHeaders(runtime) {
  return { "content-type": "application/json", "x-mosa-client-token": runtime.clientToken };
}

// ---------------------------------------------------------------------------
// Mock-fetch unit tests
// ---------------------------------------------------------------------------

describe("restoreAssets — mock fetch", () => {
  it("posts to the correct per-asset URL with project in the path", async () => {
    const calls = [];
    globalThis.fetch = function (url, opts) {
      calls.push({ url, method: opts.method, body: opts.body });
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    try {
      await la.restoreAssets("myproject", ["id-a", "id-b"]);
      assert.equal(calls.length, 2);
      assert.equal(calls[0].method, "POST");
      assert.equal(calls[0].url, "/api/assets/myproject/id-a/restore");
      assert.equal(calls[1].url, "/api/assets/myproject/id-b/restore");
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });

  it("returns partial success when the middle item fails", async () => {
    let callIndex = 0;
    globalThis.fetch = function (url) {
      callIndex++;
      if (callIndex === 2) {
        const err = new Error("server error");
        err.code = "ASSET_TRASH_RESTORE_UNAVAILABLE";
        return Promise.reject(err);
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    try {
      const result = await la.restoreAssets("default", ["a", "b", "c"]);
      assert.equal(result.total, 3);
      assert.equal(result.succeeded, 2);
      assert.equal(result.failed, 1);
      assert.deepEqual(result.failedIds, ["b"]);
      assert.equal(result.firstError, "server error");
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });

  it("deduplicates repeated ids", async () => {
    const calls = [];
    globalThis.fetch = function (url) {
      calls.push(url);
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    try {
      await la.restoreAssets("p", ["x", "x", "y", "x"]);
      assert.equal(calls.length, 2, "only unique ids should be requested");
      assert.ok(calls.every((u) => u.includes("p/")));
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });
});

describe("permanentlyDeleteAssets — mock fetch", () => {
  it("DELETE to the correct per-asset URL", async () => {
    const calls = [];
    globalThis.fetch = function (url, opts) {
      calls.push({ url, method: opts.method });
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    try {
      await la.permanentlyDeleteAssets("proj", ["dead-1", "dead-2"]);
      assert.equal(calls.length, 2);
      assert.equal(calls[0].method, "DELETE");
      assert.equal(calls[0].url, "/api/assets/proj/dead-1/permanent");
      assert.equal(calls[1].url, "/api/assets/proj/dead-2/permanent");
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });

  it("surfaces the first error message correctly", async () => {
    let callIndex = 0;
    globalThis.fetch = function (url) {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "in use", code: "ASSET_IN_USE" }), { status: 409 }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    try {
      const result = await la.permanentlyDeleteAssets("p", ["a", "b"]);
      assert.equal(result.total, 2);
      assert.equal(result.succeeded, 1);
      assert.equal(result.failed, 1);
      assert.deepEqual(result.failedIds, ["a"]);
      assert.equal(result.firstError, "in use");
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });
});

describe("emptyTrash — mock fetch", () => {
  it("DELETE /api/trash with projectId in body", async () => {
    let captured;
    globalThis.fetch = function (url, opts) {
      captured = { url, method: opts.method, body: opts.body };
      return Promise.resolve(
        new Response(JSON.stringify({ removed: 7, failed: [] }), { status: 200 }),
      );
    };
    try {
      await la.emptyTrash("test-project");
      assert.equal(captured.url, "/api/trash");
      assert.equal(captured.method, "DELETE");
      const parsed = JSON.parse(captured.body);
      assert.equal(parsed.projectId, "test-project");
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });
});

describe("createStack — mock fetch", () => {
  it("POST /api/asset-stacks with projectId, assetIds, and optional coverAssetId", async () => {
    let captured;
    globalThis.fetch = function (url, opts) {
      captured = { url, method: opts.method, body: opts.body };
      return Promise.resolve(
        new Response(JSON.stringify({ stack: { id: "s1", name: "My Stack", count: 3 } }), {
          status: 201,
        }),
      );
    };
    try {
      const result = await la.createStack("proj", ["a", "b", "c"], "a");
      assert.equal(captured.url, "/api/asset-stacks");
      assert.equal(captured.method, "POST");
      const parsed = JSON.parse(captured.body);
      assert.equal(parsed.projectId, "proj");
      assert.deepEqual(parsed.assetIds, ["a", "b", "c"]);
      assert.equal(parsed.coverAssetId, "a");
      assert.deepEqual(result, { id: "s1", name: "My Stack", count: 3 });
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });

  it("omits coverAssetId when not provided", async () => {
    let captured;
    globalThis.fetch = function (url, opts) {
      captured = JSON.parse(opts.body);
      return Promise.resolve(
        new Response(JSON.stringify({ stack: { id: "s1", name: "", count: 2 } }), { status: 201 }),
      );
    };
    try {
      await la.createStack("p", ["a", "b"]);
      assert.equal(captured.coverAssetId, undefined);
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });
});

describe("renameStack — mock fetch", () => {
  it("PATCH /api/asset-stacks/{id} with projectId and name, trims whitespace", async () => {
    let captured;
    globalThis.fetch = function (url, opts) {
      captured = { url, method: opts.method, body: opts.body };
      return Promise.resolve(
        new Response(JSON.stringify({ stack: { id: "s1", name: "trimmed", count: 2 } }), {
          status: 200,
        }),
      );
    };
    try {
      const result = await la.renameStack("p", "s1", "  trimmed  ");
      assert.equal(captured.url, "/api/asset-stacks/s1");
      assert.equal(captured.method, "PATCH");
      const parsed = JSON.parse(captured.body);
      assert.equal(parsed.projectId, "p");
      assert.equal(parsed.name, "trimmed");
      assert.equal(result.name, "trimmed");
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });

  it("throws synchronously and sends no request when name is empty after trimming", async () => {
    let called = false;
    globalThis.fetch = function () { called = true; return Promise.resolve(new Response("{}")); };
    try {
      assert.throws(() => la.renameStack("p", "s1", "   "), { message: /empty/i });
      assert.equal(called, false, "no request should be sent for an empty name");
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });

  it("throws synchronously when name is only whitespace", async () => {
    globalThis.fetch = ORIGINAL_FETCH;
    assert.throws(() => la.renameStack("p", "s1", "\t\n"), { message: /empty/i });
  });
});

describe("dissolveStack — mock fetch", () => {
  it("DELETE /api/asset-stacks/{id} with projectId", async () => {
    let captured;
    globalThis.fetch = function (url, opts) {
      captured = { url, method: opts.method, body: opts.body };
      return Promise.resolve(
        new Response(JSON.stringify({ assetIds: ["a", "b"] }), { status: 200 }),
      );
    };
    try {
      const result = await la.dissolveStack("proj", "s1");
      assert.equal(captured.url, "/api/asset-stacks/s1");
      assert.equal(captured.method, "DELETE");
      assert.equal(JSON.parse(captured.body).projectId, "proj");
      assert.deepEqual(result.assetIds, ["a", "b"]);
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });
});

describe("addAssetsToStack — mock fetch", () => {
  it("POST /api/asset-stacks/{id}/assets with projectId and assetIds", async () => {
    let captured;
    globalThis.fetch = function (url, opts) {
      captured = { url, method: opts.method, body: opts.body };
      return Promise.resolve(
        new Response(JSON.stringify({ stack: { id: "s1", name: "S", count: 4 } }), { status: 200 }),
      );
    };
    try {
      await la.addAssetsToStack("p", "s1", ["c", "d"]);
      assert.equal(captured.url, "/api/asset-stacks/s1/assets");
      assert.equal(captured.method, "POST");
      const parsed = JSON.parse(captured.body);
      assert.equal(parsed.projectId, "p");
      assert.deepEqual(parsed.assetIds, ["c", "d"]);
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });
});

describe("removeAssetsFromStack — mock fetch", () => {
  it("DELETE /api/asset-stacks/{id}/assets with projectId and assetIds", async () => {
    let captured;
    globalThis.fetch = function (url, opts) {
      captured = { url, method: opts.method, body: opts.body };
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    try {
      await la.removeAssetsFromStack("p", "s1", ["x"]);
      assert.equal(captured.url, "/api/asset-stacks/s1/assets");
      assert.equal(captured.method, "DELETE");
      const parsed = JSON.parse(captured.body);
      assert.equal(parsed.projectId, "p");
      assert.deepEqual(parsed.assetIds, ["x"]);
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });
});

describe("reorderStack — mock fetch", () => {
  it("PATCH /api/asset-stacks/{id}/order with projectId and assetIds", async () => {
    let captured;
    globalThis.fetch = function (url, opts) {
      captured = { url, method: opts.method, body: opts.body };
      return Promise.resolve(
        new Response(JSON.stringify({ stack: { id: "s1", name: "S", count: 3 } }), { status: 200 }),
      );
    };
    try {
      await la.reorderStack("p", "s1", ["z", "y", "x"]);
      assert.equal(captured.url, "/api/asset-stacks/s1/order");
      assert.equal(captured.method, "PATCH");
      const parsed = JSON.parse(captured.body);
      assert.equal(parsed.projectId, "p");
      assert.deepEqual(parsed.assetIds, ["z", "y", "x"]);
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });
});

describe("assignStackToGroup — mock fetch", () => {
  it("POST /api/asset-stacks/{id}/group with projectId and group", async () => {
    let captured;
    globalThis.fetch = function (url, opts) {
      captured = { url, method: opts.method, body: opts.body };
      return Promise.resolve(
        new Response(JSON.stringify({ stack: { id: "s1", name: "S", count: 2 } }), { status: 200 }),
      );
    };
    try {
      await la.assignStackToGroup("p", "s1", "Landscapes");
      const parsed = JSON.parse(captured.body);
      assert.equal(parsed.projectId, "p");
      assert.equal(parsed.group, "Landscapes");
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });

  it("passes empty string to ungroup a stack", async () => {
    let captured;
    globalThis.fetch = function (url, opts) {
      captured = JSON.parse(opts.body);
      return Promise.resolve(
        new Response(JSON.stringify({ stack: { id: "s1", name: "S", count: 2 } }), { status: 200 }),
      );
    };
    try {
      await la.assignStackToGroup("p", "s1", "");
      assert.equal(captured.group, "");
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });
});

describe("listStackMemberIds — mock fetch", () => {
  it("polls through multiple pages and returns all ids", async () => {
    let callCount = 0;
    globalThis.fetch = function () {
      callCount++;
      const cursor = callCount === 1 ? "cursor-page-2" : "";
      return Promise.resolve(
        new Response(
          JSON.stringify({
            assets: [{ id: `asset-page-${callCount}` }],
            page: { nextCursor: cursor || null },
          }),
          { status: 200 },
        ),
      );
    };
    try {
      const ids = await la.listStackMemberIds("p", "s1");
      assert.equal(callCount, 2);
      assert.deepEqual(ids, ["asset-page-1", "asset-page-2"]);
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });

  it("throws on repeated cursor (loop guard)", async () => {
    globalThis.fetch = function () {
      return Promise.resolve(
        new Response(
          JSON.stringify({ assets: [{ id: "x" }], page: { nextCursor: "same-cursor" } }),
          { status: 200 },
        ),
      );
    };
    try {
      await la.listStackMemberIds("p", "s1");
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(/cursor/i.test(err.message));
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });

  it("uses limit=250 and project query param", async () => {
    let capturedUrl;
    globalThis.fetch = function (url) {
      capturedUrl = url;
      return Promise.resolve(
        new Response(JSON.stringify({ assets: [], page: { nextCursor: null } }), { status: 200 }),
      );
    };
    try {
      await la.listStackMemberIds("my-proj", "stack-id");
      assert.ok(capturedUrl.includes("limit=250"));
      assert.ok(capturedUrl.includes("project=my-proj"));
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });
});

describe("trashStack — mock fetch", () => {
  it("enumerates members then calls moveAssetsToTrash (/api/assets/batch)", async () => {
    let callCount = 0;
    globalThis.fetch = function (url, opts) {
      callCount++;
      if (url.includes("/api/asset-stacks/")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ assets: [{ id: "m1" }, { id: "m2" }], page: { nextCursor: null } }),
            { status: 200 },
          ),
        );
      }
      assert.ok(url.includes("/api/assets/batch"));
      const body = JSON.parse(opts.body);
      assert.equal(body.action, "trash");
      assert.deepEqual(body.assetIds, ["m1", "m2"]);
      return Promise.resolve(
        new Response(
          JSON.stringify({ results: [{ id: "m1", ok: true }, { id: "m2", ok: true }] }),
          { status: 200 },
        ),
      );
    };
    try {
      const result = await la.trashStack("p", "s1");
      assert.equal(callCount, 2);
      assert.equal(result.total, 2);
      assert.equal(result.succeeded, 2);
      assert.equal(result.failed, 0);
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });

  it("returns empty outcome when stack has no members", async () => {
    globalThis.fetch = function () {
      return Promise.resolve(
        new Response(JSON.stringify({ assets: [], page: { nextCursor: null } }), { status: 200 }),
      );
    };
    try {
      const result = await la.trashStack("p", "s1");
      assert.deepEqual(result, { total: 0, succeeded: 0, failed: 0, failedIds: [], firstError: "" });
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });
});

// ---------------------------------------------------------------------------
// Real-server integration tests
// Uses direct fetch calls (not the library-actions module) to avoid ESM
// module-level fetch binding issues. Each test gets its own runtime via
// describe/beforeEach/afterEach lifecycle.
// ---------------------------------------------------------------------------

import { startMosaRuntime } from "../lib/mosa-runtime.mjs";

async function startLibraryActionsRuntime() {
  const root = await mkdtemp(join(tmpdir(), "mosa-la-rt-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const generated = join(root, "generated-images");
  await mkdir(generated, { recursive: true });
  for (const id of ["a", "b", "c", "d", "e", "p", "q", "r", "x", "y"]) {
    await writeFile(join(generated, `${id}.png`), ONE_PIXEL_PNG);
  }

  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: root,
    libraryDir: join(root, "library"),
    generatedImagesDir: generated,
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "sessions"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-data"),
    cowartRegistryPath: join(root, "state", "cowart-projects.json"),
  });

  const create = async (id, extra = {}) => {
    const response = await fetch(`${runtime.url}/api/assets/create`, {
      method: "POST",
      headers: mutationHeaders(runtime),
      body: JSON.stringify({
        projectId: "default",
        assetId: id,
        imagePath: join(generated, `${id}.png`),
        prompt: `prompt ${id}`,
        ...extra,
      }),
    });
    if (response.status !== 200) {
      const body = await response.text();
      assert.equal(response.status, 200, `create ${id} failed: ${response.status} ${body}`);
    }
    return (await response.json()).asset;
  };

  return { runtime, create, generated };
}

// Helper: poll through a stack's members using direct server API.
async function listMembersViaApi(runtime, stackId) {
  const ids = [];
  let cursor = "";
  for (;;) {
    const params = new URLSearchParams({ project: "default", limit: "250" });
    if (cursor) params.set("cursor", cursor);
    const resp = await fetch(
      `${runtime.url}/api/asset-stacks/${encodeURIComponent(stackId)}/assets?${params}`,
      { headers: mutationHeaders(runtime) },
    );
    const data = await resp.json();
    if (Array.isArray(data.assets)) {
      for (const asset of data.assets) {
        if (asset.id) ids.push(asset.id);
      }
    }
    cursor = data.page?.nextCursor ? String(data.page.nextCursor) : "";
    if (!cursor) break;
  }
  return ids;
}

describe("library-actions — real server end-to-end", () => {
  let runtime, create;

  beforeEach(async () => {
    const r = await startLibraryActionsRuntime();
    runtime = r.runtime;
    create = r.create;
  });

  afterEach(async () => {
    if (runtime) await runtime.stop();
  });

  it("full stack lifecycle: create → rename → reorder → group → add → remove → trash → restore", async () => {
    await create("a");
    await create("b");
    await create("c");
    await create("d");

    // Step 1 — create stack with 3 assets
    let resp = await fetch(`${runtime.url}/api/asset-stacks`, {
      method: "POST",
      headers: mutationHeaders(runtime),
      body: JSON.stringify({ projectId: "default", assetIds: ["a", "b", "c"], coverAssetId: "a" }),
    });
    assert.equal(resp.status, 201);
    const raw = await resp.json();
    const stack = raw.stack; // Server returns { stack: {...} }
    assert.ok(stack.id, "stack should have an id");
    assert.equal(stack.count, 3);

    // Verify members
    const members1 = await listMembersViaApi(runtime, stack.id);
    assert.deepEqual(members1.sort(), ["a", "b", "c"]);

    // Step 2 — rename
    resp = await fetch(`${runtime.url}/api/asset-stacks/${encodeURIComponent(stack.id)}`, {
      method: "PATCH",
      headers: mutationHeaders(runtime),
      body: JSON.stringify({ projectId: "default", name: "My Renamed Stack" }),
    });
    assert.equal(resp.status, 200);
    const renamed = (await resp.json()).stack;
    assert.equal(renamed.name, "My Renamed Stack");

    // Step 3 — reorder (reverse order)
    resp = await fetch(`${runtime.url}/api/asset-stacks/${encodeURIComponent(stack.id)}/order`, {
      method: "PATCH",
      headers: mutationHeaders(runtime),
      body: JSON.stringify({ projectId: "default", assetIds: ["c", "b", "a"] }),
    });
    assert.equal(resp.status, 200);
    const reordered = (await resp.json()).stack;
    assert.equal(reordered.count, 3);
    const afterReorder = await listMembersViaApi(runtime, stack.id);
    assert.deepEqual(afterReorder, ["c", "b", "a"]);

    // Step 4 — assign to group
    resp = await fetch(`${runtime.url}/api/asset-stacks/${encodeURIComponent(stack.id)}/group`, {
      method: "POST",
      headers: mutationHeaders(runtime),
      body: JSON.stringify({ projectId: "default", group: "Landscapes" }),
    });
    assert.equal(resp.status, 200);
    const grouped = (await resp.json()).stack;
    assert.equal(grouped.id, stack.id, "grouped stack should have same id");
    // assignAssetStackToGroup returns {id, group, assetIds, partial} — no count

    // Step 5 — remove 'b' from stack
    resp = await fetch(`${runtime.url}/api/asset-stacks/${encodeURIComponent(stack.id)}/assets`, {
      method: "DELETE",
      headers: mutationHeaders(runtime),
      body: JSON.stringify({ projectId: "default", assetIds: ["b"] }),
    });
    assert.equal(resp.status, 200);
    const removeResult = await resp.json();
    // removeAssetsFromStack returns { stack: {...}, removed, ... } not just the stack
    const afterRemove = await listMembersViaApi(runtime, stack.id);
    assert.deepEqual(afterRemove.sort(), ["a", "c"]);

    // Step 6 — add 'b' back
    resp = await fetch(`${runtime.url}/api/asset-stacks/${encodeURIComponent(stack.id)}/assets`, {
      method: "POST",
      headers: mutationHeaders(runtime),
      body: JSON.stringify({ projectId: "default", assetIds: ["b"] }),
    });
    assert.equal(resp.status, 200);
    const afterAdd = (await resp.json()).stack;
    assert.equal(afterAdd.count, 3);

    // Step 7 — trash entire stack (move members to trash via batch)
    resp = await fetch(`${runtime.url}/api/assets/batch`, {
      method: "POST",
      headers: mutationHeaders(runtime),
      body: JSON.stringify({ action: "trash", projectId: "default", assetIds: ["a", "b", "c"] }),
    });
    assert.equal(resp.status, 200);
    const batchData = await resp.json();
    assert.equal(batchData.results.length, 3);

    // Step 8 — restore all three (multi-select restore)
    for (const id of ["a", "b", "c"]) {
      resp = await fetch(`${runtime.url}/api/assets/default/${encodeURIComponent(id)}/restore`, {
        method: "POST",
        headers: mutationHeaders(runtime),
      });
      assert.equal(resp.status, 200, `restore ${id} should succeed`);
    }

    // Verify members are back in the stack
    const afterRestore = await listMembersViaApi(runtime, stack.id);
    assert.deepEqual(afterRestore.sort(), ["a", "b", "c"]);
  });

  it("stack dissolve: assets survive, no longer in a stack", async () => {
    await create("x");
    await create("y");

    // Create stack
    let resp = await fetch(`${runtime.url}/api/asset-stacks`, {
      method: "POST",
      headers: mutationHeaders(runtime),
      body: JSON.stringify({ projectId: "default", assetIds: ["x", "y"] }),
    });
    assert.equal(resp.status, 201);
    const stack = (await resp.json()).stack;
    assert.equal(stack.count, 2);

    // Dissolve
    resp = await fetch(`${runtime.url}/api/asset-stacks/${encodeURIComponent(stack.id)}`, {
      method: "DELETE",
      headers: mutationHeaders(runtime),
      body: JSON.stringify({ projectId: "default" }),
    });
    assert.equal(resp.status, 200);
    const dissolved = await resp.json();
    assert.deepEqual(dissolved.assetIds.sort(), ["x", "y"]);

    // Members should still exist but no longer in a stack
    const members = await listMembersViaApi(runtime, stack.id);
    assert.equal(members.length, 0, "dissolved stack should have no members");
  });

  it("multi-select permanent delete + empty trash", async () => {
    await create("p");
    await create("q");
    await create("r");

    // Move 2 assets to trash
    let resp = await fetch(`${runtime.url}/api/assets/batch`, {
      method: "POST",
      headers: mutationHeaders(runtime),
      body: JSON.stringify({ action: "trash", projectId: "default", assetIds: ["p", "q"] }),
    });
    assert.equal(resp.status, 200);
    const batch1 = await resp.json();
    assert.equal(batch1.results.length, 2);

    // Multi-select permanent delete (p and q)
    for (const id of ["p", "q"]) {
      resp = await fetch(`${runtime.url}/api/assets/default/${encodeURIComponent(id)}/permanent`, {
        method: "DELETE",
        headers: mutationHeaders(runtime),
      });
      assert.equal(resp.status, 200, `permanent delete ${id} should succeed`);
    }

    // Move 1 more asset to trash
    resp = await fetch(`${runtime.url}/api/assets/batch`, {
      method: "POST",
      headers: mutationHeaders(runtime),
      body: JSON.stringify({ action: "trash", projectId: "default", assetIds: ["r"] }),
    });
    assert.equal(resp.status, 200);

    // Empty trash
    resp = await fetch(`${runtime.url}/api/trash`, {
      method: "DELETE",
      headers: mutationHeaders(runtime),
      body: JSON.stringify({ projectId: "default" }),
    });
    assert.equal(resp.status, 200);
    const emptyResult = await resp.json();
    assert.ok(typeof emptyResult.removed === "number");
    assert.equal(emptyResult.removed, 1, "emptyTrash should remove 1 asset");
  });
});
