// Task 413: macOS's system image tool (/usr/bin/sips) covers what sharp's
// bundled libheif cannot — decoding HEVC-coded HEIC/HEIF (the iPhone photo
// container) and reporting dimensions for files sharp fails to open. Both
// helpers run sips via execFile (never a shell) with a hard timeout so a
// wedged sips cannot stall a derivative job or an import; callers decide the
// failure policy (derivative task fails, import dimension stays unknown).

import { execFile } from "node:child_process";
import { access, open } from "node:fs/promises";
import { extname } from "node:path";

const SIPS_BINARY = "/usr/bin/sips";
const SIPS_TIMEOUT_MS = 60000;

const HEIC_EXTENSIONS = new Set([".heic", ".heif"]);

/** True for the HEIC/HEIF container extensions (case-insensitive). */
export function isHeicExtension(extension) {
  return HEIC_EXTENSIONS.has(String(extension || "").toLowerCase());
}

/**
 * Task 424: the primary item's irot angle for a HEIF file head. HEIC files
 * converted by macOS tools carry their rotation in the HEIF irot property
 * instead of EXIF, and `sips -g orientation` reports <nil> for those. This
 * reads the angle straight from the box structure — only the boxes on the
 * meta → pitm → iprp → ipco/ipma path (ISO/IEC 23008-12 + 14496-12). Returns
 * 0-3 (quarter turns counterclockwise), 0 when no irot is associated with
 * the primary item, null when the bytes do not parse (not HEIF, truncation,
 * a size beyond the data). Never throws.
 */
export function heifPrimaryRotation(bytes) {
  try {
    return parseHeifPrimaryRotation(bytes);
  } catch {
    return null;
  }
}

function u32At(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function u16At(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function boxTypeAt(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

// One box header at offset within [offset, limit): type and content range, or
// null when the header does not fit, the size is smaller than the header, or
// the box extends beyond the enclosing data. Size 0 means "to the end of the
// enclosing data"; size 1 promotes to the 8-byte largesize after the type.
function readBoxAt(bytes, offset, limit) {
  if (offset + 8 > limit) return null;
  let size = u32At(bytes, offset);
  let headerLength = 8;
  if (size === 1) {
    if (offset + 16 > limit) return null;
    // Sizes above 2^53 lose double precision, but they are rejected by the
    // limit check either way; real file heads stay far below.
    size = u32At(bytes, offset + 8) * 0x100000000 + u32At(bytes, offset + 12);
    headerLength = 16;
  } else if (size === 0) {
    size = limit - offset;
  }
  if (size < headerLength) return null;
  if (offset + size > limit) return null;
  return { type: boxTypeAt(bytes, offset + 4), start: offset + headerLength, end: offset + size, next: offset + size };
}

function findBox(bytes, start, end, type) {
  let offset = start;
  while (offset < end) {
    const box = readBoxAt(bytes, offset, end);
    if (!box) return null;
    if (box.type === type) return box;
    offset = box.next;
  }
  return null;
}

function parseHeifPrimaryRotation(bytes) {
  if (!bytes || typeof bytes.length !== "number") return null;
  const meta = findBox(bytes, 0, bytes.length, "meta");
  if (!meta) return null;
  // meta is a FullBox: version + flags sit between its header and its children.
  if (meta.end - meta.start < 4) return null;
  const childrenStart = meta.start + 4;
  const pitm = findBox(bytes, childrenStart, meta.end, "pitm");
  if (!pitm) return null;
  // pitm is a FullBox: version 0 carries a 2-byte primary item id, anything
  // else a 4-byte one.
  if (pitm.end - pitm.start < 5) return null;
  const primaryIdLength = bytes[pitm.start] === 0 ? 2 : 4;
  if (pitm.end - pitm.start < 4 + primaryIdLength) return null;
  const primaryItemId = primaryIdLength === 2 ? u16At(bytes, pitm.start + 4) : u32At(bytes, pitm.start + 4);

  const iprp = findBox(bytes, childrenStart, meta.end, "iprp");
  if (!iprp) return null;
  const ipco = findBox(bytes, iprp.start, iprp.end, "ipco");
  const ipma = findBox(bytes, iprp.start, iprp.end, "ipma");
  if (!ipco || !ipma) return null;

  // ipco's children are the properties, numbered from 1 in file order.
  const properties = [];
  let offset = ipco.start;
  while (offset < ipco.end) {
    const property = readBoxAt(bytes, offset, ipco.end);
    if (!property) return null;
    properties.push(property);
    offset = property.next;
  }

  // ipma associates properties with items: an entry count, then per item an
  // id (2 bytes for version 0, else 4) and a list of associations (1 byte
  // each, or 2 with the essential high bit when flags & 1).
  if (ipma.end - ipma.start < 8) return null;
  const version = bytes[ipma.start];
  const flags = (bytes[ipma.start + 1] << 16) | (bytes[ipma.start + 2] << 8) | bytes[ipma.start + 3];
  const entryCount = u32At(bytes, ipma.start + 4);
  const idLength = version === 0 ? 2 : 4;
  const associationLength = (flags & 1) === 1 ? 2 : 1;
  let cursor = ipma.start + 8;
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (cursor + idLength + 1 > ipma.end) return null;
    const itemId = idLength === 2 ? u16At(bytes, cursor) : u32At(bytes, cursor);
    cursor += idLength;
    const associationCount = bytes[cursor];
    cursor += 1;
    if (cursor + associationCount * associationLength > ipma.end) return null;
    if (itemId === primaryItemId) {
      for (let index = 0; index < associationCount; index += 1) {
        const propertyIndex = associationLength === 2
          ? u16At(bytes, cursor + index * 2) & 0x7fff
          : bytes[cursor + index] & 0x7f;
        const property = properties[propertyIndex - 1];
        // An association index outside ipco cannot name an irot; skip it.
        if (property && property.type === "irot") {
          if (property.end - property.start < 1) return null;
          return bytes[property.start] & 0x03;
        }
      }
      return 0; // The primary item has no irot among its associations.
    }
    cursor += associationCount * associationLength;
  }
  return 0; // No ipma entry for the primary item, so no irot on it.
}

const HEIF_HEAD_BYTES = 512 * 1024;

// The first bytes of a file, up to byteCount — ImageIO writes the HEIF meta
// box before the (much larger) mdat, so the head is enough. A failed read
// returns null instead of throwing.
async function readFileHead(filePath, byteCount) {
  const handle = await open(filePath, "r");
  try {
    const bytes = Buffer.alloc(byteCount);
    const { bytesRead } = await handle.read(bytes, 0, byteCount, 0);
    return bytesRead === byteCount ? bytes : bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
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
 * to sharp metadata. When sips reports no EXIF orientation at all on a
 * .heic/.heif file — the macOS-tool conversion whose rotation lives in the
 * HEIF irot property (task 424) — the primary item's irot angle is parsed
 * from the first 512 KiB of the file and angles 1/3 swap the same way, so
 * the card gets the upright ratio from the first import on. Files whose meta
 * box lies beyond that head keep the stored pixel size (the derivative pass
 * still writes the upright ratio later).
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
  // A numeric EXIF orientation wins outright — the irot property is not
  // consulted, so a file carrying both is never rotated twice.
  const orientationMatch = /orientation:\s*(\d+)/.exec(stdout);
  if (orientationMatch) {
    const orientation = Number(orientationMatch[1]) || 1;
    const swapsAxes = orientation >= 5 && orientation <= 8;
    return swapsAxes ? { width: height, height: width } : { width, height };
  }
  // "orientation: <nil>" — no EXIF marker. HEIC/HEIF files converted by macOS
  // tools can carry the rotation as the primary item's HEIF irot property
  // instead; angles 1 (90°) and 3 (270°) turn the picture sideways, so the
  // stored pixel size must swap. Everything else — 0°, 180°, unparseable
  // bytes, a meta box beyond the head, a failed read — keeps the stored size.
  if (isHeicExtension(extname(filePath))) {
    const head = await readFileHead(filePath, HEIF_HEAD_BYTES).catch(() => null);
    const rotation = head ? heifPrimaryRotation(head) : null;
    if (rotation === 1 || rotation === 3) return { width: height, height: width };
  }
  return { width, height };
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
