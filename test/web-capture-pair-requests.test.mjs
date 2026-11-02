// Task 333 — Web Capture pairing confirmation. Covers the in-memory request
// table (lib/web-capture-pair-requests.mjs) with an injected clock, and the
// HTTP routes on a real server.mjs runtime: POST /pair answers 202 with a
// request id, GET /pair/<id> polls, POST /api/web-capture/identity proves the
// service holds the token, and the UI routes stay behind the client token.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { removeTestPath as rm, deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import {
  createWebCapturePairRequests,
  webCaptureExtensionIdFromOrigin,
  WEB_CAPTURE_KNOWN_EXTENSION_ORIGINS,
} from "../lib/web-capture-pair-requests.mjs";
import {
  MOSA_WEB_CAPTURE_EXTENSION_ORIGINS,
} from "../desktop/web-capture-pairing.mjs";
import { webCaptureIdentityProof } from "../lib/server-security.js";

const DEVELOPMENT_ORIGIN = WEB_CAPTURE_KNOWN_EXTENSION_ORIGINS[0];
const OTHER_ORIGIN = "chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh";

function tableWithClock(startMs = 1_000_000) {
  const state = { current: startMs, events: [] };
  const table = createWebCapturePairRequests({
    now: () => state.current,
    getToken: () => "table-token",
    onChange: (reason) => state.events.push({ reason, at: state.current }),
  });
  return {
    table,
    advance: (ms) => { state.current += ms; },
    now: () => state.current,
    events: state.events,
  };
}

test("pairing request table merges per origin and returns the token exactly once", () => {
  const clock = tableWithClock();
  const first = clock.table.request({ origin: DEVELOPMENT_ORIGIN, extensionVersion: "0.15.45" });
  assert.equal(first.status, "pending");
  assert.equal(first.expiresInMs, 120_000);
  const merged = clock.table.request({ origin: DEVELOPMENT_ORIGIN, extensionVersion: "0.15.45" });
  assert.equal(merged.status, "pending");
  assert.equal(merged.requestId, first.requestId, "a second POST from the same origin merges into one request");

  assert.deepEqual(clock.table.decide(first.requestId, true), { ok: true, status: "approved" });
  const poll = clock.table.poll(first.requestId, DEVELOPMENT_ORIGIN);
  assert.equal(poll.status, "approved");
  assert.equal(poll.token, "table-token");
  // The token is delivered once: the id is gone afterwards, so a replayed
  // poll (or another extension guessing the id) cannot collect it again.
  assert.equal(clock.table.poll(first.requestId, DEVELOPMENT_ORIGIN), null);
});

test("a decide() approval grants the old-extension retry path exactly once", () => {
  const clock = tableWithClock();
  const request = clock.table.request({ origin: DEVELOPMENT_ORIGIN, extensionVersion: "" });
  clock.table.decide(request.requestId, true);

  // An old extension never polls: its next POST /pair collects the token.
  const retry = clock.table.request({ origin: DEVELOPMENT_ORIGIN, extensionVersion: "" });
  assert.equal(retry.status, "approved");
  assert.equal(retry.token, "table-token");
  // One-shot: the next POST opens a fresh request instead.
  const again = clock.table.request({ origin: DEVELOPMENT_ORIGIN, extensionVersion: "" });
  assert.equal(again.status, "pending");
  assert.notEqual(again.requestId, request.requestId);
});

test("a denial holds a 60-second cooldown and creates nothing in the list", () => {
  const clock = tableWithClock();
  const request = clock.table.request({ origin: DEVELOPMENT_ORIGIN, extensionVersion: "" });
  clock.table.decide(request.requestId, false);
  assert.deepEqual(clock.events.at(-1), { reason: "decided", at: clock.now() });

  const denied = clock.table.request({ origin: DEVELOPMENT_ORIGIN, extensionVersion: "" });
  assert.equal(denied.status, "denied");
  assert.equal(clock.table.list().length, 0, "denials never appear in the pending list");

  clock.advance(60_000);
  const afterCooldown = clock.table.request({ origin: DEVELOPMENT_ORIGIN, extensionVersion: "" });
  assert.equal(afterCooldown.status, "pending", "after the cooldown a new request opens");
});

test("pending requests expire after 120 seconds: poll says expired, the list drops them", () => {
  const clock = tableWithClock();
  const request = clock.table.request({ origin: DEVELOPMENT_ORIGIN, extensionVersion: "" });
  clock.advance(120_000);
  const poll = clock.table.poll(request.requestId, DEVELOPMENT_ORIGIN);
  assert.equal(poll.status, "expired");
  assert.equal(clock.table.list().length, 0);
  assert.ok(clock.events.some((event) => event.reason === "expired"), "expiry notifies the UI");
  // The expired row survives one grace TTL for late polls, then vanishes.
  assert.equal(clock.table.poll(request.requestId, DEVELOPMENT_ORIGIN).status, "expired");
  clock.advance(120_000);
  assert.equal(clock.table.poll(request.requestId, DEVELOPMENT_ORIGIN), null);
});

test("more than five pending origins answer busy", () => {
  const clock = tableWithClock();
  for (let index = 0; index < 5; index += 1) {
    const opened = clock.table.request({ origin: `chrome-extension://origin${index}aaaaaaaaaaaaaaaaaaaa`, extensionVersion: "" });
    assert.equal(opened.status, "pending");
  }
  const sixth = clock.table.request({ origin: OTHER_ORIGIN, extensionVersion: "" });
  assert.equal(sixth.status, "busy");
  // A decided request frees its slot even before any poll.
  const first = clock.table.list()[0];
  clock.table.decide(first.id, true);
  assert.equal(clock.table.request({ origin: OTHER_ORIGIN, extensionVersion: "" }).status, "pending");
});

test("polls from a different origin cannot read the decision", () => {
  const clock = tableWithClock();
  const request = clock.table.request({ origin: DEVELOPMENT_ORIGIN, extensionVersion: "" });
  clock.table.decide(request.requestId, true);
  assert.equal(clock.table.poll(request.requestId, OTHER_ORIGIN), null, "cross-origin polls answer 404 upstream");
  // The legitimate owner still gets the token — the wrong poll consumed nothing.
  assert.equal(clock.table.poll(request.requestId, DEVELOPMENT_ORIGIN).status, "approved");
  assert.equal(clock.table.decide("no-such-id", true), null);
});

test("the list carries no token and flags the two known extensions", () => {
  const clock = tableWithClock();
  clock.table.request({ origin: DEVELOPMENT_ORIGIN, extensionVersion: "0.15.45" });
  clock.advance(1);
  clock.table.request({ origin: OTHER_ORIGIN, extensionVersion: "" });
  const rows = clock.table.list();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].extensionId, webCaptureExtensionIdFromOrigin(DEVELOPMENT_ORIGIN));
  assert.equal(rows[0].knownExtension, true);
  assert.equal(rows[0].extensionVersion, "0.15.45");
  assert.equal(rows[1].knownExtension, false, "unknown extensions render the generic source line");
  assert.equal(JSON.stringify(rows).includes("table-token"), false);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ["createdAt", "expiresAt", "extensionId", "extensionVersion", "id", "knownExtension"]);
  }
});

test("the known-extension list matches the desktop pairing identities", () => {
  assert.deepEqual([...WEB_CAPTURE_KNOWN_EXTENSION_ORIGINS], [...MOSA_WEB_CAPTURE_EXTENSION_ORIGINS]);
});

async function startPairingServer(t) {
  const root = await mkdtemp(join(tmpdir(), "mosa-pair-http-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sessionsDir = join(root, "sessions");
  const libraryDir = join(root, "library");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(sessionsDir, "empty.jsonl"), "\n");

  const seeded = createSqliteAssetStore({ projectRoot: root, managerDir: process.cwd(), libraryDir });
  await seeded.ensureProject("default");
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
      CODEX_SESSIONS_DIR: sessionsDir,
      GROK_SESSIONS_DIR: join(root, "grok-sessions"),
      COWART_MOSA_CANVAS_DIR: join(root, "cowart-data"),
      MOSA_COWART_REGISTRY_PATH: join(root, "state", "cowart-projects.json"),
      MOSA_CLIENT_TOKEN: "pair-http-client-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      MOSA_WEB_CAPTURE_TOKEN: "pair-http-capture-token-aaaaaaaaaaaaaaaaaaaaaaaa",
      MOSA_WEB_CAPTURE_ORIGINS: `${DEVELOPMENT_ORIGIN},${OTHER_ORIGIN}`,
      MOSA_WEB_CAPTURE_PAIR: "auto",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      const forceKill = setTimeout(() => {
        if (server.exitCode === null) server.kill("SIGKILL");
      }, 5_000);
      try {
        await exited;
      } finally {
        clearTimeout(forceKill);
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  let stdout = "";
  server.stdout.setEncoding("utf8");
  server.stdout.on("data", (chunk) => { stdout += chunk; });
  const portDeadline = Date.now() + 15_000;
  let port = 0;
  while (Date.now() < portDeadline) {
    const match = /GravityPort: http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
    if (match) { port = Number(match[1]); break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(port, `the test server printed no port (stdout: ${stdout.slice(0, 400)})`);
  // Wait until the health route answers before exercising pairing.
  const readyDeadline = Date.now() + 10_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) { await response.arrayBuffer(); break; }
      await response.arrayBuffer();
    } catch { /* not listening yet */ }
    assert.ok(Date.now() < readyDeadline, "the test server never became ready");
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return { port, clientToken: "pair-http-client-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
}

test("HTTP pairing: 202 pending, one-shot approval, poll delivers the token once", async (t) => {
  const { port } = await startPairingServer(t);
  const base = `http://127.0.0.1:${port}`;
  const extensionHeaders = { origin: DEVELOPMENT_ORIGIN, "content-type": "application/json" };

  const pair = await fetch(`${base}/api/web-capture/pair`, {
    method: "POST",
    headers: extensionHeaders,
    body: JSON.stringify({ extensionVersion: "0.15.45" }),
  });
  assert.equal(pair.status, 202);
  const pairBody = await pair.json();
  assert.equal(pairBody.product, "mosa");
  assert.equal(pairBody.status, "pending");
  assert.ok(pairBody.requestId);
  assert.ok(Number.isFinite(pairBody.expiresInMs) && pairBody.expiresInMs > 0);

  const poll = await fetch(`${base}/api/web-capture/pair/${pairBody.requestId}`, { headers: { origin: DEVELOPMENT_ORIGIN } });
  assert.equal(poll.status, 200);
  assert.deepEqual(await poll.json(), { status: "pending" });

  // The App approves through the client-authenticated UI route.
  const decision = await fetch(`${base}/api/web-capture/pair-requests/${pairBody.requestId}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mosa-client-token": "pair-http-client-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    body: JSON.stringify({ allow: true }),
  });
  assert.equal(decision.status, 200);
  await decision.arrayBuffer();

  const approved = await fetch(`${base}/api/web-capture/pair/${pairBody.requestId}`, { headers: { origin: DEVELOPMENT_ORIGIN } });
  assert.equal(approved.status, 200);
  const approvedBody = await approved.json();
  assert.equal(approvedBody.product, "mosa");
  assert.equal(approvedBody.status, "approved");
  assert.equal(approvedBody.token, "pair-http-capture-token-aaaaaaaaaaaaaaaaaaaaaaaa");

  const replayed = await fetch(`${base}/api/web-capture/pair/${pairBody.requestId}`, { headers: { origin: DEVELOPMENT_ORIGIN } });
  assert.equal(replayed.status, 404, "the token is delivered exactly once; the id is gone afterwards");
  await replayed.arrayBuffer();

  // A well-formed id that no request ever used answers 404; ids with
  // off-pattern characters never match the poll route, so the extension
  // origin is refused by the plain-API origin gate (403) instead.
  const unknownId = await fetch(`${base}/api/web-capture/pair/no-such-id`, { headers: { origin: DEVELOPMENT_ORIGIN } });
  assert.equal(unknownId.status, 404);
  await unknownId.arrayBuffer();
  const garbage = await fetch(`${base}/api/web-capture/pair/$%7Bnope%7D`, { headers: { origin: DEVELOPMENT_ORIGIN } });
  assert.equal(garbage.status, 403);
  await garbage.arrayBuffer();
});

test("HTTP pairing: wrong-origin polls and unapproved origins stay locked out", async (t) => {
  const { port } = await startPairingServer(t);
  const base = `http://127.0.0.1:${port}`;

  const pair = await fetch(`${base}/api/web-capture/pair`, {
    method: "POST",
    headers: { origin: DEVELOPMENT_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ extensionVersion: "0.15.45" }),
  });
  assert.equal(pair.status, 202);
  const { requestId } = await pair.json();

  const crossOrigin = await fetch(`${base}/api/web-capture/pair/${requestId}`, { headers: { origin: OTHER_ORIGIN } });
  assert.equal(crossOrigin.status, 404, "one approved extension cannot read another's request");
  await crossOrigin.arrayBuffer();

  const unapproved = await fetch(`${base}/api/web-capture/pair`, {
    method: "POST",
    headers: { origin: "chrome-extension://notallowed000000000000000000000", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(unapproved.status, 403);
  await unapproved.arrayBuffer();

  const forged = await fetch(`${base}/api/web-capture/pair`, {
    method: "POST",
    headers: { origin: "https://chatgpt.com", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(forged.status, 403, "web page origins cannot open pairing requests");
  await forged.arrayBuffer();
});

test("HTTP pairing: legacy bodies (empty, {}, non-JSON, oversize) still open a request", async (t) => {
  const { port } = await startPairingServer(t);
  const base = `http://127.0.0.1:${port}`;

  const empty = await fetch(`${base}/api/web-capture/pair`, {
    method: "POST",
    headers: { origin: DEVELOPMENT_ORIGIN, "content-type": "application/json" },
  });
  assert.equal(empty.status, 202);
  await empty.json();

  const legacy = await fetch(`${base}/api/web-capture/pair`, {
    method: "POST",
    headers: { origin: DEVELOPMENT_ORIGIN, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(legacy.status, 202, "the legacy {} body merges into the same pending request");
  const legacyBody = await legacy.json();
  const emptyBody = await (await fetch(`${base}/api/web-capture/pair`, {
    method: "POST",
    headers: { origin: DEVELOPMENT_ORIGIN, "content-type": "application/json" },
    body: "{}",
  })).json();
  assert.equal(emptyBody.requestId, legacyBody.requestId, "same origin, one request");

  const junk = await fetch(`${base}/api/web-capture/pair`, {
    method: "POST",
    headers: { origin: DEVELOPMENT_ORIGIN, "content-type": "application/json" },
    body: "not json at all",
  });
  assert.equal(junk.status, 202, "an unparseable body degrades to {} like the old extensions");
  await junk.json();

  const oversize = await fetch(`${base}/api/web-capture/pair`, {
    method: "POST",
    headers: { origin: DEVELOPMENT_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(2048) }),
  });
  assert.equal(oversize.status, 202, "bodies over 1 KiB are treated as empty, not rejected");
  await oversize.json();
});

test("HTTP pairing: the UI routes require the client token and refuse extension origins", async (t) => {
  const { port } = await startPairingServer(t);
  const base = `http://127.0.0.1:${port}`;
  const clientHeaders = { "x-mosa-client-token": "pair-http-client-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };

  await fetch(`${base}/api/web-capture/pair`, {
    method: "POST",
    headers: { origin: DEVELOPMENT_ORIGIN, "content-type": "application/json" },
    body: "{}",
  }).then((response) => response.arrayBuffer());

  const noCredentials = await fetch(`${base}/api/web-capture/pair-requests`);
  assert.equal(noCredentials.status, 401, "the pairing queue is a client-authenticated UI route");
  await noCredentials.arrayBuffer();

  const extensionCaller = await fetch(`${base}/api/web-capture/pair-requests`, {
    headers: { origin: DEVELOPMENT_ORIGIN, ...clientHeaders },
  });
  assert.equal(extensionCaller.status, 403, "extension origins cannot read or decide the queue");
  await extensionCaller.arrayBuffer();

  const listed = await fetch(`${base}/api/web-capture/pair-requests`, { headers: clientHeaders });
  assert.equal(listed.status, 200);
  const listBody = await listed.json();
  assert.equal(listBody.requests.length, 1);
  assert.equal(listBody.requests[0].knownExtension, true);
  assert.equal(JSON.stringify(listBody).includes("pair-http-capture-token"), false, "the queue never carries the token");

  const invalidDecision = await fetch(`${base}/api/web-capture/pair-requests/${listBody.requests[0].id}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", ...clientHeaders },
    body: JSON.stringify({ allow: "yes" }),
  });
  assert.equal(invalidDecision.status, 400, "allow must be a boolean");
  await invalidDecision.arrayBuffer();

  const unknownDecision = await fetch(`${base}/api/web-capture/pair-requests/no-such-id/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", ...clientHeaders },
    body: JSON.stringify({ allow: false }),
  });
  assert.equal(unknownDecision.status, 404);
  await unknownDecision.arrayBuffer();

  const denied = await fetch(`${base}/api/web-capture/pair-requests/${listBody.requests[0].id}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", ...clientHeaders },
    body: JSON.stringify({ allow: false }),
  });
  assert.equal(denied.status, 200);
  await denied.arrayBuffer();

  const afterDeny = await fetch(`${base}/api/web-capture/pair-requests`, { headers: clientHeaders });
  assert.equal((await afterDeny.json()).requests.length, 0);
});

test("HTTP identity: proves token possession without leaking it", async (t) => {
  const { port } = await startPairingServer(t);
  const base = `http://127.0.0.1:${port}`;
  const token = "pair-http-capture-token-aaaaaaaaaaaaaaaaaaaaaaaa";

  const badNonce = await fetch(`${base}/api/web-capture/identity`, {
    method: "POST",
    headers: { origin: DEVELOPMENT_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ nonce: "short" }),
  });
  assert.equal(badNonce.status, 400);
  await badNonce.arrayBuffer();

  const wrongType = await fetch(`${base}/api/web-capture/identity`, {
    method: "POST",
    headers: { origin: DEVELOPMENT_ORIGIN, "content-type": "text/plain" },
    body: JSON.stringify({ nonce: "aaaaaaaaaaaaaaaaaaaaaaaaaa" }),
  });
  assert.equal(wrongType.status, 415);
  await wrongType.arrayBuffer();

  const nonce = "pair-nonce-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const challenge = await fetch(`${base}/api/web-capture/identity`, {
    method: "POST",
    headers: { origin: DEVELOPMENT_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ nonce }),
  });
  assert.equal(challenge.status, 200);
  const { proof } = await challenge.json();
  assert.equal(typeof proof, "string");
  const expected = webCaptureIdentityProof(token, { port, nonce });
  assert.equal(proof, expected, "the proof matches an independently computed HMAC");
  assert.equal(createHmac("sha256", token)
    .update("gravityport-web-capture-identity\0")
    .update(String(port))
    .update("\0")
    .update(nonce)
    .digest("base64url"), proof);

  const responseText = JSON.stringify({ proof });
  assert.equal(responseText.includes(token), false, "the challenge response never carries the token");

  const wrongOrigin = await fetch(`${base}/api/web-capture/identity`, {
    method: "POST",
    headers: { origin: "https://chatgpt.com", "content-type": "application/json" },
    body: JSON.stringify({ nonce }),
  });
  assert.equal(wrongOrigin.status, 403, "web page origins cannot challenge the service either");
  await wrongOrigin.arrayBuffer();
});
