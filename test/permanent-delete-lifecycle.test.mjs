import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { access, mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createJsonAssetStore } from "../lib/asset-store.mjs";
import { createSqliteAssetStore, sqliteDatabasePath } from "../lib/sqlite-asset-store.mjs";
import { processDerivativeJob } from "../lib/derivative-worker.js";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const repositoryRoot = join(import.meta.dirname, "..");

async function writePng(filePath) {
  await sharp({ create: { width: 96, height: 64, channels: 3, background: { r: 30, g: 120, b: 200 } } }).png().toFile(filePath);
}

async function fileExists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function managedFileCounts(store, projectId) {
  const projectDir = store.projectDir(projectId);
  const count = async (name) => {
    try { return (await readdir(join(projectDir, name))).length; }
    catch (error) { if (error?.code === "ENOENT") return 0; throw error; }
  };
  const [originals, previews, mediums, thumbnails] = await Promise.all([count("original"), count("previews"), count("mediums"), count("thumbnails")]);
  return { originals, previews, mediums, thumbnails };
}

async function stagingLeftovers(store, projectId) {
  const entries = await readdir(store.projectDir(projectId));
  return entries.filter((name) => name.startsWith(".trash-purge"));
}

async function createSqliteLibrary(t, assetCount) {
  const root = await mkdtemp(join(tmpdir(), "mosa-pd-lifecycle-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sourcesDir = join(root, "project", "generated-images");
  await mkdir(sourcesDir, { recursive: true });
  const libraryDir = join(root, "library");
  const store = createSqliteAssetStore({ projectRoot: join(root, "project"), managerDir: join(root, "project", "mosa"), libraryDir, initializeFreshLibrary: true });
  t.after(() => store.close());
  for (let index = 0; index < assetCount; index += 1) {
    const sourcePath = join(sourcesDir, `asset-${index}.png`);
    await writePng(sourcePath);
    await store.createAsset({ projectId: "default", assetId: `asset-${index}`, imagePath: sourcePath, prompt: `prompt ${index}` }, { ingestMode: "manual" });
  }
  for (;;) {
    const job = await store.claimDerivativeJob();
    if (!job) break;
    const result = await processDerivativeJob(store, job);
    assert.equal(result.ok, true, `derivative generation failed: ${JSON.stringify(result)}`);
  }
  return { root, store, libraryDir };
}

test("sqlite permanent delete removes the original and every derivative with zero orphans", async (t) => {
  const { store, libraryDir } = await createSqliteLibrary(t, 3);
  assert.deepEqual(await managedFileCounts(store, "default"), { originals: 3, previews: 3, mediums: 3, thumbnails: 3 });
  for (let index = 0; index < 3; index += 1) await store.deleteAsset("default", `asset-${index}`);
  for (let index = 0; index < 3; index += 1) await store.permanentlyDeleteAsset("default", `asset-${index}`);
  assert.deepEqual(await managedFileCounts(store, "default"), { originals: 0, previews: 0, mediums: 0, thumbnails: 0 });
  assert.deepEqual(await stagingLeftovers(store, "default"), []);
  const database = new Database(sqliteDatabasePath(libraryDir), { readonly: true });
  t.after(() => database.close());
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM assets").get().n, 0);
});

test("sqlite empty trash leaves zero orphan rows and zero orphan managed files", async (t) => {
  const { store, libraryDir, root } = await createSqliteLibrary(t, 0);
  const sourcesDir = join(root, "project", "generated-images");
  for (let index = 100; index < 200; index += 1) {
    const sourcePath = join(sourcesDir, `bulk-${index}.png`);
    await writePng(sourcePath);
    await store.createAsset({ projectId: "default", assetId: `bulk-${index}`, imagePath: sourcePath, prompt: `bulk ${index}` }, { ingestMode: "manual" });
  }
  for (;;) { const job = await store.claimDerivativeJob(); if (!job) break; await processDerivativeJob(store, job); }
  assert.equal((await managedFileCounts(store, "default")).previews, 100);
  for (let index = 100; index < 200; index += 1) await store.deleteAsset("default", `bulk-${index}`);
  const result = await store.emptyTrash("default");
  assert.equal(result.removed, 100);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(await managedFileCounts(store, "default"), { originals: 0, previews: 0, mediums: 0, thumbnails: 0 });
  assert.deepEqual(await stagingLeftovers(store, "default"), []);
  const database = new Database(sqliteDatabasePath(libraryDir), { readonly: true });
  t.after(() => database.close());
  assert.deepEqual({
    assets: database.prepare("SELECT COUNT(*) AS n FROM assets").get().n,
    derivativeJobs: database.prepare("SELECT COUNT(*) AS n FROM derivative_jobs").get().n,
    stackMembers: database.prepare("SELECT COUNT(*) AS n FROM asset_stack_members").get().n,
  }, { assets: 0, derivativeJobs: 0, stackMembers: 0 });
});

test("sqlite transaction failure rolls the database back and restores every staged byte", async (t) => {
  const { store, libraryDir } = await createSqliteLibrary(t, 1);
  await store.deleteAsset("default", "asset-0");
  const projectDir = store.projectDir("default");
  assert.equal((await readdir(join(projectDir, "thumbnails"))).includes("asset-0.webp"), true);
  const saboteur = new Database(sqliteDatabasePath(libraryDir));
  saboteur.exec("DROP TABLE asset_tags");
  try { await assert.rejects(store.permanentlyDeleteAsset("default", "asset-0"), /asset_tags/); } finally { saboteur.close(); }
  assert.equal(await fileExists(join(projectDir, "original", "asset-0.png")), true);
  assert.equal(await fileExists(join(projectDir, "previews", "asset-0.webp")), true);
  assert.equal(await fileExists(join(projectDir, "mediums", "asset-0.webp")), true);
  assert.equal(await fileExists(join(projectDir, "thumbnails", "asset-0.webp")), true);
  assert.deepEqual(await stagingLeftovers(store, "default"), []);
  const database = new Database(sqliteDatabasePath(libraryDir), { readonly: true });
  t.after(() => database.close());
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM assets WHERE id = 'asset-0'").get().n, 1);
});

test("permanent delete of a non-trashed asset is a 409 conflict, not a server error", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-pd-http-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  const sourcesDir = join(root, "project", "generated-images");
  await mkdir(sourcesDir, { recursive: true });
  const sourcePath = join(sourcesDir, "live.png");
  await writePng(sourcePath);
  const runtime = await startMosaRuntime({ port: 0, projectRoot: join(root, "project"), managerDir: repositoryRoot, appDir: join(repositoryRoot, "web", "gravityport", "dist"), libraryDir, assetsRoot: join(libraryDir, "assets"), generatedImagesDir: sourcesDir, codexImagesDir: join(root, "codex-images"), codexSessionsDir: join(root, "codex-sessions"), grokSessionsDir: join(root, "grok-sessions"), cowartCanvasDir: join(root, "cowart-canvas"), cowartRegistryPath: join(root, "state", "cowart-projects.json") });
  t.after(() => runtime.stop());
  const create = await fetch(`${runtime.url}/api/assets/create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: "default", assetId: "live-asset", imagePath: sourcePath, prompt: "live" }) });
  assert.equal(create.status, 200);
  const response = await fetch(`${runtime.url}/api/assets/default/live-asset/permanent`, { method: "DELETE" });
  assert.equal(response.status, 409);
  const payload = await response.json();
  assert.equal(payload.code, "ASSET_NOT_TRASHED");
  const page = await (await fetch(`${runtime.url}/api/assets?project=default`)).json();
  assert.equal(page.assets.some((asset) => asset.id === "live-asset"), true);
});

test("startup orphan derivative sweep reclaims history without touching referenced or original files", async (t) => {
  const { store } = await createSqliteLibrary(t, 2);
  const projectDir = store.projectDir("default");
  const stale = new Date(Date.now() - 60 * 60 * 1000);
  const orphans = ["previews/orphan-preview.webp", "mediums/orphan-medium.webp", "thumbnails/orphan-thumbnail.webp", "original/orphan-original.png"];
  for (const relativeName of orphans) {
    const path = join(projectDir, ...relativeName.split("/"));
    await writeFile(path, "orphan");
    await utimes(path, stale, stale);
  }
  const sweep = await store.cleanupOrphanedDerivativeFiles();
  assert.equal(sweep.removed, 3);
  assert.equal(sweep.failed, 0);
  assert.equal(await fileExists(join(projectDir, "previews", "orphan-preview.webp")), false);
  assert.equal(await fileExists(join(projectDir, "mediums", "orphan-medium.webp")), false);
  assert.equal(await fileExists(join(projectDir, "thumbnails", "orphan-thumbnail.webp")), false);
  assert.equal(await fileExists(join(projectDir, "previews", "asset-0.webp")), true);
  assert.equal(await fileExists(join(projectDir, "thumbnails", "asset-1.webp")), true);
  assert.equal(await fileExists(join(projectDir, "original", "orphan-original.png")), true);
});

test("json permanent delete removes managed files and keeps staging clean", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-pd-json-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sourcesDir = join(projectRoot, "generated-images");
  await mkdir(sourcesDir, { recursive: true });
  const store = createJsonAssetStore({ projectRoot, managerDir });
  t.after(() => store.close?.());
  const sourcePath = join(sourcesDir, "json-asset.png");
  await writePng(sourcePath);
  await store.createAsset({ projectId: "default", assetId: "json-asset", imagePath: sourcePath, prompt: "json prompt" }, { ingestMode: "manual" });
  const asset = await store.getAsset("default", "json-asset");
  assert.equal(await fileExists(asset.image_path), true);
  await store.deleteAsset("default", "json-asset");
  await store.permanentlyDeleteAsset("default", "json-asset");
  assert.equal(await fileExists(asset.image_path), false);
  assert.deepEqual(await stagingLeftovers(store, "default"), []);
});

test("cleanupOrphanedDerivativeFiles propagates real filesystem errors to the maintenance barrier", async (t) => {
  const { store } = await createSqliteLibrary(t, 1);
  const projectDir = store.projectDir("default");
  await rm(join(projectDir, "previews"), { recursive: true });
  await writeFile(join(projectDir, "previews"), "not a directory");
  await assert.rejects(store.cleanupOrphanedDerivativeFiles(), (error) => error?.code === "ENOTDIR");
});
