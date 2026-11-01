// gallery-incremental-oracle.test.mjs — THE correctness gate for the
// incremental gallery sync (review 2-6). Real server (startMosaRuntime), real
// client modules (tsc-compiled gallery-reconcile/library-sync/mosa-api), HTTP
// against the live endpoints. Seeded random mutations; after every sync a
// client's list must equal "re-fetch the whole view, minus the rows the
// server itself declares to be past the client's boundary cursor", with the
// same total and no duplicate ids. Clients whose view died (dissolved stack,
// deleted group) must report exactly that, verified against the server.
//
// SEED=<n> STEPS=<n> node --test test/gallery-incremental-oracle.test.mjs
// reproduces a single failure with its seed.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

// 40 seeds ran ~3:52 wall; the order caps the file at ~3 minutes, so the
// default is 25 seeds (>= the 20 floor) at the full 25 steps each.
const SEEDS = Math.max(20, Math.min(40, Number(process.env.SEED) || 25));
const STEPS = Math.max(10, Math.min(40, Number(process.env.STEPS) || 25));

let api;
let syncFactory;
let tempRoot;
// The compiled mosa-api fetches relative paths (same-origin in the browser);
// in Node every request must carry the runtime base explicitly.
let oracleBase = "";
const wrappedFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (typeof input === "string" && input.startsWith("/")) {
    return wrappedFetch(`${oracleBase}${input}`, init);
  }
  return wrappedFetch(input, init);
};

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "mosa-gallery-oracle-"));
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
  api = await import(join(outDir, "mosa-api.js"));
  syncFactory = (await import(join(outDir, "library-sync.js"))).createLibrarySync;
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// Deterministic PRNG (mulberry32) so a failing seed reproduces exactly.
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeClient(syncFactory, id, view) {
  const client = {
    id,
    view: { scope: "all", query: "", sort: "newest", groupName: "", stackId: "", ...view },
    cards: [],
    loadedCardIds: [],
    nextCursor: null,
    pageTotal: null,
    baseline: null,
    generation: 0,
    paused: false,
    viewGone: null,
    syncCount: 0,
    navFetches: 0,
    reload() {
      client.cards = [];
      client.loadedCardIds = [];
      client.nextCursor = null;
      client.pageTotal = null;
      client.generation += 1;
      client.controller.reset();
      client.baseline = null;
    },
    async loadPages(count) {
      client.paused = true;
      try {
        client.baseline = await client.controller.ensureBaseline("default");
        let first = true;
        for (let index = 0; index < count; index += 1) {
          const page = await api.fetchAssetPage(clientAssetQuery(client), {
            ...(client.nextCursor ? { cursor: client.nextCursor } : {}),
          });
          if (first) client.pageTotal = page.total;
          first = false;
          const seen = new Set(client.loadedCardIds);
          for (const asset of page.assets) {
            if (seen.has(asset.id)) continue;
            seen.add(asset.id);
            client.cards.push(asset);
            client.loadedCardIds.push(asset.id);
          }
          client.nextCursor = page.nextCursor;
          client.controller.notePageRevision(page.revision, client.baseline);
          if (!page.nextCursor) break;
        }
      } finally {
        client.paused = false;
      }
    },
  };
  const rowsQuery = () => ({
    project: "default",
    scope: client.view.scope,
    query: client.view.query,
    sort: client.view.sort,
    mediaKind: "all",
    ...(client.view.groupName ? { group: client.view.groupName } : {}),
    ...(client.view.stackId ? { stackId: client.view.stackId } : {}),
  });
  client.rowsQuery = rowsQuery;
  client.controller = syncFactory({
    hooks: () => ({
      onCommit: (commit) => {
        if (process.env.ORACLE_VERBOSE) {
          console.log(`[oracle]   commit ${client.id}: removed=${JSON.stringify(commit.removedIds)} rows=${JSON.stringify(commit.classify.affectedAssetIds)} rev=${commit.revision} pageTotal=${commit.pageTotal} stack=${JSON.stringify(commit.stack)}`);
        }
        client.cards = commit.cards;
        client.loadedCardIds = commit.cards.map(card2 => card2.id);
        if (commit.pageTotal != null) client.pageTotal = commit.pageTotal;
        client.syncCount += 1;
        if (client.view.stackId) {
          if (commit.stack === null || (commit.stack != null && commit.stack.count === 0)
            || commit.classify.dissolvedStacks.includes(client.view.stackId)) {
            client.viewGone = client.viewGone || `stack ${client.view.stackId} gone`;
          }
        }
        if (client.view.groupName) {
          if (commit.classify.deletedGroups.includes(client.view.groupName)) {
            client.viewGone = client.viewGone || `group ${client.view.groupName} deleted`;
          } else if (commit.classify.groupRenames.has(client.view.groupName)) {
            let target = client.view.groupName;
            while (commit.classify.groupRenames.has(target)) {
              target = commit.classify.groupRenames.get(target);
            }
            client.view.groupName = target;
            client.reload();
          }
        }
      },
      onFallback: async (reason) => {
        // The oracle asserts incremental consistency; a fallback means the
        // merge gave up. Record it loudly — allowed reasons are tested
        // elsewhere, here it invalidates the comparison for this step.
        client.lastFallback = reason;
        if (reason === "unknown-kind" && client.baseline != null) {
          try {
            const delta = await api.fetchLibraryChanges("default", Math.max(0, client.baseline - 1));
            console.log(`[oracle] client ${client.id} baseline ${client.baseline} saw kinds:`,
              JSON.stringify(delta.changes.map(change => ({ k: change.kind, f: change.flags }))));
          } catch { /* diagnostic only */ }
        }
        client.reload();
      },
    }),
    fetchRevision: project => api.fetchLibraryRevision(project),
    fetchChanges: (project, since) => api.fetchLibraryChanges(project, since),
    // 320 补充 2：此接线必须和 web/gravityport/src/App.tsx 里 createLibrarySync 的接线一致（第 4 参数 stackIds 必须传下去）。
    fetchRows: (query, assetIds, boundaryCursor, stackIds) => api.fetchGalleryRows(query, assetIds, boundaryCursor, stackIds),
    readMutationState: () => ({ epoch: 0, pending: 0 }),
    readView: () => ({
      viewKey: `${client.id}:${client.generation}`,
      generation: client.generation,
      nextCursor: client.nextCursor,
      project: "default",
      cards: client.cards,
      loadedCardIds: client.loadedCardIds,
      query: rowsQuery(),
      viewedId: "",
    }),
    isPaused: () => client.paused,
  });
  return client;
}

function clientAssetQuery(client) {
  return {
    project: "default",
    q: client.view.query,
    scope: client.view.scope,
    sort: client.view.sort,
    mediaKind: "all",
    ...(client.view.groupName ? { group: client.view.groupName } : {}),
    ...(client.view.stackId ? { stackId: client.view.stackId } : {}),
  };
}

// The oracle comparison: full server view minus the rows the server itself
// declares to be past the client's boundary cursor.
async function verifyClient(runtime, client, label) {
  if (client.viewGone) {
    // The server must agree the view is dead or empty.
    if (client.view.stackId) {
      const response = await fetch(`${runtime.url}/api/asset-stacks/${encodeURIComponent(client.view.stackId)}?project=default`);
      if (response.ok) {
        const stack = (await response.json()).stack;
        assert.equal(stack.count, 0, `${label}: stack still has active members`);
      } else {
        assert.equal(response.status, 404, `${label}: stack lookup should be 404 or an empty stack`);
      }
    }
    if (client.view.groupName) {
      const nav = await (await fetch(`${runtime.url}/api/navigation?project=default`)).json();
      const exists = nav.navigation.groups.some(group => group.name.toLowerCase() === client.view.groupName.toLowerCase());
      assert.equal(exists, false, `${label}: group still exists`);
    }
    return;
  }
  const full = [];
  let firstTotal = null;
  let cursor; // walk the whole view from the top
  for (let guard = 0; guard < 60; guard += 1) {
    const page = await api.fetchAssetPage({ ...clientAssetQuery(client), ...(cursor ? { cursor } : {}) });
    if (firstTotal == null) firstTotal = page.total;
    for (const asset of page.assets) full.push(asset.id);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  const after = new Set();
  if (client.nextCursor && full.length) {
    for (let offset = 0; offset < full.length; offset += 1000) {
      const rows = await api.fetchGalleryRows(client.rowsQuery(), full.slice(offset, offset + 1000), client.nextCursor);
      for (const id of rows.afterCursorRowIds) after.add(id);
    }
  }
  const expected = full.filter(id => !after.has(id));
  const actual = client.cards.map(card2 => card2.id);
  assert.equal(new Set(actual).size, actual.length, `${label}: duplicate ids in the client list`);
  assert.deepEqual(actual, expected, `${label}: client list diverged from the server view`);
  assert.equal(client.pageTotal, firstTotal, `${label}: page total diverged`);
  // Sidebar-stat consistency for the scoped views (favorites/trash totals).
  if (client.view.scope === "favorite" || client.view.scope === "trash") {
    const nav = await (await fetch(`${runtime.url}/api/navigation?project=default`)).json();
    const navCount = client.view.scope === "favorite" ? nav.navigation.favorites : nav.navigation.trash;
    assert.equal(client.pageTotal, navCount, `${label}: view total disagrees with the sidebar count`);
  }
}

async function runOracle(seed) {
  const root = await mkdtemp(join(tmpdir(), `mosa-oracle-${seed}-`));
  const generated = join(root, "generated-images");
  await mkdir(generated, { recursive: true });
  await writeFile(join(generated, "pixel.png"), ONE_PIXEL_PNG);
  const runtime = await startRuntimeSafe({ root, generated });
    oracleBase = runtime.url;
  const cleanup = async () => {
    // stop() is async: the next seed may only start once this runtime has
    // fully released, or startMosaRuntime refuses a second active runtime.
    try { await runtime.stop(); } catch { /* stopped */ }
    await rm(root, { recursive: true, force: true }).catch(() => {});
  };
  try {
    const base = runtime.url;
    const json = async (path, options) => {
      const response = await fetch(`${base}${path}`, options);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(String(body.error || `HTTP ${response.status}`));
        error.code = body.code;
        error.status = response.status;
        throw error;
      }
      return body;
    };
    const post = (path, body) => json(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
    const del = (path, body) => json(path, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
    const patch = (path, body) => json(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });

    const random = rng(seed);
    const pick = (list) => list[Math.floor(random() * list.length)];
    const imagePath = join(generated, "pixel.png");
    let assetCounter = 0;

    // Full asset list over HTTP (250/page, cursor-paginated like the app).
    const listAll = async (query = "") => {
      const rows = [];
      let cursor;
      for (let guard = 0; guard < 80; guard += 1) {
        const page = await json(`/api/assets?project=default&limit=250${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        for (const asset of page.assets) rows.push(asset);
        if (!page.page.nextCursor) break;
        cursor = page.page.nextCursor;
      }
      return rows;
    };
    const liveIds = async () => (await listAll())
      .filter(asset => !asset.deleted_at && !asset.archived).map(asset => asset.id);
    const trashIds = async () => (await listAll()).filter(asset => asset.deleted_at).map(asset => asset.id);
    const stackedIds = async () => (await listAll())
      .filter(asset => !asset.deleted_at && asset.stack).map(asset => asset.id);
    const stackIds = async () => [...new Set((await stackedIds()).length ? (await listAll()).filter(a => a.stack && !a.deleted_at).map(a => a.stack.id) : [])];
    const groupNames = async () => (await (await fetch(`${base}/api/navigation?project=default`)).json()).navigation.groups.map(group => group.name);

    const newAsset = async () => {
      assetCounter += 1;
      const created = await post("/api/assets/create", {
        assetId: `o-${seed}-${assetCounter}`, imagePath, prompt: "oracle", theme: `Asset ${assetCounter}`,
      });
      return created.asset.id;
    };

    // ── seed library ──
    const seedIds = [];
    for (let i = 0; i < 20; i += 1) seedIds.push(await newAsset());
    const stackA = (await post("/api/asset-stacks", { projectId: "default", assetIds: [seedIds[0], seedIds[1], seedIds[2]] })).stack.id;
    const stackB = (await post("/api/asset-stacks", { projectId: "default", assetIds: [seedIds[3], seedIds[4]] })).stack.id;
    await post("/api/groups", { projectId: "default", name: "Oracle组" });
    await post("/api/assets/batch", { projectId: "default", action: "group", assetIds: [seedIds[5], seedIds[6], seedIds[7]], group: "Oracle组" });

    const clients = [
      makeClient(syncFactory, "all", {}),
      makeClient(syncFactory, "favorites", { scope: "favorite" }),
      makeClient(syncFactory, "unorganized", { scope: "unorganized" }),
      makeClient(syncFactory, "trash", { scope: "trash" }),
      makeClient(syncFactory, "group", { groupName: "Oracle组" }),
      makeClient(syncFactory, "stackA", { stackId: stackA, sort: "newest" }),
      makeClient(syncFactory, "search", { query: "asset" }),
      makeClient(syncFactory, "name-sort", { sort: "name" }),
    ];
    for (const client of clients) await client.loadPages(1 + Math.floor(random() * 3));
    const settle = () => new Promise(resolveTick => setTimeout(resolveTick, 30));
    const active = () => clients.filter(entry => !entry.viewGone);

    // Wait for a derivatives-flagged journal entry (a real completion).
    const waitDerivatives = async (timeoutMs = 15_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const delta = await json(`/api/library-changes?project=default&since=0&limit=20000`);
        if (delta.changes.some(change => change.flags.includes("derivatives"))) return true;
        if (Date.now() > deadline) return false;
        await new Promise(resolveWait => setTimeout(resolveWait, 100));
      }
    };

    const mutations = [
      async () => { await newAsset(); return "create" },
      async () => { await post(`/api/assets/${"default"}/${pick(await liveIds())}/favorite`); return "favorite" },
      async () => { await post("/api/assets/batch", { projectId: "default", action: "trash", assetIds: [pick(await liveIds())] }); return "trash" },
      async () => {
        const trashed = await trashIds();
        if (!trashed.length) return "restore-skip";
        await post(`/api/assets/default/${pick(trashed)}/restore`);
        return "restore";
      },
      async () => {
        const trashed = await trashIds();
        if (!trashed.length) return "permanent-skip";
        await del(`/api/assets/default/${pick(trashed)}`);
        return "permanent-delete";
      },
      async () => { await post(`/api/assets/default/${pick(await liveIds())}/archive`); return "archive" },
      async () => {
        const all = await listAll();
        const stacked = new Set(all.filter(a => a.stack && !a.deleted_at).flatMap(a => [a.id, ...[]]));
        const free = all.filter(asset => !asset.deleted_at && !asset.archived && !asset.stack).map(asset => asset.id);
        if (free.length < 2) return "stack-skip";
        await post("/api/asset-stacks", { projectId: "default", assetIds: [free[0], free[1]] });
        return "create-stack";
      },
      async () => {
        const stacks = await stackIds();
        const free = (await listAll()).filter(asset => !asset.deleted_at && !asset.archived && !asset.stack).map(asset => asset.id);
        if (!stacks.length || !free.length) return "add-skip";
        await post(`/api/asset-stacks/${pick(stacks)}/assets`, { projectId: "default", assetIds: [free[0]] });
        return "add-to-stack";
      },
      async () => {
        const stacks = await stackIds();
        if (!stacks.length) return "remove-skip";
        const stackId = pick(stacks);
        const members = (await json(`/api/asset-stacks/${stackId}/assets?project=default&limit=250`)).assets;
        if (members.length < 3) return "remove-skip"; // keep every stack ≥ 2 live members
        await del(`/api/asset-stacks/${stackId}/assets`, { projectId: "default", assetIds: [members[members.length - 1].id] });
        return "remove-from-stack";
      },
      async () => {
        const stacks = await stackIds();
        if (!stacks.length) return "reorder-skip";
        const stackId = pick(stacks);
        const members = (await json(`/api/asset-stacks/${stackId}/assets?project=default&limit=250`)).assets.map(a => a.id);
        if (members.length < 2) return "reorder-skip";
        await patch(`/api/asset-stacks/${stackId}/order`, { projectId: "default", assetIds: [...members.slice(1), members[0]] });
        return "reorder";
      },
      async () => {
        const keep = new Set([stackA, stackB]); // a stack client watches these
        const dissolvable = (await stackIds()).filter(id => !keep.has(id));
        if (!dissolvable.length) return "dissolve-skip";
        await del(`/api/asset-stacks/${pick(dissolvable)}`, { projectId: "default" });
        return "dissolve";
      },
      async () => {
        const stacked = await stackedIds();
        if (!stacked.length) return "moveout-skip";
        await post("/api/asset-stacks/move", { project: "default", assetIds: [pick(stacked)], targetStackId: null });
        return "move-out";
      },
      async () => {
        await post("/api/groups", { projectId: "default", name: `临时组 ${Math.floor(random() * 1000)}` });
        return "create-group";
      },
      async () => {
        await post("/api/assets/batch", { projectId: "default", action: "group", assetIds: [pick(await liveIds())], group: "Oracle组" });
        return "assign-group";
      },
      async () => {
        const renamable = (await groupNames()).filter(name => name !== "Oracle组");
        if (!renamable.length) return "rename-skip";
        const target = pick(renamable);
        await patch(`/api/groups/${encodeURIComponent(target)}`, { projectId: "default", name: `${target} 改` });
        return "rename-group";
      },
      async () => {
        const deletable = (await groupNames()).filter(name => name !== "Oracle组");
        if (!deletable.length) return "delete-skip";
        await del(`/api/groups/${encodeURIComponent(pick(deletable))}?project=default`);
        return "delete-group";
      },
      async () => {
        await patch(`/api/assets/default/${pick(await liveIds())}`, { prompt: `prompt-${random()}` });
        return "prompt";
      },
      async () => {
        await newAsset();
        const ok = await waitDerivatives();
        return ok ? "derivatives" : "derivative-timeout";
      },
    ];

    // Benign races: the free/stacked bookkeeping reads a flat list that only
    // annotates covers, so an op can hit a hidden member. Those are skips.
    const BENIGN_OP_CODES = new Set([
      "ASSET_ALREADY_STACKED", "STACK_ORDER_MISMATCH", "STACK_NEEDS_MULTIPLE_ASSETS",
      "STACK_NOT_FOUND", "ASSET_NOT_FOUND", "GROUP_ALREADY_EXISTS", "GROUP_NAME_REQUIRED",
      "ASSET_NOT_IN_STACK", "STACK_COVER_NOT_MEMBER",
    ]);
    const runMutation = async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await pick(mutations)();
        } catch (error) {
          if (BENIGN_OP_CODES.has(error.code) && attempt < 2) continue;
          if (BENIGN_OP_CODES.has(error.code)) return "op-skip";
          throw error;
        }
      }
    };
    for (let step = 0; step < STEPS; step += 1) {
      const outcome = await runMutation();
      if (process.env.ORACLE_VERBOSE) console.log(`[oracle] seed ${seed} step ${step}: ${outcome}`);
      assert.ok(outcome !== "derivative-timeout", `seed ${seed} step ${step}: derivative never completed`);
      for (const client of active()) {
        const roll = random();
        if (roll < 0.2 && client.nextCursor) await client.loadPages(1);
        if (roll < 0.7) {
          client.controller.schedule();
          await settle();
          assert.equal(client.lastFallback, undefined, `seed ${seed} step ${step}: client ${client.id} fell back to a full reload (${client.lastFallback})`);
        }
      }
      for (const client of clients) {
        const before = client.verifiedSyncs ?? 0;
        if (client.syncCount > before) {
          if (process.env.ORACLE_VERBOSE) console.log(`[oracle]   verify ${client.id}: baseline=${client.controller.getBaseline()} cursor=${client.nextCursor} cards=${client.cards.length}`);
          try {
            await verifyClient(runtime, client, `seed ${seed} step ${step} client ${client.id}`);
          } catch (error) {
            if (process.env.ORACLE_VERBOSE) {
              console.log(`[oracle]   FAILED ${client.id}: actual=${JSON.stringify(client.cards.map(c => c.id))}`);
              const delta = await api.fetchLibraryChanges("default", 0);
              console.log(`[oracle]   journal=${JSON.stringify(delta.changes.map(c => [c.revision, c.kind, c.entityId, c.assetIds]))}`);
            }
            throw error;
          }
          client.verifiedSyncs = client.syncCount;
        }
      }
    }
    // Final pass: every live client catches up on whatever it deferred, then
    // must match the server exactly.
    for (const client of active()) {
      client.controller.schedule();
      await settle();
    }
    for (const client of clients) {
      await verifyClient(runtime, client, `seed ${seed} final client ${client.id}`);
    }
  } finally {
    await cleanup();
  }
}

async function startRuntimeSafe({ root, generated }) {
  const { startMosaRuntime } = await import(join(repositoryRoot, "lib", "mosa-runtime.mjs"));
  return startMosaRuntime({
    port: 0,
    projectRoot: root,
    libraryDir: join(root, "library"),
    generatedImagesDir: generated,
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "sessions"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-data"),
    cowartRegistryPath: join(root, "state", "cowart-projects.json"),
  });
}

describe("gallery incremental oracle", () => {
  it(`keeps ${SEEDS} seeded clients identical to a full reload (${SEEDS}×${STEPS} steps)`, async () => {
    const started = Date.now();
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const seedStart = Date.now();
      await runOracle(seed);
      if (process.env.ORACLE_VERBOSE) {
        console.log(`seed ${seed}: ${Date.now() - seedStart}ms`);
      }
    }
  }, 480_000);
});
