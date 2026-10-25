import test from "node:test";
import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import { resolveSourceLocations } from "../lib/source-locations.js";

test("source locations preserve the current defaults under a supplied home", () => {
  assert.deepEqual(resolveSourceLocations({ home: "/Users/example", pathApi: posix }), {
    codexImagesDir: "/Users/example/.codex/generated_images",
    codexSessionsDir: "/Users/example/.codex/sessions",
    codexThreadHistoryDir: "/Users/example/.codex",
    grokSessionsDir: "/Users/example/.grok/sessions",
    cowartCanvasDir: "/Users/example/.codex/cowart-data/mosa",
    cowartRegistryPath: "/Users/example/.codex/mosa/cowart-projects.json",
  });
});

test("source location precedence remains option, then opted-in env, then default", () => {
  const resolved = resolveSourceLocations({
    home: "/Users/example",
    pathApi: posix,
    env: {
      CODEX_GENERATED_IMAGES_DIR: "/env/codex-images",
      CODEX_SESSIONS_DIR: "/env/codex-sessions",
      CODEX_THREAD_HISTORY_DIR: "/env/codex-thread-history",
      GROK_SESSIONS_DIR: "/env/grok-sessions",
      COWART_MOSA_CANVAS_DIR: "/env/cowart",
      MOSA_COWART_REGISTRY_PATH: "/env/cowart-projects.json",
    },
    overrides: {
      codexImagesDir: "/option/codex-images",
      grokSessionsDir: "/option/grok-sessions",
      cowartRegistryPath: "/option/cowart-projects.json",
    },
  });

  assert.deepEqual(resolved, {
    codexImagesDir: "/option/codex-images",
    codexSessionsDir: "/env/codex-sessions",
    codexThreadHistoryDir: "/env/codex-thread-history",
    grokSessionsDir: "/option/grok-sessions",
    cowartCanvasDir: "/env/cowart",
    cowartRegistryPath: "/option/cowart-projects.json",
  });
});

test("environment overrides are opt-in so direct bridge defaults do not silently change", () => {
  const resolved = resolveSourceLocations({
    home: "/Users/example",
    pathApi: posix,
  });
  assert.equal(resolved.codexSessionsDir, "/Users/example/.codex/sessions");
  assert.equal(resolved.grokSessionsDir, "/Users/example/.grok/sessions");
});

test("the resolver follows the host path implementation without hardcoded separators", () => {
  assert.deepEqual(resolveSourceLocations({ home: "C:\\Users\\example", pathApi: win32 }), {
    codexImagesDir: "C:\\Users\\example\\.codex\\generated_images",
    codexSessionsDir: "C:\\Users\\example\\.codex\\sessions",
    codexThreadHistoryDir: "C:\\Users\\example\\.codex",
    grokSessionsDir: "C:\\Users\\example\\.grok\\sessions",
    cowartCanvasDir: "C:\\Users\\example\\.codex\\cowart-data\\mosa",
    cowartRegistryPath: "C:\\Users\\example\\.codex\\mosa\\cowart-projects.json",
  });
});

test("CODEX_HOME rebases Codex-owned defaults without changing unrelated providers", () => {
  const resolved = resolveSourceLocations({
    home: "/Users/example",
    pathApi: posix,
    env: { CODEX_HOME: "/Volumes/codex-home" },
  });
  assert.equal(resolved.codexImagesDir, "/Volumes/codex-home/generated_images");
  assert.equal(resolved.codexSessionsDir, "/Volumes/codex-home/sessions");
  assert.equal(resolved.codexThreadHistoryDir, "/Volumes/codex-home");
  assert.equal(resolved.cowartCanvasDir, "/Volumes/codex-home/cowart-data/mosa");
  assert.equal(resolved.cowartRegistryPath, "/Volumes/codex-home/mosa/cowart-projects.json");
  assert.equal(resolved.grokSessionsDir, "/Users/example/.grok/sessions");
});
