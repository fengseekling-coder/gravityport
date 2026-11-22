// Task 452: the Settings → 连接 本机 AI 工具 card.
//
// The real card sources are compiled with tsc and the emitted JS is imported —
// bridgeRowViews / bridgeReceivedTime / commonParentOf are asserted against
// every row of the task's status and reason/fix tables, and the rendered
// states (loading, normal, error, warning, fetch failure) come from
// renderToStaticMarkup of the real BridgeStatusCardView.

import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire, register } from "node:module";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");
const compileRoot = join(uiRoot, "node_modules", ".cache", "bridge-status-card-test");

let cardModule;
let textModule;
let React;
let renderStatic;

before(async () => {
  await mkdir(compileRoot, { recursive: true });
  const sources = [
    join(uiRoot, "src", "vite-env.d.ts"),
    join(uiRoot, "src", "mosa-api.ts"),
    join(uiRoot, "src", "i18n.ts"),
    join(uiRoot, "src", "app-lifecycle.ts"),
    join(uiRoot, "src", "desktop.ts"),
    join(uiRoot, "src", "Icon.tsx"),
    join(uiRoot, "src", "bridge-status-text.ts"),
    join(uiRoot, "src", "BridgeStatusCard.tsx"),
  ];
  execFileSync(
    join(repositoryRoot, "node_modules", ".bin", "tsc"),
    [
      ...sources,
      "--outDir", compileRoot,
      "--module", "esnext",
      "--target", "es2022",
      "--moduleResolution", "bundler",
      "--jsx", "react-jsx",
      "--skipLibCheck",
    ],
    { stdio: "pipe" }
  );

  // BridgeStatusCard imports "./bridge-status.css", which Vite handles in the
  // real build; short-circuit it for Node with a resolve hook.
  await writeFile(
    join(compileRoot, "bridge-status-css-hooks.mjs"),
    [
      "export async function resolve(specifier, context, next) {",
      '  if (specifier.endsWith(".css")) {',
      '    return { url: "data:text/javascript,export default null;", shortCircuit: true };',
      "  }",
      "  return next(specifier, context);",
      "}",
      "",
    ].join("\n")
  );
  register(pathToFileURL(join(compileRoot, "bridge-status-css-hooks.mjs")).href);

  const uiRequire = createRequire(join(uiRoot, "package.json"));
  ({ renderToStaticMarkup: renderStatic } = await import(uiRequire.resolve("react-dom/server")));
  React = await import(uiRequire.resolve("react"));
  cardModule = await import(join(compileRoot, "BridgeStatusCard.js"));
  textModule = await import(join(compileRoot, "bridge-status-text.js"));
  assert.equal(typeof cardModule.BridgeStatusCardView, "function");
  assert.equal(typeof textModule.bridgeRowViews, "function");
  assert.equal(typeof textModule.bridgeReceivedTime, "function");
});

after(async () => {
  await rm(compileRoot, { recursive: true, force: true });
});

// A /api/bridges payload shaped like the server sends it; every case below
// overrides only what it cares about.
function toolStatus(overrides = {}) {
  return {
    enabled: true,
    lastScanAt: "2026-11-20T06:02:00.000Z",
    lastImportedAt: null,
    totalImported: 0,
    lastError: null,
    lastErrorCode: null,
    lastWarning: null,
    sourceFound: true,
    imagesDir: "/Users/alice/.codex/generated_images",
    sessionsDir: "/Users/alice/.codex/sessions",
    ...overrides,
  };
}

function bridgesStatus(overrides = {}) {
  return {
    codex: overrides.codex || toolStatus(),
    grok: overrides.grok || toolStatus({ imagesDir: "" }),
    cowart: {
      enabled: true,
      lastScanAt: "2026-11-20T06:02:00.000Z",
      registeredCount: 3,
      monitoredCount: 3,
      lastError: null,
      lastErrorCode: null,
      sources: [],
      ...(overrides.cowart || {}),
    },
    cowartDiscovery: { lastError: null, lastErrorCode: null, ...(overrides.cowartDiscovery || {}) },
  };
}

// The card's clock is pinned to a local 2026-11-20 08:00 and the stamps are
// built in local time too, so same-day vs other-day rendering does not depend
// on the machine's timezone.
const NOW_MS = new Date(2026, 10, 20, 8, 0, 0).getTime();
const TODAY_STAMP = new Date(2026, 10, 20, 16, 2, 0).toISOString();
const OLD_STAMP = new Date(2026, 10, 18, 14, 47, 0).toISOString();

const rowByKey = (status) => Object.fromEntries(
  textModule.bridgeRowViews(status, NOW_MS, "zh").map((row) => [row.key, row])
);

test("status table: loading ladder renders before the first fetch answers", () => {
  const rows = rowByKey(undefined);
  for (const row of Object.values(rows)) {
    assert.equal(row.badgeKey, "正在加载…");
    assert.equal(row.tone, "muted");
    assert.deepEqual(row.lines, []);
  }
});

test("status table: disabled rows come first and stay grey", () => {
  const status = bridgesStatus({
    codex: toolStatus({ enabled: false }),
    grok: toolStatus({ enabled: false, imagesDir: "" }),
    cowart: { enabled: false },
  });
  const rows = rowByKey(status);
  assert.equal(rows.codex.badgeKey, "已停用");
  assert.equal(rows.codex.tone, "muted");
  assert.equal(rows.grok.badgeKey, "已停用");
  assert.equal(rows.cowart.badgeKey, "已停用");
});

test("status table: a lastError row shows 无法收录 and outranks everything else", () => {
  const status = bridgesStatus({
    codex: toolStatus({ lastError: "EACCES: permission denied, scandir '/Users/alice/.codex/generated_images'", lastErrorCode: "EACCES", lastImportedAt: TODAY_STAMP, sourceFound: false, lastWarning: "w" }),
  });
  const rows = rowByKey(status);
  assert.equal(rows.codex.badgeKey, "无法收录");
  assert.equal(rows.codex.tone, "bad");
  assert.equal(rows.codex.lines.length, 1);
});

test("status table: sourceFound:false reads 未找到生图记录 and outranks the warning", () => {
  const status = bridgesStatus({
    grok: toolStatus({ imagesDir: "", sourceFound: false, lastWarning: "rejected chat_history.jsonl" }),
  });
  const rows = rowByKey(status);
  assert.equal(rows.grok.badgeKey, "未找到生图记录");
  assert.equal(rows.grok.tone, "muted");
  assert.deepEqual(rows.grok.lines, []);
});

test("status table: warning row reads 正在收录 · 部分提示词未读到 and carries the note", () => {
  const status = bridgesStatus({
    codex: toolStatus({ lastWarning: "thread history unavailable; prompts may be missing", lastImportedAt: TODAY_STAMP }),
  });
  const rows = rowByKey(status);
  assert.equal(rows.codex.badgeKey, "正在收录 · 部分提示词未读到");
  assert.equal(rows.codex.tone, "warn");
  assert.equal(rows.codex.lines.length, 1);
  assert.equal(rows.codex.lines[0].dangerKey, null);
  assert.equal(rows.codex.lines[0].noteKey, "有些图片的提示词没有读到，图片照常收录。");
});

test("status table: normal rows read 正在收录 · 最近收到 {time} or 正在收录", () => {
  const rows = rowByKey(bridgesStatus({ codex: toolStatus({ lastImportedAt: TODAY_STAMP }) }));
  assert.equal(rows.codex.badgeKey, "正在收录 · 最近收到 {time}");
  assert.equal(rows.codex.badgeParams.time, "16:02", "same day keeps only the clock");
  assert.equal(rows.codex.tone, "ok");

  const oldRows = rowByKey(bridgesStatus({ codex: toolStatus({ lastImportedAt: OLD_STAMP }) }));
  assert.equal(oldRows.codex.badgeParams.time, "11月18日 14:47", "another day keeps the date");

  const neverRows = rowByKey(bridgesStatus({ codex: toolStatus({ lastImportedAt: null }) }));
  assert.equal(neverRows.codex.badgeKey, "正在收录");
});

test("status table: cowart reads 正在收录 · {count} 个画布 and 还没有画布", () => {
  const rows = rowByKey(bridgesStatus());
  assert.equal(rows.cowart.badgeKey, "正在收录 · {count} 个画布");
  assert.equal(rows.cowart.badgeParams.count, "3");
  assert.equal(rows.cowart.tone, "ok");

  const empty = rowByKey(bridgesStatus({ cowart: { registeredCount: 0, monitoredCount: 0 } }));
  assert.equal(empty.cowart.badgeKey, "还没有画布");
  assert.equal(empty.cowart.tone, "muted");
});

test("reason table: EACCES/EPERM map to the permission pair with the shared parent", () => {
  const [line] = rowByKey(bridgesStatus({
    codex: toolStatus({ lastError: "EACCES: permission denied, scandir '/Users/alice/.codex/generated_images'", lastErrorCode: "EACCES" }),
  })).codex.lines;
  assert.equal(line.dangerKey, "无法读取 {tool} 的文件夹（没有权限）");
  assert.deepEqual(line.dangerParams, { tool: "Codex" });
  assert.equal(line.noteKey, "在访达中按 ⇧⌘G 前往 {dir}，按 ⌘I 打开简介，在「共享与权限」里把自己的权限改为「读与写」，问题解决后会自动恢复收录。", "macOS EACCES points at the folder's own permissions");
  assert.deepEqual(line.noteParams, { dir: "/Users/alice/.codex" }, "codex points at the images/sessions common parent");
});

test("reason table: EPERM behaves like EACCES and grok points at its sessions dir", () => {
  const [line] = rowByKey(bridgesStatus({
    grok: toolStatus({ imagesDir: "", sessionsDir: "/Users/alice/.grok/sessions", lastError: "EPERM: operation not permitted, scandir '/Users/alice/.grok/sessions'", lastErrorCode: "EPERM" }),
  })).grok.lines;
  assert.equal(line.dangerKey, "无法读取 {tool} 的文件夹（没有权限）");
  assert.deepEqual(line.dangerParams, { tool: "Grok" });
  assert.deepEqual(line.noteParams, { dir: "/Users/alice/.grok/sessions" });
  assert.equal(line.noteKey, "打开「系统设置 → 隐私与安全性 → 完全磁盘访问权限」，允许 GravityPort，问题解决后会自动恢复收录。", "macOS EPERM is the privacy gate");
});

test("reason table: permission errors on Windows paths point at the folder's Security tab", () => {
  for (const code of ["EACCES", "EPERM"]) {
    const [line] = rowByKey(bridgesStatus({
      codex: toolStatus({ imagesDir: "C:\\Users\\alice\\.codex\\generated_images", sessionsDir: "C:\\Users\\alice\\.codex\\sessions", lastError: `${code}: x`, lastErrorCode: code }),
    })).codex.lines;
    assert.equal(line.noteKey, "在文件资源管理器中右键 {dir}，打开「属性 → 安全」，给当前用户加上「读取」权限，问题解决后会自动恢复收录。", code);
    assert.deepEqual(line.noteParams, { dir: "C:\\Users\\alice\\.codex" }, code);
  }
});

test("home directory shows as ~ in the how-to-fix line while the copy payload keeps the full path", () => {
  const codexError = toolStatus({ lastError: "EACCES: permission denied, scandir '/Users/alice/.codex/generated_images'", lastErrorCode: "EACCES" });
  const grokError = toolStatus({ imagesDir: "", sessionsDir: "/Users/alice/.grok/sessions", lastError: "EACCES: x", lastErrorCode: "EACCES" });
  const rows = rowByKey({ ...bridgesStatus({ codex: codexError, grok: grokError }), homeDir: "/Users/alice" });
  assert.deepEqual(rows.codex.lines[0].noteParams, { dir: "~/.codex" });
  assert.deepEqual(rows.grok.lines[0].noteParams, { dir: "~/.grok/sessions" });
  assert.match(rows.codex.detailText, /imagesDir: \/Users\/alice\/\.codex\/generated_images/);
  assert.match(rows.codex.detailText, /sessionsDir: \/Users\/alice\/\.codex\/sessions/);
});

test("homeRelativePath only rewrites paths that really sit under the home directory", () => {
  const { homeRelativePath } = textModule;
  assert.equal(homeRelativePath("/Users/alice/.codex", "/Users/alice"), "~/.codex");
  assert.equal(homeRelativePath("/Users/alice/.codex", "/Users/alice/"), "~/.codex");
  assert.equal(homeRelativePath("/Users/alice", "/Users/alice"), "~");
  assert.equal(homeRelativePath("/Users/bob/.codex", "/Users/alice"), "/Users/bob/.codex");
  assert.equal(homeRelativePath("/var/tmp/codex", "/Users/alice"), "/var/tmp/codex");
  assert.equal(homeRelativePath("/Users/alice/.codex", ""), "/Users/alice/.codex");
  assert.equal(homeRelativePath("C:\\Users\\alice\\.codex", "C:\\Users\\alice"), "~\\.codex");
  assert.equal(homeRelativePath("", "/Users/alice"), "");
});

test("reason table: ENOSPC and SQLITE_BUSY map to their fixed pairs", () => {
  const [disk] = rowByKey(bridgesStatus({
    codex: toolStatus({ lastError: "ENOSPC: no space left on device", lastErrorCode: "ENOSPC" }),
  })).codex.lines;
  assert.equal(disk.dangerKey, "无法保存新图片（磁盘空间不足）");
  assert.equal(disk.noteKey, "腾出磁盘空间后会自动恢复收录。");

  const [busy] = rowByKey(bridgesStatus({
    grok: toolStatus({ imagesDir: "", lastError: "SQLITE_BUSY: database is locked", lastErrorCode: "SQLITE_BUSY" }),
  })).grok.lines;
  assert.equal(busy.dangerKey, "素材库暂时无法写入");
  assert.equal(busy.noteKey, "稍后会自动重试。");
});

test("reason table: unknown code keeps the code in parentheses, code-less drops them", () => {
  const [coded] = rowByKey(bridgesStatus({
    codex: toolStatus({ lastError: "weird failure", lastErrorCode: "EIO" }),
  })).codex.lines;
  assert.equal(coded.dangerKey, "无法收录 {tool} 的新图片（{code}）");
  assert.deepEqual(coded.dangerParams, { tool: "Codex", code: "EIO" });
  assert.equal(coded.noteKey, "重新打开 GravityPort；仍然失败时，复制详细信息并发送到「反馈」。");

  const [bare] = rowByKey(bridgesStatus({
    grok: toolStatus({ imagesDir: "", lastError: "weird failure", lastErrorCode: null }),
  })).grok.lines;
  assert.equal(bare.dangerKey, "无法收录 {tool} 的新图片");
  assert.deepEqual(bare.dangerParams, { tool: "Grok", code: "" });
});

test("reason table: cowart canvas trust failures map per reason", () => {
  const missing = rowByKey(bridgesStatus({
    cowart: {
      lastError: "Cowart project directory does not exist.",
      lastErrorCode: "project-missing",
      sources: [{ projectDir: "/Users/alice/works/gone-canvas", trusted: false, lastError: "Cowart project directory does not exist.", lastErrorCode: "project-missing" }],
    },
  })).cowart;
  assert.equal(missing.lines[0].dangerKey, "找不到画布「{canvas}」的文件夹");
  assert.deepEqual(missing.lines[0].dangerParams, { canvas: "gone-canvas" });
  assert.equal(missing.lines[0].noteKey, "画布被移动或删除后无法继续收录。");

  const symlink = rowByKey(bridgesStatus({
    cowart: {
      lastError: "Cowart canvas directory must not be a symbolic link.",
      lastErrorCode: "canvas-symlink",
      sources: [{ projectDir: "/Users/alice/works/linked", trusted: false, lastError: "Cowart canvas directory must not be a symbolic link.", lastErrorCode: "canvas-symlink" }],
    },
  })).cowart;
  assert.equal(symlink.lines[0].dangerKey, "无法收录画布「{canvas}」（{reason}）");
  assert.deepEqual(symlink.lines[0].dangerParams, { canvas: "linked", reason: "canvas-symlink" });
  assert.equal(symlink.lines[0].noteKey, "这个画布的文件夹位置不安全，已停止收录。");
});

test("reason table: several cowart canvases each get a group, the badge counts the partial case", () => {
  const errored = (projectDir, code) => ({
    projectDir, trusted: false, lastError: `trust failure for ${projectDir}`, lastErrorCode: code,
  });
  const partial = rowByKey(bridgesStatus({
    cowart: {
      lastError: "trust failure for /works/broken",
      lastErrorCode: "canvas-symlink",
      monitoredCount: 2,
      sources: [errored("/works/broken", "canvas-symlink"), { projectDir: "/works/ok", trusted: true, lastError: null, lastErrorCode: null }],
    },
  })).cowart;
  assert.equal(partial.badgeKey, "{count} 个画布无法收录");
  assert.deepEqual(partial.badgeParams, { count: "1" });
  assert.equal(partial.lines.length, 1);

  const allBroken = rowByKey(bridgesStatus({
    cowart: {
      lastError: "trust failure for /works/one",
      lastErrorCode: "canvas-symlink",
      sources: [errored("/works/one", "canvas-symlink"), errored("/works/two", "project-missing")],
    },
  })).cowart;
  assert.equal(allBroken.badgeKey, "无法收录");
  assert.deepEqual(allBroken.badgeParams, {});
  assert.equal(allBroken.lines.length, 2, "one 原因+怎么办 group per broken canvas");
});

test("reason table: a cowart discovery error folds into the generic row", () => {
  const rows = rowByKey(bridgesStatus({
    cowartDiscovery: { lastError: "onDiscover callback failed", lastErrorCode: null },
  }));
  assert.equal(rows.cowart.badgeKey, "无法收录");
  assert.equal(rows.cowart.lines.length, 1);
  assert.equal(rows.cowart.lines[0].dangerKey, "无法收录 {tool} 的新图片");
  assert.deepEqual(rows.cowart.lines[0].dangerParams, { tool: "Cowart", code: "" });
});

test("copy payload: errors carry code, raw message, scan stamp, and the folders", () => {
  const detail = rowByKey(bridgesStatus({
    codex: toolStatus({
      lastError: "EACCES: permission denied, scandir '/Users/alice/.codex/generated_images'",
      lastErrorCode: "EACCES",
      lastScanAt: "2026-11-20T06:02:00.000Z",
    }),
  })).codex.detailText;
  const lines = detail.split("\n");
  assert.equal(lines[0], "Codex");
  assert.equal(lines[1], "lastErrorCode: EACCES");
  assert.equal(lines[2], "lastError: EACCES: permission denied, scandir '/Users/alice/.codex/generated_images'");
  assert.equal(lines[3], "lastScanAt: 2026-11-20T06:02:00.000Z");
  assert.equal(lines[4], "imagesDir: /Users/alice/.codex/generated_images");
  assert.equal(lines[5], "sessionsDir: /Users/alice/.codex/sessions");
});

test("copy payload: warnings carry lastWarning and never lastError", () => {
  const detail = rowByKey(bridgesStatus({
    grok: toolStatus({ imagesDir: "", lastWarning: "ignored 2 malformed line(s)", lastScanAt: "2026-11-20T06:02:00.000Z" }),
  })).grok.detailText;
  assert.match(detail, /^Grok\n/);
  assert.match(detail, /lastWarning: ignored 2 malformed line\(s\)/);
  assert.match(detail, /lastScanAt: 2026-11-20T06:02:00\.000Z/);
  assert.doesNotMatch(detail, /lastError:/);
});

test("copy payload: cowart lists every broken canvas plus the discovery error", () => {
  const detail = rowByKey(bridgesStatus({
    cowart: {
      lastError: "trust failure for /works/one",
      lastErrorCode: "canvas-symlink",
      sources: [
        { projectDir: "/works/one", trusted: false, lastError: "trust failure for /works/one", lastErrorCode: "canvas-symlink" },
        { projectDir: "/works/two", trusted: false, lastError: "trust failure for /works/two", lastErrorCode: "project-missing" },
      ],
    },
    cowartDiscovery: { lastError: "discovery failed", lastErrorCode: "EIO" },
  })).cowart.detailText;
  assert.match(detail, /canvas: \/works\/one/);
  assert.match(detail, /canvas: \/works\/two/);
  assert.match(detail, /discovery lastError: discovery failed/);
});

test("time format: same day shows the clock, another day keeps the date, en follows the en shape", () => {
  assert.equal(textModule.bridgeReceivedTime(TODAY_STAMP, NOW_MS, "zh"), "16:02");
  assert.equal(textModule.bridgeReceivedTime(OLD_STAMP, NOW_MS, "zh"), "11月18日 14:47");
  assert.equal(textModule.bridgeReceivedTime(OLD_STAMP, NOW_MS, "en"), "Nov 18, 14:47");
  assert.equal(textModule.bridgeReceivedTime(null, NOW_MS, "zh"), "");
  assert.equal(textModule.bridgeReceivedTime("not-a-date", NOW_MS, "zh"), "");
});

test("common parent: shared directory of the two codex folders, windows-safe", () => {
  assert.equal(textModule.commonParentOf("/Users/alice/.codex/generated_images", "/Users/alice/.codex/sessions"), "/Users/alice/.codex");
  assert.equal(textModule.commonParentOf("/same/dir", "/same/dir/nested"), "/same/dir");
  assert.equal(textModule.commonParentOf("C:\\Users\\alice\\.codex\\images", "C:\\Users\\alice\\.codex\\sessions"), "C:\\Users\\alice\\.codex");
  assert.equal(textModule.commonParentOf("", "/x"), "");
});

// ---------------------------------------------------------------------------
// Rendering the real view
// ---------------------------------------------------------------------------

const renderCard = ({ language = "zh", status, nowMs = NOW_MS } = {}) =>
  renderStatic(React.createElement(cardModule.BridgeStatusCardView, { language, status, nowMs }));

test("view renders loading rows while the first fetch is in flight", () => {
  const html = renderCard({ status: undefined });
  assert.match(html, /本机 AI 工具/);
  assert.match(html, /自动收录这些工具生成的图片/);
  assert.match(html, /正在加载…/);
  assert.doesNotMatch(html, /复制详细信息/);
});

test("view renders normal rows without any copy button", () => {
  const html = renderCard({ status: bridgesStatus({
    codex: toolStatus({ lastImportedAt: TODAY_STAMP }),
    grok: toolStatus({ imagesDir: "", sourceFound: false }),
  }) });
  assert.match(html, /正在收录 · 最近收到 16:02/);
  assert.match(html, /未找到生图记录/);
  assert.match(html, /正在收录 · 3 个画布/);
  assert.doesNotMatch(html, /复制详细信息/);
});

test("view renders an error row with the reason, the fix, and the copy button", () => {
  const status = bridgesStatus({
    codex: toolStatus({ lastError: "EACCES: permission denied, scandir '/Users/alice/.codex/generated_images'", lastErrorCode: "EACCES" }),
    grok: toolStatus({ imagesDir: "", sourceFound: false }),
  });
  const html = renderCard({ status });
  assert.match(html, /无法收录/);
  assert.match(html, /无法读取 Codex 的文件夹（没有权限）/, "the reason line arrives filled with the tool name");
  assert.match(html, /在访达中按 ⇧⌘G 前往 \/Users\/alice\/\.codex，按 ⌘I 打开简介/);
  assert.match(html, /复制详细信息/);
  assert.match(html, /未找到生图记录/, "grok row shows its own state");
});

test("view renders a warning row with the note and the copy button but no danger line", () => {
  const html = renderCard({ status: bridgesStatus({
    grok: toolStatus({ imagesDir: "", lastWarning: "rejected chat_history.jsonl" }),
  }) });
  assert.match(html, /正在收录 · 部分提示词未读到/);
  assert.match(html, /有些图片的提示词没有读到，图片照常收录。/);
  assert.match(html, /复制详细信息/);
  assert.doesNotMatch(html, /bridge-status-error/);
});

test("view renders only the description plus one failure line when /api/bridges fails", () => {
  const html = renderCard({ status: null });
  assert.match(html, /GravityPort 打开时，自动收录这些工具生成的图片。/);
  assert.match(html, /无法读取收录状态/);
  assert.doesNotMatch(html, /bridge-status-row/);
  assert.doesNotMatch(html, /Codex/);
});

test("view renders English wording from the i18n table", () => {
  const html = renderCard({ language: "en", status: bridgesStatus({
    codex: toolStatus({ lastError: "EACCES: permission denied, scandir '/Users/alice/.codex/generated_images'", lastErrorCode: "EACCES" }),
  }) });
  assert.match(html, /Local AI tools/);
  assert.match(html, /Not capturing/);
  assert.match(html, /permission denied/);
  assert.match(html, /Copy details/);
});
