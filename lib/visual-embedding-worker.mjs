const DEFAULT_BATCH_SIZE = 8;

export function createVisualEmbeddingWorker({
  provider,
  relationshipService,
  listCandidates,
  batchSize = DEFAULT_BATCH_SIZE,
  onStatus,
} = {}) {
  validateProvider(provider);
  if (!relationshipService || typeof relationshipService.embeddingState !== "function" || typeof relationshipService.recordEmbedding !== "function") {
    throw new Error("Visual embedding worker requires a relationship service.");
  }
  if (typeof listCandidates !== "function") throw new Error("Visual embedding worker requires listCandidates.");
  const size = positiveInteger(batchSize, DEFAULT_BATCH_SIZE, 100);

  let running = false;
  let paused = false;
  let stopped = false;
  let wakeRequested = false;
  let loopPromise = null;
  let status = {
    state: "idle",
    processed: 0,
    indexed: 0,
    skipped: 0,
    failed: 0,
    last_error: "",
  };

  function publish(patch = {}) {
    status = { ...status, ...patch };
    onStatus?.({ ...status });
  }

  async function runLoop() {
    if (running || stopped) return;
    running = true;
    publish({ state: paused ? "paused" : "running", last_error: "" });
    try {
      // Keep draining the backlog batch after batch. A batch in which every
      // candidate failed ends the pass (those assets come back on every
      // backlog rebuild, so continuing would spin on them); the next wake
      // retries.
      let progressed = false;
      do {
        wakeRequested = false;
        progressed = false;
        if (paused || stopped) break;
        const candidates = await listCandidates({ limit: size });
        if (!Array.isArray(candidates) || !candidates.length) break;
        for (const candidate of candidates) {
          if (paused || stopped) break;
          const projectId = String(candidate?.projectId || candidate?.project_id || "default");
          const assetId = String(candidate?.assetId || candidate?.asset_id || "");
          const imagePath = String(candidate?.imagePath || candidate?.image_path || "");
          const contentSha256 = String(candidate?.contentSha256 || candidate?.content_sha256 || "");
          if (!assetId || !imagePath) {
            publish({ processed: status.processed + 1, failed: status.failed + 1, last_error: "Visual embedding candidate is missing asset id or image path." });
            continue;
          }
          try {
            const current = relationshipService.embeddingState(projectId, assetId, contentSha256);
            if (current?.state === "current") {
              publish({ processed: status.processed + 1, skipped: status.skipped + 1 });
              progressed = true;
              continue;
            }
            const vector = await provider.encodeImage(imagePath, { projectId, assetId, contentSha256 });
            relationshipService.recordEmbedding(projectId, assetId, { contentSha256, vector });
            publish({ processed: status.processed + 1, indexed: status.indexed + 1 });
            progressed = true;
          } catch (error) {
            publish({
              processed: status.processed + 1,
              failed: status.failed + 1,
              last_error: String(error?.message || error),
            });
          }
        }
      } while ((progressed || wakeRequested) && !paused && !stopped);
    } finally {
      running = false;
      publish({ state: stopped ? "stopped" : paused ? "paused" : "idle" });
    }
  }

  function wake() {
    if (stopped) return Promise.resolve();
    wakeRequested = true;
    if (!loopPromise || !running) {
      loopPromise = runLoop().finally(() => { loopPromise = null; });
    }
    return loopPromise;
  }

  return {
    start() {
      paused = false;
      stopped = false;
      return wake();
    },
    wake,
    pause() {
      paused = true;
      publish({ state: running ? "pausing" : "paused" });
    },
    resume() {
      paused = false;
      return wake();
    },
    async stop() {
      stopped = true;
      paused = false;
      if (loopPromise) await loopPromise;
      publish({ state: "stopped" });
    },
    status() {
      return { ...status };
    },
  };
}

function validateProvider(provider) {
  if (!provider || typeof provider.encodeImage !== "function") {
    throw new Error("Visual embedding worker requires a provider with encodeImage.");
  }
}

function positiveInteger(value, fallback, max) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(max, number) : fallback;
}
