// 任务 464：学习手册与学习记录的纯函数模型。
// 不依赖 DOM / React / Vite，单测（test/learning-guide-ui.test.mjs）直接编译后 import。

export type GuideSectionId =
  | "positioning"
  | "palette"
  | "composition"
  | "lighting"
  | "material"
  | "subject"
  | "mood"
  | "prompting"
  | "avoid"

export type GuideSectionMeta = {
  id: GuideSectionId
  label: string
}

export const GUIDE_SECTIONS: readonly GuideSectionMeta[] = [
  { id: "positioning", label: "一句话定位" },
  { id: "palette", label: "配色" },
  { id: "composition", label: "构图和镜头" },
  { id: "lighting", label: "光线" },
  { id: "material", label: "材质和质感" },
  { id: "subject", label: "人物和造型" },
  { id: "mood", label: "情绪" },
  { id: "prompting", label: "提示词写法" },
  { id: "avoid", label: "避免" },
] as const

const SECTION_LABEL_MAP = new Map<string, string>(
  GUIDE_SECTIONS.map((item) => [item.id, item.label]),
)

export type GuideSwatch = {
  hex: string
  name: string
}

export type GuideEntry = {
  id: string
  section: string
  position: number
  text: string
  swatches: GuideSwatch[]
  origin: string
  locked: boolean
  sources: string[]
  sourceCount: number
  updatedAt: string
}

export type GroupedGuideSection = {
  section: GuideSectionId
  label: string
  entries: GuideEntry[]
}

/** 按 GUIDE_SECTIONS 固定顺序分组，组内按 position 升序；空组不出现。 */
export function groupGuideEntries(entries: readonly GuideEntry[]): GroupedGuideSection[] {
  const buckets = new Map<GuideSectionId, GuideEntry[]>()
  for (const item of entries) {
    if (!SECTION_LABEL_MAP.has(item.section)) continue
    const key = item.section as GuideSectionId
    let list = buckets.get(key)
    if (!list) {
      list = []
      buckets.set(key, list)
    }
    list.push(item)
  }
  const result: GroupedGuideSection[] = []
  for (const meta of GUIDE_SECTIONS) {
    const list = buckets.get(meta.id)
    if (!list || list.length === 0) continue
    list.sort((a, b) => a.position - b.position)
    result.push({ section: meta.id, label: meta.label, entries: list })
  }
  return result
}

/** 新增条目的默认分组：「配色」以外的第一个空组，没有空组就「构图和镜头」。 */
export function defaultAddSection(entries: readonly GuideEntry[]): GuideSectionId {
  const used = new Set(entries.map((entry) => entry.section))
  for (const meta of GUIDE_SECTIONS) {
    if (meta.id === "palette") continue
    if (!used.has(meta.id)) return meta.id
  }
  return "composition"
}

/** 价格文字：一律美元，小于 $0.01 为「不到 $0.01」，否则 $ + 两位小数。 */
export function formatLearningUsd(usd: number, tr?: (text: string) => string): string {
  const value = Number(usd)
  if (!Number.isFinite(value) || value < 0.01) {
    return tr ? tr("不到 $0.01") : "不到 $0.01"
  }
  return `$${value.toFixed(2)}`
}

export type LearningStatusRun = {
  id: string
  libraryId?: string
  status: string
  phase: string
  itemCount: number
  doneCount: number
  failedCount: number
  skippedCount: number
  costUsd: number
  estimateUsd: number | null
  capUsd: number | null
  pauseReason: string
}

export type LearningStatusSnapshot = {
  run: LearningStatusRun | null
  busyElsewhere?: { libraryId: string; libraryName: string } | null
}

export type LearningQuoteData = {
  ok: boolean
  quoteToken?: string
  kind?: "learn" | "resume" | "summary-only"
  counts?: { newCount: number; analyzedCount: number; totalCount: number; noPreview: number }
  estimateUsd?: number
  capUsd?: number
  analysisUsd?: number
  summaryUsd?: number
  summaryCalls?: number
  service?: { id: string; label: string }
  models?: { analysis: { id: string; label: string; effort?: string }; summary: { id: string; label: string; effort?: string } }
  privacy?: { imageCount: number; longEdge: number }
  blocked?: string
  libraryId?: string
  libraryName?: string
  runId?: string
  serviceLabel?: string
  modelLabel?: string
}

export type LearningActionState =
  | { kind: "web-only" }
  | { kind: "quoting" }
  | { kind: "ready-first"; count: number; estimateUsd: number; noPreview: number }
  | { kind: "ready-new"; count: number; estimateUsd: number; noPreview: number }
  | { kind: "ready-summary"; estimateUsd: number; noPreview: number }
  | { kind: "analyzing"; run: LearningStatusRun; progress: number }
  | { kind: "summarizing"; run: LearningStatusRun }
  | { kind: "pausing"; run: LearningStatusRun }
  | {
      kind: "paused"
      run: LearningStatusRun
      reason: string
      reasonText: string
      showAiSettings: boolean
      canResume: boolean
      resumeEstimateUsd: number | null
      quoting: boolean
      /** 继续不了时为什么（继续报价被挡、或别的库正在学）；能继续时为 null。 */
      resumeBlocked: LearningBlockedState | null
    }
  | LearningBlockedState

export type LearningBlockedState = {
  kind: "blocked"
  blocked: string
  showAiSettings: boolean
  serviceLabel?: string
  modelLabel?: string
  libraryName?: string
}

const PAUSE_REASON_TEXT: Record<string, string> = {
  user: "已暂停",
  interrupted: "上次学习被中断了",
  auth: "Claude 拒绝了密钥，请到 AI 设置检查",
  "no-key": "Claude 的密钥被删除了",
  "rate-limit": "请求太多或额度已用完，稍后再继续",
  network: "连不上 Claude，检查网络或代理",
  server: "Claude 暂时出错，稍后再继续",
  unknown: "出了点问题，已暂停",
  "over-budget": "花费快超出报价，已暂停",
  "library-unavailable": "素材库暂时不可用",
  "summary-error": "整理手册时出错，可以再试一次",
}

/** 暂停原因对应的中文模板键（i18n.ts 里逐条有英文对照）。 */
export function pauseReasonText(reason: string | null | undefined): string {
  const key = String(reason || "")
  return PAUSE_REASON_TEXT[key] ?? PAUSE_REASON_TEXT.unknown
}

function busyElsewhereState(
  busy: { libraryId: string; libraryName: string },
  quote: LearningQuoteData | null | undefined,
): LearningBlockedState {
  return { kind: "blocked", blocked: "busy", showAiSettings: false, libraryName: busy.libraryName || quote?.libraryName || "" }
}

/** 报价被挡（ok: false）时显示哪一种受阻提示。 */
function blockedQuoteState(quote: LearningQuoteData): LearningBlockedState {
  const blocked = String(quote.blocked || "unknown")
  if (blocked === "no-service" || blocked === "unsupported-service") {
    return { kind: "blocked", blocked, showAiSettings: true }
  }
  if (blocked === "no-key") {
    return { kind: "blocked", blocked, showAiSettings: true, serviceLabel: quote.serviceLabel || quote.service?.label || "" }
  }
  if (blocked === "unknown-price") {
    return { kind: "blocked", blocked, showAiSettings: true, modelLabel: quote.modelLabel || quote.models?.analysis?.label || "" }
  }
  if (blocked === "busy") {
    return { kind: "blocked", blocked, showAiSettings: false, libraryName: quote.libraryName || "" }
  }
  return { kind: "blocked", blocked, showAiSettings: false }
}

/** 底部操作区的纯状态判定（对应设计表 B.3 每一行）。 */
export function learningActionState(input: {
  desktop: boolean
  quote: LearningQuoteData | null | undefined
  status: LearningStatusSnapshot | null | undefined
  quoting: boolean
}): LearningActionState {
  if (!input.desktop) return { kind: "web-only" }
  const run = input.status?.run ?? null
  if (run) {
    if (run.status === "pausing") return { kind: "pausing", run }
    if (run.status === "running") {
      if (run.phase === "summarize") return { kind: "summarizing", run }
      const total = Math.max(0, Number(run.itemCount || 0))
      const finished = Number(run.doneCount || 0) + Number(run.failedCount || 0) + Number(run.skippedCount || 0)
      const progress = total > 0 ? Math.min(1, Math.max(0, finished / total)) : 0
      return { kind: "analyzing", run, progress }
    }
    if (run.status === "paused") {
      const reason = run.pauseReason || "unknown"
      const canResume = Boolean(input.quote?.ok && input.quote.kind === "resume")
      // 继续也要报价：别的库正在学（主进程不给这个库报价）、或继续报价被挡
      // （密钥被删、服务换了……）时，「继续」按钮禁用，旁边要说清为什么。
      const resumeBlocked = canResume ? null
        : input.status?.busyElsewhere ? busyElsewhereState(input.status.busyElsewhere, input.quote)
          : input.quote && !input.quote.ok ? blockedQuoteState(input.quote) : null
      return {
        kind: "paused",
        run,
        reason,
        reasonText: pauseReasonText(reason),
        showAiSettings: reason === "auth" || reason === "no-key",
        canResume,
        resumeEstimateUsd: canResume ? Number(input.quote?.estimateUsd ?? 0) : null,
        quoting: Boolean(input.quoting),
        resumeBlocked,
      }
    }
  }
  if (input.status?.busyElsewhere) return busyElsewhereState(input.status.busyElsewhere, input.quote)
  if (input.quoting || !input.quote) return { kind: "quoting" }
  const quote = input.quote
  if (!quote.ok) return blockedQuoteState(quote)
  const noPreview = Number(quote.counts?.noPreview || 0)
  const estimateUsd = Number(quote.estimateUsd || 0)
  if (quote.kind === "summary-only") {
    return { kind: "ready-summary", estimateUsd, noPreview }
  }
  const newCount = Number(quote.counts?.newCount || 0)
  const analyzedCount = Number(quote.counts?.analyzedCount || 0)
  if (analyzedCount === 0) {
    return { kind: "ready-first", count: newCount, estimateUsd, noPreview }
  }
  return { kind: "ready-new", count: newCount, estimateUsd, noPreview }
}

export type LearningRunLogItem = {
  id: string
  kind: string
  status: string
  phase?: string
  pauseReason?: string
  itemCount: number
  doneCount: number
  failedCount: number
  skippedCount?: number
  costUsd: number
  change?: {
    added?: number
    replaced?: number
    keptLocked?: number
    droppedNoSource?: number
    reverted?: boolean
    edited?: number
    locked?: number
    unlocked?: number
    deleted?: number
  }
  guideRevisionAfter?: number | null
  startedAt?: string
  updatedAt?: string
}

export type LearningLogTextResult = {
  template: string
  params: Record<string, string | number>
}

/** 学习记录一行的模板键和参数。 */
export function learningLogRowText(
  run: LearningRunLogItem,
  tr?: (text: string) => string,
): LearningLogTextResult {
  const change = run.change || {}
  if (run.kind === "edit") {
    const added = Number(change.added || 0)
    const edited = Number(change.edited || 0)
    const deleted = Number(change.deleted || 0)
    const locked = Number(change.locked || 0)
    const unlocked = Number(change.unlocked || 0)
    const totalEdits = added + edited + deleted
    const lockChanges = locked + unlocked
    if (added > 0 && edited === 0 && deleted === 0 && lockChanges === 0) {
      return { template: "手动添加 {n} 条", params: { n: added } }
    }
    if (deleted > 0 && added === 0 && edited === 0 && lockChanges === 0) {
      return { template: "手动删除 {n} 条", params: { n: deleted } }
    }
    if (edited > 0 && added === 0 && deleted === 0 && lockChanges === 0) {
      return { template: "手动修改 {n} 条", params: { n: edited } }
    }
    if (totalEdits === 0 && locked > 0 && unlocked === 0) {
      return { template: "锁住 {n} 条", params: { n: locked } }
    }
    if (totalEdits === 0 && unlocked > 0 && locked === 0) {
      return { template: "解锁 {n} 条", params: { n: unlocked } }
    }
    return { template: "手动调整手册（{n} 处）", params: { n: Math.max(1, totalEdits + lockChanges) } }
  }

  const cost = formatLearningUsd(Number(run.costUsd || 0), tr)
  const done = Number(run.doneCount || 0)
  const total = Number(run.itemCount || 0)
  const failed = Number(run.failedCount || 0)

  if (run.status === "failed") {
    if (Number(run.costUsd || 0) > 0) {
      return { template: "这次没有学到内容 · 花费 {cost}", params: { cost } }
    }
    return { template: "这次没有学到内容", params: {} }
  }

  if (run.status === "canceled") {
    if (done > 0) {
      return { template: "已放弃 · 学了 {done} 张 · 花费 {cost}", params: { done, cost } }
    }
    return { template: "已放弃学习", params: {} }
  }

  if (run.status === "paused") {
    return { template: "已暂停 · 学到 {done} / {total} · 花费 {cost}", params: { done, total, cost } }
  }

  if (run.status === "running" || run.status === "pausing") {
    return { template: "正在学习 {done} / {total}", params: { done, total } }
  }

  // status === "done"
  const added = Number(change.added || 0)
  const replaced = Number(change.replaced || 0)
  const keptLocked = Number(change.keptLocked || 0)
  const reverted = Boolean(change.reverted)

  if (reverted) {
    if (total === 0) {
      return { template: "重新整理手册 · 已撤回 · 花费 {cost}", params: { cost } }
    }
    return { template: "学了 {done} 张 · 已撤回 · 花费 {cost}", params: { done, cost } }
  }

  if (total === 0) {
    if (keptLocked > 0) {
      return { template: "重新整理手册 · 更新 {added} 条 · 保留 {locked} 条锁定 · 花费 {cost}", params: { added, locked: keptLocked, cost } }
    }
    return { template: "重新整理手册 · 更新 {added} 条 · 花费 {cost}", params: { added, cost } }
  }

  if (failed > 0) {
    if (keptLocked > 0) {
      return { template: "学了 {done} 张（{failed} 张未成功）· 更新 {added} 条 · 保留 {locked} 条锁定 · 花费 {cost}", params: { done, failed, added, locked: keptLocked, cost } }
    }
    return { template: "学了 {done} 张（{failed} 张未成功）· 更新 {added} 条 · 花费 {cost}", params: { done, failed, added, cost } }
  }

  if (keptLocked > 0) {
    return { template: "学了 {done} 张 · 更新 {added} 条 · 保留 {locked} 条锁定 · 花费 {cost}", params: { done, added, locked: keptLocked, cost } }
  }

  if (replaced === 0) {
    return { template: "学了 {done} 张 · 新增 {added} 条 · 花费 {cost}", params: { done, added, cost } }
  }

  return { template: "学了 {done} 张 · 更新 {added} 条 · 花费 {cost}", params: { done, added, cost } }
}

/**
 * 最近一次已完成、没撤回过的学习 runId（仅这一行显示「撤回」按钮）。传了
 * 手册当前的 revision 时，这次学习之后手册又改过（手动改、锁、删）就不给撤回——
 * 后台照同一条规则回 409 LEARNING_GUIDE_CHANGED，按钮留着只会点了再报错。
 */
export function findRevertibleRunId(runs: readonly LearningRunLogItem[], currentRevision?: number): string | null {
  const latestDone = runs.find((run) => run.kind === "learn" && run.status === "done")
  if (!latestDone || latestDone.change?.reverted) return null
  if (currentRevision !== undefined && latestDone.guideRevisionAfter != null
    && Number(latestDone.guideRevisionAfter) !== Number(currentRevision)) return null
  return latestDone.id
}

export type LearningFilter =
  | { kind: "entry"; id: string; label: string; count: number }
  | { kind: "run"; id: string; label: string; count: number }

/** 图库查询的 learningEntry / learningRun 参数。 */
export function learningFilterParams(
  filter: LearningFilter | null | undefined,
): { learningEntry?: string; learningRun?: string } {
  if (!filter || !filter.id) return {}
  if (filter.kind === "entry") return { learningEntry: filter.id }
  if (filter.kind === "run") return { learningRun: filter.id }
  return {}
}

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const

/** 学习记录日期（本机时间）：中文「11 月 18 日」，英文 Nov 18；跨年加年份。 */
export function formatLearningLogDate(
  isoString: string | null | undefined,
  language: "zh" | "en",
  now: Date = new Date(),
): string {
  if (!isoString) return ""
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return ""
  const year = date.getFullYear()
  const month = date.getMonth()
  const day = date.getDate()
  const sameYear = year === now.getFullYear()
  if (language === "en") {
    return sameYear ? `${EN_MONTHS[month]} ${day}` : `${EN_MONTHS[month]} ${day}, ${year}`
  }
  return sameYear ? `${month + 1} 月 ${day} 日` : `${year} 年 ${month + 1} 月 ${day} 日`
}
