import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { isAllowedFetchMetadata } from "../lib/server-security.js";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import sharp from "sharp";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const CAPTURE_BEARER = "mosa_fetch_metadata_capture_token_0123456789";
const CAPTURE_ORIGIN = "chrome-extension://fetchmetadataextensionid";

// Table-driven pure-function cases: [name, input, expected]. The port is only
// consulted for the loopback-Origin exemption (rule 3a).
const PORT = 47110;
const FETCH_METADATA_CASES = [
  ["no Sec-Fetch-Site header → allow (Node clients, old browsers)", {
    method: "GET", pathname: "/api/assets", site: "", mode: "", dest: "", origin: "", port: PORT,
  }, true],
  ["same-origin → allow", {
    method: "GET", pathname: "/api/assets", site: "same-origin", mode: "cors", dest: "empty", origin: "", port: PORT,
  }, true],
  ["none (address-bar navigation) → allow", {
    method: "GET", pathname: "/", site: "none", mode: "navigate", dest: "document", origin: "", port: PORT,
  }, true],
  ["same-site no-cors image into /library/ → refuse", {
    method: "GET", pathname: "/library/default/thumbnails/x.webp", site: "same-site", mode: "no-cors", dest: "image", origin: "http://127.0.0.1:8000", port: PORT,
  }, false],
  ["cross-site cors at /api/assets → refuse", {
    method: "GET", pathname: "/api/assets", site: "cross-site", mode: "cors", dest: "empty", origin: "http://127.0.0.1:8000", port: PORT,
  }, false],
  ["cross-site top-level document navigation to / → allow", {
    method: "GET", pathname: "/", site: "cross-site", mode: "navigate", dest: "document", origin: "", port: PORT,
  }, true],
  ["cross-site navigation to /api/assets → refuse", {
    method: "GET", pathname: "/api/assets", site: "cross-site", mode: "navigate", dest: "document", origin: "", port: PORT,
  }, false],
  ["cross-site navigation to /library/x.png → refuse", {
    method: "GET", pathname: "/library/x.png", site: "cross-site", mode: "navigate", dest: "document", origin: "", port: PORT,
  }, false],
  ["cross-site navigation into an iframe is not top-level → refuse", {
    method: "GET", pathname: "/", site: "cross-site", mode: "navigate", dest: "iframe", origin: "", port: PORT,
  }, false],
  ["cross-site GET document navigation to the Pinterest callback → allow", {
    method: "GET", pathname: "/api/pinterest/callback", site: "cross-site", mode: "navigate", dest: "document", origin: "", port: PORT,
  }, true],
  ["HEAD to the Pinterest callback is refused (rule c is GET-only)", {
    method: "HEAD", pathname: "/api/pinterest/callback", site: "cross-site", mode: "navigate", dest: "document", origin: "", port: PORT,
  }, false],
  ["cross-site POST to the Pinterest callback → refuse", {
    method: "POST", pathname: "/api/pinterest/callback", site: "cross-site", mode: "navigate", dest: "document", origin: "", port: PORT,
  }, false],
  ["cross-site with this port's localhost Origin → allow (existing design)", {
    method: "GET", pathname: "/api/assets", site: "cross-site", mode: "cors", dest: "empty", origin: `http://localhost:${PORT}`, port: PORT,
  }, true],
  ["same-site with a DIFFERENT port's Origin → refuse", {
    method: "GET", pathname: "/api/assets", site: "same-site", mode: "cors", dest: "empty", origin: `http://127.0.0.1:${PORT + 1}`, port: PORT,
  }, false],
  ["cross-site with a DIFFERENT port's Origin → refuse", {
    method: "GET", pathname: "/api/assets", site: "cross-site", mode: "cors", dest: "empty", origin: `http://127.0.0.1:${PORT + 1}`, port: PORT,
  }, false],
  ["cross-site navigation to the bare /api path → refuse", {
    method: "GET", pathname: "/api", site: "cross-site", mode: "navigate", dest: "document", origin: "", port: PORT,
  }, false],
  ["cross-site navigation to the bare /library path → refuse", {
    method: "GET", pathname: "/library", site: "cross-site", mode: "navigate", dest: "document", origin: "", port: PORT,
  }, false],
  ["cross-site navigation to a static path that only shares the prefix → allow", {
    method: "GET", pathname: "/api-guide.html", site: "cross-site", mode: "navigate", dest: "document", origin: "", port: PORT,
  }, true],
  ["unrecognized site value is treated as cross-site (static path still navigable)", {
    method: "GET", pathname: "/", site: "weird", mode: "navigate", dest: "document", origin: "", port: PORT,
  }, true],
  ["unrecognized site value with a credentialed API read → refuse", {
    method: "GET", pathname: "/api/assets", site: "weird", mode: "cors", dest: "empty", origin: "", port: PORT,
  }, false],
];

for (const [name, input, expected] of FETCH_METADATA_CASES) {
  test(`isAllowedFetchMetadata: ${name}`, () => {
    assert.equal(isAllowedFetchMetadata(input), expected);
  });
}

test("isAllowedFetchMetadata: header case is normalized (Sec-Fetch-* arrive lowercase but stay defensive)", () => {
  assert.equal(isAllowedFetchMetadata({
    method: "get", pathname: "/", site: "SAME-ORIGIN", mode: "NAVIGATE", dest: "DOCUMENT", origin: "", port: PORT,
  }), true);
  assert.equal(isAllowedFetchMetadata({
    method: "GET", pathname: "/api/assets", site: "Cross-Site", mode: "cors", dest: "empty", origin: "", port: PORT,
  }), false);
});

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

function request(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (response) => {
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

async function seedAsset(runtime, root) {
  const imagePath = join(root, "seed.png");
  await sharp({
    create: { width: 64, height: 64, channels: 3, background: "#204060" },
  }).png().toFile(imagePath);
  const response = await fetch(`${runtime.url}/api/assets/create`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mosa-client-token": runtime.clientToken },
    body: JSON.stringify({ projectId: "default", imagePath, prompt: "fetch-metadata seed" }),
  });
  assert.equal(response.status, 200, `seed asset create failed: ${response.status}`);
  const created = await response.json();
  const imageFile = String(created.asset.image_path || "").split(/[\\/]/).pop();
  assert.ok(imageFile, "seed asset must carry an image path");
  return `/library/default/images/${encodeURIComponent(imageFile)}`;
}

test("the runtime gate labels same-site browser requests CROSS_SITE_REQUEST while Node, same-origin and navigations pass", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-fetch-metadata-");
  const { runtime } = await startTestRuntime(t, root, {});
  const imagePath = await seedAsset(runtime, root);

  // The header credential admits Node clients (no Sec-Fetch-* at all)…
  const noHeader = await request(runtime.port, "/api/assets?project=default", {
    headers: { "x-mosa-client-token": runtime.clientToken },
  });
  assert.equal(noHeader.status, 200, "a Node client without Sec-Fetch-Site must pass");

  // …and the app's own window (same-origin).
  const sameOrigin = await request(runtime.port, "/api/assets?project=default", {
    headers: { "x-mosa-client-token": runtime.clientToken, "sec-fetch-site": "same-origin" },
  });
  assert.equal(sameOrigin.status, 200, "same-origin must pass");

  // A page on another loopback port is same-site to the browser: refused even
  // with a stolen capability.
  const sameSite = await request(runtime.port, "/api/assets?project=default", {
    headers: {
      "x-mosa-client-token": runtime.clientToken,
      "sec-fetch-site": "same-site",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      origin: `http://127.0.0.1:${runtime.port + 1}`,
    },
  });
  assert.equal(sameSite.status, 403);
  assert.equal(JSON.parse(sameSite.body).code, "CROSS_SITE_REQUEST");
  assert.equal(JSON.parse(sameSite.body).error, "Cross-site requests are not allowed.");

  // Cookie-carrying <img> from a same-site page: SameSite=Strict would have
  // kept the cookie home, but the gate refuses it regardless.
  const session = await request(runtime.port, "/api/client-session", {
    method: "POST",
    headers: { "x-mosa-client-token": runtime.clientToken },
  });
  assert.equal(session.status, 204);
  const setCookie = Array.isArray(session.headers["set-cookie"]) ? session.headers["set-cookie"][0] : session.headers["set-cookie"];
  const cookie = (setCookie || "").split(";", 1)[0];
  assert.ok(cookie, "client-session must mint the browser cookie");

  const cookieSameSite = await request(runtime.port, imagePath, {
    headers: {
      cookie,
      "sec-fetch-site": "same-site",
      "sec-fetch-mode": "no-cors",
      "sec-fetch-dest": "image",
      origin: `http://127.0.0.1:${runtime.port + 1}`,
    },
  });
  assert.equal(cookieSameSite.status, 403, "a same-site <img> into /library/ must be refused");
  assert.equal(JSON.parse(cookieSameSite.body).code, "CROSS_SITE_REQUEST");

  const cookieSameOrigin = await request(runtime.port, imagePath, {
    headers: { cookie, "sec-fetch-site": "same-origin", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" },
  });
  assert.equal(cookieSameOrigin.status, 200, "the same media loads from the app's own window");

  // A link from any site may bring the user to the app shell.
  const shell = await request(runtime.port, "/", {
    headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
  });
  assert.equal(shell.status, 200, "a cross-site top-level navigation to the shell must pass");

  // Cross-site preflights are refused too (they used to answer 204).
  const preflight = await request(runtime.port, "/api/assets", {
    method: "OPTIONS",
    headers: {
      origin: "http://127.0.0.1:8000",
      "access-control-request-method": "GET",
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "cors",
    },
  });
  assert.equal(preflight.status, 403, "a cross-site preflight must be refused");
  assert.equal(JSON.parse(preflight.body).code, "CROSS_SITE_REQUEST");

  // The Pinterest OAuth redirect returns as a cross-site top-level GET; the
  // fetch-metadata gate must not be the layer that blocks it.
  const pinterest = await request(runtime.port, "/api/pinterest/callback?code=x&state=y", {
    headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
  });
  assert.notEqual(pinterest.status, 403, "the callback must not be refused by THIS gate");
  assert.notEqual(JSON.parse(pinterest.body).code, "CROSS_SITE_REQUEST");

  // A cross-site POST to the same path is still refused.
  const pinterestPost = await request(runtime.port, "/api/pinterest/callback", {
    method: "POST",
    headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
  });
  assert.equal(pinterestPost.status, 403);
  assert.equal(JSON.parse(pinterestPost.body).code, "CROSS_SITE_REQUEST");
});

test("web capture routes keep their own boundary and skip the fetch-metadata gate", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-fetch-metadata-ext-");
  const { runtime } = await startTestRuntime(t, root, {
    webCaptureToken: CAPTURE_BEARER,
    webCaptureOrigins: CAPTURE_ORIGIN,
  });

  const status = await request(runtime.port, "/api/ingest/web-capture-status", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": "2",
      authorization: `Bearer ${CAPTURE_BEARER}`,
      origin: CAPTURE_ORIGIN,
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    },
    body: "{}",
  });
  assert.equal(status.status, 200, `an approved extension with cross-site tags must still work: ${status.body}`);
  assert.equal(JSON.parse(status.body).code, undefined);
});

async function startTestRuntime(t, root, overrides = {}) {
  const options = runtimeOptions(root, overrides);
  const runtime = await startMosaRuntime(options);
  t.after(() => runtime.stop());
  return { runtime, options };
}
