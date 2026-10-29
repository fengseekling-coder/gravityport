// GravityPort React UI flow (task 224): a file dropped into the gallery — or
// pasted — while a group view is open lands in that group and never in
// 待整理; the same drop on 所有素材 stays ungrouped.
export const name = "drop-into-group";
export const description = "drop + paste inside a group view import into the group (待整理 stays empty); a drop on 所有素材 stays ungrouped";

const GROUP_NAME = "e2e-drop-group-224";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    await ctx.api(server.origin, "POST", "/api/groups", { projectId: "default", name: GROUP_NAME });
    const result = await ctx.runInPage(server, flowSource(GROUP_NAME));
    const checks = {
      dropLandedInGroup: result?.dropLandedInGroup === 1,
      pasteLandedInGroup: result?.pasteLandedInGroup === 2,
      unorganizedEmpty: result?.unorganizedCards === 0 && result?.unorganizedEmptyState === true,
      dropInAllAssets: result?.allAssetsAfterDrop === 3,
      groupStillTwo: result?.groupAfterReturn === 2,
    };
    if (Object.values(checks).some((value) => value !== true)) {
      throw new Error(`drop-into-group page result: ${JSON.stringify(result)}`);
    }

    // Server truth: the two group-view imports carry the group, the all-assets
    // drop carries none, and 待整理 holds exactly that third asset. Imported
    // asset ids start with the slug of the uploaded file name.
    const page = await ctx.api(server.origin, "GET", "/api/assets?project=default&limit=250");
    const assets = page.assets || [];
    const byId = (prefix) => assets.filter((asset) => String(asset.id || "").startsWith(prefix));
    const grouped = byId("drop-into-group-a").concat(byId("paste-into-group-b"));
    const dropped = byId("drop-all-c");
    if (grouped.length !== 2 || grouped.some((asset) => asset.group !== GROUP_NAME)) {
      throw new Error(`group imports lost the group: ${JSON.stringify(assets.map((asset) => ({ id: asset.id, group: asset.group })))}`);
    }
    if (dropped.length !== 1 || dropped[0].group !== "") {
      throw new Error(`all-assets drop did not stay ungrouped: ${JSON.stringify(dropped.map((asset) => ({ id: asset.id, group: asset.group })))}`);
    }
    const unorganized = await ctx.api(server.origin, "GET", "/api/assets?project=default&limit=250&unorganized=1");
    const unorganizedIds = (unorganized.assets || []).map((asset) => String(asset.id || ""));
    if (unorganizedIds.length !== 1 || !unorganizedIds[0].startsWith("drop-all-c")) {
      throw new Error(`待整理 holds ${JSON.stringify(unorganizedIds)}, expected only the all-assets drop`);
    }
    return { ...result, checks };
  } finally {
    await server.stop();
  }
}

function flowSource(groupName) {
  return `(async () => {
    const GROUP_NAME = ${JSON.stringify(groupName)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(120);
      }
      throw new Error('Timed out waiting for ' + label
        + ' | loaded=' + loadedCount() + ' | cards=' + cardCount()
        + ' | toast=' + (document.querySelector('.toast')?.textContent || '')
        + ' | groupCurrent=' + (groupRow()?.getAttribute('aria-current') || ''));
    }
    const loadedCount = () => Number(document.querySelector('.asset-grid')?.dataset.loadedAssets || 0);
    const cardCount = () => document.querySelectorAll('.asset-card:not(.asset-card-virtual-placeholder)').length;
    const mainNavButton = (label) => Array.from(document.querySelectorAll('.main-nav button'))
      .find((button) => (button.textContent || '').includes(label)) || null;
    const groupRow = () => Array.from(document.querySelectorAll('.sidebar .group-row'))
      .find((button) => button.getAttribute('aria-label') === GROUP_NAME) || null;
    async function makeFile(name, type) {
      const canvas = document.createElement('canvas');
      canvas.width = 32; canvas.height = 24;
      const context = canvas.getContext('2d');
      context.fillStyle = '#333333';
      context.fillRect(0, 0, 32, 24);
      // Each fixture carries a name-derived mark: manual imports of identical
      // bytes skip as already-in-library (task 291), so the flow needs every
      // file to hold distinct bytes.
      let mark = 0;
      for (const ch of name) mark = (mark + ch.charCodeAt(0)) % 28;
      context.fillStyle = '#eeeeee';
      context.fillRect(2 + mark, 2, 4, 20);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      return new File([blob], name, { type });
    }
    function dropOn(target, files) {
      const dataTransfer = new DataTransfer();
      for (const file of files) dataTransfer.items.add(file);
      const rect = target.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, dataTransfer, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      let event = new DragEvent('drop', init);
      if (!event.dataTransfer) {
        event = new Event('drop', init);
        Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      }
      target.dispatchEvent(event);
    }
    function dispatchPaste(file) {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      let event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dataTransfer });
      if (!event.clipboardData) {
        event = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', { value: dataTransfer });
      }
      window.dispatchEvent(event);
    }

    await waitFor(() => document.querySelector('.app') && document.querySelector('.empty-state') && groupRow(), 'app ready with the seeded group');

    // ── 1) Drop inside the group view: the card joins the group ──
    groupRow().click();
    await waitFor(() => groupRow()?.getAttribute('aria-current') === 'page', 'group view active');
    dropOn(document.querySelector('.workspace'), [await makeFile('drop-into-group-a.png', 'image/png')]);
    await waitFor(() => loadedCount() === 1, 'dropped card lands in the group view');
    const dropLandedInGroup = loadedCount();

    // ── 2) Paste inside the group view: same target ──
    dispatchPaste(await makeFile('paste-into-group-b.png', 'image/png'));
    await waitFor(() => loadedCount() === 2, 'pasted card lands in the group view');
    const pasteLandedInGroup = loadedCount();

    // ── 3) 待整理 must not hold either of them ──
    mainNavButton('待整理').click();
    await waitFor(() => mainNavButton('待整理')?.getAttribute('aria-current') === 'page'
      && !document.querySelector('.asset-card') && document.querySelector('.empty-state'), 'unorganized view loads empty');
    const unorganizedCards = cardCount();
    const unorganizedEmptyState = Boolean(document.querySelector('.empty-state'));

    // ── 4) The same drop on 所有素材 stays ungrouped ──
    mainNavButton('所有素材').click();
    await waitFor(() => mainNavButton('所有素材')?.getAttribute('aria-current') === 'page' && loadedCount() === 2, 'all-assets view shows both group members');
    dropOn(document.querySelector('.workspace'), [await makeFile('drop-all-c.png', 'image/png')]);
    await waitFor(() => loadedCount() === 3, 'third card lands in all-assets');
    const allAssetsAfterDrop = loadedCount();

    // ── 5) Back into the group: exactly the two imports ──
    groupRow().click();
    await waitFor(() => loadedCount() === 2, 'group view still holds exactly two');
    const groupAfterReturn = loadedCount();

    return { dropLandedInGroup, pasteLandedInGroup, unorganizedCards, unorganizedEmptyState, allAssetsAfterDrop, groupAfterReturn };
  })()
  `;
}
