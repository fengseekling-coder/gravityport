import { createHash, randomUUID } from "node:crypto";
import { createReadStream, watch, type FSWatcher } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { PIXEL_HASH_VERSION, safePixelDigest } from "./image-pixel-hash.js";
import { resolveSourceLocations } from "./source-locations.js";
import { isPromptUserEdited, isThemeUserEdited } from "./user-edit-marker.mjs";

const IMAGE_EXTENSIONS = new Set([".apng", ".avif", ".gif", ".jpg", ".jpeg", ".png", ".svg", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".m4v", ".mov", ".mp4", ".webm"]);
const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);
const MEDIA_TOOLS = new Set(["image_gen", "image_edit", "image_to_video", "reference_to_video"]);
const MEDIA_FOLDERS = new Set(["images", "videos"]);
const DEFAULT_PROJECT_ID = "default";
const SESSION_ID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PROMPT_RANK: Record<string, number> = { "not-available": 0, "session-user-prompt": 1, "generation-tool-prompt": 2 };

interface StoredAsset { source?: Record<string, unknown>; id?: string; image_path?: string; project_id?: string; prompt?: string; theme?: string; business_fields?: Record<string, unknown>; created_at?: string; [key: string]: unknown; }
interface Store { createAsset(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<Record<string, unknown>>; listAssets(filters: Record<string, unknown>): Promise<StoredAsset[]>; findAssetBySourcePath?(projectId: string, sourcePath: string): Promise<StoredAsset | null>; findAssetByContentHash?(projectId: string, contentHash: string): Promise<StoredAsset | null>; findAssetByPixelHash?(projectId: string, pixelHash: string): Promise<StoredAsset | null>; updateMetadata(projectId: string, assetId: string, metadata: Record<string, unknown>): Promise<void>; [key: string]: unknown; }
interface MediaCandidate { mediaPath: string; discoveredPath: string; relativePath: string; sessionId: string; sessionPath: string | null; mediaFolder: string; mediaKind: string; fileName: string; fileStem: string; fileStat: Stats; generatedAt: string; }
interface GenerationMetadata { sessionId: string; prompt: string; promptStatus: string; userMessage: string | null; sessionPath: string | null; sessionUpdatedAt: string | null; callId: string | null; generatedAt: string | null; model: string | null; toolName: string | null; aspectRatio: string | null; matched: boolean; }
interface SessionMetadata { sessionId: string; sessionPath: string | null; mediaPrompts: Map<string, GenerationMetadata>; }
interface CachedSessionMetadata { mtimeMs: number; size: number; metadata: SessionMetadata; warnings: string[]; }
interface MediaInfo { width: number | null; height: number | null; ratio: string; mimeType: string; bytes: number; media_kind: string; }
interface BridgeStatus { sessionsDir: string; enabled: boolean; watching: boolean; polling: boolean; busy: boolean; lastScanAt: string | null; lastImportedAt: string | null; lastImportCount: number; totalImported: number; lastSkippedCount: number; lastError: string | null; lastWarning: string | null; }
interface ReconcileResult { imported: unknown[]; skipped: Array<{ path: string; reason: string; error?: string }>; updated: string[]; candidates: number; warnings: string[]; queued?: boolean; }
interface Bridge { start(): Promise<BridgeStatus>; stop(): Promise<void>; reconcile(): Promise<ReconcileResult>; scheduleReconcile(): void; status(): BridgeStatus; }
interface MediaPromptCall { toolName: string; prompt: string; contextUserPrompt: string; userPrompt: string; aspectRatio: string | null; model: string; callId: string; }

export function createGrokMediaBridge(options: { store?: Store; sessionsDir?: string; projectId?: string; debounceMs?: number; pollIntervalMs?: number; signal?: AbortSignal; } = {}): Bridge {
  const store = options.store;
  if (!store || typeof store.createAsset !== "function" || typeof store.listAssets !== "function") throw new Error("Grok media bridge requires a GravityPort store.");
  const { grokSessionsDir: sessionsDir } = resolveSourceLocations({
    env: process.env,
    overrides: { grokSessionsDir: options.sessionsDir },
  });
  const projectId = options.projectId || DEFAULT_PROJECT_ID;
  const debounceMs = options.debounceMs != null && Number.isFinite(options.debounceMs) ? Math.max(0, options.debounceMs) : 500;
  const pollIntervalMs = options.pollIntervalMs != null && Number.isFinite(options.pollIntervalMs) ? Math.max(250, options.pollIntervalMs) : 30000;
  const processedSignatures = new Map<string, string>();
  const sessionMetadataCache = new Map<string, CachedSessionMetadata>();
  let watcher: FSWatcher | null = null; let poller: ReturnType<typeof setInterval> | null = null; let timer: ReturnType<typeof setTimeout> | null = null;
  let enabled = false; let reconciling = false; let reconcileAgain = false;
  let activeReconcile: Promise<ReconcileResult> | null = null; let stopPromise: Promise<void> | null = null;
  const state: Omit<BridgeStatus, "watching" | "polling" | "busy"> = { sessionsDir, enabled: false, lastScanAt: null, lastImportedAt: null, lastImportCount: 0, totalImported: 0, lastSkippedCount: 0, lastError: null, lastWarning: null };
  async function reconcile(): Promise<ReconcileResult> {
    if (!enabled) return { imported: [], skipped: [], updated: [], queued: true, candidates: 0, warnings: [] };
    if (reconciling) { reconcileAgain = true; return { imported: [], skipped: [], updated: [], queued: true, candidates: 0, warnings: [] }; }
    reconciling = true;
    const run = (async (): Promise<ReconcileResult> => {
      try { const result = await reconcileGrokMedia({ store: store!, sessionsDir, projectId, processedSignatures, sessionMetadataCache, shouldContinue: () => enabled && !options.signal?.aborted }); state.lastScanAt = new Date().toISOString(); state.lastImportCount = result.imported.length; state.lastSkippedCount = result.skipped.length; state.totalImported += result.imported.length; state.lastError = null; state.lastWarning = result.warnings?.length ? result.warnings.slice(0, 5).join("; ") : null; if (result.imported.length > 0) state.lastImportedAt = state.lastScanAt; return result; } catch (error) { state.lastScanAt = new Date().toISOString(); state.lastError = error instanceof Error ? error.message : String(error); throw error; } finally { reconciling = false; activeReconcile = null; if (reconcileAgain && enabled) { reconcileAgain = false; scheduleReconcile(); } else reconcileAgain = false; }
    })();
    activeReconcile = run;
    return run;
  }
  function scheduleReconcile(): void { if (!enabled) return; if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; if (enabled) reconcile().catch(() => {}); }, debounceMs); }
  async function start(): Promise<BridgeStatus> { if (enabled) return apiStatus(); enabled = true; state.enabled = true; try { await mkdir(sessionsDir, { recursive: true }); if (!enabled) return apiStatus(); await reconcile(); if (!enabled) return apiStatus(); try { watcher = watch(sessionsDir, { recursive: true }, () => scheduleReconcile()); watcher.on("error", () => { watcher?.close(); watcher = null; }); } catch { watcher = null; } if (!enabled) { watcher?.close(); watcher = null; return apiStatus(); } poller = setInterval(() => { if (enabled) reconcile().catch(() => {}); }, pollIntervalMs); return apiStatus(); } catch (error) { enabled = false; state.enabled = false; throw error; } }
  function stop(): Promise<void> { if (stopPromise) return stopPromise; enabled = false; state.enabled = false; reconcileAgain = false; if (timer) clearTimeout(timer); timer = null; if (poller) clearInterval(poller); poller = null; watcher?.close(); watcher = null; const currentReconcile = activeReconcile; stopPromise = Promise.resolve(currentReconcile).catch(() => {}).then(() => {}).finally(() => { stopPromise = null; }); return stopPromise; }
  function apiStatus(): BridgeStatus { return { ...state, watching: Boolean(watcher), polling: Boolean(poller), busy: reconciling || reconcileAgain || Boolean(timer) }; }
  return { start, stop, reconcile, scheduleReconcile, status: apiStatus };
}

export async function reconcileGrokMedia(options: { store: Store; sessionsDir: string; projectId?: string; knownHashes?: Set<string> | null; processedSignatures?: Map<string, string> | null; sessionMetadataCache?: Map<string, CachedSessionMetadata> | null; sha256FileImpl?: typeof sha256File; shouldContinue?: () => boolean; }): Promise<ReconcileResult> {
  const { store, sessionsDir, projectId = DEFAULT_PROJECT_ID, knownHashes: knownHashesOpt, processedSignatures = null, sessionMetadataCache = null, sha256FileImpl = sha256File } = options;
  const root = resolve(sessionsDir); let rootReal: string;
  try { rootReal = await realpath(root); } catch (error: unknown) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { imported: [], skipped: [], updated: [], candidates: 0, warnings: [] }; throw error; }
  const { candidates, skipped: discoverySkipped } = await readGrokMediaCandidates(root, rootReal);
  if (processedSignatures) pruneProcessedSignatures(processedSignatures, candidates.map((candidate) => candidate.mediaPath));
  const lookup = createBridgeAssetLookup(store, projectId);
  const contentHashes = knownHashesOpt || new Set<string>();
  const sessionIds = new Set(candidates.map((c) => c.sessionId).filter(Boolean));
  if (sessionMetadataCache) {
    const liveSessionRoots = new Set<string>();
    for (const sessionPath of new Set(candidates.map((candidate) => candidate.sessionPath).filter(Boolean) as string[])) {
      const canonical = await realpath(sessionPath).catch(() => null);
      if (canonical) liveSessionRoots.add(canonical);
    }
    for (const chatPath of sessionMetadataCache.keys()) {
      if (!liveSessionRoots.has(dirname(chatPath))) sessionMetadataCache.delete(chatPath);
    }
  }
  const { sessions: sessionMetadata, warnings } = await readGrokSessionMetadata(rootReal, sessionIds, candidates, sessionMetadataCache);
  const imported: unknown[] = []; const skipped: Array<{ path: string; reason: string; error?: string }> = [...discoverySkipped]; const updated: string[] = [];

  for (const candidate of candidates) {
    if (options.shouldContinue?.() === false) break;
    if (!(await isCanonicalChildPath(rootReal, candidate.mediaPath))) { skipped.push({ path: candidate.mediaPath, reason: "out-of-root" }); continue; }
    const generation = metadataForCandidate(sessionMetadata.get(candidate.sessionId), candidate);
    const signature = candidateSignature(candidate, generation);
    if (processedSignatures?.get(candidate.mediaPath) === signature) {
      skipped.push({ path: candidate.mediaPath, reason: "unchanged" });
      continue;
    }
    const existingAtPath = await lookup.bySourcePath(candidate.mediaPath);
    if (existingAtPath) {
      if (await upgradeGenerationMetadata(store, existingAtPath as unknown as Record<string, unknown>, generation, candidate)) {
        updated.push(existingAtPath.id as string);
      }
      skipped.push({ path: candidate.mediaPath, reason: "already-archived" });
      processedSignatures?.set(candidate.mediaPath, signature);
      continue;
    }
    let contentHash: string; try { contentHash = await sha256FileImpl(candidate.mediaPath); } catch (error) { skipped.push({ path: candidate.mediaPath, reason: "not-ready", error: error instanceof Error ? error.message : String(error) }); continue; }
    const existingAsset = await lookup.byContentHash(contentHash);
    if (existingAsset || contentHashes.has(contentHash)) {
      if (existingAsset && await upgradeGenerationMetadata(store, existingAsset as unknown as Record<string, unknown>, generation, candidate)) {
        updated.push(existingAsset.id as string);
      }
      skipped.push({ path: candidate.mediaPath, reason: "already-archived-same-content" });
      contentHashes.add(contentHash);
      processedSignatures?.set(candidate.mediaPath, signature);
      continue;
    }
    const pixelHash = candidate.mediaKind === "image" && extname(candidate.mediaPath).toLowerCase() !== ".svg"
      ? await safePixelDigest(candidate.mediaPath).catch(() => "")
      : "";
    if (pixelHash && await lookup.byPixelHash(pixelHash)) {
      skipped.push({ path: candidate.mediaPath, reason: "already-archived-same-pixels" });
      processedSignatures?.set(candidate.mediaPath, signature);
      continue;
    }
    const mediaInfo = await readMediaInfo(candidate.mediaPath, candidate.fileStat, candidate.mediaKind);
    try { const asset = await createAutomaticAssetWithCollisionFallback(store, { projectId, imagePath: candidate.mediaPath, asset: candidate.fileName, assetId: buildGrokAssetId(candidate), prompt: generation.prompt, skill: "Grok automatic archive", ratio: mediaInfo.ratio || generation.aspectRatio || "", theme: promptTheme(generation.prompt), tags: ["grok", "auto-archived", candidate.mediaKind], created_at: candidate.generatedAt, sourceType: "grok-generated", business_fields: { auto_archived: true, media_kind: candidate.mediaKind, prompt_status: generation.promptStatus, user_message: generation.userMessage || null, file_bytes: candidate.fileStat.size, width: mediaInfo.width, height: mediaInfo.height, mime_type: mediaInfo.mimeType }, source: { generation_tool: generation.toolName || `grok-${candidate.mediaKind}`, media_kind: candidate.mediaKind, grok_media_path: candidate.mediaPath, grok_session_id: candidate.sessionId || null, grok_session_path: generation.sessionPath || candidate.sessionPath || null, grok_session_folder: candidate.mediaFolder, grok_output_file: candidate.fileName, grok_generated_at: candidate.generatedAt, grok_tool_call_id: generation.callId, model: generation.model, prompt_status: generation.promptStatus, user_message: generation.userMessage || null, content_sha256: contentHash, pixel_sha256: pixelHash || null, pixel_hash_version: pixelHash ? PIXEL_HASH_VERSION : null, media_metadata: mediaInfo } }, { trustedSourceRoots: [rootReal], ingestMode: "automatic" }); lookup.remember(asset as StoredAsset); contentHashes.add(contentHash); processedSignatures?.set(candidate.mediaPath, signature); imported.push(asset); } catch (error) { if (isAutomaticImportSuppressed(error)) { skipped.push({ path: candidate.mediaPath, reason: "suppressed-after-delete" }); processedSignatures?.set(candidate.mediaPath, signature); } else if (isAutomaticIngestDuplicate(error)) { skipped.push({ path: candidate.mediaPath, reason: automaticDuplicateReason(error) }); processedSignatures?.set(candidate.mediaPath, signature); } else skipped.push({ path: candidate.mediaPath, reason: "import-failed", error: error instanceof Error ? error.message : String(error) }); }
  }
  return { imported, skipped, updated, candidates: candidates.length, warnings };
}

export function buildGrokAssetId(candidate: { sessionId?: string; mediaKind: string; relativePath?: string; mediaFolder?: string; fileName?: string; mediaPath?: string; fileStem?: string }): string {
  const sessionId = String(candidate.sessionId || "session").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40);
  const mediaKind = candidate.mediaKind === "video" ? "video" : "image";
  const pathKey = String(candidate.relativePath || (candidate.sessionId && candidate.mediaFolder && candidate.fileName ? `${candidate.sessionId}/${candidate.mediaFolder}/${candidate.fileName}` : candidate.mediaPath || candidate.fileName || "media"));
  const pathHash = createHash("sha256").update(pathKey).digest("hex").slice(0, 12);
  const fileHint = String(candidate.fileName || candidate.fileStem || "media").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").replace(/\./g, "-").slice(0, 24) || "media";
  return `grok-${sessionId}-${mediaKind}-${fileHint}-${pathHash}`.slice(0, 96);
}

export async function readGrokMediaCandidates(sessionsDir: string, rootReal: string | null = null): Promise<{ candidates: MediaCandidate[]; skipped: Array<{ path: string; reason: string }> }> {
  const root = resolve(sessionsDir);
  const canonicalRoot = rootReal || await realpath(root).catch((error: unknown) => { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null; throw error; });
  if (!canonicalRoot) return { candidates: [], skipped: [] };
  const files = await walkFiles(root); const candidates: MediaCandidate[] = []; const skipped: Array<{ path: string; reason: string }> = [];
  for (const mediaPath of files) {
    if (!MEDIA_EXTENSIONS.has(extname(mediaPath).toLowerCase())) continue;
    if (!isSafeChildPath(root, mediaPath) && !isSafeChildPath(canonicalRoot, mediaPath)) continue;
    let linkStat; try { linkStat = await lstat(mediaPath); } catch { continue; }
    if (linkStat.isSymbolicLink()) { skipped.push({ path: mediaPath, reason: "symlink-rejected" }); continue; }
    if (!linkStat.isFile() || linkStat.size <= 0) continue;
    let canonicalPath: string; try { canonicalPath = await realpath(mediaPath); } catch (error) { skipped.push({ path: mediaPath, reason: "not-ready" }); continue; }
    if (!(await isCanonicalChildPath(canonicalRoot, canonicalPath))) { skipped.push({ path: mediaPath, reason: "out-of-root" }); continue; }
    const location = sessionMediaLocation(canonicalRoot, canonicalPath) || sessionMediaLocation(root, mediaPath); if (!location) continue;
    let fileStat: Stats; try { fileStat = await stat(canonicalPath); } catch (error) { skipped.push({ path: mediaPath, reason: "not-ready" }); continue; }
    if (!fileStat.isFile() || fileStat.size <= 0) continue;
    const fileName = basename(canonicalPath);
    candidates.push({ mediaPath: canonicalPath, discoveredPath: mediaPath, relativePath: relative(canonicalRoot, canonicalPath), sessionId: location.sessionId, sessionPath: location.sessionPath, mediaFolder: location.mediaFolder, mediaKind: location.mediaKind, fileName, fileStem: fileName.replace(/\.[^.]+$/, ""), fileStat, generatedAt: fileStat.birthtime?.toISOString?.() || fileStat.mtime.toISOString() });
  }
  return { candidates: candidates.sort((l, r) => l.generatedAt.localeCompare(r.generatedAt)), skipped };
}

function sessionMediaLocation(sessionsRoot: string, mediaPath: string): { sessionId: string; sessionPath: string; mediaFolder: string; mediaKind: string } | null {
  const rel = relative(resolve(sessionsRoot), resolve(mediaPath));
  if (!rel || rel.startsWith("..") || rel.includes(`..${sep}`) || isAbsolute(rel)) return null;
  const parts = rel.split(sep); if (parts.length < 3) return null;
  const mediaFolder = parts[parts.length - 2]; if (!MEDIA_FOLDERS.has(mediaFolder)) return null;
  const sessionId = parts[parts.length - 3]; if (!SESSION_ID_RE.test(sessionId)) return null;
  const sessionPath = join(resolve(sessionsRoot), ...parts.slice(0, -2));
  const mediaKind = mediaFolder === "videos" || VIDEO_EXTENSIONS.has(extname(mediaPath).toLowerCase()) ? "video" : "image";
  return { sessionId, sessionPath, mediaFolder, mediaKind };
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
      const local = remembered.find((asset) => [asset.source?.path, asset.source?.grok_media_path].some((value) => typeof value === "string" && resolve(value) === resolved));
      if (local) return local;
      if (typeof store.findAssetBySourcePath === "function") return null;
      return (await listed()).find((asset) => [asset.source?.path, asset.source?.grok_media_path].some((value) => typeof value === "string" && resolve(value) === resolved)) || null;
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
    remember(asset: StoredAsset) { remembered.push(asset); },
  };
}

function metadataForCandidate(sessionMeta: SessionMetadata | undefined, candidate: MediaCandidate): GenerationMetadata {
  if (!sessionMeta) return { sessionId: candidate.sessionId, prompt: "", promptStatus: "not-available", userMessage: null, sessionPath: candidate.sessionPath || null, sessionUpdatedAt: null, callId: null, generatedAt: null, model: null, toolName: null, aspectRatio: null, matched: false };
  return sessionMeta.mediaPrompts.get(candidate.mediaPath) || sessionMeta.mediaPrompts.get(candidate.discoveredPath) || { sessionId: sessionMeta.sessionId, prompt: "", promptStatus: "not-available", userMessage: null, sessionPath: candidate.sessionPath || sessionMeta.sessionPath, sessionUpdatedAt: null, callId: null, generatedAt: null, model: null, toolName: null, aspectRatio: null, matched: false };
}

function candidateSignature(candidate: MediaCandidate, generation: GenerationMetadata): string {
  return [
    candidate.fileStat.size,
    candidate.fileStat.mtimeMs,
    generation.promptStatus,
    generation.sessionPath || "",
    generation.callId || "",
    generation.generatedAt || "",
    generation.model || "",
    generation.toolName || "",
    generation.prompt,
    generation.userMessage || "",
  ].join("\u001f");
}
function pruneProcessedSignatures(cache: Map<string, string>, livePaths: string[]): void {
  const live = new Set(livePaths);
  for (const path of cache.keys()) if (!live.has(path)) cache.delete(path);
}

function promptTheme(prompt: string): string { const text = String(prompt || "").trim(); if (!text) return ""; return text.split(/\r?\n/, 1)[0].slice(0, 120); }

async function readGrokSessionMetadata(sessionsRoot: string, sessionIds: Set<string>, candidates: MediaCandidate[], sessionMetadataCache: Map<string, CachedSessionMetadata> | null = null): Promise<{ sessions: Map<string, SessionMetadata>; warnings: string[] }> {
  const result = new Map<string, SessionMetadata>(); const warnings: string[] = []; if (!sessionIds.size) return { sessions: result, warnings };
  const sessionPaths = new Map<string, string | null>(); for (const c of candidates) { if (c.sessionId && c.sessionPath && !sessionPaths.has(c.sessionId)) sessionPaths.set(c.sessionId, c.sessionPath); }
  await Promise.all([...sessionIds].map(async (sid) => { const parsed = await readSessionMetadataFile(sid, sessionPaths.get(sid) || null, sessionsRoot, sessionMetadataCache); result.set(sid, parsed.metadata); warnings.push(...parsed.warnings); }));
  return { sessions: result, warnings };
}

async function readSessionMetadataFile(sessionId: string, sessionPath: string | null, sessionsRoot: string, sessionMetadataCache: Map<string, CachedSessionMetadata> | null = null): Promise<{ metadata: SessionMetadata; warnings: string[] }> {
  const warnings: string[] = [];
  if (!sessionPath || !isSafeChildPath(sessionsRoot, sessionPath)) return { metadata: { sessionId, sessionPath: null, mediaPrompts: new Map() }, warnings };
  const chatPath = join(sessionPath, "chat_history.jsonl");
  const chatSafe = await inspectSafeSessionFile(chatPath, sessionsRoot, "chat_history.jsonl", warnings, sessionId);
  if (!chatSafe.ok) { if (chatSafe.reason !== "missing") warnings.push(`session ${sessionId}: rejected chat_history.jsonl (${chatSafe.reason})`); return { metadata: { sessionId, sessionPath, mediaPrompts: new Map() }, warnings }; }
  // Fail closed: an existing but unsafe summary.json must not pair with chat provenance.
  // Missing optional summary.json and malformed JSON remain non-fatal.
  const summarySafe = await assertSafeSessionFile(join(sessionPath, "summary.json"), sessionsRoot);
  if (!summarySafe.ok && isUnsafeSessionFileReason(summarySafe.reason)) {
    warnings.push(`session ${sessionId}: rejected summary.json (${summarySafe.reason})`);
    return { metadata: { sessionId, sessionPath, mediaPrompts: new Map() }, warnings };
  }
  const chatStat = chatSafe.stat!;
  const cached = sessionMetadataCache?.get(chatSafe.path!);
  if (cached?.mtimeMs === chatStat.mtimeMs && cached?.size === chatStat.size) {
    return { metadata: cached.metadata, warnings: [...cached.warnings] };
  }
  let raw: string;
  try { raw = await readFile(chatSafe.path!, "utf8"); }
  catch { return { metadata: { sessionId, sessionPath, mediaPrompts: new Map() }, warnings: [...warnings, `session ${sessionId}: rejected chat_history.jsonl (read-failed)`] }; }
  const mediaPrompts = new Map<string, GenerationMetadata>(); const pendingCalls = new Map<string, MediaPromptCall>();
  let currentModel: string | null = null; let latestUserPrompt = ""; let parseFailures = 0;

  for (const line of raw.split("\n")) {
    if (!line) continue; let event: Record<string, unknown>; try { event = JSON.parse(line); } catch { parseFailures += 1; continue; }
    if (event?.type === "user") { const text = extractUserPromptText(event); if (text) latestUserPrompt = text; continue; }
    if (event?.type === "assistant") { currentModel = String(event.model_id || currentModel || "").trim() || currentModel; for (const call of (event.tool_calls as Array<Record<string, unknown>>) || []) { const name = String(call?.name || "").trim(); if (!MEDIA_TOOLS.has(name)) continue; const callId = String(call?.id || "").trim(); if (!callId) continue; const args = parseJsonObject(call.arguments); const toolPrompt = String(args.prompt || "").trim(); pendingCalls.set(callId, { toolName: name, prompt: toolPrompt, contextUserPrompt: toolPrompt ? "" : latestUserPrompt, userPrompt: latestUserPrompt, aspectRatio: String(args.aspect_ratio || args.aspectRatio || "").trim() || null, model: currentModel || "", callId }); } continue; }
    if (event?.type !== "tool_result") continue;
    const callId = String(event.tool_call_id || "").trim(); if (!callId) continue;
    const pending = pendingCalls.get(callId); const result = parseJsonObject(event.content);
    if (typeof result.path !== "string" || !result.path.trim()) continue;
    const resolved = resolve(String(result.path)); let canonical: string;
    try { canonical = await realpath(resolved); } catch { continue; }
    if (!(await isCanonicalChildPath(sessionsRoot, canonical))) { warnings.push(`session ${sessionId}: rejected tool_result path`); continue; }
    const toolPrompt = pending?.prompt || ""; let prompt = toolPrompt; let promptStatus = toolPrompt ? "generation-tool-prompt" : "not-available";
    if (!toolPrompt && pending?.contextUserPrompt) { prompt = pending.contextUserPrompt; promptStatus = "session-user-prompt"; }
    const entry: GenerationMetadata = { sessionId, prompt, promptStatus, userMessage: pending?.userPrompt || null, sessionPath, sessionUpdatedAt: chatStat.mtime.toISOString(), callId, generatedAt: null, model: pending?.model || currentModel, toolName: pending?.toolName || null, aspectRatio: pending?.aspectRatio || null, matched: Boolean(pending) };
    const prior = mediaPrompts.get(canonical);
    if (prior && prior.promptStatus === "generation-tool-prompt" && entry.promptStatus !== "generation-tool-prompt") { /* keep stronger */ }
    else if (prior && prior.callId && prior.callId !== entry.callId && prior.prompt && entry.prompt && prior.prompt !== entry.prompt) { warnings.push(`session ${sessionId}: ambiguous tool matches for ${basename(canonical)}`); mediaPrompts.set(canonical, { sessionId, prompt: "", promptStatus: "not-available", userMessage: null, sessionPath, sessionUpdatedAt: null, callId: null, generatedAt: null, model: null, toolName: null, aspectRatio: null, matched: false }); }
    else { mediaPrompts.set(canonical, entry); }
    if (pending) pendingCalls.delete(callId);
  }
  if (parseFailures > 0) warnings.push(`session ${sessionId}: ignored ${parseFailures} malformed line(s)`);
  const metadata = { sessionId, sessionPath, mediaPrompts };
  sessionMetadataCache?.set(chatSafe.path!, { mtimeMs: chatStat.mtimeMs, size: chatStat.size, metadata, warnings: [...warnings] });
  return { metadata, warnings };
}

async function inspectSafeSessionFile(filePath: string, sessionsRoot: string, label: string, warnings: string[], sessionId: string): Promise<{ ok: boolean; path?: string; stat?: Stats; reason?: string }> {
  try { const ls = await lstat(filePath); if (ls.isSymbolicLink()) { warnings.push(`session ${sessionId}: rejected ${label} (symlink-rejected)`); return { ok: false, reason: "symlink-rejected" }; } if (!ls.isFile()) return { ok: false, reason: "not-a-file" }; } catch (error: unknown) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: false, reason: "missing" }; return { ok: false, reason: "stat-failed" }; }
  let canonical: string; try { canonical = await realpath(filePath); } catch { return { ok: false, reason: "not-ready" }; }
  if (!isSafeChildPath(sessionsRoot, canonical)) return { ok: false, reason: "out-of-root" };
  try { return { ok: true, path: canonical, stat: await stat(canonical) }; } catch { return { ok: false, reason: "stat-failed" }; }
}

async function assertSafeSessionFile(filePath: string, sessionsRoot: string): Promise<{ ok: boolean; path?: string; reason?: string }> {
  try {
    const linkStat = await lstat(filePath);
    if (linkStat.isSymbolicLink()) return { ok: false, reason: "symlink-rejected" };
    if (!linkStat.isFile()) return { ok: false, reason: "not-a-file" };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: false, reason: "missing" };
    return { ok: false, reason: "stat-failed" };
  }
  let canonical: string;
  try { canonical = await realpath(filePath); } catch { return { ok: false, reason: "not-ready" }; }
  if (!isSafeChildPath(sessionsRoot, canonical)) return { ok: false, reason: "out-of-root" };
  return { ok: true, path: canonical };
}

const UNSAFE_SESSION_FILE_REASONS = new Set<string>([
  "symlink-rejected",
  "out-of-root",
  "not-a-file",
  "stat-failed",
  "not-ready",
]);

function isUnsafeSessionFileReason(reason: string | undefined): boolean {
  return Boolean(reason) && UNSAFE_SESSION_FILE_REASONS.has(reason as string);
}

async function upgradeGenerationMetadata(store: Store, asset: Record<string, unknown>, generation: GenerationMetadata, candidate: MediaCandidate | null = null): Promise<boolean> {
  const currentRank = PROMPT_RANK[(asset.source as Record<string, unknown> | undefined)?.prompt_status as string] ?? 0;
  const nextRank = PROMPT_RANK[generation.promptStatus] ?? 0;
  const canUpgradePrompt = nextRank > currentRank
    || (nextRank === currentRank && nextRank > 0 && generation.prompt && generation.prompt !== (asset.prompt as string));
  const nextTheme = promptTheme(generation.prompt);
  // A prompt or theme a human typed through a marked entry point wins over
  // the session file; the theme is only recomputed alongside a prompt that is
  // actually being upgraded.
  const promptChanged = !isPromptUserEdited(asset) && canUpgradePrompt && Boolean(generation.prompt) && asset.prompt !== generation.prompt;
  // The provenance status describes the kept prompt, so an automatic channel
  // never rewrites it over a user edit either.
  const statusUpgradable = canUpgradePrompt && !isPromptUserEdited(asset);
  const themeChanged = !isThemeUserEdited(asset) && promptChanged && Boolean(nextTheme) && asset.theme !== nextTheme;
  const assetSource = (asset.source as Record<string, unknown> | undefined) || {};
  const existingUserMessage = [assetSource.user_message, (asset.business_fields as Record<string, unknown> | undefined)?.user_message]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find((value) => value) || "";
  const nextUserMessage = generation.userMessage || null;
  const userMessageChanged = !existingUserMessage && Boolean(nextUserMessage);
  const nextSource: Record<string, unknown> = {
    ...assetSource,
    grok_session_path: generation.sessionPath || assetSource.grok_session_path || null,
    grok_tool_call_id: generation.callId || assetSource.grok_tool_call_id || null,
    model: generation.model || assetSource.model || null,
    generation_tool: generation.toolName || assetSource.generation_tool || null,
    media_kind: candidate?.mediaKind || assetSource.media_kind || null,
  };
  if (statusUpgradable && generation.promptStatus) nextSource.prompt_status = generation.promptStatus;
  if (userMessageChanged) nextSource.user_message = nextUserMessage;
  if (candidate?.mediaPath && !assetSource.grok_media_path) nextSource.grok_media_path = candidate.mediaPath;
  else if (candidate?.mediaPath && assetSource.grok_media_path !== candidate.mediaPath) {
    nextSource.grok_alternate_paths = uniquePaths([
      ...((assetSource.grok_alternate_paths as string[]) || []),
      candidate.mediaPath,
    ].filter((p) => p !== assetSource.grok_media_path && p !== assetSource.path));
  }
  const sourceChanged = ["grok_session_path", "grok_tool_call_id", "model", "generation_tool", "prompt_status", "grok_media_path", "user_message"].some((key) => assetSource[key] !== nextSource[key])
    || JSON.stringify(assetSource.grok_alternate_paths || []) !== JSON.stringify(nextSource.grok_alternate_paths || []);
  const businessStatusChanged = statusUpgradable && generation.promptStatus && (asset.business_fields as Record<string, unknown> | undefined)?.prompt_status !== generation.promptStatus;
  if (!promptChanged && !themeChanged && !sourceChanged && !businessStatusChanged && !userMessageChanged) return false;
  await (store as unknown as { updateMetadata: (projectId: string, assetId: string, metadata: Record<string, unknown>) => Promise<void> }).updateMetadata(
    asset.project_id as string,
    asset.id as string,
    {
      ...(promptChanged ? { prompt: generation.prompt } : {}),
      ...(themeChanged ? { theme: nextTheme } : {}),
      business_fields: {
        ...((asset.business_fields as Record<string, unknown>) || {}),
        ...(businessStatusChanged ? { prompt_status: generation.promptStatus } : {}),
        ...(userMessageChanged ? { user_message: nextUserMessage } : {}),
      },
      source: nextSource,
    },
  );
  return true;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((p) => resolve(p)))];
}

function extractUserPromptText(event: Record<string, unknown>): string {
  if (event?.synthetic_reason) return "";
  const parts = Array.isArray(event?.content) ? (event.content as Array<Record<string, unknown>>) : []; const texts: string[] = [];
  for (const part of parts) { const text = String(part?.text || "").trim(); if (!text || part?.type !== "text") continue; const queryMatch = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i.exec(text); const body = (queryMatch?.[1] || text).trim(); if (isUserPrompt(body)) texts.push(body); }
  if (typeof event?.content === "string" && isUserPrompt((event.content as string).trim())) texts.push((event.content as string).trim());
  return texts.at(-1) || "";
}

function isUserPrompt(text: string): boolean { return Boolean(text) && text.length <= 12000 && !text.startsWith("<system-reminder>") && !text.startsWith("<action_safety>") && !text.startsWith("# "); }
function parseJsonObject(value: unknown): Record<string, unknown> { if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>; if (typeof value !== "string" || !value.trim()) return {}; try { const p = JSON.parse(value); return p && typeof p === "object" && !Array.isArray(p) ? p : {}; } catch { return {}; } }

async function readMediaInfo(mediaPath: string, fileStat: Stats, mediaKind: string): Promise<MediaInfo> {
  const ext = extname(mediaPath).toLowerCase(); const info: MediaInfo = { width: null, height: null, ratio: "", mimeType: mimeTypeForExtension(ext), bytes: fileStat.size, media_kind: mediaKind };
  if (mediaKind === "video") return info;
  try { const buffer = await readFile(mediaPath); if (ext === ".png" && buffer.length >= 24 && buffer.subarray(1, 4).toString("ascii") === "PNG") { info.width = buffer.readUInt32BE(16); info.height = buffer.readUInt32BE(20); } else if ((ext === ".jpg" || ext === ".jpeg") && buffer.length > 4) { const dims = jpegDimensions(buffer); if (dims) { info.width = dims.width; info.height = dims.height; } } else if (ext === ".gif" && buffer.length >= 10) { info.width = buffer.readUInt16LE(6); info.height = buffer.readUInt16LE(8); } info.ratio = ratioFromDimensions(info.width, info.height); } catch {}
  return info;
}

function jpegDimensions(buffer: Buffer): { width: number; height: number } | null { let offset = 2; while (offset + 9 < buffer.length) { if (buffer[offset] !== 0xff) break; const marker = buffer[offset + 1]; const size = buffer.readUInt16BE(offset + 2); if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }; offset += 2 + size; } return null; }
function ratioFromDimensions(w: number | null, h: number | null): string { if (!Number.isFinite(w) || !Number.isFinite(h) || w! <= 0 || h! <= 0) return ""; const d = gcd(w!, h!); return `${w! / d}:${h! / d}`; }
function gcd(l: number, r: number): number { let a = Math.abs(l); let b = Math.abs(r); while (b) [a, b] = [b, a % b]; return a || 1; }
function mimeTypeForExtension(ext: string): string { return ({ ".apng": "image/apng", ".avif": "image/avif", ".gif": "image/gif", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp", ".mp4": "video/mp4", ".m4v": "video/x-m4v", ".mov": "video/quicktime", ".webm": "video/webm" } as Record<string, string>)[ext] || "application/octet-stream"; }
async function walkFiles(root: string): Promise<string[]> { let entries; try { entries = await readdir(root, { withFileTypes: true }); } catch (error: unknown) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return []; throw error; } const files: string[] = []; for (const entry of entries) { if (entry.name.startsWith(".") || entry.name.endsWith(".lock")) continue; const entryPath = join(root, entry.name); if (entry.isSymbolicLink()) { if (!entry.isDirectory()) files.push(entryPath); continue; } if (entry.isDirectory()) files.push(...await walkFiles(entryPath)); else if (entry.isFile()) files.push(entryPath); } return files; }
export async function sha256File(filePath: string): Promise<string> { const hash = createHash("sha256"); await pipeline(createReadStream(filePath), hash); return hash.digest("hex"); }
function isSafeChildPath(parent: string, child: string): boolean { const p = relative(resolve(parent), resolve(child)); return Boolean(p) && !p.startsWith("..") && !p.includes(`..${sep}`) && !isAbsolute(p); }
function isAutomaticImportSuppressed(error: unknown): boolean { return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "AUTOMATIC_IMPORT_SUPPRESSED"); }
function isAutomaticIngestDuplicate(error: unknown): boolean { return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "AUTOMATIC_INGEST_DUPLICATE"); }
function automaticDuplicateReason(error: unknown): string { return (error as { identityKind?: unknown })?.identityKind === "pixel" ? "already-archived-same-pixels" : "already-archived-same-content"; }
async function createAutomaticAssetWithCollisionFallback(store: Store, input: Record<string, unknown>, options: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    return await store.createAsset(input, options);
  } catch (error) {
    if (!error || typeof error !== "object" || (error as { code?: unknown }).code !== "ASSET_ALREADY_EXISTS") throw error;
    const baseId = String(input.assetId || "grok-media").slice(0, 140);
    return store.createAsset({ ...input, assetId: `${baseId}-${randomUUID().slice(0, 8)}` }, options);
  }
}
async function isCanonicalChildPath(parentReal: string, childPath: string): Promise<boolean> { try { return isSafeChildPath(parentReal, await realpath(childPath)); } catch { return false; } }
export const __test = { isSafeChildPath, isCanonicalChildPath, sessionMediaLocation, buildGrokAssetId, sha256File, MEDIA_EXTENSIONS, VIDEO_EXTENSIONS, dirname, assertSafeSessionFile, upgradeGenerationMetadata };
