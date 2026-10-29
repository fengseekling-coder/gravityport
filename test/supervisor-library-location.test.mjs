import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  LIBRARY_DATABASE_FILE,
  MosaLibraryNotFoundError,
  desktopDefaultLocationFilePath,
  resolveLibraryLocation,
} from "../lib/library-location.mjs";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import {
  backgroundRuntimeEnv,
  resolveSupervisorLibraryDir,
  runSupervisor,
} from "../scripts/macos-web-capture-supervisor.mjs";

// Every test uses a temporary home. Nothing here reads the real ~/MOSA Library,
// ~/GravityPort Library or the desktop userData folder.
// On Linux and Windows the desktop location file follows XDG_CONFIG_HOME /
// APPDATA rather than the home directory (CI sets XDG_CONFIG_HOME). Drop them
// so each test's location file stays inside its own temporary home.
delete process.env.XDG_CONFIG_HOME;
delete process.env.APPDATA;
function makeHome(t) {
  const home = mkdtempSync(join(tmpdir(), "gp-supervisor-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function seedLibrary(libraryDir) {
  mkdirSync(libraryDir, { recursive: true });
  writeFileSync(join(libraryDir, LIBRARY_DATABASE_FILE), "");
}

function recordLibraryLocation(home, libraryDir) {
  const locationFile = desktopDefaultLocationFilePath(home);
  mkdirSync(dirname(locationFile), { recursive: true });
  writeFileSync(locationFile, `${JSON.stringify({ path: libraryDir })}\n`, "utf8");
}

function defaultFoldersAbsent(home) {
  return !existsSync(join(home, "GravityPort Library")) && !existsSync(join(home, "MOSA Library"));
}

test("supervisor follows the desktop location file to the library the user moved", (t) => {
  const home = makeHome(t);
  const moved = join(home, "Moved Library");
  seedLibrary(moved);
  recordLibraryLocation(home, moved);

  assert.equal(resolveSupervisorLibraryDir({ homeDir: home, envLibraryDir: null }), moved);
});

test("a recorded location without a library is reported and nothing is created", (t) => {
  const home = makeHome(t);
  const moved = join(home, "Moved Library");
  recordLibraryLocation(home, moved);

  assert.throws(
    () => resolveSupervisorLibraryDir({ homeDir: home, envLibraryDir: null }),
    MosaLibraryNotFoundError,
  );
  assert.equal(existsSync(moved), false);
  assert.equal(defaultFoldersAbsent(home), true);
});

test("no location file and no library in either default folder reports and creates nothing", (t) => {
  const home = makeHome(t);

  assert.throws(
    () => resolveSupervisorLibraryDir({ homeDir: home, envLibraryDir: null }),
    MosaLibraryNotFoundError,
  );
  assert.equal(defaultFoldersAbsent(home), true);
});

test("a library in the legacy MOSA Library folder is still used without a location file", (t) => {
  const home = makeHome(t);
  const legacy = join(home, "MOSA Library");
  seedLibrary(legacy);

  assert.equal(resolveSupervisorLibraryDir({ homeDir: home, envLibraryDir: null }), legacy);
});

test("an explicit MOSA_LIBRARY_DIR still wins over the location file", (t) => {
  const home = makeHome(t);
  const explicit = join(home, "Explicit Library");
  seedLibrary(explicit);
  recordLibraryLocation(home, join(home, "Moved Library"));

  assert.equal(resolveSupervisorLibraryDir({ homeDir: home, envLibraryDir: explicit }), explicit);
});

test("an explicit MOSA_LIBRARY_DIR without a library is reported, not created", (t) => {
  const home = makeHome(t);
  const explicit = join(home, "Empty Library");

  assert.throws(
    () => resolveSupervisorLibraryDir({ homeDir: home, envLibraryDir: explicit }),
    MosaLibraryNotFoundError,
  );
  assert.equal(existsSync(explicit), false);
  assert.equal(defaultFoldersAbsent(home), true);
});

test("the desktop App on a fresh machine still resolves the new default folder for creation", (t) => {
  const home = makeHome(t);

  const resolution = resolveLibraryLocation({ homeDir: home });
  assert.equal(resolution.source, "new-default-fresh");
  assert.equal(resolution.libraryDir, join(home, "GravityPort Library"));
});

test("a runtime started by the background supervisor refuses to create a library", async (t) => {
  const home = makeHome(t);
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  await assert.rejects(
    () => startMosaRuntime({
      env: { MOSA_BACKGROUND_RUNTIME: "1" },
      port: 0,
      clientToken: "test-token",
    }),
    MosaLibraryNotFoundError,
  );
  assert.equal(defaultFoldersAbsent(home), true);
});

test("the supervisor marks the runtime environment as attach-only and keeps the rest", () => {
  const env = backgroundRuntimeEnv({ MOSA_PORT: "43517" });
  assert.equal(env.MOSA_BACKGROUND_RUNTIME, "1");
  assert.equal(env.MOSA_PORT, "43517");
});

test("supervisor logs a missing library once and starts nothing while it is missing", async () => {
  const warnings = [];
  const signalTarget = new EventEmitter();
  let spawnCount = 0;
  let rounds = 0;

  await runSupervisor({
    probe: async () => {
      throw new MosaLibraryNotFoundError("The recorded library location does not contain a library: /moved", {
        libraryDir: "/moved",
      });
    },
    spawnRuntime: () => {
      spawnCount += 1;
      throw new Error("the background runtime must not start without a library");
    },
    sleep: async () => {
      rounds += 1;
      if (rounds === 3) signalTarget.emit("SIGTERM");
    },
    logger: { info() {}, warn: (line) => warnings.push(line) },
    signalTarget,
  });

  assert.equal(rounds, 3);
  assert.equal(spawnCount, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /does not contain a library: \/moved/);
  assert.match(warnings[0], /not starting the background runtime and not creating a library/);
});

test("supervisor starts the runtime once the missing library comes back", async () => {
  const warnings = [];
  const signalTarget = new EventEmitter();
  let probes = 0;
  let spawnCount = 0;
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    child.signalCode = "SIGTERM";
    child.emit("exit", null, "SIGTERM");
  };

  await runSupervisor({
    probe: async () => {
      probes += 1;
      if (probes <= 2) {
        throw new MosaLibraryNotFoundError("The recorded library location does not contain a library: /moved", {
          libraryDir: "/moved",
        });
      }
      return { state: "unavailable" };
    },
    spawnRuntime: () => {
      spawnCount += 1;
      setImmediate(() => signalTarget.emit("SIGTERM"));
      return child;
    },
    watchSources: () => ({ promise: new Promise(() => {}), close() {} }),
    watchHandoff: () => ({ promise: new Promise(() => {}), close() {} }),
    sleep: async () => {},
    logger: { info() {}, warn: (line) => warnings.push(line) },
    signalTarget,
  });

  assert.equal(spawnCount, 1);
  assert.equal(warnings.filter((line) => /not creating a library/.test(line)).length, 1);
});
