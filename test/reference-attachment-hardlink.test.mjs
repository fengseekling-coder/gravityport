import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, stat, unlink, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { createReferenceAttachmentStore } from "../lib/reference-attachment-store.js";
import { ingestWebCapture } from "../lib/web-capture-ingest.js";
import { removeTestPath as rm } from "./test-cleanup.mjs";

async function noiseImage(seed, size = 200) {
  // A real PRNG stream, not an arithmetic pattern: patterned rows compress to
  // ~1 KB and then fail the 20 KiB ingest floor for non-reference captures.
  const raw = Buffer.alloc(size * size * 3);
  let state = (seed * 2654435761) % 4294967296 || 1;
  for (let i = 0; i < raw.length; i += 1) {
    state = (state * 1664525 + 1013904223) % 4294967296;
    raw[i] = (state >>> 24) & 255;
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

function inoOf(fileStat) {
  return `${fileStat.dev}:${fileStat.ino}`;
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function openLibrary() {
  const root = await mkdtemp(join(tmpdir(), "mosa-ref-hardlink-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  await store.ensureProject("default");
  // The store schedules the one-shot hard-link migration on construction; let
  // it settle (an empty reference directory completes immediately) so tests
  // below drive the migration explicitly instead of racing it.
  await waitFor(async () => store.isReferenceHardlinkMigrationDone(), "startup migration flag");
  return { root, libraryDir, store, tempRoot: join(libraryDir, ".web-capture-tmp") };
}

test("reference bytes identical to a library original become a hard link and survive deleting that asset", async () => {
  const { root, libraryDir, store, tempRoot } = await openLibrary();
  try {
    const referenceBytes = await noiseImage(11);
    const generated = await ingestWebCapture({
      store, tempRoot, projectId: "default",
      input: { provider: "chatgpt", imageBytes: referenceBytes, mimeType: "image/png", conversationId: "hardlink-demo", capturedAt: "2026-10-25T10:00:00.000Z" },
    });
    assert.equal(generated.status, "imported");

    const reference = await ingestWebCapture({
      store, tempRoot, projectId: "default",
      input: { provider: "chatgpt", is_reference: true, imageBytes: referenceBytes, mimeType: "image/png", conversationId: "hardlink-demo", capturedAt: "2026-10-25T10:00:30.000Z" },
    });
    assert.equal(reference.status, "imported");

    const originalPath = generated.asset.image_path;
    const referencePath = join(libraryDir, "reference-attachments", "default", "files", reference.attachment.file_name);
    assert.equal(inoOf(await lstat(referencePath)), inoOf(await lstat(originalPath)));
    assert.equal(reference.attachment.storage, "hardlink");

    // Deleting the asset only removes its own directory name; the reference
    // attachment keeps reading the very same bytes through its own link.
    await store.deleteAsset("default", generated.asset.id);
    await store.permanentlyDeleteAsset("default", generated.asset.id);
    assert.ok(!(await lstat(originalPath).then(() => true, () => false)));
    const survivor = await lstat(referencePath);
    assert.ok(survivor.isFile());
    assert.deepEqual(await readFile(referencePath), referenceBytes);
    const linkedAgain = await ingestWebCapture({
      store, tempRoot, projectId: "default",
      input: { provider: "chatgpt", is_reference: true, imageBytes: referenceBytes, mimeType: "image/png", conversationId: "hardlink-demo", capturedAt: "2026-10-25T10:00:45.000Z" },
    });
    assert.equal(linkedAgain.status, "skipped");
    assert.equal(linkedAgain.reason, "reference-already-archived-same-content");
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("pruning removes the reference file only after the last referencing asset is gone", async () => {
  const { root, libraryDir, store, tempRoot } = await openLibrary();
  try {
    const referenceBytes = await noiseImage(21);
    const reference = await ingestWebCapture({
      store, tempRoot, projectId: "default",
      input: { provider: "chatgpt", is_reference: true, imageBytes: referenceBytes, mimeType: "image/png", conversationId: "prune-demo", capturedAt: "2026-10-25T11:00:00.000Z" },
    });
    const derived = await ingestWebCapture({
      store, tempRoot, projectId: "default",
      input: { provider: "chatgpt", imageBytes: await noiseImage(22), mimeType: "image/png", conversationId: "prune-demo", capturedAt: "2026-10-25T11:01:00.000Z" },
    });
    assert.equal(derived.asset.references.length, 1);

    const referenceStore = createReferenceAttachmentStore(libraryDir);
    const referencePath = join(libraryDir, "reference-attachments", "default", "files", reference.attachment.file_name);
    await store.deleteAsset("default", derived.asset.id);
    await store.permanentlyDeleteAsset("default", derived.asset.id);
    // Inside the 24h grace window the file stays.
    const withinGrace = await referenceStore.pruneUnused("default", [], Date.now());
    assert.equal(withinGrace.removed, 0);
    assert.ok((await stat(referencePath)).isFile());
    // Past the grace window the last link is reclaimed.
    const pastGrace = await referenceStore.pruneUnused("default", [], Date.now() + 25 * 60 * 60 * 1000);
    assert.equal(pastGrace.removed, 1);
    assert.ok(!(await lstat(referencePath).then(() => true, () => false)));
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("save links only on byte-identical linkSource; pixel-identical but different bytes stay a copy", async () => {
  const raw = Buffer.alloc(64 * 64 * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 91 + 7) & 255;
  const pngA = await sharp(raw, { raw: { width: 64, height: 64, channels: 3 } }).png({ compressionLevel: 6 }).toBuffer();
  const pngB = await sharp(raw, { raw: { width: 64, height: 64, channels: 3 } }).png({ compressionLevel: 4 }).toBuffer();
  assert.notEqual(pngA.length, pngB.length);

  // Library 1: same pixels, different bytes — must stay a standalone copy.
  const rootA = await mkdtemp(join(tmpdir(), "mosa-ref-hardlink-pixeltwin-"));
  const originalA = join(rootA, "library", "assets", "default", "original", "seed-a.png");
  await mkdir(dirname(originalA), { recursive: true });
  await writeFile(originalA, pngA);
  const storeA = createReferenceAttachmentStore(join(rootA, "library"));
  try {
    const pixelTwin = await storeA.save({
      bytes: pngB, extension: ".png", mimeType: "image/png", width: 64, height: 64,
      provider: "chatgpt", capturedAt: "2026-10-25T12:00:00.000Z", linkSource: originalA,
    });
    const twinPath = join(storeA.root, "default", "files", pixelTwin.attachment.file_name);
    assert.equal(pixelTwin.attachment.storage, "copy");
    assert.deepEqual(await readFile(twinPath), pngB);
    assert.notEqual(inoOf(await lstat(twinPath)), inoOf(await lstat(originalA)));
  } finally {
    await rm(rootA, { recursive: true, force: true });
  }

  // Library 2: byte-identical — becomes a hard link.
  const rootB = await mkdtemp(join(tmpdir(), "mosa-ref-hardlink-twin-"));
  const originalB = join(rootB, "library", "assets", "default", "original", "seed-b.png");
  await mkdir(dirname(originalB), { recursive: true });
  await writeFile(originalB, pngA);
  const storeB = createReferenceAttachmentStore(join(rootB, "library"));
  try {
    const identical = await storeB.save({
      bytes: pngA, extension: ".png", mimeType: "image/png", width: 64, height: 64,
      provider: "chatgpt", capturedAt: "2026-10-25T12:01:00.000Z", linkSource: originalB,
    });
    const identicalPath = join(storeB.root, "default", "files", identical.attachment.file_name);
    assert.equal(identical.attachment.storage, "hardlink");
    assert.deepEqual(await readFile(identicalPath), pngA);
    assert.equal(inoOf(await lstat(identicalPath)), inoOf(await lstat(originalB)));
  } finally {
    await rm(rootB, { recursive: true, force: true });
  }
});

test("an fs.link failure falls back to writing the bytes as a standalone file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-ref-hardlink-exdev-"));
  const libraryDir = join(root, "library");
  const assetsDir = join(libraryDir, "assets", "default", "original");
  await mkdir(assetsDir, { recursive: true });
  const referenceStore = createReferenceAttachmentStore(libraryDir);
  t.mock.method(fsPromises, "link", async () => {
    const error = new Error("cross-device link not permitted (simulated)");
    error.code = "EXDEV";
    throw error;
  });
  try {
    const bytes = await noiseImage(31, 64);
    const originalPath = join(assetsDir, "seed-b.png");
    await writeFile(originalPath, bytes);
    const saved = await referenceStore.save({
      bytes, extension: ".png", mimeType: "image/png", width: 64, height: 64,
      provider: "chatgpt", capturedAt: "2026-10-25T13:00:00.000Z", linkSource: originalPath,
    });
    const savedPath = join(referenceStore.root, "default", "files", saved.attachment.file_name);
    assert.equal(saved.attachment.storage, "copy");
    assert.deepEqual(await readFile(savedPath), bytes);
    assert.notEqual(inoOf(await lstat(savedPath)), inoOf(await lstat(originalPath)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale database hash never links: the original file is re-hashed before linking", async () => {
  const { root, libraryDir, store, tempRoot } = await openLibrary();
  try {
    const recordedBytes = await noiseImage(41);
    const generated = await ingestWebCapture({
      store, tempRoot, projectId: "default",
      input: { provider: "chatgpt", imageBytes: recordedBytes, mimeType: "image/png", conversationId: "stale-demo", capturedAt: "2026-10-25T14:00:00.000Z" },
    });
    // Corrupt the managed original on disk after the database recorded its hash.
    await writeFile(generated.asset.image_path, await noiseImage(42));
    const reference = await ingestWebCapture({
      store, tempRoot, projectId: "default",
      input: { provider: "chatgpt", is_reference: true, imageBytes: recordedBytes, mimeType: "image/png", conversationId: "stale-demo", capturedAt: "2026-10-25T14:01:00.000Z" },
    });
    assert.equal(reference.status, "imported");
    const referencePath = join(libraryDir, "reference-attachments", "default", "files", reference.attachment.file_name);
    assert.equal(reference.attachment.storage, "copy");
    assert.deepEqual(await readFile(referencePath), recordedBytes);
    assert.notEqual(inoOf(await lstat(referencePath)), inoOf(await lstat(generated.asset.image_path)));
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("migration converts existing duplicates, is a no-op on re-run, and leaves failing entries untouched", async (t) => {
  const { root, libraryDir, store, tempRoot } = await openLibrary();
  try {
    const bytesA = await noiseImage(51, 96);
    const bytesB = await noiseImage(52, 96);
    const assetA = await ingestWebCapture({
      store, tempRoot, projectId: "default",
      input: { provider: "chatgpt", imageBytes: bytesA, mimeType: "image/png", conversationId: "migrate-demo", capturedAt: "2026-10-25T15:00:00.000Z" },
    });
    const assetB = await ingestWebCapture({
      store, tempRoot, projectId: "default",
      input: { provider: "chatgpt", imageBytes: bytesB, mimeType: "image/png", conversationId: "migrate-demo", capturedAt: "2026-10-25T15:00:10.000Z" },
    });

    // Two standalone duplicate copies predating hard-link support.
    const filesRoot = join(libraryDir, "reference-attachments", "default", "files");
    await mkdir(filesRoot, { recursive: true });
    const dupA = join(filesRoot, "ref-dup-a.png");
    const dupB = join(filesRoot, "ref-dup-b.png");
    await writeFile(dupA, bytesA);
    await writeFile(dupB, bytesB);
    const independentA = inoOf(await lstat(dupA));
    const independentB = inoOf(await lstat(dupB));

    let done = false;
    const referenceStore = createReferenceAttachmentStore(libraryDir);
    const runMigration = () => referenceStore.migrateToHardLinks({
      findOriginalPath: (projectId, hash) => store.findOriginalByContentHash(projectId, hash),
      isDone: async () => done,
      markDone: async () => { done = true; },
    });

    const first = await runMigration();
    assert.equal(first.alreadyDone, false);
    assert.equal(first.replaced, 2);
    assert.equal(inoOf(await lstat(dupA)), inoOf(await lstat(assetA.asset.image_path)));
    assert.equal(inoOf(await lstat(dupB)), inoOf(await lstat(assetB.asset.image_path)));
    assert.deepEqual(await readFile(dupA), bytesA);
    assert.deepEqual(await readFile(dupB), bytesB);

    // Re-running after a flag loss (interrupted pass) must process nothing.
    done = false;
    const second = await runMigration();
    assert.equal(second.replaced, 0);
    assert.equal(second.alreadyDone, false);

    // A link() failure on one entry leaves it byte-identical and independent
    // while the rest of the pass still succeeds.
    const realLink = fsPromises.link;
    const brokenLink = t.mock.method(fsPromises, "link", async (source, destination) => {
      // The migration links to a temp name (".ref-dup-a.png-<uuid>.tmp").
      if (String(destination).includes("ref-dup-a")) {
        const error = new Error("operation not permitted (simulated)");
        error.code = "EPERM";
        throw error;
      }
      return realLink(source, destination);
    });
    try {
      // Restore both as independent duplicates (unlink first: these names are
      // currently hard links, and overwriting one in place would rewrite the
      // shared inode).
      await unlink(dupA);
      await unlink(dupB);
      await writeFile(dupA, bytesA);
      await writeFile(dupB, bytesB);
      done = false;
      const third = await runMigration();
      assert.equal(third.replaced, 1);
      assert.equal(third.failed, 1);
      assert.equal(inoOf(await lstat(dupB)), inoOf(await lstat(assetB.asset.image_path)));
      assert.deepEqual(await readFile(dupB), bytesB);
      assert.notEqual(inoOf(await lstat(dupA)), inoOf(await lstat(assetA.asset.image_path)));
      assert.deepEqual(await readFile(dupA), bytesA);
      assert.ok(brokenLink.mock.callCount() > 0);
    } finally {
      brokenLink.mock.restore();
    }
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("migration keeps index.json and unrelated reference files untouched", async () => {
  const { root, libraryDir, store, tempRoot } = await openLibrary();
  try {
    const bytes = await noiseImage(61, 96);
    const asset = await ingestWebCapture({
      store, tempRoot, projectId: "default",
      input: { provider: "chatgpt", imageBytes: bytes, mimeType: "image/png", conversationId: "migrate-index", capturedAt: "2026-10-25T16:00:00.000Z" },
    });
    const orphanBytes = await noiseImage(62, 96);
    const reference = await ingestWebCapture({
      store, tempRoot, projectId: "default",
      input: { provider: "chatgpt", is_reference: true, imageBytes: orphanBytes, mimeType: "image/png", conversationId: "migrate-index", capturedAt: "2026-10-25T16:00:20.000Z" },
    });

    const filesRoot = join(libraryDir, "reference-attachments", "default", "files");
    const dup = join(filesRoot, "ref-dup-c.png");
    await writeFile(dup, bytes);
    const indexPath = join(libraryDir, "reference-attachments", "default", "index.json");
    const indexBefore = await readFile(indexPath, "utf8");

    let done = false;
    const result = await createReferenceAttachmentStore(libraryDir).migrateToHardLinks({
      findOriginalPath: (projectId, hash) => store.findOriginalByContentHash(projectId, hash),
      isDone: async () => done,
      markDone: async () => { done = true; },
    });
    assert.equal(result.replaced, 1);
    assert.equal(inoOf(await lstat(dup)), inoOf(await lstat(asset.asset.image_path)));
    assert.equal(await readFile(indexPath, "utf8"), indexBefore);
    // The unmatched attachment keeps its own file.
    const orphanPath = join(filesRoot, reference.attachment.file_name);
    assert.deepEqual(await readFile(orphanPath), orphanBytes);
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
