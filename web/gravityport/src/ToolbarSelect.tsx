import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import Icon from "./Icon"

type Option = { value: string; label: string }
export type ToolbarSelectGroup = { label: string; value: string; options: Option[]; onChange: (value: string) => void }

// One trigger, one listbox. With `groups` the listbox holds several labelled
// single-choice groups (e.g. asset type + sort) and the trigger shows `display`.
export default function ToolbarSelect({ label, value, options, onChange, groups, display }: {
  label: string
  value?: string
  options?: Option[]
  onChange?: (value: string) => void
  groups?: ToolbarSelectGroup[]
  display?: string
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const sections: ToolbarSelectGroup[] = groups ?? [{ label: "", value: value ?? "", options: options ?? [], onChange: onChange ?? (() => {}) }]
  const items = sections.flatMap((group, groupIndex) => group.options.map(option => ({ groupIndex, option })))
  const selected = Math.max(0, items.findIndex(item => item.option.value === sections[item.groupIndex].value))
  const [active, setActive] = useState(selected)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 176 })
  const headed = Boolean(groups)
  useLayoutEffect(() => {
    if (!open || !trigger.current) return
    const rect = trigger.current.getBoundingClientRect()
    const width = Math.min(Math.max(176, rect.width), window.innerWidth - 16)
    const height = items.length * 32 + 8 + (headed ? sections.length * 32 : 0)
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: rect.bottom + height + 4 <= window.innerHeight ? rect.bottom + 4 : Math.max(8, rect.top - height - 4),
      width,
    })
  }, [open, items.length, headed, sections.length])
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpen(false)
    }
    const close = () => setOpen(false)
    document.addEventListener("pointerdown", dismiss)
    window.addEventListener("resize", close)
    window.addEventListener("scroll", close, true)
    return () => {
      document.removeEventListener("pointerdown", dismiss)
      window.removeEventListener("resize", close)
      window.removeEventListener("scroll", close, true)
    }
  }, [open])
  const choose = (index: number) => {
    const item = items[index]
    sections[item.groupIndex].onChange(item.option.value)
    setOpen(false)
    trigger.current?.focus()
  }
  const triggerText = display ?? items[selected]?.option.label ?? ""
  return <>
    <button ref={trigger} className={`toolbar-select ${open ? "open" : ""}`} role="combobox" aria-label={label} aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? id : undefined} aria-activedescendant={open ? `${id}-${active}` : undefined}
      onClick={() => { setActive(selected); setOpen(!open) }}
      onKeyDown={event => {
        if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " ", "Escape"].includes(event.key)) {
          event.preventDefault()
          event.stopPropagation()
          if (event.key === "Escape") { setOpen(false); return }
          if (!open) { setActive(selected); setOpen(true); return }
          if (event.key === "ArrowDown") setActive(i => (i + 1) % items.length)
          else if (event.key === "ArrowUp") setActive(i => (i - 1 + items.length) % items.length)
          else if (event.key === "Home") setActive(0)
          else if (event.key === "End") setActive(items.length - 1)
          else choose(active)
        } else if (event.key === "Tab") setOpen(false)
      }}>
      <span>{triggerText}</span><Icon name="down" size={12} />
    </button>
    {open && createPortal(<div ref={popup} id={id} className="toolbar-select-menu" role="listbox" aria-label={label} style={position}>
      {sections.map((group, groupIndex) => {
        const optionRows = items.map((item, index) => ({ ...item, index })).filter(item => item.groupIndex === groupIndex).map(({ option, index }) =>
          <div key={option.value} id={`${id}-${index}`} role="option" aria-selected={option.value === group.value} className={`toolbar-select-option ${active === index ? "active" : ""}`} onPointerMove={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
            <span className="option-check">{option.value === group.value && <Icon name="check" size={12} />}</span><span>{option.label}</span>
          </div>)
        if (!headed) return optionRows
        return <div key={group.label} role="group" aria-labelledby={`${id}-g${groupIndex}`} className="toolbar-select-group">
          <div id={`${id}-g${groupIndex}`} className="toolbar-select-heading" role="presentation">{group.label}</div>
          {optionRows}
        </div>
      })}
    </div>, trigger.current?.closest(".app") || document.body)}
  </>
}
