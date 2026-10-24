import { existsSync } from "node:fs";
import { join } from "node:path";
import { rm } from "node:fs/promises";

// Local visual search was removed (task 238). These are the only locations
// earlier versions of the app created for it under userData; they are swept
// once per launch so no user is left carrying orphaned model or index bytes.
// Nothing outside this list is ever touched, and the library folder is not
// part of userData.
export const LEGACY_VISUAL_DATA_DIRS = Object.freeze([
  "visual-model-packs",
  "visual-pack-staging",
  "visual-relationship-indexes",
]);
export const LEGACY_VISUAL_DATA_FILES = Object.freeze([
  "visual-model-settings.json",
]);

export async function cleanupLegacyVisualData({ userDataDir } = {}) {
  const baseDir = String(userDataDir || "").trim();
  if (!baseDir) throw new Error("Legacy visual data cleanup requires the Electron userData directory.");
  const removed = [];
  for (const entry of LEGACY_VISUAL_DATA_DIRS) {
    const target = join(baseDir, entry);
    if (!existsSync(target)) continue;
    await rm(target, { recursive: true, force: true });
    removed.push(entry);
  }
  for (const entry of LEGACY_VISUAL_DATA_FILES) {
    const target = join(baseDir, entry);
    if (!existsSync(target)) continue;
    await rm(target, { force: true });
    removed.push(entry);
  }
  return removed;
}
