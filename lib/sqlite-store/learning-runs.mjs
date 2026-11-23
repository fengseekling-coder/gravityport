// Learning runs (task 463): the learn/edit run journal and its state machine.
// Implementation module for the store delegations in sqlite-asset-store.mjs —
// like learning-libraries.mjs it only touches its own tables, never assets,
// and never journals through commitLibraryChanges (analysis results and runs
// do not change gallery cards, so an incremental gallery sync per write would
// only force full gallery refreshes).
import { randomBytes } from "node:crypto";
import { assetStoreError } from "../asset-version-history.mjs";
import { normalizeAnalysisNote } from "../ai/learning-schema.mjs";
import { now as defaultNow, sanitizeProjectId } from "./util.mjs";

// HTTP semantics shared with learning-libraries.mjs's own table (that file is
// frozen for this task, so these codes live here).
const LEARNING_STATUS = Object.freeze({
  LEARNING_LIBRARY_NOT_FOUND: 404,
  LEARNING_RUN_NOT_FOUND: 404,
  LEARNING_RUN_BUSY: 409,
  LEARNING_RUN_OPEN: 409,
  LEARNING_RUN_BAD_STATE: 409,
  LEARNING_RUN_BAD_TRANSITION: 409,
  LEARNING_GUIDE_CHANGED: 409,
  LEARNING_ITEM_GONE: 410,
  LEARNING_INPUT_UNREADABLE: 422,
});

export function learningError(code, message) {
  const error = assetStoreError(code, message);
  error.statusCode = LEARNING_STATUS[code] || 500;
  return error;
}

export function newLearningId(prefix) {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

export function requireLearningLibraryRow(database, projectId, libraryId) {
  const row = database.prepare("SELECT id, name FROM learning_libraries WHERE project_id = ? AND id = ?").get(projectId, libraryId);
  if (!row) throw learningError("LEARNING_LIBRARY_NOT_FOUND", `Learning library not found: ${libraryId}`);
  return row;
}

const RUN_COLUMNS = `project_id, id, library_id, kind, status, phase, pause_reason, service_id, analysis_model, summary_model, language,
  item_count, done_count, failed_count, skipped_count, estimate_usd, cap_usd, cost_usd,
  guide_revision_before, guide_revision_after, guide_before_json, change_json, started_at, updated_at, finished_at`;

function safeParse(text, fallback) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function runRowToObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    libraryId: row.library_id,
    kind: row.kind,
    status: row.status,
    phase: row.phase,
    pauseReason: row.pause_reason || "",
    serviceId: row.service_id || "",
    analysisModel: row.analysis_model || "",
    summaryModel: row.summary_model || "",
    language: row.language || "",
    itemCount: Number(row.item_count || 0),
    doneCount: Number(row.done_count || 0),
    failedCount: Number(row.failed_count || 0),
    skippedCount: Number(row.skipped_count || 0),
    estimateUsd: row.estimate_usd == null ? null : Number(row.estimate_usd),
    capUsd: row.cap_usd == null ? null : Number(row.cap_usd),
    costUsd: Number(row.cost_usd || 0),
    guideRevisionBefore: row.guide_revision_before == null ? null : Number(row.guide_revision_before),
    guideRevisionAfter: row.guide_revision_after == null ? null : Number(row.guide_revision_after),
    change: safeParse(row.change_json, {}),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at || null,
  };
}

export function runItemCounts(database, projectId, runId) {
  const byStatus = { pending: 0, done: 0, failed: 0, skipped: 0 };
  for (const row of database.prepare(
    "SELECT status, COUNT(*) AS n FROM learning_run_items WHERE project_id = ? AND run_id = ? GROUP BY status",
  ).all(projectId, runId)) {
    byStatus[row.status] = Number(row.n || 0);
  }
  const byErrorCode = {};
  for (const row of database.prepare(
    "SELECT error_code, COUNT(*) AS n FROM learning_run_items WHERE project_id = ? AND run_id = ? AND error_code != '' GROUP BY error_code",
  ).all(projectId, runId)) {
    byErrorCode[row.error_code] = Number(row.n || 0);
  }
  return { byStatus, byErrorCode };
}

function requireRunRow(database, projectId, runId) {
  const row = database.prepare(`SELECT ${RUN_COLUMNS} FROM learning_runs WHERE project_id = ? AND id = ?`).get(projectId, runId);
  if (!row) throw learningError("LEARNING_RUN_NOT_FOUND", `Learning run not found: ${runId}`);
  return row;
}

const OPEN_STATUSES = "('running', 'pausing', 'paused')";

/**
 * 一个事务里建 run + pending 条目。同一项目里别的学习库正在学 →
 * LEARNING_RUN_BUSY（错误对象带 busyLibraryId / busyLibraryName / openRunId）；
 * 这个学习库自己还有没结束的（含暂停着的）→ LEARNING_RUN_OPEN（带 openRunId）。
 */
export function createLearningRun({
  database, projectId, libraryId, assetIds = [], serviceId = "", analysisModel = "", summaryModel = "",
  language = "", estimateUsd = null, capUsd = null,
}) {
  const cleanProjectId = sanitizeProjectId(projectId);
  const orderedAssetIds = [...new Set((Array.isArray(assetIds) ? assetIds : []).map((id) => String(id || "").trim()).filter(Boolean))];
  const timestamp = defaultNow();
  const runId = newLearningId("lr");
  database.transaction(() => {
    requireLearningLibraryRow(database, cleanProjectId, libraryId);
    for (const row of database.prepare(
      `SELECT id, library_id FROM learning_runs WHERE project_id = ? AND status IN ${OPEN_STATUSES}`,
    ).all(cleanProjectId)) {
      if (row.library_id !== libraryId) {
        const busy = database.prepare("SELECT name FROM learning_libraries WHERE project_id = ? AND id = ?").get(cleanProjectId, row.library_id);
        const error = learningError("LEARNING_RUN_BUSY", `Another learning run is active in library ${row.library_id}.`);
        error.busyLibraryId = row.library_id;
        error.busyLibraryName = busy?.name || "";
        error.openRunId = row.id;
        throw error;
      }
      const error = learningError("LEARNING_RUN_OPEN", `Learning library ${libraryId} already has an open run.`);
      error.openRunId = row.id;
      throw error;
    }
    database.prepare(`
      INSERT INTO learning_runs (project_id, id, library_id, kind, status, phase, pause_reason, service_id, analysis_model, summary_model, language,
        item_count, done_count, failed_count, skipped_count, estimate_usd, cap_usd, cost_usd,
        guide_revision_before, guide_revision_after, guide_before_json, change_json, started_at, updated_at, finished_at)
      VALUES (?, ?, ?, 'learn', 'running', ?, '', ?, ?, ?, ?,
        ?, 0, 0, 0, ?, ?, 0,
        (SELECT COALESCE(MAX(revision), 0) FROM learning_guides WHERE project_id = ? AND library_id = ?),
        NULL, NULL, '{}', ?, ?, NULL)
    `).run(
      cleanProjectId, runId, libraryId,
      orderedAssetIds.length ? "analyze" : "summarize",
      serviceId, analysisModel, summaryModel, language,
      orderedAssetIds.length, estimateUsd, capUsd,
      cleanProjectId, libraryId,
      timestamp, timestamp,
    );
    const insertItem = database.prepare(`
      INSERT INTO learning_run_items (project_id, run_id, asset_id, position, status, error_code, cost_usd, updated_at)
      VALUES (?, ?, ?, ?, 'pending', '', 0, ?)
    `);
    orderedAssetIds.forEach((assetId, index) => insertItem.run(cleanProjectId, runId, assetId, index, timestamp));
  })();
  return getLearningRun({ database, projectId: cleanProjectId, runId });
}

// 这些失败码会写一条 status='failed' 的分析（带指纹），别的失败码只记在条目上。
const FAILED_ANALYSIS_CODES = new Set(["refusal", "unreadable", "rejected", "bad-output"]);

/**
 * 一张图的结果，一个事务里：写/覆盖分析 + 改条目 + 改 run 计数和花费。
 * done 的笔记先过 normalizeAnalysisNote，不合格按 failed / bad-output 记；
 * failed 且错误码 ∈ {refusal, unreadable, rejected, bad-output} 写 failed 分析；
 * skipped（gone / no-preview）不写分析。run 不在 running/pausing 或条目不是
 * pending → LEARNING_RUN_BAD_STATE。
 */
export function recordLearningItemResult({
  database, projectId, runId, assetId, status, fingerprint = "", errorCode = "", note = null,
  serviceId = "", model = "", inputTokens = 0, outputTokens = 0, costUsd = 0,
}) {
  const cleanProjectId = sanitizeProjectId(projectId);
  const timestamp = defaultNow();
  const cost = Number(costUsd) || 0;
  let itemStatus;
  let itemErrorCode = String(errorCode || "");
  let analysisRow = null;
  if (status === "done") {
    const normalized = normalizeAnalysisNote(note);
    if (normalized) {
      itemStatus = "done";
      itemErrorCode = "";
      analysisRow = {
        status: "ok", errorCode: "", noteJson: JSON.stringify(normalized),
        fingerprint, serviceId, model, inputTokens, outputTokens,
      };
    } else {
      itemStatus = "failed";
      itemErrorCode = "bad-output";
      analysisRow = {
        status: "failed", errorCode: "bad-output", noteJson: "{}",
        fingerprint, serviceId, model, inputTokens, outputTokens,
      };
    }
  } else if (status === "failed") {
    itemStatus = "failed";
    if (FAILED_ANALYSIS_CODES.has(itemErrorCode)) {
      analysisRow = {
        status: "failed", errorCode: itemErrorCode, noteJson: "{}",
        fingerprint, serviceId, model, inputTokens, outputTokens,
      };
    }
  } else if (status === "skipped") {
    itemStatus = "skipped";
  } else {
    throw learningError("LEARNING_RUN_BAD_STATE", `Unknown item result status: ${String(status)}`);
  }
  database.transaction(() => {
    const run = requireRunRow(database, cleanProjectId, runId);
    if (run.status !== "running" && run.status !== "pausing") {
      throw learningError("LEARNING_RUN_BAD_STATE", `Learning run ${runId} is not running.`);
    }
    const item = database.prepare(
      "SELECT status FROM learning_run_items WHERE project_id = ? AND run_id = ? AND asset_id = ?",
    ).get(cleanProjectId, runId, assetId);
    if (!item || item.status !== "pending") {
      throw learningError("LEARNING_RUN_BAD_STATE", `Run item ${assetId} is not pending.`);
    }
    if (analysisRow) {
      database.prepare(`
        INSERT INTO learning_asset_analyses (project_id, asset_id, fingerprint, status, error_code, service_id, model, note_json, input_tokens, output_tokens, cost_usd, analyzed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, asset_id) DO UPDATE SET
          fingerprint = excluded.fingerprint, status = excluded.status, error_code = excluded.error_code,
          service_id = excluded.service_id, model = excluded.model, note_json = excluded.note_json,
          input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
          cost_usd = excluded.cost_usd, analyzed_at = excluded.analyzed_at
      `).run(
        cleanProjectId, assetId, analysisRow.fingerprint, analysisRow.status, analysisRow.errorCode,
        analysisRow.serviceId, analysisRow.model, analysisRow.noteJson,
        analysisRow.inputTokens, analysisRow.outputTokens, cost, timestamp,
      );
    }
    database.prepare(`
      UPDATE learning_run_items SET status = ?, error_code = ?, cost_usd = ?, updated_at = ?
      WHERE project_id = ? AND run_id = ? AND asset_id = ?
    `).run(itemStatus, itemErrorCode, cost, timestamp, cleanProjectId, runId, assetId);
    const counts = runItemCounts(database, cleanProjectId, runId);
    database.prepare(`
      UPDATE learning_runs SET done_count = ?, failed_count = ?, skipped_count = ?,
        cost_usd = cost_usd + ?, updated_at = ?
      WHERE project_id = ? AND id = ?
    `).run(counts.byStatus.done, counts.byStatus.failed, counts.byStatus.skipped, cost, timestamp, cleanProjectId, runId);
  })();
  return getLearningRun({ database, projectId: cleanProjectId, runId });
}

const TRANSITIONS = new Map([
  // [from, to] → allowed (phase-specific ones are checked separately)
  ["running>pausing", "user-pause"],
  ["pausing>paused", "finish-pause"],
  ["running>paused", "auto-pause"],
  ["paused>running", "resume"],
  ["paused>canceled", "cancel"],
  ["running>failed", "nothing-learned"],
  ["running>running", "phase-change"],
]);

/**
 * run 状态机的唯一入口；表外的变化一律 LEARNING_RUN_BAD_TRANSITION。done 只能
 * 由 applyGeneratedGuide 进入。终态写 finished_at；每次变化写 updated_at。
 */
export function transitionLearningRun({
  database, projectId, runId, to, reason = "", estimateUsd = null, capUsd = null,
}) {
  const cleanProjectId = sanitizeProjectId(projectId);
  const timestamp = defaultNow();
  const row = requireRunRow(database, cleanProjectId, runId);
  const key = `${row.status}>${to}`;
  const action = TRANSITIONS.get(key);
  const pauseReason = String(reason || "");
  if (!action) {
    throw learningError("LEARNING_RUN_BAD_TRANSITION", `Learning run cannot go from ${row.status} to ${to}.`);
  }
  if (action === "user-pause" && pauseReason !== "user") {
    throw learningError("LEARNING_RUN_BAD_TRANSITION", "running→pausing requires reason 'user'.");
  }
  if (action === "auto-pause" && !pauseReason) {
    throw learningError("LEARNING_RUN_BAD_TRANSITION", "running→paused requires a pause reason.");
  }
  if (action === "nothing-learned") {
    if (row.phase !== "analyze" || pauseReason !== "nothing-learned") {
      throw learningError("LEARNING_RUN_BAD_TRANSITION", "running→failed requires phase 'analyze' and reason 'nothing-learned'.");
    }
    const pending = database.prepare(
      "SELECT COUNT(*) AS n FROM learning_run_items WHERE project_id = ? AND run_id = ? AND status = 'pending'",
    ).get(cleanProjectId, runId).n;
    const okAnalyses = database.prepare(`
      SELECT COUNT(*) AS n FROM learning_asset_analyses x
      JOIN learning_library_members m ON m.project_id = x.project_id AND m.asset_id = x.asset_id
      WHERE m.project_id = ? AND m.library_id = ? AND x.status = 'ok'
    `).get(cleanProjectId, row.library_id).n;
    if (pending > 0 || Number(row.done_count || 0) > 0 || okAnalyses > 0) {
      throw learningError("LEARNING_RUN_BAD_TRANSITION", "nothing-learned requires a finished run with zero done items and no ok analyses.");
    }
  }
  database.transaction(() => {
    if (action === "resume") {
      if (!Number.isFinite(Number(estimateUsd)) || !Number.isFinite(Number(capUsd))) {
        throw learningError("LEARNING_RUN_BAD_TRANSITION", "paused→running requires new estimateUsd and capUsd.");
      }
      const estimate = Number(estimateUsd);
      // cap_usd = 已花 + 新报价 × 1.5 + $0.05（C.2 的继续公式）。
      const nextCap = Number(row.cost_usd || 0) + estimate * 1.5 + 0.05;
      database.prepare(`
        UPDATE learning_runs SET status = 'running', pause_reason = '', estimate_usd = ?, cap_usd = ?, updated_at = ?
        WHERE project_id = ? AND id = ?
      `).run(estimate, nextCap, timestamp, cleanProjectId, runId);
      return;
    }
    if (to === "running") {
      // running(analyze) → running(summarize)：条目全都不是 pending 才行；
      // 已在 summarize 的 run 不接受 running>running。
      if (row.phase !== "analyze") {
        throw learningError("LEARNING_RUN_BAD_TRANSITION", "running→running is only the analyze→summarize phase change.");
      }
      const pending = database.prepare(
        "SELECT COUNT(*) AS n FROM learning_run_items WHERE project_id = ? AND run_id = ? AND status = 'pending'",
      ).get(cleanProjectId, runId).n;
      if (pending > 0) {
        throw learningError("LEARNING_RUN_BAD_TRANSITION", "analyze→summarize requires zero pending items.");
      }
      database.prepare("UPDATE learning_runs SET phase = 'summarize', updated_at = ? WHERE project_id = ? AND id = ?")
        .run(timestamp, cleanProjectId, runId);
      return;
    }
    const terminal = to === "failed" || to === "canceled" || to === "done";
    const pauseReasonValue = to === "paused" || to === "pausing"
      ? (action === "finish-pause" ? row.pause_reason : pauseReason)
      : (action === "nothing-learned" ? "nothing-learned" : row.pause_reason);
    database.prepare(`
      UPDATE learning_runs SET status = ?, pause_reason = ?, updated_at = ?, finished_at = CASE WHEN ? THEN ? ELSE finished_at END
      WHERE project_id = ? AND id = ?
    `).run(to, pauseReasonValue || "", timestamp, terminal ? 1 : 0, timestamp, cleanProjectId, runId);
  })();
  return getLearningRun({ database, projectId: cleanProjectId, runId });
}

export function listLearningRuns({ database, projectId, status = "" }) {
  const cleanProjectId = sanitizeProjectId(projectId);
  const rows = status
    ? database.prepare(`SELECT ${RUN_COLUMNS} FROM learning_runs WHERE project_id = ? AND status = ? ORDER BY started_at DESC, rowid DESC`).all(cleanProjectId, status)
    : database.prepare(`SELECT ${RUN_COLUMNS} FROM learning_runs WHERE project_id = ? ORDER BY started_at DESC, rowid DESC`).all(cleanProjectId);
  return rows.map(runRowToObject);
}

/** run + 条目按状态和错误码的计数 + 条目列表（463 续跑要精确的 pending id）。 */
export function getLearningRun({ database, projectId, runId }) {
  const cleanProjectId = sanitizeProjectId(projectId);
  const row = requireRunRow(database, cleanProjectId, runId);
  const items = database.prepare(`
    SELECT asset_id, position, status, error_code FROM learning_run_items
    WHERE project_id = ? AND run_id = ? ORDER BY position
  `).all(cleanProjectId, runId).map((item) => ({
    assetId: item.asset_id,
    position: Number(item.position || 0),
    status: item.status,
    errorCode: item.error_code || "",
  }));
  return { ...runRowToObject(row), counts: runItemCounts(database, cleanProjectId, runId), items };
}
