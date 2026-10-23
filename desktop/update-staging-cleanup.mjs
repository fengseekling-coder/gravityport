import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { compareVersions } from "./update-service.mjs";

// Staged in-app update downloads live one directory per version under
// userData/updates/<platform>/<version>/ (named by the updater's safeVersion).
// A directory whose version is strictly lower than the running app can never
// be a pending install — the updater only downloads versions newer than the
// running one — and the update helpers never go back to the staged ZIP for
// rollback (they restore the parked copy kept next to the installed app), so
// a strictly-older directory is always a fully consumed download. Directories
// that do not parse as versions, or that are equal to or newer than the
// running version, are always kept.
export function selectStaleUpdateStagingDirs(entryNames, currentVersion) {
  return entryNames.filter((name) => {
    try {
      return compareVersions(name, currentVersion) < 0;
    } catch {
      return false;
    }
  });
}

/**
 * Best-effort sweep of consumed update downloads. Never throws: a staging
 * root that cannot be listed is treated as nothing to clean, and a directory
 * that cannot be removed is reported in `failed` for the caller to log; the
 * next launch retries.
 */
export async function cleanupStaleUpdateStagingDirs({ stagingRoots, currentVersion }) {
  const removed = [];
  const failed = [];
  for (const stagingRoot of Array.isArray(stagingRoots) ? stagingRoots : []) {
    if (!stagingRoot) continue;
    let entries;
    try {
      entries = await readdir(stagingRoot);
    } catch {
      continue;
    }
    for (const name of selectStaleUpdateStagingDirs(entries, currentVersion)) {
      const dirPath = join(stagingRoot, name);
      try {
        await rm(dirPath, { recursive: true, force: true });
        removed.push(dirPath);
      } catch (error) {
        failed.push({ dirPath, error: error?.message || String(error) });
      }
    }
  }
  return { removed, failed };
}
