// GravityPort React UI flow (320 补充 7 / 原单⑤-7)：自己快速收藏又取消
// （两次点击间隔 <50ms），同步提交后心形不许回跳——MutationObserver 记录的
// 状态序列只能是 未收藏→收藏→未收藏。
export const name = "live-sync-rapid-favorite";
export const description = "double-click-speed favorite/unfavorite -> MutationObserver heart sequence never bounces back";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    for (let i = 1; i <= 3; i += 1) {
      await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default",
        imagePath: await ctx.makePng(`rapid-fav-${i}.png`, [74, 127, 181]),
        prompt: `rapid favorite ${i}`,
      });
    }
    const result = await ctx.runInPage(server, rapidFavoriteSource(), { windowSize: [1440, 940] });
    if (result?.sequenceOk !== true || result?.rounds < 3) {
      throw new Error(`live-sync-rapid-favorite result: ${JSON.stringify(result)}`);
    }
    return { ...result };
  } finally {
    await server.stop();
  }
}

function rapidFavoriteSource() {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label);
    }
    const clientToken = () => sessionStorage.getItem('mosa.client-token') || '';
    const cardCount = () => document.querySelectorAll('.asset-card').length;

    await waitFor(() => document.querySelector('.app') && cardCount() === 3, 'three cards rendered');

    const rounds = 3;
    let sequenceOk = true;
    const sequences = [];
    for (let round = 0; round < rounds; round += 1) {
      const card = document.querySelectorAll('.asset-card[data-asset-id]')[round % 3];
      const id = card.getAttribute('data-asset-id');
      // MutationObserver 记录这张卡的心形出现/消失序列（操作前挂上）。
      const states = [];
      const observer = new MutationObserver(() => {
        const has = Boolean(document.querySelector('.asset-card[data-asset-id="' + id + '"] .favorite-mark'));
        if (states[states.length - 1] !== has) states.push(has);
      });
      observer.observe(document.querySelector('.asset-grid'), { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });

      // 两次点击间隔 <50ms：详情栏的收藏按钮连点（App 的 toggleFavorite 走
      // POST favorite 两次，两个修改请求先后在途）。
      card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(120);
      const favoriteButton = document.querySelector('button[aria-label="收藏素材"]');
      if (!favoriteButton) { observer.disconnect(); throw new Error('favorite button missing'); }
      favoriteButton.click();
      await sleep(40);
      favoriteButton.click();

      // 等最后一次同步提交落地（无 fallback、基线前进），再多等两拍让任何
      // 迟到的合并渲染完。
      await waitFor(() => {
        const stats = window.__mosaLibrarySync?.stats() || {};
        return Number(stats.syncs || 0) >= round + 1;
      }, 'favorite sync commits', 10000);
      await sleep(800);
      observer.disconnect();
      const seq = states.map(s => (s ? 'on' : 'off')).join('>');
      sequences.push(seq);
      // 320 返工 1 (I)：每一轮序列必须是 off>on>off 或 on>off（至少出现一次 on，最后是 off，中间不回跳）。
      if (seq !== 'off>on>off' && seq !== 'on>off') {
        sequenceOk = false;
      }
    }
    return { sequenceOk, rounds, sequences };
  })()
  `;
}
