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

function render(props) {
  return renderStatic(React.createElement(card.McpClientConfigCardView, {
    language: "zh",
    config,
    client: "claudeDesktop",
    copied: false,
    onSelectClient: () => {},
    onCopy: () => {},
    ...props,
  }));
}

function decode(html) {
  return html.replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

describe("MCP client config card", () => {
  it("shows the selected client's config, hint, and the three client switches", () => {
    for (const { id, hint } of card.MCP_CLIENTS) {
      const html = decode(render({ client: id }));
      assert.ok(html.includes(`data-mcp-client="${id}"`));
      assert.ok(html.includes(config[id]), `${id} config is shown verbatim`);
      assert.ok(html.includes(hint));
      for (const label of ["Claude Desktop", "Claude Code", "Codex"]) assert.ok(html.includes(`>${label}</button>`));
      assert.match(html, new RegExp(`aria-pressed="true"[^>]*>${card.MCP_CLIENTS.find((c) => c.id === id).label}<`));
    }
  });

  it("uses the approved Chinese and English copy", () => {
    const zh = decode(render({}));
    assert.ok(zh.includes("AI 助手（MCP）"));
    assert.ok(zh.includes("让 Claude、Codex 等 AI 助手直接搜索、查看和记录你的素材库。复制下面的配置，粘贴到对应 AI 助手里，再重启它。"));
    assert.ok(zh.includes("挪了素材库也不用改配置，重启 AI 助手就会跟过去。GravityPort 不用开着。"));
    assert.ok(zh.includes(">复制</button>"));
    assert.ok(decode(render({ copied: true })).includes(">已复制</button>"));

    const en = decode(render({ language: "en", client: "codex" }));
    assert.ok(en.includes("AI assistants (MCP)"));
    assert.ok(en.includes("Let AI assistants like Claude and Codex search, read, and add to your library. Copy the config below, paste it into the assistant, then restart it."));
    assert.ok(en.includes("Add this to the end of ~/.codex/config.toml."));
    assert.ok(en.includes("Moved your library? No need to change this: restart the assistant and it follows. GravityPort doesn't need to be open."));
    assert.ok(en.includes(">Copy</button>"));
    assert.ok(decode(render({ language: "en", copied: true })).includes(">Copied</button>"));
    assert.doesNotMatch(en, /[一-鿿]/, "no Chinese left in the English card");
  });

  it("warns before copying from an app outside Applications", () => {
    const html = decode(render({ config: { ...config, installWarning: "not-in-applications" } }));
    assert.ok(html.includes("请先把 GravityPort 拖进「应用程序」文件夹再复制，不然这段路径会失效。"));
    assert.ok(!decode(render({})).includes("应用程序」文件夹"));
    assert.ok(decode(render({ language: "en", config: { ...config, installWarning: "not-in-applications" } }))
      .includes("Move GravityPort to your Applications folder before copying, or this path will stop working."));
  });

  it("points a plain browser at the guide and renders nothing extra while loading", () => {
    const browser = decode(render({ config: null }));
    assert.ok(browser.includes(card.MCP_GUIDE_URL));
    assert.ok(browser.includes("从源码运行时的配置方法见使用指南。"));
    assert.ok(!browser.includes("<pre"));
    const loading = decode(render({ config: undefined }));
    assert.ok(!loading.includes("<pre"));
    assert.ok(!loading.includes(card.MCP_GUIDE_URL));
  });
});
