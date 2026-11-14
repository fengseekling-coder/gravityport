// Inspector version tree and version list JSX moved out of App.tsx (task 408). Pure moves; no behavior changes.
import Icon from "./Icon"
import { InspectorRow, RelationThumb } from "./InspectorParts"
import VersionCompare, { type VersionCompareEntry } from "./version-compare"
import { generationTreeRows, generationDisplay, relatedChoices, type GenerationDisplay } from "./version-tree"
import { conversationRoundRows, roundCompareSelection, roundLine, type ConversationRoundRow, type ConversationRounds } from "./conversation-rounds"
import { relationTypes, RELATION_LABELS } from "./feature-parity"
import { createGenerationRelation, editGenerationRelation, removeGenerationRelation, dismissGenerationCandidate,
  type MosaAsset, type MosaVersionRow, type MosaGenerationHistory } from "./mosa-api"
import type { Language } from "./i18n"

export type VersionSectionProps = {
  asset: MosaAsset | undefined
  selected: string
  project: string
  language: Language
  tr: (text: string) => string
  fillNamed: (text: string, values: Record<string, string | number>) => string
  versions: MosaVersionRow[] | null
  generationHistory: MosaGenerationHistory | null
  versionRounds: ConversationRounds
  inspectorFetchError: { versions: boolean; history: boolean; recipes: boolean }
  relationBusy: boolean
  relationDrafts: Record<string, string>
  newRelation: { anchor: string; other: string; direction: string; type: string } | null
  showAllRelationChoices: boolean
  versionTreeOpen: boolean
  setVersionTreeOpen: React.Dispatch<React.SetStateAction<boolean>>
  setNewRelation: React.Dispatch<React.SetStateAction<{ anchor: string; other: string; direction: string; type: string } | null>>
  setRelationDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>
  setShowAllRelationChoices: React.Dispatch<React.SetStateAction<boolean>>
  timeLabel: (value?: string) => string
  relationPairLine: (upstream: GenerationDisplay, downstream: GenerationDisplay) => string
  roundText: (text: string, params?: Record<string, string | number>) => string
  selectHistoryAsset: (id: string) => void
  mutateRelation: (action: () => Promise<unknown>) => Promise<void>
  providerDisplayLabel: (provider: string) => string
}

export function VersionSection(props: VersionSectionProps) {
  const {
    asset, selected, project, language, tr, fillNamed,
    versions, generationHistory, versionRounds, inspectorFetchError,
    relationBusy, relationDrafts, newRelation, showAllRelationChoices, versionTreeOpen,
    setVersionTreeOpen, setNewRelation, setRelationDrafts, setShowAllRelationChoices,
    timeLabel, relationPairLine, roundText, selectHistoryAsset, mutateRelation, providerDisplayLabel,
  } = props
  return (
    <>
          <section className="detail-section">
            <div className="field-heading">
              <span>{tr("版本树")}</span>
              {(() => {
                // The badge is the conversation's captured-image count
                // (context mode); truncated counts stay hidden. Plain mode
                // keeps the raw event count. Task 316: version families built
                // over the API have no generation records but two or more
                // versions — they still get the View entry into 版本历史 and
                // the compare block. The badge rule is unchanged: no records,
                // no badge.
                const badgeCount = versionRounds.mode === "context"
                  ? versionRounds.images
                  : generationHistory?.events?.length || 0
                const hasVersionFamily = (versions?.length || 0) > 1
                if (versionRounds.mode !== "context" && !badgeCount && !hasVersionFamily) return null
                return <span className="field-actions">
                  {badgeCount ? <span className="settings-badge">{badgeCount}</span> : null}
                  <button className="section-action" aria-expanded={versionTreeOpen} onClick={() => setVersionTreeOpen(!versionTreeOpen)}>{tr(versionTreeOpen ? "收起" : "展开")}</button>
                </span>
              })()}
            </div>
            {/* One list for the generation records: the record IS the version
                tree entry — its output's thumbnail on the left, prompt on the
                first line and the conversation-rounds text on the second.
                Conversation mode lists every captured image of the current
                ChatGPT conversation (three around this asset by default, all
                when expanded); the current row is highlighted and inert, the
                others jump to that image. Plain mode keeps the events list
                with the time/provider/model line. */}
            <div className="version-list" aria-label={tr("版本树")}>
              {versionRounds.mode === "context"
                ? (versionTreeOpen ? conversationRoundRows(generationHistory, asset?.id || "") : versionRounds.rows).map((row) => {
                  const output = row.outputAsset || (row.isCurrent ? asset : undefined)
                  return InspectorRow({
                    key: String(row.outputAsset?.id || row.event.id || row.event.output_asset_id),
                    thumbnailUrl: output?.thumbnail_url,
                    isCurrent: row.isCurrent,
                    title: (row.event.effective_prompt || row.event.user_prompt || tr("无提示词记录")).slice(0, 60),
                    detail: roundLine(row, versionRounds, roundText),
                    onClick: () => { if (!row.isCurrent && row.outputAsset?.id) selectHistoryAsset(row.outputAsset.id) },
                  })
                })
                : (generationHistory?.events || []).slice(0, versionTreeOpen ? undefined : 3).map((event, index) => {
                  const output = event.output_asset_id
                    ? generationHistory?.output_assets?.find(item => item.id === event.output_asset_id)
                      || (asset && asset.id === event.output_asset_id ? asset : undefined)
                    : undefined
                  return InspectorRow({
                    key: String(event.id || index),
                    thumbnailUrl: output?.thumbnail_url,
                    title: (event.effective_prompt || event.user_prompt || tr("无提示词记录")).slice(0, 60),
                    // 任务 359（MAIN-26q）：来源过显示名、日期本地化、轮次统一「第 N 轮」。
                    detail: `${timeLabel(event.created_at)}${event.provider ? ` · ${providerDisplayLabel(event.provider)}` : ""}${event.turn_index != null ? ` · ${fillNamed("第 {n} 轮", { n: event.turn_index })}` : ""}`,
                    onClick: () => { if (event.output_asset_id) selectHistoryAsset(event.output_asset_id) },
                  })
                })}
              {inspectorFetchError.history
                ? <span className="muted">{tr("无法加载")}</span>
                : !generationHistory?.events?.length && <span className="muted">{tr("暂无生成记录")}</span>}
            </div>
            {versionTreeOpen && (() => {
              // Every block below renders the same thumbnail rows as the list
              // above; no gen- id may reach this region (task 148).
              const currentAssetId = asset?.id || ""
              const anchorRecordIds = (() => {
                const seen = new Set<string>()
                return [
                  ...(generationHistory?.events || []),
                  ...(generationHistory?.context_events || []),
                ].filter((event) => {
                  const id = String(event.id || "")
                  if (!id || seen.has(id)) return false
                  seen.add(id)
                  return String(event.output_asset_id || "") === currentAssetId
                }).sort((left, right) => String(left.created_at || "").localeCompare(String(right.created_at || ""))
                  || String(left.id || "").localeCompare(String(right.id || "")))
              })()
              const fallbackAnchorId = String(anchorRecordIds[0]?.id || generationHistory?.events?.[0]?.id || "")
              // The picker rows are asset-keyed (relatedChoices returns no
              // generation ids); resolve the clicked asset back to its earliest
              // generation record here — ids live in state, never in a row.
              const generationIdForAsset = (assetId: string) => {
                const seen = new Set<string>()
                for (const event of [...(generationHistory?.events || []), ...(generationHistory?.context_events || [])]) {
                  const id = String(event.id || "")
                  if (!id || seen.has(id)) continue
                  seen.add(id)
                  if (String(event.output_asset_id || "") === assetId) return id
                }
                return ""
              }
              const candidateList = (generationHistory?.relation_candidates || [])
                .filter(candidate => candidate.status !== "dismissed" && candidate.status !== "confirmed")
              const jumpToDisplay = (display: GenerationDisplay) => (
                display.known && display.asset && !display.isCurrent ? () => selectHistoryAsset(display.asset!.id) : undefined
              )
              const turnLine = (turnIndex: number | null) => (turnIndex != null ? fillNamed(tr("第 {n} 轮"), { n: turnIndex }) : "")
              return <div className="version-tree" role="region" aria-label={tr("完整版本树")}>
                {(() => {
                  // 任务 217：对话模式也能任选两轮并排对比。有输出图的轮次
                  // 不足两个时不出这块；默认目标 = 当前素材那一轮、基准 =
                  // 它的上一轮（当前在第一轮时改为第一轮 vs 第二轮）。
                  const selection = roundCompareSelection(conversationRoundRows(generationHistory, asset?.id || ""), asset?.id || "")
                  if (!selection) return null
                  const roundEntry = (row: ConversationRoundRow): VersionCompareEntry => {
                    const output = row.outputAsset
                    return {
                      id: String(output?.id || ""),
                      label: row.turnIndex !== null ? fillNamed(tr("第 {n} 轮"), { n: row.turnIndex }) : tr("无轮次"),
                      imageUrl: output?.medium_url || output?.preview_url || output?.image_url || "",
                      values: {
                        "尺寸": output ? `${output.width} × ${output.height}` : "",
                        "用户指令": row.event.user_prompt || "",
                        "提示词": row.event.effective_prompt || "",
                      },
                    }
                  }
                  return <VersionCompare
                    key={`rounds-${asset?.id || ""}`}
                    language={language}
                    captions
                    fields={["尺寸", "用户指令", "提示词"]}
                    entries={selection.options.map(roundEntry)}
                    defaultBaseId={String(selection.base.outputAsset?.id || "")}
                    defaultTargetId={String(selection.target.outputAsset?.id || "")}
                  />
                })()}
                <h4>{tr("生成关系")}</h4>
                {generationTreeRows(generationHistory).map(({ event, depth, parentIds, relationTypes }) => {
                  const display = generationDisplay(generationHistory, event.id, asset)
                  const ancestry = !parentIds.length
                    ? tr("初始生成")
                    : relationTypes[0] === "edited_from" ? tr("改自上一个素材") : tr(RELATION_LABELS[(relationTypes[0] || "derived_from") as keyof typeof RELATION_LABELS] || String(relationTypes[0]))
                  return InspectorRow({
                    key: `tree-${event.id}`,
                    rowClassName: "generation-tree-row",
                    indent: depth,
                    emptyThumb: !display.known,
                    thumbnailUrl: display.asset?.thumbnail_url,
                    isCurrent: display.isCurrent,
                    title: display.known ? (display.prompt ? display.prompt.slice(0, 60) : tr("无提示词记录")) : tr("不属于此对话的生成记录"),
                    detail: `${ancestry}${display.turnIndex != null ? ` · ${turnLine(display.turnIndex)}` : ""}`,
                    staticRow: !display.known,
                    onClick: jumpToDisplay(display),
                  })
                })}
                {(generationHistory?.relations || []).map(relation => {
                  const key = `${relation.child_generation_id}|${relation.parent_generation_id}|${relation.relation_type}`
                  const locked = relation.verification_level === "provider_verified"
                  const upstream = generationDisplay(generationHistory, relation.parent_generation_id, asset)
                  const downstream = generationDisplay(generationHistory, relation.child_generation_id, asset)
                  return <div className="generation-relation-editor" key={key}>
                    <span className="relation-pair-row">
                      <RelationThumb display={upstream} />
                      <Icon name="right" size={12} />
                      <RelationThumb display={downstream} />
                      <small>{relationPairLine(upstream, downstream)}</small>
                    </span>
                    <select disabled={locked || relationBusy} aria-label={tr("关系类型")} value={relationDrafts[key] || relation.relation_type} onChange={event => setRelationDrafts(old => ({ ...old, [key]: event.target.value }))}>
                      {relationTypes.map(type => <option key={type} value={type}>{tr(RELATION_LABELS[type] || type)}</option>)}
                    </select>
                    {locked ? <small>{tr("已由来源平台验证，无法修改")}</small> : <>
                      <button disabled={relationBusy} onClick={() => void mutateRelation(() => editGenerationRelation(project, { childGenerationId: relation.child_generation_id, parentGenerationId: relation.parent_generation_id, previousRelationType: relation.relation_type, relationType: relationDrafts[key] || relation.relation_type, evidence: relation.evidence }))}>{tr("保存关系")}</button>
                      <button disabled={relationBusy} onClick={() => { if (window.confirm(tr("删除生成关系？"))) void mutateRelation(() => removeGenerationRelation(project, { childGenerationId: relation.child_generation_id, parentGenerationId: relation.parent_generation_id, relationType: relation.relation_type })) }}>{tr("删除关系")}</button>
                    </>}
                  </div>
                })}
                {candidateList.length > 0 && <h4>{tr("建议关系")}</h4>}
                {candidateList.map(candidate => {
                  const upstream = generationDisplay(generationHistory, candidate.parent_generation_id, asset)
                  const downstream = generationDisplay(generationHistory, candidate.child_generation_id, asset)
                  return <div className="generation-relation-editor generation-candidate-card" key={`${candidate.child_generation_id}|${candidate.parent_generation_id}`}>
                    <span className="relation-pair-row">
                      <RelationThumb display={upstream} onClick={jumpToDisplay(upstream)} label={tr("查看素材")} />
                      <Icon name="right" size={12} />
                      <RelationThumb display={downstream} onClick={jumpToDisplay(downstream)} label={tr("查看素材")} />
                      <small>{relationPairLine(upstream, downstream)}</small>
                    </span>
                    <small>{fillNamed(tr("可信度 {percent}%"), { percent: Math.round((candidate.confidence || 0) * 100) })}</small>
                    <button disabled={relationBusy} onClick={() => void mutateRelation(() => createGenerationRelation(project, { childGenerationId: candidate.child_generation_id, parentGenerationId: candidate.parent_generation_id, relationType: candidate.suggested_relation_type || "derived_from", evidence: candidate.evidence }))}>{tr("确认关系")}</button>
                    <button disabled={relationBusy} onClick={() => void mutateRelation(() => dismissGenerationCandidate(project, candidate.child_generation_id, candidate.parent_generation_id))}>{tr("忽略建议")}</button>
                  </div>
                })}
                {!!generationHistory?.events?.length && <div className="generation-relation-editor">
                  <button disabled={relationBusy} onClick={() => {
                    setNewRelation({ anchor: fallbackAnchorId, other: "", direction: "candidate-parent", type: "edited_from" })
                    setShowAllRelationChoices(false)
                  }}>{tr("添加生成关系")}</button>
                  {newRelation && (() => {
                    const choices = relatedChoices(generationHistory, newRelation.anchor, asset)
                    const visibleChoices = showAllRelationChoices ? choices : choices.slice(0, 6)
                    return <div className="generation-relation-create">
                      {anchorRecordIds.length > 1
                        ? <div className="relation-choice-list" aria-label={tr("当前生成")}>
                          {anchorRecordIds.map(record => {
                            const display = generationDisplay(generationHistory, String(record.id), asset)
                            return InspectorRow({
                              key: `anchor-${record.id}`,
                              thumbnailUrl: display.asset?.thumbnail_url,
                              isCurrent: display.isCurrent,
                              selected: newRelation.anchor === String(record.id),
                              title: display.prompt ? display.prompt.slice(0, 60) : tr("无提示词记录"),
                              detail: turnLine(display.turnIndex),
                              showChevron: false,
                              onClick: () => setNewRelation(old => old ? { ...old, anchor: String(record.id) } : old),
                            })
                          })}
                        </div>
                        : (() => {
                          const display = generationDisplay(generationHistory, newRelation.anchor, asset)
                          return InspectorRow({
                            key: "anchor-current",
                            thumbnailUrl: display.asset?.thumbnail_url ?? asset?.thumbnail_url,
                            isCurrent: true,
                            title: display.prompt ? display.prompt.slice(0, 60) : tr("无提示词记录"),
                            detail: turnLine(display.turnIndex),
                            showChevron: false,
                            staticRow: true,
                          })
                        })()}
                      <div className="relation-choice-list" aria-label={tr("关联生成")}>
                        {choices.length === 0
                          ? <span className="muted">{tr("此对话中没有可关联的其他素材")}</span>
                          : <>
                            {visibleChoices.map(choice => InspectorRow({
                              key: `choice-${choice.asset.id}`,
                              thumbnailUrl: choice.asset.thumbnail_url,
                              selected: newRelation.other === generationIdForAsset(String(choice.asset.id)),
                              title: choice.prompt ? choice.prompt.slice(0, 60) : tr("无提示词记录"),
                              detail: turnLine(choice.turnIndex),
                              showChevron: false,
                              onClick: () => setNewRelation(old => old ? { ...old, other: generationIdForAsset(String(choice.asset.id)) } : old),
                            }))}
                            {choices.length > 6 && <button className="relation-show-all" onClick={() => setShowAllRelationChoices(!showAllRelationChoices)}>
                              {showAllRelationChoices ? tr("收起") : fillNamed("显示全部 {count} 个", { count: choices.length })}
                            </button>}
                          </>}
                      </div>
                      <select aria-label={tr("关系方向")} value={newRelation.direction} onChange={event => setNewRelation(old => old ? { ...old, direction: event.target.value } : old)}><option value="candidate-parent">{tr("关联生成为前序")}</option><option value="candidate-child">{tr("关联生成为后续")}</option></select>
                      <select aria-label={tr("关系类型")} value={newRelation.type} onChange={event => setNewRelation(old => old ? { ...old, type: event.target.value } : old)}>{relationTypes.map(type => <option value={type} key={type}>{tr(RELATION_LABELS[type] || type)}</option>)}</select>
                      <button disabled={relationBusy || !newRelation.other || newRelation.other === newRelation.anchor} onClick={() => void mutateRelation(() => createGenerationRelation(project, { childGenerationId: newRelation.direction === "candidate-child" ? newRelation.other : newRelation.anchor, parentGenerationId: newRelation.direction === "candidate-child" ? newRelation.anchor : newRelation.other, relationType: newRelation.type }))}>{tr("添加")}</button>
                    </div>
                  })()}
                </div>}
                <h4>{tr("版本历史")}</h4>
                {inspectorFetchError.versions && <span className="muted">{tr("无法加载")}</span>}
                {(versions || []).map(v => InspectorRow({
                  key: `version-${v.id}`,
                  thumbnailUrl: v.thumbnail_url,
                  // The inspector shows `asset` (the first card when nothing is
                  // selected), so that is the current version; it does not jump.
                  isCurrent: v.id === asset?.id,
                  title: `${tr("版本")} ${v.version_index}`,
                  detail: [v.version_change || "", timeLabel(v.created_at)].filter(Boolean).join(" · "),
                  onClick: v.id === asset?.id ? undefined : () => selectHistoryAsset(v.id),
                }))}
                {versions && versions.length > 1 && <VersionCompare
                  key={`family-${asset?.id || ""}`}
                  language={language}
                  fields={["尺寸", "提示词", "变更说明"]}
                  entries={versions.map(v => ({
                    id: v.id,
                    label: `${tr("版本")} ${v.version_index}`,
                    imageUrl: v.medium_url || v.preview_url || v.image_url,
                    values: {
                      "尺寸": `${v.width} × ${v.height}`,
                      "提示词": v.prompt,
                      "变更说明": v.version_change || "",
                    },
                  }))}
                  defaultBaseId={versions[0].id}
                  defaultTargetId={versions[versions.length - 1].id}
                />}
              </div>
            })()}
          </section>
          {(inspectorFetchError.versions || (versions && versions.length > 1)) && <section className="detail-section">
            <div className="field-heading">
              <span>{tr("版本")}</span>
              {versions && versions.length > 1 && <span className="settings-badge">{versions.length}</span>}
            </div>
            {inspectorFetchError.versions && <span className="muted">{tr("无法加载")}</span>}
            <div className="version-list" aria-label={tr("版本")}>
              {(versions || []).map(v => (
                <button
                  className="related"
                  key={v.id}
                  onClick={() => selectHistoryAsset(v.id)}
                >
                  {v.id === selected
                    ? <Icon name="check" size={12} />
                    : <i>{v.thumbnail_url ? <img src={v.thumbnail_url} alt="" loading="lazy" /> : null}</i>}
                  <span>
                    {tr("版本")} {v.version_index}
                    <small>
                      {[v.version_change || "", v.format || "—"].filter(Boolean).join(" · ")} · {v.width} × {v.height} · {timeLabel(v.created_at)}
                    </small>
                  </span>
                  <Icon name="right" size={11} />
                </button>
              ))}
            </div>
          </section>}
    </>
  )
}
