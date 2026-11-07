import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LIBRARY_DIR_NAME } from "../lib/library-location.mjs";
import { createAssetStore } from "../lib/asset-store.mjs";
import { removeTestPath } from "./test-cleanup.mjs";
import { createMcpWorkspace, spawnMcpServerAsClient, startMcpServer, writePngFixture } from "./helpers/mcp-server-harness.mjs";

const LEGACY_CAPABILITY_KEY = Buffer.from("ZWxpY2l0YXRpb24=", "base64").toString();
const LEGACY_METHOD_NAME = Buffer.from("ZWxpY2l0YXRpb24vY3JlYXRl", "base64").toString();

async function setupServer(t, { clientCapabilities = null, env: extraEnv = {} } = {}) {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace, { env: extraEnv });
  await server.request("initialize", clientCapabilities ? { capabilities: clientCapabilities } : {});
  return { workspace, server };
}

function assertImportError(result, code) {
  assert.equal(result.isError, true, "the failure is a tool-level isError result");
  assert.equal(result.structuredContent?.error?.code, code);
}

test("a folder outside trusted roots imports directly whether client advertises capability or not", async (t) => {
  // Case A: client advertises legacy capability
  const { workspace: ws1, server: s1 } = await setupServer(t, {
    clientCapabilities: { [LEGACY_CAPABILITY_KEY]: {} },
  });
  const folder1 = join(ws1.root, "outside-cap");
  await writePngFixture(join(folder1, "top.png"), { color: "#31708f" });
  await writePngFixture(join(folder1, "nested", "deep.png"), { color: "#7a3c47" });

  const result1 = await s1.callToolStrict("asset_import_folder", { folderPath: folder1, prompt: "drop with cap" });
  assert.equal(result1.isError, undefined);
  assert.equal(result1.structuredContent.imported, 1);
  assert.equal(result1.structuredContent.deduplicated, 0);
  assert.equal(result1.structuredContent.failed, 0);
  assert.equal(result1.structuredContent.assetIds.length, 1);
  assert.equal(s1.responses.some((msg) => msg.method === LEGACY_METHOD_NAME), false);
  assert.equal(s1.responses.some((msg) => typeof msg.method === "string"), false);

  const fetched = await s1.callToolStrict("asset_get", { assetId: result1.structuredContent.assetIds[0] });
  assert.equal(fetched.structuredContent.asset.prompt, "drop with cap");

  // recursive: true imports subfolders
  const recResult = await s1.callToolStrict("asset_import_folder", { folderPath: folder1, recursive: true });
  assert.equal(recResult.structuredContent.imported, 1);
  assert.equal(recResult.structuredContent.deduplicated, 1);
  const list1 = await s1.callToolStrict("asset_list", {});
  assert.equal(list1.structuredContent.assets.length, 2);

  // Case B: client without capability advertises nothing
  const { workspace: ws2, server: s2 } = await setupServer(t);
  const folder2 = join(ws2.root, "outside-nocap");
  await writePngFixture(join(folder2, "plain.png"), { color: "#4a6d3c" });

  const result2 = await s2.callToolStrict("asset_import_folder", { folderPath: folder2, prompt: "drop without cap" });
  assert.equal(result2.isError, undefined);
  assert.equal(result2.structuredContent.imported, 1);
  assert.equal(s2.responses.some((msg) => msg.method === LEGACY_METHOD_NAME), false);
  assert.equal(s2.responses.some((msg) => typeof msg.method === "string"), false);
  const list2 = await s2.callToolStrict("asset_list", {});
  assert.equal(list2.structuredContent.assets.length, 1);
});

test("asset_create with an absolute path outside trusted roots succeeds and deduplicates on second call", async (t) => {
  const { workspace, server } = await setupServer(t);
  const outsideDir = await mkdtemp(join(tmpdir(), "gp-mcp-outside-single-"));
  t.after(() => removeTestPath(outsideDir, { recursive: true, force: true }));
  const imagePath = await writePngFixture(join(outsideDir, "single.png"), { color: "#225588" });

  const created = await server.callToolStrict("asset_create", {
    assetId: "outside-single",
    imagePath,
    prompt: "outside prompt",
  });
  assert.equal(created.structuredContent.asset.id, "outside-single");
  assert.equal(created.structuredContent.asset.prompt, "outside prompt");

  // Second call with identical bytes returns existing asset with deduplicated: true
  const duplicate = await server.callToolStrict("asset_create", {
    assetId: "outside-single-copy",
    imagePath,
    prompt: "attempted duplicate",
  });
  assert.equal(duplicate.structuredContent.deduplicated, true);
  assert.equal(duplicate.structuredContent.asset.id, "outside-single");

  const list = await server.callToolStrict("asset_list", {});
  assert.equal(list.structuredContent.assets.length, 1);
});

test("relative paths for folder and single image are rejected and library remains unchanged", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gp-mcp-relative-"));
  t.after(() => removeTestPath(root, { recursive: true, force: true }));
  const clientCwd = join(root, "client-cwd");
  const home = join(root, "home");
  const libraryDir = join(home, LIBRARY_DIR_NAME);
  await mkdir(clientCwd, { recursive: true });
  await writePngFixture(join(clientCwd, "stray.png"), { color: "#112233" });

  const seedStore = createAssetStore({
    projectRoot: root,
    managerDir: root,
    libraryDir,
    explicitLibraryDir: libraryDir,
    assetsRoot: join(libraryDir, "assets"),
    generatedImagesDir: join(libraryDir, "imports"),
  });
  seedStore.close();

  const server = spawnMcpServerAsClient(t, {
    args: [resolve(import.meta.dirname, "..", "mcp", "server.mjs")],
    cwd: clientCwd,
    env: { ...process.env, HOME: home, GRAVITYPORT_LIBRARY_DIR: libraryDir },
  });
  await server.request("initialize", {});

  // Single image relative path rejected with IMAGE_PATH_NOT_READABLE
  const singleResult = await server.callTool("asset_create", {
    assetId: "stray",
    imagePath: "stray.png",
    prompt: "must not import",
  });
  assertImportError(singleResult, "IMAGE_PATH_NOT_READABLE");

  // Folder relative path rejected with IMPORT_FOLDER_NOT_ABSOLUTE
  const folderResult = await server.callTool("asset_import_folder", {
    folderPath: "relative/folder",
  });
  assertImportError(folderResult, "IMPORT_FOLDER_NOT_ABSOLUTE");

  // Library remains completely empty
  const list = await server.callToolStrict("asset_list", {});
  assert.equal(list.structuredContent.assets.length, 0);
});

test("non-media files (.txt) are rejected for asset_create and skipped for asset_import_folder", async (t) => {
  const { workspace, server } = await setupServer(t);
  const textFile = join(workspace.root, "notes.txt");
  await writeFile(textFile, "plain text");

  // asset_create with .txt fails with IMAGE_PATH_UNSUPPORTED_TYPE
  const createResult = await server.callTool("asset_create", {
    imagePath: textFile,
  });
  assertImportError(createResult, "IMAGE_PATH_UNSUPPORTED_TYPE");

  // asset_import_folder with notes.txt in folder skips it
  const folder = join(workspace.root, "folder-with-txt");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "notes.txt"), "non media file");
  await writePngFixture(join(folder, "valid.png"), { color: "#4477aa" });

  const importResult = await server.callToolStrict("asset_import_folder", { folderPath: folder });
  assert.equal(importResult.structuredContent.imported, 1);
  assert.equal(importResult.structuredContent.skipped, 1);
  assert.equal(importResult.structuredContent.failed, 0);

  const list = await server.callToolStrict("asset_list", {});
  assert.equal(list.structuredContent.assets.length, 1);
});

test("source folder contents remain unchanged after import", async (t) => {
  const { workspace, server } = await setupServer(t);
  const folder = join(workspace.root, "preserved-folder");
  const file1 = await writePngFixture(join(folder, "a.png"), { color: "#114477" });
  const file2 = await writePngFixture(join(folder, "sub", "b.png"), { color: "#774411" });
  await writeFile(join(folder, "readme.txt"), "preserve me");

  const beforeEntries = await readdir(folder, { recursive: true });
  const beforeContent1 = await readFile(file1);
  const beforeContent2 = await readFile(file2);

  const result = await server.callToolStrict("asset_import_folder", {
    folderPath: folder,
    recursive: true,
  });
  assert.equal(result.structuredContent.imported, 2);
  assert.equal(result.structuredContent.skipped, 1);

  const afterEntries = await readdir(folder, { recursive: true });
  const afterContent1 = await readFile(file1);
  const afterContent2 = await readFile(file2);

  assert.deepEqual(afterEntries, beforeEntries);
  assert.deepEqual(afterContent1, beforeContent1);
  assert.deepEqual(afterContent2, beforeContent2);
});

test("recursive walks at most 5 layers and skips symbolic links and other file types", async (t) => {
  const { workspace, server } = await setupServer(t);
  const folder = join(workspace.root, "deep-tree");
  // l1..l4 are layers 1..4, so their files sit at layer 5 (the deepest walked)
  // and files inside l5 would be layer 6 — beyond the limit.
  const deep = join(folder, "l1", "l2", "l3", "l4");
  await writePngFixture(join(deep, "depth5.png"), { color: "#314f8f" });
  await writePngFixture(join(deep, "l5", "depth6.png"), { color: "#5f314f" });
  await writePngFixture(join(folder, "top.png"), { color: "#4f4f31" });
  await writeFile(join(folder, "notes.txt"), "not media");
  const outside = join(workspace.root, "outside");
  const linked = await writePngFixture(join(outside, "linked.png"), { color: "#6f3145" });
  await symlink(linked, join(folder, "linked.png"));
  await symlink(outside, join(folder, "linked-dir"));

  const result = await server.callToolStrict("asset_import_folder", { folderPath: folder, recursive: true });
  // top.png + depth5.png; depth6.png sits in layer 6 and the two symlinks
  // (file and folder) were never followed.
  assert.equal(result.structuredContent.imported, 2);
  assert.equal(result.structuredContent.skipped, 3);
  const list = await server.callToolStrict("asset_list", {});
  assert.equal(list.structuredContent.assets.length, 2);
});

test("a batch over the cap fails before importing and imports nothing", async (t) => {
  const { workspace, server } = await setupServer(t, {
    env: { MOSA_MCP_IMPORT_FOLDER_MAX_FILES: "2" },
  });
  const folder = join(workspace.root, "big");
  await writePngFixture(join(folder, "a.png"), { color: "#111111" });
  await writePngFixture(join(folder, "b.png"), { color: "#222222" });
  await writePngFixture(join(folder, "c.png"), { color: "#333333" });

  const result = await server.callTool("asset_import_folder", { folderPath: folder });
  assertImportError(result, "IMPORT_FOLDER_TOO_LARGE");
  assert.equal(server.responses.some((message) => typeof message.method === "string"), false);
  const list = await server.callToolStrict("asset_list", {});
  assert.equal(list.structuredContent.assets.length, 0);
});

test("an empty folder answers with zero counts", async (t) => {
  const { workspace, server } = await setupServer(t);
  const folder = join(workspace.root, "empty");
  await mkdir(folder, { recursive: true });

  const result = await server.callToolStrict("asset_import_folder", { folderPath: folder });
  assert.deepEqual(result.structuredContent, { imported: 0, deduplicated: 0, skipped: 0, failed: 0, assetIds: [], failures: [] });
  assert.equal(server.responses.some((message) => typeof message.method === "string"), false);
});

test("identical bytes already in the library count as deduplicated", async (t) => {
  const { workspace, server } = await setupServer(t);
  const known = await writePngFixture(join(workspace.imagesDir, "known.png"), { color: "#7c318f" });
  await server.callToolStrict("asset_create", { assetId: "known", imagePath: known });
  const folder = join(workspace.root, "dup");
  await mkdir(folder, { recursive: true });
  await copyFile(known, join(folder, "copy-of-known.png"));
  await writePngFixture(join(folder, "fresh.png"), { color: "#8f7c31" });

  const result = await server.callToolStrict("asset_import_folder", { folderPath: folder });
  assert.equal(result.structuredContent.imported, 1);
  assert.equal(result.structuredContent.deduplicated, 1);
  assert.equal(result.structuredContent.assetIds.length, 1);
  const list = await server.callToolStrict("asset_list", {});
  assert.equal(list.structuredContent.assets.length, 2);
});

test("a failed file is reported and does not stop the rest", async (t) => {
  const { workspace, server } = await setupServer(t);
  const folder = join(workspace.root, "mixed-health");
  const readable = await writePngFixture(join(folder, "readable.png"), { color: "#318f7c" });
  const unreadable = await writePngFixture(join(folder, "unreadable.png"), { color: "#8f3131" });
  await chmod(unreadable, 0o000);
  t.after(() => chmod(unreadable, 0o644).catch(() => {}));

  const result = await server.callToolStrict("asset_import_folder", { folderPath: folder });
  assert.equal(result.structuredContent.imported, 1);
  assert.equal(result.structuredContent.failed, 1);
  assert.deepEqual(result.structuredContent.failures, [{ file: "unreadable.png", code: "EACCES" }]);
  assert.ok(await readFile(readable));
});

// 任务 366：文本改名 .png 在文件头嗅探处失败，算一条 failed，不打断其余文件。
test("a non-media file behind a media extension fails with IMAGE_CONTENT_NOT_MEDIA and does not stop the rest", async (t) => {
  const { workspace, server } = await setupServer(t);
  const folder = join(workspace.root, "mixed-content");
  const real = await writePngFixture(join(folder, "real.png"), { color: "#7c318f" });
  await writeFile(join(folder, "fake.png"), "plain text pretending to be a picture", "utf8");

  const result = await server.callToolStrict("asset_import_folder", { folderPath: folder });
  assert.equal(result.structuredContent.imported, 1);
  assert.equal(result.structuredContent.failed, 1);
  assert.deepEqual(result.structuredContent.failures, [{ file: "fake.png", code: "IMAGE_CONTENT_NOT_MEDIA" }]);
  assert.ok(await readFile(real));
});

test("missing and non-directory folderPath fail with appropriate error", async (t) => {
  const { workspace, server } = await setupServer(t);
  const missing = await server.callTool("asset_import_folder", { folderPath: join(workspace.root, "nope") });
  assertImportError(missing, "IMPORT_FOLDER_NOT_FOUND");
  const file = await writePngFixture(join(workspace.imagesDir, "plain.png"));
  const notDirectory = await server.callTool("asset_import_folder", { folderPath: file });
  assertImportError(notDirectory, "IMPORT_FOLDER_NOT_DIRECTORY");
  const relativePath = await server.callTool("asset_import_folder", { folderPath: "some/relative/folder" });
  assertImportError(relativePath, "IMPORT_FOLDER_NOT_ABSOLUTE");
  assert.equal(server.responses.some((message) => typeof message.method === "string"), false);
});

test("folder path with symlink resolves target directory and imports directly", async (t) => {
  const { workspace, server } = await setupServer(t);
  const realFolder = join(workspace.root, "real-folder");
  await writePngFixture(join(realFolder, "one.png"), { color: "#4a6f31" });
  const linkFolder = join(workspace.root, "innocent-link");
  await symlink(realFolder, linkFolder, "dir");

  const result = await server.callToolStrict("asset_import_folder", {
    folderPath: join(linkFolder, "..", "innocent-link"),
  });
  assert.equal(result.structuredContent.imported, 1);
  assert.equal(result.structuredContent.failed, 0);
});

test("asset_version_create cannot pull a replacement image from the working directory", async (t) => {
  const { workspace, server } = await setupServer(t);
  const rootImage = await writePngFixture(join(workspace.imagesDir, "root.png"), { color: "#314f6f" });
  await server.callToolStrict("asset_create", { assetId: "root", imagePath: rootImage });
  const outside = await writePngFixture(join(workspace.root, "outside.png"), { color: "#6f314f" });

  const result = await server.callTool("asset_version_create", {
    assetId: "root",
    imagePath: outside,
    version_change: "swap from an untrusted folder",
  });
  assertImportError(result, "IMAGE_PATH_NOT_READABLE");

  const allowed = await writePngFixture(join(workspace.imagesDir, "replacement.png"), { color: "#4f6f31" });
  const okVersion = await server.callToolStrict("asset_version_create", {
    assetId: "root",
    imagePath: allowed,
    version_change: "swap from the Codex root",
  });
  assert.equal(okVersion.structuredContent.asset.parent_asset_id, "root");
});

test("a folder inside the library's own assets root imports directly", async (t) => {
  const { workspace, server } = await setupServer(t);
  const folder = join(workspace.libraryDir, "assets", "handoff");
  await writePngFixture(join(folder, "staged.png"), { color: "#3f3f8f" });

  const result = await server.callToolStrict("asset_import_folder", { folderPath: folder });
  assert.equal(result.structuredContent.imported, 1);
  assert.equal(server.responses.some((message) => typeof message.method === "string"), false);
});
