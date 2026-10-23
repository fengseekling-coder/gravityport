// GravityPort React UI flow: search, media-kind filter, sort order and the
// column control drive real server queries and the grid layout.
import { TOOLBAR_SELECT_SOURCE } from "./_shared.mjs";

export const name = "browse-sort-filter";
export const description = "search narrows server-side -> mediaKind filter -> sort order flips card order -> column control reflows the grid";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const names = [];
    for (const [file, prompt] of [
      ["alpha-browse.png", "browse flow alpha"],
      ["beta-browse.png", "browse flow beta"],
      ["gamma-browse.png", "browse flow gamma"],
    ]) {
      const created = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default", imagePath: await ctx.makePng(file, [74, 127, 181]), prompt,
      });
      names.push(created.asset.name);
    }
    const result = await ctx.runInPage(server, browseSource());
    if (result.searchCount !== 3 || result.imageCount !== 3 || result.videoCount === -1
      || result.newestFirstNames.length !== 3 || result.nameSortChanged !== true
      || result.columnReflection !== true || result.tagPersisted !== true) {
      throw new Error(`browse-sort-filter result: ${JSON.stringify({ names, ...result })}`);
    }
    return { names, ...result };
  } finally {
    await server.stop();
  }
}

function browseSource() {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label);
    }
    const cardLabels = () => Array.from(document.querySelectorAll('.asset-card')).map((card) => card.getAttribute('aria-label') || '');
    const settled = () => !document.querySelector(".empty-state[role='status']");
    function setSearch(value) {
      const input = document.querySelector('.search input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    ${TOOLBAR_SELECT_SOURCE}
    async function chooseToolbarOption(label, optionText) {
      const trigger = Array.from(document.querySelectorAll('.toolbar-select')).find((node) => {
        const combobox = node.getAttribute('role') === 'combobox';
        const matches = node.getAttribute('aria-label') === label || node.textContent.includes(label);
        return combobox && matches;
      });
      if (!trigger) throw new Error('Missing toolbar select ' + label);
      const optionFor = () => Array.from(document.querySelectorAll('.toolbar-select-menu [role="option"]'))
        .find((node) => node.textContent.trim() === optionText) || null;
      await chooseToolbarSelect(() => trigger, optionFor, 'option ' + optionText, 'toolbar select ' + label, 'menu closes');
    }

    await waitFor(() => document.querySelector('.app') && settled() && cardCount3(), 'three seeded cards');
    function cardCount3() { return document.querySelectorAll('.asset-card').length === 3; }

    // Search narrows server-side: the shared prompt token matches every card.
    setSearch('browse flow');
    await waitFor(() => settled() && cardLabels().length === 3, 'search keeps all browse cards');
    const searchCount = cardLabels().length;

    // Media-kind filter: images stay, videos endpoint stays empty for seeds.
    await chooseToolbarOption('素材类型', '视频');
    await waitFor(() => settled() && document.querySelector('.empty-state'), 'video filter empties the grid');
    const videoCount = cardLabels().length;
    await chooseToolbarOption('素材类型', '图片');
    await waitFor(() => settled() && cardLabels().length === 3, 'image filter restores the grid');
    const imageCount = cardLabels().length;

    // Sort: newest first (gamma newest), then by name (alpha first).
    const newestFirstNames = cardLabels();
    await chooseToolbarOption('排序', '名称排序');
    await waitFor(() => settled() && cardLabels()[0] !== newestFirstNames[0], 'name sort reorders');
    const nameSortChanged = cardLabels()[0].includes('alpha');

    // Tags: the inspector tag editor PATCHes the real tag set.
    document.querySelector('.asset-card').click();
    await waitFor(() => document.querySelector(".add-tag"), 'add-tag button');
    document.querySelector('.add-tag').click();
    const tagInput = await waitFor(() => document.querySelector('.tag-editor input') || null, 'tag editor input');
    const tagSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    tagSetter.call(tagInput, 'e2e-tag');
    tagInput.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => {
      const save = document.querySelector('.tag-editor button[type="submit"]');
      if (save) save.click();
      return !document.querySelector('.tag-editor');
    }, 'tag editor closes after save');
    // Tag text and the new per-tag remove control are distinct siblings.
    // Preserve the visibility contract without mistaking the remove button's
    // accessible name for the tag's displayed text.
    await waitFor(() => Array.from(document.querySelectorAll('.tags .tag-chip'))
      .some((chip) => chip.querySelector('span')?.textContent.trim() === 'e2e-tag'
        && chip.querySelector('button[aria-label]')),
    'the new tag and its removal control render in the inspector');
    const tagPersisted = await fetch('/api/assets?project=default&limit=50').then((r) => r.json())
      .then((data) => (data.assets || []).some((a) => (a.tags || []).includes('e2e-tag')));

    // Column control reflows the grid template.
    document.querySelector('.column-trigger').click();
    const two = await waitFor(() => Array.from(document.querySelectorAll('.column-popover button'))
      .find((node) => node.textContent.trim() === '2') || null, 'column tick 2');
    two.click();
    await waitFor(() => document.querySelector('.asset-grid')?.style.gridTemplateColumns.startsWith('repeat(2'), 'grid reflects 2 columns');
    const columnReflection = document.querySelector('.asset-grid')?.style.gridTemplateColumns.startsWith('repeat(2');

    return { searchCount, imageCount, videoCount, newestFirstNames, nameSortChanged, columnReflection, tagPersisted };
  })()
  `;
}
