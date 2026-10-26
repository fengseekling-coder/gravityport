import { copyFile, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { createSqliteAssetStore, hasCompletedSqliteLibrary, sqliteDatabasePath, STYLE_FACET_LIMIT, TRASH_RETENTION_MS } from "./sqlite-asset-store.mjs";
import { relinkCodexAssets } from "./codex-hardlink.js";
import { normalizeAssetCuration } from "./asset-curation.mjs";
import { createdAtTimestamp, isRecentCreatedAt, normalizeCreatedAt, recentCutoffTimestamp } from "./recent-window.js";
import { PIXEL_HASH_VERSION, safePixelDigest } from "./image-pixel-hash.js";
import { isPathInside } from "./path-safety.mjs";
import { resolveSourceLocations } from "./source-locations.js";
import { cleanupPermanentDeletionStaging, stageFilesForPermanentDeletion } from "./trash-files.mjs";
import {
  assertGenerationRelationUserMutable,
  assertGenerationRelationAcyclic,
  buildAssetGenerationHistory,
  buildGenerationLineage,
  generationHistoryError,
  generationCandidatePairKey,
  mergeGenerationEventForUpdate,
  normalizeGenerationEvent,
  normalizeGenerationRelation,
  normalizeGenerationRelationCandidate,
  preserveTrustedGenerationRelation,
  resolveGenerationRelationCandidates,
} from "./generation-history.mjs";
// Same media classification as the SQLite store's mosa_media_kind: explicit
// media_kind first, then the file extension. Powers the V2 type filter.
const MEDIA_KIND_IMAGE_EXT = new Set([".apng", ".avif", ".gif", ".jpg", ".jpeg", ".png", ".svg", ".webp"]);
const MEDIA_KIND_VIDEO_EXT = new Set([".m4v", ".mov", ".mp4", ".webm"]);
function mediaKindOfAsset(asset = {}) {
  const kind = asset.source?.media_kind || asset.business_fields?.media_kind;
  if (kind === "video") return "video";
  if (kind === "image") return "image";
  const match = /\.([a-z0-9]+)(?:$|\?)/i.exec(String(asset.image_path || asset.asset || ""));
  const ext = match ? `.${match[1].toLowerCase()}` : "";
  if (MEDIA_KIND_VIDEO_EXT.has(ext)) return "video";
  if (MEDIA_KIND_IMAGE_EXT.has(ext)) return "image";
  return "unknown";
}
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
import { appendRecipeSnapshot, ensureRecipeSnapshots, recipeHistory } from "./recipe-snapshot.js";
import { hasLegacyJsonState } from "./library-location.mjs";
import { assetSortName, compareAssets, normalizeAssetSort } from "./asset-sort.js";
import { assetSearchScore, compareAssetSearchResults, normalizeAssetSearchQuery } from "./asset-search.mjs";

const IMAGE_EXTENSIONS = new Set([".apng", ".avif", ".gif", ".jpg", ".jpeg", ".png", ".svg", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".m4v", ".mov", ".mp4", ".webm"]);
const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);
/** Served to the import form so its "supported formats" hint cannot drift from what is accepted. */
export const SUPPORTED_MEDIA_EXTENSIONS = [...MEDIA_EXTENSIONS].sort();
const DEFAULT_PROJECT_ID = "default";
const CANONICAL_SOURCE_TYPES = new Set([
  "web-chatgpt",
  "web-gemini",
  "web-flow",
  "web-google-ai-studio",
  "web-jimeng",
  "web-midjourney",
  "codex-generated",
  "grok-generated",
  "cowart-generated",
]);
const WEB_SOURCE_TYPE_BY_PROVIDER = new Map([
  ["chatgpt", "web-chatgpt"],
  ["gemini", "web-gemini"],
  ["flow", "web-flow"],
  ["google-ai-studio", "web-google-ai-studio"],
  ["jimeng", "web-jimeng"],
  ["midjourney", "web-midjourney"],
]);
const STORE_LOCK_TIMEOUT_MS = 5000;
const STORE_LOCK_STALE_MS = 30_000;
const STORE_CLEANUP_LOCK_STALE_MS = 5000;
// Corrupt metadata is reported once per store instance so repeated gallery scans cannot flood the caller.
const warnedMetadataPaths = new WeakMap();

function canonicalAssetSourceType(asset = {}) {
  const source = asset.source && typeof asset.source === "object" ? asset.source : {};
  const rawType = String(source.type || asset.sourceType || "").trim();
  if (CANONICAL_SOURCE_TYPES.has(rawType)) return rawType;

  const provider = String(source.provider || asset.business_fields?.provider || "").trim().toLowerCase();
  const webSourceType = WEB_SOURCE_TYPE_BY_PROVIDER.get(provider);
  if (webSourceType) return webSourceType;

  const generationTool = String(source.generation_tool || asset.business_fields?.generation_tool || "").trim().toLowerCase();
  if (generationTool === "codex") return "codex-generated";
  if (generationTool === "grok") return "grok-generated";
  if (generationTool === "cowart") return "cowart-generated";
  return rawType;
}

/**
 * Selects SQLite for completed migrations and genuinely fresh libraries.
 * Legacy JSON state always wins until the explicit migration has completed, so
 * an upgrade can never silently strand existing metadata or media.
 */
export function createAssetStore(options = {}) {
  const libraryDir = options.libraryDir || process.env.MOSA_LIBRARY_DIR;
  if (libraryDir && hasCompletedSqliteLibrary(libraryDir)) {
    return createSqliteAssetStore({ ...options, libraryDir });
  }
  if (libraryDir && !existsSync(sqliteDatabasePath(libraryDir))
    && existsSync(join(resolve(libraryDir), ".sqlite-migration-completed"))) {
    const error = new Error("The migrated SQLite library is missing. Restore mosa.db instead of falling back to the legacy JSON snapshot.");
    error.code = "SQLITE_LIBRARY_MISSING";
    throw error;
  }
  // A database that already exists but is not marked completed is never a
  // fresh-library signal. It may be a failed/interrupted migration, so fail
  // closed to the legacy store until migration is explicitly completed.
  if (libraryDir && existsSync(sqliteDatabasePath(libraryDir))) {
    return createJsonAssetStore(options);
  }
  if (libraryDir && !hasLegacyJsonState(options)) {
    return createSqliteAssetStore({ ...options, libraryDir, initializeFreshLibrary: true });
  }
  return createJsonAssetStore(options);
}

/**
 * A fresh runtime may have created the legacy directory skeleton without ever
 * storing user data. Whether a folder holds meaningful legacy JSON state is
 * decided by hasLegacyJsonState() in lib/library-location.mjs, shared with
 * library location resolution so both can never disagree. If the scan fails,
 * fail closed and keep JSON so uncertain data is never bypassed by an
 * automatic SQLite selection.
 */

export function createJsonAssetStore(options = {}) {
  // Concurrency contract (JSON fallback store):
  //
  // The JSON backend has no cross-process metadata transaction: every per-asset
  // metadata write is one fsync of a single project JSON file, and original
  // images are managed as insert-only content-hash filenames. That makes the
  // backend safe for any *single* writer process, but it cannot satisfy two
  // writers touching the same library directory concurrently without losing
  // metadata (last-writer-wins on the project JSON) or producing orphan files.
  //
  // Three external writers exist:
  //
  //   1. `npm start` (or `node server.mjs`) — the local HTTP runtime. Holds
  //      the Web/MCP JSON lock for as long as the runtime is alive.
  //   2. `npm run mcp` — the standalone MCP stdio server. Holds the same lock
  //      for as long as it is alive (see mcp/server.mjs directStoreLease).
  //   3. `bin/mosa.mjs` — one-shot CLI commands (migrate / verify / backup /
  //      restore). They open the SQLite store directly and do not acquire
  //      this JSON lock; the lease only coordinates JSON-mode writers.
  //
  // `runtime-lock.js` enforces that at most one writer holds the lease per
  // library directory at any time. A second writer attempting to open the
  // library fails closed with a "lock held by another writer" error instead of
  // silently corrupting metadata.
  //
  // SQLite mode does not need this guard because WAL + insert-only original
  // filenames give the same contract across many concurrent connections.
  //
  // Within a single process the JSON store is safe: every per-asset metadata
  // mutation funnels through `acquireStoreFileLock` (a proper-lockfile handle
  // keyed on the asset id) and every project-level metadata operation uses
  // the same helper keyed on the project id. Asynchronous fs.promises
  // operations are intentionally interleaved *between* projects but never
  // within the same project, so cross-project reads see stable metadata.

  const projectRoot = resolve(options.projectRoot || process.cwd());
  const managerDir = resolve(options.managerDir || join(projectRoot, "mosa"));
  // Only an explicitly configured library location roots JSON assets inside it. Direct
  // callers treat options.libraryDir / MOSA_LIBRARY_DIR as explicit; the runtime always
  // computes a *default* libraryDir for SQLite detection and lock management, so it
  // passes `explicitLibraryDir` to record whether the user actually configured one.
  // Without that signal the bundled managerDir/assets stays in use.
  const explicitLibraryDir = Object.hasOwn(options, "explicitLibraryDir")
    ? options.explicitLibraryDir
    : options.libraryDir || process.env.MOSA_LIBRARY_DIR || null;
  const resolvedLibraryDir = explicitLibraryDir ? resolve(explicitLibraryDir) : null;
  const assetsRoot = resolve(options.assetsRoot || (resolvedLibraryDir ? join(resolvedLibraryDir, "assets") : join(managerDir, "assets")));
  const generatedImagesDir = resolve(options.generatedImagesDir || join(projectRoot, "generated-images"));
  const { codexImagesDir, cowartCanvasDir } = resolveSourceLocations({
    env: process.env,
    overrides: {
      codexImagesDir: options.codexImagesDir,
      cowartCanvasDir: options.cowartCanvasDir,
    },
  });
  const cowartPageAssetsDir = join(cowartCanvasDir, "pages");
  const onWarning = typeof options.onWarning === "function" ? options.onWarning : null;

  // In-memory change journal for the JSON store. The store has no mutation
  // counter of its own, so the revision advances whenever the on-disk
  // fingerprint observed by libraryRevision() changes. Journal entries are
  // unclassified ("library-changed"); incremental clients answer them with a
  // bounded current-view refresh, which matches the pre-delta behavior for
  // this fallback storage backend. The journal is process-local: after a
  // restart clients reconcile from an empty journal once (full refresh) and
  // continue incrementally from there.
  const JSON_CHANGE_JOURNAL_LIMIT = 2000;
  let jsonChangeCounter = 0;
  const jsonChangeJournal = [];
  const jsonFingerprints = new Map();

  function recordJsonLibraryChange(change) {
    jsonChangeCounter += 1;
    jsonChangeJournal.push({ revision: jsonChangeCounter, entityType: "library", entityId: "", flags: [], assetIds: [], detail: {}, ...change });
    if (jsonChangeJournal.length > JSON_CHANGE_JOURNAL_LIMIT) {
      jsonChangeJournal.splice(0, jsonChangeJournal.length - JSON_CHANGE_JOURNAL_LIMIT);
    }
    return jsonChangeCounter;
  }

  return {
    storageKind: "json",
    projectRoot,
    managerDir,
    libraryDir: resolvedLibraryDir,
    assetsRoot,
    generatedImagesDir,
    codexImagesDir,
    cowartCanvasDir,
    cowartPageAssetsDir,
    onWarning,
    projectId(value) {
      return sanitizeProjectId(value);
    },
    projectDir(projectId = DEFAULT_PROJECT_ID) {
      return join(assetsRoot, sanitizeProjectId(projectId));
    },
    imagesDir(projectId = DEFAULT_PROJECT_ID) {
      return join(assetsRoot, sanitizeProjectId(projectId), "images");
    },
    promptsDir(projectId = DEFAULT_PROJECT_ID) {
      return join(assetsRoot, sanitizeProjectId(projectId), "prompts");
    },
    metadataDir(projectId = DEFAULT_PROJECT_ID) {
      return join(assetsRoot, sanitizeProjectId(projectId), "metadata");
    },
    async libraryRevision(projectId = DEFAULT_PROJECT_ID) {
      const cleanProjectId = sanitizeProjectId(projectId);
      const paths = [this.metadataDir(cleanProjectId), this.groupsFile(cleanProjectId)];
      const parts = await Promise.all(paths.map(async (filePath) => {
        try {
          const info = await stat(filePath);
          return `${info.mtimeMs}:${info.size}`;
        } catch (error) {
          if (error?.code === "ENOENT") return "0:0";
          throw error;
        }
      }));
      const fingerprint = parts.join(":");
      if (jsonFingerprints.get(cleanProjectId) !== fingerprint) {
        jsonFingerprints.set(cleanProjectId, fingerprint);
        recordJsonLibraryChange({ projectId: cleanProjectId, kind: "library-changed" });
      }
      return String(jsonChangeCounter);
    },
    async libraryChangeState(projectId = DEFAULT_PROJECT_ID) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const relevant = jsonChangeJournal.filter((change) => change.projectId === cleanProjectId);
      return {
        revision: jsonChangeCounter,
        oldestRevision: relevant.length ? Number(relevant[0].revision) : null,
      };
    },
    async listLibraryChangesSince(projectId, sinceRevision, { limit = 5000 } = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const since = Number(sinceRevision);
      const { revision, oldestRevision } = await this.libraryChangeState(cleanProjectId);
      if (!Number.isFinite(since) || since >= revision) {
        return { sinceRevision: Number.isFinite(since) ? since : null, currentRevision: revision, oldestRevision, complete: true, changes: [] };
      }
      const complete = oldestRevision == null ? false : since >= (Number(oldestRevision) - 1);
      const changes = jsonChangeJournal
        .filter((change) => change.projectId === cleanProjectId && Number(change.revision) > since)
        .map(({ projectId: changeProject, ...change }) => change);
      const bounded = Math.max(1, Math.min(Number(limit) || 5000, JSON_CHANGE_JOURNAL_LIMIT));
      return {
        sinceRevision: since,
        currentRevision: revision,
        oldestRevision,
        complete: complete && changes.length < bounded,
        changes,
      };
    },
    async listGalleryRowsForAssets(filters = {}, assetIds = []) {
      const cleanIds = [...new Set((Array.isArray(assetIds) ? assetIds : []).map((id) => String(id).trim()).filter(Boolean))];
      if (!cleanIds.length) return { rows: [], rowByAssetId: {} };
      if (filters.stackId) return { rows: [], rowByAssetId: {} };
      const assets = await this.listAssets({ ...filters, limit: 0 });
      const wanted = new Set(cleanIds);
      const rows = assets.filter((asset) => wanted.has(asset.id));
      rows.forEach((asset) => {
        asset.node_sort = {
          createdAt: String(asset.created_at || ""),
          sortName: String(asset.sort_name ?? assetSortName(asset) ?? ""),
          searchScore: null,
        };
      });
      const rowByAssetId = {};
      for (const assetId of cleanIds) rowByAssetId[assetId] = assetId;
      const sort = normalizeAssetSort(filters.sort);
      const searchQuery = normalizeAssetSearchQuery(filters.query);
      const cursor = filters.boundaryCursor ? parseAssetCursor(filters.boundaryCursor, sort, searchQuery) : null;
      const boundary = cursor ? cursorRow(cursor) : null;
      const afterCursorRowIds = cursor
        ? rows.filter((asset) => {
          if (!searchQuery) return compareAssets(sort, asset, boundary) > 0;
          const score = assetSearchScore(asset, searchQuery);
          if (score !== cursor.searchScore) return score < cursor.searchScore;
          return compareAssets(sort, asset, boundary) > 0;
        }).map((asset) => asset.id)
        : [];
      return { rows, rowByAssetId, afterCursorRowIds };
    },
    groupsFile(projectId = DEFAULT_PROJECT_ID) {
      return join(this.projectDir(projectId), "groups.json");
    },
    automaticIngestSuppressionsFile(projectId = DEFAULT_PROJECT_ID) {
      return join(this.projectDir(projectId), "automatic-ingest-suppressions.json");
    },
    generationEventsFile(projectId = DEFAULT_PROJECT_ID) {
      return join(this.projectDir(projectId), "generation-events.json");
    },
    generationRelationsFile(projectId = DEFAULT_PROJECT_ID) {
      return join(this.projectDir(projectId), "generation-relations.json");
    },
    generationRelationCandidatesFile(projectId = DEFAULT_PROJECT_ID) {
      return join(this.projectDir(projectId), "generation-relation-candidates.json");
    },
    async ensureProject(projectId = DEFAULT_PROJECT_ID) {
      const cleanProjectId = sanitizeProjectId(projectId);
      await mkdir(this.imagesDir(cleanProjectId), { recursive: true });
      await mkdir(this.promptsDir(cleanProjectId), { recursive: true });
      await mkdir(this.metadataDir(cleanProjectId), { recursive: true });
      return cleanProjectId;
    },
    async listProjects() {
      await mkdir(assetsRoot, { recursive: true });
      const entries = await readdir(assetsRoot, { withFileTypes: true });
      const projects = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
      if (!projects.includes(DEFAULT_PROJECT_ID)) {
        await this.ensureProject(DEFAULT_PROJECT_ID);
        projects.unshift(DEFAULT_PROJECT_ID);
      }
      return [...new Set(projects)];
    },
    async listAssets(filters = {}) {
      const projectId = await this.ensureProject(filters.projectId || DEFAULT_PROJECT_ID);
      const assets = deriveChildAssetIds(await readProjectAssets(this, projectId)).map(withRuntimeUrls);
      const recentSince = Number.isFinite(filters.recentSince) ? filters.recentSince : recentCutoffTimestamp();
      const searchQuery = normalizeAssetSearchQuery(filters.query);

      return assets
        .filter((asset) => !searchQuery || assetSearchScore(asset, searchQuery) > 0)
        .filter((asset) => (filters.trash ? Boolean(asset.deleted_at) : !asset.deleted_at))
        .filter((asset) => filters.trash || (filters.archived ? Boolean(asset.archived) : !asset.archived))
        .filter((asset) => {
          const createdAtMs = createdAtTimestamp(asset.created_at);
          if (Number.isFinite(filters.createdAfterMs) && (!Number.isFinite(createdAtMs) || createdAtMs < filters.createdAfterMs)) return false;
          if (Number.isFinite(filters.createdBeforeMs) && (!Number.isFinite(createdAtMs) || createdAtMs > filters.createdBeforeMs)) return false;
          if (filters.source && canonicalAssetSourceType(asset) !== filters.source) return false;
          if (filters.conversation && asset.source?.conversation_id !== filters.conversation) return false;
          if (filters.generationBatch && asset.source?.message_id !== filters.generationBatch) return false;
          if (filters.group && asset.group !== filters.group) return false;
          if (filters.category && asset.category !== filters.category) return false;
          if (filters.style && asset.style !== filters.style) return false;
          if (filters.favorite && !(asset.rating > 0 || asset.favorite === true)) return false;
          if (filters.unorganized && String(asset.group || "").trim()) return false;
          if (filters.mediaKind === "img" && mediaKindOfAsset(asset) !== "image") return false;
          if (filters.mediaKind === "video" && mediaKindOfAsset(asset) !== "video") return false;
          if (filters.recent && !isRecentCreatedAt(asset.created_at, recentSince)) return false;
          return true;
        })
        .sort((left, right) => searchQuery
          ? compareAssetSearchResults(searchQuery, filters.sort, left, right)
          : compareAssets(filters.sort, left, right));
    },
    async listAssetPage(filters = {}) {
      const sort = normalizeAssetSort(filters.sort);
      const searchQuery = normalizeAssetSearchQuery(filters.query);
      const assets = await this.listAssets(filters);
      const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 250);
      let start = 0;
      if (filters.cursor) {
        const cursor = parseAssetCursor(filters.cursor, sort, searchQuery);
        const boundary = cursorRow(cursor);
        start = assets.findIndex((asset) => {
          if (!searchQuery) return compareAssets(sort, asset, boundary) > 0;
          const score = assetSearchScore(asset, searchQuery);
          if (score !== cursor.searchScore) return score < cursor.searchScore;
          return compareAssets(sort, asset, boundary) > 0;
        });
        if (start < 0) start = assets.length;
      }
      const pageAssets = assets.slice(start, start + limit);
      const last = pageAssets.at(-1);
      return {
        assets: pageAssets,
        page: {
          total: filters.includeTotal === false ? null : assets.length,
          limit,
          nextCursor: start + limit < assets.length && last
            ? Buffer.from(JSON.stringify({
              createdAt: last.created_at,
              id: last.id,
              sortName: assetSortName(last),
              sort,
              searchQuery,
              searchScore: searchQuery ? assetSearchScore(last, searchQuery) : 0,
            })).toString("base64url")
            : null,
          sort,
        },
      };
    },
    async listNavigationStats(projectId = DEFAULT_PROJECT_ID) {
      const groups = await this.listGroups(projectId);
      return {
        total: groups.total,
        favorites: groups.favorites,
        unorganized: groups.unorganized,
        trash: groups.trash,
        sourceTypes: groups.sourceTypes,
        groups: groups.groups,
      };
    },
    async listGroups(projectId = DEFAULT_PROJECT_ID) {
      const cleanProjectId = await this.ensureProject(projectId);
      // One cutoff for the whole call: the scan below and the recent counter must not
      // read the clock twice, or a boundary asset could be counted inconsistently.
      const recentSince = recentCutoffTimestamp();
      const assets = await this.listAssets({ projectId: cleanProjectId, recentSince });
      const manualGroups = await readGroupRecords(this, cleanProjectId);
      const groups = {};
      const sourceTypes = {};
      const categories = {};
      const styles = {};
      let total = 0;
      let favorites = 0;
      let recent = 0;
      let unorganized = 0;
      let codex = 0;
      let cowart = 0;
      let grok = 0;

      for (const record of manualGroups) groups[record.name] = 0;

      for (const asset of assets) {
        total++;
        // 收藏：rating > 0 或 favorite 标记为 true
        if (asset.rating > 0 || asset.favorite === true) favorites++;
        if (isRecentCreatedAt(asset.created_at, recentSince)) recent++;
        if (!String(asset.group || "").trim()) unorganized++;
        if (asset.source?.type === "codex-generated") codex++;
        if (asset.source?.type === "cowart-generated") cowart++;
        if (asset.source?.type === "grok-generated") grok++;
        const sourceType = canonicalAssetSourceType(asset);
        if (sourceType) sourceTypes[sourceType] = (sourceTypes[sourceType] || 0) + 1;
        const g = asset.group || "";
        if (g) groups[g] = (groups[g] || 0) + 1;
        const c = asset.category || "";
        if (c) categories[c] = (categories[c] || 0) + 1;
        const s = asset.style || "";
        if (s) styles[s] = (styles[s] || 0) + 1;
      }

      return {
        total,
        favorites,
        recent,
        unorganized,
        codex,
        cowart,
        grok,
        sourceTypes: Object.entries(sourceTypes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
        groups: manualGroups.map((record) => ({
          name: record.name,
          count: Number(groups[record.name] || 0),
          color: record.color,
          position: record.position,
        })),
        categories: Object.entries(categories).sort((a, b) => b[1] - a[1]),
        // Matches the SQLite store: the panel searches this list client-side, and
        // `styleTotal` keeps a truncated list honest about what it is hiding.
        styles: Object.entries(styles).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, STYLE_FACET_LIMIT),
        styleTotal: Object.keys(styles).length,
        trash: (await readProjectAssets(this, cleanProjectId)).filter((asset) => asset.deleted_at).length,
      };
    },
    async createGroup(input = {}) {
      const projectId = await this.ensureProject(input.projectId || DEFAULT_PROJECT_ID);
      return withGroupWriteLock(this, projectId, async () => {
        const name = normalizeGroupName(input.name);
        if (!name) throw assetStoreError("GROUP_NAME_REQUIRED", "Group name is required.");
        const records = await readGroupRecords(this, projectId);
        const existing = findGroupRecord(records, name);
        if (existing) throw assetStoreError("GROUP_ALREADY_EXISTS", `Group already exists: ${existing.name}`);
        const created = { name, color: normalizeGroupColor(input.color), position: records.length };
        records.push(created);
        await writeGroupRecords(this, projectId, records);
        return { ...created, count: 0 };
      });
    },
    async renameGroup(projectId, groupName, nextGroupName) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      return withGroupWriteLock(this, cleanProjectId, async () => {
        const currentName = normalizeGroupName(groupName);
        const nextName = normalizeGroupName(nextGroupName);
        if (!currentName || !nextName) throw assetStoreError("GROUP_NAME_REQUIRED", "Group name is required.");

        const names = (await readGroupRecords(this, cleanProjectId)).map((record) => record.name);
        const index = names.findIndex((item) => item.toLocaleLowerCase() === currentName.toLocaleLowerCase());
        if (index === -1) throw assetStoreError("GROUP_NOT_FOUND", `Group not found: ${currentName}`);
        const duplicate = names.some((item, itemIndex) => itemIndex !== index && item.toLocaleLowerCase() === nextName.toLocaleLowerCase());
        if (duplicate) throw assetStoreError("GROUP_ALREADY_EXISTS", `Group already exists: ${nextName}`);

        const assets = await this.listAssets({ projectId: cleanProjectId });
        const conflictingAssignment = assets.some((asset) => (
          asset.group
          && asset.group.toLocaleLowerCase() !== currentName.toLocaleLowerCase()
          && asset.group.toLocaleLowerCase() === nextName.toLocaleLowerCase()
        ));
        if (conflictingAssignment) throw assetStoreError("GROUP_ALREADY_EXISTS", `Group already exists: ${nextName}`);

        await withGroupRecords(this, cleanProjectId, async (records) => {
          const record = findGroupRecord(records, currentName);
          if (!record) throw assetStoreError("GROUP_NOT_FOUND", `Group not found: ${currentName}`);
          record.name = nextName;
        });
        for (const asset of assets) {
          if (asset.group?.toLocaleLowerCase() !== currentName.toLocaleLowerCase()) continue;
          await writeMetadata(this, normalizeAssetMetadata({
            ...asset,
            group: nextName,
            updated_at: new Date().toISOString(),
          }));
        }
        return { success: true, oldName: currentName, name: nextName };
      });
    },
    async deleteGroup(projectId, groupName, options = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      return withGroupWriteLock(this, cleanProjectId, async () => {
        const name = normalizeGroupName(groupName);
        if (!name) throw assetStoreError("GROUP_NAME_REQUIRED", "Group name is required.");

        const previousRecords = await readGroupRecords(this, cleanProjectId);
        const target = findGroupRecord(previousRecords, name);
        if (!target) throw assetStoreError("GROUP_NOT_FOUND", `Group not found: ${name}`);
        const storedName = target.name;

        // Read raw project metadata so archived assets participate too. SQLite
        // has always cleared archived memberships when a group is removed; the
        // JSON store must preserve the same contract.
        const assets = await readProjectAssets(this, cleanProjectId);
        const groupAssets = assets.filter((asset) => asset.group?.toLocaleLowerCase() === name.toLocaleLowerCase());

        if (options.deleteAssets === true && groupAssets.length) {
          const deletedAt = new Date().toISOString();
          const activeAssets = groupAssets.filter((asset) => !asset.deleted_at);
          const deletingIds = new Set(activeAssets.map((asset) => asset.id));
          const externalChild = assets.find((asset) => (
            !asset.deleted_at
            && asset.parent_asset_id
            && deletingIds.has(asset.parent_asset_id)
            && !deletingIds.has(asset.id)
          ));
          if (externalChild) {
            throw assetStoreError(
              "VERSION_PARENT_HAS_CHILDREN",
              `Cannot move group ${name} to Trash; version parent ${externalChild.parent_asset_id} has active child ${externalChild.id} outside the group.`,
            );
          }
          const projectDir = this.projectDir(cleanProjectId);
          const plans = await Promise.all(activeAssets.map(async (asset) => {
            const managedPaths = [asset.image_path, asset.prompt_path]
              .filter((filePath) => filePath && isSafeChildPath(projectDir, resolve(filePath)))
              .map((filePath) => resolve(filePath));
            return { asset, ...(await automaticSuppressionIdentityForAsset(asset, managedPaths)) };
          }));
          await withSuppressionWriteLock(this, cleanProjectId, async () => {
            const previousSuppressions = await readAutomaticIngestSuppressions(this, cleanProjectId);
            let nextSuppressions = [...previousSuppressions];
            for (const plan of plans) {
              if (!plan.contentHash && !plan.pixelHash) continue;
              const normalized = normalizeSuppressionRecord({
                project_id: cleanProjectId,
                content_sha256: plan.contentHash,
                pixel_sha256: plan.pixelHash,
                pixel_hash_version: plan.pixelHashVersion,
                deleted_at: deletedAt,
                reason: "user-deleted",
              });
              nextSuppressions = [
                ...nextSuppressions.filter((item) => !(
                  item.content_sha256 === normalized.content_sha256
                  && item.pixel_sha256 === normalized.pixel_sha256
                  && String(item.pixel_hash_version || "") === String(normalized.pixel_hash_version || "")
                )),
                normalized,
              ];
            }
            const changed = [];
            try {
              if (nextSuppressions.length !== previousSuppressions.length || nextSuppressions.some((item, itemIndex) => item !== previousSuppressions[itemIndex])) {
                await writeAutomaticIngestSuppressions(this, cleanProjectId, nextSuppressions);
              }
              for (const plan of plans) {
                await writeMetadata(this, normalizeAssetMetadata({ ...plan.asset, deleted_at: deletedAt, updated_at: deletedAt }));
                changed.push(plan.asset);
              }
              await withGroupRecords(this, cleanProjectId, (records) => {
                const record = findGroupRecord(records, storedName);
                if (record) records.splice(records.indexOf(record), 1);
              });
            } catch (error) {
              await Promise.allSettled(changed.map((asset) => writeMetadata(this, asset)));
              await writeGroupRecords(this, cleanProjectId, previousRecords).catch(() => {});
              await writeAutomaticIngestSuppressions(this, cleanProjectId, previousSuppressions).catch(() => {});
              throw error;
            }
          });
          return { success: true, name: storedName, deletedAssets: activeAssets.length, trashed: true };
        } else {
          for (const asset of groupAssets) {
            // Group membership is library organization, not a recipe revision.
            // Write the metadata directly so deleting a group does not append a
            // misleading "Recipe updated" snapshot to every member.
            await writeMetadata(this, normalizeAssetMetadata({
              ...asset,
              group: null,
              updated_at: new Date().toISOString(),
            }));
          }
        }

        // Remove the group record only after asset work succeeds. A filesystem
        // failure therefore never leaves a removed group with stranded members.
        await withGroupRecords(this, cleanProjectId, (records) => {
          const record = findGroupRecord(records, storedName);
          if (record) records.splice(records.indexOf(record), 1);
        });

        return { success: true, name: storedName, deletedAssets: options.deleteAssets === true ? groupAssets.length : 0 };
      });
    },
    async updateGroupSettings(projectId, groupName, patch = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      return withGroupWriteLock(this, cleanProjectId, async () => {
        const name = normalizeGroupName(groupName);
        if (!name) throw assetStoreError("GROUP_NAME_REQUIRED", "Group name is required.");
        if (!Object.hasOwn(patch, "color")) throw assetStoreError("GROUP_PATCH_EMPTY", "No supported group settings were provided.");
        const color = normalizeGroupColor(patch.color);
        const records = await withGroupRecords(this, cleanProjectId, (current) => {
          const record = findGroupRecord(current, name);
          if (!record) throw assetStoreError("GROUP_NOT_FOUND", `Group not found: ${name}`);
          record.color = color;
        });
        const updated = findGroupRecord(records, name);
        return { name: updated.name, color: updated.color, position: updated.position };
      });
    },
    async assignAssetsToGroup(projectId, assetIds, groupName) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const ids = [...new Set((Array.isArray(assetIds) ? assetIds : []).map((id) => String(id || "").trim()).filter(Boolean))];
      if (!ids.length) throw assetStoreError("ASSET_IDS_REQUIRED", "assetIds must be a non-empty array.");
      const requested = normalizeGroupName(groupName);
      return withGroupWriteLock(this, cleanProjectId, async () => {
        const assets = await readProjectAssets(this, cleanProjectId);
        const byId = new Map(assets.map((asset) => [asset.id, asset]));
        let target = requested;
        if (target) {
          const records = await readGroupRecords(this, cleanProjectId);
          const existing = findGroupRecord(records, target);
          target = existing ? existing.name : target;
          if (!existing) {
            records.push({ name: target, color: "", position: records.length });
            await writeGroupRecords(this, cleanProjectId, records);
          }
        }
        const results = [];
        let failures = 0;
        const timestamp = new Date().toISOString();
        for (const assetId of ids) {
          const asset = byId.get(assetId);
          if (!asset) {
            failures += 1;
            results.push({ id: assetId, ok: false, code: "ASSET_NOT_FOUND", error: `Asset not found: ${assetId}` });
            continue;
          }
          if (String(asset.group || "").trim().toLocaleLowerCase() === target.toLocaleLowerCase()) {
            results.push({ id: assetId, group: target });
            continue;
          }
          // Group membership is organization, not a recipe revision — write the
          // metadata directly so a bulk move never fabricates recipe snapshots.
          await writeMetadata(this, normalizeAssetMetadata({
            ...asset,
            group: target,
            updated_at: timestamp,
          }));
          results.push({ id: assetId, group: target });
        }
        return { results, partial: failures > 0 };
      });
    },
    async mergeGroups(projectId, fromGroupName, intoGroupName) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      return withGroupWriteLock(this, cleanProjectId, async () => {
        const fromRequested = normalizeGroupName(fromGroupName);
        const intoRequested = normalizeGroupName(intoGroupName);
        if (!fromRequested || !intoRequested) throw assetStoreError("GROUP_NAME_REQUIRED", "Group name is required.");
        if (fromRequested.toLocaleLowerCase() === intoRequested.toLocaleLowerCase()) {
          throw assetStoreError("GROUP_MERGE_SAME", "A group cannot be merged into itself.");
        }
        const records = await readGroupRecords(this, cleanProjectId);
        const from = findGroupRecord(records, fromRequested);
        if (!from) throw assetStoreError("GROUP_NOT_FOUND", `Group not found: ${fromRequested}`);
        const into = findGroupRecord(records, intoRequested);
        if (!into) throw assetStoreError("GROUP_NOT_FOUND", `Group not found: ${intoRequested}`);

        const assets = await readProjectAssets(this, cleanProjectId);
        const members = assets.filter((asset) => (
          !asset.deleted_at
          && asset.group?.toLocaleLowerCase() === from.name.toLocaleLowerCase()
        ));
        const timestamp = new Date().toISOString();
        for (const asset of members) {
          await writeMetadata(this, normalizeAssetMetadata({ ...asset, group: into.name, updated_at: timestamp }));
        }
        await withGroupRecords(this, cleanProjectId, (current) => {
          const record = findGroupRecord(current, from.name);
          if (record) current.splice(current.indexOf(record), 1);
        });
        return { success: true, from: from.name, into: into.name, movedAssets: members.length };
      });
    },
    async reorderGroups(projectId, names) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      return withGroupWriteLock(this, cleanProjectId, async () => {
        const ordered = (Array.isArray(names) ? names : []).map((name) => normalizeGroupName(name)).filter(Boolean);
        if (!ordered.length) throw assetStoreError("GROUP_NAME_REQUIRED", "Group order must be a non-empty array.");
        const records = await readGroupRecords(this, cleanProjectId);
        if (ordered.length !== records.length
          || new Set(ordered.map((name) => name.toLocaleLowerCase())).size !== records.length
          || records.some((record) => !ordered.some((candidate) => candidate.toLocaleLowerCase() === record.name.toLocaleLowerCase()))) {
          throw assetStoreError("GROUP_SET_MISMATCH", "Group order does not match the project's groups; reload and retry.");
        }
        const next = ordered.map((name, position) => {
          const record = findGroupRecord(records, name);
          return { ...record, position };
        });
        await writeGroupRecords(this, cleanProjectId, next);
        return { success: true, order: next.map((record) => record.name) };
      });
    },
    async getGroupStats(projectId, groupName) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const requested = normalizeGroupName(groupName);
      if (!requested) throw assetStoreError("GROUP_NAME_REQUIRED", "Group name is required.");
      const records = await readGroupRecords(this, cleanProjectId);
      const canonical = findGroupRecord(records, requested);
      if (!canonical) throw assetStoreError("GROUP_NOT_FOUND", `Group not found: ${requested}`);
      const assets = await readProjectAssets(this, cleanProjectId);
      const members = assets.filter((asset) => (
        !asset.deleted_at
        && !asset.archived
        && asset.group?.toLocaleLowerCase() === canonical.name.toLocaleLowerCase()
      ));
      const tally = (key) => {
        const counts = new Map();
        for (const member of members) {
          const value = String(key(member) || "").trim();
          if (value) counts.set(value, (counts.get(value) || 0) + 1);
        }
        return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 8);
      };
      const videos = members.filter((member) => member.media_kind === "video" || member.business_fields?.media_kind === "video").length;
      return {
        name: canonical.name,
        total: members.length,
        favorites: members.filter((member) => member.rating > 0 || member.favorite === true).length,
        videos,
        versionChildren: members.filter((member) => member.parent_asset_id).length,
        images: members.length - videos,
        categories: tally((member) => member.category),
        sources: tally((member) => canonicalAssetSourceType(member)),
        trashed: assets.filter((asset) => asset.deleted_at && asset.group?.toLocaleLowerCase() === canonical.name.toLocaleLowerCase()).length,
      };
    },
    /**
     * Looks up an asset by the SHA-256 of its bytes, archived entries included. Callers used to
     * do this by listing the whole project twice and scanning in memory; this reads the metadata
     * directory once and decorates only the match.
     */
    async findAssetByContentHash(projectId, contentHash) {
      const hash = String(contentHash || "");
      if (!hash) return null;
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const assets = await readProjectAssets(this, cleanProjectId);
      const match = pickContentHashMatch(assets.filter((asset) => !asset.deleted_at && asset.source?.content_sha256 === hash));
      if (!match) return null;
      return withRuntimeUrls(deriveChildAssetIds(assets).find((asset) => asset.id === match.id));
    },
    /**
     * Reference hard-linking support: the SQLite store returns the managed
     * original for identical content. The legacy JSON fallback never does —
     * it only serves libraries that have not completed the SQLite migration,
     * and those gain hard-linked references after migrating.
     */
    async findOriginalByContentHash() {
      return "";
    },
    async findAssetBySourcePath(projectId, sourcePath) {
      const path = String(sourcePath || "");
      if (!path) return null;
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      let assets;
      try {
        assets = await readProjectAssets(this, cleanProjectId);
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
      const resolvedPath = resolve(path);
      const match = pickContentHashMatch(assets.filter((asset) => {
        if (asset.deleted_at) return false;
        const candidate = asset.source?.path;
        return typeof candidate === "string" && candidate && resolve(candidate) === resolvedPath;
      }));
      if (!match) return null;
      return withRuntimeUrls(deriveChildAssetIds(assets).find((asset) => asset.id === match.id));
    },
    async findAssetByPixelHash(projectId, pixelHash) {
      const hash = String(pixelHash || "");
      if (!hash) return null;
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const assets = await readProjectAssets(this, cleanProjectId);
      const match = pickContentHashMatch(assets.filter((asset) => !asset.deleted_at && asset.source?.pixel_sha256 === hash
        && asset.source?.pixel_hash_version === PIXEL_HASH_VERSION));
      if (!match) return null;
      return withRuntimeUrls(deriveChildAssetIds(assets).find((asset) => asset.id === match.id));
    },
    async findAutomaticIngestSuppression(projectId = DEFAULT_PROJECT_ID, hashes = {}) {
      const cleanProjectId = await this.ensureProject(projectId);
      const normalized = normalizeSuppressionHashes(hashes);
      if (!normalized.content_sha256 && !normalized.pixel_sha256) return null;
      const records = await readAutomaticIngestSuppressions(this, cleanProjectId);
      return records.find((record) => suppressionMatches(record, normalized)) || null;
    },
    async listAutomaticIngestSuppressions(projectId = DEFAULT_PROJECT_ID) {
      const cleanProjectId = await this.ensureProject(projectId);
      return readAutomaticIngestSuppressions(this, cleanProjectId);
    },
    async clearAutomaticIngestSuppression(projectId = DEFAULT_PROJECT_ID, hashes = {}) {
      const cleanProjectId = await this.ensureProject(projectId);
      const normalized = normalizeSuppressionHashes(hashes);
      if (!normalized.content_sha256 && !normalized.pixel_sha256) return 0;
      return withSuppressionWriteLock(this, cleanProjectId, async () => {
        const records = await readAutomaticIngestSuppressions(this, cleanProjectId);
        const remaining = records.filter((record) => !suppressionMatches(record, normalized));
        if (remaining.length !== records.length) await writeAutomaticIngestSuppressions(this, cleanProjectId, remaining);
        return records.length - remaining.length;
      });
    },
    async recordAutomaticIngestSuppression(projectId = DEFAULT_PROJECT_ID, record = {}) {
      const cleanProjectId = await this.ensureProject(projectId);
      const normalized = normalizeSuppressionRecord({ ...record, project_id: cleanProjectId });
      if (!normalized.content_sha256 && !normalized.pixel_sha256) return null;
      return withSuppressionWriteLock(this, cleanProjectId, async () => {
        const records = await readAutomaticIngestSuppressions(this, cleanProjectId);
        const existing = records.find((item) => item.content_sha256 === normalized.content_sha256
          && item.pixel_sha256 === normalized.pixel_sha256);
        const next = existing
          ? records.map((item) => item === existing ? normalized : item)
          : [...records, normalized];
        await writeAutomaticIngestSuppressions(this, cleanProjectId, next);
        return normalized;
      });
    },
    async getAsset(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const asset = await readAssetMetadata(this, cleanProjectId, cleanAssetId);
      const projectAssets = await readProjectAssets(this, cleanProjectId);
      const assets = deriveChildAssetIds([
        ...projectAssets.filter((item) => item.id !== cleanAssetId),
        asset,
      ]);
      return withRuntimeUrls(assets.find((item) => item.id === cleanAssetId));
    },
    async createAsset(input = {}, context = {}) {
      const projectId = await this.ensureProject(input.projectId || DEFAULT_PROJECT_ID);
      const { sourcePath, readablePath } = await resolveReadableImagePath(this, input.imagePath, context?.trustedSourceRoots);
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

      const codexSource = await codexSourceMetadata(this, readablePath);
      const originalName = sanitizeFileName(input.asset || input.fileName || basename(sourcePath));
      const assetId = sanitizeId(input.assetId || `${slugName(originalName)}-${shortStamp()}`, "asset");
      const parentAssetId = normalizeParentAssetId(input.parent_asset_id ?? input.parentAssetId);
      const lockPath = join(this.metadataDir(projectId), `.${assetId}.create.lock`);
      const assetLock = await acquireStoreFileLock(lockPath);
      try {
        try {
          await lstat(join(this.metadataDir(projectId), `${assetId}.json`));
          throw assetAlreadyExistsError(assetId);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        const projectAssets = await readProjectAssets(this, projectId);
        if (projectAssets.some((asset) => asset.id === assetId)) throw assetAlreadyExistsError(assetId);
        await assertJsonVersionParent(this, projectId, assetId, parentAssetId, projectAssets);
        const versionChange = parentAssetId && !context?.allowMissingVersionChange
          ? requireVersionChange(input)
          : String(input.version_change ?? input.changeSummary ?? "").trim();
        const imageName = await uniqueFileName(this.imagesDir(projectId), `${assetId}${extname(sourcePath) || extname(originalName) || ".png"}`);
        const imagePath = join(this.imagesDir(projectId), imageName);
        let storageMode;
        try {
          storageMode = codexSource ? await hardLinkOrCopy(readablePath, imagePath) : (await copyFile(readablePath, imagePath), "copy");
        } catch (error) {
          // A failed copy can leave a partially written managed file behind.
          await unlinkIfPresent(imagePath);
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

        const prompt = String(input.prompt || "").trim();
        const promptPath = join(this.promptsDir(projectId), `${assetId}.md`);
        try {
          await atomicWriteFile(promptPath, promptFileContent({ ...input, id: assetId }, prompt));
        } catch (error) {
          await unlinkIfPresent(imagePath);
          throw error;
        }

        const timestamp = new Date().toISOString();
        const metadata = appendRecipeSnapshot({}, normalizeAssetMetadata({
          ...input,
          id: assetId,
          project_id: projectId,
          asset: imageName,
          image_path: imagePath,
          prompt_path: promptPath,
          prompt,
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
          }
        }), {
          createdAt: input.created_at || timestamp,
          changeSummary: versionChange || "Initial recipe",
        });

        try {
          if (metadata.group) await resolveGroupAssignment(this, projectId, metadata);
        } catch (error) {
          await Promise.all([unlinkIfPresent(imagePath), unlinkIfPresent(promptPath)]);
          throw error;
        }

        if (context?.ingestMode === "automatic") {
          // JSON has no database transaction. Share the suppression write lock
          // with deleteAsset and recheck immediately before metadata becomes
          // visible, so a concurrent deletion cannot be bypassed.
          try {
            await withSuppressionWriteLock(this, projectId, async () => {
              const suppressions = await readAutomaticIngestSuppressions(this, projectId);
              if (suppressions.some((record) => suppressionMatches(record, {
                content_sha256: contentHash,
                pixel_sha256: pixelHash,
                pixel_hash_version: pixelHashVersion,
              }))) throw automaticImportSuppressedError();
              const currentAssets = await readProjectAssets(this, projectId);
              const duplicate = currentAssets.find((asset) =>
                asset.source?.content_sha256 === contentHash
                || (pixelHash
                  && asset.source?.pixel_sha256 === pixelHash
                  && (!pixelHashVersion || asset.source?.pixel_hash_version === pixelHashVersion)));
              if (duplicate) {
                throw automaticIngestDuplicateError(
                  duplicate.id,
                  duplicate.source?.content_sha256 === contentHash ? "content" : "pixel",
                );
              }
              await writeMetadata(this, metadata);
            });
          } catch (error) {
            await Promise.all([unlinkIfPresent(imagePath), unlinkIfPresent(promptPath)]);
            throw error;
          }
        } else {
          // Keep a manual re-import's metadata and suppression removal under the
          // same lock. If the suppression file cannot be updated, remove the
          // just-written metadata and managed copies instead of reporting a
          // failed import that nevertheless remains in the library.
          const metadataPath = join(this.metadataDir(projectId), `${assetId}.json`);
          try {
            await withSuppressionWriteLock(this, projectId, async () => {
              const records = await readAutomaticIngestSuppressions(this, projectId);
              const remaining = records.filter((record) => !suppressionMatches(record, {
                content_sha256: contentHash,
                pixel_sha256: pixelHash,
                pixel_hash_version: pixelHashVersion,
              }));
              let metadataWritten = false;
              try {
                await writeMetadata(this, metadata);
                metadataWritten = true;
                if (remaining.length !== records.length) {
                  await writeAutomaticIngestSuppressions(this, projectId, remaining);
                }
              } catch (error) {
                if (metadataWritten) await unlinkIfPresent(metadataPath);
                throw error;
              }
            });
          } catch (error) {
            await Promise.all([unlinkIfPresent(imagePath), unlinkIfPresent(promptPath)]);
            throw error;
          }
        }
        return withRuntimeUrls(metadata);
      } finally {
        await assetLock.handle.close().catch(() => {});
        await releaseStoreFileLock(lockPath, assetLock.token);
      }
    },
    async migrateCodexAssetsToHardLinks(projectId = DEFAULT_PROJECT_ID) {
      return relinkCodexAssets(this, await this.ensureProject(projectId));
    },
    async updateMetadata(projectId, assetId, patch = {}) {
      assertMutableVersionPatch(patch);
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      return withAssetWriteLock(this, cleanProjectId, cleanAssetId, async () => {
        const current = await this.getAsset(cleanProjectId, cleanAssetId);
        const prompt = Object.hasOwn(patch, "prompt") ? String(patch.prompt || "").trim() : current.prompt;
        const next = appendRecipeSnapshot(current, normalizeAssetMetadata({
          ...current,
          ...patch,
          id: current.id,
          project_id: current.project_id,
          asset: current.asset,
          image_path: current.image_path,
          prompt_path: current.prompt_path,
          prompt,
          business_fields: parseBusinessFields(patch.business_fields ?? current.business_fields),
          source: patch.source && typeof patch.source === "object"
            ? { ...current.source, ...patch.source }
            : current.source,
          updated_at: new Date().toISOString()
        }), {
          changeSummary: patch.recipe_change_summary || "Recipe updated",
        });
        if (next.group) await resolveGroupAssignment(this, next.project_id, next);
        await atomicWriteFile(next.prompt_path, promptFileContent(next, prompt));
        await writeMetadata(this, next);
        return withRuntimeUrls(next);
      });
    },
    async updateCuration(projectId, assetId, input = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const curation = normalizeAssetCuration(input);
      return withAssetWriteLock(this, cleanProjectId, cleanAssetId, async () => {
        const current = await this.getAsset(cleanProjectId, cleanAssetId);
        const next = normalizeAssetMetadata({
          ...current,
          ...curation,
          id: current.id,
          project_id: current.project_id,
          asset: current.asset,
          image_path: current.image_path,
          prompt_path: current.prompt_path,
          updated_at: new Date().toISOString(),
        });
        await writeMetadata(this, next);
        return withRuntimeUrls(next);
      });
    },
    async replaceAssetMedia(projectId, assetId, input = {}, context = {}) {
      const cleanProjectId = await this.ensureProject(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const { sourcePath, readablePath } = await resolveReadableImagePath(this, input.imagePath || input.mediaPath, context?.trustedSourceRoots);
      return withAssetWriteLock(this, cleanProjectId, cleanAssetId, async () => {
        let nextPath = "";
        try {
          const current = await this.getAsset(cleanProjectId, cleanAssetId);
          const extension = extname(sourcePath) || extname(String(input.fileName || "")) || extname(current.asset) || ".png";
          const nextName = await uniqueFileName(this.imagesDir(cleanProjectId), `${cleanAssetId}-${shortStamp()}-${randomUUID().slice(0, 8)}${extension}`);
          nextPath = join(this.imagesDir(cleanProjectId), nextName);
          await copyFile(readablePath, nextPath);
          const contentHash = await sha256File(nextPath);
          const claimedHash = normalizeHash(input.content_sha256 || input.contentHash);
          if (claimedHash && claimedHash !== contentHash) {
            await unlinkIfPresent(nextPath);
            const error = new Error("Replacement media changed while GravityPort was importing it.");
            error.code = "SOURCE_CHANGED_DURING_IMPORT";
            throw error;
          }
          const pixelHash = normalizeHash(input.pixel_sha256 || input.pixelHash);
          const timestamp = new Date().toISOString();
          const next = appendRecipeSnapshot(current, normalizeAssetMetadata({
            ...current,
            id: current.id,
            project_id: current.project_id,
            asset: nextName,
            image_path: nextPath,
            prompt_path: current.prompt_path,
            prompt: Object.hasOwn(input, "prompt") ? String(input.prompt || "").trim() : current.prompt,
            business_fields: parseBusinessFields({
              ...(current.business_fields || {}),
              ...(input.business_fields && typeof input.business_fields === "object" ? input.business_fields : {}),
            }),
            source: {
              ...(current.source || {}),
              ...(input.source && typeof input.source === "object" ? input.source : {}),
              content_sha256: contentHash,
              pixel_sha256: pixelHash || null,
              pixel_hash_version: pixelHash ? String(input.pixel_hash_version || input.pixelHashVersion || PIXEL_HASH_VERSION) : null,
              storage_mode: "copy",
              copied_at: timestamp,
            },
            updated_at: timestamp,
          }), { changeSummary: "Capture media upgraded" });
          await writeMetadata(this, next);
          if (current.image_path && resolve(current.image_path) !== resolve(nextPath)) await unlinkIfPresent(current.image_path);
          return withRuntimeUrls(next);
        } catch (error) {
          if (nextPath) await unlinkIfPresent(nextPath);
          throw error;
        }
      });
    },
    async toggleFavorite(projectId, assetId) {
      const cleanProjectId = await this.ensureProject(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      return withAssetWriteLock(this, cleanProjectId, cleanAssetId, async () => {
        // Re-read only after owning the per-asset lock. Concurrent favorite
        // requests therefore observe each other's committed value instead of
        // both flipping the same stale snapshot. This legacy JSON path mirrors
        // SQLite's atomic toggle semantics as closely as the file store allows.
        const current = await readAssetMetadata(this, cleanProjectId, cleanAssetId);
        const next = normalizeAssetMetadata({
          ...current,
          favorite: !current.favorite,
          // Favorite is UI state, not a recipe revision. Preserve updated_at so
          // the gallery poller does not rebuild every card after a star click.
          updated_at: current.updated_at,
        });
        await writeMetadata(this, next);
        return withRuntimeUrls(next);
      });
    },
    async archiveAsset(projectId, assetId) {
      return this.updateMetadata(projectId, assetId, { archived: true });
    },
    async deleteAsset(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      return withAssetWriteLock(this, cleanProjectId, cleanAssetId, async () => {
        const asset = await readAssetMetadata(this, cleanProjectId, cleanAssetId);
        if (!asset.deleted_at) {
          const siblings = await readProjectAssets(this, cleanProjectId);
          const child = siblings.find((candidate) => candidate.parent_asset_id === cleanAssetId && !candidate.deleted_at);
          if (child) {
            throw assetStoreError(
              "VERSION_PARENT_HAS_CHILDREN",
              `Cannot move version parent ${cleanAssetId} to Trash; active child ${child.id} still depends on it.`,
            );
          }
        }
        const projectDir = this.projectDir(cleanProjectId);
        const managedPaths = [asset.image_path, asset.prompt_path]
          .filter((filePath) => filePath && isSafeChildPath(projectDir, resolve(filePath)))
          .map((filePath) => resolve(filePath));
        const { contentHash, pixelHash, pixelHashVersion } = await automaticSuppressionIdentityForAsset(asset, managedPaths);
        const deletedAt = asset.deleted_at || new Date().toISOString();
        await withSuppressionWriteLock(this, cleanProjectId, async () => {
          const previous = contentHash || pixelHash
            ? await readAutomaticIngestSuppressions(this, cleanProjectId)
            : null;
          if (previous) {
            const normalized = normalizeSuppressionRecord({
              project_id: cleanProjectId,
              content_sha256: contentHash,
              pixel_sha256: pixelHash,
              pixel_hash_version: pixelHashVersion,
              deleted_at: deletedAt,
              reason: "user-deleted",
            });
            const next = [
              ...previous.filter((item) => !(
                item.content_sha256 === normalized.content_sha256
                && item.pixel_sha256 === normalized.pixel_sha256
                && String(item.pixel_hash_version || "") === String(normalized.pixel_hash_version || "")
              )),
              normalized,
            ];
            await writeAutomaticIngestSuppressions(this, cleanProjectId, next);
          }
          try {
            if (!asset.deleted_at) {
              await writeMetadata(this, normalizeAssetMetadata({ ...asset, deleted_at: deletedAt, updated_at: deletedAt }));
            }
          } catch (error) {
            if (previous) await writeAutomaticIngestSuppressions(this, cleanProjectId, previous).catch(() => {});
            throw error;
          }
        });
        return { id: cleanAssetId, project_id: cleanProjectId, deleted: true, trashed: true, deleted_at: deletedAt };
      });
    },
    async restoreAsset(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      return withAssetWriteLock(this, cleanProjectId, cleanAssetId, async () => {
        const asset = await readAssetMetadata(this, cleanProjectId, cleanAssetId);
        if (!asset.deleted_at) return withRuntimeUrls(asset);
        const timestamp = new Date().toISOString();
        const restored = normalizeAssetMetadata({ ...asset, deleted_at: null, updated_at: timestamp });
        if (restored.group) await resolveGroupAssignment(this, cleanProjectId, restored);
        const projectDir = this.projectDir(cleanProjectId);
        const managedPaths = [asset.image_path, asset.prompt_path]
          .filter((filePath) => filePath && isSafeChildPath(projectDir, resolve(filePath)))
          .map((filePath) => resolve(filePath));
        const { contentHash, pixelHash, pixelHashVersion } = await automaticSuppressionIdentityForAsset(asset, managedPaths);
        await withSuppressionWriteLock(this, cleanProjectId, async () => {
          const previous = await readAutomaticIngestSuppressions(this, cleanProjectId);
          const next = previous.filter((item) => !(
            item.content_sha256 === contentHash
            && item.pixel_sha256 === pixelHash
            && String(item.pixel_hash_version || "") === String(pixelHashVersion || "")
          ));
          if (next.length !== previous.length) await writeAutomaticIngestSuppressions(this, cleanProjectId, next);
          try {
            await writeMetadata(this, restored);
          } catch (error) {
            if (next.length !== previous.length) await writeAutomaticIngestSuppressions(this, cleanProjectId, previous).catch(() => {});
            throw error;
          }
        });
        return withRuntimeUrls(restored);
      });
    },
    async permanentlyDeleteAsset(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      return withAssetWriteLock(this, cleanProjectId, cleanAssetId, async () => {
        const asset = await readAssetMetadata(this, cleanProjectId, cleanAssetId);
        if (!asset.deleted_at) throw assetStoreError("ASSET_NOT_TRASHED", "Only trashed assets can be permanently deleted.");
        const siblings = await readProjectAssets(this, cleanProjectId);
        const child = siblings.find((candidate) => candidate.parent_asset_id === cleanAssetId && candidate.id !== cleanAssetId);
        if (child) {
          throw assetStoreError(
            "VERSION_PARENT_HAS_CHILDREN",
            `Cannot permanently delete version parent ${cleanAssetId}; it has child versions (e.g. ${child.id}).`,
          );
        }
        const metadataPath = join(this.metadataDir(cleanProjectId), `${cleanAssetId}.json`);
        const projectDir = this.projectDir(cleanProjectId);
        const managedPaths = [asset.image_path, asset.prompt_path]
          .filter((filePath) => filePath && isSafeChildPath(projectDir, resolve(filePath)))
          .map((filePath) => resolve(filePath));
        const contentHash = await contentHashForAsset(asset, managedPaths);
        const pixelHash = normalizeHash(asset.source?.pixel_sha256);
        const pixelHashVersion = pixelHash ? String(asset.source?.pixel_hash_version || PIXEL_HASH_VERSION) : "";
        let staged;
        try {
          staged = await stageFilesForPermanentDeletion(projectDir, managedPaths);
        } catch (error) {
          throw assetStoreError("ASSET_FILE_BUSY", `Asset files are still in use: ${error?.message || error}`);
        }
        const previousSuppressions = await readAutomaticIngestSuppressions(this, cleanProjectId);
        const previousEvents = await readJsonArray(this.generationEventsFile(cleanProjectId));
        const previousRelations = await readJsonArray(this.generationRelationsFile(cleanProjectId));
        const previousCandidates = await readJsonArray(this.generationRelationCandidatesFile(cleanProjectId));
        const removedEventIds = new Set(previousEvents
          .filter((event) => event?.output_asset_id === cleanAssetId)
          .map((event) => String(event?.id || ""))
          .filter(Boolean));
        const nextEvents = previousEvents.filter((event) => !removedEventIds.has(String(event?.id || "")));
        const nextRelations = previousRelations.filter((relation) => (
          !removedEventIds.has(String(relation?.child_generation_id || ""))
          && !removedEventIds.has(String(relation?.parent_generation_id || ""))
        ));
        const nextCandidates = previousCandidates.filter((candidate) => (
          !removedEventIds.has(String(candidate?.child_generation_id || ""))
          && !removedEventIds.has(String(candidate?.parent_generation_id || ""))
        ));
        let nextSuppressions = previousSuppressions;
        if (contentHash || pixelHash) {
          const normalized = normalizeSuppressionRecord({
            project_id: cleanProjectId,
            content_sha256: contentHash,
            pixel_sha256: pixelHash,
            pixel_hash_version: pixelHashVersion,
            deleted_at: new Date().toISOString(),
            reason: "user-deleted",
          });
          nextSuppressions = [...previousSuppressions.filter((item) => !(item.content_sha256 === normalized.content_sha256
            && item.pixel_sha256 === normalized.pixel_sha256
            && String(item.pixel_hash_version || "") === String(normalized.pixel_hash_version || ""))), normalized];
        }
        try {
          await withSuppressionWriteLock(this, cleanProjectId, async () => withGenerationHistoryLock(this, cleanProjectId, async () => {
            await Promise.all([
              writeAutomaticIngestSuppressions(this, cleanProjectId, nextSuppressions),
              atomicWriteFile(this.generationEventsFile(cleanProjectId), `${JSON.stringify(nextEvents, null, 2)}\n`),
              atomicWriteFile(this.generationRelationsFile(cleanProjectId), `${JSON.stringify(nextRelations, null, 2)}\n`),
              atomicWriteFile(this.generationRelationCandidatesFile(cleanProjectId), `${JSON.stringify(nextCandidates, null, 2)}\n`),
            ]);
            await unlinkIfPresent(metadataPath);
          }));
        } catch (error) {
          await Promise.allSettled([
            writeAutomaticIngestSuppressions(this, cleanProjectId, previousSuppressions),
            atomicWriteFile(this.generationEventsFile(cleanProjectId), `${JSON.stringify(previousEvents, null, 2)}\n`),
            atomicWriteFile(this.generationRelationsFile(cleanProjectId), `${JSON.stringify(previousRelations, null, 2)}\n`),
            atomicWriteFile(this.generationRelationCandidatesFile(cleanProjectId), `${JSON.stringify(previousCandidates, null, 2)}\n`),
          ]);
          await staged.rollback();
          throw error;
        }
        const cleanupComplete = await staged.commit();
        return { id: cleanAssetId, project_id: cleanProjectId, deleted: true, permanent: true, cleanupPending: !cleanupComplete };
      });
    },
    async purgeExpiredTrash({ nowMs = Date.now(), retentionMs = TRASH_RETENTION_MS } = {}) {
      const cutoff = nowMs - Math.max(0, Number(retentionMs) || TRASH_RETENTION_MS);
      const rows = [];
      for (const projectId of await this.listProjects()) {
        for (const asset of await readProjectAssets(this, projectId)) {
          if (asset.deleted_at && Date.parse(asset.deleted_at) <= cutoff) rows.push(asset);
        }
      }
      let removed = 0;
      const removedProjects = new Set();
      let pending = [...rows];
      while (pending.length) {
        const retry = [];
        let progress = 0;
        for (const asset of pending) {
          try { await this.permanentlyDeleteAsset(asset.project_id, asset.id); removed += 1; removedProjects.add(asset.project_id); progress += 1; }
          catch { retry.push(asset); }
        }
        if (!progress) { pending = retry; break; }
        pending = retry;
      }
      return { due: rows.length, removed, failed: pending.length, projects: [...removedProjects], nextCursor: null };
    },
    async cleanupPermanentDeletionStaging() {
      let removed = 0;
      let failed = 0;
      for (const projectId of await this.listProjects()) {
        const result = await cleanupPermanentDeletionStaging(this.projectDir(projectId));
        removed += result.removed;
        failed += result.failed;
      }
      return { removed, failed };
    },
    async emptyTrash(projectId = DEFAULT_PROJECT_ID) {
      const cleanProjectId = sanitizeProjectId(projectId);
      const rows = (await readProjectAssets(this, cleanProjectId)).filter((asset) => asset.deleted_at);
      let removed = 0;
      let pending = rows.map((asset) => ({ asset, error: null }));
      while (pending.length) {
        const retry = [];
        let progress = 0;
        for (const entry of pending) {
          try { await this.permanentlyDeleteAsset(cleanProjectId, entry.asset.id); removed += 1; progress += 1; }
          catch (error) { retry.push({ asset: entry.asset, error }); }
        }
        if (!progress) { pending = retry; break; }
        pending = retry;
      }
      const failed = pending.map(({ asset, error }) => ({ id: asset.id, code: error?.code || "PERMANENT_DELETE_FAILED", error: error instanceof Error ? error.message : String(error) }));
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
      const current = await this.getAsset(projectId, assetId);
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
    },
    async getAssetVersionHistory(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const selectedAsset = await readAssetMetadata(this, cleanProjectId, cleanAssetId);
      const projectAssets = await readProjectAssets(this, cleanProjectId);
      const assets = deriveChildAssetIds([
        ...projectAssets.filter((item) => item.id !== cleanAssetId),
        selectedAsset,
      ]).map(withRuntimeUrls);
      const foreignProjectsByAssetId = await findForeignVersionParents(this, cleanProjectId, assets);
      return buildAssetVersionHistory({
        projectId: cleanProjectId,
        selectedAssetId: cleanAssetId,
        assets,
        foreignProjectsByAssetId,
      });
    },
    async getRecipeSnapshotHistory(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      return recipeHistory(await readAssetMetadata(this, cleanProjectId, cleanAssetId));
    },
    async recordGenerationEvent(input = {}) {
      const event = normalizeGenerationEvent(input);
      await readAssetMetadata(this, event.project_id, event.output_asset_id);
      return withGenerationHistoryLock(this, event.project_id, async () => {
        const events = await readJsonArray(this.generationEventsFile(event.project_id));
        const index = events.findIndex((item) => item?.id === event.id);
        // Same field-level merge as the SQLite store: replays of an archived
        // capture (empty prompt/model, not-available status) must not erase
        // what a live capture recorded.
        const storedEvent = index >= 0 ? mergeGenerationEventForUpdate(events[index], event) : event;
        const next = index >= 0
          ? events.map((item, itemIndex) => itemIndex === index ? storedEvent : item)
          : [...events, storedEvent];
        await atomicWriteFile(this.generationEventsFile(event.project_id), `${JSON.stringify(next, null, 2)}\n`);
        const relations = await readJsonArray(this.generationRelationsFile(event.project_id));
        const candidates = await readJsonArray(this.generationRelationCandidatesFile(event.project_id));
        const nextCandidates = resolveGenerationRelationCandidates({
          projectId: event.project_id,
          events: next,
          relations,
          candidates,
        });
        await atomicWriteFile(this.generationRelationCandidatesFile(event.project_id), `${JSON.stringify(nextCandidates, null, 2)}\n`);
        return storedEvent;
      });
    },
    async listGenerationEvents(projectId, filters = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const events = (await readJsonArray(this.generationEventsFile(cleanProjectId)))
        .filter((event) => !filters.assetId || event.output_asset_id === filters.assetId)
        .filter((event) => !filters.captureContextId || event.capture_context_id === filters.captureContextId)
        .filter((event) => !filters.providerToolCallId || event.provider_tool_call_id === filters.providerToolCallId)
        .filter((event) => !filters.providerGenerationCallId || event.provider_generation_call_id === filters.providerGenerationCallId)
        .sort((left, right) => String(left.created_at || "").localeCompare(String(right.created_at || "")) || String(left.id || "").localeCompare(String(right.id || "")));
      const rawLimit = Number(filters.limit);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 251) : 0;
      const rawOffset = Number(filters.offset);
      const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
      return limit ? events.slice(offset, offset + limit) : events;
    },
    async listReferencedAttachmentIds(projectId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const [assets, events] = await Promise.all([
        readProjectAssets(this, cleanProjectId),
        readJsonArray(this.generationEventsFile(cleanProjectId)),
      ]);
      const ids = new Set();
      for (const owner of [...assets, ...events]) {
        for (const reference of Array.isArray(owner?.references) ? owner.references : []) {
          const id = String(reference?.reference_id || reference?.asset_id || "").trim();
          if (id) ids.add(id);
        }
      }
      return ids;
    },
    async recordGenerationRelation(input = {}) {
      const relation = normalizeGenerationRelation(input);
      return withGenerationHistoryLock(this, relation.project_id, async () => {
        const events = await readJsonArray(this.generationEventsFile(relation.project_id));
        const ids = new Set(events.map((event) => event?.id));
        if (!ids.has(relation.child_generation_id) || !ids.has(relation.parent_generation_id)) {
          throw generationHistoryError("Generation relation references a missing event.", "GENERATION_RELATION_EVENT_NOT_FOUND", 409);
        }
        const relations = await readJsonArray(this.generationRelationsFile(relation.project_id));
        assertGenerationRelationAcyclic(relation, relations);
        const key = generationRelationKey(relation);
        const index = relations.findIndex((item) => generationRelationKey(item) === key);
        const storedRelation = index >= 0 ? preserveTrustedGenerationRelation(relations[index], relation) : relation;
        const next = index >= 0
          ? relations.map((item, itemIndex) => itemIndex === index ? storedRelation : item)
          : [...relations, storedRelation];
        await atomicWriteFile(this.generationRelationsFile(relation.project_id), `${JSON.stringify(next, null, 2)}\n`);
        const candidates = await readJsonArray(this.generationRelationCandidatesFile(relation.project_id));
        const pairKey = generationCandidatePairKey(relation);
        const nextCandidates = candidates.map((candidate) => (
          generationCandidatePairKey(candidate) === pairKey
            ? normalizeGenerationRelationCandidate({ ...candidate, status: "confirmed", updated_at: new Date().toISOString() })
            : candidate
        ));
        await atomicWriteFile(this.generationRelationCandidatesFile(relation.project_id), `${JSON.stringify(nextCandidates, null, 2)}\n`);
        return storedRelation;
      });
    },
    async updateGenerationRelationCandidate(input = {}) {
      const projectId = sanitizeProjectId(input.project_id || input.projectId || DEFAULT_PROJECT_ID);
      const childGenerationId = String(input.child_generation_id || input.childGenerationId || "").trim();
      const parentGenerationId = String(input.parent_generation_id || input.parentGenerationId || "").trim();
      if (!childGenerationId || !parentGenerationId) {
        throw generationHistoryError("Generation relation candidate requires child and parent generation IDs.", "GENERATION_RELATION_CANDIDATE_IDS_REQUIRED");
      }
      return withGenerationHistoryLock(this, projectId, async () => {
        const candidates = await readJsonArray(this.generationRelationCandidatesFile(projectId));
        const pairKey = generationCandidatePairKey({ child_generation_id: childGenerationId, parent_generation_id: parentGenerationId });
        const index = candidates.findIndex((item) => generationCandidatePairKey(item) === pairKey);
        if (index < 0) {
          throw generationHistoryError("Generation relation candidate was not found.", "GENERATION_RELATION_CANDIDATE_NOT_FOUND", 404);
        }
        const existing = normalizeGenerationRelationCandidate(candidates[index]);
        const updated = normalizeGenerationRelationCandidate({
          ...existing,
          status: input.status || existing.status,
          created_at: existing.created_at,
          updated_at: new Date().toISOString(),
        });
        const next = candidates.map((item, itemIndex) => itemIndex === index ? updated : item);
        await atomicWriteFile(this.generationRelationCandidatesFile(projectId), `${JSON.stringify(next, null, 2)}\n`);
        return updated;
      });
    },
    async deleteGenerationRelation(input = {}) {
      const relation = normalizeGenerationRelation(input);
      return withGenerationHistoryLock(this, relation.project_id, async () => {
        const relations = await readJsonArray(this.generationRelationsFile(relation.project_id));
        const key = generationRelationKey(relation);
        const index = relations.findIndex((item) => generationRelationKey(item) === key);
        const existing = index >= 0 ? relations[index] : null;
        assertGenerationRelationUserMutable(existing);
        const next = relations.filter((_, itemIndex) => itemIndex !== index);
        await atomicWriteFile(this.generationRelationsFile(relation.project_id), `${JSON.stringify(next, null, 2)}\n`);
        const candidates = await readJsonArray(this.generationRelationCandidatesFile(relation.project_id));
        const pairKey = generationCandidatePairKey(relation);
        const nextCandidates = candidates.map((candidate) => (
          generationCandidatePairKey(candidate) === pairKey
            ? normalizeGenerationRelationCandidate({ ...candidate, status: "dismissed", updated_at: new Date().toISOString() })
            : candidate
        ));
        await atomicWriteFile(this.generationRelationCandidatesFile(relation.project_id), `${JSON.stringify(nextCandidates, null, 2)}\n`);
        return existing;
      });
    },
    async updateGenerationRelation(input = {}) {
      const relation = normalizeGenerationRelation(input);
      const previousRelationType = String(input.previous_relation_type || input.previousRelationType || relation.relation_type).trim();
      return withGenerationHistoryLock(this, relation.project_id, async () => {
        const events = await readJsonArray(this.generationEventsFile(relation.project_id));
        const ids = new Set(events.map((event) => event?.id));
        if (!ids.has(relation.child_generation_id) || !ids.has(relation.parent_generation_id)) {
          throw generationHistoryError("Generation relation references a missing event.", "GENERATION_RELATION_EVENT_NOT_FOUND", 409);
        }
        const relations = await readJsonArray(this.generationRelationsFile(relation.project_id));
        const existingIndex = relations.findIndex((item) => (
          item?.child_generation_id === relation.child_generation_id
          && item?.parent_generation_id === relation.parent_generation_id
          && item?.relation_type === previousRelationType
        ));
        const existing = existingIndex >= 0 ? relations[existingIndex] : null;
        assertGenerationRelationUserMutable(existing);
        const withoutExisting = relations.filter((_, itemIndex) => itemIndex !== existingIndex);
        assertGenerationRelationAcyclic(relation, withoutExisting);
        const targetIndex = withoutExisting.findIndex((item) => generationRelationKey(item) === generationRelationKey(relation));
        if (targetIndex >= 0) assertGenerationRelationUserMutable(withoutExisting[targetIndex]);
        const next = targetIndex >= 0
          ? withoutExisting.map((item, itemIndex) => itemIndex === targetIndex ? relation : item)
          : [...withoutExisting, relation];
        await atomicWriteFile(this.generationRelationsFile(relation.project_id), `${JSON.stringify(next, null, 2)}\n`);
        return relation;
      });
    },
    async getGenerationLineage(projectId, generationId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      return buildGenerationLineage({
        projectId: cleanProjectId,
        selectedGenerationId: String(generationId || ""),
        events: await readJsonArray(this.generationEventsFile(cleanProjectId)),
        relations: await readJsonArray(this.generationRelationsFile(cleanProjectId)),
      });
    },
    async getAssetGenerationHistory(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      await readAssetMetadata(this, cleanProjectId, cleanAssetId);
      if (!existsSync(this.generationRelationCandidatesFile(cleanProjectId))) {
        await withGenerationHistoryLock(this, cleanProjectId, async () => {
          const events = await readJsonArray(this.generationEventsFile(cleanProjectId));
          const relations = await readJsonArray(this.generationRelationsFile(cleanProjectId));
          const candidates = resolveGenerationRelationCandidates({ projectId: cleanProjectId, events, relations, candidates: [] });
          await atomicWriteFile(this.generationRelationCandidatesFile(cleanProjectId), `${JSON.stringify(candidates, null, 2)}\n`);
        });
      }
      const history = buildAssetGenerationHistory({
        projectId: cleanProjectId,
        assetId: cleanAssetId,
        events: await readJsonArray(this.generationEventsFile(cleanProjectId)),
        relations: await readJsonArray(this.generationRelationsFile(cleanProjectId)),
        candidates: await readJsonArray(this.generationRelationCandidatesFile(cleanProjectId)),
      });
      const outputIds = new Set([...history.events, ...(history.context_events || [])].map((event) => event.output_asset_id).filter(Boolean));
      const outputAssets = (await readProjectAssets(this, cleanProjectId))
        .filter((asset) => outputIds.has(asset.id))
        .map(withRuntimeUrls);
      return { ...history, output_assets: outputAssets };
    },
    async assetFileInfo(projectId, fileName) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const safeName = sanitizeFileName(fileName);
      const fullPath = await resolveStoredAssetPath(this, cleanProjectId, safeName);
      const fileStat = await stat(fullPath);
      return { size: fileStat.size };
    },
    async assetReadStream(projectId, fileName, options = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const safeName = sanitizeFileName(fileName);
      const fullPath = await resolveStoredAssetPath(this, cleanProjectId, safeName);
      const streamOptions = Number.isSafeInteger(options.start) && Number.isSafeInteger(options.end)
        ? { start: options.start, end: options.end }
        : undefined;
      return createReadStream(fullPath, streamOptions);
    }
  };
}

export function mimeTypeForFile(filePath) {
  switch (extname(filePath).toLowerCase()) {
    case ".apng":
      return "image/apng";
    case ".avif":
      return "image/avif";
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    case ".mp4":
      return "video/mp4";
    case ".m4v":
      return "video/x-m4v";
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    default:
      return "application/octet-stream";
  }
}

function normalizeAssetMetadata(input) {
  const businessFields = parseBusinessFields(input.business_fields);
  return {
    id: sanitizeId(input.id, "asset"),
    project_id: sanitizeProjectId(input.project_id || input.projectId || DEFAULT_PROJECT_ID),
    asset: sanitizeFileName(input.asset),
    image_path: resolve(input.image_path),
    prompt_path: resolve(input.prompt_path),
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
    deleted_at: input.deleted_at ? String(input.deleted_at) : null,
    group: normalizeGroupName(input.group),
    category: String(input.category || ""),
    rating: Number.isFinite(input.rating) ? Math.min(5, Math.max(0, Math.round(input.rating))) : 0,
    parent_asset_id: normalizeParentAssetId(input.parent_asset_id ?? input.parentAssetId),
    version_change: String(input.version_change || input.changeSummary || ""),
    child_asset_ids: uniqueArray(input.child_asset_ids || []),
    created_at: normalizeCreatedAt(input.created_at, new Date().toISOString()),
    updated_at: input.updated_at || new Date().toISOString(),
    source: input.source && typeof input.source === "object" ? input.source : {}
  };
}

function withRuntimeUrls(asset) {
  const normalized = ensureRecipeSnapshots(asset);
  return {
    ...normalized,
    image_url: `/library/${encodeURIComponent(normalized.project_id)}/images/${encodeURIComponent(normalized.asset)}`,
    prompt_file: normalized.prompt_path
  };
}

/**
 * Duplicating an asset copies its bytes, so one content hash can legitimately match several
 * records. Both stores resolve that the same way: prefer an active asset over an archived one,
 * then the newest, using the comparator `listAssets` already sorts by.
 */
function pickContentHashMatch(matches) {
  return [...matches].sort((left, right) => Number(Boolean(left.archived)) - Number(Boolean(right.archived))
    || String(right.created_at || "").localeCompare(String(left.created_at || ""))
    || String(right.id || "").localeCompare(String(left.id || "")))[0] || null;
}

/**
 * Groups are stored as records ({ name, color, position }). Libraries written
 * by older builds hold a plain string array; it is upgraded transparently on
 * first read, with positions preserving the legacy presentation order.
 */
async function readGroupRecords(store, projectId) {
  try {
    const raw = await readFile(store.groupsFile(projectId), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const records = parsed.map((entry, index) => {
      if (entry && typeof entry === "object") {
        const name = normalizeGroupName(entry.name);
        return name
          ? { name, color: normalizeGroupColor(entry.color), position: Number.isFinite(entry.position) ? entry.position : 0 }
          : null;
      }
      const name = normalizeGroupName(entry);
      return name ? { name, color: "", position: index } : null;
    }).filter(Boolean);
    const seen = new Set();
    const unique = records.filter((record) => {
      const key = record.name.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // Positions are always a dense 0..n-1 sequence over the presentation order,
    // whether the file was just upgraded from strings or already held records.
    unique.sort((left, right) => left.position - right.position || left.name.localeCompare(right.name));
    unique.forEach((record, index) => { record.position = index; });
    return unique;
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function writeGroupRecords(store, projectId, records) {
  await atomicWriteFile(store.groupsFile(projectId), `${JSON.stringify(records, null, 2)}\n`);
}

/**
 * Read-modify-write over the group records. The caller must already hold
 * withGroupWriteLock — the file lock is not re-entrant.
 */
async function withGroupRecords(store, projectId, mutator) {
  const records = await readGroupRecords(store, projectId);
  await mutator(records);
  await writeGroupRecords(store, projectId, records);
  return records;
}

function findGroupRecord(records, name) {
  const key = normalizeGroupName(name).toLocaleLowerCase();
  return records.find((record) => record.name.toLocaleLowerCase() === key) || null;
}

/**
 * Aligns a metadata write's group assignment to the stored spelling before the
 * metadata file is persisted, creating the group record when the name is new.
 * Mirrors the SQLite store's canonicalGroupName: the sidebar count and the
 * facet filter must never see two spellings of one logical group.
 */
async function resolveGroupAssignment(store, projectId, metadata) {
  const normalized = normalizeGroupName(metadata.group);
  if (!normalized) {
    metadata.group = "";
    return;
  }
  await withGroupWriteLock(store, projectId, async () => {
    const records = await readGroupRecords(store, projectId);
    const existing = findGroupRecord(records, normalized);
    if (existing) {
      metadata.group = existing.name;
      return;
    }
    records.push({ name: normalized, color: "", position: records.length });
    await writeGroupRecords(store, projectId, records);
    metadata.group = normalized;
  });
}

function normalizeGroupName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

function normalizeGroupColor(value) {
  const color = String(value || "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : "";
}

/**
 * Mirrors the SQLite store: a cursor is only valid for the order that issued it,
 * so switching sorts restarts the query rather than resuming against the wrong key.
 */
function parseAssetCursor(value, sort, searchQuery = "") {
  try {
    const cursor = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (typeof cursor?.createdAt !== "string" || typeof cursor?.id !== "string") throw new Error();
    const cursorSort = normalizeAssetSort(cursor.sort);
    if (cursorSort !== normalizeAssetSort(sort)) throw new Error();
    if (cursorSort === "name" && typeof cursor.sortName !== "string") throw new Error();
    const normalizedQuery = normalizeAssetSearchQuery(searchQuery);
    if (normalizeAssetSearchQuery(cursor.searchQuery) !== normalizedQuery) throw new Error();
    if (normalizedQuery && !Number.isFinite(Number(cursor.searchScore))) throw new Error();
    return cursor;
  } catch {
    throw assetStoreError("INVALID_ASSET_CURSOR", "Invalid asset cursor.");
  }
}

/** Shapes a decoded cursor back into the minimal asset the secondary comparator needs. */
function cursorRow(cursor) {
  return { created_at: cursor.createdAt, id: cursor.id, theme: "", asset: cursor.sortName || "" };
}

async function unlinkIfPresent(filePath) {
  await unlink(filePath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function writeMetadata(store, metadata) {
  await store.ensureProject(metadata.project_id);
  await atomicWriteFile(join(store.metadataDir(metadata.project_id), `${metadata.id}.json`), `${JSON.stringify(metadata, null, 2)}\n`);
}

async function atomicWriteFile(targetPath, content) {
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, "utf8");
    const handle = await open(temporaryPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, targetPath);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
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

function normalizeHash(value) {
  const hash = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : "";
}

function normalizeSuppressionHashes(input = {}) {
  return {
    content_sha256: normalizeHash(input.content_sha256 ?? input.contentSha256),
    pixel_sha256: normalizeHash(input.pixel_sha256 ?? input.pixelSha256),
    pixel_hash_version: String(input.pixel_hash_version ?? input.pixelHashVersion ?? "").trim(),
  };
}

function normalizeSuppressionRecord(input = {}) {
  const hashes = normalizeSuppressionHashes(input);
  return {
    project_id: sanitizeProjectId(input.project_id || DEFAULT_PROJECT_ID),
    ...hashes,
    deleted_at: String(input.deleted_at || new Date().toISOString()),
    reason: String(input.reason || "user-deleted").trim().slice(0, 120) || "user-deleted",
  };
}

function suppressionMatches(record, hashes) {
  return Boolean(
    (hashes.content_sha256 && record.content_sha256 === hashes.content_sha256)
      || (hashes.pixel_sha256
        && record.pixel_sha256 === hashes.pixel_sha256
        && (!hashes.pixel_hash_version || record.pixel_hash_version === hashes.pixel_hash_version)),
  );
}

async function readAutomaticIngestSuppressions(store, projectId) {
  try {
    const parsed = JSON.parse(await readFile(store.automaticIngestSuppressionsFile(projectId), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((record) => normalizeSuppressionRecord({ ...record, project_id: projectId }))
      .filter((record) => record.content_sha256 || record.pixel_sha256);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function writeAutomaticIngestSuppressions(store, projectId, records) {
  await store.ensureProject(projectId);
  await atomicWriteFile(store.automaticIngestSuppressionsFile(projectId), `${JSON.stringify(records, null, 2)}\n`);
}

async function withSuppressionWriteLock(store, projectId, callback) {
  const lockPath = join(store.projectDir(projectId), ".automatic-ingest-suppressions.lock");
  const lock = await acquireStoreFileLock(lockPath);
  try {
    return await callback();
  } finally {
    await lock.handle.close().catch(() => {});
    await releaseStoreFileLock(lockPath, lock.token);
  }
}

async function contentHashForAsset(asset, managedPaths) {
  const recorded = normalizeHash(asset.source?.content_sha256);
  if (recorded) return recorded;
  const imagePath = resolve(String(asset.image_path || ""));
  if (!managedPaths.includes(imagePath)) return "";
  try {
    return await sha256File(imagePath);
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

async function withGroupWriteLock(store, projectId, callback) {
  const lockPath = join(store.projectDir(projectId), ".groups.lock");
  const lock = await acquireStoreFileLock(lockPath);
  try {
    return await callback();
  } finally {
    await lock.handle.close().catch(() => {});
    await releaseStoreFileLock(lockPath, lock.token);
  }
}

// Per-asset write serialization for the JSON fallback store. Every public
// read-modify-write of an asset's metadata runs inside this lock so a stale
// snapshot can never overwrite a concurrent lifecycle change (for example, a
// metadata PATCH resurrecting an asset that deleteAsset just moved to Trash).
// Lock ordering: this is always the OUTERMOST per-asset lock and may nest the
// group/suppression/generation locks inside. Group-lock holders must never
// call the public per-asset mutations; they write metadata inline from a
// snapshot taken under their own lock instead.
async function withAssetWriteLock(store, projectId, assetId, task) {
  const lockPath = join(store.metadataDir(projectId), `.${assetId}.write.lock`);
  const lock = await acquireStoreFileLock(lockPath);
  try {
    return await task();
  } finally {
    await lock.handle.close().catch(() => {});
    await releaseStoreFileLock(lockPath, lock.token);
  }
}

async function withGenerationHistoryLock(store, projectId, callback) {
  const lockPath = join(store.projectDir(projectId), ".generation-history.lock");
  const lock = await acquireStoreFileLock(lockPath);
  try {
    return await callback();
  } finally {
    await lock.handle.close().catch(() => {});
    await releaseStoreFileLock(lockPath, lock.token);
  }
}

async function readJsonArray(filePath) {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function generationRelationKey(value = {}) {
  return [value.project_id, value.child_generation_id, value.parent_generation_id, value.relation_type].map(String).join("\u0000");
}

async function acquireStoreFileLock(lockPath) {
  const deadline = Date.now() + STORE_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const handle = await open(lockPath, "wx");
      const token = randomUUID();
      try {
        await handle.writeFile(JSON.stringify({ token, pid: process.pid }));
        return { handle, token };
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
        throw error;
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await removeStaleStoreLock(lockPath);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
  }
  throw new Error("Timed out waiting for the asset store file lock.");
}

async function removeStaleStoreLock(lockPath) {
  const cleanupPath = `${lockPath}.cleanup`;
  if (!(await acquireStoreCleanupLock(cleanupPath))) return;
  try {
    const lock = await readStoreFileLock(lockPath);
    if (!lock || lock.ageMs <= STORE_LOCK_STALE_MS || isStoreLockOwnerAlive(lock.owner)) return;
    await releaseStoreFileLock(lockPath, lock.owner?.token);
  } finally {
    await rmdir(cleanupPath).catch(() => {});
  }
}

async function acquireStoreCleanupLock(cleanupPath) {
  try {
    await mkdir(cleanupPath);
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try {
      const cleanupStat = await stat(cleanupPath);
      if (Date.now() - cleanupStat.mtimeMs > STORE_CLEANUP_LOCK_STALE_MS) await rmdir(cleanupPath);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    }
    return false;
  }
}

async function releaseStoreFileLock(lockPath, token) {
  const lock = await readStoreFileLock(lockPath);
  if (!lock || lock.owner?.token !== token) return false;
  await unlink(lockPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  return true;
}

async function readStoreFileLock(lockPath) {
  try {
    const [raw, lockStat] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
    let owner = null;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.token === "string" && Number.isInteger(parsed?.pid)) owner = parsed;
    } catch {
      // Locks written by interrupted or older processes are recovered after the stale timeout.
    }
    return { owner, ageMs: Date.now() - lockStat.mtimeMs };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function isStoreLockOwnerAlive(owner) {
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readProjectAssets(store, projectId) {
  const directory = store.metadataDir(projectId);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const assets = [];
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".json") continue;
    const filePath = join(directory, entry.name);
    let raw = null;
    try {
      raw = await readFile(filePath, "utf8");
      assets.push(withCanonicalCreatedAt(JSON.parse(raw)));
    } catch (error) {
      await warnCorruptMetadata(store, projectId, filePath, error, raw);
    }
  }
  return assets;
}

/**
 * Presents `created_at` in its canonical ISO form on the way out, without touching the file.
 * Writes have been normalised since this store learned to do so, but records last written by an
 * older build keep whatever text they were saved with, and sorting plus cursor pagination still
 * compare those strings — so a legacy "Sat, 01 Jan 2000 00:00:00 GMT" would sort as if it were
 * newer than every ISO date. Canonicalising on read fixes their placement immediately; the file
 * itself is only rewritten when the asset is next edited, and unparseable text is left alone.
 */
function withCanonicalCreatedAt(asset) {
  const createdAt = normalizeCreatedAt(asset?.created_at, asset?.created_at);
  return createdAt === asset?.created_at ? asset : { ...asset, created_at: createdAt };
}

/**
 * Reports an unreadable metadata file at most once per store instance per file *revision*, because
 * the gallery re-scans the library on every refresh and a permanently corrupt file would otherwise
 * warn on every scan. The key is the hash of the bytes that failed to parse, so a file that is
 * repaired and later damaged again is still reported — even when the new damage happens to have
 * the same size and modification time as the old.
 *
 * The payload deliberately never forwards `error.message`: JSON parser messages quote the head
 * of the offending document (V8 renders `Unexpected token 'h', "hunter2 se"... is not valid
 * JSON`), which would leak prompts, tokens, or other private fields into logs.
 */
async function warnCorruptMetadata(store, projectId, filePath, error, raw) {
  if (!store.onWarning) return;
  let warnedRevisions = warnedMetadataPaths.get(store);
  if (!warnedRevisions) {
    warnedRevisions = new Set();
    warnedMetadataPaths.set(store, warnedRevisions);
  }
  const revision = await corruptMetadataRevision(filePath, raw);
  if (warnedRevisions.has(revision)) return;
  warnedRevisions.add(revision);
  try {
    Promise.resolve(store.onWarning({
      code: "CORRUPT_METADATA",
      projectId,
      filePath,
      message: `Failed to parse metadata JSON (${error?.name || "Error"})`,
    })).catch(() => {});
  } catch {
    // Warning sinks are observational only. A broken logger must not make a tolerant gallery scan
    // fail; rejected async sinks are handled by the attached catch without delaying the scan.
  }
}

async function corruptMetadataRevision(filePath, raw) {
  if (typeof raw === "string") return `${filePath}:sha256:${createHash("sha256").update(raw).digest("hex")}`;
  try {
    // The read itself failed, so there are no bytes to hash: fall back to the file's identity.
    const fileStat = await stat(filePath);
    return `${filePath}:${fileStat.size}:${fileStat.mtimeMs}`;
  } catch {
    // A file that vanished between the failed read and this stat can only be keyed by path.
    return filePath;
  }
}

async function readAssetMetadata(store, projectId, assetId) {
  try {
    return withCanonicalCreatedAt(JSON.parse(await readFile(join(store.metadataDir(projectId), `${assetId}.json`), "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") throw assetNotFoundError(assetId);
    throw error;
  }
}

function deriveChildAssetIds(assets) {
  const childrenByParent = new Map();
  for (const asset of assets) {
    if (!asset.parent_asset_id) continue;
    const children = childrenByParent.get(asset.parent_asset_id) || [];
    children.push(asset);
    childrenByParent.set(asset.parent_asset_id, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort((left, right) => String(left.created_at || "").localeCompare(String(right.created_at || "")) || String(left.id || "").localeCompare(String(right.id || "")));
  }
  return assets.map((asset) => ({ ...asset, child_asset_ids: (childrenByParent.get(asset.id) || []).map((child) => child.id) }));
}

async function assertJsonVersionParent(store, projectId, assetId, parentAssetId, projectAssets) {
  if (!parentAssetId) return;
  if (parentAssetId === assetId) throw assetStoreError("VERSION_CYCLE", `Asset cannot be its own version parent: ${assetId}`);
  if (projectAssets.some((asset) => asset.id === parentAssetId)) return;
  const foreign = await findAssetProjects(store, projectId, new Set([parentAssetId]));
  throw versionParentError(parentAssetId, foreign.get(parentAssetId));
}

async function findForeignVersionParents(store, projectId, assets) {
  const localIds = new Set(assets.map((asset) => asset.id));
  const missingParentIds = new Set(assets.map((asset) => asset.parent_asset_id).filter((id) => id && !localIds.has(id)));
  return findAssetProjects(store, projectId, missingParentIds);
}

async function findAssetProjects(store, projectId, assetIds) {
  const matches = new Map();
  if (!assetIds.size) return matches;
  for (const otherProjectId of await store.listProjects()) {
    if (otherProjectId === projectId) continue;
    for (const asset of await readProjectAssets(store, otherProjectId)) {
      if (!assetIds.has(asset.id)) continue;
      const projects = matches.get(asset.id) || [];
      projects.push(otherProjectId);
      matches.set(asset.id, projects);
    }
  }
  return matches;
}

function normalizeParentAssetId(value) {
  return value ? sanitizeId(value, "asset") : null;
}

async function uniqueFileName(directory, preferredName) {
  const safe = sanitizeFileName(preferredName);
  const extension = extname(safe);
  const base = safe.slice(0, safe.length - extension.length);
  for (let i = 0; i < 1000; i += 1) {
    const candidate = i === 0 ? safe : `${base}-${i + 1}${extension}`;
    try {
      await stat(join(directory, candidate));
    } catch (error) {
      if (error.code === "ENOENT") return candidate;
      throw error;
    }
  }
  throw new Error(`Could not create unique filename for ${preferredName}`);
}

async function hardLinkOrCopy(sourcePath, targetPath) {
  try {
    await link(sourcePath, targetPath);
    return "hard-link";
  } catch (error) {
    // Hard links require the source and target to be on the same filesystem.
    // Keep the old copy behavior as a safe fallback for external volumes.
    if (!["EXDEV", "EPERM", "EOPNOTSUPP", "ENOTSUP", "EMLINK"].includes(error?.code)) throw error;
    await copyFile(sourcePath, targetPath);
    return "copy";
  }
}

function promptFileContent(input, prompt) {
  const header = [
    "---",
    promptHeaderField("asset_id", input.id),
    promptHeaderField("skill", input.skill),
    promptHeaderField("style", input.style),
    promptHeaderField("ratio", input.ratio),
    promptHeaderField("theme", input.theme),
    "---",
    ""
  ].join("\n");
  return `${header}${prompt || ""}\n`;
}

function promptHeaderField(key, value) {
  const text = String(value || "");
  return text ? `${key}: ${text}` : `${key}:`;
}

function parseBusinessFields(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sanitizeProjectId(value) {
  return sanitizeId(value || DEFAULT_PROJECT_ID, DEFAULT_PROJECT_ID);
}

function sanitizeId(value, fallback) {
  return String(value || fallback)
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || fallback;
}

function sanitizeFileName(value) {
  const raw = basename(String(value || "asset.png"));
  const extension = extname(raw) || ".png";
  const base = raw
    .slice(0, raw.length - extname(raw).length)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "asset"}${extension}`;
}

function slugName(value) {
  return sanitizeId(String(value || "asset").replace(/\.[^.]+$/, ""), "asset").slice(0, 56);
}

function shortStamp() {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function uniqueArray(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map(String))];
}

function resolveRequiredPath(value, label) {
  if (!value || typeof value !== "string") throw assetStoreError("IMAGE_PATH_REQUIRED", `${label} is required.`);
  return resolve(value);
}

async function resolveReadableImagePath(store, value, trustedSourceRoots = []) {
  const requestedPath = resolveRequiredPath(value, "imagePath");
  if (!MEDIA_EXTENSIONS.has(extname(requestedPath).toLowerCase())) {
    throw assetStoreError("IMAGE_PATH_UNSUPPORTED_TYPE", `Unsupported media type: ${requestedPath}`);
  }

  // Messages are unchanged; only the machine-readable code is new, so the import
  // form can attribute each rejection to the path field.
  const requestedStat = await statForImport(requestedPath);
  if (requestedStat.isSymbolicLink()) throw assetStoreError("IMAGE_PATH_NOT_READABLE", `Refusing to import symbolic links: ${requestedPath}`);
  if (!requestedStat.isFile()) throw assetStoreError("IMAGE_PATH_NOT_READABLE", `imagePath is not a file: ${requestedPath}`);

  const readablePath = await realpath(requestedPath);
  await assertWithinReadableProject(store, readablePath, trustedSourceRoots);
  return { sourcePath: requestedPath, readablePath };
}

async function resolveStoredAssetPath(store, projectId, fileName) {
  const imagesDir = store.imagesDir(projectId);
  const requestedPath = join(imagesDir, fileName);
  if (!isSafeChildPath(imagesDir, requestedPath)) throw new Error("Unsafe asset path.");

  const requestedStat = await lstat(requestedPath);
  if (requestedStat.isSymbolicLink() || !requestedStat.isFile()) throw new Error("Unsafe asset path.");

  const [imagesRoot, assetPath] = await Promise.all([realpath(imagesDir), realpath(requestedPath)]);
  if (!isSafeChildPath(imagesRoot, assetPath)) throw new Error("Unsafe asset path.");
  return assetPath;
}

async function assertWithinReadableProject(store, filePath, trustedSourceRoots = []) {
  const allowedRoots = [
    store.projectRoot,
    store.generatedImagesDir,
    store.codexImagesDir,
    store.assetsRoot,
    store.cowartPageAssetsDir,
    ...(Array.isArray(trustedSourceRoots) ? trustedSourceRoots : []),
  ].filter((root) => typeof root === "string" && root);
  const resolvedRoots = (await Promise.all(allowedRoots.map(async (root) => {
    try {
      return await realpath(root);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }))).filter(Boolean);
  if (!resolvedRoots.some((root) => filePath === root || isSafeChildPath(root, filePath))) {
    throw assetStoreError("IMAGE_PATH_NOT_READABLE", `Refusing to import outside the project roots: ${filePath}`);
  }
}

/** A missing file is an ordinary form mistake, not a 500. */
async function statForImport(requestedPath) {
  try {
    return await lstat(requestedPath);
  } catch (error) {
    if (error?.code === "ENOENT") throw assetStoreError("IMAGE_PATH_NOT_FOUND", `imagePath does not exist: ${requestedPath}`);
    throw error;
  }
}

function isSafeChildPath(parent, child) {
  return isPathInside(parent, child);
}

async function codexSourceMetadata(store, filePath) {
  const configuredRoot = resolve(store.codexImagesDir);
  let root;
  try {
    root = await realpath(configuredRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!isSafeChildPath(root, filePath)) return null;

  const relativePath = relative(root, filePath).split(sep).join("/");
  const [taskId] = relativePath.split("/");
  return {
    codex_generated_images_root: configuredRoot,
    codex_task_id: taskId || null,
    codex_relative_path: relativePath
  };
}
