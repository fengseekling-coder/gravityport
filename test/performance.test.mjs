import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";

// Task 347 (audit 261 batch 5): a steady-state 20k library must reopen fast —
// every whole-library probe/repair moved off the open path behind the
// derived:* / one-time markers, so a normal reopen pays neither. The first
// open (and any open whose markers are missing) still runs its background
// sweeps after startDeferredMaintenance, which is exactly the rule-27
// contract; this test pins the reopen budget.
test("20k library reopens in under 500ms with all maintenance markers in place", { skip: process.env.MOSA_PERF_TEST !== "1" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-perf-reopen-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const libraryDir = join(root, "library");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  const bootstrap = createSqliteAssetStore({ projectRoot, managerDir, libraryDir });
  bootstrap.close();

  const filler = "整理 红色机械未来城市 red mechanical future city variant ";
  const searchFiller = filler.repeat(60); // ≈2KB of search text per asset
  const timestamp = new Date().toISOString();
  const timestampEpoch = Date.parse(timestamp);
  const database = new Database(join(libraryDir, "mosa.db"));
  database.prepare("INSERT INTO projects (id, created_at) VALUES ('default', ?)").run(timestamp);
  const insertAsset = database.prepare(`
    INSERT INTO assets (
      project_id, id, asset, original_path, content_sha256, prompt, skill, style, ratio, business_fields_json, theme,
      favorite, archived, group_name, category, rating, version_change, source_type, source_json, metadata_json, search_text,
      tags_text, business_search_text, source_search_text, media_kind, source_group, conversation_id, generation_session_key, generation_batch,
      created_at, created_at_epoch, updated_at, sort_name
    ) VALUES (
      'default', @id, @asset, '/bench', 'bench', @filler, '', @style, '', '{}', '',
      @favorite, @archived, 'group-bench', 'category-bench', 0, '', 'web-chatgpt', @source, '{}', @searchText,
      '', '', 'web-chatgpt', @mediaKind, 'web-chatgpt', @conversation, @sessionKey, 'batch',
      @created, @epoch, @created, @sortName
    )
  `);
  // Task 348: short terms key on the doc id now; the FTS row rides it as its rowid.
  const insertDoc = database.prepare("INSERT INTO asset_search_docs (project_id, asset_id) VALUES ('default', ?)");
  const insertFts = database.prepare("INSERT INTO asset_fts (rowid, project_id, asset_id, content) VALUES (?, 'default', ?, ?)");
  const insertShortTerm = database.prepare("INSERT INTO asset_search_terms (term, doc_id) VALUES (?, ?)");
  const insertStack = database.prepare(`
    INSERT INTO asset_stacks (project_id, id, created_at, updated_at, sort_created_at, sort_name, name)
    VALUES ('default', ?, ?, ?, ?, ?, ?)
  `);
  const insertStackMember = database.prepare(`
    INSERT INTO asset_stack_members (project_id, stack_id, asset_id, position, added_at)
    VALUES ('default', ?, ?, ?, ?)
  `);
  database.transaction(() => {
    for (let index = 0; index < 20_000; index += 1) {
      const id = `bench-${index}`;
      const trashed = index % 20 === 0; // 5% in the trash
      const conversation = `conversation-${index % 100}`;
      insertAsset.run({
        id,
        asset: `${id}.png`,
        filler,
        style: `style-${index % 20}`,
        favorite: index % 17 === 0 ? 1 : 0,
        archived: 0,
        searchText: `${searchFiller} ${index}`,
        mediaKind: index % 30 === 0 ? "video" : "image",
        conversation,
        sessionKey: index % 4 === 0 ? `web-chatgpt:${conversation}` : "",
        source: JSON.stringify({ type: "web-chatgpt", conversation_id: conversation }),
        created: timestamp,
        epoch: timestampEpoch,
        sortName: id,
      });
      const docId = insertDoc.run(id).lastInsertRowid;
      insertFts.run(docId, id, `${searchFiller} ${index}`);
      insertShortTerm.run("机械", docId);
      insertShortTerm.run("未来", docId);
    }
    for (let stack = 0; stack < 600; stack += 1) {
      const stackId = `bench-stack-${stack}`;
      insertStack.run(stackId, timestamp, timestamp, timestamp, stackId, `Bench Stack ${stack}`);
      for (let position = 0; position < 5; position += 1) {
        insertStackMember.run(stackId, `bench-${stack * 5 + position}`, position, timestamp);
      }
    }
  })();
  database.close();

  // First open runs every background sweep once (markers written), so the
  // measured reopen below sees the steady state.
  const first = createSqliteAssetStore({ projectRoot, managerDir, libraryDir });
  await first.startDeferredMaintenance();
  first.close();

  const reopenSamples = [];
  for (let sample = 0; sample < 5; sample += 1) {
    const started = performance.now();
    const reopened = createSqliteAssetStore({ projectRoot, managerDir, libraryDir });
    reopenSamples.push(performance.now() - started);
    reopened.close();
  }
  reopenSamples.sort((a, b) => a - b);
  const median = reopenSamples[2];
  t.diagnostic(`20k reopen samples=${reopenSamples.map((value) => value.toFixed(1)).join(",")} median=${median.toFixed(1)}ms`);
  assert.ok(median < 500, `20k reopen median ${median.toFixed(1)}ms exceeded 500ms`);
});

test("50k SQLite library uses indexed filters, starts under 3s, and keeps search P95 under 100ms", { skip: process.env.MOSA_PERF_TEST !== "1" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-perf-"));
  // Windows can keep SQLite WAL/SHM handles alive for a short moment after
  // close (and Defender may briefly inspect them). Retry the cleanup instead
  // of turning an otherwise-passing performance run red with EBUSY/EPERM.
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const libraryDir = join(root, "library");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  const store = createSqliteAssetStore({ projectRoot, managerDir, libraryDir });
  store.close();
  const database = new Database(join(libraryDir, "mosa.db"));
  const timestamp = new Date().toISOString();
  const timestampEpoch = Date.parse(timestamp);
  database.prepare("INSERT INTO projects (id, created_at) VALUES ('default', ?)").run(timestamp);
  const insertAsset = database.prepare(`
    INSERT INTO assets (
      project_id, id, asset, original_path, content_sha256, prompt, skill, style, ratio, business_fields_json, theme,
      favorite, archived, group_name, category, rating, version_change, source_type, source_json, metadata_json, search_text,
      tags_text, business_search_text, source_search_text, media_kind, source_group, conversation_id, generation_batch,
      created_at, created_at_epoch, updated_at, sort_name
    ) VALUES (
      @project_id, @id, @asset, @original_path, 'benchmark', @prompt, '', @style, '', '{}', '',
      @favorite, 0, @group_name, @category, 0, '', 'web-chatgpt', '{"type":"web-chatgpt"}', '{}', @search_text,
      '', '', 'web-chatgpt', @media_kind, 'web-chatgpt', @conversation_id, @generation_batch,
      @created_at, @created_at_epoch, @updated_at, @sort_name
    )
  `);
  // Task 348: short terms key on the doc id now; the FTS row rides it as its rowid.
  const insertDoc = database.prepare("INSERT INTO asset_search_docs (project_id, asset_id) VALUES ('default', ?)");
  const insertFts = database.prepare("INSERT INTO asset_fts (rowid, project_id, asset_id, content) VALUES (?, 'default', ?, ?)");
  const insertShortTerm = database.prepare("INSERT INTO asset_search_terms (term, doc_id) VALUES (?, ?)");
  database.transaction(() => {
    for (let index = 0; index < 50_000; index += 1) {
      const id = `asset-${index}`;
      const content = `red mechanical future city 机械 未来 variant ${index}`;
      insertAsset.run({
        project_id: "default",
        id,
        asset: `${id}.png`,
        original_path: `/bench/${id}.png`,
        prompt: content,
        style: `style-${index % 20}`,
        favorite: index % 17 === 0 ? 1 : 0,
        group_name: `group-${index % 25}`,
        category: `category-${index % 10}`,
        search_text: content,
        media_kind: index % 4 === 0 ? "video" : "image",
        conversation_id: `conversation-${index % 100}`,
        generation_batch: `batch-${index % 10}`,
        created_at: timestamp,
        created_at_epoch: timestampEpoch,
        updated_at: timestamp,
        sort_name: id,
      });
      const docId = insertDoc.run(id).lastInsertRowid;
      insertFts.run(docId, id, content);
      insertShortTerm.run("机械", docId);
      insertShortTerm.run("未来", docId);
    }
  })();
  const planDetails = (sql, ...params) => database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => row.detail).join("\n");
  const plans = [
    ["conversation", planDetails("SELECT id FROM assets WHERE project_id = ? AND archived = 0 AND conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 101", "default", "conversation-7"), "assets_project_conversation_idx"],
    ["batch", planDetails("SELECT id FROM assets WHERE project_id = ? AND archived = 0 AND conversation_id = ? AND generation_batch = ? ORDER BY created_at DESC, id DESC LIMIT 101", "default", "conversation-7", "batch-7"), "assets_project_conversation_batch_idx"],
    ["source", planDetails("SELECT id FROM assets WHERE project_id = ? AND deleted_at IS NULL AND archived = 0 AND source_group = ? ORDER BY created_at DESC, id DESC LIMIT 101", "default", "web-chatgpt"), "assets_project_source_group_live_idx"],
    ["media", planDetails("SELECT id FROM assets WHERE project_id = ? AND deleted_at IS NULL AND archived = 0 AND media_kind = ? ORDER BY created_at DESC, id DESC LIMIT 101", "default", "video"), "assets_project_media_kind_live_idx"],
    ["group", planDetails("SELECT id FROM assets WHERE project_id = ? AND archived = 0 AND group_name = ? ORDER BY created_at DESC, id DESC LIMIT 101", "default", "group-7"), "assets_project_group_created_idx"],
    ["category", planDetails("SELECT id FROM assets WHERE project_id = ? AND deleted_at IS NULL AND archived = 0 AND category = ? ORDER BY created_at DESC, id DESC LIMIT 101", "default", "category-7"), "assets_project_category_live_idx"],
    ["style", planDetails("SELECT id FROM assets WHERE project_id = ? AND archived = 0 AND style = ? ORDER BY created_at DESC, id DESC LIMIT 101", "default", "style-7"), "assets_project_style_created_idx"],
    ["favorite", planDetails("SELECT id FROM assets WHERE project_id = ? AND archived = 0 AND (rating > 0 OR favorite = 1) ORDER BY created_at DESC, id DESC LIMIT 101", "default"), "assets_project_favorite_created_idx"],
  ];
  for (const [name, plan, indexName] of plans) {
    assert.match(plan, new RegExp(indexName), `${name} plan must use ${indexName}: ${plan}`);
    assert.doesNotMatch(plan, /USE TEMP B-TREE FOR ORDER BY/, `${name} plan must preserve index order: ${plan}`);
  }
  database.close();

  const startupStarted = performance.now();
  const reopened = createSqliteAssetStore({ projectRoot, managerDir, libraryDir });
  const startupMs = performance.now() - startupStarted;
  t.after(() => reopened.close());
  // Warm the two query shapes before measuring steady-state latency. With only
  // 20 samples, counting both first-use statement/FTS cache fills makes P95 the
  // second coldest request and turns scheduler noise into a false regression.
  // The 100ms budget below is unchanged.
  for (const query of ["mechanical", "future city"]) {
    const result = await reopened.listAssetPage({ projectId: "default", query, limit: 100 });
    assert.equal(result.page.total, 50_000);
  }
  const samples = [];
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    const result = await reopened.listAssetPage({ projectId: "default", query: index % 2 ? "mechanical" : "future city", limit: 100 });
    samples.push(performance.now() - started);
    assert.equal(result.page.total, 50_000);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  const coldSearchSamples = [];
  for (let index = 0; index < 10; index += 1) {
    const started = performance.now();
    const result = await reopened.listAssetPage({ projectId: "default", query: `mechanical variant ${1000 + index}`, limit: 100 });
    coldSearchSamples.push(performance.now() - started);
    assert.ok(result.assets.length > 0);
  }
  coldSearchSamples.sort((a, b) => a - b);
  const coldSearchP95 = coldSearchSamples[Math.ceil(coldSearchSamples.length * 0.95) - 1];
  const shortCjkSamples = [];
  for (let index = 0; index < 10; index += 1) {
    const started = performance.now();
    const result = await reopened.listAssetPage({ projectId: "default", query: index % 2 ? "机械" : "未来", limit: 100 });
    shortCjkSamples.push(performance.now() - started);
    assert.equal(result.page.total, 50_000);
  }
  shortCjkSamples.sort((a, b) => a - b);
  const shortCjkP95 = shortCjkSamples[Math.ceil(shortCjkSamples.length * 0.95) - 1];
  const filterCases = [
    ["conversation", { conversation: "conversation-7" }],
    ["conversation+batch", { conversation: "conversation-7", generationBatch: "batch-7" }],
    ["source", { source: "web-chatgpt" }],
    ["media", { mediaKind: "video" }],
    ["group", { group: "group-7" }],
    ["category", { category: "category-7" }],
    ["style", { style: "style-7" }],
    ["favorite", { favorite: true }],
  ];
  for (const [, filters] of filterCases) {
    const result = await reopened.listAssetPage({ projectId: "default", ...filters, limit: 100 });
    assert.ok(result.assets.length > 0);
  }
  const filterP95ByCase = new Map();
  for (const [name, filters] of filterCases) {
    const caseSamples = [];
    for (let sample = 0; sample < 20; sample += 1) {
      const started = performance.now();
      const result = await reopened.listAssetPage({ projectId: "default", ...filters, limit: 100 });
      caseSamples.push(performance.now() - started);
      assert.ok(result.assets.length > 0);
    }
    caseSamples.sort((a, b) => a - b);
    const caseP95 = caseSamples[Math.ceil(caseSamples.length * 0.95) - 1];
    filterP95ByCase.set(name, caseP95);
    t.diagnostic(`indexed filter ${name} P95=${caseP95.toFixed(1)}ms samples=${caseSamples.map((value) => value.toFixed(1)).join(",")}`);
  }
  const slowestFilter = [...filterP95ByCase.entries()].sort((left, right) => right[1] - left[1])[0];
  const fullList = await reopened.listAssets({ projectId: "default" });
  assert.equal(fullList.length, 50_000, "full 50k listings must not exceed SQLite's bound-variable limit");

  // Add a realistic Stack distribution only after the ordinary search/filter
  // baseline. This keeps those budgets comparable to previous releases while
  // still exercising the distinct collapsed-gallery query shape at 50k scale.
  const stackDatabase = new Database(join(libraryDir, "mosa.db"));
  const insertStack = stackDatabase.prepare(`
    INSERT INTO asset_stacks (project_id, id, created_at, updated_at, sort_created_at, sort_name, name)
    VALUES ('default', ?, ?, ?, ?, ?, ?)
  `);
  const insertStackMember = stackDatabase.prepare(`
    INSERT INTO asset_stack_members (project_id, stack_id, asset_id, position, added_at)
    VALUES ('default', ?, ?, ?, ?)
  `);
  stackDatabase.transaction(() => {
    for (let stackIndex = 0; stackIndex < 2_000; stackIndex += 1) {
      const stackId = `benchmark-stack-${stackIndex}`;
      const name = `Benchmark Stack ${stackIndex}`;
      insertStack.run(stackId, timestamp, timestamp, timestamp, name.toLowerCase(), name);
      for (let position = 0; position < 5; position += 1) {
        insertStackMember.run(stackId, `asset-${stackIndex * 5 + position}`, position, timestamp);
      }
    }
  })();
  stackDatabase.close();

  const collapsedSamples = [];
  for (let index = 0; index < 3; index += 1) {
    const started = performance.now();
    const result = await reopened.listAssetPage({ projectId: "default", collapseStacks: true, limit: 100, sort: "newest" });
    collapsedSamples.push(performance.now() - started);
    assert.equal(result.page.total, 42_000);
    assert.equal(result.assets.length, 100);
  }
  collapsedSamples.sort((a, b) => a - b);
  const collapsedP95 = collapsedSamples[Math.ceil(collapsedSamples.length * 0.95) - 1];
  const stackNameSearch = await reopened.listAssetPage({ projectId: "default", collapseStacks: true, query: "benchmark stack 1999", limit: 100 });
  assert.equal(stackNameSearch.page.total, 1);
  assert.equal(stackNameSearch.assets[0]?.stack?.name, "Benchmark Stack 1999");
  t.diagnostic(`cold search P95=${coldSearchP95.toFixed(1)}ms samples=${coldSearchSamples.map((value) => value.toFixed(1)).join(",")}`);
  t.diagnostic(`short CJK search P95=${shortCjkP95.toFixed(1)}ms samples=${shortCjkSamples.map((value) => value.toFixed(1)).join(",")}`);
  t.diagnostic(`collapsed gallery P95=${collapsedP95.toFixed(1)}ms samples=${collapsedSamples.map((value) => value.toFixed(1)).join(",")}`);
  assert.ok(startupMs < 3000, `startup ${startupMs.toFixed(1)}ms exceeded 3000ms`);
  assert.ok(p95 < 100, `search P95 ${p95.toFixed(1)}ms exceeded 100ms`);
  assert.ok(coldSearchP95 < 150, `cold search P95 ${coldSearchP95.toFixed(1)}ms exceeded 150ms`);
  assert.ok(shortCjkP95 < 150, `short CJK search P95 ${shortCjkP95.toFixed(1)}ms exceeded 150ms`);
  assert.ok(collapsedP95 < 500, `collapsed gallery P95 ${collapsedP95.toFixed(1)}ms exceeded 500ms`);
  assert.ok(slowestFilter[1] < 50,
    `indexed-filter ${slowestFilter[0]} P95 ${slowestFilter[1].toFixed(1)}ms exceeded 50ms; ${[...filterP95ByCase.entries()].map(([name, value]) => `${name}=${value.toFixed(1)}ms`).join(", ")}`);
});
