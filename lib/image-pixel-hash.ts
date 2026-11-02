import { imageDecoder } from "./image-decode-client.js";

export const DEFAULT_PIXEL_HASH_LIMIT = 40_000_000;
export const PIXEL_HASH_VERSION = "display-pixels-v2";

/**
 * Return a stable display-pixel SHA-256 for static images. The pipeline applies
 * EXIF orientation, converts to sRGB and canonicalises alpha before hashing.
 * Opaque images deliberately keep MOSA's legacy RGB digest shape so the common
 * orientation=1/sRGB case remains hash-compatible with older libraries.
 *
 * Multi-frame images return an empty digest. A correct animation identity also
 * needs frame timing/disposal metadata, so hashing only decoded pixels would be
 * dangerously incomplete.
 *
 * Task 341: the decode itself runs in the disposable image-decode child
 * process (lib/image-decode-worker.ts) — the implementation in
 * image-decode-ops.ts is verbatim what used to run here, so hashes stay
 * byte-identical. A child crash rejects with an error whose code is
 * IMAGE_DECODER_CRASHED; callers keep their existing catch-and-degrade paths.
 */
export async function safePixelDigest(
  input: Buffer | string,
  options: { limitInputPixels?: number } = {},
): Promise<string> {
  return imageDecoder.pixelDigest(input, options);
}
