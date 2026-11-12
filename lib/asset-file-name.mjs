// Shared sanitizer for managed asset file names (task 382). Both stores used
// to run an ASCII-only rule here, so every non-ASCII file name collapsed to
// `asset-<stamp>.png` and the readable name was lost for CJK (and any other
// non-Latin) imports. The rule now keeps Unicode letters, combining marks and
// numbers, while ASCII-only stems must keep byte-identical output with the
// previous implementation (locked by test/cjk-file-name.test.mjs).
//
// sanitizeFileName MUST stay idempotent: the /library image routes resolve
// stored names through store.assetFileInfo / assetReadStream, which
// re-sanitize the decoded URL segment before the lookup, and
// normalizeAssetMetadata re-sanitizes `asset` on every metadata save — a
// sanitizer that changed its own output would break image reads and mangle
// names on the first prompt edit.
import { basename, extname } from "node:path";

// Runs of characters Windows forbids in file names (<>:"/\|?*), control
// characters, emoji and whitespace collapse into a single dash. Unicode
// letters (any script), combining marks, digits and `.` `_` `-` survive.
const NON_FILE_SAFE_RUN = /[^\p{L}\p{M}\p{N}._-]+/gu;
const NON_ASCII = /[^\u0000-\u007f]/;

// The readable stem is capped at 48 code points. Array.from walks code
// points, so surrogate pairs are never split; the trailing trim repeats after
// the cap because truncation can expose a trailing connector or dot.
const MAX_STEM_CODE_POINTS = 48;

function truncateCodePoints(value, max) {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join("");
}

function sanitizeNonAsciiStem(stem) {
  return truncateCodePoints(
    String(stem).normalize("NFC").replace(NON_FILE_SAFE_RUN, "-").replace(/^[-.]+|[-.]+$/g, ""),
    MAX_STEM_CODE_POINTS,
  ).replace(/[-.]+$/g, "");
}

export function sanitizeFileName(value) {
  const raw = basename(String(value || "asset.png"));
  const extension = extname(raw) || ".png";
  const stem = raw.slice(0, raw.length - extname(raw).length);
  const base = NON_ASCII.test(stem)
    ? sanitizeNonAsciiStem(stem)
    : stem.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${base || "asset"}${extension}`;
}

/** True when the stem of `fileName` (everything before the extension) holds at least one non-ASCII character. */
export function hasNonAsciiStem(fileName) {
  const raw = basename(String(fileName || ""));
  const extension = extname(raw);
  const stem = extension ? raw.slice(0, raw.length - extension.length) : raw;
  return NON_ASCII.test(stem);
}
