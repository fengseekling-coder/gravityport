// Inspector reading text moved out of App.tsx (task 395). Pure move; no behavior changes.
import { useLayoutEffect, useRef, useState } from "react"
import Icon from "./Icon"

/** Inspector text that shows its first five lines and offers to expand only
 *  when there is more to show. */
export function ReadingText({ id, text, expanded, onToggle, expandLabel, collapseLabel }: {
  id: string
  text: string
  expanded: boolean
  onToggle: () => void
  expandLabel: string
  collapseLabel: string
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
  return (
    <div className={`detail-reading five-lines ${expanded ? "expanded" : ""}`}>
      <p id={id} ref={ref}>{text}</p>
      {overflows && <button className="reading-toggle" aria-expanded={expanded} aria-controls={id} onClick={onToggle}>{expanded ? collapseLabel : expandLabel}<Icon name={expanded ? "minus" : "down"} size={12} /></button>}
    </div>
  )
}
