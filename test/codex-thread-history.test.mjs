import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// @ts-ignore - better-sqlite3 is consumed as an untyped runtime dependency in this repository.
import Database from "better-sqlite3";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { createCodexThreadHistoryReader } from "../lib/codex-thread-history.js";

const THREAD_ID = "01a1362c-734c-77a1-9ee1-44eac822f2a1";
const RESULT_TOKEN = "RESULT-PAYLOAD-STUB";

const SCHEMA = [
  `CREATE TABLE thread_items (
    thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
    rollout_ordinal INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
    item_json TEXT NOT NULL, item_type TEXT NOT NULL DEFAULT '',
    updated_at_ordinal INTEGER NOT NULL DEFAULT 0, started_at_ms INTEGER, completed_at_ms INTEGER,
    PRIMARY KEY (thread_id, turn_id, item_id))`,
  `CREATE TABLE thread_turns (
    thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL,
    status TEXT NOT NULL, error_json TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER,
    first_user_item_id TEXT, final_agent_item_id TEXT, rollout_byte_offset INTEGER,
    rollout_end_ordinal INTEGER, rollout_end_byte_offset INTEGER, root_turn_id TEXT,
    PRIMARY KEY (thread_id, turn_id))`,
  `CREATE UNIQUE INDEX idx_thread_items_page ON thread_items (thread_id, rollout_ordinal)`,
];

async function createThreadHistoryFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-thread-history-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const dbPath = join(root, options.dbFileName || "thread_history_1.sqlite");
  const db = new Database(dbPath);
  db.exec(SCHEMA.join(";"));
  // rollout_ordinal is unique per thread in the real schema; the fixture hands
  // them out in insertion order so tests read like the conversation they seed.
  let ordinalSeq = 0;
  const fixture = {
    root,
    dbPath,
    insertTurn(threadId, turnId, firstUserItemId = null) {
      db.prepare("INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status, first_user_item_id) VALUES (?, ?, ?, 'completed', ?)")
        .run(threadId, turnId, ++ordinalSeq, firstUserItemId);
    },
    insertUserMessage(threadId, turnId, itemId, text, createdMs = 1_000) {
      db.prepare("INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type) VALUES (?, ?, ?, ?, ?, ?, 'userMessage')")
        .run(threadId, turnId, itemId, ++ordinalSeq, createdMs, JSON.stringify({
          type: "userMessage",
          id: itemId,
          clientId: "client-1",
          content: [{ type: "text", text, text_elements: [] }],
        }));
    },
    insertImageGeneration(threadId, turnId, itemId, { savedPath, revisedPrompt, result = "", completedAtMs = null, createdAtMs = 2_000 }) {
      db.prepare("INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, completed_at_ms, item_json, item_type) VALUES (?, ?, ?, ?, ?, ?, ?, 'imageGeneration')")
        .run(threadId, turnId, itemId, ++ordinalSeq, createdAtMs, completedAtMs, JSON.stringify({
          type: "imageGeneration",
          id: itemId,
          status: "completed",
          revisedPrompt,
          result,
          savedPath,
        }));
    },
    exec(sql) { db.exec(sql); },
    close() { db.close(); },
  };
  return fixture;
}

function seedTwoTurnConversation(fixture, { imagePathA, imagePathB, result = "" } = {}) {
  fixture.insertTurn(THREAD_ID, "turn-1", "um-1");
  fixture.insertUserMessage(THREAD_ID, "turn-1", "um-1", "帮我做一张书封");
  fixture.insertImageGeneration(THREAD_ID, "turn-1", "ig-1", {
    savedPath: imagePathA,
    revisedPrompt: "Book cover, warm palette.",
    result,
    completedAtMs: 1_774_000_000_000,
  });
  fixture.insertTurn(THREAD_ID, "turn-2", "um-2");
  fixture.insertUserMessage(THREAD_ID, "turn-2", "um-2", "再画一张同风格的海报");
  fixture.insertImageGeneration(THREAD_ID, "turn-2", "ig-2", {
    savedPath: imagePathB,
    revisedPrompt: "Matching poster, cool palette.",
    result,
    createdAtMs: 1_774_000_100_000,
  });
}

test("reads per-turn user messages from the thread-history database", async () => {
  const fixture = await createThreadHistoryFixture();
  const imagePathA = join(fixture.root, "generated_images", THREAD_ID, "a.png");
  const imagePathB = join(fixture.root, "generated_images", THREAD_ID, "b.png");
  seedTwoTurnConversation(fixture, { imagePathA, imagePathB });
  fixture.close();

  const reader = createCodexThreadHistoryReader({ dir: fixture.root });
  const events = reader.imageEventsForThread(THREAD_ID);
  assert.equal(events.size, 2);
  const first = events.get(imagePathA);
  const second = events.get(imagePathB);
  assert.equal(first.userMessage, "帮我做一张书封");
  assert.equal(first.prompt, "Book cover, warm palette.");
  assert.equal(first.promptStatus, "image-generation-revised-prompt");
  assert.equal(first.callId, "ig-1");
  assert.equal(first.generatedAt, new Date(1_774_000_000_000).toISOString());
  assert.equal(first.origin, "codex-thread-history");
  assert.equal(first.sessionPath, null);
  assert.equal(second.userMessage, "再画一张同风格的海报");
  assert.equal(second.generatedAt, new Date(1_774_000_100_000).toISOString());
  assert.deepEqual(reader.warnings(), []);
});

test("never surfaces the generation result payload", async () => {
  const fixture = await createThreadHistoryFixture();
  const imagePath = join(fixture.root, "generated_images", THREAD_ID, "a.png");
  seedTwoTurnConversation(fixture, {
    imagePathA: imagePath,
    imagePathB: join(fixture.root, "generated_images", THREAD_ID, "b.png"),
    result: Buffer.concat([Buffer.from(`${RESULT_TOKEN}.`), Buffer.alloc(1_000_000, 65)]).toString("base64"),
  });
  fixture.close();

  const reader = createCodexThreadHistoryReader({ dbPath: fixture.dbPath });
  const events = reader.imageEventsForThread(THREAD_ID);
  assert.equal(events.size, 2);
  const serialized = JSON.stringify([...events.values()]);
  assert.ok(!serialized.includes(RESULT_TOKEN), "the base64 result must not be read into JS");
  assert.ok(Buffer.byteLength(serialized) < 100_000, "metadata stays small");
  assert.equal(reader.stats().dbOpens, 1);
});

test("records null when the image's turn has no user message", async () => {
  const fixture = await createThreadHistoryFixture();
  const imagePath = join(fixture.root, "generated_images", THREAD_ID, "only.png");
  fixture.insertTurn(THREAD_ID, "turn-quiet", null);
  fixture.insertImageGeneration(THREAD_ID, "turn-quiet", "ig-quiet", { savedPath: imagePath, revisedPrompt: "Silent generation." });
  fixture.close();

  const reader = createCodexThreadHistoryReader({ dbPath: fixture.dbPath });
  const events = reader.imageEventsForThread(THREAD_ID);
  assert.equal(events.size, 1);
  assert.equal(events.get(imagePath).userMessage, null);
});

test("prefers first_user_item_id and otherwise the nearest earlier user message", async () => {
  const fixture = await createThreadHistoryFixture();
  const firstPath = join(fixture.root, "generated_images", THREAD_ID, "first.png");
  const missingRefPath = join(fixture.root, "generated_images", THREAD_ID, "missing-ref.png");
  const laterPath = join(fixture.root, "generated_images", THREAD_ID, "later.png");
  // Turn 1: two user messages, first_user_item_id points at the earlier one.
  fixture.insertTurn(THREAD_ID, "turn-priority", "um-a");
  fixture.insertUserMessage(THREAD_ID, "turn-priority", "um-a", "第一条消息");
  fixture.insertUserMessage(THREAD_ID, "turn-priority", "um-b", "第二条消息");
  fixture.insertImageGeneration(THREAD_ID, "turn-priority", "ig-p", { savedPath: firstPath, revisedPrompt: "Priority check." });
  // Turn 2: first_user_item_id dangles; the nearest earlier message must be used.
  fixture.insertTurn(THREAD_ID, "turn-dangling", "um-gone");
  fixture.insertUserMessage(THREAD_ID, "turn-dangling", "um-c", "悬空引用前的消息");
  fixture.insertImageGeneration(THREAD_ID, "turn-dangling", "ig-d", { savedPath: missingRefPath, revisedPrompt: "Dangling check." });
  // Turn 3: the only user message comes after the image; no borrowing from elsewhere.
  fixture.insertTurn(THREAD_ID, "turn-later", null);
  fixture.insertImageGeneration(THREAD_ID, "turn-later", "ig-l", { savedPath: laterPath, revisedPrompt: "Later check." });
  fixture.insertUserMessage(THREAD_ID, "turn-later", "um-l", "出图之后才说的消息");
  fixture.close();

  const reader = createCodexThreadHistoryReader({ dbPath: fixture.dbPath });
  const events = reader.imageEventsForThread(THREAD_ID);
  assert.equal(events.get(firstPath).userMessage, "第一条消息");
  assert.equal(events.get(missingRefPath).userMessage, "悬空引用前的消息");
  assert.equal(events.get(laterPath).userMessage, null);
});

test("strips the attachment preamble from database user messages", async () => {
  const fixture = await createThreadHistoryFixture();
  const imagePath = join(fixture.root, "generated_images", THREAD_ID, "wrapped.png");
  const wrapped = "# Files mentioned by the user:\n\n## codex-clipboard-x.png: /tmp/codex-clipboard-x.png\nImage attachment: true\n\n## My request:\n顶部空缺用模型填满";
  fixture.insertTurn(THREAD_ID, "turn-wrapped", "um-w");
  fixture.insertUserMessage(THREAD_ID, "turn-wrapped", "um-w", wrapped);
  fixture.insertImageGeneration(THREAD_ID, "turn-wrapped", "ig-w", { savedPath: imagePath, revisedPrompt: "Use case: precise-object-edit." });
  fixture.close();

  const reader = createCodexThreadHistoryReader({ dbPath: fixture.dbPath });
  assert.equal(reader.imageEventsForThread(THREAD_ID).get(imagePath).userMessage, "顶部空缺用模型填满");
});

test("caches thread queries until the database changes", async () => {
  const fixture = await createThreadHistoryFixture();
  const imagePath = join(fixture.root, "generated_images", THREAD_ID, "a.png");
  seedTwoTurnConversation(fixture, { imagePathA: imagePath, imagePathB: join(fixture.root, "generated_images", THREAD_ID, "b.png") });
  fixture.close();

  const reader = createCodexThreadHistoryReader({ dbPath: fixture.dbPath });
  const first = reader.imageEventsForThread(THREAD_ID);
  assert.equal(first.size, 2);
  assert.equal(reader.stats().threadQueries, 1);
  reader.imageEventsForThread(THREAD_ID);
  assert.equal(reader.stats().threadQueries, 1);
  assert.equal(reader.stats().cacheHits, 1);

  const write = new Database(fixture.dbPath);
  write.prepare("INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type) VALUES (?, ?, ?, ?, ?, ?, 'imageGeneration')")
    .run(THREAD_ID, "turn-1", "ig-late", 99, 3_000, JSON.stringify({ type: "imageGeneration", id: "ig-late", revisedPrompt: "Late arrival.", savedPath: join(fixture.root, "generated_images", THREAD_ID, "late.png") }));
  write.close();

  const refreshed = reader.imageEventsForThread(THREAD_ID);
  assert.equal(refreshed.size, 3);
  assert.equal(reader.stats().threadQueries, 2);
});

test("skips the source with a warning when the database is unusable", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-thread-history-broken-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const missing = createCodexThreadHistoryReader({ dbPath: join(root, "thread_history_9.sqlite") });
  assert.equal(missing.imageEventsForThread(THREAD_ID).size, 0);
  assert.ok(missing.warnings().some((warning) => /unavailable/.test(warning)), "missing file must warn");

  const emptyDir = join(root, "empty");
  await mkdir(emptyDir, { recursive: true });
  const quiet = createCodexThreadHistoryReader({ dir: emptyDir });
  assert.equal(quiet.imageEventsForThread(THREAD_ID).size, 0);
  assert.deepEqual(quiet.warnings(), [], "a directory without any database is a normal state, not a warning");

  const wrongSchemaPath = join(root, "thread_history_1.sqlite");
  const wrongSchema = new Database(wrongSchemaPath);
  wrongSchema.exec("CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT)");
  wrongSchema.close();
  const wrongSchemaReader = createCodexThreadHistoryReader({ dbPath: wrongSchemaPath });
  assert.equal(wrongSchemaReader.imageEventsForThread(THREAD_ID).size, 0);
  assert.ok(wrongSchemaReader.warnings().some((warning) => /no such column/i.test(warning)), "missing columns must warn");

  const corruptPath = join(root, "thread_history_2.sqlite");
  await writeFile(corruptPath, Buffer.from("this is definitely not a sqlite database".repeat(100)));
  const corrupt = createCodexThreadHistoryReader({ dbPath: corruptPath });
  assert.equal(corrupt.imageEventsForThread(THREAD_ID).size, 0);
  assert.ok(corrupt.warnings().some((warning) => /not a database|could not be opened/i.test(warning)), "corrupt file must warn");
});
