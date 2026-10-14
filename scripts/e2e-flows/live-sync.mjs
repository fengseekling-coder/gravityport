// GravityPort React UI flow: mutations made behind the open page arrive through
// the library event stream and reconcile the visible gallery.
export const name = "live-sync";
export const description = "external API create/trash while the page is open -> SSE live refresh updates the gallery without user action";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const seeded = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("live-sync-seed.png", [74, 127, 181]), prompt: "live sync seed",
    });
    const result = await ctx.runInPage(server, liveSyncSource());
    if (result?.initialCount !== 1 || result?.afterCreate !== 2 || result?.afterTrash !== 1) {
      throw new Error(`live-sync result: ${JSON.stringify(result)}`);
    }
    return { seededId: seeded.asset.id, ...result };
  } finally {
    await server.stop();
  }
}

function liveSyncSource() {
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
    const clientToken = () => sessionStorage.getItem('mosa.client-token') || '';
    const cardCount = () => document.querySelectorAll('.asset-card').length;
    const api = (path, method, body) => fetch(path, {
      method: method || 'GET',
      headers: { 'x-mosa-client-token': clientToken(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(method + ' ' + path + ' -> ' + response.status);
      return response.json();
    });

    await waitFor(() => document.querySelector('.app') && cardCount() === 1, 'seeded card rendered');
    const initialCount = cardCount();

    // A canvas-drawn file staged through the real endpoints, created while the
    // page just watches: the SSE stream must bring it in.
    const canvas = document.createElement('canvas');
    canvas.width = 32; canvas.height = 24;
    const context = canvas.getContext('2d');
    context.fillStyle = '#2255aa';
    context.fillRect(0, 0, 32, 24);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const staged = await fetch('/api/import/stage', {
      method: 'POST',
      headers: { 'x-mosa-file-name': 'live-sync-external.png', 'x-mosa-client-token': clientToken() },
      body: blob,
    }).then((r) => r.json());
    await api('/api/assets/import-batch', 'POST', { projectId: 'default', items: [{ imagePath: staged.path }] });
    await waitFor(() => cardCount() === 2, 'external create arrives over SSE');
    const afterCreate = cardCount();

    // External trash of one card reconciles the gallery downward.
    const page = await api('/api/assets?project=default&limit=10');
    const victim = (page.assets || []).find((asset) => !asset.stack);
    await api('/api/assets/batch', 'POST', { action: 'trash', projectId: 'default', assetIds: [victim.id] });
    await waitFor(() => cardCount() === 1, 'external trash arrives over SSE');
    const afterTrash = cardCount();

    return { initialCount, afterCreate, afterTrash };
  })()
  `;
}
