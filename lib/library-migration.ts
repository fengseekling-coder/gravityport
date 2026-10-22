import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

/**
 * sqlite-asset-store.mjs is intentionally kept as .mjs for gradual TypeScript migration.
 * Type declarations are available in sqlite-asset-store.d.ts.
 * The @ts-ignore is necessary because TypeScript cannot resolve .d.ts for .mjs imports.
 */
// @ts-ignore - .mjs module with separate .d.ts declaration
import { createSqliteAssetStore } from "./sqlite-asset-store.mjs";

interface LegacyMetadata { id: string; asset: string; parent_asset_id?: string; parentAssetId?: string; source?: Record<string, unknown>; [key: string]: unknown; }
interface LegacyRecord { projectId: string; metadataPath: string; imagePath: string; metadata: LegacyMetadata; }
interface MigrationIssue { kind: string; path: string; detail: string; }
interface InspectionResult { legacyAssetsRoot: string; records: LegacyRecord[]; groups: Array<{ projectId: string; name: string }>; issues: MigrationIssue[]; }
interface MigrationReport { legacyAssetsRoot: string; discovered: number; discoveredGroups: number; imported: number; importedGroups: number; skipped: number; skippedGroups: number; verified: number; issues: MigrationIssue[]; backupPath: string | null; completed: boolean; error?: string; }

export async function inspectLegacyLibrary(options: { managerDir?: string; legacyAssetsRoot?: string } = {}): Promise<InspectionResult> {
  const managerDir = resolve(options.managerDir || process.cwd());
  const legacyAssetsRoot = resolve(options.legacyAssetsRoot || join(managerDir, "assets"));
  const records: LegacyRecord[] = []; const groups: Array<{ projectId: string; name: string }> = []; const issues: MigrationIssue[] = [];
  let projectEntries; try { projectEntries = await readdir(legacyAssetsRoot, { withFileTypes: true }); } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { legacyAssetsRoot, records, groups, issues: [{ kind: "legacy-assets-missing", path: legacyAssetsRoot, detail: "Legacy assets directory does not exist." }] }; throw error;
  }
  for (const entry of projectEntries.filter((i) => i.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const projectId = entry.name; const groupsPath = join(legacyAssetsRoot, projectId, "groups.json");
    try { const parsedGroups = JSON.parse(await readFile(groupsPath, "utf8")); if (!Array.isArray(parsedGroups)) { issues.push({ kind: "invalid-groups", path: groupsPath, detail: "groups.json must contain an array." }); } else {
      // groups.json entries are either legacy strings or { name, color, position } records.
      const names = new Map<string, string>(); for (const v of parsedGroups) { const name = normalizeGroupName(typeof v === "object" && v !== null ? (v as { name?: unknown }).name : v); if (name && !names.has(name.toLocaleLowerCase())) names.set(name.toLocaleLowerCase(), name); }
      for (const name of names.values()) groups.push({ projectId, name });
    } } catch (error: unknown) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") issues.push({ kind: "corrupt-groups-json", path: groupsPath, detail: error instanceof Error ? error.message : String(error) }); }
    const metadataDir = join(legacyAssetsRoot, projectId, "metadata"); const imagesDir = join(legacyAssetsRoot, projectId, "images");
    let metadataEntries; try { metadataEntries = await readdir(metadataDir, { withFileTypes: true }); } catch (error: unknown) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue; throw error; }
    for (const me of metadataEntries.filter((i) => i.isFile() && i.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name))) {
      const metadataPath = join(metadataDir, me.name); let metadata: LegacyMetadata;
      try { metadata = JSON.parse(await readFile(metadataPath, "utf8")); } catch (error) { issues.push({ kind: "corrupt-json", path: metadataPath, detail: error instanceof Error ? error.message : String(error) }); continue; }
      if (!metadata?.id || !metadata?.asset) { issues.push({ kind: "invalid-metadata", path: metadataPath, detail: "Metadata requires id and asset." }); continue; }
      const imagePath = join(imagesDir, metadata.asset); try { const s = await stat(imagePath); if (!s.isFile()) throw new Error("not a file"); } catch (error) { issues.push({ kind: "missing-image", path: imagePath, detail: `${metadataPath}: ${error instanceof Error ? error.message : String(error)}` }); continue; }
      records.push({ projectId, metadataPath, imagePath, metadata });
    }
  }
  return { legacyAssetsRoot, records: orderLegacyVersionRecords(records, issues), groups, issues };
}

export async function migrateLegacyLibrary(options: { managerDir?: string; legacyAssetsRoot?: string; libraryDir?: string; projectRoot?: string; dryRun?: boolean } = {}): Promise<MigrationReport> {
  const inspection = await inspectLegacyLibrary(options);
  const report: MigrationReport = { legacyAssetsRoot: inspection.legacyAssetsRoot, discovered: inspection.records.length, discoveredGroups: inspection.groups.length, imported: 0, importedGroups: 0, skipped: 0, skippedGroups: 0, verified: 0, issues: inspection.issues, backupPath: null, completed: false };
  if (options.dryRun || inspection.issues.length) return report;
  const libraryDir = resolve(options.libraryDir!); const managerDir = resolve(options.managerDir || process.cwd()); const projectRoot = resolve(options.projectRoot || dirname(managerDir));
  const store = createSqliteAssetStore({ projectRoot, managerDir, libraryDir, legacyAssetsRoot: inspection.legacyAssetsRoot, storage: "sqlite" }) as unknown as { clearMigrationIssues(): Promise<void>; setMigrationState(s: string, d: Record<string, unknown>): Promise<void>; listGroups(p: string): Promise<{ groups: Array<{ name: string }> }>; createGroup(p: { projectId: string; name: string }): Promise<void>; getAsset(p: string, id: string): Promise<{ id: string; image_path: string } | null>; createAsset(p: Record<string, unknown>, o?: Record<string, unknown>): Promise<{ id: string; image_path: string }>; recordMigrationIssue(i: MigrationIssue): Promise<void>; verifyLibrary(): Promise<Record<string, unknown>>; migrationStatus(): Promise<unknown>; listMigrationIssues(): Promise<MigrationIssue[]>; close(): void; };
  await store.clearMigrationIssues(); await store.setMigrationState("migrating", { legacyAssetsRoot: inspection.legacyAssetsRoot, discovered: inspection.records.length });
  try {
    report.backupPath = await backupLegacyJson({ libraryDir, legacyAssetsRoot: inspection.legacyAssetsRoot });
    const knownGroups = new Map<string, Set<string>>();
    for (const group of inspection.groups) {
      if (!knownGroups.has(group.projectId)) { const stats = await store.listGroups(group.projectId); knownGroups.set(group.projectId, new Set(stats.groups.map((group) => group.name.toLocaleLowerCase()))); }
      const names = knownGroups.get(group.projectId)!; if (names.has(group.name.toLocaleLowerCase())) { report.skippedGroups += 1; continue; }
      await store.createGroup({ projectId: group.projectId, name: group.name }); names.add(group.name.toLocaleLowerCase()); report.importedGroups += 1;
    }
    for (const record of inspection.records) {
      let existing: { id: string; image_path: string } | null = null; try { existing = await store.getAsset(record.projectId, record.metadata.id); } catch { existing = null; }
      if (existing) { const [sourceHash, storedHash] = await Promise.all([hashFile(record.imagePath), hashFile(existing.image_path)]); if (sourceHash !== storedHash) { report.issues.push({ kind: "resume-hash-mismatch", path: record.metadataPath, detail: `Existing SQLite asset ${record.metadata.id} differs from legacy image.` }); continue; } report.skipped += 1; report.verified += 1; continue; }
      const asset = await store.createAsset({ ...record.metadata, projectId: record.projectId, assetId: record.metadata.id, imagePath: record.imagePath, sourceType: record.metadata.source?.type, source: record.metadata.source }, { allowMissingVersionChange: true });
      const [sourceHash, storedHash] = await Promise.all([hashFile(record.imagePath), hashFile(asset.image_path)]);
      if (sourceHash !== storedHash) { report.issues.push({ kind: "post-import-hash-mismatch", path: record.metadataPath, detail: `Imported SQLite asset ${asset.id} does not match legacy original.` }); continue; }
      report.imported += 1; report.verified += 1;
    }
    if (report.issues.length) { await store.setMigrationState("failed", report as unknown as Record<string, unknown>); return report; }
    report.completed = true;
    await store.setMigrationState("completed", report as unknown as Record<string, unknown>);
    // The backup directory is created before import starts, so only this marker
    // is filesystem-level proof that migration actually reached completion.
    await writeFile(join(libraryDir, ".sqlite-migration-completed"), "completed\n", "utf8");
    return report;
  } catch (error) { await store.setMigrationState("failed", { ...report, error: error instanceof Error ? error.message : String(error) }); throw error; } finally { store.close(); }
}

export async function verifySqliteLibrary(options: { projectRoot?: string; managerDir?: string; libraryDir?: string } = {}): Promise<Record<string, unknown>> {
  const libraryDir = resolve(options.libraryDir!);
  const presence = await sqliteLibraryPresence(libraryDir);
  if (presence !== "present") {
    // Keep the report contract (callers parse JSON) without materializing a
    // fresh mosa.db: an addressable-but-empty location verifies as unmigrated.
    return {
      ok: false,
      assets: 0,
      error: describeMissingSqliteLibrary(libraryDir, presence),
      migration: { migration_state: "unmigrated" },
      migrationIssues: [],
    };
  }
  const store = createSqliteAssetStore({ projectRoot: resolve(options.projectRoot || process.cwd()), managerDir: resolve(options.managerDir || process.cwd()), libraryDir, storage: "sqlite" }) as unknown as { verifyLibrary(): Promise<Record<string, unknown>>; migrationStatus(): Promise<unknown>; listMigrationIssues(): Promise<MigrationIssue[]>; close(): void; };
  try { const [verification, status, issues] = await Promise.all([store.verifyLibrary(), store.migrationStatus(), store.listMigrationIssues()]); return { ...verification, migration: status, migrationIssues: issues }; } finally { store.close(); }
}

/**
 * Refuse to open a directory that holds no SQLite library yet, so read-only
 * commands (backup source / thumbnails) cannot materialize a fresh unmigrated
 * `mosa.db` as a side effect of merely pointing at a missing or empty
 * directory. A legacy JSON library earns a pointed hint to migrate first;
 * anything else is simply not a MOSA library.
 */
export async function assertExistingSqliteLibrary(libraryDir: string): Promise<void> {
  const root = resolve(libraryDir);
  const presence = await sqliteLibraryPresence(root);
  if (presence === "present") return;
  throw new Error(describeMissingSqliteLibrary(root, presence));
}

function describeMissingSqliteLibrary(root: string, presence: "present" | "legacy" | "absent"): string {
  if (presence === "legacy") {
    return `"${root}" holds a legacy JSON library; run \`gravityport migrate\` before running this command against it.`;
  }
  return `"${root}" is not a GravityPort SQLite library (no mosa.db); nothing was created or modified.`;
}

async function sqliteLibraryPresence(root: string): Promise<"present" | "legacy" | "absent"> {
  const databaseInfo = await stat(join(root, "mosa.db")).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  });
  if (databaseInfo?.isFile()) return "present";
  return (await looksLikeLegacyJsonLibrary(root)) ? "legacy" : "absent";
}

async function looksLikeLegacyJsonLibrary(root: string): Promise<boolean> {
  let projects;
  try { projects = await readdir(join(root, "assets"), { withFileTypes: true }); } catch { return false; }
  const hasEntry = async (path: string, want: "file" | "directory"): Promise<boolean> => {
    try {
      const info = await stat(path);
      return want === "file" ? info.isFile() : info.isDirectory();
    } catch { return false; }
  };
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = join(root, "assets", project.name);
    for (const marker of ["metadata", "images", "prompts"]) {
      if (await hasEntry(join(projectDir, marker), "directory")) return true;
    }
    if (await hasEntry(join(projectDir, "groups.json"), "file")) return true;
  }
  return false;
}

async function backupLegacyJson({ libraryDir, legacyAssetsRoot }: { libraryDir: string; legacyAssetsRoot: string }): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-"); const backupPath = join(libraryDir, "legacy-json-backup", timestamp);
  const projects = await readdir(legacyAssetsRoot, { withFileTypes: true });
  for (const project of projects.filter((e) => e.isDirectory())) { const source = join(legacyAssetsRoot, project.name); const destination = join(backupPath, project.name); await mkdir(destination, { recursive: true }); for (const name of ["metadata", "prompts", "groups.json"]) { try { await cp(join(source, name), join(destination, name), { recursive: true, errorOnExist: false }); } catch (error: unknown) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error; } } }
  return backupPath;
}

function orderLegacyVersionRecords(records: LegacyRecord[], issues: MigrationIssue[]): LegacyRecord[] {
  const byProject = new Map<string, Map<string, LegacyRecord>>(); const projectsByAssetId = new Map<string, Set<string>>(); const duplicateKeys = new Set<string>();
  for (const record of records) {
    const projectId = normalizeLegacyId(record.projectId, "default");
    const assetId = normalizeLegacyId(record.metadata.id, "asset");
    const key = [projectId, assetId].join("\u0000");
    const projectRecords = byProject.get(projectId) || new Map<string, LegacyRecord>();
    const existing = projectRecords.get(assetId);
    if (existing) {
      if (!duplicateKeys.has(key)) {
        duplicateKeys.add(key);
        issues.push({
          kind: "duplicate-asset-id",
          path: record.metadataPath,
          detail: "Asset ID " + assetId + " duplicates " + existing.metadataPath + " after normalization.",
        });
      }
    } else {
      projectRecords.set(assetId, record);
    }
    byProject.set(projectId, projectRecords);
    const projects = projectsByAssetId.get(assetId) || new Set<string>();
    projects.add(projectId);
    projectsByAssetId.set(assetId, projects);
  }

  for (const record of records) {
    const projectId = normalizeLegacyId(record.projectId, "default");
    const rawParentAssetId = record.metadata.parent_asset_id || record.metadata.parentAssetId;
    const parentAssetId = rawParentAssetId ? normalizeLegacyId(rawParentAssetId, "asset") : null;
    if (!parentAssetId || byProject.get(projectId)?.has(parentAssetId)) continue;
    const foreignProjects = [...(projectsByAssetId.get(parentAssetId) || [])].filter((candidate) => candidate !== projectId);
    issues.push({
      kind: foreignProjects.length ? "version-project-mismatch" : "version-parent-missing",
      path: record.metadataPath,
      detail: foreignProjects.length
        ? "Version parent " + parentAssetId + " belongs to another project: " + foreignProjects.join(", ")
        : "Version parent does not exist: " + parentAssetId,
    });
  }
  const ordered: LegacyRecord[] = []; const state = new Map<string, string>(); const reportedCycles = new Set<string>();
  const visit = (record: LegacyRecord) => { const projectId = normalizeLegacyId(record.projectId, "default"); const assetId = normalizeLegacyId(record.metadata.id, "asset"); const key = `${projectId}\u0000${assetId}`; if (state.get(key) === "done") return; if (state.get(key) === "active") { if (!reportedCycles.has(key)) { reportedCycles.add(key); issues.push({ kind: "version-cycle", path: record.metadataPath, detail: `Version cycle at asset: ${assetId}` }); } return; } state.set(key, "active"); const rawParent = record.metadata.parent_asset_id || record.metadata.parentAssetId; const parentAssetId = rawParent ? normalizeLegacyId(rawParent, "asset") : null; const parent = parentAssetId ? byProject.get(projectId)?.get(parentAssetId) : null; if (parent) visit(parent); state.set(key, "done"); ordered.push(record); };
  for (const record of records) visit(record);
  const orderedSet = new Set(ordered); return [...ordered, ...records.filter((r) => !orderedSet.has(r))];
}

function normalizeLegacyId(value: string, fallback: string): string { return String(value || fallback).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || fallback; }
async function hashFile(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }
function normalizeGroupName(value: unknown): string { return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80); }
