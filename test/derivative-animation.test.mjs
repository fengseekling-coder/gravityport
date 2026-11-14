import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import sharp from "sharp";
import { detectAnimation } from "../lib/derivative-processor.js";
import { createDerivativeProcessor, processDerivativeJob } from "../lib/derivative-worker.js";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

// Task 412: the derivative run also reports whether the ORIGINAL animates
// (animated + frameCount on the result, riding back like width/height). The
// three derivatives stay still; only the flag is new. Fixtures are made here,
// never downloaded.

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, crc]);
}

function rawFrame(width, height, [r, g, b]) {
  // One PNG scanline per row: filter byte 0 + RGB triplets.
  const stride = 1 + width * 3;
  const frame = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    frame[row] = 0;
    for (let x = 0; x < width; x += 1) {
      frame[row + 1 + x * 3] = r;
      frame[row + 2 + x * 3] = g;
      frame[row + 3 + x * 3] = b;
    }
  }
  return frame;
}

// Minimal APNG per the PNG/APNG spec: signature + IHDR + acTL(num_frames) +
// one fcTL + IDAT per frame + IEND. CRCs are real so libpng accepts it.
function minimalApng({ width = 60, height = 40, frames = 2 } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frames, 0); // num_frames
  actl.writeUInt32BE(0, 4); // num_plays: infinite
  const fctl = (seq) => {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(seq, 0);
    data.writeUInt32BE(width, 4);
    data.writeUInt32BE(height, 8);
    data.writeUInt16BE(1, 20); // delay numerator
    data.writeUInt16BE(10, 22); // delay denominator -> 100ms
    return pngChunk("fcTL", data);
  };
  const frameColors = [[255, 40, 40], [40, 40, 255], [40, 255, 40]];
  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("acTL", actl),
  ];
  for (let frame = 0; frame < frames; frame += 1) {
    chunks.push(fctl(frame));
    chunks.push(pngChunk("IDAT", zlib.deflateSync(rawFrame(width, height, frameColors[frame % frameColors.length]))));
  }
  chunks.push(pngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

// sharp encodes animated AVIF without the "avis" brand; the format still
// marks sequences through compatible brands, so patch one in place (same box
// size) the way real producers (e.g. ffmpeg) write it.
async function avisAvif() {
  const red = await sharp({ create: { width: 60, height: 40, channels: 3, background: { r: 255, g: 40, b: 40 } } }).png().toBuffer();
  const blue = await sharp({ create: { width: 60, height: 40, channels: 3, background: { r: 40, g: 40, b: 255 } } }).png().toBuffer();
  const avif = await sharp([red, blue], { join: { animated: true } }).avif().toBuffer();
  const patched = Buffer.from(avif);
  const boxSize = avif.readUInt32BE(0);
  for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
    if (patched.subarray(offset, offset + 4).toString("latin1") === "miaf") {
      patched.write("avis", offset, "latin1");
      return patched;
    }
  }
  throw new Error("no compatible brand to patch with avis");
}

async function sharpFrames(colorA, colorB) {
  const make = (color) => sharp({ create: { width: 60, height: 40, channels: 3, background: color } }).png().toBuffer();
  return [await make(colorA), await make(colorB)];
}

async function writeFixture(root, name, bytes) {
  const filePath = join(root, name);
  await writeFile(filePath, bytes);
  return filePath;
}

function fakeStore() {
  const completions = [];
  return {
    completions,
    async completeDerivativeJob(_job, result) { completions.push(result); },
  };
}

async function makeJob(root, id, originalPath) {
  return {
    project_id: "default",
    asset_id: id,
    original_path: originalPath,
    previewPath: join(root, "previews", `${id}.webp`),
    mediumPath: join(root, "mediums", `${id}.webp`),
    thumbnailPath: join(root, "thumbnails", `${id}.webp`),
  };
}

test("two-frame GIF and WebP report animated with their page count; stills report one frame", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-anim-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const [red, blue] = await sharpFrames({ r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 255 });

  const gif = await writeFixture(root, "two-frames.gif", await sharp([red, blue], { join: { animated: true } }).gif().toBuffer());
  const webp = await writeFixture(root, "two-frames.webp", await sharp([red, blue], { join: { animated: true } }).webp().toBuffer());
  const stillGif = await writeFixture(root, "one-frame.gif", await sharp(red).gif().toBuffer());

  const processor = createDerivativeProcessor();
  t.after(() => processor.close());
  const store = fakeStore();

  const jobGif = await makeJob(root, "gif2", gif);
  const outcomeGif = await processDerivativeJob(store, jobGif, { processor });
  assert.equal(outcomeGif.ok, true, `gif job failed: ${outcomeGif.error || ""}`);
  assert.equal(outcomeGif.animated, true);
  assert.equal(outcomeGif.frameCount, 2);
  assert.equal(store.completions.at(-1).animated, true, "the flag reached completeDerivativeJob through the worker");
  assert.equal(store.completions.at(-1).frameCount, 2);

  const jobWebp = await makeJob(root, "webp2", webp);
  const outcomeWebp = await processDerivativeJob(store, jobWebp, { processor });
  assert.equal(outcomeWebp.ok, true, `webp job failed: ${outcomeWebp.error || ""}`);
  assert.equal(outcomeWebp.animated, true);
  assert.equal(outcomeWebp.frameCount, 2);

  const jobStill = await makeJob(root, "gif1", stillGif);
  const outcomeStill = await processDerivativeJob(store, jobStill, { processor });
  assert.equal(outcomeStill.ok, true, `still gif job failed: ${outcomeStill.error || ""}`);
  assert.equal(outcomeStill.animated, false);
  assert.equal(outcomeStill.frameCount, 1);
});

test("a handcrafted APNG is detected through its acTL chunk; a plain PNG is not animated", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-apng-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const apng = await writeFixture(root, "sequence.apng", minimalApng({ frames: 2 }));
  const plain = await writeFixture(root, "plain.png", await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer());

  const processor = createDerivativeProcessor();
  t.after(() => processor.close());
  const store = fakeStore();

  const outcomeApng = await processDerivativeJob(store, await makeJob(root, "apng", apng), { processor });
  assert.equal(outcomeApng.ok, true, `apng job failed: ${outcomeApng.error || ""}`);
  assert.equal(outcomeApng.animated, true);
  assert.equal(outcomeApng.frameCount, 2);

  const outcomePlain = await processDerivativeJob(store, await makeJob(root, "png", plain), { processor });
  assert.equal(outcomePlain.ok, true, `png job failed: ${outcomePlain.error || ""}`);
  assert.equal(outcomePlain.animated, false);
  assert.equal(outcomePlain.frameCount, 1);
});

test("an AVIF with the avis brand is a sequence (frames unknown); a plain AVIF is still", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-avif-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sequence = await writeFixture(root, "sequence.avif", await avisAvif());
  const still = await writeFixture(root, "still.avif", await sharp({ create: { width: 60, height: 40, channels: 3, background: { r: 40, g: 255, b: 40 } } }).avif().toBuffer());

  const processor = createDerivativeProcessor();
  t.after(() => processor.close());
  const store = fakeStore();

  const outcomeSequence = await processDerivativeJob(store, await makeJob(root, "avifs", sequence), { processor });
  assert.equal(outcomeSequence.ok, true, `avif sequence job failed: ${outcomeSequence.error || ""}`);
  assert.equal(outcomeSequence.animated, true);
  assert.equal(outcomeSequence.frameCount, null);

  const outcomeStill = await processDerivativeJob(store, await makeJob(root, "avif1", still), { processor });
  assert.equal(outcomeStill.ok, true, `avif still job failed: ${outcomeStill.error || ""}`);
  assert.equal(outcomeStill.animated, false);
  assert.equal(outcomeStill.frameCount, 1);
});

test("unrelated formats are still images, and a probe error reports false/null without failing the job", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-anim-still-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const jpeg = await writeFixture(root, "still.jpg", await sharp({ create: { width: 60, height: 40, channels: 3, background: { r: 20, g: 30, b: 40 } } }).jpeg().toBuffer());

  const processor = createDerivativeProcessor();
  t.after(() => processor.close());
  const store = fakeStore();
  const outcome = await processDerivativeJob(store, await makeJob(root, "jpg", jpeg), { processor });
  assert.equal(outcome.ok, true, `jpg job failed: ${outcome.error || ""}`);
  assert.equal(outcome.animated, false);
  assert.equal(outcome.frameCount, 1);

  // Truncated files cannot reach the worker (the derivative itself would
  // fail on decode), so the probe entry is exercised directly: the file-head
  // readers must come back as false/null on their own read errors, never as
  // a throw. The GIF/WebP branch does no IO — it reuses the metadata the
  // processor already read, so a missing page count is a still image.
  const [red, blue] = await sharpFrames({ r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 255 });
  const fullGif = await sharp([red, blue], { join: { animated: true } }).gif().toBuffer();
  const truncatedGif = await writeFixture(root, "truncated.gif", fullGif.subarray(0, Math.floor(fullGif.length * 0.6)));
  assert.deepEqual(await detectAnimation(truncatedGif, {}), { animated: false, frameCount: 1 }, "no pages in the metadata -> still, no throw");

  const fullPng = await sharp(red).png().toBuffer();
  // Cut before the first chunk header: the walker's own read fails and must
  // answer false/null instead of throwing.
  const truncatedPng = await writeFixture(root, "truncated.png", fullPng.subarray(0, 20));
  assert.deepEqual(await detectAnimation(truncatedPng, {}), { animated: false, frameCount: null });
  // The spec stops the scan at the first IDAT header, so even a file truncated
  // mid-stream past it answers from the intact header region alone.
  const truncatedAfterIdat = await writeFixture(root, "truncated-past-idat.png", fullPng.subarray(0, Math.floor(fullPng.length * 0.5)));
  assert.deepEqual(await detectAnimation(truncatedAfterIdat, {}), { animated: false, frameCount: 1 });

  const fakePath = await writeFixture(root, "not-actually.png", Buffer.from("this is not a png file at all, but it ends with .png"));
  assert.deepEqual(await detectAnimation(fakePath, {}), { animated: false, frameCount: null });

  const fakeAvif = await writeFixture(root, "not-actually.avif", Buffer.from("still not an avif file, truncated header and all"));
  assert.deepEqual(await detectAnimation(fakeAvif, {}), { animated: false, frameCount: null });
});

test("detectAnimation reads animated metadata through the same shapes the processor passes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-anim-meta-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const [red, blue] = await sharpFrames({ r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 255 });
  const gif = await writeFixture(root, "pages.gif", await sharp([red, blue], { join: { animated: true } }).gif().toBuffer());
  const metadata = await sharp(gif, { limitInputPixels: 1000000 }).metadata();
  assert.equal(metadata.pages, 2, "precondition: sharp reports the page count");
  assert.deepEqual(await detectAnimation(gif, metadata), { animated: true, frameCount: 2 });
});
