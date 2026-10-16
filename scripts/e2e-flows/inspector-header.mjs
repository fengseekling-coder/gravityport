// GravityPort React UI flow: inspector header line (kind · source · date),
// the group property tag at the end of the property row, and the prompt
// provenance notices for web sources (web-unavailable copy inside the prompt
// box, provider-visible provenance line below it). Also checks the English
// locale via the persisted language preference and measures how the header
// line wraps at the narrowest inspector width.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const name = "inspector-header";
export const description = "API-seeded assets (ChatGPT ±prompt, Gemini provider-visible, local import, video) -> header shows 类型 · 来源 · 日期, group tag appends to the property row only when grouped, prompt box swaps in web-unavailable copy or shows the provenance line -> English locale renders the same via preference";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const seed = async (fileName, rgb, body) => ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath: await ctx.makePng(fileName, rgb),
      ...body,
    });

    const a = await seed("header-chatgpt.png", [74, 127, 181], {
      prompt: "inspector header chatgpt with prompt",
      sourceType: "web-chatgpt",
    });
    const b = await seed("header-chatgpt-noprompt.png", [127, 181, 74], {
      prompt: "",
      sourceType: "web-chatgpt",
      source: { prompt_status: "not-available" },
    });
    const c = await seed("header-gemini.png", [181, 127, 74], {
      prompt: "inspector header gemini visible prompt",
      sourceType: "web-gemini",
      source: { prompt_status: "provider-visible-prompt" },
    });
    const d = await seed("header-local.png", [127, 74, 181], {
      prompt: "inspector header local import",
    });
    // Video-shaped fixture bytes exercise the extension-based media kind
    // without a decodable payload (same recipe as cache-semantics.test.mjs).
    const videoPath = join(ctx.fixturesDir, "header-clip.mp4");
    await writeFile(videoPath, Buffer.from(Array.from({ length: 64 }, (_, index) => index)));
    const e = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath: videoPath,
      prompt: "inspector header video",
    });

    const groupRes = await ctx.api(server.origin, "POST", "/api/assets/batch", {
      action: "group",
      projectId: "default",
      assetIds: [a.asset.id],
      group: "海报参考",
    });
    const groupOk = Array.isArray(groupRes?.results) && groupRes.results.every((r) => r?.ok !== false);
    if (!groupOk) throw new Error(`inspector-header seed: grouping asset A failed: ${JSON.stringify(groupRes)}`);

    const readAsset = async (created) => {
      const payload = await ctx.api(server.origin, "GET", `/api/assets/default/${encodeURIComponent(created.asset.id)}`);
      return payload?.asset || null;
    };
    const storedA = await readAsset(a);
    const storedB = await readAsset(b);
    const storedC = await readAsset(c);
    if (storedA?.group !== "海报参考") throw new Error(`inspector-header seed: asset A group is ${JSON.stringify(storedA?.group)}`);
    if (!storedA?.created_at) throw new Error("inspector-header seed: asset A has no created_at");
    if (String(storedB?.source?.prompt_status || "") !== "not-available") throw new Error(`inspector-header seed: asset B prompt_status is ${JSON.stringify(storedB?.source?.prompt_status)}`);
    if (String(storedC?.source?.prompt_status || "") !== "provider-visible-prompt") throw new Error(`inspector-header seed: asset C prompt_status is ${JSON.stringify(storedC?.source?.prompt_status)}`);

    const assetName = (created) => created.asset.name || created.asset.asset
      || String(created.asset.image_path || "").split("/").pop();
    const config = {
      nameA: assetName(a),
      nameB: assetName(b),
      nameC: assetName(c),
      nameD: assetName(d),
      nameE: assetName(e),
      createdAtA: storedA.created_at,
    };

    const zh = await ctx.runInPage(server, zhRoundSource(config));
    assertZhRound(zh);
    // The zh round persisted the English preference as its last step; this
    // next launch picks it up from the shared user-data dir.
    const en = await ctx.runInPage(server, enRoundSource(config));
    assertEnRound(en);
    // The en round switched the preference back to Chinese; measure the
    // header wrap in that Chinese UI.
    const wrap = await ctx.runInPage(server, wrapRoundSource(config));
    if (!(wrap?.narrowHeight > 0)) throw new Error(`inspector-header wrap round: no height ${JSON.stringify(wrap)}`);
    return { zhTagCount: zh.tagsA.length, enHeaderA: en.headerA, wrap };
  } finally {
    await server.stop();
  }
}

function assertZhRound(result) {
  const problems = [];
  if (result?.headerA !== `图片 · ChatGPT 网页版 · ${result?.dateA}`) problems.push(`A header ${JSON.stringify(result?.headerA)} (expected date ${JSON.stringify(result?.dateA)})`);
  if (result?.tagsA?.length !== 5) problems.push(`A property tags ${JSON.stringify(result?.tagsA)}`);
  if (result?.lastTagA !== "海报参考") problems.push(`A last tag ${JSON.stringify(result?.lastTagA)}`);
  if (result?.provenanceA !== "") problems.push(`A showed provenance ${JSON.stringify(result?.provenanceA)}`);
  if (result?.tagsB?.length !== 4) problems.push(`B property tags ${JSON.stringify(result?.tagsB)}`);
  if (result?.promptB !== "网页来源未暴露原始生图提示词") problems.push(`B prompt copy ${JSON.stringify(result?.promptB)}`);
  if (result?.noRecordLeakB !== false) problems.push("B showed 无提示词记录");
  if (!result?.headerC?.includes("Gemini 网页版")) problems.push(`C header ${JSON.stringify(result?.headerC)}`);
  if (result?.provenanceC !== "Gemini 页面可见用户提示词（未验证为实际生图提示词）") problems.push(`C provenance ${JSON.stringify(result?.provenanceC)}`);
  if (!result?.headerD?.includes("手动导入")) problems.push(`D header ${JSON.stringify(result?.headerD)}`);
  if (result?.provenanceD !== "") problems.push(`D showed provenance ${JSON.stringify(result?.provenanceD)}`);
  if (!result?.headerE?.startsWith("视频 · ")) problems.push(`E header ${JSON.stringify(result?.headerE)}`);
  for (const key of ["a", "b", "c", "d", "e"]) {
    if (result?.[`localLeak${key.toUpperCase()}`] !== false) problems.push(`${key}: 本地素材 leaked into the inspector`);
  }
  if (problems.length) throw new Error(`Inspector header zh round: ${problems.join("; ")}`);
}

function assertEnRound(result) {
  const problems = [];
  if (result?.headerA !== `Image · ChatGPT Web · ${result?.dateA}`) problems.push(`A header ${JSON.stringify(result?.headerA)} (expected date ${JSON.stringify(result?.dateA)})`);
  if (result?.promptB !== "The web source did not expose the original image-generation prompt") problems.push(`B prompt copy ${JSON.stringify(result?.promptB)}`);
  if (problems.length) throw new Error(`Inspector header en round: ${problems.join("; ")}`);
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
      throw new Error('Timed out waiting for ' + label + ' | cards=' + cards().length
        + ' | details=' + (document.querySelector('.details')?.textContent || '').slice(0, 300));
    }
    const cards = () => Array.from(document.querySelectorAll('.asset-card'));
    const headerMuted = () => document.querySelector('.details .asset-meta > .muted')?.textContent || '';
    const propertyTags = () => Array.from(document.querySelectorAll('.details .asset-properties .property-tag')).map((t) => t.textContent);
    const promptText = () => document.getElementById('asset-prompt')?.textContent || '';
    const provenance = () => document.querySelector('.details .prompt-provenance')?.textContent || '';
    const detailsText = () => document.querySelector('.details')?.textContent || '';
    const expectDate = (iso, locale) => new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(iso));
    const openCard = async (namePart, readyCheck, label) => {
      const card = cards().find((c) => (c.getAttribute('aria-label') || '').includes(namePart));
      if (!card) throw new Error('card not found for ' + namePart + ': ' + JSON.stringify(cards().map((c) => c.getAttribute('aria-label'))));
      card.click();
      // The header text alone cannot tell assets apart (A and B are both
      // ChatGPT), so first wait until the inspector really shows the target.
      await waitFor(() => (document.querySelector('.details .asset-name')?.textContent || '').includes(namePart), 'inspector shows ' + namePart);
      return waitFor(readyCheck, label);
    };
    const noLocalCopy = () => detailsText().includes('本地素材');
`;

function zhRoundSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
${PAGE_HELPERS}
    await waitFor(() => document.querySelector('.app') && cards().length === 5, 'five seeded cards');

    await openCard(config.nameA, () => headerMuted().includes('ChatGPT 网页版'), 'asset A header');
    const dateA = expectDate(config.createdAtA, 'zh-CN');
    const headerA = headerMuted();
    const tagsA = propertyTags();
    const lastTagA = tagsA[tagsA.length - 1] || '';
    const provenanceA = provenance();
    const localLeakA = noLocalCopy();

    await openCard(config.nameB, () => headerMuted().includes('ChatGPT 网页版'), 'asset B header');
    const tagsB = propertyTags();
    const promptB = promptText();
    const noRecordLeakB = detailsText().includes('无提示词记录');
    const localLeakB = noLocalCopy();

    await openCard(config.nameC, () => headerMuted().includes('Gemini 网页版'), 'asset C header');
    const headerC = headerMuted();
    const provenanceC = provenance();
    const localLeakC = noLocalCopy();

    await openCard(config.nameD, () => headerMuted().includes('手动导入'), 'asset D header');
    const headerD = headerMuted();
    const provenanceD = provenance();
    const localLeakD = noLocalCopy();

    await openCard(config.nameE, () => headerMuted().startsWith('视频 · '), 'asset E header');
    const headerE = headerMuted();
    const localLeakE = noLocalCopy();

    // Persist the English preference for the next launch of this flow.
    localStorage.setItem('gravityport.preferences', JSON.stringify({ appearance: '跟随系统', cardInfo: false, language: 'en' }));

    return { headerA, dateA, tagsA, lastTagA, provenanceA, localLeakA,
      tagsB, promptB, noRecordLeakB, localLeakB,
      headerC, provenanceC, localLeakC,
      headerD, provenanceD, localLeakD,
      headerE, localLeakE };
  })()
  `;
}

function enRoundSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
${PAGE_HELPERS}
    await waitFor(() => document.querySelector('.app') && cards().length === 5, 'five seeded cards');

    await openCard(config.nameA, () => headerMuted().includes('ChatGPT Web'), 'asset A header (en)');
    const dateA = expectDate(config.createdAtA, 'en');
    const headerA = headerMuted();

    await openCard(config.nameB, () => promptText().includes('The web source did not expose'), 'asset B prompt (en)');
    const promptB = promptText();

    // Back to Chinese for the wrap measurement round.
    localStorage.setItem('gravityport.preferences', JSON.stringify({ appearance: '跟随系统', cardInfo: false, language: 'zh' }));

    return { headerA, dateA, promptB };
  })()
  `;
}

function wrapRoundSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
${PAGE_HELPERS}
    await waitFor(() => document.querySelector('.app') && cards().length === 5, 'five seeded cards');
    await openCard(config.nameA, () => headerMuted().includes('ChatGPT 网页版'), 'asset A header (wrap)');

    const details = document.querySelector('.details');
    const wideWidth = details.style.width;
    details.style.width = '150px';
    await sleep(250);
    const narrowRect = document.querySelector('.details .asset-meta > .muted').getBoundingClientRect();
    const lineHeight = Number.parseFloat(getComputedStyle(document.querySelector('.details .asset-meta > .muted')).lineHeight) || 16;
    details.style.width = wideWidth;
    await sleep(100);

    return { narrowHeight: narrowRect.height, narrowWidth: narrowRect.width, lineHeight,
      wrapLines: Math.max(1, Math.round(narrowRect.height / lineHeight)) };
  })()
  `;
}
