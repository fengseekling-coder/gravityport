import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJsonAssetStore } from "../lib/asset-store.mjs";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import {
  CURRENT_SCHEMA_VERSION,
  createSqliteAssetStore,
  sqliteDatabasePath,
} from "../lib/sqlite-asset-store.mjs";
import { uniquePngBytes } from "./helpers/unique-image.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const repositoryRoot = join(import.meta.dirname, "..");

async function writeUniqueAssetImage(dir, name, seed) {
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, name);
  await writeFile(filePath, await uniquePngBytes(seed));
  return filePath;
}

async function createSqliteFixture(t, prefix = "mosa-canvas-sqlite-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  const sourcesDir = join(projectRoot, "generated-images");
  const store = createSqliteAssetStore({
    projectRoot,
    managerDir: join(projectRoot, "mosa"),
    libraryDir,
    initializeFreshLibrary: true,
  });
  t.after(() => store.close());
  return { root, projectRoot, libraryDir, sourcesDir, store };
}

async function createJsonFixture(t, prefix = "mosa-canvas-json-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const libraryDir = join(root, "library");
  const sourcesDir = join(projectRoot, "generated-images");
  await mkdir(sourcesDir, { recursive: true });
  const store = createJsonAssetStore({
    projectRoot,
    managerDir,
    assetsRoot: join(libraryDir, "assets"),
  });
  t.after(() => store.close?.());
  return { root, projectRoot, libraryDir, sourcesDir, store };
}

async function seedAssets(store, sourcesDir, ids, seedOffset = 1) {
  for (let index = 0; index < ids.length; index += 1) {
    const assetId = ids[index];
    const imagePath = await writeUniqueAssetImage(sourcesDir, `${assetId}.png`, seedOffset + index);
    await store.createAsset(
      { projectId: "default", assetId, imagePath, prompt: `prompt-${assetId}` },
      { ingestMode: "manual" },
    );
  }
}

async function runStoreCanvasStateContract({ createFixture, label }) {
  test(`${label}: canvas state partial PATCH, batch query, reset positions, validation, Trash keep & permanent cleanup`, async (t) => {
    const { store, sourcesDir } = await createFixture(t);
    await seedAssets(store, sourcesDir, ["a1", "a2", "a3"], 10);

    // Initially empty
    assert.deepEqual(await store.getAssetCanvasStates("default", ["a1", "a2", "a3"]), {});
    assert.deepEqual(await store.getAssetCanvasStates("default", []), {});

    // Partial PATCH keeps omitted fields intact
    const s1 = await store.updateAssetCanvasState("default", "a1", { is_final: true });
    assert.equal(s1.is_final, true);
    assert.deepEqual(s1.marks, []);
    assert.equal(s1.pos_x, null);
    assert.equal(s1.pos_y, null);
    assert.ok(s1.updated_at);

    const s2 = await store.updateAssetCanvasState("default", "a1", {
      marks: [{ x: 0.25, y: 0.75, text: "adjust lighting" }],
    });
    assert.equal(s2.is_final, true, "omitted is_final stays true");
    assert.deepEqual(s2.marks, [{ x: 0.25, y: 0.75, text: "adjust lighting" }]);

    const s3 = await store.updateAssetCanvasState("default", "a1", {
      pos_x: 420.5,
      pos_y: 180.25,
    });
    assert.equal(s3.is_final, true, "omitted is_final preserved");
    assert.deepEqual(s3.marks, [{ x: 0.25, y: 0.75, text: "adjust lighting" }], "omitted marks preserved");
    assert.equal(s3.pos_x, 420.5);
    assert.equal(s3.pos_y, 180.25);

    const s4 = await store.updateAssetCanvasState("default", "a1", { is_final: false });
    assert.equal(s4.is_final, false);
    assert.equal(s4.pos_x, 420.5, "turning off final keeps manual position");
    assert.deepEqual(s4.marks, [{ x: 0.25, y: 0.75, text: "adjust lighting" }], "turning off final keeps marks");

    // Second asset moved separately
    await store.updateAssetCanvasState("default", "a2", {
      is_final: true,
      marks: [{ x: 1.4, y: -0.2, text: "clamped" }],
      pos_x: 111,
      pos_y: 222,
    });
    const queried = await store.getAssetCanvasStates("default", ["a1", "a2", "a3"]);
    assert.equal(Object.hasOwn(queried, "a3"), false, "untouched asset omitted from query");
    assert.deepEqual(queried.a2.marks, [{ x: 1, y: 0, text: "clamped" }], "mark coordinates clamp to [0,1]");

    // Reset positions only clears specified assetIds' coordinates and leaves final/marks/other assets intact
    const cleared = await store.clearAssetCanvasPositions("default", ["a1"]);
    assert.equal(cleared.cleared, 1);
    const afterReset = await store.getAssetCanvasStates("default", ["a1", "a2"]);
    assert.equal(afterReset.a1.pos_x, null);
    assert.equal(afterReset.a1.pos_y, null);
    assert.equal(afterReset.a1.is_final, false);
    assert.deepEqual(afterReset.a1.marks, [{ x: 0.25, y: 0.75, text: "adjust lighting" }]);
    assert.equal(afterReset.a2.pos_x, 111, "unlisted asset position untouched");
    assert.equal(afterReset.a2.pos_y, 222);

    // Explicit null on pos_x clears only pos_x
    await store.updateAssetCanvasState("default", "a2", { pos_x: null });
    const afterNullX = await store.getAssetCanvasStates("default", ["a2"]);
    assert.equal(afterNullX.a2.pos_x, null);
    assert.equal(afterNullX.a2.pos_y, 222);

    // Validation & 404 checks
    await assert.rejects(
      () => store.updateAssetCanvasState("default", "missing-asset", { is_final: true }),
      (error) => error?.code === "ASSET_NOT_FOUND" && error?.statusCode === 404,
    );
    await assert.rejects(
      () => store.updateAssetCanvasState("default", "a1", { is_final: "yes" }),
      (error) => error?.statusCode === 400 && error?.code === "INVALID_FIELD",
    );
    await assert.rejects(
      () => store.updateAssetCanvasState("default", "a1", { pos_x: Number.NaN }),
      (error) => error?.statusCode === 400 && error?.code === "INVALID_FIELD",
    );
    await assert.rejects(
      () => store.updateAssetCanvasState("default", "a1", { unknown_field: 1 }),
      (error) => error?.statusCode === 400 && error?.code === "INVALID_FIELD",
    );
    await assert.rejects(
      () =>
        store.updateAssetCanvasState("default", "a1", {
          marks: Array.from({ length: 101 }, () => ({ x: 0.5, y: 0.5, text: "x" })),
        }),
      (error) => error?.statusCode === 400 && error?.code === "FIELD_TOO_MANY",
    );
    await assert.rejects(
      () =>
        store.updateAssetCanvasState("default", "a1", {
          marks: [{ x: 0.5, y: 0.5, text: "x".repeat(201) }],
        }),
      (error) => error?.statusCode === 400 && error?.code === "FIELD_TOO_LONG",
    );

    // Moving to Trash preserves canvas state; restoring preserves it; permanent delete clears it
    await store.deleteAsset("default", "a1");
    assert.equal((await store.getAssetCanvasStates("default", ["a1"])).a1.marks[0].text, "adjust lighting");
    await store.restoreAsset("default", "a1");
    assert.equal((await store.getAssetCanvasStates("default", ["a1"])).a1.marks[0].text, "adjust lighting");

    await store.deleteAsset("default", "a1");
    await store.permanentlyDeleteAsset("default", "a1");
    assert.deepEqual(await store.getAssetCanvasStates("default", ["a1"]), {}, "permanentlyDeleteAsset removes canvas state");

    // emptyTrash clears remaining trashed asset's canvas state
    await store.deleteAsset("default", "a2");
    await store.emptyTrash("default");
    assert.deepEqual(await store.getAssetCanvasStates("default", ["a2"]), {}, "emptyTrash removes trashed canvas state");
  });
}

runStoreCanvasStateContract({ createFixture: createSqliteFixture, label: "sqlite store" });
runStoreCanvasStateContract({ createFixture: createJsonFixture, label: "json store" });

test("SQLite schema v18 -> v19 migration creates asset_canvas_state and preserves existing assets and notes", async (t) => {
  const { root, projectRoot, libraryDir, sourcesDir, store } = await createSqliteFixture(t, "mosa-migrate-v18-v19-");
  await seedAssets(store, sourcesDir, ["legacy-1"], 50);
  await store.updateCuration("default", "legacy-1", { curated: true, curation_note: "keep v18 note" });
  store.close();

  const dbPath = sqliteDatabasePath(libraryDir);
  const raw = new Database(dbPath);
  raw.exec("DROP TABLE IF EXISTS asset_canvas_state;");
  raw.prepare("DELETE FROM schema_migrations WHERE version > 18").run();
  raw.prepare("UPDATE library_meta SET value = '18' WHERE key = 'schema_version'").run();
  raw.close();

  const upgraded = createSqliteAssetStore({
    projectRoot,
    managerDir: join(projectRoot, "mosa"),
    libraryDir,
  });
  t.after(() => upgraded.close());

  const asset = await upgraded.getAsset("default", "legacy-1");
  assert.equal(asset.curation_note, "keep v18 note", "existing curation_note survives migration");

  const inspect = new Database(dbPath, { readonly: true });
  t.after(() => inspect.close());
  const versionRow = inspect.prepare("SELECT value FROM library_meta WHERE key = 'schema_version'").get();
  assert.equal(versionRow?.value, String(CURRENT_SCHEMA_VERSION));
  // 任务 459 升到 v20：本测试只钉「不低于 19」（asset_canvas_state 自 v19 起
  // 存在），=== 20 的断言由 test/learning-library-store.test.mjs 接替。
  assert.ok(CURRENT_SCHEMA_VERSION >= 19);
  const tableRow = inspect.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'asset_canvas_state'").get();
  assert.equal(tableRow?.name, "asset_canvas_state");
  const columnNames = inspect.prepare("SELECT name FROM pragma_table_info('asset_canvas_state')").all().map((row) => row.name);
  assert.deepEqual(columnNames, ["project_id", "asset_id", "is_final", "marks_json", "pos_x", "pos_y", "updated_at"]);
  const migRow = inspect.prepare("SELECT version FROM schema_migrations WHERE version = 19").get();
  assert.equal(migRow?.version, 19);

  // Also verify batch chunking (> 500 IDs) in SQLite store
  await upgraded.updateAssetCanvasState("default", "legacy-1", { is_final: true, pos_x: 90, pos_y: 120 });
  const batchIds = ["legacy-1", ...Array.from({ length: 599 }, (_, index) => `missing-id-${index}`)];
  const batchStates = await upgraded.getAssetCanvasStates("default", batchIds);
  assert.equal(batchStates["legacy-1"]?.is_final, true);
  assert.deepEqual(await upgraded.clearAssetCanvasPositions("default", batchIds), { cleared: 1 });
  assert.equal(existsSync(join(root, "library", "mosa.db")), true);
});

test("HTTP canvas-state routes enforce client token, persist partial/batch updates, and sync curation_note with generation-history", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-canvas-http-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  const sourcesDir = join(projectRoot, "generated-images");
  const imgPath = await writeUniqueAssetImage(sourcesDir, "hero.png", 99);
  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot,
    managerDir: repositoryRoot,
    appDir: join(repositoryRoot, "web", "gravityport", "dist"),
    libraryDir,
    assetsRoot: join(libraryDir, "assets"),
    generatedImagesDir: sourcesDir,
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "codex-sessions"),
    codexThreadHistoryDir: join(root, "codex-thread-history"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-canvas"),
    cowartRegistryPath: join(root, "state", "cowart-projects.json"),
  });
  t.after(() => runtime.stop());

  const headers = {
    "content-type": "application/json",
    "x-mosa-client-token": runtime.clientToken,
  };

  // Create one asset via API
  const createRes = await fetch(`${runtime.url}/api/assets/create`, {
    method: "POST",
    headers,
    body: JSON.stringify({ projectId: "default", assetId: "hero-1", imagePath: imgPath, prompt: "hero prompt" }),
  });
  assert.equal(createRes.status, 200);

  // Auth gate check with explicit empty token (clean-test-env preserves explicit header)
  for (const [method, urlPath, body] of [
    ["POST", "/api/assets/canvas-state/query", { projectId: "default", assetIds: ["hero-1"] }],
    ["PATCH", "/api/assets/default/hero-1/canvas-state", { is_final: true }],
    ["POST", "/api/assets/canvas-state/reset-positions", { projectId: "default", assetIds: ["hero-1"] }],
  ]) {
    const unauth = await fetch(`${runtime.url}${urlPath}`, {
      method,
      headers: { "content-type": "application/json", "x-mosa-client-token": "" },
      body: JSON.stringify(body),
    });
    assert.equal(unauth.status, 401, `${method} ${urlPath} must require client token`);
  }

  // Partial PATCH & read back
  const patchFinal = await fetch(`${runtime.url}/api/assets/default/hero-1/canvas-state`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ is_final: true, pos_x: 333, pos_y: 444 }),
  });
  assert.equal(patchFinal.status, 200);
  const patchMarks = await fetch(`${runtime.url}/api/assets/default/hero-1/canvas-state`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ marks: [{ x: 0.3, y: 0.6, text: "sharpen eyes" }] }),
  });
  assert.equal(patchMarks.status, 200);
  const marksPayload = await patchMarks.json();
  assert.equal(marksPayload.state.is_final, true);
  assert.equal(marksPayload.state.pos_x, 333);

  const queryRes = await fetch(`${runtime.url}/api/assets/canvas-state/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({ projectId: "default", assetIds: ["hero-1", "unknown-id"] }),
  });
  assert.equal(queryRes.status, 200);
  const queryPayload = await queryRes.json();
  assert.deepEqual(queryPayload.states["hero-1"].marks, [{ x: 0.3, y: 0.6, text: "sharpen eyes" }]);
  assert.equal(Object.hasOwn(queryPayload.states, "unknown-id"), false);

  // Batch validation errors
  const badBatch = await fetch(`${runtime.url}/api/assets/canvas-state/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({ projectId: "default", assetIds: Array.from({ length: 1001 }, (_, i) => `id-${i}`) }),
  });
  assert.equal(badBatch.status, 400);

  const badPatch = await fetch(`${runtime.url}/api/assets/default/hero-1/canvas-state`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ is_final: "nope" }),
  });
  assert.equal(badPatch.status, 400);

  const missingAssetPatch = await fetch(`${runtime.url}/api/assets/default/does-not-exist/canvas-state`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ is_final: true }),
  });
  assert.equal(missingAssetPatch.status, 404);

  // Reset positions preserves marks & is_final
  const resetRes = await fetch(`${runtime.url}/api/assets/canvas-state/reset-positions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ projectId: "default", assetIds: ["hero-1"] }),
  });
  assert.equal(resetRes.status, 200);
  assert.deepEqual(await resetRes.json(), { cleared: 1 });
  const afterReset = await (
    await fetch(`${runtime.url}/api/assets/canvas-state/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId: "default", assetIds: ["hero-1"] }),
    })
  ).json();
  assert.equal(afterReset.states["hero-1"].pos_x, null);
  assert.equal(afterReset.states["hero-1"].pos_y, null);
  assert.equal(afterReset.states["hero-1"].is_final, true);
  assert.deepEqual(afterReset.states["hero-1"].marks, [{ x: 0.3, y: 0.6, text: "sharpen eyes" }]);

  // Seed generation event so generation-history includes hero-1 in output_assets
  const genRes = await fetch(`${runtime.url}/api/generations`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      outputAssetId: "hero-1",
      provider: "chatgpt",
      conversationId: "conv-canvas-http",
      messageId: "msg-canvas-http-1",
      effectivePrompt: "hero prompt",
      verificationLevel: "observed",
    }),
  });
  assert.equal(genRes.status, 201);

  // Curation note round-trip via PATCH /curation + generation-history
  const noteRes = await fetch(`${runtime.url}/api/assets/default/hero-1/curation`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ curation_note: "keep composition" }),
  });
  assert.equal(noteRes.status, 200);
  const notePayload = await noteRes.json();
  assert.equal(notePayload.asset.curation_note, "keep composition");

  const historyRes = await fetch(`${runtime.url}/api/assets/default/hero-1/generation-history`, {
    headers: { "x-mosa-client-token": runtime.clientToken },
  });
  assert.equal(historyRes.status, 200);
  const historyPayload = await historyRes.json();
  assert.equal(historyPayload.history?.asset_id, "hero-1");
  const historyAsset = (historyPayload.history?.output_assets || []).find((item) => item.id === "hero-1");
  assert.equal(historyAsset?.curation_note, "keep composition", "generation-history output_assets carries curation_note");
});
