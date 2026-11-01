import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { isAuthorizedMosaServiceIdentityProof, mosaServiceIdentityProof } from "../lib/server-security.js";
import {
  reserveIngestBodyCapacity,
  resetIngestBodyCapacityForTests,
  WEB_CAPTURE_INFLIGHT_BODY_LIMIT_BYTES,
  WEB_CAPTURE_MAX_JSON_BODY_BYTES,
} from "../lib/web-capture-ingest.js";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import sharp from "sharp";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const CAPTURE_BEARER = "mosa_read_auth_capture_token_0123456789abcdefg";

// A 256×256 gaussian-noise PNG stays far above the ingest 20 KiB floor.
async function writeNoisePng(path) {
  await sharp({
    create: {
      width: 256, height: 256, channels: 3,
      noise: { type: "gaussian", mean: 128, sigma: 30 },
    },
  }).png().toFile(path);
}

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

async function startTestRuntime(t, root, overrides = {}) {
  const options = runtimeOptions(root, overrides);
  const runtime = await startMosaRuntime(options);
  t.after(() => runtime.stop());
  return { runtime, options };
}

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
      response.on("end", () => resolveRequest({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", rejectRequest);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function createAsset(runtime, root) {
  const imagePath = join(root, "seed.png");
  await writeNoisePng(imagePath);
  const response = await fetch(`${runtime.url}/api/assets/create`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mosa-client-token": runtime.clientToken },
    body: JSON.stringify({ projectId: "default", imagePath, prompt: "read-auth seed" }),
  });
  assert.equal(response.status, 200, `seed asset create failed: ${response.status}`);
  const created = await response.json();
  return created.asset;
}

/** Sends one hand-written HTTP/1.1 request and returns status line + headers. */
function rawRequest(port, raw) {
  return new Promise((resolveRequest, rejectRequest) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => socket.write(raw));
    let data = "";
    socket.on("data", (chunk) => { data += chunk.toString("latin1"); });
    socket.on("close", () => resolveRequest(data));
    socket.on("error", rejectRequest);
    setTimeout(() => socket.destroy(), 3000).unref?.();
  });
}

test("unauthenticated API reads and library media are refused; credentials admit them", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-read-auth-");
  const { runtime } = await startTestRuntime(t, root);
  const asset = await createAsset(runtime, root);
  const imageFile = String(asset.image_path || "").split(/[\\/]/).pop();
  assert.ok(imageFile, "seed asset must carry an image path");
  const thumbnailPath = `/library/default/thumbnails/${asset.id}.webp`;

  const readPaths = [
    "/api/assets?project=default",
    `/api/assets/default/${asset.id}`,
    "/api/library-path?project=default",
    "/api/feedback/diagnostics",
    "/api/bridges",
    "/api/navigation?project=default",
    "/library/default/images/" + encodeURIComponent(imageFile),
    thumbnailPath,
  ];
  // Raw sockets bypass the clean-test-env fetch wrapper on purpose: these
  // assertions prove the gate fires with NO credential at all.
  for (const path of readPaths) {
    const response = await request(runtime.port, path);
    assert.equal(response.status, 401, `GET ${path} must require the capability`);
    assert.equal(JSON.parse(response.body).code, "MOSA_CLIENT_UNAUTHORIZED");
  }

  const withToken = await fetch(`${runtime.url}/library/default/images/${encodeURIComponent(imageFile)}`, {
    headers: { "x-mosa-client-token": runtime.clientToken },
  });
  assert.equal(withToken.status, 200, "the header credential admits library media");

  // The client-session cookie stands in for <img>/<video>, which cannot send
  // headers. Raw sockets keep the wrapper from adding a header token, so this
  // really is cookie-only. A missing derivative answers 404 (gate passed),
  // never 401.
  const session = await request(runtime.port, "/api/client-session", {
    method: "POST",
    headers: { "x-mosa-client-token": runtime.clientToken },
  });
  assert.equal(session.status, 204);
  const setCookie = Array.isArray(session.headers["set-cookie"]) ? session.headers["set-cookie"][0] : session.headers["set-cookie"];
  const cookie = (setCookie || "").split(";", 1)[0];
  assert.ok(cookie, "client-session must mint the browser cookie");
  const withCookie = await request(runtime.port, thumbnailPath, { headers: { cookie } });
  assert.notEqual(withCookie.status, 401, "the cookie admits library media");
  const originalWithCookie = await request(runtime.port, "/library/default/images/" + encodeURIComponent(imageFile), { headers: { cookie } });
  assert.equal(originalWithCookie.status, 200);
});

test("static UI stays public and no longer mints a capability cookie", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-read-auth-static-");
  const { runtime } = await startTestRuntime(t, root);

  const shell = await fetch(`${runtime.url}/`);
  assert.equal(shell.status, 200);
  assert.equal(shell.headers.get("set-cookie"), null);
  const fallback = await fetch(`${runtime.url}/deep/app/route`);
  assert.equal(fallback.status, 200);
  assert.equal(fallback.headers.get("set-cookie"), null);
  const shellText = await shell.text();
  const bundlePath = /src="(\/assets\/[^"]+\.js)"/.exec(shellText)?.[1];
  assert.ok(bundlePath, "the shell must reference its bundle");
  const bundle = await fetch(`${runtime.url}${bundlePath}`);
  assert.equal(bundle.status, 200);
  assert.equal(bundle.headers.get("set-cookie"), null);
});

test("client-session exchanges only the header credential for the browser cookie", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-read-auth-session-");
  const { runtime } = await startTestRuntime(t, root);

  const missing = await request(runtime.port, "/api/client-session", { method: "POST" });
  assert.equal(missing.status, 401);
  const wrong = await request(runtime.port, "/api/client-session", {
    method: "POST",
    headers: { "x-mosa-client-token": "b".repeat(43) },
  });
  assert.equal(wrong.status, 401);
  const cookieOnly = await request(runtime.port, "/api/client-session", {
    method: "POST",
    headers: { cookie: "mosa-browser-client-x=valid-looking-value" },
  });
  assert.equal(cookieOnly.status, 401, "the cookie alone must never mint a session");

  const crossOrigin = await fetch(`${runtime.url}/api/client-session`, {
    method: "POST",
    headers: { "x-mosa-client-token": runtime.clientToken, origin: "https://evil.example" },
  });
  assert.equal(crossOrigin.status, 403);

  const ok = await request(runtime.port, "/api/client-session", {
    method: "POST",
    headers: { "x-mosa-client-token": runtime.clientToken },
  });
  assert.equal(ok.status, 204);
  const setCookie = Array.isArray(ok.headers["set-cookie"]) ? ok.headers["set-cookie"][0] : ok.headers["set-cookie"];
  assert.match(
    setCookie || "",
    new RegExp(`^mosa-browser-client-${runtime.port}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Strict$`),
  );
});

test("public health keeps its contract without any library path", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-read-auth-health-");
  const { runtime, options } = await startTestRuntime(t, root);

  const response = await fetch(`${runtime.url}/api/health`);
  assert.equal(response.status, 200);
  const health = await response.json();
  const raw = JSON.stringify(health);
  assert.ok(!("libraryDir" in health), "health must not publish libraryDir");
  assert.ok(!raw.includes(resolve(options.libraryDir)), "health must not leak the library path");
  assert.ok(!raw.includes(realpathSync(options.libraryDir)), "health must not leak the library realpath");
  assert.ok(typeof health.libraryDigest === "string" && health.libraryDigest.length > 0, "health must publish the library digest");
  assert.equal(health.product, "mosa");
  assert.ok(health.productVersion, "the extension reads productVersion");
  assert.ok(health.clientAuthFingerprint, "the desktop reads clientAuthFingerprint");
  assert.ok(health.storage, "storage stays reported");
});

test("service-identity and web-capture status stay credential-free", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-read-auth-public-");
  const { runtime } = await startTestRuntime(t, root);

  const nonce = "abcdefghijklmnopqrstuvwxyz012345";
  const challenge = await request(runtime.port, "/api/service-identity", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce }),
  });
  assert.equal(challenge.status, 200, "the 311 challenge must stay reachable without a credential");
  const { proof } = JSON.parse(challenge.body);
  assert.equal(isAuthorizedMosaServiceIdentityProof(proof, runtime.clientToken, { port: runtime.port, nonce }), true);
  assert.equal(mosaServiceIdentityProof(runtime.clientToken, { port: runtime.port, nonce }), proof);

  const status = await fetch(`${runtime.url}/api/web-capture`);
  assert.equal(status.status, 200, "web capture routes keep their own bearer boundary");
});

test("the Host header itself is validated, not the request-line authority", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-read-auth-host-");
  const { runtime } = await startTestRuntime(t, root);

  const evilHost = await request(runtime.port, "/api/health", { headers: { host: "evil.example" } });
  assert.equal(evilHost.status, 403, "a non-loopback Host header is refused");
  const wrongPort = await request(runtime.port, "/api/health", { headers: { host: `127.0.0.1:${runtime.port + 1}` } });
  assert.equal(wrongPort.status, 403, "a Host port that is not the bound port is refused");
  const noHost = await new Promise((resolveRequest, rejectRequest) => {
    const req = http.request({
      host: "127.0.0.1", port: runtime.port, path: "/api/health", method: "GET",
      setHost: false,
    }, (response) => {
      response.resume();
      response.on("end", () => resolveRequest(response.statusCode));
    });
    req.on("error", rejectRequest);
    req.end();
  });
  // Node's HTTP/1.1 parser refuses hostless requests with 400 before the
  // handler runs; the runtime's own guard (403) covers HTTP/1.0-style
  // requests. Either way nothing without a Host header is served.
  assert.ok([400, 403].includes(noHost), "a missing Host header is refused");

  const absoluteForeign = await request(runtime.port, `http://evil.example/api/health`, {
    headers: { host: `127.0.0.1:${runtime.port}` },
  });
  assert.equal(absoluteForeign.status, 403, "an absolute-form request line naming a foreign host is refused");

  const localAbsolute = await request(runtime.port, `http://127.0.0.1:${runtime.port}/api/health`, {
    headers: { host: `127.0.0.1:${runtime.port}` },
  });
  assert.equal(localAbsolute.status, 200, "a loopback absolute-form request passes");
  const localhostNoPort = await request(runtime.port, "/api/health", { headers: { host: "localhost" } });
  assert.equal(localhostNoPort.status, 200, "Host without a port passes");
  const ipv6 = await request(runtime.port, "/api/health", { headers: { host: `[::1]:${runtime.port}` } });
  assert.equal(ipv6.status, 200, "a bracketed IPv6 loopback Host passes");
});

test("the capture JSON entry refuses oversized bodies before reading them", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-read-auth-ingest-");
  const { runtime } = await startTestRuntime(t, root, { webCaptureToken: CAPTURE_BEARER });

  const oversized = await request(runtime.port, "/api/ingest/web-capture", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${CAPTURE_BEARER}`,
      // The gate checks the DECLARED size before reading a byte, so a tiny
      // (never-sent) payload with an over-limit Content-Length proves the
      // ordering: the response comes back before any body byte is consumed.
      "content-length": String(WEB_CAPTURE_MAX_JSON_BODY_BYTES + 1),
    },
  });
  assert.equal(oversized.status, 413);
  assert.equal(JSON.parse(oversized.body).code, "WEB_CAPTURE_USE_BINARY_UPLOAD");

  const noLength = await rawRequest(runtime.port, [
    "POST /api/ingest/web-capture HTTP/1.1",
    "Host: 127.0.0.1",
    `Authorization: Bearer ${CAPTURE_BEARER}`,
    "Content-Type: application/json",
    "Transfer-Encoding: chunked",
    "",
    "2",
    "{}",
    "0",
    "",
    "",
  ].join("\r\n"));
  assert.match(noLength, /^HTTP\/1\.1 413/, "a chunked body without Content-Length is refused before reading");

  // A normal-sized capture body still goes through (and its budget is
  // released afterwards, proven by the follow-up request succeeding).
  const imagePath = join(root, "seed.png");
  await writeNoisePng(imagePath);
  const normal = await fetch(`${runtime.url}/api/ingest/web-capture`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${CAPTURE_BEARER}` },
    body: JSON.stringify({
      provider: "chatgpt",
      mediaKind: "image",
      mimeType: "image/png",
      imageBase64: Buffer.from(await readFile(imagePath)).toString("base64"),
      prompt: "gate pass-through",
      extensionVersion: "0.15.44",
    }),
  });
  assert.equal(normal.status, 201, `normal capture failed: ${normal.status} ${await normal.text()}`);
});

test("the global in-flight byte budget bounds concurrent capture reads", () => {
  resetIngestBodyCapacityForTests();
  const fakeRes = () => ({ headers: {}, setHeader(name, value) { this.headers[name] = value; } });

  // The binary envelope's entry cap (~100 MiB) exceeds the whole budget, so a
  // single declared-70 MiB request is admitted ALONE (0 + 70 MiB over 64 MiB
  // would otherwise 503 and a 96 MiB video could never upload).
  const res1 = fakeRes();
  const release1 = reserveIngestBodyCapacity({ headers: { "content-length": String(70 * 1024 * 1024) } }, res1, WEB_CAPTURE_INFLIGHT_BODY_LIMIT_BYTES + 36 * 1024 * 1024);
  assert.equal(typeof release1, "function");

  // While that oversized reservation is held, every other capture body 503s
  // with WEB_CAPTURE_BUSY and a Retry-After.
  const res2 = fakeRes();
  assert.throws(() => reserveIngestBodyCapacity({ headers: { "content-length": "1024" } }, res2, 1024), (error) => error.statusCode === 503 && error.code === "WEB_CAPTURE_BUSY");
  assert.equal(res2.headers["Retry-After"], "5");

  // Released budget is available again.
  release1();
  const res3 = fakeRes();
  const release3 = reserveIngestBodyCapacity({ headers: { "content-length": "1024" } }, res3, 1024);
  release3();
  release3(); // idempotent

  // Entry caps refuse oversized declarations with 413 before any read; the
  // JSON entry advertises the binary fallback through its custom code.
  assert.throws(
    () => reserveIngestBodyCapacity({ headers: { "content-length": String(WEB_CAPTURE_MAX_JSON_BODY_BYTES + 1) } }, fakeRes(), WEB_CAPTURE_MAX_JSON_BODY_BYTES, "WEB_CAPTURE_USE_BINARY_UPLOAD"),
    (error) => error.statusCode === 413 && error.code === "WEB_CAPTURE_USE_BINARY_UPLOAD",
  );
  assert.throws(
    () => reserveIngestBodyCapacity({ headers: {} }, fakeRes(), 1024),
    (error) => error.statusCode === 413 && error.code === "WEB_CAPTURE_CONTENT_LENGTH_REQUIRED",
  );
  resetIngestBodyCapacityForTests();
});

test("wrongly-typed mutation fields answer 400, never a store TypeError", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-read-auth-fields-");
  const { runtime } = await startTestRuntime(t, root);
  const authHeaders = { "content-type": "application/json", "x-mosa-client-token": runtime.clientToken };

  const group = await fetch(`${runtime.url}/api/groups`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ projectId: "default", name: {} }),
  });
  assert.equal(group.status, 400);
  assert.equal((await group.json()).code, "INVALID_FIELD");
  const asset = await createAsset(runtime, root);
  const patch = await fetch(`${runtime.url}/api/assets/default/${asset.id}`, {
    method: "PATCH",
    headers: authHeaders,
    body: JSON.stringify({ prompt: { nested: true } }),
  });
  assert.equal(patch.status, 400);
  assert.equal((await patch.json()).code, "INVALID_FIELD");

  const tags = await fetch(`${runtime.url}/api/assets/default/${asset.id}`, {
    method: "PATCH",
    headers: authHeaders,
    body: JSON.stringify({ tags: ["ok", 42] }),
  });
  assert.equal(tags.status, 400);

  const stack = await fetch(`${runtime.url}/api/asset-stacks`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ projectId: "default", assetIds: "not-an-array" }),
  });
  assert.equal(stack.status, 400);

  const batch = await fetch(`${runtime.url}/api/assets/batch`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ action: {}, projectId: "default", assetIds: ["x"] }),
  });
  assert.equal(batch.status, 400);

  // Well-typed calls keep working.
  const okGroup = await fetch(`${runtime.url}/api/groups`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ projectId: "default", name: "read-auth" }),
  });
  assert.equal(okGroup.status, 201);
  const okPatch = await fetch(`${runtime.url}/api/assets/default/${asset.id}`, {
    method: "PATCH",
    headers: authHeaders,
    body: JSON.stringify({ prompt: "typed fine", tags: ["a", "b"] }),
  });
  assert.equal(okPatch.status, 200);
});
