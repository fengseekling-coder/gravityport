import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import sharp from "sharp";
import { syncDirectory, syncFile } from "../lib/durable-file.js";
import { createReferenceAttachmentStore } from "../lib/reference-attachment-store.js";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

async function makePngBuffer(seed, size = 64) {
  const raw = Buffer.alloc(size * size * 3);
  let state = ((seed + 1) * 2654435761) >>> 0;
  for (let i = 0; i < raw.length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    raw[i] = state >>> 24;
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

async function getFileHandlePrototype(dir) {
  const probe = join(dir, `.sync-probe-${randomUUID()}`);
  await writeFile(probe, "probe");
  const handle = await open(probe, "r");
  try {
    return Object.getPrototypeOf(handle);
  } finally {
    await handle.close();
    await unlink(probe).catch(() => {});
  }
}

async function openTestLibrary() {
  const root = await mkdtemp(join(tmpdir(), "mosa-durable-450-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const libraryDir = join(root, "library");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot, managerDir, libraryDir });
  await store.ensureProject("default");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (store.isReferenceHardlinkMigrationDone()) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { root, projectRoot, managerDir, libraryDir, store };
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

test("syncFile and syncDirectory handle default platform and Windows branches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mosa-durable-unit-"));
  deferTestPathRemoval(dir, { recursive: true, force: true });
  const filePath = join(dir, "sample.bin");
  await writeFile(filePath, Buffer.from("durable-payload"));

  assert.equal(await syncFile(filePath), true);
  assert.equal(await syncDirectory(dir), true);
  assert.equal(await syncDirectory(dir, { platform: "win32" }), false);

  await chmod(filePath, 0o444);
  try {
    assert.equal(await syncFile(filePath, { platform: "win32" }), false);
    assert.equal(await syncFile(filePath), true);
  } finally {
    await chmod(filePath, 0o644).catch(() => {});
  }

  await assert.rejects(
    () => syncFile(join(dir, "does-not-exist.bin")),
    (error) => error?.code === "ENOENT",
  );
  await assert.rejects(
    () => syncFile(join(dir, "does-not-exist.bin"), { platform: "win32" }),
    (error) => error?.code === "ENOENT",
  );
});

test("createAsset syncs file and parent directory before writing the SQLite row", async (t) => {
  const { root, projectRoot, libraryDir, store } = await openTestLibrary();
  const srcPath = join(projectRoot, "create-source.png");
  await writeFile(srcPath, await makePngBuffer(101));
  const assetId = "durable-create-asset-1";

  const fileHandleProto = await getFileHandlePrototype(root);
  const originalSync = fileHandleProto.sync;
  const reader = new Database(join(libraryDir, "mosa.db"), { readonly: true });
  let syncCalls = 0;
  const rowsObservedDuringSync = [];
  const syncMock = t.mock.method(fileHandleProto, "sync", async function (...args) {
    syncCalls += 1;
    const row = reader.prepare("SELECT id FROM assets WHERE project_id = ? AND id = ?").get("default", assetId);
    rowsObservedDuringSync.push(row ?? null);
    return originalSync.apply(this, args);
  });

  try {
    await store.createAsset({ imagePath: srcPath, assetId });
    assert.ok(syncCalls >= 2, `expected at least 2 FileHandle.sync calls during createAsset, got ${syncCalls}`);
    assert.equal(rowsObservedDuringSync.length, syncCalls);
    for (let i = 0; i < rowsObservedDuringSync.length; i += 1) {
      assert.equal(
        rowsObservedDuringSync[i],
        null,
        `expected assets row ${assetId} not to exist yet on sync call #${i + 1}`,
      );
    }
    const rowAfter = reader.prepare("SELECT id FROM assets WHERE project_id = ? AND id = ?").get("default", assetId);
    assert.equal(rowAfter?.id, assetId);
  } finally {
    syncMock.mock.restore();
    reader.close();
    store.close();
  }
});

test("replaceAssetMedia syncs replacement file and parent directory before updating original_path", async (t) => {
  const { root, projectRoot, libraryDir, store } = await openTestLibrary();
  const initialSrc = join(projectRoot, "replace-initial.png");
  const nextSrc = join(projectRoot, "replace-next.png");
  await writeFile(initialSrc, await makePngBuffer(201));
  await writeFile(nextSrc, await makePngBuffer(202));
  const assetId = "durable-replace-asset-1";

  const created = await store.createAsset({ imagePath: initialSrc, assetId });
  const oldOriginalPath = created.image_path;

  const fileHandleProto = await getFileHandlePrototype(root);
  const originalSync = fileHandleProto.sync;
  const reader = new Database(join(libraryDir, "mosa.db"), { readonly: true });
  let syncCalls = 0;
  const pathsObservedDuringSync = [];
  const syncMock = t.mock.method(fileHandleProto, "sync", async function (...args) {
    syncCalls += 1;
    const row = reader.prepare("SELECT original_path FROM assets WHERE project_id = ? AND id = ?").get("default", assetId);
    pathsObservedDuringSync.push(row?.original_path ?? null);
    return originalSync.apply(this, args);
  });

  try {
    const replaced = await store.replaceAssetMedia("default", assetId, { imagePath: nextSrc });
    assert.ok(syncCalls >= 2, `expected at least 2 FileHandle.sync calls during replaceAssetMedia, got ${syncCalls}`);
    assert.equal(pathsObservedDuringSync.length, syncCalls);
    for (let i = 0; i < pathsObservedDuringSync.length; i += 1) {
      assert.equal(
        pathsObservedDuringSync[i],
        oldOriginalPath,
        `expected original_path to remain old path on sync call #${i + 1}`,
      );
    }
    const rowAfter = reader.prepare("SELECT original_path FROM assets WHERE project_id = ? AND id = ?").get("default", assetId);
    assert.equal(rowAfter?.original_path, replaced.image_path);
    assert.notEqual(rowAfter?.original_path, oldOriginalPath);
  } finally {
    syncMock.mock.restore();
    reader.close();
    store.close();
  }
});

test("reference attachment save syncs file, directory, and index before exposing the id in index.json", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-durable-ref-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const referenceStore = createReferenceAttachmentStore(libraryDir);

  const seedBytes = await makePngBuffer(301);
  await referenceStore.save({
    projectId: "default",
    bytes: seedBytes,
    extension: ".png",
    mimeType: "image/png",
    width: 64,
    height: 64,
    provider: "chatgpt",
    capturedAt: "2026-11-20T05:00:00.000Z",
  });

  const newBytes = await makePngBuffer(302);
  const expectedNewId = `ref-${sha256Hex(newBytes).slice(0, 24)}`;
  const indexPath = join(libraryDir, "reference-attachments", "default", "index.json");

  const fileHandleProto = await getFileHandlePrototype(root);
  const originalSync = fileHandleProto.sync;
  let syncCalls = 0;
  let firstSyncIndexIds = null;
  const syncMock = t.mock.method(fileHandleProto, "sync", async function (...args) {
    syncCalls += 1;
    if (syncCalls === 1) {
      const parsed = JSON.parse(readFileSync(indexPath, "utf8"));
      firstSyncIndexIds = parsed.map((entry) => entry.id);
    }
    return originalSync.apply(this, args);
  });

  try {
    const saved = await referenceStore.save({
      projectId: "default",
      bytes: newBytes,
      extension: ".png",
      mimeType: "image/png",
      width: 64,
      height: 64,
      provider: "chatgpt",
      capturedAt: "2026-11-20T05:01:00.000Z",
    });
    assert.equal(saved.created, true);
    assert.equal(saved.attachment.id, expectedNewId);
    assert.ok(syncCalls >= 4, `expected at least 4 FileHandle.sync calls when saving a new reference, got ${syncCalls}`);
    assert.ok(Array.isArray(firstSyncIndexIds), "expected index.json to be inspected on first sync call");
    assert.ok(!firstSyncIndexIds.includes(expectedNewId), `expected index.json not to contain ${expectedNewId} on first sync call`);

    const finalIndex = JSON.parse(await readFile(indexPath, "utf8"));
    assert.ok(finalIndex.some((entry) => entry.id === expectedNewId));
  } finally {
    syncMock.mock.restore();
  }
});

test("createAsset cleans up managed file and skips DB write when sync throws EIO", async (t) => {
  const { root, projectRoot, libraryDir, store } = await openTestLibrary();
  const srcPath = join(projectRoot, "fail-create.png");
  await writeFile(srcPath, await makePngBuffer(401));
  const assetId = "durable-fail-create-1";
  const imagesDir = store.imagesDir("default");
  const beforeEntries = (await readdir(imagesDir)).sort();

  const fileHandleProto = await getFileHandlePrototype(root);
  const originalSync = fileHandleProto.sync;
  let syncCalls = 0;
  const syncMock = t.mock.method(fileHandleProto, "sync", async function (...args) {
    syncCalls += 1;
    if (syncCalls === 1) {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    }
    return originalSync.apply(this, args);
  });

  const reader = new Database(join(libraryDir, "mosa.db"), { readonly: true });
  try {
    await assert.rejects(
      () => store.createAsset({ imagePath: srcPath, assetId }),
      (error) => error?.code === "EIO",
    );
    assert.equal(syncCalls, 1);
    const row = reader.prepare("SELECT id FROM assets WHERE project_id = ? AND id = ?").get("default", assetId);
    assert.equal(row, undefined, "DB must not contain the asset after sync EIO");
    const afterEntries = (await readdir(imagesDir)).sort();
    assert.deepEqual(afterEntries, beforeEntries, "images/ must not contain leftover files after sync EIO");
  } finally {
    syncMock.mock.restore();
    reader.close();
    store.close();
  }
});

test("reference attachment save removes .tmp and leaves index.json byte-identical when sync throws EIO", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-durable-ref-fail-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const referenceStore = createReferenceAttachmentStore(libraryDir);

  const seedBytes = await makePngBuffer(501);
  await referenceStore.save({
    projectId: "default",
    bytes: seedBytes,
    extension: ".png",
    mimeType: "image/png",
    width: 64,
    height: 64,
    provider: "chatgpt",
    capturedAt: "2026-11-20T05:02:00.000Z",
  });

  const projectRoot = join(libraryDir, "reference-attachments", "default");
  const filesRoot = join(projectRoot, "files");
  const indexPath = join(projectRoot, "index.json");
  const beforeFiles = (await readdir(filesRoot)).sort();
  const beforeIndexBytes = await readFile(indexPath);
  const beforeIndexSha = sha256Hex(beforeIndexBytes);

  const fileHandleProto = await getFileHandlePrototype(root);
  const originalSync = fileHandleProto.sync;
  let syncCalls = 0;
  const syncMock = t.mock.method(fileHandleProto, "sync", async function (...args) {
    syncCalls += 1;
    if (syncCalls === 1) {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    }
    return originalSync.apply(this, args);
  });

  try {
    const failingBytes = await makePngBuffer(502);
    await assert.rejects(
      () => referenceStore.save({
        projectId: "default",
        bytes: failingBytes,
        extension: ".png",
        mimeType: "image/png",
        width: 64,
        height: 64,
        provider: "chatgpt",
        capturedAt: "2026-11-20T05:03:00.000Z",
      }),
      (error) => error?.code === "EIO",
    );
    assert.equal(syncCalls, 1);
    const afterFiles = (await readdir(filesRoot)).sort();
    assert.equal(afterFiles.filter((name) => name.endsWith(".tmp")).length, 0, "files/ must not contain .tmp leftovers");
    assert.deepEqual(afterFiles, beforeFiles, "files/ must remain unchanged after sync EIO");
    const afterIndexBytes = await readFile(indexPath);
    const afterIndexSha = sha256Hex(afterIndexBytes);
    t.diagnostic(`reference index.json sha256 before=${beforeIndexSha} after=${afterIndexSha}`);
    assert.equal(afterIndexSha, beforeIndexSha);
    assert.equal(Buffer.compare(afterIndexBytes, beforeIndexBytes), 0);
  } finally {
    syncMock.mock.restore();
  }
});

test("replaceAssetMedia removes staged replacement file and keeps original_path when sync throws EIO", async (t) => {
  const { root, projectRoot, libraryDir, store } = await openTestLibrary();
  const initialSrc = join(projectRoot, "replace-fail-initial.png");
  const nextSrc = join(projectRoot, "replace-fail-next.png");
  await writeFile(initialSrc, await makePngBuffer(601));
  await writeFile(nextSrc, await makePngBuffer(602));
  const assetId = "durable-fail-replace-1";

  const created = await store.createAsset({ imagePath: initialSrc, assetId });
  const oldOriginalPath = created.image_path;
  const imagesDir = store.imagesDir("default");
  const beforeEntries = (await readdir(imagesDir)).sort();

  const fileHandleProto = await getFileHandlePrototype(root);
  const originalSync = fileHandleProto.sync;
  let syncCalls = 0;
  const syncMock = t.mock.method(fileHandleProto, "sync", async function (...args) {
    syncCalls += 1;
    if (syncCalls === 1) {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    }
    return originalSync.apply(this, args);
  });

  const reader = new Database(join(libraryDir, "mosa.db"), { readonly: true });
  try {
    await assert.rejects(
      () => store.replaceAssetMedia("default", assetId, { imagePath: nextSrc }),
      (error) => error?.code === "EIO",
    );
    assert.equal(syncCalls, 1);
    const row = reader.prepare("SELECT original_path FROM assets WHERE project_id = ? AND id = ?").get("default", assetId);
    assert.equal(row?.original_path, oldOriginalPath);
    const afterEntries = (await readdir(imagesDir)).sort();
    assert.deepEqual(afterEntries, beforeEntries);
  } finally {
    syncMock.mock.restore();
    reader.close();
    store.close();
  }
});

test("writeReferenceIndex removes temp index file and preserves index.json when index sync throws EIO", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-durable-ref-index-fail-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const referenceStore = createReferenceAttachmentStore(libraryDir);

  await referenceStore.save({
    projectId: "default",
    bytes: await makePngBuffer(701),
    extension: ".png",
    mimeType: "image/png",
    width: 64,
    height: 64,
    provider: "chatgpt",
    capturedAt: "2026-11-20T05:04:00.000Z",
  });

  const projectRoot = join(libraryDir, "reference-attachments", "default");
  const indexPath = join(projectRoot, "index.json");
  const beforeIndexBytes = await readFile(indexPath);
  const beforeIndexSha = sha256Hex(beforeIndexBytes);

  const fileHandleProto = await getFileHandlePrototype(root);
  const originalSync = fileHandleProto.sync;
  let syncCalls = 0;
  const syncMock = t.mock.method(fileHandleProto, "sync", async function (...args) {
    syncCalls += 1;
    if (syncCalls === 3) {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    }
    return originalSync.apply(this, args);
  });

  try {
    const failingBytes = await makePngBuffer(702);
    await assert.rejects(
      () => referenceStore.save({
        projectId: "default",
        bytes: failingBytes,
        extension: ".png",
        mimeType: "image/png",
        width: 64,
        height: 64,
        provider: "chatgpt",
        capturedAt: "2026-11-20T05:05:00.000Z",
      }),
      (error) => error?.code === "EIO",
    );
    assert.equal(syncCalls, 3);
    const projectEntries = await readdir(projectRoot);
    assert.equal(projectEntries.filter((name) => name.endsWith(".tmp")).length, 0, "no temporary index .tmp should remain");
    const afterIndexBytes = await readFile(indexPath);
    const afterIndexSha = sha256Hex(afterIndexBytes);
    assert.equal(afterIndexSha, beforeIndexSha);
    assert.equal(Buffer.compare(afterIndexBytes, beforeIndexBytes), 0);
  } finally {
    syncMock.mock.restore();
  }
});
