// Clipboard and native file-drag IPC handlers moved out of desktop/main.mjs registerIPC (task 396). Pure moves; no behavior changes.

export function registerClipboardIpc(deps) {
  const {
    ipcMain,
    trustedRendererEvent,
    clipboard,
    nativeImage,
    existsSync,
    statSync,
    writeStagedPng,
    importStagingRoot,
    clipboardImportable,
    clipboardImageTarget,
    writeClipboardFiles,
    resolveAllowedFolderPath,
    screenGuard,
    MAX_CLIPBOARD_TEXT_LENGTH,
    MAX_NATIVE_DRAG_FILES,
    NATIVE_DRAG_FALLBACK_ICON,
    nativeDragIcon,
    getLibraryDir,
  } = deps;
  ipcMain.handle("paste-image", async (event) => {
    if (!trustedRendererEvent(event)) return null;
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    try {
      // BUG-01 fix: pastes now land inside the trusted import staging root
      // instead of an untrusted userData/pastes directory.
      return await writeStagedPng(importStagingRoot, image.toPNG());
    } catch (error) {
      console.error(`[MOSA] import-staging paste failed: ${error?.message || error}`);
      throw new Error(`import-staging paste failed (${error?.code || "unknown"})`);
    }
  });

  // Task 239: blank-area 粘贴 import. The main process only answers whether
  // the system clipboard holds importable content (task 245: on macOS files
  // are judged by their extensions — a Finder copy always carries the file
  // icon as an image, so readImage() says yes for any file); it never hands
  // paths or bytes to the renderer. The import itself stays in the renderer's
  // paste listener, which is why the second handler just performs one
  // webContents.paste() on the main window.
  ipcMain.handle("clipboard-importable", (event) => {
    if (!trustedRendererEvent(event)) return false;
    try {
      return clipboardImportable({ platform: process.platform, clipboard });
    } catch {
      return false;
    }
  });

  ipcMain.handle("paste-from-clipboard", (event) => {
    if (!trustedRendererEvent(event)) return false;
    event.sender.paste();
    return true;
  });

  // Text copy uses Electron's native clipboard rather than the renderer Web
  // Clipboard API. Browser permissions are intentionally denied for the app's
  // local HTTP renderer, so navigator.clipboard.writeText() is not a reliable
  // desktop path (notably on macOS). Keep the bridge narrow: current main
  // window only, text only, and a bounded payload.
  ipcMain.handle("write-clipboard-text", async (event, text) => {
    if (!trustedRendererEvent(event)) return { ok: false, reason: "unavailable" };
    if (typeof text !== "string" || text.length > MAX_CLIPBOARD_TEXT_LENGTH) {
      return { ok: false, reason: "invalid" };
    }
    clipboard.writeText(text);
    return { ok: true };
  });

  // Copy the stored full-resolution asset, never a gallery thumbnail or preview.
  // The renderer may only request files inside the active MOSA library; decoding
  // and clipboard access stay in the trusted main process. 审查 3-6 甲（任务 318）：
  // the path gate lives in clipboard-image-path.mjs and decides library
  // containment on the literal path first, so out-of-library requests can no
  // longer distinguish「存在」from「不存在」.
  ipcMain.handle("write-clipboard-image", async (event, path) => {
    if (!trustedRendererEvent(event)) return { ok: false, reason: "unavailable" };
    const target = clipboardImageTarget(path, getLibraryDir());
    if (!target.ok) return { ok: false, reason: target.reason };
    try {
      const image = nativeImage.createFromPath(target.path);
      if (image.isEmpty()) return { ok: false, reason: "unsupported" };
      clipboard.writeImage(image);
      return { ok: true };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  });

  // Native file export (drag-out and the multi-file clipboard) is deliberately
  // a one-way, narrow bridge. The renderer may nominate library paths, but the
  // trusted main process canonicalizes every path, rejects directories and
  // out-of-library targets, caps the batch, and only then hands files to the
  // OS. `skipped` counts nominated paths that did not pass.
  const allowedLibraryFiles = (requestedPaths) => {
    const input = Array.isArray(requestedPaths) ? requestedPaths.slice(0, MAX_NATIVE_DRAG_FILES) : [];
    const files = [];
    const seen = new Set();
    let skipped = 0;
    for (const requestedPath of input) {
      if (typeof requestedPath !== "string" || !requestedPath.trim()) { skipped += 1; continue; }
      let allowed;
      try {
        allowed = resolveAllowedFolderPath(requestedPath.trim(), [getLibraryDir()]);
        if (allowed && seen.has(allowed)) continue;
        if (!allowed || !existsSync(allowed) || !statSync(allowed).isFile()) { skipped += 1; continue; }
      } catch {
        skipped += 1;
        continue;
      }
      seen.add(allowed);
      files.push(allowed);
    }
    return { files, skipped };
  };

  ipcMain.handle("start-native-file-drag", async (event, requestedPaths) => {
    if (!trustedRendererEvent(event)) return { ok: false };
    const { files } = allowedLibraryFiles(requestedPaths);
    if (!files.length) return { ok: false };
    let icon = nativeImage.createFromPath(files[0]);
    icon = icon.isEmpty() ? NATIVE_DRAG_FALLBACK_ICON : nativeDragIcon(icon);
    screenGuard.startDrag(event.sender, { file: files[0], files, icon });
    return { ok: true, count: files.length };
  });

  ipcMain.handle("write-clipboard-files", async (event, requestedPaths) => {
    if (!trustedRendererEvent(event)) return { ok: false, reason: "unavailable" };
    const { files, skipped } = allowedLibraryFiles(requestedPaths);
    if (!files.length) return { ok: false, reason: "missing", skipped };
    try {
      const written = await writeClipboardFiles(files, { clipboard });
      return written ? { ok: true, count: files.length, skipped } : { ok: false, reason: "unsupported" };
    } catch (error) {
      console.error(`[MOSA] write-clipboard-files failed: ${error?.message || error}`);
      return { ok: false, reason: "unavailable" };
    }
  });

  // The reverse check for drops: true for each path that resolves to an
  // existing file inside the library (same canonicalization as the drag-out
  // bridge above), so the renderer can skip re-importing those files.
  ipcMain.handle("library-file-flags", async (event, requestedPaths) => {
    if (!trustedRendererEvent(event)) return [];
    const input = Array.isArray(requestedPaths) ? requestedPaths.slice(0, 10_000) : [];
    return input.map((requestedPath) => {
      if (typeof requestedPath !== "string" || !requestedPath.trim()) return false;
      try {
        const allowed = resolveAllowedFolderPath(requestedPath.trim(), [getLibraryDir()]);
        return Boolean(allowed && existsSync(allowed) && statSync(allowed).isFile());
      } catch {
        return false;
      }
    });
  });
}
