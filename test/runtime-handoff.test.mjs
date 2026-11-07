import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createMosaDesktopStartupHandoff,
  createMosaMacosUpdateHelperHandoff,
  mosaDesktopStartupHandoffPath,
  probeMosaDesktopStartupHandoff,
} from "../lib/runtime-handoff.mjs";
import { readMosaRuntimeProcessIdentity } from "../lib/runtime-lock.js";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

test("desktop startup handoff is bound to PID/process identity and releases only its own marker", async (t) => {
  const libraryDir = await mkdtemp(join(tmpdir(), "mosa-handoff-"));
  deferTestPathRemoval(libraryDir, { recursive: true, force: true });
  const nowMs = Date.parse("2026-09-18T20:00:00.000Z");
  const lease = await createMosaDesktopStartupHandoff({
    libraryDir,
    pid: 4242,
    ttlMs: 30_000,
    now: () => nowMs,
    readProcessIdentity: async () => "unix-start:desktop-start",
    randomUUIDImpl: () => "handoff-token-1234",
  });
  const marker = JSON.parse(await readFile(mosaDesktopStartupHandoffPath(libraryDir), "utf8"));
  assert.equal(marker.pid, 4242);
  assert.equal(marker.processIdentity, "unix-start:desktop-start");

  const status = await probeMosaDesktopStartupHandoff({
    libraryDir,
    now: () => nowMs + 100,
    isProcessAlive: () => true,
    verifyProcessIdentity: async (owner) => owner.processIdentity === "unix-start:desktop-start",
  });
  assert.equal(status.state, "handoff");
  assert.equal(status.owner.pid, 4242);
  assert.equal(await lease.release(), true);
  assert.equal(await lease.release(), false);
  await assert.rejects(access(mosaDesktopStartupHandoffPath(libraryDir)));
});

// 任务 367（NATIVE-03i）：另一个启动来认领时报错带码和 PID，桌面启动失败框
// 按码选中英文；英文原句留在 message 里只进日志。走真实探针（marker 写本
// 测试进程的 PID 和 ps 可见的启动身份），不改探针钩子。
test("a second desktop startup claim rejects with the handoff-claimed code and owner pid", async (t) => {
  const libraryDir = await mkdtemp(join(tmpdir(), "mosa-handoff-claimed-"));
  deferTestPathRemoval(libraryDir, { recursive: true, force: true });
  const identity = await readMosaRuntimeProcessIdentity(process.pid);
  assert.ok(identity, "the test process exposes a ps start identity");
  const lease = await createMosaDesktopStartupHandoff({
    libraryDir,
    pid: process.pid,
    ttlMs: 30_000,
    readProcessIdentity: async () => identity,
  });
  t.after(() => lease.release());
  await assert.rejects(
    createMosaDesktopStartupHandoff({
      libraryDir,
      pid: process.pid,
      ttlMs: 30_000,
      readProcessIdentity: async () => identity,
    }),
    (error) => {
      assert.match(error.message, /already claiming this library/);
      assert.equal(error.code, "MOSA_STARTUP_HANDOFF_CLAIMED");
      assert.equal(error.pid, process.pid);
      return true;
    },
  );
});

test("expired handoff markers are ignored and removed so background fallback can recover", async (t) => {
  const libraryDir = await mkdtemp(join(tmpdir(), "mosa-handoff-expired-"));
  deferTestPathRemoval(libraryDir, { recursive: true, force: true });
  const nowMs = Date.parse("2026-09-18T20:00:00.000Z");
  await createMosaDesktopStartupHandoff({
    libraryDir,
    pid: 4242,
    ttlMs: 1_000,
    now: () => nowMs,
    readProcessIdentity: async () => "unix-start:desktop-start",
  });
  const status = await probeMosaDesktopStartupHandoff({
    libraryDir,
    now: () => nowMs + 1_001,
    isProcessAlive: () => true,
    verifyProcessIdentity: async () => true,
  });
  assert.deepEqual(status, { state: "unavailable" });
  await assert.rejects(access(mosaDesktopStartupHandoffPath(libraryDir)));
});

test("PID reuse cannot keep a handoff alive when process start identity changes", async (t) => {
  const libraryDir = await mkdtemp(join(tmpdir(), "mosa-handoff-recycled-"));
  deferTestPathRemoval(libraryDir, { recursive: true, force: true });
  const nowMs = Date.parse("2026-09-18T20:00:00.000Z");
  await createMosaDesktopStartupHandoff({
    libraryDir,
    pid: 4242,
    ttlMs: 30_000,
    now: () => nowMs,
    readProcessIdentity: async () => "unix-start:first-process",
  });
  const status = await probeMosaDesktopStartupHandoff({
    libraryDir,
    now: () => nowMs + 500,
    isProcessAlive: () => true,
    verifyProcessIdentity: async () => false,
  });
  assert.deepEqual(status, { state: "unavailable" });
  await assert.rejects(access(mosaDesktopStartupHandoffPath(libraryDir)));
});

test("macOS update helper handoff reuses the existing supervisor marker for backward compatibility", async () => {
  const libraryDir = await mkdtemp(join(tmpdir(), "mosa-update-handoff-"));
  deferTestPathRemoval(libraryDir, { recursive: true, force: true });
  const nowMs = Date.parse("2026-09-19T18:30:00.000Z");
  await createMosaMacosUpdateHelperHandoff({
    libraryDir,
    pid: 5151,
    now: () => nowMs,
    readProcessIdentity: async () => "unix-start:update-helper",
    randomUUIDImpl: () => "update-helper-token",
  });
  const marker = JSON.parse(await readFile(mosaDesktopStartupHandoffPath(libraryDir), "utf8"));
  assert.equal(marker.pid, 5151);
  assert.equal(Date.parse(marker.expiresAt) - Date.parse(marker.createdAt), 90_000);
  const updateStatus = await probeMosaDesktopStartupHandoff({
    libraryDir,
    now: () => nowMs + 45_000,
    isProcessAlive: () => true,
    verifyProcessIdentity: async () => true,
  });
  assert.equal(updateStatus.state, "handoff");
  assert.equal(updateStatus.owner.pid, 5151);
});
