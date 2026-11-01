import assert from "node:assert/strict";
import { cp, lstat, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { copyLibraryForRelocation } from "../lib/library-relocation.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import {
  ensureLibraryId,
  libraryDigest,
  LIBRARY_ID_FILE_NAME,
  readLibraryId,
} from "../lib/library-identity.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

async function makeLibrary(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  return { root, libraryDir };
}

test("the library id is created once, atomically, and stable", async (t) => {
  const { libraryDir } = await makeLibrary(t, "mosa-library-id-");
  const first = await ensureLibraryId(libraryDir);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);

  // Idempotent: an existing well-formed id is never rewritten.
  const second = await ensureLibraryId(libraryDir);
  assert.equal(second, first);
  assert.equal(await readLibraryId(libraryDir), first);

  // Written 0600 through the temp-file + rename path.
  const info = await lstat(join(libraryDir, LIBRARY_ID_FILE_NAME));
  assert.equal(info.mode & 0o777, 0o600, "the id file must not be group/world readable");

  // A malformed file is treated as missing and replaced, not echoed.
  await writeFile(join(libraryDir, LIBRARY_ID_FILE_NAME), "garbage\n", "utf8");
  const repaired = await ensureLibraryId(libraryDir);
  assert.match(repaired, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(repaired, first);

  // Read-only lookups answer "" for missing or malformed files.
  const { libraryDir: emptyDir } = await makeLibrary(t, "mosa-library-id-empty-");
  assert.equal(await readLibraryId(emptyDir), "");
  assert.equal(await readLibraryId(join(emptyDir, "does-not-exist")), "");
});

test("the digest separates copies, unifies aliases, and hides the path", async (t) => {
  const { root, libraryDir } = await makeLibrary(t, "mosa-library-digest-");
  const libraryId = await ensureLibraryId(libraryDir);
  const digest = libraryDigest(libraryId, libraryDir);
  assert.match(digest, /^[A-Za-z0-9_-]+$/);
  assert.ok(!digest.includes(resolve(libraryDir)), "the digest must not embed the path");

  // Deterministic for the same id + path.
  assert.equal(libraryDigest(libraryId, libraryDir), digest);

  // A symlinked alias of the same library digests the same (realpath).
  const alias = join(root, "library-alias");
  await symlink(libraryDir, alias);
  assert.equal(libraryDigest(libraryId, alias), digest);

  // A COPY keeps the id file but lands on another path: different digest.
  const copy = join(root, "library-copy");
  await cp(libraryDir, copy, { recursive: true });
  assert.equal(await readLibraryId(copy), libraryId, "the copy carries the same id file");
  assert.notEqual(libraryDigest(await readLibraryId(copy), copy), digest, "the copy must digest differently");

  // Without the id the digest is empty — never a fallback that could match.
  assert.equal(libraryDigest("", libraryDir), "");
  assert.equal(libraryDigest(libraryId, ""), "");
});

test("relocation carries the id; the digest follows the new path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-library-reloc-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  const libraryId = await ensureLibraryId(libraryDir);

  // A real SQLite library: the relocation copy finalizer reads mosa.db.
  const importSource = join(root, "incoming.png");
  await writeFile(importSource, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({
    projectRoot: root,
    managerDir: root,
    libraryDir,
    initializeFreshLibrary: true,
  });
  await store.createAsset({ projectId: "default", assetId: "reloc-fixture", imagePath: importSource, prompt: "identity fixture" });
  store.close();

  const destination = join(root, "moved-library");
  await copyLibraryForRelocation({ sourceLibraryDir: libraryDir, destinationLibraryDir: destination });

  assert.equal(await readLibraryId(destination), libraryId, "the id file travels with the relocated library");
  const relocatedDigest = libraryDigest(libraryId, destination);
  assert.match(relocatedDigest, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(relocatedDigest, libraryDigest(libraryId, libraryDir), "the new path digests differently");

  // A runtime opened on the destination would report exactly this digest:
  // ensure() on the relocated library keeps the carried id.
  assert.equal(await ensureLibraryId(destination), libraryId);
  assert.equal(libraryDigest(await ensureLibraryId(destination), destination), relocatedDigest);
});
