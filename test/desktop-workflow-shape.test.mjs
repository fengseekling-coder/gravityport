// Task 471 (B.1): pin the desktop.yml job shape so Apple-silicon (macos-15)
// jobs stay collapsed from 3 down to 2 (one matrix job with two shards), every
// job carries an explicit timeout-minutes, the folded macOS packaging steps
// stay gated to shard 2/2, and the removed desktop-macos-package job does not
// creep back. Reads the real workflow file; slices jobs the same way as
// test/e2e-system-clipboard.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const desktopWorkflowPath = join(rootDir, ".github", "workflows", "desktop.yml");

function parseDesktopJobs() {
  const lines = readFileSync(desktopWorkflowPath, "utf8").split("\n");
  const jobsStart = lines.findIndex((line) => line === "jobs:");
  assert.ok(jobsStart !== -1, "desktop.yml defines a top-level jobs: block");

  const jobs = new Map();
  let currentName = null;
  let currentStart = -1;
  for (let i = jobsStart + 1; i < lines.length; i += 1) {
    const match = lines[i].match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (match) {
      if (currentName !== null) {
        jobs.set(currentName, lines.slice(currentStart, i).join("\n"));
      }
      currentName = match[1];
      currentStart = i;
    }
  }
  if (currentName !== null) {
    jobs.set(currentName, lines.slice(currentStart).join("\n"));
  }
  return jobs;
}

function sliceSteps(jobText) {
  const lines = jobText.split("\n");
  const stepsStart = lines.findIndex((line) => /^    steps:\s*$/.test(line));
  assert.ok(stepsStart !== -1, "job defines steps:");
  const steps = [];
  let current = null;
  for (let i = stepsStart + 1; i < lines.length; i += 1) {
    if (/^      - /.test(lines[i])) {
      if (current) steps.push(current.join("\n"));
      current = [lines[i]];
    } else if (current) {
      current.push(lines[i]);
    }
  }
  if (current) steps.push(current.join("\n"));
  return steps;
}

test("desktop.yml has exactly one runs-on: macos-15 job (matrix of two shards) and no desktop-macos-package job", () => {
  const jobs = parseDesktopJobs();
  assert.equal(jobs.has("desktop-macos-package"), false, "desktop-macos-package must be removed (folded into desktop-macos-e2e)");

  const arm64Jobs = [...jobs.entries()].filter(([, text]) => /^\s+runs-on:\s*macos-15\s*$/m.test(text));
  assert.equal(
    arm64Jobs.length,
    1,
    `expected exactly 1 runs-on: macos-15 job, got ${arm64Jobs.map(([name]) => name).join(", ")}`,
  );
  const [jobName, jobText] = arm64Jobs[0];
  assert.equal(jobName, "desktop-macos-e2e");

  const shardMatches = [...jobText.matchAll(/shard:\s*["'](\d+\/2)["']/g)].map((m) => m[1]);
  assert.deepEqual(shardMatches, ["1/2", "2/2"], "desktop-macos-e2e matrix must define exactly shards 1/2 and 2/2");
});

test("every job in desktop.yml declares timeout-minutes (and macOS shards keep 25 / 30)", () => {
  const jobs = parseDesktopJobs();
  assert.ok(jobs.size >= 4, "desktop.yml should define the 4 platform jobs");
  for (const [jobName, jobText] of jobs.entries()) {
    assert.match(
      jobText,
      /^    timeout-minutes:\s*(?:\d+|\$\{\{\s*matrix\.timeout_minutes\s*\}\})\s*$/m,
      `job ${jobName} must declare timeout-minutes`,
    );
  }
  const macosJob = jobs.get("desktop-macos-e2e");
  const timeouts = [...macosJob.matchAll(/timeout_minutes:\s*(\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(timeouts, [25, 30], "macOS e2e shards must use 25 min for shard 1/2 and 30 min for shard 2/2");
});

test("all folded macOS packaging steps in desktop-macos-e2e are gated to shard 2/2 and keep package-macos artifact", () => {
  const jobs = parseDesktopJobs();
  const steps = sliceSteps(jobs.get("desktop-macos-e2e"));

  const expectedPackSteps = [
    "Run macOS packaging contract tests",
    "Package the macOS app",
    "Verify macOS app code signature",
    "Packaged smoke",
    "Cross-package the Intel app (no launch)",
    "Upload packaging failure artifacts",
  ];

  for (const stepName of expectedPackSteps) {
    const step = steps.find((s) => s.includes(`- name: ${stepName}`));
    assert.ok(step, `desktop-macos-e2e must include folded step "${stepName}"`);
    assert.match(
      step,
      /^\s+if:\s*\$\{\{[^}]*matrix\.shard\s*==\s*'2\/2'[^}]*\}\}\s*$/m,
      `step "${stepName}" must be gated to matrix.shard == '2/2'`,
    );
    if (stepName !== "Upload packaging failure artifacts") {
      assert.match(
        step,
        /^\s+if:\s*\$\{\{\s*!cancelled\(\)\s*&&\s*matrix\.shard\s*==\s*'2\/2'\s*\}\}\s*$/m,
        `step "${stepName}" must run even if e2e fails (!cancelled() && matrix.shard == '2/2')`,
      );
    } else {
      assert.match(step, /^\s+name:\s*package-macos\s*$/m, "packaging failure artifact name must remain package-macos");
    }
  }
});
