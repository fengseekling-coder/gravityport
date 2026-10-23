// GravityPort React UI flow (task 225): Settings → 连接 browser extension card.
//
// A seeded capture carrying extensionVersion makes the card read 已连接 with
// the version. The extension then reports a pending: 2 queue through the
// capture-plugin status route; clicking the card's 刷新 reveals the 重试 row,
// and clicking 重试 must hit POST /api/web-capture/retry for real — the
// server's retryRequestId has to come back exactly one higher.
import sharp from "sharp";

export const name = "extension-status-card";
export const description = "capture with extensionVersion -> card 已连接 + version -> extension reports pending:2 -> 刷新 shows 重试 -> click -> server retryRequestId +1 and 已让扩展重试 shows";

const CAPTURE_TOKEN = "mosa_e2e_extension_card_token";
const CAPTURED_VERSION = "0.15.37";

export async function run(ctx) {
  await ctx.prepare();
  // The capture-plugin ingest routes need a web-capture bearer token; the e2e
  // server env inherits this process's env (qaEnvironment spreads process.env).
  const previousCaptureToken = process.env.MOSA_WEB_CAPTURE_TOKEN;
  process.env.MOSA_WEB_CAPTURE_TOKEN = CAPTURE_TOKEN;
  const server = await ctx.startServer();
  try {
    const seeded = await fetch(`${server.origin}/api/ingest/web-capture`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${CAPTURE_TOKEN}` },
      body: JSON.stringify({
        provider: "chatgpt",
        imageBase64: (await noiseJpeg()).toString("base64"),
        mimeType: "image/jpeg",
        prompt: "extension status card flow",
        promptStatus: "generation-tool-prompt",
        extensionVersion: CAPTURED_VERSION,
      }),
    });
    if (!seeded.ok) {
      throw new Error(`seed capture failed: HTTP ${seeded.status}: ${(await seeded.text()).slice(0, 200)}`);
    }

    const before = await statusSnapshot(server);
    const round = await ctx.runInPage(server, pageSource());
    const problems = [];
    if (round?.connectedText !== "已连接") problems.push(`state line ${JSON.stringify(round?.connectedText)}`);
    if (round?.versionShown !== CAPTURED_VERSION) problems.push(`version shown ${JSON.stringify(round?.versionShown)}`);
    if (round?.retryBeforeRefresh !== false) problems.push("retry row visible before the extension reported a queue");
    if (round?.retryAfterRefresh !== true) problems.push("retry row missing after 刷新 with pending: 2");
    // The row's full text also contains the button label, hence startsWith.
    if (!String(round?.pendingText || "").startsWith("等待重试 2 张")) problems.push(`pending text ${JSON.stringify(round?.pendingText)}`);
    if (round?.retryRequestIdBefore !== before) problems.push(`in-page retryRequestId ${round?.retryRequestIdBefore} != Node-side ${before}`);
    if (round?.retriedShown !== true) problems.push("已让扩展重试 confirmation missing after the click");
    if (round?.retryRequestIdAfter !== before + 1) {
      problems.push(`retryRequestId after click ${round?.retryRequestIdAfter} != ${before + 1}`);
    }
    if (problems.length) throw new Error(`extension-status-card: ${problems.join("; ")}`);
    return { retryRequestId: round.retryRequestIdAfter, seededCapture: true };
  } finally {
    if (previousCaptureToken === undefined) delete process.env.MOSA_WEB_CAPTURE_TOKEN;
    else process.env.MOSA_WEB_CAPTURE_TOKEN = previousCaptureToken;
    await server.stop();
  }
}

async function statusSnapshot(server) {
  const response = await fetch(`${server.origin}/api/web-capture`);
  if (!response.ok) throw new Error(`GET /api/web-capture failed: HTTP ${response.status}`);
  const body = await response.json();
  return Number(body?.bridge?.retryRequestId || 0);
}

async function noiseJpeg() {
  const width = 720;
  const height = 960;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 37 + (i % 251)) & 255;
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
}

function pageSource() {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label);
    }
    const bridgeStatus = async () => {
      const response = await fetch('/api/web-capture', { cache: 'no-store' });
      if (!response.ok) throw new Error('GET /api/web-capture -> HTTP ' + response.status);
      return (await response.json()).bridge || {};
    };
    const reportQueue = async () => {
      const response = await fetch('/api/ingest/web-capture-status', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ${CAPTURE_TOKEN}' },
        body: JSON.stringify({
          pending: 2,
          failed: 0,
          items: [
            { id: 'e2e-item-1', provider: 'chatgpt', mediaKind: 'image', promptStatus: 'user-message', generationStatus: 'failed', attempts: 2, lastError: 'stale url', createdAt: 1, updatedAt: 2 },
            { id: 'e2e-item-2', provider: 'chatgpt', mediaKind: 'image', promptStatus: 'not-available', generationStatus: 'unknown', attempts: 1, lastError: '', createdAt: 3, updatedAt: 4 },
          ],
        }),
      });
      if (!response.ok) throw new Error('POST web-capture-status -> HTTP ' + response.status);
      return response.json();
    };

    await waitFor(() => document.querySelector('.app'), 'app shell');
    document.querySelector('.user-button').click();
    await waitFor(() => document.querySelector('.settings-modal'), 'settings open');
    const nav = Array.from(document.querySelectorAll('.settings-nav button')).find((b) => b.textContent.trim() === '连接');
    if (!nav) throw new Error('连接 nav missing: ' + Array.from(document.querySelectorAll('.settings-nav button')).map((b) => b.textContent.trim()).join('|'));
    nav.click();
    await waitFor(() => document.querySelector('.web-capture-status-card'), 'extension status card');

    const stateLine = () => document.querySelector('.web-capture-status-card .web-capture-state')?.textContent.trim() || '';
    await waitFor(() => stateLine() === '已连接', '已连接 state line');
    const rows = () => Array.from(document.querySelectorAll('.web-capture-status-card .web-capture-row')).map((el) => el.textContent.trim());
    await waitFor(() => rows().some((text) => text.includes('${CAPTURED_VERSION}')), 'version row');

    const retryButton = () => document.querySelector('.web-capture-status-card .web-capture-retry');
    const retryBeforeRefresh = Boolean(retryButton());

    const requestIdBefore = Number((await bridgeStatus()).retryRequestId || 0);
    await reportQueue();

    document.querySelector('.web-capture-status-card .web-capture-refresh').click();
    await waitFor(() => retryButton(), 'retry row after refresh');
    const cardText = () => document.querySelector('.web-capture-status-card').textContent;
    await waitFor(() => cardText().includes('等待重试 2 张'), 'pending count row');
    const pendingText = rows().find((text) => text.includes('等待重试')) || '';
    const requestIdAfterRefresh = Number((await bridgeStatus()).retryRequestId || 0);
    if (requestIdAfterRefresh !== requestIdBefore) {
      throw new Error('retryRequestId changed before the retry click: ' + requestIdAfterRefresh);
    }

    retryButton().click();
    await waitFor(() => document.querySelector('.web-capture-status-card .web-capture-retried'), '已让扩展重试 confirmation');
    const retriedShown = document.querySelector('.web-capture-status-card .web-capture-retried')?.textContent.trim() === '已让扩展重试';
    await waitFor(async () => Number((await bridgeStatus()).retryRequestId || 0) === requestIdBefore + 1, 'server retryRequestId +1');

    return {
      connectedText: stateLine(),
      versionShown: '${CAPTURED_VERSION}',
      retryBeforeRefresh,
      retryAfterRefresh: true,
      pendingText,
      retryRequestIdBefore: requestIdBefore,
      retriedShown,
      retryRequestIdAfter: Number((await bridgeStatus()).retryRequestId || 0),
    };
  })()
  `;
}
