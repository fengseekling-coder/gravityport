import sharp from "sharp";

/**
 * Task 366 made both stores sniff the head of every imported file, so test
 * fixtures that go through a real store import must carry real media bytes.
 * These helpers keep the old convenience: throwaway images with controlled
 * byte-distinctness, an undecodable-but-structural MP4 for video imports, and
 * a PNG that passes the sniff but fails decoding (derivative-failure tests).
 */

let autoSeed = 0;

/** A real 8x8 PNG. Without a seed every call returns byte-distinct bytes. */
export async function pngBytes(seed) {
  const value = seed === undefined ? ++autoSeed : seed;
  return sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: value & 255, g: (value * 7 + 11) & 255, b: (value * 13 + 29) & 255 },
    },
  }).png().toBuffer();
}

/**
 * Structural MP4 ([size][ftyp][isom]) — passes the import sniff but is not
 * decodable, like the sampleMp4Bytes fixtures the ingest tests already use.
 * Distinct seed bytes keep content hashes apart.
 */
export function mp4Bytes(seedByte = 7, size = 96 * 1024) {
  const bytes = Buffer.alloc(size, seedByte);
  bytes.writeUInt32BE(24, 0);
  bytes.write("ftyp", 4, "ascii");
  bytes.write("isom", 8, "ascii");
  return bytes;
}

/**
 * A real PNG header, junk in the middle, and a real IEND trailer: the sniff
 * accepts it (task 377's tail check sees a closed PNG stream), sharp cannot
 * decode it. Undecodable fixtures keep the legacy behaviour of imports whose
 * pixel digest cannot be recomputed (claimed hashes pass through unchanged)
 * and keep the derivative-failure tests failing for real. Distinct seeds keep
 * content hashes apart, like the old throwaway text bytes.
 */
export async function brokenPngBytes(seed = 0) {
  const whole = await pngBytes(0);
  const header = whole.subarray(0, 33); // signature + complete IHDR chunk
  const iend = whole.subarray(whole.length - 12); // length 0 + "IEND" + CRC
  return Buffer.concat([header, Buffer.from(`corrupt payload after a real PNG header (seed ${seed})`), iend]);
}
