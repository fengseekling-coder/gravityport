import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { getBuildIdentity, resetBuildIdentityCache, computeRuntimeFingerprint, computeUiFingerprint } from "../lib/build-identity.mjs";
import {
  RELEASE_MANIFEST_BACKUP_KEY_ID,
  RELEASE_MANIFEST_BACKUP_PUBLIC_KEY_PATH,
  createReleaseManifestTrust,
} from "../lib/release-manifest-signature.mjs";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { MCP_SERVER_VERSION, MOSA_SERVICE_PROTOCOL_VERSION } from "../lib/version-identities.mjs";
import { removeTestPath as rm, deferTestPathRemoval } from "./test-cleanup.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function makeTempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return dir;
}

function runtimeOptions(root, overrides = {}) {
  const libraryDir = join(root, "library");
  return {
    port: 0,
    projectRoot: root,
    managerDir: repositoryRoot,
    cowartProjectDir: join(root, "desktop-data"),
    appDir: join(repositoryRoot, "web", "gravityport", "dist"),
    libraryDir,
    assetsRoot: join(libraryDir, "assets"),
    generatedImagesDir: join(root, "generated-images"),
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "codex-sessions"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-canvas"),
    cowartRegistryPath: join(root, "state", "cowart-projects.json"),
    ...overrides,
  };
}

test("getBuildIdentity reads productVersion, Git, UI, and runtime fingerprints from build-identity.json", async () => {
  const tempAppDir = await makeTempDir("mosa-build-id-");
  t_after_cleanup(tempAppDir);
  await writeFile(join(tempAppDir, "build-identity.json"), JSON.stringify({
    productVersion: "1.2.3",
    gitSha: "abc123def456",
    uiFingerprint: "fingerprint-hash",
    runtimeFingerprint: "runtime-hash",
    distribution: "preview",
  }));
  resetBuildIdentityCache();
  const identity = getBuildIdentity(tempAppDir);
  assert.equal(identity.productVersion, "1.2.3");
  assert.equal(identity.gitSha, "abc123def456");
  assert.equal(identity.uiFingerprint, "fingerprint-hash");
  assert.equal(identity.runtimeFingerprint, "runtime-hash");
  assert.equal(identity.distribution, "preview");
  resetBuildIdentityCache();
});

test("getBuildIdentity returns unknown for all fields when build-identity.json is missing", () => {
  resetBuildIdentityCache();
  const identity = getBuildIdentity("/nonexistent/path/that/does/not/exist");
  assert.equal(identity.productVersion, "unknown");
  assert.equal(identity.gitSha, "unknown");
  assert.equal(identity.uiFingerprint, "unknown");
  assert.equal(identity.runtimeFingerprint, "unknown");
  assert.equal(identity.distribution, "development");
  resetBuildIdentityCache();
});

test("getBuildIdentity returns unknown for fields that are not strings", async () => {
  const tempAppDir = await makeTempDir("mosa-build-id-invalid-");
  t_after_cleanup(tempAppDir);
  await writeFile(join(tempAppDir, "build-identity.json"), JSON.stringify({
    productVersion: 123,
    gitSha: null,
    uiFingerprint: undefined,
    runtimeFingerprint: 123,
  }));
  resetBuildIdentityCache();
  const identity = getBuildIdentity(tempAppDir);
  assert.equal(identity.productVersion, "unknown");
  assert.equal(identity.gitSha, "unknown");
  assert.equal(identity.uiFingerprint, "unknown");
  assert.equal(identity.runtimeFingerprint, "unknown");
  assert.equal(identity.distribution, "development");
  resetBuildIdentityCache();
});

test("computeUiFingerprint hashes the browser entry files and every local ES module", async () => {
  const tempAppDir = await makeTempDir("mosa-fingerprint-");
  t_after_cleanup(tempAppDir);
  await writeFile(join(tempAppDir, "index.html"), "<html></html>");
  await writeFile(join(tempAppDir, "styles.css"), "body{}");
  await writeFile(join(tempAppDir, "app.mjs"), "console.log();");
  await writeFile(join(tempAppDir, "feature.mjs"), "export const enabled = true;");
  const fp1 = computeUiFingerprint(tempAppDir);
  assert.match(fp1, /^[0-9a-f]{64}$/);

  // Changing an imported module changes the fingerprint too.
  await writeFile(join(tempAppDir, "feature.mjs"), "export const enabled = false;");
  const fp2 = computeUiFingerprint(tempAppDir);
  assert.notEqual(fp1, fp2);

  // Reverting restores the original fingerprint.
  await writeFile(join(tempAppDir, "feature.mjs"), "export const enabled = true;");
  const fp3 = computeUiFingerprint(tempAppDir);
  assert.equal(fp1, fp3);
});

test("computeRuntimeFingerprint changes when runtime code changes", async () => {
  const root = await makeTempDir("mosa-runtime-fingerprint-");
  t_after_cleanup(root);
  await mkdir(join(root, "lib", "api"), { recursive: true });
  await writeFile(join(root, "server.mjs"), "export const server = 1;\n");
  await writeFile(join(root, "lib", "runtime.mjs"), "export const runtime = 1;\n");
  await writeFile(join(root, "lib", "api", "route.js"), "export const route = 1;\n");
  const first = computeRuntimeFingerprint(root);
  assert.match(first, /^[0-9a-f]{64}$/);
  await writeFile(join(root, "lib", "runtime.mjs"), "export const runtime = 2;\n");
  assert.notEqual(computeRuntimeFingerprint(root), first);
});

test("the repository web/gravityport/dist/ directory has a build-identity.json with valid fields", async () => {
  const appDir = join(repositoryRoot, "web", "gravityport", "dist");
  resetBuildIdentityCache();
  const identity = getBuildIdentity(appDir);
  assert.ok(identity.productVersion !== "unknown", "productVersion should be set by the build step");
  assert.ok(identity.gitSha !== "unknown", "gitSha should be set by the build step");
  assert.ok(identity.uiFingerprint !== "unknown", "uiFingerprint should be set by the build step");
  assert.ok(identity.runtimeFingerprint !== "unknown", "runtimeFingerprint should be set by the build step");
  assert.match(identity.uiFingerprint, /^[0-9a-f]{64}$/, "uiFingerprint should be a SHA-256 hex digest");
  assert.match(identity.runtimeFingerprint, /^[0-9a-f]{64}$/, "runtimeFingerprint should be a SHA-256 hex digest");
  resetBuildIdentityCache();
});

test("build identity exists only under web/gravityport/dist/, never at the repository root or the retired desktop UI copy", async () => {
  await assert.rejects(
    readFile(join(repositoryRoot, "build-identity.json"), "utf8"),
    (error) => error?.code === "ENOENT",
    "repository-root build-identity.json is a stale generated-file location and must stay absent",
  );
  await readFile(join(repositoryRoot, "web", "gravityport", "dist", "build-identity.json"), "utf8");
  // The desktop UI copy was removed; its build identity must not come back.
  const desktopDir = join(repositoryRoot, "desktop");
  await assert.rejects(
    readFile(join(desktopDir, "app", "build-identity.json"), "utf8"),
    (error) => error?.code === "ENOENT",
    "the retired desktop UI copy's build-identity.json must stay absent",
  );
});

test("uiFingerprint in build-identity.json matches the actual browser-delivered app shell", async () => {
  const appDir = join(repositoryRoot, "web", "gravityport", "dist");
  resetBuildIdentityCache();
  const identity = getBuildIdentity(appDir);
  const computed = computeUiFingerprint(appDir);
  assert.equal(identity.uiFingerprint, computed,
    "uiFingerprint in build-identity.json must match the hash of the actual UI files");
  resetBuildIdentityCache();
});

test("runtimeFingerprint in build-identity.json matches the actual local runtime code", async () => {
  const appDir = join(repositoryRoot, "web", "gravityport", "dist");
  resetBuildIdentityCache();
  const identity = getBuildIdentity(appDir);
  assert.equal(identity.runtimeFingerprint, computeRuntimeFingerprint(repositoryRoot));
  resetBuildIdentityCache();
});

test("/api/health returns product, protocol, MCP, Git, UI, and runtime build identities", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-health-build-id-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const service = await startMosaRuntime(runtimeOptions(root));
  t.after(() => service.stop());

  const response = await fetch(`${service.url}/api/health`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.product, "mosa");
  assert.equal(health.serviceProtocolVersion, MOSA_SERVICE_PROTOCOL_VERSION);
  assert.equal(typeof health.productVersion, "string");
  assert.equal(health.mcpServerVersion, MCP_SERVER_VERSION);
  assert.equal(typeof health.gitSha, "string");
  assert.equal(typeof health.uiFingerprint, "string");
  assert.equal(typeof health.runtimeFingerprint, "string");

  // Verify against the actual build-identity.json in web/gravityport/dist/
  resetBuildIdentityCache();
  const identity = getBuildIdentity(join(repositoryRoot, "web", "gravityport", "dist"));
  assert.equal(health.productVersion, identity.productVersion);
  assert.equal(health.gitSha, identity.gitSha);
  assert.equal(health.uiFingerprint, identity.uiFingerprint);
  assert.equal(health.runtimeFingerprint, identity.runtimeFingerprint);
  assert.equal(health.distribution, identity.distribution);
  resetBuildIdentityCache();
});

test("runtime health keeps the identity snapshot captured at process start", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-health-snapshot-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const tempAppDir = join(root, "app");
  await mkdir(tempAppDir, { recursive: true });
  const initialIdentity = {
    productVersion: "1.0.0",
    gitSha: "started-sha",
    uiFingerprint: "started-ui",
    runtimeFingerprint: "started-runtime",
  };
  await writeFile(join(tempAppDir, "build-identity.json"), JSON.stringify(initialIdentity));
  resetBuildIdentityCache();
  const service = await startMosaRuntime(runtimeOptions(root, { appDir: tempAppDir }));
  t.after(async () => {
    await service.stop();
    resetBuildIdentityCache();
  });

  await writeFile(join(tempAppDir, "build-identity.json"), JSON.stringify({
    productVersion: "1.0.0",
    gitSha: "newer-disk-sha",
    uiFingerprint: "newer-disk-ui",
    runtimeFingerprint: "newer-disk-runtime",
  }));
  resetBuildIdentityCache();

  const response = await fetch(`${service.url}/api/health`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.gitSha, initialIdentity.gitSha);
  assert.equal(health.uiFingerprint, initialIdentity.uiFingerprint);
  assert.equal(health.runtimeFingerprint, initialIdentity.runtimeFingerprint);
});

test("static resources served by the runtime match the built GravityPort bundle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-static-check-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const service = await startMosaRuntime(runtimeOptions(root));
  t.after(() => service.stop());

  const distDir = join(repositoryRoot, "web", "gravityport", "dist");
  const shell = await fetch(`${service.url}/`);
  assert.equal(shell.status, 200, "index.html should be served at the root");
  const servedShell = await shell.text();
  assert.equal(servedShell, await readFile(join(distDir, "index.html"), "utf-8"),
    "the served shell must match the built dist/index.html");
  // Every hashed bundle the shell references must be served byte-identical.
  const bundlePaths = [...servedShell.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
  assert.ok(bundlePaths.length >= 2, "the built shell must reference hashed js/css bundles");
  for (const bundlePath of bundlePaths) {
    const response = await fetch(`${service.url}${bundlePath}`);
    assert.equal(response.status, 200, `${bundlePath} should be served`);
    const served = Buffer.from(await response.arrayBuffer());
    const source = await readFile(join(distDir, bundlePath.replace(/^\//, "")));
    assert.ok(served.equals(source), `${bundlePath} served by the runtime must match the built file`);
  }
});

test("index.html does not use hardcoded ?v=NN query parameters for cache busting", async () => {
  const indexHtml = await readFile(join(repositoryRoot, "web", "gravityport", "dist", "index.html"), "utf-8");
  assert.doesNotMatch(indexHtml, /\?v=\d+["'\s>]/,
    "index.html must not rely on manual ?v=NN query strings; uiFingerprint is the source of truth");
});

test("the forge packaging config includes the built web/gravityport/dist/ resources", async () => {
  const forgeConfig = (await import("../desktop/forge.config.mjs")).default;
  const patterns = forgeConfig.packagerConfig.ignore;
  // The built GravityPort bundle is the single UI surface for browser and
  // Electron; verify-packaged-runtime reads web/gravityport/dist/build-identity.json
  // from the asar. The UI sources and node_modules next to it must ship.
  for (const kept of ["/web/gravityport/dist/index.html", "/web/gravityport/dist/build-identity.json", "/web/gravityport/dist/assets/index.js"]) {
    assert.ok(!patterns.some((p) => p.test(kept)), `${kept} must be packaged`);
  }
  for (const dropped of ["/web/gravityport/src/App.tsx", "/web/gravityport/node_modules/react/index.js", "/web/app/index.html"]) {
    assert.ok(patterns.some((p) => p.test(dropped)), `${dropped} must not be packaged`);
  }
});

test("desktop main.mjs derives the app root from its own module location, not app.getAppPath() or cwd", async () => {
  const source = await readFile(join(repositoryRoot, "desktop", "main.mjs"), "utf-8");
  // 静态 UI 根从 desktop/main.mjs 的模块位置派生：父目录即应用根（dev 解析为仓库根，packaged 解析为 app.asar 根）。
  assert.ok(source.includes('const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));'),
    "appRoot must be derived from the module location, not app.getAppPath()");
  // projectRoot、managerDir 使用同一个应用根。
  assert.ok(source.includes("projectRoot: appRoot"), "projectRoot must use appRoot");
  assert.ok(source.includes("managerDir: appRoot"), "managerDir must use appRoot");
  // Desktop serves the shared web UI: appDir points at the built
  // web/gravityport/dist in both dev and packaged runtimes.
  assert.ok(source.includes('appDir: join(appRoot, "web", "gravityport", "dist")'), "appDir must be appRoot/web/gravityport/dist");
  // 不再通过 app.getAppPath() 拼出 appDir，也不依赖 process.cwd()。
  assert.ok(!source.includes("app.getAppPath()"), "must not use app.getAppPath()");
  assert.ok(!source.includes("process.cwd()"), "must not use process.cwd()");
  // Renderer still loads the verified loopback service. The management
  // capability travels only in the URL fragment, which HTTP never receives.
  assert.ok(source.includes("const clientUrl = new URL(activeService.url)"), "must derive the renderer URL from the verified active service URL");
  assert.ok(source.includes("mosa-client-token="), "must deliver the management capability through the fragment");
  assert.ok(source.includes("windowRef.loadURL(clientUrl.toString())"), "must load the capability-bearing loopback URL");
  assert.ok(source.includes("windowRef.loadFile(startupShellPath)"), "startup may load only the packaged local shell before the verified loopback renderer");
  assert.ok(source.includes("preload: preloadPath"), "must keep the preload path");
  assert.ok(source.includes("sandbox: true"), "must keep the sandboxed renderer");
  assert.ok(source.includes('webContents.on("will-navigate", blockForeignNavigation)'), "must keep navigation blocking");
  assert.ok(source.includes('webContents.on("will-redirect", blockForeignNavigation)'), "must keep redirect blocking");
});

test("desktop capability bridge reports unavailable outside Electron", async () => {
  const bridgeSource = await readFile(join(repositoryRoot, "web", "gravityport", "src", "desktop.ts"), "utf-8");
  // The bridge accessor must return null when window.electronAPI is absent
  // so the UI falls back to its web behavior instead of guessing.
  assert.match(bridgeSource, /typeof window === "undefined"/);
  assert.match(bridgeSource, /window\.electronAPI/);
  assert.match(bridgeSource, /return api && typeof api === "object" \? api : null/);
});

// Helper to register cleanup for temp dirs created outside of test scope.
const cleanups = [];
function t_after_cleanup(dir) {
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
}
test.after(() => Promise.allSettled(cleanups.map((fn) => fn())));

// Build gate for the pinned release keys: runs the real scripts/write-build-identity.mjs
// inside a temp mini-repo so the real dist/ is never touched.
describe("write-build-identity pins the backup release-manifest key", () => {
  const gateVersion = "0.0.0-backup-key-test";
  const gateNotes = {
    schema: 2,
    unreleased: { zh: ["一条"], en: ["One"] },
    releases: [{ version: gateVersion, date: "2026-10-29", zh: ["说明"], en: ["Note"] }],
  };

  async function makeGateRepo() {
    const root = await mkdtemp(join(tmpdir(), "mosa-backup-key-gate-"));
    await mkdir(join(root, "scripts", "release-keys"), { recursive: true });
    await mkdir(join(root, "web", "gravityport", "dist"), { recursive: true });
    await cp(join(repositoryRoot, "lib"), join(root, "lib"), { recursive: true });
    await cp(join(repositoryRoot, "scripts", "write-build-identity.mjs"), join(root, "scripts", "write-build-identity.mjs"));
    await cp(
      join(repositoryRoot, RELEASE_MANIFEST_BACKUP_PUBLIC_KEY_PATH),
      join(root, RELEASE_MANIFEST_BACKUP_PUBLIC_KEY_PATH),
    );
    await cp(join(repositoryRoot, "server.mjs"), join(root, "server.mjs"));
    await writeFile(join(root, "package.json"), JSON.stringify({ version: gateVersion }), "utf8");
    await writeFile(join(root, "release-notes.json"), JSON.stringify(gateNotes), "utf8");
    await writeFile(join(root, "web", "gravityport", "dist", "index.html"), "<!doctype html>", "utf8");
    return root;
  }

  function runWriteBuildIdentity(root, extraEnv = {}) {
    const env = { ...process.env, ...extraEnv };
    delete env.MOSA_RELEASE_MANIFEST_PUBLIC_KEY;
    if (!("MOSA_RELEASE_MANIFEST_PUBLIC_KEY_FILE" in extraEnv)) delete env.MOSA_RELEASE_MANIFEST_PUBLIC_KEY_FILE;
    delete env.MOSA_RELEASE_DISTRIBUTION;
    try {
      execFileSync(process.execPath, [join(root, "scripts", "write-build-identity.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
      return { ok: true };
    } catch (error) {
      return { ok: false, stderr: String(error?.stderr || "") };
    }
  }

  it("writes the backup trust next to the primary trust, keyed to the pinned backup id", async () => {
    const root = await makeGateRepo();
    try {
      const primary = generateKeyPairSync("ed25519");
      const primaryFile = join(root, "primary.pem");
      await writeFile(primaryFile, primary.publicKey.export({ format: "pem", type: "spki" }).toString(), "utf8");
      const result = runWriteBuildIdentity(root, { MOSA_RELEASE_MANIFEST_PUBLIC_KEY_FILE: primaryFile });
      assert.equal(result.ok, true, result.stderr);
      const identity = JSON.parse(await readFile(join(root, "web", "gravityport", "dist", "build-identity.json"), "utf8"));
      assert.equal(identity.releaseManifestTrust.keyId, createReleaseManifestTrust(primary.publicKey).keyId);
      assert.equal(identity.releaseManifestBackupTrust.keyId, RELEASE_MANIFEST_BACKUP_KEY_ID);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes no backup trust for a development build without a primary key", async () => {
    const root = await makeGateRepo();
    try {
      const result = runWriteBuildIdentity(root);
      assert.equal(result.ok, true, result.stderr);
      const identity = JSON.parse(await readFile(join(root, "web", "gravityport", "dist", "build-identity.json"), "utf8"));
      assert.equal("releaseManifestTrust" in identity, false);
      assert.equal("releaseManifestBackupTrust" in identity, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to build when the committed backup public key has been swapped", async () => {
    const root = await makeGateRepo();
    try {
      const primary = generateKeyPairSync("ed25519");
      const primaryFile = join(root, "primary.pem");
      await writeFile(primaryFile, primary.publicKey.export({ format: "pem", type: "spki" }).toString(), "utf8");
      const otherPem = generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString();
      await writeFile(join(root, RELEASE_MANIFEST_BACKUP_PUBLIC_KEY_PATH), otherPem, "utf8");
      const result = runWriteBuildIdentity(root, { MOSA_RELEASE_MANIFEST_PUBLIC_KEY_FILE: primaryFile });
      assert.equal(result.ok, false);
      assert.match(result.stderr, /does not match the expected/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
