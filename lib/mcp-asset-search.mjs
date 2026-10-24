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
  limit = 20,
} = {}) {
  if (!store || typeof store.listAssetPage !== "function") throw new Error("MCP asset search requires a paged asset store.");
  const cleanQuery = String(query || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const range = normalizeAssetTimeRange({ createdAfter, createdBefore });
  if (!cleanQuery && range.createdAfterMs == null && range.createdBeforeMs == null) {
    throw searchError("asset_search requires query, createdAfter, or createdBefore.", "MCP_ASSET_SEARCH_EMPTY");
  }
  const boundedLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const candidateLimit = Math.min(Math.max(boundedLimit * 3, boundedLimit), 250);
  const lexicalPage = await store.listAssetPage({
    projectId,
    query: cleanQuery,
    limit: candidateLimit,
    includeTotal: false,
    createdAfterMs: range.createdAfterMs,
    createdBeforeMs: range.createdBeforeMs,
  });
  const lexical = Array.isArray(lexicalPage?.assets) ? lexicalPage.assets : [];

  return {
    query: cleanQuery,
    project_id: projectId,
    filters: {
      created_after: range.createdAfterMs == null ? null : new Date(range.createdAfterMs).toISOString(),
      created_before: range.createdBeforeMs == null ? null : new Date(range.createdBeforeMs).toISOString(),
    },
    visual: { requested: Boolean(visual), available: false, reason: visual ? "removed" : "not-requested" },
    results: rankLexicalResults(lexical).slice(0, boundedLimit),
  };
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
