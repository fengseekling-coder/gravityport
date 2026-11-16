import Database from "better-sqlite3";
import { constants as fsConstants, createReadStream, existsSync, mkdirSync, rmSync, statfsSync, statSync } from "node:fs";
import { copyFile, link, lstat, mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { imageDecoder } from "./image-decode-client.js";
import {
  derivativeTempFileName,
  publishDerivativeFile,
  removeStaleDerivativeTempFiles,
} from "./derivative-temp-file.js";
import { createHash, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { isPathInside } from "./path-safety.mjs";
import { LIBRARY_DATABASE_FILE, resolveLibraryLocation } from "./library-location.mjs";
import {
  assetAlreadyExistsError,
  assetNotFoundError,
  assetStoreError,
  automaticIngestDuplicateError,
  automaticImportSuppressedError,
  assertMutableVersionPatch,
  buildAssetVersionHistory,
  derivedAssetSource,
  manualImportDuplicateError,
  pickVersionOverrides,
  requireVersionChange,
} from "./asset-version-history.mjs";
import { createdAtTimestamp, normalizeCreatedAt, recentCutoffTimestamp } from "./recent-window.js";
import { mergeAssetCuration } from "./asset-curation.mjs";
import {
  mergeAssetCanvasState,
  normalizeAssetCanvasState,
  normalizeCanvasAssetIds,
  validateCanvasStatePatch,
} from "./asset-canvas-state.mjs";
import { assetOrganizedSql } from "./asset-organized.mjs";
import { repairCaptureHistory } from "./repair-capture-history.mjs";
import { repairClearedCapturePrompts } from "./repair-cleared-prompts.mjs";
import {
  applyGenerationMessageBindings as applyGenerationMessageBindingsInDatabase,
  backfillGenerationMessageIdsFromAssets,
  ensureGenerationMessageBindingSchema,
  supplementGenerationEventMessageId,
} from "./generation-message-binding.mjs";
import { buildRecipeSnapshot, normalizeSnapshotReferences } from "./recipe-snapshot.js";
import { scheduleReferenceHardlinkMigration } from "./reference-hardlink-migration.js";
import { assetSortName, normalizeAssetSort } from "./asset-sort.js";
import { extractImagePalette } from "./image-palette.js";
import {
  assetMatchesSearchKind,
  assetSearchKind,
  normalizeAssetSearchQuery,
} from "./asset-search.mjs";
import { relinkCodexAssets } from "./codex-hardlink.js";
import { PIXEL_HASH_VERSION, safePixelDigest } from "./image-pixel-hash.js";
import {
  PERCEPTUAL_HASH_ALGORITHM,
  computePerceptualHash,
  parsePerceptualHash,
} from "./perceptual-hash.js";
import { resolveSourceLocations } from "./source-locations.js";
import {
  ensureSchemaUpgradeBackup,
  schemaUpgradeRecoveryError,
} from "./schema-upgrade-backup.mjs";
import {
  markPendingSchemaUpgradeVerify,
  markSchemaUpgradeNoticeDismissed,
  readSchemaUpgradeVerifyRecord,
  runSchemaUpgradeVerify,
} from "./schema-upgrade-verify.mjs";
import {
  maybeKillSchemaUpgradeTestProcess,
  settleSchemaUpgradeBackupCleanup,
} from "./schema-backup-cleanup.mjs";
import { cleanupPermanentDeletionStaging, stageFilesForPermanentDeletion } from "./trash-files.mjs";
import { canonicalSourceTypeOf, GENERATION_SESSION_TITLE_MAX_LENGTH, generationSessionKey, generationSessionTitle } from "./generation-session.mjs";
import {
  assetFileNameStem,
  rebuildSearchScopeTextsBatched,
  searchableAssetName,
  searchableBusinessObjectText,
  searchableSourceObjectText,
} from "./asset-search-scope.mjs";
import { hasNonAsciiStem, sanitizeFileName } from "./asset-file-name.mjs";
import {
  assertGenerationRelationUserMutable,
  buildAssetGenerationHistory,
  buildGenerationLineage,
  generationHistoryError,
  mergeGenerationEventForUpdate,
  normalizeGenerationEvent,
  normalizeGenerationRelation,
  normalizeGenerationRelationCandidate,
  preserveTrustedGenerationRelation,
} from "./generation-history.mjs";

import { MAX_DERIVATIVE_INPUT_PIXELS } from "./derivative-limits.js";
import {
  backfillFileBytesFromFiles,
  backfillVideoMetadataFromFiles,
  countNamedValues,
  mergeBusinessFieldsPatch,
  missingFileBytesField,
  missingImageDimensionFields,
  missingVideoDimensionFields,
} from "./sqlite-store/backfills.mjs";
import {
  assetTimeFilterKey,
  encodeCursor,
  encodeStackCursor,
  isGalleryRowAfterCursor,
  isStackRowAfterCursor,
  normalizeLimit,
  normalizeStackSort,
  parseCursor,
  parseStackCursor,
} from "./sqlite-store/cursors.mjs";
import {
  assertSqliteGenerationRelationAcyclic,
  assertSqliteVersionParent,
  findSqliteVersionRoot,
  generationEventFromRow,
  generationOutputAssetIds,
  generationRelationCandidateFromRow,
  generationRelationFromRow,
  sqliteGenerationCandidatesForEvents,
  sqliteGenerationComponentEvents,
  sqliteGenerationContextEvents,
  sqliteGenerationRelationsForEvents,
  syncSqliteGenerationRelationCandidates,
  syncSqliteGenerationRelationCandidatesForEvent,
} from "./sqlite-store/generation-rows.mjs";
import {
  normalizeAssetMetadata,
  unknownFields,
} from "./sqlite-store/metadata.mjs";
import {
  assertStoredPath,
  codexSourceMetadata,
  hardLinkOrCopy,
  resolveReadableImagePath,
} from "./sqlite-store/paths.mjs";
import {
  isSqliteDuplicateError,
  paletteJsonToHexes,
  parseJson,
} from "./sqlite-store/rows-util.mjs";
import {
  buildFtsQuery,
  buildSearchScoreSql,
  escapeLikePattern,
  isIndexedShortUnicodeTerm,
  plainAsciiSearchTerms,
  resolveAssetSearchQuery,
  searchScopeRebuildHelpers as buildSearchScopeRebuildHelpers,
  searchableText,
  shortUnicodeSearchTerms,
} from "./sqlite-store/search-sql.mjs";
import {
  automaticIngestIdentityKey,
  automaticIngestIdentityKind,
  automaticSuppressionIdentityForAsset,
  clearIdentitySuppressionRow,
  contentHashForAsset,
  normalizeHash,
  normalizeSuppressionHashes,
  normalizeSuppressionRecord,
  recordIdentitySuppressionRow,
  sha256File,
  suppressionRowToObject,
} from "./sqlite-store/suppression.mjs";
import {
  DEFAULT_PROJECT_ID,
  DERIVED_MAINTENANCE_BATCH_SIZE,
  VIDEO_EXTENSIONS,
  canonicalGroupName,
  mediaKindOf,
  normalizeGroupColor,
  normalizeGroupName,
  normalizeParentAssetId,
  now,
  sanitizeId,
  sanitizeProjectId,
  shortStamp,
  slugName,
} from "./sqlite-store/util.mjs";
import {
  deleteAssetFtsEntry,
  dropAssetSearchTerms,
  ensureAssetSearchDoc,
  migrateSearchIndexToDocIds,
  purgeAssetSearchIndex,
  replaceAssetShortTerms,
  runFtsMergeMaintenance,
  runSearchIndexVacuumIfNeeded,
  syncAssetFtsEntry,
} from "./sqlite-store/search-index.mjs";
import {
  attachAssetTags,
  backfillRecipeSnapshots,
  mergeReplacementObject,
  REPLACED_MEDIA_TRASH_REASON,
  rowToAsset,
  saveAsset,
  sqliteRecipeHistory,
  stageReplacedMediaSnapshot,
} from "./sqlite-store/asset-records.mjs";
import { addAutoStackExclusions, annotateAssetStackCovers, annotateGalleryNodeSort, AUTO_STACK_BACKFILL_NOTIFY_KEY, autoStackAssetAfterInsert, backfillAutoSessionStacks, compactAssetStack, regroupJimengWorkspaceStacks, sessionTitleMayNameStack, sortUnlockedAutoStack, STACK_LIVE_COVER_SORT_NAME_SQL, stackSummary, syncAssetStackCoverSortName, targetStackForSession } from "./sqlite-store/stacks.mjs";
import { appendFilterConditions, appendSearchConditions, buildCollapsedMatchedCte, galleryStackNodesCacheState, listCollapsedAssetPage, PAGE_ASSET_COLUMNS } from "./sqlite-store/gallery-page.mjs";
import { DERIVED_CREATED_AT_EPOCH_MARKER, DERIVED_CREATED_AT_EPOCH_VERSION, DERIVED_SORT_NAME_MARKER, DERIVED_SORT_NAME_VERSION, DERIVED_STACK_SORT_COLUMNS_MARKER, DERIVED_STACK_SORT_COLUMNS_VERSION, DERIVED_STACK_SORT_CREATED_AT_MARKER, DERIVED_STACK_SORT_CREATED_AT_VERSION, derivedMarkerCurrent, ensureAssetCanvasStateTable, ensureAssetPaletteColumn, ensureAssetStackOrderLocked, ensureAssetStackSortColumns, ensureAutoStackStructures, ensureCreatedAtEpoch, ensureGenerationEventColumns, ensureGenerationSessionColumn, ensureGroupColumns, ensureMediumPathColumn, ensurePixelHashColumn, ensureSearchScalarColumns, ensureSortName, ensureSourcePathColumn, ensureSuppressionPixelHashVersion, ensureTrashColumn, ensureWebCaptureLookupColumns, writeDerivedMarker } from "./sqlite-store/schema-passes.mjs";
export { addColumnIfMissing } from "./sqlite-store/schema-passes.mjs";
export { shortUnicodeSearchTerms } from "./sqlite-store/search-sql.mjs";
export function searchScopeRebuildHelpers(database) {
  return buildSearchScopeRebuildHelpers(database, { rowToAsset, syncAssetFtsEntry, replaceAssetShortTerms });
}

function videoPosterError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.expose = true;
  return error;
}
export const STYLE_FACET_LIMIT = 200;
// Task 430: v19 adds asset_canvas_state (final/marks/card positions).
export const CURRENT_SCHEMA_VERSION = 19;
// Task 291 manual-import dedupe. T and R come from tasks/291-阈值标定.md,
// option A ("catch everything"), chosen by the user on 2026-10-29: recall
// 98.5% on rescaled/recompressed copies, with roughly 4-7% of same-round
// sibling images expected to show up in the review list (default action is
// keep, and nothing is ever processed automatically on hash distance alone —
// identical pixels are confirmed with safePixelDigest). R is 10× the largest
// aspect-ratio drift observed on positive samples (0.0029), so scaled copies
// stay comparable while differently shaped images never become candidates.
const SIMILAR_DISTANCE_THRESHOLD = 8;
const SIMILAR_RATIO_TOLERANCE = 0.03;
// Pairs decoded per similar-check call for the pixel-exact confirmation; the
// rest defer to the next poll so one request cannot stall on hundreds of
// original decodes.
const SIMILAR_LAZY_PIXEL_BUDGET_PER_CHECK = 20;
const PERCEPTUAL_BACKFILL_BATCH = 200;
// Candidate hashes are pre-parsed into uint32 pairs once per similar-check
// call; the inner loop must stay xor + table lookup only (task 291 rework §3).
const PERCEPTUAL_POPCOUNT = new Uint8Array(65536);
for (let value = 1; value < 65536; value += 1) PERCEPTUAL_POPCOUNT[value] = PERCEPTUAL_POPCOUNT[value & (value - 1)] + 1;

/** Positive width/height pair from an asset row's business_fields JSON, or null. */
function businessFieldDims(businessFieldsJson) {
  const fields = parseJson(businessFieldsJson, {});
  const width = Number(fields?.width);
  const height = Number(fields?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return [width, height];
}

/** Hamming distance between two stored 16-hex perceptual hashes (no prefix). */
function perceptualHexDistance(hashA, hashB) {
  const high = (parseInt(hashA.slice(0, 8), 16) ^ parseInt(hashB.slice(0, 8), 16)) >>> 0;
  const low = (parseInt(hashA.slice(8, 16), 16) ^ parseInt(hashB.slice(8, 16), 16)) >>> 0;
  return PERCEPTUAL_POPCOUNT[high & 0xffff] + PERCEPTUAL_POPCOUNT[(high >>> 16) & 0xffff]
    + PERCEPTUAL_POPCOUNT[low & 0xffff] + PERCEPTUAL_POPCOUNT[(low >>> 16) & 0xffff];
}
// Bounded change-journal retention: the delta API answers "what happened since
// revision N" from these rows. Anything older is pruned, and a client that asks
// for a pruned revision receives an explicit gap instead of silent data loss.
export const LIBRARY_CHANGE_JOURNAL_LIMIT = 20_000;
export const TRASH_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export function sqliteDatabasePath(libraryDir) {
  return join(resolve(libraryDir), LIBRARY_DATABASE_FILE);
}

// 任务 337：库校验失败要报出真实原因。占用（BUSY/LOCKED，以及 Windows 上能
// 从 message 认出的共享冲突）先短暂重试，仍失败抛 SQLITE_LIBRARY_BUSY；其余
// （损坏、不是数据库、表缺失、权限等）保持 SQLITE_LIBRARY_UNREADABLE。两类都
// 在抛出前用 console.error 留一条 [MOSA] 日志，让 userData/logs/gravityport.log
// 带上原始 SQLite 错误码，远程才能判断是被占用还是真坏了。
const LIBRARY_VERIFY_RETRY_DELAYS_MS = [300, 600, 900, 1200]; // 合计 3000ms。

function syncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sqliteErrorCodeOf(cause) {
  return typeof cause?.code === "string" && cause.code ? cause.code : "";
}

// Windows 文件共享冲突会以 SQLITE_IOERR*/SQLITE_CANTOPEN 的面目出现，但消息里
// 不带可辨认特征时和真损坏无法区分——只有 message 自己点名共享条件才归占用，
// 认不出就不猜，留给 UNREADABLE。
const WINDOWS_SHARE_MESSAGE_RE = /(sharing violation|resource busy|being used by another process)/i;

function isBusySqliteCause(cause) {
  const code = sqliteErrorCodeOf(cause);
  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) return true;
  if (process.platform !== "win32") return false;
  if (!code.startsWith("SQLITE_IOERR") && !code.startsWith("SQLITE_CANTOPEN")) return false;
  return WINDOWS_SHARE_MESSAGE_RE.test(String(cause?.message || ""));
}

/** One read-only verification attempt; throws the raw SQLite error on failure. */
function readLibraryMigrationStateReadonly(databasePath) {
  let database;
  try {
    // timeout: 0 turns off better-sqlite3's built-in 5s busy handler so the
    // retry policy above (not the driver) owns the waiting budget.
    database = new Database(databasePath, { readonly: true, timeout: 0 });
    const row = database.prepare("SELECT value FROM library_meta WHERE key = 'migration_state'").get();
    return row?.value === "completed";
  } finally {
    database?.close?.();
  }
}

function libraryVerificationError(libraryDir, databasePath, cause) {
  const sqliteCode = sqliteErrorCodeOf(cause) || "unknown";
  // One [MOSA] console.error per verification failure: installDiagnosticLog
  // mirrors it (with the standard redaction) into userData/logs/gravityport.log.
  console.error(`[MOSA] Existing SQLite library could not be verified: ${databasePath} (sqlite code: ${sqliteCode}, sqlite message: ${cause?.message || cause})`);
  const error = new Error(`Existing SQLite library could not be verified: ${databasePath}`, { cause });
  error.code = isBusySqliteCause(cause) ? "SQLITE_LIBRARY_BUSY" : "SQLITE_LIBRARY_UNREADABLE";
  error.libraryDir = resolve(libraryDir);
  error.sqliteCode = sqliteCode;
  return error;
}

export function hasCompletedSqliteLibrary(libraryDir) {
  const databasePath = sqliteDatabasePath(libraryDir);
  if (!existsSync(databasePath)) return false;
  let lastCause;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return readLibraryMigrationStateReadonly(databasePath);
    } catch (cause) {
      lastCause = cause;
      // Only a busy/locked cause is worth waiting on; damage cannot heal.
      if (attempt >= LIBRARY_VERIFY_RETRY_DELAYS_MS.length || !isBusySqliteCause(cause)) break;
      syncSleep(LIBRARY_VERIFY_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw libraryVerificationError(libraryDir, databasePath, lastCause);
}

/**
 * Task 350 (audit 5-2 #7): the schema version read on a read-only connection
 * before the real open touches anything. Returns null when the version cannot
 * be decided (missing file, missing table, unreadable database) — the normal
 * open path owns those cases; a decided version > CURRENT_SCHEMA_VERSION is
 * the only signal this probe exists for. A read-only connection never writes
 * the database file, so a refused open leaves mosa.db byte-identical.
 *
 * Task 357: the probe must NEVER delete the -wal/-shm files, even ones it
 * created itself. Between the probe's existence check and its cleanup another
 * process (the App, the background capture service, an MCP client) can open
 * the same library and start committing into that very -wal; deleting it
 * threw away committed frames and left indexes missing rows ("database disk
 * image is malformed"). An empty -wal and a -shm left next to a refused
 * library are harmless — the next opener reuses them.
 */
function probeSqliteSchemaVersionReadonly(databasePath) {
  if (!existsSync(databasePath)) return 0;
  let database;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 0 });
    const table = database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'library_meta' LIMIT 1").get();
    if (!table) return 0;
    const row = database.prepare("SELECT value FROM library_meta WHERE key = 'schema_version'").get();
    if (!row) return 0;
    const version = Number(row.value);
    return Number.isInteger(version) && version >= 0 ? version : 0;
  } catch {
    return null;
  } finally {
    try { database?.close(); } catch { /* already closed */ }
  }
}

/**
 * Task 350 (audit 5-2 #7): the fixed error for a library newer than this
 * build. The desktop maps MOSA_LIBRARY_SCHEMA_NEWER to its own dialog
 * (desktop/notification-i18n.mjs); MCP and CLI surface the message, which
 * itself says what to do.
 */
function newerSchemaLibraryError(existingVersion, libraryDir) {
  const error = new Error(
    `This library was last opened by a newer version of GravityPort (database schema v${existingVersion}, this build supports v${CURRENT_SCHEMA_VERSION}). `
    + "Please download the latest GravityPort to open it. Your assets were not modified.",
  );
  error.code = "MOSA_LIBRARY_SCHEMA_NEWER";
  error.libraryDir = resolve(libraryDir);
  error.schemaVersion = existingVersion;
  return error;
}

/**
 * SQLite implementation of MOSA's existing asset-store contract. It keeps the
 * public shape used by HTTP, MCP and bridge code while making the database the
 * only mutable metadata authority after a verified migration.
 */
export function createSqliteAssetStore(options = {}) {
  const projectRoot = resolve(options.projectRoot || process.cwd());
  const managerDir = resolve(options.managerDir || join(projectRoot, "mosa"));
  const libraryDir = options.libraryDir
    ? resolve(options.libraryDir)
    : resolveLibraryLocation({ homeDir: homedir(), envLibraryDir: process.env.MOSA_LIBRARY_DIR }).libraryDir;
  const assetsRoot = join(libraryDir, "assets");
  const legacyAssetsRoot = options.legacyAssetsRoot ? resolve(options.legacyAssetsRoot) : null;
  const generatedImagesDir = resolve(options.generatedImagesDir || join(projectRoot, "generated-images"));
  const { codexImagesDir, cowartCanvasDir } = resolveSourceLocations({
    env: process.env,
    overrides: {
      codexImagesDir: options.codexImagesDir,
      cowartCanvasDir: options.cowartCanvasDir,
    },
  });
  const cowartPageAssetsDir = join(cowartCanvasDir, "pages");
  const databasePath = sqliteDatabasePath(libraryDir);
  const databaseExisted = existsSync(databasePath);
  // Per-store (not module-level): two libraries open in one process must each
  // run their own backfill once.
  let perceptualBackfillStarted = false;
  // Set by startDeferredMaintenance; the runtime holds shutdown on it so a
  // crash never interrupts a committed repair batch mid-close. Rework 1:
  // shutdown also aborts the chain's signal first, so the wait only ever
  // spans the batch in flight — a stopped chain resolves between two batches
  // and the next open redoes the uncommitted remainder.
  let deferredMaintenanceChain = null;
  let deferredMaintenanceSignal = null;

  // Task 350 (audit 5-2 #7): a library written by a NEWER app version must be
  // refused before anything can write to it. The probe is a read-only
  // connection that never creates -wal/-shm files and closes before the real
  // open, so a refused open leaves mosa.db byte-identical.
  const probedSchemaVersion = probeSqliteSchemaVersionReadonly(databasePath);
  if (probedSchemaVersion != null && probedSchemaVersion > CURRENT_SCHEMA_VERSION) {
    throw newerSchemaLibraryError(probedSchemaVersion, libraryDir);
  }
  const database = openDatabase(databasePath);
  // Audit 261 mid-23: the post-upgrade whole-library verification no longer
  // runs inside the open — a full integrity_check would block the main process
  // for seconds before the first request. The upgrade itself runs in ONE
  // immediate transaction that re-reads the version under the write lock
  // (task 350 #3): ensure* passes, migrations, the pre-v10 candidate sync,
  // the version bump, the migration rows and the pending check record all
  // commit together or not at all. The deep check still runs in a worker
  // thread from startDeferredMaintenance once the service is listening, and
  // records its verdict in library_meta under schema_upgrade_verify.
  let schemaUpgradeBackup = null;
  try {
    const schemaBackup = ensureSchemaUpgradeBackup(database, {
      libraryDir,
      targetVersion: CURRENT_SCHEMA_VERSION,
      databaseExisted,
    });
    schemaUpgradeBackup = schemaBackup;
    if (schemaBackup.created) maybeKillSchemaUpgradeTestProcess("after-backup");
    let initResult;
    try {
      // The pending record is written inside the upgrade transaction whenever
      // an upgrade proceeds — also when the snapshot rename was degraded to
      // reuse (Windows lock on the previous file): that snapshot still needs
      // its verdict.
      initResult = initializeSchema(database, {
        upgrade: schemaBackup.path ? { backupPath: schemaBackup.path } : null,
        libraryDir,
      });
    } catch (error) {
      throw schemaUpgradeRecoveryError(error, schemaBackup);
    }
    if (initResult?.upgradeAborted) {
      // Another process committed the same upgrade between our snapshot and
      // our lock. Our fresh snapshot is redundant — but the file at the final
      // name may already be the other process's pending record's snapshot
      // (both renames target one path), so deleting it here could orphan
      // THEIR record. Leave it: the ok-verdict cleanup pass deletes every
      // non-kept snapshot once verification passes.
      schemaUpgradeBackup = null;
    } else if (initResult?.upgraded) {
      maybeKillSchemaUpgradeTestProcess("after-commit");
    }
    // Task 348: the one-time post-migration compaction (optimize + VACUUM).
    // Runs on the open that performed the v18 upgrade and on any later open
    // whose marker is still pending; failures are logged and retried on the
    // next open, never fail the open itself.
    runSearchIndexVacuumIfNeeded(database, {
      databasePath,
      libraryDir,
      tmpDir: tmpdir(),
      freeDiskBytes: options.freeDiskBytes,
    });
    if (options.initializeFreshLibrary === true) {
      const migrationState = database.prepare("SELECT value FROM library_meta WHERE key = 'migration_state'").get()?.value;
      if (migrationState === "unmigrated") {
        const timestamp = now();
        const writeFreshState = database.transaction(() => {
          const set = database.prepare("INSERT INTO library_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
          set.run("migration_state", "completed", timestamp);
          set.run("migration_details", JSON.stringify({ source: "fresh-library" }), timestamp);
        });
        writeFreshState();
      }
    }
  } catch (error) {
    // WAL note: the database may have a half-written WAL on this error path. Run an
    // explicit TRUNCATE checkpoint before close() so the next opener does not inherit
    // an inconsistent WAL segment.
    try {
      database.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // pragma is a no-op if the WAL is already empty or the journal mode has changed.
    }
    database.close();
    throw error;
  }
  const ftsPageCache = new Map();
  const navigationStatsCache = new Map();
  const lifecycleQueues = new Map();
  let localAssetRevision = 0;
  const invalidateFtsPageCache = () => {
    localAssetRevision += 1;
    ftsPageCache.clear();
    navigationStatsCache.clear();
    // Task 320: the collapsed-stack node cache lives per database connection
    // (its temp table is connection-local). Dropping the entry here is the
    // "localAssetRevision" segment of its cache key: the next paged collapsed
    // query rebuilds from the current rows instead of trusting stale nodes.
    galleryStackNodesCacheState.delete(database);
  };

  const readLibraryRevisionCounter = () => Number(
    database.prepare("SELECT value FROM library_meta WHERE key = 'library_revision'").get()?.value || 0,
  );

  const queueDerivativeChange = (projectId, assetId) => {
    const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
    const cleanAssetId = sanitizeId(assetId, "asset");
    database.prepare(`
      INSERT INTO pending_derivative_changes (project_id, asset_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(project_id, asset_id) DO UPDATE SET updated_at = excluded.updated_at
    `).run(cleanProjectId, cleanAssetId, now());
  };

  /**
   * Records library change entries and advances the per-library revision counter.
   * Must run inside the same transaction (or immediately after, in one transaction
   * with) the mutation it describes, so a crash can never commit a mutation whose
   * change row is missing, or a change row whose mutation rolled back. better-sqlite3
   * nests transactions via SAVEPOINT, so callers already inside database.transaction()
   * stay atomic with this write.
   */
  const commitLibraryChanges = database.transaction((records) => {
    const usable = (Array.isArray(records) ? records : []).filter((record) => record && typeof record.kind === "string");
    if (!usable.length) return 0;
    const revision = database.prepare(`
      INSERT INTO library_meta (key, value, updated_at) VALUES ('library_revision', '1', ?)
      ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(library_meta.value AS INTEGER) + 1 AS TEXT), updated_at = excluded.updated_at
      RETURNING CAST(value AS INTEGER) AS revision
    `).get(now()).revision;
    const insert = database.prepare(`
      INSERT INTO library_changes (project_id, revision, kind, entity_type, entity_id, flags_json, asset_ids_json, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const timestamp = now();
    for (const record of usable) {
      insert.run(
        sanitizeProjectId(record.projectId || DEFAULT_PROJECT_ID),
        revision,
        String(record.kind),
        String(record.entityType || "asset"),
        String(record.entityId || ""),
        JSON.stringify(Array.isArray(record.flags) ? record.flags : []),
        JSON.stringify(Array.isArray(record.assetIds) ? record.assetIds : []),
        JSON.stringify(record.detail && typeof record.detail === "object" ? record.detail : {}),
        timestamp,
      );
    }
    // Every stack write lands here, so this is where a stack's gallery date
    // follows its members (see refreshStackSortCreatedAt).
    const touchedStacks = new Set();
    for (const record of usable) {
      if (record.entityType === "stack" && record.entityId) {
        touchedStacks.add(`${sanitizeProjectId(record.projectId || DEFAULT_PROJECT_ID)}\u001f${record.entityId}`);
      }
    }
    for (const key of touchedStacks) {
      const [projectId, stackId] = key.split("\u001f");
      refreshStackSortCreatedAt(database, projectId, stackId);
    }
    // Single indexed range delete; usually matches nothing.
    database.prepare(`
      DELETE FROM library_changes
      WHERE seq <= (SELECT COALESCE(MAX(seq), 0) FROM library_changes) - ?
    `).run(LIBRARY_CHANGE_JOURNAL_LIMIT);
    invalidateFtsPageCache();
    return revision;
  });

  const flushDerivativeChanges = database.transaction(() => {
    const rows = database.prepare(`
      SELECT project_id, asset_id
      FROM pending_derivative_changes
      ORDER BY project_id, updated_at, asset_id
    `).all();
    if (!rows.length) return 0;
    const records = [];
    let activeProject = null;
    let batch = [];
    const pushBatch = () => {
      if (!batch.length || !activeProject) return;
      records.push({
        projectId: activeProject,
        kind: "assets-updated",
        entityType: "asset-batch",
        entityId: "derivatives",
        assetIds: batch,
        flags: ["derivatives"],
      });
      batch = [];
    };
    for (const row of rows) {
      if (activeProject !== row.project_id || batch.length >= 500) {
        pushBatch();
        activeProject = row.project_id;
      }
      batch.push(row.asset_id);
    }
    pushBatch();
    const revision = commitLibraryChanges(records);
    database.prepare("DELETE FROM pending_derivative_changes").run();
    return revision;
  });

  // Migration 16 backfills auto session stacks inside the schema transaction,
  // before this closure exists, and parks the touched project ids in
  // library_meta. Announce one unclassified change per project so every open
  // window takes its full-recovery path and re-renders the new stack nodes;
  // per-stack events would spam the journal for a purely historical sweep.
  const pendingBackfillProjects = parseJson(
    database.prepare("SELECT value FROM library_meta WHERE key = ?").get(AUTO_STACK_BACKFILL_NOTIFY_KEY)?.value || "[]",
    [],
  );
  if (Array.isArray(pendingBackfillProjects) && pendingBackfillProjects.length) {
    database.transaction(() => {
      commitLibraryChanges(pendingBackfillProjects.map((projectId) => ({
        projectId,
        kind: "library-backfilled",
        entityType: "stack",
        entityId: "",
        assetIds: [],
        detail: { reason: "auto-session-stacks" },
      })));
      database.prepare("DELETE FROM library_meta WHERE key = ?").run(AUTO_STACK_BACKFILL_NOTIFY_KEY);
    })();
  }
  // The six one-time repairs (capture history, generation message ids, cleared
  // prompts, search-scope rebuild, video metadata, file bytes) and the FTS
  // trash-row cleanup used to run right here, on the open path — on a large
  // library they read or rewrote whole tables before the first request. Rule
  // 27 (2026-10-28): whole-library checks and repairs belong in background
  // maintenance. They now run from startDeferredMaintenance() once the runtime
  // is listening; MCP/CLI/library-migration processes never call it and keep
  // their opens repair-free.

  function removeAssetsFromSources(database, cleanProjectId, movesBySource) {
    const sources = [];
    const changes = [];
    for (const [sourceStackId, sourceAssetIds] of movesBySource) {
      const summaryBefore = stackSummary(database, cleanProjectId, sourceStackId);
      const previousCoverAssetId = summaryBefore?.cover_asset_id || "";
      const name = summaryBefore?.name || "";
      const memberIdsBefore = database.prepare(`
        SELECT sm.asset_id
        FROM asset_stack_members sm
        INNER JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
        WHERE sm.project_id = ? AND sm.stack_id = ? AND a.archived = 0 AND a.deleted_at IS NULL
        ORDER BY sm.position ASC, sm.asset_id ASC
      `).all(cleanProjectId, sourceStackId).map((row) => row.asset_id);
      const remove = database.prepare("DELETE FROM asset_stack_members WHERE project_id = ? AND stack_id = ? AND asset_id = ?");
      sourceAssetIds.forEach((assetId) => remove.run(cleanProjectId, sourceStackId, assetId));
      const compact = compactAssetStack(database, cleanProjectId, sourceStackId);
      addAutoStackExclusions(database, cleanProjectId, compact.dissolved
        ? [...sourceAssetIds, compact.remainingAssetId]
        : sourceAssetIds);
      sources.push({
        stackId: sourceStackId,
        name,
        memberIdsBefore,
        movedAssetIds: sourceAssetIds,
        dissolved: compact.dissolved,
        remainingAssetId: compact.remainingAssetId,
      });
      if (compact.dissolved) {
        changes.push({
          projectId: cleanProjectId,
          kind: "stack-dissolved",
          entityType: "stack",
          entityId: sourceStackId,
          assetIds: [...new Set([...sourceAssetIds, compact.remainingAssetId].filter(Boolean))],
        });
      } else {
        const coverAssetId = stackSummary(database, cleanProjectId, sourceStackId)?.cover_asset_id || "";
        changes.push({
          projectId: cleanProjectId,
          kind: coverAssetId && coverAssetId !== previousCoverAssetId ? "stack-cover-changed" : "stack-members-changed",
          entityType: "stack",
          entityId: sourceStackId,
          assetIds: [...new Set([...sourceAssetIds, previousCoverAssetId, coverAssetId].filter(Boolean))],
          detail: { coverAssetId, previousCoverAssetId },
        });
      }
    }
    return { sources, changes };
  }

  function executeMoveAssetsToStackInTransaction(database, cleanProjectId, ids, cleanTargetStackId, timestamp) {
    const unstack = !cleanTargetStackId;
    const targetStackBefore = !unstack ? stackSummary(database, cleanProjectId, cleanTargetStackId) : null;
    if (!unstack && !targetStackBefore) {
      throw assetStoreError("STACK_NOT_FOUND", `Stack not found: ${cleanTargetStackId}`);
    }
    const getAssetRow = database.prepare("SELECT id, archived FROM assets WHERE project_id = ? AND id = ?");
    const getMembership = database.prepare("SELECT stack_id FROM asset_stack_members WHERE project_id = ? AND asset_id = ?");
    const movesBySource = new Map();
    const movedAssetIds = [];
    const previouslyLooseAssetIds = [];
    for (const assetId of ids) {
      const row = getAssetRow.get(cleanProjectId, assetId);
      if (!row) throw assetNotFoundError(assetId);
      if (row.archived) throw assetStoreError("STACK_ASSET_ARCHIVED", `Archived asset cannot be stacked: ${assetId}`);
      const sourceStackId = getMembership.get(cleanProjectId, assetId)?.stack_id || "";
      if (sourceStackId === cleanTargetStackId) continue;
      movedAssetIds.push(assetId);
      if (!sourceStackId) {
        previouslyLooseAssetIds.push(assetId);
        continue;
      }
      if (!movesBySource.has(sourceStackId)) movesBySource.set(sourceStackId, []);
      movesBySource.get(sourceStackId).push(assetId);
    }
    const { sources, changes } = removeAssetsFromSources(database, cleanProjectId, movesBySource);
    if (!unstack && movedAssetIds.length) {
      const previousTargetCoverAssetId = targetStackBefore?.cover_asset_id || "";
      let nextPosition = Number(database.prepare(`
        SELECT COALESCE(MAX(position), -1) + 1 AS next_position
        FROM asset_stack_members WHERE project_id = ? AND stack_id = ?
      `).get(cleanProjectId, cleanTargetStackId).next_position);
      const insertMember = database.prepare(`
        INSERT INTO asset_stack_members (project_id, stack_id, asset_id, position, added_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      movedAssetIds.forEach((assetId) => {
        insertMember.run(cleanProjectId, cleanTargetStackId, assetId, nextPosition, timestamp);
        nextPosition += 1;
      });
      sortUnlockedAutoStack(database, cleanProjectId, cleanTargetStackId);
      database.prepare("UPDATE asset_stacks SET updated_at = ? WHERE project_id = ? AND id = ?")
        .run(timestamp, cleanProjectId, cleanTargetStackId);
      const coverAssetId = stackSummary(database, cleanProjectId, cleanTargetStackId)?.cover_asset_id || "";
      const coverChanged = Boolean(previousTargetCoverAssetId && coverAssetId && coverAssetId !== previousTargetCoverAssetId);
      changes.push({
        projectId: cleanProjectId,
        kind: coverChanged ? "stack-cover-changed" : "stack-members-changed",
        entityType: "stack",
        entityId: cleanTargetStackId,
        assetIds: coverChanged
          ? [...new Set([...movedAssetIds, previousTargetCoverAssetId, coverAssetId].filter(Boolean))]
          : movedAssetIds,
        detail: coverChanged
          ? { coverAssetId, previousCoverAssetId: previousTargetCoverAssetId }
          : { coverAssetId },
      });
    }
    if (changes.length) commitLibraryChanges(changes);
    return {
      target: unstack ? null : stackSummary(database, cleanProjectId, cleanTargetStackId),
      sources,
      movedAssetIds,
      previouslyLooseAssetIds,
    };
  }

  const store = {
    storageKind: "sqlite",
    projectRoot,
    managerDir,
    libraryDir,
    databasePath,
    assetsRoot,
    legacyAssetsRoot,
    generatedImagesDir,
    codexImagesDir,
    cowartCanvasDir,
    cowartPageAssetsDir,
    derivativesAvailable: true,
    async withAssetLifecycleLock(projectId, assetId, task) {
      const key = `${sanitizeProjectId(projectId || DEFAULT_PROJECT_ID)}\u0000${sanitizeId(assetId, "asset")}`;
      const previous = lifecycleQueues.get(key) || Promise.resolve();
      let releaseTurn;
      const turn = new Promise((resolveTurn) => { releaseTurn = resolveTurn; });
      const chained = previous.then(() => turn, () => turn);
      lifecycleQueues.set(key, chained);
      await previous.catch(() => {});
      try {
        return await task();
      } finally {
        releaseTurn();
        if (lifecycleQueues.get(key) === chained) lifecycleQueues.delete(key);
      }
    },
    async isAssetActive(projectId, assetId) {
      const row = database.prepare("SELECT deleted_at FROM assets WHERE project_id = ? AND id = ?")
        .get(sanitizeProjectId(projectId || DEFAULT_PROJECT_ID), sanitizeId(assetId, "asset"));
      return Boolean(row && !row.deleted_at);
    },
    projectId(value) {
      return sanitizeProjectId(value);
    },
    projectDir(projectId = DEFAULT_PROJECT_ID) {
      return join(assetsRoot, sanitizeProjectId(projectId));
    },
    imagesDir(projectId = DEFAULT_PROJECT_ID) {
      return join(this.projectDir(projectId), "original");
    },
    previewsDir(projectId = DEFAULT_PROJECT_ID) {
      return join(this.projectDir(projectId), "previews");
    },
    mediumsDir(projectId = DEFAULT_PROJECT_ID) {
      return join(this.projectDir(projectId), "mediums");
    },
    thumbnailsDir(projectId = DEFAULT_PROJECT_ID) {
      return join(this.projectDir(projectId), "thumbnails");
    },
    promptsDir(projectId = DEFAULT_PROJECT_ID) {
      return join(this.projectDir(projectId), "prompts");
    },
    metadataDir(projectId = DEFAULT_PROJECT_ID) {
      return join(this.projectDir(projectId), "metadata");
    },
    async libraryRevision() {
      // Collapse every derivative completion accumulated since the previous
      // revision read into one durable revision (500 ids per row). This keeps
      // hidden/resume and SSE reconnect recovery on the same journal protocol
      // without allowing thumbnail churn to consume one revision per asset.
      flushDerivativeChanges();
      // First segment: the journaled mutation counter (advances on every store
      // mutation; its integer prefix is the delta API's `since` cursor). Second
      // segment: PRAGMA data_version, which still detects writes made by other
      // connections that never went through this store instance.
      const counter = readLibraryRevisionCounter();
      const dataVersion = database.pragma("data_version", { simple: true });
      return `${counter}:${dataVersion}`;
    },
    async libraryChangeState(projectId = DEFAULT_PROJECT_ID) {
      flushDerivativeChanges();
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const bounds = database.prepare(`
        SELECT MIN(revision) AS oldest, MAX(revision) AS newest
        FROM library_changes WHERE project_id = ?
      `).get(cleanProjectId);
      return {
        revision: readLibraryRevisionCounter(),
        oldestRevision: bounds?.oldest == null ? null : Number(bounds.oldest),
      };
    },
    async listLibraryChangesSince(projectId, sinceRevision, { limit = 5000 } = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const since = Number(sinceRevision);
      const { revision, oldestRevision } = await this.libraryChangeState(cleanProjectId);
      // A caller with no baseline (or one from before this journal existed) can
      // start from the current revision; nothing needs to be replayed.
      if (!Number.isFinite(since) || since >= revision) {
        return { sinceRevision: Number.isFinite(since) ? since : null, currentRevision: revision, oldestRevision, complete: true, changes: [] };
      }
      // A project with no journal rows has no missing project-local history.
      // The revision counter is global, so writes in another project may move
      // `revision` forward while this project's bounds remain empty. Treat that
      // as an empty, complete delta and advance the caller baseline instead of
      // forcing an unnecessary full-gallery recovery.
      const complete = oldestRevision == null ? true : since >= (Number(oldestRevision) - 1);
      const rows = database.prepare(`
        SELECT revision, kind, entity_type, entity_id, flags_json, asset_ids_json, detail_json
        FROM library_changes INDEXED BY library_changes_project_revision_idx
        WHERE project_id = ? AND revision > ?
        ORDER BY revision, seq
        LIMIT ?
      `).all(cleanProjectId, since, Math.max(1, Math.min(Number(limit) || 5000, 20000)));
      const changes = rows.map((row) => ({
        revision: Number(row.revision),
        kind: row.kind,
        entityType: row.entity_type,
        entityId: row.entity_id || "",
        flags: parseJson(row.flags_json, []),
        assetIds: parseJson(row.asset_ids_json, []),
        detail: parseJson(row.detail_json, {}),
      }));
      // More rows than the limit means the caller must reconcile by other means;
      // reporting them truncated would silently drop the tail after advancing.
      const truncated = changes.length >= Math.max(1, Math.min(Number(limit) || 5000, 20000));
      return {
        sinceRevision: since,
        currentRevision: revision,
        oldestRevision,
        complete: complete && !truncated,
        changes,
      };
    },
    async ensureProject(projectId = DEFAULT_PROJECT_ID) {
      const cleanProjectId = sanitizeProjectId(projectId);
      await Promise.all([
        mkdir(this.imagesDir(cleanProjectId), { recursive: true }),
        mkdir(this.previewsDir(cleanProjectId), { recursive: true }),
        mkdir(this.mediumsDir(cleanProjectId), { recursive: true }),
        mkdir(this.thumbnailsDir(cleanProjectId), { recursive: true }),
      ]);
      database.prepare("INSERT OR IGNORE INTO projects (id, created_at) VALUES (?, ?)").run(cleanProjectId, now());
      return cleanProjectId;
    },
    async listProjects() {
      await this.ensureProject(DEFAULT_PROJECT_ID);
      return database.prepare("SELECT id FROM projects ORDER BY CASE id WHEN 'default' THEN 0 ELSE 1 END, id").all().map((row) => row.id);
    },
    async listAssets(filters = {}) {
      const result = await this.listAssetPage({ ...filters, limit: 0, collapseStacks: false });
      return result.assets;
    },
    async getAssetStack(projectId, stackId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanStackId = sanitizeId(stackId, "stack");
      const summary = stackSummary(database, cleanProjectId, cleanStackId);
      if (!summary) throw assetStoreError("STACK_NOT_FOUND", `Stack not found: ${cleanStackId}`);
      return summary;
    },
    async getAssetStackMemberships(projectId, assetIds) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      if (!Array.isArray(assetIds) || !assetIds.length) return {};
      const ids = assetIds.map((id) => sanitizeId(id, "asset"));
      const rows = database.prepare(`
        WITH requested_assets(asset_id) AS (
          SELECT CAST(value AS TEXT) FROM json_each(@assetIds)
        )
        SELECT sm.asset_id, sm.stack_id
        FROM asset_stack_members sm
        JOIN requested_assets requested ON requested.asset_id = sm.asset_id
        WHERE sm.project_id = @projectId
      `).all({ projectId: cleanProjectId, assetIds: JSON.stringify(ids) });
      const cache = new Map();
      const result = {};
      for (const row of rows) {
        let summary = cache.get(row.stack_id);
        if (summary === undefined) {
          summary = stackSummary(database, cleanProjectId, row.stack_id);
          cache.set(row.stack_id, summary);
        }
        if (summary) {
          result[row.asset_id] = summary;
        }
      }
      return result;
    },
    async listAssetStacks(projectId, options = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const rawLimit = Number(options?.limit);
      const effectiveLimit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
      const cleanQuery = typeof options?.query === "string" ? options.query.trim() : "";

      const params = {
        projectId: cleanProjectId,
        fetchLimit: effectiveLimit + 1,
      };
      let queryCondition = "";
      if (cleanQuery) {
        params.queryPattern = `%${escapeLikePattern(cleanQuery.toLowerCase())}%`;
        queryCondition = "AND LOWER(COALESCE(s.name, '')) LIKE @queryPattern ESCAPE '\\'";
      }

      const rows = database.prepare(`
        SELECT s.id
        FROM asset_stacks s
        JOIN asset_stack_members sm ON sm.project_id = s.project_id AND sm.stack_id = s.id
        JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
        WHERE s.project_id = @projectId AND a.deleted_at IS NULL AND a.archived = 0
          ${queryCondition}
        GROUP BY s.id, s.updated_at
        HAVING COUNT(a.id) >= 2
        ORDER BY s.updated_at DESC, s.id ASC
        LIMIT @fetchLimit
      `).all(params);

      const truncated = rows.length > effectiveLimit;
      const sliced = truncated ? rows.slice(0, effectiveLimit) : rows;
      const stacks = sliced.map((row) => stackSummary(database, cleanProjectId, row.id)).filter(Boolean);
      return { stacks, truncated };
    },
    async listAssetStackAssets(projectId, stackId, filters = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanStackId = sanitizeId(stackId, "stack");
      const stack = stackSummary(database, cleanProjectId, cleanStackId);
      if (!stack) throw assetStoreError("STACK_NOT_FOUND", `Stack not found: ${cleanStackId}`);
      const conditions = ["a.project_id = @projectId", "a.archived = 0", "a.deleted_at IS NULL", "sm.stack_id = @stackId"];
      const params = { projectId: cleanProjectId, stackId: cleanStackId };
      appendFilterConditions(conditions, params, filters);
      appendSearchConditions(conditions, params, filters.query, { alias: "a", prefix: "stack" });
      const requestedSort = normalizeStackSort(filters.sort);
      const limit = filters.limit == null ? 0 : normalizeLimit(filters.limit);
      const cursor = parseStackCursor(filters.cursor, cleanStackId, requestedSort, filters);
      const orderBy = requestedSort === "name"
        ? "a.sort_name ASC, a.id ASC"
        : requestedSort === "oldest"
          ? "a.created_at ASC, a.id ASC"
          : requestedSort === "newest"
            ? "a.created_at DESC, a.id DESC"
            : "sm.position ASC, a.id ASC";
      const includeTotal = filters.includeTotal !== false;
      const total = includeTotal
        ? Number(database.prepare(`
          SELECT COUNT(*) AS count
          FROM asset_stack_members sm
          JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
          WHERE ${conditions.join(" AND ")}
        `).get(params).count || 0)
        : null;
      const pageConditions = [...conditions];
      if (cursor) {
        params.cursorId = cursor.id;
        if (requestedSort === "name") {
          params.cursorSortName = cursor.sortName;
          pageConditions.push("(a.sort_name > @cursorSortName OR (a.sort_name = @cursorSortName AND a.id > @cursorId))");
        } else if (requestedSort === "oldest") {
          params.cursorCreatedAt = cursor.createdAt;
          pageConditions.push("(a.created_at > @cursorCreatedAt OR (a.created_at = @cursorCreatedAt AND a.id > @cursorId))");
        } else if (requestedSort === "newest") {
          params.cursorCreatedAt = cursor.createdAt;
          pageConditions.push("(a.created_at < @cursorCreatedAt OR (a.created_at = @cursorCreatedAt AND a.id < @cursorId))");
        } else {
          params.cursorPosition = cursor.position;
          pageConditions.push("(sm.position > @cursorPosition OR (sm.position = @cursorPosition AND a.id > @cursorId))");
        }
      }
      const sql = `
        SELECT ${PAGE_ASSET_COLUMNS}, sm.position AS stack_position
        FROM asset_stack_members sm
        JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
        WHERE ${pageConditions.join(" AND ")}
        ORDER BY ${orderBy}
      `;
      const rows = limit > 0
        ? database.prepare(`${sql} LIMIT @limit`).all({ ...params, limit: limit + 1 })
        : database.prepare(sql).all(params);
      const hasMore = limit > 0 && rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const last = pageRows.at(-1);
      const assets = attachAssetTags(database, cleanProjectId, pageRows.map((row) => ({
        ...rowToAsset(database, row, { includeRelations: false }),
        stack_position: Number(row.stack_position),
        // Same sort keys listGalleryRowsForAssets' stack branch produces, so
        // incremental rows and full stack pages compare identically.
        node_sort: {
          createdAt: String(row.created_at || ""),
          sortName: String(row.sort_name ?? ""),
          searchScore: null,
        },
      })));
      return {
        stack,
        assets,
        page: {
          total,
          nextCursor: hasMore && last ? encodeStackCursor(last, cleanStackId, requestedSort, filters) : null,
          limit: limit || total || pageRows.length,
          sort: requestedSort,
        },
      };
    },
    async createAssetStack(projectId, assetIds, options = {}) {
      const cleanProjectId = await this.ensureProject(projectId || DEFAULT_PROJECT_ID);
      const ids = [...new Set((Array.isArray(assetIds) ? assetIds : []).map((id) => sanitizeId(id, "asset")))];
      if (ids.length < 2) throw assetStoreError("STACK_NEEDS_MULTIPLE_ASSETS", "A stack requires at least two assets.");
      const coverAssetId = sanitizeId(options.coverAssetId || ids[0], "asset");
      if (!ids.includes(coverAssetId)) throw assetStoreError("STACK_COVER_NOT_MEMBER", "Stack cover must be one of its assets.");
      const stackId = `stack-${randomUUID()}`;
      const orderedIds = [coverAssetId, ...ids.filter((id) => id !== coverAssetId)];
      const timestamp = now();
      database.transaction(() => {
        const getAssetRow = database.prepare("SELECT id, archived, created_at, sort_name FROM assets WHERE project_id = ? AND id = ?");
        const getMembership = database.prepare("SELECT stack_id FROM asset_stack_members WHERE project_id = ? AND asset_id = ?");
        let coverRow = null;
        for (const assetId of orderedIds) {
          const row = getAssetRow.get(cleanProjectId, assetId);
          if (!row) throw assetNotFoundError(assetId);
          if (row.archived) throw assetStoreError("STACK_ASSET_ARCHIVED", `Archived asset cannot be stacked: ${assetId}`);
          const membership = getMembership.get(cleanProjectId, assetId);
          if (membership) throw assetStoreError("ASSET_ALREADY_STACKED", `Asset ${assetId} already belongs to stack ${membership.stack_id}.`);
          if (assetId === coverAssetId) coverRow = row;
        }
        database.prepare(`
          INSERT INTO asset_stacks (project_id, id, created_at, updated_at, sort_created_at, sort_name, order_locked)
          VALUES (?, ?, ?, ?, ?, ?, 1)
        `).run(
          cleanProjectId,
          stackId,
          timestamp,
          timestamp,
          String(coverRow?.created_at || timestamp),
          String(coverRow?.sort_name || ""),
        );
        const insertMember = database.prepare(`
          INSERT INTO asset_stack_members (project_id, stack_id, asset_id, position, added_at)
          VALUES (?, ?, ?, ?, ?)
        `);
        orderedIds.forEach((assetId, index) => insertMember.run(cleanProjectId, stackId, assetId, index, timestamp));
        commitLibraryChanges([{ projectId: cleanProjectId, kind: "stack-created", entityType: "stack", entityId: stackId, assetIds: orderedIds, detail: { coverAssetId: coverAssetId } }]);
      })();
      invalidateFtsPageCache();
      return stackSummary(database, cleanProjectId, stackId);
    },
    async addAssetsToStack(projectId, stackId, assetIds) {
      const cleanProjectId = await this.ensureProject(projectId || DEFAULT_PROJECT_ID);
      const cleanStackId = sanitizeId(stackId, "stack");
      const ids = [...new Set((Array.isArray(assetIds) ? assetIds : []).map((id) => sanitizeId(id, "asset")))];
      if (!ids.length) return this.getAssetStack(cleanProjectId, cleanStackId);
      const timestamp = now();
      database.transaction(() => {
        const existingStack = stackSummary(database, cleanProjectId, cleanStackId);
        if (!existingStack) throw assetStoreError("STACK_NOT_FOUND", `Stack not found: ${cleanStackId}`);
        const previousCoverAssetId = existingStack.cover_asset_id || "";
        const getAssetRow = database.prepare("SELECT id, archived FROM assets WHERE project_id = ? AND id = ?");
        const getMembership = database.prepare("SELECT stack_id FROM asset_stack_members WHERE project_id = ? AND asset_id = ?");
        let nextPosition = Number(database.prepare(`
          SELECT COALESCE(MAX(position), -1) + 1 AS next_position
          FROM asset_stack_members WHERE project_id = ? AND stack_id = ?
        `).get(cleanProjectId, cleanStackId).next_position);
        const insertMember = database.prepare(`
          INSERT INTO asset_stack_members (project_id, stack_id, asset_id, position, added_at)
          VALUES (?, ?, ?, ?, ?)
        `);
        const addedIds = [];
        for (const assetId of ids) {
          const row = getAssetRow.get(cleanProjectId, assetId);
          if (!row) throw assetNotFoundError(assetId);
          if (row.archived) throw assetStoreError("STACK_ASSET_ARCHIVED", `Archived asset cannot be stacked: ${assetId}`);
          const membership = getMembership.get(cleanProjectId, assetId);
          if (membership?.stack_id === cleanStackId) continue;
          if (membership) throw assetStoreError("ASSET_ALREADY_STACKED", `Asset ${assetId} already belongs to stack ${membership.stack_id}.`);
          insertMember.run(cleanProjectId, cleanStackId, assetId, nextPosition, timestamp);
          addedIds.push(assetId);
          nextPosition += 1;
        }
        if (addedIds.length) {
          sortUnlockedAutoStack(database, cleanProjectId, cleanStackId);
        }
        database.prepare("UPDATE asset_stacks SET updated_at = ? WHERE project_id = ? AND id = ?")
          .run(timestamp, cleanProjectId, cleanStackId);
        if (addedIds.length) {
          const coverAssetId = stackSummary(database, cleanProjectId, cleanStackId)?.cover_asset_id || "";
          const coverChanged = Boolean(previousCoverAssetId && coverAssetId && coverAssetId !== previousCoverAssetId);
          commitLibraryChanges([{
            projectId: cleanProjectId,
            kind: coverChanged ? "stack-cover-changed" : "stack-members-changed",
            entityType: "stack",
            entityId: cleanStackId,
            assetIds: coverChanged
              ? [...new Set([...addedIds, previousCoverAssetId, coverAssetId].filter(Boolean))]
              : addedIds,
            detail: coverChanged ? { coverAssetId, previousCoverAssetId } : { coverAssetId },
          }]);
        }
      })();
      invalidateFtsPageCache();
      return stackSummary(database, cleanProjectId, cleanStackId);
    },
    async assignAssetStackToGroup(projectId, stackId, groupName) {
      const cleanProjectId = await this.ensureProject(projectId || DEFAULT_PROJECT_ID);
      const cleanStackId = sanitizeId(stackId, "stack");
      if (!stackSummary(database, cleanProjectId, cleanStackId)) {
        throw assetStoreError("STACK_NOT_FOUND", `Stack not found: ${cleanStackId}`);
      }
      const memberIds = database.prepare(`
        SELECT asset_id
        FROM asset_stack_members
        WHERE project_id = ? AND stack_id = ?
        ORDER BY position, asset_id
      `).all(cleanProjectId, cleanStackId).map((row) => row.asset_id);
      if (!memberIds.length) {
        throw assetStoreError("STACK_NOT_FOUND", `Stack not found: ${cleanStackId}`);
      }
      // Navigation groups are the Stack's parent classification. Apply the
      // assignment to every retained member, including trashed/hidden rows, so
      // restoring a member cannot resurrect the Stack in an obsolete group.
      const assigned = await this.assignAssetsToGroup(cleanProjectId, memberIds, groupName);
      return {
        id: cleanStackId,
        group: String(assigned.results.find((entry) => entry?.ok !== false)?.group || ""),
        assetIds: memberIds,
        partial: Boolean(assigned.partial),
      };
    },
    async reorderAssetStack(projectId, stackId, assetIds) {
      const cleanProjectId = await this.ensureProject(projectId || DEFAULT_PROJECT_ID);
      const cleanStackId = sanitizeId(stackId, "stack");
      const ids = [...new Set((Array.isArray(assetIds) ? assetIds : []).map((id) => sanitizeId(id, "asset")))];
      database.transaction(() => {
        const current = database.prepare(`
          SELECT sm.asset_id, sm.position,
            CASE WHEN a.archived = 0 AND a.deleted_at IS NULL THEN 1 ELSE 0 END AS active
          FROM asset_stack_members sm
          LEFT JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
          WHERE sm.project_id = ? AND sm.stack_id = ?
          ORDER BY sm.position, sm.asset_id
        `).all(cleanProjectId, cleanStackId);
        if (!current.length) throw assetStoreError("STACK_NOT_FOUND", `Stack not found: ${cleanStackId}`);

        // Reorder has the same membership semantics as listAssetStackAssets():
        // only active members are visible/editable. Trashed members deliberately
        // retain their Stack membership so Restore can reconstruct the previous
        // organisation, therefore requiring those hidden ids in the UI payload
        // makes every reorder fail as soon as one member enters Trash.
        const activeRows = current.filter((row) => Number(row.active) === 1);
        const activeIds = activeRows.map((row) => row.asset_id);
        if (ids.length !== activeIds.length || activeIds.some((id) => !ids.includes(id))) {
          throw assetStoreError("STACK_ORDER_MISMATCH", "Stack order must contain every member exactly once.");
        }

        // Preserve hidden/trashed member slots. Active members are permuted only
        // across the positions currently occupied by active members, so restoring
        // a trashed asset later returns it to the same logical place in the Stack.
        const activePositions = activeRows.map((row) => Number(row.position));
        database.prepare(`
          UPDATE asset_stack_members SET position = position + 1000000
          WHERE project_id = ? AND stack_id = ?
            AND asset_id IN (
              SELECT id FROM assets
              WHERE project_id = ? AND archived = 0 AND deleted_at IS NULL
            )
        `).run(cleanProjectId, cleanStackId, cleanProjectId);
        const update = database.prepare(`
          UPDATE asset_stack_members SET position = ?
          WHERE project_id = ? AND stack_id = ? AND asset_id = ?
        `);
        ids.forEach((assetId, index) => update.run(activePositions[index], cleanProjectId, cleanStackId, assetId));
        database.prepare("UPDATE asset_stacks SET order_locked = 1 WHERE project_id = ? AND id = ?")
          .run(cleanProjectId, cleanStackId);
        // The chronological Stack anchor stays fixed, but name sorting should
        // follow the cover users currently see rather than a historical cover.
        syncAssetStackCoverSortName(database, cleanProjectId, cleanStackId);
        commitLibraryChanges([{ projectId: cleanProjectId, kind: "stack-order-changed", entityType: "stack", entityId: cleanStackId, assetIds: ids }]);
      })();
      invalidateFtsPageCache();
      return stackSummary(database, cleanProjectId, cleanStackId);
    },
    async removeAssetsFromStack(projectId, stackId, assetIds) {
      const cleanProjectId = await this.ensureProject(projectId || DEFAULT_PROJECT_ID);
      const cleanStackId = sanitizeId(stackId, "stack");
      const ids = [...new Set((Array.isArray(assetIds) ? assetIds : []).map((id) => sanitizeId(id, "asset")))];
      // The pre-mutation cover identifies the gallery node the client currently
      // renders for this Stack; after cover reassignment that row id disappears.
      const previousCoverAssetId = stackSummary(database, cleanProjectId, cleanStackId)?.cover_asset_id || "";
      const outcome = database.transaction(() => {
        if (!stackSummary(database, cleanProjectId, cleanStackId)) throw assetStoreError("STACK_NOT_FOUND", `Stack not found: ${cleanStackId}`);
        const remove = database.prepare("DELETE FROM asset_stack_members WHERE project_id = ? AND stack_id = ? AND asset_id = ?");
        ids.forEach((assetId) => remove.run(cleanProjectId, cleanStackId, assetId));
        const compact = compactAssetStack(database, cleanProjectId, cleanStackId);
        // Leaving any stack — manual or auto — is user intent, for every
        // removed asset and — when the removal auto-dissolves the stack — for
        // the survivor too. The tombstone records each asset's own session, so
        // the dissolved manual stack's members are never re-stacked either.
        addAutoStackExclusions(database, cleanProjectId, compact.dissolved
          ? [...ids, compact.remainingAssetId]
          : ids);
        if (compact.dissolved) {
          const affectedIds = [...new Set([...ids, compact.remainingAssetId].filter(Boolean))];
          commitLibraryChanges([{ projectId: cleanProjectId, kind: "stack-dissolved", entityType: "stack", entityId: cleanStackId, assetIds: affectedIds }]);
        } else if (ids.length) {
          const coverAssetId = stackSummary(database, cleanProjectId, cleanStackId)?.cover_asset_id || "";
          commitLibraryChanges([{
            projectId: cleanProjectId,
            kind: coverAssetId && coverAssetId !== previousCoverAssetId ? "stack-cover-changed" : "stack-members-changed",
            entityType: "stack",
            entityId: cleanStackId,
            assetIds: [...new Set([...ids, previousCoverAssetId, coverAssetId].filter(Boolean))],
            detail: { coverAssetId, previousCoverAssetId },
          }]);
        }
        return compact;
      })();
      invalidateFtsPageCache();
      return { ...outcome, stack: outcome.dissolved ? null : stackSummary(database, cleanProjectId, cleanStackId) };
    },
    // Atomic cut → paste: one transaction that pulls the selected assets out of
    // wherever they sit and appends them to the target stack in input order
    // (null/empty target un-stacks into loose assets). Sources settle with the
    // exact removeAssetsFromStack housekeeping, so every leaving asset is
    // tombstoned against auto-restacking even though it joins another stack.
    async moveAssetsToStack(projectId, assetIds, targetStackId) {
      const cleanProjectId = await this.ensureProject(projectId || DEFAULT_PROJECT_ID);
      const ids = [...new Set((Array.isArray(assetIds) ? assetIds : []).map((id) => sanitizeId(id, "asset")))];
      // Un-stack mode must be decided before sanitizeId: it never yields "".
      const unstack = targetStackId == null || String(targetStackId).trim() === "";
      const cleanTargetStackId = unstack ? "" : sanitizeId(targetStackId, "stack");
      const timestamp = now();
      const outcome = database.transaction(() =>
        executeMoveAssetsToStackInTransaction(database, cleanProjectId, ids, cleanTargetStackId, timestamp)
      )();
      invalidateFtsPageCache();
      return outcome;
    },
    async dropAssetsOnAsset(projectId, assetIds, targetAssetId) {
      const cleanProjectId = await this.ensureProject(projectId || DEFAULT_PROJECT_ID);
      const cleanTargetAssetId = sanitizeId(targetAssetId, "asset");
      const timestamp = now();
      const outcome = database.transaction(() => {
        const getAssetRow = database.prepare("SELECT id, archived, created_at, sort_name FROM assets WHERE project_id = ? AND id = ?");
        const targetRow = getAssetRow.get(cleanProjectId, cleanTargetAssetId);
        if (!targetRow) throw assetNotFoundError(cleanTargetAssetId);
        if (targetRow.archived) throw assetStoreError("STACK_ASSET_ARCHIVED", `Archived asset cannot be stacked: ${cleanTargetAssetId}`);

        const rawIds = Array.isArray(assetIds) ? assetIds : [];
        const cleanIds = [...new Set(rawIds.map((id) => sanitizeId(id, "asset")))].filter((id) => id && id !== cleanTargetAssetId);

        const getMembership = database.prepare("SELECT stack_id FROM asset_stack_members WHERE project_id = ? AND asset_id = ?");
        const targetMembership = getMembership.get(cleanProjectId, cleanTargetAssetId);
        const targetStackId = targetMembership?.stack_id || "";

        if (!cleanIds.length) {
          return {
            mode: "noop",
            stack: targetStackId ? stackSummary(database, cleanProjectId, targetStackId) : null,
            sources: [],
            movedAssetIds: [],
            previouslyLooseAssetIds: [],
          };
        }

        if (targetStackId) {
          const moveResult = executeMoveAssetsToStackInTransaction(database, cleanProjectId, cleanIds, targetStackId, timestamp);
          return {
            mode: moveResult.movedAssetIds.length ? "joined" : "noop",
            stack: moveResult.target,
            sources: moveResult.sources,
            movedAssetIds: moveResult.movedAssetIds,
            previouslyLooseAssetIds: moveResult.previouslyLooseAssetIds,
          };
        }

        const movesBySource = new Map();
        const previouslyLooseAssetIds = [];
        for (const assetId of cleanIds) {
          const row = getAssetRow.get(cleanProjectId, assetId);
          if (!row) throw assetNotFoundError(assetId);
          if (row.archived) throw assetStoreError("STACK_ASSET_ARCHIVED", `Archived asset cannot be stacked: ${assetId}`);
          const sourceStackId = getMembership.get(cleanProjectId, assetId)?.stack_id || "";
          if (!sourceStackId) {
            previouslyLooseAssetIds.push(assetId);
            continue;
          }
          if (!movesBySource.has(sourceStackId)) movesBySource.set(sourceStackId, []);
          movesBySource.get(sourceStackId).push(assetId);
        }

        const { sources, changes } = removeAssetsFromSources(database, cleanProjectId, movesBySource);

        const stackId = `stack-${randomUUID()}`;
        const orderedIds = [cleanTargetAssetId, ...cleanIds];
        database.prepare(`
          INSERT INTO asset_stacks (project_id, id, created_at, updated_at, sort_created_at, sort_name, order_locked)
          VALUES (?, ?, ?, ?, ?, ?, 1)
        `).run(
          cleanProjectId,
          stackId,
          timestamp,
          timestamp,
          String(targetRow.created_at || timestamp),
          String(targetRow.sort_name || ""),
        );
        const insertMember = database.prepare(`
          INSERT INTO asset_stack_members (project_id, stack_id, asset_id, position, added_at)
          VALUES (?, ?, ?, ?, ?)
        `);
        orderedIds.forEach((assetId, index) => insertMember.run(cleanProjectId, stackId, assetId, index, timestamp));
        changes.push({
          projectId: cleanProjectId,
          kind: "stack-created",
          entityType: "stack",
          entityId: stackId,
          assetIds: orderedIds,
          detail: { coverAssetId: cleanTargetAssetId },
        });
        if (changes.length) commitLibraryChanges(changes);
        return {
          mode: "created",
          stack: stackSummary(database, cleanProjectId, stackId),
          sources,
          movedAssetIds: cleanIds,
          previouslyLooseAssetIds,
        };
      })();
      invalidateFtsPageCache();
      return outcome;
    },
    async renameAssetStack(projectId, stackId, name) {
      const cleanProjectId = await this.ensureProject(projectId || DEFAULT_PROJECT_ID);
      const cleanStackId = sanitizeId(stackId, "stack");
      // Display names are user-facing text: trim whitespace, refuse an empty
      // final value, and cap length to the same budget the group rename input
      // enforces in the UI (maxlength=80).
      const cleanName = String(name ?? "").trim().slice(0, 80);
      if (!cleanName) throw assetStoreError("STACK_NAME_EMPTY", "Stack name cannot be empty.");
      // Computed here, not in SQL: SQLite evaluates every SET right-hand side
      // against the pre-update row, so an in-statement mosa_sort_name(name, …)
      // would read the OLD name.
      const cleanSortName = assetSortName({ theme: cleanName, asset: "", id: cleanStackId });
      const members = database.prepare(`
        SELECT asset_id FROM asset_stack_members
        WHERE project_id = ? AND stack_id = ? ORDER BY position, asset_id
      `).all(cleanProjectId, cleanStackId).map((row) => row.asset_id);
      database.transaction(() => {
        // name_locked freezes auto-stack naming: a session title learned from a
        // later ingest must never overwrite the user's chosen display name.
        const updated = database.prepare(`
          UPDATE asset_stacks
          SET name = ?, name_locked = 1, updated_at = ?, sort_name = ?
          WHERE project_id = ? AND id = ?
        `).run(cleanName, now(), cleanSortName, cleanProjectId, cleanStackId);
        if (!updated.changes) throw assetStoreError("STACK_NOT_FOUND", `Stack not found: ${cleanStackId}`);
        // Node rows re-fetch through the existing incremental path; passing the
        // member ids lets every open window re-render the renamed Stack node.
        commitLibraryChanges([{ projectId: cleanProjectId, kind: "stack-updated", entityType: "stack", entityId: cleanStackId, assetIds: members }]);
      })();
      invalidateFtsPageCache();
      return stackSummary(database, cleanProjectId, cleanStackId);
    },
    // Names the session's target stack from a conversation title reported by
    // the capture plugin (old conversations reopened long after capture). The
    // naming rule is exactly the ingest-time one; a no-op is a normal result,
    // never an error.
    async applySessionTitle(projectId, sessionKey, title) {
      const cleanProjectId = await this.ensureProject(projectId || DEFAULT_PROJECT_ID);
      const cleanSessionKey = String(sessionKey || "").trim();
      // Same cap as generationSessionTitle, so both naming entries produce
      // identical stack names for the same source title.
      const cleanTitle = String(title || "").trim().slice(0, GENERATION_SESSION_TITLE_MAX_LENGTH);
      if (!cleanSessionKey || !cleanTitle) return { stackId: "", renamed: false };
      const outcome = database.transaction(() => {
        const target = targetStackForSession(database, cleanProjectId, cleanSessionKey);
        if (!target) return { stackId: "", renamed: false };
        if (!sessionTitleMayNameStack(database, cleanProjectId, target, cleanSessionKey, cleanTitle)) {
          return { stackId: target.id, renamed: false };
        }
        const members = database.prepare(`
          SELECT asset_id FROM asset_stack_members
          WHERE project_id = ? AND stack_id = ? ORDER BY position, asset_id
        `).all(cleanProjectId, target.id).map((row) => row.asset_id);
        // Computed here, not in SQL, for the same pre-update-row reason as
        // renameAssetStack above.
        database.prepare("UPDATE asset_stacks SET name = ?, sort_name = ?, updated_at = ? WHERE project_id = ? AND id = ?")
          .run(cleanTitle, assetSortName({ theme: cleanTitle, asset: "", id: target.id }), now(), cleanProjectId, target.id);
        commitLibraryChanges([{ projectId: cleanProjectId, kind: "stack-updated", entityType: "stack", entityId: target.id, assetIds: members }]);
        return { stackId: target.id, renamed: true };
      }).immediate();
      if (outcome.renamed) invalidateFtsPageCache();
      return outcome;
    },
    async dissolveAssetStack(projectId, stackId) {
      const cleanProjectId = await this.ensureProject(projectId || DEFAULT_PROJECT_ID);
      const cleanStackId = sanitizeId(stackId, "stack");
      const members = database.prepare(`
        SELECT asset_id FROM asset_stack_members
        WHERE project_id = ? AND stack_id = ? ORDER BY position, asset_id
      `).all(cleanProjectId, cleanStackId).map((row) => row.asset_id);
      database.transaction(() => {
        const deleted = database.prepare("DELETE FROM asset_stacks WHERE project_id = ? AND id = ?").run(cleanProjectId, cleanStackId);
        if (!deleted.changes) throw assetStoreError("STACK_NOT_FOUND", `Stack not found: ${cleanStackId}`);
        // Dissolving any stack is user intent for every member: each member is
        // excluded under its own session key so future ingests cannot rebuild
        // the group — manual stacks included.
        addAutoStackExclusions(database, cleanProjectId, members);
        commitLibraryChanges([{ projectId: cleanProjectId, kind: "stack-dissolved", entityType: "stack", entityId: cleanStackId, assetIds: members }]);
      })();
      invalidateFtsPageCache();
      return { id: cleanStackId, assetIds: members, dissolved: true };
    },
    async listAssetPage(filters = {}) {
      const projectId = sanitizeProjectId(filters.projectId || DEFAULT_PROJECT_ID);
      const limit = normalizeLimit(filters.limit);
      const sort = normalizeAssetSort(filters.sort);
      const searchQuery = resolveAssetSearchQuery(database, projectId, filters.query);
      const cursor = parseCursor(filters.cursor, sort, searchQuery, assetTimeFilterKey(filters));
      // The raw asset collection is the default API contract. Only the gallery
      // opts into collapsed logical nodes. Keeping these semantics separate
      // prevents exports/batch operations from silently losing Stack members.
      if (filters.collapseStacks && !filters.archived && !filters.trash
        && database.prepare("SELECT 1 FROM asset_stacks WHERE project_id = ? LIMIT 1").get(projectId)) {
        return listCollapsedAssetPage(database, { filters, projectId, limit, sort, searchQuery, cursor });
      }
      const baseConditions = [
        "a.project_id = @projectId",
        filters.trash ? "a.deleted_at IS NOT NULL" : "a.deleted_at IS NULL",
      ];
      if (!filters.trash) baseConditions.push(filters.archived ? "a.archived = 1" : "a.archived = 0");
      // Incremental reconciliation: restrict the whole query (page and count) to
      // a caller-provided asset id set so one small request can re-evaluate
      // exactly the affected rows under the full request semantics.
      const reconcileAssetIds = Array.isArray(filters.assetIds) && filters.assetIds.length
        ? [...new Set(filters.assetIds.map((assetId) => sanitizeId(assetId, "asset")))]
        : null;
      if (reconcileAssetIds) baseConditions.push("a.id IN (SELECT CAST(value AS TEXT) FROM json_each(@reconcileAssetIds))");
      const params = { projectId };
      if (reconcileAssetIds) params.reconcileAssetIds = JSON.stringify(reconcileAssetIds);
      appendFilterConditions(baseConditions, params, filters);
      const pageConditions = [...baseConditions];
      if (cursor && !searchQuery) {
        if (sort === "name") {
          pageConditions.push("(a.sort_name > @cursorSortName OR (a.sort_name = @cursorSortName AND a.id > @cursorId))");
          params.cursorSortName = cursor.sortName;
        } else {
          const comparison = sort === "oldest" ? ">" : "<";
          pageConditions.push(`(a.created_at ${comparison} @cursorCreatedAt OR (a.created_at = @cursorCreatedAt AND a.id ${comparison} @cursorId))`);
          params.cursorCreatedAt = cursor.createdAt;
        }
        params.cursorId = cursor.id;
      }
      let pageFrom = "assets a";
      let countFrom = "assets a";
      let totalConditions = [...baseConditions];
      const searchTerms = searchQuery ? searchQuery.split(/\s+/u).filter(Boolean) : [];
      const searchKind = searchTerms.length ? assetSearchKind(searchQuery) : "";
      const indexedShortUnicodeTerms = searchTerms.filter(isIndexedShortUnicodeTerm);
      // Whole-string exact match: pasting a full id or file name from the
      // Inspector must find that one asset even though machine-generated name
      // segments no longer enter search_text/FTS. Only a single term shaped
      // like an id / file name can be such a string (both stores sanitize
      // spaces out of both values), and kind-intent searches keep their
      // FTS-join page shape, so the OR-ed fallback below only exists on the
      // other paths.
      const exactMatchTerm = searchTerms.length === 1 && !searchKind
        && /^[a-z0-9][a-z0-9._-]*$/i.test(searchTerms[0])
        ? searchQuery
        : "";
      const exactMatchCondition = exactMatchTerm
        ? "mosa_asset_exact_match(a.id, a.asset, @exactMatchTerm) = 1"
        : "";
      if (exactMatchTerm) params.exactMatchTerm = exactMatchTerm;
      indexedShortUnicodeTerms.forEach((term, index) => {
        const key = `shortUnicodeTerm${index}`;
        params[key] = term;
        // Drive the page from the requested sort index and probe the short-term
        // primary key per candidate asset. Using IN here makes SQLite build the
        // entire matching asset-id set first (50k rows for a common term) before
        // LIMIT can stop the page scan, which defeats the purpose of the short
        // term index for broad CJK queries. The doc mapping turns the asset id
        // into its stable integer doc id (task 348).
        const condition = `EXISTS (
          SELECT 1 FROM asset_search_terms short_term
          JOIN asset_search_docs short_doc ON short_doc.doc_id = short_term.doc_id
          WHERE short_term.term = @${key}
            AND short_doc.project_id = a.project_id
            AND short_doc.asset_id = a.id
        )`;
        pageConditions.push(condition);
        totalConditions.push(condition);
      });
      // Query planning may translate or normalize the user input before this
      // point. Every downstream search path must consume the same effective
      // query; mixing raw input here would accidentally AND the rewritten CJK
      // predicates with stale English FTS terms.
      const indexedLikeTerms = !searchKind ? plainAsciiSearchTerms(searchQuery) : [];
      const usesIndexedLike = indexedLikeTerms.length > 0;
      const indexedFtsTerms = usesIndexedLike ? indexedLikeTerms.filter((term) => [...term].length >= 3) : [];
      const indexedShortTerms = usesIndexedLike ? indexedLikeTerms.filter((term) => [...term].length < 3) : [];
      if (indexedFtsTerms.length) params.indexedFtsQuery = buildFtsQuery(indexedFtsTerms.join(" "));
      // FTS5's trigram tokenizer can index substring terms of three or more
      // Unicode characters. Use it to drive the candidate set whenever possible;
      // one/two-character terms remain LIKE predicates on that already narrowed
      // set (or on the project index when every term is short).
      const ftsTerms = usesIndexedLike ? [] : searchTerms.filter((term) => [...term].length >= 3);
      const likeTerms = searchTerms.filter((term) => [...term].length < 3);
      const usesFts = ftsTerms.length > 0;
      const searchScoreSql = searchKind ? buildSearchScoreSql(searchTerms, params) : "1";
      if (usesFts) {
        params.ftsQuery = buildFtsQuery(ftsTerms.join(" "));
        const ftsMembership = "a.id IN (SELECT asset_id FROM asset_fts WHERE project_id = @projectId AND content MATCH @ftsQuery)";
        if (searchKind) {
          // Type-intent searches need global relevance ranking, so FTS drives the
          // candidate rows and the exact scorer ranks only those matches.
          pageFrom = "asset_fts JOIN assets a ON a.project_id = asset_fts.project_id AND a.id = asset_fts.asset_id";
          pageConditions.push("asset_fts.project_id = @projectId", "asset_fts.content MATCH @ftsQuery");
        } else {
          // Generic content searches already have exact AND membership from FTS.
          // Let the requested sort index drive the page so LIMIT can stop after
          // 101 matching assets instead of ranking/sorting every FTS hit.
          pageFrom = `assets a INDEXED BY ${sort === "name" ? "assets_project_name_idx" : "assets_project_created_idx"}`;
          pageConditions.push(exactMatchCondition ? `(${ftsMembership} OR ${exactMatchCondition})` : ftsMembership);
        }
        if (!searchKind && exactMatchCondition) {
          // An exact-only hit has no asset_fts row, so the count must run from
          // the assets table with the FTS membership as one OR arm.
          countFrom = "assets a";
          totalConditions.push(`(${ftsMembership} OR ${exactMatchCondition})`);
        } else {
          countFrom = "asset_fts JOIN assets a ON a.project_id = asset_fts.project_id AND a.id = asset_fts.asset_id";
          totalConditions.push("asset_fts.project_id = @projectId");
          totalConditions.push("asset_fts.content MATCH @ftsQuery");
        }
      } else if (indexedFtsTerms.length) {
        const indexedFtsMembership = "a.id IN (SELECT asset_id FROM asset_fts WHERE project_id = @projectId AND content MATCH @indexedFtsQuery)";
        pageFrom = `assets a INDEXED BY ${sort === "name" ? "assets_project_name_idx" : "assets_project_created_idx"}`;
        pageConditions.push(exactMatchCondition ? `(${indexedFtsMembership} OR ${exactMatchCondition})` : indexedFtsMembership);
        if (exactMatchCondition) {
          countFrom = "assets a";
          totalConditions.push(`(${indexedFtsMembership} OR ${exactMatchCondition})`);
        } else {
          countFrom = "asset_fts JOIN assets a ON a.project_id = asset_fts.project_id AND a.id = asset_fts.asset_id";
          totalConditions.push("asset_fts.project_id = @projectId", "asset_fts.content MATCH @indexedFtsQuery");
        }
      } else if (searchTerms.length) {
        pageFrom = `assets a INDEXED BY ${sort === "name" ? "assets_project_name_idx" : "assets_project_created_idx"}`;
      }
      if (searchTerms.length) {
        const fallbackTerms = (usesIndexedLike ? indexedShortTerms : (usesFts ? likeTerms : searchTerms))
          .filter((term) => !indexedShortUnicodeTerms.includes(term));
        const likeConditions = [];
        fallbackTerms.forEach((term, index) => {
          const key = `likeTerm${index}`;
          // Task 348: the LIKE runs over the FTS content table's copy of the
          // search text (narrow rows: id + project + asset + text) instead of
          // the wide assets rows. Same LOWER() + escape semantics as before;
          // the FTS-content copy exists exactly for live (non-trash) assets,
          // which is also the only place these short ASCII terms previously
          // had an index-driven path.
          likeConditions.push(`a.id IN (
            SELECT short_content.c1 FROM asset_fts_content short_content
            WHERE short_content.c0 = @projectId
              AND LOWER(short_content.c2) LIKE @${key} ESCAPE '\\'
          )`);
          params[key] = `%${escapeLikePattern(term)}%`;
        });
        if (exactMatchCondition) {
          // The exact whole string must not be AND-ed away by the per-term LIKE
          // filters. With no LIKE terms the FTS membership above is already
          // OR-ed with the exact match — pushing the exact arm again as a
          // standalone AND here would drop every non-exact row.
          if (likeConditions.length) {
            const condition = `(${likeConditions.join(" AND ")} OR ${exactMatchCondition})`;
            pageConditions.push(condition);
            totalConditions.push(condition);
          }
        } else {
          pageConditions.push(...likeConditions);
          totalConditions.push(...likeConditions);
        }
      }
      if (searchKind) {
        params.searchKind = searchKind;
        const kindCondition = `mosa_asset_matches_search_kind(
          @searchKind, a.asset, a.id, a.prompt, a.skill, a.style, a.theme, a.group_name, a.category, a.tags_text
        ) = 1`;
        pageConditions.push(kindCondition);
        totalConditions.push(kindCondition);
      }
      const cacheKey = (usesFts || indexedFtsTerms.length) && limit > 0 ? JSON.stringify([
        projectId, limit, filters.cursor || null, Boolean(filters.archived), Boolean(filters.trash), filters.query,
        filters.source || null, filters.group || null, filters.category || null, filters.style || null,
        filters.conversation || null, filters.generationBatch || null, filters.mediaKind || null,
        Boolean(filters.favorite), Boolean(filters.recent), Boolean(filters.unorganized), filters.recentSince ?? null,
        filters.createdAfterMs ?? null, filters.createdBeforeMs ?? null, sort,
      ]) : null;
      const dataVersion = cacheKey ? database.pragma("data_version", { simple: true }) : null;
      const cached = cacheKey ? ftsPageCache.get(cacheKey) : null;
      if (cached && cached.localAssetRevision === localAssetRevision && cached.dataVersion === dataVersion) {
        return structuredClone(cached.result);
      }
      const orderBy = (alias = "a") => sort === "name"
        ? `${alias}.sort_name ASC, ${alias}.id ASC`
        : (sort === "oldest" ? `${alias}.created_at ASC, ${alias}.id ASC` : `${alias}.created_at DESC, ${alias}.id DESC`);
      let searchCursorCondition = "";
      if (cursor && searchTerms.length) {
        params.cursorId = cursor.id;
        params.cursorCreatedAt = cursor.createdAt;
        params.cursorSortName = cursor.sortName;
        const secondaryAfter = sort === "name"
          ? "(sort_name > @cursorSortName OR (sort_name = @cursorSortName AND id > @cursorId))"
          : (sort === "oldest"
            ? "(created_at > @cursorCreatedAt OR (created_at = @cursorCreatedAt AND id > @cursorId))"
            : "(created_at < @cursorCreatedAt OR (created_at = @cursorCreatedAt AND id < @cursorId))");
        if (searchKind) {
          params.cursorSearchScore = cursor.searchScore;
          const rankedSecondary = secondaryAfter.replaceAll("sort_name", "r.sort_name").replaceAll("created_at", "r.created_at").replaceAll(" id", " r.id");
          searchCursorCondition = ` AND (r._search_score < @cursorSearchScore OR (r._search_score = @cursorSearchScore AND ${rankedSecondary}))`;
        } else {
          const pageSecondary = secondaryAfter.replaceAll("sort_name", "a.sort_name").replaceAll("created_at", "a.created_at").replaceAll(" id", " a.id");
          pageConditions.push(pageSecondary);
        }
      }
      // MATERIALIZED keeps the native relevance expression single-evaluation
      // even though the outer query references it in WHERE, ORDER BY and cursor
      // predicates.
      const select = searchKind
        ? `WITH ranked AS MATERIALIZED (
            SELECT ${PAGE_ASSET_COLUMNS}, (${searchScoreSql}) AS _search_score
            FROM ${pageFrom}
            WHERE ${pageConditions.join(" AND ")}
          )
          SELECT r.* FROM ranked r
          WHERE r._search_score > 0${searchCursorCondition}
          ORDER BY r._search_score DESC, ${orderBy("r")}`
        : `SELECT ${PAGE_ASSET_COLUMNS}, ${searchTerms.length ? 1 : 0} AS _search_score FROM ${pageFrom} WHERE ${pageConditions.join(" AND ")} ORDER BY ${orderBy("a")}`;
      // Keep the page query free of window aggregates. COUNT(*) OVER() makes SQLite materialise
      // every FTS match before it can apply LIMIT, which turns a 100-row gallery page into a
      // 50k-row sort. The separate count preserves the API's exact total while allowing the page
      // query to stop as soon as it has the next cursor row.
      const rows = limit > 0
        ? database.prepare(`${select} LIMIT @limit`).all({ ...params, limit: limit + 1 })
        : database.prepare(select).all(params);
      const hasMore = limit > 0 && rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const pageAssets = pageRows.map((row) => rowToAsset(database, row, { includeRelations: false }));
      const assets = attachAssetTags(
        database,
        projectId,
        // Cover annotations power the raw asset list's data-oriented callers;
        // a caller suppressing them (gallery search flattening) gets plain rows
        // so a matching cover never renders as a stack node.
        filters.stackCoverAnnotations !== false
          ? annotateAssetStackCovers(database, pageAssets, projectId)
          : pageAssets,
      );
      // Expose the exact ORDER BY tuple per row so the client can reproduce the
      // server's sort order incrementally without re-listing the whole query.
      annotateGalleryNodeSort(assets, pageRows, { collapsed: false, ranked: Boolean(searchKind) });
      const last = pageRows.at(-1);
      const canCountFtsDirectly = usesFts
        && !searchKind
        && likeTerms.length === 0
        && !exactMatchTerm
        && !filters.archived
        && !filters.trash
        && baseConditions.length === 3;
      // FTS5's trigram tokenizer only indexes terms of three or more characters,
      // so a direct MATCH count is only equivalent to the LIKE page query when
      // every term is indexable; otherwise the count would report zero while the
      // page still matches rows ("ab hello" style queries).
      const allIndexedLikeTermsIndexable = indexedLikeTerms.every((term) => [...term].length >= 3);
      const canCountIndexedFtsDirectly = usesIndexedLike
        && allIndexedLikeTermsIndexable
        && !exactMatchTerm
        && !filters.archived
        && !filters.trash
        && baseConditions.length === 3;
      const canUseDirectFtsCount = canCountFtsDirectly || canCountIndexedFtsDirectly;
      const canCountShortUnicodeDirectly = indexedShortUnicodeTerms.length > 0
        && indexedShortUnicodeTerms.length === searchTerms.length
        && !searchKind
        && !exactMatchTerm
        && !filters.archived
        && !filters.trash
        && baseConditions.length === 3;
      const hasArchivedAssets = canUseDirectFtsCount && database.prepare(`
        SELECT 1 FROM assets INDEXED BY assets_project_created_idx
        WHERE project_id = @projectId AND archived = 1 AND deleted_at IS NULL LIMIT 1
      `).get(params);
      const includeTotal = filters.includeTotal !== false;
      const directShortUnicodeTotal = includeTotal && canCountShortUnicodeDirectly
        ? database.prepare(`
          SELECT COUNT(*) AS count
          FROM asset_search_docs d
          JOIN assets a ON a.project_id = d.project_id AND a.id = d.asset_id
          WHERE d.project_id = @projectId
            AND a.deleted_at IS NULL
            AND a.archived = 0
            AND EXISTS (SELECT 1 FROM asset_search_terms st0 WHERE st0.doc_id = d.doc_id AND st0.term = @shortUnicodeTerm0)
            ${indexedShortUnicodeTerms.slice(1).map((_, index) => `AND EXISTS (
              SELECT 1 FROM asset_search_terms st${index + 1}
              WHERE st${index + 1}.doc_id = d.doc_id
                AND st${index + 1}.term = @shortUnicodeTerm${index + 1}
            )`).join("\n")}
        `).get(params).count
        : null;
      const total = includeTotal
        ? (directShortUnicodeTotal != null
          ? directShortUnicodeTotal
          : canUseDirectFtsCount && !hasArchivedAssets
          ? database.prepare("SELECT COUNT(*) AS count FROM asset_fts WHERE project_id = @projectId AND content MATCH @countFtsQuery").get({
            ...params,
            countFtsQuery: canCountFtsDirectly ? params.ftsQuery : params.indexedFtsQuery,
          }).count
          : database.prepare(`SELECT COUNT(*) AS count FROM ${countFrom} WHERE ${totalConditions.join(" AND ")}`).get(params).count)
        : null;
      const result = {
        assets,
        page: {
          total,
          nextCursor: hasMore && last ? encodeCursor(last, sort, searchQuery, assetTimeFilterKey(filters)) : null,
          limit: limit || total || pageRows.length,
          sort,
        },
      };
      if (cacheKey) {
        if (ftsPageCache.size >= 64) ftsPageCache.clear();
        ftsPageCache.set(cacheKey, { localAssetRevision, dataVersion, result: structuredClone(result) });
      }
      return result;
    },
    /**
     * Incremental reconciliation primitive: for a set of affected asset ids and
     * the *current gallery request*, return exactly the view rows those ids map
     * to under the request's filter/sort/collapse semantics, plus the asset→row
     * mapping. Rows missing from the response no longer match the request, so
     * the client can decide insert/update/remove per row with server semantics
     * instead of re-listing the whole query. Bounded by the affected id count,
     * never by the library size.
     */
    async listGalleryRowsForAssets(filters = {}, assetIds = []) {
      const projectId = sanitizeProjectId(filters.projectId || DEFAULT_PROJECT_ID);
      const cleanIds = [...new Set((Array.isArray(assetIds) ? assetIds : []).map((id) => sanitizeId(id, "asset")))];
      // 320 补充 2：纯堆叠编号的批次（封面替换，无受影响素材 id）也要照常查——
      // requestedStackIds 的可达性自己就能圈定节点行。
      const requestedStackIds = Array.isArray(filters.requestedStackIds)
        ? [...new Set(filters.requestedStackIds.map((stackId) => sanitizeId(stackId, "stack")))]
        : [];
      if (!cleanIds.length && !requestedStackIds.length) {
        return { rows: [], rowByAssetId: {}, afterCursorRowIds: [], total: null, stack: null };
      }
      const sort = normalizeAssetSort(filters.sort);
      const searchQuery = normalizeAssetSearchQuery(filters.query);

      if (filters.stackId) {
        const cleanStackId = sanitizeId(filters.stackId, "stack");
        const stack = stackSummary(database, projectId, cleanStackId);
        if (!stack) return { rows: [], rowByAssetId: {}, afterCursorRowIds: [], total: 0, stack: null };
        const conditions = [
          "a.project_id = @projectId",
          "a.archived = 0",
          "a.deleted_at IS NULL",
          "sm.stack_id = @stackId",
          "a.id IN (SELECT CAST(value AS TEXT) FROM json_each(@reconcileAssetIds))",
        ];
        const params = { projectId, stackId: cleanStackId, reconcileAssetIds: JSON.stringify(cleanIds) };
        appendFilterConditions(conditions, params, filters);
        appendSearchConditions(conditions, params, searchQuery, { alias: "a", prefix: "stack" });
        const requestedSort = normalizeStackSort(filters.sort);
        const boundaryCursor = filters.boundaryCursor
          ? parseStackCursor(filters.boundaryCursor, cleanStackId, requestedSort, filters)
          : null;
        const orderBy = requestedSort === "name"
          ? "a.sort_name ASC, a.id ASC"
          : requestedSort === "oldest"
            ? "a.created_at ASC, a.id ASC"
            : requestedSort === "newest"
              ? "a.created_at DESC, a.id DESC"
              : "sm.position ASC, a.id ASC";
        const rows = database.prepare(`
          SELECT sm.position AS stack_position, a.*
          FROM asset_stack_members sm
          JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
          WHERE ${conditions.join(" AND ")}
          ORDER BY ${orderBy}
        `).all(params);
        const assets = attachAssetTags(database, projectId, rows.map((row) => {
          const asset = rowToAsset(database, row, { includeRelations: false });
          asset.stack_position = Number(row.stack_position);
          // The real assets.sort_name column, not a rowToAsset fallback: the
          // stack page orders by `a.sort_name`, so the client-side comparator
          // must weigh the same value (theme alone would disagree with SQL).
          asset.node_sort = {
            createdAt: String(row.created_at || ""),
            sortName: String(row.sort_name ?? ""),
            searchScore: null,
          };
          return asset;
        }));
        // Identity mapping is unconditional: an affected id whose row is absent
        // no longer matches the request, which is exactly what the client needs
        // to decide a card removal.
        const rowByAssetId = {};
        for (const assetId of cleanIds) rowByAssetId[assetId] = assetId;
        const afterCursorRowIds = boundaryCursor
          ? assets.filter((asset) => isStackRowAfterCursor(asset, boundaryCursor, requestedSort)).map((asset) => asset.id)
          : [];
        // `total` must match GET /api/asset-stacks/:id/assets page.total: the
        // count comes from the same list function (limit 1 keeps the probe
        // cheap; includeTotal makes it run the same COUNT). `stack` is the
        // same summary the stack endpoints return, so a live view can tell a
        // dissolved stack from a merely empty one.
        let total = 0;
        try {
          const probe = await this.listAssetStackAssets(projectId, cleanStackId, { ...filters, limit: 1, includeTotal: true });
          total = probe.page.total ?? 0;
        } catch (error) {
          if (error?.code !== "STACK_NOT_FOUND") throw error;
        }
        return { rows: assets, rowByAssetId, afterCursorRowIds, total, stack };
      }

      const useCollapse = Boolean(filters.collapseStacks) && !filters.archived && !filters.trash
        && database.prepare("SELECT 1 FROM asset_stacks WHERE project_id = ? LIMIT 1").get(projectId);
      if (useCollapse) {
        const reconcileFilters = { ...filters, assetIds: cleanIds, includeTotal: false };
        const page = listCollapsedAssetPage(database, {
          filters: reconcileFilters,
          projectId,
          limit: 0,
          sort,
          searchQuery,
          cursor: null,
        });
        const { matchedCte, params: matchedParams } = buildCollapsedMatchedCte({
          filters: reconcileFilters,
          projectId,
          searchQuery,
        });
        const rowByAssetId = {};
        // 320 补充 2：空批次（assetIds 空、仅堆叠编号）没有 requested id，
        // asset→node 映射恒空；SQL 里的 @reconcileAssetIds 也无从绑定。
        if (cleanIds.length) {
          const results = database.prepare(`
            WITH ${matchedCte},
            requested(asset_id) AS (SELECT CAST(value AS TEXT) FROM json_each(@reconcileAssetIds)),
            member_nodes AS (
              SELECT sm.asset_id, matched.node_asset_id
              FROM asset_stack_members sm
              JOIN requested r ON r.asset_id = sm.asset_id
              LEFT JOIN matched ON matched.stack_id = sm.stack_id
              WHERE sm.project_id = @projectId
            )
            SELECT r.asset_id AS asset_id, COALESCE(n.node_asset_id, r.asset_id) AS node_asset_id
            FROM requested r
            LEFT JOIN member_nodes n ON n.asset_id = r.asset_id
          `).all(matchedParams);
          for (const row of results) rowByAssetId[row.asset_id] = row.node_asset_id;
        }
        const boundaryCursor = filters.boundaryCursor ? parseCursor(filters.boundaryCursor, sort, searchQuery, assetTimeFilterKey(filters)) : null;
        const afterCursorRowIds = boundaryCursor
          ? page.assets.filter((asset) => isGalleryRowAfterCursor(asset, boundaryCursor, sort, searchQuery)).map((asset) => asset.id)
          : [];
        // Same contract as the stack branch: the probe routes through
        // listAssetPage (collapsed branch included), so the count is the same
        // one GET /api/assets reports for the identical request. The probe
        // must drop the reconciliation scopes — requestedStackIds exist to
        // deliver current node rows to the client, never to widen the count.
        const totalProbe = await this.listAssetPage({ ...filters, assetIds: undefined, requestedStackIds: undefined, limit: 1, includeTotal: true });
        return { rows: page.assets, rowByAssetId, afterCursorRowIds, total: totalProbe.page.total ?? 0, stack: null };
      }

      const totalProbe = await this.listAssetPage({ ...filters, assetIds: undefined, requestedStackIds: undefined, limit: 1, includeTotal: true });
      // 320 返工 1 (B)：cleanIds 为空时平铺分支直接返回空，平铺视图没有堆叠卡。
      if (!cleanIds.length) {
        return { rows: [], rowByAssetId: {}, afterCursorRowIds: [], total: totalProbe.page.total ?? 0, stack: null };
      }
      const page = await this.listAssetPage({ ...filters, assetIds: cleanIds, limit: 0, includeTotal: false });
      // Unconditional identity mapping (see the stack branch above): absence of
      // the row is the signal that the asset no longer matches the request.
      const rowByAssetId = {};
      for (const assetId of cleanIds) rowByAssetId[assetId] = assetId;
      const boundaryCursor = filters.boundaryCursor ? parseCursor(filters.boundaryCursor, sort, searchQuery, assetTimeFilterKey(filters)) : null;
      const afterCursorRowIds = boundaryCursor
        ? page.assets.filter((asset) => isGalleryRowAfterCursor(asset, boundaryCursor, sort, searchQuery)).map((asset) => asset.id)
        : [];
      return { rows: page.assets, rowByAssetId, afterCursorRowIds, total: totalProbe.page.total ?? 0, stack: null };
    },
    async listNavigationStats(projectId = DEFAULT_PROJECT_ID) {
      const cleanProjectId = sanitizeProjectId(projectId);
      const dataVersion = database.pragma("data_version", { simple: true });
      const cached = navigationStatsCache.get(cleanProjectId);
      if (cached && cached.localAssetRevision === localAssetRevision && cached.dataVersion === dataVersion) {
        return structuredClone(cached.result);
      }
      // The primary sidebar needs only live navigation counts. Keep this path
      // deliberately separate from listGroups(), whose broader facet contract
      // is retained for API compatibility and non-navigation consumers.
      // trash_reclaimable_bytes (task 383): what emptying the trash would free
      // — trashed originals whose storage_mode is NOT "hard-link" (Codex
      // hard-links keep their bytes in Codex's own folder, so deleting them
      // frees nothing). Originals only: the three derivative tiers are small
      // and carry no recorded size. A missing or non-positive file_bytes
      // counts as 0. Lives in the same aggregate — no second scan.
      const stats = database.prepare(`
        SELECT
          SUM(CASE WHEN a.archived = 0 AND a.deleted_at IS NULL THEN 1 ELSE 0 END) AS total,
          SUM(CASE WHEN a.archived = 0 AND a.deleted_at IS NULL AND (a.rating > 0 OR a.favorite = 1) THEN 1 ELSE 0 END) AS favorites,
          SUM(CASE WHEN a.archived = 0 AND a.deleted_at IS NULL
            AND NOT ${assetOrganizedSql("a")} THEN 1 ELSE 0 END) AS unorganized,
          SUM(CASE WHEN a.deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS trash,
          SUM(CASE WHEN a.deleted_at IS NOT NULL
            AND COALESCE(json_extract(a.source_json, '$.storage_mode'), '') != 'hard-link'
            AND CAST(json_extract(a.business_fields_json, '$.file_bytes') AS REAL) > 0
            THEN CAST(json_extract(a.business_fields_json, '$.file_bytes') AS REAL)
            ELSE 0 END) AS trash_reclaimable_bytes
        FROM assets a
        WHERE a.project_id = ?
      `).get(cleanProjectId);
      const groups = database.prepare(`
        SELECT g.name, COUNT(a.id) AS count, g.color, COALESCE(g.position, 0) AS position
        FROM groups g
        LEFT JOIN assets a
          ON a.project_id = g.project_id
          AND a.group_name = g.name
          AND a.archived = 0
          AND a.deleted_at IS NULL
        WHERE g.project_id = ?
        GROUP BY g.name, g.color, g.position
        ORDER BY position ASC, g.name COLLATE NOCASE
      `).all(cleanProjectId).map((row) => ({
        name: row.name,
        count: Number(row.count || 0),
        color: String(row.color || ""),
        position: Number(row.position || 0),
      }));
      const sourceTypes = database.prepare(`
        SELECT a.source_group AS name, COUNT(*) AS count
        FROM assets a
        WHERE a.project_id = ? AND a.archived = 0 AND a.deleted_at IS NULL
        GROUP BY name
        HAVING name != ''
        ORDER BY count DESC, name COLLATE NOCASE
      `).all(cleanProjectId).map((row) => [row.name, Number(row.count || 0)]);
      const result = {
        total: Number(stats.total || 0),
        favorites: Number(stats.favorites || 0),
        unorganized: Number(stats.unorganized || 0),
        trash: Number(stats.trash || 0),
        trashReclaimableBytes: Number(stats.trash_reclaimable_bytes || 0),
        sourceTypes,
        groups,
      };
      navigationStatsCache.set(cleanProjectId, { localAssetRevision, dataVersion, result: structuredClone(result) });
      return result;
    },
    async listGroups(projectId = DEFAULT_PROJECT_ID) {
      const cleanProjectId = sanitizeProjectId(projectId);
      const recentSince = recentCutoffTimestamp();
      const stats = database.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN a.rating > 0 OR a.favorite = 1 THEN 1 ELSE 0 END) AS favorites,
          SUM(CASE WHEN a.created_at_epoch >= ? THEN 1 ELSE 0 END) AS recent,
          SUM(CASE WHEN NOT ${assetOrganizedSql("a")} THEN 1 ELSE 0 END) AS unorganized,
          SUM(CASE WHEN a.source_type = 'codex-generated' THEN 1 ELSE 0 END) AS codex,
          SUM(CASE WHEN a.source_type = 'cowart-generated' THEN 1 ELSE 0 END) AS cowart,
          SUM(CASE WHEN a.source_type = 'grok-generated' THEN 1 ELSE 0 END) AS grok
        FROM assets a WHERE a.project_id = ? AND a.archived = 0 AND a.deleted_at IS NULL
      `).get(recentSince, cleanProjectId);
      const groups = database.prepare(`
        SELECT g.name, COUNT(a.id) AS count, g.color, COALESCE(g.position, 0) AS position
        FROM groups g LEFT JOIN assets a ON a.project_id = g.project_id AND a.group_name = g.name AND a.archived = 0 AND a.deleted_at IS NULL
        WHERE g.project_id = ?
        GROUP BY g.name, g.color, g.position
        ORDER BY position ASC, g.name COLLATE NOCASE
      `).all(cleanProjectId).map((row) => ({
        name: row.name,
        count: Number(row.count || 0),
        color: String(row.color || ""),
        position: Number(row.position || 0),
      }));
      const sourceTypes = database.prepare(`
        SELECT a.source_group AS name, COUNT(*) AS count
        FROM assets a
        WHERE a.project_id = ? AND a.archived = 0 AND a.deleted_at IS NULL
        GROUP BY name
        HAVING name != ''
        ORDER BY count DESC, name COLLATE NOCASE
      `).all(cleanProjectId).map((row) => [row.name, Number(row.count || 0)]);
      const categories = countNamedValues(database, cleanProjectId, "category");
      // The filter panel searches this list client-side, so it has to reach past
      // the handful of most-used styles. `styleTotal` reports the real distinct
      // count so a truncated list can say so instead of looking complete.
      const styles = countNamedValues(database, cleanProjectId, "style", STYLE_FACET_LIMIT);
      const styleTotal = database.prepare(`
        SELECT COUNT(DISTINCT style) AS count FROM assets
        WHERE project_id = ? AND archived = 0 AND deleted_at IS NULL AND style != ''
      `).get(cleanProjectId).count;
      return {
        total: Number(stats.total || 0),
        favorites: Number(stats.favorites || 0),
        recent: Number(stats.recent || 0),
        unorganized: Number(stats.unorganized || 0),
        codex: Number(stats.codex || 0),
        cowart: Number(stats.cowart || 0),
        grok: Number(stats.grok || 0),
        sourceTypes,
        groups,
        categories,
        styles,
        styleTotal: Number(styleTotal || 0),
        trash: Number(database.prepare("SELECT COUNT(*) AS count FROM assets WHERE project_id = ? AND deleted_at IS NOT NULL").get(cleanProjectId).count || 0),
      };
    },
    async createGroup(input = {}) {
      const projectId = await this.ensureProject(input.projectId || DEFAULT_PROJECT_ID);
      const name = normalizeGroupName(input.name);
      if (!name) throw assetStoreError("GROUP_NAME_REQUIRED", "Group name is required.");
      const color = normalizeGroupColor(input.color);
      database.transaction(() => {
        // The stored spelling wins over the request's casing so every later
        // binary comparison (sidebar counts, gallery facet) sees one form.
        const canonical = canonicalGroupName(database, projectId, name) || name;
        if (canonical !== name) throw assetStoreError("GROUP_ALREADY_EXISTS", `Group already exists: ${canonical}`);
        const position = Number(database.prepare(
          "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM groups WHERE project_id = ?",
        ).get(projectId).next);
        const inserted = database.prepare(
          "INSERT OR IGNORE INTO groups (project_id, name, created_at, position, color) VALUES (?, ?, ?, ?, ?)",
        ).run(projectId, name, now(), position, color);
        if (!inserted.changes) throw assetStoreError("GROUP_ALREADY_EXISTS", `Group already exists: ${name}`);
        commitLibraryChanges([{ projectId, kind: "group-created", entityType: "group", entityId: name }]);
      })();
      invalidateFtsPageCache();
      const created = database.prepare("SELECT name, COALESCE(position, 0) AS position, color FROM groups WHERE project_id = ? AND name = ?").get(projectId, name);
      return { name: created.name, count: 0, color: created.color || "", position: Number(created.position || 0) };
    },
    async renameGroup(projectId, groupName, nextGroupName) {
      const pid = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const currentName = normalizeGroupName(groupName);
      const nextName = normalizeGroupName(nextGroupName);
      if (!currentName || !nextName) throw assetStoreError("GROUP_NAME_REQUIRED", "Group name is required.");

      const current = database.prepare("SELECT name FROM groups WHERE project_id = ? AND name = ? COLLATE NOCASE").get(pid, currentName);
      if (!current) throw assetStoreError("GROUP_NOT_FOUND", `Group not found: ${currentName}`);
      const duplicate = database.prepare("SELECT 1 FROM groups WHERE project_id = ? AND name = ? COLLATE NOCASE AND name != ? COLLATE NOCASE LIMIT 1").get(pid, nextName, current.name);
      if (duplicate) throw assetStoreError("GROUP_ALREADY_EXISTS", `Group already exists: ${nextName}`);

      const selectAssignedAssets = database.prepare("SELECT * FROM assets WHERE project_id = ? AND group_name = ? COLLATE NOCASE");
      const updateAssignment = database.prepare(`
        UPDATE assets
        SET group_name = ?, search_text = ?, updated_at = ?
        WHERE project_id = ? AND id = ?
      `);
      const updateGroup = database.prepare("UPDATE groups SET name = ? WHERE project_id = ? AND name = ?");
      const timestamp = now();

      database.transaction(() => {
        const result = updateGroup.run(nextName, pid, current.name);
        if (!result.changes) throw assetStoreError("GROUP_NOT_FOUND", `Group not found: ${currentName}`);
        const renamedIds = [];
        for (const row of selectAssignedAssets.all(pid, current.name)) {
          const metadata = rowToAsset(database, row);
          metadata.group = nextName;
          const searchText = searchableText(metadata);
          updateAssignment.run(nextName, searchText, timestamp, pid, row.id);
          syncAssetFtsEntry(database, pid, row.id, searchText, row.deleted_at);
          replaceAssetShortTerms(database, pid, row.id, row.search_text, searchText, row.deleted_at);
          renamedIds.push(row.id);
        }
        commitLibraryChanges([{ projectId: pid, kind: "group-renamed", entityType: "group", entityId: current.name, assetIds: renamedIds, detail: { to: nextName } }]);
      })();
      invalidateFtsPageCache();
      return { success: true, oldName: current.name, name: nextName };
    },
    async deleteGroup(projectId, groupName, options = {}) {
      const pid = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const name = normalizeGroupName(groupName);
      if (!name) throw assetStoreError("GROUP_NAME_REQUIRED", "Group name is required.");

      const currentGroup = database.prepare("SELECT name FROM groups WHERE project_id = ? AND name = ? COLLATE NOCASE").get(pid, name);
      if (!currentGroup) throw assetStoreError("GROUP_NOT_FOUND", `Group not found: ${name}`);
      const storedName = currentGroup.name;

      if (options.deleteAssets === true) {
        // "Delete group and assets" is now recoverable: every currently active
        // member enters Trash with its own 90-day clock. Keep group_name and
        // Stack membership on the rows so restore can faithfully reconstruct
        // the previous organisation even though the navigation group itself is
        // removed immediately.
        const deletedAt = now();
        const assignedRows = database.prepare(`
          SELECT * FROM assets
          WHERE project_id = ? AND group_name = ? COLLATE NOCASE AND deleted_at IS NULL
        `).all(pid, storedName);
        const externalChild = database.prepare(`
          SELECT child.id, child.parent_asset_id
          FROM assets child
          JOIN assets parent
            ON parent.project_id = child.project_id AND parent.id = child.parent_asset_id
          WHERE child.project_id = ?
            AND child.deleted_at IS NULL
            AND parent.deleted_at IS NULL
            AND parent.group_name = ? COLLATE NOCASE
            AND child.group_name != ? COLLATE NOCASE
          LIMIT 1
        `).get(pid, storedName, storedName);
        if (externalChild) {
          throw assetStoreError(
            "VERSION_PARENT_HAS_CHILDREN",
            `Cannot move group ${storedName} to Trash; version parent ${externalChild.parent_asset_id} has active child ${externalChild.id} outside the group.`,
          );
        }
        const suppressionPlans = await Promise.all(assignedRows.map(async (row) => {
          const asset = rowToAsset(database, row, { includeRelations: false });
          const files = [row.original_path, row.preview_path, row.medium_path, row.thumbnail_path].filter(Boolean);
          return { row, asset, ...(await automaticSuppressionIdentityForAsset(asset, files)) };
        }));
        database.transaction(() => {
          for (const plan of suppressionPlans) {
            const row = plan.row;
            if (plan.contentHash || plan.pixelHash) {
              database.prepare(`
                INSERT INTO automatic_ingest_suppressions (project_id, content_sha256, pixel_sha256, pixel_hash_version, deleted_at, reason)
                VALUES (?, ?, ?, ?, ?, 'user-deleted')
                ON CONFLICT(project_id, content_sha256, pixel_sha256, pixel_hash_version) DO UPDATE SET
                  deleted_at = excluded.deleted_at,
                  reason = excluded.reason
              `).run(pid, plan.contentHash, plan.pixelHash, plan.pixelHashVersion, deletedAt);
            }
            recordIdentitySuppressionRow(database, pid, plan.asset, { deletedAt });
            database.prepare("DELETE FROM derivative_jobs WHERE project_id = ? AND asset_id = ?").run(pid, row.id);
            deleteAssetFtsEntry(database, pid, row.id);
            dropAssetSearchTerms(database, pid, row.id, row.search_text);
            database.prepare("UPDATE assets SET deleted_at = ?, updated_at = ? WHERE project_id = ? AND id = ?")
              .run(deletedAt, deletedAt, pid, row.id);
          }
          // Rework 1 #3: trashing the rows changes which stack members count
          // as live, and stack sort keys are marker-gated now — the affected
          // stacks must refresh right here or their gallery dates stay wrong
          // for good (the deferred pass only runs when its marker is absent).
          const stackOfAsset = database.prepare("SELECT stack_id FROM asset_stack_members WHERE project_id = ? AND asset_id = ?");
          const touchedStacks = new Set();
          for (const row of assignedRows) {
            const membership = stackOfAsset.get(pid, row.id);
            if (membership) touchedStacks.add(membership.stack_id);
          }
          for (const stackId of touchedStacks) refreshStackSortCreatedAt(database, pid, stackId);
          const result = database.prepare("DELETE FROM groups WHERE project_id = ? AND name = ?").run(pid, storedName);
          if (!result.changes) throw assetStoreError("GROUP_NOT_FOUND", `Group not found: ${storedName}`);
          commitLibraryChanges([{
            projectId: pid,
            kind: "group-deleted",
            entityType: "group",
            entityId: storedName,
            assetIds: assignedRows.map((row) => row.id),
            detail: { trashed: true },
          }]);
        })();
        invalidateFtsPageCache();
        return { success: true, name: storedName, deletedAssets: assignedRows.length, trashed: true };
      }

      if (options.deleteAssets === "legacy-hard-delete") {
        const assignedRows = database.prepare("SELECT * FROM assets WHERE project_id = ? AND group_name = ? COLLATE NOCASE").all(pid, storedName);
        const deletingIds = new Set(assignedRows.map((row) => row.id));
        const deletionPlans = [];
        if (deletingIds.size) {
          const allParents = database.prepare("SELECT id, parent_asset_id FROM assets WHERE project_id = ?").all(pid);
          const externalChild = allParents.find((row) => row.parent_asset_id && deletingIds.has(row.parent_asset_id) && !deletingIds.has(row.id));
          if (externalChild) {
            throw assetStoreError(
              "VERSION_PARENT_HAS_CHILDREN",
              `Cannot delete group ${storedName}; version parent ${externalChild.parent_asset_id} has child ${externalChild.id} outside the group.`,
            );
          }
          const byId = new Map(assignedRows.map((row) => [row.id, row]));
          const depthOf = (row) => {
            let depth = 0;
            let parentId = row.parent_asset_id;
            const seen = new Set([row.id]);
            while (parentId && byId.has(parentId) && !seen.has(parentId)) {
              seen.add(parentId);
              depth += 1;
              parentId = byId.get(parentId).parent_asset_id;
            }
            return depth;
          };
          const deletionOrder = [...assignedRows].sort((left, right) => depthOf(right) - depthOf(left));
          // Preflight the entire destructive operation before committing any
          // database mutation. A bad path, unreadable file, or hash failure on
          // a later asset must not leave earlier assets permanently deleted.
          for (const row of deletionOrder) {
            const asset = rowToAsset(database, row);
            const stackMembership = database.prepare("SELECT stack_id FROM asset_stack_members WHERE project_id = ? AND asset_id = ?").get(pid, row.id);
            const managedPaths = [
              [this.imagesDir(pid), asset.image_path],
              [this.previewsDir(pid), asset.preview_path],
              [this.mediumsDir(pid), asset.medium_path],
              [this.thumbnailsDir(pid), asset.thumbnail_path],
            ].filter(([, filePath]) => Boolean(filePath)).map(([root, filePath]) => ({ root, filePath }));
            const filesToUnlink = [];
            for (const { root, filePath } of managedPaths) {
              try {
                await assertStoredPath(root, filePath);
                filesToUnlink.push(filePath);
              } catch (error) {
                if (error?.code !== "ENOENT") throw error;
              }
            }
            const contentHash = await contentHashForAsset(asset, filesToUnlink);
            const storedPixelHash = normalizeHash(asset.source?.pixel_sha256);
            const storedPixelHashVersion = String(asset.source?.pixel_hash_version || "").trim();
            const recomputedPixelHash = asset.image_path
              ? await safePixelDigest(asset.image_path).catch(() => "")
              : "";
            const pixelHash = recomputedPixelHash
              || (storedPixelHashVersion === PIXEL_HASH_VERSION ? "" : storedPixelHash);
            const pixelHashVersion = recomputedPixelHash
              ? PIXEL_HASH_VERSION
              : (pixelHash ? storedPixelHashVersion : "");
            deletionPlans.push({ row, asset, stackMembership, filesToUnlink, contentHash, pixelHash, pixelHashVersion });
          }
        }

        // Stage every managed file before touching the database. A crash or a
        // mid-transaction failure can then always roll back to the exact
        // previous bytes — the same discipline permanentlyDeleteAsset applies,
        // instead of post-commit best-effort unlinks.
        let staged;
        try {
          staged = await stageFilesForPermanentDeletion(this.projectDir(pid), deletionPlans.flatMap((plan) => plan.filesToUnlink));
        } catch (error) {
          throw assetStoreError("ASSET_FILE_BUSY", `Asset files are still in use: ${error?.message || error}`);
        }
        try {
          database.transaction(() => {
            const touchedStacks = new Set();
            for (const plan of deletionPlans) {
              const assetId = plan.row.id;
              if (plan.stackMembership) {
                database.prepare("DELETE FROM asset_stack_members WHERE project_id = ? AND asset_id = ?").run(pid, assetId);
                touchedStacks.add(plan.stackMembership.stack_id);
              }
              database.prepare("DELETE FROM asset_tags WHERE project_id = ? AND asset_id = ?").run(pid, assetId);
              database.prepare("DELETE FROM asset_versions WHERE project_id = ? AND asset_id = ?").run(pid, assetId);
              database.prepare("DELETE FROM asset_versions WHERE project_id = ? AND parent_asset_id = ?").run(pid, assetId);
              database.prepare("DELETE FROM derivative_jobs WHERE project_id = ? AND asset_id = ?").run(pid, assetId);
              purgeAssetSearchIndex(database, pid, assetId, plan.row.search_text);
              database.prepare("DELETE FROM auto_stack_exclusions WHERE project_id = ? AND asset_id = ?").run(pid, assetId);
              database.prepare("DELETE FROM assets WHERE project_id = ? AND id = ?").run(pid, assetId);
              if (plan.contentHash || plan.pixelHash) {
                database.prepare(`
                  INSERT INTO automatic_ingest_suppressions (project_id, content_sha256, pixel_sha256, pixel_hash_version, deleted_at, reason)
                  VALUES (?, ?, ?, ?, ?, 'user-deleted')
                  ON CONFLICT(project_id, content_sha256, pixel_sha256, pixel_hash_version) DO UPDATE SET
                    deleted_at = excluded.deleted_at,
                    reason = excluded.reason
                `).run(pid, plan.contentHash, plan.pixelHash, plan.pixelHashVersion, now());
              }
              // Hard delete is permanent, so the replaced-media exception
              // applies here too: a snapshot of a swap never suppresses the
              // id that lives on the surviving asset.
              if (String(plan.asset.trash_reason?.code || "") !== REPLACED_MEDIA_TRASH_REASON) {
                recordIdentitySuppressionRow(database, pid, plan.asset, { deletedAt: now() });
              }
            }
            for (const stackId of touchedStacks) compactAssetStack(database, pid, stackId);
            // Rework 1 #3: membership changed (and compaction may have
            // dissolved a stack), but this path emits no stack records —
            // refresh every touched stack's sort key here; a dissolved stack
            // id simply matches no rows.
            for (const stackId of touchedStacks) refreshStackSortCreatedAt(database, pid, stackId);
            const result = database.prepare("DELETE FROM groups WHERE project_id = ? AND name = ?").run(pid, storedName);
            if (!result.changes) throw assetStoreError("GROUP_NOT_FOUND", `Group not found: ${storedName}`);
            commitLibraryChanges([{
              projectId: pid,
              kind: "group-deleted",
              entityType: "group",
              entityId: storedName,
              assetIds: assignedRows.map((row) => row.id),
              detail: { trashed: false },
            }]);
          })();
        } catch (error) {
          await staged.rollback();
          throw error;
        }
        invalidateFtsPageCache();
        const cleanupComplete = await staged.commit();
        return { success: true, name: storedName, deletedAssets: assignedRows.length, cleanupPending: !cleanupComplete };
      }

      const selectAssignedAssets = database.prepare("SELECT * FROM assets WHERE project_id = ? AND group_name = ? COLLATE NOCASE");
      const clearAssignment = database.prepare(`
        UPDATE assets
        SET group_name = '', search_text = ?, updated_at = ?
        WHERE project_id = ? AND id = ?
      `);
      const deleteGroup = database.prepare("DELETE FROM groups WHERE project_id = ? AND name = ?");
      const timestamp = now();

      database.transaction(() => {
        const ungroupedIds = [];
        for (const row of selectAssignedAssets.all(pid, storedName)) {
          const metadata = rowToAsset(database, row);
          metadata.group = "";
          const searchText = searchableText(metadata);
          clearAssignment.run(searchText, timestamp, pid, row.id);
          syncAssetFtsEntry(database, pid, row.id, searchText, row.deleted_at);
          replaceAssetShortTerms(database, pid, row.id, row.search_text, searchText, row.deleted_at);
          ungroupedIds.push(row.id);
        }

        const result = deleteGroup.run(pid, storedName);
        if (!result.changes) throw assetStoreError("GROUP_NOT_FOUND", `Group not found: ${storedName}`);
        commitLibraryChanges([{
          projectId: pid,
          kind: "group-deleted",
          entityType: "group",
          entityId: storedName,
          assetIds: ungroupedIds,
          detail: { trashed: false, ungrouped: true },
        }]);
      })();
      invalidateFtsPageCache();

      return { success: true, name: storedName, deletedAssets: 0 };
    },
    /**
     * Moves a set of assets into (or, with "", out of) a group in one
     * transaction. Unlike per-asset updateMetadata this skips relation loading
     * and recipe snapshots — a membership change is not a recipe change — so a
     * Select All move stays O(selected), not O(selected × full row rewrite).
     */
    async assignAssetsToGroup(projectId, assetIds, groupName) {
      const pid = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const ids = [...new Set((Array.isArray(assetIds) ? assetIds : []).map((id) => String(id || "").trim()).filter(Boolean))];
      if (!ids.length) throw assetStoreError("ASSET_IDS_REQUIRED", "assetIds must be a non-empty array.");
      const requested = normalizeGroupName(groupName);
      const target = requested
        ? (canonicalGroupName(database, pid, requested) || requested)
        : "";

      const selectAsset = database.prepare("SELECT * FROM assets WHERE project_id = ? AND id = ?");
      const updateAssignment = database.prepare(`
        UPDATE assets
        SET group_name = ?, search_text = ?, updated_at = ?
        WHERE project_id = ? AND id = ?
      `);
      const timestamp = now();

      const results = [];
      let failures = 0;
      database.transaction(() => {
        if (target) {
          database.prepare(`
            INSERT OR IGNORE INTO groups (project_id, name, created_at, position, color)
            VALUES (?, ?, ?, (SELECT COALESCE(MAX(g.position), -1) + 1 FROM groups g WHERE g.project_id = ?), '')
          `).run(pid, target, now(), pid);
        }
        const changedIds = [];
        for (const assetId of ids) {
          const row = selectAsset.get(pid, assetId);
          if (!row) {
            failures += 1;
            results.push({ id: assetId, ok: false, code: "ASSET_NOT_FOUND", error: `Asset not found: ${assetId}` });
            continue;
          }
          if (String(row.group_name || "").trim().toLowerCase() === target.toLowerCase()) {
            results.push({ id: assetId, group: target });
            continue;
          }
          const metadata = rowToAsset(database, row);
          metadata.group = target;
          const searchText = searchableText(metadata);
          updateAssignment.run(target, searchText, timestamp, pid, assetId);
          syncAssetFtsEntry(database, pid, assetId, searchText, row.deleted_at);
          replaceAssetShortTerms(database, pid, assetId, row.search_text, searchText, row.deleted_at);
          changedIds.push(assetId);
          results.push({ id: assetId, group: target });
        }
        if (changedIds.length) {
          commitLibraryChanges([{
            projectId: pid,
            kind: "assets-updated",
            entityType: "asset-batch",
            entityId: "group-assignment",
            assetIds: changedIds,
            flags: ["group"],
          }]);
        }
      })();
      invalidateFtsPageCache();
      return { results, partial: failures > 0 };
    },
    async updateGroupSettings(projectId, groupName, patch = {}) {
      const pid = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const name = normalizeGroupName(groupName);
      if (!name) throw assetStoreError("GROUP_NAME_REQUIRED", "Group name is required.");
      const updates = {};
      if (Object.hasOwn(patch, "color")) updates.color = normalizeGroupColor(patch.color);
      if (!Object.keys(updates).length) throw assetStoreError("GROUP_PATCH_EMPTY", "No supported group settings were provided.");
      const assignments = Object.keys(updates).map((column) => `${column} = @${column}`).join(", ");
      database.transaction(() => {
        const result = database.prepare(
          `UPDATE groups SET ${assignments} WHERE project_id = @pid AND name = @name`,
        ).run({ pid, name, ...updates });
        if (!result.changes) throw assetStoreError("GROUP_NOT_FOUND", `Group not found: ${name}`);
        commitLibraryChanges([{
          projectId: pid,
          kind: "group-updated",
          entityType: "group",
          entityId: name,
          detail: updates,
        }]);
      })();
      invalidateFtsPageCache();
      const row = database.prepare("SELECT name, COALESCE(position, 0) AS position, color FROM groups WHERE project_id = ? AND name = ?").get(pid, name);
      return { name: row.name, color: row.color || "", position: Number(row.position || 0) };
    },
    /**
     * Folds one group's membership into another and removes the source group.
     * The membership rewrite mirrors renameGroup's (search_text + FTS stay in
     * sync); the journal records it as a group-deleted with `mergedInto` so
     * other windows can redirect an active filter on the source group.
     */
    async mergeGroups(projectId, fromGroupName, intoGroupName) {
      const pid = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const fromRequested = normalizeGroupName(fromGroupName);
      const intoRequested = normalizeGroupName(intoGroupName);
      if (!fromRequested || !intoRequested) throw assetStoreError("GROUP_NAME_REQUIRED", "Group name is required.");
      if (fromRequested.toLowerCase() === intoRequested.toLowerCase()) {
        throw assetStoreError("GROUP_MERGE_SAME", "A group cannot be merged into itself.");
      }
      const from = canonicalGroupName(database, pid, fromRequested);
      if (!from) throw assetStoreError("GROUP_NOT_FOUND", `Group not found: ${fromRequested}`);
      const into = canonicalGroupName(database, pid, intoRequested);
      if (!into) throw assetStoreError("GROUP_NOT_FOUND", `Group not found: ${intoRequested}`);

      const selectAssignedAssets = database.prepare("SELECT * FROM assets WHERE project_id = ? AND group_name = ? COLLATE NOCASE");
      const updateAssignment = database.prepare(`
        UPDATE assets
        SET group_name = ?, search_text = ?, updated_at = ?
        WHERE project_id = ? AND id = ?
      `);
      const deleteGroup = database.prepare("DELETE FROM groups WHERE project_id = ? AND name = ?");
      const timestamp = now();

      let movedIds = [];
      database.transaction(() => {
        movedIds = [];
        for (const row of selectAssignedAssets.all(pid, from)) {
          const metadata = rowToAsset(database, row);
          metadata.group = into;
          const searchText = searchableText(metadata);
          updateAssignment.run(into, searchText, timestamp, pid, row.id);
          syncAssetFtsEntry(database, pid, row.id, searchText, row.deleted_at);
          replaceAssetShortTerms(database, pid, row.id, row.search_text, searchText, row.deleted_at);
          movedIds.push(row.id);
        }
        const result = deleteGroup.run(pid, from);
        if (!result.changes) throw assetStoreError("GROUP_NOT_FOUND", `Group not found: ${from}`);
        commitLibraryChanges([{
          projectId: pid,
          kind: "group-deleted",
          entityType: "group",
          entityId: from,
          assetIds: movedIds,
          detail: { mergedInto: into },
        }]);
      })();
      invalidateFtsPageCache();
      return { success: true, from, into, movedAssets: movedIds.length };
    },
    /**
     * Persists the complete manual ordering of a project's groups. `names`
     * must cover exactly the existing groups (case-insensitively); a mismatch
     * is an error rather than a silent partial reorder, so a stale client
     * refetches instead of corrupting the order.
     */
    async reorderGroups(projectId, names) {
      const pid = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const ordered = (Array.isArray(names) ? names : []).map((name) => normalizeGroupName(name)).filter(Boolean);
      if (!ordered.length) throw assetStoreError("GROUP_NAME_REQUIRED", "Group order must be a non-empty array.");
      const existing = database.prepare("SELECT name FROM groups WHERE project_id = ?").all(pid).map((row) => row.name);
      if (ordered.length !== existing.length
        || new Set(ordered.map((name) => name.toLowerCase())).size !== existing.length
        || existing.some((name) => !ordered.some((candidate) => candidate.toLowerCase() === name.toLowerCase()))) {
        throw assetStoreError("GROUP_SET_MISMATCH", "Group order does not match the project's groups; reload and retry.");
      }
      const canonicalOrder = ordered.map((name) => canonicalGroupName(database, pid, name) || name);
      const updatePosition = database.prepare("UPDATE groups SET position = ? WHERE project_id = ? AND name = ?");
      database.transaction(() => {
        canonicalOrder.forEach((name, position) => updatePosition.run(position, pid, name));
        commitLibraryChanges([{ projectId: pid, kind: "groups-reordered", entityType: "group", entityId: "" }]);
      })();
      invalidateFtsPageCache();
      return { success: true, order: canonicalOrder };
    },
    async getGroupStats(projectId, groupName) {
      const pid = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const requested = normalizeGroupName(groupName);
      if (!requested) throw assetStoreError("GROUP_NAME_REQUIRED", "Group name is required.");
      const canonical = canonicalGroupName(database, pid, requested);
      if (!canonical) throw assetStoreError("GROUP_NOT_FOUND", `Group not found: ${requested}`);
      const members = `FROM assets WHERE project_id = @pid AND group_name = @name COLLATE NOCASE AND archived = 0 AND deleted_at IS NULL`;
      const counts = database.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN rating > 0 OR favorite = 1 THEN 1 ELSE 0 END) AS favorites,
          SUM(CASE WHEN media_kind = 'video' THEN 1 ELSE 0 END) AS videos,
          SUM(CASE WHEN parent_asset_id IS NOT NULL AND parent_asset_id != '' THEN 1 ELSE 0 END) AS versionChildren
        ${members}
      `).get({ pid, name: canonical });
      const byFacet = (column) => database.prepare(`
        SELECT ${column} AS name, COUNT(*) AS count ${members} AND ${column} != ''
        GROUP BY name ORDER BY count DESC, name COLLATE NOCASE LIMIT 8
      `).all({ pid, name: canonical }).map((row) => [row.name, Number(row.count || 0)]);
      const trashed = Number(database.prepare(
        "SELECT COUNT(*) AS count FROM assets WHERE project_id = ? AND group_name = ? COLLATE NOCASE AND deleted_at IS NOT NULL",
      ).get(pid, canonical).count || 0);
      return {
        name: canonical,
        total: Number(counts.total || 0),
        favorites: Number(counts.favorites || 0),
        videos: Number(counts.videos || 0),
        versionChildren: Number(counts.versionChildren || 0),
        images: Math.max(0, Number(counts.total || 0) - Number(counts.videos || 0)),
        categories: byFacet("category"),
        sources: byFacet("source_group"),
        trashed,
      };
    },
    /**
     * Content-hash lookup served by `assets_project_hash_idx` instead of listing the project.
     * Archived rows are included, and the ordering matches the JSON store: active before
     * archived, newest first.
     *
     * `INDEXED BY` is deliberate. Left to choose, the planner prefers `assets_project_created_idx`
     * because it also satisfies the ORDER BY — and then walks every row in the project, which is
     * the whole cost this method exists to avoid and is worst on a miss, the common case while
     * ingesting. Pinning the index keeps the lookup proportional to the number of assets sharing
     * the hash, and makes a dropped index fail loudly instead of silently degrading.
     */
    async findAssetByContentHash(projectId, contentHash) {
      const hash = String(contentHash || "");
      if (!hash) return null;
      const row = database.prepare(`
        SELECT * FROM assets INDEXED BY assets_project_hash_idx
        WHERE project_id = ? AND content_sha256 = ? AND deleted_at IS NULL
        ORDER BY archived ASC, mosa_normalize_created_at(created_at) DESC, id DESC LIMIT 1
      `).get(sanitizeProjectId(projectId || DEFAULT_PROJECT_ID), hash);
      return row ? rowToAsset(database, row) : null;
    },
    /**
     * Reference hard-linking asks: "do these bytes already exist as a managed
     * original?" Trash counts — the file is still on disk there, and a link
     * keeps working no matter which name goes away — but live rows win the
     * ordering so the link tracks the longest-lived copy. Returns an absolute
     * original path inside this library, or "" when nothing matches. Callers
     * must re-hash the returned file before trusting it.
     */
    async findOriginalByContentHash(projectId, contentSha256) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const hash = normalizeHash(contentSha256);
      if (!hash) return "";
      const rows = database.prepare(`
        SELECT original_path FROM assets INDEXED BY assets_project_hash_idx
        WHERE project_id = ? AND content_sha256 = ?
        ORDER BY deleted_at IS NULL DESC, mosa_normalize_created_at(created_at) DESC, id DESC
      `).all(cleanProjectId, hash);
      const originalRoot = resolve(this.imagesDir(cleanProjectId));
      for (const row of rows) {
        const candidate = String(row?.original_path || "");
        if (!candidate) continue;
        const resolvedPath = resolve(candidate);
        if (!isPathInside(originalRoot, resolvedPath)) continue;
        try {
          const info = await lstat(resolvedPath);
          if (info.isFile()) return resolvedPath;
        } catch {
          // Missing file: try the next row sharing this hash.
        }
      }
      return "";
    },
    /**
     * Bridge reconciliation needs to answer "has this exact source file already
     * been archived?" without materialising the entire library. `source_path`
     * mirrors `source.path` into an indexed scalar column for that hot lookup.
     * Archived rows are intentionally included because automatic bridges must
     * never re-import an asset merely because the user archived it.
     */
    async findAssetBySourcePath(projectId, sourcePath) {
      const path = String(sourcePath || "");
      if (!path) return null;
      const row = database.prepare(`
        SELECT * FROM assets INDEXED BY assets_project_source_path_idx
        WHERE project_id = ? AND source_path = ? AND deleted_at IS NULL
        ORDER BY archived ASC, mosa_normalize_created_at(created_at) DESC, id DESC LIMIT 1
      `).get(sanitizeProjectId(projectId || DEFAULT_PROJECT_ID), path);
      return row ? rowToAsset(database, row, { includeRelations: false }) : null;
    },
    /**
     * Media-replacement identity lookup. `mediaKind` ("image" | "video") pins
     * the match to one media type so a same-id image can never stand in for a
     * video or vice versa; copies ("duplicated_from") and versions
     * ("versioned_from" / a parent_asset_id) inherit the provider id but are
     * not the archived original, so only the ingested asset itself answers here.
     */
    async findAssetByProviderIdentity(projectId, provider, providerAssetId = "", logicalOutputId = "", mediaKind = "") {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanProvider = String(provider || "").trim().toLowerCase();
      const cleanProviderAssetId = String(providerAssetId || "").trim();
      const cleanLogicalOutputId = String(logicalOutputId || "").trim();
      if (!cleanProvider || (!cleanProviderAssetId && !cleanLogicalOutputId)) return null;
      const providerSourceTypes = {
        chatgpt: "web-chatgpt",
        gemini: "web-gemini",
        flow: "web-flow",
        "google-ai-studio": "web-google-ai-studio",
        jimeng: "web-jimeng",
        midjourney: "web-midjourney",
      };
      const sourceType = providerSourceTypes[cleanProvider] || "";
      if (!sourceType) return null;
      const cleanMediaKind = mediaKind === "image" || mediaKind === "video" ? mediaKind : "";
      const clauses = [];
      const params = [cleanProjectId, sourceType];
      if (cleanProviderAssetId) {
        clauses.push("provider_asset_id = ?");
        params.push(cleanProviderAssetId);
      }
      if (cleanLogicalOutputId) {
        clauses.push("logical_output_id = ?");
        params.push(cleanLogicalOutputId);
      }
      const row = database.prepare(`
        SELECT * FROM assets
        WHERE project_id = ? AND source_type = ? AND deleted_at IS NULL
          AND parent_asset_id IS NULL
          AND json_extract(source_json, '$.duplicated_from') IS NULL
          AND json_extract(source_json, '$.versioned_from') IS NULL
          AND (${clauses.join(" OR ")})
          ${cleanMediaKind ? "AND mosa_media_kind(business_fields_json, source_json, original_path) = ?" : ""}
        ORDER BY archived ASC, created_at DESC, id DESC LIMIT 1
      `).get(...params, ...(cleanMediaKind ? [cleanMediaKind] : []));
      return row ? rowToAsset(database, row, { includeRelations: false }) : null;
    },
    /**
     * Provider deletion sync (lib/provider-deletion-sync.mjs): every row —
     * live or already trashed — matching a provider identity, with the
     * "整理过" verdict from the one shared list (lib/asset-organized.mjs, task
     * 304) and the derivative provenance the group rules read (own parent,
     * version/duplicate source links, merged provider ids). One query must
     * answer the whole keep-or-trash decision per item.
     */
    async findProviderDeletionMatches(projectId, provider, providerAssetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanProvider = String(provider || "").trim().toLowerCase();
      const cleanProviderAssetId = String(providerAssetId || "").trim();
      const providerSourceTypes = {
        chatgpt: "web-chatgpt",
        gemini: "web-gemini",
        flow: "web-flow",
        "google-ai-studio": "web-google-ai-studio",
        jimeng: "web-jimeng",
        midjourney: "web-midjourney",
      };
      const sourceType = providerSourceTypes[cleanProvider] || "";
      if (!sourceType || !cleanProviderAssetId) return [];
      return database.prepare(`
        SELECT a.id AS id, a.deleted_at AS deleted_at,
               a.parent_asset_id AS parent_asset_id,
               json_extract(a.source_json, '$.duplicated_from') AS duplicated_from,
               json_extract(a.source_json, '$.versioned_from') AS versioned_from,
               json_extract(a.source_json, '$.merged_provider_asset_ids') AS merged_provider_asset_ids,
               json_extract(a.source_json, '$.provider_deletion_keep') AS provider_deletion_keep,
               EXISTS(
                 SELECT 1 FROM assets c
                 WHERE c.project_id = a.project_id AND c.parent_asset_id = a.id
               ) AS has_child_versions,
               EXISTS(
                 SELECT 1 FROM assets d
                 WHERE d.project_id = a.project_id
                   AND (json_extract(d.source_json, '$.duplicated_from') = a.id
                        OR json_extract(d.source_json, '$.versioned_from') = a.id)
               ) AS has_derived_references,
               ${assetOrganizedSql("a")} AS organized
        FROM assets a
        WHERE a.project_id = ? AND a.source_type = ? AND a.provider_asset_id = ?
        ORDER BY a.deleted_at IS NULL DESC, a.created_at DESC, a.id DESC
      `).all(cleanProjectId, sourceType, cleanProviderAssetId).map((row) => ({
        id: row.id,
        projectId: cleanProjectId,
        deleted: Boolean(row.deleted_at),
        parentAssetId: String(row.parent_asset_id || ""),
        duplicatedFrom: row.duplicated_from == null ? "" : String(row.duplicated_from),
        versionedFrom: row.versioned_from == null ? "" : String(row.versioned_from),
        mergedProviderAssetIds: row.merged_provider_asset_ids == null ? null : String(row.merged_provider_asset_ids),
        providerDeletionKeep: row.provider_deletion_keep == null ? null : String(row.provider_deletion_keep),
        hasChildVersions: Boolean(row.has_child_versions),
        hasDerivedReferences: Boolean(row.has_derived_references),
        organized: Boolean(row.organized),
      }));
    },
    async findAssetByPixelHash(projectId, pixelHash) {
      const hash = String(pixelHash || "");
      if (!hash) return null;
      const row = database.prepare(`
        SELECT * FROM assets INDEXED BY assets_project_pixel_hash_idx
        WHERE project_id = ? AND pixel_sha256 = ?
          AND deleted_at IS NULL
          AND json_extract(source_json, '$.pixel_hash_version') = ?
        ORDER BY archived ASC, mosa_normalize_created_at(created_at) DESC, id DESC LIMIT 1
      `).get(sanitizeProjectId(projectId || DEFAULT_PROJECT_ID), hash, PIXEL_HASH_VERSION);
      return row ? rowToAsset(database, row) : null;
    },
    async findAssetsByPixelHash(projectId, pixelHash) {
      const hash = String(pixelHash || "");
      if (!hash) return [];
      return database.prepare(`
        SELECT * FROM assets INDEXED BY assets_project_pixel_hash_idx
        WHERE project_id = ? AND pixel_sha256 = ? AND deleted_at IS NULL
        ORDER BY archived ASC, mosa_normalize_created_at(created_at) DESC, id DESC
      `).all(sanitizeProjectId(projectId || DEFAULT_PROJECT_ID), hash)
        .map((row) => rowToAsset(database, row, { includeRelations: false }));
    },
    async listAssetsByConversation(projectId, conversationId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanConversationId = String(conversationId || "").trim();
      if (!cleanConversationId) return [];
      const select = database.prepare(`
        SELECT * FROM assets INDEXED BY assets_project_conversation_idx
        WHERE project_id = ? AND archived = ? AND conversation_id = ? AND deleted_at IS NULL
        ORDER BY created_at DESC, id DESC
      `);
      return [
        ...select.all(cleanProjectId, 0, cleanConversationId),
        ...select.all(cleanProjectId, 1, cleanConversationId),
      ].map((row) => rowToAsset(database, row, { includeRelations: false }));
    },
    async findAutomaticIngestSuppression(projectId = DEFAULT_PROJECT_ID, hashes = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const normalized = normalizeSuppressionHashes(hashes);
      if (!normalized.content_sha256 && !normalized.pixel_sha256) return null;
      const byContent = normalized.content_sha256
        ? database.prepare(`
          SELECT project_id, content_sha256, pixel_sha256, pixel_hash_version, deleted_at, reason
          FROM automatic_ingest_suppressions INDEXED BY automatic_suppressions_project_content_idx
          WHERE project_id = ? AND content_sha256 = ?
          ORDER BY deleted_at DESC LIMIT 1
        `).get(cleanProjectId, normalized.content_sha256)
        : null;
      if (byContent) return suppressionRowToObject(byContent);
      const byPixel = normalized.pixel_sha256
        ? database.prepare(`
          SELECT project_id, content_sha256, pixel_sha256, pixel_hash_version, deleted_at, reason
          FROM automatic_ingest_suppressions INDEXED BY automatic_suppressions_project_pixel_idx
          WHERE project_id = ? AND pixel_sha256 = ?
            AND (? = '' OR pixel_hash_version = ?)
          ORDER BY deleted_at DESC LIMIT 1
        `).get(cleanProjectId, normalized.pixel_sha256, normalized.pixel_hash_version, normalized.pixel_hash_version)
        : null;
      return byPixel ? suppressionRowToObject(byPixel) : null;
    },
    async listAutomaticIngestSuppressions(projectId = DEFAULT_PROJECT_ID) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      return database.prepare(`
        SELECT project_id, content_sha256, pixel_sha256, pixel_hash_version, deleted_at, reason
        FROM automatic_ingest_suppressions INDEXED BY automatic_suppressions_project_deleted_idx
        WHERE project_id = ?
        ORDER BY deleted_at DESC, content_sha256, pixel_sha256, pixel_hash_version
      `).all(cleanProjectId).map(suppressionRowToObject);
    },
    async clearAutomaticIngestSuppression(projectId = DEFAULT_PROJECT_ID, hashes = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const normalized = normalizeSuppressionHashes(hashes);
      if (!normalized.content_sha256 && !normalized.pixel_sha256) return 0;
      // Suppressions are a library mutation like any other: the change and its
      // journal entry commit together so delta clients observe the new state.
      return database.transaction(() => {
        const result = database.prepare(`
          DELETE FROM automatic_ingest_suppressions
          WHERE project_id = ?
            AND ((? != '' AND content_sha256 = ?)
              OR (? != '' AND pixel_sha256 = ? AND (? = '' OR pixel_hash_version = ?)))
        `).run(
          cleanProjectId,
          normalized.content_sha256,
          normalized.content_sha256,
          normalized.pixel_sha256,
          normalized.pixel_sha256,
          normalized.pixel_hash_version,
          normalized.pixel_hash_version,
        );
        if (result.changes) {
          commitLibraryChanges([{
            projectId: cleanProjectId,
            kind: "library-changed",
            entityType: "library",
            detail: { suppressionsCleared: result.changes },
          }]);
        }
        return result.changes;
      })();
    },
    async recordAutomaticIngestSuppression(projectId = DEFAULT_PROJECT_ID, record = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const normalized = normalizeSuppressionRecord({ ...record, project_id: cleanProjectId });
      if (!normalized.content_sha256 && !normalized.pixel_sha256) return null;
      database.transaction(() => {
        database.prepare(`
          INSERT INTO automatic_ingest_suppressions (project_id, content_sha256, pixel_sha256, pixel_hash_version, deleted_at, reason)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, content_sha256, pixel_sha256, pixel_hash_version) DO UPDATE SET
            deleted_at = excluded.deleted_at,
            reason = excluded.reason
        `).run(
          normalized.project_id,
          normalized.content_sha256,
          normalized.pixel_sha256,
          normalized.pixel_hash_version,
          normalized.deleted_at,
          normalized.reason,
        );
        commitLibraryChanges([{
          projectId: cleanProjectId,
          kind: "library-changed",
          entityType: "library",
          detail: { suppressionsRecorded: 1 },
        }]);
      })();
      return normalized;
    },
    async getAsset(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const row = database.prepare("SELECT * FROM assets WHERE project_id = ? AND id = ?").get(cleanProjectId, cleanAssetId);
      if (!row) throw assetNotFoundError(cleanAssetId);
      return rowToAsset(database, row);
    },
    /**
     * Backfills the dominant-color palette for assets imported before palettes
     * existed, from the already-published thumbnail. palette_json conventions:
     * NULL = never computed (videos and assets without a usable thumbnail stay
     * NULL so a later derivative run can fill them), '[]' = computed and empty
     * — those are never recomputed here. Returns the freshest asset either way.
     */
    async ensureAssetPalette(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const row = database.prepare("SELECT * FROM assets WHERE project_id = ? AND id = ?").get(cleanProjectId, cleanAssetId);
      if (!row) throw assetNotFoundError(cleanAssetId);
      const isVideo = mediaKindOf({
        business_fields: parseJson(row.business_fields_json, {}),
        source: parseJson(row.source_json, {}),
        image_path: row.original_path,
      }) === "video";
      if (row.palette_json != null || isVideo || !row.thumbnail_path || !existsSync(row.thumbnail_path)) {
        return rowToAsset(database, row);
      }
      // Never throws: read/decode failures come back as [] and are recorded as
      // '[]' so every later GET skips the work instead of retrying it.
      const palette = await extractImagePalette(row.thumbnail_path);
      database.prepare("UPDATE assets SET palette_json = ? WHERE project_id = ? AND id = ?")
        .run(JSON.stringify(palette), cleanProjectId, cleanAssetId);
      const fresh = database.prepare("SELECT * FROM assets WHERE project_id = ? AND id = ?").get(cleanProjectId, cleanAssetId);
      return rowToAsset(database, fresh);
    },
    /**
     * Manual-import dedupe, stage two (task 291): for the just-imported assets,
     * report which ones are still waiting for a perceptual hash (pending),
     * which can never be compared (unchecked), which are pixel-identical to a
     * pre-existing library asset (identical — the caller moves them to Trash),
     * and which merely look similar (matches — the user decides in the import
     * review list, one row per new asset: the closest candidate). Read-only
     * except for the lazy pixel-digest cache column. Only pre-existing library
     * rows (this batch excluded, Trash excluded) are candidates, so images
     * captured in the same round never mark each other.
     *
     * Cost discipline (task 291 rework): while anything is still pending —
     * including "the startup backfill has not finished yet" — the call returns
     * immediately instead of comparing against a partial candidate set.
     * Candidate hashes are parsed into uint32 pairs once per call and the
     * inner loop is xor + popcount-table lookups only, with an event-loop
     * yield every 200 assets, so a 2000-asset check against a 30k library
     * stays in the seconds range and never wedges the server.
     */
    async similarCheckState(projectId, assetIds) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const ids = [...new Set((Array.isArray(assetIds) ? assetIds : []).map((id) => sanitizeId(id, "asset")))].filter(Boolean);
      const pending = [];
      const unchecked = [];
      const identical = [];
      const matches = [];
      if (!ids.length) return { pending, unchecked, identical, matches };
      // Before the one-shot backfill has flagged itself done, the candidate
      // set is still growing: comparing now could report a match/identical
      // verdict the next poll would miss. Hold the whole batch in pending so
      // the review keeps showing "checking for similar images…" (task 291
      // rework §4).
      const backfilled = Boolean(database.prepare("SELECT value FROM library_meta WHERE key = 'perceptual-hash-backfilled'").get());
      if (!backfilled) return { pending: [...ids], unchecked, identical, matches };
      const inBatch = ids.map(() => "?").join(",");
      const rows = database.prepare(`
        SELECT a.id, a.original_path, a.thumbnail_path, a.business_fields_json, a.media_kind, a.deleted_at
        FROM assets a WHERE a.project_id = ? AND a.id IN (${inBatch})
      `).all(cleanProjectId, ...ids);
      const hashRows = database.prepare(`
        SELECT asset_id, algorithm, hash, pixel_sha256, pixel_hash_version
        FROM asset_perceptual_hashes WHERE project_id = ? AND asset_id IN (${inBatch})
      `).all(cleanProjectId, ...ids);
      const newHashByAsset = new Map(hashRows.map((row) => [row.asset_id, row]));
      const readyRows = [];
      for (const row of rows) {
        if (row.deleted_at) continue;
        const hashRow = newHashByAsset.get(row.id);
        if (!hashRow) {
          if (row.media_kind !== "image") {
            unchecked.push(row.id);
            continue;
          }
          if (!row.thumbnail_path) {
            const job = database.prepare("SELECT status FROM derivative_jobs WHERE project_id = ? AND asset_id = ?")
              .get(cleanProjectId, row.id);
            if (job && (job.status === "pending" || job.status === "running")) pending.push(row.id);
            else unchecked.push(row.id);
            continue;
          }
          // The backfill is done, so a thumbnail without a hash row is one the
          // sweep could never decode; nothing later will produce a hash for it.
          unchecked.push(row.id);
          continue;
        }
        if (hashRow.algorithm !== PERCEPTUAL_HASH_ALGORITHM) {
          unchecked.push(row.id);
          continue;
        }
        readyRows.push({ row, hashRow });
      }
      if (pending.length || !readyRows.length) return { pending, unchecked, identical, matches };

      const candidates = database.prepare(`
        SELECT h.asset_id, h.hash,
          a.original_path, a.archived, a.created_at,
          COALESCE(CAST(json_extract(a.business_fields_json, '$.width') AS REAL), 0) AS width,
          COALESCE(CAST(json_extract(a.business_fields_json, '$.height') AS REAL), 0) AS height
        FROM asset_perceptual_hashes h
        JOIN assets a ON a.project_id = h.project_id AND a.id = h.asset_id
        WHERE h.project_id = ? AND h.algorithm = ? AND a.deleted_at IS NULL
          AND h.asset_id NOT IN (${inBatch})
      `).all(cleanProjectId, PERCEPTUAL_HASH_ALGORITHM, ...ids);
      const candidateCount = candidates.length;
      const candidateHigh = new Uint32Array(candidateCount);
      const candidateLow = new Uint32Array(candidateCount);
      const candidateWidth = new Float64Array(candidateCount);
      const candidateHeight = new Float64Array(candidateCount);
      const candidateArchived = new Uint8Array(candidateCount);
      const candidateCreatedAt = new Array(candidateCount);
      candidates.forEach((candidate, index) => {
        candidateHigh[index] = parseInt(candidate.hash.slice(0, 8), 16) >>> 0;
        candidateLow[index] = parseInt(candidate.hash.slice(8, 16), 16) >>> 0;
        candidateWidth[index] = candidate.width;
        candidateHeight[index] = candidate.height;
        candidateArchived[index] = candidate.archived ? 1 : 0;
        candidateCreatedAt[index] = String(candidate.created_at || "");
      });

      const isBetterCandidate = (distance, index, current) => {
        if (distance !== current.distance) return distance < current.distance;
        if (candidateArchived[index] !== candidateArchived[current.index]) return candidateArchived[index] < candidateArchived[current.index];
        return candidateCreatedAt[index] > candidateCreatedAt[current.index];
      };

      let lazyBudget = SIMILAR_LAZY_PIXEL_BUDGET_PER_CHECK;
      let processed = 0;
      for (const { row, hashRow } of readyRows) {
        const newHigh = parseInt(hashRow.hash.slice(0, 8), 16) >>> 0;
        const newLow = parseInt(hashRow.hash.slice(8, 16), 16) >>> 0;
        const newDims = businessFieldDims(row.business_fields_json);
        const newRatio = newDims ? newDims[0] / newDims[1] : 0;
        let best = null;
        for (let index = 0; index < candidateCount; index += 1) {
          let distance = PERCEPTUAL_POPCOUNT[(newHigh ^ candidateHigh[index]) & 0xffff]
            + PERCEPTUAL_POPCOUNT[((newHigh ^ candidateHigh[index]) >>> 16) & 0xffff];
          if (distance > SIMILAR_DISTANCE_THRESHOLD) continue;
          distance += PERCEPTUAL_POPCOUNT[(newLow ^ candidateLow[index]) & 0xffff]
            + PERCEPTUAL_POPCOUNT[((newLow ^ candidateLow[index]) >>> 16) & 0xffff];
          if (distance > SIMILAR_DISTANCE_THRESHOLD) continue;
          // Ratio check only for the few rows that clear the distance gate.
          if (newRatio > 0 && candidateWidth[index] > 0 && candidateHeight[index] > 0
            && Math.abs(Math.log(newRatio / (candidateWidth[index] / candidateHeight[index]))) > SIMILAR_RATIO_TOLERANCE) {
            continue;
          }
          if (!best || isBetterCandidate(distance, index, best)) best = { index, distance };
        }
        processed += 1;
        if (processed % 200 === 0) await new Promise((resolve) => setImmediate(resolve));
        if (!best) continue;
        const bestCandidate = candidates[best.index];
        const exactSize = newDims && bestCandidate.width > 0 && bestCandidate.height > 0
          && newDims[0] === bestCandidate.width && newDims[1] === bestCandidate.height;
        let identicalHit = false;
        if (best.distance <= 2 && exactSize) {
          // Identical bitmaps hide behind (near-)equal thumbnails — older
          // derivatives can land a bit or two away — so confirm on the lazily
          // computed display-pixel digest before calling it identical. Pixels
          // alone decide: the distance gate only picks whom to confirm.
          if (lazyBudget <= 0) {
            pending.push(row.id);
            continue;
          }
          lazyBudget -= 1;
          identicalHit = await this.perceptualPixelDigestsEqual(cleanProjectId, row, hashRow, bestCandidate);
        }
        if (identicalHit) {
          identical.push({ newAssetId: row.id, existingAssetId: bestCandidate.asset_id });
          continue;
        }
        const newWidth = newDims?.[0] ?? 0;
        const newHeight = newDims?.[1] ?? 0;
        const existingWidth = bestCandidate.width > 0 ? bestCandidate.width : 0;
        const existingHeight = bestCandidate.height > 0 ? bestCandidate.height : 0;
        matches.push({
          newAssetId: row.id,
          existingAssetId: bestCandidate.asset_id,
          distance: best.distance,
          newWidth,
          newHeight,
          existingWidth,
          existingHeight,
          clearer: newWidth * newHeight > existingWidth * existingHeight,
        });
      }
      return { pending, unchecked, identical, matches };
    },
    /** Lazily computes (and caches on the hash row) an asset's display-pixel
     * digest so "same perceptual hash" pairs can be confirmed byte-exact. */
    async storedPerceptualPixelDigest(projectId, row, hashRow) {
      if (hashRow.pixel_sha256 && hashRow.pixel_hash_version === PIXEL_HASH_VERSION) {
        return hashRow.pixel_sha256;
      }
      const digest = await safePixelDigest(row.original_path).catch(() => "");
      if (digest) {
        database.prepare("UPDATE asset_perceptual_hashes SET pixel_sha256 = ?, pixel_hash_version = ? WHERE project_id = ? AND asset_id = ?")
          .run(digest, PIXEL_HASH_VERSION, projectId, hashRow.asset_id);
      }
      return digest;
    },
    /** Cached display-pixel digest for an asset, "" when never lazily computed.
     * The import-resolve route forwards it to replaceAssetMedia so the sharper
     * replacement keeps the pixel identity the automatic-ingest dedupe uses. */
    async cachedPerceptualPixelDigest(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const row = database.prepare("SELECT pixel_sha256, pixel_hash_version FROM asset_perceptual_hashes WHERE project_id = ? AND asset_id = ?")
        .get(cleanProjectId, cleanAssetId);
      return row && row.pixel_hash_version === PIXEL_HASH_VERSION ? row.pixel_sha256 : "";
    },
    async perceptualPixelDigestsEqual(projectId, firstRow, firstHashRow, secondRow) {
      const secondHashRow = database.prepare(`
        SELECT asset_id, algorithm, hash, pixel_sha256, pixel_hash_version
        FROM asset_perceptual_hashes WHERE project_id = ? AND asset_id = ?
      `).get(projectId, secondRow.asset_id);
      if (!secondHashRow) return false;
      const [first, second] = await Promise.all([
        this.storedPerceptualPixelDigest(projectId, firstRow, firstHashRow),
        this.storedPerceptualPixelDigest(projectId, secondRow, secondHashRow),
      ]);
      return Boolean(first) && first === second;
    },
    /**
     * Server-side re-verification for /api/import/resolve actions (task 291
     * rework §6): the import review is UI, not authority. Every verdict here
     * reads live rows, so a pair that another window already trashed, or a
     * "sharper" claim that is actually smaller, is rejected with a specific
     * code and nothing in the library moves. Pixel-identical trash
     * re-confirms safePixelDigest equality (cache first, lazily computed
     * otherwise) because two simultaneous checks can each have seen the other
     * as "the library copy".
     */
    async verifyImportResolve(projectId, action) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const kind = String(action?.kind || "");
      const newAssetId = String(action?.newAssetId || "").trim();
      const existingAssetId = String(action?.existingAssetId || "").trim();
      if (!newAssetId || !existingAssetId) return { ok: false, code: "IMPORT_RESOLVE_INVALID" };
      if (newAssetId === existingAssetId) return { ok: false, code: "IMPORT_RESOLVE_SAME_ASSET" };
      const rows = database.prepare(`
        SELECT a.id, a.deleted_at, a.original_path, a.media_kind,
          COALESCE(CAST(json_extract(a.business_fields_json, '$.width') AS REAL), 0) AS width,
          COALESCE(CAST(json_extract(a.business_fields_json, '$.height') AS REAL), 0) AS height,
          h.hash AS perceptual_hash, h.pixel_sha256 AS cached_pixel, h.pixel_hash_version AS cached_pixel_version
        FROM assets a
        LEFT JOIN asset_perceptual_hashes h ON h.project_id = a.project_id AND h.asset_id = a.id
        WHERE a.project_id = ? AND a.id IN (?, ?)
      `).all(cleanProjectId, newAssetId, existingAssetId);
      const byId = new Map(rows.map((row) => [row.id, row]));
      const newAsset = byId.get(newAssetId);
      const existingAsset = byId.get(existingAssetId);
      if (!newAsset || !existingAsset) return { ok: false, code: "IMPORT_RESOLVE_ASSET_MISSING" };
      if (newAsset.deleted_at || existingAsset.deleted_at) return { ok: false, code: "IMPORT_RESOLVE_ASSET_TRASHED" };
      if (kind === "trash-new") {
        if (action.reason === "duplicate-import:identical") {
          if (newAsset.media_kind !== "image") return { ok: false, code: "IMPORT_RESOLVE_NOT_IMAGE" };
          const digestFor = async (assetRow) => {
            if (assetRow.cached_pixel && assetRow.cached_pixel_version === PIXEL_HASH_VERSION) {
              return assetRow.cached_pixel;
            }
            const digest = await safePixelDigest(assetRow.original_path).catch(() => "");
            if (digest) {
              database.prepare("UPDATE asset_perceptual_hashes SET pixel_sha256 = ?, pixel_hash_version = ? WHERE project_id = ? AND asset_id = ?")
                .run(digest, PIXEL_HASH_VERSION, cleanProjectId, assetRow.id);
            }
            return digest;
          };
          const [newDigest, existingDigest] = await Promise.all([digestFor(newAsset), digestFor(existingAsset)]);
          if (!newDigest || newDigest !== existingDigest) return { ok: false, code: "IMPORT_RESOLVE_PIXEL_MISMATCH" };
        }
        return { ok: true };
      }
      if (kind === "replace-with-new") {
        if (!(newAsset.width > 0 && newAsset.height > 0
          && newAsset.width * newAsset.height > existingAsset.width * existingAsset.height)) {
          return { ok: false, code: "IMPORT_RESOLVE_NOT_LARGER" };
        }
        if (!newAsset.perceptual_hash || !existingAsset.perceptual_hash) {
          return { ok: false, code: "IMPORT_RESOLVE_UNVERIFIED" };
        }
        const distance = perceptualHexDistance(newAsset.perceptual_hash, existingAsset.perceptual_hash);
        if (distance > SIMILAR_DISTANCE_THRESHOLD) return { ok: false, code: "IMPORT_RESOLVE_NOT_SIMILAR" };
        if (existingAsset.width > 0 && existingAsset.height > 0
          && Math.abs(Math.log((newAsset.width / newAsset.height) / (existingAsset.width / existingAsset.height))) > SIMILAR_RATIO_TOLERANCE) {
          return { ok: false, code: "IMPORT_RESOLVE_NOT_SIMILAR" };
        }
        return { ok: true };
      }
      return { ok: false, code: "IMPORT_RESOLVE_INVALID" };
    },
    /**
     * One-shot background backfill of perceptual hashes for images that already
     * lived in the library before task 291. Runs after the service is ready,
     * 200 assets per batch with an event-loop yield between batches, always
     * from the published 400px thumbnail (never the original). The sweep pages
     * strictly forward by (project_id, id) — an asset whose thumbnail cannot be
     * decoded is skipped without a hash row and never revisited, so a library
     * full of unreadable thumbnails still terminates and gets its done flag.
     * Assets without a thumbnail at all are skipped here too — their later
     * derivative run computes the hash the normal way. The library_meta flag
     * marks the sweep done, so a thumbnail that still has no hash row
     * afterwards counts as "never hashable" instead of keeping the import
     * review waiting forever.
     */
    startPerceptualHashBackfill() {
      if (perceptualBackfillStarted) return;
      perceptualBackfillStarted = true;
      if (database.prepare("SELECT value FROM library_meta WHERE key = 'perceptual-hash-backfilled'").get()) return;
      void (async () => {
        try {
          const page = database.prepare(`
            SELECT project_id, id, thumbnail_path
            FROM assets
            WHERE (project_id > @lastProject OR (project_id = @lastProject AND id > @lastId))
              AND deleted_at IS NULL AND thumbnail_path IS NOT NULL AND media_kind != 'video'
            ORDER BY project_id, id
            LIMIT @limit
          `);
          let lastProject = "";
          let lastId = "";
          for (;;) {
            const batch = page.all({ lastProject, lastId, limit: PERCEPTUAL_BACKFILL_BATCH });
            if (!batch.length) break;
            for (const row of batch) {
              let digest = "";
              try {
                digest = await computePerceptualHash(row.thumbnail_path);
              } catch {
                digest = "";
              }
              if (digest) {
                const parsed = parsePerceptualHash(digest);
                if (parsed) {
                  database.prepare(`
                    INSERT INTO asset_perceptual_hashes (project_id, asset_id, algorithm, hash, pixel_sha256, pixel_hash_version, computed_at)
                    VALUES (?, ?, ?, ?, '', '', ?)
                    ON CONFLICT(project_id, asset_id) DO NOTHING
                  `).run(row.project_id, row.id, parsed.algorithm, parsed.hash, now());
                }
              }
            }
            const last = batch[batch.length - 1];
            lastProject = last.project_id;
            lastId = last.id;
            await new Promise((resolve) => setImmediate(resolve));
          }
          database.prepare(`
            INSERT INTO library_meta (key, value, updated_at) VALUES ('perceptual-hash-backfilled', '1', ?)
            ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at
          `).run(now());
        } catch (error) {
          console.warn(`[MOSA] perceptual hash backfill failed: ${error?.message || error}`);
        }
      })();
    },
    /**
     * Background maintenance that used to sit on the open path (rule 27,
     * audit 261): the post-upgrade whole-library verification, the derived
     * column re-derivations that are not write-correctness-critical, the six
     * one-time repairs, and the one-time FTS trash-row cleanup. Called by the
     * runtime (mosa-runtime.mjs startDerivativeMaintenance) once the HTTP
     * service is listening; MCP, CLI and library-migration processes never
     * call it, so their opens stay repair-free. Every step keeps the
     * open-path error contract: a failure logs exactly one [MOSA] line,
     * writes no marker, and retries on the next open. Batched passes yield to
     * the event loop between batches so a large library never stalls a
     * serving process, and every batch is idempotent, so the App process and
     * a concurrent opener converge on the same result. Resolves when every
     * step has settled (used by the runtime to hold shutdown until the
     * current batch is done); the promise itself never rejects.
     */
    startDeferredMaintenance(options = {}) {
      const { signal = null } = options;
      // One live chain per store. A previous chain that was aborted by
      // shutdown does not satisfy a new caller: the new signal takes over and
      // the old chain winds down at its next between-batch check.
      if (deferredMaintenanceChain && deferredMaintenanceSignal && !deferredMaintenanceSignal.aborted) {
        return deferredMaintenanceChain;
      }
      deferredMaintenanceSignal = signal;
      const stopping = () => signal?.aborted === true;
      // Test-only knob for the SIGKILL-resume test; never set in production.
      // When unset, every pass falls back to its own default (rework 1 #7:
      // search-scope 100, the two disk-reading backfills 50, the rest 500).
      const envBatch = Number(process.env.MOSA_TEST_DEFERRED_MAINTENANCE_BATCH_SIZE) > 0
        ? Number(process.env.MOSA_TEST_DEFERRED_MAINTENANCE_BATCH_SIZE)
        : null;
      // Rework 1 #5: a pass that actually rewrote rows must invalidate this
      // connection's page/navigation/stack-node caches (same-connection
      // commits never bump PRAGMA data_version) and, once done, announce one
      // library-backfilled per touched project so open windows re-render.
      const announceBackfilled = (reason, collector, extra = {}) => {
        if (!collector.projects.size) return;
        invalidateFtsPageCache();
        commitLibraryChanges([...collector.projects].map((projectId) => ({
          projectId,
          kind: "library-backfilled",
          entityType: "asset",
          entityId: "",
          assetIds: [],
          detail: { reason, rowsChanged: collector.changed, ...extra },
        })));
      };
      const makeCollector = () => ({ changed: 0, projects: new Set() });
      deferredMaintenanceChain = (async () => {
        // Task 373: One-time archived-to-trash repair (its own library_meta marker).
        // Moves legacy archived assets into Trash (or back to the library if version
        // parent with active children) and unsets archived flag.
        // Runs first in the chain so a library with nothing to repair records
        // completion right away.
        if (stopping()) return;
        try {
          await repairArchivedAssetsToTrash(database, {
            store,
            commitLibraryChanges,
            invalidateFtsPageCache,
            signal,
          });
        } catch (error) {
          const code = error && typeof error.code === "string" ? `${error.code} ` : "";
          console.warn(`[MOSA] one-time archived-to-trash repair skipped; it retries on the next open: ${code}${error instanceof Error ? error.message : String(error)}`);
        }
        // 1. Post-upgrade whole-library verification (worker thread, read-only
        // connection). Runs when this open upgraded the schema, or when a
        // previous run was interrupted mid-check. A shutdown abort terminates
        // the worker; the record stays pending for the next open.
        if (stopping()) return;
        const maintenanceSpawnWorker = typeof options.spawnWorker === "function" ? options.spawnWorker : undefined;
        try {
          await runSchemaUpgradeVerify(database, {
            databasePath,
            targetVersion: CURRENT_SCHEMA_VERSION,
            backupPath: schemaUpgradeBackup?.created ? schemaUpgradeBackup.path : null,
            upgradeHappenedThisOpen: schemaUpgradeBackup?.created === true,
            signal,
            ...(maintenanceSpawnWorker ? { spawnWorker: maintenanceSpawnWorker } : {}),
          });
        } catch (error) {
          const code = error && typeof error.code === "string" ? `${error.code} ` : "";
          console.warn(`[MOSA] schema upgrade verify skipped; it retries on the next open: ${code}${error instanceof Error ? error.message : String(error)}`);
        }
        // 1b. Task 350: snapshot lifecycle. An ok verdict deletes every
        // non-kept snapshot (recording the deletion on the verify record); a
        // failed verdict keeps its snapshot, files it on the kept list and —
        // the first time — announces one library-backfilled so open windows
        // ask the notice endpoint and show the dialog without a restart; a
        // library upgraded before the record existed gets one legacy check.
        // Only maintenance-running processes (App, background capture) ever
        // reach this — MCP and CLI opens never delete anything.
        if (stopping()) return;
        try {
          await settleSchemaUpgradeBackupCleanup(database, {
            libraryDir,
            databasePath,
            signal,
            ...(maintenanceSpawnWorker ? { spawnWorker: maintenanceSpawnWorker } : {}),
            announce: ({ reason }) => {
              commitLibraryChanges([{
                projectId: DEFAULT_PROJECT_ID,
                kind: "library-backfilled",
                entityType: "asset",
                entityId: "",
                assetIds: [],
                detail: { reason, rowsChanged: 0 },
              }]);
            },
          });
        } catch (error) {
          const code = error && typeof error.code === "string" ? `${error.code} ` : "";
          console.warn(`[MOSA] schema backup cleanup skipped; it retries on the next open: ${code}${error instanceof Error ? error.message : String(error)}`);
        }
        // 2. Derived-column re-derivations, marker-gated, batched. These run
        // before the one-time repairs so the repairs see re-derived keys.
        const derivedOptions = envBatch ? { batchSize: envBatch, signal } : { signal };
        const createdAtEpochCollector = makeCollector();
        if (stopping()) return;
        try {
          await rederiveCreatedAtEpochBatched(database, {
            ...derivedOptions,
            onBatchResult: ({ changed, projects }) => {
              if (changed > 0) {
                createdAtEpochCollector.changed += changed;
                for (const projectId of projects) createdAtEpochCollector.projects.add(projectId);
                invalidateFtsPageCache();
              }
            },
          });
        } catch (error) {
          const code = error && typeof error.code === "string" ? `${error.code} ` : "";
          console.warn(`[MOSA] created_at_epoch rederivation skipped; it retries on the next open: ${code}${error instanceof Error ? error.message : String(error)}`);
        }
        announceBackfilled("derived:created_at_epoch", createdAtEpochCollector);
        const sortNameCollector = makeCollector();
        if (stopping()) return;
        try {
          await rederiveSortNameBatched(database, {
            ...derivedOptions,
            onBatchResult: ({ changed, projects }) => {
              if (changed > 0) {
                sortNameCollector.changed += changed;
                for (const projectId of projects) sortNameCollector.projects.add(projectId);
                invalidateFtsPageCache();
              }
            },
          });
        } catch (error) {
          const code = error && typeof error.code === "string" ? `${error.code} ` : "";
          console.warn(`[MOSA] sort_name rederivation skipped; it retries on the next open: ${code}${error instanceof Error ? error.message : String(error)}`);
        }
        announceBackfilled("derived:sort_name", sortNameCollector);
        const stackColumnsCollector = makeCollector();
        if (stopping()) return;
        try {
          await backfillStackSortColumnsBatched(database, {
            ...derivedOptions,
            onBatchResult: ({ changed, projects }) => {
              if (changed > 0) {
                stackColumnsCollector.changed += changed;
                for (const projectId of projects) stackColumnsCollector.projects.add(projectId);
                invalidateFtsPageCache();
              }
            },
          });
        } catch (error) {
          const code = error && typeof error.code === "string" ? `${error.code} ` : "";
          console.warn(`[MOSA] stack sort columns backfill skipped; it retries on the next open: ${code}${error instanceof Error ? error.message : String(error)}`);
        }
        announceBackfilled("derived:stack_sort_columns", stackColumnsCollector);
        const stackSortCollector = makeCollector();
        if (stopping()) return;
        try {
          await rederiveStackSortCreatedAtBatched(database, {
            ...derivedOptions,
            onBatchResult: ({ changed, projects }) => {
              if (changed > 0) {
                stackSortCollector.changed += changed;
                for (const projectId of projects) stackSortCollector.projects.add(projectId);
                invalidateFtsPageCache();
              }
            },
          });
        } catch (error) {
          const code = error && typeof error.code === "string" ? `${error.code} ` : "";
          console.warn(`[MOSA] stack sort_created_at rederivation skipped; it retries on the next open: ${code}${error instanceof Error ? error.message : String(error)}`);
        }
        announceBackfilled("derived:stack_sort_created_at", stackSortCollector);
        // 3. The six one-time repairs, in their original order (the capture
        // repair must precede the message backfill, which must precede the
        // cleared-prompt repair and the search-scope rebuild).
        if (stopping()) return;
        try {
          repairCaptureHistory(database, {
            commitLibraryChanges,
            syncRelationCandidates: syncSqliteGenerationRelationCandidates,
            loadMetadata: (row) => rowToAsset(database, row),
            searchableText,
            syncAssetFtsEntry: (projectId, assetId, searchText, deletedAt) => syncAssetFtsEntry(database, projectId, assetId, searchText, deletedAt),
            replaceAssetShortTerms: (projectId, assetId, oldSearchText, newSearchText, deletedAt) => replaceAssetShortTerms(database, projectId, assetId, oldSearchText, newSearchText, deletedAt),
          });
        } catch (error) {
          // Only the error code/message go to the log — never prompt or user-message
          // text from the rows this pass touches.
          const code = error && typeof error.code === "string" ? `${error.code} ` : "";
          console.warn(`[MOSA] one-time capture-history repair skipped; it retries on the next open: ${code}${error instanceof Error ? error.message : String(error)}`);
        }
        if (stopping()) return;
        try {
          backfillGenerationMessageIdsFromAssets(database, { commitLibraryChanges });
        } catch (error) {
          const code = error && typeof error.code === "string" ? `${error.code} ` : "";
          console.warn(`[MOSA] one-time generation message backfill skipped; it retries on the next open: ${code}${error instanceof Error ? error.message : String(error)}`);
        }
        if (stopping()) return;
        try {
          repairClearedCapturePrompts(database, { commitLibraryChanges });
        } catch (error) {
          const code = error && typeof error.code === "string" ? `${error.code} ` : "";
          console.warn(`[MOSA] one-time cleared-prompt repair skipped; it retries on the next open: ${code}${error instanceof Error ? error.message : String(error)}`);
        }
        if (stopping()) return;
        const searchScopeCollector = makeCollector();
        try {
          // The rebuild stays inside lib/asset-search-scope.mjs; the batched
          // driver there produces the same rows as the whole-table original.
          // Rework 1 #7: 100 rows per batch — each row's FTS delete is a full
          // scan until task 348, so the batch must stay small enough to keep
          // the event-loop stall bounded.
          let rebuildBatch = 0;
          const rebuildStats = await rebuildSearchScopeTextsBatched(database, searchScopeRebuildHelpers(database), {
            batchSize: envBatch ?? 100,
            signal,
            onBatchCommitted: (batchStats) => {
              if (batchStats?.rebuilt > 0) {
                searchScopeCollector.changed += batchStats.rebuilt;
                for (const projectId of batchStats.projects) searchScopeCollector.projects.add(projectId);
                invalidateFtsPageCache();
              }
              maybeKillTestProcessAfterBatch("search_scope", rebuildBatch += 1);
            },
          });
          if (rebuildStats.assetsRebuilt > 0) {
            // Counts and error codes only — never search text, prompts, user
            // messages or paths from the rows this pass touches.
            console.warn(`[MOSA] search_scope_v4: rebuilt search text for ${rebuildStats.assetsRebuilt} asset(s) (${rebuildStats.assetsUnchanged} already up to date).`);
          }
        } catch (error) {
          const code = error && typeof error.code === "string" ? `${error.code} ` : "";
          console.warn(`[MOSA] one-time search-scope rebuild skipped; it retries on the next open: ${code}${error instanceof Error ? error.message : String(error)}`);
        }
        announceBackfilled("search_scope_v4", searchScopeCollector);
        if (stopping()) return;
        const videoCollector = makeCollector();
        try {
          await backfillVideoMetadataFromFiles(database, { commitLibraryChanges }, {
            batchSize: envBatch ?? 50,
            signal,
            onRowsChanged: ({ changed, projects }) => {
              if (changed > 0) {
                videoCollector.changed += changed;
                for (const projectId of projects) videoCollector.projects.add(projectId);
                invalidateFtsPageCache();
              }
            },
          });
        } catch (error) {
          const code = error && typeof error.code === "string" ? `${error.code} ` : "";
          console.warn(`[MOSA] one-time video metadata backfill skipped; it retries on the next open: ${code}${error instanceof Error ? error.message : String(error)}`);
        }
        announceBackfilled("video_metadata_backfill_v1", videoCollector);
        if (stopping()) return;
        const fileBytesCollector = makeCollector();
        try {
          await backfillFileBytesFromFiles(database, { commitLibraryChanges }, {
            batchSize: envBatch ?? 50,
            signal,
            onRowsChanged: ({ changed, projects }) => {
              if (changed > 0) {
                fileBytesCollector.changed += changed;
                for (const projectId of projects) fileBytesCollector.projects.add(projectId);
                invalidateFtsPageCache();
              }
            },
          });
        } catch (error) {
          const code = error && typeof error.code === "string" ? `${error.code} ` : "";
          console.warn(`[MOSA] one-time file-bytes backfill skipped; it retries on the next open: ${code}${error instanceof Error ? error.message : String(error)}`);
        }
        announceBackfilled("file_bytes_backfill_v1", fileBytesCollector);
        // 4. One-time FTS trash-row cleanup (its own library_meta marker); it
        // changes FTS row counts, so this connection's search caches must go.
        if (stopping()) return;
        try {
          cleanupOrphanedTrashFtsRows(database, now());
          invalidateFtsPageCache();
        } catch (error) {
          const code = error && typeof error.code === "string" ? `${error.code} ` : "";
          console.warn(`[MOSA] one-time FTS trash-row cleanup skipped; it retries on the next open: ${code}${error instanceof Error ? error.message : String(error)}`);
        }
        // 5. Task 348: runtime FTS compaction — small merge steps (each yields
        // to the event loop) then one optimize, when the persisted rewrite
        // counter crossed its threshold or enough idle time passed.
        if (stopping()) return;
        try {
          await runFtsMergeMaintenance(database, { signal });
        } catch (error) {
          const code = error && typeof error.code === "string" ? `${error.code} ` : "";
          console.warn(`[MOSA] fts merge maintenance skipped; it retries when next due: ${code}${error instanceof Error ? error.message : String(error)}`);
        }
      })().catch((error) => {
        console.warn(`[MOSA] deferred maintenance failed; the affected passes retry on the next open: ${error instanceof Error ? error.message : String(error)}`);
      });
      return deferredMaintenanceChain;
    },
    /**
     * Task 350 (audit 5-2 #2): state for the post-upgrade-failure dialog.
     * Shows while the latest verify verdict is failed and the user has not
     * acknowledged it; the backup path, target version and check time feed
     * the dialog and its "reveal in Finder" button.
     */
    schemaUpgradeNoticeState() {
      const record = readSchemaUpgradeVerifyRecord(database);
      return {
        shouldShow: Boolean(record && record.status === "failed" && !record.noticeDismissedAt),
        backupPath: record?.backupPath ?? null,
        targetVersion: record?.targetVersion ?? null,
        checkedAt: record?.checkedAt ?? null,
      };
    },
    /** One-way "user saw the dialog" latch on the failed record. */
    acknowledgeSchemaUpgradeNotice() {
      return markSchemaUpgradeNoticeDismissed(database, new Date().toISOString());
    },
    async createAsset(input = {}, context = {}) {
      const projectId = await this.ensureProject(input.projectId || DEFAULT_PROJECT_ID);
      const { sourcePath, readablePath } = await resolveReadableImagePath(store, input.imagePath, context?.trustedSourceRoots,
        { excludeProjectRoot: context?.excludeProjectRoot === true, skipMediaSignature: context?.skipMediaSignature === true });
      const contentHash = await sha256File(readablePath);
      const claimedContentHash = normalizeHash(input.source?.content_sha256);
      let pixelHash = normalizeHash(input.source?.pixel_sha256);
      let pixelHashVersion = String(input.source?.pixel_hash_version || "").trim();
      let pixelIdentityRecomputed = false;
      const preflightPixelHash = context?.ingestMode === "automatic"
        && pixelHashVersion === PIXEL_HASH_VERSION
        && claimedContentHash !== contentHash
        ? ""
        : pixelHash;
      const preflightPixelHashVersion = preflightPixelHash ? pixelHashVersion : "";
      if (context?.ingestMode === "automatic") {
        const suppression = await this.findAutomaticIngestSuppression(projectId, {
          content_sha256: contentHash,
          pixel_sha256: preflightPixelHash,
          pixel_hash_version: preflightPixelHashVersion,
        });
        if (suppression) throw automaticImportSuppressedError();
        // Same-site identity list: a deleted capture also blocks the next
        // automatic arrival under the same provider identity even when the
        // bytes/pixels differ (a preview deleted, then the original arrives).
        const identityKey = automaticIngestIdentityKey(projectId, input);
        if (identityKey) {
          const identitySuppression = database.prepare(`
            SELECT 1
            FROM automatic_ingest_identity_suppressions
            WHERE project_id = ? AND logical_output_id = ? AND media_kind = ?
          `).get(projectId, identityKey, automaticIngestIdentityKind(mediaKindOf(input)));
          if (identitySuppression) throw automaticImportSuppressedError();
        }
      }
      // Drag/drop and paste imports (the two HTTP import routes only — web
      // capture's manual ingest keeps its old behavior) skip identical bytes
      // instead of storing a second copy. Trash does not count (re-import
      // after deleting stays possible); archived rows do. The lookup doubles
      // as the in-batch dedupe because the route imports items sequentially —
      // an earlier item of the same batch is already committed when the next
      // one lands here.
      if (context?.skipIdenticalBytes === true) {
        const duplicate = database.prepare(`
          SELECT id, group_name, archived FROM assets INDEXED BY assets_project_hash_idx
          WHERE project_id = ? AND content_sha256 = ? AND deleted_at IS NULL
          ORDER BY archived ASC, created_at DESC, id DESC
          LIMIT 1
        `).get(projectId, contentHash);
        if (duplicate) {
          const membership = database.prepare("SELECT stack_id FROM asset_stack_members WHERE project_id = ? AND asset_id = ?")
            .get(projectId, duplicate.id);
          const stackName = membership?.stack_id
            ? String(database.prepare("SELECT name FROM asset_stacks WHERE project_id = ? AND id = ?")
                .get(projectId, membership.stack_id)?.name || "")
            : "";
          throw manualImportDuplicateError({
            id: duplicate.id,
            groupName: String(duplicate.group_name || ""),
            stackId: membership?.stack_id || "",
            stackName,
            archived: Boolean(duplicate.archived),
          });
        }
      }
      const codexSource = await codexSourceMetadata(store, readablePath);
      const originalName = sanitizeFileName(input.asset || input.fileName || basename(sourcePath));
      const assetId = sanitizeId(input.assetId || `${slugName(originalName)}-${shortStamp()}`, "asset");
      const parentAssetId = normalizeParentAssetId(input.parent_asset_id ?? input.parentAssetId);
      const existing = database.prepare("SELECT id FROM assets WHERE project_id = ? AND id = ?").get(projectId, assetId);
      if (existing) throw assetAlreadyExistsError(assetId);
      assertSqliteVersionParent(database, projectId, assetId, parentAssetId);
      const versionChange = parentAssetId && !context?.allowMissingVersionChange
        ? requireVersionChange(input)
        : String(input.version_change ?? input.changeSummary ?? "").trim();
      // Task 382: non-ASCII names keep their readable stem in the stored file
      // name (`拖入-甲-<stamp>.png`); ASCII names keep `<id><ext>` exactly as
      // before. readableName is the search-scope view of the sanitized name
      // (machine tails from copies/versions removed); re-sanitizing re-applies
      // the 48-code-point cap before the stem is stripped back out.
      const imageExtension = extname(sourcePath) || extname(originalName) || ".png";
      const readableStem = assetFileNameStem(sanitizeFileName(searchableAssetName(originalName)));
      const imageName = hasNonAsciiStem(readableStem)
        ? `${readableStem}-${shortStamp()}${imageExtension}`
        : `${assetId}${imageExtension}`;
      const imagePath = join(this.imagesDir(projectId), imageName);
      let storageMode;
      try {
        storageMode = codexSource
          ? await hardLinkOrCopy(readablePath, imagePath)
          : (await copyFile(readablePath, imagePath, fsConstants.COPYFILE_EXCL), "copy");
      } catch (error) {
        if (error?.code === "EEXIST") throw assetAlreadyExistsError(assetId);
        // COPYFILE_EXCL fails atomically, but any other failure (disk full,
        // interrupted copy) can leave a partial managed file that would make
        // the next import of the same asset collide with bytes that were
        // never valid. Remove it before surfacing the error.
        await unlink(imagePath).catch(() => {});
        throw error;
      }
      const managedContentHash = await sha256File(imagePath);
      if (managedContentHash !== contentHash) {
        await unlink(imagePath).catch(() => {});
        const error = new Error("Source file changed while GravityPort was importing it.");
        error.code = "SOURCE_CHANGED_DURING_IMPORT";
        throw error;
      }
      if (context?.ingestMode === "automatic"
        && pixelHash
        && pixelHashVersion === PIXEL_HASH_VERSION
        && claimedContentHash !== contentHash) {
        pixelHash = await safePixelDigest(imagePath).catch(() => "");
        pixelHashVersion = pixelHash ? PIXEL_HASH_VERSION : "";
        pixelIdentityRecomputed = true;
      }
      const timestamp = now();
      // Imports hand the store a bare staged path with no business_fields, and
      // videos never reach the derivative worker that backfills image
      // dimensions, so width/height/duration_seconds must come from the file
      // itself. Only missing keys are filled; whatever the caller supplied
      // (web capture stores file-read values) stays untouched.
      const videoDimensionFields = await missingVideoDimensionFields(imagePath, input.business_fields);
      // Images get their ratio at insert (task 292): until derivatives land the
      // gallery would lay every new card out as a 1:1 box, and images beyond
      // the derivative pixel limit never get a write-back at all. The
      // dimension fill builds on the video fill, and file size builds on both,
      // so one import gains all three in a single write.
      const imageDimensionFields = await missingImageDimensionFields(imagePath, videoDimensionFields ?? input.business_fields);
      const fileBytesFields = await missingFileBytesField(imagePath, imageDimensionFields ?? videoDimensionFields ?? input.business_fields);
      const metadata = normalizeAssetMetadata({
        ...input,
        ...(fileBytesFields ? { business_fields: fileBytesFields } : {}),
        id: assetId,
        project_id: projectId,
        asset: imageName,
        image_path: imagePath,
        prompt_path: null,
        prompt: String(input.prompt || "").trim(),
        parent_asset_id: parentAssetId,
        version_change: versionChange,
        child_asset_ids: [],
        created_at: input.created_at || timestamp,
        updated_at: timestamp,
        source: {
          type: input.sourceType || (codexSource ? "codex-generated" : "local-file"),
          path: sourcePath,
          copied_at: timestamp,
          ...(codexSource || {}),
          ...(input.source && typeof input.source === "object" ? input.source : {}),
          ...(pixelIdentityRecomputed ? {
            pixel_sha256: pixelHash || null,
            pixel_hash_version: pixelHash ? pixelHashVersion : null,
          } : {}),
          content_sha256: contentHash,
          storage_mode: storageMode,
        },
      });
      try {
        const enqueueDerivative = !VIDEO_EXTENSIONS.has(extname(imagePath).toLowerCase());
        saveAsset(database, metadata, {
          enqueueDerivative,
          insertOnly: true,
          recipeSnapshot: buildRecipeSnapshot(metadata, {
            createdAt: metadata.created_at,
            changeSummary: versionChange || "Initial recipe",
          }),
          rejectAutomaticIngestSuppression: context?.ingestMode === "automatic"
            ? { content_sha256: contentHash, pixel_sha256: pixelHash, pixel_hash_version: pixelHashVersion }
            : null,
          rejectAutomaticIngestDuplicate: context?.ingestMode === "automatic"
            ? { content_sha256: contentHash, pixel_sha256: pixelHash, pixel_hash_version: pixelHashVersion }
            : null,
          clearAutomaticIngestSuppression: context?.ingestMode !== "automatic"
            ? { content_sha256: contentHash, pixel_sha256: pixelHash, pixel_hash_version: pixelHashVersion }
            : null,
          libraryChanges: [{ projectId, kind: "asset-added", entityType: "asset", entityId: assetId }],
        }, { commitLibraryChanges });
      } catch (error) {
        await unlink(imagePath).catch(() => {});
        if (isSqliteDuplicateError(error)) throw assetAlreadyExistsError(assetId);
        throw error;
      }
      invalidateFtsPageCache();
      // Same-session auto stacking is best-effort: the asset row is already
      // committed, so a stacking failure is logged and never fails the ingest.
      try {
        autoStackAssetAfterInsert(database, projectId, assetId, { commitLibraryChanges });
      } catch (error) {
        console.warn(`[MOSA] auto session stack skipped for ${assetId}: ${error?.message || error}`);
      }
      return rowToAsset(database, database.prepare("SELECT * FROM assets WHERE project_id = ? AND id = ?").get(projectId, assetId));
    },
    /**
     * `gravityport migrate` re-imports every legacy record from the JSON library file rather than the
     * Codex original, so a library that was hard-linked before migrating arrives here holding a
     * second copy of every Codex asset. This reclaims that space; new imports are already linked
     * by `createAsset`.
     */
    async migrateCodexAssetsToHardLinks(projectId = DEFAULT_PROJECT_ID) {
      return relinkCodexAssets(this, await this.ensureProject(projectId));
    },
    async updateMetadata(projectId, assetId, patch = {}) {
      assertMutableVersionPatch(patch);
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const update = database.transaction(() => {
        const row = database.prepare("SELECT * FROM assets WHERE project_id = ? AND id = ?").get(cleanProjectId, cleanAssetId);
        if (!row) throw assetNotFoundError(cleanAssetId);
        const current = rowToAsset(database, row);
        const metadata = normalizeAssetMetadata({
          ...current,
          ...patch,
          id: current.id,
          project_id: current.project_id,
          asset: current.asset,
          image_path: current.image_path,
          prompt_path: current.prompt_path,
          prompt: Object.hasOwn(patch, "prompt") ? String(patch.prompt || "").trim() : current.prompt,
          source: patch.source && typeof patch.source === "object" ? { ...current.source, ...patch.source } : current.source,
          business_fields: mergeBusinessFieldsPatch(current.business_fields, patch.business_fields),
          updated_at: now(),
        });
        const memberships = database.prepare(`
          SELECT stack_id, position FROM asset_stack_members
          WHERE project_id = ? AND asset_id = ?
        `).all(metadata.project_id, metadata.id);
        saveAsset(database, metadata, {
          enqueueDerivative: false,
          recipeSnapshot: buildRecipeSnapshot(metadata, {
            createdAt: metadata.updated_at,
            changeSummary: patch.recipe_change_summary || "Recipe updated",
          }),
          libraryChanges: [{ projectId: metadata.project_id, kind: "asset-updated", entityType: "asset", entityId: metadata.id, flags: Object.keys(patch) }],
        }, { commitLibraryChanges });
        // Rework 1 #3: a metadata edit can change created_at, and a non-cover
        // member's date shifts its stack's newest-member sort key. Stacks are
        // marker-gated now, so refresh every stack holding this asset AFTER
        // the row write (the refresh reads the new dates) — the cover-only
        // stack-updated record below does not reach them.
        for (const membership of memberships) {
          refreshStackSortCreatedAt(database, metadata.project_id, membership.stack_id);
        }
        const coverMembership = memberships.find((membership) => Number(membership.position) === 0);
        if (coverMembership) {
          syncAssetStackCoverSortName(database, metadata.project_id, coverMembership.stack_id, metadata.updated_at);
          commitLibraryChanges([{ projectId: metadata.project_id, kind: "stack-updated", entityType: "stack", entityId: coverMembership.stack_id, assetIds: [metadata.id] }]);
        }
        return metadata;
      });
      const metadata = update.immediate();
      invalidateFtsPageCache();
      return this.getAsset(metadata.project_id, metadata.id);
    },
    async updateCuration(projectId, assetId, input = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      database.transaction(() => {
        const row = database.prepare("SELECT * FROM assets WHERE project_id = ? AND id = ?").get(cleanProjectId, cleanAssetId);
        if (!row) throw assetNotFoundError(cleanAssetId);
        const timestamp = now();
        const metadataJson = parseJson(row.metadata_json, {});
        const curation = mergeAssetCuration(metadataJson, input);
        metadataJson.curated = curation.curated;
        metadataJson.curation_note = curation.curation_note;
        const current = rowToAsset(database, row, { includeRelations: false });
        const searchText = searchableText({ ...current, ...curation });
        database.prepare(`
          UPDATE assets SET metadata_json = ?, search_text = ?, updated_at = ?
          WHERE project_id = ? AND id = ?
        `).run(JSON.stringify(metadataJson), searchText, timestamp, cleanProjectId, cleanAssetId);
        syncAssetFtsEntry(database, cleanProjectId, cleanAssetId, searchText, row.deleted_at);
        replaceAssetShortTerms(database, cleanProjectId, cleanAssetId, row.search_text, searchText, row.deleted_at);
        commitLibraryChanges([{
          projectId: cleanProjectId,
          kind: "asset-updated",
          entityType: "asset",
          entityId: cleanAssetId,
          flags: ["curated", "curation_note"],
        }]);
      }).immediate();
      invalidateFtsPageCache();
      return this.getAsset(cleanProjectId, cleanAssetId);
    },
    /** Batch-reads persisted version-canvas state for a list of asset IDs. */
    async getAssetCanvasStates(projectId = DEFAULT_PROJECT_ID, assetIds = []) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const uniqueIds = normalizeCanvasAssetIds(assetIds, sanitizeId);
      const states = {};
      for (let offset = 0; offset < uniqueIds.length; offset += DERIVED_MAINTENANCE_BATCH_SIZE) {
        const chunk = uniqueIds.slice(offset, offset + DERIVED_MAINTENANCE_BATCH_SIZE);
        const placeholders = chunk.map(() => "?").join(", ");
        const rows = database.prepare(`
          SELECT asset_id, is_final, marks_json, pos_x, pos_y, updated_at
          FROM asset_canvas_state
          WHERE project_id = ? AND asset_id IN (${placeholders})
        `).all(cleanProjectId, ...chunk);
        for (const row of rows) {
          states[row.asset_id] = normalizeAssetCanvasState(row);
        }
      }
      return states;
    },
    /** Partially updates persisted version-canvas state for one asset (keeps omitted fields). */
    async updateAssetCanvasState(projectId, assetId, input = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const patch = validateCanvasStatePatch(input);
      return database.transaction(() => {
        const assetRow = database.prepare("SELECT id FROM assets WHERE project_id = ? AND id = ?").get(cleanProjectId, cleanAssetId);
        if (!assetRow) throw assetNotFoundError(cleanAssetId);
        const existing = database.prepare(`
          SELECT is_final, marks_json, pos_x, pos_y, updated_at
          FROM asset_canvas_state
          WHERE project_id = ? AND asset_id = ?
        `).get(cleanProjectId, cleanAssetId);
        const next = mergeAssetCanvasState(existing, patch, now());
        database.prepare(`
          INSERT INTO asset_canvas_state (project_id, asset_id, is_final, marks_json, pos_x, pos_y, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, asset_id) DO UPDATE SET
            is_final = excluded.is_final,
            marks_json = excluded.marks_json,
            pos_x = excluded.pos_x,
            pos_y = excluded.pos_y,
            updated_at = excluded.updated_at
        `).run(
          cleanProjectId,
          cleanAssetId,
          next.is_final ? 1 : 0,
          JSON.stringify(next.marks),
          next.pos_x,
          next.pos_y,
          next.updated_at,
        );
        return next;
      }).immediate();
    },
    /** Clears manual canvas coordinates for the given asset IDs while preserving final/marks. */
    async clearAssetCanvasPositions(projectId = DEFAULT_PROJECT_ID, assetIds = []) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const uniqueIds = normalizeCanvasAssetIds(assetIds, sanitizeId);
      if (!uniqueIds.length) return { cleared: 0 };
      const timestamp = now();
      return database.transaction(() => {
        let cleared = 0;
        for (let offset = 0; offset < uniqueIds.length; offset += DERIVED_MAINTENANCE_BATCH_SIZE) {
          const chunk = uniqueIds.slice(offset, offset + DERIVED_MAINTENANCE_BATCH_SIZE);
          const placeholders = chunk.map(() => "?").join(", ");
          const result = database.prepare(`
            UPDATE asset_canvas_state
            SET pos_x = NULL, pos_y = NULL, updated_at = ?
            WHERE project_id = ? AND asset_id IN (${placeholders}) AND (pos_x IS NOT NULL OR pos_y IS NOT NULL)
          `).run(timestamp, cleanProjectId, ...chunk);
          cleared += Number(result.changes || 0);
        }
        return { cleared };
      }).immediate();
    },
    /**
     * Batch "标为已整理" (task 304). Writes only metadata_json.curated and
     * never the curation note. Each result reports the flag before the write
     * (`previous_curated`) and whether the asset counted as organized before
     * it (`was_organized`), so an undo can put back only the assets this call
     * moved from unorganized to organized.
     */
    async setAssetsCurated(projectId, assetIds, curated) {
      const pid = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const ids = [...new Set((Array.isArray(assetIds) ? assetIds : []).map((id) => String(id || "").trim()).filter(Boolean))];
      if (!ids.length) throw assetStoreError("ASSET_IDS_REQUIRED", "assetIds must be a non-empty array.");
      const value = curated === true;
      const selectAsset = database.prepare("SELECT * FROM assets WHERE project_id = ? AND id = ?");
      const selectOrganized = database.prepare(`
        SELECT ${assetOrganizedSql("a")} AS organized FROM assets a WHERE a.project_id = ? AND a.id = ?
      `);
      const updateCurated = database.prepare(`
        UPDATE assets SET metadata_json = ?, search_text = ?, updated_at = ?
        WHERE project_id = ? AND id = ?
      `);
      const timestamp = now();

      const results = [];
      let failures = 0;
      database.transaction(() => {
        const changedIds = [];
        for (const assetId of ids) {
          const row = selectAsset.get(pid, assetId);
          if (!row) {
            failures += 1;
            results.push({ id: assetId, ok: false, code: "ASSET_NOT_FOUND", error: `Asset not found: ${assetId}` });
            continue;
          }
          const metadataJson = parseJson(row.metadata_json, {});
          const previous = [true, 1, "true"].includes(metadataJson.curated);
          const wasOrganized = Boolean(selectOrganized.get(pid, assetId)?.organized);
          results.push({ id: assetId, curated: value, previous_curated: previous, was_organized: wasOrganized });
          if (previous === value) continue;
          metadataJson.curated = value;
          const current = rowToAsset(database, row, { includeRelations: false });
          const searchText = searchableText({ ...current, curated: value, curation_note: String(metadataJson.curation_note ?? "") });
          updateCurated.run(JSON.stringify(metadataJson), searchText, timestamp, pid, assetId);
          syncAssetFtsEntry(database, pid, assetId, searchText, row.deleted_at);
          replaceAssetShortTerms(database, pid, assetId, row.search_text, searchText, row.deleted_at);
          changedIds.push(assetId);
        }
        if (changedIds.length) {
          commitLibraryChanges([{
            projectId: pid,
            kind: "assets-updated",
            entityType: "asset-batch",
            entityId: "curation",
            assetIds: changedIds,
            flags: ["curated"],
          }]);
        }
      }).immediate();
      invalidateFtsPageCache();
      return { results, partial: failures > 0 };
    },
    /**
     * Swap an asset's media for new bytes. The replaced original and its three
     * derivatives move (rename, never unlink) onto an independent trashed
     * snapshot asset, so "same provider id arrived again" can never destroy
     * the previous pixels: they stay restorable in Trash for the normal
     * retention window. Prompts never pass through here — the ingest layer
     * owns prompt upgrades via maybeUpgradePrompt — and empty incoming values
     * must not erase non-empty stored ones.
     */
    async replaceAssetMedia(projectId, assetId, input = {}, context = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const { sourcePath, readablePath } = await resolveReadableImagePath(
        store,
        input.imagePath || input.mediaPath,
        context?.trustedSourceRoots,
      );
      return this.withAssetLifecycleLock(cleanProjectId, cleanAssetId, async () => {
        const row = database.prepare("SELECT * FROM assets WHERE project_id = ? AND id = ?").get(cleanProjectId, cleanAssetId);
        if (!row) throw assetNotFoundError(cleanAssetId);
        if (row.deleted_at) throw assetStoreError("ASSET_TRASHED", "Cannot replace media for a trashed asset.");

        const current = rowToAsset(database, row, { includeRelations: false });
        const extension = extname(sourcePath) || extname(String(input.fileName || "")) || extname(row.asset) || ".png";
        // Task 382: non-ASCII assets keep their readable stem across media
        // replacements; ASCII assets keep `<id>-<stamp>-<random>` unchanged.
        const replaceStem = assetFileNameStem(sanitizeFileName(searchableAssetName(row.asset)));
        const nextName = hasNonAsciiStem(replaceStem)
          ? `${replaceStem}-${shortStamp()}-${randomUUID().slice(0, 8)}${extension}`
          : `${cleanAssetId}-${shortStamp()}-${randomUUID().slice(0, 8)}${extension}`;
        const nextPath = join(this.imagesDir(cleanProjectId), nextName);
        await copyFile(readablePath, nextPath, fsConstants.COPYFILE_EXCL);
        const contentHash = await sha256File(nextPath);
        const claimedHash = normalizeHash(input.content_sha256 || input.contentHash);
        if (claimedHash && claimedHash !== contentHash) {
          await unlink(nextPath).catch(() => {});
          throw assetStoreError("SOURCE_CHANGED_DURING_IMPORT", "Replacement media changed while GravityPort was importing it.");
        }
        const pixelHash = normalizeHash(input.pixel_sha256 || input.pixelHash);
        const timestamp = now();
        // Rework 1 #6: the replacement merge moved INSIDE the write
        // transaction below. The file copy, hashing and snapshot staging above
        // are async, and a background repair pass can fix a field on this row
        // in that window — its marker already says "done", so a stale
        // overwrite would never be repaired. The merge therefore re-reads the
        // row under the write lock and only the replacement's own fields are
        // written on top of the fresh values.
        const snapshot = await stageReplacedMediaSnapshot(database, store, cleanProjectId, row, current, { timestamp, cleanAssetId });
        // Test-only hook (task 347 rework 1): holds the replace between the
        // row read and the write transaction so a test can run a repair-like
        // write in that window. Never set outside tests.
        if (Number(process.env.MOSA_TEST_REPLACE_MEDIA_STALL_MS) > 0) {
          await new Promise((resolve) => setTimeout(resolve, Number(process.env.MOSA_TEST_REPLACE_MEDIA_STALL_MS)));
        }
        try {
          database.transaction(() => {
            const freshRow = database.prepare("SELECT * FROM assets WHERE project_id = ? AND id = ?").get(cleanProjectId, cleanAssetId);
            if (!freshRow) throw assetNotFoundError(cleanAssetId);
            const fresh = rowToAsset(database, freshRow, { includeRelations: false });
            const businessFields = mergeReplacementObject(fresh.business_fields, input.business_fields);
            const source = mergeReplacementObject(fresh.source, input.source);
            source.content_sha256 = contentHash;
            source.pixel_sha256 = pixelHash || null;
            source.pixel_hash_version = pixelHash ? String(input.pixel_hash_version || input.pixelHashVersion || PIXEL_HASH_VERSION) : null;
            source.storage_mode = "copy";
            source.copied_at = timestamp;
            const metadata = normalizeAssetMetadata({
              ...fresh,
              id: cleanAssetId,
              project_id: cleanProjectId,
              asset: nextName,
              image_path: nextPath,
              business_fields: businessFields,
              source,
              updated_at: timestamp,
            });
            const searchText = searchableText(metadata);
            const businessSearchText = searchableBusinessObjectText(metadata.business_fields);
            const sourceSearchText = searchableSourceObjectText(metadata.source || {}, canonicalSourceTypeOf(metadata));
            const mediaKind = mediaKindOf(metadata);
            database.prepare(`
              UPDATE assets SET
                asset = ?, original_path = ?, preview_path = NULL, medium_path = NULL, thumbnail_path = NULL,
                content_sha256 = ?, pixel_sha256 = ?, prompt = ?, business_fields_json = ?, source_json = ?,
                search_text = ?, business_search_text = ?, source_search_text = ?, media_kind = ?,
                conversation_id = ?, generation_batch = ?, updated_at = ?
              WHERE project_id = ? AND id = ?
            `).run(
              nextName, nextPath, contentHash, pixelHash, metadata.prompt,
              JSON.stringify(metadata.business_fields || {}), JSON.stringify(metadata.source || {}),
              searchText, businessSearchText, sourceSearchText, mediaKind,
              String(metadata.source?.conversation_id || ""), String(metadata.source?.message_id || ""), timestamp,
              cleanProjectId, cleanAssetId,
            );
            saveAsset(database, snapshot.metadata, {
              enqueueDerivative: false,
              insertOnly: true,
              libraryChanges: [],
            }, { commitLibraryChanges });
            database.prepare(`
              UPDATE assets SET preview_path = ?, medium_path = ?, thumbnail_path = ?, deleted_at = ?, updated_at = ?
              WHERE project_id = ? AND id = ?
            `).run(
              snapshot.derivativePaths.preview, snapshot.derivativePaths.medium, snapshot.derivativePaths.thumbnail,
              timestamp, timestamp, cleanProjectId, snapshot.id,
            );
            syncAssetFtsEntry(database, cleanProjectId, snapshot.id, snapshot.searchText, timestamp);
            // The snapshot was trashed by the UPDATE above; its short-term rows
            // (saveAsset wrote them while the row was still live) go with it.
            replaceAssetShortTerms(database, cleanProjectId, snapshot.id, snapshot.searchText, "", timestamp);
            database.prepare("DELETE FROM derivative_jobs WHERE project_id = ? AND asset_id = ?").run(cleanProjectId, cleanAssetId);
            // The stored perceptual hash (and its lazily computed pixel digest)
            // describe the replaced pixels; the fresh derivatives recompute it.
            database.prepare("DELETE FROM asset_perceptual_hashes WHERE project_id = ? AND asset_id = ?").run(cleanProjectId, cleanAssetId);
            if (mediaKind !== "video") database.prepare(`
              INSERT INTO derivative_jobs (project_id, asset_id, status, attempts, created_at, updated_at)
              VALUES (?, ?, 'pending', 0, ?, ?)
              ON CONFLICT(project_id, asset_id) DO UPDATE SET status = 'pending', attempts = 0, error = NULL, updated_at = excluded.updated_at
            `).run(cleanProjectId, cleanAssetId, timestamp, timestamp);
            syncAssetFtsEntry(database, cleanProjectId, cleanAssetId, searchText, freshRow.deleted_at);
            replaceAssetShortTerms(database, cleanProjectId, cleanAssetId, freshRow.search_text, searchText, freshRow.deleted_at);
            commitLibraryChanges([{ projectId: cleanProjectId, kind: "asset-updated", entityType: "asset", entityId: cleanAssetId, flags: ["media"] }]);
          })();
        } catch (error) {
          await snapshot.rollback().catch(() => {});
          await unlink(nextPath).catch(() => {});
          throw error;
        }
        invalidateFtsPageCache();
        return this.getAsset(cleanProjectId, cleanAssetId);
      });
    },
    async toggleFavorite(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      // Keep favorite as a lightweight presentation preference rather than a
      // recipe edit: one SQL statement makes the read/flip/write atomic, while
      // deliberately leaving updated_at untouched prevents background polling
      // from treating a star click as a full-card content change.
      const row = database.transaction(() => {
        const updated = database.prepare(`
          UPDATE assets
          SET favorite = CASE WHEN favorite = 1 THEN 0 ELSE 1 END
          WHERE project_id = ? AND id = ?
          RETURNING *
        `).get(cleanProjectId, cleanAssetId);
        if (!updated) throw assetNotFoundError(cleanAssetId);
        commitLibraryChanges([{
          projectId: cleanProjectId,
          kind: "asset-updated",
          entityType: "asset",
          entityId: cleanAssetId,
          flags: ["favorite"],
          detail: { favorite: Boolean(updated.favorite) },
        }]);
        return updated;
      })();
      // Cached FTS pages carry the row's favorite value and may also be scoped
      // to Favorites, so membership/state must be invalidated even though the
      // searchable document itself did not change.
      invalidateFtsPageCache();
      return rowToAsset(database, row);
    },
    async archiveAsset(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const current = await this.getAsset(cleanProjectId, cleanAssetId);
      const membership = database.prepare("SELECT stack_id FROM asset_stack_members WHERE project_id = ? AND asset_id = ?").get(cleanProjectId, cleanAssetId);
      const metadata = normalizeAssetMetadata({
        ...current,
        archived: true,
        id: current.id,
        project_id: current.project_id,
        asset: current.asset,
        image_path: current.image_path,
        prompt_path: current.prompt_path,
        source: current.source,
        updated_at: now(),
      });
      database.transaction(() => {
        saveAsset(database, metadata, {
          enqueueDerivative: false,
          recipeSnapshot: buildRecipeSnapshot(metadata, {
            createdAt: metadata.updated_at,
            changeSummary: "Recipe updated",
          }),
          libraryChanges: [{ projectId: cleanProjectId, kind: "asset-archived", entityType: "asset", entityId: cleanAssetId }],
        }, { commitLibraryChanges });
        if (membership) {
          database.prepare("DELETE FROM asset_stack_members WHERE project_id = ? AND asset_id = ?").run(cleanProjectId, cleanAssetId);
          const compact = compactAssetStack(database, cleanProjectId, membership.stack_id);
          commitLibraryChanges([{
            projectId: cleanProjectId,
            kind: compact.dissolved ? "stack-dissolved" : "stack-members-changed",
            entityType: "stack",
            entityId: membership.stack_id,
            assetIds: compact.dissolved ? [cleanAssetId, compact.remainingAssetId].filter(Boolean) : [cleanAssetId],
          }]);
        }
      })();
      invalidateFtsPageCache();
      return this.getAsset(cleanProjectId, cleanAssetId);
    },
    /**
     * Task 385 16a — the "user refused this provider's deletion" mark, stored
     * inside the asset's own source (no schema change). Deliberately silent:
     * updated_at stays, no recipe snapshot, no search-text rebuild, no library
     * change record — an internal marker the user never sees must not refresh
     * the gallery or the "recently updated" order. Only the provider deletion
     * sync reads it.
     */
    async markProviderDeletionKept(projectId, assetId, { provider, itemId } = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const cleanProvider = String(provider || "").trim().toLowerCase();
      const cleanItemId = String(itemId || "").trim();
      if (!cleanProvider || !cleanItemId) {
        throw assetStoreError("PROVIDER_DELETION_KEEP_INVALID", "markProviderDeletionKept needs a provider and an itemId.");
      }
      return this.withAssetLifecycleLock(cleanProjectId, cleanAssetId, async () => {
        const row = database.prepare("SELECT id FROM assets WHERE project_id = ? AND id = ?").get(cleanProjectId, cleanAssetId);
        if (!row) throw assetNotFoundError(cleanAssetId);
        database.prepare(`
          UPDATE assets SET source_json = json_set(COALESCE(source_json, '{}'), '$.provider_deletion_keep', json(?))
          WHERE project_id = ? AND id = ?
        `).run(
          JSON.stringify({ provider: cleanProvider, item_id: cleanItemId, refused_at: new Date().toISOString() }),
          cleanProjectId,
          cleanAssetId,
        );
        return this.getAsset(cleanProjectId, cleanAssetId);
      });
    },
    /**
     * `context.reason` (string code) records why an asset landed in Trash as
     * `metadata_json.trash_reason = { code, at }`; restoreAsset clears it.
     * Callers that pass no reason keep the exact previous behavior.
     */
    async deleteAsset(projectId, assetId, context = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const trashReasonCode = String(context?.reason || "").trim().slice(0, 120);
      return this.withAssetLifecycleLock(cleanProjectId, cleanAssetId, async () => {
        const row = database.prepare("SELECT * FROM assets WHERE project_id = ? AND id = ?").get(cleanProjectId, cleanAssetId);
        if (!row) throw assetNotFoundError(cleanAssetId);
        if (!row.deleted_at) {
          const child = database.prepare(`
            SELECT id FROM assets
            WHERE project_id = ? AND parent_asset_id = ? AND deleted_at IS NULL
            LIMIT 1
          `).get(cleanProjectId, cleanAssetId);
          if (child) {
            throw assetStoreError(
              "VERSION_PARENT_HAS_CHILDREN",
              `Cannot move version parent ${cleanAssetId} to Trash; active child ${child.id} still depends on it.`,
            );
          }
        }
        const asset = rowToAsset(database, row, { includeRelations: false });
        const files = [row.original_path, row.preview_path, row.medium_path, row.thumbnail_path].filter(Boolean);
        const { contentHash, pixelHash, pixelHashVersion } = await automaticSuppressionIdentityForAsset(asset, files);
        const deletedAt = row.deleted_at || now();
        const stackMembership = database.prepare("SELECT stack_id FROM asset_stack_members WHERE project_id = ? AND asset_id = ?")
          .get(cleanProjectId, cleanAssetId);
        database.transaction(() => {
          if (contentHash || pixelHash) {
            database.prepare(`
              INSERT INTO automatic_ingest_suppressions (project_id, content_sha256, pixel_sha256, pixel_hash_version, deleted_at, reason)
              VALUES (?, ?, ?, ?, ?, 'user-deleted')
              ON CONFLICT(project_id, content_sha256, pixel_sha256, pixel_hash_version) DO UPDATE SET
                deleted_at = excluded.deleted_at,
                reason = excluded.reason
            `).run(cleanProjectId, contentHash, pixelHash, pixelHashVersion, deletedAt);
          }
          // A media-replacement snapshot carries no provider identity and its
          // trash reason marks the swap: the id lives on in the asset that
          // replaced it, so recording the identity here would suppress future
          // arrivals of the survivor's own id.
          const replacedSnapshot = String(asset.trash_reason?.code || "") === REPLACED_MEDIA_TRASH_REASON
            || trashReasonCode === REPLACED_MEDIA_TRASH_REASON;
          if (!replacedSnapshot) recordIdentitySuppressionRow(database, cleanProjectId, asset, { deletedAt });
          if (!row.deleted_at) {
            database.prepare("DELETE FROM derivative_jobs WHERE project_id = ? AND asset_id = ?").run(cleanProjectId, cleanAssetId);
            // Task 348: moving to Trash drops both the FTS row (by doc-id
            // rowid, one probe) and the short-term rows.
            deleteAssetFtsEntry(database, cleanProjectId, cleanAssetId);
            dropAssetSearchTerms(database, cleanProjectId, cleanAssetId, row.search_text);
            if (trashReasonCode) {
              const metadataJson = parseJson(row.metadata_json, {});
              metadataJson.trash_reason = { code: trashReasonCode, at: deletedAt };
              database.prepare("UPDATE assets SET deleted_at = ?, updated_at = ?, metadata_json = ? WHERE project_id = ? AND id = ?")
                .run(deletedAt, deletedAt, JSON.stringify(metadataJson), cleanProjectId, cleanAssetId);
            } else {
              database.prepare("UPDATE assets SET deleted_at = ?, updated_at = ? WHERE project_id = ? AND id = ?")
                .run(deletedAt, deletedAt, cleanProjectId, cleanAssetId);
            }
          }
          if (stackMembership) syncAssetStackCoverSortName(database, cleanProjectId, stackMembership.stack_id, deletedAt);
          if (!row.deleted_at) {
            const changeRecords = [{ projectId: cleanProjectId, kind: "asset-deleted", entityType: "asset", entityId: cleanAssetId }];
            if (stackMembership) {
              changeRecords.push({ projectId: cleanProjectId, kind: "stack-members-changed", entityType: "stack", entityId: stackMembership.stack_id, assetIds: [cleanAssetId] });
            }
            commitLibraryChanges(changeRecords);
          } else {
            commitLibraryChanges([{ projectId: cleanProjectId, kind: "asset-updated", entityType: "asset", entityId: cleanAssetId, flags: ["trash"] }]);
          }
        })();
        invalidateFtsPageCache();
        return { id: cleanAssetId, project_id: cleanProjectId, deleted: true, trashed: true, deleted_at: deletedAt };
      });
    },
    async restoreAsset(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      return this.withAssetLifecycleLock(cleanProjectId, cleanAssetId, async () => {
        const row = database.prepare("SELECT * FROM assets WHERE project_id = ? AND id = ?").get(cleanProjectId, cleanAssetId);
        if (!row) throw assetNotFoundError(cleanAssetId);
        if (!row.deleted_at) return rowToAsset(database, row);
        const asset = rowToAsset(database, row, { includeRelations: false });
        const files = [row.original_path, row.preview_path, row.medium_path, row.thumbnail_path].filter(Boolean);
        const { contentHash, pixelHash, pixelHashVersion } = await automaticSuppressionIdentityForAsset(asset, files);
        const timestamp = now();
        const stackMembership = database.prepare("SELECT stack_id FROM asset_stack_members WHERE project_id = ? AND asset_id = ?")
          .get(cleanProjectId, cleanAssetId);
        const restoredMetadataJson = parseJson(row.metadata_json, {});
        delete restoredMetadataJson.trash_reason;
        database.transaction(() => {
          if (row.group_name) database.prepare("INSERT OR IGNORE INTO groups (project_id, name, created_at) VALUES (?, ?, ?)")
            .run(cleanProjectId, row.group_name, timestamp);
          if (contentHash || pixelHash) {
            database.prepare(`
              DELETE FROM automatic_ingest_suppressions
              WHERE project_id = ? AND content_sha256 = ? AND pixel_sha256 = ? AND pixel_hash_version = ?
            `).run(cleanProjectId, contentHash, pixelHash, pixelHashVersion);
          }
          // Restoring the asset re-admits its provider identity: the same id
          // arriving again must take the upgrade/observe path, not the
          // deleted-suppression one.
          clearIdentitySuppressionRow(database, cleanProjectId, asset);
          database.prepare("UPDATE assets SET deleted_at = NULL, updated_at = ?, metadata_json = ? WHERE project_id = ? AND id = ?")
            .run(timestamp, JSON.stringify(restoredMetadataJson), cleanProjectId, cleanAssetId);
          // The UPDATE above cleared deleted_at, so this re-indexes unconditionally.
          // Task 348: restoring also rebuilds the short-term rows (trash dropped
          // them), from the same stored search_text the FTS row is rebuilt from.
          syncAssetFtsEntry(database, cleanProjectId, cleanAssetId, row.search_text, null);
          replaceAssetShortTerms(database, cleanProjectId, cleanAssetId, "", row.search_text, null);
          if (mediaKindOf(rowToAsset(database, row, { includeRelations: false })) !== "video") database.prepare(`
            INSERT INTO derivative_jobs (project_id, asset_id, status, attempts, created_at, updated_at)
            VALUES (?, ?, 'pending', 0, ?, ?)
            ON CONFLICT(project_id, asset_id) DO UPDATE SET status = 'pending', error = NULL, updated_at = excluded.updated_at
          `).run(cleanProjectId, cleanAssetId, timestamp, timestamp);
          if (stackMembership) syncAssetStackCoverSortName(database, cleanProjectId, stackMembership.stack_id, timestamp);
          {
            const changeRecords = [{ projectId: cleanProjectId, kind: "asset-restored", entityType: "asset", entityId: cleanAssetId }];
            if (stackMembership) {
              changeRecords.push({ projectId: cleanProjectId, kind: "stack-members-changed", entityType: "stack", entityId: stackMembership.stack_id, assetIds: [cleanAssetId] });
            }
            commitLibraryChanges(changeRecords);
          }
        })();
        invalidateFtsPageCache();
        return this.getAsset(cleanProjectId, cleanAssetId);
      });
    },
    async permanentlyDeleteAsset(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      return this.withAssetLifecycleLock(cleanProjectId, cleanAssetId, async () => {
        const row = database.prepare("SELECT * FROM assets WHERE project_id = ? AND id = ?").get(cleanProjectId, cleanAssetId);
        if (!row) return { id: cleanAssetId, project_id: cleanProjectId, deleted: true, permanent: true };
        if (!row.deleted_at) throw assetStoreError("ASSET_NOT_TRASHED", "Only trashed assets can be permanently deleted.");
        const child = database.prepare(`
          SELECT id FROM assets
          WHERE project_id = ? AND parent_asset_id = ?
          LIMIT 1
        `).get(cleanProjectId, cleanAssetId);
        if (child) {
          throw assetStoreError(
            "VERSION_PARENT_HAS_CHILDREN",
            `Cannot permanently delete version parent ${cleanAssetId}; active child ${child.id} still depends on it.`,
          );
        }
        const asset = rowToAsset(database, row, { includeRelations: false });
        const files = [row.original_path, row.preview_path, row.medium_path, row.thumbnail_path].filter(Boolean);
        const contentHash = normalizeHash(row.content_sha256) || await contentHashForAsset(asset, files);
        const pixelHash = normalizeHash(row.pixel_sha256) || normalizeHash(asset.source?.pixel_sha256);
        const pixelHashVersion = pixelHash ? String(asset.source?.pixel_hash_version || PIXEL_HASH_VERSION) : "";
        let staged;
        try {
          staged = await stageFilesForPermanentDeletion(this.projectDir(cleanProjectId), files);
        } catch (error) {
          throw assetStoreError("ASSET_FILE_BUSY", `Asset files are still in use: ${error?.message || error}`);
        }
        const stackMembership = database.prepare("SELECT stack_id FROM asset_stack_members WHERE project_id = ? AND asset_id = ?")
          .get(cleanProjectId, cleanAssetId);
        try {
          database.transaction(() => {
            const changeRecords = [{ projectId: cleanProjectId, kind: "asset-permanently-deleted", entityType: "asset", entityId: cleanAssetId }];
            database.prepare("DELETE FROM asset_tags WHERE project_id = ? AND asset_id = ?").run(cleanProjectId, cleanAssetId);
            database.prepare("DELETE FROM asset_versions WHERE project_id = ? AND asset_id = ?").run(cleanProjectId, cleanAssetId);
            database.prepare("DELETE FROM asset_versions WHERE project_id = ? AND parent_asset_id = ?").run(cleanProjectId, cleanAssetId);
            database.prepare("DELETE FROM derivative_jobs WHERE project_id = ? AND asset_id = ?").run(cleanProjectId, cleanAssetId);
            // Task 348: trash already removed the FTS and short-term rows, so
            // the old per-asset scan-delete is gone; what is left is the doc
            // mapping row (plus a free rowid probe that is a no-op for a
            // trashed asset and does the work for a live one on the legacy
            // hard-delete path).
            purgeAssetSearchIndex(database, cleanProjectId, cleanAssetId, row.search_text);
            database.prepare("DELETE FROM asset_perceptual_hashes WHERE project_id = ? AND asset_id = ?").run(cleanProjectId, cleanAssetId);
            // auto_stack_exclusions has no foreign key by design (the marker
            // must survive ordinary edits), so permanent delete clears it
            // explicitly — otherwise re-importing the same content-derived id
            // inherits an exclusion the user never chose for it.
            database.prepare("DELETE FROM auto_stack_exclusions WHERE project_id = ? AND asset_id = ?").run(cleanProjectId, cleanAssetId);
            database.prepare("DELETE FROM asset_canvas_state WHERE project_id = ? AND asset_id = ?").run(cleanProjectId, cleanAssetId);
            database.prepare("DELETE FROM assets WHERE project_id = ? AND id = ?").run(cleanProjectId, cleanAssetId);
            if (stackMembership) {
              // Task 416 (audit 低1 ③): the asset row's deletion cascades its
              // own membership row; whatever is left follows the same
              // compaction rule as stack_remove_assets — a stack with fewer
              // than two member rows dissolves and its survivor's row
              // cascades away, so a permanent delete can no longer strand a
              // single-member stack.
              const compact = compactAssetStack(database, cleanProjectId, stackMembership.stack_id);
              changeRecords.push({
                projectId: cleanProjectId,
                kind: compact.dissolved ? "stack-dissolved" : "stack-members-changed",
                entityType: "stack",
                entityId: stackMembership.stack_id,
                assetIds: compact.dissolved ? [cleanAssetId, compact.remainingAssetId].filter(Boolean) : [cleanAssetId],
              });
            }
            if (contentHash || pixelHash) {
              database.prepare(`
                INSERT INTO automatic_ingest_suppressions (project_id, content_sha256, pixel_sha256, pixel_hash_version, deleted_at, reason)
                VALUES (?, ?, ?, ?, ?, 'user-deleted')
                ON CONFLICT(project_id, content_sha256, pixel_sha256, pixel_hash_version) DO UPDATE SET
                  deleted_at = excluded.deleted_at,
                  reason = excluded.reason
              `).run(cleanProjectId, contentHash, pixelHash, pixelHashVersion, now());
            }
            // A media-replacement snapshot (trash reason replaced-by-better-
            // version, identity already cleared) is the losing side of a swap
            // whose id still lives on the surviving asset: its permanent
            // deletion — by hand or through the 90-day sweep — must not write
            // the identity list, or the survivor's own future arrivals would
            // be suppressed.
            if (String(asset.trash_reason?.code || "") !== REPLACED_MEDIA_TRASH_REASON) {
              recordIdentitySuppressionRow(database, cleanProjectId, asset, { deletedAt: now() });
            }
            commitLibraryChanges(changeRecords);
          })();
        } catch (error) {
          await staged.rollback();
          throw error;
        }
        const cleanupComplete = await staged.commit();
        invalidateFtsPageCache();
        return { id: cleanAssetId, project_id: cleanProjectId, deleted: true, permanent: true, cleanupPending: !cleanupComplete };
      });
    },
    async purgeExpiredTrash({ nowMs = Date.now(), retentionMs = TRASH_RETENTION_MS, cursor = null, limit = 500 } = {}) {
      const cutoff = new Date(nowMs - Math.max(0, Number(retentionMs) || TRASH_RETENTION_MS)).toISOString();
      const batchLimit = Math.max(1, Math.min(1000, Number(limit) || 500));
      const cursorDeletedAt = String(cursor?.deleted_at || "");
      const cursorProjectId = String(cursor?.project_id || "");
      const cursorId = String(cursor?.id || "");
      const rows = cursorDeletedAt
        ? database.prepare(`
          SELECT project_id, id, deleted_at FROM assets
          WHERE deleted_at IS NOT NULL AND deleted_at <= ?
            AND (
              deleted_at > ?
              OR (deleted_at = ? AND project_id > ?)
              OR (deleted_at = ? AND project_id = ? AND id > ?)
            )
          ORDER BY deleted_at, project_id, id LIMIT ?
        `).all(cutoff, cursorDeletedAt, cursorDeletedAt, cursorProjectId, cursorDeletedAt, cursorProjectId, cursorId, batchLimit)
        : database.prepare(`
          SELECT project_id, id, deleted_at FROM assets
          WHERE deleted_at IS NOT NULL AND deleted_at <= ?
          ORDER BY deleted_at, project_id, id LIMIT ?
        `).all(cutoff, batchLimit);
      let removed = 0;
      const removedProjects = new Set();
      let pending = [...rows];
      while (pending.length) {
        const retry = [];
        let progress = 0;
        for (const row of pending) {
          try {
            await this.permanentlyDeleteAsset(row.project_id, row.id);
            removed += 1;
            removedProjects.add(row.project_id);
            progress += 1;
          } catch {
            retry.push(row);
          }
        }
        if (!progress) { pending = retry; break; }
        pending = retry;
      }
      const last = rows.at(-1);
      return {
        due: rows.length,
        removed,
        failed: pending.length,
        projects: [...removedProjects],
        nextCursor: rows.length === batchLimit && last
          ? { deleted_at: last.deleted_at, project_id: last.project_id, id: last.id }
          : null,
      };
    },
    async cleanupPermanentDeletionStaging() {
      let removed = 0;
      let failed = 0;
      for (const { id } of database.prepare("SELECT id FROM projects").all()) {
        const result = await cleanupPermanentDeletionStaging(this.projectDir(id));
        removed += result.removed;
        failed += result.failed;
      }
      return { removed, failed };
    },
    async emptyTrash(projectId = DEFAULT_PROJECT_ID) {
      const cleanProjectId = sanitizeProjectId(projectId);
      const rows = database.prepare(`
        SELECT id FROM assets
        WHERE project_id = ? AND deleted_at IS NOT NULL
        ORDER BY deleted_at, id
      `).all(cleanProjectId);
      let removed = 0;
      let pending = rows.map((row) => ({ row, error: null }));
      while (pending.length) {
        const retry = [];
        let progress = 0;
        for (const entry of pending) {
          try {
            await this.permanentlyDeleteAsset(cleanProjectId, entry.row.id);
            removed += 1;
            progress += 1;
          } catch (error) {
            retry.push({ row: entry.row, error });
          }
        }
        if (!progress) { pending = retry; break; }
        pending = retry;
      }
      const failed = pending.map(({ row, error }) => ({ id: row.id, code: error?.code || "PERMANENT_DELETE_FAILED", error: error instanceof Error ? error.message : String(error) }));
      return { removed, failed, partial: failed.length > 0 };
    },
    async duplicateAsset(projectId, assetId, input = {}) {
      const current = await this.getAsset(projectId, assetId);
      return this.createAsset({
        ...current,
        ...pickVersionOverrides(input),
        projectId: current.project_id,
        assetId: input.assetId || `${current.id}-copy-${shortStamp()}`,
        imagePath: current.image_path,
        parent_asset_id: null,
        child_asset_ids: [],
        version_change: "",
        archived: false,
        created_at: undefined,
        updated_at: undefined,
        sourceType: current.source?.type,
        source: derivedAssetSource(current.source, "duplicated_from", current.id),
      });
    },
    async createAssetVersion(projectId, assetId, input = {}, context = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      // Version creation participates in the parent's lifecycle. Holding the
      // same lock as permanentlyDeleteAsset closes the window where a purge's
      // child check passes and a new version child appears before the commit.
      return this.withAssetLifecycleLock(cleanProjectId, cleanAssetId, async () => {
        const current = await this.getAsset(cleanProjectId, cleanAssetId);
        const versionChange = requireVersionChange(input);
        const replacementImagePath = typeof input.imagePath === "string" && input.imagePath.trim() ? input.imagePath : null;
        const replacementSource = input.source && typeof input.source === "object" ? input.source : {};
        return this.createAsset({
          ...current,
          ...pickVersionOverrides(input),
          projectId: current.project_id,
          assetId: input.assetId || input.assetIdNew || `${current.id}-v-${shortStamp()}`,
          imagePath: replacementImagePath || current.image_path,
          parent_asset_id: current.id,
          child_asset_ids: [],
          version_change: versionChange,
          archived: false,
          created_at: undefined,
          updated_at: undefined,
          sourceType: replacementImagePath ? input.sourceType : current.source?.type,
          source: replacementImagePath
            ? derivedAssetSource(replacementSource, "versioned_from", current.id)
            : derivedAssetSource(current.source, "versioned_from", current.id),
        }, context);
      });
    },
    async getAssetVersionHistory(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const rootAssetId = findSqliteVersionRoot(database, cleanProjectId, cleanAssetId);
      const rows = database.prepare(`
        WITH RECURSIVE family(id) AS (
          SELECT ?
          UNION
          SELECT v.asset_id FROM asset_versions v JOIN family f ON v.parent_asset_id = f.id WHERE v.project_id = ?
        )
        SELECT a.* FROM assets a JOIN family f ON f.id = a.id WHERE a.project_id = ?
      `).all(rootAssetId, cleanProjectId, cleanProjectId);
      return buildAssetVersionHistory({
        projectId: cleanProjectId,
        selectedAssetId: cleanAssetId,
        assets: rows.map((row) => rowToAsset(database, row)),
      });
    },
    async getRecipeSnapshotHistory(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const row = database.prepare("SELECT * FROM assets WHERE project_id = ? AND id = ?").get(cleanProjectId, cleanAssetId);
      if (!row) throw assetNotFoundError(cleanAssetId);
      return sqliteRecipeHistory(database, row);
    },
    async recordGenerationEvent(input = {}) {
      const explicitId = String(input.id || input.generation_event_id || input.generationEventId || "").trim();
      const event = normalizeGenerationEvent(input);
      const legacyId = !explicitId && !event.provider_generation_call_id && event.capture_context_id && event.provider_tool_call_id
        ? normalizeGenerationEvent({ ...event, id: "", provider_tool_call_id: "" }).id
        : "";
      const asset = database.prepare("SELECT id, source_json, conversation_id FROM assets WHERE project_id = ? AND id = ?").get(event.project_id, event.output_asset_id);
      if (!asset) throw assetNotFoundError(event.output_asset_id);
      // Fill an empty message id from the asset's own capture record; the
      // event id is already derived and must not change (see
      // generation-message-binding.mjs).
      const supplementedEvent = supplementGenerationEventMessageId(database, event, asset);
      let storedEvent = supplementedEvent;
      database.transaction(() => {
      // Read and merge inside the write transaction (IMMEDIATE): the merge owns
      // every "empty new value must not erase the stored one" rule (prompt/model
      // collapse on replays from a reopened conversation page), so the upsert
      // below writes the merged row as-is and must not race another writer.
      let targetEvent = supplementedEvent;
      let existing = database.prepare("SELECT * FROM generation_events WHERE project_id = ? AND id = ?").get(targetEvent.project_id, targetEvent.id);
      if (!existing && legacyId) {
        const legacyExisting = database.prepare("SELECT * FROM generation_events WHERE project_id = ? AND id = ?").get(targetEvent.project_id, legacyId);
        const legacyToolCallId = String(legacyExisting?.provider_tool_call_id || "").trim();
        if (legacyExisting && (!legacyToolCallId || legacyToolCallId === targetEvent.provider_tool_call_id)) {
          targetEvent = { ...targetEvent, id: legacyId };
          existing = legacyExisting;
        }
      }
      storedEvent = existing
        ? mergeGenerationEventForUpdate(generationEventFromRow(existing), targetEvent)
        : targetEvent;
      database.prepare(`
        INSERT INTO generation_events (
          project_id, id, output_asset_id, provider, capture_context_id,
          provider_tool_call_id, provider_generation_call_id, provider_response_id, provider_asset_id,
          conversation_id, message_id, turn_index, turn_synced_at, batch_id, model, user_prompt, effective_prompt,
          prompt_status, prompt_scope, generation_status, capture_channel, verification_level, references_json,
          evidence_json, created_at
        ) VALUES (
          @project_id, @id, @output_asset_id, @provider, @capture_context_id,
          @provider_tool_call_id, @provider_generation_call_id, @provider_response_id, @provider_asset_id,
          @conversation_id, @message_id, @turn_index, @turn_synced_at, @batch_id, @model, @user_prompt, @effective_prompt,
          @prompt_status, @prompt_scope, @generation_status, @capture_channel, @verification_level, @references_json,
          @evidence_json, @created_at
        )
        ON CONFLICT(project_id, id) DO UPDATE SET
          output_asset_id = excluded.output_asset_id,
          provider = excluded.provider,
          capture_context_id = excluded.capture_context_id,
          provider_tool_call_id = excluded.provider_tool_call_id,
          provider_generation_call_id = excluded.provider_generation_call_id,
          provider_response_id = excluded.provider_response_id,
          provider_asset_id = excluded.provider_asset_id,
          conversation_id = excluded.conversation_id,
          message_id = excluded.message_id,
          turn_index = excluded.turn_index,
          batch_id = excluded.batch_id,
          model = excluded.model,
          user_prompt = excluded.user_prompt,
          effective_prompt = excluded.effective_prompt,
          prompt_status = excluded.prompt_status,
          prompt_scope = excluded.prompt_scope,
          generation_status = excluded.generation_status,
          capture_channel = excluded.capture_channel,
          verification_level = excluded.verification_level,
          references_json = excluded.references_json,
          evidence_json = excluded.evidence_json
      `).run({
        ...storedEvent,
        // Only the binding API stamps turn_synced_at; captures never touch it.
        turn_synced_at: null,
        references_json: JSON.stringify(storedEvent.references || []),
        evidence_json: JSON.stringify(storedEvent.evidence || {}),
      });
      syncSqliteGenerationRelationCandidatesForEvent(database, event.project_id, existing ? generationEventFromRow(existing) : null, storedEvent);
      commitLibraryChanges([{
        projectId: event.project_id,
        kind: "generation-updated",
        entityType: "generation",
        entityId: storedEvent.id,
        assetIds: [storedEvent.output_asset_id],
      }]);
      }).immediate();
      // Read the row back so callers see exactly what the database holds
      // (turn_synced_at/created_at are deliberately outside the upsert's
      // update list, so the pre-write merged event can differ from the row).
      const storedRow = database.prepare("SELECT * FROM generation_events WHERE project_id = ? AND id = ?").get(storedEvent.project_id, storedEvent.id);
      return generationEventFromRow(storedRow);
    },
    async applyGenerationMessageBindings(input = {}) {
      return applyGenerationMessageBindingsInDatabase(database, input, {
        projectId: sanitizeProjectId(input.project_id || input.projectId || DEFAULT_PROJECT_ID),
        commitLibraryChanges,
      });
    },
    async listGenerationEvents(projectId, filters = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const conditions = ["project_id = @projectId"];
      const params = { projectId: cleanProjectId };
      if (filters.assetId) {
        conditions.push("output_asset_id = @assetId");
        params.assetId = sanitizeId(filters.assetId, "asset");
      }
      if (filters.captureContextId) {
        conditions.push("capture_context_id = @captureContextId");
        params.captureContextId = String(filters.captureContextId);
      }
      if (filters.providerToolCallId) {
        conditions.push("provider_tool_call_id = @providerToolCallId");
        params.providerToolCallId = String(filters.providerToolCallId);
      }
      if (filters.providerGenerationCallId) {
        conditions.push("provider_generation_call_id = @providerGenerationCallId");
        params.providerGenerationCallId = String(filters.providerGenerationCallId);
      }
      const rawLimit = Number(filters.limit);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 251) : 0;
      const rawOffset = Number(filters.offset);
      const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
      if (limit) {
        params.limit = limit;
        params.offset = offset;
      }
      return database.prepare(`
        SELECT * FROM generation_events
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at ASC, id ASC
        ${limit ? "LIMIT @limit OFFSET @offset" : ""}
      `).all(params).map(generationEventFromRow);
    },
    async recordGenerationRelation(input = {}) {
      const relation = normalizeGenerationRelation(input);
      const rows = database.prepare(`
        SELECT id FROM generation_events
        WHERE project_id = ? AND id IN (?, ?)
      `).all(relation.project_id, relation.child_generation_id, relation.parent_generation_id);
      if (rows.length !== 2) {
        throw generationHistoryError("Generation relation references a missing event.", "GENERATION_RELATION_EVENT_NOT_FOUND", 409);
      }
      assertSqliteGenerationRelationAcyclic(database, relation);
      const existingRow = database.prepare(`
        SELECT * FROM generation_relations
        WHERE project_id = ? AND child_generation_id = ? AND parent_generation_id = ? AND relation_type = ?
      `).get(relation.project_id, relation.child_generation_id, relation.parent_generation_id, relation.relation_type);
      const existingRelation = existingRow ? generationRelationFromRow(existingRow) : null;
      const storedRelation = preserveTrustedGenerationRelation(existingRelation, relation);
      database.transaction(() => {
      database.prepare(`
        INSERT INTO generation_relations (
          project_id, child_generation_id, parent_generation_id, relation_type,
          verification_level, evidence_json, created_at
        ) VALUES (
          @project_id, @child_generation_id, @parent_generation_id, @relation_type,
          @verification_level, @evidence_json, @created_at
        )
        ON CONFLICT(project_id, child_generation_id, parent_generation_id, relation_type) DO UPDATE SET
          verification_level = excluded.verification_level,
          evidence_json = excluded.evidence_json
      `).run({
        ...storedRelation,
        evidence_json: JSON.stringify(storedRelation.evidence || {}),
      });
      database.prepare(`
        UPDATE generation_relation_candidates
        SET status = 'confirmed', updated_at = ?
        WHERE project_id = ? AND child_generation_id = ? AND parent_generation_id = ?
      `).run(now(), relation.project_id, relation.child_generation_id, relation.parent_generation_id);
      commitLibraryChanges([{
        projectId: relation.project_id,
        kind: "generation-relation-updated",
        entityType: "generation",
        entityId: relation.child_generation_id,
        assetIds: generationOutputAssetIds(database, relation.project_id, [relation.child_generation_id, relation.parent_generation_id]),
      }]);
      })();
      return storedRelation;
    },
    async updateGenerationRelationCandidate(input = {}) {
      const projectId = sanitizeProjectId(input.project_id || input.projectId || DEFAULT_PROJECT_ID);
      const childGenerationId = String(input.child_generation_id || input.childGenerationId || "").trim();
      const parentGenerationId = String(input.parent_generation_id || input.parentGenerationId || "").trim();
      if (!childGenerationId || !parentGenerationId) {
        throw generationHistoryError("Generation relation candidate requires child and parent generation IDs.", "GENERATION_RELATION_CANDIDATE_IDS_REQUIRED");
      }
      const row = database.prepare(`
        SELECT * FROM generation_relation_candidates
        WHERE project_id = ? AND child_generation_id = ? AND parent_generation_id = ?
      `).get(projectId, childGenerationId, parentGenerationId);
      if (!row) {
        throw generationHistoryError("Generation relation candidate was not found.", "GENERATION_RELATION_CANDIDATE_NOT_FOUND", 404);
      }
      const existing = generationRelationCandidateFromRow(row);
      const updated = normalizeGenerationRelationCandidate({
        ...existing,
        status: input.status || existing.status,
        created_at: existing.created_at,
        updated_at: now(),
      });
      database.transaction(() => {
      database.prepare(`
        UPDATE generation_relation_candidates
        SET suggested_relation_type = @suggested_relation_type,
            confidence = @confidence,
            verification_level = @verification_level,
            evidence_json = @evidence_json,
            status = @status,
            updated_at = @updated_at
        WHERE project_id = @project_id
          AND child_generation_id = @child_generation_id
          AND parent_generation_id = @parent_generation_id
      `).run({ ...updated, evidence_json: JSON.stringify(updated.evidence || {}) });
      commitLibraryChanges([{
        projectId,
        kind: "generation-relation-candidate-updated",
        entityType: "generation",
        entityId: childGenerationId,
        assetIds: generationOutputAssetIds(database, projectId, [childGenerationId, parentGenerationId]),
      }]);
      })();
      return updated;
    },
    async deleteGenerationRelation(input = {}) {
      const relation = normalizeGenerationRelation(input);
      const row = database.prepare(`
        SELECT * FROM generation_relations
        WHERE project_id = ? AND child_generation_id = ? AND parent_generation_id = ? AND relation_type = ?
      `).get(relation.project_id, relation.child_generation_id, relation.parent_generation_id, relation.relation_type);
      const existing = row ? generationRelationFromRow(row) : null;
      assertGenerationRelationUserMutable(existing);
      database.transaction(() => {
      database.prepare(`
        DELETE FROM generation_relations
        WHERE project_id = ? AND child_generation_id = ? AND parent_generation_id = ? AND relation_type = ?
      `).run(relation.project_id, relation.child_generation_id, relation.parent_generation_id, relation.relation_type);
      database.prepare(`
        UPDATE generation_relation_candidates
        SET status = 'dismissed', updated_at = ?
        WHERE project_id = ? AND child_generation_id = ? AND parent_generation_id = ?
      `).run(now(), relation.project_id, relation.child_generation_id, relation.parent_generation_id);
      commitLibraryChanges([{
        projectId: relation.project_id,
        kind: "generation-relation-deleted",
        entityType: "generation",
        entityId: relation.child_generation_id,
        assetIds: generationOutputAssetIds(database, relation.project_id, [relation.child_generation_id, relation.parent_generation_id]),
      }]);
      })();
      return existing;
    },
    async updateGenerationRelation(input = {}) {
      const relation = normalizeGenerationRelation(input);
      const previousRelationType = String(input.previous_relation_type || input.previousRelationType || relation.relation_type).trim();
      const update = database.transaction(() => {
        const eventRows = database.prepare(`
          SELECT id FROM generation_events
          WHERE project_id = ? AND id IN (?, ?)
        `).all(relation.project_id, relation.child_generation_id, relation.parent_generation_id);
        if (eventRows.length !== 2) {
          throw generationHistoryError("Generation relation references a missing event.", "GENERATION_RELATION_EVENT_NOT_FOUND", 409);
        }
        const existingRow = database.prepare(`
          SELECT * FROM generation_relations
          WHERE project_id = ? AND child_generation_id = ? AND parent_generation_id = ? AND relation_type = ?
        `).get(relation.project_id, relation.child_generation_id, relation.parent_generation_id, previousRelationType);
        const existing = existingRow ? generationRelationFromRow(existingRow) : null;
        assertGenerationRelationUserMutable(existing);
        assertSqliteGenerationRelationAcyclic(database, relation, {
          child_generation_id: relation.child_generation_id,
          parent_generation_id: relation.parent_generation_id,
          relation_type: previousRelationType,
        });
        const targetRow = database.prepare(`
          SELECT * FROM generation_relations
          WHERE project_id = ? AND child_generation_id = ? AND parent_generation_id = ? AND relation_type = ?
        `).get(relation.project_id, relation.child_generation_id, relation.parent_generation_id, relation.relation_type);
        const target = targetRow && relation.relation_type !== previousRelationType ? generationRelationFromRow(targetRow) : null;
        if (target) assertGenerationRelationUserMutable(target);
        database.prepare(`
          DELETE FROM generation_relations
          WHERE project_id = ? AND child_generation_id = ? AND parent_generation_id = ? AND relation_type IN (?, ?)
        `).run(relation.project_id, relation.child_generation_id, relation.parent_generation_id, previousRelationType, relation.relation_type);
        database.prepare(`
          INSERT INTO generation_relations (
            project_id, child_generation_id, parent_generation_id, relation_type,
            verification_level, evidence_json, created_at
          ) VALUES (
            @project_id, @child_generation_id, @parent_generation_id, @relation_type,
            @verification_level, @evidence_json, @created_at
          )
        `).run({
          ...relation,
          evidence_json: JSON.stringify(relation.evidence || {}),
        });
        commitLibraryChanges([{
          projectId: relation.project_id,
          kind: "generation-relation-updated",
          entityType: "generation",
          entityId: relation.child_generation_id,
          assetIds: generationOutputAssetIds(database, relation.project_id, [relation.child_generation_id, relation.parent_generation_id]),
        }]);
        return relation;
      });
      return update();
    },
    async getGenerationLineage(projectId, generationId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanGenerationId = String(generationId || "").trim();
      const events = sqliteGenerationComponentEvents(database, cleanProjectId, "id", cleanGenerationId);
      if (!events.some((event) => event.id === cleanGenerationId)) {
        throw generationHistoryError(`Generation event not found: ${cleanGenerationId}`, "GENERATION_EVENT_NOT_FOUND", 404);
      }
      const relations = sqliteGenerationRelationsForEvents(database, cleanProjectId, events);
      return buildGenerationLineage({
        projectId: cleanProjectId,
        selectedGenerationId: cleanGenerationId,
        events,
        relations,
      });
    },
    async getAssetGenerationHistory(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const asset = database.prepare("SELECT id FROM assets WHERE project_id = ? AND id = ?").get(cleanProjectId, cleanAssetId);
      if (!asset) throw assetNotFoundError(cleanAssetId);
      const lineageEvents = sqliteGenerationComponentEvents(database, cleanProjectId, "output_asset_id", cleanAssetId);
      if (lineageEvents.length > 5000) {
        throw generationHistoryError("Generation history exceeds 5000 events.", "GENERATION_LINEAGE_TOO_LARGE", 409);
      }
      const relations = sqliteGenerationRelationsForEvents(database, cleanProjectId, lineageEvents);
      const candidates = sqliteGenerationCandidatesForEvents(database, cleanProjectId, lineageEvents);
      const contextLimit = Math.max(0, 5000 - lineageEvents.length);
      const contextEvents = sqliteGenerationContextEvents(database, cleanProjectId, cleanAssetId, lineageEvents, candidates, contextLimit);
      const events = [...lineageEvents, ...contextEvents];
      // Context events can carry relations/suggestions among themselves (the
      // version canvas shows them); lineage membership is unaffected because a
      // relation touching the lineage would already have pulled the event in.
      const historyRelations = contextEvents.length ? sqliteGenerationRelationsForEvents(database, cleanProjectId, events) : relations;
      const historyCandidates = contextEvents.length ? sqliteGenerationCandidatesForEvents(database, cleanProjectId, events) : candidates;
      const conversationRows = database.prepare("SELECT provider, conversation_id, turn_count, synced_at FROM generation_conversations WHERE project_id = ?").all(cleanProjectId);
      const history = buildAssetGenerationHistory({
        projectId: cleanProjectId,
        assetId: cleanAssetId,
        events,
        relations: historyRelations,
        candidates: historyCandidates,
        conversations: conversationRows,
      });
      const outputIds = new Set([...history.events, ...(history.context_events || [])].map((event) => event.output_asset_id).filter(Boolean));
      const outputIdList = [...outputIds];
      const outputAssets = outputIdList.length
        ? database.prepare(`
            SELECT * FROM assets
            WHERE project_id = ? AND id IN (${outputIdList.map(() => "?").join(",")})
          `).all(cleanProjectId, ...outputIdList).map((row) => rowToAsset(database, row, { includeRelations: false }))
        : [];
      return { ...history, output_assets: outputAssets };
    },
    async listReferencedAttachmentIds(projectId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const rows = database.prepare(`
        SELECT DISTINCT reference_id FROM (
          SELECT COALESCE(
            json_extract(value, '$.reference_id'),
            json_extract(value, '$.asset_id')
          ) AS reference_id
          FROM assets, json_each(assets.metadata_json, '$.references')
          WHERE assets.project_id = ?
            AND json_type(assets.metadata_json, '$.references') = 'array'
          UNION ALL
          SELECT COALESCE(
            json_extract(value, '$.reference_id'),
            json_extract(value, '$.asset_id')
          ) AS reference_id
          FROM generation_events, json_each(generation_events.references_json)
          WHERE generation_events.project_id = ?
        )
        WHERE reference_id IS NOT NULL AND trim(reference_id) != ''
      `).all(cleanProjectId, cleanProjectId);
      return new Set(rows.map((row) => String(row.reference_id)));
    },
    async assetFileInfo(projectId, fileName) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const safeName = sanitizeFileName(fileName);
      const row = database.prepare("SELECT original_path FROM assets WHERE project_id = ? AND asset = ?").get(cleanProjectId, safeName);
      if (!row?.original_path) throw new Error("Asset not found.");
      await assertStoredPath(this.imagesDir(cleanProjectId), row.original_path);
      const fileStat = await stat(row.original_path);
      return { size: fileStat.size };
    },
    async assetReadStream(projectId, fileName, options = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const safeName = sanitizeFileName(fileName);
      const row = database.prepare("SELECT original_path FROM assets WHERE project_id = ? AND asset = ?").get(cleanProjectId, safeName);
      if (!row?.original_path) throw new Error("Asset not found.");
      await assertStoredPath(this.imagesDir(cleanProjectId), row.original_path);
      const streamOptions = Number.isSafeInteger(options.start) && Number.isSafeInteger(options.end)
        ? { start: options.start, end: options.end }
        : undefined;
      return createReadStream(row.original_path, streamOptions);
    },
    async derivativeReadStream(projectId, assetId, kind) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const column = DERIVATIVE_COLUMNS.get(kind);
      if (!column) throw new Error(`Invalid derivative kind: ${kind}`);
      const root = kind === "preview"
        ? this.previewsDir(cleanProjectId)
        : kind === "medium"
          ? this.mediumsDir(cleanProjectId)
          : this.thumbnailsDir(cleanProjectId);
      const row = database.prepare(`SELECT ${column} AS path FROM assets WHERE project_id = ? AND id = ?`).get(cleanProjectId, cleanAssetId);
      if (!row?.path) throw new Error("Derivative not found.");
      await assertStoredPath(root, row.path);
      return createReadStream(row.path);
    },
    async enqueueDerivative(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      database.prepare(`
        INSERT INTO derivative_jobs (project_id, asset_id, status, attempts, created_at, updated_at)
        VALUES (?, ?, 'pending', 0, ?, ?)
        ON CONFLICT(project_id, asset_id) DO UPDATE SET status = 'pending', error = NULL, updated_at = excluded.updated_at
      `).run(cleanProjectId, cleanAssetId, now(), now());
    },
    async enqueueMissingDerivatives(options = {}) {
      // No options keeps the historical metadata-only scan: gap columns and
      // missing dimensions, ignoring the filesystem. The CLI modes extend it:
      //   "repair"  — additionally enqueues assets whose derivative files
      //               vanished from disk. Paths are checked exactly as the
      //               runtime reads them: the absolute paths stored in the
      //               thumbnail/medium/preview columns.
      //   "rebuild" — enqueues every eligible asset so all derivatives are
      //               regenerated from the original, present or not.
      //   "startup" — post-listen maintenance only: dimensions missing from
      //               business_fields (older imports never recorded them and
      //               their completed jobs never re-run) or an empty
      //               thumbnail/preview column. A NULL medium_path alone is
      //               NOT a gap: media whose jobs finished before mediums were
      //               introduced has no medium and must not be regenerated
      //               wholesale on every launch. A job that already failed
      //               three times stays failed — one permanently broken image
      //               must not be re-enqueued on every launch (task 416,
      //               audit 低10 ①); repair/rebuild are explicit requests and
      //               keep re-enqueueing it.
      const mode = options.mode === "repair" || options.mode === "rebuild" || options.mode === "startup" ? options.mode : "metadata";
      const rows = database.prepare(`
        SELECT project_id, id, thumbnail_path, medium_path, preview_path,
          (
            thumbnail_path IS NULL OR medium_path IS NULL OR preview_path IS NULL
            OR COALESCE(CAST(json_extract(business_fields_json, '$.width') AS REAL), 0) <= 0
            OR COALESCE(CAST(json_extract(business_fields_json, '$.height') AS REAL), 0) <= 0
          ) AS metadata_gap,
          (
            thumbnail_path IS NULL OR preview_path IS NULL
            OR COALESCE(CAST(json_extract(business_fields_json, '$.width') AS REAL), 0) <= 0
            OR COALESCE(CAST(json_extract(business_fields_json, '$.height') AS REAL), 0) <= 0
          ) AS startup_gap
        FROM assets
        WHERE archived = 0
          AND deleted_at IS NULL
          AND mosa_media_kind(business_fields_json, source_json, original_path) != 'video'
          ${mode === "startup" ? `
          AND NOT EXISTS (
            SELECT 1 FROM derivative_jobs j
            WHERE j.project_id = assets.project_id AND j.asset_id = assets.id
              AND j.status = 'failed' AND j.attempts >= 3
          )` : ""}
      `).all();
      const stale = rows.filter((row) => {
        if (mode === "rebuild") return true;
        if (mode === "startup") return Boolean(row.startup_gap);
        if (row.metadata_gap) return true;
        if (mode !== "repair") return false;
        return [row.thumbnail_path, row.medium_path, row.preview_path].some((path) => path && !existsSync(path));
      });
      const insert = database.prepare(`
        INSERT INTO derivative_jobs (project_id, asset_id, status, attempts, created_at, updated_at)
        VALUES (?, ?, 'pending', 0, ?, ?)
        ON CONFLICT(project_id, asset_id) DO UPDATE SET status = CASE WHEN derivative_jobs.status = 'running' THEN 'running' ELSE 'pending' END, updated_at = excluded.updated_at
      `);
      const timestamp = now();
      // BEGIN IMMEDIATE, not the default deferred transaction: same rationale
      // as claimDerivativeJob — with MCP/CLI processes writing the same
      // library, a deferred transaction that upgrades from read to write
      // mid-flight fails with an immediate WAL BUSY_SNAPSHOT.
      database.transaction(() => stale.forEach((row) => insert.run(row.project_id, row.id, timestamp, timestamp))).immediate();
      return stale.length;
    },
    async enqueueMediumBackfill(options = {}) {
      // Task 383: old libraries hold assets whose derivative jobs completed
      // before medium images existed — the "startup" mode above deliberately
      // leaves those medium-only gaps alone, and regenerating them wholesale
      // on every launch would re-run thousands of rows. The runtime's slow
      // scheduler (startMediumBackfill) drips a bounded batch of them in.
      // Eligibility is the medium-only gap minus everything startup mode
      // already owns: small image and large image must exist, the row must
      // not be stuck failed-at-3 (unhashable images never stop failing), and
      // width × height must stay under the derivative ceiling — rows without
      // dimensions are NOT excluded here, the worker judges those. Rows with
      // a pending/running job are skipped so nothing is queued twice. The
      // queued job carries the ASSET's created_at, so any freshly imported
      // asset (job created_at = now) claims ahead of every backfill row.
      const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 8;
      const rows = database.prepare(`
        SELECT a.project_id, a.id, a.created_at
        FROM assets a
        WHERE a.archived = 0
          AND a.deleted_at IS NULL
          AND a.medium_path IS NULL
          AND a.thumbnail_path IS NOT NULL
          AND a.preview_path IS NOT NULL
          AND mosa_media_kind(a.business_fields_json, a.source_json, a.original_path) != 'video'
          AND (
            COALESCE(CAST(json_extract(a.business_fields_json, '$.width') AS REAL), 0) <= 0
            OR COALESCE(CAST(json_extract(a.business_fields_json, '$.height') AS REAL), 0) <= 0
            OR CAST(json_extract(a.business_fields_json, '$.width') AS REAL)
              * CAST(json_extract(a.business_fields_json, '$.height') AS REAL) <= ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM derivative_jobs j
            WHERE j.project_id = a.project_id AND j.asset_id = a.id
              AND (j.status IN ('pending', 'running') OR (j.status = 'failed' AND j.attempts >= 3))
          )
        ORDER BY a.created_at DESC
        LIMIT ?
      `).all(MAX_DERIVATIVE_INPUT_PIXELS, limit);
      const insert = database.prepare(`
        INSERT INTO derivative_jobs (project_id, asset_id, status, attempts, created_at, updated_at)
        VALUES (?, ?, 'pending', 0, ?, ?)
        ON CONFLICT(project_id, asset_id) DO UPDATE SET status = CASE WHEN derivative_jobs.status = 'running' THEN 'running' ELSE 'pending' END, created_at = excluded.created_at, updated_at = excluded.updated_at
      `);
      const timestamp = now();
      // BEGIN IMMEDIATE, not the default deferred transaction: same rationale
      // as enqueueMissingDerivatives — with MCP/CLI processes writing the same
      // library, a deferred transaction that upgrades from read to write
      // mid-flight fails with an immediate WAL BUSY_SNAPSHOT.
      database.transaction(() => rows.forEach((row) => insert.run(row.project_id, row.id, row.created_at, timestamp))).immediate();
      return rows.length;
    },
    async enqueueAnimationBackfill(options = {}) {
      // Task 412: libraries that predate the animation flag hold GIF/WebP/
      // APNG/AVIF files that would animate in the viewer if they carried it.
      // The runtime's slow scheduler (startMediumBackfill) calls this once the
      // medium backfill has drained, re-running each candidate's derivative
      // job — the completed run stamps $.animated through completeDerivativeJob.
      // Eligibility mirrors enqueueMediumBackfill's protections: nothing
      // pending/running, nothing stuck failed-at-3 (unhashable images never
      // stop failing), newest created_at first, and each queued job carries
      // the ASSET's created_at so fresh imports claim ahead of it.
      // .png is deliberately NOT backfilled: libraries hold thousands of plain
      // PNGs and re-running every one of them just to catch the rare APNG
      // would outweigh the benefit — freshly imported APNGs are flagged by
      // their own derivative run (derivative-processor.ts), so only old
      // .apng-named files need the backfill.
      const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 8;
      const rows = database.prepare(`
        SELECT a.project_id, a.id, a.created_at
        FROM assets a
        WHERE a.archived = 0
          AND a.deleted_at IS NULL
          AND mosa_media_kind(a.business_fields_json, a.source_json, a.original_path) != 'video'
          AND json_extract(a.business_fields_json, '$.animated') IS NULL
          AND (
            a.original_path LIKE '%.gif' COLLATE NOCASE
            OR a.original_path LIKE '%.webp' COLLATE NOCASE
            OR a.original_path LIKE '%.apng' COLLATE NOCASE
            OR a.original_path LIKE '%.avif' COLLATE NOCASE
          )
          AND NOT EXISTS (
            SELECT 1 FROM derivative_jobs j
            WHERE j.project_id = a.project_id AND j.asset_id = a.id
              AND (j.status IN ('pending', 'running') OR (j.status = 'failed' AND j.attempts >= 3))
          )
        ORDER BY a.created_at DESC
        LIMIT ?
      `).all(limit);
      const insert = database.prepare(`
        INSERT INTO derivative_jobs (project_id, asset_id, status, attempts, created_at, updated_at)
        VALUES (?, ?, 'pending', 0, ?, ?)
        ON CONFLICT(project_id, asset_id) DO UPDATE SET status = CASE WHEN derivative_jobs.status = 'running' THEN 'running' ELSE 'pending' END, created_at = excluded.created_at, updated_at = excluded.updated_at
      `);
      const timestamp = now();
      // BEGIN IMMEDIATE, not the default deferred transaction: same rationale
      // as enqueueMediumBackfill — with MCP/CLI processes writing the same
      // library, a deferred transaction that upgrades from read to write
      // mid-flight fails with an immediate WAL BUSY_SNAPSHOT.
      database.transaction(() => rows.forEach((row) => insert.run(row.project_id, row.id, row.created_at, timestamp))).immediate();
      return rows.length;
    },
    async claimDerivativeJob() {
      // Newest first (task 292): the gallery lists newest assets at the top,
      // so claiming in descending created_at puts each freshly imported
      // image's thumbnails where the user is actually looking while the rest
      // of the import is still landing — ASC made the top of the gallery wait
      // the full derivative queue. Retry/stale-running reclaims keep their
      // conditions; only the pick order changed (rowid breaks same-timestamp
      // ties deterministically).
      const claim = database.transaction(() => {
        const retryBefore = new Date(Date.now() - 30 * 1000).toISOString();
        const job = database.prepare(`
          SELECT j.project_id, j.asset_id, j.attempts, a.original_path, a.id
          FROM derivative_jobs j JOIN assets a ON a.project_id = j.project_id AND a.id = j.asset_id
          WHERE j.status = 'pending'
            OR (j.status = 'running' AND j.updated_at < @staleRunningBefore)
            OR (j.status = 'failed' AND j.attempts < 3 AND j.updated_at < @retryBefore)
          ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1
        `).get({
          staleRunningBefore: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          retryBefore,
        });
        if (!job) return null;
        database.prepare("UPDATE derivative_jobs SET status = 'running', attempts = attempts + 1, error = NULL, updated_at = ? WHERE project_id = ? AND asset_id = ?").run(now(), job.project_id, job.asset_id);
        return {
          ...job,
          previewPath: join(store.previewsDir(job.project_id), `${job.asset_id}.webp`),
          mediumPath: join(store.mediumsDir(job.project_id), `${job.asset_id}.webp`),
          thumbnailPath: join(store.thumbnailsDir(job.project_id), `${job.asset_id}.webp`),
        };
      });
      // BEGIN IMMEDIATE, not the default deferred transaction: the read snapshot
      // must not upgrade to a write mid-transaction. In WAL mode that upgrade
      // returns SQLITE_BUSY (BUSY_SNAPSHOT) immediately — busy_timeout never
      // applies — whenever another process (MCP/CLI on the same library)
      // commits between the SELECT and the UPDATE.
      return claim.immediate();
    },
    async completeDerivativeJob(job, result = {}) {
      const timestamp = now();
      database.transaction(() => {
        if (result.error) {
          database.prepare("UPDATE derivative_jobs SET status = 'failed', error = ?, updated_at = ? WHERE project_id = ? AND asset_id = ?").run(String(result.error), timestamp, job.project_id, job.asset_id);
          return;
        }
        const current = database.prepare("SELECT business_fields_json FROM assets WHERE project_id = ? AND id = ?").get(job.project_id, job.asset_id);
        const businessFields = parseJson(current?.business_fields_json, {});
        const width = Number(result.width);
        const height = Number(result.height);
        if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
          businessFields.width = width;
          businessFields.height = height;
        }
        // Task 412: the animation flag rides in like width/height. A result
        // without `animated` (older processors, error completions) leaves both
        // keys untouched; frame_count only lands on a positive integer. Neither
        // key is searchable (see BUSINESS_FIELD_SEARCHABLE_KEYS).
        if (typeof result.animated === "boolean") {
          businessFields.animated = result.animated;
          if (Number.isSafeInteger(result.frameCount) && result.frameCount > 0) {
            businessFields.frame_count = result.frameCount;
          }
        }
        database.prepare("UPDATE assets SET preview_path = ?, medium_path = ?, thumbnail_path = ?, business_fields_json = ?, business_search_text = ?, updated_at = ? WHERE project_id = ? AND id = ?")
          .run(result.previewPath, result.mediumPath, result.thumbnailPath, JSON.stringify(businessFields), searchableBusinessObjectText(businessFields), timestamp, job.project_id, job.asset_id);
        // Palette is a dedicated column, deliberately outside business_fields
        // (which feeds the search text). Jobs whose result carries no palette
        // (older workers, error completions) leave the column untouched.
        if (Array.isArray(result.palette)) {
          database.prepare("UPDATE assets SET palette_json = ? WHERE project_id = ? AND id = ?")
            .run(JSON.stringify(result.palette), job.project_id, job.asset_id);
        }
        // Same for the perceptual hash used by manual-import dedupe: a parsed
        // result refreshes the row (and drops any lazily computed pixel digest,
        // which belonged to the replaced pixels), a missing one leaves it.
        if (typeof result.perceptualHash === "string" && result.perceptualHash) {
          const parsed = parsePerceptualHash(result.perceptualHash);
          if (parsed) {
            database.prepare(`
              INSERT INTO asset_perceptual_hashes (project_id, asset_id, algorithm, hash, pixel_sha256, pixel_hash_version, computed_at)
              VALUES (?, ?, ?, ?, '', '', ?)
              ON CONFLICT(project_id, asset_id) DO UPDATE SET
                algorithm = excluded.algorithm,
                hash = excluded.hash,
                pixel_sha256 = '',
                pixel_hash_version = '',
                computed_at = excluded.computed_at
            `).run(job.project_id, job.asset_id, parsed.algorithm, parsed.hash, timestamp);
          }
        }
        database.prepare("UPDATE derivative_jobs SET status = 'completed', error = NULL, updated_at = ? WHERE project_id = ? AND asset_id = ?").run(timestamp, job.project_id, job.asset_id);
        queueDerivativeChange(job.project_id, job.asset_id);
      }).immediate();
      if (!result.error) {
        invalidateFtsPageCache();
      }
    },
    async derivativeStatus() {
      const rows = database.prepare("SELECT status, COUNT(*) AS count FROM derivative_jobs GROUP BY status").all();
      return Object.fromEntries(rows.map((row) => [row.status, row.count]));
    },
    /**
     * Stores a poster frame the renderer extracted from a video. Only the
     * Electron UI can decode video (no ffmpeg ships with the app), so the UI
     * picks the frame and uploads it; this method owns everything else —
     * validation, re-encoding to the thumbnail tier, atomic publish, and the
     * thumbnail_path write. The write is recorded exactly like the derivative
     * backfill loop records its own thumbnail_path updates: through
     * queueDerivativeChange (one SSE "derivatives" flush), never as a library
     * change/revision, because a generated poster is maintenance, not a user
     * edit. Videos keep their palette NULL (see ensureAssetPalette).
     */
    async saveVideoPoster(projectId, assetId, image) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      if (!Buffer.isBuffer(image) || image.length === 0) {
        throw videoPosterError("VIDEO_POSTER_INVALID_IMAGE", "Video poster upload is empty.", 400);
      }
      const row = database.prepare(`
        SELECT id, original_path, thumbnail_path, deleted_at, business_fields_json, source_json
        FROM assets WHERE project_id = ? AND id = ?
      `).get(cleanProjectId, cleanAssetId);
      if (!row) throw assetNotFoundError(cleanAssetId);
      if (row.deleted_at) {
        throw videoPosterError("VIDEO_POSTER_ASSET_DELETED", "Video poster rejected: the asset is in the trash.", 409);
      }
      const kind = mediaKindOf({
        business_fields: parseJson(row.business_fields_json, {}),
        source: parseJson(row.source_json, {}),
        image_path: row.original_path,
      });
      if (kind !== "video") {
        throw videoPosterError("VIDEO_POSTER_NOT_VIDEO", "Video posters can only be saved for video assets.", 400);
      }
      if (row.thumbnail_path) {
        throw videoPosterError("VIDEO_POSTER_EXISTS", "This video already has a poster.", 409);
      }
      // Same tier as the image thumbnail in derivative-processor.ts
      // ({ size: 400, quality: 78 }); keep the two in sync.
      const POSTER_WIDTH = 400;
      const POSTER_QUALITY = 78;
      let encoded;
      try {
        encoded = await imageDecoder.encodeVideoPoster(image, {
          width: POSTER_WIDTH,
          quality: POSTER_QUALITY,
          limitInputPixels: MAX_DERIVATIVE_INPUT_PIXELS,
        });
      } catch (error) {
        const wrapped = videoPosterError("VIDEO_POSTER_INVALID_IMAGE", "Video poster upload could not be decoded as an image.", 400);
        wrapped.cause = error;
        throw wrapped;
      }
      const finalPath = join(this.thumbnailsDir(cleanProjectId), `${cleanAssetId}.webp`);
      await mkdir(dirname(finalPath), { recursive: true });
      await removeStaleDerivativeTempFiles([dirname(finalPath)], [basename(finalPath)]);
      const tempPath = join(dirname(finalPath), derivativeTempFileName(basename(finalPath)));
      try {
        await writeFile(tempPath, encoded);
        await publishDerivativeFile(tempPath, finalPath);
      } catch (error) {
        await unlink(tempPath).catch(() => {});
        throw error;
      }
      database.transaction(() => {
        database.prepare("UPDATE assets SET thumbnail_path = ?, updated_at = ? WHERE project_id = ? AND id = ?")
          .run(finalPath, now(), cleanProjectId, cleanAssetId);
        queueDerivativeChange(cleanProjectId, cleanAssetId);
      }).immediate();
      return this.getAsset(cleanProjectId, cleanAssetId);
    },
    async migrationStatus() {
      return Object.fromEntries(database.prepare("SELECT key, value FROM library_meta").all().map((row) => [row.key, row.value]));
    },
    async setMigrationState(state, details = {}) {
      const timestamp = now();
      const set = database.prepare("INSERT INTO library_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
      const write = database.transaction(() => {
        set.run("migration_state", state, timestamp);
        set.run("migration_details", JSON.stringify(details), timestamp);
      });
      write();
    },
    async recordMigrationIssue(issue) {
      database.prepare("INSERT INTO migration_issues (id, kind, path, detail, created_at) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), issue.kind, issue.path, issue.detail || null, now());
    },
    async clearMigrationIssues() {
      database.prepare("DELETE FROM migration_issues").run();
    },
    async listMigrationIssues() {
      return database.prepare("SELECT kind, path, detail FROM migration_issues ORDER BY created_at, path").all();
    },
    async verifyLibrary() {
      const rows = database.prepare("SELECT project_id, id, original_path, content_sha256 FROM assets ORDER BY project_id, id").all();
      const failures = [];
      for (const row of rows) {
        try {
          const actual = await sha256File(row.original_path);
          if (actual !== row.content_sha256) failures.push({ projectId: row.project_id, assetId: row.id, reason: "content-hash-mismatch" });
        } catch {
          failures.push({ projectId: row.project_id, assetId: row.id, reason: "original-missing" });
        }
      }
      return { assets: rows.length, failures, ok: failures.length === 0 };
    },
    async cleanupOrphanedManagedFiles({ olderThanMs = 24 * 60 * 60 * 1000, includeDerivatives = true } = {}) {
      const referenced = new Set();
      const managedRows = database.prepare("SELECT project_id, original_path, preview_path, medium_path, thumbnail_path FROM assets").all();
      const invalidManagedPath = managedRows.find((row) => {
        const expected = [
          [row.original_path, this.imagesDir(row.project_id)],
          [row.preview_path, this.previewsDir(row.project_id)],
          [row.medium_path, this.mediumsDir(row.project_id)],
          [row.thumbnail_path, this.thumbnailsDir(row.project_id)],
        ];
        return expected.some(([value, root]) => value && !isPathInside(root, resolve(value)) && resolve(value) !== resolve(root));
      });
      if (invalidManagedPath) {
        return { removed: 0, failed: 0, skipped: true, reason: "managed-path-integrity" };
      }
      for (const row of managedRows) {
        for (const value of [row.original_path, row.preview_path, row.medium_path, row.thumbnail_path]) {
          if (value) referenced.add(resolve(value));
        }
      }
      const cutoff = Date.now() - Math.max(0, Number(olderThanMs) || 0);
      let removed = 0;
      let failed = 0;
      const projects = database.prepare("SELECT id FROM projects").all();
      for (const { id } of projects) {
        const directories = includeDerivatives
          ? [this.imagesDir(id), this.previewsDir(id), this.mediumsDir(id), this.thumbnailsDir(id)]
          : [this.imagesDir(id)];
        for (const dir of directories) {
          let names;
          try { names = await readdir(dir); } catch (error) { if (error?.code === "ENOENT") continue; throw error; }
          for (const name of names) {
            const path = resolve(join(dir, name));
            if (referenced.has(path)) continue;
            try {
              const info = await lstat(path);
              if (!info.isFile() || info.isSymbolicLink() || info.mtimeMs > cutoff) continue;
              await unlink(path);
              removed += 1;
            } catch (error) {
              if (error?.code !== "ENOENT") failed += 1;
            }
          }
        }
      }
      return { removed, failed };
    },
    // Derivative bytes are written only by the derivative worker, so a sweep
    // restricted to the derivative directories is safe before the worker has
    // started and reclaims historical orphans (thumbnail/preview/medium from
    // older builds or interrupted generations) that the age-bounded general
    // sweep must leave alone while imports or generations may be in flight.
    async cleanupOrphanedDerivativeFiles({ olderThanMs = 0 } = {}) {
      const referenced = new Set();
      const derivativeRows = database.prepare("SELECT project_id, preview_path, medium_path, thumbnail_path FROM assets").all();
      const invalidDerivativePath = derivativeRows.find((row) => {
        const expected = [
          [row.preview_path, this.previewsDir(row.project_id)],
          [row.medium_path, this.mediumsDir(row.project_id)],
          [row.thumbnail_path, this.thumbnailsDir(row.project_id)],
        ];
        return expected.some(([value, root]) => value && !isPathInside(root, resolve(value)) && resolve(value) !== resolve(root));
      });
      if (invalidDerivativePath) {
        return { removed: 0, failed: 0, skipped: true, reason: "managed-path-integrity" };
      }
      for (const row of derivativeRows) {
        for (const value of [row.preview_path, row.medium_path, row.thumbnail_path]) {
          if (value) referenced.add(resolve(value));
        }
      }
      const cutoff = Date.now() - Math.max(0, Number(olderThanMs) || 0);
      let removed = 0;
      let failed = 0;
      const projects = database.prepare("SELECT id FROM projects").all();
      for (const { id } of projects) {
        for (const dir of [this.previewsDir(id), this.mediumsDir(id), this.thumbnailsDir(id)]) {
          let names;
          try { names = await readdir(dir); } catch (error) { if (error?.code === "ENOENT") continue; throw error; }
          for (const name of names) {
            const path = resolve(join(dir, name));
            if (referenced.has(path)) continue;
            try {
              const info = await lstat(path);
              if (!info.isFile() || info.isSymbolicLink() || info.mtimeMs > cutoff) continue;
              await unlink(path);
              removed += 1;
            } catch (error) {
              if (error?.code !== "ENOENT") failed += 1;
            }
          }
        }
      }
      return { removed, failed };
    },
    /**
     * Completion flag for the one-shot reference hard-link migration, kept in
     * library_meta. Reading it is cheap, so every store construction can
     * schedule the migration; only the first pass ever does work.
     */
    async isReferenceHardlinkMigrationDone() {
      return Boolean(database.prepare("SELECT value FROM library_meta WHERE key = ?").get(REFERENCE_HARDLINK_MIGRATION_KEY)?.value);
    },
    async completeReferenceHardlinkMigration() {
      database.prepare(`
        INSERT INTO library_meta (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(REFERENCE_HARDLINK_MIGRATION_KEY, now(), now());
    },
    close() {
      // WAL note: this database opens with `journal_mode = WAL` (see createSqliteDatabase()).
      // better-sqlite3's close() performs a final implicit WAL checkpoint, but we issue an
      // explicit TRUNCATE here so the WAL file is collapsed before we drop the connection.
      // That guarantees the next opener starts on a fresh WAL and avoids leaving a stale
      // `-wal` file behind when the runtime is replaced during an in-place update.
      if (existsSync(libraryDir) && existsSync(databasePath)) {
        try {
          database.pragma("wal_checkpoint(TRUNCATE)");
        } catch {
          // pragma is a no-op if the WAL is already empty or the journal mode has changed.
        }
      }
      database.close();
    },
  };

  // Best-effort one-shot: turn duplicated reference attachments into hard
  // links against their library originals. The library_meta flag makes this a
  // single boolean read on every later open, and the migration itself is safe
  // to interrupt and re-run.
  scheduleReferenceHardlinkMigration(store, libraryDir);

  return store;
}

// --- Derived-column markers and the batched background repair runner --------
//
// Rule 27 (2026-10-28): whole-library checks and whole-library repairs run
// after the service listens, in batches, never on the open path. The `ensure*`
// repairs below split in two:
// - Structural work (ALTER TABLE ADD COLUMN, CREATE INDEX IF NOT EXISTS) stays
//   synchronous in initializeSchema — both are catalog-only and cheap.
// - Whole-table probes and whole-table repairs are marker-gated and, unless a
//   stale value would corrupt a later write, deferred to background batches.
//

// Test-only hook (task 347): the SIGKILL-resume test needs the process to die
// after a known number of committed batches of one named pass. The variable
// reads "<pass-name>:<batch-count>" (e.g. "search-scope:3") and is never set
// outside that test.
function maybeKillTestProcessAfterBatch(passName, batchIndex) {
  const spec = String(process.env.MOSA_TEST_DEFERRED_MAINTENANCE_KILL_AFTER_BATCH || "");
  const [name, count] = spec.split(":");
  if (name === passName && Number(count) > 0 && batchIndex >= Number(count)) {
    process.kill(process.pid, "SIGKILL");
  }
}

/**
 * Runs one deferred repair pass in keyset-paged batches: `selectBatch`
 * returns the rows still needing work (stale rows only — every batch's
 * UPDATE re-checks its stale predicate, so a batch is idempotent and two
 * processes racing produce the same result as one), `applyBatch` rewrites
 * them inside one short BEGIN IMMEDIATE transaction, and the runner yields
 * to the event loop between batches. When the marker is already current the
 * pass is skipped entirely. The completion marker is written inside the last
 * batch's transaction (or the empty-page transaction when the stale set is an
 * exact multiple of the batch size), so a crash either reruns the pass or
 * commits it whole.
 */
async function runBatchedDerivedRepair(database, {
  passName,
  markerKey,
  markerVersion,
  batchSize = DERIVED_MAINTENANCE_BATCH_SIZE,
  selectBatch,
  applyBatch,
  onBatchCommitted,
  onBatchResult,
  signal,
}) {
  if (derivedMarkerCurrent(database, markerKey, markerVersion)) return;
  let cursorProject = "";
  let cursorId = "";
  let batchIndex = 0;
  for (;;) {
    // Rework 1: a shutdown abort stops the pass between two batches — never
    // inside a transaction. The marker is only written with the final batch,
    // so the next open redoes whatever this run left.
    if (signal?.aborted) return;
    let lastKey = null;
    let pageWasShort = false;
    const processed = database.transaction(() => {
      // Re-checked under the write lock: a concurrent opener may have
      // finished this pass between the pre-read and acquiring the lock.
      if (derivedMarkerCurrent(database, markerKey, markerVersion)) return null;
      const rows = selectBatch(cursorProject, cursorId, batchSize);
      const changed = rows.length ? (applyBatch(rows) || 0) : 0;
      pageWasShort = rows.length < batchSize;
      lastKey = rows.length ? rows[rows.length - 1] : null;
      if (pageWasShort) writeDerivedMarker(database, markerKey, markerVersion);
      return { changed, rows };
    }).immediate();
    if (!processed || !lastKey) break;
    if (processed.changed > 0 && typeof onBatchResult === "function") {
      onBatchResult({ changed: processed.changed, projects: [...new Set(processed.rows.map((row) => row.project_id))] });
    }
    cursorProject = lastKey.project_id;
    cursorId = lastKey.id;
    batchIndex += 1;
    maybeKillTestProcessAfterBatch(passName, batchIndex);
    if (typeof onBatchCommitted === "function") onBatchCommitted();
    if (pageWasShort) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Background re-derivation of created_at/created_at_epoch (marker
 * derived:created_at_epoch): the batched equivalent of the whole-table pair of
 * UPDATEs ensureCreatedAtEpoch used to run on open. The UPDATE re-checks the
 * stale predicate per row, so visiting only stale keys is equivalent to the
 * original whole-table statement, and the asset_versions sync is restricted
 * to the same batch's assets (every asset lands in exactly one batch over the
 * pass, so nothing is skipped).
 */
async function rederiveCreatedAtEpochBatched(database, options = {}) {
  await runBatchedDerivedRepair(database, {
    passName: "created_at_epoch",
    markerKey: DERIVED_CREATED_AT_EPOCH_MARKER,
    markerVersion: DERIVED_CREATED_AT_EPOCH_VERSION,
    ...options,
    selectBatch: (project, id, limit) => database.prepare(`
      SELECT project_id, id FROM assets
      WHERE (created_at != mosa_normalize_created_at(created_at)
        OR created_at_epoch IS NOT mosa_created_at_epoch(created_at))
        AND (project_id > ? OR (project_id = ? AND id > ?))
      ORDER BY project_id, id
      LIMIT ?
    `).all(project, project, id, limit),
    applyBatch: (rows) => {
      const keys = rows.map((row) => [row.project_id, row.id]);
      const placeholders = keys.map(() => "(?, ?)").join(", ");
      const params = keys.flat();
      const changed = database.prepare(`
        UPDATE assets SET
          created_at = mosa_normalize_created_at(created_at),
          created_at_epoch = mosa_created_at_epoch(created_at)
        WHERE (project_id, id) IN (VALUES ${placeholders})
          AND (created_at != mosa_normalize_created_at(created_at)
            OR created_at_epoch IS NOT mosa_created_at_epoch(created_at))
      `).run(...params).changes;
      database.prepare(`
        UPDATE asset_versions SET created_at = (
          SELECT assets.created_at FROM assets
          WHERE assets.project_id = asset_versions.project_id AND assets.id = asset_versions.asset_id
        )
        WHERE EXISTS (
          SELECT 1 FROM assets
          WHERE assets.project_id = asset_versions.project_id
            AND assets.id = asset_versions.asset_id
            AND assets.created_at != asset_versions.created_at
        )
          AND (project_id, asset_id) IN (VALUES ${placeholders})
      `).run(...params);
      return changed;
    },
  });
}

/** Background re-derivation of sort_name (marker derived:sort_name). */
async function rederiveSortNameBatched(database, options = {}) {
  await runBatchedDerivedRepair(database, {
    passName: "sort_name",
    markerKey: DERIVED_SORT_NAME_MARKER,
    markerVersion: DERIVED_SORT_NAME_VERSION,
    ...options,
    selectBatch: (project, id, limit) => database.prepare(`
      SELECT project_id, id FROM assets
      WHERE sort_name IS NOT mosa_sort_name(theme, asset, id)
        AND (project_id > ? OR (project_id = ? AND id > ?))
      ORDER BY project_id, id
      LIMIT ?
    `).all(project, project, id, limit),
    applyBatch: (rows) => {
      const keys = rows.map((row) => [row.project_id, row.id]);
      const placeholders = keys.map(() => "(?, ?)").join(", ");
      return database.prepare(`
        UPDATE assets SET sort_name = mosa_sort_name(theme, asset, id)
        WHERE (project_id, id) IN (VALUES ${placeholders})
          AND sort_name IS NOT mosa_sort_name(theme, asset, id)
      `).run(...keys.flat()).changes;
    },
  });
}

// Rows the backfill still has to fix. An unnamed stack with no live member
// already holds the right sort_name (''), so it is not selected — otherwise
// it would be "fixed" and announced on every pass.
const STACK_SORT_COLUMNS_NEED_BACKFILL_SQL = `(
  sort_created_at = ''
  OR (sort_name = '' AND name = '' AND ${STACK_LIVE_COVER_SORT_NAME_SQL} != '')
)`;

/** Background backfill of empty stack sort keys (marker
 * derived:stack_sort_columns) — the batched form of the whole-table UPDATE
 * ensureAssetStackSortColumns used to run on every open. */
async function backfillStackSortColumnsBatched(database, options = {}) {
  await runBatchedDerivedRepair(database, {
    passName: "stack_sort_columns",
    markerKey: DERIVED_STACK_SORT_COLUMNS_MARKER,
    markerVersion: DERIVED_STACK_SORT_COLUMNS_VERSION,
    ...options,
    selectBatch: (project, id, limit) => database.prepare(`
      SELECT project_id, id FROM asset_stacks
      WHERE ${STACK_SORT_COLUMNS_NEED_BACKFILL_SQL}
        AND (project_id > ? OR (project_id = ? AND id > ?))
      ORDER BY project_id, id
      LIMIT ?
    `).all(project, project, id, limit),
    applyBatch: (rows) => {
      const keys = rows.map((row) => [row.project_id, row.id]);
      const placeholders = keys.map(() => "(?, ?)").join(", ");
      return database.prepare(`
        UPDATE asset_stacks
        SET sort_created_at = COALESCE(NULLIF(sort_created_at, ''), (
              SELECT a.created_at
              FROM asset_stack_members sm
              JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
              WHERE sm.project_id = asset_stacks.project_id AND sm.stack_id = asset_stacks.id AND sm.position = 0
            ), created_at),
            sort_name = CASE WHEN name != '' THEN mosa_sort_name(name, '', id)
              ELSE COALESCE(NULLIF(sort_name, ''), ${STACK_LIVE_COVER_SORT_NAME_SQL}) END
        WHERE (project_id, id) IN (VALUES ${placeholders})
          AND ${STACK_SORT_COLUMNS_NEED_BACKFILL_SQL}
      `).run(...keys.flat()).changes;
    },
  });
}

/** Background re-derivation of stack sort_created_at (marker
 * derived:stack_sort_created_at). Batches the whole-table rederive that used
 * to run on every open; per-stack writes keep using refreshStackSortCreatedAt,
 * which does not depend on this sweep. */
async function rederiveStackSortCreatedAtBatched(database, options = {}) {
  await runBatchedDerivedRepair(database, {
    passName: "stack_sort_created_at",
    markerKey: DERIVED_STACK_SORT_CREATED_AT_MARKER,
    markerVersion: DERIVED_STACK_SORT_CREATED_AT_VERSION,
    ...options,
    selectBatch: (project, id, limit) => database.prepare(`
      SELECT project_id, id FROM asset_stacks
      WHERE sort_created_at IS NOT ${STACK_SORT_CREATED_AT_SQL}
        AND (project_id > ? OR (project_id = ? AND id > ?))
      ORDER BY project_id, id
      LIMIT ?
    `).all(project, project, id, limit),
    applyBatch: (rows) => {
      const keys = rows.map((row) => [row.project_id, row.id]);
      const placeholders = keys.map(() => "(?, ?)").join(", ");
      return database.prepare(`
        UPDATE asset_stacks SET sort_created_at = ${STACK_SORT_CREATED_AT_SQL}
        WHERE (project_id, id) IN (VALUES ${placeholders})
          AND sort_created_at IS NOT ${STACK_SORT_CREATED_AT_SQL}
      `).run(...keys.flat()).changes;
    },
  });
}

/** A stack sorts by its newest member's date, so a stack that gains a fresh
 * capture moves up with it instead of staying where its oldest cover sat.
 * Members in the trash do not count while any member is still live. */
// Exported for tests: the EXPLAIN QUERY PLAN assertions pin the plan of the
// exact expression the store runs (audit 261 mid-8).
export const STACK_SORT_CREATED_AT_SQL = `COALESCE((
    SELECT MAX(a.created_at)
    FROM asset_stack_members sm
    JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
    -- The unary plus keeps the planner off assets_project_deleted_idx: with the
    -- bare column it walked the trash-time index per stack, making the sweep
    -- quadratic in stack members (audit 261 mid-8). "+deleted_at IS NULL" is
    -- still exact (NULL stays NULL, trash rows stay excluded) but only the
    -- member-table join and the assets primary key are usable.
    WHERE sm.project_id = asset_stacks.project_id AND sm.stack_id = asset_stacks.id AND +a.deleted_at IS NULL
  ), (
    SELECT MAX(a.created_at)
    FROM asset_stack_members sm
    JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
    WHERE sm.project_id = asset_stacks.project_id AND sm.stack_id = asset_stacks.id
  ), NULLIF(sort_created_at, ''), created_at)`;

function refreshStackSortCreatedAt(database, projectId, stackId) {
  database.prepare(`UPDATE asset_stacks SET sort_created_at = ${STACK_SORT_CREATED_AT_SQL} WHERE project_id = ? AND id = ?`)
    .run(projectId, stackId);
}

function openDatabase(databasePath) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  // Reminder for every mosa_* derivation function below: when one of them
  // changes its output, bump the matching `DERIVED_*_VERSION` constant — the
  // derived:* markers in library_meta gate the re-derivation passes, and an
  // unbumped version leaves stale values unrepaired (see the derived-column
  // markers block above ensureCreatedAtEpoch).
  // `recent` must not be decided by lexicographic TEXT comparison: SQL NULL is excluded by a
  // `>=` test, but an arbitrary TEXT date is never format-checked, so legacy values such as
  // "Sat, 01 Jan 2000 00:00:00 GMT" used to compare above an ISO cutoff. Exposing the shared
  // parser to SQL keeps this store's answers identical to the JSON store's. Unusable values
  // return NULL, which no comparison can satisfy.
  database.function("mosa_created_at_epoch", { deterministic: true }, (value) => createdAtTimestamp(value));
  database.function("mosa_normalize_created_at", { deterministic: true }, (value) => {
    if (typeof value !== "string") return value == null ? null : String(value);
    return normalizeCreatedAt(value, value);
  });
  // Name ordering has to agree with the label the gallery renders, and with the
  // JS comparator the JSON store uses, so the key is computed by one shared
  // helper rather than reimplemented in SQL.
  database.function("mosa_sort_name", { deterministic: true }, (theme, asset, id) => assetSortName({ theme, asset, id }));
  // The two scoring columns read the search-scope whitelist (lib/asset-search-scope.mjs).
  // The source variant also takes the canonical source type so the searchable
  // display name (ChatGPT, Codex, …) lands in source_search_text exactly like
  // the JS writers build it.
  database.function("mosa_business_search_text", { deterministic: true }, (json) => searchableBusinessObjectText(parseJson(json, {})));
  database.function("mosa_source_search_text", { deterministic: true }, (json, sourceGroup) => searchableSourceObjectText(parseJson(json, {}), String(sourceGroup || "")));
  // The searchable name (machine-generated segments stripped, see
  // asset-search-scope.mjs) and the whole-string exact match it pairs with:
  // scoring "contains" terms run against the stripped name, while pasting a
  // full id / file name from the Inspector must still find that one asset via
  // the raw values.
  database.function("mosa_searchable_asset_name", { deterministic: true }, (value) => searchableAssetName(value));
  database.function("mosa_asset_exact_match", { deterministic: true }, (id, asset, query) => {
    const wanted = String(query ?? "").trim().toLowerCase();
    if (!wanted) return 0;
    if (String(id ?? "").toLowerCase() === wanted) return 1;
    const name = String(asset ?? "");
    if (name.toLowerCase() === wanted) return 1;
    return assetFileNameStem(name).toLowerCase() === wanted ? 1 : 0;
  });
  database.function("mosa_short_search_terms_json", { deterministic: true }, (value) => JSON.stringify(shortUnicodeSearchTerms(value)));
  database.function("mosa_canonical_source_type", { deterministic: true }, (sourceType, businessFieldsJson, sourceJson) => canonicalSourceTypeOf({
    source_type: sourceType,
    source: parseJson(sourceJson, {}),
    business_fields: parseJson(businessFieldsJson, {}),
  }));
  // Session keys are materialised into an indexed column so stacking lookups
  // never parse source_json per row. The shared helper (not a SQL re-derivation)
  // keeps the column identical to what saveAsset writes.
  database.function("mosa_generation_session_key", { deterministic: true }, (sourceType, businessFieldsJson, sourceJson) => generationSessionKey({
    source_type: sourceType,
    source: parseJson(sourceJson, {}),
    business_fields: parseJson(businessFieldsJson, {}),
  }));
  database.function("mosa_asset_matches_search_kind", { deterministic: true }, (
    kind, asset, id, prompt, skill, style, theme, group, category, tagsText,
  ) => assetMatchesSearchKind({
    asset,
    id,
    prompt,
    skill,
    style,
    theme,
    group,
    category,
    tags: String(tagsText || "").split("\u001f").filter(Boolean),
  }, String(kind || "")) ? 1 : 0);
  // V2 FilterBar type filter: classify media in SQL with the same rule the gallery
  // uses (business_fields/source media_kind first, then the file extension), so the
  // server-side count and page agree with what the cards render.
  database.function("mosa_media_kind", { deterministic: true }, (businessFieldsJson, sourceJson, originalPath) => mediaKindOf({ business_fields: parseJson(businessFieldsJson), source: parseJson(sourceJson), image_path: originalPath }));
  database.pragma("journal_mode = WAL");
  // Task 416 (audit 建1 journal_size_limit): cap the WAL file after
  // checkpoints. Without a limit one long write burst can grow the -wal file
  // indefinitely and it stays that large afterwards; 64 MiB keeps it bounded
  // without forcing more frequent checkpoints.
  database.pragma("journal_size_limit = 67108864");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.pragma("cache_size = -20000");
  database.pragma("temp_store = MEMORY");
  return database;
}

// Task 350 (audit 5-2 #3): the whole upgrade — table creation, the ensure*
// passes, every migration step, the pre-v10 candidate sync, the version bump,
// the migration rows and the pending verify record — commits in ONE immediate
// transaction that re-reads the version under the write lock, so concurrent
// first-time openers serialize instead of racing, and a kill anywhere inside
// rolls the whole upgrade back. A plain reopen (already current) takes no
// write lock on the happy path: tables + ensure* passes + a cheap probe for
// missing migration rows (audit 5-2 #8).
const SCHEMA_UPGRADE_LOCK_WAIT_MS = 60_000;

function initializeSchema(database, { upgrade = null, libraryDir = "" } = {}) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS library_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
  `);
  const existingVersion = readSqliteSchemaVersionRow(database);
  if (existingVersion > CURRENT_SCHEMA_VERSION) {
    throw newerSchemaLibraryError(existingVersion, libraryDir);
  }

  if (existingVersion >= CURRENT_SCHEMA_VERSION) {
    createSqliteSchemaTables(database);
    runSchemaEnsurePasses(database, existingVersion);
    fillMissingSchemaMigrationRows(database);
    return { upgraded: false };
  }

  // Upgrade path. The busy timeout stretches for this one transaction: with
  // two openers the loser waits for the winner's full upgrade instead of
  // failing the open (task 350 #3; the 60s cap is the wait bound).
  database.pragma(`busy_timeout = ${SCHEMA_UPGRADE_LOCK_WAIT_MS}`);
  let outcome;
  try {
    outcome = database.transaction(() => {
      // Re-read under the write lock: another process may have committed this
      // exact upgrade between our snapshot and our lock.
      const lockedVersion = readSqliteSchemaVersionRow(database);
      if (lockedVersion >= CURRENT_SCHEMA_VERSION) return "already-current";
      createSqliteSchemaTables(database);
      runSchemaEnsurePasses(database, lockedVersion);
      if (lockedVersion < 3) backfillRecipeSnapshots(database);
      const timestamp = now();
      if (lockedVersion < 16) backfillAutoSessionStacks(database, timestamp);
      if (lockedVersion < 17) regroupJimengWorkspaceStacks(database, timestamp);
      // Task 348: v<15 libraries backfill short terms straight into the new
      // (term, doc_id) shape inside migrateSearchIndexToDocIds — the old
      // project/asset/term table is never written again.
      if (lockedVersion < 18) migrateSearchIndexToDocIds(database, lockedVersion, timestamp);
      // One migration row per step (task 350 audit 5-2 #8: 14–16 were missing).
      const migrationInsert = database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)");
      for (let version = 1; version <= CURRENT_SCHEMA_VERSION; version += 1) {
        migrationInsert.run(version, timestamp);
      }
      // Moved inside the upgrade transaction (task 350 audit 5-2 #8): the old
      // post-commit position made a kill in between skip it forever.
      if (lockedVersion < 10) {
        const projectIds = database.prepare("SELECT id FROM projects ORDER BY id").all().map((row) => row.id);
        for (const projectId of projectIds) syncSqliteGenerationRelationCandidates(database, projectId);
      }
      database.prepare(`
        INSERT INTO library_meta (key, value, updated_at) VALUES ('schema_version', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        WHERE library_meta.value != excluded.value
      `).run(String(CURRENT_SCHEMA_VERSION), timestamp);
      database.prepare("INSERT OR IGNORE INTO library_meta (key, value, updated_at) VALUES ('migration_state', 'unmigrated', ?)").run(timestamp);
      // Task 347 rework 1 (2c), now atomic with the upgrade (task 350 #3): a
      // process killed before background maintenance starts — or an upgrade
      // performed by an MCP/CLI process, which never runs maintenance — must
      // still leave a pending record.
      if (upgrade) {
        markPendingSchemaUpgradeVerify(database, {
          targetVersion: CURRENT_SCHEMA_VERSION,
          backupPath: upgrade.backupPath,
        });
      }
      // Test-only kill point (task 350): mid-transaction, so the test proves
      // the rollback leaves the pre-upgrade state untouched.
      maybeKillSchemaUpgradeTestProcess("mid-upgrade");
      // Test-only hold (task 350 concurrency test): keeps the write lock busy
      // so the concurrent losers deterministically reach the in-lock re-read
      // AFTER the winner committed. Never set outside that test.
      const holdMs = Number(process.env.MOSA_TEST_SCHEMA_UPGRADE_HOLD_MS) > 0
        ? Number(process.env.MOSA_TEST_SCHEMA_UPGRADE_HOLD_MS)
        : 0;
      if (holdMs > 0) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
      }
      return "upgraded";
    }).immediate();
  } finally {
    database.pragma("busy_timeout = 5000");
  }
  if (outcome === "already-current") return { upgraded: false, upgradeAborted: true };
  return { upgraded: true };
}

function readSqliteSchemaVersionRow(database) {
  const schemaRow = database.prepare("SELECT value FROM library_meta WHERE key = 'schema_version'").get();
  const existingVersion = schemaRow ? Number(schemaRow.value) : 0;
  if (!Number.isInteger(existingVersion) || existingVersion < 0) {
    throw new Error(`Invalid GravityPort schema version: ${schemaRow?.value ?? ""}`);
  }
  return existingVersion;
}

function createSqliteSchemaTables(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS groups (project_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, position INTEGER, color TEXT NOT NULL DEFAULT '', PRIMARY KEY (project_id, name));
    CREATE UNIQUE INDEX IF NOT EXISTS groups_project_name_ci_idx ON groups(project_id, name COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS assets (
      project_id TEXT NOT NULL,
      id TEXT NOT NULL,
      asset TEXT NOT NULL,
      original_path TEXT NOT NULL,
      preview_path TEXT,
      medium_path TEXT,
      thumbnail_path TEXT,
      content_sha256 TEXT NOT NULL,
      pixel_sha256 TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL,
      skill TEXT NOT NULL,
      style TEXT NOT NULL,
      ratio TEXT NOT NULL,
      business_fields_json TEXT NOT NULL,
      theme TEXT NOT NULL,
      favorite INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      group_name TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      rating INTEGER NOT NULL DEFAULT 0,
      parent_asset_id TEXT,
      version_change TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL,
      source_json TEXT NOT NULL,
      source_path TEXT NOT NULL DEFAULT '',
      provider_asset_id TEXT NOT NULL DEFAULT '',
      logical_output_id TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL,
      search_text TEXT NOT NULL,
      tags_text TEXT NOT NULL DEFAULT '',
      business_search_text TEXT NOT NULL DEFAULT '',
      source_search_text TEXT NOT NULL DEFAULT '',
      media_kind TEXT NOT NULL DEFAULT 'unknown',
      source_group TEXT NOT NULL DEFAULT '',
      conversation_id TEXT NOT NULL DEFAULT '',
      generation_batch TEXT NOT NULL DEFAULT '',
      palette_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, id),
      UNIQUE (project_id, asset)
    );
    CREATE INDEX IF NOT EXISTS assets_project_created_idx ON assets(project_id, archived, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS assets_project_hash_idx ON assets(project_id, content_sha256);
    CREATE INDEX IF NOT EXISTS assets_project_group_created_idx ON assets(project_id, archived, group_name, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS assets_project_category_created_idx ON assets(project_id, archived, category, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS assets_project_style_created_idx ON assets(project_id, archived, style, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS assets_project_favorite_created_idx ON assets(project_id, archived, created_at DESC, id DESC)
      WHERE rating > 0 OR favorite = 1;
    CREATE TABLE IF NOT EXISTS asset_perceptual_hashes (
      project_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      algorithm TEXT NOT NULL,
      hash TEXT NOT NULL,
      pixel_sha256 TEXT NOT NULL DEFAULT '',
      pixel_hash_version TEXT NOT NULL DEFAULT '',
      computed_at TEXT NOT NULL,
      PRIMARY KEY (project_id, asset_id)
    );
    CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, normalized_name TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS asset_tags (project_id TEXT NOT NULL, asset_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (project_id, asset_id, tag_id));
    CREATE TABLE IF NOT EXISTS asset_versions (project_id TEXT NOT NULL, asset_id TEXT NOT NULL, parent_asset_id TEXT, change_summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, PRIMARY KEY (project_id, asset_id));
    CREATE TABLE IF NOT EXISTS asset_stacks (
      project_id TEXT NOT NULL,
      id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sort_created_at TEXT NOT NULL DEFAULT '',
      sort_name TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (project_id, id)
    );
    CREATE TABLE IF NOT EXISTS asset_stack_members (
      project_id TEXT NOT NULL,
      stack_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (project_id, asset_id),
      UNIQUE (project_id, stack_id, position),
      FOREIGN KEY (project_id, stack_id) REFERENCES asset_stacks(project_id, id) ON DELETE CASCADE,
      FOREIGN KEY (project_id, asset_id) REFERENCES assets(project_id, id) ON DELETE CASCADE,
      CHECK (position >= 0)
    );
    CREATE INDEX IF NOT EXISTS asset_stack_members_stack_position_idx ON asset_stack_members(project_id, stack_id, position, asset_id);
    CREATE TABLE IF NOT EXISTS generation_events (
      project_id TEXT NOT NULL,
      id TEXT NOT NULL,
      output_asset_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT '',
      capture_context_id TEXT NOT NULL DEFAULT '',
      provider_tool_call_id TEXT NOT NULL DEFAULT '',
      provider_generation_call_id TEXT NOT NULL DEFAULT '',
      provider_response_id TEXT NOT NULL DEFAULT '',
      provider_asset_id TEXT NOT NULL DEFAULT '',
      conversation_id TEXT NOT NULL DEFAULT '',
      message_id TEXT NOT NULL DEFAULT '',
      batch_id TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      user_prompt TEXT NOT NULL DEFAULT '',
      effective_prompt TEXT NOT NULL DEFAULT '',
      prompt_status TEXT NOT NULL DEFAULT '',
      prompt_scope TEXT NOT NULL DEFAULT '',
      generation_status TEXT NOT NULL DEFAULT 'unknown',
      capture_channel TEXT NOT NULL DEFAULT '',
      verification_level TEXT NOT NULL DEFAULT 'observed',
      references_json TEXT NOT NULL DEFAULT '[]',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, id),
      FOREIGN KEY (project_id, output_asset_id) REFERENCES assets(project_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS generation_events_asset_idx ON generation_events(project_id, output_asset_id, created_at, id);
    CREATE INDEX IF NOT EXISTS generation_events_context_idx ON generation_events(project_id, capture_context_id, created_at, id);
    CREATE INDEX IF NOT EXISTS generation_events_provider_call_idx ON generation_events(project_id, provider, provider_generation_call_id, created_at, id);
    CREATE TABLE IF NOT EXISTS generation_relations (
      project_id TEXT NOT NULL,
      child_generation_id TEXT NOT NULL,
      parent_generation_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      verification_level TEXT NOT NULL DEFAULT 'inferred',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, child_generation_id, parent_generation_id, relation_type),
      FOREIGN KEY (project_id, child_generation_id) REFERENCES generation_events(project_id, id) ON DELETE CASCADE,
      FOREIGN KEY (project_id, parent_generation_id) REFERENCES generation_events(project_id, id) ON DELETE CASCADE,
      CHECK (child_generation_id != parent_generation_id)
    );
    CREATE INDEX IF NOT EXISTS generation_relations_parent_idx ON generation_relations(project_id, parent_generation_id, created_at, child_generation_id);
    CREATE INDEX IF NOT EXISTS generation_relations_child_idx ON generation_relations(project_id, child_generation_id, created_at, parent_generation_id);
    CREATE TABLE IF NOT EXISTS generation_relation_candidates (
      project_id TEXT NOT NULL,
      child_generation_id TEXT NOT NULL,
      parent_generation_id TEXT NOT NULL,
      suggested_relation_type TEXT NOT NULL DEFAULT 'derived_from',
      confidence REAL NOT NULL DEFAULT 0,
      verification_level TEXT NOT NULL DEFAULT 'inferred',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'suggested',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, child_generation_id, parent_generation_id),
      FOREIGN KEY (project_id, child_generation_id) REFERENCES generation_events(project_id, id) ON DELETE CASCADE,
      FOREIGN KEY (project_id, parent_generation_id) REFERENCES generation_events(project_id, id) ON DELETE CASCADE,
      CHECK (child_generation_id != parent_generation_id),
      CHECK (status IN ('suggested', 'dismissed', 'confirmed'))
    );
    CREATE INDEX IF NOT EXISTS generation_relation_candidates_child_idx ON generation_relation_candidates(project_id, child_generation_id, status, confidence DESC);
    CREATE INDEX IF NOT EXISTS generation_relation_candidates_parent_idx ON generation_relation_candidates(project_id, parent_generation_id, status, confidence DESC);
    CREATE TABLE IF NOT EXISTS recipe_snapshots (
      project_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      recipe_digest TEXT NOT NULL,
      prompt_digest TEXT NOT NULL,
      effective_prompt TEXT NOT NULL,
      user_prompt TEXT NOT NULL,
      negative_prompt TEXT NOT NULL,
      prompt_status TEXT NOT NULL,
      generation_tool TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      skill TEXT NOT NULL,
      style TEXT NOT NULL,
      ratio TEXT NOT NULL,
      theme TEXT NOT NULL,
      references_json TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      change_summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, asset_id, snapshot_id),
      FOREIGN KEY (project_id, asset_id) REFERENCES assets(project_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS derivative_jobs (project_id TEXT NOT NULL, asset_id TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (project_id, asset_id));
    CREATE INDEX IF NOT EXISTS derivative_jobs_status_idx ON derivative_jobs(status, created_at);
    CREATE TABLE IF NOT EXISTS migration_issues (id TEXT PRIMARY KEY, kind TEXT NOT NULL, path TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pending_derivative_changes (
      project_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, asset_id)
    );
    CREATE INDEX IF NOT EXISTS pending_derivative_changes_updated_idx ON pending_derivative_changes(project_id, updated_at, asset_id);
    CREATE TABLE IF NOT EXISTS library_changes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      kind TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT 'asset',
      entity_id TEXT NOT NULL DEFAULT '',
      flags_json TEXT NOT NULL DEFAULT '[]',
      asset_ids_json TEXT NOT NULL DEFAULT '[]',
      detail_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS library_changes_project_revision_idx ON library_changes(project_id, revision);
    CREATE TABLE IF NOT EXISTS automatic_ingest_suppressions (
      project_id TEXT NOT NULL,
      content_sha256 TEXT NOT NULL DEFAULT '',
      pixel_sha256 TEXT NOT NULL DEFAULT '',
      pixel_hash_version TEXT NOT NULL DEFAULT '',
      deleted_at TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'user-deleted',
      PRIMARY KEY (project_id, content_sha256, pixel_sha256, pixel_hash_version),
      CHECK (content_sha256 != '' OR pixel_sha256 != '')
    );
    CREATE INDEX IF NOT EXISTS automatic_suppressions_project_content_idx ON automatic_ingest_suppressions(project_id, content_sha256, deleted_at DESC);
    CREATE INDEX IF NOT EXISTS automatic_suppressions_project_pixel_idx ON automatic_ingest_suppressions(project_id, pixel_sha256, deleted_at DESC);
    CREATE INDEX IF NOT EXISTS automatic_suppressions_project_deleted_idx ON automatic_ingest_suppressions(project_id, deleted_at DESC, content_sha256, pixel_sha256, pixel_hash_version);
    CREATE TABLE IF NOT EXISTS automatic_ingest_identity_suppressions (
      project_id TEXT NOT NULL,
      logical_output_id TEXT NOT NULL,
      media_kind TEXT NOT NULL DEFAULT 'image',
      deleted_at TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'user-deleted',
      PRIMARY KEY (project_id, logical_output_id, media_kind)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS asset_fts USING fts5(project_id UNINDEXED, asset_id UNINDEXED, content, tokenize='trigram');
    CREATE TABLE IF NOT EXISTS asset_search_docs (
      doc_id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      UNIQUE(project_id, asset_id)
    );
    CREATE TABLE IF NOT EXISTS asset_search_terms (
      term TEXT NOT NULL,
      doc_id INTEGER NOT NULL,
      PRIMARY KEY (term, doc_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS asset_versions_parent_idx ON asset_versions(project_id, parent_asset_id, created_at, asset_id);
    CREATE INDEX IF NOT EXISTS recipe_snapshots_asset_idx ON recipe_snapshots(project_id, asset_id, created_at, snapshot_id);
  `);
}

function runSchemaEnsurePasses(database, existingVersion) {
  ensureCreatedAtEpoch(database);
  ensurePixelHashColumn(database);
  ensureSourcePathColumn(database);
  ensureWebCaptureLookupColumns(database);
  ensureSuppressionPixelHashVersion(database);
  ensureSortName(database);
  ensureAssetStackSortColumns(database);
  ensureMediumPathColumn(database);
  ensureTrashColumn(database);
  ensureSearchScalarColumns(database, existingVersion < 8);
  ensureGenerationEventColumns(database);
  ensureGroupColumns(database);
  ensureGenerationSessionColumn(database);
  ensureAutoStackStructures(database);
  ensureAssetStackOrderLocked(database);
  ensureAssetPaletteColumn(database);
  ensureAssetCanvasStateTable(database);
  ensureGenerationMessageBindingSchema(database);
  // rederiveStackSortCreatedAt moved to startDeferredMaintenance (rule 27):
  // it re-derives every stack's sort key, which is background work behind the
  // derived:stack_sort_created_at marker, never an open prerequisite.
}

// Task 350 (audit 5-2 #8): a current-version library missing migration rows —
// 14–16 were never written by the old code — gets them on open. One cheap
// read probes first, so a complete library never takes a write lock here.
function fillMissingSchemaMigrationRows(database) {
  const present = new Set(
    database.prepare("SELECT version FROM schema_migrations").all().map((row) => Number(row.version)),
  );
  const missing = [];
  for (let version = 1; version <= CURRENT_SCHEMA_VERSION; version += 1) {
    if (!present.has(version)) missing.push(version);
  }
  const migrationStateExists = database.prepare("SELECT 1 FROM library_meta WHERE key = 'migration_state'").get();
  if (!missing.length && migrationStateExists) return;
  const timestamp = now();
  database.transaction(() => {
    const insert = database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)");
    for (const version of missing) insert.run(version, timestamp);
    database.prepare("INSERT OR IGNORE INTO library_meta (key, value, updated_at) VALUES ('migration_state', 'unmigrated', ?)").run(timestamp);
  })();
  // cleanupOrphanedTrashFtsRows moved to startDeferredMaintenance (rule 27):
  // its one DELETE scans the FTS table, which is background work, not a
  // prerequisite for serving the library.
}

// One-time repair for libraries written before syncAssetFtsEntry existed: a
// metadata edit on a trashed asset could re-INSERT its FTS row, and the fast
// FTS count (which never joins assets) then counted it. Runs on every open but
// pays for nothing after the first pass — the library_meta key marks it done.
function cleanupOrphanedTrashFtsRows(database, timestamp) {
  const cleanupKey = "fts_trash_row_cleanup_v1";
  const alreadyDone = database.prepare("SELECT 1 FROM library_meta WHERE key = ?").get(cleanupKey);
  if (alreadyDone) return;
  database.transaction(() => {
    database.prepare(`
      DELETE FROM asset_fts
      WHERE EXISTS (
        SELECT 1 FROM assets a
        WHERE a.project_id = asset_fts.project_id AND a.id = asset_fts.asset_id
          AND a.deleted_at IS NOT NULL AND a.deleted_at != ''
      )
    `).run();
    database.prepare(`
      INSERT INTO library_meta (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(cleanupKey, timestamp, timestamp);
  })();
}

// Task 373: One-time repair moving legacy archived assets into Trash (or back
// to the library if a version parent with active children) and unsetting the
// archived flag.
async function repairArchivedAssetsToTrash(database, helpers = {}) {
  const { store, commitLibraryChanges, invalidateFtsPageCache, signal } = helpers;
  const repairKey = "archived_to_trash_repair_v1";
  const alreadyDone = database.prepare("SELECT 1 FROM library_meta WHERE key = ?").get(repairKey);
  if (alreadyDone) return;

  const rows = database.prepare("SELECT project_id, id, deleted_at FROM assets WHERE archived = 1 ORDER BY created_at ASC, id ASC").all();
  let trashedCount = 0;
  let returnedToLibraryCount = 0;
  let alreadyTrashedCount = 0;

  for (const row of rows) {
    if (signal?.aborted) return;
    const current = await store.getAsset(row.project_id, row.id);
    const metadata = normalizeAssetMetadata({
      ...current,
      archived: false,
      id: current.id,
      project_id: current.project_id,
      asset: current.asset,
      image_path: current.image_path,
      prompt_path: current.prompt_path,
      source: current.source,
      updated_at: now(),
    });
    database.transaction(() => {
      saveAsset(database, metadata, {
        enqueueDerivative: false,
        recipeSnapshot: buildRecipeSnapshot(metadata, {
          createdAt: metadata.updated_at,
          changeSummary: "Recipe updated",
        }),
        libraryChanges: [{ projectId: row.project_id, kind: "asset-updated", entityType: "asset", entityId: row.id }],
      }, { commitLibraryChanges });
    })();

    if (row.deleted_at) {
      alreadyTrashedCount += 1;
      continue;
    }

    try {
      await store.deleteAsset(row.project_id, row.id, { reason: "archived-before-373" });
      trashedCount += 1;
    } catch (error) {
      // The asset is already visible again (archived = 0), so a failed move
      // leaves it in the library rather than hidden; the user can delete it.
      returnedToLibraryCount += 1;
      if (error?.code === "VERSION_PARENT_HAS_CHILDREN") {
        console.warn(`[MOSA] archived version parent ${row.id} has active children; returned to library instead of trash.`);
      } else {
        const code = error && typeof error.code === "string" ? error.code : "unknown";
        console.warn(`[MOSA] archived asset ${row.id} could not be moved to Trash (${code}); it stays in the library.`);
      }
    }
  }

  const timestamp = now();
  database.prepare(`
    INSERT INTO library_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(repairKey, timestamp, timestamp);

  if (typeof invalidateFtsPageCache === "function") invalidateFtsPageCache();
  console.info(`[MOSA] archived-to-trash repair: ${trashedCount} moved to trash, ${returnedToLibraryCount} returned to library, ${alreadyTrashedCount} already in trash.`);
}

const REFERENCE_HARDLINK_MIGRATION_KEY = "reference_hardlink_migration_done_v1";

const DERIVATIVE_COLUMNS = new Map([
  ["preview", "preview_path"],
  ["medium", "medium_path"],
  ["thumbnail", "thumbnail_path"],
]);

