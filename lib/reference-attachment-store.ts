import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fsPromises from "node:fs/promises";
import { lstat, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PIXEL_HASH_VERSION, safePixelDigest } from "./image-pixel-hash.js";

// link() goes through the fs/promises default-export object (property lookup
// at call time, not an ESM binding) so the failure fallback can be exercised
// by tests that substitute fsPromises.link with EXDEV/EPERM throws.

// A reference is captured before the generation it feeds lands, so a prune
// fired in that window (trash purge, permanent delete, empty trash) must not
// treat the not-yet-referenced attachment as unreachable. Attachments seen
// within this window survive; the next prune after it removes them as before.
const REFERENCE_PRUNE_GRACE_MS = 24 * 60 * 60 * 1000;

type ReferenceInput = {
  projectId?: string;
  bytes: Buffer;
  extension: string;
  mimeType: string;
  width: number;
  height: number;
  provider: string;
  pageUrl?: string;
  conversationId?: string;
  messageId?: string;
  generationContextId?: string;
  providerAssetId?: string;
  capturedAt: string;
  userMessage?: string;
  // Absolute path of a managed library original with identical content. When
  // supplied and verified, the attachment file is created as a hard link to it
  // so the duplicated bytes occupy disk once. Any failure falls back to
  // writing the bytes as a standalone file.
  linkSource?: string;
};

export type ReferenceUsage = {
  generation_context_id: string;
  provider: string;
  page_url: string;
  conversation_id: string;
  message_id: string;
  provider_asset_id: string;
  captured_at: string;
  user_message: string;
};

export type ReferenceAttachment = {
  id: string;
  project_id: string;
  last_seen_at: string;
  content_sha256: string;
  pixel_sha256: string;
  pixel_hash_version: string;
  file_name: string;
  mime_type: string;
  width: number;
  height: number;
  provider: string;
  page_url: string;
  conversation_id: string;
  message_id: string;
  provider_asset_id: string;
  captured_at: string;
  user_message: string;
  attachment_url: string;
  usages: ReferenceUsage[];
  // "hardlink" when the file on disk is a hard link to a library original
  // with identical content; "copy" (or absent, for pre-existing entries) when
  // the attachment owns a standalone file.
  storage?: "hardlink" | "copy";
};

export type HardlinkMigrationStats = {
  projects: number;
  scanned: number;
  replaced: number;
  skipped: number;
  failed: number;
  alreadyDone: boolean;
};

export function createReferenceAttachmentStore(libraryDir: string) {
  const root = resolve(libraryDir, "reference-attachments");
  // A runtime owns one store instance. Serialize the read-modify-write index
  // transaction so two captures arriving together cannot overwrite each
  // other's metadata entry.
  let saveQueue: Promise<unknown> = Promise.resolve();

  function save(input: ReferenceInput): Promise<{ attachment: ReferenceAttachment; created: boolean; duplicateKind?: "content" | "pixel" }> {
    const pending = saveQueue.then(() => withProjectWriteLock(root, input.projectId || "default", () => saveUnlocked(input)));
    saveQueue = pending.catch(() => undefined);
    return pending;
  }

  function pruneUnused(projectId: string, referencedIds: Iterable<string>, nowMs: number = Date.now()): Promise<{ removed: number; retained: number; failed: number }> {
    const cleanProjectId = cleanSegment(projectId || "default", "default");
    const keep = new Set([...referencedIds].map((value) => String(value || "").trim()).filter(Boolean));
    const pending = saveQueue.then(() => withProjectWriteLock(root, cleanProjectId, async () => {
      const indexed = await list(cleanProjectId);
      if (!indexed.length) return { removed: 0, retained: 0, failed: 0 };
      const projectRoot = join(root, cleanProjectId);
      const filesRoot = join(projectRoot, "files");
      const retained: ReferenceAttachment[] = [];
      let removed = 0;
      let failed = 0;
      for (const attachment of indexed) {
        if (keep.has(attachment.id)) {
          retained.push(attachment);
          continue;
        }
        if (nowMs - await attachmentLastSeenMs(attachment, filesRoot) < REFERENCE_PRUNE_GRACE_MS) {
          retained.push(attachment);
          continue;
        }
        const fileName = cleanSegment(attachment.file_name, "");
        if (!fileName) {
          failed += 1;
          retained.push(attachment);
          continue;
        }
        try {
          await unlink(join(filesRoot, fileName));
          removed += 1;
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") removed += 1;
          else {
            failed += 1;
            retained.push(attachment);
          }
        }
      }
      if (retained.length !== indexed.length) {
        await writeReferenceIndex(join(projectRoot, "index.json"), retained);
      }
      return { removed, retained: retained.length, failed };
    }));
    saveQueue = pending.catch(() => undefined);
    return pending;
  }

  async function saveUnlocked(input: ReferenceInput): Promise<{ attachment: ReferenceAttachment; created: boolean; duplicateKind?: "content" | "pixel" }> {
    const projectId = cleanSegment(input.projectId || "default", "default");
    const projectRoot = join(root, projectId);
    const filesRoot = join(projectRoot, "files");
    const indexPath = join(projectRoot, "index.json");
    await mkdir(filesRoot, { recursive: true });
    const contentHash = createHash("sha256").update(input.bytes).digest("hex");
    const pixelHash = await safePixelDigest(input.bytes).catch(() => "");
    const indexed = await list(projectId);
    const usage = referenceUsage(input);
    const existingByContent = indexed.find((item) => item.content_sha256 === contentHash);
    if (existingByContent) {
      const attachment = await appendReferenceUsage(indexPath, indexed, existingByContent, usage);
      return { attachment, created: false, duplicateKind: "content" };
    }
    const existingByPixel = pixelHash
      ? indexed.find((item) => item.pixel_hash_version === PIXEL_HASH_VERSION && item.pixel_sha256 === pixelHash)
      : undefined;
    if (existingByPixel) {
      const attachment = await appendReferenceUsage(indexPath, indexed, existingByPixel, usage);
      return { attachment, created: false, duplicateKind: "pixel" };
    }

    const extension = safeExtension(input.extension);
    const id = `ref-${contentHash.slice(0, 24)}`;
    const fileName = `${id}${extension}`;
    const filePath = join(filesRoot, fileName);
    const temporary = join(filesRoot, `.${id}-${randomUUID()}.tmp`);
    const linked = await tryLinkSource(input.linkSource, contentHash, temporary, dirname(root));
    if (!linked) await writeFile(temporary, input.bytes, { flag: "wx" });
    try {
      await rename(temporary, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
    const attachment: ReferenceAttachment = {
      id,
      project_id: projectId,
      last_seen_at: new Date().toISOString(),
      content_sha256: contentHash,
      pixel_sha256: pixelHash,
      pixel_hash_version: pixelHash ? PIXEL_HASH_VERSION : "",
      file_name: fileName,
      mime_type: String(input.mimeType || "application/octet-stream"),
      width: Number(input.width || 0),
      height: Number(input.height || 0),
      provider: String(input.provider || ""),
      page_url: String(input.pageUrl || ""),
      conversation_id: String(input.conversationId || ""),
      message_id: String(input.messageId || ""),
      provider_asset_id: String(input.providerAssetId || ""),
      captured_at: String(input.capturedAt || new Date().toISOString()),
      user_message: String(input.userMessage || ""),
      attachment_url: attachmentUrl(projectId, fileName),
      usages: [usage],
      storage: linked ? "hardlink" : "copy",
    };
    const items = [...await list(projectId), attachment];
    await writeReferenceIndex(indexPath, items);
    return { attachment, created: true };
  }

  async function list(projectId = "default"): Promise<ReferenceAttachment[]> {
    const cleanProjectId = cleanSegment(projectId, "default");
    const indexPath = join(root, cleanProjectId, "index.json");
    try {
      const parsed = JSON.parse(await readFile(indexPath, "utf8"));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item) => item && typeof item === "object").map((item) => ({
        ...item,
        project_id: cleanProjectId,
        last_seen_at: String(item.last_seen_at || ""),
        pixel_sha256: String(item.pixel_sha256 || ""),
        pixel_hash_version: String(item.pixel_hash_version || ""),
        provider_asset_id: String(item.provider_asset_id || ""),
        attachment_url: attachmentUrl(cleanProjectId, cleanSegment(item.file_name, "reference.bin")),
        usages: normalizeReferenceUsages(item),
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw error;
    }
  }

  async function read(projectId: string, fileName: string) {
    const cleanProjectId = cleanSegment(projectId, "default");
    const cleanFileName = cleanSegment(fileName, "");
    if (!cleanFileName) throw new Error("Reference attachment not found.");
    const filePath = join(root, cleanProjectId, "files", cleanFileName);
    const rootPath = resolve(root, cleanProjectId, "files");
    const resolved = resolve(filePath);
    if (resolved !== rootPath && !resolved.startsWith(`${rootPath}${sep}`)) throw new Error("Reference attachment not found.");
    await stat(resolved);
    return { stream: createReadStream(resolved), fileName: basename(resolved) };
  }

  // One-shot conversion of pre-existing duplicate attachments into hard links
  // against their matching library originals. Every file swap is independently
  // atomic (link to a temp name, then rename over the attachment), so an
  // interrupted pass can simply run again; the caller's completion flag is
  // written only after the whole pass, and entries already linked (same
  // dev+ino) are skipped.
  function migrateToHardLinks(input: {
    findOriginalPath: (projectId: string, contentSha256: string) => Promise<string>;
    isDone: () => Promise<boolean>;
    markDone: () => Promise<void>;
  }): Promise<HardlinkMigrationStats> {
    const pending = saveQueue.then(async () => {
      if (await input.isDone()) {
        return { projects: 0, scanned: 0, replaced: 0, skipped: 0, failed: 0, alreadyDone: true };
      }
      let projectIds: string[] = [];
      try {
        projectIds = (await readdir(root, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .filter((name) => cleanSegment(name, "") === name)
          .sort();
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      }
      const totals = { projects: 0, scanned: 0, replaced: 0, skipped: 0, failed: 0, alreadyDone: false };
      for (const projectId of projectIds) {
        const result = await withProjectWriteLock(root, projectId, () => migrateProjectToHardLinks(root, projectId, input.findOriginalPath));
        totals.projects += 1;
        totals.scanned += result.scanned;
        totals.replaced += result.replaced;
        totals.skipped += result.skipped;
        totals.failed += result.failed;
      }
      await input.markDone();
      return totals;
    });
    saveQueue = pending.catch(() => undefined);
    return pending;
  }

  return { root, save, list, read, pruneUnused, migrateToHardLinks };
}

async function migrateProjectToHardLinks(root: string, projectId: string, findOriginalPath: (projectId: string, contentSha256: string) => Promise<string>): Promise<{ scanned: number; replaced: number; skipped: number; failed: number }> {
  const filesRoot = join(root, projectId, "files");
  let names: string[];
  try {
    names = await readdir(filesRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { scanned: 0, replaced: 0, skipped: 0, failed: 0 };
    throw error;
  }
  let scanned = 0;
  let replaced = 0;
  let skipped = 0;
  let failed = 0;
  for (const name of names) {
    // Dot-prefixed names are in-flight writer temporaries and lock files.
    if (name.startsWith(".")) continue;
    const filePath = join(filesRoot, name);
    const fileStat = await lstat(filePath).catch(() => null);
    if (!fileStat?.isFile()) continue;
    scanned += 1;
    const contentHash = await sha256File(filePath).catch(() => "");
    if (!contentHash) {
      failed += 1;
      continue;
    }
    const originalPath = String(await findOriginalPath(projectId, contentHash).catch(() => "") || "");
    if (!originalPath) {
      skipped += 1;
      continue;
    }
    // Trust the file, never the database hash: re-read the candidate original
    // and only link when its current bytes match the attachment byte for byte.
    const originalHash = await sha256File(originalPath).catch(() => "");
    if (!originalHash || originalHash !== contentHash) {
      skipped += 1;
      continue;
    }
    const originalStat = await lstat(originalPath).catch(() => null);
    if (!originalStat?.isFile()) {
      skipped += 1;
      continue;
    }
    const sameFile = originalStat.dev === fileStat.dev && originalStat.ino === fileStat.ino;
    if (sameFile) {
      skipped += 1;
      continue;
    }
    const temporary = join(filesRoot, `.${cleanSegment(name, "ref")}-${randomUUID()}.tmp`);
    try {
      await fsPromises.link(originalPath, temporary);
      await rename(temporary, filePath);
      replaced += 1;
    } catch {
      // Any failure leaves this attachment untouched and processing continues.
      await unlink(temporary).catch(() => {});
      failed += 1;
    }
  }
  return { scanned, replaced, skipped, failed };
}

// Best-effort hard link for a new attachment. The source must be a regular
// file inside the same library root as the reference store, its current bytes
// must hash to the attachment's content hash, and link() must succeed; on any
// mismatch or failure the caller falls back to writing the bytes itself.
async function tryLinkSource(linkSource: string | undefined, contentHash: string, temporary: string, libraryRoot: string): Promise<boolean> {
  const source = String(linkSource || "").trim();
  if (!source) return false;
  const resolved = resolve(source);
  if (!isPathInside(resolve(libraryRoot), resolved)) return false;
  const sourceStat = await lstat(resolved).catch(() => null);
  if (!sourceStat?.isFile()) return false;
  const sourceHash = await sha256File(resolved).catch(() => "");
  if (sourceHash !== contentHash) return false;
  try {
    await fsPromises.link(resolved, temporary);
    return true;
  } catch {
    // Unsupported filesystems (EXDEV/EPERM/ENOTSUP/EMLINK/…) and anything
    // else: fall back to a standalone copy, never fail the save.
    return false;
  }
}

function isPathInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, rejectHash) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectHash);
    stream.once("end", () => resolveHash());
  });
  return hash.digest("hex");
}

function cleanSegment(value: unknown, fallback: string): string {
  const cleaned = String(value || "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160);
  return cleaned || fallback;
}

// The grace clock is the server-written last_seen_at; captured_at comes from
// the extension and may be wrong. Index entries older than the field fall
// back to the file's mtime, and an unreadable file counts as long ago so the
// prune can still reclaim its index row.
async function attachmentLastSeenMs(attachment: ReferenceAttachment, filesRoot: string): Promise<number> {
  const recorded = Date.parse(String(attachment.last_seen_at || ""));
  if (!Number.isNaN(recorded) && recorded > 0) return recorded;
  const fileName = cleanSegment(attachment.file_name, "");
  if (!fileName) return 0;
  try {
    return (await stat(join(filesRoot, fileName))).mtimeMs;
  } catch {
    return 0;
  }
}

function safeExtension(value: string): string {
  const extension = extname(`file${String(value || "")}`).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"].includes(extension) ? extension : ".bin";
}

function attachmentUrl(projectId: string, fileName: string): string {
  return `/library/${encodeURIComponent(projectId)}/references/${encodeURIComponent(fileName)}`;
}

function referenceUsage(input: ReferenceInput): ReferenceUsage {
  return {
    generation_context_id: String(input.generationContextId || ""),
    provider: String(input.provider || ""),
    page_url: String(input.pageUrl || ""),
    conversation_id: String(input.conversationId || ""),
    message_id: String(input.messageId || ""),
    provider_asset_id: String(input.providerAssetId || ""),
    captured_at: String(input.capturedAt || new Date().toISOString()),
    user_message: String(input.userMessage || ""),
  };
}

function normalizeReferenceUsages(item: Record<string, unknown>): ReferenceUsage[] {
  const raw = Array.isArray(item.usages) ? item.usages : [];
  const usages = raw.filter((usage) => usage && typeof usage === "object").map((usage) => {
    const value = usage as Record<string, unknown>;
    return {
      generation_context_id: String(value.generation_context_id || ""),
      provider: String(value.provider || item.provider || ""),
      page_url: String(value.page_url || item.page_url || ""),
      conversation_id: String(value.conversation_id || item.conversation_id || ""),
      message_id: String(value.message_id || item.message_id || ""),
      provider_asset_id: String(value.provider_asset_id || item.provider_asset_id || ""),
      captured_at: String(value.captured_at || item.captured_at || ""),
      user_message: String(value.user_message || item.user_message || ""),
    };
  });
  if (usages.length) return usages;
  return [{
    generation_context_id: "",
    provider: String(item.provider || ""),
    page_url: String(item.page_url || ""),
    conversation_id: String(item.conversation_id || ""),
    message_id: String(item.message_id || ""),
    provider_asset_id: String(item.provider_asset_id || ""),
    captured_at: String(item.captured_at || ""),
    user_message: String(item.user_message || ""),
  }];
}

function referenceUsageKey(usage: ReferenceUsage): string {
  if (usage.generation_context_id) return `context:${usage.generation_context_id}`;
  return [usage.conversation_id, usage.message_id, usage.captured_at].join("\u0000");
}

async function appendReferenceUsage(indexPath: string, indexed: ReferenceAttachment[], existing: ReferenceAttachment, usage: ReferenceUsage): Promise<ReferenceAttachment> {
  const usages = normalizeReferenceUsages(existing as unknown as Record<string, unknown>);
  const existingUsageIndex = usages.findIndex((item) => referenceUsageKey(item) === referenceUsageKey(usage));
  const nextUsages = existingUsageIndex >= 0
    ? usages.map((item, index) => index === existingUsageIndex ? mergeReferenceUsage(item, usage) : item)
    : [...usages, usage].slice(-100);
  const updated: ReferenceAttachment = {
    ...existing,
    last_seen_at: new Date().toISOString(),
    provider: existing.provider || usage.provider,
    page_url: existing.page_url || usage.page_url,
    conversation_id: existing.conversation_id || usage.conversation_id,
    message_id: existing.message_id || usage.message_id,
    provider_asset_id: existing.provider_asset_id || usage.provider_asset_id,
    user_message: existing.user_message || usage.user_message,
    usages: nextUsages,
  };
  if (JSON.stringify(updated) === JSON.stringify(existing)) return existing;
  const items = indexed.map((item) => item.id === existing.id ? updated : item);
  await writeReferenceIndex(indexPath, items);
  return updated;
}

function mergeReferenceUsage(existing: ReferenceUsage, incoming: ReferenceUsage): ReferenceUsage {
  return {
    generation_context_id: existing.generation_context_id || incoming.generation_context_id,
    provider: existing.provider || incoming.provider,
    page_url: existing.page_url || incoming.page_url,
    conversation_id: existing.conversation_id || incoming.conversation_id,
    message_id: existing.message_id || incoming.message_id,
    provider_asset_id: existing.provider_asset_id || incoming.provider_asset_id,
    captured_at: existing.captured_at || incoming.captured_at,
    user_message: existing.user_message || incoming.user_message,
  };
}

async function writeReferenceIndex(indexPath: string, items: ReferenceAttachment[]): Promise<void> {
  const indexTemporary = `${indexPath}.${randomUUID()}.tmp`;
  await writeFile(indexTemporary, `${JSON.stringify(items, null, 2)}\n`, "utf8");
  await rename(indexTemporary, indexPath);
}

async function withProjectWriteLock<T>(root: string, projectId: string, task: () => Promise<T>): Promise<T> {
  const projectRoot = join(root, cleanSegment(projectId, "default"));
  const lockPath = join(projectRoot, ".index.lock");
  await mkdir(projectRoot, { recursive: true });
  for (let attempt = 0; attempt < 250; attempt += 1) {
    let handle;
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid}:${Date.now()}\n`, "utf8");
    } catch (error) {
      await handle?.close().catch(() => {});
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > 30_000) {
          await unlink(lockPath).catch(() => {});
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException)?.code === "ENOENT") continue;
        throw statError;
      }
      await delay(20);
      continue;
    }
    try {
      return await task();
    } finally {
      await handle.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
    }
  }
  throw new Error("Reference attachment index is busy.");
}
