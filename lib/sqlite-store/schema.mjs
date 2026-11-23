// Database open, schema table creation, and the schema upgrade scheduler for the SQLite store (task 445). Pure moves; no behavior changes.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createdAtTimestamp, normalizeCreatedAt } from "../recent-window.js";
import { ensureGenerationMessageBindingSchema } from "../generation-message-binding.mjs";
import { buildRecipeSnapshot } from "../recipe-snapshot.js";
import { assetSortName } from "../asset-sort.js";
import { assetMatchesSearchKind } from "../asset-search.mjs";
import { markPendingSchemaUpgradeVerify } from "../schema-upgrade-verify.mjs";
import { maybeKillSchemaUpgradeTestProcess } from "../schema-backup-cleanup.mjs";
import { canonicalSourceTypeOf, generationSessionKey } from "../generation-session.mjs";
import { assetFileNameStem, searchableAssetName, searchableBusinessObjectText, searchableSourceObjectText } from "../asset-search-scope.mjs";
import { backfillRecipeSnapshots, saveAsset } from "./asset-records.mjs";
import { syncSqliteGenerationRelationCandidates } from "./generation-rows.mjs";
import { normalizeAssetMetadata } from "./metadata.mjs";
import { parseJson } from "./rows-util.mjs";
import { migrateSearchIndexToDocIds } from "./search-index.mjs";
import { shortUnicodeSearchTerms } from "./search-sql.mjs";
import { backfillAutoSessionStacks, regroupJimengWorkspaceStacks } from "./stacks.mjs";
import { mediaKindOf, now } from "./util.mjs";
import { ensureAssetCanvasStateTable, ensureAssetPaletteColumn, ensureAssetStackOrderLocked, ensureAssetStackSortColumns, ensureAutoStackStructures, ensureCreatedAtEpoch, ensureGenerationEventColumns, ensureGenerationSessionColumn, ensureGroupColumns, ensureLearningLibraryTables, ensureMediumPathColumn, ensurePixelHashColumn, ensureSearchScalarColumns, ensureSortName, ensureSourcePathColumn, ensureSuppressionPixelHashVersion, ensureTrashColumn, ensureWebCaptureLookupColumns } from "./schema-passes.mjs";

// Task 430: v19 adds asset_canvas_state (final/marks/card positions).
// Task 459: v20 adds learning_libraries + learning_library_members.
export const CURRENT_SCHEMA_VERSION = 20;

/**
 * Task 350 (audit 5-2 #7): the fixed error for a library newer than this
 * build. The desktop maps MOSA_LIBRARY_SCHEMA_NEWER to its own dialog
 * (desktop/notification-i18n.mjs); MCP and CLI surface the message, which
 * itself says what to do.
 */
export function newerSchemaLibraryError(existingVersion, libraryDir) {
  const error = new Error(
    `This library was last opened by a newer version of GravityPort (database schema v${existingVersion}, this build supports v${CURRENT_SCHEMA_VERSION}). `
    + "Please download the latest GravityPort to open it. Your assets were not modified.",
  );
  error.code = "MOSA_LIBRARY_SCHEMA_NEWER";
  error.libraryDir = resolve(libraryDir);
  error.schemaVersion = existingVersion;
  return error;
}

export function openDatabase(databasePath) {
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

export function initializeSchema(database, { upgrade = null, libraryDir = "" } = {}) {
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
  ensureLearningLibraryTables(database);
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
export function cleanupOrphanedTrashFtsRows(database, timestamp) {
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
export async function repairArchivedAssetsToTrash(database, helpers = {}) {
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
