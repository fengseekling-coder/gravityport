// R21（Web 端）样式快照：用固定数据打开 Web UI，从 getComputedStyle /
// getBoundingClientRect 量出关键元素【实际生效】的尺寸、间距、字号、颜色，
// 与 test/fixtures/web-style-snapshot.json 基准逐项比对，一次列出全部差异。
//
// 为什么：读样式表源码的契约测试（test/web-r21-*.test.mjs）查不到浏览器里真正
// 生效的值——R21 期间同一个选择器在 styles.css 里出现多次，只有最后一组生效，
// 源码测试却只查了第一组。这里量的是级联后的最终值，兜住这类回归。
//
// 什么时候更新基准：只有当你【有意】改了 Web 样式、且新值就是要发布的设计决定
// 时。怎么更新：
//   npm run build
//   MOSA_STYLE_SNAPSHOT_UPDATE=1 MOSA_E2E_ONLY=web-style-snapshot node scripts/e2e-critical-flows.mjs
// 更新后必须在 PR 说明里列出所有变化的键（看基准文件的 git diff 即可），并给出
// 改动理由；没改样式基准却变了，一律按回归排查，不许更新基准了事。
//
// 稳定性：渲染窗口 1280×800（scripts/e2e-web-driver.mjs 固定），浅色主题、默认
// 设置、中文界面。只量与滚动位置、动画中间态、当前时间无关的值；量之前等
// document.fonts.ready、图片解码完、目标几何连续两次采样一致。像素值四舍五入
// 到 0.5px 存基准；颜色归一成 hex；字号不加舍入、要求完全相等。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "web-style-snapshot";
export const description = "R21 样式快照：量实际生效样式并与 test/fixtures/web-style-snapshot.json 比对（MOSA_STYLE_SNAPSHOT_UPDATE=1 重录基准）";

const BASELINE_PATH = join("test", "fixtures", "web-style-snapshot.json");
const UPDATE_ENV = "MOSA_STYLE_SNAPSHOT_UPDATE";
const PX_TOLERANCE = 0.5;

// 每个键的比对方式：px（几何值，容差 0.5px）/ font（字号、字重，完全相等）/
// color（颜色，完全相等，归一成 hex）。键名即页面源码里写入 R 的键名。
const KEY_KINDS = {
  // 外壳
  "shell.topbarHeight": "px",
  "shell.sidebarWidth": "px",
  "shell.baseFontSize": "font",
  "shell.bodyColor": "color",
  "shell.bodyBackground": "color",
  "shell.navItemColor": "color",
  "shell.navItemHeight": "px",
  "shell.navItemRadius": "px",
  "shell.navItemActiveColor": "color",
  "shell.navItemActiveBackground": "color",
  // 任务 50：浅色 tertiary 加深后锁侧栏计数与分组标题的实际字色。
  "shell.navCountColor": "color",
  "shell.navLabelColor": "color",
  // 顶栏控件
  // 任务 70（GravityPort A3）：类型筛选从顶栏移除，原 topbar.typeFilter* 六键
  // 删除；新增后退/前进按钮与缩略图大小滑杆键。
  "topbar.navHistoryButtonWidth": "px",
  "topbar.navHistoryButtonHeight": "px",
  "topbar.navHistoryButtonRadius": "px",
  "topbar.navHistoryButtonBackground": "color",
  "topbar.sizeGroupWindowCenterOffset": "px",
  "topbar.sizeGroupInlineLeft": "px",
  "topbar.sizeSliderWidth": "px",
  "topbar.sizeSliderAccentColor": "color",
  "topbar.sortSelectHeight": "px",
  "topbar.sortSelectRadius": "px",
  "topbar.sortSelectBackground": "color",
  "topbar.categorySelectHeight": "px",
  "topbar.categorySelectRadius": "px",
  "topbar.categorySelectBackground": "color",
  "topbar.searchHeight": "px",
  "topbar.searchRadius": "px",
  "topbar.searchBackground": "color",
  "topbar.searchPlaceholderColor": "color",
  // 画廊与卡片
  "gallery.gridPaddingTop": "px",
  "gallery.gridPaddingLeft": "px",
  "gallery.gridPaddingRight": "px",
  "gallery.gridPaddingBottom": "px",
  "gallery.gridColumnGap": "px",
  "gallery.gridColumnCount": "font",
  "gallery.cardGapX": "px",
  "gallery.thumbRadius": "px",
  "gallery.thumbBackground": "color",
  "gallery.selectionRingWidth": "px",
  "gallery.selectionRingColor": "color",
  "gallery.selectionRingRadius": "px",
  "gallery.cardInfoTitleFontSize": "font",
  "gallery.cardInfoTitleColor": "color",
  "gallery.cardInfoMetaFontSize": "font",
  "gallery.cardInfoMetaColor": "color",
  "gallery.cardInfoPaddingTop": "px",
  "gallery.cardInfoPaddingBottom": "px",
  "gallery.cardInfoPaddingLeft": "px",
  "gallery.cardInfoPaddingRight": "px",
  // 检视器
  "inspector.width": "px",
  "inspector.headerHeight": "px",
  "inspector.titleFontSize": "font",
  "inspector.titleFontWeight": "font",
  "inspector.titleColor": "color",
  "inspector.miniWidth": "px",
  "inspector.miniAspectRatio": "str",
  "inspector.miniRadius": "px",
  "inspector.factKeyFontSize": "font",
  "inspector.factKeyColor": "color",
  "inspector.factValFontSize": "font",
  "inspector.factValColor": "color",
  // 任务 109（对比度）：「添加标签」与底部素材路径的实际字色（浅色）。
  "inspector.tagsAddColor": "color",
  "inspector.pathColor": "color",
  // 任务 75：版本树与上下文的行（无对话单行态）。行 40 高、40×40 缩略图、
  // 模型行 10px/13px——对话三行小字用的行距是同一个值。
  "inspector.versionContextRowHeight": "px",
  "inspector.versionContextRowRadius": "px",
  "inspector.versionContextThumbSize": "px",
  "inspector.versionContextModelFontSize": "font",
  "inspector.versionContextModelLineHeight": "px",
  // 任务 110：头部文件名行（宽度 / 单行高）、小节标题字号字重、空提示词框与
  // 空参考图框高度、路径胶囊高度与标签字号。
  "inspector.nameRowWidth": "px",
  "inspector.nameTitleHeight": "px",
  "inspector.sectionTitleFontSize": "font",
  "inspector.sectionTitleFontWeight": "font",
  "inspector.promptBoxEmptyHeight": "px",
  "inspector.referenceEmptyHeight": "px",
  "inspector.pathbarPillHeight": "px",
  "inspector.pathbarLabelFontSize": "font",
  // 任务 90（GravityPort A4c）：大图查看页按钮/箭头/图片区几何 + toast 避让检视器的
  // 位置（检视器打开 = 检视器宽 + 20，关闭 = 20；底部恒 20）。
  "viewer.headerHeight": "px",
  "viewer.actionButtonHeight": "px",
  "viewer.actionButtonRadius": "px",
  "viewer.actionButtonGap": "px",
  "viewer.actionsRightInset": "px",
  "viewer.arrowButtonSide": "px",
  "viewer.arrowRightInset": "px",
  "viewer.arrowIconHeight": "px",
  "viewer.imageWidth": "px",
  "viewer.imageHeight": "px",
  "viewer.imageCenterOffsetX": "px",
  "viewer.imageCenterOffsetY": "px",
  "viewer.stagePaddingTop": "px",
  // 任务 96（A6）：舞台左右各让出 52px 翻页箭头栏（44 按钮 + 8 距缘）。
  "viewer.stagePaddingX": "px",
  "toast.stackRightInsetOpen": "px",
  "toast.stackRightInsetClosed": "px",
  "toast.stackBottomInset": "px",
  // 任务 96（A6）：toast 药丸几何（稿子「弹窗提示」120×36、r=半高、图标 12、
  // 距左缘 16、字 16px 由字符步进折算）。
  "toast.pillHeight": "px",
  "toast.pillRadius": "px",
  "toast.font": "font",
  "toast.iconSide": "px",
  "toast.iconInset": "px",
  // 设置弹窗（任务 121：固定 720×464——cardHeight 是「常规与外观」页的高度，
  // aboutCardHeight 是「关于」页的，两页相同证明切分页时弹窗不再变矮）。
  "settings.cardWidth": "px",
  "settings.cardMaxHeight": "px",
  "settings.cardHeight": "px",
  "settings.aboutCardHeight": "px",
  "settings.minPageCardHeight": "px",
  "settings.maxPageCardHeight": "px",
  "settings.maxBodyOverflow": "px",
  "settings.cardRadius": "px",
  "settings.sidebarWidth": "px",
  "settings.navTabHeight": "px",
  "settings.navTabColor": "color",
  "settings.navTabActiveBackground": "color",
  "settings.navTabActiveColor": "color",
  // 任务 91（GravityPort A4d）：右键菜单几何。任务 109（规范表 v1）：
  // 宽 200、行高 26、图标 16；内边距 8、组内行距 2、组间距 12 不变。
  "menu.width": "px",
  "menu.radius": "px",
  "menu.padding": "px",
  "menu.itemHeight": "px",
  "menu.itemRadius": "px",
  "menu.itemGap": "px",
  "menu.groupGap": "px",
  "menu.iconSize": "px",
  "menu.iconInset": "px",
  // 任务 94（GravityPort A4f）：确认弹窗。任务 109（规范表 v1）：卡 420 宽、
  // 高度随内容（cardMinHeight="auto" 证明 240 下限已删）、标题 15/600、按钮 28 高。
  "confirmDialog.cardWidth": "px",
  "confirmDialog.cardMinHeight": "str",
  "confirmDialog.cardHeight": "px",
  "confirmDialog.cardRadius": "px",
  "confirmDialog.titleFontSize": "font",
  "confirmDialog.titleFontWeight": "font",
  "confirmDialog.titleLineSpacing": "px",
  "confirmDialog.buttonWidth": "px",
  "confirmDialog.buttonHeight": "px",
  "confirmDialog.buttonRadius": "px",
  "confirmDialog.buttonGap": "px",
  "confirmDialog.checkboxSize": "px",
  "confirmDialog.checkboxRadius": "px",
  "confirmDialog.dontAskVisible": "str",
  "confirmDialog.dontAskFontSize": "font",
  // 深色主题（R21 没有深色规格：只守关键颜色没被浅色规则串进去）
  "dark.bodyBackground": "color",
  "dark.bodyColor": "color",
  "dark.navItemActiveBackground": "color",
  "dark.navLabelColor": "color",
  "dark.thumbBackground": "color",
  "dark.selectionRingColor": "color",
  // 任务 109（对比度）：侧栏计数、「添加标签」、素材路径在深色下的实际字色。
  "dark.navCountColor": "color",
  "dark.tagsAddColor": "color",
  "dark.pathColor": "color",
};

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  let readings;
  try {
    // 任务 100：按页面尺寸要窗口（useContentSize）。默认 1280×800 量的是外框：
    // macOS 页面是 1280×772（基准就是这么录的），Windows 减去边框只剩 1264 宽，
    // 窗口中线差 8px，滑杆组 left 就对不上基准。
    const seeded = await seedAssets(ctx, server.origin);
    readings = await ctx.runInPage(server, measurementSource({ plainAssetId: seeded.ids[0], emptyAssetId: seeded.emptyAssetId }), { windowSize: [1280, 772] });
  } finally {
    await server.stop();
  }

  const missingReadings = Object.keys(KEY_KINDS).filter((key) => readings?.[key] === undefined);
  if (missingReadings.length) {
    throw new Error(`页面没有量到 ${missingReadings.length} 个键（选择器断了或步骤没走完）：${missingReadings.join(", ")}`);
  }
  const measured = normalize(readings);
  const baselinePath = join(ctx.rootDir, BASELINE_PATH);

  if (process.env[UPDATE_ENV] === "1") {
    await mkdir(dirname(baselinePath), { recursive: true });
    const payload = `${JSON.stringify(measured, null, 2)}\n`;
    await writeFile(baselinePath, payload, "utf8");
    const reread = await readFile(baselinePath, "utf8");
    if (reread !== payload) throw new Error("基准写回后读不一致，请检查文件系统。");
    return { updated: true, keys: Object.keys(measured).length, path: BASELINE_PATH };
  }

  let baseline;
  try {
    baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  } catch {
    throw new Error(`样式基准不存在或不可解析：${BASELINE_PATH}\n首次生成：${UPDATE_ENV}=1 MOSA_E2E_ONLY=${name} node scripts/e2e-critical-flows.mjs`);
  }
  const problems = compareWithBaseline(measured, baseline);
  if (problems.length) {
    throw new Error(`样式快照与基准不一致，共 ${problems.length} 处：\n${problems.join("\n")}\n（若是你有意改的样式：${UPDATE_ENV}=1 MOSA_E2E_ONLY=${name} node scripts/e2e-critical-flows.mjs 重录基准，并在 PR 里列出变化的键）`);
  }
  return { compared: Object.keys(measured).length, path: BASELINE_PATH };
}

// ===== 预置数据：5 张不同尺寸的图（第 3 张进分组、后两张堆叠成 1 张卡）=====
async function seedAssets(ctx, origin) {
  const seeds = [
    ["snap-a.png", [96, 64], [74, 127, 181], "snapshot alpha"],
    ["snap-b.png", [64, 96], [181, 68, 74], "snapshot bravo"],
    ["snap-c.png", [80, 80], [58, 138, 87], "snapshot charlie"],
    ["snap-d.png", [120, 60], [138, 90, 47], "snapshot delta"],
    ["snap-e.png", [72, 72], [96, 74, 155], "snapshot echo"],
    // 任务 110：一张没有 prompt 的素材，供「空提示词框高度」测量（框随内容收缩）。
    ["snap-empty.png", [64, 64], [128, 128, 128], null],
  ];
  const ids = [];
  for (const [index, [file, [width, height], color, prompt]] of seeds.entries()) {
    const imagePath = await ctx.makePng(file, color, { width, height });
    const body = await ctx.api(origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath,
      ...(prompt ? { prompt } : {}),
      ...(index === 2 ? { group: "样式快照分组" } : {}),
    });
    if (!body?.asset?.id) throw new Error(`样式快照预置图失败：${file}`);
    ids.push(body.asset.id);
  }
  const stack = await ctx.api(origin, "POST", "/api/asset-stacks", {
    projectId: "default",
    assetIds: [ids[3], ids[4]],
    coverAssetId: ids[3],
  });
  if (!stack?.stack?.id) throw new Error("样式快照预置堆叠失败。");
  // 任务 75：给首图一条无对话的生成记录，让「版本树与上下文」盒渲染出
  // 单行（无对话态），行的几何与字号才量得到。
  const generation = await ctx.api(origin, "POST", "/api/generations", {
    output_asset_id: ids[0],
    provider: "style-snapshot",
    model: "snapshot-model",
    effective_prompt: "样式快照生成记录",
    created_at: new Date().toISOString(),
  });
  if (!generation?.event?.id) throw new Error("样式快照生成记录写入失败。");
  return { ids, emptyAssetId: ids[5] };
}

// ===== 比对 =====
function compareWithBaseline(measured, baseline) {
  if (typeof baseline !== "object" || baseline === null || Array.isArray(baseline)) {
    return [`基准文件格式不对：${BASELINE_PATH} 必须是扁平的 { 键: 值 } JSON。`];
  }
  const problems = [];
  for (const [key, actual] of Object.entries(measured)) {
    if (!(key in baseline)) {
      problems.push(`  ${key}: 基准里没有这个键（新增的测量项，需要重录基准）`);
      continue;
    }
    const expected = baseline[key];
    const equal = KEY_KINDS[key] === "px"
      ? Math.abs(actual - expected) <= PX_TOLERANCE + 1e-9
      : actual === expected;
    if (!equal) problems.push(`  ${key}: 基准 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)}`);
  }
  for (const key of Object.keys(baseline)) {
    if (!(key in measured)) problems.push(`  ${key}: 基准里有但这次没量到（测量项被删了？重录基准）`);
  }
  return problems;
}

function normalize(readings) {
  const roundHalf = (value) => Math.round(value * 2) / 2;
  const normalized = {};
  for (const [key, kind] of Object.entries(KEY_KINDS)) {
    const raw = String(readings[key]);
    if (kind === "color") {
      normalized[key] = normalizeColor(raw);
      continue;
    }
    if (kind === "str") {
      normalized[key] = raw.trim();
      continue;
    }
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value)) throw new Error(`键 ${key} 量到非数值：${raw}`);
    normalized[key] = kind === "px" ? roundHalf(value) : value;
  }
  return Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b)));
}

function normalizeColor(value) {
  const match = /^rgba?\((\d+(?:\.\d+)?), (\d+(?:\.\d+)?), (\d+(?:\.\d+)?)(?:, (\d+(?:\.\d+)?))?\)$/.exec(value.trim());
  if (!match) return value.trim();
  const [r, g, b] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  if (alpha !== 1) return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  const hex = (n) => n.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// ===== 页面内测量源码 =====
function measurementSource({ plainAssetId, emptyAssetId }) {
  return `(async () => {
    const seed = { plainAssetId: ${JSON.stringify(plainAssetId)}, emptyAssetId: ${JSON.stringify(emptyAssetId)} };
    ${PAGE_HELPERS}
    const R = {};
    const pick = (selector) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error('missing element ' + selector + ' diagnostic=' + JSON.stringify(pageDiagnostic()));
      return el;
    };
    const rectOf = (el) => el.getBoundingClientRect();
    const styleOf = (el, pseudo) => getComputedStyle(el, pseudo || null);

    // 两次采样一致才算稳：吃掉瀑布流重排、主题过渡。
    async function waitStable(sample, label, attempts = 40) {
      let prev = JSON.stringify(sample());
      for (let i = 0; i < attempts; i += 1) {
        await sleep(150);
        const next = JSON.stringify(sample());
        if (next === prev) return;
        prev = next;
      }
      throw new Error('never settled: ' + label + ' last=' + prev.slice(0, 200));
    }

    // 等入场动画真正结束（transform 回到恒等、子树没有在跑的动画）。
    // 只靠「两次采样相同」会被繁忙渲染器骗过：动画启动被推迟时，两个采样
    // 都落在起始值上，量到的就是 scale(.985) 这样的中间态。设置弹窗实测
    // 出现过一次，所以几何测量前必须先过这里。
    async function waitForMotionSettled(el, label) {
      await waitFor(() => {
        const transform = getComputedStyle(el).transform;
        return transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)';
      }, 'transform settles (' + label + ')');
      if (typeof el.getAnimations === 'function') {
        await Promise.race([
          Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {}))),
          sleep(3000),
        ]);
      }
    }

    async function waitGallerySettled(minCards) {
      await waitFor(() => gallerySettled() && rootCardIds().length >= minCards, minCards + ' seeded cards settled');
      await document.fonts.ready;
      await Promise.all([...document.images].map((img) => img.decode().catch(() => {})));
      await waitFor(
        () => [...document.querySelectorAll('#assetGrid .thumb img')].every((img) => img.complete && img.naturalWidth > 0),
        'thumbnails decoded',
      );
      await waitStable(() => [...document.querySelectorAll('#assetGrid > .asset-card')].map((card) => {
        const r = rectOf(card);
        return [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 2));
      }), 'card layout');
      await waitForMotionSettled(pick('#assetGrid'), 'gallery');
    }

    // 第一行相邻卡片左边缘差 = 实际生效的列间距（行内所有间隙必须一致）。
    function firstRowGapX() {
      const cards = [...document.querySelectorAll('#assetGrid > .asset-card')]
        .filter((card) => card.querySelector('.asset-card-select'));
      const rects = cards.map((card) => rectOf(card)).sort((a, b) => a.top - b.top || a.left - b.left);
      const topRow = rects.filter((r) => r.top < rects[0].bottom - 1).sort((a, b) => a.left - b.left);
      const gaps = [];
      for (let i = 1; i < topRow.length; i += 1) gaps.push(topRow[i].left - topRow[i - 1].right);
      if (!gaps.length) throw new Error('no same-row card pair to measure the column gap');
      for (const other of gaps) {
        if (Math.abs(other - gaps[0]) > 0.5) throw new Error('uneven column gaps: ' + JSON.stringify(gaps));
      }
      return gaps[0];
    }

    const settingsMenu = () => pick('#settingsMenu');
    const openSettings = async (label) => {
      click('#settingsToggle');
      await waitFor(() => !settingsMenu().hidden, 'settings opens (' + label + ')');
    };
    const closeSettings = async (label) => {
      click('#settingsMenu [data-settings-close]');
      await waitFor(() => settingsMenu().hidden, 'settings closes (' + label + ')');
    };

    // ---- 1) 浅色基础：外壳 / 顶栏 / 画廊（卡片信息默认关）----
    // 任务 81 返工 1：新用户默认「跟随系统」，快照的浅色基线必须显式钉死，
    // 否则在系统深色的机器上整套浅色键会量成深色值。
    if (document.documentElement.dataset.theme !== 'light') {
      click('#settingsToggle');
      await waitFor(() => !settingsMenu().hidden, 'settings opens for the light baseline');
      click('#settingsMenu [data-appearance-opt="light"]');
      await waitFor(() => document.documentElement.dataset.theme === 'light', 'light baseline normalised');
      closeSettings('light baseline');
    }
    await waitGallerySettled(4);
    R['shell.topbarHeight'] = rectOf(pick('.mosa-v2 .topbar')).height;
    R['shell.sidebarWidth'] = rectOf(pick('#appSidebar')).width;
    const bodyStyle = styleOf(document.body);
    R['shell.baseFontSize'] = bodyStyle.fontSize;
    R['shell.bodyColor'] = bodyStyle.color;
    R['shell.bodyBackground'] = bodyStyle.backgroundColor;
    const navNormal = styleOf(pick('#quickFilters .nav-item[data-filter="favorite"]'));
    R['shell.navItemColor'] = navNormal.color;
    R['shell.navItemHeight'] = rectOf(pick('#quickFilters .nav-item[data-filter="favorite"]')).height;
    R['shell.navItemRadius'] = navNormal.borderTopLeftRadius;
    const navActive = styleOf(pick('#quickFilters .nav-item[data-filter="all"]'));
    R['shell.navItemActiveColor'] = navActive.color;
    R['shell.navItemActiveBackground'] = navActive.backgroundColor;
    R['shell.navCountColor'] = styleOf(pick('#quickFilters .nav-item[data-filter="favorite"] .nav-count')).color;
    R['shell.navLabelColor'] = styleOf(pick('.mosa-v2 .nav-label')).color;

    // 任务 70 返工 1（GravityPort A3，用户 10-06 拍板）：后退/前进按钮 + 缩略图
    // 大小滑杆三态（居中 = 窗口中线 / 退让居中 / 隐藏）。实测：1280 关检视器 →
    // 居中（行内 left = 640-280 = 360，窗口中线在顶栏坐标系的位置，与控件宽度
    // 无关）；1440 关检视器 → 居中（left = 720-280 = 440，窗口中心偏差 0）。
    // 先关检视器锁这两态，再借驱动只把窗口临时放大到 1440 量滑杆真实几何，
    // 量完还原 1280（回到窗口居中）。
    const navHistoryButton = pick('#navHistoryBack');
    const navHistoryStyle = styleOf(navHistoryButton);
    R['topbar.navHistoryButtonWidth'] = rectOf(navHistoryButton).width;
    R['topbar.navHistoryButtonHeight'] = rectOf(navHistoryButton).height;
    R['topbar.navHistoryButtonRadius'] = navHistoryStyle.borderTopLeftRadius;
    R['topbar.navHistoryButtonBackground'] = navHistoryStyle.backgroundColor;
    const detailCloseForSlider = pick('#detailPanel .detail-close');
    if (pick('#detailPanel').getAttribute('aria-hidden') === 'false') detailCloseForSlider.click();
    await waitFor(() => pick('#detailPanel').getAttribute('aria-hidden') === 'true', 'inspector closed for slider keys');
    // 居中态的行内 left 必须等于「窗口中线 − 顶栏左缘」（barRect.left）。
    const windowCenterInBar = () => window.innerWidth / 2 - rectOf(pick('.mosa-v2 .topbar')).left;
    await waitFor(() => pick('#topbarSizeGroup').hidden === false
      && Math.abs(Number.parseFloat(pick('#topbarSizeGroup').style.left || 'NaN') - windowCenterInBar()) <= 0.75, 'size group window-centered (inline left) at 1280');
    R['topbar.sizeGroupInlineLeft'] = Number.parseFloat(pick('#topbarSizeGroup').style.left);
    console.log('__MOSA_E2E_RESIZE__ 1440x800');
    await waitFor(() => window.innerWidth >= 1440, 'window resized to 1440');
    await waitFor(() => !pick('#topbarSizeGroup').hidden
      && Math.abs(Number.parseFloat(pick('#topbarSizeGroup').style.left || 'NaN') - windowCenterInBar()) <= 0.75, 'size group window-centered at 1440');
    const topbarRect = rectOf(pick('.mosa-v2 .topbar'));
    const sizeGroupRect = rectOf(pick('#topbarSizeGroup'));
    R['topbar.sizeGroupWindowCenterOffset'] = Math.abs((sizeGroupRect.left + sizeGroupRect.width / 2) - (topbarRect.left + windowCenterInBar()));
    const sizeSlider = pick('#gallerySizeSlider');
    R['topbar.sizeSliderWidth'] = rectOf(sizeSlider).width;
    R['topbar.sizeSliderAccentColor'] = styleOf(sizeSlider).accentColor;
    console.log('__MOSA_E2E_RESIZE__ 1280x800');
    await waitFor(() => window.innerWidth <= 1280 && pick('#topbarSizeGroup').hidden === false
      && Math.abs(Number.parseFloat(pick('#topbarSizeGroup').style.left || 'NaN') - windowCenterInBar()) <= 0.75, 'window restored; the size group window-centers again at 1280');
    // 手动关闭置了 detailManuallyClosed：后续「点卡片自动开检视器」的步骤要求
    // 非手动关闭态——用真实入口（#openInspectorBtn）重新打开把它清掉。
    click('#openInspectorBtn');
    await waitFor(() => pick('#detailPanel').getAttribute('aria-hidden') === 'false', 'inspector reopened after slider keys');

    const sortSelect = pick('#sortSelect');
    const sortStyle = styleOf(sortSelect);
    R['topbar.sortSelectHeight'] = rectOf(sortSelect).height;
    R['topbar.sortSelectRadius'] = sortStyle.borderTopLeftRadius;
    R['topbar.sortSelectBackground'] = sortStyle.backgroundColor;

    const searchBox = pick('.topbar-search');
    const searchStyle = styleOf(searchBox);
    R['topbar.searchHeight'] = rectOf(searchBox).height;
    R['topbar.searchRadius'] = searchStyle.borderTopLeftRadius;
    R['topbar.searchBackground'] = searchStyle.backgroundColor;
    R['topbar.searchPlaceholderColor'] = styleOf(pick('.topbar-search input'), '::placeholder').color;

    // 任务 34：分类下拉框（复用 .sort-control 链，锁定与排序框同款外观）。
    const categorySelect = pick('#categorySelect');
    const categoryStyle = styleOf(categorySelect);
    R['topbar.categorySelectHeight'] = rectOf(categorySelect).height;
    R['topbar.categorySelectRadius'] = categoryStyle.borderTopLeftRadius;
    R['topbar.categorySelectBackground'] = categoryStyle.backgroundColor;

    const gridStyle = styleOf(pick('#assetGrid'));
    R['gallery.gridPaddingTop'] = gridStyle.paddingTop;
    R['gallery.gridPaddingLeft'] = gridStyle.paddingLeft;
    R['gallery.gridPaddingRight'] = gridStyle.paddingRight;
    R['gallery.gridPaddingBottom'] = gridStyle.paddingBottom;
    R['gallery.gridColumnGap'] = gridStyle.columnGap;
    // 任务 70：列数由 --gallery-columns 驱动（1280 宽、检视器关、滑杆默认 200
    // → 内容宽 952 → 4 列）。
    R['gallery.gridColumnCount'] = gridStyle.gridTemplateColumns.split(/\\s+/).filter(Boolean).length;
    R['gallery.cardGapX'] = firstRowGapX();
    const thumb = pick('#assetGrid .thumb');
    const thumbStyle = styleOf(thumb);
    R['gallery.thumbRadius'] = thumbStyle.borderTopLeftRadius;
    R['gallery.thumbBackground'] = thumbStyle.backgroundColor;

    // ---- 2) 设置弹窗（两栏框架），顺手用真实入口打开卡片信息 ----
    await openSettings('first');
    await waitForMotionSettled(pick('.mosa-v2 .settings-modal-card'), 'settings modal');
    await waitStable(() => {
      const r = rectOf(pick('.mosa-v2 .settings-modal-card'));
      return [r.width, r.height].map((v) => Math.round(v * 2));
    }, 'settings modal');
    const settingsCard = pick('.mosa-v2 .settings-modal-card');
    R['settings.cardWidth'] = rectOf(settingsCard).width;
    R['settings.cardMaxHeight'] = styleOf(settingsCard).maxHeight;
    R['settings.cardHeight'] = rectOf(settingsCard).height;
    R['settings.cardRadius'] = styleOf(settingsCard).borderTopLeftRadius;
    R['settings.sidebarWidth'] = rectOf(pick('.mosa-v2 .settings-modal-sidebar')).width;
    const settingsTabNormal = pick('#settingsMenu [data-settings-page="library"]');
    R['settings.navTabHeight'] = rectOf(settingsTabNormal).height;
    R['settings.navTabColor'] = styleOf(settingsTabNormal).color;
    const settingsTabActive = styleOf(pick('#settingsMenu [data-settings-page="general"]'));
    R['settings.navTabActiveBackground'] = settingsTabActive.backgroundColor;
    R['settings.navTabActiveColor'] = settingsTabActive.color;
    // 任务 121：切到「关于」页再量卡片高度——和「常规与外观」页相同 = 弹窗
    // 高度固定，内容少的分页不变矮。
    click('#settingsMenu [data-settings-page="about"]');
    await waitFor(() => pick('#settingsMenu [data-settings-panel="about"]').hidden === false, 'about page shown for its card height');
    await waitStable(() => [Math.round(rectOf(settingsCard).height * 2)], 'settings modal about page');
    R['settings.aboutCardHeight'] = rectOf(settingsCard).height;
    // 任务 121：逐个分页量一遍——每页的卡片高度都一样（min = max），并且右侧内容区
    // 在默认状态下都放得下（溢出量 0），固定高度不会把哪一页挤出滚动条。
    const settingsPageHeights = [];
    let settingsBodyOverflow = 0;
    for (const tab of [...document.querySelectorAll('#settingsMenu [data-settings-page]')]) {
      const pageId = tab.dataset.settingsPage;
      tab.click();
      await waitFor(() => pick('#settingsMenu [data-settings-panel="' + pageId + '"]').hidden === false, 'settings page ' + pageId + ' shown');
      await waitStable(() => [Math.round(rectOf(settingsCard).height * 2)], 'settings modal ' + pageId + ' page');
      settingsPageHeights.push(rectOf(settingsCard).height);
      const body = pick('#settingsMenu .settings-modal-body');
      settingsBodyOverflow = Math.max(settingsBodyOverflow, body.scrollHeight - body.clientHeight);
    }
    R['settings.minPageCardHeight'] = Math.min(...settingsPageHeights);
    R['settings.maxPageCardHeight'] = Math.max(...settingsPageHeights);
    R['settings.maxBodyOverflow'] = settingsBodyOverflow;
    click('#settingsMenu [data-settings-page="general"]');
    await waitFor(() => pick('#settingsMenu [data-settings-panel="general"]').hidden === false, 'general page restored');
    click('#settingsMenu [data-card-info-opt="show"]');
    await waitFor(() => pick('#assetGrid').dataset.cardInfo === 'show', 'card info turns on');
    await closeSettings('after card info');

    // ---- 3) 卡片信息区字号 / 颜色 ----
    await waitGallerySettled(4);
    const cardInfo = pick('#assetGrid .asset-card-info');
    if (styleOf(cardInfo).display === 'none') throw new Error('card info is still display:none after enabling it');
    const infoStyle = styleOf(cardInfo);
    R['gallery.cardInfoPaddingTop'] = infoStyle.paddingTop;
    R['gallery.cardInfoPaddingBottom'] = infoStyle.paddingBottom;
    R['gallery.cardInfoPaddingLeft'] = infoStyle.paddingLeft;
    R['gallery.cardInfoPaddingRight'] = infoStyle.paddingRight;
    const infoTitle = styleOf(pick('#assetGrid .asset-card-title'));
    R['gallery.cardInfoTitleFontSize'] = infoTitle.fontSize;
    R['gallery.cardInfoTitleColor'] = infoTitle.color;
    const infoMeta = styleOf(pick('#assetGrid .asset-card-meta'));
    R['gallery.cardInfoMetaFontSize'] = infoMeta.fontSize;
    R['gallery.cardInfoMetaColor'] = infoMeta.color;

    // ---- 4) 检视器与选中框：点普通素材卡打开素材详情（堆叠卡开的是堆叠检视器，没有头部小图）----
    const detailCardButton = () => document.querySelector('.asset-card[data-id="' + CSS.escape(seed.plainAssetId) + '"] .asset-card-select');
    await waitFor(() => detailCardButton()?.isConnected, 'plain asset card button');
    detailCardButton().click();
    await waitFor(() => pick('#detailPanel').getAttribute('aria-hidden') === 'false' && document.querySelector('.asset-card.selected'), 'detail opens with the selected card');
    // 检视器内容是异步渲染的：等头部小图和事实行真的出现再量。
    await waitFor(() => pick('#detailPanel').querySelector('.asset-mini') && pick('#detailPanel').querySelector('.head-facts .meta-key'), 'inspector head renders');
    await waitForMotionSettled(pick('.detail-inspector'), 'inspector');
    await waitStable(() => [Math.round(rectOf(pick('#detailPanel')).width * 2)], 'inspector width');
    R['inspector.width'] = rectOf(pick('#detailPanel')).width;
    R['inspector.headerHeight'] = rectOf(pick('.detail-inspector-header')).height;
    const inspectorTitle = styleOf(pick('.detail-inspector-header > span'));
    R['inspector.titleFontSize'] = inspectorTitle.fontSize;
    R['inspector.titleFontWeight'] = inspectorTitle.fontWeight;
    R['inspector.titleColor'] = inspectorTitle.color;
    const mini = pick('#detailPanel .asset-mini');
    const miniStyle = styleOf(mini);
    // 宽度用计算值：132 是内容盒设计值（1px 边框不占其中，矩形外沿 134），
    // 记计算值才和 R21 的「132 小图」对得上；比例锁 1:1。
    R['inspector.miniWidth'] = miniStyle.width;
    R['inspector.miniAspectRatio'] = miniStyle.aspectRatio;
    R['inspector.miniRadius'] = miniStyle.borderTopLeftRadius;
    const factKey = styleOf(pick('#detailPanel .head-facts .meta-key'));
    R['inspector.factKeyFontSize'] = factKey.fontSize;
    R['inspector.factKeyColor'] = factKey.color;
    const factVal = styleOf(pick('#detailPanel .head-facts .meta-val'));
    R['inspector.factValFontSize'] = factVal.fontSize;
    R['inspector.factValColor'] = factVal.color;
    // 任务 109（对比度）：「添加标签」与底部素材路径的实际字色（浅色）。
    await waitFor(() => pick('#detailPanel').querySelector('.detail-tags-add') && pick('#detailPanel').querySelector('.detail-pathbar-path'), 'tags row and pathbar render');
    R['inspector.tagsAddColor'] = styleOf(pick('#detailPanel .detail-tags-add')).color;
    R['inspector.pathColor'] = styleOf(pick('#detailPanel .detail-pathbar-path')).color;
    // 任务 75：版本树与上下文的行——生成历史异步到达后再量（无对话单行态）。
    await waitFor(() => pick('#detailPanel').querySelector('[data-generation-context] .detail-version-context-row'), 'version context row renders');
    const versionRow = pick('#detailPanel [data-generation-context] .detail-version-context-row');
    R['inspector.versionContextRowHeight'] = rectOf(versionRow).height;
    R['inspector.versionContextRowRadius'] = styleOf(versionRow).borderTopLeftRadius;
    R['inspector.versionContextThumbSize'] = rectOf(versionRow.querySelector('.generation-output-thumb')).width;
    const versionModel = styleOf(versionRow.querySelector('.detail-version-context-model'));
    R['inspector.versionContextModelFontSize'] = versionModel.fontSize;
    R['inspector.versionContextModelLineHeight'] = versionModel.lineHeight;
    // 任务 110：头部文件名行（单行宽高——太长时中间省略）、小节标题字号字重、
    // 空参考图框（种子素材无参考图）、路径胶囊高度与标签字号。
    const nameRow = pick('#detailPanel .asset-name-row');
    R['inspector.nameRowWidth'] = rectOf(nameRow).width;
    R['inspector.nameTitleHeight'] = rectOf(nameRow.querySelector('#detailTitle')).height;
    const sectionTitleStyle = styleOf(pick('#detailPanel .detail-prompt-head h3'));
    R['inspector.sectionTitleFontSize'] = sectionTitleStyle.fontSize;
    R['inspector.sectionTitleFontWeight'] = sectionTitleStyle.fontWeight;
    R['inspector.referenceEmptyHeight'] = rectOf(pick('#detailPanel .detail-reference-box')).height;
    R['inspector.pathbarPillHeight'] = rectOf(pick('#detailPanel .detail-pathbar-pill')).height;
    R['inspector.pathbarLabelFontSize'] = styleOf(pick('#detailPanel .detail-pathbar-label')).fontSize;
    // 任务 110：空提示词框——切到没有 prompt 的种子素材量框随内容收缩，量完留在
    // 该素材上；后面的查看页/确认框入口都用右键重新定位目标卡，不受影响。
    const emptyCardButton = () => document.querySelector('.asset-card[data-id="' + CSS.escape(seed.emptyAssetId) + '"] .asset-card-select');
    await waitFor(() => emptyCardButton()?.isConnected, 'empty-prompt card button');
    emptyCardButton().click();
    await waitFor(() => pick('#detailPanel').querySelector('.detail-prompt-box'), 'empty-prompt inspector renders');
    await waitForMotionSettled(pick('.detail-inspector'), 'inspector (empty prompt)');
    R['inspector.promptBoxEmptyHeight'] = rectOf(pick('#detailPanel .detail-prompt-box')).height;
    const selectedCard = pick('.asset-card.selected');
    const ring = styleOf(selectedCard, '::after');
    R['gallery.selectionRingWidth'] = ring.borderWidth;
    R['gallery.selectionRingColor'] = ring.borderColor;
    R['gallery.selectionRingRadius'] = ring.borderTopLeftRadius;

    // ---- 4b) 大图查看页（任务 90，GravityPort A4c）：按钮 / 箭头 / 图片区 + toast 位置 ----
    // 经真实入口（右键菜单「在查看器中打开」）进入；量完返回画廊并手动关检视器，
    // 再量 toast 栈的关闭态右边距。
    const viewerOpenItem = await openContextMenu(cardSelector(seed.plainAssetId), '在查看器中打开');
    // 任务 91：菜单开着时量右键菜单几何（单张菜单：打开×2｜复制×4｜收藏+分组×2｜
    // 导出｜回收站——items[1]→[2] 跨过分隔，正是组间距）。
    const contextMenuEl = pick('.context-menu');
    const contextMenuItems = [...contextMenuEl.querySelectorAll(':scope > .context-menu-item')];
    R['menu.width'] = rectOf(contextMenuEl).width;
    R['menu.radius'] = styleOf(contextMenuEl).borderTopLeftRadius;
    R['menu.padding'] = styleOf(contextMenuEl).paddingTop;
    R['menu.itemHeight'] = rectOf(contextMenuItems[0]).height;
    R['menu.itemRadius'] = styleOf(contextMenuItems[0]).borderTopLeftRadius;
    R['menu.itemGap'] = rectOf(contextMenuItems[1]).top - rectOf(contextMenuItems[0]).bottom;
    R['menu.groupGap'] = rectOf(contextMenuItems[2]).top - rectOf(contextMenuItems[1]).bottom;
    R['menu.iconSize'] = rectOf(contextMenuItems[0].querySelector('.context-menu-icon')).width;
    R['menu.iconInset'] = rectOf(contextMenuItems[0].querySelector('.context-menu-icon')).left - rectOf(contextMenuItems[0]).left;
    viewerOpenItem.click();
    await waitFor(() => !pick('#assetView').hidden, 'asset view opens for snapshot');
    const viewerImage = pick('#assetViewImage');
    await waitFor(() => !viewerImage.hidden && viewerImage.complete && viewerImage.naturalWidth > 0, 'viewer image loaded');
    await waitForMotionSettled(viewerImage, 'viewer image');
    await waitStable(() => {
      const r = rectOf(viewerImage);
      return [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 2));
    }, 'viewer image geometry');
    const viewerHeader = pick('#assetView .asset-view-header');
    const viewerStage = pick('#assetViewStage');
    const stageRect = rectOf(viewerStage);
    const viewerImageRect = rectOf(viewerImage);
    R['viewer.headerHeight'] = rectOf(viewerHeader).height;
    const deleteButton = pick('#assetViewDelete');
    const fullscreenButton = pick('#assetViewFullscreen');
    R['viewer.actionButtonHeight'] = rectOf(deleteButton).height;
    R['viewer.actionButtonRadius'] = styleOf(deleteButton).borderTopLeftRadius;
    R['viewer.actionButtonGap'] = rectOf(fullscreenButton).left - rectOf(pick('#assetZoomFit')).right;
    R['viewer.actionsRightInset'] = rectOf(viewerHeader).right - rectOf(fullscreenButton).right;
    const arrowNext = pick('#assetViewNext');
    R['viewer.arrowButtonSide'] = rectOf(arrowNext).width;
    R['viewer.arrowRightInset'] = stageRect.right - rectOf(arrowNext).right;
    R['viewer.arrowIconHeight'] = rectOf(arrowNext.querySelector('svg')).height;
    R['viewer.imageWidth'] = viewerImageRect.width;
    R['viewer.imageHeight'] = viewerImageRect.height;
    R['viewer.imageCenterOffsetX'] = Math.abs((viewerImageRect.left + viewerImageRect.width / 2) - (stageRect.left + stageRect.width / 2));
    R['viewer.imageCenterOffsetY'] = Math.abs((viewerImageRect.top + viewerImageRect.height / 2) - (stageRect.top + stageRect.height / 2));
    R['viewer.stagePaddingTop'] = styleOf(viewerStage).paddingTop;
    R['viewer.stagePaddingX'] = styleOf(viewerStage).paddingLeft;
    // 检视器开着：toast 栈右边距 = 检视器宽 + 20；底边距恒 20。
    const toastStack = pick('#toastContainer');
    await waitStable(() => [Math.round(rectOf(toastStack).right * 2)], 'toast stack right (inspector open)');
    R['toast.stackRightInsetOpen'] = window.innerWidth - rectOf(toastStack).right;
    R['toast.stackBottomInset'] = window.innerHeight - rectOf(toastStack).bottom;
    click('#assetViewBack');
    await waitFor(() => pick('#assetView').hidden === true, 'asset view closed after snapshot');
    click('#detailPanel .detail-close');
    await waitFor(() => pick('#detailPanel').getAttribute('aria-hidden') === 'true', 'inspector closed for toast closed-state key');
    await waitStable(() => [Math.round(rectOf(toastStack).right * 2)], 'toast stack right (closed)');
    R['toast.stackRightInsetClosed'] = window.innerWidth - rectOf(toastStack).right;

    // ---- 4c) 确认弹窗（任务 94 / A4f）：经真实入口（右键 → 移到回收站）打开后
    // 量稿子几何；点「否」取消——绝不点「是」（不写「不再提醒」存储、不动画廊）。
    const trashMenuItem = await openContextMenu(cardSelector(seed.plainAssetId), '移到回收站');
    trashMenuItem.click();
    await waitFor(() => pick('#confirmDialog').classList.contains('open'), 'confirm dialog opens for snapshot');
    await waitForMotionSettled(pick('#confirmDialogCard'), 'confirm dialog');
    await waitStable(() => {
      const r = rectOf(pick('#confirmDialogCard'));
      return [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 2));
    }, 'confirm dialog geometry');
    const dialogCard = pick('#confirmDialogCard');
    const dialogRect = rectOf(dialogCard);
    R['confirmDialog.cardWidth'] = dialogRect.width;
    R['confirmDialog.cardMinHeight'] = styleOf(dialogCard).minHeight;
    R['confirmDialog.cardHeight'] = dialogRect.height;
    R['confirmDialog.cardRadius'] = styleOf(dialogCard).borderTopLeftRadius;
    const dialogTitleStyle = styleOf(pick('#confirmDialogTitle'));
    R['confirmDialog.titleFontSize'] = dialogTitleStyle.fontSize;
    R['confirmDialog.titleFontWeight'] = dialogTitleStyle.fontWeight;
    R['confirmDialog.titleLineSpacing'] = rectOf(pick('#confirmDialogDescription')).top - rectOf(pick('#confirmDialogTitle')).top;
    const dialogConfirmButton = pick('#confirmDialogConfirm');
    const dialogCancelButton = pick('#confirmDialogCancel');
    R['confirmDialog.buttonWidth'] = rectOf(dialogConfirmButton).width;
    R['confirmDialog.buttonHeight'] = rectOf(dialogConfirmButton).height;
    R['confirmDialog.buttonRadius'] = styleOf(dialogConfirmButton).borderTopLeftRadius;
    R['confirmDialog.buttonGap'] = rectOf(dialogConfirmButton).left - rectOf(dialogCancelButton).right;
    const dialogCheckbox = pick('#confirmDialogDontAskCheckbox');
    R['confirmDialog.checkboxSize'] = rectOf(dialogCheckbox).width;
    R['confirmDialog.checkboxRadius'] = styleOf(dialogCheckbox).borderTopLeftRadius;
    R['confirmDialog.dontAskVisible'] = pick('#confirmDialogDontAsk').hidden === false ? 'yes' : 'no';
    R['confirmDialog.dontAskFontSize'] = styleOf(pick('#confirmDialogDontAsk')).fontSize;
    click('#confirmDialogCancel');
    await waitFor(() => !pick('#confirmDialog').classList.contains('open'), 'confirm dialog cancelled after snapshot');
    // 右键把卡片从单选转成了多选、取消弹窗不会清它；按 Esc 清掉残留选区，再按
    // 第 4 步的同一入口恢复单选（深色段要量 .asset-card.selected 的选中环）。
    // 只恢复选中、不开检视器：4b 已手动关闭检视器（detailManuallyClosed），
    // 深色段也只依赖 .selected 存在。
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
    await waitFor(() => !document.querySelector('.asset-card.multi-selected'), 'leftover multi-selection cleared after the dialog');
    const selectButtonAfterDialog = () => document.querySelector('[data-id="' + CSS.escape(seed.plainAssetId) + '"] .asset-card-select');
    await waitFor(() => selectButtonAfterDialog()?.isConnected, 'card select button back after the dialog');
    selectButtonAfterDialog().click();
    await waitFor(() => document.querySelector('.asset-card.selected'), 'single selection restored after the dialog');

    // ---- 4d) toast 药丸（任务 96 / A6）：经真实入口（右键 → 复制提示词）触发一条
    // toast 后量药丸几何。剪贴板在合成点击下成功或失败都会弹 toast（success/error
    // 通道不同、图标不同），但药丸高度/圆角/字号/图标尺寸与左缘内距是类型无关的。
    // 量完等 toast 完全离场再进深色段，避免影响后续测量的栈高度变量。
    // 右键会把 .selected 转成多选（任务 94 同款残留）：4d 后按同一手法
    // Esc 清多选、重选恢复单选，深色段的选中环断言才保持原口径。
    const copyMenuItemForToast = await openContextMenu(cardSelector(seed.plainAssetId), '复制提示词');
    copyMenuItemForToast.click();
    await waitFor(() => Boolean(document.querySelector('#toastContainer .toast.is-visible, #toastErrorContainer .toast.is-visible')), 'a toast appears for the pill keys');
    const pillToast = document.querySelector('#toastContainer .toast.is-visible, #toastErrorContainer .toast.is-visible');
    const pillRect = rectOf(pillToast);
    R['toast.pillHeight'] = pillRect.height;
    R['toast.pillRadius'] = styleOf(pillToast).borderTopLeftRadius;
    R['toast.font'] = styleOf(pillToast.querySelector('.toast-message')).fontSize;
    const pillIcon = pillToast.querySelector('.toast-icon');
    R['toast.iconSide'] = rectOf(pillIcon).width;
    R['toast.iconInset'] = rectOf(pillIcon).left - pillRect.left;
    // error 通道带关闭按钮：点掉加速离场；polite 通道等自然超时。
    const pillDismiss = pillToast.querySelector('.toast-dismiss');
    if (pillDismiss) pillDismiss.click();
    await waitFor(() => !document.querySelector('#toastContainer .toast, #toastErrorContainer .toast'), 'toast fully left before the dark section', 10000);
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
    await waitFor(() => !document.querySelector('.asset-card.multi-selected'), 'multi-selection cleared after the pill toast');
    const selectButtonAfterPill = () => document.querySelector('[data-id="' + CSS.escape(seed.plainAssetId) + '"] .asset-card-select');
    await waitFor(() => selectButtonAfterPill()?.isConnected, 'card select button back after the pill toast');
    selectButtonAfterPill().click();
    await waitFor(() => document.querySelector('.asset-card.selected'), 'single selection restored after the pill toast');

    // ---- 5) 深色主题关键颜色（设置里的真实入口切换）----
    await openSettings('dark');
    click('#settingsMenu [data-appearance-opt="dark"]');
    await waitFor(() => document.documentElement.dataset.theme === 'dark', 'dark theme applied');
    await closeSettings('after dark');
    await waitStable(() => [
      styleOf(document.body).backgroundColor,
      styleOf(document.body).color,
      styleOf(pick('#quickFilters .nav-item[data-filter="all"]')).backgroundColor,
      styleOf(pick('#assetGrid .thumb')).backgroundColor,
      styleOf(pick('.asset-card.selected'), '::after').borderColor,
      styleOf(pick('.mosa-v2 .nav-label')).color,
    ], 'dark colours');
    const bodyDark = styleOf(document.body);
    R['dark.bodyBackground'] = bodyDark.backgroundColor;
    R['dark.bodyColor'] = bodyDark.color;
    R['dark.navItemActiveBackground'] = styleOf(pick('#quickFilters .nav-item[data-filter="all"]')).backgroundColor;
    R['dark.thumbBackground'] = styleOf(pick('#assetGrid .thumb')).backgroundColor;
    R['dark.selectionRingColor'] = styleOf(pick('.asset-card.selected'), '::after').borderColor;
    R['dark.navLabelColor'] = styleOf(pick('.mosa-v2 .nav-label')).color;
    // 任务 109（对比度）：侧栏计数 + 打开检视器量「添加标签」/素材路径的深色字色。
    R['dark.navCountColor'] = styleOf(pick('#quickFilters .nav-item[data-filter="favorite"] .nav-count')).color;
    click('#openInspectorBtn');
    await waitFor(() => pick('#detailPanel').getAttribute('aria-hidden') === 'false'
      && pick('#detailPanel').querySelector('.detail-tags-add')
      && pick('#detailPanel').querySelector('.detail-pathbar-path'), 'inspector renders for the dark colour keys');
    R['dark.tagsAddColor'] = styleOf(pick('#detailPanel .detail-tags-add')).color;
    R['dark.pathColor'] = styleOf(pick('#detailPanel .detail-pathbar-path')).color;

    return R;
  })()`;
}
