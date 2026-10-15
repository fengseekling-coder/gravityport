/**
 * 任务 147:URL gate for the open-external-link IPC channel.
 *
 * Kept in its own module so tests can import the validation without
 * booting Electron (desktop/main.mjs has window lifecycle side effects).
 * Only http: and https: URLs from the main window are allowed out; the
 * renderer never gets a generic shell capability.
 */

export function openExternalLinkOutcome(url) {
  if (typeof url !== "string" || url.length === 0 || url.length > 2048) {
    return { ok: false };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false };
  }
  return { ok: true };
}
