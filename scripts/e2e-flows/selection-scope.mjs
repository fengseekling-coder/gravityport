// GravityPort React UI flow: the selection is bound to the view it was made
// in. A search/filter/project change resets it, so hidden selections can
// never be targeted by Delete or batch actions; a same-view refresh keeps the
// entries that are still visible and drops the ones that left. After a view
// change the inspector lands on the view's first card (the design's implicit
// single selection) — the ring sits on a VISIBLE card, never on a hidden one.
export const name = "selection-scope";
export const description = "multi-select -> search narrows: the ring lands on the visible needle card (hidden A/B gone) -> Delete+confirm trashes exactly that visible card -> project switch re-lands -> same-view refresh prunes an externally trashed member";

import { CHOOSE_PROJECT_SOURCE } from "./_shared.mjs";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const alpha = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("scope-alpha.png", [74, 127, 181]), prompt: "scope alpha",
    });
    const beta = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("scope-beta.png", [186, 94, 60]), prompt: "scope beta",
    });
    const gamma = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("scope-gamma.png", [58, 138, 87]), prompt: "scope needle unique",
    });
    const inOther = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "other", imagePath: await ctx.makePng("scope-other.png", [96, 74, 155]), prompt: "scope other project",
    });
    const result = await ctx.runInPage(server, selectionScopeSource({
      alphaId: alpha.asset.id, betaId: beta.asset.id, gammaId: gamma.asset.id,
    }));
    if (result?.multiSelected !== 2 || result?.searchLandedOnVisibleCard !== true
      || result?.deleteHitOnlyTheVisibleCard !== true || result?.roundTripSingleRing !== true
      || result?.projectSwitchRelanded !== true || result?.refreshPrunedTrashedMember !== true) {
      throw new Error(`selection-scope result: ${JSON.stringify(result)}`);
    }
    // Server-side truth: exactly the two deliberately trashed cards moved,
    // and the multi-selection from the first segment never reached the server.
    const page = await ctx.api(server.origin, "GET", "/api/assets?project=default&limit=250");
    const normalIds = new Set((page.assets || []).map((asset) => asset.id));
    if (normalIds.size !== 1 || !normalIds.has(alpha.asset.id)) {
      throw new Error(`the default project must keep exactly alpha, got ${JSON.stringify([...normalIds])}`);
    }
    const trashPage = await ctx.api(server.origin, "GET", "/api/assets?project=default&trash=1&limit=250");
    const trashIds = new Set((trashPage.assets || []).map((asset) => asset.id));
    if (trashIds.size !== 2 || !trashIds.has(beta.asset.id) || !trashIds.has(gamma.asset.id)) {
      throw new Error(`trash must hold exactly beta+gamma, got ${trashIds.size}`);
    }
    const otherPage = await ctx.api(server.origin, "GET", "/api/assets?project=other&limit=250");
    if (!(otherPage.assets || []).some((asset) => asset.id === inOther.asset.id)) {
      throw new Error("the other project's asset must stay untouched");
    }
    return { ...result, betaId: beta.asset.id, gammaId: gamma.asset.id };
  } finally {
    await server.stop();
  }
}

function selectionScopeSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${CHOOSE_PROJECT_SOURCE}
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      let stable = 0;
      while (Date.now() < deadline) {
        const value = check();
        if (value) { stable += 1; if (stable >= 2) return value; } else stable = 0;
        await sleep(100);
      }
      e2eTimeoutReport(label, timeoutMs);
      throw new Error('Timed out waiting for ' + label + ' | cards=' + document.querySelectorAll('.asset-card').length
        + ' | selected=' + JSON.stringify(selectedIds())
        + ' | toast=' + (document.querySelector('.toast')?.textContent || ''));
    }
    const cards = () => Array.from(document.querySelectorAll('.asset-card'));
    const plain = () => cards().filter((card) => !card.querySelector('.stack-mark'));
    const selectedIds = () => Array.from(document.querySelectorAll('.asset-card.asset-selected'))
      .map((card) => card.getAttribute('data-asset-id'));
    function clickCard(card, modifiers = {}) {
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers }));
    }
    function typeSearch(text) {
      const input = document.querySelector('.search input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input;
    }
    function cardForId(id) {
      return document.querySelector('.asset-card[data-asset-id="' + id + '"]');
    }

    await waitFor(() => plain().length === 3, 'three seeded cards');

    // ── 1) select two cards, then search: the hidden selection resets ──
    clickCard(cardForId(config.alphaId));
    clickCard(cardForId(config.betaId), { ctrlKey: true });
    await waitFor(() => selectedIds().length === 2, 'two selected rings');
    const multiSelected = selectedIds().length;
    typeSearch('needle');
    await waitFor(() => plain().length === 1
      && plain()[0].getAttribute('data-asset-id') === config.gammaId, 'search narrows to the needle card');
    // The ring must sit on the one VISIBLE card — A/B stayed behind with the
    // old view, exactly one implicit selection re-lands on the needle.
    await waitFor(() => selectedIds().length === 1 && selectedIds()[0] === config.gammaId,
      'selection re-lands on the visible needle card');
    const searchLandedOnVisibleCard = selectedIds().length === 1 && selectedIds()[0] === config.gammaId;

    // ── 2) Delete acts on the visible card only, never the hidden pair ──
    // The re-landed ring is the app's own pick: Delete ignores it until the
    // user picks the card (task 202), and the hidden pair is never touched.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await sleep(500);
    if (document.querySelector('[role="alertdialog"]') || plain().length !== 1) {
      throw new Error('Delete acted on the implicit focus the app picked');
    }
    clickCard(plain()[0]);
    await waitFor(() => selectedIds().length === 1 && selectedIds()[0] === config.gammaId, 'needle picked');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await waitFor(() => Boolean(document.querySelector('[role="alertdialog"]')), 'delete confirm opens');
    const confirm = Array.from(document.querySelectorAll('[role="alertdialog"] button'))
      .find((button) => button.textContent.trim() === '移至回收站');
    confirm.click();
    await waitFor(() => !document.querySelector('[role="alertdialog"]')
      && plain().length === 0, 'needle left the narrowed view');
    typeSearch('');
    await waitFor(() => plain().length === 2, 'clearing the search shows alpha+beta');
    await waitFor(() => selectedIds().length === 1
      && (selectedIds()[0] === config.alphaId || selectedIds()[0] === config.betaId),
      'the surviving view holds a single visible ring');
    const deleteHitOnlyTheVisibleCard = selectedIds().length === 1
      && (selectedIds()[0] === config.alphaId || selectedIds()[0] === config.betaId);
    const roundTripSingleRing = selectedIds().length === 1;

    // ── 3) Project switch re-lands the selection on the new view ──
    await chooseProject('other');
    await waitFor(() => plain().length === 1
      && selectedIds().length === 1
      && selectedIds()[0] !== config.alphaId
      && selectedIds()[0] !== config.betaId, 'other project re-lands on its own card');
    const projectSwitchRelanded = selectedIds().length === 1
      && selectedIds()[0] !== config.alphaId
      && selectedIds()[0] !== config.betaId;
    await chooseProject('default');
    await waitFor(() => plain().length === 2, 'back on the default project');

    // ── 4) Same-view refresh: prunes exactly the member that left ──
    // A plain click normalizes the inspector, then a ctrl-click adds beta to
    // the inspected alpha (the implicit selection, task 155).
    clickCard(cardForId(config.alphaId));
    await waitFor(() => selectedIds().length === 1 && selectedIds()[0] === config.alphaId, 'alpha singly selected');
    clickCard(cardForId(config.betaId), { ctrlKey: true });
    await waitFor(() => selectedIds().length === 2, 'two rings again');
    // Externally trash beta; the SSE-driven same-view refresh must drop it
    // from the selection while alpha stays selected.
    const token = sessionStorage.getItem('mosa.client-token') || '';
    const response = await fetch('/api/assets/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mosa-client-token': token },
      body: JSON.stringify({ action: 'trash', projectId: 'default', assetIds: [config.betaId] }),
    });
    if (!response.ok) throw new Error('external trash failed: ' + response.status);
    await waitFor(() => selectedIds().length === 1
      && selectedIds()[0] === config.alphaId
      && !cardForId(config.betaId), 'refresh pruned the trashed member');
    const refreshPrunedTrashedMember = selectedIds().length === 1
      && selectedIds()[0] === config.alphaId
      && !cardForId(config.betaId);

    return { multiSelected, searchLandedOnVisibleCard, deleteHitOnlyTheVisibleCard,
      roundTripSingleRing, projectSwitchRelanded, refreshPrunedTrashedMember };
  })()
  `;
}
