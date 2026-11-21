// chatgpt-web-capture-dot.test.mjs — task 451: ChatGPT Dot pages
// (/dots/<dotId>) fetch their transcript from the messaging API
// (GET /backend-api/messaging/rooms/<roomId>/messages), which the hook used to
// ignore, so Dot's image attachments were never captured. The suite replays
// the real 2026-11-20 page sample (test/fixtures/chatgpt-dot-messages.json)
// through the real page-hook.js and drives the real content.js and the real
// background worker — no function is copied into the tests.
//
// Field mapping (mirrors the post-353 ChatGPT capture): the Dot's own message
// text binds as the visible caption (the slot ChatGPT's model caption uses),
// the human's latest preceding message travels as generationRequestPrompt —
// the request-prompt slot that the server stores as the asset prompt (提示词1).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

import { createBackgroundHarness, senderFor } from "./helpers/background-harness.mjs";
import { createContentHarness } from "./helpers/content-harness.mjs";
import { createHookHarness } from "./helpers/page-hook-harness.mjs";

const SAMPLE = JSON.parse(await readFile(new URL("./fixtures/chatgpt-dot-messages.json", import.meta.url), "utf8"));
const DOT_ID = "cdaf1234ab4ae~6b003f75f753";
const DOT_PAGE_PATHNAME = `/dots/${DOT_ID}`;
const MESSAGES_URL = "https://chatgpt.com/backend-api/messaging/rooms/room-dot-test/messages?limit=32";
const ATTACHMENTS = SAMPLE.items[2].content.attachments;
const USER_PROMPT = "你来生成几张性感的美女图";
const DOT_CAPTION = "三张独立的 3:4 竖图：红裙夜景、黑色西装、日落丝缎。我最喜欢红裙那张，雨后的霓虹很有电影感。";

/** Records the dedicated Dot parser emitted (via: "dot-message"). */
function dotRecords(harness, type) {
  return harness.events
    .filter((event) => event.type === type && event.payload?.via === "dot-message")
    .map((event) => event.payload);
}

async function fetchSampleOnPage(pathname) {
  const harness = createHookHarness({}, "", { pathname });
  harness.registerFetchResponse(MESSAGES_URL, JSON.stringify(SAMPLE), { contentType: "application/json" });
  await harness.window.fetch(MESSAGES_URL);
  await setImmediate();
  return harness;
}

test("A — a Dot messages response emits one auto-capturable record per image attachment", async () => {
  const harness = await fetchSampleOnPage(DOT_PAGE_PATHNAME);

  const records = dotRecords(harness, "auto-image");
  assert.equal(records.length, 3, "every image attachment of the Dot message is one record");
  const byTitle = new Map(records.map((record) => [record.imageGenTitle, record]));
  assert.deepEqual(
    [...byTitle.keys()].sort(),
    ["日落丝缎.png", "黑色西装.png", "红裙夜景.png"].sort(),
    "the attachment file names travel as image titles",
  );

  const first = byTitle.get("红裙夜景.png");
  assert.equal(first.imageUrl, ATTACHMENTS[0].file.download_url);
  assert.equal(first.assetId, "file_00000000aaaa1111bbbb2222cccc3333", "the sediment pointer names the dedupe asset id");
  assert.equal(first.imageKey, "asset:file_00000000aaaa1111bbbb2222cccc3333", "dedupe key asset:file_… survives a page refresh");
  assert.equal(first.generationRequestPrompt, USER_PROMPT, "the human's request is the prompt");
  assert.equal(first.prompt, DOT_CAPTION, "the Dot's own words bind as the caption");
  assert.equal(first.promptStatus, "visible-caption");
  assert.equal(first.promptSource, "dot-message-caption");
  assert.equal(first.conversationId, DOT_ID);
  assert.ok(first.conversationId.includes("~"), "the /dots/ id keeps its ~");
  assert.equal(first.isGeneration, true, "Dot attachments auto-capture like ordinary generations");
});

test("B — replaying the same response does not add new ingests (asset:file dedupe)", async () => {
  const harness = await fetchSampleOnPage(DOT_PAGE_PATHNAME);
  const payloads = dotRecords(harness, "auto-image");
  assert.equal(payloads.length, 3);

  const page = await createContentHarness({ pathname: DOT_PAGE_PATHNAME, settings: { autoCapture: true } });
  page.offerHookPort();
  const ingestCount = () => page.sentMessages.filter((entry) => entry.message.type === "mosa.ingest").length;

  for (const payload of payloads) page.deliverHookEvent("auto-image", payload);
  // The unknown generation status waits out the 900 ms stability window first.
  page.advanceClock(1_000);
  page.fireTimeouts();
  await page.flush();
  assert.equal(ingestCount(), 3, "the first pass ingests all three attachments");

  for (const payload of payloads) page.deliverHookEvent("auto-image", payload);
  page.advanceClock(1_000);
  page.fireTimeouts();
  await page.flush();
  assert.equal(ingestCount(), 3, "the same asset ids must not ingest twice");
});

test("C — the same response fetched on a /c/ conversation page emits nothing", async () => {
  const harness = await fetchSampleOnPage("/c/conv-xyz");
  assert.equal(dotRecords(harness, "auto-image").length, 0);
  assert.equal(dotRecords(harness, "generation-meta").length, 0);
});

test("D — a human-uploaded attachment and a non-image mime stay out", async () => {
  const humanCopy = JSON.parse(JSON.stringify(SAMPLE));
  humanCopy.items[2].account_user_id = SAMPLE.items[0].account_user_id;
  const humanHarness = createHookHarness({}, "", { pathname: DOT_PAGE_PATHNAME });
  humanHarness.registerFetchResponse(MESSAGES_URL, JSON.stringify(humanCopy), { contentType: "application/json" });
  await humanHarness.window.fetch(MESSAGES_URL);
  await setImmediate();
  assert.equal(dotRecords(humanHarness, "auto-image").length, 0, "user-… attachments are uploads, not Dot output");

  const pdfCopy = JSON.parse(JSON.stringify(SAMPLE));
  for (const attachment of pdfCopy.items[2].content.attachments) attachment.file.mime_type = "application/pdf";
  const pdfHarness = createHookHarness({}, "", { pathname: DOT_PAGE_PATHNAME });
  pdfHarness.registerFetchResponse(MESSAGES_URL, JSON.stringify(pdfCopy), { contentType: "application/json" });
  await pdfHarness.window.fetch(MESSAGES_URL);
  await setImmediate();
  assert.equal(dotRecords(pdfHarness, "auto-image").length, 0, "only image/ attachments emit records");
});

test("E — without a preceding human message the prompt stays empty, the caption still binds", async () => {
  const copy = JSON.parse(JSON.stringify(SAMPLE));
  copy.items.splice(0, 1); // drop the human's request; the Dot's plan message must not replace it
  const harness = createHookHarness({}, "", { pathname: DOT_PAGE_PATHNAME });
  harness.registerFetchResponse(MESSAGES_URL, JSON.stringify(copy), { contentType: "application/json" });
  await harness.window.fetch(MESSAGES_URL);
  await setImmediate();

  const records = dotRecords(harness, "auto-image");
  assert.equal(records.length, 3);
  for (const record of records) {
    assert.equal(record.generationRequestPrompt, "", "Dot's own words never stand in for the prompt");
    assert.equal(record.prompt, DOT_CAPTION, "the caption is still recorded");
  }
});

test("F — content.js reads the dot id (with ~) from /dots/ URLs and leaves /c/ alone", async () => {
  const dotPage = await createContentHarness({ pathname: "/dots/abc~def" });
  assert.equal(dotPage.context.conversationIdFromUrl(), "abc~def");
  assert.equal(dotPage.state.activeConversationId, "abc~def", "boot adopts the dot id as the conversation");

  const chatPage = await createContentHarness({ pathname: "/c/xyz" });
  assert.equal(chatPage.context.conversationIdFromUrl(), "xyz");
});

test("G — the Dot estuary URL downloads through mosa.fetchImage with page cookies; 401/403 fail", async () => {
  const harness = await createBackgroundHarness({ appOnline: true });
  const requests = [];
  harness.fetchHarness.setMediaHandler((url, init) => {
    requests.push({ url: String(url), credentials: init.credentials });
    return new Response(new Uint8Array(512).fill(7), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  });
  const sender = senderFor(`https://chatgpt.com${DOT_PAGE_PATHNAME}`);

  const ok = await harness.dispatchMessage({ type: "mosa.fetchImage", url: ATTACHMENTS[0].file.download_url }, sender);
  assert.equal(ok.ok, true);
  assert.ok(ok.result.imageBase64.length > 0, "the public_content/enc URL downloads through the shared image path");
  assert.equal(ok.result.mimeType, "image/png");
  assert.equal(requests[0].credentials, "include", "the first attempt carries the page cookies like estuary/content");

  harness.fetchHarness.setMediaHandler(() => new Response("denied", { status: 401 }));
  const denied = await harness.dispatchMessage({ type: "mosa.fetchImage", url: ATTACHMENTS[0].file.download_url }, sender);
  assert.equal(denied.ok, false);
  assert.match(denied.error, /401/);

  harness.fetchHarness.setMediaHandler(() => new Response("forbidden", { status: 403 }));
  const forbidden = await harness.dispatchMessage({ type: "mosa.fetchImage", url: ATTACHMENTS[0].file.download_url }, sender);
  assert.equal(forbidden.ok, false);
  assert.match(forbidden.error, /403/);
});

test("H — a failed download keeps the image out of the library and names the reason in the status panel", async () => {
  const harness = await fetchSampleOnPage(DOT_PAGE_PATHNAME);
  const payloads = dotRecords(harness, "auto-image");
  assert.equal(payloads.length, 3);

  const page = await createContentHarness({
    pathname: DOT_PAGE_PATHNAME,
    settings: { autoCapture: true },
    respond: (message) => {
      if (message?.type === "mosa.fetchImage") return { ok: false, error: "Failed to download image (401)" };
      return undefined;
    },
  });
  page.offerHookPort();
  for (const payload of payloads) page.deliverHookEvent("auto-image", payload);
  // Walk the stability window and the bounded byte-read waits with the fake clock.
  for (let index = 0; index < 24 && !page.state.lastStatus.includes("下载未完成"); index += 1) {
    page.advanceClock(250);
    page.fireTimeouts();
    await page.flush();
  }
  const ingestCount = page.sentMessages.filter((entry) => entry.message.type === "mosa.ingest").length;
  assert.equal(ingestCount, 0, "no ingest without image bytes");
  assert.match(page.state.lastStatus, /下载未完成/, "the status panel shows the friendly download-failure reason");
});
