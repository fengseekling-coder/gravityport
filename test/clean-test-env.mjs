// BUG-08 fix: preload hook loaded by `npm test` before any test file runs.
//
// It deletes MOSA runtime environment variables inherited from the host shell
// so a leftover value from a previous run (e.g. MOSA_LIBRARY_DIR pointing at
// an old temporary library) can never cause mass false failures. Test files
// may still set their own MOSA_* values afterwards; the caller's parent shell
// is never modified because this only mutates the current process env.

const POLLUTING_MOSA_VARIABLES = [
  "MOSA_LIBRARY_DIR",
  "MOSA_LIBRARY_LOCATION_FILE",
  "MOSA_DISABLE_BRIDGES",
  "MOSA_PORT",
  "MOSA_DESKTOP_PORT",
  "MOSA_COWART_REGISTRY",
  "MOSA_COWART_ENDPOINT",
  "MOSA_COWART_REGISTRY_PATH",
  "MOSA_PROJECT_DIR",
  "MOSA_WEB_CAPTURE_TOKEN",
  "MOSA_WEB_CAPTURE_ORIGINS",
  "MOSA_RUNTIME_MODE",
  "MOSA_USER_DATA",
  "MOSA_QA_RUN",
  "MOSA_CLIENT_TOKEN",
];

for (const name of POLLUTING_MOSA_VARIABLES) {
  delete process.env[name];
}

// Integration tests act as MOSA's trusted first-party UI. Give every runtime
// the same deterministic test-only capability and mirror api-client.mjs by
// attaching it to loopback API mutations. Tests that need to verify rejection
// can explicitly supply an empty x-mosa-client-token header, which this wrapper
// intentionally preserves instead of overwriting.
const TEST_CLIENT_TOKEN = "mosa_test_client_token_0123456789ABCDEFGHijklmno";
process.env.MOSA_CLIENT_TOKEN = TEST_CLIENT_TOKEN;

const nativeFetch = globalThis.fetch;
if (typeof nativeFetch === "function") {
  globalThis.fetch = (input, init = {}) => {
    let url;
    try { url = new URL(typeof input === "string" || input instanceof URL ? input : input?.url); }
    catch { return nativeFetch(input, init); }
    const method = String(init.method || input?.method || "GET").toUpperCase();
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    if (!loopback || !url.pathname.startsWith("/api/") || ["GET", "HEAD", "OPTIONS"].includes(method)) {
      return nativeFetch(input, init);
    }
    const headers = new Headers(init.headers || input?.headers || undefined);
    if (!headers.has("x-mosa-client-token")) headers.set("x-mosa-client-token", TEST_CLIENT_TOKEN);
    return nativeFetch(input, { ...init, headers });
  };
}
