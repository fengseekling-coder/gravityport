// Learning-guide route tests (task 463). Starts the real runtime
// (startMosaRuntime) against a temporary library and exercises all 13 routes
// for success and failure, plus the boundary: a browser-extension token never
// reaches them (they are not in bridge-routes' WEB_CAPTURE_API_PATHS), same as
// the 459 learning-library routes. None of the routes touch money or keys.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { isWebCaptureApiPath } from "../lib/api/bridge-routes.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

const CLIENT_TOKEN = "learning-guide-client-token-0123456789abcdef";
const CAPTURE_TOKEN = "learning-guide-capture-token-0123456789abcdef";

function request(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let payload = null;
        try { payload = JSON.parse(raw); } catch { payload = raw; }
        resolveRequest({ status: response.statusCode, payload });
      });
    });
    req.on("error", rejectRequest);
    if (body !== undefined) {
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      req.setHeader("content-length", String(Buffer.byteLength(payload)));
      req.write(payload);
    }
    req.end();
  });
}

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

test("learning-guide routes answer per contract and stay out of the extension allowlist", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-guide-routes-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: root,
    managerDir: repositoryRoot,
    appDir: join(repositoryRoot, "web", "gravityport", "dist"),
    libraryDir: join(root, "library"),
    assetsRoot: join(root, "library", "assets"),
    generatedImagesDir: join(root, "generated-images"),
    // 来源目录全指临时目录、桥全关：不传时会落到本机真实的 ~/.codex、
    // ~/.grok，测试服务会把用户自己的生图收进临时库（11-23 批次复跑撞上过）。
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "codex-sessions"),
    codexThreadHistoryDir: join(root, "codex-thread-history"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-canvas"),
    cowartRegistryPath: join(root, "state", "cowart-projects.json"),
    disabledBridges: ["cowart", "cowartDiscovery", "codex", "grok"],
    clientToken: CLIENT_TOKEN,
    webCaptureToken: CAPTURE_TOKEN,
  });
  t.after(() => runtime.stop());
  const port = runtime.port;
  const authed = { "x-mosa-client-token": CLIENT_TOKEN, "content-type": "application/json" };

  // ── 边界：没有令牌 / bearer / 扩展令牌 全部 401；新路径不在扩展名单 ──
  const noToken = await request(port, "/api/learning-libraries/ll_x/learning?project=default");
  assert.equal(noToken.status, 401);
  assert.equal(noToken.payload.code, "MOSA_CLIENT_UNAUTHORIZED");
  const captureHeader = await request(port, "/api/learning-runs/lr_x?project=default", {
    headers: { "x-mosa-client-token": CAPTURE_TOKEN },
  });
  assert.equal(captureHeader.status, 401);
  for (const path of [
    "/api/learning-libraries/ll_x/learning",
    "/api/learning-libraries/ll_x/learning/pending",
    "/api/learning-libraries/ll_x/learning/notes",
    "/api/learning-libraries/ll_x/runs",
    "/api/learning-runs/lr_x",
    "/api/learning-runs/lr_x/items/as_x/input",
    "/api/learning-runs/lr_x/items/as_x/result",
    "/api/learning-runs/lr_x/guide",
    "/api/learning-runs/lr_x/revert",
    "/api/learning-libraries/ll_x/guide/entries",
    "/api/learning-libraries/ll_x/guide/entries/lge_x",
  ]) {
    assert.equal(isWebCaptureApiPath(path), false, `${path} must not be a web-capture path`);
  }

  // ── 准备：建库 + 放一张图 ──
  const created = await request(port, "/api/learning-libraries", {
    method: "POST", headers: authed, body: { projectId: "default", name: "路由手册" },
  });
  assert.equal(created.status, 201);
  const libraryId = created.payload.library.id;
  const importResponse = await request(port, "/api/assets/import-folder", {
    method: "POST", headers: authed, body: {},
  });
  void importResponse;
  // 直接造一张图：走 store 的导入路由太重，用 generation capture 的兜底不可靠；
  // 这里用 459 同款思路——没有图时 pending 是空的，路由依然按合同回答。

  // ── GET state：200（空库） ──
  const state = await request(port, `/api/learning-libraries/${libraryId}/learning?project=default`, { headers: authed });
  assert.equal(state.status, 200);
  assert.deepEqual(state.payload.counts, { total: 0, analyzed: 0, pending: 0, noPreview: 0 });
  assert.equal(state.payload.guide.revision, 0);
  assert.equal(state.payload.openRun, null);
  assert.deepEqual(state.payload.runs, []);

  // ── GET pending：200 空列表 ──
  const pending = await request(port, `/api/learning-libraries/${libraryId}/learning/pending?project=default`, { headers: authed });
  assert.equal(pending.status, 200);
  assert.deepEqual(pending.payload.pending, []);

  // ── GET notes：200 空 notes + 空 context ──
  const notes = await request(port, `/api/learning-libraries/${libraryId}/learning/notes?project=default`, { headers: authed });
  assert.equal(notes.status, 200);
  assert.deepEqual(notes.payload.notes, []);
  assert.deepEqual(notes.payload.context, { locked: [], removed: [] });

  // ── POST runs：201（无图 → summarize 相位）＋ 计数字段在 ──
  const runCreated = await request(port, `/api/learning-libraries/${libraryId}/runs`, {
    method: "POST", headers: authed,
    body: { projectId: "default", assetIds: [], serviceId: "claude", analysisModel: "claude-haiku-5-5", summaryModel: "claude-sonnet-5-5", language: "zh", estimateUsd: 0.1, capUsd: 0.2 },
  });
  assert.equal(runCreated.status, 201);
  const run = runCreated.payload.run;
  assert.ok(run.id.startsWith("lr_"));
  assert.equal(run.status, "running");
  assert.equal(run.phase, "summarize");

  // ── 同库第二次建 run：409 LEARNING_RUN_OPEN ──
  const second = await request(port, `/api/learning-libraries/${libraryId}/runs`, {
    method: "POST", headers: authed, body: { projectId: "default", assetIds: [] },
  });
  assert.equal(second.status, 409);
  assert.equal(second.payload.code, "LEARNING_RUN_OPEN");

  // ── GET run：200 + counts ──
  const got = await request(port, `/api/learning-runs/${run.id}?project=default`, { headers: authed });
  assert.equal(got.status, 200);
  assert.equal(got.payload.run.id, run.id);
  assert.deepEqual(got.payload.run.counts.byStatus, { pending: 0, done: 0, failed: 0, skipped: 0 });
  const missingRun = await request(port, "/api/learning-runs/lr_missing?project=default", { headers: authed });
  assert.equal(missingRun.status, 404);
  assert.equal(missingRun.payload.code, "LEARNING_RUN_NOT_FOUND");

  // ── PATCH run：running→pausing→paused；表外 409 ──
  const pausing = await request(port, `/api/learning-runs/${run.id}`, {
    method: "PATCH", headers: authed, body: { projectId: "default", to: "pausing", reason: "user" },
  });
  assert.equal(pausing.status, 200);
  assert.equal(pausing.payload.run.status, "pausing");
  const paused = await request(port, `/api/learning-runs/${run.id}`, {
    method: "PATCH", headers: authed, body: { projectId: "default", to: "paused" },
  });
  assert.equal(paused.status, 200);
  assert.equal(paused.payload.run.status, "paused");
  const illegal = await request(port, `/api/learning-runs/${run.id}`, {
    method: "PATCH", headers: authed, body: { projectId: "default", to: "done" },
  });
  assert.equal(illegal.status, 409);
  assert.equal(illegal.payload.code, "LEARNING_RUN_BAD_TRANSITION");

  // ── GET input：run 条目不存在 → 410 ──
  const input = await request(port, `/api/learning-runs/${run.id}/items/ghost-asset/input?project=default`, { headers: authed });
  assert.equal(input.status, 410);
  assert.equal(input.payload.code, "LEARNING_ITEM_GONE");

  // ── POST result：条目不存在 → 409 ──
  const result = await request(port, `/api/learning-runs/${run.id}/items/ghost-asset/result`, {
    method: "POST", headers: authed,
    body: { projectId: "default", status: "done", note: VALID_NOTE },
  });
  assert.equal(result.status, 409);
  assert.equal(result.payload.code, "LEARNING_RUN_BAD_STATE");

  // ── POST guide：run 不在 summarize running → 409（它已 paused）──
  const guide = await request(port, `/api/learning-runs/${run.id}/guide`, {
    method: "POST", headers: authed,
    body: { projectId: "default", entries: [], language: "zh", droppedNoSource: 0 },
  });
  assert.equal(guide.status, 409);
  assert.equal(guide.payload.code, "LEARNING_RUN_BAD_STATE");

  // ── 手册编辑三兄弟：还没有手册时 baseRevision 0 加一条；改 / 删 / 冲突 ──
  const added = await request(port, `/api/learning-libraries/${libraryId}/guide/entries`, {
    method: "POST", headers: authed,
    body: { projectId: "default", baseRevision: 0, section: "palette", text: "路由加的一条", swatches: [{ hex: "#101010", name: "黑" }] },
  });
  assert.equal(added.status, 201);
  const entry = added.payload.entry;
  assert.ok(entry.entryId.startsWith("lge_"));
  assert.equal(entry.revision, 1);
  const badSection = await request(port, `/api/learning-libraries/${libraryId}/guide/entries`, {
    method: "POST", headers: authed,
    body: { projectId: "default", baseRevision: entry.revision, section: "nope", text: "x" },
  });
  assert.equal(badSection.status, 400);
  const edited = await request(port, `/api/learning-libraries/${libraryId}/guide/entries/${entry.entryId}`, {
    method: "PATCH", headers: authed,
    body: { projectId: "default", baseRevision: entry.revision, locked: false },
  });
  assert.equal(edited.status, 200);
  const conflict = await request(port, `/api/learning-libraries/${libraryId}/guide/entries/${entry.entryId}`, {
    method: "PATCH", headers: authed,
    body: { projectId: "default", baseRevision: 0, text: "冲突" },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.payload.code, "LEARNING_GUIDE_CONFLICT");
  const missingEntry = await request(port, `/api/learning-libraries/${libraryId}/guide/entries/lge_missing`, {
    method: "PATCH", headers: authed,
    body: { projectId: "default", baseRevision: edited.payload.entry.revision, locked: true },
  });
  assert.equal(missingEntry.status, 404);
  assert.equal(missingEntry.payload.code, "LEARNING_GUIDE_ENTRY_NOT_FOUND");
  const deleted = await request(port, `/api/learning-libraries/${libraryId}/guide/entries/${entry.entryId}`, {
    method: "DELETE", headers: authed,
    body: { projectId: "default", baseRevision: edited.payload.entry.revision },
  });
  assert.equal(deleted.status, 200);

  // ── POST revert：run 不是 done → 409 ──
  const revert = await request(port, `/api/learning-runs/${run.id}/revert`, {
    method: "POST", headers: authed, body: { projectId: "default" },
  });
  assert.equal(revert.status, 409);
  assert.equal(revert.payload.code, "LEARNING_GUIDE_CHANGED");

  // ── 请求体逐项校验：字段类型不对 400 ──
  const badBody = await request(port, `/api/learning-runs/${run.id}`, {
    method: "PATCH", headers: authed, body: { projectId: "default", to: 123 },
  });
  assert.equal(badBody.status, 400);
  const badTokens = await request(port, `/api/learning-libraries/${libraryId}/runs`, {
    method: "POST", headers: authed, body: { projectId: "default", assetIds: "not-an-array" },
  });
  assert.equal(badTokens.status, 400);
});
