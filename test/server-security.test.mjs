import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  isAllowedIngestOrigin,
  isAllowedLocalOrigin,
  isApprovedExtensionOrigin,
  isAuthorizedMosaClientRequest,
  isAuthorizedMosaClientToken,
  mosaBrowserClientCookieHeader,
  mosaBrowserClientCookieName,
  mosaBrowserClientToken,
  mosaClientTokenFingerprint,
  normalizeMosaClientToken,
  parseAllowedIngestOrigins,
  requiresMosaClientToken,
  resolveAllowedFolderPath,
} from "../lib/server-security.js";

test("allows only same-origin browser requests", () => {
  assert.equal(isAllowedLocalOrigin(undefined, 43517), true);
  assert.equal(isAllowedLocalOrigin("http://127.0.0.1:43517", 43517), true);
  assert.equal(isAllowedLocalOrigin("http://localhost:43517", 43517), true);
  assert.equal(isAllowedLocalOrigin("https://example.com", 43517), false);
  assert.equal(isAllowedLocalOrigin("null", 43517), false);
});

test("management mutations require a high-entropy runtime capability", () => {
  const token = "a".repeat(43);
  const browserToken = mosaBrowserClientToken(token, 43517);
  const browserCookieName = mosaBrowserClientCookieName(43517);
  assert.equal(normalizeMosaClientToken(token), token);
  assert.equal(isAuthorizedMosaClientToken(token, token), true);
  assert.equal(isAuthorizedMosaClientToken(`${token.slice(0, -1)}b`, token), false);
  assert.equal(browserToken.length, 43);
  assert.equal(browserCookieName, "mosa-browser-client-43517");
  assert.match(mosaBrowserClientCookieHeader(token, 43517), /^mosa-browser-client-43517=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict$/);
  assert.equal(isAuthorizedMosaClientRequest("", `${browserCookieName}=${browserToken}`, token, 43517), true);
  assert.equal(isAuthorizedMosaClientRequest("stale", `${browserCookieName}=${browserToken}`, token, 43517), true);
  assert.equal(isAuthorizedMosaClientRequest("", `${browserCookieName}=${browserToken}`, token, 43518), false);
  assert.equal(mosaClientTokenFingerprint(token).length, 22);
  // Task 314: every /api method needs the capability now, GETs included —
  // assets, prompts, originals and diagnostics must not be readable by other
  // local users or sandboxed processes.
  assert.equal(requiresMosaClientToken("POST", "/api/assets/create"), true);
  assert.equal(requiresMosaClientToken("DELETE", "/api/trash"), true);
  assert.equal(requiresMosaClientToken("GET", "/api/assets"), true);
  assert.equal(requiresMosaClientToken("HEAD", "/api/assets/default/asset-1"), true);
  assert.equal(requiresMosaClientToken("GET", "/not-api"), false);
  assert.equal(requiresMosaClientToken("POST", "/not-api"), false);
  // The public allowlist lives in one place and covers exactly the three
  // credential-free routes (health, the 311 challenge, the cookie exchange).
  assert.equal(requiresMosaClientToken("GET", "/api/health"), false);
  assert.equal(requiresMosaClientToken("HEAD", "/api/health"), false);
  assert.equal(requiresMosaClientToken("POST", "/api/service-identity"), false);
  assert.equal(requiresMosaClientToken("POST", "/api/client-session"), false);
  assert.equal(requiresMosaClientToken("POST", "/api/health"), false, "whitelisted paths are path-scoped, so unknown methods fall through to 404");
  assert.throws(() => normalizeMosaClientToken("too-short"), /32-byte-or-stronger/);
});

test("allows only explicitly configured extension origins for ingest", () => {
  const allowed = parseAllowedIngestOrigins("chrome-extension://approved, moz-extension://firefox, https://example.com");
  assert.deepEqual(allowed, ["chrome-extension://approved", "moz-extension://firefox"]);
  assert.equal(isAllowedIngestOrigin("chrome-extension://approved", 43517, allowed), true);
  assert.equal(isAllowedIngestOrigin("moz-extension://firefox", 43517, allowed), true);
  assert.equal(isAllowedIngestOrigin("chrome-extension://other", 43517, allowed), false);
  assert.equal(isAllowedIngestOrigin("https://chatgpt.com", 43517, allowed), false);
  assert.equal(isAllowedLocalOrigin("chrome-extension://id", 43517), false);
  assert.equal(isApprovedExtensionOrigin("chrome-extension://approved", allowed), true);
  assert.equal(isApprovedExtensionOrigin(undefined, allowed), false);
  assert.equal(isApprovedExtensionOrigin("http://127.0.0.1:43517", allowed), false);
});

test("resolves only real paths inside allowed Finder roots and rejects symlink escapes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-server-security-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const allowedRoot = join(root, "mosa");
  const nested = join(allowedRoot, "assets", "default", "images");
  const outside = join(root, "secret");
  await mkdir(nested, { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, join(allowedRoot, "escape-link"));

  const allowedPaths = [allowedRoot, join(allowedRoot, "assets", "default")];
  assert.equal(resolveAllowedFolderPath(join(allowedRoot, "assets", "default"), allowedPaths), await realpath(join(allowedRoot, "assets", "default")));
  assert.equal(resolveAllowedFolderPath(nested, allowedPaths), await realpath(nested));
  assert.equal(resolveAllowedFolderPath(outside, allowedPaths), null);
  assert.equal(resolveAllowedFolderPath(join(allowedRoot, "..", "secret"), allowedPaths), null);
  assert.equal(resolveAllowedFolderPath(join(allowedRoot, "escape-link"), allowedPaths), null);
  assert.equal(resolveAllowedFolderPath("", allowedPaths), null);
});

test("keeps copied library images available to both gallery and inspector", async () => {
  const runtime = await readFile(resolve(import.meta.dirname, "..", "lib", "mosa-runtime.mjs"), "utf8");
  assert.match(runtime, /Cache-Control", "private, max-age=31536000, immutable"/);
});
