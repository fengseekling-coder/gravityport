// Pluggable flow: the whole drag & drop import pipeline (web/app/batch-import.mjs)
// through the real UI entries — 12 files at once, only-unsupported drops, folder
// walks via a fake webkitGetAsEntry tree, duplicate imports, imports into the
// open group / open stack, the 10001-file drop guard, and persistence across a
// server restart.
//
// The mixed-format case (3 PNG + 2 TXT + 1 PDF) runs last, after the restart
// phase: it guards the "unsupported files were skipped" notice, which drop
// entry points once lost by filtering those files before the importer saw
// them.

import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "import-batch-and-errors";
export const description = "drop import: 12-at-once, all-unsupported, folder walk, duplicates, group/stack targeting, 10001-file guard, restart persistence, mixed-format notice";

const GROUP_NAME = "IB-Target-Group";
const STACK_NAME = "IB-Stack";

export async function run(ctx) {
  await ctx.prepare();
  const observed = {};
  const first = await ctx.startServer();
  try {
    // Session A: bulk drop, all-unsupported, folder walk, duplicates, size guard.
    assertSessionA(await ctx.runInPage(first, sessionASource()), observed);
    await auditAfterSessionA(ctx, first, observed);

    // Seed the targeting targets: a manual group and a 2-member stack.
    const member1 = await ctx.api(first.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("ibe-stack-member-1.png", [31, 97, 141]), prompt: "ibe stack member 1",
    });
    const member2 = await ctx.api(first.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("ibe-stack-member-2.png", [141, 97, 31]), prompt: "ibe stack member 2",
    });
    await ctx.api(first.origin, "POST", "/api/groups", { projectId: "default", name: GROUP_NAME });
    const stack = await ctx.api(first.origin, "POST", "/api/asset-stacks", {
      projectId: "default", assetIds: [member1.asset.id, member2.asset.id],
    });
    observed.stackId = stack?.stack?.id || "";
    observed.stackSeedIds = [member1.asset.id, member2.asset.id];

    // Session B: drop into the open group, then into the open stack.
    assertSessionB(await ctx.runInPage(first, sessionBSource({
      stackId: observed.stackId, groupName: GROUP_NAME, stackName: STACK_NAME,
    })), observed);
    await auditAfterSessionB(ctx, first, observed);
  } finally {
    await first.stop();
  }

  // Restart on the same library: counts, group membership, stack members.
  const second = await ctx.startServer();
  try {
    await auditAfterRestart(ctx, second, observed);
    // Session C: restart verification in the UI, then the mixed-format case.
    try {
      await assertSessionC(await ctx.runInPage(second, sessionCSource({
        stackId: observed.stackId, groupName: GROUP_NAME,
      })), ctx, second, observed);
    } catch (error) {
      // The restarted server once died during this phase (ECONNREFUSED); keep
      // its stderr in the failure so the cause is diagnosable.
      const stderrTail = second.stderr().trim().split(/\r?\n/).slice(-40).join("\n");
      throw new Error(`${error.message}\n--- server2 stderr tail ---\n${stderrTail || "(empty)"}`, { cause: error });
    }
  } finally {
    await second.stop();
  }
  return observed;
}

function expect(condition, message) {
  if (!condition) throw new Error(`import-batch-and-errors: ${message}`);
}

const sameIdSet = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

// ===== In-page sources =====

// Shared prelude: PAGE_HELPERS plus the capture/observer helpers of this flow.
// Capture records the a11y live region (#statusText, the batchImportProgress
// announcements) and every toast text even if it auto-dismisses before a poll.
const PRELUDE = `
  ${PAGE_HELPERS}
  const viewTitleText = () => document.querySelector('#viewTitle')?.textContent || '';
  const allToastTexts = () => [...document.querySelectorAll('.toast-message')].map((node) => (node.textContent || '').trim()).filter(Boolean);
  const libraryDropTarget = () => {
    const el = document.querySelector('.library');
    if (!el) throw new Error('Missing .library drop surface');
    return el;
  };
  function startCapture() {
    const announcements = [];
    const toasts = [];
    const statusNode = document.querySelector('#statusText');
    const statusObserver = new MutationObserver(() => {
      const text = (statusNode.textContent || '').trim();
      if (text && announcements[announcements.length - 1] !== text) announcements.push(text);
    });
    if (statusNode) statusObserver.observe(statusNode, { childList: true, characterData: true, subtree: true });
    const toastObserver = new MutationObserver(() => {
      for (const text of allToastTexts()) if (!toasts.includes(text)) toasts.push(text);
    });
    for (const selector of ['#toastContainer', '#toastErrorContainer']) {
      const container = document.querySelector(selector);
      if (container) toastObserver.observe(container, { childList: true, subtree: true, characterData: true });
    }
    return { announcements, toasts };
  }
  // collectDroppedFiles walks webkitGetAsEntry entries when the drop carries
  // them; real OS folder drags cannot be synthesized in-page, so shadow the
  // DataTransfer's items with a fake entry tree (isDirectory/createReader/
  // entry.file match web/app/batch-import.mjs's visitEntry contract).
  function fakeFileEntry(name, file) {
    return {
      isFile: true,
      isDirectory: false,
      name,
      file(onOk, onErr) { setTimeout(() => onOk(file), 0); },
    };
  }
  function fakeDirectoryEntry(name, children) {
    let served = false;
    return {
      isFile: false,
      isDirectory: true,
      name,
      createReader() {
        return {
          readEntries(onOk, onErr) {
            const batch = served ? [] : children;
            served = true;
            setTimeout(() => onOk(batch.slice()), 0);
          },
        };
      },
    };
  }
  function beginFolderDrag(target, rootEntry) {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['placeholder'], 'mosa-ibe-folder-placeholder.png', { type: 'image/png' }));
    Object.defineProperty(dataTransfer, 'items', { value: [{ kind: 'file', webkitGetAsEntry: () => rootEntry }] });
    const rect = target.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, dataTransfer, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    const fire = (type) => target.dispatchEvent(new DragEvent(type, init));
    fire('dragenter');
    fire('dragover');
    return () => fire('drop');
  }
`;

function sessionASource() {
  return `(async () => {
  ${PRELUDE}
  await waitFor(() => gallerySettled(), 'app shell ready');
  const cap = startCapture();
  const toastSeen = (predicate) => cap.toasts.some(predicate);

  // 1) 12 differently coloured PNGs in one drop
  const colors = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', '#008080', '#9a6324'];
  const batchFiles = await Promise.all(colors.map((color, index) => makePngFile('mosa-ibe-batch-' + index + '.png', color)));
  // 12 small PNGs import in a single chunk (0/12 -> 12/12 -> clear). On a fast
  // machine each step can finish inside the live region's write delay, so every
  // progress write is cancelled by the next one before it lands. Hold the
  // import-batch request long enough for "0/12" to reach #statusText.
  const realFetch = window.fetch;
  window.fetch = async (input, init) => {
    if (String(input).includes('/api/assets/import-batch')) await new Promise((resolve) => setTimeout(resolve, 150));
    return realFetch.call(window, input, init);
  };
  beginFileDrag(libraryDropTarget(), batchFiles)();
  await waitFor(() => gallerySettled() && rootCardIds().length === 12, '12 cards after the 12-file drop');
  const batchIds = rootCardIds();
  await waitFor(() => toastSeen((text) => text.includes('已导入 12 个素材')), 'batchImportComplete toast for 12 files');
  window.fetch = realFetch;
  const queuedToast12 = toastSeen((text) => text.includes('已加入导入队列：12 个文件'));
  const progressAnnouncements = cap.announcements.filter((text) => /正在导入 \\d+\\/12/.test(text));

  // 3) only unsupported formats
  const toastsBeforeUnsupported = cap.toasts.length;
  beginFileDrag(libraryDropTarget(), [
    new File(['just text'], 'mosa-ibe-only.txt', { type: 'text/plain' }),
    new File(['%PDF-1.4 not-really'], 'mosa-ibe-only.pdf', { type: 'application/pdf' }),
  ])();
  await sleep(1200);
  const cardsAfterUnsupported = rootCardIds().length;
  const toastsAfterUnsupported = cap.toasts.slice(toastsBeforeUnsupported);
  const unsupportedToastSeen = toastsAfterUnsupported.some((text) => text.includes('不支持这种文件格式'));
  const noQueueAfterUnsupported = !toastsAfterUnsupported.some((text) => text.includes('已加入导入队列'));

  // 4) two-level folder mixing supported and unsupported names
  const rootEntry = fakeDirectoryEntry('mosa-ibe-folder', [
    fakeFileEntry('mosa-ibe-f-a.png', await makePngFile('mosa-ibe-f-a.png', '#2f6f4f')),
    fakeFileEntry('mosa-ibe-f-b.png', await makePngFile('mosa-ibe-f-b.png', '#c0392b')),
    fakeDirectoryEntry('mosa-ibe-sub-a', [
      fakeFileEntry('mosa-ibe-f-c.jpg', await makePngFile('mosa-ibe-f-c.jpg', '#7d3c98')),
      fakeFileEntry('mosa-ibe-notes.txt', new File(['notes'], 'mosa-ibe-notes.txt', { type: 'text/plain' })),
    ]),
    fakeDirectoryEntry('mosa-ibe-sub-b', [
      fakeDirectoryEntry('mosa-ibe-nested', [
        fakeFileEntry('mosa-ibe-f-d.png', await makePngFile('mosa-ibe-f-d.png', '#d68910')),
        fakeFileEntry('mosa-ibe-spec.pdf', new File(['%PDF-1.4'], 'mosa-ibe-spec.pdf', { type: 'application/pdf' })),
      ]),
    ]),
  ]);
  beginFolderDrag(libraryDropTarget(), rootEntry)();
  await waitFor(() => gallerySettled() && rootCardIds().length === 16, '4 supported files imported from the folder drop');
  const afterFolder = new Set(batchIds);
  const folderIds = rootCardIds().filter((id) => !afterFolder.has(id));
  await waitFor(() => toastSeen((text) => text.includes('已导入 4 个素材')), 'completion toast for the folder drop');

  // 5) the same image twice under different names
  const x = await makePngFile('mosa-ibe-dup-x.png', '#1868a8');
  beginFileDrag(libraryDropTarget(), [x])();
  await waitFor(() => gallerySettled() && rootCardIds().length === 17, 'X imported');
  const xPrime = new File([await x.arrayBuffer()], 'mosa-ibe-dup-x-renamed.png', { type: 'image/png' });
  beginFileDrag(libraryDropTarget(), [xPrime])();
  await waitFor(() => gallerySettled() && rootCardIds().length === 18, 'X-prime imported');
  const known = new Set([...batchIds, ...folderIds]);
  const dupIds = rootCardIds().filter((id) => !known.has(id));

  // 7) the 10001-file drop guard (no upload may happen)
  const startedAt = Date.now();
  const seed = await makePngFile('mosa-ibe-bulk-seed.png', '#101010');
  const many = Array.from({ length: 10001 }, (_, index) => new File([seed], 'mosa-ibe-bulk-' + index + '.png', { type: 'image/png' }));
  beginFileDrag(libraryDropTarget(), many)();
  await waitFor(() => toastSeen((text) => text.includes('一次最多导入 10000 个文件')), 'batchImportDropTooLarge toast', 20000);
  const maxDropMs = Date.now() - startedAt;
  await sleep(800);
  const cardsAfterMax = rootCardIds().length;
  // Toasts display one after another, so a slow runner can still be showing
  // an earlier drop's queue toast here; only a queue toast for this drop's
  // file count would mean the guard let the batch through.
  const oversizedQueued = cap.toasts.some((text) => /已加入导入队列：1000[01] 个文件/.test(text));

  return {
    batchIds,
    queuedToast12,
    progressAnnouncements,
    cardsAfterUnsupported,
    unsupportedToastSeen,
    noQueueAfterUnsupported,
    folderIds,
    dupIds,
    cardsAfterMax,
    oversizedQueued,
    maxDropMs,
    toasts: cap.toasts.slice(),
    announcements: cap.announcements.slice(),
    rendererErrors: rendererErrors.slice(0, 5),
  };
})()`;
}

function sessionBSource(config) {
  return `(async () => {
  ${PRELUDE}
  const config = ${JSON.stringify(config)};
  await waitFor(() => gallerySettled(), 'app shell ready');
  // 18 single cards from session A + 1 stack node (the 2 seeded members hide behind it)
  await waitFor(() => gallerySettled() && rootCardIds().length === 19, '19 root nodes before the targeting scenarios');
  const stackSelector = '#assetGrid > .asset-card.is-stack[data-stack-id="' + CSS.escape(config.stackId) + '"]';
  await waitFor(() => document.querySelector(stackSelector), 'stack node at root');
  const badgeBefore = document.querySelector(stackSelector + ' .asset-stack-count')?.textContent || '';

  // Name the stack so the in-stack title assertions read unambiguously.
  const renameItem = await openContextMenu(stackSelector + ' .asset-card-select', '重命名堆叠');
  renameItem.click();
  await waitFor(() => document.querySelector('#stackRenameModal')?.classList.contains('open'), 'stack rename modal opens');
  setValue('#stackRenameInput', config.stackName);
  click('#saveStackRenameBtn');
  await waitFor(() => !document.querySelector('#stackRenameModal')?.classList.contains('open'), 'stack rename modal closes');

  // Open the manual group and drop two files into the gallery.
  const groupItem = await waitFor(() => document.querySelector('#sidebarManualGroupList .nav-group-item[data-filter="group"][data-value="' + CSS.escape(config.groupName) + '"]'), 'group nav item');
  groupItem.click();
  await waitFor(() => document.querySelector('#sidebarManualGroupList .nav-group-item.active')?.dataset.value === config.groupName && gallerySettled(), 'group view is open');
  const groupCardsBefore = rootCardIds().length;
  beginFileDrag(libraryDropTarget(), await Promise.all([
    makePngFile('mosa-ibe-g1.png', '#1a7f5a'),
    makePngFile('mosa-ibe-g2.png', '#b3502a'),
  ]))();
  await waitFor(() => gallerySettled() && rootCardIds().length === 2, '2 cards in the open group after the drop');
  const groupImportedIds = rootCardIds();
  const groupViewTitle = viewTitleText();

  click('#quickFilters .nav-item[data-filter="all"]');
  await waitFor(() => gallerySettled() && rootCardIds().length === 21 && !document.querySelector('#sidebarManualGroupList .nav-group-item.active'), 'back to all: 21 root nodes');

  // Open the stack and drop one file into it.
  await waitFor(() => document.querySelector(stackSelector), 'stack node before opening');
  const openItem = await openContextMenu(stackSelector + ' .asset-card-select', '打开堆叠');
  openItem.click();
  await waitFor(() => document.body.getAttribute('data-in-stack') === 'true' && gallerySettled(), 'entered stack view');
  const titleInsideBefore = await waitFor(() => {
    const title = viewTitleText();
    return title.includes(config.stackName) && title.includes('· 2 项') ? title : '';
  }, 'stack title shows 2 members');
  const membersBefore = rootCardIds();
  beginFileDrag(libraryDropTarget(), [await makePngFile('mosa-ibe-s1.png', '#5a4fcf')])();
  await waitFor(() => gallerySettled() && rootCardIds().length === 3, '3 members after the in-stack drop');
  const membersAfter = rootCardIds();
  const importedStackMemberId = membersAfter.find((id) => !membersBefore.includes(id)) || '';
  const titleInsideAfter = await waitFor(() => {
    const title = viewTitleText();
    return title.includes(config.stackName) && title.includes('· 3 项') ? title : '';
  }, 'stack title count bumped to 3 after import');
  click('#navHistoryBack');
  await waitFor(() => gallerySettled() && rootCardIds().length === 21, 'back at the root view');
  const badgeAfter = await waitFor(() => {
    const value = document.querySelector(stackSelector + ' .asset-stack-count')?.textContent || '';
    return value === '3' ? value : '';
  }, 'stack badge count is 3 after import');

  return {
    badgeBefore,
    groupCardsBefore,
    groupImportedIds,
    groupViewTitle,
    titleInsideBefore,
    membersBefore,
    membersAfter,
    importedStackMemberId,
    titleInsideAfter,
    badgeAfter,
    rendererErrors: rendererErrors.slice(0, 5),
  };
})()`;
}

function sessionCSource(config) {
  return `(async () => {
  ${PRELUDE}
  const config = ${JSON.stringify(config)};
  await waitFor(() => gallerySettled(), 'app shell ready after restart');
  await waitFor(() => gallerySettled() && rootCardIds().length === 21, '21 root nodes after restart');
  const rootNodesAfterRestart = rootCardIds().length;
  const stackSelector = '#assetGrid > .asset-card.is-stack[data-stack-id="' + CSS.escape(config.stackId) + '"]';
  await waitFor(() => document.querySelector(stackSelector), 'stack node after restart');
  const badgeAfterRestart = document.querySelector(stackSelector + ' .asset-stack-count')?.textContent || '';

  const groupItem = await waitFor(() => document.querySelector('#sidebarManualGroupList .nav-group-item[data-filter="group"][data-value="' + CSS.escape(config.groupName) + '"]'), 'group nav item after restart');
  groupItem.click();
  await waitFor(() => document.querySelector('#sidebarManualGroupList .nav-group-item.active')?.dataset.value === config.groupName && gallerySettled(), 'group view open after restart');
  await waitFor(() => gallerySettled() && rootCardIds().length === 2, 'group still holds its 2 imported assets');
  const groupIdsAfterRestart = rootCardIds();
  click('#quickFilters .nav-item[data-filter="all"]');
  await waitFor(() => gallerySettled() && rootCardIds().length === 21, 'back to all after the group check');

  const openItem = await openContextMenu(stackSelector + ' .asset-card-select', '打开堆叠');
  openItem.click();
  await waitFor(() => document.body.getAttribute('data-in-stack') === 'true' && gallerySettled(), 'entered stack view after restart');
  await waitFor(() => gallerySettled() && rootCardIds().length === 3, 'stack still holds 3 members');
  const stackMembersAfterRestart = rootCardIds();
  click('#navHistoryBack');
  await waitFor(() => gallerySettled() && rootCardIds().length === 21, 'back at root after the stack check');

  // 2) mixed formats, run last on purpose (see the module header + assertSessionC)
  const cap = startCapture();
  const beforeMixed = new Set(rootCardIds());
  beginFileDrag(libraryDropTarget(), await Promise.all([
    makePngFile('mosa-ibe-mix-1.png', '#aa3311'),
    makePngFile('mosa-ibe-mix-2.png', '#11aa33'),
    makePngFile('mosa-ibe-mix-3.png', '#3311aa'),
    new File(['mix text a'], 'mosa-ibe-mix-a.txt', { type: 'text/plain' }),
    new File(['mix text b'], 'mosa-ibe-mix-b.txt', { type: 'text/plain' }),
    new File(['%PDF-1.4 mix'], 'mosa-ibe-mix.pdf', { type: 'application/pdf' }),
  ]))();
  await waitFor(() => gallerySettled() && rootCardIds().length === 24, 'only the 3 PNGs land from the mixed drop');
  const mixedIds = rootCardIds().filter((id) => !beforeMixed.has(id));
  await waitFor(() => cap.toasts.some((text) => text.includes('已导入 3 个素材')), 'completion toast for the mixed drop');
  const mixedQueuedToast = cap.toasts.find((text) => text.includes('已加入导入队列')) || '';
  const mixedCompleteToast = cap.toasts.find((text) => text.includes('已导入 3 个素材')) || '';
  const unsupportedNoticeSeen = cap.toasts.some((text) => text.includes('格式不支持') || text.includes('不支持这种文件格式'));

  return {
    rootNodesAfterRestart,
    badgeAfterRestart,
    groupIdsAfterRestart,
    stackMembersAfterRestart,
    mixedIds,
    mixedQueuedToast,
    mixedCompleteToast,
    unsupportedNoticeSeen,
    toasts: cap.toasts.slice(),
    announcements: cap.announcements.slice(),
    rendererErrors: rendererErrors.slice(0, 5),
  };
})()`;
}

// ===== Node-side assertions =====

function assertSessionA(a, observed) {
  expect(Array.isArray(a.batchIds) && a.batchIds.length === 12, `12 cards after the 12-file drop: ${JSON.stringify(a.batchIds?.length)}`);
  expect(a.queuedToast12 === true, `batchImportQueued toast for 12 files: ${JSON.stringify(a.toasts)}`);
  expect(a.progressAnnouncements.length >= 1, `batchImportProgress announcements: ${JSON.stringify(a.announcements)}`);
  expect(a.toasts.some((text) => text.includes('已导入 12 个素材')), `batchImportComplete toast for 12 files: ${JSON.stringify(a.toasts)}`);

  expect(a.cardsAfterUnsupported === 12, `all-unsupported drop imported nothing: ${a.cardsAfterUnsupported} cards`);
  expect(a.unsupportedToastSeen === true, `errorPathUnsupported toast: ${JSON.stringify(a.toasts)}`);
  expect(a.noQueueAfterUnsupported === true, `no import queued for the all-unsupported drop: ${JSON.stringify(a.toasts)}`);

  expect(a.folderIds.length === 4, `folder drop imported exactly the 4 supported files: ${JSON.stringify(a.folderIds)}`);
  expect(a.toasts.some((text) => text.includes('已导入 4 个素材')), `completion toast for the folder drop: ${JSON.stringify(a.toasts)}`);

  expect(a.dupIds.length === 2 && new Set(a.dupIds).size === 2, `X and X-prime both imported as separate assets: ${JSON.stringify(a.dupIds)}`);

  expect(a.cardsAfterMax === 18, `10001-file drop imported nothing: ${a.cardsAfterMax} cards`);
  expect(a.oversizedQueued === false, `no job queued for the oversized drop: ${JSON.stringify(a.toasts)}`);
  expect(a.maxDropMs < 20000, `oversized drop handled in ${a.maxDropMs}ms (too slow)`);
  expect(!a.rendererErrors?.length, `renderer errors in session A: ${JSON.stringify(a.rendererErrors)}`);

  observed.batchIds = a.batchIds;
  observed.folderIds = a.folderIds;
  observed.dupIds = a.dupIds;
  observed.progressAnnouncements = a.progressAnnouncements;
  observed.maxDropMs = a.maxDropMs;
}

async function auditAfterSessionA(ctx, server, observed) {
  const listed = (await ctx.api(server.origin, "GET", "/api/assets?project=default&limit=250")).assets || [];
  expect(listed.length === 18, `18 assets after session A (12 batch + 4 folder + 2 duplicates): ${listed.length}`);
  const byHash = new Map();
  for (const asset of listed) {
    const hash = String(asset.source?.content_sha256 || "");
    expect(hash, `asset ${asset.id} carries content_sha256`);
    byHash.set(hash, [...(byHash.get(hash) || []), asset.id]);
  }
  const duplicated = [...byHash.values()].filter((ids) => ids.length > 1);
  // Manual import does not dedupe (only automatic ingest is suppressed), so
  // X and X-prime must exist as two assets sharing one content hash.
  expect(duplicated.length === 1 && duplicated[0].length === 2, `exactly one duplicated content hash: ${JSON.stringify(duplicated)}`);
  expect(sameIdSet(duplicated[0], observed.dupIds), `duplicate pair ids: ${JSON.stringify(duplicated[0])} vs ${JSON.stringify(observed.dupIds)}`);
}

function assertSessionB(b, observed) {
  expect(b.badgeBefore === "2", `stack badge before the in-stack import: ${JSON.stringify(b.badgeBefore)}`);
  expect(b.groupCardsBefore === 0, `group view empty before the drop: ${b.groupCardsBefore}`);
  expect(Array.isArray(b.groupImportedIds) && b.groupImportedIds.length === 2, `2 assets landed in the open group: ${JSON.stringify(b.groupImportedIds)}`);
  expect(b.titleInsideBefore.includes("· 2 项"), `stack title inside before: ${JSON.stringify(b.titleInsideBefore)}`);
  expect(b.membersBefore.length === 2, `stack members before: ${JSON.stringify(b.membersBefore)}`);
  expect(b.membersAfter.length === 3, `stack members after: ${JSON.stringify(b.membersAfter)}`);
  expect(b.importedStackMemberId && !observed.stackSeedIds.includes(b.importedStackMemberId), `new stack member id: ${JSON.stringify(b.importedStackMemberId)}`);
  expect(b.titleInsideAfter.includes(STACK_NAME) && b.titleInsideAfter.includes("· 3 项"), `stack title count bumped to 3: ${JSON.stringify(b.titleInsideAfter)}`);
  expect(b.badgeAfter === "3", `stack badge after the in-stack import: ${JSON.stringify(b.badgeAfter)}`);
  expect(!b.rendererErrors?.length, `renderer errors in session B: ${JSON.stringify(b.rendererErrors)}`);
  observed.groupImportedIds = b.groupImportedIds;
  observed.stackImportedId = b.importedStackMemberId;
}

async function auditAfterSessionB(ctx, server, observed) {
  const groupListed = (await ctx.api(server.origin, "GET", `/api/assets?project=default&group=${encodeURIComponent(GROUP_NAME)}`)).assets || [];
  expect(sameIdSet(groupListed.map((asset) => asset.id), observed.groupImportedIds), `group membership after session B: ${JSON.stringify(groupListed.map((asset) => asset.id))}`);
  const stackSummary = await ctx.api(server.origin, "GET", `/api/asset-stacks/${encodeURIComponent(observed.stackId)}?project=default`);
  expect(stackSummary?.stack?.count === 3, `stack count after the in-stack import: ${JSON.stringify(stackSummary?.stack)}`);
  const stackMembers = await ctx.api(server.origin, "GET", `/api/asset-stacks/${encodeURIComponent(observed.stackId)}/assets?project=default&limit=250`);
  expect(sameIdSet((stackMembers?.assets || []).map((asset) => asset.id), [...observed.stackSeedIds, observed.stackImportedId]), `stack members after the in-stack import: ${JSON.stringify((stackMembers?.assets || []).map((asset) => asset.id))}`);
}

async function auditAfterRestart(ctx, server, observed) {
  const listed = (await ctx.api(server.origin, "GET", "/api/assets?project=default&limit=250")).assets || [];
  expect(listed.length === 23, `23 assets after the restart (18 session A + 2 seeds + 2 group + 1 stack): ${listed.length}`);
  const ids = new Set(listed.map((asset) => asset.id));
  for (const id of observed.batchIds) expect(ids.has(id), `batch asset ${id} survived the restart`);
  for (const id of observed.folderIds) expect(ids.has(id), `folder asset ${id} survived the restart`);
  for (const id of observed.dupIds) expect(ids.has(id), `duplicate asset ${id} survived the restart`);
  const groupListed = (await ctx.api(server.origin, "GET", `/api/assets?project=default&group=${encodeURIComponent(GROUP_NAME)}`)).assets || [];
  expect(sameIdSet(groupListed.map((asset) => asset.id), observed.groupImportedIds), `group membership after the restart: ${JSON.stringify(groupListed.map((asset) => asset.id))}`);
  const stackSummary = await ctx.api(server.origin, "GET", `/api/asset-stacks/${encodeURIComponent(observed.stackId)}?project=default`);
  expect(stackSummary?.stack?.count === 3, `stack count after the restart: ${JSON.stringify(stackSummary?.stack)}`);
}

async function assertSessionC(c, ctx, server, observed) {
  expect(c.rootNodesAfterRestart === 21, `21 root nodes after the restart: ${c.rootNodesAfterRestart}`);
  expect(c.badgeAfterRestart === "3", `stack badge after the restart: ${JSON.stringify(c.badgeAfterRestart)}`);
  expect(sameIdSet(c.groupIdsAfterRestart, observed.groupImportedIds), `group cards after the restart: ${JSON.stringify(c.groupIdsAfterRestart)}`);
  expect(sameIdSet(c.stackMembersAfterRestart, [...observed.stackSeedIds, observed.stackImportedId]), `stack members after the restart: ${JSON.stringify(c.stackMembersAfterRestart)}`);

  expect(Array.isArray(c.mixedIds) && c.mixedIds.length === 3, `mixed drop imported exactly the 3 PNGs: ${JSON.stringify(c.mixedIds)}`);
  expect(c.mixedQueuedToast.includes("已加入导入队列：3 个文件"), `queue toast counts only the pre-filtered files: ${JSON.stringify(c.mixedQueuedToast)}`);
  expect(Boolean(c.mixedCompleteToast), `completion toast for the mixed drop: ${JSON.stringify(c.toasts)}`);
  expect(!c.rendererErrors?.length, `renderer errors in session C: ${JSON.stringify(c.rendererErrors)}`);

  const listed = (await ctx.api(server.origin, "GET", "/api/assets?project=default&limit=250")).assets || [];
  expect(listed.length === 26, `26 assets after the mixed drop: ${listed.length}`);
  // The drop handlers filter unsupported files while collecting them and pass
  // only their count to the importer, which must still report the skip.
  expect(c.unsupportedNoticeSeen === true, `mixed drop showed no unsupported-format notice; toasts=${JSON.stringify(c.toasts)} announcements=${JSON.stringify(c.announcements)}`);
  return listed;
}
