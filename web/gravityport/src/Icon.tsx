import type { ReactNode } from "react"

// Shared 24-unit canvas, 1.6-unit strokes, rounded terminals, and optical padding.
const glyphs: Record<string, ReactNode> = {
  grid: <><rect x="4" y="4" width="6" height="6" rx="1.5" /><rect x="14" y="4" width="6" height="6" rx="1.5" /><rect x="4" y="14" width="6" height="6" rx="1.5" /><rect x="14" y="14" width="6" height="6" rx="1.5" /></>,
  heart: <path d="M12 20 4.8 13a4.7 4.7 0 0 1 6.6-6.7l.6.6.6-.6a4.7 4.7 0 0 1 6.6 6.7Z" />,
  trash: <><path d="M4.5 7h15M9 7V4.5h6V7M7 7l.7 12a1.5 1.5 0 0 0 1.5 1.5h5.6a1.5 1.5 0 0 0 1.5-1.5L17 7M10 10.5v6M14 10.5v6" /></>,
  left: <path d="m14.5 5.5-6.5 6.5 6.5 6.5" />,
  right: <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />,
  down: <path d="m5.5 9 6.5 6.5L18.5 9" />,
  "to-top": <path d="M6 5h12M12 9v10M7.5 13.5 12 9l4.5 4.5" />,
  close: <path d="m6.5 6.5 11 11M6.5 17.5l11-11" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  search: <><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 4.5 4.5" /></>,
  settings: <><path d="m9.5 4-.5 2-2 .9-1.9-.5-2 3.4 1.4 1.5v2.4l-1.4 1.5 2 3.4 1.9-.5 2 .9.5 2h4l.5-2 2-.9 1.9.5 2-3.4-1.4-1.5v-2.4l1.4-1.5-2-3.4-1.9.5-2-.9-.5-2Z" /><circle cx="11.5" cy="12" r="3" /></>,
  folder: <path d="M4 7V5.5A1.5 1.5 0 0 1 5.5 4H10l2.5 3h6A1.5 1.5 0 0 1 20 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5Z" />,
  inbox: <><path d="m4 13 2.5-8h11l2.5 8v5.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5V13Z" /><path d="M4 13h5l1.5 3h3l1.5-3h5" /></>,
  bookmark: <path d="M6 5.5A1.5 1.5 0 0 1 7.5 4h9A1.5 1.5 0 0 1 18 5.5V20l-6-4-6 4Z" />,
  layers: <><path d="m12 4 8 4-8 4-8-4ZM4 12l8 4 8-4M4 16l8 4 8-4" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M15.5 5.5v-1A1.5 1.5 0 0 0 14 3H4.5A1.5 1.5 0 0 0 3 4.5V14a1.5 1.5 0 0 0 1.5 1.5h1" /></>,
  scissors: <><circle cx="6.5" cy="7" r="2.5" /><circle cx="6.5" cy="17" r="2.5" /><path d="m8.5 8.5 11 11M8.5 15.5l11-11" /></>,
  link: <><path d="m9 8 2-2a4.2 4.2 0 0 1 6 6l-2 2M15 16l-2 2a4.2 4.2 0 0 1-6-6l2-2M9 15l6-6" /></>,
  image: <><rect x="4" y="4" width="16" height="16" rx="2" /><circle cx="9" cy="9" r="1.5" /><path d="m4 17 5-5 4 4 3-3 4 4" /></>,
  external: <><path d="M14 4h6v6M20 4l-9 9M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></>,
  expand: <path d="M9 4H4v5M15 4h5v5M4 15v5h5M20 15v5h-5" />,
  inspector: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M14 4v16" /></>,
  sun: <><circle cx="12" cy="12" r="3.5" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.5 5.5 7 7M17 17l1.5 1.5M5.5 18.5 7 17M17 7l1.5-1.5" /></>,
  globe: <><circle cx="12" cy="12" r="8" /><ellipse cx="12" cy="12" rx="3.5" ry="8" /><path d="M4 12h16" /></>,
  info: <><circle cx="12" cy="12" r="8" /><path d="M12 11v5M12 8h.01" /></>,
  user: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20v-1a7 7 0 0 1 14 0v1" /></>,
  check: <path d="m5 12 4.5 4.5L19 7" />,
  enter: <path d="M19 5v8H5m5-5-5 5 5 5" />,
  backspace: <><path d="M9 5h10a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6-7Z" /><path d="m11 9 6 6M11 15l6-6" /></>,
}

export default function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const scale = size <= 12 ? 12 : size <= 20 ? 16 : size <= 28 ? 24 : 32
  return <svg className={`ui-icon ui-icon--${scale}`} width={scale} height={scale} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{glyphs[name] || glyphs.grid}</svg>
}
