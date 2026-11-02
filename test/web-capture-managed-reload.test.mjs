import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const dir = new URL("../extensions/chatgpt-web-capture/", import.meta.url);
const source = (await readFile(new URL("background.js", dir), "utf8"))
  .replace(/^import\s+"\.\/provider-policy.js";\s*$/m, "");
const policy = await readFile(new URL("provider-policy.js", dir), "utf8");
const APP = "http://127.0.0.1:43517";
const EXT = "chrome-extension://mock-extension-id/";
const MARKER = `${EXT}gravityport-managed.json`;
const DISK = `${EXT}manifest.json`;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function area(store) {
  return {
    async get(key) {
      if (key == null) return Object.fromEntries(store);
      if (typeof key === "string") return store.has(key) ? { [key]: store.get(key) } : {};
      return Object.fromEntries(Object.entries(key).map(([name, fallback]) => [name, store.has(name) ? store.get(name) : fallback]));
    },
    async set(values) { for (const [key, value] of Object.entries(values)) store.set(key, value); },
    async remove(key) { store.delete(key); },
  };
}

async function harness({ marker = { schema: 1, installId: "abc", version: "0.15.46" },
  instruction = { version: "0.15.46", installId: "abc" }, current = "0.15.45",
  disk = "0.15.46", stored = {}, markerStatus = 200 } = {}) {
  const local = new Map(Object.entries({ mosaBaseUrl: APP, mosaToken: "test-token", autoCapture: false, ...stored }));
  const session = new Map();
  const calls = [];
  const statusBodies = [];
  const listeners = [];
  const pending = [];
  let replyInstruction = instruction;
  const runtime = {
    id: "mock-extension-id", getURL: (path) => `${EXT}${path}`,
    getManifest: () => ({ version: current }),
    reload: () => { calls.push({ stored: local.get("mosaManagedReloadV1") }); },
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onStartup: { addListener() {} }, onInstalled: { addListener() {} },
  };
  const chrome = {
    runtime,
    storage: { local: area(local), session: area(session), sync: area(new Map()), onChanged: { addListener() {} } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    action: { onClicked: { addListener() {} }, setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    contextMenus: { onClicked: { addListener() {} }, removeAll: async () => {}, create() {} },
    commands: { onCommand: { addListener() {} } },
    windows: { onRemoved: { addListener() {} } },
    tabs: { sendMessage: async () => ({ ok: true }) },
  };
  const fetch = (url, init = {}) => {
    const href = String(url);
    if (href === MARKER) return markerStatus === 404 ? Promise.resolve(new Response(null, { status: 404 }))
      : Promise.resolve(marker === "invalid-json" ? new Response("not json") : json(marker));
    if (href === DISK) return Promise.resolve(json({ version: disk }));
    // Task 333: every token-bearing send first passes the identity challenge;
    // answer it like a real GravityPort holding the paired token.
    if (href.endsWith("/api/web-capture/identity")) {
      const parsed = new URL(href);
      const proof = createHmac("sha256", String(local.get("mosaToken") || ""))
        .update("gravityport-web-capture-identity\0")
        .update(parsed.port || "80")
        .update("\0")
        .update(String(JSON.parse(init.body || "{}").nonce || ""))
        .digest("base64url");
      return Promise.resolve(json({ proof }));
    }
    if (href.endsWith("/api/ingest/web-capture-status")) {
      statusBodies.push(JSON.parse(init.body));
      return Promise.resolve(json(replyInstruction ? { extensionReload: replyInstruction } : {}));
    }
    if (href.endsWith("/api/ingest/web-capture")) {
      return new Promise((resolve) => pending.push(() => resolve(json({ ok: true, assetId: "asset" }))));
    }
    if (href.startsWith("https://chatgpt.com/")) {
      return Promise.resolve(new Response(new Uint8Array(256), { headers: { "content-type": "image/png" } }));
    }
    return Promise.resolve(json({ product: "mosa" }));
  };
  // captureMediaSizes tolerates an unavailable IndexedDB; no media is required
  // in these status/reload cases. The queue itself remains real storage.local.
  const context = vm.createContext({ chrome, fetch, indexedDB: { open() { throw new Error("unavailable"); } },
    URL, URLSearchParams, Blob, AbortController, TextEncoder, crypto, atob, btoa,
    setTimeout, clearTimeout, queueMicrotask, console });
  new vm.Script(policy, { filename: "provider-policy.js" }).runInContext(context);
  new vm.Script(source, { filename: "background.js" }).runInContext(context);
  // Startup reports asynchronously and is allowed to complete before each explicit probe.
  await context.reportCaptureQueueStatus();
  await tick();
  calls.length = 0;
  statusBodies.length = 0;
  return {
    local, calls, statusBodies, context, pending,
    setInstruction(value) { replyInstruction = value; },
    async report() { const result = await context.reportCaptureQueueStatus(); await tick(); return result; },
    async beginLiveDelivery() {
      // Same live delivery entry as the queue harness, with the POST held open.
      const sender = { id: runtime.id, tab: { id: 12 }, url: "https://chatgpt.com/c/conv1", frameId: 0 };
      const result = new Promise((resolve) => listeners[0]({ type: "mosa.ingest", payload: {
        provider: "chatgpt", mediaKind: "image", imageUrl: "https://chatgpt.com/backend-api/estuary/content?id=file_test",
      } }, sender, resolve));
      for (let i = 0; i < 50 && !pending.length; i += 1) await tick();
      assert.equal(pending.length, 1, "live POST is in flight");
      return result;
    },
  };
}

test("1: missing marker reports null and runtime extension id", async () => {
  const h = await harness({ markerStatus: 404, instruction: null });
  await h.report();
  assert.equal(h.statusBodies[0].managedInstall, null);
  assert.equal(h.statusBodies[0].extensionId, "mock-extension-id");
});

test("2: schema 1 marker sends only installId", async () => {
  const h = await harness({ instruction: null });
  await h.report();
  assert.deepEqual(h.statusBodies[0].managedInstall, { installId: "abc" });
});

test("3: invalid schema or JSON reports null", async () => {
  for (const marker of [{ schema: 2, installId: "abc" }, "invalid-json", { schema: 1, installId: "" },
    { schema: 1, installId: "x".repeat(65) }]) {
    const h = await harness({ marker, instruction: null });
    await h.report();
    assert.equal(h.statusBodies[0].managedInstall, null);
  }
});

test("4: managed newer disk manifest reloads only after persistent attempt", async () => {
  const h = await harness({ instruction: null });
  h.setInstruction({ version: "0.15.46", installId: "abc" });
  assert.deepEqual({ ...await h.report() }, { reported: true, retryRequested: false });
  assert.equal(h.calls.length, 1);
  const attempt = h.calls[0].stored;
  assert.equal(attempt.version, "0.15.46");
  assert.equal(attempt.attempts, 1);
  assert.equal(typeof attempt.lastAt, "number");
});

for (const [number, label, opts] of [
  [5, "mismatched installation", { instruction: { version: "0.15.46", installId: "xyz" } }],
  [6, "no marker", { markerStatus: 404 }],
  [7, "same current version", { instruction: { version: "0.15.45", installId: "abc" } }],
  [8, "disk manifest is still old", { disk: "0.15.45" }],
  [10, "recent previous attempt", { stored: { mosaManagedReloadV1: { version: "0.15.46", attempts: 1, lastAt: Date.now() - 60_000 } } }],
  [11, "three prior attempts", { stored: { mosaManagedReloadV1: { version: "0.15.46", attempts: 3, lastAt: Date.now() - 3_600_000 } } }],
]) {
  test(`${number}: ${label} blocks reload`, async () => {
    const h = await harness({ ...opts, instruction: null });
    await h.context.maybeReloadForManagedUpdate(opts.instruction || { version: "0.15.46", installId: "abc" });
    assert.equal(h.calls.length, 0);
  });
}

test("9: active live delivery blocks reload", async () => {
  const h = await harness({ instruction: null });
  const active = h.beginLiveDelivery();
  for (let i = 0; i < 50 && !h.pending.length; i += 1) await tick();
  assert.equal(h.pending.length, 1);
  await h.context.maybeReloadForManagedUpdate({ version: "0.15.46", installId: "abc" });
  assert.equal(h.calls.length, 0);
  for (const release of h.pending) release();
  await active;
});

test("12: old version retry history resets to attempt 1", async () => {
  const h = await harness({ instruction: null, stored: { mosaManagedReloadV1: {
    version: "0.15.40", attempts: 3, lastAt: Date.now() - 60_000,
  } } });
  await h.context.maybeReloadForManagedUpdate({ version: "0.15.46", installId: "abc" });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].stored.attempts, 1);
});

test("13: existing queue items survive reload unchanged", async () => {
  const queue = [{ id: "one", payload: { provider: "chatgpt" }, createdAt: Date.now() },
    { id: "two", payload: { provider: "gemini" }, createdAt: Date.now() }];
  const h = await harness({ instruction: null });
  h.local.set("mosaCaptureQueueV1", queue);
  await h.context.maybeReloadForManagedUpdate({ version: "0.15.46", installId: "abc" });
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.local.get("mosaCaptureQueueV1"), queue);
});

test("14: no reload instruction preserves reported status", async () => {
  const h = await harness({ instruction: null });
  const result = await h.report();
  assert.deepEqual({ ...result }, { reported: true, retryRequested: false });
  assert.equal(h.calls.length, 0);
});

test("15: numeric dotted versions compare by segment", async () => {
  const h = await harness({ instruction: null });
  assert.equal(h.context.compareManagedExtensionVersions("0.15.10", "0.15.9"), 1);
  assert.equal(h.context.compareManagedExtensionVersions("1.0.0", "0.99.99"), 1);
  assert.equal(h.context.compareManagedExtensionVersions("0.15.45", "0.15.45"), 0);
});
