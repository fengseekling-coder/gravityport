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
    librarySqliteMissingBody: "素材库在 {libraryDir}，迁移后的 mosa.db 找不到了。请从备份恢复 mosa.db 后重新打开 GravityPort。",
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
    librarySqliteMissingBody: "The library is at {libraryDir}, but its migrated mosa.db file is missing. Restore mosa.db from a backup, then open GravityPort again.",
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
};

/**
 * Startup-failure dialog text for a broken-library error, in one language
 * only. Returns null for anything else so generic startup errors keep using
 * the generic startupErrorTitle + error message. The error carries the
 * library directory (error.libraryDir); the body names it.
 */
export function getLibraryStartupFailureText(error, locale) {
  const keys = error && LIBRARY_STARTUP_ERROR_KEYS[error.code];
  if (!keys) return null;
  const libraryDir = typeof error.libraryDir === "string" ? error.libraryDir : "";
  return {
    title: getDesktopText(keys[0], locale),
    body: getDesktopText(keys[1], locale).replace(/\{libraryDir\}/g, libraryDir),
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
