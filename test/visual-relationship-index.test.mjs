import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createVisualRelationshipIndex,
  visualRelationshipIndexPath,
  visualRelationshipLibraryKey,
} from "../lib/visual-relationship-index.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const MODEL = { id: "example/vision", revision: "r1", dimension: 3 };
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

test("visual relationship index lives under userData and namespaces libraries", () => {
  const first = visualRelationshipIndexPath({ userDataDir: "/tmp/user-data", libraryDir: "/tmp/library-a" });
  const second = visualRelationshipIndexPath({ userDataDir: "/tmp/user-data", libraryDir: "/tmp/library-b" });
  assert.match(first, /visual-relationship-indexes/);
  assert.notEqual(first, second);
  assert.equal(visualRelationshipLibraryKey("/tmp/library-a").length, 24);
});

test("visual relationship index tracks missing, current, and stale derived embeddings", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-visual-index-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const index = createVisualRelationshipIndex({ databasePath: join(root, "index.sqlite") });
  try {
    assert.equal(index.embeddingState("default", "asset-a", { ...MODEL, contentSha256: HASH_A }).state, "missing");
    index.upsertEmbedding("default", "asset-a", { ...MODEL, contentSha256: HASH_A, vector: [1, 0, 0] });
    assert.equal(index.embeddingState("default", "asset-a", { ...MODEL, contentSha256: HASH_A }).state, "current");
    const stale = index.embeddingState("default", "asset-a", { ...MODEL, contentSha256: HASH_B });
    assert.equal(stale.state, "stale");
    assert.equal(stale.reason, "content");
  } finally {
    index.close();
  }
});

test("visual relationship index provides image-to-image exact similarity without model inference in the query path", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-visual-index-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const index = createVisualRelationshipIndex({ databasePath: join(root, "index.sqlite") });
  try {
    index.upsertEmbedding("default", "anchor", { ...MODEL, contentSha256: HASH_A, vector: [1, 0, 0] });
    index.upsertEmbedding("default", "near", { ...MODEL, contentSha256: HASH_B, vector: [0.98, 0.2, 0] });
    index.upsertEmbedding("default", "other", { ...MODEL, contentSha256: "c".repeat(64), vector: [0, 1, 0] });
    const similar = index.similarToAsset("default", "anchor", { ...MODEL, limit: 2 });
    assert.deepEqual(similar.map((item) => item.asset_id), ["near", "other"]);
    assert.ok(similar[0].score > similar[1].score);
    assert.ok(similar.every((item) => item.asset_id !== "anchor"));
  } finally {
    index.close();
  }
});

test("visual relationship index invalidates its in-memory matrix after writes and supports derived-data cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-visual-index-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const index = createVisualRelationshipIndex({ databasePath: join(root, "index.sqlite") });
  try {
    index.upsertEmbedding("default", "a", { ...MODEL, contentSha256: HASH_A, vector: [1, 0, 0] });
    index.upsertEmbedding("default", "b", { ...MODEL, contentSha256: HASH_B, vector: [0, 1, 0] });
    assert.equal(index.querySimilar("default", [1, 0, 0], { ...MODEL, limit: 10 }).length, 2);
    index.upsertEmbedding("default", "c", { ...MODEL, contentSha256: "c".repeat(64), vector: [0.9, 0.1, 0] });
    assert.deepEqual(index.querySimilar("default", [1, 0, 0], { ...MODEL, limit: 3 }).map((item) => item.asset_id), ["a", "c", "b"]);
    assert.equal(index.deleteAsset("default", "a"), 1);
    assert.deepEqual(index.querySimilar("default", [1, 0, 0], { ...MODEL, limit: 3 }).map((item) => item.asset_id), ["c", "b"]);
    assert.equal(index.pruneAssets("default", ["b", "missing"]), 1);
    assert.deepEqual(index.querySimilar("default", [1, 0, 0], { ...MODEL, limit: 3 }).map((item) => item.asset_id), ["c"]);
    assert.equal(index.clearModel("default", MODEL), 1);
    assert.equal(index.indexStatus("default", MODEL).count, 0);
  } finally {
    index.close();
  }
});

test("visual relationship index rejects malformed vectors instead of corrupting the derived cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-visual-index-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const index = createVisualRelationshipIndex({ databasePath: join(root, "index.sqlite") });
  try {
    assert.throws(() => index.upsertEmbedding("default", "bad", { ...MODEL, contentSha256: HASH_A, vector: [1, 0] }), /length/);
    assert.throws(() => index.upsertEmbedding("default", "bad", { ...MODEL, contentSha256: HASH_A, vector: [0, 0, 0] }), /zeroes/);
  } finally {
    index.close();
  }
});

test("visual relationship index adopts an index left in the old nested directory", async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), "mosa-visual-index-legacy-"));
  deferTestPathRemoval(userDataDir, { recursive: true, force: true });
  const libraryDir = join(userDataDir, "library");
  const key = visualRelationshipLibraryKey(libraryDir);
  const legacyRoot = join(userDataDir, "visual-relationship-indexes", "visual-relationship-indexes");
  const legacy = createVisualRelationshipIndex({
    databasePath: join(legacyRoot, key, "visual-relationships.sqlite"),
  });
  legacy.upsertEmbedding("default", "asset-a", { ...MODEL, contentSha256: HASH_A, vector: [1, 0, 0] });
  legacy.close();

  const index = createVisualRelationshipIndex({ userDataDir, libraryDir });
  try {
    assert.equal(index.databasePath, visualRelationshipIndexPath({ userDataDir, libraryDir }));
    assert.equal(index.indexStatus("default", MODEL).count, 1);
    assert.equal(existsSync(legacyRoot), false);
  } finally {
    index.close();
  }
});

test("visual relationship index keeps the current index when an old nested one also exists", async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), "mosa-visual-index-both-"));
  deferTestPathRemoval(userDataDir, { recursive: true, force: true });
  const libraryDir = join(userDataDir, "library");
  const key = visualRelationshipLibraryKey(libraryDir);
  const current = createVisualRelationshipIndex({ userDataDir, libraryDir });
  current.close();
  const legacyPath = join(userDataDir, "visual-relationship-indexes", "visual-relationship-indexes", key, "visual-relationships.sqlite");
  const legacy = createVisualRelationshipIndex({ databasePath: legacyPath });
  legacy.upsertEmbedding("default", "asset-a", { ...MODEL, contentSha256: HASH_A, vector: [1, 0, 0] });
  legacy.close();

  const index = createVisualRelationshipIndex({ userDataDir, libraryDir });
  try {
    assert.equal(index.indexStatus("default", MODEL).count, 0);
    assert.equal(existsSync(legacyPath), true);
  } finally {
    index.close();
  }
});
