import assert from "node:assert/strict";
import test from "node:test";

import { createVisualEmbeddingWorker } from "../lib/visual-embedding-worker.mjs";

test("visual embedding worker incrementally indexes missing assets and skips current embeddings", async () => {
  const recorded = [];
  const states = new Map([["current", "current"]]);
  let listed = 0;
  const worker = createVisualEmbeddingWorker({
    provider: {
      async encodeImage(path) {
        return path.endsWith("missing.png") ? [1, 0] : [0, 1];
      },
    },
    relationshipService: {
      embeddingState(_projectId, assetId) { return { state: states.get(assetId) || "missing" }; },
      recordEmbedding(_projectId, assetId, value) { recorded.push([assetId, value.vector]); states.set(assetId, "current"); },
    },
    async listCandidates() {
      listed += 1;
      if (listed > 1) return [];
      return [
        { assetId: "current", imagePath: "/tmp/current.png", contentSha256: "a".repeat(64) },
        { assetId: "missing", imagePath: "/tmp/missing.png", contentSha256: "b".repeat(64) },
      ];
    },
  });
  await worker.start();
  assert.deepEqual(recorded, [["missing", [1, 0]]]);
  assert.deepEqual(worker.status(), {
    state: "idle",
    processed: 2,
    indexed: 1,
    skipped: 1,
    failed: 0,
    last_error: "",
  });
});

test("visual embedding worker contains per-asset failures and can pause/resume", async () => {
  let batch = 0;
  const worker = createVisualEmbeddingWorker({
    provider: {
      async encodeImage(path) {
        if (path.includes("bad")) throw new Error("decode failed");
        return [1, 0];
      },
    },
    relationshipService: {
      embeddingState() { return { state: "missing" }; },
      recordEmbedding() {},
    },
    async listCandidates() {
      batch += 1;
      if (batch > 1) return [];
      return [
        { assetId: "bad", imagePath: "/tmp/bad.png" },
        { assetId: "good", imagePath: "/tmp/good.png" },
      ];
    },
  });
  worker.pause();
  assert.equal(worker.status().state, "paused");
  await worker.resume();
  const status = worker.status();
  assert.equal(status.processed, 2);
  assert.equal(status.indexed, 1);
  assert.equal(status.failed, 1);
  assert.match(status.last_error, /decode failed/);
  await worker.stop();
  assert.equal(worker.status().state, "stopped");
});

test("visual embedding worker drains a backlog larger than one batch in a single pass", async () => {
  const pending = Array.from({ length: 21 }, (_, index) => ({ assetId: `asset-${index}`, imagePath: `/tmp/${index}.png` }));
  const recorded = [];
  const worker = createVisualEmbeddingWorker({
    provider: { async encodeImage() { return [1, 0]; } },
    relationshipService: {
      embeddingState() { return { state: "missing" }; },
      recordEmbedding(_projectId, assetId) { recorded.push(assetId); },
    },
    batchSize: 8,
    async listCandidates({ limit }) { return pending.splice(0, limit); },
  });
  await worker.start();
  assert.equal(recorded.length, 21, "one wake indexes every pending asset, not just the first batch");
  assert.equal(worker.status().state, "idle");
});

test("visual embedding worker stops a pass on a batch where every asset failed", async () => {
  let listed = 0;
  const worker = createVisualEmbeddingWorker({
    provider: { async encodeImage() { throw new Error("decode failed"); } },
    relationshipService: {
      embeddingState() { return { state: "missing" }; },
      recordEmbedding() {},
    },
    batchSize: 2,
    // A failing asset is never current, so the backlog would hand it out again forever.
    async listCandidates() { listed += 1; return [{ assetId: "bad", imagePath: "/tmp/bad.png" }]; },
  });
  await worker.start();
  assert.equal(listed, 1, "no hot loop on assets that keep failing");
  assert.equal(worker.status().failed, 1);
});
