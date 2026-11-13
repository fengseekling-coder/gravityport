// Context menu row moved out of App.tsx (task 395). Pure move; no behavior changes.
import { useEffect, useRef, useState } from "react"
import Icon from "./Icon"
import type { MenuEntry } from "./context-menus"

/** One row of the context menu. A row with a submenu expands it on hover or
 * keyboard focus; near the right window edge the submenu flips to the left,
 * and a submenu taller than the window shifts up and scrolls internally. */
const MENU_SUBMENU_WIDTH = 200

export function MenuRow({ entry, onAction }: { entry: Extract<MenuEntry, { kind: "item" }>; onAction: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const [flip, setFlip] = useState(false)
  const [shiftUp, setShiftUp] = useState(0)
  const buttonRef = useRef<HTMLButtonElement>(null)
  // Leaving the row starts a short close timer so the pointer can travel the
  // gap to the submenu (and cross back over the flipped side) without
  // collapsing it; entering either part cancels the timer.
  const closeTimer = useRef<number | null>(null)
  useEffect(() => () => { if (closeTimer.current !== null) window.clearTimeout(closeTimer.current) }, [])
  const scheduleClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setOpen(false), 250)
  }
  const cancelClose = () => {
    if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null }
  }
  const expand = () => {
    cancelClose()
    if (!entry.submenu?.length) return
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect) {
      setFlip(rect.right + MENU_SUBMENU_WIDTH + 8 > window.innerWidth)
      // The submenu must clear the window bottom before its real height can
      // be measured; the row count bounds it well enough for the shift.
      const estimatedHeight = entry.submenu.length * 32 + 8
      setShiftUp(Math.max(0, rect.bottom + estimatedHeight - window.innerHeight + 8))
    }
    setOpen(true)
  }
  const iconFor = (item: Extract<MenuEntry, { kind: "item" }>) => item.color
    ? <span className="group-color-dot" style={{ background: item.color || "#8b8b93" }} />
    : item.icon ? <Icon name={item.icon} size={14} /> : <span className="menu-icon-slot" />
  return (
    <div className="menu-row" onMouseLeave={scheduleClose}>
      <button
        ref={buttonRef}
        role="menuitem"
        aria-haspopup={entry.submenu ? "menu" : undefined}
        aria-expanded={entry.submenu ? open : undefined}
        className={entry.danger ? "danger" : ""}
        disabled={entry.disabled}
        onClick={entry.submenu
          ? () => { if (open) setOpen(false); else expand() }
          : () => onAction(entry.id)}
        onMouseEnter={expand}
        onFocus={expand}
        onBlur={event => {
          // Pressing a submenu item moves focus off this button before the
          // click lands; closing here would unmount the item mid-click.
          if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) setOpen(false)
        }}
        aria-label={entry.label}
      >
        {iconFor(entry)}
        <span>{entry.label}</span>
        {entry.shortcut && <small>{entry.shortcut}</small>}
        {!entry.shortcut && entry.id === "open-viewer" && <small><Icon name="enter" size={12} /></small>}
        {entry.id === "move-to-trash" && <small><Icon name="backspace" size={12} /></small>}
        {entry.submenu && <small><Icon name="right" size={12} /></small>}
      </button>
      {open && entry.submenu && (
        <div
          className={`context-submenu${flip ? " flip" : ""}`}
          role="menu"
          style={shiftUp ? { top: -4 - shiftUp } : undefined}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          {entry.submenu.map((sub, index) => {
            if (sub.kind === "separator") return <div key={`sep-${index}`} className="menu-divider" />
            if (sub.kind === "heading") return <div key={`head-${index}`} className="menu-heading">{sub.label}</div>
            return (
              <button
                key={sub.id}
                role="menuitem"
                className={sub.danger ? "danger" : ""}
                disabled={sub.disabled}
                onClick={() => { setOpen(false); onAction(sub.id) }}
              >
                {iconFor(sub)}
                <span>{sub.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
