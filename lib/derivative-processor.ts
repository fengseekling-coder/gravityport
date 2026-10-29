import { mkdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import sharp from "./sharp-runtime.js";
import { extractImagePalette, type PaletteColor } from "./image-palette.js";
import { computePerceptualHash } from "./perceptual-hash.js";
import {
  derivativeTempFileName,
  publishDerivativeFile,
  removeStaleDerivativeTempFiles,
} from "./derivative-temp-file.js";

const MAX_DERIVATIVE_INPUT_PIXELS = 40_000_000;

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
  const sharpInputOptions = { animated: false, limitInputPixels: MAX_DERIVATIVE_INPUT_PIXELS } as const;
  const metadata = await sharp(job.original_path, sharpInputOptions).metadata();
  const orientation = Number(metadata.orientation) || 1;
  const swapsAxes = orientation >= 5 && orientation <= 8;
  const width = swapsAxes ? Number(metadata.height) : Number(metadata.width);
  const height = swapsAxes ? Number(metadata.width) : Number(metadata.height);

  // Write every derivative to a temp file first, then rename them into place
  // only once all three encoded successfully. If anything fails, this run's
  // temp files are removed so the previous complete finals stay untouched.
  const staged = targets.map((target) => ({
    ...target,
    tempPath: join(dirname(target.finalPath), derivativeTempFileName(basename(target.finalPath))),
  }));
  try {
    for (const target of staged) {
      await sharp(job.original_path, sharpInputOptions).rotate().resize({ width: target.size, height: target.size, fit: "inside", withoutEnlargement: true }).webp({ quality: target.quality }).toFile(target.tempPath);
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
    palette,
    perceptualHash,
    processorPid: process.pid,
  };
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
