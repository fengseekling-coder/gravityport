import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";

import { createLibraryBackup, restoreLibraryBackup, verifyLibraryBackup } from "../lib/library-backup.js";
import { createReferenceAttachmentStore } from "../lib/reference-attachment-store.js";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

test("library backup restores assets, versions, generation history, Stack structure, and references", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-backup-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const libraryDir = join(root, "library");
  const backupDir = join(root, "backup");
  const restoredDir = join(root, "restored");
  const inputDir = join(projectRoot, "generated-images");
  await mkdir(inputDir, { recursive: true });
  const sourcePath = join(inputDir, "fixture.png");
  await writeFile(sourcePath, ONE_PIXEL_PNG);

  const store = createSqliteAssetStore({ projectRoot, managerDir, libraryDir, initializeFreshLibrary: true });
  t.after(() => store.close?.());
  await store.ensureProject("default");
  const parent = await store.createAsset({ assetId: "parent", imagePath: sourcePath, prompt: "parent prompt" });
  const child = await store.createAssetVersion("default", parent.id, {
    assetId: "child",
    version_change: "warmer lighting",
    prompt: "child prompt",
  });
  const peer = await store.createAsset({ assetId: "peer", imagePath: sourcePath, prompt: "peer prompt" });
  const stack = await store.createAssetStack("default", [parent.id, peer.id], { coverAssetId: peer.id });
  await store.renameAssetStack("default", stack.id, "Launch Pair");
  const generation = await store.recordGenerationEvent({
    project_id: "default",
    output_asset_id: child.id,
    provider: "chatgpt",
    capture_context_id: "backup-test-generation",
    effective_prompt: "child prompt",
    verification_level: "observed",
    generation_status: "completed",
  });

  const references = createReferenceAttachmentStore(libraryDir);
  const reference = await references.save({
    projectId: "default",
    bytes: ONE_PIXEL_PNG,
    extension: ".png",
    mimeType: "image/png",
    width: 1,
    height: 1,
    provider: "chatgpt",
    capturedAt: "2026-09-17T20:00:00.000Z",
    generationContextId: "backup-test-generation",
  });

  const backup = await createLibraryBackup({ projectRoot, managerDir, libraryDir, destinationDir: backupDir });
  assert.equal(backup.verification.ok, true);
  const verified = await verifyLibraryBackup({ backupDir, projectRoot, managerDir });
  assert.equal(verified.ok, true, JSON.stringify(verified.failures));
  assert.ok(verified.files >= 5, "manifest includes database, originals, and reference attachment files");

  const restored = await restoreLibraryBackup({ backupDir, destinationDir: restoredDir, projectRoot, managerDir });
  assert.equal(restored.verification.ok, true);
  const restoredStore = createSqliteAssetStore({ projectRoot, managerDir, libraryDir: restoredDir });
  t.after(() => restoredStore.close?.());
  const restoredAssets = await restoredStore.listAssets({ projectId: "default", sort: "oldest" });
  assert.deepEqual(new Set(restoredAssets.map((asset) => asset.id)), new Set(["parent", "child", "peer"]));
  for (const asset of restoredAssets) {
    assert.ok(resolve(asset.image_path).startsWith(`${resolve(restoredDir)}${sep}`), `restored path must live under restored library: ${asset.image_path}`);
    assert.equal(resolve(asset.image_path).startsWith(`${resolve(libraryDir)}${sep}`), false);
    assert.equal(resolve(asset.image_path).startsWith(`${resolve(backupDir)}${sep}`), false);
  }
  const restoredStack = await restoredStore.getAssetStack("default", stack.id);
  assert.equal(restoredStack.name, "Launch Pair");
  assert.equal(restoredStack.cover_asset_id, peer.id);
  assert.deepEqual((await restoredStore.getAssetVersionHistory("default", child.id)).versions.map((asset) => asset.id), ["parent", "child"]);
  const restoredGenerations = await restoredStore.listGenerationEvents("default", { assetId: child.id });
  assert.equal(restoredGenerations.some((event) => event.id === generation.id), true);

  const restoredReferences = createReferenceAttachmentStore(restoredDir);
  const restoredReferenceList = await restoredReferences.list("default");
  assert.equal(restoredReferenceList.length, 1);
  assert.equal(restoredReferenceList[0].id, reference.attachment.id);
  assert.deepEqual(
    await readFile(join(restoredDir, "reference-attachments", "default", "files", restoredReferenceList[0].file_name)),
    ONE_PIXEL_PNG,
  );
});

test("backup verification rejects tampering and restore refuses a damaged snapshot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-backup-tamper-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const libraryDir = join(root, "library");
  const backupDir = join(root, "backup");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir, libraryDir, initializeFreshLibrary: true });
  t.after(() => store.close?.());
  await store.ensureProject("default");
  await store.createAsset({ assetId: "tamper-me", imagePath: sourcePath });
  await createLibraryBackup({ projectRoot, managerDir, libraryDir, destinationDir: backupDir });

  const manifest = JSON.parse(await readFile(join(backupDir, "backup-manifest.json"), "utf8"));
  const original = manifest.files.find((entry) => entry.path.includes(`${sep}original${sep}`) || entry.path.includes("/original/"));
  assert.ok(original, "manifest exposes a managed original for tamper testing");
  await writeFile(join(backupDir, original.path), Buffer.from("tampered"));
  const verification = await verifyLibraryBackup({ backupDir, projectRoot, managerDir });
  assert.equal(verification.ok, false);
  assert.equal(verification.failures.some((failure) => failure.reason === "file-integrity"), true);
  await assert.rejects(
    restoreLibraryBackup({ backupDir, destinationDir: join(root, "must-not-restore"), projectRoot, managerDir }),
    /Backup verification failed/,
  );
});

test("backup source and destination cannot contain one another", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-backup-path-boundary-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  await assert.rejects(
    createLibraryBackup({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir, destinationDir: join(libraryDir, "backup") }),
    /must not contain one another/,
  );
});

test("backup refuses an unmigrated source library and leaves no artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-backup-unmigrated-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const libraryDir = join(root, "library");
  const backupDir = join(root, "backup");
  // A store opened without initializeFreshLibrary keeps migration_state="unmigrated".
  const store = createSqliteAssetStore({ projectRoot, managerDir, libraryDir });
  store.close();

  await assert.rejects(
    createLibraryBackup({ projectRoot, managerDir, libraryDir, destinationDir: backupDir }),
    /gravityport migrate/,
  );
  const siblings = await readdir(root);
  assert.equal(siblings.includes("backup"), false, "no destination directory is created");
  assert.equal(siblings.some((name) => name.includes(".partial-")), false, "no staging directory is left behind");
});

test("backup through a symlinked library path stays independent of the original library", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-backup-symlink-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const libraryDir = join(root, "library");
  const backupDir = join(root, "backup");
  const restoredDir = join(root, "restored");
  const inputDir = join(projectRoot, "generated-images");
  await mkdir(inputDir, { recursive: true });
  const sourcePath = join(inputDir, "fixture.png");
  await writeFile(sourcePath, ONE_PIXEL_PNG);

  const store = createSqliteAssetStore({ projectRoot, managerDir, libraryDir, initializeFreshLibrary: true });
  await store.ensureProject("default");
  await store.createAsset({ assetId: "one", imagePath: sourcePath, prompt: "one" });
  await store.createAsset({ assetId: "two", imagePath: sourcePath, prompt: "two" });
  store.close();

  const linkPath = join(root, "library-link");
  await symlink(libraryDir, linkPath);

  const backup = await createLibraryBackup({ projectRoot, managerDir, libraryDir: linkPath, destinationDir: backupDir });
  assert.equal(backup.verification.ok, true);

  const backupDatabase = new Database(join(backupDir, "mosa.db"), { readonly: true });
  const rows = backupDatabase.prepare("SELECT original_path, preview_path, medium_path, thumbnail_path FROM assets").all();
  backupDatabase.close();
  assert.equal(rows.length, 2);
  const managedPaths = rows
    .flatMap((row) => [row.original_path, row.preview_path, row.medium_path, row.thumbnail_path])
    .filter(Boolean);
  assert.ok(managedPaths.length >= 2, "the snapshot carries managed paths to check");
  for (const value of managedPaths) {
    assert.equal(resolve(value).startsWith(`${resolve(backupDir)}${sep}`), true, `managed path must live inside the backup: ${value}`);
    assert.equal(resolve(value).startsWith(`${resolve(libraryDir)}${sep}`), false, `managed path must not point at the source library: ${value}`);
  }

  // The snapshot must survive the original library disappearing.
  await rename(libraryDir, join(root, "library-gone"));
  const verified = await verifyLibraryBackup({ backupDir, projectRoot, managerDir });
  assert.equal(verified.ok, true, JSON.stringify(verified.failures));
  const restored = await restoreLibraryBackup({ backupDir, destinationDir: restoredDir, projectRoot, managerDir });
  assert.equal(restored.verification.ok, true);
  const restoredStore = createSqliteAssetStore({ projectRoot, managerDir, libraryDir: restoredDir });
  t.after(() => restoredStore.close?.());
  const restoredAssets = await restoredStore.listAssets({ projectId: "default", sort: "oldest" });
  assert.deepEqual(restoredAssets.map((asset) => asset.id).sort(), ["one", "two"]);
  for (const asset of restoredAssets) {
    assert.deepEqual(await readFile(asset.image_path), ONE_PIXEL_PNG);
  }
});

test("backup verification catches a same-size byte flip and a truncated file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-backup-integrity-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const libraryDir = join(root, "library");
  const backupDir = join(root, "backup");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir, libraryDir, initializeFreshLibrary: true });
  t.after(() => store.close?.());
  await store.ensureProject("default");
  await store.createAsset({ assetId: "integrity", imagePath: sourcePath });

  const backup = await createLibraryBackup({ projectRoot, managerDir, libraryDir, destinationDir: backupDir });
  assert.equal(backup.verification.ok, true);
  const manifest = JSON.parse(await readFile(join(backupDir, "backup-manifest.json"), "utf8"));
  const originalEntry = manifest.files.find((entry) => entry.path.includes(`${sep}original${sep}`) || entry.path.includes("/original/"));
  assert.ok(originalEntry, "manifest exposes a managed original");
  const originalPath = join(backupDir, originalEntry.path);
  const fileIntegrityFailure = (report, needle) => report.failures.some((failure) =>
    failure.path === originalEntry.path
    && failure.reason === "file-integrity"
    && String(failure.detail).includes(needle));

  // One flipped byte with the size unchanged must be rejected by the hash check.
  const bytes = await readFile(originalPath);
  const flipped = Buffer.from(bytes);
  flipped[flipped.length - 1] ^= 0xff;
  await writeFile(originalPath, flipped);
  const flipCheck = await verifyLibraryBackup({ backupDir, projectRoot, managerDir });
  assert.equal(flipCheck.ok, false, JSON.stringify(flipCheck.failures));
  assert.equal(fileIntegrityFailure(flipCheck, "sha256"), true, "the hash check must flag the flipped byte");

  // Restore the bytes, then truncate: the size change must be rejected by the size check.
  await writeFile(originalPath, bytes);
  await writeFile(originalPath, bytes.subarray(0, bytes.length - 1));
  const truncationCheck = await verifyLibraryBackup({ backupDir, projectRoot, managerDir });
  assert.equal(truncationCheck.ok, false, JSON.stringify(truncationCheck.failures));
  assert.equal(fileIntegrityFailure(truncationCheck, "size"), true, "the size check must flag the truncated file");
});

test("backup refuses a reference-attachment store that is actively being written", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-backup-reference-lock-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const libraryDir = join(root, "library");
  const backupDir = join(root, "backup");
  const inputDir = join(projectRoot, "generated-images");
  await mkdir(inputDir, { recursive: true });
  const sourcePath = join(inputDir, "fixture.png");
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir, libraryDir, initializeFreshLibrary: true });
  t.after(() => store.close?.());
  await store.ensureProject("default");
  await store.createAsset({ assetId: "asset", imagePath: sourcePath });

  const referenceProjectDir = join(libraryDir, "reference-attachments", "default");
  await mkdir(referenceProjectDir, { recursive: true });
  await writeFile(join(referenceProjectDir, ".index.lock"), "test-lock\n", "utf8");
  await assert.rejects(
    createLibraryBackup({ projectRoot, managerDir, libraryDir, destinationDir: backupDir }),
    /Reference attachments are being updated/,
  );
  await assert.rejects(readFile(join(backupDir, "backup-manifest.json")), (error) => error?.code === "ENOENT");
});
