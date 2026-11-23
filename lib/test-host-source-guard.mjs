// Test-only guard: a runtime started by the test suite must never read the
// developer's real Codex / Grok / Cowart source directories.
//
// `test/clean-test-env.mjs` (the `npm test` preload) records the host's real
// source roots in TEST_GRAVITYPORT_HOST_SOURCE_ROOTS. Product hosts (desktop
// shell, server CLI, background supervisor) never set that variable, so the
// guard is a no-op outside the test suite and production defaults are
// unchanged. Inside the suite every runtime — in-process or a child process
// that inherits the test environment — fails closed before acquiring the
// library lock or starting any bridge if one of its resolved source locations
// is, or sits inside, a real host root. A test that forgets to pass its own
// temporary source directories therefore fails loudly instead of quietly
// scanning ~/.codex or ~/.grok.

import * as nodePath from "node:path";

import { isPathInsideOrEqual } from "./path-safety.mjs";

export const TEST_HOST_SOURCE_ROOTS_ENV = "TEST_GRAVITYPORT_HOST_SOURCE_ROOTS";

function parseRoots(value, pathApi) {
  if (typeof value !== "string" || !value) return [];
  return value.split(pathApi.delimiter).filter(Boolean).map((root) => pathApi.resolve(root));
}

/**
 * Throws `ERR_TEST_HOST_SOURCE` when the suite marker is present (in the
 * process env or the runtime's own env) and any resolved source location
 * points at a recorded host root. `sources` maps a runtime option name to the
 * path the runtime is about to use.
 */
export function assertNoHostSourcesUnderTest({
  sources,
  env,
  processEnv = process.env,
  platform = process.platform,
  pathApi = nodePath,
}) {
  const roots = [
    ...parseRoots(processEnv?.[TEST_HOST_SOURCE_ROOTS_ENV], pathApi),
    ...parseRoots(env?.[TEST_HOST_SOURCE_ROOTS_ENV], pathApi),
  ];
  if (roots.length === 0) return;
  // macOS and Windows volumes are case-insensitive by default; compare folded.
  const fold = platform === "darwin" || platform === "win32" ? (value) => value.toLowerCase() : (value) => value;
  for (const [field, location] of Object.entries(sources)) {
    if (typeof location !== "string" || !location) continue;
    const candidate = fold(pathApi.resolve(location));
    const hostRoot = roots.find((root) => isPathInsideOrEqual(fold(root), candidate, pathApi));
    if (!hostRoot) continue;
    const error = new Error(
      `TEST_HOST_SOURCE_REJECTED: ${field} resolved to ${location}, inside the host source root ${hostRoot}. `
      + `Pass a temporary ${field} (or the matching environment variable) when starting a runtime under test.`,
    );
    error.code = "ERR_TEST_HOST_SOURCE";
    error.field = field;
    throw error;
  }
}
