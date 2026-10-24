const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  pasteImage: () => ipcRenderer.invoke("paste-image"),
  writeClipboardText: (text) => ipcRenderer.invoke("write-clipboard-text", text),
  writeClipboardImage: (path) => ipcRenderer.invoke("write-clipboard-image", path),
  writeClipboardFiles: (paths) => ipcRenderer.invoke("write-clipboard-files", paths),
  startNativeDrag: (paths) => ipcRenderer.invoke("start-native-file-drag", paths),
  // Which dropped files already live inside the library — a card dragged out
  // of the window and dropped back must not import a second copy.
  libraryFileFlags: (files) => ipcRenderer.invoke("library-file-flags", Array.from(files || [], (file) => {
    try { return webUtils.getPathForFile(file) || ""; } catch { return ""; }
  })),
  // 任务 239：右键空白处「粘贴」——主进程只回答剪贴板里有没有可导入内容，
  // 再由主进程代按一次粘贴（webContents.paste），剪贴板内容不外传。
  clipboardImportable: () => ipcRenderer.invoke("clipboard-importable"),
  pasteFromClipboard: () => ipcRenderer.invoke("paste-from-clipboard"),
  setLocale: (locale) => ipcRenderer.invoke("set-locale", locale),
  getUserProfile: () => ipcRenderer.invoke("user-profile"),
  // 任务 116：老用户「已更名」提示——取启动早期判定结果、确认已读。
  getRenameNoticeState: () => ipcRenderer.invoke("rename-notice-state"),
  acknowledgeRenameNotice: () => ipcRenderer.invoke("acknowledge-rename-notice"),
  checkForUpdates: (notify = false) =>
    ipcRenderer.invoke("check-for-updates", notify === true),
  downloadAndInstallUpdate: () => ipcRenderer.invoke("download-and-install-update"),
  cancelUpdateDownload: () => ipcRenderer.invoke("cancel-update-download"),
  // 任务 231：主进程已把校验过的更新包放进 staging，渲染层查询 + 订阅广播，
  // 侧栏常驻「重启并更新」按钮据此显示。
  getUpdateReady: () => ipcRenderer.invoke("get-update-ready"),
  onUpdateReady: (callback) =>
    ipcRenderer.on("update-ready", (_event, payload) => callback(payload)),
  reportRendererReady: () => ipcRenderer.invoke("renderer-ready"),
  onUpdateDownloadProgress: (callback) =>
    ipcRenderer.on("update-download-progress", (_event, progress) => callback(progress)),
  openDownloadPage: () => ipcRenderer.invoke("open-download-page"),
  openPinterestAuthorize: (url) => ipcRenderer.invoke("open-pinterest-authorize", url),
  openExternalLink: (url) => ipcRenderer.invoke("open-external-link", url),
  changeLibraryLocation: () => ipcRenderer.invoke("change-library-location"),
  getMcpClientConfig: () => ipcRenderer.invoke("mcp-client-config"),
  onMenuSearch: (callback) => ipcRenderer.on("menu-search", (_event, ...args) => callback(...args)),
  // 任务 96（A6）：大图页「全屏」与窗口系统全屏双向同步——渲染层写窗口全屏态、
  // 订阅主进程广播的 enter/leave-full-screen 变化。
  setWindowFullScreen: (flag) => ipcRenderer.invoke("set-window-full-screen", flag === true),
  onWindowFullScreenChange: (callback) =>
    ipcRenderer.on("window-full-screen-change", (_event, isFullScreen) => callback(isFullScreen === true)),
});
