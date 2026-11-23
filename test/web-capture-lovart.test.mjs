import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import sharp from "sharp";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { ingestWebCapture } from "../lib/web-capture-ingest.js";
import { generationSessionKey } from "../lib/generation-session.mjs";
import { sourceSearchDisplayName } from "../lib/asset-search-scope.mjs";
import {
  createBackgroundHarness,
  senderFor,
  fakeImageBase64,
  JIMENG_TAB_URL,
} from "./helpers/background-harness.mjs";

const extensionRoot = new URL("../extensions/chatgpt-web-capture/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", extensionRoot), "utf8"));
const providerPolicySource = await readFile(new URL("provider-policy.js", extensionRoot), "utf8");
const providerLovartSource = await readFile(new URL("provider-lovart.js", extensionRoot), "utf8");
const lovartHookSource = await readFile(new URL("lovart-page-hook.js", extensionRoot), "utf8");

// Fixtures copy the 2026-11-22 read-only real-page samples' field layout;
// accounts, projects and image ids are Fake… placeholders, long prompts are
// truncated exactly as in the samples.
const historyNew = JSON.parse(await readFile(new URL("fixtures/lovart-history-new.json", import.meta.url), "utf8"));
const realtimeNew = JSON.parse(await readFile(new URL("fixtures/lovart-realtime-new.json", import.meta.url), "utf8"));
const historyOld = JSON.parse(await readFile(new URL("fixtures/lovart-history-old.json", import.meta.url), "utf8"));

function createProviderSandbox(source, filename, overrides = {}) {
  const sandbox = {
    URL,
    location: { href: "https://www.lovart.ai/canvas?projectId=x", origin: "https://www.lovart.ai" },
    ...overrides,
  };
  vm.runInNewContext(providerPolicySource, sandbox, { filename: "provider-policy.js" });
  vm.runInNewContext(source, sandbox, { filename });
  return sandbox;
}

const lovart = createProviderSandbox(providerLovartSource, "provider-lovart.js").MosaLovartCapture;

// ---- Review 294-style page clock: timers and Date share one fake clock so a
// test can run the 300 ms scan debounce without waiting.

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
    // Hands the page the hook's message port, then one hook message (a
    // history response text or one WebSocket frame string).
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

test("manifest declares the Lovart site, its media hosts, and image-only hooks", () => {
  for (const host of [
    "https://www.lovart.ai/*",
    "https://a.lovart.ai/*",
    "https://assets-persist.lovart.ai/*",
  ]) assert.ok(manifest.host_permissions.includes(host), `missing ${host}`);

  const hook = manifest.content_scripts.find((entry) => entry.js?.includes("lovart-page-hook.js"));
  assert.deepEqual(hook?.matches, ["https://www.lovart.ai/*"]);
  assert.equal(hook?.world, "MAIN");
  assert.equal(hook?.run_at, "document_start", "the fetch wrapper must be installed before the page's request client loads");
  const provider = manifest.content_scripts.find((entry) => entry.js?.includes("provider-lovart.js"));
  assert.deepEqual(provider?.js, ["provider-policy.js", "provider-lovart.js"]);
  assert.deepEqual(provider?.matches, ["https://www.lovart.ai/*"]);
  assert.equal(provider?.run_at, "document_idle");
  assert.equal(provider?.world, undefined, "the Lovart adapter must stay in the isolated world");
});

test("provider policy recognizes Lovart pages but no Lovart video support", () => {
  const sandbox = { URL };
  vm.runInNewContext(providerPolicySource, sandbox, { filename: "provider-policy.js" });
  const policy = sandbox.MosaProviderPolicy;
  assert.equal(policy.providerForPageUrl("https://www.lovart.ai/canvas?projectId=x"), "lovart");
  assert.equal(policy.providerForPageUrl("https://www.lovart.ai/"), "lovart");
  assert.equal(policy.providerForPageUrl("https://lovart.ai/canvas"), "", "only the exact www host counts");
  assert.equal(policy.providerForPageUrl("https://www.lovart.ai.evil.com/"), "");
  assert.equal(policy.supportsVideo("lovart"), false, "this version captures Lovart images only");
});

// ---- Test 1: new-UI history sample, baseline earlier than every image.

test("new-UI history sample: exactly three outputs with prompt, user words, model and references", async () => {
  const page = lovartPage({ storage: { lovartAutoCaptureBaselineAtV1: Date.parse("2026-11-01T00:00:00Z") } });
  await page.deliver("lovart-api-response", JSON.stringify(historyNew));

  const media = page.mediaCaptures();
  assert.equal(media.length, 3, JSON.stringify(media.map((message) => message.payload.providerAssetId)));
  const byId = Object.fromEntries(media.map((message) => [message.payload.providerAssetId, message.payload]));

  const fake01 = byId.Fake01ArtifactId;
  assert.ok(fake01, "Seedream image-mode output captured");
  assert.equal(fake01.model, "seedream/seedream-5-5");
  assert.match(fake01.prompt, /^A breathtaking young woman warrior goddess/);
  assert.equal(fake01.promptStatus, "generation-tool-prompt");
  assert.equal(fake01.promptSource, "lovart-generator-prompt");

  const fake02 = byId.Fake02ArtifactId;
  assert.ok(fake02, "agent edit output captured");
  assert.equal(fake02.model, "generate_image_gpt_image_2_5_sunburst");
  assert.match(fake02.prompt, /^Replace only the sword/);
  assert.equal(fake02.promptStatus, "generation-tool-prompt");
  assert.equal(fake02.promptSource, "lovart-agent-prompt");
  assert.equal(fake02.userMessage, "「sword hilt」把剑换成金色长枪，其他不变");

  const fake03 = byId.Fake03ArtifactId;
  assert.ok(fake03, "Nano Banana image-mode output captured");
  assert.equal(fake03.model, "vertex/nano-banana-2-1");
  assert.equal(fake03.prompt, "一只橘猫坐在窗台上，水彩风格");
  assert.equal(fake03.userMessage, "一只橘猫坐在窗台上，水彩风格");
  assert.equal(fake03.width, 1024);
  assert.equal(fake03.height, 1024);

  for (const payload of [fake01, fake02, fake03]) {
    assert.equal(payload.conversationId, "00000000-0000-4000-8000-000000000001");
    assert.equal(payload.provider, "lovart");
  }

  const refs = page.referenceCaptures();
  assert.equal(refs.length, 1);
  assert.equal(refs[0].payload.providerAssetId, "ref:Fake01ArtifactId", "Fake02's base image is attached as ref:<base image id>");
  assert.equal(refs[0].payload.isReference, true);
});

// ---- Test 2: baseline on 2026-11-22 keeps the older image manual-only, and
// the right-click save on a resized thumbnail URL still carries prompt+model.

test("baseline on 2026-11-22: only the two fresh images auto-capture; the old one saves manually with metadata", async () => {
  const page = lovartPage({ storage: { lovartAutoCaptureBaselineAtV1: Date.parse("2026-11-22T00:00:00Z") } });
  await page.deliver("lovart-api-response", JSON.stringify(historyNew));

  const media = page.mediaCaptures();
  assert.deepEqual(
    media.map((message) => message.payload.providerAssetId).sort(),
    ["Fake02ArtifactId", "Fake03ArtifactId"],
    "Fake01 was created before the baseline and must stay manual-save only",
  );
  assert.ok(page.localStore.get("lovartAutoCaptureBaselineAtV1"), "baseline persisted");

  const response = await dispatchPageMessage(page, {
    type: "mosa.capture.saveImageWithPrompt",
    imageUrl: "https://a.lovart.ai/artifacts/generator/Fake01ArtifactId.png?x-oss-process=image/resize,w_200",
  });
  assert.equal(response?.ok, true);
  const manual = page.mediaCaptures().find((message) => message.payload.captureMode === "manual");
  assert.ok(manual, "the manual save was handed to the background");
  assert.equal(manual.payload.providerAssetId, "Fake01ArtifactId");
  assert.match(manual.payload.prompt, /^A breathtaking young woman warrior goddess/);
  assert.equal(manual.payload.model, "seedream/seedream-5-5");
  assert.equal(manual.payload.promptSource, "lovart-generator-prompt");
  assert.equal(
    manual.payload.imageUrl,
    "https://a.lovart.ai/artifacts/generator/Fake01ArtifactId.png",
    "the learned full-size URL wins over the resized thumbnail URL",
  );
});

// ---- Test 3: realtime frames produce Fake02/Fake03 with cross-frame
// pairing; a later history feed must not re-send them.

test("realtime frames: user words from the sent frame, prompt from the result frame; history never duplicates", async () => {
  const page = lovartPage({ storage: { lovartAutoCaptureBaselineAtV1: Date.parse("2026-11-01T00:00:00Z") } });
  const frames = realtimeNew.frames.map((entry) => JSON.stringify(entry.frame));

  // client chat-canda, create_chat_status, skill_file, tool_use, tool_stage:
  // nothing is ingestable yet.
  for (const frame of frames.slice(0, 5)) {
    await page.deliver("lovart-ws-message", frame);
  }
  assert.equal(page.ingests().length, 0, "guidance reads, cost estimates and chat start produce no records");

  await page.deliver("lovart-ws-message", frames[5]);
  assert.equal(page.mediaCaptures().length, 1);
  const fake02 = page.mediaCaptures()[0].payload;
  assert.equal(fake02.providerAssetId, "Fake02ArtifactId");
  assert.match(fake02.prompt, /^Replace only the sword/);
  assert.equal(fake02.userMessage, "「sword hilt」把剑换成金色长枪，其他不变");
  assert.equal(fake02.model, "generate_image_gpt_image_2_5_sunburst");
  assert.equal(fake02.promptSource, "lovart-agent-prompt");

  for (const frame of frames.slice(6, 9)) {
    await page.deliver("lovart-ws-message", frame);
  }
  assert.equal(page.mediaCaptures().length, 2);
  const fake03 = page.mediaCaptures()[1].payload;
  assert.equal(fake03.providerAssetId, "Fake03ArtifactId");
  assert.equal(fake03.prompt, "一只橘猫坐在窗台上，水彩风格");
  assert.equal(fake03.userMessage, "一只橘猫坐在窗台上，水彩风格");
  assert.equal(fake03.model, "vertex/nano-banana-2-1");

  const before = page.ingests().length;
  await page.deliver("lovart-api-response", JSON.stringify(historyNew));
  // Fake02/Fake03 were already captured via the socket, so only Fake01 —
  // fresh by its timestamp and never seen — may join from the history feed.
  const after = page.ingests();
  assert.equal(after.length, before + 1, "only the never-seen Fake01 joins from history");
  assert.deepEqual(
    after.map((message) => message.payload.providerAssetId).slice(before),
    ["Fake01ArtifactId"],
    "the realtime-captured images must not re-send from history",
  );
});

// ---- Test 4: legacy-UI sample (page-memory sessions shape).

test("legacy-UI sessions sample: per-session user words, artifact-owned references, skips analyse/error", () => {
  const { records } = lovart.extractLovartHistory(JSON.stringify(historyOld));
  assert.equal(records.length, 3, "analyse_image and the error entry produce nothing");
  const byId = Object.fromEntries(records.map((record) => [record.providerAssetId, record]));

  const first = byId.FakeAgentArt0001;
  assert.ok(first);
  assert.equal(first.model, "generate_image_nano_banana_pro");
  assert.match(first.prompt, /^Edit the portrait image to fix and improve the nose area/);
  assert.equal(first.userMessage, "修复鼻子的变形");
  assert.deepEqual(Array.from(first.referenceUrls, (url) => lovart.referenceIdForUrl(url)), ["ref:FakeUpload01Ab2c"]);
  assert.equal(first.conversationId, "00000000-0000-4000-8000-0000000000aa");

  const second = byId.FakeAgentArt0002;
  assert.ok(second);
  assert.deepEqual(Array.from(second.referenceUrls, (url) => lovart.referenceIdForUrl(url)), ["ref:FakeAgentArt0001"]);
  assert.equal(second.userMessage, "鼻子的皮肤过于写实了");

  const third = byId.FakeAgentArt0003;
  assert.ok(third);
  assert.equal(third.referenceUrls.length, 0, "a TEXT_TO_IMAGE record has no base image");
  assert.equal(third.userMessage, "根据这张图的风格和人物形态，生成几种不同人物性别的图片");
  assert.equal(third.model, "generate_image_nano_banana_pro");
});

// ---- 11-23 acceptance additions: the base-image rule follows the artifact's
// own task_type (not action-id coincidences), refresh never re-sends, and the
// media host check is an exact match.

test("legacy-UI: a TEXT_TO_IMAGE artifact never takes the chat upload as its base image, even when action ids match", () => {
  const consistent = JSON.parse(JSON.stringify(historyOld));
  // Real pages give every raw message its own session's action id; make the
  // fixture consistent so the rule cannot lean on a mismatch.
  const sessions = (function findSessions(node) {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node.sessions)) return node.sessions;
    for (const value of Object.values(node)) {
      const found = findSessions(value);
      if (found) return found;
    }
    return null;
  })(consistent);
  assert.ok(Array.isArray(sessions) && sessions.length >= 3, "fixture has legacy sessions");
  for (const session of sessions) {
    for (const message of session.messages || []) {
      if (message?.raw) message.raw.action_id = session.input.actionId;
    }
  }
  const { records } = lovart.extractLovartHistory(JSON.stringify(consistent));
  const byId = Object.fromEntries(records.map((record) => [record.providerAssetId, record]));
  assert.deepEqual(Array.from(byId.FakeAgentArt0001.referenceUrls, (url) => lovart.referenceIdForUrl(url)), ["ref:FakeUpload01Ab2c"],
    "an EDIT_SINGLE_IMAGE artifact keeps the uploaded portrait as its base");
  assert.deepEqual(Array.from(byId.FakeAgentArt0002.referenceUrls, (url) => lovart.referenceIdForUrl(url)), ["ref:FakeAgentArt0001"]);
  assert.equal(byId.FakeAgentArt0003.referenceUrls.length, 0,
    "TEXT_TO_IMAGE with a style upload in the chat has no base image");
});

test("a refreshed Lovart page never re-sends images it already handed over", async () => {
  const baseline = { lovartAutoCaptureBaselineAtV1: Date.parse("2026-11-01T00:00:00Z") };
  const first = lovartPage({ storage: baseline });
  await first.deliver("lovart-api-response", JSON.stringify(historyNew));
  assert.equal(first.mediaCaptures().length, 3);
  const persisted = first.localStore.get("lovartCapturedAssetIdsV1");
  assert.ok(Array.isArray(persisted) && persisted.length >= 3, `seen ids were persisted (${JSON.stringify(persisted)})`);

  const refreshed = lovartPage({ storage: { ...baseline, lovartCapturedAssetIdsV1: persisted } });
  await refreshed.deliver("lovart-api-response", JSON.stringify(historyNew));
  assert.equal(refreshed.mediaCaptures().length, 0, "the same history after a refresh sends nothing again");
});

test("Lovart media hosts are matched exactly, never by substring", () => {
  for (const host of ["a.lovart.ai", "assets-persist.lovart.ai", "A.LOVART.AI"]) {
    assert.equal(lovart.isLovartMediaHost(host), true, host);
  }
  for (const host of ["a.lovart.ai.evil.example", "evil-a.lovart.ai", "xa.lovart.ai", "lovart.ai", "www.lovart.ai", ""]) {
    assert.equal(lovart.isLovartMediaHost(host), false, host);
  }
  assert.equal(lovart.mediaUrlInfo("https://a.lovart.ai.evil.example/artifacts/generator/Fake01ArtifactId.png"), null);
  assert.ok(lovart.mediaUrlInfo("https://a.lovart.ai/artifacts/generator/Fake01ArtifactId.png"));
});

// ---- Test 5: the page hook forwards only the two history endpoints and the
// socket's text frames, never binary, other hosts, or the socket address.

async function flushHook() {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function createLovartHookSandbox() {
  const portMessages = [];
  const postedWindowMessages = [];
  const windowMessageHandlers = [];
  const sockets = [];
  const fetchCalls = [];
  const originalFetch = async (input, init) => {
    fetchCalls.push({ input: String(typeof input === "string" ? input : input?.url || ""), init });
    return {
      url: String(typeof input === "string" ? input : input?.url || ""),
      clone() {
        return { text: async () => JSON.stringify({ code: 0, data: [] }) };
      },
    };
  };
  class FakeXHR {
    constructor() {
      this.responseType = "";
      this.responseText = "";
      this.status = 200;
      this.__listeners = {};
    }

    open(_method, url) { this.__url = url; }

    send() {}

    addEventListener(type, fn) { (this.__listeners[type] ||= []).push(fn); }
  }
  class FakeWebSocket {
    constructor(url, protocols) {
      this.url = String(url);
      this.protocols = protocols;
      this.__listeners = {};
      this.sent = [];
      sockets.push(this);
    }

    addEventListener(type, fn) { (this.__listeners[type] ||= []).push(fn); }

    send(data) { this.sent.push(data); }
  }
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;
  const sandbox = {
    URL,
    location: { origin: "https://www.lovart.ai", href: "https://www.lovart.ai/canvas?projectId=x" },
    fetch: originalFetch,
    XMLHttpRequest: FakeXHR,
    WebSocket: FakeWebSocket,
    MessageChannel: function FakeChannel() {
      this.port1 = {
        postMessage: (message) => portMessages.push(message),
        addEventListener: () => {},
        start: () => {},
      };
      this.port2 = {};
    },
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = (type, fn) => {
    if (type === "message") windowMessageHandlers.push(fn);
  };
  sandbox.window.postMessage = (message, origin, transfer) => {
    postedWindowMessages.push({ message, origin, transfer });
  };
  vm.runInNewContext(lovartHookSource, sandbox, { filename: "lovart-page-hook.js" });
  return { sandbox, portMessages, postedWindowMessages, sockets, fetchCalls };
}

test("lovart page hook forwards both history responses (fetch and XHR) and nothing else", async () => {
  const { sandbox, portMessages, postedWindowMessages, fetchCalls } = createLovartHookSandbox();

  const requestInit = { method: "GET", credentials: "include" };
  await sandbox.window.fetch("https://lgw.lovart.ai/v1/canda/chat-history?thread_id=t1", requestInit);
  await sandbox.window.fetch("https://www.lovart.ai/api/canva/agent/chatHistoryV2?threadId=t2", requestInit);
  await sandbox.window.fetch("https://www.lovart.ai/api/www/lovart/member/account", requestInit);
  await sandbox.window.fetch("https://lgw.lovart.ai/v1/context/vision/click_region_suggest", requestInit);
  await flushHook();

  assert.equal(fetchCalls.length, 4, "the hook must not modify or re-issue the page requests");
  assert.equal(fetchCalls.every((call) => call.init === requestInit), true);
  const forwarded = portMessages.filter((message) => message.type === "lovart-api-response");
  assert.deepEqual(forwarded.map((message) => message.url), [
    "https://lgw.lovart.ai/v1/canda/chat-history",
    "https://www.lovart.ai/api/canva/agent/chatHistoryV2",
  ], "only the two history endpoints are observed, and the query string never travels");
  assert.equal(forwarded.every((message) => typeof message.text === "string" && message.text.length > 0), true);

  const xhr = new sandbox.XMLHttpRequest();
  xhr.responseText = JSON.stringify(historyOld);
  xhr.open("POST", "https://www.lovart.ai/api/canva/agent/chatHistoryV2?threadId=t3");
  xhr.send();
  for (const fn of xhr.__listeners.load || []) fn.call(xhr);
  await flushHook();
  const xhrForwarded = portMessages.filter((message) => message.type === "lovart-api-response");
  assert.equal(xhrForwarded.length, 3, "the legacy XHR response is observed too");
  assert.equal(xhrForwarded[2].url, "https://www.lovart.ai/api/canva/agent/chatHistoryV2");

  const other = new sandbox.XMLHttpRequest();
  other.responseText = "{}";
  other.open("POST", "https://www.lovart.ai/api/www/lovart/member/account");
  other.send();
  for (const fn of other.__listeners.load || []) fn.call(other);
  await flushHook();
  assert.equal(portMessages.filter((message) => message.type === "lovart-api-response").length, 3,
    "non-history XHR responses are not observed");

  // The port was offered via a transient window message.
  assert.equal(postedWindowMessages.length, 1);
  assert.equal(postedWindowMessages[0].message.source, "mosa-lovart-hook");
});

test("lovart page hook forwards only .lovart.ai socket text frames; the address never travels", () => {
  const { sandbox, portMessages, postedWindowMessages, sockets } = createLovartHookSandbox();

  const socket = new sandbox.WebSocket("wss://ws.lovart.ai/connect?token=SECRET");
  assert.equal(sockets.length, 1, "the page's own socket was constructed exactly once");

  // Server → client string frame is forwarded.
  for (const fn of socket.__listeners.message || []) fn({ data: '{"type":"chat","data":{}}' });
  assert.equal(portMessages.length, 1);
  assert.equal(portMessages[0].type, "lovart-ws-message");
  assert.equal(portMessages[0].text, '{"type":"chat","data":{}}');

  // Binary frames are not forwarded.
  const afterText = portMessages.length;
  for (const fn of socket.__listeners.message || []) fn({ data: new Uint8Array([1, 2, 3]) });
  assert.equal(portMessages.length, afterText, "binary frames stay unobserved");

  // The page's own chat command frames are forwarded without the signature
  // field; other sent message types are not forwarded.
  socket.send(JSON.stringify({ type: "chat-canda", signature: "SIG", data: { thread_id: "t" } }));
  socket.send(JSON.stringify({ type: "not-a-chat-command", signature: "SIG", data: {} }));
  const sentFrames = portMessages.slice(afterText);
  assert.equal(sentFrames.length, 1);
  const parsed = JSON.parse(sentFrames[0].text);
  assert.equal(parsed.type, "chat-canda");
  assert.equal("signature" in parsed, false, "the signature field is stripped before forwarding");

  // A socket on another host is not observed at all.
  const evil = new sandbox.WebSocket("wss://evil.example/ws?token=SECRET");
  for (const fn of evil.__listeners.message || []) fn({ data: '{"type":"chat","data":{}}' });
  evil.send(JSON.stringify({ type: "chat-canda", data: {} }));
  assert.equal(portMessages.length, afterText + 1, "other hosts are neither read nor forwarded");

  // The socket address (with its token) appears in no forwarded content.
  const serialized = JSON.stringify({ portMessages, postedWindowMessages });
  assert.equal(serialized.includes("SECRET"), false, "the connection address must never leave the page");
  assert.equal(serialized.includes("wss:"), false);
});

// ---- Test 6: background gating, host allowlist, and cookie-free download.

test("background accepts Lovart records, gates senders, and downloads images without cookies", async () => {
  const harness = await createBackgroundHarness({ appOnline: true });
  await harness.triggerInstalled({ reason: "install" });

  const saveImage = harness.createdContextMenus.find((menu) => menu.id === "mosa-save-image");
  const saveVideo = harness.createdContextMenus.find((menu) => menu.id === "mosa-save-video");
  assert.ok(saveImage && saveVideo);
  assert.ok(saveImage.documentUrlPatterns.includes("https://www.lovart.ai/*"), "save-image covers Lovart");
  assert.equal(saveVideo.documentUrlPatterns.includes("https://www.lovart.ai/*"), false,
    "Lovart is image-only: no save-video menu entry");

  let ingestPayload = null;
  harness.fetchHarness.setAppHandler((url, init) => {
    if (url.pathname === "/api/ingest/web-capture") {
      ingestPayload = JSON.parse(init.body);
      return new Response(JSON.stringify({ ok: true, assetId: "asset-1" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return null;
  });
  const mediaRequests = [];
  harness.fetchHarness.setMediaHandler((url, init) => {
    mediaRequests.push({ url: String(url), init });
    return new Response(new Uint8Array(1024), { status: 200, headers: { "content-type": "image/png" } });
  });

  const lovartSender = senderFor("https://www.lovart.ai/canvas?projectId=x");
  const capture = await harness.dispatchMessage({
    type: "mosa.ingest",
    payload: {
      provider: "lovart",
      mediaKind: "image",
      imageUrl: "https://a.lovart.ai/artifacts/generator/Fake01ArtifactId.png",
      providerAssetId: "Fake01ArtifactId",
    },
  }, lovartSender);
  assert.equal(capture.ok, true);
  assert.equal(ingestPayload?.provider, "lovart");
  assert.equal(mediaRequests.length, 1);
  assert.equal(mediaRequests[0].init.credentials, "omit", "Lovart images are public: downloaded without cookies");
  assert.equal(mediaRequests[0].init.cache, "no-cache");
  assert.equal(mediaRequests[0].url, "https://a.lovart.ai/artifacts/generator/Fake01ArtifactId.png");

  // A Jimeng tab cannot hand over a lovart payload.
  const rejected = await harness.dispatchMessage({
    type: "mosa.ingest",
    payload: { provider: "lovart", mediaKind: "image", imageBase64: fakeImageBase64(128) },
  }, senderFor(JIMENG_TAB_URL));
  assert.equal(rejected.ok, false);

  // Media host allowlist: exact names, https only.
  assert.doesNotThrow(() => harness.context.assertAllowedRemoteMediaUrl("https://a.lovart.ai/artifacts/agent/Fake02ArtifactId.png"));
  assert.doesNotThrow(() => harness.context.assertAllowedRemoteMediaUrl("https://assets-persist.lovart.ai/Fake03ArtifactId.jpg"));
  assert.throws(() => harness.context.assertAllowedRemoteMediaUrl("https://a.lovart.ai.evil.com/x.png"), /Unsupported media host/);
  assert.throws(() => harness.context.assertAllowedRemoteMediaUrl("http://a.lovart.ai/x.png"), /Unsupported media URL protocol/);
});

// ---- Test 7: app ingest maps provider lovart to web-lovart.

async function noiseImage(seed, width = 640, height = 900) {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * (37 + seed) + (i % 251)) & 255;
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
}

test("app ingest maps lovart to web-lovart, keeps the tool prompt and records the user's words", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-lovart-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const events = [];
  const store = {
    createAsset: async (input) => ({ id: input.assetId, project_id: "default", ...input, source: { ...input.source } }),
    listAssets: async () => [],
    findAssetByContentHash: async () => null,
    recordGenerationEvent: async (event) => {
      events.push(event);
      return event;
    },
  };

  const result = await ingestWebCapture({
    store,
    tempRoot: join(root, "lovart"),
    input: {
      provider: "lovart",
      imageBytes: await noiseImage(11),
      mimeType: "image/jpeg",
      prompt: "Replace only the sword with a golden long spear (lance).",
      prompt_status: "generation-tool-prompt",
      prompt_source: "lovart-agent-prompt",
      userMessage: "「sword hilt」把剑换成金色长枪，其他不变",
      conversationId: "00000000-0000-4000-8000-000000000001",
      messageId: "1319137907211231234",
      providerAssetId: "Fake02ArtifactId",
      model: "generate_image_gpt_image_2_5_sunburst",
      pageUrl: "https://www.lovart.ai/canvas?projectId=x",
    },
  });
  assert.equal(result.status, "imported");
  assert.equal(result.asset.sourceType, "web-lovart");
  assert.equal(result.asset.source.provider, "lovart");
  assert.equal(result.asset.prompt, "Replace only the sword with a golden long spear (lance).",
    "a generation-tool prompt is retained verbatim");
  assert.equal(result.asset.business_fields.prompt_status, "generation-tool-prompt");
  assert.equal(result.asset.business_fields.user_message, "「sword hilt」把剑换成金色长枪，其他不变");
  assert.equal(result.asset.source.model, "generate_image_gpt_image_2_5_sunburst");
  assert.equal(result.asset.source.conversation_id, "00000000-0000-4000-8000-000000000001");
  assert.equal(result.asset.source.message_id, "1319137907211231234");
  assert.match(result.asset.assetId, /^web-lovart-[a-f0-9]{12}$/);
  assert.deepEqual(result.asset.tags, ["lovart", "web-capture", "auto-archived"]);
  assert.equal(events.length, 1);
  assert.equal(events[0].user_prompt, "「sword hilt」把剑换成金色长枪，其他不变");
  assert.equal(events[0].effective_prompt, result.asset.prompt);

  assert.equal(sourceSearchDisplayName("web-lovart"), "Lovart");
  assert.equal(
    generationSessionKey({ source: { type: "web-lovart", conversation_id: "00000000-0000-4000-8000-000000000001" } }),
    "web-lovart:00000000-0000-4000-8000-000000000001",
    "one Lovart conversation stacks as one generation session",
  );
});

// ---- Baseline behavior: the first auto-capture-enabled page writes it once.

test("first Lovart page with auto-capture on persists the auto-capture baseline", async () => {
  const page = lovartPage({});
  await page.clock.advance(0);
  const baseline = page.localStore.get("lovartAutoCaptureBaselineAtV1");
  assert.equal(typeof baseline, "number", `baseline key lovartAutoCaptureBaselineAtV1 was written (${typeof baseline})`);

  const second = lovartPage({ storage: { lovartAutoCaptureBaselineAtV1: 1_700_000_000_000 } });
  await second.clock.advance(0);
  assert.equal(second.localStore.get("lovartAutoCaptureBaselineAtV1"), 1_700_000_000_000,
    "an existing baseline is kept, never rewritten");
});
