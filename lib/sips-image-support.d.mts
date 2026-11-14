/**
 * Type surface of lib/sips-image-support.mjs consumed from TypeScript sources
 * (derivative-processor.ts). Hand-maintained like library-location.d.mts: the
 * .mjs module is plain JavaScript by design.
 */

/** True for the HEIC/HEIF container extensions (case-insensitive). */
export declare function isHeicExtension(extension: unknown): boolean;
/** Decodes any ImageIO-readable image into a PNG at outPath (execFile, 60s timeout). */
export declare function convertHeicToPngWithSips(sourcePath: string, outPath: string): Promise<void>;
/** Width/height from sips, orientation 5-8 swapped; null when sips cannot read the file. */
export declare function readImageDimensionsWithSips(filePath: string): Promise<{ width: number; height: number } | null>;
/** True when the sips binary is present (macOS only). */
export declare function sipsAvailable(): Promise<boolean>;
