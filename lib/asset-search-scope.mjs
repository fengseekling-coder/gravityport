/**
 * Search-scope whitelist: the single authority for which metadata values may
 * enter asset search. Everything a user can see and would think to search for
 * is listed below; every other source/business_fields value (paths, hashes,
 * capture internals, ids, mime types, sizes, timestamps, …) stays out of
 * search, and any key added in the future defaults to out until it is added
 * here. Consumers: sqlite-asset-store.mjs (search_text assembly, the two
 * scoring columns, the SQL backfill functions), asset-search.mjs (in-memory
 * scoring for the JSON store) and repair-capture-history.mjs — the three must
 * never disagree.
 */

import { canonicalSourceTypeOf } from "./generation-session.mjs";

// v3 strips machine-generated segments from asset ids / file names before they
// enter search (see searchableAssetName). Libraries marked v2 rebuild once more
// under the new rules; the old v2 marker is left in place.
export const SEARCH_SCOPE_MARKER_KEY = "search_scope_v3";

// Prompt-like text the Inspector shows (instruction, request prompt, user /
// negative prompt) plus the provider and model names. The web app reads the
// same keys from either bag (source first, business_fields as the fallback),
// so both lists carry them.
export const SOURCE_SEARCHABLE_KEYS = Object.freeze([
  "user_message",
  "generation_request_prompt",
  "user_prompt",
  "negative_prompt",
  "provider",
  "model",
]);

export const BUSINESS_FIELD_SEARCHABLE_KEYS = Object.freeze([
  "user_message",
  "user_prompt",
  "negative_prompt",
  "provider",
  "model",
]);

// Searchable display name per canonical source type (lib/generation-session.mjs
// classifies; local-file and unknown types contribute no name). Derived from
// the already-normalized source type, never from raw source strings.
const SOURCE_TYPE_SEARCH_NAMES = Object.freeze({
  "web-chatgpt": "ChatGPT",
  "web-gemini": "Gemini",
  "web-flow": "Flow",
  "web-google-ai-studio": "Google AI Studio",
  "web-jimeng": "即梦",
  "web-midjourney": "Midjourney",
  "codex-generated": "Codex",
  "grok-generated": "Grok",
  "cowart-generated": "Cowart",
});

export function sourceSearchDisplayName(sourceGroup) {
  return SOURCE_TYPE_SEARCH_NAMES[sourceGroup] || "";
}

// Ingest appends machine-generated segments to the user-visible name (manual
// import, copy, save-version and replace-image in asset-store.mjs /
// sqlite-asset-store.mjs; web-capture-ingest.ts; codex-image-bridge.ts;
// grok-media-bridge.ts): a base36 timestamp + 8-hex random pair, "-copy" /
// "-v" markers, content/path hashes, session digests, collision-randoms and
// UUIDs. Search must only match the part of the name a human can read, so the
// helpers below delete exactly those segments. They only ever delete, only
// from the tail (except whole-string UUIDs), and anything that might be a
// user-chosen name is kept — when in doubt, do not strip.

// The final ".ext" of a stored file name (stores write `<id><ext>`); ids never
// contain dots, so a trailing 1-8 alphanumeric run after the last dot is safe
// to treat as the extension.
const ASSET_NAME_EXTENSION = /(\.[a-z0-9]{1,8})$/i;
// "-copy" / "-v" version markers written by copyAsset / saveAssetVersion.
const ASSET_NAME_VERSION_MARKER = /-(copy|v)$/i;
const ASSET_NAME_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// The base36 timestamp word (Date.now().toString(36)) and the hex random that
// always trails it. A segment only counts as a timestamp when it also decodes
// to a moment an asset could have been created at (2024 up to a day from now),
// so an ordinary eight-letter word in front of a date ("birthday-20241012",
// "portrait-20241012") is not taken for one: most words decode far outside
// that window. Time-dependent only at the upper edge — a stamp written now is
// always inside it.
const STAMP_EPOCH_FLOOR = Date.UTC(2024, 0, 1);
const STAMP_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

function isStampWord(segment) {
  if (!/^[0-9a-z]{8}$/i.test(segment) || !/[g-z]/i.test(segment)) return false;
  const moment = parseInt(segment, 36);
  return moment >= STAMP_EPOCH_FLOOR && moment <= Date.now() + STAMP_CLOCK_SKEW_MS;
}

function isHexWord(segment) {
  return /^[0-9a-f]{8}$/i.test(segment);
}

// Rule 3's trailing hash segment: at least 8 hex characters mixing digits and
// a–f letters. Pure digit runs (dates like 20241012) and pure letter runs are
// user-chosen segments and stay.
function isMixedHexSegment(segment) {
  return /^[0-9a-f]{8,}$/i.test(segment) && /[0-9]/.test(segment) && /[a-f]/i.test(segment);
}

// The machine tail the stores write, matched as exactly the shapes they
// produce and nothing longer:
//   manual import / copy / save-version   `-<stamp>-<random>`
//   replace-image file name               `-<stamp>-<random>-<random>`, on an
//                                         id that may carry its own
//                                         `-<stamp>-<random>` (two pairs)
// The pair count is capped per shape on purpose: every extra pair this
// swallowed would be a user-chosen "word-date" in front of the real stamp.
function stripStampChain(stem) {
  const segments = stem.split("-");
  for (const [withTrailingRandom, maxPairs] of [[true, 2], [false, 1]]) {
    let end = segments.length;
    if (withTrailingRandom) {
      if (!isHexWord(segments[end - 1])) continue;
      end -= 1;
    }
    let pairs = 0;
    while (pairs < maxPairs && end >= 3 && isHexWord(segments[end - 1]) && isStampWord(segments[end - 2])) {
      end -= 2;
      pairs += 1;
    }
    if (pairs >= 1) return segments.slice(0, end).join("-");
  }
  return stem;
}

function stripTrailingHashSegment(stem) {
  const dash = stem.lastIndexOf("-");
  if (dash <= 0) return stem;
  if (!isMixedHexSegment(stem.slice(dash + 1))) return stem;
  return stem.slice(0, dash);
}

// Everything machine-generated at the end of a name: one stamp chain (the
// stores append exactly one per name level — looping here would walk into a
// user's own "word-date" behind it), then any hash segments in front of it
// (a collision random after a session digest, a content hash, …).
function stripMachineTail(stem) {
  let next = stripStampChain(stem);
  for (;;) {
    const shorter = stripTrailingHashSegment(next);
    if (shorter === next) return next;
    next = shorter;
  }
}

export function assetFileNameStem(value) {
  const name = String(value ?? "");
  const extension = name.match(ASSET_NAME_EXTENSION);
  return extension ? name.slice(0, name.length - extension[1].length) : name;
}

/**
 * The searchable part of an asset id or file name: the human-readable name
 * with machine-generated segments removed. Returns the input unchanged when
 * nothing looks machine-generated. The extension is preserved as-is.
 */
export function searchableAssetName(value) {
  if (value == null) return "";
  const original = String(value);
  if (!original) return "";
  const extension = original.match(ASSET_NAME_EXTENSION);
  const extensionText = extension ? extension[1] : "";
  const originalStem = extensionText ? original.slice(0, original.length - extensionText.length) : original;
  // 2. UUIDs, wherever they appear (done first so the tail rules below see
  //    the name without them).
  let stem = originalStem.replace(ASSET_NAME_UUID, "");
  if (stem !== originalStem) stem = stem.replace(/-{2,}/g, "-").replace(/-+$/, "");

  // 1 + 3. The machine tail. A "-copy" / "-v" marker left at the end belongs
  //    to the same chain when more machine segments sit in front of it
  //    (`logo-<stamp>-<random>-copy-<stamp>-<random>`): strip those too and
  //    keep the markers. A marker with nothing machine-made in front of it is
  //    the user's own ("logo-v", "my-copy") and ends the walk.
  let markers = "";
  for (;;) {
    stem = stripMachineTail(stem);
    const marker = stem.match(ASSET_NAME_VERSION_MARKER);
    if (!marker) break;
    const head = stem.slice(0, stem.length - marker[0].length);
    const headStripped = stripMachineTail(head);
    if (headStripped === head) break;
    markers = marker[0] + markers;
    stem = headStripped;
  }
  stem += markers;

  if (stem === originalStem) return original;
  // Collapsing the leftover connectors only after something was deleted, so a
  // user name that already contains "--" survives untouched.
  return `${stem.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "")}${extensionText}`;
}

function searchableValues(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return keys.flatMap((key) => {
    const item = value[key];
    if (item == null) return [];
    if (Array.isArray(item)) {
      return item.filter((entry) => typeof entry === "string" || typeof entry === "number").map(String);
    }
    if (typeof item === "string" || typeof item === "number") return [String(item)];
    return [];
  });
}

export function searchableSourceValues(source, sourceGroup) {
  const values = searchableValues(source, SOURCE_SEARCHABLE_KEYS);
  const display = sourceSearchDisplayName(sourceGroup);
  if (display) values.push(display);
  return values;
}

export function searchableBusinessFieldValues(businessFields) {
  return searchableValues(businessFields, BUSINESS_FIELD_SEARCHABLE_KEYS);
}

// Same separator the store historically used between object values, so an
// exact phrase still cannot span two values inside one scoring column.
const SEARCH_VALUE_SEPARATOR = "\u001f";

export function searchableSourceObjectText(source, sourceGroup) {
  return searchableSourceValues(source, sourceGroup).join(SEARCH_VALUE_SEPARATOR);
}

export function searchableBusinessObjectText(businessFields) {
  return searchableBusinessFieldValues(businessFields).join(SEARCH_VALUE_SEPARATOR);
}

function parseJsonObject(value) {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * One-time rebuild for libraries written before this whitelist: their
 * search_text, asset_fts and asset_short_terms rows still carry the old
 * match-everything text. Rewrites the three search columns and re-syncs the
 * two indexes for every asset (trash rows included in the column rewrite; the
 * injected syncAssetFtsEntry keeps the trash invariant — delete only), without
 * touching updated_at and without emitting library changes, so no client sees
 * "asset changed".
 *
 * Marker and data share one BEGIN IMMEDIATE transaction: a failure rolls both
 * back and the next open retries; the caller's catch must never write the
 * marker. The marker is re-checked inside the write lock, so two processes
 * opening the same library can never both run the rebuild — the loser only
 * acquires the lock after the winner committed and then sees the marker.
 */
export function rebuildSearchScopeTexts(database, helpers = {}) {
  const { loadMetadata, searchableText, syncAssetFtsEntry, replaceAssetShortTerms } = helpers;
  if (typeof loadMetadata !== "function" || typeof searchableText !== "function") {
    throw new Error("rebuildSearchScopeTexts requires loadMetadata and searchableText helpers");
  }
  const stats = { assetsRebuilt: 0, assetsUnchanged: 0 };
  // Cheap read first: once the marker exists, an open must not take the write
  // lock just to find that out (it would queue behind, or fail BUSY against,
  // an MCP/CLI writer on every single open). The check inside the transaction
  // below stays the authority for the race between two first opens.
  const markerQuery = database.prepare("SELECT 1 FROM library_meta WHERE key = ?");
  if (markerQuery.get(SEARCH_SCOPE_MARKER_KEY)) return stats;
  const timestamp = new Date().toISOString();
  database.transaction(() => {
    const alreadyDone = markerQuery.get(SEARCH_SCOPE_MARKER_KEY);
    if (alreadyDone) return;
    const rows = database.prepare("SELECT * FROM assets").all();
    const update = database.prepare(`
      UPDATE assets SET search_text = ?, source_search_text = ?, business_search_text = ?
      WHERE project_id = ? AND id = ?
    `);
    for (const row of rows) {
      const metadata = loadMetadata(row);
      const searchText = searchableText(metadata);
      const sourceSearchText = searchableSourceObjectText(
        parseJsonObject(row.source_json),
        canonicalSourceTypeOf(metadata),
      );
      const businessSearchText = searchableBusinessObjectText(parseJsonObject(row.business_fields_json));
      if (
        searchText === (row.search_text || "") &&
        sourceSearchText === (row.source_search_text || "") &&
        businessSearchText === (row.business_search_text || "")
      ) {
        stats.assetsUnchanged += 1;
        continue;
      }
      update.run(searchText, sourceSearchText, businessSearchText, row.project_id, row.id);
      syncAssetFtsEntry(row.project_id, row.id, searchText, row.deleted_at);
      replaceAssetShortTerms(row.project_id, row.id, searchText);
      stats.assetsRebuilt += 1;
    }
    database.prepare(`
      INSERT INTO library_meta (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(SEARCH_SCOPE_MARKER_KEY, timestamp, timestamp);
  }).immediate();
  return stats;
}
