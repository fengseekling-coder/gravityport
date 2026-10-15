import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import * as desktopI18n from "../desktop/notification-i18n.mjs";
import { getNotificationTextForAssetsImported, getUpdateNotificationText } from "../desktop/notification-i18n.mjs";
import { assertPackageLockMatchesManifest } from "./package-lock-contract.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (relativePath) => readFile(resolve(root, relativePath), "utf8");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const DESKTOP_TEXT = {
  menuFile: { zh: "文件", en: "File" },
  menuEdit: { zh: "编辑", en: "Edit" },
  menuView: { zh: "视图", en: "View" },
  menuSearch: { zh: "搜索", en: "Search" },
  menuWindow: { zh: "窗口", en: "Window" },
  startupErrorTitle: { zh: "GravityPort 无法启动", en: "GravityPort could not start" },
};

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test("getDesktopText resolves desktop labels in zh/en and falls back safely", () => {
  const { getDesktopText } = desktopI18n;
  assert.equal(typeof getDesktopText, "function", "desktop i18n must expose getDesktopText");

  for (const [key, expected] of Object.entries(DESKTOP_TEXT)) {
    assert.equal(getDesktopText(key, "zh"), expected.zh, `${key} zh text`);
    assert.equal(getDesktopText(key, "en"), expected.en, `${key} en text`);
    assert.equal(getDesktopText(key, "ja"), expected.zh, `${key} unknown locale falls back to zh`);
  }

  assert.throws(
    () => getDesktopText("not-a-desktop-key", "en"),
    /Unsupported desktop key/,
    "unknown desktop keys must fail explicitly",
  );
});

test("desktop notifications keep localized import and update copy", () => {
  assert.equal(getNotificationTextForAssetsImported(1, "en"), "1 new asset imported");
  assert.equal(getNotificationTextForAssetsImported(12, "en"), "12 new assets imported");
  assert.equal(getNotificationTextForAssetsImported(3, "ja"), "3 个新素材已导入");
  assert.deepEqual(getUpdateNotificationText("0.3.0", "zh"), {
    title: "GravityPort v0.3.0 可更新",
    body: "新版本已发布，点击打开 GravityPort 查看更新。",
  });
  assert.deepEqual(getUpdateNotificationText("v0.3.0", "en"), {
    title: "GravityPort v0.3.0 is available",
    body: "A new version is available. Click to open GravityPort and review the update.",
  });
  assert.equal("getNotificationText" in desktopI18n, false, "removed updater helper is not kept as dead API");
});

test("main localizes custom menu labels without changing roles or accelerators", async () => {
  const main = await read("desktop/main.mjs");
  const menu = sliceBetween(main, "function buildMenu()", "function registerIPC()");

  assert.match(main, /getDesktopText/);
  assert.match(main, /const MOSA_MENU_ID_PREFIX = "mosa-menu-"/);
  assert.match(main, /function pruneInjectedMenuItems\(menu\)/);
  assert.match(main, /child\.type !== "normal" \|\| child\.id\?\.startsWith\(MOSA_MENU_ID_PREFIX\)/);
  assert.match(menu, /id:\s*"mosa-menu-app"/);
  assert.match(menu, /id:\s*"mosa-menu-file"/);
  assert.match(menu, /id:\s*"mosa-menu-edit"/);
  assert.match(menu, /id:\s*"mosa-menu-view"/);
  assert.match(menu, /id:\s*"mosa-menu-window"/);
  for (const label of Object.values(DESKTOP_TEXT).slice(0, 5).flatMap(({ zh, en }) => [zh, en])) {
    assert.doesNotMatch(menu, new RegExp(`label\\s*:\\s*${label.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`));
  }
  assert.equal((menu.match(/getDesktopText\s*\(/g) || []).length >= 6, true, "all custom labels must use desktop i18n");

  for (const role of [
    "about", "services", "hide", "hideOthers", "unhide", "quit", "close",
    "undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "delete", "selectAll",
    "resetZoom", "zoomIn", "zoomOut", "togglefullscreen", "minimize", "zoom", "front",
  ]) {
    assert.match(menu, new RegExp(`role\\s*:\\s*"${role}"`), `${role} role remains available`);
  }
  // 2026-09: the "Import Asset" menu item retired with the manual import
  // modal, so the File menu keeps only Close and the ⌘N accelerator is gone.
  assert.doesNotMatch(menu, /CmdOrCtrl\+N/);
  assert.doesNotMatch(menu, /menu-import/);
  assert.match(menu, /accelerator\s*:\s*"CmdOrCtrl\+F"/);
  assert.match(menu, /sendToWindow\("menu-search"\)/);
  assert.match(menu, /pruneInjectedMenuItems\(menu\);/);
  assert.match(menu, /setImmediate\(\(\) =>/);
});

test("main keeps MOSA shortcuts scoped to its application menu", async () => {
  const main = await read("desktop/main.mjs");

  assert.doesNotMatch(main, /\bglobalShortcut\b/);
  assert.doesNotMatch(main, /registerGlobalShortcuts/);
});

test("set-locale validates sender and locale, rebuilds once, and is idempotent", async () => {
  const main = await read("desktop/main.mjs");
  const handler = sliceBetween(main, 'ipcMain.handle("set-locale"', "\n  });");

  assert.match(handler, /event\.sender\s*!==\s*mainWindow\.webContents/);
  assert.match(handler, /locale\s*!==\s*"zh"\s*&&\s*locale\s*!==\s*"en"/);
  assert.match(handler, /if\s*\(\s*(?:locale\s*===\s*currentLocale|currentLocale\s*===\s*locale)\s*\)\s*return\s+true;/);
  assert.match(handler, /currentLocale\s*=\s*locale/);
  assert.match(handler, /buildMenu\(\)/);
  assert.ok(handler.indexOf("currentLocale = locale") < handler.indexOf("buildMenu()"), "menu rebuild follows locale update");
});

test("startup failures route the localized title while preserving the raw error message", async () => {
  const main = await read("desktop/main.mjs");
  const reportStartupFailure = sliceBetween(main, "function reportStartupFailure(error)", "\n}");

  assert.match(reportStartupFailure, /const message\s*=\s*error instanceof Error\s*\?\s*error\.message\s*:\s*String\(error\)/);
  assert.match(reportStartupFailure, /getDesktopText\s*\(\s*"startupErrorTitle"\s*,\s*currentLocale\s*\)/);
  assert.match(reportStartupFailure, /dialog\.showErrorBox\s*\([\s\S]*,\s*message\s*\)/);
});

test("package metadata stays frozen and the runtime preload preserves its approved surface", async () => {
  const manifest = JSON.parse(await read("package.json"));
  assertPackageLockMatchesManifest(await read("package-lock.json"), manifest);
  const preload = await read("desktop/preload.cjs");
  const exposedKeys = [...preload.matchAll(/^\s{2}(\w+):/gm)].map((match) => match[1]).sort();
  assert.deepEqual(exposedKeys, [
    "acknowledgeRenameNotice",
    "cancelUpdateDownload",
    "cancelVisualPackInstall",
    "changeLibraryLocation",
    "checkForUpdates",
    "downloadAndInstallUpdate",
    "getRenameNoticeState",
    "getUserProfile",
    "getVisualModelState",
    "installVisualPack",
    "onMenuSearch",
    "onUpdateDownloadProgress",
    "onVisualPackProgress",
    "onWindowFullScreenChange",
    "openDownloadPage",
    "openPinterestAuthorize",
    "pasteImage",
    "removeVisualPack",
    "reportRendererReady",
    "setLocale",
    "setVisualModelEnabled",
    "setWindowFullScreen",
    "startNativeDrag",
    "writeClipboardImage",
    "writeClipboardText",
  ]);
  // 任务 96（A6）：第 18 条批准通道 set-window-full-screen。任务 116：第 19/20 条
  // rename-notice-state / acknowledge-rename-notice（老用户「已更名」提示）。任务 135：
  // 第 21 条 open-pinterest-authorize（Pinterest OAuth 授权页）。
  assert.equal(preload.split("ipcRenderer.invoke").length - 1, 21, "preload keeps the approved invoke channels");
  assert.match(preload, /checkForUpdates: \(notify = false\) =>[\s\S]*?ipcRenderer\.invoke\("check-for-updates", notify === true\)/);
  assert.doesNotMatch(preload, /shell\s*[:.]/, "renderer still receives no generic shell capability");
  // R1 isolation fix (2026-08-09, approved scope) added qa:web/qa:electron/
  // qa:packaged launcher scripts to package.json, so its dependency sections
  // (the frozen semantics) are pinned structurally instead of by file hash.
  assert.equal(sha256(JSON.stringify(manifest.dependencies)), "709481475dca249e75c25f9e0b5e93a685b92cfada8e7e7ab0db8a33653c1843", "package.json dependencies must remain unchanged");
  assert.equal(sha256(JSON.stringify(manifest.devDependencies)), "11f67ce00f34b4d3dfb9b9ed0dfb428b0368ad5e0a17bd3bafaa40e3c2124fac", "package.json devDependencies must remain unchanged");
});
