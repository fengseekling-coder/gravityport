// Task 258: provider-site deletion sync. When the user deletes a work on the
// provider site itself (Jimeng's /mweb/v1/remove_history for now), GravityPort
// moves the matching capture to its trash — unless the user organized it here
// (favorited, rated, grouped, or tagged). The extension part is exercised with
// the real request/response shapes captured from the live site (2026-10-26):
// the request body is a JSON string
// {"item_id_list_map":{"<recordId>":["<itemId>",…]}} and the success reply is
// {"ret":"0",…} over HTTP 200. Values below are synthetic but byte-shaped.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import sharp from "sharp";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { ingestWebCapture, createWebCaptureIngest } from "../lib/web-capture-ingest.js";
import {
  applyProviderDeletions,
  normalizeProviderDeletionItems,
  readProviderDeletionSettings,
  writeProviderDeletionSettings,
} from "../lib/provider-deletion-sync.mjs";
import { handleBridgeRoute, isWebCaptureApiPath } from "../lib/api/bridge-routes.mjs";

const extensionRoot = new URL("../extensions/chatgpt-web-capture/", import.meta.url);
const backgroundSource = await readFile(new URL("background.js", extensionRoot), "utf8");
const providerPolicySource = await readFile(new URL("provider-policy.js", extensionRoot), "utf8");
const jimengHookSource = await readFile(new URL("jimeng-page-hook.js", extensionRoot), "utf8");
const providerJimengSource = await readFile(new URL("provider-jimeng.js", extensionRoot), "utf8");

// The live sample the user produced by deleting two works on the Jimeng
// "资产" page (request body verbatim; reply verbatim).
const REMOVE_HISTORY_BODY = '{"item_id_list_map":{"45764385435404":["7689895316266716440"]}}';
const REMOVE_HISTORY_SUCCESS = '{"ret":"0","errmsg":"success","systime":"1793026609","logid":"2026102622564989F44EE69599345F6503"}';
const REMOVE_HISTORY_URL = "https://jimeng.jianying.com/mweb/v1/remove_history?aid=513084&web_version=7.6.4&da_version=3.0.0&aigc_features=FEATQ1";

// High-entropy raster so compressed size exceeds the logo gate (~20KiB); a
// seed per asset keeps content hashes distinct so captures never dedupe.
async function jpegBase64(seed) {
  const width = 720;
  const height = 960;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 37 + seed * 17 + (i % 251)) & 255;
  const buf = await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
  return buf.toString("base64");
}

async function makeLibrary() {
  const root = await mkdtemp(join(tmpdir(), "mosa-provider-delete-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  return { root, libraryDir, store };
}

let nextImageSeed = 1;
async function ingestJimengCapture(store, projectId, { itemId, recordId = "49017522166284" }) {
  const base64 = await jpegBase64(nextImageSeed);
  nextImageSeed += 1;
  const imported = await ingestWebCapture({
    store,
    tempRoot: join(store.libraryDir, ".web-capture-tmp"),
    projectId,
    input: {
      provider: "jimeng",
      mediaKind: "image",
      imageBase64: base64,
      mimeType: "image/jpeg",
      providerAssetId: itemId,
      conversationId: recordId,
      generationContextId: recordId,
      pageUrl: "https://jimeng.jianying.com/ai-tool/asset",
    },
  });
  assert.equal(imported.status, "imported");
  return imported.asset;
}

async function assetInTrash(store, projectId, assetId) {
  const asset = await store.getAsset(projectId, assetId);
  return Boolean(asset.deleted_at);
}

// ---------------------------------------------------------------- sync core

test("an unorganized jimeng capture moves to the trash and can be restored", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    const asset = await ingestJimengCapture(store, "default", { itemId: "7700970082708589849" });
    const result = await applyProviderDeletions({ store, libraryDir }, {
      provider: "jimeng",
      items: [{ recordId: "49017522166284", itemId: "7700970082708589849" }],
    });
    assert.deepEqual(result, { trashed: 1, kept: 0, notFound: 0 });
    assert.equal(await assetInTrash(store, "default", asset.id), true);
    // 移进回收站 = recoverable, not a permanent delete.
    await store.restoreAsset("default", asset.id);
    assert.equal(await assetInTrash(store, "default", asset.id), false);
  } finally {
    store.close?.();
  }
});

test("favorited, rated, grouped and tagged captures are kept", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    const favorited = await ingestJimengCapture(store, "default", { itemId: "7700970082708589849" });
    await store.updateMetadata("default", favorited.id, { favorite: true });
    const rated = await ingestJimengCapture(store, "default", { itemId: "7700970082708589850" });
    await store.updateMetadata("default", rated.id, { rating: 4 });
    const grouped = await ingestJimengCapture(store, "default", { itemId: "7700970082708589851" });
    await store.updateMetadata("default", grouped.id, { group: "好图" });
    const tagged = await ingestJimengCapture(store, "default", { itemId: "7700970082708589852" });
    await store.updateMetadata("default", tagged.id, { tags: ["风景"] });

    const result = await applyProviderDeletions({ store, libraryDir }, {
      provider: "jimeng",
      items: [
        { recordId: "49017522166284", itemId: "7700970082708589849" },
        { recordId: "49017522166284", itemId: "7700970082708589850" },
        { recordId: "49017522166284", itemId: "7700970082708589851" },
        { recordId: "49017522166284", itemId: "7700970082708589852" },
      ],
    });
    assert.deepEqual(result, { trashed: 0, kept: 4, notFound: 0 });
    for (const asset of [favorited, rated, grouped, tagged]) {
      assert.equal(await assetInTrash(store, "default", asset.id), false);
    }
  } finally {
    store.close?.();
  }
});

test("unknown item ids count as notFound and leave the library untouched", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    const asset = await ingestJimengCapture(store, "default", { itemId: "7700970082708589849" });
    const before = await store.listAssets({ projectId: "default" });
    const result = await applyProviderDeletions({ store, libraryDir }, {
      provider: "jimeng",
      items: [{ recordId: "45764385435404", itemId: "1234567890" }],
    });
    assert.deepEqual(result, { trashed: 0, kept: 0, notFound: 1 });
    assert.equal(await assetInTrash(store, "default", asset.id), false);
    assert.equal((await store.listAssets({ projectId: "default" })).length, before.length);
  } finally {
    store.close?.();
  }
});

test("the same item id under another provider is not touched", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    const chatgptResult = await ingestWebCapture({
      store,
      tempRoot: join(store.libraryDir, ".web-capture-tmp"),
      projectId: "default",
      input: {
        provider: "chatgpt",
        mediaKind: "image",
        imageBase64: await jpegBase64(nextImageSeed++),
        mimeType: "image/jpeg",
        providerAssetId: "7700970082708589849",
        pageUrl: "https://chatgpt.com/c/conv",
      },
    });
    assert.equal(chatgptResult.status, "imported");
    const chatgptAsset = chatgptResult.asset;
    const result = await applyProviderDeletions({ store, libraryDir }, {
      provider: "jimeng",
      items: [{ recordId: "45764385435404", itemId: "7700970082708589849" }],
    });
    assert.deepEqual(result, { trashed: 0, kept: 0, notFound: 1 });
    assert.equal(await assetInTrash(store, "default", chatgptAsset.id), false);
  } finally {
    store.close?.();
  }
});

test("the disabled switch leaves everything alone and reports disabled", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    await writeProviderDeletionSettings(libraryDir, { jimengDeleteSyncEnabled: false });
    const asset = await ingestJimengCapture(store, "default", { itemId: "7700970082708589849" });
    const result = await applyProviderDeletions({ store, libraryDir }, {
      provider: "jimeng",
      items: [{ recordId: "45764385435404", itemId: "7700970082708589849" }, { recordId: "r", itemId: "42" }],
    });
    assert.deepEqual(result, { trashed: 0, kept: 0, notFound: 2, disabled: true });
    assert.equal(await assetInTrash(store, "default", asset.id), false);
  } finally {
    store.close?.();
  }
});

test("captures in a second project are found and trashed", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    await store.ensureProject("second");
    const asset = await ingestJimengCapture(store, "second", { itemId: "7700970082708589855" });
    const result = await applyProviderDeletions({ store, libraryDir }, {
      provider: "jimeng",
      items: [{ recordId: "45764385435404", itemId: "7700970082708589855" }],
    });
    assert.deepEqual(result, { trashed: 1, kept: 0, notFound: 0 });
    assert.equal(await assetInTrash(store, "second", asset.id), true);
  } finally {
    store.close?.();
  }
});

test("an already trashed capture is skipped without counting and without errors", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    const asset = await ingestJimengCapture(store, "default", { itemId: "7700970082708589849" });
    await store.deleteAsset("default", asset.id);
    const result = await applyProviderDeletions({ store, libraryDir }, {
      provider: "jimeng",
      items: [{ recordId: "45764385435404", itemId: "7700970082708589849" }],
    });
    assert.deepEqual(result, { trashed: 0, kept: 0, notFound: 0 });
    assert.equal(await assetInTrash(store, "default", asset.id), true);
  } finally {
    store.close?.();
  }
});

test("malformed item ids are dropped, duplicates collapse, and the batch caps at 200", async () => {
  assert.deepEqual(
    normalizeProviderDeletionItems([
      { recordId: "r1", itemId: "not-a-number" },
      { recordId: "r2", itemId: "1".repeat(33) },
      { recordId: "r3", itemId: "42" },
      { recordId: "r4", itemId: 43 },
      { recordId: "r5", itemId: "42" },
      null,
      "42",
    ]),
    [{ recordId: "r3", itemId: "42" }, { recordId: "r4", itemId: "43" }],
  );
  const longBatch = Array.from({ length: 201 }, (_, index) => ({ recordId: "r", itemId: String(9_000_000_000_000_000_000n + BigInt(index)) }));
  assert.equal(normalizeProviderDeletionItems(longBatch).length, 200);
  // The store path sees the same rules: only the 200 valid ids are looked up.
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    const result = await applyProviderDeletions({ store, libraryDir }, {
      provider: "jimeng",
      items: [{ recordId: "r", itemId: "abc" }, { recordId: "r", itemId: "1".repeat(33) }, { recordId: "r", itemId: "777" }],
    });
    assert.deepEqual(result, { trashed: 0, kept: 0, notFound: 1 });
  } finally {
    store.close?.();
  }
});

test("unsupported providers and non-object payloads are rejected", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await assert.rejects(
      () => applyProviderDeletions({ store, libraryDir }, { provider: "flow", items: [{ itemId: "42" }] }),
      (error) => error.code === "WEB_CAPTURE_PROVIDER_DELETION_INVALID",
    );
    await assert.rejects(
      () => applyProviderDeletions({ store, libraryDir }, {}),
      (error) => error.code === "WEB_CAPTURE_PROVIDER_DELETION_INVALID",
    );
  } finally {
    store.close?.();
  }
});

test("the settings file defaults to enabled and persists explicit changes", async () => {
  const { libraryDir } = await makeLibrary();
  assert.deepEqual(await readProviderDeletionSettings(libraryDir), { jimengDeleteSyncEnabled: true });
  assert.deepEqual(
    await writeProviderDeletionSettings(libraryDir, { jimengDeleteSyncEnabled: false }),
    { jimengDeleteSyncEnabled: false },
  );
  assert.deepEqual(await readProviderDeletionSettings(libraryDir), { jimengDeleteSyncEnabled: false });
  // A corrupt file falls back to the default instead of throwing.
  await writeFile(join(libraryDir, ".provider-deletion-sync.json"), "{not json", "utf8");
  assert.deepEqual(await readProviderDeletionSettings(libraryDir), { jimengDeleteSyncEnabled: true });
  await rm(join(libraryDir, ".provider-deletion-sync.json"), { force: true });
});

// -------------------------------------------------------------------- route

function fakeReq(body, token) {
  return {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    on(type, handler) {
      if (type === "data") handler(Buffer.from(body));
      if (type === "end") queueMicrotask(() => handler());
    },
    resume() {},
  };
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(key, value) { this.headers[key] = value; },
    end(payload) { this.body = String(payload ?? ""); },
  };
}

async function postBridge({ store, libraryDir }, pathname, body, token) {
  // The server-side capture token stays fixed; only the request's bearer
  // token varies, so a wrong header is really rejected.
  const capture = createWebCaptureIngest({
    store,
    libraryDir,
    projectId: "default",
    token: "right-token",
    allowedOrigins: ["chrome-extension://test"],
  });
  const res = fakeRes();
  const handled = await handleBridgeRoute({
    req: fakeReq(JSON.stringify(body), token),
    res,
    url: new URL(`http://127.0.0.1:43110${pathname}`),
    context: {
      libraryDir,
      store,
      webCaptureIngest: capture,
      cowartBridge: { status: () => ({}) },
      cowartCanvasDiscovery: { status: () => ({}) },
      codexBridge: { status: () => ({}) },
      grokBridge: { status: () => ({}) },
    },
  });
  return { handled, res };
}

test("route policy: the deletions ingest shares the web capture origin policy, the settings route stays client-gated", () => {
  assert.equal(isWebCaptureApiPath("/api/ingest/web-capture-provider-deletions"), true);
  assert.equal(isWebCaptureApiPath("/api/web-capture/provider-deletion-settings"), false);
});

test("the deletions route rejects a wrong bearer token", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    await assert.rejects(
      () => postBridge({ store, libraryDir }, "/api/ingest/web-capture-provider-deletions", { provider: "jimeng", items: [] }, "wrong-token"),
      (error) => error.statusCode === 401,
    );
  } finally {
    store.close?.();
  }
});

test("the deletions route trashes through the real store and the settings route round-trips", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    const asset = await ingestJimengCapture(store, "default", { itemId: "7700970082708589849" });

    const read = await postBridge({ store, libraryDir }, "/api/web-capture/provider-deletion-settings", {}, "right-token");
    assert.equal(read.res.statusCode, 200);
    assert.deepEqual(JSON.parse(read.res.body), { jimengDeleteSyncEnabled: true });

    const write = await postBridge(
      { store, libraryDir },
      "/api/web-capture/provider-deletion-settings",
      { jimengDeleteSyncEnabled: false },
      "right-token",
    );
    assert.equal(write.res.statusCode, 200);
    assert.deepEqual(JSON.parse(write.res.body), { jimengDeleteSyncEnabled: false });

    const result = await postBridge(
      { store, libraryDir },
      "/api/ingest/web-capture-provider-deletions",
      { provider: "jimeng", items: [{ recordId: "45764385435404", itemId: "7700970082708589849" }] },
      "right-token",
    );
    assert.equal(result.res.statusCode, 200);
    assert.deepEqual(JSON.parse(result.res.body), { trashed: 0, kept: 0, notFound: 1, disabled: true });
    assert.equal(await assetInTrash(store, "default", asset.id), false);

    await postBridge({ store, libraryDir }, "/api/web-capture/provider-deletion-settings", { jimengDeleteSyncEnabled: true }, "right-token");
    const second = await postBridge(
      { store, libraryDir },
      "/api/ingest/web-capture-provider-deletions",
      { provider: "jimeng", items: [{ recordId: "45764385435404", itemId: "7700970082708589849" }] },
      "right-token",
    );
    assert.deepEqual(JSON.parse(second.res.body), { trashed: 1, kept: 0, notFound: 0 });
    assert.equal(await assetInTrash(store, "default", asset.id), true);
  } finally {
    store.close?.();
  }
});

// ---------------------------------------------------------------- extension

function createHookSandbox({ fetchImpl } = {}) {
  const portMessages = [];
  const hookMessages = [];
  class FakeXHR {
    constructor() {
      this.listeners = {};
      this.responseType = "";
      this.status = 0;
      this.responseText = "";
      this.response = null;
    }

    open(_method, url) { this.__url = url; }

    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }

    send(body) { this.__body = body; }

    respond({ status, text, jsonResponse }) {
      this.status = status;
      if (jsonResponse !== undefined) {
        this.responseType = "json";
        this.response = jsonResponse;
      } else {
        this.responseText = text;
      }
      for (const handler of this.listeners.load || []) handler();
    }
  }
  const sandbox = {
    URL,
    location: { origin: "https://jimeng.jianying.com", href: "https://jimeng.jianying.com/ai-tool/asset" },
    XMLHttpRequest: FakeXHR,
    MessageChannel: function FakeChannel() {
      this.port1 = {
        postMessage: (message) => portMessages.push(message),
        addEventListener: () => {},
        start: () => {},
      };
      this.port2 = {};
    },
  };
  if (fetchImpl) sandbox.fetch = fetchImpl;
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.window.postMessage = (message, origin, transfer) => { hookMessages.push({ message, origin, transfer }); };
  vm.runInNewContext(jimengHookSource, sandbox, { filename: "jimeng-page-hook.js" });
  return { sandbox, FakeXHR, portMessages, hookMessages };
}

const deletionReports = (portMessages) => portMessages.filter((message) => message.type === "jimeng-deletion-observed");
// The hook runs in a vm sandbox, so its message objects live in another realm;
// JSON round-trips them into the test realm before deepStrictEqual.
const plain = (value) => JSON.parse(JSON.stringify(value));

test("a confirmed remove_history XHR forwards the deleted item ids", () => {
  const { sandbox, FakeXHR, portMessages } = createHookSandbox();

  const xhr = new sandbox.XMLHttpRequest();
  xhr.open("POST", REMOVE_HISTORY_URL);
  xhr.send(REMOVE_HISTORY_BODY);
  xhr.respond({ status: 200, text: REMOVE_HISTORY_SUCCESS });

  const reports = deletionReports(portMessages);
  assert.equal(reports.length, 1);
  assert.deepEqual(plain(reports[0]), {
    type: "jimeng-deletion-observed",
    success: true,
    items: [{ recordId: "45764385435404", itemId: "7689895316266716440" }],
  });

  // The general structure: several records, several items per record, numeric
  // ids accepted, junk dropped.
  const multi = new sandbox.XMLHttpRequest();
  multi.open("POST", "https://jimeng.jianying.com/mweb/v1/remove_history");
  multi.send(JSON.stringify({
    item_id_list_map: {
      "45764385435404": ["7689895316266716440", "7689895316266716441"],
      "45764385435405": [12345, "bad", null],
    },
  }));
  multi.respond({ status: 200, text: REMOVE_HISTORY_SUCCESS });
  const multiReports = deletionReports(portMessages);
  assert.equal(multiReports.length, 2);
  assert.deepEqual(plain(multiReports[1].items), [
    { recordId: "45764385435404", itemId: "7689895316266716440" },
    { recordId: "45764385435404", itemId: "7689895316266716441" },
    { recordId: "45764385435405", itemId: "12345" },
  ]);
  assert.equal(FakeXHR.prototype.open.name, "mosaHookedOpen", "the hook wraps, not replaces, the site's XHR");
});

test("non-zero ret, non-200 status, empty bodies and other endpoints never forward deletions; query params never appear", async () => {
  const seenFetches = [];
  const { sandbox, portMessages } = createHookSandbox({
    fetchImpl: (url, init) => {
      seenFetches.push({ url: String(url), init });
      return Promise.resolve(new Response(REMOVE_HISTORY_SUCCESS, { status: 200 }));
    },
  });

  const failure = new sandbox.XMLHttpRequest();
  failure.open("POST", REMOVE_HISTORY_URL);
  failure.send(REMOVE_HISTORY_BODY);
  failure.respond({ status: 200, text: '{"ret":"1","errmsg":"failed","logid":"x"}' });

  const httpError = new sandbox.XMLHttpRequest();
  httpError.open("POST", REMOVE_HISTORY_URL);
  httpError.send(REMOVE_HISTORY_BODY);
  httpError.respond({ status: 500, text: REMOVE_HISTORY_SUCCESS });

  const malformed = new sandbox.XMLHttpRequest();
  malformed.open("POST", REMOVE_HISTORY_URL);
  malformed.send("not json at all");
  malformed.respond({ status: 200, text: REMOVE_HISTORY_SUCCESS });

  const wrongBody = new sandbox.XMLHttpRequest();
  wrongBody.open("POST", REMOVE_HISTORY_URL);
  wrongBody.send('{"other_map":{"1":["2"]}}');
  wrongBody.respond({ status: 200, text: REMOVE_HISTORY_SUCCESS });

  const otherEndpoint = new sandbox.XMLHttpRequest();
  otherEndpoint.open("POST", "https://jimeng.jianying.com/mweb/v1/get_asset_list?aid=513084");
  otherEndpoint.send("{}");
  otherEndpoint.respond({ status: 200, text: '{"ret":"0","data":{}}' });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deletionReports(portMessages).length, 0, "nothing may be forwarded for the failure cases");

  // The fetch path observes the same endpoint the same way when the site
  // switches transport.
  await sandbox.window.fetch(REMOVE_HISTORY_URL, { method: "POST", body: REMOVE_HISTORY_BODY });
  await new Promise((resolve) => setImmediate(resolve));
  const reports = deletionReports(portMessages);
  assert.equal(reports.length, 1);
  assert.deepEqual(plain(reports[0].items), [{ recordId: "45764385435404", itemId: "7689895316266716440" }]);

  // URL query parameters (aid / signatures / versions) never travel in the
  // deletion report.
  const reportText = JSON.stringify(reports);
  for (const fragment of ["513084", "7.6.4", "3.0.0", "FEATQ1", "aid=", "aigc_features"]) {
    assert.equal(reportText.includes(fragment), false, `deletion report must not contain ${fragment}`);
  }
});

test("background: reportProviderDeletions posts to the app with the token, caps at 200 and rejects non-jimeng senders", async () => {
  const RUNTIME_ID = "test-extension-id";
  const BASE_URL = "http://127.0.0.1:43517";
  const TOKEN = "test-pairing-token";
  const listeners = { message: [] };
  const localStore = new Map([["mosaBaseUrl", BASE_URL], ["mosaToken", TOKEN], ["autoCapture", true]]);
  const storageArea = (store) => ({
    get(query) {
      if (query === null || query === undefined) return Promise.resolve(Object.fromEntries(store));
      if (Array.isArray(query)) {
        const out = {};
        for (const key of query) if (store.has(key)) out[key] = store.get(key);
        return Promise.resolve(out);
      }
      if (typeof query === "object") {
        const out = {};
        for (const [key, value] of Object.entries(query)) out[key] = store.has(key) ? store.get(key) : value;
        return Promise.resolve(out);
      }
      const out = {};
      if (store.has(String(query))) out[String(query)] = store.get(String(query));
      return Promise.resolve(out);
    },
    set(patch) { for (const [key, value] of Object.entries(patch)) store.set(key, value); return Promise.resolve(); },
    remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key); return Promise.resolve(); },
  });
  const appRequests = [];
  const chrome = {
    runtime: {
      id: RUNTIME_ID,
      getManifest: () => ({ version: "0.15.42" }),
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
    },
    storage: {
      local: storageArea(localStore),
      session: storageArea(new Map()),
      sync: storageArea(new Map()),
      onChanged: { addListener() {} },
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    windows: { onRemoved: { addListener() {} }, create: async () => null },
    contextMenus: { removeAll: async () => {}, create() {}, onClicked: { addListener() {} } },
    action: { setBadgeText: async () => {}, onClicked: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    tabs: { sendMessage: async () => { throw new Error("no receiver"); } },
  };
  const fetchImpl = (url, init = {}) => {
    const parsed = new URL(String(url));
    const record = { url: String(url), method: String(init.method || "GET"), headers: init.headers || {}, body: typeof init.body === "string" ? init.body : null };
    if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
      appRequests.push(record);
      if (parsed.pathname === "/api/health") return Promise.resolve(new Response(JSON.stringify({ product: "mosa" })));
      if (parsed.pathname === "/api/ingest/web-capture-status") return Promise.resolve(new Response(JSON.stringify({ retryRequestId: 0 })));
      return Promise.resolve(new Response(JSON.stringify({ trashed: 0, kept: 0, notFound: 0 })));
    }
    return Promise.reject(new Error(`connection refused: ${url}`));
  };
  const context = vm.createContext({
    chrome,
    fetch: fetchImpl,
    URL,
    URLSearchParams,
    AbortController,
    TextEncoder,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    console,
  });
  new vm.Script(providerPolicySource, { filename: "provider-policy.js" }).runInContext(context);
  const workerSource = backgroundSource.replace(/^import\s+".\/provider-policy.js";\s*$/m, "");
  new vm.Script(workerSource, { filename: "background.js" }).runInContext(context);

  const dispatchMessage = (message, sender) => new Promise((resolve, reject) => {
    const listener = listeners.message[0];
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
      if (!settled) reject(new Error("sendResponse was never called"));
    }, 5_000);
  });

  const jimengSender = { id: RUNTIME_ID, tab: { id: 11 }, url: "https://jimeng.jianying.com/ai-tool/asset", frameId: 0 };
  const response = await dispatchMessage({
    type: "mosa.reportProviderDeletions",
    payload: { provider: "jimeng", items: [{ recordId: "45764385435404", itemId: "7689895316266716440" }] },
  }, jimengSender);
  assert.equal(response.ok, true);
  const deletionPost = appRequests.find((request) => request.url === `${BASE_URL}/api/ingest/web-capture-provider-deletions`);
  assert.ok(deletionPost, "the deletion report must reach the app's new ingest route");
  assert.equal(deletionPost.method, "POST");
  assert.equal(deletionPost.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(deletionPost.body), {
    provider: "jimeng",
    items: [{ recordId: "45764385435404", itemId: "7689895316266716440" }],
  });

  // Cap: a 205-item batch is truncated to 200 before it leaves the worker.
  appRequests.length = 0;
  await dispatchMessage({
    type: "mosa.reportProviderDeletions",
    payload: {
      provider: "jimeng",
      items: Array.from({ length: 205 }, (_, index) => ({ recordId: "r", itemId: String(9_000_000_000_000_000_000n + BigInt(index)) })),
    },
  }, jimengSender);
  const cappedPost = appRequests.find((request) => request.url === `${BASE_URL}/api/ingest/web-capture-provider-deletions`);
  assert.equal(JSON.parse(cappedPost.body).items.length, 200);

  // A ChatGPT tab may not report jimeng deletions (provider gating).
  const chatgptResponse = await dispatchMessage({
    type: "mosa.reportProviderDeletions",
    payload: { provider: "jimeng", items: [{ recordId: "r", itemId: "42" }] },
  }, { id: RUNTIME_ID, tab: { id: 12 }, url: "https://chatgpt.com/c/conv", frameId: 0 });
  assert.equal(chatgptResponse.ok, false);

  // The wiring lines stay pinned: content script forwards the hook message,
  // background gates it to jimeng pages.
  assert.match(providerJimengSource, /message\?\.type === "jimeng-deletion-observed"/);
  assert.match(backgroundSource, /message\.type === "mosa\.reportProviderDeletions"\) return context\.provider === "jimeng";/);
  assert.match(backgroundSource, /\/api\/ingest\/web-capture-provider-deletions/);
});
