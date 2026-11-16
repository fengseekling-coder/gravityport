/**
 * Settings → 反馈 panel (task 158).
 *
 * A small form (kind / message / optional contact), an opt-in diagnostic-log
 * attachment whose preview shows exactly the text that will be sent, and the
 * automatic app summary. Content, contact, and kind persist as a draft in
 * localStorage until a submission succeeds.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import Switch from "./ui/Switch"
import {
  feedbackErrorMessage,
  fetchFeedbackDiagnostics,
  submitFeedback,
  type FeedbackKind,
} from "./feedback-api.js"
import { translate, type Language } from "./i18n.js"

const DRAFT_STORAGE_KEY = "mosa.feedback-draft"
const MESSAGE_LIMIT = 5000
const CONTACT_LIMIT = 200
// The "已写 N / 5000" counter appears once the user is close to the limit.
const COUNTER_VISIBLE_AT = 4500
const KIND_OPTIONS: { value: FeedbackKind; label: string }[] = [
  { value: "bug", label: "问题" },
  { value: "idea", label: "建议" },
  { value: "other", label: "其他" },
]

type FeedbackDraft = { kind: FeedbackKind; message: string; contact: string }
type LogState = "idle" | "loading" | "ready" | "error"

const EMPTY_DRAFT: FeedbackDraft = { kind: "bug", message: "", contact: "" }

function readDraft(): FeedbackDraft {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY)
    if (!raw) return EMPTY_DRAFT
    const parsed = JSON.parse(raw) as Partial<FeedbackDraft>
    return {
      kind: KIND_OPTIONS.some((option) => option.value === parsed.kind) ? parsed.kind as FeedbackKind : "bug",
      message: typeof parsed.message === "string" ? parsed.message.slice(0, MESSAGE_LIMIT) : "",
      contact: typeof parsed.contact === "string" ? parsed.contact.slice(0, CONTACT_LIMIT) : "",
    }
  } catch {
    return EMPTY_DRAFT
  }
}

function writeDraft(draft: FeedbackDraft) {
  try {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft))
  } catch { /* draft persistence is best-effort. */ }
}

function removeDraft() {
  try {
    localStorage.removeItem(DRAFT_STORAGE_KEY)
  } catch { /* draft persistence is best-effort. */ }
}

export function FeedbackPanel({ language }: { language: Language }) {
  const tr = (text: string) => translate(text, language)
  const [draft] = useState(readDraft)
  const [kind, setKind] = useState<FeedbackKind>(draft.kind)
  const [message, setMessage] = useState(draft.message)
  const [contact, setContact] = useState(draft.contact)
  const [includeLog, setIncludeLog] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [logState, setLogState] = useState<LogState>("idle")
  const [logText, setLogText] = useState("")
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState("")

  // Refs mirror the log readiness so the submit path never reads stale state
  // across its await points.
  const logStateRef = useRef<LogState>("idle")
  const logTextRef = useRef("")
  const logRequestRef = useRef<Promise<string | null> | null>(null)

  const ensureDiagnostics = useCallback(async (): Promise<string | null> => {
    if (logStateRef.current === "ready") return logTextRef.current
    if (logRequestRef.current) return logRequestRef.current
    setLogState("loading")
    const request = fetchFeedbackDiagnostics()
      .then((data) => {
        logTextRef.current = data.diagnostics.text
        logStateRef.current = "ready"
        setLogText(data.diagnostics.text)
        setLogState("ready")
        return data.diagnostics.text
      })
      .catch(() => {
        logStateRef.current = "error"
        setLogState("error")
        return null
      })
    logRequestRef.current = request
    return request
  }, [])

  useEffect(() => {
    if (sent) return
    writeDraft({ kind, message, contact })
  }, [kind, message, contact, sent])

  const submitDisabled = sending || message.trim().length === 0

  const onSubmit = async () => {
    if (submitDisabled) return
    setSending(true)
    setError("")
    setSent(false)
    try {
      // "发出去的就是他看到的那份": attach the exact previewed text, and give
      // an in-flight load the chance to finish first.
      const diagnostics = includeLog ? (await ensureDiagnostics()) ?? undefined : undefined
      await submitFeedback({
        kind,
        message: message.trim(),
        contact: contact.trim(),
        locale: language,
        diagnostics,
      })
      setSent(true)
      setMessage("")
      setContact("")
      setKind("bug")
      setIncludeLog(false)
      setShowLog(false)
      removeDraft()
    } catch (submitError) {
      setError(feedbackErrorMessage(submitError))
    } finally {
      setSending(false)
    }
  }

  const onToggleIncludeLog = (on: boolean) => {
    setIncludeLog(on)
    if (on && logStateRef.current !== "ready") void ensureDiagnostics()
  }

  const onViewLog = () => {
    const opening = !showLog
    setShowLog(opening)
    if (opening && logStateRef.current !== "ready") void ensureDiagnostics()
  }

  return (
    <section className="settings-section settings-card feedback-section" aria-label={tr("反馈")}>
      <div className="settings-card-header">
        <div className="settings-card-head">
          <strong>{tr("反馈类型")}</strong>
          <div className="segmented" role="group" aria-label={tr("反馈类型")}>
            {KIND_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={kind === option.value}
                className={kind === option.value ? "on" : ""}
                onClick={() => { setKind(option.value); setSent(false) }}
              >
                {tr(option.label)}
              </button>
            ))}
          </div>
        </div>
        <p className="settings-card-desc">{tr("发送遇到的问题或功能建议。")}</p>
      </div>
      <textarea
        className="feedback-message"
        value={message}
        maxLength={MESSAGE_LIMIT}
        placeholder={tr("描述遇到的问题或希望增加的功能")}
        aria-label={tr("反馈内容")}
        onChange={(event) => { setMessage(event.target.value); setSent(false) }}
      />
      <div className="feedback-message-foot">
        {message.length >= COUNTER_VISIBLE_AT && (
          <span className="feedback-counter">{tr("{count} / 5000").replace("{count}", String(message.length))}</span>
        )}
      </div>
      <input
        className="feedback-contact"
        type="text"
        value={contact}
        maxLength={CONTACT_LIMIT}
        placeholder={tr("邮箱或其他联系方式（可选），用于回复反馈")}
        aria-label={tr("联系方式")}
        onChange={(event) => { setContact(event.target.value); setSent(false) }}
      />
      <div className="settings-card-sub">
        <div className="settings-card-head">
          <div className="settings-card-title">
            <strong>{tr("附上诊断日志")}</strong>
          </div>
          <div className="settings-card-actions">
            <button type="button" className="settings-action-btn" aria-expanded={showLog} onClick={onViewLog}>
              {showLog ? tr("收起") : tr("查看内容")}
            </button>
            <Switch label={tr("附上诊断日志")} checked={includeLog} onCheckedChange={onToggleIncludeLog} />
          </div>
        </div>
        {showLog && (
          <pre className="feedback-log-view">
            {logState === "loading" ? tr("正在加载…")
              : logState === "error" ? tr("无法加载")
              : logText || tr("暂无诊断日志")}
          </pre>
        )}
      </div>
      <div className="feedback-submit-row">
        <div className="feedback-submit-status">
          {sent ? <p className="feedback-status feedback-success" role="status">{tr("已发送反馈")}</p> : null}
          {error ? <p className="feedback-status feedback-error" role="alert">{tr(error)}</p> : null}
        </div>
        <button type="button" className="settings-action-btn feedback-send" disabled={submitDisabled} onClick={() => void onSubmit()}>
          {sending ? tr("发送中…") : tr("发送")}
        </button>
      </div>
    </section>
  )
}
