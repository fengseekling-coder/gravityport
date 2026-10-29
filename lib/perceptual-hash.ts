import sharp from "./sharp-runtime.js";

/**
 * Perceptual fingerprint of an image, computed from the 400px derivative
 * thumbnail the same pipeline publishes (not from the original bytes), so the
 * value for "the same picture" agrees no matter which encoding arrived. The
 * digest is a 64-bit difference hash serialized as 16 lowercase hex digits
 * prefixed by the algorithm name, e.g. "dhash64:9f8a1c2b3d4e5f60".
 *
 * This hash deliberately answers "almost certainly the same picture" (find
 * candidates for manual-import dedupe), never "identical pixels" — identical
 * pixels stay the job of safePixelDigest, which candidates confirm lazily.
 */

export const PERCEPTUAL_HASH_ALGORITHM = "dhash64";
/** Bumped when the thumbnail source tier or the bit layout ever changes. */
export const PERCEPTUAL_HASH_VERSION = "thumb-dhash-v1";

const POPCOUNT = new Uint8Array(65536);
for (let i = 1; i < 65536; i += 1) POPCOUNT[i] = POPCOUNT[i >> 1] + (i & 1);

function popcount32(value: number): number {
  return POPCOUNT[value & 0xffff] + POPCOUNT[(value >>> 16) & 0xffff];
}

/** Hamming distance between two "dhash64:<16 hex>" digests. Non-parseable
 * inputs return Infinity so callers never treat garbage as a near match. */
export function perceptualHammingDistance(a: string, b: string): number {
  const left = parsePerceptualHash(a);
  const right = parsePerceptualHash(b);
  if (!left || !right || left.algorithm !== right.algorithm) return Infinity;
  const high = parseInt(left.hash.slice(0, 8), 16) ^ parseInt(right.hash.slice(0, 8), 16);
  const low = parseInt(left.hash.slice(8, 16), 16) ^ parseInt(right.hash.slice(8, 16), 16);
  return popcount32(high >>> 0) + popcount32(low >>> 0);
}

export function parsePerceptualHash(encoded: string): { algorithm: string; hash: string } | null {
  const value = String(encoded || "");
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const algorithm = value.slice(0, separator);
  const hash = value.slice(separator + 1);
  if (algorithm !== PERCEPTUAL_HASH_ALGORITHM || !/^[0-9a-f]{16}$/.test(hash)) return null;
  return { algorithm, hash };
}

/** 9×8 grayscale difference hash: each bit records whether a pixel is darker
 * than its left neighbor. Resists rescaling, recompression and format changes
 * while staying an order of magnitude cheaper than a DCT hash. */
export async function computePerceptualHash(input: Buffer | string): Promise<string> {
  const raw = await sharp(input, { failOn: "error" })
    .removeAlpha()
    .grayscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer();
  let high = 0;
  let low = 0;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const bit = raw[y * 9 + x] < raw[y * 9 + x + 1] ? 1 : 0;
      if (y < 4) high = (high * 2) | bit;
      else low = (low * 2) | bit;
    }
  }
  const hex = (high >>> 0).toString(16).padStart(8, "0") + (low >>> 0).toString(16).padStart(8, "0");
  return `${PERCEPTUAL_HASH_ALGORITHM}:${hex}`;
}
