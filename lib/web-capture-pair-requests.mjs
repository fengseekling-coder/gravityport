// Task 333 — Web Capture pairing requests. Pairing used to hand the static
// token to any request that carried an allowlisted extension Origin, which any
// local program could forge. Now a POST /api/web-capture/pair creates a
// pending request that the user must approve in the App; the extension polls
// GET /api/web-capture/pair/<id> until the decision lands.
//
// The table lives in the runtime process's memory and is never persisted:
// a pending pairing is a 120-second window, not state. The macOS background
// capture process (desktop/background-runtime-entry.mjs) has no window, so a
// request may land there — the App reaches the same table over HTTP either
// way, which is why the UI routes (GET /api/web-capture/pair-requests and the
// decision POST) are plain client-authenticated API routes in bridge-routes.
import { randomBytes } from "node:crypto";

// The two official extension identities. Mirrored from
// desktop/web-capture-pairing.mjs (lib cannot import desktop); both copies are
// pinned against each other by test/web-capture-pair-requests.test.mjs.
export const WEB_CAPTURE_KNOWN_EXTENSION_ORIGINS = Object.freeze([
  "chrome-extension://hjcildpmialbefmcdpdooenlojecjpli",
  "chrome-extension://bhjibabaiccjjfcdbimeeaoaikhcfncc",
]);

export function webCaptureExtensionIdFromOrigin(origin) {
  const text = String(origin || "");
  const separator = text.indexOf("://");
  return separator >= 0 ? text.slice(separator + 3) : text;
}

export function createWebCapturePairRequests(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const getToken = typeof options.getToken === "function" ? options.getToken : () => "";
  const onChange = typeof options.onChange === "function" ? options.onChange : () => {};
  const knownExtensionOrigins = new Set(options.knownExtensionOrigins || WEB_CAPTURE_KNOWN_EXTENSION_ORIGINS);
  const pendingTtlMs = Number.isFinite(options.pendingTtlMs) ? options.pendingTtlMs : 120_000;
  const denyCooldownMs = Number.isFinite(options.denyCooldownMs) ? options.denyCooldownMs : 60_000;
  const approvalTtlMs = Number.isFinite(options.approvalTtlMs) ? options.approvalTtlMs : 5 * 60_000;
  const maxPending = Number.isFinite(options.maxPending) ? options.maxPending : 5;
  // Decided and expired rows survive one extra TTL so a poll that arrives just
  // after the deadline still sees "expired"/"denied" instead of a surprising
  // 404; only delivered approvals are dropped at once.
  const rowGraceMs = pendingTtlMs;

  let requests = new Map();
  // origin → { expiresAt, used }: the one-shot approval granted by decide().
  // An old extension never polls; its next POST /pair within the window
  // collects the token through this path.
  let approvals = new Map();
  // origin → deniedAt(ms): a recently denied origin must not re-create a
  // request, or a retrying extension would reopen the dialog forever.
  let denials = new Map();

  function sweep() {
    const current = now();
    for (const [id, row] of requests) {
      if (row.status !== "pending") continue;
      if (row.expiresAt > current) continue;
      row.status = "expired";
      onChange("expired");
    }
    for (const [id, row] of requests) {
      const deadline = Math.max(row.expiresAt, row.decidedAt || 0) + rowGraceMs;
      if (deadline > current) continue;
      requests.delete(id);
    }
  }

  function pendingCount() {
    let count = 0;
    for (const row of requests.values()) if (row.status === "pending") count += 1;
    return count;
  }

  function findByOrigin(origin) {
    for (const row of requests.values()) {
      if (row.origin === origin && row.status === "pending") return row;
    }
    return null;
  }

  // A POST /pair from one extension origin. `origin` has already passed the
  // runtime's approved-extension gate; extensionVersion is pre-validated.
  function request({ origin, extensionVersion }) {
    sweep();
    const current = now();
    const approval = approvals.get(origin);
    if (approval && !approval.used && approval.expiresAt > current) {
      approval.used = true;
      const token = String(getToken() || "");
      if (token) return { status: "approved", token };
    }

    if (denials.has(origin) && current - denials.get(origin) < denyCooldownMs) {
      return { status: "denied" };
    }

    const existing = findByOrigin(origin);
    if (existing) {
      return { status: "pending", requestId: existing.id, expiresInMs: Math.max(0, existing.expiresAt - current) };
    }

    if (pendingCount() >= maxPending) return { status: "busy" };

    const id = randomBytes(32).toString("base64url");
    requests.set(id, {
      id,
      origin: String(origin || ""),
      extensionVersion: String(extensionVersion || ""),
      status: "pending",
      createdAt: current,
      expiresAt: current + pendingTtlMs,
      decidedAt: 0,
      delivered: false,
    });
    onChange("created");
    return { status: "pending", requestId: id, expiresInMs: pendingTtlMs };
  }

  // A GET /pair/<id> poll. `origin` must match the creating origin, so one
  // extension cannot read another's decision. The token is returned exactly
  // once; afterwards the id is gone (a later poll 404s).
  function poll(id, origin) {
    sweep();
    const row = requests.get(String(id || ""));
    if (!row || row.origin !== String(origin || "")) return null;
    if (row.status === "approved") {
      if (row.delivered) return null;
      const token = String(getToken() || "");
      if (!token) return { status: "expired" };
      row.delivered = true;
      requests.delete(row.id);
      return { status: "approved", token };
    }
    return { status: row.status };
  }

  // Pending rows only — the UI must never see the token or the raw origin.
  function list() {
    sweep();
    const rows = [];
    for (const row of requests.values()) {
      if (row.status !== "pending") continue;
      rows.push({
        id: row.id,
        extensionId: webCaptureExtensionIdFromOrigin(row.origin),
        extensionVersion: row.extensionVersion,
        knownExtension: knownExtensionOrigins.has(row.origin),
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      });
    }
    rows.sort((left, right) => left.createdAt - right.createdAt || (left.id < right.id ? -1 : 1));
    return rows;
  }

  // The App's decision. Unknown or already-decided ids answer null (404).
  function decide(id, allow) {
    sweep();
    const row = requests.get(String(id || ""));
    if (!row || row.status !== "pending") return null;
    row.decidedAt = now();
    if (allow === true) {
      row.status = "approved";
      approvals.set(row.origin, { expiresAt: row.decidedAt + approvalTtlMs, used: false });
    } else {
      row.status = "denied";
      denials.set(row.origin, row.decidedAt);
    }
    onChange("decided");
    return { ok: true, status: row.status };
  }

  return { request, poll, list, decide };
}
