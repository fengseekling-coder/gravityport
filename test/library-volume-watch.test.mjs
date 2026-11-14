import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createLibraryVolumeWatch, isLibraryPresent } from "../desktop/library-volume-watch.mjs";
import { createLibraryChangeStream } from "../lib/library-change-stream.mjs";

test("isLibraryPresent requires both libraryDir and mosa.db", () => {
  const libDir = "/Volumes/GPTest/Library";
  const dbPath = join(libDir, "mosa.db");
  assert.equal(isLibraryPresent("", { exists: () => true }), false);
  assert.equal(isLibraryPresent(libDir, { exists: () => false }), false);
  assert.equal(isLibraryPresent(libDir, { exists: (p) => p === libDir }), false);
  assert.equal(isLibraryPresent(libDir, { exists: (p) => p === libDir || p === dbPath }), true);
});

test("library present -> checkNow does nothing", async () => {
  const events = [];
  const watch = createLibraryVolumeWatch({
    intervalMs: 60_000,
    exists: () => true,
    stopCaptureAndPolling: () => events.push("stopCapture"),
    closeLibrary: () => events.push("closeLibrary"),
    showMissingDialog: () => events.push("showDialog"),
    exit: (code) => events.push(`exit:${code}`),
    log: { warn() {} },
  });

  watch.start("/Volumes/GPTest/Library");
  try {
    const triggered = await watch.checkNow();
    assert.equal(triggered, false);
    assert.deepEqual(events, []);
  } finally {
    watch.stop();
  }
});

test("library missing -> calls stopCaptureAndPolling, closeLibrary, showMissingDialog, exit(0) in order, once each", async () => {
  const events = [];
  let present = true;
  const watch = createLibraryVolumeWatch({
    intervalMs: 60_000,
    exists: () => present,
    stopCaptureAndPolling: async (dir) => events.push(`stopCapture:${dir}`),
    closeLibrary: async (dir) => events.push(`closeLibrary:${dir}`),
    showMissingDialog: async (dir) => events.push(`showDialog:${dir}`),
    exit: (code) => events.push(`exit:${code}`),
    log: { warn() {} },
  });

  const libDir = "/Volumes/GPTest/Library";
  watch.start(libDir);
  try {
    present = false;
    const first = await watch.checkNow();
    const second = await watch.checkNow();
    assert.equal(first, true);
    assert.equal(second, false);
    assert.deepEqual(events, [
      `stopCapture:${libDir}`,
      `closeLibrary:${libDir}`,
      `showDialog:${libDir}`,
      "exit:0",
    ]);
  } finally {
    watch.stop();
  }
});

test("closeLibrary throwing -> still shows missing dialog and exits with 0", async () => {
  const events = [];
  const warnings = [];
  const watch = createLibraryVolumeWatch({
    intervalMs: 60_000,
    exists: () => false,
    stopCaptureAndPolling: async () => events.push("stopCapture"),
    closeLibrary: async () => {
      events.push("closeLibrary");
      throw new Error("ENXIO: device not configured");
    },
    showMissingDialog: async () => events.push("showDialog"),
    exit: (code) => events.push(`exit:${code}`),
    log: { warn: (msg) => warnings.push(msg) },
  });

  watch.start("/Volumes/GPTest/Library");
  try {
    const triggered = await watch.checkNow();
    assert.equal(triggered, true);
    assert.deepEqual(events, ["stopCapture", "closeLibrary", "showDialog", "exit:0"]);
    assert.equal(warnings.length, 2);
  } finally {
    watch.stop();
  }
});

test("closeLibrary never settling -> times out, still shows missing dialog and exits with 0", async () => {
  const events = [];
  const warnings = [];
  const watch = createLibraryVolumeWatch({
    intervalMs: 60_000,
    closeTimeoutMs: 50,
    exists: () => false,
    stopCaptureAndPolling: async () => {
      events.push("stopCapture");
      throw new Error("poll stop failed");
    },
    closeLibrary: () => {
      events.push("closeLibrary");
      return new Promise(() => {});
    },
    showMissingDialog: async () => {
      events.push("showDialog");
      throw new Error("dialog failed");
    },
    exit: (code) => events.push(`exit:${code}`),
    log: { warn: (msg) => warnings.push(msg) },
  });

  watch.start("/Volumes/GPTest/Library");
  try {
    const triggered = await watch.checkNow();
    assert.equal(triggered, true);
    assert.deepEqual(events, ["stopCapture", "closeLibrary", "showDialog", "exit:0"]);
    assert.ok(warnings.some((msg) => msg.includes("timed out after 50 ms")), warnings.join("\n"));
    assert.equal(warnings.length, 4);
  } finally {
    watch.stop();
  }
});

test("paused during relocation -> does not trigger even if library is absent; resumes on new path", async () => {
  const events = [];
  const existingPaths = new Set();
  const watch = createLibraryVolumeWatch({
    intervalMs: 60_000,
    exists: (p) => existingPaths.has(p),
    stopCaptureAndPolling: () => events.push("stopCapture"),
    closeLibrary: () => events.push("closeLibrary"),
    showMissingDialog: (dir) => events.push(`showDialog:${dir}`),
    exit: (code) => events.push(`exit:${code}`),
    log: { warn() {} },
  });

  const oldDir = "/Volumes/GPTest/OldLibrary";
  const newDir = "/Volumes/GPTest/NewLibrary";
  existingPaths.add(oldDir);
  existingPaths.add(join(oldDir, "mosa.db"));

  watch.start(oldDir);
  try {
    watch.pause();
    existingPaths.clear();
    assert.equal(await watch.checkNow(), false);
    assert.deepEqual(events, []);

    existingPaths.add(newDir);
    existingPaths.add(join(newDir, "mosa.db"));
    watch.resume(newDir);
    assert.equal(await watch.checkNow(), false);
    assert.deepEqual(events, []);

    existingPaths.delete(join(newDir, "mosa.db"));
    assert.equal(await watch.checkNow(), true);
    assert.deepEqual(events, [
      "stopCapture",
      "closeLibrary",
      `showDialog:${newDir}`,
      "exit:0",
    ]);
  } finally {
    watch.stop();
  }
});

test("createLibraryChangeStream skips libraryRevision when isLibraryAvailable returns false", async () => {
  let revisionCalls = 0;
  let available = false;
  const stream = createLibraryChangeStream({
    checkIntervalMs: 100,
    isLibraryAvailable: () => available,
    store: {
      libraryRevision: async () => {
        revisionCalls += 1;
        return "1";
      },
    },
  });

  const res = {
    statusCode: 0,
    setHeader() {},
    flushHeaders() {},
    write() { return true; },
    end() {},
    once() {},
    writableEnded: false,
    destroyed: false,
  };
  const req = { once() {} };
  await stream.attach(req, res, "default");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(revisionCalls, 0);

  available = true;
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(revisionCalls >= 1);
  stream.close();
});
