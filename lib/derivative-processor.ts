import { mkdir, open, unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import sharp from "./sharp-runtime.js";
import { orientedImageDimensions } from "./image-dimensions.js";
import { extractImagePalette, type PaletteColor } from "./image-palette.js";
import { computePerceptualHash } from "./perceptual-hash.js";
import { useInProcessImageDecoder } from "./image-decode-client.js";
import { convertHeicToPngWithSips, isHeicExtension } from "./sips-image-support.mjs";
import {
  derivativeTempFileName,
  publishDerivativeFile,
  removeStaleDerivativeTempFiles,
} from "./derivative-temp-file.js";
import { derivativeTiersRunInParallel, MAX_DERIVATIVE_INPUT_PIXELS } from "./derivative-limits.js";

export { MAX_DERIVATIVE_INPUT_PIXELS };

// This file IS the disposable image process (task 341): sharp already runs
// outside the MOSA runtime here, so its palette/perceptual-hash calls must
// decode in-process instead of forking a decoder grandchild.
useInProcessImageDecoder();

interface DerivativeProcessorJob {
  original_path: string;
  previewPath: string;
  mediumPath: string;
  thumbnailPath: string;
}

interface DerivativeProcessorRequest {
  type: "process-derivative";
  requestId: string;
  job: DerivativeProcessorJob;
}

interface ElectronParentPort {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

function normalizeJob(value: unknown): DerivativeProcessorJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Derivative processor received an invalid job.");
  }
  const input = value as Record<string, unknown>;
  const job = {
    original_path: String(input.original_path || "").trim(),
    previewPath: String(input.previewPath || "").trim(),
    mediumPath: String(input.mediumPath || "").trim(),
    thumbnailPath: String(input.thumbnailPath || "").trim(),
  };
  if (!job.original_path || !job.previewPath || !job.mediumPath || !job.thumbnailPath) {
    throw new Error("Derivative processor job paths are incomplete.");
  }
  return job;
}

// Task 412: the derivatives themselves stay still (first frame only), but the
// result records whether the ORIGINAL animates, so the viewer plays it in
// full and gallery cards can play it on hover. Every probe below only reads
// metadata or a few header bytes — never decoded pixels.
interface AnimationProbe {
  animated: boolean;
  /** Frames when the file format states them (GIF/WebP pages, APNG num_frames); null when the format does not (AVIF) or the probe failed. */
  frameCount: number | null;
}

const STILL_IMAGE: AnimationProbe = { animated: false, frameCount: 1 };
const PROBE_FAILED: AnimationProbe = { animated: false, frameCount: null };
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// sharp cannot read an APNG's later frames, so the answer comes from the chunk
// stream instead: acTL placed before the first IDAT marks an animation, and
// acTL's first big-endian word is num_frames (PNG/APNG spec). The scan stops
// at the first IDAT — never the whole file.
async function detectApngFrames(filePath: string): Promise<AnimationProbe> {
  const handle = await open(filePath, "r");
  try {
    const signature = Buffer.alloc(PNG_SIGNATURE.length);
    if ((await handle.read(signature, 0, signature.length, 0)).bytesRead < signature.length || !signature.equals(PNG_SIGNATURE)) {
      throw new Error("PNG file header is missing.");
    }
    const chunkHeader = Buffer.alloc(8);
    let offset = signature.length;
    for (;;) {
      if ((await handle.read(chunkHeader, 0, 8, offset)).bytesRead < 8) throw new Error("PNG chunk header is truncated.");
      const chunkLength = chunkHeader.readUInt32BE(0);
      const chunkType = chunkHeader.toString("latin1", 4, 8);
      if (chunkType === "acTL") {
        if (chunkLength < 8) throw new Error("acTL chunk is truncated.");
        const framesField = Buffer.alloc(4);
        if ((await handle.read(framesField, 0, 4, offset + 8)).bytesRead < 4) throw new Error("acTL chunk is truncated.");
        return { animated: true, frameCount: framesField.readUInt32BE(0) };
      }
      if (chunkType === "IDAT") return STILL_IMAGE;
      offset += 8 + chunkLength + 4;
    }
  } finally {
    await handle.close();
  }
}

// An AVIF image sequence advertises itself with the "avis" brand — in ftyp's
// main brand or its compatible-brands list. The box is tiny; one read covers it.
async function detectAvifSequence(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const head = Buffer.alloc(64);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (bytesRead < 16 || head.readUInt32BE(0) < 16 || head.toString("latin1", 4, 8) !== "ftyp") {
      throw new Error("AVIF ftyp box is missing.");
    }
    const boxEnd = Math.min(head.readUInt32BE(0), bytesRead);
    if (head.toString("latin1", 8, 12) === "avis") return true;
    for (let offset = 16; offset + 4 <= boxEnd; offset += 4) {
      if (head.toString("latin1", offset, offset + 4) === "avis") return true;
    }
    return false;
  } finally {
    await handle.close();
  }
}

// Exported for the animation-probe tests: the error cases here (truncated
// headers) have no representation as a decodable file, so generateDerivatives
// could never run them through the real worker path.
export async function detectAnimation(filePath: string, metadata: { pages?: number }): Promise<AnimationProbe> {
  const extension = extname(filePath).toLowerCase();
  try {
    if (extension === ".gif" || extension === ".webp") {
      // metadata() was already read above with the same limitInputPixels
      // option; `pages` carries the frame count without any extra decode.
      const pages = metadata.pages;
      return Number.isFinite(pages) && (pages as number) > 1
        ? { animated: true, frameCount: pages as number }
        : STILL_IMAGE;
    }
    if (extension === ".apng" || extension === ".png") return await detectApngFrames(filePath);
    if (extension === ".avif") {
      return await detectAvifSequence(filePath) ? { animated: true, frameCount: null } : STILL_IMAGE;
    }
    return STILL_IMAGE;
  } catch {
    // A probe error (unreadable header, truncated file) must never fail the
    // derivative job: report "not animated, frames unknown" and move on.
    return PROBE_FAILED;
  }
}

async function generateDerivatives(job: DerivativeProcessorJob) {
  await Promise.all([
    mkdir(dirname(job.previewPath), { recursive: true }),
    mkdir(dirname(job.mediumPath), { recursive: true }),
    mkdir(dirname(job.thumbnailPath), { recursive: true }),
  ]);
  const targets = [
    { finalPath: job.thumbnailPath, size: 400, quality: 78 },
    { finalPath: job.mediumPath, size: 960, quality: 82 },
    { finalPath: job.previewPath, size: 1600, quality: 84 },
  ];
  await removeStaleDerivativeTempFiles(
    targets.map((target) => dirname(target.finalPath)),
    targets.map((target) => basename(target.finalPath)),
  );
  // Task 413: sharp's libheif cannot decode the HEVC coding inside iPhone
  // HEIC/HEIF files. On macOS the system sips converts the original into a
  // temporary PNG (same directory and naming rules as the derivative temp
  // files, removed on success and on failure alike) and the whole sharp
  // pipeline below runs on that PNG — sips keeps the orientation marker as
  // EXIF orientation, so .rotate() and orientedImageDimensions stay correct.
  // Elsewhere there is no sips and the sharp open fails, failing the job as
  // before; the import gate already refuses HEIC there.
  let decodePath = job.original_path;
  let heicTempPng: string | null = null;
  if (isHeicExtension(extname(job.original_path).toLowerCase()) && process.platform === "darwin") {
    heicTempPng = join(dirname(job.previewPath), derivativeTempFileName("heic-decode.png"));
    try {
      await convertHeicToPngWithSips(job.original_path, heicTempPng);
      decodePath = heicTempPng;
    } catch (error) {
      await unlink(heicTempPng).catch(() => {});
      throw error;
    }
  }
  try {
    const sharpInputOptions = { animated: false, limitInputPixels: MAX_DERIVATIVE_INPUT_PIXELS, sequentialRead: true } as const;
    const metadata = await sharp(decodePath, sharpInputOptions).metadata();
    // Task 292: createAsset reads the same dimensions at import time through
    // this shared helper; both write-backs must agree or each card would jump
    // between ratios twice.
    const { width, height } = orientedImageDimensions(metadata);
    const animation = await detectAnimation(job.original_path, metadata);

    // Write every derivative to a temp file first, then rename them into place
    // only once all three encoded successfully. If anything fails, this run's
    // temp files are removed so the previous complete finals stay untouched.
    const staged = targets.map((target) => ({
      ...target,
      tempPath: join(dirname(target.finalPath), derivativeTempFileName(basename(target.finalPath))),
    }));
    try {
      const encodeTier = (target: (typeof staged)[number]) =>
        sharp(decodePath, sharpInputOptions).rotate().resize({ width: target.size, height: target.size, fit: "inside", withoutEnlargement: true }).webp({ quality: target.quality }).toFile(target.tempPath);
      if (derivativeTiersRunInParallel(Number(metadata.width), Number(metadata.height))) {
        // Task 453: typical images encode all three tiers concurrently (each
        // tier decodes the original itself). A failing tier must not rush the
        // cleanup below while the other two are still writing temp files, so
        // every tier is settled first and only then the first error is
        // rethrown; oversized images keep the sequential loop above the cap.
        const settled = await Promise.allSettled(staged.map((target) => encodeTier(target)));
        const failure = settled.find((outcome) => outcome.status === "rejected");
        if (failure && failure.status === "rejected") throw failure.reason;
      } else {
        for (const target of staged) {
          await encodeTier(target);
        }
      }
      for (const target of staged) {
        await publishDerivativeFile(target.tempPath, target.finalPath);
      }
    } catch (error) {
      await Promise.all(staged.map((target) => unlink(target.tempPath).catch(() => {})));
      throw error;
    }

    // Palette rides along with successful derivatives, computed from the just
    // published 400px thumbnail. It must never fail the derivative job: the
    // extractor already returns [] instead of throwing, and this guard keeps a
    // surprise error in it cosmetic as well.
    let palette: PaletteColor[] = [];
    try {
      palette = await extractImagePalette(job.thumbnailPath);
    } catch {
      palette = [];
    }

    // The perceptual hash rides along the same way, from the same thumbnail, so
    // manual-import dedupe never has to decode the original again.
    let perceptualHash = "";
    try {
      perceptualHash = await computePerceptualHash(job.thumbnailPath);
    } catch {
      perceptualHash = "";
    }

    return {
      previewPath: job.previewPath,
      mediumPath: job.mediumPath,
      thumbnailPath: job.thumbnailPath,
      width,
      height,
      animated: animation.animated,
      frameCount: animation.frameCount,
      palette,
      perceptualHash,
      processorPid: process.pid,
    };
  } finally {
    if (heicTempPng) await unlink(heicTempPng).catch(() => {});
  }
}

function sendToParent(message: unknown) {
  const electronPort = (process as NodeJS.Process & { parentPort?: ElectronParentPort | null }).parentPort;
  if (electronPort) {
    electronPort.postMessage(message);
    return;
  }
  if (typeof process.send === "function") process.send(message);
}

async function handleMessage(message: unknown) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  const request = message as Partial<DerivativeProcessorRequest>;
  if (request.type !== "process-derivative" || typeof request.requestId !== "string" || !request.requestId) return;
  try {
    const result = await generateDerivatives(normalizeJob(request.job));
    sendToParent({ type: "derivative-result", requestId: request.requestId, ok: true, result });
  } catch (error) {
    sendToParent({
      type: "derivative-result",
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const electronPort = (process as NodeJS.Process & { parentPort?: ElectronParentPort | null }).parentPort;
if (electronPort) {
  electronPort.on("message", (event) => { void handleMessage(event.data); });
} else {
  process.on("message", (message) => { void handleMessage(message); });
}
