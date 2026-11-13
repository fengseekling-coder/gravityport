import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { acquireMosaRuntimeLock, readMosaRuntimeProcessIdentity } from "../lib/runtime-lock.js";

test("permits only one MOSA bridge runtime for a library", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-runtime-lock-"));
  const libraryDir = join(root, "library");
  deferTestPathRemoval(root, { recursive: true, force: true });

  const first = await acquireMosaRuntimeLock({ libraryDir });
  // 任务 367（NATIVE-03h）：锁被占的错误带码和 PID，桌面启动失败框按码选
  // 中英文；英文原句留在 message 里只进日志。
  await assert.rejects(
    acquireMosaRuntimeLock({ libraryDir }),
    (error) => {
      assert.match(error.message, /GravityPort runtime already active for this library/);
      assert.equal(error.code, "MOSA_STARTUP_LIBRARY_LOCKED");
      assert.equal(error.pid, process.pid);
      return true;
    },
  );
  assert.equal(await first.release(), true);

  const replacement = await acquireMosaRuntimeLock({ libraryDir });
  assert.equal(replacement.owner.pid, process.pid);
  assert.equal(await replacement.release(), true);
});

test("recovers a lock left by a terminated runtime", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-runtime-lock-stale-"));
  const libraryDir = join(root, "library");
  const lockPath = join(libraryDir, ".mosa-runtime.lock");
  await mkdir(libraryDir, { recursive: true });
  await writeFile(lockPath, `${JSON.stringify({ token: "stale", pid: 999_999_999, createdAt: "2026-07-23T00:00:00.000Z" })}\n`, "utf8");
  deferTestPathRemoval(root, { recursive: true, force: true });

  const lock = await acquireMosaRuntimeLock({ libraryDir });
  assert.equal(lock.owner.pid, process.pid);
  assert.equal(await lock.release(), true);
});

test("recovers a lock when the PID was recycled by a different process identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-runtime-lock-recycled-pid-"));
  const libraryDir = join(root, "library");
  const lockPath = join(libraryDir, ".mosa-runtime.lock");
  await mkdir(libraryDir, { recursive: true });
  await writeFile(lockPath, `${JSON.stringify({
    token: "old-runtime",
    pid: process.pid,
    createdAt: "2026-07-23T00:00:00.000Z",
    processIdentity: "unix-start:definitely-not-this-process",
  })}\n`, "utf8");
  deferTestPathRemoval(root, { recursive: true, force: true });

  const lock = await acquireMosaRuntimeLock({ libraryDir });
  assert.equal(lock.owner.pid, process.pid);
  assert.notEqual(lock.owner.processIdentity, "unix-start:definitely-not-this-process");
  assert.equal(await lock.release(), true);
});

test("legacy JSON MCP refuses a second writer while a MOSA runtime lease is active", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-mcp-json-lock-"));
  const libraryDir = join(root, "library");
  await mkdir(join(libraryDir, "assets", "default", "metadata"), { recursive: true });
  await writeFile(join(libraryDir, "assets", "default", "metadata", "legacy.json"), JSON.stringify({ id: "legacy", asset: "legacy.png" }));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const lease = await acquireMosaRuntimeLock({ libraryDir });
  t.after(() => lease.release());
  const server = spawn(process.execPath, ["mcp/server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, MOSA_LIBRARY_DIR: libraryDir, MOSA_PROJECT_DIR: root },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await Promise.race([
    once(server, "exit"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("MCP did not reject the active JSON runtime lease.")), 5000)),
  ]);
  assert.notEqual(code, 0);
  assert.match(stderr, /GravityPort runtime already active for this library/);
});

// 任务 398（低18 ⑥）：Windows 分支此前没有测试。readMosaRuntimeProcessIdentity
// 的第二参数是可选的（不传即原行为），让测试可以注入 platform 与假 execFile。
test("readMosaRuntimeProcessIdentity asks Windows PowerShell for the process start time", async () => {
  const calls = [];
  const fakeExecFile = async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: "638000000000000000\r\n", stderr: "" };
  };
  const identity = await readMosaRuntimeProcessIdentity(4242, { platform: "win32", execFile: fakeExecFile });
  assert.equal(identity, "win-start:638000000000000000");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "powershell.exe");
  assert.ok(
    calls[0].args.some((arg) => arg.includes("Get-Process -Id 4242")),
    `the PowerShell command must name the pid, got: ${JSON.stringify(calls[0].args)}`,
  );
  assert.equal(calls[0].options.windowsHide, true);
});

test("readMosaRuntimeProcessIdentity returns null when Windows PowerShell answers empty", async () => {
  const identity = await readMosaRuntimeProcessIdentity(4242, {
    platform: "win32",
    execFile: async () => ({ stdout: "", stderr: "" }),
  });
  assert.equal(identity, null);
});

test("readMosaRuntimeProcessIdentity returns null when Windows PowerShell fails", async () => {
  const identity = await readMosaRuntimeProcessIdentity(4242, {
    platform: "win32",
    execFile: async () => { throw new Error("powershell exploded"); },
  });
  assert.equal(identity, null);
});

test("readMosaRuntimeProcessIdentity refuses non-positive pids without spawning anything", async () => {
  let calls = 0;
  const countingExecFile = async () => { calls += 1; return { stdout: "1", stderr: "" }; };
  for (const badPid of [0, -1, 1.5, Number.NaN]) {
    const identity = await readMosaRuntimeProcessIdentity(badPid, { platform: "win32", execFile: countingExecFile });
    assert.equal(identity, null, `pid ${badPid} must answer null`);
  }
  assert.equal(calls, 0, "the fake execFile must never be called for invalid pids");
});

test("readMosaRuntimeProcessIdentity keeps the unix ps branch working on darwin", async () => {
  const calls = [];
  const fakeExecFile = async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: "Mon Nov 10 09:00:00 2026\n", stderr: "" };
  };
  const identity = await readMosaRuntimeProcessIdentity(777, { platform: "darwin", execFile: fakeExecFile });
  assert.equal(identity, "unix-start:Mon Nov 10 09:00:00 2026");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "ps");
  assert.deepEqual(calls[0].args, ["-p", "777", "-o", "lstart="]);
  assert.equal(calls[0].options.windowsHide, undefined);
  assert.equal(calls[0].options.timeout, 3000);

  assert.equal(await readMosaRuntimeProcessIdentity(777, { platform: "darwin", execFile: async () => ({ stdout: "   \n", stderr: "" }) }), null);
  assert.equal(await readMosaRuntimeProcessIdentity(777, { platform: "darwin", execFile: async () => { throw new Error("ps exploded"); } }), null);
});
