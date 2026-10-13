// GravityPort React UI flow: project switching is transactional under fault
// injection — a failed load reverts to the previous project with its view
// state, a slow project never displays the old project's cards, and rapid
// consecutive switches settle exactly on the last chosen project.
export const name = "project-switch-resilience";
export const description = "failed alpha load reverts to default with view state -> delayed alpha load shows no stale default cards -> rapid default/alpha switches land on the final choice";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const inDefault = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("resilience-default.png", [74, 127, 181]), prompt: "resilience default prompt",
    });
    const inAlpha = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "alpha", imagePath: await ctx.makePng("resilience-alpha.png", [186, 94, 60]), prompt: "resilience alpha prompt",
    });
    const result = await ctx.runInPage(server, projectSwitchResilienceSource({
      defaultId: inDefault.asset.id, alphaId: inAlpha.asset.id,
    }));
    if (result?.failReverted !== true || result?.failKeptViewState !== true || result?.delayNeverShowedStale !== true
      || result?.rapidSwitchSettled !== true) {
      throw new Error(`project-switch-resilience result: ${JSON.stringify(result)}`);
    }
    return { ...result, defaultId: inDefault.asset.id, alphaId: inAlpha.asset.id };
  } finally {
    await server.stop();
  }
}

function projectSwitchResilienceSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      let stable = 0;
      while (Date.now() < deadline) {
        const value = check();
        if (value) { stable += 1; if (stable >= 2) return value; } else stable = 0;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label + ' | cards=' + document.querySelectorAll('.asset-card').length
        + ' | switcher=' + (document.querySelector('.sidebar-project .toolbar-select span')?.textContent || '?')
        + ' | toast=' + (document.querySelector('.toast')?.textContent || ''));
    }
    const cardFor = (id) => document.querySelector('.asset-card[data-asset-id="' + id + '"]');
    const cards = () => Array.from(document.querySelectorAll('.asset-card'));
    const switcherLabel = () => document.querySelector('.sidebar-project .toolbar-select span')?.textContent?.trim() || '';
    async function chooseProject(name) {
      const trigger = await waitFor(() => document.querySelector('.sidebar-project .toolbar-select') || null, 'project switcher');
      trigger.click();
      const option = await waitFor(() => Array.from(document.querySelectorAll('.toolbar-select-menu [role="option"]'))
        .find((node) => node.textContent.trim() === name) || null, 'project option ' + name);
      option.click();
      await waitFor(() => !document.querySelector('.toolbar-select-menu'), 'project menu closes');
    }
    // Fetch fault injection around the real network; the original fetch stays
    // recoverable so later segments run clean.
    if (!window.__origFetch) window.__origFetch = window.fetch.bind(window);
    const chain = () => window.fetch;
    function patchFetch(matcher, behavior) {
      const previous = chain();
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : String(input.url);
        if (matcher(url)) return behavior(url, init, () => previous(input, init));
        return previous(input, init);
      };
    }
    function unpatchFetch() {
      if (window.__origFetch) window.fetch = window.__origFetch;
    }
    const assetPageFor = (project) => (url) => url.includes('/api/assets?') && url.includes('project=' + project) && !url.includes('project=' + project + '-');

    await waitFor(() => document.querySelector('.app') && cardFor(config.defaultId), 'default project card renders');
    const switcherVisible = Boolean(document.querySelector('.sidebar-project .toolbar-select'));

    // A view-state fingerprint the revert must restore verbatim: a search
    // filter (kept in the input, still matching the default asset so the
    // grid and inspector stay observable) and the inspector selection.
    cardFor(config.defaultId).click();
    await waitFor(() => (document.querySelector('#asset-prompt')?.textContent || '').includes('resilience default prompt'),
      'default inspector opens');
    const searchInput = document.querySelector('.search input');
    const inputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    inputSetter.call(searchInput, 'resilience');
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => searchInput.value === 'resilience' && Boolean(cardFor(config.defaultId)),
      'search filter applied while the default card stays visible');

    // ── 1) Failed alpha load reverts to default, view state intact ──
    patchFetch(assetPageFor('alpha'), async () => new Response(JSON.stringify({ error: 'injected failure' }), {
      status: 500, headers: { 'content-type': 'application/json' } }));
    await chooseProject('alpha');
    await waitFor(() => (document.querySelector('.toast')?.textContent || '').includes('项目切换失败'), 'revert toast');
    // The restored view keeps the marker search filter, so the grid is empty —
    // the inspector (id-addressed) and the switcher are the truth here.
    await waitFor(() => switcherLabel() === 'default' && !cardFor(config.alphaId)
      && (document.querySelector('#asset-prompt')?.textContent || '').includes('resilience default prompt'),
      'default project restored with its inspector');
    const failReverted = switcherLabel() === 'default' && !cardFor(config.alphaId)
      && (document.querySelector('#asset-prompt')?.textContent || '').includes('resilience default prompt');
    const failKeptViewState = searchInput.value === 'resilience' && Boolean(cardFor(config.defaultId));
    unpatchFetch();

    // ── 2) Delayed alpha load: the old project's cards never linger ──
    patchFetch(assetPageFor('alpha'), async (url, init, passthrough) => {
      await sleep(1500);
      return passthrough();
    });
    await chooseProject('alpha');
    await sleep(400);
    const staleDuringDelay = cards().find((card) => card.getAttribute('data-asset-id') === config.defaultId);
    const delayNeverShowedStale = !staleDuringDelay;
    await waitFor(() => Boolean(cardFor(config.alphaId)) && switcherLabel() === 'alpha', 'alpha card after the delay');
    await waitFor(() => (document.querySelector('#asset-prompt')?.textContent || '').includes('resilience alpha prompt'),
      'alpha inspector after the delay');
    unpatchFetch();

    // ── 3) Rapid consecutive switches settle on the final choice ──
    patchFetch((url) => url.includes('/api/assets?'), async (url, init, passthrough) => {
      await sleep(600);
      return passthrough();
    });
    await chooseProject('default');
    await chooseProject('alpha');
    await chooseProject('default');
    await waitFor(() => switcherLabel() === 'default' && Boolean(cardFor(config.defaultId)) && !cardFor(config.alphaId),
      'rapid switches land on default');
    // Late responses for abandoned switches must not flip the view afterwards.
    await sleep(1800);
    const rapidSwitchSettled = switcherLabel() === 'default' && Boolean(cardFor(config.defaultId))
      && !cardFor(config.alphaId)
      && (document.querySelector('#asset-prompt')?.textContent || '').includes('resilience default prompt');
    unpatchFetch();

    return { switcherVisible, failReverted, failKeptViewState, delayNeverShowedStale, rapidSwitchSettled };
  })()
  `;
}
