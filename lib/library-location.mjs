import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

/**
 * The two default library folder names, resolved against the caller's home
 * directory. Existing libraries are never moved or renamed: the legacy
 * "MOSA Library" folder keeps working for every current user, and only a
 * machine without any library starts fresh with "GravityPort Library".
 */
export const LEGACY_LIBRARY_DIR_NAME = "MOSA Library";
export const LIBRARY_DIR_NAME = "GravityPort Library";
/**
 * The desktop shell's library-location preference file inside userData. Written
 * when the user moves the library in Settings, and since 283 also backfilled by
 * the first successful open (writeLibraryLocationFromSuccessfulOpen).
 */
export const LIBRARY_LOCATION_FILE = "library-location.json";
/** The SQLite database file inside a library; sqliteDatabasePath() builds on it. */
export const LIBRARY_DATABASE_FILE = "mosa.db";
/**
 * Media extensions GravityPort manages inside a library (originals, previews,
 * derivatives). Kept here next to directoryHasLibrary() so "is this a library"
 * and the store layer classify media identically; asset-store.mjs imports
 * these instead of keeping its own copy.
 */
export const IMAGE_EXTENSIONS = new Set([".apng", ".avif", ".gif", ".jpg", ".jpeg", ".png", ".svg", ".webp"]);
export const VIDEO_EXTENSIONS = new Set([".m4v", ".mov", ".mp4", ".webm"]);
export const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);
/**
 * Filesystem-level proof that a library's SQLite migration (or fresh
 * initialization) reached completion. Written atomically next to mosa.db;
 * library-migration.ts and createAssetStore() share this constant so the
 * marker can never drift between the two writers.
 */
export const SQLITE_MIGRATION_MARKER_FILE = ".sqlite-migration-completed";

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
  constructor(message, { libraryDir, recordedLibraryDir = null, cause } = {}) {
    super(message, { cause });
    this.name = "MosaLibraryNotFoundError";
    this.code = MOSA_LIBRARY_NOT_FOUND;
    this.libraryDir = libraryDir;
    // When set: the desktop shell's own location file records the library at
    // this path — surfaced to the user so the error can point at the real
    // library even though the configured location held none.
    this.recordedLibraryDir = recordedLibraryDir;
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
 * Whether a directory holds a real library. This is deliberately broader than
 * the backend-selection judgment (hasLegacyJsonState): a library that lost its
 * mosa.db but still holds managed media or the migration marker IS a library —
 * selecting it must lead to the store's hard error
 * (MOSA_LIBRARY_DATABASE_MISSING / SQLITE_LIBRARY_MISSING), never to silently
 * starting a fresh library in the other default folder. Only an empty folder
 * or a folder with unrelated content is "no library here".
 */
export function directoryHasLibrary(libraryDir) {
  if (!libraryDir) return false;
  const resolvedDir = resolve(libraryDir);
  if (existsSync(join(resolvedDir, LIBRARY_DATABASE_FILE))) return true;
  if (existsSync(join(resolvedDir, SQLITE_MIGRATION_MARKER_FILE))) return true;
  if (libraryHasManagedMedia(resolvedDir)) return true;
  return hasLegacyJsonState({ libraryDir: resolvedDir });
}

/**
 * Whether a directory holds legacy JSON files that only the legacy JSON store
 * can read. This is the tightened "genuinely old 0.1.x JSON library" test:
 * the legacy store keeps per-asset metadata at `assets/<project>/metadata/
 * <assetId>.json`, groups at `assets/<project>/groups.json` and prompt text
 * under `assets/<project>/prompts/`. A directory that only holds managed
 * images (an SQLite library whose mosa.db was lost) has none of those and
 * must never be opened as JSON — doing so would resume ingesting into a
 * library whose metadata already lives in the missing database.
 */
function projectHasLegacyJsonMetadata(projectDir) {
  if (existsSync(join(projectDir, "groups.json"))) return true;
  const metadataDir = join(projectDir, "metadata");
  try {
    for (const entry of readdirSync(metadataDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".json")) return true;
    }
  } catch (cause) {
    if (cause?.code !== "ENOENT" && cause?.code !== "ENOTDIR") throw cause;
  }
  try {
    for (const entry of readdirSync(join(projectDir, "prompts"), { withFileTypes: true })) {
      if (entry.isFile()) return true;
    }
  } catch (cause) {
    if (cause?.code !== "ENOENT" && cause?.code !== "ENOTDIR") throw cause;
  }
  return false;
}

/**
 * A fresh runtime may have created the legacy directory skeleton without ever
 * storing user data. Only genuine legacy JSON metadata counts as legacy state:
 * loose images, empty project folders and lock files do not. If the scan
 * itself fails, fail closed and keep JSON so uncertain data is never bypassed
 * by an automatic SQLite selection.
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
      if (!projectEntry.isDirectory()) continue;
      if (projectHasLegacyJsonMetadata(join(legacyAssetsRoot, projectEntry.name))) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * The library-location.json path the desktop shell uses by default (userData
 * of the packaged app). Electron derives userData from the package name
 * "mosa" (package.json), which must never change; this helper mirrors that
 * layout for non-Electron callers (the MCP server) so a hand-written config
 * without MOSA_LIBRARY_LOCATION_FILE still follows the library the App uses.
 */
export function desktopDefaultLocationFilePath(homeDir, { platform = process.platform, env = process.env } = {}) {
  if (platform === "darwin") {
    return join(homeDir, "Library", "Application Support", "mosa", LIBRARY_LOCATION_FILE);
  }
  if (platform === "win32") {
    const appData = env.APPDATA || join(homeDir, "AppData", "Roaming");
    return join(appData, "mosa", LIBRARY_LOCATION_FILE);
  }
  const configHome = env.XDG_CONFIG_HOME || join(homeDir, ".config");
  return join(configHome, "mosa", LIBRARY_LOCATION_FILE);
}

/**
 * Safely read the library path recorded in a library-location.json file.
 * Returns null when the file is missing or unreadable; never throws.
 */
export function readRecordedLibraryDir(locationFilePath) {
  if (!locationFilePath) return null;
  try {
    const value = JSON.parse(readFileSync(locationFilePath, "utf8"));
    return typeof value?.path === "string" && isAbsolute(value.path) ? resolve(value.path) : null;
  } catch {
    return null;
  }
}

/**
 * Atomically write a library-location.json pointing at libraryDir (same
 * layout the desktop shell's saveLibraryDir() has always produced).
 */
export function writeLibraryLocationFile(locationFilePath, libraryDir) {
  mkdirSync(dirname(locationFilePath), { recursive: true });
  const temporaryPath = `${locationFilePath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify({ path: resolve(libraryDir) })}\n`, "utf8");
  // The location file lives in userData on the same volume, so a rename gives
  // an atomic preference switch without ever exposing a partially-written path.
  renameSync(temporaryPath, locationFilePath);
}

/**
 * Record libraryDir in a library-location.json only when the file does not
 * exist yet. The desktop shell calls this after the library opened
 * successfully so a later disappearance of the default-location library is
 * reported ("library was last at ...") instead of silently replaced by a
 * fresh empty library. Never overwrites a user's recorded move; write
 * failures are reported as false and never block startup.
 */
export function writeLibraryLocationFileIfMissing(locationFilePath, libraryDir) {
  if (existsSync(locationFilePath)) return false;
  try {
    writeLibraryLocationFile(locationFilePath, libraryDir);
    return true;
  } catch {
    try { rmSync(`${locationFilePath}.tmp`, { force: true }); } catch {}
    return false;
  }
}

/**
 * The startup backfill decision for the desktop shell: with an explicit
 * MOSA_LIBRARY_DIR override (GRAVITYPORT_LIBRARY_DIR folds onto it) the
 * process is run by a developer or test against a temporary library, and that
 * path must never become the permanent recorded location — the same contract
 * as the change-library-location handler's "managed" refusal. Without the
 * override, record the library the first time it opened successfully.
 */
export function writeLibraryLocationFromSuccessfulOpen({ envLibraryDir, locationFilePath, libraryDir }) {
  if (envLibraryDir) return false;
  return writeLibraryLocationFileIfMissing(locationFilePath, libraryDir);
}

/**
 * Write the SQLite migration-completed marker next to mosa.db, atomically,
 * unless it already exists. Libraries created before the marker existed (and
 * fresh libraries) get backfilled here so a later loss of mosa.db is reported
 * instead of silently falling back to the legacy JSON backend. A failed write
 * returns false and never blocks opening a healthy library.
 */
export function ensureSqliteMigrationMarker(libraryDir) {
  const markerPath = join(resolve(libraryDir), SQLITE_MIGRATION_MARKER_FILE);
  if (existsSync(markerPath)) return true;
  const temporaryPath = `${markerPath}.tmp`;
  try {
    writeFileSync(temporaryPath, "completed\n", "utf8");
    renameSync(temporaryPath, markerPath);
    return true;
  } catch {
    try { rmSync(temporaryPath, { force: true }); } catch {}
    return false;
  }
}

const MANAGED_MEDIA_SCAN_MAX_ENTRIES = 8192;
const MANAGED_MEDIA_SCAN_MAX_DEPTH = 5;

/**
 * Whether the library directory holds media files under its managed `assets/`
 * tree (originals, previews, derivatives, trash snapshots — everything the
 * stores place below assetsRoot). This is the "library lost its mosa.db"
 * signal for both directoryHasLibrary() and createAssetStore(): managed media
 * without any database or legacy metadata means a real library that can no
 * longer be opened, not a fresh one. Symbolic links are never followed and
 * the scan stops at the first media file.
 */
export function libraryHasManagedMedia(libraryDir) {
  const assetsRoot = join(resolve(libraryDir), "assets");
  let budget = MANAGED_MEDIA_SCAN_MAX_ENTRIES;
  const scan = (directory, depth) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (budget <= 0) return false;
      budget -= 1;
      if (entry.isFile()) {
        if (MEDIA_EXTENSIONS.has(extname(entry.name).toLowerCase())) return true;
        continue;
      }
      // withFileTypes reports symlinks as symlinks (never isDirectory), so a
      // link out of the library is not followed.
      if (!entry.isDirectory() || depth >= MANAGED_MEDIA_SCAN_MAX_DEPTH) continue;
      if (scan(join(directory, entry.name), depth + 1)) return true;
    }
    return false;
  };
  return scan(assetsRoot, 0);
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
 * @param {boolean} [params.allowCreate]  Whether a machine with no library
 *     anywhere may start fresh in the new default folder. App entry points
 *     keep the default true; the MCP server passes false — it never creates a
 *     library, it reports that none was found instead.
 * @param {string} [params.fallbackLocationFile]  With allowCreate=false: the
 *     desktop shell's own library-location.json, consulted when no explicit
 *     location was configured, so a hand-written MCP config still follows a
 *     library the user moved inside the App.
 * @param {(line: string) => void} [params.log]  Optional sink for the
 *     both-defaults-exist notice. Nothing is logged to stdout by default
 *     (the MCP stdio protocol owns that stream).
 * @returns {{ libraryDir: string, source: "env"|"location-file"|"legacy-default"|"new-default"|"new-default-fresh" }}
 * @throws {MosaLibraryNotFoundError} allowCreate=false and no library was
 *     found anywhere (or the configured/recorded location holds none). Never
 *     falls back to a default or creates one.
 * @throws {MosaLibraryLocationFileError} The location file is unreadable,
 *     is not valid JSON, or does not contain an absolute path string. Never
 *     falls back to a default.
 */
export function resolveLibraryLocation({ homeDir, envLibraryDir, locationFile = "", allowCreate = true, fallbackLocationFile = "", log = null } = {}) {
  if (typeof homeDir !== "string" || !homeDir.trim()) {
    throw new Error("resolveLibraryLocation requires the caller's home directory.");
  }

  // 1. An explicit environment override always wins. App callers never check
  // existence here — the store reports a bad path. Callers that may not
  // create a library (MCP) get a hard error instead: pointing the variable at
  // an empty directory must not materialize a fresh library there.
  if (envLibraryDir) {
    const envDir = resolve(envLibraryDir);
    if (!allowCreate && !directoryHasLibrary(envDir)) {
      throw new MosaLibraryNotFoundError(
        `The configured library directory holds no GravityPort library: ${envDir}`,
        { libraryDir: envDir, recordedLibraryDir: readRecordedLibraryDir(fallbackLocationFile) },
      );
    }
    return { libraryDir: envDir, source: "env" };
  }

  // 2. A persisted desktop location is authoritative when the file exists.
  // Unlike the old loadSavedLibraryDir(), a file that cannot be understood —
  // or a recorded path without a library — stops startup instead of silently
  // falling back to the defaults and risking a fresh empty library.
  if (locationFile && existsSync(locationFile)) {
    return resolveFromLocationFile(locationFile);
  }

  // 3. MCP only: without a copied config, still follow the library the
  // desktop App itself uses. resolveFromLocationFile refuses a recorded path
  // that holds no library, so this can never invent a location.
  if (!allowCreate && fallbackLocationFile && existsSync(fallbackLocationFile)) {
    return resolveFromLocationFile(fallbackLocationFile);
  }

  // 4–6. No explicit location: prefer the legacy folder so long-time users
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
  if (!allowCreate) {
    throw new MosaLibraryNotFoundError(
      `No GravityPort library was found in the default folders; open GravityPort first`,
      { libraryDir: nextDir, recordedLibraryDir: readRecordedLibraryDir(fallbackLocationFile) },
    );
  }
  return { libraryDir: nextDir, source: "new-default-fresh" };
}

/**
 * Library directory for the background runtime: the macOS supervisor and the
 * server it starts with MOSA_BACKGROUND_RUNTIME=1. It uses the same lookup as
 * the MCP server (the desktop location file counts, nothing is ever created),
 * so a library the user moved inside the App is never replaced by an empty
 * one in a default folder. Throws the same errors as resolveLibraryLocation.
 */
export function resolveBackgroundLibraryDir({ homeDir, envLibraryDir } = {}) {
  return resolveLibraryLocation({
    homeDir,
    envLibraryDir,
    allowCreate: false,
    fallbackLocationFile: desktopDefaultLocationFilePath(homeDir),
  }).libraryDir;
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
