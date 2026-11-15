import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent,
  type SetStateAction,
} from "react"
import Icon from "./Icon"
import { InspectorRow, RelationThumb } from "./InspectorParts"
import { ReadingText } from "./ReadingText"
import { aspectRatioLabel, humanSize } from "./inspector-info"
import { conversationRoundRows, roundCompareSelection, type ConversationRoundRow } from "./conversation-rounds"
import { RELATION_LABELS, relationTypes } from "./feature-parity"
import type { Language } from "./i18n"
import {
  createGenerationRelation,
  dismissGenerationCandidate,
  editGenerationRelation,
  removeGenerationRelation,
  type MosaAsset,
  type MosaGenerationHistory,
  type MosaVersionRow,
} from "./mosa-api"
import Button from "./ui/Button"
import Dialog from "./ui/Dialog"
import Switch from "./ui/Switch"
import Text from "./ui/Text"
import TextField from "./ui/TextField"
import {
  canvasPdf,
  downloadBlob,
  renderAnnotationSheet,
  renderCanvasExport,
} from "./version-canvas-export"
import {
  COLUMN_GAP,
  NODE_HEIGHT,
  NODE_WIDTH,
  canvasFromHistory,
  edgeCurve,
  finalPathIds,
  planCanvasLink,
  submitCanvasCandidateAction,
  submitCanvasLink,
  type CanvasEdge,
  type CanvasMark,
  type CanvasNode,
} from "./version-canvas-model"
import VersionCompare, { type VersionCompareEntry } from "./version-compare"
import { generationDisplay, type GenerationDisplay } from "./version-tree"
import "./version-canvas.css"

type Props = {
  asset: MosaAsset
  generationHistory: MosaGenerationHistory | null
  versions: MosaVersionRow[] | null
  inspectorFetchError: { versions: boolean; history: boolean; recipes: boolean }
  project: string
  language: Language
  tr: (text: string) => string
  fillNamed: (text: string, values: Record<string, string | number>) => string
  timeLabel: (value?: string) => string
  relationPairLine: (upstream: GenerationDisplay, downstream: GenerationDisplay) => string
  providerDisplayLabel: (provider: string) => string
  relationBusy: boolean
  relationDrafts: Record<string, string>
  setRelationDrafts: Dispatch<SetStateAction<Record<string, string>>>
  mutateRelation: (action: () => Promise<unknown>) => Promise<void>
  onClose: () => void
  onOpenAsset: (id: string) => void
  onSelectVersion: (id: string) => void
}

type Gesture = {
  pointer: number
  x: number
  y: number
  initialX: number
  initialY: number
  node?: string
  moved: boolean
}

type LinkDraft = {
  pointer: number
  from: string
  side: "in" | "out"
  x: number
  y: number
  target: string
}

type NodeDraft = {
  x?: number
  y?: number
  final?: boolean
  note?: string
  marks?: CanvasMark[]
}

export default function VersionCanvas({
  asset,
  generationHistory,
  versions,
  inspectorFetchError,
  project,
  language,
  tr,
  fillNamed,
  timeLabel,
  relationPairLine,
  providerDisplayLabel,
  relationBusy,
  relationDrafts,
  setRelationDrafts,
  mutateRelation,
  onClose,
  onOpenAsset,
  onSelectVersion,
}: Props) {
  const doc = useMemo(
    () => canvasFromHistory(generationHistory, asset, timeLabel),
    [generationHistory, asset, timeLabel],
  )
  const [nodeDrafts, setNodeDrafts] = useState<Record<string, NodeDraft>>({})
  const nodes = useMemo(
    () =>
      doc.nodes.map((base) => {
        const draft = nodeDrafts[base.id]
        if (!draft) return base
        return {
          ...base,
          x: draft.x ?? base.x,
          y: draft.y ?? base.y,
          final: draft.final ?? base.final,
          note: draft.note ?? base.note,
          marks: draft.marks ?? base.marks,
        }
      }),
    [doc.nodes, nodeDrafts],
  )
  const edges = doc.edges
  const [selected, setSelected] = useState<string[]>([
    doc.nodes.some((item) => item.id === asset.id) ? asset.id : doc.nodes[0].id,
  ])
  const [inspector, setInspector] = useState(true)
  const [finalOnly, setFinalOnly] = useState(false)
  const [tab, setTab] = useState<"canvas" | "list">("canvas")
  const [tool, setTool] = useState<"select" | "hand">("select")
  const [transform, setTransform] = useState({ x: 24, y: 24, scale: 0.75 })
  const [compareMode, setCompareMode] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const [lightbox, setLightbox] = useState<CanvasNode | null>(null)
  const [annotating, setAnnotating] = useState<CanvasNode | null>(null)
  const [marks, setMarks] = useState<CanvasMark[]>([])
  const [menu, setMenu] = useState<{
    node: string
    x: number
    y: number
  } | null>(null)
  const [pendingDeleteRelation, setPendingDeleteRelation] = useState<{
    childGenerationId: string
    parentGenerationId: string
    relationType: string
  } | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [format, setFormat] = useState<"png" | "pdf">("png")
  const [exportOptions, setExportOptions] = useState({
    prompts: false,
    sources: false,
    notes: true,
  })
  const [exportPreview, setExportPreview] = useState("")
  const [exportBusy, setExportBusy] = useState(false)
  const [copyBusy, setCopyBusy] = useState(false)
  const [annotationResult, setAnnotationResult] = useState("")
  const [exportError, setExportError] = useState("")
  const [message, setMessage] = useState("")
  const stage = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const ignoreClick = useRef(false)
  const [link, setLink] = useState<LinkDraft | null>(null)
  const [promptExpanded, setPromptExpanded] = useState(false)
  const exportCanvas = useRef<HTMLCanvasElement | null>(null)
  const noteRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setSelected((old) => {
      const kept = old.filter((id) => doc.nodes.some((item) => item.id === id))
      if (kept.length) return kept
      return [doc.nodes.some((item) => item.id === asset.id) ? asset.id : doc.nodes[0].id]
    })
  }, [asset.id, doc.nodes])

  const node = nodes.find((item) => item.id === selected.at(-1)) || nodes[0]
  const finalCount = nodes.filter((item) => item.final).length
  const pathIds = useMemo(() => finalPathIds(nodes, edges), [nodes, edges])
  const visibleNodes = finalOnly
    ? nodes.filter((item) => pathIds.has(item.id))
    : nodes
  const visibleIds = new Set(visibleNodes.map((item) => item.id))
  const visibleEdges = edges.filter(
    (edge) =>
      visibleIds.has(edge.from) &&
      visibleIds.has(edge.to) &&
      (!finalOnly || !edge.suggested),
  )
  const columns = [...new Set(nodes.map((item) => item.column))]
  const worldWidth = Math.max(
    800,
    ...nodes.map((item) => item.x + NODE_WIDTH + 30),
  )
  const worldHeight = Math.max(
    600,
    ...nodes.map((item) => item.y + NODE_HEIGHT + 70),
  )

  const notify = (text: string) => setMessage(tr(text))
  const patchNode = (id: string, patch: NodeDraft) =>
    setNodeDrafts((old) => ({
      ...old,
      [id]: { ...(old[id] || {}), ...patch },
    }))
  const fit = () => {
    if (!stage.current) return
    const { clientWidth: width, clientHeight: height } = stage.current
    const scale = Math.min(
      (width - 64) / worldWidth,
      (height - 80) / worldHeight,
      1,
    )
    setTransform({
      scale: Math.max(0.2, scale),
      x: (width - worldWidth * scale) / 2,
      y: (height - worldHeight * scale) / 2 - 8,
    })
  }

  useLayoutEffect(() => {
    const observer = new ResizeObserver(fit)
    if (stage.current) observer.observe(stage.current)
    return () => observer.disconnect()
    // Resize fits the board; manual zoom and node moves do not refit it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspector, tab])

  useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => setMessage(""), 3000)
    return () => clearTimeout(timer)
  }, [message])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener("pointerdown", close)
    return () => window.removeEventListener("pointerdown", close)
  }, [menu])

  useEffect(() => {
    if (!exportOpen) return
    let cancelled = false
    setExportBusy(true)
    setExportError("")
    setExportPreview("")
    exportCanvas.current = null
    renderCanvasExport(
      doc.title,
      visibleNodes,
      visibleEdges,
      exportOptions,
      language,
    )
      .then((canvas) => {
        if (cancelled) return
        exportCanvas.current = canvas
        setExportPreview(canvas.toDataURL("image/png"))
      })
      .catch((error) => {
        if (!cancelled) setExportError(tr(error.message))
      })
      .finally(() => {
        if (!cancelled) setExportBusy(false)
      })
    return () => {
      cancelled = true
    }
    // Snapshot only changes when export options, language, or dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportOpen, exportOptions, language])

  const zoom = (factor: number) => {
    const rect = stage.current?.getBoundingClientRect()
    if (!rect) return
    setTransform((old) => {
      const scale = Math.min(1.8, Math.max(0.2, old.scale * factor))
      const ratio = scale / old.scale
      return {
        scale,
        x: rect.width / 2 - (rect.width / 2 - old.x) * ratio,
        y: rect.height / 2 - (rect.height / 2 - old.y) * ratio,
      }
    })
  }

  const fitRef = useRef(fit)
  fitRef.current = fit
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  useEffect(() => {
    const element = stage.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      if (event.ctrlKey || event.metaKey)
        zoomRef.current(event.deltaY < 0 ? 1.08 : 1 / 1.08)
      else
        setTransform((old) => ({
          ...old,
          x: old.x - event.deltaX,
          y: old.y - event.deltaY,
        }))
    }
    element.addEventListener("wheel", wheel, { passive: false })
    return () => element.removeEventListener("wheel", wheel)
  }, [tab])

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest("input, textarea, select, dialog"))
        return
      if (event.key === "Escape") {
        setMenu(null)
        setCompareMode(false)
      }
      if (event.code === "Space") {
        event.preventDefault()
        setTool("hand")
      }
      if (event.key.toLowerCase() === "v") setTool("select")
      if (event.key.toLowerCase() === "h") setTool("hand")
      if (event.key === "+" || event.key === "=") zoomRef.current(1.15)
      if (event.key === "-") zoomRef.current(1 / 1.15)
      if (event.key === "0") fitRef.current()
    }
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space") setTool("select")
    }
    window.addEventListener("keydown", key)
    window.addEventListener("keyup", up)
    return () => {
      window.removeEventListener("keydown", key)
      window.removeEventListener("keyup", up)
    }
  }, [])

  const selectNode = (id: string, additive: boolean) => {
    if (ignoreClick.current) {
      ignoreClick.current = false
      return
    }
    if (!additive && !compareMode) {
      setSelected([id])
      return
    }
    const next = selected.includes(id)
      ? selected.filter((item) => item !== id)
      : [...selected.slice(-1), id]
    setSelected(next)
    if (compareMode && next.length === 2) setCompareOpen(true)
  }
  const beginGesture = (event: PointerEvent, id?: string) => {
    if (
      event.button !== 0 ||
      (event.target as HTMLElement).closest(".vc-edge-label, .vc-branch-label")
    )
      return
    if (!id && (event.target as HTMLElement).closest("button")) return
    event.stopPropagation()
    ignoreClick.current = false
    const target = id ? nodes.find((item) => item.id === id) : null
    const moveNode = target && tool === "select"
    gesture.current = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      initialX: moveNode ? target.x : transform.x,
      initialY: moveNode ? target.y : transform.y,
      node: moveNode ? id : undefined,
      moved: false,
    }
    if (!id) stage.current?.setPointerCapture(event.pointerId)
  }
  const toWorld = (clientX: number, clientY: number) => {
    const rect = stage.current?.getBoundingClientRect()
    return {
      x: (clientX - (rect?.left || 0) - transform.x) / transform.scale,
      y: (clientY - (rect?.top || 0) - transform.y) / transform.scale,
    }
  }
  const nodeAtPoint = (clientX: number, clientY: number) => {
    const hit = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>("[data-canvas-node]")
    return hit?.dataset.canvasNode || ""
  }
  const beginLink = (event: PointerEvent, id: string, side: "in" | "out") => {
    if (event.button !== 0 || tool === "hand") return
    event.stopPropagation()
    event.preventDefault()
    setMenu(null)
    const point = toWorld(event.clientX, event.clientY)
    setLink({ pointer: event.pointerId, from: id, side, ...point, target: "" })
    try {
      stage.current?.setPointerCapture(event.pointerId)
    } catch {
      // A pointer that is no longer active cannot be captured; the stage
      // still receives the move/up events while the pointer is over it.
    }
  }
  const moveLink = (event: PointerEvent) => {
    if (!link || link.pointer !== event.pointerId) return false
    const point = toWorld(event.clientX, event.clientY)
    const over = nodeAtPoint(event.clientX, event.clientY)
    setLink({ ...link, ...point, target: over && over !== link.from ? over : "" })
    return true
  }
  const finishLink = (event: PointerEvent) => {
    if (!link || link.pointer !== event.pointerId) return false
    if (stage.current?.hasPointerCapture(event.pointerId))
      stage.current.releasePointerCapture(event.pointerId)
    const draft = link
    setLink(null)
    if (event.type === "pointercancel") return true
    const target = nodeAtPoint(event.clientX, event.clientY)
    if (!target || target === draft.from) return true
    const plan = planCanvasLink(
      nodes,
      edges,
      draft.from,
      target,
      draft.side,
      generationIdForAsset,
    )
    if (plan.kind === "exists") notify("这两张图之间已经有关系了")
    else if (plan.kind === "missing") notify("这张图没有生成记录，暂时不能连线")
    else if (plan.kind === "confirm") changeCandidate(plan.edge, true)
    else if (plan.kind === "create") {
      setSelected([plan.childId])
      runMutationWithToast(
        () => submitCanvasLink(project, plan),
        "已添加关系，可在右侧修改类型",
      )
    }
    return true
  }
  const moveGesture = (event: PointerEvent) => {
    if (moveLink(event)) return
    const drag = gesture.current
    if (!drag || drag.pointer !== event.pointerId) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (Math.abs(dx) + Math.abs(dy) < 5 && !drag.moved) return
    if (!drag.moved) stage.current?.setPointerCapture(event.pointerId)
    drag.moved = true
    if (drag.node)
      patchNode(drag.node, {
        x: Math.max(0, drag.initialX + dx / transform.scale),
        y: Math.max(78, drag.initialY + dy / transform.scale),
      })
    else
      setTransform((old) => ({
        ...old,
        x: drag.initialX + dx,
        y: drag.initialY + dy,
      }))
  }
  const finishGesture = (event: PointerEvent) => {
    if (finishLink(event)) return
    const drag = gesture.current
    if (drag?.moved) ignoreClick.current = true
    if (drag && stage.current?.hasPointerCapture(drag.pointer))
      stage.current.releasePointerCapture(drag.pointer)
    gesture.current = null
  }
  const startAnnotation = (item: CanvasNode) => {
    setMenu(null)
    setAnnotationResult("")
    setMarks(item.marks.map((mark) => ({ ...mark })))
    setAnnotating(item)
  }
  const toggleFinal = (item: CanvasNode) => {
    patchNode(item.id, { final: !item.final })
    notify(item.final ? "已取消定稿标记" : "已设为定稿")
    setMenu(null)
  }
  const runMutationWithToast = (
    action: () => Promise<unknown>,
    successToast?: string,
  ) => {
    let ok = false
    void mutateRelation(async () => {
      await action()
      ok = true
    }).then(() => {
      if (ok && successToast) notify(successToast)
    })
  }
  const changeCandidate = (edge: CanvasEdge, confirm: boolean) => {
    runMutationWithToast(
      () => submitCanvasCandidateAction(project, edge, confirm),
      confirm ? "已确认关系" : "已忽略候选关系",
    )
  }
  const exportFile = async () => {
    const canvas = exportCanvas.current
    if (!canvas) return
    try {
      if (format === "pdf")
        downloadBlob(canvasPdf(canvas), `${doc.title}.pdf`)
      else {
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (value) =>
              value
                ? resolve(value)
                : reject(new Error(tr("导出失败，请重试。"))),
            "image/png",
          ),
        )
        downloadBlob(blob, `${doc.title}.png`)
      }
      setExportOpen(false)
      notify("版本树已导出")
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : tr("导出失败，请重试。"),
      )
    }
  }
  const copyAnnotation = async () => {
    if (!annotating) return
    setCopyBusy(true)
    setAnnotationResult("")
    try {
      const blob = await renderAnnotationSheet(annotating, marks, language)
      try {
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": blob }),
        ])
        setAnnotationResult(tr("说明图已复制，可粘贴回原对话。"))
      } catch {
        downloadBlob(blob, `${annotating.name}-修改说明.png`)
        setAnnotationResult(tr("剪贴板不可用，已下载说明图。"))
      }
    } catch {
      setAnnotationResult(tr("说明图生成失败，请重试。"))
    } finally {
      setCopyBusy(false)
    }
  }

  const selectedNodes = selected
    .map((id) => nodes.find((item) => item.id === id))
    .filter((item): item is CanvasNode => !!item)
  const roundTitle = (item: CanvasNode) =>
    item.round ? fillNamed("第 {n} 轮", { n: item.round }) : tr("生成记录")
  const providerName = (provider: string) =>
    provider ? providerDisplayLabel(provider) : tr("本地素材")
  const relationLabel = (type: string) =>
    tr(RELATION_LABELS[type as keyof typeof RELATION_LABELS] || "衍生自")
  const openImage = (item: CanvasNode) => {
    setMenu(null)
    setLightbox(item)
  }

  const inspectedAsset =
    generationHistory?.output_assets?.find((item) => item.id === node.assetId) ||
    asset
  const currentAssetId = inspectedAsset.id
  const generationIdForAsset = (assetId: string) => {
    const seen = new Set<string>()
    for (const event of [
      ...(generationHistory?.events || []),
      ...(generationHistory?.context_events || []),
    ]) {
      const id = String(event.id || "")
      if (!id || seen.has(id)) continue
      seen.add(id)
      if (String(event.output_asset_id || "") === assetId) return id
    }
    return ""
  }
  const candidateList = (generationHistory?.relation_candidates || []).filter(
    (candidate) =>
      candidate.status !== "dismissed" && candidate.status !== "confirmed",
  )
  const roundSelection = roundCompareSelection(
    conversationRoundRows(generationHistory, currentAssetId),
    currentAssetId,
  )
  const turnLine = (turnIndex: number | null) =>
    turnIndex != null ? fillNamed("第 {n} 轮", { n: turnIndex }) : ""
  const focusCanvasOrVersion = (targetAssetId: string) => {
    if (nodes.some((item) => item.id === targetAssetId)) {
      setSelected([targetAssetId])
    } else {
      onSelectVersion(targetAssetId)
    }
  }
  const jumpToDisplay = (display: GenerationDisplay) =>
    display.known && display.asset && !display.isCurrent
      ? () => focusCanvasOrVersion(display.asset!.id)
      : undefined

  const renderNode = (item: CanvasNode) => (
    <div
      key={item.id}
      className={`vc-node ${selected.includes(item.id) ? "is-selected" : ""} ${
        item.final ? "is-final" : ""
      } ${link?.target === item.id ? "is-link-target" : ""} ${
        link?.from === item.id ? "is-link-source" : ""
      }`}
      data-canvas-node={item.id}
      style={{ left: item.x, top: item.y }}
      onPointerDown={(event) => beginGesture(event, item.id)}
      onContextMenu={(event) => {
        event.preventDefault()
        setSelected([item.id])
        setMenu({
          node: item.id,
          x: Math.min(event.clientX, window.innerWidth - 216),
          y: Math.min(event.clientY, window.innerHeight - 260),
        })
      }}
    >
      <Button
        className="vc-node-image"
        variant="quiet"
        aria-label={`${item.name} · ${roundTitle(item)}`}
        title={item.prompt ? `${item.name}\n${item.prompt}` : item.name}
        aria-pressed={selected.includes(item.id)}
        onClick={(event) =>
          selectNode(item.id, event.shiftKey || event.metaKey || event.ctrlKey)
        }
        onDoubleClick={() => openImage(item)}
      >
        <img src={item.image} alt={item.name} draggable={false} />
        {item.final && (
          <span className="vc-final-badge">
            <Icon name="check" size={12} />
            {tr("定稿")}
          </span>
        )}
        {(item.marks.length > 0 || item.note) && (
          <span className="vc-mark-badge">
            {item.note && <Icon name="message" size={12} />}
            {item.marks.length > 0 && (
              <>
                <Icon name="annotate" size={12} />
                {item.marks.length}
              </>
            )}
          </span>
        )}
        {selected.includes(item.id) && compareMode && (
          <span className="vc-select-number">
            {selected.indexOf(item.id) + 1}
          </span>
        )}
      </Button>
      <span
        className="vc-port vc-port-in"
        title={tr("拖到另一张图上：那张是这张的上一版")}
        onPointerDown={(event) => beginLink(event, item.id, "in")}
      />
      <span
        className="vc-port vc-port-out"
        title={tr("拖到另一张图上：那张是这张的下一版")}
        onPointerDown={(event) => beginLink(event, item.id, "out")}
      />
    </div>
  )

  return (
    <main className={`version-canvas ${inspector ? "with-inspector" : ""}`}>
      <header className="vc-header">
        <div className="vc-breadcrumb">
          <Button
            variant="quiet"
            iconOnly
            aria-label={tr("返回素材库")}
            title={tr("返回素材库")}
            onClick={onClose}
          >
            <Icon name="left" />
          </Button>
          <Text variant="label" title={doc.title}>
            {fillNamed("{name} 的版本树", { name: doc.title })}
          </Text>
          <Text tone="secondary" className="vc-summary">
            {fillNamed("{n} 张", { n: nodes.length })}
            {finalCount > 0 && (
              <>
                <span>·</span>
                {finalCount} {tr("个定稿")}
              </>
            )}
          </Text>
        </div>
        <div className="vc-header-actions">
          <div className="vc-view-tabs" aria-label={tr("版本树视图")}>
            <Button
              variant="quiet"
              aria-pressed={tab === "canvas"}
              className={tab === "canvas" ? "is-active" : ""}
              onClick={() => setTab("canvas")}
            >
              <Icon name="tree" />
              {tr("画布")}
            </Button>
            <Button
              variant="quiet"
              aria-pressed={tab === "list"}
              className={tab === "list" ? "is-active" : ""}
              onClick={() => setTab("list")}
            >
              <Icon name="list" />
              {tr("列表")}
            </Button>
          </div>
          <span className="vc-memory-status">
            <span />
            {tr("本页暂存")}
          </span>
          <Button
            variant="quiet"
            iconOnly
            aria-label={tr("显示素材详情")}
            aria-pressed={inspector}
            title={tr("素材详情")}
            onClick={() => setInspector((old) => !old)}
          >
            <Icon name="inspector" />
          </Button>
          <span className="vc-divider" />
          <Button onClick={() => setExportOpen(true)}>
            <Icon name="export" />
            {tr("导出版本树")}
          </Button>
        </div>
      </header>

      <section className="vc-board-area">
        <div className="vc-board-toolbar">
          <div className="vc-path-toggle">
            <Switch
              label={tr("只看定稿路径")}
              checked={finalOnly}
              onCheckedChange={setFinalOnly}
            />
            <Text>{tr("只看定稿路径")}</Text>
          </div>
          <div className="vc-board-actions">
            <Button
              variant="quiet"
              size="small"
              className={compareMode ? "is-active" : ""}
              onClick={() => {
                if (selected.length === 2) setCompareOpen(true)
                else {
                  setCompareMode((old) => !old)
                  notify("请选择两张素材进行对比")
                }
              }}
            >
              <Icon name="compare" />
              {tr("对比")}
              {compareMode && <span>{selected.length}/2</span>}
            </Button>
            <span className="vc-divider" />
            <Button
              variant="quiet"
              size="small"
              onClick={() => {
                setNodeDrafts((old) =>
                  Object.fromEntries(
                    Object.entries(old).map(([id, draft]) => [
                      id,
                      { ...draft, x: undefined, y: undefined },
                    ]),
                  ),
                )
                requestAnimationFrame(() => fitRef.current())
                notify("已恢复自动排版")
              }}
            >
              <Icon name="layout" />
              {tr("重新排版")}
            </Button>
          </div>
        </div>

        {tab === "canvas" ? (
          <div
            ref={stage}
            className={`vc-stage ${tool === "hand" ? "hand-tool" : ""}`}
            onPointerDown={(event) => beginGesture(event)}
            onPointerMove={moveGesture}
            onPointerUp={finishGesture}
            onPointerCancel={finishGesture}
          >
            {finalOnly && !visibleNodes.length && (
              <div className="vc-empty">
                <Icon name="flag" size={32} />
                <Text variant="title">{tr("还没有定稿")}</Text>
                <Text tone="secondary">
                  {tr("选中一张素材，设为定稿后即可查看路径。")}
                </Text>
                <Button onClick={() => setFinalOnly(false)}>
                  {tr("查看全部素材")}
                </Button>
              </div>
            )}
            <div
              className="vc-world"
              style={{
                width: worldWidth,
                height: worldHeight,
                transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
              }}
            >
              <div
                className="vc-timeline-line"
                style={{ width: Math.max(0, columns.length * COLUMN_GAP - 70) }}
              />
              {columns.map((column) => {
                const members = nodes.filter((item) => item.column === column)
                const round = members.every(
                  (item) => item.round === members[0].round,
                )
                  ? members[0].round
                  : null
                return (
                  <div
                    className="vc-round"
                    key={column}
                    style={{ left: 30 + column * COLUMN_GAP }}
                  >
                    <div className="vc-round-dot">{round || <span />}</div>
                    <Text variant="label">
                      {round
                        ? fillNamed("第 {n} 轮", { n: round })
                        : tr("生成记录")}
                    </Text>
                    <Text tone="secondary">
                      {members.length} {tr("张素材")}
                    </Text>
                  </div>
                )
              })}
              {columns.map((column) => {
                const members = visibleNodes.filter(
                  (item) => item.column === column,
                )
                if (members.length < 2) return null
                const top = Math.min(...members.map((item) => item.y)) - 20
                const bottom =
                  Math.max(...members.map((item) => item.y)) + NODE_HEIGHT + 20
                return (
                  <div
                    key={column}
                    className="vc-round-group"
                    style={{
                      left: 16 + column * COLUMN_GAP,
                      top,
                      height: bottom - top,
                    }}
                  />
                )
              })}
              <svg
                className="vc-edges"
                width={worldWidth}
                height={worldHeight}
                aria-label={tr("生成关系")}
              >
                {visibleEdges.map((edge) => {
                  const from = nodes.find((item) => item.id === edge.from)!
                  const to = nodes.find((item) => item.id === edge.to)!
                  return (
                    <g
                      key={edge.id}
                      className={edge.suggested ? "suggested" : ""}
                    >
                      <path d={edgeCurve(from, to)} />
                      <circle
                        cx={from.x + NODE_WIDTH}
                        cy={from.y + 136}
                        r="3"
                      />
                      <circle cx={to.x} cy={to.y + 136} r="3" />
                    </g>
                  )
                })}
                {link &&
                  (() => {
                    const from = nodes.find((item) => item.id === link.from)
                    if (!from) return null
                    const x1 = link.side === "out" ? from.x + NODE_WIDTH : from.x
                    const y1 = from.y + NODE_HEIGHT / 2
                    const bend = link.side === "out" ? 42 : -42
                    return (
                      <g className="vc-link-draft">
                        <path
                          d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${link.x - bend} ${link.y}, ${link.x} ${link.y}`}
                        />
                        <circle cx={link.x} cy={link.y} r="3" />
                      </g>
                    )
                  })()}
              </svg>
              {/* Suggested edges stay as faint dashed lines without a label;
                  they are confirmed by dragging along them or from the
                  inspector's suggestion list. */}
              {visibleEdges
                .filter((edge) => !edge.suggested)
                .map((edge) => {
                  const from = nodes.find((item) => item.id === edge.from)!
                  const to = nodes.find((item) => item.id === edge.to)!
                  if (to.column - from.column > 1)
                    return (
                      <div
                        className="vc-branch-label"
                        key={edge.id}
                        style={{
                          left: from.x + NODE_WIDTH + 42,
                          top: Math.max(from.y, to.y) + NODE_HEIGHT + 16,
                        }}
                      >
                        <Icon name="branch" size={12} />
                        {tr("回到这个方向")}
                      </div>
                    )
                  const left = (from.x + NODE_WIDTH + to.x) / 2
                  const top = (from.y + to.y) / 2 + 136
                  return (
                    <div className="vc-edge-label" key={edge.id} style={{ left, top }}>
                      <Text>{relationLabel(edge.type)}</Text>
                    </div>
                  )
                })}
              {visibleNodes.map(renderNode)}
            </div>
          </div>
        ) : (
          <div className="vc-list-view">
            {visibleNodes.map((item) => (
              <Button
                variant="quiet"
                className={`vc-list-row ${
                  selected.includes(item.id) ? "is-active" : ""
                }`}
                key={item.id}
                onClick={(event) => selectNode(item.id, event.shiftKey)}
                onDoubleClick={() => openImage(item)}
              >
                <img src={item.image} alt={item.name} />
                <span>
                  <Text variant="label">{item.name}</Text>
                  <Text as="p" tone="secondary">
                    {item.prompt || tr("无提示词记录")}
                  </Text>
                </span>
                <Text tone="secondary">{roundTitle(item)}</Text>
                {item.final && (
                  <span className="vc-list-final">
                    <Icon name="check" />
                    {tr("定稿")}
                  </span>
                )}
                <Icon name="right" size={12} />
              </Button>
            ))}
          </div>
        )}

        <div className="vc-board-bottom">
          <div className="vc-legend">
            <span>
              <i />
              {tr("已确认关系")}
            </span>
            <span>
              <i className="dashed" />
              {tr("候选关系")}
            </span>
          </div>
          <Button
            className="vc-help-button"
            variant="quiet"
            iconOnly
            aria-label={tr("画布操作说明")}
            title={tr(
              "滚动平移 · Ctrl / ⌘ + 滚动缩放 · 按 0 回到全图 · 从图边的点拖出连线 · Shift 多选 · 双击看大图",
            )}
            onClick={() =>
              notify("滚动平移 · Ctrl / ⌘ + 滚动缩放 · 按 0 回到全图 · 从图边的点拖出连线 · Shift 多选 · 双击看大图")
            }
          >
            <Icon name="info" />
          </Button>
        </div>
      </section>

      {inspector && (
        <aside className="vc-inspector">
          <div className="detail-heading vc-inspector-heading">
            <strong>
              {selected.length === 2 ? tr("已选择 2 张素材") : tr("素材详情")}
            </strong>
            <button
              aria-label={tr("关闭素材详情")}
              onClick={() => setInspector(false)}
            >
              <Icon name="inspector" size={16} />
            </button>
          </div>
          {selected.length === 2 ? (
            <div className="vc-inspector-content">
              <div className="vc-compare-thumbs">
                {selectedNodes.map((item) => (
                  <img src={item.image} alt={item.name} key={item.id} />
                ))}
              </div>
              <Text as="p" tone="secondary">
                {tr("并排查看两个版本，找到这一次的变化。")}
              </Text>
              <Button onClick={() => setCompareOpen(true)}>
                <Icon name="compare" />
                {tr("对比所选素材")}
              </Button>
            </div>
          ) : (
            <div className="vc-inspector-content" key={node.id}>
              <div className="asset-summary">
                <button
                  className="summary-image"
                  aria-label={tr("查看大图")}
                  onClick={() => openImage(node)}
                >
                  <img src={node.image} alt="" />
                  <Icon name="expand" />
                </button>
                <div className="asset-meta">
                  <div className="asset-title">
                    <span className="asset-name" title={node.name}>
                      {node.name}
                    </span>
                    <button
                      className={node.final ? "is-final" : ""}
                      aria-label={tr(node.final ? "取消定稿" : "设为定稿")}
                      title={tr(node.final ? "取消定稿" : "设为定稿")}
                      aria-pressed={node.final}
                      onClick={() => toggleFinal(node)}
                    >
                      <Icon name="flag" size={13} />
                    </button>
                  </div>
                  <span className="muted">
                    {[
                      roundTitle(node),
                      providerName(node.provider),
                      ...(node.final ? [tr("已定稿")] : []),
                    ].join(" · ")}
                  </span>
                  <button
                    className="summary-preview"
                    onClick={() => openImage(node)}
                  >
                    {tr("查看大图")}
                    <Icon name="right" size={12} />
                  </button>
                </div>
              </div>
              <div className="asset-properties">
                {(
                  [
                    ["格式", inspectedAsset.id === node.assetId ? inspectedAsset.format || "—" : "—"],
                    ["尺寸", node.width > 1 && node.height > 1 ? `${node.width} × ${node.height}` : "—"],
                    ["宽高比", aspectRatioLabel(node.width, node.height)],
                    ["大小", inspectedAsset.id === node.assetId ? humanSize(inspectedAsset.size_bytes) : "—"],
                  ] as [string, string][]
                )
                  .filter(([, value]) => value && value !== "—")
                  .map(([label, value]) => (
                    <span
                      className="property-tag"
                      key={label}
                      title={`${tr(label)}${language === "en" ? ": " : "："}${tr(value)}`}
                    >
                      {tr(value)}
                    </span>
                  ))}
              </div>
              <section className="detail-section">
                <div className="field-heading">
                  <span>{tr("提示词")}</span>
                  <button
                    aria-label={tr("复制提示词")}
                    disabled={!node.prompt}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(node.prompt)
                        notify("已复制提示词")
                      } catch {
                        notify("无法访问剪贴板，请手动复制。")
                      }
                    }}
                  >
                    <Icon name="copy" size={16} />
                  </button>
                </div>
                <ReadingText
                  id={`vc-prompt-${node.id}`}
                  text={node.prompt || tr("无提示词记录")}
                  expanded={promptExpanded}
                  onToggle={() => setPromptExpanded((old) => !old)}
                  expandLabel={tr("展开提示词")}
                  collapseLabel={tr("收起")}
                />
              </section>
              <section className="detail-section">
                <div className="field-heading">
                  <span>{tr("备注")}</span>
                </div>
                <TextField
                  ref={noteRef}
                  label={tr("素材备注")}
                  className="vc-note-field"
                  placeholder={tr("记下这一版的想法…")}
                  value={node.note}
                  maxLength={240}
                  onChange={(event) =>
                    patchNode(node.id, { note: event.target.value })
                  }
                />
              </section>
              <section className="detail-section">
                <div className="field-heading">
                  <span>{tr("标注")}</span>
                  <span className="field-actions">
                    <button
                      className="section-action"
                      onClick={() => startAnnotation(node)}
                    >
                      {tr(node.marks.length ? "编辑" : "添加")}
                    </button>
                  </span>
                </div>
                {node.marks.length ? (
                  node.marks.map((mark, index) => (
                    <div className="vc-mark-description" key={index}>
                      <span>{index + 1}</span>
                      <Text>{mark.text || tr("待补充修改要求")}</Text>
                    </div>
                  ))
                ) : (
                  <p className="muted">{tr("圈出要改的地方，让下一轮更明确。")}</p>
                )}
              </section>

              {roundSelection && (
                <div className="detail-section">
                  <div className="field-heading">
                    <span>{tr("版本对比")}</span>
                    <Icon name="compare" size={12} />
                  </div>
                  <VersionCompare
                    key={`rounds-${currentAssetId}`}
                    language={language}
                    captions
                    fields={["尺寸", "用户指令", "提示词"]}
                    entries={roundSelection.options.map((row: ConversationRoundRow): VersionCompareEntry => {
                      const output = row.outputAsset
                      return {
                        id: String(output?.id || ""),
                        label: row.turnIndex !== null ? fillNamed("第 {n} 轮", { n: row.turnIndex }) : tr("无轮次"),
                        imageUrl: output?.medium_url || output?.preview_url || output?.image_url || "",
                        values: {
                          "尺寸": output ? `${output.width} × ${output.height}` : "",
                          "用户指令": row.event.user_prompt || "",
                          "提示词": row.event.effective_prompt || "",
                        },
                      }
                    })}
                    defaultBaseId={String(roundSelection.base.outputAsset?.id || "")}
                    defaultTargetId={String(roundSelection.target.outputAsset?.id || "")}
                  />
                </div>
              )}

              <div className="detail-section">
                <div className="field-heading">
                  <span>{tr("生成关系")}</span>
                  <Icon name="branch" size={12} />
                </div>
                {inspectorFetchError.history ? (
                  <Text as="p" tone="secondary">
                    {tr("无法加载")}
                  </Text>
                ) : (
                  <div className="vc-relation-stack">
                    {!generationHistory?.events?.length && (
                      <Text as="p" tone="secondary">
                        {tr("暂无生成记录")}
                      </Text>
                    )}
                    {(generationHistory?.relations || []).map((relation) => {
                      const key = `${relation.child_generation_id}|${relation.parent_generation_id}|${relation.relation_type}`
                      const locked = relation.verification_level === "provider_verified"
                      const upstream = generationDisplay(generationHistory, relation.parent_generation_id, inspectedAsset)
                      const downstream = generationDisplay(generationHistory, relation.child_generation_id, inspectedAsset)
                      return (
                        <div className="generation-relation-editor" key={key}>
                          <span className="relation-pair-row">
                            <RelationThumb
                              display={upstream}
                              onClick={jumpToDisplay(upstream)}
                              label={tr("查看素材")}
                            />
                            <Icon name="right" size={12} />
                            <RelationThumb
                              display={downstream}
                              onClick={jumpToDisplay(downstream)}
                              label={tr("查看素材")}
                            />
                            <small>{relationPairLine(upstream, downstream)}</small>
                          </span>
                          <select
                            disabled={locked || relationBusy}
                            aria-label={tr("关系类型")}
                            value={relationDrafts[key] || relation.relation_type}
                            onChange={(event) =>
                              setRelationDrafts((old) => ({ ...old, [key]: event.target.value }))
                            }
                          >
                            {relationTypes.map((type) => (
                              <option key={type} value={type}>
                                {tr(RELATION_LABELS[type] || type)}
                              </option>
                            ))}
                          </select>
                          {locked ? (
                            <small>{tr("已由来源平台验证，无法修改")}</small>
                          ) : (
                            <>
                              <button
                                disabled={relationBusy}
                                onClick={() =>
                                  runMutationWithToast(
                                    () =>
                                      editGenerationRelation(project, {
                                        childGenerationId: relation.child_generation_id,
                                        parentGenerationId: relation.parent_generation_id,
                                        previousRelationType: relation.relation_type,
                                        relationType: relationDrafts[key] || relation.relation_type,
                                        evidence: relation.evidence,
                                      }),
                                    "已保存",
                                  )
                                }
                              >
                                {tr("保存关系")}
                              </button>
                              <button
                                disabled={relationBusy}
                                onClick={() =>
                                  setPendingDeleteRelation({
                                    childGenerationId: relation.child_generation_id,
                                    parentGenerationId: relation.parent_generation_id,
                                    relationType: relation.relation_type,
                                  })
                                }
                              >
                                {tr("删除关系")}
                              </button>
                            </>
                          )}
                        </div>
                      )
                    })}

                    {candidateList.length > 0 && (
                      <h4 className="vc-relation-subtitle">{tr("建议关系")}</h4>
                    )}
                    {candidateList.map((candidate) => {
                      const upstream = generationDisplay(generationHistory, candidate.parent_generation_id, inspectedAsset)
                      const downstream = generationDisplay(generationHistory, candidate.child_generation_id, inspectedAsset)
                      return (
                        <div
                          className="generation-relation-editor generation-candidate-card"
                          key={`${candidate.child_generation_id}|${candidate.parent_generation_id}`}
                        >
                          <span className="relation-pair-row">
                            <RelationThumb
                              display={upstream}
                              onClick={jumpToDisplay(upstream)}
                              label={tr("查看素材")}
                            />
                            <Icon name="right" size={12} />
                            <RelationThumb
                              display={downstream}
                              onClick={jumpToDisplay(downstream)}
                              label={tr("查看素材")}
                            />
                            <small>{relationPairLine(upstream, downstream)}</small>
                          </span>
                          <small>
                            {fillNamed("可信度 {percent}%", {
                              percent: Math.round((candidate.confidence || 0) * 100),
                            })}
                          </small>
                          <button
                            disabled={relationBusy}
                            onClick={() =>
                              runMutationWithToast(
                                () =>
                                  createGenerationRelation(project, {
                                    childGenerationId: candidate.child_generation_id,
                                    parentGenerationId: candidate.parent_generation_id,
                                    relationType: candidate.suggested_relation_type || "derived_from",
                                    evidence: candidate.evidence,
                                  }),
                                "已确认关系",
                              )
                            }
                          >
                            {tr("确认关系")}
                          </button>
                          <button
                            disabled={relationBusy}
                            onClick={() =>
                              runMutationWithToast(
                                () =>
                                  dismissGenerationCandidate(
                                    project,
                                    candidate.child_generation_id,
                                    candidate.parent_generation_id,
                                  ),
                                "已忽略候选关系",
                              )
                            }
                          >
                            {tr("忽略建议")}
                          </button>
                        </div>
                      )
                    })}

                  </div>
                )}
              </div>

              {(inspectorFetchError.versions || (versions && versions.length > 0)) && (
                <div className="detail-section">
                  <div className="field-heading">
                    <span>{tr("版本历史")}</span>
                    {versions && versions.length > 1 && (
                      <span className="settings-badge">{versions.length}</span>
                    )}
                  </div>
                  {inspectorFetchError.versions && (
                    <Text as="p" tone="secondary">
                      {tr("无法加载")}
                    </Text>
                  )}
                  <div className="vc-relation-stack">
                    {(versions || []).map((versionRow) =>
                      InspectorRow({
                        key: `version-${versionRow.id}`,
                        thumbnailUrl: versionRow.thumbnail_url,
                        isCurrent: versionRow.id === asset.id,
                        title: `${tr("版本")} ${versionRow.version_index}`,
                        detail: [
                          versionRow.version_change || "",
                          timeLabel(versionRow.created_at),
                        ]
                          .filter(Boolean)
                          .join(" · "),
                        onClick:
                          versionRow.id === asset.id
                            ? undefined
                            : () => onSelectVersion(versionRow.id),
                      }),
                    )}
                  </div>
                  {versions && versions.length > 1 && (
                    <div className="vc-history-compare">
                      <VersionCompare
                        key={`family-${asset.id}`}
                        language={language}
                        fields={["尺寸", "提示词", "变更说明"]}
                        entries={versions.map((versionRow) => ({
                          id: versionRow.id,
                          label: `${tr("版本")} ${versionRow.version_index}`,
                          imageUrl:
                            versionRow.medium_url ||
                            versionRow.preview_url ||
                            versionRow.image_url,
                          values: {
                            "尺寸": `${versionRow.width} × ${versionRow.height}`,
                            "提示词": versionRow.prompt,
                            "变更说明": versionRow.version_change || "",
                          },
                        }))}
                        defaultBaseId={versions[0].id}
                        defaultTargetId={versions[versions.length - 1].id}
                      />
                    </div>
                  )}
                </div>
              )}

            </div>
          )}
          <div className="vc-inspector-footer">
            <Icon name="local" size={12} />
            <Text tone="secondary">{tr("画布修改仅保留在当前页面")}</Text>
          </div>
        </aside>
      )}

      <footer className="vc-statusbar">
        <div>
          <Icon name="tree" size={12} />
          <Text tone="secondary">{tr("每一次迭代，都有迹可循。")}</Text>
        </div>
        <Text tone="secondary">{tr("Shift 多选 · 双击查看大图")}</Text>
      </footer>

      {menu && (
        <div
          className="vc-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          role="menu"
          aria-label={tr("素材操作")}
        >
          <Button
            variant="quiet"
            role="menuitem"
            onClick={() =>
              openImage(nodes.find((item) => item.id === menu.node)!)
            }
          >
            <Icon name="expand" />
            {tr("查看大图")}
          </Button>
          <Button
            variant="quiet"
            role="menuitem"
            onClick={() =>
              startAnnotation(nodes.find((item) => item.id === menu.node)!)
            }
          >
            <Icon name="annotate" />
            {tr("添加标注")}
          </Button>
          <Button
            variant="quiet"
            role="menuitem"
            onClick={() => {
              setMenu(null)
              setInspector(true)
              setTimeout(() => noteRef.current?.focus(), 50)
            }}
          >
            <Icon name="message" />
            {tr("编辑备注")}
          </Button>
          <span className="vc-context-divider" />
          <Button
            variant="quiet"
            role="menuitem"
            onClick={() =>
              toggleFinal(nodes.find((item) => item.id === menu.node)!)
            }
          >
            <Icon name="flag" />
            {tr(
              nodes.find((item) => item.id === menu.node)!.final
                ? "取消定稿"
                : "设为定稿",
            )}
          </Button>
          <span className="vc-context-divider" />
          <Button
            variant="quiet"
            role="menuitem"
            onClick={() => {
              const target = nodes.find((item) => item.id === menu.node)
              setMenu(null)
              if (target?.assetId) onOpenAsset(target.assetId)
            }}
          >
            <Icon name="folder" />
            {tr("在素材库中显示")}
          </Button>
        </div>
      )}
      {message && (
        <div className="vc-toast" role="status">
          <Icon name="check" />
          <Text>{message}</Text>
        </div>
      )}

      <Dialog
        open={!!pendingDeleteRelation}
        title={tr("删除生成关系？")}
        closeLabel={tr("关闭")}
        onClose={() => setPendingDeleteRelation(null)}
        actions={
          <>
            <Button onClick={() => setPendingDeleteRelation(null)}>
              {tr("取消")}
            </Button>
            <Button
              variant="danger"
              disabled={relationBusy}
              onClick={() => {
                const target = pendingDeleteRelation
                setPendingDeleteRelation(null)
                if (!target) return
                runMutationWithToast(() => removeGenerationRelation(project, target))
              }}
            >
              {tr("删除关系")}
            </Button>
          </>
        }
      >
        <Text tone="secondary">{tr("此操作无法撤销。")}</Text>
      </Dialog>

      <Dialog
        open={!!lightbox}
        title={lightbox ? `${lightbox.name} · ${roundTitle(lightbox)}` : ""}
        closeLabel={tr("关闭")}
        onClose={() => setLightbox(null)}
        actions={
          <Button
            onClick={() => {
              if (lightbox) startAnnotation(lightbox)
              setLightbox(null)
            }}
          >
            <Icon name="annotate" />
            {tr("添加标注")}
          </Button>
        }
      >
        {lightbox && (
          <div className="vc-lightbox">
            <img src={lightbox.image} alt={lightbox.name} />
          </div>
        )}
      </Dialog>

      <Dialog
        open={compareOpen}
        title={tr("版本对比")}
        description={tr("并排查看两个版本，找到这一次的变化。")}
        closeLabel={tr("关闭")}
        onClose={() => setCompareOpen(false)}
      >
        <div className="vc-compare">
          {selectedNodes.slice(0, 2).map((item) => (
            <div key={item.id}>
              <img src={item.image} alt={item.name} />
              <Text as="h3" variant="label">
                {item.name}
                <span className="vc-inline-separator">·</span>
                {roundTitle(item)}
              </Text>
              <Text as="p" tone="secondary">
                {item.prompt || tr("无提示词记录")}
              </Text>
            </div>
          ))}
        </div>
      </Dialog>

      <Dialog
        open={!!annotating}
        title={tr("标注修改要求")}
        description={tr(
          "点击图片添加编号标记，在下方写下对应的修改要求。原图不会被修改。",
        )}
        closeLabel={tr("关闭")}
        onClose={() => setAnnotating(null)}
        actions={
          <>
            <Button
              disabled={!marks.length}
              loading={copyBusy}
              onClick={copyAnnotation}
            >
              <Icon name="copy" />
              {tr("复制说明图")}
            </Button>
            <Button onClick={() => setAnnotating(null)}>{tr("取消")}</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (annotating) patchNode(annotating.id, { marks })
                setAnnotating(null)
                notify("标注已暂存")
              }}
            >
              {tr("保存")}
            </Button>
          </>
        }
      >
        {annotating && (
          <div className="vc-annotation">
            <div className="vc-annotation-tools">
              <span>
                <Icon name="annotate" />
                <Text>{tr("圈选标记")}</Text>
              </span>
              <Button
                variant="quiet"
                size="small"
                disabled={!marks.length}
                onClick={() => setMarks((old) => old.slice(0, -1))}
              >
                <Icon name="undo" />
                {tr("撤销")}
              </Button>
            </div>
            <Button
              variant="quiet"
              className="vc-annotation-image"
              style={{
                aspectRatio: `${annotating.width || 3} / ${annotating.height || 4}`,
              }}
              aria-label={tr("在图片上添加标记")}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                const keyboard = event.detail === 0
                setMarks((old) => [
                  ...old,
                  {
                    x: keyboard
                      ? 0.5
                      : (event.clientX - rect.left) / rect.width,
                    y: keyboard
                      ? 0.5
                      : (event.clientY - rect.top) / rect.height,
                    text: "",
                  },
                ])
              }}
            >
              <img src={annotating.image} alt={annotating.name} />
              {marks.map((mark, index) => (
                <span
                  className="vc-annotation-mark"
                  key={index}
                  style={{ left: `${mark.x * 100}%`, top: `${mark.y * 100}%` }}
                >
                  <span>{index + 1}</span>
                </span>
              ))}
            </Button>
            <div className="vc-annotation-fields">
              {marks.map((mark, index) => (
                <TextField
                  key={index}
                  label={`${index + 1}. ${tr("修改要求")}`}
                  placeholder={tr("这里需要怎样调整？")}
                  value={mark.text}
                  maxLength={200}
                  onChange={(event) =>
                    setMarks((old) =>
                      old.map((item, i) =>
                        i === index
                          ? { ...item, text: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
              ))}
            </div>
            {annotationResult && (
              <Text as="p" role="status">
                {annotationResult}
              </Text>
            )}
          </div>
        )}
      </Dialog>

      <Dialog
        open={exportOpen}
        title={tr("导出版本树")}
        description={tr("把创作过程分享出去，私有信息留给自己。")}
        closeLabel={tr("关闭")}
        onClose={() => setExportOpen(false)}
        actions={
          <>
            <Button onClick={() => setExportOpen(false)}>{tr("取消")}</Button>
            <Button
              variant="primary"
              loading={exportBusy}
              disabled={!exportPreview || !!exportError}
              onClick={exportFile}
            >
              <Icon name="export" />
              {tr("导出")} {format.toUpperCase()}
            </Button>
          </>
        }
      >
        <div className="vc-export">
          <div className="vc-export-preview">
            {exportPreview ? (
              <img src={exportPreview} alt={tr("导出内容预览")} />
            ) : (
              <Text tone="secondary">
                {tr(exportError ? "无法生成预览" : "正在生成预览…")}
              </Text>
            )}
            <span>
              {tr(finalOnly ? "仅定稿路径" : "完整版本树")} ·{" "}
              {visibleNodes.length} {tr("张素材")}
            </span>
          </div>
          <div className="vc-export-options">
            <Text variant="label">{tr("文件格式")}</Text>
            <div className="vc-export-formats">
              {(["png", "pdf"] as const).map((value) => (
                <Button
                  key={value}
                  aria-pressed={format === value}
                  className={format === value ? "is-active" : ""}
                  onClick={() => setFormat(value)}
                >
                  <Icon name={value === "png" ? "image" : "document"} />
                  {value.toUpperCase()}
                  {format === value && <Icon name="check" size={12} />}
                </Button>
              ))}
            </div>
            <Text variant="label">{tr("包含的内容")}</Text>
            {([
              ["notes", "备注与标注"],
              ["prompts", "提示词与用户指令"],
              ["sources", "来源平台"],
            ] as const).map(([key, label]) => (
              <div className="vc-export-option" key={key}>
                <Text>{tr(label)}</Text>
                <Switch
                  label={tr(label)}
                  checked={exportOptions[key]}
                  onCheckedChange={(value) =>
                    setExportOptions((old) => ({ ...old, [key]: value }))
                  }
                />
              </div>
            ))}
            <div className="vc-export-privacy">
              <Icon name="lock" />
              <Text tone="secondary">
                {tr(
                  "提示词与来源默认不导出。本地文件路径永远不会包含在导出中。",
                )}
              </Text>
            </div>
            {exportError && (
              <Text as="p" role="alert">
                {exportError}
              </Text>
            )}
          </div>
        </div>
      </Dialog>
    </main>
  )
}
