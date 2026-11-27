// Settings → 连接 "AI assistants (MCP)" card (task 208) — compile the real
// sources with tsc, then render the props-only view. Output goes under
// web/gravityport/node_modules/.cache so React resolves from the UI tree.

import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire, register } from "node:module";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMcpClientConfig } from "../lib/mcp-client-config.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");
const compileRoot = join(uiRoot, "node_modules", ".cache", "mcp-config-ui-test");

let card;
let renderStatic;
let React;

before(async () => {
  await mkdir(compileRoot, { recursive: true });
  execFileSync(
    join(repositoryRoot, "node_modules", ".bin", "tsc"),
    [
      join(uiRoot, "src", "vite-env.d.ts"),
      join(uiRoot, "src", "desktop.ts"),
      join(uiRoot, "src", "i18n.ts"),
      join(uiRoot, "src", "McpClientConfigCard.tsx"),
      "--outDir", compileRoot,
      "--module", "esnext",
      "--target", "es2022",
      "--moduleResolution", "bundler",
      "--jsx", "react-jsx",
      "--skipLibCheck",
    ],
    { stdio: "pipe" },
  );
  await writeFile(
    join(compileRoot, "css-hooks.mjs"),
    [
      "export async function resolve(specifier, context, next) {",
      '  if (specifier.endsWith(".css")) return { url: "data:text/javascript,export default null;", shortCircuit: true };',
      "  return next(specifier, context);",
      "}",
      "",
    ].join("\n"),
  );
  register(pathToFileURL(join(compileRoot, "css-hooks.mjs")).href);
  const uiRequire = createRequire(join(uiRoot, "package.json"));
  ({ renderToStaticMarkup: renderStatic } = await import(uiRequire.resolve("react-dom/server")));
  React = await import(uiRequire.resolve("react"));
  card = await import(join(compileRoot, "McpClientConfigCard.js"));
});

after(async () => {
  await rm(compileRoot, { recursive: true, force: true });
});

const config = {
  available: true,
  platform: "darwin",
  installWarning: null,
  ...buildMcpClientConfig({
    platform: "darwin",
    execPath: "/Applications/GravityPort.app/Contents/MacOS/GravityPort",
    serverPath: "/Applications/GravityPort.app/Contents/Resources/app.asar/mcp/server.mjs",
    libraryLocationFile: "/Users/a/Library/Application Support/mosa/library-location.json",
  }),
};

// The text behind 复制 is folded by default; tests that read it pass expanded.
function render(props) {
  return renderStatic(React.createElement(card.McpClientConfigCardView, {
    language: "zh",
    config,
    client: "claudeDesktop",
    copied: false,
    expanded: false,
    onSelectClient: () => {},
    onCopy: () => {},
    onToggleExpanded: () => {},
    ...props,
  }));
}

// <wbr> break opportunities sit inside the config text (after "/" and ","); they carry no text.
function decode(html) {
  return html.replace(/<wbr\/>/g, "").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

describe("MCP client config card", () => {
  it("shows the selected client's config, hint, and the four client switches once expanded", () => {
    for (const { id, hint } of card.MCP_CLIENTS) {
      const html = decode(render({ client: id, expanded: true }));
      assert.ok(html.includes(`data-mcp-client="${id}"`));
      // The code block wraps each line for hanging indents; its text is still the config verbatim.
      const codeText = /<code>([\s\S]*?)<\/code>/.exec(html)?.[1].replace(/<[^>]+>/g, "");
      const raw = card.mcpClientConfigText(config, id);
      assert.equal(codeText, card.mcpClientCopyText(id, raw, "zh"), `${id} copy text is shown verbatim`);
      assert.ok(raw && codeText.includes(raw), `${id} config is inside what is shown`);
      if (id === "claudeDesktop") assert.equal(codeText, config[id], "Claude Desktop shows the raw config");
      else if (id === "other") assert.equal(codeText, config.claudeDesktop, "Other shows the shared mcpServers config raw");
      else assert.ok(codeText.startsWith("请为我安装 GravityPort 的 MCP 服务器"), `${id} shows a message for the agent`);
      assert.ok(html.includes(hint));
      for (const label of ["Claude Desktop", "Claude Code", "Codex", "其他"]) assert.ok(html.includes(`>${label}</button>`));
      assert.match(html, new RegExp(`aria-pressed="true"[^>]*>${card.MCP_CLIENTS.find((c) => c.id === id).label}<`));
    }
  });

  it("keeps the text behind 复制 folded until 查看内容 asks for it", () => {
    for (const { id, hint } of card.MCP_CLIENTS) {
      const folded = decode(render({ client: id }));
      assert.ok(!folded.includes("<pre"), `${id}: no config block while folded`);
      assert.ok(!folded.includes("data-mcp-client"), `${id}: nothing of the config is rendered while folded`);
      // Picking an assistant, its hint, and copying all work without unfolding.
      assert.ok(folded.includes(hint), `${id}: hint stays visible`);
      assert.ok(folded.includes(">复制</button>"), `${id}: copy stays available`);
      assert.match(folded, /<button[^>]*class="mcp-config-toggle"[^>]*aria-expanded="false"[^>]*>查看内容<svg/);
    }

    const open = decode(render({ expanded: true }));
    const toggle = /<button[^>]*class="[^"]*mcp-config-toggle[^"]*"[^>]*>/.exec(open)?.[0] || "";
    assert.match(toggle, /aria-expanded="true"/);
    assert.match(open, />收起<svg/);
    // 复制 is the card's action (bordered); the toggle is a quiet text button beside it.
    assert.match(open, /class="settings-action-btn mcp-config-copy-button"/);
    assert.doesNotMatch(toggle, /settings-action-btn/);
    const controls = /aria-controls="([^"]+)"/.exec(toggle)?.[1];
    assert.ok(controls, "the toggle names the block it controls");
    assert.ok(open.includes(`<div class="mcp-config-code" id="${controls}">`), "aria-controls points at the config block");

    const en = decode(render({ language: "en" }));
    assert.match(en, />View contents<svg/);
    assert.match(decode(render({ language: "en", expanded: true })), />Collapse<svg/);
  });

  it("orders the set-up block: assistants, then the hint, then copy and view", () => {
    const html = decode(render({}));
    const positions = ["mcp-config-clients", "mcp-config-hint", "mcp-config-copy-button", "mcp-config-toggle", "mcp-config-note"]
      .map((name) => html.indexOf(name));
    assert.ok(positions.every((at) => at >= 0), `every part is rendered: ${positions}`);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, "parts appear in reading order");
    // The description comes before the assistants it no longer sits between.
    assert.ok(html.indexOf("支持 Claude、Codex 等 AI 助手") < html.indexOf("mcp-config-clients"));
  });

  it("lets long paths wrap at directory boundaries without changing the text", () => {
    const html = render({ expanded: true });
    const code = /<code>([\s\S]*?)<\/code>/.exec(html)?.[1] || "";
    // A break opportunity after every slash and comma; <wbr> carries no text.
    assert.ok(code.includes("/<wbr/>Applications/<wbr/>GravityPort.app/<wbr/>Contents/<wbr/>MacOS/<wbr/>GravityPort"), "the command path can wrap after each directory");
    assert.equal(decode(code.replace(/<[^>]+>/g, "")), config.claudeDesktop, "the shown text is still the config verbatim");
    const command = render({ client: "claudeCode", expanded: true });
    assert.ok(command.includes(",<wbr/>"), "a long one-line command can wrap after commas");
  });

  it("uses the approved Chinese and English copy", () => {
    const zh = decode(render({}));
    assert.ok(zh.includes("AI 助手（MCP）"));
    assert.ok(zh.includes("支持 Claude、Codex 等 AI 助手直接连接与管理素材库。"));
    assert.ok(zh.includes("更改存储位置后无需修改此配置，重启 AI 助手即可。GravityPort 无需保持打开。"));
    assert.ok(zh.includes(">复制</button>"));
    assert.ok(decode(render({ copied: true })).includes(">已复制</button>"));

    const en = decode(render({ language: "en", client: "codex", expanded: true }));
    assert.ok(en.includes("AI assistants (MCP)"));
    assert.ok(en.includes("Enable AI assistants such as Claude and Codex to access and manage your library directly."));
    assert.ok(en.includes("Copy the message below and send it to Codex. It will complete the setup for you."));
    assert.ok(en.includes("Please install the GravityPort MCP server for me: add the configuration below to ~/.codex/config.toml."));
    assert.ok(en.includes("After the storage location changes, this configuration stays valid; restart the assistant to apply it. GravityPort doesn’t need to be open."));
    assert.ok(en.includes(">Copy</button>"));
    assert.ok(decode(render({ language: "en", copied: true })).includes(">Copied</button>"));
    assert.doesNotMatch(en, /[一-鿿]/, "no Chinese left in the English card");

    const other = decode(render({ client: "other" }));
    assert.ok(other.includes("Cursor、Windsurf、Cline 等多数助手通用。粘贴到该助手的 MCP 设置中；若已有 mcpServers，仅合并 gravityport 这一段。保存后重启该助手。"));
    const otherEn = decode(render({ language: "en", client: "other" }));
    assert.ok(otherEn.includes(">Other</button>"));
    assert.ok(otherEn.includes("Works with most assistants, such as Cursor, Windsurf and Cline."));
    assert.doesNotMatch(otherEn, /[一-鿿]/, "no Chinese left on the English Other tab");
  });

  // 2026-11-26 copy change: the card description only says what this is; each
  // assistant's own line says what to do. The old description told every
  // assistant to "paste the configuration, then restart", which contradicted
  // the Claude Code and Codex lines ("send this message").
  it("says how to connect once per assistant, and names a restart only where the user restarts", () => {
    for (const { id } of card.MCP_CLIENTS) {
      const zh = decode(render({ client: id }));
      assert.ok(!zh.includes("将下方配置粘贴到 AI 助手中"), `${id}: the description no longer gives steps`);
      const en = decode(render({ language: "en", client: id }));
      assert.ok(!en.includes("Paste the configuration below into the assistant"), `${id}: English description no longer gives steps`);
    }

    const desktop = decode(render({ client: "claudeDesktop" }));
    assert.ok(desktop.includes("粘贴到 claude_desktop_config.json（Claude 设置 > 开发者 > 编辑配置）。若文件中已有 mcpServers，仅合并 gravityport 这一段。保存后重启 Claude Desktop。"));
    assert.ok(decode(render({ language: "en", client: "claudeDesktop" }))
      .includes("If mcpServers already exists, merge only the gravityport entry. Save the file, then restart Claude Desktop."));
    assert.ok(decode(render({ language: "en", client: "other" }))
      .includes("If mcpServers already exists, merge only the gravityport entry. Save, then restart the assistant."));

    // Claude Code and Codex install it themselves; their next step lives in the
    // message that is sent to them, not in the hint.
    for (const id of ["claudeCode", "codex"]) {
      const hint = /<p class="mcp-config-hint">([\s\S]*?)<\/p>/.exec(decode(render({ client: id })))?.[1] || "";
      assert.match(hint, /^复制下面这段话，发给 (Claude Code|Codex)，它会自动完成安装。$/);
      assert.doesNotMatch(hint, /重启/);
    }
  });

  it("warns before copying from an app outside Applications", () => {
    const html = decode(render({ config: { ...config, installWarning: "not-in-applications" } }));
    assert.ok(html.includes("请先将 GravityPort 移到「应用程序」文件夹，再复制配置，否则其中的路径将失效。"));
    assert.ok(!decode(render({})).includes("应用程序」文件夹"));
    assert.ok(decode(render({ language: "en", config: { ...config, installWarning: "not-in-applications" } }))
      .includes("Move GravityPort to the Applications folder before copying the configuration. Otherwise the path in it will stop working."));
  });

  it("points a plain browser at the guide and renders nothing extra while loading", () => {
    const browser = decode(render({ config: null, expanded: true }));
    assert.ok(browser.includes(card.MCP_GUIDE_URL));
    assert.ok(browser.includes("当前环境无法自动生成配置，配置方法见使用指南。"));
    assert.ok(!browser.includes("<pre"));
    assert.ok(!browser.includes("mcp-config-toggle"), "nothing to unfold without a config");
    const loading = decode(render({ config: undefined, expanded: true }));
    assert.ok(!loading.includes("<pre"));
    assert.ok(!loading.includes(card.MCP_GUIDE_URL));
  });
});
