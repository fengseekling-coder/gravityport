import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  PERCEPTUAL_HASH_ALGORITHM,
  computePerceptualHash,
  parsePerceptualHash,
  perceptualHammingDistance,
} from "../lib/perceptual-hash.js";

async function gradientPng(width = 64, height = 64, invert = false) {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = Math.round((255 * (x + y)) / (width + height - 2));
      const index = (y * width + x) * 3;
      const channel = invert ? 255 - value : value;
      raw[index] = channel;
      raw[index + 1] = channel;
      raw[index + 2] = channel;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

test("computePerceptualHash returns a parseable algorithm-prefixed digest", async () => {
  const png = await gradientPng();
  const digest = await computePerceptualHash(png);
  assert.match(digest, new RegExp(`^${PERCEPTUAL_HASH_ALGORITHM}:[0-9a-f]{16}$`));
  assert.deepEqual(parsePerceptualHash(digest), { algorithm: PERCEPTUAL_HASH_ALGORITHM, hash: digest.split(":")[1] });
});

test("identical encodings of the same pixels share one digest", async () => {
  const png = await gradientPng();
  const reencoded = await sharp(png).png().toBuffer();
  assert.equal(await computePerceptualHash(png), await computePerceptualHash(reencoded));
});

test("rescaling and recompression keep the distance small", async () => {
  const png = await gradientPng(512, 512);
  const digest = await computePerceptualHash(png);
  const scaled = await sharp(png).resize(128, 128).jpeg({ quality: 70 }).toBuffer();
  assert.ok(perceptualHammingDistance(digest, await computePerceptualHash(scaled)) <= 10);
});

test("different images land far apart", async () => {
  const digestA = await computePerceptualHash(await gradientPng(64, 64, false));
  const digestB = await computePerceptualHash(await gradientPng(64, 64, true));
  assert.ok(perceptualHammingDistance(digestA, digestB) > 24);
});

test("alpha channels do not shift the digest", async () => {
  const png = await gradientPng();
  const withAlpha = await sharp(png).ensureAlpha().png().toBuffer();
  assert.equal(await computePerceptualHash(png), await computePerceptualHash(withAlpha));
});

test("perceptualHammingDistance rejects malformed and cross-algorithm inputs", () => {
  const good = `${PERCEPTUAL_HASH_ALGORITHM}:${"0".repeat(16)}`;
  assert.equal(perceptualHammingDistance(good, good), 0);
  assert.equal(perceptualHammingDistance(good, "dhash64:zzzz"), Infinity);
  assert.equal(perceptualHammingDistance(good, "phash64:0000000000000000"), Infinity);
  assert.equal(perceptualHammingDistance(good, "0000000000000000"), Infinity);
  assert.equal(perceptualHammingDistance("", good), Infinity);
});

test("parsePerceptualHash rejects garbage", () => {
  assert.equal(parsePerceptualHash("no-separator"), null);
  assert.equal(parsePerceptualHash("dhash64:short"), null);
  assert.equal(parsePerceptualHash("dhash64:00000000000000000"), null);
  assert.deepEqual(parsePerceptualHash(`${PERCEPTUAL_HASH_ALGORITHM}:abcdef0123456789`), {
    algorithm: PERCEPTUAL_HASH_ALGORITHM,
    hash: "abcdef0123456789",
  });
});
