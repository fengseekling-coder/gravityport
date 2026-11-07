import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getLibraryStartupFailureText, getNotificationTextForAssetsImported, getStartupFailureText, getUpdateReadyNotificationText } from "../desktop/notification-i18n.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("getNotificationTextForAssetsImported formats the count placeholder", () => {
  // 任务 359（NOTIF-01）：结果句「已导入 N 个新素材」。
  assert.equal(getNotificationTextForAssetsImported(1, "zh"), "已导入 1 个新素材");
  assert.equal(getNotificationTextForAssetsImported(5, "zh"), "已导入 5 个新素材");
  assert.equal(getNotificationTextForAssetsImported(1, "en"), "Imported 1 new asset");
  assert.equal(getNotificationTextForAssetsImported(12, "en"), "Imported 12 new assets");
});

test("getNotificationTextForAssetsImported falls back to zh for unknown locale", () => {
  assert.equal(getNotificationTextForAssetsImported(3, "es"), "已导入 3 个新素材");
});

test("main.mjs localizes bridge and update notifications", async () => {
  const source = await readFile(resolve(repositoryRoot, "desktop/main.mjs"), "utf8");
  assert.match(source, /getNotificationTextForAssetsImported/);
  assert.match(source, /getUpdateNotificationText/);
  // 任务 359：启动期语言取系统语言（app.getLocale），不再固定 zh。
  assert.match(source, /let currentLocale = .*app\.getLocale/);
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
  // Sender must be the main window's webContents (task 311: via the shared
  // trustedRendererEvent gate, which also checks the main frame and the
  // verified service origin).
  assert.match(source, /if \(!trustedRendererEvent\(event\)\) return false;/);
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

// 任务 359（NATIVE-04/05）：标题统一「无法打开素材库」，原因进正文。
test("getLibraryStartupFailureText picks one language per library error code", () => {
  const databaseMissing = { code: "MOSA_LIBRARY_DATABASE_MISSING", libraryDir: "/tmp/Lib" };
  const zhMissing = getLibraryStartupFailureText(databaseMissing, "zh");
  assert.equal(zhMissing.title, "无法打开素材库");
  assert.match(zhMissing.body, /^素材库（\/tmp\/Lib）缺少数据文件（mosa\.db）。/);
  assert.doesNotMatch(zhMissing.body, /Restore|GravityPort again/);
  const enMissing = getLibraryStartupFailureText(databaseMissing, "en");
  assert.equal(enMissing.title, "Couldn’t open the library");
  assert.match(enMissing.body, /^The library \(\/tmp\/Lib\) is missing its data file/);
  assert.doesNotMatch(enMissing.body, /素材库/);

  const stateInvalid = { code: "MOSA_LIBRARY_STATE_INVALID", libraryDir: "/tmp/State" };
  const zhState = getLibraryStartupFailureText(stateInvalid, "zh");
  assert.equal(zhState.title, "无法打开素材库");
  assert.match(zhState.body, /素材库（\/tmp\/State）的数据不完整/);
  const enState = getLibraryStartupFailureText(stateInvalid, "en");
  assert.equal(enState.title, "Couldn’t open the library");
  assert.match(enState.body, /The data in the library \(\/tmp\/State\) is incomplete/);

  const sqliteMissing = { code: "SQLITE_LIBRARY_MISSING", libraryDir: "/tmp/Migrated" };
  const zhSqlite = getLibraryStartupFailureText(sqliteMissing, "zh");
  assert.equal(zhSqlite.title, "无法打开素材库");
  assert.match(zhSqlite.body, /（\/tmp\/Migrated）缺少数据文件（mosa\.db）/);
  const enSqlite = getLibraryStartupFailureText(sqliteMissing, "en");
  assert.equal(enSqlite.title, "Couldn’t open the library");
  assert.match(enSqlite.body, /\(\/tmp\/Migrated\) is missing its data file \(mosa\.db\)/);
});

// 任务 337：库校验失败按「被占用」和「打不开/损坏」分开报，正文带 {libraryDir}
// 和原始 SQLite 错误码（{sqliteCode}），中英文都取得到。
// 任务 337 / 359（NATIVE-07/08）：错误码放句末括号，标题统一。
test("getLibraryStartupFailureText covers the busy and unreadable library errors with the sqlite code", () => {
  const busy = { code: "SQLITE_LIBRARY_BUSY", libraryDir: "/tmp/Busy", sqliteCode: "SQLITE_BUSY" };
  const zhBusy = getLibraryStartupFailureText(busy, "zh");
  assert.equal(zhBusy.title, "无法打开素材库");
  assert.match(zhBusy.body, /^素材库（\/tmp\/Busy）的数据文件（mosa\.db）暂时无法打开/);
  assert.match(zhBusy.body, /（错误码：SQLITE_BUSY）/);
  assert.doesNotMatch(zhBusy.body, /\{libraryDir\}|\{sqliteCode\}/);
  const enBusy = getLibraryStartupFailureText(busy, "en");
  assert.equal(enBusy.title, "Couldn’t open the library");
  assert.match(enBusy.body, /^The data file \(mosa\.db\) in the library \(\/tmp\/Busy\) can’t be opened/);
  assert.match(enBusy.body, /\(Error code: SQLITE_BUSY\)/);
  assert.doesNotMatch(enBusy.body, /素材库/);

  const unreadable = { code: "SQLITE_LIBRARY_UNREADABLE", libraryDir: "/tmp/Broken", sqliteCode: "SQLITE_CORRUPT" };
  const zhUnreadable = getLibraryStartupFailureText(unreadable, "zh");
  assert.equal(zhUnreadable.title, "无法打开素材库");
  assert.match(zhUnreadable.body, /^无法读取素材库（\/tmp\/Broken）的数据文件（mosa\.db）/);
  assert.match(zhUnreadable.body, /（错误码：SQLITE_CORRUPT）/);
  const enUnreadable = getLibraryStartupFailureText(unreadable, "en");
  assert.equal(enUnreadable.title, "Couldn’t open the library");
  assert.match(enUnreadable.body, /^Couldn’t read the data file \(mosa\.db\) in the library \(\/tmp\/Broken\)/);
  assert.match(enUnreadable.body, /\(Error code: SQLITE_CORRUPT\)/);

  // cause 没有 code 时（sqliteCode 缺失）正文退到 unknown，不渲染占位符。
  const noCode = getLibraryStartupFailureText({ code: "SQLITE_LIBRARY_UNREADABLE", libraryDir: "/tmp/X" }, "zh");
  assert.match(noCode.body, /错误码：unknown/);
  assert.doesNotMatch(noCode.body, /\{sqliteCode\}/);
});

test("getLibraryStartupFailureText returns null for unrelated errors", () => {
  assert.equal(getLibraryStartupFailureText(new Error("boom"), "zh"), null);
  assert.equal(getLibraryStartupFailureText({ code: "SOMETHING_ELSE", libraryDir: "/x" }, "en"), null);
  assert.equal(getLibraryStartupFailureText(null, "zh"), null);
});

// 任务 367（NATIVE-03c~03i）：启动失败按错误码分类——七个码每个中英各一句，
// {port}/{pid} 由错误对象字段填，标题统一 NATIVE-03a。
test("getStartupFailureText covers every classified startup code in zh and en", () => {
  const cases = [
    [{ code: "MOSA_SERVICE_BUILD_MISMATCH" }, "另一个版本的 GravityPort 正在使用此素材库。请退出它，然后重新打开 GravityPort。", "Another version of GravityPort is using this library. Quit it, then open GravityPort again."],
    [{ code: "MOSA_SERVICE_LIBRARY_MISMATCH", port: 43517 }, "另一个 GravityPort 正在使用其他素材库（端口 43517）。请先退出它，再打开此素材库。", "Another GravityPort is using a different library (port 43517). Quit it, then open this library."],
    [{ code: "MOSA_SERVICE_UNVERIFIED", port: 43517 }, "无法确认端口 43517 上的服务是 GravityPort。请退出占用该端口的程序，然后重新打开 GravityPort。", "Couldn’t confirm that the service on port 43517 is GravityPort. Quit the program using that port, then open GravityPort again."],
    [{ code: "MOSA_STARTUP_PORT_OCCUPIED", port: 6453 }, "端口 6453 被其他程序占用。请退出该程序，然后重新打开 GravityPort。", "Port 6453 is in use by another program. Quit it, then open GravityPort again."],
    [{ code: "MOSA_STARTUP_NO_PORT" }, "无法找到可用的本地端口。请重新启动电脑后再试。", "Couldn’t find an available local port. Restart the computer and try again."],
    [{ code: "MOSA_STARTUP_LIBRARY_LOCKED", pid: 4242 }, "此素材库已被另一个 GravityPort 打开（PID 4242）。请退出它，然后重新打开。", "This library is already open in another GravityPort (PID 4242). Quit it, then open GravityPort again."],
    [{ code: "MOSA_STARTUP_HANDOFF_CLAIMED", pid: 4242 }, "另一个 GravityPort 正在启动并使用此素材库（PID 4242）。请稍后再试。", "Another GravityPort is starting and using this library (PID 4242). Try again shortly."],
  ];
  for (const [error, zh, en] of cases) {
    const zhText = getStartupFailureText(error, "zh");
    assert.equal(zhText.title, "GravityPort 无法启动", `${error.code} zh title`);
    assert.equal(zhText.body, zh, `${error.code} zh body`);
    assert.doesNotMatch(zhText.body, /\{port\}|\{pid\}/, `${error.code} zh placeholder filled`);
    const enText = getStartupFailureText(error, "en");
    assert.equal(enText.title, "GravityPort couldn’t start", `${error.code} en title`);
    assert.equal(enText.body, en, `${error.code} en body`);
  }
});

test("getStartupFailureText returns null for unmapped errors and fills unknown for missing fields", () => {
  assert.equal(getStartupFailureText(new Error("boom"), "zh"), null);
  assert.equal(getStartupFailureText({ code: "MOSA_LIBRARY_SCHEMA_NEWER" }, "en"), null, "schema-newer keeps its own dialog");
  assert.equal(getStartupFailureText(null, "zh"), null);
  const noFields = getStartupFailureText({ code: "MOSA_STARTUP_PORT_OCCUPIED" }, "en");
  assert.match(noFields.body, /Port unknown is in use/);
});

// 任务 367（NOTIF-03a/03b）：更新就绪通知文字进表；版本号带 v，正文不带句号。
test("getUpdateReadyNotificationText uses the reviewed copy with a v-prefixed version", () => {
  assert.deepEqual(getUpdateReadyNotificationText("0.3.9", "zh"), { title: "GravityPort v0.3.9 更新已就绪", body: "重启 GravityPort 以完成更新" });
  assert.deepEqual(getUpdateReadyNotificationText("0.3.9", "en"), { title: "GravityPort v0.3.9 update is ready", body: "Restart GravityPort to finish updating" });
  assert.deepEqual(getUpdateReadyNotificationText("v0.3.9", "zh"), { title: "GravityPort v0.3.9 更新已就绪", body: "重启 GravityPort 以完成更新" }, "a leading v is not doubled");
  assert.deepEqual(getUpdateReadyNotificationText("0.3.9", "ja"), { title: "GravityPort v0.3.9 更新已就绪", body: "重启 GravityPort 以完成更新" }, "unknown locale falls back to zh");
});

test("reportStartupFailure shows the library dialog through the i18n table", async () => {
  const source = await readFile(resolve(repositoryRoot, "desktop/main.mjs"), "utf8");
  // 任务 359（NATIVE-03b/09c）：固定正文兜底、细节进日志；库比 App 新带两个按钮。
  assert.match(source, /getLibraryStartupFailureText\(error,\s*currentLocale\)/);
  assert.match(source, /getLibrarySchemaNewerDialogText\(currentLocale\)/);
  assert.match(source, /getDesktopText\("startupErrorBody", currentLocale\)/);
  // 任务 367（NATIVE-03c~03i）：分类启动失败走 getStartupFailureText。
  assert.match(source, /getStartupFailureText\(error,\s*currentLocale\)/);
});
