import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import {
  isAuthorizedMosaServiceIdentityProof,
  isMosaServiceIdentityNonce,
  mosaServiceIdentityProof,
} from "../lib/server-security.js";
import {
  MosaServiceUnverifiedError,
  startMosaService,
  verifyMosaServiceIdentity,
} from "../desktop/service-manager.mjs";
import { isTrustedRendererEvent } from "../desktop/renderer-trust.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const CLIENT_TOKEN = "mosa_service_identity_test_client_token_0123456789abcdefghij";
const IMPOSTOR_TOKEN = "impostor_without_the_desktop_client_token_0123456789abcdefgh";
const VALID_NONCE = "abcdefghijklmnopqrstuvwxyz012345"; // 32 chars, base64url

// ---------------------------------------------------------------------------
// 1. Proof primitives (lib/server-security)
// ---------------------------------------------------------------------------

test("service identity proof round-trips for the right token, port, and nonce", () => {
  const proof = mosaServiceIdentityProof(CLIENT_TOKEN, { port: 5178, nonce: VALID_NONCE });
  assert.match(proof, /^[A-Za-z0-9_-]+$/);
  assert.equal(isAuthorizedMosaServiceIdentityProof(proof, CLIENT_TOKEN, { port: 5178, nonce: VALID_NONCE }), true);
  // The proof is deterministic for the same challenge but changes with every
  // input component.
  assert.equal(mosaServiceIdentityProof(CLIENT_TOKEN, { port: 5178, nonce: VALID_NONCE }), proof);
  assert.notEqual(
    mosaServiceIdentityProof(CLIENT_TOKEN, { port: 5179, nonce: VALID_NONCE }),
    proof,
    "the bound port is part of the signed message",
  );
  assert.notEqual(
    mosaServiceIdentityProof(CLIENT_TOKEN, { port: 5178, nonce: "abcdefghijklmnopqrstuvwxyz0123456" }),
    proof,
  );
});

test("a proof minted on one port never verifies for another (forwarding)", () => {
  const proofOnA = mosaServiceIdentityProof(CLIENT_TOKEN, { port: 5178, nonce: VALID_NONCE });
  assert.equal(isAuthorizedMosaServiceIdentityProof(proofOnA, CLIENT_TOKEN, { port: 5179, nonce: VALID_NONCE }), false);
  // A proof replayed for a different nonce is equally useless.
  assert.equal(
    isAuthorizedMosaServiceIdentityProof(proofOnA, CLIENT_TOKEN, { port: 5178, nonce: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
    false,
  );
});

test("nonce validation accepts only base64url of length 22-128", () => {
  assert.equal(isMosaServiceIdentityNonce(VALID_NONCE), true);
  assert.equal(isMosaServiceIdentityNonce("a".repeat(22)), true);
  assert.equal(isMosaServiceIdentityNonce("a".repeat(128)), true);
  assert.equal(isMosaServiceIdentityNonce("a".repeat(21)), false);
  assert.equal(isMosaServiceIdentityNonce("a".repeat(129)), false);
  assert.equal(isMosaServiceIdentityNonce("not+base64url/chars!"), false);
  assert.equal(isMosaServiceIdentityNonce(""), false);
  assert.equal(isMosaServiceIdentityNonce(null), false);
  assert.equal(isMosaServiceIdentityNonce(42), false);
  assert.equal(mosaServiceIdentityProof(CLIENT_TOKEN, { port: 5178, nonce: "a".repeat(21) }), "");
  assert.equal(isAuthorizedMosaServiceIdentityProof("whatever", CLIENT_TOKEN, { port: 5178, nonce: "short" }), false);
});

test("proof fails closed on invalid ports, empty tokens, and wrong credentials", () => {
  assert.equal(mosaServiceIdentityProof(CLIENT_TOKEN, { port: 0, nonce: VALID_NONCE }), "");
  assert.equal(mosaServiceIdentityProof(CLIENT_TOKEN, { port: "not-a-port", nonce: VALID_NONCE }), "");
  assert.equal(mosaServiceIdentityProof(CLIENT_TOKEN, { port: 70_000, nonce: VALID_NONCE }), "");
  assert.equal(mosaServiceIdentityProof("", { port: 5178, nonce: VALID_NONCE }), "");
  // An empty configured token must never authorize anything.
  assert.equal(isAuthorizedMosaServiceIdentityProof("", "", { port: 5178, nonce: VALID_NONCE }), false);
  assert.equal(isAuthorizedMosaServiceIdentityProof(null, CLIENT_TOKEN, { port: 5178, nonce: VALID_NONCE }), false);
  // A malformed (non-empty) token throws through the shared normalizer, the
  // same convention as the other server-security helpers; the desktop verifier
  // wraps this and treats it as unverified.
  assert.throws(
    () => mosaServiceIdentityProof("bad token with spaces", { port: 5178, nonce: VALID_NONCE }),
    /base64url/,
  );
});

// ---------------------------------------------------------------------------
// 2. Renderer IPC guard (desktop/renderer-trust.mjs)
// ---------------------------------------------------------------------------

const SERVICE_ORIGIN = "http://127.0.0.1:5178";
const STARTUP_SHELL_URL = "file:///Applications/GravityPort.app/Contents/Resources/app.asar/desktop/startup.html";

function fakeWindow({ url, destroyed = false } = {}) {
  const webContents = {
    mainFrame: { frameToken: "main" },
    getURL: () => url,
  };
  return {
    isDestroyed: () => destroyed,
    webContents,
  };
}

function fakeEvent({ windowRef, frame = "main" } = {}) {
  return {
    sender: windowRef.webContents,
    senderFrame: frame === "main" ? windowRef.webContents.mainFrame : { frameToken: "sub" },
  };
}

test("IPC is trusted only from the main frame on the verified service origin", () => {
  const windowRef = fakeWindow({ url: `${SERVICE_ORIGIN}/` });
  assert.equal(isTrustedRendererEvent(fakeEvent({ windowRef }), { windowRef, serviceOrigin: SERVICE_ORIGIN }), true);

  // Sub-frame invoke: refused even with the right origin.
  assert.equal(
    isTrustedRendererEvent(fakeEvent({ windowRef, frame: "sub" }), { windowRef, serviceOrigin: SERVICE_ORIGIN }),
    false,
  );
  // Main frame but the window currently shows another document.
  const foreign = fakeWindow({ url: "https://evil.example/phish" });
  assert.equal(
    isTrustedRendererEvent(fakeEvent({ foreign: true, windowRef: foreign }), { windowRef: foreign, serviceOrigin: SERVICE_ORIGIN }),
    false,
  );
  // Startup shell phase: file: URL, no service yet — nothing is allowed.
  const shell = fakeWindow({ url: STARTUP_SHELL_URL });
  assert.equal(
    isTrustedRendererEvent(fakeEvent({ windowRef: shell }), { windowRef: shell, serviceOrigin: "" }),
    false,
    "the startup shell calls no IPC and gets no allowance",
  );
  assert.equal(
    isTrustedRendererEvent(fakeEvent({ windowRef: shell }), { windowRef: shell, serviceOrigin: SERVICE_ORIGIN }),
    false,
  );
  // No verified service at all.
  assert.equal(
    isTrustedRendererEvent(fakeEvent({ windowRef }), { windowRef, serviceOrigin: "" }),
    false,
  );
  // Wrong sender (another window/webContents).
  assert.equal(
    isTrustedRendererEvent({ sender: {}, senderFrame: windowRef.webContents.mainFrame }, { windowRef, serviceOrigin: SERVICE_ORIGIN }),
    false,
  );
  // Destroyed window.
  const gone = fakeWindow({ url: `${SERVICE_ORIGIN}/`, destroyed: true });
  assert.equal(
    isTrustedRendererEvent(fakeEvent({ windowRef: gone }), { windowRef: gone, serviceOrigin: SERVICE_ORIGIN }),
    false,
  );
  // Disposed frame reports a null senderFrame.
  assert.equal(
    isTrustedRendererEvent({ sender: windowRef.webContents, senderFrame: null }, { windowRef, serviceOrigin: SERVICE_ORIGIN }),
    false,
  );
});

// ---------------------------------------------------------------------------
// 3. Desktop attach paths (desktop/service-manager.mjs, fetchImpl fakes)
// ---------------------------------------------------------------------------

function fakeService({ health, token = CLIENT_TOKEN, port, identityStatus = 200, proofPort = null, state = "up" }) {
  let challengeRequests = 0;
  let currentState = state;
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/health") {
      if (currentState !== "up") {
        const error = new Error("connect refused");
        error.code = "ECONNREFUSED";
        throw error;
      }
      return { ok: true, status: 200, json: async () => ({ ...health }) };
    }
    if (path === "/api/service-identity") {
      challengeRequests += 1;
      if (currentState !== "up" || identityStatus !== 200) {
        return { ok: false, status: identityStatus === 200 ? 404 : identityStatus, json: async () => ({}) };
      }
      const nonce = String(JSON.parse(String(init.body || "{}")).nonce || "");
      const proof = mosaServiceIdentityProof(token, { port: proofPort ?? port, nonce });
      return { ok: true, status: 200, json: async () => ({ proof, serviceProtocolVersion: "1" }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return {
    fetchImpl,
    challengeRequests: () => challengeRequests,
    setState: (next) => { currentState = next; },
  };
}

async function temporaryRoot(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  return root;
}

test("attaches only after a passing challenge and hands the credential to that service alone", async (t) => {
  const root = await temporaryRoot(t, "service-identity-real-");
  const libraryDir = join(root, "library");
  const port = 52_301;
  const service = fakeService({ health: { product: "mosa", libraryDir, storage: "sqlite" }, port });

  const attached = await startMosaService({
    port,
    libraryDir,
    clientToken: CLIENT_TOKEN,
    fetchImpl: service.fetchImpl,
  });
  assert.equal(attached.mode, "attached");
  assert.equal(attached.clientToken, CLIENT_TOKEN, "the credential reaches the verified service");
  assert.ok(service.challengeRequests() >= 1, "the attach decision ran the challenge");
  await attached.stop();
});

test("a lookalike that copies every health field cannot attach and never sees the credential", async (t) => {
  const root = await temporaryRoot(t, "service-identity-impostor-");
  const libraryDir = join(root, "library");
  const port = 52_302;
  // Every public field copied, including clientAuthFingerprint — only the
  // secret itself is missing, so the challenge fails.
  const service = fakeService({
    health: {
      product: "mosa",
      libraryDir,
      storage: "sqlite",
      serviceProtocolVersion: "1",
      productVersion: "0.15.44",
      gitSha: "copied-sha",
      uiFingerprint: "copied-ui",
      runtimeFingerprint: "copied-runtime",
      clientAuthFingerprint: "copied-fingerprint",
    },
    token: IMPOSTOR_TOKEN,
    port,
  });

  const error = await startMosaService({
    port,
    libraryDir,
    clientToken: CLIENT_TOKEN,
    expectedIdentity: {
      serviceProtocolVersion: "1",
      productVersion: "0.15.44",
      gitSha: "copied-sha",
      uiFingerprint: "copied-ui",
      runtimeFingerprint: "copied-runtime",
      clientAuthFingerprint: "copied-fingerprint",
    },
    fetchImpl: service.fetchImpl,
  }).then(
    () => { throw new Error("the impostor must not be attached to"); },
    (caught) => caught,
  );
  assert.ok(error instanceof MosaServiceUnverifiedError, `expected MosaServiceUnverifiedError, got ${error?.constructor?.name}: ${error?.message}`);
  assert.equal(error.code, "MOSA_SERVICE_UNVERIFIED");
  assert.ok(!String(error).includes(CLIENT_TOKEN));
  assert.ok(!JSON.stringify(error).includes(CLIENT_TOKEN), "no error surface may contain the credential");
});

test("a proof forwarded from a service on another port does not verify", async (t) => {
  const root = await temporaryRoot(t, "service-identity-forward-");
  const libraryDir = join(root, "library");
  const port = 52_303;
  const service = fakeService({
    health: { product: "mosa", libraryDir, storage: "sqlite" },
    port,
    proofPort: port + 1,
  });

  await assert.rejects(
    startMosaService({ port, libraryDir, clientToken: CLIENT_TOKEN, fetchImpl: service.fetchImpl }),
    MosaServiceUnverifiedError,
  );
});

test("a pre-challenge runtime answers 404: no attachment without replacement authority", async (t) => {
  const root = await temporaryRoot(t, "service-identity-old-");
  const libraryDir = join(root, "library");
  const port = 52_304;
  const service = fakeService({
    health: { product: "mosa", libraryDir, storage: "sqlite" },
    port,
    identityStatus: 404,
  });

  await assert.rejects(
    startMosaService({ port, libraryDir, clientToken: CLIENT_TOKEN, fetchImpl: service.fetchImpl }),
    MosaServiceUnverifiedError,
    "no replacement authority: the unverified listener is a conflict",
  );
});

test("a pre-challenge runtime the runtime lock vouches for is retired and replaced", async (t) => {
  const root = await temporaryRoot(t, "service-identity-old-replace-");
  const libraryDir = join(root, "library");
  const port = 52_305;
  const service = fakeService({
    health: { product: "mosa", libraryDir, storage: "sqlite" },
    port,
    identityStatus: 404,
  });
  let retireCalls = 0;
  let startCalls = 0;

  const owned = await startMosaService({
    port,
    libraryDir,
    clientToken: CLIENT_TOKEN,
    fetchImpl: service.fetchImpl,
    allowSameVersionServiceReplacement: true,
    retireVerifiedService: async () => {
      retireCalls += 1;
      return true;
    },
    startRuntime: async (options) => {
      startCalls += 1;
      return {
        url: `http://127.0.0.1:${options.port}`,
        port: options.port,
        libraryDir: options.libraryDir,
        storage: "sqlite",
        stop: async () => {},
      };
    },
  });
  assert.equal(retireCalls, 1, "the lock-verified retirement path is used for the unverified owner");
  assert.equal(startCalls, 1);
  assert.equal(owned.mode, "owned");
});

test("background supervisor with a different token still retires through the auth-only mismatch path", async (t) => {
  const root = await temporaryRoot(t, "service-identity-supervisor-");
  const libraryDir = join(root, "library");
  const port = 52_306;
  // Same build identity, different clientAuthFingerprint (random supervisor
  // token). The challenge is never consulted: the fingerprint mismatch takes
  // the existing authOnlyMismatch replacement route.
  const service = fakeService({
    health: {
      product: "mosa",
      libraryDir,
      storage: "sqlite",
      serviceProtocolVersion: "1",
      productVersion: "0.15.44",
      gitSha: "same-sha",
      uiFingerprint: "same-ui",
      runtimeFingerprint: "same-runtime",
      clientAuthFingerprint: "supervisor-fingerprint",
    },
    port,
  });
  let handoffCalls = 0;
  let startCalls = 0;

  const owned = await startMosaService({
    port,
    libraryDir,
    clientToken: CLIENT_TOKEN,
    expectedIdentity: {
      serviceProtocolVersion: "1",
      productVersion: "0.15.44",
      gitSha: "same-sha",
      uiFingerprint: "same-ui",
      runtimeFingerprint: "same-runtime",
      clientAuthFingerprint: "desktop-fingerprint",
    },
    allowSameVersionServiceReplacement: true,
    fetchImpl: service.fetchImpl,
    upgradeService: async (conflict, options) => {
      handoffCalls += 1;
      assert.equal(options.allowSameVersionReplacement, true);
      return true;
    },
    startRuntime: async (options) => {
      startCalls += 1;
      return {
        url: `http://127.0.0.1:${options.port}`,
        port: options.port,
        libraryDir: options.libraryDir,
        storage: "sqlite",
        stop: async () => {},
      };
    },
  });
  assert.equal(handoffCalls, 1);
  assert.equal(startCalls, 1);
  assert.equal(owned.mode, "owned");
  assert.equal(service.challengeRequests(), 0, "the supervisor path does not need the challenge");
});

test("the post-upgrade retry attaches only to a port winner that passes the challenge", async (t) => {
  const root = await temporaryRoot(t, "service-identity-upgrade-retry-");
  const libraryDir = join(root, "library");
  const port = 52_307;
  const expectedIdentity = {
    serviceProtocolVersion: "1",
    productVersion: "0.2.1-rc.1",
    gitSha: "new-sha",
    uiFingerprint: "new-ui",
    runtimeFingerprint: "new-runtime",
  };
  // The live service reports the OLD build (that is what authorizes the
  // upgrade); the retry winner after retirement reports the new one.
  const oldHealth = {
    product: "mosa",
    libraryDir,
    storage: "sqlite",
    serviceProtocolVersion: "1",
    productVersion: "0.2.0",
    gitSha: "old-sha",
    uiFingerprint: "old-ui",
    runtimeFingerprint: "old-runtime",
  };
  const retryWinner = {
    state: "attached",
    url: `http://127.0.0.1:${port}`,
    port,
    libraryDir,
    storage: "sqlite",
    ...expectedIdentity,
  };
  const passing = fakeService({ health: oldHealth, port });
  const failing = fakeService({ health: oldHealth, port, token: IMPOSTOR_TOKEN });
  const eaddrinuse = () => {
    throw Object.assign(new Error("port was claimed by another runtime"), { code: "EADDRINUSE" });
  };

  const attached = await startMosaService({
    port,
    libraryDir,
    clientToken: CLIENT_TOKEN,
    expectedIdentity,
    allowStaleServiceUpgrade: true,
    upgradeService: async () => true,
    upgradeProbeImpl: async () => retryWinner,
    fetchImpl: passing.fetchImpl,
    startRuntime: eaddrinuse,
  });
  assert.equal(attached.mode, "attached");
  assert.ok(passing.challengeRequests() >= 1, "the retry winner was challenged before attaching");

  await assert.rejects(
    startMosaService({
      port,
      libraryDir,
      clientToken: CLIENT_TOKEN,
      expectedIdentity,
      allowStaleServiceUpgrade: true,
      upgradeService: async () => true,
      upgradeProbeImpl: async () => retryWinner,
      fetchImpl: failing.fetchImpl,
      startRuntime: eaddrinuse,
    }),
    MosaServiceUnverifiedError,
    "the upgrade retry must not attach to a winner that cannot prove itself",
  );
});

test("the post-race retry attaches only after the challenge", async (t) => {
  const root = await temporaryRoot(t, "service-identity-race-retry-");
  const libraryDir = join(root, "library");
  const port = 52_308;
  // The port is free during the first probe, another process binds it while
  // this launch tries to start its runtime, and that winner cannot prove the
  // service identity.
  const winner = fakeService({
    health: { product: "mosa", libraryDir, storage: "json" },
    port,
    token: IMPOSTOR_TOKEN,
    state: "down",
  });

  const outcome = await startMosaService({
    port,
    libraryDir,
    clientToken: CLIENT_TOKEN,
    fetchImpl: winner.fetchImpl,
    startRuntime: async () => {
      winner.setState("up");
      throw Object.assign(new Error("Address already in use"), { code: "EADDRINUSE" });
    },
  }).then(
    () => "attached",
    (error) => error,
  );
  assert.ok(outcome instanceof MosaServiceUnverifiedError, `expected unverified, got ${outcome?.constructor?.name}: ${outcome?.message ?? outcome}`);
});

test("verifyMosaServiceIdentity resolves true/false without leaking the credential", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "service-identity-verify-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const options = {
    port: 0,
    projectRoot: root,
    managerDir: repositoryRoot,
    cowartProjectDir: join(root, "desktop-data"),
    appDir: join(repositoryRoot, "web", "gravityport", "dist"),
    libraryDir: join(root, "library"),
    assetsRoot: join(root, "library", "assets"),
    generatedImagesDir: join(root, "generated-images"),
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "codex-sessions"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-canvas"),
    cowartRegistryPath: join(root, "state", "cowart-projects.json"),
  };
  const runtime = await startMosaRuntime(options);
  t.after(() => runtime.stop());

  assert.equal(
    await verifyMosaServiceIdentity({ port: runtime.port, clientToken: runtime.clientToken }),
    true,
    "the real runtime proves its identity",
  );
  assert.equal(
    await verifyMosaServiceIdentity({ port: runtime.port, clientToken: CLIENT_TOKEN }),
    false,
    "a different token cannot verify",
  );
  assert.equal(
    await verifyMosaServiceIdentity({ port: runtime.port + 1, clientToken: runtime.clientToken }),
    false,
    "nothing listens there",
  );
});

// ---------------------------------------------------------------------------
// 4. Runtime endpoint (lib/api/bridge-routes.mjs via the real runtime)
// ---------------------------------------------------------------------------

async function startIdentityRuntime(t, root) {
  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: root,
    managerDir: repositoryRoot,
    cowartProjectDir: join(root, "desktop-data"),
    appDir: join(repositoryRoot, "web", "gravityport", "dist"),
    libraryDir: join(root, "library"),
    assetsRoot: join(root, "library", "assets"),
    generatedImagesDir: join(root, "generated-images"),
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "codex-sessions"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-canvas"),
    cowartRegistryPath: join(root, "state", "cowart-projects.json"),
  });
  t.after(() => runtime.stop());
  return runtime;
}

async function temporaryRootPlain(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  return root;
}

test("POST /api/service-identity answers the challenge with a port-bound proof only", async (t) => {
  const root = await temporaryRootPlain(t, "service-identity-endpoint-");
  const runtime = await startIdentityRuntime(t, root);

  const nonce = "abcdefghijklmnopqrstuvwxyz012345";
  const response = await fetch(`${runtime.url}/api/service-identity`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(Object.keys(payload).sort(), ["proof", "serviceProtocolVersion"],
    "the response carries no credential, fingerprint, or library path");
  assert.equal(typeof payload.proof, "string");
  assert.equal(
    isAuthorizedMosaServiceIdentityProof(payload.proof, runtime.clientToken, { port: runtime.port, nonce }),
    true,
  );
  // The proof binds the actually-bound port, not one a caller might claim.
  assert.equal(
    isAuthorizedMosaServiceIdentityProof(payload.proof, runtime.clientToken, { port: runtime.port + 1, nonce }),
    false,
  );
});

test("POST /api/service-identity rejects bad requests and web-page origins", async (t) => {
  const root = await temporaryRootPlain(t, "service-identity-endpoint-bad-");
  const runtime = await startIdentityRuntime(t, root);
  const url = `${runtime.url}/api/service-identity`;

  const shortNonce = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce: "a".repeat(21) }),
  });
  assert.equal(shortNonce.status, 400);
  assert.equal((await shortNonce.json()).code, "SERVICE_IDENTITY_NONCE_INVALID");

  const weirdNonce = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce: "not+base64url/chars!" }),
  });
  assert.equal(weirdNonce.status, 400);

  const missingNonce = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(missingNonce.status, 400);

  const tooLarge = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce: "a".repeat(43), padding: "x".repeat(2048) }),
  });
  assert.equal(tooLarge.status, 413, "request bodies stay within 1 KiB");

  const wrongType = await fetch(url, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ nonce: "a".repeat(43) }),
  });
  assert.equal(wrongType.status, 415);

  const foreignOrigin = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ nonce: "a".repeat(43) }),
  });
  assert.equal(foreignOrigin.status, 403, "web-page origins are refused by the global origin check");

  const wrongVerb = await fetch(url, { method: "GET" });
  assert.equal(wrongVerb.status, 404, "only POST exists");

  // The clean-test-env wrapper injects the shared test token into loopback
  // mutations; pass an explicit empty header to prove the gate still fires.
  const stillGated = await fetch(`${runtime.url}/api/web-capture/retry`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mosa-client-token": "" },
    body: "{}",
  });
  assert.equal(stillGated.status, 401, "the token gate keeps covering every other mutating route");
});
