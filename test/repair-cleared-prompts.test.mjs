import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { repairClearedCapturePrompts, CLEARED_PROMPT_REPAIR_MARKER_KEY } from "../lib/repair-cleared-prompts.mjs";

const DEFAULT_CREATED = "2026-05-01T00:00:00.000Z";
const CAPTION = "Model caption: A neon-lit city skyline reflected in a rainy street.";

async function createLibraryRoot(t, prefix = "mosa-repair-cleared-prompts-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  // Bootstrap the schema with a real store open, then seed damaged rows
  // through a second raw connection, the same pattern the other one-time
  // repair test files use. The bootstrap open already runs the (empty) repair
  // and writes the marker, so seeding clears it to restore "never repaired".
  const bootstrap = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  bootstrap.close();
  return { projectRoot, libraryDir };
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
    database.prepare("DELETE FROM library_meta WHERE key = ?").run(CLEARED_PROMPT_REPAIR_MARKER_KEY);
  });
}

function repairMarkerValue(libraryDir) {
  return withRawDatabase(libraryDir, (database) =>
    database.prepare("SELECT value FROM library_meta WHERE key = ?").get(CLEARED_PROMPT_REPAIR_MARKER_KEY)?.value || null,
  );
}

function insertAsset(database, { id, projectId = "default", prompt = "", sourceType = "web-chatgpt", deletedAt = null, createdAt = DEFAULT_CREATED }) {
  database.prepare(`
    INSERT INTO assets (
      project_id, id, asset, original_path, content_sha256, prompt, skill, style, ratio, business_fields_json, theme,
      favorite, archived, group_name, category, rating, version_change, source_type, source_json, metadata_json, search_text,
      tags_text, business_search_text, source_search_text, media_kind, source_group, conversation_id, generation_batch,
      created_at, created_at_epoch, updated_at, sort_name
    ) VALUES (
      @projectId, @id, @asset, '/legacy', @hash, @prompt, '', '', '', '{}', '',
      0, 0, '', '', 0, '', @sourceType, '{}', '', '',
      '', '', '', 'image', @sourceType, '', '',
      @created, @epoch, @created, @id
    )
  `).run({
    projectId,
    id,
    asset: `${id}.png`,
    hash: `hash-${id}`,
    prompt,
    sourceType,
    created: createdAt,
    epoch: Date.parse(createdAt),
  });
  if (deletedAt) database.prepare("UPDATE assets SET deleted_at = ? WHERE project_id = ? AND id = ?").run(deletedAt, projectId, id);
}

// Defaults shape one fully matching cleared ChatGPT capture record; every
// skip-scenario test overrides exactly the field that must disqualify it.
function insertEvent(database, { id, assetId, projectId = "default", provider = "chatgpt", captureChannel = "chrome-extension", evidence = { source: "web-capture" }, effectivePrompt = "", promptStatus = "not-available", createdAt = DEFAULT_CREATED }) {
  database.prepare(`
    INSERT INTO generation_events (
      project_id, id, output_asset_id, provider, capture_context_id, provider_generation_call_id,
      provider_asset_id, conversation_id, message_id, model, user_prompt, effective_prompt, prompt_status,
      generation_status, capture_channel, verification_level, evidence_json, created_at
    ) VALUES (
      @projectId, @id, @assetId, @provider, '', '',
      '', '', '', '', '', @effectivePrompt, @promptStatus,
      'unknown', @captureChannel, 'observed', @evidence, @createdAt
    )
  `).run({ projectId, id, assetId, provider, captureChannel, evidence: JSON.stringify(evidence), effectivePrompt, promptStatus, createdAt });
}

function readEvent(libraryDir, id) {
  return withRawDatabase(libraryDir, (database) =>
    database.prepare("SELECT * FROM generation_events WHERE id = ?").get(id));
}

// --- the repair path ---

test("restores the stored caption on an image whose only generation record was cleared", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertAsset(database, { id: "a1", prompt: CAPTION });
      insertEvent(database, { id: "e-a1", assetId: "a1" });
    })();
  });
  clearRepairMarker(libraryDir);

  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...parts) => { warns.push(parts.map(String).join(" ")); };
  let store;
  try {
    store = await openStore(t, projectRoot, libraryDir);
  } finally {
    console.warn = originalWarn;
  }

  const events = await store.listGenerationEvents("default", { assetId: "a1" });
  assert.equal(events.length, 1);
  assert.equal(events[0].effective_prompt, CAPTION, "the caption moves onto the record verbatim");
  assert.equal(events[0].prompt_status, "visible-caption");
  // Nothing else on the record may change — the model is not recoverable.
  assert.equal(events[0].model, "");
  assert.equal(events[0].user_prompt, "");
  assert.equal(events[0].generation_status, "unknown");
  assert.equal(events[0].capture_channel, "chrome-extension");
  assert.equal(events[0].created_at, DEFAULT_CREATED);
  assert.deepEqual(events[0].evidence, { source: "web-capture" });

  const changes = await store.listLibraryChangesSince("default", 0);
  const announcement = changes.changes.find((change) => change.kind === "library-repaired");
  assert.ok(announcement, "the first open announces the repair");
  assert.deepEqual(announcement.detail, { reason: "repair-cleared-capture-prompt-v1", promptsRestored: 1 });

  assert.deepEqual(
    warns.filter((line) => line.includes("repair_cleared_capture_prompt_v1")),
    ["[MOSA] repair_cleared_capture_prompt_v1: restored 1 prompt(s)."],
    "exactly one completion line on stderr",
  );
  assert.ok(repairMarkerValue(libraryDir), "the marker is written");
});

// --- the skip paths ---

test("leaves both records alone when an image has a second record that still holds its prompt", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertAsset(database, { id: "a2", prompt: CAPTION });
      insertEvent(database, { id: "e-a2-good", assetId: "a2", effectivePrompt: CAPTION, promptStatus: "visible-caption" });
      insertEvent(database, { id: "e-a2-blank", assetId: "a2" });
    })();
  });
  clearRepairMarker(libraryDir);

  const store = await openStore(t, projectRoot, libraryDir);
  const events = await store.listGenerationEvents("default", { assetId: "a2" });
  assert.equal(events.length, 2, "both records survive");
  const good = events.find((event) => event.id === "e-a2-good");
  const blank = events.find((event) => event.id === "e-a2-blank");
  assert.equal(good.effective_prompt, CAPTION, "the intact record is untouched");
  assert.equal(blank.effective_prompt, "", "the duplicate is not the repair's business");
  assert.equal(blank.prompt_status, "not-available");
  const changes = await store.listLibraryChangesSince("default", 0);
  assert.equal(changes.changes.filter((change) => change.kind === "library-repaired").length, 0);
});

test("leaves records alone when the image prompt is the user's own words, not a model caption", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertAsset(database, { id: "a3", prompt: "a cozy cabin in the woods at dusk" });
      insertEvent(database, { id: "e-a3", assetId: "a3" });
    })();
  });
  clearRepairMarker(libraryDir);

  const store = await openStore(t, projectRoot, libraryDir);
  const events = await store.listGenerationEvents("default", { assetId: "a3" });
  assert.equal(events[0].effective_prompt, "");
  assert.equal(events[0].prompt_status, "not-available");
});

test("leaves records alone when the image is in the trash", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertAsset(database, { id: "a4", prompt: CAPTION, deletedAt: "2026-05-02T00:00:00.000Z" });
      insertEvent(database, { id: "e-a4", assetId: "a4" });
    })();
  });
  clearRepairMarker(libraryDir);

  const store = await openStore(t, projectRoot, libraryDir);
  const events = await store.listGenerationEvents("default", { assetId: "a4" });
  assert.equal(events[0].effective_prompt, "");
  assert.equal(events[0].prompt_status, "not-available");
});

test("leaves records alone when the prompt status is not not-available", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertAsset(database, { id: "a5", prompt: CAPTION });
      insertEvent(database, { id: "e-a5", assetId: "a5", promptStatus: "visible-caption" });
    })();
  });
  clearRepairMarker(libraryDir);

  const store = await openStore(t, projectRoot, libraryDir);
  const events = await store.listGenerationEvents("default", { assetId: "a5" });
  assert.equal(events[0].effective_prompt, "");
  assert.equal(events[0].prompt_status, "visible-caption");
});

test("leaves records alone when the capture is not a plugin-captured ChatGPT image", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertAsset(database, { id: "a6", prompt: CAPTION });
      insertEvent(database, { id: "e-a6-provider", assetId: "a6", provider: "grok" });
      insertAsset(database, { id: "a7", prompt: CAPTION });
      insertEvent(database, { id: "e-a7-channel", assetId: "a7", captureChannel: "" });
      insertAsset(database, { id: "a8", prompt: CAPTION });
      insertEvent(database, { id: "e-a8-evidence", assetId: "a8", evidence: { source: "browser-upload" } });
    })();
  });
  clearRepairMarker(libraryDir);

  const store = await openStore(t, projectRoot, libraryDir);
  for (const [id, assetId] of [
    ["e-a6-provider", "a6"],
    ["e-a7-channel", "a7"],
    ["e-a8-evidence", "a8"],
  ]) {
    const events = await store.listGenerationEvents("default", { assetId });
    assert.equal(events.length, 1, `${id} survived the unrelated passes`);
    assert.equal(events[0].id, id);
    assert.equal(events[0].effective_prompt, "", `${id} stays cleared`);
    assert.equal(events[0].prompt_status, "not-available");
  }
  assert.ok(repairMarkerValue(libraryDir), "the marker is written even when nothing matched");
});

// --- one-shot marker and stats ---

test("runs once: reopening does not repair again or announce, and the marker short-circuits direct runs", async (t) => {
  const { projectRoot, libraryDir } = await createLibraryRoot(t);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertAsset(database, { id: "o1", prompt: CAPTION });
      insertEvent(database, { id: "e-o1", assetId: "o1" });
    })();
  });
  clearRepairMarker(libraryDir);

  const first = await openStore(t, projectRoot, libraryDir);
  // Task 347: the repair runs from deferred maintenance after the open.
  await first.startDeferredMaintenance();
  const firstChanges = await first.listLibraryChangesSince("default", 0);
  assert.equal(firstChanges.changes.filter((change) => change.kind === "library-repaired").length, 1);
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
    const stats = repairClearedCapturePrompts(database, {
      commitLibraryChanges: () => {
        throw new Error("must not commit on an already-repaired library");
      },
    });
    assert.deepEqual(stats, { promptsRestored: 0 }, "the marker makes the repair a no-op");
  });
});

test("returns the documented stats and announces per affected project on a direct run", async (t) => {
  const { libraryDir } = await createLibraryRoot(t);
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      insertAsset(database, { id: "d1", prompt: CAPTION });
      insertEvent(database, { id: "e-d1", assetId: "d1" });
      insertAsset(database, { id: "d2", projectId: "second", prompt: CAPTION });
      insertEvent(database, { id: "e-d2", assetId: "d2", projectId: "second" });
    })();
  });
  clearRepairMarker(libraryDir);

  withRawDatabase(libraryDir, (database) => {
    const commits = [];
    const stats = repairClearedCapturePrompts(database, {
      commitLibraryChanges: (records) => commits.push(...records),
    });
    assert.deepEqual(stats, { promptsRestored: 2 });
    assert.deepEqual(
      commits.map((record) => [record.projectId, record.kind, record.detail]),
      [
        ["default", "library-repaired", { reason: "repair-cleared-capture-prompt-v1", promptsRestored: 1 }],
        ["second", "library-repaired", { reason: "repair-cleared-capture-prompt-v1", promptsRestored: 1 }],
      ],
    );
  });
});
