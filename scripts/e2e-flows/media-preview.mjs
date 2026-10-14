// GravityPort React UI flow: the full-screen viewer opens on double-click,
// navigates with the keyboard, reports zoom state and closes on Escape.
export const name = "media-preview";
export const description = "double-click opens the viewer -> fit/zoom controls -> arrow keys switch assets -> Escape closes";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    for (const file of ["preview-a.png", "preview-b.png"]) {
      await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default", imagePath: await ctx.makePng(file, [74, 127, 181]), prompt: "media preview flow",
      });
    }
    const result = await ctx.runInPage(server, previewSource());
    if (result?.opened !== true || result?.navigationChanged !== true
      || result?.zoomVisible !== true || result?.escapeClosed !== true) {
      throw new Error(`media-preview result: ${JSON.stringify(result)}`);
    }
    return result;
  } finally {
    await server.stop();
  }
}

function previewSource() {
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
    const cardCount = () => document.querySelectorAll('.asset-card').length;

    await waitFor(() => document.querySelector('.app') && cardCount() === 2, 'two seeded cards');

    const card = Array.from(document.querySelectorAll('.asset-card')).find((node) => !node.querySelector('.stack-mark'));
    card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await waitFor(() => document.querySelector('img.viewer-image')?.complete === true, 'viewer image decoded');
    const opened = true;

    const zoomVisible = Boolean(document.querySelector('.viewer-controls output'));
    const titleBefore = document.querySelector('.viewer-title strong')?.textContent || '';
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await waitFor(() => (document.querySelector('.viewer-title strong')?.textContent || '') !== titleBefore, 'arrow navigation switches asset');
    const navigationChanged = true;

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => !document.querySelector('.image-viewer'), 'viewer closed');
    const escapeClosed = true;

    return { opened, zoomVisible, navigationChanged, escapeClosed };
  })()
  `;
}
