/**
 * Shared provider-script harnesses (task 397, review 4-1 丁).
 *
 * Three boots, all running the REAL extension sources inside a vm context:
 * - createProviderSitesHarness: provider-policy.js + provider-sites.js in
 *   manifest order (the Google provider content script) against a stub page
 *   (fake document with injectable img/video elements, fake chrome runtime +
 *   storage.local, captured timers, a controllable clock, a mutable location).
 * - createProviderPolicyHarness: provider-policy.js alone.
 * - createOptionsHarness: options.js against a stub options page (the six
 *   elements it wires at the top level, fake chrome, stub fetch, real
 *   webcrypto so the service-identity HMAC runs for real).
 *
 * Nothing here slices functions out of the sources and nothing copies them
 * into tests. provider-sites.js is a single IIFE whose body contains a bare
 * early `return` (provider-sites.js:24), so — unlike content-harness — the
 * harness does NOT strip the wrapper: the source runs verbatim and the
 * introspection object is appended just before the closing `})();`, exporting
 * the live internal state and entry points from inside the closure. If a
 * renamed internal disappears, harness creation throws a loud ReferenceError
 * rather than drifting silently. provider-policy.js and options.js run
 * verbatim, unmodified.
 *
 * identityProof() computes what a correct GravityPort service would answer to
 * options.js's identity challenge (the HMAC contract documented in
 * background.js verifyServiceIdentity); options.js still verifies it with its
 * own real code path.
 */

import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import vm from "node:vm";

const extensionDir = new URL("../../extensions/chatgpt-web-capture/", import.meta.url);
const providerPolicySource = await readFile(new URL("provider-policy.js", extensionDir), "utf8");
const providerSitesSource = await readFile(new URL("provider-sites.js", extensionDir), "utf8");
const optionsSource = await readFile(new URL("options.js", extensionDir), "utf8");

const IDENTITY_PROOF_PREFIX = "gravityport-web-capture-identity\0";

/** The proof a correctly-paired GravityPort service signs for `nonce`. */
export async function identityProof(baseUrl, token, nonce) {
  const port = new URL(baseUrl).port || "80";
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const parts = [encoder.encode(IDENTITY_PROOF_PREFIX), encoder.encode(port), new Uint8Array([0]), encoder.encode(nonce)];
  const message = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    message.set(part, offset);
    offset += part.length;
  }
  const signature = await crypto.subtle.sign("HMAC", key, message);
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** DOM-ish element used for both the provider page and the options page. */
export class FakeProviderNode {
  constructor(tagName, options = {}) {
    this.nodeType = 1;
    this.tagName = String(tagName || "div").toUpperCase();
    this.attrs = new Map(Object.entries(options.attrs || {}));
    this.className = options.className || "";
    this.id = this.attrs.get("id") || "";
    this.children = [];
    this.childNodes = [];
    this.parentElement = null;
    this.previousElementSibling = null;
    this.style = { display: "block", visibility: "visible", opacity: "1", ...(options.style || {}) };
    this.__rect = options.rect || { x: 0, y: 0, width: 300, height: 200, top: 0, left: 0, right: 300, bottom: 200 };
    this.value = options.value ?? "";
    this.checked = Boolean(options.checked);
    this.src = options.src || "";
    this.currentSrc = options.currentSrc ?? options.src ?? "";
    this.__listeners = new Map();
  }

  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }

  setAttribute(name, value) {
    this.attrs.set(name, String(value));
    if (name === "id") this.id = String(value);
    if (name === "src") this.src = String(value);
  }

  get classList() {
    const self = this;
    return {
      contains: (name) => String(self.className || "").split(/\s+/).includes(name),
      add: (...names) => {
        const values = new Set(String(self.className || "").split(/\s+/).filter(Boolean));
        for (const name of names) values.add(name);
        self.className = [...values].join(" ");
      },
      remove: (...names) => {
        const values = new Set(String(self.className || "").split(/\s+/).filter(Boolean));
        for (const name of names) values.delete(name);
        self.className = [...values].join(" ");
      },
    };
  }

  getBoundingClientRect() {
    return { ...this.__rect };
  }

  appendChild(child) {
    child.parentElement = this;
    if (child.nodeType === 1) {
      child.previousElementSibling = this.children[this.children.length - 1] || null;
      this.children.push(child);
    }
    this.childNodes.push(child);
    return child;
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.childNodes = [];
    for (const node of nodes) {
      node.parentElement = this;
      this.childNodes.push(node);
      if (node.nodeType === 1) this.children.push(node);
    }
  }

  set textContent(value) {
    this.replaceChildren({ nodeType: 3, nodeValue: String(value), parentElement: this });
  }

  get textContent() {
    return this.childNodes
      .map((node) => (node.nodeType === 3 ? String(node.nodeValue ?? "") : node.textContent))
      .join("");
  }

  addEventListener(type, listener) {
    if (!this.__listeners.has(type)) this.__listeners.set(type, []);
    this.__listeners.set(type, [...this.__listeners.get(type), listener]);
  }

  removeEventListener() {}

  click(event = { target: this }) {
    return Promise.all((this.__listeners.get("click") || []).map((listener) => listener(event)));
  }
}

export class FakeProviderImage extends FakeProviderNode {
  constructor(options = {}) {
    super("img", { attrs: options.attrs, className: options.className, style: options.style, rect: options.rect });
    this.src = options.src || "";
    this.currentSrc = options.currentSrc ?? options.src ?? "";
    this.complete = options.complete ?? true;
    this.naturalWidth = options.naturalWidth ?? 1024;
    this.naturalHeight = options.naturalHeight ?? 1024;
    this.width = options.width ?? 0;
    this.height = options.height ?? 0;
    this.alt = options.alt || "";
  }

  getAttribute(name) {
    if (name === "alt") return this.alt || null;
    return super.getAttribute(name);
  }
}

export class FakeProviderVideo extends FakeProviderNode {
  constructor(options = {}) {
    super("video", { attrs: options.attrs, className: options.className, style: options.style, rect: options.rect });
    this.src = options.src || "";
    this.currentSrc = options.currentSrc ?? options.src ?? "";
    this.readyState = options.readyState ?? 1;
    this.videoWidth = options.videoWidth ?? 720;
    this.videoHeight = options.videoHeight ?? 1280;
    this.width = options.width ?? 0;
    this.height = options.height ?? 0;
    this.duration = options.duration ?? 4;
  }
}

export const textNode = (value) => ({ nodeType: 3, nodeValue: String(value), parentElement: null });

class MockProviderMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.observed = [];
    this.disconnectCount = 0;
    MockProviderMutationObserver.instances.push(this);
  }

  observe(target, options) {
    this.observed.push({ target, options });
  }

  disconnect() {
    this.disconnectCount += 1;
  }

  /** Fire the real callback the way a DOM mutation would. */
  trigger() {
    this.callback([], this);
  }
}
MockProviderMutationObserver.instances = [];

function capturedTimers(sandbox, clock) {
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
  return {
    timeouts,
    intervals,
    fireTimeouts: (filter = {}) => {
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
    },
  };
}

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

const flush = async () => {
  for (let index = 0; index < 6; index += 1) await setImmediate();
};

/**
 * Boot the real provider content script (provider-policy.js + provider-sites.js).
 */
export async function createProviderSitesHarness(options = {}) {
  const clock = { now: options.clockStart ?? 1_700_000_000_000 };
  const advanceClock = (ms) => {
    clock.now += ms;
  };

  const sandbox = {
    URL,
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
    Boolean,
    Uint8Array,
    ArrayBuffer,
    btoa: globalThis.btoa,
    console: { debug: () => {}, log: () => {}, warn: () => {}, error: () => {} },
    innerWidth: options.innerWidth ?? 1280,
    innerHeight: options.innerHeight ?? 800,
    clock,
    MutationObserver: MockProviderMutationObserver,
    getComputedStyle: (node) => node?.style || { display: "block", visibility: "visible", opacity: "1" },
  };
  sandbox.HTMLImageElement = FakeProviderImage;
  sandbox.HTMLVideoElement = FakeProviderVideo;

  const timers = capturedTimers(sandbox, clock);

  const locationObj = {
    href: options.href || `https://${options.host || "gemini.google.com"}${options.pathname || "/"}`,
  };
  Object.defineProperties(locationObj, {
    origin: { get: () => new URL(locationObj.href).origin },
    hostname: { get: () => new URL(locationObj.href).hostname },
    pathname: { get: () => new URL(locationObj.href).pathname },
  });

  const sentMessages = [];
  const runtimeMessageListeners = [];
  const onChangedListeners = [];
  const localStore = new Map(options.storageLocal || []);
  const localReads = [];
  const localWrites = [];
  const chromeObj = {
    runtime: {
      id: "test-provider-extension-id",
      onMessage: { addListener: (fn) => runtimeMessageListeners.push(fn) },
      sendMessage: async (message) => {
        if (options.runtimeError) throw new Error("background unavailable in this harness");
        sentMessages.push({ message, at: clock.now });
        if (options.respond) {
          const custom = await options.respond(message, { at: clock.now });
          if (custom !== undefined) return custom;
        }
        return defaultReply(message);
      },
    },
    storage: {
      local: storageArea(localStore, {
        get: (query) => localReads.push(query),
        set: (patch) => localWrites.push(patch),
      }),
      onChanged: { addListener: (fn) => onChangedListeners.push(fn) },
    },
  };
  const defaultReply = (message) => {
    if (message?.type === "mosa.getSettings") {
      return { ok: true, settings: { autoCapture: options.autoCapture ?? false } };
    }
    if (message?.type === "mosa.probeFlowMedia") {
      const probe = options.probeFlowMedia === undefined
        ? { ok: true, result: { mediaKind: "image" } }
        : options.probeFlowMedia;
      return typeof probe === "function" ? probe(message) : probe;
    }
    return { ok: true };
  };

  const images = options.images || [];
  const videos = options.videos || [];
  const documentEventListeners = new Map();
  const documentObj = {
    documentElement: new FakeProviderNode("html"),
    title: "",
    __body: null,
    get body() {
      if (!documentObj.__body) documentObj.__body = new FakeProviderNode("body");
      return documentObj.__body;
    },
    images,
    videos,
    createElement: (tag) => new FakeProviderNode(tag),
    createTextNode: (text) => ({ nodeType: 3, nodeValue: String(text), parentElement: null }),
    getElementById: (id) => {
      const roots = [documentObj.documentElement];
      if (documentObj.__body) roots.push(documentObj.__body);
      while (roots.length) {
        const node = roots.shift();
        if (node.id === id) return node;
        roots.push(...node.children);
      }
      return null;
    },
    querySelector: () => null,
    querySelectorAll: (selector) => (String(selector).includes("video") ? videos : []),
    addEventListener: (type, listener) => {
      if (!documentEventListeners.has(type)) documentEventListeners.set(type, []);
      documentEventListeners.set(type, [...documentEventListeners.get(type), listener]);
    },
    removeEventListener: () => {},
  };
  sandbox.document = documentObj;
  sandbox.chrome = chromeObj;
  sandbox.location = locationObj;
  sandbox.fetch = async (url, init) => {
    sandbox.fetchCalls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      blob: async () => fakeBlob(options.blobBytes ?? 40_000, options.blobType || "image/png"),
    };
  };
  sandbox.fetchCalls = [];

  function fakeBlob(bytes, type) {
    const buffer = new ArrayBuffer(bytes);
    return {
      type,
      size: bytes,
      arrayBuffer: async () => buffer,
      slice: (start, end) => fakeBlob(Math.max(0, Math.min(bytes, end) - start), type),
    };
  }

  const observerBase = MockProviderMutationObserver.instances.length;

  // provider-sites.js is a single IIFE with a bare early return inside, so
  // the source runs verbatim; the introspection object is appended inside the
  // closure, just before the original closing `})();` (see header comment).
  const introspection = `;
;globalThis.__mosaProviderState = {
  get autoCapture() { return autoCapture; }, set autoCapture(value) { autoCapture = value; },
  seen,
  flowMediaProbeInFlight,
  flowProbeFailures,
  promptRetryStates,
  handoffRetryAttempts,
  get lastProviderUrl() { return lastProviderUrl; }, set lastProviderUrl(value) { lastProviderUrl = value; },
  get scanTimer() { return scanTimer; },
  get scanInterval() { return scanInterval; },
  get observer() { return observer; },
  get providerContextLost() { return providerContextLost; },
  get captureInFlight() { return captureInFlight; },
  scan, scheduleScan, withCaptureSlot, attemptPendingPromptUpgrades,
};`;
  const bootable = `${providerSitesSource.replace(/\}\)\(\);\s*$/, "")}\n${introspection}\n})();`;
  vm.runInNewContext(providerPolicySource, sandbox, { filename: "provider-policy.js" });
  vm.runInNewContext(bootable, sandbox, { filename: "provider-sites.js" });

  /** Run every captured (and not cleared) timeout, optionally filtered by delay. */
  const advance = (ms) => {
    advanceClock(ms);
    return timers.fireTimeouts({ dueBefore: 0 });
  };
  const runScheduledScan = () => {
    sandbox.__mosaProviderState.scheduleScan();
    return timers.fireTimeouts({ ms: 300 });
  };
  const fireDocumentEvent = (type, event = {}) => {
    for (const listener of [...(documentEventListeners.get(type) || [])]) listener(event);
  };
  const dispatchRuntimeMessage = (message) => new Promise((resolve, reject) => {
    const listener = runtimeMessageListeners[0];
    if (!listener) {
      reject(new Error("provider-sites.js did not register a chrome.runtime.onMessage listener"));
      return;
    }
    let settled = false;
    const sendResponse = (response) => {
      if (!settled) {
        settled = true;
        resolve(response);
      }
    };
    const keepOpen = listener(message, { id: chromeObj.runtime.id }, sendResponse);
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

  await flush();

  return {
    context: sandbox,
    state: sandbox.__mosaProviderState,
    document: documentObj,
    location: locationObj,
    chrome: chromeObj,
    sentMessages,
    runtimeMessageListeners,
    storage: {
      local: localStore,
      localReads,
      localWrites,
      fireChanged: (changes, area) => {
        for (const listener of [...onChangedListeners]) listener(changes, area);
      },
    },
    documentEventListeners,
    fireDocumentEvent,
    observers: MockProviderMutationObserver.instances.slice(observerBase),
    fetchCalls: sandbox.fetchCalls,
    timers,
    clock,
    advanceClock,
    advance,
    runScheduledScan,
    dispatchRuntimeMessage,
    flush,
  };
}

/** Boot only provider-policy.js. */
export function createProviderPolicyHarness() {
  const sandbox = { URL };
  vm.runInNewContext(providerPolicySource, sandbox, { filename: "provider-policy.js" });
  return sandbox.MosaProviderPolicy;
}

/**
 * Boot the real options.js against a stub options page. `options.fetchHandler`
 * answers (url, init) with a Response-like { ok, status, json } (return
 * undefined for the default offline failure); `options.respond` answers
 * chrome.runtime.sendMessage.
 */
export async function createOptionsHarness(options = {}) {
  const clock = { now: options.clockStart ?? 1_700_000_000_000 };

  const sandbox = {
    URL,
    JSON,
    Math,
    Object,
    String,
    Number,
    Array,
    Promise,
    Error,
    Uint8Array,
    Boolean,
    btoa: globalThis.btoa,
    crypto: globalThis.crypto,
    AbortController: globalThis.AbortController,
    TextEncoder: globalThis.TextEncoder,
    console: { debug: () => {}, log: () => {}, warn: () => {}, error: () => {} },
    clock,
  };
  const timers = capturedTimers(sandbox, clock);

  const runtimeMessages = [];
  const chromeObj = {
    runtime: {
      id: "test-provider-extension-id",
      sendMessage: async (message) => {
        runtimeMessages.push(message);
        if (options.respond) {
          const custom = await options.respond(message);
          if (custom !== undefined) return custom;
        }
        if (message?.type === "mosa.getSettings") {
          if (options.runtimeError) throw new Error("background unavailable in this harness");
          return { ok: true, settings: { ...(options.settings || {}) } };
        }
        return { ok: true };
      },
    },
    storage: {},
  };
  const localStore = new Map(options.storageLocal || []);
  const localReads = [];
  const localWrites = [];
  chromeObj.storage = {
    local: storageArea(localStore, {
      get: (query) => localReads.push(query),
      set: (patch) => localWrites.push(patch),
    }),
  };

  const elementMap = new Map();
  const element = (id, spec = {}) => {
    const node = new FakeProviderNode(spec.tagName || "input", { ...spec, attrs: { id, ...(spec.attrs || {}) } });
    elementMap.set(id, node);
    return node;
  };
  element("status", { tagName: "div" });
  element("mosaBaseUrl");
  element("mosaToken");
  element("autoCapture", { tagName: "input", attrs: { type: "checkbox" } });
  element("save", { tagName: "button" });
  element("test", { tagName: "button" });
  element("repair", { tagName: "button" });

  const fetchCalls = [];
  sandbox.document = {
    getElementById: (id) => elementMap.get(id) || null,
    createElement: (tag) => new FakeProviderNode(tag),
    createTextNode: (text) => ({ nodeType: 3, nodeValue: String(text), parentElement: null }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  sandbox.chrome = chromeObj;
  sandbox.fetch = async (url, init = {}) => {
    fetchCalls.push({ url: String(url), init });
    if (options.fetchHandler) {
      const custom = await options.fetchHandler(String(url), init);
      if (custom) return custom;
    }
    throw new Error("offline in this harness");
  };

  vm.runInNewContext(optionsSource, sandbox, { filename: "options.js" });
  await flush();

  return {
    context: sandbox,
    elements: Object.fromEntries(elementMap),
    click: (id) => elementMap.get(id)?.click({ target: elementMap.get(id) }),
    runtimeMessages,
    fetchCalls,
    storage: {
      local: localStore,
      localReads,
      localWrites,
    },
    timers,
    clock,
    advanceClock: (ms) => {
      clock.now += ms;
    },
    flush,
  };
}
