// Task 471 (B.2): unit tests for scripts/ci-rerun-unacquired.mjs using trimmed
// real GitHub Actions API fixtures (run IDs from B.0) plus offline REST/summary
// and workflow-shape assertions.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  classifyRun,
  formatStepSummary,
  runUnacquiredCheck,
} from "../scripts/ci-rerun-unacquired.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const fixtureDir = join(rootDir, "test", "fixtures", "ci-rerun-unacquired");

function loadFixture(file) {
  return JSON.parse(readFileSync(join(fixtureDir, file), "utf8"));
}

test("run 45408531424: 3 unacquired macOS jobs + 1 real Windows e2e failure -> report-only (has-other-failures)", () => {
  const fixture = loadFixture("run-45408531424.json");
  const result = classifyRun(fixture.jobs, fixture.annotationsByJobId);
  assert.deepEqual(result.unacquired, [138495693532, 138495694203, 138495694404]);
  assert.deepEqual(result.others, [138495694227]);
  assert.equal(result.action, "report-only");
  assert.equal(result.reason, "has-other-failures");
});

test("run 45425176035: 2 unacquired macOS jobs + 1 real macOS e2e failure -> report-only (has-other-failures)", () => {
  const fixture = loadFixture("run-45425176035.json");
  const result = classifyRun(fixture.jobs, fixture.annotationsByJobId);
  assert.deepEqual(result.unacquired, [138555080918, 138555080972]);
  assert.deepEqual(result.others, [138555081000]);
  assert.equal(result.action, "report-only");
  assert.equal(result.reason, "has-other-failures");

  // Even if only 1 of the unacquired jobs were present alongside the real
  // failure, the presence of `others` must still block auto-rerun.
  const singleUnacqWithRealFailure = fixture.jobs.filter((j) => j.id !== 138555080972);
  const singleResult = classifyRun(singleUnacqWithRealFailure, fixture.annotationsByJobId);
  assert.deepEqual(singleResult.unacquired, [138555080918]);
  assert.deepEqual(singleResult.others, [138555081000]);
  assert.equal(singleResult.action, "report-only");
  assert.equal(singleResult.reason, "has-other-failures");
});

test("run 45221815959 (nightly): 2 unacquired jobs and 0 others -> report-only (multiple-unacquired; bulk rerun-failed-jobs unverified for cancelled)", () => {
  const fixture = loadFixture("run-45221815959.json");
  const result = classifyRun(fixture.jobs, fixture.annotationsByJobId);
  assert.deepEqual(result.unacquired, [137857790632, 137857790789]);
  assert.deepEqual(result.others, []);
  assert.equal(result.action, "report-only");
  assert.equal(result.reason, "multiple-unacquired");
});

test("run 45198291142: 1 unacquired job and 0 others -> rerun-job (single-unacquired)", () => {
  const fixture = loadFixture("run-45198291142.json");
  const result = classifyRun(fixture.jobs, fixture.annotationsByJobId);
  assert.deepEqual(result.unacquired, [137802439865]);
  assert.deepEqual(result.others, []);
  assert.equal(result.action, "rerun-job");
  assert.equal(result.reason, "single-unacquired");
});

test("run 45419848205: concurrency-superseded cancellation + failures -> nothing (never rerun)", () => {
  const fixture = loadFixture("run-45419848205.json");
  const result = classifyRun(fixture.jobs, fixture.annotationsByJobId);
  assert.deepEqual(result.unacquired, []);
  assert.equal(result.others.length, 5);
  assert.equal(result.action, "nothing");
  assert.equal(result.reason, "only-other-failures");
});

test("run 45440607532: all-green run -> nothing", () => {
  const fixture = loadFixture("run-45440607532.json");
  const result = classifyRun(fixture.jobs, fixture.annotationsByJobId);
  assert.deepEqual(result.unacquired, []);
  assert.deepEqual(result.others, []);
  assert.equal(result.action, "nothing");
  assert.equal(result.reason, "all-succeeded");
});

test("runUnacquiredCheck paginates jobs, fetches annotations only for non-success jobs, and POSTs single-job rerun", async () => {
  const fixture = loadFixture("run-45198291142.json");
  const calls = [];
  const writtenSummaries = [];

  // Simulate a 2-page job list (100 dummy successes on page 1 + fixture on page 2)
  const page1Jobs = Array.from({ length: 100 }, (_, idx) => ({
    id: 9000 + idx,
    name: `ok-${idx}`,
    status: "completed",
    conclusion: "success",
    runner_name: "GitHub Actions 1",
    runner_id: 1,
    steps: [{ name: "step" }],
    labels: ["ubuntu-latest"],
  }));

  const fakeFetch = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({ method: init.method || "GET", path: parsed.pathname + parsed.search });
    if (parsed.pathname.endsWith("/jobs")) {
      const page = Number(parsed.searchParams.get("page") || "1");
      const batch = page === 1 ? page1Jobs : fixture.jobs;
      return new Response(JSON.stringify({ total_count: 100 + fixture.jobs.length, jobs: batch }), { status: 200 });
    }
    const annMatch = parsed.pathname.match(/\/check-runs\/(\d+)\/annotations$/);
    if (annMatch) {
      return new Response(JSON.stringify(fixture.annotationsByJobId[annMatch[1]] || []), { status: 200 });
    }
    if (init.method === "POST" && parsed.pathname.endsWith("/actions/jobs/137802439865/rerun")) {
      return new Response("", { status: 201 });
    }
    return new Response("unexpected request", { status: 500 });
  };

  const result = await runUnacquiredCheck({
    repo: "owner/repo",
    runId: String(fixture.run_id),
    token: "test-token",
    summaryPath: "/tmp/fake-summary.md",
    fetchImpl: fakeFetch,
    writeSummary: (p, content) => writtenSummaries.push({ p, content }),
  });

  assert.equal(result.classification.action, "rerun-job");
  assert.equal(result.rerunTriggered, true);
  assert.deepEqual(
    calls,
    [
      { method: "GET", path: `/repos/owner/repo/actions/runs/${fixture.run_id}/jobs?per_page=100&page=1` },
      { method: "GET", path: `/repos/owner/repo/actions/runs/${fixture.run_id}/jobs?per_page=100&page=2` },
      { method: "GET", path: "/repos/owner/repo/check-runs/137802439865/annotations?per_page=100" },
      { method: "POST", path: "/repos/owner/repo/actions/jobs/137802439865/rerun" },
    ],
  );
  assert.equal(writtenSummaries.length, 1);
  assert.match(writtenSummaries[0].content, /rerun-job/);
  assert.match(writtenSummaries[0].content, /137802439865/);
});

test("report-only summary prints copyable gh run rerun commands and never POSTs", async () => {
  const fixture = loadFixture("run-45221815959.json");
  const methods = [];
  const fakeFetch = async (url, init = {}) => {
    const parsed = new URL(url);
    methods.push(init.method || "GET");
    if (parsed.pathname.endsWith("/jobs")) {
      return new Response(JSON.stringify({ total_count: fixture.jobs.length, jobs: fixture.jobs }), { status: 200 });
    }
    const annMatch = parsed.pathname.match(/\/check-runs\/(\d+)\/annotations$/);
    if (annMatch) {
      return new Response(JSON.stringify(fixture.annotationsByJobId[annMatch[1]] || []), { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  };

  const result = await runUnacquiredCheck({
    repo: "owner/repo",
    runId: String(fixture.run_id),
    token: "test-token",
    fetchImpl: fakeFetch,
  });

  assert.equal(result.classification.action, "report-only");
  assert.equal(result.rerunTriggered, false);
  assert.equal(methods.includes("POST"), false);
  assert.match(result.summary, /gh run rerun 45221815959 --job 137857790632/);
  assert.match(result.summary, /gh run rerun 45221815959 --job 137857790789/);

  // Direct formatStepSummary smoke check
  const formatted = formatStepSummary({
    runId: fixture.run_id,
    jobs: fixture.jobs,
    classification: result.classification,
  });
  assert.match(formatted, /multiple-unacquired/);
});

test("runUnacquiredCheck rejects with the raw HTTP error on GitHub API failure", async () => {
  await assert.rejects(
    () => runUnacquiredCheck({
      repo: "owner/repo",
      runId: "12345",
      token: "test-token",
      fetchImpl: async () => new Response("rate limit exceeded", { status: 403, statusText: "Forbidden" }),
    }),
    /403 Forbidden.*rate limit exceeded/,
  );
});

test("desktop-rerun-unacquired.yml follows workflow_run security and SHA-pinning rules", () => {
  const desktopYml = readFileSync(join(rootDir, ".github", "workflows", "desktop.yml"), "utf8");
  const rerunYml = readFileSync(join(rootDir, ".github", "workflows", "desktop-rerun-unacquired.yml"), "utf8");

  const checkoutSha = desktopYml.match(/actions\/checkout@[0-9a-f]{40}/)?.[0];
  const setupNodeSha = desktopYml.match(/actions\/setup-node@[0-9a-f]{40}/)?.[0];
  assert.ok(checkoutSha && setupNodeSha, "desktop.yml pins checkout and setup-node SHAs");

  assert.match(rerunYml, /workflow_run:/);
  assert.match(rerunYml, /workflows:\s*\["Desktop packaging"\]/);
  assert.match(rerunYml, /types:\s*\[completed\]/);
  assert.match(rerunYml, /github\.event\.workflow_run\.conclusion != 'success' && github\.event\.workflow_run\.run_attempt == 1/);
  assert.match(rerunYml, /actions:\s*write/);
  assert.match(rerunYml, /checks:\s*read/);
  assert.match(rerunYml, /contents:\s*read/);
  assert.match(rerunYml, /runs-on:\s*ubuntu-latest/);
  assert.match(rerunYml, /timeout-minutes:\s*5/);
  assert.ok(rerunYml.includes(checkoutSha), "checkout must use the same pinned SHA as desktop.yml");
  assert.ok(rerunYml.includes(setupNodeSha), "setup-node must use the same pinned SHA as desktop.yml");
  assert.match(rerunYml, /persist-credentials:\s*false/);
  const nonCommentYml = rerunYml
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.equal(/\bnpm ci\b/.test(nonCommentYml), false, "must not run npm ci");
  assert.equal(/workflow_run\.head_sha|workflow_run\.head_branch|ref:\s*\$\{\{/.test(nonCommentYml), false, "must never check out PR head code");
});
