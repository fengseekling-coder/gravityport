// GravityPort React UI flow (task 465): Lovart edited image automatically links
// under its in-library Lovart base image in the Inspector Version Tree, can be
// deleted by the user, and stays unlinked on re-capture.
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import sharp from "sharp";
import { launchDesktopGui } from "../desktop-gui-launcher.mjs";
import { ensureElectronExecutablePath } from "../desktop-runtime-paths.mjs";
import { signalProcessTree } from "../process-tree.mjs";

export const name = "lovart-parent-link";
export const description = "Lovart Fake01 -> ref -> Fake02 via /api/ingest/web-capture -> Inspector 版本树 shows 初始生成 + indented 改自上一个素材 with 删除关系 on both Fake02 and Fake01 -> delete relation -> re-capture Fake02 stays unlinked";

const CAPTURE_TOKEN = "mosa_e2e_lovart_parent_link_token";
const ROOT_DIR = resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function noiseJpeg(seed, width = 640, height = 900) {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * (37 + seed) + (i % 251)) & 255;
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
}

async function extractFixturePayloads() {
  const extDir = join(ROOT_DIR, "extensions", "chatgpt-web-capture");
  const providerPolicySource = await readFile(join(extDir, "provider-policy.js"), "utf8");
  const providerLovartSource = await readFile(join(extDir, "provider-lovart.js"), "utf8");
  const historyNew = await readFile(join(ROOT_DIR, "test", "fixtures", "lovart-history-new.json"), "utf8");

  const sent = [];
  const windowMessageHandlers = [];
  const timers = [];
  let nowMs = Date.parse("2026-11-22T12:00:00Z");
  let nextId = 1;
  const addTimer = (fn, ms, repeat) => {
    const id = nextId++;
    timers.push({ id, at: nowMs + Math.max(0, Number(ms) || 0), delay: Math.max(0, Number(ms) || 0), repeat, fn, cancelled: false });
    return id;
  };
  const cancelTimer = (id) => {
    const item = timers.find((t) => t.id === id);
    if (item) item.cancelled = true;
  };
  const flush = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  };
  const advance = async (ms) => {
    await flush();
    const target = nowMs + ms;
    for (;;) {
      const due = timers.filter((t) => !t.cancelled && t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      nowMs = Math.max(nowMs, due.at);
      if (due.repeat) due.at += Math.max(1, due.delay);
      else due.cancelled = true;
      due.fn();
      await flush();
    }
    nowMs = target;
    await flush();
  };

  const localStore = new Map([["lovartAutoCaptureBaselineAtV1", Date.parse("2026-11-01T00:00:00Z")]]);
  const sandbox = {
    URL,
    Date: class FakeDate extends Date {
      constructor(...args) { super(...(args.length ? args : [nowMs])); }
      static now() { return nowMs; }
    },
    chrome: {
      runtime: {
        id: "e2e-lovart-ext",
        sendMessage: (message) => {
          sent.push(message);
          if (message.type === "mosa.getSettings") return Promise.resolve({ ok: true, settings: { autoCapture: true } });
          return Promise.resolve({ ok: true, result: { status: "imported" } });
        },
        onMessage: { addListener: () => {} },
      },
      storage: {
        local: {
          get: async (query) => {
            const out = {};
            for (const [k, v] of Object.entries(query || {})) out[k] = localStore.has(k) ? localStore.get(k) : v;
            return out;
          },
          set: async (patch) => {
            for (const [k, v] of Object.entries(patch)) localStore.set(k, v);
          },
        },
        onChanged: { addListener: () => {} },
      },
    },
    document: {
      getElementById: () => null,
      documentElement: {},
      body: { appendChild() {} },
      createElement: () => ({ style: {}, setAttribute() {}, replaceChildren() {}, hidden: false }),
      createTextNode: (text) => ({ text }),
    },
    location: { href: "https://www.lovart.ai/canvas?projectId=x", origin: "https://www.lovart.ai" },
    console: { info() {}, log() {}, warn() {} },
    setTimeout: (fn, ms) => addTimer(fn, ms, false),
    clearTimeout: cancelTimer,
    setInterval: (fn, ms) => addTimer(fn, ms, true),
    clearInterval: cancelTimer,
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = (type, fn) => { if (type === "message") windowMessageHandlers.push(fn); };
  sandbox.window.postMessage = () => {};
  vm.createContext(sandbox);
  vm.runInContext(providerPolicySource, sandbox, { filename: "provider-policy.js" });
  vm.runInContext(providerLovartSource, sandbox, { filename: "provider-lovart.js" });

  await advance(0);
  const port = {
    listeners: [],
    addEventListener(type, fn) { if (type === "message") this.listeners.push(fn); },
    start() {},
  };
  for (const fn of windowMessageHandlers) {
    fn({ origin: "https://www.lovart.ai", data: { source: "mosa-lovart-hook", type: "hook-port" }, ports: [port] });
  }
  for (const fn of port.listeners) fn({ data: { type: "lovart-api-response", text: historyNew } });
  await advance(400);

  const ingests = sent.filter((m) => m.type === "mosa.ingest").map((m) => m.payload);
  const fake01 = ingests.find((p) => !p.isReference && p.providerAssetId === "Fake01ArtifactId");
  const ref01 = ingests.find((p) => p.isReference && p.providerAssetId === "ref:Fake01ArtifactId");
  const fake02 = ingests.find((p) => !p.isReference && p.providerAssetId === "Fake02ArtifactId");
  if (!fake01 || !ref01 || !fake02) throw new Error("lovart-parent-link: failed to extract Fake01/ref/Fake02 payloads from fixture");
  return { fake01, ref01, fake02 };
}

function toIngestBody(extPayload, imageBytes) {
  const body = {
    provider: extPayload.provider,
    prompt: extPayload.prompt || "",
    prompt_status: extPayload.promptStatus || (extPayload.prompt ? "user-message" : "not-available"),
    user_message: extPayload.userMessage || "",
    prompt_source: extPayload.promptSource || "",
    generation_status: extPayload.generationStatus || "completed",
    is_reference: Boolean(extPayload.isReference),
    mediaKind: "image",
    mimeType: "image/jpeg",
    imageBase64: imageBytes.toString("base64"),
    width: extPayload.width || 640,
    height: extPayload.height || 900,
    pageUrl: extPayload.pageUrl || "https://www.lovart.ai/canvas?projectId=x",
    sourceMediaUrl: extPayload.imageUrl || "",
    finalMediaUrl: extPayload.imageUrl || "",
    conversationId: extPayload.conversationId || "",
    messageId: extPayload.messageId || "",
    generationContextId: extPayload.generationContextId || "",
    providerAssetId: extPayload.providerAssetId || "",
    model: extPayload.model || "",
    captureMode: extPayload.captureMode === "manual" ? "manual" : "automatic",
    capturedAt: extPayload.capturedAt || "2026-11-22T12:00:00.000Z",
  };
  if (Array.isArray(extPayload.referenceProviderAssetIds)) {
    body.reference_provider_asset_ids = [...extPayload.referenceProviderAssetIds];
  }
  return body;
}

async function postCapture(origin, token, body) {
  const response = await fetch(`${origin}/api/ingest/web-capture`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`web-capture failed (${response.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

export async function run(ctx) {
  await ctx.prepare();
  const previousCaptureToken = process.env.MOSA_WEB_CAPTURE_TOKEN;
  process.env.MOSA_WEB_CAPTURE_TOKEN = CAPTURE_TOKEN;
  const server = await ctx.startServer();
  try {
    const { fake01, ref01, fake02 } = await extractFixturePayloads();
    const img01 = await noiseJpeg(71);
    const img02 = await noiseJpeg(72);

    const res01 = await postCapture(server.origin, CAPTURE_TOKEN, {
      ...toIngestBody(fake01, img01),
      capturedAt: "2026-11-22T12:00:00.000Z",
    });
    await postCapture(server.origin, CAPTURE_TOKEN, {
      ...toIngestBody(ref01, img01),
      capturedAt: "2026-11-22T12:00:30.000Z",
    });
    const res02 = await postCapture(server.origin, CAPTURE_TOKEN, {
      ...toIngestBody(fake02, img02),
      capturedAt: "2026-11-22T12:01:00.000Z",
    });

    const fake01Id = res01.asset?.id || res01.assetId;
    const fake02Id = res02.asset?.id || res02.assetId;
    if (!fake01Id || !fake02Id) {
      throw new Error(`lovart-parent-link: missing asset ids ${JSON.stringify({ res01, res02 })}`);
    }

    // Optional light/dark CDP screenshots before deleting the relation.
    const shotDir = process.env.MOSA_465_SCREENSHOT_DIR || "";
    let screenshots = null;
    if (shotDir) {
      screenshots = await captureInspectorScreenshots(ctx, shotDir, { fake01, ref01, fake02, img01, img02 });
    }

    const stage1 = await ctx.runInPage(server, stage1Source({ fake01Id, fake02Id }));
    const problems = [];
    if (stage1?.fake02Rows?.length !== 2) problems.push(`fake02 rows=${JSON.stringify(stage1?.fake02Rows)}`);
    if (!stage1?.fake02Rows?.[0]?.text?.includes("初始生成")) problems.push(`fake02 row0 missing 初始生成: ${JSON.stringify(stage1?.fake02Rows?.[0])}`);
    if (stage1?.fake02Rows?.[0]?.indent !== 0) problems.push(`fake02 row0 indent=${stage1?.fake02Rows?.[0]?.indent}`);
    if (!stage1?.fake02Rows?.[1]?.text?.includes("改自上一个素材")) problems.push(`fake02 row1 missing 改自上一个素材: ${JSON.stringify(stage1?.fake02Rows?.[1])}`);
    if (!(stage1?.fake02Rows?.[1]?.indent > 0)) problems.push(`fake02 row1 not indented: ${JSON.stringify(stage1?.fake02Rows?.[1])}`);
    if (!stage1?.hasDeleteButton) problems.push("missing 删除关系 button");
    if (stage1?.hasLockedCopy) problems.push("unexpected 已由来源平台验证，无法修改 copy");
    if (stage1?.fake01Rows?.length !== 2) problems.push(`fake01 rows=${JSON.stringify(stage1?.fake01Rows)}`);
    if (!stage1?.deletedRelation) problems.push("relation did not disappear after clicking 删除关系");
    if (problems.length) throw new Error(`lovart-parent-link stage1: ${problems.join("; ")}`);

    // Re-ingest Fake02 after deletion -> relation must NOT come back.
    await postCapture(server.origin, CAPTURE_TOKEN, toIngestBody(fake02, img02));
    const stage2 = await ctx.runInPage(server, stage2Source({ fake02Id }));
    if (stage2?.relationEditorCount !== 0 || stage2?.treeRowCount !== 1) {
      throw new Error(`lovart-parent-link stage2 (after re-ingest): ${JSON.stringify(stage2)}`);
    }

    return {
      fake01Id,
      fake02Id,
      fake02Rows: stage1.fake02Rows,
      fake01Rows: stage1.fake01Rows,
      relationEditorText: stage1.relationEditorText,
      deletedRelation: stage1.deletedRelation,
      afterReingestRelationCount: stage2.relationEditorCount,
      afterReingestTreeRowCount: stage2.treeRowCount,
      ...(screenshots ? { screenshots } : {}),
    };
  } finally {
    if (previousCaptureToken === undefined) delete process.env.MOSA_WEB_CAPTURE_TOKEN;
    else process.env.MOSA_WEB_CAPTURE_TOKEN = previousCaptureToken;
    await server.stop();
  }
}

function stage1Source(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      let stable = 0;
      while (Date.now() < deadline) {
        const value = check();
        if (value) { stable += 1; if (stable >= 2) return value; } else stable = 0;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label + ' | cards=' + document.querySelectorAll('.asset-card').length);
    }

    async function selectCard(assetId) {
      const card = await waitFor(() => document.querySelector('.asset-card[data-asset-id="' + assetId + '"]'), 'card ' + assetId);
      card.click();
      await waitFor(() => document.querySelector('.details .asset-title'), 'inspector for ' + assetId);
    }

    async function ensureVersionTreeExpanded() {
      const btn = await waitFor(() => {
        const heading = Array.from(document.querySelectorAll('.details .field-heading'))
          .find((el) => el.querySelector('span')?.textContent?.trim() === '版本树');
        if (!heading) return null;
        return Array.from(heading.querySelectorAll('button')).find((b) => {
          const t = (b.textContent || '').trim();
          return t === '查看' || t === '收起';
        }) || null;
      }, '版本树 查看/收起 button');
      if ((btn.textContent || '').trim() === '查看') btn.click();
    }

    function readTreeRows() {
      return Array.from(document.querySelectorAll('.details .generation-tree-row')).map((row) => {
        const ml = parseFloat(getComputedStyle(row).marginLeft || '0') || 0;
        const pl = parseFloat(getComputedStyle(row).paddingLeft || '0') || 0;
        const styleAttr = row.getAttribute('style') || '';
        const indentMatch = /--indent\\s*:\\s*(\\d+)|margin-left\\s*:\\s*(\\d+)|padding-left\\s*:\\s*(\\d+)/i.exec(styleAttr);
        const attrIndent = indentMatch ? Number(indentMatch[1] || indentMatch[2] || indentMatch[3] || 0) : 0;
        return {
          text: (row.textContent || '').replace(/\\s+/g, ' ').trim(),
          indent: attrIndent || Math.round(ml + pl),
          isCurrent: row.classList.contains('is-current'),
          style: styleAttr,
        };
      });
    }

    // 1. Select Fake02 and expand 版本树 -> 查看
    await selectCard(config.fake02Id);
    await ensureVersionTreeExpanded();
    await waitFor(() => document.querySelectorAll('.details .generation-tree-row').length === 2, '2 generation tree rows on Fake02');
    const fake02Rows = readTreeRows();
    const baseIndent = fake02Rows[0]?.indent || 0;
    const normalizedFake02Rows = fake02Rows.map((r) => ({ ...r, indent: Math.max(0, r.indent - baseIndent) }));

    const editor = await waitFor(() => {
      const editors = Array.from(document.querySelectorAll('.details .generation-relation-editor'));
      return editors.find((el) => (el.textContent || '').includes('删除关系'));
    }, 'generation-relation-editor with 删除关系');
    const relationEditorText = (editor.textContent || '').replace(/\\s+/g, ' ').trim();
    const hasDeleteButton = Array.from(editor.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === '删除关系');
    const hasLockedCopy = (editor.textContent || '').includes('已由来源平台验证，无法修改');

    // 2. Select Fake01 (click the parent row in the version tree) and verify both rows are visible
    document.querySelectorAll('.details .generation-tree-row')[0].click();
    await waitFor(() => {
      const rows = Array.from(document.querySelectorAll('.details .generation-tree-row'));
      return rows.length === 2 && rows[0].classList.contains('is-current');
    }, '2 generation tree rows on Fake01 with row 0 current');
    const fake01Rows = readTreeRows();

    // 3. Re-select Fake02 and delete the relation
    document.querySelectorAll('.details .generation-tree-row')[1].click();
    await waitFor(() => {
      const rows = Array.from(document.querySelectorAll('.details .generation-tree-row'));
      return rows.length === 2 && rows[1].classList.contains('is-current');
    }, 'Fake02 selected again');
    const delBtn = await waitFor(() => {
      const buttons = Array.from(document.querySelectorAll('.details .generation-relation-editor button'));
      return buttons.find((b) => (b.textContent || '').trim() === '删除关系');
    }, '删除关系 button on Fake02');
    window.confirm = () => true;
    delBtn.click();
    await waitFor(() => {
      const editors = Array.from(document.querySelectorAll('.details .generation-relation-editor'));
      return !editors.some((el) => (el.textContent || '').includes('删除关系'));
    }, 'relation removed after 删除关系');

    return {
      fake02Rows: normalizedFake02Rows,
      fake01Rows,
      relationEditorText,
      hasDeleteButton,
      hasLockedCopy,
      deletedRelation: true,
    };
  })()`;
}

function stage2Source(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      let stable = 0;
      while (Date.now() < deadline) {
        const value = check();
        if (value) { stable += 1; if (stable >= 2) return value; } else stable = 0;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label);
    }
    const card = await waitFor(() => document.querySelector('.asset-card[data-asset-id="' + config.fake02Id + '"]'), 'Fake02 card');
    card.click();
    await waitFor(() => document.querySelector('.details .asset-title'), 'inspector opens');
    const btn = await waitFor(() => {
      const heading = Array.from(document.querySelectorAll('.details .field-heading'))
        .find((el) => el.querySelector('span')?.textContent?.trim() === '版本树');
      if (!heading) return null;
      return Array.from(heading.querySelectorAll('button')).find((b) => {
        const t = (b.textContent || '').trim();
        return t === '查看' || t === '收起';
      }) || null;
    }, '版本树 查看/收起 button');
    if ((btn.textContent || '').trim() === '查看') btn.click();
    await waitFor(() => document.querySelectorAll('.details .generation-tree-row').length >= 1, 'tree row on Fake02 after re-ingest');
    await sleep(300);
    const relationEditorCount = Array.from(document.querySelectorAll('.details .generation-relation-editor'))
      .filter((el) => (el.textContent || '').includes('删除关系')).length;
    const treeRowCount = document.querySelectorAll('.details .generation-tree-row').length;
    return { relationEditorCount, treeRowCount };
  })()`;
}

// ---- Optional hidden-window CDP screenshot helper (runs only when MOSA_465_SCREENSHOT_DIR is set) ----

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      s.close(() => resolvePort(addr.port));
    });
  });
}

async function waitForPid(filePath, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt(await readFile(filePath, "utf8"), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {}
    await sleep(100);
  }
  throw new Error(`PID timeout: ${filePath}`);
}

async function waitForHealthFile(filePath, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(filePath, "utf8")); } catch {}
    await sleep(100);
  }
  throw new Error(`Health file timeout: ${filePath}`);
}

async function connectCdp(port, expectedUrlPrefix, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let target = null;
  while (Date.now() < deadline && !target) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const list = await res.json();
        target = list.find((e) => e.type === "page" && String(e.url || "").startsWith(expectedUrlPrefix));
      }
    } catch {}
    if (!target) await sleep(150);
  }
  if (!target?.webSocketDebuggerUrl) throw new Error(`CDP target not found on port ${port}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve: r, reject: j } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) j(new Error(msg.error.message || JSON.stringify(msg.error)));
      else r(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolveSend, rejectSend) => {
    const id = nextId++;
    pending.set(id, { resolve: resolveSend, reject: rejectSend });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const out = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (out?.exceptionDetails) throw new Error(out.exceptionDetails.text || JSON.stringify(out.exceptionDetails));
    return out?.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

async function stampDemoWatermark(pngBuffer) {
  const meta = await sharp(pngBuffer).metadata();
  const width = meta.width || 1280;
  const svg = Buffer.from(
    `<svg width="${width}" height="48" xmlns="http://www.w3.org/2000/svg">`
    + `<rect x="${Math.max(12, width - 160)}" y="10" width="144" height="30" rx="6" fill="rgba(180,35,24,0.88)"/>`
    + `<text x="${Math.max(12, width - 88)}" y="30" text-anchor="middle" font-family="PingFang SC, Helvetica, Arial, sans-serif" font-size="15" font-weight="600" fill="#ffffff">演示样本</text>`
    + `</svg>`,
  );
  return sharp(pngBuffer).composite([{ input: svg, top: 0, left: 0 }]).png().toBuffer();
}

async function captureInspectorScreenshots(ctx, shotDir, { fake01, ref01, fake02, img01, img02 }) {
  await mkdir(shotDir, { recursive: true });
  const shotRoot = await mkdtemp(join(tmpdir(), "mosa-465-shot-"));
  const electronBinary = ensureElectronExecutablePath({ rootDir: ROOT_DIR });
  const port = await freePort();
  const cdpPort = await freePort();
  const userDataDir = join(shotRoot, "userdata");
  const libraryDir = join(shotRoot, "library");
  const pidFile = join(shotRoot, "desktop-shot.pid");
  const logFile = join(shotRoot, "desktop-shot.log");
  const healthFile = join(userDataDir, "health.json");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(libraryDir, { recursive: true });

  const qaFlags = process.platform === "linux" ? ["--no-sandbox", "--disable-gpu"] : [];
  await launchDesktopGui({
    platform: process.platform,
    rootDir: userDataDir,
    executable: electronBinary,
    args: [...qaFlags, "desktop/main.mjs", `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${cdpPort}`],
    env: {
      ...process.env,
      MOSA_RUNTIME_MODE: "qa",
      MOSA_QA_RUN: "1",
      MOSA_LIBRARY_DIR: libraryDir,
      MOSA_USER_DATA: userDataDir,
      MOSA_PROJECT_DIR: ROOT_DIR,
      MOSA_DESKTOP_PORT: String(port),
      MOSA_WEB_CAPTURE_TOKEN: CAPTURE_TOKEN,
      MOSA_DISABLE_BRIDGES: "cowart,cowartDiscovery,codex,grok",
      CODEX_GENERATED_IMAGES_DIR: join(shotRoot, "codex-generated"),
      CODEX_SESSIONS_DIR: join(shotRoot, "codex-sessions"),
      GROK_SESSIONS_DIR: join(shotRoot, "grok-sessions"),
      COWART_MOSA_CANVAS_DIR: join(shotRoot, "cowart-data"),
    },
    cwd: ROOT_DIR,
    pidFile,
    logFile,
    healthUrl: `http://127.0.0.1:${port}/api/health`,
    healthFile,
  });

  const pid = await waitForPid(pidFile);
  let cdp = null;
  try {
    await waitForHealthFile(healthFile);
    const origin = `http://127.0.0.1:${port}`;
    await postCapture(origin, CAPTURE_TOKEN, {
      ...toIngestBody(fake01, img01),
      capturedAt: "2026-11-22T12:00:00.000Z",
    });
    await postCapture(origin, CAPTURE_TOKEN, {
      ...toIngestBody(ref01, img01),
      capturedAt: "2026-11-22T12:00:30.000Z",
    });
    const res02 = await postCapture(origin, CAPTURE_TOKEN, {
      ...toIngestBody(fake02, img02),
      capturedAt: "2026-11-22T12:01:00.000Z",
    });
    const fake02Id = res02.asset?.id || res02.assetId;

    cdp = await connectCdp(cdpPort, origin);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
    await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline && !document.querySelector('.app')) await sleep(100);
    })()`);

    const saved = {};
    for (const theme of ["light", "dark"]) {
      await cdp.evaluate(`localStorage.setItem("mosa.ui-language", "zh"); localStorage.setItem("gravityport.preferences", JSON.stringify({ appearance: ${JSON.stringify(theme === "dark" ? "深色" : "浅色")} }));`);
      await cdp.send("Page.reload", { ignoreCache: true });
      await sleep(1500);
      await cdp.evaluate(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline && !document.querySelector('.asset-card[data-asset-id="${fake02Id}"]')) await sleep(100);
        const card = document.querySelector('.asset-card[data-asset-id="${fake02Id}"]');
        if (!card) throw new Error('Fake02 card not found for screenshot; cards=' + document.querySelectorAll('.asset-card').length);
        card.click();
        while (Date.now() < deadline && !document.querySelector('.details .asset-title')) await sleep(100);
        while (Date.now() < deadline) {
          const heading = Array.from(document.querySelectorAll('.details .field-heading'))
            .find((el) => el.querySelector('span')?.textContent?.trim() === '版本树');
          const btn = heading && Array.from(heading.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '查看' || (b.textContent || '').trim() === '收起');
          if (btn) { if ((btn.textContent || '').trim() === '查看') btn.click(); break; }
          await sleep(100);
        }
        while (Date.now() < deadline && document.querySelectorAll('.details .generation-tree-row').length < 2) await sleep(100);
        const treeRow = document.querySelector('.details .generation-tree-row');
        if (treeRow) treeRow.scrollIntoView({ block: 'center' });
        await sleep(400);
      })()`);
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      const stamped = await stampDemoWatermark(Buffer.from(shot.data, "base64"));
      const filePath = join(shotDir, `465-lovart-parent-link-${theme}.png`);
      await writeFile(filePath, stamped);
      saved[theme] = filePath;
    }
    return saved;
  } finally {
    try { cdp?.close(); } catch {}
    await signalProcessTree(pid, "SIGTERM").catch(() => {});
    await rm(shotRoot, { recursive: true, force: true }).catch(() => {});
  }
}
