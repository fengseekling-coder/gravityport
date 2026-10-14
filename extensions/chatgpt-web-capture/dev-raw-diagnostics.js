/**
 * DEV-ONLY(128): remove before release.
 *
 * Developer raw diagnostics recorder (page world). When the hidden options
 * switch (`devRawDiagnostics`) is on, this keeps a per-conversation ring
 * buffer of the RAW traffic the page hook already intercepts — SSE lines,
 * WebSocket messages in and out, and every chatgpt.com/backend-api response
 * body — plus image container metadata (PNG/JPEG/WebP metadata segments, no
 * pixels), and assembles one record per image round (same assistant message
 * id) to be stored locally in the extension's IndexedDB. Data never leaves
 * the user's machine; the whole feature is deleted before release.
 *
 * Everything recorded passes through the single masking function below:
 * sensitive JSON keys collapse to "[masked]", and URL query values are
 * stripped to their keys. Request/response headers are never recorded.
 * Any error inside this module is swallowed by its callers in page-hook.js;
 * capture itself never depends on it.
 */
(function mosaDevRawDiagnostics() {
  if (globalThis.MosaDevRawDiagnostics && globalThis.MosaDevRawDiagnostics.__installed) return;
  const api = globalThis.MosaDevRawDiagnostics || {};
  api.__installed = true;
  api.__enabled = false;

  // Test seams. Production never touches these; tests pin the clock, the
  // timer implementation, and the control-sample randomness.
  api.__clock = () => Date.now();
  api.__timers = null; // { set(fn, ms) -> id, clear(id) } when overridden
  api.__randomSource = Math.random;

  const BUFFER_TTL_MS = 10 * 60 * 1000;
  const MAX_BUFFER_FRAMES = 3000;
  const MAX_BUFFER_BYTES = 40 * 1024 * 1024;
  const MAX_CONVERSATIONS = 20;
  const MAX_PENDING_ROUNDS = 50;
  const ROUND_FINALIZE_DELAY_MS = 30_000;
  const ROUND_PRE_WINDOW_MS = 5_000;
  const CONTROL_SAMPLE_RATE = 0.1;
  const MASK_PLACEHOLDER = "[masked]";
  const SENSITIVE_KEY_RE = /token|authorization|cookie|secret|password|signature|^sig$|session/i;
  const URL_IN_TEXT_RE = /\bhttps?:\/\/[^\s"'`<>\\]+/g;
  const MODEL_KEY_NAMES = new Set(["model_slug", "default_model_slug", "resolved_model_slug"]);
  const MAX_MODELS = 32;
  const MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024;
  const MAX_RECORD_BYTES = 8 * 1024 * 1024;
  const BODY_PREVIEW_CHARS = 2048;
  const MAX_IMAGE_META_BYTES = 256 * 1024;
  const MAX_META_STRINGS = 400;
  const MAX_PRINTABLE_RUN = 512;
  const MAX_BLOB_BYTES_FOR_META = 30 * 1024 * 1024;
  // Frames seen before the URL carries a conversation id (a brand-new chat).
  const UNROUTED_KEY = "__unrouted__";

  const encoder = new TextEncoder();
  function byteLengthOf(value) {
    return encoder.encode(String(value ?? "")).byteLength;
  }

  // ----------------------------------------------------------------------
  // Masking. One set of rules applied to every piece of text that enters
  // the buffer, wherever it came from.
  // ----------------------------------------------------------------------

  function isSensitiveKey(key) {
    return typeof key === "string" && SENSITIVE_KEY_RE.test(key);
  }

  function stripUrlQueryValues(text) {
    return String(text ?? "").replace(URL_IN_TEXT_RE, (url) => {
      try {
        const parsed = new URL(url);
        const keys = [...parsed.searchParams.keys()];
        if (!keys.length) return url;
        return `${parsed.origin}${parsed.pathname}?${keys.join("&")}`;
      } catch {
        return url;
      }
    });
  }

  function maskJsonNode(value, depth = 0) {
    if (depth > 24) return MASK_PLACEHOLDER;
    if (typeof value === "string") return stripUrlQueryValues(value);
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => maskJsonNode(item, depth + 1));
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? MASK_PLACEHOLDER : maskJsonNode(child, depth + 1);
    }
    return out;
  }

  /** Mask one raw text: JSON (whole or SSE `data:` payload) gets sensitive
   *  keys replaced and URLs stripped inside every string; other text only
   *  gets URL query values stripped. */
  function maskRawText(text) {
    const raw = String(text ?? "");
    if (!raw) return raw;
    const tryParse = (value) => {
      if (typeof value !== "string" || value.length < 2 || value.length > 32_000_000) return null;
      const trimmed = value.trim();
      if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
      try {
        const parsed = JSON.parse(trimmed);
        return parsed && typeof parsed === "object" ? parsed : null;
      } catch {
        return null;
      }
    };
    const direct = tryParse(raw);
    if (direct) return JSON.stringify(maskJsonNode(direct));
    const sseMatch = /^data:\s?([\s\S]+)$/.exec(raw.trim());
    if (sseMatch) {
      const payload = tryParse(sseMatch[1]);
      if (payload) return `data: ${JSON.stringify(maskJsonNode(payload))}`;
    }
    return stripUrlQueryValues(raw);
  }

  // WebSocket envelopes carry SSE text base64-encoded in `body`; masking the
  // outer JSON would leave tokens inside the encoded body untouched. Decode,
  // mask, and store the decoded text in place so the export stays readable.
  function prepareSocketText(text) {
    const raw = String(text ?? "");
    if (!raw) return raw;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
        && typeof parsed.body === "string" && parsed.body) {
        const decoded = decodeBase64Utf8(parsed.body);
        if (decoded) {
          parsed.body = maskRawText(decoded);
          parsed.bodyDecoded = true;
          return JSON.stringify(maskJsonNode(parsed));
        }
      }
    } catch {
      // Not a JSON envelope: fall through to plain masking.
    }
    return maskRawText(raw);
  }

  function decodeBase64Utf8(value) {
    if (typeof atob !== "function") return "";
    try {
      const binary = atob(String(value || ""));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      if (typeof TextDecoder !== "function") return "";
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch {
      return "";
    }
  }

  api.isSensitiveKey = isSensitiveKey;
  api.maskRawText = maskRawText;
  api.stripUrlQueryValues = stripUrlQueryValues;
  api.prepareSocketText = prepareSocketText;

  // ----------------------------------------------------------------------
  // Per-conversation buffer of raw frames.
  // ----------------------------------------------------------------------

  const conversations = new Map();

  function conversationState(conversationId) {
    const key = String(conversationId || "");
    if (!key) return null;
    let state = conversations.get(key);
    if (!state) {
      state = { frames: [], bytes: 0, models: new Set(), userMessage: null, imageMeta: new Map() };
      conversations.set(key, state);
      while (conversations.size > MAX_CONVERSATIONS) {
        const oldest = conversations.keys().next().value;
        if (oldest === key) break;
        conversations.delete(oldest);
      }
    }
    return state;
  }

  function dropOldestFrame(state) {
    const oldest = state.frames.shift();
    if (oldest) state.bytes -= oldest.__size || 0;
  }

  function pushFrame(conversationId, frame) {
    const state = conversationState(conversationId);
    if (!state) return false;
    const now = api.__clock();
    frame.t = now;
    const size = byteLengthOf(JSON.stringify(frame));
    Object.defineProperty(frame, "__size", { value: size, enumerable: false });
    while (state.frames.length && state.frames[0].t < now - BUFFER_TTL_MS) dropOldestFrame(state);
    state.frames.push(frame);
    state.bytes += size;
    while (state.bytes > MAX_BUFFER_BYTES && state.frames.length > 1) dropOldestFrame(state);
    while (state.frames.length > MAX_BUFFER_FRAMES) dropOldestFrame(state);
    return true;
  }

  function harvestModels(conversationId, text) {
    const state = conversationState(conversationId);
    if (!state) return;
    harvestModelsInto(state.models, text);
  }

  function harvestModelsInto(models, text) {
    let parsed;
    try {
      parsed = JSON.parse(String(text ?? ""));
    } catch {
      return;
    }
    const visit = (value, depth) => {
      if (!value || typeof value !== "object" || depth > 12) return;
      for (const [key, child] of Object.entries(value)) {
        if (MODEL_KEY_NAMES.has(String(key).toLowerCase()) && typeof child === "string"
          && child && child.length <= 64) {
          models.add(child);
        }
        if (child && typeof child === "object") visit(child, depth + 1);
      }
    };
    visit(parsed, 0);
    while (models.size > MAX_MODELS) models.delete(models.keys().next().value);
  }

  /** Model names seen in this round's frames only (not the whole buffer). */
  function modelsFromFrames(frames) {
    const models = new Set();
    for (const frame of frames) {
      if (frame.source === "sse") harvestModelsInto(models, /^data:\s?([\s\S]+)$/.exec(String(frame.line || "").trim())?.[1] || "");
      else if (frame.source === "http") harvestModelsInto(models, frame.body || "");
      else if (frame.message) {
        harvestModelsInto(models, frame.message);
        try {
          const body = JSON.parse(frame.message)?.body;
          if (typeof body === "string") {
            for (const line of body.split("\n")) harvestModelsInto(models, /^data:\s?([\s\S]+)$/.exec(line.trim())?.[1] || "");
          }
        } catch {
          // not a JSON envelope
        }
      }
    }
    return [...models];
  }

  api.recordSseLine = (conversationId, meta, line) => {
    if (!api.__enabled) return false;
    try {
      const masked = maskRawText(line);
      harvestModels(conversationId, /^data:\s?([\s\S]+)$/.exec(String(line || "").trim())?.[1] || "");
      return pushFrame(conversationId, {
        source: "sse",
        method: String(meta?.method || ""),
        path: String(meta?.path || ""),
        line: masked,
      });
    } catch {
      return false;
    }
  };

  api.recordSocketMessage = (conversationId, direction, data) => {
    if (!api.__enabled) return false;
    try {
      if (data && typeof data.text === "function") {
        // Blob-like payload: read asynchronously; the late arrival is fine
        // for a diagnostics buffer.
        data.text().then((text) => {
          try { api.recordSocketMessage(conversationId, direction, text); } catch { /* ignore */ }
        }).catch(() => {});
        return false;
      }
      let text = "";
      if (typeof data === "string") text = data;
      else {
        let bytes = null;
        if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
        else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (bytes && typeof TextDecoder === "function") {
          try { text = new TextDecoder("utf-8", { fatal: false }).decode(bytes); } catch { text = ""; }
        }
      }
      if (!text) return false;
      const masked = prepareSocketText(text);
      harvestModels(conversationId, masked);
      return pushFrame(conversationId, { source: direction === "ws-out" ? "ws-out" : "ws-in", message: masked });
    } catch {
      return false;
    }
  };

  const BINARY_CONTENT_RE = /^(?:image\/|video\/|audio\/|font\/)|octet-stream/i;

  api.recordHttpExchange = (conversationId, exchange) => {
    if (!api.__enabled) return false;
    try {
      let path = "";
      let queryKeys = [];
      try {
        const parsed = new URL(String(exchange?.url || ""), "https://chatgpt.com");
        path = parsed.pathname;
        queryKeys = [...parsed.searchParams.keys()];
      } catch {
        path = String(exchange?.url || "");
      }
      const contentType = String(exchange?.contentType || "");
      const frame = {
        source: "http",
        method: String(exchange?.method || "GET").toUpperCase(),
        path,
        queryKeys,
        status: Number(exchange?.status) || 0,
        contentType,
      };
      const bodyText = typeof exchange?.bodyText === "string" ? exchange.bodyText : "";
      const bodyAllowed = bodyText
        && !BINARY_CONTENT_RE.test(contentType)
        && !contentType.includes("event-stream");
      if (bodyAllowed) {
        const masked = maskRawText(bodyText);
        harvestModels(conversationId, bodyText);
        const bytes = byteLengthOf(masked);
        if (bytes > MAX_HTTP_BODY_BYTES) {
          frame.body = bytePrefixWithin(masked, MAX_HTTP_BODY_BYTES);
          frame.bodyTruncated = true;
          frame.bodyOriginalLength = bytes;
        } else {
          frame.body = masked;
        }
      }
      return pushFrame(conversationId, frame);
    } catch {
      return false;
    }
  };

  /** Longest prefix of `text` whose UTF-8 size stays within `maxBytes`. */
  function bytePrefixWithin(text, maxBytes) {
    if (byteLengthOf(text) <= maxBytes) return text;
    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high + 1) / 2);
      if (byteLengthOf(text.slice(0, mid)) <= maxBytes) low = mid;
      else high = mid - 1;
    }
    return text.slice(0, low);
  }

  // ----------------------------------------------------------------------
  // Image container metadata (no pixels).
  // ----------------------------------------------------------------------

  function printableStrings(bytes, out) {
    let current = "";
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index];
      if (byte >= 0x20 && byte <= 0x7e) {
        if (current.length < MAX_PRINTABLE_RUN) current += String.fromCharCode(byte);
      } else {
        if (current.length >= 4 && out.strings.length < MAX_META_STRINGS) out.strings.push(current);
        current = "";
        if (out.strings.length >= MAX_META_STRINGS) return;
      }
    }
    if (current.length >= 4 && out.strings.length < MAX_META_STRINGS) out.strings.push(current);
  }

  function addTextSegment(segments, budget, chunk, text, extra = {}) {
    const clean = String(text ?? "");
    if (!clean) return;
    const remaining = MAX_IMAGE_META_BYTES - budget.bytes;
    if (remaining <= 0) {
      budget.truncated = true;
      return;
    }
    let slice = clean;
    let size = byteLengthOf(slice);
    if (size > remaining) {
      slice = bytePrefixWithin(clean, remaining);
      size = remaining;
      budget.truncated = true;
    }
    budget.bytes += size;
    segments.push({ chunk, kind: "text", text: slice, ...extra });
  }

  function addStringsSegment(segments, budget, chunk, bytes) {
    const out = { strings: [] };
    printableStrings(bytes, out);
    if (!out.strings.length) return;
    const remaining = MAX_IMAGE_META_BYTES - budget.bytes;
    if (remaining <= 0) {
      budget.truncated = true;
      return;
    }
    // Bound the serialized size: drop strings from the end until it fits.
    let kept = out.strings;
    let size = byteLengthOf(JSON.stringify(kept));
    while (size > remaining && kept.length > 1) {
      kept = kept.slice(0, Math.max(1, Math.floor(kept.length * 0.8)));
      size = byteLengthOf(JSON.stringify(kept));
    }
    if (size > remaining) {
      budget.truncated = true;
      return;
    }
    budget.bytes += size;
    segments.push({ chunk, kind: "strings", strings: kept });
  }

  async function inflateZlib(bytes) {
    if (typeof DecompressionStream !== "function" || typeof Blob !== "function"
      || typeof Response === "undefined") {
      throw new Error("decompression-unavailable");
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function decodeUtf8(bytes) {
    if (typeof TextDecoder !== "function") return "";
    try { return new TextDecoder("utf-8", { fatal: false }).decode(bytes); } catch { return ""; }
  }

  function cstring(bytes, start) {
    let end = start;
    while (end < bytes.length && bytes[end] !== 0) end += 1;
    return { text: decodeUtf8(bytes.subarray(start, end)), next: end + 1 };
  }

  async function pngSegments(bytes, segments, budget) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8;
    while (offset + 8 <= bytes.length) {
      const length = view.getUint32(offset);
      const type = decodeUtf8(bytes.subarray(offset + 4, offset + 8));
      const dataStart = offset + 8;
      if (dataStart + length > bytes.length) break;
      const data = bytes.subarray(dataStart, dataStart + length);
      if (type === "tEXt") {
        const keyword = cstring(data, 0);
        addTextSegment(segments, budget, "PNG-tEXt", `${keyword.text}\u0000${decodeUtf8(data.subarray(keyword.next))}`);
      } else if (type === "iTXt") {
        const keyword = cstring(data, 0);
        const compressionFlag = data[keyword.next] || 0;
        const textStart = keyword.next + 2;
        const language = cstring(data, textStart);
        const translated = cstring(data, language.next);
        const rawText = data.subarray(translated.next);
        if (compressionFlag === 1) {
          try {
            const inflated = await inflateZlib(rawText);
            addTextSegment(segments, budget, "PNG-iTXt", decodeUtf8(inflated), { inflated: true });
          } catch {
            segments.push({ chunk: "PNG-iTXt", kind: "strings" , strings: [], inflateFailed: true });
          }
        } else {
          addTextSegment(segments, budget, "PNG-iTXt", decodeUtf8(rawText));
        }
      } else if (type === "zTXt") {
        const keyword = cstring(data, 0);
        try {
          const inflated = await inflateZlib(data.subarray(keyword.next + 1));
          addTextSegment(segments, budget, "PNG-zTXt", decodeUtf8(inflated), { inflated: true });
        } catch {
          segments.push({ chunk: "PNG-zTXt", kind: "strings", strings: [], inflateFailed: true });
        }
      } else if (type === "eXIf" || type === "caBX") {
        addStringsSegment(segments, budget, `PNG-${type}`, data);
      }
      offset = dataStart + length + 4; // skip CRC
    }
  }

  async function jpegSegments(bytes, segments, budget) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      const dataStart = offset + 4;
      if (dataStart + length - 2 > bytes.length || length < 2) break;
      const data = bytes.subarray(dataStart, dataStart + length - 2);
      if (marker === 0xe1) { // APP1: EXIF or XMP
        if (data.length >= 6 && data[0] === 0x45 && data[1] === 0x78 && data[2] === 0x69
          && data[3] === 0x66 && data[4] === 0x00) {
          addStringsSegment(segments, budget, "JPEG-EXIF", data);
        } else if (data.length >= 29 && decodeUtf8(data.subarray(0, 29)).startsWith("http://ns.adobe.com/xap/1.0/")) {
          addTextSegment(segments, budget, "JPEG-XMP", decodeUtf8(data.subarray(29)));
        }
      } else if (marker === 0xeb) { // APP11: JUMBF (C2PA)
        addStringsSegment(segments, budget, "JPEG-APP11", data);
      }
      offset = dataStart + length - 2;
    }
  }

  function webpSegments(bytes, segments, budget) {
    if (bytes.length < 12) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const fourcc = decodeUtf8(bytes.subarray(offset, offset + 4));
      const length = view.getUint32(offset + 4, true);
      const dataStart = offset + 8;
      if (dataStart + length > bytes.length) break;
      const data = bytes.subarray(dataStart, dataStart + length);
      if (fourcc === "EXIF") addStringsSegment(segments, budget, "WEBP-EXIF", data);
      else if (fourcc === "XMP ") addTextSegment(segments, budget, "WEBP-XMP", decodeUtf8(data));
      offset = dataStart + length + (length % 2);
    }
  }

  /** Parse container metadata segments out of image bytes. Text segments are
   *  recorded verbatim (UTF-8); binary segments (EXIF, C2PA) become lists of
   *  printable runs (>= 4 chars). Pixels are never included. */
  api.extractImageMeta = async (bytes, mime = "") => {
    const view = new Uint8Array(bytes);
    const segments = [];
    const budget = { bytes: 0, truncated: false };
    const isPng = view.length >= 8 && view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4e && view[3] === 0x47;
    const isJpeg = view.length >= 4 && view[0] === 0xff && view[1] === 0xd8;
    const isWebp = view.length >= 12 && decodeUtf8(view.subarray(0, 4)) === "RIFF"
      && decodeUtf8(view.subarray(8, 12)) === "WEBP";
    try {
      if (isPng) await pngSegments(view, segments, budget);
      else if (isJpeg) await jpegSegments(view, segments, budget);
      else if (isWebp) webpSegments(view, segments, budget);
    } catch {
      budget.truncated = true;
    }
    const meta = { mime: String(mime || ""), byteLength: view.byteLength, segments };
    if (budget.truncated) meta.metaTruncated = true;
    return meta;
  };

  api.noteImageBlob = (conversationId, fileId, blob) => {
    if (!api.__enabled || !conversationId || !fileId || !blob) return;
    const state = conversationState(conversationId);
    if (!state) return;
    const size = Number(blob.size) || 0;
    if (size > MAX_BLOB_BYTES_FOR_META) return;
    const read = typeof blob.arrayBuffer === "function"
      ? blob.arrayBuffer()
      : typeof blob.blob === "function" ? blob.blob().then((inner) => inner.arrayBuffer()) : null;
    if (!read) return;
    read.then((buffer) => api.extractImageMeta(buffer, blob.type || ""))
      .then((meta) => {
        if (!api.__enabled) return;
        const entry = { fileId: String(fileId), capturedAt: new Date(api.__clock()).toISOString(), ...meta };
        state.imageMeta.set(String(fileId), entry);
      })
      .catch(() => {});
  };

  // ----------------------------------------------------------------------
  // Rounds. One round = every image emitted under one assistant message id.
  // ----------------------------------------------------------------------

  const rounds = new Map();

  function roundKey(conversationId, assistantMessageId) {
    return `${String(conversationId || "")}\u0000${String(assistantMessageId || "")}`;
  }

  function timerSet(fn, ms) {
    return api.__timers ? api.__timers.set(fn, ms) : setTimeout(fn, ms);
  }

  function timerClear(id) {
    if (api.__timers) api.__timers.clear(id);
    else clearTimeout(id);
  }

  api.noteUserMessage = (conversationId, messageId) => {
    if (!api.__enabled) return;
    const state = conversationState(conversationId);
    if (!state || !messageId) return;
    state.userMessage = { id: String(messageId), at: api.__clock() };
  };

  api.noteImage = (payload) => {
    if (!api.__enabled) return;
    try {
      const conversationId = String(payload?.conversationId || "");
      const assistantMessageId = String(payload?.assistantMessageId || "");
      const fileId = String(payload?.fileId || "");
      if (!conversationId || !assistantMessageId || !fileId) return;
      const key = roundKey(conversationId, assistantMessageId);
      let round = rounds.get(key);
      if (!round) {
        const state = conversationState(conversationId);
        const user = state?.userMessage;
        const firstFrameAt = state?.frames?.[0]?.t;
        round = {
          conversationId,
          assistantMessageId,
          userMessageId: user?.id ? String(user.id) : "",
          windowStart: user?.at
            ? user.at - ROUND_PRE_WINDOW_MS
            : Number(firstFrameAt) || api.__clock() - ROUND_PRE_WINDOW_MS,
          images: new Map(),
          lastImageAt: api.__clock(),
          timerId: undefined,
        };
        rounds.set(key, round);
        while (rounds.size > MAX_PENDING_ROUNDS) {
          const oldest = rounds.keys().next().value;
          const oldestRound = rounds.get(oldest);
          rounds.delete(oldest);
          if (oldestRound) finalizeRound(oldestRound);
          if (rounds.size <= MAX_PENDING_ROUNDS) break;
        }
      }
      const existing = round.images.get(fileId);
      const image = existing || {
        fileId,
        generationId: "",
        promptStatus: "not-available",
        promptLength: 0,
        model: "",
      };
      image.generationId = payload.generationId || image.generationId;
      image.promptStatus = payload.promptStatus || image.promptStatus;
      image.promptLength = Number(payload.promptLength) || image.promptLength || 0;
      image.model = payload.model || image.model;
      round.images.set(fileId, image);
      round.lastImageAt = api.__clock();
      if (round.timerId !== undefined) timerClear(round.timerId);
      round.timerId = timerSet(() => {
        round.timerId = undefined;
        rounds.delete(roundKey(round.conversationId, round.assistantMessageId));
        finalizeRound(round);
      }, ROUND_FINALIZE_DELAY_MS);
    } catch {
      // diagnostics must never affect the capture path
    }
  };

  function collectImageMeta(conversationId, round) {
    const state = conversations.get(conversationId);
    if (!state) return [];
    const metas = [];
    for (const fileId of round.images.keys()) {
      const meta = state.imageMeta.get(fileId);
      if (meta) metas.push(meta);
    }
    return metas;
  }

  function enforceRecordBudget(record, referenceTime) {
    let truncated = false;
    let truncatedFrames = 0;
    let total = byteLengthOf(JSON.stringify(record));
    if (total <= MAX_RECORD_BYTES) return;
    truncated = true;
    // Step 1: replace the largest full HTTP bodies with a 2 KiB preview,
    // largest first, until the estimate says we fit.
    const bodyFrames = record.frames
      .map((frame, index) => ({ frame, index }))
      .filter(({ frame }) => frame.source === "http" && typeof frame.body === "string" && !frame.bodyTruncated)
      .sort((a, b) => b.frame.body.length - a.frame.body.length);
    let saved = 0;
    for (const { frame } of bodyFrames) {
      const original = byteLengthOf(frame.body);
      const preview = byteLengthOf(frame.body.slice(0, BODY_PREVIEW_CHARS));
      if (preview >= original) continue;
      saved += original - preview;
      frame.bodyPreview = frame.body.slice(0, BODY_PREVIEW_CHARS);
      delete frame.body;
      frame.bodyTruncated = true;
      frame.bodyOriginalLength = original;
      if (total - saved <= MAX_RECORD_BYTES) break;
    }
    total = byteLengthOf(JSON.stringify(record));
    // Step 2: drop frames farthest from the image time until the record fits.
    if (total > MAX_RECORD_BYTES) {
      const distances = record.frames
        .map((frame, index) => ({ index, distance: Math.abs((Number(frame.t) || 0) - referenceTime) }))
        .sort((a, b) => b.distance - a.distance);
      const drop = new Set();
      let droppedBytes = 0;
      for (const { index } of distances) {
        droppedBytes += byteLengthOf(JSON.stringify(record.frames[index]));
        drop.add(index);
        if (total - droppedBytes <= MAX_RECORD_BYTES) break;
      }
      if (total - droppedBytes > MAX_RECORD_BYTES && record.frames.length) {
        // Extreme case: drop everything.
        for (let index = 0; index < record.frames.length; index += 1) drop.add(index);
      }
      record.frames = record.frames.filter((_, index) => !drop.has(index));
      truncatedFrames = drop.size;
      total = byteLengthOf(JSON.stringify(record));
      while (total > MAX_RECORD_BYTES && record.frames.length) {
        record.frames.pop();
        truncatedFrames += 1;
        total = byteLengthOf(JSON.stringify(record));
      }
    }
    record.truncated = true;
    record.truncatedFrames = truncatedFrames;
  }

  function finalizeRound(round) {
    try {
      if (round.timerId !== undefined) timerClear(round.timerId);
      round.timerId = undefined;
      const images = [...round.images.values()];
      if (!images.length) return;
      const missingPrompt = images.some((image) => (image.promptStatus || "not-available") === "not-available");
      const control = !missingPrompt && api.__randomSource() < CONTROL_SAMPLE_RATE;
      if (!missingPrompt && !control) return;
      const end = api.__clock();
      const state = conversations.get(round.conversationId);
      const inWindow = (frame) => frame.t >= round.windowStart && frame.t <= end;
      const unrouted = round.conversationId !== UNROUTED_KEY ? conversations.get(UNROUTED_KEY) : null;
      const frames = [
        ...(state ? state.frames.filter(inWindow) : []),
        ...(unrouted ? unrouted.frames.filter(inWindow) : []),
      ].sort((a, b) => a.t - b.t);
      const record = {
        recordedAt: new Date(end).toISOString(),
        conversationId: round.conversationId,
        assistantMessageId: round.assistantMessageId,
        userMessageId: round.userMessageId || undefined,
        window: {
          start: new Date(round.windowStart).toISOString(),
          end: new Date(end).toISOString(),
        },
        control,
        images,
        models: modelsFromFrames(frames),
        frames,
        imageMeta: collectImageMeta(round.conversationId, round),
      };
      enforceRecordBudget(record, round.lastImageAt);
      if (typeof api.onRecord === "function") api.onRecord(record);
    } catch {
      // diagnostics must never affect the capture path
    }
  }

  api.setEnabled = (value) => {
    api.__enabled = value === true;
    if (!api.__enabled) {
      for (const round of rounds.values()) {
        if (round.timerId !== undefined) timerClear(round.timerId);
      }
      rounds.clear();
      conversations.clear();
    }
    return api.__enabled;
  };

  api.isEnabled = () => api.__enabled === true;

  // Introspection for tests.
  api.debugState = () => ({
    conversations: [...conversations.keys()],
    bufferedFrames: (conversationId) => conversations.get(String(conversationId || ""))?.frames.length || 0,
    bufferedBytes: (conversationId) => conversations.get(String(conversationId || ""))?.bytes || 0,
    bufferedMetaCount: (conversationId) => conversations.get(String(conversationId || ""))?.imageMeta.size || 0,
    pendingRounds: rounds.size,
    roundKeys: [...rounds.keys()],
  });

  api.UNROUTED_KEY = UNROUTED_KEY;
  api.BUFFER_TTL_MS = BUFFER_TTL_MS;
  api.MAX_BUFFER_FRAMES = MAX_BUFFER_FRAMES;
  api.MAX_BUFFER_BYTES = MAX_BUFFER_BYTES;
  api.MAX_HTTP_BODY_BYTES = MAX_HTTP_BODY_BYTES;
  api.MAX_RECORD_BYTES = MAX_RECORD_BYTES;
  api.MAX_IMAGE_META_BYTES = MAX_IMAGE_META_BYTES;
  api.ROUND_FINALIZE_DELAY_MS = ROUND_FINALIZE_DELAY_MS;
  api.CONTROL_SAMPLE_RATE = CONTROL_SAMPLE_RATE;

  globalThis.MosaDevRawDiagnostics = api;
})();
