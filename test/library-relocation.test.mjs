import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { copyLibraryForRelocation, finalizeCopiedSqliteLibrary, validateRelocationTarget } from "../lib/library-relocation.mjs";
import { createSqliteAssetStore, sqliteDatabasePath } from "../lib/sqlite-asset-store.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

test("library relocation rebases managed SQLite paths before the old library is removed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-library-relocation-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sourceLibraryDir = join(root, "source-library");
  const destinationLibraryDir = join(root, "destination-library");
  const importSource = join(root, "incoming.png");
  await writeFile(importSource, ONE_PIXEL_PNG);

  const sourceStore = createSqliteAssetStore({
    projectRoot: root,
    managerDir: root,
    libraryDir: sourceLibraryDir,
    initializeFreshLibrary: true,
  });
  const created = await sourceStore.createAsset({
    projectId: "default",
    assetId: "relocated",
    imagePath: importSource,
    prompt: "relocation fixture",
    source: { type: "local-file", source_path: importSource },
  });
  const oldOriginal = created.image_path;
  sourceStore.close();

  await cp(sourceLibraryDir, destinationLibraryDir, { recursive: true });
  const finalized = await finalizeCopiedSqliteLibrary({ sourceLibraryDir, destinationLibraryDir });
  assert.equal(finalized.checkedAssets, 1);
  assert.equal(finalized.updatedAssets, 1);

  const copiedDb = new Database(sqliteDatabasePath(destinationLibraryDir), { readonly: true });
  const copiedRow = copiedDb.prepare("SELECT original_path, source_path FROM assets WHERE project_id = 'default' AND id = 'relocated'").get();
  copiedDb.close();
  assert.equal(copiedRow.original_path.startsWith(resolve(destinationLibraryDir)), true);
  assert.equal(copiedRow.source_path, importSource, "external provenance paths must not be rebased");
  assert.equal(copiedRow.original_path.startsWith(resolve(sourceLibraryDir)), false);
  assert.equal((await readFile(copiedRow.original_path)).equals(ONE_PIXEL_PNG), true);

  await rm(sourceLibraryDir, { recursive: true, force: true });
  await assert.rejects(stat(oldOriginal), /ENOENT/);
  const relocatedStore = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir: destinationLibraryDir });
  t.after(() => relocatedStore.close());
  const relocated = await relocatedStore.getAsset("default", "relocated");
  assert.equal(relocated.image_path, copiedRow.original_path);
  assert.equal((await relocatedStore.verifyLibrary()).ok, true);

  const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await utimes(relocated.image_path, staleTime, staleTime);
  const cleanup = await relocatedStore.cleanupOrphanedManagedFiles({ olderThanMs: 24 * 60 * 60 * 1000 });
  assert.equal(cleanup.removed, 0, "the authoritative relocated original remains referenced");
  assert.equal((await stat(relocated.image_path)).isFile(), true);
});

test("managed-file cleanup fails closed when database paths do not belong to the active library", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-library-path-guard-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  const importSource = join(root, "incoming.png");
  await mkdir(libraryDir, { recursive: true });
  await writeFile(importSource, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir, initializeFreshLibrary: true });
  const created = await store.createAsset({ projectId: "default", assetId: "guarded", imagePath: importSource });
  store.close();

  const database = new Database(sqliteDatabasePath(libraryDir));
  database.prepare("UPDATE assets SET original_path = ? WHERE project_id = 'default' AND id = 'guarded'")
    .run(join(root, "stale-library", "assets", "default", "original", "guarded.png"));
  database.close();

  const guardedStore = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  t.after(() => guardedStore.close());
  const orphan = join(guardedStore.imagesDir("default"), "old-orphan.png");
  await writeFile(orphan, "orphan");
  const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await Promise.all([utimes(created.image_path, staleTime, staleTime), utimes(orphan, staleTime, staleTime)]);

  const cleanup = await guardedStore.cleanupOrphanedManagedFiles({ olderThanMs: 24 * 60 * 60 * 1000 });
  assert.deepEqual(cleanup, { removed: 0, failed: 0, skipped: true, reason: "managed-path-integrity" });
  assert.equal((await stat(orphan)).isFile(), true, "cleanup must delete nothing while managed path integrity is broken");
  assert.equal((await stat(created.image_path)).isFile(), true);
});

// ===== Relocation helper contract shared by desktop/main.mjs and e2e =====

async function seedRelocatableLibrary(root, name, assetId) {
  const libraryDir = join(root, name);
  const importSource = join(root, `${name}-incoming.png`);
  await writeFile(importSource, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({
    projectRoot: root,
    managerDir: root,
    libraryDir,
    initializeFreshLibrary: true,
  });
  await store.createAsset({ projectId: "default", assetId, imagePath: importSource });
  store.close();
  return libraryDir;
}

test("validateRelocationTarget mirrors the desktop handler's accept/reject reasons", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-relocation-validate-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sourceLibraryDir = await seedRelocatableLibrary(root, "validate-source", "validated");
  const sameCheck = await validateRelocationTarget({ currentLibraryDir: sourceLibraryDir, nextLibraryDir: sourceLibraryDir });
  assert.deepEqual(sameCheck, { ok: false, reason: "cancelled" });
  // A spelling variant that resolves to the same directory must also read as "no change".
  assert.deepEqual(
    await validateRelocationTarget({ currentLibraryDir: sourceLibraryDir, nextLibraryDir: join(sourceLibraryDir, "sub", "..") }),
    { ok: false, reason: "cancelled" },
  );

  const nestedInsideSource = await validateRelocationTarget({
    currentLibraryDir: sourceLibraryDir,
    nextLibraryDir: join(sourceLibraryDir, "nested-target"),
  });
  assert.deepEqual(nestedInsideSource, { ok: false, reason: "invalid" });
  const sourceInsideTarget = await validateRelocationTarget({ currentLibraryDir: sourceLibraryDir, nextLibraryDir: root });
  assert.deepEqual(sourceInsideTarget, { ok: false, reason: "invalid" });

  const occupiedDir = join(root, "occupied-target");
  await mkdir(occupiedDir, { recursive: true });
  await writeFile(join(occupiedDir, "marker.txt"), "occupied");
  const occupied = await validateRelocationTarget({ currentLibraryDir: sourceLibraryDir, nextLibraryDir: occupiedDir });
  assert.deepEqual(occupied, { ok: false, reason: "not-empty" });
  assert.deepEqual(await readdir(occupiedDir), ["marker.txt"], "validation must not modify an occupied target");

  const freshTarget = join(root, "fresh-target");
  assert.deepEqual(
    await validateRelocationTarget({ currentLibraryDir: sourceLibraryDir, nextLibraryDir: freshTarget }),
    { ok: true },
  );
  assert.equal((await stat(freshTarget)).isDirectory(), true, "a missing target is created so the copy can proceed");
});

test("copyLibraryForRelocation skips the runtime lock and rebases managed paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-relocation-copy-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sourceLibraryDir = await seedRelocatableLibrary(root, "copy-source", "copied");
  // A leftover lock from an unclean shutdown must never reach the new location,
  // and neither may the relocation marker the App writes before copying.
  await writeFile(join(sourceLibraryDir, ".mosa-runtime.lock"), "stale");
  await writeFile(join(sourceLibraryDir, ".gravityport-relocating"), "{\"startedAt\":\"now\"}");
  const destinationLibraryDir = join(root, "copy-destination");
  await mkdir(destinationLibraryDir, { recursive: true });

  const result = await copyLibraryForRelocation({ sourceLibraryDir, destinationLibraryDir });
  assert.equal(result.checkedAssets, 1);
  assert.equal(result.updatedAssets, 1);

  const copiedEntries = await readdir(destinationLibraryDir);
  assert.equal(copiedEntries.includes(".mosa-runtime.lock"), false, "the runtime lock is never copied");
  assert.equal(copiedEntries.includes(".gravityport-relocating"), false, "the relocation marker is never copied");
  const copiedDatabase = new Database(sqliteDatabasePath(destinationLibraryDir), { readonly: true });
  const copiedRow = copiedDatabase.prepare("SELECT original_path FROM assets WHERE project_id = 'default' AND id = 'copied'").get();
  copiedDatabase.close();
  assert.equal(copiedRow.original_path.startsWith(resolve(destinationLibraryDir)), true);
  assert.equal((await readFile(copiedRow.original_path)).equals(ONE_PIXEL_PNG), true);

  // Unlike the handler flow, a copy into a target that does not exist yet
  // simply creates it and completes.
  const createdTarget = join(root, "created-by-copy");
  assert.equal((await copyLibraryForRelocation({ sourceLibraryDir, destinationLibraryDir: createdTarget })).updatedAssets, 1);
  assert.equal((await stat(createdTarget)).isDirectory(), true);
  assert.equal((await readdir(createdTarget)).includes("mosa.db"), true);
});

test("copyLibraryForRelocation fails closed and leaves the destination empty", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-relocation-rollback-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sourceLibraryDir = await seedRelocatableLibrary(root, "rollback-source", "guarded");
  const entriesBefore = (await readdir(sourceLibraryDir)).sort();
  const reopened = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir: sourceLibraryDir });
  t.after(() => reopened.close());
  // The reopened reader lazily creates SQLite sidecar files; they are not
  // library payload, so the untouched checks ignore them.
  const payloadEntries = (entries) => entries.filter((name) => name !== "mosa.db-shm" && name !== "mosa.db-wal");
  let expectedSourceEntries = payloadEntries(entriesBefore).sort();
  const assertSourceDataIntact = async () => {
    const asset = await reopened.getAsset("default", "guarded");
    assert.equal((await readFile(asset.image_path)).equals(ONE_PIXEL_PNG), true);
  };
  const assertSourceUntouched = async () => {
    assert.deepEqual(payloadEntries(await readdir(sourceLibraryDir)).sort(), expectedSourceEntries, "a failed copy must not modify the source");
    await assertSourceDataIntact();
  };

  // Same directory would copy the library onto itself; the guard rejects it
  // before any byte is touched.
  await assert.rejects(copyLibraryForRelocation({ sourceLibraryDir, destinationLibraryDir: sourceLibraryDir }));
  await assertSourceUntouched();

  // Overlapping and occupied destinations are refused before anything is
  // written or removed: the failure cleanup deletes the destination, so it may
  // only ever run on an empty, independent directory.
  const nestedTarget = join(sourceLibraryDir, "nested");
  await assert.rejects(copyLibraryForRelocation({ sourceLibraryDir, destinationLibraryDir: nestedTarget }),
    (error) => error?.code === "RELOCATION_TARGET_OVERLAPS");
  await assert.rejects(stat(nestedTarget), (error) => error?.code === "ENOENT", "no stray directory is created inside the source");
  await assertSourceUntouched();

  // A destination that contains the library (for example its parent folder)
  // would otherwise be wiped together with the library on failure.
  await assert.rejects(copyLibraryForRelocation({ sourceLibraryDir, destinationLibraryDir: root }),
    (error) => error?.code === "RELOCATION_TARGET_OVERLAPS");
  await assertSourceUntouched();

  const occupiedTarget = join(root, "occupied");
  await mkdir(occupiedTarget, { recursive: true });
  await writeFile(join(occupiedTarget, "keep-me.txt"), "user file");
  await assert.rejects(copyLibraryForRelocation({ sourceLibraryDir, destinationLibraryDir: occupiedTarget }),
    (error) => error?.code === "RELOCATION_TARGET_NOT_EMPTY");
  assert.deepEqual(await readdir(occupiedTarget), ["keep-me.txt"], "an occupied destination is never cleared");
  await assertSourceUntouched();

  // Case-insensitive volumes (the macOS and Windows defaults) resolve a
  // differently cased path to the same directory; identity catches it.
  const caseVariant = sourceLibraryDir.replace(/rollback-source$/, "ROLLBACK-SOURCE");
  const caseInsensitive = await stat(caseVariant).then(() => true, () => false);
  if (caseInsensitive) {
    await assert.rejects(copyLibraryForRelocation({ sourceLibraryDir, destinationLibraryDir: caseVariant }),
      (error) => error?.code === "RELOCATION_TARGET_OVERLAPS");
    assert.deepEqual(await validateRelocationTarget({ currentLibraryDir: sourceLibraryDir, nextLibraryDir: caseVariant }),
      { ok: false, reason: "cancelled" });
    await assertSourceUntouched();
  }
});

test("copyLibraryForRelocation clears the copied files when finalizing fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-relocation-partial-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  // Every entry copies fine, then the database integrity check in
  // finalizeCopiedSqliteLibrary rejects the copy.
  const sourceLibraryDir = join(root, "corrupt-source");
  await mkdir(join(sourceLibraryDir, "default", "original"), { recursive: true });
  await writeFile(sqliteDatabasePath(sourceLibraryDir), "not a database");
  await writeFile(join(sourceLibraryDir, "default", "original", "payload.bin"), "source bytes");
  const entriesBefore = (await readdir(sourceLibraryDir)).sort();
  const destinationLibraryDir = join(root, "partial-destination");
  await mkdir(destinationLibraryDir, { recursive: true });

  await assert.rejects(copyLibraryForRelocation({ sourceLibraryDir, destinationLibraryDir }));
  assert.deepEqual(await readdir(destinationLibraryDir), [], "the copied files are cleared back to an empty directory");
  assert.deepEqual((await readdir(sourceLibraryDir)).sort(), entriesBefore);
  assert.equal(await readFile(join(sourceLibraryDir, "default", "original", "payload.bin"), "utf8"), "source bytes",
    "the source payload is untouched");
});

// ===== Real-location matching: symlinked and differently cased source paths =====

test("finalizeCopiedSqliteLibrary rebases managed paths when the source is addressed through a symlink", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-relocation-symlink-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sourceLibraryDir = await seedRelocatableLibrary(root, "link-source", "linked");
  const sourceLink = join(root, "link-source-alias");
  await symlink(sourceLibraryDir, sourceLink);
  const destinationLibraryDir = join(root, "destination-library");
  await cp(sourceLibraryDir, destinationLibraryDir, { recursive: true });

  const finalized = await finalizeCopiedSqliteLibrary({ sourceLibraryDir: sourceLink, destinationLibraryDir });
  assert.equal(finalized.checkedAssets, 1);
  assert.equal(finalized.updatedAssets, 1, "the managed path is rebased even when the source is reached through a symlink");

  const copiedDatabase = new Database(sqliteDatabasePath(destinationLibraryDir), { readonly: true });
  const copiedRow = copiedDatabase.prepare("SELECT original_path FROM assets WHERE project_id = 'default' AND id = 'linked'").get();
  copiedDatabase.close();
  assert.equal(copiedRow.original_path.startsWith(resolve(destinationLibraryDir)), true);
  assert.equal((await readFile(copiedRow.original_path)).equals(ONE_PIXEL_PNG), true);

  // The relocated copy must survive the original library disappearing.
  await rename(sourceLibraryDir, join(root, "link-source-gone"));
  const relocatedStore = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir: destinationLibraryDir });
  t.after(() => relocatedStore.close());
  const relocated = await relocatedStore.getAsset("default", "linked");
  assert.equal((await readFile(relocated.image_path)).equals(ONE_PIXEL_PNG), true);
  assert.equal((await relocatedStore.verifyLibrary()).ok, true);
});

test("finalizeCopiedSqliteLibrary matches a differently cased spelling of the source library", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-relocation-case-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sourceLibraryDir = await seedRelocatableLibrary(root, "case-source", "cased");
  const caseVariant = sourceLibraryDir.replace(/case-source$/, "CASE-SOURCE");
  const resolvable = await stat(caseVariant).then(() => true, () => false);
  if (!resolvable) {
    t.skip("volume is case-sensitive; case-insensitive aliasing does not apply here");
  } else {
    const destinationLibraryDir = join(root, "destination-library");
    await cp(sourceLibraryDir, destinationLibraryDir, { recursive: true });
    const finalized = await finalizeCopiedSqliteLibrary({ sourceLibraryDir: caseVariant, destinationLibraryDir });
    assert.equal(finalized.checkedAssets, 1);
    assert.equal(finalized.updatedAssets, 1, "the managed path is rebased for a case-insensitive alias of the source");

    const copiedDatabase = new Database(sqliteDatabasePath(destinationLibraryDir), { readonly: true });
    const copiedRow = copiedDatabase.prepare("SELECT original_path FROM assets WHERE project_id = 'default' AND id = 'cased'").get();
    copiedDatabase.close();
    assert.equal(copiedRow.original_path.startsWith(resolve(destinationLibraryDir)), true);
    assert.equal((await readFile(copiedRow.original_path)).equals(ONE_PIXEL_PNG), true);
  }
});

test("copyLibraryForRelocation rebases managed paths when the source is a symlinked path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-relocation-copy-link-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sourceLibraryDir = await seedRelocatableLibrary(root, "copy-link-source", "copy-linked");
  const sourceLink = join(root, "copy-link-alias");
  await symlink(sourceLibraryDir, sourceLink);
  const destinationLibraryDir = join(root, "copy-link-destination");

  const result = await copyLibraryForRelocation({ sourceLibraryDir: sourceLink, destinationLibraryDir });
  assert.equal(result.checkedAssets, 1);
  assert.equal(result.updatedAssets, 1);

  const copiedDatabase = new Database(sqliteDatabasePath(destinationLibraryDir), { readonly: true });
  const copiedRow = copiedDatabase.prepare("SELECT original_path FROM assets WHERE project_id = 'default' AND id = 'copy-linked'").get();
  copiedDatabase.close();
  assert.equal(copiedRow.original_path.startsWith(resolve(destinationLibraryDir)), true);
  assert.equal((await readFile(copiedRow.original_path)).equals(ONE_PIXEL_PNG), true);
});
