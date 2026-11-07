/**
 * Shared executable harness for the extension background service worker.
 * Runs background.js in a real vm context with mock chrome.* APIs,
 * an in-memory IndexedDB, and a programmable fetch.
 */

import { readFile } from "node:fs/promises";
import vm from "node:vm";

const extensionDir = new URL("../../extensions/chatgpt-web-capture/", import.meta.url);
export const backgroundSource = await readFile(new URL("background.js", extensionDir), "utf8");
export const providerPolicySource = await readFile(new URL("provider-policy.js", extensionDir), "utf8");

export const RUNTIME_ID = "test-extension-id";
export const PAIRING_TOKEN = "test-pairing-token";
export const BASE_URL = "http://127.0.0.1:43517";
export const QUEUE_KEY = "mosaCaptureQueueV1";
export const QUEUE_ALARM_NAME = "mosa-capture-queue";
export const MEDIA_DB = "mosa-web-capture-media-v1";
export const MEDIA_STORE = "media";
export const CHATGPT_TAB_URL = "https://chatgpt.com/c/conv1";
export const GEMINI_TAB_URL = "https://gemini.google.com/app/conv1";
export const FLOW_TAB_URL = "https://flow.google.com/conv1";
export const AI_STUDIO_TAB_URL = "https://aistudio.google.com/prompts/new_chat";
export const JIMENG_TAB_URL = "https://jimeng.jianying.com/ai-tool/asset";
export const MIDJOURNEY_TAB_URL = "https://www.midjourney.com/app";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function fakeImageBase64(byteLength) {
  const bytes = new Uint8Array(byteLength);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 7 + 13) % 251;
  return Buffer.from(bytes).toString("base64");
}

export const PNG_BYTES = new Uint8Array(256).map((_, index) => (index * 31 + 5) % 251);

export function pngResponse(status = 200) {
  return new Response(PNG_BYTES, { status, headers: { "content-type": "image/png" } });
}

export function statusResponse(status) {
  return new Response("no", { status });
}

class FakeIdbRequest {
  constructor() {
    this.onsuccess = null;
    this.onerror = null;
    this.result = undefined;
    this.error = null;
  }

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
  const listeners = { message: [], alarm: [], installed: [], startup: [], contextMenu: [] };
  const localStore = new Map();
  const sessionStore = new Map();
  const syncStore = new Map();
  const createdContextMenus = [];
  const createdWindows = [];
  const removedWindows = [];
  let optionsPageOpened = false;

  const chrome = {
    runtime: {
      id: RUNTIME_ID,
      getManifest: () => ({ version: "0.15.38" }),
      openOptionsPage: async () => { optionsPageOpened = true; },
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      __isOptionsPageOpened: () => optionsPageOpened,
    },
    storage: {
      local: storageArea(localStore),
      session: storageArea(sessionStore),
      sync: storageArea(syncStore),
      onChanged: { addListener: () => {} },
    },
    alarms: {
      create: () => {},
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
    },
    windows: {
      onRemoved: { addListener: () => {} },
      create: async (options) => {
        createdWindows.push(options);
        const win = { id: 70 + createdWindows.length, tabs: [{ id: 90 + createdWindows.length }], ...options };
        return win;
      },
      remove: async (windowId) => {
        removedWindows.push(windowId);
      },
      __created: createdWindows,
      __removed: removedWindows,
    },
    contextMenus: {
      removeAll: async () => { createdContextMenus.length = 0; },
      create: (options) => { createdContextMenus.push(options); },
      onClicked: { addListener: (fn) => listeners.contextMenu.push(fn) },
      __created: createdContextMenus,
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, onClicked: { addListener: () => {} } },
    commands: { onCommand: { addListener: () => {} } },
    tabs: { sendMessage: async () => { throw new Error("no receiver"); } },
  };
  return {
    chrome,
    listeners,
    localStore,
    sessionStore,
    syncStore,
    createdContextMenus,
    createdWindows,
    removedWindows,
    isOptionsPageOpened: () => optionsPageOpened,
  };
}

function createFetchHarness() {
  const appRequests = [];
  const mediaRequests = [];
  let appOnline = false;
  let mediaHandler = null;
  let appHandler = null;
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
      const custom = appHandler?.(parsed, init);
      if (custom) return Promise.resolve(custom);
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
    setAppHandler: (handler) => { appHandler = handler; },
    setErrorRealm: (errorConstructor) => { realmError = errorConstructor; },
  };
}

export async function createBackgroundHarness({
  appOnline = false,
  emptyStorage = false,
  settings = {},
  clock = undefined,
  fastTimers = false,
} = {}) {
  const chromeHarness = createChromeHarness();
  if (!emptyStorage) {
    chromeHarness.localStore.set("mosaBaseUrl", settings.mosaBaseUrl !== undefined ? settings.mosaBaseUrl : BASE_URL);
    chromeHarness.localStore.set("mosaToken", settings.mosaToken !== undefined ? settings.mosaToken : PAIRING_TOKEN);
    chromeHarness.localStore.set("autoCapture", settings.autoCapture !== undefined ? settings.autoCapture : false);
  }
  const fetchHarness = createFetchHarness();
  fetchHarness.setAppOnline(appOnline);
  const indexedDb = createFakeIndexedDb();

  const sandbox = {
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
    setTimeout: fastTimers
      ? (fn, delay, ...args) => setTimeout(fn, delay === 2_000 ? 5 : delay, ...args)
      : setTimeout,
    clearTimeout,
    queueMicrotask,
    console,
    Date: clock?.Date || Date,
  };

  const context = vm.createContext(sandbox);
  fetchHarness.setErrorRealm(context.Error);

  new vm.Script(providerPolicySource, { filename: "provider-policy.js" }).runInContext(context);
  const workerSource = backgroundSource.replace(/^import\s+".\/provider-policy.js";\s*$/m, "");
  new vm.Script(workerSource, { filename: "background.js" }).runInContext(context);

  return {
    context,
    chrome: chromeHarness.chrome,
    listeners: chromeHarness.listeners,
    localStore: chromeHarness.localStore,
    sessionStore: chromeHarness.sessionStore,
    syncStore: chromeHarness.syncStore,
    fetchHarness,
    indexedDb,
    createdContextMenus: chromeHarness.createdContextMenus,
    createdWindows: chromeHarness.createdWindows,
    removedWindows: chromeHarness.removedWindows,
    isOptionsPageOpened: chromeHarness.isOptionsPageOpened,
    async triggerInstalled(details = { reason: "install" }) {
      for (const listener of chromeHarness.listeners.installed) {
        await listener(details);
      }
    },
    async triggerStartup() {
      for (const listener of chromeHarness.listeners.startup) {
        await listener();
      }
    },
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
    fireAlarm(name = QUEUE_ALARM_NAME) {
      for (const listener of chromeHarness.listeners.alarm) listener({ name });
    },
    readQueue: async () => (await chromeHarness.chrome.storage.local.get({ [QUEUE_KEY]: [] }))[QUEUE_KEY],
    writeQueue: async (queue) => chromeHarness.chrome.storage.local.set({ [QUEUE_KEY]: queue }),
    mediaEntries: () => indexedDb.__dump(MEDIA_DB, MEDIA_STORE),
    seedMediaRecord: (record) => indexedDb.__put(MEDIA_DB, MEDIA_STORE, record),
  };
}

export function senderFor(pageUrl, { id = RUNTIME_ID, tabId = 11, frameId = 0 } = {}) {
  return { id, tab: { id: tabId }, url: pageUrl, frameId };
}

export function extensionPageSender(page = "options.html") {
  return { id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/${page}`, frameId: 0 };
}
