// Whether the system clipboard holds content the blank-area 粘贴 can import
// (task 245). Extracted from desktop/main.mjs so the decision is unit-testable
// without Electron: on macOS a Finder file copy must be judged by the files'
// extensions, never by readImage() — Finder also puts the file's icon on the
// clipboard as a TIFF, so readImage() is non-empty for EVERY file copy. The
// renderer only ever sees the boolean; paths and bytes stay in the clipboard.

// Mirror of lib/asset-store.mjs SUPPORTED_MEDIA_EXTENSIONS. The main process
// must not import asset-store (it drags the whole store in), so the unit test
// asserts the two lists stay identical instead.
export const MEDIA_IMPORT_EXTENSIONS = [
  ".apng", ".avif", ".gif", ".jpeg", ".jpg", ".m4v", ".mov", ".mp4", ".png", ".svg", ".webm", ".webp",
];

const hasMediaExtension = (path) => {
  const lower = String(path).toLowerCase();
  return MEDIA_IMPORT_EXTENSIONS.some((extension) => lower.endsWith(extension));
};

// One-pass unescape so "&amp;lt;" decodes to "&lt;" (literal text), never to "<".
const XML_ENTITY = /&(?:amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#[0-9]+);/g;
function unescapeXml(value) {
  return value.replace(XML_ENTITY, (entity) => {
    if (entity === "&amp;") return "&";
    if (entity === "&lt;") return "<";
    if (entity === "&gt;") return ">";
    if (entity === "&quot;") return '"';
    if (entity === "&apos;") return "'";
    const code = entity.startsWith("&#x")
      ? Number.parseInt(entity.slice(3, -1), 16)
      : Number.parseInt(entity.slice(2, -1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

/**
 * Paths out of macOS NSFilenamesPboardType: one <string> per file inside the
 * <array>. Returns [] for unreadable or malformed data — never throws.
 */
export function parseMacFilenamesPlist(xml) {
  if (typeof xml !== "string") return [];
  const paths = [];
  const stringElement = /<string>([^<]*)<\/string>/g;
  for (let match = stringElement.exec(xml); match; match = stringElement.exec(xml)) {
    paths.push(unescapeXml(match[1]));
  }
  return paths;
}

function pathFromFileUrl(fileUrl) {
  try {
    const url = new URL(String(fileUrl));
    if (url.protocol !== "file:") return null;
    return decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
}

function macImportable(clipboard) {
  // File list first, and the decision ends there: the TIFF icon Finder adds
  // makes readImage() non-empty for any file copy, so once files are present
  // the image data cannot be trusted as an "importable content" signal.
  const paths = parseMacFilenamesPlist(clipboard.read("NSFilenamesPboardType"));
  if (paths.length) return paths.some(hasMediaExtension);
  // Fallback when the plist is unreadable: public.file-url holds the first
  // file's URL only, but that is enough for the single-file case.
  const fileUrl = clipboard.read("public.file-url");
  if (fileUrl) {
    const path = pathFromFileUrl(fileUrl);
    if (path) return hasMediaExtension(path);
  }
  // No files: raw image data (screenshots, browser 复制图片) stays importable.
  return !clipboard.readImage().isEmpty();
}

/**
 * Whether the system clipboard holds importable content. `clipboard` is the
 * Electron clipboard module (tests pass a fake); only read, readImage,
 * availableFormats and has are called, and any read failure means false.
 */
export function clipboardImportable({ platform, clipboard } = {}) {
  if (!clipboard) return false;
  try {
    if (platform === "darwin") return macImportable(clipboard);
    // Windows (and other platforms) keep the pre-245 judgment: Explorer only
    // exposes the FIRST pasted file (FileNameW), so judging by extension
    // would wrongly refuse "a document first, an image behind it". uri-list
    // and the CF_HDROP-family formats are the real signals there.
    if (!clipboard.readImage().isEmpty()) return true;
    const formats = clipboard.availableFormats();
    if (formats.includes("text/uri-list")) return true;
    if (formats.some((format) => /FileName|FileGroupDescriptor|FileDrop|CF_HDROP/i.test(format))) return true;
    if (platform === "win32" && clipboard.has("FileNameW")) return true;
    return false;
  } catch {
    return false;
  }
}
