import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createForgeConfig, resolveDesktopPackagingTarget } from "../desktop/forge.config.mjs";
import {
  MACOS_UPDATE_APP_NAMES,
  MOSA_UPDATE_FEED_URL,
  buildUpdateFeedUrl,
  macosUpdateFileNameForAppName,
  windowsUpdateFileNameForPayloadExeName,
} from "../desktop/update-service.mjs";
import {
  DEFAULT_RELEASE_PRODUCT,
  RELEASE_PRODUCTS,
  releaseProductNames,
  resolveReleaseProduct,
  resolveReleaseProductNames,
} from "../scripts/release-product.mjs";
import {
  makeMacosUpdateZip,
  macosUpdateArtifactName,
  macosUpdateArtifactPath,
} from "../scripts/make-macos-update-zip.mjs";
import {
  makeWindowsUpdateZip,
  windowsUpdateArtifactName,
  windowsUpdateArtifactPath,
} from "../scripts/make-windows-update-zip.mjs";
import { packagedExecutablePath } from "../scripts/desktop-runtime-paths.mjs";
import { packagedAsarPath } from "../scripts/verify-packaged-runtime.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

test("release product switch defaults to GravityPort and only accepts the two product names", () => {
  assert.deepEqual(RELEASE_PRODUCTS, ["MOSA", "GravityPort"]);
  assert.equal(DEFAULT_RELEASE_PRODUCT, "GravityPort");
  assert.equal(resolveReleaseProduct({}), "GravityPort");
  assert.equal(resolveReleaseProduct({ MOSA_RELEASE_PRODUCT: "MOSA" }), "MOSA");
  assert.equal(resolveReleaseProduct({ MOSA_RELEASE_PRODUCT: "GravityPort" }), "GravityPort");
  for (const invalid of ["mosa", "gravityport", "MOSA ", " MOSA", "GravityPort ", "", "\tMOSA", "legacy"]) {
    assert.throws(
      () => resolveReleaseProduct({ MOSA_RELEASE_PRODUCT: invalid }),
      new RegExp(`Unsupported MOSA_RELEASE_PRODUCT: ${JSON.stringify(invalid).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
  }
});

test("release product names cover every packaging name for both products", () => {
  const defaulted = resolveReleaseProductNames({});
  assert.equal(defaulted.product, "GravityPort");
  assert.equal(defaulted.macAppBundleName, "GravityPort.app");
  assert.equal(defaulted.macExecutableName, "GravityPort");
  assert.equal(defaulted.windowsExecutableName, "GravityPort.exe");
  assert.equal(defaulted.macosPackageDirName, "GravityPort-darwin-arm64");
  assert.equal(defaulted.windowsPackageDirName, "GravityPort-win32-x64");
  const legacy = releaseProductNames("MOSA");
  assert.equal(legacy.product, "MOSA");
  assert.equal(legacy.macAppBundleName, "MOSA.app");
  assert.equal(legacy.macExecutableName, "MOSA");
  assert.equal(legacy.windowsExecutableName, "MOSA.exe");
  assert.equal(legacy.macosPackageDirName, "MOSA-darwin-arm64");
  assert.equal(legacy.windowsPackageDirName, "MOSA-win32-x64");
  assert.equal(legacy.macosUpdateZipName("0.2.1-rc.4"), "MOSA-darwin-arm64-0.2.1-rc.4.zip");
  assert.equal(legacy.windowsUpdateZipName("0.2.1-rc.4"), "MOSA-win32-x64-0.2.1-rc.4.zip");
  assert.equal(legacy.windowsInstallerName("0.2.1-rc.4"), "MOSA-win32-x64-0.2.1-rc.4.exe");
  assert.equal(legacy.macosDmgName("0.2.1-rc.4"), "MOSA-darwin-arm64-0.2.1-rc.4.dmg");
  const renamed = releaseProductNames("GravityPort");
  assert.equal(renamed.macosUpdateZipName("0.3.0"), "GravityPort-darwin-arm64-0.3.0.zip");
  assert.equal(renamed.windowsUpdateZipName("0.3.0"), "GravityPort-win32-x64-0.3.0.zip");
  assert.equal(renamed.windowsInstallerName("0.3.0"), "GravityPort-win32-x64-0.3.0.exe");
  assert.equal(renamed.macosDmgName("0.3.0"), "GravityPort-darwin-arm64-0.3.0.dmg");
  assert.throws(() => releaseProductNames("mosa"), /Unsupported release product/);
});

test("forge packaging config takes the product name from the release switch and keeps one bundle id", () => {
  const macTarget = resolveDesktopPackagingTarget({ platform: "darwin", arch: "arm64", env: {}, argv: [] });
  const winTarget = resolveDesktopPackagingTarget({ platform: "win32", arch: "x64", env: {}, argv: [] });

  const renamedMac = createForgeConfig({ target: macTarget, env: {} });
  assert.equal(renamedMac.packagerConfig.name, "GravityPort");
  assert.equal(renamedMac.packagerConfig.appBundleId, "com.azhuilab.mosa");
  const legacyMac = createForgeConfig({ target: macTarget, env: { MOSA_RELEASE_PRODUCT: "MOSA" } });
  assert.equal(legacyMac.packagerConfig.name, "MOSA");
  assert.equal(legacyMac.packagerConfig.appBundleId, "com.azhuilab.mosa");

  const windowsSigningEnv = {
    MOSA_RELEASE_DISTRIBUTION: "production",
    MOSA_WINDOWS_SIGNER_THUMBPRINT: "A".repeat(40),
    WINDOWS_CERTIFICATE_FILE: "C:\\secrets\\mosa.pfx",
    WINDOWS_CERTIFICATE_PASSWORD: "secret",
  };
  const renamedWindows = createForgeConfig({
    target: winTarget,
    env: { ...windowsSigningEnv },
  });
  assert.equal(renamedWindows.packagerConfig.name, "GravityPort");
  assert.equal(renamedWindows.packagerConfig.windowsSign.description, "GravityPort");
  const legacyWindows = createForgeConfig({
    target: winTarget,
    env: { ...windowsSigningEnv, MOSA_RELEASE_PRODUCT: "MOSA" },
  });
  assert.equal(legacyWindows.packagerConfig.name, "MOSA");
  assert.equal(legacyWindows.packagerConfig.windowsSign.description, "MOSA");

  assert.throws(
    () => createForgeConfig({ target: macTarget, env: { MOSA_RELEASE_PRODUCT: "gravityport" } }),
    /Unsupported MOSA_RELEASE_PRODUCT/,
  );
});

test("macOS update artifact names round-trip through the update feed for both products", () => {
  for (const product of RELEASE_PRODUCTS) {
    const appName = `${product}.app`;
    assert.ok(MACOS_UPDATE_APP_NAMES.includes(appName));
    assert.equal(
      macosUpdateArtifactName("0.3.0-rc.2", "arm64", product),
      macosUpdateFileNameForAppName(appName, "0.3.0-rc.2"),
    );
    assert.equal(
      macosUpdateArtifactPath({ rootDir: "/repo", outDir: "out", version: "0.3.0", product }),
      join("/repo", "out", "make", "update", "darwin", "arm64", `${product}-darwin-arm64-0.3.0.zip`),
    );
  }
  assert.equal(macosUpdateArtifactName("0.3.0", "arm64", "MOSA"), "MOSA-darwin-arm64-0.3.0.zip");
  assert.equal(macosUpdateArtifactName("0.3.0"), "GravityPort-darwin-arm64-0.3.0.zip");
});

test("Windows update artifact names round-trip through the update feed for both products", () => {
  for (const product of RELEASE_PRODUCTS) {
    const payloadExeName = `${product}.exe`;
    assert.equal(
      windowsUpdateArtifactName("0.3.0-rc.2", "x64", product),
      windowsUpdateFileNameForPayloadExeName(payloadExeName, "0.3.0-rc.2"),
    );
    assert.equal(
      windowsUpdateArtifactPath({ rootDir: "/repo", outDir: "out", version: "0.3.0", product }),
      join("/repo", "out", "make", "zip", "win32", "x64", `${product}-win32-x64-0.3.0.zip`),
    );
  }
  assert.equal(windowsUpdateArtifactName("0.3.0", "x64", "MOSA"), "MOSA-win32-x64-0.3.0.zip");
  assert.equal(windowsUpdateArtifactName("0.3.0"), "GravityPort-win32-x64-0.3.0.zip");
});

test("macOS update ZIP builder packages either product from the same source tree", async (t) => {
  for (const product of RELEASE_PRODUCTS) {
    const root = await mkdtemp(join(tmpdir(), `mosa-mac-update-${product}-`));
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.3.0" }));
      const appPath = join(root, "out", `${product}-darwin-arm64`, `${product}.app`);
      await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
      await writeFile(join(appPath, "Contents", "MacOS", product), "binary");
      const result = await makeMacosUpdateZip({
        rootDir: root,
        product,
        runner: async (_command, args) => {
          await writeFile(args.at(-1), "fake-zip-content");
          return { stdout: "", stderr: "" };
        },
      });
      assert.equal(result.artifactName, `${product}-darwin-arm64-0.3.0.zip`);
      assert.equal(result.artifactPath, macosUpdateArtifactPath({ rootDir: root, version: "0.3.0", product }));
      assert.equal(macosUpdateFileNameForAppName(`${product}.app`, "0.3.0"), result.artifactName);
      assert.equal((await stat(result.artifactPath)).size, result.size);
      assert.equal(await readFile(result.artifactPath, "utf8"), "fake-zip-content");
    } finally {
      await removeTestPath(root, { recursive: true, force: true });
    }
  }
});

test("Windows update ZIP builder packages either product and rejects a flat layout", async (t) => {
  for (const product of RELEASE_PRODUCTS) {
    const root = await mkdtemp(join(tmpdir(), `mosa-win-update-${product}-`));
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.3.0" }));
      const packageDir = join(root, "out", `${product}-win32-x64`);
      await mkdir(packageDir, { recursive: true });
      await writeFile(join(packageDir, `${product}.exe`), "binary");
      let flat = false;
      const runner = async (command, args) => {
        if (command === "zip") {
          await writeFile(args[2], "fake-zip-content");
          return { stdout: "", stderr: "" };
        }
        if (command === "unzip") {
          return {
            stdout: flat
              ? `${product}.exe\nresources/app.asar\n`
              : `${product}-win32-x64/${product}.exe\n${product}-win32-x64/resources/app.asar\n`,
            stderr: "",
          };
        }
        throw new Error(`unexpected command: ${command}`);
      };

      const result = await makeWindowsUpdateZip({ rootDir: root, platform: "darwin", product, runner });
      assert.equal(result.artifactName, `${product}-win32-x64-0.3.0.zip`);
      assert.equal(result.artifactPath, windowsUpdateArtifactPath({ rootDir: root, version: "0.3.0", product }));
      assert.equal(windowsUpdateFileNameForPayloadExeName(`${product}.exe`, "0.3.0"), result.artifactName);
      assert.equal((await stat(result.artifactPath)).size, result.size);

      flat = true;
      await assert.rejects(
        makeWindowsUpdateZip({ rootDir: root, platform: "darwin", product, runner }),
        new RegExp(`missing ${product}-win32-x64/${product}\\.exe`),
      );
    } finally {
      await removeTestPath(root, { recursive: true, force: true });
    }
  }
});

test("packaged runtime paths and asar locations follow the release product switch", () => {
  assert.equal(
    packagedExecutablePath({ rootDir: "/repo", outDir: "/repo/out", platform: "darwin", arch: "arm64" }),
    join("/repo/out", "GravityPort-darwin-arm64", "GravityPort.app", "Contents", "MacOS", "GravityPort"),
  );
  assert.equal(
    packagedExecutablePath({ rootDir: "/repo", outDir: "/repo/out", platform: "darwin", arch: "arm64", product: "MOSA" }),
    join("/repo/out", "MOSA-darwin-arm64", "MOSA.app", "Contents", "MacOS", "MOSA"),
  );
  assert.equal(
    packagedExecutablePath({ rootDir: "/repo", outDir: "/repo/out", platform: "win32", arch: "x64", product: "MOSA" }),
    join("/repo/out", "MOSA-win32-x64", "MOSA.exe"),
  );
  assert.equal(
    packagedExecutablePath({ rootDir: "/repo", outDir: "/repo/out", platform: "win32", arch: "x64" }),
    join("/repo/out", "GravityPort-win32-x64", "GravityPort.exe"),
  );
  assert.equal(
    packagedAsarPath({ projectRoot: "/repo", outDir: "out", platform: "darwin", arch: "arm64" }),
    join("/repo/out", "GravityPort-darwin-arm64", "GravityPort.app", "Contents", "Resources", "app.asar"),
  );
  assert.equal(
    packagedAsarPath({ projectRoot: "/repo", outDir: "out", platform: "darwin", arch: "arm64", product: "MOSA" }),
    join("/repo/out", "MOSA-darwin-arm64", "MOSA.app", "Contents", "Resources", "app.asar"),
  );
  assert.equal(
    packagedAsarPath({ projectRoot: "/repo", outDir: "out", platform: "win32", arch: "x64", product: "MOSA" }),
    join("/repo/out", "MOSA-win32-x64", "resources", "app.asar"),
  );
});

test("both release products check the gravityport update feed and report usage onto it", () => {
  assert.equal(MOSA_UPDATE_FEED_URL, "https://gravityport.azhuilab.com/releases/gravityport/latest.json");
  const url = new URL(buildUpdateFeedUrl({
    event: "daily_active",
    telemetryVersion: 2,
    installationId: "123e4567-e89b-42d3-a456-426614174000",
    platform: "macos",
    arch: "arm64",
    version: "0.2.0",
  }));
  assert.equal(`${url.origin}${url.pathname}`, "https://gravityport.azhuilab.com/releases/gravityport/latest.json");
});
