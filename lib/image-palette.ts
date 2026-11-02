import { imageDecoder } from "./image-decode-client.js";

export interface PaletteColor {
  /** Uppercase "#RRGGBB". */
  hex: string;
  /** Share of the image's opaque pixels, rounded to 3 decimals. */
  ratio: number;
}

// Palette sampling constants (SAMPLE_SIZE, MAX_INPUT_PIXELS and the
// k-means/median-cut tuning) moved with the implementation to image-decode-ops.ts.

/**
 * Extracts up to 8 dominant colors from an image, largest share first.
 *
 * Deterministic by construction: median cut seeds the centers from sorted
 * pixel values, the k-means refinement tie-breaks toward the lower index, and
 * every remaining comparison uses explicit keys, so the same file always
 * yields the same palette. Read/decode failures and fully transparent images
 * return [] instead of throwing — callers treat an empty palette as
 * "computed, nothing to show", never as an error.
 *
 * Task 341: the decode runs in the image-decode child process (verbatim
 * implementation in image-decode-ops.ts); the empty-array degradation here
 * already covers a crashed decoder.
 */
export async function extractImagePalette(imagePath: string, options: { limitInputPixels?: number } = {}): Promise<PaletteColor[]> {
  return imageDecoder.palette(imagePath, options);
}
