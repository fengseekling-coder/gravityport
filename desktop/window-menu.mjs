// Window bounds memory and application menu installation moved out of desktop/main.mjs (task 409). Pure moves; no behavior changes.
import { Menu, screen } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildMenuTemplate } from "./menu-template.mjs";

const MOSA_MENU_ID_PREFIX = "mosa-menu-";

// macOS/Electron may append unlabelled normal items to an application menu
// after it is installed. Keep every explicit MOSA item and remove only those
// injected normal entries, preserving separators and native role behavior.
function pruneInjectedMenuItems(menu) {
  for (const item of menu.items) {
    const submenu = item.submenu;
    if (!submenu) continue;
    const retained = submenu.items.filter((child) => (
      child.type !== "normal" || child.id?.startsWith(MOSA_MENU_ID_PREFIX)
    ));
    if (retained.length !== submenu.items.length) {
      submenu.clear();
      retained.forEach((child) => submenu.append(child));
    }
    pruneInjectedMenuItems(submenu);
  }
}

export function createWindowMenu(deps) {
  const { desktopDataDir, desktopPlatform, getMainWindow, getCurrentLocale } = deps;
  const BOUNDS_PATH = join(desktopDataDir, "window-bounds.json");
  const DEFAULT_BOUNDS = { width: 1320, height: 860 };

  function loadBounds() {
    let saved = null;
    try {
      if (existsSync(BOUNDS_PATH)) saved = JSON.parse(readFileSync(BOUNDS_PATH, "utf-8"));
    } catch {}
    if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return DEFAULT_BOUNDS;
    const normalized = {
      width: Math.max(960, Math.round(saved.width)),
      height: Math.max(640, Math.round(saved.height)),
    };
    if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return normalized;
    const candidate = { ...normalized, x: Math.round(saved.x), y: Math.round(saved.y) };
    const visible = screen.getAllDisplays().some(({ workArea }) => {
      const overlapWidth = Math.min(candidate.x + candidate.width, workArea.x + workArea.width) - Math.max(candidate.x, workArea.x);
      const overlapHeight = Math.min(candidate.y + candidate.height, workArea.y + workArea.height) - Math.max(candidate.y, workArea.y);
      return overlapWidth >= 120 && overlapHeight >= 80;
    });
    return visible ? candidate : normalized;
  }

  function saveBounds(win) {
    if (!win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) {
      try { writeFileSync(BOUNDS_PATH, JSON.stringify(win.getBounds())); } catch {}
    }
  }

  function sendToWindow(channel) {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(channel);
  }

  function buildMenu() {
    const mainWindow = getMainWindow();
    const currentLocale = getCurrentLocale();
    const menu = Menu.buildFromTemplate(buildMenuTemplate({
      platform: process.platform,
      locale: currentLocale,
      onSearch: () => sendToWindow("menu-search"),
      onSelectAll: () => sendToWindow("menu-select-all"),
    }));
    Menu.setApplicationMenu(menu);
    if (desktopPlatform.capabilities.hideApplicationMenuBar && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setMenuBarVisibility(false);
    }
    if (desktopPlatform.capabilities.pruneInjectedApplicationMenuItems) {
      pruneInjectedMenuItems(menu);
      setImmediate(() => {
        if (Menu.getApplicationMenu() === menu) pruneInjectedMenuItems(menu);
      });
    }
  }

  return { loadBounds, saveBounds, buildMenu };
}
