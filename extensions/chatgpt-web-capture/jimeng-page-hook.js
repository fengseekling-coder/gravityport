/**
 * Page-world hook for jimeng.jianying.com: observe the site's own
 * /mweb/v1/ JSON responses read-only (generation-status polls and history
 * listings) and forward their text to the isolated-world provider script.
 * Requests and responses are never modified; only same-origin /mweb/v1/
 * endpoints are observed, and no request headers or credentials leave the
 * page through this channel — only the response body text the page itself
 * already received. The one exception in scope is the site's own delete
 * call (/mweb/v1/remove_history): when the site confirms a deletion, the
 * deleted work item ids from that request body are forwarded so GravityPort
 * can move matching captures to its trash; URL query parameters, headers,
 * cookies and every other request body stay unobserved.
 */
(function mosaJimengPageHook() {
  if (window.__mosaJimengHookInstalled) return;
  window.__mosaJimengHookInstalled = true;

  // Same channel security model as page-hook.js: the MessagePort is
  // transferred exactly once through a transient window message, so a page
  // script that runs later cannot forge or steal the bridge.
  let portPost = null;
  let activePort = null;

  // The isolated-world script runs at document_idle, long after this hook's
  // first offer, so every request gets a fresh channel (the ChatGPT hook does
  // the same). The previous port is closed so only the newest listener
  // receives responses. A page script could also request a port, but it would
  // only receive copies of responses the page itself already has.
  function handPortToContent() {
    const channel = new MessageChannel();
    try { activePort?.close(); } catch { /* already closed */ }
    activePort = channel.port1;
    portPost = activePort.postMessage.bind(activePort);
    activePort.start?.();
    window.postMessage(
      { source: "mosa-jimeng-hook", type: "hook-port" },
      location.origin,
      [channel.port2],
    );
  }
  handPortToContent();
  // The content script asks for a port once it is listening.
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin) return;
    if (event.data?.source === "mosa-jimeng-content" && event.data?.type === "hook-port-request") {
      handPortToContent();
    }
  });

  const MAX_RESPONSE_TEXT = 4 * 1024 * 1024;
  // The site's own delete call. The request body carries the deleted item ids
  // ({"item_id_list_map":{"<recordId>":["<itemId>",…]}}); on a confirmed
  // success only those ids — never headers, cookies, or URL query parameters —
  // travel to the content script so GravityPort can move the matching
  // captures to its trash.
  const REMOVAL_PATH = "/mweb/v1/remove_history";

  function isJimengRemovalUrl(value) {
    if (typeof value !== "string" || !value) return false;
    try {
      return new URL(value, location.href).pathname === REMOVAL_PATH;
    } catch {
      return false;
    }
  }

  function parseRemovalRequestItems(requestText) {
    let parsed;
    try {
      parsed = JSON.parse(String(requestText || ""));
    } catch {
      return [];
    }
    const map = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.item_id_list_map : null;
    if (!map || typeof map !== "object" || Array.isArray(map)) return [];
    const items = [];
    for (const [recordId, itemIds] of Object.entries(map)) {
      if (!Array.isArray(itemIds)) continue;
      for (const itemId of itemIds) {
        if (typeof itemId !== "string" && typeof itemId !== "number") continue;
        const clean = String(itemId).trim();
        if (!/^\d{1,32}$/.test(clean)) continue;
        items.push({ recordId: String(recordId).slice(0, 128), itemId: clean });
      }
    }
    return items;
  }

  // The site confirms with HTTP 200 and ret "0" (string or number); anything
  // else is treated as "not deleted" and never forwarded.
  function removalSucceeded(status, ret) {
    return status === 200 && (ret === "0" || ret === 0);
  }

  function removalRetFromText(text) {
    try {
      return JSON.parse(String(text || "")).ret;
    } catch {
      return undefined;
    }
  }

  function forwardRemovalObservation(requestText, status, ret) {
    if (!portPost || !removalSucceeded(status, ret)) return;
    const items = parseRemovalRequestItems(requestText);
    if (!items.length) return;
    try {
      portPost({ type: "jimeng-deletion-observed", success: true, items });
    } catch {
      // The content side may be gone (navigation); nothing to do.
    }
  }

  function isJimengApiUrl(value) {
    if (typeof value !== "string" || !value) return false;
    try {
      const url = new URL(value, location.href);
      return url.origin === location.origin && url.pathname.startsWith("/mweb/v1/");
    } catch {
      return false;
    }
  }

  function forwardResponse(requestUrl, text) {
    if (!portPost || typeof text !== "string" || !text || text.length > MAX_RESPONSE_TEXT) return;
    try {
      portPost({ type: "jimeng-api-response", url: String(requestUrl || ""), text });
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
      forwardResponse(requestUrl, text);
    } catch {
      // Reading the clone may fail when the page aborts the request; skip.
    }
  }

  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  if (originalFetch) {
    window.fetch = function mosaHookedFetch(input, init) {
      const requestUrl = typeof input === "string" ? input
        : input instanceof URL ? input.href
          : input instanceof Request ? input.url
            : "";
      const promise = originalFetch(input, init);
      if (isJimengApiUrl(requestUrl)) {
        promise.then((response) => {
          void forwardFetchResponse(requestUrl, response);
        }).catch(() => {});
        if (isJimengRemovalUrl(requestUrl)) {
          // The site currently posts remove_history over XMLHttpRequest; this
          // path keeps the same observation working if it moves to fetch.
          const requestText = typeof init?.body === "string" ? init.body : "";
          promise.then((response) => {
            (async () => {
              if (response.status !== 200) return;
              const ret = removalRetFromText(await response.clone().text());
              forwardRemovalObservation(requestText, response.status, ret);
            })().catch(() => {});
          }).catch(() => {});
        }
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
    if (isJimengApiUrl(this.__mosaRequestUrl)) {
      const removal = isJimengRemovalUrl(this.__mosaRequestUrl);
      const requestText = removal && typeof args[0] === "string" ? args[0] : "";
      this.addEventListener("load", () => {
        try {
          if (this.responseType === "" || this.responseType === "text") {
            if (removal) forwardRemovalObservation(requestText, this.status, removalRetFromText(this.responseText));
            forwardResponse(this.__mosaRequestUrl, this.responseText);
          } else if (this.responseType === "json" && this.response != null) {
            if (removal) forwardRemovalObservation(requestText, this.status, this.response?.ret);
            forwardResponse(this.__mosaRequestUrl, JSON.stringify(this.response));
          }
        } catch {
          // Reading a consumed/error body; skip.
        }
      });
    }
    return originalSend.apply(this, args);
  };
})();
