// @ts-ignore - better-sqlite3 is consumed as an untyped runtime dependency in this repository.
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
// @ts-ignore - gradual TypeScript migration: runtime implementation is still .mjs.
import { finalizeCopiedSqliteLibrary } from "./library-relocation.mjs";
// @ts-ignore - .mjs module with separate declarations.
import { sqliteDatabasePath } from "./sqlite-asset-store.mjs";
import { assertExistingSqliteLibrary, verifySqliteLibrary } from "./library-migration.js";

const BACKUP_FORMAT = "mosa-library-backup-v1";
const MANIFEST_NAME = "backup-manifest.json";
const COPY_ROOTS = ["assets", "reference-attachments", ".sqlite-migration-completed"];

type BackupFile = { path: string; size: number; sha256: string };
type BackupManifest = {
  format: string;
  createdAt: string;
  files: BackupFile[];
};

export async function createLibraryBackup(options: {
  libraryDir: string;
  destinationDir: string;
  projectRoot?: string;
  managerDir?: string;
}): Promise<{ backupDir: string; files: number; bytes: number; verification: Record<string, unknown> }> {
  const libraryDir = resolveRequired(options.libraryDir, "libraryDir");
  const destinationDir = resolveRequired(options.destinationDir, "destinationDir");
  assertSeparateRoots(libraryDir, destinationDir);
  // Source checks must run before any destination side effect: an unmigrated
  // or missing library produces no destination directory and no `.partial-*`.
  await assertExistingSqliteLibrary(libraryDir);
  await assertMigrationCompleted(libraryDir);
  await assertDirectoryTargetAvailable(destinationDir);

  const stagingDir = `${destinationDir}.partial-${randomUUID()}`;
  await mkdir(stagingDir, { recursive: true });
  let published = false;
  try {
    const sourceDatabase = new Database(sqliteDatabasePath(libraryDir), { readonly: true, fileMustExist: true });
    try {
      await sourceDatabase.backup(sqliteDatabasePath(stagingDir));
    } finally {
      sourceDatabase.close();
    }

    for (const name of COPY_ROOTS) {
      if (name === "reference-attachments") await assertReferenceStoreQuiescent(libraryDir);
      await copyManagedEntry(libraryDir, stagingDir, name);
      if (name === "reference-attachments") await assertReferenceStoreQuiescent(libraryDir);
    }

    // Absolute managed paths must be rewritten only after the copied tree has
    // its final pathname. `backup-manifest.json` is written last and is the
    // completion marker; a directory without it is never a valid backup.
    await rename(stagingDir, destinationDir);
    published = true;

    // Snapshot DB paths still point at the live library. Rebase them into the
    // backup only after all managed files have been copied and size-checked.
    // A concurrent permanent delete therefore fails closed instead of yielding
    // a database that references a missing backup byte.
    await finalizeCopiedSqliteLibrary({
      sourceLibraryDir: libraryDir,
      destinationLibraryDir: destinationDir,
    });
    await verifyReferenceAttachments(destinationDir);
    const verification = await verifySqliteLibrary({
      projectRoot: resolve(options.projectRoot || process.cwd()),
      managerDir: resolve(options.managerDir || process.cwd()),
      libraryDir: destinationDir,
    });
    if (verification.ok !== true) throw new Error("Backup snapshot failed GravityPort library verification.");

    const files = await describeBackupFiles(destinationDir);
    // Run the exact read-only audit that `backup-verify` will run later, before
    // the completion marker is written: a published backup must never fail a
    // subsequent backup-verify. A failure here cleans up via the catch below.
    // File hashes were computed from these exact bytes a moment ago by
    // describeBackupFiles, so re-hashing here would only double the read I/O.
    const snapshot = await verifyBackupSnapshot(destinationDir, files, { rehashFiles: false });
    if (snapshot.failures.length) {
      throw new Error(`Backup snapshot failed backup verification: ${JSON.stringify(snapshot.failures)}`);
    }
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      createdAt: new Date().toISOString(),
      files,
    };
    await writeFile(join(destinationDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return {
      backupDir: destinationDir,
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
      verification,
    };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    if (published) await rm(destinationDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function verifyLibraryBackup(options: {
  backupDir: string;
  projectRoot?: string;
  managerDir?: string;
}): Promise<{ ok: boolean; backupDir: string; files: number; bytes: number; failures: Array<Record<string, unknown>>; library?: Record<string, unknown> }> {
  const backupDir = resolveRequired(options.backupDir, "backupDir");
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await readFile(join(backupDir, MANIFEST_NAME), "utf8")) as BackupManifest;
  } catch (error) {
    return { ok: false, backupDir, files: 0, bytes: 0, failures: [{ reason: "manifest-unreadable", detail: errorMessage(error) }] };
  }
  if (manifest.format !== BACKUP_FORMAT || !Array.isArray(manifest.files)) {
    return { ok: false, backupDir, files: 0, bytes: 0, failures: [{ reason: "manifest-format" }] };
  }

  const snapshot = await verifyBackupSnapshot(backupDir, manifest.files);
  return {
    ok: snapshot.failures.length === 0,
    backupDir,
    files: manifest.files.length,
    bytes: manifest.files.reduce((sum, file) => sum + Number(file.size || 0), 0),
    failures: snapshot.failures,
    library: snapshot.library,
  };
}

/**
 * The single verification standard for a backup snapshot's contents: every
 * manifest entry must match the bytes on disk, reference attachments must be
 * intact, and a read-only pass over the snapshot database must accept it.
 * Both verifyLibraryBackup and the publish gate of createLibraryBackup run
 * this, so the two never drift apart.
 */
async function verifyBackupSnapshot(backupDir: string, files: BackupFile[], { rehashFiles = true }: { rehashFiles?: boolean } = {}): Promise<{ failures: Array<Record<string, unknown>>; library?: Record<string, unknown> }> {
  const failures: Array<Record<string, unknown>> = [];
  for (const entry of files) {
    try {
      const path = safeBackupPath(backupDir, entry.path);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("not a regular file");
      if (info.size !== entry.size) throw new Error(`size ${info.size} != ${entry.size}`);
      if (rehashFiles && await sha256File(path) !== entry.sha256) throw new Error("sha256 mismatch");
    } catch (error) {
      failures.push({ path: entry.path, reason: "file-integrity", detail: errorMessage(error) });
    }
  }
  let library: Record<string, unknown> | undefined;
  if (!failures.length) {
    try {
      await verifyReferenceAttachments(backupDir);
      library = await verifyBackupSqliteReadOnly(backupDir);
      if (library.ok !== true) failures.push({ reason: "library-verification", detail: library });
    } catch (error) {
      failures.push({ reason: "library-verification", detail: errorMessage(error) });
    }
  }
  return { failures, library };
}

async function verifyBackupSqliteReadOnly(libraryDir: string): Promise<Record<string, unknown>> {
  const database = new Database(sqliteDatabasePath(libraryDir), { readonly: true, fileMustExist: true });
  try {
    const integrity = database.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") return { ok: false, integrity, failures: [{ reason: "sqlite-integrity" }] };
    const foreignKeys = database.pragma("foreign_key_check");
    if (Array.isArray(foreignKeys) && foreignKeys.length) {
      return { ok: false, integrity, failures: [{ reason: "foreign-key-check", count: foreignKeys.length }] };
    }
    const migrationState = database.prepare("SELECT value FROM library_meta WHERE key = 'migration_state'").get()?.value;
    if (migrationState !== "completed") {
      return { ok: false, integrity, migrationState, failures: [{ reason: "migration-incomplete" }] };
    }
    const rows = database.prepare("SELECT project_id, id, original_path, content_sha256 FROM assets ORDER BY project_id, id").all();
    const failures: Array<Record<string, unknown>> = [];
    const backupRoot = resolve(libraryDir);
    for (const row of rows) {
      try {
        const originalPath = resolve(String(row.original_path || ""));
        if (!originalPath.startsWith(`${backupRoot}${sep}`)) {
          failures.push({ projectId: row.project_id, assetId: row.id, reason: "original-outside-backup" });
          continue;
        }
        const actual = await sha256File(originalPath);
        if (actual !== String(row.content_sha256 || "")) {
          failures.push({ projectId: row.project_id, assetId: row.id, reason: "content-hash-mismatch" });
        }
      } catch {
        failures.push({ projectId: row.project_id, assetId: row.id, reason: "original-missing" });
      }
    }
    return { ok: failures.length === 0, integrity, migrationState, assets: rows.length, failures };
  } finally {
    database.close();
  }
}

export async function restoreLibraryBackup(options: {
  backupDir: string;
  destinationDir: string;
  projectRoot?: string;
  managerDir?: string;
}): Promise<{ libraryDir: string; files: number; bytes: number; verification: Record<string, unknown> }> {
  const backupDir = resolveRequired(options.backupDir, "backupDir");
  const destinationDir = resolveRequired(options.destinationDir, "destinationDir");
  assertSeparateRoots(backupDir, destinationDir);
  await assertDirectoryTargetAvailable(destinationDir);
  const verified = await verifyLibraryBackup({
    backupDir,
    projectRoot: options.projectRoot,
    managerDir: options.managerDir,
  });
  if (!verified.ok) throw new Error(`Backup verification failed: ${JSON.stringify(verified.failures)}`);

  const stagingDir = `${destinationDir}.partial-${randomUUID()}`;
  await mkdir(stagingDir, { recursive: true });
  let published = false;
  try {
    const manifest = JSON.parse(await readFile(join(backupDir, MANIFEST_NAME), "utf8")) as BackupManifest;
    for (const entry of manifest.files) {
      const sourcePath = safeBackupPath(backupDir, entry.path);
      const destinationPath = safeBackupPath(stagingDir, entry.path);
      await mkdir(dirname(destinationPath), { recursive: true });
      await copyFile(sourcePath, destinationPath);
    }
    await rename(stagingDir, destinationDir);
    published = true;
    await finalizeCopiedSqliteLibrary({
      sourceLibraryDir: backupDir,
      destinationLibraryDir: destinationDir,
    });
    await verifyReferenceAttachments(destinationDir);
    const verification = await verifySqliteLibrary({
      projectRoot: resolve(options.projectRoot || process.cwd()),
      managerDir: resolve(options.managerDir || process.cwd()),
      libraryDir: destinationDir,
    });
    if (verification.ok !== true) throw new Error("Restored library failed GravityPort verification.");
    return { libraryDir: destinationDir, files: verified.files, bytes: verified.bytes, verification };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    if (published) await rm(destinationDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function assertMigrationCompleted(libraryDir: string): Promise<void> {
  const database = new Database(sqliteDatabasePath(libraryDir), { readonly: true, fileMustExist: true });
  try {
    const state = database.prepare("SELECT value FROM library_meta WHERE key = 'migration_state'").get()?.value;
    if (state !== "completed") {
      throw new Error(`Source library migration is not complete (migration_state: ${String(state)}). Run \`mosa migrate\` on this library before backing it up.`);
    }
  } finally {
    database.close();
  }
}

async function assertDirectoryTargetAvailable(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("destination already exists and is not a normal directory");
    const entries = await readdir(path);
    if (entries.length) throw new Error("destination directory must be empty");
    await rm(path, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      await mkdir(dirname(path), { recursive: true });
      return;
    }
    throw error;
  }
}

function assertSeparateRoots(left: string, right: string): void {
  if (left === right || right.startsWith(`${left}${sep}`) || left.startsWith(`${right}${sep}`)) {
    throw new Error("Backup source and destination must not contain one another.");
  }
}

async function copyManagedEntry(sourceRoot: string, destinationRoot: string, name: string): Promise<void> {
  const source = join(sourceRoot, name);
  let info;
  try { info = await lstat(source); } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error(`Refusing symlink in backup root: ${name}`);
  if (info.isFile()) {
    await copyFile(source, join(destinationRoot, name));
    return;
  }
  if (!info.isDirectory()) throw new Error(`Unsupported backup entry: ${name}`);
  for (const relativePath of await regularFilesUnder(source)) {
    const from = join(source, relativePath);
    const to = join(destinationRoot, name, relativePath);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }
}

async function regularFilesUnder(root: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".index.lock" || entry.name.endsWith(".tmp")) continue;
    const relativePath = prefix ? join(prefix, entry.name) : entry.name;
    const fullPath = join(root, relativePath);
    const info = await lstat(fullPath);
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink in backup tree: ${relativePath}`);
    if (info.isDirectory()) result.push(...await regularFilesUnder(root, relativePath));
    else if (info.isFile()) result.push(relativePath);
    else throw new Error(`Unsupported filesystem entry in backup tree: ${relativePath}`);
  }
  return result;
}

async function assertReferenceStoreQuiescent(libraryDir: string): Promise<void> {
  const root = join(libraryDir, "reference-attachments");
  let projects;
  try { projects = await readdir(root, { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw error;
  }
  for (const project of projects) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue;
    try {
      const info = await lstat(join(root, project.name, ".index.lock"));
      if (info.isFile()) {
        throw new Error(`Reference attachments are being updated for project ${project.name}; retry the backup after capture finishes.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }
}

async function describeBackupFiles(root: string): Promise<BackupFile[]> {
  const relativePaths = await regularFilesUnder(root);
  const files: BackupFile[] = [];
  for (const relativePath of relativePaths.sort()) {
    if (relativePath === MANIFEST_NAME) continue;
    const path = join(root, relativePath);
    const info = await stat(path);
    files.push({ path: relativePath, size: info.size, sha256: await sha256File(path) });
  }
  return files;
}

async function verifyReferenceAttachments(libraryDir: string): Promise<void> {
  const root = join(libraryDir, "reference-attachments");
  let projects;
  try { projects = await readdir(root, { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw error;
  }
  for (const project of projects) {
    if (!project.isDirectory() || project.isSymbolicLink()) throw new Error("Invalid reference attachment project entry.");
    const projectRoot = join(root, project.name);
    let items: Array<Record<string, unknown>>;
    try { items = JSON.parse(await readFile(join(projectRoot, "index.json"), "utf8")); }
    catch (error) { throw new Error(`Reference attachment index is unreadable for ${project.name}: ${errorMessage(error)}`); }
    if (!Array.isArray(items)) throw new Error(`Reference attachment index is invalid for ${project.name}.`);
    for (const item of items) {
      const fileName = String(item?.file_name || "");
      if (!fileName || fileName.includes("/") || fileName.includes("\\")) throw new Error("Unsafe reference attachment filename.");
      const path = join(projectRoot, "files", fileName);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Reference attachment is missing: ${project.name}/${fileName}`);
      const expectedHash = String(item?.content_sha256 || "");
      if (expectedHash && await sha256File(path) !== expectedHash) throw new Error(`Reference attachment hash mismatch: ${project.name}/${fileName}`);
    }
  }
}

function safeBackupPath(root: string, relativePath: string): string {
  const clean = String(relativePath || "");
  if (!clean || clean.startsWith("/") || clean.includes("\0")) throw new Error("Unsafe backup manifest path.");
  const candidate = resolve(root, clean);
  if (candidate === root || !candidate.startsWith(`${root}${sep}`) || relative(root, candidate).startsWith("..")) {
    throw new Error("Unsafe backup manifest path.");
  }
  return candidate;
}

function resolveRequired(value: string, name: string): string {
  if (!String(value || "").trim()) throw new Error(`${name} is required.`);
  return resolve(value);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
