/**
 * Page-world hook for www.lovart.ai: observe, read-only, the JSON responses
 * the page itself receives from its two chat-history endpoints (the new
 * lgw.lovart.ai/v1/canda/chat-history and the legacy
 * /api/canva/agent/chatHistoryV2) and the text WebSocket frames of Lovart's
 * own chat socket, forwarding those strings to the isolated-world provider
 * script. Requests and responses are never modified. The forwarded material
 * is only response body text the page already received and the page's own
 * outgoing chat command frames with their signature field removed — no
 * request headers, cookies, URL query parameters, binary frames, or socket
 * addresses ever leave the page through this channel. The socket address in
 * particular carries a login token: it is never read, kept, or forwarded —
 * only the host name is checked against the .lovart.ai suffix.
 */
(function mosaLovartPageHook() {
  if (window.__mosaLovartHookInstalled) return;
  window.__mosaLovartHookInstalled = true;

  // Same channel security model as page-hook.js / jimeng-page-hook.js: the
  // MessagePort is transferred exactly once through a transient window
  // message, so a page script that runs later cannot forge or steal the
  // bridge.
  let portPost = null;
  let activePort = null;

  // The isolated-world script runs at document_idle, long after this hook's
  // first offer, so every request gets a fresh channel. The previous port is
  // closed so only the newest listener receives messages.
  function handPortToContent() {
    const channel = new MessageChannel();
    try { activePort?.close(); } catch { /* already closed */ }
    activePort = channel.port1;
    portPost = activePort.postMessage.bind(activePort);
    activePort.start?.();
    window.postMessage(
      { source: "mosa-lovart-hook", type: "hook-port" },
      location.origin,
      [channel.port2],
    );
  }
  handPortToContent();
  // The content script asks for a port once it is listening.
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin) return;
    if (event.data?.source === "mosa-lovart-content" && event.data?.type === "hook-port-request") {
      handPortToContent();
    }
  });

  const MAX_RESPONSE_TEXT = 4 * 1024 * 1024;
  // The only two history endpoints observed. Matched on host + path exactly;
  // queries with or without them both pass, nothing else does.
  const HISTORY_ENDPOINTS = [
    { host: "lgw.lovart.ai", path: "/v1/canda/chat-history" },
    { host: "www.lovart.ai", path: "/api/canva/agent/chatHistoryV2" },
  ];
  // The page's own outgoing chat commands over the socket; anything else the
  // page sends stays unobserved.
  const SENT_FRAME_TYPES = new Set(["chat-canda", "chat-canda-generator"]);

  function isLovartHistoryUrl(value) {
    if (typeof value !== "string" || !value) return false;
    try {
      const url = new URL(value, location.href);
      return HISTORY_ENDPOINTS.some((endpoint) => url.protocol === "https:"
        && url.hostname.toLowerCase() === endpoint.host
        && url.pathname === endpoint.path);
    } catch {
      return false;
    }
  }

  function forwardHistoryResponse(requestUrl, text) {
    if (!portPost || typeof text !== "string" || !text || text.length > MAX_RESPONSE_TEXT) return;
    // Only the endpoint identity travels with the body — never its query
    // string (it carries thread/project ids; the body has the same data).
    let endpoint = "";
    try {
      const url = new URL(String(requestUrl || ""), location.href);
      endpoint = `${url.origin}${url.pathname}`;
    } catch {
      endpoint = "";
    }
    try {
      portPost({ type: "lovart-api-response", url: endpoint, text });
    } catch {
      // The content side may be gone (navigation); nothing to do.
    }
  }

  async function forwardFetchResponse(requestUrl, response) {
    try {
      // clone() must run before the page consumes the body; the page keeps
      // its own stream untouched.
      const clone = response.clone();
      const text = await clone.text();
      forwardHistoryResponse(requestUrl, text);
    } catch {
      // Reading the clone may fail when the page aborts the request; skip.
    }
  }

  // The request client captures fetch at load time, so this wrapper must be
  // installed before the page scripts run (document_start). The page's own
  // call is returned untouched.
  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  if (originalFetch) {
    window.fetch = function mosaHookedFetch(input, init) {
      const requestUrl = typeof input === "string" ? input
        : input instanceof URL ? input.href
          : input instanceof Request ? input.url
            : "";
      const promise = originalFetch(input, init);
      if (isLovartHistoryUrl(requestUrl)) {
        promise.then((response) => {
          void forwardFetchResponse(requestUrl, response);
        }).catch(() => {});
      }
      return promise;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function mosaHookedOpen(method, url, ...rest) {
    this.__mosaRequestUrl = typeof url === "string" ? url : String(url || "");
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function mosaHookedSend(...args) {
    if (isLovartHistoryUrl(this.__mosaRequestUrl)) {
      this.addEventListener("load", () => {
        try {
          if (this.responseType === "" || this.responseType === "text") {
            forwardHistoryResponse(this.__mosaRequestUrl, this.responseText);
          } else if (this.responseType === "json" && this.response != null) {
            forwardHistoryResponse(this.__mosaRequestUrl, JSON.stringify(this.response));
          }
        } catch {
          // Reading a consumed/error body; skip.
        }
      });
    }
    return originalSend.apply(this, args);
  };

  // The chat socket carries the login token in its address, so the address is
  // never forwarded — only string frames on .lovart.ai sockets. Incoming
  // frames pass as received; outgoing frames pass only when they are one of
  // the chat command types, with the signature field removed. Binary frames
  // and every other sent message stay unobserved, and no frame is modified on
  // its way to the page.
  const LovartWebSocket = window.WebSocket;
  if (typeof LovartWebSocket === "function") {
    function mosaSocketHostAllowed(value) {
      try {
        const url = new URL(String(value || ""), location.href);
        return url.protocol === "wss:" && url.hostname.toLowerCase().endsWith(".lovart.ai");
      } catch {
        return false;
      }
    }

    function forwardSocketMessage(text) {
      if (!portPost || typeof text !== "string" || !text || text.length > MAX_RESPONSE_TEXT) return;
      try {
        portPost({ type: "lovart-ws-message", text });
      } catch {
        // The content side may be gone (navigation); nothing to do.
      }
    }

    function forwardSentFrame(text) {
      if (typeof text !== "string" || !text || text.length > MAX_RESPONSE_TEXT) return;
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        // Not the JSON chat command shape we look for; skip.
        return;
      }
      if (!frame || typeof frame !== "object" || !SENT_FRAME_TYPES.has(frame.type)) return;
      delete frame.signature;
      try {
        forwardSocketMessage(JSON.stringify(frame));
      } catch {
        // Unserializable frame; skip.
      }
    }

    function MosaWebSocket(url, protocols) {
      const socket = protocols === undefined
        ? new LovartWebSocket(url)
        : new LovartWebSocket(url, protocols);
      if (mosaSocketHostAllowed(url)) {
        socket.addEventListener("message", (event) => {
          if (typeof event.data === "string") forwardSocketMessage(event.data);
        });
        const originalSend = socket.send.bind(socket);
        socket.send = function mosaHookedSocketSend(data) {
          forwardSentFrame(data);
          return originalSend(data);
        };
      }
      return socket;
    }
    MosaWebSocket.prototype = LovartWebSocket.prototype;
    MosaWebSocket.CONNECTING = LovartWebSocket.CONNECTING;
    MosaWebSocket.OPEN = LovartWebSocket.OPEN;
    MosaWebSocket.CLOSING = LovartWebSocket.CLOSING;
    MosaWebSocket.CLOSED = LovartWebSocket.CLOSED;
    window.WebSocket = MosaWebSocket;
  }
})();
