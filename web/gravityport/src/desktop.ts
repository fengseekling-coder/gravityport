/**
 * Desktop capability bridge. In Electron the preload exposes window.electronAPI;
 * in a plain browser every accessor reports unavailable so the UI can fall back
 * to its web behavior instead of guessing.
 */
export type McpClientConfig = {
  available?: boolean
  platform?: string
  installWarning?: "not-in-applications" | null
  serverName?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  claudeDesktop?: string
  claudeCode?: string
  codex?: string
}

// 任务 231：主进程已把校验过的更新包放进 staging 后广播的载荷。
export type UpdateReadyState = {
  version?: string
  notes?: { zh?: string; en?: string }
}

type ElectronAPI = {
  pasteImage?: () => Promise<unknown>
  writeClipboardText?: (text: string) => Promise<unknown>
  writeClipboardImage?: (path: string) => Promise<unknown>
  writeClipboardFiles?: (paths: string[]) => Promise<{ ok?: boolean; count?: number; skipped?: number; reason?: string }>
  // 任务 239：右键空白处「粘贴」——主进程只回答剪贴板里有没有可导入内容，
  // 再由主进程代按一次粘贴（webContents.paste），剪贴板内容不外传。
  clipboardImportable?: () => Promise<boolean>
  pasteFromClipboard?: () => Promise<unknown>
  startNativeDrag?: (paths: string[]) => Promise<unknown>
  libraryFileFlags?: (files: File[]) => Promise<boolean[]>
  setLocale?: (locale: string) => Promise<unknown>
  getUserProfile?: () => Promise<{ installationId?: string; [key: string]: unknown }>
  checkForUpdates?: (notify?: boolean) => Promise<{ status?: string; currentVersion?: string; latestVersion?: string; publishedAt?: string; updateAvailable?: boolean; canInstallInApp?: boolean; reason?: string; [key: string]: unknown }>
  downloadAndInstallUpdate?: () => Promise<{ status?: string; code?: string; reason?: string; latestVersion?: string; [key: string]: unknown } | undefined>
  cancelUpdateDownload?: () => Promise<unknown>
  getUpdateReady?: () => Promise<UpdateReadyState | null>
  onUpdateReady?: (callback: (payload: UpdateReadyState) => void) => unknown
  onUpdateDownloadProgress?: (callback: (progress: { percent?: number; [key: string]: unknown }) => void) => unknown
  openDownloadPage?: () => Promise<{ ok?: boolean }>
  reportRendererReady?: () => Promise<unknown>
  getRenameNoticeState?: () => Promise<{ shouldShow?: boolean }>
  acknowledgeRenameNotice?: () => Promise<unknown>
  changeLibraryLocation?: () => Promise<{ ok?: boolean; libraryDir?: string; error?: string }>
  getMcpClientConfig?: () => Promise<McpClientConfig>
  setWindowFullScreen?: (flag: boolean) => Promise<unknown>
  onWindowFullScreenChange?: (callback: (isFullScreen: boolean) => void) => unknown
  onMenuSearch?: (callback: () => void) => unknown
  openPinterestAuthorize?: (url: string) => Promise<{ ok?: boolean }>
  openExternalLink?: (url: string) => Promise<{ ok?: boolean }>
  [key: string]: unknown
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}

export function desktopAPI(): ElectronAPI | null {
  if (typeof window === "undefined") return null
  const api = window.electronAPI
  return api && typeof api === "object" ? api : null
}
