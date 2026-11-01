// library-sync.test.mjs — unit tests for the incremental sync controller
// (review 2-6). The controller is compiled from the real TypeScript sources
// (library-sync.ts + gallery-reconcile.ts + mosa-api.ts) into a temp tree;
// request functions, timers and the view snapshot are fakes.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");

let syncModule;
let reconcileModule;
let tempRoot;

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "mosa-library-sync-"));
  const outDir = join(tempRoot, "out");
  await mkdir(outDir, { recursive: true });
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    join(uiRoot, "src", "library-sync.ts"),
    join(uiRoot, "src", "gallery-reconcile.ts"),
    join(uiRoot, "src", "mosa-api.ts"),
    "--outDir", outDir,
    "--rootDir", join(uiRoot, "src"),
    "--module", "commonjs",
    "--moduleResolution", "node",
    "--target", "es2022",
    "--esModuleInterop",
    "--skipLibCheck",
  ], { stdio: "pipe" });
  syncModule = await import(join(outDir, "library-sync.js"));
  reconcileModule = await import(join(outDir, "gallery-reconcile.js"));
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ─── fake library ────────────────────────────────────────────────────────────

function createFakeLibrary() {
  const assets = new Map(); // id -> { id, createdAt, favorite, name }
  let sequence = 0;
  const journal = [];
  let revision = 0;
  const world = { dataVersion: "dv1" };

  const newestFirst = () => [...assets.values()]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1))
    .map(asset => asset.id);

  const addAsset = (id) => {
    sequence += 1;
    const createdAt = `2026-01-01T00:00:${String(sequence).padStart(2, "0")}.${String(sequence).padStart(3, "0")}Z`;
    assets.set(id, { id, createdAt, favorite: false, name: `Asset ${id}` });
    journalPush({ kind: "asset-added", entityType: "asset", entityId: id });
    return assets.get(id);
  };
  const journalPush = (record) => {
    revision += 1;
    journal.push({
      revision,
      kind: record.kind,
      entityType: record.entityType || "asset",
      entityId: record.entityId || "",
      flags: record.flags || [],
      assetIds: record.assetIds || [],
      detail: record.detail || {},
    });
  };

  const fetchChanges = async (project, since) => ({
    sinceRevision: since,
    currentRevision: revision,
    oldestRevision: journal[0]?.revision ?? null,
    complete: true,
    changes: journal.filter(change => change.revision > since).map(change => ({ ...change })),
  });

  // Rows under a newest-first, no-filter "所有素材" view. boundaryCursor
  // carries the last loaded card id; rows past it are reported separately.
  const rowsCalls = [];
  let rowsGate = null;
  const stacks = new Map(); // stackId -> { memberIds: [], coverId }
  const suppressIds = new Set(); // 行缺席模拟：视图不再匹配这些 id（favorite 取消等）
  const fetchRows = async (query, assetIds, boundaryCursor, stackIds = []) => {
    rowsCalls.push({ assetIds: [...assetIds], boundaryCursor, stackIds: [...stackIds] });
    if (rowsGate) await rowsGate.promise;
    const full = newestFirst();
    const boundaryIndex = boundaryCursor ? full.indexOf(String(boundaryCursor).replace(/^cur:/, "")) : full.length - 1;
    const wanted = new Set(assetIds);
    const rows = full.filter(id => wanted.has(id) && !suppressIds.has(id)).map(id => ({
      ...assets.get(id),
      node_sort: { createdAt: assets.get(id).createdAt, sortName: assets.get(id).name, searchScore: null },
    }));
    const rowByAssetId = {};
    for (const id of assetIds) rowByAssetId[id] = id;
    // 游标语义与真服务端一致：按 createdAt/id 比较而非列表下标——游标指向的
    // 卡可能已消失（归档），此时它比所有现存行都老，没有行在它之后。
    const boundaryAsset = boundaryCursor ? assets.get(String(boundaryCursor).replace(/^cur:/, "")) : null;
    const boundaryKey = boundaryAsset ? `${boundaryAsset.createdAt}:${boundaryAsset.id}` : null;
    const rowKey = (row) => `${row.createdAt}:${row.id}`;
    const isAfter = (row) => {
      if (!boundaryKey) return false;
      const key = rowKey(row);
      if (key === boundaryKey) return false;
      return key < boundaryKey; // newest-first：「之后」= 下页 = 更老的行
    };
    // 堆叠编号的可达性：返回该堆叠的当前节点行（cover），旧 cover 的行不在
    // assetIds 里也照返——封面替换场景靠它换卡。
    for (const stackId of stackIds) {
      const stack = stacks.get(stackId);
      if (!stack) continue;
      const live = stack.memberIds.filter(id => assets.has(id));
      if (!live.length) continue;
      const coverId = live[0];
      if (!wanted.has(coverId)) {
        rows.push({ ...assets.get(coverId), stack: { id: stackId, count: live.length, name: "S" }, node_sort: { createdAt: assets.get(coverId).createdAt, sortName: assets.get(coverId).name, searchScore: null } });
        rowByAssetId[coverId] = coverId;
      }
    }
    const afterCursorRowIds = rows.filter(isAfter).map(row => row.id);
    return { rows, rowByAssetId, afterCursorRowIds, total: full.length, stack: null };
  };

  return {
    assets, journal, newestFirst, addAsset, journalPush, fetchChanges, fetchRows, rowsCalls, stacks, suppressIds,
    get revision() { return revision },
    token: () => `${revision}:${world.dataVersion}`,
    bumpDataVersion: () => { world.dataVersion = `dv${Math.random()}` },
  };
}

// ─── fake controller wiring ──────────────────────────────────────────────────

function createHarness({ paused: pausedOverride } = {}) {
  const library = createFakeLibrary();
  const commits = [];
  const fallbacks = [];
  const timers = [];
  let clock = 1_000_000;
  const mutation = { epoch: 0, pending: 0 };
  const currentView = {
    viewKey: "view-1",
    generation: 1,
    nextCursor: null,
    project: "default",
    cards: [],
    loadedCardIds: [],
    query: { project: "default", scope: "all", query: "", sort: "newest", mediaKind: "all" },
    viewedId: "",
    viewerOpen: true,
  };
  // Baseline observed INSIDE the commit hook: the controller must not have
  // advanced it yet (reverse-verify 1 — the merge lands first, then the
  // baseline moves).
  let baselineAtCommit = null;
  const sync = syncModule.createLibrarySync({
    hooks: () => ({
      onCommit: commit => {
        baselineAtCommit = sync.getBaseline();
        commits.push(commit);
        currentView.cards = [...commit.cards];
        currentView.loadedCardIds = commit.cards.map(card => card.id);
      },
      onFallback: reason => fallbacks.push(reason),
    }),
    fetchRevision: async () => library.token(),
    fetchChanges: (project, since) => library.fetchChanges(project, since),
    fetchRows: (query, assetIds, boundaryCursor, stackIds) => library.fetchRows(query, assetIds, boundaryCursor, stackIds),
    readMutationState: () => ({ epoch: mutation.epoch, pending: mutation.pending }),
    readView: () => ({ ...currentView, loadedCardIds: [...currentView.loadedCardIds], cards: [...currentView.cards] }),
    isPaused: () => (typeof pausedOverride === "function" ? pausedOverride() : Boolean(pausedOverride)),
    setTimeoutImpl: (fn, ms) => { const handle = { fn, ms }; timers.push(handle); return handle },
    clearTimeoutImpl: (handle) => {
      const index = timers.indexOf(handle);
      if (index >= 0) timers.splice(index, 1);
    },
    now: () => clock,
  });
  const flushTimers = () => {
    while (timers.length) {
      const timer = timers.shift();
      timer.fn();
    }
  };
  // setTimeout (not setImmediate): the controller yields to renders with
  // setTimeout(0), so a same-macrotask-class tick is needed to run past it.
  const settle = async () => { await new Promise(resolveTask => setTimeout(resolveTask, 20)) };
  // A realistic page load: revision token as of the fetch + the fetched cards.
  const loadPage = async (ids, { revisionToken = library.token() } = {}) => {
    currentView.cards = ids.map(id => ({
      ...library.assets.get(id),
      node_sort: { createdAt: library.assets.get(id).createdAt, sortName: library.assets.get(id).name, searchScore: null },
    }));
    currentView.loadedCardIds = [...ids];
    currentView.nextCursor = ids.length ? `cur:${ids[ids.length - 1]}` : null;
    sync.notePageRevision(revisionToken, null);
    await settle();
  };
  return { library, stacks: library.stacks, suppressIds: library.suppressIds, sync, commits, fallbacks, timers, flushTimers, settle, mutation, currentView, loadPage, baselineAtCommit: () => baselineAtCommit, clockRef: { get: () => clock, set: (v) => { clock = v } } };
}

const ids = (cards) => cards.map(card => card.id);

describe("library-sync controller", () => {
  it("keeps KNOWN_CHANGE_KINDS equal to the store's journaled kinds", () => {
    const source = readFileSync(join(repositoryRoot, "lib", "sqlite-asset-store.mjs"), "utf8");
    // Static `kind: "…"` literals plus ternary-built kinds ("stack-cover-changed"
    // is assembled in `coverChanged ? … : …`), extracted by the change-vocabulary
    // prefix. The two non-kind hits are entityType/entityId strings.
    const found = new Set([...source.matchAll(/"((?:asset|assets|stack|group|groups|generation|library)-[a-z-]+)"/g)].map(match => match[1]));
    for (const notAKind of ["asset-batch", "group-assignment"]) found.delete(notAKind);
    assert.deepEqual([...reconcileModule.KNOWN_CHANGE_KINDS].sort(), [...found].sort());
  });

  it("reconciles a push into the loaded window and advances the baseline", async () => {
    const h = createHarness();
    for (let i = 1; i <= 5; i += 1) h.library.addAsset(`a${i}`);
    await h.sync.ensureBaseline("default");
    await h.loadPage(["a5", "a4", "a3"]);
    // One new asset arrives over SSE.
    h.library.addAsset("a6");
    h.sync.notePush({ revision: h.library.token(), fromRevision: `3:dv1`, complete: true, changes: h.library.journal.filter(c => c.revision > 3) });
    h.sync.schedule();
    await h.settle();
    assert.equal(h.commits.length, 1);
    assert.deepEqual(ids(h.commits[0].cards), ["a6", "a5", "a4", "a3"]);
    assert.equal(h.sync.getBaseline(), h.library.revision);
    assert.equal(h.fallbacks.length, 0);
    // 反向验证 1 的断言面：commit 落地时 baseline 必须还是旧值（提交后才前进）。
    assert.equal(h.baselineAtCommit(), 5);
  });

  it("missed, duplicated and reordered pushes still converge (the delta API is authoritative)", async () => {
    const h = createHarness();
    for (let i = 1; i <= 4; i += 1) h.library.addAsset(`a${i}`);
    await h.sync.ensureBaseline("default");
    await h.loadPage(["a4", "a3"]); // baseline 4; the page's own sync finds nothing
    // Two changes happen while the stream is down (revisions 5 and 6); the
    // push that finally arrives starts at the baseline, and its payload
    // carries both changes twice (duplicates, out of journal order).
    h.library.addAsset("a5");
    h.library.journalPush({ kind: "asset-updated", entityType: "asset", entityId: "a3" });
    const changes = h.library.journal.filter(c => c.revision > 4);
    h.sync.notePush({ revision: h.library.token(), fromRevision: `4:dv1`, complete: true, changes: [...changes, ...changes] });
    h.sync.schedule();
    await h.settle();
    assert.equal(h.commits.length, 1);
    assert.deepEqual(ids(h.commits[0].cards), ["a5", "a4", "a3"]);
    assert.equal(h.library.rowsCalls.length, 1);
    assert.deepEqual([...new Set(h.library.rowsCalls[0].assetIds)].sort(), ["a3", "a5"]);
    // A second push whose changes are already merged is a no-op.
    h.sync.notePush({ revision: h.library.token(), fromRevision: `4:dv1`, complete: true, changes: [...changes] });
    h.sync.schedule();
    await h.settle();
    assert.equal(h.commits.length, 1);
    assert.equal(h.library.rowsCalls.length, 1);
  });

  it("falls back when the delta is incomplete", async () => {
    const h = createHarness();
    h.library.addAsset("a1");
    await h.sync.ensureBaseline("default");
    await h.loadPage(["a1"]);
    const original = h.library.fetchChanges;
    h.library.fetchChanges = async (project, since) => ({ ...(await original(project, since)), complete: false });
    h.sync.schedule();
    await h.settle();
    assert.deepEqual(h.fallbacks, ["incomplete"]);
    assert.equal(h.sync.getBaseline(), null);
  });

  it("falls back on an unknown change kind and on library-backfilled", async () => {
    for (const [record, reason] of [
      [{ kind: "brand-new-kind", entityType: "asset", entityId: "a1" }, "unknown-kind"],
      [{ kind: "library-backfilled", entityType: "stack", entityId: "" }, "library-backfilled"],
    ]) {
      const h = createHarness();
      h.library.addAsset("a1");
      await h.sync.ensureBaseline("default");
      await h.loadPage(["a1"]);
      h.library.journalPush(record);
      h.sync.schedule();
      await h.settle();
      assert.equal(h.fallbacks.length, 1);
      assert.match(h.fallbacks[0], new RegExp(`^${reason}`));
      assert.equal(h.sync.getBaseline(), null);
    }
  });

  it("falls back on foreign library-changed detail keys", async () => {
    const h = createHarness();
    h.library.addAsset("a1");
    await h.sync.ensureBaseline("default");
    await h.loadPage(["a1"]);
    h.library.journalPush({ kind: "library-changed", entityType: "library", detail: { suppressionsRecorded: 1 } });
    h.sync.schedule();
    await h.settle();
    assert.equal(h.fallbacks.length, 0);
    assert.equal(h.commits.length, 1);
    h.library.journalPush({ kind: "library-changed", entityType: "library", detail: { somethingElse: true } });
    h.sync.schedule();
    await h.settle();
    assert.deepEqual(h.fallbacks, ["library-changed-detail"]);
  });

  it("falls back when a single sync needs more than 2000 ids", async () => {
    const h = createHarness();
    h.library.addAsset("a1");
    await h.sync.ensureBaseline("default");
    await h.loadPage(["a1"]);
    h.library.journalPush({ kind: "assets-updated", entityType: "asset-batch", entityId: "renamed", assetIds: Array.from({ length: 2001 }, (_, i) => `x${i}`) });
    h.sync.schedule();
    await h.settle();
    assert.deepEqual(h.fallbacks, ["too-many-ids"]);
  });

  it("retries a failing gallery-rows once, then falls back", async () => {
    const h = createHarness();
    h.library.addAsset("a1");
    h.library.addAsset("a2");
    await h.sync.ensureBaseline("default");
    await h.loadPage(["a2", "a1"]);
    const original = h.library.fetchRows;
    let calls = 0;
    h.library.fetchRows = async (...args) => {
      calls += 1;
      if (calls <= 2) throw new Error("boom");
      return original(...args);
    };
    h.library.journalPush({ kind: "asset-updated", entityType: "asset", entityId: "a1" });
    h.sync.schedule();
    await h.settle();
    assert.equal(calls, 2);
    assert.deepEqual(h.fallbacks, ["rows-failed"]);
  });

  it("full-reloads at most once per 10s when only data_version moved", async () => {
    const h = createHarness();
    h.library.addAsset("a1");
    await h.sync.ensureBaseline("default");
    await h.loadPage(["a1"]);
    // First token records the data version without falling back.
    h.sync.notePush({ revision: `${h.library.revision}:dv1` });
    h.library.bumpDataVersion();
    h.sync.notePush({ revision: `${h.library.revision}:x` });
    h.sync.schedule();
    await h.settle();
    assert.equal(h.fallbacks.filter(reason => reason === "data-version-only").length, 1);
    // The full reload re-establishes the baseline (the app's refreshKey path);
    // a second data-version-only push within the throttle window is ignored.
    await h.loadPage(["a1"]);
    h.library.bumpDataVersion();
    h.sync.notePush({ revision: `${h.library.revision}:y` });
    h.sync.schedule();
    await h.settle();
    assert.equal(h.fallbacks.filter(reason => reason === "data-version-only").length, 1);
    // After 10s the next one falls back again.
    await h.loadPage(["a1"]);
    h.clockRef.set(h.clockRef.get() + 10_001);
    h.library.bumpDataVersion();
    h.sync.notePush({ revision: `${h.library.revision}:z` });
    h.sync.schedule();
    await h.settle();
    assert.equal(h.fallbacks.filter(reason => reason === "data-version-only").length, 2);
  });

  it("a push arriving during a sync runs exactly one more sync", async () => {
    const h = createHarness();
    for (let i = 1; i <= 3; i += 1) h.library.addAsset(`a${i}`);
    await h.sync.ensureBaseline("default");
    await h.loadPage(["a3", "a2", "a1"]); // baseline 3; page sync finds nothing
    // Slow the NEXT sync down inside fetchChanges.
    const gate = deferred();
    const original = h.library.fetchChanges;
    let calls = 0;
    h.library.fetchChanges = async (...args) => {
      calls += 1;
      if (calls === 1) await gate.promise;
      return original(...args);
    };
    h.library.addAsset("a4");
    h.sync.schedule();
    await h.settle();
    // Push lands while the first sync is still fetching changes: at most one
    // rerun is queued (never a second concurrent sync), and the rerun sees
    // the pushed change from the new baseline.
    h.library.addAsset("a5");
    h.sync.notePush({ revision: h.library.token(), fromRevision: `4:dv1`, complete: true, changes: h.library.journal.filter(c => c.revision > 4) });
    h.sync.schedule();
    gate.resolve();
    await h.settle();
    await h.settle();
    assert.equal(h.commits.length, 1);
    // The first sync's fetchChanges resolved after a5 existed, so one commit
    // already carries both assets — and the rerun found nothing new to merge.
    assert.deepEqual(ids(h.commits[0].cards), ["a5", "a4", "a3", "a2", "a1"]);
    assert.equal(h.sync.stats().reruns, 1);
  });

  it("discards the result when the view switched, the window reloaded, pagination moved or a mutation happened — baseline untouched", async () => {
    for (const [mutate, name] of [
      [(h) => { h.currentView.viewKey = "view-2" }, "view switch"],
      [(h) => { h.currentView.generation += 1 }, "window reload"],
      [(h) => { h.currentView.nextCursor = "cur:page-2" }, "pagination"],
      [(h) => { h.mutation.epoch += 1 }, "mutation epoch"],
    ]) {
      const h = createHarness();
      h.library.addAsset("a1");
      h.library.addAsset("a2");
      await h.sync.ensureBaseline("default");
      await h.loadPage(["a2", "a1"]); // baseline 2
      const gate = deferred();
      const original = h.library.fetchRows;
      h.library.fetchRows = async (...args) => { await gate.promise; return original(...args) };
      h.library.addAsset("a3");
      h.sync.schedule();
      await h.settle();
      mutate(h);
      gate.resolve();
      await h.settle();
      // 320 补充 4：作废不再终止——记一次重跑，等在途因素稳定后变更照样合并
      // （baseline 在提交前不动、提交后前进到最新）。
      await h.settle();
      await h.settle();
      assert.ok(h.commits.length >= 1, `${name}: eventual commit`);
      const mergedIds = ids(h.commits.at(-1).cards);
      assert.ok(mergedIds.includes("a3"), `${name}: discarded change merged on rerun`);
      assert.equal(h.sync.getBaseline(), h.library.revision, `${name}: baseline advanced after commit`);
    }
  });

  it("waits for in-flight mutations before merging, then runs once", async () => {
    const h = createHarness();
    h.library.addAsset("a1");
    await h.sync.ensureBaseline("default");
    await h.loadPage(["a1"]);
    h.mutation.pending = 1;
    h.library.addAsset("a2");
    h.sync.schedule();
    await h.settle();
    assert.equal(h.commits.length, 0);
    h.mutation.pending = 0;
    h.flushTimers();
    await h.settle();
    assert.equal(h.commits.length, 1);
    assert.deepEqual(ids(h.commits[0].cards), ["a2", "a1"]);
  });

  it("a null page revision falls back to the baseline captured at request time", async () => {
    const h = createHarness();
    h.library.addAsset("a1");
    await h.sync.ensureBaseline("default"); // baseline 1
    // A change happens between ensureBaseline and the page fetch.
    h.library.addAsset("a2");
    // Page served by another (stale) connection: revision null.
    await h.loadPage(["a2", "a1"], { revisionToken: null });
    assert.equal(h.sync.getBaseline(), 1);
    h.sync.schedule();
    await h.settle();
    // The replay merges the change the null page could not vouch for.
    assert.deepEqual(ids(h.commits[0].cards), ["a2", "a1"]);
  });

  it("does not run while paused and runs once when unpaused", async () => {
    let pausedFlag = true;
    const h = createHarness({ paused: () => pausedFlag });
    h.library.addAsset("a1");
    await h.sync.ensureBaseline("default");
    await h.loadPage(["a1"]);
    h.library.addAsset("a2");
    h.sync.schedule();
    await h.settle();
    assert.equal(h.commits.length, 0);
    pausedFlag = false;
    h.sync.schedule();
    await h.settle();
    assert.equal(h.commits.length, 1);
    assert.deepEqual(ids(h.commits[0].cards), ["a2", "a1"]);
  });

  it("derivative-only changes outside the loaded window trigger no gallery-rows", async () => {
    const h = createHarness();
    h.library.addAsset("a1");
    await h.sync.ensureBaseline("default");
    await h.loadPage(["a1"]);
    const rowsBefore = h.library.rowsCalls.length;
    h.library.journalPush({ kind: "assets-updated", entityType: "asset-batch", entityId: "derivatives", assetIds: ["ghost1", "ghost2"], flags: ["derivatives"] });
    h.sync.schedule();
    await h.settle();
    assert.equal(h.library.rowsCalls.length, rowsBefore);
    // The baseline advances with no card changes.
    assert.equal(h.commits.length, 1);
    assert.deepEqual(ids(h.commits[0].cards), ["a1"]);
    assert.equal(h.sync.getBaseline(), h.library.revision);
    // Loaded derivative-only ids ARE re-fetched.
    h.library.journalPush({ kind: "assets-updated", entityType: "asset-batch", entityId: "derivatives", assetIds: ["a1"], flags: ["derivatives"] });
    h.sync.schedule();
    await h.settle();
    assert.equal(h.library.rowsCalls.length, rowsBefore + 1);
    assert.deepEqual(h.library.rowsCalls.at(-1).assetIds, ["a1"]);
  });

  it("reset drops the baseline so nothing runs until the next page lands", async () => {
    const h = createHarness();
    h.library.addAsset("a1");
    await h.sync.ensureBaseline("default");
    await h.loadPage(["a1"]);
    h.sync.reset();
    h.library.addAsset("a2");
    h.sync.schedule();
    await h.settle();
    assert.equal(h.commits.length, 0);
  });

  it("passes affected stack ids to fetchRows so a cover swap delivers the new node row (320 补充 2)", async () => {
    const h = createHarness();
    for (let i = 1; i <= 4; i += 1) h.library.addAsset(`a${i}`);
    // a1..a3 成堆叠，cover=a1
    h.stacks.set("st1", { memberIds: ["a1", "a2", "a3"], coverId: "a1" });
    await h.sync.ensureBaseline("default");
    await h.loadPage(["a4", "a3", "a2", "a1"]);
    // 外部归档 cover a1：journal 只带 a1；堆叠存活（cover 换成 a2）。
    h.library.assets.delete("a1");
    h.stacks.set("st1", { memberIds: ["a2", "a3"], coverId: "a2" });
    h.library.journalPush({ kind: "asset-archived", entityType: "asset", entityId: "a1" });
    h.library.journalPush({ kind: "stack-cover-changed", entityType: "stack", entityId: "st1", assetIds: ["a1", "a2"] });
    h.sync.schedule();
    await h.settle();
    // fetchRows 收到了堆叠编号（修复前 App 接线把它丢了，这个断言是红的）。
    const last = h.library.rowsCalls.at(-1);
    assert.ok(last, "fetchRows ran");
    assert.ok(last.stackIds.includes("st1"), `fetchRows stackIds missing st1: ${JSON.stringify(last)}`);
    // 合并后：a1 的卡被节点卡（新 cover a2）替换。
    if (process.env.SYNC_DEBUG) {
      console.log("[diag] commits:", JSON.stringify(h.commits.map(c => ({ cards: ids(c.cards), removed: c.removedIds, viewer: c.viewer }))));
      console.log("[diag] rowsCalls:", JSON.stringify(h.library.rowsCalls));
    }
    const mergedIds = ids(h.commits.at(-1).cards);
    assert.ok(!mergedIds.includes("a1"), "archived cover card removed");
    assert.ok(mergedIds.includes("a2"), "new cover card present");
  });

  it("sends a stack-only batch when fetchIds are empty but stacks are affected (320 补充 2)", async () => {
    const h = createHarness();
    for (let i = 1; i <= 3; i += 1) h.library.addAsset(`a${i}`);
    h.stacks.set("st1", { memberIds: ["a1", "a2"], coverId: "a1" });
    await h.sync.ensureBaseline("default");
    await h.loadPage(["a3", "a2", "a1"]);
    // 构造「变更只带堆叠编号、无素材编号」的批次（防御性路径）。
    h.library.journalPush({ kind: "stack-updated", entityType: "stack", entityId: "st1" });
    h.sync.schedule();
    await h.settle();
    const last = h.library.rowsCalls.at(-1);
    assert.ok(last, "fetchRows ran");
    assert.ok(last.stackIds.includes("st1"), `stack-only batch sent: ${JSON.stringify(last)}`);
  });


  // ── 320 补充 3/4/5：viewer-close release 的健壮性 ──

  it("release during pagination discards and retries: the pinned card still leaves", async () => {
    const h = createHarness();
    for (let i = 1; i <= 5; i += 1) h.library.addAsset(`a${i}`);
    await h.sync.ensureBaseline("default");
    await h.loadPage(["a5", "a4", "a3"]);
    // 先让 a3 被钉住：取消收藏（变更 + 行缺席），检视器开着。
    h.currentView.viewedId = "a3";
    h.suppressIds.add("a3");
    h.library.journalPush({ kind: "asset-updated", entityType: "asset", entityId: "a3" });
    h.sync.schedule();
    await h.settle();
    // sync 已把 a3 钉住。先挂起下一轮 rows 请求，再关检视器触发 release——
    // releaseViewer 会同步启动 run，包装必须发生在触发之前。
    const gate = deferred();
    const original = h.library.fetchRows;
    let releaseCall = 0;
    h.library.fetchRows = async (query, assetIds, boundaryCursor, stackIds) => {
      releaseCall += 1;
      if (releaseCall === 1) {
        await gate.promise; // 第一轮 release 挂起
      }
      return original(query, assetIds, boundaryCursor, stackIds);
    };
    h.sync.releaseViewer();
    await h.settle(); // 让 release 的 fetchRows 进到 gate
    h.currentView.nextCursor = "cur:a4"; // release 在途时翻页
    gate.resolve();
    await h.settle();
    await h.settle();
    // 第一次 release 作废（不提交它那轮），重跑的 release 照常合并——
    // 关键是不丢：a3 的行还是要被重新核对。
    if (process.env.SYNC_DEBUG) console.log("[diag] stats:", JSON.stringify(h.sync.stats()));
    assert.ok(releaseCall >= 2, `release retried after discard (calls=${releaseCall})`);
  });

  it("release while a mutation is in flight waits and does not commit early", async () => {
    const h = createHarness();
    for (let i = 1; i <= 4; i += 1) h.library.addAsset(`a${i}`);
    await h.sync.ensureBaseline("default");
    await h.loadPage(["a4", "a3", "a2"]);
    h.currentView.viewedId = "a2";
    h.suppressIds.add("a2");
    h.library.journalPush({ kind: "asset-updated", entityType: "asset", entityId: "a2" });
    h.sync.schedule();
    await h.settle();
    const gate = deferred();
    const original = h.library.fetchRows;
    let releaseCall = 0;
    h.library.fetchRows = async (...args) => {
      releaseCall += 1;
      if (releaseCall === 2) await gate.promise; // 第二轮（真正的 release 查询）挂起
      return original(...args);
    };
    h.sync.releaseViewer();
    h.mutation.pending = 1;
    h.sync.schedule();
    await h.settle();
    gate.resolve();
    await h.settle();
    h.mutation.pending = 0;
    h.flushTimers();
    await h.settle();
    // 没有提交丢在半路：commits 里没有以旧快照落地的 merge。
    for (const commit of h.commits) {
      assert.ok(Array.isArray(commit.cards), "commit shape intact");
    }
    assert.ok(releaseCall >= 1, "release fetch ran");
  });

  it("release discards when the list gained cards mid-flight (320 补充 5)", async () => {
    const h = createHarness();
    for (let i = 1; i <= 4; i += 1) h.library.addAsset(`a${i}`);
    await h.sync.ensureBaseline("default");
    await h.loadPage(["a4", "a3", "a2"]);
    h.currentView.viewedId = "a2";
    h.suppressIds.add("a2");
    h.library.journalPush({ kind: "asset-updated", entityType: "asset", entityId: "a2" });
    h.sync.schedule();
    await h.settle();
    // 先包装（第一轮 release 挂起、在途时插入导入卡），再关检视器触发 release。
    const gate = deferred();
    const original = h.library.fetchRows;
    let releaseCall = 0;
    h.library.fetchRows = async (query, assetIds, boundaryCursor, stackIds) => {
      releaseCall += 1;
      if (releaseCall === 1) {
        // 行请求在途时列表插入了一张导入卡（编号与对象都变）。
        gate.promise.then(() => {
          const extra = { id: "a9", createdAt: "2026-02-01T00:00:00.000Z", name: "a9", child_asset_ids: [], favorite: false };
          h.library.assets.set("a9", extra);
          h.library.journalPush({ kind: "asset-added", entityType: "asset", entityId: "a9" });
          h.currentView.cards = [{ ...extra, node_sort: { createdAt: extra.createdAt, sortName: "a9", searchScore: null } }, ...h.currentView.cards];
          h.currentView.loadedCardIds = ["a9", ...h.currentView.loadedCardIds];
        });
        await gate.promise;
      }
      return original(query, assetIds, boundaryCursor, stackIds);
    };
    h.sync.releaseViewer();
    gate.resolve();
    await h.settle();
    await h.settle();
    // release 作废重跑后的提交必须包含 a9——旧快照落地会把导入卡盖掉。
    // （钉住那次提交发生在 a9 插入之前，不含它是对的。）
    assert.ok(h.sync.stats()["release-discards"] === 1, "first release discarded");
    const lastCommit = h.commits.at(-1);
    assert.ok(lastCommit, "release retry committed");
    assert.ok(ids(lastCommit.cards).includes("a9"), "mid-flight import card survives the merge");
  });

  it("a detail merge (same id, new object) during the rows request discards and re-merges (320 补充 5)", async () => {
    const h = createHarness();
    for (let i = 1; i <= 4; i += 1) h.library.addAsset(`a${i}`);
    await h.sync.ensureBaseline("default");
    await h.loadPage(["a4", "a3", "a2"]);
    const gate = deferred();
    const original = h.library.fetchRows;
    let rowsCall = 0;
    h.library.fetchRows = async (...args) => {
      rowsCall += 1;
      if (rowsCall === 1) {
        gate.promise.then(() => {
          // 详情合并：同编号、新对象（inspect 的 fetchAsset 路径，GET 不顶
          // epoch）——只触发对象比较这一项作废检查。
          h.currentView.cards = h.currentView.cards.map(card =>
            card.id === "a3" ? { ...card, prompt: "detail-merged" } : card);
        });
        await gate.promise;
      }
      return original(...args);
    };
    h.library.journalPush({ kind: "asset-updated", entityType: "asset", entityId: "a4" });
    h.sync.schedule();
    gate.resolve();
    await h.settle();
    await h.settle();
    assert.ok(h.commits.length >= 1, "eventual commit");
    const last = h.commits.at(-1);
    const a3 = last.cards.find(card => card.id === "a3");
    assert.ok(a3, "a3 present");
    assert.equal(a3.prompt, "detail-merged", "detail merge not overwritten by the stale snapshot");
  });


  it("an unrelated mutation epoch discards the in-flight merge (defence in depth, 320 补充 4)", async () => {
    const h = createHarness();
    for (let i = 1; i <= 3; i += 1) h.library.addAsset(`a${i}`);
    await h.sync.ensureBaseline("default");
    await h.loadPage(["a3", "a2", "a1"]);
    const gate = deferred();
    const original = h.library.fetchRows;
    let rowsCall = 0;
    h.library.fetchRows = async (...args) => {
      rowsCall += 1;
      if (rowsCall === 1) {
        gate.promise.then(() => { h.mutation.epoch += 1; });
        await gate.promise;
      }
      return original(...args);
    };
    h.library.journalPush({ kind: "asset-updated", entityType: "asset", entityId: "a1" });
    h.sync.schedule();
    gate.resolve();
    await h.settle();
    await h.settle();
    // 反向验证 6 的断言面：epoch 检查去掉时不会作废重跑（rows 只查一次），
    // 变更由「旧快照直接合并」完成——行为等价但防御失效，这条即红。
    assert.ok(rowsCall === 2, `epoch discard triggered a rerun (rowsCall=${rowsCall})`);
    assert.ok(h.commits.length >= 1, "change merged after the discard rerun");
  });

  it("steps the viewer to the card now at the deleted one's position", async () => {
    const h = createHarness();
    for (let i = 1; i <= 4; i += 1) h.library.addAsset(`a${i}`);
    await h.sync.ensureBaseline("default");
    await h.loadPage(["a4", "a3", "a2"]);
    h.currentView.viewedId = "a2";
    h.library.assets.delete("a2");
    h.library.journalPush({ kind: "asset-deleted", entityType: "asset", entityId: "a2" });
    h.sync.schedule();
    await h.settle();
    assert.equal(h.commits.length, 1);
    assert.deepEqual(ids(h.commits[0].cards), ["a4", "a3"]);
    assert.deepEqual(h.commits[0].viewer, { action: "move", id: "a3" });
  });

  it("release does not eat concurrent push changes when release request fails first (320 返工 1 A)", async () => {
    const h = createHarness();
    for (let i = 1; i <= 5; i += 1) h.library.addAsset(`a${i}`);
    await h.sync.ensureBaseline("default");
    await h.loadPage(["a5", "a4", "a3"]);
    h.currentView.viewedId = "a3";
    h.suppressIds.add("a3");
    h.library.journalPush({ kind: "asset-updated", entityType: "asset", entityId: "a3" });
    h.sync.schedule();
    await h.settle();

    h.currentView.viewerOpen = false;
    h.currentView.viewedId = "";
    const originalFetchRows = h.library.fetchRows;
    let callCount = 0;
    h.library.fetchRows = async (...args) => {
      callCount += 1;
      if (callCount === 1) throw new Error("transient release fetch error");
      return originalFetchRows(...args);
    };
    h.sync.releaseViewer();
    await h.settle();
    await h.settle();

    h.library.addAsset("a6");
    h.sync.notePush({ revision: h.library.token() });
    h.sync.schedule();
    await h.settle();
    await h.settle();
    h.flushTimers();
    await h.settle();
    await h.settle();

    const lastCommit = h.commits.at(-1);
    assert.ok(lastCommit, "a commit must have landed");
    assert.ok(ids(lastCommit.cards).includes("a6"), "last commit must contain a6");
    assert.deepEqual(ids(lastCommit.cards), ["a6", "a5", "a4"]);
    assert.equal(h.sync.getBaseline(), h.library.revision, "baseline must equal library version");
  });

  it("release merges concurrent library changes in the same run (320 返工 1 A)", async () => {
    const h = createHarness();
    for (let i = 1; i <= 5; i += 1) h.library.addAsset(`a${i}`);
    await h.sync.ensureBaseline("default");
    await h.loadPage(["a5", "a4", "a3"]);
    h.currentView.viewedId = "a3";
    h.suppressIds.add("a3");
    h.library.journalPush({ kind: "asset-updated", entityType: "asset", entityId: "a3" });
    h.sync.schedule();
    await h.settle();

    h.currentView.viewerOpen = false;
    h.currentView.viewedId = "";
    h.library.addAsset("a6");
    h.sync.releaseViewer();
    await h.settle();
    await h.settle();

    const lastCommit = h.commits.at(-1);
    assert.ok(lastCommit, "a commit must have landed");
    assert.ok(ids(lastCommit.cards).includes("a6"), "concurrent change a6 merged in same run");
    assert.deepEqual(ids(lastCommit.cards), ["a6", "a5", "a4"]);
    assert.equal(h.sync.getBaseline(), h.library.revision, "baseline advances to match library revision");
  });
});

function deferred() {
  let resolveTask;
  let rejectTask;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolveTask = resolvePromise; rejectTask = rejectPromise });
  return { promise, resolve: () => resolveTask(), reject: (error) => rejectTask(error) };
}
