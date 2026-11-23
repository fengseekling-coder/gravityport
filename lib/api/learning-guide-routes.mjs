// Learning-guide routes (task 463). Dispatched from lib/api-routes.mjs right
// under handleLearningLibraryRoute; deliberately NOT in bridge-routes.mjs's
// WEB_CAPTURE_API_PATHS, so a browser-extension token can never reach them —
// same boundary as the 459 learning-library routes. None of these routes touch
// money or keys: anyone with the client token (the renderer already has it)
// can call them, and a forged analysis result only plants a fake note.
// Addressing is by library / run / entry id, never by name.
import { requireArrayField, requireBooleanField, requireStringField } from "./request-fields.mjs";
import { HttpError, readJson, sendJson } from "../http-response.mjs";

// request-fields.mjs 只覆盖字符串/数组/布尔（该文件这张单不动）；数字字段的
// 校验在本地按同一 HttpError 形状写。
function requireNumberField(body, name, { optional = false, min = null, integer = false } = {}) {
  const value = body?.[name];
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw new HttpError(400, "INVALID_FIELD", `Field "${name}" must be a number.`);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, "INVALID_FIELD", `Field "${name}" must be a number (received ${typeof value}).`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new HttpError(400, "INVALID_FIELD", `Field "${name}" must be an integer.`);
  }
  if (min !== null && value < min) {
    throw new HttpError(400, "INVALID_FIELD", `Field "${name}" must be >= ${min}.`);
  }
  return value;
}

// Same capability guard shape as asset-routes.mjs: stores without the
// capability answer 501 instead of an opaque 500 (the JSON store does not
// support the learning backend).
function requireStoreCapability(store, method, message, code) {
  if (typeof store?.[method] === "function") return;
  const error = new Error(message);
  error.statusCode = 501;
  error.code = code;
  error.expose = true;
  throw error;
}

function projectIdFrom(url, body = {}) {
  return body.projectId || body.project || url.searchParams.get("project") || "default";
}

export async function handleLearningGuideRoute({ req, res, url, context }) {
  const { store } = context;

  // ── GET state / pending / notes ──
  const learningMatch = /^\/api\/learning-libraries\/([^/]+)\/learning$/.exec(url.pathname);
  if (learningMatch && req.method === "GET") {
    requireStoreCapability(store, "getLearningState", "The learning backend is unavailable.", "LEARNING_GUIDES_UNAVAILABLE");
    sendJson(res, 200, await store.getLearningState(projectIdFrom(url), decodeURIComponent(learningMatch[1])));
    return true;
  }

  const pendingMatch = /^\/api\/learning-libraries\/([^/]+)\/learning\/pending$/.exec(url.pathname);
  if (pendingMatch && req.method === "GET") {
    requireStoreCapability(store, "listLearningPending", "The learning backend is unavailable.", "LEARNING_GUIDES_UNAVAILABLE");
    sendJson(res, 200, {
      pending: await store.listLearningPending(projectIdFrom(url), decodeURIComponent(pendingMatch[1])),
    });
    return true;
  }

  const notesMatch = /^\/api\/learning-libraries\/([^/]+)\/learning\/notes$/.exec(url.pathname);
  if (notesMatch && req.method === "GET") {
    requireStoreCapability(store, "listLearningNotes", "The learning backend is unavailable.", "LEARNING_GUIDES_UNAVAILABLE");
    const libraryId = decodeURIComponent(notesMatch[1]);
    sendJson(res, 200, {
      notes: await store.listLearningNotes(projectIdFrom(url), libraryId),
      context: await store.getLearningNotesContext(projectIdFrom(url), libraryId),
    });
    return true;
  }

  // ── POST create run ──
  const runsMatch = /^\/api\/learning-libraries\/([^/]+)\/runs$/.exec(url.pathname);
  if (runsMatch && req.method === "POST") {
    requireStoreCapability(store, "createLearningRun", "The learning backend is unavailable.", "LEARNING_GUIDES_UNAVAILABLE");
    const libraryId = decodeURIComponent(runsMatch[1]);
    const body = await readJson(req);
    requireStringField(body, "projectId", { optional: true, maxLength: 200 });
    requireArrayField(body, "assetIds", { optional: true, of: "string", maxLength: 100000 });
    requireStringField(body, "serviceId", { optional: true, maxLength: 200 });
    requireStringField(body, "analysisModel", { optional: true, maxLength: 200 });
    requireStringField(body, "summaryModel", { optional: true, maxLength: 200 });
    requireStringField(body, "language", { optional: true, maxLength: 40 });
    requireNumberField(body, "estimateUsd", { optional: true, min: 0 });
    requireNumberField(body, "capUsd", { optional: true, min: 0 });
    sendJson(res, 201, {
      run: await store.createLearningRun({
        projectId: projectIdFrom(url, body),
        libraryId,
        assetIds: body.assetIds,
        serviceId: body.serviceId,
        analysisModel: body.analysisModel,
        summaryModel: body.summaryModel,
        language: body.language,
        estimateUsd: body.estimateUsd === undefined ? null : body.estimateUsd,
        capUsd: body.capUsd === undefined ? null : body.capUsd,
      }),
    });
    return true;
  }

  // ── GET run + counts ──
  const runMatch = /^\/api\/learning-runs\/([^/]+)$/.exec(url.pathname);
  if (runMatch && req.method === "GET") {
    requireStoreCapability(store, "getLearningRun", "The learning backend is unavailable.", "LEARNING_GUIDES_UNAVAILABLE");
    sendJson(res, 200, {
      run: await store.getLearningRun(projectIdFrom(url), decodeURIComponent(runMatch[1])),
    });
    return true;
  }

  // ── PATCH run transition ──
  if (runMatch && req.method === "PATCH") {
    requireStoreCapability(store, "transitionLearningRun", "The learning backend is unavailable.", "LEARNING_GUIDES_UNAVAILABLE");
    const body = await readJson(req);
    requireStringField(body, "projectId", { optional: true, maxLength: 200 });
    requireStringField(body, "to");
    requireStringField(body, "reason", { optional: true, maxLength: 60 });
    requireNumberField(body, "estimateUsd", { optional: true, min: 0 });
    requireNumberField(body, "capUsd", { optional: true, min: 0 });
    sendJson(res, 200, {
      run: await store.transitionLearningRun({
        projectId: projectIdFrom(url, body),
        runId: decodeURIComponent(runMatch[1]),
        to: body.to,
        reason: body.reason,
        estimateUsd: body.estimateUsd,
        capUsd: body.capUsd,
      }),
    });
    return true;
  }

  // ── GET analysis input (image + metadata) ──
  const inputMatch = /^\/api\/learning-runs\/([^/]+)\/items\/([^/]+)\/input$/.exec(url.pathname);
  if (inputMatch && req.method === "GET") {
    requireStoreCapability(store, "getLearningAnalysisInput", "The learning backend is unavailable.", "LEARNING_GUIDES_UNAVAILABLE");
    sendJson(res, 200, await store.getLearningAnalysisInput(
      projectIdFrom(url),
      decodeURIComponent(inputMatch[1]),
      decodeURIComponent(inputMatch[2]),
    ));
    return true;
  }

  // ── POST one item's result ──
  const resultMatch = /^\/api\/learning-runs\/([^/]+)\/items\/([^/]+)\/result$/.exec(url.pathname);
  if (resultMatch && req.method === "POST") {
    requireStoreCapability(store, "recordLearningItemResult", "The learning backend is unavailable.", "LEARNING_GUIDES_UNAVAILABLE");
    const body = await readJson(req);
    requireStringField(body, "projectId", { optional: true, maxLength: 200 });
    requireStringField(body, "status");
    requireStringField(body, "fingerprint", { optional: true, maxLength: 128 });
    requireStringField(body, "errorCode", { optional: true, maxLength: 60 });
    requireStringField(body, "serviceId", { optional: true, maxLength: 200 });
    requireStringField(body, "model", { optional: true, maxLength: 200 });
    requireNumberField(body, "inputTokens", { optional: true, min: 0, integer: true });
    requireNumberField(body, "outputTokens", { optional: true, min: 0, integer: true });
    requireNumberField(body, "costUsd", { optional: true, min: 0 });
    sendJson(res, 200, {
      run: await store.recordLearningItemResult({
        projectId: projectIdFrom(url, body),
        runId: decodeURIComponent(resultMatch[1]),
        assetId: decodeURIComponent(resultMatch[2]),
        status: body.status,
        fingerprint: body.fingerprint,
        errorCode: body.errorCode,
        note: body.note === undefined ? null : body.note,
        serviceId: body.serviceId,
        model: body.model,
        inputTokens: body.inputTokens ?? 0,
        outputTokens: body.outputTokens ?? 0,
        costUsd: body.costUsd ?? 0,
      }),
    });
    return true;
  }

  // ── POST apply the summarized guide ──
  const guideMatch = /^\/api\/learning-runs\/([^/]+)\/guide$/.exec(url.pathname);
  if (guideMatch && req.method === "POST") {
    requireStoreCapability(store, "applyGeneratedGuide", "The learning backend is unavailable.", "LEARNING_GUIDES_UNAVAILABLE");
    const body = await readJson(req);
    requireStringField(body, "projectId", { optional: true, maxLength: 200 });
    requireArrayField(body, "entries", { optional: true, maxLength: 200 });
    requireStringField(body, "language", { optional: true, maxLength: 40 });
    requireNumberField(body, "inputTokens", { optional: true, min: 0, integer: true });
    requireNumberField(body, "outputTokens", { optional: true, min: 0, integer: true });
    requireNumberField(body, "costUsd", { optional: true, min: 0 });
    requireNumberField(body, "droppedNoSource", { optional: true, min: 0, integer: true });
    const runId = decodeURIComponent(guideMatch[1]);
    const projectId = projectIdFrom(url, body);
    const guide = await store.applyGeneratedGuide({
      projectId,
      runId,
      entries: body.entries,
      language: body.language,
      inputTokens: body.inputTokens ?? 0,
      outputTokens: body.outputTokens ?? 0,
      costUsd: body.costUsd ?? 0,
      droppedNoSource: body.droppedNoSource ?? 0,
    });
    // runner 读这里的 run（done 后的最终计数）。
    sendJson(res, 200, {
      guide,
      run: await store.getLearningRun(projectId, runId),
    });
    return true;
  }

  // ── POST revert one run's guide changes ──
  const revertMatch = /^\/api\/learning-runs\/([^/]+)\/revert$/.exec(url.pathname);
  if (revertMatch && req.method === "POST") {
    requireStoreCapability(store, "revertLearningRun", "The learning backend is unavailable.", "LEARNING_GUIDES_UNAVAILABLE");
    const body = await readJson(req);
    requireStringField(body, "projectId", { optional: true, maxLength: 200 });
    sendJson(res, 200, await store.revertLearningRun(projectIdFrom(url, body), decodeURIComponent(revertMatch[1])));
    return true;
  }

  // ── Manual guide edits (464) ──
  const entriesMatch = /^\/api\/learning-libraries\/([^/]+)\/guide\/entries$/.exec(url.pathname);
  if (entriesMatch && req.method === "POST") {
    requireStoreCapability(store, "addGuideEntry", "The learning backend is unavailable.", "LEARNING_GUIDES_UNAVAILABLE");
    const libraryId = decodeURIComponent(entriesMatch[1]);
    const body = await readJson(req);
    requireStringField(body, "projectId", { optional: true, maxLength: 200 });
    requireNumberField(body, "baseRevision", { min: 0, integer: true });
    requireStringField(body, "section");
    requireStringField(body, "text", { maxLength: 400 });
    sendJson(res, 201, {
      entry: await store.addGuideEntry({
        projectId: projectIdFrom(url, body),
        libraryId,
        baseRevision: body.baseRevision,
        section: body.section,
        text: body.text,
        swatches: body.swatches,
      }),
    });
    return true;
  }

  const entryMatch = /^\/api\/learning-libraries\/([^/]+)\/guide\/entries\/([^/]+)$/.exec(url.pathname);
  if (entryMatch && (req.method === "PATCH" || req.method === "DELETE")) {
    const libraryId = decodeURIComponent(entryMatch[1]);
    const entryId = decodeURIComponent(entryMatch[2]);
    const body = await readJson(req);
    requireStringField(body, "projectId", { optional: true, maxLength: 200 });
    requireNumberField(body, "baseRevision", { min: 0, integer: true });
    if (req.method === "PATCH") {
      requireStoreCapability(store, "updateGuideEntry", "The learning backend is unavailable.", "LEARNING_GUIDES_UNAVAILABLE");
      requireStringField(body, "text", { optional: true, maxLength: 400 });
      requireBooleanField(body, "locked", { optional: true });
      sendJson(res, 200, {
        entry: await store.updateGuideEntry({
          projectId: projectIdFrom(url, body),
          libraryId,
          entryId,
          baseRevision: body.baseRevision,
          text: body.text,
          swatches: body.swatches,
          locked: body.locked,
        }),
      });
      return true;
    }
    requireStoreCapability(store, "deleteGuideEntry", "The learning backend is unavailable.", "LEARNING_GUIDES_UNAVAILABLE");
    sendJson(res, 200, {
      entry: await store.deleteGuideEntry({
        projectId: projectIdFrom(url, body),
        libraryId,
        entryId,
        baseRevision: body.baseRevision,
      }),
    });
    return true;
  }

  return false;
}
