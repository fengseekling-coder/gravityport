// Local-artifact cleanup (development machines only, never CI or releases).
//
// Deletes ONLY explicitly whitelisted regenerable paths. Release artifacts
// under out/ (installers, packaged apps, store builds) are assets and are
// unreachable by design: the allowlist below accepts nothing under out/
// outside the declared scratch namespaces, so even a mistyped or future
// widened target list cannot touch them.
//
// Convention for future scratch work: create throwaway repack / inspect / QA
// directories inside out/tmp/, out/qa/, or out/inspect/ — those namespaces
// are what this script clears. Anything placed directly under out/ is treated
// as a deliberate artifact and is never cleaned automatically.

import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_PRODUCTS, releaseProductNames } from "./release-product.mjs";

export const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Regenerable paths directly under the repository root.
export const REGENERABLE_ROOTS = ["coverage", ".nyc_output"];

// Scratch namespaces under out/ reserved for disposable work directories.
export const TEMP_NAMESPACES = ["out/tmp", "out/qa", "out/inspect"];

export const DEFAULT_TARGETS = [...REGENERABLE_ROOTS, ...TEMP_NAMESPACES];

// Shown in every report; the allowlist above is what actually keeps them safe.
// Every release product's packaged output directories are deliberate artifacts
// and stay unreachable by cleanup.
export const PRESERVED_RELEASE_PATHS = Object.freeze([
  "out/make",
  ...RELEASE_PRODUCTS.flatMap((product) => [
    `out/${releaseProductNames(product).macosPackageDirName}`,
    `out/${releaseProductNames(product).windowsPackageDirName}`,
  ]),
  "out/store",
]);

// Accepts a requested delete target only when it is an explicitly declared
// regenerable path. Returns { path, reason } for rejections.
export function resolveCleanTarget(root, requested) {
  if (typeof requested !== "string" || requested.trim() === "") {
    return { requested, reason: "empty target" };
  }
  if (isAbsolute(requested) && !withinRoot(root, requested)) {
    return { requested, reason: "absolute path outside the repository" };
  }
  const resolved = resolve(root, requested);
  const rel = relative(root, resolved);
  if (rel === "") {
    return { requested, reason: "refusing to delete the repository root" };
  }
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    return { requested, reason: "path escapes the repository" };
  }
  if (REGENERABLE_ROOTS.includes(rel)) return { requested, path: resolved, rel };
  const namespace = TEMP_NAMESPACES.find((ns) => rel === ns || rel.startsWith(`${ns}${sep}`));
  if (namespace) return { requested, path: resolved, rel, namespace };
  return { requested, reason: "not a declared regenerable path" };
}

function withinRoot(root, candidate) {
  const rel = relative(root, resolve(candidate));
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(1)} ${units[index]}`;
}

async function measurePath(path) {
  const info = await lstat(path);
  if (!info.isDirectory()) return info.size;
  let total = 0;
  const pending = [path];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else {
        const stats = await lstat(entryPath);
        total += stats.size;
      }
    }
  }
  return total;
}

// Removes one already-validated target. Never follows symlinks: a symlink
// target is unlinked only after realpath confirms it stays inside the
// repository, and fs.rm() unlinks nested symlinks instead of traversing them.
async function removeTarget(root, entry, dryRun) {
  let info;
  try {
    info = await lstat(entry.path);
  } catch {
    return { ...entry, status: "missing", bytes: 0 };
  }
  let targetRealPath;
  try {
    targetRealPath = await realpath(entry.path);
  } catch {
    return { ...entry, status: "skipped", reason: "unresolvable target path", bytes: 0 };
  }
  if (!withinRoot(root, targetRealPath)) {
    return { ...entry, status: "skipped", reason: "resolved target escapes the repository", bytes: 0 };
  }
  if (info.isSymbolicLink()) {
    if (!dryRun) await rm(entry.path, { recursive: false, force: true });
    return { ...entry, status: "removed", bytes: info.size };
  }
  const bytes = await measurePath(entry.path);
  if (!dryRun) await rm(entry.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  return { ...entry, status: "removed", bytes };
}

export async function cleanLocal({ root = DEFAULT_ROOT, targets = DEFAULT_TARGETS, dryRun = false } = {}) {
  const resolvedRoot = resolve(root);
  const realRoot = await realpath(resolvedRoot);
  const validated = targets.map((target) => resolveCleanTarget(realRoot, target));
  const results = [];
  for (const entry of validated) {
    if (entry.reason) {
      results.push({ ...entry, status: "rejected", bytes: 0 });
      continue;
    }
    results.push(await removeTarget(realRoot, entry, dryRun));
  }
  return {
    root: realRoot,
    dryRun,
    results,
    removed: results.filter((entry) => entry.status === "removed"),
    skipped: results.filter((entry) => entry.status === "skipped" || entry.status === "missing"),
    rejected: results.filter((entry) => entry.status === "rejected"),
    bytesReclaimed: results.reduce((total, entry) => total + (entry.status === "removed" ? entry.bytes : 0), 0),
  };
}

export function renderReport(report) {
  const lines = [`MOSA local cleanup${report.dryRun ? " (dry-run, nothing was deleted)" : ""}`, `Repository root: ${report.root}`, ""];
  const removedLabel = report.dryRun ? "Would remove:" : "Removed:";
  lines.push(removedLabel);
  const removed = report.results.filter((entry) => entry.status === "removed");
  if (removed.length === 0) lines.push("  (nothing)");
  for (const entry of removed) lines.push(`  ${entry.rel} (${formatBytes(entry.bytes)})`);
  lines.push("", "Preserved:");
  for (const path of PRESERVED_RELEASE_PATHS) lines.push(`  ${path}`);
  const notPresent = report.skipped.filter((entry) => entry.status === "missing");
  const skipped = report.skipped.filter((entry) => entry.status === "skipped");
  if (notPresent.length > 0) {
    lines.push("", "Not present (skipped):");
    for (const entry of notPresent) lines.push(`  ${entry.rel ?? entry.requested}`);
  }
  if (skipped.length > 0) {
    lines.push("", "Skipped for safety:");
    for (const entry of skipped) lines.push(`  ${entry.rel ?? entry.requested} (${entry.reason})`);
  }
  if (report.rejected.length > 0) {
    lines.push("", "Rejected unsafe targets:");
    for (const entry of report.rejected) lines.push(`  ${entry.requested} (${entry.reason})`);
  }
  lines.push("", `${report.dryRun ? "Space reclaimable" : "Space reclaimed"}: ${formatBytes(report.bytesReclaimed)}`);
  return lines.join("\n");
}

export function parseArgs(argv) {
  const options = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log("Usage: npm run clean:local [-- --dry-run]");
    } else {
      const report = await cleanLocal({ dryRun: options.dryRun });
      console.log(renderReport(report));
      if (report.rejected.length > 0) process.exitCode = 1;
    }
  } catch (error) {
    console.error(`clean:local failed: ${error.message}`);
    process.exitCode = 1;
  }
}
