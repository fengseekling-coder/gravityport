import "../lib/apply-env-aliases.mjs";
import readline from "node:readline";
import { homedir } from "node:os";
import { statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { readdir, realpath, stat } from "node:fs/promises";
import { createAssetStore } from "../lib/asset-store.mjs";
import { TRASH_RETENTION_MS } from "../lib/sqlite-asset-store.mjs";
import { assetStoreError } from "../lib/asset-version-history.mjs";
import { assertExternalVerificationLevel } from "../lib/generation-history.mjs";
import { searchMcpAssets } from "../lib/mcp-asset-search.mjs";
import { createAssetViaGate, untrustedCreateSource } from "../lib/library-ingest.mjs";
import { withUserEditMarkers } from "../lib/user-edit-marker.mjs";
import { buildAssetProvenanceBundle } from "../lib/provenance-bundle.mjs";
import {
  desktopDefaultLocationFilePath,
  LIBRARY_DATABASE_FILE,
  MEDIA_EXTENSIONS,
  MOSA_LIBRARY_LOCATION_FILE_UNREADABLE,
  MOSA_LIBRARY_NOT_FOUND,
  resolveLibraryLocation,
} from "../lib/library-location.mjs";
import { acquireMosaRuntimeLock } from "../lib/runtime-lock.js";
import { hasRelocationMarker } from "../lib/library-relocation.mjs";
import { redactDiagnostics } from "../lib/diagnostic-log.mjs";
import { MCP_SERVER_VERSION } from "../lib/version-identities.mjs";

const managerDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
// Inside the desktop app (ELECTRON_RUN_AS_NODE) the client picks the working
// directory, often "/", so the app bundle itself stands in for the project root.
const projectRoot = resolve(process.env.MOSA_PROJECT_DIR || (process.versions.electron ? managerDir : process.cwd()));
// MOSA_LIBRARY_LOCATION_FILE points at the desktop's library-location.json, so a
// config copied from Settings keeps following the library after it is moved.
// No log sink here: the MCP stdio protocol owns stdout.
const locationFile = process.env.MOSA_LIBRARY_LOCATION_FILE ? resolve(process.env.MOSA_LIBRARY_LOCATION_FILE) : "";
// A hand-written config (no MOSA_LIBRARY_LOCATION_FILE) still follows the
// library the desktop App itself uses, and the MCP server never creates a
// library: allowCreate=false turns "nothing found anywhere" into an error.
function resolveCurrentLibraryDir() {
  return resolveLibraryLocation({
    homeDir: homedir(),
    envLibraryDir: process.env.MOSA_LIBRARY_DIR,
    locationFile,
    allowCreate: false,
    fallbackLocationFile: desktopDefaultLocationFilePath(homedir()),
  }).libraryDir;
}
function describeLibraryStartupError(error) {
  if (error?.code === MOSA_LIBRARY_NOT_FOUND) {
    const lines = [
      error.libraryDir
        ? `在 ${error.libraryDir} 没有找到 GravityPort 素材库。请先打开 GravityPort；MCP 不会新建素材库。`
        : "没有找到 GravityPort 素材库。请先打开 GravityPort；MCP 不会新建素材库。",
    ];
    if (error.recordedLibraryDir) lines.push(`GravityPort 记录的素材库位置是 ${error.recordedLibraryDir}。`);
    lines.push(
      error.libraryDir
        ? `No GravityPort library was found at ${error.libraryDir}. Open GravityPort first; the MCP server never creates a library.`
        : "No GravityPort library was found. Open GravityPort first; the MCP server never creates a library.",
    );
    if (error.recordedLibraryDir) lines.push(`GravityPort last recorded the library at ${error.recordedLibraryDir}.`);
    return lines.join("\n");
  }
  if (error?.code === MOSA_LIBRARY_LOCATION_FILE_UNREADABLE) {
    return `读不出素材库位置记录文件：${error.locationFile}。GravityPort could not read its library location file: ${error.locationFile}`;
  }
  return null;
}
// A missing or unreadable library no longer stops the server (task 362): it
// still answers initialize and tools/list, so an assistant can see the tools
// before GravityPort has ever been opened, and every tool call retries the
// library first. Until one opens, calls answer LIBRARY_NOT_FOUND or
// LIBRARY_UNAVAILABLE with the same bilingual reason stderr gets; nothing is
// created anywhere. All of the state below stays unset until openLibrary()
// succeeds.
let libraryDir;
let store = null;
let databasePath = "";
let databaseIdentity = null;
let directStoreLease = null;
let directStoreClosed = false;
let openingLibrary = null;
// Task 315: one redacted stderr line per uncaught crash, then Node's default
// exit. stdout must stay protocol-only. No unhandledRejection listener: Node's
// default mode raises unhandled rejections as uncaught exceptions, and
// catching them would change the exit behavior.
process.on("uncaughtExceptionMonitor", (error) => {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error && error.stack ? `\n${error.stack}` : "";
  const described = redactDiagnostics(`[MOSA] uncaught exception ${name}: ${message}${stack}`, { homeDir: homedir(), libraryDir });
  process.stderr.write(`${described}\n`);
});
// The default library location still participates in SQLite detection, but the JSON
// store only reroots its assets into it when a library was named explicitly. Launched
// from the desktop app (or following its location file), MCP uses the same library
// layout as the desktop runtime.
const desktopMode = Boolean(process.versions.electron || locationFile);
const STORE_UNAVAILABLE_CODES = new Set([
  "MOSA_LIBRARY_DATABASE_MISSING",
  "MOSA_LIBRARY_STATE_INVALID",
  "SQLITE_LIBRARY_MISSING",
]);

/**
 * Returns null once the library is open, or { code, message } when it is
 * missing (LIBRARY_NOT_FOUND) or present but unusable (LIBRARY_UNAVAILABLE).
 * Any other error still throws: an unexpected failure is not a missing library.
 */
async function openLibrary() {
  if (store) return null;
  let resolvedDir;
  try {
    resolvedDir = resolveCurrentLibraryDir();
  } catch (error) {
    const described = describeLibraryStartupError(error);
    if (!described) throw error;
    const code = error.code === MOSA_LIBRARY_NOT_FOUND ? "LIBRARY_NOT_FOUND" : "LIBRARY_UNAVAILABLE";
    return { code, message: described };
  }
  const explicitLibraryDir = desktopMode || process.env.MOSA_LIBRARY_DIR ? resolvedDir : null;
  let opened;
  try {
    opened = createAssetStore({
      projectRoot,
      managerDir,
      libraryDir: resolvedDir,
      explicitLibraryDir,
      ...(desktopMode ? { assetsRoot: join(resolvedDir, "assets"), generatedImagesDir: join(resolvedDir, "imports") } : {}),
    });
  } catch (error) {
    // A configured directory that holds a broken library (managed media without
    // mosa.db, a database that never completed) is reported with the store's
    // bilingual message — never fall through to any other location.
    if (STORE_UNAVAILABLE_CODES.has(error?.code)) return { code: "LIBRARY_UNAVAILABLE", message: error.message };
    throw error;
  }
  // SQLite uses WAL plus insert-only managed filenames for safe App+MCP coexistence.
  //
  // SQLite WAL mode lets one writer and many readers operate concurrently against
  // the same database file. Each connection holds an independent WAL snapshot,
  // so the App (HTTP UI) and the MCP stdio server can be running at the same time
  // without blocking each other. The store is configured with:
  //   journal_mode = WAL
  //   busy_timeout = 5000   (5s wait for the writer lock before failing)
  //   cache_size = -20000   (20 MB page cache)
  //   temp_store = MEMORY   (temp tables never touch disk)
  //   foreign_keys = ON
  // A writer commit waits at most 5 s for any active reader snapshot, which is
  // well below the typical interactive request budget.
  //
  // Originals are managed as insert-only content-hash filenames inside the
  // library directory, so the filesystem never mutates a file in place. The
  // SQLite store is therefore authoritative for metadata; concurrent writers
  // from MCP and App only ever produce additive metadata rows. That is what
  // makes the JSON fallback (which has no cross-process transaction support)
  // unable to share the same contract.
  //
  // The legacy JSON backend has no cross-process metadata transaction, so it
  // must share the runtime's exclusive lease instead of allowing two writers
  // to race over JSON files. JSON mode therefore *cannot* coexist with an
  // active App or another MCP writer; the lock below makes that explicit.
  let lease = null;
  if (opened.storageKind === "json") {
    try {
      lease = await acquireMosaRuntimeLock({ libraryDir: resolvedDir });
    } catch (error) {
      opened.close?.();
      throw error;
    }
  }
  // Record the mosa.db file identity (device + inode) the store was opened
  // against. A later move or deletion of the library changes or removes that
  // file; every tool call re-stats it so no write can land in a library that is
  // no longer the one this server opened. The legacy JSON backend has no
  // mosa.db to watch; its moves are covered by the location-file check below.
  const openedDatabasePath = join(resolvedDir, LIBRARY_DATABASE_FILE);
  let identity = null;
  try {
    const databaseInfo = statSync(openedDatabasePath);
    if (databaseInfo.isFile()) identity = { dev: databaseInfo.dev, ino: databaseInfo.ino };
  } catch {
    identity = null;
  }
  libraryDir = resolvedDir;
  databasePath = openedDatabasePath;
  databaseIdentity = identity;
  directStoreLease = lease;
  store = opened;
  return null;
}

/** One open attempt at a time: concurrent tool calls share it. */
function ensureLibraryOpen() {
  if (store) return Promise.resolve(null);
  if (!openingLibrary) {
    openingLibrary = openLibrary().finally(() => { openingLibrary = null; });
  }
  return openingLibrary;
}

const startupFailure = await ensureLibraryOpen();
if (startupFailure) process.stderr.write(`${startupFailure.message}\n`);

async function closeDirectStore() {
  if (directStoreClosed) return;
  directStoreClosed = true;
  try { store?.close?.(); } finally { await directStoreLease?.release().catch(() => {}); }
}

const TOOL_ASSET_CREATE = "asset_create";
const TOOL_ASSET_IMPORT_FOLDER = "asset_import_folder";
const TOOL_ASSET_LIST = "asset_list";
const TOOL_ASSET_SEARCH = "asset_search";
const TOOL_ASSET_GET = "asset_get";
const TOOL_ASSET_PROVENANCE_EXPORT = "asset_provenance_export";
const TOOL_ASSET_UPDATE_METADATA = "asset_update_metadata";
const TOOL_ASSET_ATTACH_PROMPT = "asset_attach_prompt";
const TOOL_ASSET_TRASH = "asset_trash";
const TOOL_ASSET_RESTORE = "asset_restore";
const TOOL_ASSET_DUPLICATE = "asset_duplicate";
const TOOL_ASSET_VERSION_CREATE = "asset_version_create";
const TOOL_ASSET_VERSION_HISTORY = "asset_version_history";
const TOOL_ASSET_RECIPE_HISTORY = "asset_recipe_history";
const TOOL_GENERATION_RECORD = "generation_record";
const TOOL_GENERATION_LIST = "generation_list";
const TOOL_GENERATION_RELATION_RECORD = "generation_relation_record";
const TOOL_GENERATION_LINEAGE = "generation_lineage";
const TOOL_STACK_CREATE = "stack_create";
const TOOL_STACK_ADD_ASSETS = "stack_add_assets";
const TOOL_STACK_RENAME = "stack_rename";
const TOOL_STACK_REMOVE_ASSETS = "stack_remove_assets";
const TOOL_STACK_DISSOLVE = "stack_dissolve";
const TOOL_STACK_GET = "stack_get";
const TOOL_STACK_LIST = "stack_list";

// Task 334: MCP tool annotations. Read tools never write; the only destructive
// tool is asset_trash (moves to Trash); nothing reaches out to other systems,
// so every tool declares openWorldHint: false. destructiveHint is spelled out
// everywhere because the MCP default for a missing hint is true.
const TOOL_ANNOTATIONS = {
  [TOOL_ASSET_CREATE]: { readOnlyHint: false, destructiveHint: false },
  [TOOL_ASSET_IMPORT_FOLDER]: { readOnlyHint: false, destructiveHint: false },
  [TOOL_ASSET_LIST]: { readOnlyHint: true, destructiveHint: false },
  [TOOL_ASSET_SEARCH]: { readOnlyHint: true, destructiveHint: false },
  [TOOL_ASSET_GET]: { readOnlyHint: true, destructiveHint: false },
  [TOOL_ASSET_PROVENANCE_EXPORT]: { readOnlyHint: true, destructiveHint: false },
  [TOOL_ASSET_UPDATE_METADATA]: { readOnlyHint: false, destructiveHint: false },
  [TOOL_ASSET_ATTACH_PROMPT]: { readOnlyHint: false, destructiveHint: false },
  [TOOL_ASSET_TRASH]: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  [TOOL_ASSET_RESTORE]: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  [TOOL_ASSET_DUPLICATE]: { readOnlyHint: false, destructiveHint: false },
  [TOOL_ASSET_VERSION_CREATE]: { readOnlyHint: false, destructiveHint: false },
  [TOOL_ASSET_VERSION_HISTORY]: { readOnlyHint: true, destructiveHint: false },
  [TOOL_ASSET_RECIPE_HISTORY]: { readOnlyHint: true, destructiveHint: false },
  [TOOL_GENERATION_RECORD]: { readOnlyHint: false, destructiveHint: false },
  [TOOL_GENERATION_LIST]: { readOnlyHint: true, destructiveHint: false },
  [TOOL_GENERATION_RELATION_RECORD]: { readOnlyHint: false, destructiveHint: false },
  [TOOL_GENERATION_LINEAGE]: { readOnlyHint: true, destructiveHint: false },
  [TOOL_STACK_CREATE]: { readOnlyHint: false, destructiveHint: false },
  [TOOL_STACK_ADD_ASSETS]: { readOnlyHint: false, destructiveHint: false },
  [TOOL_STACK_RENAME]: { readOnlyHint: false, destructiveHint: false },
  [TOOL_STACK_REMOVE_ASSETS]: { readOnlyHint: false, destructiveHint: true },
  [TOOL_STACK_DISSOLVE]: { readOnlyHint: false, destructiveHint: true },
  [TOOL_STACK_GET]: { readOnlyHint: true, destructiveHint: false },
  [TOOL_STACK_LIST]: { readOnlyHint: true, destructiveHint: false },
};

// Folder import limits; the max-files override is a test knob.
function importFolderMaxFiles() {
  const parsed = Number.parseInt(process.env.MOSA_MCP_IMPORT_FOLDER_MAX_FILES || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
}
const IMPORT_FOLDER_MAX_DEPTH = 5;

const EXTERNAL_VERIFICATION_SCHEMA = {
  enum: ["user_confirmed", "observed", "inferred"],
  description: "Evidence level for this externally supplied record. provider_verified is reserved for trusted GravityPort provider integrations.",
};

const REFERENCE_SCHEMA = {
  type: "array",
  items: {
    anyOf: [
      { type: "string" },
      {
        type: "object",
        properties: {
          asset_id: { type: "string" },
          sha256: { type: "string" },
          role: { type: "string" },
          scope: { type: "array", items: { type: "string" } },
          applied: { type: "boolean" },
          allowed_uses: {
            type: "array",
            items: { type: "string" },
            description: "Purposes this reference may serve, for example identity, style, world, wardrobe, composition. Once set, any purpose outside the list is treated as forbidden.",
          },
          forbidden_uses: {
            type: "array",
            items: { type: "string" },
            description: "Purposes this reference must not serve. A forbidden use always overrides the same allowed use.",
          },
          rights: {
            type: "object",
            description: "Rights declarations for the reference image. Unstated fields stay unknown; silence is never recorded as permission.",
            properties: {
              copyright: { enum: ["unknown", "owned", "licensed", "third-party"] },
              portrait_consent: { enum: ["unknown", "granted", "not-required", "denied"] },
              redistribution: { enum: ["unknown", "allowed", "forbidden"] },
              attribution: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: true,
      },
    ],
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolDefinitions() {
  return [
    {
      name: TOOL_ASSET_CREATE,
      description: "Copy an image into the GravityPort library and save prompt recipe metadata. The image path must be an absolute path on this machine. Symbolic links are rejected. Only supported image and video formats are imported. Identical bytes already in the library (outside Trash) return the existing asset with deduplicated: true instead of creating a copy.",
      inputSchema: {
        type: "object",
        properties: {
          imagePath: { type: "string", description: "Absolute path of the image on this machine." },
          prompt: { type: "string" },
          user_prompt: { type: "string", description: "Optional user request kept separately from the effective generation prompt." },
          negative_prompt: { type: "string" },
          references: REFERENCE_SCHEMA,
          skill: { type: "string" },
          style: { type: "string" },
          ratio: { type: "string" },
          theme: { type: "string" },
          business_fields: { type: "object", description: "Stored with the asset but not searchable; put anything that should be findable via search into tags instead." },
          tags: { type: "array", items: { type: "string" }, description: "Tags saved with the asset; searchable." },
          favorite: { type: "boolean", description: "Mark the asset as a favorite." },
          group: { type: "string", description: "Group the asset is filed under; grouping, not a project." },
          category: { type: "string", description: "Category label shown in the app." },
          rating: { type: "integer", minimum: 0, maximum: 5, description: "Star rating from 0 (unrated) to 5." },
          parent_asset_id: { type: "string" },
          version_change: { type: "string" },
          sourceType: { type: "string", description: "Optional source type. Defaults to codex-generated for images under <CODEX_HOME>/generated_images (normally the user's .codex/generated_images)." },
          source: {
            type: "object",
            description: "Optional generation provenance, such as generation_tool, model, codex_session_id, or codex_thread_id. The original image path and Codex task ID are detected automatically.",
            additionalProperties: true
          }
        },
        required: ["imagePath"],
        additionalProperties: true
      }
    },
    {
      name: TOOL_ASSET_IMPORT_FOLDER,
      description: "Import every image and video found in a local folder into the GravityPort library, applying the same prompt/sourceType/source to each file. The folder path must be an absolute path on this machine. Symbolic links are skipped; with recursive: true subfolders are read up to 5 levels deep; a single call imports at most 1000 files, otherwise it fails and asks for batches. Identical bytes already in the library are reported as deduplicated. Files import one by one; a failed file is reported and does not stop the rest. Files already in the library are listed in duplicates with the existing assetId.",
      inputSchema: {
        type: "object",
        properties: {
          folderPath: { type: "string", description: "Absolute path of the folder to import." },
          recursive: { type: "boolean", description: "Also read subfolders (default false; at most 5 levels deep)." },
          prompt: { type: "string" },
          sourceType: { type: "string" },
          source: {
            type: "object",
            description: "Optional generation provenance applied to every imported file, such as generation_tool, model, or codex_session_id.",
            additionalProperties: true
          }
        },
        required: ["folderPath"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_ASSET_LIST,
      description: "List saved GravityPort assets for a project, optionally filtered by search text. Returns compact per-asset summaries with the total count (20 per page by default, at most 100; pass `cursor` to page further); use asset_get for an asset's full recipe and metadata.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100, default: 20 }, cursor: { type: "string" } },
        additionalProperties: false
      }
    },
    {
      name: TOOL_ASSET_SEARCH,
      description: "Search GravityPort visual memory using lexical search and explicit creation-time bounds. Returns compact per-asset summaries with the total match count (20 per page by default, at most 100; pass `cursor` to page further); use asset_get for an asset's full recipe and metadata.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          createdAfter: { type: "string", description: "Inclusive ISO-8601 lower creation-time bound." },
          createdBefore: { type: "string", description: "Inclusive ISO-8601 upper creation-time bound." },
          // Deprecated: local visual retrieval was removed. Both properties stay
          // declared so clients with a cached older schema may still send
          // `visual` / `minScore`; they are accepted and ignored (lexical search runs).
          visual: { type: "boolean", description: "Deprecated and ignored." },
          minScore: { type: "number", description: "Deprecated and ignored." },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          cursor: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    {
      name: TOOL_ASSET_GET,
      description: "Get one saved asset and its full prompt recipe. asset_list and asset_search return only compact summaries; call this for the full recipe and metadata.",
      inputSchema: {
        type: "object",
        properties: { assetId: { type: "string" } },
        required: ["assetId"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_ASSET_PROVENANCE_EXPORT,
      description: "Export a portable GravityPort provenance bundle plus an unsigned C2PA assertion payload. Prompts and user messages are excluded by default; pass includePrompts: true only when the user explicitly asks to include prompts. Local filesystem paths and usernames are never exported under any circumstances. This does not create a signed Content Credential; a C2PA signer must bind and sign the assertion separately.",
      inputSchema: {
        type: "object",
        properties: {
          assetId: { type: "string" },
          includePrompts: {
            type: "boolean",
            description: "Whether to include prompts and user messages. Defaults to false; pass true only when the user explicitly requests prompts. Local filesystem paths and usernames are never exported under any circumstances.",
          },
        },
        required: ["assetId"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_ASSET_TRASH,
      description: "Move an asset to Trash. Trashed assets can be restored with asset_restore or inside the GravityPort app, and are permanently purged after 90 days. Use this when the user asks to delete or remove an asset. Do NOT use this when the user asks to archive or stash an asset.",
      inputSchema: {
        type: "object",
        properties: { assetId: { type: "string" } },
        required: ["assetId"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_ASSET_RESTORE,
      description: "Restore an asset from Trash back to the active library.",
      inputSchema: {
        type: "object",
        properties: { assetId: { type: "string" } },
        required: ["assetId"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_ASSET_DUPLICATE,
      description: "Create an independent editable copy that starts a new version root while retaining duplicate provenance.",
      inputSchema: {
        type: "object",
        properties: { assetId: { type: "string" }, assetIdNew: { type: "string" } },
        required: ["assetId"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_ASSET_VERSION_CREATE,
      description: "Save a new recipe version as a child of an existing asset without overwriting the parent.",
      inputSchema: {
        type: "object",
        properties: {
          assetId: { type: "string", description: "Existing parent asset ID." },
          assetIdNew: { type: "string", description: "Optional ID for the new version." },
          imagePath: { type: "string", description: "Optional new image path; must be an absolute path on this machine (any local folder is accepted, same as asset_create). When omitted, the parent image is copied for a recipe-only version." },
          version_change: { type: "string", minLength: 1, description: "Required summary of what changed from the parent." },
          prompt: { type: "string" },
          user_prompt: { type: "string", description: "Optional user request kept separately from the effective generation prompt." },
          negative_prompt: { type: "string" },
          references: REFERENCE_SCHEMA,
          skill: { type: "string" },
          style: { type: "string" },
          ratio: { type: "string" },
          theme: { type: "string" },
          business_fields: { type: "object", description: "Stored with the asset but not searchable; put anything that should be findable via search into tags instead." },
          tags: { type: "array", items: { type: "string" } },
          favorite: { type: "boolean" },
          group: { type: "string" },
          category: { type: "string" },
          rating: { type: "integer", minimum: 0, maximum: 5 },
          sourceType: { type: "string" },
          source: {
            type: "object",
            description: "Optional provenance for a replacement image, such as generation_tool, model, or codex_session_id.",
            additionalProperties: true
          }
        },
        required: ["assetId", "version_change"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_ASSET_VERSION_HISTORY,
      description: "Read the complete root-to-descendant recipe version tree for an asset, including archived versions.",
      inputSchema: {
        type: "object",
        properties: { assetId: { type: "string" } },
        required: ["assetId"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_ASSET_RECIPE_HISTORY,
      description: "Read immutable generation recipe snapshots for one asset and identify the currently active snapshot.",
      inputSchema: {
        type: "object",
        properties: { assetId: { type: "string" } },
        required: ["assetId"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_ASSET_UPDATE_METADATA,
      description: "Update metadata fields for a saved asset. Pass `references` to record reference rights and permitted uses for a saved asset; that annotation is not a generation input, so it appends a new recipe snapshot.",
      inputSchema: {
        type: "object",
        properties: {
          assetId: { type: "string" },
          prompt: { type: "string" },
          user_prompt: { type: "string" },
          negative_prompt: { type: "string" },
          references: REFERENCE_SCHEMA,
          skill: { type: "string" },
          style: { type: "string" },
          ratio: { type: "string" },
          theme: { type: "string" },
          business_fields: { type: "object", description: "Stored with the asset but not searchable; put anything that should be findable via search into tags instead. Only the keys you pass are merged into the stored object: a key whose value is null is removed, and every other stored key is kept unchanged." },
          tags: { type: "array", items: { type: "string" } },
          favorite: { type: "boolean" },
          group: { type: "string" },
          category: { type: "string" },
          rating: { type: "integer", minimum: 0, maximum: 5 },
          recipe_change_summary: { type: "string" },
        },
        required: ["assetId"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_ASSET_ATTACH_PROMPT,
      description: "Attach or replace the full prompt recipe for a saved asset.",
      inputSchema: {
        type: "object",
        properties: { assetId: { type: "string" }, prompt: { type: "string" } },
        required: ["assetId", "prompt"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_GENERATION_RECORD,
      description: "Record one generation occurrence independently from the deduplicated output asset. Use this when an agent knows that a specific generation produced a saved GravityPort asset.",
      inputSchema: {
        type: "object",
        properties: {
          outputAssetId: { type: "string", description: "Existing GravityPort asset produced by this generation." },
          provider: { type: "string" },
          captureContextId: { type: "string", description: "GravityPort/local observation context. This is not a provider generation-call ID." },
          providerToolCallId: { type: "string", description: "Provider/runtime tool-call identifier when observed." },
          providerGenerationCallId: { type: "string", description: "Provider generation-call identifier only when actually supplied by the provider integration." },
          providerResponseId: { type: "string" },
          providerAssetId: { type: "string" },
          conversationId: { type: "string" },
          messageId: { type: "string" },
          batchId: { type: "string" },
          model: { type: "string" },
          userPrompt: { type: "string" },
          effectivePrompt: { type: "string" },
          promptStatus: { type: "string" },
          captureChannel: { type: "string" },
          verificationLevel: EXTERNAL_VERIFICATION_SCHEMA,
          references: REFERENCE_SCHEMA,
          evidence: { type: "object", additionalProperties: true },
          createdAt: { type: "string" },
        },
        required: ["outputAssetId"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_GENERATION_LIST,
      description: "List generation occurrences, optionally filtered by output asset or provider identifiers.",
      inputSchema: {
        type: "object",
        properties: {
          assetId: { type: "string" },
          captureContextId: { type: "string" },
          providerToolCallId: { type: "string" },
          providerGenerationCallId: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    {
      name: TOOL_GENERATION_RELATION_RECORD,
      description: "Record an explicit generation-to-generation relationship such as edited_from or variant_of. Do not infer a parent unless the evidence supports it.",
      inputSchema: {
        type: "object",
        properties: {
          childGenerationId: { type: "string" },
          parentGenerationId: { type: "string" },
          relationType: { enum: ["edited_from", "variant_of", "derived_from", "based_on"] },
          verificationLevel: EXTERNAL_VERIFICATION_SCHEMA,
          evidence: { type: "object", additionalProperties: true },
          createdAt: { type: "string" },
        },
        required: ["childGenerationId", "parentGenerationId"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_GENERATION_LINEAGE,
      description: "Read the connected generation lineage graph around one generation event, including parent/child IDs and evidence-bearing relations.",
      inputSchema: {
        type: "object",
        properties: { generationId: { type: "string" } },
        required: ["generationId"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_STACK_CREATE,
      description: "Group two or more saved assets into a new stack, the same as stacking a selection in the GravityPort app. coverAssetId defaults to the first asset. name (optional, at most 80 characters) is the stack's display name. An asset can belong to only one stack: if any asset is already in a stack the call fails with ASSET_ALREADY_STACKED and nothing changes; take it out with stack_remove_assets first. To show the same image in several stacks, copy it with asset_duplicate and stack the copy. Archived assets cannot be stacked.",
      inputSchema: {
        type: "object",
        properties: {
          assetIds: { type: "array", items: { type: "string" }, maxItems: 2000 },
          coverAssetId: { type: "string" },
          name: { type: "string", maxLength: 80 },
        },
        required: ["assetIds"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_STACK_ADD_ASSETS,
      description: "Add saved assets to an existing stack, after its current members. Assets already in this stack are skipped and listed in alreadyInStack. If any asset belongs to a different stack the call fails with ASSET_ALREADY_STACKED and nothing changes.",
      inputSchema: {
        type: "object",
        properties: {
          stackId: { type: "string" },
          assetIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2000 },
        },
        required: ["stackId", "assetIds"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_STACK_RENAME,
      description: "Set a stack's display name (trimmed, 1 to 80 characters). The name is kept even when the stack was created automatically from a conversation.",
      inputSchema: {
        type: "object",
        properties: {
          stackId: { type: "string" },
          name: { type: "string", minLength: 1, maxLength: 80 },
        },
        required: ["stackId", "name"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_STACK_REMOVE_ASSETS,
      description: "Take assets out of a stack; the assets stay in the library. Every assetId must belong to this stack, otherwise the call fails with ASSET_NOT_IN_STACK and nothing changes. A stack left with one asset is dissolved (dissolved: true). Assets taken out are not stacked again automatically.",
      inputSchema: {
        type: "object",
        properties: {
          stackId: { type: "string" },
          assetIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2000 },
        },
        required: ["stackId", "assetIds"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_STACK_DISSOLVE,
      description: "Dissolve a stack: its assets return to the library as separate assets; nothing is deleted or archived. They are not stacked again automatically.",
      inputSchema: {
        type: "object",
        properties: {
          stackId: { type: "string" },
        },
        required: ["stackId"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_STACK_GET,
      description: "Read one stack: its name, cover, member count, and member asset IDs in stack order. Members in Trash or archived are left out.",
      inputSchema: {
        type: "object",
        properties: {
          stackId: { type: "string" },
        },
        required: ["stackId"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_STACK_LIST,
      description: "List the stacks shown in the GravityPort library (two or more visible members), most recently updated first, optionally filtered by text in the stack name.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        },
        additionalProperties: false,
      },
    },
  ];
}

function withToolAnnotations(tool) {
  return { ...tool, annotations: { openWorldHint: false, ...TOOL_ANNOTATIONS[tool.name] } };
}

function mcpImportError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}

function mcpToolError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

// Task 375: GravityPort keeps a single library, so projectId is no longer a
// tool argument — every call runs against "default". Assistants may still send
// it out of habit or from a cached schema: an empty value or a
// case-insensitive "default" is treated as absent, anything else is refused
// before schema validation so the answer is the same for every tool
// (additionalProperties varies per schema, so the schema alone cannot enforce
// this). Grouping keeps working through `group` / `tags`.
const PROJECT_ID_NOT_SUPPORTED_MESSAGE = "GravityPort 只有一个素材库，不用传 projectId；要分类请用 group 或 tags。/ GravityPort has a single library; omit projectId and use group or tags to organize.";

function normalizeProjectIdArgument(args) {
  if (!args || typeof args !== "object" || !Object.hasOwn(args, "projectId")) return;
  const value = args.projectId;
  if (value === undefined || value === null || value === "" || (typeof value === "string" && value.toLowerCase() === "default")) {
    delete args.projectId;
    return;
  }
  throw mcpToolError("PROJECT_ID_NOT_SUPPORTED", PROJECT_ID_NOT_SUPPORTED_MESSAGE);
}

// Task 375: path arguments are vetted here, before anything reaches the store,
// so the answer never depends on the MCP process's working directory. The four
// rejections share the INVALID_PATH code with a machine-readable reason; the
// text is Chinese first, original English second. Windows drive paths count as
// absolute too (win32.isAbsolute), so a config moved to Windows behaves the
// same way as on macOS.
const PATH_ERROR_TEXTS = {
  whitespace: ["路径开头或末尾有空格，请去掉。", "The path has leading or trailing spaces; remove them."],
  file_url: ["请去掉 file://，直接用完整路径。", "Drop the file:// prefix and pass a plain absolute path."],
  tilde: ["不支持 ~，请写出完整路径（如 /Users/…）。", "~ is not expanded; pass the full absolute path."],
  relative: ["请用完整（绝对）路径。", "Use an absolute path."],
};

function invalidPathError(reason) {
  const [zh, en] = PATH_ERROR_TEXTS[reason];
  const error = mcpToolError("INVALID_PATH", `${zh}\n${en}`);
  error.reason = reason;
  return error;
}

function assertLocalAbsolutePath(value) {
  if (typeof value !== "string") return;
  if (value !== value.trim()) throw invalidPathError("whitespace");
  if (value.startsWith("file://")) throw invalidPathError("file_url");
  if (value.startsWith("~")) throw invalidPathError("tilde");
  if (!isAbsolute(value) && !win32.isAbsolute(value)) throw invalidPathError("relative");
}

// The library directory comes from the same resolution openLibrary() used —
// never recomputed here. Both sides go through realpath so symlinked parents
// (macOS /var → /private/var) compare equal.
function isWithinDir(child, parent) {
  return child === parent || child.startsWith(parent + sep);
}

async function assertPathOutsideLibrary(realPath) {
  // The library's own staged-images drop area stays importable: the desktop
  // App points generatedImagesDir at <library>/imports (desktop/main.mjs), and
  // the store already trusts that root. Everything ELSE inside the library
  // (assets/, thumbnails, previews, the database) refuses.
  const staging = store?.generatedImagesDir;
  if (staging) {
    const stagingReal = await realpath(staging).catch(() => null);
    if (stagingReal && isWithinDir(realPath, stagingReal)) return;
  }
  let libraryReal;
  try {
    libraryReal = await realpath(libraryDir);
  } catch {
    libraryReal = libraryDir;
  }
  if (isWithinDir(realPath, libraryReal)) {
    throw mcpToolError(
      "LIBRARY_INTERNAL_PATH",
      "这是素材库自己的文件夹，不能再导进来。/ This path is inside the GravityPort library and cannot be imported.",
    );
  }
}

async function assertImportFolderOutsideLibrary(folderRealPath) {
  // Same staged-images exemption as assertPathOutsideLibrary.
  const staging = store?.generatedImagesDir;
  if (staging) {
    const stagingReal = await realpath(staging).catch(() => null);
    if (stagingReal && isWithinDir(folderRealPath, stagingReal)) return;
  }
  let libraryReal;
  try {
    libraryReal = await realpath(libraryDir);
  } catch {
    libraryReal = libraryDir;
  }
  // Both directions: the folder sits inside the library (its thumbnails and
  // previews would re-import as new assets), or the library sits inside the
  // folder (a recursive scan would sweep the library in).
  if (isWithinDir(folderRealPath, libraryReal) || isWithinDir(libraryReal, folderRealPath)) {
    throw mcpToolError(
      "LIBRARY_INTERNAL_PATH",
      "这是素材库自己的文件夹，不能再导进来。/ This path is inside the GravityPort library and cannot be imported.",
    );
  }
}

/**
 * Task 375: MCP-level path vetting shared by asset_create and
 * asset_version_create. Returns the realpath-based trustedSourceRoots for this
 * one store call (the file's parent directory — same rule asset_create already
 * used), or undefined when the file cannot be resolved yet, in which case the
 * store answers with its own error (e.g. IMAGE_PATH_NOT_FOUND). A folder where
 * a file is expected answers PATH_IS_FOLDER here instead of the store's
 * generic unsupported-media message.
 */
async function vetImagePath(imagePath) {
  assertLocalAbsolutePath(imagePath);
  let realFile;
  try {
    realFile = await realpath(imagePath);
  } catch {
    return undefined;
  }
  await assertPathOutsideLibrary(realFile);
  const pathStat = await stat(realFile).catch(() => null);
  if (pathStat?.isDirectory()) {
    throw mcpToolError("PATH_IS_FOLDER", "这是文件夹，请用 asset_import_folder。/ This is a folder; use asset_import_folder.");
  }
  return [dirname(realFile)];
}

// Task 375: store error messages stay English (tests and clients match on the
// exact sentence); the MCP layer prepends the Chinese reason by error code.
// structuredContent.error.code and the English message never change. Codes
// that are already bilingual (LIBRARY_NOT_FOUND, ASSET_NOT_IN_TRASH, …) and
// codes not listed here pass through untouched.
const TOOL_ERROR_TEXT_ZH = new Map([
  ["ASSET_NOT_FOUND", "找不到这张素材，请核对 assetId 后重试。"],
  ["ASSET_ALREADY_EXISTS", "这个素材 ID 已经被占用，请换一个 assetId。"],
  ["IMAGE_PATH_REQUIRED", "缺少文件路径，请补上 imagePath。"],
  ["IMAGE_PATH_NOT_FOUND", "找不到这个文件，请确认路径写对了。"],
  ["IMAGE_PATH_NOT_READABLE", "读不到这个文件，请确认文件存在、路径完整。"],
  ["IMAGE_PATH_UNSUPPORTED_TYPE", "不支持这种文件类型，请换成图片或视频文件。"],
  ["IMAGE_CONTENT_NOT_MEDIA", "这个文件的内容不是图片或视频，可能只是改了扩展名，请换一张真正的图片。"],
  ["INVALID_VERSION_CHANGE", "请写一句版本改动说明（version_change），不能只留空白。"],
  ["VERSION_CYCLE", "这样会造成版本循环，请换一个父版本。"],
  ["VERSION_PARENT_HAS_CHILDREN", "这张图是版本树里的父版本，还有子版本依赖它，不能移进回收站或彻底删除；请先处理它的子版本。"],
  ["ASSET_TRASHED", "这张图已经在回收站里，先恢复后才能这样做。"],
  ["ASSET_NOT_TRASHED", "这张图不在回收站里，不能这样做。"],
  ["ASSET_NOT_IN_STACK", "这张图不在指定的堆叠里，请核对 stackId 和 assetId。"],
  ["ASSET_ALREADY_STACKED", "这张图已经在别的堆叠里；请先用 stack_remove_assets 取出，再重新堆叠。"],
  ["STACK_NOT_FOUND", "找不到这个堆叠，请核对 stackId。"],
  ["STACK_NEEDS_MULTIPLE_ASSETS", "建堆叠至少要两张图。"],
  ["STACK_COVER_NOT_MEMBER", "封面必须是堆叠成员之一。"],
  ["MCP_ASSET_SEARCH_EMPTY", "请提供搜索词或时间范围，至少一项。"],
  ["INVALID_ASSET_CURSOR", "翻页标记无效，请从头重新翻页。"],
  ["INVALID_STACK_CURSOR", "堆叠翻页标记无效，请从头重新翻页。"],
  ["IMPORT_FOLDER_NOT_FOUND", "找不到这个文件夹，请确认路径存在。"],
  ["IMPORT_FOLDER_NOT_DIRECTORY", "这不是文件夹，请用 asset_create 导入单个文件。"],
  ["IMPORT_FOLDER_TOO_LARGE", "这个文件夹里可导入的文件太多，请分批导入（比如按子文件夹拆开）。"],
]);

// Matches any CJK ideograph: already-bilingual messages keep their text.
const CONTAINS_CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;

function localizeToolErrorText(error) {
  const zh = TOOL_ERROR_TEXT_ZH.get(error.code);
  if (!zh) return error.message;
  if (CONTAINS_CJK.test(error.message)) return error.message;
  return `${zh}\n${error.message}`;
}

function assertStackSupport(store) {
  if (
    typeof store?.createAssetStack !== "function" ||
    typeof store?.addAssetsToStack !== "function" ||
    typeof store?.renameAssetStack !== "function" ||
    typeof store?.removeAssetsFromStack !== "function" ||
    typeof store?.dissolveAssetStack !== "function" ||
    typeof store?.getAssetStack !== "function" ||
    typeof store?.listAssetStackAssets !== "function" ||
    typeof store?.getAssetStackMemberships !== "function" ||
    typeof store?.listAssetStacks !== "function"
  ) {
    throw mcpToolError("ASSET_STACKS_UNAVAILABLE", "Asset stacks are unavailable.", 400);
  }
}

// Task 376: asset_list / asset_search answers carry a fixed slim field set
// instead of the full rowToAsset payload (recipe snapshots, palette, runtime
// URLs and paths made a 100-asset page ~220KB). Full detail stays on
// asset_get. Field sources (mirroring rowToAsset in lib/sqlite-asset-store.mjs
// and the shared mediaKindOf rule at lib/sqlite-asset-store.mjs:109):
//   id ← asset.id; file_name ← asset.asset (the managed file name, the same
//   key provenance-bundle.mjs exports as file_name); media_kind ← the shared
//   mediaKindOf rule (source.media_kind || business_fields.media_kind, then
//   the file extension); width/height ← business_fields.width/height;
//   prompt_excerpt ← prompt (first 80 characters, "…" when cut, "" when the
//   asset has no prompt); group ← asset.group; tags/rating/favorite/
//   created_at/image_path carry over; stack ← the attachStackToAssets summary
//   reduced to { id, name }, the key dropped when the asset is unstacked.
// A field whose value is missing on the asset (a video without dimensions, an
// empty tag list, rating 0, favorite false) is omitted, never placeholdered.
const PROMPT_EXCERPT_CHARACTERS = 80;
const COMPACT_QUERY_ECHO_CHARACTERS = 200;
const COMPACT_LIST_DEFAULT_LIMIT = 20;
const COMPACT_LIST_MAX_LIMIT = 100;
const COMPACT_MEDIA_IMAGE_EXTENSIONS = new Set([".apng", ".avif", ".gif", ".jpg", ".jpeg", ".png", ".svg", ".webp"]);
const COMPACT_MEDIA_VIDEO_EXTENSIONS = new Set([".m4v", ".mov", ".mp4", ".webm"]);

function excerptCharacters(value, maxCharacters) {
  const text = typeof value === "string" ? value : "";
  const chars = Array.from(text);
  return chars.length > maxCharacters ? `${chars.slice(0, maxCharacters).join("")}…` : text;
}

function compactMediaKind(asset) {
  const kind = asset?.source?.media_kind || asset?.business_fields?.media_kind;
  if (kind === "video" || kind === "image") return kind;
  const match = /\.([a-z0-9]+)(?:$|\?)/i.exec(String(asset?.image_path || ""));
  const ext = match ? `.${match[1].toLowerCase()}` : "";
  if (COMPACT_MEDIA_VIDEO_EXTENSIONS.has(ext)) return "video";
  if (COMPACT_MEDIA_IMAGE_EXTENSIONS.has(ext)) return "image";
  return "unknown";
}

function compactAsset(asset) {
  if (!asset || typeof asset !== "object") return asset;
  const compact = { id: asset.id };
  if (asset.asset) compact.file_name = asset.asset;
  compact.media_kind = compactMediaKind(asset);
  const width = Number(asset.business_fields?.width);
  if (Number.isFinite(width) && width > 0) compact.width = width;
  const height = Number(asset.business_fields?.height);
  if (Number.isFinite(height) && height > 0) compact.height = height;
  compact.prompt_excerpt = excerptCharacters(asset.prompt, PROMPT_EXCERPT_CHARACTERS);
  if (asset.group) compact.group = asset.group;
  if (Array.isArray(asset.tags) && asset.tags.length) compact.tags = [...asset.tags];
  const rating = Number(asset.rating);
  if (Number.isFinite(rating) && rating > 0) compact.rating = rating;
  if (asset.favorite === true) compact.favorite = true;
  compact.created_at = asset.created_at;
  if (asset.stack && typeof asset.stack === "object") {
    compact.stack = { id: asset.stack.id, name: asset.stack.name };
  }
  if (asset.image_path) compact.image_path = asset.image_path;
  return compact;
}

function compactListLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return COMPACT_LIST_DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), COMPACT_LIST_MAX_LIMIT);
}

// Task 376: the readable content text leads with the bilingual summary (and,
// when a next page exists, the paging hint on the same line), then one line
// per asset on this page: `<id> · <file_name>`.
function compactResultText({ search, total, count, nextCursor, assets }) {
  const summary = search
    ? `找到 ${total} 张，这页 ${count} 张。/ ${total} matches, ${count} on this page.`
    : `共 ${total} 张，这页 ${count} 张。/ ${total} assets, ${count} on this page.`;
  const more = nextCursor ? " 还有更多，传 cursor 翻页。/ More results: pass cursor." : "";
  const lines = [`${summary}${more}`, ...assets.map((asset) => `${asset?.id} · ${asset?.file_name ?? ""}`)];
  return lines.join("\n");
}

async function attachStackToAssets(store, project, assets) {
  const list = Array.isArray(assets) ? assets : (assets ? [assets] : []);
  if (!list.length) return assets;
  if (typeof store?.getAssetStackMemberships !== "function") {
    for (const asset of list) {
      if (asset) asset.stack = null;
    }
    return assets;
  }
  const assetIds = list.map((a) => a?.id).filter(Boolean);
  const memberships = assetIds.length > 0 ? await store.getAssetStackMemberships(project, assetIds) : {};
  for (const asset of list) {
    if (!asset) continue;
    const summary = memberships[asset.id];
    if (summary) {
      asset.stack = {
        id: summary.id,
        name: String(summary.name || ""),
        count: Number(summary.count),
        is_cover: summary.cover_asset_id === asset.id,
      };
    } else {
      asset.stack = null;
    }
  }
  return assets;
}

/**
 * Walk one folder for importable media. The folder's own contents are layer 1;
 * with recursive: true subfolders are read up to IMPORT_FOLDER_MAX_DEPTH layers
 * deep. Plain files with a MEDIA_EXTENSIONS suffix are the import candidates;
 * every other entry seen (symbolic links, files of other types) counts as
 * skipped. Throws IMPORT_FOLDER_TOO_LARGE as soon as one more file would break
 * the cap, so nothing imports.
 */
async function scanImportFolder(folderRealPath, recursive) {
  const files = [];
  let skipped = 0;
  const maxFiles = importFolderMaxFiles();
  async function walk(dir, depth) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        skipped += 1;
        continue;
      }
      if (entry.isFile()) {
        if (MEDIA_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          files.push(join(dir, entry.name));
          if (files.length > maxFiles) {
            throw mcpImportError(
              "IMPORT_FOLDER_TOO_LARGE",
              `The folder holds more than ${maxFiles} importable files. Import it in batches (for example one subfolder at a time); nothing was imported.`,
            );
          }
        } else {
          skipped += 1;
        }
        continue;
      }
      if (entry.isDirectory() && recursive && depth < IMPORT_FOLDER_MAX_DEPTH) {
        await walk(join(dir, entry.name), depth + 1);
      }
    }
  }
  await walk(folderRealPath, 1);
  return { files, skipped };
}

/**
 * The asset_import_folder handler. Scan first (fail fast on a missing folder
 * or an oversized batch, answer empty folders directly), then import the
 * scanned files one by one with trustedSourceRoots: [folderRealPath] — a failed
 * file is recorded and never stops the rest, matching how manual imports behave.
 */
async function importFolder(args) {
  const folderPath = args.folderPath;
  // Task 375: the four path-shape rejections answer here, before the store
  // sees the value; the old absolute-path guard below stays as a type defense.
  if (typeof folderPath === "string") assertLocalAbsolutePath(folderPath);
  if (typeof folderPath !== "string" || !isAbsolute(folderPath)) {
    throw mcpImportError("IMPORT_FOLDER_NOT_ABSOLUTE", `folderPath must be an absolute path: ${folderPath}`);
  }
  let folderRealPath;
  try {
    folderRealPath = await realpath(folderPath);
  } catch {
    throw mcpImportError("IMPORT_FOLDER_NOT_FOUND", `Folder does not exist: ${folderPath}`);
  }
  const folderStat = await stat(folderRealPath).catch(() => null);
  if (folderStat?.isFile()) {
    throw mcpImportError("PATH_IS_FILE", "这是文件，请用 asset_create。/ This is a file; use asset_create.");
  }
  if (!folderStat?.isDirectory()) {
    throw mcpImportError("IMPORT_FOLDER_NOT_DIRECTORY", `Not a folder: ${folderPath}`);
  }
  await assertImportFolderOutsideLibrary(folderRealPath);
  const recursive = args.recursive === true;
  const { files, skipped } = await scanImportFolder(folderRealPath, recursive);
  const counts = { imported: 0, deduplicated: 0, skipped, failed: 0 };
  if (files.length === 0) {
    return {
      content: [{ type: "text", text: `Nothing to import from ${folderPath}.` }],
      structuredContent: { ...counts, assetIds: [], duplicates: [], failures: [] },
    };
  }
  const { source } = args;
  const assetIds = [];
  const duplicates = [];
  const failures = [];
  for (const file of files) {
    const input = {
      project_id: "default",
      prompt: args.prompt,
      sourceType: args.sourceType,
      imagePath: file,
      ...(source && typeof source === "object" && !Array.isArray(source) ? { source: untrustedCreateSource(source) } : {}),
    };
    try {
      // skipIdenticalBytes matches asset_create. trustedSourceRoots covers
      // exactly the imported folder for this one call; it is never remembered.
      const created = await createAssetViaGate(store, input, {
        skipIdenticalBytes: true,
        trustedSourceRoots: [folderRealPath],
        excludeProjectRoot: true,
      });
      if (created.ok) {
        counts.imported += 1;
        assetIds.push(created.asset.id);
      } else if (created.skipped.reason === "already-in-library") {
        counts.deduplicated += 1;
        duplicates.push({ file: basename(file), assetId: created.skipped.existingAsset?.id || null });
      } else {
        throw created.error;
      }
    } catch (error) {
      counts.failed += 1;
      failures.push({ file: basename(file), code: String(error?.code || "UNKNOWN") });
    }
  }
  const text = `Imported ${counts.imported} file(s) from ${folderPath}: ${counts.deduplicated} deduplicated, ${counts.skipped} skipped, ${counts.failed} failed.`;
  return {
    content: [{ type: "text", text }],
    structuredContent: { ...counts, assetIds, duplicates, failures },
  };
}

function deduplicatedAssetResult(existingAsset, args) {
  const NON_METADATA_KEYS = new Set(["imagePath", "assetId", "assetIdNew"]);
  const ignored_fields = Object.keys(args).filter(
    (key) => !NON_METADATA_KEYS.has(key) && args[key] !== undefined,
  );
  const structuredContent = { asset: existingAsset, deduplicated: true };
  let text = `Asset already in library: ${existingAsset.id} (identical bytes); returned the existing asset.`;
  if (ignored_fields.length > 0) {
    structuredContent.ignored_fields = ignored_fields;
    const fieldsText = ignored_fields.join(", ");
    text += ` 这次传的 ${fieldsText} 没有写入；要改用 asset_update_metadata。/ The ${fieldsText} in this request were not saved; use asset_update_metadata to change them.`;
  }
  return { content: [{ type: "text", text }], structuredContent };
}

async function handleToolCall(id, params) {
  const args = params?.arguments || {};
  const definition = toolDefinitions().find((tool) => tool.name === params?.name);
  if (!definition) {
    sendError(id, -32602, `Unknown tool: ${params?.name || ""}`);
    return;
  }
  // Task 375: the projectId gate runs before schema validation so every tool
  // answers PROJECT_ID_NOT_SUPPORTED identically, regardless of whether its
  // schema allows additional properties.
  normalizeProjectIdArgument(args);
  const validationError = validateSchema(definition.inputSchema, args, "arguments");
  if (validationError) {
    sendError(id, -32602, validationError);
    return;
  }
  if (params?.name === TOOL_ASSET_CREATE) {
    // Creation goes through the shared ingest gate (lib/library-ingest.mjs,
    // ARCHITECTURE.md §8): identical bytes already in the library (outside
    // Trash) answer with the stored asset instead of a copy, and hashes the
    // caller claims in `source` are never trusted — the store recomputes them.
    // Absolute image paths anywhere on the local filesystem are accepted
    // by scoping trustedSourceRoots to the file's parent directory for this
    // single call; task 375 vets the path shape (spaces, file://, ~,
    // relative), library-internal paths and folders here in the MCP layer.
    const { source, ...rest } = args;
    const input = source && typeof source === "object" && !Array.isArray(source)
      ? { ...rest, source: untrustedCreateSource(source) }
      : args;
    let trustedSourceRoots;
    if (typeof input.imagePath === "string") {
      trustedSourceRoots = await vetImagePath(input.imagePath);
    }
    const created = await createAssetViaGate(store, input, {
      skipIdenticalBytes: true,
      excludeProjectRoot: true,
      ...(trustedSourceRoots ? { trustedSourceRoots } : {}),
    });
    if (!created.ok) {
      if (created.skipped.reason !== "already-in-library") throw created.error;
      const located = created.skipped.existingAsset?.id
        ? await store.getAsset("default", created.skipped.existingAsset.id).catch(() => null)
        : null;
      const asset = located || created.skipped.existingAsset;
      sendResult(id, deduplicatedAssetResult(asset, args));
      return;
    }
    const asset = created.asset;
    sendResult(id, { content: [{ type: "text", text: `Saved asset ${asset.id} at ${asset.image_path}` }], structuredContent: { asset } });
    return;
  }
  if (params?.name === TOOL_ASSET_IMPORT_FOLDER) {
    sendResult(id, await importFolder(args));
    return;
  }
  if (params?.name === TOOL_ASSET_LIST) {
    // Task 376: slim per-asset summaries with top-level total/next_cursor for
    // paging; `page` from the store is not passed through, and full per-asset
    // detail stays on asset_get.
    const result = typeof store.listAssetPage === "function"
      ? await store.listAssetPage({
        projectId: "default",
        query: args.query || "",
        limit: compactListLimit(args.limit),
        cursor: args.cursor,
        includeTotal: true,
      })
      : { assets: await store.listAssets({ projectId: "default", query: args.query || "" }), page: { total: null, nextCursor: null } };
    await attachStackToAssets(store, "default", result.assets);
    const assets = (result.assets || []).map(compactAsset);
    const total = Number.isFinite(result.page?.total) ? result.page.total : assets.length;
    const nextCursor = result.page?.nextCursor ?? null;
    sendResult(id, {
      content: [{ type: "text", text: compactResultText({ search: false, total, count: assets.length, nextCursor, assets }) }],
      structuredContent: { assets, total, next_cursor: nextCursor },
    });
    return;
  }
  if (params?.name === TOOL_ASSET_SEARCH) {
    const result = await searchMcpAssets({
      store,
      projectId: "default",
      query: args.query || "",
      createdAfter: args.createdAfter,
      createdBefore: args.createdBefore,
      // Legacy clients with a cached schema may still send visual: it is
      // accepted and ignored so they keep getting lexical results.
      visual: args.visual === true,
      cursor: args.cursor,
      limit: args.limit,
    });
    const assets = (result.results || []).map((entry) => entry.asset).filter(Boolean);
    await attachStackToAssets(store, "default", assets);
    // Task 376: each result keeps its `match` scoring layer, with the slim
    // asset swapped in; totals and the paging cursor ride at the top level.
    const results = (result.results || []).map((entry) => (entry?.asset ? { ...entry, asset: compactAsset(entry.asset) } : entry));
    sendResult(id, {
      content: [{ type: "text", text: compactResultText({ search: true, total: result.total, count: results.length, nextCursor: result.next_cursor, assets: results.map((entry) => entry.asset) }) }],
      structuredContent: { ...result, results },
    });
    return;
  }
  if (params?.name === TOOL_ASSET_GET) {
    const asset = await store.getAsset("default", args.assetId);
    await attachStackToAssets(store, "default", [asset]);
    sendResult(id, { content: [{ type: "text", text: asset.prompt || `Asset ${asset.id}` }], structuredContent: { asset } });
    return;
  }
  if (params?.name === TOOL_ASSET_PROVENANCE_EXPORT) {
    const result = await buildAssetProvenanceBundle(store, "default", args.assetId, {
      includePrompts: args.includePrompts === true,
    });
    sendResult(id, { content: [{ type: "text", text: `Exported provenance for ${args.assetId}` }], structuredContent: result });
    return;
  }
  if (params?.name === TOOL_ASSET_UPDATE_METADATA) {
    const { assetId, ...patch } = args;
    // AI assistants edit on the user's behalf, so this counts as a human edit:
    // stamp markers so automatic prompt/theme writers keep their hands off.
    const current = await store.getAsset("default", assetId);
    const asset = await store.updateMetadata("default", assetId, withUserEditMarkers(current, patch));
    sendResult(id, { content: [{ type: "text", text: `Updated asset ${asset.id}` }], structuredContent: { asset } });
    return;
  }
  if (params?.name === TOOL_ASSET_ATTACH_PROMPT) {
    const current = await store.getAsset("default", args.assetId);
    const asset = await store.updateMetadata("default", args.assetId, withUserEditMarkers(current, { prompt: args.prompt }));
    sendResult(id, { content: [{ type: "text", text: `Attached prompt to ${asset.id}` }], structuredContent: { asset } });
    return;
  }
  if (params?.name === TOOL_ASSET_TRASH) {
    const result = await store.deleteAsset("default", args.assetId, { reason: "mcp" });
    const purgeAfter = new Date(new Date(result.deleted_at).getTime() + TRASH_RETENTION_MS).toISOString();
    sendResult(id, {
      content: [{
        type: "text",
        text: `已移到回收站，可恢复，90 天后自动清除。/ Moved to Trash; restorable for 90 days. (${args.assetId})`,
      }],
      structuredContent: {
        asset_id: args.assetId,
        trashed: true,
        deleted_at: result.deleted_at,
        purge_after: purgeAfter,
      },
    });
    return;
  }
  if (params?.name === TOOL_ASSET_RESTORE) {
    const current = await store.getAsset("default", args.assetId);
    if (!current.deleted_at) {
      const error = assetStoreError(
        "ASSET_NOT_IN_TRASH",
        `这张图不在回收站里。/ Asset ${args.assetId} is not in Trash.`,
      );
      error.statusCode = 400;
      throw error;
    }
    const asset = await store.restoreAsset("default", args.assetId);
    sendResult(id, {
      content: [{ type: "text", text: `已从回收站恢复。/ Restored from Trash. (${asset.id})` }],
      structuredContent: { asset },
    });
    return;
  }
  if (params?.name === TOOL_ASSET_DUPLICATE) {
    const asset = await store.duplicateAsset("default", args.assetId, { assetId: args.assetIdNew });
    sendResult(id, { content: [{ type: "text", text: `Duplicated asset ${asset.id}` }], structuredContent: { asset } });
    return;
  }
  if (params?.name === TOOL_ASSET_VERSION_CREATE) {
    const { assetId, assetIdNew, ...input } = args;
    // Task 375: the version tool now accepts replacement images from any local
    // absolute path, exactly like asset_create — trustedSourceRoots is scoped
    // to the file's parent directory for this single call, and the same
    // MCP-layer path vetting applies.
    let trustedSourceRoots;
    if (typeof args.imagePath === "string") {
      trustedSourceRoots = await vetImagePath(args.imagePath);
    }
    try {
      const asset = await store.createAssetVersion(
        "default",
        assetId,
        { ...input, assetId: assetIdNew },
        { excludeProjectRoot: true, ...(trustedSourceRoots ? { trustedSourceRoots } : {}) },
      );
      sendResult(id, { content: [{ type: "text", text: `Created version ${asset.id} from ${assetId}` }], structuredContent: { asset } });
    } catch (error) {
      if (error?.code === "ALREADY_IN_LIBRARY" && error.existingAsset?.id) {
        const located = await store.getAsset("default", error.existingAsset.id).catch(() => null);
        const asset = located || error.existingAsset;
        sendResult(id, deduplicatedAssetResult(asset, args));
        return;
      }
      throw error;
    }
    return;
  }
  if (params?.name === TOOL_ASSET_VERSION_HISTORY) {
    const history = await store.getAssetVersionHistory("default", args.assetId);
    sendResult(id, { content: [{ type: "text", text: `${history.versions.length} versions rooted at ${history.root_asset_id}` }], structuredContent: { history } });
    return;
  }
  if (params?.name === TOOL_ASSET_RECIPE_HISTORY) {
    const history = await store.getRecipeSnapshotHistory("default", args.assetId);
    sendResult(id, { content: [{ type: "text", text: `${history.snapshots.length} recipe snapshots for ${history.asset_id}` }], structuredContent: { history } });
    return;
  }
  if (params?.name === TOOL_GENERATION_RECORD) {
    if (typeof store.recordGenerationEvent !== "function") throw new Error("Generation history is unavailable.");
    assertExternalVerificationLevel(args.verificationLevel);
    const event = await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: args.outputAssetId,
      provider: args.provider,
      capture_context_id: args.captureContextId,
      provider_tool_call_id: args.providerToolCallId,
      provider_generation_call_id: args.providerGenerationCallId,
      provider_response_id: args.providerResponseId,
      provider_asset_id: args.providerAssetId,
      conversation_id: args.conversationId,
      message_id: args.messageId,
      batch_id: args.batchId,
      model: args.model,
      user_prompt: args.userPrompt,
      effective_prompt: args.effectivePrompt,
      prompt_status: args.promptStatus,
      capture_channel: args.captureChannel || "mcp",
      verification_level: args.verificationLevel || "observed",
      references: args.references,
      evidence: args.evidence,
      created_at: args.createdAt,
    });
    sendResult(id, { content: [{ type: "text", text: `Recorded generation ${event.id} for asset ${event.output_asset_id}` }], structuredContent: { event } });
    return;
  }
  if (params?.name === TOOL_GENERATION_LIST) {
    if (typeof store.listGenerationEvents !== "function") throw new Error("Generation history is unavailable.");
    const events = await store.listGenerationEvents("default", {
      assetId: args.assetId,
      captureContextId: args.captureContextId,
      providerToolCallId: args.providerToolCallId,
      providerGenerationCallId: args.providerGenerationCallId,
    });
    sendResult(id, { content: [{ type: "text", text: `${events.length} generation events` }], structuredContent: { events } });
    return;
  }
  if (params?.name === TOOL_GENERATION_RELATION_RECORD) {
    if (typeof store.recordGenerationRelation !== "function") throw new Error("Generation history is unavailable.");
    assertExternalVerificationLevel(args.verificationLevel);
    const relation = await store.recordGenerationRelation({
      project_id: "default",
      child_generation_id: args.childGenerationId,
      parent_generation_id: args.parentGenerationId,
      relation_type: args.relationType,
      verification_level: args.verificationLevel || "user_confirmed",
      evidence: args.evidence,
      created_at: args.createdAt,
    });
    sendResult(id, { content: [{ type: "text", text: `Recorded ${relation.relation_type} relation` }], structuredContent: { relation } });
    return;
  }
  if (params?.name === TOOL_GENERATION_LINEAGE) {
    if (typeof store.getGenerationLineage !== "function") throw new Error("Generation history is unavailable.");
    const lineage = await store.getGenerationLineage("default", args.generationId);
    sendResult(id, { content: [{ type: "text", text: `${lineage.events.length} generation events in lineage` }], structuredContent: { lineage } });
    return;
  }
  if (params?.name === TOOL_STACK_CREATE) {
    assertStackSupport(store);
    if (args.name !== undefined) {
      const trimmed = String(args.name).trim();
      if (!trimmed) {
        throw assetStoreError("STACK_NAME_EMPTY", "Stack name cannot be empty.");
      }
    }
    let stack = await store.createAssetStack("default", args.assetIds, { coverAssetId: args.coverAssetId });
    if (args.name !== undefined) {
      const trimmed = String(args.name).trim();
      if (trimmed) {
        stack = await store.renameAssetStack("default", stack.id, trimmed);
      }
    }
    sendResult(id, {
      content: [{ type: "text", text: `Created stack ${stack.id} with ${stack.count} assets` }],
      structuredContent: { stack },
    });
    return;
  }
  if (params?.name === TOOL_STACK_ADD_ASSETS) {
    assertStackSupport(store);
    const memberships = await store.getAssetStackMemberships("default", args.assetIds);
    const alreadyInStack = [];
    const added = [];
    for (const assetId of args.assetIds) {
      if (memberships[assetId]?.id === args.stackId) {
        if (!alreadyInStack.includes(assetId)) alreadyInStack.push(assetId);
      } else {
        if (!added.includes(assetId)) added.push(assetId);
      }
    }
    const stack = await store.addAssetsToStack("default", args.stackId, args.assetIds);
    sendResult(id, {
      content: [{ type: "text", text: `Added ${added.length} asset(s) to stack ${stack.id}` }],
      structuredContent: { stack, added, alreadyInStack },
    });
    return;
  }
  if (params?.name === TOOL_STACK_RENAME) {
    assertStackSupport(store);
    const trimmed = String(args.name).trim();
    if (!trimmed) {
      throw assetStoreError("STACK_NAME_EMPTY", "Stack name cannot be empty.");
    }
    const stack = await store.renameAssetStack("default", args.stackId, trimmed);
    sendResult(id, {
      content: [{ type: "text", text: `Renamed stack ${stack.id} to "${stack.name}"` }],
      structuredContent: { stack },
    });
    return;
  }
  if (params?.name === TOOL_STACK_REMOVE_ASSETS) {
    assertStackSupport(store);
    await store.getAssetStack("default", args.stackId);
    const memberships = await store.getAssetStackMemberships("default", args.assetIds);
    for (const assetId of args.assetIds) {
      if (memberships[assetId]?.id !== args.stackId) {
        throw mcpToolError("ASSET_NOT_IN_STACK", `Asset ${assetId} does not belong to stack ${args.stackId}.`);
      }
    }
    const outcome = await store.removeAssetsFromStack("default", args.stackId, args.assetIds);
    const text = outcome.dissolved
      ? `Removed ${args.assetIds.length} asset(s); dissolved stack ${args.stackId}`
      : `Removed ${args.assetIds.length} asset(s) from stack ${args.stackId}`;
    sendResult(id, {
      content: [{ type: "text", text }],
      structuredContent: {
        dissolved: Boolean(outcome.dissolved),
        remainingAssetId: outcome.remainingAssetId || null,
        stack: outcome.stack || null,
      },
    });
    return;
  }
  if (params?.name === TOOL_STACK_DISSOLVE) {
    assertStackSupport(store);
    const result = await store.dissolveAssetStack("default", args.stackId);
    sendResult(id, {
      content: [{ type: "text", text: `Dissolved stack ${result.id}` }],
      structuredContent: {
        id: result.id,
        assetIds: result.assetIds,
        dissolved: true,
      },
    });
    return;
  }
  if (params?.name === TOOL_STACK_GET) {
    assertStackSupport(store);
    const stack = await store.getAssetStack("default", args.stackId);
    const page = await store.listAssetStackAssets("default", args.stackId);
    const members = (page.assets || []).map((asset) => ({ id: asset.id, asset }));
    sendResult(id, {
      content: [{ type: "text", text: `Stack ${stack.id} has ${members.length} assets` }],
      structuredContent: { stack, members },
    });
    return;
  }
  if (params?.name === TOOL_STACK_LIST) {
    assertStackSupport(store);
    const result = await store.listAssetStacks("default", { query: args.query, limit: args.limit });
    sendResult(id, {
      content: [{ type: "text", text: `${result.stacks.length} stacks` }],
      structuredContent: { stacks: result.stacks, truncated: Boolean(result.truncated) },
    });
    return;
  }
}

function validateSchema(schema, value, path) {
  if (!schema || typeof schema !== "object") return "";
  if (Array.isArray(schema.anyOf)) {
    if (schema.anyOf.some((candidate) => !validateSchema(candidate, value, path))) return "";
    return `${path} does not match any allowed shape.`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `${path} must be one of: ${schema.enum.join(", ")}.`;
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return `${path} must be an object.`;
    for (const required of schema.required || []) {
      if (!Object.hasOwn(value, required)) return `${path}.${required} is required.`;
    }
    const properties = schema.properties || {};
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(value).find((key) => !Object.hasOwn(properties, key));
      if (unknown) return `${path}.${unknown} is not allowed.`;
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key)) continue;
      const error = validateSchema(child, value[key], `${path}.${key}`);
      if (error) return error;
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) return `${path} must be an array.`;
    for (let index = 0; index < value.length; index += 1) {
      const error = validateSchema(schema.items, value[index], `${path}[${index}]`);
      if (error) return error;
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string") return `${path} must be a string.`;
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) return `${path} must contain at least ${schema.minLength} characters.`;
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) return `${path} must contain at most ${schema.maxLength} characters.`;
    if (typeof schema.pattern === "string") {
      let pattern;
      try { pattern = new RegExp(schema.pattern); }
      catch { return `${path} has an invalid schema pattern.`; }
      if (!pattern.test(value)) return `${path} must match ${schema.pattern}.`;
    }
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") return `${path} must be a boolean.`;
  } else if (schema.type === "integer") {
    if (!Number.isInteger(value)) return `${path} must be an integer.`;
  } else if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return `${path} must be a finite number.`;
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) return `${path} must contain at least ${schema.minItems} items.`;
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) return `${path} must contain at most ${schema.maxItems} items.`;
  }
  if (typeof value === "number") {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) return `${path} must be >= ${schema.minimum}.`;
    if (Number.isFinite(schema.maximum) && value > schema.maximum) return `${path} must be <= ${schema.maximum}.`;
  }
  return "";
}

function libraryMovedAway() {
  if (!locationFile) return false;
  try {
    return resolveCurrentLibraryDir() !== libraryDir;
  } catch {
    return true;
  }
}

// The second half of the move/delete guard, for servers that were started
// without a location file (hand-written configs): the mosa.db this server
// opened must still be the same file. Deleted (ENOENT) or replaced by another
// file (the App recreating a library, a cloud-sync conflict) both count —
// either way the library this process holds is gone, and answering success
// would silently lose the write.
async function libraryDatabaseChanged() {
  if (!databaseIdentity) return false;
  try {
    const databaseInfo = await stat(databasePath);
    return databaseInfo.dev !== databaseIdentity.dev || databaseInfo.ino !== databaseIdentity.ino;
  } catch {
    return true;
  }
}

// The desktop App writes the relocation marker into the library root before
// it stops its runtime and removes it when the move fails; while it exists
// the old library is mid-copy and about to be deleted, so even read-only
// tools must not touch it. An unreadable answer is treated as "moving" so a
// broken stat never falls through into the doomed library.
async function libraryRelocating() {
  try {
    return await hasRelocationMarker({ libraryDir });
  } catch {
    return true;
  }
}

async function handleRequest(message) {
  const { id, method, params } = message;
  // JSON-RPC notifications (no `id`, e.g. notifications/initialized) must never
  // get a response; none of them needs handling here.
  if (!Object.hasOwn(message, "id")) return;
  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: params?.protocolVersion || "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "GravityPort MCP", version: MCP_SERVER_VERSION },
      instructions: "Save generated images with the effective prompt, distinct user prompt when available, negative constraints, reference hashes, and generation provenance. GravityPort records immutable recipe snapshots automatically. Use generation_record for each distinct generation occurrence, even when its output asset was deduplicated; use generation_relation_record only for evidence-backed parent relationships, and generation_lineage to read the resulting graph. provider_verified is reserved for trusted GravityPort provider integrations and cannot be asserted by ordinary MCP callers. Use asset_version_create only for explicit asset-version workflows."
    });
    return;
  }
  if (method === "ping") {
    sendResult(id, {});
    return;
  }
  if (method === "tools/list") {
    sendResult(id, { tools: toolDefinitions().map(withToolAnnotations) });
    return;
  }
  if (method === "tools/call") {
    // No library yet (GravityPort never opened, drive unplugged): try again on
    // every call, so opening the App is enough and the assistant need not restart.
    let unavailable;
    try {
      unavailable = await ensureLibraryOpen();
    } catch (error) {
      sendError(id, -32603, error.message);
      return;
    }
    if (unavailable) {
      sendResult(id, {
        content: [{ type: "text", text: unavailable.message }],
        isError: true,
        structuredContent: { error: { code: unavailable.code, message: unavailable.message } },
      });
      return;
    }
    // Moving the library in the desktop copies it and deletes the original.
    // This process still holds the old location, so refuse instead of
    // reading or writing a library that is gone; a restart follows the move.
    if (libraryMovedAway()) {
      const message = "The GravityPort library has moved. Restart this AI assistant to reconnect.";
      sendResult(id, {
        content: [{ type: "text", text: message }],
        isError: true,
        structuredContent: { error: { code: "LIBRARY_MOVED", message } },
      });
      return;
    }
    // The same move, one step earlier: the marker is present from the moment
    // the App starts copying until it either fails (marker removed, calls
    // recover) or succeeds (library deleted, LIBRARY_MOVED above takes over).
    if (await libraryRelocating()) {
      const message = "GravityPort is moving the library. Try again after it restarts.";
      sendResult(id, {
        content: [{ type: "text", text: message }],
        isError: true,
        structuredContent: { error: { code: "LIBRARY_MOVING", message } },
      });
      return;
    }
    // Without a copied config there is no location file to notice a move, so
    // the database file itself is the witness: deleted, or swapped for another
    // file (App recreating the library, cloud-sync conflict) both mean the
    // library this server opened is gone. Nothing is written; the caller must
    // reconnect the way the App's Settings → Connection page describes.
    if (await libraryDatabaseChanged()) {
      const message = `素材库已被移动或删除（原位置 ${libraryDir}）。请在 GravityPort 的 设置 → 连接 重新复制 MCP 配置并重启 AI 助手。The GravityPort library has been moved or deleted (was at ${libraryDir}). Copy the MCP configuration again from GravityPort's Settings → Connection and restart your AI assistant.`;
      sendResult(id, {
        content: [{ type: "text", text: message }],
        isError: true,
        structuredContent: { error: { code: "LIBRARY_DATABASE_CHANGED", message } },
      });
      return;
    }
    try {
      await handleToolCall(id, params);
    } catch (error) {
      if (error?.statusCode && error?.code) {
        // Task 375: the MCP layer prepends the Chinese reason (see
        // TOOL_ERROR_TEXT_ZH); the English message and the machine-readable
        // code stay untouched. Path-shape errors also carry error.reason.
        sendResult(id, {
          content: [{ type: "text", text: localizeToolErrorText(error) }],
          isError: true,
          structuredContent: { error: { code: error.code, message: error.message, ...(error.reason ? { reason: error.reason } : {}) } },
        });
      } else sendError(id, -32603, error.message);
    }
    return;
  }
  sendError(id, -32601, `Method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
// stdin can end while a request (e.g. a slow asset_create write) is still being
// handled. Track those requests so the store only closes after they settle,
// otherwise the in-flight write dies with "database connection is not open".
const inFlightRequests = new Set();
rl.on("line", (line) => {
  if (!line.trim()) return;
  const request = handleLine(line);
  inFlightRequests.add(request);
  request.then(
    () => inFlightRequests.delete(request),
    () => inFlightRequests.delete(request),
  );
});
async function handleLine(line) {
  try {
    await handleRequest(JSON.parse(line));
  } catch (error) {
    sendError(null, -32700, error.message);
  }
}
rl.on("close", () => {
  void Promise.allSettled([...inFlightRequests]).then(() => closeDirectStore());
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void closeDirectStore().finally(() => process.exit(0));
  });
}
