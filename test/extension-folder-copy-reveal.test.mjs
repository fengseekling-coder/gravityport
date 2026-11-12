// Settings → 连接 → 浏览器扩展, the managed-folder steps (found on 0.3.11):
// 复制位置 called navigator.clipboard.writeText directly, which the packaged
// app can refuse — the button silently did nothing; and 在访达中显示 selected
// manifest.json, which opened the extension folder's contents instead of
// showing which folder Chrome's 加载已解压的扩展程序 asks for.
import { execFileSync } from "node:child_process";
import { readFileSync as readFileSyncForMainSources, readdirSync as readdirSyncForMainSources } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiSrc = join(repositoryRoot, "web", "gravityport", "src");

let desktop;
let tempRoot;
const originalWindow = globalThis.window;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function setNavigatorClipboard(clipboard) {
  Object.defineProperty(globalThis, "navigator", { value: { clipboard }, configurable: true, writable: true });
}

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "mosa-extension-folder-"));
  const outDir = join(tempRoot, "out");
  await mkdir(outDir, { recursive: true });
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    join(uiSrc, "desktop.ts"),
    "--outDir", outDir,
    "--rootDir", uiSrc,
    "--module", "commonjs",
    "--moduleResolution", "node",
    "--target", "es2022",
    "--skipLibCheck",
  ], { stdio: "pipe" });
  desktop = await import(join(outDir, "desktop.js"));
});

after(async () => {
  globalThis.window = originalWindow;
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  await rm(tempRoot, { recursive: true, force: true });
});

// Task 396: registerIPC handlers now live in desktop/ipc/*.mjs, so source-text
// assertions read desktop/main.mjs plus those files.
function readDesktopMainSources(repoRoot) {
  const ipcDir = repoRoot + "/desktop/ipc";
  const parts = [readFileSyncForMainSources(repoRoot + "/desktop/main.mjs", "utf8")];
  for (const name of readdirSyncForMainSources(ipcDir).filter((file) => file.endsWith(".mjs")).sort()) {
    parts.push(readFileSyncForMainSources(ipcDir + "/" + name, "utf8"));
  }
  return parts.join("\n");
}

test("the desktop bridge copies the text even when navigator.clipboard refuses", async () => {
  const written = [];
  globalThis.window = { electronAPI: { writeClipboardText: async (text) => { written.push(text); return { ok: true }; } } };
  setNavigatorClipboard({ writeText: async () => { throw new Error("NotAllowedError"); } });
  await desktop.writeTextToClipboard("/Users/me/Library/Application Support/mosa/browser-extension/chrome");
  assert.deepEqual(written, ["/Users/me/Library/Application Support/mosa/browser-extension/chrome"]);
});

test("a refused bridge write is an error, not a silent success", async () => {
  globalThis.window = { electronAPI: { writeClipboardText: async () => ({ ok: false }) } };
  await assert.rejects(() => desktop.writeTextToClipboard("x"), /refused/);
});

test("without the bridge the browser clipboard is used, and a missing one is an error", async () => {
  const written = [];
  globalThis.window = {};
  setNavigatorClipboard({ writeText: async (text) => { written.push(text); } });
  await desktop.writeTextToClipboard("browser mode");
  assert.deepEqual(written, ["browser mode"]);
  setNavigatorClipboard(undefined);
  await assert.rejects(() => desktop.writeTextToClipboard("x"), /unavailable/);
});

test("复制位置 goes through the shared helper, not navigator.clipboard", async () => {
  const card = await readFile(join(uiSrc, "WebCaptureStatusCard.tsx"), "utf8");
  const copyFolder = card.slice(card.indexOf("const copyFolder"), card.indexOf("const showFolder"));
  assert.match(copyFolder, /writeTextToClipboard\(managed\.path\)/);
  assert.doesNotMatch(copyFolder, /navigator\.clipboard/);
});

test("在访达中显示 selects the extension folder itself, not manifest.json inside it", async () => {
  const main = readDesktopMainSources(repositoryRoot);
  const start = main.indexOf('ipcMain.handle("reveal-managed-extension-folder"');
  assert.ok(start >= 0);
  const handler = main.slice(start, main.indexOf("});", start));
  assert.match(handler, /shell\.showItemInFolder\(managedBrowserExtensionTarget\)/);
  assert.doesNotMatch(handler, /showItemInFolder\(manifestPath\)/);
});
