(() => {
  // Google keeps changing the markup of Gemini, Flow, and AI Studio. This
  // adapter uses only rendered image data. Gemini, Flow, and AI Studio may
  // additionally read one structurally-associated visible user Prompt. None
  // of these paths scans the whole page, other sessions, or editors.
  const IMAGE_HOSTS = new Set([
    "lh3.googleusercontent.com",
    "lh4.googleusercontent.com",
    "lh5.googleusercontent.com",
    "lh6.googleusercontent.com",
    "storage.googleapis.com",
    "generativelanguage.googleapis.com",
    "flow-content.google",
    "*.googleusercontent.com",
  ]);
  const BLOCK_URL_HINTS = [
    "avatar", "profile", "favicon", "logo", "icon", "sprite", "emoji",
    "thumbnail", "googlelogo", "placehold", "material-symbol",
  ];
  // Flow may insert a locale segment between /fx/ and /tools/ (for example
  // /fx/en/tools/flow/project/<id>). Keep the route gate explicit so the
  // provider still stays limited to Flow itself.
  const providerPolicy = globalThis.MosaProviderPolicy;
  if (!providerPolicy) return;
  const AI_STUDIO_VIDEO_PATH = /^\/generate-video(?:\/|$)/;
  // Flow places a media grid and its Prompt card in the same generation row,
  // but that row is nested deeply beneath the individual image link. The
  // limit is deliberately just enough for that documented row boundary, not a
  // page-wide search. Long prompts are normal for Flow, so preserve one card
  // up to 20k characters rather than silently dropping it.
  const FLOW_PROMPT_MAX_CHARS = 20_000;
  const FLOW_PROMPT_MAX_ANCESTORS = 14;
  const FLOW_PROMPT_MAX_NODES = 96;
  const FLOW_PROMPT_ANCHOR = /reuse\s+prompt/i;
  const GEMINI_PROMPT_MAX_CHARS = 24_000;
  const GEMINI_MAX_PREVIOUS_TURNS = 8;
  const AI_STUDIO_PROMPT_MAX_CHARS = 24_000;
  // AI Studio renders Markdown with a deeply expanded Angular node tree. This
  // budget applies only inside the already-selected single user-prompt block.
  const AI_STUDIO_PROMPT_MAX_NODES = 12_000;
  const AI_STUDIO_MAX_PREVIOUS_TURNS = 16;
  // A "generation block" is a maximal run of consecutive user turns followed
  // by its model turns. The block id anchors on the run's first turn id because
  // that turn exists from the moment an upload lands, while later text turns
  // can still be appended to the same block.
  const AI_STUDIO_BLOCK_MAX_TURNS = 64;
  // Reference images are page-local uploads: a much smaller floor than the
  // generated-output gate is enough, and no viewport-area threshold applies.
  const AI_STUDIO_REF_MIN_EDGE = 32;
  const AI_STUDIO_REF_MAX_PER_BLOCK = 8;
  const AI_STUDIO_REF_BLOCKS_MAX = 64;
  const MIN_EDGE = 512;
  const MIN_VISIBLE_AREA = 96 * 96;
  const CAPTURE_CONCURRENCY = 2;
  const MAX_LOCAL_IMAGE_BYTES = 15 * 1024 * 1024;
  const MAX_LOCAL_VIDEO_BYTES = 96 * 1024 * 1024;
  const VIDEO_TRANSFER_CHUNK_BYTES = 3 * 1024 * 1024;
  const PROMPT_RETRY_DELAYS = [900, 2_700, 7_200, 15_000, 30_000];
  const PROMPT_RETRY_PROVIDERS = new Set(["gemini", "flow", "google-ai-studio"]);
  // Generated Google media can be rendered through page-local blob URLs. Keep
  // the gate limited to the supported media-generation surfaces.
  const BLOB_MEDIA_HOSTS = ["aistudio.google.com", "labs.google", "flow.google.com"];
  // A failed Flow media probe must not re-fire on every scan tick; bounded
  // per-media backoff replaces an unbounded retry loop.
  const FLOW_PROBE_BACKOFF_DELAYS = [15_000, 60_000, 300_000];
  const FLOW_PROBE_FAILURES_MAX = 64;
  const SEEN_MAX = 2048;
  const seen = new Set();
  const flowMediaProbeInFlight = new Set();
  const flowProbeFailures = new Map();
  const promptRetryStates = new Map();
  // AI Studio generation blocks. User-uploaded reference images are remembered
  // per block id and only sent when that block's generated media is captured.
  // These tables intentionally survive URL changes: the first automatic run
  // renames /prompts/new_chat to /prompts/<id> while the same turns stay
  // mounted, and a collapsed turn keeps its blob: URL readable even after the
  // <img> element is removed. Block ids are page-visit turn ids, so stale
  // entries cannot collide across conversations.
  const aiStudioBlockReferences = new Map();
  const aiStudioSentOutputs = new Map();
  const aiStudioReferenceUploads = new Map();
  const aiStudioOutputReplays = new Set();
  let lastProviderUrl = location.href;
  let autoCapture = false;
  let scanTimer = null;
  let scanInterval = null;
  let observer = null;
  let captureInFlight = 0;
  const captureWaiters = [];
  let toastTimer = null;
  let providerContextLost = false;

  function rememberSeen(key) {
    if (!key) return;
    seen.delete(key);
    seen.add(key);
    while (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
  }

  // Automatic hand-off (review 294 B). The background keeps a queued or
  // refused capture, so the key stays. Only a retryable answer, or a message
  // that never got an answer, frees the key, and then only twice and 60 s apart.
  const HANDOFF_RETRY_MAX_ATTEMPTS = 2;
  const HANDOFF_RETRY_GAP_MS = 60_000;
  const handoffRetryAttempts = new Map();

  function releaseSeenForRetry(key) {
    const attempts = handoffRetryAttempts.get(key) || 0;
    if (attempts >= HANDOFF_RETRY_MAX_ATTEMPTS) return;
    handoffRetryAttempts.delete(key);
    handoffRetryAttempts.set(key, attempts + 1);
    while (handoffRetryAttempts.size > SEEN_MAX) handoffRetryAttempts.delete(handoffRetryAttempts.keys().next().value);
    setTimeout(() => seen.delete(key), HANDOFF_RETRY_GAP_MS);
  }

  function handOffNeedsRetry(response) {
    return !response || (response.ok === false && response.retryable === true);
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

  function currentProvider() {
    return providerPolicy.providerForPageUrl(location.href);
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
    clearAllPromptRetries();
    showToast("GravityPort 扩展已更新，请刷新此网页恢复自动收录。", true, 0);
  }

  function isAllowedImageHost(hostname) {
    const host = String(hostname || "").toLowerCase();
    if (IMAGE_HOSTS.has(host)) return true;
    return host.endsWith(".googleusercontent.com") || host.endsWith(".ggpht.com");
  }

  function isAllowedLocalImageUrl(url) {
    // Flow serves generated bytes from this exact same-origin media redirect
    // endpoint (on either Flow host). Keep the allowlist narrow so ordinary
    // page assets cannot be copied locally.
    return providerPolicy.isFlowMediaRedirectUrl(url.href);
  }

  function flowMediaIdFromImage(img) {
    if (currentProvider() !== "flow" || !(img instanceof HTMLImageElement)) return "";
    const candidates = [
      elementAttribute(img, "src"),
      img.currentSrc,
      img.src,
    ];
    for (const candidate of candidates) {
      const raw = String(candidate || "").trim();
      if (!raw || !raw.includes("media.getMediaUrlRedirect")) continue;
      try {
        const url = new URL(raw, location.href);
        if (url.origin !== location.origin || !providerPolicy.isFlowMediaRedirectUrl(url.href)) continue;
        const mediaId = String(url.searchParams.get("name") || "").trim();
        if (mediaId) return mediaId;
      } catch {
        // Ignore malformed transient src values while Flow rerenders a tile.
      }
    }
    return "";
  }

  function isVisibleFlowMediaThumbnail(img) {
    if (!(img instanceof HTMLImageElement) || !img.complete || !flowMediaIdFromImage(img)) return false;
    const width = Number(img.naturalWidth || img.width || 0);
    const height = Number(img.naturalHeight || img.height || 0);
    if (width < 128 || height < 128) return false;
    const rect = img.getBoundingClientRect?.();
    if (!rect || rect.width < 1 || rect.height < 1) return false;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return false;
    if (Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0))
      * Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0)) < MIN_VISIBLE_AREA) return false;
    const style = getComputedStyle(img);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
  }

  // Flow media tiles enter through the redirect-thumbnail channel with a
  // 128px floor; the generic image channel keeps the 512px floor. Prompt
  // association must use the same floor that admitted the tile, or a small
  // natural-size grid tile would import media while systematically losing
  // its visible Prompt card on every bounded retry.
  function isCaptureEligibleImage(provider, img) {
    if (provider === "flow" && flowMediaIdFromImage(img)) return isVisibleFlowMediaThumbnail(img);
    return isVisibleGeneratedImage(img);
  }

  function imageSource(value) {
    const src = String(value || "").trim();
    if (!src || src.startsWith("data:")) return null;
    if (src.startsWith("blob:")) {
      try {
        const url = new URL(src);
        // A blob handle is page-local. Do not read a handle carrying another
        // origin, even if a page happens to render it in an image element.
        // Generated Google media can be rendered through page-local blob URLs.
        // Keep the gate limited to the supported video-generation surfaces.
        if (!BLOB_MEDIA_HOSTS.includes(location.hostname) || url.origin !== location.origin) return null;
        return { kind: "local", url: src };
      } catch {
        return null;
      }
    }
    try {
      const url = new URL(src, location.href);
      if (url.protocol !== "https:") return null;
      const lower = `${url.hostname}${url.pathname}`.toLowerCase();
      if (BLOCK_URL_HINTS.some((hint) => lower.includes(hint))) return null;
      if (url.origin === location.origin && isAllowedLocalImageUrl(url)) {
        return { kind: "local", url: url.href };
      }
      if (!isAllowedImageHost(url.hostname)) return null;
      return { kind: "remote", url: url.href };
    } catch {
      return null;
    }
  }

  function supportedImageUrl(value) {
    return imageSource(value)?.url || "";
  }

  function imageUrlFor(img) {
    return imageSource(img?.currentSrc || img?.src || "")?.url || "";
  }

  function imageSourceFor(img) {
    return imageSource(img?.currentSrc || img?.src || "");
  }

  function videoSource(value) {
    const src = String(value || "").trim();
    if (!src || src.startsWith("data:")) return null;
    if (src.startsWith("blob:")) {
      try {
        const url = new URL(src);
        if (!BLOB_MEDIA_HOSTS.includes(location.hostname) || url.origin !== location.origin) return null;
        return { kind: "local", url: src };
      } catch {
        return null;
      }
    }
    try {
      const url = new URL(src, location.href);
      if (url.protocol !== "https:") return null;
      if (url.origin === location.origin) {
        if ((location.hostname === "labs.google" || location.hostname === "flow.google.com") && isAllowedLocalImageUrl(url)) return { kind: "local", url: url.href };
        if (location.hostname === "aistudio.google.com") return { kind: "local", url: url.href };
      }
      if (!isAllowedImageHost(url.hostname)) return null;
      return { kind: "remote", url: url.href };
    } catch {
      return null;
    }
  }

  function videoSourceFor(video) {
    const direct = video?.currentSrc || video?.src || "";
    const nested = Array.from(video?.children || []).find((child) => String(child?.tagName || "").toLowerCase() === "source")?.src || "";
    return videoSource(direct || nested);
  }

  function videoForSource(sourceUrl) {
    return Array.from(document.querySelectorAll?.("video") || []).find((candidate) => videoSourceFor(candidate)?.url === sourceUrl) || null;
  }

  function elementAttribute(node, name) {
    try {
      return String(node?.getAttribute?.(name) || "").trim();
    } catch {
      return "";
    }
  }

  function flowNodeChildren(node) {
    return Array.from(node?.children || []).filter((child) => child && child.nodeType === 1);
  }

  function flowNodeIsUiGlyph(node) {
    const tag = String(node?.tagName || "").toLowerCase();
    if (tag === "mat-icon") return true;
    const className = String(node?.className?.baseVal ?? node?.className ?? "").toLowerCase();
    return className.includes("material-symbol")
      || className.includes("material-icon")
      || className.includes("google-symbol");
  }

  function flowNodeIsExcludedFromPromptText(node) {
    const tag = String(node?.tagName || "").toLowerCase();
    if (["button", "a", "input", "textarea", "select", "option", "script", "style"].includes(tag)) return true;
    if (flowNodeIsUiGlyph(node)) return true;
    if (elementAttribute(node, "contenteditable").toLowerCase() === "true") return true;
    if (elementAttribute(node, "aria-hidden").toLowerCase() === "true") return true;
    return false;
  }

  function flowNodeAllowsVisibleText(node) {
    if (!node || node.nodeType !== 1) return false;
    const style = typeof getComputedStyle === "function" ? getComputedStyle(node) : null;
    if (style && (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0)) return false;
    return elementAttribute(node, "aria-hidden").toLowerCase() !== "true";
  }

  function flowNodeIsVisible(node) {
    if (!node || node.nodeType !== 1) return false;
    const style = typeof getComputedStyle === "function" ? getComputedStyle(node) : null;
    if (style && (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0)) return false;
    const rect = node.getBoundingClientRect?.();
    if (!rect) return true;
    if (rect.width < 1 || rect.height < 1) return false;
    if (typeof innerWidth === "number" && typeof innerHeight === "number"
      && (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth)) return false;
    return true;
  }

  function nodeIsRendered(node) {
    if (!node || node.nodeType !== 1) return false;
    const style = typeof getComputedStyle === "function" ? getComputedStyle(node) : null;
    if (style && (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0)) return false;
    const rect = node.getBoundingClientRect?.();
    return !rect || (rect.width >= 1 && rect.height >= 1);
  }

  function flowTextFromNode(node, { includeControls = false, maxNodes = FLOW_PROMPT_MAX_NODES } = {}) {
    const parts = [];
    let visited = 0;
    function visit(current) {
      if (!current || visited >= maxNodes) return;
      visited += 1;
      if (current.nodeType === 3) {
        const value = String(current.nodeValue || "").replace(/\s+/g, " ").trim();
        if (value) parts.push(value);
        return;
      }
      if (current.nodeType !== 1) return;
      if (!includeControls && flowNodeIsExcludedFromPromptText(current)) return;
      if (!flowNodeAllowsVisibleText(current)) return;
      for (const child of Array.from(current.childNodes || [])) visit(child);
    }
    visit(node);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  function flowReusePromptAnchorCount(node) {
    let visited = 0;
    let count = 0;
    const stack = [node];
    while (stack.length && visited < FLOW_PROMPT_MAX_NODES && count < 2) {
      const current = stack.shift();
      if (!current || current.nodeType !== 1) continue;
      visited += 1;
      if (!flowNodeAllowsVisibleText(current)) continue;
      const tag = String(current.tagName || "").toLowerCase();
      const role = elementAttribute(current, "role").toLowerCase();
      const label = [
        elementAttribute(current, "aria-label"),
        elementAttribute(current, "title"),
        elementAttribute(current, "data-tooltip"),
      ].join(" ").trim();
      const text = flowTextFromNode(current, { includeControls: true, maxNodes: 12 });
      const buttonLike = tag === "button" || tag === "a" || role === "button" || Boolean(label);
      if (buttonLike && FLOW_PROMPT_ANCHOR.test(`${label} ${text}`)) count += 1;
      for (const child of flowNodeChildren(current)) stack.push(child);
    }
    return count;
  }

  function flowHasReusePromptAnchor(node) {
    return flowReusePromptAnchorCount(node) === 1;
  }

  function flowPromptTextFromCard(card) {
    if (!flowNodeIsVisible(card)) return "";
    const raw = flowTextFromNode(card);
    if (!raw || raw.length > FLOW_PROMPT_MAX_CHARS) return "";
    const prompt = raw
      .replace(/^\s*prompt\s*:?\s*/i, "")
      .replace(/\s+prompt\s*:?\s*$/i, "")
      .trim();
    if (!prompt || prompt.length > FLOW_PROMPT_MAX_CHARS) return "";
    return prompt;
  }

  function flowNearbyPromptCard(image) {
    if (!image || !flowNodeIsVisible(image)) {
      return "";
    }
    let node = image;

    for (let depth = 0; node && depth < FLOW_PROMPT_MAX_ANCESTORS; depth += 1) {
      const parent = node.parentElement;
      if (!parent) break;
      const siblings = flowNodeChildren(parent);
      const promptCards = siblings
        .filter((candidate) => candidate !== node && flowNodeIsVisible(candidate))
        .map((candidate) => ({ candidate, prompt: flowPromptTextFromCard(candidate) }))
        .filter((entry) => entry.prompt);

      // The sibling card itself holds the image's Reuse Prompt control. This
      // preserves a one-image-group association even when Flow wraps the
      // image grid and its Prompt card at different depths.
      const reusePromptCards = promptCards.filter((entry) => flowHasReusePromptAnchor(entry.candidate));

      if (reusePromptCards.length === 1) {
        return reusePromptCards[0].prompt;
      }
      // Localized Flow builds do not necessarily render the English “Reuse
      // Prompt” label. When the generation row contains exactly one viable
      // text card, the structural one-to-one association is stronger evidence
      // than a language-specific control label. Stay fail-closed when two text
      // cards are present so we never guess between adjacent generations.
      if (reusePromptCards.length === 0 && promptCards.length === 1) {
        return promptCards[0].prompt;
      }
      node = parent;
    }
    return "";
  }

  function flowVisiblePromptForImage(image) {
    if (currentProvider() !== "flow" || !isCaptureEligibleImage("flow", image)) return null;
    const prompt = flowNearbyPromptCard(image);
    return prompt ? {
      prompt,
      promptStatus: "provider-visible-prompt",
      promptSource: "flow-visible-prompt",
    } : null;
  }

  function flowVisiblePromptForVideo(video) {
    if (currentProvider() !== "flow" || !isVisibleGeneratedVideo(video)) return null;
    const prompt = flowNearbyPromptCard(video);
    return prompt ? {
      prompt,
      promptStatus: "provider-visible-prompt",
      promptSource: "flow-visible-prompt",
    } : null;
  }

  function geminiVisibleUserPromptForImage(image) {
    if (currentProvider() !== "gemini" || !isVisibleGeneratedImage(image)) return null;
    const modelResponse = ancestorWithTag(image, "model-response");
    if (!modelResponse || !flowNodeIsVisible(modelResponse)) return null;

    let previous = modelResponse.previousElementSibling;
    for (let count = 0; previous && count < GEMINI_MAX_PREVIOUS_TURNS; count += 1) {
      if (String(previous.tagName || "").toLowerCase() === "user-query"
        && flowNodeIsVisible(previous)
        && flowNodeAllowsVisibleText(previous)) {
        const prompt = flowTextFromNode(previous);
        if (prompt && prompt.length <= GEMINI_PROMPT_MAX_CHARS) return {
          prompt,
          promptStatus: "provider-visible-prompt",
          promptSource: "gemini-visible-user-prompt",
        };
      }
      previous = previous.previousElementSibling;
    }
    return null;
  }

  function ancestorWithTag(node, tagName) {
    const expected = String(tagName || "").toUpperCase();
    let current = node;
    while (current && current !== document.documentElement) {
      if (String(current.tagName || "").toUpperCase() === expected) return current;
      current = current.parentElement;
    }
    return null;
  }

  function directTurnContainer(turn, role) {
    return flowNodeChildren(turn).find((child) => child.classList?.contains("chat-turn-container")
      && child.classList?.contains(role)) || null;
  }

  function descendantsWithClass(root, className, maxNodes = 256) {
    const matches = [];
    const stack = flowNodeChildren(root);
    let visited = 0;
    while (stack.length && visited < maxNodes && matches.length < 2) {
      const current = stack.shift();
      if (!current || current.nodeType !== 1) continue;
      visited += 1;
      if (current.classList?.contains(className)) matches.push(current);
      for (const child of flowNodeChildren(current)) stack.push(child);
    }
    return matches;
  }

  function aiStudioPromptFromUserTurn(turn) {
    const userContainer = directTurnContainer(turn, "user");
    if (!userContainer || !nodeIsRendered(userContainer)) return "";
    const promptBlocks = descendantsWithClass(userContainer, "user-prompt-container");
    if (promptBlocks.length !== 1 || !nodeIsRendered(promptBlocks[0])) return "";
    const prompt = flowTextFromNode(promptBlocks[0], { maxNodes: AI_STUDIO_PROMPT_MAX_NODES });
    if (!prompt || prompt.length > AI_STUDIO_PROMPT_MAX_CHARS) return "";
    return prompt;
  }

  function aiStudioVisibleUserPromptForImage(image) {
    if (currentProvider() !== "google-ai-studio" || !isVisibleGeneratedImage(image)) return null;
    const imageTurn = ancestorWithTag(image, "ms-chat-turn");
    const sessionContent = imageTurn?.parentElement;
    if (!imageTurn || !sessionContent?.classList?.contains("chat-session-content")
      || !directTurnContainer(imageTurn, "model")) return null;
    let previous = imageTurn.previousElementSibling;
    for (let count = 0; previous && count < AI_STUDIO_MAX_PREVIOUS_TURNS; count += 1) {
      if (String(previous.tagName || "").toLowerCase() === "ms-chat-turn") {
        const prompt = aiStudioPromptFromUserTurn(previous);
        if (prompt) return {
          prompt,
          promptStatus: "provider-visible-prompt",
          promptSource: "google-ai-studio-visible-user-prompt",
        };
      }
      previous = previous.previousElementSibling;
    }
    return null;
  }

  function aiStudioVisibleUserPromptForVideo(video) {
    if (currentProvider() !== "google-ai-studio" || !isVisibleGeneratedVideo(video)) return null;
    const videoTurn = ancestorWithTag(video, "ms-chat-turn");
    const sessionContent = videoTurn?.parentElement;
    if (!videoTurn || !sessionContent?.classList?.contains("chat-session-content")
      || !directTurnContainer(videoTurn, "model")) return null;
    let previous = videoTurn.previousElementSibling;
    for (let count = 0; previous && count < AI_STUDIO_MAX_PREVIOUS_TURNS; count += 1) {
      if (String(previous.tagName || "").toLowerCase() === "ms-chat-turn") {
        const prompt = aiStudioPromptFromUserTurn(previous);
        if (prompt) return {
          prompt,
          promptStatus: "provider-visible-prompt",
          promptSource: "google-ai-studio-visible-user-prompt",
        };
      }
      previous = previous.previousElementSibling;
    }
    return null;
  }

  function aiStudioTurnRole(turn) {
    if (String(turn?.tagName || "").toUpperCase() !== "MS-CHAT-TURN") return "";
    if (directTurnContainer(turn, "user")) return "user";
    if (directTurnContainer(turn, "model")) return "model";
    return "";
  }

  function aiStudioMediaTurn(media) {
    const turn = ancestorWithTag(media, "ms-chat-turn");
    const sessionContent = turn?.parentElement;
    if (!turn || !sessionContent?.classList?.contains("chat-session-content")) return null;
    return turn;
  }

  // The generation block id is the id of the first turn of the consecutive
  // user-turn run that owns the media's block: for a model turn, walk back
  // over model turns (collapsed shells included) to the first user turn, then
  // to that user run's first turn. Without a resolvable first user turn or a
  // turn-<UUID> id there is no block id, and the output is sent as before.
  function aiStudioGenerationContextIdForTurn(turn) {
    let role = aiStudioTurnRole(turn);
    if (!role) return "";
    if (role === "model") {
      let previous = turn.previousElementSibling;
      let userTurn = null;
      for (let count = 0; previous && count < AI_STUDIO_BLOCK_MAX_TURNS; count += 1) {
        const previousRole = aiStudioTurnRole(previous);
        if (previousRole === "user") {
          userTurn = previous;
          break;
        }
        if (previousRole !== "model") break;
        previous = previous.previousElementSibling;
      }
      if (!userTurn) return "";
      turn = userTurn;
      role = "user";
    }
    let first = turn;
    let bounded = false;
    for (let count = 0; count < AI_STUDIO_BLOCK_MAX_TURNS; count += 1) {
      const previous = first.previousElementSibling;
      if (!previous || aiStudioTurnRole(previous) !== role) {
        bounded = true;
        break;
      }
      first = previous;
    }
    if (!bounded) return "";
    const id = elementAttribute(first, "id");
    return id.startsWith("turn-") ? `ai-studio-turn:${id.slice("turn-".length)}` : "";
  }

  function aiStudioGenerationContextIdForMedia(media) {
    const turn = aiStudioMediaTurn(media);
    return turn ? aiStudioGenerationContextIdForTurn(turn) : "";
  }

  function aiStudioReferenceCandidate(img) {
    if (!(img instanceof HTMLImageElement) || !img.complete) return null;
    const turn = aiStudioMediaTurn(img);
    if (!turn || aiStudioTurnRole(turn) !== "user") return null;
    if (ancestorWithTag(img, "ms-thought-chunk") || !ancestorWithTag(img, "ms-image-chunk")) return null;
    const source = imageSourceFor(img);
    if (source?.kind !== "local" || !source.url.startsWith("blob:")) return null;
    const width = Number(img.naturalWidth || img.width || 0);
    const height = Number(img.naturalHeight || img.height || 0);
    if (width < AI_STUDIO_REF_MIN_EDGE || height < AI_STUDIO_REF_MIN_EDGE) return null;
    if (!nodeIsRendered(img)) return null;
    const generationContextId = aiStudioGenerationContextIdForTurn(turn);
    if (!generationContextId) return null;
    return { generationContextId, url: source.url, width, height };
  }

  // Remember user-uploaded reference images in memory only. Nothing is sent
  // here: references of a block go out only when that block's generated media
  // is captured.
  function recordAiStudioReferences() {
    for (const img of document.images || []) {
      const candidate = aiStudioReferenceCandidate(img);
      if (!candidate) continue;
      const entries = aiStudioBlockReferences.get(candidate.generationContextId);
      if (entries?.some((entry) => entry.url === candidate.url)) continue;
      const reference = { url: candidate.url, width: candidate.width, height: candidate.height };
      const next = entries ? [...entries, reference] : [reference];
      aiStudioBlockReferences.delete(candidate.generationContextId);
      aiStudioBlockReferences.set(candidate.generationContextId, next.slice(-AI_STUDIO_REF_MAX_PER_BLOCK));
      while (aiStudioBlockReferences.size > AI_STUDIO_REF_BLOCKS_MAX) {
        aiStudioBlockReferences.delete(aiStudioBlockReferences.keys().next().value);
      }
    }
  }

  async function sendAiStudioReference(generationContextId, reference) {
    try {
      const response = await fetch(reference.url, { credentials: "same-origin", cache: "no-cache" });
      if (!response.ok) return false;
      const blob = await response.blob();
      if (!blob || blob.size < 100 || blob.size > MAX_LOCAL_IMAGE_BYTES) return false;
      await chrome.runtime.sendMessage({
        type: "mosa.ingest",
        payload: {
          provider: "google-ai-studio",
          mediaKind: "image",
          mimeType: blob.type || mimeTypeForUrl(reference.url),
          imageBase64: arrayBufferToBase64(await blob.arrayBuffer()),
          width: reference.width,
          height: reference.height,
          pageUrl: location.href,
          promptStatus: "not-available",
          captureMode: "automatic",
          capturedAt: new Date().toISOString(),
          localMediaIdentity: reference.url,
          generationContextId,
          isReference: true,
        },
      });
      return true;
    } catch {
      // An optional reference failure never blocks the generated output.
      return false;
    }
  }

  async function sendAiStudioBlockReferences(generationContextId) {
    const references = aiStudioBlockReferences.get(generationContextId) || [];
    await Promise.all(references.map((reference) => {
      const key = `ai-studio:ref:${generationContextId}:${reference.url}`;
      const pending = aiStudioReferenceUploads.get(key);
      if (pending) return pending;
      if (seen.has(key)) return undefined;
      rememberSeen(key);
      const upload = sendAiStudioReference(generationContextId, reference).finally(() => aiStudioReferenceUploads.delete(key));
      aiStudioReferenceUploads.set(key, upload);
      return upload;
    }));
  }

  function visiblePromptForProvider(provider, media) {
    if (provider === "gemini") return media instanceof HTMLImageElement ? geminiVisibleUserPromptForImage(media) : null;
    if (provider === "flow") return media instanceof HTMLVideoElement ? flowVisiblePromptForVideo(media) : flowVisiblePromptForImage(media);
    if (provider === "google-ai-studio") return media instanceof HTMLVideoElement ? aiStudioVisibleUserPromptForVideo(media) : aiStudioVisibleUserPromptForImage(media);
    return null;
  }

  function imageForSource(sourceUrl) {
    return Array.from(document.images || []).find((candidate) => imageSourceFor(candidate)?.url === sourceUrl) || null;
  }

  function promptRetryKey(provider, sourceUrl, mediaKind = "image") {
    return `${provider}:${mediaKind}:${sourceUrl}`;
  }

  function clearPromptRetry(key) {
    const state = promptRetryStates.get(key);
    if (!state) return;
    for (const timer of state.timers) clearTimeout(timer);
    promptRetryStates.delete(key);
  }

  function clearAllPromptRetries() {
    for (const key of [...promptRetryStates.keys()]) clearPromptRetry(key);
  }

  function scheduleNextPromptRetry(state) {
    if (!promptRetryStates.has(state.key)) return;
    if (state.timerPending) return;
    if (state.attempt >= PROMPT_RETRY_DELAYS.length) {
      clearPromptRetry(state.key);
      return;
    }
    const delay = PROMPT_RETRY_DELAYS[state.attempt];
    state.attempt += 1;
    state.timerPending = true;
    const timer = setTimeout(() => {
      state.timers.delete(timer);
      state.timerPending = false;
      attemptPromptUpgrade(state);
    }, delay);
    state.timers.add(timer);
  }

  function attemptPromptUpgrade(state) {
    if (!promptRetryStates.has(state.key) || state.inFlight) return;
    if (!autoCapture) {
      clearPromptRetry(state.key);
      return;
    }
    if (currentProvider() !== state.provider) {
      clearPromptRetry(state.key);
      return;
    }
    const media = state.lookupMediaKind === "video"
      ? videoForSource(state.lookupSourceUrl)
      : imageForSource(state.lookupSourceUrl);
    const visible = state.lookupMediaKind === "video"
      ? isVisibleGeneratedVideo(media)
      : isCaptureEligibleImage(state.provider, media);
    if (!media || !visible) {
      scheduleNextPromptRetry(state);
      return;
    }
    const providerPrompt = visiblePromptForProvider(state.provider, media);
    if (!providerPrompt) {
      scheduleNextPromptRetry(state);
      return;
    }

    state.inFlight = true;
    clearPromptRetry(state.key);
    if (state.source?.kind === "remote" && /^https:/i.test(state.source.url || "")) {
      chrome.runtime.sendMessage({
        type: "mosa.upgradeMetadata",
        payload: {
          provider: state.provider,
          mediaKind: state.mediaKind,
          mimeType: state.source.mimeType || mimeTypeForUrl(state.source.url, state.mediaKind),
          sourceMediaUrl: state.source.url,
          pageUrl: location.href,
          ...providerPrompt,
        },
      })
        .then((response) => {
          if (handOffNeedsRetry(response)) releaseSeenForRetry(state.sourceUrl);
        })
        .catch(() => releaseSeenForRetry(state.sourceUrl));
      return;
    }
    sendCapture(state.provider, state.source, media, {
      mediaKind: state.mediaKind,
      trustMediaMetrics: state.trustMediaMetrics,
    })
      .then(({ response }) => {
        if (handOffNeedsRetry(response)) releaseSeenForRetry(state.sourceUrl);
      })
      .catch(() => releaseSeenForRetry(state.sourceUrl));
  }

  function schedulePromptRetry(provider, source, mediaKind = "image", {
    lookupSource = source,
    lookupMediaKind = mediaKind,
    trustMediaMetrics = true,
  } = {}) {
    if (!PROMPT_RETRY_PROVIDERS.has(provider) || !source?.url) return;
    const key = promptRetryKey(provider, source.url, mediaKind);
    if (promptRetryStates.has(key)) return;
    const state = {
      key,
      provider,
      source,
      sourceUrl: source.url,
      lookupSourceUrl: lookupSource?.url || source.url,
      lookupMediaKind,
      mediaKind,
      trustMediaMetrics,
      attempt: 0,
      inFlight: false,
      timerPending: false,
      timers: new Set(),
    };
    promptRetryStates.set(key, state);
    scheduleNextPromptRetry(state);
  }

  function attemptPendingPromptUpgrades() {
    for (const state of [...promptRetryStates.values()]) attemptPromptUpgrade(state);
  }

  function isVisibleGeneratedImage(img) {
    if (!(img instanceof HTMLImageElement) || !img.complete) return false;
    const width = Number(img.naturalWidth || img.width || 0);
    const height = Number(img.naturalHeight || img.height || 0);
    if (width < MIN_EDGE || height < MIN_EDGE) return false;
    const rect = img.getBoundingClientRect?.();
    if (!rect || rect.width < 1 || rect.height < 1) return false;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return false;
    if (Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0))
      * Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0)) < MIN_VISIBLE_AREA) return false;
    const style = getComputedStyle(img);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    return Boolean(imageSourceFor(img));
  }

  function isVisibleGeneratedVideo(video) {
    if (!(video instanceof HTMLVideoElement) || Number(video.readyState || 0) < 1) return false;
    const width = Number(video.videoWidth || video.width || 0);
    const height = Number(video.videoHeight || video.height || 0);
    if (width < 256 || height < 256) return false;
    const rect = video.getBoundingClientRect?.();
    if (!rect || rect.width < 1 || rect.height < 1) return false;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return false;
    if (Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0))
      * Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0)) < MIN_VISIBLE_AREA) return false;
    const style = getComputedStyle(video);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    return Boolean(videoSourceFor(video));
  }

  function isProviderGeneratedOutput(provider, img) {
    if (!isVisibleGeneratedImage(img)) return false;
    if (provider === "gemini") {
      return Boolean(ancestorWithTag(img, "model-response"));
    }
    if (provider === "google-ai-studio") {
      const turn = ancestorWithTag(img, "ms-chat-turn");
      return Boolean(turn?.parentElement?.classList?.contains("chat-session-content")
        && directTurnContainer(turn, "model"));
    }
    if (provider === "flow") {
      return Boolean(flowNearbyPromptCard(img));
    }
    return false;
  }

  function isProviderGeneratedVideo(provider, video) {
    if (!isVisibleGeneratedVideo(video)) return false;
    if (provider === "google-ai-studio") {
      // AI Studio's dedicated Veo surface is not the chat DOM used by image
      // generation, so it has no ms-chat-turn/model container to prove output
      // ownership. Restrict the relaxed branch to that exact product surface
      // instead of treating every page-local video anywhere in AI Studio as a
      // generated result.
      if (AI_STUDIO_VIDEO_PATH.test(String(location.pathname || "").toLowerCase())) {
        return Boolean(flowNearbyPromptCard(video)
          || elementAttribute(video, "data-generated") === "true"
          || /generated|result|output/i.test([
            elementAttribute(video, "aria-label"),
            elementAttribute(video, "title"),
            String(video?.parentElement?.className || ""),
          ].join(" ")));
      }
      const turn = ancestorWithTag(video, "ms-chat-turn");
      return Boolean(turn?.parentElement?.classList?.contains("chat-session-content")
        && directTurnContainer(turn, "model"));
    }
    if (provider === "flow") {
      return Boolean(flowNearbyPromptCard(video));
    }
    return false;
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

  async function bytesFromVisibleImage(source, img) {
    // This check is intentionally repeated immediately before reading bytes:
    // same-origin/Blob URLs are only eligible while their image is rendered,
    // loaded, and dimension-qualified in the current viewport.
    if (source?.kind !== "local" || !isVisibleGeneratedImage(img)) {
      throw new Error("请选择支持站点中的可见生成图片。");
    }
    const response = await fetch(source.url, {
      credentials: "same-origin",
      cache: "no-cache",
    });
    if (!response.ok) throw new Error(`Image download failed (${response.status})`);
    const blob = await response.blob();
    if (!blob || blob.size < 100) throw new Error("Downloaded image empty/too small");
    if (blob.size > MAX_LOCAL_IMAGE_BYTES) throw new Error("Image exceeds GravityPort capture size limit.");
    return {
      mimeType: blob.type || mimeTypeForUrl(source.url),
      imageBase64: arrayBufferToBase64(await blob.arrayBuffer()),
    };
  }

  async function bytesFromVisibleVideo(source, video) {
    if (source?.kind !== "local" || !isVisibleGeneratedVideo(video)) {
      throw new Error("请选择支持站点中的可见生成视频。");
    }
    const response = await fetch(source.url, {
      credentials: "same-origin",
      cache: "no-cache",
    });
    if (!response.ok) throw new Error(`Video download failed (${response.status})`);
    const blob = await response.blob();
    if (!blob || blob.size < 1024) throw new Error("Downloaded video empty/too small");
    if (blob.size > MAX_LOCAL_VIDEO_BYTES) {
      throw new Error("Large page-local video cannot be copied safely; use the provider URL result instead.");
    }
    return {
      mimeType: blob.type || mimeTypeForUrl(source.url, "video"),
      blob,
    };
  }

  async function sendChunkedVideo(payload, blob) {
    const transferId = `video-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const totalChunks = Math.ceil(blob.size / VIDEO_TRANSFER_CHUNK_BYTES);
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
        const start = index * VIDEO_TRANSFER_CHUNK_BYTES;
        const end = Math.min(blob.size, start + VIDEO_TRANSFER_CHUNK_BYTES);
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

  async function sendCapture(provider, source, media, { captureMode = "automatic", mediaKind = "image", trustMediaMetrics = true, generationContextId = "" } = {}) {
    return withCaptureSlot(async () => {
      if (!extensionAlive()) return { response: { ok: false, error: "GravityPort extension is unavailable." }, hasPrompt: false, providerPrompt: null };
      const capturePageUrl = location.href;
      const video = mediaKind === "video";
      const providerPrompt = visiblePromptForProvider(provider, media);
      const payload = {
        provider,
        mediaKind,
        mimeType: source.mimeType || mimeTypeForUrl(source.url, mediaKind),
        pageUrl: capturePageUrl,
        promptStatus: "not-available",
        promptSource: video ? "provider-visible-video" : "provider-visible-image",
        captureMode,
        capturedAt: new Date().toISOString(),
        localMediaIdentity: source.kind === "local" ? source.url : "",
        width: trustMediaMetrics ? (video ? Number(media?.videoWidth || media?.naturalWidth || media?.width || 0) : Number(media?.naturalWidth || media?.width || 0)) : 0,
        height: trustMediaMetrics ? (video ? Number(media?.videoHeight || media?.naturalHeight || media?.height || 0) : Number(media?.naturalHeight || media?.height || 0)) : 0,
        durationSeconds: trustMediaMetrics && video && Number.isFinite(Number(media?.duration)) ? Number(media.duration) : null,
      };
      if (generationContextId) payload.generationContextId = generationContextId;
      if (providerPrompt) Object.assign(payload, providerPrompt);
      if (source.kind === "local" && source.url.startsWith("blob:")) {
        const bytes = video ? await bytesFromVisibleVideo(source, media) : await bytesFromVisibleImage(source, media);
        if (location.href !== capturePageUrl) {
          return { response: { ok: false, error: "Provider page changed before capture completed." }, hasPrompt: Boolean(providerPrompt?.prompt), providerPrompt };
        }
        payload.mimeType = bytes.mimeType;
        if (video) {
          const response = await sendChunkedVideo(payload, bytes.blob);
          return { response, hasPrompt: Boolean(providerPrompt?.prompt), providerPrompt };
        }
        payload.imageBase64 = bytes.imageBase64;
      } else {
        // HTTPS provider URLs are downloaded in the background service worker,
        // avoiding a second large Base64 copy through content-script messaging.
        if (video) payload.mediaUrl = source.url;
        else payload.imageUrl = source.url;
      }
      if (location.href !== capturePageUrl) {
        return { response: { ok: false, error: "Provider page changed before capture completed." }, hasPrompt: Boolean(providerPrompt?.prompt), providerPrompt };
      }
      const response = await chrome.runtime.sendMessage({
        type: "mosa.ingest",
        payload,
      });
      return { response, hasPrompt: Boolean(providerPrompt?.prompt), providerPrompt };
    });
  }

  function mimeTypeForUrl(mediaUrl, mediaKind = "image") {
    const extension = mediaUrl.match(/\.([a-z0-9]+)(?:$|[?#])/i)?.[1]?.toLowerCase();
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

  function rememberFlowProbeFailure(key) {
    const previous = flowProbeFailures.get(key) || { count: 0, nextAllowedAt: 0 };
    const count = previous.count + 1;
    const delay = FLOW_PROBE_BACKOFF_DELAYS[Math.min(count - 1, FLOW_PROBE_BACKOFF_DELAYS.length - 1)];
    flowProbeFailures.delete(key);
    flowProbeFailures.set(key, { count, nextAllowedAt: Date.now() + delay });
    while (flowProbeFailures.size > FLOW_PROBE_FAILURES_MAX) flowProbeFailures.delete(flowProbeFailures.keys().next().value);
  }

  async function captureFlowMediaThumbnail(img) {
    const mediaId = flowMediaIdFromImage(img);
    if (!mediaId || !isVisibleFlowMediaThumbnail(img)) return false;
    const key = `flow-media:${mediaId}`;
    if (seen.has(key) || flowMediaProbeInFlight.has(key)) return true;
    const failure = flowProbeFailures.get(key);
    if (failure && Date.now() < failure.nextAllowedAt) return true;
    flowMediaProbeInFlight.add(key);
    try {
      const source = imageSourceFor(img);
      if (!source) return false;
      const probeResponse = await chrome.runtime.sendMessage({
        type: "mosa.probeFlowMedia",
        url: source.url,
      });
      if (!probeResponse?.ok || !probeResponse.result) {
        rememberFlowProbeFailure(key);
        return false;
      }
      const probe = probeResponse.result;
      if (probe.mediaKind === "video" && probe.mediaUrl) {
        rememberSeen(key);
        flowProbeFailures.delete(key);
        const videoSource = {
          kind: "remote",
          url: probe.mediaUrl,
          mimeType: probe.mimeType || "video/mp4",
        };
        const result = await sendCapture("flow", videoSource, img, { mediaKind: "video", trustMediaMetrics: false });
        if (!result?.response?.ok) {
          if (handOffNeedsRetry(result?.response)) releaseSeenForRetry(key);
        }
        else if (!result.hasPrompt) schedulePromptRetry("flow", videoSource, "video", {
          lookupSource: source,
          lookupMediaKind: "image",
          trustMediaMetrics: false,
        });
        return true;
      }
      if (probe.mediaKind === "image") {
        rememberSeen(key);
        flowProbeFailures.delete(key);
        const result = await sendCapture("flow", source, img);
        if (!result?.response?.ok) {
          if (handOffNeedsRetry(result?.response)) releaseSeenForRetry(key);
        }
        else if (!result.hasPrompt) schedulePromptRetry("flow", source);
        return true;
      }
      rememberFlowProbeFailure(key);
      return false;
    } catch {
      seen.delete(key);
      rememberFlowProbeFailure(key);
      return false;
    } finally {
      flowMediaProbeInFlight.delete(key);
    }
  }

  function rememberAiStudioSentOutput(generationContextId, source, media, mediaKind, providerPrompt, referenceCountAtSend) {
    const video = mediaKind === "video";
    const entry = {
      url: source.url,
      mediaKind,
      mimeType: source.mimeType || "",
      width: video ? Number(media?.videoWidth || media?.naturalWidth || media?.width || 0) : Number(media?.naturalWidth || media?.width || 0),
      height: video ? Number(media?.videoHeight || media?.naturalHeight || media?.height || 0) : Number(media?.naturalHeight || media?.height || 0),
      durationSeconds: video && Number.isFinite(Number(media?.duration)) ? Number(media.duration) : null,
      prompt: providerPrompt?.prompt || "",
      promptStatus: providerPrompt?.promptStatus || "",
      promptSource: providerPrompt?.promptSource || "",
      // The references sent before this output are the baseline a later
      // replay is measured against.
      referenceCountAtSend,
    };
    const entries = (aiStudioSentOutputs.get(generationContextId) || [])
      .filter((candidate) => candidate.url !== entry.url);
    entries.push(entry);
    aiStudioSentOutputs.delete(generationContextId);
    aiStudioSentOutputs.set(generationContextId, entries);
    while (aiStudioSentOutputs.size > AI_STUDIO_REF_BLOCKS_MAX) {
      aiStudioSentOutputs.delete(aiStudioSentOutputs.keys().next().value);
    }
  }

  // A recorded output's media may already be unmounted when a late reference
  // appears, so this read skips the visibility gate. Only blob: URLs this page
  // itself captured successfully earlier are ever passed in.
  async function aiStudioBytesFromRecordedUrl(url, mediaKind) {
    const response = await fetch(url, { credentials: "same-origin", cache: "no-cache" });
    if (!response.ok) throw new Error(`Recorded media download failed (${response.status})`);
    const blob = await response.blob();
    const minimumBytes = mediaKind === "video" ? 1024 : 100;
    const maximumBytes = mediaKind === "video" ? MAX_LOCAL_VIDEO_BYTES : MAX_LOCAL_IMAGE_BYTES;
    if (!blob || blob.size < minimumBytes) throw new Error("Recorded media empty/too small");
    if (blob.size > maximumBytes) throw new Error("Recorded media exceeds GravityPort capture size limit.");
    return blob;
  }

  async function replayAiStudioOutput(generationContextId, entry) {
    try {
      const blob = await aiStudioBytesFromRecordedUrl(entry.url, entry.mediaKind);
      const payload = {
        provider: "google-ai-studio",
        mediaKind: entry.mediaKind,
        mimeType: blob.type || entry.mimeType || mimeTypeForUrl(entry.url, entry.mediaKind),
        pageUrl: location.href,
        promptStatus: entry.promptStatus || "not-available",
        captureMode: "automatic",
        capturedAt: new Date().toISOString(),
        localMediaIdentity: entry.url,
        generationContextId,
        width: entry.width || 0,
        height: entry.height || 0,
        durationSeconds: entry.durationSeconds ?? null,
      };
      if (entry.prompt) {
        payload.prompt = entry.prompt;
        payload.promptSource = entry.promptSource;
      }
      if (entry.mediaKind === "video") {
        await sendChunkedVideo(payload, blob);
      } else {
        payload.imageBase64 = arrayBufferToBase64(await blob.arrayBuffer());
        await chrome.runtime.sendMessage({ type: "mosa.ingest", payload });
      }
    } catch {
      // The original capture already succeeded; a replay is best-effort.
    }
  }

  // When a block holds more references than an already-sent output saw at its
  // send time, send the new references and then re-send that output under the
  // same block id so the app can attach the late references. A
  // (block, output, reference count) combination replays at most once; the
  // check itself runs on every scan and would otherwise replay on every scan.
  async function replayAiStudioBlockOutputs(generationContextId) {
    const entries = aiStudioSentOutputs.get(generationContextId);
    if (!entries?.length) return;
    const referenceCount = (aiStudioBlockReferences.get(generationContextId) || []).length;
    if (!entries.some((entry) => referenceCount > (entry.referenceCountAtSend || 0))) return;
    await sendAiStudioBlockReferences(generationContextId);
    for (const entry of entries) {
      if (referenceCount <= (entry.referenceCountAtSend || 0)) continue;
      const key = `ai-studio:replay:${generationContextId}:${entry.url}:${referenceCount}`;
      if (aiStudioOutputReplays.has(key)) continue;
      aiStudioOutputReplays.add(key);
      await replayAiStudioOutput(generationContextId, entry);
    }
  }

  async function captureAiStudioOutput(provider, source, media, mediaKind) {
    try {
      const generationContextId = aiStudioGenerationContextIdForMedia(media);
      // References must land before the generated media so the app can attach
      // them at the moment the asset is created. Reference uploads run outside
      // the capture slot on purpose: the slot is reserved for the media itself.
      // Count the references actually sent ahead of this output. One that
      // renders while the output is in flight must still trigger a replay.
      const referenceCountAtSend = (aiStudioBlockReferences.get(generationContextId) || []).length;
      if (generationContextId) await sendAiStudioBlockReferences(generationContextId);
      const { response, hasPrompt, providerPrompt } = await sendCapture(provider, source, media, {
        mediaKind,
        generationContextId,
      });
      if (!response?.ok) {
        if (handOffNeedsRetry(response)) releaseSeenForRetry(source.url);
        return;
      }
      if (generationContextId) {
        rememberAiStudioSentOutput(generationContextId, source, media, mediaKind, providerPrompt, referenceCountAtSend);
      }
      if (!hasPrompt) schedulePromptRetry(provider, source, mediaKind);
    } catch {
      releaseSeenForRetry(source.url);
    }
  }

  function scan() {
    const provider = currentProvider();
    if (!provider || !autoCapture) return;
    if (location.href !== lastProviderUrl) {
      lastProviderUrl = location.href;
      seen.clear();
      flowMediaProbeInFlight.clear();
      flowProbeFailures.clear();
      clearAllPromptRetries();
    }
    // Record AI Studio user-turn reference images before outputs are scanned.
    // A block that already has successfully sent outputs and now holds more
    // references than at their send time gets its outputs replayed once per
    // reference count, so late-rendered references still get attached.
    if (provider === "google-ai-studio") {
      recordAiStudioReferences();
      for (const generationContextId of aiStudioBlockReferences.keys()) {
        if (aiStudioSentOutputs.has(generationContextId)) {
          void replayAiStudioBlockOutputs(generationContextId);
        }
      }
    }
    for (const img of document.images || []) {
      if (provider === "flow" && flowMediaIdFromImage(img)) {
        void captureFlowMediaThumbnail(img);
        continue;
      }
      if (!isProviderGeneratedOutput(provider, img)) continue;
      const source = imageSourceFor(img);
      if (!source || seen.has(source.url)) continue;
      rememberSeen(source.url);
      if (provider === "google-ai-studio") {
        void captureAiStudioOutput(provider, source, img, "image");
        continue;
      }
      sendCapture(provider, source, img)
        .then(({ response, hasPrompt }) => {
          // Queued or refused captures keep the key; only a retryable answer frees it.
          if (handOffNeedsRetry(response)) releaseSeenForRetry(source.url);
          else if (response.ok && !hasPrompt) schedulePromptRetry(provider, source);
        })
        .catch(() => releaseSeenForRetry(source.url));
    }
    if (provider === "flow" || provider === "google-ai-studio") {
      for (const video of document.querySelectorAll?.("video") || []) {
        if (!isProviderGeneratedVideo(provider, video)) continue;
        const source = videoSourceFor(video);
        if (!source || seen.has(source.url)) continue;
        rememberSeen(source.url);
        if (provider === "google-ai-studio") {
          void captureAiStudioOutput(provider, source, video, "video");
          continue;
        }
        sendCapture(provider, source, video, { mediaKind: "video" })
          .then(({ response, hasPrompt }) => {
            if (handOffNeedsRetry(response)) releaseSeenForRetry(source.url);
            else if (response.ok && !hasPrompt) schedulePromptRetry(provider, source, "video");
          })
          .catch(() => releaseSeenForRetry(source.url));
      }
    }
    attemptPendingPromptUpgrades();
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 300);
  }

  function startProviderObserver() {
    if (!observer || !document.documentElement) return;
    observer.disconnect();
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      // Text-only prompt changes are covered by the bounded prompt-retry
      // timers. Observing every character/style/title mutation on an Angular
      // document caused scans for unrelated UI animation and typing.
      characterData: false,
      attributeFilter: ["src", "srcset", "class", "aria-hidden", "hidden"],
    });
  }

  async function loadProviderSettings() {
    try {
      const response = await chrome.runtime?.sendMessage?.({ type: "mosa.getSettings" });
      if (response?.ok && response.settings) {
        autoCapture = response.settings.autoCapture !== false;
        return;
      }
    } catch {
      // MV3 may be waking the service worker. Fall back to the same persistent
      // local preference instead of silently disabling capture for this page.
    }
    try {
      const stored = await chrome.storage?.local?.get?.({ autoCapture });
      if (stored) autoCapture = stored.autoCapture !== false;
    } catch {
      // Keep the in-memory default when both settings paths are unavailable.
    }
  }

  function updateProviderWatchdog() {
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

  loadProviderSettings().then(() => {
    if (autoCapture) {
      startProviderObserver();
      scheduleScan();
    }
    updateProviderWatchdog();
  }).catch(() => {});

  chrome.storage?.onChanged?.addListener?.((changes, area) => {
    if (area !== "local") return;
    if (changes.autoCapture) {
      autoCapture = changes.autoCapture.newValue !== false;
      if (autoCapture) startProviderObserver();
      else {
        observer?.disconnect();
        if (scanTimer) clearTimeout(scanTimer);
        scanTimer = null;
        clearAllPromptRetries();
      }
      updateProviderWatchdog();
    }
    if (!changes.autoCapture && !changes.mosaBaseUrl && !changes.mosaToken) return;
    // A corrected address or Token should immediately retry images that were
    // rejected under the previous settings without requiring new generation.
    if (changes.mosaBaseUrl || changes.mosaToken) seen.clear();
    if (autoCapture) scheduleScan();
  });

  chrome.runtime?.onMessage?.addListener?.((message, _sender, sendResponse) => {
    if (!message || ![
      "mosa.capture.saveImage",
      "mosa.capture.saveImageWithPrompt",
      "mosa.capture.saveVideoWithPrompt",
    ].includes(message.type)) return false;
    const provider = currentProvider();
    const videoRequest = message.type === "mosa.capture.saveVideoWithPrompt";
    const source = videoRequest ? videoSource(message.videoUrl) : imageSource(message.imageUrl);
    const media = source ? (videoRequest ? videoForSource(source.url) : imageForSource(source.url)) : null;
    const valid = videoRequest
      ? isProviderGeneratedVideo(provider, media)
      : Boolean(media && (source?.kind !== "local" || isCaptureEligibleImage(provider, media)));
    if (!provider || !source || !media || !valid) {
      // A rejected manual save must not be silent; the toast is the only
      // on-page signal that the adapter ran but could not accept the media.
      const rejection = videoRequest ? "请选择支持站点中的生成视频。" : "请选择支持站点中的生成图片。";
      showToast(`${rejection}（provider=${provider || "none"}）`, true);
      sendResponse({ ok: false, error: rejection });
      return false;
    }
    sendCapture(provider, source, media, { captureMode: "manual", mediaKind: videoRequest ? "video" : "image" })
      .then(({ response }) => {
        const finalResponse = response || { ok: true };
        showToast(finalResponse.ok ? "已保存到 GravityPort" : (finalResponse.error || "保存失败"), !finalResponse.ok);
        sendResponse(finalResponse);
      })
      .catch((error) => {
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
  // HTMLMediaElement does not use the image-style load event when metadata
  // becomes available. Without these events a video inserted at readyState=0
  // can miss the one MutationObserver scan and never be reconsidered.
  document.addEventListener("loadedmetadata", () => { if (autoCapture) scheduleScan(); }, true);
  document.addEventListener("loadeddata", () => { if (autoCapture) scheduleScan(); }, true);
  document.addEventListener("canplay", () => { if (autoCapture) scheduleScan(); }, true);
  document.addEventListener("scroll", () => { if (autoCapture) scheduleScan(); }, { passive: true, capture: true });
})();
