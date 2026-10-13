import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";

// Real Chromium layout against the GravityPort React gallery, isolated
// synthetic assets. MOSA_RESIZE_QA_EXECUTABLE also exercises an installed/
// packaged application.
//
// Geometry contract under resize (unchanged from the previous gallery):
// equal implicit tracks, equal card widths, no overlapping cards in a
// column, aspect ratios preserved, decoded images in the viewport, no
// unhydrated placeholder visible, no horizontal overflow. The expected
// column counts follow the React design's responsive bands
// (web/gravityport/src/index.css): user column setting above 720px
// (default 5), 3 columns at ≤720px, 2 columns at ≤480px.
const root = resolve(import.meta.dirname, "..");
const scratch = await mkdtemp(join(tmpdir(), "mosa-resize-qa-"));
const libraryDir = join(scratch, "library");
const userData = join(scratch, "user-data");
const executable = process.env.MOSA_RESIZE_QA_EXECUTABLE || resolve(root,
  process.platform === "darwin" ? "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
    : process.platform === "win32" ? "node_modules/electron/dist/electron.exe" : "node_modules/electron/dist/electron");
const result = { status: "running", cases: [] };
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
let child;
let client;
let mainClient;
let output = "";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function seed() {
  const projectRoot = join(scratch, "project");
  const images = join(projectRoot, "generated-images");
  await mkdir(images, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir, initializeFreshLibrary: true });
  try {
    const dimensions = [[300, 300], [300, 534], [534, 300], [300, 800], [400, 300], [300, 450]];
    for (let index = 0; index < dimensions.length; index += 1) {
      const [width, height] = dimensions[index];
      const imagePath = join(images, `ratio-${index}.png`);
      await sharp({ create: { width, height, channels: 3, background: { r: 50 + index * 30, g: 100, b: 180 } } }).png().toFile(imagePath);
      await store.createAsset({ assetId: `resize-${index}`, imagePath, prompt: `resize fixture ${index}`, business_fields: { width, height } });
    }
  } finally { store.close(); }
  const database = new Database(join(libraryDir, "mosa.db"));
  try {
    // Geometry QA needs decoded mixed-ratio media, not asynchronous derivative jobs.
    database.prepare("DELETE FROM derivative_jobs").run();
    const templates = database.prepare("SELECT * FROM assets ORDER BY id").all();
    const previews = await Promise.all(templates.map((item) => sharp(item.original_path).webp({ lossless: true }).toBuffer()));
    // 360 assets: past the React gallery's mount-all threshold (320), so the
    // windowed DOM (placeholders + spacers) is what every snapshot measures.
    for (let index = 0; index < 360; index += 1) {
      await Promise.all([store.thumbnailsDir(), store.mediumsDir(), store.previewsDir()].map((directory) =>
        writeFile(join(directory, `resize-${index}.webp`), previews[index % templates.length])));
    }
    const columns = Object.keys(templates[0]);
    const insert = database.prepare(`INSERT INTO assets (${columns.join(",")}) VALUES (${columns.map((key) => `@${key}`).join(",")})`);
    const updatePaths = database.prepare("UPDATE assets SET thumbnail_path = ?, medium_path = ?, preview_path = ? WHERE id = ?");
    database.transaction(() => {
      for (let index = 6; index < 360; index += 1) {
        insert.run({ ...templates[index % templates.length], id: `resize-${index}`, asset: `resize-${index}.png` });
      }
      for (let index = 0; index < 360; index += 1) {
        updatePaths.run(...[store.thumbnailsDir(), store.mediumsDir(), store.previewsDir()].map((directory) => join(directory, `resize-${index}.webp`)), `resize-${index}`);
      }
    })();
  } finally { database.close(); }
}

async function connect() {
  const cdpPort = await freePort();
  const desktopPort = await freePort();
  const inspectPort = await freePort();
  child = spawn(executable, [
    `--remote-debugging-port=${cdpPort}`, `--inspect=${inspectPort}`, `--user-data-dir=${userData}`,
    ...(process.env.MOSA_RESIZE_QA_EXECUTABLE ? [] : [root]),
  ], { cwd: root, env: { ...process.env, MOSA_LIBRARY_DIR: libraryDir, MOSA_USER_DATA: userData,
    MOSA_RUNTIME_MODE: "qa", MOSA_QA_RUN: "1", MOSA_DESKTOP_PORT: String(desktopPort),
    MOSA_DISABLE_BRIDGES: "cowart,cowartDiscovery,codex,grok" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-6000); });
  child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-6000); });
  await once(child, "spawn");
  let target;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Electron exited: ${output}`);
    try {
      const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((response) => response.json());
      target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (target) break;
    } catch {}
    await wait(100);
  }
  assert.ok(target, `No renderer: ${output}`);
  const mainTargets = await fetch(`http://127.0.0.1:${inspectPort}/json/list`).then((response) => response.json());
  mainClient = await createClient(mainTargets[0].webSocketDebuggerUrl);
  return createClient(target.webSocketDebuggerUrl);
}

async function createClient(url) {
  const socket = new WebSocket(url);
  await new Promise((done, reject) => {
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const pending = new Map();
  let sequence = 0;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.done(message.result);
  });
  return { close: () => socket.close(), send(method, params = {}) {
    return new Promise((done, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      pending.set(id, { done, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  } };
}

async function resizeWindow(width) {
  const response = await mainClient.send("Runtime.evaluate", { expression:
    `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(root, "package.json"))})('electron').BrowserWindow.getAllWindows()[0].setSize(${width}, 780)`,
  });
  assert.ok(!response.exceptionDetails, response.exceptionDetails?.exception?.description);
}

async function clickSelectOption(label, optionText) {
  const opened = await evaluate(`(() => {
    const trigger = document.querySelector('.toolbar-select[aria-label="' + ${JSON.stringify(label)} + '"]');
    if (!trigger) return false;
    trigger.click();
    return true;
  })()`);
  assert.ok(opened, `toolbar select ${label} found`);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await evaluate(`(() => {
      const option = [...document.querySelectorAll('.toolbar-select-menu [role="option"]')]
        .find((node) => node.textContent.trim() === ${JSON.stringify(optionText)});
      if (!option) return false;
      option.click();
      return true;
    })()`)) return;
    await wait(100);
  }
  throw new Error(`option ${optionText} not found in ${label}`);
}

async function evaluate(expression) {
  const response = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  assert.ok(!response.exceptionDetails, response.exceptionDetails?.exception?.description);
  return response.result?.value;
}

async function snapshot(label) {
  await wait(600);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await evaluate("[...document.querySelectorAll('.asset-grid img.black-image')].some(img => img.naturalWidth > 0)")) break;
    await wait(100);
  }
  const metrics = await evaluate(`(() => {
    const grid = document.querySelector('.asset-grid');
    const bounds = grid.getBoundingClientRect();
    const tracks = getComputedStyle(grid).gridTemplateColumns.split(/\\s+/).map(Number.parseFloat);
    const cards = [...grid.querySelectorAll(':scope > .asset-card:not(.asset-card-virtual-placeholder)')];
    const visible = cards.filter(card => {
      const rect = card.getBoundingClientRect();
      // On mobile the grid can exceed the viewport. Offscreen content boxes
      // are estimates, not painted cards; measure the actual visible area.
      return rect.bottom > Math.max(0, bounds.top) && rect.top < Math.min(innerHeight, bounds.bottom);
    });
    const media = visible.flatMap(card => [...card.querySelectorAll('img.black-image')]).filter(img => img.naturalWidth > 0);
    const aspectErrors = visible.map(card => {
      const rect = card.getBoundingClientRect();
      // The card carries its media's aspect ratio as an inline contract
      // ("width / height"); the rendered box must honor it.
      const ratio = String(card.style.aspectRatio || '').split('/').map(Number.parseFloat);
      if (!(ratio[0] > 0) || !(ratio[1] > 0)) return 0;
      return Math.abs(rect.height - rect.width * ratio[1] / ratio[0]);
    });
    // The React grid uses implicit auto-placement, so same-column cards share
    // a left edge; vertical overlap inside a column is a layout defect.
    const columnOf = (card) => Math.round(card.getBoundingClientRect().left);
    const rects = visible.map(card => {
      const rect = card.getBoundingClientRect();
      return { column: columnOf(card), top: rect.top, bottom: rect.bottom, width: rect.width };
    });
    let overlaps = 0;
    for (const rect of rects) if (rects.some(other => other !== rect && other.column === rect.column && other.top > rect.top && other.top < rect.bottom - 1)) overlaps++;
    const placeholders = [...grid.querySelectorAll(':scope > .asset-card-virtual-placeholder')];
    return { width: innerWidth, loaded: Number(grid.dataset.loadedAssets || 0), tracks,
      visible: visible.length, images: media.length, overlaps, maxAspectError: Math.max(0, ...aspectErrors),
      widthSpread: rects.length ? Math.max(...rects.map(r => r.width)) - Math.min(...rects.map(r => r.width)) : null,
      overflow: grid.scrollWidth - grid.clientWidth,
      visiblePlaceholders: placeholders.filter(card => { const rect = card.getBoundingClientRect(); return rect.bottom > Math.max(0, bounds.top) && rect.top < Math.min(innerHeight, bounds.bottom); }).length };
  })()`);
  result.cases.push({ label, ...metrics });
  console.log(JSON.stringify({ label, ...metrics }));
  if (metrics.overlaps) console.log(await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.asset-grid > .asset-card')].map(card => ({ id: card.dataset.assetId, left: card.getBoundingClientRect().left, top: card.getBoundingClientRect().top, bottom: card.getBoundingClientRect().bottom, html: card.querySelector('img')?.outerHTML }));
    return cards.filter(card => cards.some(other => other !== card && other.left === card.left && other.top > card.top && other.top < card.bottom - 1)).slice(0, 4);
  })()`));
  if (!metrics.images) console.log(await evaluate("[...document.querySelectorAll('.asset-grid > .asset-card')].slice(0,2).map(node=>node.outerHTML)"));
  // React design bands: ≤480px → 2 columns, ≤720px → 3, otherwise the user
  // column setting (default 5).
  const expected = metrics.width <= 480 ? 2 : metrics.width <= 720 ? 3 : 5;
  assert.equal(metrics.tracks.length, expected, `${label}: implicit columns`);
  assert.ok(Math.max(...metrics.tracks) - Math.min(...metrics.tracks) <= 1, `${label}: unequal tracks`);
  assert.ok(metrics.widthSpread !== null && metrics.widthSpread <= 1, `${label}: unequal card widths`);
  assert.ok(metrics.images > 0, `${label}: no visible decoded images`);
  assert.ok(metrics.maxAspectError < 1.1, `${label}: image aspect ratio changed`);
  assert.equal(metrics.overlaps, 0, `${label}: cards overlap`);
  assert.equal(metrics.visiblePlaceholders, 0, `${label}: unhydrated visible cards`);
  assert.ok(metrics.overflow <= 1, `${label}: horizontal overflow`);
}

try {
  await seed();
  client = await connect();
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await evaluate("document.querySelectorAll('.asset-grid > .asset-card').length > 5")) break;
    await wait(100);
  }
  for (const width of [1512, 1400, 1280, 1279, 1052, 960, 1279, 1280, 1512]) {
    await resizeWindow(width);
    await snapshot(`native-${width}`);
  }
  // The native App enforces its own minimum width; smaller viewports are
  // driven through device-metrics emulation, including the 3/2-column bands.
  for (const width of [767, 640, 500, 400, 480, 768, 1279, 1280]) {
    await client.send("Emulation.setDeviceMetricsOverride", { width, height: 720, deviceScaleFactor: 1, mobile: false });
    await snapshot(`web-${width}`);
  }
  await client.send("Emulation.clearDeviceMetricsOverride");
  for (let step = 0; step < 60; step += 1) {
    const loaded = await evaluate("(()=>{const grid=document.querySelector('.asset-grid');grid.scrollTop=grid.scrollHeight;grid.dispatchEvent(new Event('scroll'));return Number(grid.dataset.loadedAssets||0)})()");
    if (loaded === 360) break;
    await wait(100);
  }
  assert.equal(await evaluate("Number(document.querySelector('.asset-grid').dataset.loadedAssets)"), 360);
  for (const width of [1512, 1052, 960, 1512]) {
    await resizeWindow(width);
    await snapshot(`scrolled-${width}`);
  }
  await evaluate("document.querySelector('.asset-grid').scrollTop = 0");
  for (const width of [1279, 1280, 960, 1512, 1052, 1512]) {
    await resizeWindow(width);
  }
  await snapshot("rapid-resize-return-top");

  // ── Mixed-ratio reorder: switching the sort rebuilds the row model for the
  // same assets in a different order (cache-signature regression). ──
  await clickSelectOption("排序", "名称排序");
  for (let step = 0; step < 60; step += 1) {
    const loaded = await evaluate("(()=>{const grid=document.querySelector('.asset-grid');grid.scrollTop=grid.scrollHeight;grid.dispatchEvent(new Event('scroll'));return Number(grid.dataset.loadedAssets||0)})()");
    if (loaded === 360) break;
    await wait(100);
  }
  assert.equal(await evaluate("Number(document.querySelector('.asset-grid').dataset.loadedAssets)"), 360);
  const firstAfterSort = await evaluate("document.querySelector('.asset-grid > .asset-card')?.dataset.assetId || ''");
  assert.notEqual(firstAfterSort, "resize-0", "name sort must actually reorder the mixed-ratio set");
  await snapshot("sorted-name-windowed");

  // ── Preview -> resize: the preview unmounts the grid; after closing it the
  // size observer must be re-bound, or these resizes go unobserved and the
  // windowed DOM drifts out of the viewport. ──
  await evaluate("(()=>{const card=document.querySelector('.asset-grid > .asset-card:not(.asset-card-virtual-placeholder)');card.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));return true})()");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await evaluate("Boolean(document.querySelector('img.viewer-image') || document.querySelector('.viewer-stage'))")) break;
    await wait(100);
  }
  assert.ok(await evaluate("Boolean(document.querySelector('.workspace.preview-open'))"), "preview opened");
  await resizeWindow(1052);
  await resizeWindow(1400);
  await wait(400);
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await evaluate("!document.querySelector('.workspace.preview-open') && document.querySelectorAll('.asset-grid > .asset-card').length > 0")) break;
    await wait(100);
  }
  await resizeWindow(960);
  await snapshot("after-preview-close-960");
  await resizeWindow(1512);
  await snapshot("after-preview-close-1512");
  await resizeWindow(1280);
  await snapshot("after-preview-close-1280");
  result.status = "PASS";
} catch (error) {
  result.status = "FAIL";
  result.error = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  client?.close();
  mainClient?.close();
  if (child?.pid && child.exitCode === null) {
    child.kill("SIGTERM");
    for (let attempt = 0; attempt < 50 && child.exitCode === null && child.signalCode === null; attempt += 1) await wait(100);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
  }
  if (process.env.MOSA_RESIZE_QA_RESULT) await writeFile(process.env.MOSA_RESIZE_QA_RESULT, JSON.stringify(result, null, 2));
  await rm(scratch, { recursive: true, force: true });
}
