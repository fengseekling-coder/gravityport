import assert from "node:assert/strict";
import { createPackage, createPackageWithOptions } from "@electron/asar";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  packagedAsarPath,
  verifyPackagedRuntime,
} from "../scripts/verify-packaged-runtime.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const IDENTITY = Object.freeze({
  productVersion: "0.2.1-test",
  gitSha: "0123456789abcdef0123456789abcdef01234567",
  uiFingerprint: "a".repeat(64),
  runtimeFingerprint: "b".repeat(64),
});

async function writeFixtureFile(root, relativePath, contents) {
  const path = join(root, ...relativePath.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function createFixture(t, { platform, arch, packedNatives = false }) {
  const projectRoot = await mkdtemp(join(tmpdir(), "mosa-package-verifier-"));
  deferTestPathRemoval(projectRoot, { recursive: true, force: true });
  const runtimeRoot = join(projectRoot, "runtime");
  const manifest = { name: "mosa", version: IDENTITY.productVersion };
  await writeFixtureFile(projectRoot, "web/gravityport/dist/build-identity.json", `${JSON.stringify(IDENTITY, null, 2)}\n`);
  await writeFixtureFile(projectRoot, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFixtureFile(runtimeRoot, "web/gravityport/dist/build-identity.json", `${JSON.stringify(IDENTITY, null, 2)}\n`);
  await writeFixtureFile(runtimeRoot, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);

  if (platform === "darwin") {
    await writeFixtureFile(runtimeRoot, "node_modules/better-sqlite3/prebuilds/darwin-arm64.node", "sqlite-native");
    await writeFixtureFile(runtimeRoot, "node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node", "sharp-native");
    await writeFixtureFile(runtimeRoot, "node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips.8.dylib", "libvips-native");
  } else {
    await writeFixtureFile(runtimeRoot, "node_modules/better-sqlite3/prebuilds/win32-x64.node", "sqlite-native");
    await writeFixtureFile(runtimeRoot, "node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node", "sharp-native");
    await writeFixtureFile(runtimeRoot, "node_modules/@img/sharp-win32-x64/lib/libvips.dll", "libvips-native");
  }

  const asarPath = packagedAsarPath({ projectRoot, platform, arch });
  await mkdir(dirname(asarPath), { recursive: true });
  if (packedNatives) {
    await createPackage(runtimeRoot, asarPath);
  } else {
    await createPackageWithOptions(runtimeRoot, asarPath, {
      unpack: "*.node",
      unpackDir: platform === "darwin" ? "node_modules/@img/sharp-libvips-darwin-arm64" : "node_modules/@img/sharp-win32-x64",
    });
  }
  return { projectRoot, asarPath };
}

test("packaged runtime verifier accepts a macOS package only when native binaries are unpacked", async (t) => {
  const { projectRoot, asarPath } = await createFixture(t, { platform: "darwin", arch: "arm64" });
  const result = await verifyPackagedRuntime({ projectRoot, platform: "darwin", arch: "arm64" });
  assert.equal(result.asarPath, asarPath);
  assert.equal(result.target, "darwin-arm64");
  assert.equal(result.productVersion, IDENTITY.productVersion);
  assert.equal(result.nativeBinaries.length, 3);
});

test("packaged runtime verifier rejects the manual repack failure mode with packed .node files", async (t) => {
  const { projectRoot } = await createFixture(t, {
    platform: "darwin",
    arch: "arm64",
    packedNatives: true,
  });
  await assert.rejects(
    verifyPackagedRuntime({ projectRoot, platform: "darwin", arch: "arm64" }),
    /Native binaries must be unpacked from app\.asar:.*\.node/,
  );
});

test("packaged runtime verifier applies the same native gate to Windows packages", async (t) => {
  const { projectRoot, asarPath } = await createFixture(t, { platform: "win32", arch: "x64" });
  const result = await verifyPackagedRuntime({ projectRoot, platform: "win32", arch: "x64" });
  assert.equal(result.asarPath, asarPath);
  assert.equal(result.target, "win32-x64");
  assert.equal(result.nativeBinaries.length, 3);
});

test("packaged runtime verifier rejects optional visual runtime bundled into the packaged app", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "mosa-package-verifier-visual-bundle-"));
  deferTestPathRemoval(projectRoot, { recursive: true, force: true });
  const runtimeRoot = join(projectRoot, "runtime");
  const manifest = { name: "mosa", version: IDENTITY.productVersion };
  await writeFixtureFile(projectRoot, "web/gravityport/dist/build-identity.json", `${JSON.stringify(IDENTITY, null, 2)}\n`);
  await writeFixtureFile(projectRoot, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFixtureFile(runtimeRoot, "web/gravityport/dist/build-identity.json", `${JSON.stringify(IDENTITY, null, 2)}\n`);
  await writeFixtureFile(runtimeRoot, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFixtureFile(runtimeRoot, "node_modules/better-sqlite3/prebuilds/darwin-arm64.node", "sqlite-native");
  await writeFixtureFile(runtimeRoot, "node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node", "sharp-native");
  await writeFixtureFile(runtimeRoot, "node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips.8.dylib", "libvips-native");
  await writeFixtureFile(runtimeRoot, "node_modules/onnxruntime-node/dist/index.js", "module.exports = {};\n");
  const asarPath = packagedAsarPath({ projectRoot, platform: "darwin", arch: "arm64" });
  await mkdir(dirname(asarPath), { recursive: true });
  await createPackageWithOptions(runtimeRoot, asarPath, {
    unpack: "*.node",
    unpackDir: "node_modules/@img/sharp-libvips-darwin-arm64",
  });
  await assert.rejects(
    verifyPackagedRuntime({ projectRoot, platform: "darwin", arch: "arm64" }),
    /Optional visual runtime must stay out of GravityPort\.app/,
  );
});

test("packaged runtime verifier rejects source/package build identity drift", async (t) => {
  const { projectRoot } = await createFixture(t, { platform: "darwin", arch: "arm64" });
  await writeFixtureFile(projectRoot, "web/gravityport/dist/build-identity.json", `${JSON.stringify({
    ...IDENTITY,
    runtimeFingerprint: "c".repeat(64),
  }, null, 2)}\n`);
  await assert.rejects(
    verifyPackagedRuntime({ projectRoot, platform: "darwin", arch: "arm64" }),
    /Packaged build identity does not match the current source build identity/,
  );
});

test("desktop packaging scripts cannot bypass structural verification and packaged smoke", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  for (const scriptName of [
    "desktop:package",
    "desktop:package:windows",
    "desktop:release:preview",
    "desktop:release:production",
    "desktop:release:windows:preview",
    "desktop:release:windows:production",
  ]) {
    const script = String(manifest.scripts?.[scriptName] || "");
    assert.match(script, /verify:desktop:package/);
    assert.match(script, /qa:packaged:smoke/);
  }
  assert.match(String(manifest.scripts?.["desktop:release"] || ""), /desktop:release:preview/);
  assert.match(String(manifest.scripts?.["desktop:release:windows"] || ""), /desktop:release:windows:preview/);
  assert.match(String(manifest.scripts?.["desktop:make"] || ""), /npm run desktop:package/);
  assert.match(String(manifest.scripts?.["desktop:make:windows"] || ""), /npm run desktop:package:windows/);
  assert.match(String(manifest.scripts?.["desktop:make:windows"] || ""), /desktop:update-artifact:windows/);
  assert.doesNotMatch(String(manifest.scripts?.["desktop:make:windows"] || ""), /electron-forge make/);
  for (const scriptName of ["desktop:release:windows:preview", "desktop:release:windows:production"]) {
    assert.match(String(manifest.scripts?.[scriptName] || ""), /desktop:update-artifact:windows/);
  }
});
