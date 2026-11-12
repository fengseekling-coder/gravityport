// Pagination cursor helpers for SQLite store (task 394). Pure moves; no behavior changes.
import { assetStoreError } from "../asset-version-history.mjs";
import { assetSortName, normalizeAssetSort } from "../asset-sort.js";
import { normalizeAssetSearchQuery } from "../asset-search.mjs";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 250;

export function normalizeLimit(value) {
  if (value === 0 || value === "0") return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(parsed), MAX_PAGE_SIZE);
}

export function normalizeStackSort(value) {
  const normalized = String(value || "manual").trim().toLowerCase();
  return normalized === "name" || normalized === "oldest" || normalized === "newest" ? normalized : "manual";
}

function stackCursorFilterKey(filters = {}) {
  return JSON.stringify([
    normalizeAssetSearchQuery(filters.query),
    String(filters.source || ""),
    String(filters.group || ""),
    String(filters.category || ""),
    String(filters.style || ""),
    String(filters.conversation || ""),
    String(filters.generationBatch || ""),
    Boolean(filters.favorite),
    Boolean(filters.recent),
    filters.mediaKind === "img" || filters.mediaKind === "video" ? filters.mediaKind : "",
    Number.isFinite(filters.createdAfterMs) ? filters.createdAfterMs : null,
    Number.isFinite(filters.createdBeforeMs) ? filters.createdBeforeMs : null,
  ]);
}

export function encodeStackCursor(row, stackId, sort, filters = {}) {
  return Buffer.from(JSON.stringify({
    stackId,
    sort: normalizeStackSort(sort),
    filterKey: stackCursorFilterKey(filters),
    id: row.id,
    position: Number(row.stack_position),
    createdAt: row.created_at,
    sortName: row.sort_name ?? assetSortName(row),
  })).toString("base64url");
}

export function parseStackCursor(value, stackId, sort, filters = {}) {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    const requestedSort = normalizeStackSort(sort);
    if (cursor?.stackId !== stackId || cursor?.sort !== requestedSort || cursor?.filterKey !== stackCursorFilterKey(filters)) throw new Error();
    if (typeof cursor.id !== "string") throw new Error();
    if (requestedSort === "manual" && !Number.isFinite(Number(cursor.position))) throw new Error();
    if ((requestedSort === "oldest" || requestedSort === "newest") && typeof cursor.createdAt !== "string") throw new Error();
    if (requestedSort === "name" && typeof cursor.sortName !== "string") throw new Error();
    return {
      ...cursor,
      position: Number(cursor.position),
    };
  } catch {
    throw assetStoreError("INVALID_STACK_CURSOR", "Invalid Stack cursor.");
  }
}

// Canonical identity of the created-time bounds a page was issued under.
// Cursors carry it so paginating with changed time bounds is rejected the
// same way a changed sort or search query already is.
export function assetTimeFilterKey(filters = {}) {
  return JSON.stringify([
    Number.isFinite(filters.createdAfterMs) ? filters.createdAfterMs : null,
    Number.isFinite(filters.createdBeforeMs) ? filters.createdBeforeMs : null,
  ]);
}

export function encodeCursor(row, sort, searchQuery = "", timeFilterKey = "") {
  return Buffer.from(JSON.stringify({
    createdAt: row._node_created_at ?? row.created_at,
    id: row.id,
    sortName: row._node_sort_name ?? row.sort_name ?? assetSortName(row),
    sort: normalizeAssetSort(sort),
    searchQuery: normalizeAssetSearchQuery(searchQuery),
    searchScore: Number(row._search_score || 0),
    timeFilterKey,
  })).toString("base64url");
}

/**
 * The cursor carries the order it was issued under. Resuming a `newest` cursor
 * under a `name` sort would compare the wrong key and silently return a page
 * from the middle of an unrelated ordering, so the mismatch is rejected and the
 * caller restarts the query instead. The created-time bounds are part of that
 * order: a page cursor minted under one time window never resumes under
 * another.
 */
export function parseCursor(value, sort, searchQuery = "", timeFilterKey = "") {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (typeof cursor?.createdAt !== "string" || typeof cursor?.id !== "string") throw new Error();
    // Cursors minted before sorting existed carry no sort and are chronological.
    const cursorSort = normalizeAssetSort(cursor.sort);
    if (cursorSort !== normalizeAssetSort(sort)) throw new Error();
    if (cursorSort === "name" && typeof cursor.sortName !== "string") throw new Error();
    const normalizedQuery = normalizeAssetSearchQuery(searchQuery);
    if (normalizeAssetSearchQuery(cursor.searchQuery) !== normalizedQuery) throw new Error();
    if (normalizedQuery && !Number.isFinite(Number(cursor.searchScore))) throw new Error();
    if (String(cursor.timeFilterKey ?? "") !== String(timeFilterKey)) throw new Error();
    return cursor;
  } catch {
    throw assetStoreError("INVALID_ASSET_CURSOR", "Invalid asset cursor.");
  }
}

export function isGalleryRowAfterCursor(asset, cursor, sort, searchQuery = "") {
  if (!cursor) return false;
  const normalizedSort = normalizeAssetSort(sort);
  const normalizedQuery = normalizeAssetSearchQuery(searchQuery);
  const createdAt = String(asset?.node_sort?.createdAt ?? asset?.created_at ?? "");
  const sortName = String(asset?.node_sort?.sortName ?? asset?.sort_name ?? assetSortName(asset));
  const id = String(asset?.id || "");
  if (normalizedQuery && Number.isFinite(Number(asset?.node_sort?.searchScore))) {
    const score = Number(asset.node_sort.searchScore);
    if (score !== Number(cursor.searchScore)) return score < Number(cursor.searchScore);
  }
  if (normalizedSort === "name") {
    return sortName > cursor.sortName || (sortName === cursor.sortName && id > cursor.id);
  }
  if (normalizedSort === "oldest") {
    return createdAt > cursor.createdAt || (createdAt === cursor.createdAt && id > cursor.id);
  }
  return createdAt < cursor.createdAt || (createdAt === cursor.createdAt && id < cursor.id);
}

export function isStackRowAfterCursor(asset, cursor, sort) {
  if (!cursor) return false;
  const normalizedSort = normalizeStackSort(sort);
  const id = String(asset?.id || "");
  if (normalizedSort === "manual") {
    const position = Number(asset?.stack_position);
    return position > Number(cursor.position) || (position === Number(cursor.position) && id > cursor.id);
  }
  const createdAt = String(asset?.created_at || "");
  const sortName = String(asset?.sort_name ?? assetSortName(asset));
  if (normalizedSort === "name") {
    return sortName > cursor.sortName || (sortName === cursor.sortName && id > cursor.id);
  }
  if (normalizedSort === "oldest") {
    return createdAt > cursor.createdAt || (createdAt === cursor.createdAt && id > cursor.id);
  }
  return createdAt < cursor.createdAt || (createdAt === cursor.createdAt && id < cursor.id);
}
