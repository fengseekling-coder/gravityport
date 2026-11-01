import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { buildRevealSpawnPlan, handleLibraryRoute } from "../lib/api/library-routes.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

test("buildRevealSpawnPlan reveals macOS app bundles instead of launching them", () => {
  const app = "/tmp/MOSA Library/Tool.app";
  assert.deepEqual(
    buildRevealSpawnPlan({ platform: "darwin", revealFile: false, isFile: false, isPackage: true, resolvedPath: app }),
    { command: "open", args: ["-R", app], options: {} },
  );
});

test("buildRevealSpawnPlan keeps plain macOS folder and file behavior without isPackage", () => {
  const dir = "/tmp/MOSA Library/Exports";
  assert.deepEqual(
    buildRevealSpawnPlan({ platform: "darwin", revealFile: false, isFile: false, resolvedPath: dir }),
    { command: "open", args: [dir], options: {} },
  );
  const file = "/tmp/MOSA Library/asset.png";
  assert.deepEqual(
    buildRevealSpawnPlan({ platform: "darwin", revealFile: true, isFile: true, resolvedPath: file }),
    { command: "open", args: ["-R", file], options: {} },
  );
  // isPackage must never override a reveal-file request either way.
  assert.deepEqual(
    buildRevealSpawnPlan({ platform: "darwin", revealFile: true, isFile: true, isPackage: true, resolvedPath: file }),
    { command: "open", args: ["-R", file], options: {} },
  );
});

test("buildRevealSpawnPlan ignores isPackage off macOS", () => {
  const winDir = String.raw`C:\MosaQA\Tool.app`;
  assert.deepEqual(
    buildRevealSpawnPlan({ platform: "win32", revealFile: false, isFile: false, isPackage: true, resolvedPath: winDir }),
    { command: "explorer.exe", args: [winDir], options: {} },
  );
  const linuxDir = "/tmp/MOSA Library/Tool.app";
  assert.deepEqual(
    buildRevealSpawnPlan({ platform: "linux", revealFile: false, isFile: false, isPackage: true, resolvedPath: linuxDir }),
    { command: "xdg-open", args: [linuxDir], options: {} },
  );
});

test("the open-folder route reveals dotted bundle directories but still opens plain folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-reveal-package-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "MOSA Library");
  const appBundle = join(libraryDir, "Tool.app");
  const innerBundle = join(libraryDir, "Bundle");
  const plain = join(libraryDir, "Exports");
  await mkdir(join(appBundle, "Contents"), { recursive: true });
  await writeFile(join(appBundle, "Contents", "Info.plist"), "<plist/>");
  await mkdir(join(innerBundle, "Contents"), { recursive: true });
  await writeFile(join(innerBundle, "Contents", "Info.plist"), "<plist/>");
  await mkdir(plain, { recursive: true });
  // resolveAllowedFolderPath returns the realpath (macOS /var → /private/var).
  const [canonicalApp, canonicalInner, canonicalPlain] = await Promise.all([
    realpath(appBundle), realpath(innerBundle), realpath(plain),
  ]);

  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };

  const appResponse = await invokeOpenFolderRoute({
    libraryDir,
    body: { path: appBundle },
    platform: "darwin",
    spawnImpl,
  });
  assert.equal(appResponse.statusCode, 200);
  assert.deepEqual(calls.at(-1).args, ["-R", canonicalApp], "a Foo.app directory is revealed, never launched");

  const innerResponse = await invokeOpenFolderRoute({
    libraryDir,
    body: { path: innerBundle },
    platform: "darwin",
    spawnImpl,
  });
  assert.equal(innerResponse.statusCode, 200);
  assert.deepEqual(calls.at(-1).args, ["-R", canonicalInner], "Contents/Info.plist marks a bundle even without an extension");

  const plainResponse = await invokeOpenFolderRoute({
    libraryDir,
    body: { path: plain },
    platform: "darwin",
    spawnImpl,
  });
  assert.equal(plainResponse.statusCode, 200);
  assert.deepEqual(calls.at(-1).args, [canonicalPlain], "a plain folder is still opened itself");
});

test("a dotted name alone marks a bundle and a dangling Contents symlink never errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-reveal-nomarker-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "MOSA Library");
  const dotted = join(libraryDir, "My.Backup");
  await mkdir(dotted, { recursive: true });
  // A dangling Contents symlink must not blow up the route either.
  await symlink(join(libraryDir, "nowhere"), join(dotted, "Contents"));

  const calls = [];
  const response = await invokeOpenFolderRoute({
    libraryDir,
    body: { path: dotted },
    platform: "darwin",
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  assert.equal(response.statusCode, 200);
  const canonicalDotted = await realpath(dotted);
  assert.deepEqual(calls[0].args, ["-R", canonicalDotted], "an extension-bearing directory name is revealed by the name rule alone");
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
