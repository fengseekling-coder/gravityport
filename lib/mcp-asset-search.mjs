import { normalizeAssetTimeRange } from "./asset-time-filter.mjs";

const RRF_K = 60;

export async function searchMcpAssets({
  store,
  projectId = "default",
  query = "",
  createdAfter,
  createdBefore,
  // Legacy clients may still send `visual: true` from a cached tool schema.
  // Local visual retrieval was removed; the flag is accepted and ignored so
  // those clients keep receiving lexical results without an error.
  visual = false,
  cursor,
  limit = 20,
} = {}) {
  if (!store || typeof store.listAssetPage !== "function") throw new Error("MCP asset search requires a paged asset store.");
  const cleanQuery = String(query || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const range = normalizeAssetTimeRange({ createdAfter, createdBefore });
  if (!cleanQuery && range.createdAfterMs == null && range.createdBeforeMs == null) {
    throw searchError("asset_search requires query, createdAfter, or createdBefore.", "MCP_ASSET_SEARCH_EMPTY");
  }
  const boundedLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  // rankLexicalResults below only decorates and filters — it never reorders —
  // so the store's own cursor paging can carry the whole result set (task 376):
  // one candidate page per call sized to the requested limit, with the total
  // and next cursor passed straight through to the caller.
  const lexicalPage = await store.listAssetPage({
    projectId,
    query: cleanQuery,
    limit: boundedLimit,
    cursor,
    includeTotal: true,
    createdAfterMs: range.createdAfterMs,
    createdBeforeMs: range.createdBeforeMs,
  });
  const lexical = Array.isArray(lexicalPage?.assets) ? lexicalPage.assets : [];

  return {
    // Task 376: the echoed query is capped at 200 characters (plus an
    // ellipsis when cut); the search above always ran with the full query.
    query: excerptCharacters(cleanQuery, 200),
    project_id: projectId,
    filters: {
      created_after: range.createdAfterMs == null ? null : new Date(range.createdAfterMs).toISOString(),
      created_before: range.createdBeforeMs == null ? null : new Date(range.createdBeforeMs).toISOString(),
    },
    visual: { requested: Boolean(visual), available: false, reason: visual ? "removed" : "not-requested" },
    results: rankLexicalResults(lexical).slice(0, boundedLimit),
    total: lexicalPage?.page?.total ?? null,
    next_cursor: lexicalPage?.page?.nextCursor ?? null,
  };
}

function excerptCharacters(value, maxCharacters) {
  const chars = Array.from(value);
  return chars.length > maxCharacters ? `${chars.slice(0, maxCharacters).join("")}…` : value;
}

// The match block keeps the historical lexical/visual/fused shape: the visual
// fields stay null now that local visual retrieval no longer exists.
function rankLexicalResults(lexicalAssets) {
  return lexicalAssets
    .filter((asset) => asset?.id)
    .map((asset, index) => ({
      asset,
      match: {
        lexical_rank: index + 1,
        visual_rank: null,
        visual_score: null,
        fused_score: 1 / (RRF_K + index + 1),
      },
    }));
}

function searchError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}
