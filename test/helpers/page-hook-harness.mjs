/**
 * Shared MAIN-world page-hook harness. Extracted from
 * test/chatgpt-web-capture-hook.test.mjs so the dev raw diagnostics suite can
 * drive the same interception points without duplicating the sandbox.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import vm from "node:vm";

export const hookSource = await readFile(new URL("../../extensions/chatgpt-web-capture/page-hook.js", import.meta.url), "utf8");
export const devRawSource = await readFile(new URL("../../extensions/chatgpt-web-capture/dev-raw-diagnostics.js", import.meta.url), "utf8");

// Minimal MessageChannel stand-in: two entangled ports. Messages are
// delivered synchronously while a listener is attached and queue otherwise,
// which mirrors how the real content script behaves once it has adopted the
// port without making every existing harness test await a task boundary.
export class MockMessagePort {
  constructor() {
    this._peer = null;
    this._pending = [];
    this._listeners = [];
    this._onmessage = null;
  }

  _entangle(peer) {
    this._peer = peer;
  }

  postMessage(data) {
    assert.ok(this._peer, "mock port must be entangled before postMessage");
    this._peer._deliver({ data });
  }

  _deliver(event) {
    if (!this._listeners.length && !this._onmessage) {
      this._pending.push(event);
      return;
    }
    for (const listener of [...this._listeners]) listener(event);
    if (this._onmessage) this._onmessage(event);
  }

  addEventListener(type, listener) {
    if (type !== "message") return;
    this._listeners.push(listener);
    this._flushPending();
  }

  get onmessage() {
    return this._onmessage;
  }

  set onmessage(handler) {
    this._onmessage = handler;
    this._flushPending();
  }

  start() {
    this._flushPending();
  }

  _flushPending() {
    if (!this._listeners.length && !this._onmessage) return;
    while (this._pending.length) this._deliver(this._pending.shift());
  }
}

export class MockMessageChannel {
  constructor() {
    this.port1 = new MockMessagePort();
    this.port2 = new MockMessagePort();
    this.port1._entangle(this.port2);
    this.port2._entangle(this.port1);
  }
}

export function createHookHarness(payload, conversationId = "conversation-test", options = {}) {
  const events = [];
  const requestedUrls = [];
  const requestedInits = [];
  const createdObjectUrls = [];
  const windowMessages = [];
  const hookPortOffers = [];
  const windowMessageListeners = [];
  const consoleDebugs = [];
  let contentPort = null;
  const documentElement = { dataset: {} };
  // The blob-asset hooks need the page's Blob, Response and URL.createObjectURL.
  // Parts may be strings or Uint8Array; arrayBuffer() hands back the exact
  // bytes so the dev diagnostics metadata reader can parse real containers.
  class HookBlob {
    constructor(parts = [], opts = {}) {
      const encoder = new TextEncoder();
      const chunks = (parts || []).map((part) => (
        typeof part === "string" ? encoder.encode(part) : Uint8Array.from(part)
      ));
      const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      this.__bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        this.__bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      this.size = total;
      this.type = opts?.type || "";
    }

    async arrayBuffer() {
      return this.__bytes.slice().buffer;
    }
  }
  class HookResponse {
    constructor(body, init = {}) {
      this.url = String(init?.url || "");
      this.__mosaBody = body;
      this.__mosaType = String(init?.type || "image/png");
    }

    async blob() {
      return new HookBlob([this.__mosaBody], { type: this.__mosaType });
    }
  }
  class HookURL extends URL {
    static createObjectURL(obj) {
      const blobUrl = `blob:https://chatgpt.com/mosa-hook-${createdObjectUrls.length}-test`;
      createdObjectUrls.push({ blobUrl, blob: obj });
      return blobUrl;
    }

    static revokeObjectURL() {}
  }
  function adoptContentPort(port) {
    contentPort = port;
    port.addEventListener("message", (portEvent) => {
      events.push(portEvent.data);
    });
    // content.js confirms the first port immediately; tests can suppress the
    // ack to exercise the hook's port-request fallback.
    if (options.ack !== false) {
      port.postMessage({ source: "mosa-chatgpt-capture", type: "hook-port-ack" });
    }
  }
  const window = {
    fetch: async (url, init) => {
      requestedUrls.push(String(url));
      requestedInits.push(init || null);
      if (typeof options.respond === "function") {
        const override = options.respond(String(url), init);
        if (override) return override;
      }
      return {
        ok: true,
        clone: () => ({ text: async () => JSON.stringify(payload) }),
        text: async () => JSON.stringify(payload),
      };
    },
    addEventListener: (type, listener) => {
      if (type === "message") windowMessageListeners.push(listener);
    },
    postMessage: (event, targetOrigin, transfer) => {
      windowMessages.push({ event, targetOrigin, transfer });
      if (
        event?.source === "mosa-chatgpt-capture"
        && event?.type === "hook-port"
        && transfer?.[0] instanceof MockMessagePort
      ) {
        hookPortOffers.push(event);
        adoptContentPort(transfer[0]);
      }
    },
    WebSocket: class MockWebSocket {
      constructor(url) {
        this.url = url;
        this.messageListeners = [];
      }

      addEventListener(type, listener) {
        if (type === "message") this.messageListeners.push(listener);
      }

      send() {}

      emit(data) {
        for (const listener of this.messageListeners) listener({ data });
      }
    },
  };
  function MockXHR() {}
  MockXHR.prototype.open = () => {};
  MockXHR.prototype.send = () => {};
  MockXHR.prototype.setRequestHeader = () => {};

  // The manifest loads dev-raw-diagnostics.js right before page-hook.js in
  // the same MAIN world; the sandbox mirrors that order. The module stays
  // inert until something calls setEnabled(true).
  const sandbox = {
    Date,
    JSON,
    Math,
    Object,
    Set,
    String,
    console: { debug: (...args) => consoleDebugs.push(args.map((value) => String(value)).join(" ")) },
    URL: HookURL,
    Blob: HookBlob,
    Response: HookResponse,
    XMLHttpRequest: MockXHR,
    MessageChannel: MockMessageChannel,
    // Base64 and UTF-8 decoding are page APIs the hook needs for socket frames.
    atob: globalThis.atob,
    TextDecoder: globalThis.TextDecoder,
    TextEncoder: globalThis.TextEncoder,
    Uint8Array: globalThis.Uint8Array,
    ArrayBuffer: globalThis.ArrayBuffer,
    setTimeout,
    clearTimeout,
    document: { documentElement, addEventListener: () => {} },
    location: { origin: "https://chatgpt.com", pathname: `/c/${conversationId}` },
    window,
  };
  vm.runInNewContext(devRawSource, sandbox, { filename: "dev-raw-diagnostics.js" });
  vm.runInNewContext(hookSource, sandbox, { filename: "page-hook.js" });

  if (options.captureEnabled !== false && contentPort) {
    contentPort.postMessage({
      source: "mosa-chatgpt-capture",
      type: "set-capture-enabled",
      payload: { enabled: true },
    });
  }

  return {
    events,
    requestedUrls,
    requestedInits,
    createdObjectUrls,
    windowMessages,
    hookPortOffers,
    consoleDebugs,
    documentElement,
    blobClass: HookBlob,
    responseClass: HookResponse,
    urlClass: HookURL,
    devRaw: sandbox.MosaDevRawDiagnostics,
    dispatchWindowMessage(data, eventOverrides = {}) {
      for (const listener of [...windowMessageListeners]) {
        listener({ source: window, data, ...eventOverrides });
      }
    },
    async sendToPageHook(data) {
      assert.ok(contentPort, "page hook should have handed a port to the content script");
      contentPort.postMessage(data);
      await setImmediate();
    },
    async harvest(init, url = "https://chatgpt.com/backend-api/conversation/test") {
      await window.fetch(url, init);
      await setImmediate();
    },
    async socketFrame(data) {
      const socket = new window.WebSocket("wss://chatgpt.com/client/hubs/conversations");
      socket.emit(data);
      await setImmediate();
      await setImmediate();
    },
    async refreshCurrentConversation() {
      assert.ok(contentPort, "page hook should listen for refresh requests");
      contentPort.postMessage({ source: "mosa-chatgpt-capture", type: "refresh-current-conversation" });
      await setImmediate();
      await setImmediate();
    },
  };
}

export function generationEvents(harness) {
  return harness.events.filter((event) => event.type === "generation-meta" && event.payload?.prompt);
}
