import sharp from "sharp";

/**
 * Manual-import dedupe (task 291) skips bytes the library already holds, so
 * tests that import several files into one library must give each file
 * distinct bytes. Seed-derived solid colors keep the PNGs tiny and unique.
 */
export async function uniquePngBytes(seed = 0) {
  const value = Number(seed) || 0;
  return sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: value & 255, g: (value * 7 + 11) & 255, b: (value * 13 + 29) & 255 },
    },
  }).png().toBuffer();
}
