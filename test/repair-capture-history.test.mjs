import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { repairCaptureHistory } from "../lib/repair-capture-history.mjs";
import { resolveGenerationRelationCandidates } from "../lib/generation-history.mjs";

const REPAIR_MARKER_KEY = "repair_capture_user_message_v1";
const DEFAULT_CREATED = "2026-05-01T00:00:00.000Z";

async function createLibraryRoot(t, prefix = "mosa-repair-capture-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  // Bootstrap the schema with a real store open, then seed damaged rows
  // through a second raw connection, the same pattern the auto-session
  // backfill tests use. The bootstrap open already runs the (empty) repair
  // and writes the marker, so seeding clears it to restore "never repaired".
  const bootstrap = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  bootstrap.close();
  return { root, projectRoot, libraryDir };
}

async function openStore(t, projectRoot, libraryDir, { warns } = {}) {
  const originalWarn = console.warn;
  if (warns) console.warn = (...parts) => { warns.push(parts.map(String).join(" ")); };
  try {
    const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
    // Task 347: the repair runs from deferred maintenance after the open, so
    // the helper runs it before returning (with warn capture still open).
    await store.startDeferredMaintenance();
    t.after(() => store.close());
    return store;
  } finally {
    console.warn = originalWarn;
  }
}

function withRawDatabase(libraryDir, task) {
  const database = new Database(join(libraryDir, "mosa.db"));
  try {
    return task(database);
  } finally {
    database.close();
  }
}

function clearRepairMarker(libraryDir) {
  withRawDatabase(libraryDir, (database) => {
    database.prepare("DELETE FROM library_meta WHERE key = ?").run(REPAIR_MARKER_KEY);
  });
}

function insertAsset(database, { id, sourceType = "web-chatgpt", source, business = "{}", createdAt = DEFAULT_CREATED, deletedAt = null, prompt = "", theme = "", tags = [] }) {
  database.prepare(`
    INSERT INTO assets (
      project_id, id, asset, original_path, content_sha256, prompt, skill, style, ratio, business_fields_json, theme,
      favorite, archived, group_name, category, rating, version_change, source_type, source_json, metadata_json, search_text,
      tags_text, business_search_text, source_search_text, media_kind, source_group, conversation_id, generation_batch,
      created_at, created_at_epoch, updated_at, sort_name
    ) VALUES (
      'default', @id, @asset, '/legacy', @hash, @prompt, '', '', '', @business, @theme,
      0, 0, '', '', 0, '', @sourceType, @source, '{}', '',
      '', @business, @source, 'image', @sourceType, @conversation, '',
      @created, @epoch, @created, @id
    )
  `).run({
    id,
    asset: `${id}.png`,
    hash: `hash-${id}`,
    sourceType,
    source: JSON.stringify(source),
    business,
    prompt,
    theme,
    conversation: source.conversation_id || "",
    created: createdAt,
    epoch: Date.parse(createdAt),
  });
  for (const tag of tags) {
    const normalized = tag.trim().toLocaleLowerCase();
    database.prepare("INSERT OR IGNORE INTO tags (id, normalized_name, name) VALUES (?, ?, ?)").run(`tag-${normalized}`, normalized, tag);
    database.prepare("INSERT OR IGNORE INTO asset_tags (project_id, asset_id, tag_id) VALUES (?, ?, ?)").run("default", id, `tag-${normalized}`);
  }
  if (deletedAt) database.prepare("UPDATE assets SET deleted_at = ? WHERE id = ?").run(deletedAt, id);
}

function insertSnapshot(database, { assetId, snapshotId, userPrompt, createdAt = DEFAULT_CREATED }) {
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

function insertEvent(database, { id, assetId, provider = "chatgpt", messageId = "", captureContextId = "", conversationId = "", userPrompt = "", createdAt = DEFAULT_CREATED }) {
  database.prepare(`
    INSERT INTO generation_events (
      project_id, id, output_asset_id, provider, capture_context_id, provider_generation_call_id,
      provider_asset_id, conversation_id, message_id, user_prompt, created_at
    ) VALUES (
      'default', @id, @assetId, @provider, @captureContextId, '',
      '', @conversationId, @messageId, @userPrompt, @createdAt
    )
  `).run({ id, assetId, provider, captureContextId, conversationId, messageId, userPrompt, createdAt });
}

function insertRelation(database, { child, parent, relationType = "derived_from", createdAt = DEFAULT_CREATED }) {
  database.prepare(`
    INSERT INTO generation_relations (project_id, child_generation_id, parent_generation_id, relation_type, verification_level, evidence_json, created_at)
    VALUES ('default', @child, @parent, @relationType, 'confirmed', '{}', @createdAt)
  `).run({ child, parent, relationType, createdAt });
}

function insertCandidate(database, { child, parent, status = "suggested", createdAt = DEFAULT_CREATED }) {
  database.prepare(`
    INSERT INTO generation_relation_candidates (
      project_id, child_generation_id, parent_generation_id, suggested_relation_type, confidence,
      verification_level, evidence_json, status, created_at, updated_at
    ) VALUES (
      'default', @child, @parent, 'derived_from', 0.5,
      'inferred', '{}', @status, @createdAt, @createdAt
    )
  `).run({ child, parent, status, createdAt });
}

function candidatePairs(libraryDir) {
  return withRawDatabase(libraryDir, (database) =>
    database.prepare(`
      SELECT child_generation_id AS child, parent_generation_id AS parent, status
      FROM generation_relation_candidates WHERE project_id = 'default'
      ORDER BY child, parent
    `).all(),
  );
}

function repairMarkerValue(libraryDir) {
  return withRawDatabase(libraryDir, (database) =>
    database.prepare("SELECT value FROM library_meta WHERE key = ?").get(REPAIR_MARKER_KEY)?.value || null,
  );
}

// --- 2a: user message restoration ---

test("restores a wrong-turn user message from the earliest non-empty recipe snapshot", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertAsset(database, {
        id: "a1",
        prompt: "neon skyline watercolor study",
        theme: "harbor nights detail",
        tags: ["reference"],
        source: { type: "web-chatgpt", conversation_id: "conv-1", user_message: "a later turn text" },
        business: JSON.stringify({ user_message: "a later turn text" }),
      });
      insertSnapshot(database, { assetId: "a1", snapshotId: "s1", userPrompt: "first prompt words", createdAt: "2026-05-01T00:00:00.000Z" });
    })();
  });
  clearRepairMarker(libraryDir);

  const store = await openStore(t, projectRoot, libraryDir);
  const asset = await store.getAsset("default", "a1");
  assert.equal(asset.source?.user_message, "first prompt words");
  assert.equal(asset.business_fields?.user_message, "first prompt words");

  withRawDatabase(libraryDir, (database) => {
    const row = database.prepare("SELECT search_text, source_search_text, business_search_text FROM assets WHERE id = 'a1'").get();
    assert.match(row.search_text, /first prompt words/);
    assert.doesNotMatch(row.search_text, /later turn text/);
    // The rebuild must not drop the fields the repair does not touch.
    assert.match(row.search_text, /neon skyline watercolor study/, "the prompt must survive the search-text rebuild");
    assert.match(row.search_text, /harbor nights detail/, "the title must survive the search-text rebuild");
    assert.match(row.search_text, /reference/, "the tag must survive the search-text rebuild");
    assert.match(row.source_search_text, /first prompt words/);
    assert.match(row.business_search_text, /first prompt words/);
    const fts = database.prepare("SELECT content FROM asset_fts WHERE asset_id = 'a1'").get();
    assert.match(fts.content, /first prompt words/);
    assert.doesNotMatch(fts.content, /later turn text/);
  });
  const page = await store.listAssetPage({ projectId: "default", query: "first prompt", limit: 0 });
  assert.ok(page.assets.some((entry) => entry.id === "a1"), "the restored message is searchable");
  const byPromptWord = await store.listAssetPage({ projectId: "default", query: "watercolor", limit: 0 });
  assert.ok(byPromptWord.assets.some((entry) => entry.id === "a1"), "still findable by a word from the original prompt");
  const byTitleWord = await store.listAssetPage({ projectId: "default", query: "harbor", limit: 0 });
  assert.ok(byTitleWord.assets.some((entry) => entry.id === "a1"), "still findable by a word from the title");
});

test("keeps a current message that is a longer completion of the snapshot prompt", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertAsset(database, {
        id: "c1",
        source: { type: "web-chatgpt", conversation_id: "conv-c", user_message: "draw a cat sitting on a mat" },
      });
      insertSnapshot(database, { assetId: "c1", snapshotId: "s1", userPrompt: "draw a cat" });
    })();
  });
  clearRepairMarker(libraryDir);

  await openStore(t, projectRoot, libraryDir);
  withRawDatabase(libraryDir, (database) => {
    const source = JSON.parse(database.prepare("SELECT source_json FROM assets WHERE id = 'c1'").get().source_json);
    assert.equal(source.user_message, "draw a cat sitting on a mat", "the completion stays untouched");
  });
});

test("uses the first non-empty snapshot when the earliest snapshots are blank", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertAsset(database, {
        id: "b1",
        source: { type: "web-chatgpt", conversation_id: "conv-b", user_message: "wrong turn text" },
      });
      insertSnapshot(database, { assetId: "b1", snapshotId: "s1", userPrompt: "", createdAt: "2026-05-01T00:00:00.000Z" });
      insertSnapshot(database, { assetId: "b1", snapshotId: "s2", userPrompt: "  ", createdAt: "2026-05-01T01:00:00.000Z" });
      insertSnapshot(database, { assetId: "b1", snapshotId: "s3", userPrompt: "the real first prompt", createdAt: "2026-05-01T02:00:00.000Z" });
    })();
  });
  clearRepairMarker(libraryDir);

  const store = await openStore(t, projectRoot, libraryDir);
  const asset = await store.getAsset("default", "b1");
  assert.equal(asset.source?.user_message, "the real first prompt");
});

test("leaves assets alone when no snapshot carries a non-empty prompt", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertAsset(database, {
        id: "n1",
        source: { type: "web-chatgpt", conversation_id: "conv-n", user_message: "whatever the page said" },
      });
      insertSnapshot(database, { assetId: "n1", snapshotId: "s1", userPrompt: "" });
      insertAsset(database, { id: "n2", source: { type: "web-chatgpt", conversation_id: "conv-n2", user_message: "no snapshots at all" } });
    })();
  });
  clearRepairMarker(libraryDir);

  const store = await openStore(t, projectRoot, libraryDir);
  const changes = await store.listLibraryChangesSince("default", 0);
  assert.equal(changes.changes.filter((change) => change.kind === "library-repaired").length, 0, "nothing to repair, no announcement");
  withRawDatabase(libraryDir, (database) => {
    const sources = database.prepare("SELECT id, source_json FROM assets WHERE id IN ('n1', 'n2') ORDER BY id").all();
    assert.equal(JSON.parse(sources[0].source_json).user_message, "whatever the page said");
    assert.equal(JSON.parse(sources[1].source_json).user_message, "no snapshots at all");
  });
});

test("skips trashed images and non-ChatGPT sources", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertAsset(database, {
        id: "t1",
        source: { type: "web-chatgpt", conversation_id: "conv-t", user_message: "wrong turn text" },
        deletedAt: "2026-05-02T00:00:00.000Z",
      });
      insertSnapshot(database, { assetId: "t1", snapshotId: "s1", userPrompt: "first prompt words" });
      insertAsset(database, {
        id: "f1",
        sourceType: "web-flow",
        source: { type: "web-flow", user_message: "wrong turn text" },
      });
      insertSnapshot(database, { assetId: "f1", snapshotId: "s1", userPrompt: "first prompt words" });
    })();
  });
  clearRepairMarker(libraryDir);

  await openStore(t, projectRoot, libraryDir);
  withRawDatabase(libraryDir, (database) => {
    const rows = database.prepare("SELECT id, source_json FROM assets WHERE id IN ('t1', 'f1') ORDER BY id").all();
    assert.equal(JSON.parse(rows[0].source_json).user_message, "wrong turn text", "trashed image untouched");
    assert.equal(JSON.parse(rows[1].source_json).user_message, "wrong turn text", "non-ChatGPT image untouched");
  });
});

// --- 2b: duplicate generation event cleanup ---

test("removes unidentified duplicate events and keeps the identified sibling", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertAsset(database, { id: "e1", source: { type: "web-chatgpt", conversation_id: "conv-e" } });
      insertEvent(database, { id: "message:conv-e:m1", assetId: "e1", conversationId: "conv-e", messageId: "m1", createdAt: "2026-05-01T00:00:00.000Z" });
      insertEvent(database, { id: "occurrence:2026-05-02T00:00:00.000Z", assetId: "e1", createdAt: "2026-05-02T00:00:00.000Z" });
      insertEvent(database, { id: "occurrence:2026-05-03T00:00:00.000Z", assetId: "e1", createdAt: "2026-05-03T00:00:00.000Z" });
    })();
  });
  clearRepairMarker(libraryDir);

  const store = await openStore(t, projectRoot, libraryDir);
  const events = await store.listGenerationEvents("default", { assetId: "e1" });
  assert.deepEqual(events.map((event) => event.id), ["message:conv-e:m1"]);
});

test("keeps an unidentified event that a generation relation references", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertAsset(database, { id: "r1", source: { type: "web-chatgpt", conversation_id: "conv-r" } });
      insertEvent(database, { id: "message:conv-r:m1", assetId: "r1", conversationId: "conv-r", messageId: "m1", createdAt: "2026-05-01T00:00:00.000Z" });
      insertEvent(database, { id: "occurrence:2026-05-02T00:00:00.000Z", assetId: "r1", createdAt: "2026-05-02T00:00:00.000Z" });
      insertRelation(database, { child: "message:conv-r:m1", parent: "occurrence:2026-05-02T00:00:00.000Z" });
    })();
  });
  clearRepairMarker(libraryDir);

  const store = await openStore(t, projectRoot, libraryDir);
  const events = await store.listGenerationEvents("default", { assetId: "r1" });
  assert.equal(events.length, 2, "both events survive while the relation references the unidentified one");
});

test("keeps an unidentified event when no identified sibling exists", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertAsset(database, { id: "s1", source: { type: "web-chatgpt", conversation_id: "conv-s" } });
      insertEvent(database, { id: "occurrence:2026-05-02T00:00:00.000Z", assetId: "s1", createdAt: "2026-05-02T00:00:00.000Z" });
    })();
  });
  clearRepairMarker(libraryDir);

  const store = await openStore(t, projectRoot, libraryDir);
  const events = await store.listGenerationEvents("default", { assetId: "s1" });
  assert.equal(events.length, 1, "the lone event is the only record of that generation");
});

test("recomputes relation candidates and leaves no rows pointing at removed events", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  const removedId = "occurrence:2026-05-02T00:00:00.000Z";
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertAsset(database, { id: "p1", source: { type: "web-chatgpt", conversation_id: "conv-p" } });
      insertEvent(database, { id: "message:conv-p:m1", assetId: "p1", conversationId: "conv-p", messageId: "m1", createdAt: "2026-05-01T00:00:00.000Z" });
      insertEvent(database, { id: removedId, assetId: "p1", createdAt: "2026-05-02T00:00:00.000Z" });
      insertEvent(database, { id: "message:conv-p:m2", assetId: "p1", conversationId: "conv-p", messageId: "m2", createdAt: "2026-05-03T00:00:00.000Z" });
      // References the doomed event: the foreign key must cascade it away.
      insertCandidate(database, { child: "message:conv-p:m2", parent: removedId });
      // Both endpoints survive the delete, so only the recomputation below
      // decides whether this row stays — the sync must run, not just cascade.
      insertCandidate(database, { child: "message:conv-p:m2", parent: "message:conv-p:m1" });
    })();
  });
  clearRepairMarker(libraryDir);

  await openStore(t, projectRoot, libraryDir);
  withRawDatabase(libraryDir, (database) => {
    const events = database.prepare("SELECT * FROM generation_events WHERE project_id = 'default' ORDER BY created_at, id").all()
      .map((row) => ({
        id: row.id,
        provider: row.provider,
        conversation_id: row.conversation_id,
        message_id: row.message_id,
        provider_asset_id: row.provider_asset_id,
        capture_context_id: row.capture_context_id,
        batch_id: row.batch_id,
        user_prompt: row.user_prompt,
        effective_prompt: row.effective_prompt,
        created_at: row.created_at,
      }));
    const expected = resolveGenerationRelationCandidates({ projectId: "default", events, relations: [], candidates: [] });
    const actual = candidatePairs(libraryDir);
    assert.deepEqual(
      actual.map((row) => `${row.child}->${row.parent}:${row.status}`),
      expected.map((row) => `${row.child_generation_id}->${row.parent_generation_id}:${row.status}`),
      "the candidate table equals a fresh recomputation over the surviving events",
    );
    const stale = actual.filter((row) => row.child === removedId || row.parent === removedId);
    assert.equal(stale.length, 0, "no candidate references the removed event");
  });
});

// --- one-shot marker, stats, and notifications ---

test("runs once: reopening does not repair again, notify, or invoke helpers", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertAsset(database, {
        id: "o1",
        source: { type: "web-chatgpt", conversation_id: "conv-o", user_message: "wrong turn text" },
      });
      insertSnapshot(database, { assetId: "o1", snapshotId: "s1", userPrompt: "first prompt words" });
      insertEvent(database, { id: "message:conv-o:m1", assetId: "o1", conversationId: "conv-o", messageId: "m1", createdAt: "2026-05-01T00:00:00.000Z" });
      insertEvent(database, { id: "occurrence:2026-05-02T00:00:00.000Z", assetId: "o1", createdAt: "2026-05-02T00:00:00.000Z" });
    })();
  });
  clearRepairMarker(libraryDir);

  const first = await openStore(t, projectRoot, libraryDir);
  // Task 347: the repair runs from deferred maintenance after the open.
  await first.startDeferredMaintenance();
  const firstChanges = await first.listLibraryChangesSince("default", 0);
  const announcement = firstChanges.changes.find((change) => change.kind === "library-repaired");
  assert.ok(announcement, "the first open announces the repair");
  assert.deepEqual(announcement.detail, { reason: "repair-capture-user-message-v1", userMessagesRestored: 1, eventsRemoved: 1 });
  assert.ok(repairMarkerValue(libraryDir), "the marker is written");
  first.close();

  const revisionAfterFirstOpen = firstChanges.changes.reduce((max, change) => Math.max(max, Number(change.revision || 0)), 0);
  const second = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => second.close());
  const secondChanges = await second.listLibraryChangesSince("default", revisionAfterFirstOpen);
  assert.equal(
    secondChanges.changes.filter((change) => change.kind === "library-repaired").length,
    0,
    "the second open does not announce another repair",
  );

  withRawDatabase(libraryDir, (database) => {
    const stats = repairCaptureHistory(database, {
      commitLibraryChanges: () => {
        throw new Error("must not commit on an already-repaired library");
      },
      syncRelationCandidates: () => {
        throw new Error("must not sync on an already-repaired library");
      },
      loadMetadata: () => {
        throw new Error("must not load on an already-repaired library");
      },
      searchableText: () => "",
      syncAssetFtsEntry: () => {
        throw new Error("must not touch FTS on an already-repaired library");
      },
      replaceAssetShortTerms: () => {
        throw new Error("must not touch short terms on an already-repaired library");
      },
    });
    assert.deepEqual(stats, { userMessagesRestored: 0, eventsRemoved: 0 }, "the marker makes the repair a no-op");
  });
});

test("returns the documented stats from a direct run", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertAsset(database, {
        id: "d1",
        source: { type: "web-chatgpt", conversation_id: "conv-d", user_message: "wrong turn text" },
      });
      insertSnapshot(database, { assetId: "d1", snapshotId: "s1", userPrompt: "first prompt words" });
      insertEvent(database, { id: "message:conv-d:m1", assetId: "d1", conversationId: "conv-d", messageId: "m1", createdAt: "2026-05-01T00:00:00.000Z" });
      insertEvent(database, { id: "occurrence:2026-05-02T00:00:00.000Z", assetId: "d1", createdAt: "2026-05-02T00:00:00.000Z" });
    })();
  });
  clearRepairMarker(libraryDir);

  withRawDatabase(libraryDir, (database) => {
    const commits = [];
    const syncedProjects = [];
    const stats = repairCaptureHistory(database, {
      commitLibraryChanges: (records) => commits.push(...records),
      syncRelationCandidates: (db, projectId) => syncedProjects.push(projectId),
      loadMetadata: (row) => ({
        id: row.id,
        prompt: row.prompt,
        source: JSON.parse(row.source_json),
        business_fields: JSON.parse(row.business_fields_json),
      }),
      searchableText: (metadata) => [metadata.prompt, ...Object.values(metadata.source || {}), ...Object.values(metadata.business_fields || {})].join(" "),
      syncAssetFtsEntry: () => {},
      replaceAssetShortTerms: () => {},
    });
    assert.deepEqual(stats, { userMessagesRestored: 1, eventsRemoved: 1 });
    assert.deepEqual(syncedProjects, ["default"]);
    assert.deepEqual(commits.map((record) => record.kind), ["library-repaired"]);
  });
});

test("a library with nothing to repair opens silently and still writes the marker", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertAsset(database, {
        id: "q1",
        source: { type: "web-chatgpt", conversation_id: "conv-q", user_message: "already correct" },
      });
      insertSnapshot(database, { assetId: "q1", snapshotId: "s1", userPrompt: "already correct" });
      insertEvent(database, { id: "message:conv-q:m1", assetId: "q1", conversationId: "conv-q", messageId: "m1", createdAt: "2026-05-01T00:00:00.000Z" });
    })();
  });
  clearRepairMarker(libraryDir);

  const store = await openStore(t, projectRoot, libraryDir);
  const changes = await store.listLibraryChangesSince("default", 0);
  assert.equal(changes.changes.filter((change) => change.kind === "library-repaired").length, 0);
  assert.ok(repairMarkerValue(libraryDir), "the marker is written even on a no-op run");
});
