// Thumbnail media helpers moved out of App.tsx (task 395). Pure move; no behavior changes.
import Icon from "./Icon"

// Videos never get a generated thumbnail (the app ships no frame extractor),
// so their thumbnail_url falls back to the mp4 itself and an <img> shows a
// broken icon. Let the browser paint an early frame of the video instead.
const VIDEO_URL_PATTERN = /\.(?:mp4|mov|webm|m4v)(?:[?#].*)?$/i
export function isVideoUrl(url: string | null | undefined): boolean {
  return !!url && VIDEO_URL_PATTERN.test(url)
}

export function ThumbMedia({ src, ...img }: { src: string } & React.ImgHTMLAttributes<HTMLImageElement>) {
  if (isVideoUrl(src)) {
    return <video className={img.className} src={src.includes("#") ? src : `${src}#t=0.1`} muted playsInline preload="metadata" tabIndex={-1} aria-hidden="true" draggable={false} />
  }
  return <img src={src} {...img} />
}

export function VideoMark() {
  return <span className="video-mark"><Icon name="play" size={12} /></span>
}
