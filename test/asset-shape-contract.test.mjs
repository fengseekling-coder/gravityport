// Task 391: asset shape contract — what the UI reads (normalizeAsset), what the
// SQLite HTTP API returns and what MCP's compactAsset reports must describe the
// same asset. Any key the UI reads but the API never sends, any MCP field
// drifting from the API row, and any new JSON-vs-SQLite key gap fails here
// instead of silently dropping a label in the gallery, the inspector or an AI
// client. Test-only suite: a real SQLite library, a real runtime and a real
// mcp/server.mjs process are started; "which keys does the UI read" is measured
// through a recording Proxy around the actual API payloads, never hand-copied.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import sharp from "sharp";
import Database from "better-sqlite3";
import { createAssetStore, createJsonAssetStore } from "../lib/asset-store.mjs";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { removeTestPath } from "./test-cleanup.mjs";
import { startMcpServer } from "./helpers/mcp-server-harness.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");
const PROJECT = "default";

// Asset ①: a fully decorated image (prompt, reference, tags, group, rating,
// favorite). ②: a video with an explicit media kind and duration. ③/④: the
// two members of one stack — a stack needs two live members before the API
// annotates a cover (annotateAssetStackCovers skips stacks with <2 members),
// so ④ exists to make ③'s stack contract observable.
const IMAGE_A = { id: "shape-image", width: 8, height: 6 };
const IMAGE_COVER = { id: "shape-cover", width: 8, height: 8 };
const IMAGE_MEMBER = { id: "shape-member", width: 8, height: 8 };
const VIDEO = { id: "shape-video", width: 320, height: 240, durationSeconds: 6.5 };
const STACK_NAME = "形状堆叠";
const GROUP_NAME = "形状契约组";
// Long enough that compactAsset must cut the excerpt with an ellipsis.
const PROMPT_LONG = "晨雾漫过松林小径，右侧斜射的光线在苔藓上留下长影，远处山脊线渐隐于乳白雾气之中。".repeat(3);
const PROMPT_SHORT = "海岸线暮色，冷调。";
const TAGS = ["形状契约", "参考图组"];
const REFERENCES = [{ reference_id: "ref-shape-1", role: "style", scope: ["prompt"] }];

// The fallback keys normalizeAsset may read without the API carrying them.
// Measured by running the real normalizeAsset over the real gallery and detail
// payloads (recording Proxy), then writing down each read-but-absent key with
// the fallback expression that makes it optional. Paths are "<scope>.<key>";
// nested paths name business_fields / source / stack levels. Claude reviews
// this list (web/gravityport/src/mosa-api.ts line references).
const FALLBACK_READ_ALLOWANCE = new Set([
  // positive(input.width ?? fields.width, 1) — rows carry dimensions in
  // business_fields only; the top-level key is the first fallback read.
  "gallery.width", "detail.width",
  // positive(input.height ?? fields.height, 1) — same chain, height half.
  "gallery.height", "detail.height",
  // name chain input.name || input.title || input.display_name || ... — rows
  // carry neither name nor title; display_name (withRuntimeUrls) resolves.
  "gallery.name", "detail.name",
  "gallery.title", "detail.title",
  // introduction chain fields.introduction || fields.description ||
  // input.description — none of the three is stored for normal assets.
  "gallery.description", "detail.description",
  // kind chain source.media_kind || fields.media_kind || input.media_kind —
  // the top-level key is the third fallback; images carry no media_kind at all.
  "gallery.media_kind", "detail.media_kind",
  // Number(input.size_bytes ?? fields.file_bytes ?? fields.size_bytes) — the
  // top-level key is the first fallback; the row size lives in file_bytes.
  "gallery.size_bytes", "detail.size_bytes",
  // input.node_sort — gallery rows carry the sort tuple; detail payloads
  // (store.getAsset) never do.
  "detail.node_sort",
  // input.stack — only stack covers with >=2 live members are annotated
  // (annotateAssetStackCovers); unstacked rows and all detail payloads lack it.
  "gallery.stack", "detail.stack",
  // stackRaw.match_count — only stack-scoped pages annotate match_count; the
  // flat gallery's cover annotation is { id, count, name }.
  "gallery.stack.match_count",
  // input.stack_position — only stack-scoped page queries attach positions.
  "gallery.stack_position", "detail.stack_position",
  // input.trash_reason — only rows deleted into Trash carry the reason; live
  // rows have none.
  "gallery.trash_reason", "detail.trash_reason",
  // business_fields.media_kind — images store no media_kind business field
  // (kind resolves through source/extension); the seeded video does carry it.
  "gallery.business_fields.media_kind", "detail.business_fields.media_kind",
  // business_fields.duration_seconds — images have no duration.
  "gallery.business_fields.duration_seconds", "detail.business_fields.duration_seconds",
  // business_fields.generation_request_prompt — request-prompt stores keep it
  // in source (and old rows carry neither).
  "gallery.business_fields.generation_request_prompt", "detail.business_fields.generation_request_prompt",
  // business_fields.user_message — user instructions live in source; the
  // business-field copy is the second fallback.
  "gallery.business_fields.user_message", "detail.business_fields.user_message",
  // business_fields.introduction / description — inspector copy fields, never
  // written by the seeded (or any current) ingest path.
  "gallery.business_fields.introduction", "detail.business_fields.introduction",
  "gallery.business_fields.description", "detail.business_fields.description",
  // source.media_kind — images keep no media_kind in source; the chain falls
  // on to business_fields / extension.
  "gallery.source.media_kind", "detail.source.media_kind",
  // source.model_caption — task 353 caption, absent on all rows here.
  "gallery.source.model_caption", "detail.source.model_caption",
  // source.generation_request_prompt — only capture sources store it.
  "gallery.source.generation_request_prompt", "detail.source.generation_request_prompt",
  // source.user_message — user instructions only when a capture recorded one.
  "gallery.source.user_message", "detail.source.user_message",
]);

// Top-level keys the SQLite gallery rows carry and the legacy JSON backend's
// rows never will (0.4 retires the JSON backend; a new gap fails the test).
// Measured by diffing the key unions of the same four assets through both
// backends' real /api/assets answers. Claude reviews this list.
const JSON_BACKEND_MISSING_SQLITE_KEYS = new Set([
  // Derivative tiers: withRuntimeUrls in lib/sqlite-asset-store.mjs adds the
  // preview / medium / thumbnail URLs, managed paths and ready flags; the JSON
  // backend's withRuntimeUrls (lib/asset-store.mjs) only adds image_url.
  "preview_url", "medium_url", "thumbnail_url",
  "preview_ready", "medium_ready", "thumbnail_ready",
  "preview_path", "medium_path", "thumbnail_path",
  // Byte-identity hashes live as top-level row fields on SQLite; the JSON
  // backend keeps them (when present) inside source.
  "content_sha256", "pixel_sha256",
  // Dominant colors: only the SQLite store tracks palettes (ensureAssetPalette).
  "palette",
  // The exact ORDER BY tuple annotateGalleryNodeSort stamps on SQLite pages.
  "node_sort",
  // Stack-cover annotation: the JSON store has no asset-stack APIs, so its
  // gallery rows never name a stack.
  "stack",
]);

let shared;
function setupOnce() {
  if (!shared) {
    shared = (async () => {
      const sqlite = await seedSqliteWorkspace();
      let runtime = null;
      let mcp = null;
      try {
        runtime = await startSqliteRuntime(sqlite);
        mcp = startMcpServer({ after: () => {} }, sqlite.workspace);
        await initializeMcp(mcp);
        await waitForImageDerivatives(runtime.url, [IMAGE_A.id, IMAGE_COVER.id, IMAGE_MEMBER.id]);
        const galleryById = await fetchGalleryById(runtime.url);
        const detailById = await fetchDetailsById(runtime.url);
        const { normalizeAsset, tempRoot } = await compileNormalizeAsset();
        return {
          sqlite,
          runtime,
          mcp,
          galleryById,
          detailById,
          normalizeAsset,
          normalizeTempRoot: tempRoot,
          stackId: sqlite.stackId,
          stopRuntime: () => runtime.stop(),
        };
      } catch (error) {
        // A half-started setup must never leak the runtime or the MCP child:
        // tear both down and drop the throwaway library before propagating.
        if (mcp) mcp.terminateIfRunning();
        if (runtime) await runtime.stop().catch(() => {});
        await removeTestPath(sqlite.workspace.root, { recursive: true, force: true });
        throw error;
      }
    })().then(
      (value) => {
        shared = value;
        return value;
      },
      (error) => {
        shared = null;
        throw error;
      },
    );
  }
  return shared;
}

async function seedSqliteWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "mosa-shape-sqlite-"));
  const workspace = {
    root,
    libraryDir: join(root, "library"),
    imagesDir: join(root, "generated-images"),
  };
  const store = createAssetStore({
    projectRoot: workspace.root,
    managerDir: workspace.root,
    libraryDir: workspace.libraryDir,
    explicitLibraryDir: workspace.libraryDir,
    assetsRoot: join(workspace.libraryDir, "assets"),
    generatedImagesDir: workspace.imagesDir,
  });
  const imagePathA = await writeImageFixture(join(workspace.imagesDir, `${IMAGE_A.id}.png`), IMAGE_A);
  const imagePathCover = await writeImageFixture(join(workspace.imagesDir, `${IMAGE_COVER.id}.png`), IMAGE_COVER);
  const imagePathMember = await writeImageFixture(join(workspace.imagesDir, `${IMAGE_MEMBER.id}.png`), IMAGE_MEMBER);
  const videoPath = await writeVideoFixture(join(workspace.imagesDir, `${VIDEO.id}.mp4`));
  await store.createAsset({
    assetId: IMAGE_A.id,
    imagePath: imagePathA,
    prompt: PROMPT_LONG,
    tags: TAGS,
    group: GROUP_NAME,
    rating: 4,
    favorite: true,
    references: REFERENCES,
  });
  await store.createAsset({
    assetId: VIDEO.id,
    imagePath: videoPath,
    prompt: PROMPT_SHORT,
    business_fields: {
      media_kind: "video",
      width: VIDEO.width,
      height: VIDEO.height,
      duration_seconds: VIDEO.durationSeconds,
    },
  });
  await store.createAsset({ assetId: IMAGE_COVER.id, imagePath: imagePathCover, prompt: PROMPT_SHORT });
  await store.createAsset({ assetId: IMAGE_MEMBER.id, imagePath: imagePathMember, prompt: PROMPT_SHORT });
  // createAssetStack returns the stack summary and never sets a display name;
  // the name lands through the same rename the MCP stack_create tool applies.
  const stackId = (await store.createAssetStack(PROJECT, [IMAGE_COVER.id, IMAGE_MEMBER.id])).id;
  await store.renameAssetStack(PROJECT, stackId, STACK_NAME);
  store.close();
  return { workspace, stackId };
}

async function startSqliteRuntime(seeded) {
  const { root, libraryDir, imagesDir } = seeded.workspace;
  return startMosaRuntime({
    port: 0,
    projectRoot: root,
    libraryDir,
    assetsRoot: join(libraryDir, "assets"),
    generatedImagesDir: imagesDir,
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "sessions"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-data"),
    cowartRegistryPath: join(root, "state", "cowart-projects.json"),
  });
}

async function initializeMcp(mcp) {
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });
}

async function writeImageFixture(filePath, { width, height }) {
  await mkdir(dirname(filePath), { recursive: true });
  await sharp({ create: { width, height, channels: 4, background: "#243047" } }).png().toFile(filePath);
  return filePath;
}

// The store's media-signature gate (task 366) accepts a .mp4 whose head is a
// real ftyp box with a non-still-image brand; business_fields carry the
// dimensions/duration so no video decoder is needed.
async function writeVideoFixture(filePath) {
  const buffer = Buffer.alloc(64);
  buffer.writeUInt32BE(64, 0);
  buffer.write("ftyp", 4, "latin1");
  buffer.write("isom", 8, "latin1");
  buffer.write("isomiso2avc1mp41", 12, "latin1");
  await writeFile(filePath, buffer);
  return filePath;
}

async function fetchGalleryById(baseUrl) {
  const response = await fetch(`${baseUrl}/api/assets?project=${PROJECT}&limit=250`);
  assert.equal(response.status, 200);
  const body = await response.json();
  const byId = new Map(body.assets.map((asset) => [asset.id, asset]));
  for (const id of [IMAGE_A.id, VIDEO.id, IMAGE_COVER.id, IMAGE_MEMBER.id]) {
    assert.ok(byId.has(id), `gallery must contain ${id}`);
  }
  return byId;
}

async function fetchDetailsById(baseUrl) {
  const byId = new Map();
  for (const id of [IMAGE_A.id, VIDEO.id, IMAGE_COVER.id, IMAGE_MEMBER.id]) {
    const response = await fetch(`${baseUrl}/api/assets/${PROJECT}/${id}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    byId.set(id, body.asset);
  }
  return byId;
}

async function waitForImageDerivatives(baseUrl, imageIds) {
  const deadline = Date.now() + 30_000;
  let lastReady = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/assets?project=${PROJECT}&limit=250`);
    assert.equal(response.status, 200);
    const body = await response.json();
    lastReady = imageIds.map((id) => Boolean(body.assets.find((asset) => asset.id === id)?.thumbnail_ready));
    if (lastReady.every(Boolean)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`derivatives never became ready within 30s: ${JSON.stringify(lastReady)}`);
}

// The real UI code: web/gravityport/src/mosa-api.ts bundled to a temporary ESM
// module with the project's own tsc (same flags as gravityport-ui.test.mjs).
async function compileNormalizeAsset() {
  const tempRoot = await mkdtemp(join(tmpdir(), "mosa-shape-ts-"));
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    join(uiRoot, "src", "mosa-api.ts"), "--outDir", tempRoot, "--module", "esnext",
    "--target", "es2022", "--moduleResolution", "bundler", "--skipLibCheck",
  ], { stdio: "pipe" });
  const module = await import(join(tempRoot, "mosa-api.js"));
  return { normalizeAsset: module.normalizeAsset, tempRoot };
}

/**
 * Records every property get on the wrapped payloads (top level plus the
 * nested business_fields / source / stack objects), so "which keys does the UI
 * read" comes out of running the real normalizeAsset, never from reading its
 * source with regexes or hand-copying a field list.
 */
class ReadRecorder {
  constructor() {
    this.reads = new Map(); // raw target -> { path, keys: Set<string> }
    this.proxies = new WeakMap();
  }

  wrap(target, path) {
    if (!target || typeof target !== "object" || Array.isArray(target)) return target;
    const existing = this.proxies.get(target);
    if (existing) return existing;
    const entry = { path, keys: new Set() };
    this.reads.set(target, entry);
    const proxy = new Proxy(target, {
      get: (raw, prop) => {
        if (typeof prop === "string") entry.keys.add(prop);
        const value = Reflect.get(raw, prop);
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          return this.wrap(value, `${path}.${prop}`);
        }
        return value;
      },
    });
    this.proxies.set(target, proxy);
    return proxy;
  }

  /** [path, key] pairs read but absent from the payload. */
  missingReads() {
    const missing = [];
    for (const [target, { path, keys }] of this.reads) {
      for (const key of keys) {
        if (!(key in target)) missing.push(`${path}.${key}`);
      }
    }
    return missing.sort();
  }
}

test("1. every key normalizeAsset reads exists in the API payloads (gallery and detail)", async () => {
  const { galleryById, detailById, normalizeAsset } = await setupOnce();
  const recorder = new ReadRecorder();
  for (const id of [IMAGE_A.id, VIDEO.id, IMAGE_COVER.id, IMAGE_MEMBER.id]) {
    for (const [scope, raw] of [["gallery", galleryById.get(id)], ["detail", detailById.get(id)]]) {
      assert.ok(raw, `${scope} payload for ${id} is missing`);
      const proxied = recorder.wrap(raw, scope);
      normalizeAsset(proxied, PROJECT);
    }
  }
  const missing = recorder.missingReads();
  const unexpected = missing.filter((path) => !FALLBACK_READ_ALLOWANCE.has(path));
  assert.deepEqual(
    unexpected,
    [],
    `the interface reads keys the API never sends; each one below must either be fixed server-side or join FALLBACK_READ_ALLOWANCE with a justification: ${JSON.stringify(unexpected)}`,
  );
});

test("1b. fields the interface must render carry real server values, not fallback empties", async () => {
  const { galleryById, detailById, normalizeAsset } = await setupOnce();
  const expectedKind = new Map([
    [IMAGE_A.id, "image"],
    [VIDEO.id, "video"],
    [IMAGE_COVER.id, "image"],
    [IMAGE_MEMBER.id, "image"],
  ]);
  for (const id of [IMAGE_A.id, VIDEO.id, IMAGE_COVER.id, IMAGE_MEMBER.id]) {
    for (const raw of [galleryById.get(id), detailById.get(id)]) {
      const asset = normalizeAsset(raw, PROJECT);
      assert.equal(asset.id, raw.id, `${id}: id must come from the row, not fall back to ""`);
      assert.ok(asset.name, `${id}: name must resolve (display_name chain), not fall back to ""`);
      assert.equal(asset.name, raw.display_name, `${id}: name comes from the server display_name`);
      assert.equal(asset.image_url, raw.image_url, `${id}: image_url must be the server URL`);
      assert.ok(asset.image_url.startsWith("/library/"), `${id}: image_url must be a library URL`);
      assert.ok(asset.thumbnail_url, `${id}: thumbnail_url must stay non-empty`);
      if (expectedKind.get(id) === "image") {
        assert.equal(asset.thumbnail_ready, true, `${id}: image thumbnails must be ready`);
        assert.equal(asset.thumbnail_url, raw.thumbnail_url, `${id}: thumbnail_url must be the derivative URL`);
        assert.ok(asset.thumbnail_url.includes("/thumbnails/"), `${id}: thumbnail_url must point at the derivative`);
      }
      assert.equal(asset.mediaKind, expectedKind.get(id), `${id}: mediaKind must resolve, not fall back to "image" for a video`);
      assert.equal(asset.width, raw.business_fields.width, `${id}: width must come from the row`);
      assert.equal(asset.height, raw.business_fields.height, `${id}: height must come from the row`);
      assert.ok(asset.width > 1 && asset.height > 1, `${id}: dimensions must be real, not the positive() fallback of 1`);
      assert.equal(asset.created_at, raw.created_at, `${id}: created_at must come from the row`);
      assert.ok(asset.created_at, `${id}: created_at must stay non-empty`);
    }
  }
});

test("2. MCP compact fields agree with the API rows for the same assets", async () => {
  const { mcp, galleryById, stackId } = await setupOnce();
  const listed = await mcp.request("tools/call", { name: "asset_list", arguments: { limit: 100 } });
  const compactById = new Map(listed.result.structuredContent.assets.map((asset) => [asset.id, asset]));
  const expectedKind = new Map([
    [IMAGE_A.id, "image"],
    [VIDEO.id, "video"],
    [IMAGE_COVER.id, "image"],
    [IMAGE_MEMBER.id, "image"],
  ]);
  for (const id of [IMAGE_A.id, VIDEO.id, IMAGE_COVER.id, IMAGE_MEMBER.id]) {
    const compact = compactById.get(id);
    assert.ok(compact, `${id} missing from asset_list`);
    const row = galleryById.get(id);
    assert.equal(compact.id, row.id, `${id}: id must match`);
    assert.equal(compact.created_at, row.created_at, `${id}: created_at must match`);
    assert.equal(String(compact.group ?? ""), String(row.group ?? ""), `${id}: group must match`);
    assert.deepEqual(compact.tags ?? [], row.tags ?? [], `${id}: tags must match`);
    assert.equal(Number(compact.rating ?? 0), Number(row.rating ?? 0), `${id}: rating must match`);
    assert.equal(Boolean(compact.favorite), Boolean(row.favorite), `${id}: favorite must match`);
    assert.equal(compact.width, row.business_fields.width, `${id}: width must match business_fields`);
    assert.equal(compact.height, row.business_fields.height, `${id}: height must match business_fields`);
    assert.equal(compact.media_kind, expectedKind.get(id), `${id}: media_kind must match`);
    assert.equal(compact.image_path, row.image_path, `${id}: image_path must match`);
    if (id === IMAGE_COVER.id) {
      assert.ok(row.stack, `${id}: the gallery must annotate the stack cover`);
      assert.deepEqual(compact.stack, { id: row.stack.id, name: row.stack.name }, `${id}: MCP stack must match the API stack`);
      assert.equal(row.stack.id, stackId);
      assert.equal(row.stack.name, STACK_NAME);
    } else if (id === IMAGE_MEMBER.id) {
      // Known view difference: MCP is membership-oriented — attachStackToAssets
      // names the stack for every member — while the flat gallery annotates
      // covers only, so the member's API row carries no stack at all. The
      // values MCP reports must still be the real stack's.
      assert.deepEqual(compact.stack, { id: stackId, name: STACK_NAME }, `${id}: MCP member stack must name the real stack`);
      assert.equal("stack" in row, false, `${id}: non-cover gallery rows carry no stack annotation`);
    } else {
      assert.equal("stack" in compact, false, `${id}: unstacked assets omit the stack key`);
      assert.equal("stack" in row, false, `${id}: unstacked gallery rows carry no stack annotation`);
    }
    // The excerpt is the interface prompt's opening, cut with an ellipsis when
    // truncated; only the prefix relationship is asserted, never the cut length.
    const prompt = String(row.prompt ?? "");
    const excerpt = String(compact.prompt_excerpt ?? "");
    const stem = excerpt.endsWith("…") ? excerpt.slice(0, -1) : excerpt;
    assert.ok(prompt.startsWith(stem), `${id}: prompt_excerpt must be a prefix of the prompt`);
    if (prompt) assert.ok(excerpt, `${id}: a prompted asset needs a non-empty excerpt`);
  }
});

test("3. the legacy JSON backend's known key gaps stay exactly as pinned", async (t) => {
  const previous = await setupOnce();
  // startMosaRuntime is one-per-process: release the SQLite runtime before the
  // JSON one starts (tests run sequentially, so tests 1/2 are already done).
  await previous.stopRuntime();
  previous.runtimeStopped = true;

  const root = await mkdtemp(join(tmpdir(), "mosa-shape-json-"));
  t.after(() => removeTestPath(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const sourceDir = join(projectRoot, "generated-images");
  const assetsRoot = join(root, "assets");
  const store = createJsonAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), assetsRoot });
  const imagePathA = await writeImageFixture(join(sourceDir, `${IMAGE_A.id}.png`), IMAGE_A);
  const imagePathCover = await writeImageFixture(join(sourceDir, `${IMAGE_COVER.id}.png`), IMAGE_COVER);
  const imagePathMember = await writeImageFixture(join(sourceDir, `${IMAGE_MEMBER.id}.png`), IMAGE_MEMBER);
  const videoPath = await writeVideoFixture(join(sourceDir, `${VIDEO.id}.mp4`));
  await store.createAsset({
    assetId: IMAGE_A.id,
    imagePath: imagePathA,
    prompt: PROMPT_LONG,
    tags: TAGS,
    group: GROUP_NAME,
    rating: 4,
    favorite: true,
    references: REFERENCES,
  });
  await store.createAsset({
    assetId: VIDEO.id,
    imagePath: videoPath,
    prompt: PROMPT_SHORT,
    business_fields: {
      media_kind: "video",
      width: VIDEO.width,
      height: VIDEO.height,
      duration_seconds: VIDEO.durationSeconds,
    },
  });
  await store.createAsset({ assetId: IMAGE_COVER.id, imagePath: imagePathCover, prompt: PROMPT_SHORT });
  await store.createAsset({ assetId: IMAGE_MEMBER.id, imagePath: imagePathMember, prompt: PROMPT_SHORT });

  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: root,
    libraryDir: join(root, "library"),
    assetsRoot,
    generatedImagesDir: sourceDir,
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "sessions"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-data"),
    cowartRegistryPath: join(root, "state", "cowart-projects.json"),
  });
  t.after(() => runtime.stop());

  const response = await fetch(`${runtime.url}/api/assets?project=${PROJECT}&limit=250`);
  assert.equal(response.status, 200);
  const body = await response.json();
  const jsonRows = body.assets.filter((asset) => [IMAGE_A.id, VIDEO.id, IMAGE_COVER.id, IMAGE_MEMBER.id].includes(asset.id));
  assert.equal(jsonRows.length, 4, "the JSON backend must hold the same four assets");

  const sqliteKeys = new Set();
  for (const row of previous.galleryById.values()) for (const key of Object.keys(row)) sqliteKeys.add(key);
  const jsonKeys = new Set();
  for (const row of jsonRows) for (const key of Object.keys(row)) jsonKeys.add(key);
  const sqliteOnly = [...sqliteKeys].filter((key) => !jsonKeys.has(key)).sort();
  assert.deepEqual(
    sqliteOnly,
    [...JSON_BACKEND_MISSING_SQLITE_KEYS].sort(),
    "a new SQLite-only key means the JSON backend's known differences changed; update JSON_BACKEND_MISSING_SQLITE_KEYS only with Claude's review",
  );
});

after(async () => {
  if (!shared) return;
  const { sqlite, mcp, runtimeStopped } = shared;
  mcp.terminateIfRunning();
  if (!runtimeStopped) await shared.stopRuntime();
  // The suite wrote to this library through real services; leave only after an
  // integrity pass over the managed database.
  const database = new Database(join(sqlite.workspace.libraryDir, "mosa.db"), { readonly: true });
  try {
    const result = database.pragma("integrity_check", { simple: true });
    assert.equal(result, "ok", "the managed library must stay integral");
  } finally {
    database.close();
  }
  await removeTestPath(sqlite.workspace.root, { recursive: true, force: true });
  if (shared.normalizeTempRoot) await rm(shared.normalizeTempRoot, { recursive: true, force: true });
});
