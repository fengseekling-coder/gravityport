import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CURATION_NOTE_MAX_LENGTH, normalizeAssetCuration } from "../lib/asset-curation.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "mosa-curation-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const sourceDir = join(projectRoot, "generated-images");
  await mkdir(sourceDir, { recursive: true });
  const sourcePath = join(sourceDir, "asset.png");
  await writeFile(sourcePath, PIXEL);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir: join(root, "library") });
  t.after(() => store.close());
  const asset = await store.createAsset({ assetId: "curated-asset", imagePath: sourcePath, prompt: "original generation prompt", source: { type: "local-file" } });
  return { store, asset };
}

test("curation normalization is explicit and bounded", () => {
  const normalized = normalizeAssetCuration({ curated: 1, note: `  ${"x".repeat(CURATION_NOTE_MAX_LENGTH + 20)}  ` });
  assert.equal(normalized.curated, false);
  assert.equal(normalized.curation_note.length, CURATION_NOTE_MAX_LENGTH);
});

test("SQLite curation persists, is searchable, and does not create a recipe snapshot", async (t) => {
  const { store, asset } = await fixture(t);
  const before = await store.getRecipeSnapshotHistory(asset.project_id, asset.id);
  const updated = await store.updateCuration(asset.project_id, asset.id, {
    curated: true,
    curation_note: "Excellent silhouette; reuse composition, avoid the lettering.",
  });
  assert.equal(updated.curated, true);
  assert.equal(updated.curation_note, "Excellent silhouette; reuse composition, avoid the lettering.");

  const after = await store.getRecipeSnapshotHistory(asset.project_id, asset.id);
  assert.equal(after.snapshots.length, before.snapshots.length, "curation must not be recorded as a recipe edit");

  const search = await store.listAssetPage({ projectId: asset.project_id, query: "excellent silhouette", limit: 20 });
  assert.deepEqual(search.assets.map((item) => item.id), [asset.id]);
});

test("SQLite curation PATCH keeps fields the caller leaves out", async (t) => {
  const { store, asset } = await fixture(t);
  await store.updateCuration(asset.project_id, asset.id, { curated: true, curation_note: "first" });
  const noteOnly = await store.updateCuration(asset.project_id, asset.id, { curation_note: "second" });
  assert.equal(noteOnly.curated, true, "saving a note alone must not clear 整理好");
  assert.equal(noteOnly.curation_note, "second");
  const flagOnly = await store.updateCuration(asset.project_id, asset.id, { curated: false });
  assert.equal(flagOnly.curated, false);
  assert.equal(flagOnly.curation_note, "second", "toggling 整理好 must not clear the note");
  const cleared = await store.updateCuration(asset.project_id, asset.id, { curation_note: "" });
  assert.equal(cleared.curation_note, "");
});
