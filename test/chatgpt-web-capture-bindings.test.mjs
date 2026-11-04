// chatgpt-web-capture-bindings.test.mjs — task 353 item 3: after the live
// push is missed (page refresh, conversation switch, second tab), the image
// that appears later must still match its prompt. The extension mirrors every
// push that carries a provider file id into chrome.storage.session, keyed by
// that file id, and rehydrates the registry wherever the image later appears.
//
// The page-hook side of every scenario replays the real 2026-11-03 Chrome
// capture (test/fixtures/chatgpt-image-gen-ws-2026-11-03.json) through
// page-hook-harness; the content-script side runs the real content.js
// functions extracted into a vm the way chatgpt-web-capture-hook.test.mjs
// does, with a Map-backed fake of chrome.storage.session.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import vm from "node:vm";
import { createHookHarness } from "./helpers/page-hook-harness.mjs";

const contentSource = await readFile(new URL("../extensions/chatgpt-web-capture/content.js", import.meta.url), "utf8");
const SAMPLE = JSON.parse(await readFile(new URL("./fixtures/chatgpt-image-gen-ws-2026-11-03.json", import.meta.url), "utf8"));

const TOOL_CALL_FRAME = SAMPLE.wsFrames.find((entry) => entry.i === 11).frame;
const TOOL_RESULT_FRAME = SAMPLE.wsFrames.find((entry) => entry.i === 15).frame;
const toolResultMessage = TOOL_RESULT_FRAME.payload.update_content.messages[0];
const REAL_REQUEST_PROMPT = JSON.parse(TOOL_CALL_FRAME.payload.update_content.messages[0].content.text).prompt;
const CAPTION = toolResultMessage.content.parts.find((part) => typeof part === "string" && part.startsWith("Model caption: "));
const FILE_ID = toolResultMessage.content.parts
  .find((part) => part?.content_type === "image_asset_pointer").asset_pointer
  .replace(/^sediment:\/\//, "");
const CONVERSATION_ID = TOOL_RESULT_FRAME.payload.conversation_id;
const MESSAGE_ID = toolResultMessage.id;
const IMAGE_GEN_TITLE = toolResultMessage.metadata.image_gen_title;
const ESTUARY_URL = `https://chatgpt.com/backend-api/estuary/content?cid=${CONVERSATION_ID}&id=${FILE_ID}&sig=signed`;

/** The page hook's own generation-meta payloads for the sample capture. */
async function sampleHookPayloads() {
  const harness = createHookHarness({}, "conversation-test");
  for (const entry of SAMPLE.wsFrames) {
    if (entry.frame) await harness.socketFrame(JSON.stringify(entry.frame));
  }
  const payloads = harness.events
    .filter((event) => event.type === "generation-meta" && event.payload?.assetId === FILE_ID)
    .map((event) => event.payload);
  assert.ok(payloads.length >= 1, "the sample capture must produce generation-meta events");
  return payloads;
}

/** A Map-backed chrome.storage.session fake (shared object = shared store). */
function fakeSessionStorage() {
  const store = new Map();
  return {
    store,
    session: {
      async get(keys) {
        if (keys === null) return Object.fromEntries(store);
        const wanted = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const key of wanted) if (store.has(key)) out[key] = store.get(key);
        return out;
      },
      async set(patch) { for (const [key, value] of Object.entries(patch)) store.set(key, value); },
      async remove(keys) { for (const key of [].concat(keys)) store.delete(key); },
    },
  };
}

/** The real content.js persistence + registry functions in a vm context. */
function contentPersistenceHarness({ sessionStorage, location } = {}) {
  const constants = ["GENERATION_BINDING_KEY_PREFIX", "GENERATION_BINDINGS_MAX", "GENERATION_BINDINGS_TTL_MS", "MAX_BLOB_ASSETS"]
    .map((name) => new RegExp(`const ${name} = [^;]+;`).exec(contentSource)?.[0]);
  const hydrationGuard = new RegExp("let generationBindingsHydration = [^;]+;").exec(contentSource)?.[0];
  assert.ok(constants.every(Boolean) && hydrationGuard, "persistence constants must be extractable");
  const names = [
    "normalizeAssetId", "cleanPromptText", "normalizeGenerationStatus",
    "promptQuality", "metaPromptQuality",
    "chatGptImageProxyInfo", "imageLookupKeys", "blobAssetIdForUrl",
    "isTrustedBlobAssetUrl", "normalizeBlobAssetId", "rememberBlobAsset",
    "generationRegistryForPage",
    "generationBindingRecord", "generationBindingEntry",
    "persistGenerationBinding", "mergeGenerationBindingRecords",
    "hydratePersistedGenerationBindings",
  ];
  const source = names.map((name) => {
    const match = new RegExp(`\\n {2}(?:async )?function ${name}\\([\\s\\S]*?\\n {2}\\}`).exec(contentSource);
    assert.ok(match, `missing ${name}`);
    return match[0];
  }).join("\n");
  const context = {
    Date, JSON, Math, Object, String, URL, Set, Map, RegExp, Array,
    location: location || { href: `https://chatgpt.com/c/${CONVERSATION_ID}`, origin: "https://chatgpt.com", pathname: `/c/${CONVERSATION_ID}` },
    blobAssetIds: new Map(),
    chrome: { storage: { session: sessionStorage } },
    scans: 0,
    scheduleScan: (force) => { context.scans += 1; },
  };
  vm.runInNewContext(`${constants.join("\n")}\n${hydrationGuard}\n${source}\nglobalThis.persist = persistGenerationBinding;\nglobalThis.hydrate = hydratePersistedGenerationBindings;\nglobalThis.generationRegistry = null;`, context);
  return context;
}

const generationRegistrySource = await readFile(
  new URL("../extensions/chatgpt-web-capture/generation-registry.js", import.meta.url),
  "utf8",
);

/** Attach the real generation registry (generation-registry.js) to a context. */
function attachRegistryTo(context) {
  if (!context.metaPromptQuality) {
    const source = ["promptQuality", "metaPromptQuality"]
      .map((name) => new RegExp(`\\n {2}function ${name}\\([\\s\\S]*?\\n {2}\\}`).exec(contentSource)?.[0])
      .filter(Boolean)
      .join("\n");
    assert.ok(source, "prompt quality ranking must be extractable");
    vm.runInNewContext(source, context);
  }
  vm.runInNewContext(generationRegistrySource, context);
  const factory = context.MosaGenerationRegistry?.createGenerationRegistry ?? null;
  assert.ok(factory, "the real registry factory must install");
  context.generationRegistry = factory({
    imageLookupKeys: context.imageLookupKeys,
    promptQuality: context.metaPromptQuality,
  });
}

test("A — same page, push first, image after: both texts bind to the file id", async () => {
  const harness = createHookHarness({}, "conversation-test");
  for (const entry of SAMPLE.wsFrames) {
    if (entry.frame) await harness.socketFrame(JSON.stringify(entry.frame));
  }
  const bound = harness.events
    .filter((event) => event.type === "generation-meta" && event.payload?.assetId === FILE_ID)
    .map((event) => event.payload);
  const withPrompt = bound.filter((payload) => payload.prompt);
  assert.equal(withPrompt.length, 1, "the frame-15 result binds once with the caption");
  assert.match(withPrompt[0].prompt, /^Model caption: A clean, minimalist/);
  assert.equal(withPrompt[0].generationRequestPrompt, REAL_REQUEST_PROMPT, "the real tool prompt travels with the same event");
  assert.equal(withPrompt[0].conversationId, CONVERSATION_ID);
  assert.equal(withPrompt[0].messageId, MESSAGE_ID);
  assert.equal(withPrompt[0].promptStatus, "visible-caption");
});

test("the persisted record carries the real prompt, the caption, the title and the conversation", async () => {
  const storage = fakeSessionStorage();
  const context = contentPersistenceHarness({ sessionStorage: storage.session });
  const [payload] = (await sampleHookPayloads()).filter((entry) => entry.prompt);

  await context.persist(payload);
  const record = storage.store.get(`mosaGenerationBinding:${FILE_ID}`);
  assert.ok(record, "the record is stored under the provider file id");
  assert.equal(record.generationRequestPrompt, REAL_REQUEST_PROMPT);
  assert.match(record.prompt, /^Model caption:/);
  assert.equal(record.imageGenTitle, IMAGE_GEN_TITLE);
  assert.equal(record.conversationId, CONVERSATION_ID);
  assert.equal(record.messageId, MESSAGE_ID);
  assert.equal(record.isGeneration, true);
});

test("C — after a page refresh a fresh content script rehydrates and binds the image", async () => {
  const storage = fakeSessionStorage();
  const pageOne = contentPersistenceHarness({ sessionStorage: storage.session });
  for (const payload of (await sampleHookPayloads()).filter((entry) => entry.prompt || entry.generationRequestPrompt)) {
    await pageOne.persist(payload);
  }
  assert.ok(storage.store.size >= 1);

  // Refresh: a brand-new context with an empty in-memory registry.
  const refreshed = contentPersistenceHarness({ sessionStorage: storage.session });
  assert.equal(refreshed.generationRegistry, null);
  attachRegistryTo(refreshed);
  await refreshed.hydrate();
  await setImmediate();
  const resolved = refreshed.generationRegistry.resolvedForImage(ESTUARY_URL);
  assert.ok(resolved, "the rehydrated registry answers for the estuary file id");
  assert.match(resolved.prompt, /^Model caption:/);
  assert.equal(resolved.generationRequestPrompt, REAL_REQUEST_PROMPT);
  assert.equal(resolved.isGeneration, true);
  assert.ok(refreshed.scans >= 1, "hydration triggers a rescan so queued candidates pick the binding");
});

test("B — push arrives while another conversation is open; the file-id record is kept and rescues the image later", async () => {
  const storage = fakeSessionStorage();
  // The page sits on a different conversation (the hook still emits the event
  // with the push's own conversation id; rememberMeta's adoption gate drops
  // it, which is exactly why the pre-gate persistence exists).
  const awayPage = contentPersistenceHarness({
    sessionStorage: storage.session,
    location: { href: "https://chatgpt.com/c/another-conversation", origin: "https://chatgpt.com", pathname: "/c/another-conversation" },
  });
  const payload = (await sampleHookPayloads()).find((entry) => entry.prompt);
  await awayPage.persist(payload);
  const record = storage.store.get(`mosaGenerationBinding:${FILE_ID}`);
  assert.ok(record, "the record persists regardless of the open conversation");
  assert.equal(record.conversationId, CONVERSATION_ID, "the record carries the push's conversation, not the open one");

  // Back on the image's conversation (SPA switch): hydration binds it.
  const back = contentPersistenceHarness({ sessionStorage: storage.session });
  attachRegistryTo(back);
  await back.hydrate();
  await setImmediate();
  const resolved = back.generationRegistry.resolvedForImage(ESTUARY_URL);
  assert.ok(resolved);
  assert.match(resolved.prompt, /^Model caption:/);
  assert.equal(resolved.generationRequestPrompt, REAL_REQUEST_PROMPT);
});

test("D — a second tab opens the conversation and hydrates the same session store", async () => {
  const storage = fakeSessionStorage();
  const tabOne = contentPersistenceHarness({ sessionStorage: storage.session });
  for (const payload of (await sampleHookPayloads()).filter((entry) => entry.prompt || entry.generationRequestPrompt)) {
    await tabOne.persist(payload);
  }

  // Tab 2: same extension session store, no live events of its own.
  const tabTwo = contentPersistenceHarness({ sessionStorage: storage.session });
  attachRegistryTo(tabTwo);
  await tabTwo.hydrate();
  await setImmediate();
  const resolved = tabTwo.generationRegistry.resolvedForImage(ESTUARY_URL);
  assert.ok(resolved, "chrome.storage.session is shared per extension, so tab 2 binds from tab 1's records");
  assert.match(resolved.prompt, /^Model caption:/);
  assert.equal(resolved.generationRequestPrompt, REAL_REQUEST_PROMPT);
});

test("the store is capped at 200 records and drops bindings older than 24 hours", async () => {
  const storage = fakeSessionStorage();
  const context = contentPersistenceHarness({ sessionStorage: storage.session });
  const now = Date.now();
  // 250 records: 50 are older than the TTL, the rest overflow the cap.
  for (let index = 0; index < 250; index += 1) {
    const age = index < 50 ? 25 * 60 * 60 * 1000 + index * 1000 : index * 1000;
    const record = {
      assetId: `file_cap_${String(index).padStart(4, "0")}`,
      prompt: `caption ${index}`,
      promptStatus: "visible-caption",
      isGeneration: true,
      capturedAt: new Date(now - (24 * 60 * 60 * 1000 - 1000) - age + (24 * 60 * 60 * 1000)).toISOString(),
    };
    // Simplify: records 0..49 are 25h old, the rest are fresh minutes apart.
    record.capturedAt = index < 50
      ? new Date(now - 25 * 60 * 60 * 1000).toISOString()
      : new Date(now - (200 - index) * 60 * 1000).toISOString();
    storage.store.set(`mosaGenerationBinding:${record.assetId}`, record);
  }
  assert.equal(storage.store.size, 250);
  attachRegistryTo(context);
  await context.hydrate();
  await setImmediate();
  assert.equal(storage.store.size, 200, "hydration prunes expired and overflow records");
  for (const [key] of storage.store) {
    const record = storage.store.get(key);
    assert.ok(Date.parse(record.capturedAt) > now - 24 * 60 * 60 * 1000, "every surviving record is within the TTL");
    assert.ok(key.startsWith("mosaGenerationBinding:file_cap_"), "pruning keeps the newest records");
  }
});

test("the wiring persists before the adoption gate and hydrates at boot and on switch", () => {
  const handlerIndex = contentSource.indexOf("function handlePageHookEvent");
  const gateIndex = contentSource.indexOf("const meta = rememberMeta(data.payload);", handlerIndex);
  const persistIndex = contentSource.indexOf("persistGenerationBinding(data.payload);", handlerIndex);
  assert.ok(handlerIndex >= 0 && gateIndex > 0 && persistIndex > 0);
  assert.ok(persistIndex < gateIndex, "the file-id record is written before the conversation-identity gate can drop the event");

  const bootStart = contentSource.indexOf("loadSettings().then(() => {");
  const bootEnd = contentSource.indexOf("});", bootStart);
  assert.match(contentSource.slice(bootStart, bootEnd), /hydratePersistedGenerationBindings\(\);/, "boot hydrates");
  assert.match(
    contentSource,
    /nextConversationId !== previousConversationId\) hydratePersistedGenerationBindings\(\);/,
    "an SPA conversation switch rehydrates (records may have arrived while away)",
  );
});
