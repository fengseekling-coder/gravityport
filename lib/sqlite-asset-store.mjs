import Database from "better-sqlite3";
import { constants as fsConstants, createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { copyFile, link, lstat, mkdir, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import sharp from "./sharp-runtime.js";
import {
  derivativeTempFileName,
  publishDerivativeFile,
  removeStaleDerivativeTempFiles,
} from "./derivative-temp-file.js";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
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
  pickVersionOverrides,
  requireVersionChange,
  versionParentError,
} from "./asset-version-history.mjs";
import { createdAtTimestamp, normalizeCreatedAt, recentCutoffTimestamp } from "./recent-window.js";
import { normalizeAssetCuration } from "./asset-curation.mjs";
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
  ASSET_SEARCH_WEIGHTS,
  assetMatchesSearchKind,
  assetSearchKind,
  normalizeAssetSearchQuery,
} from "./asset-search.mjs";
import {
  conversationalAssetSearchPlan,
  designVocabularySearchPlan,
  finalizeConversationalSearchPlan,
} from "./asset-search-query-plan.mjs";
import { relinkCodexAssets } from "./codex-hardlink.js";
import { PIXEL_HASH_VERSION, safePixelDigest } from "./image-pixel-hash.js";
import { readVideoMetadataFromFile, readVideoMetadataFromFileSync } from "./video-metadata.js";
import { resolveSourceLocations } from "./source-locations.js";
import {
  ensureSchemaUpgradeBackup,
  schemaUpgradeRecoveryError,
  verifySchemaUpgradeResult,
} from "./schema-upgrade-backup.mjs";
import { cleanupPermanentDeletionStaging, stageFilesForPermanentDeletion } from "./trash-files.mjs";
import { canonicalSourceTypeOf, GENERATION_SESSION_TITLE_MAX_LENGTH, generationSessionKey, generationSessionTitle } from "./generation-session.mjs";
import {
  assetFileNameStem,
  rebuildSearchScopeTexts,
  searchableAssetName,
  searchableBusinessObjectText,
  searchableSourceObjectText,
  searchableBusinessFieldValues,
  searchableSourceValues,
} from "./asset-search-scope.mjs";
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
  resolveGenerationRelationCandidates,
} from "./generation-history.mjs";

const IMAGE_EXTENSIONS = new Set([".apng", ".avif", ".gif", ".jpg", ".jpeg", ".png", ".svg", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".m4v", ".mov", ".mp4", ".webm"]);
const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);
// Shared with the gallery's isVideoAsset rule: explicit media_kind wins, then the
// file extension. Exposed to SQL via mosa_media_kind for the V2 type filter.
function mediaKindOf(asset = {}) {
  const kind = asset?.source?.media_kind || asset?.business_fields?.media_kind;
  if (kind === "video") return "video";
  if (kind === "image") return "image";
  const match = /\.([a-z0-9]+)(?:$|\?)/i.exec(String(asset?.image_path || ""));
  const ext = match ? `.${match[1].toLowerCase()}` : "";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "unknown";
}
const DEFAULT_PROJECT_ID = "default";
// Same cap as MAX_DERIVATIVE_INPUT_PIXELS in derivative-processor.ts. Kept
// local because that module is a worker entry with load-time side effects.
const MAX_DERIVATIVE_INPUT_PIXELS = 40_000_000;

function videoPosterError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.expose = true;
  return error;
}
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 250;
export const STYLE_FACET_LIMIT = 200;
export const CURRENT_SCHEMA_VERSION = 17;
// Bounded change-journal retention: the delta API answers "what happened since
// revision N" from these rows. Anything older is pruned, and a client that asks
// for a pruned revision receives an explicit gap instead of silent data loss.
export const LIBRARY_CHANGE_JOURNAL_LIMIT = 20_000;
export const TRASH_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const PAGE_ASSET_COLUMNS = [
  "project_id", "id", "asset", "original_path", "preview_path", "medium_path", "thumbnail_path",
  "prompt", "skill", "style", "ratio", "business_fields_json", "theme", "favorite", "archived",
  "group_name", "category", "rating", "parent_asset_id", "version_change", "deleted_at", "created_at", "updated_at",
  "source_json", "metadata_json", "sort_name", "palette_json",
].map((column) => `a.${column}`).join(", ");

function tagsSearchText(tags) {
  return (Array.isArray(tags) ? tags : [])
    .map((tag) => String(tag || "").trim())
    .filter(Boolean)
    .join("\u001f");
}

const NORMALIZED_METADATA_KEYS = new Set([
  "id", "project_id", "projectId", "asset", "image_path", "prompt_path", "prompt", "skill", "style", "ratio", "business_fields", "theme",
  "tags", "favorite", "archived", "group", "category", "rating", "parent_asset_id", "parentAssetId", "version_change", "changeSummary",
  "child_asset_ids", "created_at", "updated_at", "source", "sourceType", "imagePath", "fileName", "assetId", "preview_path", "medium_path", "thumbnail_path",
  "image_url", "preview_url", "medium_url", "thumbnail_url", "preview_ready", "medium_ready", "thumbnail_ready", "prompt_file",
  "recipe_snapshots", "active_recipe_snapshot_id", "recipe_change_summary",
]);

export function sqliteDatabasePath(libraryDir) {
  return join(resolve(libraryDir), LIBRARY_DATABASE_FILE);
}

export function hasCompletedSqliteLibrary(libraryDir) {
  const databasePath = sqliteDatabasePath(libraryDir);
  if (!existsSync(databasePath)) return false;
  let database;
  try {
    database = new Database(databasePath, { readonly: true });
    const row = database.prepare("SELECT value FROM library_meta WHERE key = 'migration_state'").get();
    return row?.value === "completed";
  } catch (cause) {
    const error = new Error(`Existing SQLite library could not be verified: ${databasePath}`, { cause });
    error.code = "SQLITE_LIBRARY_UNREADABLE";
    throw error;
  } finally {
    database?.close?.();
  }
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

  const database = openDatabase(databasePath);
  try {
    const schemaBackup = ensureSchemaUpgradeBackup(database, {
      libraryDir,
      targetVersion: CURRENT_SCHEMA_VERSION,
      databaseExisted,
    });
    try {
      initializeSchema(database);
      if (schemaBackup.created) verifySchemaUpgradeResult(database, schemaBackup);
    } catch (error) {
      throw schemaUpgradeRecoveryError(error, schemaBackup);
    }
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
  // One-time capture-history repair (see repair-capture-history.mjs); store
  // helpers are injected so that file needs no exports from this one.
  // Best-effort at open: a failure here (e.g. SQLITE_BUSY while MCP/CLI
  // writes the same library) must not fail the open. Marker and data share
  // one transaction and roll back together, so the next open retries; the
  // catch must never write the marker itself.
  try {
    repairCaptureHistory(database, {
      commitLibraryChanges,
      syncRelationCandidates: syncSqliteGenerationRelationCandidates,
      loadMetadata: (row) => rowToAsset(database, row),
      searchableText,
      syncAssetFtsEntry: (projectId, assetId, searchText, deletedAt) => syncAssetFtsEntry(database, projectId, assetId, searchText, deletedAt),
      replaceAssetShortTerms: (projectId, assetId, searchText) => replaceAssetShortTerms(database, projectId, assetId, searchText),
    });
  } catch (error) {
    // Only the error code/message go to the log — never prompt or user-message
    // text from the rows this pass touches.
    const code = error && typeof error.code === "string" ? `${error.code} ` : "";
    console.warn(`[MOSA] one-time capture-history repair skipped; it retries on the next open: ${code}${error instanceof Error ? error.message : String(error)}`);
  }
  // One-time generation message backfill (see generation-message-binding.mjs).
  // Ordered after the repair above so the backfill works on the post-repair
  // set of events: the two share the duplicate definition, and the repair
  // stays first so cleanup always precedes enrichment in a single open.
  // Same best-effort contract as the repair above: skip on error, the marker
  // rolls back with the data, the next open retries.
  try {
    backfillGenerationMessageIdsFromAssets(database, { commitLibraryChanges });
  } catch (error) {
    const code = error && typeof error.code === "string" ? `${error.code} ` : "";
    console.warn(`[MOSA] one-time generation message backfill skipped; it retries on the next open: ${code}${error instanceof Error ? error.message : String(error)}`);
  }
  // One-time cleared-prompt repair (see repair-cleared-prompts.mjs). Ordered
  // after the two passes above on purpose: the duplicate-event cleanup decides
  // which images still have exactly one generation record, which is one of the
  // repair's conditions. Same best-effort contract: skip on error, the marker
  // rolls back with the data, the next open retries.
  try {
    repairClearedCapturePrompts(database, { commitLibraryChanges });
  } catch (error) {
    const code = error && typeof error.code === "string" ? `${error.code} ` : "";
    console.warn(`[MOSA] one-time cleared-prompt repair skipped; it retries on the next open: ${code}${error instanceof Error ? error.message : String(error)}`);
  }
  // One-time search-scope rebuild (see asset-search-scope.mjs): libraries
  // written before the search whitelist still carry source paths, hashes and
  // capture internals in search_text/FTS/short terms. Ordered last so the
  // repairs above rewrite their rows with the whitelisted assembly first and
  // this pass sees them as already correct. Same best-effort contract as the
  // passes above: marker and data share one immediate transaction, a failure
  // rolls both back and the next open retries; the catch never writes the
  // marker.
  try {
    const rebuildStats = rebuildSearchScopeTexts(database, {
      loadMetadata: (row) => rowToAsset(database, row),
      searchableText,
      syncAssetFtsEntry: (projectId, assetId, searchText, deletedAt) => syncAssetFtsEntry(database, projectId, assetId, searchText, deletedAt),
      replaceAssetShortTerms: (projectId, assetId, searchText) => replaceAssetShortTerms(database, projectId, assetId, searchText),
    });
    if (rebuildStats.assetsRebuilt > 0) {
      // Counts and error codes only — never search text, prompts, user
      // messages or paths from the rows this pass touches.
      console.warn(`[MOSA] search_scope_v3: rebuilt search text for ${rebuildStats.assetsRebuilt} asset(s) (${rebuildStats.assetsUnchanged} already up to date).`);
    }
  } catch (error) {
    const code = error && typeof error.code === "string" ? `${error.code} ` : "";
    console.warn(`[MOSA] one-time search-scope rebuild skipped; it retries on the next open: ${code}${error instanceof Error ? error.message : String(error)}`);
  }
  // One-time video metadata backfill (width/height/duration read from the
  // original files; see backfillVideoMetadataFromFiles). Same best-effort
  // contract as the passes above: skip on error, the marker rolls back with
  // the data, the next open retries.
  try {
    backfillVideoMetadataFromFiles(database, { commitLibraryChanges });
  } catch (error) {
    const code = error && typeof error.code === "string" ? `${error.code} ` : "";
    console.warn(`[MOSA] one-time video metadata backfill skipped; it retries on the next open: ${code}${error instanceof Error ? error.message : String(error)}`);
  }
  // One-time file-size backfill (see backfillFileBytesFromFiles). Same
  // best-effort contract as the passes above: skip on error, the marker rolls
  // back with the data, the next open retries.
  try {
    backfillFileBytesFromFiles(database, { commitLibraryChanges });
  } catch (error) {
    const code = error && typeof error.code === "string" ? `${error.code} ` : "";
    console.warn(`[MOSA] one-time file-bytes backfill skipped; it retries on the next open: ${code}${error instanceof Error ? error.message : String(error)}`);
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
          INSERT INTO asset_stacks (project_id, id, created_at, updated_at, sort_created_at, sort_name)
          VALUES (?, ?, ?, ?, ?, ?)
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
        if (!stackSummary(database, cleanProjectId, cleanStackId)) throw assetStoreError("STACK_NOT_FOUND", `Stack not found: ${cleanStackId}`);
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
        database.prepare("UPDATE asset_stacks SET updated_at = ? WHERE project_id = ? AND id = ?")
          .run(timestamp, cleanProjectId, cleanStackId);
        if (addedIds.length) {
          const coverAssetId = stackSummary(database, cleanProjectId, cleanStackId)?.cover_asset_id || "";
          commitLibraryChanges([{ projectId: cleanProjectId, kind: "stack-members-changed", entityType: "stack", entityId: cleanStackId, assetIds: addedIds, detail: { coverAssetId } }]);
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
      const outcome = database.transaction(() => {
        if (!unstack && !stackSummary(database, cleanProjectId, cleanTargetStackId)) {
          throw assetStoreError("STACK_NOT_FOUND", `Stack not found: ${cleanTargetStackId}`);
        }
        const getAssetRow = database.prepare("SELECT id, archived FROM assets WHERE project_id = ? AND id = ?");
        const getMembership = database.prepare("SELECT stack_id FROM asset_stack_members WHERE project_id = ? AND asset_id = ?");
        // First pass validates the whole batch and partitions it per source
        // stack (first-appearance order) before any write: one bad id aborts
        // with the library untouched. Assets already in the target — or already
        // loose when un-stacking — are skipped in place, so a no-op move has no
        // sources and stays silent.
        const movesBySource = new Map();
        const movedAssetIds = [];
        for (const assetId of ids) {
          const row = getAssetRow.get(cleanProjectId, assetId);
          if (!row) throw assetNotFoundError(assetId);
          if (row.archived) throw assetStoreError("STACK_ASSET_ARCHIVED", `Archived asset cannot be stacked: ${assetId}`);
          const sourceStackId = getMembership.get(cleanProjectId, assetId)?.stack_id || "";
          if (sourceStackId === cleanTargetStackId) continue;
          movedAssetIds.push(assetId);
          if (!sourceStackId) continue;
          if (!movesBySource.has(sourceStackId)) movesBySource.set(sourceStackId, []);
          movesBySource.get(sourceStackId).push(assetId);
        }
        const sources = [];
        const changes = [];
        for (const [sourceStackId, sourceAssetIds] of movesBySource) {
          // The pre-mutation cover identifies the gallery node the client
          // currently renders for this Stack; after cover reassignment that row
          // id disappears.
          const previousCoverAssetId = stackSummary(database, cleanProjectId, sourceStackId)?.cover_asset_id || "";
          const remove = database.prepare("DELETE FROM asset_stack_members WHERE project_id = ? AND stack_id = ? AND asset_id = ?");
          sourceAssetIds.forEach((assetId) => remove.run(cleanProjectId, sourceStackId, assetId));
          const compact = compactAssetStack(database, cleanProjectId, sourceStackId);
          // Leaving any stack — manual or auto — is user intent, for every
          // removed asset and — when the removal auto-dissolves the stack — for
          // the survivor too. Joining the target manually never lifts that
          // tombstone: the exclusion only bans automatic re-stacking.
          addAutoStackExclusions(database, cleanProjectId, compact.dissolved
            ? [...sourceAssetIds, compact.remainingAssetId]
            : sourceAssetIds);
          sources.push({ stackId: sourceStackId, dissolved: compact.dissolved, remainingAssetId: compact.remainingAssetId });
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
        if (!unstack && movedAssetIds.length) {
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
          database.prepare("UPDATE asset_stacks SET updated_at = ? WHERE project_id = ? AND id = ?")
            .run(timestamp, cleanProjectId, cleanTargetStackId);
          const coverAssetId = stackSummary(database, cleanProjectId, cleanTargetStackId)?.cover_asset_id || "";
          changes.push({ projectId: cleanProjectId, kind: "stack-members-changed", entityType: "stack", entityId: cleanTargetStackId, assetIds: movedAssetIds, detail: { coverAssetId } });
        }
        if (changes.length) commitLibraryChanges(changes);
        return {
          target: unstack ? null : stackSummary(database, cleanProjectId, cleanTargetStackId),
          sources,
          movedAssetIds,
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
        // term index for broad CJK queries.
        const condition = `EXISTS (
          SELECT 1 FROM asset_short_terms short_term
          WHERE short_term.project_id = a.project_id
            AND short_term.asset_id = a.id
            AND short_term.term = @${key}
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
          likeConditions.push(`LOWER(a.search_text) LIKE @${key} ESCAPE '\\'`);
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
          FROM asset_short_terms st INDEXED BY asset_short_terms_lookup_idx
          CROSS JOIN assets a
          WHERE st.project_id = @projectId
            AND st.term = @shortUnicodeTerm0
            AND a.project_id = st.project_id
            AND a.id = st.asset_id
            AND a.deleted_at IS NULL
            AND a.archived = 0
            ${indexedShortUnicodeTerms.slice(1).map((_, index) => `AND EXISTS (
              SELECT 1 FROM asset_short_terms st${index + 1}
              WHERE st${index + 1}.project_id = st.project_id
                AND st${index + 1}.asset_id = st.asset_id
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
      if (!cleanIds.length) return { rows: [], rowByAssetId: {} };
      const sort = normalizeAssetSort(filters.sort);
      const searchQuery = normalizeAssetSearchQuery(filters.query);

      if (filters.stackId) {
        const cleanStackId = sanitizeId(filters.stackId, "stack");
        const stack = stackSummary(database, projectId, cleanStackId);
        if (!stack) return { rows: [], rowByAssetId: {} };
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
          asset.node_sort = {
            createdAt: String(asset.created_at || ""),
            sortName: String(asset.sort_name ?? asset.theme ?? ""),
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
        return { rows: assets, rowByAssetId, afterCursorRowIds };
      }

      const useCollapse = Boolean(filters.collapseStacks) && !filters.archived && !filters.trash
        && database.prepare("SELECT 1 FROM asset_stacks WHERE project_id = ? LIMIT 1").get(projectId);
      if (useCollapse) {
        const page = listCollapsedAssetPage(database, {
          filters: { ...filters, assetIds: cleanIds, includeTotal: false },
          projectId,
          limit: 0,
          sort,
          searchQuery,
          cursor: null,
        });
        const rowByAssetId = {};
        const results = database.prepare(`
          WITH requested(asset_id) AS (SELECT CAST(value AS TEXT) FROM json_each(@reconcileAssetIds)),
          member_nodes AS (
            SELECT sm.asset_id, COALESCE(
              (SELECT sm3.asset_id
               FROM asset_stack_members sm3
               JOIN assets a3 ON a3.project_id = sm3.project_id AND a3.id = sm3.asset_id
               WHERE sm3.project_id = sm.project_id AND sm3.stack_id = sm.stack_id
                 AND a3.archived = 0 AND a3.deleted_at IS NULL
               ORDER BY sm3.position, sm3.asset_id LIMIT 1), sm.asset_id) AS node_asset_id
            FROM asset_stack_members sm
            JOIN requested r ON r.asset_id = sm.asset_id
            WHERE sm.project_id = @projectId
          )
          SELECT r.asset_id AS asset_id, COALESCE(n.node_asset_id, r.asset_id) AS node_asset_id
          FROM requested r
          LEFT JOIN member_nodes n ON n.asset_id = r.asset_id
        `).all({ projectId, reconcileAssetIds: JSON.stringify(cleanIds) });
        for (const row of results) rowByAssetId[row.asset_id] = row.node_asset_id;
        const boundaryCursor = filters.boundaryCursor ? parseCursor(filters.boundaryCursor, sort, searchQuery, assetTimeFilterKey(filters)) : null;
        const afterCursorRowIds = boundaryCursor
          ? page.assets.filter((asset) => isGalleryRowAfterCursor(asset, boundaryCursor, sort, searchQuery)).map((asset) => asset.id)
          : [];
        return { rows: page.assets, rowByAssetId, afterCursorRowIds };
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
      return { rows: page.assets, rowByAssetId, afterCursorRowIds };
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
      const stats = database.prepare(`
        SELECT
          SUM(CASE WHEN a.archived = 0 AND a.deleted_at IS NULL THEN 1 ELSE 0 END) AS total,
          SUM(CASE WHEN a.archived = 0 AND a.deleted_at IS NULL AND (a.rating > 0 OR a.favorite = 1) THEN 1 ELSE 0 END) AS favorites,
          SUM(CASE WHEN a.archived = 0 AND a.deleted_at IS NULL
            AND COALESCE(TRIM(a.group_name), '') = ''
            AND NOT EXISTS (
              SELECT 1 FROM asset_stack_members sm
              WHERE sm.project_id = a.project_id AND sm.asset_id = a.id
            ) THEN 1 ELSE 0 END) AS unorganized,
          SUM(CASE WHEN a.deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS trash
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
          SUM(CASE WHEN COALESCE(TRIM(a.group_name), '') = '' AND NOT EXISTS (
            SELECT 1 FROM asset_stack_members sm
            WHERE sm.project_id = a.project_id AND sm.asset_id = a.id
          ) THEN 1 ELSE 0 END) AS unorganized,
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
          replaceAssetShortTerms(database, pid, row.id, searchText);
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
          return { row, ...(await automaticSuppressionIdentityForAsset(asset, files)) };
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
            database.prepare("DELETE FROM derivative_jobs WHERE project_id = ? AND asset_id = ?").run(pid, row.id);
            database.prepare("DELETE FROM asset_fts WHERE project_id = ? AND asset_id = ?").run(pid, row.id);
            database.prepare("UPDATE assets SET deleted_at = ?, updated_at = ? WHERE project_id = ? AND id = ?")
              .run(deletedAt, deletedAt, pid, row.id);
          }
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
            deletionPlans.push({ row, stackMembership, filesToUnlink, contentHash, pixelHash, pixelHashVersion });
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
              database.prepare("DELETE FROM asset_fts WHERE project_id = ? AND asset_id = ?").run(pid, assetId);
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
            }
            for (const stackId of touchedStacks) compactAssetStack(database, pid, stackId);
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
          replaceAssetShortTerms(database, pid, row.id, searchText);
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
          replaceAssetShortTerms(database, pid, assetId, searchText);
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
          replaceAssetShortTerms(database, pid, row.id, searchText);
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
     * curation flags the "keep organized work" rule reads. Tag names come
     * along (unit-separated, so the sync module can tell user tags from the
     * capture pipeline's system tags) because findAssetByProviderIdentity's
     * list-shape assets carry no tags and one query must answer the whole
     * keep-or-trash decision per item.
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
        SELECT a.id AS id, a.deleted_at AS deleted_at, a.favorite AS favorite,
               a.rating AS rating, a.group_name AS group_name,
               (
                 SELECT GROUP_CONCAT(t.name, char(31))
                 FROM asset_tags at JOIN tags t ON t.id = at.tag_id
                 WHERE at.project_id = a.project_id AND at.asset_id = a.id
               ) AS tag_names
        FROM assets a
        WHERE a.project_id = ? AND a.source_type = ? AND a.provider_asset_id = ?
        ORDER BY a.deleted_at IS NULL DESC, a.created_at DESC, a.id DESC
      `).all(cleanProjectId, sourceType, cleanProviderAssetId).map((row) => ({
        id: row.id,
        projectId: cleanProjectId,
        deleted: Boolean(row.deleted_at),
        favorite: Boolean(row.favorite),
        rating: Number(row.rating) || 0,
        group: String(row.group_name || ""),
        tagNames: row.tag_names ? String(row.tag_names).split("\u001f") : [],
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
    async createAsset(input = {}, context = {}) {
      const projectId = await this.ensureProject(input.projectId || DEFAULT_PROJECT_ID);
      const { sourcePath, readablePath } = await resolveReadableImagePath(store, input.imagePath, context?.trustedSourceRoots);
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
      const imageName = `${assetId}${extname(sourcePath) || extname(originalName) || ".png"}`;
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
      // File size builds on the dimension fill so one import can gain both in
      // a single write.
      const fileBytesFields = await missingFileBytesField(imagePath, videoDimensionFields ?? input.business_fields);
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
        const coverMembership = database.prepare(`
          SELECT stack_id FROM asset_stack_members
          WHERE project_id = ? AND asset_id = ? AND position = 0
        `).get(metadata.project_id, metadata.id);
        saveAsset(database, metadata, {
          enqueueDerivative: false,
          recipeSnapshot: buildRecipeSnapshot(metadata, {
            createdAt: metadata.updated_at,
            changeSummary: patch.recipe_change_summary || "Recipe updated",
          }),
          libraryChanges: [{ projectId: metadata.project_id, kind: "asset-updated", entityType: "asset", entityId: metadata.id, flags: Object.keys(patch) }],
        }, { commitLibraryChanges });
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
      const curation = normalizeAssetCuration(input);
      database.transaction(() => {
        const row = database.prepare("SELECT * FROM assets WHERE project_id = ? AND id = ?").get(cleanProjectId, cleanAssetId);
        if (!row) throw assetNotFoundError(cleanAssetId);
        const timestamp = now();
        const metadataJson = parseJson(row.metadata_json, {});
        metadataJson.curated = curation.curated;
        metadataJson.curation_note = curation.curation_note;
        const current = rowToAsset(database, row, { includeRelations: false });
        const searchText = searchableText({ ...current, ...curation });
        database.prepare(`
          UPDATE assets SET metadata_json = ?, search_text = ?, updated_at = ?
          WHERE project_id = ? AND id = ?
        `).run(JSON.stringify(metadataJson), searchText, timestamp, cleanProjectId, cleanAssetId);
        syncAssetFtsEntry(database, cleanProjectId, cleanAssetId, searchText, row.deleted_at);
        replaceAssetShortTerms(database, cleanProjectId, cleanAssetId, searchText);
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
        const nextName = `${cleanAssetId}-${shortStamp()}-${randomUUID().slice(0, 8)}${extension}`;
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
        const businessFields = mergeReplacementObject(current.business_fields, input.business_fields);
        const source = mergeReplacementObject(current.source, input.source);
        source.content_sha256 = contentHash;
        source.pixel_sha256 = pixelHash || null;
        source.pixel_hash_version = pixelHash ? String(input.pixel_hash_version || input.pixelHashVersion || PIXEL_HASH_VERSION) : null;
        source.storage_mode = "copy";
        source.copied_at = timestamp;
        const metadata = normalizeAssetMetadata({
          ...current,
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
        const snapshot = await stageReplacedMediaSnapshot(database, store, cleanProjectId, row, current, { timestamp, cleanAssetId });
        try {
          database.transaction(() => {
            database.prepare(`
              UPDATE assets SET
                asset = ?, original_path = ?, preview_path = NULL, medium_path = NULL, thumbnail_path = NULL,
                content_sha256 = ?, pixel_sha256 = ?, prompt = ?, business_fields_json = ?, source_json = ?,
                search_text = ?, business_search_text = ?, source_search_text = ?, media_kind = ?,
                conversation_id = ?, generation_batch = ?, updated_at = ?
              WHERE project_id = ? AND id = ?
            `).run(
              nextName, nextPath, contentHash, pixelHash, current.prompt,
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
            database.prepare("DELETE FROM derivative_jobs WHERE project_id = ? AND asset_id = ?").run(cleanProjectId, cleanAssetId);
            if (mediaKind !== "video") database.prepare(`
              INSERT INTO derivative_jobs (project_id, asset_id, status, attempts, created_at, updated_at)
              VALUES (?, ?, 'pending', 0, ?, ?)
              ON CONFLICT(project_id, asset_id) DO UPDATE SET status = 'pending', attempts = 0, error = NULL, updated_at = excluded.updated_at
            `).run(cleanProjectId, cleanAssetId, timestamp, timestamp);
            syncAssetFtsEntry(database, cleanProjectId, cleanAssetId, searchText, row.deleted_at);
            replaceAssetShortTerms(database, cleanProjectId, cleanAssetId, searchText);
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
          if (!row.deleted_at) {
            database.prepare("DELETE FROM derivative_jobs WHERE project_id = ? AND asset_id = ?").run(cleanProjectId, cleanAssetId);
            database.prepare("DELETE FROM asset_fts WHERE project_id = ? AND asset_id = ?").run(cleanProjectId, cleanAssetId);
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
          database.prepare("UPDATE assets SET deleted_at = NULL, updated_at = ?, metadata_json = ? WHERE project_id = ? AND id = ?")
            .run(timestamp, JSON.stringify(restoredMetadataJson), cleanProjectId, cleanAssetId);
          // The UPDATE above cleared deleted_at, so this re-indexes unconditionally.
          syncAssetFtsEntry(database, cleanProjectId, cleanAssetId, row.search_text, null);
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
            database.prepare("DELETE FROM asset_fts WHERE project_id = ? AND asset_id = ?").run(cleanProjectId, cleanAssetId);
            // auto_stack_exclusions has no foreign key by design (the marker
            // must survive ordinary edits), so permanent delete clears it
            // explicitly — otherwise re-importing the same content-derived id
            // inherits an exclusion the user never chose for it.
            database.prepare("DELETE FROM auto_stack_exclusions WHERE project_id = ? AND asset_id = ?").run(cleanProjectId, cleanAssetId);
            database.prepare("DELETE FROM assets WHERE project_id = ? AND id = ?").run(cleanProjectId, cleanAssetId);
            if (stackMembership) {
              const stackDeleted = database.prepare(`DELETE FROM asset_stacks
                WHERE project_id = ? AND id = ?
                  AND NOT EXISTS (
                    SELECT 1 FROM asset_stack_members
                    WHERE project_id = ? AND stack_id = ?
                  )`).run(cleanProjectId, stackMembership.stack_id, cleanProjectId, stackMembership.stack_id);
              syncAssetStackCoverSortName(database, cleanProjectId, stackMembership.stack_id);
              changeRecords.push({
                projectId: cleanProjectId,
                kind: stackDeleted.changes ? "stack-dissolved" : "stack-members-changed",
                entityType: "stack",
                entityId: stackMembership.stack_id,
                assetIds: [cleanAssetId],
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
    async createAssetVersion(projectId, assetId, input = {}) {
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
        });
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
      const event = normalizeGenerationEvent(input);
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
      const existing = database.prepare("SELECT * FROM generation_events WHERE project_id = ? AND id = ?").get(supplementedEvent.project_id, supplementedEvent.id);
      if (existing) storedEvent = mergeGenerationEventForUpdate(generationEventFromRow(existing), supplementedEvent);
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
      const conversationRows = database.prepare("SELECT provider, conversation_id, turn_count, synced_at FROM generation_conversations WHERE project_id = ?").all(cleanProjectId);
      const history = buildAssetGenerationHistory({
        projectId: cleanProjectId,
        assetId: cleanAssetId,
        events,
        relations,
        candidates,
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
      //               wholesale on every launch.
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
    async claimDerivativeJob() {
      const claim = database.transaction(() => {
        const retryBefore = new Date(Date.now() - 30 * 1000).toISOString();
        const job = database.prepare(`
          SELECT j.project_id, j.asset_id, j.attempts, a.original_path, a.id
          FROM derivative_jobs j JOIN assets a ON a.project_id = j.project_id AND a.id = j.asset_id
          WHERE j.status = 'pending'
            OR (j.status = 'running' AND j.updated_at < @staleRunningBefore)
            OR (j.status = 'failed' AND j.attempts < 3 AND j.updated_at < @retryBefore)
          ORDER BY j.created_at ASC LIMIT 1
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
        database.prepare("UPDATE assets SET preview_path = ?, medium_path = ?, thumbnail_path = ?, business_fields_json = ?, business_search_text = ?, updated_at = ? WHERE project_id = ? AND id = ?")
          .run(result.previewPath, result.mediumPath, result.thumbnailPath, JSON.stringify(businessFields), searchableBusinessObjectText(businessFields), timestamp, job.project_id, job.asset_id);
        // Palette is a dedicated column, deliberately outside business_fields
        // (which feeds the search text). Jobs whose result carries no palette
        // (older workers, error completions) leave the column untouched.
        if (Array.isArray(result.palette)) {
          database.prepare("UPDATE assets SET palette_json = ? WHERE project_id = ? AND id = ?")
            .run(JSON.stringify(result.palette), job.project_id, job.asset_id);
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
        encoded = await sharp(image, { limitInputPixels: MAX_DERIVATIVE_INPUT_PIXELS })
          .rotate()
          .resize({ width: POSTER_WIDTH, height: POSTER_WIDTH, fit: "inside", withoutEnlargement: true })
          .webp({ quality: POSTER_QUALITY })
          .toBuffer();
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
      try {
        database.pragma("wal_checkpoint(TRUNCATE)");
      } catch {
        // pragma is a no-op if the WAL is already empty or the journal mode has changed.
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

/**
 * `created_at` is TEXT, so a `recent` predicate has to parse it, and a parsed predicate cannot use
 * an index — on a 100k-row library that turns a sub-millisecond lookup into a ~20ms scan that runs
 * on every gallery refresh. The parsed instant is therefore materialised into an indexed column.
 *
 * This is an idempotent structural repair rather than a numbered migration: the column is added
 * when missing, parseable legacy text is canonicalised, and every derived value is checked on
 * open. Raw SQL can therefore leave the pair inconsistent only until the next store open.
 */
function ensureCreatedAtEpoch(database) {
  const hasColumn = database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('assets') WHERE name = 'created_at_epoch'").get().count > 0;
  if (!hasColumn) database.exec("ALTER TABLE assets ADD COLUMN created_at_epoch REAL");
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_epoch_idx ON assets(project_id, archived, created_at_epoch DESC, id DESC)");
  // The repair only ever needs to write when a row is actually stale. Probe
  // first so a consistent library avoids the full-table UPDATE's write lock
  // on every open; raw SQL edits are still canonicalised on the next open.
  const needsRepair = database.prepare("SELECT 1 FROM assets WHERE created_at_epoch IS NULL LIMIT 1").get()
    || database.prepare("SELECT 1 FROM assets WHERE created_at != mosa_normalize_created_at(created_at) OR created_at_epoch IS NOT mosa_created_at_epoch(created_at) LIMIT 1").get();
  if (!needsRepair) return;
  database.prepare(`
    UPDATE assets SET
      created_at = mosa_normalize_created_at(created_at),
      created_at_epoch = mosa_created_at_epoch(created_at)
    WHERE created_at != mosa_normalize_created_at(created_at)
      OR created_at_epoch IS NOT mosa_created_at_epoch(created_at)
  `).run();
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
  `).run();
}

function ensurePixelHashColumn(database) {
  const hasColumn = database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('assets') WHERE name = 'pixel_sha256'").get().count > 0;
  if (!hasColumn) database.exec("ALTER TABLE assets ADD COLUMN pixel_sha256 TEXT NOT NULL DEFAULT ''");
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_pixel_hash_idx ON assets(project_id, pixel_sha256)");
  database.prepare(`
    UPDATE assets
    SET pixel_sha256 = COALESCE(json_extract(source_json, '$.pixel_sha256'), '')
    WHERE pixel_sha256 = '' AND COALESCE(json_extract(source_json, '$.pixel_sha256'), '') != ''
  `).run();
}

function ensureSourcePathColumn(database) {
  const hasColumn = database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('assets') WHERE name = 'source_path'").get().count > 0;
  if (!hasColumn) database.exec("ALTER TABLE assets ADD COLUMN source_path TEXT NOT NULL DEFAULT ''");
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_source_path_idx ON assets(project_id, source_path)");
  const needsRepair = database.prepare(`
    SELECT 1 FROM assets
    WHERE source_path IS NOT COALESCE(CAST(json_extract(source_json, '$.path') AS TEXT), '')
    LIMIT 1
  `).get();
  if (!needsRepair) return;
  database.prepare(`
    UPDATE assets
    SET source_path = COALESCE(CAST(json_extract(source_json, '$.path') AS TEXT), '')
    WHERE source_path IS NOT COALESCE(CAST(json_extract(source_json, '$.path') AS TEXT), '')
  `).run();
}

function ensureWebCaptureLookupColumns(database) {
  const columns = new Set(database.prepare("SELECT name FROM pragma_table_info('assets')").all().map((row) => row.name));
  const needsBackfill = !columns.has("provider_asset_id") || !columns.has("logical_output_id");
  if (!columns.has("provider_asset_id")) database.exec("ALTER TABLE assets ADD COLUMN provider_asset_id TEXT NOT NULL DEFAULT ''");
  if (!columns.has("logical_output_id")) database.exec("ALTER TABLE assets ADD COLUMN logical_output_id TEXT NOT NULL DEFAULT ''");
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_provider_asset_idx ON assets(project_id, provider_asset_id)");
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_logical_output_idx ON assets(project_id, logical_output_id)");
  if (!needsBackfill) return;
  database.prepare(`
    UPDATE assets
    SET provider_asset_id = COALESCE(CAST(json_extract(source_json, '$.provider_asset_id') AS TEXT), ''),
        logical_output_id = COALESCE(CAST(json_extract(source_json, '$.logical_output_id') AS TEXT), '')
    WHERE provider_asset_id != COALESCE(CAST(json_extract(source_json, '$.provider_asset_id') AS TEXT), '')
       OR logical_output_id != COALESCE(CAST(json_extract(source_json, '$.logical_output_id') AS TEXT), '')
  `).run();
}

function ensureSuppressionPixelHashVersion(database) {
  const ensureIndexes = () => database.exec(`
    CREATE INDEX IF NOT EXISTS automatic_suppressions_project_content_idx ON automatic_ingest_suppressions(project_id, content_sha256, deleted_at DESC);
    CREATE INDEX IF NOT EXISTS automatic_suppressions_project_pixel_idx ON automatic_ingest_suppressions(project_id, pixel_sha256, deleted_at DESC);
    CREATE INDEX IF NOT EXISTS automatic_suppressions_project_deleted_idx ON automatic_ingest_suppressions(project_id, deleted_at DESC, content_sha256, pixel_sha256, pixel_hash_version);
  `);
  const legacyExists = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'automatic_ingest_suppressions_legacy'").get();
  if (legacyExists) {
    database.transaction(() => {
      database.prepare(`
        INSERT OR IGNORE INTO automatic_ingest_suppressions
          (project_id, content_sha256, pixel_sha256, pixel_hash_version, deleted_at, reason)
        SELECT project_id, content_sha256, pixel_sha256, COALESCE(pixel_hash_version, ''), deleted_at, reason
        FROM automatic_ingest_suppressions_legacy
      `).run();
      database.exec("DROP TABLE automatic_ingest_suppressions_legacy");
    }).immediate();
  }
  const hasColumn = database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('automatic_ingest_suppressions') WHERE name = 'pixel_hash_version'").get().count > 0;
  if (!hasColumn) database.exec("ALTER TABLE automatic_ingest_suppressions ADD COLUMN pixel_hash_version TEXT NOT NULL DEFAULT ''");
  const primaryKey = database.prepare("SELECT name FROM pragma_table_info('automatic_ingest_suppressions') WHERE pk > 0 ORDER BY pk").all().map((row) => row.name);
  if (primaryKey.join(",") === "project_id,content_sha256,pixel_sha256,pixel_hash_version") {
    ensureIndexes();
    return;
  }
  database.transaction(() => {
    database.exec(`
      DROP INDEX IF EXISTS automatic_suppressions_project_content_idx;
      DROP INDEX IF EXISTS automatic_suppressions_project_pixel_idx;
      DROP INDEX IF EXISTS automatic_suppressions_project_deleted_idx;
      ALTER TABLE automatic_ingest_suppressions RENAME TO automatic_ingest_suppressions_legacy;
      CREATE TABLE automatic_ingest_suppressions (
        project_id TEXT NOT NULL,
        content_sha256 TEXT NOT NULL DEFAULT '',
        pixel_sha256 TEXT NOT NULL DEFAULT '',
        pixel_hash_version TEXT NOT NULL DEFAULT '',
        deleted_at TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT 'user-deleted',
        PRIMARY KEY (project_id, content_sha256, pixel_sha256, pixel_hash_version),
        CHECK (content_sha256 != '' OR pixel_sha256 != '')
      );
      INSERT INTO automatic_ingest_suppressions
        (project_id, content_sha256, pixel_sha256, pixel_hash_version, deleted_at, reason)
      SELECT project_id, content_sha256, pixel_sha256, COALESCE(pixel_hash_version, ''), deleted_at, reason
      FROM automatic_ingest_suppressions_legacy;
      DROP TABLE automatic_ingest_suppressions_legacy;
      CREATE INDEX automatic_suppressions_project_content_idx ON automatic_ingest_suppressions(project_id, content_sha256, deleted_at DESC);
      CREATE INDEX automatic_suppressions_project_pixel_idx ON automatic_ingest_suppressions(project_id, pixel_sha256, deleted_at DESC);
      CREATE INDEX automatic_suppressions_project_deleted_idx ON automatic_ingest_suppressions(project_id, deleted_at DESC, content_sha256, pixel_sha256, pixel_hash_version);
    `);
  }).immediate();
}

/**
 * Name ordering keys on the same string the gallery labels a card with, which
 * lives across two columns. Sorting that expression inline cannot use an index,
 * so on a 50k library it degrades the paged query into a full scan plus sort —
 * the exact cost `assets_project_created_idx` exists to avoid for the default
 * order. The key is therefore materialised and indexed like `created_at_epoch`,
 * as an idempotent structural repair rather than a numbered migration.
 */
function ensureSortName(database) {
  const hasColumn = database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('assets') WHERE name = 'sort_name'").get().count > 0;
  if (!hasColumn) database.exec("ALTER TABLE assets ADD COLUMN sort_name TEXT");
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_name_idx ON assets(project_id, archived, sort_name ASC, id ASC)");
  // See ensureCreatedAtEpoch: probe before the full-table repair write.
  const needsRepair = database.prepare("SELECT 1 FROM assets WHERE sort_name IS NULL LIMIT 1").get()
    || database.prepare("SELECT 1 FROM assets WHERE sort_name IS NOT mosa_sort_name(theme, asset, id) LIMIT 1").get();
  if (!needsRepair) return;
  database.prepare(`
    UPDATE assets SET sort_name = mosa_sort_name(theme, asset, id)
    WHERE sort_name IS NOT mosa_sort_name(theme, asset, id)
  `).run();
}

/** A stack sorts by its newest member's date, so a stack that gains a fresh
 * capture moves up with it instead of staying where its oldest cover sat.
 * Members in the trash do not count while any member is still live. */
const STACK_SORT_CREATED_AT_SQL = `COALESCE((
    SELECT MAX(a.created_at)
    FROM asset_stack_members sm
    JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
    WHERE sm.project_id = asset_stacks.project_id AND sm.stack_id = asset_stacks.id AND a.deleted_at IS NULL
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

function ensureAssetStackSortColumns(database) {
  const columns = new Set(database.prepare("SELECT name FROM pragma_table_info('asset_stacks')").all().map((row) => row.name));
  if (!columns.has("sort_created_at")) database.exec("ALTER TABLE asset_stacks ADD COLUMN sort_created_at TEXT NOT NULL DEFAULT ''");
  if (!columns.has("sort_name")) database.exec("ALTER TABLE asset_stacks ADD COLUMN sort_name TEXT NOT NULL DEFAULT ''");
  // Custom Stack display names own their sort key; the cover-derived backfill
  // only applies to stacks a user has never renamed (name = '').
  if (!columns.has("name")) database.exec("ALTER TABLE asset_stacks ADD COLUMN name TEXT NOT NULL DEFAULT ''");
  database.exec("CREATE INDEX IF NOT EXISTS asset_stacks_project_sort_created_idx ON asset_stacks(project_id, sort_created_at DESC, id DESC)");
  database.exec("CREATE INDEX IF NOT EXISTS asset_stacks_project_sort_name_idx ON asset_stacks(project_id, sort_name ASC, id ASC)");
  database.prepare(`
    UPDATE asset_stacks
    SET sort_created_at = COALESCE(NULLIF(sort_created_at, ''), (
          SELECT a.created_at
          FROM asset_stack_members sm
          JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
          WHERE sm.project_id = asset_stacks.project_id AND sm.stack_id = asset_stacks.id AND sm.position = 0
        ), created_at),
        sort_name = CASE WHEN name != '' THEN mosa_sort_name(name, '', id) ELSE COALESCE(NULLIF(sort_name, ''), (
          SELECT a.sort_name
          FROM asset_stack_members sm
          JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
          WHERE sm.project_id = asset_stacks.project_id AND sm.stack_id = asset_stacks.id AND sm.position = 0
        ), '') END
    WHERE sort_created_at = '' OR (sort_name = '' AND name = '')
  `).run();
}

/** Re-derived on every open, like the other derived columns: stacks written
 * before the newest-member rule (or by raw SQL) converge here. Runs after the
 * trash column exists. */
function rederiveStackSortCreatedAt(database) {
  database.prepare(`
    UPDATE asset_stacks SET sort_created_at = ${STACK_SORT_CREATED_AT_SQL}
    WHERE sort_created_at IS NOT ${STACK_SORT_CREATED_AT_SQL}
  `).run();
}

/**
 * Session keys group same-conversation captures for automatic stacking. Like
 * the other derived scalar columns, the column is added idempotently and every
 * stored value is re-derived from source_json on open, so raw SQL edits or a
 * changed extraction rule converge on the next startup.
 */
function ensureGenerationSessionColumn(database) {
  const hasColumn = database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('assets') WHERE name = 'generation_session_key'").get().count > 0;
  if (!hasColumn) database.exec("ALTER TABLE assets ADD COLUMN generation_session_key TEXT NOT NULL DEFAULT ''");
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_session_key_idx ON assets(project_id, generation_session_key)");
  // Probe before the full-table repair write so a consistent library avoids
  // taking the write lock on every open (see ensureCreatedAtEpoch).
  const needsRepair = database.prepare(`
    SELECT 1 FROM assets
    WHERE generation_session_key != mosa_generation_session_key(source_type, business_fields_json, source_json)
    LIMIT 1
  `).get();
  if (!needsRepair) return;
  database.prepare(`
    UPDATE assets
    SET generation_session_key = mosa_generation_session_key(source_type, business_fields_json, source_json)
    WHERE generation_session_key != mosa_generation_session_key(source_type, business_fields_json, source_json)
  `).run();
}

/**
 * Auto-stacked sessions need three things the manual-stack schema predates: an
 * origin marker plus the owning session key on asset_stacks (the partial unique
 * index guarantees one auto stack per session per project), a name lock so a
 * user rename survives later ingests, and the exclusion table recording assets
 * a user deliberately pulled out of an auto stack so they are never re-stacked.
 */
function ensureAutoStackStructures(database) {
  const columns = new Set(database.prepare("SELECT name FROM pragma_table_info('asset_stacks')").all().map((row) => row.name));
  if (!columns.has("origin")) database.exec("ALTER TABLE asset_stacks ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'");
  if (!columns.has("session_key")) database.exec("ALTER TABLE asset_stacks ADD COLUMN session_key TEXT NOT NULL DEFAULT ''");
  if (!columns.has("name_locked")) database.exec("ALTER TABLE asset_stacks ADD COLUMN name_locked INTEGER NOT NULL DEFAULT 0");
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS asset_stacks_project_auto_session_idx
      ON asset_stacks(project_id, session_key) WHERE origin = 'auto'
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS auto_stack_exclusions (
      project_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      session_key TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, asset_id)
    )
  `);
}

function ensureMediumPathColumn(database) {
  const hasColumn = database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('assets') WHERE name = 'medium_path'").get().count > 0;
  if (!hasColumn) database.exec("ALTER TABLE assets ADD COLUMN medium_path TEXT");
}

function ensureTrashColumn(database) {
  const hasColumn = database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('assets') WHERE name = 'deleted_at'").get().count > 0;
  if (!hasColumn) database.exec("ALTER TABLE assets ADD COLUMN deleted_at TEXT");
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_deleted_idx ON assets(project_id, deleted_at, created_at DESC, id DESC)");
}

function ensureSearchScalarColumns(database, forceBackfill = false) {
  const columns = new Map(database.prepare("SELECT name FROM pragma_table_info('assets')").all().map((row) => [row.name, true]));
  const additions = [
    ["tags_text", "TEXT NOT NULL DEFAULT ''"],
    ["business_search_text", "TEXT NOT NULL DEFAULT ''"],
    ["source_search_text", "TEXT NOT NULL DEFAULT ''"],
    ["media_kind", "TEXT NOT NULL DEFAULT 'unknown'"],
    ["source_group", "TEXT NOT NULL DEFAULT ''"],
    ["conversation_id", "TEXT NOT NULL DEFAULT ''"],
    ["generation_batch", "TEXT NOT NULL DEFAULT ''"],
  ];
  let added = false;
  for (const [name, definition] of additions) {
    if (columns.has(name)) continue;
    database.exec(`ALTER TABLE assets ADD COLUMN ${name} ${definition}`);
    added = true;
  }
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_media_kind_idx ON assets(project_id, archived, media_kind, created_at DESC, id DESC)");
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_source_group_idx ON assets(project_id, archived, source_group, created_at DESC, id DESC)");
  // The primary gallery excludes Trash. These partial indexes make the
  // low-selectivity source/media/category filters covering for both the page
  // query and its exact COUNT instead of paying a table lookup per matching
  // row only to re-check deleted_at IS NULL. They are idempotently ensured on
  // every startup so existing schema-v13 libraries gain the optimization
  // without a data migration or index replacement window.
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_source_group_live_idx ON assets(project_id, archived, source_group, created_at DESC, id DESC) WHERE deleted_at IS NULL");
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_media_kind_live_idx ON assets(project_id, archived, media_kind, created_at DESC, id DESC) WHERE deleted_at IS NULL");
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_category_live_idx ON assets(project_id, archived, category, created_at DESC, id DESC) WHERE deleted_at IS NULL");
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_conversation_idx ON assets(project_id, archived, conversation_id, created_at DESC, id DESC)");
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_generation_batch_idx ON assets(project_id, archived, generation_batch, created_at DESC, id DESC)");
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_conversation_batch_idx ON assets(project_id, archived, conversation_id, generation_batch, created_at DESC, id DESC)");
  if (!added && !forceBackfill) return;
  database.prepare(`
    UPDATE assets SET
      tags_text = COALESCE((
        SELECT group_concat(t.name, char(31)) FROM tags t
        JOIN asset_tags at ON at.tag_id = t.id
        WHERE at.project_id = assets.project_id AND at.asset_id = assets.id
      ), ''),
      business_search_text = mosa_business_search_text(business_fields_json),
      source_search_text = mosa_source_search_text(source_json, mosa_canonical_source_type(source_type, business_fields_json, source_json)),
      media_kind = mosa_media_kind(business_fields_json, source_json, original_path),
      source_group = mosa_canonical_source_type(source_type, business_fields_json, source_json),
      conversation_id = COALESCE(CAST(json_extract(source_json, '$.conversation_id') AS TEXT), ''),
      generation_batch = COALESCE(CAST(json_extract(source_json, '$.message_id') AS TEXT), '')
  `).run();
}

function ensureGenerationEventColumns(database) {
  const columns = new Set(database.prepare("SELECT name FROM pragma_table_info('generation_events')").all().map((row) => row.name));
  if (!columns.has("provider_tool_call_id")) {
    database.exec("ALTER TABLE generation_events ADD COLUMN provider_tool_call_id TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.has("prompt_scope")) {
    database.exec("ALTER TABLE generation_events ADD COLUMN prompt_scope TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.has("generation_status")) {
    database.exec("ALTER TABLE generation_events ADD COLUMN generation_status TEXT NOT NULL DEFAULT 'unknown'");
  }
  database.exec("CREATE INDEX IF NOT EXISTS generation_events_tool_call_idx ON generation_events(project_id, provider, provider_tool_call_id, created_at, id)");
  database.exec("CREATE INDEX IF NOT EXISTS generation_events_conversation_idx ON generation_events(project_id, provider, conversation_id, created_at, id)");
}

/**
 * Manual groups carry a user-defined display order (`position`) and a color
 * swatch (`color`). The columns are added idempotently; a first-time add
 * backfills `position` with the legacy presentation order (member count DESC,
 * name ASC) so an upgraded library keeps its exact sidebar layout while
 * becoming reorderable from then on.
 */
function ensureGroupColumns(database) {
  const columns = new Set(database.prepare("SELECT name FROM pragma_table_info('groups')").all().map((row) => row.name));
  let addedPosition = false;
  if (!columns.has("position")) {
    database.exec("ALTER TABLE groups ADD COLUMN position INTEGER");
    addedPosition = true;
  }
  if (!columns.has("color")) {
    database.exec("ALTER TABLE groups ADD COLUMN color TEXT NOT NULL DEFAULT ''");
  }
  database.exec("CREATE INDEX IF NOT EXISTS groups_project_position_idx ON groups(project_id, position, name COLLATE NOCASE)");
  if (!addedPosition) return;
  database.exec(`
    UPDATE groups SET position = (
      SELECT ROW_NUMBER() OVER (
        PARTITION BY g.project_id
        ORDER BY (
          SELECT COUNT(a.id) FROM assets a
          WHERE a.project_id = g.project_id
            AND a.group_name = g.name
            AND a.archived = 0
            AND a.deleted_at IS NULL
        ) DESC, g.name COLLATE NOCASE
      ) - 1
      FROM groups g
      WHERE g.project_id = groups.project_id AND g.name = groups.name
    )
    WHERE position IS NULL
  `);
}

/**
 * `palette_json` holds the asset's dominant colors as [{hex, ratio}] JSON.
 * NULL means "never computed" (the backfill trigger); '[]' means "computed,
 * no colors" and is final. The column is added idempotently so libraries
 * opened by an older build keep every original value untouched.
 */
function ensureAssetPaletteColumn(database) {
  const columns = new Set(database.prepare("SELECT name FROM pragma_table_info('assets')").all().map((row) => row.name));
  if (!columns.has("palette_json")) {
    database.exec("ALTER TABLE assets ADD COLUMN palette_json TEXT");
  }
}

function openDatabase(databasePath) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
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
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.pragma("cache_size = -20000");
  database.pragma("temp_store = MEMORY");
  return database;
}

function initializeSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS library_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
  `);
  const schemaRow = database.prepare("SELECT value FROM library_meta WHERE key = 'schema_version'").get();
  const existingVersion = schemaRow ? Number(schemaRow.value) : 0;
  if (!Number.isInteger(existingVersion) || existingVersion < 0) {
    throw new Error(`Invalid GravityPort schema version: ${schemaRow?.value ?? ""}`);
  }
  if (existingVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(`GravityPort schema version ${existingVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}.`);
  }

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
    CREATE VIRTUAL TABLE IF NOT EXISTS asset_fts USING fts5(project_id UNINDEXED, asset_id UNINDEXED, content, tokenize='trigram');
    CREATE TABLE IF NOT EXISTS asset_short_terms (
      project_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      term TEXT NOT NULL,
      PRIMARY KEY (project_id, asset_id, term),
      FOREIGN KEY (project_id, asset_id) REFERENCES assets(project_id, id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS asset_short_terms_lookup_idx ON asset_short_terms(project_id, term, asset_id);
  `);
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
  ensureAssetPaletteColumn(database);
  ensureGenerationMessageBindingSchema(database);
  rederiveStackSortCreatedAt(database);
  const timestamp = now();
  database.transaction(() => {
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(timestamp);
    database.exec("CREATE INDEX IF NOT EXISTS asset_versions_parent_idx ON asset_versions(project_id, parent_asset_id, created_at, asset_id)");
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, ?)").run(timestamp);
    database.exec("CREATE INDEX IF NOT EXISTS recipe_snapshots_asset_idx ON recipe_snapshots(project_id, asset_id, created_at, snapshot_id)");
    if (existingVersion < 3) backfillRecipeSnapshots(database);
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (3, ?)").run(timestamp);
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (4, ?)").run(timestamp);
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (5, ?)").run(timestamp);
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (6, ?)").run(timestamp);
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (7, ?)").run(timestamp);
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (8, ?)").run(timestamp);
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (9, ?)").run(timestamp);
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (10, ?)").run(timestamp);
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (11, ?)").run(timestamp);
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (12, ?)").run(timestamp);
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (13, ?)").run(timestamp);
    if (existingVersion < 15) {
      database.exec(`
        INSERT OR IGNORE INTO asset_short_terms (project_id, asset_id, term)
        SELECT a.project_id, a.id, CAST(short_term.value AS TEXT)
        FROM assets a, json_each(mosa_short_search_terms_json(a.search_text)) AS short_term
      `);
    }
    if (existingVersion < 16) backfillAutoSessionStacks(database, timestamp);
    if (existingVersion < 17) regroupJimengWorkspaceStacks(database, timestamp);
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (17, ?)").run(timestamp);
    database.prepare(`
      INSERT INTO library_meta (key, value, updated_at) VALUES ('schema_version', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      WHERE library_meta.value != excluded.value
    `).run(String(CURRENT_SCHEMA_VERSION), timestamp);
    database.prepare("INSERT OR IGNORE INTO library_meta (key, value, updated_at) VALUES ('migration_state', 'unmigrated', ?)").run(timestamp);
  })();
  if (existingVersion < 10) {
    const projectIds = database.prepare("SELECT id FROM projects ORDER BY id").all().map((row) => row.id);
    for (const projectId of projectIds) syncSqliteGenerationRelationCandidates(database, projectId);
  }
  cleanupOrphanedTrashFtsRows(database, timestamp);
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

const REPLACED_MEDIA_TRASH_REASON = "replaced-by-better-version";
// Prompt metadata never travels with a media replacement: an empty incoming
// prompt must not downgrade the stored one, and a better prompt may only land
// through maybeUpgradePrompt in the ingest layer.
const REPLACEMENT_PRESERVED_KEYS = new Set(["prompt_status", "prompt_source", "prompt_priority", "prompt_scope", "user_message"]);

function isEmptyValue(value) {
  return value === null || value === undefined || value === "";
}

/**
 * Replacement merge rule: incoming empty values ("", null) never erase stored
 * non-empty ones, non-empty incoming values win, and prompt fields are left to
 * the existing stored values entirely.
 */
function mergeReplacementObject(current, incoming) {
  const merged = { ...(current && typeof current === "object" ? current : {}) };
  if (!incoming || typeof incoming !== "object") return merged;
  for (const [key, value] of Object.entries(incoming)) {
    if (REPLACEMENT_PRESERVED_KEYS.has(key)) continue;
    if (isEmptyValue(value) && !isEmptyValue(merged[key])) continue;
    merged[key] = value;
  }
  return merged;
}

/**
 * Moves the replaced original and its three derivatives onto an independent
 * trashed snapshot asset: a fresh id (`<id>-replaced-<stamp>`), the old
 * prompt/source/pixel metadata, cleared provider ids (it must never answer a
 * provider-identity or deletion-sync lookup again), and no curation state.
 * Files are renamed before the caller's transaction; `rollback()` restores the
 * original names if that transaction fails, so the swap stays all-or-nothing.
 */
async function stageReplacedMediaSnapshot(database, store, projectId, row, current, { timestamp, cleanAssetId }) {
  const imagesDir = store.imagesDir(projectId);
  const oldOriginal = String(row.original_path || "");
  const originalExt = extname(oldOriginal) || extname(String(row.asset || "")) || ".png";
  const derivativeMoves = [
    { column: "preview_path", kind: "preview" },
    { column: "medium_path", kind: "medium" },
    { column: "thumbnail_path", kind: "thumbnail" },
  ].map(({ column }) => {
    const from = String(row[column] || "");
    // Derivative files are named `<asset id>.webp` inside their own directory
    // (previews/, mediums/, thumbnails/), so the rename only swaps the name.
    return from ? { column, from, dir: dirname(from) } : null;
  }).filter(Boolean);

  let snapshotId = "";
  for (let attempt = 0; attempt < 5 && !snapshotId; attempt += 1) {
    const candidate = sanitizeId(`${cleanAssetId}-replaced-${shortStamp()}`, "asset");
    const rowTaken = database.prepare("SELECT 1 FROM assets WHERE project_id = ? AND id = ?").get(projectId, candidate);
    if (rowTaken) continue;
    const targets = [
      join(imagesDir, `${candidate}${originalExt}`),
      ...derivativeMoves.map((move) => join(move.dir, `${candidate}.webp`)),
    ];
    if (targets.some((target) => existsSync(target))) continue;
    snapshotId = candidate;
  }
  if (!snapshotId) throw assetStoreError("REPLACEMENT_SNAPSHOT_COLLISION", "Could not allocate a Trash snapshot id for the replaced media.");

  const moves = [
    { from: oldOriginal, to: join(imagesDir, `${snapshotId}${originalExt}`), column: "original_path" },
    ...derivativeMoves.map((move) => ({ from: move.from, to: join(move.dir, `${snapshotId}.webp`), column: move.column })),
  ].filter((move) => move.from);

  const applied = [];
  const moveOne = async (move) => {
    try {
      await rename(move.from, move.to);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    applied.push(move);
    return true;
  };
  try {
    for (const move of moves) {
      // A missing file (derivatives never generated, video poster pending)
      // just leaves that column null; only real I/O failures abort.
      if (!await moveOne(move)) continue;
    }
  } catch (error) {
    for (const move of [...applied].reverse()) await rename(move.to, move.from).catch(() => {});
    throw error;
  }

  const movedByColumn = new Map(applied.map((move) => [move.column, move.to]));
  const derivativePaths = {
    preview: movedByColumn.get("preview_path") || null,
    medium: movedByColumn.get("medium_path") || null,
    thumbnail: movedByColumn.get("thumbnail_path") || null,
  };
  const { deleted_at: _deletedAt, ...currentWithoutDeletedAt } = current;
  const snapshotMetadata = normalizeAssetMetadata({
    ...currentWithoutDeletedAt,
    id: snapshotId,
    project_id: projectId,
    asset: basename(movedByColumn.get("original_path") || `${snapshotId}${originalExt}`),
    image_path: movedByColumn.get("original_path") || join(imagesDir, `${snapshotId}${originalExt}`),
    tags: [],
    favorite: false,
    rating: 0,
    group: "",
    category: "",
    parent_asset_id: null,
    child_asset_ids: [],
    version_change: "",
    archived: false,
    created_at: current.created_at,
    updated_at: timestamp,
    source: {
      ...(current.source || {}),
      provider_asset_id: null,
      logical_output_id: null,
    },
    trash_reason: { code: REPLACED_MEDIA_TRASH_REASON, at: timestamp },
  });
  return {
    id: snapshotId,
    metadata: snapshotMetadata,
    searchText: searchableText(snapshotMetadata),
    derivativePaths,
    async rollback() {
      for (const move of [...applied].reverse()) await rename(move.to, move.from).catch(() => {});
    },
  };
}

function saveAsset(database, metadata, options = {}, helpers = {}) {
  // Align the stored casing before anything is persisted so the membership
  // join, the facet filter, and the sidebar row stay one logical group. Runs
  // ahead of the asset INSERT: every caller (import, metadata edit, restore,
  // duplication) funnels through here.
  if (metadata.group) {
    metadata.group = canonicalGroupName(database, metadata.project_id, metadata.group) || metadata.group;
  }
  const source = metadata.source || {};
  const searchText = searchableText(metadata);
  const tagsText = tagsSearchText(metadata.tags);
  const sourceGroup = canonicalSourceTypeOf(metadata);
  const businessSearchText = searchableBusinessObjectText(metadata.business_fields);
  const sourceSearchText = searchableSourceObjectText(source, sourceGroup);
  const sourcePath = source.path == null ? "" : String(source.path);
  const mediaKind = mediaKindOf(metadata);
  const conversationId = source.conversation_id == null ? "" : String(source.conversation_id);
  const generationBatch = source.message_id == null ? "" : String(source.message_id);
  const sessionKey = generationSessionKey(metadata);
  const unknownMetadata = unknownFields(metadata);
  const write = database.transaction(() => {
    if (options.rejectAutomaticIngestDuplicate) {
      const hashes = normalizeSuppressionHashes(options.rejectAutomaticIngestDuplicate);
      let duplicate = null;
      let duplicateKind = "content";
      if (hashes.content_sha256) {
        duplicate = database.prepare(`
          SELECT id FROM assets INDEXED BY assets_project_hash_idx
          WHERE project_id = ? AND content_sha256 = ? AND deleted_at IS NULL
          ORDER BY archived ASC, created_at DESC, id DESC
          LIMIT 1
        `).get(metadata.project_id, hashes.content_sha256);
      }
      if (!duplicate && hashes.pixel_sha256) {
        duplicateKind = "pixel";
        duplicate = database.prepare(`
          SELECT id FROM assets INDEXED BY assets_project_pixel_hash_idx
          WHERE project_id = ? AND pixel_sha256 = ?
            AND deleted_at IS NULL
            AND (? = '' OR json_extract(source_json, '$.pixel_hash_version') = ?)
          ORDER BY archived ASC, created_at DESC, id DESC
          LIMIT 1
        `).get(metadata.project_id, hashes.pixel_sha256, hashes.pixel_hash_version, hashes.pixel_hash_version);
      }
      if (duplicate) {
        throw automaticIngestDuplicateError(duplicate.id, duplicateKind);
      }
    }
    if (options.rejectAutomaticIngestSuppression) {
      const hashes = normalizeSuppressionHashes(options.rejectAutomaticIngestSuppression);
      const suppression = database.prepare(`
        SELECT 1
        FROM automatic_ingest_suppressions
        WHERE project_id = ?
          AND ((? != '' AND content_sha256 = ?)
            OR (? != '' AND pixel_sha256 = ? AND (? = '' OR pixel_hash_version = ?)))
        LIMIT 1
      `).get(
        metadata.project_id,
        hashes.content_sha256,
        hashes.content_sha256,
        hashes.pixel_sha256,
        hashes.pixel_sha256,
        hashes.pixel_hash_version,
        hashes.pixel_hash_version,
      );
      if (suppression) throw automaticImportSuppressedError();
    }
    database.prepare("INSERT OR IGNORE INTO projects (id, created_at) VALUES (?, ?)").run(metadata.project_id, metadata.created_at);
    const updateOnConflict = options.insertOnly ? "" : `
      ON CONFLICT(project_id, id) DO UPDATE SET
        prompt = excluded.prompt, skill = excluded.skill, style = excluded.style, ratio = excluded.ratio,
        business_fields_json = excluded.business_fields_json, theme = excluded.theme, favorite = excluded.favorite,
        archived = excluded.archived, group_name = excluded.group_name, category = excluded.category, rating = excluded.rating,
        parent_asset_id = excluded.parent_asset_id, version_change = excluded.version_change, source_type = excluded.source_type,
        pixel_sha256 = excluded.pixel_sha256, source_json = excluded.source_json, source_path = excluded.source_path,
        provider_asset_id = excluded.provider_asset_id, logical_output_id = excluded.logical_output_id,
        metadata_json = excluded.metadata_json, search_text = excluded.search_text,
        tags_text = excluded.tags_text, business_search_text = excluded.business_search_text, source_search_text = excluded.source_search_text,
        media_kind = excluded.media_kind, source_group = excluded.source_group,
        conversation_id = excluded.conversation_id, generation_batch = excluded.generation_batch,
        generation_session_key = excluded.generation_session_key,
        created_at = excluded.created_at, created_at_epoch = excluded.created_at_epoch, updated_at = excluded.updated_at,
        sort_name = excluded.sort_name
    `;
    database.prepare(`
      INSERT INTO assets (
        project_id, id, asset, original_path, preview_path, thumbnail_path, content_sha256, pixel_sha256, prompt, skill, style, ratio,
        business_fields_json, theme, favorite, archived, group_name, category, rating, parent_asset_id, version_change,
        source_type, source_json, source_path, provider_asset_id, logical_output_id, metadata_json, search_text, tags_text, business_search_text, source_search_text, media_kind, source_group,
        conversation_id, generation_batch, generation_session_key,
        created_at, created_at_epoch, updated_at, sort_name
      ) VALUES (
        @project_id, @id, @asset, @image_path, NULL, NULL, @content_sha256, @pixel_sha256, @prompt, @skill, @style, @ratio,
        @business_fields_json, @theme, @favorite, @archived, @group_name, @category, @rating, @parent_asset_id, @version_change,
        @source_type, @source_json, @source_path, @provider_asset_id, @logical_output_id, @metadata_json, @search_text, @tags_text, @business_search_text, @source_search_text, @media_kind, @source_group,
        @conversation_id, @generation_batch, @generation_session_key,
        @created_at, @created_at_epoch, @updated_at, @sort_name
      )
      ${updateOnConflict}
    `).run({
      project_id: metadata.project_id,
      id: metadata.id,
      asset: metadata.asset,
      image_path: metadata.image_path,
      content_sha256: source.content_sha256 || "",
      pixel_sha256: source.pixel_sha256 || "",
      prompt: metadata.prompt,
      skill: metadata.skill,
      style: metadata.style,
      ratio: metadata.ratio,
      business_fields_json: JSON.stringify(metadata.business_fields),
      theme: metadata.theme,
      favorite: metadata.favorite ? 1 : 0,
      archived: metadata.archived ? 1 : 0,
      group_name: metadata.group,
      category: metadata.category,
      rating: metadata.rating,
      parent_asset_id: metadata.parent_asset_id,
      version_change: metadata.version_change,
      source_type: String(source.type || "local-file"),
      source_json: JSON.stringify(source),
      source_path: sourcePath,
      provider_asset_id: String(source.provider_asset_id || ""),
      logical_output_id: String(source.logical_output_id || ""),
      metadata_json: JSON.stringify(unknownMetadata),
      search_text: searchText,
      tags_text: tagsText,
      business_search_text: businessSearchText,
      source_search_text: sourceSearchText,
      media_kind: mediaKind,
      source_group: sourceGroup,
      conversation_id: conversationId,
      generation_batch: generationBatch,
      generation_session_key: sessionKey,
      created_at: metadata.created_at,
      created_at_epoch: createdAtTimestamp(metadata.created_at),
      updated_at: metadata.updated_at,
      sort_name: assetSortName(metadata),
    });
    database.prepare("DELETE FROM asset_tags WHERE project_id = ? AND asset_id = ?").run(metadata.project_id, metadata.id);
    const insertTag = database.prepare("INSERT OR IGNORE INTO tags (id, normalized_name, name) VALUES (?, ?, ?)");
    const relateTag = database.prepare("INSERT OR IGNORE INTO asset_tags (project_id, asset_id, tag_id) VALUES (?, ?, ?)");
    for (const tag of metadata.tags) {
      const normalized = tag.trim().toLocaleLowerCase();
      if (!normalized) continue;
      const tagId = `tag-${createHash("sha256").update(normalized).digest("hex").slice(0, 20)}`;
      insertTag.run(tagId, normalized, tag.trim());
      relateTag.run(metadata.project_id, metadata.id, tagId);
    }
    if (metadata.group) {
      // Casing is already canonical (normalized at the top of saveAsset);
      // this only materializes a brand-new group row at the tail position.
      const nextPosition = database.prepare(
        "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM groups WHERE project_id = ?",
      ).get(metadata.project_id).next;
      database.prepare(
        "INSERT OR IGNORE INTO groups (project_id, name, created_at, position, color) VALUES (?, ?, ?, ?, '')",
      ).run(metadata.project_id, metadata.group, metadata.created_at, nextPosition);
    }
    database.prepare(`
      INSERT INTO asset_versions (project_id, asset_id, parent_asset_id, change_summary, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id, asset_id) DO UPDATE SET
        parent_asset_id = excluded.parent_asset_id,
        change_summary = excluded.change_summary,
        created_at = excluded.created_at
    `).run(metadata.project_id, metadata.id, metadata.parent_asset_id, metadata.version_change, metadata.created_at);
    // The upsert above never touches deleted_at, so the stored row is the
    // authority on whether this save must stay out of the search index.
    const storedDeletedAt = database.prepare("SELECT deleted_at FROM assets WHERE project_id = ? AND id = ?")
      .get(metadata.project_id, metadata.id)?.deleted_at || null;
    syncAssetFtsEntry(database, metadata.project_id, metadata.id, searchText, storedDeletedAt);
    replaceAssetShortTerms(database, metadata.project_id, metadata.id, searchText);
    if (options.recipeSnapshot) insertRecipeSnapshot(database, options.recipeSnapshot);
    if (options.enqueueDerivative) {
      database.prepare(`
        INSERT INTO derivative_jobs (project_id, asset_id, status, attempts, created_at, updated_at)
        VALUES (?, ?, 'pending', 0, ?, ?)
        ON CONFLICT(project_id, asset_id) DO UPDATE SET status = 'pending', error = NULL, updated_at = excluded.updated_at
      `).run(metadata.project_id, metadata.id, metadata.updated_at, metadata.updated_at);
    }
    if (options.clearAutomaticIngestSuppression) {
      const hashes = normalizeSuppressionHashes(options.clearAutomaticIngestSuppression);
      database.prepare(`
        DELETE FROM automatic_ingest_suppressions
        WHERE project_id = ?
          AND ((? != '' AND content_sha256 = ?)
            OR (? != '' AND pixel_sha256 = ? AND (? = '' OR pixel_hash_version = ?)))
      `).run(
        metadata.project_id,
        hashes.content_sha256,
        hashes.content_sha256,
        hashes.pixel_sha256,
        hashes.pixel_sha256,
        hashes.pixel_hash_version,
        hashes.pixel_hash_version,
      );
    }
    if (Array.isArray(options.libraryChanges) && options.libraryChanges.length) {
      // The commit helper is store-instance state (transaction-wrapped); callers
      // inside createSqliteAssetStore pass it so the journal rows land in the
      // same transaction as the asset write.
      if (typeof helpers.commitLibraryChanges !== "function") {
        throw new Error("saveAsset requires commitLibraryChanges to record its library change.");
      }
      helpers.commitLibraryChanges(options.libraryChanges);
    }
  });
  // The suppression lookup and the insert must share one write lock. Otherwise
  // a deletion can commit its suppression between the preflight lookup and the
  // asset row insert, which would resurrect a deleted automatic capture.
  if (options.rejectAutomaticIngestSuppression) write.immediate();
  else write();
}

/**
 * Only `references_json` is refreshed on conflict, and only so that rights
 * recorded after archival reach the stored snapshot. Every other column is part
 * of the frozen recipe and must stay immutable. See `refreshReferenceRights` in
 * `lib/recipe-snapshot.mjs`; the previous `INSERT OR IGNORE` silently discarded
 * those annotations.
 */
function insertRecipeSnapshot(database, snapshot) {
  database.prepare(`
    INSERT INTO recipe_snapshots (
      project_id, asset_id, snapshot_id, schema_version, recipe_digest, prompt_digest,
      effective_prompt, user_prompt, negative_prompt, prompt_status, generation_tool,
      model, provider, skill, style, ratio, theme, references_json, provenance_json,
      change_summary, created_at
    ) VALUES (
      @project_id, @asset_id, @snapshot_id, @schema_version, @recipe_digest, @prompt_digest,
      @effective_prompt, @user_prompt, @negative_prompt, @prompt_status, @generation_tool,
      @model, @provider, @skill, @style, @ratio, @theme, @references_json, @provenance_json,
      @change_summary, @created_at
    )
    ON CONFLICT (project_id, asset_id, snapshot_id) DO UPDATE SET
      references_json = excluded.references_json
  `).run({
    ...snapshot,
    references_json: JSON.stringify(snapshot.references || []),
    provenance_json: JSON.stringify(snapshot.provenance || {}),
  });
}

function backfillRecipeSnapshots(database) {
  const rows = database.prepare(`
    SELECT a.* FROM assets a
    LEFT JOIN recipe_snapshots r ON r.project_id = a.project_id AND r.asset_id = a.id
    WHERE r.snapshot_id IS NULL
    ORDER BY a.project_id, a.created_at, a.id
  `).all();
  for (const row of rows) {
    const asset = recipeAssetFromRow(row);
    insertRecipeSnapshot(database, buildRecipeSnapshot(asset, {
      createdAt: row.updated_at || row.created_at,
      changeSummary: row.version_change || "Backfilled current recipe",
    }));
  }
}

function sqliteRecipeHistory(database, assetRow) {
  const snapshots = database.prepare(`
    SELECT * FROM recipe_snapshots
    WHERE project_id = ? AND asset_id = ?
    ORDER BY created_at, rowid
  `).all(assetRow.project_id, assetRow.id).map(snapshotRowToObject);
  const current = buildRecipeSnapshot(recipeAssetFromRow(assetRow));
  const active = snapshots.find((snapshot) => snapshot.recipe_digest === current.recipe_digest)
    || snapshots.at(-1)
    || current;
  return {
    project_id: assetRow.project_id,
    asset_id: assetRow.id,
    active_snapshot_id: active.snapshot_id,
    snapshots: snapshots.length ? snapshots : [current],
  };
}

function snapshotRowToObject(row) {
  return {
    snapshot_id: row.snapshot_id,
    schema_version: row.schema_version,
    project_id: row.project_id,
    asset_id: row.asset_id,
    recipe_digest: row.recipe_digest,
    prompt_digest: row.prompt_digest,
    effective_prompt: row.effective_prompt,
    user_prompt: row.user_prompt,
    negative_prompt: row.negative_prompt,
    prompt_status: row.prompt_status,
    generation_tool: row.generation_tool,
    model: row.model,
    provider: row.provider,
    skill: row.skill,
    style: row.style,
    ratio: row.ratio,
    theme: row.theme,
    // Normalised on read so a snapshot written before the rights matrix comes
    // back with the same shape the JSON store produces. Without this, "nobody
    // has reviewed this reference yet" would be absent from SQLite rows rather
    // than visibly unknown, and the two stores would disagree.
    references: normalizeSnapshotReferences(parseJson(row.references_json, [])),
    provenance: parseJson(row.provenance_json, {}),
    change_summary: row.change_summary,
    created_at: row.created_at,
  };
}

function recipeAssetFromRow(row) {
  const metadata = parseJson(row.metadata_json, {});
  return {
    ...metadata,
    id: row.id,
    project_id: row.project_id,
    prompt: row.prompt,
    skill: row.skill,
    style: row.style,
    ratio: row.ratio,
    business_fields: parseJson(row.business_fields_json, {}),
    theme: row.theme,
    version_change: row.version_change,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source: parseJson(row.source_json, {}),
  };
}

function rowToAsset(database, row, options = {}) {
  const metadata = parseJson(row.metadata_json, {});
  const source = parseJson(row.source_json, {});
  const includeRelations = options.includeRelations !== false;
  const asset = {
    ...metadata,
    id: row.id,
    project_id: row.project_id,
    asset: row.asset,
    image_path: row.original_path,
    prompt_path: null,
    prompt: row.prompt,
    content_sha256: row.content_sha256 || "",
    pixel_sha256: row.pixel_sha256 || "",
    skill: row.skill,
    style: row.style,
    ratio: row.ratio,
    business_fields: parseJson(row.business_fields_json, {}),
    theme: row.theme,
    tags: [],
    favorite: Boolean(row.favorite),
    archived: Boolean(row.archived),
    deleted_at: row.deleted_at || null,
    group: row.group_name,
    category: row.category,
    rating: row.rating,
    parent_asset_id: row.parent_asset_id,
    version_change: row.version_change,
    child_asset_ids: [],
    created_at: row.created_at,
    updated_at: row.updated_at,
    source,
    preview_path: row.preview_path,
    medium_path: row.medium_path,
    thumbnail_path: row.thumbnail_path,
    // Dominant colors as plain hex strings, largest share first. The full
    // {hex, ratio} entries stay internal: callers only need the swatch order.
    palette: paletteJsonToHexes(row.palette_json),
  };
  if (!includeRelations) return withRuntimeUrls(asset);

  const recipe = sqliteRecipeHistory(database, row);
  asset.tags = database.prepare(`
    SELECT t.name FROM tags t JOIN asset_tags at ON at.tag_id = t.id
    WHERE at.project_id = ? AND at.asset_id = ? ORDER BY t.name COLLATE NOCASE
  `).all(row.project_id, row.id).map((tag) => tag.name);
  asset.child_asset_ids = database.prepare("SELECT asset_id FROM asset_versions WHERE project_id = ? AND parent_asset_id = ? ORDER BY created_at, asset_id").all(row.project_id, row.id).map((child) => child.asset_id);
  asset.recipe_snapshots = recipe.snapshots;
  asset.active_recipe_snapshot_id = recipe.active_snapshot_id;
  return withRuntimeUrls(asset);
}

/**
 * Derivative routes serve with a one-year immutable cache and the derivative
 * file names are keyed by asset id, so a media replacement would keep serving
 * the previous pixels forever. The content version (content_sha256 prefix)
 * in `?v=` changes whenever the bytes change. Original URLs need no version:
 * a replacement always writes the original under a new file name, and the
 * fallback must stay equal to image_url for renderer comparisons.
 */
function contentVersionParam(asset) {
  const hash = String(asset?.content_sha256 || "").trim();
  return hash ? `?v=${encodeURIComponent(hash.slice(0, 12))}` : "";
}

function withRuntimeUrls(asset) {
  const base = `/library/${encodeURIComponent(asset.project_id)}`;
  const original = `${base}/images/${encodeURIComponent(asset.asset)}`;
  const version = contentVersionParam(asset);
  return {
    ...asset,
    image_url: original,
    preview_url: asset.preview_path ? `${base}/previews/${encodeURIComponent(asset.id)}.webp${version}` : original,
    medium_url: asset.medium_path ? `${base}/mediums/${encodeURIComponent(asset.id)}.webp${version}` : (asset.preview_path ? `${base}/previews/${encodeURIComponent(asset.id)}.webp${version}` : original),
    thumbnail_url: asset.thumbnail_path ? `${base}/thumbnails/${encodeURIComponent(asset.id)}.webp${version}` : original,
    preview_ready: Boolean(asset.preview_path),
    medium_ready: Boolean(asset.medium_path),
    thumbnail_ready: Boolean(asset.thumbnail_path),
    prompt_file: null,
  };
}

// Stay far below SQLite's bound-parameter ceiling so one statement per chunk
// covers any page size without risking "too many SQL variables".
const TAG_LOOKUP_BATCH_SIZE = 500;

/**
 * List pages build assets with `rowToAsset(..., { includeRelations: false })`,
 * which leaves `tags` empty for speed. The inspector edits tags straight from
 * that list payload, so an empty array would make its next save overwrite the
 * real tags with nothing. Refill them for the whole page in batched queries —
 * never per asset. Ordering matches the includeRelations branch exactly
 * (`ORDER BY t.name COLLATE NOCASE`); each asset lands in exactly one chunk,
 * so per-chunk ordering still yields the full per-asset order.
 */
function attachAssetTags(database, projectId, assets) {
  if (!Array.isArray(assets) || !assets.length) return assets;
  const tagsByAssetId = new Map(assets.map((asset) => [asset.id, []]));
  const ids = [...tagsByAssetId.keys()];
  for (let start = 0; start < ids.length; start += TAG_LOOKUP_BATCH_SIZE) {
    const batch = ids.slice(start, start + TAG_LOOKUP_BATCH_SIZE);
    const rows = database.prepare(`
      SELECT at.asset_id AS asset_id, t.name AS name
      FROM asset_tags at JOIN tags t ON t.id = at.tag_id
      WHERE at.project_id = ? AND at.asset_id IN (${batch.map(() => "?").join(",")})
      ORDER BY t.name COLLATE NOCASE
    `).all(projectId, ...batch);
    for (const row of rows) tagsByAssetId.get(row.asset_id)?.push(row.name);
  }
  for (const asset of assets) asset.tags = tagsByAssetId.get(asset.id) || [];
  return assets;
}

/**
 * Attaches the exact ORDER BY tuple the page used to each returned asset, so
 * incremental clients can re-position a changed node without re-listing. For
 * collapsed galleries the tuple is the *node's* sort key (the Stack anchor),
 * not the cover asset row's own values. `ranked` marks relevance-ordered pages
 * (type-intent searches); plain pages pass null so clients know the order is
 * reproducible from the created/name keys alone.
 */
function annotateGalleryNodeSort(assets, pageRows, { collapsed = false, ranked = false } = {}) {
  assets.forEach((asset, index) => {
    const row = pageRows[index];
    if (!row) return;
    asset.node_sort = {
      createdAt: String((collapsed ? row._node_created_at : row.created_at) ?? ""),
      sortName: String((collapsed ? row._node_sort_name : row.sort_name) ?? ""),
      searchScore: ranked && row._search_score != null ? Number(row._search_score) : null,
    };
  });
}

function annotateAssetStackCovers(database, assets, projectId) {
  if (!assets.length) return assets;
  if (!database.prepare("SELECT 1 FROM asset_stacks WHERE project_id = ? LIMIT 1").get(projectId)) return assets;
  const ids = assets.map((asset) => asset.id);
  const rows = database.prepare(`
    WITH requested_assets(asset_id) AS (
      SELECT CAST(value AS TEXT) FROM json_each(@assetIds)
    ), requested_members AS MATERIALIZED (
      SELECT sm.asset_id, sm.stack_id, sm.position
      FROM asset_stack_members sm
      JOIN requested_assets requested ON requested.asset_id = sm.asset_id
      WHERE sm.project_id = @projectId
    ), relevant_stacks AS MATERIALIZED (
      SELECT DISTINCT stack_id FROM requested_members
    ), stack_stats AS MATERIALIZED (
      SELECT sm.stack_id,
        COUNT(*) AS member_count,
        MIN(sm.position) AS first_position
      FROM asset_stack_members sm
      JOIN relevant_stacks relevant ON relevant.stack_id = sm.stack_id
      JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
      WHERE sm.project_id = @projectId AND a.deleted_at IS NULL AND a.archived = 0
      GROUP BY sm.stack_id
    )
    SELECT requested.asset_id, requested.stack_id, stats.member_count, s.name
    FROM requested_members requested
    JOIN stack_stats stats ON stats.stack_id = requested.stack_id AND stats.first_position = requested.position
    JOIN asset_stacks s ON s.project_id = @projectId AND s.id = requested.stack_id
  `).all({ projectId, assetIds: JSON.stringify(ids) });
  const byAssetId = new Map(rows.map((row) => [row.asset_id, row]));
  return assets.map((asset) => {
    const row = byAssetId.get(asset.id);
    if (!row || Number(row.member_count) < 2) return asset;
    return {
      ...asset,
      stack: { id: row.stack_id, count: Number(row.member_count), name: String(row.name || "") },
    };
  });
}

function stackSummary(database, projectId, stackId) {
  const row = database.prepare(`
    SELECT s.id, s.name, s.created_at, s.updated_at, s.origin, s.session_key,
      SUM(CASE WHEN a.deleted_at IS NULL AND a.archived = 0 THEN 1 ELSE 0 END) AS member_count,
      MIN(CASE WHEN a.deleted_at IS NULL AND a.archived = 0 THEN sm.position ELSE NULL END) AS first_active_position
    FROM asset_stacks s
    LEFT JOIN asset_stack_members sm
      ON sm.project_id = s.project_id AND sm.stack_id = s.id
    LEFT JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
    WHERE s.project_id = ? AND s.id = ?
    GROUP BY s.project_id, s.id
  `).get(projectId, stackId);
  if (!row) return null;
  const cover = row.first_active_position == null ? null : database.prepare(`
    SELECT asset_id FROM asset_stack_members sm
    JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
    WHERE sm.project_id = ? AND sm.stack_id = ? AND sm.position = ? AND a.deleted_at IS NULL AND a.archived = 0
    LIMIT 1
  `).get(projectId, stackId, row.first_active_position);
  return {
    id: row.id,
    name: String(row.name || ""),
    count: Number(row.member_count || 0),
    cover_asset_id: cover?.asset_id || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    origin: String(row.origin || "manual"),
    session_key: String(row.session_key || ""),
  };
}

function syncAssetStackCoverSortName(database, projectId, stackId, timestamp = null) {
  const nextUpdatedAt = timestamp || now();
  database.prepare(`
    UPDATE asset_stacks
    SET updated_at = ?,
        sort_name = CASE WHEN name != '' THEN mosa_sort_name(name, '', id) ELSE COALESCE((
          SELECT a.sort_name
          FROM asset_stack_members sm
          JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
          WHERE sm.project_id = asset_stacks.project_id
            AND sm.stack_id = asset_stacks.id
            AND a.archived = 0
            AND a.deleted_at IS NULL
          ORDER BY sm.position, a.id
          LIMIT 1
        ), '') END
    WHERE project_id = ? AND id = ?
  `).run(nextUpdatedAt, projectId, stackId);
}

function compactAssetStack(database, projectId, stackId) {
  const rows = database.prepare(`
    SELECT asset_id FROM asset_stack_members
    WHERE project_id = ? AND stack_id = ?
    ORDER BY position, asset_id
  `).all(projectId, stackId);
  if (rows.length <= 1) {
    database.prepare("DELETE FROM asset_stacks WHERE project_id = ? AND id = ?").run(projectId, stackId);
    return { dissolved: true, remainingAssetId: rows[0]?.asset_id || null };
  }
  database.prepare(`
    UPDATE asset_stack_members SET position = position + 1000000
    WHERE project_id = ? AND stack_id = ?
  `).run(projectId, stackId);
  const update = database.prepare(`
    UPDATE asset_stack_members SET position = ?
    WHERE project_id = ? AND stack_id = ? AND asset_id = ?
  `);
  rows.forEach((row, index) => update.run(index, projectId, stackId, row.asset_id));
  syncAssetStackCoverSortName(database, projectId, stackId);
  return { dissolved: false, remainingAssetId: null };
}

// Migration 16 backfills stacks inside the schema transaction, before the
// store's change-journal helper exists; it parks the touched project ids here
// so the freshly opened store can announce one full-refresh change per project.
const AUTO_STACK_BACKFILL_NOTIFY_KEY = "auto_stack_backfill_pending_v1";
const REFERENCE_HARDLINK_MIGRATION_KEY = "reference_hardlink_migration_done_v1";

// A user pulling an asset out of any stack — directly, by dissolving the
// stack, or by moving it into another stack — is final: the tombstone outlives
// the stack row so later ingests from the same session never re-stack the
// asset. The recorded key is the ASSET's own session, not the stack's, because
// stacks may mix sessions and manual stacks carry none; assets without a
// session identity are skipped (they are never auto-stacked anyway). No
// foreign key, mirroring automatic_ingest_suppressions: the marker must
// survive the asset row it describes.
function addAutoStackExclusions(database, projectId, assetIds) {
  const ids = [...new Set((Array.isArray(assetIds) ? assetIds : []).filter(Boolean))];
  if (!ids.length) return;
  const timestamp = now();
  const insert = database.prepare(`
    INSERT INTO auto_stack_exclusions (project_id, asset_id, session_key, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id, asset_id) DO UPDATE SET
      session_key = excluded.session_key,
      created_at = excluded.created_at
  `);
  const sessionKeyOf = database.prepare("SELECT generation_session_key FROM assets WHERE project_id = ? AND id = ?");
  for (const assetId of ids) {
    const sessionKey = String(sessionKeyOf.get(projectId, assetId)?.generation_session_key || "");
    if (!sessionKey) continue;
    insert.run(projectId, assetId, sessionKey, timestamp);
  }
}

// The stack a session's images belong to: across every stack in the project
// (manual and auto alike), the one holding the most active members of this
// session wins; ties go to the oldest stack, then the smallest id. Driven by
// the assets(project_id, generation_session_key) index and the member table's
// (project_id, asset_id) primary key — no library-wide scan. Shared by the
// ingest path and the migration backfill.
function targetStackForSession(database, projectId, sessionKey) {
  return database.prepare(`
    SELECT sm.stack_id AS id, s.origin, s.name, s.name_locked, COUNT(*) AS session_member_count
    FROM assets a
    JOIN asset_stack_members sm ON sm.project_id = a.project_id AND sm.asset_id = a.id
    JOIN asset_stacks s ON s.project_id = sm.project_id AND s.id = sm.stack_id
    WHERE a.project_id = ? AND a.generation_session_key = ?
      AND a.archived = 0 AND a.deleted_at IS NULL
    GROUP BY sm.stack_id
    ORDER BY session_member_count DESC, s.created_at, s.id
    LIMIT 1
  `).get(projectId, sessionKey) || null;
}

// Appends rows at the end of an existing stack, whatever its origin. A session
// title only names a stack nobody named (sessionTitleMayNameStack below).
// `commitLibraryChanges` is omitted by the backfill, which announces the whole
// sweep once at the end.
function appendSessionAssetsToStack(database, projectId, stackId, sessionKey, orderedRows, title, options = {}) {
  if (!orderedRows.length) return null;
  const stack = database.prepare(`
    SELECT id, origin, name, name_locked FROM asset_stacks
    WHERE project_id = ? AND id = ?
  `).get(projectId, stackId);
  if (!stack) return null;
  const timestamp = options.timestamp || now();
  const insertMember = database.prepare(`
    INSERT INTO asset_stack_members (project_id, stack_id, asset_id, position, added_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  let nextPosition = Number(database.prepare(`
    SELECT COALESCE(MAX(position), -1) + 1 AS next_position
    FROM asset_stack_members WHERE project_id = ? AND stack_id = ?
  `).get(projectId, stackId).next_position);
  const appendedIds = [];
  for (const row of orderedRows) {
    insertMember.run(projectId, stackId, row.id, nextPosition, timestamp);
    appendedIds.push(row.id);
    nextPosition += 1;
  }
  database.prepare("UPDATE asset_stacks SET updated_at = ? WHERE project_id = ? AND id = ?")
    .run(timestamp, projectId, stackId);
  let renamed = false;
  if (sessionTitleMayNameStack(database, projectId, stack, sessionKey, title)) {
    database.prepare("UPDATE asset_stacks SET name = ?, sort_name = ? WHERE project_id = ? AND id = ?")
      .run(title, assetSortName({ theme: title, asset: "", id: stackId }), projectId, stackId);
    renamed = true;
  }
  if (typeof options.commitLibraryChanges === "function") {
    const coverAssetId = stackSummary(database, projectId, stackId)?.cover_asset_id || "";
    options.commitLibraryChanges([{
      projectId, kind: "stack-members-changed", entityType: "stack", entityId: stackId,
      assetIds: appendedIds, detail: { coverAssetId },
    }]);
    if (renamed) {
      options.commitLibraryChanges([{ projectId, kind: "stack-updated", entityType: "stack", entityId: stackId, assetIds: appendedIds }]);
    }
  }
  return stackId;
}

// The one naming rule for session titles, shared by the ingest append path and
// applySessionTitle: the title must exist, the stack must be unnamed and not
// user-locked, and it is either an auto stack or a manual stack whose every
// active member came from this one session — a stack mixing sessions or other
// sources keeps its (empty) name. `stack` is the asset_stacks row carrying
// id/origin/name/name_locked.
function sessionTitleMayNameStack(database, projectId, stack, sessionKey, title) {
  if (!title) return false;
  if (Number(stack.name_locked)) return false;
  if (String(stack.name || "")) return false;
  return stack.origin === "auto" || stackHoldsOnlySession(database, projectId, stack.id, sessionKey);
}

function stackHoldsOnlySession(database, projectId, stackId, sessionKey) {
  if (!sessionKey) return false;
  return !database.prepare(`
    SELECT 1 FROM asset_stack_members sm
    JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
    WHERE sm.project_id = ? AND sm.stack_id = ?
      AND a.archived = 0 AND a.deleted_at IS NULL
      AND a.generation_session_key != ?
    LIMIT 1
  `).get(projectId, stackId, sessionKey);
}

// Creates the session's auto stack from at least two eligible members,
// chronologically ordered with the earliest image as cover.
function createAutoSessionStack(database, projectId, sessionKey, orderedRows, title, options = {}) {
  if (orderedRows.length < 2) return null;
  // Defensive: the partial unique index allows exactly one auto stack per
  // session, so a leftover auto row whose members are all trashed absorbs the
  // rows instead of crashing the write (the active-member target rule above
  // deliberately does not see it).
  const orphan = database.prepare(`
    SELECT id FROM asset_stacks WHERE project_id = ? AND session_key = ? AND origin = 'auto'
    ORDER BY created_at, id LIMIT 1
  `).get(projectId, sessionKey);
  if (orphan) return appendSessionAssetsToStack(database, projectId, orphan.id, sessionKey, orderedRows, title, options);
  const timestamp = options.timestamp || now();
  const stackId = `stack-${randomUUID()}`;
  const coverRow = orderedRows[0];
  database.prepare(`
    INSERT INTO asset_stacks (project_id, id, created_at, updated_at, sort_created_at, sort_name, name, origin, session_key, name_locked)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'auto', ?, 0)
  `).run(
    projectId,
    stackId,
    timestamp,
    timestamp,
    String(coverRow.created_at || timestamp),
    title ? assetSortName({ theme: title, asset: "", id: stackId }) : String(coverRow.sort_name || ""),
    title || "",
    sessionKey,
  );
  const insertMember = database.prepare(`
    INSERT INTO asset_stack_members (project_id, stack_id, asset_id, position, added_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  orderedRows.forEach((row, index) => insertMember.run(projectId, stackId, row.id, index, timestamp));
  if (typeof options.commitLibraryChanges === "function") {
    options.commitLibraryChanges([{
      projectId, kind: "stack-created", entityType: "stack", entityId: stackId,
      assetIds: orderedRows.map((row) => row.id), detail: { coverAssetId: coverRow.id },
    }]);
  }
  return stackId;
}

// Active, unstacked, non-excluded members of one session, oldest first — the
// eligibility rule both the ingest path and the backfill apply.
function autoStackSessionCandidates(database, projectId, sessionKey) {
  return database.prepare(`
    SELECT a.id, a.created_at, a.sort_name, a.source_json
    FROM assets a
    LEFT JOIN asset_stack_members sm ON sm.project_id = a.project_id AND sm.asset_id = a.id
    WHERE a.project_id = ? AND a.generation_session_key = ?
      AND a.archived = 0 AND a.deleted_at IS NULL
      AND sm.asset_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM auto_stack_exclusions x
        WHERE x.project_id = a.project_id AND x.asset_id = a.id
      )
    ORDER BY a.created_at, a.id
  `).all(projectId, sessionKey);
}

// Runs right after a successful createAsset commit, in its own transaction so a
// stacking failure can never roll the ingest back (createAsset logs and moves
// on). Existing membership and exclusions win: the function is a no-op for an
// asset the user has already organised or deliberately pulled out.
function autoStackAssetAfterInsert(database, projectId, assetId, { commitLibraryChanges }) {
  const asset = database.prepare(`
    SELECT id, created_at, sort_name, archived, deleted_at, generation_session_key, source_json
    FROM assets WHERE project_id = ? AND id = ?
  `).get(projectId, assetId);
  if (!asset || asset.archived || asset.deleted_at) return null;
  const sessionKey = String(asset.generation_session_key || "");
  if (!sessionKey) return null;
  if (database.prepare("SELECT 1 FROM auto_stack_exclusions WHERE project_id = ? AND asset_id = ?").get(projectId, assetId)) return null;
  const title = generationSessionTitle({ source: parseJson(asset.source_json, {}) });
  const apply = database.transaction(() => {
    const membership = database.prepare("SELECT stack_id FROM asset_stack_members WHERE project_id = ? AND asset_id = ?").get(projectId, assetId);
    if (membership) return null;
    // A stack already holding this session's images absorbs the new image
    // whatever its origin; only a session with no stack yet follows the
    // two-image rule for creating an auto stack.
    const target = targetStackForSession(database, projectId, sessionKey);
    if (target) {
      return appendSessionAssetsToStack(database, projectId, target.id, sessionKey, [asset], title, { commitLibraryChanges });
    }
    const candidates = autoStackSessionCandidates(database, projectId, sessionKey);
    if (candidates.length < 2) return null;
    const groupTitle = title
      || candidates.map((row) => generationSessionTitle({ source: parseJson(row.source_json, {}) })).find(Boolean)
      || "";
    return createAutoSessionStack(database, projectId, sessionKey, candidates, groupTitle, { commitLibraryChanges });
  });
  return apply.immediate();
}

// Migration 16: one pass over every session in the library, executed inside the
// numbered-migration transaction (no nested transaction here). All stacks are
// built from a single ordered snapshot of eligible assets — no per-stack
// rescans — and the only journal entry is one full-refresh notification per
// touched project, parked in library_meta for the store to commit after open.
function backfillAutoSessionStacks(database, timestamp) {
  const rows = database.prepare(`
    SELECT a.project_id, a.id, a.created_at, a.sort_name, a.generation_session_key, a.source_json
    FROM assets a
    LEFT JOIN asset_stack_members sm ON sm.project_id = a.project_id AND sm.asset_id = a.id
    WHERE a.archived = 0 AND a.deleted_at IS NULL AND a.generation_session_key != ''
      AND sm.asset_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM auto_stack_exclusions x
        WHERE x.project_id = a.project_id AND x.asset_id = a.id
      )
    ORDER BY a.project_id, a.generation_session_key, a.created_at, a.id
  `).all();
  if (!rows.length) return;
  const touchedProjects = new Set();
  let currentKey = null;
  let group = [];
  const flushGroup = () => {
    if (group.length) {
      const projectId = group[0].project_id;
      const sessionKey = group[0].generation_session_key;
      const title = group.map((row) => generationSessionTitle({ source: parseJson(row.source_json, {}) })).find(Boolean) || "";
      // A stack already holding this session's images (a manual stack at
      // migration time) absorbs every loose image at any count, in ingest-time
      // order; sessions no stack touched follow the ≥2 auto-stack rule.
      const target = targetStackForSession(database, projectId, sessionKey);
      const stackId = target
        ? appendSessionAssetsToStack(database, projectId, target.id, sessionKey, group, title, { timestamp })
        : createAutoSessionStack(database, projectId, sessionKey, group, title, { timestamp });
      if (stackId) touchedProjects.add(projectId);
    }
    group = [];
  };
  for (const row of rows) {
    const key = `${row.project_id}\u0000${row.generation_session_key}`;
    if (key !== currentKey) {
      flushGroup();
      currentKey = key;
    }
    group.push(row);
  }
  flushGroup();
  if (touchedProjects.size) {
    database.prepare(`
      INSERT INTO library_meta (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(AUTO_STACK_BACKFILL_NOTIFY_KEY, JSON.stringify([...touchedProjects]), timestamp);
  }
}

// Migration 17: Jimeng's session id changed from the per-generation record id
// to the conversation window (the workspace query param in the page address),
// so already-ingested Jimeng assets re-key into one session per window.
// ensureGenerationSessionColumn has already re-derived the asset keys inside
// this open; this pass moves the regrouped assets into their window's auto
// stack with the ingest-time rules (reuse of the same helpers, no parallel
// rule set). User organisation always wins: assets in manual stacks, in
// renamed (name_locked) auto stacks, or excluded via auto_stack_exclusions
// are never moved. Only an unlocked auto stack keyed by an old Jimeng record
// id gives its members up; it is then compacted under the existing stack rules
// (empty or single-member stacks dissolve). Ingest only ever files an asset
// into its own session's stack, so a Jimeng asset inside another source's
// auto stack got there by the user moving it — that placement is the user's
// organisation and stays. Runs inside the numbered-migration transaction; the only journal
// entry is the shared backfill notify key, merged with any list migration 16
// parked for this same open (a v15 library runs both migrations at once).
function regroupJimengWorkspaceStacks(database, timestamp) {
  const rows = database.prepare(`
    SELECT a.project_id, a.id, a.created_at, a.sort_name, a.generation_session_key AS session_key, a.source_json,
      s.id AS stack_id, s.origin AS stack_origin, s.session_key AS stack_session_key, s.name_locked AS stack_name_locked
    FROM assets a
    LEFT JOIN asset_stack_members sm ON sm.project_id = a.project_id AND sm.asset_id = a.id
    LEFT JOIN asset_stacks s ON s.project_id = sm.project_id AND s.id = sm.stack_id
    WHERE a.archived = 0 AND a.deleted_at IS NULL
      AND a.generation_session_key LIKE 'web-jimeng:%'
      AND NOT EXISTS (
        SELECT 1 FROM auto_stack_exclusions x
        WHERE x.project_id = a.project_id AND x.asset_id = a.id
      )
    ORDER BY a.project_id, a.generation_session_key, a.created_at, a.id
  `).all();
  if (!rows.length) return;
  const deleteMembership = database.prepare(
    "DELETE FROM asset_stack_members WHERE project_id = ? AND asset_id = ? AND stack_id = ?",
  );
  const autoStackForSession = database.prepare(`
    SELECT id FROM asset_stacks
    WHERE project_id = ? AND session_key = ? AND origin = 'auto'
    ORDER BY created_at, id
    LIMIT 1
  `);
  const touchedProjects = new Set();
  const emptiedStacks = new Set();
  let currentKey = null;
  let group = [];
  const flushGroup = () => {
    if (group.length) {
      const projectId = group[0].project_id;
      const sessionKey = group[0].session_key;
      // Movable: loose, or held by an unlocked auto stack of an old Jimeng
      // record session. Members already in this session's auto stack, and
      // members of manual, renamed, or other-source stacks, keep their place.
      const movable = group.filter((row) => !row.stack_id
        || (row.stack_origin === "auto" && !Number(row.stack_name_locked)
          && String(row.stack_session_key || "").startsWith("web-jimeng:")
          && row.stack_session_key !== sessionKey));
      let changed = false;
      for (const row of movable) {
        if (!row.stack_id) continue;
        deleteMembership.run(projectId, row.id, row.stack_id);
        emptiedStacks.add(`${projectId}\u0000${row.stack_id}`);
        changed = true;
      }
      if (movable.length) {
        const title = group.map((row) => generationSessionTitle({ source: parseJson(row.source_json, {}) })).find(Boolean) || "";
        const existing = autoStackForSession.get(projectId, sessionKey);
        const stackId = existing
          ? appendSessionAssetsToStack(database, projectId, existing.id, sessionKey, movable, title, { timestamp })
          : createAutoSessionStack(database, projectId, sessionKey, movable, title, { timestamp });
        changed = changed || Boolean(stackId);
      }
      if (changed) touchedProjects.add(projectId);
    }
    group = [];
  };
  for (const row of rows) {
    const key = `${row.project_id}\u0000${row.session_key}`;
    if (key !== currentKey) {
      flushGroup();
      currentKey = key;
    }
    group.push(row);
  }
  flushGroup();
  for (const stackKey of emptiedStacks) {
    const separator = stackKey.indexOf("\u0000");
    compactAssetStack(database, stackKey.slice(0, separator), stackKey.slice(separator + 1));
  }
  if (touchedProjects.size) {
    const parked = parseJson(
      database.prepare("SELECT value FROM library_meta WHERE key = ?").get(AUTO_STACK_BACKFILL_NOTIFY_KEY)?.value || "[]",
      [],
    );
    const merged = [...new Set([...(Array.isArray(parked) ? parked : []), ...touchedProjects])];
    database.prepare(`
      INSERT INTO library_meta (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(AUTO_STACK_BACKFILL_NOTIFY_KEY, JSON.stringify(merged), timestamp);
  }
}

function appendFilterConditions(conditions, params, filters, alias = "a") {
  const column = (name) => `${alias}.${name}`;
  if (Number.isFinite(filters.createdAfterMs)) {
    conditions.push(`${column("created_at_epoch")} >= @createdAfterMs`);
    params.createdAfterMs = filters.createdAfterMs;
  }
  if (Number.isFinite(filters.createdBeforeMs)) {
    conditions.push(`${column("created_at_epoch")} <= @createdBeforeMs`);
    params.createdBeforeMs = filters.createdBeforeMs;
  }
  if (filters.source) {
    conditions.push(`${column("source_group")} = @source`);
    params.source = filters.source;
  }
  if (filters.group) {
    conditions.push(`${column("group_name")} = @group`);
    params.group = filters.group;
  }
  if (filters.conversation) {
    conditions.push(`${column("conversation_id")} = @conversation`);
    params.conversation = filters.conversation;
  }
  if (filters.generationBatch) {
    conditions.push(`${column("generation_batch")} = @generationBatch`);
    params.generationBatch = filters.generationBatch;
  }
  if (filters.category) {
    conditions.push(`${column("category")} = @category`);
    params.category = filters.category;
  }
  if (filters.style) {
    conditions.push(`${column("style")} = @style`);
    params.style = filters.style;
  }
  if (filters.favorite) conditions.push(`(${column("rating")} > 0 OR ${column("favorite")} = 1)`);
  if (filters.unorganized) {
    conditions.push(`COALESCE(TRIM(${column("group_name")}), '') = ''`);
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM asset_stack_members unorganized_stack
      WHERE unorganized_stack.project_id = ${column("project_id")}
        AND unorganized_stack.asset_id = ${column("id")}
    )`);
  }
  if (filters.mediaKind === "img") conditions.push(`${column("media_kind")} = 'image'`);
  if (filters.mediaKind === "video") conditions.push(`${column("media_kind")} = 'video'`);
  if (filters.recent) {
    conditions.push(`${column("created_at_epoch")} >= @recentSince`);
    params.recentSince = Number.isFinite(filters.recentSince) ? filters.recentSince : recentCutoffTimestamp();
  }
}

function appendSearchConditions(conditions, params, query, { alias = "a", prefix = "search" } = {}) {
  const normalized = normalizeAssetSearchQuery(query);
  const terms = normalized.split(/\s+/u).filter(Boolean);
  if (!terms.length) return { terms, searchKind: "", scoreSql: "1" };
  const searchKind = assetSearchKind(normalized);
  // Whole-string exact match (see listAssetPage): one id/file-name-shaped term
  // OR-ed into the FTS and LIKE arms, so a pasted full id / file name still
  // finds the asset when its machine-generated segments stay out of the
  // indexes.
  const exactCondition = !searchKind && terms.length === 1
    && /^[a-z0-9][a-z0-9._-]*$/i.test(terms[0])
    ? `mosa_asset_exact_match(${alias}.id, ${alias}.asset, @${prefix}ExactTerm) = 1`
    : "";
  if (exactCondition) params[`${prefix}ExactTerm`] = normalized;
  const ftsTerms = terms.filter((term) => [...term].length >= 3);
  const shortTerms = terms.filter((term) => [...term].length < 3);
  const indexedShortTerms = shortTerms.filter(isIndexedShortUnicodeTerm);
  indexedShortTerms.forEach((term, index) => {
    const key = `${prefix}Short${index}`;
    params[key] = term;
    conditions.push(`${alias}.id IN (
      SELECT asset_id FROM asset_short_terms
      WHERE project_id = @projectId AND term = @${key}
    )`);
  });
  if (ftsTerms.length) {
    const key = `${prefix}FtsQuery`;
    params[key] = buildFtsQuery(ftsTerms.join(" "));
    const membership = `${alias}.id IN (SELECT asset_id FROM asset_fts WHERE project_id = @projectId AND content MATCH @${key})`;
    conditions.push(exactCondition ? `(${membership} OR ${exactCondition})` : membership);
  }
  const likeTerms = (ftsTerms.length ? shortTerms : terms).filter((term) => !indexedShortTerms.includes(term));
  likeTerms.forEach((term, index) => {
    const key = `${prefix}Like${index}`;
    const like = `LOWER(${alias}.search_text) LIKE @${key} ESCAPE '\\'`;
    conditions.push(exactCondition ? `(${like} OR ${exactCondition})` : like);
    params[key] = `%${escapeLikePattern(term)}%`;
  });
  if (searchKind) {
    const key = `${prefix}SearchKind`;
    params[key] = searchKind;
    conditions.push(`mosa_asset_matches_search_kind(
      @${key}, ${alias}.asset, ${alias}.id, ${alias}.prompt, ${alias}.skill, ${alias}.style, ${alias}.theme,
      ${alias}.group_name, ${alias}.category, ${alias}.tags_text
    ) = 1`);
  }
  return { terms, searchKind, scoreSql: searchKind ? buildSearchScoreSql(terms, params, alias) : "1" };
}

function listCollapsedAssetPage(database, { filters, projectId, limit, sort, searchQuery, cursor }) {
  const hasCollapsedFacet = Boolean(
    filters.source || filters.group || filters.conversation || filters.generationBatch
    || filters.category || filters.style || filters.favorite || filters.unorganized
    || filters.mediaKind || filters.recent || (Array.isArray(filters.assetIds) && filters.assetIds.length)
    || Number.isFinite(filters.createdAfterMs) || Number.isFinite(filters.createdBeforeMs),
  );
  if (!searchQuery && !hasCollapsedFacet) {
    return listCollapsedAssetPageFast(database, { filters, projectId, limit, sort, cursor });
  }
  const params = { projectId };
  const memberConditions = ["m.project_id = @projectId", "m.archived = 0", "m.deleted_at IS NULL"];
  // Incremental reconciliation: evaluate every member of the nodes reachable
  // from the affected asset ids, so the node set is bounded by the affected
  // ids while `_matched_member_count` still counts ALL matching members of
  // each node (a direct id filter would corrupt that count).
  if (Array.isArray(filters.assetIds) && filters.assetIds.length) {
    params.reconcileAssetIds = JSON.stringify([...new Set(filters.assetIds.map((assetId) => sanitizeId(assetId, "asset")))]);
    memberConditions.push(`(
      m.id IN (SELECT CAST(value AS TEXT) FROM json_each(@reconcileAssetIds))
      OR sm.stack_id IN (
        SELECT sm2.stack_id FROM asset_stack_members sm2
        WHERE sm2.project_id = @projectId
          AND sm2.asset_id IN (SELECT CAST(value AS TEXT) FROM json_each(@reconcileAssetIds))
      )
    )`);
  }
  appendFilterConditions(memberConditions, params, filters, "m");
  // Search normally evaluates member assets. A custom Stack name is a first-
  // class gallery label, though, so the collapsed root must also be discoverable
  // by that name even when no member metadata contains the query. Keep the
  // ordinary facets on members (source/group/favorite/etc.) and OR only the
  // textual search predicate with the Stack-name predicate so a name match
  // cannot bypass the active gallery filters.
  const memberSearchConditions = [];
  const search = appendSearchConditions(memberSearchConditions, params, searchQuery, { alias: "m", prefix: "node" });
  if (search.terms.length) {
    const stackNameConditions = search.terms.map((term, index) => {
      const key = `nodeStackNameLike${index}`;
      params[key] = `%${escapeLikePattern(term)}%`;
      return `LOWER(COALESCE(stack_meta.name, '')) LIKE @${key} ESCAPE '\\'`;
    });
    memberConditions.push(`((${memberSearchConditions.join(" AND ")}) OR (${stackNameConditions.join(" AND ")}))`);
  }

  const matchedCte = `matched AS MATERIALIZED (
    SELECT
      COALESCE(sm.stack_id, 'asset:' || m.id) AS node_key,
      COALESCE(cover.asset_id, m.id) AS node_asset_id,
      sm.stack_id AS stack_id,
      COUNT(*) AS _matched_member_count,
      MAX(${search.scoreSql}) AS _search_score
    FROM assets m
    LEFT JOIN asset_stack_members sm
      ON sm.project_id = m.project_id AND sm.asset_id = m.id
    LEFT JOIN asset_stacks stack_meta
      ON stack_meta.project_id = sm.project_id AND stack_meta.id = sm.stack_id
    LEFT JOIN asset_stack_members cover
      ON cover.project_id = sm.project_id AND cover.stack_id = sm.stack_id
      AND cover.position = (
        SELECT MIN(sm3.position)
        FROM asset_stack_members sm3
        JOIN assets a3 ON a3.project_id = sm3.project_id AND a3.id = sm3.asset_id
        WHERE sm3.project_id = sm.project_id AND sm3.stack_id = sm.stack_id
          AND a3.archived = 0 AND a3.deleted_at IS NULL
      )
    WHERE ${memberConditions.join(" AND ")}
    GROUP BY node_key, node_asset_id, sm.stack_id
  )`;

  const rowsCte = `node_rows AS MATERIALIZED (
    SELECT ${PAGE_ASSET_COLUMNS}, matched._search_score, matched._matched_member_count,
      COALESCE(NULLIF(s.sort_created_at, ''), a.created_at) AS _node_created_at,
      COALESCE(NULLIF(s.sort_name, ''), a.sort_name) AS _node_sort_name
    FROM matched
    JOIN assets a ON a.project_id = @projectId AND a.id = matched.node_asset_id
    LEFT JOIN asset_stacks s ON s.project_id = @projectId AND s.id = matched.stack_id
  )`;

  const pageConditions = [];
  if (cursor) {
    params.cursorId = cursor.id;
    params.cursorCreatedAt = cursor.createdAt;
    params.cursorSortName = cursor.sortName;
    const secondary = sort === "name"
      ? "(r._node_sort_name > @cursorSortName OR (r._node_sort_name = @cursorSortName AND r.id > @cursorId))"
      : sort === "oldest"
        ? "(r._node_created_at > @cursorCreatedAt OR (r._node_created_at = @cursorCreatedAt AND r.id > @cursorId))"
        : "(r._node_created_at < @cursorCreatedAt OR (r._node_created_at = @cursorCreatedAt AND r.id < @cursorId))";
    if (search.searchKind) {
      params.cursorSearchScore = cursor.searchScore;
      pageConditions.push(`(r._search_score < @cursorSearchScore OR (r._search_score = @cursorSearchScore AND ${secondary}))`);
    } else {
      pageConditions.push(secondary);
    }
  }

  const orderBy = search.searchKind
    ? `r._search_score DESC, ${sort === "name"
      ? "r._node_sort_name ASC, r.id ASC"
      : sort === "oldest"
        ? "r._node_created_at ASC, r.id ASC"
        : "r._node_created_at DESC, r.id DESC"}`
    : sort === "name"
      ? "r._node_sort_name ASC, r.id ASC"
      : sort === "oldest"
        ? "r._node_created_at ASC, r.id ASC"
        : "r._node_created_at DESC, r.id DESC";
  const where = pageConditions.length ? `WHERE ${pageConditions.join(" AND ")}` : "";
  const sql = `WITH ${matchedCte}, ${rowsCte}
    SELECT r.* FROM node_rows r ${where}
    ORDER BY ${orderBy}`;
  const rows = limit > 0
    ? database.prepare(`${sql} LIMIT @limit`).all({ ...params, limit: limit + 1 })
    : database.prepare(sql).all(params);
  const hasMore = limit > 0 && rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const assets = attachAssetTags(
    database,
    projectId,
    annotateAssetStackCovers(
      database,
      pageRows.map((row) => rowToAsset(database, row, { includeRelations: false })),
      projectId,
    ),
  );
  annotateGalleryNodeSort(assets, pageRows, { collapsed: true, ranked: Boolean(search.searchKind) });
  assets.forEach((asset, index) => {
    if (!asset.stack) return;
    const matchedCount = Number(pageRows[index]?._matched_member_count || 0);
    if (matchedCount > 0 && matchedCount < asset.stack.count) asset.stack.match_count = matchedCount;
  });
  const total = filters.includeTotal === false
    ? null
    : Number(database.prepare(`WITH ${matchedCte} SELECT COUNT(*) AS count FROM matched`).get(params).count || 0);
  const last = pageRows.at(-1);
  return {
    assets,
    page: {
      total,
      nextCursor: hasMore && last ? encodeCursor(last, sort, searchQuery, assetTimeFilterKey(filters)) : null,
      limit: limit || total || pageRows.length,
      sort,
    },
  };
}

function listCollapsedAssetPageFast(database, { filters, projectId, limit, sort, cursor }) {
  if (limit > 0) {
    return listCollapsedAssetPageFastBounded(database, { filters, projectId, limit, sort, cursor });
  }
  const params = { projectId };
  const pageConditions = [];
  if (cursor) {
    params.cursorId = cursor.id;
    params.cursorCreatedAt = cursor.createdAt;
    params.cursorSortName = cursor.sortName;
    if (sort === "name") {
      pageConditions.push("(r._node_sort_name > @cursorSortName OR (r._node_sort_name = @cursorSortName AND r.id > @cursorId))");
    } else if (sort === "oldest") {
      pageConditions.push("(r._node_created_at > @cursorCreatedAt OR (r._node_created_at = @cursorCreatedAt AND r.id > @cursorId))");
    } else {
      pageConditions.push("(r._node_created_at < @cursorCreatedAt OR (r._node_created_at = @cursorCreatedAt AND r.id < @cursorId))");
    }
  }
  const orderBy = sort === "name"
    ? "r._node_sort_name ASC, r.id ASC"
    : sort === "oldest"
      ? "r._node_created_at ASC, r.id ASC"
      : "r._node_created_at DESC, r.id DESC";
  const where = pageConditions.length ? `WHERE ${pageConditions.join(" AND ")}` : "";
  const nodeCtes = `
    active_stack_stats AS MATERIALIZED (
      SELECT sm.stack_id,
        COUNT(*) AS _matched_member_count,
        MIN(sm.position) AS first_position
      FROM asset_stack_members sm
      JOIN assets member ON member.project_id = sm.project_id AND member.id = sm.asset_id
      WHERE sm.project_id = @projectId AND member.archived = 0 AND member.deleted_at IS NULL
      GROUP BY sm.stack_id
    ),
    node_rows AS MATERIALIZED (
      SELECT ${PAGE_ASSET_COLUMNS}, 0 AS _search_score, stats._matched_member_count,
        COALESCE(NULLIF(s.sort_created_at, ''), a.created_at) AS _node_created_at,
        COALESCE(NULLIF(s.sort_name, ''), a.sort_name) AS _node_sort_name
      FROM active_stack_stats stats
      JOIN asset_stack_members cover
        ON cover.project_id = @projectId AND cover.stack_id = stats.stack_id AND cover.position = stats.first_position
      JOIN assets a ON a.project_id = @projectId AND a.id = cover.asset_id
      JOIN asset_stacks s ON s.project_id = @projectId AND s.id = stats.stack_id
      UNION ALL
      SELECT ${PAGE_ASSET_COLUMNS}, 0 AS _search_score, 1 AS _matched_member_count,
        a.created_at AS _node_created_at,
        a.sort_name AS _node_sort_name
      FROM assets a
      LEFT JOIN asset_stack_members sm
        ON sm.project_id = a.project_id AND sm.asset_id = a.id
      WHERE a.project_id = @projectId AND a.archived = 0 AND a.deleted_at IS NULL AND sm.asset_id IS NULL
    )`;
  const sql = `WITH ${nodeCtes}
    SELECT r.* FROM node_rows r ${where}
    ORDER BY ${orderBy}`;
  const rows = limit > 0
    ? database.prepare(`${sql} LIMIT @limit`).all({ ...params, limit: limit + 1 })
    : database.prepare(sql).all(params);
  const hasMore = limit > 0 && rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const assets = attachAssetTags(
    database,
    projectId,
    annotateAssetStackCovers(
      database,
      pageRows.map((row) => rowToAsset(database, row, { includeRelations: false })),
      projectId,
    ),
  );
  annotateGalleryNodeSort(assets, pageRows, { collapsed: true, ranked: false });
  const total = filters.includeTotal === false
    ? null
    : Number(database.prepare(`
      SELECT
        (SELECT COUNT(*)
         FROM assets a
         LEFT JOIN asset_stack_members sm ON sm.project_id = a.project_id AND sm.asset_id = a.id
         WHERE a.project_id = @projectId AND a.archived = 0 AND a.deleted_at IS NULL AND sm.asset_id IS NULL)
        +
        (SELECT COUNT(DISTINCT sm.stack_id)
         FROM asset_stack_members sm
         JOIN assets member ON member.project_id = sm.project_id AND member.id = sm.asset_id
         WHERE sm.project_id = @projectId AND member.archived = 0 AND member.deleted_at IS NULL)
        AS count
    `).get(params).count || 0);
  const last = pageRows.at(-1);
  return {
    assets,
    page: {
      total,
      nextCursor: hasMore && last ? encodeCursor(last, sort, "", assetTimeFilterKey(filters)) : null,
      limit: limit || total || pageRows.length,
      sort,
    },
  };
}

function listCollapsedAssetPageFastBounded(database, { filters, projectId, limit, sort, cursor }) {
  const params = {
    projectId,
    candidateLimit: limit + 1,
    resultLimit: limit + 1,
  };
  const stackConditions = [];
  const assetConditions = [];
  if (cursor) {
    params.cursorId = cursor.id;
    params.cursorCreatedAt = cursor.createdAt;
    params.cursorSortName = cursor.sortName;
    if (sort === "name") {
      stackConditions.push("(s._node_sort_name > @cursorSortName OR (s._node_sort_name = @cursorSortName AND s.node_asset_id > @cursorId))");
      assetConditions.push("(a.sort_name > @cursorSortName OR (a.sort_name = @cursorSortName AND a.id > @cursorId))");
    } else if (sort === "oldest") {
      stackConditions.push("(s._node_created_at > @cursorCreatedAt OR (s._node_created_at = @cursorCreatedAt AND s.node_asset_id > @cursorId))");
      assetConditions.push("(a.created_at > @cursorCreatedAt OR (a.created_at = @cursorCreatedAt AND a.id > @cursorId))");
    } else {
      stackConditions.push("(s._node_created_at < @cursorCreatedAt OR (s._node_created_at = @cursorCreatedAt AND s.node_asset_id < @cursorId))");
      assetConditions.push("(a.created_at < @cursorCreatedAt OR (a.created_at = @cursorCreatedAt AND a.id < @cursorId))");
    }
  }

  const nodeOrder = sort === "name"
    ? "_node_sort_name ASC, node_asset_id ASC"
    : sort === "oldest"
      ? "_node_created_at ASC, node_asset_id ASC"
      : "_node_created_at DESC, node_asset_id DESC";
  const finalOrder = sort === "name"
    ? "r._node_sort_name ASC, r.id ASC"
    : sort === "oldest"
      ? "r._node_created_at ASC, r.id ASC"
      : "r._node_created_at DESC, r.id DESC";
  const assetIndex = sort === "name" ? "assets_project_name_idx" : "assets_project_created_idx";
  const assetOrder = sort === "name"
    ? "a.sort_name ASC, a.id ASC"
    : sort === "oldest"
      ? "a.created_at ASC, a.id ASC"
      : "a.created_at DESC, a.id DESC";
  const stackWhere = stackConditions.length ? `WHERE ${stackConditions.join(" AND ")}` : "";
  const assetCursor = assetConditions.length ? `AND ${assetConditions.join(" AND ")}` : "";

  const rows = database.prepare(`
    WITH active_stack_stats AS MATERIALIZED (
      SELECT sm.stack_id,
        COUNT(*) AS _matched_member_count,
        MIN(sm.position) AS first_position
      FROM asset_stack_members sm
      JOIN assets member ON member.project_id = sm.project_id AND member.id = sm.asset_id
      WHERE sm.project_id = @projectId
        AND member.archived = 0
        AND member.deleted_at IS NULL
      GROUP BY sm.stack_id
    ),
    stack_nodes AS MATERIALIZED (
      SELECT cover.asset_id AS node_asset_id,
        stats._matched_member_count,
        COALESCE(NULLIF(stack.sort_created_at, ''), stack.created_at) AS _node_created_at,
        COALESCE(NULLIF(stack.sort_name, ''), cover_asset.sort_name) AS _node_sort_name
      FROM active_stack_stats stats
      JOIN asset_stack_members cover
        ON cover.project_id = @projectId
        AND cover.stack_id = stats.stack_id
        AND cover.position = stats.first_position
      JOIN assets cover_asset
        ON cover_asset.project_id = @projectId
        AND cover_asset.id = cover.asset_id
      JOIN asset_stacks stack
        ON stack.project_id = @projectId
        AND stack.id = stats.stack_id
    ),
    stack_page AS MATERIALIZED (
      SELECT s.*
      FROM stack_nodes s
      ${stackWhere}
      ORDER BY ${nodeOrder}
      LIMIT @candidateLimit
    ),
    asset_page AS MATERIALIZED (
      SELECT a.id AS node_asset_id,
        1 AS _matched_member_count,
        a.created_at AS _node_created_at,
        a.sort_name AS _node_sort_name
      FROM assets a INDEXED BY ${assetIndex}
      WHERE a.project_id = @projectId
        AND a.archived = 0
        AND a.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM asset_stack_members sm
          WHERE sm.project_id = a.project_id
            AND sm.asset_id = a.id
        )
        ${assetCursor}
      ORDER BY ${assetOrder}
      LIMIT @candidateLimit
    ),
    candidate_nodes AS MATERIALIZED (
      SELECT * FROM stack_page
      UNION ALL
      SELECT * FROM asset_page
    ),
    node_rows AS MATERIALIZED (
      SELECT ${PAGE_ASSET_COLUMNS},
        0 AS _search_score,
        candidates._matched_member_count,
        candidates._node_created_at,
        candidates._node_sort_name
      FROM candidate_nodes candidates
      JOIN assets a
        ON a.project_id = @projectId
        AND a.id = candidates.node_asset_id
    )
    SELECT r.*
    FROM node_rows r
    ORDER BY ${finalOrder}
    LIMIT @resultLimit
  `).all(params);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const assets = attachAssetTags(
    database,
    projectId,
    annotateAssetStackCovers(
      database,
      pageRows.map((row) => rowToAsset(database, row, { includeRelations: false })),
      projectId,
    ),
  );
  annotateGalleryNodeSort(assets, pageRows, { collapsed: true, ranked: false });
  const total = filters.includeTotal === false
    ? null
    : Number(database.prepare(`
      SELECT
        (SELECT COUNT(*)
         FROM assets a
         WHERE a.project_id = @projectId
           AND a.archived = 0
           AND a.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1
             FROM asset_stack_members sm
             WHERE sm.project_id = a.project_id
               AND sm.asset_id = a.id
           ))
        +
        (SELECT COUNT(*)
         FROM asset_stacks stack
         WHERE stack.project_id = @projectId
           AND EXISTS (
             SELECT 1
             FROM asset_stack_members sm
             JOIN assets member
               ON member.project_id = sm.project_id
               AND member.id = sm.asset_id
             WHERE sm.project_id = stack.project_id
               AND sm.stack_id = stack.id
               AND member.archived = 0
               AND member.deleted_at IS NULL
           ))
        AS count
    `).get(params).count || 0);
  const last = pageRows.at(-1);
  return {
    assets,
    page: {
      total,
      nextCursor: hasMore && last ? encodeCursor(last, sort, "", assetTimeFilterKey(filters)) : null,
      limit,
      sort,
    },
  };
}

const ALLOWED_GROUP_COLUMNS = new Set(["category", "style", "group_name"]);
const DERIVATIVE_COLUMNS = new Map([
  ["preview", "preview_path"],
  ["medium", "medium_path"],
  ["thumbnail", "thumbnail_path"],
]);

function countNamedValues(database, projectId, column, limit = 0) {
  if (!ALLOWED_GROUP_COLUMNS.has(column)) throw new Error(`Unsafe column name: ${column}`);
  const rows = database.prepare(`
    SELECT ${column} AS name, COUNT(*) AS count FROM assets
    WHERE project_id = ? AND archived = 0 AND deleted_at IS NULL AND ${column} != ''
    GROUP BY ${column} ORDER BY count DESC, name COLLATE NOCASE${limit ? " LIMIT ?" : ""}
  `).all(...(limit ? [projectId, limit] : [projectId]));
  return rows.map((row) => [row.name, row.count]);
}

// updateMetadata merges business_fields key-by-key, like source: a plain
// object patch carries only the keys it names (a null value deletes its key),
// so a partial write — PATCH body, MCP tool, bridge caller — can never drop
// recorded dimensions it did not mention. Anything else (absent, null, array,
// string) leaves the stored object untouched; there is no whole-column clear.
function mergeBusinessFieldsPatch(current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return current;
  const merged = { ...(current || {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

// Imports (drag, paste, file picker, folder import) hand the store a bare
// staged path with no business_fields, and videos never reach the derivative
// worker that backfills image dimensions, so width/height/duration_seconds
// must come from the file itself. Only missing keys are filled; whatever the
// caller supplied stays untouched. Unreadable containers (WebM, truncated
// files) return null and change nothing.
async function missingVideoDimensionFields(imagePath, businessFields) {
  if (!VIDEO_EXTENSIONS.has(extname(imagePath).toLowerCase())) return null;
  const fields = parseBusinessFields(businessFields);
  const positive = (key) => Number(fields[key]) > 0;
  if (positive("width") && positive("height") && positive("duration_seconds")) return null;
  const fileMeta = await readVideoMetadataFromFile(imagePath).catch(() => null);
  if (!fileMeta) return null;
  const merged = { ...fields };
  let changed = false;
  if (!positive("width") && fileMeta.width > 0) {
    merged.width = fileMeta.width;
    changed = true;
  }
  if (!positive("height") && fileMeta.height > 0) {
    merged.height = fileMeta.height;
    changed = true;
  }
  if (!positive("duration_seconds") && fileMeta.durationSeconds !== null && fileMeta.durationSeconds > 0) {
    merged.duration_seconds = fileMeta.durationSeconds;
    changed = true;
  }
  return changed ? merged : null;
}

// Manual imports and Cowart captures hand the store no file size, and the
// property panel's size line reads business_fields.file_bytes. Only a missing
// or non-positive key is filled, from the managed file itself via stat;
// whatever the caller supplied (web capture stores file-read sizes) stays
// untouched. A stat failure must never fail the import, so unreadable files
// change nothing.
async function missingFileBytesField(imagePath, businessFields) {
  const fields = parseBusinessFields(businessFields);
  if (Number(fields.file_bytes) > 0) return null;
  const stats = await stat(imagePath).catch(() => null);
  if (!stats || !(stats.size > 0)) return null;
  return { ...fields, file_bytes: stats.size };
}

const FILE_BYTES_BACKFILL_MARKER_KEY = "file_bytes_backfill_v1";

// One-time backfill of file_bytes from the original files: rows stored before
// the createAsset fill (manual imports, Cowart captures) carry no size, so the
// property panel's size line shows "—". Trash rows are included. The SQL
// prefilter keeps an 8000-row library from reading every row into JS — only
// rows without a positive file_bytes reach the stat loop. Key-level merge on
// business_fields_json — only file_bytes is written; created_at, updated_at
// and every other key stay byte-identical. Same best-effort contract as the
// video pass: marker and data share one BEGIN IMMEDIATE transaction, a
// failure rolls both back and the next open retries; the caller's catch never
// writes the marker.
function backfillFileBytesFromFiles(database, helpers = {}) {
  const { commitLibraryChanges } = helpers;
  const stats = { assetsUpdated: 0, filesUnreadable: 0 };
  const markerQuery = database.prepare("SELECT 1 FROM library_meta WHERE key = ?");
  if (markerQuery.get(FILE_BYTES_BACKFILL_MARKER_KEY)) return stats;
  const timestamp = new Date().toISOString();
  const touchedProjectIds = new Set();
  database.transaction(() => {
    const alreadyDone = markerQuery.get(FILE_BYTES_BACKFILL_MARKER_KEY);
    if (alreadyDone) return;
    // CAST("123" AS REAL) = 123 keeps numeric strings out; invalid or
    // non-object JSON and non-numeric values fall through to the JS check.
    const rows = database.prepare(`
      SELECT project_id, id, original_path, business_fields_json FROM assets
      WHERE original_path IS NOT NULL AND original_path != ''
        AND (
          business_fields_json IS NULL OR business_fields_json = ''
          OR NOT json_valid(business_fields_json)
          OR json_extract(business_fields_json, '$.file_bytes') IS NULL
          OR CAST(json_extract(business_fields_json, '$.file_bytes') AS REAL) <= 0
        )
    `).all();
    const update = database.prepare(
      "UPDATE assets SET business_fields_json = ? WHERE project_id = ? AND id = ?",
    );
    for (const row of rows) {
      const parsed = parseJson(row.business_fields_json, null);
      const fields = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      if (Number(fields.file_bytes) > 0) continue;
      if (!row.original_path || !existsSync(row.original_path)) continue;
      let size = 0;
      try {
        size = statSync(row.original_path).size;
      } catch {
        stats.filesUnreadable += 1;
        continue;
      }
      if (!(size > 0)) {
        stats.filesUnreadable += 1;
        continue;
      }
      update.run(JSON.stringify({ ...fields, file_bytes: size }), row.project_id, row.id);
      stats.assetsUpdated += 1;
      touchedProjectIds.add(row.project_id);
    }
    if (stats.assetsUpdated) {
      // One unclassified change per touched project so every open window
      // takes its full-recovery path and re-renders the corrected cards;
      // per-asset events would spam the journal for a one-time sweep.
      commitLibraryChanges?.([...touchedProjectIds].map((projectId) => ({
        projectId,
        kind: "library-backfilled",
        entityType: "asset",
        entityId: "",
        assetIds: [],
        detail: { reason: "file-bytes-backfill-v1", assetsUpdated: stats.assetsUpdated },
      })));
    }
    database.prepare(`
      INSERT INTO library_meta (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(FILE_BYTES_BACKFILL_MARKER_KEY, timestamp, timestamp);
  }).immediate();
  if (stats.assetsUpdated > 0) {
    console.warn(`[MOSA] file_bytes_backfill_v1: filled file size on ${stats.assetsUpdated} asset(s) from their files.`);
  }
  return stats;
}

const VIDEO_METADATA_BACKFILL_MARKER_KEY = "video_metadata_backfill_v1";

// One-time backfill of video width/height/duration_seconds from the original
// files (see video-metadata.ts): captures archived before the store read
// files carry null dimensions or a provider-reported duration that does not
// match the video (Jimeng reported 7 s for 6.08 s files), and imports from
// before the per-file read carry no dimensions at all. Trash rows are
// included; images are untouched. Key-level merge on business_fields_json —
// only the three keys named here are written; created_at, updated_at, recipe
// snapshots, stacking and grouping stay byte-identical. Same best-effort
// contract as the other one-time passes: marker and data share one BEGIN
// IMMEDIATE transaction, a failure rolls both back and the next open
// retries; the caller's catch never writes the marker.
function backfillVideoMetadataFromFiles(database, helpers = {}) {
  const { commitLibraryChanges } = helpers;
  const stats = { assetsUpdated: 0, filesUnreadable: 0 };
  const markerQuery = database.prepare("SELECT 1 FROM library_meta WHERE key = ?");
  if (markerQuery.get(VIDEO_METADATA_BACKFILL_MARKER_KEY)) return stats;
  const timestamp = new Date().toISOString();
  const touchedProjectIds = new Set();
  database.transaction(() => {
    const alreadyDone = markerQuery.get(VIDEO_METADATA_BACKFILL_MARKER_KEY);
    if (alreadyDone) return;
    const rows = database.prepare(
      "SELECT project_id, id, original_path, business_fields_json FROM assets WHERE media_kind = 'video'",
    ).all();
    const update = database.prepare(
      "UPDATE assets SET business_fields_json = ? WHERE project_id = ? AND id = ?",
    );
    for (const row of rows) {
      if (!row.original_path || !existsSync(row.original_path)) continue;
      const fileMeta = readVideoMetadataFromFileSync(row.original_path);
      if (!fileMeta) {
        stats.filesUnreadable += 1;
        console.warn(`[MOSA] video_metadata_backfill_v1: unreadable video file skipped: ${basename(String(row.original_path))}`);
        continue;
      }
      const parsed = parseJson(row.business_fields_json, null);
      const fields = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      const merged = { ...fields };
      let changed = false;
      if (!(Number(fields.width) > 0) && fileMeta.width > 0) {
        merged.width = fileMeta.width;
        changed = true;
      }
      if (!(Number(fields.height) > 0) && fileMeta.height > 0) {
        merged.height = fileMeta.height;
        changed = true;
      }
      const storedDuration = Number(fields.duration_seconds);
      const fileDuration = fileMeta.durationSeconds;
      const durationMissing = !(storedDuration > 0);
      const durationOff = fileDuration !== null && storedDuration > 0 && Math.abs(storedDuration - fileDuration) > 0.5;
      if (fileDuration !== null && fileDuration > 0 && (durationMissing || durationOff)) {
        merged.duration_seconds = fileDuration;
        changed = true;
      }
      if (!changed) continue;
      update.run(JSON.stringify(merged), row.project_id, row.id);
      stats.assetsUpdated += 1;
      touchedProjectIds.add(row.project_id);
    }
    if (stats.assetsUpdated) {
      // One unclassified change per touched project so every open window
      // takes its full-recovery path and re-renders the corrected cards;
      // per-asset events would spam the journal for a one-time sweep.
      commitLibraryChanges?.([...touchedProjectIds].map((projectId) => ({
        projectId,
        kind: "library-backfilled",
        entityType: "asset",
        entityId: "",
        assetIds: [],
        detail: { reason: "video-metadata-backfill-v1", assetsUpdated: stats.assetsUpdated },
      })));
    }
    database.prepare(`
      INSERT INTO library_meta (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(VIDEO_METADATA_BACKFILL_MARKER_KEY, timestamp, timestamp);
  }).immediate();
  if (stats.assetsUpdated > 0) {
    console.warn(`[MOSA] video_metadata_backfill_v1: filled width/height/duration on ${stats.assetsUpdated} video asset(s) from their files.`);
  }
  return stats;
}

function normalizeAssetMetadata(input) {
  const businessFields = parseBusinessFields(input.business_fields);
  return {
    ...Object.fromEntries(Object.entries(input).filter(([key]) => !NORMALIZED_METADATA_KEYS.has(key))),
    id: sanitizeId(input.id, "asset"),
    project_id: sanitizeProjectId(input.project_id || input.projectId || DEFAULT_PROJECT_ID),
    asset: sanitizeFileName(input.asset),
    image_path: resolve(input.image_path),
    prompt_path: input.prompt_path || null,
    prompt: String(input.prompt || ""),
    user_prompt: String(input.user_prompt || ""),
    negative_prompt: String(input.negative_prompt || ""),
    references: Array.isArray(input.references) ? input.references : [],
    skill: String(input.skill || ""),
    style: String(input.style || ""),
    ratio: String(input.ratio || ""),
    business_fields: businessFields,
    theme: String(input.theme || ""),
    tags: uniqueArray(input.tags || []),
    favorite: Boolean(input.favorite),
    archived: Boolean(input.archived),
    group: normalizeGroupName(input.group),
    category: String(input.category || ""),
    rating: Number.isFinite(input.rating) ? Math.min(5, Math.max(0, Math.round(input.rating))) : 0,
    parent_asset_id: normalizeParentAssetId(input.parent_asset_id ?? input.parentAssetId),
    version_change: String(input.version_change || input.changeSummary || ""),
    child_asset_ids: uniqueArray(input.child_asset_ids || []),
    created_at: normalizeCreatedAt(input.created_at, now()),
    updated_at: input.updated_at || now(),
    source: input.source && typeof input.source === "object" ? input.source : {},
  };
}

function unknownFields(metadata) {
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !NORMALIZED_METADATA_KEYS.has(key)));
}

function searchableText(metadata) {
  return [
    searchableAssetName(metadata.id), searchableAssetName(metadata.asset), metadata.prompt, metadata.skill, metadata.style, metadata.theme, metadata.group, metadata.category,
    metadata.curation_note, ...(metadata.tags || []),
    ...searchableSourceValues(metadata.source, canonicalSourceTypeOf(metadata)),
    ...searchableBusinessFieldValues(metadata.business_fields),
  ].map((value) => typeof value === "string" || typeof value === "number" ? String(value) : "").join(" ");
}

function buildSearchScoreSql(terms, params, alias = "a") {
  const lower = (column) => `lower(COALESCE(${column}, ''))`;
  const column = (name) => `${alias}.${name}`;
  const tagExact = (key) => `instr(char(31) || ${lower(column("tags_text"))} || char(31), char(31) || @${key} || char(31)) > 0`;
  const contains = (column, key) => `instr(${lower(column)}, @${key}) > 0`;
  // Contains terms on the id / file name run against the searchable name (the
  // machine-generated segments stripped); the exact comparisons below stay on
  // the raw columns.
  const containsSearchableName = (name, key) => `instr(lower(COALESCE(mosa_searchable_asset_name(${column(name)}), '')), @${key}) > 0`;
  const promptOccurrences = (key) => `(
    (length(${lower(column("prompt"))}) - length(replace(${lower(column("prompt"))}, @${key}, ''))) / length(@${key})
  )`;
  const promptScore = (key) => `(
    ${ASSET_SEARCH_WEIGHTS.promptContains}
    + min(${ASSET_SEARCH_WEIGHTS.promptFrequencyCap}, max(0, (${promptOccurrences(key)} - 1) * ${ASSET_SEARCH_WEIGHTS.promptFrequencyStep}))
    + CASE WHEN ltrim(${lower(column("prompt"))}) LIKE @${key} || '%' THEN ${ASSET_SEARCH_WEIGHTS.promptPrefixBonus} ELSE 0 END
  )`;
  const bestTermScore = (key) => `CASE
    WHEN ${lower(column("asset"))} = @${key} THEN ${ASSET_SEARCH_WEIGHTS.assetExact}
    WHEN ${lower(column("id"))} = @${key} THEN ${ASSET_SEARCH_WEIGHTS.idExact}
    WHEN ${tagExact(key)} THEN ${ASSET_SEARCH_WEIGHTS.tagExact}
    WHEN ${lower(column("category"))} = @${key} THEN ${ASSET_SEARCH_WEIGHTS.categoryExact}
    WHEN ${lower(column("group_name"))} = @${key} THEN ${ASSET_SEARCH_WEIGHTS.groupExact}
    WHEN ${containsSearchableName("asset", key)} THEN ${ASSET_SEARCH_WEIGHTS.assetContains}
    WHEN ${containsSearchableName("id", key)} THEN ${ASSET_SEARCH_WEIGHTS.idContains}
    WHEN ${contains(column("tags_text"), key)} THEN ${ASSET_SEARCH_WEIGHTS.tagContains}
    WHEN ${contains(column("category"), key)} THEN ${ASSET_SEARCH_WEIGHTS.categoryContains}
    WHEN ${contains(column("group_name"), key)} THEN ${ASSET_SEARCH_WEIGHTS.groupContains}
    WHEN ${lower(column("style"))} = @${key} THEN ${ASSET_SEARCH_WEIGHTS.styleExact}
    WHEN ${lower(column("theme"))} = @${key} THEN ${ASSET_SEARCH_WEIGHTS.themeExact}
    WHEN ${lower(column("skill"))} = @${key} THEN ${ASSET_SEARCH_WEIGHTS.skillExact}
    WHEN ${contains(column("style"), key)} THEN ${ASSET_SEARCH_WEIGHTS.styleContains}
    WHEN ${contains(column("theme"), key)} THEN ${ASSET_SEARCH_WEIGHTS.themeContains}
    WHEN ${contains(column("skill"), key)} THEN ${ASSET_SEARCH_WEIGHTS.skillContains}
    WHEN ${lower(column("prompt"))} = @${key} THEN ${ASSET_SEARCH_WEIGHTS.promptExact}
    WHEN ${contains(column("prompt"), key)} THEN ${promptScore(key)}
    WHEN ${contains(column("business_search_text"), key)} THEN ${ASSET_SEARCH_WEIGHTS.businessContains}
    WHEN ${contains(column("source_search_text"), key)} THEN ${ASSET_SEARCH_WEIGHTS.sourceContains}
    ELSE 0
  END`;
  const termScores = terms.map((term, index) => {
    const key = `searchTerm${index}`;
    params[key] = term;
    return bestTermScore(key);
  });
  // Candidate generation already applies AND semantics to every term against
  // search_text/FTS. search_text is assembled from the exact same fields scored
  // below, so re-evaluating every CASE once for "is non-zero" and again for its
  // value only doubles CPU without filtering any additional rows.
  const termScoreSum = termScores.map((score) => `(${score})`).join(" + ");

  const phrase = terms.join(" ");
  params.searchPhrase = phrase;
  const phraseBonus = `CASE
    WHEN instr(lower(COALESCE(mosa_searchable_asset_name(${column("asset")}), '')), @searchPhrase) > 0 THEN ${ASSET_SEARCH_WEIGHTS.phraseAssetBonus}
    WHEN instr(${lower(column("tags_text"))}, @searchPhrase) > 0 THEN ${ASSET_SEARCH_WEIGHTS.phraseTagBonus}
    WHEN instr(${lower(column("category"))}, @searchPhrase) > 0 THEN ${ASSET_SEARCH_WEIGHTS.phraseCategoryBonus}
    WHEN instr(${lower(column("group_name"))}, @searchPhrase) > 0 THEN ${ASSET_SEARCH_WEIGHTS.phraseGroupBonus}
    WHEN instr(${lower(column("prompt"))}, @searchPhrase) > 0 THEN ${ASSET_SEARCH_WEIGHTS.phrasePromptBonus}
    ELSE 0
  END`;
  return `((${termScoreSum}) + (${phraseBonus}))`;
}

function escapeLikePattern(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function isIndexedShortUnicodeTerm(term) {
  const chars = [...String(term || "")];
  return chars.length > 0 && chars.length < 3 && chars.some((char) => char.codePointAt(0) > 0x7f);
}

function shortUnicodeSearchTerms(value) {
  const normalized = normalizeAssetSearchQuery(value);
  if (!normalized) return [];
  const result = new Set();
  for (const token of normalized.split(/\s+/u).filter(Boolean)) {
    const chars = [...token];
    for (let index = 0; index < chars.length; index += 1) {
      const single = chars[index];
      if (isIndexedShortUnicodeTerm(single)) result.add(single);
      if (index + 1 < chars.length) {
        const pair = `${chars[index]}${chars[index + 1]}`;
        if (isIndexedShortUnicodeTerm(pair)) result.add(pair);
      }
    }
  }
  return [...result];
}

// Single authority for asset_fts writes. A trashed asset (deleted_at set) must
// never hold an FTS row: page queries filter `deleted_at IS NULL`, but the fast
// FTS count does not join assets, so a re-indexed trashed asset would inflate
// search totals. Every writer goes through here so "deleted_at set → delete
// only" stays the invariant instead of being re-derived at each call site.
function syncAssetFtsEntry(database, projectId, assetId, searchText, deletedAt) {
  database.prepare("DELETE FROM asset_fts WHERE project_id = ? AND asset_id = ?").run(projectId, assetId);
  if (deletedAt) return;
  database.prepare("INSERT INTO asset_fts (project_id, asset_id, content) VALUES (?, ?, ?)").run(projectId, assetId, searchText);
}

function replaceAssetShortTerms(database, projectId, assetId, searchText) {
  database.prepare("DELETE FROM asset_short_terms WHERE project_id = ? AND asset_id = ?").run(projectId, assetId);
  const terms = shortUnicodeSearchTerms(searchText);
  if (!terms.length) return;
  const insert = database.prepare("INSERT OR IGNORE INTO asset_short_terms (project_id, asset_id, term) VALUES (?, ?, ?)");
  for (const term of terms) insert.run(projectId, assetId, term);
}

function plainAsciiSearchTerms(query) {
  const value = String(query || "").trim();
  if ([...value].length < 3) return [];
  const terms = value.split(/\s+/).filter(Boolean);
  if (!terms.length || terms.some((term) => !/^[a-z0-9][a-z0-9._-]*$/i.test(term))) return [];
  return terms.map((term) => term.toLowerCase());
}

function buildFtsQuery(query) {
  return String(query).trim().split(/\s+/).filter(Boolean).map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

function resolveAssetSearchQuery(database, projectId, query) {
  const normalized = normalizeAssetSearchQuery(query);
  const plan = conversationalAssetSearchPlan(normalized);
  let planned = normalized;
  if (plan) {
    const candidateTerms = plan.cjkTerms.filter(isIndexedShortUnicodeTerm);
    let knownTerms = new Set();
    if (candidateTerms.length) {
      const rows = database.prepare(`
        SELECT DISTINCT term
        FROM asset_short_terms
        WHERE project_id = @projectId
          AND term IN (SELECT CAST(value AS TEXT) FROM json_each(@terms))
      `).all({ projectId, terms: JSON.stringify(candidateTerms) });
      knownTerms = new Set(rows.map((row) => String(row.term || "")));
    }
    planned = finalizeConversationalSearchPlan(plan, knownTerms)?.query || normalized;
  }
  return designVocabularySearchPlan(planned)?.query || planned;
}

function normalizeLimit(value) {
  if (value === 0 || value === "0") return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(parsed), MAX_PAGE_SIZE);
}

function normalizeStackSort(value) {
  const normalized = String(value || "manual").trim().toLowerCase();
  return normalized === "name" || normalized === "oldest" || normalized === "newest" ? normalized : "manual";
}

function stackCursorFilterKey(filters = {}) {
  return JSON.stringify([
    normalizeAssetSearchQuery(filters.query),
    String(filters.source || ""),
    String(filters.group || ""),
    String(filters.category || ""),
    String(filters.style || ""),
    String(filters.conversation || ""),
    String(filters.generationBatch || ""),
    Boolean(filters.favorite),
    Boolean(filters.recent),
    filters.mediaKind === "img" || filters.mediaKind === "video" ? filters.mediaKind : "",
    Number.isFinite(filters.createdAfterMs) ? filters.createdAfterMs : null,
    Number.isFinite(filters.createdBeforeMs) ? filters.createdBeforeMs : null,
  ]);
}

function encodeStackCursor(row, stackId, sort, filters = {}) {
  return Buffer.from(JSON.stringify({
    stackId,
    sort: normalizeStackSort(sort),
    filterKey: stackCursorFilterKey(filters),
    id: row.id,
    position: Number(row.stack_position),
    createdAt: row.created_at,
    sortName: row.sort_name ?? assetSortName(row),
  })).toString("base64url");
}

function parseStackCursor(value, stackId, sort, filters = {}) {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    const requestedSort = normalizeStackSort(sort);
    if (cursor?.stackId !== stackId || cursor?.sort !== requestedSort || cursor?.filterKey !== stackCursorFilterKey(filters)) throw new Error();
    if (typeof cursor.id !== "string") throw new Error();
    if (requestedSort === "manual" && !Number.isFinite(Number(cursor.position))) throw new Error();
    if ((requestedSort === "oldest" || requestedSort === "newest") && typeof cursor.createdAt !== "string") throw new Error();
    if (requestedSort === "name" && typeof cursor.sortName !== "string") throw new Error();
    return {
      ...cursor,
      position: Number(cursor.position),
    };
  } catch {
    throw assetStoreError("INVALID_STACK_CURSOR", "Invalid Stack cursor.");
  }
}

// Canonical identity of the created-time bounds a page was issued under.
// Cursors carry it so paginating with changed time bounds is rejected the
// same way a changed sort or search query already is.
function assetTimeFilterKey(filters = {}) {
  return JSON.stringify([
    Number.isFinite(filters.createdAfterMs) ? filters.createdAfterMs : null,
    Number.isFinite(filters.createdBeforeMs) ? filters.createdBeforeMs : null,
  ]);
}

function encodeCursor(row, sort, searchQuery = "", timeFilterKey = "") {
  return Buffer.from(JSON.stringify({
    createdAt: row._node_created_at ?? row.created_at,
    id: row.id,
    sortName: row._node_sort_name ?? row.sort_name ?? assetSortName(row),
    sort: normalizeAssetSort(sort),
    searchQuery: normalizeAssetSearchQuery(searchQuery),
    searchScore: Number(row._search_score || 0),
    timeFilterKey,
  })).toString("base64url");
}

/**
 * The cursor carries the order it was issued under. Resuming a `newest` cursor
 * under a `name` sort would compare the wrong key and silently return a page
 * from the middle of an unrelated ordering, so the mismatch is rejected and the
 * caller restarts the query instead. The created-time bounds are part of that
 * order: a page cursor minted under one time window never resumes under
 * another.
 */
function parseCursor(value, sort, searchQuery = "", timeFilterKey = "") {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (typeof cursor?.createdAt !== "string" || typeof cursor?.id !== "string") throw new Error();
    // Cursors minted before sorting existed carry no sort and are chronological.
    const cursorSort = normalizeAssetSort(cursor.sort);
    if (cursorSort !== normalizeAssetSort(sort)) throw new Error();
    if (cursorSort === "name" && typeof cursor.sortName !== "string") throw new Error();
    const normalizedQuery = normalizeAssetSearchQuery(searchQuery);
    if (normalizeAssetSearchQuery(cursor.searchQuery) !== normalizedQuery) throw new Error();
    if (normalizedQuery && !Number.isFinite(Number(cursor.searchScore))) throw new Error();
    if (String(cursor.timeFilterKey ?? "") !== String(timeFilterKey)) throw new Error();
    return cursor;
  } catch {
    throw assetStoreError("INVALID_ASSET_CURSOR", "Invalid asset cursor.");
  }
}

function isGalleryRowAfterCursor(asset, cursor, sort, searchQuery = "") {
  if (!cursor) return false;
  const normalizedSort = normalizeAssetSort(sort);
  const normalizedQuery = normalizeAssetSearchQuery(searchQuery);
  const createdAt = String(asset?.node_sort?.createdAt ?? asset?.created_at ?? "");
  const sortName = String(asset?.node_sort?.sortName ?? asset?.sort_name ?? assetSortName(asset));
  const id = String(asset?.id || "");
  if (normalizedQuery && Number.isFinite(Number(asset?.node_sort?.searchScore))) {
    const score = Number(asset.node_sort.searchScore);
    if (score !== Number(cursor.searchScore)) return score < Number(cursor.searchScore);
  }
  if (normalizedSort === "name") {
    return sortName > cursor.sortName || (sortName === cursor.sortName && id > cursor.id);
  }
  if (normalizedSort === "oldest") {
    return createdAt > cursor.createdAt || (createdAt === cursor.createdAt && id > cursor.id);
  }
  return createdAt < cursor.createdAt || (createdAt === cursor.createdAt && id < cursor.id);
}

function isStackRowAfterCursor(asset, cursor, sort) {
  if (!cursor) return false;
  const normalizedSort = normalizeStackSort(sort);
  const id = String(asset?.id || "");
  if (normalizedSort === "manual") {
    const position = Number(asset?.stack_position);
    return position > Number(cursor.position) || (position === Number(cursor.position) && id > cursor.id);
  }
  const createdAt = String(asset?.created_at || "");
  const sortName = String(asset?.sort_name ?? assetSortName(asset));
  if (normalizedSort === "name") {
    return sortName > cursor.sortName || (sortName === cursor.sortName && id > cursor.id);
  }
  if (normalizedSort === "oldest") {
    return createdAt > cursor.createdAt || (createdAt === cursor.createdAt && id > cursor.id);
  }
  return createdAt < cursor.createdAt || (createdAt === cursor.createdAt && id < cursor.id);
}

async function resolveReadableImagePath(store, value, trustedSourceRoots = []) {
  const requestedPath = resolveRequiredPath(value, "imagePath");
  if (!MEDIA_EXTENSIONS.has(extname(requestedPath).toLowerCase())) throw assetStoreError("IMAGE_PATH_UNSUPPORTED_TYPE", `Unsupported media type: ${requestedPath}`);
  // Messages match the JSON store; only the machine-readable code is new, so the
  // import form can attribute each rejection to the path field.
  const requestedStat = await statForImport(requestedPath);
  if (requestedStat.isSymbolicLink()) throw assetStoreError("IMAGE_PATH_NOT_READABLE", `Refusing to import symbolic links: ${requestedPath}`);
  if (!requestedStat.isFile()) throw assetStoreError("IMAGE_PATH_NOT_READABLE", `imagePath is not a file: ${requestedPath}`);
  const readablePath = await realpath(requestedPath);
  await assertWithinReadableProject(store, readablePath, trustedSourceRoots);
  return { sourcePath: requestedPath, readablePath };
}

async function assertWithinReadableProject(store, filePath, trustedSourceRoots = []) {
  const allowedRoots = [
    store.projectRoot,
    store.generatedImagesDir,
    store.codexImagesDir,
    store.assetsRoot,
    store.cowartPageAssetsDir,
    store.legacyAssetsRoot,
    ...(Array.isArray(trustedSourceRoots) ? trustedSourceRoots : []),
  ].filter((root) => typeof root === "string" && root);
  const roots = (await Promise.all(allowedRoots.map(async (root) => {
    try { return await realpath(root); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }))).filter(Boolean);
  if (!roots.some((root) => filePath === root || isSafeChildPath(root, filePath))) throw assetStoreError("IMAGE_PATH_NOT_READABLE", `Refusing to import outside the project roots: ${filePath}`);
}

async function assertStoredPath(root, filePath) {
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(filePath)]);
  const fileStat = await lstat(realFile);
  if (fileStat.isSymbolicLink() || !fileStat.isFile() || !isSafeChildPath(realRoot, realFile)) throw new Error("Unsafe asset path.");
}

async function codexSourceMetadata(store, filePath) {
  const configuredRoot = resolve(store.codexImagesDir);
  let root;
  try { root = await realpath(configuredRoot); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  if (!isSafeChildPath(root, filePath)) return null;
  const relativePath = relative(root, filePath).split(sep).join("/");
  const [taskId] = relativePath.split("/");
  return { codex_generated_images_root: configuredRoot, codex_task_id: taskId || null, codex_relative_path: relativePath };
}

async function hardLinkOrCopy(sourcePath, targetPath) {
  try { await link(sourcePath, targetPath); return "hard-link"; }
  catch (error) {
    if (!["EXDEV", "EPERM", "EOPNOTSUPP", "ENOTSUP", "EMLINK"].includes(error?.code)) throw error;
    await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
    return "copy";
  }
}

function isSqliteDuplicateError(error) {
  return ["SQLITE_CONSTRAINT_PRIMARYKEY", "SQLITE_CONSTRAINT_UNIQUE"].includes(error?.code);
}

function parseBusinessFields(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

// palette_json stores [{hex, ratio}] sorted by share; assets expose just the
// hex strings in that order. NULL, malformed, and never-computed rows all read
// as [] so callers cannot distinguish "not yet computed" from "no colors".
function paletteJsonToHexes(value) {
  const parsed = parseJson(value, null);
  if (!Array.isArray(parsed)) return [];
  const hexes = [];
  for (const entry of parsed) {
    const hex = entry && typeof entry === "object" ? String(entry.hex || "") : "";
    if (/^#[0-9A-F]{6}$/.test(hex)) hexes.push(hex);
  }
  return hexes;
}

function generationEventFromRow(row) {
  return {
    project_id: row.project_id,
    id: row.id,
    output_asset_id: row.output_asset_id,
    provider: row.provider,
    capture_context_id: row.capture_context_id,
    provider_tool_call_id: row.provider_tool_call_id,
    provider_generation_call_id: row.provider_generation_call_id,
    provider_response_id: row.provider_response_id,
    provider_asset_id: row.provider_asset_id,
    conversation_id: row.conversation_id,
    message_id: row.message_id,
    turn_index: row.turn_index == null ? null : Number(row.turn_index),
    turn_synced_at: row.turn_synced_at == null ? null : String(row.turn_synced_at),
    batch_id: row.batch_id,
    model: row.model,
    user_prompt: row.user_prompt,
    effective_prompt: row.effective_prompt,
    prompt_status: row.prompt_status,
    prompt_scope: row.prompt_scope || "",
    generation_status: row.generation_status || "unknown",
    capture_channel: row.capture_channel,
    verification_level: row.verification_level,
    references: parseJson(row.references_json, []),
    evidence: parseJson(row.evidence_json, {}),
    created_at: row.created_at,
  };
}

function generationRelationFromRow(row) {
  return {
    project_id: row.project_id,
    child_generation_id: row.child_generation_id,
    parent_generation_id: row.parent_generation_id,
    relation_type: row.relation_type,
    verification_level: row.verification_level,
    evidence: parseJson(row.evidence_json, {}),
    created_at: row.created_at,
  };
}

function generationRelationCandidateFromRow(row) {
  return {
    project_id: row.project_id,
    child_generation_id: row.child_generation_id,
    parent_generation_id: row.parent_generation_id,
    suggested_relation_type: row.suggested_relation_type,
    confidence: Number(row.confidence || 0),
    verification_level: row.verification_level,
    evidence: parseJson(row.evidence_json, {}),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function generationOutputAssetIds(database, projectId, generationIds) {
  const ids = [...new Set((Array.isArray(generationIds) ? generationIds : []).map(String).filter(Boolean))];
  if (!ids.length) return [];
  return database.prepare(`
    SELECT DISTINCT output_asset_id
    FROM generation_events
    WHERE project_id = ? AND id IN (SELECT value FROM json_each(?))
  `).all(projectId, JSON.stringify(ids)).map((row) => String(row.output_asset_id || "")).filter(Boolean);
}

function syncSqliteGenerationRelationCandidatesForEvent(database, projectId, previousEvent, nextEvent) {
  const changedEvents = [previousEvent, nextEvent].filter(Boolean);
  const conversations = [...new Set(changedEvents
    .filter((event) => String(event?.provider || "").toLowerCase() === "chatgpt" && event?.conversation_id)
    .map((event) => String(event.conversation_id)))];
  const eventIds = [...new Set(changedEvents.map((event) => event.id).filter(Boolean))];
  const conversationClause = conversations.length
    ? " OR (provider = 'chatgpt' AND conversation_id IN (SELECT value FROM json_each(?)))"
    : "";
  const idClause = eventIds.length ? "id IN (SELECT value FROM json_each(?))" : "0";
  const lookupParams = [projectId];
  if (eventIds.length) lookupParams.push(JSON.stringify(eventIds));
  if (conversations.length) lookupParams.push(JSON.stringify(conversations));
  const events = database.prepare(`
    SELECT * FROM generation_events
    WHERE project_id = ? AND (${idClause}${conversationClause})
    ORDER BY created_at, id
  `).all(...lookupParams).map(generationEventFromRow);
  const compareEvents = (left, right) => (
    String(left?.created_at || "").localeCompare(String(right?.created_at || ""))
    || String(left?.id || "").localeCompare(String(right?.id || ""))
  );
  const thresholdsByConversation = new Map();
  for (const event of changedEvents) {
    if (String(event?.provider || "").toLowerCase() !== "chatgpt" || !event?.conversation_id) continue;
    const key = String(event.conversation_id);
    const current = thresholdsByConversation.get(key);
    if (!current || compareEvents(event, current) < 0) thresholdsByConversation.set(key, event);
  }
  const changedIds = new Set(eventIds);
  const childIds = [...new Set(events
    .filter((event) => {
      if (changedIds.has(event.id)) return true;
      const threshold = thresholdsByConversation.get(String(event.conversation_id || ""));
      return threshold && compareEvents(event, threshold) >= 0;
    })
    .map((event) => event.id))];
  if (!childIds.length) return [];
  const childIdsJson = JSON.stringify(childIds);
  const relations = database.prepare(`
    SELECT * FROM generation_relations
    WHERE project_id = ? AND child_generation_id IN (SELECT value FROM json_each(?))
    ORDER BY created_at, child_generation_id, parent_generation_id
  `).all(projectId, childIdsJson).map(generationRelationFromRow);
  const candidates = database.prepare(`
    SELECT * FROM generation_relation_candidates
    WHERE project_id = ? AND child_generation_id IN (SELECT value FROM json_each(?))
  `).all(projectId, childIdsJson).map(generationRelationCandidateFromRow);
  const resolved = resolveGenerationRelationCandidates({ projectId, events, relations, candidates, childEventIds: childIds, now: now() });
  const write = database.transaction(() => {
    database.prepare(`
      DELETE FROM generation_relation_candidates
      WHERE project_id = ? AND child_generation_id IN (SELECT value FROM json_each(?))
    `).run(projectId, childIdsJson);
    const insert = database.prepare(`
      INSERT INTO generation_relation_candidates (
        project_id, child_generation_id, parent_generation_id, suggested_relation_type,
        confidence, verification_level, evidence_json, status, created_at, updated_at
      ) VALUES (
        @project_id, @child_generation_id, @parent_generation_id, @suggested_relation_type,
        @confidence, @verification_level, @evidence_json, @status, @created_at, @updated_at
      )
    `);
    for (const candidate of resolved) {
      insert.run({ ...candidate, evidence_json: JSON.stringify(candidate.evidence || {}) });
    }
  });
  write();
  return resolved;
}

function syncSqliteGenerationRelationCandidates(database, projectId) {
  const events = database.prepare("SELECT * FROM generation_events WHERE project_id = ? ORDER BY created_at, id").all(projectId).map(generationEventFromRow);
  const relations = database.prepare("SELECT * FROM generation_relations WHERE project_id = ? ORDER BY created_at, child_generation_id, parent_generation_id").all(projectId).map(generationRelationFromRow);
  const candidates = database.prepare("SELECT * FROM generation_relation_candidates WHERE project_id = ?").all(projectId).map(generationRelationCandidateFromRow);
  const resolved = resolveGenerationRelationCandidates({ projectId, events, relations, candidates, now: now() });
  const write = database.transaction(() => {
    database.prepare("DELETE FROM generation_relation_candidates WHERE project_id = ?").run(projectId);
    const insert = database.prepare(`
      INSERT INTO generation_relation_candidates (
        project_id, child_generation_id, parent_generation_id, suggested_relation_type,
        confidence, verification_level, evidence_json, status, created_at, updated_at
      ) VALUES (
        @project_id, @child_generation_id, @parent_generation_id, @suggested_relation_type,
        @confidence, @verification_level, @evidence_json, @status, @created_at, @updated_at
      )
    `);
    for (const candidate of resolved) insert.run({ ...candidate, evidence_json: JSON.stringify(candidate.evidence || {}) });
  });
  write();
  return resolved;
}

function normalizeHash(value) {
  const hash = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : "";
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectHash);
    stream.once("end", resolveHash);
  });
  return hash.digest("hex");
}

function normalizeSuppressionHashes(input = {}) {
  return {
    content_sha256: normalizeHash(input.content_sha256 ?? input.contentSha256),
    pixel_sha256: normalizeHash(input.pixel_sha256 ?? input.pixelSha256),
    pixel_hash_version: String(input.pixel_hash_version ?? input.pixelHashVersion ?? "").trim(),
  };
}

function normalizeSuppressionRecord(input = {}) {
  return {
    project_id: sanitizeProjectId(input.project_id || DEFAULT_PROJECT_ID),
    ...normalizeSuppressionHashes(input),
    deleted_at: String(input.deleted_at || now()),
    reason: String(input.reason || "user-deleted").trim().slice(0, 120) || "user-deleted",
  };
}

function suppressionRowToObject(row) {
  return {
    project_id: row.project_id,
    content_sha256: row.content_sha256,
    pixel_sha256: row.pixel_sha256,
    pixel_hash_version: row.pixel_hash_version || "",
    deleted_at: row.deleted_at,
    reason: row.reason,
  };
}

function assertSqliteVersionParent(database, projectId, assetId, parentAssetId) {
  if (!parentAssetId) return;
  if (parentAssetId === assetId) throw assetStoreError("VERSION_CYCLE", `Asset cannot be its own version parent: ${assetId}`);
  if (database.prepare("SELECT 1 FROM assets WHERE project_id = ? AND id = ?").get(projectId, parentAssetId)) return;
  const foreignProjects = database.prepare("SELECT project_id FROM assets WHERE id = ? AND project_id != ? ORDER BY project_id").all(parentAssetId, projectId).map((row) => row.project_id);
  throw versionParentError(parentAssetId, foreignProjects);
}

function findSqliteVersionRoot(database, projectId, assetId) {
  const chain = database.prepare(`
    WITH RECURSIVE version_chain(id, parent_asset_id, depth, path) AS (
      SELECT id, parent_asset_id, 0, '|' || id || '|'
      FROM assets
      WHERE project_id = ? AND id = ?
      UNION ALL
      SELECT parent.id, parent.parent_asset_id, version_chain.depth + 1, version_chain.path || parent.id || '|'
      FROM assets parent
      JOIN version_chain ON parent.id = version_chain.parent_asset_id
      WHERE parent.project_id = ?
        AND version_chain.parent_asset_id IS NOT NULL
        AND instr(version_chain.path, '|' || parent.id || '|') = 0
        AND version_chain.depth < 5000
    )
    SELECT id, parent_asset_id, depth, path
    FROM version_chain
    ORDER BY depth
  `).all(projectId, assetId, projectId);
  if (!chain.length) throw assetNotFoundError(assetId);
  const last = chain.at(-1);
  if (!last.parent_asset_id) return last.id;
  if (String(last.path || "").includes(`|${last.parent_asset_id}|`)) {
    throw assetStoreError("VERSION_CYCLE", `Version cycle detected at asset: ${last.parent_asset_id}`);
  }
  const foreignProjects = database.prepare("SELECT project_id FROM assets WHERE id = ? AND project_id != ? ORDER BY project_id").all(last.parent_asset_id, projectId).map((item) => item.project_id);
  throw versionParentError(last.parent_asset_id, foreignProjects);
}

function assertSqliteGenerationRelationAcyclic(database, relation, exclude = null) {
  const childId = relation.child_generation_id;
  const parentId = relation.parent_generation_id;
  const excluded = exclude || {};
  const cycle = database.prepare(`
    WITH RECURSIVE ancestors(id) AS (
      VALUES (?)
      UNION
      SELECT gr.parent_generation_id
      FROM generation_relations gr
      JOIN ancestors ON gr.child_generation_id = ancestors.id
      WHERE gr.project_id = ?
        AND NOT (
          gr.child_generation_id = ?
          AND gr.parent_generation_id = ?
          AND gr.relation_type = ?
        )
    )
    SELECT 1 FROM ancestors WHERE id = ? LIMIT 1
  `).get(
    parentId,
    relation.project_id,
    String(excluded.child_generation_id || ""),
    String(excluded.parent_generation_id || ""),
    String(excluded.relation_type || ""),
    childId,
  );
  if (cycle) throw generationHistoryError("Generation relation would create a cycle.", "GENERATION_RELATION_CYCLE");
}

function sqliteGenerationComponentEvents(database, projectId, seedColumn, seedValue) {
  if (!seedValue) return [];
  const safeSeedColumn = seedColumn === "output_asset_id" ? "output_asset_id" : "id";
  return database.prepare(`
    WITH RECURSIVE connected(id) AS (
      SELECT id
      FROM generation_events
      WHERE project_id = @projectId AND ${safeSeedColumn} = @seedValue
      UNION
      SELECT gr.parent_generation_id
      FROM generation_relations gr
      JOIN connected ON gr.child_generation_id = connected.id
      WHERE gr.project_id = @projectId
      UNION
      SELECT gr.child_generation_id
      FROM generation_relations gr
      JOIN connected ON gr.parent_generation_id = connected.id
      WHERE gr.project_id = @projectId
    )
    SELECT ge.*
    FROM generation_events ge
    JOIN connected ON connected.id = ge.id
    WHERE ge.project_id = @projectId
    ORDER BY ge.created_at, ge.id
  `).all({ projectId, seedValue }).map(generationEventFromRow);
}

function sqliteGenerationRelationsForEvents(database, projectId, events) {
  const ids = [...new Set(events.map((event) => event?.id).filter(Boolean))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  return database.prepare(`
    SELECT * FROM generation_relations
    WHERE project_id = ?
      AND child_generation_id IN (${placeholders})
      AND parent_generation_id IN (${placeholders})
    ORDER BY created_at, child_generation_id, parent_generation_id
  `).all(projectId, ...ids, ...ids).map(generationRelationFromRow);
}

function sqliteGenerationCandidatesForEvents(database, projectId, events) {
  const ids = [...new Set(events.map((event) => event?.id).filter(Boolean))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  return database.prepare(`
    SELECT * FROM generation_relation_candidates
    WHERE project_id = ?
      AND (child_generation_id IN (${placeholders}) OR parent_generation_id IN (${placeholders}))
    ORDER BY child_generation_id, confidence DESC, parent_generation_id
  `).all(projectId, ...ids, ...ids).map(generationRelationCandidateFromRow);
}

function sqliteGenerationContextEvents(database, projectId, assetId, lineageEvents, candidates, limit) {
  if (!limit || !lineageEvents.length) return [];
  const connectedIds = [...new Set(lineageEvents.map((event) => event.id).filter(Boolean))];
  const candidateIds = [...new Set(candidates.flatMap((candidate) => [candidate.child_generation_id, candidate.parent_generation_id]).filter(Boolean))];
  const connectedPlaceholders = connectedIds.map(() => "?").join(",");
  const candidateClause = candidateIds.length
    ? ` OR ge.id IN (${candidateIds.map(() => "?").join(",")})`
    : "";
  return database.prepare(`
    SELECT ge.*
    FROM generation_events ge
    WHERE ge.project_id = ?
      AND ge.id NOT IN (${connectedPlaceholders})
      AND (
        EXISTS (
          SELECT 1 FROM generation_events seed
          WHERE seed.project_id = ge.project_id
            AND seed.output_asset_id = ?
            AND seed.conversation_id != ''
            AND seed.provider = ge.provider
            AND seed.conversation_id = ge.conversation_id
        )${candidateClause}
      )
    ORDER BY ge.created_at, ge.id
    LIMIT ?
  `).all(projectId, ...connectedIds, assetId, ...candidateIds, limit).map(generationEventFromRow);
}

function normalizeParentAssetId(value) {
  return value ? sanitizeId(value, "asset") : null;
}

function sanitizeProjectId(value) { return sanitizeId(value || DEFAULT_PROJECT_ID, DEFAULT_PROJECT_ID); }
function sanitizeId(value, fallback) { return String(value || fallback).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || fallback; }
function sanitizeFileName(value) { const raw = basename(String(value || "asset.png")); const extension = extname(raw) || ".png"; const base = raw.slice(0, raw.length - extname(raw).length).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""); return `${base || "asset"}${extension}`; }
function slugName(value) { return sanitizeId(String(value || "asset").replace(/\.[^.]+$/, ""), "asset").slice(0, 56); }
function shortStamp() { return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`; }
function uniqueArray(values) { return [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map(String))]; }
function normalizeGroupName(value) { return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80); }

function normalizeGroupColor(value) {
  const color = String(value || "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : "";
}

/**
 * Resolves a requested group name to the stored spelling of an existing
 * (case-insensitively equal) group row. Every assignment write path funnels
 * through this so `assets.group_name` and `groups.name` never diverge by case
 * alone — the sidebar count join and the gallery facet filter both compare
 * `group_name` with SQLite's default BINARY collation.
 */
function canonicalGroupName(database, projectId, name) {
  const normalized = normalizeGroupName(name);
  if (!normalized) return "";
  const row = database.prepare(
    "SELECT name FROM groups WHERE project_id = ? AND name = ? COLLATE NOCASE",
  ).get(sanitizeProjectId(projectId || DEFAULT_PROJECT_ID), normalized);
  return row ? row.name : "";
}
function resolveRequiredPath(value, label) { if (!value || typeof value !== "string") throw assetStoreError("IMAGE_PATH_REQUIRED", `${label} is required.`); return resolve(value); }
/** A missing file is an ordinary form mistake, not a 500. */
async function statForImport(requestedPath) {
  try {
    return await lstat(requestedPath);
  } catch (error) {
    if (error?.code === "ENOENT") throw assetStoreError("IMAGE_PATH_NOT_FOUND", `imagePath does not exist: ${requestedPath}`);
    throw error;
  }
}
function isSafeChildPath(parent, child) { return isPathInside(parent, child); }
function now() { return new Date().toISOString(); }

async function contentHashForAsset(asset, filesToUnlink) {
  const recorded = normalizeHash(asset.source?.content_sha256);
  if (recorded) return recorded;
  const originalPath = filesToUnlink.find((filePath) => filePath === asset.image_path) || "";
  if (!originalPath) return "";
  try {
    return await sha256File(originalPath);
  } catch {
    return "";
  }
}

async function automaticSuppressionIdentityForAsset(asset, managedPaths) {
  const contentHash = await contentHashForAsset(asset, managedPaths);
  const storedPixelHash = normalizeHash(asset.source?.pixel_sha256);
  const storedPixelHashVersion = String(asset.source?.pixel_hash_version || "").trim();
  const recomputedPixelHash = (!storedPixelHash || storedPixelHashVersion !== PIXEL_HASH_VERSION) && asset.image_path
    ? await safePixelDigest(asset.image_path).catch(() => "")
    : "";
  const pixelHash = storedPixelHashVersion === PIXEL_HASH_VERSION && storedPixelHash
    ? storedPixelHash
    : (recomputedPixelHash || storedPixelHash);
  const pixelHashVersion = recomputedPixelHash
    ? PIXEL_HASH_VERSION
    : (pixelHash ? storedPixelHashVersion : "");
  return { contentHash, pixelHash, pixelHashVersion };
}
