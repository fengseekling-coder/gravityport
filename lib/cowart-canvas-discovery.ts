import { createReadStream, watch, type FSWatcher } from "node:fs";
import { createInterface } from "node:readline";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveSourceLocations } from "./source-locations.js";

const DEFAULT_LOOKBACK_DAYS = 14;
interface Candidate { projectDir: string; canvasDir: string; sessionPath: string; lastSeenAt: string; }
interface DiscoveryResult { discovered: unknown[]; candidates: Candidate[]; queued: boolean; }
interface DiscoveryStatus { sessionsDir: string; enabled: boolean; watching: boolean; polling: boolean; lastScanAt: string | null; lastDiscoveredAt: string | null; lastDiscoveredCount: number; totalDiscovered: number; candidateCount: number; lastError: string | null; }
interface Discovery { start(): Promise<DiscoveryStatus>; stop(): void; reconcile(): Promise<DiscoveryResult>; scheduleReconcile(sessionPath?: string): void; status(): DiscoveryStatus; }

export function createCowartCanvasDiscovery(options: {
  onDiscover?: (input: { projectDir: string; discoveredBy: string; discoveredAt: string }) => Promise<unknown>;
  sessionsDir?: string; managerDir?: string; dedicatedCanvasDir?: string;
  knownProjectDirs?: () => string[]; debounceMs?: number; pollIntervalMs?: number; lookbackDays?: number;
} = {}): Discovery {
  if (typeof options.onDiscover !== "function") throw new Error("Cowart canvas discovery requires an onDiscover callback.");
  const { codexSessionsDir: sessionsDir } = resolveSourceLocations({
    overrides: { codexSessionsDir: options.sessionsDir },
  });
  const managerDir = options.managerDir ? resolve(options.managerDir) : null;
  const dedicatedCanvasDir = options.dedicatedCanvasDir ? resolve(options.dedicatedCanvasDir) : null;
  const knownProjectDirs = typeof options.knownProjectDirs === "function" ? options.knownProjectDirs : () => [];
  const debounceMs = options.debounceMs != null && Number.isFinite(options.debounceMs) ? Math.max(0, options.debounceMs) : 500;
  const pollIntervalMs = options.pollIntervalMs != null && Number.isFinite(options.pollIntervalMs) ? Math.max(500, options.pollIntervalMs) : 5000;
  const lookbackDays = options.lookbackDays != null && Number.isFinite(options.lookbackDays) ? Math.max(1, options.lookbackDays) : DEFAULT_LOOKBACK_DAYS;
  const cache = new Map<string, { mtimeMs: number; size: number; projectDirs: string[] }>();
  const dirtySessionPaths = new Set<string>();
  let watcher: FSWatcher | null = null; let poller: ReturnType<typeof setInterval> | null = null; let timer: ReturnType<typeof setTimeout> | null = null;
  let reconciling = false; let reconcileAgain = false; let initialScan = true;
  const state: Omit<DiscoveryStatus, "watching" | "polling"> = { sessionsDir, enabled: false, lastScanAt: null, lastDiscoveredAt: null, lastDiscoveredCount: 0, totalDiscovered: 0, candidateCount: 0, lastError: null };

  async function reconcile(): Promise<DiscoveryResult> {
    if (reconciling) { reconcileAgain = true; return { discovered: [], candidates: [], queued: true }; }
    reconciling = true;
    try {
      const candidates = await discoverCowartProjectsFromCodexSessions({ sessionsDir, lookbackDays, cache, dirtySessionPaths, fullScan: initialScan });
      initialScan = false; dirtySessionPaths.clear(); state.candidateCount = candidates.length;
      const known = new Set(knownProjectDirs().filter(Boolean).map((v) => resolve(v)));
      const discovered: unknown[] = []; let discoveryError: string | null = null;
      for (const candidate of candidates) {
        if (known.has(candidate.projectDir)) continue;
        if (managerDir && candidate.projectDir === managerDir) continue;
        if (dedicatedCanvasDir && candidate.canvasDir === dedicatedCanvasDir) continue;
        try { const result = await options.onDiscover!({ projectDir: candidate.projectDir, discoveredBy: "codex-cowart-launch", discoveredAt: candidate.lastSeenAt }); known.add(candidate.projectDir); discovered.push((result as Record<string, unknown>)?.canvas || (result as Record<string, unknown>)?.project || candidate); } catch (error) { discoveryError = error instanceof Error ? error.message : String(error); }
      }
      state.lastScanAt = new Date().toISOString(); state.lastDiscoveredCount = discovered.length; state.totalDiscovered += discovered.length;
      if (discovered.length > 0) state.lastDiscoveredAt = state.lastScanAt; state.lastError = discoveryError;
      return { discovered, candidates, queued: false };
    } catch (error) { state.lastScanAt = new Date().toISOString(); state.lastError = error instanceof Error ? error.message : String(error); throw error; } finally { reconciling = false; if (reconcileAgain) { reconcileAgain = false; scheduleReconcile(); } }
  }

  function scheduleReconcile(sessionPath?: string): void {
    if (sessionPath) dirtySessionPaths.add(resolve(sessionsDir, sessionPath));
    if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; reconcile().catch(() => {}); }, debounceMs);
  }

  async function start(): Promise<DiscoveryStatus> {
    await reconcile();
    try { watcher = watch(sessionsDir, { recursive: true }, (_event, fileName) => { const changedPath = fileName == null ? "" : String(fileName); scheduleReconcile(changedPath.endsWith(".jsonl") ? changedPath : undefined); }); watcher.on("error", () => { watcher?.close(); watcher = null; }); } catch { watcher = null; }
    poller = setInterval(() => reconcile().catch(() => {}), pollIntervalMs); state.enabled = true; return status();
  }
  function stop(): void { if (timer) clearTimeout(timer); timer = null; if (poller) clearInterval(poller); poller = null; watcher?.close(); watcher = null; state.enabled = false; }
  function status(): DiscoveryStatus { return { ...state, watching: Boolean(watcher), polling: Boolean(poller) }; }
  return { start, stop, reconcile, scheduleReconcile, status };
}

export async function discoverCowartProjectsFromCodexSessions(options: {
  sessionsDir?: string; lookbackDays?: number; cache?: Map<string, { mtimeMs: number; size: number; projectDirs: string[] }>;
  dirtySessionPaths?: Set<string> | string[]; fullScan?: boolean;
} = {}): Promise<Candidate[]> {
  const { codexSessionsDir: sessionsDir } = resolveSourceLocations({
    overrides: { codexSessionsDir: options.sessionsDir },
  });
  const lookbackDays = options.lookbackDays != null && Number.isFinite(options.lookbackDays) ? Math.max(1, options.lookbackDays) : DEFAULT_LOOKBACK_DAYS;
  const cache = options.cache instanceof Map ? options.cache : new Map();
  const dirtyPaths = new Set([...(options.dirtySessionPaths || [])].map((v) => resolve(v)));
  const sessionPaths = new Set(await recentSessionPaths(sessionsDir, lookbackDays, options.fullScan === true));
  for (const filePath of options.dirtySessionPaths || []) { if (isSafeChildPath(sessionsDir, filePath) && String(filePath).endsWith(".jsonl")) sessionPaths.add(resolve(filePath)); }
  const candidatesByProject = new Map<string, Candidate>();
  for (const sessionPath of sessionPaths) {
    let details; try { details = await stat(sessionPath); } catch { continue; }
    if (!details.isFile()) continue;
    const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
    if (options.fullScan === true && details.mtimeMs < cutoff && !dirtyPaths.has(sessionPath)) continue;
    const cached = cache.get(sessionPath);
    let projectDirs: string[];
    if (cached?.mtimeMs === details.mtimeMs && cached?.size === details.size) { projectDirs = cached.projectDirs; } else {
      // Task 436 C: a session file that cannot be read (mid-write, missing
      // permissions) skips only itself — no cache entry, so the next round
      // retries it while the rest of this round carries on.
      try { projectDirs = await projectDirsFromSession(sessionPath); } catch { continue; }
      cache.set(sessionPath, { mtimeMs: details.mtimeMs, size: details.size, projectDirs });
    }
    for (const requestedProjectDir of projectDirs) {
      const candidate = await cowartProjectCandidate(requestedProjectDir, sessionPath, details.mtime);
      if (!candidate) continue;
      const previous = candidatesByProject.get(candidate.projectDir);
      if (!previous || previous.lastSeenAt < candidate.lastSeenAt) candidatesByProject.set(candidate.projectDir, candidate);
    }
  }
  return [...candidatesByProject.values()].sort((l, r) => l.lastSeenAt.localeCompare(r.lastSeenAt));
}

async function projectDirsFromSession(sessionPath: string): Promise<string[]> {
  const contextDirs = new Set<string>(); const explicitDirs = new Set<string>(); let openedDefaultCanvas = false;
  // Task 436 C: stream the session line by line instead of loading the whole
  // file into memory; the per-line judgment below is unchanged.
  const reader = createInterface({ input: createReadStream(sessionPath, "utf8"), crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line.trim()) continue; let event: Record<string, unknown>; try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === "turn_context" && isAbsoluteString((event.payload as Record<string, unknown>)?.cwd)) { contextDirs.add(resolve((event.payload as Record<string, unknown>).cwd as string)); continue; }
    if (event?.type !== "response_item") continue;
    const call = cowartLaunchCall(event.payload as Record<string, unknown>);
    if (!call.opened) continue; openedDefaultCanvas = true;
    for (const projectDir of call.projectDirs) explicitDirs.add(resolve(projectDir));
  }
  if (!openedDefaultCanvas) return [];
  return explicitDirs.size > 0 ? [...explicitDirs] : [...contextDirs];
}

function cowartLaunchCall(payload: Record<string, unknown> = {}): { opened: boolean; projectDirs: string[] } {
  const name = String(payload.name || payload.tool_name || "");
  const rawArguments = payload.arguments ?? payload.input ?? payload.params ?? "";
  const parsedArguments = parseArguments(rawArguments);
  if (name.includes("render_cowart_canvas_widget")) return { opened: true, projectDirs: projectDirsFromArguments(parsedArguments) };
  if (payload.type !== "custom_tool_call" && payload.type !== "function_call") return { opened: false, projectDirs: [] };
  const source = typeof rawArguments === "string" ? rawArguments : JSON.stringify(rawArguments);
  const invokesNativeWidget = /tools\.[A-Za-z0-9_$]*render_cowart_canvas_widget\s*\(/.test(source);
  const invokesLocalCanvas = /\bcmd\s*:\s*["'](?:\.\/|\/[^"']*\/)?scripts\/start-canvas\.sh(?:\s|["'])/.test(source) || /^\s*(?:\.\/|\/\S*\/)?scripts\/start-canvas\.sh(?:\s|$)/.test(String(parsedArguments?.cmd || ""));
  if (!invokesNativeWidget && !invokesLocalCanvas) return { opened: false, projectDirs: [] };
  const projectDirs = invokesLocalCanvas ? projectDirsFromExecArguments(parsedArguments, source) : projectDirsFromArguments(parsedArguments);
  if (projectDirs.length === 0 && invokesNativeWidget) { const match = /\bprojectDir\s*:\s*["']([^"']+)["']/.exec(source); const captured = match?.[1]; if (typeof captured === "string" && isAbsoluteString(captured)) projectDirs.push(captured); }
  return { opened: true, projectDirs };
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return {};
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}

function projectDirsFromArguments(args: Record<string, unknown>): string[] { return isAbsoluteString(args?.projectDir) ? [args.projectDir as string] : []; }

function projectDirsFromExecArguments(args: Record<string, unknown>, source: string): string[] {
  const candidate = pickFirstAbsoluteString(args?.projectDir) ?? pickFirstAbsoluteString(args?.workdir) ?? pickFirstAbsoluteString(args?.cwd);
  if (candidate) return [candidate];
  const fromRegex = matchAbsoluteString(/\bprojectDir\s*:\s*["']([^"']+)["']/i, source) ?? matchAbsoluteString(/\bworkdir\s*:\s*["']([^"']+)["']/i, source) ?? matchAbsoluteString(/\bcwd\s*:\s*["']([^"']+)["']/i, source);
  return fromRegex ? [fromRegex] : [];
}

function pickFirstAbsoluteString(value: unknown): string | null { return isAbsoluteString(value) ? (value as string).trim() : null; }
function matchAbsoluteString(regex: RegExp, source: string): string | null { const match = regex.exec(source); const captured = match?.[1]; return typeof captured === "string" && isAbsoluteString(captured) ? captured : null; }

async function cowartProjectCandidate(requestedProjectDir: string, sessionPath: string, lastSeen: Date): Promise<Candidate | null> {
  if (!isAbsoluteString(requestedProjectDir)) return null;
  let projectDir: string; try { projectDir = await realpath(requestedProjectDir); } catch { return null; }
  const canvasDir = join(projectDir, "canvas");
  if (!(await hasCowartCanvasMarker(canvasDir))) return null;
  return { projectDir, canvasDir, sessionPath, lastSeenAt: lastSeen.toISOString() };
}

export async function hasCowartCanvasMarker(canvasDir: string): Promise<boolean> {
  for (const marker of ["cowart-view-state.json", "cowart-selection.json", join("pages", "manifest.json")]) {
    try { if ((await stat(join(canvasDir, marker))).isFile()) return true; } catch { /* continue */ }
  }
  return false;
}

export type TrustedExternalCanvasInspection =
  | { trusted: true; projectDir: string; canvasDir: string }
  | { trusted: false; reason: string; message: string };

/**
 * The single trust bar the API route, the registry, and the bridge manager all
 * apply before an external Cowart project may be registered, started, or handed
 * to the Cowart MCP server: `canvas` must be a real, non-symlink direct child
 * of the project directory holding a Cowart marker. `lstat` rejects a symlinked
 * canvas (a symlink into an outside directory would let MCP writes escape the
 * project), and the strict realpath equality check — never a string-prefix
 * match — proves the real canvas path is exactly join(realProjectDir, "canvas").
 */
export async function inspectTrustedExternalCanvas(requestedProjectDir: string): Promise<TrustedExternalCanvasInspection> {
  let projectDir: string;
  try { projectDir = await realpath(requestedProjectDir); } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return untrustedExternalCanvas("project-missing", "Cowart project directory does not exist.");
    throw error;
  }
  if (!(await statIsDirectory(projectDir))) return untrustedExternalCanvas("project-not-directory", "Cowart project path must point to a directory.");
  const canvasDir = join(projectDir, "canvas");
  let canvasDetails;
  try { canvasDetails = await lstat(canvasDir); } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return untrustedExternalCanvas("canvas-missing", "Cowart canvas directory does not exist.");
    throw error;
  }
  if (canvasDetails.isSymbolicLink()) return untrustedExternalCanvas("canvas-symlink", "Cowart canvas directory must not be a symbolic link.");
  if (!canvasDetails.isDirectory()) return untrustedExternalCanvas("canvas-not-directory", "Cowart canvas path must be a directory.");
  const realCanvasDir = await realpath(canvasDir);
  if (realCanvasDir !== canvasDir) return untrustedExternalCanvas("canvas-outside-project", "Cowart canvas directory must stay inside the project directory.");
  if (!(await hasCowartCanvasMarker(canvasDir))) return untrustedExternalCanvas("canvas-no-markers", "Cowart canvas directory does not contain any Cowart marker files (cowart-view-state.json, cowart-selection.json, or pages/manifest.json).");
  return { trusted: true, projectDir, canvasDir: realCanvasDir };
}

function untrustedExternalCanvas(reason: string, message: string): TrustedExternalCanvasInspection { return { trusted: false, reason, message }; }
async function statIsDirectory(path: string): Promise<boolean> { try { return (await stat(path)).isDirectory(); } catch { return false; } }

async function recentSessionPaths(sessionsDir: string, lookbackDays: number, fullScan: boolean): Promise<string[]> {
  if (fullScan) return walkJsonlFiles(sessionsDir);
  const directories = new Set([sessionsDir]);
  for (let offset = 0; offset < lookbackDays; offset += 1) {
    const date = new Date(Date.now() - offset * 24 * 60 * 60 * 1000);
    directories.add(join(sessionsDir, datePart(date.getFullYear()), datePart(date.getMonth() + 1), datePart(date.getDate())));
    directories.add(join(sessionsDir, datePart(date.getUTCFullYear()), datePart(date.getUTCMonth() + 1), datePart(date.getUTCDate())));
  }
  const files: string[] = [];
  for (const directory of directories) { let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; } for (const entry of entries) { if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(directory, entry.name)); } }
  return files;
}

async function walkJsonlFiles(root: string): Promise<string[]> {
  let entries; try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const files: string[] = [];
  for (const entry of entries) { const entryPath = join(root, entry.name); if (entry.isDirectory()) files.push(...await walkJsonlFiles(entryPath)); else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(entryPath); }
  return files;
}

function isSafeChildPath(parent: string, child: string): boolean { const rel = relative(resolve(parent), resolve(child)); return Boolean(rel) && !rel.startsWith("..") && !rel.includes(`..${sep}`) && !isAbsolute(rel); }
function isAbsoluteString(value: unknown): boolean { return typeof value === "string" && Boolean(value.trim()) && isAbsolute(value.trim()); }
function datePart(value: number): string { return String(value).padStart(2, "0"); }
