#!/usr/bin/env electron

import { app, BrowserWindow } from "electron";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createCriticalUiFlowSource, createStackUiFlowSource, createTrashUiFlowSource, E2E_DROP_GROUP_NAME } from "./e2e-ui-flow.mjs";

const cliArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const [cliTargetUrl, cliUserDataDir, cliMode, cliSearchTerm, cliRecipeChange] = cliArgs;
const targetUrl = process.env.MOSA_E2E_WEB_TARGET_URL || cliTargetUrl;
const userDataDir = process.env.MOSA_E2E_WEB_USER_DATA || cliUserDataDir;
const mode = process.env.MOSA_E2E_WEB_MODE || cliMode;
const searchTerm = process.env.MOSA_E2E_WEB_SEARCH || cliSearchTerm;
const recipeChange = process.env.MOSA_E2E_WEB_RECIPE_CHANGE || cliRecipeChange;
const dropGroupName = process.env.MOSA_E2E_WEB_GROUP || E2E_DROP_GROUP_NAME;
const pasteEnabled = (process.env.MOSA_E2E_WEB_PASTE ?? "1") !== "0";
const trashConfigSource = process.env.MOSA_E2E_WEB_TRASH_CONFIG || "";
// Pluggable flows (scripts/e2e-flows) hand over a ready-made source file.
const sourceFile = process.env.MOSA_E2E_WEB_SOURCE_FILE || "";
const flow = sourceFile ? "source" : (process.env.MOSA_E2E_WEB_FLOW || "critical");
if (!targetUrl || !userDataDir) {
  console.error("usage: electron scripts/e2e-web-driver.mjs <url> <userDataDir> [mode] [searchTerm] [recipeChange]");
  process.exit(2);
}
if (flow === "critical" && (!mode || !searchTerm || !recipeChange)) {
  console.error("usage (critical): MOSA_E2E_WEB_MODE / MOSA_E2E_WEB_SEARCH / MOSA_E2E_WEB_RECIPE_CHANGE are required");
  process.exit(2);
}
if (flow === "trash" && !trashConfigSource) {
  console.error("usage (trash): MOSA_E2E_WEB_TRASH_CONFIG (JSON) is required");
  process.exit(2);
}
// E2E only: optional renderer window size override (narrow-viewport flows),
// e.g. MOSA_E2E_WEB_WINDOW_SIZE="720x900". Unset keeps the historical 1280x800.
const windowSizeMatch = /^([1-9]\d*)x([1-9]\d*)$/.exec(process.env.MOSA_E2E_WEB_WINDOW_SIZE || "");
if (process.env.MOSA_E2E_WEB_WINDOW_SIZE && !windowSizeMatch) {
  console.error(`Invalid MOSA_E2E_WEB_WINDOW_SIZE: ${process.env.MOSA_E2E_WEB_WINDOW_SIZE}`);
  process.exit(2);
}

// E2E-only driver: on macOS run as a background (accessory) app so the hidden
// test window never shows up in the Dock or steals the user's keyboard focus
// mid-run. Must run before app ready so the process never registers as a
// regular (Foreground) application in the first place.
if (process.platform === "darwin") app.dock?.hide();

app.setPath("userData", resolve(userDataDir));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: windowSizeMatch ? Number(windowSizeMatch[1]) : 1280,
    height: windowSizeMatch ? Number(windowSizeMatch[2]) : 800,
    // A requested size is the page's viewport. Without this, Windows applies it
    // to the outer frame and a 640 request yields innerWidth 624. The default
    // 1280x800 keeps its historical outer-frame meaning so existing flows are
    // unchanged.
    useContentSize: Boolean(windowSizeMatch),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  // Windows clamps a new window to the screen: the windows-2022 runner's
  // 1024x768 display turned 1440 and 1280 requests into a 1008-wide page, so
  // flows silently ran in the narrow layout band. A resize after creation is
  // not clamped, so re-apply the requested size and refuse to run if it still
  // does not hold.
  const wantedSize = windowSizeMatch ? [Number(windowSizeMatch[1]), Number(windowSizeMatch[2])] : [1280, 800];
  const currentSize = () => (windowSizeMatch ? win.getContentSize() : win.getSize());
  const sizeHolds = () => currentSize().every((value, index) => value === wantedSize[index]);
  if (!sizeHolds()) {
    if (windowSizeMatch) win.setContentSize(...wantedSize);
    else win.setSize(...wantedSize);
  }
  if (!sizeHolds()) {
    console.error(`E2E window size ${JSON.stringify(currentSize())} does not match the requested ${JSON.stringify(wantedSize)}`);
    app.exit(2);
    return;
  }
  // E2E only: a page script can request a mid-run window resize by
  // console-logging "__MOSA_E2E_RESIZE__ <width>x<height>"; the page then waits
  // for the resize event itself. Registered before load so early messages land.
  const timeoutReports = [];
  win.webContents.on("console-message", (event, _level, legacyMessage) => {
    const message = typeof event?.message === "string" ? event.message : legacyMessage;
    const trimmed = String(message || "").trim();
    const resize = /^__MOSA_E2E_RESIZE__ (\d+)x(\d+)$/.exec(trimmed);
    if (resize) win.setContentSize(Number(resize[1]), Number(resize[2]));
    // Timeout scenes (e2e-flows/_shared.mjs) ride the same channel out: the
    // page is destroyed right after logging, so this forward is the only copy.
    // On failure the runner attaches driver stdout to its error; on success
    // the runner echoes only the last stdout line, so the scenes also ride
    // inside the result envelope below.
    if (trimmed.startsWith("[e2e-timeout]")) {
      timeoutReports.push(trimmed);
      console.log(trimmed);
    }
  });
  // E2E only: the hidden window must never pop a save dialog (it would hang),
  // so every download is auto-saved into this run's sandboxed userData under
  // downloads/, with a numeric suffix when the name is already taken. Flows
  // that never download never fire this handler.
  const downloadsDir = join(resolve(userDataDir), "downloads");
  win.webContents.session.on("will-download", (_event, item) => {
    mkdirSync(downloadsDir, { recursive: true });
    const filename = item.getFilename();
    const dot = filename.lastIndexOf(".");
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : "";
    let savePath = join(downloadsDir, filename);
    for (let n = 1; existsSync(savePath); n += 1) savePath = join(downloadsDir, `${stem}-${n}${ext}`);
    item.setSavePath(savePath);
  });
  try {
    await win.loadURL(targetUrl);
    // Flows match Chinese UI copy, but without a stored preference the UI
    // follows navigator.language, which is English on CI runners. Pin Chinese
    // unless this profile already chose a language (a flow may switch it).
    const pinnedLocale = await win.webContents.executeJavaScript(`(() => {
      try {
        if (localStorage.getItem("mosa.ui-language")) return false;
        localStorage.setItem("mosa.ui-language", "zh");
        return true;
      } catch {
        return false;
      }
    })()`, true);
    if (pinnedLocale) {
      // A real reload: loadURL(targetUrl) would only be a same-document hash
      // navigation. The client token already moved to sessionStorage, which
      // survives the reload.
      await new Promise((resolveReload, rejectReload) => {
        win.webContents.once("did-finish-load", resolveReload);
        win.webContents.once("did-fail-load", (_event, code, description) => rejectReload(new Error(`reload failed: ${code} ${description}`)));
        win.webContents.reload();
      });
    }
    let source;
    if (flow === "source") source = readFileSync(sourceFile, "utf8");
    else if (flow === "stack") source = createStackUiFlowSource();
    else if (flow === "trash") source = createTrashUiFlowSource(JSON.parse(trashConfigSource));
    else source = createCriticalUiFlowSource({ mode, searchTerm, recipeChange, dropGroupName, pasteEnabled });
    // Task 314: the app renders only after its capability exchange settles, so
    // did-finish-load no longer implies a mounted UI. Flow sources capture
    // elements up front — wait (bounded) for the workspace shell before handing
    // over, otherwise the first query gets null.
    const shellReady = await win.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !document.querySelector('.workspace')) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return Boolean(document.querySelector('.workspace'));
    })()`, true);
    if (!shellReady) console.error("[e2e-web-driver] workspace shell never mounted; running the flow anyway");
    let result = await win.webContents.executeJavaScript(source, true);
    if (timeoutReports.length && result && typeof result === "object" && !Array.isArray(result)) {
      result = { ...result, e2eTimeoutReports: timeoutReports };
    }
    console.log(JSON.stringify(result));
  } finally {
    win.destroy();
  }
  app.quit();
}).catch((error) => {
  console.error(error?.stack || error);
  app.exit(1);
});
