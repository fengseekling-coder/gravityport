import { isAbsolute, resolve } from "node:path";
import { inspectTrustedExternalCanvas } from "./cowart-canvas-discovery.js";
import { createCowartAssetBridge } from "./cowart-bridge.js";

interface ManagerStore { createAsset?: (...args: unknown[]) => unknown; listAssets?: (...args: unknown[]) => unknown; managerDir: string; cowartCanvasDir: string; [key: string]: unknown; }
interface RegistryEntry { id: string; projectDir: string; canvasDir: string; managed?: boolean; addedAt: string | null; }
interface Registry { list(): Promise<RegistryEntry[]>; addProject(input: { projectDir?: string }): Promise<{ project: RegistryEntry; created: boolean }>; removeProject(id: string): Promise<RegistryEntry>; }
interface BridgeStatus { enabled?: boolean; watching?: boolean; polling?: boolean; lastScanAt?: string | null; lastImportedAt?: string | null; lastImportCount?: number; totalImported?: number; lastSkippedCount?: number; lastError?: string | null; }
interface SourceStatus { id: string; projectDir: string; canvasDir: string; managed: boolean; addedAt: string | null; trusted: boolean; enabled: boolean; watching: boolean; polling: boolean; lastScanAt: string | null; lastImportedAt: string | null; lastImportCount: number; totalImported: number; lastSkippedCount: number; lastError: string | null; }
interface ManagerStatus { canvasDir: string; enabled: boolean; watching: boolean; polling: boolean; lastScanAt: string | null; lastImportedAt: string | null; lastImportCount: number; totalImported: number; lastSkippedCount: number; lastError: string | null; monitoredCount: number; registeredCount: number; sources: SourceStatus[]; }
interface Bridge { start(): Promise<void>; stop(): Promise<void>; status(): BridgeStatus; }

export interface CowartBridgeManager { start(): Promise<ManagerStatus>; stop(): Promise<void>; addProject(input?: { projectDir?: string }): Promise<{ project: RegistryEntry; created: boolean; canvas: SourceStatus }>; removeProject(id: string): Promise<RegistryEntry>; sources(): SourceStatus[]; status(): ManagerStatus; }

export function createCowartBridgeManager(options: { store?: ManagerStore; registry?: Registry; managerDir?: string; canvasDir?: string } = {}): CowartBridgeManager {
  const store: ManagerStore | undefined = options.store;
  const registry: Registry | undefined = options.registry;
  if (!store || typeof store.createAsset !== "function") throw new Error("Cowart bridge manager requires a GravityPort store.");
  if (!registry || typeof registry.list !== "function") throw new Error("Cowart bridge manager requires a project registry.");
  const primarySource: RegistryEntry = { id: "mosa", projectDir: resolve(options.managerDir || store.managerDir), canvasDir: resolve(options.canvasDir || store.cowartCanvasDir), managed: true, addedAt: null };
  const bridges = new Map<string, Bridge>();
  const sourceErrors = new Map<string, string>();
  // Entries that failed the external-canvas trust check stay listed (removable)
  // but must never start a bridge or be handed to the Cowart MCP server.
  const untrustedSources = new Set<string>();
  let registeredSources: RegistryEntry[] = [];
  let started = false;

  async function start(): Promise<ManagerStatus> {
    registeredSources = await registry!.list();
    await startSource(primarySource, { allowMissingProject: true });
    for (const source of registeredSources) await startSource(source);
    started = true;
    return status();
  }

  async function addProject(input: { projectDir?: string } = {}): Promise<{ project: RegistryEntry; created: boolean; canvas: SourceStatus }> {
    const result = await registry!.addProject(input);
    if (!registeredSources.some((s) => s.id === result.project.id)) registeredSources.push(result.project);
    if (started) await startSource(result.project);
    return { ...result, canvas: sourceStatus(result.project) };
  }

  async function removeProject(id: string): Promise<RegistryEntry> {
    const project = await registry!.removeProject(id);
    const bridge = bridges.get(project.id);
    await bridge?.stop();
    bridges.delete(project.id);
    untrustedSources.delete(project.id);
    sourceErrors.delete(project.id);
    registeredSources = registeredSources.filter((s) => s.id !== project.id);
    return project;
  }

  async function startSource(source: RegistryEntry, options: { allowMissingProject?: boolean } = {}): Promise<SourceStatus> {
    if (bridges.has(source.id)) return sourceStatus(source);
    if (!options.allowMissingProject) {
      // External sources must prove they are real Cowart projects before a bridge
      // may watch them or create the canvas directory on their behalf. Untrusted
      // legacy entries stay listed (and removable) but are never started.
      const trustError = await externalSourceTrustError(source);
      if (trustError) { untrustedSources.add(source.id); sourceErrors.set(source.id, trustError); return sourceStatus(source); }
    }
    const bridge = createCowartAssetBridge({ store: store as never, canvasDir: source.canvasDir, projectId: "default", cowartProjectDir: source.projectDir, sourceId: source.id }) as unknown as Bridge;
    bridges.set(source.id, bridge);
    try { await bridge.start(); untrustedSources.delete(source.id); sourceErrors.delete(source.id); } catch (error) { await bridge.stop(); bridges.delete(source.id); sourceErrors.set(source.id, error instanceof Error ? error.message : String(error)); }
    return sourceStatus(source);
  }

  function sources(): SourceStatus[] { return [primarySource, ...registeredSources].map(sourceStatus); }

  function sourceStatus(source: RegistryEntry): SourceStatus {
    const bs = bridges.get(source.id)?.status() || {};
    return { id: source.id, projectDir: source.projectDir, canvasDir: source.canvasDir, managed: Boolean(source.managed), addedAt: source.addedAt || null, trusted: !untrustedSources.has(source.id), enabled: Boolean(bs.enabled), watching: Boolean(bs.watching), polling: Boolean(bs.polling), lastScanAt: bs.lastScanAt || null, lastImportedAt: bs.lastImportedAt || null, lastImportCount: Number(bs.lastImportCount || 0), totalImported: Number(bs.totalImported || 0), lastSkippedCount: Number(bs.lastSkippedCount || 0), lastError: sourceErrors.get(source.id) || bs.lastError || null };
  }

  function status(): ManagerStatus {
    const entries = sources();
    return { canvasDir: primarySource.canvasDir, enabled: entries.some((e) => e.enabled), watching: entries.some((e) => e.watching), polling: entries.some((e) => e.polling), lastScanAt: newest(entries, "lastScanAt"), lastImportedAt: newest(entries, "lastImportedAt"), lastImportCount: entries.reduce((t, e) => t + e.lastImportCount, 0), totalImported: entries.reduce((t, e) => t + e.totalImported, 0), lastSkippedCount: entries.reduce((t, e) => t + e.lastSkippedCount, 0), lastError: entries.find((e) => e.lastError)?.lastError || null, monitoredCount: entries.filter((e) => e.enabled).length, registeredCount: registeredSources.length, sources: entries };
  }

  async function stop(): Promise<void> { const activeBridges = [...bridges.values()]; bridges.clear(); started = false; await Promise.all(activeBridges.map((bridge) => bridge.stop())); }
  return { start, stop, addProject, removeProject, sources, status };
}

async function externalSourceTrustError(source: RegistryEntry): Promise<string | null> {
  const projectDir = String(source.projectDir || "");
  if (!isAbsolute(projectDir) || projectDir.split(/[\\/]/).includes("..")) return `Cowart project path is not trusted: ${source.projectDir}`;
  // Shared with the API route and the registry: lstat rejects a symlinked
  // canvas and the strict realpath equality check keeps the canvas inside the
  // project, so an untrusted legacy entry can never redirect MCP writes.
  const inspection = await inspectTrustedExternalCanvas(projectDir);
  return inspection.trusted ? null : inspection.message;
}
function newest(entries: SourceStatus[], key: keyof SourceStatus): string | null { return entries.map((e) => e[key]).filter(Boolean).sort().at(-1) as string | null || null; }
