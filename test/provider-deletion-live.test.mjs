// Task 385 — provider-deletion sync meets the live viewer: an asset the user
// is currently viewing is asked about instead of moved, a refusal writes the
// follow-the-asset keep mark, and a timeout defers to the next report. Real
// modules only: the real sync core, the real bridge route, the real stores,
// and (for the route section) a real started runtime.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import sharp from "sharp";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { createAssetStore } from "../lib/asset-store.mjs";
import {
  MAX_DEFERRED_PROVIDER_DELETIONS,
  addDeferredProviderDeletion,
  applyLiveDeletionDecision,
  applyProviderDeletions,
  readDeferredProviderDeletions,
  runDeferredProviderDeletions,
} from "../lib/provider-deletion-sync.mjs";
import { handleBridgeRoute } from "../lib/api/bridge-routes.mjs";
import { ingestWebCapture, createWebCaptureIngest } from "../lib/web-capture-ingest.js";
import { createLiveDeletionRequests } from "../lib/live-deletion-requests.mjs";
import { searchMcpAssets } from "../lib/mcp-asset-search.mjs";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";

const CLIENT_TOKEN = "mosa_live_deletion_test_client_token_0123456789abcdef";
const CAPTURE_TOKEN = "mosa_live_deletion_test_capture_token";
const JIMENG_REQUESTER = { kind: "jimeng", name: "即梦删除同步", pid: process.pid };

async function jpegBase64(seed) {
  const width = 720;
  const height = 960;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 37 + seed * 17 + (i % 251)) & 255;
  const buf = await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
  return buf.toString("base64");
}

let nextImageSeed = 1;

async function makeLibrary() {
  const root = await mkdtemp(join(tmpdir(), "mosa-provider-live-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  return { root, libraryDir, store };
}

async function ingestJimengCapture(store, projectId, itemId) {
  const recordId = `rec-${itemId}`;
  const imported = await ingestWebCapture({
    store,
    tempRoot: join(store.libraryDir, ".web-capture-tmp"),
    projectId,
    input: {
      provider: "jimeng",
      mediaKind: "image",
      imageBase64: await jpegBase64(nextImageSeed++),
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

async function trashReason(store, projectId, assetId) {
  const asset = await store.getAsset(projectId, assetId);
  return asset?.trash_reason?.code || asset?.metadata?.trash_reason?.code || "";
}

async function refusalMark(store, projectId, assetId) {
  const asset = await store.getAsset(projectId, assetId);
  return asset?.source?.provider_deletion_keep || null;
}

/** The task's closing check for every library-touching test: pragma ok. */
async function assertIntegrityOk(libraryDir) {
  const raw = new Database(join(libraryDir, "mosa.db"), { readonly: true });
  try {
    const row = raw.prepare("PRAGMA integrity_check").get();
    assert.equal(row.integrity_check, "ok");
  } finally {
    raw.close();
  }
}

/**
 * A real delete-request protocol instance plus the same reportLive shape the
 * runtime builds (lib/mosa-runtime.mjs). `viewed` is the test's hand on the
 * viewer — isViewing reads the real .live/viewer.json file.
 */
function makeLiveContext(libraryDir, { timeoutMs = 60_000 } = {}) {
  const requests = createLiveDeletionRequests({ libraryDir, timeoutMs });
  const reportLive = () => ({
    isViewing: async (projectId, assetId) => {
      const viewer = await requests.readViewer();
      if (!requests.isViewerFresh(viewer)) return false;
      return String(viewer.projectId) === String(projectId) && String(viewer.assetId) === String(assetId);
    },
    requestConfirmation: async ({ projectId, assetId, provider, itemId }) => {
      await requests.createDeleteRequest({
        projectId,
        assetId,
        requester: JIMENG_REQUESTER,
        extra: { provider, itemId },
      });
    },
    skipViewCheckFor: new Set(),
  });
  return { requests, reportLive, live: reportLive() };
}

function fakeReq(body, token) {
  const payload = Buffer.from(JSON.stringify(body));
  return {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-length": String(payload.length),
    },
    on(type, handler) {
      if (type === "data") handler(payload);
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

async function postProviderDeletions({ store, libraryDir, liveDeletion }, body) {
  const capture = createWebCaptureIngest({
    store,
    libraryDir,
    projectId: "default",
    token: CAPTURE_TOKEN,
    allowedOrigins: ["chrome-extension://test"],
  });
  const res = fakeRes();
  const startedAt = Date.now();
  const handled = await handleBridgeRoute({
    req: fakeReq(body, CAPTURE_TOKEN),
    res,
    url: new URL("http://127.0.0.1:43110/api/ingest/web-capture-provider-deletions"),
    context: {
      libraryDir,
      store,
      webCaptureIngest: capture,
      cowartBridge: { status: () => ({}) },
      cowartCanvasDiscovery: { status: () => ({}) },
      codexBridge: { status: () => ({}) },
      grokBridge: { status: () => ({}) },
      ...(liveDeletion ? { liveDeletion } : {}),
    },
  });
  return { handled, res, elapsedMs: Date.now() - startedAt };
}

// ---------------------------------------------------------------- viewing ask

test("a viewed asset is asked about instead of moved; the rest of the batch still trashes; the route answers 200 immediately", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    const viewed = await ingestJimengCapture(store, "default", "7700970082708600001");
    const other = await ingestJimengCapture(store, "default", "7700970082708600002");
    const { requests, reportLive, live } = makeLiveContext(libraryDir);
    await requests.writeViewer({ projectId: "default", assetId: viewed.id });

    const { res, elapsedMs } = await postProviderDeletions({ store, libraryDir, liveDeletion: { reportLive } }, {
      provider: "jimeng",
      items: [
        { recordId: "rec-1", itemId: "7700970082708600001" },
        { recordId: "rec-2", itemId: "7700970082708600002" },
      ],
    });
    assert.equal(res.statusCode, 200, "the report route answers 200 without waiting for the user");
    assert.ok(elapsedMs < 1000, `route must not wait on the user (took ${elapsedMs}ms)`);
    const payload = JSON.parse(res.body);
    assert.deepEqual(payload, { trashed: 1, kept: 0, notFound: 0, awaitingUser: 1 });

    assert.equal(await assetInTrash(store, "default", viewed.id), false, "the viewed asset stays");
    assert.equal(await assetInTrash(store, "default", other.id), true, "the unviewed sibling trashes");

    // The request file exists with the provider identity the decision needs.
    const pending = await requests.listPendingRequests();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].requester.kind, "jimeng");
    assert.equal(pending[0].requester.name, "即梦删除同步");
    assert.equal(pending[0].projectId, "default");
    assert.equal(pending[0].assetId, viewed.id);
    assert.equal(pending[0].provider, "jimeng");
    assert.equal(pending[0].itemId, "7700970082708600001");

    // The user allows: the decision lands in the request file first (the
    // decision route's order), then the same item re-runs with the viewing
    // check skipped and lands in the trash with the provider reason.
    await requests.writeDecision(pending[0].id, "allowed");
    const allowed = await applyLiveDeletionDecision({
      store,
      libraryDir,
      live,
      request: pending[0],
      result: "allowed",
    });
    assert.equal(allowed.action, "reapplied");
    assert.equal(await assetInTrash(store, "default", viewed.id), true);
    assert.equal(await trashReason(store, "default", viewed.id), "provider-deleted:jimeng");
    await assertIntegrityOk(libraryDir);
  } finally {
    store.close?.();
  }
});

test("deny writes the follow-the-asset refusal mark, nothing in the deferred list, and no updated_at change", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    const asset = await ingestJimengCapture(store, "default", "7700970082708600011");
    const { requests, reportLive, live } = makeLiveContext(libraryDir);
    await requests.writeViewer({ projectId: "default", assetId: asset.id });

    await postProviderDeletions({ store, libraryDir, liveDeletion: { reportLive } }, {
      provider: "jimeng",
      items: [{ recordId: "rec-1", itemId: "7700970082708600011" }],
    });
    const pending = await requests.listPendingRequests();
    assert.equal(pending.length, 1);

    const updatedBefore = (await store.getAsset("default", asset.id)).updated_at;
    // The decision route writes the answer into the request file before the
    // sync processes it — mirror that order here.
    await requests.writeDecision(pending[0].id, "denied");
    const decided = await applyLiveDeletionDecision({ store, libraryDir, live, request: pending[0], result: "denied" });
    assert.equal(decided.action, "marked");

    const mark = await refusalMark(store, "default", asset.id);
    assert.equal(mark?.provider, "jimeng");
    assert.equal(mark?.item_id, "7700970082708600011");
    assert.ok(mark?.refused_at, "the mark records when the user refused");
    assert.equal(await assetInTrash(store, "default", asset.id), false);
    assert.equal((await store.getAsset("default", asset.id)).updated_at, updatedBefore,
      "an internal mark must not refresh updated_at");
    assert.deepEqual(await readDeferredProviderDeletions(libraryDir), [], "a refusal never defers");

    // The same item reported again with nobody watching: kept, no new request.
    await requests.clearViewer();
    const again = await applyProviderDeletions({ store, libraryDir, live }, {
      provider: "jimeng",
      items: [{ recordId: "rec-1", itemId: "7700970082708600011" }],
    });
    assert.deepEqual(again, { trashed: 0, kept: 1, notFound: 0, awaitingUser: 0 });
    assert.equal(await requests.listPendingRequests().then((rows) => rows.length), 0, "no dialog for a refused asset");
    await assertIntegrityOk(libraryDir);
  } finally {
    store.close?.();
  }
});

test("the mark follows the asset through trash and restore; an unmarked sibling still trashes", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    const protectedAsset = await ingestJimengCapture(store, "default", "7700970082708600021");
    const sibling = await ingestJimengCapture(store, "default", "7700970082708600022");
    const { requests, live } = makeLiveContext(libraryDir);
    await store.markProviderDeletionKept("default", protectedAsset.id, { provider: "jimeng", itemId: "7700970082708600021" });

    // The user trashes it themselves and restores it — the mark survives.
    await store.deleteAsset("default", protectedAsset.id, { reason: "user" });
    await store.restoreAsset("default", protectedAsset.id);
    assert.ok(await refusalMark(store, "default", protectedAsset.id), "the mark survives a trash/restore round trip");

    const { reportLive } = makeLiveContext(libraryDir);
    const result = await applyProviderDeletions({ store, libraryDir, live: reportLive() }, {
      provider: "jimeng",
      items: [
        { recordId: "rec-1", itemId: "7700970082708600021" },
        { recordId: "rec-2", itemId: "7700970082708600022" },
      ],
    });
    assert.deepEqual(result, { trashed: 1, kept: 1, notFound: 0, awaitingUser: 0 });
    assert.equal(await assetInTrash(store, "default", protectedAsset.id), false, "still protected after restore");
    assert.equal(await assetInTrash(store, "default", sibling.id), true, "the unmarked sibling trashes");
    assert.equal(await requests.listPendingRequests().then((rows) => rows.length), 0);
    await assertIntegrityOk(libraryDir);
  } finally {
    store.close?.();
  }
});

test("a timeout defers without a mark; the next report re-judges; a still-viewed re-ask replaces the entry", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    const asset = await ingestJimengCapture(store, "default", "7700970082708600031");
    const otherItem = "7700970082708600032";
    const otherAsset = await ingestJimengCapture(store, "default", otherItem);
    const { requests, reportLive, live } = makeLiveContext(libraryDir, { timeoutMs: 50 });
    await requests.writeViewer({ projectId: "default", assetId: asset.id });

    const first = await applyProviderDeletions({ store, libraryDir, live }, {
      provider: "jimeng",
      items: [{ recordId: "rec-1", itemId: "7700970082708600031" }],
    });
    assert.equal(first.awaitingUser, 1);

    // The poll-side expiry writes timeout; the runtime hands it to the sync.
    await new Promise((resolve) => setTimeout(resolve, 80));
    const flipped = await requests.markExpiredPendingAsTimeout();
    assert.equal(flipped.length, 1);
    const decided = await applyLiveDeletionDecision({ store, libraryDir, live, request: flipped[0], result: "timeout" });
    assert.equal(decided.action, "deferred");
    assert.equal((await requests.readRequest(flipped[0].id)).status, "timeout");
    assert.equal(await refusalMark(store, "default", asset.id), null, "a timeout is not a refusal: no mark");
    let deferred = await readDeferredProviderDeletions(libraryDir);
    assert.equal(deferred.length, 1);
    assert.equal(deferred[0].itemId, "7700970082708600031");
    assert.equal(deferred[0].assetId, asset.id);

    // Next report (a different item), nobody watching: the deferred entry
    // re-judges first and the asset finally moves; the list empties.
    await requests.clearViewer();
    const second = await applyProviderDeletions({ store, libraryDir, live: reportLive() }, {
      provider: "jimeng",
      items: [{ recordId: "rec-2", itemId: otherItem }],
    });
    assert.equal(second.trashed, 1, "the reported item trashes");
    assert.equal(second.awaitingUser, 0);
    assert.equal(await assetInTrash(store, "default", asset.id), true, "the deferred asset re-judged and moved");
    assert.deepEqual(await readDeferredProviderDeletions(libraryDir), [], "a ran entry leaves the list");
    await assertIntegrityOk(libraryDir);
  } finally {
    store.close?.();
  }
});

test("a deferred asset that is viewed again gets a fresh request and leaves the deferred list", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    const asset = await ingestJimengCapture(store, "default", "7700970082708600041");
    const { requests, reportLive, live } = makeLiveContext(libraryDir);
    await addDeferredProviderDeletion(libraryDir, {
      provider: "jimeng", itemId: "7700970082708600041", assetId: asset.id, at: new Date().toISOString(),
    });
    await requests.writeViewer({ projectId: "default", assetId: asset.id });

    const report = await applyProviderDeletions({ store, libraryDir, live }, {
      provider: "jimeng",
      items: [{ recordId: "rec-9", itemId: "7700970082708600099" }],
    });
    assert.equal(report.notFound, 1);
    const deferred = await readDeferredProviderDeletions(libraryDir);
    assert.deepEqual(deferred, [], "the re-asked entry waits on its request now, not the list");
    const pending = await requests.listPendingRequests();
    assert.equal(pending.length, 1, "a fresh request was filed for the still-viewed asset");
    assert.equal(pending[0].itemId, "7700970082708600041");
    assert.equal(await assetInTrash(store, "default", asset.id), false);

    // Allowing the fresh request finally moves it.
    await requests.writeDecision(pending[0].id, "allowed");
    await applyLiveDeletionDecision({ store, libraryDir, live: reportLive(), request: pending[0], result: "allowed" });
    assert.equal(await assetInTrash(store, "default", asset.id), true);
    await assertIntegrityOk(libraryDir);
  } finally {
    store.close?.();
  }
});

test("runDeferredProviderDeletions honours the switch: off means no run and no additions, marks stay", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    const asset = await ingestJimengCapture(store, "default", "7700970082708600051");
    const { requests, reportLive, live } = makeLiveContext(libraryDir);
    await store.markProviderDeletionKept("default", asset.id, { provider: "jimeng", itemId: "7700970082708600051" });
    await addDeferredProviderDeletion(libraryDir, {
      provider: "jimeng", itemId: "7700970082708600059", assetId: asset.id, at: new Date().toISOString(),
    });
    await writeFile(join(libraryDir, ".provider-deletion-sync.json"), `${JSON.stringify({ jimengDeleteSyncEnabled: false })}\n`, "utf8");

    const outcome = await runDeferredProviderDeletions({ store, libraryDir, live: reportLive() });
    assert.equal(outcome, null, "the disabled switch does not run the deferred list");
    assert.equal((await readDeferredProviderDeletions(libraryDir)).length, 1, "the list stays untouched");
    const report = await applyProviderDeletions({ store, libraryDir, live }, {
      provider: "jimeng",
      items: [{ recordId: "rec-1", itemId: "7700970082708600051" }],
    });
    assert.equal(report.disabled, true);
    assert.ok(await refusalMark(store, "default", asset.id), "existing marks are untouched by the switch");
    assert.equal(await requests.listPendingRequests().then((rows) => rows.length), 0);
  } finally {
    store.close?.();
  }
});

test("the refusal mark never reaches search", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    const asset = await ingestJimengCapture(store, "default", "7700970082708600061");
    await store.markProviderDeletionKept("default", asset.id, { provider: "jimeng", itemId: "7700970082708600061" });
    for (const query of ["provider_deletion_keep", "jimeng", "refused_at"]) {
      const found = await searchMcpAssets({ store, query, limit: 50 });
      assert.equal(
        found.results.some((row) => row.id === asset.id),
        false,
        `the mark's text must not be searchable: ${query}`,
      );
    }
    await assertIntegrityOk(libraryDir);
  } finally {
    store.close?.();
  }
});

test("the deferred list caps at 1000 entries, one per provider+itemId, oldest dropped", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-provider-live-deferred-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  try {
    const itemIdFor = (index) => `7700970082708${String(index).padStart(6, "0")}`;
    for (let index = 0; index < MAX_DEFERRED_PROVIDER_DELETIONS + 50; index += 1) {
      await addDeferredProviderDeletion(libraryDir, {
        provider: "jimeng",
        itemId: itemIdFor(index),
        assetId: `asset-${index}`,
        at: new Date().toISOString(),
      });
    }
    const entries = await readDeferredProviderDeletions(libraryDir);
    assert.equal(entries.length, MAX_DEFERRED_PROVIDER_DELETIONS);
    // The oldest (lowest index) rows were dropped; the newest survive.
    assert.equal(entries[0].itemId, itemIdFor(50));
    assert.equal(entries[entries.length - 1].itemId, itemIdFor(MAX_DEFERRED_PROVIDER_DELETIONS + 49));
    // Same provider+itemId refreshes in place instead of stacking.
    await addDeferredProviderDeletion(libraryDir, {
      provider: "jimeng", itemId: entries[0].itemId, assetId: "asset-refreshed", at: new Date().toISOString(),
    });
    const refreshed = await readDeferredProviderDeletions(libraryDir);
    assert.equal(refreshed.length, MAX_DEFERRED_PROVIDER_DELETIONS);
    assert.equal(refreshed.find((entry) => entry.itemId === entries[0].itemId).assetId, "asset-refreshed");
  } finally {
    await import("node:fs/promises").then((fs) => fs.rm(root, { recursive: true, force: true }));
  }
});

// ---------------------------------------------------------------- JSON backend

test("JSON backend: the refusal mark is written and survives a store reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-provider-live-json-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  const metadataDir = join(libraryDir, "assets", "default", "metadata");
  await mkdir(metadataDir, { recursive: true });
  await mkdir(join(libraryDir, "assets", "default", "images"), { recursive: true });
  await writeFile(join(metadataDir, "json-marked.json"), `${JSON.stringify({
    id: "json-marked",
    asset: "json-marked.png",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  })}\n`, "utf8");
  await writeFile(join(libraryDir, "assets", "default", "images", "json-marked.png"), "fixture", "utf8");

  let store = createAssetStore({
    projectRoot: root,
    managerDir: root,
    libraryDir,
    explicitLibraryDir: libraryDir,
    assetsRoot: join(libraryDir, "assets"),
  });
  try {
    assert.equal(store.storageKind, "json");
    const marked = await store.markProviderDeletionKept("default", "json-marked", { provider: "jimeng", itemId: "42" });
    assert.equal(marked.source.provider_deletion_keep.provider, "jimeng");
    assert.equal(marked.source.provider_deletion_keep.item_id, "42");
    assert.equal(marked.updated_at, "2026-01-01T00:00:00.000Z", "updated_at does not move");
    const onDisk = JSON.parse(await readFile(join(metadataDir, "json-marked.json"), "utf8"));
    assert.equal(onDisk.source.provider_deletion_keep.item_id, "42");
  } finally {
    store.close?.();
  }

  store = createAssetStore({
    projectRoot: root,
    managerDir: root,
    libraryDir,
    explicitLibraryDir: libraryDir,
    assetsRoot: join(libraryDir, "assets"),
  });
  try {
    const reopened = await store.getAsset("default", "json-marked");
    assert.equal(reopened.source.provider_deletion_keep.provider, "jimeng", "the mark survives the reopen");
  } finally {
    store.close?.();
  }
});

// ---------------------------------------------------------------- real routes

test("the real runtime routes: viewer-presence writes and clears, the queue lists unexpired pending, decisions answer 200/409/404, and the gate rejects tokenless calls", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-provider-live-runtime-"));
  t.after(() => import("node:fs/promises").then((fs) => fs.rm(root, { recursive: true, force: true })));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  // Seed through the factory so the fresh library is marked complete (the
  // runtime refuses an unmarked database).
  const seedStore = createAssetStore({
    projectRoot: root,
    managerDir: root,
    libraryDir,
    explicitLibraryDir: libraryDir,
    assetsRoot: join(libraryDir, "assets"),
  });
  await seedStore.ensureProject("default");
  seedStore.close();

  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: root,
    libraryDir,
    assetsRoot: join(libraryDir, "assets"),
    clientToken: CLIENT_TOKEN,
    webCaptureToken: CAPTURE_TOKEN,
    maintenanceStartDelayMs: 50,
  });
  t.after(() => runtime.stop());
  const authed = (path, init = {}) => fetch(`${runtime.url}${path}`, {
    ...init,
    headers: { "x-mosa-client-token": CLIENT_TOKEN, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers || {}) },
  });
  const live = createLiveDeletionRequests({ libraryDir, timeoutMs: 5000 });

  // Tokenless calls are rejected by the same client gate as every other API path.
  const tokenless = await fetch(`${runtime.url}/api/live-deletion-requests`);
  assert.equal(tokenless.status, 401);

  // Presence: a string assetId writes the record, null clears this pid's.
  const posted = await authed("/api/viewer-presence", { method: "POST", body: JSON.stringify({ projectId: "default", assetId: "watched-asset" }) });
  assert.equal(posted.status, 200);
  let viewer = await live.readViewer();
  assert.equal(viewer.assetId, "watched-asset");
  assert.equal(viewer.projectId, "default");
  assert.equal(Number(viewer.pid), process.pid, "the record names this service process");
  const cleared = await authed("/api/viewer-presence", { method: "POST", body: JSON.stringify({ projectId: "default", assetId: null }) });
  assert.equal(cleared.status, 200);
  assert.equal(await live.readViewer(), null);

  // Bad body: neither a string nor null.
  const bad = await authed("/api/viewer-presence", { method: "POST", body: JSON.stringify({ projectId: "default", assetId: 42 }) });
  assert.equal(bad.status, 400);

  // Queue: only pending and unexpired requests, oldest first. Tiny waits keep
  // the createdAt stamps distinct so the order assertion is deterministic.
  await authed("/api/viewer-presence", { method: "POST", body: JSON.stringify({ projectId: "default", assetId: "asset-x" }) });
  const fresh = createLiveDeletionRequests({ libraryDir, timeoutMs: 60_000 });
  const { request: first } = await fresh.createDeleteRequest({
    projectId: "default", assetId: "asset-x", requester: { kind: "mcp", name: "Claude", pid: process.pid },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const { request: second } = await fresh.createDeleteRequest({
    projectId: "default", assetId: "asset-x", requester: { kind: "jimeng", name: "即梦删除同步", pid: process.pid },
    extra: { provider: "jimeng", itemId: "7700970082708600071" },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const shortLived = createLiveDeletionRequests({ libraryDir, timeoutMs: 30 });
  const { request: expiring } = await shortLived.createDeleteRequest({
    projectId: "default", assetId: "asset-x", requester: { kind: "mcp", name: "Codex", pid: process.pid },
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const listed = await authed("/api/live-deletion-requests");
  assert.equal(listed.status, 200);
  const listPayload = await listed.json();
  assert.ok(Number.isFinite(listPayload.now), "the list carries the server's now");
  assert.deepEqual(listPayload.requests.map((row) => row.id), [first.id, second.id],
    "only unexpired pending rows, creation order");
  const listedRow = listPayload.requests[1];
  assert.equal(listedRow.requester.kind, "jimeng");
  assert.equal(listedRow.requester.name, "即梦删除同步");
  assert.equal(listedRow.expiresAt, second.expiresAt);

  // Decision: unknown id -> 404; expired -> 409 with a timeout write; valid -> 200.
  const missing = await authed(`/api/live-deletion-requests/does-not-exist/decision`, { method: "POST", body: JSON.stringify({ result: "deny" }) });
  assert.equal(missing.status, 404);
  const expiredDecision = await authed(`/api/live-deletion-requests/${encodeURIComponent(expiring.id)}/decision`, { method: "POST", body: JSON.stringify({ result: "allow" }) });
  assert.equal(expiredDecision.status, 409, "an expired request answers 409");
  assert.equal((await fresh.readRequest(expiring.id)).status, "timeout", "the expired row is written as timeout");

  const allow = await authed(`/api/live-deletion-requests/${encodeURIComponent(first.id)}/decision`, { method: "POST", body: JSON.stringify({ result: "allow" }) });
  assert.equal(allow.status, 200);
  assert.equal((await fresh.readRequest(first.id)).status, "allowed");

  // A jimeng decision flows through the runtime into the deferred list. The
  // asset row is a raw INSERT (NOT NULL columns filled with inert defaults):
  // the sync matches by provider identity, so the decision path can find it
  // without a full ingest.
  {
    const raw = new Database(join(libraryDir, "mosa.db"));
    try {
      raw.prepare(`
        INSERT INTO assets (project_id, id, asset, original_path, content_sha256, prompt, skill, style, ratio,
                            business_fields_json, theme, group_name, category, source_type, provider_asset_id,
                            source_json, metadata_json, search_text, created_at, updated_at)
        VALUES ('default', 'deferred-target', 'deferred-target.png', '', '', '', '', '', '', '{}', '', '', '',
                'web-jimeng', '7700970082708600071', '{}', '{}', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `).run();
    } finally {
      raw.close();
    }
  }
  const timeoutDecision = await authed(`/api/live-deletion-requests/${encodeURIComponent(second.id)}/decision`, { method: "POST", body: JSON.stringify({ result: "timeout" }) });
  assert.equal(timeoutDecision.status, 200);
  const deferred = await readDeferredProviderDeletions(libraryDir);
  assert.equal(deferred.some((entry) => entry.itemId === "7700970082708600071"), true,
    "the runtime processed the jimeng timeout into the deferred list");
  assert.equal((await fresh.readRequest(second.id)).status, "timeout");

  // Startup scan (task 385 13): a jimeng pending request from a dead pid
  // becomes timeout and defers, without a mark.
  const dead = createLiveDeletionRequests({ libraryDir, timeoutMs: 60_000 });
  const { request: orphan } = await dead.createDeleteRequest({
    projectId: "default", assetId: "deferred-target", requester: { kind: "jimeng", name: "即梦删除同步", pid: 999_999_999 },
    extra: { provider: "jimeng", itemId: "7700970082708600081" },
  });
  {
    const raw = new Database(join(libraryDir, "mosa.db"));
    try {
      raw.prepare("UPDATE assets SET deleted_at = NULL WHERE project_id = 'default' AND id = 'deferred-target'").run();
    } finally {
      raw.close();
    }
  }
  // Restart the runtime: the fresh process's maintenance pass runs the scan.
  // The first stop clears this pid's viewer record, so write it back after the
  // stop and before the restart: the scan's deferred re-judgement then finds
  // the asset being viewed and asks again instead of trashing it.
  await runtime.stop();
  await dead.writeViewer({ projectId: "default", assetId: "deferred-target" });
  const restarted = await startMosaRuntime({
    port: 0,
    projectRoot: root,
    libraryDir,
    assetsRoot: join(libraryDir, "assets"),
    clientToken: CLIENT_TOKEN,
    webCaptureToken: CAPTURE_TOKEN,
    maintenanceStartDelayMs: 30,
  });
  t.after(() => restarted.stop());
  const deadline = Date.now() + 5000;
  let orphanStatus = "";
  let reAsk = null;
  while (Date.now() < deadline) {
    orphanStatus = (await dead.readRequest(orphan.id))?.status || "";
    const pending = await dead.listPendingRequests();
    // Both deferred entries point at the same asset, so their re-asks merge
    // into one pending request for it (same requester kind + name + asset).
    reAsk = pending.find((row) => row.assetId === "deferred-target" && row.requester?.kind === "jimeng") || null;
    if (orphanStatus === "timeout" && reAsk) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(orphanStatus, "timeout", "the dead-pid jimeng request was settled by the startup scan");
  assert.ok(reAsk, "the settled timeout re-judged, found the asset viewed, and asked again");
  assert.equal(reAsk.requester.kind, "jimeng");
  assert.deepEqual(await readDeferredProviderDeletions(libraryDir), [],
    "the re-asked entry waits on its request, not the deferred list");
  const markedAsset = await (async () => {
    const check = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
    try {
      return await check.getAsset("default", "deferred-target");
    } finally {
      check.close();
    }
  })();
  assert.equal(markedAsset.source?.provider_deletion_keep ?? null, null, "a timeout never writes the refusal mark");
  assert.equal(Boolean(markedAsset.deleted_at), false, "an asked-again asset is not moved");
  await assertIntegrityOk(libraryDir);
});
