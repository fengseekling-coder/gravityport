// Task 413: macOS's system image tool (/usr/bin/sips) covers what sharp's
// bundled libheif cannot — decoding HEVC-coded HEIC/HEIF (the iPhone photo
// container) and reporting dimensions for files sharp fails to open. Both
// helpers run sips via execFile (never a shell) with a hard timeout so a
// wedged sips cannot stall a derivative job or an import; callers decide the
// failure policy (derivative task fails, import dimension stays unknown).

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";

const SIPS_BINARY = "/usr/bin/sips";
const SIPS_TIMEOUT_MS = 60000;

const HEIC_EXTENSIONS = new Set([".heic", ".heif"]);

/** True for the HEIC/HEIF container extensions (case-insensitive). */
export function isHeicExtension(extension) {
  return HEIC_EXTENSIONS.has(String(extension || "").toLowerCase());
}

/**
 * Decodes any ImageIO-readable image into a PNG at outPath. For a HEIC with
 * an orientation marker the PNG keeps that marker as EXIF orientation, so the
 * downstream sharp pipeline (.rotate() + orientedImageDimensions) still
 * displays the picture upright — verified in task 413 with an
 * Orientation=6 HEIC converted back and forth through sips.
 */
export function convertHeicToPngWithSips(sourcePath, outPath) {
  return new Promise((resolveConvert, rejectConvert) => {
    execFile(SIPS_BINARY, ["-s", "format", "png", sourcePath, "--out", outPath], { timeout: SIPS_TIMEOUT_MS }, (error, _stdout, stderr) => {
      if (error) {
        rejectConvert(new Error(`sips conversion failed for ${sourcePath}: ${String(stderr || error.message).trim()}`, { cause: error }));
        return;
      }
      resolveConvert();
    });
  });
}

/**
 * Width/height for an image sharp cannot open, from sips's property read
 * (header only — no pixel decode). Returns null when sips cannot read the
 * file either. EXIF orientations 5-8 mean the pixels are stored rotated, so
 * the display dimensions swap — the same swap orientedImageDimensions applies
 * to sharp metadata. A HEIC whose rotation lives in the HEIF irot property
 * reports orientation <nil> to sips, so its stored (pre-swap) pixel size
 * comes back; the derivative pass writes the upright ratio later.
 */
export async function readImageDimensionsWithSips(filePath) {
  const stdout = await new Promise((resolveRead, rejectRead) => {
    execFile(SIPS_BINARY, ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "orientation", filePath], { timeout: SIPS_TIMEOUT_MS }, (error, out, stderr) => {
      if (error) {
        rejectRead(new Error(`sips dimensions failed for ${filePath}: ${String(stderr || error.message).trim()}`, { cause: error }));
        return;
      }
      resolveRead(String(out || ""));
    });
  }).catch(() => null);
  if (!stdout) return null;
  const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1]);
  const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  // "orientation: <nil>" (no marker) or "orientation: 1" both read as 1.
  const orientation = Number(/orientation:\s*(\d+)/.exec(stdout)?.[1]) || 1;
  const swapsAxes = orientation >= 5 && orientation <= 8;
  return swapsAxes ? { width: height, height: width } : { width, height };
}

/** True when the sips binary is present (macOS ships it; other platforms never do). */
export async function sipsAvailable() {
  if (process.platform !== "darwin") return false;
  try {
    await access(SIPS_BINARY);
    return true;
  } catch {
    return false;
  }
}
