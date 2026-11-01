// Central outbound fetch dispatcher for background service network calls.
// In the desktop app, this is configured with Chromium's network stack (via net.fetch)
// so that system proxy and system certificates are respected, with credentials omitted.

let activeFetch = null;

export function setOutboundFetch(fn) {
  activeFetch = typeof fn === "function" ? fn : null;
}

export function outboundFetch(url, init) {
  const fetchFn = activeFetch || globalThis.fetch;
  const mergedInit = { ...init, redirect: "error" };
  return fetchFn(url, mergedInit);
}
