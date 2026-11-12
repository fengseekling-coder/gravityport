// Task 385 follow-up: the viewer-presence report changes no asset, so it must
// not count as a user mutation. Counting it made the live sync defer the
// viewer-close release (the null report raced it) and discard merges on every
// 10 s heartbeat; on Windows CI the unfavorited card then stayed in 收藏 after
// the viewer closed (e2e live-sync-viewer). A real decision still counts.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");

let api;
let tempRoot;
let releaseResponse = null;
const originalFetch = globalThis.fetch;

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "mosa-viewer-presence-"));
  const outDir = join(tempRoot, "out");
  await mkdir(outDir, { recursive: true });
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    join(uiRoot, "src", "mosa-api.ts"),
    "--outDir", outDir,
    "--rootDir", join(uiRoot, "src"),
    "--module", "commonjs",
    "--moduleResolution", "node",
    "--target", "es2022",
    "--esModuleInterop",
    "--skipLibCheck",
  ], { stdio: "pipe" });
  // Every request stays in flight until the test releases it, so the
  // mutation counter can be read while the request is pending.
  globalThis.fetch = () => new Promise((resolveFetch) => {
    releaseResponse = () => resolveFetch(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  });
  api = await import(join(outDir, "mosa-api.js"));
});

after(async () => {
  globalThis.fetch = originalFetch;
  await rm(tempRoot, { recursive: true, force: true });
});

async function inFlight(call) {
  releaseResponse = null;
  const before = api.readMutationState();
  const pending = call();
  for (let tick = 0; tick < 50 && !releaseResponse; tick += 1) await new Promise((r) => setTimeout(r, 1));
  assert.ok(releaseResponse, "the request reached fetch");
  const during = api.readMutationState();
  releaseResponse();
  await pending;
  return { before, during, after: api.readMutationState() };
}

test("viewer presence reports (open and close) are not counted as mutations", async () => {
  for (const assetId of ["asset-1", null]) {
    const { before, during, after: settled } = await inFlight(() => api.reportViewerPresence("default", assetId));
    assert.equal(during.pending, before.pending, `presence ${assetId} must not raise pending`);
    assert.equal(during.epoch, before.epoch, `presence ${assetId} must not bump the epoch`);
    assert.deepEqual(settled, before);
  }
});

test("a live deletion decision still counts as a mutation", async () => {
  const { before, during, after: settled } = await inFlight(() => api.decideLiveDeletionRequest("req-1", "deny"));
  assert.equal(during.pending, before.pending + 1);
  assert.ok(settled.epoch > before.epoch);
  assert.equal(settled.pending, before.pending);
});
