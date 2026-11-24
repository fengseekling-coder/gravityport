import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import sharp from "sharp";
import Database from "better-sqlite3";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import {
  LOVART_BASE_IMAGE_RESOLVER,
  resolveLovartBaseImageRelations,
} from "../lib/generation-history.mjs";
import { createJsonAssetStore } from "../lib/asset-store.mjs";
import { createSqliteAssetStore, sqliteDatabasePath } from "../lib/sqlite-asset-store.mjs";
import { ingestWebCapture } from "../lib/web-capture-ingest.js";
import { createBackgroundHarness, senderFor } from "./helpers/background-harness.mjs";

const extensionRoot = new URL("../extensions/chatgpt-web-capture/", import.meta.url);
const providerPolicySource = await readFile(new URL("provider-policy.js", extensionRoot), "utf8");
const providerLovartSource = await readFile(new URL("provider-lovart.js", extensionRoot), "utf8");

const historyNew = JSON.parse(await readFile(new URL("fixtures/lovart-history-new.json", import.meta.url), "utf8"));
const realtimeNew = JSON.parse(await readFile(new URL("fixtures/lovart-realtime-new.json", import.meta.url), "utf8"));
const historyOld = JSON.parse(await readFile(new URL("fixtures/lovart-history-old.json", import.meta.url), "utf8"));

async function flushPageMicrotasks() {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function fakePageClock(startMs = Date.parse("2026-11-22T12:00:00Z")) {
  const timers = [];
  let nextId = 1;
  const clock = { now: startMs, timers };
  const add = (fn, ms, repeat) => {
    const delay = Math.max(0, Number(ms) || 0);
    timers.push({ id: nextId, at: clock.now + delay, delay, repeat, fn, cancelled: false });
    nextId += 1;
    return nextId - 1;
  };
  const cancel = (id) => {
    const timer = timers.find((candidate) => candidate.id === id);
    if (timer) timer.cancelled = true;
  };
  clock.setTimeout = (fn, ms) => add(fn, ms, false);
  clock.setInterval = (fn, ms) => add(fn, ms, true);
  clock.clearTimeout = cancel;
  clock.clearInterval = cancel;
  clock.advance = async (ms) => {
    await flushPageMicrotasks();
    const target = clock.now + ms;
    for (;;) {
      const due = timers
        .filter((timer) => !timer.cancelled && timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      clock.now = Math.max(clock.now, due.at);
      if (due.repeat) due.at += Math.max(1, due.delay);
      else due.cancelled = true;
      due.fn();
      await flushPageMicrotasks();
    }
    clock.now = target;
    await flushPageMicrotasks();
  };
  return clock;
}

function fakeClockDate(clock) {
  return class FakeDate extends Date {
    constructor(...args) {
      if (args.length) super(...args);
      else super(clock.now);
    }

    static now() {
      return clock.now;
    }
  };
}

function lovartPage({ storage = {}, respond } = {}) {
  const clock = fakePageClock();
  const localStore = new Map(Object.entries(storage));
  const sent = [];
  const messageListeners = [];
  const windowMessageHandlers = [];
  const chrome = {
    runtime: {
      id: "test-extension",
      sendMessage: (message) => {
        sent.push(message);
        if (message.type === "mosa.getSettings") {
          return Promise.resolve({ ok: true, settings: { autoCapture: true } });
        }
        return Promise.resolve(respond ? respond(message) : { ok: true, result: { status: "imported" } });
      },
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
    },
    storage: {
      local: {
        get: async (query) => {
          const out = {};
          for (const [key, fallback] of Object.entries(query || {})) {
            out[key] = localStore.has(key) ? localStore.get(key) : fallback;
          }
          return out;
        },
        set: async (patch) => {
          for (const [key, value] of Object.entries(patch)) localStore.set(key, value);
        },
      },
      onChanged: { addListener: () => {} },
    },
  };
  const document = {
    getElementById: () => null,
    documentElement: {},
    body: { appendChild() {} },
    createElement: () => ({ style: {}, setAttribute() {}, replaceChildren() {}, hidden: false }),
    createTextNode: (text) => ({ text }),
  };
  const sandbox = {
    URL,
    Date: fakeClockDate(clock),
    chrome,
    document,
    location: { href: "https://www.lovart.ai/canvas?projectId=x", origin: "https://www.lovart.ai" },
    console: { info() {}, log() {}, warn() {} },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = (type, fn) => {
    if (type === "message") windowMessageHandlers.push(fn);
  };
  sandbox.window.postMessage = () => {};
  vm.createContext(sandbox);
  vm.runInContext(providerPolicySource, sandbox, { filename: "provider-policy.js" });
  vm.runInContext(providerLovartSource, sandbox, { filename: "provider-lovart.js" });
  return {
    clock,
    sent,
    localStore,
    messageListeners,
    ingests: () => sent.filter((message) => message.type === "mosa.ingest"),
    mediaCaptures: () => sent.filter((message) => message.type === "mosa.ingest"
      && !message.payload?.isReference && message.payload?.mediaKind === "image"),
    referenceCaptures: () => sent.filter((message) => message.type === "mosa.ingest"
      && message.payload?.isReference),
    deliver: async (type, text) => {
      await clock.advance(0);
      const port = {
        listeners: [],
        addEventListener(portType, fn) { if (portType === "message") this.listeners.push(fn); },
        start() {},
      };
      for (const listener of windowMessageHandlers) {
        listener({ origin: "https://www.lovart.ai", data: { source: "mosa-lovart-hook", type: "hook-port" }, ports: [port] });
      }
      for (const listener of port.listeners) listener({ data: { type, text } });
      await clock.advance(400);
    },
  };
}

function dispatchPageMessage(page, message) {
  return new Promise((resolve, reject) => {
    const listener = page.messageListeners[0];
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("sendResponse was never called"));
      }
    }, 2_000);
    const sendResponse = (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(response);
    };
    const keepOpen = listener(message, { id: "test-extension", tab: { id: 3 }, url: "https://www.lovart.ai/canvas?projectId=x", frameId: 0 }, sendResponse);
    if (keepOpen !== true && !settled) {
      settled = true;
      clearTimeout(timer);
      resolve(null);
    }
  });
}

async function noiseImage(seed, width = 640, height = 900) {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * (37 + seed) + (i % 251)) & 255;
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
}

function toAppPayload(extPayload, imageBytes, overrides = {}) {
  const base = {
    provider: extPayload.provider,
    prompt: extPayload.prompt || "",
    prompt_status: extPayload.promptStatus || (extPayload.prompt ? "user-message" : "not-available"),
    user_message: extPayload.userMessage || "",
    prompt_source: extPayload.promptSource || "",
    generation_status: extPayload.generationStatus || "completed",
    is_reference: Boolean(extPayload.isReference),
    mediaKind: extPayload.mediaKind || "image",
    mimeType: "image/jpeg",
    imageBase64: imageBytes.toString("base64"),
    width: extPayload.width || 640,
    height: extPayload.height || 900,
    pageUrl: extPayload.pageUrl || "https://www.lovart.ai/canvas?projectId=x",
    sourceMediaUrl: extPayload.imageUrl || "",
    finalMediaUrl: extPayload.imageUrl || "",
    conversationId: extPayload.conversationId || "",
    messageId: extPayload.messageId || "",
    generationContextId: extPayload.generationContextId || "",
    providerAssetId: extPayload.providerAssetId || "",
    model: extPayload.model || "",
    captureMode: extPayload.captureMode === "manual" ? "manual" : "automatic",
    capturedAt: extPayload.capturedAt || "2026-11-22T12:00:00.000Z",
    ...overrides,
  };
  if ("referenceProviderAssetIds" in extPayload && !("reference_provider_asset_ids" in overrides)) {
    base.reference_provider_asset_ids = extPayload.referenceProviderAssetIds;
  }
  return base;
}

// ---- 1. Pure function: resolveLovartBaseImageRelations ----

test("resolveLovartBaseImageRelations covers forward, reverse, multi-parent, guards, and earliest-event selection", () => {
  const now = "2026-11-24T10:00:00.000Z";
  const parent1 = {
    project_id: "default",
    id: "gen-p1",
    output_asset_id: "asset-p1",
    provider: "lovart",
    capture_channel: "chrome-extension",
    provider_asset_id: "Fake01ArtifactId",
    references: [],
    created_at: "2026-11-24T09:00:00.000Z",
  };
  const parent2 = {
    project_id: "default",
    id: "gen-p2",
    output_asset_id: "asset-p2",
    provider: "lovart",
    capture_channel: "chrome-extension",
    provider_asset_id: "Fake02ParentId",
    references: [],
    created_at: "2026-11-24T09:01:00.000Z",
  };
  const child1 = {
    project_id: "default",
    id: "gen-c1",
    output_asset_id: "asset-c1",
    provider: "lovart",
    capture_channel: "chrome-extension",
    provider_asset_id: "Fake02ArtifactId",
    references: [
      { provider_asset_id: "ref:Fake01ArtifactId", reference_id: "ref-att-1" },
    ],
    created_at: "2026-11-24T09:05:00.000Z",
  };

  // Forward (child finds parent)
  const forward = resolveLovartBaseImageRelations({
    projectId: "default",
    changedEvent: child1,
    events: [parent1, child1],
    relations: [],
    candidates: [],
    now,
  });
  assert.equal(forward.relations.length, 1);
  assert.equal(forward.candidates.length, 1);
  assert.deepEqual(forward.relations[0], {
    project_id: "default",
    child_generation_id: "gen-c1",
    parent_generation_id: "gen-p1",
    relation_type: "edited_from",
    verification_level: "observed",
    evidence: {
      resolver: LOVART_BASE_IMAGE_RESOLVER,
      reference_provider_asset_id: "ref:Fake01ArtifactId",
      parent_provider_asset_id: "Fake01ArtifactId",
      reference_id: "ref-att-1",
    },
    created_at: now,
  });
  assert.deepEqual(forward.candidates[0], {
    project_id: "default",
    child_generation_id: "gen-c1",
    parent_generation_id: "gen-p1",
    suggested_relation_type: "edited_from",
    confidence: 1,
    verification_level: "observed",
    evidence: {
      resolver: LOVART_BASE_IMAGE_RESOLVER,
      reference_provider_asset_id: "ref:Fake01ArtifactId",
      parent_provider_asset_id: "Fake01ArtifactId",
      reference_id: "ref-att-1",
    },
    status: "confirmed",
    created_at: now,
    updated_at: now,
  });

  // Reverse (parent arrives after child)
  const reverse = resolveLovartBaseImageRelations({
    projectId: "default",
    changedEvent: parent1,
    events: [child1, parent1],
    relations: [],
    candidates: [],
    now,
  });
  assert.equal(reverse.relations.length, 1);
  assert.equal(reverse.relations[0].child_generation_id, "gen-c1");
  assert.equal(reverse.relations[0].parent_generation_id, "gen-p1");

  // One child with two parents -> 2 relations (and omitted reference_id when absent)
  const twoParentChild = {
    ...child1,
    id: "gen-c-two",
    output_asset_id: "asset-c-two",
    references: [
      { provider_asset_id: "ref:Fake01ArtifactId", reference_id: "ref-att-1" },
      { provider_asset_id: "ref:Fake02ParentId" },
    ],
  };
  const twoParents = resolveLovartBaseImageRelations({
    projectId: "default",
    changedEvent: twoParentChild,
    events: [parent1, parent2, twoParentChild],
    relations: [],
    candidates: [],
    now,
  });
  assert.equal(twoParents.relations.length, 2);
  assert.deepEqual(
    twoParents.relations.map((item) => item.parent_generation_id),
    ["gen-p1", "gen-p2"],
  );
  assert.equal("reference_id" in twoParents.relations[1].evidence, false);

  // Existing relation in either direction or any relation_type blocks linking
  const blockedByRelation = resolveLovartBaseImageRelations({
    projectId: "default",
    changedEvent: child1,
    events: [parent1, child1],
    relations: [{
      project_id: "default",
      child_generation_id: "gen-p1",
      parent_generation_id: "gen-c1",
      relation_type: "variant_of",
      verification_level: "user_confirmed",
    }],
    candidates: [],
    now,
  });
  assert.equal(blockedByRelation.relations.length, 0);

  // Dismissed candidate blocks linking
  const blockedByDismissed = resolveLovartBaseImageRelations({
    projectId: "default",
    changedEvent: child1,
    events: [parent1, child1],
    relations: [],
    candidates: [{
      project_id: "default",
      child_generation_id: "gen-c1",
      parent_generation_id: "gen-p1",
      suggested_relation_type: "edited_from",
      status: "dismissed",
    }],
    now,
  });
  assert.equal(blockedByDismissed.relations.length, 0);

  // Same output_asset_id -> no relation
  const sameAsset = resolveLovartBaseImageRelations({
    projectId: "default",
    changedEvent: { ...child1, output_asset_id: "asset-p1" },
    events: [parent1, { ...child1, output_asset_id: "asset-p1" }],
    relations: [],
    candidates: [],
    now,
  });
  assert.equal(sameAsset.relations.length, 0);

  // Non-lovart provider (jimeng with identical provider_asset_id) -> no relation
  const jimengParent = { ...parent1, id: "gen-jimeng", provider: "jimeng" };
  const wrongProvider = resolveLovartBaseImageRelations({
    projectId: "default",
    changedEvent: child1,
    events: [jimengParent, child1],
    relations: [],
    candidates: [],
    now,
  });
  assert.equal(wrongProvider.relations.length, 0);

  // Non chrome-extension capture_channel -> no relation
  const wrongChannel = resolveLovartBaseImageRelations({
    projectId: "default",
    changedEvent: child1,
    events: [{ ...parent1, capture_channel: "mcp" }, child1],
    relations: [],
    candidates: [],
    now,
  });
  assert.equal(wrongChannel.relations.length, 0);

  // Case mismatch and missing ref: prefix -> no relation
  const badKeysChild = {
    ...child1,
    references: [
      { provider_asset_id: "ref:fake01artifactid" },
      { provider_asset_id: "Fake01ArtifactId" },
    ],
  };
  const badKeys = resolveLovartBaseImageRelations({
    projectId: "default",
    changedEvent: badKeysChild,
    events: [parent1, badKeysChild],
    relations: [],
    candidates: [],
    now,
  });
  assert.equal(badKeys.relations.length, 0);

  // Multiple events on same asset -> picks earliest by (created_at, id)
  const parentLater = { ...parent1, id: "gen-p1-later", created_at: "2026-11-24T09:00:30.000Z" };
  const parentEarlierSameTime = { ...parent1, id: "gen-p0", created_at: "2026-11-24T09:00:00.000Z" };
  const childEarlier = { ...child1, id: "gen-c1-a", created_at: "2026-11-24T09:04:00.000Z" };
  const earliest = resolveLovartBaseImageRelations({
    projectId: "default",
    changedEvent: child1,
    events: [parentLater, parent1, parentEarlierSameTime, child1, childEarlier],
    relations: [],
    candidates: [],
    now,
  });
  assert.equal(earliest.relations.length, 1);
  assert.equal(earliest.relations[0].parent_generation_id, "gen-p0");
  assert.equal(earliest.relations[0].child_generation_id, "gen-c1-a");
});

// ---- 2. Both stores (JSON & SQLite) via recordGenerationEvent ----

for (const [storeName, createStore] of [
  ["JSON", (root) => createJsonAssetStore({ projectRoot: root, managerDir: join(root, "manager"), assetsRoot: join(root, "json-assets") })],
  ["SQLite", (root) => createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir: join(root, "sqlite-library"), initializeFreshLibrary: true })],
]) {
  test(`${storeName} store auto-links Lovart base images in both orders, respects delete/update, and blocks cycles`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `mosa-lovart-lineage-${storeName.toLowerCase()}-`));
    deferTestPathRemoval(root, { recursive: true, force: true });
    let store;
    t.after(() => { store?.close?.(); });
    await mkdir(join(root, "input"), { recursive: true });
    const imgPaths = [];
    for (let i = 1; i <= 5; i += 1) {
      const p = join(root, "input", `img-${i}.jpg`);
      await writeFile(p, await noiseImage(i, 320, 320));
      imgPaths.push(p);
    }

    store = createStore(root);
    await store.ensureProject("default");
    const assets = [];
    for (let i = 0; i < 5; i += 1) {
      assets.push(await store.createAsset({ projectId: "default", assetId: `lovart-a${i + 1}`, imagePath: imgPaths[i] }));
    }

    async function readStoredCandidates() {
      if (storeName === "SQLite") {
        const db = new Database(sqliteDatabasePath(join(root, "sqlite-library")), { readonly: true });
        try {
          return db.prepare("SELECT * FROM generation_relation_candidates WHERE project_id = 'default'").all();
        } finally {
          db.close();
        }
      }
      return JSON.parse(await readFile(store.generationRelationCandidatesFile("default"), "utf8"));
    }

    // 2a. Parent-then-child
    const changeCursorBefore = storeName === "SQLite" ? (await store.listLibraryChangesSince("default", 0)).currentRevision : 0;
    const parentEvt = await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: assets[0].id,
      id: "gen-parent-1",
      provider: "lovart",
      capture_channel: "chrome-extension",
      provider_asset_id: "ArtParent1",
      created_at: "2026-11-24T08:00:00.000Z",
    });
    const childEvt = await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: assets[1].id,
      id: "gen-child-1",
      provider: "lovart",
      capture_channel: "chrome-extension",
      provider_asset_id: "ArtChild1",
      references: [{ provider_asset_id: "ref:ArtParent1", reference_id: "ref-p1" }],
      created_at: "2026-11-24T08:01:00.000Z",
    });
    let hist = await store.getAssetGenerationHistory("default", assets[1].id);
    assert.equal(hist.relations.length, 1);
    assert.equal(hist.relations[0].parent_generation_id, parentEvt.id);
    assert.equal(hist.relations[0].child_generation_id, childEvt.id);
    assert.equal(hist.relations[0].relation_type, "edited_from");
    assert.equal(hist.relations[0].verification_level, "observed");
    assert.equal(hist.relations[0].evidence.resolver, LOVART_BASE_IMAGE_RESOLVER);
    assert.equal(hist.relation_candidates.length, 0, "confirmed candidates stay hidden from UI suggested list");
    let storedCandidates = await readStoredCandidates();
    assert.equal(storedCandidates.length, 1);
    assert.equal(storedCandidates[0].status, "confirmed");

    let changeCursorAfterLink = 0;
    if (storeName === "SQLite") {
      const batch = await store.listLibraryChangesSince("default", changeCursorBefore);
      const relChanges = batch.changes.filter((c) => c.kind === "generation-relation-updated");
      assert.equal(relChanges.length, 1);
      assert.equal(relChanges[0].entityId, childEvt.id);
      assert.deepEqual([...relChanges[0].assetIds].sort(), [assets[0].id, assets[1].id].sort());
      changeCursorAfterLink = batch.currentRevision;
    }

    // Re-writing both keeps 1 relation, 1 confirmed candidate, and emits no new relation change
    await store.recordGenerationEvent({ ...parentEvt, effective_prompt: "updated prompt" });
    await store.recordGenerationEvent({ ...childEvt, effective_prompt: "updated child prompt" });
    hist = await store.getAssetGenerationHistory("default", assets[1].id);
    assert.equal(hist.relations.length, 1);
    storedCandidates = await readStoredCandidates();
    assert.equal(storedCandidates.length, 1);
    assert.equal(storedCandidates[0].status, "confirmed");
    if (storeName === "SQLite") {
      const batch = await store.listLibraryChangesSince("default", changeCursorAfterLink);
      assert.equal(batch.changes.filter((c) => c.kind === "generation-relation-updated").length, 0);
    }

    // Delete relation -> candidate becomes dismissed -> re-writing child & parent stays 0
    await store.deleteGenerationRelation({
      project_id: "default",
      child_generation_id: childEvt.id,
      parent_generation_id: parentEvt.id,
      relation_type: "edited_from",
    });
    hist = await store.getAssetGenerationHistory("default", assets[1].id);
    assert.equal(hist.relations.length, 0);
    storedCandidates = await readStoredCandidates();
    assert.equal(storedCandidates.find((c) => c.child_generation_id === childEvt.id && c.parent_generation_id === parentEvt.id)?.status, "dismissed");
    await store.recordGenerationEvent({ ...childEvt, effective_prompt: "rewrite after delete" });
    await store.recordGenerationEvent({ ...parentEvt, effective_prompt: "rewrite parent after delete" });
    hist = await store.getAssetGenerationHistory("default", assets[1].id);
    assert.equal(hist.relations.length, 0);

    // 2b. Child-then-parent + updateGenerationRelation to variant_of
    const child2 = await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: assets[2].id,
      id: "gen-child-2",
      provider: "lovart",
      capture_channel: "chrome-extension",
      provider_asset_id: "ArtChild2",
      references: [{ provider_asset_id: "ref:ArtParent2", reference_id: "ref-p2" }],
      created_at: "2026-11-24T08:02:00.000Z",
    });
    assert.equal((await store.getAssetGenerationHistory("default", assets[2].id)).relations.length, 0);

    const parent2 = await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: assets[3].id,
      id: "gen-parent-2",
      provider: "lovart",
      capture_channel: "chrome-extension",
      provider_asset_id: "ArtParent2",
      created_at: "2026-11-24T08:03:00.000Z",
    });
    let hist2 = await store.getAssetGenerationHistory("default", assets[2].id);
    assert.equal(hist2.relations.length, 1);
    assert.equal(hist2.relations[0].child_generation_id, child2.id);
    assert.equal(hist2.relations[0].parent_generation_id, parent2.id);

    await store.updateGenerationRelation({
      project_id: "default",
      child_generation_id: child2.id,
      parent_generation_id: parent2.id,
      previous_relation_type: "edited_from",
      relation_type: "variant_of",
      verification_level: "user_confirmed",
    });
    await store.recordGenerationEvent({ ...child2, effective_prompt: "rewrite after type change" });
    hist2 = await store.getAssetGenerationHistory("default", assets[2].id);
    assert.equal(hist2.relations.length, 1);
    assert.equal(hist2.relations[0].relation_type, "variant_of");

    // 2c. Cycle guard: child2 -> parent2 already exists via assets[2] -> assets[3],
    // now add parent2 -> assets[4] (gen-cycle-mid) and try making gen-cycle-mid -> child2
    // Wait: to test cycle directly without rule-4 asset-pair block, build a 3-node cycle:
    // gen-cyc-a (asset 4) <- manual relation <- gen-parent-2 (asset 3) <- variant_of <- gen-child-2 (asset 2)
    // Then make gen-cyc-a reference ref:ArtChild2 (so gen-cyc-a -> gen-child-2 would close a 3-cycle!).
    const cycNode = await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: assets[4].id,
      id: "gen-cyc-a",
      provider: "lovart",
      capture_channel: "chrome-extension",
      provider_asset_id: "ArtCycA",
      created_at: "2026-11-24T08:04:00.000Z",
    });
    await store.recordGenerationRelation({
      project_id: "default",
      child_generation_id: parent2.id,
      parent_generation_id: cycNode.id,
      relation_type: "based_on",
      verification_level: "user_confirmed",
    });
    // Now lineage is: gen-child-2 -> gen-parent-2 -> gen-cyc-a.
    // Adding gen-cyc-a -> gen-child-2 would form a cycle (and asset 4 <-> asset 2 has no direct relation yet).
    await assert.doesNotReject(async () => {
      await store.recordGenerationEvent({
        project_id: "default",
        output_asset_id: assets[4].id,
        id: "gen-cyc-a",
        provider: "lovart",
        capture_channel: "chrome-extension",
        provider_asset_id: "ArtCycA",
        references: [{ provider_asset_id: "ref:ArtChild2", reference_id: "ref-cyc" }],
        created_at: "2026-11-24T08:04:00.000Z",
      });
    });
    const cycHist = await store.getAssetGenerationHistory("default", assets[4].id);
    assert.equal(
      cycHist.relations.some((r) => r.child_generation_id === cycNode.id && r.parent_generation_id === child2.id),
      false,
      "cycle relation must be skipped without throwing",
    );
  });
}

// ---- 4. Extension: provider-lovart.js emits referenceProviderAssetIds ----

test("provider-lovart.js attaches per-image referenceProviderAssetIds for history, realtime, old UI, and manual saves", async () => {
  // New-UI history
  const newPage = lovartPage({ storage: { lovartAutoCaptureBaselineAtV1: Date.parse("2026-11-01T00:00:00Z") } });
  await newPage.deliver("lovart-api-response", JSON.stringify(historyNew));
  const newIngests = newPage.ingests();
  const refIdx = newIngests.findIndex((m) => m.payload.isReference && m.payload.providerAssetId === "ref:Fake01ArtifactId");
  const fake02Idx = newIngests.findIndex((m) => !m.payload.isReference && m.payload.providerAssetId === "Fake02ArtifactId");
  assert.ok(refIdx >= 0 && fake02Idx > refIdx, "reference must be sent before Fake02");
  const newById = Object.fromEntries(newPage.mediaCaptures().map((m) => [m.payload.providerAssetId, m.payload]));
  assert.deepEqual([...newById.Fake01ArtifactId.referenceProviderAssetIds], []);
  assert.deepEqual([...newById.Fake02ArtifactId.referenceProviderAssetIds], ["ref:Fake01ArtifactId"]);
  assert.deepEqual([...newById.Fake03ArtifactId.referenceProviderAssetIds], []);

  // Realtime new-UI
  const rtPage = lovartPage({ storage: { lovartAutoCaptureBaselineAtV1: Date.parse("2026-11-01T00:00:00Z") } });
  for (const entry of realtimeNew.frames) {
    await rtPage.deliver("lovart-ws-message", JSON.stringify(entry.frame));
  }
  const rtById = Object.fromEntries(rtPage.mediaCaptures().map((m) => [m.payload.providerAssetId, m.payload]));
  assert.deepEqual([...rtById.Fake02ArtifactId.referenceProviderAssetIds], ["ref:Fake01ArtifactId"]);
  assert.deepEqual([...rtById.Fake03ArtifactId.referenceProviderAssetIds], []);

  // Old-UI history
  const oldPage = lovartPage({ storage: { lovartAutoCaptureBaselineAtV1: 1 } });
  await oldPage.deliver("lovart-api-response", JSON.stringify(historyOld));
  const oldById = Object.fromEntries(oldPage.mediaCaptures().map((m) => [m.payload.providerAssetId, m.payload]));
  assert.deepEqual([...oldById.FakeAgentArt0001.referenceProviderAssetIds], ["ref:FakeUpload01Ab2c"]);
  assert.deepEqual([...oldById.FakeAgentArt0002.referenceProviderAssetIds], ["ref:FakeAgentArt0001"]);
  assert.deepEqual([...oldById.FakeAgentArt0003.referenceProviderAssetIds], []);

  // Manual save of an unlearned image -> no referenceProviderAssetIds key
  const beforeUnlearned = newPage.ingests().length;
  await dispatchPageMessage(newPage, {
    type: "mosa.capture.saveImageWithPrompt",
    imageUrl: "https://a.lovart.ai/artifacts/generator/UnlearnedArt999.png",
  });
  const unlearnedPayload = newPage.ingests()[beforeUnlearned]?.payload;
  assert.ok(unlearnedPayload);
  assert.equal(unlearnedPayload.captureMode, "manual");
  assert.equal(unlearnedPayload.providerAssetId, "UnlearnedArt999");
  assert.equal("referenceProviderAssetIds" in unlearnedPayload, false);

  // Manual save of a learned image -> includes referenceProviderAssetIds
  const beforeLearned = newPage.ingests().length;
  await dispatchPageMessage(newPage, {
    type: "mosa.capture.saveImageWithPrompt",
    imageUrl: "https://a.lovart.ai/artifacts/agent/Fake02ArtifactId.png",
  });
  const learnedManualPayload = newPage.ingests().slice(beforeLearned).find((m) => !m.payload.isReference)?.payload;
  assert.ok(learnedManualPayload);
  assert.equal(learnedManualPayload.captureMode, "manual");
  assert.deepEqual([...learnedManualPayload.referenceProviderAssetIds], ["ref:Fake01ArtifactId"]);
});

// ---- 5. Background: captureRequestPayload sanitizes reference_provider_asset_ids ----

test("background captureRequestPayload sanitizes referenceProviderAssetIds and omits key when absent", async () => {
  const harness = await createBackgroundHarness({ appOnline: true });
  await harness.triggerInstalled({ reason: "install" });
  const capturedBodies = [];
  harness.fetchHarness.setAppHandler((url, init) => {
    if (url.pathname === "/api/ingest/web-capture") {
      capturedBodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, assetId: "asset-bg-1" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return null;
  });
  harness.fetchHarness.setMediaHandler(() => new Response(new Uint8Array(1024), { status: 200, headers: { "content-type": "image/png" } }));
  const lovartSender = senderFor("https://www.lovart.ai/canvas?projectId=x");

  const longId = `ref:${"A".repeat(200)}`;
  const dirtyList = [
    123,
    "   ",
    "",
    `  ${longId}  `,
    "ref:id-2",
    "ref:id-3",
    "ref:id-4",
    "ref:id-5",
    "ref:id-6",
    "ref:id-7",
    "ref:id-8",
    "ref:id-9-dropped",
    "ref:id-10-dropped",
  ];
  const withList = await harness.dispatchMessage({
    type: "mosa.ingest",
    payload: {
      provider: "lovart",
      mediaKind: "image",
      imageUrl: "https://a.lovart.ai/artifacts/agent/Fake02ArtifactId.png",
      providerAssetId: "Fake02ArtifactId",
      referenceProviderAssetIds: dirtyList,
    },
  }, lovartSender);
  assert.equal(withList.ok, true);
  assert.equal(capturedBodies.length, 1);
  assert.equal(capturedBodies[0].reference_provider_asset_ids.length, 8);
  assert.equal(capturedBodies[0].reference_provider_asset_ids[0], longId.slice(0, 160));
  assert.deepEqual(capturedBodies[0].reference_provider_asset_ids.slice(1), [
    "ref:id-2",
    "ref:id-3",
    "ref:id-4",
    "ref:id-5",
    "ref:id-6",
    "ref:id-7",
    "ref:id-8",
  ]);

  const withoutList = await harness.dispatchMessage({
    type: "mosa.ingest",
    payload: {
      provider: "lovart",
      mediaKind: "image",
      imageUrl: "https://a.lovart.ai/artifacts/generator/Fake01ArtifactId.png",
      providerAssetId: "Fake01ArtifactId",
    },
  }, lovartSender);
  assert.equal(withoutList.ok, true);
  assert.equal(capturedBodies.length, 2);
  assert.equal("reference_provider_asset_ids" in capturedBodies[1], false);
});

// ---- 3. Full ingest chain (SQLite + real extension fixture outputs) ----

test("full Lovart ingest chain (3a-3h) links base images, handles order/repeats/deletes/uploads/multi-child turns", async (t) => {
  const newPage = lovartPage({ storage: { lovartAutoCaptureBaselineAtV1: Date.parse("2026-11-01T00:00:00Z") } });
  await newPage.deliver("lovart-api-response", JSON.stringify(historyNew));
  const newById = Object.fromEntries(newPage.mediaCaptures().map((m) => [m.payload.providerAssetId, m.payload]));
  const newRefFake01 = newPage.referenceCaptures().find((m) => m.payload.providerAssetId === "ref:Fake01ArtifactId")?.payload;
  assert.ok(newRefFake01);

  const oldPage = lovartPage({ storage: { lovartAutoCaptureBaselineAtV1: 1 } });
  await oldPage.deliver("lovart-api-response", JSON.stringify(historyOld));
  const oldById = Object.fromEntries(oldPage.mediaCaptures().map((m) => [m.payload.providerAssetId, m.payload]));
  const oldRefs = oldPage.referenceCaptures().map((m) => m.payload);

  const imgFake01 = await noiseImage(11);
  const imgFake02 = await noiseImage(12);
  const imgFake03 = await noiseImage(13);
  const imgUpload = await noiseImage(21);
  const imgOld01 = await noiseImage(22);
  const imgOld02 = await noiseImage(23);
  const imgOld03 = await noiseImage(24);
  const imgP1 = await noiseImage(31);
  const imgP2 = await noiseImage(32);
  const imgChildA = await noiseImage(33);
  const imgChildB = await noiseImage(34);
  const imgChildALegacy = await noiseImage(35);
  const imgChildBLegacy = await noiseImage(36);
  const imgMismatch = await noiseImage(41);

  async function makeEnv(suffix) {
    const root = await mkdtemp(join(tmpdir(), `mosa-lovart-chain-${suffix}-`));
    deferTestPathRemoval(root, { recursive: true, force: true });
    const libraryDir = join(root, "library");
    const store = createSqliteAssetStore({
      projectRoot: root,
      managerDir: root,
      libraryDir,
      initializeFreshLibrary: true,
    });
    await store.ensureProject("default");
    const tempRoot = join(root, "tmp");
    const readCandidates = () => {
      const db = new Database(sqliteDatabasePath(libraryDir), { readonly: true });
      try {
        return db.prepare("SELECT * FROM generation_relation_candidates WHERE project_id = 'default'").all();
      } finally {
        db.close();
      }
    };
    t.after(() => { store.close(); });
    return { store, tempRoot, readCandidates };
  }

  // 3a. New-UI history: Fake01 -> ref:Fake01ArtifactId -> Fake02, Fake03
  {
    const { store, tempRoot, readCandidates } = await makeEnv("3a");
    const r1 = await ingestWebCapture({ store, tempRoot, input: toAppPayload(newById.Fake01ArtifactId, imgFake01) });
    await ingestWebCapture({ store, tempRoot, input: toAppPayload(newRefFake01, imgFake01) });
    const r2 = await ingestWebCapture({ store, tempRoot, input: toAppPayload(newById.Fake02ArtifactId, imgFake02) });
    const r3 = await ingestWebCapture({ store, tempRoot, input: toAppPayload(newById.Fake03ArtifactId, imgFake03) });

    const h2 = await store.getAssetGenerationHistory("default", r2.asset.id);
    assert.equal(h2.relations.length, 1);
    const rel = h2.relations[0];
    assert.equal(rel.relation_type, "edited_from");
    assert.equal(rel.verification_level, "observed");
    assert.equal(rel.evidence.resolver, LOVART_BASE_IMAGE_RESOLVER);
    assert.equal(rel.evidence.reference_provider_asset_id, "ref:Fake01ArtifactId");
    assert.equal(rel.evidence.parent_provider_asset_id, "Fake01ArtifactId");
    assert.ok(rel.evidence.reference_id);
    const fake01Event = h2.events.find((e) => e.output_asset_id === r1.asset.id);
    const fake02Event = h2.events.find((e) => e.output_asset_id === r2.asset.id);
    assert.ok(fake01Event && fake02Event);
    assert.equal(rel.parent_generation_id, fake01Event.id);
    assert.equal(rel.child_generation_id, fake02Event.id);

    const h1 = await store.getAssetGenerationHistory("default", r1.asset.id);
    assert.equal(h1.relations.length, 1);
    assert.equal(h1.relations[0].child_generation_id, fake02Event.id);

    const h3 = await store.getAssetGenerationHistory("default", r3.asset.id);
    assert.equal(h3.relations.length, 0);
    assert.equal(r3.asset.references?.length || 0, 0);

    // 3c. Re-capturing Fake01 & Fake02 (automatic & manual) keeps 1 relation & 1 confirmed candidate
    await ingestWebCapture({ store, tempRoot, input: toAppPayload(newById.Fake01ArtifactId, imgFake01) });
    await ingestWebCapture({ store, tempRoot, input: toAppPayload(newById.Fake01ArtifactId, imgFake01, { captureMode: "manual" }) });
    await ingestWebCapture({ store, tempRoot, input: toAppPayload(newById.Fake02ArtifactId, imgFake02) });
    await ingestWebCapture({ store, tempRoot, input: toAppPayload(newById.Fake02ArtifactId, imgFake02, { captureMode: "manual" }) });
    const h2AfterRepeat = await store.getAssetGenerationHistory("default", r2.asset.id);
    assert.equal(h2AfterRepeat.relations.length, 1);
    const repeatCandidates = readCandidates();
    assert.equal(repeatCandidates.length, 1);
    assert.equal(repeatCandidates[0].status, "confirmed");

    // 3d. Delete relation -> re-capturing Fake02 & Fake01 does not restore it
    await store.deleteGenerationRelation({
      project_id: "default",
      child_generation_id: rel.child_generation_id,
      parent_generation_id: rel.parent_generation_id,
      relation_type: rel.relation_type,
    });
    await ingestWebCapture({ store, tempRoot, input: toAppPayload(newById.Fake02ArtifactId, imgFake02) });
    await ingestWebCapture({ store, tempRoot, input: toAppPayload(newById.Fake01ArtifactId, imgFake01, { captureMode: "manual" }) });
    const h2AfterDelete = await store.getAssetGenerationHistory("default", r2.asset.id);
    assert.equal(h2AfterDelete.relations.length, 0);
  }

  // 3b. Child-then-parent: ref + Fake02 first -> 0; Fake01 manual later -> 1
  {
    const { store, tempRoot } = await makeEnv("3b");
    await ingestWebCapture({ store, tempRoot, input: toAppPayload(newRefFake01, imgFake01) });
    const r2 = await ingestWebCapture({ store, tempRoot, input: toAppPayload(newById.Fake02ArtifactId, imgFake02) });
    assert.equal((await store.getAssetGenerationHistory("default", r2.asset.id)).relations.length, 0);

    const r1 = await ingestWebCapture({ store, tempRoot, input: toAppPayload(newById.Fake01ArtifactId, imgFake01, { captureMode: "manual" }) });
    const h2 = await store.getAssetGenerationHistory("default", r2.asset.id);
    assert.equal(h2.relations.length, 1);
    assert.equal(h2.events.some((e) => e.output_asset_id === r1.asset.id), true);
  }

  // 3e + 3f. Old-UI history: uploaded base image & text-to-image
  {
    const { store, tempRoot } = await makeEnv("3e");
    const refUpload = oldRefs.find((r) => r.providerAssetId === "ref:FakeUpload01Ab2c");
    const refOld01 = oldRefs.find((r) => r.providerAssetId === "ref:FakeAgentArt0001");
    assert.ok(refUpload && refOld01);

    // Ingest same bytes as ChatGPT first -> still must NOT link to Lovart child
    await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "chatgpt",
        mediaKind: "image",
        mimeType: "image/jpeg",
        imageBase64: imgUpload.toString("base64"),
        prompt: "uploaded photo from another source",
        prompt_status: "generation-tool-prompt",
        conversationId: "conv-gpt-other",
        messageId: "msg-gpt-other",
        providerAssetId: "file-gpt-upload",
      },
    });
    await ingestWebCapture({ store, tempRoot, input: toAppPayload(refUpload, imgUpload) });
    const r01 = await ingestWebCapture({ store, tempRoot, input: toAppPayload(oldById.FakeAgentArt0001, imgOld01) });
    assert.equal(r01.asset.references.length, 1);
    assert.equal((await store.getAssetGenerationHistory("default", r01.asset.id)).relations.length, 0);

    // Now manually save the uploaded image from Lovart (right-click, no prompt)
    await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "lovart",
        mediaKind: "image",
        mimeType: "image/jpeg",
        imageBase64: imgUpload.toString("base64"),
        prompt: "",
        prompt_status: "not-available",
        captureMode: "manual",
        providerAssetId: "FakeUpload01Ab2c",
        sourceMediaUrl: "https://a.lovart.ai/artifacts/generator/FakeUpload01Ab2c.png",
        finalMediaUrl: "https://a.lovart.ai/artifacts/generator/FakeUpload01Ab2c.png",
      },
    });
    const h01 = await store.getAssetGenerationHistory("default", r01.asset.id);
    assert.equal(h01.relations.length, 1);
    assert.equal(h01.relations[0].evidence.parent_provider_asset_id, "FakeUpload01Ab2c");

    // FakeAgentArt0002 -> links to FakeAgentArt0001
    await ingestWebCapture({ store, tempRoot, input: toAppPayload(refOld01, imgOld01) });
    const r02 = await ingestWebCapture({ store, tempRoot, input: toAppPayload(oldById.FakeAgentArt0002, imgOld02) });
    const h02 = await store.getAssetGenerationHistory("default", r02.asset.id);
    const link02to01 = h02.relations.find((r) => r.evidence.parent_provider_asset_id === "FakeAgentArt0001");
    assert.ok(link02to01);

    // 3f. TEXT_TO_IMAGE (FakeAgentArt0003) -> no references, no relations
    const r03 = await ingestWebCapture({ store, tempRoot, input: toAppPayload(oldById.FakeAgentArt0003, imgOld03) });
    assert.equal(r03.asset.references?.length || 0, 0);
    assert.equal((await store.getAssetGenerationHistory("default", r03.asset.id)).relations.length, 0);
  }

  // 3g. Same generationContextId, two children with distinct reference_provider_asset_ids vs legacy extension without list
  {
    const { store, tempRoot } = await makeEnv("3g");
    const rP1 = await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "lovart",
        mediaKind: "image",
        mimeType: "image/jpeg",
        imageBase64: imgP1.toString("base64"),
        prompt: "parent 1",
        prompt_status: "generation-tool-prompt",
        conversationId: "conv-3g",
        generationContextId: "ctx-parents",
        messageId: "ctx-parents",
        providerAssetId: "P1",
        reference_provider_asset_ids: [],
      },
    });
    const rP2 = await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "lovart",
        mediaKind: "image",
        mimeType: "image/jpeg",
        imageBase64: imgP2.toString("base64"),
        prompt: "parent 2",
        prompt_status: "generation-tool-prompt",
        conversationId: "conv-3g",
        generationContextId: "ctx-parents",
        messageId: "ctx-parents",
        providerAssetId: "P2",
        reference_provider_asset_ids: [],
      },
    });
    await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "lovart",
        mediaKind: "image",
        mimeType: "image/jpeg",
        imageBase64: imgP1.toString("base64"),
        is_reference: true,
        conversationId: "conv-3g",
        generationContextId: "ctx-same-turn",
        providerAssetId: "ref:P1",
      },
    });
    await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "lovart",
        mediaKind: "image",
        mimeType: "image/jpeg",
        imageBase64: imgP2.toString("base64"),
        is_reference: true,
        conversationId: "conv-3g",
        generationContextId: "ctx-same-turn",
        providerAssetId: "ref:P2",
      },
    });

    const rA = await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "lovart",
        mediaKind: "image",
        mimeType: "image/jpeg",
        imageBase64: imgChildA.toString("base64"),
        prompt: "child A from P1",
        prompt_status: "generation-tool-prompt",
        conversationId: "conv-3g",
        generationContextId: "ctx-same-turn",
        messageId: "ctx-same-turn",
        providerAssetId: "ChildA",
        reference_provider_asset_ids: ["ref:P1"],
      },
    });
    const rB = await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "lovart",
        mediaKind: "image",
        mimeType: "image/jpeg",
        imageBase64: imgChildB.toString("base64"),
        prompt: "child B from P2",
        prompt_status: "generation-tool-prompt",
        conversationId: "conv-3g",
        generationContextId: "ctx-same-turn",
        messageId: "ctx-same-turn",
        providerAssetId: "ChildB",
        reference_provider_asset_ids: ["ref:P2"],
      },
    });

    assert.deepEqual(rA.asset.references.map((ref) => ref.provider_asset_id), ["ref:P1"]);
    assert.deepEqual(rB.asset.references.map((ref) => ref.provider_asset_id), ["ref:P2"]);
    const hA = await store.getAssetGenerationHistory("default", rA.asset.id);
    const hB = await store.getAssetGenerationHistory("default", rB.asset.id);
    assert.equal(hA.relations.length, 1);
    assert.equal(hA.relations[0].evidence.parent_provider_asset_id, "P1");
    assert.equal(hA.events.some((e) => e.output_asset_id === rP1.asset.id), true);
    assert.equal(hA.events.some((e) => e.output_asset_id === rP2.asset.id), false);
    assert.equal(hB.relations.length, 1);
    assert.equal(hB.relations[0].evidence.parent_provider_asset_id, "P2");
    assert.equal(hB.events.some((e) => e.output_asset_id === rP2.asset.id), true);
    assert.equal(hB.events.some((e) => e.output_asset_id === rP1.asset.id), false);

    // Legacy extension (no reference_provider_asset_ids): both children receive both turn references
    const rALegacy = await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "lovart",
        mediaKind: "image",
        mimeType: "image/jpeg",
        imageBase64: imgChildALegacy.toString("base64"),
        prompt: "legacy child A",
        prompt_status: "generation-tool-prompt",
        conversationId: "conv-3g",
        generationContextId: "ctx-same-turn",
        messageId: "ctx-same-turn",
        providerAssetId: "ChildALegacy",
      },
    });
    const rBLegacy = await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "lovart",
        mediaKind: "image",
        mimeType: "image/jpeg",
        imageBase64: imgChildBLegacy.toString("base64"),
        prompt: "legacy child B",
        prompt_status: "generation-tool-prompt",
        conversationId: "conv-3g",
        generationContextId: "ctx-same-turn",
        messageId: "ctx-same-turn",
        providerAssetId: "ChildBLegacy",
      },
    });
    assert.equal(rALegacy.asset.references.length, 2, "旧扩展行为保持：不带清单时仍按整轮挂全部参考图");
    assert.equal(rBLegacy.asset.references.length, 2, "旧扩展行为保持：不带清单时仍按整轮挂全部参考图");
  }

  // 3h. Mismatched ID: ref:Fake01ArtifactIdX when library only has Fake01ArtifactId -> no relation
  {
    const { store, tempRoot } = await makeEnv("3h");
    await ingestWebCapture({ store, tempRoot, input: toAppPayload(newById.Fake01ArtifactId, imgFake01) });
    await ingestWebCapture({
      store,
      tempRoot,
      input: toAppPayload(newRefFake01, imgFake01, { providerAssetId: "ref:Fake01ArtifactIdX" }),
    });
    const rMis = await ingestWebCapture({
      store,
      tempRoot,
      input: toAppPayload(newById.Fake02ArtifactId, imgMismatch, {
        providerAssetId: "Fake02MismatchId",
        reference_provider_asset_ids: ["ref:Fake01ArtifactIdX"],
      }),
    });
    assert.equal((await store.getAssetGenerationHistory("default", rMis.asset.id)).relations.length, 0);
  }
});
