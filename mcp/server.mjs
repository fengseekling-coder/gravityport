import "../lib/apply-env-aliases.mjs";
import readline from "node:readline";
import { homedir } from "node:os";
import { statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { readdir, realpath, stat } from "node:fs/promises";
import { createAssetStore } from "../lib/asset-store.mjs";
import { TRASH_RETENTION_MS } from "../lib/sqlite-asset-store.mjs";
import { confirmTimeoutMs, createLiveDeletionRequests } from "../lib/live-deletion-requests.mjs";
import { assetStoreError } from "../lib/asset-version-history.mjs";
import { assertExternalVerificationLevel } from "../lib/generation-history.mjs";
import { searchMcpAssets } from "../lib/mcp-asset-search.mjs";
import { createAssetViaGate, untrustedCreateSource } from "../lib/library-ingest.mjs";
import { withUserEditMarkers } from "../lib/user-edit-marker.mjs";
import { MAX_DERIVATIVE_INPUT_PIXELS } from "../lib/derivative-limits.js";
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
import {
  TOOL_ASSET_CREATE,
  TOOL_ASSET_IMPORT_FOLDER,
  TOOL_ASSET_LIST,
  TOOL_ASSET_SEARCH,
  TOOL_ASSET_GET,
  TOOL_ASSET_PROVENANCE_EXPORT,
  TOOL_ASSET_UPDATE_METADATA,
  TOOL_ASSET_ATTACH_PROMPT,
  TOOL_ASSET_TRASH,
  TOOL_ASSET_RESTORE,
  TOOL_ASSET_DUPLICATE,
  TOOL_ASSET_VERSION_CREATE,
  TOOL_ASSET_VERSION_HISTORY,
  TOOL_ASSET_RECIPE_HISTORY,
  TOOL_GENERATION_RECORD,
  TOOL_GENERATION_LIST,
  TOOL_GENERATION_RELATION_RECORD,
  TOOL_GENERATION_LINEAGE,
  TOOL_STACK_CREATE,
  TOOL_STACK_ADD_ASSETS,
  TOOL_STACK_RENAME,
  TOOL_STACK_REMOVE_ASSETS,
  TOOL_STACK_DISSOLVE,
  TOOL_STACK_GET,
  TOOL_STACK_LIST,
  toolDefinitions,
  withToolAnnotations,
} from "../lib/mcp-server/tool-definitions.mjs";
import { compactAsset, compactListLimit, compactResultText } from "../lib/mcp-server/compact-results.mjs";
import { validateSchema } from "../lib/mcp-server/validate-schema.mjs";

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
// Task 385 — the display name the App's confirmation dialog shows for this
// client, from initialize's clientInfo. Empty until (and if) the client sends one.
let mcpClientDisplayName = "";
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

// Folder import limits; the max-files override is a test knob.
function importFolderMaxFiles() {
  const parsed = Number.parseInt(process.env.MOSA_MCP_IMPORT_FOLDER_MAX_FILES || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
}
const IMPORT_FOLDER_MAX_DEPTH = 5;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

// Task 385 — the requester name shown in the App's confirmation dialog.
// Known clients get their display name; anything else non-empty is sanitized
// (control characters stripped, 40 characters) and used verbatim; empty means
// the dialog shows the anonymous wording.
function sanitizeClientDisplayName(rawName) {
  const value = String(rawName || "");
  const lowered = value.toLowerCase();
  if (lowered.includes("claude")) return "Claude";
  if (lowered.includes("codex")) return "Codex";
  if (lowered.includes("cursor")) return "Cursor";
  if (lowered.includes("gemini")) return "Gemini";
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return cleaned ? [...cleaned].slice(0, 40).join("") : "";
}

function sendProgressNotification(progressToken, { progress, total, message }) {
  send({
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { progressToken, progress, total, message },
  });
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

// Task 377: images an AI saves through MCP are not manual imports. When the
// caller passes neither sourceType nor source.type, and the file does not sit
// in the Codex output directory (the store still stamps codex-generated
// there), the MCP layer passes sourceType: "mcp-agent" so the App shows the
// existing "AI 助手" label instead of "手动导入". Already-archived images are
// never relabeled, and callers who name a source keep theirs.
const MCP_AGENT_SOURCE_TYPE = "mcp-agent";

/**
 * Decides whether MCP should stamp its own default source type onto a create
 * input, and does so in place. `realPath` may carry the file's already
 * resolved path; without it the file is resolved here. Returns the stamped
 * source type (or undefined when the caller's value stands or the store will
 * stamp codex-generated itself).
 */
async function applyMcpDefaultSourceType(input, realPath = null) {
  const declared = (typeof input.sourceType === "string" && input.sourceType.trim())
    || (input.source && typeof input.source === "object" && !Array.isArray(input.source)
      ? String(input.source.type || "").trim()
      : "");
  if (declared) return undefined;
  const realFile = realPath
    || (typeof input.imagePath === "string" && input.imagePath.trim() ? await realpath(input.imagePath).catch(() => null) : null);
  if (!realFile) return undefined; // Unresolvable files fail in the store (IMAGE_PATH_NOT_FOUND).
  const codexRoot = store?.codexImagesDir ? await realpath(store.codexImagesDir).catch(() => null) : null;
  if (codexRoot && isWithinDir(realFile, codexRoot)) return undefined;
  input.sourceType = MCP_AGENT_SOURCE_TYPE;
  return MCP_AGENT_SOURCE_TYPE;
}

// Task 377: business fields the store records itself — media shape read from
// the bytes (width/height/file_bytes/duration_seconds/media_kind/mime_type)
// and status the App's pipelines own (prompt_status via the edit markers,
// auto_archived). mergeBusinessFieldsPatch is shared with the App's editor,
// so it cannot refuse these; the MCP layer drops them before the patch
// leaves this process and reports what it dropped.
const SYSTEM_BUSINESS_FIELD_KEYS = new Set([
  "width",
  "height",
  "file_bytes",
  "duration_seconds",
  "media_kind",
  "mime_type",
  "prompt_status",
  "auto_archived",
]);

function stripSystemBusinessFields(businessFields) {
  if (!businessFields || typeof businessFields !== "object" || Array.isArray(businessFields)) {
    return { fields: businessFields, ignored: [] };
  }
  const ignored = Object.keys(businessFields).filter((key) => SYSTEM_BUSINESS_FIELD_KEYS.has(key));
  if (!ignored.length) return { fields: businessFields, ignored };
  const fields = { ...businessFields };
  for (const key of ignored) delete fields[key];
  return { fields, ignored };
}

function systemFieldsNotice(ignored) {
  const fieldsText = ignored.join(", ");
  return `这次传的 ${fieldsText} 是系统记录的，没有改。/ ${fieldsText} are recorded by GravityPort and were not changed.`;
}

// Task 377: asset ids are machine names. The store's sanitizeId reads and
// writes shared rows, so it rewrites a Chinese id instead of refusing it —
// two different calls could collapse onto the same mangled id. The MCP layer
// rejects non-conforming ids before the store sees them; the three checked
// tools are the ones that mint or rename an asset.
const MCP_ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{1,96}$/;
const INVALID_ASSET_ID_MESSAGE = "名字只能用英文字母、数字、下划线和连字符，最长 96 个字；不传的话会自动起名。\nAsset ids may only use letters, digits, underscores and hyphens (up to 96 characters); omit it to get one generated.";

function assertMcpAssetId(value) {
  if (value === undefined || value === null || value === "") return;
  if (typeof value !== "string" || !MCP_ASSET_ID_PATTERN.test(value)) {
    throw mcpToolError("INVALID_ASSET_ID", INVALID_ASSET_ID_MESSAGE);
  }
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
  ["IMAGE_FILE_INCOMPLETE", "这张图的文件不完整，可能下载或复制时断了，请换一份完整的文件。"],
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
  // Task 377: an AI importing a folder without naming a source saves its
  // files as mcp-agent; a folder inside the Codex output directory keeps the
  // store's codex-generated stamp. The scanned files all live under the
  // already-real folder path, so one decision covers the batch.
  const folderSourceInput = { sourceType: args.sourceType, source: args.source };
  await applyMcpDefaultSourceType(folderSourceInput, folderRealPath);
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
      sourceType: folderSourceInput.sourceType,
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
  // Task 377: reject non-conforming ids for the tools that mint or rename an
  // asset before anything reaches the store.
  if (params?.name === TOOL_ASSET_CREATE) assertMcpAssetId(args.assetId);
  if (params?.name === TOOL_ASSET_DUPLICATE || params?.name === TOOL_ASSET_VERSION_CREATE) assertMcpAssetId(args.assetIdNew);
  if (params?.name === TOOL_ASSET_CREATE) {
    // Creation goes through the shared ingest gate (lib/library-ingest.mjs,
    // ARCHITECTURE.md §8): identical bytes already in the library (outside
    // Trash) answer with the stored asset instead of a copy, and hashes the
    // caller claims in `source` are never trusted — the store recomputes them.
    // Absolute image paths anywhere on the local filesystem are accepted
    // by scoping trustedSourceRoots to the file's parent directory for this
    // single call; task 375 vets the path shape (spaces, file://, ~,
    // relative), library-internal paths and folders here in the MCP layer.
    const { source } = args;
    // Always a copy: the mcp-agent default below stamps `input`, and the
    // deduplicated path reports the caller's original args verbatim.
    const input = { ...args };
    if (source && typeof source === "object" && !Array.isArray(source)) {
      input.source = untrustedCreateSource(source);
    }
    // Task 377: system-recorded business fields never enter a create call.
    const systemFields = stripSystemBusinessFields(input.business_fields);
    if (systemFields.ignored.length) input.business_fields = systemFields.fields;
    let trustedSourceRoots;
    if (typeof input.imagePath === "string") {
      trustedSourceRoots = await vetImagePath(input.imagePath);
    }
    // Task 377: default the source type to mcp-agent for AI saves (Codex
    // output keeps codex-generated; caller-named sources are kept).
    const defaultedSourceType = await applyMcpDefaultSourceType(input);
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
    // Task 377: an image beyond the derivative pixel ceiling never gets a
    // thumbnail or preview in the App; warn the caller instead of failing.
    const width = Number(asset.business_fields?.width);
    const height = Number(asset.business_fields?.height);
    const tooLarge = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
      && width * height > MAX_DERIVATIVE_INPUT_PIXELS;
    let text = `Saved asset ${asset.id} at ${asset.image_path}`;
    if (tooLarge) {
      text += "\n这张图超过 2.68 亿像素，App 里不会生成缩略图和预览。/ This image exceeds 268 megapixels; the App will not generate a thumbnail or preview for it.";
    }
    if (systemFields.ignored.length) {
      text += `\n${systemFieldsNotice(systemFields.ignored)}`;
    }
    sendResult(id, {
      content: [{ type: "text", text }],
      structuredContent: {
        asset,
        ...(tooLarge ? { warnings: ["IMAGE_TOO_LARGE_FOR_PREVIEW"] } : {}),
        ...(systemFields.ignored.length ? { ignored_fields: systemFields.ignored } : {}),
      },
    });
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
    // Task 377: system-recorded business fields are dropped before the patch
    // reaches the marker writer — withUserEditMarkers stamps its own
    // business_fields.prompt_status on a prompt change, which must survive.
    const systemFields = stripSystemBusinessFields(patch.business_fields);
    if (systemFields.ignored.length) patch.business_fields = systemFields.fields;
    // AI assistants edit on the user's behalf, so this counts as a human edit:
    // stamp markers so automatic prompt/theme writers keep their hands off.
    const current = await store.getAsset("default", assetId);
    const asset = await store.updateMetadata("default", assetId, withUserEditMarkers(current, patch));
    let text = `Updated asset ${asset.id}`;
    const structuredContent = { asset };
    if (systemFields.ignored.length) {
      text += `\n${systemFieldsNotice(systemFields.ignored)}`;
      structuredContent.ignored_fields = systemFields.ignored;
    }
    sendResult(id, { content: [{ type: "text", text }], structuredContent });
    return;
  }
  if (params?.name === TOOL_ASSET_ATTACH_PROMPT) {
    const current = await store.getAsset("default", args.assetId);
    const asset = await store.updateMetadata("default", args.assetId, withUserEditMarkers(current, { prompt: args.prompt }));
    sendResult(id, { content: [{ type: "text", text: `Attached prompt to ${asset.id}` }], structuredContent: { asset } });
    return;
  }
  if (params?.name === TOOL_ASSET_TRASH) {
    // Task 385: when the user is looking at exactly this asset in the App's
    // viewer, the App asks before the move and this call waits for the answer.
    // No viewer / another asset / another project / the JSON backend / no
    // library at all: the trash proceeds exactly as before.
    if (await viewerWatchesAsset(args.assetId)) {
      const decision = await requestViewerDeletionDecision(args.assetId, params);
      if (decision !== "allowed") {
        sendResult(id, viewerDeletionRefusalResult(args.assetId, decision));
        return;
      }
    }
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
    // Task 377: system-recorded business fields never enter a version call either.
    const systemFields = stripSystemBusinessFields(input.business_fields);
    if (systemFields.ignored.length) input.business_fields = systemFields.fields;
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
      let text = `Created version ${asset.id} from ${assetId}`;
      if (systemFields.ignored.length) text += `\n${systemFieldsNotice(systemFields.ignored)}`;
      sendResult(id, {
        content: [{ type: "text", text }],
        structuredContent: { asset, ...(systemFields.ignored.length ? { ignored_fields: systemFields.ignored } : {}) },
      });
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
    // Task 377 (375-acceptance gap): the user's own words rode the generation
    // record only, so they were neither searchable nor visible in the App's
    // 用户指令 row. When the output asset carries no wording anywhere and
    // this record does, fill the empty slot once — later records never
    // overwrite the first wording. Deliberately without withUserEditMarkers:
    // an agent recording a generation is not a human editing the asset.
    const recordUserPrompt = typeof args.userPrompt === "string" ? args.userPrompt.trim() : "";
    if (recordUserPrompt && event.output_asset_id) {
      const outputAsset = await store.getAsset("default", event.output_asset_id).catch(() => null);
      const existingWording = [outputAsset?.user_prompt, outputAsset?.source?.user_message, outputAsset?.business_fields?.user_message]
        .map((value) => String(value || "").trim())
        .find(Boolean);
      if (outputAsset && !existingWording) {
        await store.updateMetadata("default", event.output_asset_id, { user_prompt: args.userPrompt });
      }
    }
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

// ---- Task 385: viewer-confirmation flow for asset_trash ----------------------

function mcpDelay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

// The confirmation protocol rides on the shared .live/ directory of the open
// library; JSON backends and not-yet-open libraries never confirm (task 385
// rule 10) — the trash behaves exactly as it did before this task.
function mcpLiveDeletionRequests() {
  return createLiveDeletionRequests({ libraryDir });
}

/** True only when the App viewer is fresh and showing exactly this asset. */
async function viewerWatchesAsset(assetId) {
  if (!libraryDir || !store || store.storageKind !== "sqlite") return false;
  const requests = mcpLiveDeletionRequests();
  const viewer = await requests.readViewer();
  if (!requests.isViewerFresh(viewer)) return false;
  if (String(viewer.projectId) !== "default") return false;
  return String(viewer.assetId) === String(assetId);
}

/**
 * Files (or merges into) a delete request and polls the file every 250 ms
 * until the App writes a decision, the window closes (this process writes the
 * timeout itself — task 385 rule 3), or the outer bound (expiresAt + 2 s)
 * passes. While waiting, progress notifications every 5 s keep a client with
 * a progressToken from timing out.
 */
async function requestViewerDeletionDecision(assetId, params) {
  const requests = mcpLiveDeletionRequests();
  const timeoutMs = confirmTimeoutMs();
  const { request, created } = await requests.createDeleteRequest({
    projectId: "default",
    assetId,
    requester: { kind: "mcp", name: mcpClientDisplayName, pid: process.pid },
  });
  const progressToken = params?._meta?.progressToken;
  const totalSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const pollEveryMs = 250;
  const progressEveryMs = 5_000;
  const startedAt = Date.now();
  let lastProgressAt = progressToken === undefined ? Number.POSITIVE_INFINITY : startedAt;
  try {
    while (true) {
      await mcpDelay(pollEveryMs);
      if (progressToken !== undefined && Date.now() - lastProgressAt >= progressEveryMs) {
        lastProgressAt = Date.now();
        sendProgressNotification(progressToken, {
          progress: Math.min(totalSeconds, Math.round((Date.now() - startedAt) / 1000)),
          total: totalSeconds,
          message: "正在等用户在 GravityPort 里确认删除…",
        });
      }
      const current = await requests.readRequest(request.id);
      // The file vanished while pending (only the 10-minute sweep can do
      // that): there is no answer to wait for any more.
      if (!current) return "cancelled";
      if (current.status !== "pending") {
        // A late allow (decidedAt after the window) is no answer (rule 3).
        if (current.status === "allowed" && Number(current.decidedAt) > Number(current.expiresAt)) return "timeout";
        return current.status;
      }
      if (Date.now() > Number(current.expiresAt)) {
        await requests.writeDecision(request.id, "timeout", { enforceExpiry: false }).catch(() => {});
        return "timeout";
      }
      if (Date.now() > Number(current.expiresAt) + 2_000) return "timeout";
    }
  } finally {
    // Rule 3: the requester removes the request file it created once it holds
    // the final result. A merged waiter leaves the creator's file alone.
    if (created) await requests.deleteRequest(request.id).catch(() => {});
  }
}

/** The isError result for every non-allowed decision (task 385 rule 8). */
function viewerDeletionRefusalResult(assetId, decision) {
  const seconds = Math.max(1, Math.round(confirmTimeoutMs() / 1000));
  const declinedText = `用户拒绝了这次删除，素材没有动。/ The user declined this deletion; the asset was not changed. (${assetId})`;
  const byDecision = {
    denied: { reason: "user_denied", text: declinedText },
    timeout: {
      reason: "user_no_response",
      text: `用户 ${seconds} 秒内没有回应，素材没有删除。/ The user did not respond within ${seconds} seconds; the asset was not deleted. (${assetId})`,
    },
    cancelled: { reason: "cancelled", text: declinedText },
  };
  const refusal = byDecision[decision] || byDecision.cancelled;
  return {
    content: [{ type: "text", text: refusal.text }],
    isError: true,
    structuredContent: {
      asset_id: assetId,
      trashed: false,
      reason: refusal.reason,
    },
  };
}

async function handleRequest(message) {
  const { id, method, params } = message;
  // JSON-RPC notifications (no `id`, e.g. notifications/initialized) must never
  // get a response; none of them needs handling here.
  if (!Object.hasOwn(message, "id")) return;
  if (method === "initialize") {
    // Task 385 — remember who is asking, so the App's confirmation dialog can
    // say "允许 Claude 删除这张素材吗？" instead of the anonymous wording.
    mcpClientDisplayName = sanitizeClientDisplayName(params?.clientInfo?.name);
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
