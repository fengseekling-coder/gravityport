import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { PIXEL_HASH_VERSION, safePixelDigest } from "../lib/image-pixel-hash.js";
import { createAssetStore } from "../lib/asset-store.mjs";
import { TRASH_RETENTION_MS } from "../lib/sqlite-asset-store.mjs";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
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

test("asset_trash moves asset to Trash, calculates purge_after, and asset_restore brings it back", async (t) => {
  const { workspace, imagePath, server } = await setupServerWithFixture(t);
  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: workspace.root,
    libraryDir: workspace.libraryDir,
    assetsRoot: join(workspace.libraryDir, "assets"),
    generatedImagesDir: workspace.imagesDir,
  });
  t.after(() => runtime.stop());

  await server.callToolStrict("asset_create", { assetId: "trashme", imagePath });

  // 1. asset_trash
  const trashed = await server.callToolStrict("asset_trash", { assetId: "trashme" });
  assert.equal(trashed.structuredContent.asset_id, "trashme");
  assert.equal(trashed.structuredContent.trashed, true);
  assert.ok(trashed.structuredContent.deleted_at);
  const expectedPurgeAfter = new Date(new Date(trashed.structuredContent.deleted_at).getTime() + TRASH_RETENTION_MS).toISOString();
  assert.equal(trashed.structuredContent.purge_after, expectedPurgeAfter);
  assert.match(trashed.content[0].text, /已移到回收站，可恢复，90 天后自动清除。\/ Moved to Trash; restorable for 90 days\./);

  // HTTP GET /api/assets has no trashme
  const activeRes = await fetch(`${runtime.url}/api/assets?project=default&limit=100`);
  const active = await activeRes.json();
  assert.equal(active.assets.some((a) => a.id === "trashme"), false);

  // HTTP GET /api/assets?trash=1 has trashme
  const trashRes = await fetch(`${runtime.url}/api/assets?project=default&trash=1&limit=100`);
  const trash = await trashRes.json();
  assert.equal(trash.assets.some((a) => a.id === "trashme"), true);

  // 2. asset_restore
  const restored = await server.callToolStrict("asset_restore", { assetId: "trashme" });
  assert.equal(restored.structuredContent.asset.id, "trashme");
  assert.equal(restored.structuredContent.asset.archived, false);
  assert.equal(restored.structuredContent.asset.deleted_at, null);
  assert.match(restored.content[0].text, /已从回收站恢复。\/ Restored from Trash\./);

  // GET /api/assets has it again
  const activeRes2 = await fetch(`${runtime.url}/api/assets?project=default&limit=100`);
  const active2 = await activeRes2.json();
  assert.equal(active2.assets.some((a) => a.id === "trashme"), true);

  // 3. asset_restore on asset not in trash -> ASSET_NOT_IN_TRASH
  const notInTrash = await server.callTool("asset_restore", { assetId: "trashme" });
  assert.equal(notInTrash.isError, true);
  assert.equal(notInTrash.structuredContent.error.code, "ASSET_NOT_IN_TRASH");
  assert.match(notInTrash.content[0].text, /这张图不在回收站里。\/ Asset trashme is not in Trash\./);

  // Non-existent id -> ASSET_NOT_FOUND
  const missing = await server.callTool("asset_restore", { assetId: "ghost" });
  assertBusinessError(missing, "ASSET_NOT_FOUND");
});

test("asset_trash removes asset from stack membership", async (t) => {
  const { workspace, imagePath, server } = await setupServerWithFixture(t);
  const secondPath = await writePngFixture(join(workspace.imagesDir, "second.png"), { color: "#513a2a" });
  await server.callToolStrict("asset_create", { assetId: "member-1", imagePath });
  await server.callToolStrict("asset_create", { assetId: "member-2", imagePath: secondPath });

  const stack = await server.callToolStrict("stack_create", {
    assetIds: ["member-1", "member-2"],
    name: "stack-to-trash",
  });
  const stackId = stack.structuredContent.stack.id;

  const before = await server.callToolStrict("stack_get", { stackId });
  assert.equal(before.structuredContent.members.length, 2);

  await server.callToolStrict("asset_trash", { assetId: "member-1" });

  const after = await server.callToolStrict("stack_get", { stackId });
  assert.equal(after.structuredContent.members.length, 1);
  assert.equal(after.structuredContent.members[0].id, "member-2");
});

test("asset_trash followed by asset_create of identical bytes creates new id and keeps trashed asset", async (t) => {
  const { workspace, imagePath, server } = await setupServerWithFixture(t);
  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: workspace.root,
    libraryDir: workspace.libraryDir,
    assetsRoot: join(workspace.libraryDir, "assets"),
    generatedImagesDir: workspace.imagesDir,
  });
  t.after(() => runtime.stop());

  await server.callToolStrict("asset_create", { assetId: "first-copy", imagePath });
  await server.callToolStrict("asset_trash", { assetId: "first-copy" });

  const recreated = await server.callToolStrict("asset_create", { assetId: "second-copy", imagePath });
  assert.equal(recreated.structuredContent.asset.id, "second-copy");
  assert.equal(recreated.structuredContent.deduplicated, undefined);

  // Both exist: second-copy in active library, first-copy in trash
  const activeRes = await fetch(`${runtime.url}/api/assets?project=default&limit=100`);
  const active = await activeRes.json();
  assert.equal(active.assets.some((a) => a.id === "second-copy"), true);

  const trashRes = await fetch(`${runtime.url}/api/assets?project=default&trash=1&limit=100`);
  const trash = await trashRes.json();
  assert.equal(trash.assets.some((a) => a.id === "first-copy"), true);
});

test("tools/list contains asset_trash and asset_restore with proper annotations, and no asset_archive", async (t) => {
  const { server } = await setupServerWithFixture(t);
  const response = await server.request("tools/list");
  const tools = response.result.tools;
  const toolNames = tools.map((tool) => tool.name);

  assert.equal(toolNames.includes("asset_archive"), false, "asset_archive must not exist");
  assert.equal(toolNames.includes("asset_trash"), true, "asset_trash must exist");
  assert.equal(toolNames.includes("asset_restore"), true, "asset_restore must exist");

  const trashTool = tools.find((tool) => tool.name === "asset_trash");
  assert.deepEqual(trashTool.annotations, {
    openWorldHint: false,
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  });

  const restoreTool = tools.find((tool) => tool.name === "asset_restore");
  assert.deepEqual(restoreTool.annotations, {
    openWorldHint: false,
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  });
});

test("HTTP batch action archive moves assets to Trash", async (t) => {
  const { workspace, imagePath, server } = await setupServerWithFixture(t);
  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: workspace.root,
    libraryDir: workspace.libraryDir,
    assetsRoot: join(workspace.libraryDir, "assets"),
    generatedImagesDir: workspace.imagesDir,
  });
  t.after(() => runtime.stop());

  await server.callToolStrict("asset_create", { assetId: "batch-target", imagePath });

  const batchRes = await fetch(`${runtime.url}/api/assets/batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "archive", projectId: "default", assetIds: ["batch-target"] }),
  });
  assert.equal(batchRes.status, 200);
  const batch = await batchRes.json();
  assert.equal(batch.partial, false);
  assert.deepEqual(batch.results, [{ id: "batch-target", trashed: true }]);

  const activeRes = await fetch(`${runtime.url}/api/assets?project=default&limit=100`);
  const active = await activeRes.json();
  assert.equal(active.assets.some((a) => a.id === "batch-target"), false);

  const trashRes = await fetch(`${runtime.url}/api/assets?project=default&trash=1&limit=100`);
  const trash = await trashRes.json();
  assert.equal(trash.assets.some((a) => a.id === "batch-target"), true);
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

  const both = await server.callToolStrict("asset_list", {});
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

// Task 377 reworked the contract this test used to pin: system-recorded
// business fields (width/height/file_bytes/…/auto_archived) are dropped at
// the MCP layer instead of being written, and the answer reports them. The
// merge semantics for ordinary keys are unchanged and still pinned here.
test("asset_update_metadata merges business_fields keys; system-recorded fields are refused", async (t) => {
  const { imagePath, server } = await setupServerWithFixture(t);
  const created = await server.callToolStrict("asset_create", {
    assetId: "dims-keeper",
    imagePath,
    prompt: "partial business fields",
    business_fields: { width: 1024, height: 768, file_bytes: 12345, auto_archived: true, note: "kept" },
  });
  assert.deepEqual(created.structuredContent.ignored_fields, ["width", "height", "file_bytes", "auto_archived"]);
  const createdFields = created.structuredContent.asset.business_fields;
  assert.notEqual(createdFields.width, 1024, "the file's real width wins over a claimed one");
  assert.notEqual(createdFields.file_bytes, 12345, "the store records the real file size");
  assert.equal(createdFields.auto_archived, undefined, "auto_archived is not writable from MCP");
  assert.equal(createdFields.note, "kept", "ordinary keys are written as before");

  const updated = await server.callToolStrict("asset_update_metadata", {
    assetId: "dims-keeper",
    business_fields: { note: "renamed" },
  });
  const fields = updated.structuredContent.asset.business_fields;
  assert.equal(fields.note, "renamed", "a partial write keeps the other keys");
  assert.equal(fields.width, createdFields.width, "a partial write keeps the recorded width");
  assert.equal(fields.height, createdFields.height, "a partial write keeps the recorded height");
  assert.equal(fields.file_bytes, createdFields.file_bytes, "a partial write keeps file_bytes");

  const refused = await server.callToolStrict("asset_update_metadata", {
    assetId: "dims-keeper",
    business_fields: { auto_archived: false },
  });
  assert.deepEqual(refused.structuredContent.ignored_fields, ["auto_archived"], "auto_archived is refused and reported");

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
  assert.equal(deleted.structuredContent.asset.business_fields.width, createdFields.width, "the deletion leaves the dimensions alone");
});

test("asset_create returns the stored asset for identical bytes and rebuilds after trash", async (t) => {
  const { workspace, imagePath, server } = await setupServerWithFixture(t);
  const first = await server.callToolStrict("asset_create", { assetId: "dedupe-one", imagePath, prompt: "first copy" });
  assert.equal(first.structuredContent.deduplicated, undefined);

  const second = await server.callToolStrict("asset_create", { assetId: "dedupe-two", imagePath });
  assert.equal(second.structuredContent.asset.id, "dedupe-one", "the stored asset is returned instead of a copy");
  assert.equal(second.structuredContent.deduplicated, true);
  assert.equal(
    second.content[0].text,
    "Asset already in library: dedupe-one (identical bytes); returned the existing asset.",
  );
  const listed = await server.callToolStrict("asset_list", {});
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

test("deduplicated asset_create reports ignored_fields without overwriting stored prompt or tags", async (t) => {
  const { imagePath, server } = await setupServerWithFixture(t);
  await server.callToolStrict("asset_create", {
    assetId: "dedupe-original",
    imagePath,
    prompt: "original prompt",
    tags: ["original-tag"],
  });

  const dupResult = await server.callToolStrict("asset_create", {
    assetId: "dedupe-attempt",
    imagePath,
    prompt: "new prompt",
    tags: ["new-tag"],
  });

  assert.equal(dupResult.structuredContent.deduplicated, true);
  assert.equal(dupResult.structuredContent.asset.id, "dedupe-original");
  assert.deepEqual(dupResult.structuredContent.ignored_fields, ["prompt", "tags"]);
  assert.equal(
    dupResult.content[0].text,
    "Asset already in library: dedupe-original (identical bytes); returned the existing asset. 这次传的 prompt, tags 没有写入；要改用 asset_update_metadata。/ The prompt, tags in this request were not saved; use asset_update_metadata to change them.",
  );

  const verified = await server.callToolStrict("asset_get", { assetId: "dedupe-original" });
  assert.equal(verified.structuredContent.asset.prompt, "original prompt");
  assert.deepEqual(verified.structuredContent.asset.tags, ["original-tag"]);
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
