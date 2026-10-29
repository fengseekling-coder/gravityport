// Live sync reconnection resync tests.
import { execFileSync } from "node:child_process";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");

let lsr; // live-sync-resync exports

before(async () => {
  const compileRoot = await mkdtemp(join(tmpdir(), "mosa-gp-lsr-"));
  const sources = [join(uiRoot, "src", "live-sync-resync.ts")];
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    ...sources,
    "--outDir", compileRoot,
    "--module", "esnext",
    "--target", "es2022",
    "--moduleResolution", "bundler",
    "--skipLibCheck",
  ], { stdio: "pipe" });
  lsr = await import(join(compileRoot, "live-sync-resync.js"));
  after(async () => { await rm(compileRoot, { recursive: true, force: true }); });
});

describe("createResyncOnReconnect — first open", () => {
  it("first handleOpen() does not trigger onResync", async () => {
    let called = false;
    const ctrl = lsr.createResyncOnReconnect({
      onResync: () => { called = true; },
      delayMs: 50,
      schedule: (fn) => setTimeout(fn, 10),
      cancel: clearTimeout,
    });
    ctrl.handleOpen();
    await new Promise((r) => setTimeout(r, 80)); // wait for any scheduled callbacks
    assert.equal(called, false);
    ctrl.dispose();
  });
});

describe("createResyncOnReconnect — subsequent open", () => {
  it("second handleOpen() triggers onResync once after delay", async () => {
    let callCount = 0;
    const ctrl = lsr.createResyncOnReconnect({
      onResync: () => { callCount++; },
      delayMs: 20,
      schedule: (fn) => setTimeout(fn, 10),
      cancel: clearTimeout,
    });

    ctrl.handleOpen(); // first — skip
    await new Promise((r) => setTimeout(r, 5));
    ctrl.handleOpen(); // second — should schedule
    assert.equal(callCount, 0, "should not fire before delay");

    await new Promise((r) => setTimeout(r, 15));
    assert.equal(callCount, 1, "should fire exactly once after delay");
    ctrl.dispose();
  });
});

describe("createResyncOnReconnect — debounce", () => {
  it("open + change within delay only triggers once (last one wins)", async () => {
    let callCount = 0;
    const ctrl = lsr.createResyncOnReconnect({
      onResync: () => { callCount++; },
      delayMs: 30,
      schedule: (fn) => setTimeout(fn, 20),
      cancel: clearTimeout,
    });

    ctrl.handleOpen(); // first — skip
    ctrl.handleChange(); // schedule resync at +30ms
    await new Promise((r) => setTimeout(r, 5));
    ctrl.handleOpen(); // reschedule at +30ms again
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(callCount, 1, "should trigger exactly once despite two calls");
    ctrl.dispose();
  });

  it("multiple rapid handleChange() calls only trigger once", async () => {
    let callCount = 0;
    const ctrl = lsr.createResyncOnReconnect({
      onResync: () => { callCount++; },
      delayMs: 25,
      schedule: (fn) => setTimeout(fn, 15),
      cancel: clearTimeout,
    });

    ctrl.handleChange();
    ctrl.handleChange();
    ctrl.handleChange();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(callCount, 1);
    ctrl.dispose();
  });
});

describe("createResyncOnReconnect — dispose", () => {
  it("dispose cancels pending trigger", async () => {
    let called = false;
    const ctrl = lsr.createResyncOnReconnect({
      onResync: () => { called = true; },
      delayMs: 2000,
      schedule: (fn) => setTimeout(fn, 20),
      cancel: clearTimeout,
    });

    ctrl.handleOpen(); // first — skip
    ctrl.handleChange(); // schedule
    ctrl.dispose();

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(called, false, "should not fire after dispose");
  });

  it("no-op after dispose", async () => {
    let callCount = 0;
    const ctrl = lsr.createResyncOnReconnect({
      onResync: () => { callCount++; },
      delayMs: 20,
      schedule: (fn) => setTimeout(fn, 10),
      cancel: clearTimeout,
    });

    ctrl.dispose();
    ctrl.handleOpen();
    ctrl.handleChange();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(callCount, 0);
  });
});

describe("createResyncOnReconnect — default schedule/cancel", () => {
  it("works without explicit schedule/cancel (uses global setTimeout/clearTimeout)", async () => {
    let callCount = 0;
    const ctrl = lsr.createResyncOnReconnect({
      onResync: () => { callCount++; },
      delayMs: 10,
    });

    ctrl.handleOpen(); // first — skip
    ctrl.handleChange();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(callCount, 1);
    ctrl.dispose();
  });
});

describe("createSseRefreshGate — task 292 bridge", () => {
  function makeGate(blocked) {
    let refreshes = 0;
    const gate = lsr.createSseRefreshGate({
      isBlocked: blocked,
      refresh: () => { refreshes += 1; },
    });
    return { gate, count: () => refreshes };
  }

  it("an unblocked request refreshes immediately", () => {
    const { gate, count } = makeGate(() => false);
    gate.request();
    assert.equal(count(), 1, "no import, no load — the refresh goes out at once");
    assert.equal(gate.takePending(), false, "nothing was queued");
  });

  it("five changes while the gallery is loading never fire; the settled load owes exactly one refresh", () => {
    const { gate, count } = makeGate(() => true);
    for (let i = 0; i < 5; i += 1) gate.request();
    assert.equal(count(), 0, "the in-flight load is never aborted");
    assert.equal(gate.takePending(), true, "one follow-up is owed");
    assert.equal(gate.takePending(), false, "at most one queues — no backlog");
  });

  it("five changes during an import hold off entirely; import end consumes the marker and fires its own refresh", () => {
    const { gate, count } = makeGate(() => true);
    for (let i = 0; i < 5; i += 1) gate.request();
    assert.equal(count(), 0, "SSE refreshes stay silent while the import runs");
    // Import end (success path): the import fires its own refresh and merely
    // drops the queued marker — exactly one refresh for the whole import.
    gate.takePending();
    assert.equal(count(), 0, "the gate itself did not fire; the import's own refresh covers it");
  });

  it("a failed import fires the one queued refresh", () => {
    const { gate, count } = makeGate(() => true);
    gate.request();
    gate.request();
    assert.equal(gate.takePending(), true, "the thrown import still owes the gallery its refresh");
    assert.equal(count(), 0, "firing is the caller's job; the marker is consumed");
  });
});
