import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { PIXEL_HASH_VERSION, safePixelDigest } from "../lib/image-pixel-hash.js";
import { createAssetStore } from "../lib/asset-store.mjs";
import { createMcpWorkspace, startMcpServer, writePngFixture } from "./helpers/mcp-server-harness.mjs";

async function setupServerWithFixture(t, fixtureName = "fixture.png") {
  const workspace = await createMcpWorkspace(t);
  const imagePath = await writePngFixture(join(workspace.imagesDir, fixtureName), { color: "#243047" });
  const server = startMcpServer(t, workspace);
  return { workspace, imagePath, server };
}

function assertBusinessError(result, code) {
  assert.equal(result.isError, true, "the failure is a tool-level isError result");
  assert.deepEqual(result.structuredContent.error.code, code);
  assert.equal(typeof result.content?.[0]?.text, "string", "the failure carries text content");
}

test("asset_get returns the saved asset with its recipe, and reports unknown ids as ASSET_NOT_FOUND", async (t) => {
  const { imagePath, server } = await setupServerWithFixture(t);

  const created = await server.callToolStrict("asset_create", {
    assetId: "gettable",
    imagePath,
    prompt: "a red cube on marble",
    style: "editorial",
  });
  assert.equal(created.structuredContent.asset.id, "gettable");

  const fetched = await server.callToolStrict("asset_get", { assetId: "gettable" });
  const asset = fetched.structuredContent.asset;
  assert.equal(asset.id, "gettable");
  assert.equal(asset.prompt, "a red cube on marble");
  assert.equal(asset.style, "editorial");
  assert.equal(asset.image_path, created.structuredContent.asset.image_path);
  await access(asset.image_path); // the managed copy exists on disk

  const missing = await server.callTool("asset_get", { assetId: "ghost" });
  assertBusinessError(missing, "ASSET_NOT_FOUND");
});

test("asset_update_metadata persists tags, favorite, and rating without touching the prompt", async (t) => {
  const { imagePath, server } = await setupServerWithFixture(t);
  await server.callToolStrict("asset_create", { assetId: "curated", imagePath, prompt: "first prompt" });

  const updated = await server.callToolStrict("asset_update_metadata", {
    assetId: "curated",
    tags: ["alpha", "beta"],
    favorite: true,
    rating: 4,
    recipe_change_summary: "curated batch",
  });
  assert.equal(updated.structuredContent.asset.favorite, true);
  assert.equal(updated.structuredContent.asset.rating, 4);

  const fetched = await server.callToolStrict("asset_get", { assetId: "curated" });
  const asset = fetched.structuredContent.asset;
  assert.deepEqual(asset.tags, ["alpha", "beta"]);
  assert.equal(asset.favorite, true);
  assert.equal(asset.rating, 4);
  assert.equal(asset.prompt, "first prompt", "metadata edits do not rewrite the prompt");

  const missing = await server.callTool("asset_update_metadata", { assetId: "ghost", favorite: true });
  assertBusinessError(missing, "ASSET_NOT_FOUND");
});

test("asset_attach_prompt writes and replaces the full recipe of an asset", async (t) => {
  const { imagePath, server } = await setupServerWithFixture(t);
  await server.callToolStrict("asset_create", { assetId: "unprompted", imagePath });

  const before = await server.callToolStrict("asset_get", { assetId: "unprompted" });
  assert.equal(before.structuredContent.asset.prompt, "");

  await server.callToolStrict("asset_attach_prompt", { assetId: "unprompted", prompt: "attached full prompt" });
  const attached = await server.callToolStrict("asset_get", { assetId: "unprompted" });
  assert.equal(attached.structuredContent.asset.prompt, "attached full prompt");

  await server.callToolStrict("asset_attach_prompt", { assetId: "unprompted", prompt: "replaced prompt" });
  const replaced = await server.callToolStrict("asset_get", { assetId: "unprompted" });
  assert.equal(replaced.structuredContent.asset.prompt, "replaced prompt");

  const missing = await server.callTool("asset_attach_prompt", { assetId: "ghost", prompt: "anything" });
  assertBusinessError(missing, "ASSET_NOT_FOUND");
});

test("asset_archive hides the asset from asset_list while keeping it and its file retrievable", async (t) => {
  const { workspace, imagePath, server } = await setupServerWithFixture(t);
  // Distinct bytes: asset_create skips identical bytes already in the library
  // (outside Trash) and answers with the stored asset, so a second archive
  // target needs its own fixture.
  const secondPath = await writePngFixture(join(workspace.imagesDir, "tossme.png"), { color: "#513a2a" });
  await server.callToolStrict("asset_create", { assetId: "keepme", imagePath });
  const tossed = await server.callToolStrict("asset_create", { assetId: "tossme", imagePath: secondPath });

  const archived = await server.callToolStrict("asset_archive", { assetId: "tossme" });
  assert.equal(archived.structuredContent.asset.archived, true);

  const list = await server.callToolStrict("asset_list", { projectId: "default" });
  const listedIds = list.structuredContent.assets.map((asset) => asset.id);
  assert.deepEqual(listedIds, ["keepme"], "the archived asset left the active list");

  const stillThere = await server.callToolStrict("asset_get", { assetId: "tossme" });
  assert.equal(stillThere.structuredContent.asset.archived, true);
  await access(tossed.structuredContent.asset.image_path); // soft delete keeps the original file

  const missing = await server.callTool("asset_archive", { assetId: "ghost" });
  assertBusinessError(missing, "ASSET_NOT_FOUND");
});

test("asset_duplicate creates an independent copy and leaves the original untouched", async (t) => {
  const { imagePath, server } = await setupServerWithFixture(t);
  const created = await server.callToolStrict("asset_create", {
    assetId: "origin",
    imagePath,
    prompt: "origin prompt",
  });
  const originalPath = created.structuredContent.asset.image_path;
  const originalBytes = await readFile(originalPath);

  const duplicated = await server.callToolStrict("asset_duplicate", { assetId: "origin", assetIdNew: "copy-one" });
  const copy = duplicated.structuredContent.asset;
  assert.equal(copy.id, "copy-one");
  assert.equal(copy.parent_asset_id, null, "the duplicate starts a new version root");
  assert.notEqual(copy.image_path, originalPath, "the copy manages its own media file");
  assert.deepEqual(await readFile(copy.image_path), originalBytes, "the copy carries the same image bytes");
  assert.equal(copy.source.content_sha256, created.structuredContent.asset.source.content_sha256);

  const origin = await server.callToolStrict("asset_get", { assetId: "origin" });
  assert.equal(origin.structuredContent.asset.id, "origin");
  assert.equal(origin.structuredContent.asset.prompt, "origin prompt");
  assert.equal(origin.structuredContent.asset.image_path, originalPath);
  assert.deepEqual(await readFile(originalPath), originalBytes, "the original media file was not modified");

  const both = await server.callToolStrict("asset_list", { projectId: "default" });
  assert.deepEqual(both.structuredContent.assets.map((asset) => asset.id).sort(), ["copy-one", "origin"]);

  const missing = await server.callTool("asset_duplicate", { assetId: "ghost" });
  assertBusinessError(missing, "ASSET_NOT_FOUND");
});

test("asset_get and asset_provenance_export carry the stored content and pixel hashes", async (t) => {
  const { workspace, imagePath, server } = await setupServerWithFixture(t);
  const pixelHash = await safePixelDigest(imagePath);
  assert.match(pixelHash, /^[0-9a-f]{64}$/);

  // asset_create never trusts hashes the caller claims in `source` (the store
  // recomputes them), so pixel hashes reach the library through the capture
  // channels' own metadata writes. Seed one the way the web-capture bridge
  // would — through the store's updateMetadata on the same library.
  const created = await server.callToolStrict("asset_create", {
    assetId: "hashed",
    imagePath,
    prompt: "hash export fixture",
  });
  assert.match(created.structuredContent.asset.content_sha256, /^[0-9a-f]{64}$/);
  const seedStore = createAssetStore({
    projectRoot: workspace.root,
    managerDir: workspace.root,
    libraryDir: workspace.libraryDir,
    explicitLibraryDir: workspace.libraryDir,
    assetsRoot: join(workspace.libraryDir, "assets"),
    generatedImagesDir: join(workspace.libraryDir, "imports"),
  });
  await seedStore.updateMetadata("default", "hashed", {
    source: { pixel_sha256: pixelHash, pixel_hash_version: PIXEL_HASH_VERSION },
  });
  seedStore.close();

  const fetched = await server.callToolStrict("asset_get", { assetId: "hashed" });
  const asset = fetched.structuredContent.asset;
  assert.match(asset.content_sha256, /^[0-9a-f]{64}$/, "asset_get exposes a real content hash");
  assert.equal(asset.pixel_sha256, pixelHash, "asset_get exposes the pixel hash");

  const db = new Database(join(workspace.libraryDir, "mosa.db"), { readonly: true });
  const row = db.prepare("SELECT content_sha256, pixel_sha256 FROM assets WHERE project_id = ? AND id = ?").get("default", "hashed");
  db.close();
  assert.equal(asset.content_sha256, row.content_sha256, "the tool result matches the stored column");
  assert.equal(asset.pixel_sha256, row.pixel_sha256);

  const exported = await server.callToolStrict("asset_provenance_export", { assetId: "hashed" });
  const bundleAsset = exported.structuredContent.bundle.asset;
  assert.equal(bundleAsset.content_sha256, row.content_sha256, "the provenance bundle no longer blanks the content hash");
  assert.match(bundleAsset.content_sha256, /^[0-9a-f]{64}$/);
  assert.equal(bundleAsset.pixel_sha256, row.pixel_sha256);
  assert.notEqual(bundleAsset.pixel_sha256, "");
});

test("asset_update_metadata merges business_fields keys, so a partial write keeps recorded dimensions", async (t) => {
  const { imagePath, server } = await setupServerWithFixture(t);
  await server.callToolStrict("asset_create", {
    assetId: "dims-keeper",
    imagePath,
    prompt: "partial business fields",
    business_fields: { width: 1024, height: 768, file_bytes: 12345, auto_archived: true },
  });

  const updated = await server.callToolStrict("asset_update_metadata", {
    assetId: "dims-keeper",
    business_fields: { auto_archived: false },
  });
  const fields = updated.structuredContent.asset.business_fields;
  assert.equal(fields.auto_archived, false, "the named key updates");
  assert.equal(fields.width, 1024, "a partial write keeps the recorded width");
  assert.equal(fields.height, 768, "a partial write keeps the recorded height");
  assert.equal(fields.file_bytes, 12345, "a partial write keeps file_bytes");

  const removed = await server.callToolStrict("asset_update_metadata", {
    assetId: "dims-keeper",
    business_fields: { some_key: "temporary" },
  });
  assert.equal(removed.structuredContent.asset.business_fields.some_key, "temporary");
  const deleted = await server.callToolStrict("asset_update_metadata", {
    assetId: "dims-keeper",
    business_fields: { some_key: null },
  });
  assert.equal(Object.hasOwn(deleted.structuredContent.asset.business_fields, "some_key"), false, "a null value deletes its key");
  assert.equal(deleted.structuredContent.asset.business_fields.width, 1024, "the deletion leaves the dimensions alone");
});

test("asset_create returns the stored asset for identical bytes and rebuilds after trash", async (t) => {
  const { workspace, imagePath, server } = await setupServerWithFixture(t);
  const first = await server.callToolStrict("asset_create", { assetId: "dedupe-one", imagePath, prompt: "first copy" });
  assert.equal(first.structuredContent.deduplicated, undefined);

  const second = await server.callToolStrict("asset_create", { assetId: "dedupe-two", imagePath, prompt: "second copy" });
  assert.equal(second.structuredContent.asset.id, "dedupe-one", "the stored asset is returned instead of a copy");
  assert.equal(second.structuredContent.deduplicated, true);
  assert.equal(
    second.content[0].text,
    "Asset already in library: dedupe-one (identical bytes); returned the existing asset.",
  );
  const listed = await server.callToolStrict("asset_list", { projectId: "default" });
  assert.equal(listed.structuredContent.assets.length, 1, "no second copy enters the library");

  // Trash the stored copy through the App's own trash path; the same bytes
  // may then be imported again (Trash does not count as "already in library").
  const trashStore = createAssetStore({
    projectRoot: workspace.root,
    managerDir: workspace.root,
    libraryDir: workspace.libraryDir,
    explicitLibraryDir: workspace.libraryDir,
    assetsRoot: join(workspace.libraryDir, "assets"),
    generatedImagesDir: join(workspace.libraryDir, "imports"),
  });
  await trashStore.deleteAsset("default", "dedupe-one");
  trashStore.close();

  const third = await server.callToolStrict("asset_create", { assetId: "dedupe-three", imagePath, prompt: "after trash" });
  assert.equal(third.structuredContent.asset.id, "dedupe-three");
  assert.equal(third.structuredContent.deduplicated, undefined);
});

test("asset_create ignores hashes the caller claims in source", async (t) => {
  const { workspace, imagePath, server } = await setupServerWithFixture(t);
  const created = await server.callToolStrict("asset_create", {
    assetId: "untrusted-hash",
    imagePath,
    prompt: "claimed hashes",
    source: { pixel_sha256: "f".repeat(64), pixel_hash_version: 2, content_sha256: "a".repeat(64) },
  });
  const asset = created.structuredContent.asset;
  assert.notEqual(asset.source.pixel_sha256, "f".repeat(64), "the claimed pixel hash is not stored");
  assert.notEqual(asset.source.content_sha256, "a".repeat(64), "the claimed content hash is not stored");
  assert.match(asset.source.content_sha256, /^[0-9a-f]{64}$/, "the store recomputed the content hash from the bytes");

  const db = new Database(join(workspace.libraryDir, "mosa.db"), { readonly: true });
  try {
    const row = db.prepare("SELECT content_sha256, pixel_sha256 FROM assets WHERE project_id = ? AND id = ?").get("default", "untrusted-hash");
    assert.match(row.content_sha256, /^[0-9a-f]{64}$/);
    assert.equal(row.pixel_sha256 || "", "", "no fabricated pixel hash reaches the identity columns");
  } finally {
    db.close();
  }
});
