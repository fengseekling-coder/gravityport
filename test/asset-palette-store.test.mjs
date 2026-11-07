import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createSqliteAssetStore, sqliteDatabasePath } from "../lib/sqlite-asset-store.mjs";
import { mp4Bytes } from "./helpers/managed-media.mjs";
import { processDerivativeJob } from "../lib/derivative-worker.js";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

// Backend palette contract: the column appears on old libraries without
// touching their data, derivative completions record it, assets expose only
// the ordered hex strings, ensureAssetPalette backfills exactly once from the
// thumbnail, and the single-asset API route serves the palette.

async function createStore(t) {
  const root = await mkdtemp(join(tmpdir(), "mosa-asset-palette-"));
  await mkdir(join(root, "generated-images"), { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: join(root, "manager"), libraryDir: join(root, "library") });
  // The old-library test closes the store mid-test to rewrite its schema; a
  // second close at teardown must stay a no-op there.
  t.after(() => { try { store.close(); } catch {} });
  t.after(() => removeTestPath(root, { recursive: true, force: true }));
  return { root, store };
}

async function writeTwoColorImage(path) {
  await sharp({ create: { width: 128, height: 128, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([
      { input: await sharp({ create: { width: 64, height: 128, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer(), left: 0, top: 0 },
      { input: await sharp({ create: { width: 64, height: 128, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toBuffer(), left: 64, top: 0 },
    ])
    .png()
    .toFile(path);
}

async function createImageAsset(store, root, assetId) {
  const imagePath = join(root, "generated-images", `${assetId}.png`);
  await writeTwoColorImage(imagePath);
  await store.createAsset({ assetId, imagePath, prompt: `prompt for ${assetId}` });
  return imagePath;
}

// Records the canonical derivative paths like a completed worker run, without
// producing real files — callers write whatever thumbnail bytes they need.
async function completeDerivativePaths(store, assetId) {
  const job = await store.claimDerivativeJob();
  assert.ok(job, "a derivative job is pending");
  await store.completeDerivativeJob(job, {
    width: 128,
    height: 128,
    previewPath: job.previewPath,
    mediumPath: job.mediumPath,
    thumbnailPath: job.thumbnailPath,
  });
  return job;
}

async function writeThumbnailFile(store, assetId, { lossless = true } = {}) {
  const thumbnailPath = join(store.projectDir("default"), "thumbnails", `${assetId}.webp`);
  await mkdir(dirname(thumbnailPath), { recursive: true });
  const webp = sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 0, g: 0, b: 0 } } });
  const pipeline = lossless ? webp.composite([
    { input: await sharp({ create: { width: 200, height: 400, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer(), left: 0, top: 0 },
    { input: await sharp({ create: { width: 200, height: 400, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toBuffer(), left: 200, top: 0 },
  ]).webp({ lossless: true }) : webp;
  await pipeline.toFile(thumbnailPath);
  return thumbnailPath;
}

function rawColumnNames(libraryDir) {
  const raw = new Database(sqliteDatabasePath(libraryDir));
  try {
    return raw.prepare("SELECT name FROM pragma_table_info('assets')").all().map((row) => row.name);
  } finally {
    raw.close();
  }
}

function rawAssetRow(libraryDir, assetId) {
  const raw = new Database(sqliteDatabasePath(libraryDir));
  try {
    return raw.prepare("SELECT * FROM assets WHERE id = ?").get(assetId);
  } finally {
    raw.close();
  }
}

test("a library without the palette column gains it on open and keeps every value", async (t) => {
  const { root, store } = await createStore(t);
  const libraryDir = join(root, "library");
  await createImageAsset(store, root, "legacy");
  await completeDerivativePaths(store, "legacy");
  await writeThumbnailFile(store, "legacy");
  const before = await store.getAsset("default", "legacy");
  store.close();

  assert.ok(rawColumnNames(libraryDir).includes("palette_json"), "fresh schema has the column");
  const raw = new Database(sqliteDatabasePath(libraryDir));
  raw.exec("ALTER TABLE assets DROP COLUMN palette_json");
  raw.close();
  assert.ok(!rawColumnNames(libraryDir).includes("palette_json"));

  const reopened = createSqliteAssetStore({ projectRoot: root, managerDir: join(root, "manager"), libraryDir });
  t.after(() => reopened.close());
  assert.ok(rawColumnNames(libraryDir).includes("palette_json"), "opening re-adds the column");

  const after = await reopened.getAsset("default", "legacy");
  assert.deepEqual({ ...after, palette: [] }, { ...before, palette: [] });
  assert.deepEqual(after.palette, []);
});

test("completeDerivativeJob stores the palette and getAsset exposes ordered hex strings", async (t) => {
  const { root, store } = await createStore(t);
  await createImageAsset(store, root, "derived");

  const job = await store.claimDerivativeJob();
  await store.completeDerivativeJob(job, {
    width: 128,
    height: 128,
    previewPath: job.previewPath,
    mediumPath: job.mediumPath,
    thumbnailPath: job.thumbnailPath,
    palette: [{ hex: "#FF0000", ratio: 0.6 }, { hex: "#0000FF", ratio: 0.4 }],
  });

  const asset = await store.getAsset("default", "derived");
  assert.deepEqual(asset.palette, ["#FF0000", "#0000FF"]);

  // The full {hex, ratio} entries stay internal to the column.
  const stored = JSON.parse(rawAssetRow(join(root, "library"), "derived").palette_json);
  assert.deepEqual(stored, [{ hex: "#FF0000", ratio: 0.6 }, { hex: "#0000FF", ratio: 0.4 }]);
});

test("completeDerivativeJob without a palette leaves the column untouched", async (t) => {
  const { root, store } = await createStore(t);
  await createImageAsset(store, root, "plain");
  await completeDerivativePaths(store, "plain");

  assert.equal(rawAssetRow(join(root, "library"), "plain").palette_json, null);
  assert.deepEqual((await store.getAsset("default", "plain")).palette, []);
});

test("ensureAssetPalette computes from the thumbnail once and records the result", async (t) => {
  const { root, store } = await createStore(t);
  await createImageAsset(store, root, "backfill");
  await completeDerivativePaths(store, "backfill");
  const thumbnailPath = await writeThumbnailFile(store, "backfill");

  const asset = await store.ensureAssetPalette("default", "backfill");
  assert.deepEqual(asset.palette, ["#0000FF", "#FF0000"]);
  assert.ok(existsSync(thumbnailPath), "the thumbnail is read, not modified");

  // A second open must serve the stored value, not recompute (NULL is gone).
  const again = await store.ensureAssetPalette("default", "backfill");
  assert.deepEqual(again.palette, ["#0000FF", "#FF0000"]);
  assert.equal(again.updated_at, asset.updated_at);

  // ...even when the thumbnail has vanished in the meantime.
  const { rm } = await import("node:fs/promises");
  await rm(thumbnailPath);
  const cached = await store.ensureAssetPalette("default", "backfill");
  assert.deepEqual(cached.palette, ["#0000FF", "#FF0000"]);
});

test("a computed-but-empty palette ('[]') is never recomputed", async (t) => {
  const { root, store } = await createStore(t);
  await createImageAsset(store, root, "empty");
  const job = await store.claimDerivativeJob();
  await store.completeDerivativeJob(job, {
    width: 128,
    height: 128,
    previewPath: job.previewPath,
    mediumPath: job.mediumPath,
    thumbnailPath: job.thumbnailPath,
    palette: [],
  });
  // A perfectly readable, colorful thumbnail exists — '[]' must still win.
  await writeThumbnailFile(store, "empty");

  const asset = await store.ensureAssetPalette("default", "empty");
  assert.deepEqual(asset.palette, []);
  assert.equal(rawAssetRow(join(root, "library"), "empty").palette_json, "[]");
});

test("video assets are never paletted, even with a readable thumbnail", async (t) => {
  const { root, store } = await createStore(t);
  const videoPath = join(root, "generated-images", "clip.mp4");
  await writeFile(videoPath, mp4Bytes());
  await store.createAsset({ assetId: "clip", imagePath: videoPath, prompt: "prompt for clip" });
  // Give the video row everything ensureAssetPalette normally needs except
  // the media kind, so a failure here would compute a palette.
  await writeThumbnailFile(store, "clip");

  const asset = await store.ensureAssetPalette("default", "clip");
  assert.deepEqual(asset.palette, []);
  assert.equal(rawAssetRow(join(root, "library"), "clip").palette_json, null);
});

test("ensureAssetPalette rejects unknown assets", async (t) => {
  const { store } = await createStore(t);
  await assert.rejects(() => store.ensureAssetPalette("default", "ghost"), /Asset not found/);
});

function assertTwoColorHexPalette(palette, label) {
  assert.ok(Array.isArray(palette), `${label}: palette is an array`);
  assert.equal(palette.length, 2, `${label}: both halves surface`);
  for (const hex of palette) assert.match(hex, /^#[0-9A-F]{6}$/);
  const [first, second] = palette;
  // WebP encoding can shift a channel by a step or two; dominant channel identity must not move.
  const redFirst = parseInt(first.slice(1, 3), 16) > 200 && parseInt(first.slice(5), 16) < 80;
  const blueFirst = parseInt(first.slice(3, 5), 16) < 80 && parseInt(first.slice(5), 16) > 200;
  assert.ok(
    (redFirst && parseInt(second.slice(3, 5), 16) < 80 && parseInt(second.slice(5), 16) > 200)
    || (blueFirst && parseInt(second.slice(1, 3), 16) > 200 && parseInt(second.slice(5), 16) < 80),
    `${label}: red and blue dominate: ${palette.join(", ")}`,
  );
}

test("the derivative pipeline computes a palette with the thumbnail in one pass", async (t) => {
  const { root, store } = await createStore(t);
  await createImageAsset(store, root, "pipeline");

  // processDerivativeJob claims through the real store, forks the processor,
  // and completes with its result — the same path production derivatives take.
  const result = await processDerivativeJob(store, await store.claimDerivativeJob());
  assert.equal(result.ok, true);
  assert.equal(result.palette.length, 2);
  for (const entry of result.palette) {
    assert.ok(Math.abs(entry.ratio - 0.5) < 0.05, `each half is ~0.5, got ${entry.ratio}`);
  }
  assertTwoColorHexPalette(result.palette.map((entry) => entry.hex), "processor result");

  const asset = await store.getAsset("default", "pipeline");
  assert.deepEqual(asset.palette, result.palette.map((entry) => entry.hex));
});

test("GET /api/assets/:project/:asset backfills and returns the palette", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-palette-api-"));
  const generatedImagesDir = join(root, "generated-images");
  await mkdir(generatedImagesDir, { recursive: true });
  const imagePath = join(generatedImagesDir, "palette-e2e.png");
  await writeTwoColorImage(imagePath);

  // Seed a completed SQLite library directly so the runtime serves it instead
  // of failing closed to JSON, with a thumbnail but no palette computed yet.
  const libraryDir = join(root, "library");
  const store = createSqliteAssetStore({
    projectRoot: root,
    managerDir: join(root, "manager"),
    libraryDir,
    initializeFreshLibrary: true,
  });
  await store.createAsset({ assetId: "palette-e2e", imagePath, prompt: "two colors" });
  await completeDerivativePaths(store, "palette-e2e");
  await writeThumbnailFile(store, "palette-e2e");
  assert.deepEqual((await store.getAsset("default", "palette-e2e")).palette, []);
  store.close();

  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: root,
    libraryDir,
    assetsRoot: join(root, "assets"),
    generatedImagesDir,
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "sessions"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-data"),
    cowartRegistryPath: join(root, "state", "cowart-projects.json"),
    maintenanceStartDelayMs: 50,
  });
  t.after(() => runtime.stop());
  t.after(() => removeTestPath(root, { recursive: true, force: true }));

  const response = await fetch(`${runtime.url}/api/assets/default/palette-e2e`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assertTwoColorHexPalette(body.asset.palette, "GET response");

  // The backfilled palette now lives in the column: later reads are stable.
  const again = await fetch(`${runtime.url}/api/assets/default/palette-e2e`);
  assert.deepEqual((await again.json()).asset.palette, body.asset.palette);
  assert.ok(existsSync(join(store.projectDir("default"), "thumbnails", "palette-e2e.webp")));
});
