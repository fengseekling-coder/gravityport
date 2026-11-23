// Learning analyses (task 463): per-asset analysis results shared by every
// learning library, plus the read side the runner and the service client go
// through (state, pending list, analysis input, notes). Like
// learning-libraries.mjs this only reads its own tables + assets and never
// journals through commitLibraryChanges.
import { readFile, stat } from "node:fs/promises";
import { learningAnalysisFingerprint, LEARNING_GUIDE_SECTIONS } from "../ai/learning-schema.mjs";
import { learningError, requireLearningLibraryRow, getLearningRun } from "./learning-runs.mjs";
import { sanitizeProjectId } from "./util.mjs";

const LEARNING_INPUT_MAX_BYTES = 4 * 1024 * 1024;

const SECTION_ORDER = new Map(LEARNING_GUIDE_SECTIONS.map((section, index) => [section, index]));

function rowAssetFingerprint(row) {
  const metadata = safeParseMetadata(row.metadata_json);
  return learningAnalysisFingerprint({
    contentSha256: row.content_sha256,
    prompt: row.prompt,
    userPrompt: metadata.user_prompt,
    negativePrompt: metadata.negative_prompt,
  });
}

function safeParseMetadata(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function safeParse(text, fallback) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseBusinessFields(text) {
  return safeParse(text, {});
}

function sourcePlatformOf(source, businessFields, sourceGroup) {
  const provider = String(source?.provider || businessFields?.provider || "").trim();
  if (provider) return provider;
  const group = String(sourceGroup || "").trim();
  // web-chatgpt → chatgpt；local-file 等本机来源不算平台。
  return group.startsWith("web-") ? group.slice(4) : "";
}

function generatorModelOf(source, businessFields) {
  // 与 recipe 快照的 material 同源：source.model || business_fields.model。
  return String(source?.model || businessFields?.model || "").trim();
}

function businessDimensions(businessFields) {
  const width = Number(businessFields?.width);
  const height = Number(businessFields?.height);
  return {
    width: Number.isFinite(width) && width > 0 ? width : null,
    height: Number.isFinite(height) && height > 0 ? height : null,
  };
}

function paletteHexes(paletteJson) {
  if (!paletteJson) return [];
  const parsed = safeParse(paletteJson, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((entry) => String(entry?.hex || "")).filter(Boolean).slice(0, 6);
}

/**
 * 学习库成员的整体状态：计数、手册、进行中的 run、最近 30 条记录。
 * total 只算没进回收站的图片成员；noPreview 是「该学但没有中图」的张数
 * （这次跳过、不计入 pending）；analyzed 是指纹还和当前一致的 ok 分析。
 */
export function getLearningState({ database, projectId, libraryId }) {
  const cleanProjectId = sanitizeProjectId(projectId);
  requireLearningLibraryRow(database, cleanProjectId, libraryId);
  const members = database.prepare(`
    SELECT m.asset_id, m.added_at, a.content_sha256, a.prompt, a.metadata_json,
      a.business_fields_json, a.source_json, a.source_group, a.medium_path
    FROM learning_library_members m
    JOIN assets a ON a.project_id = m.project_id AND a.id = m.asset_id
    WHERE m.project_id = ? AND m.library_id = ? AND a.deleted_at IS NULL AND a.media_kind = 'image'
    ORDER BY m.added_at ASC, m.asset_id ASC
  `).all(cleanProjectId, libraryId);
  const analysisByAsset = new Map();
  for (const row of database.prepare(
    "SELECT asset_id, fingerprint, status, error_code FROM learning_asset_analyses WHERE project_id = ?",
  ).all(cleanProjectId)) {
    analysisByAsset.set(row.asset_id, row);
  }
  let analyzed = 0;
  let pending = 0;
  let noPreview = 0;
  for (const member of members) {
    const analysis = analysisByAsset.get(member.asset_id);
    const currentFingerprint = rowAssetFingerprint(member);
    const needsLearning = !analysis
      || analysis.fingerprint !== currentFingerprint
      || (analysis.status === "failed" && analysis.error_code === "bad-output");
    if (!needsLearning) {
      analyzed += 1;
      continue;
    }
    if (member.medium_path) pending += 1;
    else noPreview += 1;
  }
  const guideRow = database.prepare(
    "SELECT revision, language, updated_at FROM learning_guides WHERE project_id = ? AND library_id = ?",
  ).get(cleanProjectId, libraryId);
  const entries = listGuideEntriesWithSources(database, cleanProjectId, libraryId);
  const openRow = database.prepare(`
    SELECT project_id, id FROM learning_runs
    WHERE project_id = ? AND library_id = ? AND status IN ('running', 'pausing', 'paused')
  `).get(cleanProjectId, libraryId);
  const runs = database.prepare(`
    SELECT project_id, id FROM learning_runs WHERE project_id = ? AND library_id = ?
    ORDER BY started_at DESC, rowid DESC LIMIT 30
  `).all(cleanProjectId, libraryId).map((row) => {
    // 记录列表只带计数、不带逐张条目：大库一次学习就是几千行，30 条记录全展开
    // 会让这个常被轮询的接口变成几兆。要逐张看用 GET /api/learning-runs/:id。
    const { items: _items, ...run } = getLearningRun({ database, projectId: cleanProjectId, runId: row.id });
    return run;
  });
  return {
    counts: { total: members.length, analyzed, pending, noPreview },
    guide: {
      revision: guideRow ? Number(guideRow.revision || 0) : 0,
      language: guideRow?.language || "",
      updatedAt: guideRow?.updated_at || null,
      entries,
    },
    openRun: openRow ? getLearningRun({ database, projectId: cleanProjectId, runId: openRow.id }) : null,
    runs,
  };
}

/** 手册条目（不含墓碑），每条带还在库里的来源图 id（按 position）。 */
function listGuideEntriesWithSources(database, projectId, libraryId) {
  const entryRows = database.prepare(`
    SELECT id, section, position, text, swatches_json, origin, locked, run_id, created_at, updated_at
    FROM learning_guide_entries
    WHERE project_id = ? AND library_id = ? AND deleted_at IS NULL
  `).all(projectId, libraryId);
  const sourceRows = database.prepare(`
    SELECT s.entry_id, s.asset_id, s.position
    FROM learning_guide_entry_sources s
    JOIN learning_library_members m ON m.project_id = s.project_id AND m.asset_id = s.asset_id
    JOIN assets a ON a.project_id = s.project_id AND a.id = s.asset_id AND a.deleted_at IS NULL
    WHERE s.project_id = ? AND s.library_id = ?
    ORDER BY s.entry_id, s.position
  `).all(projectId, libraryId);
  const sourcesByEntry = new Map();
  for (const row of sourceRows) {
    if (!sourcesByEntry.has(row.entry_id)) sourcesByEntry.set(row.entry_id, []);
    sourcesByEntry.get(row.entry_id).push(row.asset_id);
  }
  return entryRows
    .map((row) => ({
      id: row.id,
      section: row.section,
      position: Number(row.position || 0),
      text: row.text,
      swatches: safeParse(row.swatches_json, []),
      origin: row.origin,
      locked: Boolean(row.locked),
      runId: row.run_id || "",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sources: sourcesByEntry.get(row.id) || [],
      sourceCount: (sourcesByEntry.get(row.id) || []).length,
    }))
    .sort((a, b) => (SECTION_ORDER.get(a.section) - SECTION_ORDER.get(b.section)) || (a.position - b.position));
}

/**
 * 待学列表，按加入学习库的先后：成员（图片、不在回收站、有中图）里
 * 「没有分析 / 指纹和现在算出来的不一样 / 上次 failed 且 bad-output」的。
 * refusal / unreadable / rejected 失败且指纹没变的不在（免得再花钱再被拒）。
 */
export function listLearningPending({ database, projectId, libraryId }) {
  const cleanProjectId = sanitizeProjectId(projectId);
  requireLearningLibraryRow(database, cleanProjectId, libraryId);
  const members = database.prepare(`
    SELECT m.asset_id, m.added_at, a.content_sha256, a.prompt, a.metadata_json, a.business_fields_json
    FROM learning_library_members m
    JOIN assets a ON a.project_id = m.project_id AND a.id = m.asset_id
    WHERE m.project_id = ? AND m.library_id = ? AND a.deleted_at IS NULL AND a.media_kind = 'image'
      AND a.medium_path IS NOT NULL
    ORDER BY m.added_at ASC, m.asset_id ASC
  `).all(cleanProjectId, libraryId);
  const analysisByAsset = new Map();
  for (const row of database.prepare(
    "SELECT asset_id, fingerprint, status, error_code FROM learning_asset_analyses WHERE project_id = ?",
  ).all(cleanProjectId)) {
    analysisByAsset.set(row.asset_id, row);
  }
  const pending = [];
  for (const member of members) {
    const analysis = analysisByAsset.get(member.asset_id);
    const needsLearning = !analysis
      || analysis.fingerprint !== rowAssetFingerprint(member)
      || (analysis.status === "failed" && analysis.error_code === "bad-output");
    if (!needsLearning) continue;
    const dims = businessDimensions(parseBusinessFields(member.business_fields_json));
    pending.push({ assetId: member.asset_id, width: dims.width, height: dims.height });
  }
  return pending;
}

/**
 * 一次分析的输入：图必须还是这次学习的条目、还在学习库里、没进回收站，
 * 否则 LEARNING_ITEM_GONE（410）；中图超过 4 MB 或读不出 →
 * LEARNING_INPUT_UNREADABLE（422）。metadata 只放提示词、平台、评分这些，
 * 不放文件名、路径、分组名、标签、对话 id。
 */
export async function getLearningAnalysisInput({ database, projectId, runId, assetId }) {
  const cleanProjectId = sanitizeProjectId(projectId);
  const item = database.prepare(
    "SELECT 1 FROM learning_run_items WHERE project_id = ? AND run_id = ? AND asset_id = ?",
  ).get(cleanProjectId, runId, assetId);
  const row = database.prepare(`
    SELECT m.asset_id, a.id, a.content_sha256, a.prompt, a.metadata_json, a.business_fields_json,
      a.source_json, a.source_group, a.favorite, a.rating, a.parent_asset_id, a.medium_path, a.palette_json
    FROM learning_library_members m
    JOIN assets a ON a.project_id = m.project_id AND a.id = m.asset_id
    WHERE m.project_id = ? AND m.library_id = (
      SELECT library_id FROM learning_runs WHERE project_id = ? AND id = ?
    ) AND m.asset_id = ? AND a.deleted_at IS NULL AND a.media_kind = 'image'
  `).get(cleanProjectId, cleanProjectId, runId, assetId);
  if (!item || !row) {
    throw learningError("LEARNING_ITEM_GONE", `Learning item ${assetId} is gone.`);
  }
  const fingerprint = rowAssetFingerprint(row);
  let bytes;
  try {
    const info = await stat(row.medium_path);
    if (!info.isFile() || info.size > LEARNING_INPUT_MAX_BYTES) throw new Error("size");
    bytes = await readFile(row.medium_path);
  } catch {
    throw learningError("LEARNING_INPUT_UNREADABLE", `Medium image for ${assetId} is unreadable.`);
  }
  const metadata = safeParseMetadata(row.metadata_json);
  const source = safeParse(row.source_json, {});
  const businessFields = parseBusinessFields(row.business_fields_json);
  const payloadMetadata = {};
  const prompt = String(row.prompt || "");
  if (prompt.length > 2000) {
    payloadMetadata.prompt = Array.from(prompt).slice(0, 2000).join("");
    payloadMetadata.promptTruncated = true;
  } else {
    payloadMetadata.prompt = prompt;
  }
  const userPrompt = String(metadata.user_prompt || "");
  if (userPrompt) payloadMetadata.userPrompt = Array.from(userPrompt).slice(0, 1000).join("");
  const negativePrompt = String(metadata.negative_prompt || "");
  if (negativePrompt) payloadMetadata.negativePrompt = Array.from(negativePrompt).slice(0, 1000).join("");
  const sourcePlatform = sourcePlatformOf(source, businessFields, row.source_group);
  if (sourcePlatform) payloadMetadata.sourcePlatform = sourcePlatform;
  const generatorModel = generatorModelOf(source, businessFields);
  if (generatorModel) payloadMetadata.generatorModel = generatorModel;
  payloadMetadata.favorite = Boolean(row.favorite);
  payloadMetadata.rating = Number(row.rating || 0);
  if (row.parent_asset_id) payloadMetadata.isLaterVersion = true;
  payloadMetadata.palette = paletteHexes(row.palette_json);
  return {
    assetId,
    fingerprint,
    image: {
      mediaType: "image/webp",
      base64: bytes.toString("base64"),
      byteLength: bytes.byteLength,
    },
    metadata: payloadMetadata,
  };
}

/** 现在的成员里 status='ok' 的分析，按加入先后（汇总的输入）。 */
export function listLearningNotes({ database, projectId, libraryId }) {
  const cleanProjectId = sanitizeProjectId(projectId);
  requireLearningLibraryRow(database, cleanProjectId, libraryId);
  const rows = database.prepare(`
    SELECT m.asset_id, a.favorite, a.rating, a.source_group, a.source_json, a.business_fields_json,
      x.note_json
    FROM learning_library_members m
    JOIN assets a ON a.project_id = m.project_id AND a.id = m.asset_id
    JOIN learning_asset_analyses x ON x.project_id = m.project_id AND x.asset_id = m.asset_id
    WHERE m.project_id = ? AND m.library_id = ? AND a.deleted_at IS NULL AND x.status = 'ok'
    ORDER BY m.added_at ASC, m.asset_id ASC
  `).all(cleanProjectId, libraryId);
  return rows.map((row) => ({
    assetId: row.asset_id,
    favorite: Boolean(row.favorite),
    rating: Number(row.rating || 0),
    sourcePlatform: sourcePlatformOf(safeParse(row.source_json, {}), parseBusinessFields(row.business_fields_json), row.source_group),
    note: safeParse(row.note_json, {}),
  }));
}
