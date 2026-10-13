import { useEffect, useId, useRef, useState, type CSSProperties } from "react"
import Icon from "./Icon"
import { translate, type Language } from "./i18n"

export const columnOptions = [2, 4, 5, 6, 8]

export default function ColumnControl({ value, onChange, language }: {
  value: number
  onChange: (value: number) => void
  language: Language
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const focusWhenOpened = useRef(false)
  const id = useId()
  const tr = (text: string) => translate(text, language)
  const index = columnOptions.indexOf(value)
  useEffect(() => {
    if (!open) return
    if (focusWhenOpened.current) input.current?.focus({ preventScroll: true })
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("pointerdown", dismiss)
    return () => document.removeEventListener("pointerdown", dismiss)
  }, [open])
  return <div className="column-control" ref={root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false)
  }} onKeyDown={event => {
    if (open && event.key === "Escape") {
      event.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
  }}>
    <button ref={trigger} className={`column-trigger ${open ? "open" : ""}`} aria-label={`${tr("视图")}: ${value} ${tr("列")}`} title={tr("调整列数")} aria-expanded={open} aria-controls={open ? id : undefined} onClick={event => { focusWhenOpened.current = event.detail === 0; setOpen(!open) }}>
      <Icon name="grid" size={16} /><span>{value}</span>
    </button>
    {open && <div id={id} className="column-popover" role="group" aria-label={tr("列数")}>
      <input ref={input} className="column-range" aria-label={tr("列数")} aria-valuetext={`${value} ${tr("列")}`} type="range" min={0} max={4} step={1} value={index} style={{ "--range-fill": `${index * 25}%` } as CSSProperties} onChange={event => onChange(columnOptions[Number(event.target.value)])} />
      <div className="column-ticks">{columnOptions.map(count => <button key={count} className={value === count ? "selected" : ""} aria-label={`${count} ${tr("列")}`} aria-pressed={value === count} onClick={() => onChange(count)}>{count}</button>)}</div>
    </div>}
  </div>
}
