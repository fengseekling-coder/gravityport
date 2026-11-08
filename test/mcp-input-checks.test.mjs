// Task 375: MCP input vetting.
//
// - projectId is gone from every tool schema; a caller sending it gets either
//   silent normalization ("default", case-insensitive, empty) or
//   PROJECT_ID_NOT_SUPPORTED, and no new project is ever created.
// - Path arguments are vetted in the MCP layer: whitespace, file://, ~ and
//   relative paths answer INVALID_PATH with a reason, a folder answers
//   PATH_IS_FOLDER / PATH_IS_FILE, and Windows drive paths count as absolute.
// - Paths inside the GravityPort library (and folders containing it) refuse to
//   import with LIBRARY_INTERNAL_PATH.
// - asset_version_create accepts a replacement image from any local absolute
//   path (same rule as asset_create).
// - Unknown store error codes keep their original content; table-covered codes
//   get the Chinese line prepended.
// - user_prompt and negative_prompt are searchable, and a library whose
//   search-scope rebuild marker is one version behind rebuilds on open.

import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createAssetStore } from "../lib/asset-store.mjs";
import { SEARCH_SCOPE_MARKER_KEY } from "../lib/asset-search-scope.mjs";
import { createMcpWorkspace, startMcpServer, writePngFixture } from "./helpers/mcp-server-harness.mjs";

// The marker the PREVIOUS code version wrote; a library holding only this one
// still owes the rebuild (task 375 bumped the version).
const PREVIOUS_SCOPE_MARKER_KEY = "search_scope_v3";

function openDirectStore(workspace) {
  return createAssetStore({
    projectRoot: workspace.root,
    managerDir: workspace.root,
    libraryDir: workspace.libraryDir,
    explicitLibraryDir: workspace.libraryDir,
    assetsRoot: join(workspace.libraryDir, "assets"),
    generatedImagesDir: join(workspace.libraryDir, "imports"),
  });
}

function withRawDatabase(libraryDir, task) {
  const database = new Database(join(libraryDir, "mosa.db"));
  try {
    return task(database);
  } finally {
    database.close();
  }
}

function markerValue(libraryDir, key) {
  return withRawDatabase(libraryDir, (database) =>
    database.prepare("SELECT value FROM library_meta WHERE key = ?").get(key)?.value ?? null);
}

let colorIndex = 1;
async function createFixtureAsset(server, workspace, { prompt = "fixture image", ...fields } = {}) {
  const filePath = join(workspace.imagesDir, `asset-${colorIndex}.png`);
  colorIndex += 1;
  await writePngFixture(filePath, { color: `#${(colorIndex * 1357911).toString(16).slice(-6).padStart(6, "0")}` });
  const result = await server.callToolStrict("asset_create", { imagePath: filePath, prompt, ...fields });
  return result.structuredContent.asset;
}

async function libraryAssetCount(server) {
  const listed = await server.callToolStrict("asset_list", { limit: 250 });
  return listed.structuredContent.page?.total ?? listed.structuredContent.assets.length;
}

test("1. no tool declares projectId in its input schema", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const response = await server.request("tools/list", {});
  const tools = response.result.tools;
  assert.ok(tools.length >= 25, `expected the full tool set, got ${tools.length}`);
  for (const tool of tools) {
    const properties = tool.inputSchema?.properties || {};
    assert.equal(Object.hasOwn(properties, "projectId"), false, `${tool.name} must not declare projectId`);
  }
});

test("2. projectId default/DEFAULT/empty pass, other values refuse with PROJECT_ID_NOT_SUPPORTED and no new project appears", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  for (const value of ["default", "DEFAULT", ""]) {
    const listed = await server.callToolStrict("asset_list", { projectId: value, limit: 5 });
    assert.equal(Array.isArray(listed.structuredContent.assets), true, `projectId ${JSON.stringify(value)} answered normally`);
  }

  const refused = await server.callTool("asset_list", { projectId: "proj-x", limit: 5 });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.error.code, "PROJECT_ID_NOT_SUPPORTED");
  assert.equal(
    refused.content[0].text,
    "GravityPort 只有一个素材库，不用传 projectId；要分类请用 group 或 tags。/ GravityPort has a single library; omit projectId and use group or tags to organize.",
  );

  const direct = openDirectStore(workspace);
  t.after(() => direct.close());
  assert.deepEqual(await direct.listProjects(), ["default"], "no project was created behind the user's back");
});

test("3. the four path shapes answer INVALID_PATH with a reason, folders answer PATH_IS_FOLDER / PATH_IS_FILE", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);
  const realImage = await writePngFixture(join(workspace.imagesDir, "lantern.png"), { color: "#31506f" });

  const cases = [
    {
      name: "trailing whitespace",
      args: { imagePath: `${realImage} ` },
      reason: "whitespace",
      zh: "路径开头或末尾有空格，请去掉。",
      en: "The path has leading or trailing spaces; remove them.",
    },
    {
      name: "file:// prefix",
      args: { imagePath: `file://${realImage}` },
      reason: "file_url",
      zh: "请去掉 file://，直接用完整路径。",
      en: "Drop the file:// prefix and pass a plain absolute path.",
    },
    {
      name: "tilde",
      args: { imagePath: "~/Pictures/lantern.png" },
      reason: "tilde",
      zh: "不支持 ~，请写出完整路径（如 /Users/…）。",
      en: "~ is not expanded; pass the full absolute path.",
    },
    {
      name: "relative image path",
      args: { imagePath: "fixtures/lantern.png" },
      reason: "relative",
      zh: "请用完整（绝对）路径。",
      en: "Use an absolute path.",
    },
    {
      name: "relative folder path",
      args: { folderPath: "fixtures/folder" },
      tool: "asset_import_folder",
      reason: "relative",
      zh: "请用完整（绝对）路径。",
      en: "Use an absolute path.",
    },
  ];

  for (const { name, args, tool = "asset_create", reason, zh, en } of cases) {
    const result = await server.callTool(tool, args);
    assert.equal(result.isError, true, `${name} must fail`);
    assert.equal(result.structuredContent.error.code, "INVALID_PATH", name);
    assert.equal(result.structuredContent.error.reason, reason, name);
    const lines = result.content[0].text.split("\n");
    assert.equal(lines[0], zh, `${name}: first line is the Chinese sentence`);
    assert.equal(lines[1], en, `${name}: second line is the original English sentence`);
  }

  const folderTarget = join(workspace.imagesDir, "not-a-file");
  await mkdir(folderTarget, { recursive: true });
  const folderResult = await server.callTool("asset_create", { imagePath: folderTarget, prompt: "must not import" });
  assert.equal(folderResult.isError, true);
  assert.equal(folderResult.structuredContent.error.code, "PATH_IS_FOLDER");
  assert.equal(folderResult.content[0].text, "这是文件夹，请用 asset_import_folder。/ This is a folder; use asset_import_folder.");

  const fileResult = await server.callTool("asset_import_folder", { folderPath: realImage });
  assert.equal(fileResult.isError, true);
  assert.equal(fileResult.structuredContent.error.code, "PATH_IS_FILE");
  assert.equal(fileResult.content[0].text, "这是文件，请用 asset_create。/ This is a file; use asset_create.");

  // A Windows drive path is absolute (win32.isAbsolute), so the MCP layer does
  // not answer INVALID_PATH/relative — the store then answers with its own
  // file-not-found error for a path that does not exist on this machine.
  const windows = await server.callTool("asset_create", { imagePath: "C:\\Users\\someone\\Pictures\\lantern.png", prompt: "windows shape" });
  assert.equal(windows.isError, true);
  assert.equal(windows.structuredContent.error.code, "IMAGE_PATH_NOT_FOUND");
  assert.notEqual(windows.structuredContent.error.code, "INVALID_PATH");
  assert.equal(windows.content[0].text.split("\n")[0], "找不到这个文件，请确认路径写对了。");
});

test("4. library-internal folders, folders containing the library, and library images refuse with LIBRARY_INTERNAL_PATH", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const existing = await createFixtureAsset(server, workspace, { prompt: "already in library" });
  const before = await libraryAssetCount(server);

  const insideFolder = join(workspace.libraryDir, "probe-export");
  await mkdir(insideFolder, { recursive: true });
  await writePngFixture(join(insideFolder, "inside.png"), { color: "#5f3f1f" });

  const folderInside = await server.callTool("asset_import_folder", { folderPath: insideFolder, recursive: true });
  assert.equal(folderInside.isError, true);
  assert.equal(folderInside.structuredContent.error.code, "LIBRARY_INTERNAL_PATH");
  assert.equal(
    folderInside.content[0].text,
    "这是素材库自己的文件夹，不能再导进来。/ This path is inside the GravityPort library and cannot be imported.",
  );

  // The workspace root contains the library; a recursive scan would sweep it in.
  const folderAround = await server.callTool("asset_import_folder", { folderPath: workspace.root, recursive: true });
  assert.equal(folderAround.isError, true);
  assert.equal(folderAround.structuredContent.error.code, "LIBRARY_INTERNAL_PATH");

  const imageInside = await server.callTool("asset_create", { imagePath: existing.image_path, prompt: "re-import the stored original" });
  assert.equal(imageInside.isError, true);
  assert.equal(imageInside.structuredContent.error.code, "LIBRARY_INTERNAL_PATH");

  const versionInside = await server.callTool("asset_version_create", {
    assetId: existing.id,
    imagePath: existing.image_path,
    version_change: "must not re-import a library file",
  });
  assert.equal(versionInside.isError, true);
  assert.equal(versionInside.structuredContent.error.code, "LIBRARY_INTERNAL_PATH");

  assert.equal(await libraryAssetCount(server), before, "the library gained no asset");

  // The one library-internal exemption is the store's own staged-images root
  // (generatedImagesDir): with a copied desktop config that is
  // <library>/imports, and test/mcp-desktop-mode.test.mjs keeps importing from
  // there. In this hand-written-config workspace the staging root is
  // imagesDir (outside the library), so nothing library-internal imports.
});

test("5. error codes outside the bilingual table keep their original content", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const a = await createFixtureAsset(server, workspace, { prompt: "stack member a" });
  const b = await createFixtureAsset(server, workspace, { prompt: "stack member b" });

  const result = await server.callTool("stack_create", { assetIds: [a.id, b.id], name: "   " });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "STACK_NAME_EMPTY");
  assert.equal(result.content[0].text, "Stack name cannot be empty.");
});

test("6. asset_version_create accepts a replacement image from the temporary HOME's Downloads", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const parent = await createFixtureAsset(server, workspace, { prompt: "parent poster" });
  // The harness pins HOME to workspace.root, so this is <temp HOME>/Downloads.
  const downloads = join(workspace.root, "Downloads");
  await mkdir(downloads, { recursive: true });
  const replacement = await writePngFixture(join(downloads, "v1.png"), { color: "#7f3f00" });

  const version = await server.callToolStrict("asset_version_create", {
    assetId: parent.id,
    imagePath: replacement,
    version_change: "换成暖色调",
    prompt: "warm version",
  });
  // The store copies the bytes into the library, so image_path is the managed
  // file; the point here is that a ~/Downloads image no longer refuses.
  assert.equal(version.structuredContent.asset.parent_asset_id, parent.id);
});

test("7. user_prompt and negative_prompt are searchable right after creation", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const asset = await createFixtureAsset(server, workspace, {
    prompt: "a lighthouse poster, dramatic lighting",
    user_prompt: "画一张红色的灯塔海报",
    negative_prompt: "blurry, low quality",
  });

  for (const query of ["红色的灯塔", "blurry"]) {
    const found = await server.callToolStrict("asset_search", { query, limit: 20 });
    const ids = (found.structuredContent.results || []).map((entry) => entry.asset?.id);
    assert.ok(ids.includes(asset.id), `query ${JSON.stringify(query)} finds the asset`);
  }
});

test("8. a library whose search-scope marker is one version behind rebuilds on open and becomes searchable", async (t) => {
  const workspace = await createMcpWorkspace(t);

  const seeder = openDirectStore(workspace);
  const legacyImage = await writePngFixture(join(workspace.imagesDir, "legacy.png"), { color: "#3f5f7f" });
  const created = await seeder.createAsset({
    imagePath: legacyImage,
    prompt: "effective legacy prompt",
    user_prompt: "画一张红色的灯塔海报",
    negative_prompt: "blurry, low quality",
  });
  await seeder.startDeferredMaintenance();
  seeder.close();
  assert.ok(markerValue(workspace.libraryDir, SEARCH_SCOPE_MARKER_KEY), "the fresh library finished the current rebuild");

  // Rewind the library to the previous code version: the searchable text has
  // no user_prompt / negative_prompt, and only the old marker is present.
  withRawDatabase(workspace.libraryDir, (database) => {
    database.transaction(() => {
      database.prepare("UPDATE assets SET search_text = ? WHERE id = ?").run("effective legacy prompt", created.id);
      database.prepare("DELETE FROM asset_search_terms WHERE doc_id IN (SELECT doc_id FROM asset_search_docs WHERE asset_id = ?)").run(created.id);
      // The trigram index is where search finds its candidates, so it has to
      // hold the old text too; otherwise the asset stays findable without any
      // rebuild and this test proves nothing.
      const { doc_id: docId } = database.prepare("SELECT doc_id FROM asset_search_docs WHERE asset_id = ?").get(created.id);
      database.prepare("DELETE FROM asset_fts WHERE rowid = ?").run(docId);
      database.prepare("INSERT INTO asset_fts (rowid, project_id, asset_id, content) VALUES (?, ?, ?, ?)")
        .run(docId, "default", created.id, "effective legacy prompt");
      database.prepare("DELETE FROM library_meta WHERE key = ?").run(SEARCH_SCOPE_MARKER_KEY);
      database.prepare("INSERT INTO library_meta (key, value, updated_at) VALUES (?, ?, ?)")
        .run(PREVIOUS_SCOPE_MARKER_KEY, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    })();
  });

  const reopened = openDirectStore(workspace);
  t.after(() => reopened.close());
  for (const query of ["红色的灯塔", "blurry"]) {
    const found = await reopened.listAssets({ projectId: "default", query });
    assert.ok(!found.some((asset) => asset.id === created.id), `before the rebuild, query ${JSON.stringify(query)} does not find the asset yet`);
  }
  await reopened.startDeferredMaintenance();
  assert.ok(markerValue(workspace.libraryDir, SEARCH_SCOPE_MARKER_KEY), "the rebuild ran to the current version");

  for (const query of ["红色的灯塔", "blurry"]) {
    const found = await reopened.listAssets({ projectId: "default", query });
    assert.ok(found.some((asset) => asset.id === created.id), `after the rebuild, query ${JSON.stringify(query)} finds the asset`);
  }
});
