import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PIXEL_HASH_VERSION, safePixelDigest } from "./image-pixel-hash.js";
import {
  createCodexSessionIndex,
  type CodexGenerationMetadata,
  type CodexSessionImageEvent,
  type CodexSessionIndex,
  type CodexTaskMetadata,
} from "./codex-session-index.js";
import { createCodexThreadHistoryReader } from "./codex-thread-history.js";
import {
  cleanupCodexSessionRecoveryRoot,
  removeCodexSessionStagedImage,
  stageCodexSessionImageResult,
  type StagedCodexSessionImage,
} from "./codex-session-recovery.js";
import { resolveSourceLocations } from "./source-locations.js";

const IMAGE_EXTENSIONS = new Set([".apng", ".avif", ".gif", ".jpg", ".jpeg", ".png", ".svg", ".webp"]);
const DEFAULT_PROJECT_ID = "default";
interface ImageCandidate { imagePath: string; taskId: string | null; fileName: string; fileStem: string; fileStat: Stats; generatedAt: string; }
type GenerationMetadata = CodexGenerationMetadata;
interface ImageInfo { width: number | null; height: number | null; ratio: string; mimeType: string; bytes: number; }
interface StoredAsset {
  id: string;
  project_id: string;
  prompt?: string;
  theme?: string;
  source?: Record<string, unknown>;
  business_fields?: Record<string, unknown>;
  image_path?: string;
  [key: string]: unknown;
}
interface Store { createAsset(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<StoredAsset>; listAssets(filters: Record<string, unknown>): Promise<StoredAsset[]>; findAssetBySourcePath?(projectId: string, sourcePath: string): Promise<StoredAsset | null>; findAssetByContentHash?(projectId: string, contentHash: string): Promise<StoredAsset | null>; findAssetByPixelHash?(projectId: string, pixelHash: string): Promise<StoredAsset | null>; updateMetadata(projectId: string, assetId: string, metadata: Record<string, unknown>): Promise<void>; codexImagesDir: string; assetsRoot: string; [key: string]: unknown; }
interface BridgeStatus { imagesDir: string; sessionsDir: string; threadHistoryPath: string | null; enabled: boolean; watching: boolean; watchingImages: boolean; watchingSessions: boolean; polling: boolean; busy: boolean; pendingSessionResults: number; lastSessionBytesRead: number; lastScanAt: string | null; lastImportedAt: string | null; lastImportCount: number; totalImported: number; lastSkippedCount: number; lastError: string | null; lastWarning: string | null; }
interface ReconcileResult { imported: unknown[]; skipped: Array<{ path: string; reason: string; error?: string }>; updated?: string[]; candidates: number; sessionBytesRead?: number; queued?: boolean; }
interface Bridge { start(): Promise<BridgeStatus>; stop(): Promise<void>; reconcile(): Promise<ReconcileResult>; scheduleReconcile(): void; status(): BridgeStatus; }

export function createCodexImageBridge(options: { store?: Store; imagesDir?: string; sessionsDir?: string; threadHistoryDir?: string; threadHistoryPath?: string; projectId?: string; debounceMs?: number; pollIntervalMs?: number; signal?: AbortSignal; } = {}): Bridge {
  const store = options.store;
  if (!store || typeof store.createAsset !== "function" || typeof store.listAssets !== "function") throw new Error("Codex image bridge requires a GravityPort store.");
  const imagesDir = resolve(options.imagesDir || store.codexImagesDir);
  const { codexSessionsDir: sessionsDir, codexThreadHistoryDir } = resolveSourceLocations({
    overrides: { codexSessionsDir: options.sessionsDir, codexThreadHistoryDir: options.threadHistoryDir },
  });
  const threadHistory = createCodexThreadHistoryReader({ dir: codexThreadHistoryDir, dbPath: options.threadHistoryPath || null });
  const projectId = options.projectId || DEFAULT_PROJECT_ID;
  const debounceMs = options.debounceMs != null && Number.isFinite(options.debounceMs) ? Math.max(0, options.debounceMs) : 500;
  const pollIntervalMs = options.pollIntervalMs != null && Number.isFinite(options.pollIntervalMs) ? Math.max(250, options.pollIntervalMs) : 30000;
  const processedSignatures = new Map<string, string>();
  const sessionIndex = createCodexSessionIndex({ sessionsDir, threadHistory });
  let imageWatcher: FSWatcher | null = null;
  let sessionWatcher: FSWatcher | null = null;
  let poller: ReturnType<typeof setInterval> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let enabled = false; let reconciling = false; let reconcileAgain = false;
  let activeReconcile: Promise<ReconcileResult> | null = null; let stopPromise: Promise<void> | null = null;
  const state: Omit<BridgeStatus, "watching" | "watchingImages" | "watchingSessions" | "polling" | "busy"> = {
    imagesDir,
    sessionsDir,
    threadHistoryPath: options.threadHistoryPath || (options.threadHistoryDir ? resolve(options.threadHistoryDir) : codexThreadHistoryDir),
    enabled: false,
    pendingSessionResults: 0,
    lastSessionBytesRead: 0,
    lastScanAt: null,
    lastImportedAt: null,
    lastImportCount: 0,
    totalImported: 0,
    lastSkippedCount: 0,
    lastError: null,
    lastWarning: null,
  };
  async function reconcile(): Promise<ReconcileResult> {
    if (!enabled) return { imported: [], skipped: [], queued: true, candidates: 0 };
    if (reconciling) { reconcileAgain = true; return { imported: [], skipped: [], queued: true, candidates: 0 }; }
    reconciling = true;
    const run = (async (): Promise<ReconcileResult> => {
      try {
        const result = await reconcileCodexSources({
          store: store!,
          imagesDir,
          sessionsDir,
          projectId,
          processedSignatures,
          sessionIndex,
          shouldContinue: () => enabled && !options.signal?.aborted,
        });
        state.pendingSessionResults = sessionIndex.pendingResults().length;
        state.lastSessionBytesRead = Number(result.sessionBytesRead || 0);
        state.lastScanAt = new Date().toISOString();
        state.lastImportCount = result.imported.length;
        state.lastSkippedCount = result.skipped.length;
        state.totalImported += result.imported.length;
        state.lastError = null;
        state.lastWarning = threadHistory.warnings().at(-1) || null;
        if (result.imported.length > 0) state.lastImportedAt = state.lastScanAt;
        return result;
      } catch (error) {
        state.lastScanAt = new Date().toISOString();
        state.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        reconciling = false;
        activeReconcile = null;
        ensureWatchers();
        if (reconcileAgain && enabled) { reconcileAgain = false; scheduleReconcile(); } else reconcileAgain = false;
      }
    })();
    activeReconcile = run;
    return run;
  }
  function scheduleReconcile(): void { if (!enabled) return; if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; if (enabled) reconcile().catch(() => {}); }, debounceMs); }
  async function start(): Promise<BridgeStatus> {
    if (enabled) return apiStatus();
    enabled = true;
    state.enabled = true;
    try {
      await mkdir(imagesDir, { recursive: true });
      await cleanupCodexSessionRecoveryRoot(store!.assetsRoot).catch(() => {});
      if (!enabled) return apiStatus();
      await reconcile();
      if (!enabled) return apiStatus();
      ensureWatchers();
      poller = setInterval(() => { if (enabled) reconcile().catch(() => {}); }, pollIntervalMs);
      return apiStatus();
    } catch (error) {
      enabled = false;
      state.enabled = false;
      throw error;
    }
  }
  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    enabled = false;
    state.enabled = false;
    reconcileAgain = false;
    if (timer) clearTimeout(timer);
    timer = null;
    if (poller) clearInterval(poller);
    poller = null;
    imageWatcher?.close();
    imageWatcher = null;
    sessionWatcher?.close();
    sessionWatcher = null;
    const currentReconcile = activeReconcile;
    stopPromise = Promise.resolve(currentReconcile).catch(() => {}).then(() => {}).finally(() => { stopPromise = null; });
    return stopPromise;
  }
  function apiStatus(): BridgeStatus {
    return {
      ...state,
      watching: Boolean(imageWatcher || sessionWatcher),
      watchingImages: Boolean(imageWatcher),
      watchingSessions: Boolean(sessionWatcher),
      polling: Boolean(poller),
      busy: reconciling || reconcileAgain || Boolean(timer),
    };
  }
  function ensureWatchers(): void {
    if (!enabled) return;
    if (!imageWatcher) imageWatcher = createWatcher(imagesDir, scheduleReconcile, () => { imageWatcher = null; });
    if (!sessionWatcher) sessionWatcher = createWatcher(sessionsDir, scheduleReconcile, () => { sessionWatcher = null; });
  }
  return { start, stop, reconcile, scheduleReconcile, status: apiStatus };
}

export async function reconcileCodexGeneratedImages(options: { store: Store; imagesDir?: string; sessionsDir?: string; threadHistoryDir?: string; threadHistoryPath?: string; projectId?: string; knownHashes?: Set<string> | null; processedSignatures?: Map<string, string> | null; }): Promise<ReconcileResult> {
  const { store, projectId = DEFAULT_PROJECT_ID } = options;
  const imagesDir = resolve(options.imagesDir || store.codexImagesDir);
  const { codexSessionsDir: sessionsDir, codexThreadHistoryDir } = resolveSourceLocations({
    overrides: { codexSessionsDir: options.sessionsDir, codexThreadHistoryDir: options.threadHistoryDir },
  });
  return reconcileCodexSources({
    store,
    imagesDir,
    sessionsDir,
    projectId,
    processedSignatures: options.processedSignatures || new Map(),
    sessionIndex: createCodexSessionIndex({
      sessionsDir,
      threadHistory: createCodexThreadHistoryReader({ dir: codexThreadHistoryDir, dbPath: options.threadHistoryPath || null }),
    }),
    knownHashes: options.knownHashes || new Set(),
  });
}

async function reconcileCodexSources(options: {
  store: Store;
  imagesDir: string;
  sessionsDir: string;
  projectId: string;
  processedSignatures: Map<string, string>;
  sessionIndex: CodexSessionIndex;
  knownHashes?: Set<string>;
  shouldContinue?: () => boolean;
}): Promise<ReconcileResult> {
  const { store, imagesDir, projectId, processedSignatures, sessionIndex } = options;
  const shouldContinue = options.shouldContinue || (() => true);
  if (!shouldContinue()) return { imported: [], skipped: [], updated: [], candidates: 0 };
  const sessionScan = await sessionIndex.scan();
  if (!shouldContinue()) return { imported: [], skipped: [], updated: [], candidates: 0, sessionBytesRead: sessionScan.bytesRead };
  const candidates = await readCodexImageCandidates(imagesDir);
  pruneProcessedSignatures(processedSignatures, candidates.map((candidate) => candidate.imagePath));
  const lookup = createBridgeAssetLookup(store, projectId);
  const contentHashes = options.knownHashes || new Set<string>();
  const imported: unknown[] = [];
  const skipped: Array<{ path: string; reason: string; error?: string }> = [];
  const updated: string[] = [];

  for (const candidate of candidates) {
    if (!shouldContinue()) break;
    const task = sessionIndex.metadataForTask(candidate.taskId || "");
    const generation = metadataForIndexedCandidate(task, candidate);
    await ingestFilesystemCandidate({
      store,
      projectId,
      imagesRoot: imagesDir,
      candidate,
      generation,
      lookup,
      contentHashes,
      processedSignatures,
      imported,
      skipped,
      updated,
    });
  }

  await ingestSessionResultCandidates({
    store,
    projectId,
    imagesRoot: imagesDir,
    sessionIndex,
    lookup,
    contentHashes,
    imported,
    skipped,
    shouldContinue,
  });

  return {
    imported,
    skipped,
    updated,
    candidates: candidates.length + sessionIndex.pendingResults().length,
    sessionBytesRead: sessionScan.bytesRead,
  };
}

async function readCodexImageCandidates(imagesDir: string): Promise<ImageCandidate[]> {
  const files = await walkFiles(imagesDir); const candidates: ImageCandidate[] = [];
  for (const imagePath of files) { if (!IMAGE_EXTENSIONS.has(extname(imagePath).toLowerCase()) || !isSafeChildPath(imagesDir, imagePath)) continue; let fileStat: Stats; try { fileStat = await stat(imagePath); } catch { continue; } if (!fileStat.isFile()) continue; const relativePath = relative(imagesDir, imagePath); const [taskId] = relativePath.split(sep); const fileName = basename(imagePath); candidates.push({ imagePath, taskId: taskId || null, fileName, fileStem: fileName.replace(/\.[^.]+$/, ""), fileStat, generatedAt: fileStat.birthtime.toISOString?.() || fileStat.mtime.toISOString() }); }
  return candidates.sort((l, r) => l.generatedAt.localeCompare(r.generatedAt));
}

function metadataForIndexedCandidate(task: CodexTaskMetadata, candidate: ImageCandidate): GenerationMetadata {
  return task.imageEvents.get(candidate.imagePath) || task.fallback;
}

async function ingestFilesystemCandidate({
  store,
  projectId,
  imagesRoot,
  candidate,
  generation,
  lookup,
  contentHashes,
  processedSignatures,
  imported,
  skipped,
  updated,
}: {
  store: Store;
  projectId: string;
  imagesRoot: string;
  candidate: ImageCandidate;
  generation: GenerationMetadata;
  lookup: ReturnType<typeof createBridgeAssetLookup>;
  contentHashes: Set<string>;
  processedSignatures: Map<string, string>;
  imported: unknown[];
  skipped: Array<{ path: string; reason: string; error?: string }>;
  updated: string[];
}): Promise<void> {
  const signature = candidateSignature(candidate, generation);
  if (processedSignatures.get(candidate.imagePath) === signature) {
    skipped.push({ path: candidate.imagePath, reason: "unchanged" });
    return;
  }

  const existingAtPath = await lookup.bySourcePath(candidate.imagePath);
  if (existingAtPath) {
    if (await upgradeGenerationMetadata(store, existingAtPath, generation)) updated.push(existingAtPath.id);
    skipped.push({ path: candidate.imagePath, reason: "already-archived" });
    processedSignatures.set(candidate.imagePath, signature);
    return;
  }

  let contentHash: string;
  try {
    contentHash = await sha256File(candidate.imagePath);
  } catch (error) {
    skipped.push({ path: candidate.imagePath, reason: "not-ready", error: error instanceof Error ? error.message : String(error) });
    return;
  }
  const existingByContent = contentHashes.has(contentHash) ? true : await lookup.byContentHash(contentHash);
  if (existingByContent) {
    skipped.push({ path: candidate.imagePath, reason: "already-archived-same-content" });
    contentHashes.add(contentHash);
    processedSignatures.set(candidate.imagePath, signature);
    return;
  }

  const pixelHash = extname(candidate.imagePath).toLowerCase() === ".svg"
    ? ""
    : await safePixelDigest(candidate.imagePath).catch(() => "");
  if (pixelHash && await lookup.byPixelHash(pixelHash)) {
    skipped.push({ path: candidate.imagePath, reason: "already-archived-same-pixels" });
    processedSignatures.set(candidate.imagePath, signature);
    return;
  }

  const imageInfo = await readImageInfo(candidate.imagePath, candidate.fileStat);
  try {
    const asset = await createAutomaticAssetWithCollisionFallback(store, {
      projectId,
      imagePath: candidate.imagePath,
      asset: candidate.fileName,
      assetId: `codex-${candidate.taskId || "image"}-${candidate.fileStem}`,
      prompt: generation.prompt,
      skill: "Codex automatic archive",
      ratio: imageInfo.ratio,
      theme: promptTheme(String(generation.prompt || "")),
      tags: ["codex", "auto-archived"],
      created_at: candidate.generatedAt,
      sourceType: "codex-generated",
      business_fields: {
        auto_archived: true,
        prompt_status: generation.promptStatus,
        user_message: generation.userMessage || null,
        file_bytes: candidate.fileStat.size,
        width: imageInfo.width,
        height: imageInfo.height,
        mime_type: imageInfo.mimeType,
      },
      source: {
        generation_tool: "codex-imagegen",
        codex_image_path: candidate.imagePath,
        codex_task_id: candidate.taskId || null,
        codex_output_file: candidate.fileName,
        codex_generated_at: candidate.generatedAt,
        codex_session_path: generation.sessionPath,
        codex_session_updated_at: generation.sessionUpdatedAt,
        codex_image_generation_call_id: generation.callId,
        codex_image_generated_at: generation.generatedAt,
        codex_session_event_key: generation.eventKey,
        model: generation.model,
        prompt_status: generation.promptStatus,
        user_message: generation.userMessage || null,
        codex_generation_origin: generation.origin || null,
        content_sha256: contentHash,
        pixel_sha256: pixelHash || null,
        pixel_hash_version: pixelHash ? PIXEL_HASH_VERSION : null,
        image_metadata: imageInfo,
      },
    }, { trustedSourceRoots: [imagesRoot], ingestMode: "automatic" });
    lookup.remember(asset);
    contentHashes.add(contentHash);
    processedSignatures.set(candidate.imagePath, signature);
    imported.push(asset);
  } catch (error) {
    if (isAutomaticImportSuppressed(error)) {
      skipped.push({ path: candidate.imagePath, reason: "suppressed-after-delete" });
      processedSignatures.set(candidate.imagePath, signature);
    } else if (isAutomaticIngestDuplicate(error)) {
      skipped.push({ path: candidate.imagePath, reason: automaticDuplicateReason(error) });
      processedSignatures.set(candidate.imagePath, signature);
    } else {
      skipped.push({ path: candidate.imagePath, reason: "import-failed", error: error instanceof Error ? error.message : String(error) });
    }
  }
}

async function ingestSessionResultCandidates({
  store,
  projectId,
  imagesRoot,
  sessionIndex,
  lookup,
  contentHashes,
  imported,
  skipped,
  shouldContinue,
}: {
  store: Store;
  projectId: string;
  imagesRoot: string;
  sessionIndex: CodexSessionIndex;
  lookup: ReturnType<typeof createBridgeAssetLookup>;
  contentHashes: Set<string>;
  imported: unknown[];
  skipped: Array<{ path: string; reason: string; error?: string }>;
  shouldContinue: () => boolean;
}): Promise<void> {
  for (const event of sessionIndex.pendingResults()) {
    if (!shouldContinue()) break;
    const sourceLabel = event.savedPath || event.sessionPath;
    if (event.savedPath && isSafeChildPath(imagesRoot, event.savedPath)) {
      const existingPath = await lookup.bySourcePath(event.savedPath);
      if (existingPath) {
        sessionIndex.acknowledgeResult(event.eventKey);
        skipped.push({ path: event.savedPath, reason: "already-archived" });
        continue;
      }
      try {
        const info = await stat(event.savedPath);
        if (info.isFile()) {
          skipped.push({ path: event.savedPath, reason: "awaiting-standard-file-ingest" });
          continue;
        }
      } catch {
        // Fall through to session-result recovery when Codex advertised a
        // standard path but the file was never persisted there.
      }
    }

    const existingEvent = await lookup.bySessionEventKey(event.eventKey);
    if (existingEvent) {
      sessionIndex.acknowledgeResult(event.eventKey);
      skipped.push({ path: sourceLabel, reason: "already-archived-session-result" });
      continue;
    }

    if (!event.resultAvailable) continue;
    await ingestOneSessionResult({ store, projectId, sessionIndex, event, lookup, contentHashes, imported, skipped });
  }
}

async function ingestOneSessionResult({
  store,
  projectId,
  sessionIndex,
  event,
  lookup,
  contentHashes,
  imported,
  skipped,
}: {
  store: Store;
  projectId: string;
  sessionIndex: CodexSessionIndex;
  event: CodexSessionImageEvent;
  lookup: ReturnType<typeof createBridgeAssetLookup>;
  contentHashes: Set<string>;
  imported: unknown[];
  skipped: Array<{ path: string; reason: string; error?: string }>;
}): Promise<void> {
  const sourceLabel = event.savedPath || event.sessionPath;
  let staged: StagedCodexSessionImage | null = null;
  try {
    const encoded = await sessionIndex.loadResult(event);
    if (!encoded) {
      sessionIndex.acknowledgeResult(event.eventKey);
      skipped.push({ path: sourceLabel, reason: "session-result-empty" });
      return;
    }
    staged = await stageCodexSessionImageResult({ assetsRoot: store.assetsRoot, eventKey: event.eventKey, result: encoded });
    const contentHash = await sha256File(staged.path);
    const existingByContent = contentHashes.has(contentHash) ? true : await lookup.byContentHash(contentHash);
    if (existingByContent) {
      contentHashes.add(contentHash);
      sessionIndex.acknowledgeResult(event.eventKey);
      skipped.push({ path: sourceLabel, reason: "already-archived-same-content" });
      return;
    }

    const pixelHash = await safePixelDigest(staged.path).catch(() => "");
    if (pixelHash && await lookup.byPixelHash(pixelHash)) {
      sessionIndex.acknowledgeResult(event.eventKey);
      skipped.push({ path: sourceLabel, reason: "already-archived-same-pixels" });
      return;
    }

    const task = sessionIndex.metadataForTask(event.taskId);
    const generation = generationForSessionResult(event, task);
    const fileStat = await stat(staged.path);
    const imageInfo = await readImageInfo(staged.path, fileStat);
    const eventDigest = createHash("sha256").update(event.eventKey).digest("hex").slice(0, 16);
    const fileName = `codex-session-${eventDigest}${staged.extension}`;
    const asset = await createAutomaticAssetWithCollisionFallback(store, {
      projectId,
      imagePath: staged.path,
      asset: fileName,
      assetId: `codex-session-${eventDigest}`,
      prompt: generation.prompt,
      skill: "Codex automatic archive",
      ratio: imageInfo.ratio,
      theme: promptTheme(generation.prompt),
      tags: ["codex", "auto-archived"],
      created_at: generation.generatedAt || new Date(fileStat.mtimeMs).toISOString(),
      sourceType: "codex-generated",
      business_fields: {
        auto_archived: true,
        prompt_status: generation.promptStatus,
        user_message: generation.userMessage || null,
        file_bytes: fileStat.size,
        width: imageInfo.width,
        height: imageInfo.height,
        mime_type: imageInfo.mimeType,
      },
      source: {
        path: event.sessionPath,
        generation_tool: "codex-imagegen-session-recovery",
        codex_image_path: event.savedPath,
        codex_task_id: event.taskId || null,
        codex_output_file: fileName,
        codex_session_path: event.sessionPath,
        codex_session_updated_at: generation.sessionUpdatedAt,
        codex_image_generation_call_id: event.callId,
        codex_image_generated_at: generation.generatedAt,
        codex_session_event_key: event.eventKey,
        codex_recovered_from_session: true,
        model: generation.model,
        prompt_status: generation.promptStatus,
        user_message: generation.userMessage || null,
        codex_generation_origin: generation.origin || null,
        content_sha256: contentHash,
        pixel_sha256: pixelHash || null,
        pixel_hash_version: pixelHash ? PIXEL_HASH_VERSION : null,
        image_metadata: imageInfo,
      },
    }, { trustedSourceRoots: [staged.root], ingestMode: "automatic" });
    lookup.remember(asset);
    contentHashes.add(contentHash);
    sessionIndex.acknowledgeResult(event.eventKey);
    imported.push(asset);
  } catch (error) {
    if (isAutomaticImportSuppressed(error)) {
      sessionIndex.acknowledgeResult(event.eventKey);
      skipped.push({ path: sourceLabel, reason: "suppressed-after-delete" });
    } else if (isAutomaticIngestDuplicate(error)) {
      sessionIndex.acknowledgeResult(event.eventKey);
      skipped.push({ path: sourceLabel, reason: automaticDuplicateReason(error) });
    } else if (isPermanentSessionRecoveryError(error)) {
      sessionIndex.acknowledgeResult(event.eventKey);
      skipped.push({ path: sourceLabel, reason: "session-result-invalid", error: error instanceof Error ? error.message : String(error) });
    } else {
      skipped.push({ path: sourceLabel, reason: "session-result-import-failed", error: error instanceof Error ? error.message : String(error) });
    }
  } finally {
    await removeCodexSessionStagedImage(staged).catch(() => {});
  }
}

function generationForSessionResult(event: CodexSessionImageEvent, task: CodexTaskMetadata): GenerationMetadata {
  if (event.prompt) return event;
  return {
    ...event,
    prompt: task.fallback.prompt,
    promptStatus: task.fallback.promptStatus,
    userMessage: event.userMessage || null,
    model: event.model || task.fallback.model,
  };
}

function isPermanentSessionRecoveryError(error: unknown): boolean {
  const code = error && typeof error === "object" ? String((error as { code?: unknown }).code || "") : "";
  return code.startsWith("CODEX_SESSION_IMAGE_") || code === "CODEX_SESSION_EVENT_TOO_LARGE";
}

function createBridgeAssetLookup(store: Store, projectId: string) {
  let fallbackAssets: Promise<StoredAsset[]> | null = null;
  const listed = () => fallbackAssets ||= Promise.all([store.listAssets({ projectId }), store.listAssets({ projectId, archived: true })]).then(([active, archived]) => [...active, ...archived]);
  const remembered: StoredAsset[] = [];
  return {
    async bySourcePath(path: string) {
      const direct = typeof store.findAssetBySourcePath === "function" ? await store.findAssetBySourcePath(projectId, path) : null;
      if (direct) return direct;
      const resolved = resolve(path);
      const local = remembered.find((asset) => [asset.source?.path, asset.source?.codex_image_path].some((value) => typeof value === "string" && resolve(value) === resolved));
      if (local) return local;
      if (typeof store.findAssetBySourcePath === "function") return null;
      return (await listed()).find((asset) => [asset.source?.path, asset.source?.codex_image_path].some((value) => typeof value === "string" && resolve(value) === resolved)) || null;
    },
    async byContentHash(hash: string) {
      const local = remembered.find((asset) => asset.source?.content_sha256 === hash);
      if (local) return local;
      if (typeof store.findAssetByContentHash === "function") return store.findAssetByContentHash(projectId, hash);
      return (await listed()).find((asset) => asset.source?.content_sha256 === hash) || null;
    },
    async byPixelHash(hash: string) {
      const local = remembered.find((asset) => asset.source?.pixel_hash_version === PIXEL_HASH_VERSION && asset.source?.pixel_sha256 === hash);
      if (local) return local;
      if (typeof store.findAssetByPixelHash === "function") return store.findAssetByPixelHash(projectId, hash);
      return (await listed()).find((asset) => asset.source?.pixel_hash_version === PIXEL_HASH_VERSION && asset.source?.pixel_sha256 === hash) || null;
    },
    async bySessionEventKey(eventKey: string) {
      const local = remembered.find((asset) => asset.source?.codex_session_event_key === eventKey);
      if (local) return local;
      return (await listed()).find((asset) => asset.source?.codex_session_event_key === eventKey) || null;
    },
    remember(asset: StoredAsset) { remembered.push(asset); },
  };
}

function assetUserMessage(asset: StoredAsset): string {
  const value = asset.source?.user_message ?? asset.business_fields?.user_message;
  return typeof value === "string" ? value.trim() : "";
}

async function upgradeGenerationMetadata(store: Store, asset: StoredAsset, generation: GenerationMetadata): Promise<boolean> {
  const existingUserMessage = assetUserMessage(asset);
  const nextUserMessage = generation.userMessage || null;
  const userMessageChanged = !existingUserMessage && Boolean(nextUserMessage);
  if (generation.promptStatus !== "image-generation-revised-prompt") {
    if (!userMessageChanged) return false;
    // User-message-only backfill: an older generation may carry the user's
    // words without a revisable prompt, and that must not touch the prompt
    // or its provenance status.
    await store.updateMetadata(asset.project_id, asset.id, {
      business_fields: { ...(asset.business_fields || {}), user_message: nextUserMessage },
      source: { ...(asset.source || {}), user_message: nextUserMessage },
    });
    return true;
  }

  const nextTheme = promptTheme(generation.prompt);
  const promptChanged = asset.prompt !== generation.prompt;
  const themeChanged = Boolean(nextTheme) && asset.theme !== nextTheme;
  const nextSource: Record<string, unknown> = {
    ...(asset.source || {}),
    codex_session_path: generation.sessionPath || asset.source?.codex_session_path || null,
    codex_image_generation_call_id: generation.callId || asset.source?.codex_image_generation_call_id || null,
    codex_image_generated_at: generation.generatedAt || asset.source?.codex_image_generated_at || null,
    model: generation.model || asset.source?.model || null,
    prompt_status: generation.promptStatus,
    codex_generation_origin: generation.origin || asset.source?.codex_generation_origin || null,
  };
  if (userMessageChanged) nextSource.user_message = nextUserMessage;
  const sourceChanged = [
    "codex_session_path",
    "codex_image_generation_call_id",
    "codex_image_generated_at",
    "model",
    "prompt_status",
    "user_message",
    "codex_generation_origin",
  ].some((key) => asset.source?.[key] !== nextSource[key]);
  const businessStatusChanged = asset.business_fields?.prompt_status !== generation.promptStatus;
  if (!promptChanged && !themeChanged && !sourceChanged && !businessStatusChanged && !userMessageChanged) return false;

  // Session mtime is provenance, not business identity. Record the freshest
  // value only when a real prompt/call/model/provenance upgrade already
  // warrants a write; mtime churn alone must never create a library revision.
  if (generation.sessionUpdatedAt) nextSource.codex_session_updated_at = generation.sessionUpdatedAt;

  await store.updateMetadata(asset.project_id, asset.id, {
    ...(promptChanged ? { prompt: generation.prompt } : {}),
    ...(themeChanged ? { theme: nextTheme } : {}),
    business_fields: {
      ...(asset.business_fields || {}),
      prompt_status: generation.promptStatus,
      ...(userMessageChanged ? { user_message: nextUserMessage } : {}),
    },
    source: nextSource,
  });
  return true;
}

function candidateSignature(candidate: ImageCandidate, generation: GenerationMetadata): string {
  return [candidate.fileStat.size, candidate.fileStat.mtimeMs, generation.promptStatus, generation.sessionPath || "", generation.callId || "", generation.generatedAt || "", generation.model || "", generation.prompt, generation.userMessage || ""].join("\u001f");
}
function pruneProcessedSignatures(cache: Map<string, string>, livePaths: string[]): void {
  const live = new Set(livePaths);
  for (const path of cache.keys()) if (!live.has(path)) cache.delete(path);
}
function promptTheme(prompt: string): string { const match = /^Asset type:\s*(.+)$/mi.exec(String(prompt || "")); return match?.[1]?.trim() || ""; }

async function readImageInfo(imagePath: string, fileStat: Stats): Promise<ImageInfo> {
  const extension = extname(imagePath).toLowerCase(); const imageInfo: ImageInfo = { width: null, height: null, ratio: "", mimeType: mimeTypeForExtension(extension), bytes: fileStat.size };
  try { const buffer = await readFile(imagePath); if (extension === ".png" && buffer.length >= 24 && buffer.subarray(1, 4).toString("ascii") === "PNG") { imageInfo.width = buffer.readUInt32BE(16); imageInfo.height = buffer.readUInt32BE(20); } else if (extension === ".gif" && buffer.length >= 10) { imageInfo.width = buffer.readUInt16LE(6); imageInfo.height = buffer.readUInt16LE(8); } imageInfo.ratio = ratioFromDimensions(imageInfo.width ?? 0, imageInfo.height ?? 0); } catch {}
  return imageInfo;
}

function ratioFromDimensions(width: number | null, height: number | null): string { if (!Number.isFinite(width) || !Number.isFinite(height) || width! <= 0 || height! <= 0) return ""; const d = gcd(width!, height!); return `${width! / d}:${height! / d}`; }
function gcd(l: number, r: number): number { let a = Math.abs(l); let b = Math.abs(r); while (b) [a, b] = [b, a % b]; return a || 1; }
function mimeTypeForExtension(ext: string): string { return ({ ".apng": "image/apng", ".avif": "image/avif", ".gif": "image/gif", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp" } as Record<string, string>)[ext] || "application/octet-stream"; }
async function walkFiles(root: string): Promise<string[]> { let entries; try { entries = await readdir(root, { withFileTypes: true }); } catch (error: unknown) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return []; throw error; } const files: string[] = []; for (const entry of entries) { const entryPath = join(root, entry.name); if (entry.isDirectory()) files.push(...await walkFiles(entryPath)); else if (entry.isFile()) files.push(entryPath); } return files; }
function createWatcher(root: string, onChange: () => void, onUnavailable: () => void): FSWatcher | null {
  try {
    const watcher = watch(root, { recursive: true }, onChange);
    watcher.on("error", () => {
      watcher.close();
      onUnavailable();
    });
    return watcher;
  } catch {
    onUnavailable();
    return null;
  }
}
export async function sha256File(filePath: string): Promise<string> { return createHash("sha256").update(await readFile(filePath)).digest("hex"); }
function isSafeChildPath(parent: string, child: string): boolean { const p = relative(parent, child); return Boolean(p) && !p.startsWith("..") && !p.includes(`..${sep}`) && !isAbsolute(p); }
function isAutomaticImportSuppressed(error: unknown): boolean { return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "AUTOMATIC_IMPORT_SUPPRESSED"); }
function isAutomaticIngestDuplicate(error: unknown): boolean { return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "AUTOMATIC_INGEST_DUPLICATE"); }
function automaticDuplicateReason(error: unknown): string { return (error as { identityKind?: unknown })?.identityKind === "pixel" ? "already-archived-same-pixels" : "already-archived-same-content"; }
async function createAutomaticAssetWithCollisionFallback(store: Store, input: Record<string, unknown>, options: Record<string, unknown>): Promise<StoredAsset> {
  try {
    return await store.createAsset(input, options);
  } catch (error) {
    if (!error || typeof error !== "object" || (error as { code?: unknown }).code !== "ASSET_ALREADY_EXISTS") throw error;
    const baseId = String(input.assetId || "codex-image").slice(0, 140);
    return store.createAsset({ ...input, assetId: `${baseId}-${randomUUID().slice(0, 8)}` }, options);
  }
}
