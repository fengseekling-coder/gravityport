// Search-index helpers for SQLite store (task 404). Pure moves; no behavior changes.
import { statfsSync, statSync } from "node:fs";
import { shortUnicodeSearchTerms } from "./search-sql.mjs";
import { now } from "./util.mjs";

// --- Task 348: search index on integer doc ids (S2) -------------------------
//
// asset_search_docs hands every asset a permanent integer doc id; the short
// term table keys on (term, doc_id) and asset_fts uses the doc id as its
// rowid, so every FTS delete is a one-probe rowid delete instead of a full
// table scan on the unindexed asset_id column. The doc id is assigned on
// first write and never changes — restoring from Trash keeps it.

const SEARCH_SLIM_VACUUM_KEY = "search_slim_vacuum";
const SEARCH_SLIM_VACUUM_ATTEMPTS_KEY = "search_slim_vacuum_attempts";
const SEARCH_SLIM_VACUUM_MAX_ATTEMPTS = 3;
const FTS_MERGE_LAST_AT_KEY = "fts_merge_last_at";
const FTS_MERGE_REWRITE_COUNT_KEY = "fts_rewrite_count";
// Runtime FTS compaction triggers (task 348 §5): enough accumulated rewrites
// or enough idle time since the last pass, whichever comes first.
const FTS_MERGE_REWRITE_THRESHOLD = 500;
const FTS_MERGE_MAX_IDLE_DAYS = 7;
// Pages merged per merge step; small enough that one step stays well under
// the interactive-stall budget even on large libraries (measured, see the
// task-348 report).
const FTS_MERGE_STEP_PAGES = 200;
const FTS_MERGE_MAX_STEPS = 500;

// Test-only kill points for the SIGKILL-resume test (task 348 test 5), the
// same pattern as maybeKillSchemaUpgradeTestProcess. Points: "after-docs",
// "after-terms" (inside the upgrade transaction), "pre-vacuum", "post-vacuum".
function maybeKillSearchSlimTestProcess(point) {
  if (process.env.MOSA_TEST_SEARCH_SLIM_KILL_AT === point) {
    process.kill(process.pid, "SIGKILL");
  }
}

function readLibraryMetaMarker(database, key) {
  return database.prepare("SELECT value FROM library_meta WHERE key = ?").get(key)?.value ?? null;
}

function writeLibraryMetaMarker(database, key, value, timestamp) {
  database.prepare(`
    INSERT INTO library_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value), timestamp);
}

/**
 * v17 → v18 rebuild, inside the upgrade transaction. Order matters: doc ids
 * first (assets → docs), then short terms for LIVE assets only, then the FTS
 * table rebuilt from scratch with rowid = doc id, then the old project/asset
 * keyed short-term table is dropped. Every step is idempotent: the whole
 * transaction commits once or not at all, and a kill reruns it from zero.
 */
export function migrateSearchIndexToDocIds(database, lockedVersion, timestamp) {
  // OR IGNORE: pre-migration legacy assets tables (v1 era) can hold rows the
  // current primary key would collapse; one doc id per surviving
  // (project_id, asset_id) pair is all the mapping needs.
  database.exec("INSERT OR IGNORE INTO asset_search_docs (project_id, asset_id) SELECT project_id, id FROM assets");
  maybeKillSearchSlimTestProcess("after-docs");
  const oldTableExists = Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'asset_short_terms'",
  ).get());
  // Where the short terms come from:
  // - below v15 the old table was never backfilled (a real one exists but is
  //   empty), so derive from the search text — the same source the old v15
  //   backfill used;
  // - at v15..17 the old rows exist, copy them (live rows only: from v18 on,
  //   trashed assets carry no short terms);
  // - a missing table on a nominally >=15 library (only reachable from
  //   synthetic downgraded test libraries) also derives from the text.
  if (lockedVersion >= 15 && oldTableExists) {
    database.exec(`
      INSERT OR IGNORE INTO asset_search_terms (term, doc_id)
      SELECT old.term, d.doc_id
      FROM asset_short_terms old
      JOIN asset_search_docs d ON d.project_id = old.project_id AND d.asset_id = old.asset_id
      JOIN assets a ON a.project_id = old.project_id AND a.id = old.asset_id
      WHERE a.deleted_at IS NULL
    `);
  } else {
    // OR IGNORE keeps the derive idempotent: a library rewound to a nominal
    // older version for tests already carries rows here.
    database.exec(`
      INSERT OR IGNORE INTO asset_search_terms (term, doc_id)
      SELECT CAST(short_term.value AS TEXT), d.doc_id
      FROM assets a
      JOIN asset_search_docs d ON d.project_id = a.project_id AND d.asset_id = a.id,
      json_each(mosa_short_search_terms_json(a.search_text)) AS short_term
      WHERE a.deleted_at IS NULL
    `);
  }
  maybeKillSearchSlimTestProcess("after-terms");
  database.exec("DROP TABLE asset_fts");
  database.exec("CREATE VIRTUAL TABLE asset_fts USING fts5(project_id UNINDEXED, asset_id UNINDEXED, content, tokenize='trigram')");
  database.exec(`
    INSERT INTO asset_fts (rowid, project_id, asset_id, content)
    SELECT d.doc_id, d.project_id, d.asset_id, a.search_text
    FROM asset_search_docs d
    JOIN assets a ON a.project_id = d.project_id AND a.id = d.asset_id
    WHERE a.deleted_at IS NULL
  `);
  if (oldTableExists) database.exec("DROP TABLE asset_short_terms");
  // The one-time VACUUM runs after this transaction commits (VACUUM cannot
  // run inside one). A kill anywhere below leaves this marker at "pending",
  // and the next open retries.
  writeLibraryMetaMarker(database, SEARCH_SLIM_VACUUM_KEY, "pending", timestamp);
  database.prepare("DELETE FROM library_meta WHERE key = ?").run(SEARCH_SLIM_VACUUM_ATTEMPTS_KEY);
}

/**
 * Per-opener statement caches. These run on every asset write, so they are
 * prepared once per connection instead of per call.
 */
const searchDocIdStatements = new WeakMap();

function assetSearchDocIdStatement(database) {
  let statement = searchDocIdStatements.get(database);
  if (!statement) {
    statement = database.prepare("SELECT doc_id FROM asset_search_docs WHERE project_id = ? AND asset_id = ?");
    searchDocIdStatements.set(database, statement);
  }
  return statement;
}

function assetSearchDocId(database, projectId, assetId) {
  return assetSearchDocIdStatement(database).get(projectId, assetId)?.doc_id ?? null;
}

export function ensureAssetSearchDoc(database, projectId, assetId) {
  database.prepare("INSERT OR IGNORE INTO asset_search_docs (project_id, asset_id) VALUES (?, ?)").run(projectId, assetId);
  return assetSearchDocId(database, projectId, assetId);
}

/**
 * One accumulated FTS rewrite (delete + insert, or a trash delete) — the
 * runtime merge maintenance counts these to decide when to compact. The
 * counter lives in library_meta so it survives restarts; the write is one
 * tiny UPSERT inside the caller's transaction.
 */
function noteFtsRewrite(database, count = 1) {
  const timestamp = now();
  database.prepare(`
    INSERT INTO library_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(library_meta.value AS INTEGER) + ? AS TEXT), updated_at = excluded.updated_at
  `).run(FTS_MERGE_REWRITE_COUNT_KEY, String(count), timestamp, count);
}

/**
 * Single authority for asset_fts writes (unchanged rule from before task 348:
 * a trashed asset must never hold an FTS row). The delete is a one-probe
 * rowid delete now; the doc row is ensured so libraries and QA fixtures that
 * inserted asset rows outside saveAsset still get a doc id on first write.
 */
export function syncAssetFtsEntry(database, projectId, assetId, searchText, deletedAt) {
  const docId = ensureAssetSearchDoc(database, projectId, assetId);
  database.prepare("DELETE FROM asset_fts WHERE rowid = ?").run(docId);
  noteFtsRewrite(database);
  if (deletedAt) return;
  database.prepare("INSERT INTO asset_fts (rowid, project_id, asset_id, content) VALUES (?, ?, ?, ?)").run(docId, projectId, assetId, searchText);
}

/**
 * Drops one asset's short-term rows. Task 348 chose the cheapest delete shape
 * (261 measurement): recompute the term set from the asset's PREVIOUS
 * search_text and delete by primary key (term, doc_id) — no extra index on
 * doc_id, so the table stays at its 35 MB-scale size instead of doubling.
 * Callers must pass the stored search_text the current rows were built from.
 */
export function dropAssetSearchTerms(database, projectId, assetId, oldSearchText) {
  const docId = assetSearchDocId(database, projectId, assetId);
  if (docId == null) return;
  const deleteByTerm = database.prepare("DELETE FROM asset_search_terms WHERE term = ? AND doc_id = ?");
  for (const term of shortUnicodeSearchTerms(oldSearchText)) deleteByTerm.run(term, docId);
}

/**
 * Trash-path write rule for short terms, mirroring syncAssetFtsEntry: a
 * trashed asset is delete-only; a live one is a full replace. `oldSearchText`
 * is the stored text the existing rows were built from.
 */
export function replaceAssetShortTerms(database, projectId, assetId, oldSearchText, newSearchText, deletedAt) {
  dropAssetSearchTerms(database, projectId, assetId, oldSearchText);
  if (deletedAt) return;
  const docId = ensureAssetSearchDoc(database, projectId, assetId);
  const terms = shortUnicodeSearchTerms(newSearchText);
  if (!terms.length) return;
  const insert = database.prepare("INSERT OR IGNORE INTO asset_search_terms (term, doc_id) VALUES (?, ?)");
  for (const term of terms) insert.run(term, docId);
}

/**
 * FTS delete by rowid for the paths that only delete (trash, hard delete).
 * One b-tree probe instead of the old full scan on the unindexed asset_id.
 */
export function deleteAssetFtsEntry(database, projectId, assetId) {
  const docId = assetSearchDocId(database, projectId, assetId);
  if (docId == null) return;
  database.prepare("DELETE FROM asset_fts WHERE rowid = ?").run(docId);
  noteFtsRewrite(database);
}

/**
 * Full search-index teardown for a permanently deleted asset: short terms by
 * the old term set, the FTS row by rowid (a free probe when the asset was
 * already trashed — its rows went at trash time), and the doc mapping row.
 */
export function purgeAssetSearchIndex(database, projectId, assetId, oldSearchText) {
  const docId = assetSearchDocId(database, projectId, assetId);
  if (docId == null) return;
  dropAssetSearchTerms(database, projectId, assetId, oldSearchText);
  database.prepare("DELETE FROM asset_fts WHERE rowid = ?").run(docId);
  database.prepare("DELETE FROM asset_search_docs WHERE doc_id = ?").run(docId);
}

// Free disk space probe, injectable for the tests (task 348 test 6). Returns
// available bytes on the volume holding `path`, or a very large number when
// the probe itself fails (never block the open on a probe error).
function defaultFreeDiskBytes(path) {
  try {
    const stats = statfsSync(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

// Peak headroom measured on the 20k synthetic library (task 348 bench): the
// upgrade open peaked at ~1.9x the database size — the pre-upgrade backup and
// the VACUUM image each take about one copy, both on the library volume; the
// retry path (backup already taken) peaks at ~1x. The gate keeps the 2x
// margin plus a 200 MB floor, on the library volume and the temp volume.
const VACUUM_FREE_SPACE_MARGIN_RATIO = 2;
const VACUUM_FREE_SPACE_FLOOR_BYTES = 200 * 1024 * 1024;

/**
 * The one-time post-migration compaction (task 348 §6): optimize, then
 * VACUUM, then a TRUNCATE checkpoint, then the "done" marker. Runs on the
 * open that performed the v18 upgrade and on any later open whose marker is
 * still "pending" (busy database, killed VACUUM, low disk). VACUUM cannot run
 * inside a transaction and cannot be batched — the user agreed to wait on the
 * startup page for exactly this step. Failures never fail the open. Each
 * attempt is counted before it starts, so three that failed or were killed
 * mark it abandoned; success clears the counter.
 */
export function runSearchIndexVacuumIfNeeded(database, { databasePath, libraryDir, tmpDir, freeDiskBytes = defaultFreeDiskBytes }) {
  const marker = readLibraryMetaMarker(database, SEARCH_SLIM_VACUUM_KEY);
  if (!marker || marker === "done" || marker === "abandoned") return;
  const attempts = Number(readLibraryMetaMarker(database, SEARCH_SLIM_VACUUM_ATTEMPTS_KEY) || "0");
  // Attempts that never came back (the process was killed mid-VACUUM, e.g. a
  // force quit on a slow startup) were counted before they started, so three
  // of them stop the retries instead of stalling every launch forever.
  if (attempts >= SEARCH_SLIM_VACUUM_MAX_ATTEMPTS) {
    writeLibraryMetaMarker(database, SEARCH_SLIM_VACUUM_KEY, "abandoned", now());
    console.warn(`[MOSA] library compaction abandoned after ${attempts} unfinished attempts; the database stays usable, just not compacted.`);
    return;
  }
  const attempt = attempts + 1;
  writeLibraryMetaMarker(database, SEARCH_SLIM_VACUUM_ATTEMPTS_KEY, String(attempt), now());
  const fail = (reason) => {
    if (attempt >= SEARCH_SLIM_VACUUM_MAX_ATTEMPTS) {
      writeLibraryMetaMarker(database, SEARCH_SLIM_VACUUM_KEY, "abandoned", now());
      console.warn(`[MOSA] library compaction abandoned after ${attempt} attempts (${reason}); the database stays usable, just not compacted.`);
    } else {
      console.warn(`[MOSA] library compaction skipped (${reason}); it retries on the next open (attempt ${attempt}).`);
    }
  };
  try {
    // Order per the task: optimize first (it rewrites the FTS index compactly
    // so VACUUM has less to copy), then the VACUUM itself.
    database.exec("INSERT INTO asset_fts(asset_fts) VALUES('optimize')");
  } catch (error) {
    fail(`optimize: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  maybeKillSearchSlimTestProcess("pre-vacuum");
  // Free-disk gate. Both volumes need roughly one database-size of headroom:
  // VACUUM builds a fresh image (WAL mode routes it through the WAL file) and
  // the pre-upgrade backup on a first open takes its own copy.
  const databaseBytes = statSync(databasePath).size;
  const requiredBytes = databaseBytes * VACUUM_FREE_SPACE_MARGIN_RATIO + VACUUM_FREE_SPACE_FLOOR_BYTES;
  const libraryVolumeFree = freeDiskBytes(libraryDir);
  const tempVolumeFree = freeDiskBytes(tmpDir);
  if (libraryVolumeFree < requiredBytes || tempVolumeFree < requiredBytes) {
    fail(`not enough free disk space (need ${(requiredBytes / 1024 / 1024).toFixed(0)} MB)`);
    return;
  }
  try {
    database.exec("VACUUM");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }
  maybeKillSearchSlimTestProcess("post-vacuum");
  try {
    database.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // A concurrent reader can hold the checkpoint back; the WAL collapses on
    // the next clean close either way.
  }
  writeLibraryMetaMarker(database, SEARCH_SLIM_VACUUM_KEY, "done", now());
  // Success resets the consecutive-failure counter.
  database.prepare("DELETE FROM library_meta WHERE key = ?").run(SEARCH_SLIM_VACUUM_ATTEMPTS_KEY);
}

/**
 * Shape probe for the merge loop's quiet detection: merge steps that change
 * none of page count, freelist size or segment count have nothing left to do.
 */
function ftsMergeShape(database) {
  const pages = database.pragma("page_count", { simple: true });
  const freelist = database.pragma("freelist_count", { simple: true });
  const segments = database.prepare("SELECT COUNT(*) AS n FROM asset_fts_data").get().n;
  return `${pages}/${freelist}/${segments}`;
}

const yieldToEventLoop = () => new Promise((resolveYield) => setImmediate(resolveYield));
const ftsMergeRunning = new WeakSet();

/**
 * Runtime FTS compaction (task 348 §5), called from startDeferredMaintenance.
 * Small merge steps first (each yields to the event loop, and waits out any
 * open transaction), then one optimize statement — measured at ~11 ms on a
 * 2000-asset library (test 8's dbstat target needs the optimize; merge alone
 * frees almost nothing). Triggered by the persisted rewrite counter crossing
 * 500, or 7 idle days, whichever comes first.
 */
export async function runFtsMergeMaintenance(database, { signal, freeDiskBytes } = {}) {
  if (ftsMergeRunning.has(database)) return;
  const rewrites = Number(readLibraryMetaMarker(database, FTS_MERGE_REWRITE_COUNT_KEY) || "0");
  const lastAt = readLibraryMetaMarker(database, FTS_MERGE_LAST_AT_KEY);
  const idleMs = lastAt ? Date.now() - Date.parse(lastAt) : Number.POSITIVE_INFINITY;
  const due = rewrites >= FTS_MERGE_REWRITE_THRESHOLD || idleMs >= FTS_MERGE_MAX_IDLE_DAYS * 24 * 60 * 60 * 1000;
  if (!due) return;
  ftsMergeRunning.add(database);
  try {
    const merge = database.prepare("INSERT INTO asset_fts(asset_fts, rank) VALUES('merge', ?)");
    for (let step = 0; step < FTS_MERGE_MAX_STEPS; step += 1) {
      if (signal?.aborted || !database.open) return;
      // A write transaction on this connection may be mid-flight (better-sqlite3
      // transactions are synchronous); never interleave an FTS merge into one.
      if (database.inTransaction) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        continue;
      }
      const before = ftsMergeShape(database);
      merge.run(FTS_MERGE_STEP_PAGES);
      await yieldToEventLoop();
      if (ftsMergeShape(database) === before) break;
    }
    if (signal?.aborted || !database.open) return;
    while (database.inTransaction) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      if (signal?.aborted || !database.open) return;
    }
    database.exec("INSERT INTO asset_fts(asset_fts) VALUES('optimize')");
    const timestamp = now();
    writeLibraryMetaMarker(database, FTS_MERGE_REWRITE_COUNT_KEY, "0", timestamp);
    writeLibraryMetaMarker(database, FTS_MERGE_LAST_AT_KEY, timestamp, timestamp);
  } finally {
    ftsMergeRunning.delete(database);
  }
}
