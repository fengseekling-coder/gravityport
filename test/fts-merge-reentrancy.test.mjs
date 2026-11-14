// Task 407: behavior coverage for the re-entrancy guard of runFtsMergeMaintenance
// (lib/sqlite-store/search-index.mjs). The 404 report left this gap: nothing
// exercised the "same database already running" early return. This test drives
// the real module — no copied logic — and never awaits the first call before
// starting the second, so the guard is the only thing that can keep the second
// call from running its own optimize pass.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { runFtsMergeMaintenance } from "../lib/sqlite-store/search-index.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

test("fts merge re-entrancy: a concurrent second call with the same database returns without running its own pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-407-fts-reentry-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  // A real store-built library: schema (asset_fts, library_meta) comes from the
  // actual initialization path. Closed before the raw connection below opens,
  // so that connection is the only handle the maintenance pass sees.
  const store = createSqliteAssetStore({
    projectRoot: join(root, "project"),
    managerDir: join(root, "project", "mosa"),
    libraryDir: join(root, "library"),
  });
  store.close();

  const database = new Database(join(root, "library", "mosa.db"));
  try {
    // Cross the rewrite threshold so the first call is due (500 is the
    // module-internal threshold; seeded through the same library_meta row the
    // runtime accumulates into).
    database.prepare(`
      INSERT INTO library_meta (key, value, updated_at) VALUES ('fts_rewrite_count', '600', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(new Date().toISOString());

    // One full pass executes exactly one optimize statement, so counting
    // optimize execs distinguishes "the second call never ran" from "both ran".
    let optimizeCount = 0;
    const rawExec = database.exec.bind(database);
    database.exec = (sql) => {
      if (String(sql).includes("VALUES('optimize')")) optimizeCount += 1;
      return rawExec(sql);
    };

    const first = runFtsMergeMaintenance(database);
    const second = runFtsMergeMaintenance(database);
    await Promise.all([first, second]);

    assert.equal(optimizeCount, 1, `the guarded second call must not run its own optimize pass (optimize ran ${optimizeCount} times)`);
    assert.ok(
      database.prepare("SELECT value FROM library_meta WHERE key = 'fts_merge_last_at'").get()?.value,
      "the first call really ran and wrote fts_merge_last_at",
    );
    assert.equal(
      database.prepare("SELECT value FROM library_meta WHERE key = 'fts_rewrite_count'").get()?.value,
      "0",
      "the rewrite counter reset after the first pass",
    );
  } finally {
    database.close();
  }
});
