// GravityPort React UI flow (task 313): Settings → 连接 → AI assistants (MCP)
// card. The desktop main process returns ready-to-paste configs for three
// assistants; the card shows the selected one and copies it through
// electronAPI.writeClipboardText.
//
// The flow injects a two-method fake electronAPI (getMcpClientConfig +
// writeClipboardText) BEFORE the settings modal opens. With the fake write
// in place a copy can never fall through to navigator.clipboard and touch
// the developer's real system clipboard; the fake config comes from
// lib/mcp-client-config.mjs on the Node side with every path pointed at a
// nonexistent flow-local location, so rendering and copying touch nothing on
// the machine.
//
// One ctx.runInPage call is one fresh page load, so the installWarning and
// available:false variants are separate rounds that re-inject the fake and
// reopen settings from scratch. The English round switches the interface
// language on the settings 常规 page (the viewer-fullscreen pattern) and then
// walks the same card with English copy. Known product shape, not fixed
// here: the card has no edit/save — select, read, copy is all it does.
import { join } from "node:path";
import { buildMcpClientConfig } from "../../lib/mcp-client-config.mjs";

export const name = "settings-mcp-config";
export const description = "Settings → 连接 MCP card: three assistants with per-client pre/code/hint -> Codex copy hits the fake clipboard once, switch clears 已复制 at once, button auto-resets in ~2s -> installWarning banner -> available:false leaves only the guide link (not clicked) -> English round";

const CLIENT_IDS = ["claudeDesktop", "claudeCode", "codex"];
const CLIENT_LABELS = ["Claude Desktop", "Claude Code", "Codex"];
const LABEL_BY_ID = { claudeDesktop: "Claude Desktop", claudeCode: "Claude Code", codex: "Codex" };

// The card's copy, pinned in both languages (zh source strings from
// McpClientConfigCard.tsx, en from web/gravityport/src/i18n.ts).
const ZH_HINTS = {
  claudeDesktop: "粘贴到 claude_desktop_config.json（Claude 设置 → 开发者 → 编辑配置）。里面已有 mcpServers 的，只把 gravityport 这一段并进去。",
  claudeCode: "在终端里运行这条命令。",
  codex: "粘贴到 ~/.codex/config.toml 末尾。",
};
const EN_HINTS = {
  claudeDesktop: "Paste into claude_desktop_config.json (Claude Settings → Developer → Edit Config). If it already has mcpServers, add just the gravityport entry.",
  claudeCode: "Run this command in a terminal.",
  codex: "Add this to the end of ~/.codex/config.toml.",
};
const ZH_WARNING = "请先把 GravityPort 拖进「应用程序」文件夹再复制，不然这段路径会失效。";
const ZH_NOTE = "挪了素材库也不用改配置，重启 AI 助手就会跟过去。GravityPort 不用开着。";
const EN_NOTE = "Moved your library? No need to change this: restart the assistant and it follows. GravityPort doesn't need to be open.";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath: await ctx.makePng("mcp-config-seed.png", [74, 127, 181]),
      prompt: "mcp config seed",
    });

    // The config the desktop main process would return, with every path
    // pointed at a flow-local location. Strings only — the builder never
    // touches the filesystem, so nothing exists to read or overwrite.
    const config = buildMcpClientConfig({
      platform: process.platform,
      execPath: join(ctx.rootDir, "flow-local", "GravityPort"),
      serverPath: join(ctx.rootDir, "flow-local", "mcp", "server.mjs"),
      libraryLocationFile: join(ctx.rootDir, "flow-local", "library-location.json"),
    });

    // Round 1 (Chinese, available): the full selection and copy walk.
    const zh = await ctx.runInPage(server, cardSource({ config, platform: process.platform, installWarning: null }));
    assertEqual(zh.clientLabels, CLIENT_LABELS, "three assistant buttons");
    assertEqual(zh.classes, ["on", "", ""], "selected assistant button carries the on class");
    assertEqual(zh.initial.pressed, "Claude Desktop", "Claude Desktop pressed by default");
    assertEqual(zh.initial.attr, "claudeDesktop", "default pre[data-mcp-client]");
    assertEqual(zh.initial.code, config.claudeDesktop, "default code text");
    assertEqual(zh.initial.hint, ZH_HINTS.claudeDesktop, "default hint");
    for (const id of ["claudeCode", "codex"]) {
      assertEqual(zh.clients[id].attr, id, `${id} pre[data-mcp-client]`);
      assertEqual(zh.clients[id].code, config[id], `${id} code text`);
      assertEqual(zh.clients[id].hint, ZH_HINTS[id], `${id} hint`);
      assertEqual(zh.clients[id].pressed, LABEL_BY_ID[id], `${id} pressed`);
    }
    assertEqual(zh.note, ZH_NOTE, "library-move note");
    assertEqual(zh.copy.copiedAfterFirst, [config.codex], "first copy reaches the fake clipboard alone");
    assertEqual(zh.copy.switchClearedImmediately, true, "switching assistants clears 已复制 at once");
    assertEqual(zh.copy.afterSwitch.attr, "claudeDesktop", "switch lands back on claudeDesktop");
    assertEqual(zh.copy.afterSwitch.hint, ZH_HINTS.claudeDesktop, "hint follows the switch");
    assertOk(zh.copy.resetWaitMs >= 1000 && zh.copy.resetWaitMs <= 3000, `copied state auto-resets in ~2s (took ${zh.copy.resetWaitMs}ms)`);
    assertEqual(zh.copy.copiedFinal, [config.codex, config.codex], "every copy sent the Codex section");

    // Round 2: installWarning — a fresh page with the warning variant.
    const warned = await ctx.runInPage(server, warningSource({ config, platform: process.platform }));
    assertEqual(warned.warningText, ZH_WARNING, "install warning copy");
    assertEqual(warned.warningRole, "alert", "install warning role");

    // Round 3: available:false — only the guide link remains; the flow never
    // clicks it (it would leave the app for an external page).
    const off = await ctx.runInPage(server, unavailableSource());
    assertEqual(off.hasClientButtons, false, "no assistant buttons when unavailable");
    assertEqual(off.hasCopyButton, false, "no copy button when unavailable");
    assertEqual(off.hasPre, false, "no config block when unavailable");
    assertEqual(off.hasWarning, false, "no install warning when unavailable");
    assertOk(typeof off.linkHref === "string" && off.linkHref.startsWith("https://github.com/") && off.linkHref.includes("guide"), `guide link points at the guide (${off.linkHref})`);

    // Round 4: English — language switched on the 常规 page, same walk.
    const en = await ctx.runInPage(server, englishSource({ config, platform: process.platform }));
    assertEqual(en.ariaLabel, "AI assistants (MCP)", "English card label");
    assertEqual(en.clientLabels, CLIENT_LABELS, "English assistant buttons");
    assertEqual(en.initial.pressed, "Claude Desktop", "English default assistant");
    assertEqual(en.initial.attr, "claudeDesktop", "English default pre[data-mcp-client]");
    assertEqual(en.initial.code, config.claudeDesktop, "English default code text");
    assertEqual(en.initial.hint, EN_HINTS.claudeDesktop, "English default hint");
    for (const id of ["claudeCode", "codex"]) {
      assertEqual(en.clients[id].code, config[id], `English ${id} code text`);
      assertEqual(en.clients[id].hint, EN_HINTS[id], `English ${id} hint`);
    }
    assertEqual(en.copyLabel, "Copy", "English copy button");
    assertEqual(en.note, EN_NOTE, "English library-move note");

    return { copied: zh.copy.copiedFinal.length, resetWaitMs: zh.copy.resetWaitMs, warningShown: warned.warningText === ZH_WARNING, guideOnly: off.linkHref !== null, english: en.ariaLabel === "AI assistants (MCP)" };
  } finally {
    await server.stop();
  }
}

function assertEqual(actual, expected, label) {
  const same = actual === expected || JSON.stringify(actual) === JSON.stringify(expected);
  if (!same) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertOk(condition, label) {
  if (!condition) throw new Error(label);
}

function pagePrelude() {
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
    const navButton = (label) => Array.from(document.querySelectorAll('.settings-nav button'))
      .find((button) => button.textContent.trim() === label) || null;
    const clientButtons = () => Array.from(document.querySelectorAll('.mcp-config-clients button'));
    const clientButton = (label) => clientButtons().find((button) => button.textContent.trim() === label) || null;
    const mcpPre = () => document.querySelector('.mcp-config-card pre[data-mcp-client]');
    const selectedId = () => mcpPre()?.getAttribute('data-mcp-client') ?? null;
    const codeText = () => document.querySelector('.mcp-config-card pre code')?.textContent ?? null;
    const hintText = () => document.querySelector('.mcp-config-hint')?.textContent ?? null;
    const copyButton = () => document.querySelector('.mcp-config-copy-button');
    const cardState = () => ({
      attr: selectedId(),
      code: codeText(),
      hint: hintText(),
      pressed: clientButtons().find((b) => b.getAttribute('aria-pressed') === 'true')?.textContent.trim() ?? null,
    });
`;
}

// The fake desktop bridge, injected before the settings modal opens: the card
// reads getMcpClientConfig at mount and copies through writeClipboardText, so
// with the fake write in place the real system clipboard is never reachable.
function fakeBridge({ config, platform, installWarning, available }) {
  const getConfig = available
    ? `async () => ({ available: true, platform: ${JSON.stringify(platform)}, installWarning: ${JSON.stringify(installWarning)}, ...${JSON.stringify(config)} })`
    : "async () => ({ available: false })";
  return `
    window.electronAPI = {
      getMcpClientConfig: ${getConfig},
      writeClipboardText: async (text) => { (window.__copied = window.__copied || []).push(text); return { ok: true }; },
    };
`;
}

function openConnectionPage(navLabel) {
  return `
    async function openConnectionPage() {
      await waitFor(() => document.querySelector('.app') && document.querySelectorAll('.asset-card').length === 1, 'seeded gallery');
      document.querySelector('.user-button').click();
      await waitFor(() => document.querySelector('.settings-modal'), 'settings open');
      const nav = navButton(${JSON.stringify(navLabel)});
      if (!nav) throw new Error('settings nav ' + ${JSON.stringify(navLabel)} + ' missing: ' + Array.from(document.querySelectorAll('.settings-nav button')).map((b) => b.textContent.trim()).join('|'));
      nav.click();
      await waitFor(() => document.querySelector('.settings-modal .mcp-config-card'), 'MCP config card on the connections page');
    }
`;
}

function cardSource({ config, platform, installWarning }) {
  return `(async () => {
    ${pagePrelude()}
    ${fakeBridge({ config, platform, installWarning, available: true })}
    ${openConnectionPage("连接")}

    await openConnectionPage();

    const clientLabels = clientButtons().map((b) => b.textContent.trim());
    const classes = clientButtons().map((b) => b.className);
    const initial = cardState();

    const clients = {};
    for (const [label, id] of [['Claude Code', 'claudeCode'], ['Codex', 'codex']]) {
      clientButton(label).click();
      await waitFor(() => selectedId() === id, id + ' selected');
      clients[id] = cardState();
    }

    // Copy the Codex section: the fake writeClipboardText records exactly
    // what the card sent, the button flips to 已复制, and the reset timer
    // brings 复制 back within ~2s.
    copyButton().click();
    await waitFor(() => copyButton()?.textContent.trim() === '已复制', 'copied state shows');
    const copiedAfterFirst = (window.__copied || []).slice();

    // Switch assistant while 已复制 is up: the reset timer would fire ~2s
    // after the copy click, so a 复制 read ~150ms after the switch can only
    // come from the switch itself clearing the copied state.
    clientButton('Claude Desktop').click();
    await waitFor(() => selectedId() === 'claudeDesktop', 'claudeDesktop re-selected');
    await sleep(150);
    const switchClearedImmediately = copyButton()?.textContent.trim() === '复制';
    const afterSwitch = cardState();

    clientButton('Codex').click();
    await waitFor(() => selectedId() === 'codex', 'codex selected again');
    copyButton().click();
    await waitFor(() => copyButton()?.textContent.trim() === '已复制', 'second copied state shows');
    const copiedShownAt = Date.now();
    await waitFor(() => copyButton()?.textContent.trim() === '复制', 'copied state auto-resets', 3000);
    const resetWaitMs = Date.now() - copiedShownAt;

    return {
      clientLabels,
      classes,
      initial,
      clients,
      note: document.querySelector('.mcp-config-card .mcp-config-note')?.textContent.trim() ?? null,
      copy: {
        copiedAfterFirst,
        switchClearedImmediately,
        afterSwitch,
        resetWaitMs,
        copiedFinal: (window.__copied || []).slice(),
      },
    };
  })()
  `;
}

function warningSource({ config, platform }) {
  return `(async () => {
    ${pagePrelude()}
    ${fakeBridge({ config, platform, installWarning: "not-in-applications", available: true })}
    ${openConnectionPage("连接")}

    await openConnectionPage();
    const warning = await waitFor(() => document.querySelector('.mcp-config-warning'), 'install warning banner');
    return { warningText: warning.textContent.trim(), warningRole: warning.getAttribute('role') };
  })()
  `;
}

function unavailableSource() {
  return `(async () => {
    ${pagePrelude()}
    ${fakeBridge({ available: false })}
    ${openConnectionPage("连接")}

    await openConnectionPage();
    // The guide link is the only content left; it is deliberately not clicked.
    await waitFor(() => document.querySelector('.mcp-config-card .mcp-config-note a'), 'guide link');
    return {
      hasClientButtons: clientButtons().length > 0,
      hasCopyButton: Boolean(document.querySelector('.mcp-config-copy-button')),
      hasPre: Boolean(document.querySelector('.mcp-config-card pre')),
      hasWarning: Boolean(document.querySelector('.mcp-config-warning')),
      linkHref: document.querySelector('.mcp-config-card .mcp-config-note a')?.getAttribute('href') ?? null,
    };
  })()
  `;
}

function englishSource({ config, platform }) {
  return `(async () => {
    ${pagePrelude()}
    ${fakeBridge({ config, platform, installWarning: null, available: true })}

    await waitFor(() => document.querySelector('.app') && document.querySelectorAll('.asset-card').length === 1, 'seeded gallery');
    document.querySelector('.user-button').click();
    await waitFor(() => document.querySelector('.settings-modal'), 'settings open');
    // Language switch on the default 常规 page, then over to the connections
    // page whose nav now reads Connect.
    const englishButton = () => Array.from(document.querySelectorAll('.settings-content .segmented button'))
      .find((b) => b.textContent.trim() === 'English') || null;
    await waitFor(englishButton, 'English language button');
    englishButton().click();
    await sleep(300);
    const nav = navButton('Connect');
    if (!nav) throw new Error('Connect nav missing: ' + Array.from(document.querySelectorAll('.settings-nav button')).map((b) => b.textContent.trim()).join('|'));
    nav.click();
    await waitFor(() => document.querySelector('.settings-modal .mcp-config-card'), 'MCP config card in English');

    const clientLabels = clientButtons().map((b) => b.textContent.trim());
    const initial = cardState();
    const clients = {};
    for (const [label, id] of [['Claude Code', 'claudeCode'], ['Codex', 'codex']]) {
      clientButton(label).click();
      await waitFor(() => selectedId() === id, id + ' selected (English)');
      clients[id] = cardState();
    }
    return {
      ariaLabel: document.querySelector('.mcp-config-card')?.getAttribute('aria-label') ?? null,
      clientLabels,
      initial,
      clients,
      copyLabel: copyButton()?.textContent.trim() ?? null,
      note: document.querySelector('.mcp-config-card .mcp-config-note')?.textContent.trim() ?? null,
    };
  })()
  `;
}
