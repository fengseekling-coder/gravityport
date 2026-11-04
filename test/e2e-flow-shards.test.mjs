// Task 352: `--shard k/n` splits the e2e flow set by name so CI can run two
// parallel jobs per platform. The union of the shards must be exactly the
// unsharded set — no flow lost, none duplicated. This drives the runner's
// `--list` mode (which prints the selected flow names and exits before any
// setup) instead of running any flow.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const rootDir = fileURLToPath(new URL("..", import.meta.url));
const runner = join(rootDir, "scripts", "e2e-critical-flows.mjs");
// A worktree borrows node_modules through a symlink; the runner's Electron
// path guard only matches when module resolution keeps that symlink path
// (task 342). Normal checkouts and CI have real node_modules and no flag.
const nodeArgs = lstatSync(join(rootDir, "node_modules")).isSymbolicLink() ? ["--preserve-symlinks"] : [];

async function listFlows(extraArgs = []) {
  const { stdout } = await execFileAsync(process.execPath, [...nodeArgs, runner, "--list", ...extraArgs], {
    cwd: rootDir,
    encoding: "utf8",
    // The selection must not depend on a developer's shell exporting
    // MOSA_E2E_ONLY, and nothing here needs a QA runtime.
    env: { ...process.env, MOSA_E2E_ONLY: "", TMPDIR: tmpdir() },
  });
  return stdout.trim().split("\n").filter(Boolean);
}

test("e2e shard 1/2 + 2/2 partition the flow set exactly", async () => {
  const full = await listFlows();
  const shard1 = await listFlows(["--shard", "1/2"]);
  const shard2 = await listFlows(["--shard", "2/2"]);
  assert.ok(full.length > 0, "the runner lists flows");
  assert.ok(shard1.length > 0 && shard2.length > 0, "both shards are non-empty");
  assert.equal(shard1.length + shard2.length, full.length,
    `shard sizes (${shard1.length} + ${shard2.length}) must add up to the full set (${full.length})`);
  const union = new Set([...shard1, ...shard2]);
  assert.equal(union.size, full.length, "shards must not overlap");
  for (const name of full) {
    assert.ok(union.has(name), `flow ${name} is missing from every shard`);
  }
  for (const [shardName, flows] of [["1/2", shard1], ["2/2", shard2]]) {
    for (const name of flows) {
      assert.ok(full.includes(name), `shard ${shardName} lists unknown flow ${name}`);
    }
  }
});

test("e2e shard arguments are validated", async () => {
  await assert.rejects(() => listFlows(["--shard", "3/2"]), /1 <= k <= n/);
  await assert.rejects(() => listFlows(["--shard", "0/2"]), /1 <= k <= n/);
  await assert.rejects(() => listFlows(["--shard", "1"]), /--shard expects/);
  await assert.rejects(() => listFlows(["--bogus"]), /unknown argument/);
});
