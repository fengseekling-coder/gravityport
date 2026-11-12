// Generation event and relation row helpers for SQLite store (task 394). Pure moves; no behavior changes.
import {
  assetNotFoundError,
  assetStoreError,
  versionParentError,
} from "../asset-version-history.mjs";
import {
  generationHistoryError,
  resolveGenerationRelationCandidates,
} from "../generation-history.mjs";
import { parseJson } from "./rows-util.mjs";
import { now } from "./util.mjs";

export function generationEventFromRow(row) {
  return {
    project_id: row.project_id,
    id: row.id,
    output_asset_id: row.output_asset_id,
    provider: row.provider,
    capture_context_id: row.capture_context_id,
    provider_tool_call_id: row.provider_tool_call_id,
    provider_generation_call_id: row.provider_generation_call_id,
    provider_response_id: row.provider_response_id,
    provider_asset_id: row.provider_asset_id,
    conversation_id: row.conversation_id,
    message_id: row.message_id,
    turn_index: row.turn_index == null ? null : Number(row.turn_index),
    turn_synced_at: row.turn_synced_at == null ? null : String(row.turn_synced_at),
    batch_id: row.batch_id,
    model: row.model,
    user_prompt: row.user_prompt,
    effective_prompt: row.effective_prompt,
    prompt_status: row.prompt_status,
    prompt_scope: row.prompt_scope || "",
    generation_status: row.generation_status || "unknown",
    capture_channel: row.capture_channel,
    verification_level: row.verification_level,
    references: parseJson(row.references_json, []),
    evidence: parseJson(row.evidence_json, {}),
    created_at: row.created_at,
  };
}

export function generationRelationFromRow(row) {
  return {
    project_id: row.project_id,
    child_generation_id: row.child_generation_id,
    parent_generation_id: row.parent_generation_id,
    relation_type: row.relation_type,
    verification_level: row.verification_level,
    evidence: parseJson(row.evidence_json, {}),
    created_at: row.created_at,
  };
}

export function generationRelationCandidateFromRow(row) {
  return {
    project_id: row.project_id,
    child_generation_id: row.child_generation_id,
    parent_generation_id: row.parent_generation_id,
    suggested_relation_type: row.suggested_relation_type,
    confidence: Number(row.confidence || 0),
    verification_level: row.verification_level,
    evidence: parseJson(row.evidence_json, {}),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function generationOutputAssetIds(database, projectId, generationIds) {
  const ids = [...new Set((Array.isArray(generationIds) ? generationIds : []).map(String).filter(Boolean))];
  if (!ids.length) return [];
  return database.prepare(`
    SELECT DISTINCT output_asset_id
    FROM generation_events
    WHERE project_id = ? AND id IN (SELECT value FROM json_each(?))
  `).all(projectId, JSON.stringify(ids)).map((row) => String(row.output_asset_id || "")).filter(Boolean);
}

export function syncSqliteGenerationRelationCandidatesForEvent(database, projectId, previousEvent, nextEvent) {
  const changedEvents = [previousEvent, nextEvent].filter(Boolean);
  const conversations = [...new Set(changedEvents
    .filter((event) => String(event?.provider || "").toLowerCase() === "chatgpt" && event?.conversation_id)
    .map((event) => String(event.conversation_id)))];
  const eventIds = [...new Set(changedEvents.map((event) => event.id).filter(Boolean))];
  const conversationClause = conversations.length
    ? " OR (provider = 'chatgpt' AND conversation_id IN (SELECT value FROM json_each(?)))"
    : "";
  const idClause = eventIds.length ? "id IN (SELECT value FROM json_each(?))" : "0";
  const lookupParams = [projectId];
  if (eventIds.length) lookupParams.push(JSON.stringify(eventIds));
  if (conversations.length) lookupParams.push(JSON.stringify(conversations));
  const events = database.prepare(`
    SELECT * FROM generation_events
    WHERE project_id = ? AND (${idClause}${conversationClause})
    ORDER BY created_at, id
  `).all(...lookupParams).map(generationEventFromRow);
  const compareEvents = (left, right) => (
    String(left?.created_at || "").localeCompare(String(right?.created_at || ""))
    || String(left?.id || "").localeCompare(String(right?.id || ""))
  );
  const thresholdsByConversation = new Map();
  for (const event of changedEvents) {
    if (String(event?.provider || "").toLowerCase() !== "chatgpt" || !event?.conversation_id) continue;
    const key = String(event.conversation_id);
    const current = thresholdsByConversation.get(key);
    if (!current || compareEvents(event, current) < 0) thresholdsByConversation.set(key, event);
  }
  const changedIds = new Set(eventIds);
  const childIds = [...new Set(events
    .filter((event) => {
      if (changedIds.has(event.id)) return true;
      const threshold = thresholdsByConversation.get(String(event.conversation_id || ""));
      return threshold && compareEvents(event, threshold) >= 0;
    })
    .map((event) => event.id))];
  if (!childIds.length) return [];
  const childIdsJson = JSON.stringify(childIds);
  const relations = database.prepare(`
    SELECT * FROM generation_relations
    WHERE project_id = ? AND child_generation_id IN (SELECT value FROM json_each(?))
    ORDER BY created_at, child_generation_id, parent_generation_id
  `).all(projectId, childIdsJson).map(generationRelationFromRow);
  const candidates = database.prepare(`
    SELECT * FROM generation_relation_candidates
    WHERE project_id = ? AND child_generation_id IN (SELECT value FROM json_each(?))
  `).all(projectId, childIdsJson).map(generationRelationCandidateFromRow);
  const resolved = resolveGenerationRelationCandidates({ projectId, events, relations, candidates, childEventIds: childIds, now: now() });
  const write = database.transaction(() => {
    database.prepare(`
      DELETE FROM generation_relation_candidates
      WHERE project_id = ? AND child_generation_id IN (SELECT value FROM json_each(?))
    `).run(projectId, childIdsJson);
    const insert = database.prepare(`
      INSERT INTO generation_relation_candidates (
        project_id, child_generation_id, parent_generation_id, suggested_relation_type,
        confidence, verification_level, evidence_json, status, created_at, updated_at
      ) VALUES (
        @project_id, @child_generation_id, @parent_generation_id, @suggested_relation_type,
        @confidence, @verification_level, @evidence_json, @status, @created_at, @updated_at
      )
    `);
    for (const candidate of resolved) {
      insert.run({ ...candidate, evidence_json: JSON.stringify(candidate.evidence || {}) });
    }
  });
  write();
  return resolved;
}

export function syncSqliteGenerationRelationCandidates(database, projectId) {
  const events = database.prepare("SELECT * FROM generation_events WHERE project_id = ? ORDER BY created_at, id").all(projectId).map(generationEventFromRow);
  const relations = database.prepare("SELECT * FROM generation_relations WHERE project_id = ? ORDER BY created_at, child_generation_id, parent_generation_id").all(projectId).map(generationRelationFromRow);
  const candidates = database.prepare("SELECT * FROM generation_relation_candidates WHERE project_id = ?").all(projectId).map(generationRelationCandidateFromRow);
  const resolved = resolveGenerationRelationCandidates({ projectId, events, relations, candidates, now: now() });
  const write = database.transaction(() => {
    database.prepare("DELETE FROM generation_relation_candidates WHERE project_id = ?").run(projectId);
    const insert = database.prepare(`
      INSERT INTO generation_relation_candidates (
        project_id, child_generation_id, parent_generation_id, suggested_relation_type,
        confidence, verification_level, evidence_json, status, created_at, updated_at
      ) VALUES (
        @project_id, @child_generation_id, @parent_generation_id, @suggested_relation_type,
        @confidence, @verification_level, @evidence_json, @status, @created_at, @updated_at
      )
    `);
    for (const candidate of resolved) insert.run({ ...candidate, evidence_json: JSON.stringify(candidate.evidence || {}) });
  });
  write();
  return resolved;
}

export function assertSqliteVersionParent(database, projectId, assetId, parentAssetId) {
  if (!parentAssetId) return;
  if (parentAssetId === assetId) throw assetStoreError("VERSION_CYCLE", `Asset cannot be its own version parent: ${assetId}`);
  if (database.prepare("SELECT 1 FROM assets WHERE project_id = ? AND id = ?").get(projectId, parentAssetId)) return;
  const foreignProjects = database.prepare("SELECT project_id FROM assets WHERE id = ? AND project_id != ? ORDER BY project_id").all(parentAssetId, projectId).map((row) => row.project_id);
  throw versionParentError(parentAssetId, foreignProjects);
}

export function findSqliteVersionRoot(database, projectId, assetId) {
  const chain = database.prepare(`
    WITH RECURSIVE version_chain(id, parent_asset_id, depth, path) AS (
      SELECT id, parent_asset_id, 0, '|' || id || '|'
      FROM assets
      WHERE project_id = ? AND id = ?
      UNION ALL
      SELECT parent.id, parent.parent_asset_id, version_chain.depth + 1, version_chain.path || parent.id || '|'
      FROM assets parent
      JOIN version_chain ON parent.id = version_chain.parent_asset_id
      WHERE parent.project_id = ?
        AND version_chain.parent_asset_id IS NOT NULL
        AND instr(version_chain.path, '|' || parent.id || '|') = 0
        AND version_chain.depth < 5000
    )
    SELECT id, parent_asset_id, depth, path
    FROM version_chain
    ORDER BY depth
  `).all(projectId, assetId, projectId);
  if (!chain.length) throw assetNotFoundError(assetId);
  const last = chain.at(-1);
  if (!last.parent_asset_id) return last.id;
  if (String(last.path || "").includes(`|${last.parent_asset_id}|`)) {
    throw assetStoreError("VERSION_CYCLE", `Version cycle detected at asset: ${last.parent_asset_id}`);
  }
  const foreignProjects = database.prepare("SELECT project_id FROM assets WHERE id = ? AND project_id != ? ORDER BY project_id").all(last.parent_asset_id, projectId).map((item) => item.project_id);
  throw versionParentError(last.parent_asset_id, foreignProjects);
}

export function assertSqliteGenerationRelationAcyclic(database, relation, exclude = null) {
  const childId = relation.child_generation_id;
  const parentId = relation.parent_generation_id;
  const excluded = exclude || {};
  const cycle = database.prepare(`
    WITH RECURSIVE ancestors(id) AS (
      VALUES (?)
      UNION
      SELECT gr.parent_generation_id
      FROM generation_relations gr
      JOIN ancestors ON gr.child_generation_id = ancestors.id
      WHERE gr.project_id = ?
        AND NOT (
          gr.child_generation_id = ?
          AND gr.parent_generation_id = ?
          AND gr.relation_type = ?
        )
    )
    SELECT 1 FROM ancestors WHERE id = ? LIMIT 1
  `).get(
    parentId,
    relation.project_id,
    String(excluded.child_generation_id || ""),
    String(excluded.parent_generation_id || ""),
    String(excluded.relation_type || ""),
    childId,
  );
  if (cycle) throw generationHistoryError("Generation relation would create a cycle.", "GENERATION_RELATION_CYCLE");
}

export function sqliteGenerationComponentEvents(database, projectId, seedColumn, seedValue) {
  if (!seedValue) return [];
  const safeSeedColumn = seedColumn === "output_asset_id" ? "output_asset_id" : "id";
  return database.prepare(`
    WITH RECURSIVE connected(id) AS (
      SELECT id
      FROM generation_events
      WHERE project_id = @projectId AND ${safeSeedColumn} = @seedValue
      UNION
      SELECT gr.parent_generation_id
      FROM generation_relations gr
      JOIN connected ON gr.child_generation_id = connected.id
      WHERE gr.project_id = @projectId
      UNION
      SELECT gr.child_generation_id
      FROM generation_relations gr
      JOIN connected ON gr.parent_generation_id = connected.id
      WHERE gr.project_id = @projectId
    )
    SELECT ge.*
    FROM generation_events ge
    JOIN connected ON connected.id = ge.id
    WHERE ge.project_id = @projectId
    ORDER BY ge.created_at, ge.id
  `).all({ projectId, seedValue }).map(generationEventFromRow);
}

export function sqliteGenerationRelationsForEvents(database, projectId, events) {
  const ids = [...new Set(events.map((event) => event?.id).filter(Boolean))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  return database.prepare(`
    SELECT * FROM generation_relations
    WHERE project_id = ?
      AND child_generation_id IN (${placeholders})
      AND parent_generation_id IN (${placeholders})
    ORDER BY created_at, child_generation_id, parent_generation_id
  `).all(projectId, ...ids, ...ids).map(generationRelationFromRow);
}

export function sqliteGenerationCandidatesForEvents(database, projectId, events) {
  const ids = [...new Set(events.map((event) => event?.id).filter(Boolean))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  return database.prepare(`
    SELECT * FROM generation_relation_candidates
    WHERE project_id = ?
      AND (child_generation_id IN (${placeholders}) OR parent_generation_id IN (${placeholders}))
    ORDER BY child_generation_id, confidence DESC, parent_generation_id
  `).all(projectId, ...ids, ...ids).map(generationRelationCandidateFromRow);
}

export function sqliteGenerationContextEvents(database, projectId, assetId, lineageEvents, candidates, limit) {
  if (!limit || !lineageEvents.length) return [];
  const connectedIds = [...new Set(lineageEvents.map((event) => event.id).filter(Boolean))];
  const candidateIds = [...new Set(candidates.flatMap((candidate) => [candidate.child_generation_id, candidate.parent_generation_id]).filter(Boolean))];
  const connectedPlaceholders = connectedIds.map(() => "?").join(",");
  const candidateClause = candidateIds.length
    ? ` OR ge.id IN (${candidateIds.map(() => "?").join(",")})`
    : "";
  return database.prepare(`
    SELECT ge.*
    FROM generation_events ge
    WHERE ge.project_id = ?
      AND ge.id NOT IN (${connectedPlaceholders})
      AND (
        EXISTS (
          SELECT 1 FROM generation_events seed
          WHERE seed.project_id = ge.project_id
            AND seed.output_asset_id = ?
            AND seed.conversation_id != ''
            AND seed.provider = ge.provider
            AND seed.conversation_id = ge.conversation_id
        )${candidateClause}
      )
    ORDER BY ge.created_at, ge.id
    LIMIT ?
  `).all(projectId, ...connectedIds, assetId, ...candidateIds, limit).map(generationEventFromRow);
}
