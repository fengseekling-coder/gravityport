import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  RELOCATION_MARKER_NAME,
  RELOCATION_MARKER_SETTLE_MS,
  clearStaleRelocationMarker,
  copyLibraryForRelocationGuarded,
  hasRelocationMarker,
  removeRelocationMarker,
  writeRelocationMarker,
} from "../lib/library-relocation.mjs";
import { createSqliteAssetStore, sqliteDatabasePath } from "../lib/sqlite-asset-store.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

async function seedLibrary(root, name, assetId) {
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

test("the relocation marker round-trips and a stale one is cleared at startup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-relocation-marker-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });

  assert.equal(await hasRelocationMarker({ libraryDir }), false);
  assert.equal((await clearStaleRelocationMarker({ libraryDir })).removed, false, "no marker means no cleanup");

  await writeRelocationMarker({ libraryDir, pid: 424242 });
  assert.equal(await hasRelocationMarker({ libraryDir }), true);
  const cleared = await clearStaleRelocationMarker({ libraryDir });
  assert.equal(cleared.removed, true);
  assert.equal(cleared.pid, 424242);
  assert.equal(typeof cleared.startedAt, "string");
  assert.equal(await hasRelocationMarker({ libraryDir }), false);

  // An unparsable marker (crash mid-write) is still removed.
  await writeFile(join(libraryDir, RELOCATION_MARKER_NAME), "garbage", "utf8");
  const unparsable = await clearStaleRelocationMarker({ libraryDir });
  assert.deepEqual(unparsable, { removed: true, startedAt: null, pid: null });

  // The settle window stays inside the reviewed 1–2 s band.
  assert.ok(RELOCATION_MARKER_SETTLE_MS >= 1000 && RELOCATION_MARKER_SETTLE_MS <= 2000,
    `settle window out of band: ${RELOCATION_MARKER_SETTLE_MS}`);
});

test("the guarded copy never carries the marker into the destination", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-relocation-guard-copy-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sourceLibraryDir = await seedLibrary(root, "guard-source", "guarded-copy");
  const destinationLibraryDir = join(root, "guard-destination");
  await writeRelocationMarker({ libraryDir: sourceLibraryDir, pid: process.pid });

  const result = await copyLibraryForRelocationGuarded({
    sourceLibraryDir,
    destinationLibraryDir,
    settleMs: 0,
  });
  assert.equal(result.updatedAssets, 1);
  assert.equal((await readdir(destinationLibraryDir)).includes(RELOCATION_MARKER_NAME), false,
    "the relocation marker is never copied");
  // On success the marker stays in the old library: the MCP keeps refusing it
  // until the caller records the new location and deletes the old directory.
  assert.equal(await hasRelocationMarker({ libraryDir: sourceLibraryDir }), true);
});

test("a refused copy removes the relocation marker and never clears an occupied destination", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-relocation-guard-refused-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sourceLibraryDir = await seedLibrary(root, "refused-source", "refused");
  const occupied = join(root, "occupied");
  await mkdir(occupied, { recursive: true });
  await writeFile(join(occupied, "keep-me.txt"), "user file");
  await writeRelocationMarker({ libraryDir: sourceLibraryDir, pid: process.pid });

  await assert.rejects(
    copyLibraryForRelocationGuarded({ sourceLibraryDir, destinationLibraryDir: occupied, settleMs: 0 }),
    (error) => error?.code === "RELOCATION_TARGET_NOT_EMPTY",
  );
  assert.equal(await hasRelocationMarker({ libraryDir: sourceLibraryDir }), false,
    "a refused move must lift the MCP refusal from the old library");
  assert.deepEqual(await readdir(occupied), ["keep-me.txt"], "the occupied destination is never cleared");
});

test("a source database touched mid-copy aborts the move and keeps the original authoritative", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-relocation-guard-mutation-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sourceLibraryDir = await seedLibrary(root, "mutation-source", "mutated");
  const destinationLibraryDir = join(root, "mutation-destination");
  await writeRelocationMarker({ libraryDir: sourceLibraryDir, pid: process.pid });

  // The write an MCP request could land between the pre-copy fingerprint and
  // the copy finishing; any such change means the copy may be torn.
  const midCopyWrite = async () => {
    const probe = new Database(sqliteDatabasePath(sourceLibraryDir));
    probe.exec("CREATE TABLE relocation_guard_probe (note TEXT)");
    probe.exec("INSERT INTO relocation_guard_probe VALUES ('mid-copy write')");
    probe.close();
  };

  await assert.rejects(
    copyLibraryForRelocationGuarded({
      sourceLibraryDir,
      destinationLibraryDir,
      settleMs: 0,
      onBeforeCopy: midCopyWrite,
    }),
    (error) => error?.code === "RELOCATION_SOURCE_MUTATED",
  );
  assert.equal(await hasRelocationMarker({ libraryDir: sourceLibraryDir }), false,
    "the failed move must lift the MCP refusal");
  assert.deepEqual(await readdir(destinationLibraryDir), [], "the copied-away content is cleared from the destination");

  // The old library stays authoritative and the mid-copy write survives in it.
  const reopened = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir: sourceLibraryDir });
  t.after(() => reopened.close());
  assert.equal((await reopened.getAsset("default", "mutated")).id, "mutated");
  const probe = new Database(sqliteDatabasePath(sourceLibraryDir), { readonly: true });
  assert.equal(probe.prepare("SELECT count(*) AS c FROM relocation_guard_probe").get().c, 1,
    "the mid-copy write is preserved in the original library");
  probe.close();
});

test("a quiet copy passes the fingerprint check", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-relocation-guard-quiet-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sourceLibraryDir = await seedLibrary(root, "quiet-source", "quiet");
  const destinationLibraryDir = join(root, "quiet-destination");
  await writeRelocationMarker({ libraryDir: sourceLibraryDir, pid: process.pid });

  const result = await copyLibraryForRelocationGuarded({
    sourceLibraryDir,
    destinationLibraryDir,
    settleMs: 0,
    onBeforeCopy: () => Promise.resolve(),
  });
  assert.equal(result.checkedAssets, 1);
  const destination = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir: destinationLibraryDir });
  t.after(() => destination.close());
  assert.equal((await destination.getAsset("default", "quiet")).id, "quiet");
});
