// GravityPort React UI flow: multi-file drop import lands through the staging
// endpoints; unsupported types surface a real failure toast, never a fake
// success.
export const name = "import-batch-and-errors";
export const description = "two-file drop imports both -> unsupported text file paste fails honestly with a toast and imports nothing";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const result = await ctx.runInPage(server, importSource());
    if (result?.droppedCount !== 2 || result?.rejectedImport !== true || result?.countAfterReject !== 2) {
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
      canvas.getContext('2d').fillRect(0, 0, 32, 24);
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

    dropOn(workspace, [await makeFile('batch-one.png', 'image/png'), await makeFile('batch-two.png', 'image/png')]);
    await waitFor(() => cardCount() === 2, 'both dropped files imported');
    const droppedCount = cardCount();

    // A text file matches no supported media extension: the UI must refuse it
    // loudly instead of pretending it imported.
    dispatchPaste(new File(['not an image'], 'notes.txt', { type: 'text/plain' }));
    await waitFor(() => document.querySelector('.toast')?.textContent.includes('导入失败'), 'unsupported type rejected');
    await sleep(400);
    const rejectedImport = cardCount() === 2;
    const countAfterReject = cardCount();

    return { droppedCount, rejectedImport, countAfterReject };
  })()
  `;
}
