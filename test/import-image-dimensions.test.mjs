// Task 292: images carry their display dimensions from the moment they are
// created — read from the file header only (no pixel decode, no pixel limit),
// with the EXIF orientation swap shared with the derivative write-back so a
// card never changes ratio twice. Bad files must import exactly as before.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import test from "node:test";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { createDerivativeProcessor, processDerivativeJob } from "../lib/derivative-worker.js";
import { removeTestPath } from "./test-cleanup.mjs";

async function createStore(t) {
  const root = await mkdtemp(join(tmpdir(), "mosa-import-dims-"));
  const libraryDir = join(root, "library");
  const imagesDir = join(root, "generated-images");
  await mkdir(imagesDir, { recursive: true });
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: join(root, "manager"), libraryDir });
  t.after(() => store.close());
  t.after(() => removeTestPath(root, { recursive: true, force: true }));
  return { root, imagesDir, store };
}

async function runAllDerivatives(store, processor) {
  for (let job = await store.claimDerivativeJob(); job; job = await store.claimDerivativeJob()) {
    await processDerivativeJob(store, job, { processor });
  }
}

function dimensionsOf(asset) {
  return [asset.business_fields.width, asset.business_fields.height];
}

test("PNG, JPEG (EXIF orientation 6) and WebP get dimensions at createAsset; derivatives keep them", async (t) => {
  const { imagesDir, store } = await createStore(t);
  const pngPath = join(imagesDir, "plain.png");
  await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 12, g: 34, b: 56 } } }).png().toFile(pngPath);
  const jpegPath = join(imagesDir, "rotated.jpg");
  // Stored pixel grid 3000x2000 with EXIF orientation 6: displayed 2000x3000.
  await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 12, g: 34, b: 56 } } })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 90 })
    .toFile(jpegPath);
  const webpPath = join(imagesDir, "tall.webp");
  await sharp({ create: { width: 640, height: 1136, channels: 3, background: { r: 12, g: 34, b: 56 } } }).webp().toFile(webpPath);

  const png = await store.createAsset({ assetId: "png-plain", imagePath: pngPath });
  const jpeg = await store.createAsset({ assetId: "jpeg-orient6", imagePath: jpegPath });
  const webp = await store.createAsset({ assetId: "webp-tall", imagePath: webpPath });
  assert.deepEqual(dimensionsOf(png), [1200, 800], "PNG has dimensions at insert");
  assert.deepEqual(dimensionsOf(jpeg), [2000, 3000], "orientation 6 swaps stored 3000x2000 to 2000x3000");
  assert.deepEqual(dimensionsOf(webp), [640, 1136], "WebP has dimensions at insert");
  assert.ok(Number(png.business_fields.file_bytes) > 0, "file size fill still rides along");

  // The derivative write-back must not change the ratio again.
  const processor = createDerivativeProcessor();
  t.after(() => processor.close());
  assert.equal(await store.enqueueMissingDerivatives({ mode: "rebuild" }), 3);
  await runAllDerivatives(store, processor);

  assert.deepEqual(dimensionsOf(await store.getAsset("default", "png-plain")), [1200, 800], "PNG ratio unchanged after derivatives");
  assert.deepEqual(dimensionsOf(await store.getAsset("default", "jpeg-orient6")), [2000, 3000], "orientation-6 ratio unchanged after derivatives");
  assert.deepEqual(dimensionsOf(await store.getAsset("default", "webp-tall")), [640, 1136], "WebP ratio unchanged after derivatives");
});

test("an 8000x5500 image beyond the 40MP derivative limit still gets dimensions; its derivative job still fails", async (t) => {
  const { imagesDir, store } = await createStore(t);
  const bigPath = join(imagesDir, "huge.png");
  await sharp({ create: { width: 8000, height: 5500, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toFile(bigPath);

  const asset = await store.createAsset({ assetId: "big-44mp", imagePath: bigPath });
  assert.deepEqual(dimensionsOf(asset), [8000, 5500], "header read has no pixel limit");

  const processor = createDerivativeProcessor();
  t.after(() => processor.close());
  assert.equal(await store.enqueueMissingDerivatives({ mode: "rebuild" }), 1);
  const job = await store.claimDerivativeJob();
  const outcome = await processDerivativeJob(store, job, { processor });
  assert.equal(outcome.ok, false, "the derivative job still fails past the pixel limit (unchanged)");
  assert.match(String(outcome.error || ""), /pixel limit|exceeds/i);
  // The imported dimensions survive the failed job.
  assert.deepEqual(dimensionsOf(await store.getAsset("default", "big-44mp")), [8000, 5500]);
});

test("caller-supplied dimensions are never overwritten", async (t) => {
  const { imagesDir, store } = await createStore(t);
  const pngPath = join(imagesDir, "caller.png");
  await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 9, g: 9, b: 9 } } }).png().toFile(pngPath);
  const asset = await store.createAsset({
    assetId: "caller-dims",
    imagePath: pngPath,
    business_fields: { width: 111, height: 222 },
  });
  assert.deepEqual(dimensionsOf(asset), [111, 222]);
});

test("a text file with a .png extension imports as before — no new error, no dimensions", async (t) => {
  const { imagesDir, store } = await createStore(t);
  const badPath = join(imagesDir, "not-an-image.png");
  await writeFile(badPath, "this is text, not an image");

  const asset = await store.createAsset({ assetId: "bad-file", imagePath: badPath });
  assert.equal(asset.id, "bad-file", "the import itself still succeeds");
  assert.equal(asset.business_fields.width ?? null, null, "no width invented");
  assert.equal(asset.business_fields.height ?? null, null, "no height invented");
});

test("a video import is untouched by the image dimension fill", async (t) => {
  const { imagesDir, store } = await createStore(t);
  // A .webm container sharp cannot read: the video fill ignores it too, so
  // the row simply carries no dimensions — same as before this task.
  const videoPath = join(imagesDir, "clip.webm");
  await writeFile(videoPath, "not a real webm container");

  const asset = await store.createAsset({ assetId: "video-row", imagePath: videoPath });
  assert.equal(asset.business_fields.width ?? null, null);
  assert.equal(asset.business_fields.height ?? null, null);
});
