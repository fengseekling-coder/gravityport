#!/usr/bin/env node

/**
 * Installs the GravityPort UI dependencies when they are missing so a fresh
 * checkout works with plain `npm install` / `npm ci` at the repository root.
 * An existing node_modules is left alone: upgrading UI deps is an explicit
 * `npm --prefix web/gravityport install` away.
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const uiDir = join(root, "web", "gravityport");

if (existsSync(join(uiDir, "node_modules"))) process.exit(0);

const hasLockfile = existsSync(join(uiDir, "package-lock.json"));
const args = hasLockfile ? ["ci"] : ["install"];
console.log(`[GravityPort UI] installing UI dependencies (npm ${args[0]})…`);
const result = spawnSync("npm", args, {
  cwd: uiDir,
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
