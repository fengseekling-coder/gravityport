import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { buildRevealSpawnPlan, handleLibraryRoute } from "../lib/api/library-routes.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const WINDOWS_FILE_CASES = [
  String.raw`C:\MosaQA\plain\asset.png`,
  String.raw`C:\MosaQA\space dir\asset.png`,
  String.raw`C:\MosaQA\中文目录\asset.png`,
  String.raw`C:\MosaQA\中文 目录\asset file.png`,
  String.raw`C:\MosaQA\space dir\asset (final).png`,
  String.raw`C:\MosaQA\space dir\asset & (notes).png`,
  String.raw`C:\MosaQA\deep folder\nested level\asset file.png`,
];

for (const resolvedPath of WINDOWS_FILE_CASES) {
  test(`Windows reveal preserves Explorer /select grammar for ${resolvedPath}`, () => {
    const plan = buildRevealSpawnPlan({
      platform: "win32",
      revealFile: true,
      isFile: true,
      resolvedPath,
    });
    assert.equal(plan.command, "explorer.exe");
    assert.deepEqual(plan.args, [`/select,"${resolvedPath}"`]);
    assert.deepEqual(plan.options, { windowsVerbatimArguments: true });
  });
}

test("Windows directory open keeps the ordinary spawn argument path", () => {
  const resolvedPath = String.raw`C:\MosaQA\space dir`;
  const plan = buildRevealSpawnPlan({ platform: "win32", revealFile: false, isFile: false, resolvedPath });
  assert.deepEqual(plan, { command: "explorer.exe", args: [resolvedPath], options: {} });
});

test("macOS reveal remains open -R and Linux reveal remains parent-directory open", () => {
  const resolvedPath = "/tmp/MOSA Library/asset file.png";
  assert.deepEqual(
    buildRevealSpawnPlan({ platform: "darwin", revealFile: true, isFile: true, resolvedPath }),
    { command: "open", args: ["-R", resolvedPath], options: {} },
  );
  assert.deepEqual(
    buildRevealSpawnPlan({ platform: "linux", revealFile: true, isFile: true, resolvedPath }),
    { command: "xdg-open", args: ["/tmp/MOSA Library"], options: {} },
  );
});

test("open-folder route uses shell-free verbatim Explorer reveal after allowlist validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-explorer-reveal-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "MOSA Library");
  const nestedDir = join(libraryDir, "中文 目录", "space & (notes)");
  const filePath = join(nestedDir, "asset file & (final).png");
  await mkdir(nestedDir, { recursive: true });
  await writeFile(filePath, "fixture");
  const canonicalPath = await realpath(filePath);

  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };

  const response = await invokeOpenFolderRoute({
    libraryDir,
    body: { path: filePath, reveal: true },
    platform: "win32",
    spawnImpl,
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "explorer.exe");
  assert.deepEqual(calls[0].args, [`/select,"${canonicalPath}"`]);
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.stdio, "ignore");
  // windowsHide would start Explorer with SW_HIDE and leave the window invisible.
  assert.equal("windowsHide" in calls[0].options, false);
  assert.match(calls[0].args[0], /&/);
  assert.match(calls[0].args[0], /\(final\)/);
});

test("open-folder route rejects paths outside the allowlist without spawning", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-explorer-reveal-block-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  const outsideDir = join(root, "outside");
  const outsideFile = join(outsideDir, "asset & (outside).png");
  await mkdir(libraryDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await writeFile(outsideFile, "fixture");
  let spawnCount = 0;

  const response = await invokeOpenFolderRoute({
    libraryDir,
    body: { path: outsideFile, reveal: true },
    platform: "win32",
    spawnImpl: () => {
      spawnCount += 1;
      throw new Error("spawn must not run");
    },
  });

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.body, { error: "Path not allowed" });
  assert.equal(spawnCount, 0);
});

test("open-folder route keeps Windows directory-open behavior without verbatim arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-explorer-directory-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "MOSA Library");
  const directoryPath = join(libraryDir, "中文 目录");
  await mkdir(directoryPath, { recursive: true });
  const canonicalPath = await realpath(directoryPath);
  const calls = [];

  const response = await invokeOpenFolderRoute({
    libraryDir,
    body: { path: directoryPath, reveal: false },
    platform: "win32",
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "explorer.exe");
  assert.deepEqual(calls[0].args, [canonicalPath]);
  assert.equal("windowsVerbatimArguments" in calls[0].options, false);
  assert.equal("windowsHide" in calls[0].options, false);
  assert.equal(calls[0].options.shell, false);
});

async function invokeOpenFolderRoute({ libraryDir, body, platform, spawnImpl }) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = "POST";
  const headers = new Map();
  const res = {
    statusCode: 0,
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    end(payload = "") { this.payload = String(payload); },
  };
  const handled = await handleLibraryRoute({
    req,
    res,
    url: new URL("http://127.0.0.1/api/open-folder"),
    context: {
      platform,
      spawnImpl,
      libraryDir,
      grokSessionsDir: libraryDir,
      supportedMediaExtensions: [],
      store: {
        listProjects: async () => [],
        managerDir: libraryDir,
        codexImagesDir: libraryDir,
        projectDir: () => libraryDir,
      },
    },
  });
  assert.equal(handled, true);
  return {
    statusCode: res.statusCode,
    headers,
    body: res.payload ? JSON.parse(res.payload) : null,
  };
}
