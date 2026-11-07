import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createAssetStore } from "../lib/asset-store.mjs";
import { createCowartBridgeManager } from "../lib/cowart-bridge-manager.js";
import { createCowartProjectRegistry } from "../lib/cowart-project-registry.js";
import { pngBytes } from "./helpers/managed-media.mjs";

test("archives registered project-local Cowart canvases", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-manager-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const projectRoot = join(root, "workspace");
  const managerDir = join(projectRoot, "mosa");
  const firstProject = join(root, "first-project");
  const secondProject = join(root, "second-project");
  await Promise.all([
    writeCowartImage(firstProject, "first-project-image.png", "第一项目画布图"),
    writeCowartImage(secondProject, "second-project-image.png", "第二项目画布图"),
  ]);

  const store = createAssetStore({
    projectRoot,
    managerDir,
    cowartCanvasDir: join(root, "cowart-data", "mosa"),
  });
  await assert.rejects(
    store.createAsset({ imagePath: join(firstProject, "canvas", "pages", "page", "assets", "first-project-image.png") }),
    /Refusing to import outside the project roots/,
  );
  const registry = createCowartProjectRegistry({
    managerDir,
    registryPath: join(root, "state", "cowart-projects.json"),
  });
  const first = await registry.addProject({ projectDir: firstProject });
  const second = await registry.addProject({ projectDir: secondProject });
  assert.equal((await registry.addProject({ projectDir: firstProject })).created, false);

  const manager = createCowartBridgeManager({ store, registry, managerDir });
  t.after(() => manager.stop());
  await manager.start();

  const assets = await store.listAssets({ projectId: "default" });
  assert.equal(assets.length, 2);
  assert.deepEqual(
    new Set(assets.map((asset) => asset.source.cowart_project_dir)),
    new Set([first.project.projectDir, second.project.projectDir]),
  );
  assert.deepEqual(
    new Set(assets.map((asset) => asset.source.cowart_source_id)),
    new Set([first.project.id, second.project.id]),
  );

  const status = manager.status();
  assert.equal(status.registeredCount, 2);
  assert.equal(status.monitoredCount, 3);
  assert.equal(status.sources.length, 3);
  assert.equal(status.sources.find((source) => source.id === first.project.id)?.canvasDir, join(first.project.projectDir, "canvas"));

  await manager.removeProject(first.project.id);
  assert.equal(manager.status().registeredCount, 1);
  assert.deepEqual((await registry.list()).map((project) => project.id), [second.project.id]);
});

test("requires a trusted Cowart canvas for newly registered projects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-registry-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const registryPath = join(root, "state", "cowart-projects.json");
  const registry = createCowartProjectRegistry({ registryPath });

  const projectWithoutCanvas = join(root, "no-canvas-project");
  await mkdir(projectWithoutCanvas, { recursive: true });
  const projectWithoutMarkers = join(root, "no-marker-project");
  await mkdir(join(projectWithoutMarkers, "canvas"), { recursive: true });
  // A canvas symlinked into an outside directory holding real markers: stat()
  // would follow it, so the trust check must reject it via lstat().
  const externalCanvas = join(root, "external-canvas");
  await mkdir(externalCanvas, { recursive: true });
  await writeFile(join(externalCanvas, "cowart-view-state.json"), "{}\n", "utf8");
  const symlinkedProject = join(root, "symlinked-project");
  await mkdir(symlinkedProject, { recursive: true });
  await symlink(externalCanvas, join(symlinkedProject, "canvas"), "dir");

  await assert.rejects(registry.addProject({ projectDir: "relative-project" }), /absolute directory/);
  await assert.rejects(registry.addProject({ projectDir: `${root}/no-canvas-project/../no-marker-project` }), /must not contain '\.\.' path segments/);
  await assert.rejects(registry.addProject({ projectDir: join(root, "missing-project") }), /does not exist/);
  await assert.rejects(registry.addProject({ projectDir: projectWithoutCanvas }), /canvas directory does not exist/);
  await assert.rejects(registry.addProject({ projectDir: projectWithoutMarkers }), /does not contain any Cowart marker files/);
  await assert.rejects(registry.addProject({ projectDir: symlinkedProject }), /symbolic link/);

  // Rejected registrations must not write the registry or create canvas directories.
  await assert.rejects(readFile(registryPath, "utf8"), /ENOENT/);
  assert.equal(existsSync(join(projectWithoutCanvas, "canvas")), false);
  assert.deepEqual(await readdir(join(projectWithoutMarkers, "canvas")), []);
  assert.deepEqual(await readdir(externalCanvas), ["cowart-view-state.json"], "rejected registrations must not write into an external canvas");
});

test("legacy registry entries without a trusted Cowart canvas stay lazy at startup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-legacy-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "workspace");
  const managerDir = join(projectRoot, "mosa");
  const emptyProject = join(root, "empty-project");
  const noMarkerProject = join(root, "no-marker-project");
  const missingProject = join(root, "missing-project");
  const symlinkedProject = join(root, "symlinked-project");
  await mkdir(emptyProject, { recursive: true });
  await mkdir(join(noMarkerProject, "canvas"), { recursive: true });
  // A canvas symlinked into an outside directory holding real Cowart markers.
  const externalCanvas = join(root, "external-canvas");
  await mkdir(externalCanvas, { recursive: true });
  await writeFile(join(externalCanvas, "cowart-view-state.json"), "{}\n", "utf8");
  await mkdir(symlinkedProject, { recursive: true });
  await symlink(externalCanvas, join(symlinkedProject, "canvas"), "dir");

  // A registry written before registration validation existed: entries point at
  // an empty directory, a canvas without markers, a deleted project, and a
  // symlinked canvas that escapes its project directory.
  const registryPath = join(root, "state", "cowart-projects.json");
  await mkdir(dirname(registryPath), { recursive: true });
  const legacyRegistry = {
    version: 1,
    projects: [
      { projectDir: emptyProject, addedAt: "2026-01-01T00:00:00.000Z" },
      { projectDir: noMarkerProject, addedAt: "2026-01-02T00:00:00.000Z" },
      { projectDir: missingProject, addedAt: "2026-01-03T00:00:00.000Z" },
      { projectDir: symlinkedProject, addedAt: "2026-01-04T00:00:00.000Z" },
    ],
  };
  await writeFile(registryPath, `${JSON.stringify(legacyRegistry, null, 2)}\n`, "utf8");
  const registryBytesBefore = await readFile(registryPath, "utf8");

  const store = createAssetStore({
    projectRoot,
    managerDir,
    cowartCanvasDir: join(root, "cowart-data", "mosa"),
  });
  const registry = createCowartProjectRegistry({ managerDir, registryPath });
  const manager = createCowartBridgeManager({ store, registry, managerDir });
  t.after(() => manager.stop());
  const status = await manager.start();

  assert.equal(status.registeredCount, 4);
  assert.equal(status.monitoredCount, 1, "only the managed MOSA canvas may start");
  const externalSources = status.sources.filter((source) => !source.managed);
  assert.equal(externalSources.length, 4);
  for (const source of externalSources) {
    assert.equal(source.enabled, false, `untrusted entry must stay lazy: ${source.projectDir}`);
    assert.equal(source.trusted, false, `untrusted entry must be marked untrusted: ${source.projectDir}`);
    assert.ok(source.lastError, `untrusted entry must report a trust error: ${source.projectDir}`);
  }
  const symlinkedSource = externalSources.find((source) => source.projectDir === symlinkedProject);
  assert.match(symlinkedSource.lastError, /symbolic link/);

  // Starting must not create canvas directories or write into untrusted projects.
  assert.equal(existsSync(join(emptyProject, "canvas")), false);
  assert.deepEqual(await readdir(join(noMarkerProject, "canvas")), []);
  assert.deepEqual(await readdir(externalCanvas), ["cowart-view-state.json"], "startup must not write through the symlinked canvas");
  assert.equal(await readFile(registryPath, "utf8"), registryBytesBefore, "startup must not rewrite the registry");

  // The entries remain visible and removable.
  const [firstEntry] = await registry.list();
  const removed = await manager.removeProject(firstEntry.id);
  assert.equal(removed.projectDir, firstEntry.projectDir);
  assert.equal((await registry.list()).length, 3);
});

async function writeCowartImage(projectDir, fileName, altText) {
  const pageDir = join(projectDir, "canvas", "pages", "page");
  const assetsDir = join(pageDir, "assets");
  await mkdir(assetsDir, { recursive: true });
  // A registered project must prove itself with a real Cowart canvas marker.
  await writeFile(join(projectDir, "canvas", "cowart-view-state.json"), "{}\n", "utf8");
  await writeFile(join(assetsDir, fileName), await pngBytes());
  await writeFile(join(pageDir, "cowart-canvas.json"), JSON.stringify({
    store: {
      "asset:image": { id: "asset:image", typeName: "asset", type: "image", props: { name: fileName, src: `/page-assets/page/${fileName}` }, meta: {} },
      "shape:image": { id: "shape:image", typeName: "shape", type: "image", props: { assetId: "asset:image", w: 1200, h: 800, altText }, meta: {} },
    },
  }), "utf8");
}
