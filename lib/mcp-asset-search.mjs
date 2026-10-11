import { resolve } from "node:path";

import { normalizeAssetTimeRange } from "./asset-time-filter.mjs";
import { createdAtTimestamp } from "./recent-window.js";
import { DEFAULT_MOSA_DISCOVERY_PORTS, normalizeMosaPort } from "./runtime-defaults.mjs";

const RRF_K = 60;

export async function searchMcpAssets({
  store,
  libraryDir,
  projectId = "default",
  query = "",
  createdAfter,
  createdBefore,
  visual = false,
  limit = 20,
  minScore,
  port,
  ports,
  fetchImpl = globalThis.fetch,
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

  let visualState = { requested: Boolean(visual), available: false, reason: visual ? "not-attempted" : "not-requested" };
  let visualRows = [];
  if (visual && cleanQuery) {
    const visualResult = await searchVisualViaLocalRuntime({
      query: cleanQuery,
      projectId,
      limit: candidateLimit,
      minScore,
      libraryDir,
      port,
      ports,
      fetchImpl,
    });
    visualState = {
      requested: true,
      available: visualResult.available,
      reason: visualResult.reason || null,
      model: visualResult.model || null,
    };
    if (visualResult.available) {
      visualRows = await hydrateVisualRows(store, projectId, visualResult.results, range);
    }
  } else if (visual) {
    visualState = { requested: true, available: false, reason: "query-required" };
  }

  const merged = fuseResults(lexical, visualRows).slice(0, boundedLimit);
  return {
    query: cleanQuery,
    project_id: projectId,
    filters: {
      created_after: range.createdAfterMs == null ? null : new Date(range.createdAfterMs).toISOString(),
      created_before: range.createdBeforeMs == null ? null : new Date(range.createdBeforeMs).toISOString(),
    },
    visual: visualState,
    results: merged,
  };
}

// Candidate ports for finding the local runtime: an explicit list, an
// explicit single port, MOSA_PORT, then every discovery port the desktop
// service manager itself scans. A probe failure on one port is not a verdict
// about the runtime — it may simply live on the next port.
function resolveRuntimePortCandidates({ port, ports } = {}) {
  const raw = Array.isArray(ports) && ports.length > 0
    ? ports
    : (port != null && port !== "" ? [port] : null);
  const candidates = raw ?? (process.env.MOSA_PORT ? [process.env.MOSA_PORT] : DEFAULT_MOSA_DISCOVERY_PORTS);
  const valid = [];
  for (const value of candidates) {
    try {
      valid.push(normalizeMosaPort(value, { label: "GravityPort visual-search port" }));
    } catch {
      // Skip malformed candidates; the caller learns via the final verdict.
    }
  }
  return [...new Set(valid)];
}

export async function searchVisualViaLocalRuntime({
  query,
  projectId = "default",
  limit = 20,
  minScore,
  libraryDir,
  port,
  ports,
  fetchImpl = globalThis.fetch,
  timeoutMs = 2000,
} = {}) {
  if (typeof fetchImpl !== "function") return { available: false, reason: "fetch-unavailable", results: [] };
  const candidates = resolveRuntimePortCandidates({ port, ports });
  if (candidates.length === 0) return { available: false, reason: "runtime-port-invalid", results: [] };
  const signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(Math.max(250, timeoutMs)) : undefined;

  let lastReason = "runtime-unreachable";
  for (const safePort of candidates) {
    const baseUrl = `http://127.0.0.1:${safePort}`;
    try {
      const healthResponse = await fetchImpl(`${baseUrl}/api/health`, { method: "GET", signal });
      if (!healthResponse?.ok) {
        lastReason = "runtime-health-unavailable";
        continue;
      }
      const health = await healthResponse.json();
      if (health?.product !== "mosa") {
        lastReason = "runtime-identity-mismatch";
        continue;
      }
      if (!sameLocalPath(health.libraryDir, libraryDir)) {
        // A healthy MOSA runtime serving another library is not this library's
        // runtime — keep scanning the remaining discovery ports.
        lastReason = "runtime-library-mismatch";
        continue;
      }

      const params = new URLSearchParams({ project: projectId, q: query, limit: String(limit) });
      if (minScore != null && minScore !== "") params.set("minScore", String(minScore));
      const response = await fetchImpl(`${baseUrl}/api/visual/search?${params}`, { method: "GET", signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        return { available: false, reason: body.code || `http-${response.status}`, results: [] };
      }
      return {
        available: true,
        reason: null,
        model: body.model || null,
        results: Array.isArray(body.results) ? body.results : [],
      };
    } catch (error) {
      lastReason = error?.name === "TimeoutError" ? "runtime-timeout" : "runtime-unreachable";
    }
  }
  return { available: false, reason: lastReason, results: [] };
}

async function hydrateVisualRows(store, projectId, rows, range) {
  const hydrated = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const assetId = String(row?.asset_id || "").trim();
    if (!assetId) continue;
    try {
      const asset = await store.getAsset(projectId, assetId);
      const created = createdAtTimestamp(asset?.created_at);
      if (range.createdAfterMs != null && (!Number.isFinite(created) || created < range.createdAfterMs)) continue;
      if (range.createdBeforeMs != null && (!Number.isFinite(created) || created > range.createdBeforeMs)) continue;
      hydrated.push({ asset, score: Number(row.score), asset_id: assetId });
    } catch (error) {
      if (error?.code === "ASSET_NOT_FOUND" || /not found/i.test(String(error?.message || error))) continue;
      throw error;
    }
  }
  return hydrated;
}

function fuseResults(lexicalAssets, visualRows) {
  const byId = new Map();
  lexicalAssets.forEach((asset, index) => {
    if (!asset?.id) return;
    byId.set(asset.id, {
      asset,
      lexical_rank: index + 1,
      visual_rank: null,
      visual_score: null,
      fused_score: 1 / (RRF_K + index + 1),
    });
  });
  visualRows.forEach((row, index) => {
    const id = row?.asset?.id || row?.asset_id;
    if (!id) return;
    const existing = byId.get(id) || {
      asset: row.asset,
      lexical_rank: null,
      visual_rank: null,
      visual_score: null,
      fused_score: 0,
    };
    existing.asset = existing.asset || row.asset;
    existing.visual_rank = index + 1;
    existing.visual_score = Number.isFinite(row.score) ? row.score : null;
    existing.fused_score += 1 / (RRF_K + index + 1);
    byId.set(id, existing);
  });
  return [...byId.values()]
    .sort((left, right) => right.fused_score - left.fused_score
      || (left.lexical_rank ?? Number.MAX_SAFE_INTEGER) - (right.lexical_rank ?? Number.MAX_SAFE_INTEGER)
      || String(left.asset?.id || "").localeCompare(String(right.asset?.id || "")))
    .map((item) => ({
      asset: item.asset,
      match: {
        lexical_rank: item.lexical_rank,
        visual_rank: item.visual_rank,
        visual_score: item.visual_score,
        fused_score: Number(item.fused_score.toFixed(8)),
      },
    }));
}

function sameLocalPath(left, right) {
  if (!left || !right) return false;
  const a = resolve(String(left));
  const b = resolve(String(right));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function searchError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}
