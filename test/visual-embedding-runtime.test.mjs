import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createVisualEmbeddingRuntime } from "../lib/visual-embedding-runtime.mjs";
import { createVisualRelationshipIndex, visualRelationshipIndexPath } from "../lib/visual-relationship-index.mjs";

function fakePack(overrides = {}) {
  return {
    ok: true,
    id: "fake-pack",
    revision: "rev-1",
    model_type: "image-text-embedding",
    embedding_dimension: 4,
    pack_dir: "/tmp/unused",
    total_bytes: 100,
    license: { id: "apache-2.0", source: "https://example.invalid", commercial_product_use: true },
    files: [],
    ...overrides,
  };
}

function fakeStore({ assets }) {
  return {
    async listProjects() {
      return ["default"];
    },
    async listAssets() {
      return assets;
    },
    async getAsset(_projectId, assetId) {
      const asset = assets.find((item) => item.id === assetId);
      return asset ? { ...asset } : (() => { throw new Error("ASSET_NOT_FOUND"); })();
    },
    async libraryRevision() {
      return "1";
    },
  };
}

function fakeClient({ vectors, dimension = 4 } = {}) {
  const state = { ready: false };
  const client = {
    get state() { return state.ready ? "ready" : "dead"; },
    isReady: () => state.ready,
    isRunning: () => state.ready,
    model: { id: "fake-pack", revision: "rev-1", dimension },
    start: async () => {
      state.ready = true;
      return client.model;
    },
    restart: async () => {
      state.ready = true;
      return client.model;
    },
    close: async () => { state.ready = false; },
    encodeImage: async (imagePath) => vectors(imagePath),
    encodeText: async (text) => vectors(text),
    requestStatus: async () => ({ initialized: true, memory: 1, uptime: 1 }),
  };
  return client;
}

function tempUserData() {
  return mkdtemp(join(tmpdir(), "mosa-visual-runtime-"));
}

test("runtime reports not-installed without packs and stays fully fail-closed", async () => {
  const userDataDir = await tempUserData();
  try {
    const runtime = await createVisualEmbeddingRuntime({
      store: fakeStore({ assets: [] }),
      libraryDir: userDataDir,
      userDataDir,
      settings: { enabled: true },
      discoverPacks: async () => ({ root: userDataDir, packs: [], invalid: [] }),
    });
    assert.equal(runtime.state, "not-installed");
    assert.equal(runtime.service, null);
    await runtime.close();
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("runtime reports disabled when settings keep the pack off", async () => {
  const userDataDir = await tempUserData();
  try {
    const runtime = await createVisualEmbeddingRuntime({
      store: fakeStore({ assets: [] }),
      libraryDir: userDataDir,
      userDataDir,
      settings: { enabled: false },
      discoverPacks: async () => ({ root: userDataDir, packs: [fakePack()], invalid: [] }),
    });
    assert.equal(runtime.state, "disabled");
    assert.equal(runtime.service, null);
    await runtime.close();
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("runtime indexes candidate assets through the client and serves text search", async () => {
  const userDataDir = await tempUserData();
  try {
    const assets = [
      { id: "asset-a", image_path: "/tmp/a.png", source: { content_sha256: "a".repeat(64) } },
      { id: "asset-b", image_path: "/tmp/b.png", source: { content_sha256: "b".repeat(64) } },
    ];
    const runtime = await createVisualEmbeddingRuntime({
      store: fakeStore({ assets }),
      libraryDir: join(userDataDir, "library"),
      userDataDir,
      settings: { enabled: true },
      discoverPacks: async () => ({ root: userDataDir, packs: [fakePack()], invalid: [] }),
      clientFactory: () => {
        const encodeImage = async (imagePath) => (String(imagePath).endsWith("a.png") ? [1, 0, 0, 0] : [0, 1, 0, 0]);
        const encodeText = async (text) => (String(text).endsWith("a") ? [1, 0, 0, 0] : [0, 1, 0, 0]);
        const client = fakeClient({ vectors: encodeImage });
        return { ...client, encodeText };
      },
    });
    assert.equal(
      runtime.index.databasePath,
      visualRelationshipIndexPath({ userDataDir, libraryDir: join(userDataDir, "library") }),
    );
    assert.equal(runtime.state, "ready");
    await runtime.worker.start();
    await runtime.worker.stop();
    const status = runtime.index.indexStatus("default", runtime.model);
    assert.equal(status.count, 2);

    // text -> image over the recorded vectors
    const results = await runtime.service.searchByText("default", "query-for-a", { limit: 2 });
    assert.equal(results[0].asset_id, "asset-a");
    assert.ok(Number(results[0].score) >= 0.999);

    // image -> similar
    const similar = await runtime.service.similarAssets("default", "asset-a", { limit: 2 });
    assert.equal(similar[0].asset_id, "asset-b");
    assert.equal(runtime.index.databasePath.includes(userDataDir), true);
    const client = runtime.client;
    await runtime.close();
    assert.equal(client.isRunning(), false);
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("runtime stops feeding the worker when the client is dead (fail closed)", async () => {
  const userDataDir = await tempUserData();
  try {
    let encodeCalls = 0;
    const runtime = await createVisualEmbeddingRuntime({
      store: fakeStore({
        assets: [{ id: "asset-a", image_path: "/tmp/a.png", source: { content_sha256: "a".repeat(64) } }],
      }),
      libraryDir: join(userDataDir, "library"),
      userDataDir,
      settings: { enabled: true },
      discoverPacks: async () => ({ root: userDataDir, packs: [fakePack()], invalid: [] }),
      clientFactory: () => {
        const client = fakeClient({ vectors: () => [1, 0, 0, 0] });
        return {
          ...client,
          // A client whose runtime can never start: the backlog must idle out
          // without calling encode and without hot-looping.
          start: async () => { throw new Error("runtime unavailable"); },
          restart: async () => { throw new Error("runtime unavailable"); },
          encodeImage: async () => {
            encodeCalls += 1;
            throw new Error("worker is gone");
          },
        };
      },
    });
    // Start with a dead client: the worker must idle out without hot-looping
    // and the index must stay empty.
    await runtime.client.close();
    await runtime.worker.start();
    await runtime.worker.stop();
    assert.equal(encodeCalls, 0);
    assert.equal(runtime.index.indexStatus("default", runtime.model).count, 0);
    await runtime.close();
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("runtime prunes stale embeddings when assets disappear from the library", async () => {
  const userDataDir = await tempUserData();
  const model = { id: "fake-pack", revision: "rev-1", dimension: 4 };
  const index = createVisualRelationshipIndex({
    userDataDir: join(userDataDir, "indexes"),
    libraryDir: join(userDataDir, "library"),
  });
  index.upsertEmbedding("default", "asset-gone", { ...model, contentSha256: "c".repeat(64), vector: [1, 0, 0, 0] });
  index.close();
  try {
    const runtime = await createVisualEmbeddingRuntime({
      store: fakeStore({ assets: [] }),
      libraryDir: join(userDataDir, "library"),
      userDataDir,
      settings: { enabled: true },
      discoverPacks: async () => ({ root: userDataDir, packs: [fakePack()], invalid: [] }),
      clientFactory: () => fakeClient({ vectors: () => [1, 0, 0, 0] }),
      indexFactory: () => createVisualRelationshipIndex({
        userDataDir: join(userDataDir, "indexes"),
        libraryDir: join(userDataDir, "library"),
      }),
    });
    const status = runtime.index.indexStatus("default", runtime.model);
    assert.equal(status.count, 1);
    const removed = await runtime.service.removeAsset("default", "asset-gone");
    assert.equal(removed, 1);
    await runtime.close();
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});
