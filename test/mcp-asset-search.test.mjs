import assert from "node:assert/strict";
import test from "node:test";

import { searchMcpAssets } from "../lib/mcp-asset-search.mjs";

function lexicalStore(assets, filtersSeen) {
  return {
    async listAssetPage(filters) {
      if (filtersSeen) filtersSeen.push(filters);
      return { assets, page: { nextCursor: null } };
    },
  };
}

test("MCP asset search returns lexical results while honoring time bounds", async () => {
  const assets = [
    { id: "lexical", prompt: "red poster", created_at: "2026-09-20T10:00:00.000Z" },
    { id: "shared", prompt: "poster", created_at: "2026-09-21T10:00:00.000Z" },
  ];
  const filtersSeen = [];
  const result = await searchMcpAssets({
    store: lexicalStore(assets, filtersSeen),
    projectId: "default",
    query: "red poster",
    createdAfter: "2026-09-15T00:00:00.000Z",
    limit: 10,
  });
  assert.equal(filtersSeen[0].createdAfterMs, Date.parse("2026-09-15T00:00:00.000Z"));
  assert.deepEqual(result.results.map((item) => item.asset.id), ["lexical", "shared"]);
  assert.equal(result.results[0].match.lexical_rank, 1);
  assert.equal(result.results[0].match.visual_rank, null);
  assert.equal(result.results[0].match.visual_score, null);
});

test("legacy visual:true clients keep getting lexical results without an error", async () => {
  const assets = [
    { id: "lexical", prompt: "red poster", created_at: "2026-09-20T10:00:00.000Z" },
    { id: "shared", prompt: "poster", created_at: "2026-09-21T10:00:00.000Z" },
  ];
  const result = await searchMcpAssets({
    store: lexicalStore(assets),
    projectId: "default",
    query: "red poster",
    visual: true,
    limit: 10,
  });
  assert.deepEqual(result.results.map((item) => item.asset.id), ["lexical", "shared"]);
  assert.equal(result.visual.requested, true);
  assert.equal(result.visual.available, false);
  assert.equal(result.visual.reason, "removed");
  assert.equal(result.results.every((item) => item.match.visual_rank === null), true);
});

test("visual stays not-requested when the flag is absent", async () => {
  const result = await searchMcpAssets({
    store: lexicalStore([{ id: "a", prompt: "poster", created_at: "2026-09-20T10:00:00.000Z" }]),
    query: "poster",
  });
  assert.deepEqual(result.visual, { requested: false, available: false, reason: "not-requested" });
});

test("MCP asset search rejects inverted time ranges", async () => {
  await assert.rejects(() => searchMcpAssets({
    store: { listAssetPage: async () => ({ assets: [], page: {} }) },
    createdAfter: "2026-09-20T00:00:00.000Z",
    createdBefore: "2026-09-19T00:00:00.000Z",
  }), (error) => error?.code === "ASSET_TIME_RANGE_INVALID");
});
