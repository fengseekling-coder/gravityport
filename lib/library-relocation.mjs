import Database from "better-sqlite3";
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isPathInsideOrEqual, pathsEqual } from "./path-safety.mjs";
import { sqliteDatabasePath } from "./sqlite-asset-store.mjs";

// Released by the runtime when its service stops; copying a stale lock into
// the new location would make the relocated library look occupied.
const RELOCATION_SKIPPED_ENTRY_NAMES = Object.freeze([".mosa-runtime.lock"]);

// Path strings alone cannot decide whether two locations overlap: macOS and
// Windows volumes are usually case-insensitive, and links can alias a folder.
// Compare filesystem identity (device + inode) along the candidate's ancestry.
async function directoryIdentity(path) {
  try {
    const info = await stat(path);
    return `${info.dev}:${info.ino}`;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

async function containsOrEquals(parentPath, candidatePath) {
  if (isPathInsideOrEqual(parentPath, candidatePath)) return true;
  const parentIdentity = await directoryIdentity(parentPath);
  if (!parentIdentity) return false;
  for (let current = resolve(candidatePath); ; current = dirname(current)) {
    if (await directoryIdentity(current) === parentIdentity) return true;
    if (dirname(current) === current) return false;
  }
}

async function sameLocation(left, right) {
  if (pathsEqual(left, right)) return true;
  const leftIdentity = await directoryIdentity(left);
  return Boolean(leftIdentity) && leftIdentity === await directoryIdentity(right);
}

function relocationError(code, message) {
  return Object.assign(new Error(message), { code });
}

// `realpath.native` reports the spelling that actually exists on disk, which
// also canonicalizes case on case-insensitive volumes (macOS APFS, most
// Windows filesystems). fs.promises does not expose the native variant, so
// fall back to the sync call.
async function nativeRealpath(path) {
  if (typeof realpath.native === "function") return realpath.native(path);
  return realpathSync.native(path);
}

// Canonicalize a path to its real on-disk location, tolerating a missing
// tail: the deepest existing ancestor is canonicalized and the remainder is
// appended verbatim. Returns null when even the filesystem root is missing.
async function realLocation(path) {
  let current = resolve(path);
  let missingTail = "";
  for (;;) {
    try {
      const real = await nativeRealpath(current);
      return missingTail ? join(real, missingTail) : real;
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) return null;
      missingTail = missingTail ? join(basename(current), missingTail) : basename(current);
      current = parent;
    }
  }
}

const MANAGED_ASSET_PATH_COLUMNS = Object.freeze([
  "original_path",
  "preview_path",
  "medium_path",
  "thumbnail_path",
]);

// Decide whether an absolute managed path belongs to the source library and,
// if so, which spelling of the library root measures it: the literal string
// prefix when that already matches, otherwise the canonical on-disk location
// so access through a symlink or a differently cased path still counts.
// Returns null when the path lives outside the library under both spellings.
async function matchSourceRoot(sourceLibraryDir, candidatePath) {
  if (isPathInsideOrEqual(sourceLibraryDir, candidatePath)) {
    return { root: sourceLibraryDir, path: candidatePath };
  }
  const sourceReal = await realLocation(sourceLibraryDir);
  if (!sourceReal) return null;
  const candidateReal = await realLocation(candidatePath);
  if (!candidateReal || !isPathInsideOrEqual(sourceReal, candidateReal)) return null;
  return { root: sourceReal, path: candidateReal };
}

async function relocatedPath(value, sourceLibraryDir, destinationLibraryDir) {
  if (!value) return value;
  const resolvedValue = resolve(String(value));
  const match = await matchSourceRoot(sourceLibraryDir, resolvedValue);
  if (!match) return value;
  const candidate = resolve(destinationLibraryDir, relative(match.root, match.path));
  if (!isPathInsideOrEqual(destinationLibraryDir, candidate)) {
    throw new Error(`Refusing unsafe relocated library path: ${value}`);
  }
  return candidate;
}

async function assertCopiedManagedFile(sourcePath, destinationPath) {
  const [sourceInfo, destinationInfo] = await Promise.all([stat(sourcePath), stat(destinationPath)]);
  if (!sourceInfo.isFile() || !destinationInfo.isFile()) {
    throw new Error(`Relocated managed path is not a file: ${destinationPath}`);
  }
  if (sourceInfo.size !== destinationInfo.size) {
    throw new Error(`Relocated managed file size mismatch: ${destinationPath}`);
  }
}

/**
 * Validate a candidate library location before anything is moved.
 *
 * The result mirrors the desktop handler's dialog flow: the same directory
 * counts as "cancelled" (nothing would change), mutually nested directories
 * are "invalid" (a recursive copy into itself would make rollback ambiguous),
 * a non-empty target is "not-empty", and a target that cannot be inspected is
 * "unavailable". A missing target is created so the copy can proceed.
 */
export async function validateRelocationTarget({ currentLibraryDir, nextLibraryDir } = {}) {
  const currentRoot = resolve(String(currentLibraryDir || ""));
  const nextRoot = resolve(String(nextLibraryDir || ""));
  if (!currentLibraryDir || !nextLibraryDir) throw new Error("Both the current and the next library directory are required.");
  if (await sameLocation(nextRoot, currentRoot)) return { ok: false, reason: "cancelled" };
  // Parent/child moves can recursively copy the library into itself or make
  // rollback ambiguous. Only independent directories are accepted.
  if (await containsOrEquals(currentRoot, nextRoot) || await containsOrEquals(nextRoot, currentRoot)) {
    return { ok: false, reason: "invalid" };
  }
  try {
    const entries = await readdir(nextRoot);
    if (entries.length > 0) return { ok: false, reason: "not-empty" };
  } catch (error) {
    if (error?.code !== "ENOENT") return { ok: false, reason: "unavailable" };
    await mkdir(nextRoot, { recursive: true });
  }
  return { ok: true };
}

/**
 * Copy a stopped library to a new location and rebase its managed paths.
 *
 * Every top-level entry is copied in order — never overwriting an existing
 * destination file — except the runtime lock, then
 * {@link finalizeCopiedSqliteLibrary} rebases the copied database. The
 * destination must be empty (or missing) and independent of the source; that
 * is checked here before anything is written, because on a copy failure the
 * partial copy is removed and the destination recreated as an empty
 * directory. Callers still run {@link validateRelocationTarget} first to map
 * rejections to user-facing reasons. The source is never modified; the
 * original library stays authoritative until the caller deletes it.
 */
export async function copyLibraryForRelocation({ sourceLibraryDir, destinationLibraryDir } = {}) {
  const sourceRoot = resolve(String(sourceLibraryDir || ""));
  const destinationRoot = resolve(String(destinationLibraryDir || ""));
  if (!sourceLibraryDir || !destinationLibraryDir) {
    throw new Error("Source and destination library directories are required.");
  }
  // The failure path below deletes the destination, so its preconditions are
  // enforced here, not only by callers: an overlapping or occupied
  // destination is refused before a single byte is written or removed.
  if (await sameLocation(sourceRoot, destinationRoot)
    || await containsOrEquals(sourceRoot, destinationRoot)
    || await containsOrEquals(destinationRoot, sourceRoot)) {
    throw relocationError("RELOCATION_TARGET_OVERLAPS", "The destination must be independent of the source library.");
  }
  try {
    if ((await readdir(destinationRoot)).length > 0) {
      throw relocationError("RELOCATION_TARGET_NOT_EMPTY", "The destination library directory must be empty.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(destinationRoot, { recursive: true });
  }
  try {
    const sourceEntries = await readdir(sourceRoot, { withFileTypes: true });
    for (const entry of sourceEntries) {
      if (RELOCATION_SKIPPED_ENTRY_NAMES.includes(entry.name)) continue;
      await cp(join(sourceRoot, entry.name), join(destinationRoot, entry.name), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    }
    return await finalizeCopiedSqliteLibrary({
      sourceLibraryDir: sourceRoot,
      destinationLibraryDir: destinationRoot,
    });
  } catch (error) {
    // The destination was verified empty and independent above, so removing
    // it only discards this partial copy. The original remains authoritative.
    await rm(destinationRoot, { recursive: true, force: true }).catch(() => {});
    await mkdir(destinationRoot, { recursive: true }).catch(() => {});
    throw error;
  }
}

/**
 * Finalize a copied SQLite library before it becomes authoritative.
 *
 * MOSA stores managed media paths as absolute paths. Copying the library tree
 * therefore requires rebasing only the managed media columns inside the copied
 * database. Provenance/source paths intentionally stay untouched because they
 * may point to external applications or source folders.
 *
 * The operation is fail-closed: every path that belonged to the old library is
 * checked against the copied byte on disk before a single database row is
 * changed, then the copied SQLite file receives an integrity check after the
 * transaction commits.
 */
export async function finalizeCopiedSqliteLibrary({ sourceLibraryDir, destinationLibraryDir } = {}) {
  const sourceRoot = resolve(String(sourceLibraryDir || ""));
  const destinationRoot = resolve(String(destinationLibraryDir || ""));
  if (!sourceLibraryDir || !destinationLibraryDir || sourceRoot === destinationRoot) {
    throw new Error("Source and destination library directories must be different absolute locations.");
  }

  const databasePath = sqliteDatabasePath(destinationRoot);
  const database = new Database(databasePath);
  try {
    const integrityBefore = database.pragma("integrity_check", { simple: true });
    if (integrityBefore !== "ok") throw new Error(`Copied GravityPort database failed integrity check: ${integrityBefore}`);

    const rows = database.prepare(`
      SELECT project_id, id, ${MANAGED_ASSET_PATH_COLUMNS.join(", ")}
      FROM assets
      ORDER BY project_id, id
    `).all();
    const updates = [];

    for (const row of rows) {
      const next = {};
      let changed = false;
      for (const column of MANAGED_ASSET_PATH_COLUMNS) {
        const current = row[column];
        if (!current) continue;
        const rebased = await relocatedPath(current, sourceRoot, destinationRoot);
        if (rebased === current) continue;
        await assertCopiedManagedFile(resolve(current), rebased);
        next[column] = rebased;
        changed = true;
      }
      if (changed) updates.push({ projectId: row.project_id, assetId: row.id, next });
    }

    const updateRow = database.prepare(`
      UPDATE assets SET
        original_path = @original_path,
        preview_path = @preview_path,
        medium_path = @medium_path,
        thumbnail_path = @thumbnail_path
      WHERE project_id = @project_id AND id = @id
    `);
    const apply = database.transaction(() => {
      for (const update of updates) {
        const current = database.prepare(`
          SELECT original_path, preview_path, medium_path, thumbnail_path
          FROM assets WHERE project_id = ? AND id = ?
        `).get(update.projectId, update.assetId);
        const values = {
          project_id: update.projectId,
          id: update.assetId,
          original_path: update.next.original_path ?? current.original_path,
          preview_path: update.next.preview_path ?? current.preview_path,
          medium_path: update.next.medium_path ?? current.medium_path,
          thumbnail_path: update.next.thumbnail_path ?? current.thumbnail_path,
        };
        updateRow.run(values);
      }
    });
    apply();

    const staleQuery = database.prepare(`
      SELECT project_id, id, ${MANAGED_ASSET_PATH_COLUMNS.join(", ")}
      FROM assets
      ORDER BY project_id, id
    `);
    let stale;
    for (const row of staleQuery.all()) {
      for (const column of MANAGED_ASSET_PATH_COLUMNS) {
        const value = row[column];
        if (value && await matchSourceRoot(sourceRoot, resolve(value))) {
          stale = row;
          break;
        }
      }
      if (stale) break;
    }
    if (stale) throw new Error(`Relocated library still references the previous library for asset ${stale.project_id}/${stale.id}.`);

    const integrityAfter = database.pragma("integrity_check", { simple: true });
    if (integrityAfter !== "ok") throw new Error(`Relocated GravityPort database failed integrity check: ${integrityAfter}`);
    return { updatedAssets: updates.length, checkedAssets: rows.length };
  } finally {
    database.close();
  }
}
