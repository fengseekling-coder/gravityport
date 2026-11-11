/**
 * Application menu template, extracted from desktop/main.mjs so tests can
 * build it per platform without importing Electron (main.mjs runs the whole
 * app on import). Pure data in, pure data out: no Electron types here.
 *
 * The first app-menu label is the literal product name. On Windows, pressing
 * Alt otherwise reveals Electron's `app.name` ("mosa"), the old internal
 * package name. On macOS the system draws the app-menu title from the bundle
 * Info.plist, so this label is cosmetic there and the visible menu is
 * unchanged.
 *
 * macOS keeps the native services/hide items; other platforms drop them (they
 * are Mac-only roles) and keep only About and Quit around a single separator.
 * The search item's click callback is injected by main.mjs (it forwards into
 * the focused window), keeping this module free of Electron imports. 全选 is
 * wired the same way (task 384): without a `role` the ⌘A accelerator cannot
 * outrun the web page's own keydown, so the two paths stay consistent.
 */

import { getDesktopText } from "./notification-i18n.mjs";

export const GRAVITYPORT_APP_MENU_LABEL = "GravityPort";

export function buildMenuTemplate({ platform, locale, onSearch, onSelectAll }) {
  const isMac = platform === "darwin";
  const appSubmenu = [
    { id: "mosa-menu-about", role: "about", label: getDesktopText("menuAbout", locale) },
  ];
  if (isMac) {
    appSubmenu.push(
      { id: "mosa-menu-app-separator-1", type: "separator" },
      { id: "mosa-menu-services", role: "services", label: getDesktopText("menuServices", locale) },
      { id: "mosa-menu-app-separator-2", type: "separator" },
      { id: "mosa-menu-hide", role: "hide", label: getDesktopText("menuHide", locale) },
      { id: "mosa-menu-hide-others", role: "hideOthers", label: getDesktopText("menuHideOthers", locale) },
      { id: "mosa-menu-show-all", role: "unhide", label: getDesktopText("menuShowAll", locale) },
      { id: "mosa-menu-app-separator-3", type: "separator" },
    );
  } else {
    appSubmenu.push(
      { id: "mosa-menu-app-separator-1", type: "separator" },
    );
  }
  appSubmenu.push(
    { id: "mosa-menu-quit", role: "quit", label: getDesktopText("menuQuit", locale) },
  );

  return [
    {
      id: "mosa-menu-app",
      label: GRAVITYPORT_APP_MENU_LABEL,
      submenu: appSubmenu,
    },
    {
      id: "mosa-menu-file",
      label: getDesktopText("menuFile", locale),
      submenu: [
        { id: "mosa-menu-close", role: "close", label: getDesktopText("menuClose", locale) },
      ],
    },
    {
      id: "mosa-menu-edit",
      label: getDesktopText("menuEdit", locale),
      submenu: [
        { id: "mosa-menu-undo", role: "undo", label: getDesktopText("menuUndo", locale) },
        { id: "mosa-menu-redo", role: "redo", label: getDesktopText("menuRedo", locale) },
        { id: "mosa-menu-edit-separator-1", type: "separator" },
        { id: "mosa-menu-cut", role: "cut", label: getDesktopText("menuCut", locale) },
        { id: "mosa-menu-copy", role: "copy", label: getDesktopText("menuCopy", locale) },
        { id: "mosa-menu-paste", role: "paste", label: getDesktopText("menuPaste", locale) },
        { id: "mosa-menu-paste-match-style", role: "pasteAndMatchStyle", label: getDesktopText("menuPasteAndMatchStyle", locale) },
        { id: "mosa-menu-delete", role: "delete", label: getDesktopText("menuDelete", locale) },
        {
          id: "mosa-menu-select-all",
          label: getDesktopText("menuSelectAll", locale),
          accelerator: "CmdOrCtrl+A",
          click: onSelectAll,
        },
      ],
    },
    {
      id: "mosa-menu-view",
      label: getDesktopText("menuView", locale),
      submenu: [
        {
          id: "mosa-menu-search",
          label: getDesktopText("menuSearch", locale),
          accelerator: "CmdOrCtrl+F",
          click: onSearch,
        },
        { id: "mosa-menu-view-separator-1", type: "separator" },
        { id: "mosa-menu-reset-zoom", role: "resetZoom", label: getDesktopText("menuResetZoom", locale) },
        { id: "mosa-menu-zoom-in", role: "zoomIn", label: getDesktopText("menuZoomIn", locale) },
        { id: "mosa-menu-zoom-out", role: "zoomOut", label: getDesktopText("menuZoomOut", locale) },
        { id: "mosa-menu-view-separator-2", type: "separator" },
        { id: "mosa-menu-toggle-fullscreen", role: "togglefullscreen", label: getDesktopText("menuToggleFullScreen", locale) },
      ],
    },
    {
      id: "mosa-menu-window",
      label: getDesktopText("menuWindow", locale),
      submenu: [
        { id: "mosa-menu-minimize", role: "minimize", label: getDesktopText("menuMinimize", locale) },
        { id: "mosa-menu-window-zoom", role: "zoom", label: getDesktopText("menuZoom", locale) },
        { id: "mosa-menu-window-separator-1", type: "separator" },
        { id: "mosa-menu-bring-all-to-front", role: "front", label: getDesktopText("menuBringAllToFront", locale) },
      ],
    },
  ];
}
