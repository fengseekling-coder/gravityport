// Media byte inspection and capture temp-file checks moved out of web-capture-ingest.ts (task 410). Pure moves; no behavior changes.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { imageDecoder } from "../image-decode-client.js";
import { safePixelDigest } from "../image-pixel-hash.js";
import { WEB_CAPTURE_MAX_IMAGE_PIXELS } from "./limits.js";
import type { WebCaptureInput } from "./types.js";

export function webCaptureError(message: string, statusCode: number, code: string): Error & { statusCode: number; code: string } {
  const error = new Error(message) as Error & { statusCode: number; code: string };
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

export async function inspectImageBytes(imageBytes: Buffer): Promise<{ format: string; width: number; height: number; pixelHash: string }> {
  try {
    const metadata = await imageDecoder.metadata(imageBytes, {
      failOn: "error",
      limitInputPixels: WEB_CAPTURE_MAX_IMAGE_PIXELS,
    });
    const width = Number(metadata.width) || 0;
    const height = Number(metadata.height) || 0;
    const pages = Number(metadata.pages) || 1;
    const frameHeight = Number(metadata.pageHeight) || height;
    const totalPixels = width * frameHeight * pages;
    if (!width || !height || totalPixels > WEB_CAPTURE_MAX_IMAGE_PIXELS) {
      throw webCaptureError(
        "Image exceeds " + WEB_CAPTURE_MAX_IMAGE_PIXELS.toLocaleString("en-US") + " pixel limit.",
        413,
        "WEB_CAPTURE_PIXEL_LIMIT",
      );
    }
    return {
      format: String(metadata.format || ""),
      width,
      height: frameHeight,
      pixelHash: await safePixelDigest(imageBytes, { limitInputPixels: WEB_CAPTURE_MAX_IMAGE_PIXELS }),
    };
  } catch (error: unknown) {
    if ((error as { code?: string })?.code === "WEB_CAPTURE_PIXEL_LIMIT") throw error;
    const detail = error instanceof Error ? error.message : String(error);
    if (/pixel limit|exceeds.*pixels|input image exceeds/i.test(detail)) {
      throw webCaptureError(
        "Image exceeds " + WEB_CAPTURE_MAX_IMAGE_PIXELS.toLocaleString("en-US") + " pixel limit.",
        413,
        "WEB_CAPTURE_PIXEL_LIMIT",
      );
    }
    throw webCaptureError(
      "Image bytes are invalid, truncated, or exceed the decoded pixel limit.",
      400,
      "WEB_CAPTURE_BAD_IMAGE_BYTES",
    );
  }
}

export function decodeImageBytes(input: WebCaptureInput): Buffer {
  if (Buffer.isBuffer(input.imageBytes)) return input.imageBytes;
  if (input.imageBytes instanceof Uint8Array) return Buffer.from(input.imageBytes);
  let raw = String(input.imageBase64 || input.image_base64 || "").trim(); if (!raw) return Buffer.alloc(0);
  const dataUrl = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(raw); if (dataUrl) raw = dataUrl[1];
  try { return Buffer.from(raw, "base64"); } catch { return Buffer.alloc(0); }
}

export function decodeMediaBytes(input: WebCaptureInput): Buffer {
  if (Buffer.isBuffer(input.mediaBytes)) return input.mediaBytes;
  if (input.mediaBytes instanceof Uint8Array) return Buffer.from(input.mediaBytes);
  let raw = String(input.mediaBase64 || input.media_base64 || "").trim();
  if (!raw) return Buffer.alloc(0);
  const dataUrl = /^data:video\/[a-z0-9.+-]+;base64,(.+)$/i.exec(raw);
  if (dataUrl) raw = dataUrl[1];
  try { return Buffer.from(raw, "base64"); } catch { return Buffer.alloc(0); }
}

export function assertVideoContainer(bytes: Buffer, mimeType: string): void {
  const header = bytes.subarray(0, 32);
  if (mimeType === "video/webm") {
    if (header.length < 4 || header[0] !== 0x1a || header[1] !== 0x45 || header[2] !== 0xdf || header[3] !== 0xa3) {
      throw webCaptureError("Video bytes do not match WebM container.", 400, "WEB_CAPTURE_MIME_MISMATCH");
    }
    return;
  }
  if (["video/mp4", "video/quicktime", "video/x-m4v"].includes(mimeType)) {
    const marker = header.subarray(4, 12).toString("ascii");
    if (!marker.includes("ftyp")) {
      throw webCaptureError("Video bytes do not match ISO BMFF container.", 400, "WEB_CAPTURE_MIME_MISMATCH");
    }
  }
}

export function normalizeMediaMetric(value: unknown, max: number, allowFraction = false): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > max) return 0;
  return allowFraction ? number : Math.round(number);
}

export async function inspectTrustedCaptureTempFile(tempRoot: string, mediaFilePath: string): Promise<{ path: string; size: number; header: Buffer }> {
  const root = resolve(tempRoot);
  const path = resolve(mediaFilePath);
  if (path === root || !path.startsWith(`${root}${sep}`)) {
    throw webCaptureError("Uploaded media path is outside the Web Capture temp directory.", 400, "WEB_CAPTURE_UPLOAD_PATH_INVALID");
  }
  const info = await lstat(path).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink()) {
    throw webCaptureError("Uploaded media file is unavailable.", 400, "WEB_CAPTURE_UPLOAD_FILE_INVALID");
  }
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return { path, size: info.size, header: header.subarray(0, bytesRead) };
  } finally {
    await handle.close();
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function sanitizeStoredMediaUrl(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return "";
    const retained = new URLSearchParams();
    for (const key of ["id", "cid", "name", "asset_id", "assetId", "media_id", "mediaId"]) {
      const entry = url.searchParams.get(key);
      if (entry) retained.set(key, entry.slice(0, 512));
    }
    url.search = retained.toString();
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}
