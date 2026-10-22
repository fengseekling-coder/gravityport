import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readSqliteSchemaVersion } from "../lib/schema-upgrade-backup.mjs";
import {
  CURRENT_SCHEMA_VERSION,
  hasCompletedSqliteLibrary,
  sqliteDatabasePath,
} from "../lib/sqlite-asset-store.mjs";

// Written next to the post-update ready file before this launch upgrades the
// library schema. The update helpers (macOS sh, Windows PowerShell) read it:
// once the library is upgraded the previous version can no longer open it, so
// the helper keeps the new version instead of rolling back.
export const SCHEMA_UPGRADE_MARKER_NAME = "schema-upgrade-started.json";

export function schemaUpgradeMarkerPath(readyFile) {
  return join(dirname(String(readyFile)), SCHEMA_UPGRADE_MARKER_NAME);
}

function readLibrarySchemaVersion(databasePath) {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return readSqliteSchemaVersion(database);
  } finally {
    database.close();
  }
}

/**
 * Marks a pending schema upgrade for the update helper. Never throws: a
 * missing, legacy, or unreadable library simply gets no marker, and startup
 * continues either way.
 */
export function markPendingSchemaUpgrade({
  readyFile,
  libraryDir,
  targetVersion = CURRENT_SCHEMA_VERSION,
  readSchemaVersion = readLibrarySchemaVersion,
  now = () => new Date(),
} = {}) {
  if (!readyFile || !libraryDir) return { marked: false, reason: "not-an-update-launch" };
  try {
    if (!hasCompletedSqliteLibrary(libraryDir)) return { marked: false, reason: "no-sqlite-library" };
    const from = readSchemaVersion(sqliteDatabasePath(libraryDir));
    if (!(Number.isInteger(from) && from < targetVersion)) return { marked: false, reason: "no-upgrade", from };
    writeFileSync(schemaUpgradeMarkerPath(readyFile), `${JSON.stringify({
      from,
      to: targetVersion,
      at: now().toISOString(),
    })}\n`, "utf8");
    return { marked: true, from, to: targetVersion };
  } catch (error) {
    console.warn(`[GravityPort] unable to check the library schema before startup: ${error?.message || error}`);
    return { marked: false, reason: "error" };
  }
}
