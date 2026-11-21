/**
 * Task 377: the derivative pixel ceiling lives here so every consumer imports
 * the same number. derivative-processor.ts re-exports it (the worker's sharp
 * reads pass it as limitInputPixels), and the MCP server's asset_create uses
 * it to warn when an image exceeds it — without importing the processor
 * module itself, whose top-level useInProcessImageDecoder() call would flip
 * the host process's image decoder from the forked child to in-process mode.
 */
// Task 380: raised to sharp's default ceiling (16383 * 16383) so large
// upscaled images still receive thumbnails and previews.
export const MAX_DERIVATIVE_INPUT_PIXELS = 268_402_689;

// Task 453: above this pixel count the three tiers still run one at a time.
// Encoding all three tiers concurrently raises sharp's peak memory to roughly
// 1.5-2.5x the sequential run (measured on the reference machine: 2048x2048
// PNG 57 -> 77 MB, 4096x4096 JPEG 76 -> 113 MB, 4096x4096 PNG 67 -> 157 MB,
// 8192x8192 JPEG 82 -> 207 MB), so oversized images keep the sequential path
// and the worst-case extra memory stays bounded even with the app's two
// concurrent derivative workers (DEFAULT_CONCURRENCY = 2 in
// derivative-worker.ts).
export const PARALLEL_DERIVATIVE_TIER_MAX_PIXELS = 40_000_000;

export function derivativeTiersRunInParallel(width: number, height: number): boolean {
  return (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0 &&
    width * height <= PARALLEL_DERIVATIVE_TIER_MAX_PIXELS
  );
}
