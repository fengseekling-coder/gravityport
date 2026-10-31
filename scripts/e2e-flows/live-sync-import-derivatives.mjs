// GravityPort React UI flow (320 补充 8 / 原单⑤-8)：导入几张等衍生图做完，
// 卡片换成缩略图地址，列表顺序和 scrollTop 都不变（增量合并不重排）。
export const name = "live-sync-import-derivatives";
export const description = "import via page API, wait for derivatives -> card URLs swap to thumbnails with order and scrollTop unchanged";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    // 320 返工 1 (I2)：预置 60 张，保证画廊能滚动（scrollTop > 0 生效）
    const samplePng = await ctx.makePng(`deriv-base.png`, [74, 127, 181]);
    for (let i = 1; i <= 60; i += 1) {
      await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default",
        imagePath: samplePng,
        prompt: `derivatives base ${i}`,
      });
    }
    const result = await ctx.runInPage(server, derivativesSource(), { windowSize: [1440, 940] });
    if (result?.allSwapped !== true || result?.orderPreserved !== true || result?.scrollPreserved !== true) {
      throw new Error(`live-sync-import-derivatives result: ${JSON.stringify(result)}`);
    }
    return { ...result };
  } finally {
    await server.stop();
  }
}

function derivativesSource() {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 60000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(200);
      }
      throw new Error('Timed out waiting for ' + label);
    }
    const clientToken = () => sessionStorage.getItem('mosa.client-token') || '';
    const cardIds = () => [...document.querySelectorAll('.asset-card[data-asset-id]')].map(node => node.dataset.assetId);
    const grid = () => document.querySelector('.asset-grid');

    await waitFor(() => cardIds().length === 60, 'base cards rendered');

    // 导入 3 张（走页面 fetch，等同外部导入；App 经推送增量合并）。
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 400;
    const context = canvas.getContext('2d');
    const colors = ['#2255aa', '#aa5522', '#22aa55'];
    for (let i = 0; i < 3; i += 1) {
      context.fillStyle = colors[i];
      context.fillRect(0, 0, 640, 400);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const staged = await fetch('/api/import/stage', {
        method: 'POST',
        headers: { 'x-mosa-file-name': 'deriv-new-' + i + '.png', 'x-mosa-client-token': clientToken() },
        body: blob,
      }).then((r) => r.json());
      await fetch('/api/assets/import-batch', {
        method: 'POST',
        headers: { 'x-mosa-client-token': clientToken(), 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: 'default', items: [{ imagePath: staged.path }] }),
      });
    }
    await waitFor(() => cardIds().length === 63, 'imported cards merged in', 30000);
    const orderBefore = cardIds();
    const scrollBefore = Math.round(grid().scrollTop);
    grid().scrollTop = 120; // 给一个非零滚动位，验证合并不重置它
    await sleep(200);
    const scrollPinned = Math.round(grid().scrollTop);
    // 320 返工 1 (I2)：先断言 scrollPinned > 0，再比合并前后的 scrollTop 和顺序
    if (scrollPinned <= 0) {
      throw new Error('scrollPinned must be > 0 but was ' + scrollPinned);
    }

    // 等三张新卡的缩略图 URL 全部出现（衍生图完成 + 增量合并换地址）。
    const thumbSelector = (id) => '.asset-card[data-asset-id="' + id + '"] img';
    const newIds = orderBefore.slice(0, 3);
    try {
      // 衍生地址 = thumbnails/mediums/previews 任一档（srcset 按视口可能选
      // medium 档）；原图 fallback 是 /images/ 且保持原始扩展名。
      await waitFor(() => newIds.every((id) => {
        const img = document.querySelector(thumbSelector(id));
        const src = String(img?.currentSrc || img?.src || '');
        return Boolean(img) && src.includes('.webp') && !src.includes('/images/');
      }), 'imported cards swapped to derivative URLs', 120000);
    } catch (error) {
      const diag = newIds.map((id) => {
        const img = document.querySelector(thumbSelector(id));
        const full = img ? String(img.currentSrc || img.src || '') : '';
        let path = full;
        try { path = new URL(full, location.origin).pathname; } catch {}
        return { id: id.slice(0, 14), path };
      });
      throw new Error('derivative swap failed | ' + JSON.stringify(diag));
    }

    const orderAfter = cardIds();
    const orderPreserved = JSON.stringify(orderBefore) === JSON.stringify(orderAfter);
    const scrollAfter = Math.round(grid().scrollTop);

    // 合并（衍生图换地址）不得把滚动位拉回顶；先断言 scrollPinned > 0，±40px 容忍布局微差。
    const scrollPreserved = scrollPinned > 0 && Math.abs(scrollAfter - scrollPinned) <= 40;
    // 新导入素材的衍生地址已全部就位（同上面的判定口径：medium/thumbnail 均可，
    // 原图 fallback 是 /images/ 且保持原始扩展名）。
    const perCardPaths = newIds.map((id) => {
      const img = document.querySelector(thumbSelector(id));
      const full = String(img?.currentSrc || img?.src || '');
      let path = full;
      try { path = new URL(full, location.origin).pathname; } catch {}
      return path;
    });
    const allSwapped = perCardPaths.every((path) => path.includes('.webp') && !path.includes('/images/'));
    if (!allSwapped) throw new Error('not all derivative URLs | ' + JSON.stringify(perCardPaths));
    return { allSwapped, orderPreserved, scrollPreserved, scrollPinned, scrollAfter, loaded: cardIds().length };
  })()
  `;
}
