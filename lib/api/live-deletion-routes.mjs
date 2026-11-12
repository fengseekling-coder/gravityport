// Task 385 — the App-UI side of the live deletion protocol. Three routes,
// client-token gated by the runtime like every other non-public API path
// (the same bar as 333's GET /api/web-capture/pair-requests): the viewer
// reports what it shows, the UI polls the pending confirmation queue, and the
// UI delivers the user's decision. The heavy lifting lives in
// lib/live-deletion-requests.mjs (files) and the runtime's context.liveDeletion
// (the jimeng decision processing).
import { HttpError, readJson, sendJson } from "../http-response.mjs";

const DECISION_RESULT_TO_STATUS = { allow: "allowed", deny: "denied", timeout: "timeout" };
const DECISION_PATTERN = /^\/api\/live-deletion-requests\/([A-Za-z0-9_-]+)\/decision$/;

export async function handleLiveDeletionRoute({ req, res, url, context }) {
  const requests = context?.liveDeletionRequests;
  if (!requests) return false;

  if (req.method === "POST" && url.pathname === "/api/viewer-presence") {
    const body = await readJson(req, 4 * 1024);
    const projectId = body?.projectId;
    const assetId = body?.assetId;
    if (assetId === null) {
      // The viewer closed: drop this process's record only.
      const cleared = await requests.clearViewer();
      sendJson(res, 200, { ok: true, cleared });
      return true;
    }
    if (typeof assetId !== "string" || !assetId.trim()) {
      throw new HttpError(400, "VIEWER_PRESENCE_INVALID", "viewer-presence needs { projectId, assetId } with a string assetId, or assetId: null.");
    }
    await requests.writeViewer({
      projectId: typeof projectId === "string" && projectId.trim() ? projectId.trim() : "default",
      assetId: assetId.trim(),
    });
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/live-deletion-requests") {
    // Pending and still inside their window, oldest first. `now` is the
    // service's clock so the countdown is computed against one authoritative
    // value, not the client's.
    sendJson(res, 200, { requests: await requests.listPendingRequests(), now: Date.now() });
    return true;
  }

  const decisionMatch = req.method === "POST" ? DECISION_PATTERN.exec(url.pathname) : null;
  if (decisionMatch) {
    const body = await readJson(req, 1024);
    const result = String(body?.result || "");
    if (!(result in DECISION_RESULT_TO_STATUS)) {
      sendJson(res, 400, { error: "The decision body must be { result: \"allow\" | \"deny\" | \"timeout\" }.", code: "LIVE_DELETION_DECISION_INVALID" });
      return true;
    }
    const decided = await context.liveDeletion.decide(decisionMatch[1], result);
    // An expired request is written as a timeout and answered 409 so the UI
    // shows the same "no answer in time" toast it would for its own countdown.
    if (decided.httpStatus === 409) {
      sendJson(res, 409, { ok: false, status: "timeout", code: "LIVE_DELETION_REQUEST_EXPIRED" });
      return true;
    }
    if (decided.httpStatus === 404) {
      sendJson(res, 404, { error: "Unknown live deletion request.", code: "LIVE_DELETION_REQUEST_UNKNOWN" });
      return true;
    }
    sendJson(res, 200, { ok: true, status: decided.status, changed: decided.changed });
    return true;
  }

  return false;
}
