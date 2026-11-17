// Schema ensure passes (missing columns and indexes) and derived-column markers for SQLite store (task 427). Pure moves; no behavior changes.
import { parseJson } from "./rows-util.mjs";
import { now } from "./util.mjs";
import { AUTO_STACK_BACKFILL_NOTIFY_KEY, sortUnlockedAutoStack } from "./stacks.mjs";

// Each marker is `derived:<column>` in library_meta; the value is the
// derivation-rule version. When the paired mosa_* SQL function changes its
// output, bump that version constant — the next open re-derives every value
// in the background. The reminder lives next to each mosa_* registration in
// openDatabase too.

export const DERIVED_CREATED_AT_EPOCH_MARKER = "derived:created_at_epoch";
export const DERIVED_CREATED_AT_EPOCH_VERSION = 1;
export const DERIVED_SORT_NAME_MARKER = "derived:sort_name";
export const DERIVED_SORT_NAME_VERSION = 1;
export const DERIVED_STACK_SORT_COLUMNS_MARKER = "derived:stack_sort_columns";
export const DERIVED_STACK_SORT_COLUMNS_VERSION = 1;
export const DERIVED_STACK_SORT_CREATED_AT_MARKER = "derived:stack_sort_created_at";
export const DERIVED_STACK_SORT_CREATED_AT_VERSION = 1;
// These three stay synchronous (see each function for why) but only run while
// the marker is missing, so a consistent library stops probing entirely.
const DERIVED_PIXEL_SHA256_MARKER = "derived:pixel_sha256";
const DERIVED_PIXEL_SHA256_VERSION = 1;
const DERIVED_SOURCE_PATH_MARKER = "derived:source_path";
const DERIVED_SOURCE_PATH_VERSION = 1;
const DERIVED_GENERATION_SESSION_KEY_MARKER = "derived:generation_session_key";
const DERIVED_GENERATION_SESSION_KEY_VERSION = 1;

export function derivedMarkerCurrent(database, markerKey, markerVersion) {
  return database.prepare("SELECT value FROM library_meta WHERE key = ?").get(markerKey)?.value === String(markerVersion);
}

function clearDerivedMarker(database, markerKey) {
  database.prepare("DELETE FROM library_meta WHERE key = ?").run(markerKey);
}

export function writeDerivedMarker(database, markerKey, markerVersion) {
  const timestamp = now();
  database.prepare(`
    INSERT INTO library_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(markerKey, String(markerVersion), timestamp);
}

/**
 * Rework 1 (task 350): the plain-open path takes no write lock, so two
 * processes opening a library that is already current but missing columns
 * (a state tests manufacture, or a repair a crash interrupted mid-transaction
 * in some historical build) both reach ALTER TABLE ADD COLUMN — the loser
 * used to die with "duplicate column name" and could not open the library at
 * all. Racing adds are idempotent: a duplicate-name error is success if the
 * column verifiably exists afterwards; every other error rethrows.
 */
export function addColumnIfMissing(database, table, column, definition) {
  try {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  } catch (error) {
    if (!/duplicate column name/i.test(String(error?.message || ""))) throw error;
    const exists = database.prepare(
      `SELECT COUNT(*) AS count FROM pragma_table_info('${table.replaceAll("'", "''")}') WHERE name = ?`,
    ).get(column)?.count > 0;
    if (!exists) throw error;
    return false;
  }
}

/**
 * `created_at` is TEXT, so a `recent` predicate has to parse it, and a parsed predicate cannot use
 * an index — on a 100k-row library that turns a sub-millisecond lookup into a ~20ms scan that runs
 * on every gallery refresh. The parsed instant is therefore materialised into an indexed column.
 *
 * This is an idempotent structural repair rather than a numbered migration: the column is added
 * when missing and parseable legacy text is canonicalised. The whole-table probe and repair moved
 * to rederiveCreatedAtEpochBatched behind the derived:created_at_epoch marker (rule 27) — a stale
 * value only mis-orders a view, so it never has to block the open. Bump
 * DERIVED_CREATED_AT_EPOCH_VERSION whenever mosa_normalize_created_at or mosa_created_at_epoch
 * changes its output.
 */
export function ensureCreatedAtEpoch(database) {
  const hasColumn = database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('assets') WHERE name = 'created_at_epoch'").get().count > 0;
  if (!hasColumn) {
    addColumnIfMissing(database, "assets", "created_at_epoch", "REAL");
    // A freshly added column invalidates the marker: every row needs its
    // backfill, whatever an earlier open recorded.
    clearDerivedMarker(database, DERIVED_CREATED_AT_EPOCH_MARKER);
  }
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_epoch_idx ON assets(project_id, archived, created_at_epoch DESC, id DESC)");
}

// Synchronous (not deferred): the column feeds findAssetByPixelHash, the
// ingest path's same-pixels match — a stale empty value would make an import
// miss the asset it should have matched and store a duplicate instead, which
// is a wrong write, not a display-order nuisance. Gated by the
// derived:pixel_sha256 marker so a consistent library never scans; bump
// DERIVED_PIXEL_SHA256_VERSION when the pixel hash derivation changes.
export function ensurePixelHashColumn(database) {
  const hasColumn = database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('assets') WHERE name = 'pixel_sha256'").get().count > 0;
  if (!hasColumn) {
    addColumnIfMissing(database, "assets", "pixel_sha256", "TEXT NOT NULL DEFAULT ''");
    clearDerivedMarker(database, DERIVED_PIXEL_SHA256_MARKER);
  }
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_pixel_hash_idx ON assets(project_id, pixel_sha256)");
  if (derivedMarkerCurrent(database, DERIVED_PIXEL_SHA256_MARKER, DERIVED_PIXEL_SHA256_VERSION)) return;
  database.transaction(() => {
    database.prepare(`
      UPDATE assets
      SET pixel_sha256 = COALESCE(json_extract(source_json, '$.pixel_sha256'), '')
      WHERE pixel_sha256 = '' AND COALESCE(json_extract(source_json, '$.pixel_sha256'), '') != ''
    `).run();
    writeDerivedMarker(database, DERIVED_PIXEL_SHA256_MARKER, DERIVED_PIXEL_SHA256_VERSION);
  }).immediate();
}

// Synchronous (not deferred) for the same wrong-write reason as the pixel
// column: source_path backs findAssetBySourcePath, the bridge reconciliation
// "has this file been archived?" lookup — a stale empty value re-imports the
// same file. Gated by derived:source_path; bump DERIVED_SOURCE_PATH_VERSION
// when the source-path derivation changes.
export function ensureSourcePathColumn(database) {
  const hasColumn = database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('assets') WHERE name = 'source_path'").get().count > 0;
  if (!hasColumn) {
    addColumnIfMissing(database, "assets", "source_path", "TEXT NOT NULL DEFAULT ''");
    clearDerivedMarker(database, DERIVED_SOURCE_PATH_MARKER);
  }
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_source_path_idx ON assets(project_id, source_path)");
  if (derivedMarkerCurrent(database, DERIVED_SOURCE_PATH_MARKER, DERIVED_SOURCE_PATH_VERSION)) return;
  database.transaction(() => {
    database.prepare(`
      UPDATE assets
      SET source_path = COALESCE(CAST(json_extract(source_json, '$.path') AS TEXT), '')
      WHERE source_path IS NOT COALESCE(CAST(json_extract(source_json, '$.path') AS TEXT), '')
    `).run();
    writeDerivedMarker(database, DERIVED_SOURCE_PATH_MARKER, DERIVED_SOURCE_PATH_VERSION);
  }).immediate();
}

// Task 350 (audit 5-2 #5): the column additions and the derived-value backfill
// commit in ONE transaction — the old gap between "column added" and "values
// backfilled" let a kill in between leave the hole permanently (the old gate
// only backfilled on the add itself).
export function ensureWebCaptureLookupColumns(database) {
  const columns = new Set(database.prepare("SELECT name FROM pragma_table_info('assets')").all().map((row) => row.name));
  const needsBackfill = !columns.has("provider_asset_id") || !columns.has("logical_output_id");
  if (!needsBackfill) {
    database.exec("CREATE INDEX IF NOT EXISTS assets_project_provider_asset_idx ON assets(project_id, provider_asset_id)");
    database.exec("CREATE INDEX IF NOT EXISTS assets_project_logical_output_idx ON assets(project_id, logical_output_id)");
    return;
  }
  database.transaction(() => {
    if (!columns.has("provider_asset_id")) addColumnIfMissing(database, "assets", "provider_asset_id", "TEXT NOT NULL DEFAULT ''");
    if (!columns.has("logical_output_id")) addColumnIfMissing(database, "assets", "logical_output_id", "TEXT NOT NULL DEFAULT ''");
    database.exec("CREATE INDEX IF NOT EXISTS assets_project_provider_asset_idx ON assets(project_id, provider_asset_id)");
    database.exec("CREATE INDEX IF NOT EXISTS assets_project_logical_output_idx ON assets(project_id, logical_output_id)");
    database.prepare(`
      UPDATE assets
      SET provider_asset_id = COALESCE(CAST(json_extract(source_json, '$.provider_asset_id') AS TEXT), ''),
          logical_output_id = COALESCE(CAST(json_extract(source_json, '$.logical_output_id') AS TEXT), '')
      WHERE provider_asset_id != COALESCE(CAST(json_extract(source_json, '$.provider_asset_id') AS TEXT), '')
         OR logical_output_id != COALESCE(CAST(json_extract(source_json, '$.logical_output_id') AS TEXT), '')
    `).run();
  }).immediate();
}

export function ensureSuppressionPixelHashVersion(database) {
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
  if (!hasColumn) addColumnIfMissing(database, "automatic_ingest_suppressions", "pixel_hash_version", "TEXT NOT NULL DEFAULT ''");
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
export function ensureSortName(database) {
  const hasColumn = database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('assets') WHERE name = 'sort_name'").get().count > 0;
  if (!hasColumn) {
    addColumnIfMissing(database, "assets", "sort_name", "TEXT");
    clearDerivedMarker(database, DERIVED_SORT_NAME_MARKER);
  }
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_name_idx ON assets(project_id, archived, sort_name ASC, id ASC)");
  // The whole-table probe and repair live in rederiveSortNameBatched behind
  // the derived:sort_name marker (rule 27): a stale value only mis-orders the
  // gallery. Bump DERIVED_SORT_NAME_VERSION when mosa_sort_name changes.
}

export function ensureAssetStackSortColumns(database) {
  const columns = new Set(database.prepare("SELECT name FROM pragma_table_info('asset_stacks')").all().map((row) => row.name));
  const addedAny = !columns.has("sort_created_at") || !columns.has("sort_name") || !columns.has("name");
  if (!columns.has("sort_created_at")) addColumnIfMissing(database, "asset_stacks", "sort_created_at", "TEXT NOT NULL DEFAULT ''");
  if (!columns.has("sort_name")) addColumnIfMissing(database, "asset_stacks", "sort_name", "TEXT NOT NULL DEFAULT ''");
  // Custom Stack display names own their sort key; the cover-derived backfill
  // only applies to stacks a user has never renamed (name = '').
  if (!columns.has("name")) addColumnIfMissing(database, "asset_stacks", "name", "TEXT NOT NULL DEFAULT ''");
  if (addedAny) {
    // Freshly added stack columns invalidate both stack markers.
    clearDerivedMarker(database, DERIVED_STACK_SORT_COLUMNS_MARKER);
    clearDerivedMarker(database, DERIVED_STACK_SORT_CREATED_AT_MARKER);
  }
  database.exec("CREATE INDEX IF NOT EXISTS asset_stacks_project_sort_created_idx ON asset_stacks(project_id, sort_created_at DESC, id DESC)");
  database.exec("CREATE INDEX IF NOT EXISTS asset_stacks_project_sort_name_idx ON asset_stacks(project_id, sort_name ASC, id ASC)");
  // The whole-table backfill UPDATE moved to backfillStackSortColumnsBatched
  // behind the derived:stack_sort_columns marker (rule 27): it only feeds
  // gallery ordering, so it never blocks the open. Bump
  // DERIVED_STACK_SORT_COLUMNS_VERSION when the cover-derived key changes.
}

/**
 * Session keys group same-conversation captures for automatic stacking. The
 * column is added idempotently and every stored value is re-derived from
 * source_json. Synchronous (not deferred) on purpose: auto-stacking reads
 * this column on every ingest, and a stale empty key would stack a new image
 * into the wrong place or fork a duplicate session stack — a wrong write, not
 * a display nuisance. Gated by the derived:generation_session_key marker so a
 * consistent library stops probing; bump DERIVED_GENERATION_SESSION_KEY_VERSION
 * whenever mosa_generation_session_key changes its output.
 */
export function ensureGenerationSessionColumn(database) {
  const hasColumn = database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('assets') WHERE name = 'generation_session_key'").get().count > 0;
  if (!hasColumn) {
    addColumnIfMissing(database, "assets", "generation_session_key", "TEXT NOT NULL DEFAULT ''");
    clearDerivedMarker(database, DERIVED_GENERATION_SESSION_KEY_MARKER);
  }
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_session_key_idx ON assets(project_id, generation_session_key)");
  if (derivedMarkerCurrent(database, DERIVED_GENERATION_SESSION_KEY_MARKER, DERIVED_GENERATION_SESSION_KEY_VERSION)) return;
  // Probe before the full-table repair write so a consistent library avoids
  // taking the write lock (the marker above keeps this a first-open-only cost).
  const needsRepair = database.prepare(`
    SELECT 1 FROM assets
    WHERE generation_session_key != mosa_generation_session_key(source_type, business_fields_json, source_json)
    LIMIT 1
  `).get();
  database.transaction(() => {
    if (!needsRepair) {
      writeDerivedMarker(database, DERIVED_GENERATION_SESSION_KEY_MARKER, DERIVED_GENERATION_SESSION_KEY_VERSION);
      return;
    }
    database.prepare(`
      UPDATE assets
      SET generation_session_key = mosa_generation_session_key(source_type, business_fields_json, source_json)
      WHERE generation_session_key != mosa_generation_session_key(source_type, business_fields_json, source_json)
    `).run();
    writeDerivedMarker(database, DERIVED_GENERATION_SESSION_KEY_MARKER, DERIVED_GENERATION_SESSION_KEY_VERSION);
  }).immediate();
}

/**
 * Auto-stacked sessions need three things the manual-stack schema predates: an
 * origin marker plus the owning session key on asset_stacks (the partial unique
 * index guarantees one auto stack per session per project), a name lock so a
 * user rename survives later ingests, and the exclusion table recording assets
 * a user deliberately pulled out of an auto stack so they are never re-stacked.
 */
export function ensureAutoStackStructures(database) {
  const columns = new Set(database.prepare("SELECT name FROM pragma_table_info('asset_stacks')").all().map((row) => row.name));
  if (!columns.has("origin")) addColumnIfMissing(database, "asset_stacks", "origin", "TEXT NOT NULL DEFAULT 'manual'");
  if (!columns.has("session_key")) addColumnIfMissing(database, "asset_stacks", "session_key", "TEXT NOT NULL DEFAULT ''");
  if (!columns.has("name_locked")) addColumnIfMissing(database, "asset_stacks", "name_locked", "INTEGER NOT NULL DEFAULT 0");
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

export function ensureAssetStackOrderLocked(database) {
  const columns = new Set(database.prepare("SELECT name FROM pragma_table_info('asset_stacks')").all().map((row) => row.name));
  if (columns.has("order_locked")) return;
  database.transaction(() => {
    addColumnIfMissing(database, "asset_stacks", "order_locked", "INTEGER NOT NULL DEFAULT 0");
    database.prepare("UPDATE asset_stacks SET order_locked = 1 WHERE origin != 'auto'").run();
    const autoStacks = database.prepare("SELECT project_id, id FROM asset_stacks WHERE origin = 'auto'").all();
    const membersByPosition = database.prepare(`
      SELECT sm.asset_id
      FROM asset_stack_members sm
      WHERE sm.project_id = ? AND sm.stack_id = ?
      ORDER BY sm.position ASC, sm.asset_id ASC
    `);
    const membersChronological = database.prepare(`
      SELECT sm.asset_id
      FROM asset_stack_members sm
      LEFT JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
      WHERE sm.project_id = ? AND sm.stack_id = ?
      ORDER BY COALESCE(a.created_at, '') ASC, sm.asset_id ASC
    `);
    const lockStack = database.prepare("UPDATE asset_stacks SET order_locked = 1 WHERE project_id = ? AND id = ?");
    const touchedProjects = new Set();
    for (const stack of autoStacks) {
      const currentOrder = membersByPosition.all(stack.project_id, stack.id);
      const oldestToNewest = membersChronological.all(stack.project_id, stack.id);
      const untouchedOrder = currentOrder.length === oldestToNewest.length
        && currentOrder.every((row, index) => row.asset_id === oldestToNewest[index].asset_id);
      if (untouchedOrder) {
        if (sortUnlockedAutoStack(database, stack.project_id, stack.id)) {
          touchedProjects.add(stack.project_id);
        }
      } else {
        lockStack.run(stack.project_id, stack.id);
      }
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
      `).run(AUTO_STACK_BACKFILL_NOTIFY_KEY, JSON.stringify(merged), now());
    }
  })();
}

export function ensureMediumPathColumn(database) {
  const hasColumn = database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('assets') WHERE name = 'medium_path'").get().count > 0;
  if (!hasColumn) addColumnIfMissing(database, "assets", "medium_path", "TEXT");
}

export function ensureTrashColumn(database) {
  const hasColumn = database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('assets') WHERE name = 'deleted_at'").get().count > 0;
  if (!hasColumn) addColumnIfMissing(database, "assets", "deleted_at", "TEXT");
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_deleted_idx ON assets(project_id, deleted_at, created_at DESC, id DESC)");
}

// Task 350 (audit 5-2 #5): additions, indexes and the scalar backfill commit
// in ONE transaction, so a kill can no longer split "column added" from
// "values backfilled".
export function ensureSearchScalarColumns(database, forceBackfill = false) {
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
    added = true;
    break;
  }
  if (!added && !forceBackfill) {
    ensureSearchScalarIndexes(database);
    return;
  }
  database.transaction(() => {
    const currentColumns = new Map(database.prepare("SELECT name FROM pragma_table_info('assets')").all().map((row) => [row.name, true]));
    for (const [name, definition] of additions) {
      if (currentColumns.has(name)) continue;
      addColumnIfMissing(database, "assets", name, definition);
    }
    ensureSearchScalarIndexes(database);
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
  }).immediate();
}

function ensureSearchScalarIndexes(database) {
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
}

export function ensureGenerationEventColumns(database) {
  const columns = new Set(database.prepare("SELECT name FROM pragma_table_info('generation_events')").all().map((row) => row.name));
  if (!columns.has("provider_tool_call_id")) {
    addColumnIfMissing(database, "generation_events", "provider_tool_call_id", "TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.has("prompt_scope")) {
    addColumnIfMissing(database, "generation_events", "prompt_scope", "TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.has("generation_status")) {
    addColumnIfMissing(database, "generation_events", "generation_status", "TEXT NOT NULL DEFAULT 'unknown'");
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
 *
 * Task 350 (audit 5-2 #5/#6): the addition and the backfill commit in ONE
 * transaction, and the ranking runs over the WHOLE project group set before
 * being written back — the old ROW_NUMBER subquery filtered each group to a
 * single row first, so every rank was 1 and every position landed at 0.
 */
const GROUP_POSITION_REPAIR_MARKER = "repair:group_position_v1";

export function ensureGroupColumns(database) {
  const columns = new Set(database.prepare("SELECT name FROM pragma_table_info('groups')").all().map((row) => row.name));
  const addedPosition = !columns.has("position");
  if (addedPosition || !columns.has("color")) {
    database.transaction(() => {
      if (!columns.has("position")) addColumnIfMissing(database, "groups", "position", "INTEGER");
      if (!columns.has("color")) addColumnIfMissing(database, "groups", "color", "TEXT NOT NULL DEFAULT ''");
      database.exec("CREATE INDEX IF NOT EXISTS groups_project_position_idx ON groups(project_id, position, name COLLATE NOCASE)");
      if (addedPosition) rankGroupPositions(database);
    }).immediate();
  } else {
    database.exec("CREATE INDEX IF NOT EXISTS groups_project_position_idx ON groups(project_id, position, name COLLATE NOCASE)");
  }
  repairDegenerateGroupPositions(database);
}

/** Ranks every group of every project by the legacy rule: more live members
 * first, ties by name (NOCASE). Positions come out 0..n-1, distinct. */
function rankGroupPositions(database) {
  database.exec(`
    UPDATE groups SET position = (
      SELECT ranked.pos FROM (
        SELECT g.project_id AS project_id, g.name AS name,
          ROW_NUMBER() OVER (
            PARTITION BY g.project_id
            ORDER BY (
              SELECT COUNT(a.id) FROM assets a
              WHERE a.project_id = g.project_id
                AND a.group_name = g.name
                AND a.archived = 0
                AND a.deleted_at IS NULL
            ) DESC, g.name COLLATE NOCASE
          ) - 1 AS pos
        FROM groups g
      ) AS ranked
      WHERE ranked.project_id = groups.project_id AND ranked.name = groups.name
    )
  `);
}

/**
 * Task 350 (audit 5-2 #6): libraries upgraded while the old single-row
 * ranking bug was live carry groups whose positions are all identical (every
 * backfill wrote 0) — the sidebar order degenerates to name order with no
 * way back. User actions cannot produce this state (createGroup appends
 * MAX+1, reorderGroups writes 0..n-1 — always distinct), so all-equal
 * positions (or all-NULL from a pre-350 interrupted backfill) mark a project
 * for exactly one re-rank, gated by the repair:group_position_v1 marker.
 */
function repairDegenerateGroupPositions(database) {
  if (database.prepare("SELECT 1 FROM library_meta WHERE key = ?").get(GROUP_POSITION_REPAIR_MARKER)) return;
  const totals = database.prepare(`
    SELECT project_id, COUNT(*) AS total,
      COUNT(DISTINCT COALESCE(position, -1)) AS distinct_positions,
      COUNT(position) AS non_null_positions
    FROM groups GROUP BY project_id
  `).all();
  const degenerate = totals
    .filter((row) => row.total >= 2 && (row.distinct_positions === 1 || row.non_null_positions === 0))
    .map((row) => row.project_id);
  const timestamp = now();
  const rerankProject = database.prepare(`
    UPDATE groups SET position = (
      SELECT ranked.pos FROM (
        SELECT g.name AS name,
          ROW_NUMBER() OVER (
            ORDER BY (
              SELECT COUNT(a.id) FROM assets a
              WHERE a.project_id = g.project_id
                AND a.group_name = g.name
                AND a.archived = 0
                AND a.deleted_at IS NULL
            ) DESC, g.name COLLATE NOCASE
          ) - 1 AS pos
        FROM groups g
        WHERE g.project_id = ?
      ) AS ranked
      WHERE ranked.name = groups.name
    )
    WHERE project_id = ?
  `);
  database.transaction(() => {
    // Re-checked inside the transaction: a concurrent opener may have
    // finished this repair between the probe and the lock.
    if (database.prepare("SELECT 1 FROM library_meta WHERE key = ?").get(GROUP_POSITION_REPAIR_MARKER)) return;
    for (const projectId of degenerate) rerankProject.run(projectId, projectId);
    database.prepare(`
      INSERT INTO library_meta (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(GROUP_POSITION_REPAIR_MARKER, timestamp, timestamp);
  }).immediate();
  if (degenerate.length) {
    console.warn(`[MOSA] repaired all-equal group positions (repair:group_position_v1) in ${degenerate.length} project(s).`);
  }
}

/**
 * `palette_json` holds the asset's dominant colors as [{hex, ratio}] JSON.
 * NULL means "never computed" (the backfill trigger); '[]' means "computed,
 * no colors" and is final. The column is added idempotently so libraries
 * opened by an older build keep every original value untouched.
 */
export function ensureAssetPaletteColumn(database) {
  const columns = new Set(database.prepare("SELECT name FROM pragma_table_info('assets')").all().map((row) => row.name));
  if (!columns.has("palette_json")) {
    addColumnIfMissing(database, "assets", "palette_json", "TEXT");
  }
}
