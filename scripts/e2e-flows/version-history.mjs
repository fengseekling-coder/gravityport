// GravityPort React UI flow: version lineage and generation rounds surface in
// the React inspector, and the prompt editor writes through the real API.
export const name = "version-history";
export const description = "parent+child version -> 版本 section lists both and switches -> generation event -> 生成记录 shows the prompt -> prompt editor PATCHes";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const parentCreate = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("version-parent.png", [74, 127, 181]), prompt: "version flow original prompt",
    });
    const parent = { asset: { ...parentCreate.asset, name: parentCreate.asset.name || parentCreate.asset.asset || "version-parent.png" } };
    const child = await ctx.api(server.origin, "POST",
      `/api/assets/default/${encodeURIComponent(parent.asset.id)}/versions`,
      { version_change: "e2e version change" });
    await ctx.api(server.origin, "POST", "/api/generations", {
      projectId: "default",
      output_asset_id: parent.asset.id,
      provider: "e2e-provider",
      model: "e2e-model",
      effective_prompt: "e2e generation prompt marker",
    });
    const result = await ctx.runInPage(server, versionHistorySource({ parentId: parent.asset.id, childId: child.asset?.id || "" }));
    if (result?.versionRows !== 2 || result?.switchedToChild !== true || result?.generationRowShown !== true
      || result?.promptEdited !== true || result?.promptPersisted !== true) {
      throw new Error(`version-history result: ${JSON.stringify({ parent: parent.asset.id, child: child.asset?.id, ...result })}`);
    }
    return { parentId: parent.asset.id, childId: child.asset?.id, ...result };
  } finally {
    await server.stop();
  }
}

function versionHistorySource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      let stable = 0;
      while (Date.now() < deadline) {
        const value = check();
        if (value) { stable += 1; if (stable >= 2) return value; } else stable = 0;
        await sleep(100);
      }
      const genProbe = await fetch('/api/assets/default/' + (window.__mosaSelectedId || '') + '/generation-history')
        .then((r) => r.json()).catch((e) => String(e));
      throw new Error('Timed out waiting for ' + label + ' | cards=' + document.querySelectorAll('.asset-card').length
        + ' | toast=' + (document.querySelector('.toast')?.textContent || '')
        + ' | gen=' + JSON.stringify(genProbe).slice(0, 300));
    }
    const cards = () => document.querySelectorAll('.asset-card').length;

    await waitFor(() => document.querySelector('.app') && cards() >= 1, 'seeded card rendered');
    // Generation rounds are per-asset: select the PARENT (the event's output)
    // by its exact id — unnamed stacks and version children share filenames.
    const parentCard = await waitFor(() => Array.from(document.querySelectorAll('.asset-card'))
      .find((card) => card.dataset.assetId === config.parentId) || null, 'parent card');
    parentCard.click();
    await waitFor(() => Boolean(document.querySelector('.details .asset-title')), 'inspector opens');

    // 版本 section: parent + child, with the parent prompt rendered.
    await waitFor(() => document.querySelectorAll('.version-list[aria-label="版本"] .related').length >= 2
      && (document.querySelector('#asset-prompt')?.textContent || '').includes('version flow original prompt'),
      '版本 section lists both versions with the parent prompt');
    const versionRows = document.querySelectorAll('.version-list[aria-label="版本"] .related').length;

    // 生成记录 section (on the parent — the event's output): the recorded
    // round carries the marker prompt.
    await waitFor(() => (document.body.innerHTML).includes('e2e generation prompt marker'),
      '生成记录 shows the generation prompt');
    const generationRowShown = document.body.innerHTML.includes('e2e generation prompt marker');

    // Switching versions selects the child through the real API.
    const childRow = Array.from(document.querySelectorAll('.version-list[aria-label="版本"] .related'))
      .find((row) => (row.querySelector('span')?.childNodes[0]?.textContent || '').trim() === '版本 2');
    (childRow || document.querySelectorAll('.version-list[aria-label="版本"] .related')[1]).click();
    await waitFor(() => (window.__mosaSelectedId || '') === config.childId && document.querySelectorAll('.version-list[aria-label="版本"] .related').length >= 2,
      'the child version renders in the inspector');
    const switchedToChild = (window.__mosaSelectedId || '') === config.childId;

    // Prompt editor: 编辑 -> textarea -> 保存 PATCHes and persists.
    const editButton = Array.from(document.querySelectorAll('.details .section-action'))
      .find((button) => button.textContent.trim() === '编辑');
    if (!editButton) throw new Error('missing 编辑 action');
    editButton.click();
    const editor = await waitFor(() => document.querySelector('.detail-editor') || null, 'prompt editor');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(editor, 'version flow edited prompt XYZ');
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => {
      if (!document.querySelector('.detail-editor')) return true; // saved: the editor unmounted
      const save = Array.from(document.querySelectorAll('.prompt-editor-actions .primary-button'))
        .find((button) => !button.disabled);
      if (save) save.click();
      return false;
    }, 'save enabled and clicked');
    await waitFor(() => (document.querySelector('#asset-prompt')?.textContent || '').includes('version flow edited prompt XYZ'),
      'edited prompt renders');
    const promptEdited = (document.querySelector('#asset-prompt')?.textContent || '').includes('version flow edited prompt XYZ');
    const persisted = await fetch('/api/assets?project=default&limit=50')
      .then((r) => r.json())
      .then((data) => (data.assets || []).some((a) => (a.prompt || '').includes('version flow edited prompt XYZ')));
    const promptPersisted = persisted === true;

    return { versionRows, switchedToChild, generationRowShown, promptEdited, promptPersisted };
  })()
  `;
}
