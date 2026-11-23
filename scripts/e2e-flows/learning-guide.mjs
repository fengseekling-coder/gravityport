// GravityPort desktop flow (task 464): end-to-end learning guide UI with the
// real Electron shell, real ai-learning-* IPC, real learning-guide HTTP routes,
// and a local 127.0.0.1 fake Claude service (never touches any external host).
//
// Walks through every interaction specified in task 464:
// 1. Add a Claude-format custom service via Settings -> AI pointing at the
//    local fake server, save a fake key (sk-test-0...5678), verify models.
// 2. Seed 3 images in a learning library -> confirm dialog shows longEdge 960
//    and service label -> learn -> verify guide (positioning + >=2 sections +
//    swatches + source counts), 1 log row, no 未学习 in top bar.
// 3. Click 来自 N 张 -> gallery filters to N cards + top bar filter chip ->
//    clear -> back to 3; click learning log row -> chip + 3 cards -> clear.
// 4. Inline edit one entry -> auto-locks -> rebuild guide -> edited text
//    preserved verbatim, unlocked entry updated to v2, 3 log rows.
// 5. Revert latest run -> unlocked entry returns to v1.
// 6. Add 6 more images -> top bar 6 张未学习, button 学新加的 6 张 -> slow mode
//    (2s/img) -> start -> pause as soon as progress appears -> 正在暂停 -> 已暂停
//    -> fake server stops at 4 analyze requests (concurrency 4), stays 4 after
//    3s -> resume -> confirm dialog mentions 剩下的 2 张 -> completes.
// 7. Switch fake server to 401 -> add 1 image -> start -> auth pause + 打开 AI
//    设置 opens AI tab -> close -> 放弃这次学习 -> returns to 学新加的 1 张.
// 8. Raw-byte scan of every file in libraryDir and userDataDir (except
//    ai-credentials.json): fake key must appear nowhere.
import { createServer } from "node:http";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopGui } from "../desktop-gui-launcher.mjs";
import { ensureElectronExecutablePath } from "../desktop-runtime-paths.mjs";

export const name = "learning-guide";
export const description = "real desktop shell + fake 127.0.0.1 Claude: AI setup -> first learn (confirm 960px + progress + guide/log) -> entry & run gallery filters -> inline edit auto-lock -> rebuild keeps locked -> revert -> add 6 + pause stops at 4 + resume remaining 2 -> 401 auth pause + open AI settings + discard -> zero secret leak";

const FAKE_KEY = `sk-test-${"0".repeat(30)}5678`;
const FAKE_KEY_BODY = FAKE_KEY.slice("sk-test-".length);
const FAKE_SERVICE_NAME = "Fake Claude 464";
const LIBRARY_NAME = "学习手册测试库";

export async function run(ctx) {
  await ctx.prepare();
  const guiRoot = join(ctx.userDataDir, "..", "learning-guide-gui");
  await mkdir(guiRoot, { recursive: true });

  const fakeClaude = await startFakeClaudeServer();
  const port = await freePort();
  const cdpPort = await freePort();
  const pidFile = join(guiRoot, "pid.txt");
  const logFile = join(guiRoot, "main.log");
  const healthFile = join(guiRoot, "health.json");
  const executable = ensureElectronExecutablePath({ rootDir: ctx.rootDir });
  const qaFlags = process.platform === "win32" ? ["--disable-gpu"] : [];

  const launched = await launchDesktopGui({
    platform: process.platform,
    rootDir: guiRoot,
    executable,
    args: [...qaFlags, "desktop/main.mjs", `--user-data-dir=${ctx.userDataDir}`, `--remote-debugging-port=${cdpPort}`],
    env: {
      ...process.env,
      MOSA_RUNTIME_MODE: "qa",
      MOSA_QA_RUN: "1",
      MOSA_CLIENT_TOKEN: ctx.token,
      MOSA_LIBRARY_DIR: ctx.libraryDir,
      MOSA_USER_DATA: ctx.userDataDir,
      MOSA_DISABLE_BRIDGES: "cowart,cowartDiscovery,codex,grok",
      MOSA_PROJECT_DIR: ctx.rootDir,
      MOSA_DESKTOP_PORT: String(port),
      CODEX_GENERATED_IMAGES_DIR: join(guiRoot, "generated-images"),
      CODEX_SESSIONS_DIR: join(guiRoot, "codex-sessions"),
      GROK_SESSIONS_DIR: join(guiRoot, "grok-sessions"),
      COWART_MOSA_CANVAS_DIR: join(guiRoot, "cowart-data"),
      MOSA_COWART_REGISTRY_PATH: join(guiRoot, "cowart-data", "registry.json"),
    },
    cwd: ctx.rootDir,
    pidFile,
    logFile,
    healthUrl: `http://127.0.0.1:${port}/api/health`,
    healthFile,
  });

  const waiter = launched.waiter;
  let cdp = null;
  try {
    await waitForHealthFile(healthFile);
    const origin = `http://127.0.0.1:${port}`;

    // Seed 3 initial images & a learning library through the local service API.
    const initialIds = [];
    const initialColors = [
      [42, 84, 148],
      [62, 118, 174],
      [28, 52, 96],
    ];
    for (let i = 0; i < initialColors.length; i += 1) {
      const id = await stageAndCreateAsset(ctx, origin, `lg-init-${i + 1}.png`, initialColors[i], `cold blue poster ${i + 1}`);
      initialIds.push(id);
    }
    const createdLib = await ctx.api(origin, "POST", "/api/learning-libraries", {
      projectId: "default",
      name: LIBRARY_NAME,
    });
    const libraryId = createdLib.library.id;
    await ctx.api(origin, "POST", `/api/learning-libraries/${encodeURIComponent(libraryId)}/members`, {
      projectId: "default",
      assetIds: initialIds,
    });
    await waitForPendingCount(ctx, origin, libraryId, 3);

    cdp = await connectCdp(cdpPort, origin);
    await waitForRendererReady(cdp);

    // Enable dev switch and reload.
    await cdp.evaluate(`localStorage.setItem('gravityport.dev.ai-generation', '1')`);
    await cdp.evaluate(`location.reload()`);
    await waitForRendererReady(cdp);

    // ── Step 1: Configure Fake Claude via Settings -> AI ──
    await clickCenter(cdp, `document.querySelector('.user-button')`);
    await waitFor(cdp, `Boolean(document.querySelector('.settings-modal'))`, "settings modal open");
    await waitFor(
      cdp,
      `Array.from(document.querySelectorAll('.settings-nav button')).some((b) => b.textContent.trim() === 'AI')`,
      "AI nav row",
    );
    await clickCenter(
      cdp,
      `Array.from(document.querySelectorAll('.settings-nav button')).find((b) => b.textContent.trim() === 'AI')`,
    );
    await waitFor(cdp, `document.querySelectorAll('.settings-modal .ai-card').length === 3`, "three AI cards");

    // Add Claude-format custom service in first card (分析和汇总).
    await clickCenter(cdp, `document.querySelector('.ai-card .ai-row .toolbar-select')`);
    await waitFor(
      cdp,
      `Array.from(document.querySelectorAll('.toolbar-select-menu .toolbar-select-option')).some((el) => el.textContent.includes('添加其它服务'))`,
      "add-service menu option",
    );
    await clickCenter(
      cdp,
      `Array.from(document.querySelectorAll('.toolbar-select-menu .toolbar-select-option')).find((el) => el.textContent.includes('添加其它服务'))`,
    );
    await waitFor(cdp, `Boolean(document.querySelector('.ai-add-form'))`, "add service form open");
    await clickCenter(cdp, `document.querySelector('.ai-add-form input.ai-text-input')`);
    await cdp.send("Input.insertText", { text: FAKE_SERVICE_NAME });
    // Choose Claude format.
    await clickCenter(
      cdp,
      `Array.from(document.querySelectorAll('.ai-add-form .segmented button')).find((b) => b.textContent.includes('Claude'))`,
    );
    await clickCenter(cdp, `document.querySelector('.ai-add-form input[type="url"]')`);
    await cdp.send("Input.insertText", { text: fakeClaude.url });
    await clickCenter(
      cdp,
      `Array.from(document.querySelectorAll('.ai-add-actions .settings-action-btn')).find((b) => b.textContent.trim() === '添加')`,
    );
    await waitFor(cdp, `!document.querySelector('.ai-add-form')`, "add service form closed");
    await waitFor(
      cdp,
      `Array.from(document.querySelectorAll('.ai-card .ai-row .toolbar-select span')).some((el) => el.textContent.trim() === ${JSON.stringify(FAKE_SERVICE_NAME)})`,
      "custom Claude service selected",
    );
    // Save fake key.
    await clickCenter(cdp, `document.querySelector('.ai-card .ai-key-input')`);
    await cdp.send("Input.insertText", { text: FAKE_KEY });
    await clickCenter(
      cdp,
      `Array.from(document.querySelectorAll('.ai-card .ai-key-row .settings-action-btn')).find((b) => b.textContent.trim() === '保存')`,
    );
    await waitFor(
      cdp,
      `Array.from(document.querySelectorAll('.ai-key-saved')).some((el) => el.textContent.includes('尾号 5678'))`,
      "fake key saved last4 5678",
    );
    // Verify analysis & summary models default to Claude Haiku 5.5 / Claude Sonnet 5.5.
    const modelTexts = await cdp.evaluate(
      `Array.from(document.querySelectorAll('.ai-card .ai-model-pair .toolbar-select span')).map((el) => el.textContent.trim())`,
    );
    if (!modelTexts.some((t) => t.includes("Haiku 5.5")) || !modelTexts.some((t) => t.includes("Sonnet 5.5"))) {
      throw new Error(`unexpected Claude model defaults: ${JSON.stringify(modelTexts)}`);
    }
    await clickCenter(cdp, `document.querySelector('.settings-modal .modal-close')`);
    await waitFor(cdp, `!document.querySelector('.settings-modal')`, "settings closed");

    // ── Step 2: Enter learning library -> first learn (3 images) ──
    await waitFor(
      cdp,
      `Boolean(document.querySelector('.sidebar .group-row[data-drop-learning-library="${libraryId}"]'))`,
      "sidebar learning library row",
    );
    await clickCenter(cdp, `document.querySelector('.sidebar .group-row[data-drop-learning-library="${libraryId}"]')`);
    await waitFor(
      cdp,
      `document.querySelector('.sidebar .group-row[data-drop-learning-library="${libraryId}"]')?.getAttribute('aria-current') === 'page' && Boolean(document.querySelector('.learn-library-tabs')) && Boolean(document.querySelector('.learn-library-title')) && document.querySelectorAll('.asset-card:not(.asset-card-virtual-placeholder)').length === 3`,
      "learning library view active with 3 cards",
    );
    // Wait a beat for initial gallery selection to settle before switching to 手册 tab.
    await sleep(300);
    await ensureGuideTabActive(cdp);

    // Wait for footer button: 开始学习 3 张（约 …）
    await waitFor(
      cdp,
      `Boolean(document.querySelector('.learn-footer-btn') && document.querySelector('.learn-footer-btn').textContent.includes('开始学习 3 张（约'))`,
      "footer shows 开始学习 3 张（约 ...）",
    );
    await clickCenter(cdp, `document.querySelector('.learn-footer-btn')`);
    await waitFor(cdp, `Boolean(document.querySelector('dialog.ui-dialog[open]'))`, "start confirm dialog opens");
    const confirmText = await cdp.evaluate(`document.querySelector('dialog.ui-dialog[open]').textContent`);
    if (!confirmText.includes("长边 960 像素") || !confirmText.includes(FAKE_SERVICE_NAME)) {
      throw new Error(`start confirm dialog missing 960px or service name: ${confirmText}`);
    }

    // Use a brief analyze delay so the progress line is visibly rendered before finishing.
    fakeClaude.state.analyzeDelayMs = 400;
    await clickCenter(
      cdp,
      `Array.from(document.querySelectorAll('dialog.ui-dialog[open] .ui-dialog-actions button')).find((b) => b.textContent.trim() === '开始学习')`,
    );
    await waitFor(
      cdp,
      `Boolean(document.querySelector('.learn-footer-status') && document.querySelector('.learn-footer-status').textContent.includes('正在学习'))`,
      "progress indicator appears",
    );
    // Wait for learning to finish: positioning + >=2 sections + 1 log row + no 未学习.
    await waitFor(
      cdp,
      `Boolean(document.querySelector('.learn-guide-positioning') && document.querySelectorAll('.learn-guide-group').length >= 2 && document.querySelectorAll('.learn-log-row').length === 1)`,
      "first learn completes with guide and 1 log row",
      30000,
    );
    const headerAfterFirst = await cdp.evaluate(`document.querySelector('.learn-library-title')?.textContent || ''`);
    if (headerAfterFirst.includes("未学习")) {
      throw new Error(`top bar still shows 未学习 after first learn: ${headerAfterFirst}`);
    }
    const sourceTexts = await cdp.evaluate(
      `Array.from(document.querySelectorAll('.learn-guide-source')).map((el) => el.textContent.trim())`,
    );
    if (!sourceTexts.length || !sourceTexts.every((t) => /^来自 \d+ 张$/.test(t))) {
      throw new Error(`unexpected source buttons: ${JSON.stringify(sourceTexts)}`);
    }
    const swatchCount = await cdp.evaluate(`document.querySelectorAll('.learn-guide-swatch').length`);
    if (swatchCount < 2) throw new Error(`expected palette swatches, got ${swatchCount}`);

    // ── Step 3: Filter by entry source (来自 2 张) & by learning log row ──
    await waitFor(
      cdp,
      `Array.from(document.querySelectorAll('.learn-guide-source')).some((el) => el.textContent.trim() === '来自 2 张')`,
      "entry with 来自 2 张",
    );
    await clickCenter(
      cdp,
      `Array.from(document.querySelectorAll('.learn-guide-source')).find((el) => el.textContent.trim() === '来自 2 张')`,
    );
    await waitFor(
      cdp,
      `document.querySelectorAll('.asset-card:not(.asset-card-virtual-placeholder)').length === 2 && Boolean(document.querySelector('.learn-filter-chip'))`,
      "gallery filtered to 2 cards with filter chip",
    );
    const entryChipText = await cdp.evaluate(`document.querySelector('.learn-filter-chip')?.textContent?.trim() || ''`);
    if (!entryChipText.includes("的来源 · 2 张")) {
      throw new Error(`unexpected entry filter chip text: ${entryChipText}`);
    }
    await clickCenter(cdp, `document.querySelector('.learn-filter-clear')`);
    await waitFor(
      cdp,
      `document.querySelectorAll('.asset-card:not(.asset-card-virtual-placeholder)').length === 3 && !document.querySelector('.learn-filter-chip')`,
      "gallery returns to 3 cards after clearing entry filter",
    );

    // Click the learning log row -> filter chip shows 只看 ... 学的 3 张.
    await clickCenter(cdp, `document.querySelector('.learn-log-clickable')`);
    await waitFor(
      cdp,
      `Boolean(document.querySelector('.learn-filter-chip')) && document.querySelectorAll('.asset-card:not(.asset-card-virtual-placeholder)').length === 3`,
      "run filter chip active with 3 cards",
    );
    const runChipText = await cdp.evaluate(`document.querySelector('.learn-filter-chip')?.textContent?.trim() || ''`);
    if (!runChipText.includes("学的 3 张")) {
      throw new Error(`unexpected run filter chip text: ${runChipText}`);
    }
    await clickCenter(cdp, `document.querySelector('.learn-filter-clear')`);
    await waitFor(cdp, `!document.querySelector('.learn-filter-chip')`, "run filter chip cleared");

    // ── Step 4: Edit one entry -> auto-locks -> rebuild guide -> locked preserved, unlocked updated ──
    const lockedEditText = "手动锁定的构图规则（464测试）";
    const compositionEntryId = await cdp.evaluate(`(() => {
      const group = Array.from(document.querySelectorAll('.learn-guide-group'))
        .find((g) => g.querySelector('.learn-guide-section-label')?.textContent.trim() === '构图和镜头');
      return group?.querySelector('.learn-guide-entry')?.getAttribute('data-guide-entry-id') || '';
    })()`);
    if (!compositionEntryId) throw new Error("composition guide entry not found");

    await clickCenter(
      cdp,
      `document.querySelector('[data-guide-entry-id="${compositionEntryId}"] .learn-guide-text')`,
    );
    await waitFor(
      cdp,
      `Boolean(document.querySelector('[data-guide-entry-id="${compositionEntryId}"] .learn-guide-textarea'))`,
      "inline textarea open",
    );
    await cdp.evaluate(`(() => {
      const ta = document.querySelector('[data-guide-entry-id="${compositionEntryId}"] .learn-guide-textarea');
      ta.focus();
      ta.select();
    })()`);
    await cdp.send("Input.insertText", { text: lockedEditText });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });

    await waitFor(
      cdp,
      `Boolean(document.querySelector('[data-guide-entry-id="${compositionEntryId}"] .learn-guide-lock.locked'))`,
      "edited entry auto-locked",
    );
    await waitFor(
      cdp,
      `Boolean(document.querySelector('.learn-footer-btn') && document.querySelector('.learn-footer-btn').textContent.includes('重新整理手册（约'))`,
      "footer shows 重新整理手册（约 ...）",
    );

    // Click 重新整理手册 -> confirm -> wait for v2 text on unlocked lighting entry.
    await clickCenter(cdp, `document.querySelector('.learn-footer-btn')`);
    await waitFor(cdp, `Boolean(document.querySelector('dialog.ui-dialog[open]'))`, "rebuild confirm opens");
    await clickCenter(
      cdp,
      `Array.from(document.querySelectorAll('dialog.ui-dialog[open] .ui-dialog-actions button')).find((b) => b.textContent.trim() === '重新整理')`,
    );
    await waitFor(
      cdp,
      `document.querySelectorAll('.learn-log-row').length === 3 && Array.from(document.querySelectorAll('.learn-guide-text')).some((el) => el.textContent.includes('第二版光线总结'))`,
      "rebuild finishes with 3 log rows and v2 unlocked text",
      30000,
    );
    const lockedAfterRebuild = await cdp.evaluate(
      `document.querySelector('[data-guide-entry-id="${compositionEntryId}"] .learn-guide-text')?.textContent?.trim() || ''`,
    );
    if (lockedAfterRebuild !== lockedEditText) {
      throw new Error(`locked entry changed after rebuild: ${JSON.stringify(lockedAfterRebuild)} !== ${JSON.stringify(lockedEditText)}`);
    }

    // ── Step 5: Revert latest run -> unlocked lighting entry returns to v1 text ──
    await waitFor(cdp, `Boolean(document.querySelector('.learn-log-revert'))`, "revert button visible");
    await clickCenter(cdp, `document.querySelector('.learn-log-revert')`);
    await waitFor(cdp, `Boolean(document.querySelector('dialog.ui-dialog[open]'))`, "revert confirm dialog opens");
    await clickCenter(
      cdp,
      `Array.from(document.querySelectorAll('dialog.ui-dialog[open] .ui-dialog-actions button')).find((b) => b.textContent.trim() === '撤回')`,
    );
    await waitFor(
      cdp,
      `Array.from(document.querySelectorAll('.learn-guide-text')).some((el) => el.textContent.includes('第一版光线总结'))`,
      "unlocked entry reverted back to v1 text",
    );

    // ── Step 6: Add 6 more images -> pause stops at 4 requests -> wait 3s -> resume remaining 2 ──
    const sixIds = [];
    for (let i = 0; i < 6; i += 1) {
      const id = await stageAndCreateAsset(ctx, origin, `lg-batch-${i + 1}.png`, [40 + i * 20, 90, 160], `batch poster ${i + 1}`);
      sixIds.push(id);
    }
    await ctx.api(origin, "POST", `/api/learning-libraries/${encodeURIComponent(libraryId)}/members`, {
      projectId: "default",
      assetIds: sixIds,
    });
    await waitForPendingCount(ctx, origin, libraryId, 6);

    await waitFor(
      cdp,
      `Boolean(document.querySelector('.learn-library-title')?.textContent?.includes('6 张未学习'))`,
      "top bar shows 6 张未学习",
      20000,
    );
    await ensureGuideTabActive(cdp);
    await waitFor(
      cdp,
      `Boolean(document.querySelector('.learn-footer-btn')?.textContent?.includes('学新加的 6 张'))`,
      "footer shows 学新加的 6 张",
      20000,
    );

    fakeClaude.state.analyzeCount = 0;
    fakeClaude.state.mode = "slow";
    fakeClaude.state.analyzeDelayMs = 2000;

    await clickCenter(cdp, `document.querySelector('.learn-footer-btn')`);
    await waitFor(cdp, `Boolean(document.querySelector('dialog.ui-dialog[open]'))`, "learn-6 confirm opens");
    await clickCenter(
      cdp,
      `Array.from(document.querySelectorAll('dialog.ui-dialog[open] .ui-dialog-actions button')).find((b) => b.textContent.trim() === '开始学习')`,
    );
    await waitFor(
      cdp,
      `Boolean(document.querySelector('.learn-footer-progress-row .learn-footer-link'))`,
      "progress + pause button appear",
    );
    // Click 暂停 immediately.
    await clickCenter(cdp, `document.querySelector('.learn-footer-progress-row .learn-footer-link')`);
    await waitFor(
      cdp,
      `Boolean(document.querySelector('.learn-footer-status')?.textContent?.includes('正在暂停'))`,
      "shows 正在暂停…",
    );
    await waitFor(
      cdp,
      `Boolean(document.querySelector('.learn-footer-reason')?.textContent?.includes('已暂停'))`,
      "transitions to 已暂停",
      20000,
    );

    const analyzeCountAtPause = fakeClaude.state.analyzeCount;
    console.log(`[e2e] learning-guide pause-check: analyzeCountAtPause=${analyzeCountAtPause}`);
    if (analyzeCountAtPause !== 4) {
      throw new Error(`expected analyzeCount at pause to be 4 (concurrency 4), got ${analyzeCountAtPause}`);
    }
    await sleep(3000);
    const analyzeCountAfter3s = fakeClaude.state.analyzeCount;
    console.log(`[e2e] learning-guide pause-check: analyzeCountAfter3s=${analyzeCountAfter3s}`);
    if (analyzeCountAfter3s !== 4) {
      throw new Error(`analyzeCount increased while paused: ${analyzeCountAfter3s}`);
    }

    // Resume the remaining 2 images.
    fakeClaude.state.mode = "fast";
    fakeClaude.state.analyzeDelayMs = 150;
    await waitFor(
      cdp,
      `Boolean(document.querySelector('.learn-footer-paused-actions .learn-footer-btn')?.textContent?.includes('继续（约'))`,
      "resume button ready",
    );
    await clickCenter(cdp, `document.querySelector('.learn-footer-paused-actions .learn-footer-btn')`);
    await waitFor(cdp, `Boolean(document.querySelector('dialog.ui-dialog[open]'))`, "resume confirm opens");
    const resumeConfirmText = await cdp.evaluate(`document.querySelector('dialog.ui-dialog[open]').textContent`);
    if (!resumeConfirmText.includes("剩下的 2 张")) {
      throw new Error(`resume confirm dialog missing 剩下的 2 张: ${resumeConfirmText}`);
    }
    await clickCenter(
      cdp,
      `Array.from(document.querySelectorAll('dialog.ui-dialog[open] .ui-dialog-actions button')).find((b) => b.textContent.trim() === '继续')`,
    );
    await waitFor(
      cdp,
      `Boolean(document.querySelector('.learn-footer-btn')?.textContent?.includes('重新整理手册')) && !document.querySelector('.learn-library-title')?.textContent?.includes('未学习')`,
      "resumed run finishes and all 9 images are learned",
      30000,
    );

    // ── Step 7: 401 auth pause -> open AI settings -> close -> discard -> back to 学新加的 1 张 ──
    fakeClaude.state.mode = "401";
    const extraId = await stageAndCreateAsset(ctx, origin, "lg-401-1.png", [180, 72, 92], "auth failure image");
    await ctx.api(origin, "POST", `/api/learning-libraries/${encodeURIComponent(libraryId)}/members`, {
      projectId: "default",
      assetIds: [extraId],
    });
    await waitForPendingCount(ctx, origin, libraryId, 1);
    await waitFor(
      cdp,
      `Boolean(document.querySelector('.learn-library-title')?.textContent?.includes('1 张未学习'))`,
      "top bar shows 1 张未学习",
      20000,
    );
    await ensureGuideTabActive(cdp);
    await waitFor(
      cdp,
      `Boolean(document.querySelector('.learn-footer-btn')?.textContent?.includes('学新加的 1 张'))`,
      "footer shows 学新加的 1 张",
      20000,
    );
    await clickCenter(cdp, `document.querySelector('.learn-footer-btn')`);
    await waitFor(cdp, `Boolean(document.querySelector('dialog.ui-dialog[open]'))`, "learn-1 confirm opens");
    await clickCenter(
      cdp,
      `Array.from(document.querySelectorAll('dialog.ui-dialog[open] .ui-dialog-actions button')).find((b) => b.textContent.trim() === '开始学习')`,
    );
    await waitFor(
      cdp,
      `Boolean(document.querySelector('.learn-footer-reason')?.textContent?.includes('Claude 拒绝了密钥，请到 AI 设置检查'))`,
      "401 auth pause reason shown",
      20000,
    );
    // Click 打开 AI 设置 -> opens Settings modal on AI page.
    await clickCenter(
      cdp,
      `Array.from(document.querySelectorAll('.learn-library-footer .learn-footer-link')).find((b) => b.textContent.trim() === '打开 AI 设置')`,
    );
    await waitFor(
      cdp,
      `Boolean(document.querySelector('.settings-modal')) && document.querySelectorAll('.settings-modal .ai-card').length === 3`,
      "Settings opens directly on AI tab",
    );
    await clickCenter(cdp, `document.querySelector('.settings-modal .modal-close')`);
    await waitFor(cdp, `!document.querySelector('.settings-modal')`, "Settings closes");

    // Discard run -> back to 学新加的 1 张.
    await clickCenter(
      cdp,
      `Array.from(document.querySelectorAll('.learn-library-footer .learn-footer-link')).find((b) => b.textContent.trim() === '放弃这次学习')`,
    );
    await waitFor(cdp, `Boolean(document.querySelector('dialog.ui-dialog[open]'))`, "abandon confirm opens");
    await clickCenter(
      cdp,
      `Array.from(document.querySelectorAll('dialog.ui-dialog[open] .ui-dialog-actions button')).find((b) => b.textContent.trim() === '放弃')`,
    );
    await waitFor(
      cdp,
      `Boolean(document.querySelector('.learn-footer-btn')?.textContent?.includes('学新加的 1 张'))`,
      "after discard returns to 学新加的 1 张",
      20000,
    );

    // ── Step 8: Raw byte scan for fake key across libraryDir and userDataDir (except ai-credentials.json) ──
    const leaked = [
      ...(await scanDirectoryForSecret(ctx.libraryDir, [FAKE_KEY, FAKE_KEY_BODY], new Set())),
      ...(await scanDirectoryForSecret(ctx.userDataDir, [FAKE_KEY, FAKE_KEY_BODY], new Set(["ai-credentials.json"]))),
    ];
    if (leaked.length > 0) {
      throw new Error(`fake key leaked into files: ${JSON.stringify(leaked)}`);
    }

    return {
      ok: true,
      analyzeCountAtPause,
      analyzeCountAfter3s,
      totalSummaryCalls: fakeClaude.state.summaryCount,
      leakedFiles: 0,
    };
  } finally {
    if (cdp) cdp.close();
    try {
      const childPid = Number((await readFile(pidFile, "utf8")).trim());
      if (Number.isInteger(childPid) && childPid > 1) process.kill(childPid, "SIGTERM");
    } catch {}
    if (waiter.exitCode === null) waiter.kill("SIGTERM");
    await fakeClaude.close();
    await rm(guiRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function ensureGuideTabActive(cdp) {
  const isGuide = await cdp.evaluate(
    `Array.from(document.querySelectorAll('.learn-library-tabs button')).find((b) => b.textContent.trim() === '手册')?.getAttribute('aria-selected') === 'true'`,
  );
  if (!isGuide) {
    await clickCenter(
      cdp,
      `Array.from(document.querySelectorAll('.learn-library-tabs button')).find((b) => b.textContent.trim() === '手册')`,
    );
  }
  await waitFor(cdp, `Boolean(document.querySelector('.learn-library-panel'))`, "guide panel mounted");
}

async function stageAndCreateAsset(ctx, origin, fileName, rgb, prompt) {
  const pngPath = await ctx.makePng(fileName, rgb, { width: 120, height: 160 });
  const staged = await fetch(`${origin}/api/import/stage`, {
    method: "POST",
    headers: {
      "content-type": "image/png",
      "x-mosa-file-name": encodeURIComponent(fileName),
      "x-mosa-client-token": ctx.token,
    },
    body: await readFile(pngPath),
  });
  if (!staged.ok) throw new Error(`stage failed (${staged.status}) for ${fileName}`);
  const { path } = await staged.json();
  const created = await ctx.api(origin, "POST", "/api/assets/create", {
    projectId: "default",
    imagePath: path,
    prompt,
  });
  return created.asset.id;
}

async function waitForPendingCount(ctx, origin, libraryId, expectedPending, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await ctx.api(origin, "GET", `/api/learning-libraries/${encodeURIComponent(libraryId)}/learning?project=default`);
    if (state?.counts?.pending === expectedPending) return state;
    await sleep(150);
  }
  throw new Error(`timeout waiting for pending count ${expectedPending}`);
}

async function scanDirectoryForSecret(dir, needles, skipNames) {
  const hits = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      hits.push(...(await scanDirectoryForSecret(full, needles, skipNames)));
    } else if (entry.isFile()) {
      if (skipNames.has(entry.name)) continue;
      const bytes = await readFile(full).catch(() => null);
      if (!bytes) continue;
      for (const needle of needles) {
        if (bytes.includes(Buffer.from(needle, "utf8"))) {
          hits.push(full);
          break;
        }
      }
    }
  }
  return hits;
}

function startFakeClaudeServer() {
  const state = {
    mode: "fast",
    analyzeDelayMs: 0,
    analyzeCount: 0,
    summaryCount: 0,
    totalRequests: 0,
  };

  const server = createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || "/", "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    let body = null;
    try { body = rawBody ? JSON.parse(rawBody) : null; } catch { body = null; }

    if (req.method === "GET" && parsedUrl.pathname === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "claude-haiku-5-5" }, { id: "claude-sonnet-5-5" }] }));
      return;
    }

    if (req.method === "POST" && parsedUrl.pathname === "/v1/messages") {
      state.totalRequests += 1;
      if (state.mode === "401") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "invalid api key" },
        }));
        return;
      }

      const content = Array.isArray(body?.messages?.[0]?.content) ? body.messages[0].content : [];
      const hasImage = content.some((block) => block && block.type === "image");

      if (hasImage) {
        state.analyzeCount += 1;
        const delay = state.mode === "slow" ? 2000 : state.analyzeDelayMs;
        if (delay > 0) await sleep(delay);
        const note = {
          subject: "冷蓝系人像海报",
          style_keywords: ["冷蓝", "高对比", "电影感"],
          palette: [
            { hex: "#1B3A5C", role: "main", name: "深海蓝" },
            { hex: "#D6ECFF", role: "accent", name: "冰白高光" },
          ],
          composition: "竖版人物居中偏下，上方留白",
          camera: "中景平视",
          lighting: "冷色逆光加清晰轮廓光",
          material: "光泽金属与薄雾反射",
          character: "单人主体正面凝视",
          mood_keywords: ["克制", "冷静"],
          prompt_techniques: ["cold rim lighting", "clean silhouette"],
          has_text: false,
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: `msg_ana_${state.analyzeCount}`,
          type: "message",
          role: "assistant",
          model: body?.model || "claude-haiku-5-5",
          content: [
            { type: "thinking", thinking: "inspecting composition and palette" },
            { type: "text", text: JSON.stringify(note) },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 1800, output_tokens: 450 },
        }));
        return;
      }

      // Summary call (SSE stream).
      state.summaryCount += 1;
      const userText = typeof body?.messages?.[0]?.content === "string"
        ? body.messages[0].content
        : content.map((b) => b?.text || "").join("\n");
      const refs = [...new Set([...userText.matchAll(/#(\d+)\b/g)].map((m) => Number(m[1])).filter((n) => n >= 1))];
      const allRefs = refs.length ? refs : [1];
      const subsetRefs = allRefs.length >= 2 ? allRefs.slice(0, 2) : allRefs;
      const version = state.summaryCount;

      const guide = {
        entries: [
          {
            section: "positioning",
            text: version === 1 ? "冷蓝暗调的电影感人像海报风格" : "冷蓝暗调与金属高光结合的视觉风格（第二版）",
            swatches: [],
            sources: allRefs,
          },
          {
            section: "palette",
            text: version === 1 ? "深蓝打底配合冰白高光，整体保持克制偏暗。" : "第二版配色总结：深蓝主调加青白轮廓高光。",
            swatches: [
              { hex: "#1B3A5C", name: "深海蓝" },
              { hex: "#D6ECFF", name: "冰白高光" },
              { hex: "#0E1624", name: "夜色底" },
            ],
            sources: subsetRefs,
          },
          {
            section: "composition",
            text: version === 1 ? "竖版主体居中偏下，画面顶部保留呼吸空间。" : "第二版构图总结：中景竖幅居中，顶部预留标题区。",
            swatches: [],
            sources: allRefs,
          },
          {
            section: "lighting",
            text: version === 1 ? "第一版光线总结：冷色逆光勾勒肩线轮廓，暗部保留细节。" : "第二版光线总结：强化冰蓝边缘光与薄雾体积感。",
            swatches: [],
            sources: allRefs,
          },
        ],
      };

      const textPayload = JSON.stringify(guide);
      const events = [
        {
          type: "message_start",
          message: {
            id: `msg_sum_${version}`,
            type: "message",
            role: "assistant",
            model: body?.model || "claude-sonnet-5-5",
            content: [],
            stop_reason: null,
            usage: { input_tokens: 2400, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: textPayload } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 900 } },
        { type: "message_stop" },
      ];
      const sse = events.map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join("");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse);
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveServer({
        port,
        url: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

async function waitForRendererReady(cdp, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await cdp.evaluate(`({
        readyState: document.readyState,
        appShell: Boolean(document.querySelector('.app')),
        preload: Boolean(window.electronAPI && typeof window.electronAPI.aiLearningQuote === 'function'),
      })`);
      if (state?.readyState === "complete" && state.appShell && state.preload) return;
    } catch {}
    await sleep(150);
  }
  throw new Error("desktop renderer readiness timeout");
}

async function waitFor(cdp, expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await cdp.evaluate(`Boolean(${expression})`)) return;
    } catch {}
    await sleep(150);
  }
  const snapshot = await cdp.evaluate(`(() => ({
    title: document.querySelector('.learn-library-title')?.textContent?.trim() || '',
    footer: document.querySelector('.learn-library-footer')?.textContent?.trim() || '',
    entries: document.querySelectorAll('[data-guide-entry-id]').length,
    logs: document.querySelectorAll('.learn-log-row').length,
    cards: document.querySelectorAll('.asset-card:not(.asset-card-virtual-placeholder)').length,
    dialog: document.querySelector('dialog.ui-dialog[open]')?.textContent?.trim() || '',
    toast: document.querySelector('.toast')?.textContent?.trim() || '',
  }))()`.replace(/\n\s*/g, " ")).catch(() => ({}));
  throw new Error(`timeout waiting for ${label}; state=${JSON.stringify(snapshot)}`);
}

async function centerOf(cdp, elementExpression) {
  const point = await cdp.evaluate(`(() => {
    const el = ${elementExpression};
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!point) throw new Error(`element not found: ${elementExpression}`);
  return point;
}

async function clickCenter(cdp, elementExpression) {
  const point = await centerOf(cdp, elementExpression);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, pointerType: "mouse" });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
}

async function waitForHealthFile(filePath, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const health = JSON.parse(await readFile(filePath, "utf8"));
      if (health?.product === "mosa") return health;
    } catch {}
    await sleep(250);
  }
  throw new Error("desktop health file timeout");
}

async function connectCdp(cdpPort, expectedUrlPrefix, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find((entry) => entry.type === "page" && String(entry.url || "").startsWith(expectedUrlPrefix));
        if (target?.webSocketDebuggerUrl) return openCdpSession(target.webSocketDebuggerUrl);
      }
    } catch {}
    await sleep(200);
  }
  throw new Error(`no desktop CDP target on port ${cdpPort}`);
}

function openCdpSession(url) {
  let idSeq = 0;
  const pending = new Map();
  const socket = new WebSocket(url);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else if (message.result?.exceptionDetails) {
        reject(new Error("evaluate failed: " + (message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text)));
      } else resolve(message.result?.result?.value);
    }
  });
  const ready = new Promise((resolveReady, rejectReady) => {
    socket.addEventListener("open", resolveReady, { once: true });
    socket.addEventListener("error", () => rejectReady(new Error("CDP socket failed")), { once: true });
  });
  return {
    async send(method, params = {}) {
      await ready;
      const id = ++idSeq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      return this.send("Runtime.evaluate", { expression, returnByValue: true });
    },
    close() {
      try { socket.close(); } catch {}
    },
  };
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
