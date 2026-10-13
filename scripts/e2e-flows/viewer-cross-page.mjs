// GravityPort React UI flow: the viewer crosses a pagination boundary —
// navigating past the loaded edge pulls the next page and steps into it.
export const name = "viewer-cross-page";
export const description = "110 assets -> viewer opened at the last card of page 1 -> ArrowRight pulls page 2 and shows asset 101/110";

const CROSS_TOTAL = 110;
const PAGE_SIZE = 100;

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const fixturePath = await ctx.makePng("cross-fixture.png", [74, 127, 181]);
    const workers = 6;
    let created = 0;
    while (created < CROSS_TOTAL) {
      const batch = Math.min(workers, CROSS_TOTAL - created);
      await Promise.all(Array.from({ length: batch }, () =>
        ctx.api(server.origin, "POST", "/api/assets/create", {
          projectId: "default", imagePath: fixturePath, prompt: "viewer cross page",
        })));
      created += batch;
    }
    const result = await ctx.runInPage(server, crossPageSource(), { windowSize: [1440, 940] });
    if (result?.initialTitle !== "100 / 100" || result?.crossedTitle !== "101 / 110") {
      throw new Error(`viewer-cross-page result: ${JSON.stringify(result)}`);
    }
    return result;
  } finally {
    await server.stop();
  }
}

function crossPageSource() {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 45000) {
      const deadline = Date.now() + timeoutMs;
      let stable = 0;
      while (Date.now() < deadline) {
        if (check()) { stable += 1; if (stable >= 2) return true; } else stable = 0;
        await sleep(120);
      }
      throw new Error('Timed out waiting for ' + label + ' | cards=' + document.querySelectorAll('.asset-card').length
        + ' | nav=' + JSON.stringify(window.__navDebug || null) + ' | title=' + viewerTitle()
        + ' | selected=' + (window.__mosaSelectedId || '').slice(0, 30)
        + ' | titleHtml=' + (document.querySelector('.viewer-title')?.outerHTML || 'none').slice(0, 220)
        + ' | imgSrc=' + (document.querySelector('img.viewer-image')?.getAttribute('src') || 'none').slice(0, 80)
        + ' | nav2=' + JSON.stringify(window.__navDebug2 || null));
    }
    const cardCount = () => document.querySelectorAll('.asset-card').length;
    const viewerTitle = () => document.querySelector('.viewer-title span')?.textContent?.trim() || '';

    await waitFor(() => cardCount() === ${PAGE_SIZE}, 'the first page loads exactly');

    // Open the viewer on the LAST card of the first page.
    const lastCard = Array.from(document.querySelectorAll('.asset-card'))[${PAGE_SIZE - 1}];
    lastCard.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await waitFor(() => document.querySelector('img.viewer-image')?.complete === true, 'viewer opens on the page edge');
    const initialTitle = viewerTitle();
    window.__openSnap = { title: initialTitle, selected: (window.__mosaSelectedId || '').slice(0, 30) };
    const openedFor = window.__mosaSelectedId || '';

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await waitFor(() => viewerTitle() === '101 / 110', 'the viewer crosses into the next page');
    const crossedTitle = viewerTitle();

    return { initialTitle, crossedTitle };
  })()
  `;
}
