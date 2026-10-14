// GravityPort React UI flow: the toolbar arrows walk real navigation history
// across scopes instead of resetting the workspace.
export const name = "nav-history";
export const description = "all -> Favorites -> all -> back returns to Favorites -> forward returns to all -> a search becomes a history entry";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const plain = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("nav-plain.png", [74, 127, 181]), prompt: "nav history plain",
    });
    const starred = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("nav-starred.png", [181, 68, 74]), prompt: "nav history starred",
    });
    await ctx.api(server.origin, "POST", `/api/assets/default/${encodeURIComponent(starred.asset.id)}/favorite`);
    const result = await ctx.runInPage(server, navHistorySource());
    if (result?.backToIdentity !== true || result?.forwardToAll !== true || result?.searchInHistory !== true) {
      throw new Error(`nav-history result: ${JSON.stringify(result)}`);
    }
    return { plainId: plain.asset.id, ...result };
  } finally {
    await server.stop();
  }
}

function navHistorySource() {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      let stable = 0;
      while (Date.now() < deadline) {
        if (check()) { stable += 1; if (stable >= 2) return true; } else stable = 0;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label + ' | cards=' + document.querySelectorAll('.asset-card').length);
    }
    const cards = () => document.querySelectorAll('.asset-card').length;
    const navButton = (label) => Array.from(document.querySelectorAll('.main-nav button'))
      .find((button) => Array.from(button.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === label));
    const activeNav = () => document.querySelector('.main-nav .nav-row[aria-current="page"] > span')?.textContent?.trim();
    async function goto(label) {
      await waitFor(() => {
        const button = navButton(label);
        if (button && activeNav() !== label) button.click();
        return activeNav() === label;
      }, 'switch to ' + label);
    }
    const toolbarButton = (index) => document.querySelectorAll('.toolbar-left button')[index];

    await waitFor(() => document.querySelector('.app') && cards() === 2, 'two seeded cards');

    await goto('收藏');
    await waitFor(() => cards() === 1, 'favorites view');
    await goto('所有素材');
    await waitFor(() => cards() === 2, 'all view');

    toolbarButton(0).click();
    await waitFor(() => activeNav() === '收藏' && cards() === 1, 'back returns to Favorites');
    const backToIdentity = activeNav() === '收藏' && cards() === 1;

    toolbarButton(1).click();
    await waitFor(() => activeNav() === '所有素材' && cards() === 2, 'forward returns to all');
    const forwardToAll = activeNav() === '所有素材' && cards() === 2;

    // A committed search is a history entry: back must undo it.
    const input = document.querySelector('.search input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'nav history starred');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => cards() === 1, 'search narrows to the starred card');
    toolbarButton(0).click();
    await waitFor(() => activeNav() === '所有素材' && cards() === 2, 'back undoes the search');
    const searchInHistory = cards() === 2 && (document.querySelector('.search input')?.value || '') === '';

    return { backToIdentity, forwardToAll, searchInHistory };
  })()
  `;
}
