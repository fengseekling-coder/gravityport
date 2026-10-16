// GravityPort React UI flow (task 142): the dedicated trash menu, the undo
// toast on move-to-trash, permanent delete / empty trash, the trash countdown
// badge, and the staged import pipeline (plain drop into a stack + folder
// drop). Every step is asserted against the server's real state through the
// in-page API, and the node side re-verifies the final state via ctx.api.
export const name = "trash-undo-import";
export const description = "undo toast restores trashed assets -> toast expires without undo -> trash menu (no cut/favorite, 90-day countdown) -> restore 2 -> permanent delete -> empty trash -> drop into stack (4 members) -> folder drop expands (3 + 1 subfolder)";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    // 6 loose assets + one 2-member stack.
    const loose = [];
    const looseColors = [[181, 68, 74], [74, 127, 181], [58, 138, 87], [138, 90, 47], [96, 74, 155], [121, 77, 33]];
    for (const [index, color] of looseColors.entries()) {
      const created = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default", imagePath: await ctx.makePng(`tui-loose-${index}.png`, color), prompt: `trash undo import ${index}`,
      });
      loose.push(created.asset.id);
    }
    const members = [];
    for (const [index, color] of [[0, [33, 77, 121]], [1, [77, 121, 33]]]) {
      const created = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default", imagePath: await ctx.makePng(`tui-member-${index}.png`, color), prompt: `trash undo import member ${index}`,
      });
      members.push(created.asset.id);
    }
    const stack = await ctx.api(server.origin, "POST", "/api/asset-stacks", {
      projectId: "default", assetIds: members,
    });
    const stackId = stack.stack?.id;
    if (!stackId) throw new Error(`stack create failed: ${JSON.stringify(stack)}`);

    const config = { looseIds: loose, memberIds: members, stackId };
    const result = await ctx.runInPage(server, trashUndoImportSource(config));
    if (!result || result.failedSteps?.length) {
      throw new Error(`trash-undo-import page result: ${JSON.stringify(result)}`);
    }

    // Node-side re-verification of the final server state: 12 assets stay
    // (4 loose survivors + 2 stack members + 2 stack drops + 4 folder drops),
    // the permanently deleted id and the one destroyed by empty-trash are gone
    // from both listings, the stack has exactly 4 members, and the trash is
    // empty.
    const deletedId = config.looseIds[4];
    const emptiedId = config.looseIds[5];
    const root = await ctx.api(server.origin, "GET", "/api/assets?project=default&limit=250");
    const rootIds = new Set((root.assets || []).map(asset => asset.id));
    const trash = await ctx.api(server.origin, "GET", "/api/assets?project=default&trash=1&limit=250");
    const trashIds = new Set((trash.assets || []).map(asset => asset.id));
    if (trashIds.size !== 0) throw new Error(`trash not empty after empty-trash: ${JSON.stringify([...trashIds])}`);
    for (const gone of [deletedId, emptiedId]) {
      if (rootIds.has(gone) || trashIds.has(gone)) throw new Error(`destroyed asset ${gone} is still listed`);
    }
    const stackPage = await ctx.api(server.origin, "GET", `/api/asset-stacks/${encodeURIComponent(stackId)}/assets?project=default&limit=250`);
    const memberIds = (stackPage.assets || []).map(asset => asset.id);
    if (memberIds.length !== 4) throw new Error(`stack member count after stack drop import: ${memberIds.length}`);
    const stackDropIds = memberIds.filter(id => !config.memberIds.includes(id));
    if (stackDropIds.length !== 2) throw new Error(`stack drop imports missing from the stack: ${JSON.stringify(memberIds)}`);
    const survivors = config.looseIds.filter(id => id !== deletedId && id !== emptiedId);
    const expectedRoot = [...survivors, ...config.memberIds, ...stackDropIds, ...result.folderDropIds];
    if (expectedRoot.length !== 12) throw new Error(`expected 12 surviving assets, got ${expectedRoot.length}`);
    if (expectedRoot.length !== rootIds.size) {
      throw new Error(`root listing holds ${rootIds.size} assets, expected ${expectedRoot.length}: ${JSON.stringify([...rootIds])}`);
    }
    for (const id of expectedRoot) {
      if (!rootIds.has(id)) throw new Error(`expected asset ${id} missing from the root listing`);
    }
    return {
      steps: result.steps?.length || 0,
      stackId,
      folderDropUsedMockedDirectoryEntry: result.folderDropUsedMockedDirectoryEntry === true,
    };
  } finally {
    await server.stop();
  }
}

function trashUndoImportSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const steps = [];
    const failedSteps = [];
    const clientToken = () => sessionStorage.getItem('mosa.client-token') || '';
    async function api(path, method, body) {
      const response = await fetch(path, {
        method: method || 'GET',
        headers: {
          'x-mosa-client-token': clientToken(),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      if (!response.ok) throw new Error((method || 'GET') + ' ' + path + ' -> ' + response.status + ': ' + text.slice(0, 200));
      return text ? JSON.parse(text) : null;
    }
    async function waitFor(check, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      let lastError = null;
      while (Date.now() < deadline) {
        try {
          const value = await check();
          if (value) return value;
        } catch (error) { lastError = error; }
        await sleep(120);
      }
      const detail = typeof label === 'function' ? label() : String(label);
      throw new Error('Timed out waiting for ' + detail + (lastError ? ': ' + lastError.message : '')
        + ' | cards=' + document.querySelectorAll('.asset-card').length
        + ' | toast=' + (document.querySelector('.toast')?.textContent || '')
        + ' | menu=' + (document.querySelector('.context-menu')?.textContent?.trim().slice(0, 120) || ''));
    }
    const card = (id) => document.querySelector('[data-asset-id="' + id + '"]');
    const cardCount = () => document.querySelectorAll('.asset-card').length;
    const settled = () => !document.querySelector(".empty-state[role='status']");
    function clickCard(id, modifiers = {}) {
      const node = card(id);
      if (!node) throw new Error('missing card ' + id);
      node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers }));
    }
    function navButton(label, scope) {
      const root = scope ? document.querySelector(scope) : document;
      return Array.from((root || document).querySelectorAll('button')).find((button) =>
        button.textContent.trim() === label
          || Array.from(button.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === label));
    }
    function clickLabel(label, scope) {
      const button = navButton(label, scope);
      if (!button) throw new Error('Missing button "' + label + '"');
      button.click();
      return button;
    }
    function contextMenuOn(node, label) {
      const deadline = Date.now() + 15000;
      return (async () => {
        while (Date.now() < deadline) {
          if (node.isConnected) {
            node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 500, clientY: 400 }));
            const item = [...document.querySelectorAll('.context-menu button')].find((entry) => entry.textContent.trim() === label);
            if (item) return item;
          }
          await sleep(100);
        }
        throw new Error('Timed out waiting for context menu item ' + label + ' menu='
          + (document.querySelector('.context-menu')?.textContent?.trim().slice(0, 160) || ''));
      })();
    }
    const closeMenu = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    async function listingIds(trash) {
      const page = await api('/api/assets?project=default&limit=250' + (trash ? '&trash=1' : ''));
      return new Set((page.assets || []).map((asset) => asset.id));
    }
    const toastAction = () => document.querySelector('.toast .toast-action');
    async function makePngFile(name, color) {
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 24;
      const context = canvas.getContext('2d');
      context.fillStyle = color;
      context.fillRect(0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolveBlob, rejectBlob) => canvas.toBlob(
        (value) => (value ? resolveBlob(value) : rejectBlob(new Error('canvas.toBlob produced no blob'))),
        'image/png',
      ));
      return new File([blob], name, { type: 'image/png' });
    }
    function dropEvent(dataTransfer, target) {
      const rect = target.getBoundingClientRect();
      const init = {
        bubbles: true, cancelable: true, dataTransfer,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
      };
      let event = new DragEvent('drop', init);
      if (!event.dataTransfer) {
        event = new Event('drop', init);
        Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      }
      return event;
    }
    function dropFilesOn(target, files) {
      const dataTransfer = new DataTransfer();
      for (const file of files) dataTransfer.items.add(file);
      target.dispatchEvent(dropEvent(dataTransfer, target));
    }
    // A real directory item cannot be fabricated for a synthetic drop event,
    // so the root item's webkitGetAsEntry is mocked to return a directory
    // entry wrapping real in-page Files (3 loose + 1 inside a subfolder). The
    // app's full folder-expansion path runs for real; only the browser's
    // directory enumeration is faked.
    function dropFolderOn(target, files) {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(files[0]);
      const fileEntry = (file) => ({
        isFile: true, isDirectory: false, name: file.name, fullPath: '/' + file.name,
        file: (success) => success(file),
      });
      const dirEntry = (name, children) => ({
        isFile: false, isDirectory: true, name, fullPath: '/' + name,
        createReader: () => {
          let served = false;
          return {
            readEntries: (success) => {
              if (served) { success([]); return; }
              served = true;
              success(children);
            },
          };
        },
      });
      const root = dirEntry('e2e-drop-folder', [
        fileEntry(files[0]), fileEntry(files[1]), fileEntry(files[2]),
        dirEntry('sub', [fileEntry(files[3])]),
      ]);
      const original = DataTransferItem.prototype.webkitGetAsEntry;
      DataTransferItem.prototype.webkitGetAsEntry = function () { return root; };
      try {
        target.dispatchEvent(dropEvent(dataTransfer, target));
      } finally {
        DataTransferItem.prototype.webkitGetAsEntry = original;
      }
    }
    async function step(label, fn) {
      try {
        await fn();
        steps.push(label);
      } catch (error) {
        failedSteps.push(label + ': ' + String(error?.message || error).slice(0, 1600));
      }
    }
    async function moveToTrash(ids) {
      // Proven multi-select grammar (multi-select flow): click the first card,
      // modifier-click the rest, wait for the selected rings, then the menu
      // acts on the batch.
      ids.forEach((id, index) => clickCard(id, index ? { ctrlKey: true } : {}));
      await waitFor(() => document.querySelectorAll('.asset-card.asset-selected').length === ids.length,
        'selection rings for ' + ids.length + ' cards');
      await contextMenuOn(card(ids[ids.length - 1]), '移至回收站').then((item) => item.click());
      await waitFor(() => document.querySelector('[role="alertdialog"]'), 'trash confirm dialog');
      clickLabel('移至回收站', '.delete-modal');
      await waitFor(() => toastAction() && toastAction().textContent.trim() === '撤销', 'undo toast action');
    }
    const stackMembersProbe = { last: '(never polled)' };
    const stackMemberCount = async () => {
      const page = await api('/api/asset-stacks/' + encodeURIComponent(config.stackId) + '/assets?project=default&limit=250');
      stackMembersProbe.last = 'count=' + (page.stack?.count ?? '?');
      return (page.assets || []).length;
    };

    await waitFor(() => settled() && cardCount() >= 7, 'seeded gallery');

    // 1) Multi-select two loose assets -> move to trash -> undo via the toast
    //    button -> both are back in the library on the server and in the gallery.
    const undoPair = config.looseIds.slice(0, 2);
    await step('undo toast restores two trashed assets', async () => {
      await moveToTrash(undoPair);
      toastAction().click();
      await waitFor(async () => {
        const normal = await listingIds(false);
        const trashed = await listingIds(true);
        return undoPair.every((id) => normal.has(id) && !trashed.has(id));
      }, 'undo restores both assets on the server');
      await waitFor(() => settled() && cardCount() === 7, 'gallery shows the restored cards again');
    });

    // 2) Move three more to trash and let the toast expire (>6s): the assets
    //    stay trashed on the server.
    const expireTrio = config.looseIds.slice(2, 5);
    await step('toast expiry keeps the trash move', async () => {
      await moveToTrash(expireTrio);
      await waitFor(() => !document.querySelector('.toast'), 'undo toast expires after ~6s', 12000);
      const trashed = await listingIds(true);
      if (!expireTrio.every((id) => trashed.has(id))) throw new Error('toast expiry did not keep the trash move');
    });

    // 3) Trash view: countdown badges and the dedicated menu (no cut/favorite).
    await step('trash countdown badge and dedicated menu', async () => {
      clickLabel('回收站', '.main-nav');
      await waitFor(() => settled() && cardCount() === 3, 'trash view shows three cards');
      const badges = Array.from(document.querySelectorAll('.asset-card .trash-countdown')).map((node) => node.textContent.trim());
      if (badges.length !== 3 || badges.some((text) => !text.includes('90 天后删除'))) {
        throw new Error('trash countdown badges wrong: ' + JSON.stringify(badges));
      }
      const victim = card(expireTrio[0]);
      victim.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 500, clientY: 400 }));
      await waitFor(() => document.querySelector('.context-menu'), 'trash card menu opens');
      const menuText = document.querySelector('.context-menu').textContent;
      if (menuText.includes('剪切') || menuText.includes('收藏')) {
        throw new Error('trash menu still offers gallery actions: ' + menuText.slice(0, 120));
      }
      if (!menuText.includes('恢复') || !menuText.includes('永久删除')) {
        throw new Error('trash menu misses restore/permanent delete: ' + menuText.slice(0, 120));
      }
      closeMenu();
      await waitFor(() => !document.querySelector('.context-menu'), 'trash card menu closes');
    });

    // 4) Restore two of the three via the counted menu entry.
    const restorePair = expireTrio.slice(0, 2);
    const permanentVictim = expireTrio[2];
    await step('restore 2 via the trash menu', async () => {
      clickCard(restorePair[0]);
      clickCard(restorePair[1], { ctrlKey: true });
      await waitFor(() => document.querySelectorAll('.asset-card.asset-selected').length === 2, 'two rings in the trash view');
      await contextMenuOn(card(restorePair[1]), '恢复 2 个素材').then((item) => item.click());
      await waitFor(async () => {
        const normal = await listingIds(false);
        const trashed = await listingIds(true);
        return restorePair.every((id) => normal.has(id) && !trashed.has(id)) && trashed.size === 1;
      }, 'server: two restored, one left in trash');
      await waitFor(() => settled() && cardCount() === 1, 'trash view shows the one remaining card');
    });

    // 5) Permanent-delete the last trashed asset with its confirmation.
    await step('permanent delete removes the asset everywhere', async () => {
      await contextMenuOn(card(permanentVictim), '永久删除').then((item) => item.click());
      await waitFor(() => document.querySelector('[role="alertdialog"]'), 'permanent delete confirm opens');
      clickLabel('永久删除', '.delete-modal');
      await waitFor(async () => {
        const normal = await listingIds(false);
        const trashed = await listingIds(true);
        return !normal.has(permanentVictim) && !trashed.has(permanentVictim);
      }, 'server: asset gone from both listings');
    });

    // 6) Empty trash from the toolbar button; the button disappears at zero.
    const lastLoose = config.looseIds[5];
    await step('empty trash via the toolbar button', async () => {
      clickLabel('所有素材', '.main-nav');
      await waitFor(() => settled() && cardCount() === 6, 'root view after restore/permanent delete');
      await moveToTrash([lastLoose]);
      clickLabel('回收站', '.main-nav');
      await waitFor(() => settled() && cardCount() === 1, 'trash view with one card');
      const emptyButton = await waitFor(() => {
        const button = Array.from(document.querySelectorAll('.toolbar-right button'))
          .find((entry) => entry.textContent.trim() === '清空回收站');
        return button || null;
      }, 'toolbar 清空回收站 button');
      emptyButton.click();
      await waitFor(() => document.querySelector('[role="alertdialog"]'), 'empty trash confirm opens');
      clickLabel('清空回收站', '.delete-modal');
      await waitFor(async () => (await listingIds(true)).size === 0, 'server: trash empty');
      await waitFor(() => !Array.from(document.querySelectorAll('.toolbar-right button'))
        .some((entry) => entry.textContent.trim() === '清空回收站'), 'toolbar button disappears at zero');
    });

    // 7) Enter the stack and drop two files into it: the stack grows to 4.
    await step('drop import lands inside the current stack', async () => {
      clickLabel('所有素材', '.main-nav');
      await waitFor(() => settled() && cardCount() === 5, 'root view before entering the stack');
      const stackCard = document.querySelector('.asset-card .stack-mark')?.closest('.asset-card');
      if (!stackCard) throw new Error('stack card not found in root view');
      stackCard.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      await waitFor(() => settled() && cardCount() === 2, 'stack interior has two members');
      const before = await stackMemberCount();
      if (before !== 2) throw new Error('stack member count before drop: ' + before);
      dropFilesOn(document.querySelector('.workspace'), [
        await makePngFile('tui-stack-drop-1.png', '#3f7a4a'),
        await makePngFile('tui-stack-drop-2.png', '#7a3f4a'),
      ]);
      await waitFor(async () => (await stackMemberCount()) === 4,
        () => 'server: stack grows to 4 members (last poll: ' + stackMembersProbe.last + ')');
    });

    // 8) Folder drop on the root gallery: 3 loose images + a subfolder with 1
    //    image all land in the library.
    const folderDropIds = [];
    await step('folder drop expands folders into imports', async () => {
      clickLabel('所有素材', '.main-nav');
      await waitFor(() => settled() && cardCount() === 5, 'root view before folder drop');
      const before = await listingIds(false);
      dropFolderOn(document.querySelector('.workspace'), [
        await makePngFile('tui-folder-1.png', '#4a7a3f'),
        await makePngFile('tui-folder-2.png', '#3f4a7a'),
        await makePngFile('tui-folder-3.png', '#7a6f3f'),
        await makePngFile('tui-folder-sub.png', '#6f3f7a'),
      ]);
      await waitFor(async () => {
        const after = await listingIds(false);
        const added = [...after].filter((id) => !before.has(id));
        folderDropIds.splice(0, folderDropIds.length, ...added);
        return added.length === 4;
      }, 'server: folder drop adds 4 assets');
    });

    return {
      steps,
      failedSteps,
      folderDropIds,
      folderDropUsedMockedDirectoryEntry: true,
    };
  })()
  `;
}
