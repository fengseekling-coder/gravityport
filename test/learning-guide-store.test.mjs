// Learning-guide store tests (task 463). Every case drives the real
// createSqliteAssetStore against a temporary on-disk library — no test doubles,
// no copied implementation. Covers: v20→v21 tables + upgrade (A), FK cascades
// (A), the "learn a new image once" pending rule (C.1), the analysis input
// payload and its 410/422 boundaries (C.1), the run state machine (C.2), the
// AI guide write with locked/tombstone protection and revert (C.3), the manual
// edit path with revision conflicts and the 30-minute edit-run merge (C.3),
// and the learningEntry / learningRun gallery filters (C.4).
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CURRENT_SCHEMA_VERSION,
  createSqliteAssetStore,
  sqliteDatabasePath,
} from "../lib/sqlite-asset-store.mjs";
import { processDerivativeJob } from "../lib/derivative-worker.js";
import { learningAnalysisFingerprint } from "../lib/ai/learning-schema.mjs";
import { uniquePngBytes } from "./helpers/unique-image.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

let imageSeed = 0;

const VALID_NOTE = {
  subject: "一张测试图",
  style_keywords: ["flat"],
  palette: [{ hex: "#112233", role: "main", name: "深蓝" }],
  composition: "居中",
  camera: "平视",
  lighting: "柔光",
  material: "哑光",
  character: "",
  mood_keywords: ["安静"],
  prompt_techniques: ["minimal palette"],
  has_text: false,
};

async function createStore(t, prefix = "mosa-learning-guide-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  const generatedDir = join(projectRoot, "generated-images");
  await mkdir(generatedDir, { recursive: true });
  const sourcePath = join(generatedDir, "fixture.png");
  await writeFile(sourcePath, await uniquePngBytes(++imageSeed));
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir, initializeFreshLibrary: true });
  t.after(() => store.close());
  return { root, projectRoot, libraryDir, sourcePath, store };
}

async function seedImage(store, sourcePath, id, prompt = `prompt for ${id}`) {
  // 每张图独立字节（不同纯色），派生管线也读得到。
  await writeFile(sourcePath, await uniquePngBytes(++imageSeed));
  const created = await store.createAsset({ assetId: id, imagePath: sourcePath, prompt, source: { type: "local-file" } });
  return created.asset.id;
}

async function drainDerivatives(store) {
  for (;;) {
    const job = await store.claimDerivativeJob();
    if (!job) break;
    const result = await processDerivativeJob(store, job);
    assert.equal(result.ok, true, `derivative generation failed: ${JSON.stringify(result)}`);
  }
}

async function seedLearnableImage(store, sourcePath, id, prompt = `prompt for ${id}`) {
  await seedImage(store, sourcePath, id, prompt);
  await drainDerivatives(store);
  return id;
}

// 教具：建学习库（+可选成员）。run 各测试自己建、自己收尾。
async function makeLibrary(store, { libraryName, assetIds = [] } = {}) {
  const library = await store.createLearningLibrary({ projectId: "default", name: libraryName });
  if (assetIds.length) await store.addToLearningLibrary("default", library.id, { assetIds });
  return library;
}

async function startRun(store, library, { assetIds = [] } = {}) {
  return store.createLearningRun({
    projectId: "default",
    libraryId: library.id,
    assetIds,
    serviceId: "claude",
    analysisModel: "claude-haiku-5-5",
    summaryModel: "claude-sonnet-5-5",
    language: "zh",
    estimateUsd: 0.3,
    capUsd: 0.5,
  });
}

function sideDb(libraryDir) {
  return new Database(sqliteDatabasePath(libraryDir), { readonly: false });
}

function sideRows(libraryDir, sql, ...params) {
  const db = sideDb(libraryDir);
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

async function fingerprintInputs(store, assetId) {
  const asset = await store.getAsset("default", assetId);
  return learningAnalysisFingerprint({
    contentSha256: asset.content_sha256,
    prompt: asset.prompt,
    userPrompt: asset.user_prompt || "",
    negativePrompt: asset.negative_prompt || "",
  });
}

test("CURRENT_SCHEMA_VERSION is 21 and a fresh library carries all five learning-guide tables", async (t) => {
  assert.equal(CURRENT_SCHEMA_VERSION, 21);
  const { libraryDir, store } = await createStore(t);
  await store.ensureProject("default");
  const tables = sideRows(libraryDir, "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('learning_asset_analyses','learning_guides','learning_guide_entries','learning_guide_entry_sources','learning_runs','learning_run_items') ORDER BY name").map((row) => row.name);
  assert.deepEqual(tables, [
    "learning_asset_analyses",
    "learning_guide_entries",
    "learning_guide_entry_sources",
    "learning_guides",
    "learning_run_items",
    "learning_runs",
  ]);
  const indexes = sideRows(libraryDir, "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'learning_%' ORDER BY name").map((row) => row.name);
  assert.ok(indexes.includes("learning_guide_entries_section_idx"));
  assert.ok(indexes.includes("learning_guide_entry_sources_asset_idx"));
  assert.ok(indexes.includes("learning_runs_library_started_idx"));
  assert.ok(indexes.includes("learning_runs_library_open_idx"), "partial unique index exists");
  const partialSql = sideRows(libraryDir, "SELECT sql FROM sqlite_master WHERE name = 'learning_runs_library_open_idx'")[0].sql;
  assert.match(partialSql, /WHERE status IN \('running', 'pausing', 'paused'\)/);
  const version = sideRows(libraryDir, "SELECT value FROM library_meta WHERE key = 'schema_version'")[0].value;
  assert.equal(version, "21");
});

test("a v20 library upgrades to v21 on open and keeps every pre-existing row intact", async (t) => {
  const { libraryDir, sourcePath, store } = await createStore(t, "mosa-guide-upgrade-");
  await store.ensureProject("default");
  await seedImage(store, sourcePath, "old-a");
  const oldLibrary = await makeLibrary(store, { libraryName: "旧学习库", assetIds: ["old-a"] });

  const before = JSON.stringify({
    assets: sideRows(libraryDir, "SELECT * FROM assets ORDER BY project_id, id"),
    members: sideRows(libraryDir, "SELECT * FROM learning_library_members ORDER BY library_id, asset_id"),
    libraries: sideRows(libraryDir, "SELECT * FROM learning_libraries ORDER BY id"),
  });
  // Roll the on-disk schema back to exactly v20: drop the six learning-guide
  // tables + indexes and stamp the old version.
  const raw = sideDb(libraryDir);
  raw.exec(`
    DROP TABLE learning_run_items;
    DROP TABLE learning_runs;
    DROP TABLE learning_guide_entry_sources;
    DROP TABLE learning_guide_entries;
    DROP TABLE learning_guides;
    DROP TABLE learning_asset_analyses;
    DROP INDEX IF EXISTS learning_guide_entries_section_idx;
    DROP INDEX IF EXISTS learning_guide_entry_sources_asset_idx;
    DROP INDEX IF EXISTS learning_runs_library_started_idx;
    DROP INDEX IF EXISTS learning_runs_library_open_idx;
  `);
  raw.prepare("UPDATE library_meta SET value = '20' WHERE key = 'schema_version'").run();
  raw.close();

  const reopened = createSqliteAssetStore({
    projectRoot: join(libraryDir, "..", "project"),
    managerDir: join(libraryDir, "..", "project", "mosa"),
    libraryDir,
  });
  t.after(() => reopened.close());
  const after = JSON.stringify({
    assets: sideRows(libraryDir, "SELECT * FROM assets ORDER BY project_id, id"),
    members: sideRows(libraryDir, "SELECT * FROM learning_library_members ORDER BY library_id, asset_id"),
    libraries: sideRows(libraryDir, "SELECT * FROM learning_libraries ORDER BY id"),
  });
  assert.equal(after, before, "the v20→v21 upgrade must not touch assets or 459 rows");
  assert.equal(sideRows(libraryDir, "SELECT value FROM library_meta WHERE key = 'schema_version'")[0].value, "21");
  const state = await reopened.getLearningState("default", oldLibrary.id);
  assert.equal(state.counts.total, 1, "pre-existing data survives");
});

test("cascade: deleting a library removes its guide/entries/sources/runs/items but keeps the shared analysis; permanently deleting an asset removes its analysis/source rows/run items but entries survive", async (t) => {
  const { libraryDir, sourcePath, store } = await createStore(t, "mosa-guide-cascade-");
  const assetId = await seedLearnableImage(store, sourcePath, "ca1");
  const first = await makeLibrary(store, { libraryName: "级联一", assetIds: [assetId] });
  const second = await makeLibrary(store, { libraryName: "级联二", assetIds: [assetId] });

  // 第一个库里学一张图 + 写一本手册（条目来源 = 这张图）。
  const run1 = await startRun(store, first, { assetIds: [assetId] });
  await store.recordLearningItemResult({
    projectId: "default", runId: run1.id, assetId, status: "done", fingerprint: await fingerprintInputs(store, assetId), note: VALID_NOTE,
    serviceId: "claude", model: "claude-haiku-5-5", inputTokens: 10, outputTokens: 10, costUsd: 0.001,
  });
  await store.transitionLearningRun({ projectId: "default", runId: run1.id, to: "running" });
  await store.applyGeneratedGuide({
    projectId: "default", runId: run1.id,
    entries: [{ section: "palette", text: "主色深蓝", swatches: [{ hex: "#112233", name: "深蓝" }], sourceAssetIds: [assetId] }],
    language: "zh", inputTokens: 100, outputTokens: 50, costUsd: 0.002, droppedNoSource: 0,
  });

  assert.equal(sideRows(libraryDir, "SELECT COUNT(*) AS n FROM learning_asset_analyses")[0].n, 1);
  assert.equal(sideRows(libraryDir, "SELECT COUNT(*) AS n FROM learning_guides")[0].n, 1);

  // 删第一个学习库：它的手册、条目、来源、run、条目行全没了；分析留着（跟着图走）。
  await store.deleteLearningLibrary("default", first.id);
  assert.equal(sideRows(libraryDir, "SELECT COUNT(*) AS n FROM learning_guides")[0].n, 0);
  assert.equal(sideRows(libraryDir, "SELECT COUNT(*) AS n FROM learning_guide_entries")[0].n, 0);
  assert.equal(sideRows(libraryDir, "SELECT COUNT(*) AS n FROM learning_guide_entry_sources")[0].n, 0);
  assert.equal(sideRows(libraryDir, "SELECT COUNT(*) AS n FROM learning_runs")[0].n, 0);
  assert.equal(sideRows(libraryDir, "SELECT COUNT(*) AS n FROM learning_run_items")[0].n, 0);
  assert.equal(sideRows(libraryDir, "SELECT COUNT(*) AS n FROM learning_asset_analyses WHERE asset_id = 'ca1'")[0].n, 1, "analysis follows the asset");
  const secondPending = await store.listLearningPending("default", second.id);
  assert.deepEqual(secondPending, [], "the second library sees the shared analysis");

  // 第二个库里建手册（run 无图直接 summarize）+ 建一个带条目行的 run。
  const run2 = await startRun(store, second);
  await store.applyGeneratedGuide({
    projectId: "default", runId: run2.id,
    entries: [{ section: "palette", text: "第二个库的配色", swatches: [], sourceAssetIds: [assetId] }],
    language: "zh", inputTokens: 1, outputTokens: 1, costUsd: 0, droppedNoSource: 0,
  });
  const run3 = await startRun(store, second, { assetIds: [assetId] });
  assert.equal(sideRows(libraryDir, "SELECT COUNT(*) AS n FROM learning_guide_entries")[0].n, 1);

  // 彻底删图（进回收站再清空）：分析、来源行、run 条目行没了；条目本身留着。
  await store.deleteAsset("default", assetId, { reason: "test" });
  await store.emptyTrash("default");
  assert.equal(sideRows(libraryDir, "SELECT COUNT(*) AS n FROM learning_asset_analyses WHERE asset_id = 'ca1'")[0].n, 0, "analysis gone with the asset");
  assert.equal(sideRows(libraryDir, "SELECT COUNT(*) AS n FROM learning_run_items WHERE asset_id = 'ca1'")[0].n, 0, "run item gone with the asset");
  assert.equal(sideRows(libraryDir, "SELECT COUNT(*) AS n FROM learning_guide_entry_sources WHERE asset_id = 'ca1'")[0].n, 0, "source row gone with the asset");
  assert.equal(sideRows(libraryDir, "SELECT COUNT(*) AS n FROM learning_runs")[0].n, 2, "run rows survive the asset");
  assert.equal(sideRows(libraryDir, "SELECT COUNT(*) AS n FROM learning_guide_entries")[0].n, 1, "the entry itself survives");
});

test("只学新的: new asset pending; done clears it; prompt change re-pends; second library shares the analysis; refusal stays out, bad-output re-pends; trash hides; no medium counts into noPreview", async (t) => {
  const { sourcePath, store } = await createStore(t, "mosa-guide-pending-");
  const a = await seedLearnableImage(store, sourcePath, "pa");
  await seedImage(store, sourcePath, "pm"); // 派生没跑：没有中图
  const library = await makeLibrary(store, { libraryName: "待学", assetIds: [a, "pm"] });
  const run = await startRun(store, library, { assetIds: [a] });

  const pending1 = await store.listLearningPending("default", library.id);
  assert.deepEqual(pending1.map((item) => item.assetId), [a]);
  assert.equal(pending1[0].width, 8, "width comes from business_fields");

  const state1 = await store.getLearningState("default", library.id);
  assert.equal(state1.counts.total, 2);
  assert.equal(state1.counts.pending, 1);
  assert.equal(state1.counts.noPreview, 1, "no-medium member counts into noPreview, not pending");

  const fingerprint = await fingerprintInputs(store, "pa");
  await store.recordLearningItemResult({
    projectId: "default", runId: run.id, assetId: a, status: "done", fingerprint, note: VALID_NOTE,
  });
  const pending2 = await store.listLearningPending("default", library.id);
  assert.deepEqual(pending2, [], "done asset leaves the pending list");

  // 改提示词 → 指纹变 → 又在待学里。
  await store.updateMetadata("default", "pa", { prompt: "全新的提示词" });
  const pending3 = await store.listLearningPending("default", library.id);
  assert.deepEqual(pending3.map((item) => item.assetId), [a]);

  // 改回提示词（指纹复原）→ 共用分析：另一个学习库的待学里没有它。
  await store.updateMetadata("default", "pa", { prompt: "prompt for pa" });
  const second = await makeLibrary(store, { libraryName: "共用", assetIds: [a] });
  const secondPending = await store.listLearningPending("default", second.id);
  assert.deepEqual(secondPending, [], "analysis is shared across libraries");

  // 一条 run 条目只能记一次结果：refusal / bad-output 各起一个新 run 记。
  await store.transitionLearningRun({ projectId: "default", runId: run.id, to: "pausing", reason: "user" });
  await store.transitionLearningRun({ projectId: "default", runId: run.id, to: "paused" });
  await store.transitionLearningRun({ projectId: "default", runId: run.id, to: "canceled" });
  const run2 = await startRun(store, library, { assetIds: [a] });
  await store.recordLearningItemResult({
    projectId: "default", runId: run2.id, assetId: a, status: "failed", fingerprint: await fingerprintInputs(store, a), errorCode: "refusal",
  });
  const pending4 = await store.listLearningPending("default", library.id);
  assert.deepEqual(pending4, [], "refused asset stays out of pending until its fingerprint changes");
  await store.transitionLearningRun({ projectId: "default", runId: run2.id, to: "pausing", reason: "user" });
  await store.transitionLearningRun({ projectId: "default", runId: run2.id, to: "paused" });
  await store.transitionLearningRun({ projectId: "default", runId: run2.id, to: "canceled" });
  const run3 = await startRun(store, library, { assetIds: [a] });
  await store.recordLearningItemResult({
    projectId: "default", runId: run3.id, assetId: a, status: "failed", fingerprint: await fingerprintInputs(store, a), errorCode: "bad-output",
  });
  const pending5 = await store.listLearningPending("default", library.id);
  assert.deepEqual(pending5.map((item) => item.assetId), [a], "bad-output failure re-pends");

  // 进回收站：不计成员、不在待学。
  await store.deleteAsset("default", "pm", { reason: "test" });
  const state2 = await store.getLearningState("default", library.id);
  assert.equal(state2.counts.total, 1, "trashed member leaves total");
  assert.equal(state2.counts.noPreview, 0);
});

test("分析输入: metadata carries only the allowed keys; prompt truncates at 2000; 410 when out of the run/library; 422 when the medium file is gone", async (t) => {
  const { libraryDir, sourcePath, store } = await createStore(t, "mosa-guide-input-");
  const assetId = await seedLearnableImage(store, sourcePath, "ia", "原始提示词");
  await store.updateMetadata("default", assetId, {
    prompt: "长".repeat(2500),
    user_prompt: "用户原话",
    negative_prompt: "不要文字",
  });
  const library = await makeLibrary(store, { libraryName: "输入", assetIds: [assetId] });
  const run = await startRun(store, library, { assetIds: [assetId] });

  const input = await store.getLearningAnalysisInput("default", run.id, assetId);
  assert.equal(input.assetId, assetId);
  assert.ok(/^[0-9a-f]{64}$/.test(input.fingerprint), "fingerprint is a sha256 hex");
  assert.equal(input.image.mediaType, "image/webp");
  assert.ok(input.image.byteLength > 0);
  assert.equal(Buffer.from(input.image.base64, "base64").byteLength, input.image.byteLength);
  // 逐键断言：只有 C.1 列的键，没有文件名、路径、分组、标签、对话 id；
  // isLaterVersion 只有有父图时才出现。
  assert.deepEqual(Object.keys(input.metadata).sort(), [
    "favorite", "negativePrompt", "palette", "prompt", "promptTruncated", "rating", "userPrompt",
  ].sort());
  assert.equal(input.metadata.prompt.length, 2000);
  assert.equal(input.metadata.promptTruncated, true);
  assert.equal(input.metadata.userPrompt, "用户原话");
  assert.equal(input.metadata.negativePrompt, "不要文字");
  assert.equal(input.metadata.favorite, false);
  assert.equal(input.metadata.rating, 0);
  assert.ok(Array.isArray(input.metadata.palette), "palette always present");
  assert.ok(input.metadata.palette.length >= 1 && input.metadata.palette.length <= 6);
  assert.ok(input.metadata.palette.every((hex) => /^#[0-9A-Fa-f]{6}$/.test(hex)), "palette hexes are #RRGGBB");

  // 图已移出学习库 → 410（LEARNING_ITEM_GONE）。
  await store.removeFromLearningLibrary("default", library.id, [assetId]);
  await assert.rejects(
    () => store.getLearningAnalysisInput("default", run.id, assetId),
    (error) => error.code === "LEARNING_ITEM_GONE" && error.statusCode === 410,
  );
  await store.addToLearningLibrary("default", library.id, { assetIds: [assetId] });

  // 中图文件被删 → 422（LEARNING_INPUT_UNREADABLE）。
  const mediumPath = sideRows(libraryDir, "SELECT medium_path FROM assets WHERE id = 'ia'")[0].medium_path;
  await rm(mediumPath);
  await assert.rejects(
    () => store.getLearningAnalysisInput("default", run.id, assetId),
    (error) => error.code === "LEARNING_INPUT_UNREADABLE" && error.statusCode === 422,
  );
});

test("状态机: every legal transition succeeds; out-of-table transitions 409; LEARNING_RUN_OPEN and LEARNING_RUN_BUSY gate concurrent runs", async (t) => {
  const { sourcePath, store } = await createStore(t, "mosa-guide-machine-");
  const a = await seedLearnableImage(store, sourcePath, "sa");
  const library = await makeLibrary(store, { libraryName: "状态机", assetIds: [a] });
  const run = await startRun(store, library, { assetIds: [a] });
  assert.equal(run.status, "running");
  assert.equal(run.phase, "analyze");

  // running → pausing（user）
  let paused = await store.transitionLearningRun({ projectId: "default", runId: run.id, to: "pausing", reason: "user" });
  assert.equal(paused.status, "pausing");
  // pausing → paused（手上的都回来了）
  paused = await store.transitionLearningRun({ projectId: "default", runId: run.id, to: "paused" });
  assert.equal(paused.status, "paused");
  assert.equal(paused.pauseReason, "user");
  assert.equal(paused.finishedAt, null, "paused is not terminal");

  // paused → running（继续：必须带新报价；cap = 已花 + 报价 ×1.5 + $0.05）
  const resumed = await store.transitionLearningRun({
    projectId: "default", runId: run.id, to: "running", estimateUsd: 0.2, capUsd: 0.35,
  });
  assert.equal(resumed.status, "running");
  assert.equal(resumed.estimateUsd, 0.2);
  assert.ok(Math.abs(resumed.capUsd - (0 + 0.2 * 1.5 + 0.05)) < 1e-9, `cap recomputed from spend, got ${resumed.capUsd}`);

  // running → paused（自动暂停带原因）
  const auto = await store.transitionLearningRun({ projectId: "default", runId: run.id, to: "paused", reason: "auth" });
  assert.equal(auto.status, "paused");
  assert.equal(auto.pauseReason, "auth");

  // paused → canceled（放弃；终态带 finished_at）
  const canceled = await store.transitionLearningRun({ projectId: "default", runId: run.id, to: "canceled" });
  assert.equal(canceled.status, "canceled");
  assert.ok(canceled.finishedAt, "canceled is terminal");

  // 表外的变化一律 409。
  for (const [from, to] of [["done", "running"], ["paused", "summarize"], ["canceled", "running"]]) {
    await assert.rejects(
      () => store.transitionLearningRun({ projectId: "default", runId: run.id, to, reason: from }),
      (error) => error.code === "LEARNING_RUN_BAD_TRANSITION" && error.statusCode === 409,
      `${from} → ${to} must be refused`,
    );
  }

  // 同一学习库两次没结束的学习 → LEARNING_RUN_OPEN；另一库在学 → LEARNING_RUN_BUSY。
  const b = await seedLearnableImage(store, sourcePath, "sb");
  const lib2 = await makeLibrary(store, { libraryName: "忙" });
  const run2 = await startRun(store, lib2, { assetIds: [b] });
  await assert.rejects(
    () => startRun(store, lib2, { assetIds: [b] }),
    (error) => error.code === "LEARNING_RUN_OPEN" && error.statusCode === 409 && error.openRunId === run2.id,
  );
  await assert.rejects(
    () => startRun(store, library, { assetIds: [] }),
    (error) => error.code === "LEARNING_RUN_BUSY" && error.statusCode === 409 && error.busyLibraryId === lib2.id,
  );

  // running(analyze) → running(summarize)：条目全不是 pending 才行。
  await store.recordLearningItemResult({ projectId: "default", runId: run2.id, assetId: b, status: "skipped", errorCode: "gone" });
  const summarized = await store.transitionLearningRun({ projectId: "default", runId: run2.id, to: "running" });
  assert.equal(summarized.phase, "summarize");
  assert.equal(summarized.status, "running");
  await assert.rejects(
    () => store.transitionLearningRun({ projectId: "default", runId: run2.id, to: "running" }),
    (error) => error.code === "LEARNING_RUN_BAD_TRANSITION",
    "summarize → summarize must be refused",
  );
  // summarize 阶段不接受 running → failed（那张表只许 analyze 阶段转 failed）。
  await assert.rejects(
    () => store.transitionLearningRun({ projectId: "default", runId: run2.id, to: "failed", reason: "nothing-learned" }),
    (error) => error.code === "LEARNING_RUN_BAD_TRANSITION",
  );

  // nothing-learned 用一个新 run：全结束（b 已 skipped）、零 done、库里没有 ok 分析 → failed。
  await store.transitionLearningRun({ projectId: "default", runId: run2.id, to: "pausing", reason: "user" });
  await store.transitionLearningRun({ projectId: "default", runId: run2.id, to: "paused" });
  await store.transitionLearningRun({ projectId: "default", runId: run2.id, to: "canceled" });
  const run3 = await startRun(store, lib2, { assetIds: [b] });
  await store.recordLearningItemResult({ projectId: "default", runId: run3.id, assetId: b, status: "skipped", errorCode: "no-preview" });
  const failed = await store.transitionLearningRun({ projectId: "default", runId: run3.id, to: "failed", reason: "nothing-learned" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.pauseReason, "nothing-learned");
  assert.ok(failed.finishedAt);
});

test("写入手册: locked entries and tombstones stay byte-identical, unlocked move into guide_before_json, new entries land after locked, non-member sources skipped, revert restores, later edit blocks revert", async (t) => {
  const { libraryDir, sourcePath, store } = await createStore(t, "mosa-guide-write-");
  const a = await seedLearnableImage(store, sourcePath, "ga");
  const gb = await seedLearnableImage(store, sourcePath, "gb"); // 不进学习库：非成员来源
  const library = await makeLibrary(store, { libraryName: "手册", assetIds: [a] });

  // 墓碑先造：写入一条 AI 条目再删掉（AI 条目删了才留墓碑）。
  const seedRun = await startRun(store, library);
  await store.applyGeneratedGuide({
    projectId: "default", runId: seedRun.id,
    entries: [{ section: "lighting", text: "会被删的", swatches: [], sourceAssetIds: [a] }],
    language: "zh", inputTokens: 1, outputTokens: 1, costUsd: 0, droppedNoSource: 0,
  });
  let state = await store.getLearningState("default", library.id);
  const tombstoneSource = state.guide.entries.find((row) => row.text === "会被删的");
  await store.deleteGuideEntry({ projectId: "default", libraryId: library.id, entryId: tombstoneSource.id, baseRevision: state.guide.revision, at: "2026-11-23T08:59:00" });

  // 手工放：2 条锁住（addGuideEntry 自动锁）、3 条没锁的先加再解锁。
  const g0 = await store.getLearningState("default", library.id);
  const locked1 = await store.addGuideEntry({ projectId: "default", libraryId: library.id, baseRevision: g0.guide.revision, section: "palette", text: "锁住的配色", swatches: [{ hex: "#101010", name: "黑" }], at: "2026-11-23T09:00:00" });
  const g1 = await store.getLearningState("default", library.id);
  const locked2 = await store.addGuideEntry({ projectId: "default", libraryId: library.id, baseRevision: g1.guide.revision, section: "mood", text: "锁住的情绪", at: "2026-11-23T09:01:00" });
  const unlocked = [];
  for (const [section, text] of [["composition", "旧构图一"], ["composition", "旧构图二"], ["subject", "旧主体"]]) {
    const currentState = await store.getLearningState("default", library.id);
    const added = await store.addGuideEntry({ projectId: "default", libraryId: library.id, baseRevision: currentState.guide.revision, section, text, at: "2026-11-23T09:04:00" });
    await store.updateGuideEntry({ projectId: "default", libraryId: library.id, entryId: added.entryId, baseRevision: added.revision, locked: false, at: "2026-11-23T09:05:00" });
    unlocked.push(added.entryId);
  }
  const beforeRevision = (await store.getLearningState("default", library.id)).guide.revision;

  // SELECT * 整行快照：锁住的 2 条和墓碑。
  const snapshotEntryRows = () => sideRows(libraryDir, "SELECT * FROM learning_guide_entries WHERE project_id = 'default' AND library_id = ?", library.id);
  const tombstoneRow = snapshotEntryRows().find((row) => row.id === tombstoneSource.id);
assert.ok(tombstoneRow && tombstoneRow.deleted_at, "the deleted AI entry keeps a tombstone row");
const beforeRows = snapshotEntryRows().filter((row) => [locked1.entryId, locked2.entryId, tombstoneSource.id].includes(row.id));
  assert.equal(beforeRows.length, 3);

  // run 到 summarize，写 4 条新的（其中一条的来源含非成员图 gb、一条空来源）。
  const run = await startRun(store, library);
  await store.applyGeneratedGuide({
    projectId: "default",
    runId: run.id,
    entries: [
      { section: "positioning", text: "新的定位", swatches: [], sourceAssetIds: [a] },
      { section: "palette", text: "新的配色", swatches: [{ hex: "#ABCDEF", name: "浅蓝" }], sourceAssetIds: [a] },
      { section: "composition", text: "新的构图", swatches: [], sourceAssetIds: [a, gb] },
      { section: "subject", text: "空来源的主体", swatches: [], sourceAssetIds: [] },
    ],
    language: "zh",
    inputTokens: 500, outputTokens: 200, costUsd: 0.01, droppedNoSource: 1,
  });

  const afterRows = snapshotEntryRows();
  for (const row of beforeRows) {
    const same = afterRows.find((candidate) => candidate.id === row.id);
    assert.deepEqual(same, row, `locked/tombstone row ${row.text} must stay byte-identical`);
  }
  assert.equal(afterRows.filter((row) => unlocked.includes(row.id)).length, 0, "unlocked entries removed");
  const runRow = sideRows(libraryDir, "SELECT guide_before_json, change_json, guide_revision_after, status FROM learning_runs WHERE id = ?", run.id)[0];
  const beforeSnapshot = JSON.parse(runRow.guide_before_json);
  assert.deepEqual(beforeSnapshot.map((entry) => entry.text).sort(), ["旧主体", "旧构图一", "旧构图二"]);
  assert.deepEqual(JSON.parse(runRow.change_json), { added: 3, replaced: 3, keptLocked: 2, droppedNoSource: 2 });
  assert.equal(runRow.status, "done");
  assert.equal(runRow.guide_revision_after, beforeRevision + 1);

  // 新条目排在锁住条目后面；空来源的条目被丢（droppedNoSource 1 + 本地 1）。
  const guideState = await store.getLearningState("default", library.id);
  const paletteEntries = guideState.guide.entries.filter((entry) => entry.section === "palette");
  assert.equal(paletteEntries[0].text, "锁住的配色", "locked entry stays first");
  assert.equal(paletteEntries[1].text, "新的配色", "new entry lands after the locked one");
  const composition = guideState.guide.entries.find((entry) => entry.text === "新的构图");
  assert.deepEqual(composition.sources, [a], "non-member source (gb) skipped");

  // revert：恢复原样（3 条没锁的回来、新的 3 条删掉、revision + 1）。
  await store.revertLearningRun("default", run.id);
  const stateAfterRevert = await store.getLearningState("default", library.id);
  const textsAfterRevert = stateAfterRevert.guide.entries.map((entry) => entry.text).sort();
  assert.deepEqual(textsAfterRevert, ["旧主体", "旧构图一", "旧构图二", "锁住的情绪", "锁住的配色"].sort());
  const revertRunRow = sideRows(libraryDir, "SELECT change_json FROM learning_runs WHERE id = ?", run.id)[0];
  assert.equal(JSON.parse(revertRunRow.change_json).reverted, true);

  // 之后手动改过一条 → 再撤回那次 run → 409（LEARNING_GUIDE_CHANGED）。
  const currentState = await store.getLearningState("default", library.id);
  await store.addGuideEntry({ projectId: "default", libraryId: library.id, baseRevision: currentState.guide.revision, section: "mood", text: "撤回后又改的", at: "2026-11-23T09:10:00" });
  await assert.rejects(
    () => store.revertLearningRun("default", run.id),
    (error) => error.code === "LEARNING_GUIDE_CHANGED" && error.statusCode === 409,
  );
});

test("手动改: add locks, editing AI text re-locks, lock-only edit, AI delete leaves a tombstone visible in context.removed, user delete removes, stale baseRevision 409, 30-minute edit-run merge with injectable now", async (t) => {
  const { libraryDir, sourcePath, store } = await createStore(t, "mosa-guide-edit-");
  const ea = await seedLearnableImage(store, sourcePath, "ea");
  const library = await makeLibrary(store, { libraryName: "手改", assetIds: [ea] });
  const g0 = await store.getLearningState("default", library.id);

  // 加一条 → origin user、locked 1。
  const added = await store.addGuideEntry({ projectId: "default", libraryId: library.id, baseRevision: g0.guide.revision, section: "palette", text: "手加的", swatches: [{ hex: "#0f0f0f", name: "深" }], at: "2026-11-23T10:00:00" });
  assert.ok(added.entryId.startsWith("lge_"));
  assert.equal(added.revision, g0.guide.revision + 1);
  let state = await store.getLearningState("default", library.id);
  let entry = state.guide.entries.find((row) => row.id === added.entryId);
  assert.equal(entry.origin, "user");
  assert.equal(entry.locked, true);

  // 写一次手册（AI 条目），改它的文字 → origin 变 user 且锁住。
  const run = await startRun(store, library);
  await store.applyGeneratedGuide({
    projectId: "default", runId: run.id,
    entries: [
      { section: "composition", text: "AI 的构图", swatches: [], sourceAssetIds: [ea] },
      { section: "material", text: "AI 的材质", swatches: [], sourceAssetIds: [ea] },
    ],
    language: "zh", inputTokens: 1, outputTokens: 1, costUsd: 0, droppedNoSource: 0,
  });
  state = await store.getLearningState("default", library.id);
  const aiEntry = state.guide.entries.find((row) => row.text === "AI 的构图");
  const aiTombstoneTarget = state.guide.entries.find((row) => row.text === "AI 的材质");
  assert.equal(aiEntry.origin, "ai");
  assert.equal(aiEntry.locked, false);
  const edited = await store.updateGuideEntry({ projectId: "default", libraryId: library.id, entryId: aiEntry.id, baseRevision: state.guide.revision, text: "改过的构图", at: "2026-11-23T10:05:00" });
  state = await store.getLearningState("default", library.id);
  entry = state.guide.entries.find((row) => row.id === aiEntry.id);
  assert.equal(entry.text, "改过的构图");
  assert.equal(entry.origin, "user");
  assert.equal(entry.locked, true);

  // 只改 locked：文字不动。
  const lockEdit = await store.updateGuideEntry({ projectId: "default", libraryId: library.id, entryId: entry.id, baseRevision: edited.revision, locked: false, at: "2026-11-23T10:06:00" });
  state = await store.getLearningState("default", library.id);
  entry = state.guide.entries.find((row) => row.id === aiEntry.id);
  assert.equal(entry.text, "改过的构图");
  assert.equal(entry.locked, false);

  // baseRevision 旧了 → 409。
  await assert.rejects(
    () => store.updateGuideEntry({ projectId: "default", libraryId: library.id, entryId: entry.id, baseRevision: 0, locked: true }),
    (error) => error.code === "LEARNING_GUIDE_CONFLICT" && error.statusCode === 409,
  );

  // 删 AI 条目 → 墓碑：state 里看不到、context.removed 里有；删用户条目 → 行没了。
  state = await store.getLearningState("default", library.id);
  await store.deleteGuideEntry({ projectId: "default", libraryId: library.id, entryId: aiTombstoneTarget.id, baseRevision: state.guide.revision, at: "2026-11-23T10:07:30" });
  state = await store.getLearningState("default", library.id);
  assert.equal(state.guide.entries.find((row) => row.id === aiTombstoneTarget.id), undefined);
  const context = await store.getLearningNotesContext("default", library.id);
  assert.deepEqual(context.removed.map((row) => row.text), ["AI 的材质"]);
  const userEntry = await store.addGuideEntry({ projectId: "default", libraryId: library.id, baseRevision: state.guide.revision, section: "lighting", text: "AI 风格手加", at: "2026-11-23T10:07:00" });
  await store.deleteGuideEntry({ projectId: "default", libraryId: library.id, entryId: userEntry.entryId, baseRevision: (await store.getLearningState("default", library.id)).guide.revision, at: "2026-11-23T10:09:00" });
  assert.equal(sideRows(libraryDir, "SELECT COUNT(*) AS n FROM learning_guide_entries WHERE id = ?", userEntry.entryId)[0].n, 0, "user entry deleted for good");

  // 30 分钟内连改三次 → 学习记录里只有一条 edit、数字是 3 次之和；31 分钟后再改 → 新的一条。
  const g1 = await store.getLearningState("default", library.id);
  await store.addGuideEntry({ projectId: "default", libraryId: library.id, baseRevision: g1.guide.revision, section: "mood", text: "合并一", at: "2026-11-23T11:00:00" });
  const g2 = await store.getLearningState("default", library.id);
  await store.addGuideEntry({ projectId: "default", libraryId: library.id, baseRevision: g2.guide.revision, section: "mood", text: "合并二", at: "2026-11-23T11:10:00" });
  const g3 = await store.getLearningState("default", library.id);
  await store.addGuideEntry({ projectId: "default", libraryId: library.id, baseRevision: g3.guide.revision, section: "mood", text: "合并三", at: "2026-11-23T11:20:00" });
  const state3 = await store.getLearningState("default", library.id);
  const merged = state3.runs.filter((row) => row.kind === "edit" && row.startedAt.startsWith("2026-11-23T11"));
  assert.equal(merged.length, 1, "three edits within 30 minutes merge into one record");
  assert.equal(merged[0].change.added, 3);
  const g4 = await store.getLearningState("default", library.id);
  await store.addGuideEntry({ projectId: "default", libraryId: library.id, baseRevision: g4.guide.revision, section: "mood", text: "三十一分钟后", at: "2026-11-23T11:51:00" });
  const state4 = await store.getLearningState("default", library.id);
  const lateRuns = state4.runs.filter((row) => row.kind === "edit" && row.startedAt.startsWith("2026-11-23T11"));
  assert.equal(lateRuns.length, 2, "31 minutes later a new record");
  assert.equal(lateRuns[0].change.added, 1);
});

test("图库过滤: learningLibrary+learningEntry narrows to the entry's sources, learningRun to the run's images, learningEntry alone is a no-op", async (t) => {
  const { sourcePath, store } = await createStore(t, "mosa-guide-filter-");
  const a = await seedLearnableImage(store, sourcePath, "fa");
  const b = await seedLearnableImage(store, sourcePath, "fb");
  const library = await makeLibrary(store, { libraryName: "过滤", assetIds: [a, b] });
  const run = await startRun(store, library, { assetIds: [a, b] });
  await store.recordLearningItemResult({
    projectId: "default", runId: run.id, assetId: a, status: "done", fingerprint: "fp", note: VALID_NOTE,
  });
  await store.recordLearningItemResult({
    projectId: "default", runId: run.id, assetId: b, status: "done", fingerprint: "fp2", note: VALID_NOTE,
  });
  await store.transitionLearningRun({ projectId: "default", runId: run.id, to: "running" });
  await store.applyGeneratedGuide({
    projectId: "default", runId: run.id,
    entries: [{ section: "palette", text: "只有 a 的配色", swatches: [], sourceAssetIds: [a] }],
    language: "zh", inputTokens: 1, outputTokens: 1, costUsd: 0, droppedNoSource: 0,
  });
  const state = await store.getLearningState("default", library.id);
  const entry = state.guide.entries.find((row) => row.text === "只有 a 的配色");

  const withEntry = await store.listAssetPage({
    projectId: "default", query: "", sort: "newest", limit: 50, learningLibrary: library.id, learningEntry: entry.id,
  });
  assert.deepEqual(withEntry.assets.map((asset) => asset.id), [a]);

  const withRun = await store.listAssetPage({
    projectId: "default", query: "", sort: "newest", limit: 50, learningLibrary: library.id, learningRun: run.id,
  });
  assert.deepEqual(withRun.assets.map((asset) => asset.id).sort(), [a, b].sort());

  const entryOnly = await store.listAssetPage({
    projectId: "default", query: "", sort: "newest", limit: 50, learningEntry: entry.id,
  });
  const plain = await store.listAssetPage({ projectId: "default", query: "", sort: "newest", limit: 50 });
  assert.deepEqual(entryOnly.assets.map((asset) => asset.id), plain.assets.map((asset) => asset.id), "learningEntry without learningLibrary is a no-op");
});
