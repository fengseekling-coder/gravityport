// App-managed import staging (audit BUG-01 fix).
//
// The Electron shell stages files the user picks or pastes into a MOSA-owned
// private directory before submitting them to the import API. The backend only
// trusts that exact staging root as an extra source root, so ordinary files
// outside the project roots remain importable without widening any other
// trust boundary. Staged files are plain copies: the user's original files are
// never moved, linked, or deleted by this module.
//
// Trust model (Desktop vs Web):
//
//   Desktop (`desktop/main.mjs`):
//     - Electron owns the staging root (under `app.getPath("userData")`).
//     - `mosa-runtime.mjs` passes that exact root to the API context via
//       `importStagingRoot`, and `api-routes.mjs` exposes it as the *only*
//       non-root source the create-asset route will accept without being
//       classified as `automatic` or `web`.
//     - Threat surface: a compromised renderer can only write to the
//       Electron `userData` directory, which already requires breaking the
//       sandboxed, contextIsolated BrowserWindow. No additional privilege is
//       gained by the staging trust boundary.
//
//   Web / standalone CLI (`server.mjs`):
//     - `importStagingRoot` stays null; the API context reports
//       `trustedSourceRoots: []`. The create-asset route therefore trusts
//       only the configured source-location allowlist (Codex/Grok/Cowart),
//       which is enforced through `source-locations.ts` and `path-safety.mjs`.
//     - No path originating from the browser may bypass that allowlist. The
//       renderer can still upload file *contents* through the ingest endpoint
//       (handled separately by `web-capture-ingest.ts`), but that path
//       uploads bytes — not filenames — and runs through the same media
//       validation pipeline.
//
// This module is the only place where Desktop can introduce a new trusted
// source. Adding any extra `trustedSourceRoots` entry here or in
// `mosa-runtime.mjs` is a deliberate security decision and must be reviewed
// against the threat model above.
//
// Task 319: deletion and the orphan sweep only ever trust DIRECT children of
// the staging root, and the staging root itself must be a real directory —
// never a symlink. An in-root symlinked directory would let a staged-looking
// path name a file outside MOSA's own directory, and a swapped staging root
// would point the sweep at someone else's directory.

import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isPathInside, isUrlLikePath } from "./path-safety.mjs";

export const IMPORT_STAGING_DIR_NAME = "import-staging";
export const STAGING_PREFIX = "import";
export const STAGING_PASTE_PREFIX = "paste";
export const MAX_STREAMED_IMPORT_BYTES = 1024 * 1024 * 1024;

// Mirrors the store's accepted media extensions so a staged copy always keeps
// an extension the import API will accept. This is the single source for the
// native open dialog filters (desktop/main.mjs derives them from here), and
// the batch 1.1 guard test keeps the renderer drag/drop pattern on the same set.
export const STAGING_EXTENSIONS = new Set([
  ".apng", ".avif", ".gif", ".jpg", ".jpeg", ".png", ".svg", ".webp",
  ".m4v", ".mov", ".mp4", ".webm",
]);

const DEFAULT_ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;

export class ImportStagingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ImportStagingError";
    this.code = code;
  }
}

/** Exact private staging root below a data directory (e.g. Electron userData). */
export function importStagingDir(userDataDir) {
  return resolve(join(resolve(userDataDir), IMPORT_STAGING_DIR_NAME));
}

export async function ensureImportStagingDir(root) {
  await mkdir(resolve(root), { recursive: true });
  return resolve(root);
}

/** True only when `target` is a real child of `root` (no `..` escape, no equality). */
export function isWithinStagingRoot(root, target) {
  return isPathInside(root, target);
}

function rejectUnsafeSource(sourcePath) {
  if (typeof sourcePath !== "string" || !sourcePath.trim()) {
    throw new ImportStagingError("STAGING_SOURCE_REQUIRED", "Staging source path is required.");
  }
  // URL-like sources (http:, file:, ...) must never be treated as local files.
  // A Windows drive path such as C:\\Users\\... is a local path, not a URL scheme.
  if (isUrlLikePath(sourcePath)) {
    throw new ImportStagingError("STAGING_URL_NOT_ALLOWED", `Refusing to stage URL-like source: ${sourcePath}`);
  }
}

async function statSourceForStaging(resolvedSource) {
  let info;
  try {
    info = await lstat(resolvedSource);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ImportStagingError("STAGING_SOURCE_NOT_FOUND", `Staging source does not exist: ${resolvedSource}`);
    }
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new ImportStagingError("STAGING_SOURCE_IS_SYMLINK", `Refusing to stage symbolic links: ${resolvedSource}`);
  }
  if (!info.isFile()) {
    throw new ImportStagingError("STAGING_SOURCE_NOT_FILE", `Staging source is not a regular file: ${resolvedSource}`);
  }
  return info;
}

/**
 * Copies a user-chosen file into the staging root and returns the staged path.
 * The staged name is fully generated here (never derived from user input), so
 * it cannot contain path separators or traverse out of the staging root. The
 * original file is left untouched.
 */
export async function stageFileForImport({ sourcePath, stagingRoot, prefix = STAGING_PREFIX }) {
  rejectUnsafeSource(sourcePath);
  const resolvedSource = resolve(sourcePath);
  await statSourceForStaging(resolvedSource);
  const extension = extname(resolvedSource).toLowerCase();
  if (!STAGING_EXTENSIONS.has(extension)) {
    throw new ImportStagingError("STAGING_UNSUPPORTED_TYPE", `Unsupported staging media type: ${resolvedSource}`);
  }
  const root = await ensureImportStagingDir(stagingRoot);
  const targetPath = join(root, `${prefix}-${Date.now()}-${randomBytes(4).toString("hex")}${extension}`);
  await copyFile(resolvedSource, targetPath);
  return targetPath;
}

/**
 * Streams a browser-selected File into a server-owned staging directory.
 * Only the extension is read from the client-provided filename; the actual
 * staged filename is generated here so user input can never create paths or
 * overwrite an existing file. The byte cap is enforced while streaming, so
 * large videos do not need to be buffered in memory.
 */
export async function stageReadableForImport({
  readable,
  fileName,
  stagingRoot,
  prefix = STAGING_PREFIX,
  maxBytes = MAX_STREAMED_IMPORT_BYTES,
}) {
  if (!readable || typeof readable[Symbol.asyncIterator] !== "function") {
    throw new ImportStagingError("STAGING_STREAM_REQUIRED", "A readable upload stream is required.");
  }
  const extension = extname(String(fileName || "")).toLowerCase();
  if (!STAGING_EXTENSIONS.has(extension)) {
    throw new ImportStagingError("STAGING_UNSUPPORTED_TYPE", "Unsupported staging media type.");
  }
  const byteLimit = Number(maxBytes);
  if (!Number.isFinite(byteLimit) || byteLimit <= 0) {
    throw new ImportStagingError("STAGING_INVALID_LIMIT", "The upload byte limit is invalid.");
  }

  const root = await ensureImportStagingDir(stagingRoot);
  const targetPath = join(root, `${prefix}-${Date.now()}-${randomBytes(4).toString("hex")}${extension}`);
  let bytesRead = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      bytesRead += chunk.length;
      if (bytesRead > byteLimit) {
        callback(new ImportStagingError("STAGING_FILE_TOO_LARGE", "The uploaded file exceeds the staging limit."));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(readable, limiter, createWriteStream(targetPath, { flags: "wx", mode: 0o600 }));
    if (bytesRead === 0) {
      throw new ImportStagingError("STAGING_FILE_EMPTY", "The uploaded file is empty.");
    }
    return targetPath;
  } catch (error) {
    await unlink(targetPath).catch((cleanupError) => {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
}

/**
 * Persists a pasted clipboard image as a unique PNG inside the staging root.
 * Returns the staged path, or null when the caller should treat the paste as
 * empty (same contract as the previous pastes directory, but inside the root
 * the backend actually trusts).
 */
export async function writeStagedPng(stagingRoot, pngBuffer) {
  const root = await ensureImportStagingDir(stagingRoot);
  const targetPath = join(root, `${STAGING_PASTE_PREFIX}-${Date.now()}-${randomBytes(4).toString("hex")}.png`);
  await writeFile(targetPath, pngBuffer, { flag: "wx" });
  return targetPath;
}

/**
 * Removes one staged file after a successful import. Only plain files inside
 * the exact staging root are eligible; every failure is reported as a result
 * so the caller can log diagnostics without failing the import itself.
 */
export async function removeStagedImport(stagingRoot, stagedPath) {
  if (!stagingRoot || typeof stagedPath !== "string" || !stagedPath.trim()) {
    return { ok: false, reason: "no-op" };
  }
  const root = resolve(stagingRoot);
  const target = resolve(stagedPath);
  if (!isWithinStagingRoot(root, target)) return { ok: false, reason: "outside-staging" };
  // Task 319: staged names are always generated direct children, so a path
  // through an in-root symlinked directory (root/link/x.png) is refused on
  // its face — the literal check above cannot see that hop. Higher ancestors
  // may be symlinks (a library on an external drive reached through one); only
  // the staging root itself must be a real, non-symlink directory.
  if (dirname(target) !== root) return { ok: false, reason: "outside-staging" };
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch {
    return { ok: false, reason: "staging-root-unsafe" };
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    return { ok: false, reason: "staging-root-unsafe" };
  }
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) return { ok: false, reason: "not-plain-file" };
    await unlink(target);
    return { ok: true };
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true, reason: "already-removed" };
    return { ok: false, reason: error?.code || "error", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Startup sweep for orphaned staged files (imports that failed or were
 * cancelled before completion). Only plain files older than `ttlMs` inside
 * the exact staging root are removed; directories and symlinks are skipped.
 */
export async function cleanupOrphanStagedFiles(stagingRoot, { ttlMs = DEFAULT_ORPHAN_TTL_MS, now = Date.now } = {}) {
  const root = resolve(stagingRoot);
  // Task 319: a staging root swapped for a symlink would aim the sweep at the
  // target directory's old files; refuse to enumerate it. A missing root
  // keeps the existing nothing-to-do result.
  try {
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      return { removed: 0, failed: 0, skipped: "staging-root-unsafe" };
    }
  } catch (error) {
    if (error?.code === "ENOENT") return { removed: 0, failed: 0 };
    throw error;
  }
  const cutoff = now() - ttlMs;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { removed: 0, failed: 0 };
    throw error;
  }
  let removed = 0;
  let failed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const candidate = join(root, entry.name);
    let info;
    try {
      info = await lstat(candidate);
    } catch {
      continue;
    }
    if (info.isSymbolicLink() || !info.isFile()) continue;
    if (info.mtimeMs > cutoff) continue;
    try {
      await unlink(candidate);
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}
