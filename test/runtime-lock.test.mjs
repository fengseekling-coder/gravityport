import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { acquireMosaRuntimeLock } from "../lib/runtime-lock.js";

test("permits only one MOSA bridge runtime for a library", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-runtime-lock-"));
  const libraryDir = join(root, "library");
  deferTestPathRemoval(root, { recursive: true, force: true });

  const first = await acquireMosaRuntimeLock({ libraryDir });
  await assert.rejects(
    acquireMosaRuntimeLock({ libraryDir }),
    /GravityPort runtime already active for this library/,
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
