// Records which npm packages end up in the production bundle, so desktop
// packaging can ship their license texts (scripts/third-party-licenses.mjs
// reads the emitted bundled-packages.json). Only modules that made it into an
// output chunk count; anything tree-shaken away never reaches users.

import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const BUNDLED_PACKAGES_FILE = "bundled-packages.json";

const PACKAGE_ROOT_PATTERN = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/@.][^/]*)(?:\/|$)/;

/** Package root directory of a bundled module id, or null for project sources and virtual modules. */
export function packageRootForModuleId(id) {
  const path = String(id || "").split("?")[0].replace(/\\/g, "/");
  if (!path || path.startsWith("\0")) return null;
  const match = PACKAGE_ROOT_PATTERN.exec(path);
  return match ? match[1] : null;
}

/** Sorted, de-duplicated package roots, relative to `root` with forward slashes. */
export function bundledPackageDirs(moduleIds, root) {
  const dirs = new Set();
  for (const id of moduleIds) {
    const packageRoot = packageRootForModuleId(id);
    if (!packageRoot) continue;
    dirs.add(relative(resolve(root), resolve(packageRoot)).replace(/\\/g, "/"));
  }
  return [...dirs].sort();
}

/**
 * `inlinedPackages` names packages whose code reaches the output without
 * becoming a module (for example the CSS @tailwindcss/vite inlines for
 * `@import "tailwindcss"`). Each must be installed under `root`/node_modules.
 */
export function bundledPackagesPlugin({ root, inlinedPackages = [] }) {
  return {
    name: "gravityport-bundled-packages",
    apply: "build",
    generateBundle(_options, bundle) {
      const moduleIds = [];
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        moduleIds.push(...(output.moduleIds || Object.keys(output.modules || {})));
      }
      for (const name of inlinedPackages) {
        const packageJson = join(root, "node_modules", name, "package.json");
        if (!existsSync(packageJson)) throw new Error(`Inlined package ${name} is not installed: ${packageJson}`);
        moduleIds.push(packageJson);
      }
      this.emitFile({
        type: "asset",
        fileName: BUNDLED_PACKAGES_FILE,
        source: `${JSON.stringify(bundledPackageDirs(moduleIds, root), null, 2)}\n`,
      });
    },
  };
}
