// Learning-library route tests (task 459). Starts the real runtime
// (startMosaRuntime) against a temporary library and exercises all seven
// routes for success and failure, plus the boundary the task pins down: the
// browser-extension token never reaches these routes (they are not in
// bridge-routes' WEB_CAPTURE_API_PATHS, so the client-token gate covers them
// exactly like every other non-public API path).
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { isWebCaptureApiPath } from "../lib/api/bridge-routes.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

const CLIENT_TOKEN = "learning-library-client-token-0123456789abcdef";
const CAPTURE_TOKEN = "learning-library-capture-token-0123456789abcdef";

function request(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let payload = null;
        try { payload = JSON.parse(raw); } catch { payload = raw; }
        resolveRequest({ status: response.statusCode, payload });
      });
    });
    req.on("error", rejectRequest);
    if (body !== undefined) {
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      req.setHeader("content-length", String(Buffer.byteLength(payload)));
      req.write(payload);
    }
    req.end();
  });
}

test("learning-library routes answer per contract and stay out of the extension allowlist", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-learning-routes-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: root,
    managerDir: repositoryRoot,
    appDir: join(repositoryRoot, "web", "gravityport", "dist"),
    libraryDir: join(root, "library"),
    assetsRoot: join(root, "library", "assets"),
    generatedImagesDir: join(root, "generated-images"),
    clientToken: CLIENT_TOKEN,
    webCaptureToken: CAPTURE_TOKEN,
  });
  t.after(() => runtime.stop());
  const port = runtime.port;
  const authed = { "x-mosa-client-token": CLIENT_TOKEN, "content-type": "application/json" };

  // ── The extension boundary: no token, a bare bearer, and the extension's
  // own token all bounce off the client-token gate with 401. ──
  const noToken = await request(port, "/api/learning-libraries?project=default");
  assert.equal(noToken.status, 401);
  assert.equal(noToken.payload.code, "MOSA_CLIENT_UNAUTHORIZED");
  const bearerToken = await request(port, "/api/learning-libraries?project=default", {
    headers: { authorization: `Bearer ${CAPTURE_TOKEN}` },
  });
  assert.equal(bearerToken.status, 401);
  const captureTokenHeader = await request(port, "/api/learning-libraries?project=default", {
    headers: { "x-mosa-client-token": CAPTURE_TOKEN },
  });
  assert.equal(captureTokenHeader.status, 401);
  // None of the new paths may sit in the capture allowlist (lib/api/bridge-routes.mjs).
  for (const path of ["/api/learning-libraries", "/api/learning-libraries/ll_x", "/api/learning-libraries/ll_x/members"]) {
    assert.equal(isWebCaptureApiPath(path), false, `${path} must not be a web-capture path`);
  }

  // ── GET list: empty at first ──
  const emptyList = await request(port, "/api/learning-libraries?project=default", { headers: authed });
  assert.equal(emptyList.status, 200);
  assert.deepEqual(emptyList.payload.learningLibraries, []);

  // ── POST create: 201 with the library; empty name 400; duplicate 409 ──
  const created = await request(port, "/api/learning-libraries", {
    method: "POST", headers: authed, body: { projectId: "default", name: "海报风格" },
  });
  assert.equal(created.status, 201);
  const library = created.payload.library;
  assert.ok(library.id.startsWith("ll_"), `library id is ll_-prefixed: ${library.id}`);
  assert.equal(library.name, "海报风格");
  assert.equal(library.count, 0);
  const emptyName = await request(port, "/api/learning-libraries", {
    method: "POST", headers: authed, body: { projectId: "default", name: "   " },
  });
  assert.equal(emptyName.status, 400);
  assert.equal(emptyName.payload.code, "LEARNING_LIBRARY_NAME_EMPTY");
  const duplicate = await request(port, "/api/learning-libraries", {
    method: "POST", headers: authed, body: { projectId: "default", name: " 海报风格 " },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.payload.code, "LEARNING_LIBRARY_NAME_TAKEN");

  // ── GET one: 200 with groupCount; missing id 404 ──
  const single = await request(port, `/api/learning-libraries/${library.id}?project=default`, { headers: authed });
  assert.equal(single.status, 200);
  assert.equal(single.payload.library.id, library.id);
  assert.equal(single.payload.library.groupCount, 0);
  const missing = await request(port, "/api/learning-libraries/ll_missing?project=default", { headers: authed });
  assert.equal(missing.status, 404);
  assert.equal(missing.payload.code, "LEARNING_LIBRARY_NOT_FOUND");

  // ── PATCH rename: 200; renaming onto a taken name 409 ──
  const renamed = await request(port, `/api/learning-libraries/${library.id}`, {
    method: "PATCH", headers: authed, body: { projectId: "default", name: "海报风格二" },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.payload.library.name, "海报风格二");
  const second = await request(port, "/api/learning-libraries", {
    method: "POST", headers: authed, body: { projectId: "default", name: "第二个" },
  });
  const renameTaken = await request(port, `/api/learning-libraries/${second.payload.library.id}`, {
    method: "PATCH", headers: authed, body: { projectId: "default", name: "海报风格二" },
  });
  assert.equal(renameTaken.status, 409);
  assert.equal(renameTaken.payload.code, "LEARNING_LIBRARY_NAME_TAKEN");

  // ── POST members: 200 with the four counters; missing library 404 ──
  const added = await request(port, `/api/learning-libraries/${library.id}/members`, {
    method: "POST", headers: authed, body: { projectId: "default", assetIds: ["ghost-asset"] },
  });
  assert.equal(added.status, 200);
  assert.deepEqual(added.payload, { added: 0, alreadyIn: 0, skippedVideos: 0, missing: 1 }, "a non-existent asset counts as missing");
  const addMissing = await request(port, "/api/learning-libraries/ll_missing/members", {
    method: "POST", headers: authed, body: { projectId: "default", assetIds: ["ghost-asset"] },
  });
  assert.equal(addMissing.status, 404);
  assert.equal(addMissing.payload.code, "LEARNING_LIBRARY_NOT_FOUND");

  // ── DELETE members: 200 { removed } ──
  const removed = await request(port, `/api/learning-libraries/${library.id}/members`, {
    method: "DELETE", headers: authed, body: { projectId: "default", assetIds: ["ghost-asset"] },
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.payload, { removed: 0 });

  // ── DELETE library: 200; missing id 404; list shrinks ──
  const deleted = await request(port, `/api/learning-libraries/${second.payload.library.id}?project=default`, { method: "DELETE", headers: authed });
  assert.equal(deleted.status, 200);
  const deleteMissing = await request(port, `/api/learning-libraries/${second.payload.library.id}?project=default`, { method: "DELETE", headers: authed });
  assert.equal(deleteMissing.status, 404);
  const finalList = await request(port, "/api/learning-libraries?project=default", { headers: authed });
  assert.equal(finalList.payload.learningLibraries.length, 1);

  // ── The navigation payload carries the sidebar rows ──
  const navigation = await request(port, "/api/navigation?project=default", { headers: authed });
  assert.equal(navigation.status, 200);
  assert.deepEqual(navigation.payload.navigation.learningLibraries, [
    { id: library.id, name: "海报风格二", count: 0 },
  ]);
});
