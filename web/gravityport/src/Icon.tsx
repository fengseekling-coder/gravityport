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
  book: <><path d="M4 6.5A1.5 1.5 0 0 1 5.5 5H10a2.5 2.5 0 0 1 2 1 2.5 2.5 0 0 1 2-1h4.5A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5H14a2.5 2.5 0 0 0-2 1 2.5 2.5 0 0 0-2-1H5.5A1.5 1.5 0 0 1 4 17.5Z" /><path d="M12 6v14" /></>,
  layers: <><path d="m12 4 8 4-8 4-8-4ZM4 12l8 4 8-4M4 16l8 4 8-4" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M15.5 5.5v-1A1.5 1.5 0 0 0 14 3H4.5A1.5 1.5 0 0 0 3 4.5V14a1.5 1.5 0 0 0 1.5 1.5h1" /></>,
  scissors: <><circle cx="6.5" cy="7" r="2.5" /><circle cx="6.5" cy="17" r="2.5" /><path d="m8.5 8.5 11 11M8.5 15.5l11-11" /></>,
  link: <><path d="m9 8 2-2a4.2 4.2 0 0 1 6 6l-2 2M15 16l-2 2a4.2 4.2 0 0 1-6-6l2-2M9 15l6-6" /></>,
  image: <><rect x="4" y="4" width="16" height="16" rx="2" /><circle cx="9" cy="9" r="1.5" /><path d="m4 17 5-5 4 4 3-3 4 4" /></>,
  external: <><path d="M14 4h6v6M20 4l-9 9M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></>,
  play: <path d="M8.5 5.8v12.4a.8.8 0 0 0 1.2.7l9.6-6.2a.8.8 0 0 0 0-1.4L9.7 5.1a.8.8 0 0 0-1.2.7Z" />,
  expand: <path d="M9 4H4v5M15 4h5v5M4 15v5h5M20 15v5h-5" />,
  // Task 177: viewer fullscreen — corners stretch outward to enter, inward to exit.
  fullscreen: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  "fullscreen-exit": <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />,
  inspector: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M14 4v16" /></>,
  sun: <><circle cx="12" cy="12" r="3.5" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.5 5.5 7 7M17 17l1.5 1.5M5.5 18.5 7 17M17 7l1.5-1.5" /></>,
  globe: <><circle cx="12" cy="12" r="8" /><ellipse cx="12" cy="12" rx="3.5" ry="8" /><path d="M4 12h16" /></>,
  info: <><circle cx="12" cy="12" r="8" /><path d="M12 11v5M12 8h.01" /></>,
  message: <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v6a2.5 2.5 0 0 1-2.5 2.5H12l-4.5 3.5v-3.5h-1A2.5 2.5 0 0 1 4 13.5Z" />,
  user: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20v-1a7 7 0 0 1 14 0v1" /></>,
  check: <path d="m5 12 4.5 4.5L19 7" />,
  enter: <path d="M19 5v8H5m5-5-5 5 5 5" />,
  backspace: <><path d="M9 5h10a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6-7Z" /><path d="m11 9 6 6M11 15l6-6" /></>,
  tree: <><rect x="3" y="8" width="5" height="7" rx="1.3" /><rect x="16" y="3" width="5" height="7" rx="1.3" /><rect x="16" y="15" width="5" height="7" rx="1.3" /><path d="M8 11.5h4a2 2 0 0 0 2-2v-1a2 2 0 0 1 2-2M8 11.5h4a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2" /></>,
  branch: <><circle cx="5" cy="5" r="2" /><circle cx="19" cy="5" r="2" /><circle cx="5" cy="19" r="2" /><path d="M5 7v10M7 17c8 0 12-2 12-10" /></>,
  list: <><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" /></>,
  compare: <><rect x="3" y="5" width="7" height="14" rx="1.5" /><rect x="14" y="5" width="7" height="14" rx="1.5" /><path d="M12 3v18" /></>,
  layout: <><rect x="3" y="4" width="7" height="6" rx="1.3" /><rect x="14" y="4" width="7" height="6" rx="1.3" /><rect x="3" y="14" width="7" height="6" rx="1.3" /><rect x="14" y="14" width="7" height="6" rx="1.3" /></>,
  export: <><path d="M12 15V3m-4 4 4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" /></>,
  flag: <><path d="M5 21V4m0 1c5-4 9 4 14 0v10c-5 4-9-4-14 0" /></>,
  cursor: <path d="m5 3 14 10-7 1-3 7Z" />,
  hand: <path d="M8 12V6a1.5 1.5 0 0 1 3 0v5-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v6-3a1.5 1.5 0 0 1 3 0v5c0 5-3 7-7 7-3 0-5-2-6-4l-3-5a1.5 1.5 0 0 1 2.5-1.5L8 13" />,
  annotate: <><path d="m14 5 5 5M4 20l5-1 12-12a2 2 0 0 0-5-5L4 14Z" /><path d="m4 14 5 5" /></>,
  undo: <path d="M8 5 3 10l5 5M3 10h10a7 7 0 0 1 7 7" />,
  document: <><path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10Z" /><path d="M13 3v7h7M8 14h8M8 17h5" /></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
  local: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 14h18M16 16.5h.01M18 16.5h.01" /></>,
  chatgpt: <><path d="M12 3a5 5 0 0 1 5 3 5 5 0 0 1 4 7 5 5 0 0 1-5 7 5 5 0 0 1-8 0 5 5 0 0 1-5-7 5 5 0 0 1 4-7 5 5 0 0 1 5-3Z" /><path d="m8 8 4-2 4 2v5l-4 3-4-2V8Zm0 0 8 5M12 6v10M8 14l8-6" /></>,
  // 任务 458：AI 设置页的 sparkle（设置左栏「AI」）。四角星，笔画同其他图标。
  sparkle: <path d="M12 4c.7 3.9 3.4 6.6 7.3 7.3-3.9.7-6.6 3.4-7.3 7.3-.7-3.9-3.4-6.6-7.3-7.3 3.9-.7 6.6-3.4 7.3-7.3Z" />,
}

export default function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const scale = size <= 12 ? 12 : size <= 20 ? 16 : size <= 28 ? 24 : 32
  return <svg className={`ui-icon ui-icon--${scale}`} width={scale} height={scale} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{glyphs[name] || glyphs.grid}</svg>
}
