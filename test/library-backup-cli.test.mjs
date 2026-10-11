import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";

const root = resolve(import.meta.dirname, "..");

function runCli(args) {
  return spawnSync(process.execPath, ["bin/mosa.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, MOSA_LIBRARY_DIR: "" },
  });
}

test("mosa CLI advertises explicit backup, verification, restore, and visual-model verification commands", () => {
  const result = runCli(["help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /gravityport backup \[--library <path>\] --to <backup-dir>/);
  assert.match(result.stdout, /gravityport backup-verify --from <backup-dir>/);
  assert.match(result.stdout, /gravityport restore --from <backup-dir> --to <empty-library-dir>/);
  assert.match(result.stdout, /gravityport visual-model-verify --from <model-pack-dir>/);
});

test("backup and restore never infer destructive destination paths", () => {
  const backup = runCli(["backup", "--library", "/tmp/does-not-matter"]);
  assert.notEqual(backup.status, 0);
  assert.match(`${backup.stdout}${backup.stderr}`, /backup requires --to/);

  const verify = runCli(["backup-verify"]);
  assert.notEqual(verify.status, 0);
  assert.match(`${verify.stdout}${verify.stderr}`, /backup-verify requires --from/);

  const restore = runCli(["restore", "--from", "/tmp/does-not-matter"]);
  assert.notEqual(restore.status, 0);
  assert.match(`${restore.stdout}${restore.stderr}`, /restore requires --to/);

  const visualModelVerify = runCli(["visual-model-verify"]);
  assert.notEqual(visualModelVerify.status, 0);
  assert.match(`${visualModelVerify.stdout}${visualModelVerify.stderr}`, /visual-model-verify requires --from/);
});

test("mosa backup refuses an unmigrated library and exits non-zero", () => {
  const root = mkdtempSync(join(tmpdir(), "mosa-cli-unmigrated-"));
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  // No initializeFreshLibrary: the database stays migration_state="unmigrated".
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  store.close();

  const backup = runCli(["backup", "--library", libraryDir, "--to", join(root, "bk")]);
  assert.notEqual(backup.status, 0);
  assert.match(`${backup.stdout}${backup.stderr}`, /mosa migrate/);
  assert.equal(existsSync(join(root, "bk")), false, "no backup directory is created");
});

test("verify and thumbnails refuse to materialize a library in an empty or missing directory", () => {
  const root = mkdtempSync(join(tmpdir(), "mosa-cli-nolib-"));

  const missing = join(root, "never-created");
  const verifyMissing = runCli(["verify", "--library", missing]);
  assert.notEqual(verifyMissing.status, 0);
  assert.equal(JSON.parse(verifyMissing.stdout).error.includes("is not a GravityPort SQLite library"), true, verifyMissing.stdout);
  assert.equal(existsSync(missing), false, "a missing library directory is not created");

  const empty = join(root, "empty");
  mkdirSync(empty, { recursive: true });
  const verifyEmpty = runCli(["verify", "--library", empty]);
  assert.notEqual(verifyEmpty.status, 0);
  const emptyReport = JSON.parse(verifyEmpty.stdout);
  assert.equal(emptyReport.ok, false);
  assert.equal(emptyReport.error.includes("is not a GravityPort SQLite library"), true, verifyEmpty.stdout);
  assert.equal(existsSync(join(empty, "mosa.db")), false, "verify must not create mosa.db in an empty directory");

  const legacy = join(root, "legacy");
  mkdirSync(join(legacy, "assets", "legacyproj", "metadata"), { recursive: true });
  writeFileSync(join(legacy, "assets", "legacyproj", "metadata", "img.json"), JSON.stringify({ id: "img", asset: "img.png" }));
  const verifyLegacy = runCli(["verify", "--library", legacy]);
  assert.notEqual(verifyLegacy.status, 0);
  assert.equal(JSON.parse(verifyLegacy.stdout).error.includes("mosa migrate"), true, verifyLegacy.stdout);
  assert.equal(existsSync(join(legacy, "mosa.db")), false, "verify must not create mosa.db in a legacy JSON library");

  const thumbnails = runCli(["thumbnails", "repair", "--library", empty]);
  assert.notEqual(thumbnails.status, 0);
  assert.match(`${thumbnails.stdout}${thumbnails.stderr}`, /is not a GravityPort/);
  assert.equal(existsSync(join(empty, "mosa.db")), false, "thumbnails must not create mosa.db in an empty directory");
});
