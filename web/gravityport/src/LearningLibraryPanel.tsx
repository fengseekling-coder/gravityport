// 任务 464：学习库视图右栏的「手册」页签。自带状态（照 FeedbackPanel / AiSettingsPanel
// 的做法），自己调 desktopAPI() 和 mosa-api.ts，App.tsx 只传必要回调。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import Icon from "./Icon"
import ToolbarSelect from "./ToolbarSelect"
import Button from "./ui/Button"
import { desktopAPI, type AiState } from "./desktop"
import type { Language } from "./i18n"
import {
  addLearningGuideEntry,
  deleteLearningGuideEntry,
  fetchLearningState,
  revertLearningRun,
  updateLearningGuideEntry,
  type MosaLearningGuideEntry,
  type MosaLearningState,
} from "./mosa-api"
import {
  GUIDE_SECTIONS,
  defaultAddSection,
  findRevertibleRunId,
  formatLearningLogDate,
  formatLearningUsd,
  groupGuideEntries,
  learningActionState,
  learningLogRowText,
  type GuideSectionId,
  type LearningBlockedState,
  type LearningFilter,
  type LearningQuoteData,
  type LearningStatusSnapshot,
} from "./learning-guide-model"
import {
  LearningAbandonDialog,
  LearningRevertDialog,
  LearningStartDialog,
} from "./LearningGuideDialogs"
import "./learning-library.css"

export type LearningLibraryPanelProps = {
  tr: (text: string) => string
  fillNamed: (text: string, values: Record<string, string | number>) => string
  language: Language
  project: string
  libraryId: string
  libraryName: string
  libraryCount: number
  refreshKey: number
  activeFilter: LearningFilter | null
  onShowFilter: (filter: LearningFilter | null) => void
  onOpenAiSettings: () => void
  onLearningChanged: () => void
  /** 每次取到学习状态都报一次「未学习」张数，顶栏和手册同一拍更新。 */
  onPendingCount?: (pending: number) => void
  notify: (text: string) => void
}

function errorCodeOf(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code?: unknown }).code || "")
  }
  return ""
}

function enrichBlockedQuote(quote: LearningQuoteData, aiState: AiState | null): LearningQuoteData {
  if (quote.ok || !aiState) return quote
  if (quote.blocked === "no-key" && !quote.serviceLabel && !quote.service?.label) {
    const slotServiceId = aiState.slots?.analysis?.serviceId || ""
    const service = aiState.services?.find((item) => item.id === slotServiceId)
      || aiState.catalog?.services?.find((item) => item.id === slotServiceId)
    if (service?.label) return { ...quote, serviceLabel: service.label }
  }
  if (quote.blocked === "unknown-price" && !quote.modelLabel && !quote.models?.analysis?.label) {
    const analysisId = aiState.slots?.analysis?.model || ""
    const summaryId = aiState.slots?.analysis?.summaryModel || ""
    const knownIds = new Set((aiState.catalog?.models || []).map((item) => item.id))
    const missingId = (analysisId && !knownIds.has(analysisId))
      ? analysisId
      : ((summaryId && !knownIds.has(summaryId)) ? summaryId : (analysisId || summaryId))
    if (missingId) return { ...quote, modelLabel: missingId }
  }
  return quote
}

function AutoGrowTextarea({
  value,
  maxLength,
  placeholder,
  ariaLabel,
  autoFocus,
  disabled,
  commitOnBlur = true,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string
  maxLength: number
  placeholder?: string
  ariaLabel: string
  autoFocus?: boolean
  disabled?: boolean
  commitOnBlur?: boolean
  onChange: (next: string) => void
  onCommit?: () => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const cancelledRef = useRef(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.max(el.scrollHeight, 32)}px`
  }, [value])

  useEffect(() => {
    if (!autoFocus || !ref.current) return
    const el = ref.current
    el.focus()
    const end = el.value.length
    el.setSelectionRange(end, end)
  }, [autoFocus])

  return (
    <textarea
      ref={ref}
      className="learn-guide-textarea"
      aria-label={ariaLabel}
      value={value}
      maxLength={maxLength}
      placeholder={placeholder}
      disabled={disabled}
      rows={1}
      onChange={(event) => onChange(event.target.value)}
      onBlur={() => {
        if (cancelledRef.current) {
          cancelledRef.current = false
          return
        }
        if (commitOnBlur) onCommit?.()
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault()
          event.stopPropagation()
          cancelledRef.current = true
          onCancel()
          return
        }
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault()
          event.stopPropagation()
          cancelledRef.current = true
          onCommit?.()
        }
      }}
    />
  )
}

export function LearningLibraryPanel({
  tr,
  fillNamed,
  language,
  project,
  libraryId,
  libraryName,
  libraryCount,
  refreshKey,
  activeFilter,
  onShowFilter,
  onOpenAiSettings,
  onLearningChanged,
  onPendingCount,
  notify,
}: LearningLibraryPanelProps) {
  const api = desktopAPI()
  const hasDesktopLearning = Boolean(
    api && typeof api.aiLearningStatus === "function" && typeof api.aiLearningQuote === "function",
  )

  const [state, setState] = useState<MosaLearningState | null>(null)
  const [statusSnapshot, setStatusSnapshot] = useState<LearningStatusSnapshot | null>(null)
  const [quote, setQuote] = useState<LearningQuoteData | null>(null)
  const [quoting, setQuoting] = useState(false)

  // Inline editing state
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState("")
  const [savingEntryId, setSavingEntryId] = useState<string | null>(null)

  // Inline add-entry state
  const [addingOpen, setAddingOpen] = useState(false)
  const [addSection, setAddSection] = useState<GuideSectionId>("composition")
  const [addDraft, setAddDraft] = useState("")
  const [addingBusy, setAddingBusy] = useState(false)

  // Dialog states
  const [confirmDialog, setConfirmDialog] = useState<{ mode: "start" | "resume"; runId?: string; quote: LearningQuoteData } | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [abandonRunId, setAbandonRunId] = useState<string | null>(null)
  const [abandonBusy, setAbandonBusy] = useState(false)
  const [revertRunId, setRevertRunId] = useState<string | null>(null)
  const [revertBusy, setRevertBusy] = useState(false)

  const loadSeqRef = useRef(0)
  const mountedRef = useRef(true)
  // 手册改动一条接一条发：每次都带上一条回来的 revision。并发发出去的几条
  // 会带同一个旧 revision，后到的那条必然 409（比如改完文字失焦、紧接着点锁）。
  // revision 只增不减，取较大值，防止晚到的旧快照把它拉回去。
  const revisionRef = useRef(0)
  const mutationChainRef = useRef<Promise<unknown>>(Promise.resolve())
  const watchingRunIdRef = useRef<string | null>(null)
  const prevActiveRunRef = useRef<{ id: string; status: string } | null>(null)
  const libraryNameRef = useRef(libraryName)
  libraryNameRef.current = libraryName
  const trRef = useRef(tr)
  trRef.current = tr
  const fillNamedRef = useRef(fillNamed)
  fillNamedRef.current = fillNamed
  const notifyRef = useRef(notify)
  notifyRef.current = notify
  const onLearningChangedRef = useRef(onLearningChanged)
  onLearningChangedRef.current = onLearningChanged
  const onPendingCountRef = useRef(onPendingCount)
  onPendingCountRef.current = onPendingCount

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Reset local editor/dialog states when switching libraries.
  useEffect(() => {
    setEditingId(null)
    setEditDraft("")
    setAddingOpen(false)
    setAddDraft("")
    setConfirmDialog(null)
    setAbandonRunId(null)
    setRevertRunId(null)
    watchingRunIdRef.current = null
    prevActiveRunRef.current = null
    revisionRef.current = 0
  }, [project, libraryId])

  const requestQuote = useCallback(async (runId?: string): Promise<LearningQuoteData | null> => {
    const bridge = desktopAPI()
    if (!bridge || typeof bridge.aiLearningQuote !== "function") return null
    const raw = await bridge.aiLearningQuote({
      project,
      libraryId,
      ...(runId ? { runId } : {}),
    }) as LearningQuoteData
    if (!raw.ok && (raw.blocked === "no-key" || raw.blocked === "unknown-price") && typeof bridge.aiGetState === "function") {
      const aiState = await bridge.aiGetState().catch(() => null)
      return enrichBlockedQuote(raw, aiState)
    }
    return raw
  }, [project, libraryId])

  const loadStateOnly = useCallback(async (): Promise<MosaLearningState | null> => {
    try {
      const next = await fetchLearningState(project, libraryId)
      if (!mountedRef.current) return null
      revisionRef.current = Math.max(revisionRef.current, next.guide.revision)
      setState(next)
      onPendingCountRef.current?.(next.counts.pending)
      return next
    } catch {
      return null
    }
  }, [project, libraryId])

  const loadAll = useCallback(async ({ announceRunId = null as string | null } = {}) => {
    const seq = ++loadSeqRef.current
    const bridge = desktopAPI()
    const isDesktop = Boolean(
      bridge && typeof bridge.aiLearningStatus === "function" && typeof bridge.aiLearningQuote === "function",
    )

    // 1. Always call aiLearningStatus first (sweeps interrupted runs in main process).
    let nextStatus: LearningStatusSnapshot | null = null
    if (isDesktop && bridge?.aiLearningStatus) {
      const statusRes = await bridge.aiLearningStatus({ project, libraryId }).catch(() => null)
      if (!mountedRef.current || seq !== loadSeqRef.current) return
      if (statusRes?.ok) {
        nextStatus = {
          run: statusRes.run ?? null,
          busyElsewhere: statusRes.busyElsewhere ?? null,
        }
        setStatusSnapshot(nextStatus)
      }
    } else {
      setStatusSnapshot(null)
    }

    // 2. Fetch learning state (guide, counts, runs).
    const nextState = await fetchLearningState(project, libraryId).catch(() => null)
    if (!mountedRef.current || seq !== loadSeqRef.current) return
    if (nextState) {
      revisionRef.current = Math.max(revisionRef.current, nextState.guide.revision)
      setState(nextState)
      onPendingCountRef.current?.(nextState.counts.pending)
    }

    // Announce completion / failure toast if a watched run just settled.
    if (announceRunId && nextState) {
      const finished = nextState.runs.find((item) => item.id === announceRunId)
      if (finished?.status === "done") {
        const updatedCount = Number(finished.change?.added || 0)
        notifyRef.current(fillNamedRef.current("已学完《{name}》，手册更新了 {n} 条", {
          name: libraryNameRef.current,
          n: updatedCount,
        }))
      } else if (finished?.status === "failed") {
        notifyRef.current(trRef.current("这次没学成：没有一张图分析成功"))
      }
    }

    // 3. Quote (skip when currently running/pausing; pass runId when paused).
    const activeRun = nextStatus?.run ?? null
    if (activeRun && (activeRun.status === "running" || activeRun.status === "pausing")) {
      prevActiveRunRef.current = { id: activeRun.id, status: activeRun.status }
      watchingRunIdRef.current = activeRun.id
      setQuoting(false)
      return
    }
    prevActiveRunRef.current = activeRun ? { id: activeRun.id, status: activeRun.status } : null
    if (!isDesktop) {
      setQuote(null)
      setQuoting(false)
      return
    }
    if (nextStatus?.busyElsewhere) {
      setQuote(null)
      setQuoting(false)
      return
    }
    setQuoting(true)
    try {
      const nextQuote = await requestQuote(activeRun?.status === "paused" ? activeRun.id : undefined)
      if (!mountedRef.current || seq !== loadSeqRef.current) return
      setQuote(nextQuote)
    } finally {
      if (mountedRef.current && seq === loadSeqRef.current) setQuoting(false)
    }
  }, [project, libraryId, requestQuote])

  // Initial load + reload when libraryId / libraryCount / refreshKey changes.
  useEffect(() => {
    void loadAll()
  }, [loadAll, libraryCount, refreshKey])

  // Poll aiLearningStatus every 1s while a run is running or pausing.
  const isActivelyRunning = Boolean(
    statusSnapshot?.run && (statusSnapshot.run.status === "running" || statusSnapshot.run.status === "pausing"),
  )
  useEffect(() => {
    if (!hasDesktopLearning || !isActivelyRunning) return
    let stopped = false
    let inFlight = false
    const tick = async () => {
      if (stopped || inFlight) return
      const bridge = desktopAPI()
      if (!bridge?.aiLearningStatus) return
      inFlight = true
      try {
        const res = await bridge.aiLearningStatus({ project, libraryId }).catch(() => null)
        if (stopped || !mountedRef.current || !res?.ok) return
        const nextStatus: LearningStatusSnapshot = {
          run: res.run ?? null,
          busyElsewhere: res.busyElsewhere ?? null,
        }
        setStatusSnapshot(nextStatus)
        const nextRun = nextStatus.run
        const stillRunning = Boolean(nextRun && (nextRun.status === "running" || nextRun.status === "pausing"))
        if (!stillRunning) {
          const settledRunId = watchingRunIdRef.current || prevActiveRunRef.current?.id || null
          watchingRunIdRef.current = null
          prevActiveRunRef.current = null
          await loadAll({ announceRunId: settledRunId })
          onLearningChangedRef.current()
        }
      } finally {
        inFlight = false
      }
    }
    const timer = window.setInterval(() => { void tick() }, 1000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [hasDesktopLearning, isActivelyRunning, project, libraryId, loadAll])

  const entries = state?.guide.entries ?? []
  const revision = state?.guide.revision ?? 0
  const runs = useMemo(() => (state?.runs ?? []).slice(0, 30), [state?.runs])
  const grouped = useMemo(() => groupGuideEntries(entries), [entries])
  // 定位通常只有一条；用户锁住旧的一条后重新学习，后台可能再加一条新的，
  // 每条都要显示出来（看不见的条目照样会进生成提示词）。
  const positioningEntries = useMemo(
    () => grouped.find((group) => group.section === "positioning")?.entries ?? [],
    [grouped],
  )
  const bodyGroups = useMemo(
    () => grouped.filter((group) => group.section !== "positioning"),
    [grouped],
  )
  const revertibleRunId = useMemo(() => findRevertibleRunId(runs, revision), [runs, revision])

  // 过滤着的那条不在手册里了（重新学习换掉、撤回、别处删了）→ 图墙回到全部，
  // 不留一个永远是 0 张的过滤标签。
  useEffect(() => {
    if (!state || activeFilter?.kind !== "entry") return
    if (!state.guide.entries.some((entry) => entry.id === activeFilter.id)) onShowFilter(null)
  }, [state, activeFilter, onShowFilter])

  const availableAddSections = useMemo(() => {
    const hasPositioning = positioningEntries.length > 0
    return GUIDE_SECTIONS
      .filter((item) => !(item.id === "positioning" && hasPositioning))
      .map((item) => ({ value: item.id, label: tr(item.label) }))
  }, [positioningEntries, tr])

  const action = useMemo(
    () => learningActionState({
      desktop: hasDesktopLearning,
      quote,
      status: statusSnapshot,
      quoting,
    }),
    [hasDesktopLearning, quote, statusSnapshot, quoting],
  )

  // ── Manual guide editing handlers ──
  const beginEdit = (entry: MosaLearningGuideEntry) => {
    setEditingId(entry.id)
    setEditDraft(entry.text)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditDraft("")
  }

  // 所有手册改动都排进同一条队；成功后再取一次手册，409 时取新的并提示。
  const runGuideMutation = (work: (baseRevision: number) => Promise<{ revision: number }>): Promise<boolean> => {
    const next = mutationChainRef.current.then(async () => {
      try {
        const result = await work(revisionRef.current)
        if (result.revision) revisionRef.current = Math.max(revisionRef.current, result.revision)
        await loadStateOnly()
        return true
      } catch (error) {
        if (errorCodeOf(error) === "LEARNING_GUIDE_CONFLICT") {
          await loadStateOnly()
          notify(tr("手册已经更新，请再改一次"))
        } else {
          notify(tr("无法保存这一条"))
        }
        return false
      }
    })
    mutationChainRef.current = next.catch(() => {})
    return next
  }

  const commitEdit = async (entry: MosaLearningGuideEntry) => {
    if (savingEntryId === entry.id) return
    const trimmed = editDraft.trim()
    setEditingId(null)
    if (!trimmed || trimmed === entry.text) return
    setSavingEntryId(entry.id)
    try {
      await runGuideMutation((baseRevision) => updateLearningGuideEntry(project, libraryId, entry.id, {
        baseRevision,
        text: trimmed,
      }))
    } finally {
      if (mountedRef.current) setSavingEntryId(null)
    }
  }

  const handleToggleLock = async (entry: MosaLearningGuideEntry) => {
    if (savingEntryId === entry.id) return
    setSavingEntryId(entry.id)
    try {
      await runGuideMutation((baseRevision) => updateLearningGuideEntry(project, libraryId, entry.id, {
        baseRevision,
        locked: !entry.locked,
      }))
    } finally {
      if (mountedRef.current) setSavingEntryId(null)
    }
  }

  const handleDeleteEntry = async (entry: MosaLearningGuideEntry) => {
    if (savingEntryId === entry.id) return
    setSavingEntryId(entry.id)
    try {
      const ok = await runGuideMutation((baseRevision) => deleteLearningGuideEntry(project, libraryId, entry.id, baseRevision))
      if (ok) notify(tr("已删除一条要点"))
    } finally {
      if (mountedRef.current) setSavingEntryId(null)
    }
  }

  const openAddForm = () => {
    const initial = defaultAddSection(entries)
    setAddSection(initial)
    setAddDraft("")
    setAddingOpen(true)
  }

  const closeAddForm = () => {
    setAddingOpen(false)
    setAddDraft("")
  }

  const handleAddEntry = async () => {
    const trimmed = addDraft.trim()
    if (!trimmed || addingBusy) return
    setAddingBusy(true)
    try {
      const ok = await runGuideMutation((baseRevision) => addLearningGuideEntry(project, libraryId, {
        baseRevision,
        section: addSection,
        text: trimmed,
      }))
      if (ok && mountedRef.current) closeAddForm()
    } finally {
      if (mountedRef.current) setAddingBusy(false)
    }
  }

  // ── Learning run actions (start / resume / pause / abandon / revert) ──
  const openStartConfirm = (mode: "start" | "resume", runId?: string) => {
    if (!quote || !quote.ok) return
    setConfirmDialog({ mode, runId, quote })
  }

  const handleConfirmStartOrResume = async () => {
    if (!confirmDialog || confirmBusy) return
    const bridge = desktopAPI()
    if (!bridge) return
    const { mode, runId, quote: activeQuote } = confirmDialog
    const quoteToken = activeQuote.quoteToken || ""
    setConfirmBusy(true)
    try {
      const result = mode === "resume" && runId
        ? await bridge.aiLearningResume?.({ runId, quoteToken })
        : await bridge.aiLearningStart?.({ quoteToken })
      if (!mountedRef.current) return
      if (result?.ok) {
        const startedRunId = ("runId" in result && typeof result.runId === "string" ? result.runId : null) || runId || null
        setConfirmDialog(null)
        watchingRunIdRef.current = startedRunId
        // Immediately read status so progress (or fast completion) renders without waiting 1s.
        const statusRes = await bridge.aiLearningStatus?.({ project, libraryId }).catch(() => null)
        if (!mountedRef.current) return
        if (statusRes?.ok) {
          const nextStatus: LearningStatusSnapshot = {
            run: statusRes.run ?? null,
            busyElsewhere: statusRes.busyElsewhere ?? null,
          }
          setStatusSnapshot(nextStatus)
          const stillActive = Boolean(nextStatus.run && (nextStatus.run.status === "running" || nextStatus.run.status === "pausing"))
          if (!stillActive) {
            watchingRunIdRef.current = null
            await loadAll({ announceRunId: startedRunId })
            onLearningChanged()
          }
        } else {
          await loadAll()
        }
        return
      }
      if (result?.reason === "quote-expired") {
        const freshQuote = await requestQuote(mode === "resume" ? runId : undefined)
        if (!mountedRef.current) return
        setQuote(freshQuote)
        if (freshQuote?.ok) {
          setConfirmDialog({ mode, runId, quote: freshQuote })
          notify(tr("花费估算已更新，请再确认一次"))
          return
        }
      }
      // 其余失败（另一个库抢先开学、素材库不可用……）关框后底部会换成对应的
      // 受阻提示；这两种重新取数也看不出原因，当场说一句。
      if (result && !result.ok && result.reason === "busy") {
        const busyName = "libraryName" in result && typeof result.libraryName === "string" ? result.libraryName : ""
        notify(fillNamed("「{name}」正在学习，学完再开始。", { name: busyName || tr("另一个学习库") }))
      } else if (result && !result.ok && result.reason === "library-unavailable") {
        notify(tr("素材库暂时不可用"))
      }
      setConfirmDialog(null)
      await loadAll()
    } finally {
      if (mountedRef.current) setConfirmBusy(false)
    }
  }

  const handlePause = async (runId: string) => {
    const bridge = desktopAPI()
    if (!bridge?.aiLearningPause) return
    await bridge.aiLearningPause({ runId }).catch(() => null)
    const statusRes = await bridge.aiLearningStatus?.({ project, libraryId }).catch(() => null)
    if (!mountedRef.current) return
    if (statusRes?.ok) {
      setStatusSnapshot({
        run: statusRes.run ?? null,
        busyElsewhere: statusRes.busyElsewhere ?? null,
      })
    }
  }

  const handleConfirmAbandon = async () => {
    if (!abandonRunId || abandonBusy) return
    const bridge = desktopAPI()
    if (!bridge?.aiLearningAbandon) return
    setAbandonBusy(true)
    try {
      await bridge.aiLearningAbandon({ runId: abandonRunId }).catch(() => null)
      if (!mountedRef.current) return
      setAbandonRunId(null)
      watchingRunIdRef.current = null
      await loadAll()
      onLearningChanged()
    } finally {
      if (mountedRef.current) setAbandonBusy(false)
    }
  }

  const handleConfirmRevert = async () => {
    if (!revertRunId || revertBusy) return
    setRevertBusy(true)
    try {
      await revertLearningRun(project, revertRunId)
      if (!mountedRef.current) return
      setRevertRunId(null)
      if (activeFilter?.kind === "entry") onShowFilter(null)
      await loadAll()
      onLearningChanged()
      notify(tr("已撤回这次学习的改动"))
    } catch (error) {
      if (!mountedRef.current) return
      setRevertRunId(null)
      if (errorCodeOf(error) === "LEARNING_GUIDE_CHANGED") {
        await loadAll()
        notify(tr("手册在这次学习后改过，无法撤回"))
      } else {
        notify(tr("无法撤回这次学习"))
      }
    } finally {
      if (mountedRef.current) setRevertBusy(false)
    }
  }

  const toggleSourceFilter = (entry: MosaLearningGuideEntry, sectionLabel: string) => {
    const isActive = activeFilter?.kind === "entry" && activeFilter.id === entry.id
    if (isActive) {
      onShowFilter(null)
    } else {
      onShowFilter({
        kind: "entry",
        id: entry.id,
        label: tr(sectionLabel),
        count: entry.sourceCount,
      })
    }
  }

  const renderEntryMeta = (entry: MosaLearningGuideEntry, sectionLabel: string) => {
    const isActiveSource = activeFilter?.kind === "entry" && activeFilter.id === entry.id
    const lockActionLabel = entry.locked ? tr("解锁这一条") : tr("锁住这一条")
    const lockTitle = `${lockActionLabel} · ${tr("锁住后重新学习不会改动这一条")}`
    return (
      <div className="learn-guide-entry-meta">
        {entry.sourceCount > 0 ? (
          <button
            type="button"
            className={`learn-guide-source ${isActiveSource ? "active" : ""}`}
            aria-pressed={isActiveSource}
            onClick={() => toggleSourceFilter(entry, sectionLabel)}
          >
            {fillNamed("来自 {n} 张", { n: entry.sourceCount })}
          </button>
        ) : (
          <span className="learn-guide-manual">{tr("手动添加")}</span>
        )}
        <button
          type="button"
          className={`learn-guide-lock ${entry.locked ? "locked" : ""}`}
          aria-pressed={entry.locked}
          aria-label={lockActionLabel}
          title={lockTitle}
          disabled={savingEntryId === entry.id}
          onClick={() => void handleToggleLock(entry)}
        >
          <Icon name="lock" size={16} />
        </button>
        <button
          type="button"
          className="learn-guide-delete"
          aria-label={tr("删除这一条")}
          title={tr("删除这一条")}
          disabled={savingEntryId === entry.id}
          onClick={() => void handleDeleteEntry(entry)}
        >
          <Icon name="trash" size={16} />
        </button>
      </div>
    )
  }

  const blockedMessage = (blocked: LearningBlockedState): string => {
    switch (blocked.blocked) {
      case "encryption-unavailable": return tr("这台电脑无法加密保存密钥，暂时不能学习。")
      case "no-service": return tr("还没有设置「学习」用哪家服务。")
      case "unsupported-service": return tr("学习暂时只支持 Claude，请在 AI 设置里把「学习」换成 Claude 的模型。")
      case "no-key": return fillNamed("还没有填 {service} 的密钥。", { service: blocked.serviceLabel || "Claude" })
      case "unknown-price": return fillNamed("{model} 不在单价表里，无法估算花费。", { model: blocked.modelLabel || tr("所选模型") })
      case "busy": return fillNamed("「{name}」正在学习，学完再开始。", { name: blocked.libraryName || tr("另一个学习库") })
      case "empty": return tr("学习库里还没有能学的图片")
      default: return tr("出了点问题，已暂停")
    }
  }

  const renderFooter = () => {
    switch (action.kind) {
      case "web-only":
        return <p className="learn-footer-note">{tr("学习只能在 GravityPort 桌面版中使用。")}</p>
      case "quoting":
        return (
          <button type="button" className="learn-footer-btn" disabled>
            {tr("正在估算花费…")}
          </button>
        )
      case "ready-first":
        return (
          <>
            {action.noPreview > 0 && (
              <p className="learn-footer-hint">
                {fillNamed("{k} 张还没生成缩略图，这次先跳过", { k: action.noPreview })}
              </p>
            )}
            <button
              type="button"
              className="learn-footer-btn"
              onClick={() => openStartConfirm("start")}
            >
              {fillNamed("开始学习 {n} 张（约 {price}）", {
                n: action.count,
                price: formatLearningUsd(action.estimateUsd, tr),
              })}
            </button>
          </>
        )
      case "ready-new":
        return (
          <>
            {action.noPreview > 0 && (
              <p className="learn-footer-hint">
                {fillNamed("{k} 张还没生成缩略图，这次先跳过", { k: action.noPreview })}
              </p>
            )}
            <button
              type="button"
              className="learn-footer-btn"
              onClick={() => openStartConfirm("start")}
            >
              {fillNamed("学新加的 {n} 张（约 {price}）", {
                n: action.count,
                price: formatLearningUsd(action.estimateUsd, tr),
              })}
            </button>
          </>
        )
      case "ready-summary":
        return (
          <>
            {action.noPreview > 0 && (
              <p className="learn-footer-hint">
                {fillNamed("{k} 张还没生成缩略图，这次先跳过", { k: action.noPreview })}
              </p>
            )}
            <button
              type="button"
              className="learn-footer-btn"
              onClick={() => openStartConfirm("start")}
            >
              {fillNamed("重新整理手册（约 {price}）", {
                price: formatLearningUsd(action.estimateUsd, tr),
              })}
            </button>
          </>
        )
      case "analyzing":
        return (
          <div className="learn-footer-progress">
            <div className="learn-footer-progress-row">
              <span className="learn-footer-status">
                {fillNamed("正在学习 {done} / {total} · 已花 {cost}", {
                  done: action.run.doneCount,
                  total: action.run.itemCount,
                  cost: formatLearningUsd(action.run.costUsd, tr),
                })}
              </span>
              <button
                type="button"
                className="learn-footer-link"
                onClick={() => void handlePause(action.run.id)}
              >
                {tr("暂停")}
              </button>
            </div>
            <div className="learn-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(action.progress * 100)}>
              <div className="learn-progress-fill" style={{ width: `${Math.round(action.progress * 100)}%` }} />
            </div>
          </div>
        )
      case "summarizing":
        return (
          <p className="learn-footer-status">
            {fillNamed("正在整理手册… · 已花 {cost}", {
              cost: formatLearningUsd(action.run.costUsd, tr),
            })}
          </p>
        )
      case "pausing":
        return <p className="learn-footer-status">{tr("正在暂停，等手上的几张做完…")}</p>
      case "paused":
        return (
          <div className="learn-footer-paused">
            <div className="learn-footer-reason-row">
              <span className="learn-footer-reason">{tr(action.reasonText)}</span>
              {action.showAiSettings && (
                <button type="button" className="learn-footer-link" onClick={onOpenAiSettings}>
                  {tr("打开 AI 设置")}
                </button>
              )}
            </div>
            <p className="learn-footer-meta">
              {fillNamed("学到 {done} / {total} · 已花 {cost}", {
                done: action.run.doneCount,
                total: action.run.itemCount,
                cost: formatLearningUsd(action.run.costUsd, tr),
              })}
            </p>
            {action.resumeBlocked && !action.quoting && (
              <div className="learn-footer-blocked">
                <p className="learn-footer-note">{blockedMessage(action.resumeBlocked)}</p>
                {action.resumeBlocked.showAiSettings && !action.showAiSettings && (
                  <button type="button" className="learn-footer-link" onClick={onOpenAiSettings}>
                    {tr("打开 AI 设置")}
                  </button>
                )}
              </div>
            )}
            <div className="learn-footer-paused-actions">
              {action.canResume && action.resumeEstimateUsd !== null ? (
                <button
                  type="button"
                  className="learn-footer-btn"
                  onClick={() => openStartConfirm("resume", action.run.id)}
                >
                  {fillNamed("继续（约 {price}）", {
                    price: formatLearningUsd(action.resumeEstimateUsd, tr),
                  })}
                </button>
              ) : (
                <button type="button" className="learn-footer-btn" disabled>
                  {action.quoting ? tr("正在估算花费…") : tr("继续")}
                </button>
              )}
              <button
                type="button"
                className="learn-footer-link"
                onClick={() => setAbandonRunId(action.run.id)}
              >
                {tr("放弃这次学习")}
              </button>
            </div>
          </div>
        )
      case "blocked": {
        if (action.blocked === "empty") {
          return (
            <button type="button" className="learn-footer-btn" disabled>
              {tr("学习库里还没有能学的图片")}
            </button>
          )
        }
        return (
          <div className="learn-footer-blocked">
            <p className="learn-footer-note">{blockedMessage(action)}</p>
            {action.showAiSettings && (
              <button type="button" className="learn-footer-link" onClick={onOpenAiSettings}>
                {tr("打开 AI 设置")}
              </button>
            )}
          </div>
        )
      }
    }
  }

  return (
    <div className="learn-library-panel">
      <div className="learn-library-scroll">
        {/* 1. 设计手册 */}
        {entries.length === 0 ? (
          <section className="learn-library-section">
            <h3 className="learn-library-heading">{tr("设计手册")}</h3>
            <p className="learn-library-empty-title">{tr("还没有设计手册")}</p>
            <p className="learn-library-empty-hint">
              {tr("学习这些图片后，配色、构图、光线等要点会整理在这里，每条都标明来自哪几张。")}
            </p>
          </section>
        ) : (
          <section className="learn-library-section learn-guide-list" aria-label={tr("设计手册")}>
            {positioningEntries.map((positioningEntry) => (
              <div
                key={positioningEntry.id}
                className="learn-guide-entry learn-guide-positioning"
                data-guide-entry-id={positioningEntry.id}
              >
                {editingId === positioningEntry.id ? (
                  <AutoGrowTextarea
                    value={editDraft}
                    maxLength={80}
                    ariaLabel={tr("一句话定位")}
                    autoFocus
                    disabled={savingEntryId === positioningEntry.id}
                    onChange={setEditDraft}
                    onCommit={() => void commitEdit(positioningEntry)}
                    onCancel={cancelEdit}
                  />
                ) : (
                  <button
                    type="button"
                    className="learn-guide-positioning-text"
                    onClick={() => beginEdit(positioningEntry)}
                  >
                    {positioningEntry.text}
                  </button>
                )}
                <div className="learn-guide-positioning-meta">
                  {renderEntryMeta(positioningEntry, "一句话定位")}
                </div>
              </div>
            ))}

            {bodyGroups.map((group) => (
              <div key={group.section} className="learn-guide-group">
                {group.entries.map((entry, index) => (
                  <div
                    key={entry.id}
                    className="learn-guide-entry"
                    data-guide-entry-id={entry.id}
                  >
                    <div className="learn-guide-entry-head">
                      <span className="learn-guide-section-label">
                        {index === 0 ? tr(group.label) : ""}
                      </span>
                      {renderEntryMeta(entry, group.label)}
                    </div>
                    {group.section === "palette" && entry.swatches.length > 0 && (
                      <div className="learn-guide-swatches">
                        {entry.swatches.slice(0, 6).map((swatch, swatchIndex) => (
                          <span
                            key={`${swatch.hex}-${swatchIndex}`}
                            className="learn-guide-swatch"
                            style={{ backgroundColor: swatch.hex }}
                            title={swatch.name ? `${swatch.name} ${swatch.hex}` : swatch.hex}
                          />
                        ))}
                      </div>
                    )}
                    {editingId === entry.id ? (
                      <AutoGrowTextarea
                        value={editDraft}
                        maxLength={240}
                        ariaLabel={tr(group.label)}
                        autoFocus
                        disabled={savingEntryId === entry.id}
                        onChange={setEditDraft}
                        onCommit={() => void commitEdit(entry)}
                        onCancel={cancelEdit}
                      />
                    ) : (
                      <button
                        type="button"
                        className="learn-guide-text"
                        onClick={() => beginEdit(entry)}
                      >
                        {entry.text}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ))}

            {addingOpen ? (
              <div className="learn-guide-add-form">
                <div className="learn-guide-add-select">
                  <ToolbarSelect
                    label={tr("分组")}
                    value={addSection}
                    options={availableAddSections}
                    onChange={(value) => setAddSection(value as GuideSectionId)}
                  />
                </div>
                <AutoGrowTextarea
                  value={addDraft}
                  maxLength={addSection === "positioning" ? 80 : 240}
                  placeholder={tr("写一条要点…")}
                  ariaLabel={tr("添加一条")}
                  autoFocus
                  disabled={addingBusy}
                  commitOnBlur={false}
                  onChange={setAddDraft}
                  onCommit={() => void handleAddEntry()}
                  onCancel={closeAddForm}
                />
                <div className="learn-guide-add-actions">
                  <Button variant="quiet" size="small" disabled={addingBusy} onClick={closeAddForm}>
                    {tr("取消")}
                  </Button>
                  <Button
                    variant="primary"
                    size="small"
                    disabled={!addDraft.trim() || addingBusy}
                    loading={addingBusy}
                    onClick={() => void handleAddEntry()}
                  >
                    {tr("添加")}
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="learn-guide-add-trigger"
                onClick={openAddForm}
              >
                <Icon name="plus" size={12} />
                <span>{tr("添加一条")}</span>
              </button>
            )}
          </section>
        )}

        {/* 2. 学习记录 */}
        <section className="learn-library-section learn-log-section">
          <h3 className="learn-library-heading">{tr("学习记录")}</h3>
          {runs.length === 0 ? (
            <>
              <p className="learn-library-empty-title">{tr("还没有学习记录")}</p>
              <p className="learn-library-empty-hint">{tr("每次学习的图片和手册的改动会记在这里。")}</p>
            </>
          ) : (
            <div className="learn-log-list">
              {runs.map((run) => {
                const dateLabel = formatLearningLogDate(run.startedAt, language)
                const rowText = learningLogRowText(run, tr)
                const summary = fillNamed(rowText.template, rowText.params)
                const clickable = run.kind === "learn" && run.itemCount > 0
                const isActiveRun = activeFilter?.kind === "run" && activeFilter.id === run.id
                const showRevert = run.id === revertibleRunId
                return (
                  <div
                    key={run.id}
                    className={`learn-log-row ${isActiveRun ? "active" : ""}`}
                    data-learning-run-id={run.id}
                  >
                    {clickable ? (
                      <button
                        type="button"
                        className="learn-log-main learn-log-clickable"
                        aria-pressed={isActiveRun}
                        onClick={() => {
                          if (isActiveRun) onShowFilter(null)
                          else onShowFilter({ kind: "run", id: run.id, label: dateLabel, count: run.itemCount })
                        }}
                      >
                        <span className="learn-log-date">{dateLabel}</span>
                        <span className="learn-log-summary">{summary}</span>
                      </button>
                    ) : (
                      <div className="learn-log-main">
                        <span className="learn-log-date">{dateLabel}</span>
                        <span className="learn-log-summary">{summary}</span>
                      </div>
                    )}
                    {showRevert && (
                      <button
                        type="button"
                        className="learn-log-revert"
                        onClick={() => setRevertRunId(run.id)}
                      >
                        {tr("撤回")}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>

      {/* 3. 底部固定操作区 */}
      <div className="learn-library-footer">
        {renderFooter()}
      </div>

      {/* 三个确认框 */}
      <LearningStartDialog
        open={Boolean(confirmDialog)}
        libraryName={libraryName}
        quote={confirmDialog?.quote ?? null}
        busy={confirmBusy}
        tr={tr}
        fillNamed={fillNamed}
        onCancel={() => setConfirmDialog(null)}
        onConfirm={() => void handleConfirmStartOrResume()}
      />
      <LearningAbandonDialog
        open={Boolean(abandonRunId)}
        busy={abandonBusy}
        tr={tr}
        onCancel={() => setAbandonRunId(null)}
        onConfirm={() => void handleConfirmAbandon()}
      />
      <LearningRevertDialog
        open={Boolean(revertRunId)}
        busy={revertBusy}
        tr={tr}
        onCancel={() => setRevertRunId(null)}
        onConfirm={() => void handleConfirmRevert()}
      />
    </div>
  )
}
