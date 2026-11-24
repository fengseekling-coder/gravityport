/**
 * Lovart (www.lovart.ai) adapter. Media and metadata come from strings the
 * page itself receives, observed read-only by lovart-page-hook.js: the two
 * chat-history JSON responses (new lgw.lovart.ai /v1/canda/chat-history and
 * legacy /api/canva/agent/chatHistoryV2) and the chat WebSocket's text
 * frames. The DOM is only used for the manual right-click save. Records are
 * recognized structurally (never pinned to one endpoint), one record per
 * generated image. A persistent timestamp baseline marks when auto-capture
 * was first seen enabled on a Lovart page: images created before it are only
 * remembered (prompt, model, references) for the manual save; images created
 * after it are auto-captured. Everything user-visible on the socket side is
 * a text frame the page already had — the socket address (which carries a
 * login token) never reaches this script.
 */
(() => {
  const providerPolicy = globalThis.MosaProviderPolicy;
  if (!providerPolicy) return;

  const MEDIA_HOSTS = new Set(["a.lovart.ai", "assets-persist.lovart.ai"]);
  const MEDIA_URL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
  const MAX_WALK_NODES = 60_000;
  const MAX_RESPONSE_TEXT = 4 * 1024 * 1024;
  const MAX_PROMPT_LENGTH = 8000;
  const MAX_REFERENCE_IMAGES = 8;
  const SEEN_MAX = 2048;
  const PENDING_MAX = 64;
  const CAPTURE_CONCURRENCY = 2;
  const FRESH_SLACK_MS = 120_000;
  // Set once, the first time auto-capture is observed enabled on a Lovart
  // page: images created before this moment stay manual-save only.
  const AUTO_BASELINE_KEY = "lovartAutoCaptureBaselineAtV1";
  // Rolling list of asset ids already handed to GravityPort, so a refresh
  // (empty in-memory seen set) never re-sends the same image from history.
  const SEEN_STORE_KEY = "lovartCapturedAssetIdsV1";

  function isLovartMediaHost(hostname) {
    return MEDIA_HOSTS.has(String(hostname || "").toLowerCase());
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
    if (!isLovartMediaHost(url.hostname)) return null;
    const fileName = /\/([^/]+)$/.exec(url.pathname)?.[1] || "";
    const dot = fileName.lastIndexOf(".");
    if (dot <= 0) return null;
    if (!/^(?:png|jpe?g|webp|gif)$/i.test(fileName.slice(dot + 1))) return null;
    const id = fileName.slice(0, dot);
    if (!MEDIA_URL_ID_PATTERN.test(id)) return null;
    return { kind: "image", url: url.href, id };
  }

  function referenceIdForUrl(value) {
    const info = mediaUrlInfo(value);
    return info ? `ref:${info.id}` : "";
  }

  function mimeTypeForUrl(mediaUrl) {
    const extension = String(mediaUrl || "").match(/\.([a-z0-9]+)(?:$|[?#])/i)?.[1]?.toLowerCase();
    if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
    if (extension === "webp") return "image/webp";
    if (extension === "gif") return "image/gif";
    return "image/png";
  }

  // User's own words as typed into Lovart: drop attached-file and tool
  // mentions, turn area marks into 「label」, keep everything else verbatim.
  function cleanUserMessage(value) {
    let text = String(value || "");
    text = text.replace(/\[@image:[^\]]*\]/g, " ");
    text = text.replace(/\[@tool:[^\]]*\]/g, " ");
    text = text.replace(/\[@mark:#\d+:([^\]]*)\]/g, (_match, label) => `「${String(label).trim()}」`);
    return text.trim().slice(0, MAX_PROMPT_LENGTH);
  }

  function trimmed(value, max = 120) {
    if (typeof value !== "string") return "";
    const text = value.trim();
    return text ? text.slice(0, max) : "";
  }

  function parseJsonText(text) {
    if (typeof text !== "string" || !text || text.length > MAX_RESPONSE_TEXT) return null;
    const trimmedText = text.trim();
    if (!trimmedText.startsWith("{") && !trimmedText.startsWith("[")) return null;
    try {
      return JSON.parse(trimmedText);
    } catch {
      return null;
    }
  }

  function timestampMsOf(value) {
    if (typeof value !== "string" || !value) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }

  // thread_meta.session_id is "<thread id>_main"; both shapes key the
  // conversation by the bare thread id.
  function sessionFromThreadId(value) {
    const id = String(value || "").trim();
    return id.endsWith("_main") ? id.slice(0, -"_main".length) : id;
  }

  // Strings, or objects carrying a url-ish field; Lovart mixes both across
  // the observed shapes.
  function collectUrlList(value, urlKey = "url") {
    const urls = [];
    const add = (entry) => {
      if (typeof entry === "string") urls.push(entry);
      else if (entry && typeof entry === "object" && typeof entry[urlKey] === "string") urls.push(entry[urlKey]);
    };
    if (typeof value === "string") add(value);
    else if (Array.isArray(value)) for (const entry of value) add(entry);
    return urls;
  }

  function collectImageListUrls(value) {
    const urls = [];
    if (!Array.isArray(value)) return urls;
    for (const entry of value) {
      if (entry && typeof entry === "object" && typeof entry.imageUrl === "string") urls.push(entry.imageUrl);
      else if (typeof entry === "string") urls.push(entry);
    }
    return urls;
  }

  // One media host per path id: three spellings of the same reference
  // (prompt_image_list, reference_image_urls string, mark url) collapse to one.
  function dedupeReferenceUrls(urls, selfUrl) {
    const seenIds = new Set();
    const out = [];
    for (const url of urls) {
      const info = mediaUrlInfo(url);
      if (!info || info.url === selfUrl || seenIds.has(info.id)) continue;
      seenIds.add(info.id);
      out.push(info.url);
    }
    return out.slice(0, MAX_REFERENCE_IMAGES);
  }

  // The image-mode input's own JSON (typed prompt, chosen generator, base
  // images). `original_unit_data.image[]` / `source_image[]` element formats
  // were never observed non-empty: both strings and {url} objects are
  // accepted, anything else is ignored.
  function collectUserGeneratorParams(text) {
    const parsed = parseJsonText(text);
    const params = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed.generator_params
      : null;
    if (!params || typeof params !== "object") return null;
    const inputArgs = params.input_args && typeof params.input_args === "object" ? params.input_args : {};
    const unitData = inputArgs.original_unit_data && typeof inputArgs.original_unit_data === "object"
      ? inputArgs.original_unit_data
      : {};
    return {
      generatorName: trimmed(params.generator_name),
      prompt: typeof inputArgs.prompt === "string" ? inputArgs.prompt.trim().slice(0, MAX_PROMPT_LENGTH) : "",
      referenceUrls: [
        ...collectUrlList(unitData.image),
        ...collectUrlList(unitData.source_image),
        ...collectUrlList(inputArgs.source_image),
        ...collectUrlList(inputArgs.reference_image_urls),
      ],
    };
  }

  // Anything shaped like a user message: type "user" with text, an action
  // key, optional area marks and attached images. Covers the new UI's
  // history entries and the legacy UI's input objects (camelCase fields).
  function collectUserInput(node) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return null;
    if (node.type !== "user" || typeof node.text !== "string") return null;
    const generatorParams = collectUserGeneratorParams(node.text);
    return {
      actionKey: trimmed(node.action_id ?? node.actionId, 128),
      text: generatorParams ? "" : node.text,
      generatorParams,
      markUrls: collectUrlList(node.mark_list ?? node.markList),
      imageUrls: collectImageListUrls(node.imageList ?? node.image_list),
      timestampMs: timestampMsOf(node.timestamp),
    };
  }

  function agentArtifactsFromContent(owner) {
    if (!owner || typeof owner !== "object" || !Array.isArray(owner.content)) return null;
    const artifacts = [];
    for (const entry of owner.content) {
      if (!entry || typeof entry !== "object" || entry.event_type !== "tool_artifacts") continue;
      const eventData = entry.event_data && typeof entry.event_data === "object" ? entry.event_data : {};
      if (Array.isArray(eventData.artifact)) {
        for (const artifact of eventData.artifact) {
          if (artifact && typeof artifact === "object") artifacts.push(artifact);
        }
      }
    }
    return artifacts.length ? artifacts : null;
  }

  // Image-mode outputs hide inside an assistant message whose text is itself
  // a JSON string: {"generator_task_id":…,"artifacts":[…]}.
  function generatorArtifactsFromText(node) {
    if (!node || typeof node !== "object" || node.type !== "assistant") return null;
    const parsed = parseJsonText(node.text);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.artifacts)) return null;
    const artifacts = [];
    for (const entry of parsed.artifacts) {
      if (entry && typeof entry === "object") artifacts.push(entry);
    }
    return artifacts.length ? artifacts : null;
  }

  function realtimeGeneratorArtifacts(block) {
    if (!block || typeof block !== "object" || !Array.isArray(block.content)) return null;
    const artifacts = [];
    for (const entry of block.content) {
      if (!entry || typeof entry !== "object" || entry.event_type !== "generator_artifacts") continue;
      const eventData = entry.event_data && typeof entry.event_data === "object" ? entry.event_data : {};
      if (Array.isArray(eventData.artifacts)) {
        for (const artifact of eventData.artifacts) {
          if (artifact && typeof artifact === "object") artifacts.push(artifact);
        }
      }
    }
    return artifacts.length ? artifacts : null;
  }

  function generatorStartPrompt(block) {
    if (!block || typeof block !== "object" || !Array.isArray(block.content)) return "";
    for (const entry of block.content) {
      if (!entry || typeof entry !== "object" || entry.event_type !== "generator_start") continue;
      const eventData = entry.event_data && typeof entry.event_data === "object" ? entry.event_data : {};
      const inputArgs = eventData.input_args && typeof eventData.input_args === "object" ? eventData.input_args : {};
      if (typeof inputArgs.prompt === "string") return inputArgs.prompt.trim().slice(0, MAX_PROMPT_LENGTH);
    }
    return "";
  }

  // The legacy UI names models `generate_image_…`; a bare tool name
  // (edit_media_v2) is never a model.
  function legacyModelFor(name, source) {
    const cleanName = trimmed(name);
    const cleanSource = trimmed(source);
    if (/^generate_image_/.test(cleanName)) return cleanName;
    if (/^generate_image_/.test(cleanSource)) return cleanSource;
    return "";
  }

  function auditRejected(metadata) {
    const audit = metadata && typeof metadata === "object" ? metadata.audit_status : undefined;
    // The legacy shape carries no audit_status at all; only an explicit
    // non-success verdict skips a record.
    return typeof audit === "string" && audit && audit !== "success";
  }

  function capturedAtMsFor(context) {
    if (context?.isRealtime) return Number(context?.nowMs) || null;
    return context?.timestampMs ?? null;
  }

  function buildAgentRecord(artifact, context) {
    if (!artifact || typeof artifact !== "object") return null;
    if (context?.name === "analyse_image" || trimmed(artifact.source) === "analyse_image") return null;
    const media = mediaUrlInfo(artifact.image_url);
    if (!media) return null;
    const id = trimmed(artifact.artifact_id, 128) || media.id;
    if (!id) return null;
    if (auditRejected(artifact.metadata)) return null;
    const inputArgs = artifact.input_args && typeof artifact.input_args === "object" ? artifact.input_args : {};
    const prompt = trimmed(artifact.prompt_text, MAX_PROMPT_LENGTH)
      || trimmed(inputArgs.prompt, MAX_PROMPT_LENGTH)
      || trimmed(context?.pendingTool?.prompt, MAX_PROMPT_LENGTH);
    const model = trimmed(inputArgs.routed_model)
      || trimmed(context?.toolHint)
      || trimmed(context?.pendingTool?.model)
      || legacyModelFor(context?.name, artifact.source);
    // Images the user attached to the message are the base image only when
    // the artifact itself says it edited one. A TEXT_TO_IMAGE artifact made
    // from a chat that also carries an upload ("generate in this style") has
    // no parent; the artifact's own prompt_image_list / reference_image_urls
    // always count.
    const userImagesAreBase = trimmed(artifact.task_type).toUpperCase() !== "TEXT_TO_IMAGE";
    const referenceUrls = dedupeReferenceUrls([
      ...collectUrlList(artifact.prompt_image_list),
      ...collectUrlList(inputArgs.reference_image_urls),
      ...(userImagesAreBase ? context?.userInput?.markUrls || [] : []),
      ...(userImagesAreBase ? context?.userInput?.imageUrls || [] : []),
      ...(context?.pendingTool?.referenceUrls || []),
    ], media.url);
    return {
      providerAssetId: id,
      mediaUrl: media.url,
      prompt,
      promptKind: "agent",
      userMessage: cleanUserMessage(context?.userInput?.text || ""),
      model,
      conversationId: trimmed(artifact.thread_id, 128)
        || trimmed(context?.threadId, 128)
        || sessionFromThreadId(context?.sessionId),
      messageId: trimmed(context?.actionKey, 128),
      width: Number(artifact.width) || 0,
      height: Number(artifact.height) || 0,
      capturedAtMs: capturedAtMsFor(context),
      referenceUrls,
    };
  }

  function buildGeneratorRecord(entry, context) {
    if (!entry || typeof entry !== "object") return null;
    const media = mediaUrlInfo(entry.content);
    if (!media) return null;
    if (auditRejected(entry.metadata)) return null;
    const id = trimmed(entry.metadata?.artifact_id, 128) || media.id;
    const params = context?.userInput?.generatorParams || null;
    const prompt = trimmed(params?.prompt, MAX_PROMPT_LENGTH)
      || trimmed(context?.pendingGeneratorPrompt, MAX_PROMPT_LENGTH)
      || trimmed(context?.userInput?.text, MAX_PROMPT_LENGTH);
    const model = trimmed(params?.generatorName) || trimmed(context?.model);
    const referenceUrls = dedupeReferenceUrls([
      ...(params?.referenceUrls || []),
      ...(context?.userInput?.markUrls || []),
    ], media.url);
    return {
      providerAssetId: id,
      mediaUrl: media.url,
      prompt,
      promptKind: "generator",
      userMessage: cleanUserMessage(prompt || context?.userInput?.text || ""),
      model,
      conversationId: trimmed(context?.threadId, 128) || sessionFromThreadId(context?.sessionId),
      messageId: trimmed(context?.actionKey, 128),
      width: Number(entry.metadata?.width) || 0,
      height: Number(entry.metadata?.height) || 0,
      capturedAtMs: capturedAtMsFor(context),
      referenceUrls,
    };
  }

  function agentContextFromOwner(owner, userInput, realtimeNowMs = null) {
    return {
      name: trimmed(owner?.name),
      toolHint: trimmed(owner?.tool_hint),
      actionKey: trimmed(owner?.action_id ?? owner?.actionId, 128),
      threadId: trimmed(owner?.thread_id, 128),
      sessionId: trimmed(owner?.thread_meta?.session_id, 128),
      timestampMs: realtimeNowMs !== null ? null : timestampMsOf(owner?.timestamp),
      userInput: userInput || null,
      pendingTool: null,
      isRealtime: realtimeNowMs !== null,
      nowMs: realtimeNowMs,
    };
  }

  function generatorContextFromOwner(owner, userInput, realtimeNowMs = null) {
    return {
      model: "",
      actionKey: trimmed(owner?.action_id ?? owner?.actionId, 128),
      threadId: trimmed(owner?.thread_id, 128),
      sessionId: trimmed(owner?.thread_meta?.session_id, 128),
      timestampMs: realtimeNowMs !== null ? null : timestampMsOf(owner?.timestamp),
      userInput: userInput || null,
      pendingGeneratorPrompt: "",
      isRealtime: realtimeNowMs !== null,
      nowMs: realtimeNowMs,
    };
  }

  function emitContainers(containers, userInputForOwner, realtimeNowMs, records) {
    for (const container of containers) {
      const userInput = userInputForOwner(container.owner) || null;
      for (const artifact of container.artifacts) {
        const record = container.kind === "agent"
          ? buildAgentRecord(artifact, agentContextFromOwner(container.owner, userInput, realtimeNowMs))
          : buildGeneratorRecord(artifact, generatorContextFromOwner(container.owner, userInput, realtimeNowMs));
        if (record) records.push(record);
      }
    }
  }

  // History responses: shape is found structurally. The legacy UI's raw
  // messages can appear anywhere in the (unobserved outer wrapper of the)
  // chatHistoryV2 answer, so the whole tree is walked for the known message
  // shapes instead of guessing outer field names.
  function recordsFromGenericTree(root, realtimeNowMs = null) {
    const records = [];
    if (!root || typeof root !== "object") return { records };
    const userInputs = new Map();
    const containers = [];
    let visited = 0;
    const walk = (node) => {
      if (!node || typeof node !== "object" || visited >= MAX_WALK_NODES) return;
      visited += 1;
      if (Array.isArray(node)) {
        for (const entry of node) walk(entry);
        return;
      }
      const userInput = collectUserInput(node);
      if (userInput?.actionKey && !userInputs.has(userInput.actionKey)) {
        userInputs.set(userInput.actionKey, userInput);
      }
      const agentArtifacts = agentArtifactsFromContent(node);
      if (agentArtifacts) containers.push({ kind: "agent", owner: node, artifacts: agentArtifacts });
      const generatorArtifacts = generatorArtifactsFromText(node);
      if (generatorArtifacts) containers.push({ kind: "generator", owner: node, artifacts: generatorArtifacts });
      for (const value of Object.values(node)) {
        if (value && typeof value === "object") walk(value);
      }
    };
    walk(root);
    emitContainers(containers, (owner) => userInputs.get(trimmed(owner?.action_id ?? owner?.actionId, 128)) || null, realtimeNowMs, records);
    return { records };
  }

  // The legacy page-memory shape (sessions[].input + sessions[].messages[]
  // .raw) pairs each record with its own session's input. Whether the
  // input's attached images are a base image is decided per artifact by its
  // task_type (see buildAgentRecord), not by comparing action ids.
  function recordsFromSessions(sessions) {
    const records = [];
    let visited = 0;
    for (const session of Array.isArray(sessions) ? sessions : []) {
      if (!session || typeof session !== "object" || visited >= MAX_WALK_NODES) continue;
      const input = session.input && typeof session.input === "object" ? session.input : {};
      const sessionInput = collectUserInput(input)
        || { actionKey: "", text: "", generatorParams: null, markUrls: [], imageUrls: [], timestampMs: null };
      for (const message of Array.isArray(session.messages) ? session.messages : []) {
        visited += 1;
        const raw = message && typeof message === "object" && message.raw && typeof message.raw === "object"
          ? message.raw
          : null;
        if (!raw) continue;
        const userInputForRecord = sessionInput;
        const agentArtifacts = agentArtifactsFromContent(raw);
        if (agentArtifacts) {
          const context = agentContextFromOwner(raw, userInputForRecord);
          for (const artifact of agentArtifacts) {
            const record = buildAgentRecord(artifact, context);
            if (record) records.push(record);
          }
        }
        const generatorArtifacts = generatorArtifactsFromText(raw);
        if (generatorArtifacts) {
          const context = generatorContextFromOwner(raw, userInputForRecord);
          for (const artifact of generatorArtifacts) {
            const record = buildGeneratorRecord(artifact, context);
            if (record) records.push(record);
          }
        }
      }
    }
    return { records };
  }

  function extractLovartHistory(text) {
    const root = parseJsonText(text);
    if (!root || typeof root !== "object" || Array.isArray(root)) return { records: [] };
    if (Array.isArray(root.sessions)) return recordsFromSessions(root.sessions);
    return recordsFromGenericTree(root);
  }

  // Per-page socket state: the latest user words per conversation ("one
  // running task per conversation at a time") and the agent's tool calls
  // until their result frame arrives.
  function createFrameState() {
    return {
      pendingUsers: new Map(),
      pendingTools: new Map(),
      pendingGeneratorPrompts: new Map(),
    };
  }

  function capMap(map) {
    while (map.size > PENDING_MAX) map.delete(map.keys().next().value);
  }

  function learnClientFrame(frame, state) {
    if (!frame || typeof frame !== "object" || !state) return;
    const data = frame.data && typeof frame.data === "object" ? frame.data : {};
    const threadId = trimmed(data.thread_id, 128);
    if (!threadId) return;
    if (frame.type === "chat-canda") {
      const contents = [];
      for (const message of Array.isArray(data.messages) ? data.messages : []) {
        if (message && typeof message === "object" && Array.isArray(message.contents)) {
          for (const part of message.contents) {
            if (part && typeof part === "object") contents.push(part);
          }
        }
      }
      let text = "";
      const markUrls = [];
      for (const part of contents) {
        if (part.type === "text" && typeof part.text === "string") text = text ? `${text}\n${part.text}` : part.text;
        if (part.type === "mark" && typeof part.url === "string") markUrls.push(part.url);
      }
      state.pendingUsers.set(threadId, { text, markUrls, generatorParams: null });
      capMap(state.pendingUsers);
      return;
    }
    if (frame.type === "chat-canda-generator") {
      const params = data.generator_params && typeof data.generator_params === "object" ? data.generator_params : {};
      const inputArgs = params.input_args && typeof params.input_args === "object" ? params.input_args : {};
      const unitData = inputArgs.original_unit_data && typeof inputArgs.original_unit_data === "object"
        ? inputArgs.original_unit_data
        : {};
      const generatorParams = {
        generatorName: trimmed(params.generator_name),
        prompt: typeof inputArgs.prompt === "string" ? inputArgs.prompt.trim().slice(0, MAX_PROMPT_LENGTH) : "",
        referenceUrls: [
          ...collectUrlList(unitData.image),
          ...collectUrlList(unitData.source_image),
          ...collectUrlList(inputArgs.source_image),
          ...collectUrlList(inputArgs.reference_image_urls),
        ],
      };
      state.pendingUsers.set(threadId, { text: generatorParams.prompt, markUrls: [], generatorParams });
      capMap(state.pendingUsers);
    }
  }

  // Server pushes: only content_block_start frames can carry finished image
  // artifacts. tool_use blocks remember the agent's call until the matching
  // tool_event result; everything else (create_chat_status, skill_file,
  // tool_stage estimates, text deltas) produces nothing.
  function recordsFromServerFrame(frame, state, nowMs) {
    const records = [];
    if (!frame || typeof frame !== "object" || frame.type !== "chat" || !state) return records;
    const data = frame.data && typeof frame.data === "object" ? frame.data : {};
    const inner = data.data && typeof data.data === "object" ? data.data : {};
    const block = inner.content_block && typeof inner.content_block === "object" ? inner.content_block : null;
    if (data.type !== "content_block_start" || !block) return records;
    const threadId = trimmed(data.thread_id, 128);
    const actionKey = trimmed(data.action_id, 128);

    if (block.type === "tool_use") {
      const input = block.input && typeof block.input === "object" ? block.input : {};
      const toolKey = trimmed(block.id, 128) || threadId;
      if (toolKey) {
        state.pendingTools.set(toolKey, {
          prompt: typeof input.prompt === "string" ? input.prompt.trim().slice(0, MAX_PROMPT_LENGTH) : "",
          model: trimmed(block.tool_hint ?? input.tool_hint),
          referenceUrls: collectUrlList(input.reference_image_urls),
        });
        capMap(state.pendingTools);
      }
      return records;
    }

    if (block.type === "tool_event") {
      const artifacts = agentArtifactsFromContent(block);
      if (!artifacts) return records;
      const toolKey = trimmed(block.id, 128);
      const pendingTool = toolKey ? (state.pendingTools.get(toolKey) || null) : null;
      if (toolKey) state.pendingTools.delete(toolKey);
      const context = {
        ...agentContextFromOwner({ name: block.name, action_id: data.action_id, thread_id: data.thread_id, thread_meta: { session_id: data.session_id } }, state.pendingUsers.get(threadId) || null),
        pendingTool,
        isRealtime: true,
        nowMs,
        timestampMs: null,
      };
      for (const artifact of artifacts) {
        const record = buildAgentRecord(artifact, context);
        if (record) records.push(record);
      }
      return records;
    }

    if (block.type === "generator_event") {
      const startPrompt = generatorStartPrompt(block);
      if (startPrompt) {
        state.pendingGeneratorPrompts.set(threadId, startPrompt);
        capMap(state.pendingGeneratorPrompts);
      }
      const artifacts = realtimeGeneratorArtifacts(block);
      if (!artifacts) return records;
      const context = {
        ...generatorContextFromOwner({ action_id: data.action_id, thread_id: data.thread_id, thread_meta: { session_id: data.session_id } }, state.pendingUsers.get(threadId) || null),
        model: trimmed(block.name),
        pendingGeneratorPrompt: state.pendingGeneratorPrompts.get(threadId) || "",
        isRealtime: true,
        nowMs,
        timestampMs: null,
      };
      for (const artifact of artifacts) {
        const record = buildGeneratorRecord(artifact, context);
        if (record) records.push(record);
      }
      return records;
    }
    return records;
  }

  // Test seam: the extraction core runs in a plain sandbox without Chrome.
  globalThis.MosaLovartCapture = Object.freeze({
    cleanUserMessage,
    mediaUrlInfo,
    referenceIdForUrl,
    isLovartMediaHost,
    mimeTypeForUrl,
    extractLovartHistory,
    recordsFromGenericTree,
    learnClientFrame,
    recordsFromServerFrame,
    createFrameState,
    basePayload,
    manualPayload,
  });
  if (typeof chrome === "undefined" || !chrome?.runtime?.id) return;

  let autoCapture = false;
  let autoBaselineMs = 0;
  let hookPort = null;
  let providerContextLost = false;
  const seen = new Set();
  const historyBaseline = new Set();
  const learnedByKey = new Map();
  const frameState = createFrameState();
  const retryAttempts = new Map();
  const referenceUploads = new Map();
  let captureInFlight = 0;
  const captureWaiters = [];
  let toastTimer = null;
  let scanTimer = null;

  // Diagnostic lines only: ids and host+path, never prompts, account data,
  // or anything from the socket address (which never reaches this script).
  function debugLog(...parts) {
    try { console.info("[GravityPort] lovart", ...parts); } catch { /* console unavailable */ }
  }

  function urlForLog(value) {
    try {
      const url = new URL(String(value || ""));
      return `${url.host}${url.pathname.slice(0, 120)}`;
    } catch {
      return "";
    }
  }

  function markSeen(key) {
    if (!key) return;
    seen.delete(key);
    seen.add(key);
    while (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
  }

  // The background keeps a queued or refused capture, so the key stays. Only
  // a retryable answer, or a message that never got an answer, frees the
  // key, and then only twice and 60 s apart.
  const RETRY_MAX_ATTEMPTS = 2;
  const RETRY_GAP_MS = 60_000;

  function releaseSeenForRetry(key) {
    const attempts = retryAttempts.get(key) || 0;
    if (attempts >= RETRY_MAX_ATTEMPTS) return;
    retryAttempts.delete(key);
    retryAttempts.set(key, attempts + 1);
    while (retryAttempts.size > SEEN_MAX) retryAttempts.delete(retryAttempts.keys().next().value);
    setTimeout(() => seen.delete(key), RETRY_GAP_MS);
  }

  function handOffNeedsRetry(response) {
    return !response || (response.ok === false && response.retryable === true);
  }

  function persistedMediaIds() {
    const ids = [];
    for (const key of seen) {
      if (!key.startsWith("lovart:image:")) continue;
      ids.push(key.slice("lovart:image:".length));
      if (ids.length >= SEEN_MAX) break;
    }
    return ids;
  }

  function persistSeen() {
    try {
      chrome.storage?.local?.set?.({ [SEEN_STORE_KEY]: persistedMediaIds() })?.catch?.(() => {});
    } catch {
      // Storage unavailable; the in-memory set still guards this page.
    }
  }

  async function loadPersistedSeen() {
    try {
      const stored = await chrome.storage?.local?.get?.({ [SEEN_STORE_KEY]: [] });
      for (const id of Array.isArray(stored?.[SEEN_STORE_KEY]) ? stored[SEEN_STORE_KEY] : []) {
        if (typeof id === "string" && id) markSeen(`lovart:image:${id}`);
      }
    } catch {
      // Keep the in-memory set only.
    }
  }

  async function ensureLovartBaseline() {
    if (autoBaselineMs) return autoBaselineMs;
    try {
      const stored = await chrome.storage?.local?.get?.({ [AUTO_BASELINE_KEY]: 0 });
      const value = Number(stored?.[AUTO_BASELINE_KEY]) || 0;
      if (value > 0) {
        autoBaselineMs = value;
        return autoBaselineMs;
      }
    } catch {
      // Fall through to writing a fresh baseline.
    }
    const now = Date.now();
    try {
      await chrome.storage?.local?.set?.({ [AUTO_BASELINE_KEY]: now });
    } catch {
      // Keep the in-memory baseline; the next page retries the write.
    }
    autoBaselineMs = now;
    return autoBaselineMs;
  }

// 任务 359（EXT-43/46）：后台与服务端的英文原文只进诊断；上屏前按已知原句
// 映射成统一文案，认不出的原样返回。与 content.js 的同名函数保持一致。
function friendlyCaptureError(message) {
  const text = String(message || "");
  const rules = [
    [/\(网址已过期\)|链接已过期/, "无法下载：链接已过期，请刷新页面后重试"],
    [/blob\/img fetch failed|Image download failed|Failed to download image|Downloaded image empty\/too small/, "无法保存图片：下载未完成"],
    [/Failed to download video|Downloaded video empty\/too small|Recorded media empty\/too small/, "无法保存视频：下载未完成"],
    [/exceeds GravityPort capture size limit|exceeds the supported size limit/, "无法保存：文件超过 GravityPort 的大小上限"],
    [/Unsupported media host|Unsupported media URL protocol|Invalid media URL/, "无法保存：不支持该网站的媒体链接"],
    [/Unsupported web (image|video) provider|Unsupported web capture provider/, "无法保存：不支持此网站"],
    [/Capture metadata is too large|request body exceeds|media exceeds/, "无法保存：附带信息过大"],
    [/Midjourney original/, "无法保存：未获取到原图"],
    [/Unauthorized web capture token/, "无法保存：与 GravityPort 的连接已失效，请重新打开 GravityPort 后重试"],
    [/Web capture is disabled until/, "无法保存：GravityPort 未启用浏览器扩展收录"],
    [/Image exceeds 15 MiB limit/, "无法保存：图片超过 15 MB 上限"],
    [/Video exceeds 96 MiB limit/, "无法保存：视频超过 96 MB 上限"],
    [/Image exceeds \d+ pixel limit/, "无法保存：图片尺寸超过上限"],
    [/Image bytes are invalid/, "无法保存：图片数据无效或不完整"],
    [/Web capture is busy/, "GravityPort 正忙，请稍后重试"],
    [/GravityPort returned non-JSON \((\d+)\)/, "无法保存：GravityPort 返回了无法识别的内容（HTTP $1）。请更新 GravityPort 后重试。"],
    [/GravityPort ingest failed \((\d+)\)/, "无法保存：GravityPort 返回错误（HTTP $1）"],
    [/Canvas encoding failed/, "无法保存：无法处理该图片"],
    [/Unsupported data URL/, "无法保存：不支持的图片格式"],
    [/Unknown extension error/, "无法保存：扩展出现未知错误"],
  ];
  for (const [pattern, replacement] of rules) {
    if (pattern.test(text)) return text.replace(pattern, replacement);
  }
  return text;
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
    showToast("扩展已更新，请刷新此页面以继续收录", true, 0);
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

  function sendIngest(payload) {
    return chrome.runtime.sendMessage({ type: "mosa.ingest", payload });
  }

  function basePayload(record) {
    const prompt = record.prompt || "";
    const referenceProviderAssetIds = [];
    for (const referenceUrl of record.referenceUrls || []) {
      const refId = referenceIdForUrl(referenceUrl);
      if (refId && !referenceProviderAssetIds.includes(refId)) referenceProviderAssetIds.push(refId);
    }
    return {
      provider: "lovart",
      mediaKind: "image",
      mimeType: mimeTypeForUrl(record.mediaUrl),
      pageUrl: location.href,
      promptStatus: prompt ? "generation-tool-prompt" : "not-available",
      promptSource: prompt
        ? (record.promptKind === "generator" ? "lovart-generator-prompt" : "lovart-agent-prompt")
        : "",
      prompt,
      ...(record.userMessage ? { userMessage: record.userMessage } : {}),
      model: record.model || "",
      captureMode: "automatic",
      capturedAt: new Date().toISOString(),
      conversationId: record.conversationId || "",
      generationContextId: record.messageId || "",
      messageId: record.messageId || "",
      providerAssetId: record.providerAssetId || "",
      referenceProviderAssetIds,
      generationStatus: "completed",
      imageUrl: record.mediaUrl,
      width: record.width || 0,
      height: record.height || 0,
    };
  }

  async function captureReference(referenceUrl, record) {
    try {
      await sendIngest({
        provider: "lovart",
        mediaKind: "image",
        mimeType: mimeTypeForUrl(referenceUrl),
        imageUrl: referenceUrl,
        pageUrl: location.href,
        promptStatus: "not-available",
        captureMode: "automatic",
        capturedAt: new Date().toISOString(),
        conversationId: record.conversationId || "",
        generationContextId: record.messageId || "",
        isReference: true,
        providerAssetId: (referenceIdForUrl(referenceUrl)
          || `ref:${mediaUrlInfo(referenceUrl)?.id || referenceUrl}`).slice(0, 160),
      });
    } catch {
      // An optional reference failure never blocks the generated output.
    }
  }

  // The app attaches references to the generation at the moment the finished
  // asset lands (matched by generation_context_id), so every reference of a
  // record must be ingested before the record's media. References of one
  // record go out in parallel and are sent once per record.
  async function captureRecordReferences(record) {
    await Promise.all((record.referenceUrls || []).map((referenceUrl) => {
      const refId = referenceIdForUrl(referenceUrl);
      if (!refId) return undefined;
      const key = `lovart:ref:${record.messageId || record.conversationId || ""}:${refId}`;
      const pending = referenceUploads.get(key);
      if (pending) return pending;
      if (seen.has(key)) return undefined;
      markSeen(key);
      const upload = captureReference(referenceUrl, record).finally(() => referenceUploads.delete(key));
      referenceUploads.set(key, upload);
      return upload;
    }));
  }

  async function captureRecordMedia(record) {
    return withCaptureSlot(async () => {
      const key = `lovart:image:${record.providerAssetId}`;
      if (seen.has(key)) return { ok: true };
      markSeen(key);
      try {
        const response = await sendIngest(basePayload(record));
        if (!response?.ok) {
          if (handOffNeedsRetry(response)) releaseSeenForRetry(key);
          else persistSeen();
          return { ok: false, error: response?.error };
        }
        persistSeen();
        return { ok: true };
      } catch (error) {
        releaseSeenForRetry(key);
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  async function captureRecordWithReferences(record) {
    await captureRecordReferences(record);
    return captureRecordMedia(record);
  }

  function isRecordFresh(record) {
    if (!autoBaselineMs) return false;
    const at = record.capturedAtMs;
    if (at === null || !Number.isFinite(at)) return false;
    return at >= autoBaselineMs - FRESH_SLACK_MS;
  }

  async function attemptAutomaticCapture() {
    if (!autoCapture) return;
    await ensureLovartBaseline();
    for (const record of learnedByKey.values()) {
      const id = record.providerAssetId;
      if (!id || !record.mediaUrl) continue;
      if (seen.has(`lovart:image:${id}`)) continue;
      if (historyBaseline.has(id)) continue;
      if (!isRecordFresh(record)) {
        // Created before the auto-capture baseline (or with no readable
        // time): remember prompt/model/references for the right-click manual
        // save, never auto-capture.
        historyBaseline.add(id);
        debugLog("history record skipped", id, record.capturedAtMs ? "older than the capture baseline" : "no timestamp");
        continue;
      }
      debugLog("new image, capturing", id, urlForLog(record.mediaUrl));
      void captureRecordWithReferences(record);
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
      void attemptAutomaticCapture();
    }, 300);
  }

  function mergeLearned(record) {
    if (!record?.providerAssetId || !record.mediaUrl) return;
    const previous = learnedByKey.get(record.providerAssetId);
    if (!previous) {
      learnedByKey.set(record.providerAssetId, record);
    } else {
      learnedByKey.set(record.providerAssetId, {
        ...previous,
        mediaUrl: record.mediaUrl || previous.mediaUrl,
        prompt: record.prompt || previous.prompt,
        promptKind: record.promptKind || previous.promptKind,
        userMessage: record.userMessage || previous.userMessage,
        model: record.model || previous.model,
        conversationId: record.conversationId || previous.conversationId,
        messageId: record.messageId || previous.messageId,
        width: record.width || previous.width,
        height: record.height || previous.height,
        capturedAtMs: earlierMs(record.capturedAtMs, previous.capturedAtMs),
        referenceUrls: record.referenceUrls.length ? record.referenceUrls : previous.referenceUrls,
      });
    }
    while (learnedByKey.size > SEEN_MAX) learnedByKey.delete(learnedByKey.keys().next().value);
  }

  // The true creation time is the earlier of the two observations (the
  // realtime receive time only ever says "no older than this").
  function earlierMs(a, b) {
    if (a === null || !Number.isFinite(a)) return b ?? null;
    if (b === null || !Number.isFinite(b)) return a;
    return Math.min(a, b);
  }

  function onHistoryText(text) {
    if (typeof text !== "string" || !text || text.length > MAX_RESPONSE_TEXT) return;
    const { records } = extractLovartHistory(text);
    if (records.length) debugLog("history", records.length, "generation images");
    for (const record of records) mergeLearned(record);
    scheduleScan();
  }

  function onFrameText(text) {
    if (typeof text !== "string" || !text || text.length > MAX_RESPONSE_TEXT) return;
    const frame = parseJsonText(text);
    // Not a recognizable JSON frame: skip silently.
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) return;
    if (frame.type === "chat-canda" || frame.type === "chat-canda-generator") {
      learnClientFrame(frame, frameState);
      return;
    }
    let records = recordsFromServerFrame(frame, frameState, Date.now());
    if (!records.length && frame.type !== "chat") {
      // No sample exists for the legacy UI's socket pushes: try the same
      // structural walk and silently skip what it cannot recognize (the
      // history backfill after a refresh still captures those images).
      records = recordsFromGenericTree(frame, Date.now()).records;
    }
    if (records.length) debugLog("socket", records.length, "generation images");
    for (const record of records) mergeLearned(record);
    scheduleScan();
  }

  function onHookMessage(message) {
    if (message?.type === "lovart-api-response") {
      onHistoryText(String(message.text || ""));
      return;
    }
    if (message?.type === "lovart-ws-message") {
      onFrameText(String(message.text || ""));
    }
  }

  function connectHookPort() {
    window.addEventListener("message", (event) => {
      if (event.origin !== location.origin) return;
      const data = event.data;
      if (data?.source !== "mosa-lovart-hook" || data.type !== "hook-port") return;
      const [port] = event.ports || [];
      if (!port) return;
      if (hookPort) {
        try { hookPort.close(); } catch { /* replaced */ }
      }
      hookPort = port;
      port.addEventListener("message", (portEvent) => {
        onHookMessage(portEvent.data);
      });
      port.start?.();
    });
    // The page hook is installed at document_start; this script may wake much
    // later (or after a service-worker restart), so ask for a fresh port.
    try {
      window.postMessage({ source: "mosa-lovart-content", type: "hook-port-request" }, location.origin);
    } catch {
      // The page may not be ready; the hook also re-offers on its own.
    }
  }

  function manualPayload(mediaUrl, learned) {
    const info = mediaUrlInfo(mediaUrl);
    const prompt = learned?.prompt || "";
    const referenceProviderAssetIds = [];
    if (learned) {
      for (const referenceUrl of learned.referenceUrls || []) {
        const refId = referenceIdForUrl(referenceUrl);
        if (refId && !referenceProviderAssetIds.includes(refId)) referenceProviderAssetIds.push(refId);
      }
    }
    return {
      provider: "lovart",
      mediaKind: "image",
      mimeType: mimeTypeForUrl(learned?.mediaUrl || mediaUrl),
      pageUrl: location.href,
      promptStatus: prompt ? "generation-tool-prompt" : "not-available",
      promptSource: prompt
        ? (learned?.promptKind === "generator" ? "lovart-generator-prompt" : "lovart-agent-prompt")
        : "",
      prompt,
      ...(learned?.userMessage ? { userMessage: learned.userMessage } : {}),
      model: learned?.model || "",
      captureMode: "manual",
      capturedAt: new Date().toISOString(),
      conversationId: learned?.conversationId || "",
      generationContextId: learned?.messageId || "",
      messageId: learned?.messageId || "",
      providerAssetId: learned?.providerAssetId || info?.id || "",
      ...(learned ? { referenceProviderAssetIds } : {}),
      generationStatus: "completed",
      // A learned record carries the full-size URL; the clicked thumbnail may
      // be the same image behind resize query parameters.
      imageUrl: learned?.mediaUrl || info?.url || mediaUrl,
      width: learned?.width || 0,
      height: learned?.height || 0,
    };
  }

  function learnedVariantFor(assetId) {
    return assetId ? (learnedByKey.get(assetId) || null) : null;
  }

  async function loadProviderSettings() {
    try {
      const response = await chrome.runtime?.sendMessage?.({ type: "mosa.getSettings" });
      if (response?.ok && response.settings) {
        autoCapture = response.settings.autoCapture !== false;
      } else {
        const stored = await chrome.storage?.local?.get?.({ autoCapture });
        if (stored) autoCapture = stored.autoCapture !== false;
      }
    } catch {
      try {
        const stored = await chrome.storage?.local?.get?.({ autoCapture });
        if (stored) autoCapture = stored.autoCapture !== false;
      } catch {
        // Keep the in-memory default.
      }
    }
    if (autoCapture) await ensureLovartBaseline();
    await loadPersistedSeen();
  }

  chrome.runtime?.onMessage?.addListener?.((message, _sender, sendResponse) => {
    if (!message || !["mosa.capture.saveImageWithPrompt", "mosa.capture.saveVideoWithPrompt"].includes(message.type)) return false;
    if (message.type === "mosa.capture.saveVideoWithPrompt") {
      showToast("无法保存：Lovart 暂只支持收录图片", true);
      sendResponse({ ok: false, error: "无法保存：Lovart 暂只支持收录图片" });
      return true;
    }
    (async () => {
      const clickedUrl = String(message.imageUrl || "");
      const info = mediaUrlInfo(clickedUrl);
      if (!info) {
        showToast("无法保存：请在支持的网站上选择生成的图片", true);
        sendResponse({ ok: false, error: "无法保存：请在支持的网站上选择生成的图片" });
        return;
      }
      const learned = learnedVariantFor(info.id);
      const payload = manualPayload(info.url, learned);
      if (learned?.referenceUrls?.length) await captureRecordReferences(learned);
      const response = await sendIngest(payload);
      showToast(response?.ok ? "已保存到 GravityPort" : friendlyCaptureError(response?.error || "无法保存"), !response?.ok);
      sendResponse(response || { ok: false });
    })().catch((error) => {
      const errorText = friendlyCaptureError(error instanceof Error ? error.message : String(error));
      showToast(errorText, true);
      sendResponse({ ok: false, error: errorText });
    });
    return true;
  });

  loadProviderSettings().then(() => {
    connectHookPort();
    scheduleScan();
  }).catch(() => {});

  chrome.storage?.onChanged?.addListener?.((changes, area) => {
    if (area !== "local") return;
    if (changes.autoCapture) {
      autoCapture = changes.autoCapture.newValue !== false;
      if (autoCapture) void ensureLovartBaseline().then(() => scheduleScan());
    }
    if (changes.mosaBaseUrl || changes.mosaToken) seen.clear();
  });
})();
