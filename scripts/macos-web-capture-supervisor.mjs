#!/usr/bin/env node
import "../lib/apply-env-aliases.mjs";

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSupervisor as runSharedSupervisor, backgroundRuntimeEnv } from "../desktop/web-capture-supervisor.mjs";
export * from "../desktop/web-capture-supervisor.mjs";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(moduleDir, "..");
const serverEntry = join(repositoryRoot, "server.mjs");
const DEFAULT_SOURCE_CHANGE_SETTLE_MS = 750;

export function runSupervisor(options = {}) {
  return runSharedSupervisor({
    spawnRuntime: () => spawn(process.execPath, [serverEntry], {
      cwd: repositoryRoot,
      env: backgroundRuntimeEnv(),
      stdio: "inherit",
    }),
    watchSources: () => watchOwnedRuntimeSources(),
    ...options,
  });
}

export function watchOwnedRuntimeSources({
  watchImpl = watch,
  settleMs = DEFAULT_SOURCE_CHANGE_SETTLE_MS,
  sources = [
    { path: join(repositoryRoot, "web", "gravityport", "src"), recursive: true },
    { path: join(repositoryRoot, "lib"), recursive: true },
    { path: serverEntry, recursive: false },
    { path: join(repositoryRoot, "package.json"), recursive: false },
  ],
} = {}) {
  const watchers = [];
  let settleTimer = null;
  let closed = false;
  let resolveChange;
  const promise = new Promise((resolvePromise) => { resolveChange = resolvePromise; });

  const closeHandles = () => {
    for (const watcher of watchers.splice(0)) watcher.close?.();
  };
  const scheduleChange = () => {
    if (closed) return;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (closed) return;
      closed = true;
      settleTimer = null;
      closeHandles();
      resolveChange({ reason: "source-change" });
    }, Math.max(50, Number(settleMs) || DEFAULT_SOURCE_CHANGE_SETTLE_MS));
    settleTimer.unref?.();
  };

  for (const source of sources) {
    const watcher = watchImpl(source.path, { recursive: source.recursive === true }, scheduleChange);
    watcher.on?.("error", scheduleChange);
    watchers.push(watcher);
  }

  return {
    promise,
    close() {
      if (closed) return;
      closed = true;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = null;
      closeHandles();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runSupervisor({
    spawnRuntime: () => spawn(process.execPath, [serverEntry], {
      cwd: repositoryRoot,
      env: backgroundRuntimeEnv(),
      stdio: "inherit",
    }),
    watchSources: () => watchOwnedRuntimeSources(),
  });
}
