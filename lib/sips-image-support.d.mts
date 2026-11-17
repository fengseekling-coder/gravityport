/**
 * Type surface of lib/sips-image-support.mjs consumed from TypeScript sources
 * (derivative-processor.ts). Hand-maintained like library-location.d.mts: the
 * .mjs module is plain JavaScript by design.
 */

/** True for the HEIC/HEIF container extensions (case-insensitive). */
export declare function isHeicExtension(extension: unknown): boolean;
/** Decodes any ImageIO-readable image into a PNG at outPath (execFile, 60s timeout). */
export declare function convertHeicToPngWithSips(sourcePath: string, outPath: string): Promise<void>;
/** Width/height from sips; EXIF orientations 5-8 swapped, and a .heic/.heif with no EXIF orientation gets the HEIF irot angles 1/3 swapped too (task 424); null when sips cannot read the file. */
export declare function readImageDimensionsWithSips(filePath: string): Promise<{ width: number; height: number } | null>;
/** The HEIF primary item's irot angle 0-3 from the file head bytes (0 when no irot is associated, null when the bytes do not parse; never throws). */
export declare function heifPrimaryRotation(bytes: Buffer | Uint8Array): 0 | 1 | 2 | 3 | null;
/** True when the sips binary is present (macOS only). */
export declare function sipsAvailable(): Promise<boolean>;
