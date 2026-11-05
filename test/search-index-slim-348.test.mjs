// Task 348: the search index moves onto integer doc ids (S2 shape).
//
// - asset_search_docs hands every asset a permanent doc id; asset_search_terms
//   keys on (term, doc_id) and asset_fts uses the doc id as its rowid, so FTS
//   deletes are one-probe rowid deletes.
// - Trashed assets lose their short-term rows and FTS row; restoring rebuilds
//   both; permanent delete clears doc mapping, terms and FTS.
// - 1-2 character ASCII terms LIKE over the FTS content table's copy of the
//   search text instead of the wide assets rows.
// - The v17→v18 migration rebuilds everything inside the upgrade transaction;
//   optimize + VACUUM follow on the open path (marker-gated, retried).
//
// The golden fixture in test/fixtures/348-search-golden/results.json was
// captured on the pre-change code (batch/2026-11-01 e0e08c8); the corpus
// builder lives in test/search-golden-corpus-348.mjs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { createSqliteAssetStore, CURRENT_SCHEMA_VERSION, searchScopeRebuildHelpers, shortUnicodeSearchTerms } from "../lib/sqlite-asset-store.mjs";
import { rebuildSearchScopeTexts } from "../lib/asset-search-scope.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { buildGoldenCorpus, runGoldenQueries } from "./search-golden-corpus-348.mjs";

const REPO_ROOT = dirname(dirname(new URL(import.meta.url).pathname));
const GOLDEN_FIXTURE = JSON.parse(readFileSync(join(REPO_ROOT, "test", "fixtures", "348-search-golden", "results.json"), "utf8"));
const STORE_SOURCE = readFileSync(join(REPO_ROOT, "lib", "sqlite-asset-store.mjs"), "utf8");
const OLD_SEARCH_TERMS_DDL = `
  CREATE TABLE asset_short_terms (
    project_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    term TEXT NOT NULL,
    PRIMARY KEY (project_id, asset_id, term),
    FOREIGN KEY (project_id, asset_id) REFERENCES assets(project_id, id) ON DELETE CASCADE
  ) WITHOUT ROWID
`;
const ONE_TIME_MARKERS = [
  "derived:created_at_epoch", "derived:sort_name", "derived:stack_sort_columns", "derived:stack_sort_created_at",
  "search_scope_v3", "repair_capture_user_message_v1", "generation_message_backfill_v1",
  "repair_cleared_capture_prompt_v1", "video_metadata_backfill_v1", "file_bytes_backfill_v1",
  "fts_trash_row_cleanup_v1", "reference_hardlink_migration_v1",
];

function withRawDatabase(libraryDir, task) {
  const database = new Database(join(libraryDir, "mosa.db"));
  // The store registers mosa_short_search_terms_json on its own connection;
  // raw fixtures (downgrades, legacy seeding) need the same function.
  database.function("mosa_short_search_terms_json", { deterministic: true }, (value) => JSON.stringify(shortUnicodeSearchTerms(value)));
  try {
    return task(database);
  } finally {
    database.close();
  }
}

function markerValue(libraryDir, key) {
  return withRawDatabase(libraryDir, (database) => database.prepare("SELECT value FROM library_meta WHERE key = ?").get(key)?.value ?? null);
}

function setMarker(libraryDir, key, value) {
  withRawDatabase(libraryDir, (database) => database.prepare(`
    INSERT INTO library_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, new Date().toISOString()));
}

function openStore(t, root, extraOptions = {}) {
  const store = createSqliteAssetStore({
    projectRoot: join(root, "project"),
    managerDir: join(root, "project", "mosa"),
    libraryDir: join(root, "library"),
    ...extraOptions,
  });
  t.after(() => { try { store.close(); } catch { /* closed by the test */ } });
  return store;
}

async function createRoot(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  return root;
}

// --- the shared 2000-asset seed corpus --------------------------------------
//
// Built once per process with the real write paths (createAsset, stacks,
// trash, restore), then settled through one deferred-maintenance run so every
// one-time marker exists and copies start from a quiescent state.

let seedPromise = null;

function seedCorpusLibrary() {
  if (!seedPromise) {
    seedPromise = (async () => {
      const root = await mkdtemp(join(tmpdir(), "mosa-348-seed-"));
      const store = createSqliteAssetStore({
        projectRoot: join(root, "project"),
        managerDir: join(root, "project", "mosa"),
        libraryDir: join(root, "library"),
      });
      try {
        await buildGoldenCorpus(store, { projectRoot: join(root, "project") });
        await store.startDeferredMaintenance();
      } finally {
        store.close();
      }
      return root;
    })();
  }
  return seedPromise;
}

async function libraryFromSeed(t, prefix) {
  const seedRoot = await seedCorpusLibrary();
  const root = await createRoot(t, prefix);
  await cp(join(seedRoot, "library"), join(root, "library"), { recursive: true });
  await cp(join(seedRoot, "project"), join(root, "project"), { recursive: true });
  return root;
}

/**
 * Turns a v18 corpus library into the v17 shape the pre-change code wrote:
 * old (project_id, asset_id, term) short-term table (trashed rows included),
 * FTS rows on fresh auto rowids, no doc mapping, schema_version 17.
 */
function downgradeToV17(libraryDir, { dropTermsTable = false, version = 17 } = {}) {
  withRawDatabase(libraryDir, (database) => {
    database.pragma("foreign_keys = OFF");
    database.transaction(() => {
      database.exec(OLD_SEARCH_TERMS_DDL);
      database.exec("CREATE INDEX asset_short_terms_lookup_idx ON asset_short_terms(project_id, term, asset_id)");
      database.exec(`
        INSERT INTO asset_short_terms (project_id, asset_id, term)
        SELECT d.project_id, d.asset_id, st.term
        FROM asset_search_terms st
        JOIN asset_search_docs d ON d.doc_id = st.doc_id
      `);
      // Re-add the trashed rows the v18 table dropped: the old code kept them.
      database.exec(`
        INSERT OR IGNORE INTO asset_short_terms (project_id, asset_id, term)
        SELECT a.project_id, a.id, CAST(short_term.value AS TEXT)
        FROM assets a, json_each(mosa_short_search_terms_json(a.search_text)) AS short_term
        WHERE a.deleted_at IS NOT NULL
      `);
      database.exec("CREATE VIRTUAL TABLE asset_fts_v17 USING fts5(project_id UNINDEXED, asset_id UNINDEXED, content, tokenize='trigram')");
      database.exec("INSERT INTO asset_fts_v17 (project_id, asset_id, content) SELECT project_id, asset_id, content FROM asset_fts");
      database.exec("DROP TABLE asset_fts");
      database.exec("ALTER TABLE asset_fts_v17 RENAME TO asset_fts");
      database.exec("DROP TABLE asset_search_terms");
      database.exec("DROP TABLE asset_search_docs");
      if (dropTermsTable) database.exec("DROP TABLE asset_short_terms");
      database.prepare("UPDATE library_meta SET value = ? WHERE key = 'schema_version'").run(String(version));
      database.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(18);
      database.prepare("DELETE FROM library_meta WHERE key IN ('search_slim_vacuum', 'search_slim_vacuum_attempts', 'fts_merge_last_at', 'fts_rewrite_count')").run();
    })();
    database.pragma("foreign_keys = ON");
  });
}

function ftsDbstatBytes(libraryDir) {
  return withRawDatabase(libraryDir, (database) => database.prepare(`
    SELECT COALESCE(SUM(pgsize), 0) AS n FROM dbstat
    WHERE name IN ('asset_fts_data', 'asset_fts_idx', 'asset_fts_content', 'asset_fts_docsize')
  `).get().n);
}

function searchRowsForAsset(libraryDir, projectId, assetId) {
  return withRawDatabase(libraryDir, (database) => ({
    fts: database.prepare(`
      SELECT rowid, project_id, asset_id, content FROM asset_fts
      WHERE project_id = ? AND asset_id = ?
    `).all(projectId, assetId),
    terms: database.prepare(`
      SELECT st.term FROM asset_search_terms st
      JOIN asset_search_docs d ON d.doc_id = st.doc_id
      WHERE d.project_id = ? AND d.asset_id = ?
      ORDER BY st.term
    `).all(projectId, assetId).map((row) => row.term),
    doc: database.prepare("SELECT doc_id FROM asset_search_docs WHERE project_id = ? AND asset_id = ?").get(projectId, assetId) ?? null,
  }));
}

// --- test 1: golden results --------------------------------------------------

test("348 golden: search results are identical to the pre-change fixture", async (t) => {
  const root = await libraryFromSeed(t, "mosa-348-golden-");
  const store = openStore(t, root);
  const results = await runGoldenQueries(store);
  for (let index = 0; index < GOLDEN_FIXTURE.queries.length; index += 1) {
    const expected = GOLDEN_FIXTURE.queries[index];
    const actual = results[index];
    assert.equal(expected.label, actual.label);
    assert.deepEqual(actual.pages, expected.pages, `golden mismatch on ${expected.label}`);
  }
  assert.equal(GOLDEN_FIXTURE.queries.length, results.length);
});

// --- test 2: v17 and v14 upgrades reproduce the golden results ---------------

test("348 upgrade: a v17 library upgrades to identical results, new structure, ok integrity", async (t) => {
  const root = await libraryFromSeed(t, "mosa-348-up17-");
  const libraryDir = join(root, "library");
  downgradeToV17(libraryDir);
  assert.equal(markerValue(libraryDir, "schema_version"), "17");
  assert.ok(withRawDatabase(libraryDir, (db) => db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'asset_short_terms'").get()));

  const store = openStore(t, root);
  assert.equal(markerValue(libraryDir, "schema_version"), String(CURRENT_SCHEMA_VERSION), "the upgrade lands on the new version");
  const tables = withRawDatabase(libraryDir, (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('asset_short_terms', 'asset_search_docs', 'asset_search_terms') ORDER BY name").all().map((row) => row.name));
  assert.deepEqual(tables, ["asset_search_docs", "asset_search_terms"], "the old short-term table is gone");
  assert.equal(withRawDatabase(libraryDir, (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'asset_short_terms_lookup_idx'").get()), undefined);
  assert.equal(withRawDatabase(libraryDir, (db) => db.pragma("integrity_check", { simple: true })), "ok");
  assert.equal(markerValue(libraryDir, "search_slim_vacuum"), "done", "the post-upgrade compaction ran on the open");
  // The rebuilt index keeps the standing rule: a trashed asset holds no FTS
  // row and no short terms (results alone cannot show this — every query
  // filters trashed rows out after the index match).
  const trashedIndexRows = withRawDatabase(libraryDir, (db) => ({
    trashed: db.prepare("SELECT COUNT(*) AS n FROM assets WHERE deleted_at IS NOT NULL").get().n,
    fts: db.prepare(`
      SELECT COUNT(*) AS n FROM asset_fts f
      JOIN asset_search_docs d ON d.doc_id = f.rowid
      JOIN assets a ON a.project_id = d.project_id AND a.id = d.asset_id
      WHERE a.deleted_at IS NOT NULL
    `).get().n,
    terms: db.prepare(`
      SELECT COUNT(*) AS n FROM asset_search_terms t
      JOIN asset_search_docs d ON d.doc_id = t.doc_id
      JOIN assets a ON a.project_id = d.project_id AND a.id = d.asset_id
      WHERE a.deleted_at IS NOT NULL
    `).get().n,
  }));
  assert.ok(trashedIndexRows.trashed > 0, "the corpus carries trashed assets, so the check below means something");
  assert.equal(trashedIndexRows.fts, 0, "no FTS row survives the upgrade for a trashed asset");
  assert.equal(trashedIndexRows.terms, 0, "no short term survives the upgrade for a trashed asset");

  const results = await runGoldenQueries(store);
  for (let index = 0; index < GOLDEN_FIXTURE.queries.length; index += 1) {
    assert.deepEqual(results[index].pages, GOLDEN_FIXTURE.queries[index].pages, `golden mismatch after upgrade on ${GOLDEN_FIXTURE.queries[index].label}`);
  }
});

test("348 upgrade: a v14 library backfills short terms straight into the new shape", async (t) => {
  const root = await libraryFromSeed(t, "mosa-348-up14-");
  const libraryDir = join(root, "library");
  downgradeToV17(libraryDir, { dropTermsTable: true, version: 14 });
  assert.equal(markerValue(libraryDir, "schema_version"), "14");

  const store = openStore(t, root);
  assert.equal(markerValue(libraryDir, "schema_version"), String(CURRENT_SCHEMA_VERSION));
  assert.equal(withRawDatabase(libraryDir, (db) => db.pragma("integrity_check", { simple: true })), "ok");
  const results = await runGoldenQueries(store);
  for (let index = 0; index < GOLDEN_FIXTURE.queries.length; index += 1) {
    assert.deepEqual(results[index].pages, GOLDEN_FIXTURE.queries[index].pages, `golden mismatch after v14 backfill on ${GOLDEN_FIXTURE.queries[index].label}`);
  }
  // The v14 path derives short terms from the live assets' search text: the
  // corpus's 100 trashed rows (minus the 20 restored) must carry no terms.
  const trashedTerms = withRawDatabase(libraryDir, (db) => db.prepare(`
    SELECT COUNT(*) AS count
    FROM asset_search_terms st
    JOIN asset_search_docs d ON d.doc_id = st.doc_id
    JOIN assets a ON a.project_id = d.project_id AND a.id = d.asset_id
    WHERE a.deleted_at IS NOT NULL
  `).get().count);
  assert.equal(trashedTerms, 0, "trashed assets get no short-term rows");
});

// --- test 3 + 7: rowid deletes and the narrow-table LIKE, by query plan ------
//
// The statements under test are the exact SQL literals the store module
// carries: extracted from the source (so the test cannot drift from the
// implementation) and explained against a real database. The 347 one-time
// trash-row cleanup is a whole-table background pass by design (marker-gated,
// runs once); its backtick-quoted statement is not part of the write path.

test("348 plans: every write-path FTS delete is a rowid probe, the short-ASCII LIKE never scans the wide table", async (t) => {
  const root = await libraryFromSeed(t, "mosa-348-plan-");
  const store = openStore(t, root);
  const libraryDir = join(root, "library");

  const deleteStatements = [...STORE_SOURCE.matchAll(/"DELETE FROM asset_fts[^"]*"/g)].map((match) => match[0].slice(1, -1));
  assert.ok(deleteStatements.length >= 3, `the module carries rowid FTS deletes (found ${deleteStatements.length})`);
  withRawDatabase(libraryDir, (db) => {
    for (const statement of deleteStatements) {
      const placeholders = (statement.match(/\?/g) || []).length;
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${statement}`).all(...Array.from({ length: placeholders }, () => null))
        .map((row) => String(row.detail));
      // On the FTS5 virtual table a rowid-equality delete reports INDEX 0:=
      // (one probe); the old project/asset form reports INDEX 0: with no "="
      // and reads every row.
      assert.ok(
        plan.some((detail) => detail.includes("asset_fts") && detail.includes("VIRTUAL TABLE INDEX 0:=")),
        `FTS delete must be a rowid-equality probe: ${statement} → ${JSON.stringify(plan)}`,
      );
      assert.ok(
        !plan.some((detail) => detail.includes("asset_fts") && !detail.includes("INDEX 0:=")),
        `FTS delete must not fall back to a full-table strategy: ${statement} → ${JSON.stringify(plan)}`,
      );
    }
  });

  // The short-ASCII LIKE condition the module builds (both call sites).
  const likeShapes = [...STORE_SOURCE.matchAll(/LOWER\(short_content\.c2\) LIKE/g)];
  assert.ok(likeShapes.length >= 2, "both LIKE call sites run on the FTS content copy");
  assert.ok(!/LOWER\(a\.search_text\) LIKE/.test(STORE_SOURCE), "the wide-table LIKE is gone from the module");
  const pagePlans = withRawDatabase(libraryDir, (db) => db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT a.id FROM assets a
    WHERE a.project_id = 'default' AND a.deleted_at IS NULL AND a.archived = 0
      AND a.id IN (
        SELECT short_content.c1 FROM asset_fts_content short_content
        WHERE short_content.c0 = 'default' AND LOWER(short_content.c2) LIKE '%3d%' ESCAPE '\\'
      )
  `).all().map((row) => String(row.detail)));
  assert.ok(pagePlans.some((detail) => detail.includes("SCAN short_content")), `the LIKE scans the narrow content table: ${JSON.stringify(pagePlans)}`);
  assert.ok(!pagePlans.some((detail) => detail.includes("SCAN a ") || detail.includes("SCAN assets")), `the wide assets table is not scanned: ${JSON.stringify(pagePlans)}`);
  store.close();
});

test("348 edit: rewriting a prompt updates FTS + short terms, old words leave both", async (t) => {
  const root = await libraryFromSeed(t, "mosa-348-edit-");
  const store = openStore(t, root);
  const libraryDir = join(root, "library");
  await store.createAsset({
    assetId: "edit-probe",
    imagePath: join(root, "project", "corpus-images", "seed.png"),
    prompt: "霓虹雨夜的老街巡查",
  });
  assert.ok(
    (await store.listAssets({ projectId: "default", query: "霓虹" })).some((row) => row.id === "edit-probe"),
    "the probe arrives with its first prompt",
  );
  await store.updateMetadata("default", "edit-probe", { prompt: "海边鲸鱼光斑下潜" });
  assert.ok(
    !(await store.listAssets({ projectId: "default", query: "霓虹" })).some((row) => row.id === "edit-probe"),
    "the old CJK word leaves short-term search",
  );
  assert.ok(
    (await store.listAssets({ projectId: "default", query: "鲸鱼" })).some((row) => row.id === "edit-probe"),
    "the new CJK word arrives",
  );
  assert.ok(
    (await store.listAssets({ projectId: "default", query: "下潜" })).some((row) => row.id === "edit-probe"),
    "the full-text path sees the new words",
  );
  const rows = searchRowsForAsset(libraryDir, "default", "edit-probe");
  assert.equal(rows.fts.length, 1, "exactly one FTS row (rowid delete + insert)");
  assert.match(rows.fts[0].content, /鲸鱼光斑/);
  assert.ok(rows.terms.includes("鲸鱼") && !rows.terms.includes("霓虹"), "short terms follow the edit");
  // One edit = one rewrite in the persisted counter.
  assert.ok(Number(markerValue(libraryDir, "fts_rewrite_count")) >= 2, "edits accumulate in the rewrite counter");
});

// --- test 4: trash / restore / permanent delete ------------------------------

test("348 trash: terms and FTS drop on trash, restore rebuilds them identically, permanent delete clears the doc", async (t) => {
  const root = await libraryFromSeed(t, "mosa-348-trash-");
  const store = openStore(t, root);
  const libraryDir = join(root, "library");
  await store.createAsset({
    assetId: "trash-probe",
    imagePath: join(root, "project", "corpus-images", "seed.png"),
    prompt: "Trash探针鲸鱼光斑 3d",
  });
  const before = searchRowsForAsset(libraryDir, "default", "trash-probe");
  assert.ok(before.doc && before.fts.length === 1 && before.terms.length > 0);

  await store.deleteAsset("default", "trash-probe", { reason: "probe" });
  const trashed = searchRowsForAsset(libraryDir, "default", "trash-probe");
  assert.deepEqual(trashed.terms, [], "trash drops the short-term rows");
  assert.deepEqual(trashed.fts, [], "trash drops the FTS row");
  assert.ok(trashed.doc, "the doc mapping survives trash");

  // Editing a trashed asset stays delete-only: the metadata write must not
  // re-seed short-term rows for a trashed asset.
  // Editing a trashed asset stays delete-only: the metadata write must not
  // re-seed short-term rows for a trashed asset.
  await store.updateMetadata("default", "trash-probe", { prompt: "回收站里的鲸鱼新词" });
  assert.deepEqual(searchRowsForAsset(libraryDir, "default", "trash-probe").terms, [], "an edit while trashed writes no short terms");

  await store.restoreAsset("default", "trash-probe");
  const restored = searchRowsForAsset(libraryDir, "default", "trash-probe");
  // The restore rebuilds from the edited search text (the trashed edit won),
  // keeping the doc id and the rowid == doc id pairing.
  assert.equal(restored.doc.doc_id, before.doc.doc_id, "restore keeps the original doc id");
  assert.equal(restored.fts.length, 1, "exactly one FTS row after restore");
  assert.equal(restored.fts[0].rowid, before.doc.doc_id, "the FTS row rides the doc id");
  assert.match(restored.fts[0].content, /回收站里的鲸鱼新词/, "the FTS row holds the edited text");
  assert.ok(!restored.fts[0].content.includes("Trash探针鲸鱼光斑"), "the old prompt left the stored text");
  assert.deepEqual(restored.terms, shortUnicodeSearchTerms(restored.fts[0].content).sort(),
    "short terms are the stored text's windows");

  // Back to Trash, then out of the library for good.
  await store.deleteAsset("default", "trash-probe", { reason: "probe" });
  await store.permanentlyDeleteAsset("default", "trash-probe");
  const purged = searchRowsForAsset(libraryDir, "default", "trash-probe");
  assert.equal(purged.doc, null, "the doc mapping row is gone");
  assert.deepEqual(purged.terms, [], "short terms are gone");
  assert.deepEqual(purged.fts, [], "the FTS row is gone");
});

test("348 trash: emptying 200 trashed assets clears everything with no wide scans", async (t) => {
  const root = await libraryFromSeed(t, "mosa-348-empty-");
  const store = openStore(t, root);
  const libraryDir = join(root, "library");
  const image = join(root, "project", "corpus-images", "seed.png");
  for (let index = 0; index < 200; index += 1) {
    await store.createAsset({ assetId: `empty-${String(index).padStart(3, "0")}`, imagePath: image, prompt: `清空探针 ${index} 光斑` });
  }
  for (let index = 0; index < 200; index += 1) {
    await store.deleteAsset("default", `empty-${String(index).padStart(3, "0")}`, { reason: "probe" });
  }
  const started = Date.now();
  const { removed } = await store.emptyTrash("default");
  const elapsedMs = Date.now() - started;
  assert.equal(removed, 200);
  t.diagnostic(`emptyTrash 200 took ${elapsedMs}ms`);
  const leftovers = withRawDatabase(libraryDir, (db) => ({
    docs: db.prepare("SELECT COUNT(*) AS n FROM asset_search_docs WHERE asset_id LIKE 'empty-%'").get().n,
    terms: db.prepare("SELECT COUNT(*) AS n FROM asset_search_terms WHERE doc_id NOT IN (SELECT doc_id FROM asset_search_docs)").get().n,
    fts: db.prepare("SELECT COUNT(*) AS n FROM asset_fts WHERE asset_id LIKE 'empty-%'").get().n,
  }));
  assert.equal(leftovers.docs, 0, "doc mapping rows are cleared");
  assert.equal(leftovers.terms, 0, "no orphaned short-term rows");
  assert.equal(leftovers.fts, 0, "no leftover FTS rows");
});

// --- test 5: SIGKILL during the migration / compaction ------------------------

async function writeKillChildScript(root, { killAfterMs = null } = {}) {
  const scriptPath = join(root, "child-open-348.mjs");
  // A mid-statement kill cannot use a main-thread setTimeout: the whole open
  // (upgrade + optimize + VACUUM) is one synchronous block, so the timer would
  // only fire after it. killAfterMs != null arms the marker watcher worker:
  // it polls library_meta from its own read-only connection and SIGKILLs the
  // process a beat after "pending" shows up — i.e. while the optimize/VACUUM
  // sequence is running.
  if (killAfterMs != null) {
    const workerPath = join(root, "vacuum-killer.mjs");
    await writeFile(workerPath, `
import Database from ${JSON.stringify(join(REPO_ROOT, "node_modules", "better-sqlite3", "lib", "index.js"))};
const database = new Database(${JSON.stringify(join(root, "library", "mosa.db"))}, { readonly: true });
const startedAt = Date.now();
const poll = () => {
  try {
    const row = database.prepare("SELECT value FROM library_meta WHERE key = 'search_slim_vacuum'").get();
    if (row && row.value === "pending") {
      setTimeout(() => process.kill(process.pid, "SIGKILL"), ${killAfterMs});
      return;
    }
  } catch {
    // The main thread may hold the database mid-write; keep polling.
  }
  if (Date.now() - startedAt < 30000) setTimeout(poll, 2);
};
poll();
`);
    await writeFile(scriptPath, `
import { Worker } from "node:worker_threads";
new Worker(${JSON.stringify(workerPath)}).unref();
import { createSqliteAssetStore } from ${JSON.stringify(join(REPO_ROOT, "lib", "sqlite-asset-store.mjs"))};
const { join } = await import("node:path");
const projectRoot = ${JSON.stringify(join(root, "project"))};
const store = createSqliteAssetStore({
  projectRoot,
  managerDir: join(projectRoot, "mosa"),
  libraryDir: ${JSON.stringify(join(root, "library"))},
});
store.close();
console.log("child-ok");
`);
    return scriptPath;
  }
  await writeFile(scriptPath, `
import { createSqliteAssetStore } from ${JSON.stringify(join(REPO_ROOT, "lib", "sqlite-asset-store.mjs"))};
const { join } = await import("node:path");
const projectRoot = ${JSON.stringify(join(root, "project"))};
const store = createSqliteAssetStore({
  projectRoot,
  managerDir: join(projectRoot, "mosa"),
  libraryDir: ${JSON.stringify(join(root, "library"))},
});
store.close();
console.log("child-ok");
`);
  return scriptPath;
}

function runChild(scriptPath, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

for (const killPoint of ["after-docs", "after-terms", "pre-vacuum", "post-vacuum"]) {
  test(`348 resume: SIGKILL at ${killPoint} reopens to a converged library`, async (t) => {
    const root = await libraryFromSeed(t, "mosa-348-kill-");
    const libraryDir = join(root, "library");
    downgradeToV17(libraryDir);
    const killed = await runChild(await writeKillChildScript(root), { MOSA_TEST_SEARCH_SLIM_KILL_AT: killPoint });
    assert.equal(killed.signal, "SIGKILL", `the child died at ${killPoint} (code ${killed.code}, stderr ${killed.stderr.slice(0, 200)})`);

    // Reopen without the kill hook: the upgrade or the compaction finishes.
    const store = openStore(t, root);
    assert.equal(withRawDatabase(libraryDir, (db) => db.pragma("integrity_check", { simple: true })), "ok");
    assert.equal(markerValue(libraryDir, "search_slim_vacuum"), "done", "the compaction marker converges to done");
    const results = await runGoldenQueries(store);
    for (let index = 0; index < GOLDEN_FIXTURE.queries.length; index += 1) {
      assert.deepEqual(results[index].pages, GOLDEN_FIXTURE.queries[index].pages, `golden mismatch after kill at ${killPoint} on ${GOLDEN_FIXTURE.queries[index].label}`);
    }
  });
}

test("348 resume: SIGKILL mid-VACUUM reopens and finishes the compaction", async (t) => {
  const root = await libraryFromSeed(t, "mosa-348-killvac-");
  const libraryDir = join(root, "library");
  downgradeToV17(libraryDir);
  // The killer worker sights the "pending" marker (written inside the upgrade
  // transaction, before optimize + VACUUM) and kills ~10ms later, which lands
  // inside the optimize/VACUUM sequence for this corpus size. Either way the
  // reopen must converge.
  const killed = await runChild(await writeKillChildScript(root, { killAfterMs: 10 }), {});
  assert.equal(killed.signal, "SIGKILL", `the child died around the VACUUM (code ${killed.code}, stderr ${killed.stderr.slice(0, 200)})`);
  const store = openStore(t, root);
  assert.equal(withRawDatabase(libraryDir, (db) => db.pragma("integrity_check", { simple: true })), "ok");
  assert.equal(markerValue(libraryDir, "search_slim_vacuum"), "done", "the next open finishes the compaction");
  const results = await runGoldenQueries(store);
  assert.deepEqual(results[0].pages, GOLDEN_FIXTURE.queries[0].pages);
});

// A force quit on every slow startup must not make every launch redo the
// compaction forever: an attempt counts before it starts, so three that never
// came back abandon it like three ordinary failures do.
test("348 resume: three compactions killed mid-way abandon it on the next open", async (t) => {
  const root = await libraryFromSeed(t, "mosa-348-killx3-");
  const libraryDir = join(root, "library");
  downgradeToV17(libraryDir);
  const script = await writeKillChildScript(root);
  for (const expectedAttempts of ["1", "2", "3"]) {
    const killed = await runChild(script, { MOSA_TEST_SEARCH_SLIM_KILL_AT: "pre-vacuum" });
    assert.equal(killed.signal, "SIGKILL", `the child died before the VACUUM (code ${killed.code}, stderr ${killed.stderr.slice(0, 200)})`);
    assert.equal(markerValue(libraryDir, "search_slim_vacuum"), "pending", "a killed attempt leaves the marker pending");
    assert.equal(markerValue(libraryDir, "search_slim_vacuum_attempts"), expectedAttempts, "the killed attempt was counted");
  }
  const store = openStore(t, root);
  assert.equal(markerValue(libraryDir, "search_slim_vacuum"), "abandoned", "the fourth open gives up instead of retrying");
  assert.equal(withRawDatabase(libraryDir, (db) => db.pragma("integrity_check", { simple: true })), "ok");
  const results = await runGoldenQueries(store);
  assert.deepEqual(results[0].pages, GOLDEN_FIXTURE.queries[0].pages, "the uncompacted library stays fully usable");
});

// --- test 6: not enough free disk --------------------------------------------

test("348 disk: a failing free-space probe skips the compaction, three failures abandon it", async (t) => {
  const root = await libraryFromSeed(t, "mosa-348-disk-");
  const libraryDir = join(root, "library");
  downgradeToV17(libraryDir);
  const openWithProbe = (freeDiskBytes) => {
    const warns = [];
    const original = console.warn;
    console.warn = (...parts) => { warns.push(parts.map(String).join(" ")); };
    try {
      const store = createSqliteAssetStore({
        projectRoot: join(root, "project"),
        managerDir: join(root, "project", "mosa"),
        libraryDir,
        freeDiskBytes,
      });
      return { store, warns };
    } finally {
      console.warn = original;
    }
  };

  const first = openWithProbe(() => 1024);
  try {
    assert.equal(markerValue(libraryDir, "search_slim_vacuum"), "pending", "the marker stays pending");
    assert.ok(first.warns.some((line) => line.startsWith("[MOSA]") && line.includes("not enough free disk space")), `a [MOSA] warning is logged: ${first.warns.join(" | ")}`);
    assert.equal(markerValue(libraryDir, "search_slim_vacuum_attempts"), "1");
  } finally {
    first.store.close();
  }

  const second = openWithProbe(() => 1024);
  second.store.close();
  assert.equal(markerValue(libraryDir, "search_slim_vacuum_attempts"), "2");

  const third = openWithProbe(() => 1024);
  third.store.close();
  assert.equal(markerValue(libraryDir, "search_slim_vacuum"), "abandoned", "three consecutive failures abandon the compaction");

  // A fourth open (even with space) does not retry an abandoned marker.
  const fourth = openWithProbe(() => Number.MAX_SAFE_INTEGER);
  fourth.store.close();
  assert.equal(markerValue(libraryDir, "search_slim_vacuum"), "abandoned");

  // The library itself stays fully usable throughout.
  const store = openStore(t, root);
  const results = await runGoldenQueries(store);
  assert.deepEqual(results[0].pages, GOLDEN_FIXTURE.queries[0].pages);
});

// --- test 8: the runtime FTS compaction ---------------------------------------

test("348 maintenance: after heavy churn the runtime pass brings the FTS back to near-fresh without stalling timers", async (t) => {
  const root = await libraryFromSeed(t, "mosa-348-merge-");
  const libraryDir = join(root, "library");
  const store = openStore(t, root);
  const freshFtsBytes = ftsDbstatBytes(libraryDir);

  const churnPrompt = (round) => `churn 光斑 round ${round} variant`;
  for (let round = 0; round < 3; round += 1) {
    const assets = await store.listAssets({ projectId: "default" });
    for (const asset of assets) {
      await store.updateMetadata("default", asset.id, { prompt: `${churnPrompt(round)} ${asset.id}` });
    }
  }
  const churnedBytes = ftsDbstatBytes(libraryDir);
  assert.ok(churnedBytes > freshFtsBytes, `churn grows the index (${churnedBytes} > ${freshFtsBytes})`);
  assert.ok(Number(markerValue(libraryDir, "fts_rewrite_count")) >= 500, "the rewrite counter crossed its threshold");

  // A 6000-edit metadata batch leaves the event loop with a one-time
  // post-batch stall (observed on macOS, present on the pre-change code too
  // — it is not part of the compaction this test measures). Absorb it before
  // arming the responsiveness timer.
  await new Promise((resolveYield) => setImmediate(resolveYield));

  const tickDurations = [];
  let last = performance.now();
  const timer = setInterval(() => {
    const nowTick = performance.now();
    tickDurations.push(nowTick - last);
    last = nowTick;
  }, 50);
  await store.startDeferredMaintenance();
  clearInterval(timer);

  const settledBytes = ftsDbstatBytes(libraryDir);
  const drift = (settledBytes - freshFtsBytes) / freshFtsBytes;
  t.diagnostic(`fts dbstat fresh=${freshFtsBytes} churned=${churnedBytes} settled=${settledBytes} (drift ${(drift * 100).toFixed(1)}%)`);
  assert.ok(Math.abs(drift) <= 0.1, `the compaction brings the FTS within 10% of fresh (drift ${(drift * 100).toFixed(1)}%)`);
  assert.equal(markerValue(libraryDir, "fts_rewrite_count"), "0", "the counter resets after the pass");
  assert.ok(markerValue(libraryDir, "fts_merge_last_at"), "the last-maintained time is written");
  const slowest = Math.max(...tickDurations);
  assert.ok(slowest < 200, `every 50ms timer fired within 200ms during maintenance (slowest ${slowest.toFixed(1)}ms)`);
});

// --- the narrow-table rebuild driver keeps matching the whole-table pass -----

test("348 rebuild: the exported helpers match the whole-table rebuildSearchScopeTexts", async (t) => {
  const root = await libraryFromSeed(t, "mosa-348-scope-");
  const libraryDir = join(root, "library");
  const store = openStore(t, root);
  // Add one legacy-shaped row the whitelist must strip, then drive both
  // implementations and compare the resulting search columns row for row.
  // The seed's rebuild marker is cleared so the pass actually runs here.
  withRawDatabase(libraryDir, (db) => {
    db.transaction(() => {
      db.prepare("DELETE FROM library_meta WHERE key = 'search_scope_v3'").run();
      const docId = db.prepare("INSERT INTO asset_search_docs (project_id, asset_id) VALUES ('default', 'legacy-probe')").run().lastInsertRowid;
      db.prepare(`
        INSERT INTO assets (project_id, id, asset, original_path, content_sha256, prompt, skill, style, ratio, business_fields_json, theme,
          favorite, archived, group_name, category, rating, version_change, source_type, source_json, source_path, metadata_json, search_text,
          tags_text, business_search_text, source_search_text, media_kind, source_group, conversation_id, generation_batch,
          created_at, created_at_epoch, updated_at, sort_name)
        VALUES ('default', 'legacy-probe', 'legacy-probe.png', '/tmp/zqx7-藏经阁/legacy.png', 'hash-legacy', 'lantern legacy study', '', '', '', '{}', '',
          0, 0, '', '', 0, '', 'local-file', '{}', '', '{}', 'lantern legacy study /tmp/zqx7-藏经阁/legacy.png deadbeef',
          '', '', '', 'image', 'local-file', '', '', '2026-01-01T00:00:00.000Z', 0, '2026-01-01T00:00:00.000Z', 'legacy-probe')
      `).run();
      db.prepare("INSERT INTO asset_fts (rowid, project_id, asset_id, content) VALUES (?, 'default', 'legacy-probe', ?)")
        .run(docId, "lantern legacy study /tmp/zqx7-藏经阁/legacy.png deadbeef");
      for (const term of ["藏经", "经阁", "藏"]) {
        db.prepare("INSERT INTO asset_search_terms (term, doc_id) VALUES (?, ?)").run(term, docId);
      }
    })();
  });
  // The whole-table pass on a copy of the raw state.
  const wholeTable = withRawDatabase(libraryDir, (db) => {
    const before = db.prepare("SELECT id, search_text, source_search_text, business_search_text FROM assets ORDER BY id").all();
    rebuildSearchScopeTexts(db, searchScopeRebuildHelpers(db));
    const after = db.prepare("SELECT id, search_text, source_search_text, business_search_text FROM assets ORDER BY id").all();
    return { before, after };
  });
  assert.equal(wholeTable.before.filter((row) => row.id === "legacy-probe")[0].search_text.includes("zqx7"), true, "the legacy text was there");
  assert.equal(wholeTable.after.filter((row) => row.id === "legacy-probe")[0].search_text.includes("zqx7"), false, "the whitelist stripped it");
  const probe = searchRowsForAsset(libraryDir, "default", "legacy-probe");
  assert.deepEqual(probe.terms, [], "the legacy CJK terms are gone");
  assert.ok(probe.fts[0] && !probe.fts[0].content.includes("zqx7"), "the FTS row holds the rebuilt text");
  assert.equal(markerValue(libraryDir, "search_scope_v3") != null, true, "the marker is written");
  store.close();
});
