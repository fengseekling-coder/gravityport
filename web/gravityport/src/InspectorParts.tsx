// Inspector row helpers moved out of App.tsx (task 395). Pure move; no behavior changes.
import Icon from "./Icon"
import { ThumbMedia } from "./ThumbMedia"
import type { GenerationDisplay } from "./version-tree"

// Task 148: one row renderer shared by the version-tree list above and every
// block of the expanded 「查看」 region below. The list rows keep the exact DOM
// they had before the extraction (the version-history e2e drives it).
export type InspectorRowSpec = {
  key: string
  thumbnailUrl?: string | null
  emptyThumb?: boolean
  title: string
  detail?: string
  isCurrent?: boolean
  selected?: boolean
  showChevron?: boolean
  staticRow?: boolean
  rowClassName?: string
  indent?: number
  onClick?: () => void
}

export function InspectorRow(spec: InspectorRowSpec) {
  const className = [
    "related",
    spec.isCurrent ? "is-current" : "",
    spec.staticRow ? "row-static" : "",
    spec.rowClassName || "",
  ].filter(Boolean).join(" ")
  const style = spec.indent ? { marginLeft: spec.indent * 14 } : undefined
  const row = (
    <>
      <i className={spec.emptyThumb ? "row-thumb-empty" : undefined}>
        {!spec.emptyThumb && spec.thumbnailUrl ? <ThumbMedia src={spec.thumbnailUrl} alt="" loading="lazy" /> : null}
      </i>
      <span>{spec.title}<small>{spec.detail || ""}</small></span>
      {spec.showChevron === false ? null : <Icon name="right" size={11} />}
    </>
  )
  if (spec.staticRow) return <div className={className} key={spec.key} style={style}>{row}</div>
  return (
    <button
      className={className}
      key={spec.key}
      aria-pressed={spec.selected === true ? true : undefined}
      style={style}
      onClick={spec.onClick}
    >{row}</button>
  )
}

// One generation record as a 36px thumbnail for the upstream → downstream pair
// rows; records that resolve to no asset render the gray placeholder frame.
export function RelationThumb({ display, onClick, label }: { display: GenerationDisplay; onClick?: () => void; label?: string }) {
  const thumb = display.known && display.asset
    ? <i>{display.asset.thumbnail_url ? <ThumbMedia src={display.asset.thumbnail_url} alt="" loading="lazy" /> : null}</i>
    : <i className="row-thumb-empty" />
  if (!onClick) return <span className="relation-thumb-frame">{thumb}</span>
  return <button className="relation-thumb-link" title={label} aria-label={label} onClick={onClick}>{thumb}</button>
}
