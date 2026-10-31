import { readJson, sendJson } from "../http-response.mjs";
import { assertExternalVerificationLevel } from "../generation-history.mjs";
import { requireStringField } from "./request-fields.mjs";

function projectIdFrom(url, body = {}) {
  return String(body.projectId || body.project_id || url.searchParams.get("project") || "default");
}

function requireGenerationStore(store, method) {
  if (typeof store?.[method] !== "function") {
    const error = new Error("Generation history is unavailable.");
    error.statusCode = 501;
    error.code = "GENERATION_HISTORY_UNAVAILABLE";
    error.expose = true;
    throw error;
  }
}

export async function handleGenerationRoute({ req, res, url, context }) {
  const { store } = context;

  const assetHistoryMatch = /^\/api\/assets\/([^/]+)\/([^/]+)\/generation-history$/.exec(url.pathname);
  if (req.method === "GET" && assetHistoryMatch) {
    requireGenerationStore(store, "getAssetGenerationHistory");
    const projectId = decodeURIComponent(assetHistoryMatch[1]);
    const assetId = decodeURIComponent(assetHistoryMatch[2]);
    sendJson(res, 200, { history: await store.getAssetGenerationHistory(projectId, assetId) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/generations") {
    requireGenerationStore(store, "listGenerationEvents");
    const projectId = projectIdFrom(url);
    const rawLimit = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 250) : 100;
    const rawCursor = Number(url.searchParams.get("cursor"));
    const offset = Number.isInteger(rawCursor) && rawCursor >= 0 ? rawCursor : 0;
    const events = await store.listGenerationEvents(projectId, {
      assetId: url.searchParams.get("asset") || "",
      captureContextId: url.searchParams.get("captureContext") || "",
      providerToolCallId: url.searchParams.get("providerToolCallId") || "",
      providerGenerationCallId: url.searchParams.get("providerGenerationCallId") || "",
      limit: limit + 1,
      offset,
    });
    const hasMore = events.length > limit;
    sendJson(res, 200, {
      events: hasMore ? events.slice(0, limit) : events,
      page: { limit, nextCursor: hasMore ? String(offset + limit) : null },
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/generations") {
    requireGenerationStore(store, "recordGenerationEvent");
    const body = await readJson(req);
    assertExternalVerificationLevel(body?.verification_level || body?.verificationLevel);
    const event = await store.recordGenerationEvent({
      project_id: projectIdFrom(url, body),
      output_asset_id: body?.output_asset_id || body?.outputAssetId || body?.asset_id || body?.assetId,
      provider: body?.provider,
      capture_context_id: body?.capture_context_id || body?.captureContextId,
      provider_tool_call_id: body?.provider_tool_call_id || body?.providerToolCallId,
      provider_generation_call_id: body?.provider_generation_call_id || body?.providerGenerationCallId,
      provider_response_id: body?.provider_response_id || body?.providerResponseId,
      provider_asset_id: body?.provider_asset_id || body?.providerAssetId,
      conversation_id: body?.conversation_id || body?.conversationId,
      message_id: body?.message_id || body?.messageId,
      batch_id: body?.batch_id || body?.batchId || body?.generation_batch_id || body?.generationBatchId,
      model: body?.model,
      user_prompt: body?.user_prompt || body?.userPrompt,
      effective_prompt: body?.effective_prompt || body?.effectivePrompt || body?.prompt,
      prompt_status: body?.prompt_status || body?.promptStatus,
      prompt_scope: body?.prompt_scope || body?.promptScope,
      generation_status: body?.generation_status || body?.generationStatus,
      capture_channel: body?.capture_channel || body?.captureChannel || "http-api",
      verification_level: body?.verification_level || body?.verificationLevel || "observed",
      references: body?.references,
      evidence: body?.evidence,
      created_at: body?.created_at || body?.createdAt,
    });
    sendJson(res, 201, { event });
    return true;
  }

  // Capture-plugin conversation sync: file id → message id / turn index.
  // Same client-token gate as every other non-GET /api route (applied by the
  // runtime before dispatch); validation errors surface as 400 with nothing
  // written (see generation-message-binding.mjs).
  if (req.method === "POST" && url.pathname === "/api/generation-message-bindings") {
    requireGenerationStore(store, "applyGenerationMessageBindings");
    const body = await readJson(req);
    const result = await store.applyGenerationMessageBindings({
      ...body,
      project_id: projectIdFrom(url, body),
    });
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/generation-relations") {
    requireGenerationStore(store, "recordGenerationRelation");
    const body = await readJson(req);
    // Task 314 ⑤: relation identities are strings; a wrong type is a 400
    // before the store ever sees it.
    requireStringField(body, "childGenerationId", { optional: true, maxLength: 200 });
    requireStringField(body, "parentGenerationId", { optional: true, maxLength: 200 });
    requireStringField(body, "relationType", { optional: true, maxLength: 60 });
    assertExternalVerificationLevel(body?.verification_level || body?.verificationLevel);
    const relation = await store.recordGenerationRelation({
      ...body,
      project_id: projectIdFrom(url, body),
    });
    sendJson(res, 201, { relation });
    return true;
  }

  if (req.method === "PATCH" && url.pathname === "/api/generation-relation-candidates") {
    requireGenerationStore(store, "updateGenerationRelationCandidate");
    const body = await readJson(req);
    const status = String(body?.status || "").trim();
    if (!new Set(["suggested", "dismissed"]).has(status)) {
      const error = new Error("Generation relation candidate status must be suggested or dismissed.");
      error.statusCode = 400;
      error.code = "GENERATION_RELATION_CANDIDATE_STATUS_UNSUPPORTED";
      error.expose = true;
      throw error;
    }
    const candidate = await store.updateGenerationRelationCandidate({
      ...body,
      project_id: projectIdFrom(url, body),
      status,
    });
    sendJson(res, 200, { candidate });
    return true;
  }

  if (req.method === "PATCH" && url.pathname === "/api/generation-relations") {
    requireGenerationStore(store, "updateGenerationRelation");
    const body = await readJson(req);
    requireStringField(body, "childGenerationId", { optional: true, maxLength: 200 });
    requireStringField(body, "parentGenerationId", { optional: true, maxLength: 200 });
    requireStringField(body, "relationType", { optional: true, maxLength: 60 });
    assertExternalVerificationLevel(body?.verification_level || body?.verificationLevel);
    const relation = await store.updateGenerationRelation({
      ...body,
      project_id: projectIdFrom(url, body),
    });
    sendJson(res, 200, { relation });
    return true;
  }

  if (req.method === "DELETE" && url.pathname === "/api/generation-relations") {
    requireGenerationStore(store, "deleteGenerationRelation");
    const body = await readJson(req);
    requireStringField(body, "childGenerationId", { optional: true, maxLength: 200 });
    requireStringField(body, "parentGenerationId", { optional: true, maxLength: 200 });
    requireStringField(body, "relationType", { optional: true, maxLength: 60 });
    const relation = await store.deleteGenerationRelation({
      ...body,
      project_id: projectIdFrom(url, body),
    });
    sendJson(res, 200, { relation });
    return true;
  }

  const lineageMatch = /^\/api\/generations\/([^/]+)\/lineage$/.exec(url.pathname);
  if (req.method === "GET" && lineageMatch) {
    requireGenerationStore(store, "getGenerationLineage");
    const projectId = projectIdFrom(url);
    const generationId = decodeURIComponent(lineageMatch[1]);
    sendJson(res, 200, { lineage: await store.getGenerationLineage(projectId, generationId) });
    return true;
  }

  return false;
}
