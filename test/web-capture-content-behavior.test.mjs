// Task 390 (review 4-1 丙): behavior tests for extensions/chatgpt-web-capture/content.js.
// Every test here boots the REAL content.js through test/helpers/content-harness.mjs
// and asserts on what it does — messages it sends, storage it touches, timers it
// schedules, DOM it builds — never on how the source is written.
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

import { createContentHarness, FakeImage, BIG_IMAGE_BASE64 } from "./helpers/content-harness.mjs";
import { MockMessagePort } from "./helpers/page-hook-harness.mjs";

const BLOB_CORE_URL = "https://sdmntprwestus.blob.core.windows.net/files/00000000-abcd/raw?se=2026&sig=x";
const fileUrl = (fileId) => `https://files.oaiusercontent.com/${fileId}?se=2026&sig=x`;
const sentOf = (harness, type) => harness.sentMessages.filter((entry) => entry.message?.type === type);
const ingests = (harness) => sentOf(harness, "mosa.ingest");
// Objects created inside the vm carry its realm's prototypes; compare through JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));

async function flushAutoCapture(harness, times = 15) {
  for (let index = 0; index < times; index += 1) await setImmediate();
}

/** Drive the captured timers forward: the script's own polling loops only
 * progress when their timeouts fire, so tests advance the clock and run the
 * due callbacks in 100 ms steps. */
async function pump(harness, totalMs) {
  for (let elapsed = 0; elapsed < totalMs; elapsed += 100) {
    harness.advance(100);
    harness.fireTimeouts();
    await setImmediate();
  }
  await flushAutoCapture(harness);
}

test("automatic capture stays off until it is explicitly enabled, then archives new images", async () => {
  // No background answer and no stored preference: the initializer decides,
  // and it is off. A new generation event must not send any capture message.
  const off = await createContentHarness({ settings: null });
  off.offerHookPort();
  off.deliverHookEvent("auto-image", { imageUrl: BLOB_CORE_URL, isGeneration: true });
  off.advance(1_000);
  await flushAutoCapture(off);
  assert.equal(ingests(off).length, 0, "no capture without an explicit enable");
  assert.equal(off.state.autoCapture, false);

  // An explicit local "off" is honored the same way...
  const explicitOff = await createContentHarness({ settings: null, localAutoCapture: false });
  explicitOff.offerHookPort();
  explicitOff.deliverHookEvent("auto-image", { imageUrl: BLOB_CORE_URL, isGeneration: true });
  explicitOff.advance(1_000);
  await flushAutoCapture(explicitOff);
  assert.equal(ingests(explicitOff).length, 0);

  // ...and a local storage flip to on (the settings toggle's real path)
  // starts archiving: the same event then sends mosa.fetchImage + mosa.ingest.
  explicitOff.storage.fireChanged({ autoCapture: { newValue: true } }, "local");
  assert.equal(explicitOff.state.autoCapture, true);
  explicitOff.deliverHookEvent("auto-image", { imageUrl: BLOB_CORE_URL, isGeneration: true });
  explicitOff.advance(1_000);
  await flushAutoCapture(explicitOff);
  assert.equal(ingests(explicitOff).length, 1, "the enabled capture archives the new image");
  assert.equal(sentOf(explicitOff, "mosa.fetchImage").length, 1, "the original bytes are fetched through the background");
  assert.equal(ingests(explicitOff)[0].message.payload.imageUrl, BLOB_CORE_URL);
});

test("auto-image events outside the generation hosts never archive", async () => {
  const harness = await createContentHarness({ settings: { autoCapture: true } });
  harness.offerHookPort();
  harness.deliverHookEvent("auto-image", { imageUrl: "https://example.org/pictures/x.png", isGeneration: true });
  harness.advance(1_000);
  await flushAutoCapture(harness);
  assert.equal(ingests(harness).length, 0, "unknown hosts are not generation output");
});

test("the page bridge adopts only the first port offered by this window, then acks and syncs over it", async () => {
  const harness = await createContentHarness();
  const requestAttempts = () => harness.windowMessages.filter((entry) => entry.event?.type === "hook-port-request");

  // No port yet: the content script asks for one with a backoff ladder,
  // four attempts at 1s/2s/4s/8s, then stops asking.
  assert.equal(harness.fireTimeouts({ ms: 1_000 }), 1);
  assert.equal(requestAttempts().length, 1);
  assert.equal(harness.fireTimeouts({ ms: 2_000 }), 1);
  assert.equal(requestAttempts().length, 2);
  assert.equal(harness.fireTimeouts({ ms: 4_000 }), 1);
  assert.equal(requestAttempts().length, 3);
  assert.equal(harness.fireTimeouts({ ms: 8_000 }), 1);
  assert.equal(requestAttempts().length, 4, "the ladder makes exactly four attempts");
  harness.advanceClock(60_000);
  assert.equal(harness.fireTimeouts({ ms: 8_000 }) + harness.fireTimeouts({ ms: 1_000 }), 0, "the ladder does not restart on its own");

  // The hook transfers a port through a window message from this window.
  const first = harness.offerHookPort();
  assert.deepEqual(plain(harness.portMessages), [{ source: "mosa-chatgpt-capture", type: "hook-port-ack" }],
    "the adopted port is acked immediately");

  // A transfer from another window is ignored even with a port attached —
  // on a page that has not adopted any port yet, so the source check is the
  // only gate (first-port-wins cannot mask it).
  const unclaimed = await createContentHarness();
  const impostor = new MockMessagePort();
  const impostorPeer = new MockMessagePort();
  impostor._entangle(impostorPeer);
  impostorPeer._entangle(impostor);
  impostorPeer.addEventListener("message", (event) => {
    if (event?.data && typeof event.data === "object") unclaimed.portMessages.push(event.data);
  });
  unclaimed.dispatchWindowMessage(
    { source: "mosa-chatgpt-capture", type: "hook-port" },
    { source: {}, ports: [impostor] },
  );
  assert.equal(unclaimed.portMessages.length, 0, "a hook-port transfer from another window is ignored");
  impostor._peer.postMessage({ source: "mosa-chatgpt-capture", type: "capture-state", payload: { enabled: true } });
  assert.equal(unclaimed.portMessages.length, 0, "events via a non-adopted port are ignored");

  // A second offer on the real window is ignored too; the first port stays.
  const second = harness.offerHookPort();
  assert.equal(harness.portMessages.length, 1, "no second ack; the first port is kept");
  harness.deliverHookEvent("harvest-skipped", { reason: "payload-too-large" });
  assert.equal(harness.state.lastStatus, "对话信息过大，将先保存图片，提示词可能稍后补充",
    "the first adopted port still carries hook traffic");
  assert.equal(harness.state.hookPort, first);

  // A capture-state ack that disagrees with the desired state re-syncs over
  // the port; DOMContentLoaded re-syncs as well.
  harness.deliverHookEvent("capture-state", { enabled: true });
  const syncs = () => harness.portMessages.filter((entry) => entry.type === "set-capture-enabled");
  assert.equal(syncs().length, 1);
  assert.deepEqual(plain(syncs()[0].payload), { enabled: false });
  await harness.fireDOMContentLoaded();
  assert.equal(syncs().length, 2, "DOMContentLoaded syncs the hook state again");

  // A pending ladder step must not mint anything once a port is adopted.
  harness.fireTimeouts({ ms: 1_000 });
  harness.fireTimeouts({ ms: 2_000 });
  assert.equal(requestAttempts().length, 4, "no port requests after adoption");
});

test("an archived image is not captured again, but a different image still is", async () => {
  const harness = await createContentHarness({ settings: { autoCapture: true } });
  harness.offerHookPort();
  const event = { imageUrl: fileUrl("file-dedupe1"), isGeneration: true, generationStatus: "completed" };

  harness.deliverHookEvent("auto-image", { ...event });
  await flushAutoCapture(harness);
  assert.equal(ingests(harness).length, 1);

  harness.deliverHookEvent("auto-image", { ...event });
  await flushAutoCapture(harness);
  assert.equal(ingests(harness).length, 1, "the same image identity is never sent twice");

  harness.deliverHookEvent("auto-image", { ...event, imageUrl: fileUrl("file-dedupe2") });
  await flushAutoCapture(harness);
  assert.equal(ingests(harness).length, 2, "a different image still archives");
  assert.ok(harness.state.savedIdentityKeys.size >= 2);
});

test("in-progress generations wait for pixel stability, expire after six seconds, and the other tiers wait their own floors", async () => {
  const images = [];
  const harness = await createContentHarness({ settings: { autoCapture: true }, images });
  harness.offerHookPort();
  images.push(new harness.context.HTMLImageElement({ src: fileUrl("file-stability1"), complete: true, naturalWidth: 1024, naturalHeight: 1024 }));

  // in_progress with a stable rendered canvas: not ready at first sight...
  harness.deliverHookEvent("auto-image", {
    imageUrl: fileUrl("file-stability1"), isGeneration: true, generationStatus: "in_progress",
  });
  await flushAutoCapture(harness);
  assert.equal(ingests(harness).length, 0, "an in-progress generation is not archived immediately");

  harness.advance(1_000);
  harness.fireTimeouts();
  await flushAutoCapture(harness);
  assert.equal(ingests(harness).length, 0, "still waiting before the six-second stale floor");

  // ...once the same rendered image has been stable past six seconds, the
  // stale in_progress marker no longer holds it back.
  harness.advance(5_500);
  harness.fireTimeouts();
  await flushAutoCapture(harness);
  assert.equal(ingests(harness).length, 1, "a stale in_progress generation archives provisionally");

  // An unknown status waits for the plain stability floor (900 ms)...
  const plainImages = [];
  const plainHarness = await createContentHarness({ settings: { autoCapture: true }, images: plainImages });
  plainHarness.offerHookPort();
  plainImages.push(new plainHarness.context.HTMLImageElement({ src: fileUrl("file-stability2"), complete: true, naturalWidth: 1024, naturalHeight: 1024 }));
  const plain = plainHarness;
  plain.deliverHookEvent("auto-image", { imageUrl: fileUrl("file-stability2"), isGeneration: true });
  plain.advance(500);
  plain.fireTimeouts();
  await flushAutoCapture(plain);
  assert.equal(ingests(plain).length, 0);
  plain.advance(500);
  plain.fireTimeouts();
  await flushAutoCapture(plain);
  assert.equal(ingests(plain).length, 1, "the plain stability floor is about 900 ms");

  // ...and a partial generation waits for the 15 s partial fallback.
  const partialImages = [];
  const partial = await createContentHarness({ settings: { autoCapture: true }, images: partialImages });
  partial.offerHookPort();
  partialImages.push(new partial.context.HTMLImageElement({ src: fileUrl("file-stability3"), complete: true, naturalWidth: 1024, naturalHeight: 1024 }));
  partial.deliverHookEvent("auto-image", {
    imageUrl: fileUrl("file-stability3"), isGeneration: true, generationStatus: "partial",
  });
  partial.advance(5_000);
  partial.fireTimeouts();
  await flushAutoCapture(partial);
  assert.equal(ingests(partial).length, 0);
  partial.advance(11_000);
  partial.fireTimeouts();
  await flushAutoCapture(partial);
  assert.equal(ingests(partial).length, 1, "a partial generation archives after its fallback window");
});

test("switching conversations drops the previous conversation's state and rehydrates persisted bindings", async () => {
  const harness = await createContentHarness({ settings: { autoCapture: true }, pathname: "/c/conv-a" });
  harness.offerHookPort();
  harness.deliverHookEvent("generation-meta", {
    conversationId: "conv-a", prompt: "poster prompt", imageUrl: fileUrl("file-switch1"), isGeneration: true,
  });
  await flushAutoCapture(harness);
  assert.equal((await harness.dispatchRuntimeMessage({ type: "mosa.capture.getPageState" })).state.cachedPromptCount, 1);
  const readsAtBoot = harness.storage.sessionReads.length;
  assert.ok(readsAtBoot >= 1, "boot hydrates the persisted bindings");

  // SPA switch to another conversation: the scan observes the URL change,
  // clears the transient state and hydrates the persisted bindings again.
  harness.location.href = "https://chatgpt.com/c/conv-b";
  harness.location.pathname = "/c/conv-b";
  harness.fireInterval(harness.state.autoScanInterval);
  harness.fireTimeouts();
  await flushAutoCapture(harness);
  const state = (await harness.dispatchRuntimeMessage({ type: "mosa.capture.getPageState" })).state;
  assert.equal(state.conversationId, "conv-b");
  assert.equal(state.cachedPromptCount, 0, "the previous conversation's cached prompts are gone");
  assert.ok(harness.storage.sessionReads.length > readsAtBoot, "the switch rehydrates persisted bindings");
});

test("adoptConversationId keeps live-only evidence on identity enrichment and resets on a real switch", async () => {
  const harness = await createContentHarness({ settings: null, pathname: "/" });
  const { context, state } = harness;
  state.activeConversationId = "";
  let resets = 0;
  context.resetConversationTransientState = () => {
    resets += 1;
  };

  assert.equal(context.currentConversationId(), "");
  assert.equal(context.adoptConversationId("conversation-new"), "conversation-new");
  assert.equal(resets, 0, "transport identity enrichment must preserve live-only evidence");
  harness.location.pathname = "/c/conversation-new";
  assert.equal(context.adoptConversationId("conversation-new"), "conversation-new");
  assert.equal(resets, 0, "URL assignment for the same conversation must not reset state");

  assert.equal(context.adoptConversationId("conversation-stale"), "", "stale transport events must lose to the named URL conversation");
  assert.equal(resets, 0);
  harness.location.pathname = "/c/conversation-other";
  assert.equal(context.adoptConversationId("conversation-other"), "conversation-other");
  assert.equal(resets, 1, "a real conversation switch must clear transient state once");
});

test("boot hydrates persisted bindings and never issues a conversation re-read", async () => {
  const harness = await createContentHarness({ settings: { autoCapture: true } });
  await harness.flush();
  assert.ok(harness.storage.sessionReads.length >= 1, "boot reads chrome.storage.session for persisted bindings");
  assert.equal(
    harness.sentMessages.filter((entry) => String(entry.message?.type || "").startsWith("mosa.")).some((entry) => entry.message.type !== "mosa.getSettings"),
    false,
    "boot sends nothing beyond the settings read",
  );
});

test("a harvest-skipped report surfaces a plain status instead of an error", async () => {
  const harness = await createContentHarness();
  harness.offerHookPort();
  harness.deliverHookEvent("harvest-skipped", { reason: "payload-too-large" });
  await harness.flush();
  const state = (await harness.dispatchRuntimeMessage({ type: "mosa.capture.getPageState" })).state;
  assert.equal(state.status, "对话信息过大，将先保存图片，提示词可能稍后补充");
  assert.equal(state.error, "", "a harvest skip is not an error");
});

test("the in-page panel carries the manual fallback actions and toggles closed again", async () => {
  const harness = await createContentHarness();
  const opened = await harness.dispatchRuntimeMessage({ type: "mosa.capture.togglePanel" });
  assert.equal(opened.ok, true);
  assert.equal(opened.open, true);
  const panel = harness.document.getElementById("mosa-capture-panel");
  assert.ok(panel, "the panel element exists in the page");
  assert.ok(panel.innerHTML.includes('data-action="save-visible"'), "manual save-current control exists");
  assert.ok(panel.innerHTML.includes('data-action="save-all"'), "manual save-all control exists");
  assert.ok(panel.innerHTML.includes('data-action="toggle-auto"'));

  const closed = await harness.dispatchRuntimeMessage({ type: "mosa.capture.togglePanel" });
  assert.equal(closed.open, false);
  harness.fireTimeouts({ ms: 150 });
  await harness.flush();
  assert.equal(harness.document.getElementById("mosa-capture-panel"), null, "the panel is removed after closing");
});

test("session titles are reported only while automatic capture is on, and observed for changes", async () => {
  const quiet = await createContentHarness({ title: "Named Chat", pathname: "/c/conv-1" });
  quiet.advance(1_000);
  quiet.fireTimeouts();
  await quiet.flush();
  assert.equal(sentOf(quiet, "mosa.reportSessionTitle").length, 0, "no title report with capture off");

  const harness = await createContentHarness({ settings: { autoCapture: true }, title: "Named Chat", pathname: "/c/conv-1" });
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.observers[0].observed[0].options)),
    { childList: true, characterData: true, subtree: true },
    "the title watcher observes the title node",
  );
  harness.fireTimeouts({ ms: 0 });
  await harness.flush();
  const reports = sentOf(harness, "mosa.reportSessionTitle");
  assert.equal(reports.length, 1);
  assert.deepEqual(plain(reports[0].message.payload), { provider: "chatgpt", conversationId: "conv-1", title: "Named Chat" });

  // The same conversation and title is not reported twice; enabling capture
  // later (storage flip) reports the open conversation.
  harness.observers[0].callback();
  harness.fireTimeouts({ ms: 800 });
  await harness.flush();
  assert.equal(sentOf(harness, "mosa.reportSessionTitle").length, 1, "the same title is reported once per session");

  const late = await createContentHarness({ title: "Named Chat", pathname: "/c/conv-1" });
  late.storage.fireChanged({ autoCapture: { newValue: true } }, "local");
  late.fireTimeouts({ ms: 0 });
  await late.flush();
  assert.equal(sentOf(late, "mosa.reportSessionTitle").length, 1, "enabling capture reports the open conversation once");
});

test("turn bindings reported by the hook are relayed to the background", async () => {
  const harness = await createContentHarness();
  harness.offerHookPort();
  harness.deliverHookEvent("conversation-turn-bindings", {
    conversationId: "conv-turns",
    turnCount: 1,
    bindings: [{ provider_asset_id: "file_turn1", message_id: "u1", turn_index: 1 }],
  });
  await harness.flush();
  const reports = sentOf(harness, "mosa.reportConversationTurns");
  assert.equal(reports.length, 1);
  assert.deepEqual(plain(reports[0].message.payload), {
    provider: "chatgpt",
    conversationId: "conv-turns",
    turnCount: 1,
    bindings: [{ provider_asset_id: "file_turn1", message_id: "u1", turn_index: 1 }],
  });
});

test("an orphaned content script explains itself instead of dying on sendMessage", async () => {
  // Boot with chrome.runtime gone (a reloaded unpacked extension): the boot
  // itself must survive (no TDZ error), flip to the refresh instruction, and
  // disconnect the observer.
  const harness = await createContentHarness({ orphanRuntime: true });
  assert.equal(harness.state.contextLost, true, "boot detects the dead context");
  assert.equal(harness.state.lastStatus, "扩展已更新，请刷新此页面以继续收录");
  assert.ok(harness.observers.some((observer) => observer.disconnectCount >= 1), "the initialized observer is disconnected");
  await assert.rejects(
    harness.context.runtimeSend({ type: "mosa.getSettings" }),
    /扩展已更新/,
  );
});

test("a settings read failure preserves an explicit local auto-capture choice and never rewrites settings", async () => {
  const harness = await createContentHarness({ settings: null, localAutoCapture: false });
  assert.equal(harness.state.autoCapture, false, "the local off choice survives a dead background");
  assert.equal(harness.storage.localReads.length, 1);
  assert.deepEqual(plain(harness.storage.localReads[0]), { autoCapture: false });
  assert.deepEqual(harness.storage.localWrites, [], "the content script must not rewrite settings");
});

test("the background setting wins without a redundant local read", async () => {
  const harness = await createContentHarness({ settings: { autoCapture: false }, localAutoCapture: true });
  assert.equal(harness.state.autoCapture, false);
  assert.deepEqual(harness.storage.localReads, []);
  assert.deepEqual(harness.storage.localWrites, []);
});

test("an open page follows auto-capture changes from local storage only", async () => {
  const harness = await createContentHarness({ settings: { autoCapture: false } });
  harness.offerHookPort();
  const syncs = () => harness.portMessages.filter((entry) => entry.type === "set-capture-enabled");

  harness.storage.fireChanged({ autoCapture: { newValue: true } }, "sync");
  assert.equal(harness.state.autoCapture, false, "a sync-area change is ignored");
  assert.deepEqual(syncs(), []);

  harness.storage.fireChanged({ autoCapture: { newValue: false } }, "local");
  assert.equal(harness.state.autoCapture, false);
  assert.equal(harness.state.lastStatus, "自动关");
  assert.deepEqual(plain(syncs().at(-1)?.payload), { enabled: false });

  harness.storage.fireChanged({ autoCapture: { newValue: true } }, "local");
  assert.equal(harness.state.autoCapture, true);
  assert.equal(harness.state.lastStatus, "自动开");
  assert.deepEqual(plain(syncs().at(-1)?.payload), { enabled: true });
  assert.ok(harness.observers.some((observer) => observer.observed.length >= 1), "the DOM observer starts with capture");
  assert.equal(harness.timers.intervals.every((timer) => timer.cleared), false, "the watchdog interval keeps running");
});

test("capture identity passthrough keeps transport conversation and provider call ids", async () => {
  const harness = await createContentHarness({ settings: null, pathname: "/c/conv-transport" });
  const { context } = harness;
  context.runtimeSend = async (message) => {
    harness.sentMessages.push({ message });
    return { ok: true, result: { status: "imported" } };
  };
  context.bytesFromUrlOrImg = async () => ({ mimeType: "image/png", imageBase64: BIG_IMAGE_BASE64 });
  context.showToast = () => {};
  context.setStatus = () => {};
  const meta = context.rememberMeta({
    prompt: "A detailed editorial poster with blue type",
    promptStatus: "generation-tool-prompt",
    imageUrl: fileUrl("file-passthrough"),
    assetId: "file-passthrough",
    conversationId: "conv-transport",
    providerGenerationCallId: "ig-web-explicit",
    generationRequestPrompt: "request prompt kept beside the caption",
    generationStatus: "completed",
    isGeneration: true,
  });
  assert.ok(meta);
  assert.equal(meta.conversationId, "conv-transport", "the transport conversation id survives rememberMeta");
  assert.equal(meta.providerGenerationCallId, "ig-web-explicit");

  const candidate = { key: fileUrl("file-passthrough"), imageUrl: fileUrl("file-passthrough"), el: null, width: 0, height: 0 };
  await context.ingestCandidate(candidate, { silentSkip: true, reason: "network" });
  const ingest = harness.sentMessages.find((entry) => entry.message?.type === "mosa.ingest");
  assert.ok(ingest, "the capture reached the background");
  assert.equal(ingest.message.payload.conversationId, "conv-transport");
  assert.equal(ingest.message.payload.providerGenerationCallId, "ig-web-explicit");
  assert.equal(ingest.message.payload.generationRequestPrompt, "request prompt kept beside the caption");
  assert.equal(ingest.message.payload.generationSessionTitle, "", "a page without a title carries no session title");
});

test("saved outputs are force re-ingested once so late references reach the server, and reference failures stay quiet", async () => {
  const harness = await createContentHarness({ settings: { autoCapture: true }, pathname: "/c/conv-refs" });
  const { context } = harness;
  const imageUrl = fileUrl("file-refpair");
  const reference = new context.HTMLImageElement({ src: "blob:https://chatgpt.com/ref-upload", complete: true, naturalWidth: 2048, naturalHeight: 1143 });
  const output = new context.HTMLImageElement({ src: imageUrl, complete: true, naturalWidth: 1024, naturalHeight: 1024 });
  harness.document.querySelectorAll("img").push(output, reference);

  const meta = context.rememberMeta({
    prompt: "Model caption: 一张参考图驱动的海报练习，构图完整，光影柔和。",
    promptStatus: "visible-caption",
    imageUrl,
    assetId: "file-refpair",
    conversationId: "conv-refs",
    generationStatus: "completed",
    isGeneration: true,
  });
  assert.ok(meta);
  const candidate = context.domCandidateForImage(imageUrl);
  assert.ok(candidate);

  // First archive: one ingest for the output; the saved identity now blocks
  // plain re-captures.
  await context.enqueueDomCandidateForImage(imageUrl, "dom-hook");
  await flushAutoCapture(harness);
  assert.equal(ingests(harness).length, 1);

  // A generation context later stages its references: the saved output must
  // be re-sent exactly once with the context so the server can append usage.
  context.stageGenerationReferences = async () => ({ generationContextId: "chatgpt:conv-refs:asset:file-refpair", stagedReferences: 1 });
  await context.enqueueDomCandidateForImage(imageUrl, "blob-asset");
  await flushAutoCapture(harness);
  const repair = ingests(harness)[1];
  assert.ok(repair, "the reference repair re-sends the saved output");
  assert.equal(repair.message.payload.generationContextId, "chatgpt:conv-refs:asset:file-refpair");

  // A third trigger with the same context stays quiet (the repair is once).
  await context.enqueueDomCandidateForImage(imageUrl, "blob-asset");
  await flushAutoCapture(harness);
  assert.equal(ingests(harness).length, 2, "one repair per generation context and output");

  // A reference ingest failure never surfaces as an error toast.
  const failures = [];
  context.runtimeSend = async (message) => {
    if (message.type === "mosa.ingest") throw Object.assign(new Error("MOSA is closed"), { deliveryState: "lost" });
    return { ok: true, result: { mimeType: "image/png", imageBase64: BIG_IMAGE_BASE64 } };
  };
  context.showToast = (message, isError) => failures.push({ message, isError });
  context.setStatus = () => {};
  const referenceCandidate = { key: reference.src, imageUrl: reference.src, el: reference, width: 2048, height: 1143 };
  await assert.rejects(context.ingestCandidate(referenceCandidate, { silentSkip: true, reason: "auto-reference" }));
  assert.equal(failures.filter((entry) => entry.isError).length, 0, "an optional reference failure is silent");
});

test("reference images mark the payload and the size floors keep their tiers", async () => {
  const harness = await createContentHarness({ settings: null });
  const { context } = harness;
  context.runtimeSend = async (message) => {
    harness.sentMessages.push({ message });
    if (message.type === "mosa.fetchImage") return { ok: true, result: { mimeType: "image/png", imageBase64: BIG_IMAGE_BASE64 } };
    return { ok: true, result: { status: "imported" } };
  };
  context.showToast = () => {};
  context.setStatus = () => {};

  // A user-turn image is a reference: the ingest payload marks it.
  const userScope = { querySelector: () => null };
  class ReferenceImage extends FakeImage {
    closest(selector) {
      return String(selector).includes('data-message-author-role="user"') ? userScope : null;
    }
  }
  const referenceEl = new ReferenceImage({ src: "blob:https://chatgpt.com/ref", complete: true, naturalWidth: 2048, naturalHeight: 1143 });
  assert.equal(context.isReferenceCandidate({ el: referenceEl }), true);
  await context.ingestCandidate({ key: referenceEl.src, imageUrl: referenceEl.src, el: referenceEl, width: 2048, height: 1143 }, { silentSkip: true, reason: "auto-reference" });
  const payload = harness.sentMessages.find((entry) => entry.message?.type === "mosa.ingest")?.message.payload;
  assert.ok(payload);
  assert.equal(payload.isReference, true, "a reference ingest marks the payload");

  // Size floors: references accept tiny inputs, auto requires the 480 edge
  // unless proven (256) or manual (360).
  assert.equal(context.isArchiveWorthyCandidate({ width: 40, height: 40, imageUrl: "blob:https://chatgpt.com/x" }, { reference: true }), true);
  assert.equal(context.isArchiveWorthyCandidate({ width: 40, height: 40, imageUrl: "blob:https://chatgpt.com/x" }, { manual: false }), false);
  assert.equal(context.isArchiveWorthyCandidate({ width: 300, height: 300, imageUrl: fileUrl("file-floor1") }, { manual: false }), false, "below the auto edge");
  assert.equal(context.isArchiveWorthyCandidate({ width: 400, height: 400, imageUrl: fileUrl("file-floor1") }, { manual: true }), true, "manual accepts it above the 360 floor");
  const proven = { width: 300, height: 300, imageUrl: fileUrl("file-floor1") };
  context.generationRegistryForPage().remember({
    assetId: "file-floor1", promptStatus: "visible-caption", prompt: "x".repeat(90), isGeneration: true, generationStatus: "completed",
  });
  assert.equal(context.isArchiveWorthyCandidate(proven, { manual: false }), true, "a proven generation gets the lower floor");

  // A small byte payload below 20 KB with generation evidence is recorded as
  // a size failure (retryable), never permanently saved...
  context.bytesFromUrlOrImg = async () => ({ mimeType: "image/png", imageBase64: Buffer.alloc(1_000, 3).toString("base64") });
  context.generationRegistryForPage().remember({
    assetId: "file-small1", promptStatus: "visible-caption", prompt: "x".repeat(90), isGeneration: true, generationStatus: "completed",
  });
  const small = { key: fileUrl("file-small1"), imageUrl: fileUrl("file-small1"), el: null, width: 1024, height: 1024 };
  const result = await context.ingestCandidate(small, { silentSkip: true, reason: "network" });
  assert.equal(result, null);
  assert.ok([...harness.state.sizeFailureStates.keys()].some((key) => key.includes("file-small1")), "recorded as a size failure");
  assert.equal([...harness.state.savedKeys].some((key) => key.includes("file-small1")), false, "not permanently saved");
  assert.equal([...harness.state.savedIdentityKeys].some((key) => key.includes("file-small1")), false);

  // ...while a small candidate WITHOUT evidence is skipped for good.
  const junk = { key: fileUrl("file-junksmall"), imageUrl: fileUrl("file-junksmall"), el: null, width: 1024, height: 1024 };
  await context.ingestCandidate(junk, { silentSkip: true, reason: "network" });
  assert.equal([...harness.state.savedKeys].some((key) => key.includes("file-junksmall")), true, "junk without evidence is saved-skipped");
});

test("manual capture archives the viewport image and carries the session title", async () => {
  const harness = await createContentHarness({ settings: null, pathname: "/c/conv-manual", title: "Manual Chat" });
  const { context } = harness;
  context.runtimeSend = async (message) => {
    harness.sentMessages.push({ message });
    if (message.type === "mosa.fetchImage") return { ok: true, result: { mimeType: "image/png", imageBase64: BIG_IMAGE_BASE64 } };
    return { ok: true, result: { status: "imported" } };
  };
  const image = new context.HTMLImageElement({ src: fileUrl("file-manual"), complete: true, naturalWidth: 1024, naturalHeight: 1024 });
  harness.document.querySelectorAll("img").push(image);

  const result = await context.runManualAction("save-visible");
  assert.equal(result.completed, 1);
  const payload = harness.sentMessages.find((entry) => entry.message?.type === "mosa.ingest")?.message.payload;
  assert.ok(payload, "the manual capture reached the background");
  assert.equal(payload.imageUrl, fileUrl("file-manual"));
  assert.equal(payload.captureMode, "manual");
  assert.equal(payload.generationSessionTitle, "Manual Chat", "the open conversation's title rides with the capture");
  assert.equal(payload.isReference, false);
});

test("only a same-message Model caption is used when conversation metadata is cached", async () => {
  const harness = await createContentHarness({ settings: null, pathname: "/c/conv-caption" });
  const caption = "Model caption: A detailed retro travel poster with cream paper, bold red typography and a screen-print editorial layout.";
  const image = new harness.context.HTMLImageElement({ src: "blob:https://chatgpt.com/preview-caption", alt: caption });
  const resolved = harness.context.resolvePrompt("blob:https://chatgpt.com/preview-caption", { el: image, key: image.src, imageUrl: image.src });
  assert.equal(resolved.prompt, caption);
  assert.equal(resolved.promptStatus, "visible-caption");
  assert.equal(resolved.promptSource, "dom-message-caption");
  assert.equal(resolved.promptPriority, 425);
});

test("a better generation prompt upgrades an already archived output exactly once", async () => {
  const harness = await createContentHarness({ settings: { autoCapture: true }, pathname: "/c/conv-upgrade" });
  const { context } = harness;
  context.runtimeSend = async (message) => {
    harness.sentMessages.push({ message });
    return { ok: true, result: { status: "imported" } };
  };
  context.bytesFromUrlOrImg = async () => ({ mimeType: "image/png", imageBase64: BIG_IMAGE_BASE64 });
  context.showToast = () => {};
  context.setStatus = () => {};
  const imageUrl = fileUrl("file-upgrade1");
  const meta = context.rememberMeta({
    imageUrl, assetId: "file-upgrade1", conversationId: "conv-upgrade",
    generationStatus: "completed", isGeneration: true, promptStatus: "not-available", prompt: "",
  });
  assert.ok(meta);
  const candidate = { key: imageUrl, imageUrl, el: null, width: 0, height: 0 };
  await context.ingestCandidate(candidate, { silentSkip: true, reason: "network" });
  assert.equal(ingests(harness).length, 1);

  // The live push later binds a trusted generation prompt to the same file:
  // the saved, promptless capture is re-sent with force so MOSA upgrades it.
  const better = context.rememberMeta({
    imageUrl, assetId: "file-upgrade1", conversationId: "conv-upgrade",
    prompt: "A detailed editorial poster with metallic blue type", promptStatus: "generation-tool-prompt",
    generationStatus: "completed", isGeneration: true,
  });
  context.schedulePromptUpgrade(better);
  await flushAutoCapture(harness);
  const upgrades = ingests(harness).length;
  assert.equal(upgrades, 2, "the saved output is re-sent once");
  assert.equal(ingests(harness)[1].message.payload.prompt, "A detailed editorial poster with metallic blue type");

  context.schedulePromptUpgrade(better);
  await flushAutoCapture(harness);
  assert.equal(ingests(harness).length, 2, "no further upgrade at the same rank");
});

test("automatic capture does not starve new images behind already-saved candidates", async () => {
  const harness = await createContentHarness({ settings: { autoCapture: true }, pathname: "/c/conv-budget" });
  const { context } = harness;
  context.showToast = () => {};
  context.setStatus = () => {};
  const registry = context.generationRegistryForPage();
  const images = harness.document.querySelectorAll("img");
  const candidates = [];
  for (let index = 0; index < 6; index += 1) {
    const fileId = `file-saved${index}`;
    const image = new context.HTMLImageElement({
      src: fileUrl(fileId), complete: true, naturalWidth: 2000, naturalHeight: 2000, width: 900, height: 900,
    });
    images.push(image);
    registry.remember({
      assetId: fileId, promptStatus: "visible-caption", prompt: `saved caption ${index}`, isGeneration: true, generationStatus: "completed",
    });
    candidates.push(context.domCandidateForImage(fileUrl(fileId)));
  }
  for (const candidate of candidates) await context.enqueueAuto(candidate, "dom-scan");
  await flushAutoCapture(harness);
  assert.equal(ingests(harness).length, 6, "the six large saved images archive first");

  // A seventh, smaller new image would lose a naive top-6 cut taken BEFORE
  // the saved filter; the per-scan budget must be applied after it.
  const newFileId = "file-newcomer";
  const newImage = new context.HTMLImageElement({
    src: fileUrl(newFileId), complete: true, naturalWidth: 1000, naturalHeight: 1000, width: 500, height: 500,
  });
  images.push(newImage);
  registry.remember({
    assetId: newFileId, promptStatus: "visible-caption", prompt: "newcomer caption", isGeneration: true, generationStatus: "completed",
  });
  harness.fireTimeouts();
  await flushAutoCapture(harness);
  assert.equal(ingests(harness).length, 7, "the new image is archived in the same scan");
  assert.equal(ingests(harness)[6].message.payload.imageUrl, fileUrl(newFileId));
});

test("generation evidence recovery spans slow multi-image renders and falls back to the DOM", async () => {
  const harness = await createContentHarness({ settings: { autoCapture: true }, pathname: "/c/conv-recovery" });
  const { context } = harness;
  context.showToast = () => {};
  context.setStatus = () => {};
  const imageUrl = fileUrl("file-slowrender");
  const image = new context.HTMLImageElement({ src: imageUrl, complete: true, naturalWidth: 1024, naturalHeight: 1024, alt: "Generated image 1" });
  harness.document.querySelectorAll("img").push(image);

  // No evidence yet: the recoverable candidate gets a 2.8s/7.2s/15s ladder.
  const candidate = context.domCandidateForImage(imageUrl);
  assert.ok(candidate, "the marked image is a recoverable generation candidate");
  await context.enqueueAuto(candidate, "dom-scan");
  await flushAutoCapture(harness);
  assert.equal(ingests(harness).length, 0);

  harness.advanceClock(2_800);
  harness.fireTimeouts({ ms: 2_800 });
  await flushAutoCapture(harness);
  assert.equal(ingests(harness).length, 0, "the first recovery step finds nothing yet");

  // Evidence arrives from the live push before the ladder runs out.
  context.rememberMeta({
    imageUrl, assetId: "file-slowrender", conversationId: "conv-recovery",
    prompt: "Model caption: 一张慢渲染的多图海报练习。", promptStatus: "visible-caption",
    generationStatus: "completed", isGeneration: true,
  });
  harness.advanceClock(7_200);
  harness.fireTimeouts({ ms: 7_200 });
  await flushAutoCapture(harness);
  assert.equal(ingests(harness).length, 1, "recovered evidence archives the image");
  harness.advanceClock(15_000);
  harness.fireTimeouts({ ms: 15_000 });
  await flushAutoCapture(harness);
  assert.equal(ingests(harness).length, 1, "the remaining ladder steps are cancelled");

  // Without any evidence the last step falls back to a DOM-side archive.
  const fallback = await createContentHarness({ settings: { autoCapture: true }, pathname: "/c/conv-recovery" });
  const fallbackImage = new fallback.context.HTMLImageElement({
    src: fileUrl("file-neverbound"), complete: true, naturalWidth: 1024, naturalHeight: 1024, alt: "Generated image 1",
  });
  fallback.document.querySelectorAll("img").push(fallbackImage);
  fallback.context.showToast = () => {};
  fallback.context.setStatus = () => {};
  await fallback.context.enqueueAuto(fallback.context.domCandidateForImage(fileUrl("file-neverbound")), "dom-scan");
  await flushAutoCapture(fallback);
  assert.equal(ingests(fallback).length, 0);
  fallback.advanceClock(15_000);
  fallback.fireTimeouts({ ms: 15_000 });
  await flushAutoCapture(fallback);
  assert.equal(ingests(fallback).length, 1, "the exhausted ladder archives via the DOM fallback");
  assert.equal(ingests(fallback)[0].message.payload.imageUrl, fileUrl("file-neverbound"));
});

test("network failures keep the identity retryable for a rendered DOM image", async () => {
  const harness = await createContentHarness({ settings: { autoCapture: true } });
  harness.offerHookPort();
  harness.context.runtimeSend = async (message) => {
    if (message.type === "mosa.fetchImage") throw new Error("download failed");
    harness.sentMessages.push({ message });
    return { ok: true, result: { status: "imported" } };
  };
  const imageUrl = fileUrl("file-netfail");
  harness.deliverHookEvent("auto-image", { imageUrl, isGeneration: true, generationStatus: "completed" });
  // The page-side byte read has no DOM image to race against, so it polls for
  // a rendered candidate until the grace window passes; drive those timers.
  await pump(harness, 900);
  assert.equal(ingests(harness).length, 0, "the failed page read sent nothing");
  assert.ok([...harness.state.failedNetworkIdentityKeys].some((key) => key.includes("file-netfail")),
    "the network identity is marked as failed");

  // The same image rendered in the DOM retries immediately through the
  // canvas instead of waiting for the generic cooldown.
  const image = new harness.context.HTMLImageElement({ src: imageUrl, complete: true, naturalWidth: 1024, naturalHeight: 1024 });
  harness.document.querySelectorAll("img").push(image);
  harness.context.runtimeSend = async (message) => {
    harness.sentMessages.push({ message });
    if (message.type === "mosa.fetchImage") return { ok: true, result: { mimeType: "image/png", imageBase64: BIG_IMAGE_BASE64 } };
    return { ok: true, result: { status: "imported" } };
  };
  assert.equal(await harness.context.enqueueDomCandidateForImage(imageUrl, "dom-hook"), true);
  await flushAutoCapture(harness);
  assert.equal(ingests(harness).length, 1, "the rendered image retries right away");
});

test("a failed capture cools down for a moment instead of hammering", async () => {
  const harness = await createContentHarness({ settings: { autoCapture: true } });
  const { context } = harness;
  context.showToast = () => {};
  context.setStatus = () => {};
  // A page-side byte read failure (not a refused/lost delivery) cools down.
  context.runtimeSend = async (message) => {
    if (message.type === "mosa.fetchImage") throw new Error("download failed");
    harness.sentMessages.push({ message });
    return { ok: true, result: { status: "imported" } };
  };
  const imageUrl = fileUrl("file-cooldown");
  const candidate = { key: imageUrl, imageUrl, el: null, width: 0, height: 0 };
  context.rememberMeta({ imageUrl, assetId: "file-cooldown", conversationId: "conversation-test", generationStatus: "completed", isGeneration: true });
  // The failed page read polls for a rendered candidate first; drive the
  // captured polling timers until the grace window passes.
  const failing = context.ingestCandidate(candidate, { silentSkip: true, reason: "network" });
  failing.catch(() => {});
  await pump(harness, 900);
  await assert.rejects(failing);
  assert.ok(harness.state.failedAt.get("asset:file-cooldown"), "the failure is recorded");
  assert.equal(context.canAttempt(candidate), false, "an immediate retry is blocked");
  harness.advanceClock(9_000);
  assert.equal(context.canAttempt(candidate), true, "after the cooldown the retry is allowed");
});

test("manual capture also finds CSS-background images inside large blocks", async () => {
  const harness = await createContentHarness({ settings: null, backgroundImage: 'url("https://files.oaiusercontent.com/file-cssbg?se=1&sig=x")' });
  const { context } = harness;
  context.runtimeSend = async (message) => {
    harness.sentMessages.push({ message });
    return { ok: true, result: { status: "imported" } };
  };
  const block = context.document.createElement("div");
  block.getBoundingClientRect = () => ({ width: 420, height: 420, top: 0, left: 0, bottom: 420, right: 420 });
  harness.document.querySelectorAll("div, section, main, figure").push(block);

  const candidates = context.collectDomCandidates({ manual: true });
  assert.equal(candidates.length, 1, "the CSS background is collected for a manual save");
  assert.equal(candidates[0].imageUrl, "https://files.oaiusercontent.com/file-cssbg?se=1&sig=x");
  assert.equal(context.collectDomCandidates({ manual: false }).length, 0, "the automatic scan ignores CSS backgrounds");
});

test("the capture toast speaks plainly and the status bar counts saves", async () => {
  const harness = await createContentHarness({ settings: { autoCapture: true }, pathname: "/c/conv-toast" });
  const { context } = harness;
  context.runtimeSend = async (message) => {
    harness.sentMessages.push({ message });
    return { ok: true, result: { status: "imported" } };
  };
  context.bytesFromUrlOrImg = async () => ({ mimeType: "image/png", imageBase64: BIG_IMAGE_BASE64 });
  const imageUrl = fileUrl("file-toast");
  context.rememberMeta({
    imageUrl, assetId: "file-toast", conversationId: "conv-toast",
    prompt: "A detailed editorial poster", promptStatus: "generation-tool-prompt",
    generationStatus: "completed", isGeneration: true,
  });
  await context.ingestCandidate({ key: imageUrl, imageUrl, el: null, width: 0, height: 0 }, { silentSkip: true, reason: "network" });
  const toast = harness.document.getElementById("mosa-capture-toast");
  assert.ok(toast);
  assert.equal(toast.textContent, "已保存到 GravityPort");
  assert.equal(toast.textContent.includes("generation-tool-prompt"), false, "the internal status code never reaches the screen");

  const promptless = await createContentHarness({ settings: { autoCapture: true } });
  promptless.context.runtimeSend = async (message) => {
    promptless.sentMessages.push({ message });
    return { ok: true, result: { status: "imported" } };
  };
  promptless.context.bytesFromUrlOrImg = async () => ({ mimeType: "image/png", imageBase64: BIG_IMAGE_BASE64 });
  promptless.context.showToast = () => {};
  const noPromptUrl = fileUrl("file-noprompt");
  promptless.context.rememberMeta({
    imageUrl: noPromptUrl, assetId: "file-noprompt", conversationId: "conversation-test",
    generationStatus: "completed", isGeneration: true, prompt: "", promptStatus: "not-available",
  });
  await promptless.context.ingestCandidate({ key: noPromptUrl, imageUrl: noPromptUrl, el: null, width: 0, height: 0 }, { silentSkip: true, reason: "network" });
  const state = (await promptless.dispatchRuntimeMessage({ type: "mosa.capture.getPageState" })).state;
  assert.equal(state.status, "已保存 · 共1", "the status bar counts the saves without internal labels");
});

test("user messages drop the image tool chip line but keep the same words typed in the text", async () => {
  const harness = await createContentHarness({ settings: null });
  const strip = harness.context.stripSystemHintLabelLines;
  assert.equal(strip("一只放在白色桌面上的蓝色玻璃苹果\n创建图像"), "一只放在白色桌面上的蓝色玻璃苹果");
  assert.equal(strip("创建图像\n\n一座巨大的赛博朋克佛像\n第二段"), "一座巨大的赛博朋克佛像\n第二段");
  assert.equal(strip("Create image\r\nA glass apple"), "A glass apple");
  assert.equal(strip("@创建图像 基于参考图: 一只苹果"), "@创建图像 基于参考图: 一只苹果");
  assert.equal(strip("第一行\n创建图像\n最后一行"), "第一行\n创建图像\n最后一行");
  assert.equal(strip("创建图像"), "");
});

test("conversation titles strip the site suffix, trim, keep the 200-char cap, and fall back to the sidebar", async () => {
  const harness = await createContentHarness({ title: "Bangkok Travel Poster - ChatGPT", sidebarTitle: "Sidebar Named Chat", pathname: "/c/conv-title" });
  const { context } = harness;
  assert.equal(context.normalizeConversationTitle("Bangkok Travel Poster - ChatGPT"), "Bangkok Travel Poster");
  assert.equal(context.normalizeConversationTitle("Skyline Edit | ChatGPT"), "Skyline Edit");
  assert.equal(context.normalizeConversationTitle("  Padded Title  "), "Padded Title");
  assert.equal(context.normalizeConversationTitle("x".repeat(250)).length, 200);
  assert.equal(context.currentConversationTitle(), "Bangkok Travel Poster", "document.title is the first source");

  for (const placeholder of ["ChatGPT", "new chat", "新聊天", "新对话", "   ", ""]) {
    assert.equal(context.normalizeConversationTitle(placeholder), "", JSON.stringify(placeholder));
  }
  const sidebar = await createContentHarness({ title: "New chat", sidebarTitle: "Sidebar Named Chat" });
  assert.equal(sidebar.context.currentConversationTitle(), "Sidebar Named Chat", "a placeholder title falls through to the sidebar entry");

  const scoped = await createContentHarness({ title: "Matched Chat", pathname: "/c/conv-1" });
  assert.equal(scoped.context.sessionTitleForConversation("conv-1"), "Matched Chat");
  assert.equal(scoped.context.sessionTitleForConversation("conv-other"), "", "a different conversation id carries no title");
  assert.equal(scoped.context.sessionTitleForConversation(""), "", "no conversation id, no title");
});
