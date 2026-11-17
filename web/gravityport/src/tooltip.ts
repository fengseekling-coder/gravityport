// UI 审查 11-16：App 自己的悬停提示，替换浏览器自带的 title 提示。
//
// 图标按钮只剩图标后，悬停提示是唯一能看出按钮作用的地方；自带提示在
// 内嵌浏览器里不显示，在 Electron 里要停一秒多、样子是系统默认的。这里
// 对全 App 带 title 的元素统一处理：停 400ms 在元素下方出一个小标签，
// 贴到窗口底边就翻到上方。
//
// title 只在悬停期间暂时拿下（不然自带提示会叠出第二个），移开、按下、
// 按键、滚动、窗口失焦时放回去——读屏和按 title 找元素的测试都不受影响。

import "./tooltip.css"

const SHOW_DELAY_MS = 400
const GAP_PX = 6
const EDGE_PX = 8

let installed = false

export function installTooltips(): void {
  if (installed || typeof document === "undefined") return
  installed = true

  const tip = document.createElement("div")
  tip.className = "app-tooltip"
  tip.setAttribute("role", "tooltip")
  tip.hidden = true

  let current: HTMLElement | null = null
  let stored: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const restore = () => {
    if (current && stored !== null && !current.hasAttribute("title")) current.setAttribute("title", stored)
  }

  const hide = () => {
    if (timer) clearTimeout(timer)
    timer = null
    tip.hidden = true
    restore()
    current = null
    stored = null
  }

  const show = (target: HTMLElement, text: string) => {
    if (!target.isConnected) return hide()
    // An open <dialog> sits in the top layer, above any z-index; the tip has
    // to live inside it to be seen over the dialog. Otherwise it lives in .app,
    // where the dark-theme colour tokens are defined.
    const host = target.closest("dialog[open]") || target.closest(".app") || document.body
    if (tip.parentElement !== host) host.appendChild(tip)
    tip.textContent = text
    tip.hidden = false
    const rect = target.getBoundingClientRect()
    const { width, height } = tip.getBoundingClientRect()
    const left = Math.min(
      Math.max(EDGE_PX, rect.left + rect.width / 2 - width / 2),
      window.innerWidth - width - EDGE_PX,
    )
    let top = rect.bottom + GAP_PX
    if (top + height > window.innerHeight - EDGE_PX) top = rect.top - height - GAP_PX
    tip.style.left = `${Math.round(left)}px`
    tip.style.top = `${Math.round(Math.max(EDGE_PX, top))}px`
  }

  document.addEventListener("pointerover", (event) => {
    if (event.pointerType === "touch") return
    const node = event.target as Element | null
    if (!node || typeof node.closest !== "function") return
    if (current && current.contains(node)) return
    const target = node.closest<HTMLElement>("[title]")
    if (!target) return
    hide()
    const text = target.getAttribute("title") || ""
    if (!text.trim()) return
    current = target
    stored = text
    target.removeAttribute("title")
    timer = setTimeout(() => show(target, text), SHOW_DELAY_MS)
  }, true)

  document.addEventListener("pointerout", (event) => {
    if (!current) return
    const next = event.relatedTarget as Node | null
    if (next && current.contains(next)) return
    hide()
  }, true)

  for (const type of ["pointerdown", "keydown", "wheel"] as const) {
    document.addEventListener(type, hide, true)
  }
  document.addEventListener("scroll", hide, true)
  window.addEventListener("blur", hide)
}
