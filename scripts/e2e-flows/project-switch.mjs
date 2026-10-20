// GravityPort React UI flow: the sidebar project switcher is a transaction —
// switching swaps the whole workspace and back-switching restores it.
export const name = "project-switch";
export const description = "asset created in project alpha -> sidebar switcher appears -> switch shows alpha's gallery -> switch back shows default";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const inDefault = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("default-proj.png", [74, 127, 181]), prompt: "project flow default",
    });
    const inAlpha = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "alpha", imagePath: await ctx.makePng("alpha-proj.png", [181, 68, 74]), prompt: "project flow alpha",
    });
    const result = await ctx.runInPage(server, projectSwitchSource());
    if (result?.switcherVisible !== true || result?.alphaCount !== 1 || result?.defaultCount !== 1
      || result?.alphaPromptShown !== true) {
      throw new Error(`project-switch result: ${JSON.stringify({ ...result, inDefault: inDefault.asset.id, inAlpha: inAlpha.asset.id })}`);
    }
    return { ...result };
  } finally {
    await server.stop();
  }
}

function projectSwitchSource() {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      let stable = 0;
      while (Date.now() < deadline) {
        const value = check();
        if (value) { stable += 1; if (stable >= 2) return value; } else stable = 0;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label + ' | cards=' + document.querySelectorAll('.asset-card').length);
    }
    const cards = () => document.querySelectorAll('.asset-card').length;
    async function chooseProject(name) {
      const trigger = await waitFor(() => document.querySelector('.sidebar-project .toolbar-select') || null, 'project switcher');
      trigger.click();
      const option = await waitFor(() => Array.from(document.querySelectorAll('.toolbar-select-menu [role="option"]'))
        .find((node) => node.textContent.trim() === name) || null, 'project option ' + name);
      option.click();
      await waitFor(() => !document.querySelector('.toolbar-select-menu'), 'project menu closes');
    }

    await waitFor(() => document.querySelector('.app') && cards() === 1, 'default project card');
    // The switcher appears once the project list loads (two projects); a
    // slow start (Windows CI) must not read it before that.
    const switcherVisible = Boolean(await waitFor(() => document.querySelector('.sidebar-project .toolbar-select'), 'project switcher shown', 15000).catch(() => null));

    await chooseProject('alpha');
    await waitFor(() => cards() === 1, "alpha project shows its own card");
    const alphaCount = cards();
    document.querySelector('.asset-card').click();
    await waitFor(() => (document.querySelector('#asset-prompt')?.textContent || '').includes('project flow alpha'),
      'alpha inspector shows the alpha prompt');
    const alphaPromptShown = (document.querySelector('#asset-prompt')?.textContent || '').includes('project flow alpha');

    await chooseProject('default');
    await waitFor(() => cards() === 1, 'default project restored');
    const defaultCount = cards();

    return { switcherVisible, alphaCount, alphaPromptShown, defaultCount };
  })()
  `;
}
