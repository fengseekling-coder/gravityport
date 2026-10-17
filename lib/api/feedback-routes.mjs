// Feedback routes (task 158): GET /api/feedback/diagnostics serves the
// redacted ring-buffer preview for the settings panel; POST /api/feedback/submit
// validates locally, re-redacts the user-seen diagnostics, and forwards one
// request to the collection service. The local log records only the outcome
// status — never content, contact, or the diagnostics text.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { arch, homedir, release } from "node:os";
import { getDiagnosticLogText, redactDiagnostics } from "../diagnostic-log.mjs";
import { getFeedbackCollectUrl, getFeedbackTimeoutMs } from "../feedback/config.mjs";
import { readJson, sendJson } from "../http-response.mjs";

const LOCAL_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const MAX_DIAGNOSTICS_CHARS = 200000;
const OUTBOUND_BODY_LIMIT_BYTES = 300 * 1024;
const KINDS = new Set(["bug", "idea", "other"]);
const LOCALES = new Set(["zh", "en"]);

const packageVersion = (() => {
  try {
    const parsed = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    return typeof parsed.version === "string" ? parsed.version : "";
  } catch {
    return "";
  }
})();

export async function handleFeedbackRoute({ req, res, url, context }) {
  if (!url.pathname.startsWith("/api/feedback/")) return false;

  if (req.method === "GET" && url.pathname === "/api/feedback/diagnostics") {
    const text = redactDiagnostics(getDiagnosticLogText(), {
      homeDir: homedir(),
      libraryDir: context.libraryDir,
    });
    sendJson(res, 200, {
      app: feedbackAppInfo(context.buildIdentity),
      diagnostics: {
        text,
        lines: text ? text.split("\n").length : 0,
        bytes: Buffer.byteLength(text, "utf8"),
      },
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/feedback/submit") {
    const body = await readJson(req, LOCAL_BODY_LIMIT_BYTES);
    const kind = body.kind;
    if (typeof kind !== "string" || !KINDS.has(kind)) {
      sendJson(res, 400, { code: "FEEDBACK_INVALID", field: "kind" });
      return true;
    }
    if (typeof body.message !== "string") {
      sendJson(res, 400, { code: "FEEDBACK_INVALID", field: "message" });
      return true;
    }
    const message = body.message.trim();
    if (message.length < 1 || message.length > 5000) {
      sendJson(res, 400, { code: "FEEDBACK_INVALID", field: "message" });
      return true;
    }
    const contact = typeof body.contact === "string" ? body.contact.trim() : "";
    if (contact.length > 200) {
      sendJson(res, 400, { code: "FEEDBACK_INVALID", field: "contact" });
      return true;
    }
    if (typeof body.locale !== "string" || !LOCALES.has(body.locale)) {
      sendJson(res, 400, { code: "FEEDBACK_INVALID", field: "locale" });
      return true;
    }
    if (body.diagnostics !== undefined && body.diagnostics !== null && typeof body.diagnostics !== "string") {
      sendJson(res, 400, { code: "FEEDBACK_INVALID", field: "diagnostics" });
      return true;
    }
    // The panel preview already went through redaction; the forwarded copy is
    // redacted again here because the request body is never trusted.
    const diagnostics = typeof body.diagnostics === "string" && body.diagnostics
      ? redactDiagnostics(body.diagnostics.slice(0, MAX_DIAGNOSTICS_CHARS), {
        homeDir: homedir(),
        libraryDir: context.libraryDir,
      })
      : "";

    const payload = {
      schema: 1,
      kind,
      message,
      locale: body.locale,
      app: feedbackAppInfo(context.buildIdentity),
    };
    if (contact) payload.contact = contact.slice(0, 200);
    if (diagnostics) payload.diagnostics = diagnostics;
    const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
    if (payloadBytes.byteLength > OUTBOUND_BODY_LIMIT_BYTES) {
      sendJson(res, 413, { code: "FEEDBACK_TOO_LARGE" });
      return true;
    }

    const forward = await forwardToCollector(payloadBytes);
    // The local log line carries only the outcome status, never the content.
    console.info(`[MOSA] 反馈发送结果：${forward.status}`);
    if (forward.status === 200) {
      sendJson(res, 200, { ok: true, id: forward.id });
    } else if (forward.status === 400) {
      sendJson(res, 400, { code: "FEEDBACK_INVALID" });
    } else if (forward.status === 413) {
      sendJson(res, 413, { code: "FEEDBACK_TOO_LARGE" });
    } else if (forward.status === 429) {
      sendJson(res, 429, { code: "FEEDBACK_RATE_LIMITED" });
    } else if (forward.status === 503) {
      sendJson(res, 503, { code: "FEEDBACK_UNAVAILABLE" });
    } else {
      sendJson(res, 502, { code: forward.offline ? "FEEDBACK_OFFLINE" : "FEEDBACK_UPSTREAM" });
    }
    return true;
  }

  return false;
}

async function forwardToCollector(payloadBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Feedback forward timed out.")), getFeedbackTimeoutMs());
  timer.unref?.();
  try {
    const response = await fetch(getFeedbackCollectUrl(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gravityport-client": "desktop",
      },
      body: payloadBytes,
      signal: controller.signal,
    });
    if (response.status === 201) {
      const data = await response.json().catch(() => ({}));
      return { status: 200, offline: false, id: typeof data?.id === "string" ? data.id : "" };
    }
    if (response.status === 400 || response.status === 413 || response.status === 429 || response.status === 503) {
      return { status: response.status, offline: false, id: "" };
    }
    return { status: 502, offline: false, id: "" };
  } catch {
    // Network failure and the 15-second timeout both land here.
    return { status: 502, offline: true, id: "" };
  } finally {
    clearTimeout(timer);
  }
}

function feedbackAppInfo(buildIdentity) {
  const gitSha = typeof buildIdentity?.gitSha === "string" && buildIdentity.gitSha && buildIdentity.gitSha !== "unknown"
    ? buildIdentity.gitSha.slice(0, 40)
    : "";
  const app = {
    product: "GravityPort",
    version: packageVersion.slice(0, 32),
    platform: platformName(),
    osVersion: osVersion().slice(0, 64),
    arch: arch().slice(0, 16),
  };
  if (gitSha) app.gitSha = gitSha;
  return app;
}

// os.release() on macOS is the Darwin kernel number (e.g. 25.x for macOS 26),
// which reads as a wrong macOS version; ask sw_vers once and fall back.
let cachedOsVersion = "";
function osVersion() {
  if (cachedOsVersion) return cachedOsVersion;
  cachedOsVersion = release();
  if (process.platform === "darwin") {
    try {
      const productVersion = execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8", timeout: 2000 }).trim();
      if (/^\d+(\.\d+)*$/.test(productVersion)) cachedOsVersion = productVersion;
    } catch {
      // Keep the kernel release; it still identifies the system.
    }
  }
  return cachedOsVersion;
}

function platformName() {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "other";
}
