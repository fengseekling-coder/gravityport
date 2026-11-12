import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { relinkCodexAssets } from "../lib/codex-hardlink.js";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("SQLite Codex hard-link maintenance skips session-recovered assets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-sqlite-codex-session-copy-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const codexImagesDir = join(root, ".codex", "generated_images");
  const recoveryRoot = join(root, "library", "assets", ".codex-session-recovery");
  const recoveredPath = join(recoveryRoot, "recovered.png");
  await mkdir(codexImagesDir, { recursive: true });
  await mkdir(recoveryRoot, { recursive: true });
  await writeFile(recoveredPath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({
    projectRoot,
    managerDir: join(projectRoot, "mosa"),
    libraryDir: join(root, "library"),
    codexImagesDir,
  });
  t.after(() => store.close());

  const asset = await store.createAsset({
    assetId: "codex-session-recovered",
    imagePath: recoveredPath,
    sourceType: "codex-generated",
    source: {
      generation_tool: "codex-imagegen-session-recovery",
      codex_session_event_key: "session::call",
      codex_recovered_from_session: true,
    },
  }, { trustedSourceRoots: [recoveryRoot] });
  assert.equal(asset.source.storage_mode, "copy");

  const result = await store.migrateCodexAssetsToHardLinks("default");
  assert.deepEqual(result.migrated, []);
  assert.deepEqual(result.alreadyLinked, []);
  assert.deepEqual(result.skipped, [{ assetId: "codex-session-recovered", reason: "non-generated-images-source" }]);
});

// 任务 389（低18 ⑤）：exFAT 这类不支持硬链接的盘上 link() 抛 EPERM，这张
// 记为 link-failed（进 skipped），整次迁移不再中断；原文件内容不变、临时
// 文件不残留。link 通过 t.mock.method(fsPromises, "link", …) 注入——被测模块
// 对 fs/promises 默认导出对象做属性查找（lib/reference-attachment-store.ts 同法）。
test("a hard-link failure on an unsupported filesystem is recorded as link-failed, not fatal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-hardlink-eperm-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const codexImagesDir = join(root, ".codex", "generated_images");
  const sourcePath = join(codexImagesDir, "task", "out.png");
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const targetPath = join(root, "library-copy.png");
  await writeFile(targetPath, ONE_PIXEL_PNG);

  const asset = {
    id: "codex-eperm",
    project_id: "default",
    image_path: targetPath,
    source: { path: sourcePath, codex_generated_images_root: codexImagesDir },
  };
  const updates = [];
  const store = {
    // relinkCodexAssets 查两次（普通 + archived），这张只进普通清单。
    listAssets: async (filters) => (filters?.archived ? [] : [asset]),
    updateMetadata: async (projectId, assetId, metadata) => { updates.push({ projectId, assetId, metadata }); },
  };

  const brokenLink = t.mock.method(fsPromises, "link", async () => {
    const error = new Error("operation not permitted (simulated)");
    error.code = "EPERM";
    throw error;
  });
  const result = await relinkCodexAssets(store, "default");
  assert.equal(brokenLink.mock.callCount(), 1, "the simulated EPERM link() was actually used");
  assert.deepEqual(result.skipped, [{ assetId: "codex-eperm", reason: "link-failed" }]);
  assert.deepEqual(result.migrated, []);
  assert.deepEqual(result.alreadyLinked, []);
  // link-failed 不改 metadata（storage_mode 不标成 hard-link）。
  assert.equal(updates.length, 0);
  // 原文件内容没变。
  assert.deepEqual(await readFile(sourcePath), ONE_PIXEL_PNG);
  assert.deepEqual(await readFile(targetPath), ONE_PIXEL_PNG);
  // 临时文件没留下（finally 的 unlink 照旧）。
  const leftovers = (await readdir(dirname(targetPath))).filter(name => name.startsWith(".") && name.endsWith(".hardlink"));
  assert.deepEqual(leftovers, []);
});
