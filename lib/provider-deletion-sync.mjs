import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HttpError } from "./http-response.mjs";
import { liveDeletionDir } from "./live-deletion-requests.mjs";

/**
 * Provider deletion sync (web capture): the paired browser extension observes
 * a provider site's own delete requests (Jimeng /mweb/v1/remove_history for
 * now) and reports the deleted item ids here. Assets whose provider identity
 * matches a deleted item move to the GravityPort trash (recoverable for the
 * trash retention window, recorded with a "provider-deleted:<provider>"
 * reason) — unless the matched group is kept: any derivative (duplicate or
 * version) or merged-identity asset keeps the whole group, and otherwise each
 * live asset is kept when the user organized it here (the shared "整理过"
 * list in lib/asset-organized.mjs, task 304). All matches are
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
 * Applies one deletion report. Per item id: every match (live or trashed) is
 * looked up in every project first, then the whole group is decided, and only
 * then does anything move (task 281 — deciding per row while deleting let a
 * newer version child move first and strip its parent's active-children
 * guard). Group rules: any derivative or merged-identity match keeps the
 * whole group. Otherwise each live match that the user organized — or that
 * carries a "user refused the deletion" mark for this provider (task 385,
 * `provider_deletion_keep` in the asset's source) — is counted under `kept`,
 * and the rest move to the trash with a "provider-deleted:<provider>" reason,
 * counting under `trashed`. An item id with no match at all (live or trashed)
 * counts under `notFound`. Matches already in the trash are skipped without
 * counting. A live match that cannot be trashed (a version parent with active
 * children) is kept safe and counted under `kept`.
 *
 * Task 385 — `live` (only the App's local service passes it) changes one
 * thing: an asset the user is currently viewing in the App is not trashed.
 * Instead `live.requestConfirmation` files a delete-confirmation request the
 * user answers in the App, and the match counts under the extra `awaitingUser`
 * counter (the route still answers 200 immediately — the extension reads
 * nothing but the HTTP status). Without `live` the behaviour is byte-for-byte
 * the pre-385 one, down to the result shape.
 */
export async function applyProviderDeletions({ store, libraryDir, live }, payload = {}) {
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
  const effectiveLive = live && typeof live === "object" ? live : null;
  // Task 385 17: every report first re-judges the deferred (timed-out) items
  // by these same rules, then handles this report. The decision path does not
  // go through here, so an answer never re-runs the list.
  if (effectiveLive) await runDeferredProviderDeletions({ store, libraryDir, live: effectiveLive });
  const outcome = await applyProviderDeletionItems({
    store,
    provider,
    items,
    live: effectiveLive,
  });
  if (!live) return { trashed: outcome.trashed, kept: outcome.kept, notFound: outcome.notFound };
  return { trashed: outcome.trashed, kept: outcome.kept, notFound: outcome.notFound, awaitingUser: outcome.awaitingUser };
}

/**
 * The shared per-item core (report path, decision re-apply and the deferred
 * re-judgement all run through this so the keep rules can never drift).
 * `skipViewCheckFor` bypasses the viewing check for named assets only — the
 * user has already answered "allow" for those.
 */
async function applyProviderDeletionItems({ store, provider, items, live, skipViewCheckFor }) {
  const projects = await store.listProjects();
  let trashed = 0;
  let kept = 0;
  let notFound = 0;
  let awaitingUser = 0;
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
      if (groupProtected || match.organized || providerRefusalMark(match, provider)) {
        kept += 1;
        continue;
      }
      toTrash.push(match);
    }
    for (const match of toTrash) {
      if (live && typeof live.isViewing === "function"
        && !(skipViewCheckFor && skipViewCheckFor.has(match.id))
        && await live.isViewing(match.projectId, match.id)) {
        // The user is looking at this one: ask instead of moving (task 385).
        awaitingUser += 1;
        if (typeof live.requestConfirmation === "function") {
          await live.requestConfirmation({ projectId: match.projectId, assetId: match.id, provider, itemId: item.itemId });
        }
        continue;
      }
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
  return { trashed, kept, notFound, awaitingUser };
}

/**
 * The "user refused" keep mark (task 385 16a): a `provider_deletion_keep`
 * object inside the asset's own source, written by markProviderDeletionKept
 * when the user declines the confirmation dialog. It only protects against
 * the provider that was refused — a different provider's deletion sync (or a
 * manual/AI-assisted trash) reads nothing here. The mark never reaches
 * search (lib/asset-search-scope.mjs is a whitelist and must stay closed).
 */
function providerRefusalMark(match, provider) {
  const raw = match.providerDeletionKeep;
  if (raw == null) return false;
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  return String(parsed.provider || "").trim().toLowerCase() === String(provider || "").trim().toLowerCase();
}

// ---- deferred (timed-out) deletions (task 385 16/17) ------------------------
// A timeout is not a refusal — the user was probably on the provider site and
// never saw the dialog — so the item waits in a small file under .live/ and is
// re-judged by the normal rules on the next report (or at service startup).
// The sync switch (18) gates the list: off means no run and no additions;
// existing refusal marks are never touched by the switch.

const DEFERRED_FILE_NAME = "provider-deletion-deferred.json";
export const MAX_DEFERRED_PROVIDER_DELETIONS = 1000;

function deferredFilePath(libraryDir) {
  return join(liveDeletionDir(libraryDir), DEFERRED_FILE_NAME);
}

function sanitizeDeferredEntries(value) {
  const source = Array.isArray(value) ? value : [];
  const entries = [];
  for (const entry of source) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const provider = String(entry.provider || "").trim().toLowerCase();
    const itemId = String(entry.itemId || "").trim();
    const assetId = String(entry.assetId || "").trim();
    if (!provider || !itemId || !assetId) continue;
    entries.push({ provider, itemId, assetId, at: String(entry.at || "") });
  }
  return entries.slice(0, MAX_DEFERRED_PROVIDER_DELETIONS);
}

export async function readDeferredProviderDeletions(libraryDir) {
  let raw;
  try {
    raw = await readFile(deferredFilePath(libraryDir), "utf8");
  } catch {
    return [];
  }
  try {
    return sanitizeDeferredEntries(JSON.parse(raw));
  } catch {
    return [];
  }
}

async function writeDeferredProviderDeletions(libraryDir, entries) {
  const path = deferredFilePath(libraryDir);
  await mkdir(liveDeletionDir(libraryDir), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(sanitizeDeferredEntries(entries), null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

/**
 * Adds (or refreshes) one deferred entry. Same provider+itemId keeps a single
 * row; the list caps at 1000 and drops the oldest beyond that.
 */
export async function addDeferredProviderDeletion(libraryDir, { provider, itemId, assetId, at } = {}) {
  const cleanProvider = String(provider || "").trim().toLowerCase();
  const cleanItemId = String(itemId || "").trim();
  const cleanAssetId = String(assetId || "").trim();
  if (!cleanProvider || !cleanItemId || !cleanAssetId) return false;
  const previous = await readDeferredProviderDeletions(libraryDir);
  const next = previous.filter((entry) => !(entry.provider === cleanProvider && entry.itemId === cleanItemId));
  next.push({ provider: cleanProvider, itemId: cleanItemId, assetId: cleanAssetId, at: String(at || new Date().toISOString()) });
  await writeDeferredProviderDeletions(libraryDir, next.slice(-MAX_DEFERRED_PROVIDER_DELETIONS));
  return true;
}

/**
 * Item 17 — re-judge every deferred entry by the normal rules before a new
 * report is processed. Every entry that got a verdict comes off the list:
 * trashed, kept, not-found, and "asked again" (a fresh request now carries it)
 * alike. The switch-off case answers null and leaves the list untouched.
 */
export async function runDeferredProviderDeletions({ store, libraryDir, live } = {}) {
  if (!libraryDir || !live) return null;
  const settings = await readProviderDeletionSettings(libraryDir);
  if (!settings.jimengDeleteSyncEnabled) return null;
  const entries = await readDeferredProviderDeletions(libraryDir);
  if (!entries.length) return { ran: 0, outcomes: [] };
  const outcomes = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const outcome = await applyProviderDeletionItems({
      store,
      provider: entry.provider,
      items: [{ itemId: entry.itemId }],
      live,
    });
    outcomes.push({ entry, outcome });
    // Write the shrink-after-each-entry list so a crash mid-run keeps the
    // un-re-judged tail deferred instead of losing it.
    await writeDeferredProviderDeletions(libraryDir, entries.slice(index + 1));
  }
  return { ran: entries.length, outcomes };
}

/**
 * The user's answer to one live deletion request for a provider deletion
 * (task 385 16), run by the service process right after the decision lands in
 * the request file. `result` is the request's written status: "allowed",
 * "denied" or "timeout".
 *   allowed → re-run only this itemId; the asset skips the viewing check
 *     (already answered) but every keep rule — organized, group, refusal
 *     mark — judges again, so work organized in the meantime stays.
 *   denied → write the refusal mark. A store without the method falls back to
 *     the deferred list: conservative, nothing is lost.
 *   timeout → defer; the next report (or the next startup) re-judges.
 */
export async function applyLiveDeletionDecision({ store, libraryDir, live, request, result } = {}) {
  const provider = String(request?.provider || "").trim().toLowerCase();
  if (!PROVIDER_SOURCE_TYPES[provider]) {
    throw new HttpError(400, "WEB_CAPTURE_PROVIDER_DELETION_INVALID", "Unsupported web capture provider for a live deletion decision.");
  }
  const itemId = String(request?.itemId || "").trim();
  if (!itemId) throw new HttpError(400, "WEB_CAPTURE_PROVIDER_DELETION_INVALID", "A live deletion decision needs the provider item id.");
  if (result === "allowed") {
    return {
      action: "reapplied",
      outcome: await applyProviderDeletionItems({
        store,
        provider,
        items: [{ itemId }],
        live: live && typeof live === "object" ? live : null,
        skipViewCheckFor: new Set([String(request.assetId || "")]),
      }),
    };
  }
  if (result === "denied") {
    if (typeof store?.markProviderDeletionKept === "function") {
      try {
        await store.markProviderDeletionKept(String(request.projectId || "default"), String(request.assetId || ""), {
          provider,
          itemId,
        });
        return { action: "marked" };
      } catch (error) {
        // The asset vanished between the dialog and the answer (permanent
        // delete). Nothing exists to protect; a future re-ingest is a new
        // asset and must not inherit an old refusal.
        if (error?.code === "ASSET_NOT_FOUND") return { action: "asset-gone" };
        throw error;
      }
    }
    await addDeferredProviderDeletion(libraryDir, { provider, itemId, assetId: String(request.assetId || ""), at: new Date().toISOString() });
    return { action: "deferred" };
  }
  if (result === "timeout") {
    const settings = await readProviderDeletionSettings(libraryDir);
    if (!settings.jimengDeleteSyncEnabled) return { action: "skipped-disabled" };
    await addDeferredProviderDeletion(libraryDir, { provider, itemId, assetId: String(request.assetId || ""), at: new Date().toISOString() });
    return { action: "deferred" };
  }
  throw new HttpError(400, "WEB_CAPTURE_PROVIDER_DELETION_INVALID", `Unsupported live deletion decision result: ${result}`);
}
