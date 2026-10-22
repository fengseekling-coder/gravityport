// Wires the MOSA-local visual stack into a live runtime: verified model pack
// -> inference child process -> validated provider -> relationship index ->
// background embedding worker -> visual relationship service.
//
// Construction is fail-closed: with no pack or disabled settings, callers get
// a runtime whose `state` explains the situation and every model-dependent
// capability stays unavailable. All derived data lives under userData (packs
// + relationship indexes), never in MOSA Library.
import { createVisualInferenceClient, visualInferenceError } from "./visual-inference-client.mjs";
import { createVisualEmbeddingWorker } from "./visual-embedding-worker.mjs";
import {
  createVisualRelationshipIndex,
  visualRelationshipIndexRoot,
} from "./visual-relationship-index.mjs";
import { createVisualRelationshipService } from "./visual-relationship-service.mjs";
import { discoverVisualModelPacks } from "./visual-model-pack.mjs";

const BACKLOG_SCAN_LIMIT = 4000;
const RESTART_RETRY_MS = 60_000;
const CHANGE_POLL_MS = 30_000;

export async function createVisualEmbeddingRuntime({
  store,
  libraryDir,
  userDataDir,
  settings = null,
  listCandidateAssets = null,
  maxQueue = 16,
  timeoutMs = 30_000,
  discoverPacks = discoverVisualModelPacks,
  indexFactory = null,
  clientFactory = createVisualInferenceClient,
} = {}) {
  if (!store) throw new Error("Visual embedding runtime requires the asset store.");
  if (!libraryDir) throw new Error("Visual embedding runtime requires the library directory.");
  if (!userDataDir) throw new Error("Visual embedding runtime requires the userData directory.");

  const discovery = await discoverPacks({ userDataDir });
  const enabled = settings?.enabled === true;
  const active = resolveActivePack(discovery, settings);
  let changePollTimer = null;
  let backlog = null;

  const runtime = {
    state: !active ? "not-installed" : !enabled ? "disabled" : "loading",
    model: null,
    service: null,
    provider: null,
    worker: null,
    client: null,
    index: null,
    pack: active ? summarizePack(active) : null,
    invalidPacks: discovery.invalid,
    wake: () => {},
    startChangePolling,
    async close() {
      if (changePollTimer) {
        clearInterval(changePollTimer);
        changePollTimer = null;
      }
      backlog?.cancel();
      if (runtime.worker) await runtime.worker.stop().catch(() => {});
      if (runtime.client) await runtime.client.close().catch(() => {});
      if (runtime.index) runtime.index.close();
      runtime.worker = null;
      runtime.client = null;
      runtime.service = null;
      runtime.index = null;
    },
  };
  if (!active || !enabled) return runtime;

  // The index is keyed by the pack's own identity; settings can never make a
  // different model's vectors silently land in the same space.
  const model = Object.freeze({
    id: active.id,
    revision: active.revision,
    dimension: active.embedding_dimension,
  });
  runtime.model = model;
  runtime.index = indexFactory
    ? indexFactory({ userDataDir, libraryDir, model })
    : createVisualRelationshipIndex({ userDataDir, libraryDir });
  const client = clientFactory({ pack: active, model, maxQueue, timeoutMs });
  runtime.client = client;

  const provider = {
    model,
    async start() {
      await client.start();
    },
    encodeImage(imagePath, context = {}) {
      return client.encodeImage(imagePath, context);
    },
    encodeText(text, context = {}) {
      return client.encodeText(text, context);
    },
    async close() {
      await client.close().catch(() => {});
    },
  };
  runtime.provider = provider;

  const service = createVisualRelationshipService({
    index: runtime.index,
    model,
    assetStore: store,
    provider,
  });
  runtime.service = service;

  backlog = createBacklog();
  const worker = createVisualEmbeddingWorker({
    provider,
    relationshipService: service,
    listCandidates: backlog.next,
    batchSize: Math.max(1, Math.min(8, maxQueue)),
  });
  runtime.worker = worker;
  runtime.state = "ready";
  runtime.wake = () => {
    backlog.invalidate();
    worker.wake();
  };
  let lastRevisionToken = null;
  return runtime;

  // Imports bump the store's per-project journal revision (an O(1) SQLite
  // counter). Polling it keeps import→embedding latency bounded without
  // rescanning the asset list while idle.
  function startChangePolling() {
    if (changePollTimer || !store || typeof store.listProjects !== "function") return;
    changePollTimer = setInterval(() => {
      pollChanges().catch(() => {});
    }, CHANGE_POLL_MS);
    if (changePollTimer.unref) changePollTimer.unref();
  }

  async function pollChanges() {
    if (runtime.state !== "ready" || !runtime.client?.isRunning()) return;
    if (typeof store.libraryRevision !== "function") return;
    const projects = await store.listProjects();
    const revisions = [];
    for (const projectId of projects) {
      revisions.push(`${projectId}:${await store.libraryRevision(projectId)}`);
    }
    const token = revisions.join("|");
    if (lastRevisionToken === null) {
      lastRevisionToken = token;
      return;
    }
    if (token === lastRevisionToken) return;
    lastRevisionToken = token;
    runtime.wake();
  }

  function summarizePack(pack) {
    return {
      id: pack.id,
      revision: pack.revision,
      dimension: pack.embedding_dimension,
      embedding_dimension: pack.embedding_dimension,
      total_bytes: pack.total_bytes,
      license: pack.license,
      pack_dir: pack.pack_dir,
    };
  }

  function resolveActivePack(discoveryResult, runtimeSettings) {
    if (!discoveryResult.packs.length) return null;
    if (runtimeSettings?.active_pack_id) {
      const selected = discoveryResult.packs.find((pack) =>
        pack.id === runtimeSettings.active_pack_id && pack.revision === runtimeSettings.active_revision);
      if (selected) return selected;
    }
    return discoveryResult.packs[0] || null;
  }

  function createBacklog() {
    let queue = null;
    let building = null;
    let restartTimer = null;

    async function rebuild() {
      if (building) return building;
      building = (async () => {
        const candidates = await (listCandidateAssets || defaultListCandidateAssets(store))({ limit: BACKLOG_SCAN_LIMIT });
        const pending = [];
        for (const candidate of candidates) {
          const known = runtime.index.embeddingState(candidate.projectId || "default", candidate.assetId, {
            id: model.id,
            revision: model.revision,
            dimension: model.dimension,
            contentSha256: candidate.contentSha256 || "",
          });
          if (known.state === "current") continue;
          pending.push(candidate);
        }
        queue = pending;
        return pending.length;
      })().finally(() => {
        building = null;
      });
      return building;
    }

    function scheduleRestart() {
      if (restartTimer || runtime.state !== "ready") return;
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (runtime.state !== "ready") return;
        // One bounded self-healing attempt per cycle; the wake below drives
        // the next backlog check whether or not the restart succeeded.
        runtime.client.restart().catch(() => {}).finally(() => {
          worker.wake();
        });
      }, RESTART_RETRY_MS);
      if (typeof restartTimer.unref === "function") restartTimer.unref();
    }

    let startingClient = null;
    function ensureClientRunning() {
      if (!startingClient) {
        startingClient = (async () => {
          try {
            await runtime.client.start();
            return runtime.client.isRunning();
          } catch {
            return false;
          } finally {
            startingClient = null;
          }
        })();
      }
      return startingClient;
    }

    return {
      invalidate() {
        queue = null;
      },
      cancel() {
        if (restartTimer) {
          clearTimeout(restartTimer);
          restartTimer = null;
        }
      },
      async next({ limit }) {
        if (runtime.client && !runtime.client.isRunning()) {
          // Lazily bring the inference worker up on the first backlog pass;
          // if the runtime cannot start, fail closed without a hot failure
          // loop and schedule one bounded retry.
          const running = await ensureClientRunning();
          if (!running) {
            scheduleRestart();
            return [];
          }
        }
        if (!queue || queue.length === 0) {
          await rebuild();
        }
        if (!queue || queue.length === 0) return [];
        return queue.splice(0, limit);
      },
    };
  }
}

function defaultListCandidateAssets(store) {
  return async ({ limit }) => {
    const projects = await store.listProjects();
    const assets = [];
    for (const projectId of projects) {
      if (assets.length >= limit) break;
      const page = await store.listAssets({ projectId, mediaKind: "img" });
      for (const asset of page) {
        if (assets.length >= limit) break;
        if (!asset.image_path) continue;
        assets.push({
          projectId,
          assetId: asset.id,
          imagePath: asset.image_path,
          contentSha256: asset.source?.content_sha256 || "",
        });
      }
    }
    return assets;
  };
}

export { visualRelationshipIndexRoot, visualInferenceError };
