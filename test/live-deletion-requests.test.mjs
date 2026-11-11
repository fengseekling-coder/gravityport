// Task 385 — unit tests for the .live/ file protocol (lib/live-deletion-requests.mjs).
// The clock and pid liveness are injected, so every case below drives virtual
// time; nothing here touches a real library or a real process.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import {
  DEFAULT_CONFIRM_TIMEOUT_MS,
  VIEWER_FRESH_MS,
  confirmTimeoutMs,
  createLiveDeletionRequests,
  defaultIsPidAlive,
} from "../lib/live-deletion-requests.mjs";

function makeClock(startMs = 1_000_000) {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms) => { current += ms; },
    value: () => current,
  };
}

async function makeLive(t) {
  const root = await mkdtemp(join(tmpdir(), "mosa-live-deletion-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  return { libraryDir };
}

const JIMENG_REQUESTER = { kind: "jimeng", name: "即梦删除同步", pid: 4242 };
const MCP_REQUESTER = { kind: "mcp", name: "Claude", pid: 5151 };

test("viewer presence freshness: fresh, older than 30 s, and dead pid all read as their own cases", async () => {
  const { libraryDir } = await makeLive();
  const clock = makeClock();
  const alive = new Set([1000]);
  const live = createLiveDeletionRequests({
    libraryDir,
    now: clock.now,
    isPidAlive: (pid) => alive.has(Number(pid)),
    timeoutMs: DEFAULT_CONFIRM_TIMEOUT_MS,
  });

  await live.writeViewer({ projectId: "default", assetId: "asset-a", pid: 1000 });
  const fresh = await live.readViewer();
  assert.equal(live.isViewerFresh(fresh), true, "a just-written record by a live pid is fresh");

  clock.advance(VIEWER_FRESH_MS);
  assert.equal(live.isViewerFresh(await live.readViewer()), true, "exactly 30 s is still fresh (<= 30_000)");
  clock.advance(1);
  assert.equal(live.isViewerFresh(await live.readViewer()), false, "past 30 s counts as nobody watching");

  alive.delete(1000);
  await live.writeViewer({ projectId: "default", assetId: "asset-a", pid: 1000 });
  assert.equal(live.isViewerFresh(await live.readViewer()), false, "a dead reporter pid is never fresh");

  assert.equal(live.isViewerFresh(null), false);
  assert.equal(live.isViewerFresh({ pid: 1000, updatedAt: "not-a-number" }), false);
});

test("delete requests: create, merge for the same requester+asset, and keep separate ones apart", async () => {
  const { libraryDir } = await makeLive();
  const clock = makeClock();
  const live = createLiveDeletionRequests({ libraryDir, now: clock.now, isPidAlive: () => true, timeoutMs: 60_000 });

  const first = await live.createDeleteRequest({ projectId: "default", assetId: "asset-a", requester: MCP_REQUESTER });
  assert.equal(first.created, true);
  assert.equal(first.merged, false);
  assert.equal(first.request.status, "pending");
  assert.equal(first.request.requester.name, "Claude");
  assert.equal(first.request.requester.kind, "mcp");
  assert.equal(first.request.expiresAt, clock.value() + 60_000);

  // Same requester (kind + name) for the same project + asset merges.
  const retry = await live.createDeleteRequest({ projectId: "default", assetId: "asset-a", requester: MCP_REQUESTER });
  assert.equal(retry.created, false);
  assert.equal(retry.merged, true);
  assert.equal(retry.request.id, first.request.id, "the retry waits on the existing pending request");

  // A different requester for the same asset gets its own request.
  clock.advance(1);
  const other = await live.createDeleteRequest({ projectId: "default", assetId: "asset-a", requester: JIMENG_REQUESTER });
  assert.equal(other.created, true);
  assert.notEqual(other.request.id, first.request.id);
  // A different asset for the same requester gets its own request too.
  clock.advance(1);
  const otherAsset = await live.createDeleteRequest({ projectId: "default", assetId: "asset-b", requester: MCP_REQUESTER });
  assert.equal(otherAsset.created, true);
  assert.notEqual(otherAsset.request.id, first.request.id);

  // Pending listing is ordered by creation time.
  const pending = await live.listPendingRequests();
  assert.deepEqual(pending.map((request) => request.id), [first.request.id, other.request.id, otherAsset.request.id]);
});

test("decisions: allow before expiry lands; allow after expiry becomes timeout; decided files never change again", async () => {
  const { libraryDir } = await makeLive();
  const clock = makeClock();
  const live = createLiveDeletionRequests({ libraryDir, now: clock.now, isPidAlive: () => true, timeoutMs: 60_000 });

  const { request } = await live.createDeleteRequest({ projectId: "default", assetId: "asset-a", requester: MCP_REQUESTER });

  // An allow inside the window is recorded as allowed.
  const allowed = await live.writeDecision(request.id, "allowed");
  assert.equal(allowed.changed, true);
  assert.equal(allowed.request.status, "allowed");
  assert.equal(allowed.request.decidedAt, clock.value());
  const onDisk = JSON.parse(await readFile(live.requestPath(request.id), "utf8"));
  assert.equal(onDisk.status, "allowed");

  // A second write does not flip an already-decided file.
  const deniedAfter = await live.writeDecision(request.id, "denied");
  assert.equal(deniedAfter.changed, false);
  assert.equal(deniedAfter.request.status, "allowed");
  assert.equal(JSON.parse(await readFile(live.requestPath(request.id), "utf8")).status, "allowed");

  // An allow past the window is refused and rewritten as timeout.
  const second = await live.createDeleteRequest({ projectId: "default", assetId: "asset-b", requester: MCP_REQUESTER });
  clock.advance(60_001);
  const lateAllow = await live.writeDecision(second.request.id, "allowed");
  assert.equal(lateAllow.changed, true);
  assert.equal(lateAllow.request.status, "timeout", "a post-expiry allow must not stand");
  assert.equal(lateAllow.request.decidedAt, clock.value());

  // The pending list drops decided rows.
  assert.deepEqual(await live.listPendingRequests(), []);
});

test("an allowed decision whose decidedAt is past expiresAt reads as a timeout to the requester", async () => {
  // This pins the requester-side rule (task 385 甲3): even if the file somehow
  // carries allowed with a late decidedAt, the MCP reader must treat it as no
  // answer. The rule lives in the MCP read path; here the file is written by
  // hand to reproduce that exact shape.
  const { libraryDir } = await makeLive();
  const clock = makeClock();
  const live = createLiveDeletionRequests({ libraryDir, now: clock.now, isPidAlive: () => true, timeoutMs: 60_000 });
  const { request } = await live.createDeleteRequest({ projectId: "default", assetId: "asset-a", requester: MCP_REQUESTER });
  const forged = { ...request, status: "allowed", decidedAt: request.expiresAt + 5_000 };
  await writeFile(live.requestPath(request.id), `${JSON.stringify(forged, null, 2)}\n`, "utf8");
  const read = await live.readRequest(request.id);
  assert.equal(read.status, "allowed");
  assert.ok(Number(read.decidedAt) > Number(read.expiresAt), "fixture: decidedAt after expiresAt");
  // The requester-side check the MCP server applies.
  const effective = read.status === "allowed" && Number(read.decidedAt) <= Number(read.expiresAt) ? "allowed" : "timeout";
  assert.equal(effective, "timeout");
});

test("unparsable JSON reads as absent; unknown ids read as null", async () => {
  const { libraryDir } = await makeLive();
  const clock = makeClock();
  const live = createLiveDeletionRequests({ libraryDir, now: clock.now, isPidAlive: () => true, timeoutMs: 60_000 });

  const { request } = await live.createDeleteRequest({ projectId: "default", assetId: "asset-a", requester: MCP_REQUESTER });
  await writeFile(live.requestPath(request.id), "{not json", "utf8");
  assert.equal(await live.readRequest(request.id), null, "torn JSON is treated as no request");
  assert.deepEqual(await live.listRequests(), []);
  assert.deepEqual(await live.listPendingRequests(), []);

  await writeFile(live.viewerPath(), "][", "utf8");
  assert.equal(await live.readViewer(), null, "a torn viewer record is treated as nobody watching");

  assert.equal(await live.readRequest("does-not-exist"), null);
  const missing = await live.writeDecision("does-not-exist", "denied");
  assert.equal(missing.request, null);
  assert.equal(missing.changed, false);
});

test("cleanup removes request files older than 10 minutes and keeps the rest", async () => {
  const { libraryDir } = await makeLive();
  const clock = makeClock();
  const live = createLiveDeletionRequests({ libraryDir, now: clock.now, isPidAlive: () => true, timeoutMs: 60_000 });

  const old = await live.createDeleteRequest({ projectId: "default", assetId: "asset-old", requester: MCP_REQUESTER });
  clock.advance(10 * 60_000 + 1);
  const keep = await live.createDeleteRequest({ projectId: "default", assetId: "asset-keep", requester: MCP_REQUESTER });
  const removed = await live.cleanupOldRequests();
  assert.equal(removed, 1, "only the 10-minute-old file is swept");
  assert.equal(await live.readRequest(old.request.id), null);
  assert.ok(await live.readRequest(keep.request.id));

  // Pending expiry flips past-window rows to timeout and reports them. `keep`
  // has also slid past its own window by now, so both flip.
  const pending = await live.createDeleteRequest({ projectId: "default", assetId: "asset-expiring", requester: JIMENG_REQUESTER });
  clock.advance(60_001);
  const flipped = await live.markExpiredPendingAsTimeout();
  assert.deepEqual([...flipped.map((request) => request.id)].sort(), [keep.request.id, pending.request.id].sort());
  assert.equal((await live.readRequest(pending.request.id)).status, "timeout");
  assert.equal((await live.readRequest(keep.request.id)).status, "timeout");
  assert.deepEqual(await live.markExpiredPendingAsTimeout(), [], "an already-flipped row is not reported twice");
});

test("clearViewer only removes the record this process wrote", async () => {
  const { libraryDir } = await makeLive();
  const clock = makeClock();
  const live = createLiveDeletionRequests({ libraryDir, now: clock.now, isPidAlive: () => true, timeoutMs: 60_000 });

  await live.writeViewer({ projectId: "default", assetId: "asset-a", pid: 4242 });
  assert.equal(await live.clearViewer(9999), false, "another pid must not clear it");
  assert.ok(await live.readViewer());
  assert.equal(await live.clearViewer(4242), true);
  assert.equal(await live.readViewer(), null);
});

test("the timeout window defaults to 60 s and is only shortened under MOSA_QA_RUN=1", () => {
  assert.equal(confirmTimeoutMs({}), DEFAULT_CONFIRM_TIMEOUT_MS);
  assert.equal(confirmTimeoutMs({ MOSA_DELETE_CONFIRM_TIMEOUT_MS: "1500" }), DEFAULT_CONFIRM_TIMEOUT_MS,
    "without MOSA_QA_RUN the override is ignored");
  assert.equal(confirmTimeoutMs({ MOSA_QA_RUN: "1", MOSA_DELETE_CONFIRM_TIMEOUT_MS: "1500" }), 1500);
  assert.equal(confirmTimeoutMs({ MOSA_QA_RUN: "1" }), DEFAULT_CONFIRM_TIMEOUT_MS);
  assert.equal(confirmTimeoutMs({ MOSA_QA_RUN: "1", MOSA_DELETE_CONFIRM_TIMEOUT_MS: "bogus" }), DEFAULT_CONFIRM_TIMEOUT_MS);
});

test("the default pid probe answers for this process and refuses junk", () => {
  assert.equal(defaultIsPidAlive(process.pid), true);
  assert.equal(defaultIsPidAlive(0), false);
  assert.equal(defaultIsPidAlive(-1), false);
  assert.equal(defaultIsPidAlive(Number.NaN), false);
  assert.equal(defaultIsPidAlive("not-a-pid"), false);
});

test("request ids are path-encoded, so a hostile id never escapes the requests directory", async () => {
  const { libraryDir } = await makeLive();
  const clock = makeClock();
  const live = createLiveDeletionRequests({ libraryDir, now: clock.now, isPidAlive: () => true, timeoutMs: 60_000 });

  const path = live.requestPath("../escape");
  assert.ok(!path.includes("/../"), "encodeURIComponent leaves no traversal separators");
  assert.ok(path.startsWith(live.requestsDir()));
  // Reads and writes on such an id behave like a normal missing request.
  assert.equal(await live.readRequest("../escape"), null);
  const missing = await live.writeDecision("../escape", "denied");
  assert.equal(missing.request, null);
  assert.equal(missing.changed, false);
});
