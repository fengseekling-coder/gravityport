// GravityPort React UI flow (task 164, sections since task 251): Settings →
// 关于 release notes.
//
// The About page must say what changed: on a development build one block fed
// by release-notes.json `unreleased` ("下个版本（开发中）"), with the
// version/build/distribution line demoted to a small footnote and the legacy
// 本次更新/构建信息 headings gone. A fake window.electronAPI.checkForUpdates
// (update available + itemized notes with category prefixes) proves the
// new-version block lands above the current-version block and restores the
// 新增/修复 sections with the prefixes stripped, and the 720x464 settings
// dialog must scroll internally instead of growing or overflowing sideways.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const name = "about-release-notes";
export const description =
  "Settings → 关于: dev notes from release-notes.json (zh + en) + meta footnote + no legacy headings -> fake update injects prefixed new-version notes restored into sections above the current one -> 720x464 stays overflow-free";

const FAKE_UPDATE = {
  status: "ok",
  updateAvailable: true,
  latestVersion: "9.9.9",
  publishedAt: "2026-10-16T12:00:00Z",
  canInstallInApp: false,
  notes: {
    zh: "• 新增：新版第一句\n- 修复：新版第二句\n\n  第三行没有符号",
    en: "• New: English first\n- Fixed: English second\n\nthird line has no marker",
  },
};

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const notes = JSON.parse(await readFile(join(ctx.rootDir, "release-notes.json"), "utf8"));
    // Between a release and the next recorded change, `unreleased` is empty and
    // the dev About page renders the placeholder instead of real lines.
    // `unreleased` may be a flat list or sectioned (schema 2); the renderer
    // reports the lines of all groups in section order.
    const flatLines = (value) => Array.isArray(value)
      ? value
      : ["new", "improved", "fixed", "other"].flatMap((key) => (Array.isArray(value?.[key]) ? value[key] : []));
    const zhUnreleased = flatLines(notes.unreleased.zh);
    const enUnreleased = flatLines(notes.unreleased.en);
    const zhDevLines = zhUnreleased.length > 0 ? zhUnreleased : ["还没有记录"];
    const enDevLines = enUnreleased.length > 0 ? enUnreleased : ["Nothing recorded yet"];
    const status = await ctx.api(server.origin, "GET", "/api/health");
    if (status.distribution !== "development") {
      throw new Error(`this flow asserts the development branch; dist was built as ${status.distribution} — run npm run build without MOSA_RELEASE_DISTRIBUTION first`);
    }
    const sha = String(status.gitSha || "").slice(0, 7);
    await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath: await ctx.makePng("about-release-notes.png", [96, 74, 155]),
      prompt: "about release notes seed",
    });

    // Round 1 (zh): the development block plus the demoted meta footnote.
    const zh = await runRound(ctx, server, zhSource(), 'zh');
    assertEqual(zh.titles, ["下个版本（开发中）"], "zh dev block titles");
    assertEqual(zh.firstLines, zhDevLines, "zh dev block lines match unreleased.zh");
    assertOk(zh.meta.includes(`版本 ${status.productVersion} · 构建 ${sha} · 开发版`), `meta footnote line (got: ${zh.meta})`);
    assertEqual(zh.legacyHeadings, false, "本次更新/构建信息 headings are gone");
    assertOk(zh.paneOverflowFree, `about pane must not overflow horizontally (${zh.paneScrollWidth} <= ${zh.paneClientWidth})`);

    // Round 2 (en): same content in English after switching the language.
    const en = await runRound(ctx, server, englishSource(), 'en');
    assertEqual(en.titles, ["Next version (in development)"], "en dev block titles");
    assertEqual(en.firstLines, enDevLines, "en dev block lines match unreleased.en");
    assertOk(en.meta.includes(`Version ${status.productVersion} · Build ${sha} · Development build`), `en meta footnote line (got: ${en.meta})`);

    // Round 3: 720x464 — the dialog keeps its CSS size and the about page
    // scrolls inside the content pane instead of overflowing sideways.
    const narrow = await runRound(ctx, server, narrowSource(), 'narrow', { windowSize: [720, 464] });
    assertEqual(narrow.innerWidth, 720, "narrow viewport width");
    assertEqual(narrow.innerHeight, 464, "narrow viewport height");
    assertEqual(narrow.modalWidth, 672, "modal width at 720x464 (min(736, 100vw-48))");
    assertEqual(narrow.modalHeight, 416, "modal height at 720x464 (min(560, 100dvh-48))");
    assertOk(narrow.paneOverflowFree, `about pane must not overflow horizontally at 720x464 (${narrow.paneScrollWidth} <= ${narrow.paneClientWidth})`);

    // Round 4: a fake checkForUpdates result with category-prefixed notes —
    // the new-version block appears above the current-version block, restores
    // the 新增/修复 sections with the prefixes stripped, and puts the lines
    // without a prefix into a heading-less group first; the expected date is
    // computed in-page with the same Intl options so the assertion holds in
    // every timezone.
    const updated = await runRound(ctx, server, fakeUpdateSource(), 'fake-update');
    assertEqual(updated.titles, ["新版本 9.9.9 更新内容", "下个版本（开发中）"], "new-version block above the current one");
    assertEqual(updated.firstGroups, [
      { heading: "", lines: ["第三行没有符号"] },
      { heading: "新增", lines: ["新版第一句"] },
      { heading: "修复", lines: ["新版第二句"] },
    ], "new-version groups restore the sections with prefixes stripped");
    assertEqual(updated.firstDate, updated.expectedDate, "new-version date formatted for the zh interface");
    assertEqual(updated.secondLines, zhDevLines, "current-version block still the dev unreleased lines");
    return { rounds: 4, updateInjected: true };
  } finally {
    await server.stop();
  }
}

function pageHelpers() {
  return `
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
    const navByTitle = (title) => Array.from(document.querySelectorAll('.settings-nav button'))
      .find((b) => b.textContent.trim() === title);
    async function openSettings() {
      await waitFor(() => document.querySelector('.app'), 'app shell');
      document.querySelector('.user-button').click();
      await waitFor(() => document.querySelector('.settings-modal'), 'settings open');
    }
    async function openAboutPage() {
      await openSettings();
      const nav = navByTitle('关于') || navByTitle('About');
      if (!nav) throw new Error('about nav missing: ' + Array.from(document.querySelectorAll('.settings-nav button')).map((b) => b.textContent.trim()).join('|'));
      nav.click();
      // Until /api/health answers, the heading is the "当前版本 — 更新内容"
      // placeholder; a slow start (Windows CI) must not be read that early.
      await waitFor(() => {
        const heading = document.querySelector('.release-notes .release-heading h4');
        return heading && !heading.textContent.includes('—') ? heading : null;
      }, 'release-notes block with the version loaded');
    }
    const collect = () => {
      const blocks = Array.from(document.querySelectorAll('.settings-content .release-notes'));
      const pane = document.querySelector('.settings-content');
      const groups = (block) => Array.from(block?.querySelectorAll('.release-group') || []).map((g) => ({
        heading: (g.querySelector('.release-group-heading')?.textContent || '').trim(),
        lines: Array.from(g.querySelectorAll('li')).map((li) => li.textContent.trim()),
      }));
      return {
        titles: blocks.filter((s) => s.querySelector('.release-heading h4')).map((s) => s.querySelector('.release-heading h4').textContent.trim()),
        firstLines: Array.from(blocks[0]?.querySelectorAll('li') || []).map((li) => li.textContent.trim()),
        firstGroups: groups(blocks[0]),
        meta: (pane.querySelector('.release-meta')?.textContent || '').replace(/\\s+/g, ' ').trim(),
        legacyHeadings: /本次更新|构建信息/.test(pane.textContent),
        paneScrollWidth: pane.scrollWidth,
        paneClientWidth: pane.clientWidth,
        paneOverflowFree: pane.scrollWidth <= pane.clientWidth,
      };
    };
  `;
}

// The Electron runner only reports "script failed to execute" for a rejected
// page script, so every source catches its own errors and ships the stack back
// to the flow, which turns it into a real assertion message.
function pageSource(body) {
  return `(async () => {
    try {
      ${body}
    } catch (error) {
      return { __pageError: String((error && error.stack) || error) };
    }
  })()`;
}

async function runRound(ctx, server, source, label, { windowSize } = {}) {
  const result = await ctx.runInPage(server, source, { windowSize });
  if (result?.__pageError) throw new Error(`${label} page error: ${result.__pageError}`);
  return result;
}

function zhSource() {
  return pageSource(`
    ${pageHelpers()}
    await openAboutPage();
    return collect();
  `);
}

function englishSource() {
  return pageSource(`
    ${pageHelpers()}
    await openAboutPage();
    // Switch the interface to English on the general page, then back to About.
    navByTitle('常规').click();
    await waitFor(() => Array.from(document.querySelectorAll('.settings-content .segmented button')).find((b) => b.textContent.trim() === 'English'), 'English language button');
    Array.from(document.querySelectorAll('.settings-content .segmented button')).find((b) => b.textContent.trim() === 'English').click();
    await sleep(200);
    const aboutNav = navByTitle('About');
    if (!aboutNav) throw new Error('About nav missing after language switch');
    aboutNav.click();
    await waitFor(() => Array.from(document.querySelectorAll('.release-notes .release-heading h4')).some((h) => h.textContent.includes('Next version')), 'english release-notes block');
    return collect();
  `);
}

function narrowSource() {
  return pageSource(`
    ${pageHelpers()}
    await openAboutPage();
    const modal = document.querySelector('.settings-modal');
    return {
      ...collect(),
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      modalWidth: modal.offsetWidth,
      modalHeight: modal.offsetHeight,
    };
  `);
}

function fakeUpdateSource() {
  return pageSource(`
    ${pageHelpers()}
    await openSettings();
    // Round 2 left the persisted preference on English; pin Chinese back so
    // the zh titles and date format are deterministic.
    (navByTitle('常规') || navByTitle('General')).click();
    await waitFor(() => Array.from(document.querySelectorAll('.settings-content .segmented button')).find((b) => b.textContent.trim() === '中文'), '中文 language button');
    Array.from(document.querySelectorAll('.settings-content .segmented button')).find((b) => b.textContent.trim() === '中文').click();
    await sleep(200);
    (navByTitle('关于') || navByTitle('About')).click();
    await waitFor(() => document.querySelector('.release-notes .release-heading h4'), 'release-notes block');
    // Injected after load: the click handler reads desktopAPI() at call time,
    // so this fake is exactly what a desktop update check would answer.
    window.electronAPI = {
      // Parenthesized: a bare object literal after the arrow would parse as a block.
      checkForUpdates: async () => (${JSON.stringify(FAKE_UPDATE)}),
    };
    document.querySelector('.settings-content .about-update').click();
    await waitFor(() => Array.from(document.querySelectorAll('.release-notes .release-heading h4')).some((h) => h.textContent.includes('9.9.9')), 'new-version block');
    const blocks = Array.from(document.querySelectorAll('.settings-content .release-notes'))
      .filter((s) => s.querySelector('.release-heading h4'));
    const expectedDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })
      .format(new Date(${JSON.stringify(FAKE_UPDATE.publishedAt)}));
    const groups = (block) => Array.from(block.querySelectorAll('.release-group') || []).map((g) => ({
      heading: (g.querySelector('.release-group-heading')?.textContent || '').trim(),
      lines: Array.from(g.querySelectorAll('li')).map((li) => li.textContent.trim()),
    }));
    return {
      titles: blocks.map((s) => s.querySelector('.release-heading h4').textContent.trim()),
      firstLines: Array.from(blocks[0].querySelectorAll('li')).map((li) => li.textContent.trim()),
      firstGroups: groups(blocks[0]),
      secondLines: Array.from(blocks[1].querySelectorAll('li')).map((li) => li.textContent.trim()),
      firstDate: (blocks[0].querySelector('.release-heading span')?.textContent || '').trim(),
      expectedDate,
    };
  `);
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertOk(condition, label) {
  if (!condition) throw new Error(label);
}
