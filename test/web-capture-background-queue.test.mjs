// Executable harness for the extension background capture queue (review M10,
// task 227 / 226 fix A). The other extension tests only assert on background.js
// source text; this file actually runs it in a vm context with mock
// chrome.* APIs, an in-memory IndexedDB and a programmable fetch, so queue
// behavior — byte tickets, offline prefetch, retry give-up, byte budget and
// 7-day expiry — is exercised end to end.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const extensionDir = new URL("../extensions/chatgpt-web-capture/", import.meta.url);
const backgroundSource = await readFile(new URL("background.js", extensionDir), "utf8");
const providerPolicySource = await readFile(new URL("provider-policy.js", extensionDir), "utf8");

const RUNTIME_ID = "test-extension-id";
const PAIRING_TOKEN = "test-pairing-token";
const BASE_URL = "http://127.0.0.1:43517";
const QUEUE_KEY = "mosaCaptureQueueV1";
const QUEUE_ALARM_NAME = "mosa-capture-queue";
const MEDIA_DB = "mosa-web-capture-media-v1";
const MEDIA_STORE = "media";
const CHATGPT_TAB_URL = "https://chatgpt.com/c/conv1";
const GEMINI_TAB_URL = "https://gemini.google.com/app/conv1";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeImageBase64(byteLength) {
  const bytes = new Uint8Array(byteLength);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 7 + 13) % 251;
  return Buffer.from(bytes).toString("base64");
}

const PNG_BYTES = new Uint8Array(256).map((_, index) => (index * 31 + 5) % 251);

function pngResponse(status = 200) {
  return new Response(PNG_BYTES, { status, headers: { "content-type": "image/png" } });
}

function statusResponse(status) {
  return new Response("no", { status });
}

class FakeIdbRequest {
  constructor() {
    this.onsuccess = null;
    this.onerror = null;
    this.result = undefined;
    this.error = null;
  }

  // Deliver the result in a microtask, then release the transaction slot
  // after the handler ran (IDB-like: handlers see a settled request first).
  settle(result, error, onDelivered) {
    queueMicrotask(() => {
      this.result = result === undefined ? undefined : result;
      this.error = error || null;
      if (error) this.onerror?.();
      else this.onsuccess?.();
      onDelivered?.();
    });
  }
}

class FakeIdbTransaction {
  constructor(storeMap) {
    this.storeMap = storeMap;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.__pending = 0;
    this.__done = false;
    this.__error = null;
    queueMicrotask(() => this.__settle());
  }

  __acquire() {
    this.__pending += 1;
    return () => {
      this.__pending -= 1;
      queueMicrotask(() => this.__settle());
    };
  }

  __settle() {
    if (this.__done || this.__pending > 0) return;
    this.__done = true;
    if (this.__error) this.onerror?.();
    else this.oncomplete?.();
  }

  __fail(request, error) {
    this.__error = this.__error || error;
    request.settle(undefined, error, this.__acquire());
  }

  objectStore() {
    const tx = this;
    return {
      put(record) {
        const request = new FakeIdbRequest();
        if (tx.__done) {
          tx.__fail(request, tx.__error || new Error("Transaction already finished."));
          return request;
        }
        tx.storeMap.set(record.key, record);
        request.settle(record.key, null, tx.__acquire());
        return request;
      },
      get(key) {
        const request = new FakeIdbRequest();
        const value = tx.storeMap.has(key) ? tx.storeMap.get(key) : null;
        request.settle(value, null, tx.__acquire());
        return request;
      },
      delete(key) {
        const request = new FakeIdbRequest();
        if (tx.__done) {
          tx.__fail(request, tx.__error || new Error("Transaction already finished."));
          return request;
        }
        tx.storeMap.delete(key);
        request.settle(undefined, null, tx.__acquire());
        return request;
      },
      openCursor() {
        const request = new FakeIdbRequest();
        if (tx.__done) {
          tx.__fail(request, tx.__error || new Error("Transaction already finished."));
          return request;
        }
        const release = tx.__acquire();
        const entries = [...tx.storeMap.entries()];
        let position = 0;
        const deliver = () => {
          if (position >= entries.length) {
            request.settle(undefined, null, release);
            return;
          }
          const [key, value] = entries[position];
          position += 1;
          const cursor = { key, value, continue: () => queueMicrotask(deliver) };
          request.settle(cursor, null, null);
        };
        queueMicrotask(deliver);
        return request;
      },
    };
  }
}

function createFakeIndexedDb() {
  const databases = new Map();
  const api = {
    open(name, version = 1) {
      const request = new FakeIdbRequest();
      queueMicrotask(() => {
        let db = databases.get(name);
        let upgraded = false;
        if (!db) {
          db = { version: 0, stores: new Map() };
          databases.set(name, db);
        }
        const handle = {
          close: () => {},
          objectStoreNames: { contains: (storeName) => db.stores.has(storeName) },
          createObjectStore: (storeName) => db.stores.set(storeName, new Map()),
          transaction: (storeName) => {
            if (!db.stores.has(storeName)) db.stores.set(storeName, new Map());
            return new FakeIdbTransaction(db.stores.get(storeName));
          },
        };
        if (version > db.version) {
          db.version = version;
          upgraded = true;
        }
        request.result = handle;
        if (upgraded) request.onupgradeneeded?.();
        queueMicrotask(() => request.onsuccess?.());
      });
      return request;
    },
    __dump(dbName, storeName) {
      return [...(databases.get(dbName)?.stores.get(storeName)?.entries() || [])];
    },
    __put(dbName, storeName, record) {
      if (!databases.has(dbName)) databases.set(dbName, { version: 1, stores: new Map() });
      const db = databases.get(dbName);
      if (!db.stores.has(storeName)) db.stores.set(storeName, new Map());
      db.stores.get(storeName).set(record.key, record);
    },
  };
  return api;
}

function storageArea(store) {
  return {
    get(query = null) {
      if (query === null || query === undefined) return Promise.resolve(Object.fromEntries(store));
      if (Array.isArray(query)) {
        const out = {};
        for (const key of query) if (store.has(key)) out[key] = store.get(key);
        return Promise.resolve(out);
      }
      if (typeof query === "object") {
        const out = {};
        for (const [key, fallback] of Object.entries(query)) out[key] = store.has(key) ? store.get(key) : fallback;
        return Promise.resolve(out);
      }
      const out = {};
      if (store.has(String(query))) out[String(query)] = store.get(String(query));
      return Promise.resolve(out);
    },
    set(patch) {
      for (const [key, value] of Object.entries(patch)) store.set(key, value);
      return Promise.resolve();
    },
    remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
      return Promise.resolve();
    },
  };
}

function createChromeHarness() {
  const listeners = { message: [], alarm: [] };
  const localStore = new Map();
  const chrome = {
    runtime: {
      id: RUNTIME_ID,
      getManifest: () => ({ version: "0.15.38" }),
      openOptionsPage: async () => {},
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onStartup: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
    },
    storage: {
      local: storageArea(localStore),
      session: storageArea(new Map()),
      sync: storageArea(new Map()),
      onChanged: { addListener: () => {} },
    },
    alarms: {
      create: () => {},
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
    },
    windows: {
      onRemoved: { addListener: () => {} },
      create: async () => null,
      remove: async () => {},
    },
    contextMenus: { removeAll: async () => {}, create: () => {}, onClicked: { addListener: () => {} } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, onClicked: { addListener: () => {} } },
    commands: { onCommand: { addListener: () => {} } },
    tabs: { sendMessage: async () => { throw new Error("no receiver"); } },
  };
  return { chrome, listeners, localStore };
}

function createFetchHarness() {
  const appRequests = [];
  const mediaRequests = [];
  let appOnline = false;
  let mediaHandler = null;
  let realmError = Error;
  const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
  const fetchImpl = (url, init = {}) => {
    const href = String(url);
    const parsed = new URL(href);
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    const record = {
      url: href,
      method: String(init.method || "GET"),
      headers: init.headers || {},
      body: typeof init.body === "string" ? init.body : null,
    };
    if (loopback) {
      appRequests.push(record);
      if (!appOnline) return Promise.reject(new realmError(`connection refused: ${href}`));
      if (parsed.pathname === "/api/health") return Promise.resolve(jsonResponse({ product: "mosa" }));
      if (parsed.pathname === "/api/web-capture/pair") return Promise.resolve(jsonResponse({ product: "mosa", token: "paired-token" }));
      if (parsed.pathname === "/api/ingest/web-capture-status") return Promise.resolve(jsonResponse({ retryRequestId: 0 }));
      if (parsed.pathname === "/api/ingest/web-capture") return Promise.resolve(jsonResponse({ ok: true, assetId: "asset-1" }));
      return Promise.resolve(jsonResponse({ ok: true }));
    }
    mediaRequests.push(record);
    if (!mediaHandler) return Promise.reject(new realmError(`connection refused: ${href}`));
    return Promise.resolve(mediaHandler(parsed, init));
  };
  return {
    fetchImpl,
    appRequests,
    mediaRequests,
    setAppOnline: (value) => { appOnline = value; },
    setMediaHandler: (handler) => { mediaHandler = handler; },
    setErrorRealm: (errorConstructor) => { realmError = errorConstructor; },
  };
}

async function createHarness({ appOnline = false } = {}) {
  const chromeHarness = createChromeHarness();
  chromeHarness.localStore.set("mosaBaseUrl", BASE_URL);
  chromeHarness.localStore.set("mosaToken", PAIRING_TOKEN);
  chromeHarness.localStore.set("autoCapture", false);
  const fetchHarness = createFetchHarness();
  fetchHarness.setAppOnline(appOnline);
  const indexedDb = createFakeIndexedDb();

  const context = vm.createContext({
    chrome: chromeHarness.chrome,
    fetch: fetchHarness.fetchImpl,
    indexedDB: indexedDb,
    URL,
    URLSearchParams,
    Blob,
    AbortController,
    TextEncoder,
    atob,
    btoa,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    console,
  });
  fetchHarness.setErrorRealm(context.Error);

  // provider-policy.js is a plain IIFE attaching to globalThis; background.js
  // is an ES module only for its single import line, which the policy
  // evaluation replaces.
  new vm.Script(providerPolicySource, { filename: "provider-policy.js" }).runInContext(context);
  const workerSource = backgroundSource.replace(/^import\s+".\/provider-policy.js";\s*$/m, "");
  new vm.Script(workerSource, { filename: "background.js" }).runInContext(context);

  return {
    context,
    chrome: chromeHarness.chrome,
    listeners: chromeHarness.listeners,
    localStore: chromeHarness.localStore,
    fetchHarness,
    indexedDb,
    dispatchMessage(message, sender) {
      return new Promise((resolve, reject) => {
        const listener = chromeHarness.listeners.message[0];
        let settled = false;
        const sendResponse = (response) => {
          if (settled) return;
          settled = true;
          resolve(response);
        };
        const keepOpen = listener(message, sender, sendResponse);
        if (keepOpen !== true && !settled) {
          settled = true;
          resolve(null);
        }
        setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error("sendResponse was never called"));
          }
        }, 8_000);
      });
    },
    fireAlarm() {
      for (const listener of chromeHarness.listeners.alarm) listener({ name: QUEUE_ALARM_NAME });
    },
    readQueue: async () => (await chromeHarness.chrome.storage.local.get({ [QUEUE_KEY]: [] }))[QUEUE_KEY],
    writeQueue: async (queue) => chromeHarness.chrome.storage.local.set({ [QUEUE_KEY]: queue }),
    mediaEntries: () => indexedDb.__dump(MEDIA_DB, MEDIA_STORE),
    seedMediaRecord: (record) => indexedDb.__put(MEDIA_DB, MEDIA_STORE, record),
  };
}

function senderFor(pageUrl) {
  return { id: RUNTIME_ID, tab: { id: 11 }, url: pageUrl, frameId: 0 };
}

async function waitFor(poll, { timeoutMs = 5_000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await poll();
    if (value) return value;
    await sleep(10);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function ingestCalls(harness) {
  return harness.fetchHarness.appRequests.filter((request) => request.url === `${BASE_URL}/api/ingest/web-capture`);
}

test("queues keep the image bytes for an https URL and replay them without re-downloading", async () => {
  const harness = await createHarness();
  const imageBase64 = fakeImageBase64(1024);
  const payload = {
    provider: "chatgpt",
    mediaKind: "image",
    imageUrl: "https://chatgpt.com/backend-api/estuary/content?id=file_abc&cid=conv1",
    imageBase64,
    mimeType: "image/png",
    prompt: "a red cube",
    promptStatus: "user-message",
  };

  const response = await harness.dispatchMessage({ type: "mosa.ingest", payload }, senderFor(CHATGPT_TAB_URL));
  assert.equal(response?.ok, false, "GravityPort is offline, so the live ingest must fail");

  const queue = await harness.readQueue();
  assert.equal(queue.length, 1);
  assert.ok(queue[0].payload.queuedMediaId, "https URLs with bytes must become byte tickets");
  assert.equal(queue[0].payload.queuedMediaId, queue[0].id);
  assert.equal(queue[0].payload.imageBase64, undefined, "bytes live in IndexedDB, not in the ticket");
  assert.equal(queue[0].payload.imageUrl, payload.imageUrl, "the URL stays for provenance");
  assert.equal(harness.fetchHarness.mediaRequests.length, 0, "enqueue must not fetch the URL it has bytes for");

  let entries = harness.mediaEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0][0], `capture:${queue[0].id}`);
  assert.equal(entries[0][1].blob.size, Buffer.from(imageBase64, "base64").byteLength);

  harness.fetchHarness.setAppOnline(true);
  harness.fireAlarm();
  await waitFor(async () => {
    if (ingestCalls(harness).length === 0) return null;
    const current = await harness.readQueue();
    return current.length === 0 ? current : null;
  }, { label: "replay ingest finished and ticket removed" });
  const replayBody = JSON.parse(ingestCalls(harness)[0].body);
  assert.equal(replayBody.imageBase64, imageBase64, "replay must upload the stored bytes");
  assert.equal(replayBody.sourceMediaUrl, "https://chatgpt.com/backend-api/estuary/content?id=file_abc&cid=conv1",
    "the sanitized provenance URL survives the byte-ticket replay");

  assert.equal((await harness.readQueue()).length, 0, "ticket leaves the queue after a successful replay");
  entries = harness.mediaEntries();
  assert.equal(entries.length, 0, "stored bytes are deleted after the replay");
  assert.equal(harness.fetchHarness.mediaRequests.length, 0, "replay must not re-download the URL");
});

test("URL-only captures prefetch bytes while offline and upgrade to byte tickets", async () => {
  const harness = await createHarness();
  harness.fetchHarness.setMediaHandler(() => pngResponse());
  const payload = {
    provider: "gemini",
    mediaKind: "image",
    imageUrl: "https://lh3.googleusercontent.com/generated-figure",
    promptStatus: "not-available",
  };

  const response = await harness.dispatchMessage({ type: "mosa.ingest", payload }, senderFor(GEMINI_TAB_URL));
  assert.equal(response?.ok, false);

  const queue = await harness.readQueue();
  assert.equal(queue.length, 1);
  assert.ok(queue[0].payload.queuedMediaId, "a successful prefetch upgrades the ticket to bytes");
  assert.equal(queue[0].payload.mimeType, "image/png");
  assert.equal(queue[0].payload.imageBase64, undefined);
  assert.equal(harness.fetchHarness.mediaRequests.length, 1, "exactly one prefetch fetch");
  assert.equal(harness.mediaEntries()[0][1].blob.size, PNG_BYTES.byteLength);

  harness.fetchHarness.setAppOnline(true);
  harness.fireAlarm();
  await waitFor(async () => {
    if (ingestCalls(harness).length === 0) return null;
    const current = await harness.readQueue();
    return current.length === 0 ? current : null;
  }, { label: "replay ingest finished and ticket removed" });
  const replayBody = JSON.parse(ingestCalls(harness)[0].body);
  assert.equal(Buffer.from(replayBody.imageBase64, "base64").byteLength, PNG_BYTES.byteLength);
  assert.equal(harness.fetchHarness.mediaRequests.length, 1, "replay must not fetch again");
});

test("a failed prefetch leaves the plain URL ticket in place", async () => {
  const harness = await createHarness();
  harness.fetchHarness.setMediaHandler(() => statusResponse(403));
  const payload = {
    provider: "gemini",
    mediaKind: "image",
    imageUrl: "https://lh3.googleusercontent.com/expired-figure",
    promptStatus: "not-available",
  };

  const response = await harness.dispatchMessage({ type: "mosa.ingest", payload }, senderFor(GEMINI_TAB_URL));
  assert.equal(response?.ok, false);

  const queue = await harness.readQueue();
  assert.equal(queue.length, 1);
  assert.equal(queue[0].payload.queuedMediaId, undefined, "a failed prefetch keeps the URL ticket");
  assert.equal(queue[0].payload.imageUrl, payload.imageUrl);
  assert.equal(harness.mediaEntries().length, 0);
  assert.equal(harness.fetchHarness.mediaRequests.length, 3, "all fetch attempts (include/omit/force-cache) ran");
});

test("expired URL tickets (403) give up after three attempts; 5xx keeps retrying", async () => {
  const harness = await createHarness();
  harness.fetchHarness.setMediaHandler(() => statusResponse(403));
  const payload = {
    provider: "gemini",
    mediaKind: "image",
    imageUrl: "https://lh3.googleusercontent.com/expired-figure",
    promptStatus: "not-available",
  };
  await harness.dispatchMessage({ type: "mosa.ingest", payload }, senderFor(GEMINI_TAB_URL));

  harness.fetchHarness.setAppOnline(true);

  harness.fireAlarm();
  let queue = await waitFor(async () => {
    const current = await harness.readQueue();
    return Number(current[0]?.attempts || 0) >= 1 ? current : null;
  }, { label: "first failure recorded" });
  assert.match(queue[0].lastError, /403/);
  assert.match(queue[0].lastError, /网址已过期/);

  harness.fireAlarm();
  queue = await waitFor(async () => {
    const current = await harness.readQueue();
    return Number(current[0]?.attempts || 0) >= 2 ? current : null;
  }, { label: "second failure recorded" });
  assert.equal(queue.length, 1);

  harness.fireAlarm();
  await waitFor(async () => (await harness.readQueue()).length === 0, { label: "ticket removed after 3 attempts" });
});

test("503 URL downloads stay queued and keep retrying", async () => {
  const harness = await createHarness();
  harness.fetchHarness.setMediaHandler(() => statusResponse(503));
  const payload = {
    provider: "gemini",
    mediaKind: "image",
    imageUrl: "https://lh3.googleusercontent.com/temporarily-down",
    promptStatus: "not-available",
  };
  await harness.dispatchMessage({ type: "mosa.ingest", payload }, senderFor(GEMINI_TAB_URL));
  harness.fetchHarness.setAppOnline(true);

  for (let round = 1; round <= 3; round += 1) {
    harness.fireAlarm();
    const queue = await waitFor(async () => {
      const current = await harness.readQueue();
      return Number(current[0]?.attempts || 0) >= round ? current : null;
    }, { label: `attempt ${round} recorded` });
    assert.equal(queue.length, 1, "a 503 URL ticket is never removed");
    assert.doesNotMatch(queue[0].lastError, /网址已过期/);
    assert.match(queue[0].lastError, /503/);
  }
});

test("the byte budget evicts the oldest ticket's bytes, downgrading or removing it", async () => {
  const harness = await createHarness();
  const fiveMb = 5 * 1024 * 1024;
  const oldUrlTicket = {
    id: "capture-oldurl",
    payload: { provider: "gemini", mediaKind: "image", imageUrl: "https://lh3.googleusercontent.com/old1", queuedMediaId: "oldurl" },
    createdAt: Date.now() - 5_000,
    attempts: 0,
    lastError: "",
  };
  const oldBlobTicket = {
    id: "capture-oldblob",
    payload: { provider: "chatgpt", mediaKind: "image", imageUrl: "blob:https://chatgpt.com/old2", queuedMediaId: "oldblob" },
    createdAt: Date.now() - 4_000,
    attempts: 0,
    lastError: "",
  };
  await harness.writeQueue([oldUrlTicket, oldBlobTicket]);
  // Fake blobs: budget accounting only reads blob.size.
  harness.seedMediaRecord({ key: "capture:oldurl", blob: { size: 300 * 1024 * 1024 }, updatedAt: 1 });
  harness.seedMediaRecord({ key: "capture:oldblob", blob: { size: 250 * 1024 * 1024 }, updatedAt: 1 });

  // A fresh ~0.2MB byte ticket pushes the total over the 512MB budget.
  const imageBase64 = fakeImageBase64(200 * 1024);
  await harness.dispatchMessage({
    type: "mosa.ingest",
    payload: {
      provider: "chatgpt",
      mediaKind: "image",
      imageUrl: "https://chatgpt.com/backend-api/estuary/content?id=file_new&cid=conv1",
      imageBase64,
      mimeType: "image/png",
    },
  }, senderFor(CHATGPT_TAB_URL));

  const queue = await harness.readQueue();
  assert.equal(queue.length, 3, "a downgraded ticket stays as a URL ticket");
  const downgraded = queue.find((item) => item.id === "capture-oldurl");
  assert.ok(downgraded, "the oldest ticket is evicted first");
  assert.equal(downgraded.payload.queuedMediaId, undefined, "its bytes are dropped");
  assert.equal(downgraded.payload.imageUrl, "https://lh3.googleusercontent.com/old1", "it is downgraded to a URL ticket");
  const keptBlobTicket = queue.find((item) => item.id === "capture-oldblob");
  assert.equal(keptBlobTicket.payload.queuedMediaId, "oldblob", "the next ticket is untouched");
  const freshTicket = queue.find((item) => item.payload.queuedMediaId && item.payload.queuedMediaId !== "oldblob");
  assert.ok(freshTicket, "the new byte ticket survives (eviction stops under budget)");
  assert.equal(harness.mediaEntries().some(([key]) => key === "capture:oldurl"), false, "evicted bytes are deleted");
  assert.equal(harness.mediaEntries().some(([key]) => key === "capture:oldblob"), true);
});

test("budget eviction removes byte-only tickets without any URL entirely", async () => {
  const harness = await createHarness();
  const orphan = {
    id: "capture-orphan",
    payload: { provider: "chatgpt", mediaKind: "image", imageUrl: "blob:https://chatgpt.com/orphan", queuedMediaId: "orphan" },
    createdAt: Date.now() - 1_000,
    attempts: 0,
    lastError: "",
  };
  await harness.writeQueue([orphan]);
  harness.seedMediaRecord({ key: "capture:orphan", blob: { size: 600 * 1024 * 1024 }, updatedAt: 1 });

  await harness.context.enforceCaptureQueueBudget();

  assert.equal((await harness.readQueue()).length, 0, "no URL to fall back to: the ticket is removed");
  assert.equal(harness.mediaEntries().length, 0, "and its bytes are deleted");
});

test("7-day expiry still clears tickets together with their stored bytes", async () => {
  const harness = await createHarness();
  const imageBase64 = fakeImageBase64(512);
  await harness.dispatchMessage({
    type: "mosa.ingest",
    payload: {
      provider: "chatgpt",
      mediaKind: "image",
      imageUrl: "https://chatgpt.com/backend-api/estuary/content?id=file_old&cid=conv1",
      imageBase64,
      mimeType: "image/png",
    },
  }, senderFor(CHATGPT_TAB_URL));

  const queue = await harness.readQueue();
  assert.equal(queue.length, 1);
  assert.ok(queue[0].payload.queuedMediaId);
  const aged = { ...queue[0], createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000 };
  await harness.writeQueue([aged]);

  harness.fetchHarness.setAppOnline(true);
  harness.fireAlarm();
  await waitFor(async () => (await harness.readQueue()).length === 0, { label: "aged ticket pruned" });
  assert.equal(harness.mediaEntries().length, 0, "the stored bytes are pruned with the ticket");
});

test("enqueueing a typical 2MB image stays in the millisecond range (harness estimate)", async () => {
  const harness = await createHarness();
  const durations = [];
  for (let round = 0; round < 5; round += 1) {
    const imageBase64 = fakeImageBase64(2 * 1024 * 1024);
    const startedAt = performance.now();
    await harness.dispatchMessage({
      type: "mosa.ingest",
      payload: {
        provider: "chatgpt",
        mediaKind: "image",
        imageUrl: `https://chatgpt.com/backend-api/estuary/content?id=file_bench${round}&cid=conv1`,
        imageBase64,
        mimeType: "image/png",
      },
    }, senderFor(CHATGPT_TAB_URL));
    durations.push(performance.now() - startedAt);
  }
  durations.sort((a, b) => a - b);
  const median = durations[Math.floor(durations.length / 2)];
  // The dispatch includes the failed live-ingest attempt against the offline
  // App, so this is an upper bound for the enqueue itself. Chrome's real
  // IndexedDB adds disk time on top; the harness only measures the
  // extension's own work (decode, blob wrap, IDB write, budget scan).
  console.log(`enqueue of a 2MiB image: median ${median.toFixed(1)}ms (harness, 5 runs: ${durations.map((value) => value.toFixed(1)).join(", ")})`);
  assert.ok(median < 500, `enqueue should stay far below a second, got ${median.toFixed(1)}ms`);
});
