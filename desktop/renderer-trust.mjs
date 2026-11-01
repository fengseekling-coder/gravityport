// Task 311: every IPC handler must trust only the verified local service
// origin on the main window's main frame. A compromised iframe, a cross-origin
// document, or any page the window was lured into loading must not reach the
// clipboard, drag-out, external-link, or update bridges.
//
// Pure predicate so test/service-identity.test.mjs can exercise sub-frame,
// foreign-origin, and startup-shell shapes without launching Electron.
//
// The startup shell (desktop/startup.html) renders before the service exists;
// the task-311 audit found it contains no scripts and calls no IPC at all, so
// it holds no allowance here — any future shell-side call needs an explicit,
// named exception first.

/**
 * @param event Electron IPC event (real or test double).
 * @param context {{ windowRef: object, serviceOrigin: string }}
 *   windowRef: the BrowserWindow (or a test double with webContents).
 *   serviceOrigin: origin of the service verified this launch, "" when none.
 */
export function isTrustedRendererEvent(event, context = {}) {
  const { windowRef, serviceOrigin } = context;
  if (!windowRef || (typeof windowRef.isDestroyed === "function" && windowRef.isDestroyed())) return false;
  if (!event || event.sender !== windowRef.webContents) return false;
  // Main frame only: invoke() from a sub-frame (or a disposed frame, which
  // reports a null senderFrame) is refused.
  if (event.senderFrame !== windowRef.webContents.mainFrame) return false;
  if (!serviceOrigin) return false;
  try {
    const currentUrl = new URL(String(windowRef.webContents.getURL() || ""));
    return currentUrl.origin === serviceOrigin;
  } catch {
    return false;
  }
}
