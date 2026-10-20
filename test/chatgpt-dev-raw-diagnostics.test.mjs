/**
 * Tests for the DEV-ONLY(128) developer raw diagnostics feature: the hidden
 * options switch, the raw per-conversation frame buffer, the masking rules,
 * per-round record assembly, the local IndexedDB store contract, and the
 * startup cleanup of the removed structure-only diagnostics keys.
 */

import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { createHookHarness } from "./helpers/page-hook-harness.mjs";
import {
  createMemoryStore,
  idsToEvict,
  removeLegacyCaptureDiagnosticsKeys,
  devRawRecordBytes,
} from "../extensions/chatgpt-web-capture/dev-raw-diagnostics-store.js";

const devRawSource = await readFile(new URL("../extensions/chatgpt-web-capture/dev-raw-diagnostics.js", import.meta.url), "utf8");
const optionsHtml = await readFile(new URL("../extensions/chatgpt-web-capture/options.html", import.meta.url), "utf8");
const optionsSource = await readFile(new URL("../extensions/chatgpt-web-capture/options.js", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../extensions/chatgpt-web-capture/manifest.json", import.meta.url), "utf8"));
const backgroundSource = await readFile(new URL("../extensions/chatgpt-web-capture/background.js", import.meta.url), "utf8");
const privacySource = await readFile(new URL("../PRIVACY.md", import.meta.url), "utf8");
const extensionReadme = await readFile(new URL("../extensions/chatgpt-web-capture/README.md", import.meta.url), "utf8");

/** Load the dev diagnostics module into a fresh VM with the real host Blob /
 *  Response / DecompressionStream so container-metadata parsing (including
 *  zTXt inflation) works end to end. */
function createDevRawApi() {
  const sandbox = {
    Date,
    JSON,
    Math,
    Object,
    Set,
    String,
    console,
    URL: globalThis.URL,
    Blob: globalThis.Blob,
    Response: globalThis.Response,
    DecompressionStream: globalThis.DecompressionStream,
    atob: globalThis.atob,
    TextDecoder: globalThis.TextDecoder,
    TextEncoder: globalThis.TextEncoder,
    Uint8Array: globalThis.Uint8Array,
    ArrayBuffer: globalThis.ArrayBuffer,
    setTimeout,
    clearTimeout,
    location: { origin: "https://chatgpt.com" },
  };
  vm.runInNewContext(devRawSource, sandbox, { filename: "dev-raw-diagnostics.js" });
  return sandbox.MosaDevRawDiagnostics;
}

/** Deterministic clock + manual timer queue replacing setTimeout for rounds. */
function fakeTimers(api) {
  const pending = [];
  let now = 1_700_000_000_000;
  api.__clock = () => now;
  api.__timers = {
    set: (fn, ms) => {
      const entry = { fn, at: now + ms };
      pending.push(entry);
      return entry;
    },
    clear: (entry) => {
      const index = pending.indexOf(entry);
      if (index >= 0) pending.splice(index, 1);
    },
  };
  return {
    advance(ms) {
      now += ms;
      const due = [];
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        if (pending[index].at <= now) due.push(...pending.splice(index, 1));
      }
      for (const entry of due) entry.fn();
    },
    now: () => now,
  };
}

function devRawRecords(harness) {
  return harness.events.filter((event) => event.type === "dev-raw-diagnostic").map((event) => event.payload);
}

async function enableDevRaw(harness) {
  await harness.sendToPageHook({
    source: "mosa-chatgpt-capture",
    type: "set-dev-raw-diagnostics-enabled",
    payload: { enabled: true },
  });
  assert.ok(harness.devRaw.isEnabled());
}

// ---- SSE streaming fixture (delta encoding v1, 5.6 shape) ----

function chunkText(text, size = 40) {
  const pieces = [];
  for (let index = 0; index < text.length; index += size) pieces.push(text.slice(index, index + size));
  return pieces;
}

function streamingResponse(pieces, { url = "https://chatgpt.com/backend-api/f/conversation", contentType = "text/event-stream" } = {}) {
  let cursor = 0;
  const reader = {
    read: async () => {
      if (cursor >= pieces.length) return { done: true, value: undefined };
      const value = pieces[cursor];
      cursor += 1;
      return { done: false, value };
    },
  };
  const headers = new Map([["content-type", contentType]]);
  const response = {
    ok: true,
    status: 200,
    url,
    headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
    body: { getReader: () => reader },
    clone: () => response,
  };
  return response;
}

function deltaEvent(data) {
  return `event: delta\ndata: ${JSON.stringify(data)}`;
}

function sseEventsText(events) {
  return `${events.join("\n\n")}\n\n`;
}

/** A 5.6-style image turn whose tool-call arguments carry `"prompt": null`
 *  and whose metadata prompt patch is null — the case the raw record must
 *  answer. */
function deltaV1StreamEventsWithNullPrompt() {
  const codeArgsText = JSON.stringify({ prompt: null, aspect_ratio: "2:3" });
  const toolMessage = {
    id: "message-tool-image",
    author: { role: "tool", name: "image_gen.text2im", metadata: {} },
    recipient: "all",
    channel: "commentary",
    content: {
      content_type: "multimodal_text",
      parts: [{
        content_type: "image_asset_pointer",
        asset_pointer: "sediment://file-poster",
        size: { width: 1024, height: 1536 },
        metadata: { dalle: { gen_id: "generation-poster", prompt: "" } },
      }],
    },
    status: "finished_successfully",
    metadata: {
      turn_exchange_id: "turn-poster",
      parent_id: "message-code",
      model_slug: "gpt-5-6-thinking",
      image_gen_title: "Generated image",
    },
  };
  return [
    "event: delta_encoding\ndata: \"v1\"",
    deltaEvent({
      type: "input_message",
      message: {
        id: "message-user",
        author: { role: "user", metadata: {} },
        content: { content_type: "text", parts: ["画一张雾中山谷的旅行海报"] },
        status: "finished_successfully",
        metadata: {},
      },
    }),
    deltaEvent({
      p: "",
      o: "add",
      v: {
        message: {
          id: "message-code",
          author: { role: "assistant", name: null, metadata: {} },
          recipient: "image_gen.text2im",
          channel: "commentary",
          content: { content_type: "code", language: "json", text: codeArgsText },
          status: "finished_successfully",
          metadata: { turn_exchange_id: "turn-poster" },
        },
        conversation_id: "conversation-test",
      },
    }),
    deltaEvent({ v: [{ p: "/message/metadata/prompt", o: "replace", v: null }], o: "patch" }),
    deltaEvent({ o: "add", v: { message: toolMessage, conversation_id: "conversation-test" } }),
    "data: [DONE]",
  ];
}

function streamedHarness(events) {
  const streamPieces = chunkText(sseEventsText(events));
  return createHookHarness({ conversation_id: "conversation-test", mapping: {} }, "conversation-test", {
    respond: () => streamingResponse(streamPieces),
  });
}

// ---- image container fixtures ----

function pngChunk(type, data) {
  const bytes = new Uint8Array(12 + data.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index += 1) bytes[4 + index] = type.charCodeAt(index);
  bytes.set(data, 8);
  return bytes;
}

function textBytes(value) {
  return new TextEncoder().encode(value);
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function pngWithItextAndCabx() {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = pngChunk("IHDR", new Uint8Array(13));
  const itextPayload = [
    ...textBytes("Description"), 0,
    0, 0, // compression flag/method: uncompressed
    ...textBytes("zh-CN"), 0,
    ...textBytes("Description"), 0,
    ...textBytes("一张雾中山谷的旅行海报, flat vector poster"),
  ];
  const itext = pngChunk("iTXt", new Uint8Array(itextPayload));
  const cabxPayload = [
    ...new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]),
    ...textBytes("c2pa.metadata.run-one"),
    0x00,
    ...textBytes("another-printable-run"),
    ...new Uint8Array([0x00, 0xff]),
  ];
  const cabx = pngChunk("caBX", new Uint8Array(cabxPayload));
  const pixelNoise = new Uint8Array([222, 173, 190, 239, 11, 22, 33]);
  const idat = pngChunk("IDAT", pixelNoise);
  const png = concatBytes([signature, ihdr, itext, cabx, idat]);
  return { png, pixelNoise };
}

function jpegSegment(marker, payload) {
  const bytes = new Uint8Array(4 + payload.length);
  bytes[0] = 0xff;
  bytes[1] = marker;
  const length = payload.length + 2;
  bytes[2] = (length >> 8) & 0xff;
  bytes[3] = length & 0xff;
  bytes.set(payload, 4);
  return bytes;
}

function jpegWithXmpAndApp11() {
  const xmpPayload = [
    ...textBytes("http://ns.adobe.com/xap/1.0/\0"),
    ...textBytes("<x:xmpmeta>雪夜霓虹街景, neon alley at night</x:xmpmeta>"),
  ];
  const app11Payload = [
    ...textBytes("JP\0\0"),
    ...new Uint8Array([0x00, 0xa1, 0xb2]),
    ...textBytes("jumbf-c2pa-string"),
    0x00,
    ...new Uint8Array([0xff, 0xd9]),
  ];
  return {
    jpeg: concatBytes([
      new Uint8Array([0xff, 0xd8]),
      jpegSegment(0xe1, new Uint8Array(xmpPayload)),
      jpegSegment(0xeb, new Uint8Array(app11Payload)),
      new Uint8Array([0xff, 0xd9]),
    ]),
  };
}

function webpWithExifAndXmp() {
  const exif = textBytes("Exif\0\0MM\0*\0\0\0\0\0anti-pattern\0");
  const xmp = textBytes("<x:xmpmeta>webp side</x:xmpmeta>");
  const chunk = (fourcc, data) => {
    const bytes = new Uint8Array(8 + data.length + (data.length % 2));
    for (let index = 0; index < 4; index += 1) bytes[index] = fourcc.charCodeAt(index);
    new DataView(bytes.buffer).setUint32(4, data.length, true);
    bytes.set(data, 8);
    return bytes;
  };
  const chunks = [chunk("EXIF", exif), chunk("XMP ", xmp)];
  const header = new Uint8Array(12);
  header.set(textBytes("RIFF"), 0);
  new DataView(header.buffer).setUint32(4, 4 + chunks.reduce((sum, part) => sum + part.length, 0), true);
  header.set(textBytes("WEBP"), 8);
  return { webp: concatBytes([header, ...chunks]) };
}

// ---- masking rules ----

test("masking: sensitive JSON keys collapse to [masked] wherever they appear", () => {
  const api = createDevRawApi();
  const masked = JSON.parse(api.maskRawText(JSON.stringify({
    access_token: "secret-token-value",
    Authorization: "Bearer xyz",
    cookie: "session=1",
    clientSecret: "shh",
    password: "hunter2",
    signature: "sig-value",
    sig: "sig-value",
    session_id: "sess-42",
    nested: { apiKey: "kept", token: "gone", deep: [{ refreshToken: "gone", note: "kept" }] },
  })));
  assert.equal(masked.access_token, "[masked]");
  assert.equal(masked.Authorization, "[masked]");
  assert.equal(masked.cookie, "[masked]");
  assert.equal(masked.clientSecret, "[masked]");
  assert.equal(masked.password, "[masked]");
  assert.equal(masked.signature, "[masked]");
  assert.equal(masked.sig, "[masked]");
  assert.equal(masked.session_id, "[masked]");
  assert.equal(masked.nested.token, "[masked]");
  assert.equal(masked.nested.apiKey, "kept");
  assert.equal(masked.nested.deep[0].refreshToken, "[masked]");
  assert.equal(masked.nested.deep[0].note, "kept");
});

test("masking: an SSE data line keeps its payload shape while keys are masked", () => {
  const api = createDevRawApi();
  const line = `data: ${JSON.stringify({ p: "/message/metadata", o: "replace", v: { prompt: null, ws_token: "abc" } })}`;
  const masked = api.maskRawText(line);
  assert.ok(masked.startsWith("data: "));
  assert.ok(masked.includes('"prompt":null'));
  assert.ok(masked.includes('"ws_token":"[masked]"'));
  assert.ok(!masked.includes("abc"));
});

test("masking: URL query values are stripped to their keys, including inside JSON strings", () => {
  const api = createDevRawApi();
  const url = "https://chatgpt.com/backend-api/estuary/content?id=file_abc&sig=SIGVALUE&se=1700000000";
  assert.equal(
    api.stripUrlQueryValues(url),
    "https://chatgpt.com/backend-api/estuary/content?id&sig&se",
  );
  const masked = api.maskRawText(JSON.stringify({
    download_url: "https://files.oaiusercontent.com/f?sig=abc&se=1&mime=image%2Fpng",
  }));
  assert.ok(masked.includes("https://files.oaiusercontent.com/f?sig&se&mime"));
  assert.ok(!masked.includes("abc&se=1"));
});

test("masking: websocket envelopes get their base64 body decoded, masked, and kept readable", () => {
  const api = createDevRawApi();
  const inner = `data: ${JSON.stringify({ message: { token: "inner-secret", url: "https://x.y/a?sig=z&ok=1" } })}`;
  const envelope = JSON.stringify({
    type: "http.response.body",
    body: Buffer.from(inner, "utf8").toString("base64"),
  });
  const masked = api.prepareSocketText(envelope);
  const parsed = JSON.parse(masked);
  assert.equal(parsed.bodyDecoded, true);
  assert.ok(parsed.body.includes("data: "));
  assert.ok(parsed.body.includes('"token":"[masked]"'));
  assert.ok(parsed.body.includes("https://x.y/a?sig&ok"));
  assert.ok(!parsed.body.includes("inner-secret"));
  assert.ok(!masked.includes(Buffer.from(inner, "utf8").toString("base64")));
});

test("switch off: nothing is buffered, no blob metadata is read, no record is emitted", async () => {
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} });
  const clock = fakeTimers(harness.devRaw);
  assert.equal(harness.devRaw.isEnabled(), false);

  await harness.socketFrame(JSON.stringify({
    conversation_id: "conversation-test",
    message: {
      id: "message-tool-off",
      author: { role: "tool", name: "image_gen.text2im" },
      content: {
        content_type: "multimodal_text",
        parts: [{ content_type: "image_asset_pointer", asset_pointer: "sediment://file-off", metadata: { dalle: { gen_id: "gen-off", prompt: "" } } }],
      },
      metadata: { turn_exchange_id: "turn-off" },
    },
  }));
  const response = new harness.responseClass(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
    url: "https://chatgpt.com/backend-api/estuary/content?id=file-off&cid=conversation-test",
    type: "image/png",
  });
  await response.blob();
  await harness.harvest({ method: "GET" }, "https://chatgpt.com/backend-api/conversation/conversation-test");
  clock.advance(60_000);
  await setImmediate();

  assert.equal(harness.devRaw.debugState().bufferedFrames("conversation-test"), 0);
  assert.equal(harness.devRaw.debugState().bufferedMetaCount("conversation-test"), 0);
  assert.equal(devRawRecords(harness).length, 0);
});

test("SSE raw record: a 5.6 prompt-less turn produces one record whose frames keep the raw prompt-null lines", async () => {
  const harness = streamedHarness(deltaV1StreamEventsWithNullPrompt());
  await enableDevRaw(harness);
  const clock = fakeTimers(harness.devRaw);

  await harness.harvest({ method: "POST" }, "https://chatgpt.com/backend-api/f/conversation");
  assert.ok(harness.events.some((event) => event.type === "generation-meta" && event.payload?.assetId === "file-poster"));
  assert.equal(devRawRecords(harness).length, 0, "no record before the 30s window closes");

  clock.advance(30_000);
  const records = devRawRecords(harness);
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.control, false);
  assert.equal(record.conversationId, "conversation-test", "the full conversation id is kept");
  assert.equal(record.assistantMessageId, "message-tool-image");
  assert.equal(record.userMessageId, "message-user");
  assert.deepEqual([...record.models], ["gpt-5-6-thinking"]);
  assert.deepEqual(JSON.parse(JSON.stringify(record.images)), [{
    fileId: "file-poster",
    generationId: "generation-poster",
    promptStatus: "not-available",
    promptLength: 0,
    model: "gpt-5-6-thinking",
  }]);
  assert.ok(Array.isArray(record.frames) && record.frames.length > 1, "sse lines plus the stream request frame");

  const lineText = record.frames.map((frame) => frame.line || "").join("\n");
  assert.ok(/prompt\\?":\s*null/.test(lineText), "the raw SSE text carries the prompt-null arguments (escaped in the code-args string or bare in a patch)");
  assert.ok(lineText.includes("画一张雾中山谷的旅行海报"), "raw conversation text is the point of this feature");
  assert.ok(lineText.includes("event: delta_encoding"), "event: lines are recorded too");
  const sources = new Set(record.frames.map((frame) => frame.source));
  assert.ok(sources.has("sse"));
  assert.equal(record.truncated, undefined);
  assert.ok(record.window.start <= record.window.end);
});

test("WebSocket raw record: a captioned 5.4 turn is only kept as a control sample when sampling hits", async () => {
  const caption = "Model caption: 一张暖色沙漠时装大片海报，电影感光影与胶片颗粒，杂志封面排版。";
  const frameText = JSON.stringify({
    update_content: {
      messages: [{
        message: {
          id: "message-live",
          author: { role: "tool" },
          content: { parts: [caption, { asset_pointer: "sediment://file-live" }] },
          metadata: { model_slug: "gpt-5.4" },
        },
      }],
    },
  });

  async function runWithRandom(value) {
    const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} });
    await enableDevRaw(harness);
    const clock = fakeTimers(harness.devRaw);
    harness.devRaw.__randomSource = () => value;
    await harness.socketFrame(frameText);
    assert.ok(harness.events.some((event) => event.type === "generation-meta" && event.payload?.prompt === caption));
    clock.advance(30_000);
    return devRawRecords(harness);
  }

  const miss = await runWithRandom(0.99);
  assert.equal(miss.length, 0, "a sampled-out control round must not produce a record");

  const hit = await runWithRandom(0.05);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].control, true);
  assert.deepEqual(JSON.parse(JSON.stringify(hit[0].images)), [{
    fileId: "file-live",
    generationId: "",
    promptStatus: "visible-caption",
    promptLength: caption.length,
    model: "gpt-5.4",
  }]);
  const frameTexts = hit[0].frames.map((frame) => frame.message || "").join("\n");
  assert.ok(frameTexts.includes("Model caption:"), "the ws-in frames keep the raw caption text");
  assert.ok(hit[0].models.includes("gpt-5.4"));
});

test("per-round: four images under one assistant message become exactly one record with four images, only after the window closes", async () => {
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} });
  await enableDevRaw(harness);
  const clock = fakeTimers(harness.devRaw);

  const quadMessage = () => JSON.stringify({
    conversation_id: "conversation-test",
    message: {
      id: "message-quad",
      author: { role: "tool", name: "image_gen.text2im" },
      content: {
        content_type: "multimodal_text",
        parts: ["file-quad-1", "file-quad-2", "file-quad-3", "file-quad-4"].map((fileId) => ({
          content_type: "image_asset_pointer",
          asset_pointer: `sediment://${fileId}`,
          metadata: { dalle: { gen_id: `gen-${fileId}`, prompt: "" } },
        })),
      },
      metadata: { turn_exchange_id: "turn-quad" },
    },
  });
  await harness.socketFrame(quadMessage());
  // A later emission inside the window must not close the round early.
  clock.advance(20_000);
  await harness.socketFrame(quadMessage());
  clock.advance(25_000);
  assert.equal(devRawRecords(harness).length, 0, "the 30s window restarts with every new image");

  clock.advance(10_000);
  const records = devRawRecords(harness);
  assert.equal(records.length, 1);
  assert.equal(records[0].images.length, 4);
  assert.equal(records[0].assistantMessageId, "message-quad");
});

test("archive-only images stay unrecorded until the live stream carries them", async () => {
  // Reopening a conversation replays its stored JSON through the same hook;
  // those historical images must not flood the store with rounds that have no
  // live frames behind them.
  const archivedMessage = {
    id: "message-archived",
    author: { role: "tool", name: "image_gen.text2im" },
    content: {
      content_type: "multimodal_text",
      parts: [{
        content_type: "image_asset_pointer",
        asset_pointer: "sediment://file-archived",
        metadata: { dalle: { gen_id: "gen-archived", prompt: "" } },
      }],
    },
    metadata: { turn_exchange_id: "turn-archived", image_gen_title: "Generated image" },
  };
  let archiveRequests = 0;
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} }, "conversation-test", {
    respond: (url) => {
      if (String(url).includes("/backend-api/conversations/conversation-test")) {
        archiveRequests += 1;
        return {
          ok: true,
          status: 200,
          headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json" : null) },
          clone: () => ({ json: async () => ({ conversation_id: "conversation-test", mapping: {}, messages: [archivedMessage] }) }),
          json: async () => ({ conversation_id: "conversation-test", mapping: {}, messages: [archivedMessage] }),
        };
      }
      return null;
    },
  });
  await enableDevRaw(harness);
  const clock = fakeTimers(harness.devRaw);
  harness.devRaw.__randomSource = () => 0.99;

  await harness.harvest({ method: "GET" }, "https://chatgpt.com/backend-api/conversations/conversation-test");
  assert.equal(archiveRequests, 1);
  assert.ok(harness.events.some((event) => (
    event.type === "generation-meta" && event.payload?.assetId === "file-archived"
  )), "the hook still binds the historical image");
  clock.advance(30_000);
  assert.equal(devRawRecords(harness).length, 0, "an archive-only image never triggers a record");

  // The same image delivered by the live stream does.
  await harness.socketFrame(JSON.stringify({
    conversation_id: "conversation-test",
    message: {
      ...archivedMessage,
      metadata: { ...archivedMessage.metadata, model_slug: "gpt-5-6-thinking" },
    },
  }));
  clock.advance(30_000);
  const records = devRawRecords(harness);
  assert.equal(records.length, 1);
  assert.equal(records[0].assistantMessageId, "message-archived");
  assert.deepEqual(JSON.parse(JSON.stringify(records[0].images)), [{
    fileId: "file-archived",
    generationId: "gen-archived",
    promptStatus: "not-available",
    promptLength: 0,
    model: "gpt-5-6-thinking",
  }]);
});

test("rounds: frames stay with their own assistant message", () => {
  const api = createDevRawApi();
  const timers = fakeTimers(api);
  api.__randomSource = () => 0.99;
  api.setEnabled(true);
  const records = [];
  api.onRecord = (value) => records.push(value);

  const frameFor = (messageId, turnId, fileId, withCaption) => JSON.stringify({
    update_content: {
      messages: [{
        message: {
          id: messageId,
          author: { role: "tool", name: "t2uay3k.sj1i4kz" },
          content: {
            content_type: "multimodal_text",
            parts: [
              { content_type: "image_asset_pointer", asset_pointer: `sediment://${fileId}`, metadata: { dalle: { gen_id: `gen-${fileId}`, prompt: "" } } },
              ...(withCaption ? [`Model caption: A flat vector study sheet for a round mascot with thick outlines and a plain background.`] : []),
            ],
          },
          metadata: { turn_exchange_id: turnId },
        },
      }],
    },
  });
  api.recordSocketMessage("conversation-attr", "ws-in", frameFor("message-own", "turn-own", "file-own", false));
  api.recordSocketMessage("conversation-attr", "ws-in", frameFor("message-other", "turn-other", "file-other", true));

  api.noteImage({
    conversationId: "conversation-attr",
    assistantMessageId: "message-own",
    fileId: "file-own",
    promptStatus: "not-available",
    model: "",
  });
  timers.advance(api.ROUND_FINALIZE_DELAY_MS + 1);

  assert.equal(records.length, 1, "only the prompt-less own round is recorded");
  const record = records[0];
  assert.equal(record.assistantMessageId, "message-own");
  const frameTexts = record.frames.map((frame) => frame.message || frame.line || "").join("\n");
  assert.ok(frameTexts.includes("message-own"), "the round keeps its own frames");
  assert.ok(!frameTexts.includes("message-other"), "frames of another message never join");
  assert.ok(!frameTexts.includes("turn-other"), "not even via their turn ids");
});

test("rounds: the same WebSocket frame delivered repeatedly is kept once", () => {
  const api = createDevRawApi();
  const timers = fakeTimers(api);
  api.__randomSource = () => 0.99;
  api.setEnabled(true);
  const records = [];
  api.onRecord = (value) => records.push(value);

  const duplicate = JSON.stringify({
    update_content: {
      messages: [{
        message: {
          id: "message-dup",
          author: { role: "tool", name: "t2uay3k.sj1i4kz" },
          content: {
            content_type: "multimodal_text",
            parts: [{ content_type: "image_asset_pointer", asset_pointer: "sediment://file-dup", metadata: { dalle: { gen_id: "gen-dup", prompt: "" } } }],
          },
          metadata: { turn_exchange_id: "turn-dup", model_slug: "gpt-5-6-thinking" },
        },
      }],
    },
  });
  const distinct = JSON.stringify({
    update_content: {
      messages: [{
        message: {
          id: "message-dup-status",
          author: { role: "tool", name: "t2uay3k.sj1i4kz" },
          content: { content_type: "text", parts: ["Generated images from the last model call were saved at /mnt/data."] },
          metadata: { turn_exchange_id: "turn-dup" },
        },
      }],
    },
  });
  api.recordSocketMessage("conversation-dup", "ws-in", duplicate);
  timers.advance(200);
  api.recordSocketMessage("conversation-dup", "ws-in", duplicate);
  timers.advance(200);
  api.recordSocketMessage("conversation-dup", "ws-in", duplicate);
  timers.advance(500);
  api.recordSocketMessage("conversation-dup", "ws-in", distinct);

  api.noteImage({
    conversationId: "conversation-dup",
    assistantMessageId: "message-dup",
    fileId: "file-dup",
    promptStatus: "not-available",
    model: "gpt-5-6-thinking",
  });
  timers.advance(api.ROUND_FINALIZE_DELAY_MS + 1);

  assert.equal(records.length, 1);
  const imageFrames = records[0].frames.filter((frame) => (frame.message || "").includes("message-dup\""));
  assert.equal(imageFrames.length, 1, "three identical frames within a second collapse to one");
  assert.ok(records[0].frames.some((frame) => (frame.message || "").includes("message-dup-status")), "a different frame still joins");
});

test("masking: websocket_url query values lose their values, verify included", () => {
  const api = createDevRawApi();
  const masked = api.maskRawText(JSON.stringify({
    websocket_url: "wss://ws.example.com/backend-api/celsius/ws/user?verify=SECRETVERIFY&rid=7&v=2",
  }));
  assert.ok(masked.includes("wss://ws.example.com/backend-api/celsius/ws/user?verify&rid&v"), "query keys survive");
  assert.ok(!masked.includes("SECRETVERIFY"), "the verify token is gone");
});

test("store: one record per conversation + assistant message, richer frames win", async () => {
  const store = createMemoryStore();
  const record = (frames, messageId = "message-reopen") => ({
    recordedAt: "2026-10-17T10:00:00Z",
    conversationId: "conversation-reopen",
    assistantMessageId: messageId,
    images: [{ fileId: "file-reopen", promptStatus: "not-available" }],
    frames: frames.map((marker) => ({ t: 1700000000000, source: "sse", line: `data: {"marker":"${marker}"}` })),
  });

  await store.addRecord(record(["a", "b", "c"]));
  await store.addRecord(record(["a", "b", "c"]));
  await store.addRecord(record(["a", "b"]));
  let stats = await store.statsRecords();
  assert.equal(stats.count, 1, "three re-records of the same round stay one record");

  await store.addRecord(record(["a", "b", "c", "d", "e"]));
  stats = await store.statsRecords();
  assert.equal(stats.count, 1, "the richer re-record replaces the poorer one");
  const page = await store.listRecords({ limit: 10 });
  assert.equal(page.records[0].frames.length, 5);

  await store.addRecord(record(["x"], "message-unrelated"));
  stats = await store.statsRecords();
  assert.equal(stats.count, 2, "a different assistant message is its own record");
});

test("HTTP: GET and POST backend-api exchanges are recorded with query keys only, masked bodies, and no headers", async () => {
  const httpBody = {
    access_token: "TOPSECRET",
    authorization: "Bearer SECRET",
    payload: {
      download_url: "https://files.oaiusercontent.com/download?sig=ABC&se=42&mime=image%2Fpng",
      title: "雾中山谷",
    },
  };
  let requests = 0;
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} }, "conversation-test", {
    respond: (url) => {
      if (String(url).includes("/backend-api/conversation/conversation-test")) {
        requests += 1;
        return {
          ok: true,
          status: 200,
          headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json" : null) },
          clone() {
            return { text: async () => JSON.stringify({ ...httpBody, huge: "y".repeat(2 * 1024 * 1024 + 4096) }) };
          },
          text: async () => JSON.stringify(httpBody),
        };
      }
      return null;
    },
  });
  await enableDevRaw(harness);
  const clock = fakeTimers(harness.devRaw);

  await harness.harvest({ method: "GET" }, "https://chatgpt.com/backend-api/conversation/conversation-test?sig=SIG&se=7");
  await harness.harvest({ method: "POST" }, "https://chatgpt.com/backend-api/conversation/conversation-test");
  assert.equal(requests, 2);
  assert.equal(harness.devRaw.debugState().bufferedFrames("conversation-test"), 2);

  // Complete a control round so the buffered http frames become inspectable.
  harness.devRaw.__randomSource = () => 0;
  await harness.socketFrame(JSON.stringify({
    conversation_id: "conversation-test",
    message: {
      id: "message-http",
      author: { role: "tool", name: "image_gen.text2im" },
      content: {
        content_type: "multimodal_text",
        parts: [{
          content_type: "image_asset_pointer",
          asset_pointer: "sediment://file-http",
          metadata: { dalle: { gen_id: "gen-http", prompt: "" } },
        }],
      },
      metadata: { turn_exchange_id: "turn-http" },
    },
  }));
  clock.advance(30_000);
  const records = devRawRecords(harness);
  assert.equal(records.length, 1);
  const httpFrames = records[0].frames.filter((frame) => frame.source === "http");
  assert.equal(httpFrames.length, 2);
  const [getFrame, postFrame] = httpFrames;
  assert.equal(getFrame.method, "GET");
  assert.equal(getFrame.path, "/backend-api/conversation/conversation-test");
  assert.deepEqual([...getFrame.queryKeys], ["sig", "se"], "query parameters keep their keys only");
  assert.equal(getFrame.status, 200);
  assert.equal(getFrame.contentType, "application/json");
  assert.ok(!("headers" in getFrame) && !("requestHeaders" in getFrame), "headers are never recorded");
  assert.ok(getFrame.body.includes("[masked]"));
  assert.ok(getFrame.body.includes("https://files.oaiusercontent.com/download?sig&se&mime"));
  assert.ok(!getFrame.body.includes("TOPSECRET"));
  assert.ok(!getFrame.body.includes("Bearer SECRET"));
  assert.ok(getFrame.body.includes("雾中山谷"));
  assert.equal(getFrame.bodyTruncated, true, "the oversized response body is truncated");
  assert.ok(getFrame.bodyOriginalLength > 2 * 1024 * 1024);
  assert.ok(getFrame.body.length < 3 * 1024 * 1024);
  assert.equal(postFrame.method, "POST");
});

test("limits: the buffer evicts at 3000 frames and 10 minutes; the record budget truncates bodies before dropping frames", () => {
  const api = createDevRawApi();
  api.setEnabled(true);
  let tick = 0;
  api.__clock = () => 1_700_000_000_000 + tick;

  for (let index = 0; index < 3100; index += 1) {
    api.recordSseLine("conversation-test", { method: "POST", path: "/backend-api/f/conversation" }, `data: {"i":${index}}`);
  }
  assert.equal(api.debugState().bufferedFrames("conversation-test"), api.MAX_BUFFER_FRAMES, "3000-frame cap");

  // TTL eviction: frames older than 10 minutes fall off on the next push.
  // The fresh line also puts the round's image on the live-frames radar —
  // only images the live stream delivered may trigger a record.
  tick += api.BUFFER_TTL_MS + 1;
  api.recordSseLine("conversation-test", { method: "POST", path: "/backend-api/f/conversation" }, "data: {\"fresh\":true,\"file_id\":\"file-big\"}");
  assert.equal(api.debugState().bufferedFrames("conversation-test"), 1);

  // Record budget: twelve ~1.5 MiB bodies exceed the 8 MiB record cap.
  const bigBody = JSON.stringify({ blob: "z".repeat(1_500_000) });
  for (let index = 0; index < 12; index += 1) {
    api.recordHttpExchange("conversation-test", {
      method: "GET",
      url: `https://chatgpt.com/backend-api/conversation/big-${index}`,
      status: 200,
      contentType: "application/json",
      bodyText: bigBody,
    });
  }
  const records = [];
  api.onRecord = (value) => records.push(value);
  api.__timers = {
    set: (fn) => { fn(); return 0; },
    clear: () => {},
  };
  api.noteUserMessage("conversation-test", "message-user");
  api.noteImage({
    conversationId: "conversation-test",
    assistantMessageId: "message-big",
    fileId: "file-big",
    generationId: "gen-big",
    promptStatus: "not-available",
    promptLength: 0,
    model: "",
  });

  assert.equal(records.length, 1, "the round finalized immediately under the manual timer");
  const record = records[0];
  assert.equal(record.assistantMessageId, "message-big");
  assert.equal(record.control, false);
  assert.ok(devRawRecordBytes(record) <= api.MAX_RECORD_BYTES, "the stored record fits the 8 MiB budget");
  assert.equal(record.truncated, true);
  const httpFrames = record.frames.filter((frame) => frame.source === "http");
  const truncatedBodies = httpFrames.filter((frame) => frame.bodyTruncated === true && typeof frame.bodyPreview === "string");
  assert.ok(truncatedBodies.length >= 1, "the largest HTTP bodies were replaced with previews first");
  assert.ok(truncatedBodies.every((frame) => frame.bodyPreview.length <= 2048));
  assert.ok(truncatedBodies.every((frame) => frame.bodyOriginalLength > 1_400_000), "replaced bodies were the large ones");
});

test("store: the memory store evicts beyond 200 records, pages exports, and clears", async () => {
  const store = createMemoryStore();
  for (let index = 0; index < 250; index += 1) {
    await store.addRecord({
      recordedAt: `2026-10-14T00:00:${String(index % 60).padStart(2, "0")}`,
      conversationId: `conv-${index}`,
      control: index % 10 === 0,
      images: [{ promptStatus: index % 2 ? "not-available" : "visible-caption" }],
      frames: [{ t: index, source: "sse", line: `data: {"i":${index}}` }],
    });
  }
  const stats = await store.statsRecords();
  assert.equal(stats.count, 200, "only the newest 200 rounds are kept");
  assert.equal(stats.missingPromptCount, 100);
  assert.equal(stats.controlCount, 20);
  assert.ok(stats.bytes > 0);
  assert.ok(stats.maxId >= 250, "ids stay monotonic across evictions so 'recent 20' can seek");

  const page = await store.listRecords({ afterId: stats.maxId - 20, limit: 10 });
  assert.equal(page.records.length, 10);
  assert.equal(page.hasMore, true);
  const rest = await store.listRecords({ afterId: page.nextAfterId, limit: 10 });
  assert.equal(rest.records.length, 10);
  assert.equal(rest.hasMore, false, "exactly the newest 20 records were paged through");

  await store.clearRecords();
  const cleared = await store.statsRecords();
  assert.equal(cleared.count, 0);
});

test("store: eviction math drops the oldest ids first until both caps hold", () => {
  const summaries = Array.from({ length: 5 }, (_, index) => ({ id: index + 1, bytes: 100 }));
  assert.deepEqual(idsToEvict(summaries, { maxRecords: 3, maxTotalBytes: 100_000 }), [1, 2]);
  assert.deepEqual(idsToEvict(summaries, { maxRecords: 10, maxTotalBytes: 250 }), [1, 2, 3]);
  assert.deepEqual(idsToEvict(summaries, { maxRecords: 10, maxTotalBytes: 100_000 }), []);
});

test("startup cleanup: the three removed structure-only diagnostics keys are deleted", async () => {
  const removed = [];
  const fakeStorage = { remove: async (keys) => removed.push(...keys) };
  await removeLegacyCaptureDiagnosticsKeys(fakeStorage);
  assert.deepEqual(removed.sort(), ["captureDiagnostics", "mosaCaptureDiagnosticsRejects", "mosaCaptureDiagnosticsV1"]);
});

test("image metadata: PNG iTXt/caBX and JPEG XMP/APP11 and WebP EXIF/XMP are read without pixel data", async () => {
  const api = createDevRawApi();
  api.setEnabled(true);

  const { png, pixelNoise } = pngWithItextAndCabx();
  const pngMeta = await api.extractImageMeta(png, "image/png");
  assert.equal(pngMeta.byteLength, png.byteLength);
  const pngTexts = pngMeta.segments.filter((segment) => segment.kind === "text").map((segment) => segment.text);
  assert.ok(pngTexts.some((text) => text.includes("一张雾中山谷的旅行海报")));
  const pngStrings = pngMeta.segments.filter((segment) => segment.chunk === "PNG-caBX").flatMap((segment) => segment.strings);
  assert.ok(pngStrings.includes("c2pa.metadata.run-one"));
  assert.ok(pngStrings.includes("another-printable-run"));
  const pixelSignature = Array.from(pixelNoise).join(",");
  assert.ok(!JSON.stringify(pngMeta).includes(pixelSignature), "pixel bytes never enter the metadata");

  const { jpeg } = jpegWithXmpAndApp11();
  const jpegMeta = await api.extractImageMeta(jpeg, "image/jpeg");
  assert.ok(jpegMeta.segments.some((segment) => segment.chunk === "JPEG-XMP" && segment.text.includes("neon alley at night")));
  const app11Strings = jpegMeta.segments.filter((segment) => segment.chunk === "JPEG-APP11").flatMap((segment) => segment.strings);
  assert.ok(app11Strings.includes("jumbf-c2pa-string"));

  const { webp } = webpWithExifAndXmp();
  const webpMeta = await api.extractImageMeta(webp, "image/webp");
  assert.ok(webpMeta.segments.some((segment) => segment.chunk === "WEBP-XMP" && segment.text.includes("webp side")));
  assert.ok(webpMeta.segments.some((segment) => segment.chunk === "WEBP-EXIF" && segment.strings.includes("anti-pattern")));

  // zTXt survives inflation.
  const zlib = await import("node:zlib");
  const compressed = zlib.deflateSync(textBytes("ztxt 压缩后的原文内容"));
  const ztxt = pngChunk("zTXt", new Uint8Array([...textBytes("Comment"), 0, 0, ...compressed]));
  const ztxtMeta = await api.extractImageMeta(concatBytes([png, ztxt]), "image/png");
  assert.ok(ztxtMeta.segments.some((segment) => (
    segment.chunk === "PNG-zTXt" && segment.inflated === true && segment.text.includes("ztxt 压缩后的原文内容")
  )));

  // The per-image metadata budget is capped at 256 KiB.
  const hugeText = pngChunk("tEXt", new Uint8Array([...textBytes("Big"), 0, ...textBytes("w".repeat(600_000))]));
  const hugeMeta = await api.extractImageMeta(concatBytes([png, hugeText]), "image/png");
  assert.equal(hugeMeta.metaTruncated, true);
  assert.ok(devRawRecordBytes(hugeMeta) < api.MAX_IMAGE_META_BYTES + 1024);
});

test("blob integration: an estuary blob's metadata lands in the round record with mime and byte length", async () => {
  const { png } = pngWithItextAndCabx();
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} });
  await enableDevRaw(harness);
  const clock = fakeTimers(harness.devRaw);

  const response = new harness.responseClass(png, {
    url: "https://chatgpt.com/backend-api/estuary/content?id=file-meta&cid=conversation-test&sig=SIG",
    type: "image/png",
  });
  await response.blob();
  for (let index = 0; index < 5; index += 1) await setImmediate();
  assert.equal(harness.devRaw.debugState().bufferedMetaCount("conversation-test"), 1);

  await harness.socketFrame(JSON.stringify({
    conversation_id: "conversation-test",
    message: {
      id: "message-meta",
      author: { role: "tool", name: "image_gen.text2im" },
      content: {
        content_type: "multimodal_text",
        parts: [{
          content_type: "image_asset_pointer",
          asset_pointer: "sediment://file-meta",
          metadata: { dalle: { gen_id: "gen-meta", prompt: "" } },
        }],
      },
      metadata: { turn_exchange_id: "turn-meta" },
    },
  }));
  clock.advance(30_000);
  const records = devRawRecords(harness);
  assert.equal(records.length, 1);
  assert.equal(records[0].imageMeta.length, 1);
  const meta = records[0].imageMeta[0];
  assert.equal(meta.fileId, "file-meta");
  assert.equal(meta.mime, "image/png");
  assert.equal(meta.byteLength, png.byteLength);
  assert.ok(JSON.stringify(meta.segments).includes("一张雾中山谷的旅行海报"));
});

test("disabling the switch drops buffers and pending rounds immediately", async () => {
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} });
  await enableDevRaw(harness);
  const clock = fakeTimers(harness.devRaw);
  await harness.socketFrame(JSON.stringify({
    conversation_id: "conversation-test",
    message: {
      id: "message-reset",
      author: { role: "tool" },
      content: {
        content_type: "multimodal_text",
        parts: [{ content_type: "image_asset_pointer", asset_pointer: "sediment://file-reset", metadata: { dalle: { gen_id: "g", prompt: "" } } }],
      },
      metadata: {},
    },
  }));
  assert.ok(harness.devRaw.debugState().pendingRounds >= 1);
  await harness.sendToPageHook({
    source: "mosa-chatgpt-capture",
    type: "set-dev-raw-diagnostics-enabled",
    payload: { enabled: false },
  });
  assert.equal(harness.devRaw.debugState().pendingRounds, 0);
  assert.equal(harness.devRaw.debugState().bufferedFrames("conversation-test"), 0);
  clock.advance(60_000);
  assert.equal(devRawRecords(harness).length, 0);
});

test("options page: the diagnostics panel only exists behind options.html#dev", () => {
  assert.equal(manifest.version, "0.15.36");
  assert.ok(manifest.permissions.includes("unlimitedStorage"));
  assert.ok(backgroundSource.includes("chrome.runtime.getManifest().version"),
    "the background stamps stored records with the extension version");
  assert.ok(backgroundSource.includes("removeLegacyCaptureDiagnosticsKeys(chrome.storage.local)"),
    "startup removes the legacy diagnostics keys");
  assert.ok(optionsHtml.includes('<section id="devDiagnostics" hidden'), "the panel ships hidden");
  assert.ok(!optionsHtml.includes('id="diagnosticsEnabled"'), "the old visible switch is gone");
  assert.ok(optionsSource.includes('window.location.hash === "#dev"'), "the panel unhide is gated on the #dev hash");
  assert.ok(optionsSource.includes("devPanelEl.hidden = false"), "the panel is only revealed inside the gate");
  assert.ok(optionsSource.includes("mosa-raw-diagnostics-"), "exports keep the raw-diagnostics file name");
  assert.ok(!privacySource.includes("capture diagnostics"), "the removed feature is out of the privacy document");
  assert.ok(!extensionReadme.includes("0.15.28"), "the removed feature is out of the extension README");
});

test("rounds: frames from a brand-new chat (no conversation id in the URL yet) are merged in, and models are this round's only", () => {
  const api = createDevRawApi();
  const timers = fakeTimers(api);
  api.__randomSource = () => 0.99;
  api.setEnabled(true);
  const records = [];
  api.onRecord = (value) => records.push(value);
  const sse = { method: "POST", path: "/backend-api/f/conversation" };

  // An older turn in the buffer used another model; it is outside the window.
  api.recordSseLine("conversation-new", sse, 'data: {"message":{"metadata":{"model_slug":"gpt-5-4"}}}');
  timers.advance(5 * 60 * 1000);

  // The new turn starts before the URL carries /c/<id>. Its frames carry the
  // image's file id, so the round counts as a live delivery.
  api.recordSseLine(api.UNROUTED_KEY, sse, 'data: {"message":{"metadata":{"model_slug":"gpt-6-thinking"},"content":{"parts":["unrouted-early"]},"file_id":"file-new"}}');
  timers.advance(1000);
  api.noteUserMessage("conversation-new", "message-user");
  api.recordSseLine("conversation-new", sse, 'data: {"tool":{"prompt":null}}');
  api.noteImage({
    conversationId: "conversation-new",
    assistantMessageId: "message-new",
    fileId: "file-new",
    promptStatus: "not-available",
    model: "gpt-6-thinking",
  });
  timers.advance(api.ROUND_FINALIZE_DELAY_MS + 1);

  assert.equal(records.length, 1);
  const lines = records[0].frames.map((frame) => frame.line);
  assert.ok(lines.some((line) => line.includes("unrouted-early")), "unrouted frames inside the window are merged in");
  assert.ok(lines.some((line) => line.includes('"prompt":null')));
  assert.ok(!lines.some((line) => line.includes("gpt-5-4")), "frames before the window stay out");
  assert.deepEqual([...records[0].models], ["gpt-6-thinking"], "models come from this round's frames only");
  const times = records[0].frames.map((frame) => frame.t);
  assert.deepEqual([...times], [...times].sort((a, b) => a - b), "merged frames stay in time order");
});

test("background: the dev panel routes accept the options page opened in a tab, and nothing else", () => {
  const start = backgroundSource.indexOf("function extensionPageSender(");
  const gateStart = backgroundSource.indexOf("function senderAllowedForMessage(");
  const gateEnd = backgroundSource.indexOf("\n}\n", gateStart) + 3;
  assert.ok(start >= 0 && gateStart > start && gateEnd > gateStart);
  const sandbox = {
    chrome: { runtime: { id: "extid" } },
    providerForPageUrl: (url) => (String(url).startsWith("https://chatgpt.com/") ? "chatgpt" : ""),
    Number,
    String,
    Boolean,
  };
  vm.runInNewContext(`${backgroundSource.slice(start, gateEnd)}\nthis.gate = senderAllowedForMessage;`, sandbox);
  const options = { id: "extid", frameId: 0, url: "chrome-extension://extid/options.html#dev", tab: { id: 7 } };
  const chatgptTab = { id: "extid", frameId: 0, url: "https://chatgpt.com/c/abc", tab: { id: 8, url: "https://chatgpt.com/c/abc" } };
  for (const type of ["mosa.devRawDiagnostics.stats", "mosa.devRawDiagnostics.exportPage", "mosa.devRawDiagnostics.clear"]) {
    assert.equal(sandbox.gate({ type }, options), true, `${type} from the options tab`);
    assert.equal(sandbox.gate({ type }, chatgptTab), false, `${type} from a ChatGPT page`);
    assert.equal(sandbox.gate({ type }, { ...options, id: "other" }), false, `${type} from another extension`);
    assert.equal(sandbox.gate({ type }, { ...options, frameId: 2 }), false, `${type} from a subframe`);
  }
  assert.equal(sandbox.gate({ type: "mosa.devRawDiagnostics.record" }, chatgptTab), true);
  assert.equal(sandbox.gate({ type: "mosa.devRawDiagnostics.record" }, options), false);
});
