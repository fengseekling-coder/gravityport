/**
 * Desktop capability bridge. In Electron the preload exposes window.electronAPI;
 * in a plain browser every accessor reports unavailable so the UI can fall back
 * to its web behavior instead of guessing.
 */
type ElectronAPI = {
  pasteImage?: () => Promise<unknown>
  writeClipboardText?: (text: string) => Promise<unknown>
  writeClipboardImage?: (path: string) => Promise<unknown>
  startNativeDrag?: (paths: string[]) => Promise<unknown>
  setLocale?: (locale: string) => Promise<unknown>
  getUserProfile?: () => Promise<{ installationId?: string; [key: string]: unknown }>
  getVisualModelState?: (refresh?: boolean) => Promise<{ state?: string; [key: string]: unknown }>
  setVisualModelEnabled?: (enabled: boolean) => Promise<{ state?: string; [key: string]: unknown }>
  installVisualPack?: () => Promise<{ ok?: boolean; error?: string }>
  cancelVisualPackInstall?: () => Promise<unknown>
  removeVisualPack?: () => Promise<unknown>
  onVisualPackProgress?: (callback: (progress: { percent?: number; status?: string; [key: string]: unknown }) => void) => unknown
  checkForUpdates?: (notify?: boolean) => Promise<{ status?: string; currentVersion?: string; latestVersion?: string; publishedAt?: string; updateAvailable?: boolean; canInstallInApp?: boolean; reason?: string; [key: string]: unknown }>
  downloadAndInstallUpdate?: () => Promise<unknown>
  cancelUpdateDownload?: () => Promise<unknown>
  onUpdateDownloadProgress?: (callback: (progress: { percent?: number; [key: string]: unknown }) => void) => unknown
  openDownloadPage?: () => Promise<{ ok?: boolean }>
  reportRendererReady?: () => Promise<unknown>
  getRenameNoticeState?: () => Promise<{ shouldShow?: boolean }>
  acknowledgeRenameNotice?: () => Promise<unknown>
  changeLibraryLocation?: () => Promise<{ ok?: boolean; libraryDir?: string; error?: string }>
  setWindowFullScreen?: (flag: boolean) => Promise<unknown>
  onWindowFullScreenChange?: (callback: (isFullScreen: boolean) => void) => unknown
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
