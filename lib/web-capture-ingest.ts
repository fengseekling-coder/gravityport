import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import sharp from "./sharp-runtime.js";
import { readVideoMetadataFromFile } from "./video-metadata.js";
import { createdAtTimestamp } from "./recent-window.js";
import { createReferenceAttachmentStore, type ReferenceAttachment } from "./reference-attachment-store.js";
import { PIXEL_HASH_VERSION, safePixelDigest } from "./image-pixel-hash.js";

const DEFAULT_PROJECT_ID = "default";
const DEFAULT_TEMP_ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;
const PROVIDER_CONFIG = {
  chatgpt: {
    label: "ChatGPT",
    sourceType: "web-chatgpt",
    skill: "ChatGPT web capture",
    tempPrefix: "chatgpt",
    assetIdPrefix: "web-chatgpt",
  },
  gemini: {
    label: "Gemini",
    sourceType: "web-gemini",
    skill: "Gemini web capture",
    tempPrefix: "gemini",
    assetIdPrefix: "web-gemini",
  },
  flow: {
    label: "Flow",
    sourceType: "web-flow",
    skill: "Flow web capture",
    tempPrefix: "flow",
    assetIdPrefix: "web-flow",
  },
  "google-ai-studio": {
    label: "Google AI Studio",
    sourceType: "web-google-ai-studio",
    skill: "Google AI Studio web capture",
    tempPrefix: "google-ai-studio",
    assetIdPrefix: "web-google-ai-studio",
  },
  jimeng: {
    label: "即梦",
    sourceType: "web-jimeng",
    skill: "Jimeng web capture",
    tempPrefix: "jimeng",
    assetIdPrefix: "web-jimeng",
  },
  midjourney: {
    label: "Midjourney",
    sourceType: "web-midjourney",
    skill: "Midjourney web capture",
    tempPrefix: "midjourney",
    assetIdPrefix: "web-midjourney",
  },
} as const;
const ALLOWED_PROVIDERS = new Set(Object.keys(PROVIDER_CONFIG));
type ProviderId = keyof typeof PROVIDER_CONFIG;
const MIME_TO_EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif" };
const VIDEO_MIME_TO_EXT: Record<string, string> = { "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov", "video/x-m4v": ".m4v" };
const VIDEO_PROVIDERS = new Set(["flow", "google-ai-studio", "jimeng", "midjourney"]);
// Providers whose visible-page prompt association is trusted enough to store
// as prompt_status="provider-visible-prompt" (still unverified by the provider).
const PROVIDER_VISIBLE_PROMPT_PROVIDERS = new Set(["gemini", "flow", "google-ai-studio", "jimeng", "midjourney"]);
const PROMPT_STATUSES = new Set(["user-message", "visible-caption", "not-available", "generation-tool-prompt", "provider-visible-prompt"]);
const PROMPT_SCOPES = new Set(["output", "attempt", "message", ""]);
const GENERATION_STATUSES = new Set(["unknown", "in_progress", "partial", "completed", "failed", "cancelled"]);
const MIME_TO_FORMATS: Record<string, Set<string>> = { "image/png": new Set(["png"]), "image/jpeg": new Set(["jpeg"]), "image/webp": new Set(["webp"]), "image/gif": new Set(["gif"]), "image/avif": new Set(["avif", "heif"]) };
export const WEB_CAPTURE_MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const WEB_CAPTURE_MAX_VIDEO_BYTES = 96 * 1024 * 1024;
export const WEB_CAPTURE_MAX_IMAGE_PIXELS = 40_000_000;
export const WEB_CAPTURE_MAX_BODY_BYTES = Math.ceil(Math.max(WEB_CAPTURE_MAX_IMAGE_BYTES, WEB_CAPTURE_MAX_VIDEO_BYTES) / 3) * 4 + 1024 * 1024;

type Metadata = Record<string, unknown>;

interface StoredAsset {
  id: string;
  project_id: string;
  prompt?: string;
  theme?: string;
  source?: Metadata;
  business_fields?: Metadata;
  created_at?: string;
  [key: string]: unknown;
}

interface Store {
  createAsset(params: Metadata, options?: Metadata): Promise<StoredAsset>;
  listAssets(filters: Metadata): Promise<StoredAsset[]>;
  updateMetadata?(projectId: string, assetId: string, metadata: Metadata): Promise<StoredAsset>;
  replaceAssetMedia?(projectId: string, assetId: string, input: Metadata, options?: Metadata): Promise<StoredAsset>;
  deleteAsset?(projectId: string, assetId: string): Promise<unknown>;
  permanentlyDeleteAsset?(projectId: string, assetId: string): Promise<unknown>;
  recordGenerationEvent?(input: Metadata): Promise<Metadata>;
  findAssetByContentHash?(projectId: string, contentHash: string): Promise<StoredAsset | null>;
  /** Absolute library-original path with identical content, or "" when the store cannot answer. */
  findOriginalByContentHash?(projectId: string, contentHash: string): Promise<string>;
  findAssetByPixelHash?(projectId: string, pixelHash: string): Promise<StoredAsset | null>;
  findAssetsByPixelHash?(projectId: string, pixelHash: string): Promise<StoredAsset[]>;
  findAssetByProviderIdentity?(projectId: string, provider: string, providerAssetId?: string, logicalOutputId?: string, mediaKind?: string): Promise<StoredAsset | null>;
  listAssetsByConversation?(projectId: string, conversationId: string): Promise<StoredAsset[]>;
  libraryDir?: string;
  assetsRoot?: string;
  [key: string]: unknown;
}
interface WebCaptureInput { provider?: string; mediaKind?: string; media_kind?: string; mimeType?: string; mime_type?: string; imageBase64?: string; image_base64?: string; imageBytes?: Buffer | Uint8Array; mediaBase64?: string; media_base64?: string; mediaBytes?: Buffer | Uint8Array; width?: number; height?: number; durationSeconds?: number; duration_seconds?: number; prompt?: string; prompt_status?: string; promptStatus?: string; prompt_source?: string; promptSource?: string; prompt_priority?: number; promptPriority?: number; prompt_scope?: string; promptScope?: string; generation_status?: string; generationStatus?: string; user_message?: string; userMessage?: string; generation_request_prompt?: string; generationRequestPrompt?: string; pageUrl?: string; page_url?: string; sourceMediaUrl?: string; source_media_url?: string; finalMediaUrl?: string; final_media_url?: string; mediaVariant?: string; media_variant?: string; conversationId?: string; conversation_id?: string; generationSessionTitle?: string; generation_session_title?: string; messageId?: string; message_id?: string; generationContextId?: string; generation_context_id?: string; providerToolCallId?: string; provider_tool_call_id?: string; providerGenerationCallId?: string; provider_generation_call_id?: string; providerResponseId?: string; provider_response_id?: string; providerAssetId?: string; provider_asset_id?: string; model?: string; capturedAt?: string; captured_at?: string; captureMode?: string; capture_mode?: string; assetId?: string; is_reference?: boolean; isReference?: boolean; extensionVersion?: string; extension_version?: string; }
interface IngestResult { status: string; reason?: string; asset?: StoredAsset; attachment?: ReferenceAttachment; contentHash: string; upgraded?: boolean; recipeMerged?: boolean; replacedAssetId?: string; }
interface WebCaptureIngest { ingest(input: WebCaptureInput, authToken?: string): Promise<IngestResult>; ingestFile(input: WebCaptureInput, mediaFilePath: string, authToken?: string): Promise<IngestResult>; upgradeMetadata(input: WebCaptureInput, authToken?: string): Promise<IngestResult>; status(): Record<string, unknown>; updateClientStatus(input: Metadata, authToken?: string): Record<string, unknown>; requestRetry(): Record<string, unknown>; assertToken(provided: string): void; readReference(projectId: string, fileName: string): Promise<{ stream: NodeJS.ReadableStream; fileName: string }>; pruneReferences(projectId: string, referencedIds: Iterable<string>): Promise<{ removed: number; retained: number; failed: number }>; tempRoot: string; token: string; }

const logicalCaptureLocks = new Map<string, Promise<unknown>>();

export async function cleanupWebCaptureTemp(tempRoot: string, { ttlMs = DEFAULT_TEMP_ORPHAN_TTL_MS, now = Date.now } = {}): Promise<number> {
  const root = resolve(tempRoot);
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return 0;
    throw error;
  }
  const cutoff = now() - ttlMs;
  let removed = 0;
  for (const name of names) {
    const path = join(root, name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.mtimeMs > cutoff) continue;
      await rm(path, { force: true });
      removed += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }
  return removed;
}

export function createWebCaptureIngest(options: { store?: Store; libraryDir?: string; tempRoot?: string; projectId?: string; token?: string; allowedOrigins?: string[]; onLibraryChange?: (projectId: string, result: IngestResult) => void | Promise<void>; } = {}): WebCaptureIngest {
  const store = options.store as Store;
  if (!store || typeof store.createAsset !== "function" || typeof store.listAssets !== "function") throw new Error("Web capture ingest requires a GravityPort store.");
  const libraryDir = resolve(options.libraryDir || store.libraryDir || store.assetsRoot!);
  const tempRoot = resolve(options.tempRoot || join(libraryDir, ".web-capture-tmp"));
  const referenceStore = createReferenceAttachmentStore(libraryDir);
  const projectId = options.projectId || DEFAULT_PROJECT_ID;
  const tokenSource = Object.hasOwn(options, "token") ? options.token : process.env.MOSA_WEB_CAPTURE_TOKEN;
  const token = String(tokenSource || "").trim();
  const allowedOriginCount = Array.isArray(options.allowedOrigins) ? options.allowedOrigins.length : 0;
  const maxConcurrentIngests = 4;
  let activeIngests = 0;
  const ingestWaiters: Array<() => void> = [];
  async function acquireIngestSlot(): Promise<void> {
    if (activeIngests < maxConcurrentIngests && ingestWaiters.length === 0) {
      activeIngests += 1;
      return;
    }
    // The releasing owner transfers its occupied slot directly to this waiter.
    // The waiter therefore must not increment activeIngests after waking.
    await new Promise<void>((resolveSlot) => ingestWaiters.push(resolveSlot));
  }
  function releaseIngestSlot(): void {
    const next = ingestWaiters.shift();
    if (next) {
      next();
      return;
    }
    activeIngests = Math.max(0, activeIngests - 1);
  }
  const state: { enabled: boolean; providers: string[]; lastIngestAt: string | null; lastExtensionVersion: string | null; lastImportCount: number; totalImported: number; totalSkipped: number; lastError: string | null; lastSkippedReason: string | null } = { enabled: Boolean(token) && allowedOriginCount > 0, providers: Object.keys(PROVIDER_CONFIG), lastIngestAt: null, lastExtensionVersion: null, lastImportCount: 0, totalImported: 0, totalSkipped: 0, lastError: null, lastSkippedReason: null };
  const recentActivity: Metadata[] = [];
  let retryRequestId = 0;
  let clientQueue: Metadata = { reportedAt: null, pending: 0, failed: 0, items: [] };
  function pushActivity(input: WebCaptureInput, result: IngestResult | null, error: unknown = null): void {
    const provider = String(input.provider || "").trim().toLowerCase();
    const asset = result?.asset;
    const promptStatus = String(asset?.source?.prompt_status || input.prompt_status || input.promptStatus || "not-available");
    recentActivity.unshift({
      at: new Date().toISOString(),
      provider: ALLOWED_PROVIDERS.has(provider) ? provider : "unknown",
      mediaKind: String(input.mediaKind || input.media_kind || "image") === "video" ? "video" : "image",
      status: error ? "failed" : String(result?.status || "unknown"),
      reason: error ? (error instanceof Error ? error.message : String(error)).slice(0, 240) : String(result?.reason || ""),
      assetId: String(asset?.id || result?.replacedAssetId || ""),
      promptStatus,
      upgraded: Boolean(result?.upgraded || result?.recipeMerged),
    });
    if (recentActivity.length > 20) recentActivity.length = 20;
  }
  function status(): Record<string, unknown> {
    return {
      ...state,
      tokenConfigured: Boolean(token),
      originConfigured: allowedOriginCount > 0,
      allowedOriginCount,
      queue: clientQueue,
      recentActivity: recentActivity.map((entry) => ({ ...entry })),
      retryRequestId,
    };
  }
  function updateClientStatus(input: Metadata = {}, authToken = ""): Record<string, unknown> {
    assertToken(authToken);
    // 0.15.38+ extensions report their version with every queue status, so the
    // Settings card knows it without waiting for a capture.
    const reportedVersion = String(input.extensionVersion || "").trim().slice(0, 64);
    if (reportedVersion) state.lastExtensionVersion = reportedVersion;
    const rawItems = Array.isArray(input.items) ? input.items.slice(0, 20) : [];
    const items = rawItems.map((entry) => {
      const value = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Metadata : {};
      const provider = String(value.provider || "").trim().toLowerCase();
      return {
        id: String(value.id || "").slice(0, 160),
        provider: ALLOWED_PROVIDERS.has(provider) ? provider : "unknown",
        mediaKind: String(value.mediaKind || "") === "video" ? "video" : "image",
        promptStatus: String(value.promptStatus || "not-available").slice(0, 80),
        generationStatus: String(value.generationStatus || "unknown").slice(0, 80),
        createdAt: Math.max(0, Number(value.createdAt || 0) || 0),
        updatedAt: Math.max(0, Number(value.updatedAt || 0) || 0),
        attempts: Math.max(0, Math.min(100, Math.trunc(Number(value.attempts || 0) || 0))),
        lastError: String(value.lastError || "").slice(0, 240),
      };
    });
    clientQueue = {
      reportedAt: new Date().toISOString(),
      pending: Math.max(0, Math.min(256, Math.trunc(Number(input.pending ?? items.length) || 0))),
      failed: Math.max(0, Math.min(256, Math.trunc(Number(input.failed || 0) || 0))),
      items,
    };
    return { ok: true, retryRequestId };
  }
  function requestRetry(): Record<string, unknown> {
    retryRequestId += 1;
    return { ok: true, retryRequestId };
  }
  function assertToken(provided: string): void {
    if (!token) { const e = new Error("Web capture is disabled until GRAVITYPORT_WEB_CAPTURE_TOKEN is configured.") as Error & { statusCode: number; code: string; expose: boolean }; e.statusCode = 503; e.code = "WEB_CAPTURE_DISABLED"; e.expose = true; throw e; }
    if (!safeTokenEqual(String(provided || "").trim(), token)) { const e = new Error("Unauthorized web capture token.") as Error & { statusCode: number; code: string }; e.statusCode = 401; e.code = "WEB_CAPTURE_UNAUTHORIZED"; throw e; }
  }
  async function performIngest(input: WebCaptureInput, authToken: string, mediaFilePath = ""): Promise<IngestResult> {
    assertToken(authToken);
    await acquireIngestSlot();
    try {
      // The Settings → 连接 card shows which extension version last reported
      // here, so every token-accepted capture refreshes it. A capture without
      // a version (very old extension) keeps the previous value.
      const extensionVersion = String(input.extensionVersion || input.extension_version || "").trim().slice(0, 64);
      if (extensionVersion) state.lastExtensionVersion = extensionVersion;
      const result = await ingestWebCapture({ store, referenceStore, tempRoot, projectId, input, mediaFilePath });
      state.lastIngestAt = new Date().toISOString();
      state.lastError = null;
      if (result.status === "imported") {
        state.lastImportCount = 1;
        state.totalImported += 1;
        state.lastSkippedReason = null;
      } else {
        state.lastImportCount = 0;
        state.totalSkipped += 1;
        state.lastSkippedReason = result.reason || "skipped";
      }
      if (result.status === "imported" || result.upgraded || result.recipeMerged) {
        await options.onLibraryChange?.(projectId, result);
      }
      pushActivity(input, result);
      return result;
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      pushActivity(input, null, error);
      throw error;
    } finally {
      releaseIngestSlot();
    }
  }
  async function ingest(input: WebCaptureInput = {}, authToken = ""): Promise<IngestResult> {
    return performIngest(input, authToken);
  }
  async function ingestFile(input: WebCaptureInput = {}, mediaFilePath = "", authToken = ""): Promise<IngestResult> {
    try {
      return await performIngest(input, authToken, mediaFilePath);
    } finally {
      if (mediaFilePath) await rm(mediaFilePath, { force: true }).catch(() => {});
    }
  }
  async function upgradeMetadata(input: WebCaptureInput = {}, authToken = ""): Promise<IngestResult> {
    assertToken(authToken);
    try {
      const result = await upgradeWebCaptureMetadata({ store, projectId, input });
      if (result.upgraded || result.recipeMerged) await options.onLibraryChange?.(projectId, result);
      pushActivity(input, result);
      return result;
    } catch (error) {
      pushActivity(input, null, error);
      throw error;
    }
  }
  return { ingest, ingestFile, upgradeMetadata, status, updateClientStatus, requestRetry, assertToken, readReference: referenceStore.read, pruneReferences: referenceStore.pruneUnused, tempRoot, token };
}

async function upgradeWebCaptureMetadata({ store, projectId, input }: { store: Store; projectId: string; input: WebCaptureInput }): Promise<IngestResult> {
  const provider = String(input.provider || "").trim().toLowerCase();
  if (!ALLOWED_PROVIDERS.has(provider)) throw webCaptureError(`Unsupported provider: ${provider || "(empty)"}.`, 400, "WEB_CAPTURE_BAD_PROVIDER");
  const providerAssetId = String(input.providerAssetId || input.provider_asset_id || "").trim();
  const logicalOutputId = logicalCaptureKey(projectId, provider, input);
  const sourceMediaUrl = sanitizeStoredMediaUrl(input.sourceMediaUrl || input.source_media_url);
  const upgradeMediaKind = String(input.mediaKind || input.media_kind || "image").trim().toLowerCase() === "video" ? "video" : "image";
  let assets: StoredAsset[] | null = null;
  let asset = typeof store.findAssetByProviderIdentity === "function"
    ? await store.findAssetByProviderIdentity(projectId, provider, providerAssetId, logicalOutputId, upgradeMediaKind)
    : null;
  if (!asset && typeof store.findAssetByProviderIdentity !== "function") {
    const listedAssets = await Promise.all([
      store.listAssets({ projectId }),
      store.listAssets({ projectId, archived: true }).catch(() => []),
    ]).then(([active, archived]) => [...active, ...archived]);
    assets = listedAssets;
    asset = findLogicalProviderAsset(listedAssets, provider, providerAssetId, logicalOutputId);
  }
  if (!asset && sourceMediaUrl) {
    let listedAssets = assets;
    if (!listedAssets) {
      listedAssets = await Promise.all([
        store.listAssets({ projectId }),
        store.listAssets({ projectId, archived: true }).catch(() => []),
      ]).then(([active, archived]) => [...active, ...archived]);
      assets = listedAssets;
    }
    asset = (listedAssets || []).find((candidate) => {
      if (String(candidate.source?.provider || "").trim().toLowerCase() !== provider) return false;
      const occurrences = Array.isArray(candidate.source?.capture_occurrences) ? candidate.source.capture_occurrences : [];
      return occurrences.some((entry) => sanitizeStoredMediaUrl((entry as Metadata)?.source_media_url) === sourceMediaUrl);
    }) || null;
  }
  if (!asset) throw webCaptureError("Archived capture not found for metadata upgrade.", 404, "WEB_CAPTURE_ASSET_NOT_FOUND");

  const suppliedPromptStatus = String(input.prompt_status || input.promptStatus || "").trim();
  const trustedPrompt = ["generation-tool-prompt", "visible-caption"].includes(suppliedPromptStatus)
    || (PROVIDER_VISIBLE_PROMPT_PROVIDERS.has(provider) && suppliedPromptStatus === "provider-visible-prompt");
  const prompt = trustedPrompt ? String(input.prompt || "").trim() : "";
  const promptSource = String(input.prompt_source || input.promptSource || "").trim();
  const promptPriority = Math.max(0, Math.min(1000, Number(input.prompt_priority ?? input.promptPriority) || 0));
  const promptScope = normalizePromptScope(input.prompt_scope || input.promptScope);
  const model = String(input.model || "").trim();
  const userMessage = String(input.user_message || input.userMessage || "").trim();
  const upgraded = await maybeUpgradePrompt(store, asset, {
    prompt,
    promptStatus: prompt ? suppliedPromptStatus : "not-available",
    userMessage,
    promptSource,
    promptPriority,
    promptScope,
    model,
    provider,
  });
  if (upgraded) asset = upgraded;
  asset = await maybeStoreRequestPrompt(store, asset, requestPromptFor(provider, input)) || asset;

  const generationStatus = normalizeGenerationStatus(input.generation_status || input.generationStatus);
  if (generationStatus !== "unknown" && generationStatus !== String(asset.source?.generation_status || "unknown") && typeof store.updateMetadata === "function") {
    asset = await store.updateMetadata(projectId, asset.id, {
      business_fields: { ...(asset.business_fields || {}), generation_status: generationStatus },
      source: { ...(asset.source || {}), generation_status: generationStatus },
      recipe_change_summary: "Capture metadata upgraded",
    });
  }
  return {
    status: "skipped",
    reason: upgraded ? "already-archived-prompt-upgraded" : "already-archived-metadata-checked",
    asset,
    contentHash: String(asset.source?.content_sha256 || ""),
    upgraded: Boolean(upgraded),
  };
}

export async function ingestWebCapture(options: { store: Store; referenceStore?: ReturnType<typeof createReferenceAttachmentStore>; tempRoot: string; projectId?: string; input?: WebCaptureInput; mediaFilePath?: string; }): Promise<IngestResult> {
  const input = options.input || {};
  const projectId = options.projectId || DEFAULT_PROJECT_ID;
  const provider = String(input.provider || "").trim().toLowerCase();
  const logicalKey = logicalCaptureKey(projectId, provider, input);
  if (!logicalKey) return ingestWebCaptureUnlocked(options);
  const previous = logicalCaptureLocks.get(logicalKey) || Promise.resolve();
  const operation = previous.catch(() => undefined).then(() => ingestWebCaptureUnlocked(options));
  logicalCaptureLocks.set(logicalKey, operation);
  try {
    return await operation;
  } finally {
    if (logicalCaptureLocks.get(logicalKey) === operation) logicalCaptureLocks.delete(logicalKey);
  }
}

async function ingestWebCaptureUnlocked(options: { store: Store; referenceStore?: ReturnType<typeof createReferenceAttachmentStore>; tempRoot: string; projectId?: string; input?: WebCaptureInput; mediaFilePath?: string; }): Promise<IngestResult> {
  const { store, tempRoot, projectId = DEFAULT_PROJECT_ID, input = {} } = options;
  const provider = String(input.provider || "").trim().toLowerCase();
  if (!ALLOWED_PROVIDERS.has(provider)) { const e = new Error(`Unsupported provider: ${provider || "(empty)"}.`) as Error & { statusCode: number; code: string }; e.statusCode = 400; e.code = "WEB_CAPTURE_BAD_PROVIDER"; throw e; }
  const mediaKind = String(input.mediaKind || input.media_kind || "image").trim().toLowerCase();
  if (mediaKind === "video") return ingestWebVideoCapture({ ...options, projectId, input, provider });
  if (mediaKind !== "image") throw webCaptureError(`Unsupported media kind: ${mediaKind}.`, 400, "WEB_CAPTURE_BAD_MEDIA_KIND");
  const providerConfig = PROVIDER_CONFIG[provider as ProviderId];
  const mimeType = normalizeMime(input.mimeType || input.mime_type || "image/png"); const ext = MIME_TO_EXT[mimeType];
  if (!ext) { const e = new Error(`Unsupported image mime type: ${mimeType}`) as Error & { statusCode: number; code: string }; e.statusCode = 400; e.code = "WEB_CAPTURE_BAD_MIME"; throw e; }
  const imageBytes = decodeImageBytes(input);
  if (!imageBytes.length) { const e = new Error("imageBase64 is required.") as Error & { statusCode: number; code: string }; e.statusCode = 400; e.code = "WEB_CAPTURE_BAD_IMAGE"; throw e; }
  const isReference = Boolean(input.is_reference ?? input.isReference);
  const MIN_IMAGE_BYTES = 20 * 1024;
  if (!isReference && imageBytes.length < MIN_IMAGE_BYTES) { const e = new Error(`Image too small (${imageBytes.length} < ${MIN_IMAGE_BYTES}).`) as Error & { statusCode: number; code: string }; e.statusCode = 400; e.code = "WEB_CAPTURE_IMAGE_TOO_SMALL"; throw e; }
  if (imageBytes.length > WEB_CAPTURE_MAX_IMAGE_BYTES) { const e = new Error("Image exceeds 15 MiB limit.") as Error & { statusCode: number; code: string }; e.statusCode = 413; e.code = "WEB_CAPTURE_IMAGE_TOO_LARGE"; throw e; }
  const imageMetadata = await inspectImageBytes(imageBytes);
  if (!MIME_TO_FORMATS[mimeType]?.has(imageMetadata.format)) { const e = new Error(`MIME mismatch: ${mimeType} vs ${imageMetadata.format}`) as Error & { statusCode: number; code: string }; e.statusCode = 400; e.code = "WEB_CAPTURE_MIME_MISMATCH"; throw e; }
  const contentHash = createHash("sha256").update(imageBytes).digest("hex");
  let prompt = String(input.prompt || "").trim(); const userMessage = String(input.user_message || input.userMessage || "").trim();
  const suppliedPromptStatus = String(input.prompt_status || input.promptStatus || "").trim();
  const promptSource = String(input.prompt_source || input.promptSource || "").trim();
  const promptPriority = Math.max(0, Math.min(1000, Number(input.prompt_priority ?? input.promptPriority) || 0));
  const promptScope = normalizePromptScope(input.prompt_scope || input.promptScope);
  // An uploaded reference is not a generation, so it never has a request Prompt.
  const requestPrompt = isReference ? "" : requestPromptFor(provider, input);
  const generationStatus = normalizeGenerationStatus(input.generation_status || input.generationStatus);
  const trustedGenerationPrompt = ["generation-tool-prompt", "visible-caption"].includes(suppliedPromptStatus);
  // Gemini, Flow, AI Studio, Jimeng, and Midjourney can expose a narrowly
  // associated visible user prompt. None is verified to be the exact prompt
  // executed by the provider.
  const providerVisiblePrompt = PROVIDER_VISIBLE_PROMPT_PROVIDERS.has(provider)
    && suppliedPromptStatus === "provider-visible-prompt";
  if (!trustedGenerationPrompt && !providerVisiblePrompt) prompt = "";
  let promptStatus = PROMPT_STATUSES.has(suppliedPromptStatus) ? suppliedPromptStatus : prompt ? "user-message" : "not-available";
  if (!prompt) promptStatus = "not-available";
  const normalizedPromptStatus = trustedGenerationPrompt || providerVisiblePrompt
    ? (prompt ? suppliedPromptStatus : "not-available")
    : promptStatus;
  const pixelHash = imageMetadata.pixelHash || "";
  const projectAssets = onceProjectListing(store, projectId);
  const pageUrl = String(input.pageUrl || input.page_url || "").trim(); const conversationId = String(input.conversationId || input.conversation_id || "").trim();
  const generationSessionTitle = String(input.generationSessionTitle || input.generation_session_title || "").trim().slice(0, 200);
  const sourceMediaUrl = sanitizeStoredMediaUrl(input.sourceMediaUrl || input.source_media_url);
  const finalMediaUrl = sanitizeStoredMediaUrl(input.finalMediaUrl || input.final_media_url);
  const messageId = String(input.messageId || input.message_id || "").trim(); const model = String(input.model || "").trim();
  const generationContextId = String(input.generationContextId || input.generation_context_id || "").trim();
  const providerToolCallId = String(input.providerToolCallId || input.provider_tool_call_id || "").trim();
  const providerGenerationCallId = String(input.providerGenerationCallId || input.provider_generation_call_id || "").trim();
  const providerResponseId = String(input.providerResponseId || input.provider_response_id || "").trim();
  const providerAssetId = String(input.providerAssetId || input.provider_asset_id || "").trim();
  const logicalOutputId = logicalCaptureKey(projectId, provider, input);
  const captureSessionId = conversationId ? `${provider}:${conversationId}` : "";
  const generationBatchId = captureSessionId && messageId ? `${captureSessionId}:${messageId}` : "";
  const capturedAt = String(input.capturedAt || input.captured_at || new Date().toISOString());
  const captureMode = String(input.captureMode || input.capture_mode || "automatic").trim().toLowerCase() === "manual" ? "manual" : "automatic";
  const captureOccurrence = {
    provider,
    type: providerConfig.sourceType,
    page_url: pageUrl || null,
    source_media_url: sourceMediaUrl || null,
    final_media_url: finalMediaUrl || null,
    conversation_id: conversationId || null,
    message_id: messageId || null,
    model: model || null,
    captured_at: capturedAt,
    capture_mode: captureMode,
    generation_context_id: generationContextId || null,
    generation_status: generationStatus,
  };
  const referenceLibraryDir = store.libraryDir || (store.assetsRoot ? dirname(store.assetsRoot) : dirname(tempRoot));
  const referenceStore = options.referenceStore || createReferenceAttachmentStore(resolve(referenceLibraryDir));
  if (isReference) {
    const linkSource = await findReferenceHardlinkSource(store, projectId, contentHash);
    const saved = await referenceStore.save({
      projectId, bytes: imageBytes, extension: ext, mimeType, width: imageMetadata.width, height: imageMetadata.height,
      provider, pageUrl, conversationId, messageId, generationContextId, providerAssetId, capturedAt, userMessage,
      linkSource,
    });
    return {
      status: saved.created ? "imported" : "skipped",
      reason: saved.created
        ? undefined
        : saved.duplicateKind === "pixel"
          ? "reference-already-archived-same-pixels"
          : "reference-already-archived-same-content",
      attachment: saved.attachment,
      contentHash,
    };
  }
  const finalizeDuplicate = async (duplicate: StoredAsset): Promise<IngestResult> => {
    const existingWithOccurrence = await recordCaptureOccurrence(store, duplicate, captureOccurrence) || duplicate;
    // A provider-visible prompt must not upgrade an asset archived from a
    // different provider when the bytes happen to be identical.
    const existingProvider = String(existingWithOccurrence.source?.provider || "").trim().toLowerCase();
    const duplicatePromptAllowed = normalizedPromptStatus !== "provider-visible-prompt" || existingProvider === provider;
    const mergedRecipe = await mergeDuplicateGenerationRecipe(store, existingWithOccurrence, {
      projectAssets,
      referenceStore,
      projectId,
      conversationId,
      generationContextId,
      providerToolCallId,
      providerGenerationCallId,
      providerResponseId,
      providerAssetId,
      capturedAt,
      messageId,
      prompt: duplicatePromptAllowed ? prompt : "",
      promptStatus: duplicatePromptAllowed ? normalizedPromptStatus : "not-available",
      promptSource,
      promptPriority: duplicatePromptAllowed ? promptPriority : 0,
      promptScope: duplicatePromptAllowed ? promptScope : "",
      generationStatus,
      userMessage,
      model,
      provider,
    });
    const upgraded = await maybeUpgradePrompt(store, mergedRecipe.asset, {
      prompt: duplicatePromptAllowed ? prompt : "",
      promptStatus: duplicatePromptAllowed ? normalizedPromptStatus : "not-available",
      userMessage,
      promptSource,
      promptPriority: duplicatePromptAllowed ? promptPriority : 0,
      promptScope: duplicatePromptAllowed ? promptScope : "",
      model,
      provider,
    });
    const asset = await maybeStoreRequestPrompt(store, upgraded || mergedRecipe.asset, requestPrompt) || upgraded || mergedRecipe.asset;
    const titledAsset = generationSessionTitle
      ? await maybeStoreSessionTitle(store, asset, generationSessionTitle) || asset
      : asset;
    // A re-observation of an already-archived image without any provider
    // identity used to append a fresh generation event on every capture (its
    // occurrence:<time> id never matches), so the history showed phantom
    // regenerations. Only identified observations may record an event.
    if (providerGenerationCallId || generationContextId || messageId || providerAssetId) {
      await recordCapturedGeneration(store, titledAsset, {
        projectId,
        provider,
        generationContextId,
        providerToolCallId,
        providerGenerationCallId,
        providerResponseId,
        providerAssetId,
        conversationId,
        messageId,
        generationBatchId,
        model,
        userMessage,
        prompt,
        promptStatus: normalizedPromptStatus,
        promptScope,
        generationStatus,
        references: asset.references,
        capturedAt,
      });
    }
    const sameBytes = titledAsset.source?.content_sha256 === contentHash;
    return {
      status: "skipped",
      reason: upgraded
        ? "already-archived-prompt-upgraded"
        : mergedRecipe.merged
          ? "already-archived-recipe-merged"
          : sameBytes ? "already-archived-same-content" : "already-archived-same-pixels",
      asset: titledAsset,
      contentHash,
      upgraded: Boolean(upgraded),
      recipeMerged: mergedRecipe.merged,
    };
  };
  let logicalExistingForReplacement: StoredAsset | null = null;
  if (providerAssetId || logicalOutputId) {
    const logicalExisting = typeof store.findAssetByProviderIdentity === "function"
      ? await store.findAssetByProviderIdentity(projectId, provider, providerAssetId, logicalOutputId, "image")
      : findLogicalProviderAsset(await projectAssets(), provider, providerAssetId, logicalOutputId);
    if (logicalExisting) {
      const existingHash = String(logicalExisting.source?.content_sha256 || "").trim();
      if (existingHash === contentHash) return finalizeDuplicate(logicalExisting);
      if (["completed", "failed", "cancelled"].includes(generationStatus)
        && typeof store.replaceAssetMedia === "function"
        && isProviderMediaUpgrade(logicalExisting, {
          pixels: imageMetadata.width * imageMetadata.height,
          mediaVariant: normalizeMediaVariant(input.mediaVariant ?? input.media_variant),
          generationStatus,
        })) {
        logicalExistingForReplacement = logicalExisting;
      } else {
        return finalizeDuplicate(logicalExisting);
      }
    }
  }
  if (!logicalExistingForReplacement) {
    const existing = await findArchivedDuplicate(store, projectId, contentHash, pixelHash, projectAssets);
    if (existing) return finalizeDuplicate(existing);
  }
  await mkdir(tempRoot, { recursive: true });
  const tempName = `${providerConfig.tempPrefix}-${Date.now()}-${randomBytes(4).toString("hex")}${ext}`; const tempPath = join(tempRoot, tempName);
  await writeFile(tempPath, imageBytes);
  try {
    const explicitAssetId = String(input.assetId || "").trim();
    let assetId = sanitizeAssetId(explicitAssetId || `${providerConfig.assetIdPrefix}-${contentHash.slice(0, 12)}`, providerConfig.assetIdPrefix);
    const references = await turnReferences(store, projectAssets, referenceStore, projectId, { conversationId, generationContextId, capturedAt, selfAssetId: assetId });
    const assetInput = {
      projectId,
      imagePath: tempPath,
      assetId,
      fileName: tempName,
      prompt,
      skill: providerConfig.skill,
      theme: promptTheme(prompt, providerConfig.label),
      tags: [provider, "web-capture", captureMode === "manual" ? "manual-capture" : "auto-archived"],
      category: "",
      references,
      created_at: capturedAt,
      sourceType: providerConfig.sourceType,
      business_fields: {
        auto_archived: captureMode !== "manual",
        capture_mode: captureMode,
        generation_context_id: generationContextId || null,
        capture_context_id: generationContextId || null,
        verification_level: "observed",
        is_reference: false,
        capture_channel: "chrome-extension",
        prompt_status: normalizedPromptStatus,
        prompt_source: promptSource || null,
        prompt_priority: promptPriority || 0,
        prompt_scope: promptScope || null,
        generation_status: generationStatus,
        user_message: userMessage || null,
        file_bytes: imageBytes.length,
        mime_type: mimeType,
        width: imageMetadata.width,
        height: imageMetadata.height,
      },
      source: {
        generation_tool: "web-ui",
        provider,
        type: providerConfig.sourceType,
        capture_mode: captureMode,
        // "original" or "preview": Midjourney previews are 640px WebPs while
        // the full-size PNG is cookie-gated; the variant tells which was kept.
        media_variant: normalizeMediaVariant(input.mediaVariant ?? input.media_variant),
        generation_context_id: generationContextId || null,
        capture_context_id: generationContextId || null,
        generation_status: generationStatus,
        provider_tool_call_id: providerToolCallId || null,
        provider_generation_call_id: providerGenerationCallId || null,
        provider_response_id: providerResponseId || null,
        provider_asset_id: providerAssetId || null,
        logical_output_id: logicalOutputId || null,
        verification_level: "observed",
        capture_occurrences: [captureOccurrence],
        model: model || null,
        page_url: pageUrl || null,
        conversation_id: conversationId || null,
        ...(generationSessionTitle ? { generation_session_title: generationSessionTitle } : {}),
        message_id: messageId || null,
        capture_session_id: captureSessionId || null,
        generation_batch_id: generationBatchId || null,
        prompt_status: normalizedPromptStatus,
        prompt_source: promptSource || null,
        prompt_priority: promptPriority || 0,
        prompt_scope: promptScope || null,
        user_message: userMessage || null,
        generation_request_prompt: requestPrompt || null,
        captured_at: capturedAt,
        capture_extension_version: String(input.extensionVersion || input.extension_version || ""),
        content_sha256: contentHash,
        pixel_sha256: pixelHash || null,
        pixel_hash_version: pixelHash ? PIXEL_HASH_VERSION : null,
      },
    };
    if (logicalExistingForReplacement && typeof store.replaceAssetMedia === "function") {
      const replaced = await store.replaceAssetMedia(projectId, logicalExistingForReplacement.id, {
        imagePath: tempPath,
        fileName: tempName,
        contentHash,
        pixelHash,
        pixelHashVersion: pixelHash ? PIXEL_HASH_VERSION : "",
        business_fields: assetInput.business_fields,
        source: assetInput.source,
      }, { trustedSourceRoots: [tempRoot], ingestMode: captureMode });
      const merged = await finalizeDuplicate(replaced);
      return {
        ...merged,
        status: "imported",
        reason: "logical-output-media-upgraded",
        asset: merged.asset || replaced,
        contentHash,
        replacedAssetId: logicalExistingForReplacement.id,
      };
    }
    let asset: StoredAsset;
    try {
      asset = await store.createAsset(assetInput, { trustedSourceRoots: [tempRoot], ingestMode: captureMode === "manual" ? "manual" : "automatic" });
    } catch (error) {
      // The compact deterministic ID is useful for ordinary captures, but two
      // independent runtimes can reserve the same filename before either one
      // publishes metadata. A unique candidate lets both attempts reach the
      // store's transactional content/pixel identity check. It also keeps a
      // genuine short-hash collision importable instead of misclassifying it.
      if (explicitAssetId || !isAssetAlreadyExists(error)) throw error;
      assetId = sanitizeAssetId(`${providerConfig.assetIdPrefix}-${contentHash.slice(0, 24)}-${randomBytes(4).toString("hex")}`, providerConfig.assetIdPrefix);
      asset = await store.createAsset({ ...assetInput, assetId }, { trustedSourceRoots: [tempRoot], ingestMode: captureMode === "manual" ? "manual" : "automatic" });
    }
    await recordCapturedGeneration(store, asset, {
      projectId,
      provider,
      generationContextId,
      providerToolCallId,
      providerGenerationCallId,
      providerResponseId,
      providerAssetId,
      conversationId,
      messageId,
      generationBatchId,
      model,
      userMessage,
      prompt,
      promptStatus: normalizedPromptStatus,
      promptScope,
      generationStatus,
      references: asset.references,
      capturedAt,
    });
    return {
      status: "imported",
      asset,
      contentHash,
    };
  } catch (error) {
    if (isAutomaticImportSuppressed(error)) return { status: "skipped", reason: "suppressed-after-delete", contentHash };
    if (isAutomaticIngestDuplicate(error)) {
      const duplicateId = String((error as { assetId?: unknown }).assetId || "");
      const duplicate = duplicateId
        ? (await projectAssets()).find((asset) => asset.id === duplicateId)
          || await findArchivedDuplicate(store, projectId, contentHash, pixelHash, projectAssets)
        : await findArchivedDuplicate(store, projectId, contentHash, pixelHash, projectAssets);
      if (duplicate) {
        return finalizeDuplicate(duplicate);
      }
    }
    throw error;
  } finally { await rm(tempPath, { force: true }).catch(() => {}); }
}

async function ingestWebVideoCapture(options: {
  store: Store;
  referenceStore?: ReturnType<typeof createReferenceAttachmentStore>;
  tempRoot: string;
  projectId: string;
  input: WebCaptureInput;
  provider: string;
  mediaFilePath?: string;
}): Promise<IngestResult> {
  const { store, tempRoot, projectId, input, provider } = options;
  if (!VIDEO_PROVIDERS.has(provider)) throw webCaptureError(`Provider does not support web video capture: ${provider}.`, 400, "WEB_CAPTURE_BAD_VIDEO_PROVIDER");
  if (Boolean(input.is_reference ?? input.isReference)) throw webCaptureError("Video reference capture is not supported.", 400, "WEB_CAPTURE_BAD_VIDEO_REFERENCE");
  const providerConfig = PROVIDER_CONFIG[provider as ProviderId];
  const mimeType = normalizeMime(input.mimeType || input.mime_type || "video/mp4");
  const ext = VIDEO_MIME_TO_EXT[mimeType];
  if (!ext) throw webCaptureError(`Unsupported video mime type: ${mimeType}`, 400, "WEB_CAPTURE_BAD_MIME");
  const MIN_VIDEO_BYTES = 64 * 1024;
  let videoBytes: Buffer | null = null;
  let videoSize = 0;
  let uploadedVideoPath = "";
  let containerHeader: Buffer;
  let contentHash: string;
  if (options.mediaFilePath) {
    const uploaded = await inspectTrustedCaptureTempFile(tempRoot, options.mediaFilePath);
    uploadedVideoPath = uploaded.path;
    videoSize = uploaded.size;
    containerHeader = uploaded.header;
    contentHash = await sha256File(uploaded.path);
  } else {
    videoBytes = decodeMediaBytes(input);
    videoSize = videoBytes.length;
    containerHeader = videoBytes;
    contentHash = createHash("sha256").update(videoBytes).digest("hex");
  }
  if (!videoSize) throw webCaptureError("Video media bytes are required.", 400, "WEB_CAPTURE_BAD_VIDEO");
  if (videoSize < MIN_VIDEO_BYTES) throw webCaptureError(`Video too small (${videoSize} < ${MIN_VIDEO_BYTES}).`, 400, "WEB_CAPTURE_VIDEO_TOO_SMALL");
  if (videoSize > WEB_CAPTURE_MAX_VIDEO_BYTES) throw webCaptureError("Video exceeds 96 MiB limit.", 413, "WEB_CAPTURE_VIDEO_TOO_LARGE");
  assertVideoContainer(containerHeader, mimeType);
  let prompt = String(input.prompt || "").trim();
  const userMessage = String(input.user_message || input.userMessage || "").trim();
  const suppliedPromptStatus = String(input.prompt_status || input.promptStatus || "").trim();
  const promptSource = String(input.prompt_source || input.promptSource || "").trim();
  const promptPriority = Math.max(0, Math.min(1000, Number(input.prompt_priority ?? input.promptPriority) || 0));
  const promptScope = normalizePromptScope(input.prompt_scope || input.promptScope);
  const generationStatus = normalizeGenerationStatus(input.generation_status || input.generationStatus);
  const trustedGenerationPrompt = ["generation-tool-prompt", "visible-caption"].includes(suppliedPromptStatus);
  const providerVisiblePrompt = suppliedPromptStatus === "provider-visible-prompt";
  if (!trustedGenerationPrompt && !providerVisiblePrompt) prompt = "";
  const normalizedPromptStatus = prompt && (trustedGenerationPrompt || providerVisiblePrompt)
    ? suppliedPromptStatus
    : "not-available";
  const projectAssets = onceProjectListing(store, projectId);
  const pageUrl = String(input.pageUrl || input.page_url || "").trim();
  const sourceMediaUrl = sanitizeStoredMediaUrl(input.sourceMediaUrl || input.source_media_url);
  const finalMediaUrl = sanitizeStoredMediaUrl(input.finalMediaUrl || input.final_media_url);
  const conversationId = String(input.conversationId || input.conversation_id || "").trim();
  const messageId = String(input.messageId || input.message_id || "").trim();
  const model = String(input.model || "").trim();
  const generationContextId = String(input.generationContextId || input.generation_context_id || "").trim();
  const providerToolCallId = String(input.providerToolCallId || input.provider_tool_call_id || "").trim();
  const providerGenerationCallId = String(input.providerGenerationCallId || input.provider_generation_call_id || "").trim();
  const providerResponseId = String(input.providerResponseId || input.provider_response_id || "").trim();
  const providerAssetId = String(input.providerAssetId || input.provider_asset_id || "").trim();
  const captureSessionId = conversationId ? `${provider}:${conversationId}` : "";
  const generationBatchId = captureSessionId && messageId ? `${captureSessionId}:${messageId}` : "";
  const capturedAt = String(input.capturedAt || input.captured_at || new Date().toISOString());
  const captureMode = String(input.captureMode || input.capture_mode || "automatic").trim().toLowerCase() === "manual" ? "manual" : "automatic";
  const captureOccurrence = {
    provider,
    type: providerConfig.sourceType,
    media_kind: "video",
    page_url: pageUrl || null,
    source_media_url: sourceMediaUrl || null,
    final_media_url: finalMediaUrl || null,
    conversation_id: conversationId || null,
    message_id: messageId || null,
    model: model || null,
    captured_at: capturedAt,
    capture_mode: captureMode,
    generation_context_id: generationContextId || null,
    generation_status: generationStatus,
  };
  const referenceLibraryDir = store.libraryDir || (store.assetsRoot ? dirname(store.assetsRoot) : dirname(tempRoot));
  const referenceStore = options.referenceStore || createReferenceAttachmentStore(resolve(referenceLibraryDir));

  const finalizeDuplicate = async (duplicate: StoredAsset): Promise<IngestResult> => {
    const existingWithOccurrence = await recordCaptureOccurrence(store, duplicate, captureOccurrence) || duplicate;
    const mergedRecipe = await mergeDuplicateGenerationRecipe(store, existingWithOccurrence, {
      projectAssets,
      referenceStore,
      projectId,
      conversationId,
      generationContextId,
      providerToolCallId,
      providerGenerationCallId,
      providerResponseId,
      providerAssetId,
      capturedAt,
      messageId,
      prompt,
      promptStatus: normalizedPromptStatus,
      promptSource,
      promptPriority,
      promptScope,
      generationStatus,
      userMessage,
      model,
      provider,
    });
    const upgraded = await maybeUpgradePrompt(store, mergedRecipe.asset, {
      prompt,
      promptStatus: normalizedPromptStatus,
      userMessage,
      promptSource,
      promptPriority,
      promptScope,
      model,
      provider,
    });
    const asset = upgraded || mergedRecipe.asset;
    await recordCapturedGeneration(store, asset, {
      projectId,
      provider,
      generationContextId,
      providerToolCallId,
      providerGenerationCallId,
      providerResponseId,
      providerAssetId,
      conversationId,
      messageId,
      generationBatchId,
      model,
      userMessage,
      prompt,
      promptStatus: normalizedPromptStatus,
      promptScope,
      generationStatus,
      references: asset.references,
      capturedAt,
    });
    return {
      status: "skipped",
      reason: upgraded
        ? "already-archived-prompt-upgraded"
        : mergedRecipe.merged
          ? "already-archived-recipe-merged"
          : "already-archived-same-content",
      asset,
      contentHash,
      upgraded: Boolean(upgraded),
      recipeMerged: mergedRecipe.merged,
    };
  };

  const existing = await findArchivedDuplicate(store, projectId, contentHash, "", projectAssets);
  if (existing) {
    if (uploadedVideoPath) await rm(uploadedVideoPath, { force: true }).catch(() => {});
    return finalizeDuplicate(existing);
  }
  await mkdir(tempRoot, { recursive: true });
  const tempName = `${providerConfig.tempPrefix}-video-${Date.now()}-${randomBytes(4).toString("hex")}${ext}`;
  const tempPath = uploadedVideoPath || join(tempRoot, tempName);
  if (!uploadedVideoPath) await writeFile(tempPath, videoBytes!);
  // Dimensions and duration read from the file itself are the truth; the
  // values a provider page reports (e.g. Jimeng's fixed duration of 7 for a
  // 6.08 s video, or 0×0 when its API carries none) are only the fallback
  // for containers this parser cannot read (WebM, truncated files).
  const fileVideoMeta = await readVideoMetadataFromFile(tempPath).catch(() => null);
  const width = fileVideoMeta?.width || normalizeMediaMetric(input.width, 16_384);
  const height = fileVideoMeta?.height || normalizeMediaMetric(input.height, 16_384);
  const durationSeconds = fileVideoMeta?.durationSeconds || normalizeMediaMetric(input.durationSeconds ?? input.duration_seconds, 3600, true);
  try {
    const explicitAssetId = String(input.assetId || "").trim();
    let assetId = sanitizeAssetId(explicitAssetId || `${providerConfig.assetIdPrefix}-video-${contentHash.slice(0, 12)}`, providerConfig.assetIdPrefix);
    const references = await turnReferences(store, projectAssets, referenceStore, projectId, { conversationId, generationContextId, capturedAt, selfAssetId: assetId });
    const assetInput = {
      projectId,
      imagePath: tempPath,
      assetId,
      fileName: tempName,
      prompt,
      skill: providerConfig.skill,
      theme: promptTheme(prompt, providerConfig.label),
      tags: [provider, "web-capture", "video", captureMode === "manual" ? "manual-capture" : "auto-archived"],
      category: "",
      references,
      created_at: capturedAt,
      sourceType: providerConfig.sourceType,
      business_fields: {
        auto_archived: captureMode !== "manual",
        capture_mode: captureMode,
        generation_context_id: generationContextId || null,
        capture_context_id: generationContextId || null,
        verification_level: "observed",
        is_reference: false,
        capture_channel: "chrome-extension",
        media_kind: "video",
        prompt_status: normalizedPromptStatus,
        prompt_source: promptSource || null,
        prompt_priority: promptPriority || 0,
        prompt_scope: promptScope || null,
        generation_status: generationStatus,
        user_message: userMessage || null,
        file_bytes: videoSize,
        mime_type: mimeType,
        width: width || null,
        height: height || null,
        duration_seconds: durationSeconds || null,
      },
      source: {
        generation_tool: "web-ui",
        provider,
        type: providerConfig.sourceType,
        media_kind: "video",
        capture_mode: captureMode,
        media_variant: normalizeMediaVariant(input.mediaVariant ?? input.media_variant),
        generation_context_id: generationContextId || null,
        capture_context_id: generationContextId || null,
        generation_status: generationStatus,
        provider_tool_call_id: providerToolCallId || null,
        provider_generation_call_id: providerGenerationCallId || null,
        provider_response_id: providerResponseId || null,
        provider_asset_id: providerAssetId || null,
        verification_level: "observed",
        capture_occurrences: [captureOccurrence],
        model: model || null,
        page_url: pageUrl || null,
        conversation_id: conversationId || null,
        message_id: messageId || null,
        capture_session_id: captureSessionId || null,
        generation_batch_id: generationBatchId || null,
        prompt_status: normalizedPromptStatus,
        prompt_source: promptSource || null,
        prompt_priority: promptPriority || 0,
        prompt_scope: promptScope || null,
        user_message: userMessage || null,
        captured_at: capturedAt,
        capture_extension_version: String(input.extensionVersion || input.extension_version || ""),
        content_sha256: contentHash,
        pixel_sha256: null,
        pixel_hash_version: null,
      },
    };
    let asset: StoredAsset;
    try {
      asset = await store.createAsset(assetInput, { trustedSourceRoots: [tempRoot], ingestMode: captureMode === "manual" ? "manual" : "automatic" });
    } catch (error) {
      if (explicitAssetId || !isAssetAlreadyExists(error)) throw error;
      assetId = sanitizeAssetId(`${providerConfig.assetIdPrefix}-video-${contentHash.slice(0, 24)}-${randomBytes(4).toString("hex")}`, providerConfig.assetIdPrefix);
      asset = await store.createAsset({ ...assetInput, assetId }, { trustedSourceRoots: [tempRoot], ingestMode: captureMode === "manual" ? "manual" : "automatic" });
    }
    await recordCapturedGeneration(store, asset, {
      projectId,
      provider,
      generationContextId,
      providerToolCallId,
      providerGenerationCallId,
      providerResponseId,
      providerAssetId,
      conversationId,
      messageId,
      generationBatchId,
      model,
      userMessage,
      prompt,
      promptStatus: normalizedPromptStatus,
      promptScope,
      generationStatus,
      references: asset.references,
      capturedAt,
    });
    return { status: "imported", asset, contentHash };
  } catch (error) {
    if (isAutomaticImportSuppressed(error)) return { status: "skipped", reason: "suppressed-after-delete", contentHash };
    if (isAutomaticIngestDuplicate(error)) {
      const duplicateId = String((error as { assetId?: unknown }).assetId || "");
      const duplicate = duplicateId
        ? (await projectAssets()).find((asset) => asset.id === duplicateId) || await findArchivedDuplicate(store, projectId, contentHash, "", projectAssets)
        : await findArchivedDuplicate(store, projectId, contentHash, "", projectAssets);
      if (duplicate) return finalizeDuplicate(duplicate);
    }
    throw error;
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

export function extractBearerToken(req: { headers?: Record<string, unknown> } | undefined | null): string {
  const authorization = String(req?.headers?.authorization || "");
  if (authorization.startsWith("Bearer ")) return authorization.slice("Bearer ".length).trim();
  return String(req?.headers?.["x-mosa-token"] || "").trim();
}

async function recordCapturedGeneration(store: Store, asset: StoredAsset, input: {
  projectId: string;
  provider: string;
  generationContextId: string;
  providerToolCallId?: string;
  providerGenerationCallId?: string;
  providerResponseId?: string;
  providerAssetId?: string;
  conversationId: string;
  messageId: string;
  generationBatchId: string;
  model: string;
  userMessage: string;
  prompt: string;
  promptStatus: string;
  promptScope?: string;
  generationStatus?: string;
  references?: unknown;
  capturedAt: string;
}): Promise<Metadata | null> {
  if (typeof store.recordGenerationEvent !== "function" || !asset?.id) return null;
  return store.recordGenerationEvent({
    project_id: input.projectId,
    output_asset_id: asset.id,
    provider: input.provider,
    capture_context_id: input.generationContextId,
    provider_tool_call_id: input.providerToolCallId || "",
    provider_generation_call_id: input.providerGenerationCallId || "",
    provider_response_id: input.providerResponseId || "",
    provider_asset_id: input.providerAssetId || "",
    conversation_id: input.conversationId,
    message_id: input.messageId,
    batch_id: input.generationBatchId,
    model: input.model,
    user_prompt: input.userMessage,
    effective_prompt: input.prompt,
    prompt_status: input.promptStatus,
    prompt_scope: normalizePromptScope(input.promptScope),
    generation_status: normalizeGenerationStatus(input.generationStatus),
    capture_channel: "chrome-extension",
    verification_level: "observed",
    references: Array.isArray(input.references) ? input.references : [],
    evidence: {
      source: "web-capture",
      relation_status: "unresolved",
      generation_status: normalizeGenerationStatus(input.generationStatus),
      prompt_scope: normalizePromptScope(input.promptScope),
      note: "Observed from provider web UI/runtime metadata; not provider-API verified.",
    },
    created_at: input.capturedAt,
  });
}

function webCaptureError(message: string, statusCode: number, code: string): Error & { statusCode: number; code: string } {
  const error = new Error(message) as Error & { statusCode: number; code: string };
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function isAutomaticImportSuppressed(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "AUTOMATIC_IMPORT_SUPPRESSED");
}

function isAutomaticIngestDuplicate(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "AUTOMATIC_INGEST_DUPLICATE");
}

function isAssetAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "ASSET_ALREADY_EXISTS");
}

async function inspectImageBytes(imageBytes: Buffer): Promise<{ format: string; width: number; height: number; pixelHash: string }> {
  try {
    const metadata = await sharp(imageBytes, {
      failOn: "error",
      limitInputPixels: WEB_CAPTURE_MAX_IMAGE_PIXELS,
    }).metadata();
    const width = Number(metadata.width) || 0;
    const height = Number(metadata.height) || 0;
    const pages = Number(metadata.pages) || 1;
    const frameHeight = Number(metadata.pageHeight) || height;
    const totalPixels = width * frameHeight * pages;
    if (!width || !height || totalPixels > WEB_CAPTURE_MAX_IMAGE_PIXELS) {
      throw webCaptureError(
        "Image exceeds " + WEB_CAPTURE_MAX_IMAGE_PIXELS.toLocaleString("en-US") + " pixel limit.",
        413,
        "WEB_CAPTURE_PIXEL_LIMIT",
      );
    }
    return {
      format: String(metadata.format || ""),
      width,
      height: frameHeight,
      pixelHash: await safePixelDigest(imageBytes, { limitInputPixels: WEB_CAPTURE_MAX_IMAGE_PIXELS }),
    };
  } catch (error: unknown) {
    if ((error as { code?: string })?.code === "WEB_CAPTURE_PIXEL_LIMIT") throw error;
    const detail = error instanceof Error ? error.message : String(error);
    if (/pixel limit|exceeds.*pixels|input image exceeds/i.test(detail)) {
      throw webCaptureError(
        "Image exceeds " + WEB_CAPTURE_MAX_IMAGE_PIXELS.toLocaleString("en-US") + " pixel limit.",
        413,
        "WEB_CAPTURE_PIXEL_LIMIT",
      );
    }
    throw webCaptureError(
      "Image bytes are invalid, truncated, or exceed the decoded pixel limit.",
      400,
      "WEB_CAPTURE_BAD_IMAGE_BYTES",
    );
  }
}

function decodeImageBytes(input: WebCaptureInput): Buffer {
  if (Buffer.isBuffer(input.imageBytes)) return input.imageBytes;
  if (input.imageBytes instanceof Uint8Array) return Buffer.from(input.imageBytes);
  let raw = String(input.imageBase64 || input.image_base64 || "").trim(); if (!raw) return Buffer.alloc(0);
  const dataUrl = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(raw); if (dataUrl) raw = dataUrl[1];
  try { return Buffer.from(raw, "base64"); } catch { return Buffer.alloc(0); }
}

function decodeMediaBytes(input: WebCaptureInput): Buffer {
  if (Buffer.isBuffer(input.mediaBytes)) return input.mediaBytes;
  if (input.mediaBytes instanceof Uint8Array) return Buffer.from(input.mediaBytes);
  let raw = String(input.mediaBase64 || input.media_base64 || "").trim();
  if (!raw) return Buffer.alloc(0);
  const dataUrl = /^data:video\/[a-z0-9.+-]+;base64,(.+)$/i.exec(raw);
  if (dataUrl) raw = dataUrl[1];
  try { return Buffer.from(raw, "base64"); } catch { return Buffer.alloc(0); }
}

function assertVideoContainer(bytes: Buffer, mimeType: string): void {
  const header = bytes.subarray(0, 32);
  if (mimeType === "video/webm") {
    if (header.length < 4 || header[0] !== 0x1a || header[1] !== 0x45 || header[2] !== 0xdf || header[3] !== 0xa3) {
      throw webCaptureError("Video bytes do not match WebM container.", 400, "WEB_CAPTURE_MIME_MISMATCH");
    }
    return;
  }
  if (["video/mp4", "video/quicktime", "video/x-m4v"].includes(mimeType)) {
    const marker = header.subarray(4, 12).toString("ascii");
    if (!marker.includes("ftyp")) {
      throw webCaptureError("Video bytes do not match ISO BMFF container.", 400, "WEB_CAPTURE_MIME_MISMATCH");
    }
  }
}

function normalizeMediaMetric(value: unknown, max: number, allowFraction = false): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > max) return 0;
  return allowFraction ? number : Math.round(number);
}

async function inspectTrustedCaptureTempFile(tempRoot: string, mediaFilePath: string): Promise<{ path: string; size: number; header: Buffer }> {
  const root = resolve(tempRoot);
  const path = resolve(mediaFilePath);
  if (path === root || !path.startsWith(`${root}${sep}`)) {
    throw webCaptureError("Uploaded media path is outside the Web Capture temp directory.", 400, "WEB_CAPTURE_UPLOAD_PATH_INVALID");
  }
  const info = await lstat(path).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink()) {
    throw webCaptureError("Uploaded media file is unavailable.", 400, "WEB_CAPTURE_UPLOAD_FILE_INVALID");
  }
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return { path, size: info.size, header: header.subarray(0, bytesRead) };
  } finally {
    await handle.close();
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function sanitizeStoredMediaUrl(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
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

function safeTokenEqual(provided: string, configured: string): boolean { if (!provided || !configured) return false; const a = Buffer.from(provided); const b = Buffer.from(configured); return a.length === b.length && timingSafeEqual(a, b); }
function normalizeMime(value: string): string { const m = String(value || "image/png").trim().toLowerCase(); return m === "image/jpg" ? "image/jpeg" : m; }
function normalizeMediaVariant(value: unknown): string { const variant = String(value || "").trim().toLowerCase(); return variant === "original" || variant === "preview" ? variant : ""; }
function normalizePromptScope(value: unknown): string {
  const scope = String(value || "").trim().toLowerCase();
  return PROMPT_SCOPES.has(scope) ? scope : "";
}
function normalizeGenerationStatus(value: unknown): string {
  const raw = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, string> = {
    complete: "completed", succeeded: "completed", success: "completed", done: "completed", finished: "completed",
    failure: "failed", error: "failed", errored: "failed", rejected: "failed", timeout: "failed", timed_out: "failed",
    canceled: "cancelled", aborted: "cancelled", stopped: "cancelled",
    incomplete: "partial", running: "in_progress", generating: "in_progress", streaming: "in_progress", pending: "in_progress", queued: "in_progress",
  };
  const normalized = aliases[raw] || raw || "unknown";
  return GENERATION_STATUSES.has(normalized) ? normalized : "unknown";
}
function logicalCaptureKey(projectId: string, provider: string, input: WebCaptureInput): string {
  const providerAssetId = String(input.providerAssetId || input.provider_asset_id || "").trim();
  if (providerAssetId) return `${projectId}\u001f${provider}\u001fasset:${providerAssetId}`;
  const generationCallId = String(input.providerGenerationCallId || input.provider_generation_call_id || "").trim();
  const generationContextId = String(input.generationContextId || input.generation_context_id || "").trim();
  const messageId = String(input.messageId || input.message_id || "").trim();
  const mediaUrl = sanitizeStoredMediaUrl(input.finalMediaUrl || input.final_media_url || input.sourceMediaUrl || input.source_media_url);
  // A call/context can legitimately emit multiple images. Never collapse the
  // whole generation when the provider did not give us an output-scoped asset
  // id or a distinct media URL for this one output.
  if ((!generationCallId && !generationContextId) || !mediaUrl) return "";
  return `${projectId}\u001f${provider}\u001foutput:${generationCallId}\u001f${generationContextId}\u001f${messageId}\u001f${mediaUrl}`;
}
function onceProjectListing(store: Store, projectId: string): () => Promise<StoredAsset[]> { let pending: Promise<StoredAsset[]> | null = null; return () => { if (!pending) pending = Promise.all([store.listAssets({ projectId }), store.listAssets({ projectId, archived: true }).catch(() => [])]).then(([a, b]) => [...a, ...b]); return pending; }; }
const TERMINAL_GENERATION_STATUSES = new Set(["completed", "failed", "cancelled"]);

function storedGenerationStatus(asset: StoredAsset): string {
  return normalizeGenerationStatus(asset.source?.generation_status ?? asset.business_fields?.generation_status);
}

function storedPixelCount(asset: StoredAsset): number {
  const width = Number(asset.business_fields?.width ?? asset.source?.width) || 0;
  const height = Number(asset.business_fields?.height ?? asset.source?.height) || 0;
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * "Same provider id arrived again" may only ever replace media upward
 * (user rule 2026-10-28): a preview or an equal/smaller re-encode must never
 * destroy archived pixels. A provisional capture holds the slot for its
 * terminal result, an archived preview may be replaced by the original, and an
 * archived original only yields to strictly more pixels. When dimensions are
 * unreadable the conservative branch applies — an unreadable *incoming* image
 * never upgrades, while unreadable *stored* dimensions cannot prove a
 * downgrade of a provisional capture, so the terminal result still lands.
 */
function isProviderMediaUpgrade(existing: StoredAsset, incoming: { pixels: number; mediaVariant: string; generationStatus: string }): boolean {
  if (!TERMINAL_GENERATION_STATUSES.has(incoming.generationStatus)) return false;
  const existingTerminal = TERMINAL_GENERATION_STATUSES.has(storedGenerationStatus(existing));
  const existingVariant = normalizeMediaVariant(existing.source?.media_variant);
  const existingPixels = storedPixelCount(existing);
  if (incoming.mediaVariant === "preview") {
    // Only a strictly larger preview may replace a preview; an archived
    // original must never be downgraded to a preview.
    return existingTerminal && existingVariant === "preview"
      && incoming.pixels > 0 && existingPixels > 0 && incoming.pixels > existingPixels;
  }
  if (!existingTerminal) {
    return incoming.pixels === 0 || existingPixels === 0 || incoming.pixels >= existingPixels;
  }
  if (existingVariant === "preview") return true;
  return incoming.pixels > 0 && existingPixels > 0 && incoming.pixels > existingPixels;
}

// The first-archived provider id stays in source.provider_asset_id; later ids
// observed for the same bytes are appended here (deduped, bounded) so identity
// history grows without ever rewriting the archived one.
const MERGED_PROVIDER_ASSET_IDS_LIMIT = 20;

function mergeProviderAssetIds(current: unknown, incomingId: string, archivedId: string): string[] {
  const clean = String(incomingId || "").trim();
  if (!clean || clean === String(archivedId || "").trim()) return Array.isArray(current) ? current.map((entry) => String(entry)) : [];
  const merged = (Array.isArray(current) ? current : [])
    .map((entry) => String(entry || "").trim())
    .filter((entry) => entry && entry !== String(archivedId || "").trim());
  if (!merged.includes(clean)) merged.push(clean);
  return merged.slice(0, MERGED_PROVIDER_ASSET_IDS_LIMIT);
}
function findLogicalProviderAsset(assets: StoredAsset[], provider: string, providerAssetId: string, logicalOutputId = ""): StoredAsset | null {
  const wantedProvider = String(provider || "").trim().toLowerCase();
  const wantedAssetId = String(providerAssetId || "").trim();
  const wantedLogicalOutputId = String(logicalOutputId || "").trim();
  if (!wantedProvider || (!wantedAssetId && !wantedLogicalOutputId)) return null;
  return assets.find((asset) => (
    String(asset.source?.provider || "").trim().toLowerCase() === wantedProvider
    && (
      (wantedAssetId && String(asset.source?.provider_asset_id || "").trim() === wantedAssetId)
      || (wantedLogicalOutputId && String(asset.source?.logical_output_id || "").trim() === wantedLogicalOutputId)
    )
  )) || null;
}
async function findArchivedDuplicate(store: Store, projectId: string, contentHash: string, pixelHash: string, projectAssets: () => Promise<StoredAsset[]>): Promise<StoredAsset | null> {
  const byBytes = typeof store.findAssetByContentHash === "function" ? await store.findAssetByContentHash(projectId, contentHash) : (await projectAssets()).find((a) => a.source?.content_sha256 === contentHash) || null;
  if (byBytes) return byBytes;
  if (!pixelHash) return null;
  const indexedMatch = typeof store.findAssetByPixelHash === "function"
    ? await store.findAssetByPixelHash(projectId, pixelHash)
    : (await projectAssets()).find((a) => a.source?.pixel_sha256 === pixelHash) || null;
  if (indexedMatch && await isTrustedPixelMatch(store, indexedMatch, pixelHash)) return indexedMatch;
  const candidates = (typeof store.findAssetsByPixelHash === "function"
    ? await store.findAssetsByPixelHash(projectId, pixelHash)
    : (await projectAssets()).filter((asset) => asset.source?.pixel_sha256 === pixelHash))
    .filter((asset) => asset.id !== indexedMatch?.id);
  for (const candidate of candidates) if (await isTrustedPixelMatch(store, candidate, pixelHash)) return candidate;
  return null;
}

async function isTrustedPixelMatch(store: Store, asset: StoredAsset, pixelHash: string): Promise<boolean> {
  if (asset.source?.pixel_hash_version === PIXEL_HASH_VERSION) return true;
  const imagePath = typeof asset.image_path === "string" ? asset.image_path : "";
  if (!imagePath) return false;
  const trusted = await safePixelDigest(imagePath, { limitInputPixels: WEB_CAPTURE_MAX_IMAGE_PIXELS }).then((hash) => hash === pixelHash, () => false);
  if (!trusted) return false;
  if (typeof store.updateMetadata === "function") {
    const nextSource = { ...(asset.source || {}), pixel_sha256: pixelHash, pixel_hash_version: PIXEL_HASH_VERSION };
    await store.updateMetadata(asset.project_id, asset.id, { source: nextSource }).then(() => { asset.source = nextSource; }, () => {});
  }
  return true;
}

const MAX_TURN_REFERENCES = 8;

// A reference whose bytes already exist as a managed library original can be
// stored as a hard link to it instead of a second copy. The reference store
// re-hashes the candidate file before linking, so a stale database hash can
// only cost the link, never correctness.
async function findReferenceHardlinkSource(store: Store, projectId: string, contentHash: string): Promise<string | undefined> {
  const finder = store.findOriginalByContentHash;
  if (typeof finder !== "function") return undefined;
  try {
    return (await finder.call(store, projectId, contentHash)) || undefined;
  } catch {
    return undefined;
  }
}

async function turnReferences(store: Store, projectAssets: () => Promise<StoredAsset[]>, referenceStore: ReturnType<typeof createReferenceAttachmentStore>, projectId: string, { conversationId, generationContextId, capturedAt, selfAssetId }: { conversationId: string; generationContextId: string; capturedAt: string; selfAssetId: string }): Promise<Metadata[]> {
  if (!conversationId && !generationContextId) return [];
  const now = createdAtTimestamp(capturedAt);
  if (now === null) return [];

  const attachments = await referenceStore.list(projectId);
  if (generationContextId) {
    return attachments
      .map((attachment) => ({
        attachment,
        usage: attachment.usages?.find((usage) => usage.generation_context_id === generationContextId),
      }))
      .filter((entry): entry is { attachment: ReferenceAttachment; usage: ReferenceAttachment["usages"][number] } => Boolean(entry.usage))
      .slice(0, MAX_TURN_REFERENCES)
      .map(({ attachment, usage }) => referenceMetadata(attachment, usage));
  }

  const members = (typeof store.listAssetsByConversation === "function"
    ? await store.listAssetsByConversation(projectId, conversationId)
    : await projectAssets()).filter((asset) =>
    asset.id !== selfAssetId && asset.source?.conversation_id === conversationId);
  const timeOf = (asset: StoredAsset) => createdAtTimestamp(asset.source?.captured_at || asset.created_at);

  let previousGeneration = -Infinity;
  for (const asset of members) {
    if (asset.business_fields?.is_reference) continue;
    const at = timeOf(asset);
    if (at !== null && at < now && at > previousGeneration) previousGeneration = at;
  }

  return attachments
    .flatMap((attachment) => (attachment.usages?.length ? attachment.usages : [{
      generation_context_id: "",
      provider: attachment.provider,
      page_url: attachment.page_url,
      conversation_id: attachment.conversation_id,
      message_id: attachment.message_id,
      provider_asset_id: attachment.provider_asset_id,
      captured_at: attachment.captured_at,
      user_message: attachment.user_message,
    }])
      .filter((usage) => usage.conversation_id === conversationId)
      .map((usage) => ({ attachment, usage, at: createdAtTimestamp(usage.captured_at) })))
    .filter((entry): entry is { attachment: ReferenceAttachment; usage: ReferenceAttachment["usages"][number]; at: number } => entry.at !== null && entry.at <= now && entry.at > previousGeneration)
    .sort((left, right) => left.at - right.at)
    .slice(0, MAX_TURN_REFERENCES)
    .map(({ attachment, usage }) => referenceMetadata(attachment, usage));
}

function referenceMetadata(attachment: ReferenceAttachment, usage?: ReferenceAttachment["usages"][number]): Metadata {
  return {
    reference_id: attachment.id,
    asset_id: attachment.id,
    provider_asset_id: usage?.provider_asset_id || attachment.provider_asset_id,
    sha256: attachment.content_sha256,
    attachment_url: attachment.attachment_url,
    mime_type: attachment.mime_type,
    width: attachment.width,
    height: attachment.height,
    role: "",
    scope: [],
    applied: true,
    application_status: "observed_input",
    verification_level: "observed",
  };
}

async function mergeDuplicateGenerationRecipe(
  store: Store,
  existing: StoredAsset,
  input: {
    projectAssets: () => Promise<StoredAsset[]>;
    referenceStore: ReturnType<typeof createReferenceAttachmentStore>;
    projectId: string;
    conversationId: string;
    generationContextId: string;
    providerToolCallId?: string;
    providerGenerationCallId?: string;
    providerResponseId?: string;
    providerAssetId?: string;
    capturedAt: string;
    messageId: string;
    prompt: string;
    promptStatus: string;
    promptSource: string;
    promptPriority?: number;
    promptScope?: string;
    generationStatus?: string;
    userMessage: string;
    model: string;
    provider: string;
  },
): Promise<{ asset: StoredAsset; merged: boolean }> {
  if (typeof store.updateMetadata !== "function") return { asset: existing, merged: false };
  const references = await turnReferences(store, input.projectAssets, input.referenceStore, input.projectId, {
    conversationId: input.conversationId,
    generationContextId: input.generationContextId,
    capturedAt: input.capturedAt,
    selfAssetId: existing.id,
  });
  const currentReferences = Array.isArray(existing.references) ? existing.references : [];
  // Duplicate/late observations are monotonic: an incomplete observation with
  // no resolved references must never erase a reference set already archived
  // on the asset. A later non-empty observation may still replace the set when
  // it carries better evidence for the same generation occurrence.
  const mergedReferences = references.length ? references : currentReferences;
  const currentContext = String(existing.source?.generation_context_id || existing.business_fields?.generation_context_id || "");
  const currentGenerationStatus = normalizeGenerationStatus(existing.source?.generation_status || existing.business_fields?.generation_status);
  const contextChanged = Boolean(input.generationContextId && input.generationContextId !== currentContext);
  const nextGenerationStatus = normalizeGenerationStatus(input.generationStatus);
  const statusChanged = nextGenerationStatus !== "unknown" && nextGenerationStatus !== currentGenerationStatus;
  const referencesChanged = referenceIdentityList(currentReferences) !== referenceIdentityList(mergedReferences);
  // A second provider asset id for the same bytes is a distinct identity event:
  // the archived id stays, the newcomer is appended to merged_provider_asset_ids.
  const incomingProviderAssetId = String(input.providerAssetId || "").trim();
  const currentProviderAssetId = String(existing.source?.provider_asset_id || "").trim();
  const providerAssetIdChanged = Boolean(incomingProviderAssetId && currentProviderAssetId && incomingProviderAssetId !== currentProviderAssetId);
  // Plain prompt/user-message upgrades are handled by maybeUpgradePrompt below.
  // This merge exists specifically for a distinct generation occurrence or a
  // late-arriving reference set, otherwise it would swallow the normal upgrade signal.
  if (!contextChanged && !referencesChanged && !statusChanged && !providerAssetIdChanged) return { asset: existing, merged: false };

  const updated = await store.updateMetadata(existing.project_id, existing.id, {
    references: mergedReferences,
    source: {
      ...(existing.source || {}),
      generation_context_id: input.generationContextId || existing.source?.generation_context_id || null,
      capture_context_id: input.generationContextId || existing.source?.capture_context_id || existing.source?.generation_context_id || null,
      provider_tool_call_id: input.providerToolCallId || existing.source?.provider_tool_call_id || null,
      provider_generation_call_id: input.providerGenerationCallId || existing.source?.provider_generation_call_id || null,
      provider_response_id: input.providerResponseId || existing.source?.provider_response_id || null,
      provider_asset_id: currentProviderAssetId || input.providerAssetId || null,
      merged_provider_asset_ids: providerAssetIdChanged
        ? mergeProviderAssetIds(existing.source?.merged_provider_asset_ids, incomingProviderAssetId, currentProviderAssetId)
        : existing.source?.merged_provider_asset_ids,
      generation_status: statusChanged ? nextGenerationStatus : existing.source?.generation_status || currentGenerationStatus,
      verification_level: existing.source?.verification_level || "observed",
      message_id: input.messageId || existing.source?.message_id || null,
      prompt_status: existing.source?.prompt_status || existing.business_fields?.prompt_status || "not-available",
      prompt_source: existing.source?.prompt_source || existing.business_fields?.prompt_source || null,
      prompt_priority: existing.source?.prompt_priority || existing.business_fields?.prompt_priority || 0,
      prompt_scope: existing.source?.prompt_scope || existing.business_fields?.prompt_scope || input.promptScope || null,
      user_message: mergedUserMessage(existing.source?.user_message, input.userMessage) || null,
      model: input.model || existing.source?.model || null,
    },
    business_fields: {
      ...(existing.business_fields || {}),
      generation_context_id: input.generationContextId || existing.business_fields?.generation_context_id || null,
      capture_context_id: input.generationContextId || existing.business_fields?.capture_context_id || existing.business_fields?.generation_context_id || null,
      generation_status: statusChanged ? nextGenerationStatus : existing.business_fields?.generation_status || currentGenerationStatus,
      verification_level: existing.business_fields?.verification_level || "observed",
      prompt_status: existing.business_fields?.prompt_status || existing.source?.prompt_status || "not-available",
      prompt_source: existing.business_fields?.prompt_source || existing.source?.prompt_source || null,
      prompt_priority: existing.business_fields?.prompt_priority || existing.source?.prompt_priority || 0,
      prompt_scope: existing.business_fields?.prompt_scope || existing.source?.prompt_scope || input.promptScope || null,
      user_message: mergedUserMessage(existing.business_fields?.user_message, input.userMessage) || null,
    },
    recipe_change_summary: providerAssetIdChanged
      ? "Provider asset identity merged"
      : contextChanged
        ? "Generation occurrence merged"
        : referencesChanged
          ? "Generation references merged"
          : "Generation status updated",
  });
  return { asset: updated, merged: true };
}

function referenceIdentityList(references: unknown): string {
  if (!Array.isArray(references)) return "";
  return references.map((reference) => {
    const item = reference && typeof reference === "object" ? reference as Record<string, unknown> : {};
    return String(item.reference_id || item.asset_id || item.sha256 || item.attachment_url || "");
  }).filter(Boolean).sort().join("|");
}

const PROMPT_STATUS_RANK: Record<string, number> = {
  "not-available": 0,
  "user-message": 1,
  "provider-visible-prompt": 1,
  "visible-caption": 2,
  "generation-tool-prompt": 3,
};

function promptRank(status: string, text: unknown, priority = 0): number {
  const base = PROMPT_STATUS_RANK[status] ?? 0;
  return Math.max(0, Number(priority) || 0) * 1_000_000
    + base * 10000
    + Math.min(String(text || "").trim().length, 5000);
}

function placeHints(text: unknown): string[] {
  const value = String(text || "");
  const hints: string[] = [];
  const rules: Array<[RegExp, string]> = [
    [/北京|beijing/i, "beijing"],
    [/上海|shanghai/i, "shanghai"],
    [/东京|tokyo/i, "tokyo"],
    [/曼谷|bangkok/i, "bangkok"],
    [/首尔|seoul/i, "seoul"],
    [/巴黎|paris/i, "paris"],
    [/伦敦|london/i, "london"],
  ];
  for (const [pattern, key] of rules) {
    if (pattern.test(value)) hints.push(key);
  }
  return hints;
}

function mentionsAnyPlace(text: unknown, hints: string[]): boolean {
  if (!hints.length) return false;
  const lower = String(text || "").toLowerCase();
  return hints.some((hint) => lower.includes(hint));
}

function captureOccurrenceKey(value: Record<string, unknown>): string {
  return [
    value.provider,
    value.type,
    value.page_url,
    value.conversation_id,
    value.message_id,
    value.generation_context_id,
    value.capture_mode,
  ].map((part) => String(part || "")).join("|");
}

async function recordCaptureOccurrence(
  store: Store,
  existing: StoredAsset,
  occurrence: Record<string, unknown>,
): Promise<StoredAsset | null> {
  if (typeof store.updateMetadata !== "function") return null;
  const current = Array.isArray(existing.source?.capture_occurrences)
    ? existing.source.capture_occurrences.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    : [];
  const key = captureOccurrenceKey(occurrence);
  if (current.some((entry) => captureOccurrenceKey(entry) === key)) return existing;
  return store.updateMetadata(existing.project_id, existing.id, {
    source: {
      ...(existing.source || {}),
      capture_occurrences: [...current, occurrence].slice(-40),
    },
  });
}

interface PromptUpgrade {
  prompt?: string;
  promptStatus?: string;
  userMessage?: string;
  user_message?: string;
  promptSource?: string;
  promptPriority?: number;
  promptScope?: string;
  model?: string;
  provider?: string;
}

// ChatGPT's live image tool call carries the Prompt the chat model wrote for
// the image generator. It is kept beside the caption Prompt, never in place of
// it, so it does not take part in Prompt ranking.
function requestPromptFor(provider: string, input: WebCaptureInput): string {
  if (provider !== "chatgpt") return "";
  const text = String(input.generation_request_prompt || input.generationRequestPrompt || "").trim();
  return text.length <= 12000 ? text : "";
}

async function maybeStoreRequestPrompt(store: Store, existing: StoredAsset, requestPrompt: string): Promise<StoredAsset | null> {
  if (!requestPrompt || typeof store.updateMetadata !== "function") return null;
  if (String(existing.source?.provider || "").trim().toLowerCase() !== "chatgpt") return null;
  if (String(existing.source?.generation_request_prompt || "").trim()) return null;
  return store.updateMetadata(existing.project_id, existing.id, {
    source: { ...(existing.source || {}), generation_request_prompt: requestPrompt },
  });
}

// A session title learned late names stacks; it must never rewrite one the
// asset already carries. Only an empty slot is backfilled, and because the
// recipe digest never covers generation_session_title, the store dedupes the
// snapshot by digest — this write adds no recipe snapshot.
async function maybeStoreSessionTitle(store: Store, existing: StoredAsset, title: string): Promise<StoredAsset | null> {
  if (!title || typeof store.updateMetadata !== "function") return null;
  if (String(existing.source?.generation_session_title || "").trim()) return null;
  return store.updateMetadata(existing.project_id, existing.id, {
    source: { ...(existing.source || {}), generation_session_title: title },
  });
}

// The first user instruction archived for an image wins: re-observations of
// an already archived capture often carry the message of a different
// conversation turn (virtual scrolling shows only partial history), so an
// unrelated message must never replace the archived one. Only an empty slot
// or a strict extension of the archived text may update it.
function mergedUserMessage(current: unknown, incoming: unknown): string {
  const existing = String(current || "").trim();
  const next = String(incoming || "").trim();
  if (!existing) return next;
  if (!next) return existing;
  if (next.startsWith(existing) && next.length > existing.length) return next;
  return existing;
}

async function maybeUpgradePrompt(store: Store, existing: StoredAsset, next: PromptUpgrade = {}): Promise<StoredAsset | null> {
  if (typeof store.updateMetadata !== "function") return null;
  const nextPrompt = String(next.prompt || "").trim();
  const userMessage = String(next.userMessage || next.user_message || "").trim();
  const currentUserMessage = String(existing.source?.user_message || existing.business_fields?.user_message || "").trim();
  if (!nextPrompt) {
    const merged = mergedUserMessage(currentUserMessage, userMessage);
    // Keeping the archived instruction is a no-op: writing metadata here would
    // add a recipe snapshot for every repeated observation of the same image.
    if (merged === currentUserMessage) return null;
    return store.updateMetadata(existing.project_id, existing.id, {
      source: {
        ...(existing.source || {}),
        prompt_source: next.promptSource || existing.source?.prompt_source || null,
        user_message: merged,
      },
      business_fields: {
        ...(existing.business_fields || {}),
        prompt_source: next.promptSource || existing.business_fields?.prompt_source || null,
        user_message: merged,
      },
    });
  }

  const currentPrompt = String(existing.prompt || "").trim();
  const currentStatus = String(
    existing.source?.prompt_status
      || existing.business_fields?.prompt_status
      || (currentPrompt ? "user-message" : "not-available"),
  );
  const nextStatus = next.promptStatus || "user-message";
  const currentPriority = Number(existing.source?.prompt_priority || existing.business_fields?.prompt_priority) || 0;
  const nextPriority = Math.max(0, Number(next.promptPriority) || 0);
  const currentRank = promptRank(currentStatus, currentPrompt, currentPriority);
  const nextRank = promptRank(nextStatus, nextPrompt, nextPriority);
  const places = placeHints(userMessage || nextPrompt);
  const placeUpgrade = places.length > 0
    && mentionsAnyPlace(userMessage || nextPrompt, places)
    && !mentionsAnyPlace(currentPrompt, places)
    && (mentionsAnyPlace(nextPrompt, places) || /user edit|Generation caption|requested a different region/i.test(nextPrompt));
  if (!placeUpgrade && nextRank <= currentRank && !(nextPrompt.length > currentPrompt.length + 40 && nextRank >= currentRank)) {
    return null;
  }

  return store.updateMetadata(existing.project_id, existing.id, {
    prompt: nextPrompt,
    theme: promptTheme(nextPrompt, providerLabelFor(next.provider || existing.source?.provider)),
    source: {
      ...(existing.source || {}),
      prompt_status: nextStatus,
      prompt_source: next.promptSource || existing.source?.prompt_source || null,
      prompt_priority: nextPriority,
      prompt_scope: normalizePromptScope(next.promptScope) || existing.source?.prompt_scope || null,
      user_message: mergedUserMessage(existing.source?.user_message, next.userMessage) || null,
      model: next.model || existing.source?.model || null,
    },
    business_fields: {
      ...(existing.business_fields || {}),
      prompt_status: nextStatus,
      prompt_source: next.promptSource || existing.business_fields?.prompt_source || null,
      prompt_priority: nextPriority,
      prompt_scope: normalizePromptScope(next.promptScope) || existing.business_fields?.prompt_scope || null,
      user_message: mergedUserMessage(existing.business_fields?.user_message, next.userMessage) || null,
    },
  });
}

const LEADING_UI_GLYPH_TOKENS = new Set([
  "play_circle", "play_arrow", "pause_circle", "stop_circle",
  "more_vert", "more_horiz", "fullscreen_exit", "open_in_full",
  "download_for_offline", "file_download", "volume_up", "volume_off",
]);

function stripLeadingUiGlyphTokens(value: string): string {
  const parts = String(value || "").trim().split(/\s+/);
  while (parts.length && LEADING_UI_GLYPH_TOKENS.has(parts[0].toLowerCase())) parts.shift();
  return parts.join(" ").trim();
}

function promptTheme(prompt: string, providerLabel: string = PROVIDER_CONFIG.chatgpt.label): string {
  const text = stripLeadingUiGlyphTokens(String(prompt || "")
    .replace(/<\|has_watermark\|>/g, "")
    .replace(/\n?展开\s*$/g, "")
    .trim()
    .replace(/\s+/g, " "));
  if (!text) return `${providerLabel} web image`;
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
function sanitizeAssetId(value: string, fallbackPrefix: string = PROVIDER_CONFIG.chatgpt.assetIdPrefix): string { return String(value || fallbackPrefix).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || `${fallbackPrefix}-${Date.now()}`; }
function providerLabelFor(value: unknown): string { const config = PROVIDER_CONFIG[String(value || "").trim().toLowerCase() as ProviderId]; return config?.label || PROVIDER_CONFIG.chatgpt.label; }
