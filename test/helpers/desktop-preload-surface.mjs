// 任务 444：preload 暴露面清单原来抄在三个测试文件里（desktop-i18n-contract、
// import-staging-contract、electron-preload-runtime-contract），改一处漏两处就
// 互相打架；收敛为这份唯一来源，键名排序、逐键注释取自原三份并集。
export const EXPECTED_PRELOAD_API_KEYS = Object.freeze([
  "acknowledgeRenameNotice",
  "cancelUpdateDownload",
  "changeLibraryLocation",
  "checkForUpdates",
  "clipboardImportable", // 任务 239：只回答剪贴板里有没有可导入内容，不传路径和字节
  "downloadAndInstallUpdate",
  "getBackgroundCaptureState", // 任务 329：只读，后台收录开关状态
  "getClientToken", // 任务 311：客户端凭据不进网址片段，主进程只对已核实服务 origin 上的主框架回答
  "getInstallationId", // 11-16：左下角显示安装编号（只读通道 installation-id）
  "getMcpClientConfig", // 任务 208：只读，本机 App 路径拼成的 MCP 配置文本
  "getRenameNoticeState",
  "getUpdateReady", // 任务 231：只读，主进程已下好并校验的更新包状态
  "libraryFileFlags", // drop-back guard: which dropped files already live in the library (booleans only)
  "onMenuSearch",
  "onMenuSelectAll", // 任务 384：全选不走 role，经 menu-select-all 转给网页
  "onUpdateDownloadProgress",
  "onUpdateReady", // 任务 231：主进程广播「已下好」，与 getUpdateReady 成对
  "onWindowFullScreenChange",
  "openDownloadPage",
  "openExternalLink", // 任务 147：第 22 条 open-external-link（Pinterest Pin 外链，仅 http/https）
  "openPinterestAuthorize", // 任务 135：第 21 条 open-pinterest-authorize（Pinterest 授权页，只放行 https://www.pinterest.com/oauth/）
  "pasteFromClipboard", // 任务 239：主进程对主窗口执行一次 webContents.paste，导入走渲染层统一 paste 监听
  "pasteImage",
  "reportRendererReady",
  "revealManagedExtensionFolder",
  "setBackgroundCapture", // 任务 329：布尔开关，主进程核实来源后写设置
  "setLocale",
  "setWindowFullScreen",
  "startNativeDrag",
  "writeClipboardFiles",
  "writeClipboardImage",
  "writeClipboardText",
]);

// desktop/preload.cjs 里 ipcRenderer.invoke 的个数，以代码为准（新增批准通道时
// 这里同步 +1，三份引用方共用）。
export const EXPECTED_PRELOAD_INVOKE_COUNT = 27;
