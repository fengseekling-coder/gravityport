// One-time video metadata backfill tests: width/height/duration_seconds read
// from the original files at store open (marker video_metadata_backfill_v1),
// plus the createAsset fill that gives drag/paste/file/folder imports their
// dimensions. Rows are seeded through a raw connection, the same pattern the
// other one-time repair test files use.
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";

const VIDEO_METADATA_BACKFILL_MARKER_KEY = "video_metadata_backfill_v1";
const CAPTURE_FIXTURE = resolve(import.meta.dirname, "fixtures", "video-metadata", "capture-72x128.mp4");
const CREATED = "2026-05-01T00:00:00.000Z";

async function createLibraryRoot(t, prefix = "mosa-video-backfill-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  const filesDir = join(root, "videos");
  const bootstrap = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  bootstrap.close();
  await mkdir(filesDir, { recursive: true });
  return { projectRoot, libraryDir, filesDir };
}

function openStore(t, projectRoot, libraryDir, { captureWarns } = {}) {
  const warns = [];
  const originalWarn = console.warn;
  if (captureWarns) console.warn = (...parts) => { warns.push(parts.map(String).join(" ")); };
  try {
    const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
    t.after(() => store.close());
    return { store, warns };
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

function clearBackfillMarker(libraryDir) {
  withRawDatabase(libraryDir, (database) => {
    database.prepare("DELETE FROM library_meta WHERE key = ?").run(VIDEO_METADATA_BACKFILL_MARKER_KEY);
  });
}

function insertVideoAsset(database, {
  id,
  projectId = "default",
  originalPath,
  businessFields = {},
  createdAt = CREATED,
  deletedAt = null,
}) {
  database.prepare(`
    INSERT INTO assets (
      project_id, id, asset, original_path, content_sha256, prompt, skill, style, ratio, business_fields_json, theme,
      favorite, archived, group_name, category, rating, version_change, source_type, source_json, metadata_json, search_text,
      tags_text, business_search_text, source_search_text, media_kind, source_group, conversation_id, generation_batch,
      created_at, created_at_epoch, updated_at, sort_name
    ) VALUES (
      @projectId, @id, @asset, @originalPath, @hash, '', '', '', '', @businessFields, '',
      0, 0, '', '', 0, '', 'web-jimeng', '{}', '', '',
      '', '', '', 'video', 'web-jimeng', '', '',
      @createdAt, @epoch, @createdAt, @id
    )
  `).run({
    projectId,
    id,
    asset: `${id}.mp4`,
    originalPath,
    hash: `hash-${id}`,
    businessFields: JSON.stringify(businessFields),
    createdAt,
    epoch: Date.parse(createdAt),
  });
  if (deletedAt) {
    database.prepare("UPDATE assets SET deleted_at = ? WHERE project_id = ? AND id = ?").run(deletedAt, projectId, id);
  }
}

function readAssetRow(libraryDir, id) {
  return withRawDatabase(libraryDir, (database) =>
    database.prepare("SELECT * FROM assets WHERE id = ?").get(id));
}

// --- the backfill pass ---

test("fills missing dimensions, corrects a wrong duration, and preserves every other key", async (t) => {
  const { projectRoot, libraryDir, filesDir } = await createLibraryRoot(t);
  const videoPath = join(filesDir, "web-jimeng-video-8c46e0773d63.mp4");
  await copyFile(CAPTURE_FIXTURE, videoPath);
  withRawDatabase(libraryDir, (database) => {
    insertVideoAsset(database, {
      id: "v-fill",
      originalPath: videoPath,
      // What the Jimeng capture stored before the file read: no dimensions,
      // a provider-reported duration of 7 for a 2 s file.
      businessFields: { prompt_status: "not-available", media_kind: "video", duration_seconds: 7, user_message: "画一只猫" },
    });
  });
  clearBackfillMarker(libraryDir);

  const { store, warns } = openStore(t, projectRoot, libraryDir, { captureWarns: true });
  const row = readAssetRow(libraryDir, "v-fill");
  const fields = JSON.parse(row.business_fields_json);
  assert.equal(fields.width, 72);
  assert.equal(fields.height, 128);
  assert.equal(fields.duration_seconds, 2);
  // Key-level merge: everything the row carried before stays byte-identical.
  assert.equal(fields.prompt_status, "not-available");
  assert.equal(fields.media_kind, "video");
  assert.equal(fields.user_message, "画一只猫");
  assert.equal(row.created_at, CREATED, "created_at untouched so newest-first sorting is stable");
  assert.equal(row.updated_at, CREATED, "updated_at untouched");
  assert.equal(row.deleted_at, null);

  const changes = await store.listLibraryChangesSince("default", 0);
  const announcement = changes.changes.find((change) => change.kind === "library-backfilled"
    && change.detail?.reason === "video-metadata-backfill-v1");
  assert.ok(announcement, "the first open announces the backfill");
  assert.match(
    warns.find((line) => line.includes("video_metadata_backfill_v1")) || "",
    /filled width\/height\/duration on 1 video asset/,
  );
});

test("includes trash rows and leaves correct rows alone", async (t) => {
  const { projectRoot, libraryDir, filesDir } = await createLibraryRoot(t);
  const videoPath = join(filesDir, "correct.mp4");
  await copyFile(CAPTURE_FIXTURE, videoPath);
  withRawDatabase(libraryDir, (database) => {
    insertVideoAsset(database, {
      id: "v-trashed",
      originalPath: videoPath,
      businessFields: { duration_seconds: 7 },
      deletedAt: "2026-05-02T00:00:00.000Z",
    });
    insertVideoAsset(database, {
      id: "v-correct",
      originalPath: videoPath,
      // Dimensions already present and a duration within half a second of the
      // file: nothing to do, and the file must not overwrite them.
      businessFields: { width: 640, height: 360, duration_seconds: 1.9 },
    });
  });
  clearBackfillMarker(libraryDir);

  openStore(t, projectRoot, libraryDir);
  const trashed = JSON.parse(readAssetRow(libraryDir, "v-trashed").business_fields_json);
  assert.equal(trashed.width, 72);
  assert.equal(trashed.height, 128);
  assert.equal(trashed.duration_seconds, 2);
  const correct = JSON.parse(readAssetRow(libraryDir, "v-correct").business_fields_json);
  assert.deepEqual(correct, { width: 640, height: 360, duration_seconds: 1.9 });
});

test("skips missing files silently and unreadable files with one log line", async (t) => {
  const { projectRoot, libraryDir, filesDir } = await createLibraryRoot(t);
  const unreadablePath = join(filesDir, "broken.mp4");
  await copyFile(resolve(import.meta.dirname, "fixtures", "video-metadata", "truncated.mp4"), unreadablePath);
  withRawDatabase(libraryDir, (database) => {
    insertVideoAsset(database, {
      id: "v-gone",
      originalPath: join(filesDir, "deleted-from-disk.mp4"),
      businessFields: {},
    });
    insertVideoAsset(database, {
      id: "v-broken",
      originalPath: unreadablePath,
      businessFields: {},
    });
  });
  clearBackfillMarker(libraryDir);

  const { warns } = openStore(t, projectRoot, libraryDir, { captureWarns: true });
  assert.deepEqual(JSON.parse(readAssetRow(libraryDir, "v-gone").business_fields_json), {});
  assert.deepEqual(JSON.parse(readAssetRow(libraryDir, "v-broken").business_fields_json), {});
  const skipped = warns.filter((line) => line.includes("unreadable video file skipped"));
  assert.equal(skipped.length, 1, "exactly one line for the unreadable file, none for the missing one");
  assert.match(skipped[0], /broken\.mp4/);
  assert.equal(warns.some((line) => line.includes("filled width/height/duration")), false);
});

test("runs once: the marker short-circuits later opens", async (t) => {
  const { projectRoot, libraryDir, filesDir } = await createLibraryRoot(t);
  const videoPath = join(filesDir, "once.mp4");
  await copyFile(CAPTURE_FIXTURE, videoPath);
  withRawDatabase(libraryDir, (database) => {
    insertVideoAsset(database, { id: "v-once", originalPath: videoPath, businessFields: { duration_seconds: 7 } });
  });
  clearBackfillMarker(libraryDir);
  openStore(t, projectRoot, libraryDir).store.close();

  // Damage a row again after the marker exists: the next open must not
  // "helpfully" repair it — the pass is one-time by design.
  withRawDatabase(libraryDir, (database) => {
    database.prepare("UPDATE assets SET business_fields_json = ? WHERE id = ?").run(JSON.stringify({}), "v-once");
  });

  openStore(t, projectRoot, libraryDir);
  assert.deepEqual(JSON.parse(readAssetRow(libraryDir, "v-once").business_fields_json), {});
});

// --- the createAsset fill for imports (drag / paste / file / folder) ---

test("createAsset reads dimensions for an imported video with no business_fields", async (t) => {
  const { projectRoot, libraryDir, filesDir } = await createLibraryRoot(t);
  const stagedPath = join(filesDir, "import-clip.mp4");
  await copyFile(CAPTURE_FIXTURE, stagedPath);
  const { store } = openStore(t, projectRoot, libraryDir);
  // The import-batch route passes the staging root as a trusted source root.
  const asset = await store.createAsset(
    { imagePath: stagedPath, fileName: "import-clip.mp4", assetId: "imported-video" },
    { trustedSourceRoots: [filesDir] },
  );
  assert.equal(asset.business_fields.width, 72);
  assert.equal(asset.business_fields.height, 128);
  assert.equal(asset.business_fields.duration_seconds, 2);
});

test("createAsset keeps caller-supplied dimensions on an imported video", async (t) => {
  const { projectRoot, libraryDir, filesDir } = await createLibraryRoot(t);
  const stagedPath = join(filesDir, "import-clip-2.mp4");
  await copyFile(CAPTURE_FIXTURE, stagedPath);
  const { store } = openStore(t, projectRoot, libraryDir);
  const asset = await store.createAsset({
    imagePath: stagedPath,
    fileName: "import-clip-2.mp4",
    assetId: "imported-video-2",
    business_fields: { width: 640, height: 360, source_note: "measured by the page" },
  }, { trustedSourceRoots: [filesDir] });
  assert.equal(asset.business_fields.width, 640);
  assert.equal(asset.business_fields.height, 360);
  // Duration was missing, so the file still fills it in.
  assert.equal(asset.business_fields.duration_seconds, 2);
  assert.equal(asset.business_fields.source_note, "measured by the page");
});
