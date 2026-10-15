// GravityPort React UI flow, task 148: every block of the expanded 版本树
// 「查看」 region renders thumbnail rows and no gen- generation id reaches the
// screen. One 4-turn ChatGPT conversation seeded through the capture-plugin
// turn-bindings endpoint; prompts and timestamps are tuned so the lineage
// resolver naturally proposes exactly one candidate per child
// (3←2 and 4←3 pass the 0.45 confidence bar: same conversation + immediately
// previous + recent + modification prompt + same model = 0.69; the older
// pairs lose the recency signal and land at 0.43).
export const name = "version-view-rows";
export const description = "查看 expand: no gen- ids -> candidate pair confirm -> tree jump -> candidate dismiss -> add relation from thumbnail rows -> relation edit/delete -> version history rows";

export async function run(ctx) {
  await ctx.prepare();
  const captureToken = "mosa_e2e_capture_vview_token";
  const previousCaptureToken = process.env.MOSA_WEB_CAPTURE_TOKEN;
  process.env.MOSA_WEB_CAPTURE_TOKEN = captureToken;
  const server = await ctx.startServer();
  try {
    // A two-version asset for the 版本历史 block.
    const parentCreate = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("vview-parent.png", [74, 127, 181]), prompt: "vview versioned original prompt",
    });
    const parent = parentCreate.asset;
    const versionChild = await ctx.api(server.origin, "POST",
      `/api/assets/default/${encodeURIComponent(parent.id)}/versions`,
      { version_change: "vview version change" });

    // Four assets of one conversation, turns 1-4. Gaps 2→3 and 3→4 are 29
    // minutes (recent), 1→3 and 2→4 are ≥58 minutes (not recent), so exactly
    // the adjacent pairs reach candidate confidence.
    const roundsAssets = [];
    for (let index = 1; index <= 4; index += 1) {
      const created = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default", imagePath: await ctx.makePng(`vview-rounds-${index}.png`, [40 + index * 30, 120, 180]),
        prompt: `vview rounds prompt ${index}`,
      });
      roundsAssets.push(created.asset);
    }
    const minute = 60000;
    const baseTime = Date.parse("2026-10-15T08:00:00.000Z");
    const turnStart = [0, 91, 120, 149]; // minutes after baseTime: gaps 29/29/29, 1→3 = 120
    const prompts = [
      "vview rounds prompt one",
      "vview rounds prompt two",
      "vview rounds prompt three 把背景改成暖色",
      "vview rounds prompt four 把阴影改成冷色",
    ];
    for (let index = 1; index <= 4; index += 1) {
      await ctx.api(server.origin, "POST", "/api/generations", {
        projectId: "default",
        output_asset_id: roundsAssets[index - 1].id,
        provider: "chatgpt",
        conversation_id: "e2e-conv-vview",
        provider_asset_id: `file-vview-${index}`,
        model: "gpt-5-4-thinking",
        effective_prompt: prompts[index - 1],
        created_at: new Date(baseTime + turnStart[index - 1] * minute).toISOString(),
      });
    }
    const bindings = Array.from({ length: 4 }, (_, index) => ({
      provider_asset_id: `file-vview-${index + 1}`,
      message_id: `m-vview-${index + 1}`,
      turn_index: index + 1,
    }));
    const bound = await fetch(`${server.origin}/api/ingest/web-capture-turn-bindings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${captureToken}` },
      body: JSON.stringify({
        project_id: "default",
        provider: "chatgpt",
        conversation_id: "e2e-conv-vview",
        turn_count: 4,
        bindings,
      }),
    });
    const boundResult = await bound.json().catch(() => ({}));
    if (!bound.ok || boundResult.matched !== 4 || boundResult.updated !== 4) {
      throw new Error(`web-capture-turn-bindings failed: HTTP ${bound.status} ${JSON.stringify(boundResult)}`);
    }

    const first = await ctx.runInPage(server, firstStageSource({
      asset2Id: roundsAssets[1].id,
      asset3Id: roundsAssets[2].id,
      asset4Id: roundsAssets[3].id,
    }));
    for (const field of ["regionHasNoGenerationId", "sameConversationBlockGone", "candidatePairSrcs", "secondCandidatePairSrcs",
      "confidenceText", "confirmAddedRelation", "confirmedCardGone", "dismissedCardGone", "dismissedStatusPersisted",
      "treeNodeCount", "treeNodeImages", "treeJumpTargetId", "currentRowFlipped"]) {
      if (first?.[field] === undefined || first?.[field] === false || (field === "treeNodeCount" && first[field] !== 2)) {
        throw new Error(`version-view-rows stage 1 failed at ${field}: ${JSON.stringify(first)}`);
      }
    }

    // The related-generation picker must hide trashed assets: trash #4 from
    // the real API, then drive the picker in a fresh page.
    const trashed = await ctx.api(server.origin, "POST", "/api/assets/batch", {
      action: "trash", projectId: "default", assetIds: [roundsAssets[3].id],
    });
    if (!JSON.stringify(trashed).includes(`"${roundsAssets[3].id}"`)) {
      throw new Error(`trash batch did not confirm asset 4: ${JSON.stringify(trashed).slice(0, 200)}`);
    }

    const second = await ctx.runInPage(server, secondStageSource({
      asset1Id: roundsAssets[0].id,
      asset2Id: roundsAssets[1].id,
      asset3Id: roundsAssets[2].id,
      asset4Id: roundsAssets[3].id,
      parentId: parent.id,
    }));
    for (const field of ["anchorIsCurrent", "pickerRows", "pickerHasNoTrashed", "pickerHasNoCurrent", "choiceSelected", "addCreatedRelation",
      "editorPairLines", "relationTypeEdited", "relationDeleted", "regionStillHasNoGenerationId",
      "versionRows", "versionRowImages", "currentVersionMarked", "compareImages"]) {
      if (second?.[field] === undefined || second?.[field] === false
        || (field === "pickerRows" && second[field] !== 2)
        || (field === "versionRows" && second[field] !== 2)
        || (field === "compareImages" && second[field] !== 2)) {
        throw new Error(`version-view-rows stage 2 failed at ${field}: ${JSON.stringify(second)}`);
      }
    }
    if (second.editorPairLines.join("|") !== "第 2 轮 → 第 3 轮|第 1 轮 → 第 3 轮") {
      throw new Error(`relation editor pair lines wrong: ${JSON.stringify(second.editorPairLines)}`);
    }
    return { first, second };
  } finally {
    if (previousCaptureToken === undefined) delete process.env.MOSA_WEB_CAPTURE_TOKEN;
    else process.env.MOSA_WEB_CAPTURE_TOKEN = previousCaptureToken;
    await server.stop();
  }
}

const HELPERS = `
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      let stable = 0;
      while (Date.now() < deadline) {
        const value = await check();
        if (value) { stable += 1; if (stable >= 2) return value; } else stable = 0;
        await sleep(100);
      }
      const genProbe = await fetch('/api/assets/default/' + (window.__vviewAsset3 || config.asset3Id) + '/generation-history')
        .then((r) => r.json()).catch((e) => String(e));
      const h = genProbe?.history || {};
      const outMap = {};
      for (const e of [...(h.events || []), ...(h.context_events || [])]) outMap[e.id] = e.output_asset_id;
      const probe = JSON.stringify({
        rel: (h.relations || []).map((r) => [outMap[r.child_generation_id], outMap[r.parent_generation_id], r.relation_type]),
        cand: (h.relation_candidates || []).map((c) => [outMap[c.child_generation_id], outMap[c.parent_generation_id], c.confidence, c.status]),
        ev: (h.events || []).map((e) => e.output_asset_id),
        ctx: (h.context_events || []).map((e) => e.output_asset_id),
      });
      throw new Error('Timed out waiting for ' + label + ' | cards=' + document.querySelectorAll('.asset-card').length
        + ' | toast=' + (document.querySelector('.toast')?.textContent || '')
        + ' | probe=' + probe.slice(0, 1200));
    }
    const assetJson = (id) => fetch('/api/assets/default/' + id).then((r) => r.json()).then((d) => d.asset || d);
    // A row shows the thumbnail, or the original image while the thumbnail
    // is still being made (slow CI runners), so a src matches an asset when
    // it is any of that asset's image URLs.
    const assetUrls = (asset) => [asset.thumbnail_url, asset.image_url, asset.medium_url, asset.preview_url].filter(Boolean);
    const srcIsAsset = (src, asset) => Boolean(src) && assetUrls(asset).includes(src);
    const srcsAre = (srcs, assets) => srcs.length === assets.length && assets.every((asset, index) => srcIsAsset(srcs[index], asset));
    const historyOf = (id) => fetch('/api/assets/default/' + id + '/generation-history')
      .then((r) => r.json()).then((d) => d.history || d);
    const region = () => document.querySelector('.version-tree');
    const noGenerationIds = () => {
      const root = region();
      if (!root) return false;
      if (root.textContent.includes('gen-')) return false;
      for (const el of root.querySelectorAll('[aria-label]')) {
        if (el.getAttribute('aria-label').includes('gen-')) return false;
      }
      return true;
    };
    const treeHeading = () => Array.from(document.querySelectorAll('.details .field-heading'))
      .find((heading) => heading.querySelector('span')?.textContent === '版本树');
    const openViewer = async () => {
      await waitFor(() => treeHeading() && treeHeading().querySelector('.section-action'), '查看 action');
      Array.from(treeHeading().querySelectorAll('.section-action')).find((b) => b.textContent.trim() === '查看').click();
      await waitFor(() => Boolean(region()), '展开的版本树区域');
    };
    const selectCard = async (assetId) => {
      const card = await waitFor(() => Array.from(document.querySelectorAll('.asset-card'))
        .find((el) => el.dataset.assetId === assetId) || null, 'card ' + assetId);
      card.click();
      await waitFor(() => document.querySelector('.details .asset-title'), 'inspector for ' + assetId);
      await sleep(300);
    };
    const setSelect = (select, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const relationRows = (assetId) => historyOf(assetId).then((h) => ({
      relations: h.relations || [],
      candidates: h.relation_candidates || [],
      events: h.events || [],
      context: h.context_events || [],
    }));
    const eventForAsset = (stage, assetId) => stage.events.find((e) => e.output_asset_id === assetId)?.id
      || stage.context.find((e) => e.output_asset_id === assetId)?.id || '';
`;

function firstStageSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${HELPERS}
    window.__vviewAsset3 = config.asset3Id;

    await selectCard(config.asset3Id);
    await openViewer();

    // No generation id anywhere in the expanded region; the retired block is gone.
    const regionHasNoGenerationId = await waitFor(noGenerationIds, '展开区不含 gen- 编号');
    const sameConversationBlockGone = !document.body.textContent.includes('同对话候选');

    // Two natural candidates: 3←2 (the asset's own modification prompt) and
    // 4←3 (surfaced because its upstream 3 is connected). Card order follows
    // random event ids, so both cards are identified by their thumbnail pair.
    const cards = await waitFor(() => {
      const list = Array.from(region().querySelectorAll('.generation-candidate-card'));
      return list.length === 2 ? list : null;
    }, '两张候选关系卡');
    const [upstream, downstream, downstream4] = await Promise.all([
      assetJson(config.asset2Id), assetJson(config.asset3Id), assetJson(config.asset4Id),
    ]);
    const pairSrcs = (card) => Array.from(card.querySelectorAll('.relation-pair-row i img')).map((img) => img.getAttribute('src'));
    const confirmCard = cards.find((card) => srcsAre(pairSrcs(card), [upstream, downstream]));
    const dismissCard = cards.find((card) => srcsAre(pairSrcs(card), [downstream, downstream4]));
    if (!confirmCard || !dismissCard) throw new Error('候选卡配对不上: ' + JSON.stringify(cards.map(pairSrcs)));
    const candidatePairSrcs = true;
    const secondCandidatePairSrcs = true;
    const confidenceText = Array.from(confirmCard.querySelectorAll(':scope > small'))
      .map((el) => el.textContent).find((t) => t.includes('把握')) || '';
    if (confidenceText !== '把握 69%') throw new Error('候选把握文本不符合打分预期: ' + confidenceText);

    // Confirming writes the relation and removes that candidate (the other
    // card stays until it is dismissed below).
    Array.from(confirmCard.querySelectorAll('button')).find((b) => b.textContent.trim() === '确认关系').click();
    await waitFor(async () => {
      const stage = await relationRows(config.asset3Id);
      const parentEvent = stage.events.find((e) => e.output_asset_id === config.asset2Id);
      const childEvent = stage.events.find((e) => e.output_asset_id === config.asset3Id);
      const linked = stage.relations.some((r) => r.parent_generation_id === (parentEvent || {}).id
        && r.child_generation_id === (childEvent || {}).id);
      const pairStillSuggested = stage.candidates.some((c) => c.child_generation_id === (childEvent || {}).id
        && c.parent_generation_id === (parentEvent || {}).id);
      return linked && !pairStillSuggested;
    }, '确认关系写入接口且该候选消失');
    const confirmAddedRelation = true;
    const confirmedCardGone = await waitFor(() => {
      const list = Array.from(region().querySelectorAll('.generation-candidate-card'));
      return list.length === 1 && srcsAre(pairSrcs(list[0]), [downstream, downstream4]);
    }, '已确认的候选卡消失，只剩 4←3');

    // Dismiss the remaining 4←3 candidate: it leaves the screen and the API
    // keeps it with status dismissed (re-PATCH reads the persisted row).
    const stageForDismiss = await relationRows(config.asset3Id);
    const child4 = (stageForDismiss.events.find((e) => e.output_asset_id === config.asset4Id)
      || stageForDismiss.context.find((e) => e.output_asset_id === config.asset4Id) || {}).id || '';
    const freshDismissCard = await waitFor(() => {
      const list = Array.from(region().querySelectorAll('.generation-candidate-card'));
      return list.length === 1 ? list[0] : null;
    }, '只剩 4←3 候选卡');
    Array.from(freshDismissCard.querySelectorAll('button')).find((b) => b.textContent.trim() === '忽略候选').click();
    await waitFor(async () => {
      const stage = await relationRows(config.asset3Id);
      return !stage.candidates.some((c) => c.child_generation_id === child4);
    }, '忽略候选从接口候选列表消失');
    const dismissedCardGone = await waitFor(() => !region().querySelector('.generation-candidate-card'), '忽略后候选卡全部消失');
    const stageNow = await relationRows(config.asset3Id);
    const child4b = (stageNow.events.find((e) => e.output_asset_id === config.asset4Id)
      || stageNow.context.find((e) => e.output_asset_id === config.asset4Id) || {}).id || '';
    const parent3 = (stageNow.events.find((e) => e.output_asset_id === config.asset3Id) || {}).id || '';
    const patched = await fetch('/api/generation-relation-candidates', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-mosa-client-token': sessionStorage.getItem('mosa.client-token') || '' },
      body: JSON.stringify({ projectId: 'default', childGenerationId: child4b, parentGenerationId: parent3, status: 'dismissed' }),
    }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
    const dismissedStatusPersisted = patched?.candidate?.status === 'dismissed';

    // The tree now shows both nodes as thumbnail rows; clicking the upstream
    // (non-current) node jumps to that image.
    const treeRows = await waitFor(() => {
      const rows = Array.from(region().querySelectorAll('.generation-tree-row'));
      return rows.length === 2 && rows.every((row) => row.querySelector('i img')) ? rows : null;
    }, '生成关系树两行缩略图');
    const treeNodeCount = treeRows.length;
    const treeNodeImages = treeRows.every((row) => row.querySelector('i img'));
    const selectedCard = () => document.querySelector('.asset-card.asset-selected')?.dataset.assetId || '';
    treeRows[0].click();
    await waitFor(() => selectedCard() === config.asset2Id, '点树节点跳到上游素材');
    const treeJumpTargetId = selectedCard();
    const currentRowFlipped = await waitFor(() => {
      const rows = Array.from(region().querySelectorAll('.generation-tree-row'));
      return rows.length === 2 && rows[0].classList.contains('is-current') && !rows[1].classList.contains('is-current');
    }, '当前行高亮随跳转翻转');

    return {
      regionHasNoGenerationId, sameConversationBlockGone, candidatePairSrcs, secondCandidatePairSrcs, confidenceText,
      confirmAddedRelation, confirmedCardGone, dismissedCardGone, dismissedStatusPersisted,
      treeNodeCount, treeNodeImages, treeJumpTargetId, currentRowFlipped,
    };
  })()
  `;
}

function secondStageSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${HELPERS}
    window.confirm = () => true;
    window.__vviewAsset3 = config.asset3Id;

    await selectCard(config.asset3Id);
    await openViewer();
    await waitFor(noGenerationIds, '展开区不含 gen- 编号');

    // 添加生成关系: the anchor display, the picker rows and the trashed filter.
    Array.from(region().querySelectorAll('button')).find((b) => b.textContent.trim() === '添加生成关系').click();
    const create = await waitFor(() => region().querySelector('.generation-relation-create'), '添加关系表单');
    await waitFor(() => create.querySelector('.relation-choice-list[aria-label="关联生成"]'), '关联生成列表');
    const anchorStatic = create.querySelector('.related.row-static');
    const anchorIsCurrent = !!(anchorStatic && anchorStatic.classList.contains('is-current') && anchorStatic.querySelector('i img'));
    const pickerRows = await waitFor(() => {
      const rows = Array.from(create.querySelectorAll('.relation-choice-list[aria-label="关联生成"] .related'));
      return rows.length === 2 ? rows : null;
    }, '关联列表两行（不含当前和回收站）');
    const pickerImgs = pickerRows.map((row) => row.querySelector('i img')?.getAttribute('src') || '');
    const [a1, a2, a3, a4] = await Promise.all([
      assetJson(config.asset1Id), assetJson(config.asset2Id), assetJson(config.asset3Id), assetJson(config.asset4Id),
    ]);
    const pickerHasNoTrashed = !pickerImgs.some((src) => srcIsAsset(src, a4));
    const pickerHasNoCurrent = !pickerImgs.some((src) => srcIsAsset(src, a3));
    // Rows are ordered by turn, so the picker lists asset 1 then asset 2.
    if (!srcsAre(pickerImgs, [a1, a2])) throw new Error('关联列表缩略图不对: ' + pickerImgs.join('|'));

    // Pick asset 1, keep 关联项为上游, confirm: relation asset1 → asset3.
    pickerRows[0].click();
    await waitFor(() => pickerRows[0].getAttribute('aria-pressed') === 'true', '选中行高亮 aria-pressed');
    const choiceSelected = pickerRows[0].getAttribute('aria-pressed') === 'true';
    setSelect(create.querySelector('select[aria-label="关系方向"]'), 'candidate-parent');
    Array.from(create.querySelectorAll('button')).find((b) => b.textContent.trim() === '确认添加').click();
    await waitFor(async () => {
      const stage = await relationRows(config.asset3Id);
      const p = stage.events.find((e) => e.output_asset_id === config.asset1Id);
      const c = stage.events.find((e) => e.output_asset_id === config.asset3Id);
      return stage.relations.some((r) => r.parent_generation_id === (p || {}).id && r.child_generation_id === (c || {}).id);
    }, '确认添加写入 第1张→第3张');
    const addCreatedRelation = true;

    // Confirmed relations render as pair rows; edit the type of 1→3, then delete it.
    const editors = await waitFor(() => {
      const rows = Array.from(region().querySelectorAll('.generation-relation-editor'))
        .filter((el) => el.querySelector('.relation-pair-row i img'));
      return rows.length === 2 ? rows : null;
    }, '两条已确认关系各一行双缩略图');
    const editorPairLines = editors.map((el) => el.querySelector('.relation-pair-row > small')?.textContent || '');
    const target = editors[editorPairLines.indexOf('第 1 轮 → 第 3 轮')];
    if (!target) throw new Error('没找到 1→3 的关系编辑行: ' + JSON.stringify(editorPairLines));
    setSelect(target.querySelector('select[aria-label="关系类型"]'), 'variant_of');
    Array.from(target.querySelectorAll('button')).find((b) => b.textContent.trim() === '保存关系').click();
    await waitFor(async () => {
      const stage = await relationRows(config.asset3Id);
      const p = stage.events.find((e) => e.output_asset_id === config.asset1Id);
      if (!stage.relations.some((r) => r.parent_generation_id === (p || {}).id && r.relation_type === 'variant_of')) return false;
      // The editor row is keyed by relation type: saving swaps the DOM node.
      // Re-query and only proceed once the fresh row shows the saved value.
      const rows = Array.from(region().querySelectorAll('.generation-relation-editor'))
        .filter((el) => el.querySelector('.relation-pair-row i img'));
      return rows.some((el) => el.querySelector('.relation-pair-row > small')?.textContent === '第 1 轮 → 第 3 轮'
        && el.querySelector('select[aria-label="关系类型"]')?.value === 'variant_of');
    }, '保存关系改类型并刷新编辑行');
    const relationTypeEdited = true;
    const refreshedTarget = Array.from(region().querySelectorAll('.generation-relation-editor'))
      .filter((el) => el.querySelector('.relation-pair-row i img'))
      .find((el) => el.querySelector('.relation-pair-row > small')?.textContent === '第 1 轮 → 第 3 轮');
    if (!refreshedTarget) throw new Error('保存后找不到重建的 1→3 编辑行');
    Array.from(refreshedTarget.querySelectorAll('button')).find((b) => b.textContent.trim() === '删除关系').click();
    await waitFor(async () => {
      const stage = await relationRows(config.asset3Id);
      const p = stage.events.find((e) => e.output_asset_id === config.asset1Id);
      return !stage.relations.some((r) => r.parent_generation_id === (p || {}).id);
    }, '删除关系从接口移除');
    const relationDeleted = true;
    const regionStillHasNoGenerationId = noGenerationIds();

    // 版本历史 rows for the two-version asset, untouched 版本对比.
    await selectCard(config.parentId);
    await waitFor(() => Boolean(region()), '展开区跟随素材仍在');
    const versionRowsList = await waitFor(() => {
      const rows = Array.from(region().querySelectorAll(':scope > .related'));
      return rows.length === 2 && rows.every((row) => row.querySelector('i img')) ? rows : null;
    }, '版本历史两行缩略图');
    const versionRows = versionRowsList.length;
    const versionRowImages = versionRowsList.every((row) => row.querySelector('i img'));
    const currentVersionMarked = versionRowsList[0].classList.contains('is-current')
      && !versionRowsList[1].classList.contains('is-current');
    const compareImages = await waitFor(() => {
      const imgs = region().querySelectorAll('.version-compare-images img');
      return imgs.length === 2 && Array.from(imgs).every((img) => img.getAttribute('src')) ? imgs.length : 0;
    }, '版本对比两张图');

    return {
      anchorIsCurrent, pickerRows: pickerRows.length, pickerHasNoTrashed, pickerHasNoCurrent, pickerImgs: pickerImgs.join('|'),
      choiceSelected, addCreatedRelation, editorPairLines, relationTypeEdited, relationDeleted,
      regionStillHasNoGenerationId, versionRows, versionRowImages, currentVersionMarked, compareImages,
    };
  })()
  `;
}
