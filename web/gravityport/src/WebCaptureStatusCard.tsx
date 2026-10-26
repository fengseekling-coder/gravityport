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
  const loading = status === undefined
  const extensionVersion = status?.lastExtensionVersion || ""
  const versionGap = extensionVersion && bundledVersion
    ? compareExtensionVersions(extensionVersion, bundledVersion)
    : null
  const outdated = active && versionGap !== null && versionGap < 0
  const pending = status?.queue.pending ?? 0
  const lastError = status?.lastError ? status.lastError.slice(0, LAST_ERROR_MAX_CHARS) : ""

  return (
    <section className="web-capture-status-card" aria-label={t("浏览器扩展")}>
      <div className="web-capture-status-head">
        <div className="web-capture-status-title">
          <strong>{t("浏览器扩展")}</strong>
          <p className="web-capture-state">
            {loading ? t("加载中") : active ? t("已连接") : t("没有连接")}
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
      {!loading && !active ? (
        <p className="web-capture-note">
          {t("去官网安装浏览器扩展，并在扩展设置里打开「发现新图时自动入库」。")}{" "}
          <a href={DOWNLOAD_PAGE_URL} target="_blank" rel="noreferrer">{t("前往官网下载")}</a>
        </p>
      ) : null}
      {!loading && active ? (
        <p className="web-capture-row">
          {t("扩展版本")}：{extensionVersion || t("未记录")}
        </p>
      ) : null}
      {outdated ? (
        <p className="web-capture-note">
          <a href={DOWNLOAD_PAGE_URL} target="_blank" rel="noreferrer">{t("有新版扩展")}</a>
        </p>
      ) : null}
      {!loading && pending > 0 ? (
        <p className="web-capture-row">
          {t("等待重试 {count} 张").replace("{count}", String(pending))}
          {" "}
          <button
            type="button"
            className="neutral-button web-capture-retry"
            onClick={onRetry}
            disabled={retrying}
          >
            {t("重试")}
          </button>
          {retried ? <span className="web-capture-retried">{t("已让扩展重试")}</span> : null}
        </p>
      ) : null}
      {lastError ? (
        <p className="web-capture-error">
          {t("最近一次错误")}：{lastError}
        </p>
      ) : null}
      <div className="web-capture-toggle">
        <div className="web-capture-toggle-row">
          <span>{t("即梦站内删除作品时，同步移进回收站")}</span>
          <button
            type="button"
            className={`settings-switch ${deletionSyncEnabled === true ? "enabled" : ""}`}
            role="switch"
            aria-checked={deletionSyncEnabled === true}
            aria-label={t("即梦站内删除作品时，同步移进回收站")}
            disabled={deletionSyncEnabled === undefined || deletionSyncSaving}
            onClick={() => onDeletionSyncChange(deletionSyncEnabled !== true)}
          >
            <span />
          </button>
        </div>
        <p className="web-capture-toggle-note">
          {t("在 GravityPort 里收藏、打分、分组或加了标签的素材不会被移动")}
        </p>
        {deletionSyncError ? <p className="web-capture-error">{t("同步设置保存失败")}</p> : null}
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
