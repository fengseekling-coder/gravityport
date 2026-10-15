// GravityPort React UI flow: version lineage and generation rounds surface in
// the React inspector, and the prompt editor writes through the real API.
// Task 144 adds a same-conversation ChatGPT shape: four assets bound to turns
// 1-4 of one conversation (via the capture-plugin turn-bindings endpoint), the
// version tree listing them with 共 N 轮 texts, the expanded list, row jump and
// the second-line ellipsis.
export const name = "version-history";
export const description = "parent+child version -> 版本 section lists both and switches -> generation event -> 版本树 row shows thumbnail and prompt -> prompt editor PATCHes -> 4-image conversation -> 版本树 lists rounds, expands, jumps";

export async function run(ctx) {
  await ctx.prepare();
  // The capture-plugin ingest routes need a web-capture bearer token; the e2e
  // server env inherits this process's env (qaEnvironment spreads process.env).
  const captureToken = "mosa_e2e_capture_rounds_token";
  const previousCaptureToken = process.env.MOSA_WEB_CAPTURE_TOKEN;
  process.env.MOSA_WEB_CAPTURE_TOKEN = captureToken;
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

    // Four assets of one ChatGPT conversation, turns 1-4, deterministic
    // created_at ordering. provider_asset_id is what the turn-bindings
    // endpoint matches generation events by.
    const roundsAssets = [];
    for (let index = 1; index <= 4; index += 1) {
      const created = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default", imagePath: await ctx.makePng(`rounds-${index}.png`, [40 + index * 30, 120, 180]), prompt: `rounds conversation prompt ${index}`,
      });
      roundsAssets.push(created.asset);
    }
    const baseTime = Date.parse("2026-10-15T09:00:00.000Z");
    for (let index = 1; index <= 4; index += 1) {
      await ctx.api(server.origin, "POST", "/api/generations", {
        projectId: "default",
        output_asset_id: roundsAssets[index - 1].id,
        provider: "chatgpt",
        conversation_id: "e2e-conv-rounds",
        provider_asset_id: `file-rounds-${index}`,
        model: "gpt-5-4-thinking",
        effective_prompt: `rounds conversation prompt ${index}`,
        created_at: new Date(baseTime + index * 60000).toISOString(),
      });
    }
    // Conversation snapshot (turn_count 4) through the capture-plugin route:
    // same trust bar as the other /api/ingest entries, bearer-token only.
    const bindings = Array.from({ length: 4 }, (_, index) => ({
      provider_asset_id: `file-rounds-${index + 1}`,
      message_id: `m-rounds-${index + 1}`,
      turn_index: index + 1,
    }));
    const bound = await fetch(`${server.origin}/api/ingest/web-capture-turn-bindings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${captureToken}` },
      body: JSON.stringify({
        project_id: "default",
        provider: "chatgpt",
        conversation_id: "e2e-conv-rounds",
        turn_count: 4,
        bindings,
      }),
    });
    const boundResult = await bound.json().catch(() => ({}));
    if (!bound.ok || boundResult.matched !== 4 || boundResult.updated !== 4) {
      throw new Error(`web-capture-turn-bindings failed: HTTP ${bound.status} ${JSON.stringify(boundResult)}`);
    }

    const result = await ctx.runInPage(server, versionHistorySource({
      parentId: parent.asset.id,
      childId: child.asset?.id || "",
      secondId: roundsAssets[1].id,
    }));
    if (result?.versionRows !== 2 || result?.switchedToChild !== true || result?.generationRowShown !== true
      || result?.promptEdited !== true || result?.promptPersisted !== true) {
      throw new Error(`version-history result: ${JSON.stringify({ parent: parent.asset.id, child: child.asset?.id, ...result })}`);
    }
    if (result?.roundsDefaultRows !== 3 || result?.roundsExpandedRows !== 4 || result?.roundsBadge !== "4"
      || result?.roundsSwitchedToThird !== true || result?.roundsEllipsis !== true || result?.roundsCurrentMarked !== true) {
      throw new Error(`version-history rounds result: ${JSON.stringify(result)}`);
    }
    return { parentId: parent.asset.id, childId: child.asset?.id, ...result };
  } finally {
    if (previousCaptureToken === undefined) delete process.env.MOSA_WEB_CAPTURE_TOKEN;
    else process.env.MOSA_WEB_CAPTURE_TOKEN = previousCaptureToken;
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
      const genProbe = await fetch('/api/assets/default/' + config.parentId + '/generation-history')
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
    // The generation records ARE the version tree: each row leads with its
    // output's thumbnail, and the retired "原始信息" label stays gone.
    await waitFor(() => document.querySelector('.version-list[aria-label="版本树"] .related i img[src]'),
      '版本树 rows show the output thumbnail');
    if (document.body.textContent.includes('原始信息')) throw new Error('原始信息 label is back in the inspector');

    // Switching versions selects the child through the real API. The selected
    // row leads with the check icon (svg); unselected rows lead with a bare
    // marker <i> (the trailing chevron svg exists on every row).
    const listRows = () => Array.from(document.querySelectorAll('.version-list[aria-label="版本"] .related'));
    const childRow = listRows()
      .find((row) => (row.querySelector('span')?.childNodes[0]?.textContent || '').trim() === '版本 2');
    (childRow || listRows()[1]).click();
    const childSelected = () => {
      const rows = listRows();
      return rows.length >= 2
        && rows[1]?.firstElementChild?.tagName === 'svg'
        && rows[0]?.firstElementChild?.tagName !== 'svg';
    };
    await waitFor(() => childSelected() && document.querySelectorAll('.version-list[aria-label="版本"] .related').length >= 2,
      'the child version renders in the inspector');
    const switchedToChild = childSelected();

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

    // --- Task 144: conversation rounds in the version tree ---
    // Select the second conversation asset (turn 2). Its window is
    // assets 1-3, the current row in the middle.
    const secondCard = await waitFor(() => Array.from(document.querySelectorAll('.asset-card'))
      .find((card) => card.dataset.assetId === config.secondId) || null, 'second conversation card');
    secondCard.click();
    const treeList = () => document.querySelector('.version-list[aria-label="版本树"]');
    const treeRowSmalls = () => Array.from(treeList().querySelectorAll('.related > span > small')).map((el) => el.textContent);
    await waitFor(() => treeRowSmalls().join('|') === '共 4 轮 · 第 1 轮|共 4 轮 · 当前第 2 轮|共 4 轮 · 第 3 轮',
      '版本树 default window shows turns 1-3 around the current asset');
    const roundsDefaultRows = treeList().querySelectorAll('.related').length;
    const roundsSmallLines = treeRowSmalls();
    const treeHeading = () => Array.from(document.querySelectorAll('.details .field-heading'))
      .find((heading) => heading.querySelector('span')?.textContent === '版本树');
    const roundsBadge = treeHeading().querySelector('.settings-badge')?.textContent || '';

    // 查看 expands to every captured image of the conversation (4).
    Array.from(treeHeading().querySelectorAll('.section-action')).find((button) => button.textContent.trim() === '查看').click();
    await waitFor(() => treeList().querySelectorAll('.related').length === 4, '版本树 expanded shows all 4 images');
    const roundsExpandedRows = treeList().querySelectorAll('.related').length;

    // The second line truncates with an ellipsis of its own.
    const roundsEllipsis = getComputedStyle(treeList().querySelector('.related > span > small')).textOverflow === 'ellipsis';

    // Clicking the third row jumps to that image: it becomes the current row.
    treeList().querySelectorAll('.related')[2].click();
    await waitFor(() => {
      const rows = Array.from(treeList().querySelectorAll('.related'));
      return rows.length === 4
        && rows[2]?.classList.contains('is-current')
        && treeRowSmalls().join('|') === '共 4 轮 · 第 1 轮|共 4 轮 · 第 2 轮|共 4 轮 · 当前第 3 轮|共 4 轮 · 第 4 轮';
    }, '版本树 jumps to the third image and marks it current');
    const rowsAfterJump = Array.from(treeList().querySelectorAll('.related'));
    const roundsCurrentMarked = rowsAfterJump[2]?.classList.contains('is-current') === true
      && rowsAfterJump.some((row, index) => index !== 2 && !row.classList.contains('is-current'));
    const roundsSwitchedToThird = treeRowSmalls()[2] === '共 4 轮 · 当前第 3 轮';

    return {
      versionRows, switchedToChild, generationRowShown, promptEdited, promptPersisted,
      roundsDefaultRows, roundsSmallLines, roundsBadge, roundsExpandedRows,
      roundsEllipsis, roundsCurrentMarked, roundsSwitchedToThird,
    };
  })()
  `;
}
