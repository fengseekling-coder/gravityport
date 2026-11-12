/**
 * Settings → 连接: "浏览器扩展" card (task 225, audit M9).
 *
 * Shows whether the browser extension recently reported or captured here,
 * which version it ran, how many captures wait in its retry queue, and the
 * last ingest error. WebCaptureStatusCardView is the props-only half that
 * unit tests render directly; the connection window and the version compare
 * are pure helpers so the boundary stays testable.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import {
  fetchProviderDeletionSettings,
  fetchWebCaptureStatus,
  requestWebCaptureRetry,
  updateProviderDeletionSettings,
  type MosaWebCaptureStatus,
} from "./mosa-api.js"
import { translate, type Language } from "./i18n.js"
import { bundledExtensionVersion } from "./bundled-extension-version.js"
import { handleExternalLinkClick } from "./external-link.js"
import { desktopAPI, writeTextToClipboard } from "./desktop.js"
import "./web-capture-status.css"

// The extension posts a queue status about once a minute (a chrome.alarms
// minute beat, plus one right after each capture), so five minutes of silence
// means it is really gone while one delayed alarm beat does not.
export const EXTENSION_ACTIVE_WINDOW_MS = 5 * 60 * 1000
export const DOWNLOAD_PAGE_URL = "https://gravityport.azhuilab.com/#download"

const LAST_ERROR_MAX_CHARS = 120
const RETRIED_RESET_MS = 4000

/** Latest instant the extension demonstrably talked to this server. */
export function extensionLastActiveAt(bridge: MosaWebCaptureStatus | null): number | null {
  const stamps = [bridge?.queue.reportedAt, bridge?.lastIngestAt]
  const times = stamps
    .filter((stamp): stamp is string => typeof stamp === "string" && stamp !== "")
    .map((stamp) => Date.parse(stamp))
    .filter((time) => Number.isFinite(time))
  return times.length ? Math.max(...times) : null
}

/** Connected means the extension reported or captured inside the window. */
export function isExtensionRecentlyActive(
  bridge: MosaWebCaptureStatus | null,
  nowMs: number,
  windowMs: number = EXTENSION_ACTIVE_WINDOW_MS,
): boolean {
  const lastActive = extensionLastActiveAt(bridge)
  return lastActive !== null && nowMs - lastActive < windowMs
}

/** Segment-wise version compare (0.15.37 style). Null when either side is not
 * a plain dotted number — the card then never claims a newer extension. */
export function compareExtensionVersions(left: string, right: string): number | null {
  const parse = (value: string): number[] | null => {
    const parts = String(value || "").trim().split(".")
    if (!parts.length || !parts.every((part) => /^\d+$/.test(part))) return null
    return parts.map(Number)
  }
  const leftParts = parse(left)
  const rightParts = parse(right)
  if (!leftParts || !rightParts) return null
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] || 0) - (rightParts[index] || 0)
    if (diff) return diff > 0 ? 1 : -1
  }
  return 0
}

export type WebCaptureStatusCardViewProps = {
  language: Language
  /** undefined while loading; null when the status request failed. */
  status: MosaWebCaptureStatus | null | undefined
  /** Whether the extension counts as connected (computed by the container). */
  active: boolean
  /** Version this app build ships; empty outside the bundler. */
  bundledVersion: string
  refreshing: boolean
  retrying: boolean
  retried: boolean
  onRefresh: () => void
  onRetry: () => void
  /** undefined while the deletion-sync switch has not loaded yet. */
  deletionSyncEnabled: boolean | undefined
  deletionSyncSaving: boolean
  deletionSyncError: boolean
  onDeletionSyncChange: (enabled: boolean) => void
}

export function WebCaptureStatusCardView({
  language,
  status,
  active,
  bundledVersion,
  refreshing,
  retrying,
  retried,
  onRefresh,
  onRetry,
  deletionSyncEnabled,
  deletionSyncSaving,
  deletionSyncError,
  onDeletionSyncChange,
}: WebCaptureStatusCardViewProps) {
  const t = (text: string) => translate(text, language)
  const [copied, setCopied] = useState(false)
  const copiedTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [lagStartedAt, setLagStartedAt] = useState<number | null>(null)
  const [clockMs, setClockMs] = useState(() => Date.now())
  const managed = status?.managedExtension
  const available = managed?.available === true && Boolean(managed.path)
  const extensionManaged = available && managed?.extensionManaged === true
  const storeVersion = status?.lastExtensionId === "bhjibabaiccjjfcdbimeeaoaikhcfncc"
  const migrate = active && available && !extensionManaged && !storeVersion
  const managedLag = extensionManaged && active && managed?.version && status?.lastExtensionVersion
    ? compareExtensionVersions(status.lastExtensionVersion, managed.version) === -1 : false
  useEffect(() => {
    if (managedLag && lagStartedAt === null) setLagStartedAt(Date.now())
    if (!managedLag && lagStartedAt !== null) setLagStartedAt(null)
  }, [managedLag, lagStartedAt])
  useEffect(() => {
    if (!managedLag) return
    const timer = setInterval(() => setClockMs(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [managedLag])
  useEffect(() => () => {
    if (copiedTimeout.current) clearTimeout(copiedTimeout.current)
  }, [])
  const copyFolder = async () => {
    if (!managed?.path) return
    try {
      await writeTextToClipboard(managed.path)
      setCopied(true)
      if (copiedTimeout.current) clearTimeout(copiedTimeout.current)
      copiedTimeout.current = setTimeout(() => setCopied(false), 2000)
    } catch { setCopied(false) }
  }
  const showFolder = () => {
    const api = desktopAPI() as { revealManagedExtensionFolder?: () => Promise<unknown> } | null
    void api?.revealManagedExtensionFolder?.()
  }
  const installationSteps = (
    <div className="web-capture-note">
      <p>{t("1. 复制扩展文件夹位置")}</p>
      <p className="web-capture-row">
        <code>{managed?.path}</code>
        <button type="button" className="neutral-button" onClick={copyFolder}>{t("复制位置")}</button>
        {copied ? <span>{t("已复制")}</span> : null}
        <button type="button" className="neutral-button" onClick={showFolder}>
          {t(typeof navigator !== "undefined" && /Win/i.test(navigator.platform) ? "在文件资源管理器中显示" : "在访达中显示")}
        </button>
      </p>
      <p>{t("2. 在 Chrome 打开 chrome://extensions，打开右上角「开发者模式」。")}</p>
      <p>{t("3. 点「加载已解压的扩展程序」，选这个文件夹。（Mac：在选择窗口按 ⌘⇧G，粘贴位置。）")}</p>
      <p>{t("然后在扩展设置里打开「自动收录」。")}</p>
    </div>
  )
  const loading = status === undefined
  const extensionVersion = status?.lastExtensionVersion || ""
  const versionGap = extensionVersion && bundledVersion
    ? compareExtensionVersions(extensionVersion, bundledVersion)
    : null
  const outdated = active && !extensionManaged && !migrate && versionGap !== null && versionGap < 0
  const pending = status?.queue.pending ?? 0
  const lastError = status?.lastError ? status.lastError.slice(0, LAST_ERROR_MAX_CHARS) : ""
  // Offline-storage diagnostics from the extension's queue snapshot
  // (0.15.44+, review 2-2). Older extensions report zeros, so every hint
  // below stays hidden for them.
  const queue = status?.queue
  const storageBytes = queue?.storageBytes ?? 0
  const storageLimitBytes = queue?.storageLimitBytes ?? 0
  const urlOnly = queue?.urlOnly ?? 0
  const evicted = queue?.evicted ?? 0
  const formatMb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))}MB`
  const storageNearlyFull = storageLimitBytes > 0 && storageBytes >= storageLimitBytes * 0.9

  return (
    <section className="web-capture-status-card" aria-label={t("浏览器扩展")}>
      <div className="web-capture-status-head">
        <div className="web-capture-status-title">
          <strong>{t("浏览器扩展")}</strong>
          <p className="web-capture-state">
            {loading ? t("正在加载…") : active ? t("已连接") : t("未连接")}
          </p>
        </div>
        <button
          type="button"
          className="neutral-button web-capture-refresh"
          onClick={onRefresh}
          disabled={refreshing}
        >
          {t("刷新")}
        </button>
      </div>
      {!loading && !active && available ? (
        <div className="web-capture-note">
          <p>{t("安装浏览器扩展（装一次，以后跟随 App 自动更新）：")}</p>
          {installationSteps}
          <small>{t("也可以去官网下载")} <a href={DOWNLOAD_PAGE_URL} target="_blank" rel="noreferrer" onClick={(event) => handleExternalLinkClick(event, DOWNLOAD_PAGE_URL)}>{t("前往官网下载")}</a></small>
        </div>
      ) : null}
      {!loading && !active && !available ? (
        <p className="web-capture-note">
          {t("前往官网安装浏览器扩展，并在扩展设置中开启「自动收录」。")}{" "}
          <a href={DOWNLOAD_PAGE_URL} target="_blank" rel="noreferrer" onClick={(event) => handleExternalLinkClick(event, DOWNLOAD_PAGE_URL)}>{t("前往官网下载")}</a>
        </p>
      ) : null}
      {/* 任务 359（SET-10h）：标签 + 数值不写冒号。 */}
      {!loading && active ? (
        <p className="web-capture-row">
          {t("扩展版本")} {extensionVersion || t("未知")}
          {extensionManaged ? t("（跟随 App 自动更新）") : null}
        </p>
      ) : null}
      {migrate ? (
        <div className="web-capture-note">
          <p>{t("扩展现在需要手动更新。改成跟随 App 自动更新：")}</p>
          {installationSteps}
          <p>{t("不要先移除旧扩展，直接加载这个文件夹就行，等待入库的图片会保留。换好后，旧的扩展文件夹可以删掉。")}</p>
        </div>
      ) : null}
      {managedLag ? (
        <p className="web-capture-note">
          {lagStartedAt !== null && clockMs - lagStartedAt > 5 * 60 * 1000
            ? t("扩展没有自动更新。打开 chrome://extensions，确认扩展已启用、开发者模式开着，然后点扩展上的刷新按钮。")
            : t("正在更新扩展，一分钟内完成")}
        </p>
      ) : null}
      {outdated ? (
        <p className="web-capture-note">
          <a href={DOWNLOAD_PAGE_URL} target="_blank" rel="noreferrer" onClick={(event) => handleExternalLinkClick(event, DOWNLOAD_PAGE_URL)}>{t("有新版扩展")}</a>
        </p>
      ) : null}
      {!loading && pending > 0 ? (
        <p className="web-capture-row">
          {pending === 1
            ? t("1 个素材等待重试")
            : t("{count} 个素材等待重试").replace("{count}", String(pending))}
          {" "}
          <button
            type="button"
            className="neutral-button web-capture-retry"
            onClick={onRetry}
            disabled={retrying}
          >
            {t("重试")}
          </button>
          {retried ? <span className="web-capture-retried">{t("已请求重试")}</span> : null}
        </p>
      ) : null}
      {!loading && active && storageNearlyFull ? (
        <p className="web-capture-note">
          {t("浏览器扩展的离线空间即将用尽（已用 {used} / {limit}）。GravityPort 打开后将自动收录暂存的素材。")
            .replace("{used}", formatMb(storageBytes))
            .replace("{limit}", formatMb(storageLimitBytes))}
        </p>
      ) : null}
      {!loading && active && evicted > 0 ? (
        <p className="web-capture-error">
          {evicted === 1
            ? t("1 个素材因离线空间不足，仅保留了网址或已被移除。网址过期后可能无法收录。")
            : t("{count} 个素材因离线空间不足，仅保留了网址或已被移除。网址过期后可能无法收录。").replace("{count}", String(evicted))}
        </p>
      ) : null}
      {!loading && active && urlOnly > 0 ? (
        <p className="web-capture-error">
          {urlOnly === 1
            ? t("1 个素材仅保存了网址。网址过期后可能无法收录。")
            : t("{count} 个素材仅保存了网址。网址过期后可能无法收录。").replace("{count}", String(urlOnly))}
        </p>
      ) : null}
      {/* 任务 359（TOAST-38p）：冒号随语言进翻译表。 */}
      {lastError ? (
        <p className="web-capture-error">
          {t("最近一次错误：{error}").replace("{error}", lastError)}
        </p>
      ) : null}
      <div className="web-capture-toggle">
        <div className="web-capture-toggle-row">
          <span>{t("同步即梦中的删除")}</span>
          <button
            type="button"
            className={`settings-switch ${deletionSyncEnabled === true ? "enabled" : ""}`}
            role="switch"
            aria-checked={deletionSyncEnabled === true}
            aria-label={t("同步即梦中的删除")}
            disabled={deletionSyncEnabled === undefined || deletionSyncSaving}
            onClick={() => onDeletionSyncChange(deletionSyncEnabled !== true)}
          >
            <span />
          </button>
        </div>
        <p className="web-capture-toggle-note">
          {t("在即梦网站中删除的作品，对应素材将移到回收站。在 GravityPort 中收藏、评分、分组或加了标签的素材不会被移动。")}
        </p>
        {deletionSyncError ? <p className="web-capture-error">{t("无法保存同步设置")}</p> : null}
      </div>
    </section>
  )
}

export function WebCaptureStatusCard({ language }: { language: Language }) {
  const [status, setStatus] = useState<MosaWebCaptureStatus | null | undefined>(() => undefined)
  const [refreshing, setRefreshing] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [retried, setRetried] = useState(false)
  const [deletionSyncEnabled, setDeletionSyncEnabled] = useState<boolean | undefined>(() => undefined)
  const [deletionSyncSaving, setDeletionSyncSaving] = useState(false)
  const [deletionSyncError, setDeletionSyncError] = useState(false)
  const retriedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(() => {
    const controller = new AbortController()
    setRefreshing(true)
    fetchWebCaptureStatus(controller.signal)
      .then((next) => setStatus(next))
      .catch(() => {
        if (!controller.signal.aborted) setStatus(null)
      })
      .finally(() => setRefreshing(false))
    fetchProviderDeletionSettings(controller.signal)
      .then((next) => setDeletionSyncEnabled(next.jimengDeleteSyncEnabled))
      .catch(() => {
        if (!controller.signal.aborted) setDeletionSyncEnabled(undefined)
      })
    return controller
  }, [])

  // Read once when the card opens; no polling.
  useEffect(() => {
    const controller = load()
    return () => controller.abort()
  }, [load])

  useEffect(() => () => {
    if (retriedTimer.current) clearTimeout(retriedTimer.current)
  }, [])

  const retry = () => {
    if (retrying) return
    setRetrying(true)
    requestWebCaptureRetry()
      .then(() => {
        setRetried(true)
        if (retriedTimer.current) clearTimeout(retriedTimer.current)
        retriedTimer.current = setTimeout(() => setRetried(false), RETRIED_RESET_MS)
        load()
      })
      .catch(() => setRetried(false))
      .finally(() => setRetrying(false))
  }

  // No optimistic flip: the checkbox keeps the server's last known value until
  // the save answers, so a failed save never shows a state the server disagrees
  // with (the switch decides whether captures move to the trash).
  const changeDeletionSync = (enabled: boolean) => {
    if (deletionSyncEnabled === undefined || deletionSyncSaving) return
    setDeletionSyncSaving(true)
    setDeletionSyncError(false)
    updateProviderDeletionSettings({ jimengDeleteSyncEnabled: enabled })
      .then((next) => setDeletionSyncEnabled(next.jimengDeleteSyncEnabled))
      .catch(() => setDeletionSyncError(true))
      .finally(() => setDeletionSyncSaving(false))
  }

  return (
    <WebCaptureStatusCardView
      language={language}
      status={status}
      active={isExtensionRecentlyActive(status ?? null, Date.now())}
      bundledVersion={bundledExtensionVersion()}
      refreshing={refreshing}
      retrying={retrying}
      retried={retried}
      onRefresh={load}
      onRetry={retry}
      deletionSyncEnabled={deletionSyncEnabled}
      deletionSyncSaving={deletionSyncSaving}
      deletionSyncError={deletionSyncError}
      onDeletionSyncChange={changeDeletionSync}
    />
  )
}
