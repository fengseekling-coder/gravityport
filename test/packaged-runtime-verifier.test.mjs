import assert from "node:assert/strict";
import { createPackage, createPackageWithOptions } from "@electron/asar";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  missingMcpServerModules,
  packagedAsarPath,
  verifyPackagedRuntime,
} from "../scripts/verify-packaged-runtime.mjs";
import { LICENSE_FILES } from "../scripts/third-party-licenses.mjs";
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

async function writePackagedLicenses(asarPath) {
  const licensesDir = join(dirname(asarPath), "licenses");
  await mkdir(licensesDir, { recursive: true });
  for (const name of Object.values(LICENSE_FILES)) {
    await writeFile(join(licensesDir, name), name === LICENSE_FILES.notices ? "react\nbetter-sqlite3\nlibvips\n" : `${name}\n`);
  }
  return licensesDir;
}

async function createFixture(t, { platform, arch, packedNatives = false, omitMcpModule = "" }) {
  const projectRoot = await mkdtemp(join(tmpdir(), "mosa-package-verifier-"));
  deferTestPathRemoval(projectRoot, { recursive: true, force: true });
  const runtimeRoot = join(projectRoot, "runtime");
  const manifest = { name: "mosa", version: IDENTITY.productVersion };
  await writeFixtureFile(projectRoot, "web/gravityport/dist/build-identity.json", `${JSON.stringify(IDENTITY, null, 2)}\n`);
  await writeFixtureFile(projectRoot, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFixtureFile(runtimeRoot, "web/gravityport/dist/build-identity.json", `${JSON.stringify(IDENTITY, null, 2)}\n`);
  await writeFixtureFile(runtimeRoot, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);
  const mcpModules = {
    "mcp/server.mjs": 'import { search } from "../lib/search.mjs";\nimport "../lib/lock.js";\n',
    "lib/search.mjs": 'export { range } from "./time-range.mjs";\nexport const search = () => import("./lazy.mjs");\n',
    "lib/time-range.mjs": "export const range = 1;\n",
    "lib/lazy.mjs": "export default 1;\n",
    "lib/lock.js": "export {};\n",
  };
  for (const [path, contents] of Object.entries(mcpModules)) {
    if (path !== omitMcpModule) await writeFixtureFile(runtimeRoot, path, contents);
  }

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
  const licensesDir = await writePackagedLicenses(asarPath);
  return { projectRoot, asarPath, licensesDir };
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

test("packaged runtime verifier requires every license file in Resources/licenses on both targets", async (t) => {
  for (const [platform, arch] of [["darwin", "arm64"], ["win32", "x64"]]) {
    for (const name of Object.values(LICENSE_FILES)) {
      const { projectRoot, licensesDir } = await createFixture(t, { platform, arch });
      await rm(join(licensesDir, name));
      await assert.rejects(
        verifyPackagedRuntime({ projectRoot, platform, arch }),
        new RegExp(`Packaged license file is missing: licenses/${name.replace(/\./g, "\\.")}`),
      );
    }
  }
});

test("packaged runtime verifier rejects empty license files and notices that miss a component", async (t) => {
  const { projectRoot, licensesDir } = await createFixture(t, { platform: "darwin", arch: "arm64" });
  await writeFile(join(licensesDir, LICENSE_FILES.gpl), "");
  await assert.rejects(
    verifyPackagedRuntime({ projectRoot, platform: "darwin", arch: "arm64" }),
    /Packaged license file is empty: licenses\/GPL-3\.0\.txt/,
  );
  await writeFile(join(licensesDir, LICENSE_FILES.gpl), "GPL\n");
  await writeFile(join(licensesDir, LICENSE_FILES.notices), "better-sqlite3\nlibvips\n");
  await assert.rejects(
    verifyPackagedRuntime({ projectRoot, platform: "darwin", arch: "arm64" }),
    /THIRD_PARTY_LICENSES\.txt does not mention react/,
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

test("packaged runtime verifier rejects a bundled MCP server with a missing module", async (t) => {
  for (const omitted of ["mcp/server.mjs", "lib/time-range.mjs", "lib/lazy.mjs", "lib/lock.js"]) {
    const { projectRoot } = await createFixture(t, { platform: "darwin", arch: "arm64", omitMcpModule: omitted });
    await assert.rejects(
      verifyPackagedRuntime({ projectRoot, platform: "darwin", arch: "arm64" }),
      new RegExp(`Bundled MCP server is incomplete; missing from app.asar: ${omitted.replace(/\./g, "\\.")}`),
    );
  }
});

test("bundled MCP import closure follows the real server's relative imports", async () => {
  const root = new URL("..", import.meta.url);
  const read = (path) => readFile(new URL(path, root), "utf8");
  const sources = new Map();
  const pending = ["mcp/server.mjs"];
  while (pending.length) {
    const path = pending.pop();
    if (sources.has(path)) continue;
    let text;
    try { text = await read(path); } catch { continue; }
    sources.set(path, text);
    for (const [, specifier] of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/gu)) {
      pending.push(new URL(specifier, new URL(path, root)).pathname.slice(new URL(root).pathname.length));
    }
  }
  assert.ok(sources.has("lib/asset-store.mjs"));
  assert.deepEqual(missingMcpServerModules([...sources.keys()], (path) => sources.get(path)), []);
  const withoutStore = [...sources.keys()].filter((path) => path !== "lib/asset-store.mjs");
  assert.deepEqual(missingMcpServerModules(withoutStore, (path) => sources.get(path)), ["lib/asset-store.mjs"]);
});
