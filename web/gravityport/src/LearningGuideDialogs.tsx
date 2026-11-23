// 任务 464：学习手册的三个确认框（开始/重新整理/继续、放弃这次学习、撤回）。
// 复用公共 Dialog / Button；花钱的学习只允许经第一个确认框里的主按钮触发。
import Dialog from "./ui/Dialog"
import Button from "./ui/Button"
import { formatLearningUsd, type LearningQuoteData } from "./learning-guide-model"

type TranslateFn = (text: string) => string
type FillNamedFn = (text: string, values: Record<string, string | number>) => string

export function LearningStartDialog({
  open,
  libraryName,
  quote,
  busy,
  tr,
  fillNamed,
  onCancel,
  onConfirm,
}: {
  open: boolean
  libraryName: string
  quote: LearningQuoteData | null
  busy: boolean
  tr: TranslateFn
  fillNamed: FillNamedFn
  onCancel: () => void
  onConfirm: () => void
}) {
  if (!open || !quote || !quote.ok) return null
  const kind = quote.kind ?? "learn"
  const newCount = Number(quote.counts?.newCount ?? 0)
  const analyzedCount = Number(quote.counts?.analyzedCount ?? 0)
  const estimateText = formatLearningUsd(Number(quote.estimateUsd ?? 0), tr)
  const capText = formatLearningUsd(Number(quote.capUsd ?? 0), tr)
  const serviceLabel = quote.service?.label || quote.service?.id || "Claude"
  const analysisModel = quote.models?.analysis?.label || quote.models?.analysis?.id || ""
  const summaryModel = quote.models?.summary?.label || quote.models?.summary?.id || ""
  const longEdge = Number(quote.privacy?.longEdge ?? 960)

  const title = kind === "summary-only"
    ? fillNamed("重新整理《{name}》的手册？", { name: libraryName })
    : kind === "resume"
      ? fillNamed("继续学习《{name}》？", { name: libraryName })
      : fillNamed("开始学习《{name}》？", { name: libraryName })

  const scopeLine = kind === "summary-only"
    ? fillNamed("将根据已分析的 {m} 张图重新整理设计手册。锁住的条目不会改动。", { m: analyzedCount })
    : kind === "resume"
      ? (newCount > 0
          ? fillNamed("将继续分析剩下的 {n} 张图，再整理成设计手册。", { n: newCount })
          : tr("将重新整理设计手册。"))
      : fillNamed("将逐张分析 {n} 张图，再整理成设计手册。锁住的条目不会改动。", { n: newCount })

  const priceLine = fillNamed("预计花费约 {price}，最多 {cap}；快超过时会自动暂停。", {
    price: estimateText,
    cap: capText,
  })

  const privacyLine = newCount > 0
    ? fillNamed("每张图的缩小版（长边 {longEdge} 像素）、提示词和来源平台会发给 {service}：{analysisModel} 逐张分析，{summaryModel} 整理手册。", {
        longEdge,
        service: serviceLabel,
        analysisModel,
        summaryModel,
      })
    : fillNamed("已分析的文字笔记会发给 {service}（{summaryModel}），不发送图片。", {
        service: serviceLabel,
        summaryModel,
      })

  const confirmLabel = kind === "summary-only"
    ? tr("重新整理")
    : kind === "resume"
      ? tr("继续")
      : tr("开始学习")

  return (
    <Dialog
      open={open}
      title={title}
      closeLabel={tr("关闭")}
      onClose={() => { if (!busy) onCancel() }}
      actions={
        <>
          <Button variant="neutral" autoFocus disabled={busy} onClick={onCancel}>
            {tr("取消")}
          </Button>
          <Button variant="primary" loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="learn-dialog-body">
        <p>{scopeLine}</p>
        <p>{priceLine}</p>
        <p className="learn-dialog-privacy">{privacyLine}</p>
      </div>
    </Dialog>
  )
}

export function LearningAbandonDialog({
  open,
  busy,
  tr,
  onCancel,
  onConfirm,
}: {
  open: boolean
  busy: boolean
  tr: TranslateFn
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog
      open={open}
      title={tr("放弃这次学习吗？")}
      description={tr("已经分析过的图会保留，下次不用重新分析；没分析的下次再学。手册不会改动。")}
      closeLabel={tr("关闭")}
      onClose={() => { if (!busy) onCancel() }}
      actions={
        <>
          <Button variant="neutral" autoFocus disabled={busy} onClick={onCancel}>
            {tr("取消")}
          </Button>
          <Button variant="danger" loading={busy} onClick={onConfirm}>
            {tr("放弃")}
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  )
}

export function LearningRevertDialog({
  open,
  busy,
  tr,
  onCancel,
  onConfirm,
}: {
  open: boolean
  busy: boolean
  tr: TranslateFn
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog
      open={open}
      title={tr("撤回这次学习的改动吗？")}
      description={tr("手册会回到这次学习之前的样子。已经分析过的图不用重新分析，花费不退。")}
      closeLabel={tr("关闭")}
      onClose={() => { if (!busy) onCancel() }}
      actions={
        <>
          <Button variant="neutral" autoFocus disabled={busy} onClick={onCancel}>
            {tr("取消")}
          </Button>
          <Button variant="primary" loading={busy} onClick={onConfirm}>
            {tr("撤回")}
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  )
}
