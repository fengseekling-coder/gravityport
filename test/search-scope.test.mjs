import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";

import { createAssetStore } from "../lib/asset-store.mjs";
import { SEARCH_SCOPE_MARKER_KEY, rebuildSearchScopeTexts } from "../lib/asset-search-scope.mjs";
import { createSqliteAssetStore, sqliteDatabasePath } from "../lib/sqlite-asset-store.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");
const LEGACY_CREATED = "2024-03-04T00:00:00.000Z";
const LIB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "lib");

async function createProjectRoot(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  return root;
}

function openSqliteStore(t, root) {
  const store = createSqliteAssetStore({
    projectRoot: join(root, "project"),
    managerDir: join(root, "project", "mosa"),
    libraryDir: join(root, "library"),
  });
  t.after(() => store.close());
  return store;
}

function withRawDatabase(libraryDir, task) {
  const database = new Database(sqliteDatabasePath(libraryDir));
  try {
    return task(database);
  } finally {
    database.close();
  }
}

function markerValue(libraryDir) {
  return withRawDatabase(libraryDir, (database) =>
    database.prepare("SELECT value FROM library_meta WHERE key = ?").get(SEARCH_SCOPE_MARKER_KEY)?.value || null,
  );
}

// Seeds a row exactly the way pre-whitelist writers left it: search_text and
// the two scoring columns carry the original file path, the content hash and
// the copied_at timestamp, and the FTS row + short terms are derived from that
// text.
function insertLegacyAssetRow(database, { id, asset, prompt, source, deletedAt = null }) {
  const sourceJson = JSON.stringify(source);
  const legacySearchText = [
    id, asset, prompt,
    source.path || "", source.type || "", source.content_sha256 || "", source.copied_at || "",
  ].filter(Boolean).join(" ");
  const legacySourceSearchText = [source.path, source.content_sha256, source.copied_at].filter(Boolean).join("\u001f");
  database.prepare(`
    INSERT INTO assets (
      project_id, id, asset, original_path, content_sha256, prompt, skill, style, ratio, business_fields_json, theme,
      favorite, archived, group_name, category, rating, parent_asset_id, version_change, deleted_at, source_type,
      source_json, source_path, provider_asset_id, logical_output_id, metadata_json, search_text, tags_text,
      business_search_text, source_search_text, media_kind, source_group, conversation_id, generation_batch,
      created_at, created_at_epoch, updated_at, sort_name
    ) VALUES (
      'default', @id, @asset, @originalPath, @hash, @prompt, '', '', '', '{}', '',
      0, 0, '', '', 0, NULL, '', @deletedAt, @sourceType,
      @sourceJson, '', '', '', '{}', @searchText, '',
      '', @sourceSearchText, 'image', @sourceGroup, '', '',
      @createdAt, @epoch, @createdAt, @id
    )
  `).run({
    id,
    asset,
    originalPath: source.path || `/legacy/${asset}`,
    hash: source.content_sha256 || `hash-${id}`,
    prompt,
    deletedAt,
    sourceType: source.type || "local-file",
    sourceJson,
    searchText: legacySearchText,
    sourceSearchText: legacySourceSearchText,
    sourceGroup: source.type || "local-file",
    createdAt: LEGACY_CREATED,
    epoch: Date.parse(LEGACY_CREATED),
  });
  const docId = database
    .prepare("INSERT INTO asset_search_docs (project_id, asset_id) VALUES ('default', ?)")
    .run(id).lastInsertRowid;
  // Task 348: the FTS row rides the doc id as its rowid.
  database.prepare("INSERT INTO asset_fts (rowid, project_id, asset_id, content) VALUES (?, 'default', ?, ?)").run(docId, id, legacySearchText);
  return { legacySearchText, docId };
}

async function seedLegacyLibrary(t, root) {
  const libraryDir = join(root, "library");
  const bootstrap = createSqliteAssetStore({
    projectRoot: join(root, "project"),
    managerDir: join(root, "project", "mosa"),
    libraryDir,
  });
  bootstrap.close();
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      database.prepare("DELETE FROM library_meta WHERE key = ?").run(SEARCH_SCOPE_MARKER_KEY);
      const liveDocId = insertLegacyAssetRow(database, {
        id: "legacy-live",
        asset: "legacy-harbor.png",
        prompt: "lantern harbor study",
        source: {
          type: "local-file",
          path: "/tmp/zqx9-藏经阁/legacy-harbor.png",
          content_sha256: "deadbeefcafe0123456789abcdef",
          copied_at: LEGACY_CREATED,
        },
      }).docId;
      insertLegacyAssetRow(database, {
        id: "legacy-trash",
        asset: "legacy-trashed.png",
        prompt: "trashed lantern study",
        source: {
          type: "local-file",
          path: "/tmp/zqx9-藏经阁/legacy-trashed.png",
          content_sha256: "feedface0123456789abcdef",
          copied_at: LEGACY_CREATED,
        },
        deletedAt: "2026-01-01T00:00:00.000Z",
      });
      for (const term of ["藏经", "经阁", "藏"]) {
        database.prepare("INSERT INTO asset_search_terms (term, doc_id) VALUES (?, ?)").run(term, liveDocId);
      }
    })();
  });
  return libraryDir;
}

// Captures console.warn lines for the duration of task() so the one-line
// skip warnings from the open path can be asserted exactly.
function captureWarns(task) {
  const warns = [];
  const original = console.warn;
  console.warn = (...parts) => { warns.push(parts.map(String).join(" ")); };
  try {
    task();
  } finally {
    console.warn = original;
  }
  return warns;
}

// Same technique as test/open-repair-guard.test.mjs: fail exactly the target
// one-time step's transaction the way a blocked BEGIN IMMEDIATE does.
function failOneTimeStepTransactionWithBusy(stepConstantName) {
  const original = Database.prototype.transaction;
  let intercepted = false;
  Database.prototype.transaction = function patchedTransaction(fn, ...rest) {
    if (!intercepted && String(fn).includes(stepConstantName)) {
      intercepted = true;
      Database.prototype.transaction = original;
      const busy = new Error("database is locked");
      busy.code = "SQLITE_BUSY";
      throw busy;
    }
    return original.call(this, fn, ...rest);
  };
  return {
    get intercepted() { return intercepted; },
    restore() { Database.prototype.transaction = original; },
  };
}

test("manual imports are searchable by visible fields only", async (t) => {
  const root = await createProjectRoot(t, "mosa-zqx7-import-");
  const projectRoot = join(root, "project");
  const imagePath = join(projectRoot, "generated-images", "harbor-lookout.png");
  await mkdir(dirname(imagePath), { recursive: true });
  await writeFile(imagePath, ONE_PIXEL_PNG);
  const store = openSqliteStore(t, root);

  const asset = await store.createAsset({
    assetId: "harbor-lookout",
    imagePath,
    prompt: "foggy harbor lookout at dawn",
    tags: ["Seascape"],
    group: "Harbor Studies",
  });
  assert.equal(asset.source.type, "local-file");
  const hash8 = asset.source.content_sha256.slice(0, 8);
  const copiedYear = String(asset.source.copied_at).slice(0, 4);
  const hits = async (query) => (await store.listAssets({ projectId: "default", query })).map((entry) => entry.id);

  assert.deepEqual(await hits("harbor-lookout"), ["harbor-lookout"], "file name");
  assert.deepEqual(await hits("harbor"), ["harbor-lookout"], "file name stem");
  assert.deepEqual(await hits("seascape"), ["harbor-lookout"], "tag");
  assert.deepEqual(await hits("harbor studies"), ["harbor-lookout"], "group name");
  assert.deepEqual(await hits("lookout"), ["harbor-lookout"], "prompt word");
  assert.deepEqual(await hits("zqx7"), [], "import folder name in the original path");
  assert.deepEqual(await hits("local"), [], "raw source type");
  assert.deepEqual(await hits("copy"), [], "storage mode");
  assert.deepEqual(await hits(hash8), [], "content hash prefix");
  assert.deepEqual(await hits(copiedYear), [], "copy timestamp year");
});

test("web capture internals stay out of search while instruction, model and provider match", async (t) => {
  const root = await createProjectRoot(t, "mosa-search-scope-capture-");
  const projectRoot = join(root, "project");
  // A non-.png extension keeps the mime-type assertion honest: "png" then
  // appears only inside the stored mime_type value, never in the file name.
  const imagePath = join(projectRoot, "generated-images", "lantern-capture.jpeg");
  await mkdir(dirname(imagePath), { recursive: true });
  await writeFile(imagePath, ONE_PIXEL_PNG);
  const store = openSqliteStore(t, root);

  await store.createAsset({
    assetId: "lantern-capture",
    imagePath,
    prompt: "tangerine lantern festival poster",
    source: {
      type: "web-chatgpt",
      provider: "chatgpt",
      model: "imagenium v2",
      user_message: "make the lanterns glow warm",
      generation_request_prompt: "tangerine lantern festival poster",
      capture_mode: "observed",
      verification_level: "observed",
      capture_channel: "web-ui",
      page_url: "chrome-extension://extend-id/page.html",
      message_id: "msg-9182",
      conversation_id: "conv-9182",
      captured_at: "2026-10-10T00:00:00.000Z",
    },
    business_fields: {
      user_message: "make the lanterns glow warm",
      mime_type: "image/png",
      width: 1536,
      height: 1024,
      file_bytes: 48213,
      capture_channel: "web-ui",
      generation_status: "observed",
    },
  });
  const hits = async (query) => (await store.listAssets({ projectId: "default", query })).map((entry) => entry.id);

  assert.deepEqual(await hits("lantern"), ["lantern-capture"], "file name stem");
  assert.deepEqual(await hits("tangerine"), ["lantern-capture"], "prompt / request prompt");
  assert.deepEqual(await hits("glow"), ["lantern-capture"], "user instruction word");
  assert.deepEqual(await hits("imagenium"), ["lantern-capture"], "model name");
  assert.deepEqual(await hits("chatgpt"), ["lantern-capture"], "provider value and display name");
  assert.deepEqual(await hits("observed"), [], "capture/verification status");
  assert.deepEqual(await hits("chrome-extension"), [], "page url scheme");
  assert.deepEqual(await hits("web-ui"), [], "capture channel");
  assert.deepEqual(await hits("1536"), [], "image width");
  assert.deepEqual(await hits("1024"), [], "image height");
  assert.deepEqual(await hits("48213"), [], "file byte size");
  assert.deepEqual(await hits("msg-9182"), [], "message id");
  assert.deepEqual(await hits("conv-9182"), [], "conversation id");
  assert.deepEqual(await hits("png"), [], "mime type");
});

test("codex images are searchable by the source display name, not by session paths", async (t) => {
  const root = await createProjectRoot(t, "mosa-search-scope-codex-");
  const projectRoot = join(root, "project");
  const imagePath = join(projectRoot, "generated-images", "codex-stair.png");
  await mkdir(dirname(imagePath), { recursive: true });
  await writeFile(imagePath, ONE_PIXEL_PNG);
  const store = openSqliteStore(t, root);

  await store.createAsset({
    assetId: "codex-stair",
    imagePath,
    prompt: "brutalist museum stair study",
    source: {
      type: "codex-generated",
      generation_tool: "codex-imagegen",
      codex_task_id: "task-4411",
      codex_session_path: "/Users/dev/.codex/sessions/zqx8-rollout-session.jsonl",
      codex_output_file: "output-4411.png",
      model: "gpt-image-2",
    },
  });
  const hits = async (query) => (await store.listAssets({ projectId: "default", query })).map((entry) => entry.id);

  assert.deepEqual(await hits("codex"), ["codex-stair"], "source display name");
  assert.deepEqual(await hits("gpt-image-2"), ["codex-stair"], "model name");
  assert.deepEqual(await hits("stair"), ["codex-stair"], "prompt word");
  assert.deepEqual(await hits("zqx8"), [], "session path directory name");
  assert.deepEqual(await hits("rollout-session"), [], "session file name");
  assert.deepEqual(await hits("task-4411"), [], "codex task id");
});

test("CJK short-term and full-text search paths both follow the whitelist", async (t) => {
  const root = await createProjectRoot(t, "mosa-search-scope-cjk-");
  const projectRoot = join(root, "project");
  const imagePath = join(projectRoot, "generated-images", "bamboo-tea.png");
  await mkdir(dirname(imagePath), { recursive: true });
  await writeFile(imagePath, ONE_PIXEL_PNG);
  const store = openSqliteStore(t, root);

  await store.createAsset({
    assetId: "bamboo-tea",
    imagePath,
    prompt: "竹编茶盘静物",
    business_fields: { internal_note: "藏经阁深处" },
  });
  const hits = async (query) => (await store.listAssets({ projectId: "default", query })).map((entry) => entry.id);

  assert.deepEqual(await hits("竹"), ["bamboo-tea"], "single CJK char goes through the short-term table");
  assert.deepEqual(await hits("竹编"), ["bamboo-tea"], "two CJK chars go through the short-term table");
  assert.deepEqual(await hits("竹编茶盘"), ["bamboo-tea"], "three-plus CJK chars go through full-text search");
  assert.deepEqual(await hits("茶盘"), ["bamboo-tea"], "two CJK chars from the prompt tail");
  assert.deepEqual(await hits("藏经"), [], "non-whitelisted business value, short-term path");
  assert.deepEqual(await hits("经阁"), [], "non-whitelisted business value, short-term path");
  assert.deepEqual(await hits("藏经阁"), [], "non-whitelisted business value, full-text path");
  assert.deepEqual(await hits("深处"), [], "non-whitelisted business value, full-text path");
});

test("opening an old library rebuilds search text once under the whitelist", async (t) => {
  const root = await createProjectRoot(t, "mosa-search-scope-rebuild-");
  const libraryDir = await seedLegacyLibrary(t, root);
  const hits = async (store, query) => (await store.listAssets({ projectId: "default", query })).map((entry) => entry.id);

  const updatedAtBefore = withRawDatabase(libraryDir, (database) =>
    database.prepare("SELECT updated_at FROM assets WHERE id = 'legacy-live'").get().updated_at);

  const store = openSqliteStore(t, root);
  // Task 347: the rebuild runs from deferred maintenance after the open, not
  // on the open path any more.
  await store.startDeferredMaintenance();
  assert.ok(markerValue(libraryDir), "the rebuild marker is written");

  assert.deepEqual(await hits(store, "zqx9"), [], "legacy path fragments leave search");
  assert.deepEqual(await hits(store, "藏经"), [], "legacy path CJK leaves the short-term table");
  assert.deepEqual(await hits(store, "藏经阁"), [], "legacy path CJK leaves full-text search");
  assert.deepEqual(await hits(store, "deadbeef"), [], "legacy content hash leaves search");
  assert.deepEqual(await hits(store, "2024"), [], "legacy copy timestamp leaves search");
  assert.deepEqual(await hits(store, "legacy-harbor"), ["legacy-live"], "file name still matches");
  assert.deepEqual(await hits(store, "lantern"), ["legacy-live"], "prompt still matches");
  assert.deepEqual(await hits(store, "legacy-trashed"), [], "trashed row stays out of page results");

  withRawDatabase(libraryDir, (database) => {
    const live = database.prepare("SELECT search_text, source_search_text, business_search_text, updated_at FROM assets WHERE id = 'legacy-live'").get();
    assert.doesNotMatch(live.search_text, /zqx9|藏经阁|deadbeef/, "rebuilt search text carries no internal values");
    assert.equal(live.source_search_text, "", "local-file rows get no source scoring text");
    assert.equal(live.updated_at, updatedAtBefore, "rebuild never touches updated_at");
    const ftsRows = database.prepare("SELECT asset_id, content FROM asset_fts WHERE project_id = 'default' AND asset_id IN ('legacy-live', 'legacy-trash')").all();
    assert.deepEqual(ftsRows, [{ asset_id: "legacy-live", content: live.search_text }],
      "the live FTS row holds the rebuilt text and the trashed row has no FTS row");
    const shortTerms = database.prepare(`
      SELECT COUNT(*) AS count
      FROM asset_search_terms st
      JOIN asset_search_docs d ON d.doc_id = st.doc_id
      WHERE d.project_id = 'default' AND d.asset_id = 'legacy-live'
    `).get();
    assert.equal(shortTerms.count, 0, "short terms are rebuilt from the whitelisted text (ASCII only here)");
    const trashText = database.prepare("SELECT search_text FROM assets WHERE id = 'legacy-trash'").get();
    assert.doesNotMatch(trashText.search_text, /zqx9|feedface/, "the trashed row's columns are rebuilt too");
  });

  // A second old-style row after the rebuild must survive untouched: the
  // marker makes every later open a no-op. (Probed on the stored column: a
  // raw UPDATE cannot keep the FTS row in sync, so search is the wrong probe.)
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      const legacy = database.prepare("SELECT search_text FROM assets WHERE id = 'legacy-live'").get();
      database.prepare("UPDATE assets SET search_text = ? WHERE id = 'legacy-live'").run(`${legacy.search_text} zqx9-again`);
    })();
  });
  store.close();

  const secondOpen = openSqliteStore(t, root);
  await secondOpen.startDeferredMaintenance();
  withRawDatabase(libraryDir, (database) => {
    const row = database.prepare("SELECT search_text FROM assets WHERE id = 'legacy-live'").get();
    assert.match(row.search_text, /zqx9-again/, "no second rebuild once the marker is set");
  });
  assert.ok(markerValue(libraryDir), "the marker stays");
});

test("a BUSY failure during the rebuild is one warning, the open survives, and the next open retries", async (t) => {
  const root = await createProjectRoot(t, "mosa-search-scope-busy-");
  const libraryDir = await seedLegacyLibrary(t, root);
  const hits = async (store, query) => (await store.listAssets({ projectId: "default", query })).map((entry) => entry.id);

  let store;
  let stub;
  // Task 347: the rebuild runs in deferred maintenance now, so the BUSY stub
  // and the warn capture must span startDeferredMaintenance as well.
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...parts) => { warns.push(parts.map(String).join(" ")); };
  try {
    stub = failOneTimeStepTransactionWithBusy("SEARCH_SCOPE_MARKER_KEY");
    try {
      store = createSqliteAssetStore({
        projectRoot: join(root, "project"),
        managerDir: join(root, "project", "mosa"),
        libraryDir,
      });
      await store.startDeferredMaintenance();
    } finally {
      stub.restore();
    }
  } finally {
    console.warn = originalWarn;
  }
  t.after(() => store.close());
  assert.ok(stub.intercepted, "the rebuild transaction was the one that failed");
  assert.ok(
    warns.some((line) => line.includes("one-time search-scope rebuild skipped") && line.includes("SQLITE_BUSY")),
    `expected the skip warning, got: ${JSON.stringify(warns)}`,
  );
  assert.equal(markerValue(libraryDir), null, "the failed rebuild writes no marker");
  assert.deepEqual(await hits(store, "zqx9"), ["legacy-live"], "the old text is untouched after the failed open");

  store.close();
  const retried = openSqliteStore(t, root);
  await retried.startDeferredMaintenance();
  assert.deepEqual(await hits(retried, "zqx9"), [], "the next open rebuilds");
  assert.ok(markerValue(libraryDir), "the retried rebuild writes the marker");
});

test("rebuildSearchScopeTexts never runs twice on an already-rebuilt library", async (t) => {
  const root = await createProjectRoot(t, "mosa-search-scope-once-");
  const libraryDir = await seedLegacyLibrary(t, root);
  const rebuilds = [];
  const helpers = {
    loadMetadata: (row) => ({
      id: row.id,
      asset: row.asset,
      prompt: row.prompt,
      skill: row.skill,
      style: row.style,
      theme: row.theme,
      group: row.group_name,
      category: row.category,
      tags: [],
      source: JSON.parse(row.source_json || "{}"),
      business_fields: JSON.parse(row.business_fields_json || "{}"),
    }),
    searchableText: (metadata) => [metadata.id, metadata.asset, metadata.prompt].filter(Boolean).join(" "),
    syncAssetFtsEntry: (projectId, assetId) => rebuilds.push(`fts:${assetId}`),
    replaceAssetShortTerms: (projectId, assetId) => rebuilds.push(`terms:${assetId}`),
  };

  withRawDatabase(libraryDir, (database) => {
    const first = rebuildSearchScopeTexts(database, helpers);
    assert.equal(first.assetsRebuilt, 2, "both legacy rows are rebuilt");
    assert.deepEqual(rebuilds.sort(), ["fts:legacy-live", "fts:legacy-trash", "terms:legacy-live", "terms:legacy-trash"].sort());
    const second = rebuildSearchScopeTexts(database, helpers);
    assert.deepEqual(second, { assetsRebuilt: 0, assetsUnchanged: 0 }, "the marker makes the second run a no-op before any helper fires");
    assert.equal(rebuilds.length, 4, "no FTS or short-term writes happened in the second run");
  });
});

test("the rebuild's marker check sits inside its immediate transaction", () => {
  const source = readFileSync(join(LIB_DIR, "asset-search-scope.mjs"), "utf8");
  // Task 347 added the batched driver after the whole-table original; scope
  // the count to the original so "exactly one immediate transaction" keeps
  // describing rebuildSearchScopeTexts itself.
  const wholeTableStart = source.indexOf("export function rebuildSearchScopeTexts(database");
  const batchedStart = source.indexOf("export async function rebuildSearchScopeTextsBatched(database");
  const wholeTableSource = source.slice(wholeTableStart, batchedStart);
  const transactionStart = wholeTableSource.indexOf("database.transaction(() => {");
  const immediate = wholeTableSource.indexOf(").immediate()");
  const check = "markerQuery.get(SEARCH_SCOPE_MARKER_KEY)";
  const fastPath = wholeTableSource.indexOf(check);
  const lockedCheck = wholeTableSource.indexOf(check, transactionStart);
  assert.ok(transactionStart !== -1 && immediate !== -1 && fastPath !== -1 && lockedCheck !== -1, "all anchors exist");
  // A read-only fast path first, so an already-rebuilt library never takes the
  // write lock on open…
  assert.ok(fastPath < transactionStart, "the marker is read once before any write lock is taken");
  // …and the authoritative re-check under the lock for two racing first opens.
  assert.ok(transactionStart < lockedCheck && lockedCheck < immediate,
    "the marker is re-checked after the write lock is held, so two concurrent opens cannot both rebuild");
  assert.equal((wholeTableSource.match(/\.immediate\(\)/g) || []).length, 1, "the rebuild runs exactly one immediate transaction");
});

test("the in-memory JSON store scores the same whitelist", async (t) => {
  const root = await createProjectRoot(t, "mosa-search-scope-json-");
  const projectRoot = join(root, "project");
  const imagePath = join(projectRoot, "generated-images", "meadow-capture.jpeg");
  await mkdir(dirname(imagePath), { recursive: true });
  await writeFile(imagePath, ONE_PIXEL_PNG);
  const store = createAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa") });
  assert.equal(store.storageKind, "json");

  await store.createAsset({
    assetId: "meadow-capture",
    imagePath,
    prompt: "windy meadow panorama",
    source: {
      type: "web-chatgpt",
      provider: "chatgpt",
      model: "imagenium v2",
      user_message: "windy meadow panorama",
      capture_channel: "web-ui",
      generation_status: "observed",
      page_url: "https://chatgpt.example/backend-api/conversation?token=zqy1",
    },
    business_fields: { user_message: "windy meadow panorama", mime_type: "image/png", width: 1536 },
  });
  const hits = async (query) => (await store.listAssets({ projectId: "default", query })).map((entry) => entry.id);

  assert.deepEqual(await hits("meadow"), ["meadow-capture"], "file name");
  assert.deepEqual(await hits("windy"), ["meadow-capture"], "user instruction");
  assert.deepEqual(await hits("imagenium"), ["meadow-capture"], "model");
  assert.deepEqual(await hits("chatgpt"), ["meadow-capture"], "provider and display name");
  assert.deepEqual(await hits("observed"), [], "status string");
  assert.deepEqual(await hits("web-ui"), [], "capture channel");
  assert.deepEqual(await hits("1536"), [], "width");
  assert.deepEqual(await hits("png"), [], "mime type (jpeg file keeps the assertion honest)");
  assert.deepEqual(await hits("zqy1"), [], "url query fragment");
});
