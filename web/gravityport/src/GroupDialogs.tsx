// Group/stack dialogs moved out of App.tsx (task 395). Pure moves; no behavior changes.
import Icon from "./Icon"
import { renameGroup, deleteGroupKeepingAssets, mergeGroups, createGroup, type MosaAsset, type MosaNavigation } from "./mosa-api"
import { renameStack, dissolveStack, trashStack, assignStackToGroup } from "./library-actions"
import { describeError } from "./error-messages"
import { describeGroupStats } from "./group-stats"
import type { Language } from "./i18n"

export type GroupDialogsProps = {
  groupRename: { original: string; draft: string } | null
  setGroupRename: React.Dispatch<React.SetStateAction<{ original: string; draft: string } | null>>
  groupDeleteConfirm: string | null
  setGroupDeleteConfirm: React.Dispatch<React.SetStateAction<string | null>>
  groupMerge: { source: string; target: string } | null
  setGroupMerge: React.Dispatch<React.SetStateAction<{ source: string; target: string } | null>>
  groupStats: { name: string; values: Record<string, unknown> } | null
  setGroupStats: React.Dispatch<React.SetStateAction<{ name: string; values: Record<string, unknown> } | null>>
  stackRename: { stackId: string; initialName: string; draft: string } | null
  setStackRename: React.Dispatch<React.SetStateAction<{ stackId: string; initialName: string; draft: string } | null>>
  stackDissolveConfirm: { stackId: string; stackCount: number } | null
  setStackDissolveConfirm: React.Dispatch<React.SetStateAction<{ stackId: string; stackCount: number } | null>>
  stackTrashConfirm: { stackId: string; stackCount: number } | null
  setStackTrashConfirm: React.Dispatch<React.SetStateAction<{ stackId: string; stackCount: number } | null>>
  groupCreateWithSelection: { target: "asset" | "stack"; targetStackId?: string; draft: string } | null
  setGroupCreateWithSelection: React.Dispatch<React.SetStateAction<{ target: "asset" | "stack"; targetStackId?: string; draft: string } | null>>
  groupCreateError: string
  setGroupCreateError: React.Dispatch<React.SetStateAction<string>>
  project: string
  active: string
  stackId: string
  language: Language
  navigation: MosaNavigation | null
  batchIds: string[]
  tr: (text: string) => string
  fillNamed: (text: string, values: Record<string, string | number>) => string
  notify: (text: string) => void
  errorMessage: (error: unknown, language: Language) => string
  goTo: (partial: Partial<{ active: string; stackId: string; stackName: string; query: string; sortOrder: string; assetType: string }>, options?: { replace?: boolean }) => void
  scheduleSync: () => void
  sourceDisplayLabel: (code: string) => string
  setAssets: React.Dispatch<React.SetStateAction<MosaAsset[]>>
  setStackName: React.Dispatch<React.SetStateAction<string>>
  setSelectedIds: React.Dispatch<React.SetStateAction<string[]>>
  assignBatchToGroup: (targetProject: string, ids: string[], name: string) => Promise<{ succeeded: number; failed: number; firstError: string }>
}

export function GroupDialogs(props: GroupDialogsProps) {
  const {
    groupRename, setGroupRename, groupDeleteConfirm, setGroupDeleteConfirm, groupMerge, setGroupMerge,
    groupStats, setGroupStats, stackRename, setStackRename, stackDissolveConfirm, setStackDissolveConfirm,
    stackTrashConfirm, setStackTrashConfirm, groupCreateWithSelection, setGroupCreateWithSelection,
    groupCreateError, setGroupCreateError, project, active, stackId, language, navigation, batchIds,
    tr, fillNamed, notify, errorMessage, goTo, scheduleSync, sourceDisplayLabel, setAssets, setStackName,
    setSelectedIds, assignBatchToGroup,
  } = props
  return (
    <>
        {(groupRename || groupDeleteConfirm || groupMerge || groupStats) && <div className="group-dialog-backdrop" role="presentation">
          {/* 任务 359（DLG-06a）：读屏名称跟随各自标题，不再共用「分组管理」。 */}
          <div className="group-dialog" role="dialog" aria-modal="true" aria-label={groupRename ? tr("重命名分组")
            : groupDeleteConfirm ? fillNamed("删除分组「{group}」？", { group: groupDeleteConfirm })
            : groupMerge ? fillNamed("合并分组「{source}」", { source: groupMerge.source })
            : `${tr("分组统计")} · ${groupStats?.name || ""}`}>
            {groupRename && <form onSubmit={event => {
              event.preventDefault()
              const name = groupRename.draft.trim()
              if (!name || name === groupRename.original) { setGroupRename(null); return }
              renameGroup(project, groupRename.original, name).then(() => {
                if (active === `group:${groupRename.original}`) goTo({ active: `group:${name}` })
                scheduleSync(); setGroupRename(null)
              }).catch(error => notify(errorMessage(error, language)))
            }}><h3>{tr("重命名分组")}</h3><input autoFocus value={groupRename.draft} maxLength={80} onChange={event => setGroupRename(old => old ? { ...old, draft: event.target.value } : old)} /><div className="group-dialog-actions"><button type="button" className="neutral-button" onClick={() => setGroupRename(null)}>{tr("取消")}</button><button type="submit" className="primary-button">{tr("重命名")}</button></div></form>}
            {groupDeleteConfirm && <><h3>{fillNamed("删除分组「{group}」？", { group: groupDeleteConfirm })}</h3><p>{tr("分组中的素材不会被删除。")}</p><div className="group-dialog-actions"><button className="neutral-button" onClick={() => setGroupDeleteConfirm(null)}>{tr("取消")}</button><button className="primary-button" onClick={() => {
              const name = groupDeleteConfirm
              deleteGroupKeepingAssets(project, name).then(() => {
                if (active === `group:${name}`) goTo({ active: "所有素材" })
                scheduleSync(); setGroupDeleteConfirm(null)
              }).catch(error => notify(errorMessage(error, language)))
            }}>{tr("删除分组")}</button></div></>}
            {groupMerge && <><h3>{fillNamed("合并分组「{source}」", { source: groupMerge.source })}</h3><p>{tr("合并到：")}</p><p className="group-dialog-error">{fillNamed("「{source}」中的素材将移到所选分组，「{source}」随后删除。", { source: groupMerge.source })}</p><select value={groupMerge.target} onChange={event => setGroupMerge(old => old ? { ...old, target: event.target.value } : old)}>{navigation?.groups.filter(item => item.name !== groupMerge.source).map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select><div className="group-dialog-actions"><button className="neutral-button" onClick={() => setGroupMerge(null)}>{tr("取消")}</button><button className="primary-button" onClick={() => {
              const { source, target } = groupMerge
              mergeGroups(project, source, target).then(() => {
                if (active === `group:${source}`) goTo({ active: `group:${target}` })
                scheduleSync(); setGroupMerge(null)
              }).catch(error => notify(errorMessage(error, language)))
            }}>{tr("合并")}</button></div></>}
            {groupStats && (() => {
              const described = describeGroupStats(groupStats.values)
              return <>
                <h3>{tr("分组统计")} · {groupStats.name}</h3>
                <div className="group-stats-data">
                  {/* 任务 359（DLG-09b）：标签 + 数值不写冒号。 */}
                  {described.overview.map(item => <p key={item.label}>{language === "en" && item.enLabel ? item.enLabel : tr(item.label)} {item.value}</p>)}
                  {described.facets.map(facet => <div key={facet.title} className="group-stats-facet">
                    <strong>{tr(facet.title)}</strong>
                    {facet.entries.length
                      ? facet.entries.map(entry => <p key={entry.name}>
                          {/* 任务 359（HC-16）：来源码过显示名（ChatGPT 网页版…），分类原样。 */}
                          {facet.title === "按来源" ? sourceDisplayLabel(entry.name) : entry.name} {entry.count}
                        </p>)
                      : <p>{tr(facet.emptyText)}</p>}
                  </div>)}
                </div>
                <div className="group-dialog-actions"><button className="neutral-button" onClick={() => setGroupStats(null)}>{tr("关闭")}</button></div>
              </>
            })()}
          </div>
        </div>}

        {/* Stack rename dialog */}
        {stackRename && (
          <div className="group-dialog-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) setStackRename(null) }}>
            <div className="group-dialog" role="dialog" aria-modal="true" aria-label={tr("重命名堆叠")}>
              <form onSubmit={event => {
                event.preventDefault()
                const name = stackRename.draft.trim()
                if (!name) return
                renameStack(project, stackRename.stackId, name)
                  .then(() => {
                    notify("已重命名堆叠")
                    setAssets(old => old.map(a => a.stack && a.stack.id === stackRename.stackId ? { ...a, stack: { ...a.stack, name } } : a))
                    if (stackId === stackRename.stackId) setStackName(name)
                    setStackRename(null)
                    scheduleSync()
                  })
                  .catch(error => notify(errorMessage(error, language)))
              }}>
                <h3>{tr("重命名堆叠")}</h3>
                <input autoFocus value={stackRename.draft} maxLength={80} onChange={event => setStackRename(old => old ? { ...old, draft: event.target.value } : old)} />
                <div className="group-dialog-actions">
                  <button type="button" className="neutral-button" onClick={() => setStackRename(null)}>{tr("取消")}</button>
                  <button type="submit" className="primary-button">{tr("重命名")}</button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Stack dissolve confirmation */}
        {stackDissolveConfirm && (
          <div className="modal-layer delete-layer" onClick={event => { if (event.target === event.currentTarget) setStackDissolveConfirm(null) }}>
            <div className="delete-modal" role="alertdialog" aria-modal="true">
              <div className="delete-icon"><Icon name="layers" size={26} /></div>
              <h3>{tr("解散堆叠？")}</h3>
              <p>{tr("堆叠中的素材将恢复为独立素材，不会被删除。")}</p>
              <div className="delete-actions">
                <button className="neutral-button" onClick={() => setStackDissolveConfirm(null)}>{tr("取消")}</button>
                <button className="primary-button" onClick={() => {
                  const target = stackDissolveConfirm
                  setStackDissolveConfirm(null)
                  dissolveStack(project, target.stackId)
                    .then(result => {
                      // The server echoes the members it released; the toast
                      // counts those, not the stale menu-time count.
                      notify(result.assetIds.length === 1
                        ? tr("已解散堆叠，1 个素材已恢复为独立素材")
                        : fillNamed("已解散堆叠，{count} 个素材已恢复为独立素材", { count: result.assetIds.length }))
                      setAssets(old => old.map(a => a.stack && a.stack.id === target.stackId ? { ...a, stack: null } : a))
                      if (stackId === target.stackId) goTo({ stackId: "", stackName: "" })
                      scheduleSync()
                    })
                    .catch(error => notify(errorMessage(error, language)))
                }}>{tr("解散堆叠")}</button>
              </div>
            </div>
          </div>
        )}

        {/* Stack move-to-trash confirmation — a stack always confirms, the
        "不再提醒" suppression only ever covered plain assets. */}
        {stackTrashConfirm && (
          <div className="modal-layer delete-layer" onClick={event => { if (event.target === event.currentTarget) setStackTrashConfirm(null) }}>
            <div className="delete-modal" role="alertdialog" aria-modal="true">
              <div className="delete-icon"><Icon name="trash" size={26} /></div>
              <h3>{tr("将堆叠移到回收站？")}</h3>
              <p>{fillNamed("堆叠中的 {count} 个素材将一并移到回收站，90 天内可恢复。", { count: stackTrashConfirm.stackCount })}</p>
              <div className="delete-actions">
                <button className="neutral-button" onClick={() => setStackTrashConfirm(null)}>{tr("取消")}</button>
                <button className="primary-button" onClick={() => {
                  const target = stackTrashConfirm
                  setStackTrashConfirm(null)
                  trashStack(project, target.stackId)
                    .then(outcome => {
                      // 任务 359（TOAST-17）：全部失败固定句，不再出现「0 项」。
                      if (outcome.failed && !outcome.succeeded) {
                        notify("无法将堆叠移到回收站")
                      } else if (outcome.failed) {
                        notify(fillNamed("已将 {count} 个素材移到回收站，{failed} 个无法移动", { count: outcome.succeeded, failed: outcome.failed }))
                      } else if (outcome.succeeded) {
                        notify(outcome.succeeded === 1
                          ? tr("已将堆叠及其中 1 个素材移到回收站")
                          : fillNamed("已将堆叠及其中 {count} 个素材移到回收站", { count: outcome.succeeded }))
                      }
                      const failedIds = new Set(outcome.failedIds)
                      setAssets(old => old.filter(a => !(a.stack && a.stack.id === target.stackId && !failedIds.has(a.id))))
                      if (stackId === target.stackId) goTo({ stackId: "", stackName: "" })
                      scheduleSync()
                    })
                    .catch(error => notify(errorMessage(error, language)))
                }}>{tr("移到回收站")}</button>
              </div>
            </div>
          </div>
        )}

        {/* Create a group and move the menu's target into it. A server rejection
        (duplicate name) shows inside the dialog and keeps it open. */}
        {groupCreateWithSelection && (
          <div className="group-dialog-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) setGroupCreateWithSelection(null) }}>
            <div className="group-dialog" role="dialog" aria-modal="true" aria-label={tr("用所选素材新建分组")}>
              <form onSubmit={event => {
                event.preventDefault()
                const name = groupCreateWithSelection.draft.trim()
                if (!name) return
                const target = groupCreateWithSelection
                let moveFailedTo = ""
                createGroup(project, name)
                  .then(async () => {
                    if (target.target === "stack" && target.targetStackId) { await assignStackToGroup(project, target.targetStackId, name); return }
                    const outcome = await assignBatchToGroup(project, [...batchIds], name)
                    // 任务 359（TOAST-21b）：创建成功但移入失败给出带分组名的整句。
                    if (!outcome.succeeded) { moveFailedTo = name; throw new Error("move-into-group-failed") }
                  })
                  .then(() => {
                    notify(target.target === "stack"
                      ? fillNamed("已新建分组「{group}」，堆叠已移到其中", { group: name })
                      : fillNamed("已新建分组「{group}」，{count} 个素材已移到其中", { group: name, count: batchIds.length }))
                    if (target.target === "asset") setSelectedIds([])
                    setGroupCreateWithSelection(null)
                    scheduleSync()
                  })
                  .catch(error => setGroupCreateError(moveFailedTo
                    ? fillNamed("无法将素材移到「{group}」。", { group: moveFailedTo })
                    : describeError(error, language)))
              }}>
                <h3>{tr("用所选素材新建分组")}</h3>
                <input autoFocus value={groupCreateWithSelection.draft} maxLength={80} onChange={event => {
                  setGroupCreateError("")
                  setGroupCreateWithSelection(old => old ? { ...old, draft: event.target.value } : old)
                }} />
                {groupCreateError && <p className="group-dialog-error" role="alert">{groupCreateError}</p>}
                <div className="group-dialog-actions">
                  <button type="button" className="neutral-button" onClick={() => setGroupCreateWithSelection(null)}>{tr("取消")}</button>
                  <button type="submit" className="primary-button">{tr("新建")}</button>
                </div>
              </form>
            </div>
          </div>
        )}
    </>
  )
}
