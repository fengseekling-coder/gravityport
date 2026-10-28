import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HttpError } from "./http-response.mjs";

/**
 * Provider deletion sync (web capture): the paired browser extension observes
 * a provider site's own delete requests (Jimeng /mweb/v1/remove_history for
 * now) and reports the deleted item ids here. Assets whose provider identity
 * matches a deleted item move to the GravityPort trash (recoverable for the
 * trash retention window, recorded with a "provider-deleted:<provider>"
 * reason) — unless the matched group is kept: any derivative (duplicate or
 * version) or merged-identity asset keeps the whole group, and otherwise each
 * live asset is kept when the user organized it here: favorited, rated,
 * placed in a group, carrying a user tag, a member of a manual stack,
 * curated, archived, or edited by hand after capture. All matches are
 * collected and decided before anything moves. Items that match nothing are
 * counted as not found, which is expected for captures made before the
 * extension recorded item ids.
 *
 * The enable switch lives in a JSON file inside the library directory so the
 * server-side ingest route can read it without a renderer round trip; the
 * settings card edits it through /api/web-capture/provider-deletion-settings.
 * A missing file means the default (enabled); a file that exists but does not
 * parse means disabled — moving captures on unreadable configuration would be
 * the unsafe direction.
 */

const SETTINGS_FILENAME = ".provider-deletion-sync.json";
export const MAX_PROVIDER_DELETION_ITEMS = 200;
const ITEM_ID_PATTERN = /^\d{1,32}$/;
const PROVIDER_SOURCE_TYPES = { jimeng: "web-jimeng" };

let warnedCorruptSettings = false;

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
    // A missing file stays the untouched default: enabled (2026-10-26 ruling).
    return sanitizeSettings(null);
  }
  try {
    return sanitizeSettings(JSON.parse(raw));
  } catch (error) {
    // An existing but unparsable file means off (task 281), warned once per
    // process so a broken file can neither silently trash captures nor spam
    // every ingest request.
    if (!warnedCorruptSettings) {
      warnedCorruptSettings = true;
      console.warn(
        `[provider-deletion-sync] ${SETTINGS_FILENAME} exists but is not valid JSON; provider deletion sync stays disabled until the file is repaired.`,
        error instanceof Error ? error.message : error,
      );
    }
    return { jimengDeleteSyncEnabled: false };
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

/**
 * A derivative in the matched group (task 281): the asset itself is a version
 * child, has version children in any state, or is a duplicate/version by
 * source provenance. hasDerivedReferences covers the reverse direction too —
 * assets whose duplicated_from/versioned_from point at this asset — because
 * derivatives created since task 281 no longer carry the provider asset id
 * and would otherwise be invisible to the group, leaving their original
 * unprotected.
 */
function isDerivedMatch(match) {
  return Boolean(String(match.parentAssetId || "").trim())
    || Boolean(match.hasChildVersions)
    || Boolean(match.hasDerivedReferences)
    || Boolean(String(match.duplicatedFrom || "").trim())
    || Boolean(String(match.versionedFrom || "").trim());
}

/**
 * Same bytes captured under several provider item ids (task 280): the stored
 * id stays and the others are recorded here, so a deletion report for any of
 * them must keep the asset (json_extract hands the array over as JSON text).
 */
function hasMergedProviderAssetIds(match) {
  const raw = match.mergedProviderAssetIds;
  if (raw == null) return false;
  const text = String(raw).trim();
  if (!text) return false;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.length > 0;
    return Boolean(parsed);
  } catch {
    return true;
  }
}

/**
 * Tags the capture pipeline writes by itself (lib/web-capture-ingest.js:
 * the provider name, "web-capture", "auto-archived"/"manual-capture", and
 * "video" for videos). "加了标签" in the keep-organized-work rule means a tag
 * the user added — every capture carries the system ones, so counting them
 * would keep every capture forever. The set is computed per asset (task 281):
 * "video" only counts as a system tag on a video, so a user's own "video"
 * tag on an image keeps the capture, and provider names other than this
 * asset's own (e.g. "chatgpt" on a Jimeng capture) are user tags.
 */
function hasUserTag(match) {
  const systemTags = new Set([String(match.providerName || ""), "web-capture", "auto-archived", "manual-capture"]);
  if (match.mediaKind === "video") systemTags.add("video");
  systemTags.delete("");
  return Array.isArray(match.tagNames) && match.tagNames.some((name) => !systemTags.has(name));
}

function isOrganized(match) {
  return Boolean(match.favorite)
    || Number(match.rating) > 0
    || Boolean(String(match.group || "").trim())
    || hasUserTag(match)
    || Boolean(match.manualStackMember)
    || match.curated === 1 || match.curated === true || match.curated === "true"
    || Boolean(String(match.curationNote || "").trim())
    || Number(match.archived) === 1
    || Boolean(String(match.userEditedAt || "").trim())
    || Boolean(String(match.promptUserEditedAt || "").trim());
}

/**
 * Applies one deletion report. Per item id: every match (live or trashed) is
 * looked up in every project first, then the whole group is decided, and only
 * then does anything move (task 281 — deciding per row while deleting let a
 * newer version child move first and strip its parent's active-children
 * guard). Group rules: any derivative or merged-identity match keeps the
 * whole group. Otherwise each live match that the user organized is counted
 * under `kept`, and the rest move to the trash with a
 * "provider-deleted:<provider>" reason, counting under `trashed`. An item id
 * with no match at all (live or trashed) counts under `notFound`. Matches
 * already in the trash are skipped without counting. A live match that
 * cannot be trashed (a version parent with active children) is kept safe and
 * counted under `kept`.
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
    // Collect every match across every project before deciding anything.
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
    const groupProtected = matches.some((match) => isDerivedMatch(match) || hasMergedProviderAssetIds(match));
    const toTrash = [];
    for (const match of matches) {
      if (match.deleted) continue;
      if (groupProtected || isOrganized(match)) {
        kept += 1;
        continue;
      }
      toTrash.push(match);
    }
    for (const match of toTrash) {
      try {
        await store.deleteAsset(match.projectId, match.id, { reason: `provider-deleted:${provider}` });
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
