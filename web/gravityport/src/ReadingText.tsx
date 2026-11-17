import { useLayoutEffect, useRef, useState } from "react"
import Icon from "./Icon"

// Long inspector text: five lines collapsed, up to ten lines expanded (longer
// text scrolls inside). The toggle only appears when the text actually
// overflows five lines. With `onActivate` the text itself is the edit entry:
// a click that is not a text selection (or Enter) opens the editor.
export function ReadingText({ id, text, expanded, onToggle, expandLabel, collapseLabel, onActivate, activateLabel, placeholder }: {
  id: string
  text: string
  expanded: boolean
  onToggle: () => void
  expandLabel: string
  collapseLabel: string
  onActivate?: () => void
  activateLabel?: string
  /** Render `text` as a muted placeholder (nothing recorded yet). */
  placeholder?: boolean
}) {
  const ref = useRef<HTMLParagraphElement>(null)
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const paragraph = ref.current
    if (!paragraph || expanded) return
    const measure = () => setOverflows(paragraph.scrollHeight > paragraph.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(paragraph)
    return () => observer.disconnect()
  }, [text, expanded])
  const editable = Boolean(onActivate)
  return (
    <div className={`detail-reading five-lines ${expanded ? "expanded" : ""} ${editable ? "editable" : ""} ${placeholder ? "placeholder" : ""}`}>
      <p id={id} ref={ref}
        tabIndex={editable ? 0 : undefined}
        title={editable ? activateLabel : undefined}
        onClick={editable ? () => { if (!window.getSelection()?.toString()) onActivate?.() } : undefined}
        onKeyDown={editable ? event => { if (event.key === "Enter") { event.preventDefault(); onActivate?.() } } : undefined}
      >{text}</p>
      {overflows && <button className="reading-toggle" aria-expanded={expanded} aria-controls={id} onClick={onToggle}>{expanded ? collapseLabel : expandLabel}<Icon name={expanded ? "minus" : "down"} size={12} /></button>}
    </div>
  )
}

// The editor that replaces a ReadingText in place. Leaving the field (blur)
// or ⌘/Ctrl+Enter saves; Esc cancels. Grows with its content up to ten lines.
export function InlineTextEditor({ value, label, placeholder, onChange, onSave, onCancel }: {
  value: string
  label: string
  placeholder?: string
  onChange: (value: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  const cancelled = useRef(false)
  return (
    <textarea
      className="detail-editor"
      aria-label={label}
      placeholder={placeholder}
      value={value}
      autoFocus
      onFocus={event => { const end = event.currentTarget.value.length; event.currentTarget.setSelectionRange(end, end) }}
      onChange={event => onChange(event.target.value)}
      onBlur={() => { if (!cancelled.current) onSave() }}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelled.current = true; onCancel() }
        else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onSave() }
      }}
    />
  )
}
