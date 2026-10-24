// Video metadata reader tests (lib/video-metadata.ts): real ISO BMFF files
// generated once with ffmpeg and committed under test/fixtures/video-metadata
// (CI has no ffmpeg — see that directory's README). The four real Jimeng
// captures from the user's library were verified against this reader during
// development; they must never be committed, so the fixtures stand in here.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  readVideoMetadataFromBuffer,
  readVideoMetadataFromFile,
  readVideoMetadataFromFileSync,
} from "../lib/video-metadata.js";

const fixturesDir = resolve(import.meta.dirname, "fixtures", "video-metadata");

test("reads width, height and duration from a faststart mp4 (moov in front)", async () => {
  const path = join(fixturesDir, "faststart-72x128.mp4");
  const expected = { width: 72, height: 128, durationSeconds: 2 };
  assert.deepEqual(await readVideoMetadataFromFile(path), expected);
  assert.deepEqual(readVideoMetadataFromFileSync(path), expected);
  assert.deepEqual(readVideoMetadataFromBuffer(await readFile(path)), expected);
});

test("reads a moov-at-tail mp4 by walking top-level box headers", async () => {
  const path = join(fixturesDir, "moov-late-72x128.mp4");
  const expected = { width: 72, height: 128, durationSeconds: 2 };
  assert.deepEqual(await readVideoMetadataFromFile(path), expected);
  assert.deepEqual(readVideoMetadataFromFileSync(path), expected);
  assert.deepEqual(readVideoMetadataFromBuffer(await readFile(path)), expected);
});

test("swaps width and height for a 90-degree rotation matrix", async () => {
  const path = join(fixturesDir, "rotated-90-72x128.mp4");
  // The track stores 72x128 with a quarter-turn display matrix: the picture
  // viewers show (and the gallery needs) is 128x72.
  const expected = { width: 128, height: 72, durationSeconds: 2 };
  assert.deepEqual(await readVideoMetadataFromFile(path), expected);
  assert.deepEqual(readVideoMetadataFromBuffer(await readFile(path)), expected);
});

test("reads a QuickTime MOV container", async () => {
  const path = join(fixturesDir, "sample-72x128.mov");
  const expected = { width: 72, height: 128, durationSeconds: 2 };
  assert.deepEqual(await readVideoMetadataFromFile(path), expected);
  assert.deepEqual(readVideoMetadataFromFileSync(path), expected);
  assert.deepEqual(readVideoMetadataFromBuffer(await readFile(path)), expected);
});

test("returns null for a file cut off before its tail moov", async () => {
  const path = join(fixturesDir, "truncated.mp4");
  assert.equal(await readVideoMetadataFromFile(path), null);
  assert.equal(readVideoMetadataFromFileSync(path), null);
  assert.equal(readVideoMetadataFromBuffer(await readFile(path)), null);
});

test("returns null for non-video bytes instead of throwing", async () => {
  assert.equal(readVideoMetadataFromBuffer(Buffer.alloc(0)), null);
  assert.equal(readVideoMetadataFromBuffer(Buffer.from("not a video at all, just text", "utf8")), null);
  // WebM/EBML magic: the u32 size parse sends the walker past the file end.
  assert.equal(readVideoMetadataFromBuffer(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])), null);
  // A size that claims more bytes than exist.
  assert.equal(readVideoMetadataFromBuffer(Buffer.from([0, 0, 0, 32, 0x66, 0x74, 0x79, 0x70])), null);
});

test("returns null for missing files instead of throwing", async () => {
  await assert.equal(await readVideoMetadataFromFile(join(fixturesDir, "does-not-exist.mp4")), null);
  assert.equal(readVideoMetadataFromFileSync(join(fixturesDir, "does-not-exist.mp4")), null);
});

test("parses a moov-only buffer the same way as a whole file", async () => {
  const bytes = await readFile(join(fixturesDir, "faststart-72x128.mp4"));
  // The async file entry reads exactly this range after locating the moov.
  const moovStart = bytes.indexOf(Buffer.from("moov", "ascii")) - 4;
  const moovSize = bytes.readUInt32BE(moovStart);
  assert.deepEqual(
    readVideoMetadataFromBuffer(bytes.subarray(moovStart + 8, moovStart + moovSize)),
    { width: 72, height: 128, durationSeconds: 2 },
  );
});
