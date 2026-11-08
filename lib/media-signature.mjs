import { open } from "node:fs/promises";

import { assetStoreError } from "./asset-version-history.mjs";
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from "./library-location.mjs";

// Task 366: the import path used to trust the file extension alone, so plain
// text saved as "fake.png" became a card that could never render (task 364
// acceptance). This module reads the head of the source file and checks the
// bytes against the real format signatures before an asset is created. Only
// the media class is checked (image extensions must hold image bytes, video
// extensions must hold video bytes) — an extension/content mismatch inside a
// class stays accepted, because many sites store PNG bytes under .jpg names.

/**
 * How many leading bytes are read from a file. SVG detection needs a small
 * text window (libmagic searches the first 4096 bytes for the svg root
 * element); every binary signature below fits far inside it.
 */
const SNIFF_LIMIT = 4096;

/** The EBML DocType string sits within the first bytes of every WebM/Matroska file. */
const EBML_DOCTYPE_WINDOW = 64;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Task 377: a complete PNG stream ends with the IEND chunk — length 0, the
// four "IEND" bytes, and the chunk CRC (PNG spec, ISO/IEC 15948 §5.3). Files
// whose bytes stop short of it were cut off mid-transfer and fail halfway
// through every decode, so the store refuses them at the gate.
const PNG_IEND_TRAILER = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
// How far back from the end of a PNG the IEND trailer may sit.
const PNG_TAIL_WINDOW = 64 * 1024;
const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

/** ftyp brands that mean a still image (AVIF: ISO/IEC 14496-12 + AV1 Image File Format spec). */
const IMAGE_FTYP_BRANDS = new Set(["avif", "avis"]);

function isPng(buffer) {
  // APNG is a valid PNG stream, so one check covers both extensions. The PNG
  // signature must be followed by the IHDR chunk (PNG spec, ISO/IEC 15948
  // §5.2: the first chunk is always IHDR) — a file holding only the 8-byte
  // signature is rejected.
  return buffer.length >= 16
    && buffer.subarray(0, 8).equals(PNG_SIGNATURE)
    && buffer.readUInt32BE(8) === 13
    && buffer.toString("latin1", 12, 16) === "IHDR";
}

function isJpeg(buffer) {
  // SOI (FF D8 FF) followed by an APPn marker (JFIF/Exif SPIFF...), DQT, SOFn,
  // DRI, SOS or COM. Requiring 12 bytes keeps a 4-byte truncated header out;
  // real JFIF/Exif files carry a ≥12-byte application segment (JFIF spec §2).
  // COM (FF FE) first is real-world JPEG: ffmpeg ≥8 MJPEG writes its encoder
  // comment as the first segment when there is no JFIF header (task 366
  // rework 1). 00/FF filler bytes stay rejected.
  if (buffer.length < 12) return false;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) return false;
  const marker = buffer[3];
  return (marker >= 0xe0 && marker <= 0xef)
    || marker === 0xdb
    || (marker >= 0xc0 && marker <= 0xcf)
    || marker === 0xda
    || marker === 0xdd
    || marker === 0xfe;
}

function isGif(buffer) {
  if (buffer.length < 6) return false;
  const header = buffer.toString("latin1", 0, 6);
  return header === "GIF87a" || header === "GIF89a";
}

function isWebp(buffer) {
  // RIFF container with a WEBP form id (WebP container spec §2).
  return buffer.length >= 12
    && buffer.toString("latin1", 0, 4) === "RIFF"
    && buffer.toString("latin1", 8, 12) === "WEBP";
}

function isFtypBox(buffer) {
  return buffer.length >= 12 && buffer.toString("latin1", 4, 8) === "ftyp";
}

function ftypBrand(buffer) {
  return buffer.toString("latin1", 8, 12);
}

function isAvif(buffer) {
  return isFtypBox(buffer) && IMAGE_FTYP_BRANDS.has(ftypBrand(buffer));
}

function isVideoFtyp(buffer) {
  // Every ISO base media file that is not a still-image brand is a movie
  // container (mp4/mov/m4v brands: isom, iso2, mp41/mp42, qt  , M4V , ...).
  // Media extensions only contain these families, so an unknown movie brand
  // stays accepted while image brands never pass as video.
  return isFtypBox(buffer) && !IMAGE_FTYP_BRANDS.has(ftypBrand(buffer));
}

function isWebm(buffer) {
  // EBML magic plus the Matroska/WebM DocType string (IETF CELLAR EBML spec;
  // matches what file(1) reports as "WebM" / "Matroska").
  if (buffer.length < 4 || !buffer.subarray(0, 4).equals(EBML_MAGIC)) return false;
  const head = buffer.toString("latin1", 0, Math.min(buffer.length, EBML_DOCTYPE_WINDOW));
  return head.includes("webm") || head.includes("matroska");
}

const SVG_MARKUP_OPENERS = ["<?xml", "<!--", "<svg"];
const SVG_TAG = Buffer.from("<svg", "latin1");

function isSvgText(buffer) {
  // SVG has no binary magic; it is XML text. Same rule file(1)/libmagic uses:
  // after an optional BOM and leading whitespace the file must open with an
  // XML declaration, a comment or the svg root tag, and an <svg element (the
  // tag followed by a name terminator) must appear inside the sniff window.
  let offset = 0;
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) offset = 3;
  while (offset < buffer.length
    && (buffer[offset] === 0x20 || buffer[offset] === 0x09 || buffer[offset] === 0x0d || buffer[offset] === 0x0a)) {
    offset += 1;
  }
  if (offset >= buffer.length) return false;
  const rest = buffer.toString("latin1", offset);
  if (!SVG_MARKUP_OPENERS.some((opener) => rest.startsWith(opener))) return false;
  return svgRootElementOffset(buffer, offset) !== -1;
}

/** Index of "<svg" followed by a tag terminator, searched inside the sniff window. */
function svgRootElementOffset(buffer, from) {
  const limit = Math.min(buffer.length, SNIFF_LIMIT);
  let at = from;
  while (at <= limit - SVG_TAG.length) {
    const found = buffer.indexOf(SVG_TAG, at);
    if (found === -1 || found > limit - SVG_TAG.length) return -1;
    const next = found + SVG_TAG.length;
    const follower = buffer[next];
    if (follower === 0x20 || follower === 0x09 || follower === 0x0d || follower === 0x0a
      || follower === 0x3e || follower === 0x2f) {
      return found;
    }
    at = found + 1;
  }
  return -1;
}

/**
 * "image", "video" or "" for the given file head. Exported for tests; the
 * stores only consume assertMediaSignature below.
 */
export function classifyMediaSignature(buffer) {
  if (isPng(buffer) || isJpeg(buffer) || isGif(buffer) || isWebp(buffer) || isAvif(buffer) || isSvgText(buffer)) return "image";
  if (isVideoFtyp(buffer) || isWebm(buffer)) return "video";
  return "";
}

function familyForExtension(extension) {
  const normalized = String(extension || "").toLowerCase();
  if (IMAGE_EXTENSIONS.has(normalized)) return "image";
  if (VIDEO_EXTENSIONS.has(normalized)) return "video";
  return "";
}

async function readSniffBuffer(handle) {
  const buffer = Buffer.alloc(SNIFF_LIMIT);
  const { bytesRead } = await handle.read(buffer, 0, SNIFF_LIMIT, 0);
  return bytesRead === SNIFF_LIMIT ? buffer : buffer.subarray(0, bytesRead);
}

/**
 * Task 377: a file whose head is a PNG stream must also end with the IEND
 * chunk somewhere in its last 64 KB (positioned read, never the whole
 * file); JPEG keeps no tail check — trailing metadata after EOI is common and
 * would falsely reject real files.
 */
async function assertPngComplete(handle) {
  const { size } = await handle.stat();
  if (size < PNG_IEND_TRAILER.length) throw imageFileIncompleteError();
  // Some tools append bytes after IEND (extra metadata, padding); those files
  // decode fine, so the trailer only has to appear somewhere in the tail
  // window. A file cut off mid-transfer never reached IEND at all.
  const windowSize = Math.min(size, PNG_TAIL_WINDOW);
  const tail = Buffer.alloc(windowSize);
  const { bytesRead } = await handle.read(tail, 0, windowSize, size - windowSize);
  if (tail.subarray(0, bytesRead).lastIndexOf(PNG_IEND_TRAILER) === -1) throw imageFileIncompleteError();
}

function imageFileIncompleteError() {
  return assetStoreError(
    "IMAGE_FILE_INCOMPLETE",
    `The image file is incomplete (it may have been cut off while downloading or copying).`,
  );
}

/**
 * Throws IMAGE_CONTENT_NOT_MEDIA unless the file's bytes look like the media
 * class its extension promises, and IMAGE_FILE_INCOMPLETE when those bytes are
 * a PNG stream that stops short of its IEND trailer. Called by both stores'
 * resolveReadableImagePath after the path checks; files the extension gate
 * already rejects never reach this read. A read error (the file vanished
 * between stat and open) propagates as-is so a vanished source is not
 * misreported as fake media.
 */
export async function assertMediaSignature(filePath, extension) {
  const family = familyForExtension(extension);
  if (!family) return; // Unregistered extensions are rejected earlier (IMAGE_PATH_UNSUPPORTED_TYPE).
  const handle = await open(filePath, "r");
  try {
    const buffer = await readSniffBuffer(handle);
    if (classifyMediaSignature(buffer) !== family) {
      throw assetStoreError(
        "IMAGE_CONTENT_NOT_MEDIA",
        `File content is not a supported image or video: ${filePath}`,
      );
    }
    if (isPng(buffer)) await assertPngComplete(handle);
  } finally {
    await handle.close();
  }
}
