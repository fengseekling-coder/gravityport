import "./provider-policy.js";
// DEV-ONLY(128): remove before release (the whole dev raw diagnostics block).
import {
  createIdbStore,
  removeLegacyCaptureDiagnosticsKeys,
  devRawJsonlLine,
} from "./dev-raw-diagnostics-store.js";

const devRawDiagnosticsStore = createIdbStore();
// Startup cleanup: the pre-0.15.30 structure-only diagnostics storage keys
// are dead weight; remove them once per service-worker start.
removeLegacyCaptureDiagnosticsKeys(chrome.storage.local).catch(() => {});

const DEFAULTS = {
  mosaBaseUrl: "http://127.0.0.1:43517",
  mosaToken: "",
  autoCapture: false,
  devRawDiagnostics: false,
};
const DISCOVERY_PORTS = [43517, 43518, 43519, 43520, 43521];
const STORAGE_KEYS = ["mosaBaseUrl", "mosaToken", "autoCapture"];
const CAPTURE_QUEUE_KEY = "mosaCaptureQueueV1";
const CAPTURE_QUEUE_ALARM = "mosa-capture-queue";
const CAPTURE_QUEUE_MAX_ITEMS = 256;
const CAPTURE_QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CAPTURE_QUEUE_MAX_ATTEMPTS = 3;
const CAPTURE_MEDIA_DB = "mosa-web-capture-media-v1";
const CAPTURE_MEDIA_STORE = "media";
const LEGACY_DEV_TOKEN = "mosa-web-capture-dev";
const WEB_IMAGE_PROVIDERS = new Set(["chatgpt", "gemini", "flow", "google-ai-studio"]);
const WEB_VIDEO_PROVIDERS = new Set(["flow", "google-ai-studio"]);
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_VIDEO_BYTES = 96 * 1024 * 1024;
const MAX_VIDEO_CHUNKS = 40;
const REMOTE_MEDIA_HOSTS = new Set([
  "chatgpt.com",
  "chat.openai.com",
  "images.openai.com",
  "labs.google",
  "flow.google.com",
  "aistudio.google.com",
  "storage.googleapis.com",
  "generativelanguage.googleapis.com",
  "flow-content.google",
]);
let settingsMigration;
let queueDrainPromise;
let queueMutationPromise = Promise.resolve();
let queueStatusReportPromise;
let lastSeenRetryRequestId = 0;
const chunkedVideoTransfers = new Map();
const VIDEO_TRANSFER_TTL_MS = 10 * 60 * 1000;

function openCaptureMediaDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CAPTURE_MEDIA_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CAPTURE_MEDIA_STORE)) db.createObjectStore(CAPTURE_MEDIA_STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Capture media database unavailable."));
  });
}

async function captureMediaPut(record) {
  const db = await openCaptureMediaDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CAPTURE_MEDIA_STORE, "readwrite");
      tx.objectStore(CAPTURE_MEDIA_STORE).put(record);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("Capture media write failed."));
      tx.onabort = () => reject(tx.error || new Error("Capture media write aborted."));
    });
  } finally {
    db.close();
  }
}

async function captureMediaGet(key) {
  const db = await openCaptureMediaDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CAPTURE_MEDIA_STORE, "readonly");
      const request = tx.objectStore(CAPTURE_MEDIA_STORE).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Capture media read failed."));
    });
  } finally {
    db.close();
  }
}

async function captureMediaDelete(key) {
  const db = await openCaptureMediaDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CAPTURE_MEDIA_STORE, "readwrite");
      tx.objectStore(CAPTURE_MEDIA_STORE).delete(key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("Capture media delete failed."));
    });
  } finally {
    db.close();
  }
}

function videoChunkKey(transferId, index) {
  return `video:${transferId}:${index}`;
}

async function deleteVideoSpool(transferId, totalChunks) {
  await Promise.all(Array.from({ length: Number(totalChunks) || 0 }, (_, index) => (
    captureMediaDelete(videoChunkKey(transferId, index)).catch(() => {})
  )));
}

function providerForPageUrl(value) {
  return globalThis.MosaProviderPolicy?.providerForPageUrl(value) || "";
}

function extensionPageSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id || sender.tab) return false;
  return String(sender.url || "").startsWith(`chrome-extension://${chrome.runtime.id}/`);
}

// DEV-ONLY(128): remove before release. The options page is declared with
// open_in_tab, so its messages always carry sender.tab and never pass
// extensionPageSender(); the dev panel routes accept the extension's own
// options page in a tab instead.
function devRawOptionsPageSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (Number(sender.frameId ?? 0) !== 0) return false;
  return String(sender.url || "").startsWith(`chrome-extension://${chrome.runtime.id}/options.html`);
}

function pageSenderContext(sender) {
  if (!sender || sender.id !== chrome.runtime.id || !sender.tab) return null;
  if (Number(sender.frameId ?? 0) !== 0) return null;
  const pageUrl = String(sender.url || sender.tab.url || "");
  const provider = providerForPageUrl(pageUrl);
  if (!provider) return null;
  return { provider, pageUrl, tabId: Number(sender.tab.id) };
}

function senderKey(sender) {
  const context = pageSenderContext(sender);
  return context && Number.isInteger(context.tabId)
    ? `${context.tabId}:${Number(sender.frameId ?? 0)}:${context.provider}`
    : "";
}

function senderAllowedForMessage(message, sender) {
  if (message?.type === "mosa.getSettings") {
    return extensionPageSender(sender) || Boolean(pageSenderContext(sender));
  }
  // DEV-ONLY(128): remove before release (the three dev panel routes; they
  // come from the options page, which has no provider page context).
  if (["mosa.devRawDiagnostics.stats", "mosa.devRawDiagnostics.exportPage", "mosa.devRawDiagnostics.clear"].includes(message?.type)) {
    return devRawOptionsPageSender(sender);
  }
  const context = pageSenderContext(sender);
  if (!context) return false;
  if (message.type === "mosa.fetchImage") return context.provider === "chatgpt";
  if (message.type === "mosa.reportSessionTitle") return context.provider === "chatgpt";
  if (message.type === "mosa.reportConversationTurns") return context.provider === "chatgpt";
  // DEV-ONLY(128): remove before release (records come from the ChatGPT tab).
  if (message.type === "mosa.devRawDiagnostics.record") return context.provider === "chatgpt";
  if (message.type === "mosa.probeFlowMedia") return context.provider === "flow";
  if (["mosa.beginVideoTransfer", "mosa.videoTransferChunk", "mosa.commitVideoTransfer", "mosa.abortVideoTransfer"].includes(message.type)) {
    return context.provider === "flow" || context.provider === "google-ai-studio";
  }
  if (message.type === "mosa.openOptions") return true;
  if (!["mosa.ingest", "mosa.upgradeMetadata"].includes(message.type)) return true;
  const declaredProvider = String(message.payload?.provider || (context.provider === "chatgpt" ? "chatgpt" : "")).trim().toLowerCase();
  return declaredProvider === context.provider;
}

function pruneChunkedVideoTransfers() {
  const cutoff = Date.now() - VIDEO_TRANSFER_TTL_MS;
  for (const [id, transfer] of chunkedVideoTransfers) {
    if (Number(transfer?.createdAt || 0) < cutoff) {
      chunkedVideoTransfers.delete(id);
      void deleteVideoSpool(id, transfer.totalChunks).catch(() => {});
      void abortVideoUpload(transfer).catch(() => {});
    }
  }
}

function stableCaptureKey(payload = {}) {
  const mediaUrl = payload.mediaKind === "video" ? payload.mediaUrl : payload.imageUrl;
  const identity = [
    String(payload.provider || ""),
    String(payload.mediaKind || "image"),
    String(mediaUrl || ""),
    String(payload.providerAssetId || ""),
    String(payload.providerGenerationCallId || ""),
    String(payload.generationContextId || ""),
    String(payload.localMediaIdentity || ""),
    String(payload.pageUrl || ""),
  ].join("\u001f");
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `capture-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function queueReplayPayload(payload = {}, id = "") {
  const mediaUrl = payload.mediaKind === "video" ? payload.mediaUrl : payload.imageUrl;
  const replay = { ...payload };
  if (typeof mediaUrl === "string" && mediaUrl.startsWith("https:")) {
    delete replay.mediaBase64;
    delete replay.imageBase64;
    delete replay.localMediaIdentity;
    return replay;
  }
  const base64 = payload.mediaKind === "video" ? payload.mediaBase64 : payload.imageBase64;
  if (!id || typeof base64 !== "string" || !base64) return null;
  delete replay.mediaBase64;
  delete replay.imageBase64;
  replay.queuedMediaId = id;
  delete replay.localMediaIdentity;
  return replay;
}

function promptPayloadRank(payload = {}) {
  const explicit = Number(payload.promptPriority || payload.prompt_priority) || 0;
  const status = String(payload.promptStatus || payload.prompt_status || "");
  const rank = {
    "not-available": 0,
    "user-message": 1,
    "provider-visible-prompt": 2,
    "visible-caption": 3,
    "generation-tool-prompt": 4,
  }[status] ?? 0;
  return explicit * 100 + rank;
}

function generationStatusRank(value) {
  return {
    unknown: 0,
    in_progress: 1,
    partial: 2,
    failed: 3,
    cancelled: 3,
    completed: 4,
  }[String(value || "").trim().toLowerCase()] ?? 0;
}

function mergeReplayPayload(previous = {}, incoming = {}) {
  const merged = { ...previous, ...incoming };
  if (promptPayloadRank(previous) > promptPayloadRank(incoming)) {
    for (const key of ["prompt", "promptStatus", "promptSource", "promptPriority", "promptScope"]) {
      if (previous[key] !== undefined) merged[key] = previous[key];
    }
  }
  if (generationStatusRank(previous.generationStatus) > generationStatusRank(incoming.generationStatus)) {
    merged.generationStatus = previous.generationStatus;
  }
  return merged;
}

function mutateCaptureQueue(operation) {
  const run = queueMutationPromise.catch(() => undefined).then(operation);
  queueMutationPromise = run.catch(() => undefined);
  return run;
}

async function readCaptureQueue() {
  const stored = await chrome.storage.local.get({ [CAPTURE_QUEUE_KEY]: [] });
  const now = Date.now();
  return (Array.isArray(stored[CAPTURE_QUEUE_KEY]) ? stored[CAPTURE_QUEUE_KEY] : [])
    .filter((item) => item && item.payload && now - Number(item.createdAt || 0) <= CAPTURE_QUEUE_MAX_AGE_MS)
    .slice(-CAPTURE_QUEUE_MAX_ITEMS);
}

async function pruneStoredCaptureQueue() {
  let removed = [];
  await mutateCaptureQueue(async () => {
    const stored = await chrome.storage.local.get({ [CAPTURE_QUEUE_KEY]: [] });
    const raw = Array.isArray(stored[CAPTURE_QUEUE_KEY]) ? stored[CAPTURE_QUEUE_KEY] : [];
    const now = Date.now();
    const next = raw
      .filter((item) => item && item.payload && now - Number(item.createdAt || 0) <= CAPTURE_QUEUE_MAX_AGE_MS)
      .slice(-CAPTURE_QUEUE_MAX_ITEMS);
    const retainedIds = new Set(next.map((item) => item.id));
    removed = raw.filter((item) => item?.id && !retainedIds.has(item.id));
    if (next.length !== raw.length) await writeCaptureQueue(next);
  });
  for (const item of removed) {
    if (item?.payload?.queuedMediaId) await captureMediaDelete(`capture:${item.payload.queuedMediaId}`).catch(() => {});
    if (item?.videoSpool?.transferId) await deleteVideoSpool(item.videoSpool.transferId, item.videoSpool.totalChunks);
  }
}

async function writeCaptureQueue(queue) {
  await chrome.storage.local.set({ [CAPTURE_QUEUE_KEY]: queue.slice(-CAPTURE_QUEUE_MAX_ITEMS) });
}

async function captureQueueStatusSnapshot() {
  const queue = await readCaptureQueue();
  return {
    pending: queue.length,
    failed: queue.filter((item) => Number(item?.attempts || 0) > 0).length,
    items: queue.slice(0, 20).map((item) => ({
      id: String(item?.id || ""),
      provider: String(item?.payload?.provider || ""),
      mediaKind: item?.payload?.mediaKind === "video" ? "video" : "image",
      promptStatus: String(item?.payload?.promptStatus || item?.payload?.prompt_status || "not-available"),
      generationStatus: String(item?.payload?.generationStatus || item?.payload?.generation_status || "unknown"),
      createdAt: Number(item?.createdAt || 0),
      updatedAt: Number(item?.lastUpdatedAt || item?.createdAt || 0),
      attempts: Number(item?.attempts || 0),
      lastError: String(item?.lastError || ""),
    })),
  };
}

function reportCaptureQueueStatus() {
  if (queueStatusReportPromise) return queueStatusReportPromise;
  queueStatusReportPromise = (async () => {
    const settings = await getSettings();
    const token = String(settings.mosaToken || "").trim();
    if (!token) return { reported: false, retryRequested: false };
    const baseUrl = normalizeBaseUrl(settings.mosaBaseUrl || DEFAULTS.mosaBaseUrl);
    const response = await fetchWithTimeout(`${baseUrl}/api/ingest/web-capture-status`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(await captureQueueStatusSnapshot()),
      cache: "no-cache",
    }, 3_000);
    if (!response.ok) return { reported: false, retryRequested: false };
    const body = await response.json().catch(() => ({}));
    const retryRequestId = Math.max(0, Number(body?.retryRequestId || 0));
    const retryRequested = retryRequestId > lastSeenRetryRequestId;
    lastSeenRetryRequestId = Math.max(lastSeenRetryRequestId, retryRequestId);
    return { reported: true, retryRequested };
  })().catch(() => ({ reported: false, retryRequested: false })).finally(() => {
    queueStatusReportPromise = undefined;
  });
  return queueStatusReportPromise;
}

// Stack naming: at most one report per (conversation, title) per browser
// session. The sent-set lives in the service worker, so a browser restart
// (worker restart) allows one fresh attempt; a failed or rejected POST is
// still remembered as sent — no retries, no capture-queue detour. Without a
// pairing token nothing is sent and nothing is remembered, so a later pairing
// can still report the title.
const reportedSessionTitles = new Set();

async function reportSessionTitleOnce(payload = {}) {
  const provider = String(payload?.provider || "chatgpt").trim().toLowerCase() || "chatgpt";
  const conversationId = String(payload?.conversationId || "").trim();
  const title = String(payload?.title || "").trim().slice(0, 200);
  if (!conversationId || !title) return { reported: false, reason: "empty" };
  const key = `${conversationId}\u001f${title}`;
  if (reportedSessionTitles.has(key)) return { reported: false, reason: "already-reported" };
  const settings = await getSettings();
  const token = String(settings.mosaToken || "").trim();
  if (!token) return { reported: false, reason: "no-token" };
  const baseUrl = normalizeBaseUrl(settings.mosaBaseUrl || DEFAULTS.mosaBaseUrl);
  reportedSessionTitles.add(key);
  try {
    const response = await fetchWithTimeout(`${baseUrl}/api/ingest/web-capture-session-title`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ provider, conversationId, title }),
      cache: "no-cache",
    }, 3_000);
    return { reported: response.ok, status: response.status };
  } catch (error) {
    return { reported: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

// Conversation turn bindings: while the user has a ChatGPT conversation open,
// the page hook reduces its displayed branch to file id → turn numbers and
// this worker POSTs that snapshot to MOSA. At most one send per conversation
// per 2s window — the newest read inside the window wins. The summary
// (turn_count + bindings) is remembered per browser session only after a
// successful POST: an unchanged read is never sent twice, a failed or
// tokenless attempt is not remembered, so the next conversation load retries
// naturally. No capture-queue detour and no retries on a timer.
const reportedTurnBindingSummaries = new Map();
const pendingTurnBindingReports = new Map();
const TURN_BINDING_REPORT_THROTTLE_MS = 2_000;

function turnBindingSummaryKey(payload = {}) {
  const bindings = (Array.isArray(payload.bindings) ? payload.bindings : [])
    .map((binding) => [
      String(binding?.provider_asset_id || ""),
      String(binding?.message_id || ""),
      Number(binding?.turn_index) || 0,
    ])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[2] - b[2]));
  return JSON.stringify([Number(payload.turnCount) || 0, bindings]);
}

async function reportConversationTurnsOnce(payload = {}) {
  const provider = String(payload?.provider || "chatgpt").trim().toLowerCase() || "chatgpt";
  const conversationId = String(payload?.conversationId || "").trim();
  const turnCount = Number(payload?.turnCount) || 0;
  const rawBindings = Array.isArray(payload?.bindings) ? payload.bindings : [];
  const bindings = rawBindings
    .map((binding) => ({
      provider_asset_id: String(binding?.provider_asset_id || "").trim(),
      message_id: String(binding?.message_id || "").trim(),
      turn_index: Number(binding?.turn_index) || 0,
    }))
    .filter((binding) => binding.provider_asset_id && binding.turn_index >= 1);
  if (!conversationId || turnCount < 1 || !bindings.length) return { reported: false, reason: "empty" };
  const summary = turnBindingSummaryKey({ turnCount, bindings });
  if (reportedTurnBindingSummaries.get(conversationId) === summary) {
    return { reported: false, reason: "already-reported" };
  }
  const settings = await getSettings();
  const token = String(settings.mosaToken || "").trim();
  if (!token) return { reported: false, reason: "no-token" };
  const baseUrl = normalizeBaseUrl(settings.mosaBaseUrl || DEFAULTS.mosaBaseUrl);
  const response = await fetchWithTimeout(`${baseUrl}/api/ingest/web-capture-turn-bindings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      project_id: "default",
      provider,
      conversation_id: conversationId,
      turn_count: turnCount,
      bindings,
    }),
    cache: "no-cache",
  }, 3_000);
  if (!response.ok) throw new Error(`GravityPort turn-binding report failed (${response.status})`);
  await response.arrayBuffer().catch(() => {});
  reportedTurnBindingSummaries.set(conversationId, summary);
  return { reported: true, status: response.status };
}

// Trailing throttle: the first trigger for a conversation opens a 2s window
// and later triggers inside it only replace the payload, so a burst of
// conversation reads collapses into the single newest snapshot.
function reportConversationTurnsThrottled(payload = {}) {
  const conversationId = String(payload?.conversationId || "").trim();
  if (!conversationId) return Promise.resolve({ reported: false, reason: "empty" });
  return new Promise((resolve) => {
    const pending = pendingTurnBindingReports.get(conversationId);
    if (pending) {
      pending.payload = payload;
      pending.resolvers.push(resolve);
      return;
    }
    const entry = { payload, resolvers: [resolve] };
    pendingTurnBindingReports.set(conversationId, entry);
    setTimeout(() => {
      pendingTurnBindingReports.delete(conversationId);
      reportConversationTurnsOnce(entry.payload)
        .catch((error) => ({ reported: false, reason: error instanceof Error ? error.message : String(error) }))
        .then((result) => {
          for (const resolve of entry.resolvers) resolve(result);
        });
    }, TURN_BINDING_REPORT_THROTTLE_MS);
  });
}

async function enqueueCapture(payload) {
  const id = stableCaptureKey(payload);
  const replayPayload = queueReplayPayload(payload, id);
  if (!replayPayload) return null;
  if (replayPayload.queuedMediaId) {
    const base64 = payload.mediaKind === "video" ? payload.mediaBase64 : payload.imageBase64;
    const bytes = base64ToBytes(base64);
    await captureMediaPut({
      key: `capture:${id}`,
      blob: new Blob([bytes], { type: payload.mimeType || (payload.mediaKind === "video" ? "video/mp4" : "image/png") }),
      updatedAt: Date.now(),
    });
  }
  await mutateCaptureQueue(async () => {
    const queue = await readCaptureQueue();
    const index = queue.findIndex((item) => item.id === id);
    if (index < 0) {
      // Persist a small replay ticket rather than the potentially multi-MiB
      // Base64 body. If MOSA is temporarily unavailable and the page closes,
      // the service worker can re-download the same provider URL later.
      queue.push({ id, payload: replayPayload, createdAt: Date.now(), attempts: 0, lastError: "" });
    } else {
      queue[index] = {
        ...queue[index],
        payload: mergeReplayPayload(queue[index].payload, replayPayload),
        lastUpdatedAt: Date.now(),
      };
    }
    await writeCaptureQueue(queue);
  });
  return id;
}

async function enqueueVideoSpool(payload, transferId, totalBytes, totalChunks) {
  const id = stableCaptureKey(payload);
  const replayPayload = { ...payload };
  delete replayPayload.mediaBase64;
  delete replayPayload.imageBase64;
  delete replayPayload.localMediaIdentity;
  let queuedItem = null;
  let replacedSpool = null;
  await mutateCaptureQueue(async () => {
    const queue = await readCaptureQueue();
    const index = queue.findIndex((item) => item.id === id);
    const previous = index >= 0 ? queue[index] : null;
    replacedSpool = previous?.videoSpool || null;
    queuedItem = {
      id,
      payload: previous ? mergeReplayPayload(previous.payload, replayPayload) : replayPayload,
      createdAt: previous?.createdAt || Date.now(),
      attempts: previous?.attempts || 0,
      lastError: "",
      lastUpdatedAt: Date.now(),
      videoSpool: { transferId, totalBytes, totalChunks },
    };
    if (index >= 0) queue[index] = queuedItem;
    else queue.push(queuedItem);
    await writeCaptureQueue(queue);
  });
  if (replacedSpool?.transferId && replacedSpool.transferId !== transferId) {
    await deleteVideoSpool(replacedSpool.transferId, replacedSpool.totalChunks);
  }
  return queuedItem;
}

async function removeQueuedCapture(id) {
  if (!id) return;
  let removed = null;
  await mutateCaptureQueue(async () => {
    const queue = await readCaptureQueue();
    removed = queue.find((item) => item.id === id) || null;
    const next = queue.filter((item) => item.id !== id);
    if (next.length !== queue.length) await writeCaptureQueue(next);
  });
  if (removed?.payload?.queuedMediaId) await captureMediaDelete(`capture:${removed.payload.queuedMediaId}`).catch(() => {});
  if (removed?.videoSpool?.transferId) await deleteVideoSpool(removed.videoSpool.transferId, removed.videoSpool.totalChunks);
}

async function markQueuedCaptureFailure(id, error) {
  if (!id) return;
  await mutateCaptureQueue(async () => {
    const queue = await readCaptureQueue();
    const index = queue.findIndex((item) => item.id === id);
    if (index < 0) return;
    queue[index] = {
      ...queue[index],
      attempts: Number(queue[index].attempts || 0) + 1,
      lastError: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
    };
    await writeCaptureQueue(queue);
  });
}

function mosaUnavailableError(message) {
  const error = new Error(message);
  error.code = "MOSA_UNAVAILABLE";
  error.retryable = true;
  return error;
}

function ingestResponseError(message, status) {
  const error = new Error(message);
  error.status = Number(status) || 0;
  error.retryable = error.status === 0 || error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
  return error;
}

async function ingestWithQueue(payload = {}) {
  let queueId = null;
  try {
    queueId = await enqueueCapture(payload);
  } catch {
    // Durability is a safety net, not a prerequisite for a live capture. If
    // browser storage is temporarily unavailable, still let an online MOSA
    // receive the media instead of turning the backup path into a new outage.
  }
  try {
    const result = await ingestToMosa(payload);
    await removeQueuedCapture(queueId).catch(() => {});
    void reportCaptureQueueStatus();
    return result;
  } catch (error) {
    void reportCaptureQueueStatus();
    throw error;
  }
}

async function ingestQueuedCapture(item) {
  if (item?.payload?.queuedMediaId) {
    const record = await captureMediaGet(`capture:${item.payload.queuedMediaId}`);
    if (!record?.blob) {
      const error = new Error("Queued local media bytes are missing.");
      error.retryable = false;
      throw error;
    }
    const mediaKind = item.payload.mediaKind === "video" ? "video" : "image";
    const payload = { ...item.payload };
    delete payload.queuedMediaId;
    const base64 = bufferToBase64(await record.blob.arrayBuffer());
    if (mediaKind === "video") payload.mediaBase64 = base64;
    else payload.imageBase64 = base64;
    return ingestToMosa(payload);
  }
  if (item?.videoSpool?.transferId) return ingestQueuedVideoSpool(item);
  return ingestToMosa(item.payload);
}

async function ingestQueuedVideoSpool(item) {
  const spool = item.videoSpool;
  const payload = { ...(item.payload || {}), mediaKind: "video" };
  const connection = await uploadConnection();
  const upload = await beginVideoUpload(payload, spool.totalBytes, spool.totalChunks, connection);
  try {
    for (let index = 0; index < spool.totalChunks; index += 1) {
      const record = await captureMediaGet(videoChunkKey(spool.transferId, index));
      if (!record?.blob) {
        const error = new Error(`Queued video chunk ${index} is missing.`);
        error.retryable = false;
        throw error;
      }
      const bytes = new Uint8Array(await record.blob.arrayBuffer());
      await appendVideoUploadChunk(upload, index, bytes);
    }
    return await commitVideoUpload(upload);
  } catch (error) {
    await abortVideoUpload(upload).catch(() => {});
    throw error;
  }
}

function drainCaptureQueue() {
  if (queueDrainPromise) return queueDrainPromise;
  queueDrainPromise = (async () => {
    await pruneStoredCaptureQueue();
    const queue = await readCaptureQueue();
    if (!queue.length) return;
    for (const item of queue) {
      try {
        await ingestQueuedCapture(item);
        await removeQueuedCapture(item.id);
      } catch (error) {
        await markQueuedCaptureFailure(item.id, error);
        if (error?.code === "MOSA_UNAVAILABLE") break;
        if (error?.retryable === false && Number(item.attempts || 0) + 1 >= CAPTURE_QUEUE_MAX_ATTEMPTS) {
          await removeQueuedCapture(item.id);
        }
      }
    }
  })().finally(() => {
    queueDrainPromise = undefined;
    void reportCaptureQueueStatus();
  });
  return queueDrainPromise;
}

chrome.runtime.onStartup?.addListener(() => { void drainCaptureQueue(); });
chrome.runtime.onInstalled?.addListener(() => {
  chrome.alarms?.create?.(CAPTURE_QUEUE_ALARM, { periodInMinutes: 1 });
  void drainCaptureQueue();
});
chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm?.name === CAPTURE_QUEUE_ALARM) {
    void reportCaptureQueueStatus().finally(() => drainCaptureQueue());
  }
});
chrome.alarms?.create?.(CAPTURE_QUEUE_ALARM, { periodInMinutes: 1 });
void drainCaptureQueue();
void reportCaptureQueueStatus();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;
  if (!senderAllowedForMessage(message, sender)) {
    sendResponse({ ok: false, error: "GravityPort rejected a message from an unsupported sender." });
    return false;
  }

  if (message.type === "mosa.ingest") {
    ingestWithQueue(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  }

  if (message.type === "mosa.reportSessionTitle") {
    // Best effort stack naming: never surface failures to the page.
    reportSessionTitleOnce(message.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch(() => sendResponse({ ok: true, reported: false }));
    return true;
  }

  if (message.type === "mosa.reportConversationTurns") {
    // Best effort turn bindings: never surface failures to the page.
    reportConversationTurnsThrottled(message.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch(() => sendResponse({ ok: true, reported: false }));
    return true;
  }

  // DEV-ONLY(128): remove before release (the whole dev raw diagnostics block).
  if (message.type === "mosa.devRawDiagnostics.record") {
    // Records come from the paired ChatGPT tab only (checked above). Stamp
    // the extension version and arrival time, store, and evict; capture
    // itself is never blocked on this.
    const record = message.payload && typeof message.payload === "object" ? message.payload : null;
    if (!record) {
      sendResponse({ ok: false, error: "empty dev raw diagnostics record" });
      return true;
    }
    if (typeof record.version !== "string" || !record.version) {
      record.version = chrome.runtime.getManifest().version;
    }
    if (typeof record.recordedAt !== "string" || !record.recordedAt) {
      record.recordedAt = new Date().toISOString();
    }
    devRawDiagnosticsStore.addRecord(record)
      .then((result) => sendResponse({ ok: true, id: result.id, count: result.count }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (message.type === "mosa.devRawDiagnostics.stats") {
    devRawDiagnosticsStore.statsRecords()
      .then((stats) => sendResponse({ ok: true, stats }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (message.type === "mosa.devRawDiagnostics.exportPage") {
    const afterId = Number(message.afterId) || 0;
    const limit = Math.min(Math.max(Number(message.limit) || 10, 1), 50);
    devRawDiagnosticsStore.listRecords({ afterId, limit })
      .then((page) => sendResponse({
        ok: true,
        lines: page.records.map((record) => devRawJsonlLine(record)),
        nextAfterId: page.nextAfterId,
        hasMore: page.hasMore,
      }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (message.type === "mosa.devRawDiagnostics.clear") {
    devRawDiagnosticsStore.clearRecords()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (message.type === "mosa.upgradeMetadata") {
    upgradeMetadataToMosa(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  }

  if (message.type === "mosa.beginVideoTransfer") {
    (async () => {
      pruneChunkedVideoTransfers();
      const transferId = String(message.transferId || "").trim();
      const totalBytes = Number(message.totalBytes || 0);
      const totalChunks = Number(message.totalChunks || 0);
      if (!transferId || totalBytes < 1024 || totalBytes > MAX_VIDEO_BYTES
        || !Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_VIDEO_CHUNKS) {
        throw new Error("Invalid chunked video transfer.");
      }
      chunkedVideoTransfers.set(transferId, {
        payload: { ...(message.payload || {}), mediaKind: "video" },
        senderKey: senderKey(sender),
        totalBytes,
        totalChunks,
        nextIndex: 0,
        receivedBytes: 0,
        createdAt: Date.now(),
      });
      sendResponse({ ok: true });
    })().catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }

  if (message.type === "mosa.videoTransferChunk") {
    (async () => {
      const transferId = String(message.transferId || "").trim();
      const transfer = chunkedVideoTransfers.get(transferId);
      const index = Number(message.index);
      const chunkBase64 = String(message.chunkBase64 || "");
      if (!transfer || transfer.senderKey !== senderKey(sender)
        || !Number.isInteger(index) || index !== transfer.nextIndex || index >= transfer.totalChunks || !chunkBase64) {
        throw new Error("Unknown or invalid video transfer chunk.");
      }
      const chunkBytes = base64ToBytes(chunkBase64);
      if (transfer.receivedBytes + chunkBytes.byteLength > transfer.totalBytes) {
        chunkedVideoTransfers.delete(transferId);
        await deleteVideoSpool(transferId, transfer.totalChunks).catch(() => {});
        throw new Error("Chunked video exceeds declared size.");
      }
      await captureMediaPut({
        key: videoChunkKey(transferId, index),
        blob: new Blob([chunkBytes], { type: "application/octet-stream" }),
        updatedAt: Date.now(),
      });
      transfer.receivedBytes += chunkBytes.byteLength;
      transfer.nextIndex += 1;
      transfer.createdAt = Date.now();
      sendResponse({ ok: true });
    })().catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }

  if (message.type === "mosa.commitVideoTransfer") {
    const transferId = String(message.transferId || "").trim();
    const transfer = chunkedVideoTransfers.get(transferId);
    if (!transfer || transfer.senderKey !== senderKey(sender)
      || transfer.nextIndex !== transfer.totalChunks || transfer.receivedBytes !== transfer.totalBytes) {
      sendResponse({ ok: false, error: "Chunked video transfer is incomplete." });
      return false;
    }
    chunkedVideoTransfers.delete(transferId);
    (async () => {
      const queued = await enqueueVideoSpool(transfer.payload, transferId, transfer.totalBytes, transfer.totalChunks);
      try {
        const result = await ingestQueuedCapture(queued);
        await removeQueuedCapture(queued.id);
        sendResponse({ ok: true, result });
      } catch (error) {
        await markQueuedCaptureFailure(queued.id, error).catch(() => {});
        if (error?.retryable === false) {
          sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
          return;
        }
        sendResponse({ ok: true, result: { status: "queued", reason: "mosa-temporarily-unavailable" } });
      }
    })().catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (message.type === "mosa.abortVideoTransfer") {
    const transferId = String(message.transferId || "").trim();
    const transfer = chunkedVideoTransfers.get(transferId);
    if (!transfer || transfer.senderKey !== senderKey(sender)) {
      sendResponse({ ok: true, aborted: false });
      return false;
    }
    chunkedVideoTransfers.delete(transferId);
    Promise.all([
      deleteVideoSpool(transferId, transfer.totalChunks),
      abortVideoUpload(transfer),
    ])
      .then(() => sendResponse({ ok: true, aborted: true }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (message.type === "mosa.fetchImage") {
    fetchImageAsBase64(message.url)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  }

  // DEV-ONLY(128): remove before release (the devRawDiagnostics branch).
  function isChatGptPageSender(sender) {
    // Content scripts on chatgpt.com need the devRawDiagnostics flag to enable
    // the page-hook dev diagnostics mode. Provider pages (gemini/flow) never
    // observe the flag, so we filter by sender URL.
    try {
      const url = new URL(sender?.url || sender?.tab?.url || "");
      const host = url.hostname.toLowerCase();
      return host === "chatgpt.com" || host === "chat.openai.com" || host.endsWith(".chatgpt.com") || host.endsWith(".openai.com");
    } catch {
      return false;
    }
  }

  if (message.type === "mosa.getSettings") {
    // Extension pages manage every field. Content scripts on provider pages
    // only read autoCapture, so the mosaToken and base URL never leave the
    // background for a page origin. The chatgpt-web-capture content script
    // additionally needs the devRawDiagnostics toggle, which is harmless on
    // ChatGPT (settings storage is local) and never reaches provider tabs.
    getSettings()
      .then((settings) => sendResponse({
        ok: true,
        settings: extensionPageSender(sender)
          ? settings
          : { autoCapture: settings.autoCapture, devRawDiagnostics: isChatGptPageSender(sender) ? Boolean(settings.devRawDiagnostics) : false },
      }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  }

  if (message.type === "mosa.probeFlowMedia") {
    probeFlowMedia(message.url)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  }

  if (message.type === "mosa.openOptions") {
    chrome.runtime.openOptionsPage()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  }

  return false;
});

async function getSettings() {
  await migrateSettingsToLocal();
  let stored = await chrome.storage.local.get(DEFAULTS);
  let settings = { ...DEFAULTS, ...stored };
  if (!String(settings.mosaToken || "").trim()) {
    const paired = await discoverAndPairMosa().catch(() => null);
    if (paired) {
      await chrome.storage.local.set({ mosaBaseUrl: paired.baseUrl, mosaToken: paired.token });
      stored = await chrome.storage.local.get(DEFAULTS);
      settings = { ...DEFAULTS, ...stored };
    }
  }
  return settings;
}

async function discoverAndPairMosa() {
  for (const port of DISCOVERY_PORTS) {
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const health = await fetchWithTimeout(`${baseUrl}/api/health`, { cache: "no-cache" }, 700);
      if (!health.ok) continue;
      const identity = await health.json();
      if (identity?.product !== "mosa") continue;

      const pair = await fetchWithTimeout(`${baseUrl}/api/web-capture/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        cache: "no-cache",
      }, 900);
      if (!pair.ok) continue;
      const body = await pair.json();
      const token = String(body?.token || "").trim();
      if (body?.product !== "mosa" || !token) continue;
      return { baseUrl, token };
    } catch {
      // Try the next local discovery port.
    }
  }
  return null;
}

async function repairPairing() {
  const paired = await discoverAndPairMosa();
  if (!paired) return null;
  await chrome.storage.local.set({ mosaBaseUrl: paired.baseUrl, mosaToken: paired.token });
  return paired;
}

async function ensureMosaAvailable(baseUrl) {
  try {
    const response = await fetchWithTimeout(`${baseUrl}/api/health`, { cache: "no-cache" }, 900);
    if (!response.ok) return false;
    const body = await response.json();
    return body?.product === "mosa";
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probeFlowMedia(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ""));
  } catch {
    throw new Error("Invalid Flow media URL.");
  }
  // The accepted Flow origins and redirect paths live in provider-policy.js
  // so the page adapter and this background gate share one rule set.
  if (!globalThis.MosaProviderPolicy?.isFlowMediaRedirectUrl?.(parsed.href)) {
    throw new Error("Unsupported Flow media probe URL.");
  }

  const attempts = [
    { method: "GET", credentials: "include", cache: "no-cache", redirect: "follow", headers: { Range: "bytes=0-31" } },
    { method: "GET", credentials: "omit", cache: "no-cache", redirect: "follow", headers: { Range: "bytes=0-31" } },
  ];
  let lastError = null;
  for (const init of attempts) {
    try {
      const response = await fetchWithTimeout(parsed.href, init, 5_000);
      if (!response.ok && response.status !== 206) {
        lastError = new Error(`Flow media probe failed (${response.status})`);
        continue;
      }
      const contentType = String(response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
      const finalUrl = String(response.url || parsed.href);
      let finalParsed;
      try { finalParsed = new URL(finalUrl); } catch { finalParsed = null; }
      const finalHost = String(finalParsed?.hostname || "").toLowerCase();
      const finalPath = String(finalParsed?.pathname || "").toLowerCase();
      const trustedFinalHost = finalHost === "flow-content.google"
        || finalHost === "storage.googleapis.com"
        || finalHost.endsWith(".googleusercontent.com")
        || finalParsed?.origin === "https://labs.google"
        || finalParsed?.origin === "https://flow.google.com";
      if (!trustedFinalHost) throw new Error("Flow media redirected to an unsupported host.");
      const mediaKind = contentType.startsWith("video/") || finalPath.includes("/video/")
        ? "video"
        : contentType.startsWith("image/") || finalPath.includes("/image/")
          ? "image"
          : "unknown";
      response.body?.cancel?.().catch?.(() => {});
      return { mediaKind, mimeType: contentType, mediaUrl: finalUrl };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError || new Error("Flow media probe failed.");
}

function migrateSettingsToLocal() {
  if (settingsMigration) return settingsMigration;
  settingsMigration = (async () => {
    const [local, synced] = await Promise.all([
      chrome.storage.local.get(null),
      chrome.storage.sync.get(STORAGE_KEYS),
    ]);
    const localToken = normalizeStoredToken(local.mosaToken);
    const migratedToken = normalizeStoredToken(synced.mosaToken);
    const patch = {
      mosaBaseUrl: local.mosaBaseUrl || synced.mosaBaseUrl || DEFAULTS.mosaBaseUrl,
      mosaToken: localToken || migratedToken || DEFAULTS.mosaToken,
      autoCapture: local.autoCapture ?? synced.autoCapture ?? DEFAULTS.autoCapture,
    };
    await chrome.storage.local.set(patch);
    await chrome.storage.sync.remove(STORAGE_KEYS);
  })().catch((error) => {
    settingsMigration = undefined;
    throw error;
  });
  return settingsMigration;
}

function normalizeStoredToken(value) {
  const token = String(value || "").trim();
  return token === LEGACY_DEV_TOKEN ? "" : token;
}

async function fetchImageAsBase64(url, { publicImage = false } = {}) {
  const result = await fetchMediaAsBase64(url, {
    publicMedia: publicImage,
    mediaKind: "image",
    attemptLimit: 1,
    timeoutMs: 1_800,
  });
  return { mimeType: result.mimeType, imageBase64: result.mediaBase64 };
}

async function fetchMediaAsBase64(url, {
  publicMedia = false,
  mediaKind = "image",
  binary = false,
  attemptLimit = 0,
  timeoutMs = 0,
} = {}) {
  const label = mediaKind === "video" ? "video" : "image";
  if (!url || typeof url !== "string") throw new Error(`${label === "video" ? "Video" : "Image"} URL is required.`);
  if (url.startsWith("data:")) {
    const match = /^data:([^;]+);base64,(.+)$/i.exec(url);
    if (!match) throw new Error("Unsupported data URL.");
    return { mimeType: match[1], mediaBase64: match[2] };
  }

  assertAllowedRemoteMediaUrl(url);
  const maxBytes = mediaKind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;

  const allAttempts = [
    ...(publicMedia ? [] : [{ credentials: "include", cache: "no-cache" }]),
    { credentials: "omit", cache: "no-cache" },
    ...(publicMedia ? [] : [{ credentials: "include", cache: "force-cache" }]),
  ];
  const attempts = attemptLimit > 0 ? allAttempts.slice(0, attemptLimit) : allAttempts;
  const requestTimeoutMs = timeoutMs > 0 ? timeoutMs : mediaKind === "video" ? 45_000 : 15_000;
  let lastError = null;
  for (const init of attempts) {
    try {
      const response = await fetchWithTimeout(url, init, requestTimeoutMs);
      if (!response.ok) {
        lastError = new Error(`Failed to download ${label} (${response.status})`);
        continue;
      }
      // Redirects are followed by fetch. Re-validate the final destination so
      // an allow-listed bootstrap URL cannot bounce the extension to an
      // arbitrary host.
      assertAllowedRemoteMediaUrl(response.url || url);
      const declaredLength = Number(response.headers.get("content-length") || 0);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        response.body?.cancel?.().catch?.(() => {});
        throw new Error(`${label === "video" ? "Video" : "Image"} exceeds GravityPort capture size limit.`);
      }
      const blob = await response.blob();
      if (!blob || blob.size < 100) {
        lastError = new Error(`Downloaded ${label} empty/too small`);
        continue;
      }
      if (blob.size > maxBytes) {
        throw new Error(`${label === "video" ? "Video" : "Image"} exceeds GravityPort capture size limit.`);
      }
      const mimeType = blob.type || guessMime(url, mediaKind) || (mediaKind === "video" ? "video/mp4" : "image/png");
      const buffer = await blob.arrayBuffer();
      return binary
        ? { mimeType, mediaBytes: buffer, finalUrl: response.url || url }
        : { mimeType, mediaBase64: bufferToBase64(buffer), finalUrl: response.url || url };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError || new Error(`Failed to download ${label}`);
}

function assertAllowedRemoteMediaUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("Invalid media URL.");
  }
  if (url.protocol !== "https:") throw new Error("Unsupported media URL protocol.");
  const host = url.hostname.toLowerCase();
  const allowed = REMOTE_MEDIA_HOSTS.has(host)
    || host.endsWith(".oaiusercontent.com")
    || host.endsWith(".blob.core.windows.net")
    || host.endsWith(".googleusercontent.com")
    || host.endsWith(".ggpht.com");
  if (!allowed) throw new Error("Unsupported media host.");
}

function sanitizeProvenanceUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:") return "";
    const retained = new URLSearchParams();
    for (const key of ["id", "cid", "name", "asset_id", "assetId", "media_id", "mediaId"]) {
      const entry = url.searchParams.get(key);
      if (entry) retained.set(key, entry.slice(0, 512));
    }
    url.search = retained.toString();
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function binaryCaptureEnvelope(metadata, parts) {
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  if (metadataBytes.byteLength > 256 * 1024) throw new Error("Capture metadata is too large.");
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, metadataBytes.byteLength, false);
  return new Blob([header, metadataBytes, ...parts], { type: "application/octet-stream" });
}

function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function captureRequestPayload(payload, { mediaKind, mimeType, mediaUrl = "", finalMediaUrl = "", provider } = {}) {
  return {
    provider,
    prompt: payload.prompt || "",
    prompt_status: payload.promptStatus || (payload.prompt ? "user-message" : "not-available"),
    user_message: payload.userMessage || payload.user_message || "",
    generation_request_prompt: payload.generationRequestPrompt || payload.generation_request_prompt || "",
    prompt_source: payload.promptSource || payload.prompt_source || "",
    prompt_priority: Number(payload.promptPriority || payload.prompt_priority) || 0,
    prompt_scope: payload.promptScope || payload.prompt_scope || "",
    generation_status: payload.generationStatus || payload.generation_status || "unknown",
    is_reference: Boolean(payload.isReference),
    mediaKind,
    mimeType,
    width: Number(payload.width) || 0,
    height: Number(payload.height) || 0,
    durationSeconds: Number.isFinite(Number(payload.durationSeconds)) ? Number(payload.durationSeconds) : null,
    pageUrl: payload.pageUrl || "",
    sourceMediaUrl: sanitizeProvenanceUrl(mediaUrl || payload.sourceMediaUrl || ""),
    finalMediaUrl: sanitizeProvenanceUrl(finalMediaUrl || payload.finalMediaUrl || ""),
    conversationId: payload.conversationId || "",
    generation_session_title: String(payload.generationSessionTitle || payload.generation_session_title || "").trim().slice(0, 200),
    messageId: payload.messageId || "",
    generationContextId: payload.generationContextId || "",
    providerToolCallId: payload.providerToolCallId || "",
    providerGenerationCallId: payload.providerGenerationCallId || "",
    providerResponseId: payload.providerResponseId || "",
    providerAssetId: payload.providerAssetId || "",
    model: payload.model || "",
    captureMode: payload.captureMode === "manual" ? "manual" : "automatic",
    capturedAt: payload.capturedAt || new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
  };
}

async function upgradeMetadataToMosa(payload = {}) {
  const provider = String(payload.provider || "").trim().toLowerCase();
  if (!WEB_IMAGE_PROVIDERS.has(provider)) throw new Error("Unsupported web image provider.");
  const mediaKind = payload.mediaKind === "video" ? "video" : "image";
  if (mediaKind === "video" && !WEB_VIDEO_PROVIDERS.has(provider)) throw new Error("Unsupported web video provider.");
  const { baseUrl, token } = await uploadConnection();
  const requestPayload = captureRequestPayload(payload, {
    mediaKind,
    mimeType: payload.mimeType || (mediaKind === "video" ? "video/mp4" : "image/png"),
    mediaUrl: payload.sourceMediaUrl || payload.mediaUrl || payload.imageUrl || "",
    finalMediaUrl: payload.finalMediaUrl || "",
    provider,
  });
  const response = await fetchWithTimeout(`${baseUrl}/api/ingest/web-capture-metadata`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(requestPayload),
  }, 15_000);
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw ingestResponseError(`GravityPort returned non-JSON (${response.status}): ${text.slice(0, 180)}`, response.status);
  }
  if (!response.ok) throw ingestResponseError(data.error || `GravityPort metadata upgrade failed (${response.status})`, response.status);
  return data;
}

async function uploadConnection() {
  const settings = await getSettings();
  let baseUrl = normalizeBaseUrl(settings.mosaBaseUrl || DEFAULTS.mosaBaseUrl);
  let token = String(settings.mosaToken || "").trim();
  if (!token) throw new Error("Web Capture Token 未配置。");
  if (!await ensureMosaAvailable(baseUrl)) {
    const repaired = await repairPairing().catch(() => null);
    if (!repaired) throw mosaUnavailableError(`无法连接 GravityPort (${baseUrl})。请确认 GravityPort App 正在运行。`);
    baseUrl = repaired.baseUrl;
    token = repaired.token;
  }
  return { baseUrl, token };
}

async function beginVideoUpload(payload, totalBytes, totalChunks, connection = null, provenance = {}) {
  const { baseUrl, token } = connection || await uploadConnection();
  const provider = String(payload.provider || "").trim().toLowerCase();
  if (!WEB_VIDEO_PROVIDERS.has(provider)) throw new Error("Unsupported web video provider.");
  const mimeType = payload.mimeType || "video/mp4";
  const metadata = captureRequestPayload(payload, {
    mediaKind: "video",
    mimeType,
    mediaUrl: provenance.mediaUrl || "",
    finalMediaUrl: provenance.finalMediaUrl || "",
    provider,
  });
  const response = await fetchWithTimeout(`${baseUrl}/api/ingest/web-capture-upload/begin`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ metadata, totalBytes, totalChunks }),
  }, 30_000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.uploadId) throw new Error(data.error || `GravityPort upload begin failed (${response.status})`);
  return { baseUrl, token, uploadId: data.uploadId };
}

async function streamRemoteVideoToMosa(payload, mediaUrl, connection) {
  assertAllowedRemoteMediaUrl(mediaUrl);
  const attempts = [
    { credentials: "include", cache: "no-cache" },
    { credentials: "omit", cache: "no-cache" },
    { credentials: "include", cache: "force-cache" },
  ];
  let lastError = null;
  for (const init of attempts) {
    let upload = null;
    try {
      const response = await fetchWithTimeout(mediaUrl, init, 45_000);
      if (!response.ok) {
        lastError = new Error(`Failed to download video (${response.status})`);
        continue;
      }
      const finalUrl = response.url || mediaUrl;
      assertAllowedRemoteMediaUrl(finalUrl);
      const declaredLength = Number(response.headers.get("content-length") || 0);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_VIDEO_BYTES) {
        response.body?.cancel?.().catch?.(() => {});
        throw new Error("Video exceeds GravityPort capture size limit.");
      }
      if (!response.body?.getReader) throw new Error("Remote video response is not streamable.");
      const mimeType = String(response.headers.get("content-type") || "").split(";", 1)[0].trim()
        || guessMime(finalUrl, "video") || "video/mp4";
      upload = await beginVideoUpload(
        { ...payload, mimeType },
        0,
        0,
        connection,
        { mediaUrl, finalMediaUrl: finalUrl },
      );
      const transfer = { ...upload, receivedBytes: 0, nextIndex: 0 };
      const reader = response.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        for (let offset = 0; offset < value.byteLength; offset += 3 * 1024 * 1024) {
          const chunk = value.subarray(offset, Math.min(value.byteLength, offset + 3 * 1024 * 1024));
          if (transfer.receivedBytes + chunk.byteLength > MAX_VIDEO_BYTES) {
            throw new Error("Video exceeds GravityPort capture size limit.");
          }
          await appendVideoUploadChunk(transfer, transfer.nextIndex, chunk);
          transfer.receivedBytes += chunk.byteLength;
          transfer.nextIndex += 1;
        }
      }
      if (transfer.receivedBytes < 64 * 1024) throw new Error("Downloaded video empty/too small");
      return await commitVideoUpload(transfer);
    } catch (error) {
      if (upload) await abortVideoUpload(upload).catch(() => {});
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError || new Error("Failed to download video");
}

async function appendVideoUploadChunk(transfer, index, chunkBytes) {
  const response = await fetchWithTimeout(`${transfer.baseUrl}/api/ingest/web-capture-upload/chunk`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      authorization: `Bearer ${transfer.token}`,
      "x-mosa-upload-id": transfer.uploadId,
      "x-mosa-chunk-index": String(index),
    },
    body: chunkBytes,
  }, 30_000);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `GravityPort upload chunk failed (${response.status})`);
  }
}

async function commitVideoUpload(transfer) {
  const response = await fetchWithTimeout(`${transfer.baseUrl}/api/ingest/web-capture-upload/commit`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${transfer.token}` },
    body: JSON.stringify({ uploadId: transfer.uploadId }),
  }, 90_000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `GravityPort upload commit failed (${response.status})`);
  return data;
}

async function abortVideoUpload(transfer) {
  if (!transfer?.uploadId || !transfer?.baseUrl || !transfer?.token) return;
  await fetchWithTimeout(`${transfer.baseUrl}/api/ingest/web-capture-upload/abort`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${transfer.token}` },
    body: JSON.stringify({ uploadId: transfer.uploadId }),
  }, 10_000).catch(() => null);
}

async function ingestToMosa(payload = {}, { binaryParts = null } = {}) {
  const settings = await getSettings();
  let baseUrl = normalizeBaseUrl(settings.mosaBaseUrl || DEFAULTS.mosaBaseUrl);
  let token = String(settings.mosaToken || "").trim();
  if (!token) throw new Error("Web Capture Token 未配置。请在扩展选项中填写与 GravityPort 服务相同的随机 Token。");

  const mediaKind = payload.mediaKind === "video" ? "video" : "image";
  let mediaBase64 = mediaKind === "video" ? payload.mediaBase64 : payload.imageBase64;
  let mediaBinaryParts = Array.isArray(binaryParts) && binaryParts.length ? binaryParts : null;
  let mimeType = payload.mimeType || (mediaKind === "video" ? "video/mp4" : "image/png");
  const provider = String(payload.provider || "chatgpt").trim().toLowerCase();
  if (!WEB_IMAGE_PROVIDERS.has(provider)) throw new Error("Unsupported web image provider.");
  if (mediaKind === "video" && !WEB_VIDEO_PROVIDERS.has(provider)) throw new Error("Unsupported web video provider.");

  // Prefer server-side (extension background) download for remote URLs.
  const mediaUrl = mediaKind === "video" ? payload.mediaUrl : payload.imageUrl;
  let finalMediaUrl = mediaUrl || "";
  if (!mediaBase64 && !mediaBinaryParts && mediaUrl) {
    if (!await ensureMosaAvailable(baseUrl)) {
      const repaired = await repairPairing().catch(() => null);
      if (!repaired) throw mosaUnavailableError(`无法连接 GravityPort (${baseUrl})。请确认 GravityPort App 正在运行。`);
      baseUrl = repaired.baseUrl;
      token = repaired.token;
    }
    if (mediaKind === "video") {
      return streamRemoteVideoToMosa(payload, mediaUrl, { baseUrl, token });
    }
    const fetched = await fetchMediaAsBase64(mediaUrl, { publicMedia: false, mediaKind, binary: mediaKind === "video" });
    if (mediaKind === "video" && fetched.mediaBytes) mediaBinaryParts = [fetched.mediaBytes];
    else mediaBase64 = fetched.mediaBase64;
    mimeType = fetched.mimeType || mimeType;
    finalMediaUrl = fetched.finalUrl || mediaUrl;
  }
  if (!mediaBase64 && !mediaBinaryParts) throw new Error(`No ${mediaKind} bytes to ingest.`);
  const requestPayload = captureRequestPayload(payload, { mediaKind, mimeType, mediaUrl, finalMediaUrl, provider });
  const requestIngest = () => mediaBinaryParts
    ? fetchWithTimeout(`${baseUrl}/api/ingest/web-capture-binary`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        authorization: `Bearer ${token}`,
      },
      body: binaryCaptureEnvelope(requestPayload, mediaBinaryParts),
    }, 90_000)
    : fetchWithTimeout(`${baseUrl}/api/ingest/web-capture`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ...requestPayload,
        ...(mediaKind === "video" ? { mediaBase64 } : { imageBase64: mediaBase64 }),
      }),
    }, mediaKind === "video" ? 90_000 : 30_000);

  let response;
  try {
    response = await requestIngest();
  } catch (error) {
    const repaired = await repairPairing().catch(() => null);
    if (!repaired) {
      const msg = error instanceof Error ? error.message : String(error);
      throw mosaUnavailableError(`无法连接 GravityPort (${baseUrl})：${msg}。请确认 GravityPort App 正在运行。`);
    }
    baseUrl = repaired.baseUrl;
    token = repaired.token;
    try {
      response = await requestIngest();
    } catch (retryError) {
      const msg = retryError instanceof Error ? retryError.message : String(retryError);
      throw mosaUnavailableError(`无法连接 GravityPort (${baseUrl})：${msg}。请确认 GravityPort App 正在运行。`);
    }
  }

  // Discard a failed body only when a repaired pairing replaces the response.
  // Otherwise it is read below, so the user sees MOSA's own error and status.
  if (response.status === 401 || response.status === 403) {
    const repaired = await repairPairing().catch(() => null);
    if (repaired && (repaired.baseUrl !== baseUrl || repaired.token !== token)) {
      await response.arrayBuffer().catch(() => {});
      baseUrl = repaired.baseUrl;
      token = repaired.token;
      response = await requestIngest();
    }
  }

  // A cached discovery port may later be occupied by another local service,
  // or an older MOSA runtime may no longer expose the ingest route. Repair the
  // pairing once for endpoint-level failures, but never retry normal 4xx media
  // validation errors because those belong to the current capture itself.
  if ([404, 405, 500, 502, 503, 504].includes(response.status)) {
    const repaired = await repairPairing().catch(() => null);
    if (repaired && (repaired.baseUrl !== baseUrl || repaired.token !== token)) {
      await response.arrayBuffer().catch(() => {});
      baseUrl = repaired.baseUrl;
      token = repaired.token;
      response = await requestIngest();
    }
  }

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw ingestResponseError(`GravityPort returned non-JSON (${response.status}): ${text.slice(0, 180)}`, response.status);
  }
  if (!response.ok) {
    throw ingestResponseError(data.error || `GravityPort ingest failed (${response.status})`, response.status);
  }
  return data;
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("GravityPort 地址无效。");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.username || url.password) {
    throw new Error("GravityPort 地址必须是 http://127.0.0.1:端口 或 http://localhost:端口。");
  }
  return url.origin;
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function guessMime(url, mediaKind = "image") {
  const lower = String(url).toLowerCase();
  if (mediaKind === "video") {
    if (lower.includes(".webm")) return "video/webm";
    if (lower.includes(".mov")) return "video/quicktime";
    if (lower.includes(".m4v")) return "video/x-m4v";
    if (lower.includes(".mp4")) return "video/mp4";
    return "";
  }
  if (lower.includes(".jpg") || lower.includes(".jpeg")) return "image/jpeg";
  if (lower.includes(".webp")) return "image/webp";
  if (lower.includes(".gif")) return "image/gif";
  if (lower.includes(".png")) return "image/png";
  return "";
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await migrateSettingsToLocal();
  await updateBadge();
  await refreshContextMenus();
  if (details?.reason === "install") await chrome.runtime.openOptionsPage();
});

async function updateBadge() {
  const settings = await getSettings();
  await chrome.action.setBadgeText({ text: settings.autoCapture ? "ON" : "OFF" });
  await chrome.action.setBadgeBackgroundColor({ color: settings.autoCapture ? "#84cc16" : "#71717a" });
}

// Context menus persist across service-worker restarts, so only (re)create them
// on install/update. removeAll() first avoids "Cannot create item with
// duplicate id" errors when the extension is updated or reloaded during dev.
async function refreshContextMenus() {
  if (!chrome.contextMenus) return;
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "mosa-save-image",
    title: "保存图片到 GravityPort",
    contexts: ["image"],
    documentUrlPatterns: [
      "https://chatgpt.com/*",
      "https://chat.openai.com/*",
      "https://gemini.google.com/*",
      "https://labs.google/*",
      "https://flow.google.com/*",
      "https://aistudio.google.com/*",
    ],
  });
  chrome.contextMenus.create({
    id: "mosa-save-video",
    title: "保存视频到 GravityPort",
    contexts: ["video"],
    documentUrlPatterns: [
      "https://labs.google/*",
      "https://flow.google.com/*",
      "https://aistudio.google.com/*",
    ],
  });
}

chrome.commands?.onCommand?.addListener(async (command) => {
  if (command !== "toggle-auto-capture") return;
  const current = await getSettings();
  await chrome.storage.local.set({ autoCapture: !current.autoCapture });
  await updateBadge();
});

chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area === "local" && changes.autoCapture) updateBadge();
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "mosa.capture.togglePanel" });
    if (!response?.ok) await chrome.runtime.openOptionsPage();
  } catch {
    // Google adapters intentionally keep no floating panel; settings are the
    // useful fallback instead of making the toolbar click a silent no-op.
    await chrome.runtime.openOptionsPage();
  }
});

chrome.contextMenus?.onClicked?.addListener(async (info, tab) => {
  if (!tab?.id) return;
  try {
    if (info.menuItemId === "mosa-save-video") {
      await chrome.tabs.sendMessage(tab.id, {
        type: "mosa.capture.saveVideoWithPrompt",
        videoUrl: info.srcUrl || "",
      });
      return;
    }
    if (info.menuItemId === "mosa-save-image") {
      await chrome.tabs.sendMessage(tab.id, {
        type: "mosa.capture.saveImageWithPrompt",
        imageUrl: info.srcUrl || "",
      });
    }
  } catch {
    // Page is not ready or not a supported tab — nothing to surface here.
  }
});
