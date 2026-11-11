import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";
import test from "node:test";
import { createSqliteAssetStore, sqliteDatabasePath } from "../lib/sqlite-asset-store.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

// Task 383: listNavigationStats reports what emptying the trash would free —
// the summed file_bytes of trashed originals whose storage_mode is not
// "hard-link" (a Codex hard-link's bytes stay in Codex's own folder, so
// deleting the library row frees nothing). Originals only; missing or
// non-positive file_bytes counts as 0; the number moves with restore/empty
// through the same navigationStatsCache invalidation as the counts.

async function createLibrary(t) {
  const root = await mkdtemp(join(tmpdir(), "mosa-trash-reclaimable-"));
  const libraryDir = join(root, "library");
  const codexImagesDir = join(root, ".codex", "generated_images");
  await mkdir(join(codexImagesDir, "task-1"), { recursive: true });
  await mkdir(join(root, "generated-images"), { recursive: true });
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({
    projectRoot: root,
    managerDir: join(root, "manager"),
    libraryDir,
    codexImagesDir,
  });
  t.after(() => store.close());
  t.after(() => removeTestPath(root, { recursive: true, force: true }));

  const createPng = async (assetId, fileBytes, { codex = false } = {}) => {
    const imagePath = codex
      ? join(codexImagesDir, "task-1", `${assetId}.png`)
      : join(root, "generated-images", `${assetId}.png`);
    await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 16, g: 32, b: 64 } } })
      .png()
      .toFile(imagePath);
    // file_bytes rides in exactly as a web-capture import would store it;
    // missingFileBytesField only fills the key when the caller left no
    // positive value, so these numbers are what the SQL must sum.
    return await store.createAsset({
      assetId,
      imagePath,
      prompt: `trash reclaimable ${assetId}`,
      business_fields: { file_bytes: fileBytes },
    });
  };

  const copySmall = await createPng("copy-small", 1000);
  const copyLarge = await createPng("copy-large", 2500);
  const codexLinked = await createPng("codex-linked", 9000, { codex: true });
  const liveAsset = await createPng("live-asset", 7000);
  return { libraryDir, store, copySmall, copyLarge, codexLinked, liveAsset };
}

function assertLibraryIntegrity(libraryDir) {
  const database = new Database(sqliteDatabasePath(libraryDir), { readonly: true });
  try {
    assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
  } finally {
    database.close();
  }
}

test("trashReclaimableBytes sums only non-hard-link trashed originals and follows restore and empty", async (t) => {
  const { libraryDir, store, copySmall, copyLarge, codexLinked } = await createLibrary(t);
  assert.equal(codexLinked.source.storage_mode, "hard-link", "the fixture's Codex asset must really be hard-linked");

  await store.deleteAsset("default", copySmall.id);
  await store.deleteAsset("default", copyLarge.id);
  await store.deleteAsset("default", codexLinked.id);

  const trashed = await store.listNavigationStats("default");
  assert.equal(trashed.trash, 3);
  assert.equal(trashed.trashReclaimableBytes, 3500, "1000 + 2500; the 9000 hard-link frees nothing");
  assert.equal(trashed.total, 1, "total counts live assets: three of four are trashed");

  await store.restoreAsset("default", copySmall.id);
  const restored = await store.listNavigationStats("default");
  assert.equal(restored.trash, 2);
  assert.equal(restored.trashReclaimableBytes, 2500, "the restore moves its bytes back out of the sum");

  await store.deleteAsset("default", copySmall.id);
  await store.emptyTrash("default");
  const emptied = await store.listNavigationStats("default");
  assert.equal(emptied.trash, 0);
  assert.equal(emptied.trashReclaimableBytes, 0);
  assertLibraryIntegrity(libraryDir);
});

test("a missing or non-positive file_bytes counts as 0, not as noise", async (t) => {
  const { libraryDir, store } = await createLibrary(t);
  // The import path always fills a usable file_bytes from the file itself
  // (task 257), so the SQL's non-positive branch is reached by writing the
  // rows directly: one with the key removed, one with 0.
  const noKey = await store.createAsset({
    assetId: "no-key",
    imagePath: join(store.projectRoot, "generated-images", "copy-large.png"),
    prompt: "no file_bytes",
  });
  const zero = await store.createAsset({
    assetId: "zero",
    imagePath: join(store.projectRoot, "generated-images", "copy-large.png"),
    prompt: "zero file_bytes",
    business_fields: { file_bytes: 0 },
  });
  const database = new Database(sqliteDatabasePath(libraryDir));
  try {
    database.prepare("UPDATE assets SET business_fields_json = json_remove(business_fields_json, '$.file_bytes') WHERE id = 'no-key'").run();
    database.prepare("UPDATE assets SET business_fields_json = json_set(business_fields_json, '$.file_bytes', 0) WHERE id = 'zero'").run();
  } finally {
    database.close();
  }
  await store.deleteAsset("default", noKey.id);
  await store.deleteAsset("default", zero.id);

  const stats = await store.listNavigationStats("default");
  assert.equal(stats.trashReclaimableBytes, 0, "neither row adds anything");
  assertLibraryIntegrity(libraryDir);
});
