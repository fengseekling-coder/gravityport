/**
 * Settings → 连接: 本机 AI 工具 card (task 452).
 *
 * One row per local capture source (Codex, Grok, Cowart 画布) showing whether
 * GravityPort is picking their images up, and — when a row fails — a reason,
 * a fix, and a 复制详细信息 button whose payload goes into 反馈. The row
 * ladders and wording live in bridge-status-text.ts so they stay testable;
 * this file only renders and polls. Reads once when the 连接 page opens and
 * every 30 seconds while it stays open; no refresh button.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { fetchBridgeStatus, type MosaBridgesStatus } from "./mosa-api.js"
import { translate, type Language } from "./i18n.js"
import { fill } from "./app-lifecycle.js"
import { bridgeRowViews } from "./bridge-status-text.js"
import { writeTextToClipboard } from "./desktop.js"
import Icon from "./Icon.js"
import "./bridge-status.css"

export type BridgeStatusCardViewProps = {
  language: Language
  /** undefined while loading; null when the status request failed. */
  status: MosaBridgesStatus | null | undefined
  /** Clock override for deterministic tests; defaults to Date.now(). */
  nowMs?: number
}

export function BridgeStatusCardView({ language, status, nowMs }: BridgeStatusCardViewProps) {
  const t = (text: string) => translate(text, language)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const copiedTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (copiedTimeout.current) clearTimeout(copiedTimeout.current)
  }, [])
  const copyDetail = async (key: string, detailText: string) => {
    try {
      await writeTextToClipboard(detailText)
      setCopiedKey(key)
      if (copiedTimeout.current) clearTimeout(copiedTimeout.current)
      copiedTimeout.current = setTimeout(() => setCopiedKey(null), 2000)
    } catch {
      setCopiedKey(null)
    }
  }
  const clock = nowMs ?? Date.now()
  return (
    <section className="settings-section settings-card bridge-status-card" aria-label={t("本机 AI 工具")}>
      <div className="settings-card-header">
        <div className="settings-card-head"><strong>{t("本机 AI 工具")}</strong></div>
        <p className="settings-card-desc">{t("GravityPort 打开时，自动收录这些工具生成的图片。")}</p>
      </div>
      {status === null ? (
        <p className="bridge-status-error">{t("无法读取收录状态")}</p>
      ) : (
        <div className="bridge-status-rows">
          {bridgeRowViews(status, clock, language).map((row) => (
            <div className="bridge-status-row" key={row.key}>
              <div className="bridge-status-line">
                <span className="bridge-status-name">{t(row.nameKey)}</span>
                <span className={`bridge-status-badge ${row.tone === "ok" ? "is-ok" : row.tone === "warn" ? "is-warn" : row.tone === "bad" ? "is-bad" : ""}`}>
                  {fill(t(row.badgeKey), row.badgeParams)}
                </span>
              </div>
              {row.lines.length > 0 && row.detailText ? (
                <div className="bridge-status-detail">
                  {row.lines.map((line, index) => (
                    <div className="bridge-status-line-group" key={index}>
                      {line.dangerKey ? <p className="bridge-status-error">{fill(t(line.dangerKey), line.dangerParams)}</p> : null}
                      <p className="bridge-status-note">{fill(t(line.noteKey), line.noteParams)}</p>
                    </div>
                  ))}
                  <div className="bridge-status-actions">
                    <button type="button" className="settings-action-btn bridge-status-copy-btn" onClick={() => copyDetail(row.key, row.detailText)}>
                      <Icon name="copy" size={16} />
                      {copiedKey === row.key ? t("已复制") : t("复制详细信息")}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

export function BridgeStatusCard({ language }: { language: Language }) {
  const [status, setStatus] = useState<MosaBridgesStatus | null | undefined>(() => undefined)

  const load = useCallback(() => {
    const controller = new AbortController()
    fetchBridgeStatus(controller.signal)
      .then((next) => setStatus(next))
      .catch(() => {
        if (!controller.signal.aborted) setStatus(null)
      })
    return controller
  }, [])

  // Read once when the 连接 page opens and every 30 seconds while it stays
  // open; leaving the page unmounts the card and stops the polling.
  useEffect(() => {
    const controller = load()
    const timer = setInterval(() => load(), 30_000)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [load])

  return <BridgeStatusCardView language={language} status={status} />
}
