// GravityPort React UI flow: multi-file drop import lands through the staging
// endpoints; unsupported types surface a real failure toast, never a fake
// success. Task 382: a CJK-named drop keeps its readable name everywhere the
// UI shows it (card aria-label, inspector title, viewer title) instead of the
// old `asset-<stamp>` slug.
export const name = "import-batch-and-errors";
export const description = "three-file drop imports all (CJK name intact on card/inspector/viewer) -> unsupported text file paste fails honestly with a toast and imports nothing";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const result = await ctx.runInPage(server, importSource());
    if (result?.droppedCount !== 3 || result?.rejectedImport !== true || result?.countAfterReject !== 3
      || result?.cjkInspectorName !== "拖入-甲.png" || result?.cjkViewerName !== "拖入-甲.png") {
      throw new Error(`import-batch-and-errors result: ${JSON.stringify(result)}`);
    }
    return result;
  } finally {
    await server.stop();
  }
}

function importSource() {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(120);
      }
      throw new Error('Timed out waiting for ' + label);
    }
    const cardCount = () => document.querySelectorAll('.asset-card').length;
    async function makeFile(name, type) {
      const canvas = document.createElement('canvas');
      canvas.width = 32; canvas.height = 24;
      const context = canvas.getContext('2d');
      context.fillStyle = '#333333';
      context.fillRect(0, 0, 32, 24);
      // Name-seeded block noise: identical bytes skip as already-in-library
      // and look-alike images open the import review (task 291); this flow
      // drops files that must all import quietly, so each gets its own pattern.
      let seed = 2166136261;
      for (const ch of name) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619) >>> 0;
      for (let y = 0; y < 24; y += 3) {
        for (let x = 0; x < 32; x += 4) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          const level = seed >>> 24;
          context.fillStyle = 'rgba(' + level + ',' + level + ',' + level + ',0.7)';
          context.fillRect(x, y, 4, 3);
        }
      }
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

    await waitFor(() => document.querySelector('.app') && document.querySelector('.empty-state'), 'empty library ready');
    const workspace = document.querySelector('.workspace');

    dropOn(workspace, [await makeFile('batch-one.png', 'image/png'), await makeFile('batch-two.png', 'image/png'), await makeFile('拖入-甲.png', 'image/png')]);
    await waitFor(() => cardCount() === 3, 'all three dropped files imported');
    const droppedCount = cardCount();

    // Task 382: the CJK drop keeps its readable display name — no machine
    // slug — on the card, in the inspector title, and in the viewer title.
    const cjkCard = () => [...document.querySelectorAll('.asset-card[aria-label]')].find((card) => card.getAttribute('aria-label').includes('拖入-甲.png'));
    await waitFor(() => cjkCard() && cjkCard().getAttribute('aria-label') === '查看素材 拖入-甲.png', 'CJK card carries the readable name');
    cjkCard().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitFor(() => (document.querySelector('.details .asset-name')?.textContent || '') === '拖入-甲.png', 'inspector shows 拖入-甲.png');

    // A text file matches no supported media extension: the UI must refuse it
    // loudly instead of pretending it imported.
    dispatchPaste(new File(['not an image'], 'notes.txt', { type: 'text/plain' }));
    await waitFor(() => /无法导入。1 个文件格式不支持。/.test(document.querySelector('.toast')?.textContent || ''), 'unsupported type rejected');
    await sleep(400);
    const rejectedImport = cardCount() === 3;
    const countAfterReject = cardCount();

    cjkCard().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await waitFor(() => (document.querySelector('.viewer-title strong')?.textContent || '') === '拖入-甲.png', 'viewer title shows 拖入-甲.png');

    return { droppedCount, rejectedImport, countAfterReject, cjkInspectorName: document.querySelector('.details .asset-name')?.textContent || '', cjkViewerName: document.querySelector('.viewer-title strong')?.textContent || '' };
  })()
  `;
}
