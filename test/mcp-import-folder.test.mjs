import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LIBRARY_DIR_NAME } from "../lib/library-location.mjs";
import { createAssetStore } from "../lib/asset-store.mjs";
import { removeTestPath } from "./test-cleanup.mjs";
import { createMcpWorkspace, spawnMcpServerAsClient, startMcpServer, writePngFixture } from "./helpers/mcp-server-harness.mjs";

const ELICIT_CLIENT = { capabilities: { elicitation: {} } };

async function setupServer(t, { elicitation = false, env: extraEnv = {} } = {}) {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace, { env: extraEnv });
  await server.request("initialize", elicitation ? ELICIT_CLIENT : {});
  return { workspace, server };
}

function assertImportError(result, code) {
  assert.equal(result.isError, true, "the failure is a tool-level isError result");
  assert.equal(result.structuredContent?.error?.code, code);
}

test("source mode: a file in the working directory is rejected with asset_import_folder guidance", async (t) => {
  const { workspace, server } = await setupServer(t);
  const imagePath = await writePngFixture(join(workspace.root, "stray.png"));

  const result = await server.callTool("asset_create", { assetId: "stray", imagePath, prompt: "must not land" });
  assertImportError(result, "IMAGE_PATH_NOT_READABLE");
  assert.match(result.content[0].text, /asset_import_folder/);

  const list = await server.callToolStrict("asset_list", {});
  assert.equal(list.structuredContent.assets.length, 0);
});

test("desktop mode (location file): a file next to the client is rejected the same way", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-mcp-folder-desktop-"));
  t.after(() => removeTestPath(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const userData = join(home, "Library", "Application Support", "mosa");
  const clientCwd = join(root, "client-cwd");
  const libraryDir = join(home, LIBRARY_DIR_NAME);
  await mkdir(userData, { recursive: true });
  await mkdir(clientCwd, { recursive: true });
  const locationFile = join(userData, "library-location.json");
  await writeFile(locationFile, `${JSON.stringify({ path: libraryDir })}\n`);
  const seedStore = createAssetStore({
    projectRoot: root,
    managerDir: root,
    libraryDir,
    explicitLibraryDir: libraryDir,
    assetsRoot: join(libraryDir, "assets"),
    generatedImagesDir: join(libraryDir, "imports"),
  });
  seedStore.close();
  const imagePath = await writePngFixture(join(clientCwd, "stray.png"));

  // cwd is the hole this test probes: without the 334 switch the assistant's
  // own working directory is a trusted root, so the stray file would import.
  const server = spawnMcpServerAsClient(t, {
    args: [resolve(import.meta.dirname, "..", "mcp", "server.mjs")],
    cwd: clientCwd,
    env: { ...process.env, HOME: home, GRAVITYPORT_LIBRARY_LOCATION_FILE: locationFile },
  });
  await server.request("initialize", ELICIT_CLIENT);
  const result = await server.callTool("asset_create", { assetId: "stray", imagePath, prompt: "must not land" });
  assertImportError(result, "IMAGE_PATH_NOT_READABLE");
  assert.match(result.content[0].text, /asset_import_folder/);
});

test("elicitation accept imports the folder; recursive stays off by default", async (t) => {
  const { workspace, server } = await setupServer(t, { elicitation: true });
  const folder = join(workspace.root, "mixed");
  await writePngFixture(join(folder, "top.png"), { color: "#31708f" });
  await writePngFixture(join(folder, "nested", "deep.png"), { color: "#7a3c47" });

  const resultPromise = server.callTool("asset_import_folder", { folderPath: folder, prompt: "folder drop" });
  const request = await server.waitForServerRequest("elicitation/create");
  assert.match(request.id, /^gp-elicit-/);
  assert.match(request.params.message, /要从 .*mixed 导入 1 张图片和视频到 GravityPort 素材库吗？/);
  assert.deepEqual(request.params.requestedSchema, {
    type: "object",
    properties: { allow: { type: "boolean", title: "允许导入" } },
    required: ["allow"],
  });
  server.respond(request.id, { action: "accept", content: { allow: true } });

  const result = await resultPromise;
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  assert.equal(result.structuredContent.imported, 1);
  assert.equal(result.structuredContent.deduplicated, 0);
  assert.equal(result.structuredContent.failed, 0);
  assert.deepEqual(result.structuredContent.failures, []);
  assert.equal(result.structuredContent.assetIds.length, 1);
  const fetched = await server.callToolStrict("asset_get", { assetId: result.structuredContent.assetIds[0] });
  assert.equal(fetched.structuredContent.asset.prompt, "folder drop");

  // recursive defaults to false: the nested file was never offered. The
  // confirmation is never remembered, so the second call asks again.
  const secondResultPromise = server.callTool("asset_import_folder", { folderPath: folder, recursive: true });
  const secondRequest = await server.waitForServerRequest("elicitation/create", { minimumCount: 2 });
  server.respond(secondRequest.id, { action: "accept", content: { allow: true } });
  const recursiveResult = await secondResultPromise;
  const list = await server.callToolStrict("asset_list", {});
  assert.equal(list.structuredContent.assets.length, 2);
  assert.equal(recursiveResult.structuredContent.imported, 1);
});

test("recursive:true announces subfolders and imports them", async (t) => {
  const { workspace, server } = await setupServer(t, { elicitation: true });
  const folder = join(workspace.root, "tree");
  await writePngFixture(join(folder, "nested", "deep.png"), { color: "#4a6d3c" });

  const resultPromise = server.callTool("asset_import_folder", { folderPath: folder, recursive: true });
  const request = await server.waitForServerRequest("elicitation/create");
  assert.match(request.params.message, /（含子文件夹）/);
  server.respond(request.id, { action: "accept", content: { allow: true } });
  const result = await resultPromise;
  assert.equal(result.structuredContent.imported, 1);
});

async function expectRefusal(t, reply) {
  const { workspace, server } = await setupServer(t, { elicitation: true });
  const folder = join(workspace.root, "batch");
  const imagePath = await writePngFixture(join(folder, "one.png"), { color: "#8f3170" });

  const resultPromise = server.callTool("asset_import_folder", { folderPath: folder });
  const request = await server.waitForServerRequest("elicitation/create");
  server.respond(request.id, reply);
  const result = await resultPromise;
  assertImportError(result, "IMPORT_NOT_CONFIRMED");
  assert.match(result.structuredContent.error.message, /drag the images into GravityPort/);
  const list = await server.callToolStrict("asset_list", {});
  assert.equal(list.structuredContent.assets.length, 0);
  assert.ok(await readFile(imagePath), "the source file is untouched");
}

test("an elicitation decline imports nothing", async (t) => {
  await expectRefusal(t, { action: "decline" });
});

test("an elicitation cancel imports nothing", async (t) => {
  await expectRefusal(t, { action: "cancel" });
});

test("an accept without allow:true imports nothing", async (t) => {
  await expectRefusal(t, { action: "accept", content: { allow: false } });
});

test("a client without elicitation support gets IMPORT_NOT_CONFIRMED without being asked", async (t) => {
  const { workspace, server } = await setupServer(t, { elicitation: false });
  const folder = join(workspace.root, "batch");
  await writePngFixture(join(folder, "one.png"), { color: "#3c8f31" });

  const result = await server.callTool("asset_import_folder", { folderPath: folder });
  assertImportError(result, "IMPORT_NOT_CONFIRMED");
  assert.equal(server.responses.some((message) => message.method === "elicitation/create"), false);
  const list = await server.callToolStrict("asset_list", {});
  assert.equal(list.structuredContent.assets.length, 0);
});

test("a timed-out confirmation is refused and a late reply is dropped silently", async (t) => {
  const { workspace, server } = await setupServer(t, { elicitation: true, env: { MOSA_MCP_ELICIT_TIMEOUT_MS: "120" } });
  const folder = join(workspace.root, "batch");
  await writePngFixture(join(folder, "one.png"), { color: "#8f8231" });

  const requestPromise = server.waitForServerRequest("elicitation/create");
  const result = await server.callTool("asset_import_folder", { folderPath: folder });
  assertImportError(result, "IMPORT_NOT_CONFIRMED");
  const list = await server.callToolStrict("asset_list", {});
  assert.equal(list.structuredContent.assets.length, 0);

  // The user answers after the server gave up: the reply must be dropped
  // without a "Method not found" error or any stderr noise.
  const request = await requestPromise;
  server.respond(request.id, { action: "accept", content: { allow: true } });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
  assert.equal(server.stderr, "");
  assert.equal(server.responses.some((message) => message.error?.code === -32601), false);
  assert.deepEqual((await server.request("ping")).result, {});
});

test("a folder inside the Codex generated images root imports without confirmation", async (t) => {
  const { workspace, server } = await setupServer(t, { elicitation: true });
  const folder = join(workspace.imagesDir, "batch");
  await writePngFixture(join(folder, "gen.png"), { color: "#31458f" });

  const result = await server.callTool("asset_import_folder", { folderPath: folder, prompt: "codex batch" });
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  assert.equal(result.structuredContent.imported, 1);
  assert.equal(server.responses.some((message) => message.method === "elicitation/create"), false);
});

test("recursive walks at most 5 layers and skips symbolic links and other file types", async (t) => {
  const { workspace, server } = await setupServer(t, { elicitation: true });
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

  const resultPromise = server.callTool("asset_import_folder", { folderPath: folder, recursive: true });
  const request = await server.waitForServerRequest("elicitation/create");
  assert.match(request.params.message, /另有 3 个文件会跳过。/);
  server.respond(request.id, { action: "accept", content: { allow: true } });
  const result = await resultPromise;
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  // top.png + depth5.png; depth6.png sits in layer 6 and the two symlinks
  // (file and folder) were never followed.
  assert.equal(result.structuredContent.imported, 2);
  assert.equal(result.structuredContent.skipped, 3);
  const list = await server.callToolStrict("asset_list", {});
  assert.equal(list.structuredContent.assets.length, 2);
});

test("a batch over the cap fails before asking and imports nothing", async (t) => {
  const { workspace, server } = await setupServer(t, {
    elicitation: true,
    env: { MOSA_MCP_IMPORT_FOLDER_MAX_FILES: "2" },
  });
  const folder = join(workspace.root, "big");
  await writePngFixture(join(folder, "a.png"), { color: "#111111" });
  await writePngFixture(join(folder, "b.png"), { color: "#222222" });
  await writePngFixture(join(folder, "c.png"), { color: "#333333" });

  const result = await server.callTool("asset_import_folder", { folderPath: folder });
  assertImportError(result, "IMPORT_FOLDER_TOO_LARGE");
  assert.equal(server.responses.some((message) => message.method === "elicitation/create"), false);
  const list = await server.callToolStrict("asset_list", {});
  assert.equal(list.structuredContent.assets.length, 0);
});

test("an empty folder answers with zero counts and never asks", async (t) => {
  const { workspace, server } = await setupServer(t, { elicitation: true });
  const folder = join(workspace.root, "empty");
  await mkdir(folder, { recursive: true });

  const result = await server.callTool("asset_import_folder", { folderPath: folder });
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  assert.deepEqual(result.structuredContent, { imported: 0, deduplicated: 0, skipped: 0, failed: 0, assetIds: [], failures: [] });
  assert.equal(server.responses.some((message) => message.method === "elicitation/create"), false);
});

test("identical bytes already in the library count as deduplicated", async (t) => {
  const { workspace, server } = await setupServer(t, { elicitation: true });
  const known = await writePngFixture(join(workspace.imagesDir, "known.png"), { color: "#7c318f" });
  await server.callToolStrict("asset_create", { assetId: "known", imagePath: known });
  const folder = join(workspace.root, "dup");
  await mkdir(folder, { recursive: true });
  await copyFile(known, join(folder, "copy-of-known.png"));
  await writePngFixture(join(folder, "fresh.png"), { color: "#8f7c31" });

  const resultPromise = server.callTool("asset_import_folder", { folderPath: folder });
  const request = await server.waitForServerRequest("elicitation/create");
  server.respond(request.id, { action: "accept", content: { allow: true } });
  const result = await resultPromise;
  assert.equal(result.structuredContent.imported, 1);
  assert.equal(result.structuredContent.deduplicated, 1);
  assert.equal(result.structuredContent.assetIds.length, 1);
  const list = await server.callToolStrict("asset_list", {});
  assert.equal(list.structuredContent.assets.length, 2);
});

test("a failed file is reported and does not stop the rest", async (t) => {
  const { workspace, server } = await setupServer(t, { elicitation: true });
  const folder = join(workspace.root, "mixed-health");
  const readable = await writePngFixture(join(folder, "readable.png"), { color: "#318f7c" });
  const unreadable = await writePngFixture(join(folder, "unreadable.png"), { color: "#8f3131" });
  await chmod(unreadable, 0o000);
  t.after(() => chmod(unreadable, 0o644).catch(() => {}));

  const resultPromise = server.callTool("asset_import_folder", { folderPath: folder });
  const request = await server.waitForServerRequest("elicitation/create");
  server.respond(request.id, { action: "accept", content: { allow: true } });
  const result = await resultPromise;
  assert.equal(result.structuredContent.imported, 1);
  assert.equal(result.structuredContent.failed, 1);
  assert.deepEqual(result.structuredContent.failures, [{ file: "unreadable.png", code: "EACCES" }]);
  assert.ok(await readFile(readable));
});

test("missing and non-directory folderPath fail without asking", async (t) => {
  const { workspace, server } = await setupServer(t, { elicitation: true });
  const missing = await server.callTool("asset_import_folder", { folderPath: join(workspace.root, "nope") });
  assertImportError(missing, "IMPORT_FOLDER_NOT_FOUND");
  const file = await writePngFixture(join(workspace.imagesDir, "plain.png"));
  const notDirectory = await server.callTool("asset_import_folder", { folderPath: file });
  assertImportError(notDirectory, "IMPORT_FOLDER_NOT_DIRECTORY");
  const relativePath = await server.callTool("asset_import_folder", { folderPath: "some/relative/folder" });
  assertImportError(relativePath, "IMPORT_FOLDER_NOT_ABSOLUTE");
  assert.equal(server.responses.some((message) => message.method === "elicitation/create"), false);
});

test("the confirmation names the resolved folder, not a symlinked or dotted spelling", async (t) => {
  const { workspace, server } = await setupServer(t, { elicitation: true });
  const realFolder = join(workspace.root, "real-folder");
  await writePngFixture(join(realFolder, "one.png"), { color: "#4a6f31" });
  const linkFolder = join(workspace.root, "innocent-link");
  await symlink(realFolder, linkFolder, "dir");

  const viaLink = server.callTool("asset_import_folder", { folderPath: join(linkFolder, "..", "innocent-link") });
  const request = await server.waitForServerRequest("elicitation/create");
  assert.match(request.params.message, /real-folder 导入 1 张/);
  assert.doesNotMatch(request.params.message, /innocent-link|\.\./);
  server.respond(request.id, { action: "decline" });
  assertImportError(await viaLink, "IMPORT_NOT_CONFIRMED");
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

test("a folder inside the library's own assets root imports without confirmation", async (t) => {
  const { workspace, server } = await setupServer(t, { elicitation: true });
  const folder = join(workspace.libraryDir, "assets", "handoff");
  await writePngFixture(join(folder, "staged.png"), { color: "#3f3f8f" });

  const result = await server.callTool("asset_import_folder", { folderPath: folder });
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  assert.equal(result.structuredContent.imported, 1);
  assert.equal(server.responses.some((message) => message.method === "elicitation/create"), false);
});

test("a file removed between scan and import only fails its own entry", async (t) => {
  const { workspace, server } = await setupServer(t, { elicitation: true });
  const folder = join(workspace.root, "vanish");
  await writePngFixture(join(folder, "stays.png"), { color: "#315f8f" });
  await writePngFixture(join(folder, "vanishes.png"), { color: "#8f5f31" });

  const resultPromise = server.callTool("asset_import_folder", { folderPath: folder });
  const request = await server.waitForServerRequest("elicitation/create");
  // The scan has finished once the confirmation is out (the ask happens after
  // the walk), so removing a scanned file now must surface as one failed
  // entry, not a broken call.
  await rm(join(folder, "vanishes.png"), { force: true });
  server.respond(request.id, { action: "accept", content: { allow: true } });
  const result = await resultPromise;
  assert.equal(result.structuredContent.imported, 1);
  assert.equal(result.structuredContent.failed, 1);
  assert.deepEqual(result.structuredContent.failures.map((entry) => entry.file), ["vanishes.png"]);
});
