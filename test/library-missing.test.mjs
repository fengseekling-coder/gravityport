import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createAssetStore } from "../lib/asset-store.mjs";
import {
  defaultLibraryDir,
  desktopDefaultLocationFilePath,
  directoryHasLibrary,
  ensureSqliteMigrationMarker,
  hasLegacyJsonState,
  libraryHasManagedMedia,
  LIBRARY_DIR_NAME,
  MosaLibraryNotFoundError,
  resolveLibraryLocation,
  writeLibraryLocationFile,
  writeLibraryLocationFileIfMissing,
  writeLibraryLocationFromSuccessfulOpen,
} from "../lib/library-location.mjs";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { createMcpWorkspace, spawnMcpServerAsClient, startMcpServer, writePngFixture } from "./helpers/mcp-server-harness.mjs";

const SQLITE_MIGRATION_MARKER_FILE = ".sqlite-migration-completed";

async function tempHome(t, prefix = "mosa-libmissing-") {
  const home = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(home, { recursive: true, force: true });
  return home;
}

/** A healthy completed SQLite library created through the real store path. */
function seedCompletedSqliteLibrary({ projectRoot, libraryDir }) {
  const store = createAssetStore({
    projectRoot,
    managerDir: projectRoot,
    libraryDir,
    explicitLibraryDir: libraryDir,
    assetsRoot: join(libraryDir, "assets"),
    generatedImagesDir: join(libraryDir, "imports"),
  });
  store.close();
}

/** A database that exists but whose migration never completed. */
async function seedIncompleteSqliteLibrary(libraryDir) {
  await mkdir(libraryDir, { recursive: true });
  const database = new Database(join(libraryDir, "mosa.db"));
  database.exec("CREATE TABLE library_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);");
  database
    .prepare("INSERT INTO library_meta (key, value, updated_at) VALUES ('migration_state', 'migrating', ?)")
    .run(new Date().toISOString());
  database.close();
}

async function seedManagedImages(libraryDir) {
  const imagesDir = join(libraryDir, "assets", "default", "images");
  await mkdir(imagesDir, { recursive: true });
  await writeFile(join(imagesDir, "content-hash.png"), "fixture");
}

test("a healthy pre-marker library opens and the marker is backfilled exactly once", async (t) => {
  const home = await tempHome(t);
  const projectRoot = join(home, "project");
  const libraryDir = join(home, LIBRARY_DIR_NAME);
  seedCompletedSqliteLibrary({ projectRoot, libraryDir });
  // Simulate a library created before the marker existed.
  await rm(join(libraryDir, SQLITE_MIGRATION_MARKER_FILE));
  assert.equal(existsSync(join(libraryDir, SQLITE_MIGRATION_MARKER_FILE)), false);

  const first = createAssetStore({
    projectRoot,
    managerDir: projectRoot,
    libraryDir,
    explicitLibraryDir: libraryDir,
  });
  assert.equal(first.storageKind, "sqlite");
  first.close();
  const markerPath = join(libraryDir, SQLITE_MIGRATION_MARKER_FILE);
  assert.equal(existsSync(markerPath), true);
  assert.equal(await readFile(markerPath, "utf8"), "completed\n");

  // Opening again is a no-op on the marker (mtime unchanged) and still succeeds.
  const mtimeBefore = (await stat(markerPath)).mtimeMs;
  const second = createAssetStore({
    projectRoot,
    managerDir: projectRoot,
    libraryDir,
    explicitLibraryDir: libraryDir,
  });
  assert.equal(second.storageKind, "sqlite");
  second.close();
  assert.equal((await stat(markerPath)).mtimeMs, mtimeBefore);
});

test("ensureSqliteMigrationMarker writes atomically and never overwrites", async (t) => {
  const home = await tempHome(t);
  const libraryDir = join(home, "lib");
  await mkdir(libraryDir, { recursive: true });

  assert.equal(ensureSqliteMigrationMarker(libraryDir), true);
  assert.equal(await readFile(join(libraryDir, SQLITE_MIGRATION_MARKER_FILE), "utf8"), "completed\n");
  // A second call keeps the existing file untouched.
  await writeFile(join(libraryDir, SQLITE_MIGRATION_MARKER_FILE), "custom\n", "utf8");
  assert.equal(ensureSqliteMigrationMarker(libraryDir), true);
  assert.equal(await readFile(join(libraryDir, SQLITE_MIGRATION_MARKER_FILE), "utf8"), "custom\n");
});

test("a brand-new machine: the App path creates a library, the MCP path refuses and creates nothing", async (t) => {
  const home = await tempHome(t);

  // App path: defaults resolve to new-default-fresh and the store initializes.
  const resolution = resolveLibraryLocation({ homeDir: home });
  assert.equal(resolution.source, "new-default-fresh");
  const store = createAssetStore({
    projectRoot: home,
    managerDir: home,
    libraryDir: resolution.libraryDir,
    explicitLibraryDir: resolution.libraryDir,
  });
  assert.equal(store.storageKind, "sqlite");
  store.close();
  assert.equal(existsSync(join(defaultLibraryDir(home), SQLITE_MIGRATION_MARKER_FILE)), true);

  // MCP path: the same empty machine is a hard error and creates nothing.
  const emptyHome = await tempHome(t);
  assert.throws(
    () => resolveLibraryLocation({ homeDir: emptyHome, allowCreate: false }),
    (error) => error instanceof MosaLibraryNotFoundError,
  );
  assert.deepEqual(await readdir(emptyHome), []);
});

test("a marker without mosa.db is still reported as a missing migrated library", async (t) => {
  const home = await tempHome(t);
  const projectRoot = join(home, "project");
  const libraryDir = join(home, LIBRARY_DIR_NAME);
  seedCompletedSqliteLibrary({ projectRoot, libraryDir });
  await rm(join(libraryDir, "mosa.db"));

  assert.throws(
    () => createAssetStore({ projectRoot, managerDir: projectRoot, libraryDir, explicitLibraryDir: libraryDir }),
    // The desktop dialog and the MCP stderr both name the library from these.
    (error) => error?.code === "SQLITE_LIBRARY_MISSING"
      && error.libraryDir === resolve(libraryDir)
      && error.message.includes(resolve(libraryDir))
      && /mosa\.db/.test(error.message),
  );
});

test("managed media without mosa.db and without legacy metadata is an error, not a JSON fallback", async (t) => {
  const home = await tempHome(t);
  const projectRoot = join(home, "project");
  const libraryDir = join(home, LIBRARY_DIR_NAME);
  await seedManagedImages(libraryDir);
  assert.equal(libraryHasManagedMedia(libraryDir), true);
  // The tightened judgment: images alone are not legacy JSON state.
  assert.equal(hasLegacyJsonState({ libraryDir, explicitLibraryDir: libraryDir }), false);

  assert.throws(
    () => createAssetStore({ projectRoot, managerDir: projectRoot, libraryDir, explicitLibraryDir: libraryDir }),
    (error) => error?.code === "MOSA_LIBRARY_DATABASE_MISSING"
      && String(error.message).includes(resolve(libraryDir)),
  );
});

test("a database that is not completed without legacy JSON metadata is an error", async (t) => {
  const home = await tempHome(t);
  const projectRoot = join(home, "project");
  const libraryDir = join(home, LIBRARY_DIR_NAME);
  await seedIncompleteSqliteLibrary(libraryDir);

  assert.throws(
    () => createAssetStore({ projectRoot, managerDir: projectRoot, libraryDir, explicitLibraryDir: libraryDir }),
    (error) => error?.code === "MOSA_LIBRARY_STATE_INVALID",
  );
});

test("a database that is not completed with genuine legacy JSON metadata still opens as JSON", async (t) => {
  const home = await tempHome(t);
  const projectRoot = join(home, "project");
  const libraryDir = join(home, LIBRARY_DIR_NAME);
  await seedIncompleteSqliteLibrary(libraryDir);
  const metadataDir = join(libraryDir, "assets", "default", "metadata");
  await mkdir(metadataDir, { recursive: true });
  await writeFile(join(metadataDir, "asset-1.json"), JSON.stringify({ id: "asset-1", asset: "asset-1.png" }));

  const store = createAssetStore({ projectRoot, managerDir: projectRoot, libraryDir, explicitLibraryDir: libraryDir });
  assert.equal(store.storageKind, "json");
  store.close?.();
});

test("a genuine 0.1.x JSON library (metadata, no mosa.db) still opens as JSON", async (t) => {
  const home = await tempHome(t);
  const projectRoot = join(home, "project");
  const libraryDir = join(home, LIBRARY_DIR_NAME);
  const metadataDir = join(libraryDir, "assets", "default", "metadata");
  await mkdir(metadataDir, { recursive: true });
  await writeFile(join(metadataDir, "asset-1.json"), JSON.stringify({ id: "asset-1", asset: "asset-1.png" }));
  await writeFile(join(libraryDir, "assets", "default", "groups.json"), "[]\n");

  const store = createAssetStore({ projectRoot, managerDir: projectRoot, libraryDir, explicitLibraryDir: libraryDir });
  assert.equal(store.storageKind, "json");
  store.close?.();
});

test("libraryHasManagedMedia finds media under assets/ but ignores other files and links", async (t) => {
  const home = await tempHome(t);
  const libraryDir = join(home, "lib");
  await mkdir(join(libraryDir, "assets"), { recursive: true });
  assert.equal(libraryHasManagedMedia(libraryDir), false);

  // A lock file or notes file is not managed media.
  await writeFile(join(libraryDir, "assets", ".asset-1.create.lock"), "");
  await writeFile(join(libraryDir, "notes.txt"), "text");
  assert.equal(libraryHasManagedMedia(libraryDir), false);

  // Nested media counts.
  await seedManagedImages(libraryDir);
  assert.equal(libraryHasManagedMedia(libraryDir), true);
});

test("directoryHasLibrary counts managed media as a library; hasLegacyJsonState stays strict", async (t) => {
  const home = await tempHome(t);
  const libraryDir = join(home, "lib");
  await seedManagedImages(libraryDir);
  // A broken library (media, no mosa.db) IS a library for location selection:
  // it must be selected and then reported by createAssetStore, never skipped
  // in favor of a fresh library in the other default folder.
  assert.equal(directoryHasLibrary(libraryDir), true);
  // The backend-selection judgment stays strict: images alone are not legacy
  // JSON state, so opening still reports the missing database.
  assert.equal(hasLegacyJsonState({ libraryDir, explicitLibraryDir: libraryDir }), false);
  const metadataDir = join(libraryDir, "assets", "default", "metadata");
  await mkdir(metadataDir, { recursive: true });
  await writeFile(join(metadataDir, "asset-1.json"), "{}");
  assert.equal(directoryHasLibrary(libraryDir), true);
});

test("the desktop backfill writes the location file once and the recorded path is enforced", async (t) => {
  const home = await tempHome(t);
  const projectRoot = join(home, "project");
  const libraryDir = join(home, LIBRARY_DIR_NAME);
  seedCompletedSqliteLibrary({ projectRoot, libraryDir });
  const locationFile = join(home, "userData", "library-location.json");

  // First successful open records the location.
  assert.equal(writeLibraryLocationFileIfMissing(locationFile, libraryDir), true);
  assert.deepEqual(JSON.parse(await readFile(locationFile, "utf8")), { path: resolve(libraryDir) });
  // Later launches never overwrite a recorded move.
  assert.equal(writeLibraryLocationFileIfMissing(locationFile, join(home, "somewhere-else")), false);
  assert.deepEqual(JSON.parse(await readFile(locationFile, "utf8")), { path: resolve(libraryDir) });
  // And writeLibraryLocationFile (the relocation path) still overwrites.
  writeLibraryLocationFile(locationFile, join(home, "moved"));
  assert.deepEqual(JSON.parse(await readFile(locationFile, "utf8")), { path: resolve(join(home, "moved")) });
});

test("a recorded location whose library disappeared is an error, not a fresh library", async (t) => {
  const home = await tempHome(t);
  const projectRoot = join(home, "project");
  const libraryDir = join(home, LIBRARY_DIR_NAME);
  seedCompletedSqliteLibrary({ projectRoot, libraryDir });
  const locationFile = join(home, "userData", "library-location.json");
  writeLibraryLocationFile(locationFile, libraryDir);
  const movedDir = join(home, "External", "Library");
  await mkdir(join(home, "External"), { recursive: true });
  await rename(libraryDir, movedDir);

  assert.throws(
    () => resolveLibraryLocation({ homeDir: home, locationFile }),
    (error) => error instanceof MosaLibraryNotFoundError && error.libraryDir === resolve(libraryDir),
  );
});

test("desktopDefaultLocationFilePath mirrors the packaged app's userData", async (t) => {
  const home = "/home/test-user";
  assert.equal(
    desktopDefaultLocationFilePath(home, { platform: "darwin" }),
    join(home, "Library", "Application Support", "mosa", "library-location.json"),
  );
  assert.equal(
    desktopDefaultLocationFilePath(home, { platform: "win32", env: { APPDATA: join(home, "AppData", "Roaming") } }),
    join(home, "AppData", "Roaming", "mosa", "library-location.json"),
  );
  assert.equal(
    desktopDefaultLocationFilePath(home, { platform: "linux", env: {} }),
    join(home, ".config", "mosa", "library-location.json"),
  );
});

test("MCP follows the desktop's own location file when the config does not name one", async (t) => {
  const home = await tempHome(t);
  const projectRoot = join(home, "project");
  const libraryDir = join(home, LIBRARY_DIR_NAME);
  seedCompletedSqliteLibrary({ projectRoot, libraryDir });
  const locationFilePath = desktopDefaultLocationFilePath(home);
  await mkdir(resolve(locationFilePath, ".."), { recursive: true });
  writeLibraryLocationFile(locationFilePath, libraryDir);

  // Resolution layer: the desktop-recorded location wins over the defaults.
  const resolution = resolveLibraryLocation({ homeDir: home, allowCreate: false, fallbackLocationFile: locationFilePath });
  assert.equal(resolution.libraryDir, resolve(libraryDir));
  assert.equal(resolution.source, "location-file");

  // Real server: a hand-written config (no env library, no location file in
  // the config) starts and serves the library the App recorded.
  await mkdir(projectRoot, { recursive: true });
  const server = spawnMcpServerAsClient(t, {
    args: [resolve(import.meta.dirname, "..", "mcp", "server.mjs")],
    cwd: projectRoot,
    env: { ...process.env, HOME: home },
    allowMissingLibraryEnv: true,
  });
  const init = await server.request("initialize", { protocolVersion: "2025-11-25" });
  assert.equal(init.result.serverInfo.name, "GravityPort MCP");
  // Without a copied config the server has no desktop-mode asset roots, so the
  // import source must sit under the server's own generated-images directory.
  const imagePath = await writePngFixture(join(projectRoot, "generated-images", "fallback.png"));
  const created = await server.callToolStrict("asset_create", { assetId: "fallback-follow", imagePath, prompt: "via the desktop location file" });
  assert.equal(created.structuredContent.asset.id, "fallback-follow");
  server.child.kill("SIGTERM");
  await server.waitForExit();
});

test("MCP refuses an env-configured directory without a library and reports the recorded location", async (t) => {
  const home = await tempHome(t);
  const emptyEnvDir = join(home, "empty-env-dir");
  await mkdir(emptyEnvDir, { recursive: true });
  const recordedLibrary = join(home, "real-library");
  await mkdir(recordedLibrary, { recursive: true });
  const fallbackFile = join(home, "userData", "library-location.json");
  await mkdir(resolve(fallbackFile, ".."), { recursive: true });
  writeLibraryLocationFile(fallbackFile, recordedLibrary);

  try {
    resolveLibraryLocation({
      homeDir: home,
      envLibraryDir: emptyEnvDir,
      allowCreate: false,
      fallbackLocationFile: fallbackFile,
    });
    assert.fail("expected MosaLibraryNotFoundError");
  } catch (error) {
    assert.ok(error instanceof MosaLibraryNotFoundError);
    assert.equal(error.libraryDir, resolve(emptyEnvDir));
    assert.equal(error.recordedLibraryDir, resolve(recordedLibrary));
  }
  // Nothing was created inside the configured directory.
  assert.deepEqual(await readdir(emptyEnvDir), []);
});

test("MCP refuses to create a library when only MOSA_LIBRARY_DIR points at an empty directory", async (t) => {
  const workspace = await createMcpWorkspace(t);
  // Empty the seeded library back out: env pointing at a directory without a
  // library must fail instead of materializing a fresh one.
  for (const entry of await readdir(workspace.libraryDir)) {
    await rm(join(workspace.libraryDir, entry), { recursive: true, force: true });
  }

  const server = startMcpServer(t, workspace);
  const exit = await server.waitForExit();
  assert.equal(exit.code, 1);
  assert.match(server.stderr, /没有找到 GravityPort 素材库/);
  assert.match(server.stderr, /No GravityPort library was found/);
});

test("MCP answers LIBRARY_DATABASE_CHANGED after the library directory is moved away", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);
  await server.request("initialize", { protocolVersion: "2025-11-25" });
  const imagePath = await writePngFixture(join(workspace.imagesDir, "before-move.png"));
  await server.callToolStrict("asset_create", { assetId: "before-move", imagePath, prompt: "written before the move" });

  const movedDir = `${workspace.libraryDir}-moved`;
  await rename(workspace.libraryDir, movedDir);

  // A read and a write both refuse, and neither location gains new writes.
  const readAttempt = await server.callTool("asset_search", { query: "before-move" });
  assert.equal(readAttempt.isError, true);
  assert.equal(readAttempt.structuredContent.error.code, "LIBRARY_DATABASE_CHANGED");
  assert.match(readAttempt.content[0].text, /素材库已被移动或删除/);
  assert.match(readAttempt.content[0].text, /moved or deleted/);

  const writeAttempt = await server.callTool("asset_create", {
    assetId: "after-move",
    imagePath,
    prompt: "must never land anywhere",
  });
  assert.equal(writeAttempt.isError, true);
  assert.equal(writeAttempt.structuredContent.error.code, "LIBRARY_DATABASE_CHANGED");

  // The old location is gone; the moved library holds only what it had before.
  assert.equal(existsSync(workspace.libraryDir), false);
  const movedImports = join(movedDir, "imports");
  const movedImportNames = (await existsSync(movedImports)) ? await readdir(movedImports) : [];
  assert.equal(movedImportNames.some((name) => name.includes("after-move")), false);
  assert.deepEqual(await server.request("ping").then((response) => response.result), {});
  server.child.kill("SIGTERM");
  await server.waitForExit();
});

test("MCP answers LIBRARY_DATABASE_CHANGED when mosa.db is swapped for another file", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);
  await server.request("initialize", { protocolVersion: "2025-11-25" });
  const imagePath = await writePngFixture(join(workspace.imagesDir, "before-swap.png"));
  await server.callToolStrict("asset_create", { assetId: "before-swap", imagePath, prompt: "written before the swap" });

  // Delete the database and replace it with a different (empty) file: the
  // inode changed, so the library this server opened is gone even though the
  // path still exists.
  await rm(join(workspace.libraryDir, "mosa.db"));
  await writeFile(join(workspace.libraryDir, "mosa.db"), "not a database");

  const readAttempt = await server.callTool("asset_search", { query: "before-swap" });
  assert.equal(readAttempt.isError, true);
  assert.equal(readAttempt.structuredContent.error.code, "LIBRARY_DATABASE_CHANGED");
  const writeAttempt = await server.callTool("asset_create", { assetId: "after-swap", imagePath, prompt: "must never land" });
  assert.equal(writeAttempt.isError, true);
  assert.equal(writeAttempt.structuredContent.error.code, "LIBRARY_DATABASE_CHANGED");

  // The swapped file was never opened or overwritten by the server.
  assert.equal(await readFile(join(workspace.libraryDir, "mosa.db"), "utf8"), "not a database");
  server.child.kill("SIGTERM");
  await server.waitForExit();
});
test("a broken default library is selected and reported, not skipped for a fresh one", async (t) => {
  const home = await tempHome(t);
  const legacyLibrary = join(home, "MOSA Library");
  await seedManagedImages(legacyLibrary);

  const resolution = resolveLibraryLocation({ homeDir: home });
  assert.equal(resolution.libraryDir, resolve(legacyLibrary));
  assert.equal(resolution.source, "legacy-default");

  assert.throws(
    () => createAssetStore({ projectRoot: home, managerDir: home, libraryDir: resolution.libraryDir, explicitLibraryDir: resolution.libraryDir }),
    (error) => error?.code === "MOSA_LIBRARY_DATABASE_MISSING",
  );
  assert.equal(existsSync(join(home, LIBRARY_DIR_NAME)), false);
});

test("a marker without mosa.db in the default location is selected and reported", async (t) => {
  const home = await tempHome(t);
  const legacyLibrary = join(home, "MOSA Library");
  await seedManagedImages(legacyLibrary);
  ensureSqliteMigrationMarker(legacyLibrary);

  const resolution = resolveLibraryLocation({ homeDir: home });
  assert.equal(resolution.libraryDir, resolve(legacyLibrary));
  assert.equal(resolution.source, "legacy-default");

  assert.throws(
    () => createAssetStore({ projectRoot: home, managerDir: home, libraryDir: resolution.libraryDir, explicitLibraryDir: resolution.libraryDir }),
    (error) => error?.code === "SQLITE_LIBRARY_MISSING",
  );
  assert.equal(existsSync(join(home, LIBRARY_DIR_NAME)), false);
});

test("a broken GravityPort Library is selected as new-default, not new-default-fresh", async (t) => {
  const home = await tempHome(t);
  const library = join(home, LIBRARY_DIR_NAME);
  await seedManagedImages(library);

  const resolution = resolveLibraryLocation({ homeDir: home });
  assert.equal(resolution.libraryDir, resolve(library));
  assert.equal(resolution.source, "new-default");
  assert.throws(
    () => createAssetStore({ projectRoot: home, managerDir: home, libraryDir: resolution.libraryDir, explicitLibraryDir: resolution.libraryDir }),
    (error) => error?.code === "MOSA_LIBRARY_DATABASE_MISSING",
  );
});

test("the runtime without an explicit libraryDir reports the broken default instead of creating one", async (t) => {
  const home = await tempHome(t);
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = savedHome; });
  await seedManagedImages(join(home, "MOSA Library"));

  // Production shape (no QA markers): QA/debug mode requires an explicit
  // MOSA_LIBRARY_DIR by design, so the implicit-default path only exists for
  // `npm start` style runs. No libraryDir/assetsRoot passed — exactly the
  // path mosa-runtime.mjs takes when the caller does not name a library.
  await assert.rejects(
    () => startMosaRuntime({
      port: 0,
      projectRoot: home,
      managerDir: home,
      cowartProjectDir: join(home, "desktop-data"),
      appDir: join(home, "dist"),
      generatedImagesDir: join(home, "generated-images"),
      codexImagesDir: join(home, "codex-images"),
      codexSessionsDir: join(home, "codex-sessions"),
      grokSessionsDir: join(home, "grok-sessions"),
      cowartCanvasDir: join(home, "cowart-canvas"),
      cowartRegistryPath: join(home, "state", "cowart-projects.json"),
    }),
    (error) => error?.code === "MOSA_LIBRARY_DATABASE_MISSING",
  );
  assert.equal(existsSync(join(home, LIBRARY_DIR_NAME)), false);
});

test("MCP exits non-zero for an env-configured directory holding only managed media", async (t) => {
  const workspace = await createMcpWorkspace(t);
  // Reduce the seeded library to managed media only: no mosa.db, no marker.
  for (const entry of await readdir(workspace.libraryDir)) {
    await rm(join(workspace.libraryDir, entry), { recursive: true, force: true });
  }
  await seedManagedImages(workspace.libraryDir);

  const server = startMcpServer(t, workspace);
  const exit = await server.waitForExit();
  assert.equal(exit.code, 1);
  // The store's bilingual message reaches stderr; nothing was created.
  assert.match(server.stderr, /素材库缺少数据库文件 mosa\.db/);
  assert.match(server.stderr, /is missing its mosa\.db database/);
  assert.equal(existsSync(join(workspace.libraryDir, "mosa.db")), false);
});

test("the startup backfill skips recording when MOSA_LIBRARY_DIR is set", async (t) => {
  const home = await tempHome(t);
  const library = join(home, LIBRARY_DIR_NAME);
  const locationFile = join(home, "user-data", "library-location.json");

  assert.equal(writeLibraryLocationFromSuccessfulOpen({
    envLibraryDir: join(home, "temporary-library"),
    locationFilePath: locationFile,
    libraryDir: library,
  }), false);
  assert.equal(existsSync(locationFile), false);
});

test("the startup backfill records once without MOSA_LIBRARY_DIR and never twice", async (t) => {
  const home = await tempHome(t);
  const library = join(home, LIBRARY_DIR_NAME);
  await mkdir(library, { recursive: true });
  const locationFile = join(home, "user-data", "library-location.json");

  assert.equal(writeLibraryLocationFromSuccessfulOpen({
    envLibraryDir: undefined,
    locationFilePath: locationFile,
    libraryDir: library,
  }), true);
  assert.deepEqual(JSON.parse(await readFile(locationFile, "utf8")), { path: resolve(library) });
  assert.equal(writeLibraryLocationFromSuccessfulOpen({
    envLibraryDir: undefined,
    locationFilePath: locationFile,
    libraryDir: join(home, "somewhere-else"),
  }), false);
  assert.deepEqual(JSON.parse(await readFile(locationFile, "utf8")), { path: resolve(library) });
});
