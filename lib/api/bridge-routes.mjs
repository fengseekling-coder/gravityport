import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { HttpError, readBytes, readJson, sendJson } from "../http-response.mjs";
import { inspectTrustedExternalCanvas } from "../cowart-canvas-discovery.js";
import { generationSessionKey } from "../generation-session.mjs";
import {
  extractBearerToken,
  WEB_CAPTURE_MAX_BODY_BYTES,
  WEB_CAPTURE_MAX_IMAGE_BYTES,
  WEB_CAPTURE_MAX_VIDEO_BYTES,
} from "../web-capture-ingest.js";
import { getBuildIdentity } from "../build-identity.mjs";
import { isMosaServiceIdentityNonce, mosaServiceIdentityProof } from "../server-security.js";
import { applyProviderDeletions, readProviderDeletionSettings, writeProviderDeletionSettings } from "../provider-deletion-sync.mjs";
import { MCP_SERVER_VERSION, MOSA_SERVICE_PROTOCOL_VERSION } from "../version-identities.mjs";

// Shared trust bar with the registry and the bridge manager: the canvas must
// be a real, non-symlink direct child of the project holding a Cowart marker.
const COWART_TRUST_FAILURE_CODES = {
  "project-missing": "COWART_CANVAS_DIR_MISSING",
  "project-not-directory": "COWART_CANVAS_DIR_MISSING",
  "canvas-missing": "COWART_CANVAS_DIR_MISSING",
  "canvas-not-directory": "COWART_CANVAS_DIR_MISSING",
  "canvas-symlink": "COWART_CANVAS_SYMLINK",
  "canvas-outside-project": "COWART_CANVAS_OUTSIDE_PROJECT",
  "canvas-no-markers": "COWART_CANVAS_NO_MARKERS",
};
const WEB_CAPTURE_BINARY_META_BYTES = 256 * 1024;
const WEB_CAPTURE_UPLOAD_TTL_MS = 10 * 60 * 1000;
const WEB_CAPTURE_UPLOAD_MAX_SESSIONS = 8;
const WEB_CAPTURE_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const WEB_CAPTURE_UPLOAD_VIDEO_EXT = new Map([
  ["video/mp4", ".mp4"],
  ["video/webm", ".webm"],
  ["video/quicktime", ".mov"],
  ["video/x-m4v", ".m4v"],
]);
const webCaptureUploads = new Map();

async function withUploadLock(upload, action) {
  const previous = upload.operation || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  upload.operation = current;
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (upload.operation === current) delete upload.operation;
  }
}

const WEB_CAPTURE_API_PATHS = new Set([
  "/api/web-capture",
  "/api/web-capture/pair",
  "/api/ingest/web-capture",
  "/api/ingest/web-capture-metadata",
  "/api/ingest/web-capture-binary",
  "/api/ingest/web-capture-status",
  "/api/ingest/web-capture-session-title",
  "/api/ingest/web-capture-turn-bindings",
  "/api/ingest/web-capture-desktop-sync",
  "/api/ingest/web-capture-provider-deletions",
]);

export function isWebCaptureApiPath(pathname) {
  const path = String(pathname || "");
  return WEB_CAPTURE_API_PATHS.has(path) || path.startsWith("/api/ingest/web-capture-upload/");
}

async function pruneWebCaptureUploads(now = Date.now()) {
  for (const [id, upload] of webCaptureUploads) {
    if (upload.expiresAt > now) continue;
    if (upload.operation) continue;
    webCaptureUploads.delete(id);
    await rm(upload.path, { force: true }).catch(() => {});
  }
}

export async function handleBridgeRoute({ req, res, url, context }) {
  const {
    libraryDir,
    store,
    cowartBridge,
    codexBridge,
    chatgptDesktopSync,
    grokBridge,
    webCaptureIngest,
    cowartCanvasDiscovery,
    derivativeWorker,
  } = context;

  if (req.method === "GET" && url.pathname === "/api/health") {
    const identity = context.buildIdentity || getBuildIdentity(context.appDir);
    sendJson(res, 200, {
      product: "mosa",
      libraryDir,
      storage: store?.storageKind || "json",
      serviceProtocolVersion: MOSA_SERVICE_PROTOCOL_VERSION,
      productVersion: identity.productVersion,
      mcpServerVersion: MCP_SERVER_VERSION,
      gitSha: identity.gitSha,
      uiFingerprint: identity.uiFingerprint,
      runtimeFingerprint: identity.runtimeFingerprint,
      distribution: identity.distribution,
      clientAuthFingerprint: context.clientAuthFingerprint || "unknown",
    });
    return true;
  }

  // Desktop service-identity challenge (task 311). Deliberately unauthenticated:
  // the caller has not yet confirmed this service's identity, so it holds no
  // capability to present. The proof only demonstrates possession of the client
  // token and binds the actually-bound port; the response carries no credential,
  // fingerprint, or library path. The global Host/Origin checks above already
  // reject every web-page origin, and the runtime exempts this route from the
  // client-token gate because the desktop asks before it can trust anything.
  if (req.method === "POST" && url.pathname === "/api/service-identity") {
    if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
      throw new HttpError(415, "SERVICE_IDENTITY_CONTENT_TYPE", "Service identity challenge expects application/json.");
    }
    const body = await readJson(req, 1024);
    const nonce = body?.nonce;
    if (!isMosaServiceIdentityNonce(nonce)) {
      throw new HttpError(400, "SERVICE_IDENTITY_NONCE_INVALID", "Invalid service identity nonce.");
    }
    const proof = mosaServiceIdentityProof(context.clientToken, { port: context.port, nonce });
    if (!proof) {
      throw new HttpError(503, "SERVICE_IDENTITY_UNAVAILABLE", "Service identity is unavailable for this runtime.");
    }
    sendJson(res, 200, { proof, serviceProtocolVersion: MOSA_SERVICE_PROTOCOL_VERSION });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/web-capture") {
    sendJson(res, 200, { bridge: webCaptureIngest.status() });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/web-capture/retry") {
    sendJson(res, 202, webCaptureIngest.requestRetry());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/web-capture/pair") {
    const status = webCaptureIngest.status();
    const token = String(webCaptureIngest.token || "").trim();
    if (!status.enabled || !token) {
      sendJson(res, 503, {
        error: "Web capture pairing is unavailable for this GravityPort runtime.",
        code: "WEB_CAPTURE_PAIRING_UNAVAILABLE",
      });
      return true;
    }
    // The runtime layer has already restricted this route to explicitly
    // allowlisted extension origins. Desktop opts into silent local pairing;
    // source/headless runtimes stay disabled unless their owner opts in.
    if (context?.webCapturePairingEnabled !== true) {
      sendJson(res, 503, {
        error: "Web capture pairing is disabled for this GravityPort runtime.",
        code: "WEB_CAPTURE_PAIRING_DISABLED",
      });
      return true;
    }
    sendJson(res, 200, { product: "mosa", token });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/ingest/web-capture") {
    const authToken = extractBearerToken(req);
    webCaptureIngest.assertToken(authToken);
    // Base64 images need a larger body budget than ordinary JSON metadata posts.
    const body = await readJson(req, WEB_CAPTURE_MAX_BODY_BYTES);
    const result = await webCaptureIngest.ingest(body, authToken);
    if (result.status === "imported" && result.asset) derivativeWorker.wake();
    sendJson(res, result.status === "imported" ? 201 : 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/ingest/web-capture-metadata") {
    const authToken = extractBearerToken(req);
    webCaptureIngest.assertToken(authToken);
    const body = await readJson(req, WEB_CAPTURE_BINARY_META_BYTES);
    const result = await webCaptureIngest.upgradeMetadata(body, authToken);
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/ingest/web-capture-status") {
    const authToken = extractBearerToken(req);
    webCaptureIngest.assertToken(authToken);
    const body = await readJson(req, 64 * 1024);
    const status = webCaptureIngest.updateClientStatus(body, authToken);
    // Only an extension that announces it can open desktop conversations (and
    // has auto capture on) is handed any; older extensions never lease one.
    const chatgptDesktopConversations = body?.desktopSync === true && chatgptDesktopSync
      ? chatgptDesktopSync.claimPending()
      : [];
    sendJson(res, 200, { ...status, chatgptDesktopConversations });
    return true;
  }

  // The capture plugin reports how a handed-out ChatGPT desktop conversation
  // went (captured, no images, failed, timed out) so it is not handed out again.
  if (req.method === "POST" && url.pathname === "/api/ingest/web-capture-desktop-sync") {
    const authToken = extractBearerToken(req);
    webCaptureIngest.assertToken(authToken);
    const body = await readJson(req, 4 * 1024);
    const result = chatgptDesktopSync
      ? chatgptDesktopSync.acknowledge(String(body?.conversationId || ""), String(body?.outcome || ""))
      : { ok: false };
    sendJson(res, result.ok ? 200 : 400, result);
    return true;
  }

  // The capture plugin reports a conversation title for stack naming when an
  // (old) conversation is reopened. Same trust bar as web-capture-status; the
  // session identity follows the shared generation-session convention, so a
  // malformed conversation id is a client bug (400), not a silent no-op.
  if (req.method === "POST" && url.pathname === "/api/ingest/web-capture-session-title") {
    const authToken = extractBearerToken(req);
    webCaptureIngest.assertToken(authToken);
    const body = await readJson(req, 16 * 1024);
    const provider = String(body?.provider || "").trim().toLowerCase();
    const conversationId = String(body?.conversationId || "").trim();
    const sessionKey = provider === "chatgpt"
      ? generationSessionKey({ source: { type: "web-chatgpt", conversation_id: conversationId } })
      : "";
    if (!sessionKey) {
      throw new HttpError(400, "WEB_CAPTURE_SESSION_TITLE_INVALID", "Invalid web capture session title request.");
    }
    if (typeof store?.applySessionTitle !== "function") {
      throw new HttpError(501, "SESSION_TITLES_UNAVAILABLE", "Session titles need the SQLite asset store.");
    }
    sendJson(res, 200, await store.applySessionTitle(String(body?.projectId || ""), sessionKey, String(body?.title || "")));
    return true;
  }

  // The capture plugin reports which image file belongs to which conversation
  // turn while the user has that conversation open. Same capture-token trust
  // bar as the other /api/ingest routes; validation and write rules live
  // entirely in applyGenerationMessageBindings (shared with the MOSA-client
  // /api/generation-message-bindings endpoint, which stays client-token
  // gated for the runtime itself).
  if (req.method === "POST" && url.pathname === "/api/ingest/web-capture-turn-bindings") {
    const authToken = extractBearerToken(req);
    webCaptureIngest.assertToken(authToken);
    const body = await readJson(req, 1024 * 1024);
    if (typeof store?.applyGenerationMessageBindings !== "function") {
      throw new HttpError(501, "GENERATION_MESSAGE_BINDINGS_UNAVAILABLE", "Generation message bindings need the SQLite asset store.");
    }
    const projectId = String(body?.projectId || body?.project_id || "default");
    sendJson(res, 200, await store.applyGenerationMessageBindings({ ...body, project_id: projectId }));
    return true;
  }

  // The capture plugin reports item ids it saw the provider site delete (the
  // site's own delete request succeeded). Same capture-token trust bar as the
  // other /api/ingest routes; validation, the keep-organized-work rule and the
  // trash move live in applyProviderDeletions. Responses stay 200 so the
  // best-effort reporter can log the counters without treating kept/not-found
  // items as failures.
  if (req.method === "POST" && url.pathname === "/api/ingest/web-capture-provider-deletions") {
    const authToken = extractBearerToken(req);
    webCaptureIngest.assertToken(authToken);
    const body = await readJson(req, 64 * 1024);
    sendJson(res, 200, await applyProviderDeletions({ store, libraryDir }, body));
    return true;
  }

  // Settings → 连接: the "move provider-site deletions to the trash" switch.
  // Renderer-facing like /api/web-capture/retry (client-token gated by the
  // runtime, not in WEB_CAPTURE_API_PATHS), so the enable state is a plain
  // library-directory JSON file the ingest route above can read directly.
  if (req.method === "GET" && url.pathname === "/api/web-capture/provider-deletion-settings") {
    sendJson(res, 200, await readProviderDeletionSettings(libraryDir));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/web-capture/provider-deletion-settings") {
    const body = await readJson(req, 4 * 1024);
    sendJson(res, 200, await writeProviderDeletionSettings(libraryDir, body));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/ingest/web-capture-binary") {
    const authToken = extractBearerToken(req);
    webCaptureIngest.assertToken(authToken);
    // Binary envelope: uint32be metadata length, UTF-8 JSON metadata, then raw
    // media bytes. Videos no longer need a 4/3-size Base64 JSON representation.
    const body = await readBytes(req, WEB_CAPTURE_MAX_VIDEO_BYTES + WEB_CAPTURE_BINARY_META_BYTES + 4);
    if (body.length < 5) throw new HttpError(400, "WEB_CAPTURE_BINARY_INVALID", "Invalid web capture binary envelope.");
    const metadataBytes = body.readUInt32BE(0);
    if (metadataBytes < 2 || metadataBytes > WEB_CAPTURE_BINARY_META_BYTES || 4 + metadataBytes >= body.length) {
      throw new HttpError(400, "WEB_CAPTURE_BINARY_INVALID", "Invalid web capture metadata length.");
    }
    let metadata;
    try {
      metadata = JSON.parse(body.subarray(4, 4 + metadataBytes).toString("utf8"));
    } catch {
      throw new HttpError(400, "WEB_CAPTURE_BINARY_INVALID", "Invalid web capture metadata JSON.");
    }
    const mediaBytes = body.subarray(4 + metadataBytes);
    const mediaKind = metadata?.mediaKind === "video" ? "video" : "image";
    const maxMediaBytes = mediaKind === "video" ? WEB_CAPTURE_MAX_VIDEO_BYTES : WEB_CAPTURE_MAX_IMAGE_BYTES;
    if (mediaBytes.length > maxMediaBytes) {
      throw new HttpError(413, "WEB_CAPTURE_BINARY_TOO_LARGE", "Web capture media exceeds the supported size limit.");
    }
    const input = mediaKind === "video"
      ? { ...metadata, mediaBytes }
      : { ...metadata, imageBytes: mediaBytes };
    const result = await webCaptureIngest.ingest(input, authToken);
    if (result.status === "imported" && result.asset) derivativeWorker.wake();
    sendJson(res, result.status === "imported" ? 201 : 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/ingest/web-capture-upload/begin") {
    webCaptureIngest.assertToken(extractBearerToken(req));
    await pruneWebCaptureUploads();
    const body = await readJson(req, WEB_CAPTURE_BINARY_META_BYTES);
    const totalBytes = Number(body?.totalBytes || 0);
    const totalChunks = Number(body?.totalChunks || 0);
    const metadata = body?.metadata;
    const uploadExt = WEB_CAPTURE_UPLOAD_VIDEO_EXT.get(String(metadata?.mimeType || "").toLowerCase());
    const exactSize = Number.isInteger(totalBytes) && totalBytes > 0;
    const exactChunks = Number.isInteger(totalChunks) && totalChunks > 0;
    if (!metadata || metadata.mediaKind !== "video" || !Number.isInteger(totalBytes)
      || totalBytes < 0 || totalBytes > WEB_CAPTURE_MAX_VIDEO_BYTES
      || !Number.isInteger(totalChunks) || totalChunks < 0 || totalChunks > 64
      || exactSize !== exactChunks || (exactSize && totalBytes < 64 * 1024) || !uploadExt) {
      throw new HttpError(400, "WEB_CAPTURE_UPLOAD_INVALID", "Invalid Web Capture upload declaration.");
    }
    const uploadId = randomUUID();
    // Each session parks a temp file until commit/abort/TTL; without a cap a
    // token holder could hold unbounded temp disk hostage. Real traffic uses
    // one or two sessions at a time, so the bound is generous.
    if (webCaptureUploads.size >= WEB_CAPTURE_UPLOAD_MAX_SESSIONS) {
      throw new HttpError(429, "WEB_CAPTURE_UPLOAD_BUSY", "Too many concurrent upload sessions; retry shortly.");
    }
    await mkdir(webCaptureIngest.tempRoot, { recursive: true });
    const path = join(webCaptureIngest.tempRoot, `upload-${uploadId}${uploadExt}`);
    await writeFile(path, Buffer.alloc(0), { flag: "wx" });
    webCaptureUploads.set(uploadId, {
      path, metadata, totalBytes, totalChunks, nextIndex: 0, receivedBytes: 0,
      expiresAt: Date.now() + WEB_CAPTURE_UPLOAD_TTL_MS,
      operation: null,
    });
    sendJson(res, 201, { uploadId });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/ingest/web-capture-upload/chunk") {
    webCaptureIngest.assertToken(extractBearerToken(req));
    await pruneWebCaptureUploads();
    const uploadId = String(req.headers["x-mosa-upload-id"] || "").trim();
    const index = Number(req.headers["x-mosa-chunk-index"]);
    const upload = webCaptureUploads.get(uploadId);
    if (!upload || !Number.isInteger(index)) {
      throw new HttpError(409, "WEB_CAPTURE_UPLOAD_SEQUENCE", "Unknown upload or out-of-order chunk.");
    }
    await withUploadLock(upload, async () => {
      if (webCaptureUploads.get(uploadId) !== upload || index !== upload.nextIndex) {
        throw new HttpError(409, "WEB_CAPTURE_UPLOAD_SEQUENCE", "Unknown upload or out-of-order chunk.");
      }
      const chunk = await readBytes(req, WEB_CAPTURE_UPLOAD_CHUNK_BYTES);
      const nextBytes = upload.receivedBytes + chunk.length;
      if (!chunk.length || nextBytes > WEB_CAPTURE_MAX_VIDEO_BYTES
        || (upload.totalBytes > 0 && nextBytes > upload.totalBytes)) {
        throw new HttpError(400, "WEB_CAPTURE_UPLOAD_CHUNK_INVALID", "Invalid Web Capture upload chunk.");
      }
      await appendFile(upload.path, chunk);
      upload.receivedBytes = nextBytes;
      upload.nextIndex += 1;
      upload.expiresAt = Date.now() + WEB_CAPTURE_UPLOAD_TTL_MS;
      sendJson(res, 200, { receivedBytes: upload.receivedBytes, nextIndex: upload.nextIndex });
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/ingest/web-capture-upload/commit") {
    const authToken = extractBearerToken(req);
    webCaptureIngest.assertToken(authToken);
    await pruneWebCaptureUploads();
    const body = await readJson(req, 16 * 1024);
    const uploadId = String(body?.uploadId || "").trim();
    const upload = webCaptureUploads.get(uploadId);
    if (!upload) {
      throw new HttpError(409, "WEB_CAPTURE_UPLOAD_INCOMPLETE", "Web Capture upload is incomplete.");
    }
    await withUploadLock(upload, async () => {
      const exactUploadComplete = upload.totalBytes > 0
        ? upload.receivedBytes === upload.totalBytes && upload.nextIndex === upload.totalChunks
        : upload.receivedBytes >= 64 * 1024 && upload.receivedBytes <= WEB_CAPTURE_MAX_VIDEO_BYTES;
      if (webCaptureUploads.get(uploadId) !== upload || !exactUploadComplete) {
        throw new HttpError(409, "WEB_CAPTURE_UPLOAD_INCOMPLETE", "Web Capture upload is incomplete.");
      }
      webCaptureUploads.delete(uploadId);
      const result = await webCaptureIngest.ingestFile(upload.metadata, upload.path, authToken);
      if (result.status === "imported" && result.asset) derivativeWorker.wake();
      sendJson(res, result.status === "imported" ? 201 : 200, result);
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/ingest/web-capture-upload/abort") {
    webCaptureIngest.assertToken(extractBearerToken(req));
    const body = await readJson(req, 16 * 1024);
    const uploadId = String(body?.uploadId || "").trim();
    const upload = webCaptureUploads.get(uploadId);
    if (upload) {
      await withUploadLock(upload, async () => {
        if (webCaptureUploads.get(uploadId) !== upload) return;
        webCaptureUploads.delete(uploadId);
        await rm(upload.path, { force: true }).catch(() => {});
      });
    }
    sendJson(res, 200, { aborted: Boolean(upload) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/bridges") {
    sendJson(res, 200, {
      codex: codexBridge.status(),
      grok: grokBridge.status(),
      webCapture: webCaptureIngest.status(),
      cowart: cowartBridge.status(),
      cowartDiscovery: cowartCanvasDiscovery.status(),
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/cowart-canvases") {
    await cowartCanvasDiscovery.reconcile();
    sendJson(res, 200, { canvases: cowartBridge.sources() });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/cowart-canvases") {
    const body = await readJson(req);
    const rawPath = String(body.projectDir || "").trim();
    if (!rawPath) {
      sendJson(res, 400, { error: "Cowart project path is required.", code: "COWART_PROJECT_PATH_REQUIRED" });
      return true;
    }
    if (!isAbsolute(rawPath)) {
      sendJson(res, 400, { error: "Cowart project path must be an absolute directory.", code: "COWART_PROJECT_PATH_NOT_ABSOLUTE" });
      return true;
    }
    if (rawPath.split(/[\\/]/).includes("..")) {
      sendJson(res, 400, { error: "Cowart project path must not contain '..' path segments.", code: "COWART_PROJECT_PATH_UNSAFE" });
      return true;
    }
    const inspection = await inspectTrustedExternalCanvas(rawPath);
    if (!inspection.trusted) {
      sendJson(res, 400, { error: inspection.message, code: COWART_TRUST_FAILURE_CODES[inspection.reason] || "COWART_CANVAS_UNTRUSTED" });
      return true;
    }
    const result = await cowartBridge.addProject({ projectDir: rawPath });
    sendJson(res, result.created ? 201 : 200, result);
    return true;
  }

  const cowartCanvasMatch = /^\/api\/cowart-canvases\/([^/]+)$/.exec(url.pathname);
  if (cowartCanvasMatch && req.method === "DELETE") {
    const canvas = await cowartBridge.removeProject(decodeURIComponent(cowartCanvasMatch[1]));
    sendJson(res, 200, { canvas });
    return true;
  }

  return false;
}
