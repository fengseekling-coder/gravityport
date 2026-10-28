// video-poster-store.test.mjs — backend contract for renderer-extracted
// video posters (task 248): saveVideoPoster validation and thumbnail-tier
// encoding, the poster API route, derivative-style bookkeeping (no user-edit
// library change), and the poster file following deletion and relocation.
import assert from "node:assert/strict";
import { copyFile, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createSqliteAssetStore, sqliteDatabasePath } from "../lib/sqlite-asset-store.mjs";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { finalizeCopiedSqliteLibrary } from "../lib/library-relocation.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const FIXTURE_VIDEO = join(import.meta.dirname, "fixtures", "video-poster", "black-intro.mp4");

async function makePosterJpeg(width = 640, height = 360) {
  // Distinct colour quadrants: textured enough for any real frame picker.
  const quadrant = (colour) => sharp({ create: { width: width / 2, height: height / 2, channels: 3, background: colour } }).png().toBuffer();
  return sharp({ create: { width, height, channels: 3, background: { r: 20, g: 20, b: 20 } } })
    .composite([
      { input: await quadrant({ r: 220, g: 60, b: 40 }), left: 0, top: 0 },
      { input: await quadrant({ r: 40, g: 200, b: 90 }), left: width / 2, top: 0 },
      { input: await quadrant({ r: 60, g: 90, b: 230 }), left: 0, top: height / 2 },
      { input: await quadrant({ r: 240, g: 210, b: 50 }), left: width / 2, top: height / 2 },
    ])
    .jpeg()
    .toBuffer();
}

async function createStore(t, name) {
  const root = await mkdtemp(join(tmpdir(), name));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const generated = join(root, "generated-images");
  await mkdir(generated, { recursive: true });
  const store = createSqliteAssetStore({
    projectRoot: root,
    managerDir: join(root, "manager"),
    libraryDir: join(root, "library"),
    initializeFreshLibrary: true,
  });
  t.after(() => { try { store.close(); } catch {} });
  return { root, generated, store };
}

async function createVideoAsset(store, generated, assetId) {
  const videoPath = join(generated, `${assetId}.mp4`);
  await copyFile(FIXTURE_VIDEO, videoPath);
  return store.createAsset({ assetId, imagePath: videoPath, prompt: `poster fixture ${assetId}` });
}

function assertPosterError(error, code) {
  assert.equal(error.code, code, `expected ${code}, got ${error?.code}: ${error?.message}`);
}

test("saveVideoPoster stores a thumbnail-tier webp and records it like derivative backfill", async (t) => {
  const { root, generated, store } = await createStore(t, "mosa-video-poster-store-");
  const created = await createVideoAsset(store, generated, "poster-store-1");
  assert.equal(created.thumbnail_path, null, "imported video starts without a poster");
  // Task 280: the poster-less fallback URL carries the content version too.
  assert.equal(created.thumbnail_url, `/library/default/images/${encodeURIComponent(created.asset)}?v=${created.content_sha256.slice(0, 12)}`);

  const updated = await store.saveVideoPoster("default", "poster-store-1", await makePosterJpeg());
  assert.equal(updated.thumbnail_ready, true);
  assert.match(updated.thumbnail_url, /^\/library\/default\/thumbnails\/poster-store-1\.webp\?v=[0-9a-f]{12}$/);
  assert.equal(updated.thumbnail_path, join(store.thumbnailsDir("default"), "poster-store-1.webp"));
  assert.ok(existsSync(updated.thumbnail_path), "poster file must exist on disk");

  const metadata = await sharp(updated.thumbnail_path).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 400, "poster is re-encoded to the 400px thumbnail tier");
  assert.equal(metadata.height, 225, "16:9 fixture keeps its aspect ratio");
  // Video metadata from ingest (task 244) must survive the poster write.
  assert.equal(updated.business_fields.width, 640);
  assert.equal(updated.business_fields.height, 360);
  assert.ok(Number(updated.business_fields.duration_seconds) > 0);

  // Poster storage is maintenance, not a user edit: the only journal entry it
  // may produce is the derivative flush (assets-updated flagged derivatives).
  await store.libraryRevision("default"); // flush pending derivative changes now
  const delta = await store.listLibraryChangesSince("default", 0);
  const nonDerivative = delta.changes.filter((change) => !(change.kind === "assets-updated" && (change.flags || []).includes("derivatives")));
  assert.deepEqual(nonDerivative.map((change) => change.kind), ["asset-added"], "no user-edit change records beyond the import itself");
});

test("saveVideoPoster rejects non-video assets, undecodable bytes, repeats and trashed videos", async (t) => {
  const { root, generated, store } = await createStore(t, "mosa-video-poster-reject-");
  const stillPath = join(generated, "still.png");
  await sharp({ create: { width: 40, height: 30, channels: 4, background: { r: 10, g: 120, b: 200, alpha: 1 } } }).png().toFile(stillPath);
  const still = await store.createAsset({ assetId: "poster-still", imagePath: stillPath, prompt: "not a video" });
  const smallJpeg = await makePosterJpeg(40, 30);
  await assert.rejects(() => store.saveVideoPoster("default", "poster-still", smallJpeg), (error) => {
    assertPosterError(error, "VIDEO_POSTER_NOT_VIDEO");
    return true;
  });

  const created = await createVideoAsset(store, generated, "poster-reject-1");
  const posterJpeg = await makePosterJpeg();
  await assert.rejects(() => store.saveVideoPoster("default", "poster-reject-1", Buffer.alloc(0)), (error) => {
    assertPosterError(error, "VIDEO_POSTER_INVALID_IMAGE");
    return true;
  });
  await assert.rejects(() => store.saveVideoPoster("default", "poster-reject-1", Buffer.from("not an image at all")), (error) => {
    assertPosterError(error, "VIDEO_POSTER_INVALID_IMAGE");
    return true;
  });
  assert.equal((await store.getAsset("default", "poster-reject-1")).thumbnail_path, null, "failed saves must not occupy the poster slot");

  await store.saveVideoPoster("default", "poster-reject-1", posterJpeg);
  await assert.rejects(() => store.saveVideoPoster("default", "poster-reject-1", posterJpeg), (error) => {
    assertPosterError(error, "VIDEO_POSTER_EXISTS");
    return true;
  });

  const trashed = await createVideoAsset(store, generated, "poster-reject-2");
  await store.deleteAsset("default", trashed.id);
  await assert.rejects(() => store.saveVideoPoster("default", "poster-reject-2", posterJpeg), (error) => {
    assertPosterError(error, "VIDEO_POSTER_ASSET_DELETED");
    return true;
  });

  await assert.rejects(() => store.saveVideoPoster("default", "asset-missing", posterJpeg), (error) => {
    assert.equal(error.code, "ASSET_NOT_FOUND");
    return true;
  });
});

test("poster API route validates content type and size, and serves the stored poster", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-video-poster-api-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const generated = join(root, "generated-images");
  await mkdir(generated, { recursive: true });
  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: root,
    libraryDir: join(root, "library"),
    assetsRoot: join(root, "assets"),
    generatedImagesDir: generated,
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "sessions"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-data"),
    cowartRegistryPath: join(root, "state", "cowart-projects.json"),
  });
  t.after(() => runtime.stop());
  const headers = { "x-mosa-client-token": runtime.clientToken };

  // Asset creation goes through the API too (generatedImagesDir is a trusted
  // source root), which is exactly how the e2e flow seeds the fixture.
  const videoPath = join(generated, "api-clip.mp4");
  await copyFile(FIXTURE_VIDEO, videoPath);
  const createdResponse = await fetch(`${runtime.url}/api/assets/create`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ projectId: "default", imagePath: videoPath, prompt: "api poster clip" }),
  });
  assert.equal(createdResponse.status, 200);
  const created = (await createdResponse.json()).asset;
  const posterUrl = `${runtime.url}/api/assets/default/${created.id}/poster`;

  const badType = await fetch(posterUrl, { method: "POST", headers: { ...headers, "content-type": "text/plain" }, body: "hello" });
  assert.equal(badType.status, 400);
  assert.equal((await badType.json()).code, "VIDEO_POSTER_BAD_TYPE");

  const oversize = await fetch(posterUrl, {
    method: "POST",
    headers: { ...headers, "content-type": "image/jpeg", "content-length": String(9 * 1024 * 1024) },
    body: Buffer.alloc(9 * 1024 * 1024, 1),
  });
  assert.equal(oversize.status, 413);
  assert.equal((await oversize.json()).code, "VIDEO_POSTER_TOO_LARGE");

  const garbage = await fetch(posterUrl, { method: "POST", headers: { ...headers, "content-type": "image/jpeg" }, body: Buffer.from("junk") });
  assert.equal(garbage.status, 400);
  assert.equal((await garbage.json()).code, "VIDEO_POSTER_INVALID_IMAGE");

  const ok = await fetch(posterUrl, { method: "POST", headers: { ...headers, "content-type": "image/jpeg" }, body: await makePosterJpeg() });
  assert.equal(ok.status, 201);
  const payload = await ok.json();
  assert.match(payload.asset.thumbnail_url, new RegExp(`^/library/default/thumbnails/${created.id}\\.webp\\?v=[0-9a-f]{12}$`));

  const repeat = await fetch(posterUrl, { method: "POST", headers: { ...headers, "content-type": "image/jpeg" }, body: await makePosterJpeg() });
  assert.equal(repeat.status, 409);
  assert.equal((await repeat.json()).code, "VIDEO_POSTER_EXISTS");

  // Explicit empty token: npm test's clean-test-env fetch wrapper injects the
  // shared test token into loopback mutations unless the caller sets the
  // header itself — this row must exercise the real unauthenticated path.
  const unauthed = await fetch(posterUrl, { method: "POST", headers: { "content-type": "image/jpeg", "x-mosa-client-token": "" }, body: await makePosterJpeg() });
  assert.equal(unauthed.status, 401, "poster uploads must require the client token like every other mutation");

  // The derivative stream serves the stored poster with image content type.
  const served = await fetch(`${runtime.url}${payload.asset.thumbnail_url}`);
  assert.equal(served.status, 200);
  assert.match(served.headers.get("content-type") || "", /image\/webp/);
});

test("poster file follows permanent deletion and library relocation", async (t) => {
  const { root, generated, store } = await createStore(t, "mosa-video-poster-follow-");
  const created = await createVideoAsset(store, generated, "poster-follow-1");
  const updated = await store.saveVideoPoster("default", "poster-follow-1", await makePosterJpeg());
  const posterPath = updated.thumbnail_path;
  assert.ok(existsSync(posterPath));

  // Soft delete (trash) keeps files; permanent deletion removes them with the
  // rest of the asset's managed files, exactly like image thumbnails.
  await store.deleteAsset("default", created.id);
  assert.ok(existsSync(posterPath), "trash keeps the poster file");
  await store.permanentlyDeleteAsset("default", created.id);
  assert.equal(existsSync(posterPath), false, "permanent deletion removes the poster file");

  // Relocation rebases the poster path into the copied library.
  const second = await createVideoAsset(store, generated, "poster-follow-2");
  const secondUpdated = await store.saveVideoPoster("default", "poster-follow-2", await makePosterJpeg());
  store.close();

  const sourceLibraryDir = join(root, "library");
  const destinationLibraryDir = join(root, "destination-library");
  await cp(sourceLibraryDir, destinationLibraryDir, { recursive: true });
  const finalized = await finalizeCopiedSqliteLibrary({ sourceLibraryDir, destinationLibraryDir });
  assert.ok(finalized.updatedAssets >= 1, "relocation must rebase the video row too");

  const destinationStore = createSqliteAssetStore({
    projectRoot: destinationLibraryDir,
    managerDir: join(destinationLibraryDir, "manager"),
    libraryDir: destinationLibraryDir,
  });
  t.after(() => { try { destinationStore.close(); } catch {} });
  const relocated = await destinationStore.getAsset("default", "poster-follow-2");
  assert.equal(relocated.thumbnail_ready, true);
  assert.ok(relocated.thumbnail_path.startsWith(resolve(destinationLibraryDir)), `poster path rebased into destination, got ${relocated.thumbnail_path}`);
  assert.ok(existsSync(relocated.thumbnail_path), "poster file must exist at the rebased path");
  assert.match(relocated.thumbnail_url, /^\/library\/default\/thumbnails\/poster-follow-2\.webp\?v=[0-9a-f]{12}$/);
});
