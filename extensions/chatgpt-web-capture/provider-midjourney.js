/**
 * Midjourney (www.midjourney.com) adapter. The /imagine feed renders each
 * generated image grid from cdn.midjourney.com preview WebPs (…_640_…), while
 * the full-size PNG sits at the same path without the preview suffix. Page
 * fetches of the original are CORS/403-blocked, so the bytes are downloaded
 * in the extension background with the browser's cookies; when that fails the
 * preview WebP is archived instead and the asset is marked
 * source_media_variant="preview". Old history rendered below the fold must
 * not flood the library: job ids that already exist when this script injects,
 * job ids arriving in scroll-triggered batches, or three-or-more new job ids
 * in one tick are treated as history (baseline); only single fresh job cards
 * appearing outside a scroll window are auto-captured. Manual right-click
 * saves are always allowed.
 */
(() => {
  const providerPolicy = globalThis.MosaProviderPolicy;
  if (!providerPolicy) return;

  const CDN_HOST = "cdn.midjourney.com";
  // Job ids are UUIDs with hyphens on the live site (e.g. 28db0dbe-289a-...);
  // the hyphen-less form is accepted too.
  const JOB_ID_PATTERN = /^[0-9a-f]{8}(?:-?[0-9a-f]{4}){3}-?[0-9a-f]{12}$/i;
  // Live previews are 0_<n>_640_N.webp; keep any <width>_<suffix> variant.
  const PREVIEW_FILE_PATTERN = /^0_(\d+)(_\d+_[A-Za-z0-9]+)?\.(webp|png|jpe?g)$/i;
  const VIDEO_FILE_PATTERN = /\.(mp4|webm|mov|m4v)$/i;
  const MIN_VISIBLE_AREA = 96 * 96;
  const MIN_EDGE = 256;
  const PROMPT_MAX_ANCESTORS = 10;
  const PROMPT_MAX_CHARS = 8000;
  const PROMPT_MIN_CHARS = 4;
  const SCROLL_BASELINE_WINDOW_MS = 1200;
  // History renders a moment after the script starts (the first scan can see
  // 0 jobs); anything appearing within this window after load is history.
  const LOAD_BASELINE_WINDOW_MS = 8000;
  const scriptStartedAtMs = Date.now();
  const BATCH_BASELINE_JOB_CARDS = 3;
  const SEEN_MAX = 2048;
  const CAPTURE_CONCURRENCY = 2;

  function parseMidjourneyMediaUrl(value) {
    const raw = String(value || "").trim();
    if (!raw.startsWith("https://")) return null;
    let url;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.hostname.toLowerCase() !== CDN_HOST) return null;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return null;
    const jobId = segments[0];
    if (!JOB_ID_PATTERN.test(jobId)) return null;
    const fileName = segments[segments.length - 1];
    const preview = PREVIEW_FILE_PATTERN.exec(fileName);
    if (preview) {
      const index = Number(preview[1]);
      const originalUrl = `${url.origin}/${jobId}/0_${index}.png`;
      return { kind: "image", jobId, index, isPreview: Boolean(preview[2]), url: url.href, originalUrl };
    }
    if (VIDEO_FILE_PATTERN.test(fileName)) {
      return { kind: "video", jobId, index: 0, isPreview: false, url: url.href, originalUrl: url.href };
    }
    return null;
  }

  function midjourneyAssetIdentity(info) {
    return info ? `${info.jobId}:${info.index}` : "";
  }

  // Test seam for the pure URL + baseline rules.
  globalThis.MosaMidjourneyCapture = Object.freeze({
    parseMidjourneyMediaUrl,
    midjourneyAssetIdentity,
    isScrollBaselineInsertion(nowMs, lastScrollAtMs) {
      return Number.isFinite(lastScrollAtMs) && nowMs - lastScrollAtMs <= SCROLL_BASELINE_WINDOW_MS;
    },
    isBatchBaselineInsertion(newJobCount) {
      return Number(newJobCount || 0) >= BATCH_BASELINE_JOB_CARDS;
    },
  });
  if (typeof chrome === "undefined" || !chrome?.runtime?.id) return;

  let autoCapture = false;
  let providerContextLost = false;
  let firstScanDone = false;
  let lastScrollAtMs = -Infinity;
  let scanTimer = null;
  let scanInterval = null;
  let observer = null;
  let toastTimer = null;
  let lastProviderUrl = location.href;
  const seen = new Set();
  const baseline = new Set();
  let captureInFlight = 0;
  const captureWaiters = [];

  // Diagnostic lines for the user's live-site test; never includes cookies,
  // signatures or prompt text.
  function debugLog(...parts) {
    try { console.info("[GravityPort] midjourney", ...parts); } catch { /* console unavailable */ }
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
    observer?.disconnect();
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

  function elementAttribute(node, name) {
    try {
      return String(node?.getAttribute?.(name) || "").trim();
    } catch {
      return "";
    }
  }

  function isExcludedFromPromptText(node) {
    const tag = String(node?.tagName || "").toLowerCase();
    return ["button", "a", "input", "textarea", "select", "option", "script", "style", "svg"].includes(tag)
      || elementAttribute(node, "aria-hidden").toLowerCase() === "true";
  }

  function visibleTextFromNode(node) {
    const parts = [];
    let visited = 0;
    function visit(current) {
      if (!current || visited >= 2_000) return;
      if (current.nodeType === 3) {
        const value = String(current.nodeValue || "").replace(/\s+/g, " ").trim();
        if (value) parts.push(value);
        return;
      }
      if (current.nodeType !== 1) return;
      visited += 1;
      if (isExcludedFromPromptText(current)) return;
      const style = typeof getComputedStyle === "function" ? getComputedStyle(current) : null;
      if (style && (style.display === "none" || style.visibility === "hidden")) return;
      for (const child of Array.from(current.childNodes || [])) visit(child);
    }
    visit(node);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  function jobIdsUnder(root) {
    const ids = new Set();
    for (const img of root?.querySelectorAll?.("img") || []) {
      const info = parseMidjourneyMediaUrl(img.currentSrc || img.src || "");
      if (info) ids.add(info.jobId);
    }
    return ids;
  }

  // The prompt (with its --ar/--v parameters kept verbatim) sits in the text
  // of the job card around the image grid. Climb ancestors until the subtree
  // holds exactly this one job, then take that container's visible text.
  function promptForImage(img, jobId) {
    let node = img;
    for (let depth = 0; node && depth < PROMPT_MAX_ANCESTORS; depth += 1) {
      const parent = node.parentElement;
      if (!parent) return "";
      const ids = jobIdsUnder(parent);
      if (ids.size === 1 && ids.has(jobId)) {
        const text = visibleTextFromNode(parent);
        if (text.length >= PROMPT_MIN_CHARS && text.length <= PROMPT_MAX_CHARS) {
          return text.replace(/^(?:play|pause|download|copy link|open in discord|more options|variations?|upscale[sd]?)\s*/i, "").trim();
        }
        if (text.length > PROMPT_MAX_CHARS) return "";
      }
      if (ids.size > 1) return "";
      node = parent;
    }
    return "";
  }

  function isVisibleMedia(media, { minEdge = MIN_EDGE } = {}) {
    if (!(media instanceof HTMLImageElement) && !(media instanceof HTMLVideoElement)) return false;
    if (media instanceof HTMLImageElement && !media.complete) return false;
    if (media instanceof HTMLVideoElement && Number(media.readyState || 0) < 1) return false;
    const width = Number((media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth) || media.width || 0);
    const height = Number((media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight) || media.height || 0);
    if (width < minEdge || height < minEdge) return false;
    const rect = media.getBoundingClientRect?.();
    if (!rect || rect.width < 1 || rect.height < 1) return false;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return false;
    if (Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0))
      * Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0)) < MIN_VISIBLE_AREA) return false;
    const style = getComputedStyle(media);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
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

  async function sendIngest(payload) {
    return chrome.runtime.sendMessage({ type: "mosa.ingest", payload });
  }

  function basePayload(mediaKind, captureMode) {
    return {
      provider: "midjourney",
      mediaKind,
      mimeType: mediaKind === "video" ? "video/mp4" : "image/webp",
      pageUrl: location.href,
      promptStatus: "not-available",
      promptSource: mediaKind === "video" ? "provider-visible-video" : "provider-visible-image",
      captureMode,
      capturedAt: new Date().toISOString(),
      generationStatus: "completed",
    };
  }

  async function captureImage(img, info, captureMode) {
    return withCaptureSlot(async () => {
      const identity = midjourneyAssetIdentity(info);
      const key = `midjourney:image:${identity}`;
      const automatic = captureMode === "automatic";
      if (automatic && seen.has(key)) return { ok: true };
      if (automatic) rememberSeen(key);
      const prompt = img ? promptForImage(img, info.jobId) : "";
      const payload = basePayload("image", captureMode);
      payload.providerAssetId = identity;
      payload.conversationId = info.jobId;
      payload.generationContextId = info.jobId;
      payload.sourceMediaUrl = info.url;
      payload.width = Number((img instanceof HTMLImageElement ? img.naturalWidth || img.width : 0) || 0);
      payload.height = Number((img instanceof HTMLImageElement ? img.naturalHeight || img.height : 0) || 0);
      if (prompt) {
        payload.prompt = prompt;
        payload.promptStatus = "provider-visible-prompt";
        payload.promptSource = "midjourney-visible-prompt";
      }
      // Full-size PNGs are cookie-gated; the background (with host
      // permissions) downloads them. Fall back to the preview WebP and mark
      // the capture as preview when the original is unavailable.
      let original = null;
      try {
        original = await chrome.runtime.sendMessage({
          type: "mosa.fetchMidjourneyOriginal",
          previewUrl: info.url,
        });
      } catch {
        original = null;
      }
      if (original?.ok && typeof original.imageBase64 === "string" && original.imageBase64) {
        payload.imageBase64 = original.imageBase64;
        payload.mimeType = original.mimeType || "image/png";
        payload.finalMediaUrl = original.finalUrl || info.originalUrl;
        payload.mediaVariant = "original";
        debugLog("original fetched", `${info.jobId}:${info.index}`);
      } else {
        payload.imageUrl = info.url;
        payload.mediaVariant = "preview";
        debugLog("original unavailable, using preview", `${info.jobId}:${info.index}`, original?.error || "");
      }
      try {
        const response = await sendIngest(payload);
        if (!response?.ok && automatic) seen.delete(key);
        return response || { ok: false };
      } catch (error) {
        if (automatic) seen.delete(key);
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  async function captureVideo(video, info, captureMode) {
    return withCaptureSlot(async () => {
      const identity = midjourneyAssetIdentity(info);
      const key = `midjourney:video:${identity}`;
      const automatic = captureMode === "automatic";
      if (automatic && seen.has(key)) return { ok: true };
      if (automatic) rememberSeen(key);
      const payload = basePayload("video", captureMode);
      payload.providerAssetId = identity;
      payload.conversationId = info.jobId;
      payload.generationContextId = info.jobId;
      payload.sourceMediaUrl = info.url;
      payload.finalMediaUrl = info.url;
      payload.mediaUrl = info.url;
      payload.mimeType = mimeTypeForUrl(info.url, "video");
      payload.width = Number(video.videoWidth || video.width || 0);
      payload.height = Number(video.videoHeight || video.height || 0);
      payload.durationSeconds = Number.isFinite(Number(video.duration)) ? Number(video.duration) : null;
      payload.mediaVariant = "original";
      try {
        const response = await sendIngest(payload);
        if (!response?.ok && automatic) seen.delete(key);
        return response || { ok: false };
      } catch (error) {
        if (automatic) seen.delete(key);
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  function videoInfoFor(video) {
    const candidates = [
      video?.currentSrc || "",
      video?.src || "",
      Array.from(video?.children || []).find((child) => String(child?.tagName || "").toLowerCase() === "source")?.src || "",
    ];
    for (const candidate of candidates) {
      const info = parseMidjourneyMediaUrl(candidate);
      if (info?.kind === "video") return info;
    }
    return null;
  }

  function scan() {
    if (!autoCapture || providerContextLost) return;
    if (location.href !== lastProviderUrl) {
      lastProviderUrl = location.href;
      seen.clear();
      firstScanDone = false;
    }
    const images = Array.from(document.images || [])
      .map((img) => ({ img, info: parseMidjourneyMediaUrl(img.currentSrc || img.src || "") }))
      .filter((entry) => entry.info?.kind === "image" && isVisibleMedia(entry.img));
    const videos = Array.from(document.querySelectorAll?.("video") || [])
      .map((video) => ({ video, info: videoInfoFor(video) }))
      .filter((entry) => entry.info && isVisibleMedia(entry.video, { minEdge: 128 }));

    if (!firstScanDone) {
      firstScanDone = true;
      for (const { info } of [...images, ...videos]) baseline.add(info.jobId);
      debugLog("baseline", baseline.size, "jobs already on the page");
      return;
    }

    const nowMs = Date.now();
    const newEntries = [...images.map((entry) => ({ ...entry, mediaKind: "image" })), ...videos.map((entry) => ({ ...entry, mediaKind: "video" }))]
      .filter((entry) => !baseline.has(entry.info.jobId));
    const newJobIds = new Set(newEntries.map((entry) => entry.info.jobId));
    const batchBaseline = globalThis.MosaMidjourneyCapture.isBatchBaselineInsertion(newJobIds.size);
    for (const entry of newEntries) {
      // Lazy-loaded history pages in: (a) inside the scroll window right after
      // the user scrolled, or (b) as a multi-card batch in one tick. A fresh
      // generation inserts a single new card with no recent scrolling.
      const loadBaseline = nowMs - scriptStartedAtMs < LOAD_BASELINE_WINDOW_MS;
      if (loadBaseline || batchBaseline || globalThis.MosaMidjourneyCapture.isScrollBaselineInsertion(nowMs, lastScrollAtMs)) {
        if (!baseline.has(entry.info.jobId)) debugLog("history job skipped", entry.info.jobId, loadBaseline ? "page still loading" : batchBaseline ? "batch" : "after scroll");
        baseline.add(entry.info.jobId);
        continue;
      }
      debugLog("new job, capturing", entry.mediaKind, `${entry.info.jobId}:${entry.info.index}`);
      if (entry.mediaKind === "image") void captureImage(entry.img, entry.info, "automatic");
      else void captureVideo(entry.video, entry.info, "automatic");
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
      scan();
    }, 300);
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
      const info = parseMidjourneyMediaUrl(clickedUrl);
      if (videoRequest) {
        const video = info?.kind === "video"
          ? Array.from(document.querySelectorAll?.("video") || []).find((candidate) => videoInfoFor(candidate)?.url === info.url)
          : null;
        if (!info || info.kind !== "video" || !video) {
          showToast("请选择支持站点中的生成视频。", true);
          sendResponse({ ok: false, error: "请选择支持站点中的生成视频。" });
          return;
        }
        const response = await captureVideo(video, info, "manual");
        showToast(response?.ok ? "已保存到 GravityPort" : (response?.error || "保存失败"), !response?.ok);
        sendResponse(response || { ok: false });
        return;
      }
      if (!info || info.kind !== "image") {
        showToast("请选择支持站点中的生成图片。", true);
        sendResponse({ ok: false, error: "请选择支持站点中的生成图片。" });
        return;
      }
      const img = Array.from(document.images || []).find((candidate) => {
        const candidateInfo = parseMidjourneyMediaUrl(candidate.currentSrc || candidate.src || "");
        return candidateInfo && midjourneyAssetIdentity(candidateInfo) === midjourneyAssetIdentity(info);
      }) || null;
      const response = await captureImage(img, info, "manual");
      showToast(response?.ok ? "已保存到 GravityPort" : (response?.error || "保存失败"), !response?.ok);
      sendResponse(response || { ok: false });
    })().catch((error) => {
      const errorText = error instanceof Error ? error.message : String(error);
      showToast(errorText, true);
      sendResponse({ ok: false, error: errorText });
    });
    return true;
  });

  observer = new MutationObserver(() => {
    if (autoCapture) scheduleScan();
  });
  document.addEventListener("load", () => { if (autoCapture) scheduleScan(); }, true);
  document.addEventListener("loadedmetadata", () => { if (autoCapture) scheduleScan(); }, true);
  document.addEventListener("loadeddata", () => { if (autoCapture) scheduleScan(); }, true);
  document.addEventListener("canplay", () => { if (autoCapture) scheduleScan(); }, true);
  document.addEventListener("scroll", () => {
    lastScrollAtMs = Date.now();
    if (autoCapture) scheduleScan();
  }, { passive: true, capture: true });

  loadProviderSettings().then(() => {
    if (autoCapture && document.documentElement) {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: false,
        attributeFilter: ["src", "srcset", "class", "aria-hidden", "hidden"],
      });
      scheduleScan();
    }
    updateWatchdog();
  }).catch(() => {});

  chrome.storage?.onChanged?.addListener?.((changes, area) => {
    if (area !== "local") return;
    if (changes.autoCapture) {
      autoCapture = changes.autoCapture.newValue !== false;
      if (autoCapture && observer && document.documentElement) {
        observer.disconnect();
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: false,
          attributeFilter: ["src", "srcset", "class", "aria-hidden", "hidden"],
        });
        scheduleScan();
      } else if (!autoCapture) {
        observer?.disconnect();
      }
      updateWatchdog();
    }
    if (changes.mosaBaseUrl || changes.mosaToken) seen.clear();
  });
})();
