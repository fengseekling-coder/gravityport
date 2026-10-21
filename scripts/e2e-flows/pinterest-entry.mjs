// GravityPort React UI flow: Pinterest browsing stays hidden until Pinterest
// approves Standard API access (PINTEREST_ENTRY in App.tsx), so neither the
// sidebar row nor Settings → 连接 may show up. The view, the connection card,
// and the token API stay in the code and are covered by the component tests.
export const name = "pinterest-entry";
export const description = "no Pinterest row in the sidebar -> Settings has no 连接 tab and no Pinterest connection card";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("pin-entry-a.png", [74, 127, 181]), prompt: "pinterest hidden seed",
    });
    return await ctx.runInPage(server, pinterestHiddenSource());
  } finally {
    await server.stop();
  }
}

function pinterestHiddenSource() {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      let stable = 0;
      while (Date.now() < deadline) {
        if (check()) { stable += 1; if (stable >= 2) return true; } else stable = 0;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label);
    }
    await waitFor(() => document.querySelector('.app') && document.querySelectorAll('.asset-card').length === 1, 'one seeded card');

    const navLabels = Array.from(document.querySelectorAll('.main-nav button')).map((button) => button.getAttribute('aria-label'));
    if (navLabels.some((label) => /pinterest/i.test(String(label)))) throw new Error('sidebar still shows Pinterest: ' + JSON.stringify(navLabels));
    if (document.querySelector('.main-nav .brand-icon')) throw new Error('sidebar still renders the Pinterest brand icon');

    document.querySelector('.user-button').click();
    await waitFor(() => document.querySelector('.settings-modal'), 'settings modal');
    const tabs = Array.from(document.querySelectorAll('.settings-nav button')).map((button) => button.textContent.trim());
    if (tabs.includes('连接') || tabs.includes('Connections')) throw new Error('Settings still lists a connection tab: ' + JSON.stringify(tabs));
    if (document.querySelector('.pinterest-connection-card')) throw new Error('Pinterest connection card is rendered');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
    await waitFor(() => !document.querySelector('.settings-modal'), 'settings closed');

    return { navLabels, tabs };
  })()
  `;
}
