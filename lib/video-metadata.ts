/**
 * Minimal ISO BMFF (MP4/MOV) header reader for video width, height and
 * duration. Only box headers and the moov bodies (mvhd/tkhd/hdlr) are read —
 * a 25 MB file costs a handful of small reads — so the moov may sit at the
 * front (faststart) or the tail. No npm dependencies and no external
 * processes: machines running GravityPort do not have ffmpeg.
 *
 * Every entry returns null instead of throwing: WebM (EBML), truncated files,
 * audio-only containers and anything else unreadable simply have no metadata,
 * and callers fall back to capture-supplied values.
 */

import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export interface VideoMetadata {
  width: number;
  height: number;
  /** Presentation duration in seconds from mvhd; null when absent. */
  durationSeconds: number | null;
}

type BoxReader = (offset: number, length: number) => Buffer | null;

interface BoxHeader {
  type: string;
  headerSize: number;
  contentStart: number;
  contentEnd: number;
}

const CONTAINER_BOXES = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts"]);
const MAX_BOX_DEPTH = 8;
const FIXED_POINT_ONE = 65536;
// moov is one index entry per media chunk; a few MB covers hours-long files.
// Beyond this the file is treated as unreadable rather than buffered whole.
const MAX_MOOV_BYTES = 64 * 1024 * 1024;

interface ParseContext {
  durationSeconds: number | null;
  videoWidth: number;
  videoHeight: number;
}

/**
 * Reads metadata from a file. Locates the moov box by walking top-level box
 * headers (a few awaited reads), then parses the moov bytes in memory.
 */
export async function readVideoMetadataFromFile(filePath: string): Promise<VideoMetadata | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(filePath, "r");
    const size = (await handle.stat()).size;
    const moov = await locateMoovBox(handle, size);
    if (!moov || moov.size < 8 || moov.size > MAX_MOOV_BYTES) return null;
    const buffer = Buffer.alloc(moov.size);
    const { bytesRead } = await handle.read(buffer, 0, moov.size, moov.offset);
    if (bytesRead !== moov.size) return null;
    return readVideoMetadataFromBuffer(buffer);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** In-memory variant with the same parsing rules. Accepts a whole file or just its moov. */
export function readVideoMetadataFromBuffer(bytes: Buffer | Uint8Array): VideoMetadata | null {
  try {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const read: BoxReader = (offset, length) =>
      offset >= 0 && length > 0 && offset + length <= buffer.length ? buffer.subarray(offset, offset + length) : null;
    return parseVideoMetadata(read, buffer.length);
  } catch {
    return null;
  }
}

/** Synchronous file variant for store passes that run inside SQLite transactions. */
export function readVideoMetadataFromFileSync(filePath: string): VideoMetadata | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const size = fstatSync(fd).size;
    const read: BoxReader = (offset, length) => {
      if (offset < 0 || length <= 0 || offset + length > size) return null;
      const buffer = Buffer.alloc(length);
      return readSync(fd!, buffer, 0, length, offset) === length ? buffer : null;
    };
    return parseVideoMetadata(read, size);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Already closed or never opened — nothing to clean up.
      }
    }
  }
}

/**
 * Walks the box tree depth-first. Container boxes are recursed into, leaf
 * boxes are skipped by size; mvhd/tkhd/hdlr bodies are the only leaf contents
 * ever read.
 */
function parseVideoMetadata(read: BoxReader, size: number): VideoMetadata | null {
  const context: ParseContext = { durationSeconds: null, videoWidth: 0, videoHeight: 0 };
  walkBoxes(read, 0, size, 0, context);
  if (context.videoWidth <= 0 || context.videoHeight <= 0) return null;
  return { width: context.videoWidth, height: context.videoHeight, durationSeconds: context.durationSeconds };
}

function readBoxHeader(read: BoxReader, offset: number, end: number): BoxHeader | null {
  const header = read(offset, 8);
  if (!header || header.length < 8) return null;
  let boxSize = header.readUInt32BE(0);
  const type = header.toString("latin1", 4, 8);
  let headerSize = 8;
  if (boxSize === 1) {
    const large = read(offset + 8, 8);
    if (!large || large.length < 8) return null;
    boxSize = large.readUInt32BE(0) * 2 ** 32 + large.readUInt32BE(4);
    headerSize = 16;
  } else if (boxSize === 0) {
    boxSize = end - offset;
  }
  if (boxSize < headerSize) return null;
  return {
    type,
    headerSize,
    contentStart: offset + headerSize,
    contentEnd: Math.min(offset + boxSize, end),
  };
}

function walkBoxes(read: BoxReader, start: number, end: number, depth: number, context: ParseContext): void {
  let offset = start;
  while (offset + 8 <= end) {
    const box = readBoxHeader(read, offset, end);
    if (!box) return;
    if (box.type === "trak") {
      parseVideoTrack(read, box.contentStart, box.contentEnd, context);
    } else if (CONTAINER_BOXES.has(box.type) && depth < MAX_BOX_DEPTH) {
      walkBoxes(read, box.contentStart, box.contentEnd, depth + 1, context);
    } else if (box.type === "mvhd") {
      const body = read(box.contentStart, Math.min(box.contentEnd - box.contentStart, 32));
      if (body) context.durationSeconds = parseMovieHeader(body) ?? context.durationSeconds;
    }
    offset += box.contentEnd - box.contentStart + box.headerSize;
  }
}

/** One trak: keep its dimensions only when its mdia.hdlr handler is `vide`. */
function parseVideoTrack(read: BoxReader, start: number, end: number, context: ParseContext): void {
  let offset = start;
  let width = 0;
  let height = 0;
  let isVideo = false;
  while (offset + 8 <= end) {
    const box = readBoxHeader(read, offset, end);
    if (!box) return;
    if (box.type === "tkhd") {
      const body = read(box.contentStart, Math.min(box.contentEnd - box.contentStart, 96));
      const dimensions = body ? parseTrackHeader(body) : null;
      if (dimensions) {
        width = dimensions.width;
        height = dimensions.height;
      }
    } else if (box.type === "mdia" && readHandlerType(read, box.contentStart, box.contentEnd) === "vide") {
      isVideo = true;
    }
    offset += box.contentEnd - box.contentStart + box.headerSize;
  }
  if (isVideo && width > 0 && height > 0 && context.videoWidth <= 0) {
    context.videoWidth = width;
    context.videoHeight = height;
  }
}

function readHandlerType(read: BoxReader, start: number, end: number): string {
  let offset = start;
  while (offset + 8 <= end) {
    const box = readBoxHeader(read, offset, end);
    if (!box) return "";
    if (box.type === "hdlr") {
      const body = read(box.contentStart, Math.min(box.contentEnd - box.contentStart, 12));
      return body && body.length >= 12 ? body.toString("latin1", 8, 12) : "";
    }
    offset += box.contentEnd - box.contentStart + box.headerSize;
  }
  return "";
}

async function locateMoovBox(handle: FileHandle, size: number): Promise<{ offset: number; size: number } | null> {
  const readAt = async (offset: number, length: number): Promise<Buffer | null> => {
    if (offset < 0 || length <= 0 || offset + length > size) return null;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return bytesRead === length ? buffer : null;
  };
  let offset = 0;
  while (offset + 8 <= size) {
    const header = await readAt(offset, 8);
    if (!header) return null;
    let boxSize = header.readUInt32BE(0);
    const type = header.toString("latin1", 4, 8);
    let headerSize = 8;
    if (boxSize === 1) {
      const large = await readAt(offset + 8, 8);
      if (!large) return null;
      boxSize = Number(large.readBigUInt64BE(0));
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = size - offset;
    }
    if (boxSize < headerSize) return null;
    if (type === "moov") {
      return { offset: offset + headerSize, size: Math.min(boxSize - headerSize, size - offset - headerSize) };
    }
    offset += boxSize;
  }
  return null;
}

/** mvhd body: version 0 (u32 fields) and version 1 (u64 fields). */
function parseMovieHeader(body: Buffer): number | null {
  const version = body[0];
  if (version === 1) {
    if (body.length < 32) return null;
    const timescale = body.readUInt32BE(20);
    const durationBig = body.readBigUInt64BE(24);
    const duration = durationBig <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(durationBig) : null;
    return durationToSeconds(timescale, duration);
  }
  if (body.length < 20) return null;
  const timescale = body.readUInt32BE(12);
  const duration = body.readUInt32BE(16);
  // 0xFFFFFFFF marks "unknown duration" in version 0 boxes.
  return durationToSeconds(timescale, duration === 0xffffffff ? null : duration);
}

function durationToSeconds(timescale: number, duration: number | null): number | null {
  if (!timescale || duration === null || duration <= 0) return null;
  const seconds = duration / timescale;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** tkhd body: width/height are 16.16 fixed point; a 90°/270° rotation matrix
 * stores the unrotated track size, so portrait phone recordings must swap. */
function parseTrackHeader(body: Buffer): { width: number; height: number } | null {
  const version = body[0];
  const dimensionsStart = version === 1 ? 88 : 76;
  const matrixStart = version === 1 ? 52 : 40;
  if (body.length < dimensionsStart + 8) return null;
  let width = body.readUInt32BE(dimensionsStart) / FIXED_POINT_ONE;
  let height = body.readUInt32BE(dimensionsStart + 4) / FIXED_POINT_ONE;
  const a = body.readInt32BE(matrixStart) / FIXED_POINT_ONE;
  const b = body.readInt32BE(matrixStart + 4) / FIXED_POINT_ONE;
  const c = body.readInt32BE(matrixStart + 12) / FIXED_POINT_ONE;
  const d = body.readInt32BE(matrixStart + 16) / FIXED_POINT_ONE;
  const near = (value: number, target: number) => Math.abs(value - target) < 0.01;
  if (near(a, 0) && near(d, 0) && (near(b, 1) || near(b, -1)) && (near(c, 1) || near(c, -1))) {
    [width, height] = [height, width];
  }
  width = Math.round(width);
  height = Math.round(height);
  return width > 0 && height > 0 ? { width, height } : null;
}
