/**
 * Task 377: the derivative pixel ceiling lives here so every consumer imports
 * the same number. derivative-processor.ts re-exports it (the worker's sharp
 * reads pass it as limitInputPixels), and the MCP server's asset_create uses
 * it to warn when an image exceeds it — without importing the processor
 * module itself, whose top-level useInProcessImageDecoder() call would flip
 * the host process's image decoder from the forked child to in-process mode.
 */
export const MAX_DERIVATIVE_INPUT_PIXELS = 40_000_000;
