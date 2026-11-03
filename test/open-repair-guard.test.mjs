import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";

import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { repairCaptureHistory } from "../lib/repair-capture-history.mjs";
import { CLEARED_PROMPT_REPAIR_MARKER_KEY } from "../lib/repair-cleared-prompts.mjs";
import { GENERATION_MESSAGE_BACKFILL_MARKER_KEY } from "../lib/generation-message-binding.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const REPAIR_MARKER_KEY = "repair_capture_user_message_v1";
const DEFAULT_CREATED = "2026-05-01T00:00:00.000Z";
const LIB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "lib");

async function createLibraryRoot(t, prefix = "mosa-open-repair-guard-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  // Bootstrap the schema with a real store open (this runs both one-time
  // passes on the empty library and writes their markers), then seed rows and
  // clear markers through raw connections, the same pattern the
  // repair/backfill test files use.
  const bootstrap = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  bootstrap.close();
  return { projectRoot, libraryDir };
}

function openStore(t, projectRoot, libraryDir) {
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => store.close());
  return store;
}

function withRawDatabase(libraryDir, task) {
  const database = new Database(join(libraryDir, "mosa.db"));
  try {
    return task(database);
  } finally {
    database.close();
  }
}

function markerValue(libraryDir, key) {
  return withRawDatabase(libraryDir, (database) =>
    database.prepare("SELECT value FROM library_meta WHERE key = ?").get(key)?.value || null,
  );
}

function clearMarker(libraryDir, key) {
  withRawDatabase(libraryDir, (database) => {
    database.prepare("DELETE FROM library_meta WHERE key = ?").run(key);
  });
}

// Captures console.warn lines for the duration of task() so the one-line
// skip warnings from the open path can be asserted exactly. Task 347 moved
// the repairs into deferred maintenance, so the async variant spans a
// startDeferredMaintenance() await as well.
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

async function captureWarnsAsync(task) {
  const warns = [];
  const original = console.warn;
  console.warn = (...parts) => { warns.push(parts.map(String).join(" ")); };
  try {
    await task();
  } finally {
    console.warn = original;
  }
  return warns;
}

// BUSY simulation for one open: the store's open path always writes outside
// the one-time steps too (schema ensure UPDATEs), so holding a second
// connection's write lock across the whole open would fail in
// initializeSchema before the one-time step even runs — a different,
// out-of-scope failure. Instead the task's stub option: the transaction call
// whose closure belongs to the target one-time step (identified by the marker
// key constant in its source) fails the way a blocked BEGIN IMMEDIATE does,
// and every other transaction runs unchanged. Self-restores on the throw and
// the caller restores in finally, so a missed match cannot leak the patch.
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

function insertChatgptAsset(database, { id, source, business = {}, prompt = "" }) {
  const businessJson = typeof business === "string" ? business : JSON.stringify(business);
  const sourceJson = JSON.stringify(source);
  database.prepare(`
    INSERT INTO assets (
      project_id, id, asset, original_path, content_sha256, prompt, skill, style, ratio, business_fields_json, theme,
      favorite, archived, group_name, category, rating, version_change, source_type, source_json, metadata_json, search_text,
      tags_text, business_search_text, source_search_text, media_kind, source_group, conversation_id, generation_batch,
      created_at, created_at_epoch, updated_at, sort_name
    ) VALUES (
      'default', @id, @asset, '/legacy', @hash, @prompt, '', '', '', @business, '',
      0, 0, '', '', 0, '', 'web-chatgpt', @source, '{}', '',
      '', @business, @source, 'image', 'web-chatgpt', @conversation, '',
      @created, @epoch, @created, @id
    )
  `).run({
    id,
    asset: `${id}.png`,
    hash: `hash-${id}`,
    prompt,
    business: businessJson,
    source: sourceJson,
    conversation: source.conversation_id || "",
    created: DEFAULT_CREATED,
    epoch: Date.parse(DEFAULT_CREATED),
  });
}

function insertRecipeSnapshot(database, { assetId, snapshotId, userPrompt, createdAt = DEFAULT_CREATED }) {
  database.prepare(`
    INSERT INTO recipe_snapshots (
      project_id, asset_id, snapshot_id, schema_version, recipe_digest, prompt_digest, effective_prompt, user_prompt,
      negative_prompt, prompt_status, generation_tool, model, provider, skill, style, ratio, theme,
      references_json, provenance_json, change_summary, created_at
    ) VALUES (
      'default', @assetId, @snapshotId, '1', '', '', @userPrompt, @userPrompt,
      '', '', '', '', 'chatgpt', '', '', '', '',
      '[]', '{}', '', @createdAt
    )
  `).run({ assetId, snapshotId, userPrompt, createdAt });
}

function insertGenerationEvent(database, { id, assetId, conversationId = "", messageId = "", createdAt = DEFAULT_CREATED }) {
  database.prepare(`
    INSERT INTO generation_events (
      project_id, id, output_asset_id, provider, capture_context_id, provider_generation_call_id,
      provider_asset_id, conversation_id, message_id, created_at
    ) VALUES (
      'default', @id, @assetId, 'chatgpt', '', '',
      '', @conversationId, @messageId, @createdAt
    )
  `).run({ id, assetId, conversationId, messageId, createdAt });
}

// --- immediate transactions ---

// Chosen assertion method for "the five transactions are BEGIN IMMEDIATE":
// source assertion (the first option in the task). The up-front-lock test at
// the bottom exercises the behavior end to end on top.
test("the one-time and read-then-write transactions are BEGIN IMMEDIATE (source assertion)", () => {
  const repair = readFileSync(join(LIB_DIR, "repair-capture-history.mjs"), "utf8");
  assert.equal((repair.match(/\.immediate\(\)/g) || []).length, 1, "repair-capture-history runs its single transaction with .immediate()");

  const cleared = readFileSync(join(LIB_DIR, "repair-cleared-prompts.mjs"), "utf8");
  assert.equal((cleared.match(/\.immediate\(\)/g) || []).length, 1, "repair-cleared-prompts runs its single transaction with .immediate()");

  const binding = readFileSync(join(LIB_DIR, "generation-message-binding.mjs"), "utf8");
  assert.equal((binding.match(/\.immediate\(\)/g) || []).length, 2, "generation-message-binding runs both transactions (backfill, applyGenerationMessageBindings) with .immediate()");

  const store = readFileSync(join(LIB_DIR, "sqlite-asset-store.mjs"), "utf8");
  const start = store.indexOf("async applySessionTitle");
  const end = store.indexOf("async dissolveAssetStack");
  assert.ok(start !== -1 && end > start, "applySessionTitle section found");
  assert.match(store.slice(start, end), /\.immediate\(\)/, "applySessionTitle runs its transaction with .immediate()");
});

// --- BUSY during the open: the open must survive, the step must retry ---

test("a BUSY failure in the one-time repair transaction is one warning and the open still succeeds; the next open repairs", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertChatgptAsset(database, {
        id: "a1",
        prompt: "neon skyline watercolor study",
        source: { type: "web-chatgpt", conversation_id: "conv-1", user_message: "a later turn text" },
        business: { user_message: "a later turn text" },
      });
      insertRecipeSnapshot(database, { assetId: "a1", snapshotId: "s1", userPrompt: "first prompt words" });
    })();
  });
  clearMarker(libraryDir, REPAIR_MARKER_KEY);

  let store;
  let stub;
  const warns = await captureWarnsAsync(async () => {
    stub = failOneTimeStepTransactionWithBusy("REPAIR_MARKER_KEY");
    try {
      store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
      // Task 347: the repair runs in deferred maintenance now; the stub and
      // the warn capture must span it.
      await store.startDeferredMaintenance();
    } finally {
      stub.restore();
    }
  });
  t.after(() => store.close());

  assert.ok(stub.intercepted, "the stub actually failed the repair's transaction");
  assert.ok(store, "createSqliteAssetStore returned despite the BUSY repair");
  assert.equal(store.storageKind, "sqlite");
  // The failed repair logs exactly one skip line; the deferred chain's other
  // passes may add unrelated progress lines (search_scope_v3 counts), which
  // are filtered out here.
  const skipWarns = warns.filter((line) => line.includes("skipped"));
  assert.equal(skipWarns.length, 1, "exactly one skip warning line");
  assert.match(skipWarns[0], /capture-history repair skipped/);
  assert.match(skipWarns[0], /SQLITE_BUSY/);
  assert.equal(markerValue(libraryDir, REPAIR_MARKER_KEY), null, "the marker rolled back with the data");
  const damaged = await store.getAsset("default", "a1");
  assert.equal(damaged.source?.user_message, "a later turn text", "the repair wrote nothing");

  const reopened = openStore(t, projectRoot, libraryDir);
  await reopened.startDeferredMaintenance();
  const asset = await reopened.getAsset("default", "a1");
  assert.equal(asset.source?.user_message, "first prompt words", "the repair ran on the next open");
  assert.equal(asset.business_fields?.user_message, "first prompt words");
  assert.ok(markerValue(libraryDir, REPAIR_MARKER_KEY), "the marker is written on the next open");
});

test("a BUSY failure in the message-id backfill transaction is one warning and the open still succeeds; the next open backfills", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertChatgptAsset(database, {
        id: "bf-a",
        source: { type: "web-chatgpt", conversation_id: "conv-1", message_id: "msg-9" },
      });
      insertGenerationEvent(database, { id: "e-a", assetId: "bf-a", conversationId: "conv-1" });
    })();
  });
  clearMarker(libraryDir, GENERATION_MESSAGE_BACKFILL_MARKER_KEY);

  let store;
  let stub;
  const warns = await captureWarnsAsync(async () => {
    stub = failOneTimeStepTransactionWithBusy("GENERATION_MESSAGE_BACKFILL_MARKER_KEY");
    try {
      store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
      await store.startDeferredMaintenance();
    } finally {
      stub.restore();
    }
  });
  t.after(() => store.close());

  assert.ok(stub.intercepted, "the stub actually failed the backfill's transaction");
  assert.ok(store, "createSqliteAssetStore returned despite the BUSY backfill");
  assert.equal(store.storageKind, "sqlite");
  const skipWarns = warns.filter((line) => line.includes("skipped"));
  assert.equal(skipWarns.length, 1, "exactly one skip warning line");
  assert.match(skipWarns[0], /generation message backfill skipped/);
  assert.match(skipWarns[0], /SQLITE_BUSY/);
  assert.equal(markerValue(libraryDir, GENERATION_MESSAGE_BACKFILL_MARKER_KEY), null, "the marker rolled back with the data");
  const events = await store.listGenerationEvents("default", {});
  assert.deepEqual(events.map((event) => event.message_id), [""], "the backfill wrote nothing");

  const reopened = openStore(t, projectRoot, libraryDir);
  await reopened.startDeferredMaintenance();
  const backfilled = await reopened.listGenerationEvents("default", {});
  assert.deepEqual(backfilled.map((event) => event.message_id), ["msg-9"], "the backfill ran on the next open");
  assert.ok(markerValue(libraryDir, GENERATION_MESSAGE_BACKFILL_MARKER_KEY), "the marker is written on the next open");
});

function insertClearedCaptureEvent(database, { id, assetId, createdAt = DEFAULT_CREATED }) {
  database.prepare(`
    INSERT INTO generation_events (
      project_id, id, output_asset_id, provider, capture_context_id, provider_generation_call_id,
      provider_asset_id, conversation_id, message_id, model, user_prompt, effective_prompt, prompt_status,
      generation_status, capture_channel, verification_level, evidence_json, created_at
    ) VALUES (
      'default', @id, @assetId, 'chatgpt', '', '',
      '', '', '', '', '', '', 'not-available',
      'unknown', 'chrome-extension', 'observed', '{"source":"web-capture"}', @createdAt
    )
  `).run({ id, assetId, createdAt });
}

test("a BUSY failure in the cleared-prompt repair transaction is one warning and the open still succeeds; the next open repairs", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertChatgptAsset(database, {
        id: "cp-a",
        prompt: "Model caption: A neon-lit city skyline reflected in a rainy street.",
        source: { type: "web-chatgpt", conversation_id: "conv-cp" },
      });
      insertClearedCaptureEvent(database, { id: "e-cp-a", assetId: "cp-a" });
    })();
  });
  clearMarker(libraryDir, CLEARED_PROMPT_REPAIR_MARKER_KEY);

  let store;
  let stub;
  const warns = await captureWarnsAsync(async () => {
    stub = failOneTimeStepTransactionWithBusy("CLEARED_PROMPT_REPAIR_MARKER_KEY");
    try {
      store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
      await store.startDeferredMaintenance();
    } finally {
      stub.restore();
    }
  });
  t.after(() => store.close());

  assert.ok(stub.intercepted, "the stub actually failed the repair's transaction");
  assert.ok(store, "createSqliteAssetStore returned despite the BUSY repair");
  assert.equal(store.storageKind, "sqlite");
  const skipWarns = warns.filter((line) => line.includes("skipped"));
  assert.equal(skipWarns.length, 1, "exactly one skip warning line");
  assert.match(skipWarns[0], /cleared-prompt repair skipped/);
  assert.match(skipWarns[0], /SQLITE_BUSY/);
  assert.equal(markerValue(libraryDir, CLEARED_PROMPT_REPAIR_MARKER_KEY), null, "the marker rolled back with the data");
  const events = await store.listGenerationEvents("default", { assetId: "cp-a" });
  assert.deepEqual(events.map((event) => event.effective_prompt), [""], "the repair wrote nothing");

  const reopened = openStore(t, projectRoot, libraryDir);
  await reopened.startDeferredMaintenance();
  const restored = await reopened.listGenerationEvents("default", { assetId: "cp-a" });
  assert.equal(restored[0].effective_prompt, "Model caption: A neon-lit city skyline reflected in a rainy street.", "the repair ran on the next open");
  assert.equal(restored[0].prompt_status, "visible-caption");
  assert.ok(markerValue(libraryDir, CLEARED_PROMPT_REPAIR_MARKER_KEY), "the marker is written on the next open");
});

// --- the repair transaction really holds the write lock up front ---

test("the repair transaction takes the write lock before its reads, so a mid-transaction write by another connection cannot break it", async (t) => {
  const { libraryDir } = await createLibraryRoot(t);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertChatgptAsset(database, {
        id: "a1",
        source: { type: "web-chatgpt", conversation_id: "conv-1", user_message: "a later turn text" },
        business: { user_message: "a later turn text" },
      });
      insertRecipeSnapshot(database, { assetId: "a1", snapshotId: "s1", userPrompt: "first prompt words" });
    })();
  });
  clearMarker(libraryDir, REPAIR_MARKER_KEY);

  const first = new Database(join(libraryDir, "mosa.db"), { timeout: 25 });
  const second = new Database(join(libraryDir, "mosa.db"), { timeout: 25 });
  t.after(() => {
    first.close();
    second.close();
  });

  const externalWrite = second.prepare("INSERT INTO library_meta (key, value, updated_at) VALUES ('open-repair-guard-probe', '1', '1')");
  let externalConflicts = 0;
  const stats = repairCaptureHistory(first, {
    commitLibraryChanges: () => {},
    syncRelationCandidates: () => {},
    // Called between the repair's snapshot reads and its first UPDATE — the
    // exact window where a deferred transaction dies with BUSY_SNAPSHOT once
    // the external write commits. Under BEGIN IMMEDIATE the external write
    // instead rebounds off the write lock the repair already holds.
    loadMetadata: () => {
      try {
        externalWrite.run();
      } catch {
        externalConflicts += 1;
      }
      return { source: {}, business_fields: {} };
    },
    searchableText: () => "open-repair-guard",
    syncAssetFtsEntry: () => {},
    replaceAssetShortTerms: () => {},
  });

  assert.equal(stats.userMessagesRestored, 1, "the repair completed under the concurrent write attempt");
  assert.equal(externalConflicts, 1, "the external write genuinely attempted mid-transaction and was repelled by the held write lock");
  assert.ok(markerValue(libraryDir, REPAIR_MARKER_KEY), "the marker committed with the data");
  const restored = withRawDatabase(libraryDir, (database) =>
    database.prepare("SELECT source_json FROM assets WHERE id = 'a1'").get(),
  );
  assert.equal(JSON.parse(restored.source_json).user_message, "first prompt words");
});
