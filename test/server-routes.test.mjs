import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { removeTestPath as rm, deferTestPathRemoval } from "./test-cleanup.mjs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import sharp from "sharp";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";

test("returns 404 for a missing library image without stopping the server", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-server-"));
  const sessionsDir = join(root, "sessions");
  const detectedProject = join(root, "detected-project");
  const workdirOnlyProject = join(root, "workdir-only-project");
  await mkdir(join(detectedProject, "canvas"), { recursive: true });
  await mkdir(join(workdirOnlyProject, "canvas"), { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(detectedProject, "canvas", "cowart-view-state.json"), "{}\n", "utf8");
  await writeFile(join(workdirOnlyProject, "canvas", "cowart-view-state.json"), "{}\n", "utf8");
  // Session 1: has turn_context.cwd + JS-call-style start-canvas.sh
  await writeFile(join(sessionsDir, "cowart-open.jsonl"), [
    JSON.stringify({ type: "turn_context", payload: { cwd: detectedProject } }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        arguments: `const result = await tools.exec_command({cmd:"./scripts/start-canvas.sh ${detectedProject}",workdir:"${detectedProject}"});`,
      },
    }),
  ].join("\n") + "\n");
  // Session 2: NO turn_context.cwd -- project dir only in structured JSON workdir.
  await writeFile(join(sessionsDir, "workdir-only.jsonl"), [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        arguments: JSON.stringify({
          cmd: "./scripts/start-canvas.sh",
          workdir: workdirOnlyProject,
        }),
      },
    }),
  ].join("\n") + "\n");
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOSA_PORT: "0",
      MOSA_PROJECT_DIR: root,
      MOSA_LIBRARY_DIR: join(root, "library"),
      CODEX_GENERATED_IMAGES_DIR: join(root, "generated-images"),
      CODEX_SESSIONS_DIR: sessionsDir,
      GROK_SESSIONS_DIR: join(root, "grok-sessions"),
      COWART_MOSA_CANVAS_DIR: join(root, "cowart-data"),
      MOSA_COWART_REGISTRY_PATH: join(root, "state", "cowart-projects.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });

  const port = await waitForServerPort(server);
  await waitForServer(port, server);
  const home = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(home.status, 200);
  assert.equal(home.headers.get("content-security-policy"), "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: https://i.pinimg.com; media-src 'self' blob:; connect-src 'self'");

  const unknownApi = await fetch(`http://127.0.0.1:${port}/api/not-a-route`);
  assert.equal(unknownApi.status, 404);
  assert.deepEqual(await unknownApi.json(), { error: "Not found" });

  for (const retiredPath of [
    "/api/diagnostics",
    "/api/codex-bridge",
    "/api/grok-bridge",
    "/api/cowart-bridge",
    "/api/ingest-suppressions",
  ]) {
    const retired = await fetch(`http://127.0.0.1:${port}${retiredPath}`);
    assert.equal(retired.status, 404, `${retiredPath} must stay retired`);
  }
  const retiredSuppressionDelete = await fetch(`http://127.0.0.1:${port}/api/ingest-suppressions`, { method: "DELETE" });
  assert.equal(retiredSuppressionDelete.status, 404, "suppression management must not be exposed over HTTP");

  // Traversal-shaped static requests carry an extension and must 404 as
  // themselves: the SPA fallback only applies to extensionless routes, and a
  // missing/escaped .mjs must never be answered with app-shell HTML.
  const traversal = await rawGet(port, "/%2e%2e/server.mjs");
  assert.equal(traversal.statusCode, 404);
  assert.doesNotMatch(traversal.body, /import \{ createServer \} from "node:http"/);

  const missingImage = await fetch(`http://127.0.0.1:${port}/library/default/images/does-not-exist.png`);
  assert.equal(missingImage.status, 404);
  assert.deepEqual(await missingImage.json(), { error: "Asset not found" });

  const bridgeStatus = await waitForBridgeEnabled(port, server, "grok");
  assert.equal(bridgeStatus.status, 200);
  const bridges = await bridgeStatus.json();
  assert.equal(bridges.grok?.enabled, true);
  assert.equal(typeof bridges.grok?.sessionsDir, "string");
  assert.equal(bridges.webCapture?.enabled, false);
  assert.equal(bridges.webCapture?.tokenConfigured, false);
  assert.equal(bridges.webCapture?.originConfigured, false);
  assert.ok(Array.isArray(bridges.webCapture?.providers));
  assert.equal(server.exitCode, null);

  await waitForBridgeEnabled(port, server, "cowartDiscovery");

  const webCaptureStatus = await fetch(`http://127.0.0.1:${port}/api/web-capture`);
  assert.equal(webCaptureStatus.status, 200);
  assert.equal((await webCaptureStatus.json()).bridge?.enabled, false);

  const disabledWebCapture = await fetch(`http://127.0.0.1:${port}/api/ingest/web-capture`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(disabledWebCapture.status, 503);
  assert.deepEqual(await disabledWebCapture.json(), {
    error: "Web capture is disabled until MOSA_WEB_CAPTURE_TOKEN is configured.",
    code: "WEB_CAPTURE_DISABLED",
  });

  const automaticallyDetected = await fetch(`http://127.0.0.1:${port}/api/cowart-canvases`);
  assert.equal(automaticallyDetected.status, 200);
  const detectedCanvases = (await automaticallyDetected.json()).canvases;
  const canonicalDetectedProject = await realpath(detectedProject);
  const canonicalWorkdirOnlyProject = await realpath(workdirOnlyProject);
  assert.equal(detectedCanvases.length, 3);
  assert.equal(detectedCanvases.some((canvas) => canvas.projectDir === canonicalDetectedProject), true);
  assert.equal(detectedCanvases.some((canvas) => canvas.projectDir === canonicalWorkdirOnlyProject), true);

  // External registration requires a trusted Cowart canvas: an absolute path
  // without '..' segments whose existing canvas directory holds a real marker.
  const registryPath = join(root, "state", "cowart-projects.json");
  const registryBeforeRejectedPosts = await readFile(registryPath, "utf8");
  const emptyProject = join(root, "empty-project");
  await mkdir(emptyProject, { recursive: true });
  const noMarkerProject = join(root, "no-marker-project");
  await mkdir(join(noMarkerProject, "canvas"), { recursive: true });
  // A canvas symlinked into an outside directory holding real markers: stat()
  // would follow it, so the trust check must reject it via lstat().
  const externalCanvas = join(root, "external-canvas");
  await mkdir(externalCanvas, { recursive: true });
  await writeFile(join(externalCanvas, "cowart-view-state.json"), "{}\n", "utf8");
  const symlinkedProject = join(root, "symlinked-project");
  await mkdir(symlinkedProject, { recursive: true });
  await symlink(externalCanvas, join(symlinkedProject, "canvas"), "dir");
  const rejectedRegistrations = [
    ["relative path", "relative/project", "COWART_PROJECT_PATH_NOT_ABSOLUTE"],
    ["missing projectDir", null, "COWART_PROJECT_PATH_REQUIRED"],
    ["raw '..' segments", `${root}/detected-project/../other-project`, "COWART_PROJECT_PATH_UNSAFE"],
    ["missing directory", join(root, "missing-project"), "COWART_CANVAS_DIR_MISSING"],
    ["empty directory", emptyProject, "COWART_CANVAS_DIR_MISSING"],
    ["canvas without markers", noMarkerProject, "COWART_CANVAS_NO_MARKERS"],
    ["symlinked canvas", symlinkedProject, "COWART_CANVAS_SYMLINK"],
  ];
  for (const [name, projectDir, code] of rejectedRegistrations) {
    const rejected = await fetch(`http://127.0.0.1:${port}/api/cowart-canvases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(projectDir === null ? {} : { projectDir }),
    });
    assert.equal(rejected.status, 400, `expected a 4xx for ${name}`);
    assert.equal((await rejected.json()).code, code, `expected ${code} for ${name}`);
  }
  assert.equal(await readFile(registryPath, "utf8"), registryBeforeRejectedPosts, "rejected registrations must not write the registry");
  assert.equal(existsSync(join(emptyProject, "canvas")), false, "rejected registrations must not create canvas directories");
  assert.deepEqual(await readdir(externalCanvas), ["cowart-view-state.json"], "rejected registrations must not write into an external canvas");
  const unchangedCanvases = await fetch(`http://127.0.0.1:${port}/api/cowart-canvases`);
  assert.equal((await unchangedCanvases.json()).canvases.length, 3);

  const otherProject = join(root, "other-project");
  await mkdir(join(otherProject, "canvas"), { recursive: true });
  await writeFile(join(otherProject, "canvas", "cowart-view-state.json"), "{}\n", "utf8");
  const canonicalOtherProject = await realpath(otherProject);
  const addCanvas = await fetch(`http://127.0.0.1:${port}/api/cowart-canvases`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectDir: otherProject }),
  });
  assert.equal(addCanvas.status, 201);
  const added = await addCanvas.json();
  assert.equal(added.canvas.projectDir, canonicalOtherProject);
  assert.equal(added.canvas.canvasDir, join(canonicalOtherProject, "canvas"));

  const canvases = await fetch(`http://127.0.0.1:${port}/api/cowart-canvases`);
  assert.equal(canvases.status, 200);
  assert.equal((await canvases.json()).canvases.length, 4);

  const removeCanvas = await fetch(`http://127.0.0.1:${port}/api/cowart-canvases/${encodeURIComponent(added.canvas.id)}`, { method: "DELETE" });
  assert.equal(removeCanvas.status, 200);
  assert.equal((await removeCanvas.json()).canvas.id, added.canvas.id);
});

test("SQLite HTTP surface paginates assets and serves durable derivatives", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-server-sqlite-"));
  const libraryDir = join(root, "library");
  const imagePath = join(root, "generated-images", "fixture.png");
  const replacementPath = join(root, "replacement.png");
  await mkdir(join(root, "generated-images"), { recursive: true });
  await sharp({ create: { width: 8, height: 8, channels: 4, background: "#243047" } }).png().toFile(imagePath);
  await sharp({ create: { width: 8, height: 8, channels: 4, background: "#c43d38" } }).png().toFile(replacementPath);
  const seeded = createSqliteAssetStore({ projectRoot: root, managerDir: process.cwd(), libraryDir });
  const asset = await seeded.createAsset({ assetId: "sqlite-fixture", imagePath, prompt: "red mechanical future city" });
  await seeded.setMigrationState("completed", { test: true });
  seeded.close();

  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOSA_PORT: "0",
      MOSA_PROJECT_DIR: root,
      MOSA_LIBRARY_DIR: libraryDir,
      CODEX_GENERATED_IMAGES_DIR: join(root, "generated-images"),
      CODEX_SESSIONS_DIR: join(root, "sessions"),
      GROK_SESSIONS_DIR: join(root, "grok-sessions"),
      COWART_MOSA_CANVAS_DIR: join(root, "cowart-data"),
      MOSA_COWART_REGISTRY_PATH: join(root, "state", "cowart-projects.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  const port = await waitForServerPort(server);
  await waitForServer(port, server);
  const assets = await fetch(`http://127.0.0.1:${port}/api/assets?project=default&limit=1`);
  assert.equal(assets.status, 200);
  const page = await assets.json();
  assert.equal(page.page.total, 1);
  assert.equal(page.assets[0].id, asset.id);
  const thumbnail = await waitForResponse(`http://127.0.0.1:${port}/library/default/thumbnails/${asset.id}.webp`);
  assert.equal(thumbnail.status, 200);
  assert.equal(thumbnail.headers.get("content-type"), "image/webp");

  const duplicate = await fetch(`http://127.0.0.1:${port}/api/assets/default/${asset.id}/duplicate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assetId: "sqlite-copy" }) });
  assert.equal(duplicate.status, 201);
  const copied = (await duplicate.json()).asset;
  assert.equal(copied.parent_asset_id, null);

  const bypassVersionContract = await fetch(`http://127.0.0.1:${port}/api/assets/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "default", assetId: "bypass-version-contract", imagePath: replacementPath, parent_asset_id: asset.id }),
  });
  assert.equal(bypassVersionContract.status, 400);
  assert.equal((await bypassVersionContract.json()).code, "INVALID_VERSION_CHANGE");

  const invalidVersion = await fetch(`http://127.0.0.1:${port}/api/assets/default/${asset.id}/versions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version_change: " " }),
  });
  assert.equal(invalidVersion.status, 400);
  assert.equal((await invalidVersion.json()).code, "INVALID_VERSION_CHANGE");

  const versionResponse = await fetch(`http://127.0.0.1:${port}/api/assets/default/${asset.id}/versions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assetId: "sqlite-version", imagePath: replacementPath, version_change: "Brighter palette", theme: "Daylight" }),
  });
  assert.equal(versionResponse.status, 201);
  const version = (await versionResponse.json()).asset;
  assert.equal(version.parent_asset_id, asset.id);
  assert.equal(version.version_change, "Brighter palette");
  assert.equal(version.theme, "Daylight");
  assert.equal(version.source.path, replacementPath);
  const versionImage = await fetch(`http://127.0.0.1:${port}${version.image_url}`);
  assert.equal(versionImage.status, 200);
  assert.deepEqual(Buffer.from(await versionImage.arrayBuffer()), await readFile(replacementPath));

  const historyResponse = await fetch(`http://127.0.0.1:${port}/api/assets/default/${version.id}/versions`);
  assert.equal(historyResponse.status, 200);
  const history = (await historyResponse.json()).history;
  assert.equal(history.root_asset_id, asset.id);
  assert.equal(history.selected_asset_id, version.id);
  assert.deepEqual(history.versions.map((item) => item.id), [asset.id, version.id]);

  const recipeResponse = await fetch(`http://127.0.0.1:${port}/api/assets/default/${asset.id}/recipes`);
  assert.equal(recipeResponse.status, 200);
  const recipeHistory = (await recipeResponse.json()).history;
  assert.equal(recipeHistory.asset_id, asset.id);
  assert.equal(recipeHistory.snapshots.length, 1);
  assert.equal(recipeHistory.snapshots[0].effective_prompt, "red mechanical future city");
  assert.equal(recipeHistory.active_snapshot_id, recipeHistory.snapshots[0].snapshot_id);

  const missingHistory = await fetch(`http://127.0.0.1:${port}/api/assets/default/missing/versions`);
  assert.equal(missingHistory.status, 404);
  assert.equal((await missingHistory.json()).code, "ASSET_NOT_FOUND");

  const missingRecipeHistory = await fetch(`http://127.0.0.1:${port}/api/assets/default/missing/recipes`);
  assert.equal(missingRecipeHistory.status, 404);
  assert.equal((await missingRecipeHistory.json()).code, "ASSET_NOT_FOUND");

  const immutableRelation = await fetch(`http://127.0.0.1:${port}/api/assets/default/${version.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parent_asset_id: null }),
  });
  assert.equal(immutableRelation.status, 400);
  assert.equal((await immutableRelation.json()).code, "VERSION_RELATION_IMMUTABLE");

  const archived = await fetch(`http://127.0.0.1:${port}/api/assets/default/${copied.id}/archive`, { method: "POST" });
  assert.equal(archived.status, 200);
});

test("invalid cursor returns 400 with INVALID_ASSET_CURSOR code", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-server-cursor-"));
  const libraryDir = join(root, "library");
  const imagePath = join(root, "generated-images", "cursor-test.png");
  await mkdir(join(root, "generated-images"), { recursive: true });
  await sharp({ create: { width: 4, height: 4, channels: 4, background: "#1a2b3c" } }).png().toFile(imagePath);
  const seeded = createSqliteAssetStore({ projectRoot: root, managerDir: process.cwd(), libraryDir });
  await seeded.createAsset({ assetId: "cursor-fixture", imagePath, prompt: "cursor test" });
  await seeded.setMigrationState("completed", { test: true });
  seeded.close();

  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOSA_PORT: "0",
      MOSA_PROJECT_DIR: root,
      MOSA_LIBRARY_DIR: libraryDir,
      CODEX_GENERATED_IMAGES_DIR: join(root, "generated-images"),
      CODEX_SESSIONS_DIR: join(root, "sessions"),
      GROK_SESSIONS_DIR: join(root, "grok-sessions"),
      COWART_MOSA_CANVAS_DIR: join(root, "cowart-data"),
      MOSA_COWART_REGISTRY_PATH: join(root, "state", "cowart-projects.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  const port = await waitForServerPort(server);
  await waitForServer(port, server);

  const invalidBase64 = Buffer.from('{"wrong":"field"}').toString("base64url");
  const invalidCursorResponse = await fetch(`http://127.0.0.1:${port}/api/assets?cursor=${invalidBase64}`);
  assert.equal(invalidCursorResponse.status, 400);
  const invalidCursorBody = await invalidCursorResponse.json();
  assert.equal(invalidCursorBody.code, "INVALID_ASSET_CURSOR");
  assert.equal(typeof invalidCursorBody.error, "string");

  const garbageCursor = await fetch(`http://127.0.0.1:${port}/api/assets?cursor=!!!not-valid!!!`);
  assert.equal(garbageCursor.status, 400);
  const garbageBody = await garbageCursor.json();
  assert.equal(garbageBody.code, "INVALID_ASSET_CURSOR");

  const validCursorResponse = await fetch(`http://127.0.0.1:${port}/api/assets?limit=1`);
  assert.equal(validCursorResponse.status, 200);
  const validPage = await validCursorResponse.json();
  assert.ok(validPage.page);

  const zeroLimitResponse = await fetch(`http://127.0.0.1:${port}/api/assets?limit=0`);
  assert.equal(zeroLimitResponse.status, 200);
  const zeroLimitPage = await zeroLimitResponse.json();
  assert.equal(zeroLimitPage.page.limit, 100, "public API must not turn limit=0 into an unbounded SQLite query");

  assert.equal(server.exitCode, null);
});

test("request body errors return correct HTTP status codes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-server-body-"));
  const libraryDir = join(root, "library");
  const imagePath = join(root, "generated-images", "body-test.png");
  await mkdir(join(root, "generated-images"), { recursive: true });
  await sharp({ create: { width: 4, height: 4, channels: 4, background: "#4d5e6f" } }).png().toFile(imagePath);
  const seeded = createSqliteAssetStore({ projectRoot: root, managerDir: process.cwd(), libraryDir });
  await seeded.setMigrationState("completed", { test: true });
  seeded.close();

  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOSA_PORT: "0",
      MOSA_PROJECT_DIR: root,
      MOSA_LIBRARY_DIR: libraryDir,
      CODEX_GENERATED_IMAGES_DIR: join(root, "generated-images"),
      CODEX_SESSIONS_DIR: join(root, "sessions"),
      GROK_SESSIONS_DIR: join(root, "grok-sessions"),
      COWART_MOSA_CANVAS_DIR: join(root, "cowart-data"),
      MOSA_COWART_REGISTRY_PATH: join(root, "state", "cowart-projects.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  const port = await waitForServerPort(server);
  await waitForServer(port, server);

  const invalidJsonResponse = await fetch(`http://127.0.0.1:${port}/api/assets/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not valid json!!!",
  });
  assert.equal(invalidJsonResponse.status, 400);
  const invalidJsonBody = await invalidJsonResponse.json();
  assert.equal(invalidJsonBody.code, "INVALID_JSON_BODY");
  assert.equal(typeof invalidJsonBody.error, "string");

  const hugePayload = "x".repeat(6 * 1024 * 1024);
  const tooLargeResponse = await fetch(`http://127.0.0.1:${port}/api/assets/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: hugePayload,
  });
  assert.equal(tooLargeResponse.status, 413);
  const tooLargeBody = await tooLargeResponse.json();
  assert.equal(tooLargeBody.code, "REQUEST_BODY_TOO_LARGE");
  assert.equal(typeof tooLargeBody.error, "string");

  const normalResponse = await fetch(`http://127.0.0.1:${port}/api/assets?project=default&limit=10`);
  assert.equal(normalResponse.status, 200);

  assert.equal(server.exitCode, null);
});

test("JSON backend invalid cursor returns 400 with INVALID_ASSET_CURSOR", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-json-cursor-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const { createAssetStore } = await import("../lib/asset-store.mjs");
  const libraryDir = join(root, "library");
  await mkdir(join(libraryDir, "assets", "default"), { recursive: true });
  await writeFile(join(libraryDir, "assets", "default", "groups.json"), "[]\n", "utf8");
  const store = createAssetStore({ projectRoot: root, managerDir: join(root, "mosa"), libraryDir });
  assert.equal(store.storageKind, "json");
  await store.ensureProject("default");

  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOSA_PORT: "0",
      MOSA_PROJECT_DIR: root,
      MOSA_LIBRARY_DIR: join(root, "library"),
      CODEX_GENERATED_IMAGES_DIR: join(root, "generated-images"),
      CODEX_SESSIONS_DIR: join(root, "sessions"),
      GROK_SESSIONS_DIR: join(root, "grok-sessions"),
      COWART_MOSA_CANVAS_DIR: join(root, "cowart-data"),
      MOSA_COWART_REGISTRY_PATH: join(root, "state", "cowart-projects.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await once(server, "exit");
    }
  });
  const port = await waitForServerPort(server);
  await waitForServer(port, server);

  const badCursor = Buffer.from('{"bad":true}').toString("base64url");
  const res = await fetch(`http://127.0.0.1:${port}/api/assets?cursor=${badCursor}`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, "INVALID_ASSET_CURSOR");

  const garbage = await fetch(`http://127.0.0.1:${port}/api/assets?cursor=!!!nope!!!`);
  assert.equal(garbage.status, 400);
  assert.equal((await garbage.json()).code, "INVALID_ASSET_CURSOR");
});

test("cross-origin request returns 403 while same-origin succeeds", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cors-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOSA_PORT: "0",
      MOSA_PROJECT_DIR: root,
      MOSA_LIBRARY_DIR: join(root, "library"),
      CODEX_GENERATED_IMAGES_DIR: join(root, "generated-images"),
      CODEX_SESSIONS_DIR: join(root, "sessions"),
      GROK_SESSIONS_DIR: join(root, "grok-sessions"),
      COWART_MOSA_CANVAS_DIR: join(root, "cowart-data"),
      MOSA_COWART_REGISTRY_PATH: join(root, "state", "cowart-projects.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await once(server, "exit");
    }
  });
  const port = await waitForServerPort(server);
  await waitForServer(port, server);

  const crossOrigin = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    headers: { origin: "https://example.com" },
  });
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(await crossOrigin.json(), { error: "Cross-origin requests are not allowed." });

  const sameOrigin = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    headers: { origin: `http://127.0.0.1:${port}` },
  });
  assert.equal(sameOrigin.status, 200);
  const projects = await sameOrigin.json();
  assert.ok(Array.isArray(projects.projects));
});

test("multi-byte UTF-8 body exceeding 5 MiB returns 413", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-multibyte-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOSA_PORT: "0",
      MOSA_PROJECT_DIR: root,
      MOSA_LIBRARY_DIR: join(root, "library"),
      CODEX_GENERATED_IMAGES_DIR: join(root, "generated-images"),
      CODEX_SESSIONS_DIR: join(root, "sessions"),
      GROK_SESSIONS_DIR: join(root, "grok-sessions"),
      COWART_MOSA_CANVAS_DIR: join(root, "cowart-data"),
      MOSA_COWART_REGISTRY_PATH: join(root, "state", "cowart-projects.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await once(server, "exit");
    }
  });
  const port = await waitForServerPort(server);
  await waitForServer(port, server);

  // Each Chinese character is 3 bytes in UTF-8 but 1 JS string length unit.
  // 2 MiB characters → 6 MiB bytes, well above the 5 MiB byte limit.
  const charCount = 2 * 1024 * 1024;
  const jsonBody = JSON.stringify({ prompt: "\u4f60\u597d".repeat(charCount) });
  const jsLen = jsonBody.length;
  const byteLen = Buffer.byteLength(jsonBody, "utf8");
  assert.ok(jsLen < 5 * 1024 * 1024, `JS string length ${jsLen} should be under 5 MiB`);
  assert.ok(byteLen > 5 * 1024 * 1024, `UTF-8 byte length ${byteLen} should exceed 5 MiB`);

  const res = await fetch(`http://127.0.0.1:${port}/api/assets/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: jsonBody,
  });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.code, "REQUEST_BODY_TOO_LARGE");
  assert.equal(typeof body.error, "string");

  const stillWorks = await fetch(`http://127.0.0.1:${port}/api/assets?project=default&limit=10`);
  assert.equal(stillWorks.status, 200);
});

async function waitForServerPort(server) {
  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");
  return new Promise((resolvePort, rejectPort) => {
    let output = "";
    let errorOutput = "";
    const timer = setTimeout(() => finish(new Error("Timed out waiting for MOSA server startup.")), 5000);
    const onOutput = (chunk) => {
      output += chunk;
      const match = /MOSA: http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (match) finish(null, Number(match[1]));
    };
    const onErrorOutput = (chunk) => { errorOutput += chunk; };
    const onExit = () => finish(new Error(`MOSA server exited during startup.${errorOutput ? `\n${errorOutput}` : ""}`));
    const finish = (error, port) => {
      clearTimeout(timer);
      server.stdout.off("data", onOutput);
      server.stderr.off("data", onErrorOutput);
      server.off("exit", onExit);
      if (error) rejectPort(error);
      else resolvePort(port);
    };
    server.stdout.on("data", onOutput);
    server.stderr.on("data", onErrorOutput);
    server.once("exit", onExit);
  });
}

async function waitForServer(port, server) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error("MOSA server exited during startup.");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/bridges`);
      if (response.ok) return;
    } catch {
      // The listener may not be ready yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("Timed out waiting for MOSA server startup.");
}

async function waitForBridgeEnabled(port, server, bridgeName) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error("MOSA server exited while integrations were starting.");
    const response = await fetch(`http://127.0.0.1:${port}/api/bridges`, {
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    if (response.ok) {
      const payload = await response.clone().json();
      if (payload?.[bridgeName]?.enabled === true) return response;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Timed out waiting for ${bridgeName} bridge startup.`);
}

async function waitForResponse(url) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await fetch(url);
    if (response.status !== 404) return response;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function rawGet(port, path) {
  return new Promise((resolveResponse, rejectResponse) => {
    const req = request({ host: "127.0.0.1", port, path }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolveResponse({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.once("error", rejectResponse);
    req.end();
  });
}

test("rejects non-loopback Host headers (DNS rebinding guard)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-host-guard-"));
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOSA_PORT: "0",
      MOSA_PROJECT_DIR: root,
      MOSA_LIBRARY_DIR: join(root, "library"),
      MOSA_DISABLE_BRIDGES: "codex,grok,cowart,cowartDiscovery",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  const port = await waitForServerPort(server);
  await waitForServer(port, server);

  const rawRequest = (hostHeader, path) => new Promise((resolveResponse, rejectResponse) => {
    const req = request({ host: "127.0.0.1", port, path, headers: hostHeader ? { host: hostHeader } : {} }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolveResponse({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", rejectResponse);
    req.end();
  });

  // DNS-rebinding style request: loopback IP, attacker-controlled Host.
  const rebinding = await rawRequest(`attacker.example:${port}`, "/api/health");
  assert.equal(rebinding.statusCode, 403, "a foreign Host on the loopback listener must be rejected");
  assert.match(rebinding.body, /Forbidden host/);

  const wrongPort = await rawRequest(`127.0.0.1:${port + 1}`, "/api/health");
  assert.equal(wrongPort.statusCode, 403, "a Host naming a different port must be rejected");

  const loopback = await rawRequest(`127.0.0.1:${port}`, "/api/health");
  assert.equal(loopback.statusCode, 200, "the canonical loopback Host keeps working");
  const localhost = await rawRequest(`localhost:${port}`, "/api/health");
  assert.equal(localhost.statusCode, 200, "localhost Host keeps working");
});

test("JSON write routes reject non-object bodies with 400 INVALID_JSON_BODY_TYPE instead of 500", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-null-body-"));
  const clientToken = "0".repeat(64);
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOSA_PORT: "0",
      MOSA_PROJECT_DIR: root,
      MOSA_LIBRARY_DIR: join(root, "library"),
      MOSA_DISABLE_BRIDGES: "codex,grok,cowart,cowartDiscovery",
      MOSA_CLIENT_TOKEN: clientToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrOutput = "";
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => { stderrOutput += chunk; });
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  const port = await waitForServerPort(server);
  await waitForServer(port, server);

  const postJson = (method, path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "x-mosa-client-token": clientToken },
    body,
  });

  const probes = [
    ["POST", "/api/groups"],
    ["POST", "/api/assets/batch"],
    ["PATCH", "/api/assets/default/no-such-asset"],
    ["POST", "/api/asset-stacks"],
    ["PATCH", "/api/group-order"],
    ["POST", "/api/open-folder"],
  ];
  for (const [method, path] of probes) {
    for (const rawBody of ["null", "123", '"x"']) {
      const response = await postJson(method, path, rawBody);
      const payload = await response.json();
      assert.equal(response.status, 400, `${method} ${path} body=${rawBody} must be a 400`);
      assert.equal(payload.code, "INVALID_JSON_BODY_TYPE", `${method} ${path} body=${rawBody} must carry the type error code`);
      assert.match(payload.error, /Request body must be a JSON object/);
    }
  }

  // An absent body still normalizes to {} — the routes keep their existing
  // validation behavior for empty bodies.
  const emptyBatch = await postJson("POST", "/api/assets/batch", "");
  assert.deepEqual(await emptyBatch.json(), { error: "Unknown batch action: undefined" });
  const emptyGroups = await postJson("POST", "/api/groups", "");
  assert.equal(emptyGroups.status, 400);
  assert.equal((await emptyGroups.json()).code, "GROUP_NAME_REQUIRED");

  assert.ok(!stderrOutput.includes("MOSA request failed"), "no probe may reach the 500 failure logger");
});
