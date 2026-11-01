import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { agentRuntimeEnv, readBundleVersion, createBundleVersionGuard, runBackgroundCaptureAgent } from "../desktop/background-capture-agent.mjs";
import { runSupervisor } from "../desktop/web-capture-supervisor.mjs";

test("agent reads both desktop tokens, trims them and preserves inherited env", () => {
  const result = agentRuntimeEnv({
    env: { PATH: "/bin" }, userDataDir: "/data",
    readFileSync: (path) => path.endsWith("/web-capture-token") ? "abc\n" : "  def  ",
  });
  assert.equal(result.MOSA_WEB_CAPTURE_TOKEN, "abc");
  assert.equal(result.MOSA_CLIENT_TOKEN, "def");
  assert.equal(result.MOSA_BACKGROUND_RUNTIME, "1");
  assert.equal(result.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(result.PATH, "/bin");
});

test("missing or blank desktop token fails closed without leaking the other token", () => {
  for (const value of [null, "   "]) {
    assert.throws(() => agentRuntimeEnv({
      env: {}, userDataDir: "/data",
      readFileSync: (path) => {
        if (path.endsWith("/web-capture-token")) {
          if (value === null) throw new Error("not found");
          return value;
        }
        return "super-secret-client-token";
      },
    }), (error) => {
      assert.equal(error.code, "BACKGROUND_TOKEN_MISSING");
      assert.match(error.message, /web-capture-token/);
      assert.doesNotMatch(error.message, /super-secret-client-token/);
      return true;
    });
  }
});

test("bundle version is read from the executable's Contents/Info.plist", () => {
  let path;
  const version = readBundleVersion({
    execPath: "/A/GravityPort.app/Contents/MacOS/GravityPort",
    readFileSync: (name) => { path = name; return "<key>CFBundleShortVersionString</key>\n\t<string>0.3.9</string>"; },
  });
  assert.equal(version, "0.3.9");
  assert.equal(path, "/A/GravityPort.app/Contents/Info.plist");
  assert.throws(() => readBundleVersion({ execPath: "/A/GravityPort.app/Contents/MacOS/GravityPort", readFileSync: () => "<plist/>" }));
});

test("bundle version guard notices both version change and missing bundle", () => {
  const versions = ["0.3.9", "0.3.9", "0.4.0"];
  const guard = createBundleVersionGuard({ readVersion: () => versions.shift() });
  assert.equal(guard.initial, "0.3.9");
  assert.equal(guard.changed(), false);
  assert.equal(guard.changed(), true);
  const missing = createBundleVersionGuard({ readVersion: (() => { let n = 0; return () => { if (n++) throw new Error("gone"); return "0.3.9"; }; })() });
  assert.equal(missing.changed(), true);
});

test("shared supervisor requires both runtime spawn and watcher", async () => {
  await assert.rejects(runSupervisor({ spawnRuntime: () => null }), { name: "TypeError", message: "runSupervisor needs spawnRuntime and watchSources" });
  await assert.rejects(runSupervisor({ watchSources: () => ({ promise: Promise.resolve(), close() {} }) }), { name: "TypeError", message: "runSupervisor needs spawnRuntime and watchSources" });
});

test("shared supervisor can exit before first probe or spawn", async () => {
  let spawned = 0;
  const result = await runSupervisor({
    probe: async () => ({ state: "unavailable" }),
    spawnRuntime: () => { spawned += 1; throw new Error("must not spawn"); },
    watchSources: () => ({ promise: new Promise(() => {}), close() {} }),
    sleep: async () => {},
    shouldExit: () => true,
    signalTarget: new EventEmitter(),
  });
  assert.deepEqual(result, { exitReason: "should-exit" });
  assert.equal(spawned, 0);
});

test("missing token is retried without crashing and version guard eventually exits", async () => {
  let tries = 0;
  const warnings = [];
  const result = await runSupervisor({
    probe: async () => ({ state: "unavailable" }),
    spawnRuntime: () => {
      tries += 1;
      const err = new Error("Missing background capture credential: web-capture-token");
      err.code = "BACKGROUND_TOKEN_MISSING";
      throw err;
    },
    watchSources: () => ({ promise: new Promise(() => {}), close() {} }),
    sleep: async () => {},
    shouldExit: () => tries === 2,
    signalTarget: new EventEmitter(),
    logger: { info() {}, warn(text) { warnings.push(text); } },
  });
  assert.equal(tries, 2);
  assert.equal(warnings.length, 1);
  assert.deepEqual(result, { exitReason: "should-exit" });
});

test("agent skips non-launchd calls lacking desktop data root", async () => {
  const result = await runBackgroundCaptureAgent({ env: {}, supervisor: () => { throw new Error("must not start"); } });
  assert.deepEqual(result, { exitReason: "not-launched" });
});

test("agent stops with exit 75 when bundle changes", async () => {
  let exitCode;
  let options;
  await runBackgroundCaptureAgent({
    env: { MOSA_DESKTOP_DATA_DIR: "/tmp/mosa" },
    execPath: "/A/GravityPort.app/Contents/MacOS/GravityPort",
    readFileSync: () => "<key>CFBundleShortVersionString</key><string>0.3.9</string>",
    supervisor: async (args) => { options = args; return { exitReason: "should-exit" }; },
    exit: (code) => { exitCode = code; },
  });
  assert.equal(exitCode, 75);
  assert.equal(typeof options.shouldExit, "function");
});
