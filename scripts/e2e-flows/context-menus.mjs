// GravityPort React UI flow: the completed context menus — stack cards,
// blank areas, group submenus. Every UI step is checked against the server
// through the in-page API (session token) and re-verified from node via ctx.api.
export const name = "context-menus";
export const description = "stack card menu (open/rename/group/paste/dissolve/trash) -> blank-area menus (back-to-library/stack-selected) -> multi-select and stack copy (files/paths) -> asset menu group submenu -> server truth at every step";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    // 4 loose assets + one 3-member stack + one group holding loose-4.
    const loose = [];
    for (const [name, color] of [["loose-1", [74, 127, 181]], ["loose-2", [186, 94, 60]], ["loose-3", [58, 138, 87]], ["loose-4", [96, 74, 155]]]) {
      const created = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default", imagePath: await ctx.makePng(`ctx-${name}.png`, color), prompt: `context menu ${name}`,
      });
      loose.push(created.asset.id);
    }
    const members = [];
    for (const [name, color] of [["member-1", [33, 77, 121]], ["member-2", [121, 77, 33]], ["member-3", [77, 121, 33]]]) {
      const created = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default", imagePath: await ctx.makePng(`ctx-${name}.png`, color), prompt: `context menu ${name}`,
      });
      members.push(created.asset.id);
    }
    const stack = await ctx.api(server.origin, "POST", "/api/asset-stacks", {
      projectId: "default", assetIds: members,
    });
    const stackId = stack.stack?.id;
    const coverId = stack.stack?.cover_asset_id || members[0];
    if (!stackId) throw new Error(`stack create failed: ${JSON.stringify(stack)}`);
    const seedGroup = `上下文菜单组-${Date.now().toString(36)}`;
    await ctx.api(server.origin, "POST", "/api/groups", { projectId: "default", name: seedGroup });
    await ctx.api(server.origin, "POST", "/api/assets/batch", {
      action: "group", projectId: "default", assetIds: [loose[3]], group: seedGroup,
    });

    const config = {
      looseIds: loose, memberIds: members, stackId, coverId, seedGroup,
      renamedStack: `上下文菜单堆叠-${Date.now().toString(36)}`,
      newGroup: `新分组移入-${Date.now().toString(36)}`,
    };
    const result = await ctx.runInPage(server, contextMenusSource(config));
    if (!result || result.failedSteps?.length) {
      throw new Error(`context-menus page result: ${JSON.stringify(result)}`);
    }

    // Node-side re-verification of the final server state: the dissolved
    // stack's members (and the pasted loose asset) are loose again, the
    // trashed stack's members are in trash, and nothing else remains.
    const root = await ctx.api(server.origin, "GET", "/api/assets?project=default&limit=250");
    const rootIds = (root.assets || []).map(asset => asset.id).sort();
    const expectedRoot = [loose[0], loose[3], ...members].sort();
    if (JSON.stringify(rootIds) !== JSON.stringify(expectedRoot)) {
      throw new Error(`root view mismatch: ${JSON.stringify(rootIds)} != ${JSON.stringify(expectedRoot)}`);
    }
    const trashed = await ctx.api(server.origin, "GET", "/api/assets?project=default&trash=1&limit=250");
    const trashedIds = new Set((trashed.assets || []).map(asset => asset.id));
    for (const id of [loose[1], loose[2]]) {
      if (!trashedIds.has(id)) throw new Error(`stack-to-trash member ${id} missing from trash`);
    }
    const newGroupPage = await ctx.api(server.origin, "GET", `/api/assets?project=default&group=${encodeURIComponent(config.newGroup)}&limit=250`);
    if (!(newGroupPage.assets || []).some(asset => asset.id === loose[3])) {
      throw new Error(`asset not in created group: ${JSON.stringify(newGroupPage.assets?.map(a => a.id))}`);
    }
    const dissolvedCover = (root.assets || []).find(asset => asset.id === coverId);
    if (!dissolvedCover || dissolvedCover.stack) {
      throw new Error(`dissolved stack still annotates its cover: ${JSON.stringify(dissolvedCover?.stack)}`);
    }
    return { steps: result.steps?.length || 0, stackId, seedGroup, newGroup: config.newGroup };
  } finally {
    await server.stop();
  }
}

function contextMenusSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const steps = [];
    const failedSteps = [];
    async function step(name, action) {
      try {
        const detail = await action();
        steps.push(name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
        console.log('[context-menus-flow] step ok:', name, detail === undefined ? '' : JSON.stringify(detail));
      } catch (error) {
        failedSteps.push(name + ' :: ' + error.message);
        console.log('[context-menus-flow] step FAIL:', name, error.message);
      }
    }
    async function waitFor(check, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label
        + ' | cards=' + document.querySelectorAll('.asset-card').length
        + ' | toast=' + (document.querySelector('.toast')?.textContent || ''));
    }
    const cardFor = (id) => document.querySelector('.asset-card[data-asset-id="' + id + '"]');
    const activeStackCard = () => Array.from(document.querySelectorAll('.asset-card')).find((card) => card.querySelector('.stack-mark'));
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
    const rootAssets = async () => (await api('/api/assets?project=default&limit=250')).assets || [];
    const assetById = async (id) => (await rootAssets()).find((asset) => asset.id === id) || null;
    function menuButton(label) {
      const menu = document.querySelector('.context-menu');
      if (!menu) return null;
      return Array.from(menu.querySelectorAll('button'))
        .find((button) => Array.from(button.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === label)) || null;
    }
    const menuLabels = () => Array.from(document.querySelectorAll('.context-menu > .menu-row > button'))
      .map((button) => Array.from(button.querySelectorAll(':scope > span')).map((span) => span.textContent.trim()).join(''));
    function submenuButton(label) {
      const submenu = document.querySelector('.context-submenu');
      if (!submenu) return null;
      return Array.from(submenu.querySelectorAll('button'))
        .find((button) => Array.from(button.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === label)) || null;
    }
    async function openMenu(card) {
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 640, clientY: 400 }));
      return waitFor(() => document.querySelector('.context-menu') || null, 'context menu opens');
    }
    async function openBlankMenu() {
      document.querySelector('.asset-grid').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 700, clientY: 500 }));
      return waitFor(() => document.querySelector('.context-menu') || null, 'blank context menu opens');
    }
    const closeMenu = () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return waitFor(() => !document.querySelector('.context-menu'), 'context menu closes');
    };
    async function clickMenuItem(label) {
      const item = await waitFor(() => menuButton(label), 'menu item ' + label);
      item.click();
      return waitFor(() => !document.querySelector('.context-menu'), 'menu closes after ' + label);
    }
    async function openSubmenuAndClick(parentLabel, itemLabel) {
      const parent = await waitFor(() => menuButton(parentLabel), 'menu item ' + parentLabel);
      parent.click();
      const item = await waitFor(() => submenuButton(itemLabel), 'submenu item ' + itemLabel);
      item.click();
      return waitFor(() => !document.querySelector('.context-menu'), 'menu closes after ' + itemLabel);
    }
    async function dialogSubmit(value, buttonLabel) {
      const input = await waitFor(() => document.querySelector('.group-dialog input'), 'dialog input');
      // A click inside the dialog must stay inside: reaching the backdrop
      // would close it, and a real Save click would lose the submission.
      input.click();
      await sleep(150);
      if (!document.querySelector('.group-dialog')) throw new Error('a click inside the dialog closed it');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const button = Array.from(document.querySelectorAll('.group-dialog button'))
        .find((entry) => entry.textContent.trim() === buttonLabel);
      button.click();
      return waitFor(() => !document.querySelector('.group-dialog'), 'dialog closes');
    }
    async function confirmDialog(titleText, buttonLabel) {
      const modal = await waitFor(() => {
        const candidate = document.querySelector('.delete-modal');
        return candidate && candidate.querySelector('h3')?.textContent === titleText ? candidate : null;
      }, 'confirm dialog ' + titleText);
      modal.querySelector('p').click();
      await sleep(150);
      if (!document.querySelector('.delete-modal')) throw new Error('a click inside the confirm dialog closed it');
      const button = Array.from(document.querySelectorAll('.delete-modal button'))
        .find((entry) => entry.textContent.trim() === buttonLabel);
      button.click();
      return waitFor(() => !document.querySelector('.delete-modal'), 'confirm dialog closes');
    }

    await waitFor(() => cardFor(config.looseIds[0]) && cardFor(config.coverId), 'seeded cards render');

    // ── 1) Blank gallery menu before any cut: no paste, create-group present ──
    await step('gallery blank menu without cut', async () => {
      const menu = await openBlankMenu();
      const labels = menuLabels();
      if (labels.includes('粘贴')) throw new Error('paste shown without cut content: ' + JSON.stringify(labels));
      for (const expected of ['新建分组', '全选', '刷新素材库']) {
        if (!labels.includes(expected)) throw new Error('missing ' + expected + ' in ' + JSON.stringify(labels));
      }
      await closeMenu();
      return labels;
    });

    // ── 2) Stack card menu: right-clicking re-targets the selection to it ──
    await step('stack card menu appears', async () => {
      const menu = await openMenu(cardFor(config.coverId));
      const labels = menuLabels();
      for (const expected of ['打开堆叠', '添加分组', '移除分组', '重命名堆叠', '解散堆叠', '移至回收站']) {
        if (!labels.includes(expected)) throw new Error('missing ' + expected + ' in ' + JSON.stringify(labels));
      }
      if (labels.includes('粘贴到此堆叠')) throw new Error('paste-into-stack shown without cut content');
      const ringed = Array.from(document.querySelectorAll('.asset-card.asset-selected')).map((card) => card.getAttribute('data-asset-id')).sort();
      if (JSON.stringify(ringed) !== JSON.stringify([config.coverId])) {
        throw new Error('stack right-click did not select the stack card: ' + JSON.stringify(ringed));
      }
      await closeMenu();
      return labels;
    });

    // ── 3) Rename the stack; card and server agree ──
    await step('rename stack', async () => {
      await openMenu(cardFor(config.coverId));
      await clickMenuItem('重命名堆叠');
      await dialogSubmit(config.renamedStack, '保存');
      await waitFor(() => (activeStackCard()?.getAttribute('aria-label') || '').includes(config.renamedStack), 'card shows the new name');
      const annotated = await assetById(config.coverId);
      if (annotated?.stack?.name !== config.renamedStack) {
        throw new Error('server stack name mismatch: ' + JSON.stringify(annotated?.stack));
      }
      return annotated?.stack;
    });

    // ── 4) Stack card -> 添加分组 ▸ seed group: members join server-side ──
    await step('stack to seed group via submenu', async () => {
      await openMenu(cardFor(config.coverId));
      await openSubmenuAndClick('添加分组', config.seedGroup);
      const grouped = (await api('/api/assets?project=default&group=' + encodeURIComponent(config.seedGroup) + '&limit=250')).assets || [];
      const ids = grouped.map((asset) => asset.id).sort();
      const expected = [...config.memberIds, config.looseIds[3]].sort();
      if (JSON.stringify(ids) !== JSON.stringify(expected)) {
        throw new Error('group membership mismatch: ' + JSON.stringify(ids) + ' != ' + JSON.stringify(expected));
      }
      return ids;
    });

    // ── 5) Cut a loose asset -> 粘贴到此堆叠: stack grows to 4 ──
    await step('paste into stack', async () => {
      await openMenu(cardFor(config.looseIds[0]));
      await clickMenuItem('剪切');
      const menu = await openMenu(cardFor(config.coverId));
      if (!menuLabels().includes('粘贴到此堆叠')) throw new Error('paste-into-stack missing with cut content');
      await closeMenu();
      await openMenu(cardFor(config.coverId));
      await clickMenuItem('粘贴到此堆叠');
      await waitFor(() => activeStackCard()?.querySelector('.stack-mark')?.textContent?.trim() === '4', 'stack card count 4');
      const annotated = await assetById(config.coverId);
      if (annotated?.stack?.count !== 4) throw new Error('server stack count != 4: ' + JSON.stringify(annotated?.stack));
      return annotated?.stack?.count;
    });

    // ── 6) Single click only selects the stack card; double-click enters ──
    await step('stack single click selects, double click enters', async () => {
      cardFor(config.coverId).click();
      await waitFor(() => cardFor(config.coverId)?.classList.contains('asset-selected'), 'single click rings the stack card');
      if (document.querySelector('.viewer-title')) throw new Error('single click entered the stack: the topbar shows the stack title');
      if (!cardFor(config.looseIds[1])) throw new Error('single click left the root gallery');
      cardFor(config.coverId).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      await waitFor(() => cardFor(config.memberIds[1]) && !cardFor(config.memberIds[1]).querySelector('.stack-mark'), 'stack view opens with plain member cards');
      cardFor(config.memberIds[1]).click();
      await openMenu(cardFor(config.memberIds[1]));
      await clickMenuItem('移出堆叠');
      await waitFor(() => !cardFor(config.memberIds[1]), 'moved-out card leaves the stack view');
      const annotated = await assetById(config.coverId);
      if (annotated?.stack?.count !== 3) throw new Error('server stack count != 3: ' + JSON.stringify(annotated?.stack));
      // Blank area inside the stack: 返回素材库 (+ rename/dissolve/select-all), no paste (cut consumed).
      const menu = await openBlankMenu();
      const labels = menuLabels();
      for (const expected of ['返回素材库', '重命名堆叠', '解散堆叠', '全选', '刷新']) {
        if (!labels.includes(expected)) throw new Error('missing ' + expected + ' in ' + JSON.stringify(labels));
      }
      if (labels.includes('粘贴')) throw new Error('paste shown after the cut was consumed');
      await closeMenu();
      await openBlankMenu();
      await clickMenuItem('返回素材库');
      await waitFor(() => activeStackCard(), 'back to the root gallery');
      return annotated?.stack?.count;
    });

    // ── 6b) Task 198: multi-select and stack-card copy. A recording desktop
    // bridge stands in for the preload (the real main-process clipboard is
    // covered by desktop-input); it sees exactly the paths the UI sends. ──
    await step('multi-select and stack copy images and paths', async () => {
      const sent = { files: [], text: [] };
      window.electronAPI = {
        writeClipboardFiles: async (paths) => { sent.files.push(paths); return { ok: true, count: paths.length, skipped: 0 }; },
        writeClipboardText: async (text) => { sent.text.push(text); return true; },
      };
      try {
        const pathOf = async (id) => (await assetById(id))?.image_path || '';
        const stackPaths = ((await api('/api/asset-stacks/' + encodeURIComponent(config.stackId) + '/assets?project=default&limit=250')).assets || [])
          .map((asset) => asset.image_path);
        const loosePaths = [await pathOf(config.looseIds[1]), await pathOf(config.looseIds[2])];
        if (stackPaths.length !== 3 || loosePaths.some((path) => !path)) throw new Error('setup paths ' + JSON.stringify({ stackPaths, loosePaths }));

        // Two loose cards: 复制图片 sends both files, 复制路径 two lines, in selection order.
        cardFor(config.looseIds[1]).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        cardFor(config.looseIds[2]).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
        await waitFor(() => document.querySelectorAll('.asset-card.asset-selected').length === 2, 'two cards selected');
        await openMenu(cardFor(config.looseIds[1]));
        await clickMenuItem('复制图片');
        await waitFor(() => sent.files.length === 1, 'files sent');
        if (JSON.stringify(sent.files[0]) !== JSON.stringify(loosePaths)) throw new Error('multi files ' + JSON.stringify(sent.files[0]));
        await waitFor(() => (document.querySelector('.toast')?.textContent || '').includes('已复制 2 张图片'), 'files toast');
        await openMenu(cardFor(config.looseIds[1]));
        await clickMenuItem('复制路径');
        await waitFor(() => sent.text.length === 1, 'paths sent');
        if (sent.text[0] !== loosePaths.join('\\n')) throw new Error('multi paths ' + JSON.stringify(sent.text[0]));

        // A loose card plus the stack card: the stack expands to its members in stack order.
        cardFor(config.looseIds[1]).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        cardFor(config.coverId).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
        await waitFor(() => document.querySelectorAll('.asset-card.asset-selected').length === 2, 'loose + stack selected');
        await openMenu(cardFor(config.looseIds[1]));
        await clickMenuItem('复制路径');
        await waitFor(() => sent.text.length === 2, 'mixed paths sent');
        const mixed = [loosePaths[0], ...stackPaths].join('\\n');
        if (sent.text[1] !== mixed) throw new Error('mixed paths ' + JSON.stringify(sent.text[1]) + ' != ' + JSON.stringify(mixed));

        // Stack card alone: 复制全部图片 / 复制全部路径.
        cardFor(config.looseIds[3]).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await waitFor(() => document.querySelectorAll('.asset-card.asset-selected').length === 1, 'single selection');
        await openMenu(cardFor(config.coverId));
        await clickMenuItem('复制全部图片');
        await waitFor(() => sent.files.length === 2, 'stack files sent');
        if (JSON.stringify(sent.files[1]) !== JSON.stringify(stackPaths)) throw new Error('stack files ' + JSON.stringify(sent.files[1]));
        await openMenu(cardFor(config.coverId));
        await clickMenuItem('复制全部路径');
        await waitFor(() => sent.text.length === 3, 'stack paths sent');
        if (sent.text[2] !== stackPaths.join('\\n')) throw new Error('stack paths ' + JSON.stringify(sent.text[2]));
      } finally {
        delete window.electronAPI;
      }

      // Without the bridge (plain browser) the multi-file entries are hidden.
      await openMenu(cardFor(config.coverId));
      const labels = menuLabels();
      await closeMenu();
      if (labels.includes('复制全部图片') || !labels.includes('复制全部路径')) throw new Error('browser stack menu ' + JSON.stringify(labels));
      return sent.files.length + sent.text.length;
    });

    // ── 7) Multi-select two loose assets -> 堆叠所选: new stack server-side ──
    await step('stack selected', async () => {
      // The inspected card is the implicit selection (task 155): click the
      // first card, ⌘-click the second.
      cardFor(config.looseIds[1]).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      cardFor(config.looseIds[2]).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
      await waitFor(() => document.querySelectorAll('.asset-card.asset-selected').length === 2, 'two cards selected');
      await openMenu(cardFor(config.looseIds[1]));
      await clickMenuItem('堆叠所选');
      await waitFor(() => {
        const cards = Array.from(document.querySelectorAll('.asset-card .stack-mark'));
        return cards.length === 2 && cards.some((mark) => mark.textContent.trim() === '2');
      }, 'a second stack card with 2 members');
      const annotated = await assetById(config.looseIds[1]);
      if (!annotated?.stack || annotated.stack.id === config.stackId) throw new Error('no new stack server-side: ' + JSON.stringify(annotated?.stack));
      if (annotated.stack.count !== 2) throw new Error('new stack count != 2: ' + JSON.stringify(annotated.stack));
      return annotated.stack;
    });

    // ── 8) 新建分组并移入 on a loose asset ──
    await step('create group with selection', async () => {
      await openMenu(cardFor(config.looseIds[3]));
      await openSubmenuAndClick('添加分组', '新建分组并移入');
      await dialogSubmit(config.newGroup, '保存');
      const grouped = (await api('/api/assets?project=default&group=' + encodeURIComponent(config.newGroup) + '&limit=250')).assets || [];
      if (!grouped.some((asset) => asset.id === config.looseIds[3])) {
        throw new Error('asset not in the new group: ' + JSON.stringify(grouped.map((asset) => asset.id)));
      }
      return config.newGroup;
    });

    // ── 9) Dissolve the renamed stack: members restored, stack gone ──
    await step('dissolve stack', async () => {
      await openMenu(cardFor(config.coverId));
      await clickMenuItem('解散堆叠');
      await confirmDialog('解散这个堆叠？', '解散堆叠');
      await waitFor(() => cardFor(config.memberIds[1]) && !cardFor(config.memberIds[1]).querySelector('.stack-mark'), 'members are loose again');
      const annotated = await assetById(config.coverId);
      if (annotated?.stack) throw new Error('server still annotates the dissolved stack: ' + JSON.stringify(annotated.stack));
      return true;
    });

    // ── 10) Stack to trash: confirm, members land in trash ──
    await step('stack to trash', async () => {
      const secondStackCard = () => Array.from(document.querySelectorAll('.asset-card'))
        .find((card) => card.getAttribute('data-asset-id') === config.looseIds[1] && card.querySelector('.stack-mark'));
      if (!secondStackCard()) throw new Error('the stacked-selection card is not in the gallery');
      await openMenu(secondStackCard());
      await clickMenuItem('移至回收站');
      await confirmDialog('将这个堆叠移到回收站？', '移至回收站');
      await waitFor(() => !secondStackCard(), 'trashed stack card leaves the gallery');
      const trashedPage = (await api('/api/assets?project=default&trash=1&limit=250')).assets || [];
      const trashedIds = trashedPage.map((asset) => asset.id);
      const missing = [config.looseIds[1], config.looseIds[2]].filter((id) => !trashedIds.includes(id));
      if (missing.length) {
        const rootNow = await rootAssets();
        throw new Error('members missing from trash: ' + JSON.stringify(missing)
          + ' | trash=' + JSON.stringify(trashedIds)
          + ' | root=' + JSON.stringify(rootNow.map((asset) => ({ id: asset.id, stack: asset.stack ? { id: asset.stack.id, count: asset.stack.count } : null }))));
      }
      return trashedIds.length;
    });

    return { steps, failedSteps };
  })()
  `;
}
