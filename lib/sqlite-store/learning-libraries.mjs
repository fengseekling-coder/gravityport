// Learning libraries (task 459): named collections an asset can join without
// leaving its group or stack. Members live in their own tables; every write
// here touches only learning_libraries / learning_library_members — never
// assets, groups or asset_stack_members — and journals through the store's
// commitLibraryChanges so the sidebar and open views refresh like they do for
// groups. View and route addressing is by library id, never by name, so a
// rename does not break anything watching it.
import { randomBytes } from "node:crypto";
import { assetStoreError } from "../asset-version-history.mjs";
import { normalizeGroupName, now, sanitizeProjectId } from "./util.mjs";

// The shared ERROR_STATUS table in asset-version-history.mjs predates learning
// libraries; these codes carry the same HTTP semantics as their group
// counterparts (GROUP_NAME_REQUIRED 400 / GROUP_ALREADY_EXISTS 409 /
// GROUP_NOT_FOUND 404) without touching that frozen table.
const LEARNING_LIBRARY_STATUS = Object.freeze({
  LEARNING_LIBRARY_NAME_EMPTY: 400,
  LEARNING_LIBRARY_NAME_TAKEN: 409,
  LEARNING_LIBRARY_NOT_FOUND: 404,
});

function learningLibraryError(code, message) {
  const error = assetStoreError(code, message);
  error.statusCode = LEARNING_LIBRARY_STATUS[code] || 500;
  return error;
}

function newLibraryId() {
  return `ll_${randomBytes(6).toString("hex")}`;
}

// Names follow the group rules (normalizeGroupName): trimmed, whitespace
// collapsed, at most 80 characters.
function normalizeLibraryName(name) {
  return normalizeGroupName(name);
}

function requireLibraryRow(database, projectId, id) {
  const row = database.prepare("SELECT id, name, created_at FROM learning_libraries WHERE project_id = ? AND id = ?").get(projectId, id);
  if (!row) throw learningLibraryError("LEARNING_LIBRARY_NOT_FOUND", `Learning library not found: ${id}`);
  return row;
}

function assertNameAvailable(database, projectId, name, excludeId = "") {
  const duplicate = database.prepare(
    "SELECT id FROM learning_libraries WHERE project_id = ? AND name = ? COLLATE NOCASE AND id != ? COLLATE NOCASE LIMIT 1",
  ).get(projectId, name, excludeId);
  if (duplicate) throw learningLibraryError("LEARNING_LIBRARY_NAME_TAKEN", `Learning library already exists: ${name}`);
}

export function listLearningLibraries({ database, projectId }) {
  const cleanProjectId = sanitizeProjectId(projectId);
  // count 只算没进回收站的图：回收站里暂时看不到、也不计数，恢复后回来。
  return database.prepare(`
    SELECT l.id, l.name, l.created_at, COUNT(a.id) AS count
    FROM learning_libraries l
    LEFT JOIN learning_library_members m
      ON m.project_id = l.project_id AND m.library_id = l.id
    LEFT JOIN assets a
      ON a.project_id = m.project_id AND a.id = m.asset_id AND a.deleted_at IS NULL
    WHERE l.project_id = ?
    GROUP BY l.id, l.name, l.created_at
    ORDER BY l.created_at ASC, l.id ASC
  `).all(cleanProjectId).map((row) => ({
    id: row.id,
    name: row.name,
    count: Number(row.count || 0),
    createdAt: row.created_at,
  }));
}

export function getLearningLibrary({ database, projectId, id }) {
  const cleanProjectId = sanitizeProjectId(projectId);
  const row = database.prepare(`
    SELECT l.id, l.name, l.created_at,
      COUNT(a.id) AS count,
      COUNT(DISTINCT CASE WHEN COALESCE(a.group_name, '') != '' AND a.deleted_at IS NULL THEN a.group_name END) AS group_count
    FROM learning_libraries l
    LEFT JOIN learning_library_members m
      ON m.project_id = l.project_id AND m.library_id = l.id
    LEFT JOIN assets a
      ON a.project_id = m.project_id AND a.id = m.asset_id AND a.deleted_at IS NULL
    WHERE l.project_id = ? AND l.id = ?
    GROUP BY l.id, l.name, l.created_at
  `).get(cleanProjectId, id);
  if (!row) throw learningLibraryError("LEARNING_LIBRARY_NOT_FOUND", `Learning library not found: ${id}`);
  return {
    id: row.id,
    name: row.name,
    count: Number(row.count || 0),
    groupCount: Number(row.group_count || 0),
    createdAt: row.created_at,
  };
}

export function createLearningLibrary({ database, commitLibraryChanges, projectId, name }) {
  const cleanProjectId = sanitizeProjectId(projectId);
  const cleanName = normalizeLibraryName(name);
  if (!cleanName) throw learningLibraryError("LEARNING_LIBRARY_NAME_EMPTY", "Learning library name is required.");
  const id = newLibraryId();
  const timestamp = now();
  database.transaction(() => {
    assertNameAvailable(database, cleanProjectId, cleanName);
    database.prepare(
      "INSERT INTO learning_libraries (project_id, id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(cleanProjectId, id, cleanName, timestamp, timestamp);
    commitLibraryChanges([{ projectId: cleanProjectId, kind: "learning-library-created", entityType: "learning-library", entityId: id }]);
  })();
  return { id, name: cleanName, count: 0, createdAt: timestamp };
}

export function renameLearningLibrary({ database, commitLibraryChanges, projectId, id, name }) {
  const cleanProjectId = sanitizeProjectId(projectId);
  const cleanName = normalizeLibraryName(name);
  if (!cleanName) throw learningLibraryError("LEARNING_LIBRARY_NAME_EMPTY", "Learning library name is required.");
  const timestamp = now();
  database.transaction(() => {
    const library = requireLibraryRow(database, cleanProjectId, id);
    assertNameAvailable(database, cleanProjectId, cleanName, library.id);
    database.prepare(
      "UPDATE learning_libraries SET name = ?, updated_at = ? WHERE project_id = ? AND id = ?",
    ).run(cleanName, timestamp, cleanProjectId, id);
    commitLibraryChanges([{
      projectId: cleanProjectId,
      kind: "learning-library-renamed",
      entityType: "learning-library",
      entityId: id,
      detail: { to: cleanName },
    }]);
  })();
  return { success: true, id, name: cleanName };
}

export function deleteLearningLibrary({ database, commitLibraryChanges, projectId, id }) {
  const cleanProjectId = sanitizeProjectId(projectId);
  database.transaction(() => {
    const library = requireLibraryRow(database, cleanProjectId, id);
    // 成员行靠外键 ON DELETE CASCADE 一起删；学习库只删自己，图一张不动。
    const result = database.prepare("DELETE FROM learning_libraries WHERE project_id = ? AND id = ?").run(cleanProjectId, id);
    if (!result.changes) throw learningLibraryError("LEARNING_LIBRARY_NOT_FOUND", `Learning library not found: ${id}`);
    commitLibraryChanges([{ projectId: cleanProjectId, kind: "learning-library-deleted", entityType: "learning-library", entityId: id }]);
    return library;
  })();
  return { success: true, id };
}

// Expands the three sources (asset ids, stack ids, one group name) into a
// deduped list of asset ids. Stacks and the group contribute their members
// (trash-excluded); trashed assets never join a learning library.
function expandMemberAssetIds(database, projectId, { assetIds, stackIds, groupName }) {
  const ids = [];
  const seen = new Set();
  const push = (value) => {
    const id = String(value || "").trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const assetId of Array.isArray(assetIds) ? assetIds : []) push(assetId);
  for (const stackId of Array.isArray(stackIds) ? stackIds : []) {
    const stackIdClean = String(stackId || "").trim();
    if (!stackIdClean) continue;
    for (const row of database.prepare(
      "SELECT sm.asset_id AS id FROM asset_stack_members sm JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id WHERE sm.project_id = ? AND sm.stack_id = ? AND a.deleted_at IS NULL",
    ).all(projectId, stackIdClean)) push(row.id);
  }
  const groupNameClean = normalizeGroupName(groupName);
  if (groupNameClean) {
    for (const row of database.prepare(
      "SELECT id FROM assets WHERE project_id = ? AND group_name = ? AND deleted_at IS NULL",
    ).all(projectId, groupNameClean)) push(row.id);
  }
  return ids;
}

export function addToLearningLibrary({ database, commitLibraryChanges, projectId, id, assetIds, stackIds, groupName }) {
  const cleanProjectId = sanitizeProjectId(projectId);
  const candidates = expandMemberAssetIds(database, cleanProjectId, { assetIds, stackIds, groupName });
  const selectAsset = database.prepare("SELECT id, deleted_at, media_kind FROM assets WHERE project_id = ? AND id = ?");
  const selectMember = database.prepare(
    "SELECT 1 FROM learning_library_members WHERE project_id = ? AND library_id = ? AND asset_id = ?",
  );
  const insertMember = database.prepare(
    "INSERT INTO learning_library_members (project_id, library_id, asset_id, added_at) VALUES (?, ?, ?, ?)",
  );
  const addedIds = [];
  let alreadyIn = 0;
  let skippedVideos = 0;
  let missing = 0;
  database.transaction(() => {
    requireLibraryRow(database, cleanProjectId, id);
    const timestamp = now();
    for (const assetId of candidates) {
      const asset = selectAsset.get(cleanProjectId, assetId);
      if (!asset) { missing += 1; continue; }
      // 回收站里的不加（各来源展开时已排除；直接给的 id 在这里挡一道）。
      if (asset.deleted_at) continue;
      // 学习库只收图片：视频跳过并计数。
      if (asset.media_kind !== "image") { skippedVideos += 1; continue; }
      if (selectMember.get(cleanProjectId, id, assetId)) { alreadyIn += 1; continue; }
      insertMember.run(cleanProjectId, id, assetId, timestamp);
      addedIds.push(assetId);
    }
    if (addedIds.length) {
      commitLibraryChanges([{
        projectId: cleanProjectId,
        kind: "learning-library-members-changed",
        entityType: "learning-library",
        entityId: id,
        assetIds: addedIds,
        detail: { action: "added" },
      }]);
    }
  })();
  return { added: addedIds.length, alreadyIn, skippedVideos, missing };
}

export function removeFromLearningLibrary({ database, commitLibraryChanges, projectId, id, assetIds }) {
  const cleanProjectId = sanitizeProjectId(projectId);
  const wanted = [...new Set((Array.isArray(assetIds) ? assetIds : []).map((value) => String(value || "").trim()).filter(Boolean))];
  const removedIds = [];
  database.transaction(() => {
    requireLibraryRow(database, cleanProjectId, id);
    const remove = database.prepare(
      "DELETE FROM learning_library_members WHERE project_id = ? AND library_id = ? AND asset_id = ?",
    );
    for (const assetId of wanted) {
      if (remove.run(cleanProjectId, id, assetId).changes) removedIds.push(assetId);
    }
    if (removedIds.length) {
      commitLibraryChanges([{
        projectId: cleanProjectId,
        kind: "learning-library-members-changed",
        entityType: "learning-library",
        entityId: id,
        assetIds: removedIds,
        detail: { action: "removed" },
      }]);
    }
  })();
  return { removed: removedIds.length };
}
