import "../lib/apply-env-aliases.mjs";
import readline from "node:readline";
import { homedir } from "node:os";
import { statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readdir, realpath, stat } from "node:fs/promises";
import { createAssetStore } from "../lib/asset-store.mjs";
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
const TOOL_ASSET_ARCHIVE = "asset_archive";
const TOOL_ASSET_DUPLICATE = "asset_duplicate";
const TOOL_ASSET_VERSION_CREATE = "asset_version_create";
const TOOL_ASSET_VERSION_HISTORY = "asset_version_history";
const TOOL_ASSET_RECIPE_HISTORY = "asset_recipe_history";
const TOOL_GENERATION_RECORD = "generation_record";
const TOOL_GENERATION_LIST = "generation_list";
const TOOL_GENERATION_RELATION_RECORD = "generation_relation_record";
const TOOL_GENERATION_LINEAGE = "generation_lineage";

// Task 334: MCP tool annotations. Read tools never write; the only destructive
// tool is asset_archive (soft-delete); nothing reaches out to other systems,
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
  [TOOL_ASSET_ARCHIVE]: { readOnlyHint: false, destructiveHint: true },
  [TOOL_ASSET_DUPLICATE]: { readOnlyHint: false, destructiveHint: false },
  [TOOL_ASSET_VERSION_CREATE]: { readOnlyHint: false, destructiveHint: false },
  [TOOL_ASSET_VERSION_HISTORY]: { readOnlyHint: true, destructiveHint: false },
  [TOOL_ASSET_RECIPE_HISTORY]: { readOnlyHint: true, destructiveHint: false },
  [TOOL_GENERATION_RECORD]: { readOnlyHint: false, destructiveHint: false },
  [TOOL_GENERATION_LIST]: { readOnlyHint: true, destructiveHint: false },
  [TOOL_GENERATION_RELATION_RECORD]: { readOnlyHint: false, destructiveHint: false },
  [TOOL_GENERATION_LINEAGE]: { readOnlyHint: true, destructiveHint: false },
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
      description: "Copy an image into the GravityPort library and save prompt recipe metadata. Any local absolute image path is accepted; relative paths are rejected. Symbolic links are skipped. Only supported image and video formats are imported. Identical bytes already in the library (outside Trash) return the existing asset with deduplicated: true instead of creating a copy.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          imagePath: { type: "string" },
          prompt: { type: "string" },
          user_prompt: { type: "string", description: "Optional user request kept separately from the effective generation prompt." },
          negative_prompt: { type: "string" },
          references: REFERENCE_SCHEMA,
          skill: { type: "string" },
          style: { type: "string" },
          ratio: { type: "string" },
          theme: { type: "string" },
          business_fields: { type: "object", description: "Stored with the asset but not searchable; put anything that should be findable via search into tags instead." },
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
      description: "Import every image and video found in a local folder into the GravityPort library, applying the same projectId/prompt/sourceType/source to each file. Any local absolute folder path is accepted; relative paths are rejected. Symbolic links are skipped; with recursive: true subfolders are read up to 5 levels deep; a single call imports at most 1000 files, otherwise it fails and asks for batches. Identical bytes already in the library are reported as deduplicated. Files import one by one; a failed file is reported and does not stop the rest.",
      inputSchema: {
        type: "object",
        properties: {
          folderPath: { type: "string", description: "Absolute path of the folder to import." },
          recursive: { type: "boolean", description: "Also read subfolders (default false; at most 5 levels deep)." },
          projectId: { type: "string" },
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
      description: "List saved GravityPort assets for a project, optionally filtered by search text.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" }, query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 250 }, cursor: { type: "string" } },
        additionalProperties: false
      }
    },
    {
      name: TOOL_ASSET_SEARCH,
      description: "Search GravityPort visual memory using lexical search and explicit creation-time bounds.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          query: { type: "string" },
          createdAfter: { type: "string", description: "Inclusive ISO-8601 lower creation-time bound." },
          createdBefore: { type: "string", description: "Inclusive ISO-8601 upper creation-time bound." },
          // Deprecated: local visual retrieval was removed. Both properties stay
          // declared so clients with a cached older schema may still send
          // `visual` / `minScore`; they are accepted and ignored (lexical search runs).
          visual: { type: "boolean", description: "Deprecated and ignored." },
          minScore: { type: "number", description: "Deprecated and ignored." },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
    },
    {
      name: TOOL_ASSET_GET,
      description: "Get one saved asset and its full prompt recipe.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" }, assetId: { type: "string" } },
        required: ["assetId"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_ASSET_PROVENANCE_EXPORT,
      description: "Export a portable GravityPort provenance bundle plus an unsigned C2PA assertion payload. This does not create a signed Content Credential; a C2PA signer must bind and sign the assertion separately.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          assetId: { type: "string" },
          includePrompts: { type: "boolean" },
        },
        required: ["assetId"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_ASSET_ARCHIVE,
      description: "Soft-delete an asset from active GravityPort results while preserving its provenance and original file.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" }, assetId: { type: "string" } },
        required: ["assetId"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_ASSET_DUPLICATE,
      description: "Create an independent editable copy that starts a new version root while retaining duplicate provenance.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" }, assetId: { type: "string" }, assetIdNew: { type: "string" } },
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
          projectId: { type: "string" },
          assetId: { type: "string", description: "Existing parent asset ID." },
          assetIdNew: { type: "string", description: "Optional ID for the new version." },
          imagePath: { type: "string", description: "Optional new image path. When omitted, the parent image is copied for a recipe-only version." },
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
        properties: { projectId: { type: "string" }, assetId: { type: "string" } },
        required: ["assetId"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_ASSET_RECIPE_HISTORY,
      description: "Read immutable generation recipe snapshots for one asset and identify the currently active snapshot.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" }, assetId: { type: "string" } },
        required: ["assetId"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_ASSET_UPDATE_METADATA,
      description: "Update metadata fields for a saved asset. Pass `references` to record reference rights and permitted uses for an already-archived asset; that annotation is not a generation input, so it refreshes the existing recipe snapshot rather than appending a new one.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
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
        properties: { projectId: { type: "string" }, assetId: { type: "string" }, prompt: { type: "string" } },
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
          projectId: { type: "string" },
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
          projectId: { type: "string" },
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
          projectId: { type: "string" },
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
        properties: { projectId: { type: "string" }, generationId: { type: "string" } },
        required: ["generationId"],
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

/**
 * Walk one folder for importable media. The folder's own contents are layer 1;
 * with recursive: true subfolders are read up to IMPORT_FOLDER_MAX_DEPTH layers
 * deep. Plain files with a MEDIA_EXTENSIONS suffix are the import candidates;
 * every other entry seen (symbolic links, files of other types) counts as
 * skipped. Throws IMPORT_FOLDER_TOO_LARGE as soon as one more file would break
 * the cap, so nothing imports and no confirmation is asked for.
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
  if (!folderStat?.isDirectory()) {
    throw mcpImportError("IMPORT_FOLDER_NOT_DIRECTORY", `Not a folder: ${folderPath}`);
  }
  const recursive = args.recursive === true;
  const { files, skipped } = await scanImportFolder(folderRealPath, recursive);
  const counts = { imported: 0, deduplicated: 0, skipped, failed: 0 };
  if (files.length === 0) {
    return {
      content: [{ type: "text", text: `Nothing to import from ${folderPath}.` }],
      structuredContent: { ...counts, assetIds: [], failures: [] },
    };
  }
  const { source } = args;
  const assetIds = [];
  const failures = [];
  for (const file of files) {
    const input = {
      projectId: args.projectId || "default",
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
    structuredContent: { ...counts, assetIds, failures },
  };
}

async function handleToolCall(id, params) {
  const args = params?.arguments || {};
  const definition = toolDefinitions().find((tool) => tool.name === params?.name);
  if (!definition) {
    sendError(id, -32602, `Unknown tool: ${params?.name || ""}`);
    return;
  }
  const validationError = validateSchema(definition.inputSchema, args, "arguments");
  if (validationError) {
    sendError(id, -32602, validationError);
    return;
  }
  if (params?.name === TOOL_ASSET_CREATE) {
    const projectId = args.projectId || "default";
    // Creation goes through the shared ingest gate (lib/library-ingest.mjs,
    // ARCHITECTURE.md §8): identical bytes already in the library (outside
    // Trash) answer with the stored asset instead of a copy, and hashes the
    // caller claims in `source` are never trusted — the store recomputes them.
    // Absolute image paths anywhere on the local filesystem are accepted
    // by scoping trustedSourceRoots to the file's parent directory for this
    // single call. Relative paths are rejected by the store (IMAGE_PATH_NOT_READABLE).
    const { source, ...rest } = args;
    const input = source && typeof source === "object" && !Array.isArray(source)
      ? { ...rest, source: untrustedCreateSource(source) }
      : args;
    let trustedSourceRoots;
    if (typeof input.imagePath === "string" && isAbsolute(input.imagePath)) {
      try {
        const realFile = await realpath(input.imagePath);
        trustedSourceRoots = [dirname(realFile)];
      } catch {
        // Missing files or broken paths fail inside createAssetViaGate with
        // the existing store error (e.g. IMAGE_PATH_NOT_FOUND).
      }
    }
    const created = await createAssetViaGate(store, input, {
      skipIdenticalBytes: true,
      excludeProjectRoot: true,
      ...(trustedSourceRoots ? { trustedSourceRoots } : {}),
    });
    if (!created.ok) {
      if (created.skipped.reason !== "already-in-library") throw created.error;
      const located = created.skipped.existingAsset?.id
        ? await store.getAsset(projectId, created.skipped.existingAsset.id).catch(() => null)
        : null;
      const asset = located || created.skipped.existingAsset;
      sendResult(id, {
        content: [{ type: "text", text: `Asset already in library: ${asset.id} (identical bytes); returned the existing asset.` }],
        structuredContent: { asset, deduplicated: true },
      });
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
    const result = typeof store.listAssetPage === "function"
      ? await store.listAssetPage({ projectId: args.projectId || "default", query: args.query || "", limit: args.limit, cursor: args.cursor })
      : { assets: await store.listAssets({ projectId: args.projectId || "default", query: args.query || "" }), page: { nextCursor: null } };
    sendResult(id, { content: [{ type: "text", text: `${result.assets.length} assets` }], structuredContent: result });
    return;
  }
  if (params?.name === TOOL_ASSET_SEARCH) {
    const result = await searchMcpAssets({
      store,
      projectId: args.projectId || "default",
      query: args.query || "",
      createdAfter: args.createdAfter,
      createdBefore: args.createdBefore,
      // Legacy clients with a cached schema may still send visual: it is
      // accepted and ignored so they keep getting lexical results.
      visual: args.visual === true,
      limit: args.limit,
    });
    sendResult(id, { content: [{ type: "text", text: `${result.results.length} matching assets` }], structuredContent: result });
    return;
  }
  if (params?.name === TOOL_ASSET_GET) {
    const asset = await store.getAsset(args.projectId || "default", args.assetId);
    sendResult(id, { content: [{ type: "text", text: asset.prompt || `Asset ${asset.id}` }], structuredContent: { asset } });
    return;
  }
  if (params?.name === TOOL_ASSET_PROVENANCE_EXPORT) {
    const result = await buildAssetProvenanceBundle(store, args.projectId || "default", args.assetId, {
      includePrompts: args.includePrompts !== false,
    });
    sendResult(id, { content: [{ type: "text", text: `Exported provenance for ${args.assetId}` }], structuredContent: result });
    return;
  }
  if (params?.name === TOOL_ASSET_UPDATE_METADATA) {
    const { projectId = "default", assetId, ...patch } = args;
    // AI assistants edit on the user's behalf, so this counts as a human edit:
    // stamp markers so automatic prompt/theme writers keep their hands off.
    const current = await store.getAsset(projectId, assetId);
    const asset = await store.updateMetadata(projectId, assetId, withUserEditMarkers(current, patch));
    sendResult(id, { content: [{ type: "text", text: `Updated asset ${asset.id}` }], structuredContent: { asset } });
    return;
  }
  if (params?.name === TOOL_ASSET_ATTACH_PROMPT) {
    const projectId = args.projectId || "default";
    const current = await store.getAsset(projectId, args.assetId);
    const asset = await store.updateMetadata(projectId, args.assetId, withUserEditMarkers(current, { prompt: args.prompt }));
    sendResult(id, { content: [{ type: "text", text: `Attached prompt to ${asset.id}` }], structuredContent: { asset } });
    return;
  }
  if (params?.name === TOOL_ASSET_ARCHIVE) {
    const asset = await store.archiveAsset(args.projectId || "default", args.assetId);
    sendResult(id, { content: [{ type: "text", text: `Archived asset ${asset.id}` }], structuredContent: { asset } });
    return;
  }
  if (params?.name === TOOL_ASSET_DUPLICATE) {
    const asset = await store.duplicateAsset(args.projectId || "default", args.assetId, { assetId: args.assetIdNew });
    sendResult(id, { content: [{ type: "text", text: `Duplicated asset ${asset.id}` }], structuredContent: { asset } });
    return;
  }
  if (params?.name === TOOL_ASSET_VERSION_CREATE) {
    const { projectId = "default", assetId, assetIdNew, ...input } = args;
    const asset = await store.createAssetVersion(projectId, assetId, { ...input, assetId: assetIdNew }, { excludeProjectRoot: true });
    sendResult(id, { content: [{ type: "text", text: `Created version ${asset.id} from ${assetId}` }], structuredContent: { asset } });
    return;
  }
  if (params?.name === TOOL_ASSET_VERSION_HISTORY) {
    const history = await store.getAssetVersionHistory(args.projectId || "default", args.assetId);
    sendResult(id, { content: [{ type: "text", text: `${history.versions.length} versions rooted at ${history.root_asset_id}` }], structuredContent: { history } });
    return;
  }
  if (params?.name === TOOL_ASSET_RECIPE_HISTORY) {
    const history = await store.getRecipeSnapshotHistory(args.projectId || "default", args.assetId);
    sendResult(id, { content: [{ type: "text", text: `${history.snapshots.length} recipe snapshots for ${history.asset_id}` }], structuredContent: { history } });
    return;
  }
  if (params?.name === TOOL_GENERATION_RECORD) {
    if (typeof store.recordGenerationEvent !== "function") throw new Error("Generation history is unavailable.");
    assertExternalVerificationLevel(args.verificationLevel);
    const event = await store.recordGenerationEvent({
      project_id: args.projectId || "default",
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
    const events = await store.listGenerationEvents(args.projectId || "default", {
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
      project_id: args.projectId || "default",
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
    const lineage = await store.getGenerationLineage(args.projectId || "default", args.generationId);
    sendResult(id, { content: [{ type: "text", text: `${lineage.events.length} generation events in lineage` }], structuredContent: { lineage } });
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
        sendResult(id, {
          content: [{ type: "text", text: error.message }],
          isError: true,
          structuredContent: { error: { code: error.code, message: error.message } },
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
