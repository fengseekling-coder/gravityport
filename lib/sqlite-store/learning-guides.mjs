// Learning guides (task 463): the per-library style guide, its entries and
// sources, the AI write path (applyGeneratedGuide / revert) and the manual
// edit path (add / update / delete with revision checks + edit-run journal).
// Locked entries and deleted tombstones are never touched by a re-learn; a
// tombstone tells the next summary "do not add this back".
import { learningError, newLearningId, requireLearningLibraryRow } from "./learning-runs.mjs";
import { LEARNING_GUIDE_SECTIONS } from "../ai/learning-schema.mjs";
import { now as defaultNow, sanitizeProjectId } from "./util.mjs";

const GUIDE_STATUS = Object.freeze({
  LEARNING_GUIDE_CONFLICT: 409,
  LEARNING_GUIDE_CHANGED: 409,
  LEARNING_GUIDE_ENTRY_EMPTY: 400,
  LEARNING_GUIDE_ENTRY_NOT_FOUND: 404,
});

function guideError(code, message) {
  const error = learningError(code, message);
  error.statusCode = GUIDE_STATUS[code] || error.statusCode || 500;
  return error;
}

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
const EDIT_RUN_MERGE_WINDOW_MS = 30 * 60 * 1000;

function safeParse(text, fallback) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function entryRowToObject(row, sources) {
  return {
    id: row.id,
    section: row.section,
    position: Number(row.position || 0),
    text: row.text,
    swatches: safeParse(row.swatches_json, []),
    origin: row.origin,
    locked: Boolean(row.locked),
    deletedAt: row.deleted_at || null,
    runId: row.run_id || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sources: sources || [],
  };
}

function requireGuideRow(database, projectId, libraryId) {
  return database.prepare(
    "SELECT project_id, library_id, revision, language, updated_at FROM learning_guides WHERE project_id = ? AND library_id = ?",
  ).get(projectId, libraryId) || null;
}

function assertBaseRevision(guideRow, baseRevision) {
  const current = guideRow ? Number(guideRow.revision || 0) : 0;
  if (Number(baseRevision) !== current) {
    throw guideError("LEARNING_GUIDE_CONFLICT", `Guide revision moved: expected ${baseRevision}, current ${current}.`);
  }
  return current;
}

function bumpGuideRevision(database, projectId, libraryId, language, timestamp) {
  database.prepare(`
    INSERT INTO learning_guides (project_id, library_id, revision, language, updated_at)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(project_id, library_id) DO UPDATE SET
      revision = revision + 1, language = excluded.language, updated_at = excluded.updated_at
  `).run(projectId, libraryId, language, timestamp);
  return Number(database.prepare(
    "SELECT revision FROM learning_guides WHERE project_id = ? AND library_id = ?",
  ).get(projectId, libraryId).revision || 0);
}

function normalizeEntryText(section, text) {
  const clean = String(text || "").trim();
  if (!clean) throw guideError("LEARNING_GUIDE_ENTRY_EMPTY", "Guide entry text is required.");
  const cap = section === "positioning" ? 80 : 240;
  const chars = Array.from(clean);
  return chars.length > cap ? chars.slice(0, cap).join("") : clean;
}

function normalizeSwatches(section, swatches) {
  if (section !== "palette" || swatches === undefined) return [];
  if (!Array.isArray(swatches)) throw guideError("LEARNING_GUIDE_ENTRY_EMPTY", "swatches must be an array.");
  const cleaned = [];
  for (const swatch of swatches.slice(0, 6)) {
    const hex = String(swatch?.hex || "").trim();
    const name = String(swatch?.name || "").trim();
    if (!HEX_RE.test(hex)) throw guideError("LEARNING_GUIDE_ENTRY_EMPTY", `Invalid swatch hex: ${hex}`);
    cleaned.push({ hex: hex.toUpperCase(), name });
  }
  return cleaned;
}

function assertSection(section) {
  if (!LEARNING_GUIDE_SECTIONS.includes(section)) {
    throw guideError("LEARNING_GUIDE_ENTRY_EMPTY", `Unknown guide section: ${String(section)}`);
  }
}

function nextSectionPosition(database, projectId, libraryId, section) {
  const row = database.prepare(
    "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM learning_guide_entries WHERE project_id = ? AND library_id = ? AND section = ?",
  ).get(projectId, libraryId, section);
  return Number(row.next || 0);
}

function replaceEntrySources(database, projectId, libraryId, entryId, sourceAssetIds) {
  database.prepare(
    "DELETE FROM learning_guide_entry_sources WHERE project_id = ? AND library_id = ? AND entry_id = ?",
  ).run(projectId, libraryId, entryId);
  const insert = database.prepare(`
    INSERT INTO learning_guide_entry_sources (project_id, library_id, entry_id, asset_id, position)
    VALUES (?, ?, ?, ?, ?)
  `);
  sourceAssetIds.forEach((assetId, index) => insert.run(projectId, libraryId, entryId, assetId, index));
}

function memberAssetFilter(database, projectId, libraryId, assetIds) {
  if (!assetIds.length) return [];
  const kept = [];
  const check = database.prepare(`
    SELECT 1 FROM learning_library_members m
    JOIN assets a ON a.project_id = m.project_id AND a.id = m.asset_id AND a.deleted_at IS NULL
    WHERE m.project_id = ? AND m.library_id = ? AND m.asset_id = ?
  `);
  for (const assetId of assetIds) {
    if (check.get(projectId, libraryId, assetId)) kept.push(assetId);
  }
  return kept;
}

/**
 * 手动改手册都走这条：写一条 kind 'edit'、status 'done' 的 run；这个学习库
 * 最新一条记录就是 30 分钟内的 edit 时合并进那一条（数字相加、updated_at
 * 更新），免得改一个字就是一行。at 可注入（测试拨时钟）。
 */
function recordGuideEditRun(database, projectId, libraryId, change, at) {
  const timestamp = typeof at === "string" && at ? at : defaultNow();
  // 只有「这个学习库最新建的一条记录」（按插入先后）就是 edit 才合并；中间
  // 隔了一次学习就另起一条，免得手动改动被并进学习之前的那条记录里。
  const latest = database.prepare(`
    SELECT project_id, id, kind, status, change_json, updated_at FROM learning_runs
    WHERE project_id = ? AND library_id = ?
    ORDER BY rowid DESC LIMIT 1
  `).get(projectId, libraryId);
  if (latest && latest.kind === "edit" && latest.status === "done") {
    const lastUpdate = Date.parse(latest.updated_at);
    if (Number.isFinite(lastUpdate) && Math.abs(Date.parse(timestamp) - lastUpdate) <= EDIT_RUN_MERGE_WINDOW_MS) {
      const merged = safeParse(latest.change_json, {});
      for (const key of ["added", "edited", "locked", "unlocked", "deleted"]) {
        merged[key] = Number(merged[key] || 0) + Number(change[key] || 0);
      }
      database.prepare("UPDATE learning_runs SET change_json = ?, updated_at = ? WHERE project_id = ? AND id = ?")
        .run(JSON.stringify(merged), timestamp, projectId, latest.id);
      return latest.id;
    }
  }
  const runId = newLearningId("lr");
  database.prepare(`
    INSERT INTO learning_runs (project_id, id, library_id, kind, status, phase, pause_reason, service_id, analysis_model, summary_model, language,
      item_count, done_count, failed_count, skipped_count, estimate_usd, cap_usd, cost_usd,
      guide_revision_before, guide_revision_after, guide_before_json, change_json, started_at, updated_at, finished_at)
    VALUES (?, ?, ?, 'edit', 'done', '', '', '', '', '', '',
      0, 0, 0, 0, NULL, NULL, 0,
      (SELECT COALESCE(MAX(revision), 0) FROM learning_guides WHERE project_id = ? AND library_id = ?),
      (SELECT COALESCE(MAX(revision), 0) FROM learning_guides WHERE project_id = ? AND library_id = ?),
      NULL, ?, ?, ?, ?)
  `).run(projectId, runId, libraryId, projectId, libraryId, projectId, libraryId, JSON.stringify(change), timestamp, timestamp, timestamp);
  return runId;
}

/**
 * 汇总出的手册写入（run 的终站）。一个事务里：此刻锁住的条目和墓碑一行不
 * 碰；没锁没删的连同来源先存进 run 的 guide_before_json 再删；插入新条目
 * （origin 'ai'、不锁、run_id），每个 section 排在已有行后面；来源只写现在
 * 还是成员的图；revision + 1；run 改 done。
 */
export function applyGeneratedGuide({
  database, projectId, runId, entries = [], language = "", inputTokens = 0, outputTokens = 0,
  costUsd = 0, droppedNoSource = 0,
}) {
  const cleanProjectId = sanitizeProjectId(projectId);
  const timestamp = defaultNow();
  const cost = Number(costUsd) || 0;
  let added = 0;
  let replaced = 0;
  let keptLocked = 0;
  let localDroppedNoSource = 0;
  const runIdOut = database.transaction(() => {
    const run = database.prepare(
      "SELECT id, library_id, kind, status, phase FROM learning_runs WHERE project_id = ? AND id = ?",
    ).get(cleanProjectId, runId);
    if (!run) throw learningError("LEARNING_RUN_NOT_FOUND", `Learning run not found: ${runId}`);
    // pausing 也收：用户在汇总请求途中点了暂停，汇总那一次请求不打断
    // （D.4），落地时 run 正处于 pausing —— done 优先于暂停。
    if (run.kind !== "learn" || (run.status !== "running" && run.status !== "pausing") || run.phase !== "summarize") {
      throw learningError("LEARNING_RUN_BAD_STATE", `Learning run ${runId} is not in the summarize phase.`);
    }
    const libraryId = run.library_id;
    const currentEntries = database.prepare(`
      SELECT id, section, position, text, swatches_json, origin, locked, deleted_at, run_id, created_at, updated_at
      FROM learning_guide_entries WHERE project_id = ? AND library_id = ?
      ORDER BY section, position
    `).all(cleanProjectId, libraryId);
    const sourceRows = database.prepare(
      "SELECT entry_id, asset_id, position FROM learning_guide_entry_sources WHERE project_id = ? AND library_id = ? ORDER BY entry_id, position",
    ).all(cleanProjectId, libraryId);
    const sourcesByEntry = new Map();
    for (const row of sourceRows) {
      if (!sourcesByEntry.has(row.entry_id)) sourcesByEntry.set(row.entry_id, []);
      sourcesByEntry.get(row.entry_id).push(row.asset_id);
    }
    const lockedEntries = currentEntries.filter((row) => row.locked === 1 && !row.deleted_at);
    keptLocked = lockedEntries.length;
    const removable = currentEntries.filter((row) => row.locked !== 1 && !row.deleted_at);
    replaced = removable.length;
    const beforeSnapshot = removable.map((row) => entryRowToObject(row, sourcesByEntry.get(row.id) || []));
    const insertEntry = database.prepare(`
      INSERT INTO learning_guide_entries (project_id, library_id, id, section, position, text, swatches_json, origin, locked, deleted_at, run_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ai', 0, NULL, ?, ?, ?)
    `);
    for (const row of removable) {
      database.prepare("DELETE FROM learning_guide_entries WHERE project_id = ? AND library_id = ? AND id = ?")
        .run(cleanProjectId, libraryId, row.id);
    }
    for (const entry of entries) {
      const section = String(entry?.section || "");
      const text = String(entry?.text || "").trim();
      if (!LEARNING_GUIDE_SECTIONS.includes(section) || !text) continue;
      const sourceAssetIds = memberAssetFilter(database, cleanProjectId, libraryId, Array.isArray(entry?.sourceAssetIds) ? entry.sourceAssetIds.map((id) => String(id)) : []);
      if (!sourceAssetIds.length) { localDroppedNoSource += 1; continue; }
      const entryId = newLearningId("lge");
      insertEntry.run(
        cleanProjectId, libraryId, entryId, section,
        nextSectionPosition(database, cleanProjectId, libraryId, section),
        text, JSON.stringify(Array.isArray(entry?.swatches) ? entry.swatches : []),
        runId, timestamp, timestamp,
      );
      replaceEntrySources(database, cleanProjectId, libraryId, entryId, sourceAssetIds);
      added += 1;
    }
    const revision = bumpGuideRevision(database, cleanProjectId, libraryId, String(language || ""), timestamp);
    const change = { added, replaced, keptLocked, droppedNoSource: Number(droppedNoSource || 0) + localDroppedNoSource };
    database.prepare(`
      UPDATE learning_runs SET status = 'done', phase = 'summarize',
        guide_revision_after = ?, guide_before_json = ?, change_json = ?,
        cost_usd = cost_usd + ?, updated_at = ?, finished_at = ?
      WHERE project_id = ? AND id = ?
    `).run(
      revision,
      JSON.stringify(beforeSnapshot),
      JSON.stringify(change),
      cost, timestamp, timestamp, cleanProjectId, runId,
    );
    return runId;
  })();
  return { runId: runIdOut, added, replaced, keptLocked, droppedNoSource: Number(droppedNoSource || 0) + localDroppedNoSource };
}

/**
 * 撤回一次学习对手册的改动：只认这个学习库最近一次 done 的 learn，且手册
 * revision 还等于它的 guide_revision_after（之后改过 → LEARNING_GUIDE_CHANGED）。
 * 这次插入的条目删掉、guide_before_json 里的恢复回来（来源里已不是成员的图
 * 跳过）、revision + 1；花费不变，change_json 加 reverted: true。
 */
export function revertLearningRun({ database, projectId, runId, at }) {
  const cleanProjectId = sanitizeProjectId(projectId);
  const timestamp = typeof at === "string" && at ? at : defaultNow();
  database.transaction(() => {
    const run = database.prepare(
      "SELECT id, library_id, kind, status, guide_revision_after, guide_before_json, change_json FROM learning_runs WHERE project_id = ? AND id = ?",
    ).get(cleanProjectId, runId);
    if (!run) throw learningError("LEARNING_RUN_NOT_FOUND", `Learning run not found: ${runId}`);
    if (run.kind !== "learn" || run.status !== "done") {
      throw guideError("LEARNING_GUIDE_CHANGED", `Run ${runId} is not a finished learn run.`);
    }
    const latestDone = database.prepare(`
      SELECT id FROM learning_runs WHERE project_id = ? AND library_id = ? AND kind = 'learn' AND status = 'done'
      ORDER BY started_at DESC, rowid DESC LIMIT 1
    `).get(cleanProjectId, run.library_id);
    if (!latestDone || latestDone.id !== runId) {
      throw guideError("LEARNING_GUIDE_CHANGED", `Run ${runId} is not the latest finished learn run.`);
    }
    const guideRow = requireGuideRow(database, cleanProjectId, run.library_id);
    if (!guideRow || Number(guideRow.revision || 0) !== Number(run.guide_revision_after)) {
      throw guideError("LEARNING_GUIDE_CHANGED", "The guide changed after this run; nothing to revert.");
    }
    const beforeEntries = Array.isArray(safeParse(run.guide_before_json, [])) ? safeParse(run.guide_before_json, []) : [];
    // 这次 run 插入的条目（含被用户删成墓碑的）整批删掉。
    database.prepare(
      "DELETE FROM learning_guide_entries WHERE project_id = ? AND library_id = ? AND run_id = ? AND origin = 'ai'",
    ).run(cleanProjectId, run.library_id, runId);
    const insertEntry = database.prepare(`
      INSERT INTO learning_guide_entries (project_id, library_id, id, section, position, text, swatches_json, origin, locked, deleted_at, run_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const entry of beforeEntries) {
      insertEntry.run(
        cleanProjectId, run.library_id, entry.id, entry.section, Number(entry.position || 0),
        entry.text, JSON.stringify(Array.isArray(entry.swatches) ? entry.swatches : []),
        entry.origin, entry.locked ? 1 : 0, entry.deletedAt || null, entry.runId || "",
        entry.createdAt || timestamp, entry.updatedAt || timestamp,
      );
      const sources = memberAssetFilter(database, cleanProjectId, run.library_id, Array.isArray(entry.sources) ? entry.sources : []);
      replaceEntrySources(database, cleanProjectId, run.library_id, entry.id, sources);
    }
    bumpGuideRevision(database, cleanProjectId, run.library_id, guideRow.language, timestamp);
    const change = safeParse(run.change_json, {});
    change.reverted = true;
    database.prepare("UPDATE learning_runs SET change_json = ?, updated_at = ? WHERE project_id = ? AND id = ?")
      .run(JSON.stringify(change), timestamp, cleanProjectId, runId);
  })();
  return { ok: true };
}

/**
 * 手动加一条：origin 'user'、自动锁住、排在 section 末尾；baseRevision 不对
 * → 409。还没有手册时先建一本（baseRevision 传 0）。
 */
export function addGuideEntry({ database, projectId, libraryId, baseRevision, section, text, swatches, at }) {
  const cleanProjectId = sanitizeProjectId(projectId);
  const timestamp = typeof at === "string" && at ? at : defaultNow();
  assertSection(section);
  const cleanText = normalizeEntryText(section, text);
  const cleanSwatches = normalizeSwatches(section, swatches);
  return database.transaction(() => {
    requireLearningLibraryRow(database, cleanProjectId, libraryId);
    const guideRow = requireGuideRow(database, cleanProjectId, libraryId);
    assertBaseRevision(guideRow, baseRevision);
    const entryId = newLearningId("lge");
    database.prepare(`
      INSERT INTO learning_guide_entries (project_id, library_id, id, section, position, text, swatches_json, origin, locked, deleted_at, run_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'user', 1, NULL, '', ?, ?)
    `).run(
      cleanProjectId, libraryId, entryId, section,
      nextSectionPosition(database, cleanProjectId, libraryId, section),
      cleanText, JSON.stringify(cleanSwatches), timestamp, timestamp,
    );
    const revision = bumpGuideRevision(database, cleanProjectId, libraryId, guideRow?.language || "", timestamp);
    recordGuideEditRun(database, cleanProjectId, libraryId, { added: 1 }, timestamp);
    return { entryId, revision };
  })();
}

/**
 * 手动改一条：改了 text 或 swatches → origin 改 'user' 且自动锁住；只改
 * locked 就只改锁。墓碑上的行不可改（404）。
 */
export function updateGuideEntry({ database, projectId, libraryId, entryId, baseRevision, text, swatches, locked, at }) {
  const cleanProjectId = sanitizeProjectId(projectId);
  const timestamp = typeof at === "string" && at ? at : defaultNow();
  return database.transaction(() => {
    requireLearningLibraryRow(database, cleanProjectId, libraryId);
    const guideRow = requireGuideRow(database, cleanProjectId, libraryId);
    assertBaseRevision(guideRow, baseRevision);
    const row = database.prepare(`
      SELECT id, section, text, swatches_json, origin, locked, deleted_at FROM learning_guide_entries
      WHERE project_id = ? AND library_id = ? AND id = ?
    `).get(cleanProjectId, libraryId, entryId);
    if (!row || row.deleted_at) {
      throw guideError("LEARNING_GUIDE_ENTRY_NOT_FOUND", `Guide entry not found: ${entryId}`);
    }
    const changes = { edited: 0, locked: 0, unlocked: 0 };
    const editsText = text !== undefined || swatches !== undefined;
    if (editsText) {
      const cleanText = text !== undefined ? normalizeEntryText(row.section, text) : row.text;
      const cleanSwatches = swatches !== undefined ? normalizeSwatches(row.section, swatches) : safeParse(row.swatches_json, []);
      database.prepare(`
        UPDATE learning_guide_entries SET text = ?, swatches_json = ?, origin = 'user', locked = 1, updated_at = ?
        WHERE project_id = ? AND library_id = ? AND id = ?
      `).run(cleanText, JSON.stringify(cleanSwatches), timestamp, cleanProjectId, libraryId, entryId);
      changes.edited = 1;
    }
    if (locked !== undefined) {
      if (typeof locked !== "boolean") throw guideError("LEARNING_GUIDE_ENTRY_EMPTY", "locked must be a boolean.");
      database.prepare(`
        UPDATE learning_guide_entries SET locked = ?, updated_at = ? WHERE project_id = ? AND library_id = ? AND id = ?
      `).run(locked ? 1 : 0, timestamp, cleanProjectId, libraryId, entryId);
      if (locked) changes.locked = 1;
      else changes.unlocked = 1;
    }
    if (!editsText && locked === undefined) {
      throw guideError("LEARNING_GUIDE_ENTRY_EMPTY", "Nothing to update: pass text, swatches or locked.");
    }
    const revision = bumpGuideRevision(database, cleanProjectId, libraryId, guideRow?.language || "", timestamp);
    recordGuideEditRun(database, cleanProjectId, libraryId, changes, timestamp);
    return { entryId, revision };
  })();
}

/**
 * 手动删一条：AI 条目打墓碑（下次汇总告诉模型「别再加回来」），用户条目
 * 直接删（来源靠外键级联）。
 */
export function deleteGuideEntry({ database, projectId, libraryId, entryId, baseRevision, at }) {
  const cleanProjectId = sanitizeProjectId(projectId);
  const timestamp = typeof at === "string" && at ? at : defaultNow();
  return database.transaction(() => {
    requireLearningLibraryRow(database, cleanProjectId, libraryId);
    const guideRow = requireGuideRow(database, cleanProjectId, libraryId);
    assertBaseRevision(guideRow, baseRevision);
    const row = database.prepare(
      "SELECT id, origin, deleted_at FROM learning_guide_entries WHERE project_id = ? AND library_id = ? AND id = ?",
    ).get(cleanProjectId, libraryId, entryId);
    if (!row || row.deleted_at) {
      throw guideError("LEARNING_GUIDE_ENTRY_NOT_FOUND", `Guide entry not found: ${entryId}`);
    }
    if (row.origin === "ai") {
      database.prepare(`
        UPDATE learning_guide_entries SET deleted_at = ?, updated_at = ? WHERE project_id = ? AND library_id = ? AND id = ?
      `).run(timestamp, timestamp, cleanProjectId, libraryId, entryId);
    } else {
      database.prepare(
        "DELETE FROM learning_guide_entries WHERE project_id = ? AND library_id = ? AND id = ?",
      ).run(cleanProjectId, libraryId, entryId);
    }
    const revision = bumpGuideRevision(database, cleanProjectId, libraryId, guideRow?.language || "", timestamp);
    recordGuideEditRun(database, cleanProjectId, libraryId, { deleted: 1 }, timestamp);
    return { entryId, revision };
  })();
}

/**
 * 给汇总的上下文：锁住的条目（不许复述/矛盾/重复）和用户删掉的墓碑
 * （不许加回来）。排序在 JS 里按九个 section 的固定顺序。
 */
export function getLearningNotesContext({ database, projectId, libraryId }) {
  const cleanProjectId = sanitizeProjectId(projectId);
  requireLearningLibraryRow(database, cleanProjectId, libraryId);
  const sectionOrder = new Map(LEARNING_GUIDE_SECTIONS.map((section, index) => [section, index]));
  const sortEntries = (rows) => rows
    .map((row) => ({ section: row.section, text: row.text }))
    .sort((a, b) => (sectionOrder.get(a.section) - sectionOrder.get(b.section)));
  const locked = sortEntries(database.prepare(`
    SELECT section, text FROM learning_guide_entries
    WHERE project_id = ? AND library_id = ? AND locked = 1 AND deleted_at IS NULL
    ORDER BY position
  `).all(cleanProjectId, libraryId));
  const removed = sortEntries(database.prepare(`
    SELECT section, text FROM learning_guide_entries
    WHERE project_id = ? AND library_id = ? AND deleted_at IS NOT NULL
    ORDER BY position
  `).all(cleanProjectId, libraryId));
  return { locked, removed };
}
