import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getNotificationTextForAssetsImported } from "../desktop/notification-i18n.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("getNotificationTextForAssetsImported formats the count placeholder", () => {
  assert.equal(getNotificationTextForAssetsImported(1, "zh"), "1 个新素材已导入");
  assert.equal(getNotificationTextForAssetsImported(5, "zh"), "5 个新素材已导入");
  assert.equal(getNotificationTextForAssetsImported(1, "en"), "1 new asset imported");
  assert.equal(getNotificationTextForAssetsImported(12, "en"), "12 new assets imported");
});

test("getNotificationTextForAssetsImported falls back to zh for unknown locale", () => {
  assert.equal(getNotificationTextForAssetsImported(3, "es"), "3 个新素材已导入");
});

test("main.mjs localizes bridge and update notifications", async () => {
  const source = await readFile(resolve(repositoryRoot, "desktop/main.mjs"), "utf8");
  assert.match(source, /getNotificationTextForAssetsImported/);
  assert.match(source, /getUpdateNotificationText/);
  assert.match(source, /let currentLocale\s*=\s*"zh"/);
  // Bridge poll uses the i18n helper instead of a hardcoded string.
  assert.match(source, /getNotificationTextForAssetsImported\(delta,\s*currentLocale\)/);
  // Update reminders stay localized while the trusted main process owns the
  // macOS/Windows download/apply paths.
  assert.match(source, /getUpdateNotificationText\(result\.latestVersion,\s*currentLocale\)/);
  assert.match(source, /downloadMacosUpdate/);
  assert.match(source, /downloadWindowsUpdate/);
  assert.doesNotMatch(source, /electron-updater|autoUpdater|updateDownloaded/);
  assert.doesNotMatch(source, /`?\$\{delta\} 个新素材已导入`?/);
});

test("set-locale IPC validates sender and locale values", async () => {
  const source = await readFile(resolve(repositoryRoot, "desktop/main.mjs"), "utf8");
  assert.match(source, /ipcMain\.handle\("set-locale"/);
  assert.match(source, /async \(event,\s*locale\)/);
  // Sender must be the main window's webContents.
  assert.match(source, /event\.sender\s*!==\s*mainWindow\.webContents/);
  // Only zh/en accepted; anything else is rejected.
  assert.match(source, /locale\s*!==\s*"zh"\s*&&\s*locale\s*!==\s*"en"/);
  assert.match(source, /currentLocale\s*=\s*locale/);
});

test("preload exposes setLocale and no longer exposes openFolder", async () => {
  const preload = await readFile(resolve(repositoryRoot, "desktop/preload.cjs"), "utf8");
  assert.match(preload, /setLocale:\s*\(locale\)\s*=>\s*ipcRenderer\.invoke\("set-locale"/);
  assert.doesNotMatch(preload, /openFolder/);
  assert.doesNotMatch(preload, /open-folder/);
});

test("main.mjs no longer registers an open-folder IPC handler", async () => {
  const source = await readFile(resolve(repositoryRoot, "desktop/main.mjs"), "utf8");
  assert.doesNotMatch(source, /ipcMain\.handle\("open-folder"/);
  assert.doesNotMatch(source, /shell\.openPath/);
  // The renderer's /api/open-folder HTTP route (validated server-side) is the
  // only remaining folder-opening path; the desktop IPC shortcut is gone.
  const appSource = await readFile(resolve(repositoryRoot, "web/gravityport/src/App.tsx"), "utf8");
  assert.doesNotMatch(appSource, /electronAPI\?\.openFolder|electronAPI\.openFolder/);
});

test("the React shell syncs the resolved locale to the main process", async () => {
  const appSource = await readFile(resolve(repositoryRoot, "web/gravityport/src/App.tsx"), "utf8");
  assert.match(appSource, /desktopAPI\(\)\?\.setLocale\?\.\(language === "en" \? "en" : "zh"\)/);
});
