// Inspector details JSX (heading, summary, properties, tags, palette, prompt, user instruction, introduction, references) moved out of App.tsx (task 415). Pure moves; no behavior changes.
import { useEffect, useState } from "react"
import Icon from "./Icon"
import { ThumbMedia, VideoMark } from "./ThumbMedia"
import { InlineTextEditor, ReadingText } from "./ReadingText"
import { aspectRatioLabel, formatVideoDuration, humanSize, resolveReferences, describeSource, promptNotice, trashReasonNotice } from "./inspector-info"
import { removeTagFromStored } from "./tag-display"
import { promptEditorActive, type PromptEditTarget } from "./prompt-edit"
import { updateAssetMetadata, updateAssetNote, mergeAssetDetail, type MosaAsset, type MosaRecipeHistory } from "./mosa-api"
import { errorMessage } from "./error-messages"
import type { Language } from "./i18n"

export type InspectorDetailsProps = {
  asset: MosaAsset
  language: Language
  tr: (text: string) => string
  fillNamed: (text: string, values: Record<string, string | number>) => string
  notify: (text: string) => void
  project: string
  writeText: (text: string) => Promise<void>
  headerLine: string
  trashReasonInfo: ReturnType<typeof trashReasonNotice>
  sourceInfo: ReturnType<typeof describeSource> | null
  tagsRowRef: React.RefObject<HTMLDivElement | null>
  tagsMeasureRef: React.RefObject<HTMLDivElement | null>
  setDetail: React.Dispatch<React.SetStateAction<boolean>>
  setPreview: React.Dispatch<React.SetStateAction<boolean>>
  /** The big-image viewer is open: the "open in viewer" link would only repeat it. */
  previewOpen: boolean
  toggleFavorite: () => Promise<void>
  setAssets: React.Dispatch<React.SetStateAction<MosaAsset[]>>
  expandedTags: boolean
  setExpandedTags: React.Dispatch<React.SetStateAction<boolean>>
  tagItems: string[]
  collapsedTagCount: number
  tagVendor: string | null
  currentTags: string[]
  addingTag: boolean
  setAddingTag: React.Dispatch<React.SetStateAction<boolean>>
  tagDraft: string
  setTagDraft: React.Dispatch<React.SetStateAction<string>>
  tagError: string
  setTagError: React.Dispatch<React.SetStateAction<string>>
  promptVariant: 1 | 2
  setPromptVariant: React.Dispatch<React.SetStateAction<1 | 2>>
  promptEdit: (PromptEditTarget & { draft: string }) | null
  setPromptEdit: React.Dispatch<React.SetStateAction<(PromptEditTarget & { draft: string }) | null>>
  expandedPrompt: boolean
  setExpandedPrompt: React.Dispatch<React.SetStateAction<boolean>>
  shownPrompt: string
  startPromptEdit: () => void
  savePrompt: () => void
  promptNoticeInfo: ReturnType<typeof promptNotice>
  expandedInstruction: boolean
  setExpandedInstruction: React.Dispatch<React.SetStateAction<boolean>>
  expandedIntro: boolean
  setExpandedIntro: React.Dispatch<React.SetStateAction<boolean>>
  recipeHistory: MosaRecipeHistory | null | undefined
  assets: MosaAsset[]
  inspectorFetchError: { versions: boolean; history: boolean; recipes: boolean }
  /** Further sections of the same asset; they scroll with the rest of the details. */
  children?: React.ReactNode
}

export function InspectorDetails(props: InspectorDetailsProps) {
  const {
    asset, language, tr, fillNamed, notify, project, writeText, headerLine,
    trashReasonInfo, sourceInfo, tagsRowRef, tagsMeasureRef,
    setDetail, setPreview, previewOpen, toggleFavorite, setAssets,
    expandedTags, setExpandedTags, tagItems, collapsedTagCount, tagVendor, currentTags,
    addingTag, setAddingTag, tagDraft, setTagDraft, tagError, setTagError,
    promptVariant, setPromptVariant, promptEdit, setPromptEdit,
    expandedPrompt, setExpandedPrompt, shownPrompt, startPromptEdit, savePrompt, promptNoticeInfo,
    expandedInstruction, setExpandedInstruction, expandedIntro, setExpandedIntro,
    recipeHistory, assets, inspectorFetchError,
  } = props
  // 备注 editor: a draft is bound to the asset it was opened for, like the
  // prompt draft, and a save always writes to that asset.
  const [noteEdit, setNoteEdit] = useState<{ project: string; assetId: string; draft: string } | null>(null)
  const [savingNoteId, setSavingNoteId] = useState<string | null>(null)
  const [expandedNote, setExpandedNote] = useState(false)
  useEffect(() => { setNoteEdit(null); setExpandedNote(false) }, [asset.id])
  const noteEditing = promptEditorActive(noteEdit, project, asset.id)
  const saveNote = () => {
    const target = noteEdit
    if (!target || savingNoteId === target.assetId) return
    const current = assets.find(a => a.id === target.assetId && a.project_id === target.project)
    const next = target.draft.trim()
    if (!current || next === current.note) { setNoteEdit(null); return }
    setSavingNoteId(target.assetId)
    updateAssetNote(target.project, target.assetId, next).then(updated => {
      setAssets(old => old.map(a => a.id === updated.id ? mergeAssetDetail(a, updated) : a))
      setNoteEdit(old => old && old.assetId === target.assetId && old.project === target.project ? null : old)
      notify("已保存")
    }).catch(() => notify("无法保存备注")).finally(() => {
      setSavingNoteId(old => old === target.assetId ? null : old)
    })
  }
  return (
    <>
          <div className="detail-heading">
            <strong>{tr("素材详情")}</strong>
            <button aria-label={tr("关闭素材详情")} onClick={() => setDetail(false)}>
              <Icon name="inspector" size={16} />
            </button>
          </div>
          {/* 标题行固定在上面，下面这一段自己滚动（DESIGN.md「详情栏」）。 */}
          <div className="details-scroll">
          <div className="asset-summary">
            <button className="summary-image" aria-label={tr("在查看器中打开")} onClick={() => setPreview(true)}>{asset.thumbnail_url ? <ThumbMedia src={asset.thumbnail_url} motionSrc={asset.mediaKind === "video" || asset.animated ? asset.image_url : undefined} motionKind={asset.mediaKind === "video" ? "video" : asset.animated ? "image" : undefined} alt="" /> : null}{(asset.mediaKind === "video" || asset.animated) && <VideoMark />}<Icon name="expand" /></button>
            <div className="asset-meta">
              <div className="asset-title">
                <span className="asset-name" title={asset.name}>{asset.name}</span>
                <button
                  className={asset.favorite ? "is-favorite" : ""}
                  aria-label={tr("收藏素材")}
                  aria-pressed={!!asset.favorite}
                  onClick={toggleFavorite}
                >
                  <Icon name="heart" size={13} />
                </button>
              </div>
              <span className="muted">{headerLine}</span>
              {trashReasonInfo && <span className="trash-reason">{tr(trashReasonInfo.text)}</span>}
              {/* UI 审查 11-16：已经在查看器里时不再显示「在查看器中打开」。 */}
              {!previewOpen && <button className="summary-preview" onClick={() => setPreview(true)}>{tr("在查看器中打开")}<Icon name="right" size={12} /></button>}
            </div>
          </div>
          <div className="asset-properties">
              {([
                ["格式", asset.format || "—"],
                ["尺寸", asset.width > 1 && asset.height > 1 ? `${asset.width} × ${asset.height}` : "—"],
                ["宽高比", aspectRatioLabel(asset.width, asset.height)],
                ...(asset.mediaKind === "video" && asset.duration_seconds
                  ? [["时长", formatVideoDuration(asset.duration_seconds)]]
                  : []),
                ["大小", humanSize(asset.size_bytes)],
              ] as [string, string][]).map(([label, value]) => (
                // 任务 359（MAIN-19a）：中文全角冒号、英文半角，按语言取。
                <span className="property-tag" key={label} title={`${tr(label)}${language === "en" ? ": " : "："}${tr(value)}`} aria-label={`${tr(label)}${language === "en" ? ": " : "："}${tr(value)}`}>{tr(value)}</span>
              ))}
              {sourceInfo?.groupLabel ? (
                <span className="property-tag" title={`${tr("分组")}${language === "en" ? ": " : "："}${sourceInfo.groupLabel}`} aria-label={`${tr("分组")}${language === "en" ? ": " : "："}${sourceInfo.groupLabel}`}>{sourceInfo.groupLabel}</span>
              ) : null}
          </div>
          <div className="tags" ref={tagsRowRef}>
            {(expandedTags ? tagItems : tagItems.slice(0, collapsedTagCount)).map((t, index) => (
              index === 0 && tagVendor ? (
                <span className="tag-chip tag-vendor" key={`vendor-${t}`}>{t}</span>
              ) : (
                <span className="tag-chip" key={`tag-${t}`}>
                  <span>{t}</span>
                  <button aria-label={`${tr("移除标签")} ${t}`} title={`${tr("移除标签")} ${t}`}
                    onClick={() => {
                      const remaining = removeTagFromStored(currentTags, t)
                      updateAssetMetadata(asset.project_id, asset.id, { tags: remaining })
                        .then(updated => setAssets(old => old.map(item => item.id === updated.id ? mergeAssetDetail(item, updated) : item)))
                        .catch(error => notify(errorMessage(error, language)))
                    }}>×</button>
                </span>
              )
            ))}
            {expandedTags
              ? <button className="tags-toggle" aria-expanded="true" onClick={() => setExpandedTags(false)}>{tr("收起")}</button>
              : (collapsedTagCount < tagItems.length && <button className="tags-toggle" aria-expanded="false" onClick={() => setExpandedTags(true)}>{`+${tagItems.length - collapsedTagCount}`}</button>)}
            {!addingTag && <button className="add-tag" onClick={() => { setAddingTag(true); setTagError("") }}>{tr("添加标签")}</button>}
            {addingTag && <form className="tag-editor" onSubmit={e => {
              e.preventDefault()
              const tag = tagDraft.trim()
              if (!tag) { setTagError("请输入标签名称。"); return }
              if (currentTags.some(existing => existing.toLocaleLowerCase() === tag.toLocaleLowerCase())) { setTagError("已有同名标签。"); return }
              updateAssetMetadata(asset.project_id, asset.id, { tags: [...currentTags, tag] }).then(updated => {
                setAssets(old => old.map(a => a.id === updated.id ? mergeAssetDetail(a, updated) : a))
              }).catch(error => notify(errorMessage(error, language)))
              setExpandedTags(true)
              setTagDraft("")
              setTagError("")
              setAddingTag(false)
            }}>
              <div className="tag-editor-controls">
                <input aria-label={tr("标签名称")} placeholder={tr("标签名称")} autoFocus maxLength={32} value={tagDraft} aria-invalid={!!tagError} aria-describedby={tagError ? "tag-error" : undefined} onChange={e => { setTagDraft(e.target.value); setTagError("") }} onKeyDown={e => {
                  if (e.key === "Escape") { e.stopPropagation(); setAddingTag(false); setTagDraft(""); setTagError("") }
                  if (e.key === "Enter" && e.nativeEvent.isComposing) e.preventDefault()
                }} />
                <button type="submit" aria-label={tr("保存标签")} title={tr("保存标签")}><Icon name="check" size={16} /></button>
                <button type="button" aria-label={tr("取消")} title={tr("取消")} onClick={() => { setAddingTag(false); setTagDraft(""); setTagError("") }}><Icon name="close" size={16} /></button>
              </div>
              {tagError && <p id="tag-error" role="alert">{tr(tagError)}</p>}
            </form>}
            {/* Measuring twin last: document-order lookups of .add-tag / .tags-toggle
             * must reach the live controls, never these inert copies. */}
            <div className="tags-measure" aria-hidden="true" ref={tagsMeasureRef}>
              {tagItems.map((t, index) => (
                <span className={`tag-chip${index === 0 && tagVendor ? " tag-vendor" : ""}`} data-tag-measure-item key={`measure-${index}-${t}`}>
                  {t}
                  {!(index === 0 && tagVendor) && <button tabIndex={-1}>×</button>}
                </span>
              ))}
              <button className="tags-toggle" data-tag-measure-toggle>{`+${Math.max(0, tagItems.length - collapsedTagCount)}`}</button>
              <button className="add-tag" data-tag-measure-add>{tr("添加标签")}</button>
            </div>
          </div>
          {asset.palette.length > 0 && <div className="palette">
            {asset.palette.map((c) => (
              <button
                key={c}
                title={`${tr("复制颜色")} ${c}`}
                style={{ background: c }}
                aria-label={`${tr("复制颜色")} ${c}`}
                onClick={async () => {
                  // 任务 359（TOAST-06i）：失败不能再报「已复制」。
                  try {
                    try { await writeText(c) } catch { await navigator.clipboard?.writeText(c) }
                    notify(fillNamed("已复制颜色 {color}", { color: c }))
                  } catch { notify("无法复制颜色") }
                }}
              />
            ))}
          </div>}
          <section className="detail-section">
            <div className="field-heading">
              <span className="prompt-tabs" role="group" aria-label={tr("提示词")}>
                {asset.prompt2 ? <>
                  <button className={promptVariant === 1 ? "active" : ""} aria-pressed={promptVariant === 1} onClick={() => { setPromptVariant(1); setExpandedPrompt(false) }}>{tr("提示词 1")}</button>
                  <button className={promptVariant === 2 ? "active" : ""} aria-pressed={promptVariant === 2} onClick={() => { setPromptVariant(2); setExpandedPrompt(false); setPromptEdit(null) }}>{tr("提示词 2")}</button>
                </> : tr("提示词")}
              </span>
              <span className="field-actions">
                <button
                  aria-label={tr("复制提示词")}
                  onClick={async () => {
                    if (!shownPrompt) { notify("此素材没有提示词记录"); return }
                    try { await writeText(shownPrompt); notify("已复制提示词") }
                    catch { notify("无法复制提示词") }
                  }}
                >
                  <Icon name="copy" size={16} />
                </button>
              </span>
            </div>
            {promptVariant === 1 && promptEditorActive(promptEdit, project, asset?.id) && promptEdit ? (
              <InlineTextEditor
                label={tr("编辑提示词")}
                value={promptEdit.draft}
                onChange={draft => setPromptEdit(old => old ? { ...old, draft } : old)}
                onSave={savePrompt}
                onCancel={() => setPromptEdit(null)}
              />
            ) : (
              <>
                <ReadingText
                  id="asset-prompt"
                  text={shownPrompt || tr(promptNoticeInfo?.key === "webPromptUnavailable" ? "该网页未提供原始提示词" : "无提示词记录")}
                  placeholder={!shownPrompt}
                  expanded={expandedPrompt}
                  onToggle={() => setExpandedPrompt(!expandedPrompt)}
                  expandLabel={tr("展开提示词")}
                  collapseLabel={tr("收起")}
                  onActivate={promptVariant === 1 ? startPromptEdit : undefined}
                  activateLabel={tr("点击编辑")}
                />
                {promptVariant === 1 && promptNoticeInfo && promptNoticeInfo.key !== "webPromptUnavailable" && (
                  <p className="prompt-provenance">{tr(promptNoticeInfo.text)}</p>
                )}
              </>
            )}
          </section>
          <section className="detail-section user-instruction-section">
            <div className="field-heading">
              <span>{tr("用户指令")}</span>
              <button aria-label={tr("复制用户指令")} disabled={!asset.user_instruction}
                onClick={() => writeText(asset.user_instruction).then(() => notify("已复制用户指令")).catch(() => notify("无法复制用户指令"))}>
                <Icon name="copy" size={16} />
              </button>
            </div>
            <ReadingText
              id="asset-instruction"
              text={asset.user_instruction || tr("无用户指令记录")}
              placeholder={!asset.user_instruction}
              expanded={expandedInstruction}
              onToggle={() => setExpandedInstruction(!expandedInstruction)}
              expandLabel={tr("展开用户指令")}
              collapseLabel={tr("收起")}
            />
          </section>
          <section className="detail-section note-section">
            <div className="field-heading">
              <span>{tr("备注")}</span>
              <button aria-label={tr("复制备注")} disabled={!asset.note}
                onClick={() => writeText(asset.note).then(() => notify("已复制备注")).catch(() => notify("无法复制备注"))}>
                <Icon name="copy" size={16} />
              </button>
            </div>
            {noteEditing && noteEdit ? (
              <InlineTextEditor
                label={tr("编辑备注")}
                placeholder={tr("添加备注")}
                value={noteEdit.draft}
                onChange={draft => setNoteEdit(old => old ? { ...old, draft } : old)}
                onSave={saveNote}
                onCancel={() => setNoteEdit(null)}
              />
            ) : (
              <ReadingText
                id="asset-note"
                text={asset.note || tr("添加备注")}
                placeholder={!asset.note}
                expanded={expandedNote}
                onToggle={() => setExpandedNote(!expandedNote)}
                expandLabel={tr("展开备注")}
                collapseLabel={tr("收起")}
                onActivate={() => setNoteEdit({ project: asset.project_id, assetId: asset.id, draft: asset.note })}
                activateLabel={tr("点击编辑")}
              />
            )}
          </section>
          {asset.introduction && <section className="detail-section">
            <div className="field-heading">
              <span>{tr("内容介绍")}</span>
              <button
                aria-label={tr("复制内容介绍")}
                onClick={async () => {
                  // 任务 359（TOAST-06g）：复制失败要有反馈，不再静默。
                  try {
                    try { await writeText(asset.introduction) } catch { await navigator.clipboard?.writeText(asset.introduction) }
                    notify("已复制内容介绍")
                  } catch { notify("无法复制内容介绍") }
                }}
              >
                <Icon name="copy" size={16} />
              </button>
            </div>
            <div className={`detail-reading ${expandedIntro ? "expanded" : ""}`}>
              <p id="asset-introduction">{asset.introduction}</p>
              <button className="reading-toggle" aria-expanded={expandedIntro} aria-controls="asset-introduction" onClick={() => setExpandedIntro(!expandedIntro)}>{expandedIntro ? tr("收起") : tr("展开内容介绍")}<Icon name={expandedIntro ? "minus" : "down"} size={12} /></button>
            </div>
          </section>}
          {(() => {
            const references = resolveReferences(asset, recipeHistory, assets)?.items.filter(item => item.thumbnailUrl) || []
            // Task 316: a failed recipes fetch must not read as "no references".
            if (!references.length && !inspectorFetchError.recipes) return null
            return <section className="detail-section">
              <div className="field-heading">
                <span>{tr("参考图")}</span>
              </div>
              {inspectorFetchError.recipes
                ? <span className="muted">{tr("无法加载")}</span>
                : <div className="reference-gallery" aria-label={tr("参考图缩略图")}>
                {references.map(reference => <button key={reference.key} className="reference-thumbnail" title={/^参考图 \d+$/.test(reference.label) ? tr(reference.label) : reference.label} aria-label={tr("打开参考图")} onClick={() => window.open(reference.openUrl || reference.thumbnailUrl, "_blank", "noopener")}>
                  <img className="reference-image" src={reference.thumbnailUrl} alt="" loading="lazy" />
                </button>)}
              </div>}
            </section>
          })()}
          {props.children}
          </div>
    </>
  )
}
