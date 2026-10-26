/**
 * Jimeng (jimeng.jianying.com) adapter. Media and metadata come from the
 * site's own /mweb/v1/ JSON responses (observed read-only by
 * jimeng-page-hook.js): generation polls carry signed full-size image/video
 * URLs that expire, so the bytes must be captured when the response arrives.
 * The DOM is only used for the manual right-click save and page-local blob
 * videos. Old history records are excluded by a timestamp gate: only records
 * created after this content script started (minus a small slack) are
 * auto-captured; everything else is remembered as baseline and stays
 * manual-save only.
 */
(() => {
  const providerPolicy = globalThis.MosaProviderPolicy;
  if (!providerPolicy) return;

  const MEDIA_HOST_SUFFIXES = [".byteimg.com", ".jimeng.com", ".vlabvod.com"];
  const IMAGE_PATH_HINTS = [/\.webp($|[?#])/i, /\.png($|[?#])/i, /\.jpeg($|[?#])/i, /\.jpg($|[?#])/i, /aigc_resize/i, /tos-cn-i/i];
  const PROMPT_KEYS = ["prompt", "prompt_text", "first_prompt", "video_prompt", "image_prompt", "user_prompt", "description"];
  const MODEL_KEYS = ["model_name", "model", "model_version", "aigc_model"];
  // Live get_asset_list records carry `created_time` (seconds) on the record
  // and `create_time` on each item's common_attr (seen 2026-10-23).
  const TIME_KEYS = ["finish_time", "created_time", "create_time", "created_at", "submit_time", "c_time", "insert_time", "update_time"];
  const RECORD_ID_KEYS = ["history_record_id", "history_id", "record_id"];
  const ITEM_ID_KEYS = ["item_id", "id", "local_item_id"];
  const MAX_REFERENCE_IMAGES = 8;
  const RESIZE_PATTERN = /aigc_resize[:_-](\d{2,5})[:_-](\d{2,5})/i;
  const RESOURCE_ID_PATTERN = /\/([A-Za-z0-9_-]{8,})~tplv-/;
  const MAX_WALK_NODES = 60_000;
  const MAX_RESPONSE_TEXT = 4 * 1024 * 1024;
  // One deletion report carries at most this many item ids; a bigger batch is
  // the extension's own bug, so the tail is dropped rather than forwarded.
  const MAX_DELETION_ITEMS = 200;
  const FRESH_SLACK_MS = 120_000;
  const MIN_AUTO_IMAGE_EDGE = 512;
  const SEEN_MAX = 2048;
  const CAPTURE_CONCURRENCY = 2;

  function isMediaHost(hostname) {
    const host = String(hostname || "").toLowerCase();
    return MEDIA_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  }

  function mediaUrlInfo(value) {
    const raw = String(value || "").trim();
    if (!raw || raw.length > 4096 || !/^https:\/\//i.test(raw)) return null;
    let url;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (!isMediaHost(url.hostname)) return null;
    const resize = RESIZE_PATTERN.exec(url.pathname) || RESIZE_PATTERN.exec(raw);
    const width = resize ? Number(resize[1]) : 0;
    const height = resize ? Number(resize[2]) : 0;
    const resourceMatch = RESOURCE_ID_PATTERN.exec(url.pathname);
    const resourceId = resourceMatch ? resourceMatch[1] : "";
    const looksImage = (url.pathname.includes("~tplv-") && !/\.mp4($|[?#])/i.test(raw) && !/video/i.test(url.pathname))
      || IMAGE_PATH_HINTS.some((hint) => hint.test(url.pathname));
    const looksVideo = /\.(mp4|webm|mov|m4v)($|[?#])/i.test(raw) || /video/i.test(url.pathname);
    if (!looksImage && !looksVideo) return null;
    return {
      kind: looksVideo ? "video" : "image",
      url: url.href,
      width,
      height,
      resourceId,
    };
  }

  function decodeBase64Url(value) {
    try {
      const decoded = atob(String(value || ""));
      return decoded.startsWith("http") ? decoded : "";
    } catch {
      return "";
    }
  }

  function normalizeTimestampMs(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return null;
    if (number > 1e12) return number;
    if (number > 1e9) return number * 1000;
    return null;
  }

  function firstStringValue(object, keys, { maxLength = 8000, minLength = 1 } = {}) {
    for (const key of keys) {
      const value = object?.[key];
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length >= minLength && trimmed.length <= maxLength && !trimmed.startsWith("{")) return trimmed;
      }
    }
    return "";
  }

  function videoVariantRank(key) {
    return { video_4: 4, video_3: 3, video_2: 2, video_1: 1 }[String(key)] || 0;
  }

  // One generation item: the largest image variant, the highest-bitrate video
  // URL, identity, prompt, model and creation time found on it or its record.
  function extractJimengItem(item) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const commonAttr = item.common_attr && typeof item.common_attr === "object" ? item.common_attr : {};
    const video = item.video && typeof item.video === "object" ? item.video : {};
    const identity = String(
      firstStringValue(item, ITEM_ID_KEYS) || firstStringValue(commonAttr, ITEM_ID_KEYS) || "",
    ).slice(0, 128);

    let bestImage = null;
    const considerImage = (info) => {
      if (!info || info.kind !== "image") return;
      if (!bestImage
        || (info.width && info.height && (!bestImage.width || info.width * info.height > bestImage.width * bestImage.height))) {
        bestImage = info;
      }
    };
    const largeImages = item.image?.large_images;
    if (Array.isArray(largeImages)) {
      for (const entry of largeImages) {
        const info = mediaUrlInfo(entry?.image_url || entry?.url);
        // The live original is `aigc_resize:0:0.png` (0:0 = full size), so its
        // URL carries no usable size; take the dimensions the response states
        // (e.g. 1440x2560) instead of treating it as a 0-pixel image.
        if (info && (!info.width || !info.height)) {
          const width = Number(entry?.width) || 0;
          const height = Number(entry?.height) || 0;
          if (width > 0 && height > 0) {
            info.width = width;
            info.height = height;
          }
        }
        considerImage(info);
      }
    }
    considerImage(mediaUrlInfo(item.image?.orig_image?.url));
    considerImage(mediaUrlInfo(item.image?.url));

    let bestVideo = null;
    const considerVideo = (info, rank) => {
      if (!info || info.kind !== "video") return;
      if (!bestVideo || rank > bestVideo.rank) bestVideo = { ...info, rank };
    };
    considerVideo(mediaUrlInfo(commonAttr.transcoded_video?.origin?.video_url), 1);
    considerVideo(mediaUrlInfo(video.transcoded_video?.origin?.video_url), 1);
    considerVideo(mediaUrlInfo(video.play_url), 0);
    considerVideo(mediaUrlInfo(video.download_url), 0);
    considerVideo(mediaUrlInfo(video.url), 0);
    // The watermark-free high-bitrate download lives inside video_model JSON
    // as base64 main_url fields (video_4 highest … video_1 lowest).
    if (typeof video.video_model === "string" && video.video_model.length <= 512_000) {
      try {
        const model = JSON.parse(video.video_model);
        const list = model?.video_list && typeof model.video_list === "object" ? model.video_list : {};
        for (const [key, entry] of Object.entries(list)) {
          const url = decodeBase64Url(entry?.main_url);
          if (url) considerVideo(mediaUrlInfo(url), videoVariantRank(key) + 1);
        }
      } catch {
        // Malformed video_model; the structured fields above still apply.
      }
    }

    if (!bestImage && !bestVideo) return null;
    return {
      identity,
      image: bestImage,
      video: bestVideo,
      width: Number(largeImages?.[0]?.width || bestImage?.width || commonAttr.width || video.width) || 0,
      height: Number(largeImages?.[0]?.height || bestImage?.height || commonAttr.height || video.height) || 0,
      durationSeconds: Number(commonAttr.duration || video.duration) || 0,
      prompt: firstStringValue(item, PROMPT_KEYS) || firstStringValue(commonAttr, PROMPT_KEYS),
      // Live responses nest the model under aigc_image_params.<kind>_params.model_config.
      model: firstStringValue(item, MODEL_KEYS) || nestedModelName(item.aigc_image_params),
      referenceUrls: [],
      capturedAtMs: null,
      status: "",
    };
  }

  function nestedModelName(params) {
    if (!params || typeof params !== "object") return "";
    for (const value of Object.values(params)) {
      const name = value && typeof value === "object" ? value.model_config?.model_name : "";
      if (typeof name === "string" && name.trim()) return name.trim().slice(0, 120);
    }
    return "";
  }

  /**
   * Reference images for one generation record, in the order `resources`
   * lists them (observed on the live API 2026-10-25: `resources[]` carries
   * `type: "image"` entries with `image_info.image_url`, max 3 per record;
   * the same images also appear under task.aigc_image_params…, which is
   * ignored here). Frame sources under task (first/last frame of a video
   * generation) are a fallback. Dedup by resource id, cap at 8.
   */
  function jimengReferenceInfos(record) {
    const urls = [];
    const byKey = new Set();
    const addUrl = (value) => {
      const info = mediaUrlInfo(value);
      if (!info || info.kind !== "image") return;
      const key = info.resourceId || info.url;
      if (byKey.has(key)) return;
      byKey.add(key);
      urls.push(info.url);
    };
    const resources = Array.isArray(record.resources) ? record.resources : [];
    for (const resource of resources) {
      if (!resource || typeof resource !== "object" || resource.type !== "image") continue;
      const imageInfo = resource.image_info && typeof resource.image_info === "object" ? resource.image_info : {};
      if (imageInfo.image_url) {
        addUrl(imageInfo.image_url);
        continue;
      }
      const coverMap = imageInfo.cover_url_map && typeof imageInfo.cover_url_map === "object" ? imageInfo.cover_url_map : {};
      const largest = Object.entries(coverMap)
        .filter(([size]) => Number(size) > 0)
        .sort((a, b) => Number(b[0]) - Number(a[0]))[0];
      if (largest) addUrl(largest[1]);
    }
    const task = record.task && typeof record.task === "object" ? record.task : {};
    const videoInputs = task.original_input && typeof task.original_input === "object" && Array.isArray(task.original_input.video_gen_inputs)
      ? task.original_input.video_gen_inputs
      : [];
    const frames = [
      task.first_frame_image,
      task.last_frame_image,
      ...videoInputs.flatMap((input) => [input?.first_frame_image, input?.last_frame_image]),
    ];
    for (const frame of frames) {
      if (frame && typeof frame === "object") addUrl(String(frame.image_url || frame.url || ""));
    }
    return urls.slice(0, MAX_REFERENCE_IMAGES);
  }

  /**
   * Walk one /mweb/v1/ JSON response and extract finished generation items.
   * Record containers are recognized structurally (objects carrying an
   * item_list), so poll responses, history listings and conversation feeds
   * all flow through the same path without pinning endpoint names.
   */
  function extractJimengResponse(text) {
    let root;
    try {
      root = JSON.parse(String(text || ""));
    } catch {
      return { records: [] };
    }
    const records = [];
    let visited = 0;
    const walk = (node, recordContext, keyHint = "") => {
      if (!node || typeof node !== "object" || visited >= MAX_WALK_NODES) return;
      visited += 1;
      let context = recordContext;
      if (Array.isArray(node)) {
        for (const entry of node) walk(entry, context);
        return;
      }
      if (Array.isArray(node.item_list)) {
        const capturedAtMs = (() => {
          for (const key of TIME_KEYS) {
            const direct = normalizeTimestampMs(node[key]);
            if (direct !== null) return direct;
            const nested = node.task && typeof node.task === "object" ? normalizeTimestampMs(node.task[key === "finish_time" ? "finish_time" : key]) : null;
            if (nested !== null) return nested;
          }
          return null;
        })();
        // get_history_by_ids answers with the record keyed by its id, so the
        // parent map key is the record id when the object carries none itself.
        const keyHintId = /^[A-Za-z0-9_-]{6,128}$/.test(keyHint) ? keyHint : "";
        const recordId = String(firstStringValue(node, RECORD_ID_KEYS) || keyHintId).slice(0, 128);
        context = {
          capturedAtMs,
          recordId,
          prompt: firstStringValue(node, PROMPT_KEYS),
          model: firstStringValue(node, MODEL_KEYS),
        };
        for (const item of node.item_list) {
          const extracted = extractJimengItem(item);
          if (!extracted) continue;
          extracted.capturedAtMs = context.capturedAtMs ?? normalizeTimestampMs(item.common_attr?.create_time);
          extracted.prompt = extracted.prompt || context.prompt;
          extracted.model = extracted.model || context.model;
          extracted.historyId = context.recordId;
          extracted.generationStatus = node.status === 30 ? "failed" : node.status === 10 || node.status === 50 ? "completed" : "in_progress";
          extracted.referenceUrls = jimengReferenceInfos(node);
          records.push(extracted);
        }
      }
      for (const [key, value] of Object.entries(node)) {
        if (value && typeof value === "object") walk(value, context, key);
      }
    };
    walk(root, null);
    return { records };
  }

  function isFreshGeneration(capturedAtMs, sessionStartMs, slackMs = FRESH_SLACK_MS) {
    if (capturedAtMs === null || !Number.isFinite(capturedAtMs)) return false;
    return capturedAtMs >= sessionStartMs - slackMs;
  }

  function resourceKeyForUrl(value) {
    const info = mediaUrlInfo(value);
    return info?.resourceId || "";
  }

  // Test seam: the extraction core runs in a plain sandbox without Chrome.
  globalThis.MosaJimengCapture = Object.freeze({
    extractJimengResponse,
    extractJimengItem,
    isFreshGeneration,
    mediaUrlInfo,
    resourceKeyForUrl,
    isMediaHost,
  });
  if (typeof chrome === "undefined" || !chrome?.runtime?.id) return;

  let autoCapture = false;
  let sessionStartMs = Date.now();
  let hookPort = null;
  let providerContextLost = false;
  const seen = new Set();
  const baseline = new Set();
  const learnedByKey = new Map();
  let captureInFlight = 0;
  const captureWaiters = [];
  let toastTimer = null;
  let scanTimer = null;
  let scanInterval = null;

  // Diagnostic lines for the user's live-site test; URLs lose their query
  // (signatures) and no prompt text or account data is printed.
  function debugLog(...parts) {
    try { console.info("[GravityPort] jimeng", ...parts); } catch { /* console unavailable */ }
  }

  function urlForLog(value) {
    try {
      const url = new URL(String(value || ""));
      return `${url.host}${url.pathname.slice(0, 120)}`;
    } catch {
      return "";
    }
  }

  function rememberSeen(key) {
    if (!key) return;
    seen.delete(key);
    seen.add(key);
    while (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
  }

  function showToast(message, isError = false, durationMs = 3600) {
    let toast = document.getElementById("mosa-provider-capture-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "mosa-provider-capture-toast";
      Object.assign(toast.style, {
        position: "fixed",
        right: "20px",
        bottom: "20px",
        zIndex: "2147483647",
        maxWidth: "360px",
        padding: "10px 12px",
        borderRadius: "10px",
        font: "13px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
        boxShadow: "0 8px 30px rgba(0,0,0,.22)",
        color: "#fff",
      });
      (document.body || document.documentElement).appendChild(toast);
    }
    toast.replaceChildren(document.createTextNode(String(message || "")));
    toast.style.background = isError ? "#991b1b" : "#18181b";
    toast.setAttribute("role", isError ? "alert" : "status");
    toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = durationMs > 0 ? setTimeout(() => { toast.hidden = true; }, durationMs) : null;
  }

  function extensionAlive() {
    try {
      return typeof chrome === "object" && Boolean(chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function markProviderContextLost() {
    if (providerContextLost) return;
    providerContextLost = true;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = null;
    if (scanInterval) clearInterval(scanInterval);
    scanInterval = null;
    showToast("GravityPort 扩展已更新，请刷新此网页恢复自动收录。", true, 0);
  }

  async function withCaptureSlot(task) {
    if (captureInFlight >= CAPTURE_CONCURRENCY) {
      await new Promise((resolveSlot) => captureWaiters.push(resolveSlot));
    }
    captureInFlight += 1;
    try {
      return await task();
    } finally {
      captureInFlight -= 1;
      captureWaiters.shift()?.();
    }
  }

  function mimeTypeForUrl(mediaUrl, mediaKind = "image") {
    const extension = String(mediaUrl || "").match(/\.([a-z0-9]+)(?:$|[?#])/i)?.[1]?.toLowerCase();
    if (mediaKind === "video") {
      if (extension === "webm") return "video/webm";
      if (extension === "mov") return "video/quicktime";
      if (extension === "m4v") return "video/x-m4v";
      return "video/mp4";
    }
    if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
    if (extension === "webp") return "image/webp";
    if (extension === "gif") return "image/gif";
    return "image/png";
  }

  function sendIngest(payload) {
    return chrome.runtime.sendMessage({ type: "mosa.ingest", payload });
  }

  // The page hook saw the site confirm a delete (remove_history). Hand the
  // deleted item ids to the background worker so the app can move matching
  // captures to its trash. Best effort: a failed report (app closed, worker
  // restarted) is dropped — the site already deleted the work, and the next
  // deletion reports naturally.
  function reportProviderDeletions(rawItems) {
    const items = [];
    const seen = new Set();
    for (const entry of Array.isArray(rawItems) ? rawItems : []) {
      const itemId = String(entry?.itemId || "").trim();
      if (!/^\d{1,32}$/.test(itemId) || seen.has(itemId)) continue;
      seen.add(itemId);
      items.push({ recordId: String(entry?.recordId || "").slice(0, 128), itemId });
      if (items.length >= MAX_DELETION_ITEMS) break;
    }
    if (!items.length) return;
    chrome.runtime.sendMessage({ type: "mosa.reportProviderDeletions", payload: { provider: "jimeng", items } })
      .catch(() => {});
  }

  function basePayload(record, mediaKind, mediaUrl) {
    return {
      provider: "jimeng",
      mediaKind,
      mimeType: mimeTypeForUrl(mediaUrl, mediaKind),
      pageUrl: location.href,
      promptStatus: record.prompt ? "provider-visible-prompt" : "not-available",
      promptSource: record.prompt ? "jimeng-visible-prompt" : "",
      prompt: record.prompt || "",
      model: record.model || "",
      captureMode: "automatic",
      capturedAt: new Date().toISOString(),
      conversationId: record.historyId || "",
      generationContextId: record.historyId || "",
      providerAssetId: record.identity || resourceKeyForUrl(mediaUrl),
      generationStatus: record.generationStatus || "completed",
      ...(mediaKind === "video"
        ? {
          mediaUrl,
          width: record.width || 0,
          height: record.height || 0,
          durationSeconds: record.durationSeconds > 0 ? record.durationSeconds : null,
        }
        : {
          imageUrl: mediaUrl,
          width: record.width || 0,
          height: record.height || 0,
        }),
    };
  }

  async function captureReference(referenceUrl, record) {
    try {
      await sendIngest({
        provider: "jimeng",
        mediaKind: "image",
        mimeType: mimeTypeForUrl(referenceUrl, "image"),
        imageUrl: referenceUrl,
        pageUrl: location.href,
        promptStatus: "not-available",
        captureMode: "automatic",
        capturedAt: new Date().toISOString(),
        conversationId: record.historyId || "",
        generationContextId: record.historyId || "",
        isReference: true,
        providerAssetId: `ref:${resourceKeyForUrl(referenceUrl) || referenceUrl}`.slice(0, 160),
      });
    } catch {
      // An optional reference failure never blocks the generated output.
    }
  }

  // The app attaches references to the generation at the moment the finished
  // asset lands (matched by generation_context_id), so every reference of a
  // record must be ingested before the record's media. References of one
  // record go out in parallel and are sent once per history id. A later scan
  // that sees the same record while a reference is still uploading waits for
  // that upload too, so its media can never overtake the references.
  const referenceUploads = new Map();
  async function captureRecordReferences(record) {
    const historyId = record.historyId || "";
    await Promise.all((record.referenceUrls || []).map((referenceUrl) => {
      const key = `jimeng:ref:${historyId}:${resourceKeyForUrl(referenceUrl) || referenceUrl}`;
      const pending = referenceUploads.get(key);
      if (pending) return pending;
      if (seen.has(key)) return undefined;
      rememberSeen(key);
      const upload = captureReference(referenceUrl, record).finally(() => referenceUploads.delete(key));
      referenceUploads.set(key, upload);
      return upload;
    }));
  }

  async function captureRecordWithReferences(record, mediaKind) {
    await captureRecordReferences(record);
    return captureRecordMedia(record, mediaKind);
  }

  async function captureRecordMedia(record, mediaKind) {
    return withCaptureSlot(async () => {
      const media = mediaKind === "video" ? record.video : record.image;
      if (!media) return { ok: false };
      const key = `jimeng:${mediaKind}:${record.identity || media.url}`;
      if (seen.has(key)) return { ok: true };
      rememberSeen(key);
      const payload = basePayload(record, mediaKind, media.url);
      try {
        const response = await sendIngest(payload);
        if (!response?.ok) {
          seen.delete(key);
          return { ok: false, error: response?.error };
        }
        return { ok: true };
      } catch (error) {
        seen.delete(key);
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  function mergeLearned(record) {
    if (!record.image && !record.video) return;
    const key = record.identity || record.image?.resourceId || record.video?.resourceId || "";
    if (!key) return;
    const previous = learnedByKey.get(key) || { image: null, video: null, prompt: "", model: "", historyId: "", generationStatus: "", referenceUrls: [], width: 0, height: 0, durationSeconds: 0, identity: record.identity, capturedAtMs: null };
    const merged = {
      identity: record.identity || previous.identity,
      image: (!previous.image || (record.image && record.image.width * record.image.height > previous.image.width * previous.image.height)) && record.image ? record.image : previous.image,
      video: record.video || previous.video,
      prompt: record.prompt || previous.prompt,
      model: record.model || previous.model,
      historyId: record.historyId || previous.historyId,
      generationStatus: record.generationStatus || previous.generationStatus,
      referenceUrls: record.referenceUrls.length ? record.referenceUrls : previous.referenceUrls,
      width: record.width || previous.width,
      height: record.height || previous.height,
      durationSeconds: record.durationSeconds || previous.durationSeconds,
      capturedAtMs: record.capturedAtMs ?? previous.capturedAtMs,
    };
    learnedByKey.set(key, merged);
    while (learnedByKey.size > SEEN_MAX) learnedByKey.delete(learnedByKey.keys().next().value);
  }

  function attemptAutomaticCapture() {
    if (!autoCapture) return;
    for (const record of learnedByKey.values()) {
      const mediaKey = record.identity || record.image?.resourceId || record.video?.resourceId || "";
      if (!mediaKey) continue;
      if (baseline.has(mediaKey)) continue;
      if (!isFreshGeneration(record.capturedAtMs, sessionStartMs)) {
        // Old history (listing pages, lazy-loaded past work): baseline it so
        // the same item seen again in a later response stays out of capture.
        baseline.add(mediaKey);
        debugLog("history record skipped", mediaKey, record.capturedAtMs ? "older than this page" : "no timestamp");
        continue;
      }
      const hasImage = record.image && Math.min(record.image.width || 0, record.image.height || 0) >= MIN_AUTO_IMAGE_EDGE;
      if (record.image && !hasImage) debugLog("image too small or size unknown, waiting", mediaKey, `${record.image.width || 0}x${record.image.height || 0}`);
      const hasVideo = Boolean(record.video);
      if (!hasImage && !hasVideo) continue;
      if (hasVideo && !seen.has(`jimeng:video:${mediaKey}`)) {
        debugLog("new video, capturing", mediaKey, urlForLog(record.video.url));
        void captureRecordWithReferences(record, "video");
      }
      if (hasImage && !seen.has(`jimeng:image:${mediaKey}`)) {
        debugLog("new image, capturing", mediaKey, urlForLog(record.image.url), `${record.image.width || 0}x${record.image.height || 0}`);
        void captureRecordWithReferences(record, "image");
      }
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      if (!extensionAlive()) {
        markProviderContextLost();
        return;
      }
      attemptAutomaticCapture();
    }, 300);
  }

  function onHookResponse(text) {
    if (typeof text !== "string" || !text || text.length > MAX_RESPONSE_TEXT) return;
    const { records } = extractJimengResponse(text);
    if (records.length) debugLog("api response", records.length, "generation items");
    for (const record of records) mergeLearned(record);
    scheduleScan();
  }

  function connectHookPort() {
    window.addEventListener("message", (event) => {
      if (event.origin !== location.origin) return;
      const data = event.data;
      if (data?.source !== "mosa-jimeng-hook" || data.type !== "hook-port") return;
      const [port] = event.ports || [];
      if (!port) return;
      if (hookPort) {
        try { hookPort.close(); } catch { /* replaced */ }
      }
      hookPort = port;
      port.addEventListener("message", (portEvent) => {
        const message = portEvent.data;
        if (message?.type === "jimeng-api-response") onHookResponse(String(message.text || ""));
        if (message?.type === "jimeng-deletion-observed" && message.success === true) {
          reportProviderDeletions(message.items);
        }
      });
      port.start?.();
    });
    // The page hook is installed at document_start; this script may wake much
    // later (or after a service-worker restart), so ask for a fresh port.
    try {
      window.postMessage({ source: "mosa-jimeng-content", type: "hook-port-request" }, location.origin);
    } catch {
      // The page may not be ready; the hook also re-offers on its own.
    }
  }

  function blobVideoSourceFor(video) {
    const direct = video?.currentSrc || video?.src || "";
    const nested = Array.from(video?.children || []).find((child) => String(child?.tagName || "").toLowerCase() === "source")?.src || "";
    const raw = String(direct || nested).trim();
    if (!raw.startsWith("blob:")) return null;
    try {
      const url = new URL(raw);
      if (url.origin !== location.origin) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  async function sendChunkedVideo(payload, blob) {
    const transferId = `video-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const totalChunks = Math.ceil(blob.size / (3 * 1024 * 1024));
    let begun = false;
    try {
      const begin = await chrome.runtime.sendMessage({
        type: "mosa.beginVideoTransfer",
        transferId,
        totalBytes: blob.size,
        totalChunks,
        payload,
      });
      if (!begin?.ok) return begin;
      begun = true;
      for (let index = 0; index < totalChunks; index += 1) {
        const start = index * 3 * 1024 * 1024;
        const end = Math.min(blob.size, start + 3 * 1024 * 1024);
        const chunkBase64 = arrayBufferToBase64(await blob.slice(start, end).arrayBuffer());
        const response = await chrome.runtime.sendMessage({
          type: "mosa.videoTransferChunk",
          transferId,
          index,
          chunkBase64,
        });
        if (!response?.ok) return response;
      }
      return chrome.runtime.sendMessage({ type: "mosa.commitVideoTransfer", transferId });
    } finally {
      if (begun) {
        chrome.runtime.sendMessage({ type: "mosa.abortVideoTransfer", transferId }).catch(() => {});
      }
    }
  }

  function manualPayload(mediaKind, mediaUrl, { prompt = "", model = "", width = 0, height = 0, identity = "", historyId = "" } = {}) {
    const resourceId = resourceKeyForUrl(mediaUrl) || identity;
    return {
      provider: "jimeng",
      mediaKind,
      mimeType: mimeTypeForUrl(mediaUrl, mediaKind),
      pageUrl: location.href,
      promptStatus: prompt ? "provider-visible-prompt" : "not-available",
      promptSource: prompt ? "jimeng-visible-prompt" : "",
      prompt,
      model,
      captureMode: "manual",
      capturedAt: new Date().toISOString(),
      conversationId: historyId,
      generationContextId: historyId,
      providerAssetId: identity || resourceId,
      generationStatus: "completed",
      ...(mediaKind === "video"
        ? { mediaUrl, width, height }
        : { imageUrl: mediaUrl, width, height }),
    };
  }

  // Manual saves prefer the largest variant this session has learned for the
  // clicked media (detail dialogs carry the signed full-size URL).
  function learnedVariantFor(mediaKind, clickedUrl) {
    const resourceId = resourceKeyForUrl(clickedUrl);
    if (!resourceId) return null;
    for (const record of learnedByKey.values()) {
      const candidate = mediaKind === "video" ? record.video : record.image;
      if (candidate && candidate.resourceId === resourceId) return { record, candidate };
    }
    return null;
  }

  async function loadProviderSettings() {
    try {
      const response = await chrome.runtime?.sendMessage?.({ type: "mosa.getSettings" });
      if (response?.ok && response.settings) {
        autoCapture = response.settings.autoCapture !== false;
        return;
      }
    } catch {
      // Fall back to the persistent local preference below.
    }
    try {
      const stored = await chrome.storage?.local?.get?.({ autoCapture });
      if (stored) autoCapture = stored.autoCapture !== false;
    } catch {
      // Keep the in-memory default.
    }
  }

  function updateWatchdog() {
    if (scanInterval) clearInterval(scanInterval);
    scanInterval = null;
    if (!autoCapture) return;
    scanInterval = setInterval(() => {
      if (!extensionAlive()) {
        markProviderContextLost();
        return;
      }
      scheduleScan();
    }, 5_000);
  }

  chrome.runtime?.onMessage?.addListener?.((message, _sender, sendResponse) => {
    if (!message || !["mosa.capture.saveImageWithPrompt", "mosa.capture.saveVideoWithPrompt"].includes(message.type)) return false;
    const videoRequest = message.type === "mosa.capture.saveVideoWithPrompt";
    (async () => {
      const clickedUrl = String((videoRequest ? message.videoUrl : message.imageUrl) || "");
      if (videoRequest) {
        const learned = learnedVariantFor("video", clickedUrl);
        const mediaUrl = learned?.candidate?.url
          || (mediaUrlInfo(clickedUrl)?.kind === "video" ? clickedUrl : "");
        if (mediaUrl) {
          const payload = manualPayload("video", mediaUrl, {
            prompt: learned?.record.prompt || "",
            model: learned?.record.model || "",
            width: learned?.record.width || 0,
            height: learned?.record.height || 0,
            identity: learned?.record.identity || "",
            historyId: learned?.record.historyId || "",
          });
          if (learned?.record?.referenceUrls?.length) await captureRecordReferences(learned.record);
          const response = await sendIngest(payload);
          showToast(response?.ok ? "已保存到 GravityPort" : (response?.error || "保存失败"), !response?.ok);
          sendResponse(response || { ok: false });
          return;
        }
        // Page-local blob videos (video players driven by MSE): fetch the
        // bytes here and transfer them in chunks, exactly like Flow does.
        const blobVideo = Array.from(document.querySelectorAll?.("video") || [])
          .find((candidate) => blobVideoSourceFor(candidate) === clickedUrl.trim())
          || (clickedUrl.trim().startsWith("blob:") ? document.querySelector("video") : null);
        const blobUrl = blobVideo ? blobVideoSourceFor(blobVideo) : "";
        if (blobUrl && blobVideo && Number(blobVideo.readyState || 0) >= 1 && Number(blobVideo.videoWidth || 0) >= 128) {
          const response = await fetch(blobUrl, { credentials: "same-origin", cache: "no-cache" });
          if (!response.ok) throw new Error(`Video download failed (${response.status})`);
          const blob = await response.blob();
          if (!blob || blob.size < 1024) throw new Error("Downloaded video empty/too small");
          const payload = manualPayload("video", blobUrl, {
            width: Number(blobVideo.videoWidth || 0),
            height: Number(blobVideo.videoHeight || 0),
          });
          delete payload.mediaUrl;
          payload.mimeType = blob.type || payload.mimeType;
          payload.localMediaIdentity = blobUrl;
          payload.durationSeconds = Number.isFinite(Number(blobVideo.duration)) ? Number(blobVideo.duration) : null;
          const result = await sendChunkedVideo(payload, blob);
          showToast(result?.ok ? "已保存到 GravityPort" : (result?.error || "保存失败"), !result?.ok);
          sendResponse(result || { ok: false });
          return;
        }
        showToast("请选择支持站点中的生成视频。", true);
        sendResponse({ ok: false, error: "请选择支持站点中的生成视频。" });
        return;
      }
      const learned = learnedVariantFor("image", clickedUrl);
      const info = mediaUrlInfo(clickedUrl);
      if (!learned && !info) {
        showToast("请选择支持站点中的生成图片。", true);
        sendResponse({ ok: false, error: "请选择支持站点中的生成图片。" });
        return;
      }
      const mediaUrl = learned?.candidate?.url || info.url;
      const payload = manualPayload("image", mediaUrl, {
        prompt: learned?.record.prompt || "",
        model: learned?.record.model || "",
        width: learned?.record.width || info?.width || 0,
        height: learned?.record.height || info?.height || 0,
        identity: learned?.record.identity || "",
        historyId: learned?.record.historyId || "",
      });
      if (learned?.record?.referenceUrls?.length) await captureRecordReferences(learned.record);
      const response = await sendIngest(payload);
      showToast(response?.ok ? "已保存到 GravityPort" : (response?.error || "保存失败"), !response?.ok);
      sendResponse(response || { ok: false });
    })().catch((error) => {
      const errorText = error instanceof Error ? error.message : String(error);
      showToast(errorText, true);
      sendResponse({ ok: false, error: errorText });
    });
    return true;
  });

  loadProviderSettings().then(() => {
    connectHookPort();
    updateWatchdog();
    scheduleScan();
  }).catch(() => {});

  chrome.storage?.onChanged?.addListener?.((changes, area) => {
    if (area !== "local") return;
    if (changes.autoCapture) {
      autoCapture = changes.autoCapture.newValue !== false;
      updateWatchdog();
      if (autoCapture) scheduleScan();
    }
    if (changes.mosaBaseUrl || changes.mosaToken) seen.clear();
  });
})();
