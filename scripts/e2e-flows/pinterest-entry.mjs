// GravityPort React UI flow: the sidebar Pinterest row opens the live
// Pinterest view (guide page while not connected) instead of filtering local
// assets, the gallery chrome and its shortcuts stay out of reach there, and
// Settings → 连接 hosts the Pinterest connection card.
export const name = "pinterest-entry";
export const description = "Pinterest row -> guide page, no gallery toolbar/inspector -> ⌘A+Delete touch nothing -> 打开设置 lands on 连接 with the connection card and the MCP card";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    for (const [file, color] of [["pin-entry-a.png", [74, 127, 181]], ["pin-entry-b.png", [181, 68, 74]]]) {
      await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default", imagePath: await ctx.makePng(file, color), prompt: "pinterest entry seed",
      });
    }
    const result = await ctx.runInPage(server, pinterestEntrySource());
    const trash = (await ctx.api(server.origin, "GET", "/api/assets?project=default&trash=1&limit=250")).assets || [];
    if (trash.length) throw new Error(`gallery shortcuts reached hidden assets from the Pinterest view: ${trash.length} trashed`);
    return result;
  } finally {
    await server.stop();
  }
}

function pinterestEntrySource() {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      let stable = 0;
      while (Date.now() < deadline) {
        if (check()) { stable += 1; if (stable >= 2) return true; } else stable = 0;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label + ' | nav=' + activeNav() + ' | main=' + (document.querySelector('main')?.innerText || '').slice(0, 200));
    }
    const cards = () => document.querySelectorAll('.asset-card').length;
    const navButton = (label) => Array.from(document.querySelectorAll('.main-nav button'))
      .find((button) => Array.from(button.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === label));
    const activeNav = () => document.querySelector('.main-nav .nav-row[aria-current="page"] > span:not(.brand-icon)')?.textContent?.trim();
    const key = (init) => document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

    await waitFor(() => document.querySelector('.app') && cards() === 2, 'two seeded cards');

    const baselineSelected = document.querySelectorAll('.asset-card.asset-selected').length;
    navButton('Pinterest').click();
    await waitFor(() => activeNav() === 'Pinterest' && document.querySelector('.pinterest-guide'), 'Pinterest guide page');
    const galleryHidden = !document.querySelector('.asset-grid') && !document.querySelector('.toolbar .search')
      && !document.querySelector('.details');
    if (!galleryHidden) throw new Error('gallery chrome still shown in the Pinterest view');
    const sidebarCount = navButton('Pinterest').querySelector('small')?.textContent ?? null;
    if (sidebarCount !== '暂未开放') throw new Error('Pinterest row should say 暂未开放 in the count slot before boards load: ' + JSON.stringify(sidebarCount));

    // ⌘A then Delete in the Pinterest view must not select or trash the
    // hidden gallery's assets.
    key({ key: 'a', metaKey: true });
    await sleep(400);
    key({ key: 'Delete' });
    await sleep(400);
    if (document.querySelector('[role="alertdialog"]')) throw new Error('Delete opened the trash confirmation from the Pinterest view');

    document.querySelector('.pinterest-guide .pinterest-link').click();
    await waitFor(() => document.querySelector('.settings-modal .pinterest-connection-card'), 'connection card in Settings');
    const activeTab = document.querySelector('.settings-nav button[aria-pressed="true"]')?.textContent?.trim();
    if (activeTab !== '连接') throw new Error('打开设置 should land on 连接, got ' + JSON.stringify(activeTab));
    // The Pinterest connection is not an MCP integration; the separate
    // AI assistants (MCP) card below it is (task 208).
    if (/MCP/.test(document.querySelector('.settings-modal .pinterest-connection-card').textContent)) throw new Error('Pinterest card still mentions MCP');
    await waitFor(() => document.querySelector('.settings-modal .pinterest-connection-card + .mcp-config-card'), 'AI assistants (MCP) card below the Pinterest card');
    key({ key: 'Escape' });
    await waitFor(() => !document.querySelector('.settings-modal'), 'settings closed');

    navButton('所有素材').click();
    await waitFor(() => activeNav() === '所有素材' && cards() === 2, 'gallery back with both cards');
    // The gallery always marks its focused card; ⌘A would have marked both.
    const selectedAfter = document.querySelectorAll('.asset-card.asset-selected').length;
    if (selectedAfter > baselineSelected) throw new Error('⌘A in the Pinterest view selected gallery cards: ' + selectedAfter + ' > ' + baselineSelected);

    return { galleryHidden, sidebarCount, activeTab, baselineSelected, selectedAfter };
  })()
  `;
}
