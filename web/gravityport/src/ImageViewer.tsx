import { useEffect, useRef, useState } from "react"
import Icon from "./Icon"
import { translate, type Language } from "./i18n"

const CONTROLS_IDLE_MS = 2000

export default function ImageViewer({ width, height, src, isVideo, language, disabled, fullscreen, onNavigate, onToggleFullscreen, onContextMenu, message }: {
  width: number; height: number; src?: string; isVideo?: boolean; language: Language; disabled: boolean
  fullscreen: boolean
  onNavigate: (direction: number) => void
  onToggleFullscreen: () => void
  onContextMenu: (x: number, y: number) => void
  message: string
}) {
  const stage = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [manualScale, setManualScale] = useState<number | null>(null)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  // The zoom bar floats over the picture and fades out after the pointer rests
  // for CONTROLS_IDLE_MS; any pointer movement, wheel zoom or zoom key brings
  // it back. It never fades while the pointer is on it or it holds focus.
  const [controlsIdle, setControlsIdle] = useState(false)
  const idleTimer = useRef<number | null>(null)
  const pointerOnControls = useRef(false)
  const revealControls = () => {
    setControlsIdle(false)
    if (idleTimer.current !== null) window.clearTimeout(idleTimer.current)
    idleTimer.current = window.setTimeout(() => {
      if (!pointerOnControls.current) setControlsIdle(true)
    }, CONTROLS_IDLE_MS)
  }
  useEffect(() => {
    revealControls()
    return () => { if (idleTimer.current !== null) window.clearTimeout(idleTimer.current) }
  }, [])
  const tr = (text: string) => translate(text, language)
  const fitScale = Math.max(.01, Math.min((size.width - 48) / width, (size.height - 32) / height, 1))
  const scale = manualScale ?? fitScale
  const clampPan = (x: number, y: number, zoom = scale) => {
    const maxX = Math.max(0, (width * zoom - size.width) / 2)
    const maxY = Math.max(0, (height * zoom - size.height) / 2)
    return { x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) }
  }
  const renderedPan = clampPan(pan.x, pan.y)
  const fit = () => { setManualScale(null); setPan({ x: 0, y: 0 }) }
  const zoomTo = (next: number, point = { x: 0, y: 0 }) => {
    const zoom = Math.min(4, Math.max(.05, next))
    setPan(clampPan(point.x - (point.x - renderedPan.x) * zoom / scale, point.y - (point.y - renderedPan.y) * zoom / scale, zoom))
    setManualScale(zoom)
  }
  useEffect(() => {
    if (!stage.current) return
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      setSize({ width, height })
    })
    observer.observe(stage.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const element = stage.current
    if (!element || disabled) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1)
      zoomTo(scale * Math.exp(-delta * .002), { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 })
      revealControls()
    }
    element.addEventListener("wheel", wheel, { passive: false })
    return () => element.removeEventListener("wheel", wheel)
  }, [scale, pan, size, disabled])
  useEffect(() => {
    if (disabled) return
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && (event.target.isContentEditable || event.target.closest("input, textarea, select"))) return
      if (event.key === "ArrowLeft") onNavigate(-1)
      else if (event.key === "ArrowRight") onNavigate(1)
      else if (event.key === "+" || event.key === "=") zoomTo(scale * 1.25)
      else if (event.key === "-") zoomTo(scale / 1.25)
      else if (event.key === "0") fit()
      else if (event.key === "1") zoomTo(1)
      else return
      event.preventDefault()
      revealControls()
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [scale, pan, size, disabled, onNavigate])
  const pannable = width * scale > size.width || height * scale > size.height
  return <div className="image-viewer" onPointerMove={revealControls}>
    <div ref={stage} className={`viewer-stage ${pannable ? "pannable" : ""} ${dragging ? "dragging" : ""}`} aria-label={tr("图片预览")} onDoubleClick={() => manualScale === null ? zoomTo(1) : fit()}
      onContextMenu={event => { event.preventDefault(); onContextMenu(event.clientX, event.clientY) }}
      onPointerDown={event => {
        if (!pannable || event.button !== 0 || disabled) return
        stage.current?.setPointerCapture(event.pointerId)
        drag.current = { x: event.clientX, y: event.clientY, panX: renderedPan.x, panY: renderedPan.y }
        setDragging(true)
      }}
      onPointerMove={event => {
        if (!drag.current) return
        setPan(clampPan(drag.current.panX + event.clientX - drag.current.x, drag.current.panY + event.clientY - drag.current.y))
      }}
      onPointerUp={() => { drag.current = null; setDragging(false) }}
      onPointerCancel={() => { drag.current = null; setDragging(false) }}
      onLostPointerCapture={() => { drag.current = null; setDragging(false) }}>
      {src && isVideo
        ? <video className="viewer-image" src={src} controls autoPlay loop style={{ width: width * scale, height: height * scale, transform: `translate(-50%, -50%) translate(${renderedPan.x}px, ${renderedPan.y}px)` }} />
        : src
          ? <img className="viewer-image" src={src} alt="" draggable={false} style={{ width: width * scale, height: height * scale, transform: `translate(-50%, -50%) translate(${renderedPan.x}px, ${renderedPan.y}px)`, objectFit: "contain" }} />
          : <div className="viewer-image" style={{ width: width * scale, height: height * scale, transform: `translate(-50%, -50%) translate(${renderedPan.x}px, ${renderedPan.y}px)` }} />}
    </div>
    <button className="viewer-nav viewer-previous" aria-label={tr("上一个素材")} onClick={() => onNavigate(-1)}><Icon name="left" size={24} /></button>
    <button className="viewer-nav viewer-next" aria-label={tr("下一个素材")} onClick={() => onNavigate(1)}><Icon name="right" size={24} /></button>
    <div className={`viewer-controls ${controlsIdle ? "is-idle" : ""}`} role="group" aria-label={tr("缩放控制")}
      onPointerEnter={() => { pointerOnControls.current = true; setControlsIdle(false) }}
      onPointerLeave={() => { pointerOnControls.current = false; revealControls() }}>
      <button aria-label={tr("缩小")} title={tr("缩小")} disabled={scale <= .05} onClick={() => zoomTo(scale / 1.25)}><Icon name="minus" size={16} /></button>
      <output aria-live="polite">{Math.round(scale * 100)}%</output>
      <button aria-label={tr("放大")} title={tr("放大")} disabled={scale >= 4} onClick={() => zoomTo(scale * 1.25)}><Icon name="plus" size={16} /></button>
      <span className="viewer-divider" />
      <button className={manualScale === null ? "active" : ""} aria-pressed={manualScale === null} onClick={fit} title={tr("适合窗口")}><Icon name="expand" size={16} /><span>{tr("适合窗口")}</span></button>
      <button className={manualScale === 1 ? "active" : ""} aria-pressed={manualScale === 1} title={tr("原始尺寸")} onClick={() => zoomTo(1)}>1:1</button>
      <span className="viewer-divider" />
      <button aria-pressed={fullscreen} title={tr(fullscreen ? "退出全屏" : "全屏")} onClick={onToggleFullscreen}>
        <Icon name={fullscreen ? "fullscreen-exit" : "fullscreen"} size={16} />
        <span>{tr(fullscreen ? "退出全屏" : "全屏")}</span>
      </button>
    </div>
    {message && <div className="viewer-event" role="status" aria-live="polite"><Icon name="info" size={16} /><span>{message}</span></div>}
  </div>
}
