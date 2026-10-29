// GravityPort React UI flow (task 291): manual-import dedupe. Byte-identical
// files skip with 「已在素材库中」, a rescaled copy pops up in the import
// review next to the library original, the review offers to move the original
// into the target group, and 「按所选处理」 applies exactly what was picked; a
// second run through 「取消」 changes nothing.
export const name = "import-dedupe";
export const description = "identical drop skips, rescaled copy opens the review, move+trash apply, cancel keeps everything";

const GROUP_H = "e2e-dedupe-h";
const GROUP_G = "e2e-dedupe-g";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    await ctx.api(server.origin, "POST", "/api/groups", { projectId: "default", name: GROUP_H });
    await ctx.api(server.origin, "POST", "/api/groups", { projectId: "default", name: GROUP_G });
    const result = await ctx.runInPage(server, flowSource());
    if (result?.firstRun?.reviewRows !== 2 || result?.secondRun?.reviewRows !== 1
      || result?.firstRun?.applied !== true || result?.secondRun?.cancelled !== true) {
      throw new Error(`import-dedupe page result: ${JSON.stringify(result)}`);
    }

    const listAll = async () => (await ctx.api(server.origin, "GET", "/api/assets?project=default&limit=250")).assets || [];
    const listTrash = async () => (await ctx.api(server.origin, "GET", "/api/assets?project=default&limit=250&trash=1")).assets || [];
    const all = await listAll();
    const trash = await listTrash();
    const byId = (assets, prefix) => assets.filter((asset) => String(asset.id || "").startsWith(prefix));

    const libOriginal = byId(all, "dedupe-lib-a");
    const freshImport = byId(all, "dedupe-new-c");
    const rescaled = byId(trash, "dedupe-small-b");
    if (libOriginal.length !== 1 || freshImport.length !== 1) {
      throw new Error(`active assets wrong: ${JSON.stringify(all.map((asset) => ({ id: asset.id, group: asset.group })))}`);
    }
    if (libOriginal[0].group !== GROUP_G) {
      throw new Error(`library original did not move to ${GROUP_G}: ${libOriginal[0].group}`);
    }
    if (freshImport[0].group !== GROUP_G) {
      throw new Error(`fresh import did not land in ${GROUP_G}: ${JSON.stringify(freshImport[0])}`);
    }
    if (rescaled.length !== 1 || rescaled[0].trash_reason?.code !== "duplicate-import:user") {
      throw new Error(`rescaled copy missing from Trash: ${JSON.stringify(trash.map((asset) => ({ id: asset.id, reason: asset.trash_reason })))}`);
    }

    // Second run pressed 取消: nothing else moved to Trash and the applied
    // state from the first run is untouched.
    if (trash.length !== 1) {
      throw new Error(`cancel run changed the Trash: ${JSON.stringify(trash.map((asset) => ({ id: asset.id })))}`);
    }
    return { ...result, checks: { originalInG: true, freshInG: true, rescaledTrashed: true, trashUntouched: true } };
  } finally {
    await server.stop();
  }
}

function flowSource() {
  return `(async () => {
    const GROUP_H = ${JSON.stringify(GROUP_H)};
    const GROUP_G = ${JSON.stringify(GROUP_G)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 30000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(150);
      }
      throw new Error('Timed out waiting for ' + label
        + ' | toast=' + (document.querySelector('.toast')?.textContent || '')
        + ' | review=' + Boolean(document.querySelector('.import-review')));
    }
    const loadedCount = () => Number(document.querySelector('.asset-grid')?.dataset.loadedAssets || 0);
    const groupRow = (name) => Array.from(document.querySelectorAll('.sidebar .group-row'))
      .find((button) => button.getAttribute('aria-label') === name) || null;
    const mainNavButton = (label) => Array.from(document.querySelectorAll('.main-nav button'))
      .find((button) => (button.textContent || '').includes(label)) || null;
    // Horizontal-gradient PNGs: same size + same drawing = identical bytes;
    // the half-size copy keeps the pixels (a real duplicate), and the vertical
    // gradient is a genuinely new image (far from every horizontal one).
    async function makeFile(name, width, height, direction, reuseBytesFrom = null) {
      if (reuseBytesFrom) {
        // Same bytes, different name: this is the copy that must skip.
        return new File([reuseBytesFrom], name, { type: 'image/png' });
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      const gradient = context.createLinearGradient(direction === 'vertical' ? 0 : 0, direction === 'vertical' ? 0 : 0, direction === 'vertical' ? 0 : width, direction === 'vertical' ? height : 0);
      gradient.addColorStop(0, '#000000');
      gradient.addColorStop(1, '#ffffff');
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      return new File([blob], name, { type: 'image/png' });
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
    const reviewDialog = () => document.querySelector('.import-review');
    const reviewOption = (text) => Array.from(reviewDialog()?.querySelectorAll('.review-options label') || [])
      .find((label) => (label.textContent || '').includes(text)) || null;
    const reviewSectionRows = (title) => {
      const sections = Array.from(reviewDialog()?.querySelectorAll('.review-section') || []);
      const section = sections.find((node) => (node.querySelector('.review-section-head h4')?.textContent || '').includes(title));
      return section ? section.querySelectorAll('.review-row').length : -1;
    };
    const toastText = () => document.querySelector('.toast')?.textContent || '';

    await waitFor(() => document.querySelector('.app') && document.querySelector('.empty-state') && groupRow(GROUP_H) && groupRow(GROUP_G),
      'app ready with both seeded groups');

    // ── Seed: the library original lives in group H ──
    // The copy that must skip shares the exact File instance, so byte
    // identity never depends on canvas encoding determinism.
    const libFile = await makeFile('dedupe-lib-a.png', 32, 24, 'horizontal');
    groupRow(GROUP_H).click();
    await waitFor(() => groupRow(GROUP_H)?.getAttribute('aria-current') === 'page', 'group H active');
    dropOn(document.querySelector('.workspace'), [libFile]);
    await waitFor(() => loadedCount() === 1, 'library original lands in H');
    // Let group H's own import review finish (one pending round + one clean
    // round) before the next import, so the two reviews never interleave.
    await sleep(3000);

    // ── First run: drop original copy + half-size copy + new image into G ──
    groupRow(GROUP_G).click();
    await waitFor(() => groupRow(GROUP_G)?.getAttribute('aria-current') === 'page', 'group G active');
    dropOn(document.querySelector('.workspace'), [
      await makeFile('dedupe-lib-a-copy.png', 32, 24, 'horizontal', libFile),
      await makeFile('dedupe-small-b.png', 16, 12, 'horizontal'),
      await makeFile('dedupe-new-c.png', 40, 30, 'vertical'),
    ]);
    await waitFor(() => reviewDialog(), 'import review dialog opens');
    await waitFor(() => toastText().includes('已导入 2 张，1 张已在素材库中'), 'dedupe toast text');
    const toastAfterFirstRun = toastText();
    const elsewhereRows = reviewSectionRows('已在素材库的其他位置');
    const duplicateRows = reviewSectionRows('可能重复');
    if (elsewhereRows !== 1 || duplicateRows !== 1) {
      throw new Error('review rows wrong: elsewhere=' + elsewhereRows + ' duplicates=' + duplicateRows
        + ' | dialog=' + (reviewDialog()?.textContent || '').slice(0, 200));
    }
    const firstRunReviewRows = elsewhereRows + duplicateRows;
    reviewOption('移到「' + GROUP_G + '」')?.click();
    reviewOption('删掉新的')?.click();
    const applyButton = Array.from(reviewDialog().querySelectorAll('.review-foot .primary-button'))
      .find((button) => (button.textContent || '').includes('按所选处理'));
    applyButton.click();
    await waitFor(() => !reviewDialog(), 'review closes after 按所选处理');
    const firstRun = { reviewRows: firstRunReviewRows, applied: true, toast: toastAfterFirstRun };

    // ── Second run: copy skips in place (original already in G), the
    // half-size copy pops the review again, then 取消 keeps everything ──
    dropOn(document.querySelector('.workspace'), [
      await makeFile('dedupe-lib-a-copy2.png', 32, 24, 'horizontal', libFile),
      await makeFile('dedupe-small-b2.png', 16, 12, 'horizontal'),
    ]);
    await waitFor(() => reviewDialog(), 'second review dialog opens');
    const secondDuplicateRows = reviewSectionRows('可能重复');
    // The elsewhere section only renders when it has rows; a missing section
    // counts as zero.
    const secondElsewhereRows = Math.max(0, reviewSectionRows('已在素材库的其他位置'));
    if (secondDuplicateRows !== 1 || secondElsewhereRows !== 0) {
      throw new Error('second review rows wrong: elsewhere=' + secondElsewhereRows + ' duplicates=' + secondDuplicateRows);
    }
    const secondRunReviewRows = secondDuplicateRows;
    const cancelButton = Array.from(reviewDialog().querySelectorAll('.review-foot .neutral-button'))
      .find((button) => (button.textContent || '').includes('取消'));
    cancelButton.click();
    await waitFor(() => !reviewDialog(), 'review closes after 取消');
    const secondRun = { reviewRows: secondRunReviewRows, cancelled: true };

    return { firstRun, secondRun };
  })()
  `;
}
