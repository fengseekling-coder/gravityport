// chatgpt-web-capture-sse-split.test.mjs — review 2-4 中-15 confirmation
// (task 353 item 4). The live POST /backend-api/f/conversation stream may be
// cut at any byte boundary by the network; createSseStreamHarvester must
// rebuild exactly the same messages no matter where the stream is split.
//
// Fixture: the real 2026-11-03 capture (test/fixtures/chatgpt-image-gen-ws-
// 2026-11-03.json). Two modifications, both derived from the fixture itself
// and annotated here:
//   1. The sample's sseChunks carry only the opening thoughts placeholder, so
//      the image-bearing turn would emit no generation events and the split
//      comparison would be vacuous. Two extra `delta` add-events are appended
//      with the exact envelope shape of the sample's own chunk 2
//      (`{"p":"","o":"add","v":{...},"c":0}`), carrying the verbatim frame-11
//      tool-call message and the verbatim frame-15 image-result message from
//      the same capture's wsFrames.
//   2. The split test concatenates every sseChunk into one stream text and
//      re-feeds it split at EVERY character position into two chunks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { createHookHarness } from "./helpers/page-hook-harness.mjs";

const SAMPLE = JSON.parse(readFileSync(
  new URL("./fixtures/chatgpt-image-gen-ws-2026-11-03.json", import.meta.url),
  "utf8",
));

const SSE_URL = "https://chatgpt.com/backend-api/f/conversation";
const toolCallMessage = SAMPLE.wsFrames.find((entry) => entry.i === 11).frame.payload.update_content.messages[0];
const toolResultMessage = SAMPLE.wsFrames.find((entry) => entry.i === 15).frame.payload.update_content.messages[0];
const CONVERSATION_ID = SAMPLE.wsFrames.find((entry) => entry.i === 15).frame.payload.conversation_id;

const addEvent = (message) => `data: ${JSON.stringify({
  p: "",
  o: "add",
  v: { message, conversation_id: CONVERSATION_ID },
  c: 0,
})}\n\n`;

const STREAM_TEXT = [
  ...SAMPLE.sseChunks.map((chunk) => chunk.text),
  // Modification 1 (see header): image-bearing events derived from wsFrames.
  addEvent(toolCallMessage),
  addEvent(toolResultMessage),
].join("");

function sseHarness() {
  let chunks = [STREAM_TEXT];
  const harness = createHookHarness({}, CONVERSATION_ID, {
    respond: (url) => {
      if (url !== SSE_URL) return null;
      let index = 0;
      const reader = {
        read: async () => (index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined }),
      };
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => String(name || "").toLowerCase() === "content-type" ? "text/event-stream" : "" },
        clone: () => ({ body: { getReader: () => reader } }),
        body: { getReader: () => reader },
        text: async () => chunks.join(""),
      };
    },
  });
  return {
    harness,
    async feed(splitChunks) {
      chunks = splitChunks;
      harness.events.length = 0;
      // The respond override answers SSE_URL itself; harvest() only stages the
      // URL and drives window.fetch.
      await harness.harvest({ method: "POST" }, SSE_URL);
      // The stream reader drains over several microtask turns.
      for (let i = 0; i < 8; i += 1) await setImmediate();
      return generationEventProjection(harness);
    },
  };
}

function generationEventProjection(harness) {
  return harness.events
    .filter((event) => event.type === "generation-meta" && event.payload?.prompt)
    .map((event) => ({
      prompt: event.payload.prompt,
      promptStatus: event.payload.promptStatus,
      promptSource: event.payload.promptSource,
      generationRequestPrompt: event.payload.generationRequestPrompt,
      imageKey: event.payload.imageKey,
      assetId: event.payload.assetId,
      conversationId: event.payload.conversationId,
      messageId: event.payload.messageId,
      generationStatus: event.payload.generationStatus,
    }));
}

test("the real stream unsplit binds the tool-call prompt and the image result", async () => {
  const { harness, feed } = sseHarness();
  const events = await feed([STREAM_TEXT]);
  assert.equal(events.length, 1, "exactly the frame-15 image result binds a prompt");
  assert.match(events[0].prompt, /^Model caption: A clean, minimalist/);
  assert.equal(events[0].promptStatus, "visible-caption");
  assert.equal(events[0].generationRequestPrompt, JSON.parse(toolCallMessage.content.text).prompt);
  assert.equal(events[0].assetId, toolResultMessage.content.parts[0].asset_pointer.replace(/^sediment:\/\//, ""));
  assert.ok(events[0].imageKey.includes(CONVERSATION_ID));
  void harness;
});

test("splitting the stream at every character position rebuilds the same events", async () => {
  const { feed } = sseHarness();
  const baseline = await feed([STREAM_TEXT]);
  assert.ok(baseline.length >= 1, "the unsplit stream binds events");

  // Modification 2 (see header): every character position of the whole text.
  for (let splitAt = 1; splitAt < STREAM_TEXT.length; splitAt += 1) {
    const rebuilt = await feed([STREAM_TEXT.slice(0, splitAt), STREAM_TEXT.slice(splitAt)]);
    assert.deepEqual(rebuilt, baseline, `splitting at character ${splitAt} must rebuild the same events`);
  }
});

test("splitting into many uneven fragments rebuilds the same events", async () => {
  const { feed } = sseHarness();
  const baseline = await feed([STREAM_TEXT]);
  // One fragment per line, as a hostile proxy might re-chunk the stream.
  const fragments = STREAM_TEXT.split("\n").map((line) => `${line}\n`).filter((line) => line !== "\n");
  assert.ok(fragments.length > 10);
  assert.deepEqual(await feed(fragments), baseline);
});
