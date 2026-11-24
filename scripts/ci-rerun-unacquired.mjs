#!/usr/bin/env node
// Task 471 (B.2): classify a completed Desktop packaging workflow run and
// automatically rerun a single unacquired-runner job once (never rerunning
// when any real failure or concurrency-cancel exists).
//
// Because docs.github.com does not specify whether POST /rerun-failed-jobs
// includes `cancelled` jobs (unacquired runners end with conclusion=cancelled),
// automatic rerun is restricted to a single unacquired job via
// POST /repos/{repo}/actions/jobs/{job_id}/rerun; when more than one job was
// unacquired, the script downgrades to report-only and prints ready-to-copy
// `gh run rerun <run_id> --job <job_id>` commands in GITHUB_STEP_SUMMARY.
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const NOT_ACQUIRED_NEEDLE = "was not acquired by Runner";
const GITHUB_API_BASE = "https://api.github.com";

function stepsCountOf(job) {
  if (Array.isArray(job?.steps)) return job.steps.length;
  if (typeof job?.steps_count === "number" && Number.isFinite(job.steps_count)) {
    return job.steps_count;
  }
  return 0;
}

export function isUnacquiredJob(job, annotations = []) {
  if (!job || (job.conclusion !== "cancelled" && job.conclusion !== "failure")) {
    return false;
  }
  const hasRunner = Boolean(job.runner_name) && Number(job.runner_id) > 0;
  if (hasRunner) return false;
  if (stepsCountOf(job) !== 0) return false;
  const list = Array.isArray(annotations) ? annotations : [];
  return list.some(
    (entry) => typeof entry?.message === "string" && entry.message.includes(NOT_ACQUIRED_NEEDLE),
  );
}

/**
 * Pure classifier for a completed workflow run.
 *
 * Returns `{ unacquired, others, action, reason }` where:
 * - `action: "rerun-job"`    — exactly 1 unacquired job and 0 other non-success jobs
 * - `action: "report-only"`  — unacquired jobs exist, but either other non-success
 *                              jobs also exist or >1 jobs were unacquired (bulk
 *                              rerun-failed-jobs behaviour on `cancelled` jobs is
 *                              unverified in docs.github.com)
 * - `action: "nothing"`      — no unacquired jobs
 */
export function classifyRun(jobs, annotationsByJobId = {}) {
  const unacquired = [];
  const others = [];

  for (const job of jobs || []) {
    if (job.conclusion === "success" || job.conclusion === "skipped") continue;
    const annotations = annotationsByJobId[job.id] ?? annotationsByJobId[String(job.id)] ?? [];
    if (isUnacquiredJob(job, annotations)) {
      unacquired.push(job.id);
    } else {
      others.push(job.id);
    }
  }

  if (unacquired.length === 0) {
    return {
      unacquired,
      others,
      action: "nothing",
      reason: others.length > 0 ? "only-other-failures" : "all-succeeded",
    };
  }
  if (others.length > 0) {
    return {
      unacquired,
      others,
      action: "report-only",
      reason: "has-other-failures",
    };
  }
  if (unacquired.length === 1) {
    return {
      unacquired,
      others,
      action: "rerun-job",
      reason: "single-unacquired",
    };
  }
  return {
    unacquired,
    others,
    action: "report-only",
    reason: "multiple-unacquired",
  };
}

export function formatStepSummary({ runId, jobs, classification, rerunTriggered = false }) {
  const byId = new Map((jobs || []).map((j) => [j.id, j]));
  const describe = (jobId) => {
    const j = byId.get(jobId);
    return j ? `\`${jobId}\` (${j.name} — ${j.conclusion ?? j.status})` : `\`${jobId}\``;
  };

  const lines = [
    `## Unacquired Runner Check (run \`${runId}\`)`,
    "",
    `- **Action**: \`${classification.action}\` (${classification.reason})`,
    `- **Unacquired jobs (${classification.unacquired.length})**: ${
      classification.unacquired.length > 0
        ? classification.unacquired.map(describe).join(", ")
        : "none"
    }`,
    `- **Other non-success jobs (${classification.others.length})**: ${
      classification.others.length > 0
        ? classification.others.map(describe).join(", ")
        : "none"
    }`,
  ];

  if (classification.action === "rerun-job" && rerunTriggered) {
    lines.push(
      "",
      `Triggered single-job rerun via \`POST /actions/jobs/${classification.unacquired[0]}/rerun\`.`,
    );
  } else if (classification.action === "report-only") {
    lines.push("", "Manual rerun commands for unacquired jobs:", "```bash");
    for (const jobId of classification.unacquired) {
      lines.push(`gh run rerun ${runId} --job ${jobId}`);
    }
    lines.push("```");
  }

  return `${lines.join("\n")}\n`;
}

async function githubRequest({ fetchImpl, token, method = "GET", path, apiBase = GITHUB_API_BASE }) {
  const url = `${apiBase}${path}`;
  const response = await fetchImpl(url, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gravityport-ci-rerun-unacquired",
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub API ${method} ${path} failed (${response.status} ${response.statusText}): ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

export async function listAllRunJobs({ fetchImpl, token, repo, runId, apiBase = GITHUB_API_BASE }) {
  const jobs = [];
  for (let page = 1; page <= 20; page += 1) {
    const data = await githubRequest({
      fetchImpl,
      token,
      method: "GET",
      path: `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`,
      apiBase,
    });
    const batch = Array.isArray(data?.jobs) ? data.jobs : [];
    jobs.push(...batch);
    const total = Number(data?.total_count ?? 0);
    if (batch.length < 100 || (total > 0 && jobs.length >= total)) break;
  }
  return jobs;
}

export async function runUnacquiredCheck({
  repo,
  runId,
  token,
  summaryPath = "",
  fetchImpl = globalThis.fetch,
  apiBase = GITHUB_API_BASE,
  writeSummary = (filePath, content) => appendFileSync(filePath, content, "utf8"),
}) {
  if (!repo || !runId || !token) {
    throw new Error("Missing required configuration: repo, runId, and token are all required.");
  }
  const jobs = await listAllRunJobs({ fetchImpl, token, repo, runId, apiBase });
  const annotationsByJobId = {};

  for (const job of jobs) {
    if (job.conclusion === "success" || job.conclusion === "skipped") continue;
    annotationsByJobId[job.id] = await githubRequest({
      fetchImpl,
      token,
      method: "GET",
      path: `/repos/${repo}/check-runs/${job.id}/annotations?per_page=100`,
      apiBase,
    });
  }

  const classification = classifyRun(jobs, annotationsByJobId);
  let rerunTriggered = false;

  if (classification.action === "rerun-job") {
    const targetJobId = classification.unacquired[0];
    await githubRequest({
      fetchImpl,
      token,
      method: "POST",
      path: `/repos/${repo}/actions/jobs/${targetJobId}/rerun`,
      apiBase,
    });
    rerunTriggered = true;
  }

  const summary = formatStepSummary({ runId, jobs, classification, rerunTriggered });
  if (summaryPath) {
    writeSummary(summaryPath, summary);
  }
  return { jobs, annotationsByJobId, classification, rerunTriggered, summary };
}

function parseCliArgs(argv) {
  let repo = process.env.GITHUB_REPOSITORY || "";
  let runId = process.env.WORKFLOW_RUN_ID || "";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--repo" && argv[i + 1]) {
      repo = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--run-id" && argv[i + 1]) {
      runId = argv[i + 1];
      i += 1;
    }
  }
  return {
    repo,
    runId,
    token: process.env.GITHUB_TOKEN || "",
    summaryPath: process.env.GITHUB_STEP_SUMMARY || "",
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = parseCliArgs(process.argv.slice(2));
  try {
    const result = await runUnacquiredCheck(args);
    process.stdout.write(result.summary);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
