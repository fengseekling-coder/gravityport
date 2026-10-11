import { createHash } from "node:crypto";

export const GENERATION_VERIFICATION_LEVELS = Object.freeze([
  "provider_verified",
  "user_confirmed",
  "observed",
  "inferred",
]);

export const GENERATION_EXECUTION_STATUSES = Object.freeze([
  "unknown",
  "in_progress",
  "partial",
  "completed",
  "failed",
  "cancelled",
]);

export const GENERATION_RELATION_TYPES = Object.freeze([
  "edited_from",
  "variant_of",
  "derived_from",
  "based_on",
]);

export const GENERATION_RELATION_CANDIDATE_STATUSES = Object.freeze([
  "suggested",
  "dismissed",
  "confirmed",
]);

const verificationSet = new Set(GENERATION_VERIFICATION_LEVELS);
const generationStatusSet = new Set(GENERATION_EXECUTION_STATUSES);
const promptScopeSet = new Set(["", "output", "attempt", "message"]);
const relationTypeSet = new Set(GENERATION_RELATION_TYPES);
const candidateStatusSet = new Set(GENERATION_RELATION_CANDIDATE_STATUSES);
const GPT_RELATION_CANDIDATE_THRESHOLD = 0.45;
const GPT_RELATION_CANDIDATE_LIMIT = 3;

/**
 * A Generation Event records one act of generation. It deliberately does not
 * inherit identity from the output asset: one deduplicated media file can be
 * produced by several independent generation events.
 */
export function normalizeGenerationEvent(input = {}) {
  const projectId = clean(input.project_id || input.projectId || "default");
  const outputAssetId = clean(input.output_asset_id || input.outputAssetId || input.asset_id || input.assetId);
  if (!outputAssetId) throw generationHistoryError("Generation event requires output_asset_id.", "GENERATION_OUTPUT_ASSET_REQUIRED");

  const event = {
    project_id: projectId || "default",
    output_asset_id: outputAssetId,
    provider: clean(input.provider),
    capture_context_id: clean(input.capture_context_id || input.captureContextId),
    provider_tool_call_id: clean(input.provider_tool_call_id || input.providerToolCallId),
    provider_generation_call_id: clean(input.provider_generation_call_id || input.providerGenerationCallId),
    provider_response_id: clean(input.provider_response_id || input.providerResponseId),
    provider_asset_id: clean(input.provider_asset_id || input.providerAssetId),
    conversation_id: clean(input.conversation_id || input.conversationId),
    message_id: clean(input.message_id || input.messageId),
    // Only the binding API writes turn numbers; callers that pass one are
    // heard, but the HTTP capture route never forwards this field.
    turn_index: normalizeTurnIndex(input.turn_index || input.turnIndex),
    batch_id: clean(input.batch_id || input.batchId || input.generation_batch_id || input.generationBatchId),
    model: clean(input.model),
    user_prompt: clean(input.user_prompt || input.userPrompt),
    effective_prompt: clean(input.effective_prompt || input.effectivePrompt || input.prompt),
    prompt_status: clean(input.prompt_status || input.promptStatus),
    prompt_scope: normalizePromptScope(input.prompt_scope || input.promptScope),
    generation_status: normalizeGenerationStatus(input.generation_status || input.generationStatus),
    capture_channel: clean(input.capture_channel || input.captureChannel),
    verification_level: normalizeVerificationLevel(input.verification_level || input.verificationLevel, "observed"),
    references: normalizeReferences(input.references),
    evidence: normalizeObject(input.evidence),
    created_at: clean(input.created_at || input.createdAt) || new Date().toISOString(),
  };
  return {
    ...event,
    id: clean(input.id || input.generation_event_id || input.generationEventId) || generationEventId(event),
  };
}

export function normalizeGenerationRelation(input = {}) {
  const childGenerationId = clean(input.child_generation_id || input.childGenerationId);
  const parentGenerationId = clean(input.parent_generation_id || input.parentGenerationId);
  if (!childGenerationId || !parentGenerationId) {
    throw generationHistoryError("Generation relation requires child and parent generation IDs.", "GENERATION_RELATION_IDS_REQUIRED");
  }
  if (childGenerationId === parentGenerationId) {
    throw generationHistoryError("Generation relation cannot reference itself.", "GENERATION_RELATION_SELF_REFERENCE");
  }
  const relationType = clean(input.relation_type || input.relationType) || "derived_from";
  if (!relationTypeSet.has(relationType)) {
    throw generationHistoryError(`Unsupported generation relation type: ${relationType}`, "GENERATION_RELATION_TYPE_UNSUPPORTED");
  }
  return {
    project_id: clean(input.project_id || input.projectId || "default") || "default",
    child_generation_id: childGenerationId,
    parent_generation_id: parentGenerationId,
    relation_type: relationType,
    verification_level: normalizeVerificationLevel(input.verification_level || input.verificationLevel, "inferred"),
    evidence: normalizeObject(input.evidence),
    created_at: clean(input.created_at || input.createdAt) || new Date().toISOString(),
  };
}

export function normalizeGenerationRelationCandidate(input = {}) {
  const childGenerationId = clean(input.child_generation_id || input.childGenerationId);
  const parentGenerationId = clean(input.parent_generation_id || input.parentGenerationId);
  if (!childGenerationId || !parentGenerationId) {
    throw generationHistoryError("Generation relation candidate requires child and parent generation IDs.", "GENERATION_RELATION_CANDIDATE_IDS_REQUIRED");
  }
  if (childGenerationId === parentGenerationId) {
    throw generationHistoryError("Generation relation candidate cannot reference itself.", "GENERATION_RELATION_CANDIDATE_SELF_REFERENCE");
  }
  const relationType = clean(input.suggested_relation_type || input.suggestedRelationType || input.relation_type || input.relationType) || "derived_from";
  if (!relationTypeSet.has(relationType)) {
    throw generationHistoryError(`Unsupported generation relation candidate type: ${relationType}`, "GENERATION_RELATION_TYPE_UNSUPPORTED");
  }
  const confidence = Math.min(Math.max(Number(input.confidence) || 0, 0), 1);
  const status = clean(input.status) || "suggested";
  if (!candidateStatusSet.has(status)) {
    throw generationHistoryError(`Unsupported generation relation candidate status: ${status}`, "GENERATION_RELATION_CANDIDATE_STATUS_UNSUPPORTED");
  }
  const createdAt = clean(input.created_at || input.createdAt) || new Date().toISOString();
  return {
    project_id: clean(input.project_id || input.projectId || "default") || "default",
    child_generation_id: childGenerationId,
    parent_generation_id: parentGenerationId,
    suggested_relation_type: relationType,
    confidence: Math.round(confidence * 100) / 100,
    verification_level: normalizeVerificationLevel(input.verification_level || input.verificationLevel, "inferred"),
    evidence: normalizeObject(input.evidence),
    status,
    created_at: createdAt,
    updated_at: clean(input.updated_at || input.updatedAt) || createdAt,
  };
}

/**
 * GPT web capture cannot authoritatively expose image lineage. This resolver
 * therefore emits candidates only. It never creates a GenerationRelation.
 * Candidates become durable relations only after explicit user confirmation.
 */
export function resolveGenerationRelationCandidates({ projectId = "default", events = [], relations = [], candidates = [], childEventIds = null, now = new Date().toISOString() }) {
  const normalizedProjectId = clean(projectId) || "default";
  const targetChildIds = childEventIds == null ? null : new Set([...childEventIds].map(clean).filter(Boolean));
  const ordered = [...events]
    .filter((event) => event?.id)
    .sort(compareGenerationEvents);
  const relationPairs = new Set(relations.map((relation) => generationCandidatePairKey(relation)));
  const existingByPair = new Map(candidates
    .filter((candidate) => candidate?.child_generation_id && candidate?.parent_generation_id)
    .map((candidate) => [generationCandidatePairKey(candidate), normalizeGenerationRelationCandidate(candidate)]));
  const generated = new Map();

  for (let childIndex = 0; childIndex < ordered.length; childIndex += 1) {
    const child = ordered[childIndex];
    if (targetChildIds && !targetChildIds.has(clean(child.id))) continue;
    if (clean(child.provider).toLowerCase() !== "chatgpt") continue;
    if (!clean(child.conversation_id)) continue;
    const suggestions = [];
    let rank = 0;
    for (let parentIndex = childIndex - 1; parentIndex >= 0; parentIndex -= 1) {
      const parent = ordered[parentIndex];
      if (!isEligibleGptParent(parent, child)) continue;
      const pairKey = generationCandidatePairKey({ child_generation_id: child.id, parent_generation_id: parent.id });
      if (relationPairs.has(pairKey)) {
        rank += 1;
        continue;
      }
      const scored = scoreGptRelationCandidate(parent, child, rank);
      rank += 1;
      if (scored.confidence < GPT_RELATION_CANDIDATE_THRESHOLD) continue;
      suggestions.push(normalizeGenerationRelationCandidate({
        project_id: normalizedProjectId,
        child_generation_id: child.id,
        parent_generation_id: parent.id,
        suggested_relation_type: scored.relationType,
        confidence: scored.confidence,
        verification_level: scored.verificationLevel,
        evidence: {
          resolver: "chatgpt-lineage-v1",
          signals: scored.signals,
          parent_provider_asset_id: scored.explicitReference ? clean(parent.provider_asset_id) : "",
          child_message_id: clean(child.message_id),
          parent_message_id: clean(parent.message_id),
        },
        status: "suggested",
        created_at: now,
        updated_at: now,
      }));
      if (suggestions.length >= GPT_RELATION_CANDIDATE_LIMIT) break;
    }
    for (const suggestion of suggestions) generated.set(generationCandidatePairKey(suggestion), suggestion);
  }

  const next = [];
  for (const [pairKey, suggestion] of generated) {
    const existing = existingByPair.get(pairKey);
    if (existing?.status === "dismissed" || existing?.status === "confirmed") {
      next.push(existing);
      continue;
    }
    next.push({
      ...suggestion,
      created_at: existing?.created_at || suggestion.created_at,
      updated_at: now,
    });
  }
  for (const [pairKey, existing] of existingByPair) {
    if (generated.has(pairKey)) continue;
    if (existing.status === "dismissed" || existing.status === "confirmed") next.push(existing);
  }
  return next.sort(compareGenerationCandidates);
}

export function normalizeVerificationLevel(value, fallback = "observed") {
  const normalized = clean(value);
  if (verificationSet.has(normalized)) return normalized;
  return verificationSet.has(fallback) ? fallback : "observed";
}

/**
 * Turn numbers come from the capture plugin's page reads (1-based, counted in
 * user messages). Anything else — absent, 0, fractional, text — means "not
 * bound yet" and is kept as null.
 */
function normalizeTurnIndex(value) {
  return Number.isInteger(value) && value >= 1 ? value : null;
}

/**
 * `provider_verified` crosses a trust boundary. Public HTTP/MCP callers may
 * provide provider identifiers, but only a MOSA-owned provider integration
 * that directly observed the provider response may claim provider verification.
 */
export function assertExternalVerificationLevel(value) {
  if (clean(value) !== "provider_verified") return;
  throw generationHistoryError(
    "provider_verified is reserved for trusted GravityPort provider integrations.",
    "GENERATION_PROVIDER_VERIFICATION_RESERVED",
  );
}

export function preserveTrustedGenerationEvent(existing, next) {
  if (!existing || existing.verification_level !== "provider_verified") return next;
  if (next?.verification_level === "provider_verified") return next;
  return existing;
}

const NOT_AVAILABLE_PROMPT_STATUS = "not-available";

function strongerVerificationLevel(existingValue, nextValue) {
  const existingStrength = GENERATION_VERIFICATION_LEVELS.indexOf(existingValue);
  const nextStrength = GENERATION_VERIFICATION_LEVELS.indexOf(nextValue);
  if (existingStrength < 0) return nextValue;
  if (nextStrength < 0) return existingValue;
  return nextStrength <= existingStrength ? nextValue : existingValue;
}

/**
 * Field-level merge for re-observing a generation event that is already
 * stored. Replays of an already-archived capture — a reopened conversation
 * page reporting its images again, with no live prompt/model data in view —
 * must never erase what the live capture recorded: the asset keeps its
 * prompt, so the generation record keeps prompt, model, and provider ids.
 * An empty (or, for execution status, "unknown") new value is weaker
 * information than what is stored and loses; any non-empty new value wins.
 *
 * The prompt and its status travel together: keeping the stored prompt means
 * keeping the stored status, so the merge can never manufacture the broken
 * combination "prompt present, status not-available". Verification level can
 * only move up the trust ladder (provider_verified > user_confirmed >
 * observed > inferred); a weaker claim never demotes the stored one.
 */
export function mergeGenerationEventForUpdate(existing, next) {
  if (!existing) return next;
  if (preserveTrustedGenerationEvent(existing, next) === existing) return existing;
  const merged = { ...next };
  for (const key of [
    "model",
    "user_prompt",
    "provider_tool_call_id",
    "provider_generation_call_id",
    "provider_response_id",
    "provider_asset_id",
    "batch_id",
    "capture_channel",
    "conversation_id",
  ]) {
    if (!clean(merged[key])) merged[key] = existing[key] || "";
  }
  if (!merged.message_id) merged.message_id = existing.message_id || "";
  if (merged.turn_index == null) merged.turn_index = existing.turn_index ?? null;
  if (!merged.references.length && existing.references?.length) merged.references = existing.references;
  if (!Object.keys(merged.evidence || {}).length && Object.keys(existing.evidence || {}).length) merged.evidence = existing.evidence;
  if (merged.generation_status === "unknown" && existing.generation_status && existing.generation_status !== "unknown") {
    merged.generation_status = existing.generation_status;
  }
  merged.verification_level = strongerVerificationLevel(existing.verification_level, next.verification_level);
  const nextHasPrompt = Boolean(next.effective_prompt);
  merged.effective_prompt = next.effective_prompt || existing.effective_prompt || "";
  merged.prompt_status = nextHasPrompt
    ? (next.prompt_status || existing.prompt_status || "")
    : (existing.prompt_status || next.prompt_status || "");
  if (merged.effective_prompt && merged.prompt_status === NOT_AVAILABLE_PROMPT_STATUS) merged.prompt_status = "";
  return merged;
}

export function preserveTrustedGenerationRelation(existing, next) {
  if (!existing || existing.verification_level !== "provider_verified") return next;
  if (next?.verification_level === "provider_verified") return next;
  return existing;
}

export function assertGenerationRelationUserMutable(relation) {
  if (!relation) {
    throw generationHistoryError("Generation relation was not found.", "GENERATION_RELATION_NOT_FOUND", 404);
  }
  if (relation.verification_level === "provider_verified") {
    throw generationHistoryError(
      "Provider-verified generation relations cannot be changed from the public management surface.",
      "GENERATION_RELATION_PROVIDER_VERIFIED_IMMUTABLE",
      409,
    );
  }
}

export function assertGenerationRelationAcyclic(relation, relations = []) {
  const child = relation.child_generation_id;
  const parent = relation.parent_generation_id;
  const parentsByChild = new Map();
  for (const item of relations) {
    if (!item?.child_generation_id || !item?.parent_generation_id) continue;
    const parents = parentsByChild.get(item.child_generation_id) || [];
    parents.push(item.parent_generation_id);
    parentsByChild.set(item.child_generation_id, parents);
  }
  const pending = [parent];
  const seen = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    if (current === child) {
      throw generationHistoryError("Generation relation would create a cycle.", "GENERATION_RELATION_CYCLE");
    }
    seen.add(current);
    for (const ancestor of parentsByChild.get(current) || []) pending.push(ancestor);
  }
}

/**
 * Return the connected generation graph around one event. The graph is not
 * forced into a tree because a generation can legitimately have several
 * inputs/parents; callers may render a tree only when the recorded relations
 * actually form one.
 */
export function buildGenerationLineage({ projectId = "default", selectedGenerationId, events = [], relations = [], maxEvents = 5000 }) {
  const eventMap = new Map(events.map((event) => [event.id, event]));
  if (!eventMap.has(selectedGenerationId)) {
    throw generationHistoryError(`Generation event not found: ${selectedGenerationId}`, "GENERATION_EVENT_NOT_FOUND", 404);
  }

  const edges = relations.filter((relation) => eventMap.has(relation.child_generation_id) && eventMap.has(relation.parent_generation_id));
  const adjacent = new Map();
  for (const relation of edges) {
    for (const [left, right] of [[relation.child_generation_id, relation.parent_generation_id], [relation.parent_generation_id, relation.child_generation_id]]) {
      const neighbors = adjacent.get(left) || [];
      neighbors.push(right);
      adjacent.set(left, neighbors);
    }
  }

  const connectedIds = [];
  const seen = new Set();
  const queue = [selectedGenerationId];
  while (queue.length) {
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    if (connectedIds.length >= maxEvents) {
      throw generationHistoryError(`Generation lineage exceeds ${maxEvents} events.`, "GENERATION_LINEAGE_TOO_LARGE", 409);
    }
    seen.add(id);
    connectedIds.push(id);
    for (const neighbor of adjacent.get(id) || []) if (!seen.has(neighbor)) queue.push(neighbor);
  }

  const connected = new Set(connectedIds);
  const lineageRelations = edges.filter((relation) => connected.has(relation.child_generation_id) && connected.has(relation.parent_generation_id));
  const parentsByChild = new Map();
  const childrenByParent = new Map();
  for (const relation of lineageRelations) {
    const parents = parentsByChild.get(relation.child_generation_id) || [];
    parents.push(relation);
    parentsByChild.set(relation.child_generation_id, parents);
    const children = childrenByParent.get(relation.parent_generation_id) || [];
    children.push(relation);
    childrenByParent.set(relation.parent_generation_id, children);
  }

  const lineageEvents = connectedIds.map((id) => ({
    ...eventMap.get(id),
    parent_generation_ids: (parentsByChild.get(id) || []).map((relation) => relation.parent_generation_id),
    child_generation_ids: (childrenByParent.get(id) || []).map((relation) => relation.child_generation_id),
  }));
  return {
    project_id: projectId,
    selected_generation_id: selectedGenerationId,
    events: lineageEvents,
    relations: lineageRelations,
  };
}

/**
 * Build the union of every lineage component that contains at least one
 * generation whose output is the requested asset. This is the shape the
 * Inspector needs: one deduplicated Asset may be the output of several
 * independent generation events, and each of those events can belong to a
 * different lineage component.
 */
export function buildAssetGenerationHistory({ projectId = "default", assetId, events = [], relations = [], candidates = [], conversations = [], maxEvents = 5000 }) {
  const cleanAssetId = clean(assetId);
  if (!cleanAssetId) {
    throw generationHistoryError("Asset generation history requires asset_id.", "GENERATION_ASSET_ID_REQUIRED");
  }

  const eventMap = new Map(events.map((event) => [event.id, event]));
  const seedIds = events
    .filter((event) => event?.output_asset_id === cleanAssetId)
    .map((event) => event.id)
    .filter(Boolean);
  if (!seedIds.length) {
    return {
      project_id: projectId,
      asset_id: cleanAssetId,
      generation_ids: [],
      events: [],
      relations: [],
      context_events: [],
      context_truncated: false,
      relation_candidates: [],
      conversations: [],
    };
  }

  const validRelations = relations.filter((relation) => (
    eventMap.has(relation.child_generation_id) && eventMap.has(relation.parent_generation_id)
  ));
  const adjacent = new Map();
  for (const relation of validRelations) {
    for (const [left, right] of [
      [relation.child_generation_id, relation.parent_generation_id],
      [relation.parent_generation_id, relation.child_generation_id],
    ]) {
      const neighbors = adjacent.get(left) || [];
      neighbors.push(right);
      adjacent.set(left, neighbors);
    }
  }

  const connectedIds = [];
  const seen = new Set();
  const queue = [...seedIds];
  while (queue.length) {
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    if (connectedIds.length >= maxEvents) {
      throw generationHistoryError(`Generation history exceeds ${maxEvents} events.`, "GENERATION_LINEAGE_TOO_LARGE", 409);
    }
    seen.add(id);
    connectedIds.push(id);
    for (const neighbor of adjacent.get(id) || []) if (!seen.has(neighbor)) queue.push(neighbor);
  }

  const connected = new Set(connectedIds);
  const lineageRelations = validRelations.filter((relation) => (
    connected.has(relation.child_generation_id) && connected.has(relation.parent_generation_id)
  ));
  const parentsByChild = new Map();
  const childrenByParent = new Map();
  for (const relation of lineageRelations) {
    const parents = parentsByChild.get(relation.child_generation_id) || [];
    parents.push(relation);
    parentsByChild.set(relation.child_generation_id, parents);
    const children = childrenByParent.get(relation.parent_generation_id) || [];
    children.push(relation);
    childrenByParent.set(relation.parent_generation_id, children);
  }

  const historyEvents = connectedIds
    .map((id) => ({
      ...eventMap.get(id),
      parent_generation_ids: (parentsByChild.get(id) || []).map((relation) => relation.parent_generation_id),
      child_generation_ids: (childrenByParent.get(id) || []).map((relation) => relation.child_generation_id),
    }))
    .sort((left, right) => String(left.created_at || "").localeCompare(String(right.created_at || "")) || String(left.id || "").localeCompare(String(right.id || "")));

  // Keep same-conversation generations available as management candidates
  // without pretending they already belong to the lineage. The Inspector can
  // present these as "possible parent" suggestions and only turns one into an
  // edge after explicit user confirmation.
  const seedConversations = new Set(events
    .filter((event) => seedIds.includes(event?.id))
    .map(generationConversationKey)
    .filter(Boolean));
  // Surface the synced conversation metadata (turn count) for the
  // conversations the asset's own generations live in; unknown conversations
  // (never seen by the binding API) are simply absent.
  const historyConversations = conversations
    .filter((conversation) => conversation && seedConversations.has(generationConversationKey(conversation)))
    .map((conversation) => ({
      provider: clean(conversation.provider),
      conversation_id: clean(conversation.conversation_id),
      turn_count: Number(conversation.turn_count),
      synced_at: clean(conversation.synced_at),
    }))
    .sort((left, right) => (
      left.provider.localeCompare(right.provider)
      || left.conversation_id.localeCompare(right.conversation_id)
    ));
  const relationCandidates = candidates
    .map((candidate) => normalizeGenerationRelationCandidate(candidate))
    .filter((candidate) => candidate.status === "suggested")
    .filter((candidate) => (
      connected.has(candidate.child_generation_id)
      || connected.has(candidate.parent_generation_id)
    ));
  const candidateEventIds = new Set(relationCandidates.flatMap((candidate) => [
    candidate.child_generation_id,
    candidate.parent_generation_id,
  ]));
  const contextLimit = Math.max(0, maxEvents - historyEvents.length);
  const contextCandidates = events
    .filter((event) => event?.id && !connected.has(event.id) && (
      seedConversations.has(generationConversationKey(event))
      || candidateEventIds.has(event.id)
    ))
    .sort((left, right) => String(left.created_at || "").localeCompare(String(right.created_at || "")) || String(left.id || "").localeCompare(String(right.id || "")));
  const contextEvents = contextCandidates.slice(0, contextLimit);
  // Everything past the limit is silently dropped, so consumers counting on
  // the context need to know the answer is partial.
  const contextTruncated = contextCandidates.length > contextEvents.length;

  return {
    project_id: projectId,
    asset_id: cleanAssetId,
    generation_ids: [...seedIds],
    events: historyEvents,
    context_events: contextEvents,
    context_truncated: contextTruncated,
    relation_candidates: relationCandidates,
    conversations: historyConversations,
    relations: [...lineageRelations].sort((left, right) => (
      String(left.created_at || "").localeCompare(String(right.created_at || ""))
      || String(left.child_generation_id || "").localeCompare(String(right.child_generation_id || ""))
      || String(left.parent_generation_id || "").localeCompare(String(right.parent_generation_id || ""))
    )),
  };
}

function generationConversationKey(event) {
  const conversationId = clean(event?.conversation_id);
  if (!conversationId) return "";
  return `${clean(event?.provider)}\u0000${conversationId}`;
}

export function generationCandidatePairKey(candidate) {
  return `${clean(candidate?.child_generation_id)}\u0000${clean(candidate?.parent_generation_id)}`;
}

function isEligibleGptParent(parent, child) {
  if (!parent?.id || parent.id === child.id) return false;
  if (clean(parent.provider).toLowerCase() !== "chatgpt") return false;
  if (clean(parent.conversation_id) !== clean(child.conversation_id)) return false;
  if (compareGenerationEvents(parent, child) >= 0) return false;
  const parentContext = clean(parent.capture_context_id);
  const childContext = clean(child.capture_context_id);
  if (parentContext && childContext && parentContext === childContext) return false;
  const parentMessage = clean(parent.message_id);
  const childMessage = clean(child.message_id);
  if (parentMessage && childMessage && parentMessage === childMessage) return false;
  const parentBatch = clean(parent.batch_id);
  const childBatch = clean(child.batch_id);
  if (parentBatch && childBatch && parentBatch === childBatch) return false;
  return true;
}

function scoreGptRelationCandidate(parent, child, rank) {
  const signals = [];
  let score = 0;
  addSignal(signals, "same_conversation", 0.15);
  score += 0.15;

  if (rank === 0) {
    addSignal(signals, "immediately_previous_generation", 0.18);
    score += 0.18;
  }

  const parentTime = Date.parse(parent.created_at || "");
  const childTime = Date.parse(child.created_at || "");
  const deltaMs = Number.isFinite(parentTime) && Number.isFinite(childTime) ? Math.max(0, childTime - parentTime) : Number.POSITIVE_INFINITY;
  if (deltaMs <= 30 * 60 * 1000) {
    addSignal(signals, "recent_predecessor", 0.08);
    score += 0.08;
  }

  const prompt = clean(child.user_prompt || child.effective_prompt);
  const modification = looksLikeModificationPrompt(prompt);
  if (modification) {
    addSignal(signals, "modification_prompt", 0.25);
    score += 0.25;
  }

  const explicitReference = childReferencesParent(child, parent);
  if (explicitReference) {
    addSignal(signals, "explicit_parent_reference", 0.55);
    score += 0.55;
  }

  if (clean(parent.model) && clean(parent.model) === clean(child.model)) {
    addSignal(signals, "same_model", 0.03);
    score += 0.03;
  }

  if (looksLikeFreshCreationPrompt(prompt) && !explicitReference && !modification) {
    addSignal(signals, "fresh_creation_prompt", -0.18);
    score -= 0.18;
  }

  return {
    confidence: Math.min(1, Math.max(0, Math.round(score * 100) / 100)),
    // The reference observation is evidence, not proof of lineage. The
    // relation itself stays inferred until a user confirms it.
    verificationLevel: "inferred",
    relationType: modification ? "edited_from" : explicitReference ? "based_on" : suggestedRelationType(prompt, modification),
    explicitReference,
    signals,
  };
}

function childReferencesParent(child, parent) {
  const tokens = new Set([
    parent.id,
    parent.output_asset_id,
    parent.provider_asset_id,
    parent.capture_context_id,
    parent.provider_generation_call_id,
    parent.provider_tool_call_id,
  ].map(clean).filter(Boolean));
  if (!tokens.size) return false;
  for (const reference of Array.isArray(child.references) ? child.references : []) {
    if (!reference || typeof reference !== "object") continue;
    const values = [
      reference.asset_id,
      reference.reference_id,
      reference.provider_asset_id,
      reference.generation_event_id,
      reference.generation_id,
      reference.capture_context_id,
      reference.provider_generation_call_id,
    ].map(clean).filter(Boolean);
    if (values.some((value) => tokens.has(value))) return true;
  }
  return false;
}

function looksLikeModificationPrompt(prompt) {
  const value = clean(prompt).toLowerCase();
  if (!value) return false;
  return /(再|继续|修改|改成|改为|换成|换为|保持.+不变|上一张|这张图|这个版本|在此基础上|基于这|调整|放大|缩小|移除|删除|添加|背景.*(?:改|换)|logo.*(?:大|小|改)|edit\b|change\b|modify\b|keep\b.+\bsame\b|previous image|this image|based on this|make .* (?:larger|smaller)|remove\b|add\b)/i.test(value);
}

function looksLikeFreshCreationPrompt(prompt) {
  const value = clean(prompt).toLowerCase();
  if (!value) return false;
  return /(生成一|生成一个|画一|画一个|创建一|创建一个|做一张|create (?:an?|the) |generate (?:an?|the) |draw (?:an?|the) |make (?:an?|the) image)/i.test(value);
}

function suggestedRelationType(prompt, modification) {
  const value = clean(prompt).toLowerCase();
  if (/(变体|另一版|另一个版本|variation\b|variant\b|alternative version)/i.test(value)) return "variant_of";
  if (/(基于|参考这张|以.+为参考|based on|use .+ as (?:a )?reference)/i.test(value)) return "based_on";
  return modification ? "edited_from" : "derived_from";
}

function addSignal(signals, kind, weight) {
  signals.push({ kind, weight });
}

function compareGenerationEvents(left, right) {
  return String(left?.created_at || "").localeCompare(String(right?.created_at || ""))
    || String(left?.id || "").localeCompare(String(right?.id || ""));
}

function compareGenerationCandidates(left, right) {
  return String(left?.child_generation_id || "").localeCompare(String(right?.child_generation_id || ""))
    || Number(right?.confidence || 0) - Number(left?.confidence || 0)
    || String(left?.parent_generation_id || "").localeCompare(String(right?.parent_generation_id || ""));
}

export function generationHistoryError(message, code, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.expose = true;
  return error;
}

function generationEventId(event) {
  const anchor = event.provider_generation_call_id
    ? `provider-call:${event.provider_generation_call_id}`
    : event.capture_context_id
      ? `capture-context:${event.capture_context_id}`
      : event.conversation_id && event.message_id
        ? `message:${event.conversation_id}:${event.message_id}`
        : event.provider_asset_id
          ? `provider-asset:${event.provider_asset_id}`
          : `occurrence:${event.created_at}`;
  const digest = createHash("sha256")
    .update([event.project_id, event.provider, anchor, event.output_asset_id].join("\u0000"))
    .digest("hex");
  return `gen-${digest.slice(0, 24)}`;
}

function normalizeReferences(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((item) => {
    if (typeof item === "string") return { asset_id: clean(item) };
    return normalizeObject(item);
  }).filter((item) => Object.keys(item).length > 0);
}

function normalizeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...value };
}

function normalizePromptScope(value) {
  const scope = clean(value).toLowerCase();
  return promptScopeSet.has(scope) ? scope : "";
}

function normalizeGenerationStatus(value) {
  const raw = clean(value).toLowerCase().replace(/[\s-]+/g, "_");
  const aliases = {
    complete: "completed", succeeded: "completed", success: "completed", done: "completed", finished: "completed",
    failure: "failed", error: "failed", errored: "failed", rejected: "failed", timeout: "failed", timed_out: "failed",
    canceled: "cancelled", aborted: "cancelled", stopped: "cancelled",
    incomplete: "partial", running: "in_progress", generating: "in_progress", streaming: "in_progress", pending: "in_progress", queued: "in_progress",
  };
  const normalized = aliases[raw] || raw || "unknown";
  return generationStatusSet.has(normalized) ? normalized : "unknown";
}

function clean(value) {
  return String(value || "").trim();
}
