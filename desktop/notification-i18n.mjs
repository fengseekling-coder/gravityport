/**
 * Desktop notification internationalization module.
 * Exports pure functions for the desktop notifications GravityPort actually emits.
 * Desktop menu labels are resolved separately so native role items can follow
 * the renderer's app locale without changing the notification API.
 * Supports {count} placeholder for dynamically-counted messages.
 * Default language is "zh" to preserve existing first-run behavior.
 */

// 任务 359（NOTIF-01/02）：系统通知标题说事件、正文一句细节、不带句号。
const translations = {
  zh: {
    assetsImported: "已导入 {count} 个新素材",
    updateAvailableTitle: "GravityPort {version} 可用",
    updateAvailableBody: "点击查看更新内容",
    // 任务 367（NOTIF-03a/03b）：更新就绪通知文字从 update-scheduler.mjs 搬进
    // 本表；版本号统一带 v，通知正文不带句号。
    updateReadyTitle: "GravityPort v{version} 更新已就绪",
    updateReadyBody: "重启 GravityPort 以完成更新",
  },
  en: {
    assetsImported: "Imported {count} new assets",
    assetsImportedSingular: "Imported 1 new asset",
    updateAvailableTitle: "GravityPort {version} is available",
    updateAvailableBody: "Click to view what’s new",
    // Task 367 (NOTIF-03a/03b): update-ready copy moved here from
    // update-scheduler.mjs; the version is v-prefixed, the body has no period.
    updateReadyTitle: "GravityPort v{version} update is ready",
    updateReadyBody: "Restart GravityPort to finish updating",
  },
};

const desktopTranslations = {
  zh: {
    menuFile: "文件",
    menuEdit: "编辑",
    menuView: "显示",
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
    menuResetZoom: "实际大小",
    menuZoomIn: "放大",
    menuZoomOut: "缩小",
    menuToggleFullScreen: "进入全屏幕",
    menuMinimize: "最小化",
    menuZoom: "缩放",
    menuBringAllToFront: "前置全部窗口",
    // 任务 359：原生框文字照定稿（NATIVE-01~18）。标题统一说结果（无法打开
    // 素材库），原因进正文；文件名 mosa.db 只在要用户找文件的提示里出现。
    startupErrorTitle: "GravityPort 无法启动",
    startupErrorBody: "GravityPort 启动时出现未知错误。请重新启动电脑后再试。",
    libraryLocationMissingTitle: "无法打开素材库",
    libraryLocationMissingBody: "找不到上次使用的素材库（{libraryDir}）。如果它位于外接硬盘，请连接后重新打开 GravityPort。",
    libraryLocationFileUnreadableTitle: "无法打开素材库",
    libraryLocationFileUnreadableBody: "无法读取记录素材库位置的文件（{locationFile}）。为避免新建空素材库，GravityPort 已停止启动。",
    libraryDatabaseMissingTitle: "无法打开素材库",
    libraryDatabaseMissingBody: "素材库（{libraryDir}）缺少数据文件（mosa.db）。请从备份恢复该文件，然后重新打开 GravityPort。",
    libraryStateInvalidTitle: "无法打开素材库",
    libraryStateInvalidBody: "素材库（{libraryDir}）的数据不完整。请从备份恢复素材库，然后重新打开 GravityPort。",
    librarySqliteMissingTitle: "无法打开素材库",
    librarySqliteMissingBody: "素材库（{libraryDir}）缺少数据文件（mosa.db）。请从备份恢复该文件，然后重新打开 GravityPort。",
    // 任务 337：库校验失败按「被占用」和「打不开/损坏」分开报，错误码放句末括号。
    librarySqliteBusyTitle: "无法打开素材库",
    librarySqliteBusyBody: "素材库（{libraryDir}）的数据文件（mosa.db）暂时无法打开，可能正被其他程序使用。关闭其他程序或重启电脑后，重新打开 GravityPort。请勿删除或移动素材库中的文件。（错误码：{sqliteCode}）",
    librarySqliteUnreadableTitle: "无法打开素材库",
    librarySqliteUnreadableBody: "无法读取素材库（{libraryDir}）的数据文件（mosa.db）。请勿删除或修改素材库中的任何文件，先复制整个素材库文件夹留存，然后前往官网反馈此问题。（错误码：{sqliteCode}）",
    // 任务 350：库比当前 App 新——库文件一个字节都没动，只提示去下载新版。
    librarySchemaNewerTitle: "需要更新 GravityPort",
    librarySchemaNewerBody: "此素材库已由更新版本的 GravityPort 打开过，当前版本无法打开。请前往官网下载最新版本。素材未被改动。",
    librarySchemaNewerDownload: "前往官网下载",
    librarySchemaNewerCancel: "取消",
    // 任务 367（NATIVE-03c~03i）：启动失败按错误码分类——service-manager /
    // runtime-lock / runtime-handoff 抛 MOSA_* 码，这里按码选正文（标题统一
    // 用 NATIVE-03a 的 startupErrorTitle）；英文原句留在 message 里只进日志。
    startupOtherBuildBody: "另一个版本的 GravityPort 正在使用此素材库。请退出它，然后重新打开 GravityPort。",
    startupPortOtherLibraryBody: "另一个 GravityPort 正在使用其他素材库（端口 {port}）。请先退出它，再打开此素材库。",
    startupPortUnverifiedBody: "无法确认端口 {port} 上的服务是 GravityPort。请退出占用该端口的程序，然后重新打开 GravityPort。",
    startupPortOccupiedBody: "端口 {port} 被其他程序占用。请退出该程序，然后重新打开 GravityPort。",
    startupNoPortBody: "无法找到可用的本地端口。请重新启动电脑后再试。",
    startupLibraryLockedBody: "此素材库已被另一个 GravityPort 打开（PID {pid}）。请退出它，然后重新打开。",
    startupHandoffClaimedBody: "另一个 GravityPort 正在启动并使用此素材库（PID {pid}）。请稍后再试。",
    // 更新安装失败与安装前检查（NATIVE-10~14）。
    updateFailedOnceTitle: "无法安装 GravityPort v{version}",
    updateFailedOnceBody: "{reason}已恢复为 v{currentVersion}，下次启动 GravityPort 时将再次尝试。",
    updateFailedOnceButton: "好",
    updateFailedTwiceTitle: "无法安装 GravityPort v{version}",
    updateFailedTwiceBody: "{reason}已连续两次尝试。请前往官网下载新版本并手动安装。素材库不受影响。",
    updateFailedTwiceDownload: "前往官网下载",
    updateFailedTwiceLater: "取消",
    updateReasonINSTALL_DIR_BUSY: "安装文件正被其他程序占用（常见于 AI 助手的 MCP 连接）。",
    updateReasonTARGET_EXISTS: "「应用程序」文件夹中已存在 GravityPort.app。",
    updateReasonEXTRACT_FAILED: "无法解压更新包，可能是磁盘空间不足。",
    updateReasonVERIFY_FAILED: "更新包未通过校验。",
    updateReasonREPLACE_FAILED: "没有写入权限，无法替换旧版本。",
    updateReasonNEW_VERSION_FAILED: "新版本无法正常启动。",
    updateReasonUNKNOWN: "安装过程中出现错误。",
    updatePreflightMcpTitle: "请先退出 AI 助手",
    updatePreflightMcpBody: "Claude、Codex 等 AI 助手正通过 MCP 使用 GravityPort，占用了安装文件，更新暂时无法安装。退出这些 AI 助手后重试。",
    updatePreflightMcpRetry: "重试",
    updatePreflightMcpCancel: "取消",
    updatePreflightSpaceTitle: "磁盘空间不足，无法安装更新",
    updatePreflightSpaceBody: "更新需要约 {needed} 可用空间，当前仅有 {available}。清理磁盘空间后重试。",
    updatePreflightSpaceButton: "好",
    updatePreflightWritableTitle: "无法安装更新",
    updatePreflightWritableBody: "GravityPort 所在的文件夹没有写入权限。请前往官网下载新版本并手动安装。",
    updatePreflightWritableDownload: "前往官网下载",
    updatePreflightWritableCancel: "取消",
    // 审查 3-6 甲（任务 318）/ 任务 359（NATIVE-15）：外链确认，执行按钮用标题动词。
    externalLinkConfirmTitle: "在浏览器中打开 {host}？",
    externalLinkConfirmBody: "此网址不属于 GravityPort，将在默认浏览器中打开：{url}",
    externalLinkConfirmOpen: "打开",
    externalLinkConfirmCancel: "取消",
    // 任务 359（NATIVE-16/17/18）：原先写死或只有英文的三组，并入本表。
    chooseLibraryLocationTitle: "选择素材库的新位置",
    chooseLibraryLocationButton: "选择",
    moveLibraryTitle: "移动素材库",
    moveLibraryMessage: "将素材库移到所选文件夹？",
    moveLibraryDetail: "GravityPort 将先关闭，复制全部素材及相关信息，然后自动重启。复制完成前不会删除原素材库。",
    moveLibraryCancel: "取消",
    moveLibraryRestart: "移动并重启",
    rendererCrashBody: "GravityPort 的界面意外停止，且无法自动恢复。",
    rendererCrashRestart: "重新启动",
    rendererCrashClose: "关闭",
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
    menuResetZoom: "Actual Size",
    menuZoomIn: "Zoom In",
    menuZoomOut: "Zoom Out",
    menuToggleFullScreen: "Enter Full Screen",
    menuMinimize: "Minimize",
    menuZoom: "Zoom",
    menuBringAllToFront: "Bring All to Front",
    // Task 359: native dialog copy per the reviewed wording (NATIVE-01~18).
    startupErrorTitle: "GravityPort couldn’t start",
    startupErrorBody: "GravityPort ran into an unknown error while starting. Restart the computer and try again.",
    libraryLocationMissingTitle: "Couldn’t open the library",
    libraryLocationMissingBody: "The library last used ({libraryDir}) can’t be found. If it’s on an external drive, connect it and open GravityPort again.",
    libraryLocationFileUnreadableTitle: "Couldn’t open the library",
    libraryLocationFileUnreadableBody: "Couldn’t read the file that records the library location ({locationFile}). GravityPort stopped to avoid creating an empty library.",
    libraryDatabaseMissingTitle: "Couldn’t open the library",
    libraryDatabaseMissingBody: "The library ({libraryDir}) is missing its data file (mosa.db). Restore it from a backup, then open GravityPort again.",
    libraryStateInvalidTitle: "Couldn’t open the library",
    libraryStateInvalidBody: "The data in the library ({libraryDir}) is incomplete. Restore the library from a backup, then open GravityPort again.",
    librarySqliteMissingTitle: "Couldn’t open the library",
    librarySqliteMissingBody: "The library ({libraryDir}) is missing its data file (mosa.db). Restore it from a backup, then open GravityPort again.",
    // 任务 337：被占用与打不开/损坏分开报，错误码放句末括号。
    librarySqliteBusyTitle: "Couldn’t open the library",
    librarySqliteBusyBody: "The data file (mosa.db) in the library ({libraryDir}) can’t be opened right now. Another program may be using it. Close other programs or restart the computer, then open GravityPort again. Don’t delete or move any files in the library folder. (Error code: {sqliteCode})",
    librarySqliteUnreadableTitle: "Couldn’t open the library",
    librarySqliteUnreadableBody: "Couldn’t read the data file (mosa.db) in the library ({libraryDir}). Don’t delete or modify any files in the library folder. Copy the whole library folder as a backup, then report the issue on the website. (Error code: {sqliteCode})",
    // Task 350: the library is newer than this build — nothing was touched,
    // the user only needs the latest release.
    librarySchemaNewerTitle: "GravityPort update required",
    librarySchemaNewerBody: "This library was last opened by a newer version of GravityPort, so this version can’t open it. Download the latest version from the website. No assets were modified.",
    librarySchemaNewerDownload: "Download from website",
    librarySchemaNewerCancel: "Cancel",
    // Task 367 (NATIVE-03c~03i): startup failures by error code — see the zh
    // block above. The English originals stay in error.message for the log.
    startupOtherBuildBody: "Another version of GravityPort is using this library. Quit it, then open GravityPort again.",
    startupPortOtherLibraryBody: "Another GravityPort is using a different library (port {port}). Quit it, then open this library.",
    startupPortUnverifiedBody: "Couldn’t confirm that the service on port {port} is GravityPort. Quit the program using that port, then open GravityPort again.",
    startupPortOccupiedBody: "Port {port} is in use by another program. Quit it, then open GravityPort again.",
    startupNoPortBody: "Couldn’t find an available local port. Restart the computer and try again.",
    startupLibraryLockedBody: "This library is already open in another GravityPort (PID {pid}). Quit it, then open GravityPort again.",
    startupHandoffClaimedBody: "Another GravityPort is starting and using this library (PID {pid}). Try again shortly.",
    // Update install failures and install preflight (NATIVE-10~14).
    updateFailedOnceTitle: "Couldn’t install GravityPort v{version}",
    updateFailedOnceBody: "{reason} GravityPort has been restored to v{currentVersion}. Another attempt will be made the next time it opens.",
    updateFailedOnceButton: "OK",
    updateFailedTwiceTitle: "Couldn’t install GravityPort v{version}",
    updateFailedTwiceBody: "{reason} Two attempts have failed. Download the new version from the website and install it manually. The library isn’t affected.",
    updateFailedTwiceDownload: "Download from website",
    updateFailedTwiceLater: "Cancel",
    updateReasonINSTALL_DIR_BUSY: "Install files are in use by another program, often an AI assistant’s MCP connection.",
    updateReasonTARGET_EXISTS: "GravityPort.app already exists in the Applications folder.",
    updateReasonEXTRACT_FAILED: "The update package couldn’t be unpacked. The disk may be full.",
    updateReasonVERIFY_FAILED: "The update package didn’t pass verification.",
    updateReasonREPLACE_FAILED: "The old version couldn’t be replaced because the folder isn’t writable.",
    updateReasonNEW_VERSION_FAILED: "The new version didn’t start correctly.",
    updateReasonUNKNOWN: "The installation stopped because of an error.",
    updatePreflightMcpTitle: "Quit AI assistants first",
    updatePreflightMcpBody: "AI assistants such as Claude and Codex are using GravityPort through MCP and holding the install files, so the update can’t be installed now. Quit them, then try again.",
    updatePreflightMcpRetry: "Retry",
    updatePreflightMcpCancel: "Cancel",
    updatePreflightSpaceTitle: "Not enough disk space to install the update",
    updatePreflightSpaceBody: "The update needs about {needed} of free space, but only {available} is available. Free up space, then try again.",
    updatePreflightSpaceButton: "OK",
    updatePreflightWritableTitle: "The update couldn’t be installed",
    updatePreflightWritableBody: "GravityPort’s folder isn’t writable. Download the new version from the website and install it manually.",
    updatePreflightWritableDownload: "Download from website",
    updatePreflightWritableCancel: "Cancel",
    // 任务 318 / 359（NATIVE-15）：confirm dialog before opening a non-allowlisted link.
    externalLinkConfirmTitle: "Open {host} in the default browser?",
    externalLinkConfirmBody: "This link isn’t part of GravityPort. It will open in the default browser: {url}",
    externalLinkConfirmOpen: "Open",
    externalLinkConfirmCancel: "Cancel",
    // Task 359（NATIVE-16/17/18）: previously inlined or English-only strings.
    chooseLibraryLocationTitle: "Choose a new library location",
    chooseLibraryLocationButton: "Choose",
    moveLibraryTitle: "Move library",
    moveLibraryMessage: "Move the library to the selected folder?",
    moveLibraryDetail: "GravityPort will close, copy all assets and their information, then restart automatically. The original library isn’t removed until the copy is complete.",
    moveLibraryCancel: "Cancel",
    moveLibraryRestart: "Move and restart",
    rendererCrashBody: "GravityPort’s interface stopped unexpectedly and couldn’t recover automatically.",
    rendererCrashRestart: "Restart",
    rendererCrashClose: "Close",
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
  MOSA_LIBRARY_SCHEMA_NEWER: ["librarySchemaNewerTitle", "librarySchemaNewerBody"],
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
 * 任务 359（NATIVE-09）：库比 App 新的对话框带「前往官网下载 / 取消」两个
 * 按钮（此前只有系统自带的「好」，正文却让用户去官网）。仅这个错误码给按钮。
 */
export function getLibrarySchemaNewerDialogText(locale) {
  return {
    title: getDesktopText("librarySchemaNewerTitle", locale),
    body: getDesktopText("librarySchemaNewerBody", locale),
    buttons: [getDesktopText("librarySchemaNewerDownload", locale), getDesktopText("librarySchemaNewerCancel", locale)],
  };
}

// 任务 367（NATIVE-03c~03i）：启动失败错误码 → desktopTranslations 里的正文
// 键。标题统一 startupErrorTitle（NATIVE-03a，定稿「不改」）。未列出的码
// 返回 null，reportStartupFailure 照旧走 NATIVE-03b 兜底句。
const STARTUP_FAILURE_BODY_KEYS = {
  MOSA_SERVICE_BUILD_MISMATCH: "startupOtherBuildBody",
  MOSA_SERVICE_LIBRARY_MISMATCH: "startupPortOtherLibraryBody",
  MOSA_SERVICE_UNVERIFIED: "startupPortUnverifiedBody",
  MOSA_STARTUP_PORT_OCCUPIED: "startupPortOccupiedBody",
  MOSA_STARTUP_NO_PORT: "startupNoPortBody",
  MOSA_STARTUP_LIBRARY_LOCKED: "startupLibraryLockedBody",
  MOSA_STARTUP_HANDOFF_CLAIMED: "startupHandoffClaimedBody",
};

/**
 * Startup-failure dialog text for a classified startup error, in one
 * language. Returns null for anything unmapped so the NATIVE-03b fallback
 * stays in charge. {port}/{pid} come from the error object's fields; the
 * English originals in error.message only ever reach the log.
 */
export function getStartupFailureText(error, locale) {
  const bodyKey = error && STARTUP_FAILURE_BODY_KEYS[error.code];
  if (!bodyKey) return null;
  const fieldText = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "string" && value.trim()) return value.trim();
    return "unknown";
  };
  return {
    title: getDesktopText("startupErrorTitle", locale),
    body: getDesktopText(bodyKey, locale)
      .replace(/\{port\}/g, fieldText(error.port))
      .replace(/\{pid\}/g, fieldText(error.pid)),
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

/**
 * 任务 367（NOTIF-03a/03b）：更新就绪通知的中英文（update-scheduler.mjs 搬
 * 进本表）。模板里 v 已写死（定稿「GravityPort v{version} 更新已就绪」），
 * 这里只归一化传入的版本号（剥掉可能带的 v），不再补 v；通知正文不带句号。
 */
export function getUpdateReadyNotificationText(version, locale) {
  const lang = (locale === "zh" || locale === "en") ? locale : "zh";
  return {
    title: translations[lang].updateReadyTitle.replace(/\{version\}/g, String(version || "").replace(/^v/i, "")),
    body: translations[lang].updateReadyBody,
  };
}
