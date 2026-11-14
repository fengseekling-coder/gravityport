// Thumbnail media helpers moved out of App.tsx (task 395). Pure move; no behavior changes.
// Task 412 adds optional hover-motion: cards handed a motionSrc/motionKind
// play their ORIGINAL media while the pointer rests on them.
import { useEffect, useRef, useState } from "react"
import Icon from "./Icon"
import { needsImagePlaceholder } from "./original-display"

// Videos never get a generated thumbnail (the app ships no frame extractor),
// so their thumbnail_url falls back to the mp4 itself and an <img> shows a
// broken icon. Let the browser paint an early frame of the video instead.
// Task 413: the list mirrors VIDEO_EXTENSIONS in lib/library-location.mjs (the
// single source; renderer code must not import lib/) — .mkv joined it there.
const VIDEO_URL_PATTERN = /\.(?:mp4|m4v|mov|webm|mkv)(?:[?#].*)?$/i
export function isVideoUrl(url: string | null | undefined): boolean {
  return !!url && VIDEO_URL_PATTERN.test(url)
}

// Task 412: the delay keeps a quick sweep across a row of cards from loading
// every original; a pressed pointer (drag, marquee) never triggers playback.
const MOTION_HOVER_DELAY_MS = 150

export function ThumbMedia({ src, motionSrc, motionKind, ...img }: {
  src: string
  motionSrc?: string
  motionKind?: "image" | "video"
} & React.ImgHTMLAttributes<HTMLImageElement>) {
  const mediaRef = useRef<HTMLImageElement | HTMLVideoElement | null>(null)
  const hoverTimer = useRef<number | null>(null)
  const motionImage = useRef<HTMLImageElement | null>(null)
  const [hovering, setHovering] = useState(false)
  const [motionLoaded, setMotionLoaded] = useState(false)

  const stopMotion = () => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
    if (motionImage.current) {
      motionImage.current.src = ""
      motionImage.current = null
    }
    setHovering(false)
    setMotionLoaded(false)
  }

  // The listeners live on the card element (ThumbMedia's parent), so the
  // motion state is per-card and a leave anywhere on the card ends playback.
  useEffect(() => {
    if (!motionSrc || !motionKind) return
    const card = mediaRef.current?.parentElement
    if (!card) return
    const enter = (event: PointerEvent) => {
      if (event.buttons !== 0) return
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current)
      hoverTimer.current = window.setTimeout(() => {
        hoverTimer.current = null
        setHovering(true)
      }, MOTION_HOVER_DELAY_MS)
    }
    const leave = () => stopMotion()
    card.addEventListener("pointerenter", enter)
    card.addEventListener("pointerleave", leave)
    return () => {
      card.removeEventListener("pointerenter", enter)
      card.removeEventListener("pointerleave", leave)
      stopMotion()
    }
  }, [motionSrc, motionKind])

  // Animated image: preload the original, swap only once decoded, so the
  // still thumbnail keeps showing until the original can replace it without
  // a flash. A failed decode ends the hover session quietly.
  useEffect(() => {
    if (!hovering || !motionSrc || motionKind !== "image") return
    let cancelled = false
    const image = new Image()
    motionImage.current = image
    image.src = motionSrc
    image.decode().then(() => {
      if (cancelled || motionImage.current !== image) return
      setMotionLoaded(true)
    }, () => {
      if (!cancelled) stopMotion()
    })
    return () => { cancelled = true }
  }, [hovering, motionSrc, motionKind])

  // Video already shown as its own stand-in (no stored poster): hover plays
  // it, leaving pauses and rewinds to the poster frame.
  useEffect(() => {
    if (!hovering || !motionSrc || motionKind !== "video" || !isVideoUrl(src)) return
    const element = mediaRef.current
    if (!(element instanceof HTMLVideoElement)) return
    void element.play().catch(() => {})
    return () => {
      element.pause()
      element.currentTime = 0.1
    }
  }, [hovering, motionSrc, motionKind, src])

  const motionImageSrc = motionKind === "image" && hovering && motionLoaded && motionSrc ? motionSrc : null
  const motionOverlay = motionKind === "video" && hovering && motionSrc && !isVideoUrl(src)
    ? (
      // A stored poster stands in as the still cover: play the original video
      // in an overlay with the cover's box and object-fit. pointer-events off
      // keeps the card's own handlers in charge.
      <video
        src={motionSrc}
        className={img.className}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", background: "#000", pointerEvents: "none", borderRadius: "inherit" }}
        muted
        loop
        playsInline
        autoPlay
        preload="auto"
        aria-hidden="true"
        tabIndex={-1}
        draggable={false}
      />
    )
    : null

  if (isVideoUrl(src)) {
    return <video ref={mediaRef as React.RefObject<HTMLVideoElement>} className={img.className} src={src.includes("#") ? src : `${src}#t=0.1`} muted playsInline preload="metadata" tabIndex={-1} aria-hidden="true" draggable={false} />
  }

  // Undisplayable original standing in for a missing derivative (task 413):
  // the empty card's black box, never an <img> with a broken icon. No
  // hover-motion hook here — TIFF/HEIC are still images, never motionSrc.
  if (needsImagePlaceholder(src)) {
    return <div className={img.className} aria-hidden="true" />
  }

  const { srcSet, sizes, ...rest } = img
  return (
    <>
      <img
        ref={mediaRef as React.RefObject<HTMLImageElement>}
        src={motionImageSrc || src}
        srcSet={motionImageSrc ? undefined : srcSet}
        sizes={motionImageSrc ? undefined : sizes}
        {...rest}
      />
      {motionOverlay}
    </>
  )
}

export function VideoMark() {
  return <span className="video-mark"><Icon name="play" size={12} /></span>
}
