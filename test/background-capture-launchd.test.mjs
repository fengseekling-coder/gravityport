import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKGROUND_AGENT_LABEL,
  shouldManageBackgroundAgent,
  buildBackgroundAgentPlist,
  syncBackgroundAgent,
  readBackgroundCaptureSetting,
  writeBackgroundCaptureSetting,
} from "../desktop/background-capture-launchd.mjs";

test("launchd management only on packaged Darwin with no QA or override switches", () => {
  const base = { platform: "darwin", isPackaged: true, env: {} };
  assert.equal(shouldManageBackgroundAgent(base), true);
  assert.equal(shouldManageBackgroundAgent({ ...base, platform: "win32" }), false);
  assert.equal(shouldManageBackgroundAgent({ ...base, isPackaged: false }), false);
  for (const [key, value] of Object.entries({
    MOSA_QA_RUN: "1", MOSA_USER_DATA: "/x", MOSA_LIBRARY_DIR: "/x",
    GRAVITYPORT_LIBRARY_DIR: "/x", MOSA_DESKTOP_PORT: "43617", MOSA_RUNTIME_MODE: "qa",
  })) {
    assert.equal(shouldManageBackgroundAgent({ ...base, env: { [key]: value } }), false, key);
  }
  assert.equal(shouldManageBackgroundAgent({ ...base, env: { MOSA_QA_RUN: "" } }), true);
});

test("plist contains safe start arguments, escaped paths, no tokens, and correct restart policy", () => {
  const plist = buildBackgroundAgentPlist({
    execPath: "/Applications/Gravity & Port.app/Contents/MacOS/GravityPort",
    agentEntry: "/Applications/Gravity & Port.app/Contents/Resources/app.asar/desktop/background-capture-agent.mjs",
    userDataDir: "/Users/u/Library/Application Support/mosa",
    logDir: "/Users/u/Library/Logs/GravityPort",
  });
  assert.ok(plist.includes("<string>com.azhuilab.gravityport.background</string>"));
  assert.ok(plist.includes("Gravity &amp; Port.app"));
  assert.ok(!plist.includes("Gravity & Port"));
  assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(plist, /<key>ELECTRON_RUN_AS_NODE<\/key><string>1<\/string>/);
  assert.ok(plist.includes("<string>/Users/u/Library/Logs/GravityPort/background.err.log</string>"));
  assert.ok(!plist.includes("TOKEN"));
  assert.ok(!plist.includes("com.azhuilab.mosa.web-capture"));
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>10<\/integer>/);
});

function fakeIo(initial) {
  const files = new Map(initial ? [["/launch/agent.plist", initial]] : []);
  const calls = [];
  return {
    files,
    calls,
    existsSync: p => files.has(p),
    readFileSync: p => files.get(p),
    writeFileSync: (p, data) => { calls.push(["write", p]); files.set(p, String(data)); },
    unlinkSync: p => { calls.push(["unlink", p]); files.delete(p); },
    mkdirSync: p => { calls.push(["mkdir", p]); },
    renameSync: (from, to) => {
      calls.push(["rename", from, to]); files.set(to, files.get(from)); files.delete(from);
    },
  };
}

async function syncCase({ initial, enabled, fail = false }) {
  const fs = fakeIo(initial);
  const calls = [];
  const result = await syncBackgroundAgent({
    enabled, desiredXml: "<plist>new</plist>", plistPath: "/launch/agent.plist", uid: 501, fs,
    launchctl: async args => {
      calls.push(args);
      return fail ? { code: 5, stderr: "Bootstrap failed: 5: Input/output error\nmore" } : { code: 0, stderr: "" };
    },
  });
  return { fs, calls, result };
}

test("installs a new launch agent exactly once", async () => {
  const { fs, calls, result } = await syncCase({ enabled: true });
  assert.deepEqual(result, { action: "installed", ok: true });
  assert.deepEqual(calls, [["bootstrap", "gui/501", "/launch/agent.plist"]]);
  assert.equal(fs.files.get("/launch/agent.plist"), "<plist>new</plist>");
});

test("unchanged plist does not rewrite or invoke launchctl", async () => {
  const { fs, calls, result } = await syncCase({ initial: "<plist>new</plist>", enabled: true });
  assert.deepEqual(result, { action: "unchanged", ok: true });
  assert.equal(calls.length, 0);
  assert.equal(fs.calls.filter(call => call[0] === "write").length, 0);
});

test("updates by bootout before bootstrap", async () => {
  const { calls, result } = await syncCase({ initial: "old", enabled: true });
  assert.deepEqual(result, { action: "updated", ok: true });
  assert.deepEqual(calls, [
    ["bootout", `gui/501/${BACKGROUND_AGENT_LABEL}`],
    ["bootstrap", "gui/501", "/launch/agent.plist"],
  ]);
});

test("disabling removes the existing agent and leaves absent agents untouched", async () => {
  const removed = await syncCase({ initial: "old", enabled: false });
  assert.deepEqual(removed.result, { action: "removed", ok: true });
  assert.deepEqual(removed.calls, [["bootout", `gui/501/${BACKGROUND_AGENT_LABEL}`]]);
  assert.equal(removed.fs.files.has("/launch/agent.plist"), false);
  const absent = await syncCase({ enabled: false });
  assert.deepEqual(absent.result, { action: "absent", ok: true });
  assert.equal(absent.calls.length, 0);
});

test("bootstrap errors produce one-line failure results rather than exceptions", async () => {
  const { result } = await syncCase({ enabled: true, fail: true });
  assert.deepEqual(result, { action: "installed", ok: false, error: "Bootstrap failed: 5: Input/output error" });
});

test("setting defaults on absent, malformed, or nonboolean data", () => {
  const fs = fakeIo();
  const dir = "/data";
  assert.deepEqual(readBackgroundCaptureSetting(dir, fs), { enabled: true });
  writeBackgroundCaptureSetting(dir, false, fs);
  assert.deepEqual(readBackgroundCaptureSetting(dir, fs), { enabled: false });
  fs.files.set("/data/background-capture.json", "not json");
  assert.deepEqual(readBackgroundCaptureSetting(dir, fs), { enabled: true });
  fs.files.set("/data/background-capture.json", '{"enabled":"no"}');
  assert.deepEqual(readBackgroundCaptureSetting(dir, fs), { enabled: true });
  assert.equal(fs.calls.some(call => call[0] === "rename"), true);
});
