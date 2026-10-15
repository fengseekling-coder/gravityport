const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  pasteImage: () => ipcRenderer.invoke("paste-image"),
  writeClipboardText: (text) => ipcRenderer.invoke("write-clipboard-text", text),
  writeClipboardImage: (path) => ipcRenderer.invoke("write-clipboard-image", path),
  startNativeDrag: (paths) => ipcRenderer.invoke("start-native-file-drag", paths),
  setLocale: (locale) => ipcRenderer.invoke("set-locale", locale),
  getUserProfile: () => ipcRenderer.invoke("user-profile"),
  // 任务 116：老用户「已更名」提示——取启动早期判定结果、确认已读。
  getRenameNoticeState: () => ipcRenderer.invoke("rename-notice-state"),
  acknowledgeRenameNotice: () => ipcRenderer.invoke("acknowledge-rename-notice"),
  getVisualModelState: (refresh = false) => ipcRenderer.invoke("visual-model-state", refresh === true),
  setVisualModelEnabled: (enabled) => ipcRenderer.invoke("visual-model-set-enabled", enabled === true),
  installVisualPack: () => ipcRenderer.invoke("visual-pack-install"),
  cancelVisualPackInstall: () => ipcRenderer.invoke("visual-pack-cancel"),
  removeVisualPack: () => ipcRenderer.invoke("visual-pack-remove"),
  onVisualPackProgress: (callback) =>
    ipcRenderer.on("visual-pack-progress", (_event, progress) => callback(progress)),
  checkForUpdates: (notify = false) =>
    ipcRenderer.invoke("check-for-updates", notify === true),
  downloadAndInstallUpdate: () => ipcRenderer.invoke("download-and-install-update"),
  cancelUpdateDownload: () => ipcRenderer.invoke("cancel-update-download"),
  reportRendererReady: () => ipcRenderer.invoke("renderer-ready"),
  onUpdateDownloadProgress: (callback) =>
    ipcRenderer.on("update-download-progress", (_event, progress) => callback(progress)),
  openDownloadPage: () => ipcRenderer.invoke("open-download-page"),
  openPinterestAuthorize: (url) => ipcRenderer.invoke("open-pinterest-authorize", url),
  changeLibraryLocation: () => ipcRenderer.invoke("change-library-location"),
  onMenuSearch: (callback) => ipcRenderer.on("menu-search", (_event, ...args) => callback(...args)),
  // 任务 96（A6）：大图页「全屏」与窗口系统全屏双向同步——渲染层写窗口全屏态、
  // 订阅主进程广播的 enter/leave-full-screen 变化。
  setWindowFullScreen: (flag) => ipcRenderer.invoke("set-window-full-screen", flag === true),
  onWindowFullScreenChange: (callback) =>
    ipcRenderer.on("window-full-screen-change", (_event, isFullScreen) => callback(isFullScreen === true)),
});
