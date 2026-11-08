import { useEffect, useRef, useState } from "react"
import Icon from "./Icon"
import { translate, type Language } from "./i18n"
import { fill } from "./app-lifecycle"

// Task 333 — the authorization dialog (DESIGN.md 授权确认框): used whenever a
// requester outside the App asks permission to act. One request is visible at
// a time; the rest of the `requests` queue behind it and each resolves through
// onResult before the next one shows. Esc and a click on the backdrop (only
// when the backdrop itself is the target) both count as a denial, per the
// design spec — the App's global Escape chain routes its first branch here.
export type AuthorizationRequest = {
  // Stable identity of one request; the key is handed back with the result.
  key: string
  title: string
  // First body line: the consequence of allowing.
  consequence: string
  // Second body line ("来自：…"), omitted when the requester is unknown.
  source?: string
  primaryLabel: string
  // Optional per-second countdown (requester opt-in, e.g. task 2-8). Pairing
  // deliberately runs without one; the server's own TTL does the cleanup.
  timeoutSeconds?: number
}

export type AuthorizationResult = "allow" | "deny" | "timeout"

export function AuthorizationModal({ requests, language, onResult }: {
  requests: AuthorizationRequest[]
  language: Language
  onResult: (key: string, result: AuthorizationResult) => void
}) {
  const tr = (text: string) => translate(text, language)
  const active = requests[0]
  // Seeded from the request so the countdown is visible from the first paint
  // (server rendering included); the effect below re-arms it per request.
  const [remaining, setRemaining] = useState<number | null>(
    active?.timeoutSeconds && active.timeoutSeconds > 0 ? active.timeoutSeconds : null,
  )
  const denyButtonRef = useRef<HTMLButtonElement>(null)
  // The Escape chain, the backdrop click and the countdown timer must all see
  // the freshest handler without re-arming effects on every App render.
  const onResultRef = useRef(onResult)
  onResultRef.current = onResult

  useEffect(() => {
    if (!active || !active.timeoutSeconds || active.timeoutSeconds <= 0) {
      setRemaining(null)
      return
    }
    const startedAt = Date.now()
    setRemaining(active.timeoutSeconds)
    const timer = setInterval(() => {
      const left = (active.timeoutSeconds || 0) - Math.floor((Date.now() - startedAt) / 1000)
      if (left <= 0) {
        clearInterval(timer)
        setRemaining(0)
        onResultRef.current(active.key, "timeout")
        return
      }
      setRemaining(left)
    }, 1000)
    return () => clearInterval(timer)
  }, [active?.key, active?.timeoutSeconds])

  // Initial focus sits on the refusal button: allowing must always be a
  // deliberate act (DESIGN.md).
  useEffect(() => {
    denyButtonRef.current?.focus()
  }, [active?.key])

  if (!active) return null

  return (
    <div
      className="modal-layer authorization-layer"
      onClick={event => {
        if (event.target === event.currentTarget) onResultRef.current(active.key, "deny")
      }}
    >
      <div className="delete-modal authorization-modal" role="alertdialog" aria-modal="true" aria-labelledby={`authorization-title-${active.key}`}>
        <div className="delete-icon">
          <Icon name="info" size={26} />
        </div>
        <h3 id={`authorization-title-${active.key}`}>{tr(active.title)}</h3>
        <p>{tr(active.consequence)}</p>
        {active.source ? <p className="authorization-source">{tr(active.source)}</p> : null}
        {remaining !== null ? (
          <p className="authorization-source">{fill(tr("{seconds} 秒内不回应将视为不允许"), { seconds: remaining })}</p>
        ) : null}
        <div className="delete-actions">
          <button ref={denyButtonRef} className="neutral-button" onClick={() => onResultRef.current(active.key, "deny")}>
            {tr("不允许")}
          </button>
          <button className="primary-button" onClick={() => onResultRef.current(active.key, "allow")}>
            {tr(active.primaryLabel)}
          </button>
        </div>
      </div>
    </div>
  )
}
