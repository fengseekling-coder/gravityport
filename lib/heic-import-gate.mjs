// Task 413: HEIC/HEIF imports are accepted on macOS only. sharp cannot decode
// HEVC-coded HEIC and ships no ImageIO bridge, so outside macOS the file would
// land in the library as a card that can never render a thumbnail or a
// preview; the import gate refuses it up front instead. Windows users see the
// dedicated sentence from web/gravityport/src/error-messages.ts.
//
// Every media entry point (staging layer, both stores' resolveReadableImagePath)
// calls heicUnsupportedOnPlatform(), so the rejection code and behavior stay
// identical no matter which door the file came in through.
//
// The platform is injectable — tests call setHeicImportPlatformForTests()
// rather than mutating process.platform, which Node does not allow.

const HEIC_EXTENSIONS = new Set([".heic", ".heif"]);

let platformForTests = null;

/**
 * Tests inject "win32" / "darwin" / null here; null restores the real
 * process.platform. Returns the previous value so a test's finally block can
 * restore it with one call.
 */
export function setHeicImportPlatformForTests(platform) {
  const previous = platformForTests;
  platformForTests = platform;
  return previous;
}

/** The platform the HEIC import gate evaluates against. */
export function heicImportPlatform() {
  return platformForTests || process.platform;
}

/**
 * True when a file with this extension must be refused on this platform:
 * HEIC/HEIF anywhere except macOS. Extension comparison ignores case, matching
 * the extname().toLowerCase() normalization every caller already applies.
 */
export function heicUnsupportedOnPlatform(extension, platform = heicImportPlatform()) {
  return platform !== "darwin" && HEIC_EXTENSIONS.has(String(extension || "").toLowerCase());
}
