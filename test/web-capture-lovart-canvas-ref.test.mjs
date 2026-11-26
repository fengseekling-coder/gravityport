import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import sharp from "sharp";
import Database from "better-sqlite3";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { LOVART_BASE_IMAGE_RESOLVER } from "../lib/generation-history.mjs";
import { createSqliteAssetStore, sqliteDatabasePath } from "../lib/sqlite-asset-store.mjs";
import { ingestWebCapture } from "../lib/web-capture-ingest.js";

const extensionRoot = new URL("../extensions/chatgpt-web-capture/", import.meta.url);
const providerPolicySource = await readFile(new URL("provider-policy.js", extensionRoot), "utf8");
const providerLovartSource = await readFile(new URL("provider-lovart.js", extensionRoot), "utf8");

const realtimeCanvasRef = JSON.parse(await readFile(new URL("fixtures/lovart-realtime-canvas-ref.json", import.meta.url), "utf8"));
const historyCanvasRef = JSON.parse(await readFile(new URL("fixtures/lovart-history-canvas-ref.json", import.meta.url), "utf8"));
const realtime457 = JSON.parse(await readFile(new URL("fixtures/lovart-realtime-new.json", import.meta.url), "utf8"));
const history457 = JSON.parse(await readFile(new URL("fixtures/lovart-history-new.json", import.meta.url), "utf8"));

const cloneFixture = (value) => JSON.parse(JSON.stringify(value));

function createProviderSandbox() {
  const sandbox = {
    URL,
    location: { href: "https://www.lovart.ai/canvas?projectId=x", origin: "https://www.lovart.ai" },
  };
  vm.runInNewContext(providerPolicySource, sandbox, { filename: "provider-policy.js" });
  vm.runInNewContext(providerLovartSource, sandbox, { filename: "provider-lovart.js" });
  return sandbox.MosaLovartCapture;
}

const lovart = createProviderSandbox();

async function flushPageMicrotasks() {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function fakePageClock(startMs = Date.parse("2026-11-26T12:00:00Z")) {
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

function lovartPage({ storage = {}, respond, startMs } = {}) {
  const clock = fakePageClock(startMs);
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
    capturedAt: extPayload.capturedAt || "2026-11-26T12:00:00.000Z",
    ...overrides,
  };
  if ("referenceProviderAssetIds" in extPayload && !("reference_provider_asset_ids" in overrides)) {
    base.reference_provider_asset_ids = extPayload.referenceProviderAssetIds;
  }
  return base;
}

// ---- Test 1: full-sequence replay of lovart-realtime-canvas-ref.json ----

test("1. realtime canvas-ref replay: ack/fetch frames do not wipe image-mode base image or agent user words", async (t) => {
  const page = lovartPage({ storage: { lovartAutoCaptureBaselineAtV1: Date.parse("2026-11-01T00:00:00Z") } });
  for (const entry of realtimeCanvasRef.frames) {
    await page.deliver("lovart-ws-message", JSON.stringify(entry.frame));
  }

  const ingests = page.ingests();
  const byId = Object.fromEntries(page.mediaCaptures().map((m) => [m.payload.providerAssetId, m.payload]));

  await t.test("Fake04 image-mode payload and reference order", () => {
    const fake04 = byId.Fake04ArtifactId;
    assert.ok(fake04, "Fake04 image-mode output captured");
    assert.deepEqual([...fake04.referenceProviderAssetIds], ["ref:Fake02ArtifactId"]);
    assert.equal(fake04.prompt, "保持人物、服装和构图不变，把场景改成雪夜。");
    assert.equal(fake04.userMessage, "保持人物、服装和构图不变，把场景改成雪夜。");
    assert.equal(fake04.model, "vertex/nano-banana-2-1");

    const fake04MediaIdx = ingests.findIndex((m) => !m.payload.isReference && m.payload.providerAssetId === "Fake04ArtifactId");
    const fake04RefIdx = ingests.findIndex((m) => m.payload.isReference
      && m.payload.providerAssetId === "ref:Fake02ArtifactId"
      && m.payload.generationContextId === fake04.generationContextId);
    assert.ok(fake04RefIdx >= 0, "Fake04 reference ingest sent");
    assert.ok(fake04RefIdx < fake04MediaIdx, "Fake04 reference ingest precedes Fake04 media ingest");
  });

  await t.test("Fake05 agent payload keeps cleaned userMessage across ack/fetch", () => {
    const fake05 = byId.Fake05ArtifactId;
    assert.ok(fake05, "Fake05 agent output captured");
    assert.deepEqual([...fake05.referenceProviderAssetIds], ["ref:Fake02ArtifactId"]);
    assert.equal(fake05.userMessage, "保持人物和构图不变，把背景改成黄昏的海边，只出一张图。");
  });

  await t.test("Fake04 client generator params survive ack/fetch even without server generator_start images", async () => {
    const withoutServerStartImages = cloneFixture(realtimeCanvasRef);
    for (const entry of withoutServerStartImages.frames) {
      const block = entry.frame?.data?.data?.content_block;
      if (block?.type === "generator_event" && Array.isArray(block.content)) {
        for (const item of block.content) {
          if (item?.event_type === "generator_start" && item?.event_data?.input_args) {
            delete item.event_data.input_args.image;
            if (item.event_data.input_args.original_unit_data) {
              delete item.event_data.input_args.original_unit_data.image;
            }
          }
        }
      }
    }
    const clientOnlyPage = lovartPage({ storage: { lovartAutoCaptureBaselineAtV1: Date.parse("2026-11-01T00:00:00Z") } });
    for (const entry of withoutServerStartImages.frames) {
      await clientOnlyPage.deliver("lovart-ws-message", JSON.stringify(entry.frame));
    }
    const fake04ClientOnly = clientOnlyPage.mediaCaptures().find((m) => m.payload.providerAssetId === "Fake04ArtifactId")?.payload;
    assert.ok(fake04ClientOnly, "Fake04 captured when server generator_start carries no image fields");
    assert.deepEqual([...fake04ClientOnly.referenceProviderAssetIds], ["ref:Fake02ArtifactId"]);
  });
});

// ---- Test 2: missing client chat-canda-generator frame falls back to server generator_start ----

test("2. missing client chat-canda-generator frame: server generator_start still supplies Fake04 base image", async () => {
  const withoutClientGen = cloneFixture(realtimeCanvasRef);
  withoutClientGen.frames = withoutClientGen.frames.filter((entry) => entry.frame?.type !== "chat-canda-generator");

  const page = lovartPage({ storage: { lovartAutoCaptureBaselineAtV1: Date.parse("2026-11-01T00:00:00Z") } });
  for (const entry of withoutClientGen.frames) {
    await page.deliver("lovart-ws-message", JSON.stringify(entry.frame));
  }

  const fake04 = page.mediaCaptures().find((m) => m.payload.providerAssetId === "Fake04ArtifactId")?.payload;
  assert.ok(fake04, "Fake04 captured without client generator frame");
  assert.deepEqual([...fake04.referenceProviderAssetIds], ["ref:Fake02ArtifactId"]);
  assert.equal(fake04.prompt, "保持人物、服装和构图不变，把场景改成雪夜。");
  assert.equal(fake04.model, "vertex/nano-banana-2-1");

  // Fallback key to thread_id when content_block.id is absent, and cleanup after use.
  const withoutBlockId = cloneFixture(withoutClientGen);
  for (const entry of withoutBlockId.frames) {
    const block = entry.frame?.data?.data?.content_block;
    if (block?.type === "generator_event") delete block.id;
  }
  const state = lovart.createFrameState();
  const records = [];
  for (const entry of withoutBlockId.frames) {
    const frame = entry.frame;
    if (frame.type === "chat-canda" || frame.type === "chat-canda-generator") {
      lovart.learnClientFrame(frame, state);
    } else {
      records.push(...lovart.recordsFromServerFrame(frame, state, Date.parse("2026-11-26T12:00:00Z")));
    }
  }
  const fake04NoId = records.find((record) => record.providerAssetId === "Fake04ArtifactId");
  assert.ok(fake04NoId);
  assert.deepEqual(Array.from(fake04NoId.referenceUrls, (url) => lovart.referenceIdForUrl(url)), ["ref:Fake02ArtifactId"]);
  assert.equal(state.pendingGeneratorReferences.size, 0, "pendingGeneratorReferences cleaned up after artifacts arrive");
});

// ---- Test 3: agent artifact & tool_use stripped of base image -> client chat-canda type=image fallback ----

test("3. agent without artifact prompt_image_list or tool_use refs still gets Fake05 base image from client type=image part", async () => {
  const stripped = cloneFixture(realtimeCanvasRef);
  for (const entry of stripped.frames) {
    const block = entry.frame?.data?.data?.content_block;
    if (block?.type === "tool_use" && block.input) {
      delete block.input.reference_image_urls;
    }
    if (block?.type === "tool_event" && Array.isArray(block.content)) {
      for (const item of block.content) {
        if (item?.event_type === "tool_artifacts" && Array.isArray(item.event_data?.artifact)) {
          for (const artifact of item.event_data.artifact) {
            if (artifact.artifact_id === "Fake05ArtifactId") {
              delete artifact.prompt_image_list;
              if (artifact.input_args) delete artifact.input_args.reference_image_urls;
            }
          }
        }
      }
    }
  }

  const page = lovartPage({ storage: { lovartAutoCaptureBaselineAtV1: Date.parse("2026-11-01T00:00:00Z") } });
  for (const entry of stripped.frames) {
    await page.deliver("lovart-ws-message", JSON.stringify(entry.frame));
  }

  const fake05 = page.mediaCaptures().find((m) => m.payload.providerAssetId === "Fake05ArtifactId")?.payload;
  assert.ok(fake05, "Fake05 captured after stripping server reference fields");
  assert.deepEqual([...fake05.referenceProviderAssetIds], ["ref:Fake02ArtifactId"]);
  assert.equal(fake05.userMessage, "保持人物和构图不变，把背景改成黄昏的海边，只出一张图。");
});

// ---- Test 4: a real new start frame still overwrites pendingUsers (one running task per thread assumption) ----

test("4. new real start frame overwrites pendingUsers in same thread (existing single-task-per-thread assumption)", async () => {
  // Frames are picked by content, not position: the fixture keeps the real
  // order, including the repeated generator_start blocks.
  const frames = realtimeCanvasRef.frames.map((entry) => entry.frame);
  const blockEvent = (frame) => frame?.data?.data?.content_block?.content?.[0];
  const genStartClient = cloneFixture(frames.find((frame) => frame.type === "chat-canda-generator" && frame.data?.event === "start"));
  const genStartServer = cloneFixture(frames.find((frame) => blockEvent(frame)?.event_type === "generator_start"
    && Array.isArray(blockEvent(frame)?.event_data?.input_args?.image)));
  const agentStartClient = cloneFixture(frames.find((frame) => frame.type === "chat-canda" && frame.data?.event === "start"));
  const genArtifactsServer = cloneFixture(frames.find((frame) => blockEvent(frame)?.event_type === "generator_artifacts"));

  // With server generator_start present: client generator params were overwritten
  // by the agent start frame, so Fake04 keeps ref:Fake02ArtifactId only via
  // server generator_start and userMessage falls back to the server prompt.
  const page = lovartPage({ storage: { lovartAutoCaptureBaselineAtV1: Date.parse("2026-11-01T00:00:00Z") } });
  for (const frame of [genStartClient, genStartServer, agentStartClient, genArtifactsServer]) {
    await page.deliver("lovart-ws-message", JSON.stringify(frame));
  }
  const fake04 = page.mediaCaptures().find((m) => m.payload.providerAssetId === "Fake04ArtifactId")?.payload;
  assert.ok(fake04, "Fake04 captured");
  assert.deepEqual(
    [...fake04.referenceProviderAssetIds],
    ["ref:Fake02ArtifactId"],
    "一个对话同时只有一个任务：新 start 帧覆盖客户端参数后，底图只剩服务端 generator_start 那份",
  );
  assert.equal(
    fake04.userMessage,
    "保持人物、服装和构图不变，把场景改成雪夜。",
    "一个对话同时只有一个任务：客户端参数被新 start 帧覆盖后，userMessage 回落到服务端 generator_start 提示词",
  );

  // Confirm directly via frame state that the second real start frame cleared
  // the earlier image-mode client generatorParams.
  const state = lovart.createFrameState();
  lovart.learnClientFrame(genStartClient, state);
  assert.ok(state.pendingUsers.get("00000000-0000-4000-8000-000000000001")?.generatorParams);
  lovart.learnClientFrame(agentStartClient, state);
  assert.equal(
    state.pendingUsers.get("00000000-0000-4000-8000-000000000001")?.generatorParams,
    null,
    "一个对话同时只有一个任务：同一对话的新一轮 Agent start 帧照旧覆盖先前的图像模式客户端参数",
  );
});

// ---- Test 5: history canvas-ref fixture & manual right-click save ----

test("5. history canvas-ref fixture: Fake06 learns ref:Fake02ArtifactId and right-click save sends ref before media", async () => {
  const { records } = lovart.extractLovartHistory(JSON.stringify(historyCanvasRef));
  assert.equal(records.length, 1);
  assert.equal(records[0].providerAssetId, "Fake06ArtifactId");
  assert.deepEqual(
    Array.from(records[0].referenceUrls, (url) => lovart.referenceIdForUrl(url)),
    ["ref:Fake02ArtifactId"],
  );

  // Baseline after the sample (2026-11-26T15:53:28Z): no auto-capture, manual right-click saves with reference.
  const page = lovartPage({
    storage: { lovartAutoCaptureBaselineAtV1: Date.parse("2026-11-27T00:00:00Z") },
    startMs: Date.parse("2026-11-27T01:00:00Z"),
  });
  await page.deliver("lovart-api-response", JSON.stringify(historyCanvasRef));
  assert.equal(page.ingests().length, 0, "Fake06 predates baseline so it must not auto-capture");

  const response = await dispatchPageMessage(page, {
    type: "mosa.capture.saveImageWithPrompt",
    imageUrl: "https://a.lovart.ai/artifacts/generator/Fake06ArtifactId.png?x-oss-process=image/resize,w_200",
  });
  assert.equal(response?.ok, true);

  const ingests = page.ingests();
  const refIdx = ingests.findIndex((m) => m.payload.isReference && m.payload.providerAssetId === "ref:Fake02ArtifactId");
  const mediaIdx = ingests.findIndex((m) => !m.payload.isReference && m.payload.providerAssetId === "Fake06ArtifactId");
  assert.ok(refIdx >= 0 && mediaIdx > refIdx, "reference ingest must be sent before Fake06 manual media ingest");

  const manual = ingests[mediaIdx].payload;
  assert.equal(manual.captureMode, "manual");
  assert.equal(manual.providerAssetId, "Fake06ArtifactId");
  assert.deepEqual([...manual.referenceProviderAssetIds], ["ref:Fake02ArtifactId"]);
  assert.equal(manual.model, "seedream/seedream-5-5");
  assert.equal(manual.prompt, "保持人物、头冠和长枪不变，构图不变，把场景改成月夜。");
  assert.equal(manual.imageUrl, "https://a.lovart.ai/artifacts/generator/Fake06ArtifactId.png");
});

// ---- Test 6: 457 realtime sample non-regression ----

test("6. 457 realtime sample non-regression: Fake02 and Fake03 referenceProviderAssetIds and userMessage unchanged", async () => {
  const page = lovartPage({ storage: { lovartAutoCaptureBaselineAtV1: Date.parse("2026-11-01T00:00:00Z") } });
  for (const entry of realtime457.frames) {
    await page.deliver("lovart-ws-message", JSON.stringify(entry.frame));
  }
  const byId = Object.fromEntries(page.mediaCaptures().map((m) => [m.payload.providerAssetId, m.payload]));

  assert.ok(byId.Fake02ArtifactId);
  assert.deepEqual([...byId.Fake02ArtifactId.referenceProviderAssetIds], ["ref:Fake01ArtifactId"]);
  assert.equal(byId.Fake02ArtifactId.userMessage, "「sword hilt」把剑换成金色长枪，其他不变");

  assert.ok(byId.Fake03ArtifactId);
  assert.deepEqual([...byId.Fake03ArtifactId.referenceProviderAssetIds], []);
  assert.equal(byId.Fake03ArtifactId.userMessage, "一只橘猫坐在窗台上，水彩风格");
});

// ---- Test 7: Full chain (SQLite + ingestWebCapture) in 11-26 real order ----

test("7. full chain (SQLite + ingestWebCapture): 7a Fake04->Fake02, 7b Fake05->Fake02, 7c legacy Fake06 backfill", async (t) => {
  // Produce real extension payloads from Test 1 (realtime canvas-ref), Test 5
  // (history canvas-ref manual save), and 457 history (manual save of Fake02).
  const rtPage = lovartPage({ storage: { lovartAutoCaptureBaselineAtV1: Date.parse("2026-11-01T00:00:00Z") } });
  for (const entry of realtimeCanvasRef.frames) {
    await rtPage.deliver("lovart-ws-message", JSON.stringify(entry.frame));
  }
  const fake04Media = rtPage.mediaCaptures().find((m) => m.payload.providerAssetId === "Fake04ArtifactId")?.payload;
  const fake05Media = rtPage.mediaCaptures().find((m) => m.payload.providerAssetId === "Fake05ArtifactId")?.payload;
  const fake04Ref = rtPage.referenceCaptures().find((m) => m.payload.providerAssetId === "ref:Fake02ArtifactId"
    && m.payload.generationContextId === fake04Media?.generationContextId)?.payload;
  const fake05Ref = rtPage.referenceCaptures().find((m) => m.payload.providerAssetId === "ref:Fake02ArtifactId"
    && m.payload.generationContextId === fake05Media?.generationContextId)?.payload;
  assert.ok(fake04Media && fake04Ref && fake05Media && fake05Ref);

  const hist457Page = lovartPage({
    storage: { lovartAutoCaptureBaselineAtV1: Date.parse("2026-11-27T00:00:00Z") },
    startMs: Date.parse("2026-11-27T01:00:00Z"),
  });
  await hist457Page.deliver("lovart-api-response", JSON.stringify(history457));
  const fake02ManualResp = await dispatchPageMessage(hist457Page, {
    type: "mosa.capture.saveImageWithPrompt",
    imageUrl: "https://a.lovart.ai/artifacts/agent/Fake02ArtifactId.png",
  });
  assert.equal(fake02ManualResp?.ok, true);
  const fake02Manual = hist457Page.mediaCaptures().find((m) => m.payload.providerAssetId === "Fake02ArtifactId")?.payload;
  assert.ok(fake02Manual && fake02Manual.captureMode === "manual");

  const histCanvasPage = lovartPage({
    storage: { lovartAutoCaptureBaselineAtV1: Date.parse("2026-11-27T00:00:00Z") },
    startMs: Date.parse("2026-11-27T01:00:00Z"),
  });
  await histCanvasPage.deliver("lovart-api-response", JSON.stringify(historyCanvasRef));
  const fake06ManualResp = await dispatchPageMessage(histCanvasPage, {
    type: "mosa.capture.saveImageWithPrompt",
    imageUrl: "https://a.lovart.ai/artifacts/generator/Fake06ArtifactId.png",
  });
  assert.equal(fake06ManualResp?.ok, true);
  const fake06ManualRef = histCanvasPage.referenceCaptures().find((m) => m.payload.providerAssetId === "ref:Fake02ArtifactId")?.payload;
  const fake06ManualMedia = histCanvasPage.mediaCaptures().find((m) => m.payload.providerAssetId === "Fake06ArtifactId")?.payload;
  assert.ok(fake06ManualRef && fake06ManualMedia);

  const imgFake02 = await noiseImage(102);
  const imgFake04 = await noiseImage(104);
  const imgFake05 = await noiseImage(105);
  const imgFake06 = await noiseImage(106);

  async function makeEnv(suffix) {
    const root = await mkdtemp(join(tmpdir(), `mosa-lovart-canvas-ref-${suffix}-`));
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
    const queryRelations = () => {
      const db = new Database(sqliteDatabasePath(libraryDir), { readonly: true });
      try {
        return db.prepare(
          "SELECT child_generation_id, parent_generation_id, relation_type, verification_level, evidence_json FROM generation_relations ORDER BY created_at, child_generation_id, parent_generation_id",
        ).all();
      } finally {
        db.close();
      }
    };
    t.after(() => { store.close(); });
    return { store, tempRoot, queryRelations };
  }

  // 7a + 7b: Fake04 (with ref) auto-captured -> 0; Fake02 manual save -> Fake04->Fake02; then Fake05 -> Fake05->Fake02
  {
    const { store, tempRoot, queryRelations } = await makeEnv("7ab");

    await ingestWebCapture({ store, tempRoot, input: toAppPayload(fake04Ref, imgFake02) });
    const r04 = await ingestWebCapture({ store, tempRoot, input: toAppPayload(fake04Media, imgFake04) });
    assert.equal(queryRelations().length, 0, "7a before Fake02 arrives: 0 relations");

    const r02 = await ingestWebCapture({ store, tempRoot, input: toAppPayload(fake02Manual, imgFake02) });
    const rows7a = queryRelations();
    t.diagnostic(`7a generation_relations: ${JSON.stringify(rows7a)}`);
    assert.equal(rows7a.length, 1);
    const h04 = await store.getAssetGenerationHistory("default", r04.asset.id);
    const h02 = await store.getAssetGenerationHistory("default", r02.asset.id);
    const ev04 = h04.events.find((e) => e.output_asset_id === r04.asset.id);
    const ev02 = h02.events.find((e) => e.output_asset_id === r02.asset.id);
    assert.ok(ev04 && ev02);
    assert.equal(rows7a[0].child_generation_id, ev04.id);
    assert.equal(rows7a[0].parent_generation_id, ev02.id);
    assert.equal(rows7a[0].relation_type, "edited_from");
    assert.equal(rows7a[0].verification_level, "observed");
    assert.equal(JSON.parse(rows7a[0].evidence_json).resolver, LOVART_BASE_IMAGE_RESOLVER);

    // 7b: ingest Fake05 (with its reference) -> Fake05 -> Fake02
    await ingestWebCapture({ store, tempRoot, input: toAppPayload(fake05Ref, imgFake02) });
    const r05 = await ingestWebCapture({ store, tempRoot, input: toAppPayload(fake05Media, imgFake05) });
    const rows7b = queryRelations();
    t.diagnostic(`7b generation_relations: ${JSON.stringify(rows7b)}`);
    assert.equal(rows7b.length, 2);
    const h05 = await store.getAssetGenerationHistory("default", r05.asset.id);
    const ev05 = h05.events.find((e) => e.output_asset_id === r05.asset.id);
    assert.ok(ev05);
    const rel05 = rows7b.find((row) => row.child_generation_id === ev05.id && row.parent_generation_id === ev02.id);
    assert.ok(rel05, "7b Fake05 -> Fake02 relation created");
    assert.equal(rel05.relation_type, "edited_from");
    assert.equal(rel05.verification_level, "observed");
    assert.equal(JSON.parse(rel05.evidence_json).resolver, LOVART_BASE_IMAGE_RESOLVER);
  }

  // 7c: legacy Fake06 (no referenceProviderAssetIds, no ref ingest, references=[]) + Fake02 -> 0;
  // re-capturing Fake06 via Test 5 right-click save updates generation references and links Fake06 -> Fake02.
  {
    const { store, tempRoot, queryRelations } = await makeEnv("7c");

    const legacyFake06Payload = toAppPayload(fake06ManualMedia, imgFake06, { captureMode: "automatic" });
    delete legacyFake06Payload.reference_provider_asset_ids;

    const r06Old = await ingestWebCapture({ store, tempRoot, input: legacyFake06Payload });
    const r02 = await ingestWebCapture({ store, tempRoot, input: toAppPayload(fake02Manual, imgFake02) });
    const h06Old = await store.getAssetGenerationHistory("default", r06Old.asset.id);
    const ev06Old = h06Old.events.find((e) => e.output_asset_id === r06Old.asset.id);
    assert.ok(ev06Old);
    assert.deepEqual(ev06Old.references, [], "7c initial legacy Fake06 event has references: []");
    assert.equal(queryRelations().length, 0, "7c before re-capture: 0 relations");

    // Re-capture Fake06 using Test 5's manual right-click save (reference first, then media)
    await ingestWebCapture({ store, tempRoot, input: toAppPayload(fake06ManualRef, imgFake02) });
    await ingestWebCapture({ store, tempRoot, input: toAppPayload(fake06ManualMedia, imgFake06) });

    const h06New = await store.getAssetGenerationHistory("default", r06Old.asset.id);
    const ev06New = h06New.events.find((e) => e.output_asset_id === r06Old.asset.id);
    const ev02 = h06New.events.find((e) => e.output_asset_id === r02.asset.id);
    assert.ok(ev06New && ev02);
    assert.ok(
      ev06New.references.some((ref) => ref.provider_asset_id === "ref:Fake02ArtifactId"),
      "7c Fake06 generation event references updated with ref:Fake02ArtifactId",
    );
    const rows7c = queryRelations();
    t.diagnostic(`7c generation_relations: ${JSON.stringify(rows7c)}`);
    assert.equal(rows7c.length, 1);
    assert.equal(rows7c[0].child_generation_id, ev06New.id);
    assert.equal(rows7c[0].parent_generation_id, ev02.id);
    assert.equal(rows7c[0].relation_type, "edited_from");
    assert.equal(rows7c[0].verification_level, "observed");
    assert.equal(JSON.parse(rows7c[0].evidence_json).resolver, LOVART_BASE_IMAGE_RESOLVER);
  }
});
