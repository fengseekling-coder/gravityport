// chatgpt-web-capture-bindings.test.mjs — task 353 item 3: after the live
// push is missed (page refresh, conversation switch, second tab), the image
// that appears later must still match its prompt. The extension mirrors every
// push that carries a provider file id into chrome.storage.session, keyed by
// that file id, and rehydrates the registry wherever the image later appears.
//
// The page-hook side of every scenario replays the real 2026-11-03 Chrome
// capture (test/fixtures/chatgpt-image-gen-ws-2026-11-03.json) through
// page-hook-harness; the content-script side boots the real content.js
// through createContentHarness (task 411: no more slicing functions out of
// the source — persist/hydrate are body function declarations, reachable as
// sandbox globals, and the registry is the real generationRegistryForPage()).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { createContentHarness } from "./helpers/content-harness.mjs";
import { createHookHarness } from "./helpers/page-hook-harness.mjs";

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

/**
 * Boot the real content.js on an optional shared chrome.storage.session Map
 * (the same store two tabs of the extension see). The tests drive the real
 * functions directly: context.persistGenerationBinding and
 * context.hydratePersistedGenerationBindings, with the registry exposed by
 * the harness's __mosaContentState introspection.
 */
async function contentPersistenceHarness({ sessionStore, pathname } = {}) {
  return createContentHarness({
    pathname: pathname || `/c/${CONVERSATION_ID}`,
    ...(sessionStore ? { sessionStore } : {}),
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
  const page = await contentPersistenceHarness();
  const [payload] = (await sampleHookPayloads()).filter((entry) => entry.prompt);

  await page.context.persistGenerationBinding(payload);
  const record = page.storage.session.get(`mosaGenerationBinding:${FILE_ID}`);
  assert.ok(record, "the record is stored under the provider file id");
  assert.equal(record.generationRequestPrompt, REAL_REQUEST_PROMPT);
  assert.match(record.prompt, /^Model caption:/);
  assert.equal(record.imageGenTitle, IMAGE_GEN_TITLE);
  assert.equal(record.conversationId, CONVERSATION_ID);
  assert.equal(record.messageId, MESSAGE_ID);
  assert.equal(record.isGeneration, true);
});

test("C — after a page refresh a fresh content script rehydrates and binds the image", async () => {
  const store = new Map();
  const pageOne = await contentPersistenceHarness({ sessionStore: store });
  for (const payload of (await sampleHookPayloads()).filter((entry) => entry.prompt || entry.generationRequestPrompt)) {
    await pageOne.context.persistGenerationBinding(payload);
  }
  assert.ok(store.size >= 1);

  // Refresh: a brand-new content script boots on the same session store with
  // an empty in-memory registry; hydrating is what binds the image again.
  const refreshed = await contentPersistenceHarness({ sessionStore: store });
  const timeoutsBeforeHydration = refreshed.timers.timeouts.length;
  await refreshed.context.hydratePersistedGenerationBindings();
  await setImmediate();
  const resolved = refreshed.state.generationRegistry.resolvedForImage(ESTUARY_URL);
  assert.ok(resolved, "the rehydrated registry answers for the estuary file id");
  assert.match(resolved.prompt, /^Model caption:/);
  assert.equal(resolved.generationRequestPrompt, REAL_REQUEST_PROMPT);
  assert.equal(resolved.isGeneration, true);
  assert.ok(
    refreshed.timers.timeouts.length > timeoutsBeforeHydration,
    "hydration triggers a rescan so queued candidates pick the binding",
  );
});

test("B — push arrives while another conversation is open; the file-id record is kept and rescues the image later", async () => {
  const store = new Map();
  // The page sits on a different conversation (the hook still emits the event
  // with the push's own conversation id; rememberMeta's adoption gate drops
  // it, which is exactly why the pre-gate persistence exists — that wiring is
  // exercised for real by the "persists a push the adoption gate drops" test
  // below).
  const awayPage = await contentPersistenceHarness({ sessionStore: store, pathname: "/c/another-conversation" });
  const payload = (await sampleHookPayloads()).find((entry) => entry.prompt);
  await awayPage.context.persistGenerationBinding(payload);
  const record = store.get(`mosaGenerationBinding:${FILE_ID}`);
  assert.ok(record, "the record persists regardless of the open conversation");
  assert.equal(record.conversationId, CONVERSATION_ID, "the record carries the push's conversation, not the open one");

  // Back on the image's conversation (SPA switch): hydration binds it.
  const back = await contentPersistenceHarness({ sessionStore: store });
  await back.context.hydratePersistedGenerationBindings();
  await setImmediate();
  const resolved = back.state.generationRegistry.resolvedForImage(ESTUARY_URL);
  assert.ok(resolved);
  assert.match(resolved.prompt, /^Model caption:/);
  assert.equal(resolved.generationRequestPrompt, REAL_REQUEST_PROMPT);
});

test("D — a second tab opens the conversation and hydrates the same session store", async () => {
  const store = new Map();
  const tabOne = await contentPersistenceHarness({ sessionStore: store });
  for (const payload of (await sampleHookPayloads()).filter((entry) => entry.prompt || entry.generationRequestPrompt)) {
    await tabOne.context.persistGenerationBinding(payload);
  }

  // Tab 2: same extension session store, no live events of its own.
  const tabTwo = await contentPersistenceHarness({ sessionStore: store });
  await tabTwo.context.hydratePersistedGenerationBindings();
  await setImmediate();
  const resolved = tabTwo.state.generationRegistry.resolvedForImage(ESTUARY_URL);
  assert.ok(resolved, "chrome.storage.session is shared per extension, so tab 2 binds from tab 1's records");
  assert.match(resolved.prompt, /^Model caption:/);
  assert.equal(resolved.generationRequestPrompt, REAL_REQUEST_PROMPT);
});

test("the store is capped at 200 records and drops bindings older than 24 hours", async () => {
  const store = new Map();
  const page = await contentPersistenceHarness({ sessionStore: store });
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
    store.set(`mosaGenerationBinding:${record.assetId}`, record);
  }
  assert.equal(store.size, 250);
  await page.context.hydratePersistedGenerationBindings();
  await setImmediate();
  assert.equal(store.size, 200, "hydration prunes expired and overflow records");
  for (const [key, record] of store) {
    assert.ok(Date.parse(record.capturedAt) > now - 24 * 60 * 60 * 1000, "every surviving record is within the TTL");
    assert.ok(key.startsWith("mosaGenerationBinding:file_cap_"), "pruning keeps the newest records");
  }
});

test("a generation-meta push the adoption gate drops still leaves its file-id record", async () => {
  // The wiring rule this locks: persistGenerationBinding runs BEFORE the
  // conversation-identity gate inside handlePageHookEvent, so a push that
  // arrives while another conversation is open is not lost (the gate drops
  // the event itself, but the file-id record is conversation-agnostic).
  const store = new Map();
  const awayPage = await contentPersistenceHarness({ sessionStore: store, pathname: "/c/another-conversation" });
  awayPage.offerHookPort();
  const payload = (await sampleHookPayloads()).find((entry) => entry.prompt);
  awayPage.deliverHookEvent("generation-meta", payload);
  await awayPage.flush();

  const record = store.get(`mosaGenerationBinding:${FILE_ID}`);
  assert.ok(record, "the record is written even though the gate dropped the event");
  assert.equal(record.conversationId, CONVERSATION_ID, "the record carries the push's conversation, not the open one");
  assert.equal(record.messageId, MESSAGE_ID);
  assert.match(record.prompt, /^Model caption:/);
  assert.equal(awayPage.state.generationRegistry, null, "the gate kept the event itself out of the in-memory registry");
});

test("a fresh page hydrates the persisted bindings at boot", async () => {
  const store = new Map();
  const pageOne = await contentPersistenceHarness({ sessionStore: store });
  for (const payload of (await sampleHookPayloads()).filter((entry) => entry.prompt || entry.generationRequestPrompt)) {
    await pageOne.context.persistGenerationBinding(payload);
  }

  // A brand-new page, no test-driven hydrate call: boot alone
  // (loadSettings().then → hydratePersistedGenerationBindings) must bind.
  const fresh = await contentPersistenceHarness({ sessionStore: store });
  const resolved = fresh.state.generationRegistry?.resolvedForImage(ESTUARY_URL);
  assert.ok(resolved, "boot hydration bound the persisted record without any explicit hydrate call");
  assert.match(resolved.prompt, /^Model caption:/);
  assert.equal(resolved.generationRequestPrompt, REAL_REQUEST_PROMPT);
});

test("an SPA conversation switch rehydrates bindings persisted while away", async () => {
  const store = new Map();
  // Boot on a different conversation with an empty store: boot hydration
  // finds nothing and the registry stays empty.
  const page = await contentPersistenceHarness({ sessionStore: store, pathname: "/c/conv-away" });
  assert.equal(page.state.generationRegistry, null, "nothing to bind before the push arrives");
  // While away, a push for the image's conversation arrives; the adoption
  // gate drops the event but its file-id record is persisted.
  page.offerHookPort();
  const payload = (await sampleHookPayloads()).find((entry) => entry.prompt);
  page.deliverHookEvent("generation-meta", payload);
  await page.flush();
  assert.ok(store.get(`mosaGenerationBinding:${FILE_ID}`), "the record survived while the user was away");
  assert.equal(page.state.generationRegistry, null, "the gate kept the event out of the in-memory registry");

  // Switch to the push's conversation: the next scan notices the URL change
  // and rehydrates (records may have arrived while away).
  page.location.href = `https://chatgpt.com/c/${CONVERSATION_ID}`;
  page.location.pathname = `/c/${CONVERSATION_ID}`;
  page.context.scheduleScan(true);
  page.fireTimeouts();
  await page.flush();

  const resolved = page.state.generationRegistry?.resolvedForImage(ESTUARY_URL);
  assert.ok(resolved, "the switch rehydrated the record persisted while away");
  assert.match(resolved.prompt, /^Model caption:/);
  assert.equal(resolved.generationRequestPrompt, REAL_REQUEST_PROMPT);
});
