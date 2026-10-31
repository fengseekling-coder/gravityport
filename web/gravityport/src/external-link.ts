/**
 * 审查 3-6 甲（任务 318）:settings-card links must actually open in the
 * desktop app. The window's setWindowOpenHandler denies every new window, so
 * a plain <a target="_blank"> silently does nothing in Electron; in a plain
 * browser the same anchor has to keep working. Clicking calls the controlled
 * open-external-link channel (destination policy + confirm dialog live in the
 * main process); keyboard activation and the context-menu「复制链接」still use
 * the untouched href.
 */
import { desktopAPI } from "./desktop.js"

export function handleExternalLinkClick(event: { preventDefault(): void }, url: string): void {
  const api = desktopAPI()
  const openExternalLink = api?.openExternalLink
  if (typeof openExternalLink === "function") {
    event.preventDefault()
    void openExternalLink.call(api, url)
  }
}
