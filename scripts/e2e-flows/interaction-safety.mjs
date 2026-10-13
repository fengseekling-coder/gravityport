// GravityPort React UI flow: interaction-safety regressions — gallery
// shortcuts never fire from editable surfaces (⌘A in search, Backspace/Delete
// in the prompt editor), the prompt draft stays bound to its asset across
// switches and in-flight saves, and every batch action targets the real
// logical selection (plain click -> modifier click -> menu trash/favorite/
// cut-paste precision).
export const name = "interaction-safety";
export const description = "keyboard guards -> prompt draft binding (switch/cancel/in-flight save) -> selection unity (modifier re-target, batch trash/favorite/cut precision)";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const alpha = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("safety-alpha.png", [74, 127, 181]), prompt: "safety alpha prompt",
    });
    const beta = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("safety-beta.png", [186, 94, 60]), prompt: "safety beta prompt",
    });
    // A stack to receive a batch cut: two extra members, stack node on top.
    const memberA = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("safety-stack-a.png", [58, 138, 87]), prompt: "safety stack a",
    });
    const memberB = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("safety-stack-b.png", [96, 74, 155]), prompt: "safety stack b",
    });
    const stack = await ctx.api(server.origin, "POST", "/api/asset-stacks", {
      projectId: "default", assetIds: [memberA.asset.id, memberB.asset.id],
    });
    const result = await ctx.runInPage(server, interactionSafetySource({
      alphaId: alpha.asset.id, betaId: beta.asset.id,
      stackCoverId: stack.stack?.cover_asset_id || memberA.asset.id,
    }));
    if (result?.keyboardGuards !== true || result?.promptBinding !== true || result?.promptInFlightSafe !== true
      || result?.selectionUnity !== true || result?.batchCutPrecise !== true) {
      throw new Error(`interaction-safety result: ${JSON.stringify(result)}`);
    }
    // Server-side truth: only alpha's prompt changed, beta is untouched.
    const page = await ctx.api(server.origin, "GET", "/api/assets?project=default&limit=250");
    const promptOf = (id) => (page.assets || []).find((asset) => asset.id === id)?.prompt || "";
    if (promptOf(alpha.asset.id) !== "safety alpha prompt v2") {
      throw new Error(`alpha prompt not saved: ${promptOf(alpha.asset.id)}`);
    }
    if (promptOf(beta.asset.id) !== "safety beta prompt") {
      throw new Error(`beta prompt contaminated: ${promptOf(beta.asset.id)}`);
    }
    return { ...result, alphaId: alpha.asset.id, betaId: beta.asset.id, stackId: stack.stack?.id };
  } finally {
    await server.stop();
  }
}

function interactionSafetySource(config) {
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
      throw new Error('Timed out waiting for ' + label + ' | cards=' + document.querySelectorAll('.asset-card').length
        + ' | ringIds=' + JSON.stringify(Array.from(document.querySelectorAll('.asset-card.asset-selected')).map((card) => (card.getAttribute('data-asset-id') || '').slice(0, 10)))
        + ' | toast=' + (document.querySelector('.toast')?.textContent || '')
        + ' | dialog=' + Boolean(document.querySelector('[role="alertdialog"]')));
    }
    const cardFor = (id) => document.querySelector('.asset-card[data-asset-id="' + id + '"]');
    const rings = () => Array.from(document.querySelectorAll('.asset-card.asset-selected'));
    const navSmall = (label) => Array.from(document.querySelectorAll('.main-nav button'))
      .find((button) => Array.from(button.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === label))
      ?.querySelector('small')?.textContent || '0';
    const navButton = (label) => Array.from(document.querySelectorAll('.main-nav button'))
      .find((button) => Array.from(button.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === label));
    function clickCard(card, modifiers = {}) {
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers }));
    }
    async function menuOn(card, label) {
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 600, clientY: 400 }));
      return waitFor(() => {
        const item = Array.from(document.querySelectorAll('.context-menu button'))
          .find((entry) => entry.textContent.trim() === label);
        return item || null;
      }, 'context menu item ' + label);
    }
    async function api(path, method, body) {
      const token = sessionStorage.getItem('mosa-client-token') || '';
      const response = await fetch(path, {
        method: method || 'GET',
        headers: { 'x-mosa-client-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      if (!response.ok) throw new Error((method || 'GET') + ' ' + path + ' -> ' + response.status + ': ' + text.slice(0, 200));
      return text ? JSON.parse(text) : null;
    }
    const promptOf = async (id) => (await api('/api/assets/default/' + encodeURIComponent(id))).asset.prompt;
    function typeInto(node, value) {
      const proto = node.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(node, value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const inspectorPrompt = () => document.querySelector('#asset-prompt')?.textContent || '';

    await waitFor(() => cardFor(config.alphaId) && cardFor(config.betaId), 'seeded cards render');
    const cardA = () => cardFor(config.alphaId);
    const cardB = () => cardFor(config.betaId);

    // ── 1) Keyboard guards ────────────────────────────────────────────────
    // ⌘A pressed inside the search field selects text, never every asset.
    clickCard(cardA());
    await waitFor(() => rings().length === 1, 'plain click rings card A');
    const searchInput = document.querySelector('.search input');
    if (!searchInput) throw new Error('missing search input');
    searchInput.focus();
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }));
    await sleep(400);
    const searchSelectAllIgnored = rings().length === 1
      && document.activeElement === searchInput
      && !document.querySelector('[role="alertdialog"]');

    // Backspace/Delete inside the prompt editor must not open the trash dialog.
    const editButton = () => Array.from(document.querySelectorAll('.details .section-action'))
      .find((button) => button.textContent.trim() === '编辑');
    editButton().click();
    const editor = await waitFor(() => document.querySelector('.detail-editor') || null, 'prompt editor opens');
    editor.focus();
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
    await sleep(350);
    const backspaceGuard = !document.querySelector('[role="alertdialog"]');
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    await sleep(350);
    const deleteGuard = !document.querySelector('[role="alertdialog"]');
    document.querySelector('.prompt-editor-actions .neutral-button').click();
    await waitFor(() => !document.querySelector('.detail-editor'), 'editor closes on cancel');
    const keyboardGuards = searchSelectAllIgnored && backspaceGuard && deleteGuard;

    // ── 2) Prompt draft binding ───────────────────────────────────────────
    // Editing A then selecting B discards the draft and never writes it.
    clickCard(cardA());
    await waitFor(() => inspectorPrompt().includes('safety alpha prompt'), 'alpha prompt rendered');
    editButton().click();
    await waitFor(() => document.querySelector('.detail-editor'), 'editor opens for alpha');
    typeInto(document.querySelector('.detail-editor'), 'DRAFT must not leak into beta');
    clickCard(cardB());
    await waitFor(() => !document.querySelector('.detail-editor'), 'editor closed on asset switch');
    const switchShowedBeta = inspectorPrompt().includes('safety beta prompt');
    const betaUntouched = (await promptOf(config.betaId)) === 'safety beta prompt';
    const alphaUntouchedByDraft = (await promptOf(config.alphaId)) === 'safety alpha prompt';

    // In-flight save keeps writing to the bound asset while the user moves on.
    clickCard(cardA());
    await waitFor(() => inspectorPrompt().includes('safety alpha prompt'), 'alpha prompt rendered again');
    editButton().click();
    await waitFor(() => document.querySelector('.detail-editor'), 'editor opens for alpha again');
    typeInto(document.querySelector('.detail-editor'), 'safety alpha prompt v2');
    document.querySelector('.prompt-editor-actions .primary-button').click();
    clickCard(cardB());
    let saveLanded = false;
    for (let attempt = 0; attempt < 100 && !saveLanded; attempt += 1) {
      saveLanded = (await promptOf(config.alphaId)) === 'safety alpha prompt v2';
      if (!saveLanded) await sleep(200);
    }
    if (!saveLanded) throw new Error('in-flight save never landed on alpha');
    const betaStillClean = (await promptOf(config.betaId)) === 'safety beta prompt';
    const noEditorAfterSwitch = !document.querySelector('.detail-editor');
    const promptBinding = switchShowedBeta && betaUntouched && alphaUntouchedByDraft && noEditorAfterSwitch;
    const promptInFlightSafe = saveLanded && betaStillClean;

    // ── 3) Selection unity ────────────────────────────────────────────────
    // Plain click A then modifier-click B: the logical selection is exactly B,
    // so a menu trash removes B — not the previously inspected A.
    clickCard(cardA());
    await waitFor(() => rings().length === 1 && rings()[0].getAttribute('data-asset-id') === config.alphaId,
      'plain click focuses A');
    clickCard(cardB(), { ctrlKey: true });
    await waitFor(() => rings().length === 1 && rings()[0].getAttribute('data-asset-id') === config.betaId,
      'modifier click re-targets the selection to B');
    (await menuOn(cardB(), '移至回收站')).click();
    await waitFor(() => Boolean(document.querySelector('[role="alertdialog"]')), 'single trash confirm');
    Array.from(document.querySelectorAll('[role="alertdialog"] button'))
      .find((button) => button.textContent.trim() === '移至回收站').click();
    await waitFor(() => Number(navSmall('回收站')) === 1, 'exactly the modifier-picked card was trashed');
    const keptA = Boolean(cardFor(config.alphaId));
    navButton('回收站').click();
    await waitFor(() => document.querySelectorAll('.asset-card').length === 1, 'trash lists the card');
    (await menuOn(document.querySelector('.asset-card'), '恢复素材')).click();
    await waitFor(() => Number(navSmall('回收站')) === 0, 'restore from trash');
    navButton('所有素材').click();
    await waitFor(() => Boolean(cardFor(config.betaId)), 'beta back in the all view');

    // Batch favorite acts on both modifier-selected cards.
    clickCard(cardA(), { ctrlKey: true });
    await waitFor(() => rings().length === 1 && rings()[0].getAttribute('data-asset-id') === config.alphaId,
      'ring on alpha before batch favorite');
    clickCard(cardB(), { ctrlKey: true });
    await waitFor(() => rings().length === 2, 'two rings after two modifier clicks');
    (await menuOn(cardB(), '收藏')).click();
    await waitFor(() => Number(navSmall('收藏')) === 2, 'batch favorite count');
    const batchFavorite = Number(navSmall('收藏')) === 2;

    // Batch cut-paste: ⌘X with the two-card selection moves exactly those two
    // cards into the seeded stack. Escape first so the batch-favorite cleanup
    // cannot race the selection this segment builds.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    // Clearing never shows a multi-ring again; the refresh the batch favorite
    // triggered may legally re-land the design's implicit single ring on the
    // first card, so the gate is "no batch selection left", not "zero rings".
    await waitFor(() => rings().length <= 1, 'selection cleared before the cut round');
    clickCard(cardA(), { ctrlKey: true });
    await waitFor(() => rings().length === 1, 'one ring after modifier click');
    clickCard(cardB(), { ctrlKey: true });
    await waitFor(() => rings().length === 2, 'two rings before the cut');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', ctrlKey: true, bubbles: true, cancelable: true }));
    await waitFor(() => document.querySelector('.toast')?.textContent.includes('已剪切'), 'cut acknowledged');
    const stackNode = Array.from(document.querySelectorAll('.asset-card'))
      .find((card) => card.querySelector('.stack-mark') && card.getAttribute('data-asset-id') === config.stackCoverId);
    if (!stackNode) throw new Error('stack node missing');
    stackNode.click();
    await waitFor(() => document.querySelectorAll('.asset-card').length === 2
      && !document.querySelector('.asset-card .stack-mark'), 'stack interior shows its two members');
    const pasteDeadline = Date.now() + 20000;
    while (Date.now() < pasteDeadline && document.querySelectorAll('.asset-card').length !== 4) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true }));
      await sleep(600);
    }
    await waitFor(() => document.querySelectorAll('.asset-card').length === 4, 'batch paste landed both cards');
    const stackCountShown = document.querySelector('.viewer-title span')?.textContent?.trim().split(' ')[0] || '';
    const batchCutPrecise = document.querySelectorAll('.asset-card').length === 4 && stackCountShown === '4';

    const selectionUnity = keptA && batchFavorite;
    return { keyboardGuards, promptBinding, promptInFlightSafe, selectionUnity, batchCutPrecise };
  })()
  `;
}
