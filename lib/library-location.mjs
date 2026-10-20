import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/**
 * The two default library folder names, resolved against the caller's home
 * directory. Existing libraries are never moved or renamed: the legacy
 * "MOSA Library" folder keeps working for every current user, and only a
 * machine without any library starts fresh with "GravityPort Library".
 */
export const LEGACY_LIBRARY_DIR_NAME = "MOSA Library";
export const LIBRARY_DIR_NAME = "GravityPort Library";
/**
 * The desktop shell's library-location preference file inside userData. Only
 * written when the user moves the library in Settings, never at startup.
 */
export const LIBRARY_LOCATION_FILE = "library-location.json";
/** The SQLite database file inside a library; sqliteDatabasePath() builds on it. */
export const LIBRARY_DATABASE_FILE = "mosa.db";

export function legacyDefaultLibraryDir(homeDir) {
  return join(homeDir, LEGACY_LIBRARY_DIR_NAME);
}

export function defaultLibraryDir(homeDir) {
  return join(homeDir, LIBRARY_DIR_NAME);
}

/** The recorded library cannot be found; the app must not fall back or create one. */
export const MOSA_LIBRARY_NOT_FOUND = "MOSA_LIBRARY_NOT_FOUND";
/** The location file exists but cannot be understood; the app must not fall back or create one. */
export const MOSA_LIBRARY_LOCATION_FILE_UNREADABLE = "MOSA_LIBRARY_LOCATION_FILE_UNREADABLE";

export class MosaLibraryNotFoundError extends Error {
  constructor(message, { libraryDir, cause } = {}) {
    super(message, { cause });
    this.name = "MosaLibraryNotFoundError";
    this.code = MOSA_LIBRARY_NOT_FOUND;
    this.libraryDir = libraryDir;
  }
}

export class MosaLibraryLocationFileError extends Error {
  constructor(message, { locationFile, cause } = {}) {
    super(message, { cause });
    this.name = "MosaLibraryLocationFileError";
    this.code = MOSA_LIBRARY_LOCATION_FILE_UNREADABLE;
    this.locationFile = locationFile;
  }
}

/**
 * Whether a directory holds a real library: a SQLite database, or a legacy
 * JSON library. The SQLite side is the same file `sqliteDatabasePath()` in
 * the store layer opens (both read LIBRARY_DATABASE_FILE); the legacy-JSON
 * side is the exact detection `createAssetStore()`
 * uses to pick a backend, extracted here so location resolution and store
 * selection can never disagree. An empty folder is not a library.
 */
export function directoryHasLibrary(libraryDir) {
  if (!libraryDir) return false;
  if (existsSync(join(resolve(libraryDir), LIBRARY_DATABASE_FILE))) return true;
  return hasLegacyJsonState({ libraryDir });
}

/**
 * A fresh runtime may have created the legacy directory skeleton without ever
 * storing user data. Treat only meaningful entries as legacy state. If the
 * scan itself fails, fail closed and keep JSON so uncertain data is never
 * bypassed by an automatic SQLite selection. (Extracted verbatim from
 * lib/asset-store.mjs's createAssetStore detection so both callers share one
 * implementation.)
 */
export function hasLegacyJsonState(options = {}) {
  const projectRoot = resolve(options.projectRoot || process.cwd());
  const managerDir = resolve(options.managerDir || join(projectRoot, "mosa"));
  const configuredLibraryDir = options.libraryDir || process.env.MOSA_LIBRARY_DIR || null;
  const explicitLibraryDir = Object.hasOwn(options, "explicitLibraryDir")
    ? options.explicitLibraryDir
    : configuredLibraryDir;
  const legacyAssetsRoot = resolve(options.assetsRoot || (explicitLibraryDir
    ? join(resolve(explicitLibraryDir), "assets")
    : join(managerDir, "assets")));

  if (!existsSync(legacyAssetsRoot)) return false;
  try {
    for (const projectEntry of readdirSync(legacyAssetsRoot, { withFileTypes: true })) {
      if (!projectEntry.isDirectory()) return true;
      const projectDir = join(legacyAssetsRoot, projectEntry.name);
      for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (readdirSync(join(projectDir, entry.name)).length > 0) return true;
          continue;
        }
        // Lock files are transient coordination state, not user library data.
        if (!entry.name.endsWith(".lock") && !entry.name.endsWith(".cleanup")) return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Resolve which library directory this process should use. Synchronous and
 * strictly read-only: nothing is created, and only the new-user default may
 * point at a directory that does not exist yet (the store creates it later).
 *
 * @param {object} params
 * @param {string} params.homeDir  The caller's home directory; always passed
 *     in (never read here) so sandboxes can redirect it.
 * @param {string|undefined} params.envLibraryDir  Value of MOSA_LIBRARY_DIR.
 * @param {string} [params.locationFile]  Path to a library-location.json
 *     preference file. Only the desktop shell passes one; CLI, MCP and
 *     daemons keep ignoring it.
 * @param {(line: string) => void} [params.log]  Optional sink for the
 *     both-defaults-exist notice. Nothing is logged to stdout by default
 *     (the MCP stdio protocol owns that stream).
 * @returns {{ libraryDir: string, source: "env"|"location-file"|"legacy-default"|"new-default"|"new-default-fresh" }}
 * @throws {MosaLibraryNotFoundError} The location file names a path that
 *     holds no library. Never falls back to a default.
 * @throws {MosaLibraryLocationFileError} The location file is unreadable,
 *     is not valid JSON, or does not contain an absolute path string. Never
 *     falls back to a default.
 */
export function resolveLibraryLocation({ homeDir, envLibraryDir, locationFile = "", log = null } = {}) {
  if (typeof homeDir !== "string" || !homeDir.trim()) {
    throw new Error("resolveLibraryLocation requires the caller's home directory.");
  }

  // 1. An explicit environment override always wins, exactly as before:
  // existence is never checked here and the store reports a bad path.
  if (envLibraryDir) {
    return { libraryDir: resolve(envLibraryDir), source: "env" };
  }

  // 2. A persisted desktop location is authoritative when the file exists.
  // Unlike the old loadSavedLibraryDir(), a file that cannot be understood —
  // or a recorded path without a library — stops startup instead of silently
  // falling back to the defaults and risking a fresh empty library.
  if (locationFile && existsSync(locationFile)) {
    return resolveFromLocationFile(locationFile);
  }

  // 3–5. No explicit location: prefer the legacy folder so long-time users
  // keep their library, then the new default folder, and only a machine with
  // neither starts fresh in the new default.
  const legacyDir = legacyDefaultLibraryDir(homeDir);
  const nextDir = defaultLibraryDir(homeDir);
  const legacyHasLibrary = directoryHasLibrary(legacyDir);
  if (legacyHasLibrary) {
    if (directoryHasLibrary(nextDir)) {
      log?.(`Both ${LEGACY_LIBRARY_DIR_NAME} and ${LIBRARY_DIR_NAME} under ${homeDir} contain a library; using ${legacyDir}.`);
    }
    return { libraryDir: legacyDir, source: "legacy-default" };
  }
  if (directoryHasLibrary(nextDir)) {
    return { libraryDir: nextDir, source: "new-default" };
  }
  return { libraryDir: nextDir, source: "new-default-fresh" };
}

function resolveFromLocationFile(locationFile) {
  let raw;
  try {
    raw = readFileSync(locationFile, "utf8");
  } catch (cause) {
    throw new MosaLibraryLocationFileError(
      `The library location file could not be read: ${locationFile}`,
      { locationFile, cause },
    );
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new MosaLibraryLocationFileError(
      `The library location file is not valid JSON: ${locationFile}`,
      { locationFile, cause },
    );
  }
  if (typeof value?.path !== "string" || !isAbsolute(value.path)) {
    throw new MosaLibraryLocationFileError(
      `The library location file does not contain an absolute path: ${locationFile}`,
      { locationFile },
    );
  }
  const savedLibraryDir = resolve(value.path);
  if (!directoryHasLibrary(savedLibraryDir)) {
    throw new MosaLibraryNotFoundError(
      `The recorded library location does not contain a library: ${savedLibraryDir}`,
      { libraryDir: savedLibraryDir },
    );
  }
  return { libraryDir: savedLibraryDir, source: "location-file" };
}
