// Batched background derived-column repair passes moved out of the SQLite store (task 448). Pure moves; no behavior changes.
import { DERIVED_MAINTENANCE_BATCH_SIZE } from "./util.mjs";
import { STACK_LIVE_COVER_SORT_NAME_SQL, STACK_SORT_CREATED_AT_SQL } from "./stacks.mjs";
import { DERIVED_CREATED_AT_EPOCH_MARKER, DERIVED_CREATED_AT_EPOCH_VERSION, DERIVED_SORT_NAME_MARKER, DERIVED_SORT_NAME_VERSION, DERIVED_STACK_SORT_COLUMNS_MARKER, DERIVED_STACK_SORT_COLUMNS_VERSION, DERIVED_STACK_SORT_CREATED_AT_MARKER, DERIVED_STACK_SORT_CREATED_AT_VERSION, derivedMarkerCurrent, writeDerivedMarker } from "./schema-passes.mjs";

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
export function maybeKillTestProcessAfterBatch(passName, batchIndex) {
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
export async function rederiveCreatedAtEpochBatched(database, options = {}) {
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
export async function rederiveSortNameBatched(database, options = {}) {
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
export async function backfillStackSortColumnsBatched(database, options = {}) {
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
export async function rederiveStackSortCreatedAtBatched(database, options = {}) {
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
