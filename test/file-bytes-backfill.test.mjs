// One-time file-size (file_bytes) backfill tests: the size stat'ed from the
// original files at store open (marker file_bytes_backfill_v1), plus the
// createAsset fill that gives manual imports and Cowart captures their size
// property. Rows are seeded through a raw connection, the same pattern the
// other one-time repair test files use.
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";

const FILE_BYTES_BACKFILL_MARKER_KEY = "file_bytes_backfill_v1";
const CAPTURE_FIXTURE = resolve(import.meta.dirname, "fixtures", "video-metadata", "capture-72x128.mp4");
const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");
const CREATED = "2026-05-01T00:00:00.000Z";

async function createLibraryRoot(t, prefix = "mosa-file-bytes-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  const filesDir = join(root, "files");
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
    database.prepare("DELETE FROM library_meta WHERE key = ?").run(FILE_BYTES_BACKFILL_MARKER_KEY);
  });
}

function insertAsset(database, {
  id,
  projectId = "default",
  originalPath,
  mediaKind = "image",
  sourceType = "local-file",
  fileName = `${id}.png`,
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
      0, 0, '', '', 0, '', @sourceType, '{}', '', '',
      '', '', '', @mediaKind, '', '', '',
      @createdAt, @epoch, @createdAt, @id
    )
  `).run({
    projectId,
    id,
    asset: fileName,
    originalPath,
    hash: `hash-${id}`,
    businessFields: JSON.stringify(businessFields),
    mediaKind,
    sourceType,
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

// --- the createAsset fill for manual imports (drag / paste / file / folder,
// Cowart goes through the same store call) ---

test("createAsset records file size for an imported image with no business_fields", async (t) => {
  const { projectRoot, libraryDir, filesDir } = await createLibraryRoot(t);
  const stagedPath = join(filesDir, "imported.png");
  await writeFile(stagedPath, ONE_PIXEL_PNG);
  const { store } = openStore(t, projectRoot, libraryDir);
  // The import-batch route passes the staging root as a trusted source root.
  const asset = await store.createAsset(
    { imagePath: stagedPath, fileName: "imported.png", assetId: "imported-image" },
    { trustedSourceRoots: [filesDir] },
  );
  const staged = await stat(stagedPath);
  assert.equal(asset.business_fields.file_bytes, staged.size);
});

test("createAsset records file size for an imported video alongside the dimension fill", async (t) => {
  const { projectRoot, libraryDir, filesDir } = await createLibraryRoot(t);
  const stagedPath = join(filesDir, "import-clip.mp4");
  await copyFile(CAPTURE_FIXTURE, stagedPath);
  const { store } = openStore(t, projectRoot, libraryDir);
  const asset = await store.createAsset(
    { imagePath: stagedPath, fileName: "import-clip.mp4", assetId: "imported-video" },
    { trustedSourceRoots: [filesDir] },
  );
  const staged = await stat(stagedPath);
  assert.equal(asset.business_fields.file_bytes, staged.size);
  // The video dimension fill from video_metadata_backfill keeps working on
  // top of the same merged business_fields.
  assert.equal(asset.business_fields.width, 72);
  assert.equal(asset.business_fields.height, 128);
  assert.equal(asset.business_fields.duration_seconds, 2);
});

test("createAsset keeps a caller-supplied file size", async (t) => {
  const { projectRoot, libraryDir, filesDir } = await createLibraryRoot(t);
  const stagedPath = join(filesDir, "captured.png");
  await writeFile(stagedPath, ONE_PIXEL_PNG);
  const { store } = openStore(t, projectRoot, libraryDir);
  const asset = await store.createAsset({
    imagePath: stagedPath,
    fileName: "captured.png",
    assetId: "captured-image",
    business_fields: { file_bytes: 12345, source_note: "reported by the page" },
  }, { trustedSourceRoots: [filesDir] });
  assert.equal(asset.business_fields.file_bytes, 12345);
  assert.equal(asset.business_fields.source_note, "reported by the page");
});

// --- the one-time backfill pass ---

test("backfill fills missing sizes at open, includes trash rows, and preserves every other key", async (t) => {
  const { projectRoot, libraryDir, filesDir } = await createLibraryRoot(t);
  const imagePath = join(filesDir, "imported-before.png");
  const trashImagePath = join(filesDir, "trashed-before.png");
  await writeFile(imagePath, ONE_PIXEL_PNG);
  await writeFile(trashImagePath, Buffer.concat([ONE_PIXEL_PNG, ONE_PIXEL_PNG]));
  withRawDatabase(libraryDir, (database) => {
    insertAsset(database, {
      id: "img-missing",
      originalPath: imagePath,
      businessFields: { source_note: "manual import" },
    });
    insertAsset(database, {
      id: "img-trashed",
      originalPath: trashImagePath,
      businessFields: {},
      deletedAt: "2026-05-02T00:00:00.000Z",
    });
    // Original already deleted from disk: nothing to stat, must be skipped.
    insertAsset(database, {
      id: "img-gone",
      originalPath: join(filesDir, "deleted-from-disk.png"),
      businessFields: {},
    });
    insertAsset(database, {
      id: "img-correct",
      originalPath: imagePath,
      businessFields: { file_bytes: 999 },
    });
  });
  clearBackfillMarker(libraryDir);

  const { store, warns } = openStore(t, projectRoot, libraryDir, { captureWarns: true });
  const row = readAssetRow(libraryDir, "img-missing");
  const fields = JSON.parse(row.business_fields_json);
  const staged = await stat(imagePath);
  assert.equal(fields.file_bytes, staged.size);
  // Key-level merge: everything the row carried before stays byte-identical.
  assert.equal(fields.source_note, "manual import");
  assert.equal(row.created_at, CREATED, "created_at untouched so newest-first sorting is stable");
  assert.equal(row.updated_at, CREATED, "updated_at untouched");

  const trashed = JSON.parse(readAssetRow(libraryDir, "img-trashed").business_fields_json);
  assert.equal(trashed.file_bytes, ONE_PIXEL_PNG.length * 2);
  assert.equal(readAssetRow(libraryDir, "img-trashed").deleted_at, "2026-05-02T00:00:00.000Z");

  assert.deepEqual(JSON.parse(readAssetRow(libraryDir, "img-gone").business_fields_json), {});
  assert.deepEqual(JSON.parse(readAssetRow(libraryDir, "img-correct").business_fields_json), { file_bytes: 999 });

  const changes = await store.listLibraryChangesSince("default", 0);
  const announcement = changes.changes.find((change) => change.kind === "library-backfilled"
    && change.detail?.reason === "file-bytes-backfill-v1");
  assert.ok(announcement, "the first open announces the backfill");
  assert.match(
    warns.find((line) => line.includes("file_bytes_backfill_v1")) || "",
    /filled file size on 2 asset\(s\)/,
  );
});

test("runs once: the marker short-circuits later opens", async (t) => {
  const { projectRoot, libraryDir, filesDir } = await createLibraryRoot(t);
  const imagePath = join(filesDir, "once.png");
  await writeFile(imagePath, ONE_PIXEL_PNG);
  withRawDatabase(libraryDir, (database) => {
    insertAsset(database, { id: "img-once", originalPath: imagePath, businessFields: {} });
  });
  clearBackfillMarker(libraryDir);
  openStore(t, projectRoot, libraryDir).store.close();
  assert.equal(JSON.parse(readAssetRow(libraryDir, "img-once").business_fields_json).file_bytes, ONE_PIXEL_PNG.length);

  // Damage a row again after the marker exists: the next open must not
  // "helpfully" repair it — the pass is one-time by design.
  withRawDatabase(libraryDir, (database) => {
    database.prepare("UPDATE assets SET business_fields_json = ? WHERE id = ?").run(JSON.stringify({}), "img-once");
  });

  openStore(t, projectRoot, libraryDir);
  assert.deepEqual(JSON.parse(readAssetRow(libraryDir, "img-once").business_fields_json), {});
});

test("skips missing files silently and rows without an original path", async (t) => {
  const { projectRoot, libraryDir, filesDir } = await createLibraryRoot(t);
  withRawDatabase(libraryDir, (database) => {
    insertAsset(database, {
      id: "img-gone",
      originalPath: join(filesDir, "deleted-from-disk.png"),
      businessFields: {},
    });
    insertAsset(database, {
      id: "img-nopath",
      originalPath: "",
      businessFields: {},
    });
  });
  clearBackfillMarker(libraryDir);

  const { warns } = openStore(t, projectRoot, libraryDir, { captureWarns: true });
  assert.deepEqual(JSON.parse(readAssetRow(libraryDir, "img-gone").business_fields_json), {});
  assert.deepEqual(JSON.parse(readAssetRow(libraryDir, "img-nopath").business_fields_json), {});
  assert.equal(warns.some((line) => line.includes("file_bytes_backfill_v1")), false);
});
