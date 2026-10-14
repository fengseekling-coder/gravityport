import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";

// Gallery performance QA against the GravityPort React UI (web/gravityport).
// The renderer is the desktop shell, which serves the same built UI as the
// browser, so the scroll-step budget reads the React gallery's page size.
//
// Original budgets are carried over unchanged from the previous (windowed
// DOM) gallery: mounted cards, hydrated cards, DOM nodes and long-task
// latencies must stay inside them while the whole library loads. The React
// grid keeps that contract by mounting only the viewport window (real cards
// in the hydrate zone, same-geometry placeholders in the warm zone, spacer
// rows for the scroll extent). Grid state is read from the product DOM:
// `.asset-grid[data-loaded-assets]` (logical loaded count) and the
// `.asset-card` / `.asset-card-virtual-placeholder` children.

const root = resolve(import.meta.dirname, "..");
const ASSET_COUNT = Number.parseInt(process.env.MOSA_GALLERY_QA_ASSET_COUNT || "2000", 10);
const MAX_HYDRATED_CARDS = Number.parseInt(process.env.MOSA_GALLERY_QA_MAX_HYDRATED || "320", 10);
const MAX_MOUNTED_CARDS = Number.parseInt(process.env.MOSA_GALLERY_QA_MAX_MOUNTED || "400", 10);
const MAX_DOM_NODES = Number.parseInt(process.env.MOSA_GALLERY_QA_MAX_DOM_NODES || "9000", 10);
const MAX_LONG_TASK_MS = Number.parseInt(process.env.MOSA_GALLERY_QA_MAX_LONG_TASK_MS || "500", 10);
const MAX_LONG_TASK_TOTAL_MS = Number.parseInt(process.env.MOSA_GALLERY_QA_MAX_LONG_TASK_TOTAL_MS || "4000", 10);
const SKIP_BOTTOM_CHECK = process.env.MOSA_GALLERY_QA_SKIP_BOTTOM === "1";
// Mutations issued node-side against the desktop runtime must carry the same
// client token the shell was started with (QA parity with e2e-critical-flows).
const QA_CLIENT_TOKEN = "mosa_gallery_qa_client_token_0123456789abcdef";
// Optional structured diagnostics sink. Unset => script behavior is unchanged.
// Set => a JSON verdict (pass/fail + key metrics) is written even when the
// caller loses the process handle on a long run, so the exit status can be
// recovered from the file. QA diagnostics only; never read by product code.
const RESULT_FILE = process.env.MOSA_GALLERY_QA_RESULT_FILE || "";
const PROFILE_RENDERER = process.env.MOSA_GALLERY_QA_PROFILE === "1";
const qaResult = {
  status: "unknown",
  assetCount: ASSET_COUNT,
  loaded: null,
  cards: null,
  hydrated: null,
  placeholders: null,
  domNodes: null,
  longTaskCount: null,
  longTaskMax: null,
  longTaskTotal: null,
  appendLatencyMax: null,
  boundaryStallMax: null,
  elapsedMs: null,
  windowCollapses: null,
  cdpPointerInputAtScale: false,
  incrementalScenarios: [],
  cpuProfileTop: [],
  error: null,
};

async function writeResultFile() {
  if (!RESULT_FILE) return;
  await writeFile(RESULT_FILE, `${JSON.stringify(qaResult, null, 2)}\n`);
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function reserveFreePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  assert.ok(port > 0);
  return port;
}

function electronExecutable() {
  // Exercise the actual packaged macOS/Windows app without requiring a second
  // development Electron download. The same isolated QA Library and bounded
  // gallery performance assertions apply to either executable.
  if (process.env.MOSA_GALLERY_QA_EXECUTABLE) return resolve(process.env.MOSA_GALLERY_QA_EXECUTABLE);
  if (process.platform === "darwin") return resolve(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  if (process.platform === "win32") return resolve(root, "node_modules/electron/dist/electron.exe");
  return resolve(root, "node_modules/electron/dist/electron");
}

async function waitForPageTarget(port, child, getOutput) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await wait(100);
  }
  throw new Error(`Electron page target was not ready.\n${getOutput()}`);
}

async function createCdpClient(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", rejectOpen, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve: resolvePending, reject: rejectPending } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) rejectPending(new Error(JSON.stringify(message.error)));
    else resolvePending(message.result);
  });
  return {
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolvePending, rejectPending) => {
        pending.set(id, { resolve: resolvePending, reject: rejectPending });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Renderer evaluation failed");
  return result?.result?.value;
}

async function clickThroughChromium(client, selector) {
  const point = await evaluate(client, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    const box = node.getBoundingClientRect();
    const x = Math.round(box.left + box.width / 2);
    const y = Math.round(box.top + box.height / 2);
    return { x, y, hit: node.contains(document.elementFromPoint(x, y)) };
  })()`);
  assert.ok(point?.hit, `Chromium pointer hit-test failed at ${selector}`);
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
}

function summarizeCpuProfile(profile, limit = 20) {
  const nodesById = new Map((profile?.nodes || []).map((node) => [node.id, node]));
  const counts = new Map();
  for (const id of profile?.samples || []) counts.set(id, (counts.get(id) || 0) + 1);
  return [...counts.entries()]
    .map(([id, hits]) => {
      const frame = nodesById.get(id)?.callFrame || {};
      return {
        functionName: frame.functionName || "(anonymous)",
        source: String(frame.url || "").split("/").pop(),
        line: (frame.lineNumber ?? -1) + 1,
        column: (frame.columnNumber ?? -1) + 1,
        hits,
      };
    })
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit);
}

async function main() {
  const libraryDir = await mkdtemp(join(tmpdir(), "mosa-gallery-qa-library-"));  const userDataDir = await mkdtemp(join(tmpdir(), "mosa-gallery-qa-user-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "mosa-gallery-qa-project-"));
  let child = null;
  let client = null;
  try {
    const sourceDir = join(projectRoot, "generated-images");
    await mkdir(sourceDir, { recursive: true });
    const sourcePath = join(sourceDir, "pixel.png");
    await writeFile(sourcePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    const store = createSqliteAssetStore({
      projectRoot,
      managerDir: join(projectRoot, "mosa"),
      libraryDir,
      initializeFreshLibrary: true,
    });
    try {
      await store.ensureProject("default");
    } finally {
      store.close();
    }
    // Seed the scale fixture in one SQLite transaction, matching the same
    // canonical row shape used by test:performance. The GUI QA is measuring
    // renderer/runtime pagination and the mounted window, not 2k file copies
    // or 2k Sharp jobs; real mutations below still go through the public
    // Runtime APIs.
    const database = new Database(join(libraryDir, "mosa.db"));
    try {
      const timestamp = new Date().toISOString();
      const timestampEpoch = Date.parse(timestamp);
      const insertAsset = database.prepare(`
        INSERT INTO assets (
          project_id, id, asset, original_path, content_sha256, prompt, skill, style, ratio,
          business_fields_json, theme, favorite, archived, group_name, category, rating,
          version_change, source_type, source_json, metadata_json, search_text, tags_text,
          business_search_text, source_search_text, media_kind, source_group, conversation_id,
          generation_batch, created_at, created_at_epoch, updated_at, sort_name
        ) VALUES (
          'default', @id, @asset, @original_path, @content_sha256, @prompt, '', '', '',
          '{"width":1024,"height":1024}', '', 0, 0, '', '', 0,
          '', 'qa-gallery', '{"type":"qa-gallery"}', '{}', @prompt, '',
          '1024 1024', 'qa-gallery', 'image', 'qa-gallery', '', '',
          @created_at, @created_at_epoch, @updated_at, @sort_name
        )
      `);
      const insertFts = database.prepare("INSERT INTO asset_fts (project_id, asset_id, content) VALUES ('default', ?, ?)");
      database.transaction(() => {
        for (let index = 0; index < ASSET_COUNT; index += 1) {
          const id = `perf-${String(index).padStart(5, "0")}`;
          const prompt = `gallery virtualization fixture ${index}`;
          insertAsset.run({
            id,
            asset: `${id}.png`,
            original_path: sourcePath,
            content_sha256: `qa-${index}`,
            prompt,
            created_at: timestamp,
            created_at_epoch: timestampEpoch,
            updated_at: timestamp,
            sort_name: id,
          });
          insertFts.run(id, prompt);
        }
      })();
      const seededCount = Number(database.prepare("SELECT COUNT(*) AS count FROM assets WHERE project_id = 'default'").get().count || 0);
      assert.equal(seededCount, ASSET_COUNT, `QA seed wrote ${seededCount} of ${ASSET_COUNT} assets`);
      console.log(`[gallery-qa] seeded ${seededCount}/${ASSET_COUNT} in one isolated fixture transaction`);
    } finally {
      database.close();
    }

    const [cdpPort, desktopPort] = await Promise.all([reserveFreePort(), reserveFreePort()]);
    child = spawn(electronExecutable(), [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      ...(process.env.MOSA_GALLERY_QA_EXECUTABLE ? [] : [root]),
    ], {
      cwd: root,
      env: {
        ...process.env,
        MOSA_LIBRARY_DIR: libraryDir,
        MOSA_USER_DATA: userDataDir,
        MOSA_RUNTIME_MODE: "qa",
        MOSA_QA_RUN: "1",
        MOSA_CLIENT_TOKEN: QA_CLIENT_TOKEN,
        MOSA_DESKTOP_PORT: String(desktopPort),
        MOSA_DISABLE_BRIDGES: "cowart,cowartDiscovery,codex,grok",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const output = () => `stdout:\n${stdout.slice(-4000)}\nstderr:\n${stderr.slice(-4000)}`;
    const target = await waitForPageTarget(cdpPort, child, output);
    client = await createCdpClient(target.webSocketDebuggerUrl);
    await client.send("Runtime.enable");
    // The React UI starts every session on the unfiltered 所有素材 view (no
    // persisted facets), so no facet reset is needed before measuring.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (Number(await evaluate(client, "document.querySelectorAll('.asset-grid > .asset-card').length")) > 0) break;
      await wait(100);
    }
    // Request journal for pagination diagnostics (also reused by the
    // incremental scenarios below).
    await evaluate(client, `(()=>{
      window.__mosaReqLog=[];
      if(!window.__mosaFetchPatched){
        window.__mosaFetchPatched=true;
        const original=window.fetch;
        window.fetch=(...args)=>{
          const url=String(args[0] instanceof Request?args[0].url:args[0]);
          const entry={url,at:performance.now(),done:0};
          window.__mosaReqLog.push(entry);
          const result=original(...args);
          result.then(()=>{entry.done=performance.now();}).catch(()=>{entry.done=-1;});
          return result;
        };
      }
      return true;
    })()`)
    await evaluate(client, `window.__mosaLongTasks=[]; window.__mosaAppendMarks=[]; window.__mosaBoundaryStalls=[]; window.__mosaBoundaryStall=null; window.__mosaLongTaskObserver=new PerformanceObserver((list)=>window.__mosaLongTasks.push(...list.getEntries().map((entry)=>({startTime:entry.startTime,duration:entry.duration})))); window.__mosaLongTaskObserver.observe({entryTypes:['longtask']}); true`);
    if (PROFILE_RENDERER) {
      await client.send("Profiler.enable");
      await client.send("Profiler.start");
    }

    const startedAt = Date.now();
    // Exercise the real product path: a fast continuous scroll drives the
    // auto-append pagination; the QA records how long each pagination boundary
    // stays pending from entering the warm zone to the new cards being loaded.
    // Windowed DOM means the mounted card count no longer grows with loaded
    // pages; `data-loaded-assets` is the logical loaded count. The loop is
    // bounded by wall clock (evaluate round-trips dominate each step), with a
    // stall bail-out if nothing loads while pinned at the bottom.
    const scrollDeadline = Date.now() + 240_000;
    let lastProgressAt = Date.now();
    let lastLoaded = 0;
    while (Date.now() < scrollDeadline) {
      const scrollState = JSON.parse(await evaluate(client, `JSON.stringify((()=>{
        const grid=document.querySelector('.asset-grid');
        const cards=document.querySelectorAll('.asset-grid > .asset-card').length;
        const loaded=Number(grid.dataset.loadedAssets||0);
        const more=loaded < ${ASSET_COUNT};
        const now=performance.now();
        const pending=window.__mosaBoundaryPending;
        if(pending && loaded>pending.loaded){window.__mosaAppendMarks.push({at:pending.at,committedAt:now,loaded:pending.loaded,phase:'auto-append',latency:now-pending.at});window.__mosaBoundaryPending=null;}
        if(window.__mosaBoundaryStall && loaded>window.__mosaBoundaryStall.loaded){window.__mosaBoundaryStalls.push({at:window.__mosaBoundaryStall.at,endedAt:now,loaded:window.__mosaBoundaryStall.loaded,duration:now-window.__mosaBoundaryStall.at});window.__mosaBoundaryStall=null;}
        const remaining=Math.max(0,grid.scrollHeight-grid.scrollTop-grid.clientHeight);
        const triggerDistance=Math.max(600,grid.clientHeight*0.85)+32;
        if(!window.__mosaBoundaryPending && more && remaining<=triggerDistance){window.__mosaBoundaryPending={at:now,loaded};}
        const maxScrollTop=Math.max(0,grid.scrollHeight-grid.clientHeight);
        grid.scrollTop=Math.min(maxScrollTop,grid.scrollTop+Math.max(160,grid.clientHeight*0.7));
        if(more && grid.scrollTop>=maxScrollTop-0.5 && !window.__mosaBoundaryStall){window.__mosaBoundaryStall={at:now,loaded};}
        return {cards,loaded,more,scrollTop:grid.scrollTop,scrollHeight:grid.scrollHeight,clientHeight:grid.clientHeight};
      })())`));
      if (scrollState.loaded !== lastLoaded) { lastLoaded = scrollState.loaded; lastProgressAt = Date.now(); }
      else if (Date.now() - lastProgressAt > 30000) {
        const recent = await evaluate(client, `JSON.stringify((window.__mosaReqLog||[]).filter(e=>e.url.includes('/api/assets')).slice(-8).map(e=>({
          cursor:decodeURIComponent(e.url).match(/cursor=([^&]+)/)?.[1]?.slice(-24)||'first-page',
          view:e.url.includes('view=gallery')?'gallery':'stack',
          at:Math.round(e.at),done:Math.round(e.done),
        })))`);
        throw new Error(`pagination stalled at ${scrollState.loaded}/${ASSET_COUNT} loaded, scrollTop=${Math.round(scrollState.scrollTop)} scrollHeight=${Math.round(scrollState.scrollHeight)}; recent asset fetches: ${recent}`);
      }
      if (scrollState.loaded >= ASSET_COUNT || !scrollState.more) break;
      await wait(16);
    }
    await evaluate(client, `(()=>{const pending=window.__mosaBoundaryPending;const loaded=Number(document.querySelector('.asset-grid')?.dataset.loadedAssets||0);if(pending&&loaded>pending.loaded){const now=performance.now();window.__mosaAppendMarks.push({at:pending.at,committedAt:now,loaded:pending.loaded,phase:'auto-append',latency:now-pending.at});window.__mosaBoundaryPending=null;}return true;})()`);
    await wait(1200);
    if (PROFILE_RENDERER) {
      const { profile } = await client.send("Profiler.stop");
      qaResult.cpuProfileTop = summarizeCpuProfile(profile);
      await client.send("Profiler.disable");
    }
    const topMetrics = JSON.parse(await evaluate(client, `JSON.stringify({
      scrollHeight:document.querySelector('.asset-grid').scrollHeight,
      clientHeight:document.querySelector('.asset-grid').clientHeight,
      columns:getComputedStyle(document.querySelector('.asset-grid')).gridTemplateColumns,
      firstPlaceholderHeight:(card=>card?card.getBoundingClientRect().height:0)(document.querySelector('.asset-grid > .asset-card-virtual-placeholder')),
      firstPlaceholderRatio:(card=>card?card.style.aspectRatio:'')(document.querySelector('.asset-grid > .asset-card-virtual-placeholder')),
      firstPlaceholderWidth:(card=>card?card.getBoundingClientRect().width:0)(document.querySelector('.asset-grid > .asset-card-virtual-placeholder'))
    })`));
    let bottomMetrics = null;
    if (!SKIP_BOTTOM_CHECK) {
      await evaluate(client, `window.__mosaAppendMarks.push({at:performance.now(),cards:document.querySelectorAll('.asset-grid > .asset-card').length,phase:'bottom-jump'}); true`);
      await evaluate(client, `(()=>{const grid=document.querySelector('.asset-grid');grid.scrollTop=grid.scrollHeight;grid.dispatchEvent(new Event('scroll'));return grid.scrollTop})()`);
      await wait(1200);
      await evaluate(client, `window.__mosaLongTaskObserver?.disconnect(); true`);
      bottomMetrics = JSON.parse(await evaluate(client, `JSON.stringify({
        scrollTop:document.querySelector('.asset-grid').scrollTop,
        scrollHeight:document.querySelector('.asset-grid').scrollHeight,
        hydrated:document.querySelectorAll('.asset-grid > .asset-card:not(.asset-card-virtual-placeholder)').length,
        visibleHydrated:(()=>{const grid=document.querySelector('.asset-grid');const bounds=grid.getBoundingClientRect();return [...grid.querySelectorAll(':scope > .asset-card:not(.asset-card-virtual-placeholder)')].filter((card)=>{const rect=card.getBoundingClientRect();return rect.bottom>bounds.top&&rect.top<bounds.bottom}).length})(),
        visiblePlaceholders:(()=>{const grid=document.querySelector('.asset-grid');const bounds=grid.getBoundingClientRect();return [...grid.querySelectorAll(':scope > .asset-card-virtual-placeholder')].filter((card)=>{const rect=card.getBoundingClientRect();return rect.bottom>bounds.top&&rect.top<bounds.bottom}).length})()
      })`));
    } else {
      await evaluate(client, `window.__mosaLongTaskObserver?.disconnect(); true`);
    }
    const healthSnapshot = JSON.parse(await evaluate(client, `(async()=>{const response=await fetch('/api/health');return JSON.stringify(await response.json())})()`));
    const apiSnapshot = JSON.parse(await evaluate(client, `(async()=>{const response=await fetch('/api/assets?project=default&limit=2');return JSON.stringify(await response.json())})()`));
    const metrics = JSON.parse(await evaluate(client, `JSON.stringify({
      href:location.href,
      loaded:Number(document.querySelector('.asset-grid')?.dataset.loadedAssets||0),
      cards:document.querySelectorAll('.asset-grid > .asset-card').length,
      hydrated:document.querySelectorAll('.asset-grid > .asset-card:not(.asset-card-virtual-placeholder)').length,
      placeholders:document.querySelectorAll('.asset-grid > .asset-card-virtual-placeholder').length,
      nodes:document.querySelectorAll('*').length,
      gridText:(document.querySelector('.asset-grid')?.textContent||'').slice(0,500),
      gridHtml:(document.querySelector('.asset-grid')?.innerHTML||'').slice(0,1000),
      longTasks:window.__mosaLongTasks.length,
      longTaskTotal:Math.round(window.__mosaLongTasks.reduce((sum,entry)=>sum+entry.duration,0)),
      longTaskMax:Math.round(Math.max(0,...window.__mosaLongTasks.map((entry)=>entry.duration))),
      longTaskEntries:window.__mosaLongTasks,
      appendMarks:window.__mosaAppendMarks,
      appendLatencyMax:Math.round(Math.max(0,...window.__mosaAppendMarks.filter((entry)=>Number.isFinite(entry.latency)).map((entry)=>entry.latency))),
      boundaryStalls:window.__mosaBoundaryStalls,
      boundaryStallMax:Math.round(Math.max(0,...window.__mosaBoundaryStalls.map((entry)=>entry.duration))),
      scrollHeight:document.querySelector('.asset-grid').scrollHeight
    })`));
    metrics.apiSnapshot = apiSnapshot;
    metrics.healthSnapshot = healthSnapshot;
    metrics.expectedLibraryDir = libraryDir;
    metrics.topMetrics = topMetrics;
    metrics.bottomMetrics = bottomMetrics;
    console.log(JSON.stringify(metrics, null, 2));
    metrics.elapsedMs = Date.now() - startedAt;
    qaResult.loaded = metrics.loaded;
    qaResult.cards = metrics.cards;
    qaResult.hydrated = metrics.hydrated;
    qaResult.placeholders = metrics.placeholders;
    qaResult.domNodes = metrics.nodes;
    qaResult.longTaskCount = metrics.longTasks;
    qaResult.longTaskMax = metrics.longTaskMax;
    qaResult.longTaskTotal = metrics.longTaskTotal;
    qaResult.appendLatencyMax = metrics.appendLatencyMax;
    qaResult.boundaryStallMax = metrics.boundaryStallMax;
    qaResult.elapsedMs = metrics.elapsedMs;

    assert.equal(metrics.loaded, ASSET_COUNT, `expected ${ASSET_COUNT} loaded assets: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.cards <= MAX_MOUNTED_CARDS, `mounted cards ${metrics.cards} exceeds ${MAX_MOUNTED_CARDS}`);
    assert.ok(metrics.hydrated <= MAX_HYDRATED_CARDS, `hydrated cards ${metrics.hydrated} exceeds ${MAX_HYDRATED_CARDS}`);
    assert.ok(metrics.nodes <= MAX_DOM_NODES, `DOM nodes ${metrics.nodes} exceeds ${MAX_DOM_NODES}`);
    assert.ok(metrics.longTaskMax <= MAX_LONG_TASK_MS, `long task max ${metrics.longTaskMax}ms exceeds ${MAX_LONG_TASK_MS}ms`);
    assert.ok(metrics.longTaskTotal <= MAX_LONG_TASK_TOTAL_MS, `long task total ${metrics.longTaskTotal}ms exceeds ${MAX_LONG_TASK_TOTAL_MS}ms`);
    assert.equal(metrics.hydrated + metrics.placeholders, metrics.cards);
    assert.ok(topMetrics.scrollHeight > topMetrics.clientHeight * 2, "large gallery must preserve a real scrollable extent");
    if (topMetrics.firstPlaceholderHeight > 0) {
      const [w, h] = String(topMetrics.firstPlaceholderRatio).split("/").map((value) => Number.parseFloat(value));
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0) {
        const expectedHeight = topMetrics.firstPlaceholderWidth * h / w;
        assert.ok(
          Math.abs(topMetrics.firstPlaceholderHeight - expectedHeight) <= 1.5,
          `placeholder geometry must match its asset ratio (${topMetrics.firstPlaceholderHeight} vs ${expectedHeight})`,
        );
      }
    }
    if (bottomMetrics) {
      assert.ok(bottomMetrics.scrollTop > 0, "gallery must be able to scroll away from the first viewport");
      assert.ok(bottomMetrics.visibleHydrated > 0, "the far end of the gallery must render hydrated cards in the viewport");
      assert.equal(bottomMetrics.visiblePlaceholders, 0, "virtual placeholders must never be exposed inside the visible viewport");
    }

    // ------------------------------------------------------------------
    // Library Change 增量同步专项场景：在全部加载的状态下逐个触发单实体
    // 变化，度量「revision before/after、delta 数、页面请求数、已加载窗口
    // 是否塌缩、UI 反馈耗时」。React 画廊对变更的既有策略是重取当前已加载
    // 窗口（SSE 驱动），因此这里的硬性门槛不是“零页面请求”，而是：任何
    // 普通变更都不得让已加载窗口塌缩回第一页（loaded 只增不减）、滚动位置
    // 不得被重置，且变更必须经 SSE 反映到 UI。
    // ------------------------------------------------------------------
    const runtimeHealth = await fetch(`http://127.0.0.1:${desktopPort}/api/health`).then((response) => response.json());
    assert.ok(runtimeHealth?.productVersion, "desktop runtime must be reachable for the incremental scenarios");

    // 回到画廊顶部：新增素材（newest 排序）的卡片要出现在可见 DOM 里。
    await evaluate(client, `(()=>{const grid=document.querySelector('.asset-grid');grid.scrollTop=0;grid.dispatchEvent(new Event('scroll'));return true})()`);
    await wait(1200);

    const runtimeFetch = async (path, options) => {
      const headers = { "x-mosa-client-token": QA_CLIENT_TOKEN, ...(options?.headers || {}) };
      const response = await fetch(`http://127.0.0.1:${desktopPort}${path}`, { ...options, headers });
      const body = await response.json();
      assert.ok(response.ok, `runtime mutation ${path} failed: ${response.status} ${JSON.stringify(body)}`);
      return body;
    };
    const revisionNow = async () => Number.parseInt((await runtimeFetch(`/api/library-revision?project=default`)).revision, 10);
    const deltaCount = async (since) => (await runtimeFetch(`/api/library-changes?project=default&since=${since}`)).changes.length;
    const loadedNow = () => evaluate(client, "Number(document.querySelector('.asset-grid')?.dataset.loadedAssets||0)");
    const scrollTopNow = () => evaluate(client, "Math.round(document.querySelector('.asset-grid')?.scrollTop||0)");
    const drainRequests = () => evaluate(client, "(()=>{const log=window.__mosaReqLog;window.__mosaReqLog=[];return JSON.stringify(log)})()").then(JSON.parse);
    const waitForPage = async (expression, description, timeoutMs = 10000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(client, expression)) return;
        await wait(80);
      }
      throw new Error(`Timed out waiting for ${description}`);
    };

    const scenarios = [];
    qaResult.incrementalScenarios = scenarios;
    let windowCollapses = 0;
    // Expected loaded-window size per scenario. The React gallery re-fetches
    // the SAME window it had (top-of-order, capped at the previous size), so
    // add/trash/restore reshuffle the window's contents without changing its
    // size; only a real node collapse (stack create) shrinks it. Anything far
    // below the expectation means the view collapsed back to the first page.
    const EXPECTED_LOADED_DELTA = {
      "external-ingest-add": 0,
      "favorite": 0,
      "trash-delete": 0,
      "restore": 0,
      "stack-create": 0,
      "stack-cover-change": 0,
      // Deleting one member dissolves the stack, and the survivor re-enters
      // the window as a plain node: the window size is preserved.
      "stack-member-delete": 0,
    };
    const runScenario = async (name, mutate, waitExpression, waitDescription) => {
      await drainRequests();
      const revisionBefore = await revisionNow();
      const loadedBefore = await loadedNow();
      const scrollBefore = await scrollTopNow();
      const startedAt = Date.now();
      // A wait function receives the in-page request-log baseline so a
      // scenario can wait for "the SSE-driven refetch has run" even when the
      // change itself is invisible in the windowed DOM (window-tail stacks).
      const requestBaseline = await evaluate(client, "(window.__mosaReqLog||[]).length");
      const expression = typeof waitExpression === "function" ? waitExpression(requestBaseline) : waitExpression;
      const result = await mutate();
      // The DOM/refetch wait is authoritative: every mutation here is
      // external (runtime API), so the UI can only reflect it after the
      // SSE-driven window refresh has landed.
      if (expression) await waitForPage(expression, waitDescription);
      const elapsedMs = Date.now() - startedAt;
      await wait(400);
      const requests = await drainRequests();
      const revisionAfter = await revisionNow();
      const loadedAfter = await loadedNow();
      const scrollAfter = await scrollTopNow();
      const deltas = revisionAfter > revisionBefore ? await deltaCount(revisionBefore) : 0;
      const pageRequests = requests.filter((entry) => entry.url.includes("/api/assets?") || entry.url.includes("asset-stacks")).length;
      const expectedLoaded = loadedBefore + (EXPECTED_LOADED_DELTA[name] ?? 0);
      const collapsed = loadedAfter < expectedLoaded - 50;
      if (collapsed) windowCollapses += 1;
      scenarios.push({
        name, revisionBefore, revisionAfter, deltaCount: deltas, requestCount: requests.length,
        pageRequests, loadedBefore, loadedAfter, expectedLoaded, scrollBefore, scrollAfter,
        windowCollapsed: collapsed, elapsedMs, ...result,
      });
      assert.equal(loadedAfter, expectedLoaded, `${name}: loaded window changed unexpectedly`);
    };

    const liveId = `perf-live-${Date.now()}`;

    // 外部 ingest 走正规 staging 流程（desktop runtime 只信任自己的 staging 根）。
    const liveAssetBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const stageLiveAsset = async () => {
      const staged = await fetch(`http://127.0.0.1:${desktopPort}/api/import/stage`, {
        method: "POST",
        headers: {
          "x-mosa-file-name": encodeURIComponent(`${liveId}.png`),
          "content-type": "application/octet-stream",
          "x-mosa-client-token": QA_CLIENT_TOKEN,
        },
        body: liveAssetBytes,
      });
      const stagedBody = await staged.json();
      assert.ok(staged.ok, `staging failed: ${staged.status} ${JSON.stringify(stagedBody)}`);
      return stagedBody.path;
    };

    await runScenario(
      "external-ingest-add",
      async () => {
        const stagedPath = await stageLiveAsset();
        const created = await runtimeFetch("/api/assets/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ assetId: liveId, imagePath: stagedPath, prompt: "live incremental ingest" }),
        });
        return { id: created.asset?.id };
      },
      `document.querySelector('.asset-grid > .asset-card:not(.asset-card-virtual-placeholder)')?.dataset.assetId === '${liveId}'`,
      "the ingested card to appear at the gallery top",
    ).then(() => assert.equal((scenarios.at(-1)).windowCollapsed, false, "single ingest must not collapse the loaded window"));

    await runScenario(
      "favorite",
      async () => {
        const toggled = await runtimeFetch(`/api/assets/default/${liveId}/favorite`, { method: "POST" });
        return { favorite: toggled.asset?.favorite };
      },
      `document.querySelector('.asset-grid > .asset-card[data-asset-id="${liveId}"] .favorite-mark') !== null`,
      "the card star to flip to favorited",
    ).then(() => assert.equal((scenarios.at(-1)).windowCollapsed, false, "favorite must not collapse the loaded window"));

    await runScenario(
      "trash-delete",
      () => runtimeFetch("/api/assets/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "trash", projectId: "default", assetIds: [liveId] }),
      }),
      `document.querySelector('.asset-grid > .asset-card[data-asset-id="${liveId}"]') === null`,
      "the deleted card to leave the gallery top",
    ).then(() => assert.equal((scenarios.at(-1)).windowCollapsed, false, "delete must not collapse the loaded window"));

    await runScenario(
      "restore",
      async () => {
        const restored = await runtimeFetch(`/api/assets/default/${liveId}/restore`, { method: "POST" });
        return { id: restored.asset?.id };
      },
      `document.querySelector('.asset-grid > .asset-card[data-asset-id="${liveId}"]') !== null`,
      "the restored card to re-enter the gallery top",
    ).then(() => assert.equal((scenarios.at(-1)).windowCollapsed, false, "restore must not collapse the loaded window"));

    // 深处 Stack 场景：成员都在已加载窗口内但不在视口 DOM 中，度量纯数据增量。
    const stackMembers = (await runtimeFetch("/api/assets?project=default&sort=oldest&limit=2")).assets.map((asset) => asset.id);
    assert.equal(stackMembers.length, 2);
    let createdStackId = "";
    await runScenario(
      "stack-create",
      async () => {
        const created = await runtimeFetch("/api/asset-stacks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: "default", assetIds: stackMembers, coverAssetId: stackMembers[0] }),
        });
        createdStackId = created.stack?.id || "";
        return { stackId: createdStackId };
      },
      // The collapsed members sit at the window tail: assert the SSE refetch
      // ran and the window survived it (the exact node math is server-checked
      // below).
      (baseline) => `(window.__mosaReqLog||[]).length > ${baseline}`,
      "the SSE refetch to run after the stack creation",
    ).then(async () => {
      assert.equal((scenarios.at(-1)).windowCollapsed, false, "stack creation must not collapse the loaded window");
      const summary = await runtimeFetch(`/api/asset-stacks/${encodeURIComponent(createdStackId)}?project=default`);
      assert.equal(summary.stack?.cover_asset_id, stackMembers[0], "stack created with the seeded cover");
    });
    assert.ok(createdStackId, "stack id returned by creation");

    await runScenario(
      "stack-cover-change",
      () => runtimeFetch(`/api/asset-stacks/${encodeURIComponent(createdStackId)}/order`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: "default", assetIds: [stackMembers[1], stackMembers[0]] }),
      }),
      (baseline) => `(window.__mosaReqLog||[]).length > ${baseline}`,
      "the SSE refetch to run after the cover reorder",
    ).then(async () => {
      assert.equal((scenarios.at(-1)).windowCollapsed, false, "cover change must not collapse the loaded window");
      const summary = await runtimeFetch(`/api/asset-stacks/${encodeURIComponent(createdStackId)}?project=default`);
      assert.equal(summary.stack?.cover_asset_id, stackMembers[1], "server anchor follows the reorder");
    });

    await runScenario(
      "stack-member-delete",
      () => runtimeFetch("/api/assets/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "trash", projectId: "default", assetIds: [stackMembers[1]] }),
      }),
      (baseline) => `(window.__mosaReqLog||[]).length > ${baseline}`,
      "the SSE refetch to run after the member deletion",
    ).then(() => assert.equal((scenarios.at(-1)).windowCollapsed, false, "member deletion must not collapse the loaded window"));

    // SSE 实时性场景：变更发出后，SSE 驱动的 UI 反馈必须在 5 秒内出现
    //（对应旧版的 resume 对账 5s 预算；React 的实时路径是 SSE 事件）。
    const sseStartedAt = Date.now();
    const favoriteFlip = await runtimeFetch(`/api/assets/default/${liveId}/favorite`, { method: "POST" });
    assert.equal(typeof favoriteFlip.asset?.favorite, "boolean");
    await waitForPage(
      `document.querySelector('.asset-grid > .asset-card[data-asset-id="${liveId}"] .favorite-mark') ${favoriteFlip.asset?.favorite ? "!" : "="}== null`,
      "the SSE-driven favorite flip to reach the UI",
      5000,
    );
    const sseElapsedMs = Date.now() - sseStartedAt;
    assert.ok(sseElapsedMs < 5000, `SSE-driven refresh took ${sseElapsedMs}ms`);
    scenarios.push({ name: "sse-refresh-latency", elapsedMs: sseElapsedMs });

    // The main failure report is a real macOS window that appears frozen
    // under a 4,249-item Library. Assert mouse input reaches React even AFTER
    // repeated SSE refreshes. Unlike element.click(), CDP uses browser hit
    // testing and pointer dispatch; physical OS mouse acceptance is separate.
    assert.equal(await loadedNow(), ASSET_COUNT, "the full loaded gallery must remain available before pointer QA");
    await clickThroughChromium(client, ".sidebar .user-button");
    await waitForPage("Boolean(document.querySelector('.settings-modal'))", "settings open via browser mouse input");
    await clickThroughChromium(client, ".settings-modal .modal-close");
    try {
      await waitForPage("!document.querySelector('.settings-modal')", "settings close via browser mouse input");
    } catch (error) {
      const diagnosis = await evaluate(client, `(() => {
        const close=document.querySelector('.settings-modal .modal-close');
        const b=close?.getBoundingClientRect();
        const x=b ? Math.round(b.left+b.width/2) : -1;
        const y=b ? Math.round(b.top+b.height/2) : -1;
        return { close:!!close, rect:b ? { x:b.x,y:b.y,width:b.width,height:b.height } : null,
          target:document.elementFromPoint(x,y)?.outerHTML.slice(0,260),
          modalCount:document.querySelectorAll('.settings-modal').length,
          bodyText:document.body.innerText.slice(0,240) };
      })()`);
      throw new Error(`${error.message}; pointer diagnosis=${JSON.stringify(diagnosis)}`);
    }
    await clickThroughChromium(client, ".search input");
    await waitForPage("document.activeElement === document.querySelector('.search input')", "search focus via browser mouse input");
    await client.send("Input.insertText", { text: "scale-pointer-test" });
    await waitForPage("document.querySelector('.search input')?.value === 'scale-pointer-test'", "search input via Chromium");
    qaResult.cdpPointerInputAtScale = true;

    qaResult.windowCollapses = windowCollapses;
    assert.equal(windowCollapses, 0, `ordinary library changes must never collapse the loaded window (saw ${windowCollapses})`);
    console.log("INCREMENTAL_SCENARIOS");
    console.log(JSON.stringify(scenarios, null, 2));
  } finally {
    client?.close();
    if (child?.exitCode === null) {
      const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
      child.kill("SIGTERM");
      await Promise.race([exited, wait(2000)]);
      if (child.exitCode === null) {
        const forcedExit = new Promise((resolveExit) => child.once("exit", resolveExit));
        child.kill("SIGKILL");
        await Promise.race([forcedExit, wait(2000)]);
      }
    }
    await Promise.allSettled([
      rm(libraryDir, { recursive: true, force: true }),
      rm(userDataDir, { recursive: true, force: true }),
      rm(projectRoot, { recursive: true, force: true }),
    ]);
  }
}

let exitCode = 0;
try {
  await main();
  qaResult.status = "pass";
} catch (error) {
  qaResult.status = "fail";
  qaResult.error = { message: error?.message || String(error), stack: error?.stack || null };
  console.error(error);
  exitCode = 1;
}
try {
  await writeResultFile();
} catch (error) {
  console.error(`[gallery-qa] failed to write result file ${RESULT_FILE}: ${error?.message || error}`);
  exitCode = 1;
}
console.log(`[gallery-qa] result: ${qaResult.status} (exit ${exitCode})${RESULT_FILE ? `, verdict file: ${RESULT_FILE}` : ""}`);
process.exitCode = exitCode;
