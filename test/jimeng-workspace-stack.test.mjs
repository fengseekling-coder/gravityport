import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { generationSessionKey } from "../lib/generation-session.mjs";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");
const GENERATE_IMAGE = "https://jimeng.jianying.com/ai-tool/generate?workspace=20297433960204&type=image";
const GENERATE_VIDEO = "https://jimeng.jianying.com/ai-tool/generate?workspace=20297433960204&type=video";

async function createFixtureStore(t, prefix = "mosa-jimeng-stack-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  const generatedDir = join(projectRoot, "generated-images");
  await mkdir(generatedDir, { recursive: true });
  const sourcePath = join(generatedDir, "fixture.png");
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  return { store, sourcePath, root, projectRoot, libraryDir, close: () => store.close() };
}

function jimengSource(conversationId, extra = {}) {
  return { type: "web-jimeng", provider: "jimeng", conversation_id: conversationId, ...extra };
}

async function ingest(store, sourcePath, assetId, createdAt, source) {
  return store.createAsset({ assetId, imagePath: sourcePath, prompt: `fixture ${assetId}`, created_at: createdAt, source });
}

// Tests build the pre-migration world by hand on a second connection: assets
// ingested with record-id sessions (the old rule), then their source_json gets
// the workspace page_url the extension always sent, and the schema marker is
// rewound to 16 so the next open runs migration 17.
function openRaw(libraryDir) {
  return new Database(join(libraryDir, "mosa.db"));
}

function rewindToSchema16(db) {
  db.prepare(`
    INSERT INTO library_meta (key, value, updated_at) VALUES ('schema_version', '16', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run("2026-10-01T00:00:00.000Z");
  db.prepare("DELETE FROM schema_migrations WHERE version >= 17").run();
}

function addPageUrl(db, assetId, pageUrl) {
  db.prepare("UPDATE assets SET source_json = json_set(source_json, '$.page_url', ?) WHERE id = ?").run(pageUrl, assetId);
}

function insertAutoStack(db, stackId, sessionKey, { nameLocked = 0, name = "" } = {}) {
  const timestamp = "2026-10-02T00:00:00.000Z";
  db.prepare(`
    INSERT INTO asset_stacks (project_id, id, created_at, updated_at, sort_created_at, sort_name, name, origin, session_key, name_locked)
    VALUES ('default', ?, ?, ?, '', '', ?, 'auto', ?, ?)
  `).run(stackId, timestamp, timestamp, name, sessionKey, nameLocked);
}

function insertManualStack(db, stackId) {
  const timestamp = "2026-10-02T00:00:00.000Z";
  db.prepare(`
    INSERT INTO asset_stacks (project_id, id, created_at, updated_at, sort_created_at, sort_name, name, origin, session_key, name_locked)
    VALUES ('default', ?, ?, ?, '', '', '', 'manual', '', 0)
  `).run(stackId, timestamp, timestamp);
}

function addMember(db, stackId, assetId, position) {
  db.prepare(`
    INSERT INTO asset_stack_members (project_id, stack_id, asset_id, position, added_at)
    VALUES ('default', ?, ?, ?, '2026-10-02T00:00:00.000Z')
  `).run(stackId, assetId, position);
}

function stackRows(db) {
  return db.prepare(`
    SELECT s.id, s.origin, s.session_key, s.name_locked, s.name,
      (SELECT group_concat(sm.asset_id, ',') FROM asset_stack_members sm
        WHERE sm.project_id = s.project_id AND sm.stack_id = s.id ORDER BY sm.position) AS members
    FROM asset_stacks s ORDER BY s.id
  `).all();
}

function sessionKeyOf(db, assetId) {
  return db.prepare("SELECT generation_session_key FROM assets WHERE id = ?").get(assetId)?.generation_session_key;
}

// --- generationSessionKey: Jimeng keys on the workspace conversation window ---

test("generationSessionKey prefers the Jimeng workspace window over the record id", () => {
  assert.equal(generationSessionKey({ source: jimengSource("48923474024204", { page_url: GENERATE_VIDEO }) }), "web-jimeng:20297433960204");
  assert.equal(generationSessionKey({ source: jimengSource("48860492523276", { page_url: GENERATE_IMAGE }) }), "web-jimeng:20297433960204", "image and video of one window share the key");
});

test("generationSessionKey falls back to the record id when the workspace is unusable", () => {
  const fallbackUrl = (url) => generationSessionKey({ source: jimengSource("48923474024204", { page_url: url }) });
  assert.equal(fallbackUrl("https://jimeng.jianying.com/ai-tool/generate?workspace=0&type=video"), "web-jimeng:48923474024204", "workspace=0 is the no-window default");
  assert.equal(fallbackUrl("https://jimeng.jianying.com/ai-tool/generate?type=video"), "web-jimeng:48923474024204", "no workspace param");
  assert.equal(fallbackUrl("https://jimeng.jianying.com/ai-tool/generate?workspace=abc&type=video"), "web-jimeng:48923474024204", "non-numeric workspace");
  assert.equal(fallbackUrl("https://jimeng.jianying.com/ai-tool/generate?workspace=12x&type=video"), "web-jimeng:48923474024204", "partially numeric workspace");
  assert.equal(fallbackUrl("https://jimeng.jianying.com/ai-tool/asset?workspace=20297433960204"), "web-jimeng:48923474024204", "other Jimeng paths do not carry a window");
  assert.equal(fallbackUrl("https://evil.example/ai-tool/generate?workspace=20297433960204"), "web-jimeng:48923474024204", "other hosts never carry a Jimeng window");
  assert.equal(fallbackUrl("not a url"), "web-jimeng:48923474024204", "unparsable page_url falls back");
  assert.equal(generationSessionKey({ source: jimengSource("48923474024204") }), "web-jimeng:48923474024204", "no page_url at all falls back");
});

// --- ingest-time auto stacking under the new key ---

test("Jimeng ingests of one workspace stack together across generation records", async (t) => {
  const { store, sourcePath, close } = await createFixtureStore(t);
  try {
    await ingest(store, sourcePath, "jm-a1", "2026-10-20T10:00:00.000Z", jimengSource("rec-1", { page_url: GENERATE_IMAGE }));
    let page = await store.listAssetPage({ projectId: "default", limit: 0, collapseStacks: true });
    assert.equal(page.assets.filter((asset) => asset.stack).length, 0, "the first generation stays loose");

    await ingest(store, sourcePath, "jm-b1", "2026-10-20T10:05:00.000Z", jimengSource("rec-2", { page_url: GENERATE_VIDEO }));
    await ingest(store, sourcePath, "jm-a2", "2026-10-20T10:10:00.000Z", jimengSource("rec-1", { page_url: GENERATE_IMAGE }));
    page = await store.listAssetPage({ projectId: "default", limit: 0, collapseStacks: true });
    const stack = page.assets.find((asset) => asset.stack)?.stack;
    assert.ok(stack, "later generations of the same window join the stack");
    const summary = await store.getAssetStack("default", stack.id);
    assert.equal(summary.count, 3);
    assert.equal(summary.origin, "auto");
    assert.equal(summary.session_key, "web-jimeng:20297433960204");
    assert.deepEqual(
      (await store.listAssetStackAssets("default", stack.id)).assets.map((asset) => asset.id),
      ["jm-a1", "jm-b1", "jm-a2"],
    );
  } finally {
    close();
  }
});

test("Jimeng ingests without a workspace window keep one stack per generation record", async (t) => {
  const { store, sourcePath, close } = await createFixtureStore(t);
  try {
    const noWindow = "https://jimeng.jianying.com/ai-tool/generate?workspace=0&type=image";
    await ingest(store, sourcePath, "jm-z1", "2026-10-20T11:00:00.000Z", jimengSource("rec-9", { page_url: noWindow }));
    await ingest(store, sourcePath, "jm-z2", "2026-10-20T11:05:00.000Z", jimengSource("rec-8", { page_url: noWindow }));
    const page = await store.listAssetPage({ projectId: "default", limit: 0, collapseStacks: true });
    assert.equal(page.assets.filter((asset) => asset.stack).length, 0, "workspace=0 captures never group across records");
  } finally {
    close();
  }
});

// --- migration 17: regroup already-ingested Jimeng assets by workspace ---

test("migration 17 merges same-window Jimeng assets and removes their emptied record stacks", async (t) => {
  const { store, sourcePath, libraryDir, projectRoot, close } = await createFixtureStore(t);
  await ingest(store, sourcePath, "jm-m1", "2026-10-20T09:00:00.000Z", jimengSource("rec-a1"));
  await ingest(store, sourcePath, "jm-m2", "2026-10-20T09:01:00.000Z", jimengSource("rec-a2"));
  await ingest(store, sourcePath, "jm-m3", "2026-10-20T09:02:00.000Z", jimengSource("rec-b1"));
  close();
  const db = openRaw(libraryDir);
  for (const id of ["jm-m1", "jm-m2", "jm-m3"]) addPageUrl(db, id, GENERATE_VIDEO);
  insertAutoStack(db, "stack-old-a", "web-jimeng:rec-a1");
  addMember(db, "stack-old-a", "jm-m1", 0);
  addMember(db, "stack-old-a", "jm-m2", 1);
  insertAutoStack(db, "stack-old-b", "web-jimeng:rec-b1");
  addMember(db, "stack-old-b", "jm-m3", 0);
  rewindToSchema16(db);
  db.close();

  const reopened = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => reopened.close());
  const raw = openRaw(libraryDir);
  t.after(() => raw.close());
  assert.equal(sessionKeyOf(raw, "jm-m1"), "web-jimeng:20297433960204", "keys re-derived to the window");
  const stacks = stackRows(raw);
  assert.equal(stacks.length, 1, "both record stacks are gone");
  assert.equal(stacks[0].origin, "auto");
  assert.equal(stacks[0].session_key, "web-jimeng:20297433960204");
  assert.equal(stacks[0].members, "jm-m1,jm-m2,jm-m3", "all three assets join in ingest order");
});

test("migration 17 leaves workspace=0 captures ungrouped", async (t) => {
  const { store, sourcePath, libraryDir, projectRoot, close } = await createFixtureStore(t);
  await ingest(store, sourcePath, "jm-w1", "2026-10-20T12:00:00.000Z", jimengSource("rec-c1"));
  await ingest(store, sourcePath, "jm-w2", "2026-10-20T12:01:00.000Z", jimengSource("rec-c2"));
  close();
  const db = openRaw(libraryDir);
  for (const id of ["jm-w1", "jm-w2"]) {
    addPageUrl(db, id, "https://jimeng.jianying.com/ai-tool/generate?workspace=0&type=video");
  }
  insertAutoStack(db, "stack-old-c", "web-jimeng:rec-c1");
  addMember(db, "stack-old-c", "jm-w1", 0);
  rewindToSchema16(db);
  db.close();

  const reopened = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => reopened.close());
  const raw = openRaw(libraryDir);
  t.after(() => raw.close());
  assert.equal(sessionKeyOf(raw, "jm-w1"), "web-jimeng:rec-c1", "keys fall back to the record id");
  const stacks = stackRows(raw);
  assert.equal(stacks.length, 1, "the existing record stack is the only one");
  assert.equal(stacks[0].id, "stack-old-c");
  assert.equal(stacks[0].members, "jm-w1");
});

test("migration 17 never touches renamed Jimeng record stacks", async (t) => {
  const { store, sourcePath, libraryDir, projectRoot, close } = await createFixtureStore(t);
  await ingest(store, sourcePath, "jm-r1", "2026-10-20T13:00:00.000Z", jimengSource("rec-d1"));
  await ingest(store, sourcePath, "jm-r2", "2026-10-20T13:01:00.000Z", jimengSource("rec-d2"));
  close();
  const db = openRaw(libraryDir);
  for (const id of ["jm-r1", "jm-r2"]) addPageUrl(db, id, "https://jimeng.jianying.com/ai-tool/generate?workspace=555000111222&type=image");
  insertAutoStack(db, "stack-renamed", "web-jimeng:rec-d1", { nameLocked: 1, name: "我起的名字" });
  addMember(db, "stack-renamed", "jm-r1", 0);
  addMember(db, "stack-renamed", "jm-r2", 1);
  rewindToSchema16(db);
  db.close();

  const reopened = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => reopened.close());
  const raw = openRaw(libraryDir);
  t.after(() => raw.close());
  const stacks = stackRows(raw);
  assert.equal(stacks.length, 1, "no second stack is created for the window");
  assert.equal(stacks[0].id, "stack-renamed");
  assert.equal(Number(stacks[0].name_locked), 1);
  assert.equal(stacks[0].members, "jm-r1,jm-r2", "renamed stacks keep every member");
});

test("migration 17 respects exclusions and manual stacks", async (t) => {
  const { store, sourcePath, libraryDir, projectRoot, close } = await createFixtureStore(t);
  await ingest(store, sourcePath, "jm-x1", "2026-10-20T14:00:00.000Z", jimengSource("rec-e1"));
  await ingest(store, sourcePath, "jm-x2", "2026-10-20T14:01:00.000Z", jimengSource("rec-e2"));
  await ingest(store, sourcePath, "jm-x3", "2026-10-20T14:02:00.000Z", jimengSource("rec-e3"));
  await ingest(store, sourcePath, "jm-x4", "2026-10-20T14:03:00.000Z", jimengSource("rec-e4"));
  await ingest(store, sourcePath, "jm-x5", "2026-10-20T14:04:00.000Z", jimengSource("rec-e5"));
  close();
  const db = openRaw(libraryDir);
  const window = "https://jimeng.jianying.com/ai-tool/generate?workspace=777000999888&type=video";
  for (const id of ["jm-x1", "jm-x2", "jm-x3", "jm-x4", "jm-x5"]) addPageUrl(db, id, window);
  db.prepare(`
    INSERT INTO auto_stack_exclusions (project_id, asset_id, session_key, created_at)
    VALUES ('default', 'jm-x2', 'web-jimeng:rec-e2', '2026-10-21T00:00:00.000Z')
  `).run();
  insertManualStack(db, "stack-manual");
  addMember(db, "stack-manual", "jm-x4", 0);
  addMember(db, "stack-manual", "jm-x5", 1);
  rewindToSchema16(db);
  db.close();

  const reopened = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => reopened.close());
  const raw = openRaw(libraryDir);
  t.after(() => raw.close());
  const stacks = stackRows(raw).sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(stacks.length, 2);
  const auto = stacks.find((row) => row.origin === "auto");
  const manual = stacks.find((row) => row.origin === "manual");
  assert.equal(auto.members, "jm-x1,jm-x3", "only the two eligible loose assets join the window stack");
  assert.equal(manual.id, "stack-manual");
  assert.equal(manual.members, "jm-x4,jm-x5", "manual stack members never move");
});

test("migration 17 runs once and later opens change nothing", async (t) => {
  const { store, sourcePath, libraryDir, projectRoot, close } = await createFixtureStore(t);
  await ingest(store, sourcePath, "jm-o1", "2026-10-20T15:00:00.000Z", jimengSource("rec-f1"));
  await ingest(store, sourcePath, "jm-o2", "2026-10-20T15:01:00.000Z", jimengSource("rec-f2"));
  close();
  const db = openRaw(libraryDir);
  for (const id of ["jm-o1", "jm-o2"]) addPageUrl(db, id, "https://jimeng.jianying.com/ai-tool/generate?workspace=888111222333&type=image");
  rewindToSchema16(db);
  db.close();

  const openStore = () => createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  const first = openStore();
  const snapshot = () => {
    const raw = openRaw(libraryDir);
    try {
      return JSON.stringify({
        revision: raw.prepare("SELECT value FROM library_meta WHERE key = 'library_revision'").get()?.value || "0",
        schema: raw.prepare("SELECT value FROM library_meta WHERE key = 'schema_version'").get().value,
        stacks: stackRows(raw),
      });
    } finally {
      raw.close();
    }
  };
  const afterFirst = snapshot();
  first.close();

  const second = openStore();
  t.after(() => second.close());
  const afterSecond = snapshot();
  assert.equal(afterFirst, afterSecond, "the second open neither re-migrates nor bumps the revision");
  assert.match(afterFirst, /"schema":"17"/);
});

test("migration 17 rolls back completely when it fails mid-way", async (t) => {
  const { store, sourcePath, libraryDir, projectRoot, close } = await createFixtureStore(t);
  await ingest(store, sourcePath, "jm-e1", "2026-10-20T16:00:00.000Z", jimengSource("rec-g1"));
  await ingest(store, sourcePath, "jm-e2", "2026-10-20T16:01:00.000Z", jimengSource("rec-g2"));
  await ingest(store, sourcePath, "jm-e3", "2026-10-20T16:02:00.000Z", jimengSource("rec-g3"));
  close();
  const db = openRaw(libraryDir);
  for (const id of ["jm-e1", "jm-e2", "jm-e3"]) addPageUrl(db, id, "https://jimeng.jianying.com/ai-tool/generate?workspace=999000111222&type=video");
  insertAutoStack(db, "stack-old-g", "web-jimeng:rec-g1");
  addMember(db, "stack-old-g", "jm-e1", 0);
  rewindToSchema16(db);
  db.close();

  const sabotage = openRaw(libraryDir);
  sabotage.exec("CREATE TRIGGER sabotage_stack_insert BEFORE INSERT ON asset_stack_members BEGIN SELECT RAISE(ABORT, 'injected sabotage'); END");
  sabotage.close();
  const beforeFailure = openRaw(libraryDir);
  const preState = JSON.stringify({
    schema: beforeFailure.prepare("SELECT value FROM library_meta WHERE key = 'schema_version'").get().value,
    stacks: stackRows(beforeFailure),
  });
  beforeFailure.close();

  assert.throws(
    () => createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir }),
    /injected sabotage/,
    "the failing migration aborts the open",
  );

  const afterFailure = openRaw(libraryDir);
  afterFailure.exec("DROP TRIGGER sabotage_stack_insert");
  assert.equal(
    JSON.stringify({ schema: afterFailure.prepare("SELECT value FROM library_meta WHERE key = 'schema_version'").get().value, stacks: stackRows(afterFailure) }),
    preState,
    "the migration transaction rolled back to the exact pre-migration state",
  );
  afterFailure.close();

  const recovered = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => recovered.close());
  const raw = openRaw(libraryDir);
  t.after(() => raw.close());
  const stacks = stackRows(raw);
  assert.equal(stacks.length, 1, "the retry after the sabotage is removed completes the regrouping");
  assert.equal(stacks[0].session_key, "web-jimeng:999000111222");
  assert.equal(stacks[0].members, "jm-e1,jm-e2,jm-e3");
});
