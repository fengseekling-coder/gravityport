import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import {
  probeMosaOwner,
  probeRuntimeLease,
  runSupervisor,
  watchDesktopStartupHandoff,
  watchOwnedRuntimeSources,
  waitForReplacementOwner,
} from "../scripts/macos-web-capture-supervisor.mjs";

test("supervisor gives a verified desktop startup handoff priority over port probing", async () => {
  let fetchCalls = 0;
  const status = await probeMosaOwner({
    libraryDir: "/tmp/mosa-library",
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("should not probe HTTP while desktop handoff is active");
    },
    handoffProbe: async () => ({ state: "handoff", owner: { pid: 777 } }),
  });
  assert.deepEqual(status, { state: "handoff", owner: { pid: 777 } });
  assert.equal(fetchCalls, 0);
});

test("supervisor recognizes a verified MOSA owner for the same library", async () => {
  const status = await probeMosaOwner({
    port: 43517,
    libraryDir: "/tmp/mosa-library",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ product: "mosa", libraryDir: "/tmp/mosa-library" }),
    }),
  });
  assert.equal(status.state, "attached");
});

test("supervisor refuses to start over a different library or non-MOSA listener", async () => {
  const differentLibrary = await probeMosaOwner({
    libraryDir: "/tmp/mosa-library",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ product: "mosa", libraryDir: "/tmp/other-library" }),
    }),
  });
  assert.deepEqual(differentLibrary, { state: "conflict", reason: "different-library" });

  const foreign = await probeMosaOwner({
    libraryDir: "/tmp/mosa-library",
    fetchImpl: async () => ({ ok: true, json: async () => ({ product: "other" }) }),
  });
  assert.deepEqual(foreign, { state: "conflict", reason: "non-mosa-listener" });
});

test("supervisor treats an active verified runtime lock as an owner while HTTP is still starting", async () => {
  const lease = await probeRuntimeLease({
    libraryDir: "/tmp/mosa-library",
    readFileImpl: async () => JSON.stringify({ token: "owner-token", pid: 4242, processIdentity: "start-1" }),
    isProcessAlive: () => true,
    verifyProcessIdentity: async () => true,
  });
  assert.deepEqual(lease, { state: "starting", owner: { pid: 4242 } });

  const status = await probeMosaOwner({
    libraryDir: "/tmp/mosa-library",
    fetchImpl: async () => {
      const error = new Error("connection refused");
      error.code = "ECONNREFUSED";
      throw error;
    },
    leaseProbe: async () => lease,
  });
  assert.deepEqual(status, lease);
});

test("stale or recycled runtime locks never suppress background recovery", async () => {
  const dead = await probeRuntimeLease({
    libraryDir: "/tmp/mosa-library",
    readFileImpl: async () => JSON.stringify({ token: "owner-token", pid: 4242, processIdentity: "start-1" }),
    isProcessAlive: () => false,
  });
  assert.deepEqual(dead, { state: "unavailable" });

  const recycled = await probeRuntimeLease({
    libraryDir: "/tmp/mosa-library",
    readFileImpl: async () => JSON.stringify({ token: "owner-token", pid: 4242, processIdentity: "start-1" }),
    isProcessAlive: () => true,
    verifyProcessIdentity: async () => false,
  });
  assert.deepEqual(recycled, { state: "unavailable" });
});

test("takeover grace observes a desktop owner before restarting the background runtime", async () => {
  const states = [
    { state: "unavailable" },
    { state: "unavailable" },
    { state: "attached", health: { product: "mosa" } },
  ];
  let sleeps = 0;
  const result = await waitForReplacementOwner({
    probe: async () => states.shift() || { state: "attached" },
    sleep: async () => { sleeps += 1; },
    graceMs: 1000,
    pollMs: 250,
  });
  assert.equal(result.state, "attached");
  assert.equal(sleeps, 2);
});

test("supervisor stands by while desktop owns the library and starts service after it leaves", async () => {
  const signalTarget = new EventEmitter();
  let probeCount = 0;
  let spawnCount = 0;
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  };

  await runSupervisor({
    signalTarget,
    probe: async () => {
      probeCount += 1;
      if (probeCount <= 2) return { state: "attached" };
      return { state: "unavailable" };
    },
    spawnRuntime: () => {
      spawnCount += 1;
      queueMicrotask(() => signalTarget.emit("SIGTERM"));
      return child;
    },
    sleep: async (delayMs) => new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs)),
    idlePollMs: 1,
    takeoverGraceMs: 1,
    takeoverPollMs: 1,
    logger: { info() {}, warn() {} },
  });

  assert.equal(spawnCount, 1);
  assert.ok(probeCount >= 3);
});

test("supervisor resumes background fallback after a desktop handoff marker expires", async () => {
  const signalTarget = new EventEmitter();
  let probeCount = 0;
  let spawnCount = 0;
  const child = new EventEmitter();
  child.pid = 4343;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  };

  await runSupervisor({
    signalTarget,
    probe: async () => {
      probeCount += 1;
      if (probeCount <= 2) return { state: "handoff", owner: { pid: 777 } };
      return { state: "unavailable" };
    },
    spawnRuntime: () => {
      spawnCount += 1;
      queueMicrotask(() => signalTarget.emit("SIGTERM"));
      return child;
    },
    sleep: async (delayMs) => new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs)),
    idlePollMs: 1,
    takeoverGraceMs: 1,
    controlledTakeoverGraceMs: 1,
    takeoverPollMs: 1,
    logger: { info() {}, warn() {} },
  });

  assert.equal(spawnCount, 1);
  assert.ok(probeCount >= 3);
});

test("source watcher resolves once and closes every watched handle", async () => {
  const callbacks = [];
  const handles = [];
  const sourceWatch = watchOwnedRuntimeSources({
    settleMs: 1,
    sources: [
      { path: "/tmp/app", recursive: true },
      { path: "/tmp/server.mjs", recursive: false },
    ],
    watchImpl: (_path, _options, callback) => {
      callbacks.push(callback);
      const handle = new EventEmitter();
      const keepEventLoopAlive = setTimeout(() => {}, 1000);
      handle.closed = false;
      handle.close = () => {
        clearTimeout(keepEventLoopAlive);
        handle.closed = true;
      };
      handles.push(handle);
      return handle;
    },
  });

  callbacks[0]();
  callbacks[1]();
  assert.deepEqual(await sourceWatch.promise, { reason: "source-change" });
  assert.equal(handles.every((handle) => handle.closed), true);
});

test("supervisor restarts an owned background runtime when source changes", async () => {
  const signalTarget = new EventEmitter();
  let spawnCount = 0;
  let watchCount = 0;
  const children = [];

  function makeChild(pid) {
    const child = new EventEmitter();
    child.pid = pid;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal) => {
      child.signalCode = signal;
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    };
    children.push(child);
    return child;
  }

  await runSupervisor({
    signalTarget,
    probe: async () => ({ state: "unavailable" }),
    spawnRuntime: () => {
      spawnCount += 1;
      const child = makeChild(5000 + spawnCount);
      if (spawnCount === 2) queueMicrotask(() => signalTarget.emit("SIGTERM"));
      return child;
    },
    watchSources: () => {
      watchCount += 1;
      return {
        promise: watchCount === 1
          ? Promise.resolve({ reason: "source-change" })
          : new Promise(() => {}),
        close() {},
      };
    },
    sleep: async (delayMs) => new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs)),
    takeoverGraceMs: 1,
    takeoverPollMs: 1,
    logger: { info() {}, warn() {} },
  });

  assert.equal(spawnCount, 2);
  assert.equal(children[0].signalCode, "SIGTERM");
  assert.equal(children[1].signalCode, "SIGTERM");
});

test("handoff watcher resolves when a desktop marker becomes active", async () => {
  let probes = 0;
  const watcher = watchDesktopStartupHandoff({
    pollMs: 1,
    probe: async () => {
      probes += 1;
      return probes < 2 ? { state: "unavailable" } : { state: "handoff", owner: { pid: 777 } };
    },
  });
  assert.deepEqual(await watcher.promise, { state: "handoff", owner: { pid: 777 } });
  watcher.close();
  assert.equal(probes, 2);
});

test("running supervisor runtime yields immediately when desktop startup handoff appears", async () => {
  const signalTarget = new EventEmitter();
  const child = new EventEmitter();
  child.pid = 5151;
  child.exitCode = null;
  child.signalCode = null;
  const killed = [];
  child.kill = (signal) => {
    killed.push(signal);
    child.signalCode = signal;
    queueMicrotask(() => {
      child.emit("exit", null, signal);
      signalTarget.emit("SIGTERM");
    });
    return true;
  };

  await runSupervisor({
    signalTarget,
    probe: async () => ({ state: "unavailable" }),
    spawnRuntime: () => child,
    watchSources: () => ({ promise: new Promise(() => {}), close() {} }),
    watchHandoff: () => ({
      promise: Promise.resolve({ state: "handoff", owner: { pid: 777 } }),
      close() {},
    }),
    sleep: async (delayMs) => new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs)),
    takeoverGraceMs: 1,
    takeoverPollMs: 1,
    logger: { info() {}, warn() {} },
  });
  assert.deepEqual(killed, ["SIGTERM"]);
});

test("handoff yield does not respawn a background runtime before desktop acquires the lock", async () => {
  const signalTarget = new EventEmitter();
  const child = new EventEmitter();
  child.pid = 5151;
  child.exitCode = null;
  child.signalCode = null;
  const killed = [];
  let spawnCount = 0;
  let probeCount = 0;
  child.kill = (signal) => {
    killed.push(signal);
    child.signalCode = signal;
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  };

  let sleepCalls = 0;
  const supervised = runSupervisor({
    signalTarget,
    probe: async () => {
      probeCount += 1;
      return probeCount === 1 ? { state: "unavailable" } : { state: "handoff", owner: { pid: 777 } };
    },
    spawnRuntime: () => {
      spawnCount += 1;
      return child;
    },
    watchSources: () => ({ promise: new Promise(() => {}), close() {} }),
    watchHandoff: () => ({
      promise: Promise.resolve({ state: "handoff", owner: { pid: 777 } }),
      close() {},
    }),
    sleep: async (delayMs) => {
      sleepCalls += 1;
      if (sleepCalls === 2) signalTarget.emit("SIGTERM");
      await new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs));
    },
    takeoverGraceMs: 1,
    controlledTakeoverGraceMs: 1,
    takeoverPollMs: 1,
    idlePollMs: 5,
    logger: { info() {}, warn() {} },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await supervised;

  assert.equal(spawnCount, 1);
  assert.deepEqual(killed, ["SIGTERM"]);
  assert.ok(probeCount >= 2);
});

test("handoff cooldown keeps refreshing while the verified desktop marker remains alive", async () => {
  const signalTarget = new EventEmitter();
  const child = new EventEmitter();
  child.pid = 5152;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  };
  let spawnCount = 0;
  let probeCount = 0;

  const supervised = runSupervisor({
    signalTarget,
    probe: async () => {
      probeCount += 1;
      return { state: "handoff", owner: { pid: 778 } };
    },
    spawnRuntime: () => {
      spawnCount += 1;
      return child;
    },
    watchSources: () => ({ promise: new Promise(() => {}), close() {} }),
    watchHandoff: () => ({ promise: new Promise(() => {}), close() {} }),
    sleep: async (delayMs) => new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs)),
    idlePollMs: 5,
    takeoverGraceMs: 1,
    controlledTakeoverGraceMs: 1,
    takeoverPollMs: 1,
    logger: { info() {}, warn() {} },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  signalTarget.emit("SIGTERM");
  await supervised;

  assert.equal(spawnCount, 0);
  assert.ok(probeCount >= 2);
});

// Task 314: health digests replace the published library path; the supervisor
// recomputes the expected digest from the library directory it watches.
test("probeMosaOwner compares library digests and keeps the legacy path fallback", async (t) => {
  const { mkdir, mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { ensureLibraryId, libraryDigest } = await import("../lib/library-identity.mjs");
  const { deferTestPathRemoval } = await import("./test-cleanup.mjs");
  const root = await mkdtemp(join(tmpdir(), "mosa-supervisor-digest-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const expectedLibraryDir = join(root, "library");
  await mkdir(expectedLibraryDir, { recursive: true });
  const expectedDigest = libraryDigest(await ensureLibraryId(expectedLibraryDir), expectedLibraryDir);

  const otherLibraryDir = join(root, "other-library");
  await mkdir(otherLibraryDir, { recursive: true });
  const otherDigest = libraryDigest(await ensureLibraryId(otherLibraryDir), otherLibraryDir);

  const probeWith = (health, overrides = {}) => probeMosaOwner({
    libraryDir: expectedLibraryDir,
    fetchImpl: async () => ({ ok: true, json: async () => health }),
    handoffProbe: async () => ({ state: "unavailable" }),
    ...overrides,
  });

  const matching = await probeWith({ product: "mosa", libraryDigest: expectedDigest });
  assert.equal(matching.state, "attached", "a matching digest attaches without any path in health");

  const copied = await probeWith({ product: "mosa", libraryDigest: otherDigest });
  assert.deepEqual(copied, { state: "conflict", reason: "different-library" }, "a copied library (same id, other path) must conflict");

  const noLocalId = await probeWith({ product: "mosa", libraryDigest: expectedDigest }, {
    libraryDir: join(root, "library-without-id"),
  });
  assert.deepEqual(noLocalId, { state: "conflict", reason: "different-library" }, "a digest without a local id file is a mismatch");

  const neither = await probeWith({ product: "mosa" });
  assert.deepEqual(neither, { state: "conflict", reason: "non-mosa-listener" }, "neither digest nor legacy path is not GravityPort");

  const legacy = await probeWith({ product: "mosa", libraryDir: expectedLibraryDir });
  assert.equal(legacy.state, "attached", "legacy runtimes that still publish libraryDir keep working");

  const legacyForeign = await probeWith({ product: "mosa", libraryDir: otherLibraryDir });
  assert.deepEqual(legacyForeign, { state: "conflict", reason: "different-library" });
});
