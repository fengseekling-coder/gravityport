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

// 任务 458：AI 设置页的状态与各通道载荷。密钥原文永远不出主进程，
// 界面只见到 last4 和最近一次测试的归类结果。
export type AiLastTest = {
  ok: boolean
  code: string
  at: string
  models: string[]
  display?: { message: string; template: string; params: Record<string, string>; modelCount?: number; missingModel?: string }
}

export type AiServiceState = {
  id: string
  label: string
  format: string
  baseUrl?: string
  hasKey: boolean
  last4: string
  keyUrl?: string
  lastTest?: AiLastTest | null
}

export type AiSlotState = {
  serviceId: string
  model: string
  summaryModel?: string
}

export type AiCatalogModel = {
  id: string
  label: string
  service: string
  slots: string[]
  defaults: string[]
  source?: string
  checkedAt?: string
}

export type AiPriceLine = {
  template: string
  params: Record<string, string>
}

export type AiState = {
  available: boolean
  services: AiServiceState[]
  slots: { analysis: AiSlotState; brain: AiSlotState; image: AiSlotState }
  catalog: { services: AiServiceState[]; models: AiCatalogModel[] }
  priceLines: { analysis: AiPriceLine[]; brain: AiPriceLine[]; image: AiPriceLine[] }
  monthTotals: { analysis: number; brain: number; image: number }
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
  // 任务 359（HC-06）：桥接只返回 reason（cancelled/managed/attached/
  // unavailable/校验原因…），从不返回 error。
  changeLibraryLocation?: () => Promise<{ ok?: boolean; libraryDir?: string; reason?: string }>
  getMcpClientConfig?: () => Promise<McpClientConfig>
  getInstallationId?: () => Promise<string>
  getBackgroundCaptureState?: () => Promise<{ supported: boolean; enabled: boolean }>
  setBackgroundCapture?: (enabled: boolean) => Promise<{ ok: boolean; enabled: boolean }>
  setWindowFullScreen?: (flag: boolean) => Promise<unknown>
  onWindowFullScreenChange?: (callback: (isFullScreen: boolean) => void) => unknown
  onMenuSearch?: (callback: () => void) => unknown
  onMenuSelectAll?: (callback: () => void) => unknown
  openPinterestAuthorize?: (url: string) => Promise<{ ok?: boolean }>
  openExternalLink?: (url: string) => Promise<{ ok?: boolean }>
  // 任务 458：AI 设置页五个通道；浏览器里没有这些方法，设置页整页降级。
  aiGetState?: () => Promise<AiState>
  aiSaveKey?: (serviceId: string, key: string) => Promise<{ ok: boolean; last4?: string; reason?: string }>
  aiDeleteKey?: (serviceId: string) => Promise<{ ok: boolean }>
  aiTestConnection?: (serviceId: string, purpose: "text" | "image") => Promise<{ ok: boolean; code?: string; message?: string; template?: string; params?: Record<string, string>; modelCount?: number; missingModel?: string }>
  aiUpdateSettings?: (payload: { slots?: Record<string, Partial<AiSlotState>>; customServices?: Array<{ id?: string; label: string; format: "openai" | "claude"; baseUrl: string }> }) => Promise<{ ok: boolean; state?: AiState; reason?: string }>
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

/**
 * Plain-text copy that works in the packaged app: the desktop bridge writes
 * the system clipboard directly, while navigator.clipboard can be refused
 * there (the extension-folder 复制位置 button silently did nothing). The
 * browser API stays the fallback for source/browser mode.
 */
export async function writeTextToClipboard(text: string): Promise<void> {
  const api = desktopAPI()
  if (api?.writeClipboardText) {
    const result = await api.writeClipboardText(text) as { ok?: boolean } | undefined
    if (result?.ok === false) throw new Error("clipboard write refused")
    return
  }
  if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable")
  await navigator.clipboard.writeText(text)
}
