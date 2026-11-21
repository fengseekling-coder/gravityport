#!/usr/bin/env electron

// Task 452 settings-bridge-status: a persistent hidden web window the flow
// drives over CDP. Unlike scripts/e2e-web-driver.mjs (one-shot), this window
// stays open so the Node side can flip files and permissions between page
// assertions and take the light/dark screenshots through
// Page.captureScreenshot. Launched with --remote-debugging-port=<cdpPort> by
// the flow itself; the CDP session finds this page target by its URL.

import { app, BrowserWindow } from "electron";
import { resolve } from "node:path";

// process.argv keeps Chromium switches (--remote-debugging-port=…) in place,
// so drop every dash-prefixed token and skip the script path itself.
const positional = process.argv.slice(1).filter((arg) => !arg.startsWith("-")).slice(1);
const [targetUrl, userDataDir] = positional;
if (!targetUrl || !userDataDir) {
  console.error("usage: electron scripts/e2e-flows/bridge-status-window.mjs <url> <userDataDir>");
  process.exit(2);
}

// Same quiet-window rules as the shared web driver: background (accessory)
// app on macOS so the hidden test window never reaches the Dock and never
// takes focus. Must run before app ready.
if (process.platform === "darwin") app.dock?.hide();

app.setPath("userData", resolve(userDataDir));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.on("closed", () => app.quit());
  await win.loadURL(targetUrl);
  // Flows match Chinese UI copy; pin it the same way the shared driver does.
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
    await new Promise((resolveReload, rejectReload) => {
      win.webContents.once("did-finish-load", resolveReload);
      win.webContents.once("did-fail-load", (_event, code, description) => rejectReload(new Error(`reload failed: ${code} ${description}`)));
      win.webContents.reload();
    });
  }
  const shellReady = await win.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !document.querySelector('.workspace')) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    return Boolean(document.querySelector('.workspace'));
  })()`, true);
  if (!shellReady) {
    console.error("[bridge-status-window] workspace shell never mounted");
    app.exit(2);
    return;
  }
  console.log("BRIDGE_STATUS_WINDOW_READY");
}).catch((error) => {
  console.error(error?.stack || error);
  app.exit(1);
});
