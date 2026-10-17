/**
 * Page-world hook: bind generated-image metadata within one ChatGPT message.
 * Never broadcast one old caption onto every image URL in a payload.
 */
(function mosaPageHook() {
  if (window.__mosaPageHookInstalled) return;
  window.__mosaPageHookInstalled = true;
  let captureEnabled = false;
  // DEV-ONLY(128): remove before release (the whole dev raw diagnostics block).
  // Optional raw-traffic recorder for prompt-less captures. Disabled by
  // default, switched on through the hidden options-page #dev panel; every
  // call site below is wrapped so a failure here can never touch capture.
  // (globalThis and window are the same object in a real MAIN world; the
  // module registers itself on globalThis.)
  const devRaw = (globalThis.MosaDevRawDiagnostics && globalThis.MosaDevRawDiagnostics.__installed)
    ? globalThis.MosaDevRawDiagnostics
    : null;
  if (devRaw) devRaw.onRecord = (record) => post("dev-raw-diagnostic", record);
  function devRawEnabled() {
    try {
      return Boolean(devRaw && devRaw.isEnabled());
    } catch {
      return false;
    }
  }
  // One conversation per tab in practice; conversationIdFromLocation() keeps
  // frames with the conversation the user has open. A brand-new chat has no
  // /c/<id> in the URL until the server assigns one mid-stream, so those
  // frames go to the recorder's unrouted bucket and are merged back in when
  // the round closes.
  function devRawConversationKey() {
    return conversationIdFromLocation() || (devRaw && devRaw.UNROUTED_KEY) || "";
  }
  function devRawRecordSseLine(method, url, line) {
    if (!devRawEnabled()) return;
    try {
      devRaw.recordSseLine(devRawConversationKey(), { method, path: devRawPathOf(url) }, line);
    } catch {
      // diagnostics must never affect page hooks
    }
  }
  function devRawRecordSocket(direction, data) {
    if (!devRawEnabled()) return;
    try {
      devRaw.recordSocketMessage(devRawConversationKey(), direction, data);
    } catch {
      // diagnostics must never affect page hooks
    }
  }
  function devRawRecordHttp(method, url, status, contentType, bodyText) {
    if (!devRawEnabled()) return;
    try {
      devRaw.recordHttpExchange(devRawConversationKey(), { method, url, status, contentType, bodyText });
    } catch {
      // diagnostics must never affect page hooks
    }
  }
  function devRawPathOf(value) {
    try {
      return new URL(String(value || ""), location.origin).pathname;
    } catch {
      return String(value || "");
    }
  }
  function devRawIsBackendApiUrl(value) {
    try {
      const url = new URL(String(value || ""), location.origin);
      return (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com")
        && url.pathname.startsWith("/backend-api/");
    } catch {
      return false;
    }
  }
  function devRawRequestMethodOf(args) {
    const first = args[0];
    if (first && typeof first === "object" && typeof first.method === "string") return first.method;
    const init = args[1];
    if (init && typeof init.method === "string") return init.method;
    return "GET";
  }
  // Binary or streamed responses are recorded without their body; the SSE
  // lines and the image metadata carry what matters.
  function devRawBodyTextFor(contentType, text) {
    const type = String(contentType || "").toLowerCase();
    if (!text) return "";
    if (/^(?:image\/|video\/|audio\/|font\/)/.test(type) || type.includes("octet-stream") || type.includes("event-stream")) return "";
    return text;
  }
  // Threat model: injected page scripts that run after document_start must
  // neither learn the bridge identity nor forge capture events. Publishing a
  // channel name in the DOM failed the first half, and every window message
  // failed the second. A MessagePort is transferred exactly once, as a
  // transient window message that later-running scripts never observe. This
  // does not (and cannot) defend against code that runs before the hook or
  // rewrites page built-ins such as Response.prototype: both share this realm.
  let commandPort = null;
  let commandPortPost = null;
  let portConfirmed = false;

  function onPortMessage(event) {
    const data = event?.data;
    if (data?.source !== "mosa-chatgpt-capture") return;
    if (data.type === "hook-port-ack") {
      portConfirmed = true;
      return;
    }
    if (data.type === "set-capture-enabled") {
      captureEnabled = data.payload?.enabled === true;
      post("capture-state", { enabled: captureEnabled });
      return;
    }
    if (data.type === "set-dev-raw-diagnostics-enabled") {
      // DEV-ONLY(128): remove before release. The dev diagnostics recorder is
      // opt-in from the hidden options-page #dev panel and is set
      // independently of captureEnabled. Auto-capture being on or off must
      // never flip this switch; enabling or disabling it clears the in-memory
      // buffer immediately.
      const diagnosticsEnabled = data.payload?.enabled === true;
      if (devRaw) devRaw.setEnabled(diagnosticsEnabled);
      return;
    }
    if (data.type === "refresh-current-conversation") refreshCurrentConversation().catch(() => {});
  }

  function handPortToContent() {
    const channel = new MessageChannel();
    commandPort = channel.port1;
    // Bind postMessage at hand-off time: a later page rewrite of the port
    // object cannot reroute hook traffic.
    commandPortPost = commandPort.postMessage.bind(commandPort);
    commandPort.addEventListener("message", onPortMessage);
    commandPort.start?.();
    window.postMessage(
      { source: "mosa-chatgpt-capture", type: "hook-port" },
      location.origin,
      [channel.port2],
    );
  }

  function markReady() {
    if (document.documentElement) {
      try {
        document.documentElement.dataset.mosaPageHook = "1";
      } catch {
        // The hook itself still works in test/minimal document environments.
      }
      return;
    }
    document.addEventListener("DOMContentLoaded", markReady, { once: true });
  }
  markReady();
  handPortToContent();

  const PROMPT_KEY_ALIASES = new Map([
    ["prompt", "prompt"],
    ["revised_prompt", "revised_prompt"], ["revisedprompt", "revised_prompt"],
    ["generation_prompt", "generation_prompt"], ["generationprompt", "generation_prompt"],
    ["image_prompt", "image_prompt"], ["imageprompt", "image_prompt"],
    ["original_prompt", "original_prompt"], ["originalprompt", "original_prompt"],
    ["caption", "caption"],
    ["model_caption", "model_caption"], ["modelcaption", "model_caption"],
    ["alt_text", "alt_text"], ["alttext", "alt_text"],
    ["metadata_caption", "metadata_caption"], ["metadatacaption", "metadata_caption"],
  ]);
  const URL_KEYS = new Set([
    "url", "download_url", "src", "image_url", "asset_url", "file_url",
    "encoded_image_url", "downloadurl", "imageurl", "asseturl", "fileurl", "encodedimageurl",
  ]);
  const ASSET_REFERENCE_KEYS = new Set([
    "asset_pointer", "assetpointer", "asset_id", "file_id", "image_id", "assetid", "fileid", "imageid",
  ]);
  const CONVERSATION_ID_KEYS = new Set(["conversation_id", "conversationid", "cid"]);
  const MESSAGE_ID_KEYS = new Set(["message_id", "messageid"]);
  const RESPONSE_ID_KEYS = new Set(["response_id", "responseid"]);
  const TOOL_CALL_ID_KEYS = new Set(["tool_call_id", "toolcallid", "call_id", "callid"]);
  // Keep provider generation-call identity separate from generic tool-call
  // identity. Only accept fields whose names explicitly say they are image /
  // generation call ids; never promote tool_call_id into this slot.
  const GENERATION_CALL_ID_KEYS = new Set([
    "generation_call_id", "generationcallid",
    "image_generation_call_id", "imagegenerationcallid",
    "image_gen_call_id", "imagegencallid",
  ]);
  const GENERATION_STATUS_KEYS = new Set([
    "status", "state", "generation_status", "generationstatus",
    "result_status", "resultstatus", "finish_reason", "finishreason",
  ]);
  const STRUCTURED_JSON_KEYS = new Set([
    "arguments", "args", "input", "inputs", "parameters", "params",
    "payload", "request", "result", "output", "tool_input", "toolinput",
    "async_source",
  ]);

  function post(type, payload) {
    try {
      commandPortPost?.({ type, payload });
    } catch {
      // ignore
    }
  }

  function postDebug(stage, details = {}) {
    post("capture-debug", {
      stage: String(stage || "unknown").slice(0, 40),
      ...details,
    });
  }

  function parseStructuredJson(value) {
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (text.length < 2 || text.length > 512_000) return null;
    if (!((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]")))) return null;
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function interestingFieldKeys(value, out = new Set(), depth = 0) {
    if (!value || typeof value !== "object" || depth > 7 || out.size >= 24) return [...out];
    for (const [rawKey, child] of Object.entries(value)) {
      const key = String(rawKey || "").toLowerCase();
      if (/prompt|caption|image|asset|generation|tool|argument|input/.test(key)) out.add(key.slice(0, 80));
      if (out.size >= 24) break;
      if (child && typeof child === "object") interestingFieldKeys(child, out, depth + 1);
      else if (STRUCTURED_JSON_KEYS.has(key)) {
        const parsed = parseStructuredJson(child);
        if (parsed) interestingFieldKeys(parsed, out, depth + 1);
      }
    }
    return [...out];
  }

  function promptFieldShapes(value, path = "", out = [], depth = 0) {
    if (!value || typeof value !== "object" || depth > 7 || out.length >= 12) return out;
    for (const [rawKey, child] of Object.entries(value)) {
      const key = String(rawKey || "").toLowerCase();
      const nextPath = path ? `${path}.${key}` : key;
      const canonical = canonicalPromptKey(key);
      if (canonical) {
        const type = Array.isArray(child) ? "array" : child === null ? "null" : typeof child;
        out.push({
          path: nextPath.slice(0, 160),
          type,
          keys: child && typeof child === "object" && !Array.isArray(child)
            ? Object.keys(child).slice(0, 16).map((item) => String(item).slice(0, 80))
            : [],
          length: Array.isArray(child) ? child.length : typeof child === "string" ? child.length : undefined,
        });
      }
      if (child && typeof child === "object") promptFieldShapes(child, nextPath, out, depth + 1);
    }
    return out;
  }

  function sanitizedSchema(value, path = "", out = [], depth = 0) {
    if (depth > 8 || out.length >= 96 || value == null) return out;
    if (Array.isArray(value)) {
      out.push({ path: path || "$", type: "array", length: value.length });
      for (let index = 0; index < Math.min(value.length, 8); index += 1) {
        sanitizedSchema(value[index], `${path}[${index}]`, out, depth + 1);
      }
      return out;
    }
    if (typeof value === "object") {
      if (path) out.push({ path, type: "object", keys: Object.keys(value).slice(0, 24) });
      for (const [rawKey, child] of Object.entries(value)) {
        const key = String(rawKey || "").slice(0, 80);
        const nextPath = path ? `${path}.${key}` : key;
        sanitizedSchema(child, nextPath, out, depth + 1);
        if (out.length >= 96) break;
      }
      return out;
    }
    out.push({
      path: path || "$",
      type: typeof value,
      length: typeof value === "string" ? value.length : undefined,
    });
    return out;
  }

  function opaqueSourceShapes(value, path = "", out = [], depth = 0) {
    if (!value || typeof value !== "object" || depth > 7 || out.length >= 12) return out;
    for (const [rawKey, child] of Object.entries(value)) {
      const key = String(rawKey || "").toLowerCase();
      const nextPath = path ? `${path}.${key}` : key;
      if (key === "async_source" && typeof child === "string") {
        const text = child.trim();
        const descriptor = {
          path: nextPath.slice(0, 160),
          length: text.length,
          kind: "opaque",
        };
        const parsed = parseStructuredJson(text);
        if (parsed) {
          descriptor.kind = "json";
          descriptor.rootKeys = Array.isArray(parsed)
            ? []
            : Object.keys(parsed).slice(0, 24).map((item) => String(item).slice(0, 80));
          descriptor.interestingKeys = interestingFieldKeys(parsed).slice(0, 24);
        } else if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
          try {
            const url = new URL(text);
            descriptor.kind = "uri";
            descriptor.scheme = url.protocol.replace(/:$/, "").slice(0, 24);
            descriptor.pathSegments = url.pathname.split("/").filter(Boolean).length;
            descriptor.queryKeys = [...new Set([...url.searchParams.keys()])]
              .slice(0, 24)
              .map((item) => String(item).slice(0, 80));
          } catch {
            descriptor.kind = "opaque";
          }
        }
        out.push(descriptor);
      }
      if (child && typeof child === "object") opaqueSourceShapes(child, nextPath, out, depth + 1);
    }
    return out;
  }

  function isCaptureEnabled() {
    return captureEnabled === true;
  }

  function isHttpUrl(value) {
    return typeof value === "string" && /^https?:\/\//i.test(value);
  }

  function chatGptImageProxyInfo(value) {
    if (!isHttpUrl(value)) return null;
    try {
      const url = new URL(value);
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

  function genericImageKey(value) {
    if (!isHttpUrl(value)) return "";
    try {
      const url = new URL(value);
      return `url:${url.origin}${url.pathname}`;
    } catch {
      return "";
    }
  }

  function imageIdentity(imageUrl, extra = {}) {
    const proxy = chatGptImageProxyInfo(imageUrl);
    const assetId = normalizeAssetId(extra.assetId) || proxy?.assetId || "";
    const conversationId = String(extra.conversationId || proxy?.conversationId || "").trim();
    const imageKey = String(extra.imageKey || proxy?.imageKey || "").trim()
      || (assetId && conversationId ? `estuary:${conversationId}:${assetId}` : "")
      || (assetId ? `asset:${assetId}` : "")
      || genericImageKey(imageUrl);
    return { imageKey, assetId, conversationId };
  }

  function isImageishUrl(value) {
    if (!isHttpUrl(value)) return false;
    if (chatGptImageProxyInfo(value)) return true;
    const lower = value.toLowerCase();
    // Never treat ChatGPT UI static assets as generations.
    if (
      lower.includes("oaistatic")
      || lower.includes("sprite")
      || lower.includes("favicon")
      || lower.includes("emoji")
      || lower.includes("avatar")
      || lower.includes("logo")
      || lower.includes("/_next/")
    ) return false;
    return (
      lower.includes("oaiusercontent")
      || lower.includes("oaidalle")
      || lower.includes("files.oaiusercontent")
      || lower.includes("images.openai.com")
      || lower.includes("blob.core")
      || lower.includes("dalle")
      || lower.includes("generated")
    );
  }

  function cleanPrompt(text) {
    return String(text || "")
      .replace(/<\|has_watermark\|>/g, "")
      .replace(/\n?展开\s*$/g, "")
      .trim();
  }

  function canonicalPromptKey(key) {
    return PROMPT_KEY_ALIASES.get(String(key || "").toLowerCase()) || "";
  }

  const STRUCTURED_PROMPT_TEXT_KEYS = new Set([
    "text", "value", "content", "caption", "description",
    "instruction", "instructions",
  ]);

  function promptTextsFromValue(value, depth = 0, out = []) {
    if (depth > 8 || out.length >= 12 || value == null) return out;
    if (typeof value === "string") {
      const text = cleanPrompt(value);
      if (text && text.length <= 12000 && !looksLikeGenerationErrorText(text)) out.push(text);
      return out;
    }
    if (Array.isArray(value)) {
      for (const item of value) promptTextsFromValue(item, depth + 1, out);
      return out;
    }
    if (typeof value !== "object") return out;
    for (const [rawKey, child] of Object.entries(value)) {
      const key = String(rawKey || "").toLowerCase();
      if (canonicalPromptKey(key) || STRUCTURED_PROMPT_TEXT_KEYS.has(key)) {
        promptTextsFromValue(child, depth + 1, out);
      }
    }
    return out;
  }

  function uniquePromptTexts(value) {
    return [...new Set(promptTextsFromValue(value))];
  }

  function looksLikePrompt(text) {
    const t = cleanPrompt(text);
    if (t.length < 24 || t.length > 12000) return false;
    if (/^(ok|yes|no|thanks|继续|好的)\b/i.test(t) && t.length < 60) return false;
    return true;
  }

  function looksLikeGenerationErrorText(text) {
    const t = cleanPrompt(text);
    if (!t) return false;
    return /^(?:generation|image generation|image|request|tool|operation)\b.{0,80}\b(?:failed|failure|error|timed?\s*out|timeout|cancelled|canceled|aborted|blocked|rejected|stopped)\b/i.test(t)
      || /\b(?:failed|unable|could(?:n't| not))\s+to\s+(?:generate|create|render|produce)\b/i.test(t)
      || /\b(?:image|generation)\s+(?:service|request)\b.{0,80}\b(?:timed?\s*out|timeout|failed|error)\b/i.test(t)
      || /\bpartial result\b.{0,80}\b(?:visible|available|returned)\b/i.test(t)
      || /\bpolicy violation\b/i.test(t)
      || /(?:生成失败|生成图片时出错|生成时出错|生成错误|生成超时|已取消生成|取消生成|生成已中止|生成被阻止|未能生成|生成已停止|仅返回部分结果|部分结果仍可见)/.test(t);
  }

  function normalizeGenerationStatus(value) {
    const raw = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (!raw) return "unknown";
    if (/^(?:completed?|succeeded|success|done|finished|finished_successfully)$/.test(raw)) return "completed";
    if (/^(?:failed|failure|error|errored|rejected|timeout|timed_out)$/.test(raw)) return "failed";
    if (/^(?:cancelled|canceled|aborted|stopped)$/.test(raw)) return "cancelled";
    if (/^(?:partial|incomplete)$/.test(raw)) return "partial";
    if (/^(?:in_progress|running|generating|streaming|pending|queued)$/.test(raw)) return "in_progress";
    return "unknown";
  }

  function generationStatusFromObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
    for (const [key, child] of Object.entries(value)) {
      const lower = String(key).toLowerCase();
      if (GENERATION_STATUS_KEYS.has(lower) && typeof child === "string") {
        const status = normalizeGenerationStatus(child);
        if (status !== "unknown") return status;
      }
      if ((lower === "error" || lower === "failure") && child) return "failed";
    }
    return "unknown";
  }

  function generationStatusRank(status) {
    return ({ unknown: 0, in_progress: 1, partial: 2, failed: 3, cancelled: 3, completed: 4 })[status] || 0;
  }

  function preferGenerationStatus(current, candidate) {
    const next = normalizeGenerationStatus(candidate);
    return generationStatusRank(next) >= generationStatusRank(current) ? next : current;
  }

  function scorePrompt(text) {
    const t = cleanPrompt(text);
    if (!looksLikePrompt(t)) return 0;
    let score = Math.min(t.length, 2000) / 20;
    const keywords = [
      "poster", "illustration", "typography", "vector", "style", "lighting",
      "caption", "graphic", "layout", "city", "travel",
      "海报", "插画", "构图", "风格", "场景",
    ];
    for (const word of keywords) {
      if (t.toLowerCase().includes(word.toLowerCase())) score += 6;
    }
    if (/^model caption:/i.test(t)) score += 15;
    return score;
  }

  const CAPTION_STYLE_HINTS = [
    "poster", "illustration", "typography", "vector", "style", "lighting",
    "camera", "composition", "palette", "cinematic", "editorial", "scene",
    "caption", "graphic", "layout", "portrait", "background", "photo",
    "海报", "插画", "构图", "光影", "风格", "场景", "画面", "镜头",
  ];

  /** Reads like generation instructions rather than a chat reply. */
  function looksLikeGenerationCaption(text) {
    const t = cleanPrompt(text);
    if (t.length < 120) return false;
    const hits = CAPTION_STYLE_HINTS.filter((word) => t.toLowerCase().includes(word.toLowerCase()));
    return hits.length >= 2;
  }

  function promptPriority(key, { generationOwned = false } = {}) {
    const canonical = canonicalPromptKey(key);
    return ({
      revised_prompt: 700,
      generation_prompt: 650,
      image_prompt: 600,
      original_prompt: generationOwned ? 550 : 100,
      prompt: generationOwned ? 500 : 100,
      model_caption: 400,
      metadata_caption: 380,
      caption: 350,
      alt_text: 300,
    })[canonical] || 0;
  }

  function promptStatusForKey(key, { generationOwned = false } = {}) {
    const canonical = canonicalPromptKey(key);
    if (["revised_prompt", "generation_prompt", "image_prompt"].includes(canonical)) return "generation-tool-prompt";
    if (generationOwned && ["original_prompt", "prompt"].includes(canonical)) return "generation-tool-prompt";
    if (["metadata_caption", "caption", "model_caption", "alt_text"].includes(canonical)) return "visible-caption";
    return "user-message";
  }

  function isTrustedGenerationPromptKey(key, options = {}) {
    return promptStatusForKey(key, options) === "generation-tool-prompt";
  }

  function conversationIdFromLocation() {
    const match = location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/);
    return match ? match[1] : "";
  }

  function pickString(node, keys) {
    if (!node || typeof node !== "object") return "";
    for (const [key, value] of Object.entries(node)) {
      if (keys.has(String(key).toLowerCase()) && typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  }

  function trustedGenerationIdFromKnownContainers(value, depth = 0, out = new Set()) {
    if (!value || typeof value !== "object" || depth > 7 || out.size > 2) return out;
    if (Array.isArray(value)) {
      for (const item of value) trustedGenerationIdFromKnownContainers(item, depth + 1, out);
      return out;
    }
    for (const [rawKey, child] of Object.entries(value)) {
      const key = String(rawKey || "").toLowerCase();
      if ((key === "dalle" || key === "generation") && child && typeof child === "object" && !Array.isArray(child)) {
        const genId = typeof child.gen_id === "string" ? child.gen_id.trim() : "";
        if (genId) out.add(genId);
      }
      if (
        child && typeof child === "object"
        && ["message", "metadata", "content", "parts", "payload", "result", "output"].includes(key)
      ) {
        trustedGenerationIdFromKnownContainers(child, depth + 1, out);
      }
    }
    return out;
  }

  function trustedGenerationId(value) {
    const ids = [...trustedGenerationIdFromKnownContainers(value)];
    return ids.length === 1 ? ids[0] : "";
  }

  // ChatGPT sends each image tool call as an assistant "code" message whose
  // JSON arguments hold the Prompt the chat model wrote for the generator.
  // Only the live stream carries it; the stored conversation blanks it. It is
  // kept apart from the caption Prompt and never competes with it.
  const IMAGE_TOOL_ARGUMENT_KEYS = new Set([
    "aspect_ratio", "size", "n", "transparent_background",
    "reference_image_paths", "referenced_image_ids", "is_style_transfer",
  ]);
  const MAX_IMAGE_TOOL_CALLS = 64;
  const imageToolCalls = new Map();

  function rememberImageToolCall(message) {
    if (String(message?.author?.role || "").toLowerCase() !== "assistant") return;
    if (message?.content?.content_type !== "code" || typeof message.content.text !== "string") return;
    const callId = typeof message.id === "string" ? message.id : "";
    const args = parseStructuredJson(message.content.text);
    if (!callId || !args || Array.isArray(args)) return;
    // Async image turns call the generator with several batched requests and
    // no per-image identity. Only a single-entry batch names its image
    // unambiguously; a multi-entry batch must stay unnamed rather than be
    // matched to an image by position.
    let namedArgs = args;
    if (typeof args.prompt !== "string" && Array.isArray(args.batch_requests)) {
      const named = args.batch_requests.filter((entry) => entry && typeof entry.prompt === "string");
      if (named.length !== 1) return;
      namedArgs = named[0];
    }
    if (typeof namedArgs.prompt !== "string") return;
    const recipient = String(message.recipient || "");
    const imageTool = /(dall[-_.]?e|image[_ .-]?(gen|generation)|text2im|imagegen)/i.test(recipient)
      || Object.keys(namedArgs).some((key) => IMAGE_TOOL_ARGUMENT_KEYS.has(key));
    const prompt = cleanPrompt(namedArgs.prompt);
    if (!imageTool || !prompt || prompt.length > 12000) return;
    imageToolCalls.delete(callId);
    imageToolCalls.set(callId, {
      prompt,
      recipient,
      turnId: String(message.metadata?.turn_exchange_id || ""),
      generationCallIds: new Set(),
    });
    while (imageToolCalls.size > MAX_IMAGE_TOOL_CALLS) imageToolCalls.delete(imageToolCalls.keys().next().value);
  }

  // An image answers the call named by its parent_id or, failing that, the one
  // call of the same tool in its turn that no other generation has claimed.
  function requestPromptForOutput(message, generationCallId) {
    const toolName = String(message?.author?.name || "");
    const sameTool = (call) => !toolName || !call.recipient || call.recipient === toolName;
    const claim = (call) => {
      if (generationCallId) call.generationCallIds.add(generationCallId);
      return call.prompt;
    };
    const parent = imageToolCalls.get(String(message?.metadata?.parent_id || ""));
    if (parent && sameTool(parent)) return claim(parent);
    const turnId = String(message?.metadata?.turn_exchange_id || "");
    if (!turnId) return "";
    const calls = [...imageToolCalls.values()].filter((call) => call.turnId === turnId && sameTool(call));
    if (calls.length !== 1) return "";
    const [call] = calls;
    const claimedByOther = generationCallId
      ? [...call.generationCallIds].some((id) => id !== generationCallId)
      : call.generationCallIds.size > 0;
    return claimedByOther ? "" : claim(call);
  }

  function contextForNode(node, inherited = {}) {
    const message = node?.message && typeof node.message === "object" ? node.message : node;
    return {
      conversationId: pickString(node, CONVERSATION_ID_KEYS)
        || pickString(message, CONVERSATION_ID_KEYS)
        || inherited.conversationId
        || conversationIdFromLocation(),
      messageId: pickString(node, MESSAGE_ID_KEYS)
        || pickString(message, MESSAGE_ID_KEYS)
        || (typeof message?.id === "string" ? message.id : "")
        || inherited.messageId
        || "",
      responseId: pickString(node, RESPONSE_ID_KEYS)
        || pickString(message, RESPONSE_ID_KEYS)
        || inherited.responseId
        || "",
      generationCallId: pickString(node, GENERATION_CALL_ID_KEYS)
        || pickString(message, GENERATION_CALL_ID_KEYS)
        || trustedGenerationId(node)
        || trustedGenerationId(message)
        || inherited.generationCallId
        || "",
      generationOwnedContext: inherited.generationOwnedContext === true,
    };
  }

  function isMessageCarrier(node) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return false;
    const message = node.message && typeof node.message === "object" ? node.message : node;
    return Boolean(message?.content && (message?.id || message?.author || message?.metadata));
  }

  // A hidden image-tool return carries its Model caption next to the image,
  // while the very same image (same asset_pointer file id, same dalle gen_id)
  // is displayed inside a different, visible message — in async turns the
  // hidden messages exist only in the live stream. Keep caption candidates by
  // image identity so the message that displays the image without a prompt can
  // adopt the caption its generation already produced, in either arrival
  // order. Only candidates that passed visibleCaptionCandidate inside a
  // message owning the image are stored, and only under that image's own ids.
  const MAX_CAPTION_TRANSFERS = 256;
  const captionTransfers = new Map();

  function captionTransferKey(conversationId, imageId) {
    const conversation = String(conversationId || "").trim();
    const id = String(imageId || "").trim();
    return conversation && id ? `${conversation}\u0000${id}` : "";
  }

  function rememberCaptionForImage(conversationId, imageId, candidate) {
    const key = captionTransferKey(conversationId, imageId);
    if (!key || !candidate?.text) return;
    if (!captionTransfers.has(key)) {
      captionTransfers.set(key, candidate);
      while (captionTransfers.size > MAX_CAPTION_TRANSFERS) {
        captionTransfers.delete(captionTransfers.keys().next().value);
      }
    }
  }

  function rememberNativeCaption(conversationId, imageId, candidate) {
    // Only this message's own visible caption is transferable evidence; a
    // caption adopted from another message must not propagate further.
    if (candidate?.promptSource !== "message-visible-caption") return;
    rememberCaptionForImage(conversationId, imageId, candidate);
  }

  function transferredCaptionForImage(conversationId, ...imageIds) {
    for (const imageId of imageIds) {
      const key = captionTransferKey(conversationId, imageId);
      const candidate = key ? captionTransfers.get(key) : null;
      if (candidate) return candidate;
    }
    return null;
  }

  /** Emit a tightly bound pair. Empty prompt is allowed for an image-only event. */
  function emitPair(prompt, imageUrl, extra = {}) {
    const p = cleanPrompt(prompt);
    const url = isImageishUrl(imageUrl) ? imageUrl : "";
    const identity = imageIdentity(url || imageUrl, extra);
    if (!p && !url && !identity.imageKey) return;
    const payload = {
      prompt: p,
      promptScore: scorePrompt(p),
      imageUrl: url,
      imageKey: identity.imageKey,
      assetId: identity.assetId,
      conversationId: identity.conversationId,
      messageId: extra.messageId || "",
      generationContextId: extra.generationContextId || "",
      providerToolCallId: extra.providerToolCallId || "",
      providerGenerationCallId: extra.providerGenerationCallId || extra.generationCallId || "",
      providerResponseId: extra.providerResponseId || extra.responseId || "",
      generationRequestPrompt: extra.generationRequestPrompt || "",
      promptStatus: extra.promptStatus || (p ? "user-message" : "not-available"),
      promptSource: extra.promptSource || "",
      promptPriority: Number(extra.promptPriority) || 0,
      promptScope: extra.promptScope || (p && identity.imageKey ? "output" : p ? "attempt" : ""),
      generationStatus: normalizeGenerationStatus(extra.generationStatus),
      model: extra.model || "",
      capturedAt: new Date().toISOString(),
      via: extra.via || "network",
      bound: Boolean(p && identity.imageKey),
      // A CDN URL is not proof of generation: ChatGPT serves uploads through
      // the same asset path. Only a tool-owned generation prompt is evidence
      // that this exact asset is an output we may auto-archive.
      isGeneration: extra.isGeneration === true,
    };
    postDebug("emit", {
      via: payload.via,
      promptStatus: payload.promptStatus,
      promptSource: payload.promptSource,
      hasPrompt: Boolean(payload.prompt),
      hasAsset: Boolean(payload.assetId || payload.imageKey || payload.imageUrl),
      isGeneration: payload.isGeneration,
      hasMessageId: Boolean(payload.messageId),
      hasGenerationCallId: Boolean(payload.providerGenerationCallId),
      hasRequestPrompt: Boolean(payload.generationRequestPrompt),
    });
    post("generation-meta", payload);
    if (url && payload.isGeneration) post("auto-image", payload);
    // DEV-ONLY(128): remove before release. Feed the dev raw diagnostics
    // round tracker; the recorder decides per round whether a record is kept.
    if (devRawEnabled()) {
      try {
        devRaw.noteImage({
          conversationId: payload.conversationId,
          assistantMessageId: payload.messageId,
          fileId: payload.assetId,
          generationId: payload.providerGenerationCallId,
          promptStatus: payload.promptStatus,
          promptLength: typeof payload.prompt === "string" ? payload.prompt.length : 0,
          model: payload.model,
        });
      } catch {
        // diagnostics must never affect page hooks
      }
    }
  }
  function emitMessageBindings(node, inherited) {
    const message = node.message && typeof node.message === "object" ? node.message : node;
    // DEV-ONLY(128): remove before release. Remember the visible user message
    // of this conversation so the dev diagnostics rounds can open their
    // window 5 seconds before it was sent.
    if (devRawEnabled() && String(message?.author?.role || "").toLowerCase() === "user"
      && typeof message?.id === "string" && message.id) {
      try { devRaw.noteUserMessage(contextForNode(node, inherited).conversationId, message.id); } catch { /* ignore */ }
    }
    rememberImageToolCall(message);
    const context = contextForNode(node, inherited);
    const prompts = new Map();
    const assetIds = new Set();
    const imageUrls = new Set();
    const toolCallIds = new Set();
    const generationCallIds = new Set();
    let model = "";
    const toolMarker = [
      message?.author?.name,
      message?.recipient,
      message?.metadata?.tool_name,
      message?.metadata?.command,
      message?.metadata?.invoked_plugin?.namespace,
    ].filter(Boolean).join(" ");
    const imageParts = Array.isArray(message?.content?.parts) ? message.content.parts : [];
    const hasImageAssetPart = imageParts.some((part) => (
      part && typeof part === "object"
      && (part?.content_type === "image_asset_pointer" || normalizeAssetId(part?.asset_pointer || part?.assetPointer))
    ));
    const hasImageGenerationMetadata = Boolean(
      message?.metadata?.image_gen_title
      || message?.metadata?.imageGenTitle
      || message?.metadata?.image_generation_title
      || message?.metadata?.imageGenerationTitle
    );
    const generationToolMarker = /(dall[-_.]?e|image[_ .-]?(gen|generation)|text2im|imagegen)/i.test(toolMarker)
      || Boolean(
        message?.metadata?.dalle
        || message?.metadata?.image_gen
        || message?.metadata?.imageGen
        || message?.metadata?.image_generation
        || message?.metadata?.imageGeneration
        // Current ChatGPT tool names can be opaque. Generation provenance is
        // still explicit on the image part; uploads do not have this marker.
        || message?.content?.parts?.some((part) => (
          part?.content_type === "image_asset_pointer"
          && (part.metadata?.dalle?.gen_id || part.metadata?.generation?.gen_id)
        ))
        || (hasImageAssetPart && hasImageGenerationMetadata),
      );
    const authorRole = String(message?.author?.role || "").toLowerCase();
    const generationOwnedMessage = generationToolMarker && ["tool", "assistant"].includes(authorRole);
    const requestPrompt = generationOwnedMessage && hasImageAssetPart
      ? requestPromptForOutput(message, context.generationCallId)
      : "";
    if (hasImageAssetPart || generationToolMarker) {
      postDebug("message", {
        authorRole,
        generationOwned: generationOwnedMessage,
        hasImageAssetPart,
        hasImageGenerationMetadata,
        hasTrustedGenerationId: Boolean(context.generationCallId),
        keys: interestingFieldKeys(message),
        promptShapes: promptFieldShapes(message),
        opaqueSources: opaqueSourceShapes(message),
        schema: sanitizedSchema(message),
      });
    }

    function emitScopedGenerationUnits(root, messageCaption) {
      if (!generationOwnedMessage) return 0;
      const units = new Map();
      const toolDefaults = new Map();

      function promptCandidate(key, value) {
        const canonical = canonicalPromptKey(key);
        if (!canonical) return null;
        const texts = uniquePromptTexts(value);
        if (texts.length !== 1) return null;
        const [text] = texts;
        const priority = promptPriority(canonical, { generationOwned: true });
        const status = promptStatusForKey(canonical, { generationOwned: true });
        if (status !== "generation-tool-prompt" && !looksLikePrompt(text)) return null;
        return { text, priority, promptStatus: status, promptSource: canonical };
      }

      function selectPrompt(candidates) {
        if (!candidates?.length) return null;
        const ordered = [...candidates].sort((a, b) => b.priority - a.priority);
        const best = ordered[0];
        const tied = ordered.filter((item) => item.priority === best.priority && item.text !== best.text);
        return tied.length ? null : best;
      }

      function selectPromptGroups(groups) {
        const selected = (groups || []).map(selectPrompt).filter(Boolean);
        if (!selected.length) return null;
        const byText = new Map();
        for (const prompt of selected) {
          const current = byText.get(prompt.text);
          if (!current || prompt.priority > current.priority) byText.set(prompt.text, prompt);
        }
        // Different prompt-only sibling objects are different scopes until the
        // provider proves otherwise. This keeps collage/panel prompts from
        // competing by field priority for ownership of the whole output.
        if (byText.size !== 1) return null;
        return [...byText.values()][0];
      }

      function unitFor(toolCallId, generationCallId) {
        const key = generationCallId ? `generation:${generationCallId}` : toolCallId ? `tool:${toolCallId}` : "";
        if (!key) return null;
        if (!units.has(key)) {
          units.set(key, {
            toolCallId: toolCallId || "",
            generationCallId: generationCallId || "",
            sharedPromptGroups: [],
            outputs: new Map(),
            model: "",
            generationStatus: "unknown",
          });
        }
        const unit = units.get(key);
        if (toolCallId) unit.toolCallId = toolCallId;
        if (generationCallId) unit.generationCallId = generationCallId;
        return unit;
      }

      function toolDefault(toolCallId) {
        if (!toolCallId) return null;
        if (!toolDefaults.has(toolCallId)) {
          toolDefaults.set(toolCallId, { promptGroups: [], model: "", generationStatus: "unknown" });
        }
        return toolDefaults.get(toolCallId);
      }

      function outputFor(unit, assetId, imageUrl) {
        if (!unit || (!assetId && !imageUrl)) return null;
        const proxy = imageUrl ? chatGptImageProxyInfo(imageUrl) : null;
        const resolvedAssetId = assetId || proxy?.assetId || "";
        const key = resolvedAssetId ? `asset:${resolvedAssetId}` : `url:${genericImageKey(imageUrl) || imageUrl}`;
        if (!unit.outputs.has(key)) {
          unit.outputs.set(key, {
            assetId: resolvedAssetId,
            imageUrl: imageUrl || "",
            prompts: [],
            generationStatus: "unknown",
          });
        }
        const output = unit.outputs.get(key);
        if (resolvedAssetId) output.assetId = resolvedAssetId;
        if (imageUrl && !output.imageUrl) output.imageUrl = imageUrl;
        return output;
      }

      const visit = (value, inheritedIds = {}, depth = 0) => {
        if (!value || depth > 14 || typeof value !== "object") return;
        if (Array.isArray(value)) {
          for (const item of value) visit(item, inheritedIds, depth + 1);
          return;
        }

        let toolCallId = inheritedIds.toolCallId || "";
        let generationCallId = inheritedIds.generationCallId || "";
        for (const [key, child] of Object.entries(value)) {
          const lower = String(key).toLowerCase();
          if (TOOL_CALL_ID_KEYS.has(lower) && typeof child === "string" && child.trim()) toolCallId = child.trim();
          if (GENERATION_CALL_ID_KEYS.has(lower) && typeof child === "string" && child.trim()) generationCallId = child.trim();
        }

        const unit = unitFor(toolCallId, generationCallId);
        const defaults = toolDefault(toolCallId);
        const localPrompts = [];
        const localAssets = [];
        const localUrls = [];
        let localModel = "";
        let localStatus = generationStatusFromObject(value);

        for (const [key, child] of Object.entries(value)) {
          const lower = String(key).toLowerCase();
          const prompt = promptCandidate(lower, child);
          if (prompt) localPrompts.push(prompt);
          if (ASSET_REFERENCE_KEYS.has(lower) && typeof child === "string") {
            const assetId = normalizeAssetId(child);
            if (assetId) localAssets.push(assetId);
          }
          if ((URL_KEYS.has(lower) || typeof child === "string") && isImageishUrl(child)) localUrls.push(child);
          if ((lower === "model" || lower === "model_slug") && typeof child === "string" && child.trim()) localModel = child.trim();
          if ((lower === "error" || lower === "failure") && child) localStatus = "failed";
          if (STRUCTURED_JSON_KEYS.has(lower)) {
            const parsed = parseStructuredJson(child);
            if (parsed) visit(parsed, { toolCallId, generationCallId }, depth + 1);
          }
        }

        if (unit) {
          if (localModel) unit.model = localModel;
          unit.generationStatus = preferGenerationStatus(unit.generationStatus, localStatus);

          const uniqueAssets = [...new Set(localAssets)];
          const uniqueUrls = [...new Set(localUrls)];
          const localOutputCount = uniqueAssets.length || uniqueUrls.length;

          if (uniqueAssets.length === 1) {
            const output = outputFor(unit, uniqueAssets[0], uniqueUrls[0] || "");
            output.generationStatus = preferGenerationStatus(output.generationStatus, localStatus);
            if (localPrompts.length) output.prompts.push(...localPrompts);
            for (const extraUrl of uniqueUrls.slice(1)) outputFor(unit, uniqueAssets[0], extraUrl);
          } else if (uniqueAssets.length > 1) {
            for (const assetId of uniqueAssets) {
              const output = outputFor(unit, assetId, "");
              output.generationStatus = preferGenerationStatus(output.generationStatus, localStatus);
            }
            if (localPrompts.length) unit.sharedPromptGroups.push(localPrompts);
          } else if (uniqueUrls.length === 1) {
            const output = outputFor(unit, "", uniqueUrls[0]);
            output.generationStatus = preferGenerationStatus(output.generationStatus, localStatus);
            if (localPrompts.length) output.prompts.push(...localPrompts);
          } else if (uniqueUrls.length > 1) {
            for (const imageUrl of uniqueUrls) {
              const output = outputFor(unit, "", imageUrl);
              output.generationStatus = preferGenerationStatus(output.generationStatus, localStatus);
            }
            if (localPrompts.length) unit.sharedPromptGroups.push(localPrompts);
          } else if (localPrompts.length) {
            unit.sharedPromptGroups.push(localPrompts);
          }

          if (!generationCallId && defaults) {
            if (localPrompts.length && !localOutputCount) defaults.promptGroups.push(localPrompts);
            if (localModel) defaults.model = localModel;
            defaults.generationStatus = preferGenerationStatus(defaults.generationStatus, localStatus);
          }
        }

        const nextIds = { toolCallId, generationCallId };
        for (const child of Object.values(value)) {
          if (child && typeof child === "object") visit(child, nextIds, depth + 1);
        }
      };

      visit(root, { generationCallId: context.generationCallId || "" });
      const explicitGenerationCounts = new Map();
      for (const unit of units.values()) {
        if (!unit.toolCallId || !unit.generationCallId) continue;
        explicitGenerationCounts.set(unit.toolCallId, (explicitGenerationCounts.get(unit.toolCallId) || 0) + 1);
      }
      const explicitGenerationUnitCount = [...units.values()].filter((unit) => unit.generationCallId).length;
      const outputUnitCount = [...units.values()].filter((unit) => unit.outputs.size > 0).length;
      const visibleMessageFailure = (message?.content?.parts || []).some((part) => (
        typeof part === "string" && looksLikeGenerationErrorText(part)
      ));
      let emitted = 0;
      for (const unit of units.values()) {
        const defaults = toolDefaults.get(unit.toolCallId) || null;
        const explicitGenerationCount = explicitGenerationCounts.get(unit.toolCallId) || 0;
        const canInheritToolDefaults = !unit.generationCallId || explicitGenerationCount <= 1;
        // A message caption describes this message's image only when a single
        // generation unit owns the message's outputs.
        const captionFallback = outputUnitCount === 1 && unit.outputs.size ? messageCaption : null;
        const sharedPrompt = selectPromptGroups(unit.sharedPromptGroups)
          || (canInheritToolDefaults ? selectPromptGroups(defaults?.promptGroups || []) : null)
          || captionFallback;
        const model = unit.model || defaults?.model || "";
        let unitStatus = canInheritToolDefaults
          ? preferGenerationStatus(unit.generationStatus, defaults?.generationStatus || "unknown")
          : unit.generationStatus;
        if (visibleMessageFailure && explicitGenerationUnitCount <= 1 && outputUnitCount === 1 && unit.outputs.size) {
          unitStatus = preferGenerationStatus(unitStatus, "failed");
        }
        const attemptScope = unit.generationCallId || unit.toolCallId;
        const generationContextId = context.conversationId && attemptScope
          ? `chatgpt:${context.conversationId}:${attemptScope}`
          : attemptScope ? `chatgpt:${attemptScope}` : "";

        for (const output of unit.outputs.values()) {
          const outputPrompt = selectPrompt(output.prompts);
          const transferred = outputPrompt || sharedPrompt
            ? null
            : transferredCaptionForImage(context.conversationId, output.assetId, unit.generationCallId);
          const selected = outputPrompt || sharedPrompt || transferred;
          const outputScoped = Boolean(outputPrompt)
            || (selected === captionFallback && unit.outputs.size === 1)
            || Boolean(transferred);
          emitPair(selected?.text || "", output.imageUrl, {
            assetId: output.assetId,
            conversationId: context.conversationId,
            messageId: context.messageId,
            generationContextId,
            providerToolCallId: unit.toolCallId,
            providerGenerationCallId: unit.generationCallId,
            providerResponseId: context.responseId,
            promptStatus: selected?.promptStatus || "not-available",
            promptSource: selected?.promptSource || "",
            promptPriority: selected?.priority || 0,
            promptScope: outputScoped ? "output" : selected ? "attempt" : "",
            generationStatus: output.generationStatus !== "unknown" ? output.generationStatus : unitStatus,
            model,
            generationRequestPrompt: requestPrompt,
            via: "message-generation-unit",
            isGeneration: true,
          });
          rememberNativeCaption(context.conversationId, output.assetId, selected);
          rememberNativeCaption(context.conversationId, unit.generationCallId, selected);
          emitted += 1;
        }

        const shadowedByExplicitGeneration = !unit.generationCallId && explicitGenerationCount > 0;
        if (!unit.outputs.size && sharedPrompt && !shadowedByExplicitGeneration) {
          emitPair(sharedPrompt.text, "", {
            conversationId: context.conversationId,
            messageId: context.messageId,
            generationContextId,
            providerToolCallId: unit.toolCallId,
            providerGenerationCallId: unit.generationCallId,
            providerResponseId: context.responseId,
            promptStatus: sharedPrompt.promptStatus,
            promptSource: sharedPrompt.promptSource,
            promptPriority: sharedPrompt.priority,
            promptScope: "attempt",
            generationStatus: unitStatus,
            model,
            via: "message-generation-attempt",
            isGeneration: true,
          });
          emitted += 1;
        }
      }
      return emitted;
    }

    // The live image tool message carries its caption as a plain string next
    // to the image in content.parts. Generation units only walk nested
    // objects, so a unit without its own prompt takes the one message caption.
    const messageCaption = (() => {
      const captions = new Map();
      for (const part of message?.content?.parts || []) {
        if (typeof part !== "string") continue;
        const candidate = visibleCaptionCandidate(part, {
          hasImageAsset: hasImageAssetPart,
          authorRole,
          generationOwned: generationOwnedMessage,
        });
        if (candidate && !captions.has(candidate.text)) captions.set(candidate.text, candidate);
      }
      const ordered = [...captions.values()].sort((a, b) => b.priority - a.priority);
      const tied = ordered.filter((item) => item.priority === ordered[0]?.priority);
      return tied.length === 1 ? tied[0] : null;
    })();

    const emittedNestedUnits = emitScopedGenerationUnits(message, messageCaption);
    if (emittedNestedUnits > 0) return;

    function rememberPrompt(key, value) {
      const canonical = canonicalPromptKey(key);
      if (!canonical) return;
      const priority = promptPriority(canonical, { generationOwned: generationOwnedMessage });
      const status = promptStatusForKey(canonical, { generationOwned: generationOwnedMessage });
      for (const text of uniquePromptTexts(value)) {
        if (!isTrustedGenerationPromptKey(canonical, { generationOwned: generationOwnedMessage }) && !looksLikePrompt(text)) continue;
        const current = prompts.get(text);
        if (!current || priority > current.priority) {
          prompts.set(text, {
            text,
            priority,
            promptStatus: status,
            promptSource: canonical,
          });
        }
      }
    }

    // ChatGPT's image tool has left dalle.prompt blank while the same tool
    // message exposed the caption as a plain string in content.parts. The
    // "Model caption:" marker is OpenAI wording that has changed before, so an
    // unmarked caption is accepted too — but only inside a tool message that
    // owns the image, which is where a caption lives and chat prose does not.
    // A caption is provider output: users paste old "Model caption:" text into
    // their own messages, and other tool text in the same turn (for example a
    // Skill's instructions) is not a description of the image.
    function visibleCaptionCandidate(value, { hasImageAsset, authorRole, generationOwned }) {
      const text = cleanPrompt(value);
      if (!text || text.length > 12000 || looksLikeGenerationErrorText(text)) return null;
      if (!["tool", "assistant"].includes(authorRole)) return null;
      const markedCaption = /^model caption\s*:/i.test(text);
      if (!markedCaption) {
        if (!hasImageAsset) return null;
        if (authorRole === "assistant" && !generationOwned) return null;
        if (authorRole === "tool" && !generationOwned && !looksLikeGenerationCaption(text)) return null;
        if (/^(?:image generated|generated image|done|completed|success|已生成|生成完成|完成)[.!。！]?$/i.test(text)) return null;
      } else if (!looksLikePrompt(text)) {
        return null;
      }
      return {
        text,
        priority: markedCaption ? 425 : 325,
        promptStatus: "visible-caption",
        promptSource: "message-visible-caption",
      };
    }

    function rememberVisibleCaption(value, captionContext) {
      const candidate = visibleCaptionCandidate(value, captionContext);
      if (!candidate) return;
      const current = prompts.get(candidate.text);
      if (!current || candidate.priority > current.priority) prompts.set(candidate.text, candidate);
    }

    let messageGenerationStatus = generationStatusFromObject(message);
    function scan(value, depth = 0) {
      if (!value || depth > 14 || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) scan(item, depth + 1);
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        const lower = String(key).toLowerCase();
        if (GENERATION_STATUS_KEYS.has(lower) && typeof child === "string") {
          messageGenerationStatus = preferGenerationStatus(messageGenerationStatus, child);
        }
        if ((lower === "error" || lower === "failure") && child) {
          messageGenerationStatus = preferGenerationStatus(messageGenerationStatus, "failed");
        }
        rememberPrompt(lower, child);
        if (ASSET_REFERENCE_KEYS.has(lower) && typeof child === "string") {
          const assetId = normalizeAssetId(child);
          if (assetId) assetIds.add(assetId);
        }
        if (TOOL_CALL_ID_KEYS.has(lower) && typeof child === "string" && child.trim()) {
          toolCallIds.add(child.trim());
        }
        if (GENERATION_CALL_ID_KEYS.has(lower) && typeof child === "string" && child.trim()) {
          generationCallIds.add(child.trim());
        }
        if ((URL_KEYS.has(lower) || typeof child === "string") && isImageishUrl(child)) imageUrls.add(child);
        if ((lower === "model" || lower === "model_slug") && typeof child === "string" && child.trim()) model = child.trim();
        if (child && typeof child === "object") scan(child, depth + 1);
      }
    }

    scan(message);
    const captionContext = {
      hasImageAsset: assetIds.size > 0 || imageUrls.size > 0,
      authorRole,
      generationOwned: generationOwnedMessage,
    };
    for (const part of message?.content?.parts || []) {
      if (typeof part === "string") {
        if (looksLikeGenerationErrorText(part)) {
          messageGenerationStatus = preferGenerationStatus(messageGenerationStatus, "failed");
        }
        rememberVisibleCaption(part, captionContext);
      }
    }
    const orderedPrompts = [...prompts.values()].sort((a, b) => b.priority - a.priority);
    const selected = orderedPrompts[0];
    const equallyPreferred = selected ? orderedPrompts.filter((item) => item.priority === selected.priority) : [];
    const toolOwnedGeneration = captionContext.hasImageAsset
      && generationToolMarker
      && ["tool", "assistant"].includes(captionContext.authorRole);
    // Prompt availability and generation provenance are separate facts. A
    // tool-owned image remains safe to archive even when ChatGPT omits the
    // caption; a later metadata event can upgrade the prompt by image hash.
    const usablePrompt = selected && equallyPreferred.length === 1 ? selected : null;
    if (!usablePrompt && !toolOwnedGeneration) return;

    const onlyAssetId = assetIds.size === 1 ? [...assetIds][0] : "";
    const onlyToolCallId = toolCallIds.size === 1 ? [...toolCallIds][0] : "";
    const onlyGenerationCallId = generationCallIds.size === 1
      ? [...generationCallIds][0]
      : (!generationCallIds.size ? context.generationCallId : "");
    const ambiguousToolCalls = toolCallIds.size > 1;
    // If multiple image calls were flattened into one message, keep generation
    // provenance but do not assign one ambiguous prompt to every output.
    const boundPrompt = ambiguousToolCalls ? null : usablePrompt;
    // URL events and asset events for one generation must carry the same
    // reference-linking scope. A single tool call or a single asset covers the
    // whole message; several assets without one shared call id are distinct
    // generations, and each output keeps its own scope so references of one
    // generation never attach to a sibling output.
    const sharedScopeId = onlyToolCallId
      || (assetIds.size <= 1 && !ambiguousToolCalls ? context.messageId : "");
    const scopeForAsset = (assetId) => sharedScopeId || `asset:${assetId}`;
    const scopeForUrl = (imageUrl) => {
      if (sharedScopeId) return sharedScopeId;
      const proxy = chatGptImageProxyInfo(imageUrl);
      return proxy?.assetId && assetIds.has(proxy.assetId) ? `asset:${proxy.assetId}` : "";
    };
    const contextIdFor = (scopeId) => (
      context.conversationId && scopeId
        ? `chatgpt:${context.conversationId}:${scopeId}`
        : scopeId ? `chatgpt:${scopeId}` : ""
    );
    for (const imageUrl of imageUrls) {
      emitPair(boundPrompt?.text || "", imageUrl, {
        assetId: onlyAssetId,
        conversationId: context.conversationId,
        messageId: context.messageId,
        generationContextId: contextIdFor(scopeForUrl(imageUrl)),
        providerToolCallId: onlyToolCallId,
        providerGenerationCallId: onlyGenerationCallId,
        providerResponseId: context.responseId,
        promptStatus: boundPrompt?.promptStatus || "not-available",
        promptSource: boundPrompt?.promptSource || "",
        promptPriority: boundPrompt?.priority || 0,
        promptScope: boundPrompt ? (assetIds.size + imageUrls.size > 1 ? "attempt" : "output") : "",
        generationStatus: messageGenerationStatus,
        model,
        generationRequestPrompt: requestPrompt,
        via: "message-metadata-url",
        isGeneration: toolOwnedGeneration || boundPrompt?.promptStatus === "generation-tool-prompt" || boundPrompt?.promptStatus === "visible-caption",
      });
    }
    for (const assetId of assetIds) {
      const transferred = boundPrompt ? null
        : transferredCaptionForImage(context.conversationId, assetId, onlyGenerationCallId);
      const caption = transferred || boundPrompt;
      emitPair(caption?.text || "", "", {
        assetId,
        conversationId: context.conversationId,
        messageId: context.messageId,
        generationContextId: contextIdFor(scopeForAsset(assetId)),
        providerToolCallId: onlyToolCallId,
        providerGenerationCallId: onlyGenerationCallId,
        providerResponseId: context.responseId,
        promptStatus: caption?.promptStatus || "not-available",
        promptSource: caption?.promptSource || "",
        promptPriority: caption?.priority || 0,
        promptScope: transferred ? "output" : boundPrompt ? (assetIds.size + imageUrls.size > 1 ? "attempt" : "output") : "",
        generationStatus: messageGenerationStatus,
        model,
        generationRequestPrompt: requestPrompt,
        via: "message-metadata-asset",
        isGeneration: toolOwnedGeneration || caption?.promptStatus === "generation-tool-prompt" || caption?.promptStatus === "visible-caption",
      });
      rememberNativeCaption(context.conversationId, assetId, boundPrompt);
    }
    rememberNativeCaption(context.conversationId, onlyGenerationCallId, boundPrompt);
    if (boundPrompt && !imageUrls.size && !assetIds.size) {
      emitPair(boundPrompt.text, "", {
        conversationId: context.conversationId,
        messageId: context.messageId,
        providerGenerationCallId: onlyGenerationCallId,
        providerResponseId: context.responseId,
        promptStatus: boundPrompt.promptStatus,
        promptSource: boundPrompt.promptSource || "",
        promptPriority: boundPrompt.priority || 0,
        promptScope: "attempt",
        generationStatus: messageGenerationStatus,
        model,
        via: "message-prompt-only",
      });
    }
  }

  /** Walk objects without sharing prompt data across sibling message nodes. */
  function walkObject(node, inherited = {}, depth = 0) {
    if (!node || depth > 18) return;
    if (typeof node === "string") return;
    if (typeof node !== "object") return;

    if (Array.isArray(node)) {
      for (const item of node) walkObject(item, inherited, depth + 1);
      return;
    }

    const context = contextForNode(node, inherited);
    if (isMessageCarrier(node)) {
      emitMessageBindings(node, context);
      return;
    }

    let localPrompt = "";
    let localPromptStatus = "not-available";
    let localPromptPriority = 0;
    let localPromptSource = "";
    let localUrl = "";
    let localAssetId = "";
    let localModel = "";
    let localGenerationStatus = generationStatusFromObject(node);

    for (const [key, value] of Object.entries(node)) {
      const lower = String(key).toLowerCase();
      const canonical = canonicalPromptKey(lower);
      if (canonical) {
        const promptOptions = { generationOwned: context.generationOwnedContext === true };
        const status = promptStatusForKey(canonical, promptOptions);
        const priority = promptPriority(canonical, promptOptions);
        const texts = uniquePromptTexts(value);
        const text = texts.length === 1 ? texts[0] : "";
        if (text && (status === "generation-tool-prompt" || looksLikePrompt(text)) && priority >= localPromptPriority) {
          localPrompt = text;
          localPromptStatus = status;
          localPromptPriority = priority;
          localPromptSource = canonical;
        }
      } else if ((lower === "error" || lower === "failure") && value) {
        localGenerationStatus = preferGenerationStatus(localGenerationStatus, "failed");
      } else if ((lower === "model" || lower === "model_slug") && typeof value === "string") {
        localModel = value;
      } else if (URL_KEYS.has(lower) && isImageishUrl(value)) {
        localUrl = value;
      } else if (ASSET_REFERENCE_KEYS.has(lower) && typeof value === "string") {
        localAssetId = normalizeAssetId(value);
      } else if (STRUCTURED_JSON_KEYS.has(lower)) {
        if (value && typeof value === "object") {
          walkObject(value, context, depth + 1);
        } else {
          const parsed = parseStructuredJson(value);
          if (parsed) walkObject(parsed, context, depth + 1);
        }
      } else if (value && typeof value === "object") {
        const directGenId = (
          (lower === "generation" || lower === "dalle")
          && !Array.isArray(value)
          && typeof value.gen_id === "string"
        ) ? value.gen_id.trim() : "";
        walkObject(value, directGenId ? {
          ...context,
          generationCallId: directGenId,
          generationOwnedContext: true,
        } : context, depth + 1);
      }
    }

    const localGenerationEvidence = localPromptStatus === "generation-tool-prompt" || Boolean(context.generationCallId);
    if (localPrompt) {
      postDebug("prompt-signal", {
        promptStatus: localPromptStatus,
        promptSource: localPromptSource,
        hasMessageId: Boolean(context.messageId),
        hasGenerationCallId: Boolean(context.generationCallId),
        hasAsset: Boolean(localAssetId || localUrl),
        isGeneration: localGenerationEvidence,
      });
    }

    if (localPrompt && localUrl) {
      emitPair(localPrompt, localUrl, {
        ...context,
        model: localModel,
        promptStatus: localPromptStatus,
        promptSource: localPromptSource,
        promptPriority: localPromptPriority,
        promptScope: "output",
        generationStatus: localGenerationStatus,
        via: "same-object",
        isGeneration: localGenerationEvidence,
      });
      return;
    }
    if (localPrompt && localAssetId) {
      emitPair(localPrompt, "", {
        ...context,
        assetId: localAssetId,
        model: localModel,
        promptStatus: localPromptStatus,
        promptSource: localPromptSource,
        promptPriority: localPromptPriority,
        promptScope: "output",
        generationStatus: localGenerationStatus,
        via: "same-object-asset",
        isGeneration: localGenerationEvidence,
      });
      return;
    }
    if (localUrl) {
      emitPair("", localUrl, { ...context, model: localModel, generationStatus: localGenerationStatus, via: "url-only", isGeneration: localGenerationEvidence });
    } else if (localAssetId && localGenerationEvidence) {
      emitPair("", "", { ...context, assetId: localAssetId, model: localModel, generationStatus: localGenerationStatus, via: "asset-only", isGeneration: true });
    }
    if (localPrompt && !localUrl && !localAssetId) {
      emitPair(localPrompt, "", {
        ...context,
        model: localModel,
        promptStatus: localPromptStatus,
        promptSource: localPromptSource,
        promptPriority: localPromptPriority,
        promptScope: "attempt",
        generationStatus: localGenerationStatus,
        via: "prompt-only",
        isGeneration: localGenerationEvidence,
      });
    }
  }

  function harvest(text, via) {
    if (!text || text.length < 20) return;
    const maxHarvestBytes = via === "conversation-refresh" ? 32_000_000 : 12_000_000;
    if (text.length > maxHarvestBytes) {
      post("harvest-skipped", { reason: "payload-too-large", size: text.length, via });
      return;
    }
    // Only enter the SSE parser when the payload actually contains an SSE
    // data record. Ordinary conversation JSON may contain the substring
    // "data:" inside prompts, code blocks, captions, or data URLs; treating
    // that as SSE used to skip JSON.parse() for the whole conversation.
    if (/^\s*data:/m.test(text)) {
      let parsedEvent = false;
      for (const line of text.split(/\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          walkObject(JSON.parse(payload), { conversationId: conversationIdFromLocation() });
          parsedEvent = true;
        } catch {
          // ignore
        }
      }
      if (parsedEvent) return;
    }
    try {
      walkObject(JSON.parse(text), { conversationId: conversationIdFromLocation() });
    } catch {
      const urls = text.match(/https?:\/\/[^\s"'\\]+/g) || [];
      for (const url of urls) {
        const cleaned = url.replace(/[),;]+$/, "");
        if (isImageishUrl(cleaned)) emitPair("", cleaned, { via: via + "-urlscan" });
      }
    }
  }

  // ---- Live SSE streams (POST /backend-api/f/conversation) ----
  //
  // ChatGPT pushes some replies (for example GPT-5.6 Thinking image turns)
  // through a streaming fetch response instead of the WebSocket, and aborts
  // that request right after `data: [DONE]`. A buffered clone.text() read used
  // to die with an AbortError and lose the whole turn. These helpers consume
  // the clone incrementally and rebuild messages from the "delta encoding v1"
  // patch stream while it arrives, so an interruption keeps everything the
  // stream already delivered.

  const SSE_STREAM_MAX_CHARS = 12_000_000; // same ceiling as harvest()'s buffered payloads

  function conversationStreamPathname(value) {
    try {
      const path = new URL(String(value || ""), location.origin).pathname.toLowerCase();
      return path === "/backend-api/conversation" || path === "/backend-api/f/conversation" ? path : "";
    } catch {
      return "";
    }
  }

  function createSseStreamHarvester(via, requestMeta = null) {
    // Per-stream reconstruction state; concurrent streams never share it.
    const state = {
      currentMessage: null,
      conversationId: "",
      lastPatchPath: "",
      pendingEmit: false,
      completedEmitted: false,
      decodedChars: 0,
      sawDataLine: false,
      skipped: false,
      text: "",
      buffer: "",
    };

    function emitCurrentMessage() {
      if (!state.pendingEmit || !state.currentMessage) return;
      state.pendingEmit = false;
      walkObject({ message: state.currentMessage }, {
        conversationId: state.conversationId || conversationIdFromLocation(),
      });
    }

    function handleAdd(value) {
      const message = value?.message;
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      // A stream may move on to the next message without a completion patch;
      // flush the previous one so its rebuilt content is still bound.
      emitCurrentMessage();
      state.currentMessage = message;
      if (typeof value.conversation_id === "string" && value.conversation_id) {
        state.conversationId = value.conversation_id;
      }
      state.lastPatchPath = "";
      state.pendingEmit = true;
      state.completedEmitted = message.status === "finished_successfully";
      emitCurrentMessage();
    }

    function isIndexSegment(segment) {
      return /^(?:0|[1-9]\d*)$/.test(segment);
    }

    // Resolve the parent container of a /message/... patch path inside the
    // current message. Missing containers are created so an append has
    // somewhere to land; a scalar already sitting on the path means the patch
    // does not fit and is ignored.
    function targetForPath(path) {
      if (!state.currentMessage || typeof state.currentMessage !== "object") return null;
      const segments = String(path || "").split("/").filter((segment) => segment !== "");
      if (segments[0] !== "message" || segments.length < 2) return null;
      let container = state.currentMessage;
      for (let index = 1; index < segments.length - 1; index += 1) {
        const segment = segments[index];
        const next = segments[index + 1];
        let position = -1;
        let child;
        if (Array.isArray(container)) {
          if (!isIndexSegment(segment)) return null;
          position = Number(segment);
          if (position >= container.length) return null;
          child = container[position];
        } else if (container && typeof container === "object") {
          child = container[segment];
        } else {
          return null;
        }
        if (child === undefined || child === null) {
          child = isIndexSegment(next) ? [] : {};
          if (position >= 0) container[position] = child;
          else container[segment] = child;
        } else if (typeof child !== "object") {
          return null;
        }
        container = child;
      }
      const last = segments[segments.length - 1];
      if (Array.isArray(container)) {
        return isIndexSegment(last) ? { container, key: Number(last) } : null;
      }
      return container && typeof container === "object" ? { container, key: last } : null;
    }

    function mergeDeltaObject(target, patch) {
      let changed = false;
      for (const [key, value] of Object.entries(patch)) {
        const current = target[key];
        if (
          value && typeof value === "object" && !Array.isArray(value)
          && current && typeof current === "object" && !Array.isArray(current)
        ) {
          if (mergeDeltaObject(current, value)) changed = true;
        } else if (current !== value) {
          target[key] = value;
          changed = true;
        }
      }
      return changed;
    }

    function appendAtPath(path, value) {
      if (value === undefined) return false;
      const target = targetForPath(path);
      if (!target) return false;
      const { container, key } = target;
      if (Array.isArray(container) && key > container.length) return false;
      const current = container[key];
      if (typeof current === "string" && typeof value === "string") {
        if (!value) return false;
        container[key] = current + value;
        return true;
      }
      if (current === undefined || current === null) {
        container[key] = value;
        return true;
      }
      if (
        current && typeof current === "object" && !Array.isArray(current)
        && value && typeof value === "object" && !Array.isArray(value)
      ) {
        return mergeDeltaObject(current, value);
      }
      return false;
    }

    function replaceAtPath(path, value) {
      const target = targetForPath(path);
      if (!target) return false;
      const { container, key } = target;
      if (Array.isArray(container) && key > container.length) return false;
      if (container[key] === value) return false;
      container[key] = value;
      return true;
    }

    // One patch operation. Unknown operations and paths are ignored so the
    // events after them still apply.
    function applyPatchOp(op) {
      if (!op || typeof op !== "object" || Array.isArray(op) || !Object.hasOwn(op, "v")) return false;
      const rawPath = typeof op.p === "string" && op.p ? op.p : "";
      if (!rawPath) {
        // {"v":"..."} continues appending to the previous patch path.
        return typeof op.v === "string" && state.lastPatchPath
          ? appendAtPath(state.lastPatchPath, op.v)
          : false;
      }
      state.lastPatchPath = rawPath;
      const operation = typeof op.o === "string" && op.o ? op.o.toLowerCase() : "replace";
      if (operation === "append") return appendAtPath(rawPath, op.v);
      if (operation === "replace") return replaceAtPath(rawPath, op.v);
      return false;
    }

    // Patches must not re-bind per token: content changes only arm the flush,
    // which fires when the message completes or the stream ends.
    function afterPatches(changed) {
      if (!changed) return;
      state.pendingEmit = true;
      if (state.completedEmitted) return;
      if (state.currentMessage?.status === "finished_successfully") {
        state.completedEmitted = true;
        emitCurrentMessage();
      }
    }

    function handleStreamPayload(payload) {
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return; // e.g. data: "v1"
      const value = parsed.v;
      // Message add: {"p":"","o":"add","v":{"message":...}} (o may be omitted).
      if (
        value && typeof value === "object" && !Array.isArray(value)
        && value.message && typeof value.message === "object" && !Array.isArray(value.message)
      ) {
        handleAdd(value);
        return;
      }
      // Batch patch: {"v":[{p,o,v},...]} (also seen as {"o":"patch","v":[...]}).
      if (Array.isArray(value)) {
        let changed = false;
        for (const op of value) {
          if (applyPatchOp(op)) changed = true;
        }
        afterPatches(changed);
        return;
      }
      // Single patch: {"p":"/message/...","o":"append|replace","v":...}.
      if (typeof parsed.p === "string" && parsed.p) {
        afterPatches(applyPatchOp(parsed));
        return;
      }
      // Bare {"v":"..."} continues appending to the previous patch path.
      if (typeof value === "string" && !("p" in parsed) && !("o" in parsed) && state.lastPatchPath) {
        afterPatches(applyPatchOp({ v: value }));
        return;
      }
      if (parsed.type === "message_stream_complete") emitCurrentMessage();
      // Plain objects (input_message, message_marker, resume tokens, ...) keep
      // the ordinary buffered-path treatment.
      walkObject(parsed, { conversationId: conversationIdFromLocation() });
    }

    function processDataLine(line) {
      const payload = line.slice(5).trim();
      if (!payload) return;
      state.sawDataLine = true;
      if (payload === "[DONE]") {
        // The page aborts the request right after this marker; bind whatever
        // the stream has rebuilt so far.
        emitCurrentMessage();
        return;
      }
      handleStreamPayload(payload);
    }

    function processEventBlock(block) {
      for (const line of String(block || "").split("\n")) {
        const trimmed = line.trim();
        // DEV-ONLY(128): remove before release. Every raw SSE line of this
        // stream (event: and data: alike) lands in the dev buffer, masked.
        if (line) devRawRecordSseLine(requestMeta?.method, requestMeta?.url, line);
        // event: / id: / retry: lines and comments carry no payload. Old
        // (non-delta) streams put one complete object per data line; handling
        // each data line on its own keeps them working unchanged.
        if (trimmed.startsWith("data:")) processDataLine(trimmed);
      }
    }

    function push(chunk) {
      if (state.skipped) return false;
      if (!state.sawDataLine) state.text += chunk;
      state.decodedChars += chunk.length;
      if (state.decodedChars > SSE_STREAM_MAX_CHARS) {
        state.skipped = true;
        post("harvest-skipped", { reason: "payload-too-large", size: state.decodedChars, via });
        return false;
      }
      // A separator is at most 4 characters (\r\n\r\n) and every earlier one
      // is already processed, so only the window near the new chunk can hold
      // the next separator.
      const from = Math.max(0, state.buffer.length - 3);
      state.buffer += chunk;
      let match = /\r?\n\r?\n/.exec(state.buffer.slice(from));
      while (match) {
        const cut = from + match.index;
        const block = state.buffer.slice(0, cut);
        state.buffer = state.buffer.slice(cut + match[0].length);
        processEventBlock(block);
        match = /\r?\n\r?\n/.exec(state.buffer);
      }
      return true;
    }

    function end() {
      if (state.skipped) return;
      const rest = state.buffer;
      state.buffer = "";
      if (rest.trim()) processEventBlock(rest);
      // A body without any data line is not SSE (plain JSON on a stream
      // endpoint): keep the old buffered treatment.
      if (!state.sawDataLine) harvest(state.text, via);
      emitCurrentMessage();
    }

    function abort() {
      // Quietly keep every processed event; drop the partial one.
      state.buffer = "";
      emitCurrentMessage();
    }

    return { push, end, abort };
  }

  async function harvestResponseStream(response, via, requestMeta = null) {
    const reader = response?.body?.getReader?.();
    if (!reader) {
      // No streaming body in this environment: keep the buffered path.
      try {
        harvest(await response.text(), via);
      } catch {
        // ignore
      }
      return;
    }
    const stream = createSseStreamHarvester(via, requestMeta);
    const decoder = typeof TextDecoder === "function" ? new TextDecoder("utf-8") : null;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = typeof value === "string"
          ? value
          : decoder && value
            ? decoder.decode(value, { stream: true })
            : "";
        if (!chunk) continue;
        if (!stream.push(chunk)) break; // size ceiling: stop parsing this stream
      }
      stream.end();
    } catch {
      // The page aborts finished streams; keep what already arrived.
      stream.abort();
    }
  }

  // Keep the original fetch so an explicit refresh cannot recurse through the
  // general fetch interceptor below.
  const originalFetch = window.fetch;
  const conversationRefreshAt = new Map();
  const conversationRefreshBackoffUntil = new Map();
  const CONVERSATION_REFRESH_COOLDOWN_MS = 2_500;
  const CONVERSATION_REFRESH_SOFT_FAILURE_BACKOFF_MS = 60_000;

  async function refreshCurrentConversation() {
    if (!isCaptureEnabled()) return;
    const conversationId = conversationIdFromLocation();
    if (!conversationId) return;

    const now = Date.now();
    const backoffUntil = conversationRefreshBackoffUntil.get(conversationId) || 0;
    if (now < backoffUntil) return;
    const previous = conversationRefreshAt.get(conversationId) || 0;
    if (now - previous < CONVERSATION_REFRESH_COOLDOWN_MS) return;
    conversationRefreshAt.set(conversationId, now);
    if (conversationRefreshAt.size > 20) {
      for (const [id, at] of conversationRefreshAt) {
        if (now - at > CONVERSATION_REFRESH_COOLDOWN_MS * 4) conversationRefreshAt.delete(id);
      }
    }

    const encodedConversationId = encodeURIComponent(conversationId);
    const base = location.origin || "https://chatgpt.com";
    const endpoints = [
      `${base}/backend-api/conversations/${encodedConversationId}`,
      `${base}/backend-api/conversation/${encodedConversationId}`,
      `${base}/backend-api/f/conversation/${encodedConversationId}`,
    ];
    let lastStatus = 0;
    for (const endpoint of endpoints) {
      try {
        const response = await originalFetch(endpoint, {
          credentials: "include",
          cache: "no-store",
        });
        if (!response?.ok) {
          lastStatus = Number(response?.status) || 0;
          continue;
        }
        const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
        if (/json/.test(contentType)) {
          // The explicit recovery endpoint is already structured conversation
          // JSON. Parse it directly instead of materializing a second giant
          // text copy and rejecting long chats by byte count. This keeps late
          // Prompt recovery working for very large creative conversations.
          walkObject(await response.json(), { conversationId });
        } else {
          harvest(await response.text(), "conversation-refresh");
        }
        return;
      } catch {
        // Try the alternate first-party conversation endpoint.
      }
    }
    const soft = [403, 404, 410].includes(lastStatus);
    if (soft) {
      conversationRefreshBackoffUntil.set(
        conversationId,
        Date.now() + CONVERSATION_REFRESH_SOFT_FAILURE_BACKOFF_MS,
      );
    }
    post("conversation-refresh-failed", { status: lastStatus, soft });
  }

  // Commands no longer arrive over window messages: any page script could
  // forge those. Only the request for a (replacement) port is accepted here,
  // and only until the content script confirmed the first port.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data?.source !== "mosa-chatgpt-capture") return;
    if (data.type !== "hook-port-request") return;
    if (portConfirmed) return;
    handPortToContent();
  });

  function isInterestingResponseUrl(value) {
    try {
      const url = new URL(String(value || ""), location.origin);
      if (url.origin !== location.origin) return false;
      const path = url.pathname.toLowerCase();
      const isConversationStream = path === "/backend-api/conversation"
        || path === "/backend-api/f/conversation";
      const isConversationItem = path.startsWith("/backend-api/conversation/")
        || path.startsWith("/backend-api/f/conversation/");
      // The plural collection also exposes batch/sidebar responses. Inspect
      // only the open conversation, never those multi-conversation payloads.
      return (Boolean(conversationIdFromLocation())
          && path === `/backend-api/conversations/${conversationIdFromLocation().toLowerCase()}`)
        || isConversationStream
        || isConversationItem
        || path.includes("/backend-api/estuary/")
        || /\/(image|images|imagegen|image-generation|generation)(?:\/|$)/.test(path);
    } catch {
      return false;
    }
  }

  // The multi-image gallery renders generated images as blob: URLs, which
  // carry no file id. The page loads them as estuary/content?id=file_X ->
  // Response.blob() -> URL.createObjectURL(), so tag that Blob with its file id
  // and report the blob: URL it becomes. Only the `id` parameter is read; the
  // signature and token parameters never leave the URL. Both hooks return the
  // original result unchanged and swallow their own errors.
  const blobAssetIds = new WeakMap();

  function estuaryFileIdFromUrl(value) {
    try {
      const url = new URL(String(value || ""), location.origin);
      if (url.origin !== location.origin || url.pathname !== "/backend-api/estuary/content") return "";
      const id = url.searchParams.get("id") || "";
      return /^file[-_][A-Za-z0-9]{6,}$/i.test(id) ? id : "";
    } catch {
      return "";
    }
  }

  try {
    const OriginalResponseBlob = Response.prototype.blob;
    if (typeof OriginalResponseBlob === "function") {
      Response.prototype.blob = function mosaResponseBlob(...args) {
        const promise = OriginalResponseBlob.apply(this, args);
        // DEV-ONLY(128): remove before release. While the dev recorder is
        // on, read the generated image's container metadata (no pixels) off
        // the estuary blob, asynchronously, so the page gets its Blob
        // unchanged and without waiting.
        if (devRawEnabled()) {
          try {
            const devProxy = chatGptImageProxyInfo(this?.url);
            if (devProxy && /^file[-_]/i.test(devProxy.assetId)) {
              promise.then((devBlob) => {
                try {
                  const devType = String(devBlob?.type || this?.headers?.get?.("content-type") || "");
                  if (!devType || /^image\//i.test(devType.split(";", 1)[0])) {
                    devRaw.noteImageBlob(devProxy.conversationId, devProxy.assetId, devBlob);
                  }
                } catch {
                  // metadata reading must never surface here
                }
                return devBlob;
              }).catch(() => {});
            }
          } catch {
            // diagnostics never break the page's Blob
          }
        }
        if (!isCaptureEnabled()) return promise;
        try {
          const assetId = estuaryFileIdFromUrl(this?.url);
          if (!assetId) return promise;
          return promise.then((blob) => {
            try {
              if (blob && typeof Blob === "function" && blob instanceof Blob) blobAssetIds.set(blob, assetId);
            } catch {
              // A failed tag only loses this mapping; the page still gets its Blob.
            }
            return blob;
          });
        } catch {
          return promise;
        }
      };
    }
  } catch {
    // No Response in this environment.
  }

  try {
    const OriginalCreateObjectURL = URL.createObjectURL;
    if (typeof OriginalCreateObjectURL === "function") {
      URL.createObjectURL = function mosaCreateObjectURL(...args) {
        const result = OriginalCreateObjectURL.apply(this, args);
        try {
          const [obj] = args;
          if (
            isCaptureEnabled()
            && typeof result === "string"
            && result.startsWith("blob:")
            && obj && typeof Blob === "function" && obj instanceof Blob
          ) {
            const assetId = blobAssetIds.get(obj);
            if (assetId) post("blob-asset", { blobUrl: result, assetId });
          }
        } catch {
          // A failed report never affects the blob: URL the page receives.
        }
        return result;
      };
    }
  } catch {
    // No URL.createObjectURL in this environment.
  }

  // ---- Conversation turn structure (ids and numbers only, never text) ----
  //
  // While the user has a conversation open, the page itself fetches its stored
  // JSON (mapping + current_node). That tree is the only source of real turn
  // numbers: which visible user turn each generated image belongs to. The
  // extraction below reads just that structure — message ids, roles, image
  // file ids, order — and the report replaces turn guessing on the MOSA side.

  const MAX_CONVERSATION_TURN_BINDINGS = 2000;

  // Tool telemetry and similar system turns carry role "user" while being
  // kept out of the visible thread; they are not turns the user typed.
  function isHiddenConversationUserMessage(message) {
    return message?.metadata?.is_visually_hidden_from_conversation === true;
  }

  function isConversationUserMessage(message) {
    if (String(message?.author?.role || "").toLowerCase() !== "user") return false;
    return !isHiddenConversationUserMessage(message);
  }

  // Image file ids this message generated. The provenance markers mirror
  // emitMessageBindings: uploads and images an assistant message merely
  // references carry no image-generation metadata and stay out.
  function conversationGenerationAssets(message) {
    const authorRole = String(message?.author?.role || "").toLowerCase();
    if (!["assistant", "tool"].includes(authorRole)) return [];
    const parts = Array.isArray(message?.content?.parts) ? message.content.parts : [];
    const assetIds = [...new Set(parts
      .filter((part) => part && typeof part === "object" && part.content_type === "image_asset_pointer")
      .map((part) => normalizeAssetId(part.asset_pointer || part.assetPointer))
      .filter(Boolean))];
    if (!assetIds.length) return [];
    const toolMarker = [
      message?.author?.name,
      message?.recipient,
      message?.metadata?.tool_name,
      message?.metadata?.command,
      message?.metadata?.invoked_plugin?.namespace,
    ].filter(Boolean).join(" ");
    const generationOwned = Boolean(
      message?.metadata?.dalle
      || message?.metadata?.image_gen
      || message?.metadata?.imageGen
      || message?.metadata?.image_generation
      || message?.metadata?.imageGeneration
      || message?.metadata?.image_gen_title
      || message?.metadata?.imageGenTitle
      || message?.metadata?.image_generation_title
      || message?.metadata?.imageGenerationTitle
      || /(dall[-_.]?e|image[_ .-]?(gen|generation)|text2im|imagegen)/i.test(toolMarker)
      || parts.some((part) => (
        part?.content_type === "image_asset_pointer"
        && (part.metadata?.dalle?.gen_id || part.metadata?.generation?.gen_id)
      )),
    );
    return generationOwned ? assetIds : [];
  }

  /**
   * Turn bindings from one conversation read. Input is the conversation's own
   * JSON; output carries only ids and numbers: { conversationId, turnCount,
   * bindings: [{ provider_asset_id, message_id, turn_index }] }, or null when
   * there is nothing to report. Only the displayed branch is read: from
   * current_node up through parent links, never sibling branches. turn_index
   * counts the branch's visible user messages up to and including the turn
   * that produced the image; message_id is that turn's user message. A file
   * that surfaces as a generation output in two different branch messages is
   * ambiguous and omitted whole. A batch over the server ceiling comes back
   * with overLimit and empty bindings — it must be dropped, not truncated.
   */
  function extractConversationTurnBindings(conversationJson) {
    const tree = conversationJson && typeof conversationJson === "object" && !Array.isArray(conversationJson)
      ? conversationJson
      : null;
    const mapping = tree?.mapping && typeof tree.mapping === "object" && !Array.isArray(tree.mapping)
      ? tree.mapping
      : null;
    if (!mapping) return extractMessagesConversationTurnBindings(tree);
    const conversationId = typeof tree.conversation_id === "string" ? tree.conversation_id.trim() : "";
    if (!conversationId) return null;
    const branch = [];
    const seenNodes = new Set();
    let cursor = typeof tree.current_node === "string" ? tree.current_node : "";
    while (cursor && !seenNodes.has(cursor)) {
      const node = mapping[cursor];
      if (!node || typeof node !== "object" || Array.isArray(node)) break;
      seenNodes.add(cursor);
      branch.unshift(node);
      cursor = typeof node.parent === "string" ? node.parent : "";
    }
    let turnCount = 0;
    let turnMessageId = "";
    const outputs = new Map();
    for (const node of branch) {
      const message = node?.message && typeof node.message === "object" ? node.message : null;
      if (!message) continue;
      if (isConversationUserMessage(message)) {
        turnCount += 1;
        turnMessageId = typeof message.id === "string" ? message.id.trim() : "";
        continue;
      }
      const messageKey = (typeof message.id === "string" && message.id.trim())
        || (typeof node.id === "string" ? node.id : "");
      for (const assetId of conversationGenerationAssets(message)) {
        const entry = outputs.get(assetId);
        if (entry) entry.messages.add(messageKey);
        else outputs.set(assetId, { messages: new Set([messageKey]), turnIndex: turnCount, turnMessageId });
      }
    }
    if (!turnCount) return null;
    const bindings = [];
    for (const [assetId, entry] of outputs) {
      if (entry.messages.size !== 1 || !entry.turnIndex) continue;
      bindings.push({
        provider_asset_id: assetId,
        message_id: entry.turnMessageId,
        turn_index: entry.turnIndex,
      });
    }
    if (!bindings.length) return null;
    bindings.sort((a, b) => (
      a.turn_index - b.turn_index
      || (a.provider_asset_id < b.provider_asset_id ? -1 : a.provider_asset_id > b.provider_asset_id ? 1 : 0)
    ));
    if (bindings.length > MAX_CONVERSATION_TURN_BINDINGS) {
      return { conversationId, turnCount, bindings: [], overLimit: true };
    }
    return { conversationId, turnCount, bindings };
  }

  /**
   * Same contract as extractConversationTurnBindings, for the newer
   * conversation read: instead of a mapping tree the page gets the displayed
   * branch as a flat `messages` list (oldest first) plus `page_info` paging.
   * Turn numbers are only trustworthy when the read holds the whole
   * conversation, so anything but `page_info.has_previous_page === false` is
   * dropped — while older pages exist every count would come out too low, and
   * a wrong turn number is worse than none. Stitching those older pages into
   * one report is future work (paged reads simply report nothing today).
   * Structural gates before counting: the list must end at current_node and
   * stay in order. ChatGPT leaves internal nodes (tool-call steps and the
   * like) out of the list, so a metadata.parent_id may name a node that is
   * not there — that is a skipped internal node and is allowed. A parent_id
   * that names a message which IS in the list must name an earlier one; a
   * parent at or after its child means the list is not one ordered branch,
   * and the whole batch is dropped.
   */
  function extractMessagesConversationTurnBindings(tree) {
    const messages = Array.isArray(tree?.messages) ? tree.messages : null;
    if (!messages?.length) return null;
    const pageInfo = tree.page_info && typeof tree.page_info === "object" && !Array.isArray(tree.page_info)
      ? tree.page_info
      : null;
    if (pageInfo?.has_previous_page !== false) return null;
    const conversationId = typeof tree.conversation_id === "string" ? tree.conversation_id.trim() : "";
    if (!conversationId) return null;
    for (const message of messages) {
      if (!message || typeof message !== "object" || Array.isArray(message)) return null;
    }
    const lastMessage = messages[messages.length - 1];
    if (typeof lastMessage.id !== "string" || lastMessage.id !== tree.current_node) return null;
    const positionById = new Map();
    messages.forEach((message, index) => {
      if (typeof message.id === "string" && message.id) positionById.set(message.id, index);
    });
    for (let index = 0; index < messages.length; index += 1) {
      const parentId = messages[index]?.metadata?.parent_id;
      if (parentId == null || !positionById.has(parentId)) continue;
      if (positionById.get(parentId) >= index) return null;
    }
    // Identical counting rules as the mapping branch above, only over an
    // already-flattened branch: the helpers carry the rules, never a second
    // copy of them.
    let turnCount = 0;
    let turnMessageId = "";
    const outputs = new Map();
    for (const message of messages) {
      if (isConversationUserMessage(message)) {
        turnCount += 1;
        turnMessageId = typeof message.id === "string" ? message.id.trim() : "";
        continue;
      }
      const messageKey = typeof message.id === "string" ? message.id.trim() : "";
      for (const assetId of conversationGenerationAssets(message)) {
        const entry = outputs.get(assetId);
        if (entry) entry.messages.add(messageKey);
        else outputs.set(assetId, { messages: new Set([messageKey]), turnIndex: turnCount, turnMessageId });
      }
    }
    if (!turnCount) return null;
    const bindings = [];
    for (const [assetId, entry] of outputs) {
      if (entry.messages.size !== 1 || !entry.turnIndex) continue;
      bindings.push({
        provider_asset_id: assetId,
        message_id: entry.turnMessageId,
        turn_index: entry.turnIndex,
      });
    }
    if (!bindings.length) return null;
    bindings.sort((a, b) => (
      a.turn_index - b.turn_index
      || (a.provider_asset_id < b.provider_asset_id ? -1 : a.provider_asset_id > b.provider_asset_id ? 1 : 0)
    ));
    if (bindings.length > MAX_CONVERSATION_TURN_BINDINGS) {
      return { conversationId, turnCount, bindings: [], overLimit: true };
    }
    return { conversationId, turnCount, bindings };
  }

  // Conversation items are only reported when they are the conversation the
  // user has open — never a prefetched or sibling conversation id.
  function isCurrentConversationItemUrl(value) {
    const openId = conversationIdFromLocation();
    if (!openId) return false;
    try {
      const url = new URL(String(value || ""), location.origin);
      if (url.origin !== location.origin) return false;
      if (!/^\/backend-api\/(?:f\/)?conversations?\/[^/]+$/.test(url.pathname.toLowerCase())) return false;
      return decodeURIComponent(url.pathname.split("/").pop() || "").toLowerCase() === openId.toLowerCase();
    } catch {
      return false;
    }
  }

  function reportConversationTurnBindings(conversationJson) {
    let report;
    try {
      report = extractConversationTurnBindings(conversationJson);
    } catch {
      return;
    }
    if (!report) return;
    if (report.overLimit) {
      // Over the server ceiling: a truncated batch would make the reported
      // turn numbers disagree with the stored turn count, so the whole read
      // is dropped with one debug line. The next conversation load retries.
      console.debug("[mosa] conversation turn bindings dropped: batch exceeds 2000 entries", report.conversationId);
      return;
    }
    post("conversation-turn-bindings", report);
  }

  function reportConversationTurnBindingsFromText(text) {
    if (typeof text !== "string" || text.length < 2 || text.length > 32_000_000) return;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    reportConversationTurnBindings(parsed);
  }

  window.fetch = async function mosaFetch(...args) {
    const response = await originalFetch.apply(this, args);
    // DEV-ONLY(128): remove before release. Record every backend-api
    // exchange the page itself makes while the dev recorder is on, with the
    // raw response body (2 MiB cap, headers never recorded). Runs before the
    // capture gate so the recorder also works with auto-capture off.
    if (devRawEnabled()) {
      try {
        const devUrl = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
        if (devRawIsBackendApiUrl(devUrl)) {
          const devMethod = devRawRequestMethodOf(args);
          const devContentType = String(response?.headers?.get?.("content-type") || "");
          const devStatus = Number(response?.status) || 0;
          if (devContentType.includes("event-stream")) {
            devRawRecordHttp(devMethod, devUrl, devStatus, devContentType, "");
          } else if (typeof response?.clone === "function") {
            response.clone().text().then((devText) => {
              devRawRecordHttp(devMethod, devUrl, devStatus, devContentType, devRawBodyTextFor(devContentType, devText));
            }).catch(() => {});
          }
        }
      } catch {
        // diagnostics never throws into the harness
      }
    }
    if (!isCaptureEnabled()) return response;
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      if (isInterestingResponseUrl(url)) {
        const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
        const textLike = /json|text|event-stream|javascript/.test(contentType)
          || /backend-api|conversation/i.test(String(url));
        if (textLike && !/^image\//.test(contentType)) {
          const clone = response.clone();
          const isSseStream = contentType.includes("event-stream")
            || Boolean(conversationStreamPathname(url));
          if (isSseStream && clone.body && typeof clone.body.getReader === "function") {
            // Streamed reply: parse while it arrives so the page aborting the
            // finished request keeps every binding already delivered.
            harvestResponseStream(clone, "fetch-sse", {
              method: devRawRequestMethodOf(args),
              url,
            }).catch(() => {});
          } else if (/json/.test(contentType) && /\/backend-api\/(?:f\/)?conversations?\//i.test(String(url))) {
            clone.json()
              .then((payload) => {
                walkObject(payload, { conversationId: conversationIdFromLocation() });
                if (isCurrentConversationItemUrl(url)) reportConversationTurnBindings(payload);
              })
              .catch(() => {});
          } else {
            clone.text().then((text) => {
              harvest(text, "fetch");
            }).catch(() => {});
          }
        }
      }
    } catch {
      // ignore
    }
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function mosaOpen(method, url, ...rest) {
    this.__mosaUrl = url;
    // DEV-ONLY(128): remove before release (dev http recording needs it).
    this.__mosaMethod = method;
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function mosaSend(...args) {
    this.addEventListener("load", function onLoad() {
      // DEV-ONLY(128): remove before release. Record every backend-api XHR
      // exchange while the dev recorder is on, capture gate or not.
      if (devRawEnabled()) {
        try {
          const devUrl = String(this.__mosaUrl || "");
          if (devRawIsBackendApiUrl(devUrl)) {
            const devContentType = String(this.getResponseHeader?.("content-type") || "");
            const responseType = String(this.responseType || "").toLowerCase();
            const devText = responseType === "" || responseType === "text"
              ? (this.responseText || "")
              : responseType === "json" && this.response
                ? JSON.stringify(this.response)
                : "";
            devRawRecordHttp(
              String(this.__mosaMethod || "GET"),
              devUrl,
              Number(this.status) || 0,
              devContentType,
              devRawBodyTextFor(devContentType, devText),
            );
          }
        } catch {
          // diagnostics must never affect the XHR path
        }
      }
      if (!isCaptureEnabled()) return;
      try {
        const url = String(this.__mosaUrl || "");
        if (isInterestingResponseUrl(url)) {
          // Mirror the fetch interceptor: never harvest raw image bytes.
          const contentType = String(this.getResponseHeader?.("content-type") || "").toLowerCase();
          if (!/^image\//.test(contentType)) {
            const responseType = String(this.responseType || "").toLowerCase();
            const text = responseType === "" || responseType === "text"
              ? (this.responseText || "")
              : responseType === "json" && this.response
                ? JSON.stringify(this.response)
                : "";
            if (text) harvest(text, "xhr");
            if (isCurrentConversationItemUrl(url)) reportConversationTurnBindingsFromText(text);
          }
        }
      } catch {
        // ignore
      }
    });
    return originalSend.apply(this, args);
  };

  /**
   * ChatGPT streams a live answer over a WebSocket for most consumer accounts,
   * so fetch and XHR never see the caption of an image generated while the page
   * is open. Frames arrive as JSON envelopes whose `body` is base64 SSE text.
   */
  // Image tool arguments arrive as JSON text inside content.text, so their
  // "prompt" key is escaped (\"prompt\":) in the raw frame.
  const WS_INTEREST = /asset_pointer|asset_id|file_id|image_id|file-service|sediment|revised_prompt|generation_prompt|image_prompt|generation_call_id|image_generation_call_id|image_gen_call_id|tool_call_id|toolcallid|model[ _]caption|\\?["']prompt\\?["']\s*:|generation_status|finish_reason|["'](?:error|failure)["']\s*:|image[_ .-]?(gen|generation)|imagegen|dalle|oaiusercontent|estuary/i;

  function hasConversationMessageShape(text) {
    if (typeof text !== "string" || text.length < 24) return false;
    // Current live envelopes have changed outer event names several times.
    // `update_content.messages` is a more durable structural signal than a
    // provider/tool keyword, while still avoiding a JSON parse for ordinary
    // token-delta frames.
    return text.includes('"update_content"')
      && text.includes('"messages"')
      && (text.includes('"content"') || text.includes('"message"'));
  }

  function decodeBase64Utf8(value) {
    if (typeof atob !== "function") return "";
    const binary = atob(String(value || ""));
    if (typeof TextDecoder !== "function" || typeof Uint8Array !== "function") return binary;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    // A caption is often Chinese; the raw binary string would mangle it.
    return new TextDecoder("utf-8").decode(bytes);
  }

  function harvestSocketText(text) {
    if (!text || typeof text !== "string") return;
    // Token-by-token deltas dominate the stream. Parse only image-bearing frames.
    if (WS_INTEREST.test(text) || hasConversationMessageShape(text)) harvest(text, "websocket");
    // Skip anything that is not a JSON envelope carrying a base64 body, so a
    // fast answer stream does not pay for a parse per token.
    if (text.charCodeAt(0) !== 123 || !text.includes('"body"')) return;
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      return;
    }
    const body = envelope?.body;
    if (typeof body !== "string" || !body) return;
    try {
      const decoded = decodeBase64Utf8(body);
      if (decoded && (WS_INTEREST.test(decoded) || hasConversationMessageShape(decoded))) {
        harvest(decoded, "websocket-body");
      }
    } catch {
      // A frame we cannot decode is skipped; the refresh path still recovers it.
    }
  }

  function harvestSocketData(data) {
    try {
      if (typeof data === "string") {
        harvestSocketText(data);
      } else if (typeof ArrayBuffer === "function" && data instanceof ArrayBuffer) {
        if (typeof TextDecoder === "function") harvestSocketText(new TextDecoder("utf-8").decode(data));
      } else if (data && typeof data.text === "function") {
        data.text().then(harvestSocketText).catch(() => {});
      }
    } catch {
      // ignore
    }
  }

  try {
    const OriginalWebSocket = window.WebSocket;
    if (typeof OriginalWebSocket === "function") {
      class MosaWebSocket extends OriginalWebSocket {
        constructor(...args) {
          super(...args);
          try {
            this.addEventListener("message", (event) => {
              if (isCaptureEnabled()) harvestSocketData(event?.data);
            });
          } catch {
            // A socket that rejects listeners still works for the page.
          }
          // DEV-ONLY(128): remove before release. Record incoming and
          // outgoing socket payloads verbatim (masked) while the dev
          // recorder is on.
          try {
            this.addEventListener("message", (event) => {
              devRawRecordSocket("ws-in", event?.data);
            });
            const devOriginalSend = this.send;
            this.send = (...sendArgs) => {
              devRawRecordSocket("ws-out", sendArgs[0]);
              return devOriginalSend.apply(this, sendArgs);
            };
          } catch {
            // Diagnostics hooks never break the page's socket.
          }
        }
      }
      window.WebSocket = MosaWebSocket;
    }
  } catch {
    // ignore
  }

  try {
    const obs = new MutationObserver((mutations) => {
      if (!isCaptureEnabled()) return;
      for (const m of mutations) {
        for (const node of m.addedNodes || []) {
          const imgs = [];
          if (node instanceof HTMLImageElement) imgs.push(node);
          else if (node?.querySelectorAll) imgs.push(...node.querySelectorAll("img"));
          for (const img of imgs) {
            const src = img.currentSrc || img.src;
            if (src) post("dom-image", { ...imageIdentity(src), imageUrl: src, width: img.naturalWidth, height: img.naturalHeight });
          }
        }
        if (
          m.type === "attributes"
          && m.target instanceof HTMLImageElement
          && (m.attributeName === "src" || m.attributeName === "srcset")
        ) {
          const src = m.target.currentSrc || m.target.src;
          if (src) post("dom-image", { ...imageIdentity(src), imageUrl: src, width: m.target.naturalWidth, height: m.target.naturalHeight });
        }
      }
    });
    const startObs = () => obs.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset"],
    });
    if (document.documentElement) startObs();
    else document.addEventListener("DOMContentLoaded", startObs, { once: true });
  } catch {
    // ignore
  }

  post("generation-meta", { prompt: "", promptScore: 0, imageUrl: "", via: "hook-ready", hookReady: true });
})();
