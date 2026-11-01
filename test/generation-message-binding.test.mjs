import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp } from "node:fs/promises";
import { deferTestPathRemoval, removeTestPath as rm } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import Database from "better-sqlite3";
import sharp from "sharp";

import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { buildAssetGenerationHistory } from "../lib/generation-history.mjs";
import {
  GENERATION_MESSAGE_BACKFILL_MARKER_KEY,
  backfillGenerationMessageIdsFromAssets,
} from "../lib/generation-message-binding.mjs";

const REPAIR_MARKER_KEY = "repair_capture_user_message_v1";
const DEFAULT_CREATED = "2026-05-01T00:00:00.000Z";

async function createLibraryRoot(t, prefix = "mosa-message-binding-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  // Bootstrap the schema with a real store open, then seed rows through a
  // second raw connection. The bootstrap open already runs both one-time
  // passes and writes their markers; tests that need a pass to run clear the
  // marker after seeding.
  const bootstrap = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  bootstrap.close();
  return { root, projectRoot, libraryDir };
}

function openStore(t, projectRoot, libraryDir) {
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => store.close());
  return store;
}

function clearMarkers(libraryDir, { backfill = true, repair = false } = {}) {
  withRawDatabase(libraryDir, (database) => {
    if (backfill) database.prepare("DELETE FROM library_meta WHERE key = ?").run(GENERATION_MESSAGE_BACKFILL_MARKER_KEY);
    if (repair) database.prepare("DELETE FROM library_meta WHERE key = ?").run(REPAIR_MARKER_KEY);
  });
}

function markerValue(libraryDir, key) {
  return withRawDatabase(libraryDir, (database) =>
    database.prepare("SELECT value FROM library_meta WHERE key = ?").get(key)?.value || null,
  );
}

function withRawDatabase(libraryDir, task) {
  const database = new Database(join(libraryDir, "mosa.db"));
  try {
    return task(database);
  } finally {
    database.close();
  }
}

async function createChatAsset(store, assetId, source) {
  const imagePath = join(store.generatedImagesDir, `${assetId}.png`);
  await mkdir(store.generatedImagesDir, { recursive: true });
  await sharp({ create: { width: 8, height: 8, channels: 4, background: "#243047" } }).png().toFile(imagePath);
  const asset = await store.createAsset({ assetId, imagePath });
  if (source) await store.updateMetadata("default", asset.id, { source });
  return asset;
}

function insertAssetRaw(database, { id, conversationId = "", messageKey = "", providerAssetKey = "" }) {
  const source = {
    type: "web-chatgpt",
    ...(conversationId ? { conversation_id: conversationId } : {}),
    ...(messageKey ? { message_id: messageKey } : {}),
    ...(providerAssetKey ? { provider_asset_id: providerAssetKey } : {}),
  };
  database.prepare(`
    INSERT INTO assets (
      project_id, id, asset, original_path, content_sha256, prompt, skill, style, ratio, business_fields_json, theme,
      favorite, archived, group_name, category, rating, version_change, source_type, source_json, metadata_json, search_text,
      tags_text, business_search_text, source_search_text, media_kind, source_group, conversation_id, generation_batch,
      created_at, created_at_epoch, updated_at, sort_name
    ) VALUES (
      'default', @id, @asset, '/legacy', @hash, '', '', '', '', '{}', '',
      0, 0, '', '', 0, '', 'web-chatgpt', @source, '{}', '',
      '', '', @source, 'image', 'web-chatgpt', @conversation, '',
      @created, @epoch, @created, @id
    )
  `).run({
    id,
    asset: `${id}.png`,
    hash: `hash-${id}`,
    source: JSON.stringify(source),
    conversation: conversationId,
    created: DEFAULT_CREATED,
    epoch: Date.parse(DEFAULT_CREATED),
  });
}

function insertEventRaw(database, { id, assetId, conversationId = "", messageId = "", providerAssetId = "", captureContextId = "", callId = "", createdAt = DEFAULT_CREATED }) {
  database.prepare(`
    INSERT INTO generation_events (
      project_id, id, output_asset_id, provider, capture_context_id, provider_generation_call_id,
      provider_asset_id, conversation_id, message_id, created_at
    ) VALUES (
      'default', @id, @assetId, 'chatgpt', @captureContextId, @callId,
      @providerAssetId, @conversationId, @messageId, @createdAt
    )
  `).run({ id, assetId, conversationId, messageId, providerAssetId, captureContextId, callId, createdAt });
}

function insertRelationRaw(database, { child, parent, createdAt = DEFAULT_CREATED }) {
  database.prepare(`
    INSERT INTO generation_relations (project_id, child_generation_id, parent_generation_id, relation_type, verification_level, evidence_json, created_at)
    VALUES ('default', @child, @parent, 'derived_from', 'user_confirmed', '{}', @createdAt)
  `).run({ child, parent, createdAt });
}

// --- write-time supplement (recordGenerationEvent) ---

test("write-time supplement fills the message id from the asset when conversations agree, and keeps the event id", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  const store = openStore(t, projectRoot, libraryDir);
  const asset = await createChatAsset(store, "sup-a", {
    type: "web-chatgpt",
    conversation_id: "conv-1",
    message_id: "msg-9",
  });

  const event = await store.recordGenerationEvent({
    project_id: "default",
    output_asset_id: asset.id,
    provider: "chatgpt",
    conversation_id: "conv-1",
    created_at: "2026-08-27T10:00:00.000Z",
  });
  assert.equal(event.message_id, "msg-9");
  assert.equal(event.turn_index, null);

  // The id is derived from what the capture actually sent (no message), and
  // it must not change once the message is filled in.
  const again = await store.recordGenerationEvent({
    project_id: "default",
    output_asset_id: asset.id,
    provider: "chatgpt",
    conversation_id: "conv-1",
    created_at: "2026-08-27T10:00:00.000Z",
  });
  assert.equal(again.id, event.id);
  assert.equal(again.message_id, "msg-9");
  const events = await store.listGenerationEvents("default", { assetId: asset.id });
  assert.equal(events.length, 1, "re-recording the same event updates in place");
});

test("write-time supplement does not fill when conversations disagree", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  const store = openStore(t, projectRoot, libraryDir);
  const asset = await createChatAsset(store, "sup-b", {
    type: "web-chatgpt",
    conversation_id: "conv-other",
    message_id: "msg-z",
  });
  const event = await store.recordGenerationEvent({
    project_id: "default",
    output_asset_id: asset.id,
    provider: "chatgpt",
    conversation_id: "conv-1",
    created_at: "2026-08-27T10:00:00.000Z",
  });
  assert.equal(event.message_id, "");
});

test("a write with empty values never overwrites a stored message id or turn index", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  const store = openStore(t, projectRoot, libraryDir);
  const asset = await createChatAsset(store, "sup-c", {
    type: "web-chatgpt",
    conversation_id: "conv-1",
    message_id: "msg-9",
  });
  const event = await store.recordGenerationEvent({
    project_id: "default",
    output_asset_id: asset.id,
    provider: "chatgpt",
    conversation_id: "conv-1",
    created_at: "2026-08-27T10:00:00.000Z",
  });
  assert.equal(event.message_id, "msg-9");
  withRawDatabase(libraryDir, (database) => {
    database.prepare("UPDATE generation_events SET turn_index = 3 WHERE project_id = 'default' AND id = ?").run(event.id);
  });

  const rewritten = await store.recordGenerationEvent({
    project_id: "default",
    output_asset_id: asset.id,
    provider: "chatgpt",
    conversation_id: "conv-1",
    created_at: "2026-08-27T10:00:00.000Z",
  });
  assert.equal(rewritten.message_id, "msg-9", "empty message write keeps the stored message");
  assert.equal(rewritten.turn_index, 3, "write without turn index keeps the stored turn");

  const stored = await store.listGenerationEvents("default", { assetId: asset.id });
  assert.deepEqual(stored.map((entry) => [entry.message_id, entry.turn_index]), [["msg-9", 3]]);
});

test("write-time supplement skips an unidentified duplicate event", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  const store = openStore(t, projectRoot, libraryDir);
  const asset = await createChatAsset(store, "sup-d", {
    type: "web-chatgpt",
    conversation_id: "conv-1",
    message_id: "msg-9",
  });
  // An identified sibling for the same output asset makes any all-identifiers-
  // empty event a duplicate of the repair-capture-history kind.
  withRawDatabase(libraryDir, (database) => {
    insertEventRaw(database, { id: "message:conv-1:m1", assetId: asset.id, conversationId: "conv-1", messageId: "m1" });
  });

  const duplicate = await store.recordGenerationEvent({
    project_id: "default",
    output_asset_id: asset.id,
    provider: "chatgpt",
    conversation_id: "conv-1",
    created_at: "2026-08-27T11:00:00.000Z",
  });
  assert.equal(duplicate.message_id, "", "the duplicate stays unfilled");
});

// --- one-time backfill and its ordering after the repair pass ---

test("backfill runs after the capture-history repair: deleted duplicates stay gone, relation-kept duplicates stay unfilled", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  const deletedId = "occurrence:2026-05-02T00:00:00.000Z";
  const relationKeptId = "occurrence:2026-05-03T00:00:00.000Z";
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      // Repair-damaged shape: one capture per asset, message ids on the asset.
      insertAssetRaw(database, { id: "ord-a", conversationId: "conv-1", messageKey: "msg-9" });
      insertAssetRaw(database, { id: "ord-b", conversationId: "conv-1", messageKey: "msg-8" });
      // The event the backfill should fill must live on an asset with no
      // identified sibling, or the repair deletes it as a duplicate first.
      insertAssetRaw(database, { id: "ord-c", conversationId: "conv-1", messageKey: "msg-7" });
      // Identified sibling + plain duplicate: the repair deletes it in this
      // same open. Both passes use the same duplicate definition, so the
      // backfill would skip this row in either order — what this test locks
      // is that one open of a pre-both library runs the repair first and the
      // backfill second, and the end state is the repaired-then-filled one.
      insertEventRaw(database, { id: "message:conv-1:m1", assetId: "ord-a", conversationId: "conv-1", messageId: "m1", createdAt: "2026-05-01T00:00:00.000Z" });
      insertEventRaw(database, { id: deletedId, assetId: "ord-a", conversationId: "conv-1", createdAt: "2026-05-02T00:00:00.000Z" });
      // Same duplicate shape, but referenced by a relation: the repair keeps
      // it, and the backfill must still not fill it.
      insertEventRaw(database, { id: "message:conv-1:m2", assetId: "ord-b", conversationId: "conv-1", messageId: "m2", createdAt: "2026-05-01T00:00:00.000Z" });
      insertEventRaw(database, { id: relationKeptId, assetId: "ord-b", conversationId: "conv-1", createdAt: "2026-05-03T00:00:00.000Z" });
      insertRelationRaw(database, { child: "message:conv-1:m2", parent: relationKeptId });
      // The normal backfill case: a lone unfilled event, no sibling anywhere.
      insertEventRaw(database, { id: "occurrence:2026-05-04T00:00:00.000Z", assetId: "ord-c", conversationId: "conv-1", createdAt: "2026-05-04T00:00:00.000Z" });
    })();
  });
  clearMarkers(libraryDir, { backfill: true, repair: true });

  const store = openStore(t, projectRoot, libraryDir);
  const events = await store.listGenerationEvents("default", {});
  const byId = new Map(events.map((event) => [event.id, event]));
  assert.equal(byId.has(deletedId), false, "the repair deleted its duplicates in this same open");
  assert.deepEqual([byId.get(relationKeptId).message_id, byId.get(relationKeptId).turn_index], ["", null], "the relation-kept duplicate is not filled");
  const lone = byId.get("occurrence:2026-05-04T00:00:00.000Z");
  assert.ok(lone, "the lone event survives the repair");
  assert.deepEqual([lone.message_id, lone.turn_index], ["msg-7", null], "the backfill filled it afterwards");
  assert.ok(markerValue(libraryDir, REPAIR_MARKER_KEY), "the repair marker is written");
  assert.ok(markerValue(libraryDir, GENERATION_MESSAGE_BACKFILL_MARKER_KEY), "the backfill marker is written");

  const changes = await store.listLibraryChangesSince("default", 0);
  const kinds = changes.changes.map((change) => change.kind);
  assert.ok(kinds.includes("library-repaired"), "the repair announces itself");
  const backfill = changes.changes.find((change) => change.kind === "library-backfilled" && change.detail?.reason === "generation-message-backfill-v1");
  assert.ok(backfill, "the backfill announces itself");
  assert.equal(backfill.detail.eventsUpdated, 1);
});

test("backfill fills only conversation-matching events and never scans again after the marker", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertAssetRaw(database, { id: "bf-a", conversationId: "conv-1", messageKey: "msg-9" });
      insertEventRaw(database, { id: "e-a", assetId: "bf-a", conversationId: "conv-1" });
      insertAssetRaw(database, { id: "bf-b", conversationId: "conv-2", messageKey: "msg-8" });
      insertEventRaw(database, { id: "e-b", assetId: "bf-b", conversationId: "conv-1" });
      insertAssetRaw(database, { id: "bf-c", conversationId: "conv-3" });
      insertEventRaw(database, { id: "e-c", assetId: "bf-c", conversationId: "conv-3" });
    })();
  });
  clearMarkers(libraryDir);

  const store = openStore(t, projectRoot, libraryDir);
  const events = await store.listGenerationEvents("default", {});
  const byId = new Map(events.map((event) => [event.id, event]));
  assert.equal(byId.get("e-a").message_id, "msg-9", "matching conversation is filled");
  assert.equal(byId.get("e-b").message_id, "", "mismatched conversation stays empty");
  assert.equal(byId.get("e-c").message_id, "", "asset without a source message stays empty");
  const changes = await store.listLibraryChangesSince("default", 0);
  const revision = changes.changes.reduce((max, change) => Math.max(max, Number(change.revision || 0)), 0);
  store.close();

  // A row that a second scan would fill appears after the marker is set.
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertAssetRaw(database, { id: "bf-d", conversationId: "conv-1", messageKey: "msg-7" });
      insertEventRaw(database, { id: "e-d", assetId: "bf-d", conversationId: "conv-1" });
    })();
  });

  const second = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => second.close());
  const secondEvents = await second.listGenerationEvents("default", {});
  assert.equal(secondEvents.find((event) => event.id === "e-d").message_id, "", "the marker stops the rescan");
  const secondChanges = await second.listLibraryChangesSince("default", revision);
  assert.equal(
    secondChanges.changes.filter((change) => change.kind === "library-backfilled").length,
    0,
    "no second backfill announcement",
  );
});

test("a library without the new column and table upgrades on open", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  withRawDatabase(libraryDir, (database) => {
    database.exec("ALTER TABLE generation_events DROP COLUMN turn_index");
    database.exec("ALTER TABLE generation_events DROP COLUMN turn_synced_at");
    database.exec("DROP TABLE generation_conversations");
    database.prepare("DELETE FROM library_meta WHERE key = ?").run(GENERATION_MESSAGE_BACKFILL_MARKER_KEY);
  });

  const store = openStore(t, projectRoot, libraryDir);
  const asset = await createChatAsset(store, "up-a", {
    type: "web-chatgpt",
    conversation_id: "conv-1",
    message_id: "msg-9",
  });
  const event = await store.recordGenerationEvent({
    project_id: "default",
    output_asset_id: asset.id,
    provider: "chatgpt",
    conversation_id: "conv-1",
    created_at: "2026-08-27T10:00:00.000Z",
  });
  assert.equal(event.message_id, "msg-9");
  const bound = await store.applyGenerationMessageBindings({
    project_id: "default",
    provider: "chatgpt",
    conversation_id: "conv-1",
    turn_count: 2,
    bindings: [{ provider_asset_id: "file-up", message_id: "msg-9", turn_index: 2 }],
  });
  assert.equal(bound.matched, 0, "the unbound file id stays unmatched");
  // The conversation sync applies even when nothing matches; reading it back
  // through the history API proves the dropped table was recreated and works.
  const history = await store.getAssetGenerationHistory("default", asset.id);
  assert.deepEqual(history.conversations, [{
    provider: "chatgpt",
    conversation_id: "conv-1",
    turn_count: 2,
    synced_at: history.conversations[0]?.synced_at,
  }]);
  assert.ok(history.conversations[0]?.synced_at);
  withRawDatabase(libraryDir, (database) => {
    const columns = new Set(database.prepare("SELECT name FROM pragma_table_info('generation_events')").all().map((row) => row.name));
    assert.ok(columns.has("turn_index"), "the column is recreated");
    assert.ok(columns.has("turn_synced_at"), "the watermark column is recreated");
  });
});

// --- turn numbers as snapshot data (binding write rules) ---

test("one batch is one snapshot: watermarks match the conversation, and records absent from a later batch keep a stale one", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  const store = openStore(t, projectRoot, libraryDir);
  const assetA = await createChatAsset(store, "snap-a", { type: "web-chatgpt", conversation_id: "conv-1" });
  const assetB = await createChatAsset(store, "snap-b", { type: "web-chatgpt", conversation_id: "conv-1" });
  await store.recordGenerationEvent({ project_id: "default", output_asset_id: assetA.id, provider: "chatgpt", conversation_id: "conv-1", provider_asset_id: "file-snap-a", created_at: "2026-08-27T10:00:00.000Z" });
  await store.recordGenerationEvent({ project_id: "default", output_asset_id: assetB.id, provider: "chatgpt", conversation_id: "conv-1", provider_asset_id: "file-snap-b", created_at: "2026-08-27T10:01:00.000Z" });

  const first = await store.applyGenerationMessageBindings({
    project_id: "default",
    provider: "chatgpt",
    conversation_id: "conv-1",
    turn_count: 5,
    bindings: [
      { provider_asset_id: "file-snap-a", message_id: "msg-a", turn_index: 1 },
      { provider_asset_id: "file-snap-b", message_id: "msg-b", turn_index: 2 },
    ],
  });
  assert.deepEqual(first, { matched: 2, updated: 2, unchanged: 0, conflicts: 0, unmatched: 0 });
  withRawDatabase(libraryDir, (database) => {
    const conversation = database.prepare("SELECT turn_count, synced_at FROM generation_conversations WHERE conversation_id = 'conv-1'").get();
    assert.equal(conversation.turn_count, 5);
    const rows = database.prepare("SELECT output_asset_id, turn_index, turn_synced_at FROM generation_events WHERE output_asset_id IN (?, ?)").all(assetA.id, assetB.id);
    const byAsset = new Map(rows.map((row) => [row.output_asset_id, row]));
    assert.deepEqual([byAsset.get(assetA.id).turn_index, byAsset.get(assetB.id).turn_index], [1, 2]);
    for (const row of rows) {
      assert.equal(row.turn_synced_at, conversation.synced_at, "every write of the batch carries the batch's stamp");
    }
  });

  // The conversation changed between reads: the second batch only mentions A.
  await delay(5);
  const second = await store.applyGenerationMessageBindings({
    project_id: "default",
    provider: "chatgpt",
    conversation_id: "conv-1",
    turn_count: 6,
    bindings: [{ provider_asset_id: "file-snap-a", message_id: "msg-a", turn_index: 3 }],
  });
  assert.deepEqual(second, { matched: 1, updated: 1, unchanged: 0, conflicts: 0, unmatched: 0 });
  withRawDatabase(libraryDir, (database) => {
    const conversation = database.prepare("SELECT turn_count, synced_at FROM generation_conversations WHERE conversation_id = 'conv-1'").get();
    assert.equal(conversation.turn_count, 6);
    const rowA = database.prepare("SELECT turn_index, turn_synced_at FROM generation_events WHERE output_asset_id = ?").get(assetA.id);
    const rowB = database.prepare("SELECT turn_index, turn_synced_at FROM generation_events WHERE output_asset_id = ?").get(assetB.id);
    assert.equal(rowA.turn_synced_at, conversation.synced_at, "A follows the latest snapshot");
    assert.equal(rowB.turn_index, 2, "B's turn number is not cleared");
    assert.ok(rowB.turn_synced_at < conversation.synced_at, "B's watermark shows the older snapshot");
  });
});

test("a message disagreement counts a conflict but the turn still follows the snapshot", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  const store = openStore(t, projectRoot, libraryDir);
  const asset = await createChatAsset(store, "snap-c", { type: "web-chatgpt", conversation_id: "conv-1" });
  await store.recordGenerationEvent({ project_id: "default", output_asset_id: asset.id, provider: "chatgpt", conversation_id: "conv-1", provider_asset_id: "file-snap-c", message_id: "m1", created_at: "2026-08-27T10:00:00.000Z" });

  const bound = await store.applyGenerationMessageBindings({
    project_id: "default",
    provider: "chatgpt",
    conversation_id: "conv-1",
    turn_count: 9,
    bindings: [{ provider_asset_id: "file-snap-c", message_id: "m2", turn_index: 5 }],
  });
  assert.deepEqual(bound, { matched: 1, updated: 0, unchanged: 0, conflicts: 1, unmatched: 0 });
  withRawDatabase(libraryDir, (database) => {
    const row = database.prepare("SELECT message_id, turn_index, turn_synced_at FROM generation_events WHERE output_asset_id = ?").get(asset.id);
    const conversation = database.prepare("SELECT synced_at FROM generation_conversations WHERE conversation_id = 'conv-1'").get();
    assert.deepEqual([row.message_id, row.turn_index], ["m1", 5], "the message stays and the turn is written");
    assert.equal(row.turn_synced_at, conversation.synced_at);
  });
});

test("an ambiguous file is skipped whole; identical repeats apply once", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  const store = openStore(t, projectRoot, libraryDir);
  const assetX = await createChatAsset(store, "snap-x", { type: "web-chatgpt", conversation_id: "conv-1" });
  const assetY = await createChatAsset(store, "snap-y", { type: "web-chatgpt", conversation_id: "conv-1" });
  await store.recordGenerationEvent({ project_id: "default", output_asset_id: assetX.id, provider: "chatgpt", conversation_id: "conv-1", provider_asset_id: "file-snap-x", created_at: "2026-08-27T10:00:00.000Z" });
  await store.recordGenerationEvent({ project_id: "default", output_asset_id: assetY.id, provider: "chatgpt", conversation_id: "conv-1", provider_asset_id: "file-snap-y", created_at: "2026-08-27T10:01:00.000Z" });

  // Two entries for one file disagreeing on the turn: the file's ownership is
  // unclear, so neither message nor turn is written, reported as one conflict.
  const ambiguous = await store.applyGenerationMessageBindings({
    project_id: "default",
    provider: "chatgpt",
    conversation_id: "conv-1",
    turn_count: 8,
    bindings: [
      { provider_asset_id: "file-snap-x", message_id: "mx", turn_index: 3 },
      { provider_asset_id: "file-snap-x", message_id: "mx", turn_index: 7 },
    ],
  });
  assert.deepEqual(ambiguous, { matched: 1, updated: 0, unchanged: 0, conflicts: 1, unmatched: 0 });
  withRawDatabase(libraryDir, (database) => {
    const row = database.prepare("SELECT message_id, turn_index, turn_synced_at FROM generation_events WHERE output_asset_id = ?").get(assetX.id);
    assert.deepEqual([row.message_id, row.turn_index, row.turn_synced_at], ["", null, null], "the ambiguous file writes nothing");
  });

  // Entries repeating the same values exactly are one binding.
  const repeated = await store.applyGenerationMessageBindings({
    project_id: "default",
    provider: "chatgpt",
    conversation_id: "conv-1",
    turn_count: 8,
    bindings: [
      { provider_asset_id: "file-snap-y", message_id: "my", turn_index: 4 },
      { provider_asset_id: "file-snap-y", message_id: "my", turn_index: 4 },
    ],
  });
  assert.deepEqual(repeated, { matched: 1, updated: 1, unchanged: 0, conflicts: 0, unmatched: 0 }, "the identical repeat is treated as one entry");
  withRawDatabase(libraryDir, (database) => {
    const row = database.prepare("SELECT message_id, turn_index FROM generation_events WHERE output_asset_id = ?").get(assetY.id);
    assert.deepEqual([row.message_id, row.turn_index], ["my", 4]);
  });
});

test("generation history flags a context truncated by maxEvents", () => {
  const conversation = { provider: "chatgpt", conversation_id: "conv-t" };
  const seed = { id: "seed", output_asset_id: "asset-1", created_at: "2026-08-27T10:00:00.000Z", ...conversation };
  const context = [1, 2, 3].map((n) => ({
    id: `ctx-${n}`,
    output_asset_id: `other-${n}`,
    created_at: `2026-08-27T10:0${n}:00.000Z`,
    ...conversation,
  }));
  const truncated = buildAssetGenerationHistory({ projectId: "default", assetId: "asset-1", events: [seed, ...context], maxEvents: 3 });
  assert.equal(truncated.context_truncated, true, "the third context event does not fit");
  assert.equal(truncated.context_events.length, 2);
  const full = buildAssetGenerationHistory({ projectId: "default", assetId: "asset-1", events: [seed, ...context], maxEvents: 50 });
  assert.deepEqual([full.context_truncated, full.context_events.length], [false, 3]);
  const empty = buildAssetGenerationHistory({ projectId: "default", assetId: "unbound", events: [] });
  assert.equal(empty.context_truncated, false, "the empty early return is not truncated");
});

// --- binding API over HTTP ---

test("generation message binding API: writes, conflicts, idempotency, validation, and history fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-message-binding-api-"));
  const libraryDir = join(root, "library");
  const generatedDir = join(root, "generated-images");
  await mkdir(generatedDir, { recursive: true });

  const store = createSqliteAssetStore({ projectRoot: root, managerDir: process.cwd(), libraryDir });
  const png = async (name, color) => {
    const path = join(generatedDir, name);
    await sharp({ create: { width: 8, height: 8, channels: 4, background: color } }).png().toFile(path);
    return path;
  };
  const mkAsset = async (assetId, source, color) => {
    const asset = await store.createAsset({ assetId, imagePath: await png(`${assetId}.png`, color) });
    if (source) await store.updateMetadata("default", asset.id, { source });
    return asset;
  };
  const a1 = await mkAsset("bind-a1", { type: "web-chatgpt", conversation_id: "conv-1", message_id: "msg-1", provider_asset_id: "file-a1" }, "#243047");
  await store.recordGenerationEvent({ project_id: "default", output_asset_id: a1.id, provider: "chatgpt", conversation_id: "conv-1", provider_asset_id: "file-a1", created_at: "2026-08-27T10:00:00.000Z" });
  const a2 = await mkAsset("bind-a2", { type: "web-chatgpt", conversation_id: "conv-1", provider_asset_id: "file-a2" }, "#c43d38");
  const eventA2 = await store.recordGenerationEvent({ project_id: "default", output_asset_id: a2.id, provider: "chatgpt", conversation_id: "conv-1", created_at: "2026-08-27T10:01:00.000Z" });
  const a3 = await mkAsset("bind-a3", { type: "web-chatgpt", conversation_id: "conv-1", provider_asset_id: "file-a3" }, "#336644");
  await store.recordGenerationEvent({ project_id: "default", output_asset_id: a3.id, provider: "chatgpt", conversation_id: "conv-1", message_id: "msg-3", created_at: "2026-08-27T10:02:00.000Z" });
  // The unidentified duplicate for a3: all identifiers empty, identified
  // sibling above. Only reachable through the asset's file id.
  withRawDatabase(libraryDir, (database) => {
    insertEventRaw(database, { id: "dup:a3", assetId: a3.id, conversationId: "conv-1", createdAt: "2026-08-27T10:02:30.000Z" });
  });
  const a4 = await mkAsset("bind-a4", { type: "web-chatgpt", conversation_id: "conv-2", message_id: "msg-4", provider_asset_id: "file-a4" }, "#444a5c");
  await store.recordGenerationEvent({ project_id: "default", output_asset_id: a4.id, provider: "chatgpt", conversation_id: "conv-2", provider_asset_id: "file-a4", created_at: "2026-08-27T10:03:00.000Z" });
  const a5 = await mkAsset("bind-a5", { type: "web-chatgpt", conversation_id: "conv-1", provider_asset_id: "file-a5" }, "#5c4444");
  await store.recordGenerationEvent({ project_id: "default", output_asset_id: a5.id, provider: "chatgpt", conversation_id: "conv-1", provider_asset_id: "file-a5", message_id: "msg-5", created_at: "2026-08-27T10:04:00.000Z" });
  const a6 = await mkAsset("bind-a6", { type: "web-chatgpt", conversation_id: "conv-fresh", provider_asset_id: "file-a6" }, "#445c44");
  const eventA6 = await store.recordGenerationEvent({ project_id: "default", output_asset_id: a6.id, provider: "chatgpt", conversation_id: "conv-fresh", created_at: "2026-08-27T10:05:00.000Z" });
  const plain = await mkAsset("bind-plain", null, "#5c5c44");
  const plainEvent = await store.recordGenerationEvent({ project_id: "default", output_asset_id: plain.id, provider: "chatgpt", created_at: "2026-08-27T10:06:00.000Z" });
  await store.setMigrationState("completed", { test: true });
  store.close();

  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOSA_PORT: "0",
      MOSA_PROJECT_DIR: root,
      MOSA_LIBRARY_DIR: libraryDir,
      CODEX_GENERATED_IMAGES_DIR: generatedDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });

  const port = await waitForServerPort(server);
  await waitForServer(port, server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const postBindings = (body) => postJson(`${baseUrl}/api/generation-message-bindings`, body);
  const historyOf = async (assetId) => (await (await fetch(`${baseUrl}/api/assets/default/${encodeURIComponent(assetId)}/generation-history`)).json()).history;

  // Normal write: message + turn land on the record matched through the
  // ASSET's file id (the event itself carries none); another conversation is
  // never matched.
  const first = await postBindings({
    project_id: "default",
    provider: "chatgpt",
    conversation_id: "conv-1",
    turn_count: 5,
    bindings: [
      { provider_asset_id: "file-a2", message_id: "msg-2", turn_index: 2 },
      { provider_asset_id: "file-a4", message_id: "msg-4", turn_index: 3 },
    ],
  });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { matched: 1, updated: 1, unchanged: 0, conflicts: 0, unmatched: 1 });
  let history = await historyOf(a2.id);
  assert.deepEqual([history.events[0].message_id, history.events[0].turn_index], ["msg-2", 2]);
  assert.equal(history.events[0].turn_synced_at, history.conversations[0].synced_at, "the bound turn carries its batch's snapshot stamp");
  assert.equal(history.context_truncated, false);
  assert.equal(history.conversations.length, 1);
  assert.equal(history.conversations[0].provider, "chatgpt");
  assert.equal(history.conversations[0].conversation_id, "conv-1");
  assert.equal(history.conversations[0].turn_count, 5);
  assert.ok(history.conversations[0].synced_at);

  // Re-sending the same batch is a NEW read of the conversation: the turn
  // watermark refreshes, so the entry counts as updated under the snapshot
  // rules (the old "second replay writes nothing" rule is gone).
  await delay(5);
  const stampedBefore = history.events[0].turn_synced_at;
  const replay = await postBindings({
    project_id: "default",
    provider: "chatgpt",
    conversation_id: "conv-1",
    turn_count: 5,
    bindings: [
      { provider_asset_id: "file-a2", message_id: "msg-2", turn_index: 2 },
      { provider_asset_id: "file-a4", message_id: "msg-4", turn_index: 3 },
    ],
  });
  assert.deepEqual(await replay.json(), { matched: 1, updated: 1, unchanged: 0, conflicts: 0, unmatched: 1 });
  history = await historyOf(a2.id);
  assert.notEqual(history.events[0].turn_synced_at, stampedBefore, "the watermark moves to the newer snapshot");
  assert.equal(history.events[0].turn_synced_at, history.conversations[0].synced_at);

  // A message disagreement is a conflict, but it no longer blocks the turn:
  // the turn number follows the latest snapshot either way.
  const conflict = await postBindings({
    project_id: "default",
    provider: "chatgpt",
    conversation_id: "conv-1",
    turn_count: 5,
    bindings: [{ provider_asset_id: "file-a2", message_id: "msg-other", turn_index: 4 }],
  });
  assert.deepEqual(await conflict.json(), { matched: 1, updated: 0, unchanged: 0, conflicts: 1, unmatched: 0 });
  history = await historyOf(a2.id);
  assert.deepEqual([history.events[0].message_id, history.events[0].turn_index], ["msg-2", 4], "the message stays and the turn is overwritten");
  assert.equal(history.events[0].turn_synced_at, history.conversations[0].synced_at);

  // The same file twice with different values: the file's ownership is
  // unclear, nothing from its entries is written, one conflict is reported.
  const inBatch = await postBindings({
    project_id: "default",
    provider: "chatgpt",
    conversation_id: "conv-1",
    turn_count: 9,
    bindings: [
      { provider_asset_id: "file-a5", message_id: "msg-5", turn_index: 4 },
      { provider_asset_id: "file-a5", message_id: "msg-5", turn_index: 9 },
    ],
  });
  assert.deepEqual(await inBatch.json(), { matched: 1, updated: 0, unchanged: 0, conflicts: 1, unmatched: 0 });
  history = await historyOf(a5.id);
  assert.deepEqual([history.events[0].message_id, history.events[0].turn_index, history.events[0].turn_synced_at], ["msg-5", null, null], "the ambiguous file leaves the record untouched");

  // The duplicate event of a3 is only reachable through the asset's file id
  // and must be skipped; the identified sibling receives the turn.
  const skip = await postBindings({
    project_id: "default",
    provider: "chatgpt",
    conversation_id: "conv-1",
    turn_count: 5,
    bindings: [{ provider_asset_id: "file-a3", message_id: "msg-3", turn_index: 1 }],
  });
  assert.deepEqual(await skip.json(), { matched: 1, updated: 1, unchanged: 0, conflicts: 0, unmatched: 0 });
  withRawDatabase(libraryDir, (database) => {
    const duplicate = database.prepare("SELECT message_id, turn_index FROM generation_events WHERE project_id = 'default' AND id = 'dup:a3'").get();
    assert.deepEqual([duplicate.message_id, duplicate.turn_index], ["", null], "the unidentified duplicate is skipped, not written");
  });
  history = await historyOf(a3.id);
  assert.equal(history.events.find((event) => event.id !== "dup:a3").turn_index, 1, "the identified sibling receives the turn");

  // Extra keys — including conversation text — are ignored and not stored.
  // The entry still refreshes the turn watermark, so it counts as updated.
  const extraFields = await postBindings({
    project_id: "default",
    provider: "chatgpt",
    conversation_id: "conv-1",
    turn_count: 5,
    bindings: [{
      provider_asset_id: "file-a2",
      message_id: "msg-2",
      turn_index: 2,
      note: "用户在这一轮说：画一只戴帽子的猫",
      prompt: "画一只戴帽子的猫",
      user_message: "画一只戴帽子的猫",
    }],
  });
  assert.deepEqual(await extraFields.json(), { matched: 1, updated: 1, unchanged: 0, conflicts: 0, unmatched: 0 });
  withRawDatabase(libraryDir, (database) => {
    const row = database.prepare("SELECT * FROM generation_events WHERE project_id = 'default' AND id = ?").get(eventA2.id);
    assert.deepEqual(
      Object.keys(row).filter((key) => JSON.stringify(row[key]).includes("戴帽子")),
      [],
      "no column stores the ignored text",
    );
  });

  // turn_count refresh, including a smaller value (messages were deleted).
  const shrink = await postBindings({
    project_id: "default",
    provider: "chatgpt",
    conversation_id: "conv-1",
    turn_count: 3,
    bindings: [],
  });
  assert.deepEqual(await shrink.json(), { matched: 0, updated: 0, unchanged: 0, conflicts: 0, unmatched: 0 });
  history = await historyOf(a2.id);
  assert.equal(history.conversations[0].turn_count, 3);

  // Invalid batches: 400 and nothing written — not even the conversation row.
  const invalidBatches = [
    { project_id: "default", provider: "openai", conversation_id: "conv-fresh", turn_count: 3, bindings: [] },
    { project_id: "default", provider: "chatgpt", conversation_id: "", turn_count: 3, bindings: [] },
    { project_id: "default", provider: "chatgpt", conversation_id: "conv-fresh", turn_count: 0, bindings: [] },
    { project_id: "default", provider: "chatgpt", conversation_id: "conv-fresh", turn_count: 2.5, bindings: [] },
    {
      project_id: "default",
      provider: "chatgpt",
      conversation_id: "conv-fresh",
      turn_count: 5,
      bindings: [
        { provider_asset_id: "file-a6", message_id: "msg-6", turn_index: 1 },
        { provider_asset_id: "file-x", message_id: "msg-x", turn_index: 6 },
      ],
    },
    {
      project_id: "default",
      provider: "chatgpt",
      conversation_id: "conv-fresh",
      turn_count: 5,
      bindings: Array.from({ length: 2001 }, (_, index) => ({ provider_asset_id: `file-${index}`, message_id: "m", turn_index: 1 })),
    },
  ];
  for (const batch of invalidBatches) {
    const response = await postBindings(batch);
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(batch).slice(0, 80)}`);
    const payload = await response.json();
    assert.equal(payload.code, "GENERATION_MESSAGE_BINDINGS_INVALID");
  }
  withRawDatabase(libraryDir, (database) => {
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM generation_conversations WHERE conversation_id = 'conv-fresh'").get().count, 0, "no conversation row for rejected batches");
    const row = database.prepare("SELECT message_id, turn_index FROM generation_events WHERE project_id = 'default' AND id = ?").get(eventA6.id);
    assert.deepEqual([row.message_id, row.turn_index], ["", null], "the valid leading entry of a rejected batch is not written");
  });

  // History fields for an asset without any conversation binding.
  const plainHistory = await historyOf(plain.id);
  assert.deepEqual(
    [plainHistory.events[0].turn_index, plainHistory.events[0].turn_synced_at, plainHistory.conversations, plainHistory.context_truncated],
    [null, null, [], false],
  );
  assert.equal(plainHistory.events[0].id, plainEvent.id);

  // The capture route must not accept a turn index: it is ignored, and the
  // binding API remains the only writer.
  const throughCapture = await postJson(`${baseUrl}/api/generations`, {
    outputAssetId: plain.id,
    provider: "chatgpt",
    conversationId: "conv-9",
    messageId: "msg-p",
    turn_index: 7,
    effectivePrompt: "ignored turn claim",
  });
  assert.equal(throughCapture.status, 201);
  const captureEvent = (await throughCapture.json()).event;
  assert.equal(captureEvent.turn_index, null);
  const captureHistory = await historyOf(plain.id);
  assert.deepEqual(captureHistory.events.map((event) => [event.turn_index, event.turn_synced_at]), [[null, null], [null, null]]);
});

// --- capture-plugin turn-bindings entry over HTTP (rework 1) ---

test("the capture turn-bindings entry accepts only the web capture token and writes through the shared store path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-turn-bindings-capture-"));
  const libraryDir = join(root, "library");
  const generatedDir = join(root, "generated-images");
  await mkdir(generatedDir, { recursive: true });

  const store = createSqliteAssetStore({ projectRoot: root, managerDir: process.cwd(), libraryDir });
  const png = async (name, color) => {
    const path = join(generatedDir, name);
    await sharp({ create: { width: 8, height: 8, channels: 4, background: color } }).png().toFile(path);
    return path;
  };
  const mkAsset = async (assetId, source, color) => {
    const asset = await store.createAsset({ assetId, imagePath: await png(`${assetId}.png`, color) });
    if (source) await store.updateMetadata("default", asset.id, { source });
    return asset;
  };
  const a1 = await mkAsset("cap-a1", { type: "web-chatgpt", conversation_id: "conv-cap", provider_asset_id: "file-cap-1" }, "#243047");
  await store.recordGenerationEvent({ project_id: "default", output_asset_id: a1.id, provider: "chatgpt", conversation_id: "conv-cap", provider_asset_id: "file-cap-1", created_at: "2026-08-27T11:00:00.000Z" });
  const a2 = await mkAsset("cap-a2", { type: "web-chatgpt", conversation_id: "conv-old", provider_asset_id: "file-old-1" }, "#336644");
  await store.recordGenerationEvent({ project_id: "default", output_asset_id: a2.id, provider: "chatgpt", conversation_id: "conv-old", provider_asset_id: "file-old-1", created_at: "2026-08-27T11:01:00.000Z" });
  await store.setMigrationState("completed", { test: true });
  store.close();

  const CAPTURE_TOKEN = "mosa_e2e_capture_turn_token";
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOSA_PORT: "0",
      MOSA_PROJECT_DIR: root,
      MOSA_LIBRARY_DIR: libraryDir,
      CODEX_GENERATED_IMAGES_DIR: generatedDir,
      MOSA_WEB_CAPTURE_TOKEN: CAPTURE_TOKEN,
      MOSA_WEB_CAPTURE_ORIGINS: "chrome-extension://example-extension",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });

  const port = await waitForServerPort(server);
  await waitForServer(port, server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const historyOf = async (assetId) => (await (await fetch(`${baseUrl}/api/assets/default/${encodeURIComponent(assetId)}/generation-history`)).json()).history;
  const postTurnBindings = (body, headers = {}) => fetch(`${baseUrl}/api/ingest/web-capture-turn-bindings`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const turnSnapshot = () => {
    let stored = null;
    withRawDatabase(libraryDir, (database) => {
      stored = database.prepare("SELECT turn_count, synced_at FROM generation_conversations WHERE conversation_id = 'conv-cap'").get() || null;
    });
    return stored;
  };

  // The MOSA client token is not a capture credential: even though the test
  // fetch wrapper attaches it to every loopback mutation, the entry only
  // reads the Web Capture bearer token.
  const clientOnly = await postTurnBindings({
    project_id: "default",
    provider: "chatgpt",
    conversation_id: "conv-cap",
    turn_count: 3,
    bindings: [{ provider_asset_id: "file-cap-1", message_id: "user-1", turn_index: 1 }],
  });
  assert.equal(clientOnly.status, 401, "a client token without the capture bearer is unauthorized");
  assert.equal((await clientOnly.json()).code, "WEB_CAPTURE_UNAUTHORIZED");

  const wrongToken = await postTurnBindings({
    project_id: "default",
    provider: "chatgpt",
    conversation_id: "conv-cap",
    turn_count: 3,
    bindings: [{ provider_asset_id: "file-cap-1", message_id: "user-1", turn_index: 1 }],
  }, { authorization: "Bearer mosa_wrong_capture_token" });
  assert.equal(wrongToken.status, 401, "a wrong capture token is unauthorized");
  assert.equal(turnSnapshot(), null, "rejected requests wrote no conversation row");

  const validBatch = {
    project_id: "default",
    provider: "chatgpt",
    conversation_id: "conv-cap",
    turn_count: 3,
    bindings: [{ provider_asset_id: "file-cap-1", message_id: "user-1", turn_index: 1 }],
  };
  const accepted = await postTurnBindings(validBatch, { authorization: `Bearer ${CAPTURE_TOKEN}` });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { matched: 1, updated: 1, unchanged: 0, conflicts: 0, unmatched: 0 });
  const history = await historyOf(a1.id);
  assert.deepEqual([history.events[0].message_id, history.events[0].turn_index], ["user-1", 1]);
  assert.equal(history.conversations[0].turn_count, 3);
  assert.equal(history.events[0].turn_synced_at, history.conversations[0].synced_at, "the capture entry shares the snapshot watermark rules");

  // Invalid bodies stay 400 with nothing written, same contract as the
  // client-token endpoint.
  const invalid = await postTurnBindings({
    project_id: "default",
    provider: "openai",
    conversation_id: "conv-cap",
    turn_count: 3,
    bindings: [],
  }, { authorization: `Bearer ${CAPTURE_TOKEN}` });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, "GENERATION_MESSAGE_BINDINGS_INVALID");

  // The client-token endpoint keeps working unchanged (no regression).
  const legacy = await postJson(`${baseUrl}/api/generation-message-bindings`, {
    project_id: "default",
    provider: "chatgpt",
    conversation_id: "conv-old",
    turn_count: 2,
    bindings: [{ provider_asset_id: "file-old-1", message_id: "old-user-1", turn_index: 1 }],
  });
  assert.equal(legacy.status, 200, "the client-token endpoint still answers 200");
  assert.deepEqual(await legacy.json(), { matched: 1, updated: 1, unchanged: 0, conflicts: 0, unmatched: 0 });
  const oldHistory = await historyOf(a2.id);
  assert.deepEqual([oldHistory.events[0].message_id, oldHistory.events[0].turn_index], ["old-user-1", 1]);
});

function postJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Snapshot timestamps have millisecond resolution; consecutive batches in a
// test must not land in the same millisecond or "older watermark" comparisons
// would flake.
function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForServerPort(server) {
  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");
  return new Promise((resolvePort, rejectPort) => {
    let output = "";
    let errorOutput = "";
    const timer = setTimeout(() => finish(new Error("Timed out waiting for MOSA server startup.")), 5000);
    const onOutput = (chunk) => {
      output += chunk;
      // Task 314: the child prints its capability on the boot line; stash it
      // so the readiness probes can present the credential it actually owns.
      const match = /GravityPort: http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      const tokenMatch = /#mosa-client-token=([A-Za-z0-9_%-]+)/.exec(output);
      if (match) {
        // Suppressed when stdout is redirected (server.mjs): the probes then
        // fall back to the MOSA_CLIENT_TOKEN the test itself exported.
        if (tokenMatch) server.mosaClientToken = decodeURIComponent(tokenMatch[1]);
        finish(null, Number(match[1]));
      }
    };
    const onErrorOutput = (chunk) => { errorOutput += chunk; };
    const onExit = () => finish(new Error(`MOSA server exited during startup.${errorOutput ? `\n${errorOutput}` : ""}`));
    const finish = (error, port) => {
      clearTimeout(timer);
      server.stdout.off("data", onOutput);
      server.stderr.off("data", onErrorOutput);
      server.off("exit", onExit);
      if (error) rejectPort(error);
      else resolvePort(port);
    };
    server.stdout.on("data", onOutput);
    server.stderr.on("data", onErrorOutput);
    server.once("exit", onExit);
  });
}

async function waitForServer(port, server) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error("MOSA server exited during startup.");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/bridges`, {
        // Task 314: /api/bridges requires the child's own capability now.
        headers: { "x-mosa-client-token": server.mosaClientToken ?? process.env.MOSA_CLIENT_TOKEN ?? "" },
      });
      if (response.ok) return;
    } catch {
      // Listener may not be ready yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("Timed out waiting for MOSA server startup.");
}
