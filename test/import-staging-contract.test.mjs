import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import {
  cleanupOrphanStagedFiles,
  ImportStagingError,
  importStagingDir,
  isWithinStagingRoot,
  removeStagedImport,
  STAGING_EXTENSIONS,
  stageFileForImport,
  stageReadableForImport,
  writeStagedPng,
} from "../lib/import-staging.mjs";
import { SUPPORTED_MEDIA_EXTENSIONS } from "../lib/asset-store.mjs";

const root = resolve(import.meta.dirname, "..");
const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function makeWorkspace(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(dir, { recursive: true, force: true });
  return dir;
}

async function writeFixture(dir, name, bytes = ONE_PIXEL_PNG) {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

async function waitFor(condition, timeoutMs = 3000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, stepMs));
  }
  throw new Error("waitFor timed out");
}

function assertStagingError(error, code) {
  assert.ok(error instanceof ImportStagingError, `expected ImportStagingError, got ${error?.constructor?.name}`);
  assert.equal(error.code, code);
}

// ── pure helper contract ──────────────────────────────────────────────────────

test("external plain PNG is copied into the staging root (original untouched)", async (t) => {
  const dir = await makeWorkspace(t, "mosa-stage-copy-");
  const sourcePath = await writeFixture(dir, "original.png");
  const stagingRoot = importStagingDir(join(dir, "userData"));
  const staged = await stageFileForImport({ sourcePath, stagingRoot });

  assert.ok(isWithinStagingRoot(stagingRoot, staged), "staged path must be inside the staging root");
  assert.equal(sha256(await readFile(staged)), sha256(ONE_PIXEL_PNG), "staged copy must match source bytes");
  assert.equal(sha256(await readFile(sourcePath)), sha256(ONE_PIXEL_PNG), "original must be untouched");
  assert.equal(existsSync(sourcePath), true);
});

test("browser upload bytes stream into generated staging without a local path", async (t) => {
  const dir = await makeWorkspace(t, "mosa-stage-stream-");
  const stagingRoot = importStagingDir(join(dir, "library", "assets"));
  const staged = await stageReadableForImport({
    readable: Readable.from([ONE_PIXEL_PNG]),
    fileName: "picked.png",
    stagingRoot,
  });

  assert.ok(isWithinStagingRoot(stagingRoot, staged));
  assert.match(basename(staged), /^import-\d+-[0-9a-f]{8}\.png$/);
  assert.equal(sha256(await readFile(staged)), sha256(ONE_PIXEL_PNG));
});

test("browser upload streaming enforces the byte cap and removes partial output", async (t) => {
  const dir = await makeWorkspace(t, "mosa-stage-stream-limit-");
  const stagingRoot = importStagingDir(join(dir, "library", "assets"));
  await assert.rejects(
    () => stageReadableForImport({
      readable: Readable.from([Buffer.alloc(8)]),
      fileName: "too-large.png",
      stagingRoot,
      maxBytes: 4,
    }),
    (error) => { assertStagingError(error, "STAGING_FILE_TOO_LARGE"); return true; },
  );
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(stagingRoot), [], "failed upload must not leave a partial staging file");
});

test("staged file name is generated, unique, and cannot traverse directories", async (t) => {
  const dir = await makeWorkspace(t, "mosa-stage-name-");
  const sourcePath = await writeFixture(dir, "name.png");
  const stagingRoot = importStagingDir(join(dir, "userData"));
  const names = new Set();
  for (let i = 0; i < 5; i += 1) {
    const staged = await stageFileForImport({ sourcePath, stagingRoot });
    const name = basename(staged);
    assert.equal(name, staged.slice(stagingRoot.length + 1), "target name must be a plain basename");
    assert.ok(!name.includes(sep) && !name.includes(".."), "target name must not contain path separators");
    assert.match(name, /^import-\d+-[0-9a-f]{8}\.png$/);
    names.add(name);
  }
  assert.equal(names.size, 5, "concurrent same-ms stages must stay unique");
});

test("extension is preserved for supported media types", async (t) => {
  const dir = await makeWorkspace(t, "mosa-stage-ext-");
  const sourcePath = await writeFixture(dir, "photo.JPG");
  const staged = await stageFileForImport({ sourcePath, stagingRoot: importStagingDir(join(dir, "userData")) });
  assert.ok(staged.endsWith(".JPG") || staged.endsWith(".jpg"), "staged file must keep a supported extension");
});

test("symbolic links are rejected", async (t) => {
  const dir = await makeWorkspace(t, "mosa-stage-link-");
  const target = await writeFixture(dir, "target.png");
  const link = join(dir, "link.png");
  await symlink(target, link);
  await assert.rejects(
    stageFileForImport({ sourcePath: link, stagingRoot: importStagingDir(join(dir, "userData")) }),
    (error) => { assertStagingError(error, "STAGING_SOURCE_IS_SYMLINK"); return true; },
  );
});

test("directories are rejected", async (t) => {
  const dir = await makeWorkspace(t, "mosa-stage-dir-");
  const sourcePath = join(dir, "folder.png");
  await mkdir(sourcePath, { recursive: true });
  await assert.rejects(
    stageFileForImport({ sourcePath, stagingRoot: importStagingDir(join(dir, "userData")) }),
    (error) => { assertStagingError(error, "STAGING_SOURCE_NOT_FILE"); return true; },
  );
});

test("missing files are rejected", async (t) => {
  const dir = await makeWorkspace(t, "mosa-stage-missing-");
  await assert.rejects(
    stageFileForImport({ sourcePath: join(dir, "nope.png"), stagingRoot: importStagingDir(join(dir, "userData")) }),
    (error) => { assertStagingError(error, "STAGING_SOURCE_NOT_FOUND"); return true; },
  );
});

test("URL-like sources are rejected", async (t) => {
  const dir = await makeWorkspace(t, "mosa-stage-url-");
  await assert.rejects(
    stageFileForImport({ sourcePath: "http://example.com/a.png", stagingRoot: importStagingDir(join(dir, "userData")) }),
    (error) => { assertStagingError(error, "STAGING_URL_NOT_ALLOWED"); return true; },
  );
  await assert.rejects(
    stageFileForImport({ sourcePath: "file:///etc/hosts", stagingRoot: importStagingDir(join(dir, "userData")) }),
    (error) => { assertStagingError(error, "STAGING_URL_NOT_ALLOWED"); return true; },
  );
});

test("unsupported media types are rejected", async (t) => {
  const dir = await makeWorkspace(t, "mosa-stage-type-");
  const sourcePath = await writeFixture(dir, "note.txt", Buffer.from("hello"));
  await assert.rejects(
    stageFileForImport({ sourcePath, stagingRoot: importStagingDir(join(dir, "userData")) }),
    (error) => { assertStagingError(error, "STAGING_UNSUPPORTED_TYPE"); return true; },
  );
});

test("pasted PNG bytes land inside the same staging root with a unique name", async (t) => {
  const dir = await makeWorkspace(t, "mosa-stage-paste-");
  const stagingRoot = importStagingDir(join(dir, "userData"));
  const pasted = await writeStagedPng(stagingRoot, ONE_PIXEL_PNG);
  assert.ok(isWithinStagingRoot(stagingRoot, pasted), "paste must live inside the staging root");
  assert.ok(basename(pasted).startsWith("paste-"), "paste file must use the paste prefix");
  assert.ok(pasted.endsWith(".png"));
  const second = await writeStagedPng(stagingRoot, ONE_PIXEL_PNG);
  assert.notEqual(pasted, second, "paste files must stay unique");
});

test("removeStagedImport deletes only plain files inside the exact staging root", async (t) => {
  const dir = await makeWorkspace(t, "mosa-stage-remove-");
  const userDataDir = join(dir, "userData");
  const stagingRoot = importStagingDir(userDataDir);
  const sourcePath = await writeFixture(dir, "original.png");
  const staged = await stageFileForImport({ sourcePath, stagingRoot });
  const outside = await writeFixture(userDataDir, "other.png");

  assert.equal((await removeStagedImport(stagingRoot, staged)).ok, true);
  assert.equal(existsSync(staged), false, "staged copy must be removed");
  assert.equal(existsSync(sourcePath), true, "user original must never be deleted");
  assert.equal(existsSync(outside), true, "files outside staging must never be deleted");

  const result = await removeStagedImport(stagingRoot, outside);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "outside-staging");
  assert.equal(existsSync(outside), true);
});

test("removeStagedImport refuses symlinks even when placed inside the staging root", async (t) => {
  const dir = await makeWorkspace(t, "mosa-stage-remove-link-");
  const stagingRoot = importStagingDir(join(dir, "userData"));
  const target = await writeFixture(dir, "target.png");
  const link = join(stagingRoot, "import-link.png");
  await mkdir(stagingRoot, { recursive: true });
  await symlink(target, link);
  const result = await removeStagedImport(stagingRoot, link);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-plain-file");
  assert.equal(existsSync(target), true);
});

test("orphan sweep removes only stale plain files inside the staging root", async (t) => {
  const dir = await makeWorkspace(t, "mosa-stage-orphan-");
  const userDataDir = join(dir, "userData");
  const stagingRoot = importStagingDir(userDataDir);
  const now = Date.now();
  const fresh = await writeFixture(stagingRoot, "import-fresh.png");
  const stale = await writeFixture(stagingRoot, "import-stale.png");
  await writeFile(join(stagingRoot, "import-stale-2.png"), ONE_PIXEL_PNG);
  await utimes(stale, new Date(now - 3_600_000), new Date(now - 3_600_000));
  await utimes(join(stagingRoot, "import-stale-2.png"), new Date(now - 3_600_000), new Date(now - 3_600_000));
  const outside = await writeFixture(userDataDir, "outside-old.png");
  await utimes(outside, new Date(now - 3_600_000), new Date(now - 3_600_000));
  const dirEntry = join(stagingRoot, "keep-dir");
  await mkdir(dirEntry, { recursive: true });

  const result = await cleanupOrphanStagedFiles(stagingRoot, { ttlMs: 60_000, now: () => now });
  assert.equal(result.removed, 2, "only the two stale plain files are removed");
  assert.equal(result.failed, 0);
  assert.equal(existsSync(fresh), true, "fresh staged file must survive");
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(dirEntry), true, "directories must never be removed");
  assert.equal(existsSync(outside), true, "staging-adjacent files must never be removed");
});

test("cleanupOrphanStagedFiles tolerates a missing staging root", async () => {
  const result = await cleanupOrphanStagedFiles(join(await mkdtemp(join(tmpdir(), "mosa-stage-missing-root-")), "never-created"));
  assert.deepEqual(result, { removed: 0, failed: 0 });
});

test("preload surface and Electron security boundaries stay narrowly approved", async () => {
  const preload = await readFile(join(root, "desktop", "preload.cjs"), "utf8");
  const exposed = [...preload.matchAll(/^\s{2}(\w+):/gm)].map((match) => match[1]).sort();
  assert.deepEqual(exposed, [
    "acknowledgeRenameNotice",
    "cancelUpdateDownload",
    "cancelVisualPackInstall",
    "changeLibraryLocation",
    "checkForUpdates",
    "downloadAndInstallUpdate",
    "getMcpClientConfig", // 任务 208：只读，本机 App 路径拼成的 MCP 配置文本
    "getRenameNoticeState",
    "getUserProfile",
    "getVisualModelState",
    "installVisualPack",
    "libraryFileFlags", // drop-back guard: which dropped files already live in the library (booleans only)
    "onMenuSearch",
    "onUpdateDownloadProgress",
    "onVisualPackProgress",
    "onWindowFullScreenChange",
    "openDownloadPage",
    "openExternalLink", // 任务 147：第 22 条 open-external-link（Pinterest Pin 外链，仅 http/https）
    "openPinterestAuthorize", // 任务 135：第 21 条 open-pinterest-authorize（Pinterest 授权页，只放行 https://www.pinterest.com/oauth/）
    "pasteImage",
    "removeVisualPack",
    "reportRendererReady",
    "setLocale",
    "setVisualModelEnabled",
    "setWindowFullScreen",
    "startNativeDrag",
    "writeClipboardFiles",
    "writeClipboardImage",
    "writeClipboardText",
  ], "electronAPI surface must match the approved narrow desktop capabilities");

  const main = await readFile(join(root, "desktop", "main.mjs"), "utf8");
  assert.doesNotMatch(main, /ipcMain\.handle\("show-item-in-folder"/, "retired Finder IPC must stay removed");
  assert.match(main, /contextIsolation: true/, "contextIsolation must remain");
  assert.match(main, /nodeIntegration: false/, "nodeIntegration must remain disabled");
  assert.match(main, /sandbox: true/, "sandbox must remain enabled");
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)/, "window open handler must stay deny");
});

// ── runtime integration: trust boundary and cleanup ──────────────────────────

async function startAuditRuntime(t, { userDataDir, withStagingRoot }) {
  const libraryDir = join(userDataDir, "library");
  const projectRoot = join(userDataDir, "project");
  await mkdir(projectRoot, { recursive: true });
  const runtime = await startMosaRuntime({
    port: 0,
    libraryDir,
    projectRoot,
    managerDir: userDataDir,
    appDir: join(userDataDir, "app"),
    assetsRoot: join(libraryDir, "assets"),
    generatedImagesDir: join(libraryDir, "imports"),
    disabledBridges: ["cowart", "cowartDiscovery", "codex", "grok"],
    importStagingRoot: withStagingRoot ? importStagingDir(userDataDir) : null,
  });
  t.after(async () => { await runtime.stop(); });
  return runtime;
}

async function createViaApi(runtime, imagePath) {
  const response = await fetch(`${runtime.url}/api/assets/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: "default", imagePath, prompt: "staging contract" }),
  });
  return { status: response.status, body: await response.json() };
}

test("desktop runtime trusts only the exact staging root, never its parent", async (t) => {
  const userDataDir = await makeWorkspace(t, "mosa-stage-runtime-");
  const stagingRoot = importStagingDir(userDataDir);
  const outsideRoot = await writeFixture(userDataDir, "outside-root.png");
  const parentSibling = await writeFixture(dirname(stagingRoot), "sibling-of-staging.png");
  const runtime = await startAuditRuntime(t, { userDataDir, withStagingRoot: true });
  const staged = await stageFileForImport({ sourcePath: outsideRoot, stagingRoot });

  const inside = await createViaApi(runtime, staged);
  assert.equal(inside.status, 200, `staged import should succeed, got ${inside.status} ${JSON.stringify(inside.body)}`);

  const sibling = await createViaApi(runtime, parentSibling);
  assert.equal(sibling.status, 400, "staging parent directory must not be trusted");
  assert.match(sibling.body.error, /outside the project roots/);

  const unrelated = await createViaApi(runtime, outsideRoot);
  assert.equal(unrelated.status, 400, "other userData files must not be trusted");
  assert.match(unrelated.body.error, /outside the project roots/);
});

test("successful staged import removes the staged copy after the store copied it", async (t) => {
  const userDataDir = await makeWorkspace(t, "mosa-stage-cleanup-");
  const stagingRoot = importStagingDir(userDataDir);
  const sourcePath = await writeFixture(userDataDir, "original.png");
  const runtime = await startAuditRuntime(t, { userDataDir, withStagingRoot: true });
  const staged = await stageFileForImport({ sourcePath, stagingRoot });

  const result = await createViaApi(runtime, staged);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.asset.image_path.startsWith(join(userDataDir, "library")), true, "asset must live in the library");
  await waitFor(async () => !existsSync(staged));
  assert.equal(existsSync(sourcePath), true, "user original must survive the import");
});

test("cancel endpoint removes only staged files from the server and Electron staging roots", async (t) => {
  const userDataDir = await makeWorkspace(t, "mosa-stage-cancel-");
  const electronStagingRoot = importStagingDir(userDataDir);
  const runtime = await startAuditRuntime(t, { userDataDir, withStagingRoot: true });

  const stageResponse = await fetch(`${runtime.url}/api/import/stage`, {
    method: "POST",
    headers: {
      "Content-Type": "image/png",
      "x-mosa-file-name": encodeURIComponent("cancel-browser.png"),
    },
    body: ONE_PIXEL_PNG,
  });
  assert.equal(stageResponse.status, 201);
  const browserStaged = (await stageResponse.json()).path;
  assert.equal(existsSync(browserStaged), true);

  const electronSource = await writeFixture(userDataDir, "cancel-electron-source.png");
  const electronStaged = await stageFileForImport({ sourcePath: electronSource, stagingRoot: electronStagingRoot });
  const outside = await writeFixture(userDataDir, "cancel-outside.png");

  for (const stagedPath of [browserStaged, electronStaged]) {
    const response = await fetch(`${runtime.url}/api/import/stage`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: stagedPath }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    assert.equal(existsSync(stagedPath), false, "cancel must remove a staged copy immediately");
  }

  const outsideResponse = await fetch(`${runtime.url}/api/import/stage`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: outside }),
  });
  assert.equal(outsideResponse.status, 200);
  assert.equal(existsSync(outside), true, "cancel endpoint must never delete a path outside either staging root");
  assert.equal(existsSync(electronSource), true, "the original Electron source must remain untouched");
});

test("Web/server mode without a staging root keeps the default boundary", async (t) => {
  const userDataDir = await makeWorkspace(t, "mosa-stage-web-");
  const stagingRoot = importStagingDir(userDataDir);
  const sourcePath = await writeFixture(userDataDir, "original.png");
  const runtime = await startAuditRuntime(t, { userDataDir, withStagingRoot: false });
  const staged = await stageFileForImport({ sourcePath, stagingRoot });

  const result = await createViaApi(runtime, staged);
  assert.equal(result.status, 400, "Web mode must not gain Electron staging privileges");
  assert.match(result.body.error, /outside the project roots/);
});

test("Web manual upload stages bytes then creates an asset without local path access", async (t) => {
  const userDataDir = await makeWorkspace(t, "mosa-stage-web-upload-");
  const runtime = await startAuditRuntime(t, { userDataDir, withStagingRoot: false });
  const stageResponse = await fetch(`${runtime.url}/api/import/stage`, {
    method: "POST",
    headers: {
      "Content-Type": "image/png",
      "x-mosa-file-name": encodeURIComponent("manual-upload.png"),
    },
    body: ONE_PIXEL_PNG,
  });
  assert.equal(stageResponse.status, 201);
  const staged = await stageResponse.json();
  assert.equal(typeof staged.path, "string");
  assert.equal(existsSync(staged.path), true, "stage endpoint persists the selected bytes");

  const created = await createViaApi(runtime, staged.path);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  await waitFor(async () => !existsSync(staged.path));
});

// ── batch 1.1: one format set, visible failures ──────────────────────────────

test("staging extensions mirror the store's supported media set exactly", () => {
  assert.deepEqual([...STAGING_EXTENSIONS].sort(), SUPPORTED_MEDIA_EXTENSIONS);
});

test("desktop import uses the renderer picker instead of a redundant native dialog IPC", async () => {
  const main = await readFile(join(root, "desktop", "main.mjs"), "utf8");
  const preload = await readFile(join(root, "desktop", "preload.cjs"), "utf8");
  assert.doesNotMatch(main, /ipcMain\.handle\("open-file-dialog"/, "unused native dialog handler stays removed");
  assert.doesNotMatch(preload, /openFileDialog:/, "unused native dialog capability is not exposed");
});

test("the React gallery accepts exactly the server-declared media set and stages through the local runtime", async () => {
  const app = await readFile(join(root, "web", "gravityport", "src", "App.tsx"), "utf8");
  // The accepted set is never hardcoded: drop/paste imports filter through the
  // supportedMediaExtensions list served by /api/library-path.
  assert.match(app, /library\?\.supportedMediaExtensions/, "the accept set comes from the server");
  assert.doesNotMatch(app, /\.(?:png|jpe?g|webm)[a-z|?]*/, { skip: true });
  assert.doesNotMatch(app, /browseFileBtn|importFileInput/, "no manual import modal ever came back");
  const api = await readFile(join(root, "web", "gravityport", "src", "mosa-api.ts"), "utf8");
  assert.match(api, /fetch\("\/api\/import\/stage"/, "dropped files stream to the local staging endpoint");
});

// ── batch 1.2: drag & drop staging ───────────────────────────────────────────

test("Electron drag/drop uses the same byte-stream staging path as Web", async () => {
  const [preload, app, pipeline] = await Promise.all([
    readFile(join(root, "desktop", "preload.cjs"), "utf8"),
    readFile(join(root, "web", "gravityport", "src", "App.tsx"), "utf8"),
    readFile(join(root, "web", "gravityport", "src", "import-pipeline.ts"), "utf8"),
  ]);

  // The drop-back guard is the one place a dropped File becomes a path, and
  // only on its way to the main process: the renderer gets booleans back and
  // still imports through the byte-stream staging below.
  assert.doesNotMatch(preload, /stage-dropped-file/, "preload must not stage dropped files by path");
  assert.equal(preload.split("getPathForFile").length - 1, 1, "getPathForFile appears exactly once");
  assert.match(preload, /libraryFileFlags: \(files\) => ipcRenderer\.invoke\("library-file-flags", Array\.from\(files \|\| \[\], \(file\) => \{\n\s+try \{ return webUtils\.getPathForFile\(file\) \|\| ""; \} catch \{ return ""; \}\n\s+\}\)\),/,
    "dropped-file paths only go to the main process, never back to the page");
  assert.match(app, /onDrop={event =>/, "the workspace owns the drop handler");
  // Task 142: the drop handler hands the DataTransfer to collectDroppedFiles
  // (folder expansion, still real File objects) and importFiles runs the
  // staged pipeline from import-pipeline.ts.
  assert.match(app, /importDroppedFiles\(event\.dataTransfer\)/,
    "drop handler feeds the DataTransfer into the staged import pipeline");
  assert.match(app, /collectDroppedFiles\(dataTransfer/,
    "dropped folders expand into real File objects before staging");
  assert.match(pipeline, /stageImportFile\(file\)/, "imports stream bytes through the runtime staging endpoint");
  assert.doesNotMatch(app, /file\.path|electronAPI\.getPathForFile/,
    "renderer must never read or request the raw Electron file path");
});

// ── batch 1.3: drop failure state hygiene ────────────────────────────────────

test("unsupported imports fail honestly with a toast and never open a modal", async () => {
  const app = await readFile(join(root, "web", "gravityport", "src", "App.tsx"), "utf8");
  // 全部格式不支持：明确报「导入失败」，绝不假装成功，也绝不弹任何导入对话框。
  assert.match(app, /if \(!result\.imported && !result\.failed\) notify\("导入失败"\)/);
  assert.match(app, /部分素材导入失败/, "partial batch failures surface as their own message");
  assert.doesNotMatch(app, /openImportModal|importModal/, "no import path opens any dialog");
});
