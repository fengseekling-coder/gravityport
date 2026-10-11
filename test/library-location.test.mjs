import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  defaultLibraryDir,
  directoryHasLibrary,
  LEGACY_LIBRARY_DIR_NAME,
  LIBRARY_DIR_NAME,
  legacyDefaultLibraryDir,
  MosaLibraryLocationFileError,
  MosaLibraryNotFoundError,
  resolveLibraryLocation,
} from "../lib/library-location.mjs";
import { validateRuntimeIsolation } from "../lib/runtime-isolation-guard.mjs";
import { probeMosaService } from "../desktop/service-manager.mjs";
import { probeMosaOwner } from "../scripts/macos-web-capture-supervisor.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

/**
 * Minimal legacy JSON library: the same shape hasLegacyJsonState() treats as
 * meaningful legacy state (a project directory holding real files).
 */
async function seedLegacyJsonLibrary(libraryDir) {
  const imagesDir = join(libraryDir, "assets", "default", "images");
  await mkdir(imagesDir, { recursive: true });
  await writeFile(join(imagesDir, "asset.png"), "fixture");
}

function tempHome() {
  return mkdtemp(join(tmpdir(), "mosa-libloc-home-"));
}

describe("resolveLibraryLocation", () => {
  it("env MOSA_LIBRARY_DIR wins over everything else", async () => {
    const home = await tempHome();
    deferTestPathRemoval(home, { recursive: true, force: true });
    const envDir = join(home, "env-library");
    await seedLegacyJsonLibrary(envDir);

    const result = resolveLibraryLocation({ homeDir: home, envLibraryDir: envDir });
    assert.equal(result.libraryDir, resolve(envDir));
    assert.equal(result.source, "env");
  });

  it("env wins even when a location file is present", async () => {
    const home = await tempHome();
    deferTestPathRemoval(home, { recursive: true, force: true });
    const savedDir = join(home, "saved-library");
    await seedLegacyJsonLibrary(savedDir);
    const locationFile = join(home, "library-location.json");
    await writeFile(locationFile, JSON.stringify({ path: savedDir }));

    const result = resolveLibraryLocation({
      homeDir: home,
      envLibraryDir: join(home, "from-env"),
      locationFile,
    });
    assert.equal(result.libraryDir, resolve(join(home, "from-env")));
    assert.equal(result.source, "env");
  });

  it("uses a valid location file that points at a library", async () => {
    const home = await tempHome();
    deferTestPathRemoval(home, { recursive: true, force: true });
    const savedDir = join(home, "saved-library");
    await seedLegacyJsonLibrary(savedDir);
    const locationFile = join(home, "library-location.json");
    await writeFile(locationFile, JSON.stringify({ path: savedDir }));

    const result = resolveLibraryLocation({ homeDir: home, locationFile });
    assert.equal(result.libraryDir, resolve(savedDir));
    assert.equal(result.source, "location-file");
  });

  it("throws not-found when the location file's directory does not exist", async () => {
    const home = await tempHome();
    deferTestPathRemoval(home, { recursive: true, force: true });
    const locationFile = join(home, "library-location.json");
    await writeFile(locationFile, JSON.stringify({ path: join(home, "gone-library") }));

    assert.throws(
      () => resolveLibraryLocation({ homeDir: home, locationFile }),
      (error) => error instanceof MosaLibraryNotFoundError
        && error.code === "MOSA_LIBRARY_NOT_FOUND"
        && error.libraryDir === resolve(join(home, "gone-library")),
    );
  });

  it("throws not-found when the location file's directory exists but holds no library", async () => {
    const home = await tempHome();
    deferTestPathRemoval(home, { recursive: true, force: true });
    const emptyDir = join(home, "empty-library");
    await mkdir(emptyDir, { recursive: true });
    const locationFile = join(home, "library-location.json");
    await writeFile(locationFile, JSON.stringify({ path: emptyDir }));

    assert.throws(
      () => resolveLibraryLocation({ homeDir: home, locationFile }),
      (error) => error instanceof MosaLibraryNotFoundError && error.libraryDir === resolve(emptyDir),
    );
  });

  it("throws a file error for a corrupt (non-JSON) location file", async () => {
    const home = await tempHome();
    deferTestPathRemoval(home, { recursive: true, force: true });
    const locationFile = join(home, "library-location.json");
    await writeFile(locationFile, "{not json");

    assert.throws(
      () => resolveLibraryLocation({ homeDir: home, locationFile }),
      (error) => error instanceof MosaLibraryLocationFileError
        && error.code === "MOSA_LIBRARY_LOCATION_FILE_UNREADABLE"
        && error.locationFile === locationFile,
    );
  });

  it("throws a file error when path is not a string or not absolute", async () => {
    const home = await tempHome();
    deferTestPathRemoval(home, { recursive: true, force: true });
    const locationFile = join(home, "library-location.json");

    await writeFile(locationFile, JSON.stringify({ path: "relative/path" }));
    assert.throws(
      () => resolveLibraryLocation({ homeDir: home, locationFile }),
      (error) => error instanceof MosaLibraryLocationFileError,
    );

    await writeFile(locationFile, JSON.stringify({ path: 42 }));
    assert.throws(
      () => resolveLibraryLocation({ homeDir: home, locationFile }),
      (error) => error instanceof MosaLibraryLocationFileError,
    );
  });

  it("falls through when the location file does not exist", async () => {
    const home = await tempHome();
    deferTestPathRemoval(home, { recursive: true, force: true });

    const result = resolveLibraryLocation({ homeDir: home, locationFile: join(home, "missing.json") });
    assert.equal(result.source, "new-default-fresh");
  });

  it("treats a legacy user with mosa.db in MOSA Library as the legacy default", async () => {
    const home = await tempHome();
    deferTestPathRemoval(home, { recursive: true, force: true });
    await mkdir(legacyDefaultLibraryDir(home), { recursive: true });
    await writeFile(join(legacyDefaultLibraryDir(home), "mosa.db"), "");

    const result = resolveLibraryLocation({ homeDir: home });
    assert.equal(result.libraryDir, legacyDefaultLibraryDir(home));
    assert.equal(result.source, "legacy-default");
  });

  it("treats a legacy user with an old JSON library in MOSA Library as the legacy default", async () => {
    const home = await tempHome();
    deferTestPathRemoval(home, { recursive: true, force: true });
    await seedLegacyJsonLibrary(legacyDefaultLibraryDir(home));

    const result = resolveLibraryLocation({ homeDir: home });
    assert.equal(result.libraryDir, legacyDefaultLibraryDir(home));
    assert.equal(result.source, "legacy-default");
  });

  it("does not treat an empty MOSA Library folder as an existing library", async () => {
    const home = await tempHome();
    deferTestPathRemoval(home, { recursive: true, force: true });
    await mkdir(legacyDefaultLibraryDir(home), { recursive: true });

    const result = resolveLibraryLocation({ homeDir: home });
    assert.equal(result.libraryDir, defaultLibraryDir(home));
    assert.equal(result.source, "new-default-fresh");
  });

  it("does not treat a lock-file-only assets folder as an existing library", async () => {
    const home = await tempHome();
    deferTestPathRemoval(home, { recursive: true, force: true });
    const assetsDir = join(legacyDefaultLibraryDir(home), "assets", "default");
    await mkdir(assetsDir, { recursive: true });
    await writeFile(join(assetsDir, ".asset-1.create.lock"), "");

    const result = resolveLibraryLocation({ homeDir: home });
    assert.equal(result.source, "new-default-fresh");
  });

  it("uses GravityPort Library when only it has a library", async () => {
    const home = await tempHome();
    deferTestPathRemoval(home, { recursive: true, force: true });
    await seedLegacyJsonLibrary(defaultLibraryDir(home));

    const result = resolveLibraryLocation({ homeDir: home });
    assert.equal(result.libraryDir, defaultLibraryDir(home));
    assert.equal(result.source, "new-default");
  });

  it("prefers MOSA Library and logs when both defaults hold a library", async () => {
    const home = await tempHome();
    deferTestPathRemoval(home, { recursive: true, force: true });
    await seedLegacyJsonLibrary(legacyDefaultLibraryDir(home));
    await seedLegacyJsonLibrary(defaultLibraryDir(home));
    const logs = [];

    const result = resolveLibraryLocation({ homeDir: home, log: (line) => logs.push(line) });
    assert.equal(result.libraryDir, legacyDefaultLibraryDir(home));
    assert.equal(result.source, "legacy-default");
    assert.equal(logs.length, 1);
    assert.match(logs[0], /MOSA Library/);
    assert.match(logs[0], /GravityPort Library/);
  });

  it("returns GravityPort Library for a machine with no library anywhere", async () => {
    const home = await tempHome();
    deferTestPathRemoval(home, { recursive: true, force: true });

    const result = resolveLibraryLocation({ homeDir: home });
    assert.equal(result.libraryDir, defaultLibraryDir(home));
    assert.equal(result.source, "new-default-fresh");
    // Only the fresh default may point at a directory that does not exist.
    assert.equal(existsSync(result.libraryDir), false);
  });

  it("never reads the caller's real home directory when a sandbox home is passed", async () => {
    const home = await tempHome();
    deferTestPathRemoval(home, { recursive: true, force: true });
    // No default folder exists under the temp home, so resolution must land on
    // the temp-home default — any real-home read would return legacy-default.
    const result = resolveLibraryLocation({ homeDir: home });
    assert.equal(result.libraryDir, join(home, LIBRARY_DIR_NAME));
  });
});

describe("directoryHasLibrary", () => {
  it("recognizes mosa.db and legacy JSON state, and rejects empty folders", async () => {
    const home = await tempHome();
    deferTestPathRemoval(home, { recursive: true, force: true });
    const sqliteDir = join(home, "sqlite-lib");
    await mkdir(sqliteDir, { recursive: true });
    assert.equal(directoryHasLibrary(sqliteDir), false);
    await writeFile(join(sqliteDir, "mosa.db"), "");
    assert.equal(directoryHasLibrary(sqliteDir), true);

    const jsonDir = join(home, "json-lib");
    await seedLegacyJsonLibrary(jsonDir);
    assert.equal(directoryHasLibrary(jsonDir), true);
    assert.equal(directoryHasLibrary(""), false);
  });
});

describe("runtime isolation guard protects both default libraries", () => {
  const base = {
    libraryDir: join(tmpdir(), "mosa-libloc-qa-lib"),
    port: 44444,
    runtimeMode: "qa",
    userData: join(tmpdir(), "mosa-libloc-qa-ud"),
    actualUserData: join(tmpdir(), "mosa-libloc-qa-ud"),
    argv: ["node", "test.mjs"],
    productionPorts: [43517],
    defaultUserData: join(tmpdir(), "mosa-libloc-prod-ud"),
  };

  it("rejects a QA library equal to the GravityPort default when the caller passes the list", () => {
    const result = validateRuntimeIsolation({
      ...base,
      productionLibraryDir: [legacyDefaultLibraryDir(homedir()), defaultLibraryDir(homedir())],
      libraryDir: defaultLibraryDir(homedir()),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /must not equal the production library/);
  });

  it("rejects a QA library inside the GravityPort default when the caller passes the list", () => {
    const result = validateRuntimeIsolation({
      ...base,
      productionLibraryDir: [legacyDefaultLibraryDir(homedir()), defaultLibraryDir(homedir())],
      libraryDir: join(defaultLibraryDir(homedir()), "sub"),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /must not be a subdirectory/);
  });

  it("defaults to protecting both home defaults when no list is passed", () => {
    for (const dir of [legacyDefaultLibraryDir(homedir()), defaultLibraryDir(homedir())]) {
      const result = validateRuntimeIsolation({ ...base, libraryDir: dir });
      assert.equal(result.ok, false, `expected rejection for ${dir}`);
      assert.match(result.reason, /must not equal the production library/);
    }
  });

  it("still passes a QA library that is outside both defaults", () => {
    const result = validateRuntimeIsolation({
      ...base,
      productionLibraryDir: [legacyDefaultLibraryDir(homedir()), defaultLibraryDir(homedir())],
    });
    assert.equal(result.ok, true);
  });
});

describe("canonical library comparison across symlinks", () => {
  it("service probe attaches when the running library is reached through a symlink", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "mosa-libloc-symlink-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const realDir = join(root, "real-library");
    const alias = join(root, "alias-library");
    await mkdir(realDir, { recursive: true });
    await symlink(realDir, alias);

    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({ product: "mosa", libraryDir: alias }),
    });
    const attached = await probeMosaService({ port: 45678, libraryDir: realDir, fetchImpl });
    assert.equal(attached.state, "attached");
    assert.equal(attached.libraryDir, resolve(realDir));

    // A genuinely different library still conflicts.
    const otherDir = join(root, "other-library");
    await mkdir(otherDir, { recursive: true });
    const conflicting = await probeMosaService({
      port: 45678,
      libraryDir: realDir,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ product: "mosa", libraryDir: otherDir }),
      }),
    });
    assert.equal(conflicting.state, "conflict");
    assert.match(conflicting.error?.message || "", /different GravityPort library/);
  });

  it("supervisor probe attaches through a symlink and still reports different-library", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "mosa-libloc-symlink-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const realDir = join(root, "real-library");
    const alias = join(root, "alias-library");
    await mkdir(realDir, { recursive: true });
    await symlink(realDir, alias);

    const attached = await probeMosaOwner({
      port: 45679,
      libraryDir: realDir,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ product: "mosa", libraryDir: alias }),
      }),
      leaseProbe: async () => ({ state: "unavailable" }),
      handoffProbe: async () => ({ state: "unavailable" }),
    });
    assert.equal(attached.state, "attached");

    const otherDir = join(root, "other-library");
    await mkdir(otherDir, { recursive: true });
    const conflicting = await probeMosaOwner({
      port: 45679,
      libraryDir: realDir,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ product: "mosa", libraryDir: otherDir }),
      }),
      leaseProbe: async () => ({ state: "unavailable" }),
      handoffProbe: async () => ({ state: "unavailable" }),
    });
    assert.equal(conflicting.state, "conflict");
    assert.equal(conflicting.reason, "different-library");
  });
});

describe("packaged userData identity contract", () => {
  // The packaged app takes its Electron userData directory name from the
  // package.json bundled into the app (productName if present, otherwise
  // name — tasks/89-摸底报告.md §1), NOT from the forge packagerConfig name.
  // Changing either would move every user's settings directory on the next
  // launch: installation ID, pairing tokens, library-location.json and theme
  // state would all be silently lost. This is the red line from the rename
  // plan (section 3): the visible app may be renamed, this file may not.
  it("root package.json keeps name=mosa and never gains productName", async () => {
    const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
    assert.equal(manifest.name, "mosa");
    assert.equal("productName" in manifest, false);
  });

  it("the packaged-manifest key whitelist never introduces productName", async () => {
    const forgeSource = await readFile(join(repositoryRoot, "desktop", "forge.config.mjs"), "utf8");
    const whitelist = forgeSource.slice(
      forgeSource.indexOf("const PACKAGED_MANIFEST_KEYS"),
      forgeSource.indexOf("]", forgeSource.indexOf("const PACKAGED_MANIFEST_KEYS")),
    );
    assert.doesNotMatch(whitelist, /productName/);
  });

  it("desktop/main.mjs documents the real userData rule instead of the forge claim", async () => {
    const source = await readFile(join(repositoryRoot, "desktop", "main.mjs"), "utf8");
    assert.match(source, /productName if present, otherwise name/);
    assert.doesNotMatch(source, /forge packagerConfig name \("MOSA"\)/);
  });
});

describe("library folder name constants", () => {
  it("exposes the two default folder names", () => {
    assert.equal(LEGACY_LIBRARY_DIR_NAME, "MOSA Library");
    assert.equal(LIBRARY_DIR_NAME, "GravityPort Library");
    assert.equal(legacyDefaultLibraryDir("/home/u"), "/home/u/MOSA Library");
    assert.equal(defaultLibraryDir("/home/u"), "/home/u/GravityPort Library");
  });
});
