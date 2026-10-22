import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import test, { before } from "node:test";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { runMosaCli } from "./helpers/cli-runner.mjs";

const state = {};

before(async () => {
  state.root = await mkdtemp(join(tmpdir(), "mosa-cli-lifecycle-"));
  deferTestPathRemoval(state.root, { recursive: true, force: true });
  state.env = {
    HOME: join(state.root, "home"),
    MOSA_LIBRARY_DIR: join(state.root, "library"),
    MOSA_PROJECT_DIR: join(state.root, "project"),
  };
  state.library = state.env.MOSA_LIBRARY_DIR;
  state.legacyAssets = await createLegacyAssetsFixture(join(state.root, "project"));
});

async function createLegacyAssetsFixture(projectDir) {
  const legacyAssets = join(projectDir, "legacy-assets");
  const imagesDir = join(legacyAssets, "default", "images");
  const metadataDir = join(legacyAssets, "default", "metadata");
  await mkdir(imagesDir, { recursive: true });
  await mkdir(metadataDir, { recursive: true });
  const pngFor = (background) => sharp({ create: { width: 8, height: 8, channels: 3, background } }).png().toBuffer();
  await writeFile(join(imagesDir, "alpha.png"), await pngFor({ r: 32, g: 64, b: 96 }));
  await writeFile(join(imagesDir, "beta.png"), await pngFor({ r: 96, g: 64, b: 32 }));
  await writeFile(join(metadataDir, "alpha.json"), JSON.stringify({
    id: "alpha",
    project_id: "default",
    asset: "alpha.png",
    prompt: "lifecycle alpha",
    tags: ["lifecycle"],
    source: { type: "codex-generated", path: "/old/alpha.png", model: "test" },
  }));
  await writeFile(join(metadataDir, "beta.json"), JSON.stringify({
    id: "beta",
    project_id: "default",
    asset: "beta.png",
    prompt: "lifecycle beta",
  }));
  await writeFile(join(legacyAssets, "default", "groups.json"), JSON.stringify(["Lifecycle collection"]));
  return legacyAssets;
}

test("migrate --dry-run reports the plan without writing the library directory", () => {
  const result = runMosaCli(["migrate", "--dry-run", "--library", state.library, "--from", state.legacyAssets], { env: state.env });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.discovered, 2);
  assert.equal(report.discoveredGroups, 1);
  assert.equal(report.imported, 0);
  assert.deepEqual(report.issues, []);
  assert.equal(existsSync(state.library), false, "a dry run must not create the library directory");
});

test("migrate imports the legacy library, and --resume skips everything on a second pass", () => {
  const result = runMosaCli(["migrate", "--library", state.library, "--from", state.legacyAssets], { env: state.env });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.completed, true);
  assert.equal(report.imported, 2);
  assert.equal(report.importedGroups, 1);
  assert.equal(report.verified, 2);
  assert.deepEqual(report.issues, []);
  assert.equal(existsSync(join(state.library, ".sqlite-migration-completed")), true);

  const resume = runMosaCli(["migrate", "--resume", "--library", state.library, "--from", state.legacyAssets], { env: state.env });
  assert.equal(resume.status, 0, resume.stderr);
  const resumeReport = JSON.parse(resume.stdout);
  assert.equal(resumeReport.completed, true);
  assert.equal(resumeReport.imported, 0);
  assert.equal(resumeReport.skipped, 2);
  assert.equal(resumeReport.skippedGroups, 1);
});

test("verify passes on the migrated library and fails on an unmigrated one", async () => {
  const result = runMosaCli(["verify", "--library", state.library], { env: state.env });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.migration.migration_state, "completed");
  assert.equal(report.assets, 2);

  const emptyLibrary = join(state.root, "empty-library");
  await mkdir(emptyLibrary, { recursive: true });
  const unmigrated = runMosaCli(["verify", "--library", emptyLibrary], { env: state.env });
  assert.equal(unmigrated.status, 1);
  const unmigratedReport = JSON.parse(unmigrated.stdout);
  assert.equal(unmigratedReport.migration.migration_state, "unmigrated");
});

test("thumbnails rebuild renders preview, medium, and thumbnail derivatives", () => {
  const result = runMosaCli(["thumbnails", "rebuild", "--library", state.library], { env: state.env, timeoutMs: 180000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.queued, 2);
  assert.equal(report.status.completed, 2);
  assert.ok(!report.status.failed);
  for (const assetId of ["alpha", "beta"]) {
    for (const kind of ["previews", "mediums", "thumbnails"]) {
      assert.equal(existsSync(join(state.library, "assets", "default", kind, `${assetId}.webp`)), true, `${kind}/${assetId}.webp must exist`);
    }
  }
});

test("backup, backup-verify, restore, and verify round-trip the library", async () => {
  const backupDir = join(state.root, "backup");
  const backup = runMosaCli(["backup", "--library", state.library, "--to", backupDir], { env: state.env });
  assert.equal(backup.status, 0, backup.stderr);
  const backupReport = JSON.parse(backup.stdout);
  assert.ok(backupReport.files > 0);
  assert.equal(backupReport.verification.ok, true);
  state.backupDir = backupDir;

  const backupVerify = runMosaCli(["backup-verify", "--from", backupDir], { env: state.env });
  assert.equal(backupVerify.status, 0, backupVerify.stderr);
  assert.equal(JSON.parse(backupVerify.stdout).ok, true);

  const restoredDir = join(state.root, "restored");
  const restore = runMosaCli(["restore", "--from", backupDir, "--to", restoredDir], { env: state.env });
  assert.equal(restore.status, 0, restore.stderr);

  const restoredVerify = runMosaCli(["verify", "--library", restoredDir], { env: state.env });
  assert.equal(restoredVerify.status, 0, restoredVerify.stderr);
  const restoredReport = JSON.parse(restoredVerify.stdout);
  assert.equal(restoredReport.ok, true);
  assert.equal(restoredReport.assets, 2);
});

test("backup-verify rejects a backup whose bytes were tampered with", async () => {
  const backupDir = join(state.root, "backup-tampered-bytes");
  assert.equal(runMosaCli(["backup", "--library", state.library, "--to", backupDir], { env: state.env }).status, 0);
  const original = join(backupDir, "assets", "default", "original", "alpha.png");
  const bytes = await readFile(original);
  bytes[0] ^= 0xff;
  await writeFile(original, bytes);

  const result = runMosaCli(["backup-verify", "--from", backupDir], { env: state.env });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.ok(report.failures.length > 0);
});

test("backup-verify rejects a backup with a missing file", async () => {
  const backupDir = join(state.root, "backup-missing-file");
  assert.equal(runMosaCli(["backup", "--library", state.library, "--to", backupDir], { env: state.env }).status, 0);
  await rm(join(backupDir, "assets", "default", "original", "beta.png"));

  const result = runMosaCli(["backup-verify", "--from", backupDir], { env: state.env });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).ok, false);
});

test("restore refuses to write into a non-empty destination", async () => {
  const occupied = join(state.root, "occupied-destination");
  await mkdir(occupied, { recursive: true });
  await writeFile(join(occupied, "sentinel.txt"), "not empty");

  const result = runMosaCli(["restore", "--from", state.backupDir, "--to", occupied], { env: state.env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /destination directory must be empty/);
});

test("restore without --from is rejected", () => {
  const result = runMosaCli(["restore", "--to", join(state.root, "never-created")], { env: state.env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /restore requires --from/);
});

test("thumbnails on a library without a completed migration points at gravityport migrate", async () => {
  const unmigratedLibrary = join(state.root, "unmigrated-library");
  const result = runMosaCli(["thumbnails", "rebuild", "--library", unmigratedLibrary], { env: state.env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Run `gravityport migrate` successfully before rebuilding derivatives/);
});

test("thumbnails repair restores a deleted derivative file", async () => {
  const deleted = join(state.library, "assets", "default", "thumbnails", "beta.webp");
  await rm(deleted);
  const result = runMosaCli(["thumbnails", "repair", "--library", state.library], { env: state.env, timeoutMs: 180000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(deleted), true, "repair must restore the deleted derivative");
});

test("thumbnails repair on a healthy library queues nothing", () => {
  const result = runMosaCli(["thumbnails", "repair", "--library", state.library], { env: state.env, timeoutMs: 180000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, "repair");
  assert.equal(report.queued, 0, "a healthy library has nothing to repair");
  assert.ok(!report.status.pending && !report.status.running && !report.status.failed);
});

test("thumbnails repair re-enqueues only the asset whose medium went missing", async () => {
  const medium = join(state.library, "assets", "default", "mediums", "alpha.webp");
  await rm(medium);

  const result = runMosaCli(["thumbnails", "repair", "--library", state.library], { env: state.env, timeoutMs: 180000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, "repair");
  assert.equal(report.queued, 1, "only alpha is missing a derivative file");
  assert.equal(existsSync(medium), true, "repair must restore the deleted medium");
});

test("thumbnails rebuild regenerates existing derivatives from the original", async () => {
  const thumbnail = join(state.library, "assets", "default", "thumbnails", "alpha.webp");
  const pristine = await readFile(thumbnail);
  await writeFile(thumbnail, Buffer.from("corrupted derivative bytes"));

  const result = runMosaCli(["thumbnails", "rebuild", "--library", state.library], { env: state.env, timeoutMs: 180000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, "rebuild");
  assert.equal(report.queued, 2, "every image asset is re-enqueued even when derivatives already exist");

  const regenerated = await readFile(thumbnail);
  assert.notDeepEqual(regenerated, Buffer.from("corrupted derivative bytes"), "the corrupted thumbnail was replaced");
  assert.deepEqual(regenerated, pristine, "the rebuilt thumbnail matches what the original renders");
});
