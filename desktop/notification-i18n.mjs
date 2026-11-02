/**
 * Desktop notification internationalization module.
 * Exports pure functions for the desktop notifications GravityPort actually emits.
 * Desktop menu labels are resolved separately so native role items can follow
 * the renderer's app locale without changing the notification API.
 * Supports {count} placeholder for dynamically-counted messages.
 * Default language is "zh" to preserve existing first-run behavior.
 */

const translations = {
  zh: {
    assetsImported: "{count} 个新素材已导入",
    updateAvailableTitle: "GravityPort {version} 可更新",
    updateAvailableBody: "新版本已发布，点击打开 GravityPort 查看更新。",
  },
  en: {
    assetsImported: "{count} new assets imported",
    assetsImportedSingular: "1 new asset imported",
    updateAvailableTitle: "GravityPort {version} is available",
    updateAvailableBody: "A new version is available. Click to open GravityPort and review the update.",
  },
};

const desktopTranslations = {
  zh: {
    menuFile: "文件",
    menuEdit: "编辑",
    menuView: "视图",
    menuSearch: "搜索",
    menuWindow: "窗口",
    menuAbout: "关于 GravityPort",
    menuServices: "服务",
    menuHide: "隐藏 GravityPort",
    menuHideOthers: "隐藏其他",
    menuShowAll: "显示全部",
    menuQuit: "退出 GravityPort",
    menuClose: "关闭",
    menuUndo: "撤销",
    menuRedo: "重做",
    menuCut: "剪切",
    menuCopy: "拷贝",
    menuPaste: "粘贴",
    menuPasteAndMatchStyle: "粘贴并匹配样式",
    menuDelete: "删除",
    menuSelectAll: "全选",
    menuResetZoom: "重置缩放",
    menuZoomIn: "放大",
    menuZoomOut: "缩小",
    menuToggleFullScreen: "进入全屏",
    menuMinimize: "最小化",
    menuZoom: "缩放",
    menuBringAllToFront: "将全部置于最前",
    startupErrorTitle: "GravityPort 无法启动",
    libraryDatabaseMissingTitle: "素材库的数据库文件不见了",
    libraryDatabaseMissingBody: "素材库在 {libraryDir}，里面的 mosa.db 找不到了。请从备份恢复 mosa.db 后重新打开 GravityPort。",
    libraryStateInvalidTitle: "素材库状态不完整",
    libraryStateInvalidBody: "素材库在 {libraryDir}，数据库没有标记为已就绪。请从备份恢复素材库后重新打开 GravityPort。",
    librarySqliteMissingTitle: "素材库的数据库文件不见了",
    librarySqliteMissingBody: "素材库在 {libraryDir}，里面的 mosa.db 找不到了。请从备份恢复 mosa.db 后重新打开 GravityPort。",
    // 任务 337：库校验失败按「被占用」和「打不开/损坏」分开报，正文末尾带原始
    // SQLite 错误码，方便用户截图回来定位。
    librarySqliteBusyTitle: "素材库正被别的程序占用",
    librarySqliteBusyBody: "素材库在 {libraryDir}，它的数据库文件 mosa.db 暂时打不开，可能有别的程序正在使用它。请关掉其他程序或重启电脑后再打开 GravityPort。不要删除或移动素材库里的文件。错误码：{sqliteCode}。",
    librarySqliteUnreadableTitle: "素材库的数据库打不开",
    librarySqliteUnreadableBody: "素材库在 {libraryDir}，它的数据库文件 mosa.db 读取失败。请先不要删除或修改素材库里的任何文件，把整个素材库文件夹复制一份留存，再联系我们。错误码：{sqliteCode}。",
    // Update install failures and install preflight (main process system dialogs).
    updateFailedOnceTitle: "GravityPort {version} 没有装上",
    updateFailedOnceBody: "{reason}已退回 {currentVersion}，下次重启 GravityPort 时会再试一次。",
    updateFailedOnceButton: "知道了",
    updateFailedTwiceTitle: "GravityPort {version} 两次都没有装上",
    updateFailedTwiceBody: "{reason}请到官网下载新版安装，素材库不受影响。",
    updateFailedTwiceDownload: "去官网下载",
    updateFailedTwiceLater: "以后再说",
    updateReasonINSTALL_DIR_BUSY: "安装文件被别的程序占用（常见是 AI 助手的 MCP）。",
    updateReasonTARGET_EXISTS: "应用程序文件夹里已经有一个 GravityPort.app。",
    updateReasonEXTRACT_FAILED: "解压更新包失败，可能是磁盘空间不够。",
    updateReasonVERIFY_FAILED: "更新包没有通过校验。",
    updateReasonREPLACE_FAILED: "替换旧版本时没有写入权限。",
    updateReasonNEW_VERSION_FAILED: "新版本没能正常启动。",
    updateReasonUNKNOWN: "安装过程出错。",
    updatePreflightMcpTitle: "请先退出 AI 助手",
    updatePreflightMcpBody: "Claude、Codex 等 AI 助手正在通过 MCP 使用 GravityPort，会占住安装文件，这时更新装不上。退出这些 AI 助手后点「重试」。",
    updatePreflightMcpRetry: "重试",
    updatePreflightMcpCancel: "取消",
    updatePreflightSpaceTitle: "磁盘空间不够，装不了更新",
    updatePreflightSpaceBody: "更新需要约 {needed} 的空闲空间，现在只有 {available}。清出空间后再点「重启更新」。",
    updatePreflightSpaceButton: "知道了",
    updatePreflightWritableTitle: "装不了更新",
    updatePreflightWritableBody: "GravityPort 所在的文件夹不能写入。请到官网下载新版安装。",
    updatePreflightWritableDownload: "去官网下载",
    updatePreflightWritableCancel: "取消",
    // 审查 3-6 甲（任务 318）：打开白名单以外的外链前的系统确认框。
    externalLinkConfirmTitle: "要在浏览器中打开 {host} 吗？",
    externalLinkConfirmBody: "这个网址不属于 GravityPort，会用默认浏览器打开：{url}",
    externalLinkConfirmOpen: "在浏览器中打开",
    externalLinkConfirmCancel: "取消",
  },
  en: {
    menuFile: "File",
    menuEdit: "Edit",
    menuView: "View",
    menuSearch: "Search",
    menuWindow: "Window",
    menuAbout: "About GravityPort",
    menuServices: "Services",
    menuHide: "Hide GravityPort",
    menuHideOthers: "Hide Others",
    menuShowAll: "Show All",
    menuQuit: "Quit GravityPort",
    menuClose: "Close",
    menuUndo: "Undo",
    menuRedo: "Redo",
    menuCut: "Cut",
    menuCopy: "Copy",
    menuPaste: "Paste",
    menuPasteAndMatchStyle: "Paste and Match Style",
    menuDelete: "Delete",
    menuSelectAll: "Select All",
    menuResetZoom: "Reset Zoom",
    menuZoomIn: "Zoom In",
    menuZoomOut: "Zoom Out",
    menuToggleFullScreen: "Toggle Full Screen",
    menuMinimize: "Minimize",
    menuZoom: "Zoom",
    menuBringAllToFront: "Bring All to Front",
    startupErrorTitle: "GravityPort could not start",
    libraryDatabaseMissingTitle: "Your library's database is missing",
    libraryDatabaseMissingBody: "The library is at {libraryDir}, but its mosa.db file is missing. Restore mosa.db from a backup, then open GravityPort again.",
    libraryStateInvalidTitle: "Your library is in an incomplete state",
    libraryStateInvalidBody: "The library is at {libraryDir}, and its database was never marked as ready. Restore the library from a backup, then open GravityPort again.",
    librarySqliteMissingTitle: "Your library's database is missing",
    librarySqliteMissingBody: "The library is at {libraryDir}, but its mosa.db file is missing. Restore mosa.db from a backup, then open GravityPort again.",
    // 任务 337：被占用与打不开/损坏分开报，正文末尾同样带原始 SQLite 错误码。
    librarySqliteBusyTitle: "Your library is in use by another program",
    librarySqliteBusyBody: "The library is at {libraryDir}, but its mosa.db database file cannot be opened right now — another program may be using it. Close other programs or restart your computer, then open GravityPort again. Do not delete or move any files inside the library folder. Error code: {sqliteCode}.",
    librarySqliteUnreadableTitle: "Your library's database could not be opened",
    librarySqliteUnreadableBody: "The library is at {libraryDir}, but its mosa.db database file could not be read. Do not delete or modify anything in the library folder. Keep a copy of the whole library folder, then contact us. Error code: {sqliteCode}.",
    // Update install failures and install preflight (main process system dialogs).
    updateFailedOnceTitle: "GravityPort {version} did not install",
    updateFailedOnceBody: "{reason} The app went back to {currentVersion}. GravityPort will try again the next time you restart it.",
    updateFailedOnceButton: "OK",
    updateFailedTwiceTitle: "GravityPort {version} failed to install twice",
    updateFailedTwiceBody: "{reason} Download the new version from the website and install it. Your library is not affected.",
    updateFailedTwiceDownload: "Download from Website",
    updateFailedTwiceLater: "Later",
    updateReasonINSTALL_DIR_BUSY: "Install files are in use by another program, often an AI assistant's MCP connection.",
    updateReasonTARGET_EXISTS: "The Applications folder already contains a GravityPort.app.",
    updateReasonEXTRACT_FAILED: "The update package could not be unpacked, possibly because the disk is full.",
    updateReasonVERIFY_FAILED: "The update package did not pass verification.",
    updateReasonREPLACE_FAILED: "The old version could not be replaced because the folder is not writable.",
    updateReasonNEW_VERSION_FAILED: "The new version did not start properly.",
    updateReasonUNKNOWN: "The install stopped with an error.",
    updatePreflightMcpTitle: "Quit your AI assistants first",
    updatePreflightMcpBody: "Claude, Codex and other AI assistants are using GravityPort through MCP. They keep the install files in use, so the update cannot be installed now. Quit those assistants, then click Retry.",
    updatePreflightMcpRetry: "Retry",
    updatePreflightMcpCancel: "Cancel",
    updatePreflightSpaceTitle: "Not enough disk space to install the update",
    updatePreflightSpaceBody: "The update needs about {needed} of free space, and only {available} is available. Free up space, then click Restart to Update.",
    updatePreflightSpaceButton: "OK",
    updatePreflightWritableTitle: "The update cannot be installed",
    updatePreflightWritableBody: "The folder GravityPort is in cannot be written to. Download the new version from the website and install it.",
    updatePreflightWritableDownload: "Download from Website",
    updatePreflightWritableCancel: "Cancel",
    // 审查 3-6 甲（任务 318）：confirm dialog before opening a non-allowlisted link.
    externalLinkConfirmTitle: "Open {host} in your browser?",
    externalLinkConfirmBody: "This link isn't part of GravityPort. It will open in your default browser: {url}",
    externalLinkConfirmOpen: "Open in Browser",
    externalLinkConfirmCancel: "Cancel",
  },
};

/**
 * Resolve a native desktop label. Unknown keys fail loudly so adding a menu
 * item cannot silently reintroduce an untranslated string.
 */
export function getDesktopText(key, locale) {
  if (!Object.prototype.hasOwnProperty.call(desktopTranslations.zh, key)) {
    throw new Error(`Unsupported desktop key: ${key}`);
  }
  const language = locale === "zh" || locale === "en" ? locale : "zh";
  return desktopTranslations[language][key];
}

// Library errors the store layer throws during startup (lib/asset-store.mjs);
// each maps to its own title/body pair in the desktopTranslations table.
const LIBRARY_STARTUP_ERROR_KEYS = {
  MOSA_LIBRARY_DATABASE_MISSING: ["libraryDatabaseMissingTitle", "libraryDatabaseMissingBody"],
  MOSA_LIBRARY_STATE_INVALID: ["libraryStateInvalidTitle", "libraryStateInvalidBody"],
  SQLITE_LIBRARY_MISSING: ["librarySqliteMissingTitle", "librarySqliteMissingBody"],
  SQLITE_LIBRARY_BUSY: ["librarySqliteBusyTitle", "librarySqliteBusyBody"],
  SQLITE_LIBRARY_UNREADABLE: ["librarySqliteUnreadableTitle", "librarySqliteUnreadableBody"],
};

/**
 * Startup-failure dialog text for a broken-library error, in one language
 * only. Returns null for anything else so generic startup errors keep using
 * the generic startupErrorTitle + error message. The error carries the
 * library directory (error.libraryDir); the body names it. 任务 337：库校验
 * 失败的错误（lib/sqlite-asset-store.mjs）还带原始 SQLite 错误码
 * （error.sqliteCode），正文末尾用它替换 {sqliteCode}。
 */
export function getLibraryStartupFailureText(error, locale) {
  const keys = error && LIBRARY_STARTUP_ERROR_KEYS[error.code];
  if (!keys) return null;
  const libraryDir = typeof error.libraryDir === "string" ? error.libraryDir : "";
  const sqliteCode = typeof error.sqliteCode === "string" && error.sqliteCode ? error.sqliteCode : "unknown";
  return {
    title: getDesktopText(keys[0], locale),
    body: getDesktopText(keys[1], locale)
      .replace(/\{libraryDir\}/g, libraryDir)
      .replace(/\{sqliteCode\}/g, sqliteCode),
  };
}

/**
 * Get the final text for the assets-imported notification, replacing the count.
 * English uses the singular form for exactly one imported asset.
 *
 * @param {number} count - Positive integer representing the number of imported assets
 * @param {string} locale - Current locale ("zh" or "en", defaults to "zh")
 * @returns {string} - Fully resolved notification body
 */
export function getNotificationTextForAssetsImported(count, locale) {
  const lang = (locale === "zh" || locale === "en") ? locale : "zh";
  if (lang === "en" && count === 1) {
    return translations.en.assetsImportedSingular;
  }
  const template = translations[lang].assetsImported;
  return template.replace(/\{count\}/g, String(count));
}

export function getUpdateNotificationText(version, locale) {
  const lang = (locale === "zh" || locale === "en") ? locale : "zh";
  return {
    title: translations[lang].updateAvailableTitle.replace(/\{version\}/g, `v${String(version || "").replace(/^v/i, "")}`),
    body: translations[lang].updateAvailableBody,
  };
}
