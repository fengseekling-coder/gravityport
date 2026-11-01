import { useEffect, useRef, useState } from "react"
import Icon from "./Icon"
import { translate, type Language } from "./i18n"

const CONTROLS_IDLE_MS = 2000
// Vertical breathing room around the fitted media: 16px top (the top half of
// the old flat 32px margin) and the floating zoom bar plus this gap at the
// bottom, so fit never tucks the picture under the bar.
const FIT_PAD_TOP = 16
const CONTROLS_GAP = 8

export default function ImageViewer({ width, height, src, originalSrc, isVideo, language, disabled, fullscreen, onNavigate, onToggleFullscreen, onContextMenu, onOpenLocation, message }: {
  width: number; height: number; src?: string; originalSrc?: string; isVideo?: boolean; language: Language; disabled: boolean
  fullscreen: boolean
  onNavigate: (direction: number) => void
  onToggleFullscreen: () => void
  onContextMenu: (x: number, y: number) => void
  onOpenLocation: () => void
  message: string
}) {
  const stage = useRef<HTMLDivElement>(null)
  const controlsBar = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [manualScale, setManualScale] = useState<number | null>(null)
  // Where "fit" may render, measured from the real zoom bar: `height` is the
  // usable band between FIT_PAD_TOP and the bar's top edge, `lift` shifts the
  // media's center up into that band (the media centers in the band, not the
  // stage, so the top pad stays 16px while the bottom clears the bar). Null
  // until the first measurement falls back to the old flat 32px margin.
  const [fitBox, setFitBox] = useState<{ height: number; lift: number } | null>(null)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  // normalizeAsset fills missing dimensions with 1, so a props pair ≤1 means
  // "size unknown". The media still renders (and still fires load events), and
  // the real dimensions are read from the element once it decodes, so
  // fit-scale, pan bounds and the rendered size use them. Known props
  // dimensions never touch this path.
  const [probed, setProbed] = useState<{ src: string; width: number; height: number } | null>(null)
  const propsSizeKnown = width > 1 && height > 1
  // The original replaces the preview only after it has decoded. `loadedOriginal`
  // names the originalSrc that is ready, and `previewMeasure` the preview's long
  // edge measured for `src`, so neither can leak onto a different source.
  const [loadedOriginal, setLoadedOriginal] = useState<string | null>(null)
  const [previewMeasure, setPreviewMeasure] = useState<{ src: string; edge: number } | null>(null)
  // Task 316: a missing original used to leave a bare stage. The media's own
  // error event flips this on; switching sources (new selection) clears it.
  const [mediaError, setMediaError] = useState(false)
  useEffect(() => { setMediaError(false) }, [src])
  const displaySrc = originalSrc && loadedOriginal === originalSrc ? originalSrc : src
  const previewEdge = previewMeasure && previewMeasure.src === src ? previewMeasure.edge : 0
  const probedForSrc = !propsSizeKnown && probed && probed.src === displaySrc ? probed : null
  const usedWidth = propsSizeKnown ? width : (probedForSrc?.width || width)
  const usedHeight = propsSizeKnown ? height : (probedForSrc?.height || height)
  const probeSize = (element: HTMLImageElement | HTMLVideoElement) => {
    if (propsSizeKnown || !displaySrc) return
    const measuredWidth = element instanceof HTMLVideoElement ? element.videoWidth : element.naturalWidth
    const measuredHeight = element instanceof HTMLVideoElement ? element.videoHeight : element.naturalHeight
    if (measuredWidth > 0 && measuredHeight > 0) setProbed({ src: displaySrc, width: measuredWidth, height: measuredHeight })
  }
  const onImageLoad = (element: HTMLImageElement) => {
    if (src && displaySrc === src) setPreviewMeasure({ src, edge: Math.max(element.naturalWidth, element.naturalHeight) })
    probeSize(element)
  }
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
  const fitHeight = fitBox ? fitBox.height : size.height - FIT_PAD_TOP * 2
  const fitScale = Math.max(.01, Math.min((size.width - 48) / usedWidth, fitHeight / usedHeight, 1))
  const scale = manualScale ?? fitScale
  // Swap to the original only while the preview is on screen, when the original
  // is bigger than the preview and this view needs more device pixels than the
  // preview holds. Fit mode and manual zoom share the same rule.
  const originalEdge = Math.max(usedWidth, usedHeight)
  const needsOriginal = !isVideo && !!originalSrc && originalSrc !== src && displaySrc === src && previewEdge > 0
    && originalEdge > previewEdge && originalEdge * scale * window.devicePixelRatio > previewEdge * 1.05
  // Manual zoom recenters on the stage again — once the picture is bigger than
  // (or freed from) the fit band, panning math owns the placement and the bar
  // is allowed to sit on top of it.
  const fitLift = manualScale === null ? fitBox?.lift ?? 0 : 0
  const clampPan = (x: number, y: number, zoom = scale) => {
    const maxX = Math.max(0, (usedWidth * zoom - size.width) / 2)
    const maxY = Math.max(0, (usedHeight * zoom - size.height) / 2)
    return { x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) }
  }
  const renderedPan = clampPan(pan.x, pan.y)
  // fitLift is a signed y-offset (negative = up): add it after the -50%
  // centering so fit mode rests 16px from the top and reserve from the bottom.
  const mediaTransform = `translate(-50%, calc(-50% + ${fitLift}px)) translate(${renderedPan.x}px, ${renderedPan.y}px)`
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
    const stageElement = stage.current
    const controlsElement = controlsBar.current
    if (!stageElement || !controlsElement) return
    const measure = () => {
      const stageRect = stageElement.getBoundingClientRect()
      const controlsRect = controlsElement.getBoundingClientRect()
      const bottomEdge = controlsRect.top - stageRect.top - CONTROLS_GAP
      if (!(bottomEdge > 0)) return
      setFitBox({ height: bottomEdge - FIT_PAD_TOP, lift: (FIT_PAD_TOP - (stageRect.height - bottomEdge)) / 2 })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stageElement)
    observer.observe(controlsElement)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    // This Chromium build still renders the media controls' fullscreen button
    // despite controlsList="nofullscreen". The app's own 全屏 is CSS-only, so
    // an OS fullscreen reached from those controls is always wrong — leave it.
    const exitForeignFullscreen = () => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    }
    document.addEventListener("fullscreenchange", exitForeignFullscreen)
    return () => document.removeEventListener("fullscreenchange", exitForeignFullscreen)
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
  // The original is requested at most once per asset, even if its decode fails.
  // Manual zoom loads at once; fit waits 200ms so a run of arrow-key flips does
  // not pull every original on the way. Once the request has started, input
  // changes cancel nothing: the decode must still land (unmount clears it).
  const originalRequested = useRef<string | null>(null)
  const originalLoader = useRef<HTMLImageElement | null>(null)
  useEffect(() => {
    if (!needsOriginal || !originalSrc || originalRequested.current === originalSrc) return
    const load = (url: string) => {
      const image = new Image()
      originalRequested.current = url
      originalLoader.current = image
      image.src = url
      image.decode().then(() => {
        if (originalLoader.current === image) setLoadedOriginal(url)
      }, () => {})
    }
    if (manualScale !== null) {
      load(originalSrc)
      return
    }
    const timer = window.setTimeout(() => load(originalSrc), 200)
    return () => window.clearTimeout(timer)
  }, [needsOriginal, manualScale, scale, originalSrc])
  useEffect(() => () => {
    if (originalLoader.current) originalLoader.current.src = ""
    originalLoader.current = null
  }, [])
  const pannable = usedWidth * scale > size.width || usedHeight * scale > size.height
  return <div className="image-viewer" onPointerMove={revealControls}>
    <div ref={stage} className={`viewer-stage ${pannable ? "pannable" : ""} ${dragging ? "dragging" : ""}`} aria-label={tr("图片预览")}
      onDoubleClick={event => {
        // Native video controls own their surface: a double-click there must
        // not toggle fit/1:1 (and Chromium's controls add no fullscreen of
        // their own — asserted in the viewer-video-controls e2e).
        if (event.target instanceof HTMLVideoElement) return
        manualScale === null ? zoomTo(1) : fit()
      }}
      onContextMenu={event => { event.preventDefault(); onContextMenu(event.clientX, event.clientY) }}
      onPointerDown={event => {
        // Pressing on the video would setPointerCapture on the stage and steal
        // every later pointer event from the native controls (scrubber, volume).
        if (event.target instanceof HTMLVideoElement) return
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
      {src && mediaError
        ? <div className="viewer-missing" role="status">
          <Icon name="image" size={32} />
          <p>{tr("原图找不到了")}</p>
          <button onClick={onOpenLocation}>{tr("打开素材位置")}</button>
        </div>
        : src && isVideo
          ? <video className="viewer-image" src={src} controls autoPlay loop controlsList="nofullscreen nodownload noremoteplayback" disablePictureInPicture onLoadedMetadata={event => probeSize(event.currentTarget)} onError={() => setMediaError(true)} style={{ width: usedWidth * scale, height: usedHeight * scale, transform: mediaTransform }} />
          : src
            ? <img className="viewer-image" src={displaySrc} alt="" draggable={false} onLoad={event => onImageLoad(event.currentTarget)} onError={() => setMediaError(true)} style={{ width: usedWidth * scale, height: usedHeight * scale, transform: mediaTransform, objectFit: "contain" }} />
            : <div className="viewer-image" style={{ width: usedWidth * scale, height: usedHeight * scale, transform: mediaTransform }} />}
    </div>
    <button className="viewer-nav viewer-previous" aria-label={tr("上一个素材")} onClick={() => onNavigate(-1)}><Icon name="left" size={24} /></button>
    <button className="viewer-nav viewer-next" aria-label={tr("下一个素材")} onClick={() => onNavigate(1)}><Icon name="right" size={24} /></button>
    <div ref={controlsBar} className={`viewer-controls ${controlsIdle ? "is-idle" : ""}`} role="group" aria-label={tr("缩放控制")}
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
