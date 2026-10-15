import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import forgeConfig, {
  createForgeConfig,
  macReleasePackagingConfig,
  packageIgnorePatterns,
  packageIgnorePatternsForTarget,
  preparePackagedRuntime,
  resolveDesktopPackagingTarget,
  windowsReleasePackagingConfig,
} from "../desktop/forge.config.mjs";
import {
  DESKTOP_ICON_SOURCE_PATH,
  desktopIconBasePath,
  generateDesktopIcons,
} from "../desktop/icon-assets.mjs";
import {
  assertDesktopPackagingNode,
  desktopPackagingNodeError,
} from "../scripts/check-desktop-package-node.mjs";
import {
  MOSA_MAC_BUNDLE_ID,
  assertMacAppMetadata,
  macDmgArtifactName,
  macDmgOutputPath,
  macDmgReleaseCredentials,
} from "../scripts/make-macos-dmg.mjs";

const isIgnored = (path) => packageIgnorePatterns.some((pattern) => pattern.test(path));

test("desktop packaging accepts Node 22 and rejects other major versions", () => {
  assert.equal(assertDesktopPackagingNode("22.23.1"), true);
  assert.equal(desktopPackagingNodeError("v22.0.0"), null);
  assert.match(desktopPackagingNodeError("24.16.0")?.message || "", /requires Node\.js 22\.x/);
  assert.throws(() => assertDesktopPackagingNode("24.16.0"), /current runtime is v24\.16\.0/);
});

test("packages the default product with ASAR and unpacked native dependencies", () => {
  assert.equal(forgeConfig.outDir, "out");
  assert.equal(forgeConfig.packagerConfig.name, "GravityPort");
  // The legacy MOSA transition build comes from the same config under the switch.
  assert.equal(createForgeConfig({ env: { MOSA_RELEASE_PRODUCT: "MOSA" } }).packagerConfig.name, "MOSA");
  assert.equal(forgeConfig.packagerConfig.icon, desktopIconBasePath({ outDir: "out" }));
  assert.equal(forgeConfig.packagerConfig.appBundleId, "com.azhuilab.mosa");
  const sign = forgeConfig.packagerConfig.osxSign;
  assert.equal(sign.identity, "-");
  assert.equal(sign.identityValidation, false);
  assert.equal(sign.preAutoEntitlements, false);
  assert.equal(sign.strictVerify, true);
  assert.equal(sign.continueOnError, false);
  assert.deepEqual(sign.optionsForFile("/tmp/MOSA.app"), {
    hardenedRuntime: false,
    additionalArguments: ["--options=0"],
  });
  assert.equal(
    forgeConfig.packagerConfig.asar.unpackDir,
    "node_modules/@img/sharp-libvips-darwin-arm64",
  );
  assert.equal(typeof forgeConfig.hooks.packageAfterPrune, "function");
  assert.equal(typeof forgeConfig.hooks.generateAssets, "function");
  assert.deepEqual(forgeConfig.packagerConfig.ignore, packageIgnorePatterns);
  assert.equal(forgeConfig.plugins.some((plugin) => plugin.name === "auto-unpack-natives"), true);
  const zipMaker = forgeConfig.makers.find((maker) => maker.name === "zip");
  assert.ok(zipMaker);
  assert.deepEqual(zipMaker.platforms, ["win32"]);
});

test("macOS distribution keeps a stable app identity and deterministic DMG path", () => {
  assert.equal(MOSA_MAC_BUNDLE_ID, "com.azhuilab.mosa");
  // Legacy MOSA transition build keeps the historical names under the switch.
  assert.equal(macDmgArtifactName("0.2.1-rc.4", "arm64", "MOSA"), "MOSA-darwin-arm64-0.2.1-rc.4.dmg");
  assert.equal(
    macDmgOutputPath({ rootDir: "/repo", version: "0.2.1-rc.4", product: "MOSA" }),
    resolve("/repo", "out", "make", "dmg", "darwin", "arm64", "MOSA-darwin-arm64-0.2.1-rc.4.dmg"),
  );
  assert.equal(assertMacAppMetadata({
    bundleId: "com.azhuilab.mosa",
    bundleName: "MOSA",
    executable: "MOSA",
    version: "0.2.1-rc.4",
  }, "0.2.1-rc.4", "MOSA"), true);
  assert.throws(() => assertMacAppMetadata({
    bundleId: "com.example.mosa-copy",
    bundleName: "MOSA",
    executable: "MOSA",
    version: "0.2.1-rc.4",
  }, "0.2.1-rc.4", "MOSA"), /Unexpected macOS bundle identifier/);
  // The default GravityPort build validates against the renamed metadata.
  assert.equal(macDmgArtifactName("0.2.1-rc.4"), "GravityPort-darwin-arm64-0.2.1-rc.4.dmg");
  assert.equal(assertMacAppMetadata({
    bundleId: "com.azhuilab.mosa",
    bundleName: "GravityPort",
    executable: "GravityPort",
    version: "0.2.1-rc.4",
  }, "0.2.1-rc.4"), true);
  assert.throws(() => assertMacAppMetadata({
    bundleId: "com.azhuilab.mosa",
    bundleName: "GravityPort",
    executable: "MOSA",
    version: "0.2.1-rc.4",
  }, "0.2.1-rc.4"), /Unexpected macOS executable name/);
  assert.throws(() => assertMacAppMetadata({
    bundleId: "com.azhuilab.mosa",
    bundleName: "MOSA",
    executable: "MOSA",
    version: "0.2.1-rc.4",
  }, "0.2.1-rc.4"), /Unexpected macOS bundle name/);
});

test("macOS release DMG credentials fail closed", () => {
  assert.throws(() => macDmgReleaseCredentials({}), /MOSA DMG release requires/);
  assert.deepEqual(macDmgReleaseCredentials({
    MOSA_MACOS_SIGN_IDENTITY: "Developer ID Application: Example (TEAM123456)",
    APPLE_ID: "release@example.com",
    APPLE_APP_SPECIFIC_PASSWORD: "app-password",
    APPLE_TEAM_ID: "TEAM123456",
  }), {
    identity: "Developer ID Application: Example (TEAM123456)",
    appleId: "release@example.com",
    appleIdPassword: "app-password",
    teamId: "TEAM123456",
  });
});

test("desktop packaging target resolution supports only the approved macOS and Windows targets", () => {
  assert.equal(resolveDesktopPackagingTarget({ platform: "darwin", arch: "arm64", env: {}, argv: [] }).id, "darwin-arm64");
  assert.equal(resolveDesktopPackagingTarget({ platform: "win32", arch: "x64", env: {}, argv: [] }).id, "win32-x64");
  assert.equal(resolveDesktopPackagingTarget({ env: {}, argv: ["node", "forge", "--platform", "win32", "--arch=x64"] }).id, "win32-x64");
  assert.equal(resolveDesktopPackagingTarget({ env: { MOSA_DESKTOP_PLATFORM: "win32", MOSA_DESKTOP_ARCH: "x64" }, argv: [] }).id, "win32-x64");
  assert.throws(
    () => resolveDesktopPackagingTarget({ platform: "win32", arch: "arm64", env: {}, argv: [] }),
    /Unsupported MOSA desktop packaging target: win32-arm64/,
  );
});

test("Windows Forge config omits mac signing and selects Windows native runtime packages", () => {
  const target = resolveDesktopPackagingTarget({ platform: "win32", arch: "x64", env: {}, argv: [] });
  const config = createForgeConfig({ target, env: {} });
  assert.equal("appBundleId" in config.packagerConfig, false);
  assert.equal("osxSign" in config.packagerConfig, false);
  assert.equal("osxNotarize" in config.packagerConfig, false);
  assert.equal("windowsSign" in config.packagerConfig, false);
  assert.equal(config.packagerConfig.icon, desktopIconBasePath({ outDir: "out" }));
  assert.equal(config.packagerConfig.asar.unpackDir, "node_modules/@img/sharp-win32-x64");
  assert.equal(config.makers.some((maker) => maker.name === "zip" && maker.platforms.includes("win32")), true);

  const patterns = packageIgnorePatternsForTarget(target);
  const ignored = (path) => patterns.some((pattern) => pattern.test(path));
  assert.equal(ignored("/node_modules/@img/sharp-win32-x64/package.json"), false);
  assert.equal(ignored("/node_modules/@img/sharp-darwin-arm64/package.json"), true);
  assert.equal(ignored("/node_modules/better-sqlite3/prebuilds/win32-x64.node"), false);
  assert.equal(ignored("/node_modules/onnxruntime-node/dist/index.js"), true);
  assert.equal(ignored("/node_modules/onnxruntime-common/dist/cjs/index.js"), true);
  assert.equal(ignored("/node_modules/@huggingface/tokenizers/dist/tokenizers.mjs"), true);
});

test("Windows release packaging fails closed without explicit signing configuration", () => {
  assert.throws(
    () => windowsReleasePackagingConfig({ MOSA_RELEASE_DISTRIBUTION: "production" }),
    /MOSA_WINDOWS_SIGNER_THUMBPRINT/,
  );
  assert.throws(
    () => windowsReleasePackagingConfig({
      MOSA_RELEASE_DISTRIBUTION: "production",
      MOSA_WINDOWS_SIGNER_THUMBPRINT: "A".repeat(40),
    }),
    /requires a signing source/,
  );
});

test("Windows release packaging enables SHA-256 Authenticode signing", () => {
  const config = windowsReleasePackagingConfig({
    MOSA_RELEASE_DISTRIBUTION: "production",
    MOSA_WINDOWS_SIGNER_THUMBPRINT: "A".repeat(40),
    WINDOWS_CERTIFICATE_FILE: "C:\\secrets\\mosa.pfx",
    WINDOWS_CERTIFICATE_PASSWORD: "secret",
  });
  assert.equal(config.windowsSign.continueOnError, false);
  assert.deepEqual(config.windowsSign.hashes, ["sha256"]);
  assert.equal(config.windowsSign.certificateFile, "C:\\secrets\\mosa.pfx");
  assert.equal(config.windowsSign.certificatePassword, "secret");
});

test("desktop icon source generates valid macOS and Windows icon containers", async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), "mosa-desktop-icons-"));
  deferTestPathRemoval(outputDir, { recursive: true, force: true });

  const source = await readFile(DESKTOP_ICON_SOURCE_PATH, "utf8");
  assert.match(source, /<rect x="100" y="100" width="824" height="824" rx="185" fill="#FCFBF8"\/>/);
  assert.match(source, /<circle cx="95\.81" cy="60" r="7\.88" fill="#C9A45C"\/>/);

  const paths = await generateDesktopIcons({ outputDir });
  const [icns, ico, png] = await Promise.all([
    readFile(paths.icns),
    readFile(paths.ico),
    readFile(paths.png),
  ]);

  assert.equal(icns.subarray(0, 4).toString("ascii"), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length);
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 7);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test("release packaging fails closed when Apple signing credentials are incomplete", () => {
  assert.throws(
    () => macReleasePackagingConfig({ MOSA_RELEASE_DISTRIBUTION: "production" }),
    /MOSA release build requires: MOSA_MACOS_SIGN_IDENTITY, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID/,
  );
  assert.throws(
    () => macReleasePackagingConfig({
      MOSA_RELEASE_DISTRIBUTION: "production",
      MOSA_MACOS_SIGN_IDENTITY: "Developer ID Application: Example",
      APPLE_ID: "release@example.com",
      APPLE_TEAM_ID: "TEAM123456",
    }),
    /APPLE_APP_SPECIFIC_PASSWORD/,
  );
});

test("release packaging enables Developer ID hardened signing and notarization", () => {
  const config = macReleasePackagingConfig({
    MOSA_RELEASE_DISTRIBUTION: "production",
    MOSA_MACOS_SIGN_IDENTITY: "Developer ID Application: Example (TEAM123456)",
    APPLE_ID: "release@example.com",
    APPLE_APP_SPECIFIC_PASSWORD: "app-specific-password",
    APPLE_TEAM_ID: "TEAM123456",
  });

  assert.equal(config.osxSign.identity, "Developer ID Application: Example (TEAM123456)");
  assert.equal(config.osxSign.identityValidation, true);
  assert.equal(config.osxSign.preAutoEntitlements, true);
  assert.equal(config.osxSign.strictVerify, true);
  assert.equal(config.osxSign.continueOnError, false);
  assert.deepEqual(config.osxSign.optionsForFile("/tmp/MOSA.app"), { hardenedRuntime: true });
  assert.deepEqual(config.osxNotarize, {
    appleId: "release@example.com",
    appleIdPassword: "app-specific-password",
    teamId: "TEAM123456",
  });
  assert.equal("tool" in config.osxNotarize, false, "Forge uses the current notarization credential shape");
});

test("preview packaging never requires platform signing credentials", () => {
  const mac = macReleasePackagingConfig({ MOSA_RELEASE_DISTRIBUTION: "preview" });
  assert.equal(mac.osxSign.identity, "-");
  assert.equal(mac.osxSign.identityValidation, false);
  assert.equal("osxNotarize" in mac, false);
  assert.deepEqual(windowsReleasePackagingConfig({ MOSA_RELEASE_DISTRIBUTION: "preview" }), {});
});

test("desktop package excludes every non-runtime project surface", () => {
  for (const path of [
    "/.github/workflows/verify.yml",
    "/.gitignore",
    "/AGENTS.md",
    "/assets/default/images/library-image.png",
    "/bin/mosa.mjs",
    "/CHANGELOG.md",
    "/COMMERCIAL-LICENSE.md",
    "/desktop/assets/mosa-app-icon.svg",
    "/desktop/forge.config.mjs",
    "/desktop/icon-assets.mjs",
    "/dist/lib/server-security.js",
    "/docs/operations.md",
    "/extensions/chatgpt-web-capture/manifest.json",
    "/lib/asset-sort.d.ts",
    "/lib/asset-sort.js.map",
    "/lib/asset-sort.ts",
    "/mcp/server.mjs",
    "/node_modules/.package-lock.json",
    "/node_modules/@electron/asar/lib/asar.js",
    "/node_modules/@img/sharp-darwin-x64/package.json",
    "/node_modules/@huggingface/tokenizers/dist/tokenizers.mjs",
    "/node_modules/eslint/lib/api.js",
    "/node_modules/onnxruntime-common/dist/cjs/index.js",
    "/node_modules/onnxruntime-node/dist/index.js",
    "/out/MOSA-darwin-arm64/MOSA.app/Contents/Info.plist",
    "/package-lock.json",
    "/README.md",
    "/scripts/check-source.mjs",
    "/server.mjs",
    "/test/desktop-packaging.test.mjs",
    "/tsconfig.json",
    "/web/legacy-ui/index.html",
  ]) {
    assert.equal(isIgnored(path), true, `${path} must stay out of the desktop package`);
  }
});

test("desktop package keeps every required runtime surface", () => {
  for (const path of [
    "/LICENSE",
    "/package.json",
    "/web/gravityport/dist/index.html",
    "/web/gravityport/dist/build-identity.json",
    "/desktop/main.mjs",
    "/desktop/notification-i18n.mjs",
    "/desktop/platform/index.mjs",
    "/desktop/preload.cjs",
    "/desktop/service-manager.mjs",
    "/lib/api/asset-routes.mjs",
    "/lib/asset-sort.js",
    "/lib/mosa-runtime.mjs",
    "/lib/runtime-isolation-guard.mjs",
    "/node_modules/better-sqlite3/lib/index.js",
    "/node_modules/better-sqlite3/prebuilds/darwin-arm64.node",
    "/node_modules/detect-libc/lib/detect-libc.js",
    "/node_modules/node-addon-api/index.js",
    "/node_modules/semver/index.js",
    "/node_modules/sharp/dist/index.cjs",
    "/node_modules/@img/colour/index.cjs",
    "/node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64-0.35.3.node",
    "/node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.3.dylib",
  ]) {
    assert.equal(isIgnored(path), false, `${path} must remain available to the desktop runtime`);
  }
});

test("reduces the packaged dependency tree to arm64 runtime files", async (t) => {
  const buildPath = await mkdtemp(join(tmpdir(), "mosa-desktop-package-"));
  deferTestPathRemoval(buildPath, { recursive: true, force: true });
  const packageDir = join(buildPath, "node_modules", "better-sqlite3");
  const metadataPath = join(packageDir, "build", "config.gypi");
  const bindingPath = join(packageDir, "prebuilds", "darwin-arm64.node");
  const foreignBindingPath = join(packageDir, "prebuilds", "linux-x64.node");
  const sqliteSourcePath = join(packageDir, "src", "addon.cpp");
  const sharpRuntimePath = join(buildPath, "node_modules", "sharp", "dist", "index.cjs");
  const sharpTypePath = join(buildPath, "node_modules", "sharp", "dist", "index.d.cts");
  const nodeAddonPath = join(buildPath, "node_modules", "node-addon-api", "index.js");
  const sharpBindingDir = join(buildPath, "node_modules", "@img", "sharp-darwin-arm64");
  const sharpLibvipsDir = join(buildPath, "node_modules", "@img", "sharp-libvips-darwin-arm64");
  await mkdir(join(packageDir, "build"), { recursive: true });
  await mkdir(join(packageDir, "prebuilds"), { recursive: true });
  await mkdir(join(packageDir, "src"), { recursive: true });
  await mkdir(join(buildPath, "node_modules", "sharp", "dist"), { recursive: true });
  await mkdir(join(buildPath, "node_modules", "node-addon-api"), { recursive: true });
  await mkdir(sharpBindingDir, { recursive: true });
  await mkdir(sharpLibvipsDir, { recursive: true });
  await writeFile(metadataPath, "local_prefix=/Users/example/project\n");
  await writeFile(bindingPath, "binding");
  await writeFile(foreignBindingPath, "foreign binding");
  await writeFile(sqliteSourcePath, "source");
  await writeFile(sharpRuntimePath, "runtime");
  await writeFile(sharpTypePath, "types");
  await writeFile(nodeAddonPath, "build helper");
  await writeFile(
    join(buildPath, "package.json"),
    JSON.stringify({
      name: "mosa",
      version: "0.2.0",
      private: true,
      license: "test-license",
      type: "module",
      main: "desktop/main.mjs",
      config: { forge: "desktop/forge.config.mjs" },
      scripts: { test: "node --test" },
      bin: { mosa: "bin/mosa.mjs" },
      engines: { node: ">=22" },
      dependencies: { "@huggingface/tokenizers": "1", "better-sqlite3": "1", "onnxruntime-node": "1", sharp: "1" },
      devDependencies: { electron: "1" },
    }),
  );

  await preparePackagedRuntime(buildPath);

  await assert.rejects(access(metadataPath));
  await assert.rejects(access(foreignBindingPath));
  await assert.rejects(access(sqliteSourcePath));
  await assert.rejects(access(sharpTypePath));
  await assert.rejects(access(nodeAddonPath));
  await access(bindingPath);
  await access(sharpRuntimePath);
  await access(sharpBindingDir);
  await access(sharpLibvipsDir);
  assert.deepEqual(JSON.parse(await readFile(join(buildPath, "package.json"), "utf8")), {
    name: "mosa",
    version: "0.2.0",
    private: true,
    license: "test-license",
    type: "module",
    main: "desktop/main.mjs",
    engines: { node: ">=22" },
    dependencies: { "better-sqlite3": "1", sharp: "1" },
  });
});

test("reduces a Windows package to win32-x64 native runtime files", async (t) => {
  const buildPath = await mkdtemp(join(tmpdir(), "mosa-desktop-package-win32-"));
  deferTestPathRemoval(buildPath, { recursive: true, force: true });
  const packageDir = join(buildPath, "node_modules", "better-sqlite3");
  const windowsBinding = join(packageDir, "prebuilds", "win32-x64.node");
  const macBinding = join(packageDir, "prebuilds", "darwin-arm64.node");
  const windowsSharp = join(buildPath, "node_modules", "@img", "sharp-win32-x64");
  await mkdir(join(packageDir, "prebuilds"), { recursive: true });
  await mkdir(windowsSharp, { recursive: true });
  await writeFile(windowsBinding, "windows binding");
  await writeFile(macBinding, "mac binding");
  await writeFile(join(buildPath, "package.json"), JSON.stringify({
    name: "mosa",
    version: "0.2.0",
    private: true,
    license: "test-license",
    type: "module",
    main: "desktop/main.mjs",
    engines: { node: ">=22" },
    dependencies: { "better-sqlite3": "1", sharp: "1" },
  }));

  const target = resolveDesktopPackagingTarget({ platform: "win32", arch: "x64", env: {}, argv: [] });
  await preparePackagedRuntime(buildPath, target);

  await access(windowsBinding);
  await access(windowsSharp);
  await assert.rejects(access(macBinding));
});

test("Windows packaging fails closed with actionable cross-packaging guidance when target Sharp is absent", async (t) => {
  const buildPath = await mkdtemp(join(tmpdir(), "mosa-desktop-package-win32-missing-sharp-"));
  deferTestPathRemoval(buildPath, { recursive: true, force: true });
  const packageDir = join(buildPath, "node_modules", "better-sqlite3");
  await mkdir(join(packageDir, "prebuilds"), { recursive: true });
  await writeFile(join(packageDir, "prebuilds", "win32-x64.node"), "windows binding");

  const target = resolveDesktopPackagingTarget({ platform: "win32", arch: "x64", env: {}, argv: [] });
  await assert.rejects(
    preparePackagedRuntime(buildPath, target),
    /Missing Sharp runtime for win32-x64: @img\/sharp-win32-x64[\s\S]*Build win32-x64 on Windows\/CI[\s\S]*cross-packaging requires the target OS optional Sharp package/,
  );
});

test("desktop:start has a native Windows launch path while preserving the macOS GUI workaround", async () => {
  const source = await readFile(resolve(import.meta.dirname, "..", "scripts", "desktop-start.mjs"), "utf8");
  assert.match(source, /process\.platform === "darwin"/);
  assert.match(source, /process\.platform === "win32"/);
  assert.match(source, /electron\.exe/);
  assert.match(source, /Using the native Windows Electron launch path/);
  assert.match(source, /tryOpenViaLaunchServices\(\)/);
  assert.match(source, /tryOpenViaTerminal\(\)/);
});

test("keeps the desktop window single-instance and sandboxed", async () => {
  const source = await readFile(resolve(import.meta.dirname, "..", "desktop", "main.mjs"), "utf8");
  assert.match(source, /app\.requestSingleInstanceLock\(\)/);
  assert.match(source, /desktopPlatformAdapter\(\)/);
  assert.match(source, /app\.on\("window-all-closed", \(\) => \{[\s\S]*?if \(runtimeRecoveryInProgress\) return;[\s\S]*?desktopPlatform\.onWindowAllClosed\(app\);[\s\S]*?\}\)/,
    "internal runtime recovery must not look like a user quit on Windows");
  assert.match(source, /\.\.\.desktopPlatform\.windowOptions\(\)/);
  assert.match(source, /desktopPlatform\.capabilities\.hideApplicationMenuBar/);
  assert.match(source, /mainWindow\.setMenuBarVisibility\(false\)/);
  assert.match(source, /startMosaService/);
  assert.match(source, /DEFAULT_MOSA_DESKTOP_PORT/);
  assert.match(source, /const desktopDataDir = app\.getPath\("userData"\)/);
  // Library location resolution moved into lib/library-location.mjs; the
  // desktop shell passes userInfo().homedir (not homedir()) so sandboxed
  // HOME rewrites cannot fork an empty library, and it must never spell a
  // default folder itself. A location file that cannot be honored stops the
  // app with the localized error dialog instead of silently falling back.
  assert.match(source, /const homeDir = userInfo\(\)\.homedir;/);
  assert.match(source, /resolveLibraryLocation\(\{[\s\S]*?homeDir,[\s\S]*?envLibraryDir: process\.env\.MOSA_LIBRARY_DIR,[\s\S]*?locationFile: LIBRARY_LOCATION_PATH/);
  assert.doesNotMatch(source, /join\(userInfo\(\)\.homedir, "MOSA Library"\)/);
  assert.doesNotMatch(source, /loadSavedLibraryDir/);
  assert.match(source, /showLibraryLocationErrorAndExit/);
  assert.match(source, /MOSA_LIBRARY_NOT_FOUND/);
  assert.doesNotMatch(source, /homedir\(\).*MOSA Library/);
  assert.match(source, /failOnPrimaryLibraryMismatch: true/);
  assert.match(source, /cowartProjectDir: desktopDataDir/);
  assert.match(source, /const clientUrl = new URL\(activeService\.url\)/);
  assert.match(source, /clientUrl\.hash = `mosa-client-token=/);
  assert.match(source, /windowRef\.loadURL\(clientUrl\.toString\(\)\)/);
  assert.match(source, /const startupShellPath = fileURLToPath\(new URL\("\.\/startup\.html"/);
  assert.match(source, /await windowRef\.loadFile\(startupShellPath\)/);
  assert.match(source, /serviceManagerModulePromise \|\|= import\("\.\/service-manager\.mjs"\)/);
  assert.match(source, /if \(serviceStartPromise\) return serviceStartPromise;/,
    "concurrent window activation must share one runtime startup transaction");
  assert.match(source, /windowOpenRequested = true;[\s\S]*?if \(windowPromise\) return windowPromise;[\s\S]*?do \{[\s\S]*?windowOpenRequested = false;[\s\S]*?await createMainWindow\(\);[\s\S]*?while \(!shuttingDown && windowOpenRequested/,
    "closing the startup shell followed by Dock/second-instance activation must queue a replacement window");
  assert.doesNotMatch(source, /^import .*service-manager\.mjs/m,
    "the heavy runtime/service graph must stay off the pre-window module-evaluation path");
  assert.ok(
    source.indexOf("await windowRef.loadFile(startupShellPath)") < source.indexOf("const activeService = await ensureDesktopService()"),
    "the startup shell must paint before importing and waiting for runtime readiness",
  );
  assert.match(source, /app\.on\("before-quit"/);
  assert.match(source, /service\?\.mode === "owned"/);
  assert.match(source, /contextIsolation: true/);
  assert.match(source, /nodeIntegration: false/);
  assert.match(source, /sandbox: true/);
  assert.match(source, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(source, /webContents\.on\("will-navigate", blockForeignNavigation\)/);
  assert.match(source, /webContents\.on\("will-redirect", blockForeignNavigation\)/);
  assert.match(source, /setPermissionCheckHandler\(\(\) => false\)/);
  assert.match(source, /setPermissionRequestHandler\(\(_webContents, _permission, callback\) => callback\(false\)\)/);
  assert.match(source, /const controller = new AbortController\(\);[\s\S]*?BRIDGE_POLL_TIMEOUT_MS[\s\S]*?await fetch\([\s\S]*?signal: controller\.signal[\s\S]*?const data = await response\.json\(\);[\s\S]*?bridgePollFailures = 0;/,
    "runtime health polling must be bounded and only reset failures after a fully parsed response");
  assert.doesNotMatch(source, /setInterval\(async \(\) =>[\s\S]*?\/api\/bridges/,
    "runtime health checks must not overlap through an async setInterval");
  assert.match(source, /app\.exit\(0\)/);
  assert.match(
    source,
    /if \(shuttingDown\) \{[\s\S]*startup load aborted during shutdown/,
    "shutdown must not surface a false startup error dialog",
  );

  // The React viewer renders media internally: images and videos both mount
  // inside .viewer-stage as .viewer-image elements instead of external windows.
  const viewerSource = await readFile(resolve(import.meta.dirname, "..", "web", "gravityport", "src", "ImageViewer.tsx"), "utf8");
  assert.match(viewerSource, /img className="viewer-image"/);
  assert.match(viewerSource, /video className="viewer-image"/);
  const appSource = await readFile(resolve(import.meta.dirname, "..", "web", "gravityport", "src", "App.tsx"), "utf8");
  assert.match(appSource, /setPreview\(true\)/);
});

test("packaged smoke waits for the real renderer and tears Electron down before cleanup", async () => {
  const source = await readFile(resolve(import.meta.dirname, "..", "scripts", "packaged-smoke.mjs"), "utf8");
  const apiClientSource = await readFile(resolve(import.meta.dirname, "..", "web", "gravityport", "src", "mosa-api.ts"), "utf8");
  assert.match(source, /--remote-debugging-port=/, "packaged smoke must inspect the packaged renderer");
  assert.match(source, /waitForRenderer\(/, "packaged smoke must wait for renderer readiness");
  assert.match(source, /document\.querySelector\('\.app'\)/, "renderer readiness must require the real MOSA app shell");
  assert.match(source, /window\.electronAPI/, "renderer readiness must verify preload exposure");
  assert.match(source, /sessionStorage.*mosa\.client-token/, "packaged smoke must reuse the real renderer client capability");
  assert.match(source, /"x-mosa-client-token": clientToken/, "packaged smoke mutations must authenticate with that capability");
  // The React adapter memoizes the bootstrap capability and consumes it at
  // module load; every request helper reads the same memoized token.
  const tokenFactory = apiClientSource.indexOf("function takeBootstrapToken()");
  const moduleConsume = apiClientSource.indexOf("if (typeof window !== \"undefined\") takeBootstrapToken()");
  assert.ok(tokenFactory >= 0 && moduleConsume > tokenFactory,
    "the API adapter must consume the bootstrap capability at module load");
  assert.match(apiClientSource, /takeBootstrapToken\(\)/, "request helpers must read the memoized capability");
  assert.match(source, /await stopChild\(.*\.child\)/, "cleanup must wait for Electron teardown");
  assert.match(source, /signalProcessTree\(childProcess\.pid, \{ force: true \}\)/, "teardown must have a bounded process-tree hard-stop fallback");
});

test("the packaged app keeps the shared web UI tree and its build identity", () => {
  // The built GravityPort bundle is the single packaged UI surface, shared
  // with the browser; its generated build-identity.json must not be filtered
  // out by the forge ignore rules. /web itself must stay allowed too: the
  // packager matches directory entries against the ignore rules.
  assert.equal(isIgnored("/web"), false);
  assert.equal(isIgnored("/web/gravityport"), false);
  assert.equal(isIgnored("/web/gravityport/dist"), false);
  assert.equal(isIgnored("/web/gravityport/dist/build-identity.json"), false);
  assert.equal(isIgnored("/web/gravityport/dist/index.html"), false);
  assert.equal(isIgnored("/web/gravityport/dist/assets/index.js"), false);
  assert.equal(isIgnored("/desktop/startup.html"), false);
  assert.equal(isIgnored("/lib/build-identity.mjs"), false);
  assert.equal(isIgnored("/desktop/preload.cjs"), false);
  // Anything under /web outside web/app must stay out of the desktop bundle,
  // as must root-level UI copies.
  assert.equal(isIgnored("/web/legacy-ui/index.html"), true);
  assert.equal(isIgnored("/web/notes.md"), true);
  assert.equal(isIgnored("/app/app.mjs"), true);
  // The UI sources and dependencies live outside the shipped build output.
  assert.equal(isIgnored("/web/gravityport/src/App.tsx"), true);
  assert.equal(isIgnored("/web/gravityport/node_modules/react/index.js"), true);
});

// The dedicated Finder IPC was retired after renderer actions converged on the
// validated /api/open-folder route. Keep it retired without expanding preload authority.
test("retired show-in-folder IPC stays removed without expanding renderer authority", async () => {
  const preload = await readFile(resolve(import.meta.dirname, "..", "desktop", "preload.cjs"), "utf8");
  const main = await readFile(resolve(import.meta.dirname, "..", "desktop", "main.mjs"), "utf8");

  assert.doesNotMatch(preload, /showItemInFolder|show-item-in-folder/);
  assert.doesNotMatch(main, /ipcMain\.handle\("show-item-in-folder",/);
  // preload 其余 API 不变，不向 renderer 暴露 shell 对象或任意命令执行能力。
  for (const api of ["pasteImage", "setLocale", "onMenuSearch"]) {
    assert.match(preload, new RegExp(`${api}:`), `preload keeps exposing ${api}`);
  }
  // Dead IPC channels stay removed rather than expanding renderer authority.
  assert.doesNotMatch(preload, /getPathForFile:/, "getPathForFile was removed as dead code");
  assert.doesNotMatch(preload, /stage-dropped-file/, "stage-dropped-file IPC was removed as dead code");
  assert.doesNotMatch(preload, /openFileDialog:/, "unused open-file dialog IPC was removed");
  assert.doesNotMatch(main, /ipcMain\.handle\("open-file-dialog"/, "unused open-file dialog handler was removed");
  // 任务 96（A6）：第 18 条批准通道 set-window-full-screen（大图页全屏与窗口系统全屏同步）。
  // 任务 116：第 19/20 条 rename-notice-state / acknowledge-rename-notice（老用户「已更名」提示）。
  // 任务 135：第 21 条 open-pinterest-authorize（Pinterest 授权页，只放行 https://www.pinterest.com/oauth/）。
  assert.equal(preload.split("ipcRenderer.invoke").length - 1, 21, "no invoke channel beyond the currently approved narrow requests (Visual Pack lifecycle remains named and URL-free)");
  assert.doesNotMatch(preload, /shell\s*[:.]/, "shell is never exposed to the renderer");
  assert.doesNotMatch(preload, /exec\(|spawn\(|execFile\(/, "no arbitrary command execution");

  // packaged app 的 sandbox preload 使用相对 main.mjs 解析出的绝对 CommonJS 路径。
  assert.match(main, /const preloadPath = fileURLToPath\(new URL\("\.\/preload\.cjs", import\.meta\.url\)\);/);
  assert.match(main, /preload: preloadPath/);
  assert.equal(isIgnored("/desktop/preload.cjs"), false);
});
