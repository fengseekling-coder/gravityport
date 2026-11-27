// GravityPort desktop flow (task 458): Settings → AI page with the real
// desktop shell (desktop/main.mjs + preload) so the five ai-* IPC channels
// run for real: keys land in the flow-local userData (ai-credentials.json),
// never in the library.
//
// The flow starts two fake services on 127.0.0.1 (one answers GET /v1/models
// with two model ids, one always answers 401 with the fake key quoted — the
// way OpenAI's real 401 does — to prove the response body never surfaces).
// Nothing here talks to any real AI provider.
//
// Round 1: without the entry switch the settings nav has no AI row. Round 2:
// localStorage "gravityport.dev.ai-generation"="1" + reload reveals it. Then
// through the real UI: add an OpenAI-format custom service pointing at the
// 200 server, save the fake key (已保存 · 尾号 5678, input cleared), test the
// connection (连接正常 · 可用 2 个模型), remove the service (key cascades),
// repeat against the 401 server (密钥不对或没有权限（401）), delete the key,
// and finally read ai-credentials.json raw bytes in Node: the fake key must
// not appear anywhere.
import { createServer } from "node:http";
import { readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopGui } from "../desktop-gui-launcher.mjs";
import { ensureElectronExecutablePath } from "../desktop-runtime-paths.mjs";
import { clickAndWait, clickCenter, connectCdp, waitFor as waitForCdp, waitForRendererReady } from "./_cdp.mjs";

export const name = "settings-ai";
export const description = "real desktop shell + real ai-* IPC: nav has no AI without the switch, localStorage switch reveals two-card AI page, add custom service (127.0.0.1 fake) -> save key (尾号 5678, input cleared, auto-test 连接正常 · 可用 2 个模型) -> replace/cancel -> uses card shows auto-selected models & learning-unsupported note -> remove service cascades the key -> 401 server round auto-tests 密钥不对或没有权限（401） and shows image test-failed note -> remove service -> ai-credentials.json bytes never contain the fake key";

const FAKE_KEY = `sk-test-${"0".repeat(30)}5678`;
const FAKE_KEY_BODY = FAKE_KEY.slice("sk-test-".length);

export async function run(ctx) {
  await ctx.prepare();
  const guiRoot = join(ctx.userDataDir, "..", "settings-ai-gui");
  await mkdir(guiRoot, { recursive: true });

  // Two fake services, both strictly on 127.0.0.1, both closed in finally.
  const modelIds = ["flow-model-a", "flow-model-b"];
  const server200 = await startFakeService((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: modelIds.map((id) => ({ id })) }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
  const server401 = await startFakeService((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    // Poisoned with the fake key, like a real OpenAI 401: the UI must never
    // echo this body, so the flow also asserts the status line lacks it.
    res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${FAKE_KEY}.` } }));
  });

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
    // Seed through the desktop service's own staging endpoint: the staged
    // copy lives inside its project roots, which /api/assets/create requires.
    const origin = `http://127.0.0.1:${port}`;
    const pngPath = await ctx.makePng("settings-ai-seed.png", [104, 137, 191]);
    const staged = await fetch(`${origin}/api/import/stage`, {
      method: "POST",
      headers: {
        "content-type": "image/png",
        "x-mosa-file-name": encodeURIComponent("settings-ai-seed.png"),
        "x-mosa-client-token": ctx.token,
      },
      body: await readFile(pngPath),
    });
    if (!staged.ok) throw new Error(`import stage failed (${staged.status})`);
    const { path } = await staged.json();
    await ctx.api(origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath: path,
      prompt: "settings ai seed",
    });
    cdp = await connectCdp(cdpPort, `http://127.0.0.1:${port}`);
    const readyOptions = { ready: "Boolean(window.electronAPI && typeof window.electronAPI.aiGetState === 'function')" };
    await waitForRendererReady(cdp, readyOptions);
    await waitForUi(cdp, `document.querySelectorAll('.asset-card').length === 1`, "seeded gallery");

    // Round 1: no switch — settings nav has no AI row.
    await openSettings(cdp, "settings open");
    const navWithoutSwitch = await cdp.evaluate(`(() => ({
      labels: Array.from(document.querySelectorAll('.settings-nav button')).map((button) => button.textContent.trim()),
      hasAi: Array.from(document.querySelectorAll('.settings-nav button')).some((button) => button.textContent.trim() === 'AI'),
    }))()`);
    if (navWithoutSwitch.hasAi) throw new Error(`switch off but nav shows AI: ${JSON.stringify(navWithoutSwitch.labels)}`);
    await clickCenter(cdp, `document.querySelector('.settings-modal .modal-close')`);
    await waitForUi(cdp, `!document.querySelector('.settings-modal')`, "settings closed");

    // Round 2: set the switch and reload — AI_SETTINGS_ENTRY is evaluated at
    // module load, so the page must reload for it to take effect.
    await cdp.evaluate(`localStorage.setItem('gravityport.dev.ai-generation', '1')`);
    await cdp.evaluate(`location.reload()`);
    await waitForRendererReady(cdp, readyOptions);
    await waitForUi(cdp, `document.querySelectorAll('.asset-card').length === 1`, "gallery after reload");
    await openSettings(cdp, "settings open again");
    await waitForUi(cdp, `Array.from(document.querySelectorAll('.settings-nav button')).some((button) => button.textContent.trim() === 'AI')`, "AI nav row appears");
    await clickCenter(cdp, `Array.from(document.querySelectorAll('.settings-nav button')).find((button) => button.textContent.trim() === 'AI')`);
    await waitForUi(cdp, `Boolean(document.querySelector('.settings-modal .ai-services')) && Boolean(document.querySelector('.settings-modal .ai-uses'))`, "two AI cards (.ai-services and .ai-uses)");
    await waitForUi(cdp,
      `document.querySelector('.ai-services .settings-card-desc')?.textContent.includes('密钥只保存在本机')`,
      "service card privacy line");
    const useRowsMeta = await cdp.evaluate(`Array.from(document.querySelectorAll('.ai-uses .ai-use-row')).map((row) => ({
      role: row.getAttribute('data-role'),
      label: row.querySelector('.ai-use-label')?.textContent?.trim() || '',
      ariaLabel: row.querySelector('.toolbar-select')?.getAttribute('aria-label') || '',
    }))`);
    const expectedUseRows = [
      { role: "analysis", label: "逐张分析", ariaLabel: "逐张分析" },
      { role: "summary", label: "汇总手册", ariaLabel: "汇总手册" },
      { role: "brain", label: "对话大脑", ariaLabel: "对话大脑" },
      { role: "image", label: "出图", ariaLabel: "出图" },
    ];
    if (JSON.stringify(useRowsMeta) !== JSON.stringify(expectedUseRows)) {
      throw new Error(`unexpected use rows: ${JSON.stringify(useRowsMeta)}`);
    }

    // --- Round 3: custom service -> save key -> auto-test OK ---
    const fakeKeyRecord = { savedShown: false, inputCleared: false, autoTestOk: false, testMessage: null };
    const addedServiceId = await addCustomService(cdp, `http://127.0.0.1:${server200.port}/v1`);
    await saveKey(cdp, FAKE_KEY);
    await waitForUi(cdp,
      `document.querySelector('.ai-service-row[data-service-id="${addedServiceId}"]')?.textContent?.includes('尾号 5678')`,
      "尾号 5678 on service row");
    fakeKeyRecord.savedShown = true;
    // 保存后不点任何按钮，自动测试连接。
    await waitForUi(cdp,
      `document.querySelector('.ai-service-row[data-service-id="${addedServiceId}"] .ai-status-line')?.textContent?.includes('连接正常 · 可用 2 个模型')`,
      "auto-test connection ok line");
    fakeKeyRecord.autoTestOk = true;
    const inputsAfterSave = await cdp.evaluate(`Array.from(document.querySelectorAll('.ai-key-input')).map((el) => el.value)`);
    if (inputsAfterSave.some((value) => value !== "")) {
      throw new Error(`save succeeded but a key input still holds text: ${JSON.stringify(inputsAfterSave)}`);
    }
    const okLine = await cdp.evaluate(`Array.from(document.querySelectorAll('.ai-status-line')).map((el) => el.textContent.trim()).join(' | ')`);
    if (okLine.includes(FAKE_KEY)) throw new Error(`status line leaks the fake key: ${okLine}`);
    fakeKeyRecord.testMessage = okLine;
    console.log(`[e2e] settings-ai auto-test ok (no button clicked): ${okLine}`);

    // 点「更换」→ 密码框重新出现且是空值 → 点「取消」回到平时。
    await clickCenter(cdp, `Array.from(document.querySelectorAll('.ai-service-row[data-service-id="${addedServiceId}"] .ai-service-actions .settings-action-btn')).find((el) => el.textContent.trim() === '更换')`);
    await waitForUi(cdp, `Boolean(document.querySelector('.ai-service-row[data-service-id="${addedServiceId}"] .ai-key-input'))`, "更换 reopens the key input");
    const reopened = await cdp.evaluate(`Array.from(document.querySelectorAll('.ai-key-input')).map((el) => el.value)`);
    if (reopened.length < 1 || reopened.some((value) => value !== "")) {
      throw new Error(`reopened key inputs not all empty: ${JSON.stringify(reopened)}`);
    }
    fakeKeyRecord.inputCleared = true;
    await clickCenter(cdp, `Array.from(document.querySelectorAll('.ai-service-row[data-service-id="${addedServiceId}"] .settings-action-btn')).find((el) => el.textContent.trim() === '取消')`);
    await waitForUi(cdp, `!document.querySelector('.ai-service-row[data-service-id="${addedServiceId}"] .ai-key-input')`, "取消 returns service row to normal");

    // 用途卡：逐张分析、对话大脑、出图三行都显示 Flow 假服务的模型，且逐张分析行提示学习不支持。
    const useDisplays = await cdp.evaluate(`({
      analysis: document.querySelector('.ai-use-row[data-role="analysis"] .toolbar-select > span')?.textContent?.trim() || '',
      summary: document.querySelector('.ai-use-row[data-role="summary"] .toolbar-select > span')?.textContent?.trim() || '',
      brain: document.querySelector('.ai-use-row[data-role="brain"] .toolbar-select > span')?.textContent?.trim() || '',
      image: document.querySelector('.ai-use-row[data-role="image"] .toolbar-select > span')?.textContent?.trim() || '',
      analysisNote: document.querySelector('.ai-use-row[data-role="analysis"] .ai-note')?.textContent?.trim() || '',
    })`);
    for (const role of ["analysis", "brain", "image"]) {
      if (!useDisplays[role] || useDisplays[role] === "未选择" || !useDisplays[role].includes("Flow 假服务")) {
        throw new Error(`use row ${role} did not show Flow 假服务 model: ${JSON.stringify(useDisplays)}`);
      }
    }
    if (!useDisplays.analysisNote.includes("学习暂时只支持 Claude")) {
      throw new Error(`analysis row missing learning-unsupported note: ${JSON.stringify(useDisplays)}`);
    }
    // 任务 476：OpenAI 格式服务下，学习两行以及对话大脑、出图均不得出现推理强度下拉。
    const openaiEffortCounts = await cdp.evaluate(`({
      analysis: document.querySelectorAll('.ai-use-row[data-role="analysis"] .ai-effort-group').length,
      summary: document.querySelectorAll('.ai-use-row[data-role="summary"] .ai-effort-group').length,
      brain: document.querySelectorAll('.ai-use-row[data-role="brain"] .ai-effort-group').length,
      image: document.querySelectorAll('.ai-use-row[data-role="image"] .ai-effort-group').length,
    })`);
    if (openaiEffortCounts.analysis !== 0 || openaiEffortCounts.summary !== 0 || openaiEffortCounts.brain !== 0 || openaiEffortCounts.image !== 0) {
      throw new Error(`OpenAI custom service should have zero effort selects: ${JSON.stringify(openaiEffortCounts)}`);
    }

    // --- Round 4: 更换 → 删除此服务 (key cascades, uses fall back to 未选择) ---
    await clickCenter(cdp, `Array.from(document.querySelectorAll('.ai-service-row[data-service-id="${addedServiceId}"] .ai-service-actions .settings-action-btn')).find((el) => el.textContent.trim() === '更换')`);
    await waitForUi(cdp, `Boolean(document.querySelector('.ai-service-row[data-service-id="${addedServiceId}"] .ai-danger-link'))`, "删除此服务 visible");
    await clickCenter(cdp, `document.querySelector('.ai-service-row[data-service-id="${addedServiceId}"] .ai-danger-link')`);
    await waitForUi(cdp, `!document.querySelector('.ai-service-row[data-service-id="${addedServiceId}"]')`, "service row removed");
    await waitForUi(cdp,
      `Array.from(document.querySelectorAll('.ai-uses .ai-use-row .toolbar-select > span')).every((el) => el.textContent.trim() === '未选择')`,
      "all four uses fall back to 未选择");
    const credsAfterRemove = await readFile(join(ctx.userDataDir, "ai-credentials.json"), "utf8");
    if (credsAfterRemove.includes(addedServiceId)) {
      throw new Error(`ai-credentials.json still references removed service ${addedServiceId}`);
    }

    // --- Round 5: 401 service -> save key -> auto-test fails -> image row shows test-failed note ---
    const failingServiceId = await addCustomService(cdp, `http://127.0.0.1:${server401.port}/v1`);
    await saveKey(cdp, FAKE_KEY);
    await waitForUi(cdp,
      `document.querySelector('.ai-service-row[data-service-id="${failingServiceId}"]')?.textContent?.includes('尾号 5678')`,
      "401 service key saved");
    await waitForUi(cdp,
      `document.querySelector('.ai-service-row[data-service-id="${failingServiceId}"] .ai-status-line')?.textContent?.includes('密钥不对或没有权限（401）')`,
      "401 auto-test failure line");
    const failLine = await cdp.evaluate(`Array.from(document.querySelectorAll('.ai-status-line')).map((el) => el.textContent.trim()).join(' | ')`);
    if (failLine.includes(FAKE_KEY) || failLine.includes("Incorrect API key")) {
      throw new Error(`failure line leaks the response body: ${failLine}`);
    }
    await waitForUi(cdp,
      `document.querySelector('.ai-use-row[data-role="image"] .ai-note')?.textContent?.includes('Flow 假服务 最近一次测试没通过')`,
      "image row shows test-failed note");

    // --- Round 6: 更换 → 删除此服务 (equivalent to deleting key) -> raw byte check ---
    await clickCenter(cdp, `Array.from(document.querySelectorAll('.ai-service-row[data-service-id="${failingServiceId}"] .ai-service-actions .settings-action-btn')).find((el) => el.textContent.trim() === '更换')`);
    await waitForUi(cdp, `Boolean(document.querySelector('.ai-service-row[data-service-id="${failingServiceId}"] .ai-danger-link'))`, "删除此服务 visible on 401 service");
    await clickCenter(cdp, `document.querySelector('.ai-service-row[data-service-id="${failingServiceId}"] .ai-danger-link')`);
    await waitForUi(cdp, `!document.querySelector('.ai-service-row[data-service-id="${failingServiceId}"]')`, "401 service removed");

    // --- Round 7 (task 476): Claude-format custom service -> effort dropdowns, persistence, out-of-catalog fallback ---
    const serverClaude = await startFakeService((req, res) => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "claude-haiku-5-5" }, { id: "claude-custom-ext" }] }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
    try {
      const claudeServiceId = await addCustomClaudeService(cdp, serverClaude.url);
      await saveKey(cdp, FAKE_KEY);
      await waitForUi(cdp,
        `document.querySelector('.ai-service-row[data-service-id="${claudeServiceId}"] .ai-status-line')?.textContent?.includes('连接正常 · 可用 2 个模型')`,
        "Claude custom service auto-test ok");

      // 学习两行出现推理强度下拉，对话大脑与出图任何时候都没有。
      await waitForUi(cdp,
        `Boolean(document.querySelector('.ai-use-row[data-role="analysis"] .ai-effort-group .toolbar-select')) && Boolean(document.querySelector('.ai-use-row[data-role="summary"] .ai-effort-group .toolbar-select'))`,
        "analysis and summary effort selects appear for Claude service");
      const claudeEffortPresence = await cdp.evaluate(`({
        analysisText: document.querySelector('.ai-use-row[data-role="analysis"] .ai-effort-group .toolbar-select > span')?.textContent?.trim() || '',
        summaryText: document.querySelector('.ai-use-row[data-role="summary"] .ai-effort-group .toolbar-select > span')?.textContent?.trim() || '',
        brainCount: document.querySelectorAll('.ai-use-row[data-role="brain"] .ai-effort-group').length,
        imageCount: document.querySelectorAll('.ai-use-row[data-role="image"] .ai-effort-group').length,
      })`);
      if (claudeEffortPresence.analysisText !== "推理强度：低（默认）") {
        throw new Error(`unexpected initial analysis effort text: ${JSON.stringify(claudeEffortPresence)}`);
      }
      if (claudeEffortPresence.summaryText !== "推理强度：中（默认）") {
        throw new Error(`unexpected initial summary effort text: ${JSON.stringify(claudeEffortPresence)}`);
      }
      if (claudeEffortPresence.brainCount !== 0 || claudeEffortPresence.imageCount !== 0) {
        throw new Error(`brain/image must never show effort select: ${JSON.stringify(claudeEffortPresence)}`);
      }

      // 选「高」→ 出现「比默认多想，这一步花费约 ×4」→ 关掉设置再打开仍是「高」。
      await clickCenter(cdp, `document.querySelector('.ai-use-row[data-role="analysis"] .ai-effort-group .toolbar-select')`);
      await waitForUi(cdp,
        `document.querySelectorAll('.toolbar-select-menu .toolbar-select-option').length === 5`,
        "Haiku 5.5 offers 5 effort options");
      await clickCenter(cdp,
        `Array.from(document.querySelectorAll('.toolbar-select-menu .toolbar-select-option')).find((el) => el.textContent.trim() === '高')`);
      await waitForUi(cdp,
        `document.querySelector('.ai-use-row[data-role="analysis"] .ai-effort-group .toolbar-select > span')?.textContent?.trim() === '推理强度：高' && (document.querySelector('.ai-use-row[data-role="analysis"] .ai-effort-hint')?.textContent?.trim() || '') === '比默认多想，这一步花费约 ×4'`,
        "analysis effort high shows 4x cost hint");

      await clickCenter(cdp, `document.querySelector('.settings-modal .modal-close')`);
      await waitForUi(cdp, `!document.querySelector('.settings-modal')`, "settings closed after setting effort high");
      await openSettings(cdp, "settings reopened to check persisted effort");
      await waitForUi(cdp, `Array.from(document.querySelectorAll('.settings-nav button')).some((button) => button.textContent.trim() === 'AI')`, "AI nav row on reopen");
      await clickCenter(cdp, `Array.from(document.querySelectorAll('.settings-nav button')).find((button) => button.textContent.trim() === 'AI')`);
      await waitForUi(cdp,
        `document.querySelector('.ai-use-row[data-role="analysis"] .ai-effort-group .toolbar-select > span')?.textContent?.trim() === '推理强度：高' && (document.querySelector('.ai-use-row[data-role="analysis"] .ai-effort-hint')?.textContent?.trim() || '') === '比默认多想，这一步花费约 ×4'`,
        "analysis effort high persisted across reopen");

      // 先选「很高」（仅五档模型支持），再把逐张分析换成表外模型 claude-custom-ext → 只剩三档、档位回到「低（默认）」。
      await clickCenter(cdp, `document.querySelector('.ai-use-row[data-role="analysis"] .ai-effort-group .toolbar-select')`);
      await waitForUi(cdp,
        `Array.from(document.querySelectorAll('.toolbar-select-menu .toolbar-select-option')).some((el) => el.textContent.trim() === '很高')`,
        "xhigh option visible");
      await clickCenter(cdp,
        `Array.from(document.querySelectorAll('.toolbar-select-menu .toolbar-select-option')).find((el) => el.textContent.trim() === '很高')`);
      await waitForUi(cdp,
        `document.querySelector('.ai-use-row[data-role="analysis"] .ai-effort-group .toolbar-select > span')?.textContent?.trim() === '推理强度：很高'`,
        "analysis effort set to xhigh");

      await clickCenter(cdp, `document.querySelector('.ai-use-row[data-role="analysis"] .toolbar-select')`);
      await waitForUi(cdp,
        `Array.from(document.querySelectorAll('.toolbar-select-menu .toolbar-select-option')).some((el) => el.textContent.includes('claude-custom-ext'))`,
        "out-of-catalog claude-custom-ext option visible");
      await clickCenter(cdp,
        `Array.from(document.querySelectorAll('.toolbar-select-menu .toolbar-select-option')).find((el) => el.textContent.includes('claude-custom-ext'))`);
      await waitForUi(cdp,
        `document.querySelector('.ai-use-row[data-role="analysis"] .ai-effort-group .toolbar-select > span')?.textContent?.trim() === '推理强度：低（默认）' && !document.querySelector('.ai-use-row[data-role="analysis"] .ai-effort-hint')`,
        "switching to out-of-catalog model resets unsupported xhigh back to 低（默认）");

      await clickCenter(cdp, `document.querySelector('.ai-use-row[data-role="analysis"] .ai-effort-group .toolbar-select')`);
      await waitForUi(cdp,
        `document.querySelectorAll('.toolbar-select-menu .toolbar-select-option').length === 3`,
        "out-of-catalog Claude model offers exactly 3 effort options");
      const extOptions = await cdp.evaluate(`Array.from(document.querySelectorAll('.toolbar-select-menu .toolbar-select-option')).map((el) => el.textContent.trim())`);
      if (JSON.stringify(extOptions) !== JSON.stringify(["低（默认）", "中", "高"])) {
        throw new Error(`unexpected out-of-catalog effort options: ${JSON.stringify(extOptions)}`);
      }
      await clickCenter(cdp, `document.querySelector('.toolbar-select-menu .toolbar-select-option')`);
      await waitForUi(cdp, `!document.querySelector('.toolbar-select-menu')`, "effort menu closed");

      // 收尾删掉 Claude 假服务。
      await clickCenter(cdp, `Array.from(document.querySelectorAll('.ai-service-row[data-service-id="${claudeServiceId}"] .ai-service-actions .settings-action-btn')).find((el) => el.textContent.trim() === '更换')`);
      await waitForUi(cdp, `Boolean(document.querySelector('.ai-service-row[data-service-id="${claudeServiceId}"] .ai-danger-link'))`, "删除此服务 visible on Claude service");
      await clickCenter(cdp, `document.querySelector('.ai-service-row[data-service-id="${claudeServiceId}"] .ai-danger-link')`);
      await waitForUi(cdp, `!document.querySelector('.ai-service-row[data-service-id="${claudeServiceId}"]')`, "Claude custom service removed");
    } finally {
      await serverClaude.close();
    }

    // Final byte check on the real userData file: the fake key survives nowhere.
    const credentialPath = join(ctx.userDataDir, "ai-credentials.json");
    const raw = await readFile(credentialPath, "utf8");
    if (raw.includes(FAKE_KEY) || raw.includes(FAKE_KEY_BODY)) {
      throw new Error(`ai-credentials.json contains the fake key (raw bytes): ${JSON.stringify(raw.slice(0, 400))}`);
    }
    const settingsRaw = await readFile(join(ctx.userDataDir, "ai-settings.json"), "utf8");
    if (settingsRaw.includes(FAKE_KEY)) throw new Error("ai-settings.json contains the fake key");

    console.log(`[e2e] flow ${name} ok: ${JSON.stringify({ ...fakeKeyRecord, services: server200.url, failing: server401.url })}`);
    return;
  } finally {
    if (cdp) cdp.close();
    if (waiter.exitCode === null) waiter.kill("SIGTERM");
    await server200.close();
    await server401.close();
    await rm(guiRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function addCustomService(cdp, baseUrl) {
  await waitForUi(
    cdp,
    `Boolean(document.querySelector('.ai-add-select .toolbar-select')) || Array.from(document.querySelectorAll('.ai-quick-add .settings-action-btn')).some((el) => el.textContent.includes('其它服务'))`,
    "add-service trigger ready",
  );
  const hasHeaderSelect = await cdp.evaluate(`Boolean(document.querySelector('.ai-add-select .toolbar-select'))`);
  if (hasHeaderSelect) {
    await clickCenter(cdp, `document.querySelector('.ai-add-select .toolbar-select')`);
    await waitForUi(cdp, `Array.from(document.querySelectorAll('.toolbar-select-menu .toolbar-select-option')).some((el) => el.textContent.includes('其它服务'))`, "other-service option");
    await clickCenter(cdp, `Array.from(document.querySelectorAll('.toolbar-select-menu .toolbar-select-option')).find((el) => el.textContent.includes('其它服务'))`);
  } else {
    await clickCenter(cdp, `Array.from(document.querySelectorAll('.ai-quick-add .settings-action-btn')).find((el) => el.textContent.includes('其它服务'))`);
  }
  await waitForUi(cdp, `Boolean(document.querySelector('.ai-add-form'))`, "add form open");
  await clickCenter(cdp, `document.querySelector('.ai-add-form input.ai-text-input')`);
  await cdp.send("Input.insertText", { text: "Flow 假服务" });
  await clickCenter(cdp, `document.querySelector('.ai-add-form input[type="url"]')`);
  await cdp.send("Input.insertText", { text: baseUrl });
  await clickCenter(cdp, `Array.from(document.querySelectorAll('.ai-add-actions .settings-action-btn')).find((el) => el.textContent.trim() === '添加')`);
  await waitForUi(cdp, `!document.querySelector('.ai-add-form')`, "add form closed");
  await waitForUi(cdp,
    `Boolean(document.querySelector('.ai-service-row.editing[data-service-id] .ai-key-input')) && document.activeElement === document.querySelector('.ai-service-row.editing[data-service-id] .ai-key-input')`,
    "custom service row appears in edit mode with focus in password input");
  const serviceId = await cdp.evaluate(`document.querySelector('.ai-service-row.editing[data-service-id]')?.getAttribute('data-service-id') || ''`);
  if (!serviceId) throw new Error("custom service row missing data-service-id");
  return serviceId;
}

async function addCustomClaudeService(cdp, baseUrl) {
  await waitForUi(
    cdp,
    `Boolean(document.querySelector('.ai-add-select .toolbar-select')) || Array.from(document.querySelectorAll('.ai-quick-add .settings-action-btn')).some((el) => el.textContent.includes('其它服务'))`,
    "add-claude-service trigger ready",
  );
  const hasHeaderSelect = await cdp.evaluate(`Boolean(document.querySelector('.ai-add-select .toolbar-select'))`);
  if (hasHeaderSelect) {
    await clickCenter(cdp, `document.querySelector('.ai-add-select .toolbar-select')`);
    await waitForUi(cdp, `Array.from(document.querySelectorAll('.toolbar-select-menu .toolbar-select-option')).some((el) => el.textContent.includes('其它服务'))`, "other-service option (claude)");
    await clickCenter(cdp, `Array.from(document.querySelectorAll('.toolbar-select-menu .toolbar-select-option')).find((el) => el.textContent.includes('其它服务'))`);
  } else {
    await clickCenter(cdp, `Array.from(document.querySelectorAll('.ai-quick-add .settings-action-btn')).find((el) => el.textContent.includes('其它服务'))`);
  }
  await waitForUi(cdp, `Boolean(document.querySelector('.ai-add-form'))`, "add form open (claude)");
  await clickCenter(cdp, `document.querySelector('.ai-add-form input.ai-text-input')`);
  await cdp.send("Input.insertText", { text: "Flow Claude 假服务" });
  await clickCenter(cdp, `Array.from(document.querySelectorAll('.ai-add-form .segmented button')).find((el) => el.textContent.includes('Claude'))`);
  await clickCenter(cdp, `document.querySelector('.ai-add-form input[type="url"]')`);
  await cdp.send("Input.insertText", { text: baseUrl });
  await clickCenter(cdp, `Array.from(document.querySelectorAll('.ai-add-actions .settings-action-btn')).find((el) => el.textContent.trim() === '添加')`);
  await waitForUi(cdp, `!document.querySelector('.ai-add-form')`, "add form closed (claude)");
  await waitForUi(cdp,
    `Boolean(document.querySelector('.ai-service-row.editing[data-service-id] .ai-key-input')) && document.activeElement === document.querySelector('.ai-service-row.editing[data-service-id] .ai-key-input')`,
    "Claude custom service row appears in edit mode");
  const serviceId = await cdp.evaluate(`document.querySelector('.ai-service-row.editing[data-service-id]')?.getAttribute('data-service-id') || ''`);
  if (!serviceId) throw new Error("Claude custom service row missing data-service-id");
  return serviceId;
}

async function saveKey(cdp, key) {
  await clickCenter(cdp, `document.querySelector('.ai-service-row.editing .ai-key-input')`);
  await cdp.send("Input.insertText", { text: key });
  await clickCenter(cdp, `Array.from(document.querySelectorAll('.ai-service-row.editing .settings-action-btn')).find((el) => el.textContent.trim() === '保存')`);
}

const SETTINGS_AI_SCENE = `(() => ({
  nav: Array.from(document.querySelectorAll('.settings-nav button')).map((button) => button.textContent.trim()),
  hasServices: Boolean(document.querySelector('.ai-services')),
  hasUses: Boolean(document.querySelector('.ai-uses')),
  serviceRows: Array.from(document.querySelectorAll('.ai-service-row')).map((el) => el.textContent.trim()),
  status: Array.from(document.querySelectorAll('.ai-status-line')).map((el) => el.textContent.trim()),
  selects: Array.from(document.querySelectorAll('.ai-uses .toolbar-select > span')).map((el) => el.textContent.trim()),
  notes: Array.from(document.querySelectorAll('.ai-uses .ai-note')).map((el) => el.textContent.trim()),
  errors: Array.from(document.querySelectorAll('.ai-error-line')).map((el) => el.textContent.trim()),
}))()`;

async function waitForUi(cdp, expression, label, timeoutMs = 20000) {
  await waitForCdp(cdp, expression, label, { timeoutMs, scene: SETTINGS_AI_SCENE });
}

// 刷新后左下角的用户按钮要等它真能接住点击再点：PR #357 第四轮 macOS CI
// 在刷新后点了一下、设置窗口没开，单点一次又不核对，只剩一句超时。先等它
// 看得见、中心点落在它自己身上；点了 3 秒没开，记下点上去的是什么再点一次。
async function openSettings(cdp, label) {
  await clickAndWait(
    cdp,
    `document.querySelector('.user-button')`,
    `Boolean(document.querySelector('.settings-modal'))`,
    label,
    {
      retryOnce: "刷新后左下角的用户按钮可能没接住第一次点击（PR #357 第四轮 macOS CI），3 秒未开记下 hit 后再点一次",
      scene: SETTINGS_AI_SCENE,
      // 旧写法点之前先等按钮可点最多 20 秒；pointOf 默认只给 5 秒，刷新慢的 CI 机上会先挂。
      clickTimeoutMs: 20000,
    },
  );
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

function startFakeService(handler) {
  return new Promise((resolveService) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveService({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
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
