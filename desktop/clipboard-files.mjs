// Several library files onto the system clipboard (task 198), so they paste
// into Finder, Explorer, chat apps and web pages as that many files. Callers
// pass paths the main process has already canonicalized to library files.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const escapeXml = (value) => String(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;");

/** The property list macOS reads as NSFilenamesPboardType: one <string> per
 *  file. AppKit turns it into one public.file-url item per path. */
export function macFilenamesPlist(paths) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<plist version="1.0"><array>${paths.map((path) => `<string>${escapeXml(path)}</string>`).join("")}</array></plist>`,
  ].join("\n");
}

// Electron cannot write CF_HDROP, so Windows goes through Windows PowerShell's
// Set-Clipboard -LiteralPath. The script is a constant: the paths travel in a
// UTF-8 JSON file named by an environment variable, never in the command line.
export const WINDOWS_SET_CLIPBOARD_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$paths = @(Get-Content -LiteralPath $env:GRAVITYPORT_CLIPBOARD_FILES -Raw -Encoding UTF8 | ConvertFrom-Json)",
  "Set-Clipboard -LiteralPath $paths",
].join("; ");

const runFile = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, (error) => (error ? reject(error) : resolve()));
});

/**
 * Writes `paths` to the clipboard as files. Returns true when written, false
 * on a platform without a file clipboard; throws when the write fails.
 */
export async function writeClipboardFiles(paths, { platform = process.platform, clipboard, run = runFile } = {}) {
  if (!paths.length) return false;
  if (platform === "darwin") {
    clipboard.clear();
    clipboard.writeBuffer("NSFilenamesPboardType", Buffer.from(macFilenamesPlist(paths), "utf8"));
    return true;
  }
  if (platform === "win32") {
    const dir = await mkdtemp(join(tmpdir(), "gravityport-clipboard-"));
    const listFile = join(dir, "files.json");
    try {
      await writeFile(listFile, JSON.stringify(paths), "utf8");
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS_SET_CLIPBOARD_SCRIPT], {
        env: { ...process.env, GRAVITYPORT_CLIPBOARD_FILES: listFile },
        timeout: 10_000,
        windowsHide: true,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return true;
  }
  return false;
}
