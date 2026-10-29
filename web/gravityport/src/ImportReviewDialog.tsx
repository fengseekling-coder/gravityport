import { useState } from "react"
import { translate, type Language } from "./i18n.js"
import type { MosaAsset } from "./mosa-api.js"

/**
 * 导入结果浮层(task 291):一次导入结束后,把「已在素材库的其他位置」和
 * 「可能重复」并成一问,用户逐行选择;像素完全相同的那部分不进清单,服务端
 * 已经移进回收站,这里只给一行只读说明。选项默认全部保留,「取消」等于全部
 * 选默认——没有勾选任何改动之前,库里什么都不会变。
 */

export type ImportReviewElsewhereItem = {
  existingAssetId: string
  fileName: string
  thumbnailUrl: string
  locationLabel: string
  archived: boolean
}

export type ImportReviewMatchItem = {
  newAsset: MosaAsset
  existingAsset: MosaAsset
  clearer: boolean
}

export type ImportReviewData = {
  key: string
  project: string
  targetGroupName: string
  targetStackId: string
  targetStackName: string
  identicalCount: number
  elsewhere: ImportReviewElsewhereItem[]
  matches: ImportReviewMatchItem[]
}

export type ImportReviewDecision = {
  elsewhereMoves: string[]
  matchChoices: Array<{ newAssetId: string; existingAssetId: string; choice: "trash-new" | "replace-with-new" }>
}

type Props = {
  data: ImportReviewData
  busy: boolean
  language: Language
  onConfirm: (decision: ImportReviewDecision) => void
  onCancel: () => void
}

const PAGE_SIZE = 100

type ElsewhereChoice = "keep" | "move"
type MatchChoice = "keep" | "trash-new" | "replace-with-new"

function dimensionsLabel(asset: MosaAsset): string {
  return `${asset.width}×${asset.height}`
}

export default function ImportReviewDialog({ data, busy, language, onConfirm, onCancel }: Props) {
  const tr = (text: string) => translate(text, language)
  const fill = (text: string, values: Record<string, string | number>) =>
    Object.entries(values).reduce((acc, [key, value]) => acc.split(`{${key}}`).join(String(value)), tr(text))
  const rowCount = data.elsewhere.length + data.matches.length
  const [elsewhereChoice, setElsewhereChoice] = useState<Record<string, ElsewhereChoice>>({})
  const [matchChoice, setMatchChoice] = useState<Record<string, MatchChoice>>({})
  const [visible, setVisible] = useState(PAGE_SIZE)

  const moveTargetLabel = data.targetGroupName
    ? fill("移到「{group}」", { group: data.targetGroupName })
    : fill("移进「{stack}」", { stack: data.targetStackName })
  // The move action reuses the context menu's move-to-group / move-into-stack
  // behavior exactly; archived images cannot join a stack, so those rows keep
  // only the keep option with a short reason.
  const canMove = (item: ImportReviewElsewhereItem) => !(data.targetStackName && item.archived)

  const visibleElsewhere = data.elsewhere.slice(0, visible)
  const visibleMatches = data.matches.slice(0, Math.max(0, visible - data.elsewhere.length))
  const hiddenCount = data.elsewhere.length + data.matches.length - visibleElsewhere.length - visibleMatches.length

  const setAllElsewhere = (choice: ElsewhereChoice) => {
    const next: Record<string, ElsewhereChoice> = {}
    for (const item of data.elsewhere) {
      next[item.existingAssetId] = canMove(item) ? choice : "keep"
    }
    setElsewhereChoice(next)
  }
  const setAllMatches = (choice: MatchChoice) => {
    const next: Record<string, MatchChoice> = {}
    for (const item of data.matches) {
      next[item.newAsset.id] = choice === "replace-with-new" && !item.clearer ? "keep" : choice
    }
    setMatchChoice(next)
  }

  const elsewhereMoves = data.elsewhere
    .filter((item) => canMove(item) && elsewhereChoice[item.existingAssetId] === "move")
    .map((item) => item.existingAssetId)
  const matchChoices = data.matches
    .map((item) => ({ newAssetId: item.newAsset.id, existingAssetId: item.existingAsset.id, choice: matchChoice[item.newAsset.id] || "keep" }))
    .filter((entry): entry is { newAssetId: string; existingAssetId: string; choice: "trash-new" | "replace-with-new" } => entry.choice !== "keep")

  return (
    <div className="import-review" role="dialog" aria-modal="true" aria-label={fill("这 {n} 张图怎么处理？", { n: rowCount })}>
      <h3>{fill("这 {n} 张图怎么处理？", { n: rowCount })}</h3>
      {data.identicalCount > 0 && (
        <p className="review-note">{fill("{k} 张和库里的图完全相同，已移入回收站", { k: data.identicalCount })}</p>
      )}
      <div className="review-scroll">
        {data.elsewhere.length > 0 && (
          <section className="review-section">
            <div className="review-section-head">
              <h4>{tr("已在素材库的其他位置")}</h4>
              <div className="review-section-actions">
                <button type="button" onClick={() => setAllElsewhere("keep")}>{tr("全部保留原位置")}</button>
                <button type="button" onClick={() => setAllElsewhere("move")}>{tr("全部移过来")}</button>
              </div>
            </div>
            {visibleElsewhere.map((item) => (
              <div className="review-row" key={item.existingAssetId}>
                <img className="review-thumb" src={item.thumbnailUrl} alt="" loading="lazy" />
                <div className="review-meta">
                  <span className="review-name">{item.fileName}</span>
                  <span className="review-sub">{item.locationLabel}</span>
                </div>
                <div className="review-options">
                  <label>
                    <input
                      type="radio"
                      name={`elsewhere-${item.existingAssetId}`}
                      checked={(elsewhereChoice[item.existingAssetId] || "keep") === "keep"}
                      onChange={() => setElsewhereChoice((previous) => ({ ...previous, [item.existingAssetId]: "keep" }))}
                    />
                    {tr("保留原位置")}
                  </label>
                  {canMove(item) ? (
                    <label>
                      <input
                        type="radio"
                        name={`elsewhere-${item.existingAssetId}`}
                        checked={elsewhereChoice[item.existingAssetId] === "move"}
                        onChange={() => setElsewhereChoice((previous) => ({ ...previous, [item.existingAssetId]: "move" }))}
                      />
                      {moveTargetLabel}
                    </label>
                  ) : (
                    <span className="review-sub">{tr("已归档，不能移进堆叠")}</span>
                  )}
                </div>
              </div>
            ))}
          </section>
        )}
        {data.matches.length > 0 && (
          <section className="review-section">
            <div className="review-section-head">
              <h4>{tr("可能重复")}</h4>
              <div className="review-section-actions">
                <button type="button" onClick={() => setAllMatches("keep")}>{tr("全部保留")}</button>
                <button type="button" onClick={() => setAllMatches("trash-new")}>{tr("全部删掉新的")}</button>
              </div>
            </div>
            {visibleMatches.map((item) => (
              <div className="review-row" key={item.newAsset.id}>
                <div className="review-pair">
                  <img className="review-thumb" src={item.newAsset.thumbnail_url} alt="" loading="lazy" />
                  <span className="review-sub">{dimensionsLabel(item.newAsset)}</span>
                  <img className="review-thumb" src={item.existingAsset.thumbnail_url} alt="" loading="lazy" />
                  <span className="review-sub">{dimensionsLabel(item.existingAsset)}</span>
                </div>
                <div className="review-meta">
                  <span className="review-sub">{item.newAsset.name}</span>
                </div>
                <div className="review-options">
                  <label>
                    <input
                      type="radio"
                      name={`match-${item.newAsset.id}`}
                      checked={(matchChoice[item.newAsset.id] || "keep") === "keep"}
                      onChange={() => setMatchChoice((previous) => ({ ...previous, [item.newAsset.id]: "keep" }))}
                    />
                    {tr("保留")}
                  </label>
                  <label>
                    <input
                      type="radio"
                      name={`match-${item.newAsset.id}`}
                      checked={matchChoice[item.newAsset.id] === "trash-new"}
                      onChange={() => setMatchChoice((previous) => ({ ...previous, [item.newAsset.id]: "trash-new" }))}
                    />
                    {tr("删掉新的")}
                  </label>
                  {item.clearer && (
                    <label>
                      <input
                        type="radio"
                        name={`match-${item.newAsset.id}`}
                        checked={matchChoice[item.newAsset.id] === "replace-with-new"}
                        onChange={() => setMatchChoice((previous) => ({ ...previous, [item.newAsset.id]: "replace-with-new" }))}
                      />
                      {tr("换成更清晰的这张")}
                    </label>
                  )}
                </div>
              </div>
            ))}
          </section>
        )}
        {hiddenCount > 0 && (
          <button type="button" className="review-more" onClick={() => setVisible((value) => value + PAGE_SIZE)}>
            {fill("再显示 {count} 条", { count: Math.min(PAGE_SIZE, hiddenCount) })}
          </button>
        )}
      </div>
      <div className="review-foot">
        <button type="button" className="neutral-button" disabled={busy} onClick={onCancel}>{tr("取消")}</button>
        <button type="button" className="primary-button" disabled={busy} onClick={() => onConfirm({ elsewhereMoves, matchChoices })}>
          {busy ? tr("正在处理导入结果…") : tr("按所选处理")}
        </button>
      </div>
    </div>
  )
}
