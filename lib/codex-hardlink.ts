import { createHash, randomUUID } from "node:crypto";
import fsPromises from "node:fs/promises";
import { readFile, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

interface Asset {
  id: string;
  project_id: string;
  image_path?: string;
  source?: Record<string, unknown>;
  [key: string]: unknown;
}

interface Store {
  listAssets(filters: Record<string, unknown>): Promise<Asset[]>;
  updateMetadata(projectId: string, assetId: string, metadata: Record<string, unknown>): Promise<void>;
}

interface RelinkResult {
  migrated: string[];
  alreadyLinked: string[];
  skipped: Array<{ assetId: string; reason: string }>;
}

interface SingleRelinkResult {
  status: string;
}

export async function relinkCodexAssets(store: Store, projectId: string): Promise<RelinkResult> {
  const filters = { projectId, source: "codex-generated" };
  const assets = [
    ...(await store.listAssets(filters)),
    ...(await store.listAssets({ ...filters, archived: true })),
  ];
  const result: RelinkResult = { migrated: [], alreadyLinked: [], skipped: [] };
  for (const asset of assets) {
    const relink = await relinkCodexAsset(asset);
    if (relink.status === "migrated") {
      await store.updateMetadata(asset.project_id, asset.id, {
        source: { ...asset.source, storage_mode: "hard-link", storage_linked_at: new Date().toISOString() },
      });
      result.migrated.push(asset.id);
    } else if (relink.status === "already-linked") result.alreadyLinked.push(asset.id);
    else result.skipped.push({ assetId: asset.id, reason: relink.status });
  }
  return result;
}

export async function relinkCodexAsset(asset: Asset): Promise<SingleRelinkResult> {
  const sourcePath = asset.source?.path ? resolve(asset.source.path as string) : null;
  const targetPath = asset.image_path ? resolve(asset.image_path) : null;
  if (!sourcePath || !targetPath) return { status: "missing-path" };
  const generatedImagesRoot = typeof asset.source?.codex_generated_images_root === "string"
    ? resolve(asset.source.codex_generated_images_root as string)
    : null;
  if (!generatedImagesRoot || !isStrictChildPath(generatedImagesRoot, sourcePath)) {
    return { status: "non-generated-images-source" };
  }
  let sourceStat, targetStat;
  try {
    [sourceStat, targetStat] = await Promise.all([stat(sourcePath), stat(targetPath)]);
  } catch {
    return { status: "source-or-library-file-missing" };
  }
  if (!sourceStat.isFile() || !targetStat.isFile()) return { status: "not-a-file" };
  if (sourceStat.dev !== targetStat.dev) return { status: "different-filesystem" };
  if (sourceStat.ino === targetStat.ino) return { status: "already-linked" };
  const [sourceHash, targetHash] = await Promise.all([
    createHash("sha256").update(await readFile(sourcePath)).digest("hex"),
    createHash("sha256").update(await readFile(targetPath)).digest("hex"),
  ]);
  if (sourceHash !== targetHash) return { status: "content-mismatch" };
  const temporaryPath = join(dirname(targetPath), `.${basename(targetPath)}.${randomUUID()}.hardlink`);
  try {
    // link/rename 走 fs/promises 的默认导出对象（属性查找），失败路径才能被
    // 用 t.mock.method(fsPromises, "link", …) 注入 EPERM 的测试驱动——和
    // lib/reference-attachment-store.ts 同一做法。
    await fsPromises.link(sourcePath, temporaryPath);
    await fsPromises.rename(temporaryPath, targetPath);
    return { status: "migrated" };
  } catch (error: unknown) {
    // 任务 389（低18 ⑤）：exFAT 这类盘不支持硬链接，link/rename 抛
    // EPERM/EXDEV/ENOTSUP/EMLINK/EACCES；这张按 link-failed 记进 skipped，
    // 整理不再中断。其他错误照旧抛出去。
    if (HARDLINK_FAILURE_CODES.has((error as NodeJS.ErrnoException)?.code ?? "")) {
      return { status: "link-failed" };
    }
    throw error;
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

// exFAT 等文件系统上硬链接不可用时的错误码：整次迁移继续，单张记为跳过。
const HARDLINK_FAILURE_CODES: ReadonlySet<string> = new Set(["EPERM", "EXDEV", "ENOTSUP", "EMLINK", "EACCES"]);

function isStrictChildPath(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}
