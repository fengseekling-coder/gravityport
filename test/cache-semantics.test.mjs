import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { DISABLEABLE_BRIDGES } from "../lib/runtime-bridges.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { mp4Bytes } from "./helpers/managed-media.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

test("static resource cache semantics: no-cache for UI files and immutable for library images", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cache-semantics-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  // Use a completely different library path to avoid conflicts with real user library
  const isolatedLibraryDir = join(root, "isolated-test-library");

  const runtime = await startMosaRuntime({
    projectRoot: root,
    managerDir: repositoryRoot,
    cowartProjectDir: join(root, "desktop-data"),
    appDir: join(repositoryRoot, "web", "gravityport", "dist"),
    assetsRoot: join(isolatedLibraryDir, "assets"),
    generatedImagesDir: join(root, "generated-images"),
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "codex-sessions"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-canvas"),
    port: 0,
    disabledBridges: [...DISABLEABLE_BRIDGES],
    // Force isolated library dir to prevent lock conflicts with user's real library
    libraryDir: isolatedLibraryDir,
  });
  t.after(() => runtime.stop());

  await t.test("GET / returns Cache-Control: no-cache, must-revalidate", async () => {
    const res = await fetch(`${runtime.url}/`);
    assert.equal(res.status, 200);
    const cc = res.headers.get("cache-control");
    assert.ok(cc?.includes("no-cache"), `Cache-Control should include 'no-cache', got: ${cc}`);
    assert.ok(cc?.includes("must-revalidate"), `Cache-Control should include 'must-revalidate', got: ${cc}`);
  });

  await t.test("GET /assets/* hashed bundles return same no-cache policy", async () => {
    const shell = await (await fetch(`${runtime.url}/`)).text();
    const bundlePath = /src="(\/assets\/[^"]+\.js)"/.exec(shell)?.[1];
    assert.ok(bundlePath, "the built shell must reference a hashed js bundle");
    const res = await fetch(`${runtime.url}${bundlePath}`);
    assert.equal(res.status, 200);
    const cc = res.headers.get("cache-control");
    assert.ok(cc?.includes("no-cache"), `JS should have no-cache, got: ${cc}`);
    assert.ok(cc?.includes("must-revalidate"), `JS should have must-revalidate, got: ${cc}`);
    const cssPath = /href="(\/assets\/[^"]+\.css)"/.exec(shell)?.[1];
    assert.ok(cssPath, "the built shell must reference a hashed css bundle");
    const css = await fetch(`${runtime.url}${cssPath}`);
    assert.equal(css.status, 200);
    assert.ok(css.headers.get("cache-control")?.includes("no-cache"), "CSS should have no-cache");
  });

  await t.test("GET /nonexistent.html falls back to index with same cache policy", async () => {
    const res = await fetch(`${runtime.url}/nonexistent-page`);
    assert.equal(res.status, 200);
    const cc = res.headers.get("cache-control");
    assert.ok(cc?.includes("no-cache"), `SPA fallback should have no-cache, got: ${cc}`);
    assert.ok(cc?.includes("must-revalidate"), `SPA fallback should have must-revalidate, got: ${cc}`);
  });

  await t.test("library images use immutable long-term cache when served", async () => {
    // Create the fixture image and import it through the runtime's own API so
    // the asset is served by the same store instance that backs /library/*.
    // Task 377: the hex string this used to hand-roll was one nibble short of
    // a whole file (odd length), so Buffer.from chopped the IEND CRC's last
    // byte — the head-only sniff tolerated it, the PNG tail check correctly
    // refuses it. A real 1×1 PNG keeps the test's intent.
    const fixtureImagePath = join(root, "fixture-cache.png");
    const TINY_PNG = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==",
      "base64",
    );
    await writeFile(fixtureImagePath, TINY_PNG);

    const createRes = await fetch(`${runtime.url}/api/assets/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ asset: "cache-test-fixture", imagePath: fixtureImagePath }),
    });
    assert.equal(createRes.status, 200, "fixture asset creation should succeed");
    const created = (await createRes.json()).asset;

    const res = await fetch(`${runtime.url}${created.image_url}`);
    assert.equal(res.status, 200, "library image should be served");
    const cc = res.headers.get("cache-control");
    assert.ok(cc?.includes("immutable"), `Library image should be immutable, got: ${cc}`);
    assert.ok(cc?.includes("max-age=31536000"), `Library image should have long max-age, got: ${cc}`);
  });

  await t.test("library media supports byte ranges and exact content length", async () => {
    // The library route is shared by images and videos. A video-shaped fixture
    // exercises the extension/mime path without requiring a valid decoder payload.
    const fixtureVideoPath = join(root, "fixture-range.mp4");
    const VIDEO_BYTES = mp4Bytes(7, 64);
    await writeFile(fixtureVideoPath, VIDEO_BYTES);

    const createRes = await fetch(`${runtime.url}/api/assets/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ asset: "range-test-fixture.mp4", imagePath: fixtureVideoPath }),
    });
    assert.equal(createRes.status, 200, "video fixture asset creation should succeed");
    const created = (await createRes.json()).asset;

    const full = await fetch(`${runtime.url}${created.image_url}`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.equal(full.headers.get("content-length"), String(VIDEO_BYTES.length));
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), VIDEO_BYTES);

    const partial = await fetch(`${runtime.url}${created.image_url}`, { headers: { Range: "bytes=10-19" } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("accept-ranges"), "bytes");
    assert.equal(partial.headers.get("content-range"), `bytes 10-19/${VIDEO_BYTES.length}`);
    assert.equal(partial.headers.get("content-length"), "10");
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), VIDEO_BYTES.subarray(10, 20));

    const suffix = await fetch(`${runtime.url}${created.image_url}`, { headers: { Range: "bytes=-8" } });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers.get("content-range"), `bytes 56-63/${VIDEO_BYTES.length}`);
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), VIDEO_BYTES.subarray(56));

    const invalid = await fetch(`${runtime.url}${created.image_url}`, { headers: { Range: "bytes=999-1000" } });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get("content-range"), `bytes */${VIDEO_BYTES.length}`);
  });
});
