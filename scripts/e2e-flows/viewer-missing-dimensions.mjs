// GravityPort React UI flow (task 182): an asset whose dimensions never made
// it into business_fields must still open at the right size in the viewer.
//
// The derivative job records dimensions quickly, so the flow does NOT rely on
// missing data in the library: a forwarding proxy sits between the UI and the
// server and strips width/height (top level and business_fields) from every
// JSON response that carries the target asset — the same interception
// Playwright's page.route would provide, at flow level. The UI must then fall
// back to the loaded image's own dimensions (ImageViewer onLoad) instead of
// collapsing the picture to normalizeAsset's 1×1 placeholder. A second asset
// with intact dimensions must keep rendering from its props.
import { createServer, request as httpRequest } from "node:http";

export const name = "viewer-missing-dimensions";
export const description = "UI receives a 1200x800 asset without width/height (proxy-stripped) -> viewer renders it from the decoded image at ~1.5 ratio, zoom and fit work -> a normal asset keeps its props dimensions";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  const normalPath = await ctx.makePng("dims-ok-normal.png", [74, 127, 181], { width: 800, height: 400 });
  const gapPath = await ctx.makePng("dims-gap-wide.png", [181, 127, 74], { width: 1200, height: 800 });
  const normal = (await ctx.api(server.origin, "POST", "/api/assets/create", {
    projectId: "default", imagePath: normalPath, prompt: "dims ok normal",
  })).asset;
  const gap = (await ctx.api(server.origin, "POST", "/api/assets/create", {
    projectId: "default", imagePath: gapPath, prompt: "dims gap wide",
  })).asset;

  // The gallery lists newest first, so the gap asset is the first card.
  await waitForPreview(server, ctx, gap.id);
  await waitForPreview(server, ctx, normal.id);

  // The library itself keeps the dimensions; only the proxy hides them.
  const directPage = await ctx.api(server.origin, "GET", "/api/assets?project=default");
  const directFields = (directPage.assets || []).find((asset) => asset.id === gap.id);
  if (directFields?.business_fields?.width !== 1200 || directFields?.business_fields?.height !== 800) {
    throw new Error(`the stored asset must keep its dimensions: ${JSON.stringify(directFields?.business_fields)}`);
  }

  const proxy = await startStrippingProxy(server.origin, gap.id);
  try {
    const result = await ctx.runInPage({ origin: proxy.origin }, viewerSource(gap.id), { windowSize: [1440, 940] });
    if (result?.__pageError) throw new Error(`viewer-missing-dimensions page error: ${result.__pageError}`);
    const problems = [];
    if (result?.uiSawDimensions !== false) problems.push("the UI-facing asset JSON still carried width/height");
    if (result?.gapRendered !== true) problems.push("the dimension-less asset rendered larger than a point");
    if (result?.gapRatioOk !== true) problems.push(`gap asset displayed ratio ${result?.displayedRatio} not within 2% of 1.5`);
    if (result?.zoomWorks !== true) problems.push("zoom in did not grow the picture");
    if (result?.fitWorks !== true) problems.push("适合窗口 did not restore the fitted size");
    if (result?.nextRatioOk !== true) problems.push(`normal asset displayed ratio ${result?.nextDisplayedRatio} not within 2% of 2`);
    if (problems.length) throw new Error(`viewer-missing-dimensions result: ${problems.join("; ")} — ${JSON.stringify(result)}`);
    return { ok: true };
  } finally {
    await proxy.close();
    await server.stop();
  }
}

async function waitForPreview(server, ctx, assetId) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const page = await ctx.api(server.origin, "GET", "/api/assets?project=default");
    const asset = (page.assets || []).find((candidate) => candidate.id === assetId);
    if (asset?.preview_ready === true) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`preview for ${assetId} never became ready`);
}

// Forwards every request to the target origin untouched, except that JSON
// responses carrying the target asset lose their width/height. SSE frames and
// binary derivative files stream through unbuffered.
function startStrippingProxy(targetOrigin, assetId) {
  const target = new URL(targetOrigin);
  const stripAsset = (node) => {
    if (Array.isArray(node)) {
      node.forEach(stripAsset);
      return;
    }
    if (!node || typeof node !== "object") return;
    if (node.id === assetId && ("business_fields" in node || "preview_path" in node || "asset" in node)) {
      delete node.width;
      delete node.height;
      if (node.business_fields && typeof node.business_fields === "object") {
        delete node.business_fields.width;
        delete node.business_fields.height;
      }
    }
    for (const value of Object.values(node)) {
      if (value && (typeof value === "object")) stripAsset(value);
    }
  };
  return new Promise((resolveProxy, rejectProxy) => {
    const proxy = createServer((req, res) => {
      // The runtime refuses requests whose Origin names a port other than its
      // own (DNS-rebinding guard), so the proxy must present the target
      // origin upstream, not the one the UI is actually loading from.
      const headers = { ...req.headers, host: target.host };
      if (headers.origin) headers.origin = targetOrigin;
      if (headers.referer) headers.referer = targetOrigin + "/";
      const upstream = httpRequest({
        host: target.hostname,
        port: target.port,
        path: req.url,
        method: req.method,
        headers,
      }, (upstreamRes) => {
        const contentType = String(upstreamRes.headers["content-type"] || "");
        if (!contentType.includes("application/json")) {
          res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
          upstreamRes.pipe(res);
          return;
        }
        const chunks = [];
        upstreamRes.on("data", (chunk) => chunks.push(chunk));
        upstreamRes.on("end", () => {
          let payload;
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            stripAsset(body);
            payload = Buffer.from(JSON.stringify(body));
          } catch {
            payload = Buffer.concat(chunks);
          }
          res.writeHead(upstreamRes.statusCode || 502, { ...upstreamRes.headers, "content-length": String(payload.length) });
          res.end(payload);
        });
      });
      upstream.on("error", () => res.destroy());
      req.pipe(upstream);
    });
    proxy.on("error", rejectProxy);
    proxy.listen(0, "127.0.0.1", () => {
      resolveProxy({
        origin: `http://127.0.0.1:${proxy.address().port}`,
        close: () => new Promise((resolveClose) => {
          proxy.closeAllConnections?.();
          proxy.close(() => resolveClose());
        }),
      });
    });
  });
}

function viewerSource(gapId) {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 45000) {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        try { last = check(); } catch (error) { last = String(error); }
        if (last) return last;
        await sleep(120);
      }
      throw new Error('Timed out waiting for ' + label + ' | last=' + String(last));
    }
    // The page talks to the same stripping proxy, so this response is exactly
    // what the app was fed.
    const token = new URLSearchParams(location.hash.slice(1)).get('mosa-client-token') || '';
    const listResponse = await fetch('/api/assets?project=default', { headers: { 'x-mosa-client-token': token } });
    const listBody = await listResponse.json();
    const gapRow = (listBody.assets || []).find((asset) => asset.id === '${gapId}');
    const uiSawDimensions = Boolean(gapRow && ((gapRow.business_fields && (gapRow.business_fields.width || gapRow.business_fields.height)) || gapRow.width || gapRow.height));

    const cards = () => Array.from(document.querySelectorAll('.asset-card'));
    await waitFor(() => cards().length === 2, 'two seeded cards');
    const gapCard = cards().find((card) => (card.getAttribute('aria-label') || '').includes('dims-gap'));
    if (!gapCard) throw new Error('gap card not found: ' + JSON.stringify(cards().map((card) => card.getAttribute('aria-label'))));
    gapCard.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    const image = await waitFor(() => {
      const element = document.querySelector('img.viewer-image');
      return element && element.complete && element.naturalWidth > 0 ? element : null;
    }, 'viewer image decodes');
    // The fallback dimensions land in a React state update right after load.
    const rect = await waitFor(() => {
      const box = image.getBoundingClientRect();
      return box.width > 100 && box.height > 100 ? box : null;
    }, 'image renders larger than a point');
    const displayedRatio = rect.width / rect.height;
    const gapRatioOk = Math.abs(displayedRatio - 1.5) <= 1.5 * 0.02;
    const gapRendered = rect.width > 100 && rect.height > 100;

    document.querySelector('.image-viewer')?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    const controls = () => Array.from(document.querySelectorAll('.viewer-controls button'));
    const sizeBefore = image.getBoundingClientRect().width;
    controls()[1].click();
    await sleep(200);
    const sizeZoomed = image.getBoundingClientRect().width;
    const zoomWorks = sizeZoomed > sizeBefore * 1.1;
    controls()[2].click();
    await sleep(200);
    const sizeFit = image.getBoundingClientRect().width;
    const fitWorks = Math.abs(sizeFit - sizeBefore) <= Math.max(2, sizeBefore * 0.02);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const nextImage = await waitFor(() => {
      const element = document.querySelector('img.viewer-image');
      return element && element !== image && element.complete && element.naturalWidth > 0 ? element : null;
    }, 'navigation lands on the normal asset');
    const nextRect = await waitFor(() => {
      const box = nextImage.getBoundingClientRect();
      return box.width > 100 && box.height > 100 ? box : null;
    }, 'normal asset renders');
    const nextDisplayedRatio = nextRect.width / nextRect.height;
    const nextRatioOk = Math.abs(nextDisplayedRatio - 2) <= 2 * 0.02;

    return { uiSawDimensions, gapRendered, displayedRatio, gapRatioOk, zoomWorks, fitWorks, nextDisplayedRatio, nextRatioOk, nextTitle: document.querySelector('.viewer-title span')?.textContent?.trim() || '' };
  })()`;
}
