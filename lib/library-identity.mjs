import { createHmac, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Library identity (task 314): the public /api/health may no longer carry the
 * library's absolute path, yet the desktop shell and the background capture
 * supervisor still need to answer "is the service on this port serving MY
 * library?". A per-library random secret (.gravityport-library-id) plus an
 * HMAC over the canonicalized directory gives them a comparable, non-reversible
 * fingerprint:
 *   - a copied library (same id file, different path) digests differently;
 *   - a library reached through a symlink digests the same (realpath);
 *   - without the id file the digest is empty, so a path guess cannot be
 *     brute-forced from a captured digest.
 * The digest only says "same library"; attaching still requires the task 311
 * challenge-response proof of the shared client token.
 */

export const LIBRARY_ID_FILE_NAME = ".gravityport-library-id";
// 32 random bytes are exactly 43 base64url characters.
const LIBRARY_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_CONTEXT = "gravityport-library\0";

function libraryIdPath(libraryDir) {
  return join(resolve(String(libraryDir || "")), LIBRARY_ID_FILE_NAME);
}

/**
 * Reads the library's id, creating it atomically (temp file + rename, mode
 * 0600) when missing or malformed. An existing well-formed id is never
 * rewritten, so the identity is stable for the lifetime of the directory.
 */
export async function ensureLibraryId(libraryDir) {
  const path = libraryIdPath(libraryDir);
  // The runtime calls this after the store has created the library, but the
  // helper stays self-sufficient for fresh directories.
  await mkdir(resolve(String(libraryDir || "")), { recursive: true });
  try {
    const existing = String(await readFile(path, "utf8")).trim();
    if (LIBRARY_ID_PATTERN.test(existing)) return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const id = randomBytes(32).toString("base64url");
  const tempPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(`${id}\n`, "utf8");
    await handle.close();
    await rename(tempPath, path);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw error;
  }
  return id;
}

/** Read-only lookup; "" when the file is missing or malformed. */
export async function readLibraryId(libraryDir) {
  try {
    const content = String(await readFile(libraryIdPath(libraryDir), "utf8")).trim();
    return LIBRARY_ID_PATTERN.test(content) ? content : "";
  } catch {
    return "";
  }
}

/**
 * HMAC-SHA256 over "gravityport-library\0" + realpath(libraryDir), keyed by
 * the library id, as base64url. Empty id → empty digest: callers must treat a
 * missing digest as "cannot compare", never as a match.
 */
export function libraryDigest(libraryId, libraryDir) {
  const id = String(libraryId || "");
  if (!id || !String(libraryDir || "")) return "";
  let real;
  try {
    real = realpathSync(resolve(String(libraryDir)));
  } catch {
    real = resolve(String(libraryDir));
  }
  return createHmac("sha256", id).update(DIGEST_CONTEXT).update(real).digest("base64url");
}
