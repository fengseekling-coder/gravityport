// BUG-08 fix: preload hook loaded by `npm test` before any test file runs.
//
// It deletes MOSA/GravityPort runtime environment variables inherited from the host shell
// so a leftover value from a previous run (e.g. MOSA_LIBRARY_DIR pointing at
// an old temporary library) can never cause mass false failures. Test files
// may still set their own MOSA_* values afterwards; the caller's parent shell
// is never modified because this only mutates the current process env.

import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { TEST_HOST_SOURCE_ROOTS_ENV } from "../lib/test-host-source-guard.mjs";

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
  "MOSA_BACKGROUND_RUNTIME",
  // GravityPort names of the user-facing switches (lib/env-aliases.mjs).
  "GRAVITYPORT_LIBRARY_DIR",
  "GRAVITYPORT_LIBRARY_LOCATION_FILE",
  "GRAVITYPORT_DISABLE_BRIDGES",
  "GRAVITYPORT_DISABLE_TELEMETRY",
  "GRAVITYPORT_WEB_CAPTURE_TOKEN",
  "GRAVITYPORT_WEB_CAPTURE_ORIGINS",
];

// Real AI-tool source locations on this machine. A runtime under test must
// never scan, watch, or write them: record the host roots (default homes plus
// any location the developer's shell points at) for the fail-closed guard in
// lib/test-host-source-guard.mjs, then drop the shell overrides (before the
// generic MOSA_* sweep below) so a test can only reach a source directory it
// passes explicitly. Product hosts never set the marker, so production
// defaults are untouched.
const HOST_SOURCE_VARIABLES = [
  "CODEX_HOME",
  "CODEX_GENERATED_IMAGES_DIR",
  "CODEX_SESSIONS_DIR",
  "CODEX_THREAD_HISTORY_DIR",
  "GROK_SESSIONS_DIR",
  "COWART_MOSA_CANVAS_DIR",
  "MOSA_COWART_REGISTRY_PATH",
];
const hostSourceRoots = new Set([join(homedir(), ".codex"), join(homedir(), ".grok")]);
for (const name of HOST_SOURCE_VARIABLES) {
  const value = process.env[name];
  if (value) hostSourceRoots.add(resolve(value));
  delete process.env[name];
}
// Child test processes inherit the already-recorded roots; keep them so a
// nested preload cannot forget the real roots after they were deleted above.
for (const root of String(process.env[TEST_HOST_SOURCE_ROOTS_ENV] || "").split(delimiter)) {
  if (root) hostSourceRoots.add(root);
}
process.env[TEST_HOST_SOURCE_ROOTS_ENV] = [...hostSourceRoots].join(delimiter);

for (const name of POLLUTING_MOSA_VARIABLES) {
  delete process.env[name];
}

// Integration tests act as MOSA's trusted first-party UI. Give every runtime
// the same deterministic test-only capability and mirror api-client.mjs by
// attaching it to loopback API calls. Task 314: reads (/api/ GETs and the
// /library/ media routes) need the capability too, so every method is covered
// — exactly like the real UI, which presents the header on fetches and the
// cookie on <img>/<video>. Tests that need to verify rejection can explicitly
// supply an empty or wrong x-mosa-client-token header, which this wrapper
// intentionally preserves instead of overwriting; raw-socket requests bypass
// the wrapper entirely.
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
    const covered = url.pathname.startsWith("/api/") || url.pathname.startsWith("/library/");
    if (!loopback || !covered || method === "OPTIONS") {
      return nativeFetch(input, init);
    }
    const headers = new Headers(init.headers || input?.headers || undefined);
    if (!headers.has("x-mosa-client-token")) headers.set("x-mosa-client-token", TEST_CLIENT_TOKEN);
    return nativeFetch(input, { ...init, headers });
  };
}
