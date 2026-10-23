/**
 * Page-world hook for jimeng.jianying.com: observe the site's own
 * /mweb/v1/ JSON responses read-only (generation-status polls and history
 * listings) and forward their text to the isolated-world provider script.
 * Requests and responses are never modified; only same-origin /mweb/v1/
 * endpoints are observed, and no request headers or credentials leave the
 * page through this channel — only the response body text the page itself
 * already received.
 */
(function mosaJimengPageHook() {
  if (window.__mosaJimengHookInstalled) return;
  window.__mosaJimengHookInstalled = true;

  // Same channel security model as page-hook.js: the MessagePort is
  // transferred exactly once through a transient window message, so a page
  // script that runs later cannot forge or steal the bridge.
  let portPost = null;

  function handPortToContent() {
    if (!portPost) {
      const channel = new MessageChannel();
      const port = channel.port1;
      portPost = port.postMessage.bind(port);
      port.start?.();
      window.postMessage(
        { source: "mosa-jimeng-hook", type: "hook-port" },
        location.origin,
        [channel.port2],
      );
    }
  }
  handPortToContent();
  // A late-waking content script (document_idle) may re-request the port.
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin) return;
    if (event.data?.source === "mosa-jimeng-content" && event.data?.type === "hook-port-request") {
      handPortToContent();
    }
  });

  const MAX_RESPONSE_TEXT = 4 * 1024 * 1024;

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
      this.addEventListener("load", () => {
        try {
          if (this.responseType === "" || this.responseType === "text") {
            forwardResponse(this.__mosaRequestUrl, this.responseText);
          } else if (this.responseType === "json" && this.response != null) {
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
