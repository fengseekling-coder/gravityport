import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile, readdir } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { uniquePngBytes } from "./helpers/unique-image.mjs";
import { DISABLEABLE_BRIDGES } from "../lib/runtime-bridges.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * Minimal 1×1 PNG (67 bytes) used as a fixture image so that createAsset can
 * resolve a readable source path without touching any real user media.
 */
// Manual imports of identical bytes now skip as already-in-library, so each
// imported fixture needs its own bytes (task 291).
async function createFixtureImage(dir, seed = 0) {
  const imagesDir = join(dir, "fixture-images");
  await mkdir(imagesDir, { recursive: true });
  const filePath = join(imagesDir, `fixture-${seed}.png`);
  await writeFile(filePath, await uniquePngBytes(seed));
  return filePath;
}

function runtimeOptions(root) {
  const libraryDir = join(root, "library");
  return {
    projectRoot: root,
    managerDir: repositoryRoot,
    cowartProjectDir: join(root, "desktop-data"),
    appDir: join(repositoryRoot, "web", "gravityport", "dist"),
    assetsRoot: join(libraryDir, "assets"),
    generatedImagesDir: join(root, "generated-images"),
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "codex-sessions"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-canvas"),
    cowartRegistryPath: join(root, "state", "cowart-projects.json"),
  };
}

async function snapshotDirectory(root) {
  const entries = [];
  async function visit(directory, prefix = "") {
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = join(prefix, child.name);
      const absolutePath = join(directory, child.name);
      if (child.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (child.isFile()) {
        const digest = createHash("sha256").update(await readFile(absolutePath)).digest("hex");
        entries.push([relativePath, digest]);
      }
    }
  }
  await visit(root);
  return entries;
}

function waitForServer(child) {
  return new Promise((resolveUrl, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for server startup: ${output}`)), 10_000);
    const onOutput = (chunk) => {
      output += chunk.toString();
      const match = output.match(/GravityPort: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolveUrl(match[1]);
      }
    };
    child.stdout.on("data", onOutput);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`server.mjs exited before startup (code=${code}, signal=${signal}): ${output}`));
    });
  });
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

describe("runtime isolation with all bridges disabled", () => {
  it("library contains only manually created fixtures", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "mosa-isolation-"));
    deferTestPathRemoval(root, { recursive: true, force: true });

    const libraryDir = join(root, "library");
    const opts = runtimeOptions(root);

    const runtime = await startMosaRuntime({
      ...opts,
      port: 0,
      libraryDir,
      disabledBridges: [...DISABLEABLE_BRIDGES],
    });
    t.after(() => runtime.stop());

    // Create 3 fixture assets via the HTTP API
    for (let i = 1; i <= 3; i++) {
      const res = await fetch(`${runtime.url}/api/assets/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          asset: `fixture-${i}`,
          imagePath: await createFixtureImage(root, i),
        }),
      });
      assert.equal(res.status, 200, `createAsset fixture-${i} should succeed`);
    }

    // Give bridges time to potentially scan (they shouldn't, since disabled)
    await new Promise((r) => setTimeout(r, 2000));

    // Verify total count is strictly 3
    const listRes = await fetch(`${runtime.url}/api/assets`);
    const listBody = await listRes.json();
    const assets = listBody.assets || [];
    assert.equal(assets.length, 3, "Library should contain exactly 3 assets");

    // Verify health endpoint reports the correct libraryDir
    const healthRes = await fetch(`${runtime.url}/api/health`);
    const healthBody = await healthRes.json();
    assert.equal(healthBody.libraryDir, libraryDir, "health should report the temp libraryDir");
  });
});

describe("disabledBridges validation", () => {
  it("throws on unknown bridge name", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "mosa-isolation-bad-"));
    deferTestPathRemoval(root, { recursive: true, force: true });

    const libraryDir = join(root, "library");
    const opts = runtimeOptions(root);

    await assert.rejects(
      startMosaRuntime({
        ...opts,
        port: 0,
        libraryDir,
        disabledBridges: ["webCapture"],
      }),
      (err) => {
        assert.match(err.message, /Unknown bridge name "webCapture"/);
        return true;
      },
    );
  });

  it("empty disabledBridges array starts normally", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "mosa-isolation-empty-"));
    deferTestPathRemoval(root, { recursive: true, force: true });

    const libraryDir = join(root, "library");
    const opts = runtimeOptions(root);

    const runtime = await startMosaRuntime({
      ...opts,
      port: 0,
      libraryDir,
      disabledBridges: [],
    });
    t.after(() => runtime.stop());

    const healthRes = await fetch(`${runtime.url}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthBody = await healthRes.json();
    assert.equal(healthBody.product, "mosa");
  });
});

describe("environment-only server startup isolation", () => {
  it("starts server.mjs from environment variables without touching manager assets", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "mosa-e2e-isolation-"));
    deferTestPathRemoval(root, { recursive: true, force: true });

    const libraryDir = join(root, "library");
    const managerAssets = await snapshotDirectory(join(repositoryRoot, "assets", "default"));
    const child = spawn(process.execPath, ["server.mjs"], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        MOSA_PORT: "0",
        MOSA_PROJECT_DIR: root,
        MOSA_LIBRARY_DIR: libraryDir,
        MOSA_DISABLE_BRIDGES: DISABLEABLE_BRIDGES.join(","),
        CODEX_GENERATED_IMAGES_DIR: join(root, "codex-images"),
        CODEX_SESSIONS_DIR: join(root, "codex-sessions"),
        GROK_SESSIONS_DIR: join(root, "grok-sessions"),
        COWART_MOSA_CANVAS_DIR: join(root, "cowart-canvas"),
        MOSA_COWART_REGISTRY_PATH: join(root, "state", "cowart-projects.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => stopServer(child));

    const url = await waitForServer(child);
    for (let i = 1; i <= 3; i++) {
      const response = await fetch(`${url}/api/assets/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ asset: `e2e-fixture-${i}`, imagePath: await createFixtureImage(root, i) }),
      });
      assert.equal(response.status, 200, `server.mjs should create fixture ${i}`);
    }

    const health = await (await fetch(`${url}/api/health`)).json();
    const library = await (await fetch(`${url}/api/library-path`)).json();
    const assets = await (await fetch(`${url}/api/assets?project=default`)).json();
    const page = await fetch(`${url}/`);
    assert.equal(page.status, 200);
    assert.equal(health.libraryDir, resolve(libraryDir));
    assert.equal(library.libraryDir, health.libraryDir);
    assert.equal(library.path, join(resolve(libraryDir), "assets", "default"));
    assert.equal(assets.assets.length, 3, "isolated server API should contain exactly three fixtures");
    assert.match(await page.text(), /assets\/index-[^"]+\.js/, "isolated server should serve the built UI shell");

    assert.deepEqual(
      await snapshotDirectory(join(repositoryRoot, "assets", "default")),
      managerAssets,
      "environment-only startup must not mutate the manager's default assets",
    );
  });

  it("fresh default startup selects SQLite without touching manager assets", async (t) => {
    const tempHome = await mkdtemp(join(tmpdir(), "mosa-no-lib-home-"));
    deferTestPathRemoval(tempHome, { recursive: true, force: true });

    // Canonical assets/default hash before: we expect no writes on startup
    const managerAssetsBefore = await snapshotDirectory(join(repositoryRoot, "assets", "default"));

    // Spawn server.mjs WITHOUT MOSA_LIBRARY_DIR. A machine without any library
    // starts fresh: the isolated home has neither default folder, so the new
    // GravityPort Library is created (lib/library-location.mjs rules 3–5).
    const child = spawn(process.execPath, ["server.mjs"], {
      cwd: repositoryRoot,
      env: {
        // os.homedir() resolves USERPROFILE on Windows and HOME elsewhere; a
        // fresh-install simulation must redirect both to stay portable.
        HOME: tempHome,
        USERPROFILE: tempHome,
        PATH: process.env.PATH,
        MOSA_PORT: "0",
        MOSA_PROJECT_DIR: repositoryRoot,
        // NO MOSA_LIBRARY_DIR set → fresh default SQLite library
        MOSA_DISABLE_BRIDGES: DISABLEABLE_BRIDGES.join(","),
        CODEX_SESSIONS_DIR: join(tempHome, ".codex", "sessions"),
        GROK_SESSIONS_DIR: join(tempHome, ".grok", "sessions"),
        COWART_MOSA_CANVAS_DIR: join(tempHome, ".codex", "cowart-data", "mosa"),
        MOSA_COWART_REGISTRY_PATH: join(tempHome, "state", "cowart-projects.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => stopServer(child));

    const url = await waitForServer(child);

    // Read the two diagnostic endpoints
    const health = await (await fetch(`${url}/api/health`)).json();
    const library = await (await fetch(`${url}/api/library-path`)).json();
    const page = await fetch(`${url}/`);

    // Both diagnostics must report the same fresh SQLite library.
    assert.equal(
      health.libraryDir,
      library.libraryDir,
      "health.libraryDir must equal library-path.libraryDir",
    );
    const expectedEffectiveLibraryDir = join(tempHome, "GravityPort Library");
    assert.equal(
      health.libraryDir,
      expectedEffectiveLibraryDir,
      "a machine without any library must start fresh in the new default under the isolated home",
    );
    assert.equal(health.storage, "sqlite");
    assert.equal(library.storage, "sqlite");

    // Path must match join(effectiveLibraryDir, "assets", "default")
    const expectedProjectPath = join(expectedEffectiveLibraryDir, "assets", "default");
    assert.equal(
      library.path,
      expectedProjectPath,
      "library-path.path must point at the SQLite asset root",
    );

    // Page served successfully
    assert.equal(page.status, 200);
    assert.match(await page.text(), /assets\/index-[^"]+\.js/, "fresh server startup must serve the built UI shell");

    // Verify canonical assets/default was NOT mutated (no writes on pure read)
    const managerAssetsAfter = await snapshotDirectory(join(repositoryRoot, "assets", "default"));
    assert.deepEqual(
      managerAssetsAfter,
      managerAssetsBefore,
      "fresh SQLite startup must not write to canonical assets/default",
    );
  });

  it("SQLite backend aligns health and library-path endpoints with the SQLite library directory", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "mosa-sqlite-contract-"));
    deferTestPathRemoval(root, { recursive: true, force: true });

    const libraryDir = join(root, "library");
    const fixtureImage = await createFixtureImage(root);

    // Seed a SQLite library so the runtime picks the sqlite storage backend.
    const { createSqliteAssetStore } = await import("../lib/sqlite-asset-store.mjs");
    const seeded = createSqliteAssetStore({ projectRoot: root, managerDir: repositoryRoot, libraryDir });
    await seeded.createAsset({ assetId: "sqlite-contract-fixture", imagePath: fixtureImage, prompt: "sqlite contract" });
    await seeded.setMigrationState("completed", { test: true });
    seeded.close();

    const child = spawn(process.execPath, ["server.mjs"], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        MOSA_PORT: "0",
        MOSA_PROJECT_DIR: root,
        MOSA_LIBRARY_DIR: libraryDir,
        MOSA_DISABLE_BRIDGES: DISABLEABLE_BRIDGES.join(","),
        CODEX_GENERATED_IMAGES_DIR: join(root, "codex-images"),
        CODEX_SESSIONS_DIR: join(root, "codex-sessions"),
        GROK_SESSIONS_DIR: join(root, "grok-sessions"),
        COWART_MOSA_CANVAS_DIR: join(root, "cowart-canvas"),
        MOSA_COWART_REGISTRY_PATH: join(root, "state", "cowart-projects.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => stopServer(child));

    const url = await waitForServer(child);

    const health = await (await fetch(`${url}/api/health`)).json();
    const library = await (await fetch(`${url}/api/library-path`)).json();

    // SQLite: the effective library directory is the SQLite libraryDir itself,
    // and both diagnostic endpoints must agree on it.
    assert.equal(health.storage, "sqlite", "seeded library should select the sqlite backend");
    assert.equal(health.libraryDir, resolve(libraryDir), "health must report the SQLite libraryDir");
    assert.equal(
      library.libraryDir,
      health.libraryDir,
      "health.libraryDir must equal library-path.libraryDir in the SQLite backend",
    );
    assert.equal(
      library.path,
      join(resolve(libraryDir), "assets", "default"),
      "library-path.path must equal join(libraryDir, 'assets', 'default') in the SQLite backend",
    );
  });
});
