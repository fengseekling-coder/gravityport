import { join } from "node:path";

/**
 * Every AI-tool source location a GravityPort runtime resolves, pointed below
 * a test-owned temporary `root`. Spread it into `startMosaRuntime` options so
 * a runtime under test never falls back to the developer's real ~/.codex or
 * ~/.grok (the preload-armed guard in lib/test-host-source-guard.mjs rejects
 * that fallback). The directories need not exist; bridges treat a missing
 * source as "nothing to import".
 */
export function isolatedSourceOptions(root) {
  return {
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "codex-sessions"),
    codexThreadHistoryDir: join(root, "codex-thread-history"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-canvas"),
    cowartRegistryPath: join(root, "cowart-state", "cowart-projects.json"),
  };
}

/**
 * The environment-variable form of {@link isolatedSourceOptions}, for runtimes
 * started as child processes (`server.mjs`, the MCP server). CODEX_HOME moves
 * every Codex-owned default (images, sessions, thread history, Cowart canvas
 * and registry); Grok has no home variable of its own.
 */
export function isolatedSourceEnv(root) {
  return {
    CODEX_HOME: join(root, "codex-home"),
    GROK_SESSIONS_DIR: join(root, "grok-sessions"),
  };
}
