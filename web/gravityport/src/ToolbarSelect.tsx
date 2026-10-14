import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import Icon from "./Icon"

type Option = { value: string; label: string }

export default function ToolbarSelect({ label, value, options, onChange }: {
  label: string
  value: string
  options: Option[]
  onChange: (value: string) => void
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const selected = Math.max(0, options.findIndex(option => option.value === value))
  const [active, setActive] = useState(selected)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 176 })
  useLayoutEffect(() => {
    if (!open || !trigger.current) return
    const rect = trigger.current.getBoundingClientRect()
    const width = Math.min(Math.max(176, rect.width), window.innerWidth - 16)
    const height = options.length * 32 + 8
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: rect.bottom + height + 4 <= window.innerHeight ? rect.bottom + 4 : Math.max(8, rect.top - height - 4),
      width,
    })
  }, [open, options.length])
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
    onChange(options[index].value)
    setOpen(false)
    trigger.current?.focus()
  }
  return <>
    <button ref={trigger} className={`toolbar-select ${open ? "open" : ""}`} role="combobox" aria-label={label} aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? id : undefined} aria-activedescendant={open ? `${id}-${active}` : undefined}
      onClick={() => { setActive(selected); setOpen(!open) }}
      onKeyDown={event => {
        if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " ", "Escape"].includes(event.key)) {
          event.preventDefault()
          event.stopPropagation()
          if (event.key === "Escape") { setOpen(false); return }
          if (!open) { setActive(selected); setOpen(true); return }
          if (event.key === "ArrowDown") setActive(i => (i + 1) % options.length)
          else if (event.key === "ArrowUp") setActive(i => (i - 1 + options.length) % options.length)
          else if (event.key === "Home") setActive(0)
          else if (event.key === "End") setActive(options.length - 1)
          else choose(active)
        } else if (event.key === "Tab") setOpen(false)
      }}>
      <span>{options[selected].label}</span><Icon name="down" size={12} />
    </button>
    {open && createPortal(<div ref={popup} id={id} className="toolbar-select-menu" role="listbox" aria-label={label} style={position}>
      {options.map((option, index) => <div key={option.value} id={`${id}-${index}`} role="option" aria-selected={option.value === value} className={`toolbar-select-option ${active === index ? "active" : ""}`} onPointerMove={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
        <span className="option-check">{option.value === value && <Icon name="check" size={12} />}</span><span>{option.label}</span>
      </div>)}
    </div>, trigger.current?.closest(".app") || document.body)}
  </>
}
