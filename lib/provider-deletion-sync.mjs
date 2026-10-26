import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HttpError } from "./http-response.mjs";

/**
 * Provider deletion sync (web capture): the paired browser extension observes
 * a provider site's own delete requests (Jimeng /mweb/v1/remove_history for
 * now) and reports the deleted item ids here. Assets whose provider identity
 * matches a deleted item move to the GravityPort trash (recoverable for the
 * trash retention window) — unless the user organized them here: favorited,
 * rated, placed in a group, or carrying any tag. Items that match nothing are
 * counted as not found, which is expected for captures made before the
 * extension recorded item ids.
 *
 * The enable switch lives in a JSON file inside the library directory so the
 * server-side ingest route can read it without a renderer round trip; the
 * settings card edits it through /api/web-capture/provider-deletion-settings.
 */

const SETTINGS_FILENAME = ".provider-deletion-sync.json";
export const MAX_PROVIDER_DELETION_ITEMS = 200;
const ITEM_ID_PATTERN = /^\d{1,32}$/;
const PROVIDER_SOURCE_TYPES = { jimeng: "web-jimeng" };
// Tags the capture pipeline writes by itself (lib/web-capture-ingest.js:
// the provider name, "web-capture", "auto-archived"/"manual-capture", and
// "video" for videos). "加了标签" in the keep-organized-work rule means a tag
// the user added — every capture carries the system ones, so counting them
// would keep every capture forever.
const WEB_CAPTURE_SYSTEM_TAGS = new Set([
  "web-capture", "auto-archived", "manual-capture", "video",
  "chatgpt", "gemini", "flow", "google-ai-studio", "jimeng", "midjourney",
]);

function sanitizeSettings(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    jimengDeleteSyncEnabled: source.jimengDeleteSyncEnabled !== false,
  };
}

export async function readProviderDeletionSettings(libraryDir) {
  let raw;
  try {
    raw = await readFile(join(String(libraryDir || ""), SETTINGS_FILENAME), "utf8");
  } catch {
    return sanitizeSettings(null);
  }
  try {
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    // A corrupt settings file falls back to the default (enabled) rather than
    // silently disabling or throwing on every ingest request.
    return sanitizeSettings(null);
  }
}

export async function writeProviderDeletionSettings(libraryDir, patch) {
  const base = await readProviderDeletionSettings(libraryDir);
  const source = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  const next = sanitizeSettings({ ...base, ...source });
  const path = join(String(libraryDir || ""), SETTINGS_FILENAME);
  await mkdir(String(libraryDir || ""), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
  return next;
}

/**
 * Normalizes the extension's deletion report: drops malformed item ids
 * (non-digits or longer than 32 chars), dedupes by item id, caps the batch.
 * The record id travels for provenance only — matching uses the item id.
 */
export function normalizeProviderDeletionItems(rawItems, { maxItems = MAX_PROVIDER_DELETION_ITEMS } = {}) {
  const source = Array.isArray(rawItems) ? rawItems : [];
  const items = [];
  const seen = new Set();
  for (const entry of source) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const itemId = String(entry.itemId ?? entry.item_id ?? "").trim();
    if (!ITEM_ID_PATTERN.test(itemId) || seen.has(itemId)) continue;
    seen.add(itemId);
    items.push({ recordId: String(entry.recordId ?? "").trim().slice(0, 128), itemId });
    if (items.length >= maxItems) break;
  }
  return items;
}

function isCurated(match) {
  return Boolean(match.favorite)
    || Number(match.rating) > 0
    || Boolean(String(match.group || "").trim())
    || (Array.isArray(match.tagNames) && match.tagNames.some((name) => !WEB_CAPTURE_SYSTEM_TAGS.has(name)));
}

/**
 * Applies one deletion report. Per item id: matches are looked up in every
 * project; live curated matches are counted under `kept`, live unorganized
 * matches move to the trash and count under `trashed`; an item id with no
 * match at all (live or trashed) counts under `notFound`. Matches already in
 * the trash are skipped without counting — they are not re-processed and not
 * "not found". A live match that cannot be trashed (a version parent with
 * active children) is kept safe and counted under `kept`.
 */
export async function applyProviderDeletions({ store, libraryDir }, payload = {}) {
  const provider = String(payload?.provider || "").trim().toLowerCase();
  if (!PROVIDER_SOURCE_TYPES[provider]) {
    throw new HttpError(400, "WEB_CAPTURE_PROVIDER_DELETION_INVALID", "Unsupported web capture provider for deletion sync.");
  }
  const items = normalizeProviderDeletionItems(payload?.items);
  const settings = await readProviderDeletionSettings(libraryDir);
  if (!settings.jimengDeleteSyncEnabled) {
    return { trashed: 0, kept: 0, notFound: items.length, disabled: true };
  }
  if (typeof store?.listProjects !== "function" || typeof store?.deleteAsset !== "function"
    || typeof store?.findProviderDeletionMatches !== "function") {
    throw new HttpError(501, "PROVIDER_DELETION_SYNC_UNAVAILABLE", "Provider deletion sync needs the SQLite asset store.");
  }
  const projects = await store.listProjects();
  let trashed = 0;
  let kept = 0;
  let notFound = 0;
  for (const item of items) {
    const matches = [];
    for (const projectId of projects) {
      for (const match of await store.findProviderDeletionMatches(projectId, provider, item.itemId)) {
        matches.push({ projectId, ...match });
      }
    }
    if (!matches.length) {
      notFound += 1;
      continue;
    }
    for (const match of matches) {
      if (match.deleted) continue;
      if (isCurated(match)) {
        kept += 1;
        continue;
      }
      try {
        await store.deleteAsset(match.projectId, match.id);
        trashed += 1;
      } catch (error) {
        // A version parent with active children refuses the trash on purpose;
        // keeping it is the safe outcome, so it counts as kept.
        if (error?.code === "VERSION_PARENT_HAS_CHILDREN") {
          kept += 1;
          continue;
        }
        throw error;
      }
    }
  }
  return { trashed, kept, notFound };
}
