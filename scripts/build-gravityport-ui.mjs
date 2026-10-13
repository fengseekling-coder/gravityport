#!/usr/bin/env node

/**
 * Builds the GravityPort React UI (web/gravityport) into web/gravityport/dist.
 *
 * The runtime serves that directory as its default appDir and the build
 * identity fingerprints it, so `npm run build` always refreshes the UI first.
 * A missing node_modules is a hard error with the exact fix, never a silent
 * skip that would fingerprint stale output.
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const uiDir = join(root, "web", "gravityport");

if (!existsSync(join(uiDir, "node_modules"))) {
  console.error(`
[GravityPort UI] web/gravityport/node_modules is missing.
  Run:  npm --prefix web/gravityport ci
(The root \`npm install\` does this automatically via the preprepare hook.)
`);
  process.exit(1);
}

const result = spawnSync("npm", ["run", "build"], {
  cwd: uiDir,
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
