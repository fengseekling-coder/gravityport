/**
 * Shared ISOLATED-world content-script harness (task 390, review 4-1 丙).
 *
 * Boots the REAL extensions/chatgpt-web-capture/content.js — with its
 * manifest-ordered dependency generation-registry.js — inside a vm context
 * against a stub page environment (fake window/document/chrome, captured
 * timers, a controllable clock). Nothing in here slices functions out of the
 * source and nothing copies them into tests: content.js is a single IIFE, so
 * the harness strips only that outer `(() => { ... })()` wrapper. The body
 * then runs verbatim in sloppy mode, which makes its function declarations
 * reachable as sandbox globals — that is what lets a test call
 * context.enqueueAuto or stub context.runtimeSend without any name-based
 * extraction. If content.js ever stops being a plain IIFE the strip no-ops
 * and the same source still runs (drivers keep working; only direct internal
 * calls would need a follow-up).
 *
 * The sandbox also gets a `__mosaContentState` introspection object appended
 * after the body: getters/setters for the script-level `let` state and direct
 * references to its Maps/Sets, so tests can read and mutate the live internal
 * state of the real script (the old extraction harnesses did the same by
 * pre-declaring those bindings in their preamble).
 */

import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import vm from "node:vm";

import { MockMessagePort } from "./page-hook-harness.mjs";

const extensionDir = new URL("../../extensions/chatgpt-web-capture/", import.meta.url);
const contentSource = await readFile(new URL("content.js", extensionDir), "utf8");
const generationRegistrySource = await readFile(new URL("generation-registry.js", extensionDir), "utf8");

/** Base64 whose decoded size is ~30 KB, above the 20 KB MIN_BYTES floor. */
export const BIG_IMAGE_BASE64 = Buffer.alloc(30_000, 7).toString("base64");

function storageArea(store, ops = {}) {
  return {
    async get(query = null) {
      ops.get?.(query);
      if (query === null || query === undefined) return Object.fromEntries(store);
      if (Array.isArray(query)) {
        const out = {};
        for (const key of query) if (store.has(key)) out[key] = store.get(key);
        return out;
      }
      if (typeof query === "object") {
        const out = {};
        for (const [key, fallback] of Object.entries(query)) {
          out[key] = store.has(key) ? store.get(key) : fallback;
        }
        return out;
      }
      const out = {};
      if (store.has(String(query))) out[String(query)] = store.get(String(query));
      return out;
    },
    async set(patch) {
      ops.set?.(patch);
      for (const [key, value] of Object.entries(patch)) store.set(key, value);
    },
    async remove(keys) {
      for (const key of [].concat(keys)) store.delete(key);
    },
  };
}

class FakeClassList {
  constructor(owner) {
    this.__owner = owner;
  }

  __values() {
    return new Set(String(this.__owner.className || "").split(/\s+/).filter(Boolean));
  }

  add(...names) {
    const values = this.__values();
    for (const name of names) values.add(name);
    this.__owner.className = [...values].join(" ");
  }

  remove(...names) {
    const values = this.__values();
    for (const name of names) values.delete(name);
    this.__owner.className = [...values].join(" ");
  }

  toggle(name, force) {
    const values = this.__values();
    const has = values.has(name);
    const next = force === undefined ? !has : Boolean(force);
    if (next) values.add(name);
    else values.delete(name);
    this.__owner.className = [...values].join(" ");
    return next;
  }

  contains(name) {
    return this.__values().has(name);
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || "div").toUpperCase();
    this.id = "";
    this.className = "";
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.isConnected = false;
    this.textContent = "";
    this.__listeners = new Map();
    this.classList = new FakeClassList(this);
    this.__innerHTML = "";
  }

  get innerHTML() {
    return this.__innerHTML;
  }

  set innerHTML(value) {
    this.__innerHTML = String(value);
  }

  get offsetWidth() {
    return 0;
  }

  get offsetHeight() {
    return 0;
  }

  setAttribute(name, value) {
    if (name === "id") this.id = String(value);
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    child.isConnected = true;
    return child;
  }

  remove() {
    this.isConnected = false;
    if (this.parentElement) {
      const index = this.parentElement.children.indexOf(this);
      if (index >= 0) this.parentElement.children.splice(index, 1);
      this.parentElement = null;
    }
  }

  addEventListener(type, listener) {
    if (!this.__listeners.has(type)) this.__listeners.set(type, []);
    this.__listeners.set(type, [...this.__listeners.get(type), listener]);
  }

  removeEventListener(type, listener) {
    const list = this.__listeners.get(type) || [];
    this.__listeners.set(type, list.filter((entry) => entry !== listener));
  }

  click(event = { target: null }) {
    for (const listener of this.__listeners.get("click") || []) listener(event);
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  closest() {
    return null;
  }

  matches() {
    return false;
  }

  getBoundingClientRect() {
    return { width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 };
  }

  /** Canvas stub: enough for renderedPixelSignature's 24x24 sample hash and
   * for canvasBytesFromImage (whose toBlob rejects so the page falls back to
   * the original provider bytes, as it does for tainted canvases). */
  getContext() {
    return {
      drawImage: () => {},
      getImageData: () => ({ data: new Uint8ClampedArray(24 * 24 * 4) }),
    };
  }

  toBlob(callback) {
    callback(null);
  }
}

class FakeImage {
  constructor(srcOrOptions = {}) {
    const options = typeof srcOrOptions === "string" ? { src: srcOrOptions } : (srcOrOptions || {});
    this.src = options.src || "";
    this.currentSrc = options.src || "";
    this.complete = options.complete ?? false;
    this.naturalWidth = options.naturalWidth ?? 0;
    this.naturalHeight = options.naturalHeight ?? 0;
    this.width = options.width ?? 0;
    this.height = options.height ?? 0;
    this.alt = options.alt || "";
  }

  getAttribute(name) {
    if (name === "alt") return this.alt || null;
    return null;
  }

  closest() {
    return null;
  }
}

class MockMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.observed = [];
    this.disconnectCount = 0;
    MockMutationObserver.instances.push(this);
  }

  observe(target, options) {
    this.observed.push({ target, options });
  }

  disconnect() {
    this.disconnectCount += 1;
  }
}
MockMutationObserver.instances = [];

export { FakeImage };

/**
 * Boot the real content.js. Returns drivers plus introspection; see the
 * header comment for what runs and how.
 */
export async function createContentHarness(options = {}) {
  const clock = { now: options.clockStart ?? 1_700_000_000_000 };
  const advanceClock = (ms) => {
    clock.now += ms;
  };

  const sandbox = {
    // Language builtins the script touches.
    URL,
    Date: undefined, // replaced below with the fake-clock Date
    JSON,
    Math,
    Object,
    Set,
    Map,
    String,
    Number,
    Array,
    Promise,
    RegExp,
    Error,
    Uint8Array,
    ArrayBuffer,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    console: { debug: () => {}, log: () => {}, warn: () => {}, error: () => {} },

    // Captured timers + controllable clock.
    setTimeout: undefined,
    clearTimeout: undefined,
    setInterval: undefined,
    clearInterval: undefined,
    clock,
    __advanceClock: advanceClock,

    // Page environment.
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    navigator: { clipboard: { writeText: async () => {} } },
    requestAnimationFrame: undefined,

    // Recorder fields tests read directly.
    fetchCalls: [],
    createImageBitmapCalls: [],
    closedBitmaps: 0,
    decodedSize: { width: 1024, height: 1024 },
    rafCallbacks: [],
    domContentLoadedListeners: [],
  };
  sandbox.HTMLImageElement = options.imageClass || FakeImage;
  sandbox.MutationObserver = MockMutationObserver;

  // --- timers -------------------------------------------------------------
  let timerSeq = 0;
  const timeouts = [];
  const intervals = [];
  sandbox.setTimeout = (fn, ms, ...args) => {
    timerSeq += 1;
    const timer = { id: timerSeq, fn, ms: Number(ms) || 0, due: clock.now + (Number(ms) || 0), args, cleared: false };
    timeouts.push(timer);
    return timer.id;
  };
  sandbox.clearTimeout = (id) => {
    for (const timer of timeouts) if (timer.id === id) timer.cleared = true;
  };
  sandbox.setInterval = (fn, ms, ...args) => {
    timerSeq += 1;
    const timer = { id: timerSeq, fn, ms: Number(ms) || 0, args, runs: 0, cleared: false };
    intervals.push(timer);
    return timer.id;
  };
  sandbox.clearInterval = (id) => {
    for (const timer of intervals) if (timer.id === id) timer.cleared = true;
  };
  sandbox.requestAnimationFrame = (fn) => {
    sandbox.rafCallbacks.push(fn);
    return sandbox.rafCallbacks.length;
  };
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length) super(...args);
      else super(clock.now);
    }

    static now() {
      return clock.now;
    }
  }
  sandbox.Date = FakeDate;

  /** Run every captured (and not cleared) timeout, optionally filtered by delay. */
  const fireTimeouts = (filter = {}) => {
    const due = timeouts.filter((timer) => {
      if (timer.cleared) return false;
      if (filter.ms !== undefined && timer.ms !== filter.ms) return false;
      if (filter.dueBefore !== undefined && timer.due > clock.now + filter.dueBefore) return false;
      return true;
    });
    for (const timer of due) {
      timer.cleared = true;
      timer.fn(...timer.args);
    }
    return due.length;
  };
  const fireInterval = (id) => {
    const timer = intervals.find((entry) => entry.id === id && !entry.cleared);
    if (!timer) return false;
    timer.runs += 1;
    timer.fn(...timer.args);
    return true;
  };
  const advance = (ms) => {
    advanceClock(ms);
    return fireTimeouts({ dueBefore: 0 });
  };

  // --- chrome -------------------------------------------------------------
  const sentMessages = [];
  const runtimeMessageListeners = [];
  const localStore = new Map();
  const sessionStore = new Map();
  const localReads = [];
  const localWrites = [];
  if (options.localAutoCapture !== undefined) localStore.set("autoCapture", options.localAutoCapture);
  const onChangedListeners = [];
  const defaultRuntimeReply = (message) => {
    if (message?.type === "mosa.getSettings") {
      if (options.settings === null) throw new Error("background unavailable in this harness");
      return { ok: true, settings: { autoCapture: options.settings?.autoCapture ?? false } };
    }
    if (message?.type === "mosa.fetchImage") {
      return { ok: true, result: { mimeType: "image/png", imageBase64: BIG_IMAGE_BASE64 } };
    }
    if (message?.type === "mosa.ingest") {
      return { ok: true, result: { status: "imported" } };
    }
    return { ok: true };
  };
  const chrome = {
    runtime: options.orphanRuntime
      ? {}
      : {
        id: "test-content-extension-id",
        getManifest: () => ({ version: "0.15.47" }),
        onMessage: { addListener: (fn) => runtimeMessageListeners.push(fn) },
        sendMessage: async (message) => {
          sentMessages.push({ message, at: clock.now });
          if (options.respond) {
            const custom = options.respond(message, { at: clock.now });
            if (custom !== undefined) return custom;
          }
          return defaultRuntimeReply(message);
        },
      },
    storage: {
      local: storageArea(localStore, {
        get: (query) => localReads.push(query),
        set: (patch) => localWrites.push(patch),
      }),
      session: storageArea(sessionStore, {
        get: (query) => sessionReads.push(query),
      }),
      onChanged: { addListener: (fn) => onChangedListeners.push(fn) },
    },
  };
  const sessionReads = [];

  // --- window / document --------------------------------------------------
  const windowMessageListeners = [];
  const windowMessages = [];
  const windowObj = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: (type, listener) => {
      if (type === "message") windowMessageListeners.push(listener);
    },
    removeEventListener: () => {},
    postMessage: (event, targetOrigin, transfer) => {
      windowMessages.push({ event, targetOrigin, transfer });
    },
  };

  const elements = [];
  const observerBase = MockMutationObserver.instances.length;
  const observers = MockMutationObserver.instances;
  const images = options.images || [];
  const blocks = options.blocks || [];
  const titleNode = options.titleNode === undefined ? (options.title ? new FakeElement("title") : null) : options.titleNode;
  if (titleNode) titleNode.textContent = options.title || "";
  const sidebarNode = options.sidebarTitle ? new FakeElement("a") : null;
  if (sidebarNode) sidebarNode.textContent = options.sidebarTitle;
  const documentObj = {
    documentElement: new FakeElement("html"),
    title: options.title || "",
    get body() {
      if (!documentObj.__body) {
        documentObj.__body = new FakeElement("body");
        elements.push(documentObj.__body);
      }
      return documentObj.__body;
    },
    getElementById: (id) => elements.find((el) => el.id === id && el.isConnected) || null,
    createElement: (tag) => {
      const el = new FakeElement(tag);
      elements.push(el);
      return el;
    },
    querySelector: (selector) => {
      const s = String(selector);
      if (s === "head > title") return titleNode;
      if (s.includes('aria-current="page"')) return sidebarNode;
      return null;
    },
    querySelectorAll: (selector) => {
      const s = String(selector);
      if (s === "img") return images;
      if (s === "div, section, main, figure") return blocks;
      return [];
    },
    addEventListener: (type, listener) => {
      if (type === "DOMContentLoaded") sandbox.domContentLoadedListeners.push(listener);
    },
    removeEventListener: () => {},
    getComputedStyle: () => ({ backgroundImage: options.backgroundImage || "" }),
  };
  sandbox.document = documentObj;
  sandbox.window = windowObj;
  sandbox.chrome = chrome;
  sandbox.getComputedStyle = documentObj.getComputedStyle;
  sandbox.fetch = async (url, init) => {
    sandbox.fetchCalls.push(String(url));
    if (options.fetchResponse) {
      const custom = options.fetchResponse(String(url), init);
      if (custom) return custom;
    }
    return {
      ok: true,
      blob: async () => ({
        type: "image/png",
        arrayBuffer: async () => new Uint8Array(30_000).fill(7).buffer,
      }),
    };
  };
  sandbox.Blob = class FakeBlob {
    constructor(parts = [], opts = {}) {
      this.type = opts?.type || "";
      this.size = (parts || []).reduce((sum, part) => sum + (part?.length || part?.byteLength || 0), 0);
    }
  };
  sandbox.createImageBitmap = async (blob) => {
    sandbox.createImageBitmapCalls.push(blob);
    return {
      width: sandbox.decodedSize.width,
      height: sandbox.decodedSize.height,
      close: () => {
        sandbox.closedBitmaps += 1;
      },
    };
  };
  sandbox.images = images;

  // Merge caller env BEFORE the script runs (plain values the boot reads),
  // then boot generation-registry.js (manifest order) and content.js itself.
  const env = {
    location: {
      href: options.href || `https://chatgpt.com${options.pathname || "/c/conversation-test"}`,
      origin: options.origin || "https://chatgpt.com",
      pathname: options.pathname || "/c/conversation-test",
      hash: options.hash || "",
    },
    ...options.env,
  };
  // A caller-provided `document` patches the default one (query selectors,
  // title, ...) instead of replacing it: the boot sequence needs the full
  // document surface (addEventListener, getElementById, ...).
  Object.assign(documentObj, options.document || {});
  delete env.document;
  Object.assign(sandbox, env);

  // content.js is a single IIFE; strip only the wrapper so the body runs
  // verbatim with its function declarations reachable as sandbox globals.
  const body = contentSource
    .replace(/^\s*\(\(\) => \{/, "")
    .replace(/\}\)\(\);\s*$/, "");
  const introspection = `;
;globalThis.__mosaContentState = {
  get autoCapture() { return autoCapture; }, set autoCapture(value) { autoCapture = value; },
  get contextLost() { return contextLost; }, set contextLost(value) { contextLost = value; },
  get hookReady() { return hookReady; }, set hookReady(value) { hookReady = value; },
  get hookPort() { return hookPort; },
  get pageHookCaptureAck() { return pageHookCaptureAck; }, set pageHookCaptureAck(value) { pageHookCaptureAck = value; },
  get manualHookLeaseUntil() { return manualHookLeaseUntil; }, set manualHookLeaseUntil(value) { manualHookLeaseUntil = value; },
  get lastStatus() { return lastStatus; },
  get lastError() { return lastError; },
  get lastUrl() { return lastUrl; }, set lastUrl(value) { lastUrl = value; },
  get activeConversationId() { return activeConversationId; }, set activeConversationId(value) { activeConversationId = value; },
  get conversationEpoch() { return conversationEpoch; },
  get generationRegistry() { return generationRegistry; },
  get autoScanInterval() { return autoScanInterval; },
  get desktopSyncRun() { return desktopSyncRun; },
  networkMeta,
  imagePromptMap,
  inFlight,
  queuedAutoKeys,
  savedKeys,
  savedIdentityKeys,
  capturedCandidates,
  savedPromptRanks,
  referenceSyncKeys,
  failedNetworkIdentityKeys,
  promptUpgradeInFlight,
  generationEvidenceRecoveryTimers,
  autoStabilityStates,
  autoStabilityTimers,
  savedGenerationStatuses,
  blobAssetIds,
  failedAt,
  deliveryRetries,
  deliveryRefusedKeys,
  pageReadFailures,
  queuedToastKeys,
  errorToastKeys,
  sizeFailureStates,
  captureDebugEvents,
};`;
  vm.runInNewContext(generationRegistrySource, sandbox, { filename: "generation-registry.js" });
  vm.runInNewContext(`${body}\n${introspection}`, sandbox, { filename: "content.js" });

  // Caller function stubs replace the hoisted declarations after boot.
  if (options.override) Object.assign(sandbox, options.override);

  // --- hook-port plumbing -------------------------------------------------
  const portMessages = [];
  const adoptedPorts = [];
  const dispatchWindowMessage = (data, eventOverrides = {}) => {
    const event = { source: eventOverrides.source ?? windowObj, data, ports: [], ...eventOverrides };
    for (const listener of [...windowMessageListeners]) listener(event);
    return event;
  };
  /** Offer a hook port the way page-hook.js does and return the content-side port. */
  const offerHookPort = () => {
    const port = new MockMessagePort();
    const peer = new MockMessagePort();
    port._entangle(peer);
    peer._entangle(port);
    peer.addEventListener("message", (event) => {
      if (event?.data && typeof event.data === "object") portMessages.push(event.data);
    });
    dispatchWindowMessage(
      { source: "mosa-chatgpt-capture", type: "hook-port" },
      { ports: [port] },
    );
    adoptedPorts.push(port);
    return port;
  };
  /** Deliver one page-hook event through the port the content script adopted. */
  const deliverHookEvent = (type, payload) => {
    const port = sandbox.__mosaContentState?.hookPort;
    if (!port) throw new Error("no hook port adopted; call harness.offerHookPort() first");
    port._peer.postMessage({ source: "mosa-chatgpt-capture", type, payload });
  };

  const dispatchRuntimeMessage = (message, sender = { id: chrome.runtime.id, tab: { id: 11 }, url: env.location.href, frameId: 0 }) => {
    return new Promise((resolve, reject) => {
      const listener = runtimeMessageListeners[0];
      if (!listener) {
        reject(new Error("content.js did not register a chrome.runtime.onMessage listener"));
        return;
      }
      let settled = false;
      const sendResponse = (response) => {
        if (settled) return;
        settled = true;
        resolve(response);
      };
      const keepOpen = listener(message, sender, sendResponse);
      if (keepOpen !== true && !settled) {
        settled = true;
        resolve(null);
      }
      setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("sendResponse was never called"));
        }
      }, 8_000);
    });
  };

  const flush = async () => {
    for (let index = 0; index < 6; index += 1) await setImmediate();
  };
  await flush();

  return {
    context: sandbox,
    state: sandbox.__mosaContentState,
    window: windowObj,
    document: documentObj,
    location: sandbox.location,
    chrome,
    sentMessages,
    portMessages,
    adoptedPorts,
    windowMessages,
    windowMessageListeners,
    runtimeMessageListeners,
    storage: {
      local: localStore,
      session: sessionStore,
      localReads,
      localWrites,
      sessionReads,
      fireChanged: (changes, area) => {
        for (const listener of [...onChangedListeners]) listener(changes, area);
      },
    },
    elements,
    observers: MockMutationObserver.instances.slice(observerBase),
    fetchCalls: sandbox.fetchCalls,
    createImageBitmapCalls: sandbox.createImageBitmapCalls,
    clock,
    advanceClock,
    timers: { timeouts, intervals },
    fireTimeouts,
    fireInterval,
    advance,
    flush,
    dispatchWindowMessage,
    offerHookPort,
    deliverHookEvent,
    dispatchRuntimeMessage,
    fireDOMContentLoaded: async () => {
      for (const listener of [...sandbox.domContentLoadedListeners]) await listener();
    },
  };
}
