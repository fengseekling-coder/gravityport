(() => {
  // Real generation CDNs. ChatGPT may proxy a generated asset through Estuary.
  const GENERATION_HOST_HINTS = [
    "oaiusercontent.com",
    "oaidalle",
    "files.oaiusercontent",
    "images.openai.com",
    "blob.core.windows.net",
  ];
  const BLOCK_URL_HINTS = [
    "oaistatic.com",
    "avatar",
    "favicon",
    "emoji",
    "sprite",
    "logo",
    "icon",
    "/_next/",
    "profile",
  ];
  const MIN_EDGE = 480; // px — drop small UI logos
  const MIN_BYTES = 20 * 1024; // server also enforces this
  const PROVEN_GENERATION_MIN_EDGE = 256; // matches the provenGeneration tier in isArchiveWorthyCandidate
  const COMPOSER_SELECTOR = 'form, [data-type="unified-composer"], [data-testid="composer"]';
  const CHATGPT_TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const CHATGPT_USER_SELECTOR = '[data-message-author-role="user"], [data-content-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":user"]';
  const CHATGPT_MESSAGE_SELECTOR = '[data-chatgpt-search-message-ids]';
  const GENERATION_EVIDENCE_RECOVERY_DELAYS = [2_800, 7_200, 15_000];
  const SIZE_FAILURE_LIMIT = 3;
  const SIZE_FAILURE_BACKOFF_MS = 60_000;
  const AUTO_STABILITY_DELAY_MS = 900;
  const AUTO_IN_PROGRESS_STALE_MS = 6_000;
  const AUTO_PARTIAL_FALLBACK_MS = 15_000;
  const DOM_MEDIA_GRACE_MS = 600;
  const MANUAL_HOOK_LEASE_MS = 20_000;
  const STYLE_HINTS = [
    "poster", "illustration", "typography", "vector", "style", "lighting",
    "camera", "composition", "palette", "cinematic", "editorial", "scene",
    "caption", "graphic", "layout", "海报", "插画", "构图", "光影", "风格", "场景",
  ];

  /** @type {Array<{prompt:string,promptScore:number,imageUrl:string,imageKey:string,assetId:string,promptStatus:string,messageId:string,model:string,capturedAt:string,via:string,bound?:boolean}>} */
  const networkMeta = [];
  /** Stable image identity -> latest bound prompt for that exact generated asset */
  const imagePromptMap = new Map();
  const inFlight = new Set();
  const queuedAutoKeys = new Set();
  const savedKeys = new Set();
  /**
   * Stable image identities already archived in this page session. One uploaded
   * reference photo renders under several URLs (composer blob, Estuary proxy,
   * signed CDN link), so keying only on the raw src archived it once per URL.
   */
  const savedIdentityKeys = new Set();
  /** Stable image identity -> candidate retained for a late prompt upgrade. */
  const capturedCandidates = new Map();
  /** Stable image identity -> best prompt rank sent to MOSA in this page session. */
  const savedPromptRanks = new Map();
  /** Generation context + output identity pairs whose references were repaired after the output was first archived. */
  const referenceSyncKeys = new Set();
  /**
   * A network-only capture can fail before the image has rendered. Once the
   * real DOM image is available, its canvas is a different byte source and
   * should be allowed to retry immediately instead of waiting for the generic
   * failure cooldown.
   */
  const failedNetworkIdentityKeys = new Set();
  const promptUpgradeInFlight = new Set();
  const promptRecoveryTimers = new Map();
  const generationEvidenceRecoveryTimers = new Map();
  const autoStabilityStates = new Map();
  const autoStabilityTimers = new Map();
  const savedGenerationStatuses = new Map();
  const SESSION_CACHE_MAX = 4096;
  /** blob: URL -> estuary file id, from the page hook's blob-asset messages. */
  const blobAssetIds = new Map();
  const MAX_BLOB_ASSETS = 400;
  let generationRegistry = null;
  const failedAt = new Map(); // key -> timestamp, retry after cooldown
  const sizeFailureStates = new Map(); // stable image identity -> bounded small-file retry state
  // The conversation endpoint is enough to recover a caption that was rendered
  // from ChatGPT's cache, but was never seen by the page network hook.
  const conversationRefreshRequestedAt = new Map();
  const CONVERSATION_REFRESH_COOLDOWN_MS = 2_500;
  let toastTimer = null;
  let autoCapture = false;
  let scanTimer = null;
  let lastUrl = location.href;
  let activeConversationId = conversationIdFromUrl();
  let conversationEpoch = 0;
  let hookReady = document.documentElement?.dataset?.mosaPageHook === "1";
  let lastError = "";
  let lastStatus = "starting";
  const AUTO_CAPTURE_CONCURRENCY = 2;
  let autoCaptureInFlight = 0;
  const autoCaptureWaiters = [];
  let contextLost = false;
  let autoScanInterval = null;
  let observer = null;
  let controlPanel = null;
  let panelDragState = null;
  let manualHookDisableTimer = null;
  let manualHookLeaseUntil = 0;
  let pageHookSyncTimer = null;
  let pageHookCaptureAck = null;
  // Stack naming: the per-page side of "one report per (conversation, title)".
  // The background keeps the authoritative per-browser-session sent-set.
  let sessionTitleReportTimer = null;
  let lastSessionTitleReportKey = "";
  const titleObserver = new MutationObserver(() => scheduleSessionTitleReport());
  // The page hook talks to this script over a private MessagePort handed
  // through a one-time window message. Plain window messages are visible to
  // every page script and used to be forgeable; only the transferred port is
  // trusted, and only the first transferred port is adopted.
  let hookPort = null;
  let hookPortRequestTimer = null;
  let hookPortRequestAttempt = 0;
  const captureDebugEvents = [];

  function postToPageHook(type, payload) {
    if (!hookPort) return false;
    hookPort.postMessage({ source: "mosa-chatgpt-capture", type, payload });
    return true;
  }

  function rememberSet(set, value, maxSize = SESSION_CACHE_MAX) {
    if (!value) return;
    set.delete(value);
    set.add(value);
    while (set.size > maxSize) set.delete(set.values().next().value);
  }

  function rememberMap(map, key, value, maxSize = SESSION_CACHE_MAX) {
    if (!key) return;
    map.delete(key);
    map.set(key, value);
    while (map.size > maxSize) map.delete(map.keys().next().value);
  }

  function setPageHookCaptureEnabled(enabled) {
    // Returns false while the port is not ready yet, same semantics as the
    // old "no channel name in the DOM" path; syncPageHookCaptureEnabled()
    // keeps retrying until the hook confirms the state.
    return postToPageHook("set-capture-enabled", { enabled: enabled === true });
  }

  function desiredPageHookCaptureEnabled() {
    return autoCapture || Date.now() < manualHookLeaseUntil;
  }

  function syncPageHookCaptureEnabled(attempt = 0) {
    const desired = desiredPageHookCaptureEnabled();
    if (pageHookCaptureAck === desired) {
      if (pageHookSyncTimer) clearTimeout(pageHookSyncTimer);
      pageHookSyncTimer = null;
      return;
    }
    setPageHookCaptureEnabled(desired);
    const retryDelays = [25, 100, 300, 750, 1_500, 2_500];
    if (attempt >= retryDelays.length || contextLost) return;
    if (pageHookSyncTimer) clearTimeout(pageHookSyncTimer);
    pageHookSyncTimer = setTimeout(() => {
      pageHookSyncTimer = null;
      syncPageHookCaptureEnabled(attempt + 1);
    }, retryDelays[attempt]);
  }

  function enablePageHookForManualCapture() {
    manualHookLeaseUntil = Date.now() + MANUAL_HOOK_LEASE_MS;
    pageHookCaptureAck = null;
    syncPageHookCaptureEnabled();
    if (manualHookDisableTimer) clearTimeout(manualHookDisableTimer);
    manualHookDisableTimer = setTimeout(() => {
      manualHookDisableTimer = null;
      manualHookLeaseUntil = 0;
      pageHookCaptureAck = null;
      syncPageHookCaptureEnabled();
    }, MANUAL_HOOK_LEASE_MS);
  }

  function resetConversationTransientState() {
    conversationEpoch += 1;
    networkMeta.splice(0, networkMeta.length);
    imagePromptMap.clear();
    generationRegistry?.clear?.();
    capturedCandidates.clear();
    conversationRefreshRequestedAt.clear();
    for (const timers of promptRecoveryTimers.values()) {
      for (const timer of timers) clearTimeout(timer);
    }
    promptRecoveryTimers.clear();
    for (const timers of generationEvidenceRecoveryTimers.values()) {
      for (const timer of timers) clearTimeout(timer);
    }
    generationEvidenceRecoveryTimers.clear();
    for (const timer of autoStabilityTimers.values()) clearTimeout(timer);
    autoStabilityTimers.clear();
    autoStabilityStates.clear();
    savedGenerationStatuses.clear();
    promptUpgradeInFlight.clear();
    queuedAutoKeys.clear();
    referenceSyncKeys.clear();
    failedNetworkIdentityKeys.clear();
    failedAt.clear();
    sizeFailureStates.clear();
  }

  function showToast(message, isError = false) {
    let el = document.getElementById("mosa-capture-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "mosa-capture-toast";
      el.className = "mosa-capture-toast";
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = message;
    el.setAttribute("role", isError ? "alert" : "status");
    el.classList.toggle("is-error", Boolean(isError));
    el.classList.add("is-visible");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("is-visible"), 4200);
  }

  function setStatus(text, isError = false) {
    lastStatus = text;
    if (isError) lastError = text;
    else if (!contextLost) lastError = "";
    renderControlPanel();
  }

  function conversationIdFromUrl() {
    const match = location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/);
    return match ? match[1] : "";
  }

  function currentConversationId() {
    return conversationIdFromUrl() || activeConversationId || "";
  }

  function adoptConversationId(value, { resetOnChange = true } = {}) {
    const next = String(value || "").trim();
    if (!next) return activeConversationId;

    const urlConversationId = conversationIdFromUrl();
    if (urlConversationId && next !== urlConversationId) return "";

    if (activeConversationId && activeConversationId !== next && resetOnChange) {
      resetConversationTransientState();
    }
    activeConversationId = next;
    return activeConversationId;
  }

  const SESSION_TITLE_MAX_LENGTH = 200; // server re-caps to 80 for stack names
  const SESSION_TITLE_PLACEHOLDERS = new Set(["chatgpt", "new chat", "新聊天", "新对话"]);

  function normalizeConversationTitle(value) {
    const cleaned = String(value || "")
      .replace(/\s*[-|]\s*ChatGPT\s*$/i, "")
      .trim();
    if (!cleaned || SESSION_TITLE_PLACEHOLDERS.has(cleaned.toLowerCase())) return "";
    return cleaned.slice(0, SESSION_TITLE_MAX_LENGTH);
  }

  function conversationTitleFromSidebar() {
    const active = document.querySelector('nav a[aria-current="page"]');
    return String(active?.textContent || "");
  }

  function currentConversationTitle() {
    return normalizeConversationTitle(document.title)
      || normalizeConversationTitle(conversationTitleFromSidebar());
  }

  // A title only travels with images of the conversation currently open in the
  // URL: during a switch the old page's queued captures must not inherit the
  // next chat's name.
  function sessionTitleForConversation(conversationId) {
    const cleanId = String(conversationId || "").trim();
    if (!cleanId || cleanId !== conversationIdFromUrl()) return "";
    return currentConversationTitle();
  }

  function isBlockedUrl(src) {
    const lower = String(src || "").toLowerCase();
    // Hint substrings must never scan a data URL body: base64 can contain
    // "logo"/"icon" by chance and silently drop a real reference image.
    if (lower.startsWith("data:")) return false;
    return BLOCK_URL_HINTS.some((hint) => lower.includes(hint));
  }

  function chatGptImageProxyInfo(src) {
    try {
      const url = new URL(src, location.href);
      const host = url.hostname.toLowerCase();
      if (!(["chatgpt.com", "chat.openai.com"].includes(host)) || url.pathname !== "/backend-api/estuary/content") {
        return null;
      }
      const conversationId = url.searchParams.get("cid") || "";
      const assetId = url.searchParams.get("id") || "";
      if (!assetId) return null;
      return {
        conversationId,
        assetId,
        imageKey: conversationId ? `estuary:${conversationId}:${assetId}` : `asset:${assetId}`,
      };
    } catch {
      return null;
    }
  }

  function normalizeAssetId(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const pointer = /^(?:file-service|asset|sediment):\/\/([^/?#]+)/i.exec(raw);
    if (pointer) return pointer[1];
    return /^[a-z0-9][a-z0-9._:-]{2,200}$/i.test(raw) ? raw : "";
  }

  // The page hook reports which estuary file each blob: URL was made from.
  // Accept only same-origin blob: URLs and file_ ids; the mapping only adds an
  // asset:<fileId> lookup key so the existing bindings match by file id.
  function isTrustedBlobAssetUrl(value) {
    const raw = String(value || "").trim();
    if (!/^blob:/i.test(raw)) return false;
    try {
      // Some engines report "null" as a blob: URL's origin, so compare the
      // inner URL's origin instead.
      const inner = new URL(raw.slice(5));
      const origin = location.origin || new URL(location.href).origin;
      return inner.origin === origin && /^\/[A-Za-z0-9._:-]+$/.test(inner.pathname);
    } catch {
      return false;
    }
  }

  function normalizeBlobAssetId(value) {
    const raw = String(value || "").trim();
    return /^file[-_][A-Za-z0-9]{6,}$/i.test(raw) ? raw : "";
  }

  function rememberBlobAsset(payload) {
    const blobUrl = String(payload?.blobUrl || "").trim();
    const assetId = normalizeBlobAssetId(payload?.assetId);
    if (!isTrustedBlobAssetUrl(blobUrl) || !assetId) return null;
    blobAssetIds.delete(blobUrl);
    blobAssetIds.set(blobUrl, assetId);
    while (blobAssetIds.size > MAX_BLOB_ASSETS) blobAssetIds.delete(blobAssetIds.keys().next().value);
    return { blobUrl, assetId };
  }

  function blobAssetIdForUrl(value) {
    const url = String(value || "").trim();
    if (!isTrustedBlobAssetUrl(url)) return "";
    return blobAssetIds.get(url) || "";
  }

  function imageLookupKeys(imageUrl, meta = {}) {
    const keys = [];
    const explicitKey = String(meta.imageKey || "").trim();
    if (explicitKey) keys.push(explicitKey);
    const explicitAssetId = normalizeAssetId(meta.assetId);
    if (explicitAssetId) keys.push(`asset:${explicitAssetId}`);

    const direct = String(imageUrl || "").trim();
    if (/^(?:estuary|asset|url):/.test(direct)) keys.push(direct);
    // A gallery blob: URL matches its generation through the reported file id.
    if (/^blob:/i.test(direct)) {
      const mappedAssetId = blobAssetIdForUrl(direct);
      if (mappedAssetId) keys.push(`asset:${mappedAssetId}`);
    }
    const proxy = chatGptImageProxyInfo(direct);
    if (proxy) {
      keys.push(proxy.imageKey, `asset:${proxy.assetId}`);
    } else if (direct) {
      try {
        const url = new URL(direct, location.href);
        // One ChatGPT file is served both through the Estuary proxy and from a
        // signed CDN link. Without the shared file id those read as two images.
        const fileId = /\/(file[-_][A-Za-z0-9]{6,})(?:[./]|$)/.exec(url.pathname)?.[1] || "";
        if (fileId) keys.push(`asset:${fileId}`);
        keys.push(`url:${url.origin}${url.pathname}`);
      } catch {
        // Ignore malformed lookup values.
      }
    }
    return [...new Set(keys)];
  }

  function isLikelyGeneratedUrl(src) {
    if (!src) return false;
    if (isBlockedUrl(src)) return false;
    if (src.startsWith("blob:")) return true;
    if (src.startsWith("data:image/")) return !src.startsWith("data:image/svg");
    if (chatGptImageProxyInfo(src)) return true;
    try {
      const full = new URL(src, location.href).hostname + src;
      return GENERATION_HOST_HINTS.some((hint) => full.includes(hint));
    } catch {
      return false;
    }
  }

  function scorePromptText(text) {
    const t = String(text || "").trim();
    if (!t) return 0;
    let score = Math.min(t.length, 2500) / 15;
    for (const word of STYLE_HINTS) {
      if (t.toLowerCase().includes(word.toLowerCase())) score += 10;
    }
    if (t.length < 50 && /^(换|改|再|生成|做|来|版本|三版|两版|地区|继续|好的|嗯|在做)/.test(t)) score -= 40;
    if (/^model caption:/i.test(t)) score += 30;
    const latin = (t.match(/[A-Za-z]/g) || []).length;
    if (latin > 80) score += 20;
    return score;
  }

  function isWeakChatPrompt(text) {
    const t = String(text || "").trim();
    if (!t) return true;
    if (/^model caption:/i.test(t)) return false;
    if (t.length >= 120 && scorePromptText(t) >= 25) return false;
    if (t.length < 100) return true;
    if (/^(换|改|再|做|来|在做|生成|请|帮)/.test(t)) return true;
    return false;
  }

  function looksLikeGenerationCaption(text) {
    const t = String(text || "").trim();
    if (t.length < 80) return false;
    if (/^model caption:/i.test(t)) return true;
    const hits = STYLE_HINTS.filter((w) => t.toLowerCase().includes(w.toLowerCase()));
    return hits.length >= 2 || (t.length > 200 && hits.length >= 1);
  }

  /**
   * An attachment still sitting in the composer is not part of the conversation
   * yet, and ChatGPT re-renders it inside the sent message at a capped size.
   * Capturing both archived one upload as two differently sized assets.
   */
  function isComposerNode(node) {
    const scope = node?.closest?.(COMPOSER_SELECTOR);
    if (!scope) return false;
    if (scope.matches?.('[data-type="unified-composer"], [data-testid="composer"]')) return true;
    // A bare <form> is the composer only when it owns the prompt input, so a
    // future ChatGPT layout cannot silently mute capture for the whole thread.
    return Boolean(scope.querySelector?.('textarea, [contenteditable="true"]'));
  }

  function conversationTurnForNode(node) {
    return node?.closest?.(CHATGPT_TURN_SELECTOR) || null;
  }

  function turnContainsRole(turn, role) {
    return Boolean(turn?.querySelector?.(`[data-message-author-role="${role}"]`));
  }

  function nearestPrecedingUserScope(node) {
    if (!node) return null;
    let nearest = null;
    const seen = new Set();
    const candidates = document.querySelectorAll(
      `${CHATGPT_USER_SELECTOR}, ${CHATGPT_TURN_SELECTOR}`,
    );
    for (const candidate of candidates) {
      const scope = candidate.matches?.(CHATGPT_TURN_SELECTOR)
        ? (turnContainsRole(candidate, "user") ? candidate : null)
        : (conversationTurnForNode(candidate) || candidate);
      if (!scope || seen.has(scope)) continue;
      seen.add(scope);
      if (scope.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) nearest = scope;
    }
    return nearest;
  }

  /** A search unit key reads "fallback-turn-12:0:user"; one message shares the prefix. */
  function userUnitKeyPrefix(unit) {
    const key = String(
      unit?.getAttribute?.("data-chatgpt-search-unit-key") || unit?.getAttribute?.("data-content-search-unit-key") || "",
    );
    return key.replace(/:[^:]*:user$/, "");
  }

  /**
   * One ChatGPT user message can arrive as several sibling units (attachments,
   * then text). Reference lookup must span every user unit of that message —
   * but the units are the boundary, never the turn container: the generated
   * gallery lives inside the same container's assistant unit.
   */
  function userUnitsOfSameMessage(anchor, image) {
    if (!anchor) return [];
    if (anchor.matches?.(CHATGPT_TURN_SELECTOR)) return [anchor];
    const anchorPrefix = userUnitKeyPrefix(anchor);
    // Prefer the outer turn-key wrapper: the attachment unit may sit beside,
    // not inside, the inner content-search turn.
    const container = anchor.closest?.("[data-turn-key]") || anchor.closest?.("[data-content-search-turn-key]") || null;
    if (!container && !anchorPrefix) return [anchor];
    const units = Array.from(
      container?.querySelectorAll?.(CHATGPT_USER_SELECTOR) || document.querySelectorAll(CHATGPT_USER_SELECTOR),
    );
    const sameMessage = units.filter((unit) => {
      if (!(unit.compareDocumentPosition?.(image) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
      return container ? true : userUnitKeyPrefix(unit) === anchorPrefix;
    });
    return sameMessage.length ? sameMessage : [anchor];
  }

  function hasGeneratedImageDomMarker(image) {
    if (!(image instanceof HTMLImageElement)) return false;
    const label = [image.getAttribute("alt"), image.getAttribute("aria-label")]
      .filter(Boolean)
      .join(" ")
      .trim();
    return /^(?:generated image|image generated)(?:\b|:)/i.test(label)
      || /^(?:已?生成的?(?:图片|图像)|生成(?:图片|图像))(?:\b|[:：])?/i.test(label);
  }

  /** A picture inside a user turn is an uploaded reference, not a generation. */
  function isReferenceCandidate(candidate) {
    const image = candidate?.el instanceof HTMLImageElement ? candidate.el : null;
    if (!image || hasGeneratedImageDomMarker(image)) return false;
    if (image.closest?.(CHATGPT_USER_SELECTOR)) return true;
    const turn = conversationTurnForNode(image);
    return Boolean(turn?.querySelector?.('[data-message-author-role="user"]'));
  }

  /**
   * DOM-only generation candidates are not archived without provenance. They
   * may, however, trigger a same-conversation metadata refresh when they are
   * clearly inside an assistant/tool turn and use a known generation asset
   * host. This recovers startup races without treating arbitrary page images as
   * generated output.
   */
  function isRecoverableGenerationCandidate(candidate) {
    const image = candidate?.el instanceof HTMLImageElement ? candidate.el : null;
    if (!image || isComposerNode(image) || isReferenceCandidate(candidate)) return false;
    const src = candidate.imageUrl || candidate.key || image.currentSrc || image.src || "";
    if (!src || isBlockedUrl(src)) return false;
    const turn = conversationTurnForNode(image);
    const roleScope = image.closest?.('[data-message-author-role="assistant"], [data-message-author-role="tool"]');
    const turnOwnsAssistantContent = Boolean(turn?.querySelector?.('[data-message-author-role="assistant"], [data-message-author-role="tool"]'));
    const explicitGeneratedImage = hasGeneratedImageDomMarker(image);
    if (!roleScope && !turnOwnsAssistantContent && !explicitGeneratedImage) return false;
    if (!isLikelyGeneratedUrl(src) && !explicitGeneratedImage) return false;
    if (explicitGeneratedImage) return true;
    if (src.startsWith("blob:")) return true;
    if (chatGptImageProxyInfo(src)) return true;
    try {
      const host = new URL(src, location.href).hostname.toLowerCase();
      return GENERATION_HOST_HINTS.some((hint) => host.includes(hint));
    } catch {
      return false;
    }
  }

  function looksLikeGeneratedImage(img, { manual = false } = {}) {
    if (!(img instanceof HTMLImageElement)) return false;
    if (!manual && isComposerNode(img)) return false;
    const src = img.currentSrc || img.src || "";
    if (!src || isBlockedUrl(src)) return false;
    // A proven gallery blob is collected before any size gate: an unclicked
    // thumbnail has naturalWidth 0 and a ~54px display size, and its real
    // size is enforced from the decoded blob bytes later.
    if (!manual && src.startsWith("blob:") && isProvenGalleryBlobImage(img)) return true;
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    const explicitGeneratedImage = hasGeneratedImageDomMarker(img);
    const minEdge = manual ? 360 : explicitGeneratedImage ? 256 : MIN_EDGE;
    if (w > 0 && h > 0) {
      if (w < minEdge || h < minEdge) return false;
      const ratio = w / h;
      // Block smallish square logos; allow large square gens.
      if (ratio > 0.85 && ratio < 1.15 && Math.min(w, h) < 700 && !isLikelyGeneratedUrl(src) && !manual) {
        return false;
      }
    }
    if (explicitGeneratedImage) return true;
    if (isLikelyGeneratedUrl(src)) return true;
    if (src.startsWith("blob:") && (w >= minEdge || manual)) return true;
    // Manual: accept any large on-page image (full viewer often uses non-CDN hosts).
    if (manual && w >= minEdge && h >= minEdge) return true;
    if (w >= 700 && h >= 700) return true;
    return false;
  }

  function isArchiveWorthyCandidate(candidate, { manual = false, reference = false, byteLength = 0 } = {}) {
    if (!candidate) return false;
    if (!reference && byteLength > 0 && byteLength < MIN_BYTES) return false;
    const w = candidate.width || 0;
    const h = candidate.height || 0;
    // References are inputs, not output candidates. Do not reuse the output/logo
    // threshold or legitimate thumbnails and low-resolution identity guides are lost.
    const provenGeneration = !manual && !reference
      && (hasObservedGenerationEvidence(candidate) || isRecoverableGenerationCandidate(candidate));
    const minEdge = reference ? 32 : manual ? 360 : provenGeneration ? 256 : MIN_EDGE;
    if (w > 0 && h > 0 && (w < minEdge || h < minEdge)) return false;
    const url = candidate.imageUrl || candidate.key || "";
    if (isBlockedUrl(url)) return false;
    if (manual || reference) return true;
    // Network-only auto candidates without dimensions: require generation CDN or blob.
    if ((!w || !h) && url && !url.startsWith("blob:") && !isLikelyGeneratedUrl(url)) return false;
    return true;
  }

  function collectDomCandidates({ manual = false } = {}) {
    const byKey = new Map();
    for (const img of document.querySelectorAll("img")) {
      if (!looksLikeGeneratedImage(img, { manual })) continue;
      const src = img.currentSrc || img.src;
      if (!src || byKey.has(src)) continue;
      // A proven gallery blob that has not decoded yet reports no meaningful
      // size: keep it unknown so the size gate cannot drop the unclicked
      // thumbnail and the real decoded size is enforced from the bytes later.
      const provenGalleryBlob = !manual && src.startsWith("blob:") && isProvenGalleryBlobImage(img);
      byKey.set(src, {
        key: src,
        el: img,
        imageUrl: src.startsWith("data:") ? "" : src,
        dataUrl: src.startsWith("data:") ? src : "",
        width: provenGalleryBlob ? (img.naturalWidth || 0) : (img.naturalWidth || img.width || 0),
        height: provenGalleryBlob ? (img.naturalHeight || 0) : (img.naturalHeight || img.height || 0),
      });
    }
    // CSS-background discovery is kept only for an explicit manual save. The
    // automatic path already receives provider URLs from the page hook and
    // scanning every div/section plus computed style on each mutation was a
    // major long-conversation layout cost.
    if (manual) {
      for (const el of document.querySelectorAll("div, section, main, figure")) {
        const rect = el.getBoundingClientRect?.();
        if (!rect || rect.width < 300 || rect.height < 300) continue;
        const bg = getComputedStyle(el).backgroundImage || "";
        const match = /url\(["']?(https?:\/\/[^"')]+|blob:[^"')]+)["']?\)/i.exec(bg);
        if (!match) continue;
        const url = match[1];
        if (isBlockedUrl(url) || byKey.has(url)) continue;
        byKey.set(url, {
          key: url,
          el,
          imageUrl: url.startsWith("data:") ? "" : url,
          dataUrl: url.startsWith("data:") ? url : "",
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
    }
    return [...byKey.values()].sort((a, b) => (b.width * b.height) - (a.width * a.height));
  }

  function currentViewportCandidate(candidates) {
    const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
    const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
    const visible = candidates
      .map((candidate) => ({ candidate, rect: candidate.el?.getBoundingClientRect?.() }))
      .filter(({ rect }) => rect && rect.bottom > 0 && rect.right > 0 && rect.top < viewportHeight && rect.left < viewportWidth)
      .sort((a, b) => {
        const aVisibleArea = Math.max(0, Math.min(a.rect.bottom, viewportHeight) - Math.max(a.rect.top, 0))
          * Math.max(0, Math.min(a.rect.right, viewportWidth) - Math.max(a.rect.left, 0));
        const bVisibleArea = Math.max(0, Math.min(b.rect.bottom, viewportHeight) - Math.max(b.rect.top, 0))
          * Math.max(0, Math.min(b.rect.right, viewportWidth) - Math.max(b.rect.left, 0));
        return bVisibleArea - aVisibleArea;
      });
    return visible[0]?.candidate || candidates[0] || null;
  }

  function domCandidateForImage(imageUrl, { manual = false } = {}) {
    const wantedKeys = imageLookupKeys(imageUrl);
    if (!wantedKeys.length) return null;
    return collectDomCandidates({ manual }).find((candidate) => (
      candidate.imageUrl === imageUrl
      || candidate.key === imageUrl
      || candidateLookupKeys(candidate).some((key) => wantedKeys.includes(key))
    )) || null;
  }

  function enqueueDomCandidateForImage(imageUrl, reason) {
    const candidate = domCandidateForImage(imageUrl);
    if (candidate) {
      enqueueAuto(candidate, reason);
      return true;
    }
    scheduleScan(true);
    return false;
  }

  const CONTEXT_LOST_MESSAGE = "GravityPort 扩展已更新或重载，本页脚本已失联：请按 Cmd+Shift+R 硬刷新本页恢复捕获";

  function extensionAlive() {
    try {
      return typeof chrome === "object" && Boolean(chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  /**
   * Reloading or re-adding the unpacked extension orphans this already-injected
   * script: the dock stays on screen while chrome.runtime is gone, so every
   * save died with a raw "Cannot read properties of undefined". Say what
   * happened once, freeze the buttons, and stop the scan machinery.
   */
  function markContextLost() {
    if (contextLost) return;
    contextLost = true;
    if (autoScanInterval) clearInterval(autoScanInterval);
    if (scanTimer) clearTimeout(scanTimer);
    if (manualHookDisableTimer) clearTimeout(manualHookDisableTimer);
    observer?.disconnect();
    for (const timers of promptRecoveryTimers.values()) {
      for (const timer of timers) clearTimeout(timer);
    }
    promptRecoveryTimers.clear();
    for (const timers of generationEvidenceRecoveryTimers.values()) {
      for (const timer of timers) clearTimeout(timer);
    }
    generationEvidenceRecoveryTimers.clear();
    for (const timer of autoStabilityTimers.values()) clearTimeout(timer);
    autoStabilityTimers.clear();
    autoStabilityStates.clear();
    setStatus(CONTEXT_LOST_MESSAGE, true);
    showToast(CONTEXT_LOST_MESSAGE, true);
  }

  async function runtimeSend(message) {
    if (!extensionAlive() || typeof chrome.runtime?.sendMessage !== "function") {
      markContextLost();
      throw new Error(CONTEXT_LOST_MESSAGE);
    }
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (chrome.runtime.lastError) {
        throw new Error(chrome.runtime.lastError.message);
      }
      if (response === undefined) {
        throw new Error("扩展后台无响应：请到 chrome://extensions 刷新 GravityPort 扩展，再 Cmd+Shift+R 刷新本页");
      }
      return response;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/Extension context invalidated|context invalidated|reading 'sendMessage'/i.test(msg)) {
        markContextLost();
        throw new Error(CONTEXT_LOST_MESSAGE);
      }
      if (/Receiving end does not exist|Could not establish connection/i.test(msg)) {
        throw new Error("扩展后台未连接：请在 chrome://extensions 打开 GravityPort 并点刷新，再硬刷新本页");
      }
      throw error instanceof Error ? error : new Error(msg);
    }
  }

  function cleanPromptText(text) {
    return String(text || "")
      .replace(/<\|has_watermark\|>/g, "")
      .replace(/\n?展开\s*$/g, "")
      .trim();
  }

  function normalizeGenerationStatus(value) {
    const raw = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (["completed", "complete", "succeeded", "success", "done", "finished"].includes(raw)) return "completed";
    if (["failed", "failure", "error", "errored", "rejected", "timeout", "timed_out"].includes(raw)) return "failed";
    if (["cancelled", "canceled", "aborted", "stopped"].includes(raw)) return "cancelled";
    if (["partial", "incomplete"].includes(raw)) return "partial";
    if (["in_progress", "running", "generating", "streaming", "pending", "queued"].includes(raw)) return "in_progress";
    return "unknown";
  }

  function isTerminalGenerationStatus(value) {
    return ["completed", "failed", "cancelled"].includes(normalizeGenerationStatus(value));
  }

  function isShortEditCommand(text) {
    const t = String(text || "").trim();
    if (!t) return false;
    if (t.length > 160) return false;
    return /^(换|改|再|生成|做|来|版本|三版|两版|地区|继续|改成|换成|变成|变成|用|请)/.test(t)
      || /改成|换成|变成|版本|地区|北京|上海|东京|曼谷|bangkok|beijing/i.test(t) && t.length < 120;
  }

  function extractPlaceHints(text) {
    const t = String(text || "");
    const hints = [];
    const pairs = [
      [/北京|beijing/i, ["北京", "beijing", "peking"]],
      [/上海|shanghai/i, ["上海", "shanghai"]],
      [/东京|tokyo/i, ["东京", "tokyo"]],
      [/曼谷|bangkok/i, ["曼谷", "bangkok"]],
      [/首尔|seoul/i, ["首尔", "seoul"]],
      [/巴黎|paris/i, ["巴黎", "paris"]],
      [/伦敦|london/i, ["伦敦", "london"]],
      [/纽约|new york/i, ["纽约", "new york"]],
    ];
    for (const [re, keys] of pairs) {
      if (re.test(t)) hints.push(...keys);
    }
    return hints;
  }

  function promptMentionsPlace(prompt, placeHints) {
    if (!placeHints.length) return true;
    const lower = String(prompt || "").toLowerCase();
    return placeHints.some((h) => lower.includes(String(h).toLowerCase()));
  }

  function rememberMeta(item) {
    const prompt = cleanPromptText(item.prompt || "");
    const imageUrl = String(item.imageUrl || "");
    const imageKey = String(item.imageKey || "");
    const assetId = normalizeAssetId(item.assetId);
    const transportConversationId = String(item.conversationId || item.conversation_id || "");
    if (transportConversationId && !adoptConversationId(transportConversationId)) return null;
    const entry = {
      prompt,
      promptScore: Number(item.promptScore) || scorePromptText(prompt),
      imageUrl,
      imageKey,
      assetId,
      promptStatus: String(item.promptStatus || item.prompt_status || ""),
      promptSource: String(item.promptSource || item.prompt_source || ""),
      promptPriority: Number(item.promptPriority || item.prompt_priority) || 0,
      promptScope: String(item.promptScope || item.prompt_scope || ""),
      generationStatus: normalizeGenerationStatus(item.generationStatus || item.generation_status),
      conversationId: transportConversationId || currentConversationId(),
      messageId: String(item.messageId || item.message_id || ""),
      generationContextId: String(item.generationContextId || item.generation_context_id || ""),
      providerToolCallId: String(item.providerToolCallId || item.provider_tool_call_id || ""),
      providerGenerationCallId: String(item.providerGenerationCallId || item.provider_generation_call_id || ""),
      providerResponseId: String(item.providerResponseId || item.provider_response_id || ""),
      generationRequestPrompt: String(item.generationRequestPrompt || item.generation_request_prompt || ""),
      model: String(item.model || ""),
      capturedAt: String(item.capturedAt || new Date().toISOString()),
      via: String(item.via || "network"),
      bound: Boolean(item.bound || (prompt && imageUrl)),
      // page-hook only emits auto-image events with isGeneration === true; carry
      // the field through so the auto-image listener below can see it.
      isGeneration: Boolean(item.isGeneration),
    };
    networkMeta.push(entry);
    if (networkMeta.length > 120) networkMeta.splice(0, networkMeta.length - 120);

    const registry = generationRegistryForPage();
    const context = registry?.remember?.(entry) || null;
    const resolvedContext = context ? registry?.resolvedForEntry?.(entry) : null;

    const lookupKeys = imageLookupKeys(imageUrl, { imageKey, assetId });
    const registryImageKeys = context ? registry?.imageKeysForEntry?.(entry) || [] : [];
    const effectiveKeys = [...new Set([...lookupKeys, ...registryImageKeys])];
    const effectivePrompt = resolvedContext?.prompt ? resolvedContext : entry;
    if (effectivePrompt.prompt && effectiveKeys.length) {
      for (const key of effectiveKeys) {
        const current = imagePromptMap.get(key);
        if (!current || metaPromptQuality(effectivePrompt) >= metaPromptQuality(current)) {
          imagePromptMap.set(key, effectivePrompt);
        }
      }
    }
    return entry;
  }

  /**
   * Bound prompt only — never reuse the highest-score caption from the whole chat
   * (that was attaching the first Bangkok caption to every later city image).
   */
  function findBoundPromptForImage(imageUrl) {
    const registryResolved = generationRegistryForPage()?.resolvedForImage?.(imageUrl);
    if (registryResolved?.prompt) return registryResolved;
    const wantedKeys = imageLookupKeys(imageUrl);
    for (const key of wantedKeys) {
      if (imagePromptMap.has(key)) return imagePromptMap.get(key);
    }
    return [...networkMeta].reverse().find((item) => (
      item.prompt && imageLookupKeys(item.imageUrl, item).some((key) => wantedKeys.includes(key))
    )) || null;
  }

  function findGenerationEvidenceForImage(imageUrl) {
    const registryResolved = generationRegistryForPage()?.resolvedForImage?.(imageUrl);
    if (registryResolved?.isGeneration) return registryResolved;
    const wantedKeys = imageLookupKeys(imageUrl);
    if (!wantedKeys.length) return null;
    return [...networkMeta].reverse().find((item) => (
      item.isGeneration === true
      && imageLookupKeys(item.imageUrl, item).some((key) => wantedKeys.includes(key))
    )) || null;
  }

  function findGenerationEvidenceForCandidate(candidate) {
    const imageRef = candidate?.imageUrl || candidate?.key || "";
    const exact = findGenerationEvidenceForImage(imageRef);
    if (exact) return exact;
    const messageIds = messageIdsForCandidate(candidate);
    if (!messageIds.length) return null;
    const registry = generationRegistryForPage();
    const messageResolved = messageIds.length === 1
      ? registry?.resolvedForMessage?.(currentConversationId(), messageIds[0])
      : registry?.resolvedForMessages?.(currentConversationId(), messageIds);
    return messageResolved?.isGeneration ? messageResolved : null;
  }

  /**
   * Automatic capture has a stricter contract than manual save: an image must
   * be bound to a generation-tool result, rather than merely looking like a
   * large ChatGPT asset. User uploads and normal visual-analysis attachments
   * deliberately have no such evidence.
   */
  function hasObservedGenerationEvidence(candidate) {
    if (isReferenceCandidate(candidate)) return false;
    return Boolean(findGenerationEvidenceForCandidate(candidate));
  }

  /**
   * A gallery blob: URL that the page hook mapped to an estuary file id and
   * the registry proved to be a generation output. Its bytes live in the page,
   * so capture never needs the lazy thumbnail <img> to finish decoding.
   */
  function isProvenGalleryBlobUrl(value) {
    const src = String(value || "").trim();
    if (!src.startsWith("blob:")) return false;
    if (!blobAssetIdForUrl(src)) return false;
    return Boolean(findGenerationEvidenceForImage(src));
  }

  function isProvenGalleryBlobImage(image) {
    if (!(image instanceof HTMLImageElement)) return false;
    if (isComposerNode(image) || isReferenceCandidate({ el: image })) return false;
    return isProvenGalleryBlobUrl(image.currentSrc || image.src || "");
  }

  function referenceCandidatesForGeneration(candidate) {
    const image = candidate?.el instanceof HTMLImageElement ? candidate.el : null;
    if (!image) return [];
    const nearestUser = nearestPrecedingUserScope(image);
    if (!nearestUser) return [];
    const references = [];
    for (const unit of userUnitsOfSameMessage(nearestUser, image)) {
      for (const img of unit.querySelectorAll("img")) {
        if (isComposerNode(img)) continue;
        const src = img.currentSrc || img.src || "";
        if (!src) continue;
        references.push({
          key: src,
          el: img,
          imageUrl: src.startsWith("data:") ? "" : src,
          dataUrl: src.startsWith("data:") ? src : "",
          width: img.naturalWidth || img.width || 0,
          height: img.naturalHeight || img.height || 0,
        });
      }
    }
    return references.slice(0, 8);
  }

  /**
   * Stage the uploaded images of the nearest preceding user turn as reference
   * attachments for this generation. Reference bytes may already be stored, but
   * every generation context must still reach the server so the deduplicated
   * attachment can record a usage for this context. Skipping a previously seen
   * reference would make later generations lose their reference lineage.
   */
  async function stageGenerationReferences(candidate) {
    const evidence = findGenerationEvidenceForCandidate(candidate);
    if (!evidence) return { generationContextId: "", stagedReferences: 0 };
    const generationContextId = evidence.generationContextId || "";
    const references = referenceCandidatesForGeneration(candidate);
    let stagedReferences = 0;
    let nextReference = 0;
    const workerCount = Math.min(3, references.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (nextReference < references.length) {
        const index = nextReference;
        nextReference += 1;
        try {
          const result = await ingestCandidate(references[index], { silentSkip: true, reason: "auto-reference", generationContextId });
          if (result) stagedReferences += 1;
        } catch {
          // A failed optional reference must not block the generated output.
        }
      }
    }));
    return { generationContextId, stagedReferences };
  }

  function promptQuality(promptStatus, prompt) {
    const rank = {
      "not-available": 0,
      "user-message": 1,
      "visible-caption": 2,
      "generation-tool-prompt": 3,
    }[String(promptStatus || "")] ?? 0;
    return rank * 10_000 + Math.min(cleanPromptText(prompt).length, 5_000);
  }

  function metaPromptQuality(entry) {
    const explicitPriority = Number(entry?.promptPriority || entry?.prompt_priority) || 0;
    return explicitPriority * 1_000_000 + promptQuality(entry?.promptStatus || entry?.prompt_status, entry?.prompt);
  }

  function generationRegistryForPage() {
    if (generationRegistry) return generationRegistry;
    const factory = globalThis.MosaGenerationRegistry?.createGenerationRegistry;
    if (typeof factory !== "function") return null;
    generationRegistry = factory({
      imageLookupKeys,
      promptQuality: metaPromptQuality,
    });
    return generationRegistry;
  }

  function candidateLookupKeys(candidate) {
    // New ChatGPT previews are blob URLs. Only an unambiguous provider result
    // for this exact message may supply their stable asset identity.
    const evidence = findGenerationEvidenceForCandidate(candidate);
    return imageLookupKeys(candidate?.imageUrl || candidate?.key || "", evidence || {});
  }

  function candidateOperationKey(candidate) {
    const keys = candidateLookupKeys(candidate);
    return keys.find((key) => key.startsWith("asset:"))
      || keys.find((key) => key.startsWith("estuary:"))
      || keys[0]
      || candidate?.key
      || candidate?.imageUrl
      || "";
  }

  function candidateSizeSignature(candidate) {
    const width = Number(candidate?.el?.naturalWidth || candidate?.width || 0);
    const height = Number(candidate?.el?.naturalHeight || candidate?.height || 0);
    return `${width}x${height}`;
  }

  function renderedPixelSignature(candidate) {
    const image = candidate?.el instanceof HTMLImageElement ? candidate.el : null;
    if (!image?.complete || !image.naturalWidth || !image.naturalHeight) return "";
    try {
      const sample = document.createElement("canvas");
      sample.width = 24;
      sample.height = 24;
      const context = sample.getContext("2d", { willReadFrequently: true });
      if (!context) return "";
      context.drawImage(image, 0, 0, sample.width, sample.height);
      const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
      let hash = 2166136261;
      for (let index = 0; index < pixels.length; index += 4) {
        hash ^= pixels[index];
        hash = Math.imul(hash, 16777619);
        hash ^= pixels[index + 1];
        hash = Math.imul(hash, 16777619);
        hash ^= pixels[index + 2];
        hash = Math.imul(hash, 16777619);
        hash ^= pixels[index + 3];
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(16).padStart(8, "0");
    } catch {
      // Cross-origin images can taint canvas. In that case do not pretend the
      // pixels are stable; terminal provider metadata remains the safe gate.
      return "";
    }
  }

  function markSizeFailure(candidate) {
    const key = candidateOperationKey(candidate);
    if (!key) return;
    const signature = candidateSizeSignature(candidate);
    const previous = sizeFailureStates.get(key);
    const count = previous?.signature === signature ? previous.count + 1 : 1;
    sizeFailureStates.set(key, {
      signature,
      count,
      blockedUntil: count >= SIZE_FAILURE_LIMIT ? Date.now() + SIZE_FAILURE_BACKOFF_MS : 0,
    });
    failedAt.set(key, Date.now());
  }

  function isSizeFailureBlocked(candidate) {
    const key = candidateOperationKey(candidate);
    const state = key ? sizeFailureStates.get(key) : null;
    if (!state) return false;
    if (state.signature !== candidateSizeSignature(candidate)) {
      sizeFailureStates.delete(key);
      return false;
    }
    if (state.blockedUntil && Date.now() < state.blockedUntil) return true;
    return false;
  }

  function rememberCandidate(candidate) {
    for (const key of candidateLookupKeys(candidate)) rememberMap(capturedCandidates, key, candidate);
  }

  /** One archived picture, whichever URL variant or DOM node surfaced it. */
  function isSavedCandidate(candidate) {
    const key = candidate?.key || candidate?.imageUrl;
    if (key && savedKeys.has(key)) return true;
    return candidateLookupKeys(candidate).some((identity) => savedIdentityKeys.has(identity));
  }

  function rememberSavedCandidate(candidate, generationStatus = "unknown") {
    const key = candidate?.key || candidate?.imageUrl;
    rememberSet(savedKeys, key);
    const normalizedStatus = normalizeGenerationStatus(generationStatus);
    for (const identity of candidateLookupKeys(candidate)) {
      rememberSet(savedIdentityKeys, identity);
      rememberMap(savedGenerationStatuses, identity, normalizedStatus);
    }
  }

  function savedGenerationStatusForCandidate(candidate) {
    for (const identity of candidateLookupKeys(candidate)) {
      if (savedGenerationStatuses.has(identity)) return savedGenerationStatuses.get(identity) || "unknown";
    }
    return "unknown";
  }

  function clearAutoStability(candidateKey) {
    const timer = autoStabilityTimers.get(candidateKey);
    if (timer) clearTimeout(timer);
    autoStabilityTimers.delete(candidateKey);
    autoStabilityStates.delete(candidateKey);
  }

  function scheduleAutoStabilityRetry(candidate, reason, delayMs) {
    const candidateKey = candidateOperationKey(candidate);
    if (!candidateKey || autoStabilityTimers.has(candidateKey)) return;
    const timer = setTimeout(() => {
      autoStabilityTimers.delete(candidateKey);
      if (autoCapture && !contextLost) enqueueAuto(candidate, `${reason}-stability`);
    }, Math.max(120, delayMs));
    autoStabilityTimers.set(candidateKey, timer);
  }

  function autoCandidateReadiness(candidate, evidence, reason) {
    const candidateKey = candidateOperationKey(candidate);
    if (!candidateKey) return { ready: false, forceTerminalRefresh: false };
    const status = normalizeGenerationStatus(evidence?.generationStatus);
    const savedStatus = savedGenerationStatusForCandidate(candidate);
    const forceTerminalRefresh = isSavedCandidate(candidate)
      && isTerminalGenerationStatus(status)
      && !isTerminalGenerationStatus(savedStatus);

    if (isTerminalGenerationStatus(status)) {
      clearAutoStability(candidateKey);
      return { ready: true, forceTerminalRefresh };
    }

    const now = Date.now();
    const pixelSignature = renderedPixelSignature(candidate);
    const signature = `${candidateSizeSignature(candidate)}|${candidate?.imageUrl || candidate?.key || ""}|${pixelSignature}`;
    const previous = autoStabilityStates.get(candidateKey);
    const state = previous?.signature === signature
      ? previous
      : { signature, firstSeenAt: now, lastSeenAt: now };
    state.lastSeenAt = now;
    autoStabilityStates.set(candidateKey, state);

    const age = now - state.firstSeenAt;
    if (status === "in_progress") {
      requestCurrentConversationRefresh(candidate);
      if (!pixelSignature) {
        scheduleAutoStabilityRetry(candidate, reason, 1_200);
        return { ready: false, forceTerminalRefresh: false };
      }
      if (age < AUTO_IN_PROGRESS_STALE_MS) {
        scheduleAutoStabilityRetry(candidate, reason, Math.min(1_200, AUTO_IN_PROGRESS_STALE_MS - age));
        return { ready: false, forceTerminalRefresh: false };
      }
      // ChatGPT occasionally leaves the final visible output carrying a stale
      // in_progress marker forever. Once the same rendered candidate has been
      // stable for a bounded interval, archive it provisionally and let the
      // duplicate-ingest path merge a later terminal status/prompt.
      clearAutoStability(candidateKey);
      return { ready: true, forceTerminalRefresh: false };
    }

    if (status === "partial") {
      requestCurrentConversationRefresh(candidate);
      if (!pixelSignature) {
        scheduleAutoStabilityRetry(candidate, reason, 1_500);
        return { ready: false, forceTerminalRefresh: false };
      }
      if (age < AUTO_PARTIAL_FALLBACK_MS) {
        scheduleAutoStabilityRetry(candidate, reason, Math.min(1_500, AUTO_PARTIAL_FALLBACK_MS - age));
        return { ready: false, forceTerminalRefresh: false };
      }
    }

    if (age < AUTO_STABILITY_DELAY_MS) {
      scheduleAutoStabilityRetry(candidate, reason, AUTO_STABILITY_DELAY_MS - age);
      return { ready: false, forceTerminalRefresh: false };
    }

    clearAutoStability(candidateKey);
    return { ready: true, forceTerminalRefresh };
  }

  function rememberSavedPrompt(candidate, resolved) {
    const rank = metaPromptQuality(resolved);
    for (const key of candidateLookupKeys(candidate)) {
      rememberMap(savedPromptRanks, key, Math.max(savedPromptRanks.get(key) ?? -1, rank));
    }
  }

  function savedPromptRankForKeys(keys) {
    let rank = -1;
    for (const key of keys) rank = Math.max(rank, savedPromptRanks.get(key) ?? -1);
    return rank;
  }

  async function withAutoCaptureSlot(task) {
    if (autoCaptureInFlight >= AUTO_CAPTURE_CONCURRENCY) {
      await new Promise((resolve) => autoCaptureWaiters.push(resolve));
    } else {
      autoCaptureInFlight += 1;
    }
    try {
      return await task();
    } finally {
      const next = autoCaptureWaiters.shift();
      if (next) next();
      else autoCaptureInFlight -= 1;
    }
  }

  function findCandidateForMeta(keys) {
    for (const key of keys) {
      const remembered = capturedCandidates.get(key);
      if (remembered) return remembered;
    }
    return collectDomCandidates().find((candidate) => (
      candidateLookupKeys(candidate).some((key) => keys.includes(key))
    )) || null;
  }

  /**
   * The conversation metadata can arrive after the image bytes. Re-send only
   * an already archived, lower-quality image; MOSA's hash dedupe upgrades it.
   */
  function schedulePromptUpgrade(meta) {
    const registry = generationRegistryForPage();
    const resolvedOutputs = registry?.resolvedOutputsForEntry?.(meta) || [];
    const targets = resolvedOutputs.length ? resolvedOutputs : [registry?.resolvedForEntry?.(meta) || meta];

    for (const resolvedMeta of targets) {
      if (!cleanPromptText(resolvedMeta?.prompt)) continue;
      const keys = imageLookupKeys(resolvedMeta?.imageUrl || "", resolvedMeta || {});
      if (!keys.length) continue;
      const candidate = findCandidateForMeta(keys);
      if (!candidate) continue;
      // Metadata may arrive after this blob was saved. Its old saved rank is
      // indexed by the blob URL, before the provider asset id became known.
      const savedRank = savedPromptRankForKeys([...keys, ...candidateLookupKeys(candidate)]);
      const nextRank = metaPromptQuality(resolvedMeta);
      if (savedRank < 0 || savedRank >= nextRank) continue;
      const candidateKey = candidateOperationKey(candidate) || candidate.key || candidate.imageUrl;
      if (!candidateKey || promptUpgradeInFlight.has(candidateKey)) continue;
      clearPromptRecovery(candidate.key || candidate.imageUrl || candidateKey);

      promptUpgradeInFlight.add(candidateKey);
      withAutoCaptureSlot(() => ingestCandidate(candidate, {
          silentSkip: true,
          reason: "prompt-upgrade",
          force: true,
        }))
        .catch(() => {})
        .finally(() => promptUpgradeInFlight.delete(candidateKey));
    }
  }

  function clearPromptRecovery(candidateKey) {
    const timers = promptRecoveryTimers.get(candidateKey);
    if (timers) {
      for (const timer of timers) clearTimeout(timer);
      promptRecoveryTimers.delete(candidateKey);
    }
  }

  function schedulePromptRecovery(candidate, { needPrompt = true, needTerminal = false } = {}) {
    const candidateKey = candidate?.key || candidate?.imageUrl;
    const imageRef = candidate?.imageUrl || candidateKey || "";
    if (!candidateKey || !imageRef || promptRecoveryTimers.has(candidateKey)) return;

    // The image can become visible before ChatGPT stores its tool caption.
    // Re-read the active conversation on the same bounded schedule used by
    // generation-evidence recovery; the context registry can then bind a late
    // prompt even after the image was already archived.
    const delays = [2_800, 7_200, 15_000];
    const timers = delays.map((delay, index) => setTimeout(() => {
      const bound = findGenerationEvidenceForCandidate(candidate) || findBoundPromptForImage(imageRef);
      const promptReady = !needPrompt || Boolean(bound?.prompt);
      const terminalReady = !needTerminal || isTerminalGenerationStatus(bound?.generationStatus);
      if (promptReady && terminalReady) {
        clearPromptRecovery(candidateKey);
        return;
      }
      requestCurrentConversationRefresh(candidate);
      if (index === delays.length - 1) promptRecoveryTimers.delete(candidateKey);
    }, delay));
    promptRecoveryTimers.set(candidateKey, timers);
  }

  function enqueueDomFallback(candidate) {
    if (!autoCapture || !isRecoverableGenerationCandidate(candidate) || isSavedCandidate(candidate)) return;
    rememberCandidate(candidate);
    withAutoCaptureSlot(() => ingestCandidate(candidate, {
      silentSkip: true,
      reason: "dom-fallback",
    })).catch(() => {});
  }

  function scheduleGenerationEvidenceRecovery(candidate) {
    if (!autoCapture || !isRecoverableGenerationCandidate(candidate)) return;
    const candidateKey = candidateLookupKeys(candidate)[0] || candidate?.key || candidate?.imageUrl || "";
    if (!candidateKey || generationEvidenceRecoveryTimers.has(candidateKey)) return;
    requestCurrentConversationRefresh(candidate);
    const timers = GENERATION_EVIDENCE_RECOVERY_DELAYS.map((delay, index) => setTimeout(() => {
      if (findGenerationEvidenceForCandidate(candidate)) {
        const activeTimers = generationEvidenceRecoveryTimers.get(candidateKey) || [];
        for (const timer of activeTimers) clearTimeout(timer);
        generationEvidenceRecoveryTimers.delete(candidateKey);
        enqueueAuto(candidate, "evidence-recovered");
        return;
      }
      requestCurrentConversationRefresh(candidate);
      if (index !== GENERATION_EVIDENCE_RECOVERY_DELAYS.length - 1) return;
      generationEvidenceRecoveryTimers.delete(candidateKey);
      enqueueDomFallback(candidate);
    }, delay));
    generationEvidenceRecoveryTimers.set(candidateKey, timers);
  }

  function buildStoredPrompt({ generationPrompt, generationStatus = "", userMessage, via }) {
    const gen = cleanPromptText(generationPrompt);
    const user = cleanPromptText(userMessage).slice(0, 8000);
    const places = extractPlaceHints(user);
    const trustedGeneration = generationStatus === "generation-tool-prompt";
    const visibleCaption = generationStatus === "visible-caption";
    const genOk = gen && (trustedGeneration || visibleCaption);
    const resolvedStatus = trustedGeneration
      ? "generation-tool-prompt"
      : visibleCaption
        ? "visible-caption"
        : "not-available";

    // Heuristics are useful recovery evidence, but they are not provider facts.
    // Never upgrade text merely because it looks like a generation prompt.
    if (gen && !genOk && looksLikeGenerationCaption(gen)) {
      return {
        prompt: "",
        candidatePrompt: gen,
        promptStatus: "not-available",
        userMessage: user,
        promptSource: "heuristic-generation-caption",
      };
    }

    // Real generation caption that matches place intent.
    if (genOk && places.length && promptMentionsPlace(gen, places)) {
      return {
        prompt: gen,
        promptStatus: resolvedStatus,
        userMessage: user,
        promptSource: via || "bound-place-match",
      };
    }

    // Caption present but may be stale vs user place request — still store caption as main prompt,
    // never replace it with the short chat line alone.
    if (genOk && places.length && !promptMentionsPlace(gen, places)) {
      return {
        prompt: gen,
        promptStatus: resolvedStatus,
        userMessage: user,
        promptSource: "bound-caption-place-mismatch",
      };
    }

    if (genOk) {
      return {
        prompt: gen,
        promptStatus: resolvedStatus,
        userMessage: user,
        promptSource: via || "generation",
      };
    }

    // A user turn is context, not ChatGPT's revised generation prompt.
    return {
      prompt: "",
      promptStatus: "not-available",
      userMessage: user || (isWeakChatPrompt(gen) ? "" : gen),
      promptSource: user || gen ? "awaiting-generation-caption" : "none",
    };
  }

  function userMessageForCandidate(candidate) {
    const image = candidate?.el instanceof HTMLImageElement ? candidate.el : null;
    if (!image) return "";
    const nearest = nearestPrecedingUserScope(image);
    return String(nearest?.innerText || "").trim();
  }

  function messageScopeForCandidate(candidate) {
    const image = candidate?.el instanceof HTMLImageElement ? candidate.el : null;
    if (!image) return null;
    return image.closest(
      `${CHATGPT_MESSAGE_SELECTOR}, [data-message-author-role="assistant"], [data-message-author-role="tool"], [data-message-id], ${CHATGPT_TURN_SELECTOR}, article`,
    );
  }

  function domCaptionForCandidate(candidate) {
    const image = candidate?.el instanceof HTMLImageElement ? candidate.el : null;
    if (!image) return "";
    const scope = messageScopeForCandidate(candidate);
    const directSources = [image.getAttribute("alt"), image.getAttribute("aria-label")];
    for (const source of directSources) {
      const text = String(source || "").replace(/\s+/g, " ").trim();
      const match = /model caption\s*:\s*(.+)$/i.exec(text);
      const caption = cleanPromptText(match?.[0] || text);
      if (looksLikeGenerationCaption(caption)) return caption;
    }
    const scopeText = String(scope?.innerText || "").replace(/\s+/g, " ").trim();
    const scopedMatch = /model caption\s*:\s*(.+)$/i.exec(scopeText);
    const scopedCaption = cleanPromptText(scopedMatch?.[0] || "");
    if (looksLikeGenerationCaption(scopedCaption)) return scopedCaption;
    return "";
  }

  function messageIdsForCandidate(candidate) {
    const image = candidate?.el instanceof HTMLImageElement ? candidate.el : null;
    if (!image) return [];
    const directMessage = image.closest?.("[data-message-id]");
    const direct = String(directMessage?.getAttribute?.("data-message-id") || "").trim();
    if (direct) return [direct];
    const searchMessage = image.closest?.(CHATGPT_MESSAGE_SELECTOR);
    const searchIds = String(searchMessage?.getAttribute?.("data-chatgpt-search-message-ids") || "")
      .trim().split(/[\s,]+/).filter(Boolean);
    if (searchIds.length) return [...new Set(searchIds)];
    const turn = conversationTurnForNode(image);
    const nestedMessage = String(turn?.querySelector?.("[data-message-id]")?.getAttribute?.("data-message-id") || "").trim();
    if (nestedMessage) return [nestedMessage];
    const testId = String(turn?.getAttribute?.("data-testid") || "").trim();
    return testId.startsWith("conversation-turn-") ? [testId.slice("conversation-turn-".length)] : [];
  }

  function messageIdForCandidate(candidate) {
    const ids = messageIdsForCandidate(candidate);
    return ids.length === 1 ? ids[0] : "";
  }

  function requestCurrentConversationRefresh(candidate) {
    const conversationId = conversationIdFromUrl();
    if (!conversationId) return false;

    const imageRef = candidate?.imageUrl || candidate?.key || "";
    const proxy = chatGptImageProxyInfo(imageRef);
    // Do not ask the page hook to inspect the active conversation for an image
    // from a different ChatGPT conversation.
    if (proxy?.conversationId && proxy.conversationId !== conversationId) return false;

    const now = Date.now();
    const lastRequested = conversationRefreshRequestedAt.get(conversationId) || 0;
    if (now - lastRequested < CONVERSATION_REFRESH_COOLDOWN_MS) return false;
    conversationRefreshRequestedAt.set(conversationId, now);
    if (conversationRefreshRequestedAt.size > 20) {
      for (const [id, at] of conversationRefreshRequestedAt) {
        if (now - at > CONVERSATION_REFRESH_COOLDOWN_MS * 4) conversationRefreshRequestedAt.delete(id);
      }
    }

    // page-hook.js derives the endpoint from its own location; the content
    // script never supplies a URL or any credential-bearing request detail.
    return postToPageHook("refresh-current-conversation", { conversationId });
  }

  function resolvePrompt(imageUrl, candidate) {
    const userMessage = userMessageForCandidate(candidate);
    const providerAssetId = chatGptImageProxyInfo(imageUrl)?.assetId || "";
    const registry = generationRegistryForPage();
    const generationEvidence = findGenerationEvidenceForCandidate(candidate);

    const bound = findBoundPromptForImage(imageUrl);
    if (bound?.prompt) {
      const built = buildStoredPrompt({
        generationPrompt: bound.prompt,
        generationStatus: bound.promptStatus,
        userMessage,
        via: `bound:${bound.via || "network"}`,
      });
      return {
        ...built,
        promptSource: bound.promptSource || built.promptSource,
        promptPriority: Number(bound.promptPriority) || 0,
        promptScope: bound.promptScope || "output",
        generationStatus: normalizeGenerationStatus(bound.generationStatus),
        model: bound.model || "",
        conversationId: bound.conversationId || "",
        messageId: bound.messageId || "",
        generationContextId: bound.generationContextId || "",
        providerToolCallId: bound.providerToolCallId || "",
        providerGenerationCallId: bound.providerGenerationCallId || "",
        providerResponseId: bound.providerResponseId || "",
        generationRequestPrompt: bound.generationRequestPrompt || generationEvidence?.generationRequestPrompt || "",
        providerAssetId: bound.assetId || providerAssetId,
      };
    }

    // Preview/blob URLs can lose their provider asset identity. Use the
    // containing message only when the registry proves there is exactly one
    // generation attempt in that message. Error + retry messages with several
    // attempts intentionally fail closed here instead of borrowing a sibling
    // attempt's prompt.
    const domMessageIds = messageIdsForCandidate(candidate);
    const domMessageId = domMessageIds.length === 1 ? domMessageIds[0] : "";
    const messageBound = domMessageIds.length === 1
      ? registry?.resolvedForMessage?.(currentConversationId(), domMessageIds[0])
      : registry?.resolvedForMessages?.(currentConversationId(), domMessageIds);
    if (messageBound?.isGeneration) {
      const built = buildStoredPrompt({
        generationPrompt: messageBound.prompt,
        generationStatus: messageBound.promptStatus,
        userMessage,
        via: `message:${messageBound.via || "registry"}`,
      });
      return {
        ...built,
        promptSource: messageBound.promptSource || built.promptSource,
        promptPriority: Number(messageBound.promptPriority) || 0,
        promptScope: messageBound.promptScope || "attempt",
        generationStatus: normalizeGenerationStatus(messageBound.generationStatus),
        model: messageBound.model || "",
        conversationId: messageBound.conversationId || currentConversationId(),
        messageId: messageBound.messageId || domMessageId,
        generationContextId: messageBound.generationContextId || "",
        providerToolCallId: messageBound.providerToolCallId || "",
        providerGenerationCallId: messageBound.providerGenerationCallId || "",
        providerResponseId: messageBound.providerResponseId || "",
        generationRequestPrompt: messageBound.generationRequestPrompt || "",
        providerAssetId: messageBound.assetId || providerAssetId,
      };
    }

    // Cached ChatGPT routes can render an image without replaying the
    // conversation response. Keep the fallback inside that image's own
    // message and accept only the explicit Model caption marker.
    const domCaption = domCaptionForCandidate(candidate);
    if (domCaption) {
      const built = buildStoredPrompt({
        generationPrompt: domCaption,
        generationStatus: "visible-caption",
        userMessage,
        via: "dom-message-caption",
      });
      return {
        ...built,
        promptPriority: 425,
        promptScope: "output",
        generationStatus: normalizeGenerationStatus(generationEvidence?.generationStatus),
        model: "",
        conversationId: currentConversationId(),
        messageId: messageIdForCandidate(candidate),
        generationContextId: "",
        providerToolCallId: "",
        providerGenerationCallId: "",
        providerResponseId: "",
        generationRequestPrompt: generationEvidence?.generationRequestPrompt || "",
        providerAssetId,
      };
    }

    const built = buildStoredPrompt({
      generationPrompt: "",
      userMessage,
      via: "user-fallback",
    });
    return {
      ...built,
      promptPriority: 0,
      promptScope: "",
      generationStatus: normalizeGenerationStatus(generationEvidence?.generationStatus),
      model: "",
      conversationId: currentConversationId(),
      messageId: "",
      generationContextId: "",
      providerToolCallId: "",
      providerGenerationCallId: "",
      providerResponseId: "",
      generationRequestPrompt: generationEvidence?.generationRequestPrompt || "",
      providerAssetId,
    };
  }

  async function originalBytesFromUrl(url) {
    if (!url) throw new Error("未能读取图片字节（下载失败或跨域）");
    if (url.startsWith("blob:")) {
      // A blob handle only resolves inside the page, not in the service worker.
      const response = await fetch(url);
      if (!response.ok) throw new Error(`blob/img fetch failed (${response.status})`);
      const blob = await response.blob();
      const buffer = await blob.arrayBuffer();
      return { mimeType: blob.type || "image/png", imageBase64: arrayBufferToBase64(buffer) };
    }
    const response = await runtimeSend({ type: "mosa.fetchImage", url });
    if (!response?.ok) throw new Error(response?.error || "Image download failed");
    return response.result;
  }

  async function canvasBytesFromImage(el) {
    if (!(el instanceof HTMLImageElement) || !el.complete || !el.naturalWidth) {
      throw new Error("未能读取图片字节（下载失败或跨域）");
    }
    const canvas = document.createElement("canvas");
    canvas.width = el.naturalWidth;
    canvas.height = el.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("未能读取图片字节（下载失败或跨域）");
    context.drawImage(el, 0, 0);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Canvas encoding failed")), "image/png");
    });
    const buffer = await blob.arrayBuffer();
    return { mimeType: blob.type || "image/png", imageBase64: arrayBufferToBase64(buffer) };
  }

  function renderedCandidateFor(candidate) {
    const keys = candidateLookupKeys(candidate);
    if (!keys.length) return null;
    for (const image of document.querySelectorAll("img")) {
      if (!(image instanceof HTMLImageElement) || !image.complete || !image.naturalWidth) continue;
      const src = image.currentSrc || image.src || "";
      if (!src) continue;
      const imageKeys = imageLookupKeys(src);
      if (!imageKeys.some((key) => keys.includes(key))) continue;
      return {
        ...candidate,
        key: src,
        imageUrl: src,
        el: image,
        width: image.naturalWidth || image.width || candidate?.width || 0,
        height: image.naturalHeight || image.height || candidate?.height || 0,
      };
    }
    return null;
  }

  async function waitForRenderedCandidate(candidate, timeoutMs = DOM_MEDIA_GRACE_MS) {
    const immediate = candidate?.el instanceof HTMLImageElement && candidate.el.complete && candidate.el.naturalWidth
      ? candidate
      : renderedCandidateFor(candidate);
    if (immediate) return immediate;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      const rendered = renderedCandidateFor(candidate);
      if (rendered) return rendered;
    }
    return null;
  }

  /**
   * Give the original provider bytes a very short head start so JPEG/WebP
   * generations keep their original encoding and do not balloon into a large
   * synchronous PNG data URL. A rendered DOM image remains the low-latency
   * fallback, and a tainted canvas can still wait for the bounded network read.
   */
  async function bytesFromUrlOrImg(candidate) {
    if (candidate.dataUrl) {
      const match = /^data:([^;]+);base64,(.+)$/i.exec(candidate.dataUrl);
      if (!match) throw new Error("Unsupported data URL");
      return { mimeType: match[1], imageBase64: match[2] };
    }

    const originalUrl = candidate.imageUrl || candidate.key || "";
    // A proven gallery blob is page-local: read its original bytes directly
    // instead of waiting for the lazy thumbnail <img> to decode.
    if (isProvenGalleryBlobUrl(originalUrl)) return originalBytesFromUrl(originalUrl);
    const originalPromise = /^https:/i.test(originalUrl)
      ? originalBytesFromUrl(originalUrl).then((value) => ({ value }), () => null)
      : null;
    const renderedPromise = waitForRenderedCandidate(candidate);
    if (originalPromise) {
      const fastOriginal = await Promise.race([
        originalPromise,
        renderedPromise.then(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), 220)),
      ]);
      if (fastOriginal?.value) return fastOriginal.value;
    }
    const rendered = await renderedPromise;
    if (rendered?.el) {
      try {
        return await canvasBytesFromImage(rendered.el);
      } catch {
        // Some provider images taint canvas. Fall back to provider bytes.
      }
    }
    if (originalPromise) {
      const original = await originalPromise;
      if (original?.value) return original.value;
    }
    if (originalUrl) return originalBytesFromUrl(originalUrl);
    return canvasBytesFromImage(candidate.el);
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

  /** Real pixel size of image bytes, decoded once and released immediately. */
  async function decodedImageDimensions(imageBase64, mimeType) {
    try {
      const binary = atob(String(imageBase64 || ""));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType || "image/png" }));
      const dimensions = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
      return dimensions;
    } catch {
      return null;
    }
  }

  function canAttempt(candidate, { force = false } = {}) {
    const key = candidateOperationKey(candidate);
    if (!key) return false;
    if (inFlight.has(key)) return false;
    if (force) return true;
    if (isSavedCandidate(candidate)) return false;
    if (isSizeFailureBlocked(candidate)) return false;
    const domRecovered = candidate?.el instanceof HTMLImageElement
      && candidate.el.complete
      && candidate.el.naturalWidth > 0
      && candidateLookupKeys(candidate).some((identity) => failedNetworkIdentityKeys.has(identity));
    if (domRecovered) return true;
    const failed = failedAt.get(key);
    if (failed && Date.now() - failed < 8_000) return false;
    return true;
  }

  async function ingestCandidate(candidate, { silentSkip = false, reason = "manual", force = false, generationContextId = "" } = {}) {
    const taskConversationEpoch = conversationEpoch;
    const rawKey = candidate.key || candidate.imageUrl;
    const key = candidateOperationKey(candidate) || rawKey;
    const manual = reason.startsWith("manual");
    const reference = isReferenceCandidate(candidate) || reason === "auto-reference";
    rememberCandidate(candidate);
    if (!canAttempt(candidate, { force: manual || reference || force })) {
      if (!silentSkip) {
        const saved = isSavedCandidate(candidate);
        showToast(saved ? "这张已处理过（或已入库）" : "请稍后再试（冷却中）", true);
        setStatus(saved ? "已处理过" : "冷却中");
      }
      return null;
    }
    if (!isArchiveWorthyCandidate(candidate, { manual, reference })) {
      if (!manual) {
        if (hasObservedGenerationEvidence(candidate) || isRecoverableGenerationCandidate(candidate)) markSizeFailure(candidate);
        else rememberSet(savedKeys, key);
      }
      if (!silentSkip) showToast("已跳过：不像生成大图（logo/小图）", true);
      setStatus("跳过小图/logo");
      return null;
    }
    inFlight.add(key);
    setStatus(`保存中… (${reason})`);

    try {
      // Ask the MAIN-world hook to re-read only the active conversation before
      // waiting. Cached ChatGPT pages otherwise render the image without
      // replaying the conversation response through the fetch/XHR interceptors.
      const imageRef = candidate.imageUrl || key;
      const refreshRequested = !findBoundPromptForImage(imageRef)
        && requestCurrentConversationRefresh(candidate);
      const promptWaitMs = manual ? 700 : refreshRequested ? 450 : 0;
      const promptWaitDeadline = Date.now() + promptWaitMs;
      while (Date.now() < promptWaitDeadline && !findBoundPromptForImage(imageRef)) {
        await new Promise((r) => setTimeout(r, 150));
      }
      if (taskConversationEpoch !== conversationEpoch) return null;
      const resolved = resolvePrompt(imageRef, candidate);
      const { mimeType, imageBase64 } = await bytesFromUrlOrImg(candidate);
      if (taskConversationEpoch !== conversationEpoch) return null;
      if (!imageBase64) throw new Error("未能读取图片字节（下载失败或跨域）");

      // Approximate decoded size from base64.
      const approxBytes = Math.floor((imageBase64.length || 0) * 0.75);
      if (!reference && approxBytes > 0 && approxBytes < MIN_BYTES) {
        if (!manual) {
          if (hasObservedGenerationEvidence(candidate) || isRecoverableGenerationCandidate(candidate)) markSizeFailure(candidate);
          else rememberSet(savedKeys, key);
        }
        if (!silentSkip) showToast(`已跳过小文件 ${(approxBytes / 1024).toFixed(0)}KB（logo）`, true);
        setStatus("跳过小文件");
        return null;
      }

      // A proven gallery blob's <img> may never decode, so its reported size
      // is unknown. Enforce the proven-generation floor on the real decoded
      // pixel size instead of trusting display dimensions.
      if (!reference && !manual && isProvenGalleryBlobUrl(imageRef)) {
        const dimensions = await decodedImageDimensions(imageBase64, mimeType);
        if (dimensions && Math.min(dimensions.width, dimensions.height) < PROVEN_GENERATION_MIN_EDGE) {
          markSizeFailure(candidate);
          setStatus("跳过小文件");
          return null;
        }
      }

      // Auto may still save without caption (prompt empty / not-available). Manual always saves.

      const response = await runtimeSend({
        type: "mosa.ingest",
        payload: {
          prompt: resolved.prompt,
          promptStatus: resolved.promptStatus,
          userMessage: resolved.userMessage,
          model: resolved.model,
          promptSource: resolved.promptSource,
          promptPriority: Number(resolved.promptPriority) || 0,
          promptScope: resolved.promptScope || "",
          generationStatus: normalizeGenerationStatus(resolved.generationStatus),
          isReference: isReferenceCandidate(candidate),
          mimeType,
          imageBase64,
          imageUrl: imageRef,
          pageUrl: location.href,
          conversationId: resolved.conversationId || currentConversationId(),
          generationSessionTitle: sessionTitleForConversation(resolved.conversationId || currentConversationId()),
          messageId: resolved.messageId,
          generationContextId: generationContextId || resolved.generationContextId || "",
          providerToolCallId: resolved.providerToolCallId || "",
          providerGenerationCallId: resolved.providerGenerationCallId || "",
          providerResponseId: resolved.providerResponseId || "",
          generationRequestPrompt: resolved.generationRequestPrompt || "",
          providerAssetId: resolved.providerAssetId || "",
          captureMode: manual ? "manual" : "automatic",
          capturedAt: new Date().toISOString(),
        },
      });
      if (!response?.ok) throw new Error(response?.error || "Unknown extension error");

      const result = response.result;
      rememberSavedCandidate(candidate, resolved.generationStatus);
      failedAt.delete(key);
      sizeFailureStates.delete(key);
      for (const identity of candidateLookupKeys(candidate)) failedNetworkIdentityKeys.delete(identity);
      rememberSavedPrompt(candidate, resolved);

      // Capture the narrow race where metadata appeared while image bytes were
      // downloading, after resolvePrompt had already returned no prompt.
      const lateBound = findGenerationEvidenceForCandidate(candidate) || findBoundPromptForImage(imageRef);
      if (lateBound?.prompt) schedulePromptUpgrade(lateBound);
      const needsPromptRecovery = !lateBound?.prompt
        && !["visible-caption", "generation-tool-prompt"].includes(resolved.promptStatus);
      const latestStatus = normalizeGenerationStatus(lateBound?.generationStatus || resolved.generationStatus);
      const needsTerminalRecovery = !isTerminalGenerationStatus(latestStatus);
      if (needsPromptRecovery || needsTerminalRecovery) {
        schedulePromptRecovery(candidate, {
          needPrompt: needsPromptRecovery,
          needTerminal: needsTerminalRecovery,
        });
      }

      if (result.status === "imported") {
        const label = resolved.prompt ? resolved.promptStatus : "no-caption";
        showToast(`GravityPort 入库 ✓ ${label}`);
        setStatus(`已入库 · ${label} · 共${savedKeys.size}`);
      } else if (result.upgraded) {
        showToast("GravityPort 已升级提示词");
        setStatus(`提示词已升级 · 共${savedKeys.size}`);
      } else if (!silentSkip) {
        showToast("GravityPort 已存在相同图片");
        setStatus(`已存在 · 共${savedKeys.size}`);
      } else {
        setStatus(`已同步(跳过) · 共${savedKeys.size}`);
      }
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/too small|IMAGE_TOO_SMALL|logo/i.test(msg)) {
        if (!manual) {
          if (hasObservedGenerationEvidence(candidate) || isRecoverableGenerationCandidate(candidate)) markSizeFailure(candidate);
          else rememberSet(savedKeys, key);
        }
      } else {
        failedAt.set(key, Date.now());
        if (reason === "network" && !candidate.el) {
          for (const identity of candidateLookupKeys(candidate)) failedNetworkIdentityKeys.add(identity);
        }
      }
      // Always surface manual errors; auto stays quiet for pure size junk.
      // An optional reference failure never alarms the user, in either path.
      const optionalReferenceFailure = reason === "auto-reference";
      if (!silentSkip || (!optionalReferenceFailure && !/too small|IMAGE_TOO_SMALL/i.test(msg))) {
        showToast(msg, true);
      }
      if (optionalReferenceFailure) setStatus(`参考图跳过: ${msg.slice(0, 60)}`);
      else setStatus(`失败: ${msg.slice(0, 120)}`, true);
      throw error;
    } finally {
      inFlight.delete(key);
    }
  }

  function enqueueAuto(candidate, reason) {
    if (!autoCapture) return;
    if (!isArchiveWorthyCandidate(candidate, { manual: false })) return;
    const evidence = findGenerationEvidenceForCandidate(candidate);
    if (!evidence || isReferenceCandidate(candidate)) {
      if (!evidence && isRecoverableGenerationCandidate(candidate)) scheduleGenerationEvidenceRecovery(candidate);
      return;
    }
    rememberCandidate(candidate);
    const readiness = autoCandidateReadiness(candidate, evidence, reason);
    if (!readiness.ready) return;
    const queueKey = candidateOperationKey(candidate);
    if (!queueKey || queuedAutoKeys.has(queueKey)) return;
    queuedAutoKeys.add(queueKey);
    withAutoCaptureSlot(async () => {
        try {
          const { generationContextId, stagedReferences } = await stageGenerationReferences(candidate);
          const outputIdentity = candidateLookupKeys(candidate)[0] || candidate.key || candidate.imageUrl || "";
          const syncKey = `${generationContextId || evidence.messageId || "legacy"}|${outputIdentity}`;
          const needsReferenceRepair = stagedReferences > 0
            && isSavedCandidate(candidate)
            && !referenceSyncKeys.has(syncKey);
          const result = await ingestCandidate(candidate, {
            silentSkip: true,
            reason,
            generationContextId,
            force: needsReferenceRepair || readiness.forceTerminalRefresh,
          });
          // A forced duplicate ingest is intentional: it lets the server merge
          // references that appeared in the DOM after the network result was archived.
          if (needsReferenceRepair && result) rememberSet(referenceSyncKeys, syncKey);
        } catch {
          // keep queue alive
        } finally {
          queuedAutoKeys.delete(queueKey);
        }
      }).catch(() => {});
  }

  function pageState() {
    return {
      autoCapture,
      cachedPromptCount: networkMeta.filter((item) => item.prompt).length,
      contextLost,
      conversationId: currentConversationId(),
      debug: captureDebugEvents.slice(-6),
      error: lastError,
      hookReady,
      pageUrl: location.href,
      savedCount: Math.max(savedIdentityKeys.size, savedKeys.size),
      status: lastStatus,
    };
  }

  function renderControlPanel() {
    const panel = controlPanel?.isConnected
      ? controlPanel
      : document.getElementById("mosa-capture-panel");
    if (!panel) return;
    controlPanel = panel;

    const state = pageState();
    const mode = panel.querySelector('[data-role="mode"]');
    const connection = panel.querySelector('[data-role="connection"]');
    const detail = panel.querySelector('[data-role="detail"]');
    const saved = panel.querySelector('[data-role="saved-count"]');
    const cached = panel.querySelector('[data-role="prompt-count"]');
    const debug = panel.querySelector('[data-role="debug"]');
    const toggle = panel.querySelector('[data-action="toggle-auto"]');

    if (mode) {
      mode.textContent = state.autoCapture ? "运行中" : "已关闭";
      mode.classList.toggle("is-off", !state.autoCapture);
    }
    if (connection) {
      connection.textContent = state.contextLost
        ? "页面脚本需刷新"
        : state.hookReady
          ? "Hook 已连接"
          : "Hook 连接中";
      connection.classList.toggle("is-error", Boolean(state.contextLost || state.error));
    }
    if (detail) {
      detail.textContent = state.error
        ? state.error
        : state.autoCapture
          ? "正在监听当前会话中的生成图片"
          : "自动入库已暂停，不会处理新图片";
      detail.setAttribute("role", state.error ? "alert" : "status");
      detail.setAttribute("aria-live", state.error ? "assertive" : "polite");
    }
    if (saved) saved.textContent = String(state.savedCount);
    if (cached) cached.textContent = String(state.cachedPromptCount);
    if (debug) {
      debug.textContent = state.debug.length
        ? state.debug.map((item) => JSON.stringify(item)).join("\n")
        : "暂无捕获事件";
    }
    if (toggle) {
      toggle.textContent = state.autoCapture ? "关闭自动入库" : "启动自动入库";
      toggle.classList.toggle("is-off", !state.autoCapture);
      toggle.setAttribute("aria-pressed", String(state.autoCapture));
    }
  }

  function finishPanelDrag(event) {
    if (event && panelDragState && event.pointerId !== panelDragState.pointerId) return;
    controlPanel?.classList.remove("is-dragging");
    panelDragState = null;
    document.removeEventListener("pointermove", moveControlPanel, true);
    document.removeEventListener("pointerup", finishPanelDrag, true);
    document.removeEventListener("pointercancel", finishPanelDrag, true);
  }

  function moveControlPanel(event) {
    if (!panelDragState || !controlPanel || event.pointerId !== panelDragState.pointerId) return;
    const width = controlPanel.offsetWidth;
    const height = controlPanel.offsetHeight;
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    const maxTop = Math.max(8, window.innerHeight - height - 8);
    const left = Math.min(maxLeft, Math.max(8, event.clientX - panelDragState.offsetX));
    const top = Math.min(maxTop, Math.max(8, event.clientY - panelDragState.offsetY));
    controlPanel.style.left = `${Math.round(left)}px`;
    controlPanel.style.top = `${Math.round(top)}px`;
    controlPanel.style.right = "auto";
  }

  function startPanelDrag(event) {
    if (event.button !== 0 || !controlPanel) return;
    if (!event.target.closest?.('[data-drag-handle]') || event.target.closest?.("button")) return;
    const rect = controlPanel.getBoundingClientRect();
    panelDragState = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    controlPanel.classList.add("is-dragging");
    document.addEventListener("pointermove", moveControlPanel, true);
    document.addEventListener("pointerup", finishPanelDrag, true);
    document.addEventListener("pointercancel", finishPanelDrag, true);
    event.preventDefault();
  }

  function handlePanelEscape(event) {
    if (event.key === "Escape" && controlPanel?.isConnected) closeControlPanel();
  }

  function closeControlPanel() {
    finishPanelDrag();
    document.removeEventListener("keydown", handlePanelEscape, true);
    controlPanel?.classList.remove("is-visible");
    const panel = controlPanel;
    controlPanel = null;
    if (panel) setTimeout(() => panel.remove(), 150);
  }

  async function handleControlPanelClick(event) {
    const button = event.target.closest?.("[data-action]");
    if (!button) return;
    const action = button.getAttribute("data-action");
    if (action === "close") {
      closeControlPanel();
      return;
    }
    if (action === "toggle-auto") {
      autoCapture = !autoCapture;
      await chrome.storage?.local?.set?.({ autoCapture });
      setStatus(autoCapture ? "自动入库已开启" : "自动入库已关闭");
      showToast(autoCapture ? "GravityPort 自动入库已开启" : "GravityPort 自动入库已关闭");
      if (autoCapture) scheduleScan(true);
      renderControlPanel();
      return;
    }
    if (action === "save-visible") {
      try {
        await runManualAction("save-visible");
      } catch {
        // runManualAction already surfaces the failure.
      }
      renderControlPanel();
      return;
    }
    if (action === "save-all") {
      try {
        await runManualAction("save-all");
      } catch {
        // runManualAction already surfaces the failure.
      }
      renderControlPanel();
      return;
    }
    if (action === "open-settings") {
      const response = await runtimeSend({ type: "mosa.openOptions" });
      if (!response?.ok) showToast(response?.error || "无法打开设置", true);
      else closeControlPanel();
      return;
    }
    if (action === "copy-debug") {
      const diagnostics = JSON.stringify({
        version: chrome.runtime?.getManifest?.().version || "",
        state: pageState(),
      }, null, 2);
      await navigator.clipboard?.writeText?.(diagnostics);
      showToast("GravityPort 捕获诊断已复制");
    }
  }

  function ensureControlPanel() {
    const existing = document.getElementById("mosa-capture-panel");
    if (existing) {
      controlPanel = existing;
      renderControlPanel();
      return existing;
    }
    const host = document.body || document.documentElement;
    if (!host) return null;

    const panel = document.createElement("section");
    panel.id = "mosa-capture-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "GravityPort Capture 控制台");
    panel.setAttribute("aria-modal", "false");
    panel.innerHTML = `
      <header class="mosa-panel-header" data-drag-handle>
        <div class="mosa-panel-brand">
          <span class="mosa-panel-logo" aria-hidden="true">M</span>
          <span>
            <strong>GravityPort Capture</strong>
            <small>ChatGPT Web Capture</small>
          </span>
        </div>
        <button type="button" class="mosa-panel-icon-button" data-action="close" aria-label="关闭 GravityPort 控制台">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </header>
      <div class="mosa-panel-body">
        <section class="mosa-panel-status-card">
          <div class="mosa-panel-status-row">
            <span>
              <small>自动入库</small>
              <strong data-role="connection">Hook 连接中</strong>
            </span>
            <span class="mosa-panel-mode" data-role="mode">运行中</span>
          </div>
          <p data-role="detail" role="status" aria-live="polite">正在读取当前页面状态</p>
        </section>
        <div class="mosa-panel-metrics">
          <span><small>当前页面已存</small><strong data-role="saved-count">0</strong></span>
          <span><small>Prompt 缓存</small><strong data-role="prompt-count">0</strong></span>
        </div>
        <details class="mosa-panel-debug">
          <summary>捕获诊断（不含 Prompt 正文）</summary>
          <pre data-role="debug">暂无捕获事件</pre>
          <button type="button" class="mosa-panel-secondary" data-action="copy-debug">复制诊断</button>
        </details>
        <button type="button" class="mosa-panel-primary" data-action="toggle-auto" aria-pressed="true">
          关闭自动入库
        </button>
        <button type="button" class="mosa-panel-secondary" data-action="save-visible">保存当前图</button>
        <button type="button" class="mosa-panel-secondary" data-action="save-all">保存全部大图</button>
        <button type="button" class="mosa-panel-secondary" data-action="open-settings">打开设置</button>
        <footer>拖动顶部移动 · Esc 关闭</footer>
      </div>
    `;
    panel.addEventListener("click", handleControlPanelClick);
    panel.addEventListener("pointerdown", startPanelDrag);
    host.appendChild(panel);
    controlPanel = panel;
    document.addEventListener("keydown", handlePanelEscape, true);
    renderControlPanel();
    requestAnimationFrame(() => panel.classList.add("is-visible"));
    return panel;
  }

  function toggleControlPanel() {
    if (controlPanel?.isConnected || document.getElementById("mosa-capture-panel")) {
      closeControlPanel();
      return false;
    }
    return Boolean(ensureControlPanel());
  }

  async function runManualAction(action, { imageUrl } = {}) {
    if (contextLost || !extensionAlive()) {
      markContextLost();
      throw new Error(CONTEXT_LOST_MESSAGE);
    }
    enablePageHookForManualCapture();

    // Right-click "save image" targets a specific src; prefer it over the
    // generic viewport heuristic so the user gets the picture they clicked.
    let target = null;
    if (imageUrl) {
      target = domCandidateForImage(imageUrl, { manual: true })
        || collectDomCandidates({ manual: true }).find((candidate) => (
          candidate.imageUrl === imageUrl || candidate.key === imageUrl
        ))
        || null;
    }

    const candidates = collectDomCandidates({ manual: true });
    if (!candidates.length && !target) {
      const message = "没找到可保存的大图：请等图片加载完成后再试";
      showToast(message, true);
      setStatus("未找到图片", true);
      throw new Error(message);
    }

    if (action === "save-image" || action === "save-image-with-prompt") {
      if (!target) target = currentViewportCandidate(candidates);
      if (!target) throw new Error("未找到当前可见图片");
      const { generationContextId } = await stageGenerationReferences(target);
      const result = await ingestCandidate(target, { reason: "manual-context", generationContextId });
      return {
        action,
        attempted: 1,
        completed: 1,
        failed: 0,
        result,
      };
    }

    if (action === "save-visible") {
      const current = target || currentViewportCandidate(candidates);
      if (!current) throw new Error("未找到当前可见图片");
      const { generationContextId } = await stageGenerationReferences(current);
      const result = await ingestCandidate(current, { reason: "manual-popup", generationContextId });
      return {
        action,
        attempted: 1,
        completed: 1,
        failed: 0,
        result,
      };
    }

    if (action === "save-all") {
      const batch = candidates.slice(0, 12);
      let completed = 0;
      let failed = 0;
      let firstError = null;
      for (const candidate of batch) {
        try {
          const { generationContextId } = await stageGenerationReferences(candidate);
          await ingestCandidate(candidate, { silentSkip: false, reason: "manual-popup-all", generationContextId });
          completed += 1;
        } catch (error) {
          failed += 1;
          firstError ||= error;
        }
      }
      if (!completed && firstError) throw firstError;
      setStatus(`批量完成 · ${completed}/${batch.length}`);
      return {
        action,
        attempted: batch.length,
        completed,
        failed,
      };
    }

    throw new Error(`未知操作: ${action}`);
  }

  chrome.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return false;

    if (message.type === "mosa.capture.togglePanel") {
      sendResponse({ ok: true, open: toggleControlPanel(), state: pageState() });
      return false;
    }

    if (message.type === "mosa.capture.getPageState") {
      sendResponse({ ok: true, state: pageState() });
      return false;
    }

    const actionByType = {
      "mosa.capture.saveVisible": "save-visible",
      "mosa.capture.saveAll": "save-all",
      "mosa.capture.saveImage": "save-image",
      "mosa.capture.saveImageWithPrompt": "save-image-with-prompt",
    };
    const action = actionByType[message.type];
    if (!action) return false;

    runManualAction(action, { imageUrl: message.imageUrl })
      .then((result) => sendResponse({ ok: true, result, state: pageState() }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        state: pageState(),
      }));
    return true;
  });

  function scheduleScan(force = false) {
    if (contextLost) return;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(async () => {
      if (contextLost) return;
      if (!extensionAlive()) {
        markContextLost();
        return;
      }
      hookReady ||= document.documentElement?.dataset?.mosaPageHook === "1";
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        const nextConversationId = conversationIdFromUrl();
        if (nextConversationId) {
          const previousConversationId = activeConversationId;
          adoptConversationId(nextConversationId);
          if (autoCapture && nextConversationId !== previousConversationId) requestCurrentConversationRefresh(null);
        } else if (activeConversationId) {
          // Leaving a named conversation for a true new-chat/non-conversation
          // route is a real boundary. The reverse transition (empty -> assigned
          // id) is identity enrichment and deliberately preserves live-only
          // WebSocket evidence such as Model caption and request Prompt.
          activeConversationId = "";
          resetConversationTransientState();
        }
      }
      const net = networkMeta.filter((x) => x.prompt).length;
      setStatus(`${autoCapture ? "自动开" : "自动关"} · hook${hookReady ? "✓" : "…"} · 缓存${net} · 已存${savedKeys.size}`);
      if (!autoCapture && !force) return;

      const candidates = collectDomCandidates();
      // Size/URL only filters UI clutter. A bound generation event is required
      // before auto-save, so user uploads in ordinary chats never enter MOSA.
      // Filter old/saved/ineligible images BEFORE applying the per-scan budget.
      // Otherwise a long chat whose six largest images are already archived
      // permanently starves every newer generated image below them.
      const eligible = candidates.filter((candidate) => {
        if (!canAttempt(candidate)) return false;
        if (!isArchiveWorthyCandidate(candidate)) return false;
        if (candidate.el instanceof HTMLImageElement) {
          // A proven gallery blob reads its bytes from the blob: URL, so an
          // undecoded lazy gallery thumbnail is still archivable.
          if (!candidate.el.complete && !isProvenGalleryBlobImage(candidate.el)) return false;
        }
        if (hasObservedGenerationEvidence(candidate)) return true;
        if (isRecoverableGenerationCandidate(candidate)) scheduleGenerationEvidenceRecovery(candidate);
        return false;
      }).slice(0, 6);
      for (const candidate of eligible) {
        enqueueAuto(candidate, "dom-scan");
      }
    }, force ? 120 : 600);
  }

  async function loadSettings() {
    try {
      const response = await runtimeSend({ type: "mosa.getSettings" });
      if (response?.ok && response.settings) {
        autoCapture = response.settings.autoCapture !== false;
        pageHookCaptureAck = null;
        syncPageHookCaptureEnabled();
        syncPageHookDiagnostics(response.settings);
        return;
      }
    } catch {
      if (contextLost) return;
    }

    // The background owns defaults and migration. A temporary messaging failure
    // must never overwrite an explicit local "off" preference.
    try {
      const stored = await chrome.storage?.local?.get?.({ autoCapture, captureDiagnostics: false });
      if (stored) {
        autoCapture = stored.autoCapture !== false;
        syncPageHookDiagnostics({ captureDiagnostics: stored.captureDiagnostics === true });
      }
    } catch {
      // Keep the in-memory value when both settings paths are unavailable.
    }
    pageHookCaptureAck = null;
    syncPageHookCaptureEnabled();
  }

  function syncPageHookDiagnostics(settings) {
    const enabled = settings?.captureDiagnostics === true;
    postToPageHook("set-diagnostics-enabled", { enabled });
  }

  function handlePageHookEvent(data) {
    if (data.type === "generation-meta" && data.payload) {
      if (data.payload.hookReady) {
        hookReady = true;
        pageHookCaptureAck = null;
        syncPageHookCaptureEnabled();
        setStatus(`${autoCapture ? "自动开" : "自动关"} · hook✓`);
        return;
      }
      if (data.payload.prompt || data.payload.imageUrl || data.payload.imageKey) {
        const meta = rememberMeta(data.payload);
        if (!meta) return;
        schedulePromptUpgrade(meta);
        if (meta.isGeneration) {
          const keys = imageLookupKeys(meta.imageUrl || "", meta);
          const candidate = findCandidateForMeta(keys);
          if (candidate) {
            const candidateKey = candidateLookupKeys(candidate)[0] || candidate.key || candidate.imageUrl || "";
            const timers = generationEvidenceRecoveryTimers.get(candidateKey) || [];
            for (const timer of timers) clearTimeout(timer);
            if (candidateKey) generationEvidenceRecoveryTimers.delete(candidateKey);
            enqueueAuto(candidate, "metadata-recovered");
          } else {
            scheduleScan(true);
          }
        }
      }
    }

    if (data.type === "capture-debug" && data.payload) {
      captureDebugEvents.push(data.payload);
      while (captureDebugEvents.length > 24) captureDebugEvents.shift();
      renderControlPanel();
      return;
    }

    // One record per prompt-less capture. The hook reduced the record to
    // safe fields before sending it; the content script forwards it to the
    // background for retention only. The page hook never blocks on this.
    if (data.type === "capture-diagnostic" && data.payload) {
      if (extensionAlive()) {
        Promise.resolve(runtimeSend({
          type: "mosa.recordDiagnostic",
          payload: {
            ...data.payload,
            recordedAtIso: new Date().toISOString(),
          },
        })).catch(() => {});
      }
      return;
    }

    if (data.type === "capture-state") {
      pageHookCaptureAck = data.payload?.enabled === true;
      const desired = desiredPageHookCaptureEnabled();
      if (pageHookCaptureAck === desired) {
        if (pageHookSyncTimer) clearTimeout(pageHookSyncTimer);
        pageHookSyncTimer = null;
        if (desired) {
          requestCurrentConversationRefresh(null);
          if (autoCapture) scheduleScan(true);
        }
      } else {
        syncPageHookCaptureEnabled();
      }
      return;
    }

    // A failed recovery used to be invisible, so captures kept landing without
    // a caption and nothing on screen said why.
    if (data.type === "conversation-refresh-failed") {
      const status = Number(data.payload?.status) || 0;
      if (data.payload?.soft) {
        setStatus(
          `实时 Hook 正常 · 历史会话回读不可用${status ? ` (${status})` : ""}`,
        );
        return;
      }
      setStatus(
        `会话元数据读取失败${status ? ` (${status})` : ""}，提示词可能缺失`,
        true,
      );
      return;
    }

    if (data.type === "harvest-skipped") {
      setStatus("会话元数据过大，已启用图片兜底，提示词可能延后", true);
      return;
    }

    // The hook emits this only after binding a tool-owned generation prompt to
    // the asset. CDN/host alone is intentionally not treated as provenance.
    if (data.type === "auto-image" && data.payload?.imageUrl && autoCapture) {
      const imageUrl = String(data.payload.imageUrl);
      const meta = rememberMeta(data.payload);
      if (!meta) return;
      if (meta.isGeneration !== true) return;
      if (!isLikelyGeneratedUrl(imageUrl)) return;
      if (enqueueDomCandidateForImage(imageUrl, "network-dom")) return;
      // auto-image is emitted only for explicit image-generation provenance.
      // Do not require the caption to arrive in the same event: ChatGPT often
      // publishes the image first and the generation prompt later.
      enqueueAuto({
        key: imageUrl,
        imageUrl,
        dataUrl: "",
        el: null,
        width: 0,
        height: 0,
      }, "network");
    }

    if (data.type === "dom-image" && data.payload?.imageUrl && autoCapture) {
      const imageUrl = String(data.payload.imageUrl);
      const w = Number(data.payload.width) || 0;
      const h = Number(data.payload.height) || 0;
      if (!isLikelyGeneratedUrl(imageUrl)) return;
      if (w > 0 && h > 0 && (w < MIN_EDGE || h < MIN_EDGE)) return;
      enqueueDomCandidateForImage(imageUrl, "dom-hook");
    }

    // The image may render before its mapping arrives; re-check that one image.
    if (data.type === "blob-asset" && data.payload) {
      const mapping = rememberBlobAsset(data.payload);
      if (mapping && autoCapture) enqueueDomCandidateForImage(mapping.blobUrl, "blob-asset");
    }

    // Turn structure of the conversation the user has open: the hook already
    // reduced it to ids and numbers. Relay is best effort like stack naming —
    // failures stay invisible and the next conversation load retries.
    if (data.type === "conversation-turn-bindings" && data.payload) {
      const report = data.payload;
      const conversationId = String(report.conversationId || "");
      const turnCount = Number(report.turnCount) || 0;
      if (conversationId && turnCount >= 1 && Array.isArray(report.bindings) && report.bindings.length) {
        if (!contextLost && extensionAlive()) {
          Promise.resolve(runtimeSend({
            type: "mosa.reportConversationTurns",
            payload: {
              provider: "chatgpt",
              conversationId,
              turnCount,
              bindings: report.bindings,
            },
          })).catch(() => {});
        }
      }
    }
  }

  // The page hook hands over a private MessagePort exactly once, via a window
  // message that only fires while the page is still loading. Every report
  // afterwards arrives through that port; plain window messages are ignored,
  // because any page script can post those.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "mosa-chatgpt-capture") return;
    if (data.type !== "hook-port") return;
    // First port wins: any later transfer is ignored.
    if (hookPort || !event.ports?.[0]) return;
    hookPort = event.ports[0];
    if (hookPortRequestTimer) {
      clearTimeout(hookPortRequestTimer);
      hookPortRequestTimer = null;
    }
    hookPort.addEventListener("message", (portEvent) => {
      const portData = portEvent?.data;
      if (portData && typeof portData === "object") handlePageHookEvent(portData);
    });
    hookPort.start?.();
    hookPort.postMessage({ source: "mosa-chatgpt-capture", type: "hook-port-ack" });
  });

  observer = new MutationObserver(() => {
    if (autoCapture) scheduleScan(false);
  });
  const startObs = () => {
    observer.disconnect();
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "alt", "aria-label"],
    });
  };

  // Stack naming: report the conversation title so unnamed session stacks get
  // named — including old conversations reopened long after their captures.
  // Best effort only: failures are dropped silently, never queued or retried,
  // and a dead extension context must stay invisible here (no context-lost
  // toast for a background nicety).
  function reportSessionTitleNow() {
    if (contextLost || !extensionAlive()) return;
    const conversationId = conversationIdFromUrl();
    const title = currentConversationTitle();
    if (!conversationId || !title) return;
    const key = `${conversationId}\u001f${title}`;
    if (key === lastSessionTitleReportKey) return;
    lastSessionTitleReportKey = key;
    Promise.resolve(runtimeSend({
      type: "mosa.reportSessionTitle",
      payload: { provider: "chatgpt", conversationId, title },
    })).catch(() => {});
  }

  function scheduleSessionTitleReport(delay = 800) {
    if (contextLost) return;
    if (sessionTitleReportTimer) clearTimeout(sessionTitleReportTimer);
    sessionTitleReportTimer = setTimeout(() => {
      sessionTitleReportTimer = null;
      reportSessionTitleNow();
    }, delay);
  }

  function startTitleWatcher() {
    const title = document.querySelector("head > title");
    if (!title) return false;
    titleObserver.disconnect();
    titleObserver.observe(title, { childList: true, characterData: true, subtree: true });
    return true;
  }

  function bootSessionTitleReporting() {
    if (startTitleWatcher()) scheduleSessionTitleReport(0);
    else {
      document.addEventListener("DOMContentLoaded", () => {
        startTitleWatcher();
        scheduleSessionTitleReport(0);
      }, { once: true });
    }
  }

  // Boot. page-hook.js is a document_start MAIN-world content script.
  loadSettings().then(() => {
    syncPageHookCaptureEnabled();
    if (autoCapture) {
      if (document.documentElement) startObs();
      else document.addEventListener("DOMContentLoaded", startObs, { once: true });
      requestCurrentConversationRefresh(null);
      scheduleScan(true);
    }
  });
  document.addEventListener("DOMContentLoaded", () => syncPageHookCaptureEnabled(), { once: true });
  bootSessionTitleReporting();

  // The hook transfers its port at document_start, which can happen before
  // this listener exists. Ask for a (replacement) port until one arrives; the
  // hook ignores requests once the first port has been confirmed, so an
  // attacker replaying this message mints nothing.
  const HOOK_PORT_REQUEST_DELAYS = [1_000, 2_000, 4_000, 8_000];
  function scheduleHookPortRequest() {
    if (hookPortRequestTimer) clearTimeout(hookPortRequestTimer);
    hookPortRequestTimer = setTimeout(() => {
      hookPortRequestTimer = null;
      if (hookPort || contextLost) return;
      window.postMessage({ source: "mosa-chatgpt-capture", type: "hook-port-request" }, location.origin);
      hookPortRequestAttempt += 1;
      if (hookPortRequestAttempt < HOOK_PORT_REQUEST_DELAYS.length) scheduleHookPortRequest();
    }, HOOK_PORT_REQUEST_DELAYS[hookPortRequestAttempt]);
  }
  scheduleHookPortRequest();

  // Aggressive periodic auto scan — user explicitly wants hands-free save.
  // Doubles as the orphan watchdog: an extension reload flips the dock to the
  // refresh instruction within 2s instead of waiting for a failed save.
  autoScanInterval = setInterval(() => {
    if (!extensionAlive()) {
      markContextLost();
      return;
    }
    if (autoCapture) scheduleScan(true);
  }, 5000);

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !changes.autoCapture) return;
    autoCapture = changes.autoCapture.newValue !== false;
    if (autoCapture) {
      manualHookLeaseUntil = 0;
      if (manualHookDisableTimer) clearTimeout(manualHookDisableTimer);
      manualHookDisableTimer = null;
    }
    pageHookCaptureAck = null;
    syncPageHookCaptureEnabled();
    setStatus(autoCapture ? "自动开" : "自动关");
    if (autoCapture) {
      startObs();
      requestCurrentConversationRefresh(null);
      scheduleScan(true);
    } else {
      observer?.disconnect();
      if (scanTimer) clearTimeout(scanTimer);
      for (const timer of autoStabilityTimers.values()) clearTimeout(timer);
      autoStabilityTimers.clear();
      autoStabilityStates.clear();
    }
  });
})();
