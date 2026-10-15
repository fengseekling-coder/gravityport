// GravityPort React UI flow: inspector tag row — vendor name first, system
// tags hidden, bare-text styling, focus-revealed × writes the full stored tag
// list back to the server, and the collapsed row folds into "+N" on two lines
// that recomputes when the row's container narrows.
export const name = "inspector-tags";
export const description = "API-seeded capture tags -> inspector shows vendor+user tags only -> bare-text alignment/transparent chips -> focus-revealed x deletes with hidden tags preserved server-side -> 20-tag asset folds to +N on two lines -> narrower container folds more";

const MANY_TAGS = Array.from({ length: 20 }, (_, index) => `标签${String(index + 1).padStart(2, "0")}`);

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const basic = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath: await ctx.makePng("tags-basic.png", [74, 127, 181]),
      prompt: "inspector tags basic flow",
      tags: ["auto-archived", "chatgpt", "web-capture", "风景"],
      sourceType: "web-chatgpt",
    });
    const many = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath: await ctx.makePng("tags-many.png", [181, 68, 74]),
      prompt: "inspector tags many flow",
      tags: MANY_TAGS,
      sourceType: "web-chatgpt",
    });
    const storedTags = async (assetId) => {
      const payload = await ctx.api(server.origin, "GET", `/api/assets/default/${encodeURIComponent(assetId)}`);
      return Array.isArray(payload?.asset?.tags) ? payload.asset.tags : null;
    };
    const seededBasic = await storedTags(basic.asset.id);
    const seededMany = await storedTags(many.asset.id);
    if (JSON.stringify(seededBasic) !== JSON.stringify(["auto-archived", "chatgpt", "web-capture", "风景"])) {
      throw new Error(`inspector-tags seed: basic asset tags wrong on the server: ${JSON.stringify(seededBasic)}`);
    }
    if (seededMany?.length !== 20) {
      throw new Error(`inspector-tags seed: many-tag asset tags wrong on the server: ${JSON.stringify(seededMany)}`);
    }
    const assetName = (created) => created.asset.name || created.asset.asset
      || String(created.asset.image_path || "").split("/").pop();
    const config = {
      basicName: assetName(basic),
      manyName: assetName(many),
    };

    const wide = await ctx.runInPage(server, basicRoundSource(config));
    assertBasicRound(wide);
    const afterDelete = await storedTags(basic.asset.id);
    if (JSON.stringify(afterDelete) !== JSON.stringify(["auto-archived", "chatgpt", "web-capture"])) {
      throw new Error(`inspector-tags delete did not preserve hidden tags on the server: ${JSON.stringify(afterDelete)}`);
    }

    const wideMany = await ctx.runInPage(server, manyRoundSource(config));
    assertManyRound(wideMany, "wide");
    return { wideFolded: wideMany.foldedCount, narrowFolded: wideMany.narrowFolded };
  } finally {
    await server.stop();
  }
}

function assertBasicRound(result) {
  const problems = [];
  if (result?.vendorText !== "ChatGPT") problems.push(`first chip is ${JSON.stringify(result?.vendorText)}`);
  if (result?.secondTagText !== "风景") problems.push(`second visible tag is ${JSON.stringify(result?.secondTagText)}`);
  if (result?.systemTagsAbsent !== true) problems.push(`system tags visible: ${JSON.stringify(result?.leakedText)}`);
  if (!(result?.leftDelta <= 1)) problems.push(`first tag left edge off by ${result?.leftDelta}px`);
  if (result?.chipBackground !== "rgba(0, 0, 0, 0)") problems.push(`chip background ${result?.chipBackground}`);
  if (result?.removeOpacityBefore !== "0") problems.push(`remove x visible before focus: ${result?.removeOpacityBefore}`);
  if (result?.removeOpacityFocused !== "1") problems.push(`remove x not revealed on focus: ${result?.removeOpacityFocused}`);
  if (result?.deletedFromRow !== true) problems.push("deleted tag stayed in the row");
  if (problems.length) throw new Error(`Inspector tags basic round: ${problems.join("; ")}`);
}

function assertManyRound(result, phase) {
  const problems = [];
  if (result?.twoLineOk !== true) problems.push(`collapsed row height ${result?.rowHeight} > 2×${result?.chipHeight}+4`);
  if (!(result?.foldedCount > 0)) problems.push("no +N on the 20-tag asset");
  if (!(result?.narrowFolded > result?.foldedCount)) problems.push(`shrunk container must fold more (was +${result?.foldedCount}, got +${result?.narrowFolded})`);
  if (result?.narrowTwoLineOk !== true) problems.push(`shrunk row height ${result?.narrowRowHeight} > 2×${result?.chipHeight}+4`);
  if (result?.expandedChipCount !== 21) problems.push(`expanded row shows ${result?.expandedChipCount} chips`);
  if (result?.collapseLabel !== "收起") problems.push(`expanded toggle reads ${JSON.stringify(result?.collapseLabel)}`);
  if (problems.length) throw new Error(`Inspector tags ${phase} round: ${problems.join("; ")} — ${JSON.stringify(result)}`);
}

const PAGE_HELPERS = `
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label + ' | chips=' + chips().length
        + ' | details=' + (document.querySelector('.details')?.textContent || '').slice(0, 300));
    }
    const cards = () => Array.from(document.querySelectorAll('.asset-card'));
    const row = () => document.querySelector('.details .tags');
    const chips = () => Array.from(document.querySelectorAll('.details .tags > .tag-chip'));
    const openCard = async (namePart, readyCheck, label) => {
      await waitFor(() => document.querySelector('.app') && cards().length === 2, 'two seeded cards');
      const card = cards().find((c) => (c.getAttribute('aria-label') || '').includes(namePart));
      if (!card) throw new Error('card not found for ' + namePart + ': ' + JSON.stringify(cards().map((c) => c.getAttribute('aria-label'))));
      card.click();
      return waitFor(readyCheck, label);
    };
    // Switching assets renders the new row with the previous fit for one
    // frame; the folded count settles once the re-measure effect has run.
    const settledToggle = async () => {
      let previous = -1;
      const deadline = Date.now() + 8000;
      for (;;) {
        const toggle = row().querySelector(':scope > .tags-toggle');
        const current = toggle && toggle.textContent.startsWith('+') ? Number.parseInt(toggle.textContent.slice(1), 10) : -1;
        if (current >= 0 && current === previous) return { toggle, foldedCount: current };
        previous = current;
        if (Date.now() > deadline) throw new Error('folded count never settled, last=+' + previous);
        await sleep(120);
      }
    };
`;

function basicRoundSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
${PAGE_HELPERS}
    await openCard(config.basicName, () => chips().some((c) => c.textContent.includes('风景')), 'basic asset tag row');
    const vendor = chips()[0];
    const vendorText = vendor.textContent.trim();
    const secondTagText = chips()[1]?.querySelector(':scope > span')?.textContent || '';
    const detailsText = document.querySelector('.details').textContent;
    const leaked = ['auto-archived', 'web-capture', 'manual-capture'].filter((t) => detailsText.includes(t));
    const promptLeft = document.getElementById('asset-prompt').getBoundingClientRect().left;
    const vendorLeft = vendor.getBoundingClientRect().left;
    const chipBackground = getComputedStyle(vendor).backgroundColor;

    // The × hides until the tag is hovered or keyboard-focused; focus proves
    // the reveal path (CSS :hover shares the same rule block).
    const tagChip = chips()[1];
    const removeButton = tagChip.querySelector('button');
    const removeOpacityBefore = getComputedStyle(removeButton).opacity;
    removeButton.focus();
    const removeOpacityFocused = getComputedStyle(removeButton).opacity;
    removeButton.click();
    await waitFor(() => !chips().some((c) => c.textContent.includes('风景')), 'deleted tag leaving the row');

    return {
      vendorText,
      secondTagText,
      systemTagsAbsent: leaked.length === 0,
      leakedText: leaked.join(','),
      leftDelta: Math.abs(promptLeft - vendorLeft),
      chipBackground,
      removeOpacityBefore,
      removeOpacityFocused,
      deletedFromRow: true,
    };
  })()
  `;
}

function manyRoundSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
${PAGE_HELPERS}
    await openCard(config.manyName, () => chips().some((c) => c.textContent.includes('标签01')), 'many-tag asset row');
    const { toggle, foldedCount } = await settledToggle();
    if (foldedCount <= 0) throw new Error('no +N on the collapsed 20-tag row');
    const chipHeight = chips()[0].getBoundingClientRect().height;
    const rowHeight = row().getBoundingClientRect().height;
    const twoLineOk = rowHeight <= chipHeight * 2 + 4 + 1;

    // Shrink the inspector container: the ResizeObserver-driven re-fit must
    // fold harder and stay within two lines.
    const details = document.querySelector('.details');
    const wideWidth = details.style.width;
    details.style.width = '150px';
    const shrunk = await settledToggle();
    if (shrunk.foldedCount <= foldedCount) {
      throw new Error('shrunk container folded count +' + shrunk.foldedCount + ' must exceed +' + foldedCount);
    }
    const narrowRowHeight = row().getBoundingClientRect().height;
    const narrowTwoLineOk = narrowRowHeight <= chipHeight * 2 + 4 + 1;
    details.style.width = wideWidth;

    // Re-query after the restore renders; a stale node reference could no-op.
    const restoredToggle = await waitFor(() => row().querySelector(':scope > .tags-toggle'), 'restored +N toggle');
    restoredToggle.click();
    await waitFor(() => chips().length === 21, 'all 20 tags + vendor after expanding');
    const collapseLabel = row().querySelector(':scope > .tags-toggle')?.textContent || '';

    return { chipHeight, rowHeight, twoLineOk, foldedCount, narrowFolded: shrunk.foldedCount, narrowRowHeight, narrowTwoLineOk,
      expandedChipCount: chips().length, collapseLabel };
  })()
  `;
}
