import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { once } from "node:events";
import { access, mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pipeStreamToResponse } from "../lib/http-response.mjs";
import { createAssetStore } from "../lib/asset-store.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { processDerivativeJob } from "../lib/derivative-worker.js";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import sharp from "sharp";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function runtimeOptions(root, overrides = {}) {
  const libraryDir = join(root, "library");
  return {
    port: 0,
    projectRoot: root,
    managerDir: repositoryRoot,
    cowartProjectDir: join(root, "desktop-data"),
    appDir: join(repositoryRoot, "web", "gravityport", "dist"),
    libraryDir,
    assetsRoot: join(libraryDir, "assets"),
    generatedImagesDir: join(root, "generated-images"),
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "codex-sessions"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-canvas"),
    cowartRegistryPath: join(root, "state", "cowart-projects.json"),
    ...overrides,
  };
}

async function makeTemporaryRoot(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  return root;
}

function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

test("turns a reference stream error into 500 without taking down the HTTP server", async (t) => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    if (requests > 1) {
      res.end("healthy");
      return;
    }

    const stream = new PassThrough();
    res.statusCode = 200;
    res.setHeader("content-type", "image/png");
    pipeStreamToResponse(stream, res, {
      errorPayload: { error: "Reference attachment unavailable" },
    });
    queueMicrotask(() => stream.destroy(new Error("reference file disappeared")));
  });
  await listen(server);
  t.after(() => close(server));

  const failed = await fetch(`http://127.0.0.1:${server.address().port}/library/default/references/missing.png`);
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: "Reference attachment unavailable" });

  const healthy = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  assert.equal(healthy.status, 200);
  assert.equal(await healthy.text(), "healthy");
});

test("starts, identifies itself, stops idempotently, and restarts", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-runtime-");
  const options = runtimeOptions(root);
  const first = await startMosaRuntime(options);
  t.after(() => first.stop());

  assert.equal(first.storage, "sqlite");
  const response = await fetch(`${first.url}/api/health`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.product, "mosa");
  // Task 314: the public health payload carries the library digest, never
  // the library path.
  assert.equal(typeof health.libraryDigest, "string");
  assert.ok(health.libraryDigest.length > 0, "the library digest must be present");
  assert.ok(!("libraryDir" in health), "health must not leak the library path");
  assert.ok(!JSON.stringify(health).includes(resolve(options.libraryDir)), "no absolute library path may appear in health");
  assert.equal(health.storage, "sqlite");
  assert.equal(typeof health.productVersion, "string");
  assert.equal(typeof health.gitSha, "string");
  assert.equal(typeof health.uiFingerprint, "string");
  // The served shell is the built React bundle: the hashed module must come
  // back as JavaScript, and a missing flat asset must stay a 404 instead of
  // the SPA fallback handing out HTML for a script request.
  const shell = await (await fetch(`${first.url}/`)).text();
  const bundlePath = /src="(\/assets\/[^"]+\.js)"/.exec(shell)?.[1];
  assert.ok(bundlePath, "the built shell must reference a hashed js bundle");
  const bundle = await fetch(`${first.url}${bundlePath}`);
  assert.equal(bundle.status, 200);
  assert.equal(bundle.headers.get("content-type"), "text/javascript; charset=utf-8");
  const missingScript = await fetch(`${first.url}/app.mjs`);
  assert.equal(missingScript.status, 404);
  const authHeaders = { "x-mosa-client-token": first.clientToken };
  const bridges = await (await fetch(`${first.url}/api/bridges`, { headers: authHeaders })).json();
  assert.equal(bridges.cowart.sources[0].projectDir, options.cowartProjectDir);
  assert.equal(typeof bridges.codex.watchingImages, "boolean");
  assert.equal(typeof bridges.codex.watchingSessions, "boolean");
  assert.equal(typeof bridges.codex.pendingSessionResults, "number");
  assert.equal(typeof bridges.codex.lastSessionBytesRead, "number");

  await first.stop();
  await first.stop();

  const second = await startMosaRuntime(options);
  try {
    assert.notEqual(second.port, 0);
    assert.equal((await fetch(`${second.url}/api/health`)).status, 200);
  } finally {
    await second.stop();
  }
});

test("CODEX_HOME drives every default Codex-owned runtime source consistently", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-runtime-codex-home-");
  const codexHome = join(root, "codex-home");
  const options = runtimeOptions(root, {
    codexImagesDir: undefined,
    codexSessionsDir: undefined,
    cowartCanvasDir: undefined,
    cowartRegistryPath: undefined,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_GENERATED_IMAGES_DIR: undefined,
      CODEX_SESSIONS_DIR: undefined,
      COWART_MOSA_CANVAS_DIR: undefined,
      MOSA_COWART_REGISTRY_PATH: undefined,
    },
  });
  const runtime = await startMosaRuntime(options);
  t.after(() => runtime.stop());

  const authHeaders = { "x-mosa-client-token": runtime.clientToken };
  const bridges = await (await fetch(`${runtime.url}/api/bridges`, { headers: authHeaders })).json();
  const library = await (await fetch(`${runtime.url}/api/library-path`, { headers: authHeaders })).json();
  assert.equal(bridges.codex.imagesDir, join(codexHome, "generated_images"));
  assert.equal(bridges.codex.sessionsDir, join(codexHome, "sessions"));
  assert.equal(library.codexGeneratedImagesDir, join(codexHome, "generated_images"));
  assert.equal(bridges.cowart.sources[0].canvasDir, join(codexHome, "cowart-data", "mosa"));
});

test("management mutations reject callers without the runtime capability", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-runtime-client-auth-");
  const runtime = await startMosaRuntime(runtimeOptions(root));
  t.after(() => runtime.stop());

  const response = await fetch(`${runtime.url}/api/assets/batch`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mosa-client-token": "" },
    body: JSON.stringify({ action: "favorite", assetIds: ["missing"] }),
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: "Unauthorized GravityPort client.",
    code: "MOSA_CLIENT_UNAUTHORIZED",
  });
});

test("first-party browser HTML no longer mints the capability; client-session does", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-runtime-browser-auth-");
  const runtime = await startMosaRuntime(runtimeOptions(root));
  t.after(() => runtime.stop());

  // Task 314: an HTML GET (root or SPA fallback) hands out NO cookie — a
  // stolen HTML response must not carry a writable capability.
  const page = await fetch(`${runtime.url}/`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("set-cookie"), null, "GET / must not set the capability cookie");
  const fallback = await fetch(`${runtime.url}/some/spa/route`);
  assert.equal(fallback.status, 200);
  assert.equal(fallback.headers.get("set-cookie"), null, "SPA fallback must not set the capability cookie");

  // The renderer proves the credential and exchanges it for the cookie.
  // (Explicit empty headers pin "no credential": the clean-test-env wrapper
  // preserves them instead of injecting the shared test token.)
  const unauthorized = await fetch(`${runtime.url}/api/client-session`, {
    method: "POST",
    headers: { "x-mosa-client-token": "" },
  });
  assert.equal(unauthorized.status, 401);
  const cookieOnly = await fetch(`${runtime.url}/api/client-session`, {
    method: "POST",
    // The explicit empty header pins "no credential"; the clean-test-env
    // wrapper preserves it instead of injecting the shared test token.
    headers: { cookie: `mosa-browser-client-${runtime.port}=whatever`, "x-mosa-client-token": "" },
  });
  assert.equal(cookieOnly.status, 401, "the cookie itself must not count as a credential here");
  const session = await fetch(`${runtime.url}/api/client-session`, {
    method: "POST",
    headers: { "x-mosa-client-token": runtime.clientToken },
  });
  assert.equal(session.status, 204);
  const setCookie = session.headers.get("set-cookie") || "";
  assert.match(setCookie, new RegExp(`^mosa-browser-client-${runtime.port}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Strict$`));
  const browserCookie = setCookie.split(";", 1)[0];

  const mutation = await fetch(`${runtime.url}/api/assets/batch`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: browserCookie,
      "x-mosa-client-token": "stale-renderer-token",
    },
    body: JSON.stringify({ action: "group", projectId: "default", assetIds: ["missing"], group: "" }),
  });
  assert.notEqual(mutation.status, 401);
  // Reads are behind the capability too (task 314); the cookie authorizes
  // them, and an explicitly empty header proves the bare request is refused
  // (the clean-test-env wrapper would otherwise inject the shared token).
  const read = await fetch(`${runtime.url}/api/assets?project=default`, { headers: { cookie: browserCookie } });
  assert.equal(read.status, 200);
  const readWithout = await fetch(`${runtime.url}/api/assets?project=default`, {
    headers: { "x-mosa-client-token": "" },
  });
  assert.equal(readWithout.status, 401);
});

test("runtime shutdown closes active library event streams before waiting for HTTP drain", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-runtime-sse-shutdown-");
  const runtime = await startMosaRuntime(runtimeOptions(root));
  t.after(() => runtime.stop());

  const response = await fetch(`${runtime.url}/api/library-events?project=default`, {
    headers: { "x-mosa-client-token": runtime.clientToken },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);

  await Promise.race([
    runtime.stop(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("runtime stop was blocked by the active SSE response")), 2000)),
  ]);
  const final = await reader.read();
  assert.equal(final.done, true);
});

test("requests on an existing connection receive 503 while runtime ownership drains", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-runtime-draining-request-");
  const runtime = await startMosaRuntime(runtimeOptions(root));
  t.after(() => runtime.stop());
  const socket = createConnection({ host: "127.0.0.1", port: runtime.port });
  t.after(() => socket.destroy());
  await once(socket, "connect");
  socket.write(`GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${runtime.port}\r\n`);
  await new Promise((done) => setTimeout(done, 10));
  let response = "";
  socket.on("data", (chunk) => { response += chunk.toString(); });
  const ended = once(socket, "end");
  const stopped = runtime.stop();
  socket.end("\r\n");
  await ended;
  await stopped;
  assert.match(response, /^HTTP\/1\.1 503/);
  assert.match(response, /GravityPort runtime is shutting down/);
});

test("an explicit runtime libraryDir keeps detected legacy JSON assets in place", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-runtime-explicit-library-");
  const options = runtimeOptions(root);
  // Let the store derive assetsRoot from the explicit libraryDir instead of the
  // desktop-style override used by the shared fixture options.
  delete options.assetsRoot;
  await mkdir(join(options.libraryDir, "assets", "default"), { recursive: true });
  await writeFile(join(options.libraryDir, "assets", "default", "groups.json"), "[]\n", "utf8");
  const runtime = await startMosaRuntime(options);
  t.after(() => runtime.stop());

  assert.equal(runtime.storage, "json");
  const library = await (await fetch(`${runtime.url}/api/library-path`, { headers: { "x-mosa-client-token": runtime.clientToken } })).json();
  assert.equal(library.storage, "json");
  assert.equal(library.libraryDir, options.libraryDir);
  assert.equal(library.path, join(options.libraryDir, "assets", "default"));
});

test("rejects a second runtime in the same process", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-runtime-singleton-");
  const runtime = await startMosaRuntime(runtimeOptions(root));
  t.after(() => runtime.stop());

  await assert.rejects(
    startMosaRuntime(runtimeOptions(join(root, "other-library"))),
    /already active in this process/,
  );
});

test("releases the library lock when listener startup fails", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-runtime-rollback-");
  const portOwner = createServer((_req, res) => res.end("not mosa"));
  await listen(portOwner);
  t.after(() => close(portOwner));
  const address = portOwner.address();
  assert.equal(typeof address, "object");

  const options = runtimeOptions(root, { port: address.port });
  await assert.rejects(startMosaRuntime(options), /EADDRINUSE/);

  await close(portOwner);
  const runtime = await startMosaRuntime(runtimeOptions(root));
  try {
    assert.equal((await fetch(`${runtime.url}/api/health`)).status, 200);
  } finally {
    await runtime.stop();
  }
});

test("runtime listens before delayed optional integrations start", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-runtime-fast-core-");
  const startedAt = performance.now();
  const runtime = await startMosaRuntime(runtimeOptions(root, {
    bridgeStartupDelayMs: 5000,
    maintenanceStartDelayMs: 5000,
  }));
  t.after(() => runtime.stop());
  const readyMs = performance.now() - startedAt;
  assert.ok(readyMs < 1000, `core runtime readiness took ${readyMs.toFixed(1)}ms while optional integrations were delayed`);
  assert.equal((await fetch(`${runtime.url}/api/health`)).status, 200);
  const bridges = await (await fetch(`${runtime.url}/api/bridges`, { headers: { "x-mosa-client-token": runtime.clientToken } })).json();
  assert.equal(bridges.codex.enabled, false);
  assert.equal(bridges.grok.enabled, false);
  assert.equal(bridges.cowart.enabled, false);
});

test("a host bridge gate holds optional integrations until the desktop releases it", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-runtime-bridge-gate-");
  let releaseGate;
  const bridgeStartupGate = new Promise((resolveGate) => { releaseGate = resolveGate; });
  const runtime = await startMosaRuntime(runtimeOptions(root, {
    bridgeStartupDelayMs: 0,
    maintenanceStartDelayMs: 5000,
    bridgeStartupGate,
  }));
  t.after(() => runtime.stop());
  const bridges = async () => (await fetch(`${runtime.url}/api/bridges`, { headers: { "x-mosa-client-token": runtime.clientToken } })).json();
  await new Promise((resolveWait) => setTimeout(resolveWait, 400));
  assert.equal((await bridges()).codex.enabled, false, "bridges wait for the host gate");
  releaseGate();
  const deadline = Date.now() + 5000;
  while (!(await bridges()).codex.enabled) {
    assert.ok(Date.now() < deadline, "bridges start once the host releases the gate");
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
});

test("bridge startup failures do not block the local library runtime", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-runtime-bridge-rollback-");
  const options = runtimeOptions(root, { bridgeStartupDelayMs: 0 });
  await mkdir(join(root, "state"), { recursive: true });
  await writeFile(options.cowartRegistryPath, "not-json", "utf8");

  const runtime = await startMosaRuntime(options);
  try {
    assert.equal((await fetch(`${runtime.url}/api/health`)).status, 200);
    assert.equal((await fetch(`${runtime.url}/`)).status, 200);
  } finally {
    await runtime.stop();
  }

  await writeFile(options.cowartRegistryPath, '{"version":1,"projects":[]}\n', "utf8");
  const restarted = await startMosaRuntime(options);
  try {
    assert.equal((await fetch(`${restarted.url}/api/health`)).status, 200);
  } finally {
    await restarted.stop();
  }
});

test("historical orphan derivative sweep is post-listen maintenance and the worker starts after it settles", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-runtime-orphan-sweep-");
  const libraryDir = join(root, "library");
  const sourcesDir = join(root, "project", "generated-images");
  await mkdir(sourcesDir, { recursive: true });
  const sourcePath = join(sourcesDir, "seed.png");
  await sharp({ create: { width: 96, height: 64, channels: 3, background: { r: 30, g: 120, b: 200 } } }).png().toFile(sourcePath);
  const store = createSqliteAssetStore({
    projectRoot: join(root, "project"),
    managerDir: join(root, "project", "mosa"),
    libraryDir,
    initializeFreshLibrary: true,
  });
  await store.createAsset({ projectId: "default", assetId: "seed-asset", imagePath: sourcePath, prompt: "seed" }, { ingestMode: "manual" });
  for (;;) {
    const job = await store.claimDerivativeJob();
    if (!job) break;
    assert.equal((await processDerivativeJob(store, job)).ok, true);
  }
  const projectDir = join(libraryDir, "assets", "default");
  const stale = new Date(Date.now() - 60 * 60 * 1000);
  const orphanPaths = [];
  for (const dir of ["previews", "mediums", "thumbnails"]) {
    for (let index = 0; index < 40; index += 1) {
      const orphanPath = join(projectDir, dir, "orphan-" + index + ".webp");
      await writeFile(orphanPath, "orphan");
      await utimes(orphanPath, stale, stale);
      orphanPaths.push(orphanPath);
    }
  }
  t.after(() => store.close());
  const runtime = await startMosaRuntime(runtimeOptions(root));
  t.after(() => runtime.stop());
  assert.equal((await fetch(runtime.url + "/api/health")).status, 200, "startup serves before maintenance matters");
  const fileExists = async (filePath) => access(filePath).then(() => true, () => false);
  const sweepDeadline = Date.now() + 15000;
  let orphansRemaining = -1;
  do {
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    orphansRemaining = 0;
    for (const orphanPath of orphanPaths) if (await fileExists(orphanPath)) orphansRemaining += 1;
  } while (orphansRemaining > 0 && Date.now() < sweepDeadline);
  assert.equal(orphansRemaining, 0, "historical orphans must be reclaimed after startup without blocking it");
  assert.equal(await fileExists(join(projectDir, "thumbnails", "seed-asset.webp")), true, "referenced derivatives are never touched by the sweep");
  // Distinct bytes from seed.png: identical bytes now skip as
  // already-in-library instead of creating the second asset.
  const postSweepPath = join(sourcesDir, "post-sweep.png");
  await sharp({ create: { width: 96, height: 64, channels: 3, background: { r: 60, g: 100, b: 180 } } }).png().toFile(postSweepPath);
  const create = await fetch(runtime.url + "/api/assets/create", {
    method: "POST",
    headers: { "content-type": "application/json", "x-mosa-client-token": runtime.clientToken },
    body: JSON.stringify({ projectId: "default", assetId: "post-sweep-asset", imagePath: postSweepPath, prompt: "after sweep" }),
  });
  assert.equal(create.status, 200);
  const thumbnailDeadline = Date.now() + 15000;
  let thumbnailExists = false;
  while (Date.now() < thumbnailDeadline) {
    thumbnailExists = await fileExists(join(projectDir, "thumbnails", "post-sweep-asset.webp"));
    if (thumbnailExists) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  assert.equal(thumbnailExists, true, "derivative worker must generate new derivatives after the sweep settled");
});

test("shutdown awaits the in-flight orphan sweep without leaking it", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-runtime-orphan-shutdown-");
  const libraryDir = join(root, "library");
  // A completed library first: the runtime must open a real library (it may
  // no longer initialize one inside a directory that already holds media).
  const seedStore = createAssetStore({ projectRoot: root, managerDir: root, libraryDir, explicitLibraryDir: libraryDir });
  seedStore.close();
  const projectDir = join(libraryDir, "assets", "default");
  await mkdir(join(projectDir, "previews"), { recursive: true });
  await mkdir(join(projectDir, "mediums"), { recursive: true });
  await mkdir(join(projectDir, "thumbnails"), { recursive: true });
  const stale = new Date(Date.now() - 60 * 60 * 1000);
  for (const dir of ["previews", "mediums", "thumbnails"]) {
    for (let index = 0; index < 150; index += 1) {
      const orphanPath = join(projectDir, dir, "orphan-" + index + ".webp");
      await writeFile(orphanPath, "orphan");
      await utimes(orphanPath, stale, stale);
    }
  }
  const runtime = await startMosaRuntime(runtimeOptions(root));
  t.after(() => runtime.stop());
  assert.equal((await fetch(runtime.url + "/api/health")).status, 200);
  await runtime.stop();
  await assert.rejects(fetch(runtime.url + "/api/health", { signal: AbortSignal.timeout(2000) }));
});
