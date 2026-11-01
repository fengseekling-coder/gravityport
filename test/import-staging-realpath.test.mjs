import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanupOrphanStagedFiles, removeStagedImport, stageFileForImport } from "../lib/import-staging.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

async function makeTempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(dir, { recursive: true, force: true });
  return dir;
}

function seedPath(root, name) {
  return stageFileForImport({
    sourcePath: join(root, name),
    stagingRoot: join(root, "staging"),
    prefix: "import",
  });
}

test("removeStagedImport refuses a staged path that escapes through an in-root symlinked directory", async (t) => {
  const root = await makeTempDir("mosa-stage-escape-");
  const stagingRoot = join(root, "staging");
  await mkdir(stagingRoot, { recursive: true });
  const external = join(root, "external");
  await mkdir(external, { recursive: true });
  const outsideFile = join(external, "x.png");
  await writeFile(outsideFile, "outside bytes");
  await symlink(external, join(stagingRoot, "link"), "dir");

  const result = await removeStagedImport(stagingRoot, join(stagingRoot, "link", "x.png"));
  assert.deepEqual(result, { ok: false, reason: "outside-staging" });
  assert.equal(await readFile(outsideFile, "utf8"), "outside bytes", "the external file must survive");
});

test("removeStagedImport refuses to run when the staging root itself is a symlink", async (t) => {
  const root = await makeTempDir("mosa-stage-root-link-");
  const realStaging = join(root, "real-staging");
  await mkdir(realStaging, { recursive: true });
  const stagedFile = join(realStaging, "import-1-old.png");
  await writeFile(stagedFile, "old staged bytes");
  const stagingRoot = join(root, "staging");
  await symlink(realStaging, stagingRoot, "dir");

  const removal = await removeStagedImport(stagingRoot, join(stagingRoot, "import-1-old.png"));
  assert.deepEqual(removal, { ok: false, reason: "staging-root-unsafe" });
  const sweep = await cleanupOrphanStagedFiles(stagingRoot, { ttlMs: 0 });
  assert.deepEqual(sweep, { removed: 0, failed: 0, skipped: "staging-root-unsafe" });
  assert.equal(await readFile(stagedFile, "utf8"), "old staged bytes", "the old file behind the link must survive");

  await unlink(stagingRoot);
  // Once the root is a real directory again, the same path deletes normally.
  await mkdir(stagingRoot, { recursive: true });
  const replacement = join(stagingRoot, "import-1-old.png");
  await writeFile(replacement, "staged bytes again");
  const afterRepair = await removeStagedImport(stagingRoot, replacement);
  assert.equal(afterRepair.ok, true);
});

test("removeStagedImport still works when an ANCESTOR of the staging root is a symlink", async (t) => {
  const root = await makeTempDir("mosa-stage-ancestor-");
  const realUserData = join(root, "real-userData");
  const stagingRoot = join(realUserData, "import-staging");
  await mkdir(stagingRoot, { recursive: true });
  const linkRoot = join(root, "link");
  await symlink(realUserData, linkRoot, "dir");

  // Callers stage and delete through ONE literal form (as stageFileForImport
  // returns it), so with the library reached through a link both paths carry
  // the linked ancestor and stay consistent.
  const linkedRoot = join(linkRoot, "import-staging");
  const staged = join(linkedRoot, "import-2.png");
  await writeFile(staged, "staged bytes");

  const result = await removeStagedImport(linkedRoot, staged);
  assert.deepEqual(result, { ok: true }, "deletion through an ancestor symlink is ordinary operation");
});

test("removeStagedImport keeps its existing contract for ordinary targets", async (t) => {
  const root = await makeTempDir("mosa-stage-contract-");
  await writeFile(join(root, "photo.png"), "png bytes");
  await writeFile(join(root, "photo2.png"), "png bytes 2");
  const staged = await seedPath(root, "photo.png");

  const direct = await removeStagedImport(join(root, "staging"), staged);
  assert.deepEqual(direct, { ok: true });

  const stagedLink = await seedPath(root, "photo2.png");
  await unlink(stagedLink);
  await symlink(join(root, "photo2.png"), stagedLink, "file");
  const linkResult = await removeStagedImport(join(root, "staging"), stagedLink);
  assert.deepEqual(linkResult, { ok: false, reason: "not-plain-file" });

  const gone = await removeStagedImport(join(root, "staging"), staged);
  assert.deepEqual(gone, { ok: true, reason: "already-removed" });
});

test("cleanupOrphanStagedFiles still sweeps stale plain files and skips fresh ones", async (t) => {
  const root = await makeTempDir("mosa-stage-sweep-");
  const stagingRoot = join(root, "staging");
  await mkdir(stagingRoot, { recursive: true });
  const stale = join(stagingRoot, "import-stale.png");
  const fresh = join(stagingRoot, "import-fresh.png");
  await writeFile(stale, "stale");
  await writeFile(fresh, "fresh");

  const now = 1_000_000;
  const result = await cleanupOrphanStagedFiles(stagingRoot, { ttlMs: 60_000, now: () => now });
  assert.deepEqual(result, { removed: 0, failed: 0 }, "a fake clock far behind the files' mtime sweeps nothing");

  const later = await cleanupOrphanStagedFiles(stagingRoot, { ttlMs: 0, now: () => Date.now() + 10_000 });
  assert.deepEqual(later, { removed: 2, failed: 0 });
});
