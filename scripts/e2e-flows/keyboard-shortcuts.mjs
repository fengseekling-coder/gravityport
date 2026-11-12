// GravityPort keyboard-shortcuts flow (task 384): launches the REAL desktop
// shell (desktop/main.mjs with preload) and drives every shortcut through CDP
// Input.dispatchKeyEvent / dispatchMouseEvent — trusted browser input, no
// real mouse or keyboard, exactly like desktop-input.
//
// What this flow proves, layer by layer:
// - ⌘C with a batch puts the real file paths on the OS clipboard (read back
//   through NSPasteboard the way Finder sees them) with the 已复制 toast, and
//   a ⌘V paste of those same library files is deduped (已在素材库中).
// - A selected prompt range keeps ⌘C on the text path: clipboard text, no
//   files — the browser's own copy, never the file intercept.
// - document.execCommand("copy") with one card selected (Runtime.evaluate,
//   userGesture) rides the web `copy` event — the same event the desktop
//   menu's 拷贝 role fires — and lands the file path. CDP keys bypass the
//   macOS menu accelerator table entirely, so a pressed-for-real ⌘C through
//   the menu bar cannot be exercised here; the menu side is pinned by
//   test/desktop-menu-template.test.mjs (role kept for copy/cut/paste) and
//   this execCommand step (the event both paths converge on).
// - ⌘[ / ⌘] and the mouse side buttons (button "back"/"forward") step
//   nav history without reloading the page (live window marker survives).
// - Back with the viewer open closes only the viewer (windowed and
//   fullscreen), leaving the group; the next ⌘[ steps history.
// - Esc in a stack without a user selection exits the stack; with a batch it
//   only clears the batch, and the second Esc exits.
// - The rename-group dialog traps Tab inside, lands focus on its input, and
//   Esc cancels; the delete-group dialog lands on 取消 and Esc keeps the group.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { realpathSync } from "node:fs";
import { readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopGui } from "../desktop-gui-launcher.mjs";
import { ensureElectronExecutablePath } from "../desktop-runtime-paths.mjs";

export const name = "keyboard-shortcuts";
export const description = "real desktop shell: ⌘C copies selection files to the system clipboard (toast + paste dedupe), text selection keeps ⌘C on text, execCommand copy rides the web copy event, ⌘[/⌘] and mouse side buttons step history, viewer back closes only the viewer, Esc exits stacks, group dialogs trap Tab and cancel on Esc";

const SEED_COUNT = 5;
const GROUP_NAME = "e2e-shortcuts-group-384";

export async function run(ctx) {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    throw new Error(`keyboard-shortcuts needs a real system clipboard (darwin/win32), not ${process.platform}`);
  }
  await ctx.prepare();
  const guiRoot = join(ctx.userDataDir, "..", "desktop-gui");
  await mkdir(join(guiRoot, "generated-images"), { recursive: true });
  await mkdir(join(guiRoot, "codex-sessions"), { recursive: true });
  await mkdir(join(guiRoot, "grok-sessions"), { recursive: true });
  await mkdir(join(guiRoot, "cowart-data"), { recursive: true });

  const port = await freePort();
  const cdpPort = await freePort();
  const pidFile = join(guiRoot, "pid.txt");
  const logFile = join(guiRoot, "main.log");
  const healthFile = join(guiRoot, "health.json");
  const executable = ensureElectronExecutablePath({ rootDir: ctx.rootDir });
  const qaFlags = process.platform === "win32" ? ["--disable-gpu"] : [];
  const launched = await launchDesktopGui({
    platform: process.platform,
    rootDir: guiRoot,
    executable,
    args: [...qaFlags, "desktop/main.mjs", `--user-data-dir=${ctx.userDataDir}`, `--remote-debugging-port=${cdpPort}`],
    env: {
      ...process.env,
      MOSA_RUNTIME_MODE: "qa",
      MOSA_QA_RUN: "1",
      MOSA_CLIENT_TOKEN: ctx.token,
      MOSA_LIBRARY_DIR: ctx.libraryDir,
      MOSA_USER_DATA: ctx.userDataDir,
      MOSA_DISABLE_BRIDGES: "cowart,cowartDiscovery,codex,grok",
      MOSA_PROJECT_DIR: ctx.rootDir,
      MOSA_DESKTOP_PORT: String(port),
      CODEX_GENERATED_IMAGES_DIR: join(guiRoot, "generated-images"),
      CODEX_SESSIONS_DIR: join(guiRoot, "codex-sessions"),
      GROK_SESSIONS_DIR: join(guiRoot, "grok-sessions"),
      COWART_MOSA_CANVAS_DIR: join(guiRoot, "cowart-data"),
      MOSA_COWART_REGISTRY_PATH: join(guiRoot, "cowart-data", "registry.json"),
    },
    cwd: ctx.rootDir,
    pidFile,
    logFile,
    healthUrl: `http://127.0.0.1:${port}/api/health`,
    healthFile,
  });

  let cdp = null;
  try {
    await waitForHealthFile(healthFile);
    const origin = `http://127.0.0.1:${port}`;
    const seeded = await seedAssets(ctx, port);
    await ctx.api(origin, "POST", "/api/groups", { projectId: "default", name: GROUP_NAME });
    // The group view needs one card for the viewer steps inside it.
    await ctx.api(origin, "POST", "/api/assets/batch", {
      action: "group", projectId: "default", assetIds: [seeded.ids[2]], group: GROUP_NAME,
    });
    const stack = await ctx.api(origin, "POST", "/api/asset-stacks", {
      projectId: "default", assetIds: [seeded.ids[3], seeded.ids[4]],
    });
    if (!stack?.stack?.id) throw new Error(`stack create failed: ${JSON.stringify(stack)}`);

    cdp = await connectCdp(cdpPort, origin);
    const failures = [];
    const step = async (label, fn) => {
      try {
        await fn();
        console.log(`[keyboard-shortcuts] ok: ${label}`);
      } catch (error) {
        failures.push(`${label}: ${error.message}`);
        console.error(`[keyboard-shortcuts] FAIL: ${label}: ${error.message}`);
      }
    };
    // The sidebar and grid update through the live library stream; every
    // trusted click waits for that stream to settle first (desktop-input
    // pattern — a re-render replacing a node mid-click loses the click).
    const waitForLibraryQuiet = async (label) => {
      const deadline = Date.now() + 30000;
      let lastRevision = null;
      let stableSince = Date.now();
      for (;;) {
        if (Date.now() >= deadline) throw new Error(`library never went quiet before ${label}`);
        const { revision } = await ctx.api(origin, "GET", "/api/library-revision?project=default");
        if (revision !== lastRevision) { lastRevision = revision; stableSince = Date.now(); }
        else if (Date.now() - stableSince >= 1500) { await sleep(300); return; }
        await sleep(250);
      }
    };

    const activeNav = () => cdp.evaluate(`document.querySelector('.nav-row[aria-current="page"]')?.getAttribute('aria-label') || 'none'`);
    const cardCenter = async (assetId) => {
      const point = await cdp.evaluate(`(() => {
        const el = document.querySelector('[data-asset-id="${assetId}"]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width === 0) return null;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (!point) throw new Error(`card not on screen: ${assetId}`);
      return point;
    };
    const selectedCount = () => cdp.evaluate(`document.querySelectorAll('.asset-card.asset-selected').length`);
    const toastText = () => cdp.evaluate(`document.querySelector('.toast')?.textContent || ''`);
    const waitForToast = async (fragment) => {
      const deadline = Date.now() + 12000;
      for (;;) {
        const text = await toastText();
        if (text.includes(fragment)) return text;
        if (Date.now() >= deadline) throw new Error(`toast 「${fragment}」 never shown; last=${JSON.stringify(text)}`);
        await sleep(150);
      }
    };

    await waitForLibraryQuiet("first render");
    await waitFor(cdp, `document.querySelectorAll('.asset-card').length >= 4`, "seeded grid", 20000);

    // ── 1. ⌘C with two cards: file paths on the OS clipboard + toast ──
    await step("⌘C on two cards copies their file paths with the 已复制 toast", async () => {
      await dispatchClick(cdp, await cardCenter(seeded.ids[0]));
      await waitFor(cdp, `document.querySelectorAll('.asset-card.asset-selected').length === 1`, "first card selected");
      await dispatchClick(cdp, await cardCenter(seeded.ids[1]), { modifiers: 4 });
      await waitFor(cdp, `document.querySelectorAll('.asset-card.asset-selected').length === 2`, "batch of two");
      await dispatchCopyKey(cdp);
      await waitForToast("已复制 2 个素材");
      const expected = [seeded.paths[0], seeded.paths[1]].map((p) => realpathSync.native(p));
      const actual = readSystemClipboard().files.map((p) => realpathSync.native(p));
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`clipboard files ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
      }
    });

    // ── 2. ⌘V of those same library files: import dedupe, count unchanged ──
    await step("⌘V pasting the copied library files dedupes with the 已在素材库中 toast", async () => {
      const before = await ctx.api(origin, "GET", "/api/assets?project=default&limit=1000");
      const beforeCount = (before.assets || []).length;
      await dispatchPasteCommand(cdp);
      await waitForToast("已在素材库中");
      const after = await ctx.api(origin, "GET", "/api/assets?project=default&limit=1000");
      const afterCount = (after.assets || []).length;
      if (afterCount !== beforeCount) throw new Error(`asset count changed: ${beforeCount} -> ${afterCount}`);
    });

    // ── 3. a selected prompt range keeps ⌘C on the text path ──
    await step("⌘C with a selected prompt range copies the text, not files", async () => {
      await dispatchClick(cdp, await cardCenter(seeded.ids[2]));
      await waitFor(cdp, `Boolean(document.querySelector('#asset-prompt'))`, "inspector prompt visible");
      const selected = await cdp.evaluate(`(() => {
        const p = document.querySelector('#asset-prompt');
        const range = document.createRange();
        range.selectNodeContents(p);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return sel.toString();
      })()`);
      if (!selected || selected !== seeded.prompts[2]) {
        throw new Error(`prompt selection mismatch: ${JSON.stringify(selected)}`);
      }
      await dispatchCopyKey(cdp);
      await sleep(400);
      const clipboard = readSystemClipboard();
      if (clipboard.files.length) throw new Error(`clipboard unexpectedly carries files: ${JSON.stringify(clipboard.files)}`);
      if (clipboard.text !== seeded.prompts[2]) {
        throw new Error(`clipboard text ${JSON.stringify(clipboard.text)} != prompt ${JSON.stringify(seeded.prompts[2])}`);
      }
    });

    // ── 4. the web copy event (menu 拷贝 role's path) copies the file ──
    await step("document.execCommand('copy') with one card lands its file path", async () => {
      await dispatchClick(cdp, await cardCenter(seeded.ids[0]));
      await waitFor(cdp, `document.querySelectorAll('.asset-card.asset-selected').length === 1`, "one card selected");
      await cdp.send("Runtime.evaluate", {
        expression: `document.execCommand('copy')`,
        userGesture: true,
        returnByValue: true,
      });
      await waitForToast("已复制 1 个素材");
      const expected = [seeded.paths[0]].map((p) => realpathSync.native(p));
      const actual = readSystemClipboard().files.map((p) => realpathSync.native(p));
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`clipboard files ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
      }
    });

    // ── 5. ⌘[ / ⌘] step nav history like the toolbar arrows ──
    await step("⌘[ / ⌘] walk back and forth between the group and 所有素材", async () => {
      await clickCenter(cdp, `document.querySelector('.nav-row[aria-label="所有素材"]')`);
      await waitFor(cdp, `document.querySelector('.nav-row[aria-current="page"]')?.getAttribute('aria-label') === '所有素材'`, "back on 所有素材");
      await clickCenter(cdp, `document.querySelector('.nav-row.group-row[aria-label="${GROUP_NAME}"]')`);
      await waitFor(cdp, `document.querySelector('.nav-row[aria-current="page"]')?.getAttribute('aria-label') === '${GROUP_NAME}'`, "inside the group");
      await dispatchNavBackKey(cdp);
      await waitFor(cdp, `document.querySelector('.nav-row[aria-current="page"]')?.getAttribute('aria-label') === '所有素材'`, "⌘[ went back to 所有素材");
      await dispatchNavForwardKey(cdp);
      await waitFor(cdp, `document.querySelector('.nav-row[aria-current="page"]')?.getAttribute('aria-label') === '${GROUP_NAME}'`, "⌘] came forward to the group");
    });

    // ── 6. mouse side buttons do the same, with no page reload ──
    await step("mouse side buttons step history without a page reload", async () => {
      await cdp.evaluate(`(() => { window.__ksProbe = { marker: 384, href: location.href }; return window.__ksProbe.marker; })()`);
      await dispatchSideButton(cdp, "back");
      await waitFor(cdp, `document.querySelector('.nav-row[aria-current="page"]')?.getAttribute('aria-label') === '所有素材'`, "side back to 所有素材");
      await dispatchSideButton(cdp, "forward");
      await waitFor(cdp, `document.querySelector('.nav-row[aria-current="page"]')?.getAttribute('aria-label') === '${GROUP_NAME}'`, "side forward to the group");
      const probe = await cdp.evaluate(`(() => ({ marker: window.__ksProbe?.marker || null, href: location.href, same: window.__ksProbe?.href === location.href }))()`);
      if (probe.marker !== 384 || !probe.same) {
        throw new Error(`page reloaded or marker lost: ${JSON.stringify(probe)}`);
      }
    });

    // ── 7. back with the viewer open closes only the viewer ──
    await step("⌘[ with the viewer open closes just the viewer (windowed, then fullscreen)", async () => {
      await dispatchDoubleClick(cdp, await cardCenter(seeded.ids[2]));
      await waitFor(cdp, `document.querySelector('.workspace')?.classList.contains('preview-open')`, "viewer open");
      await dispatchNavBackKey(cdp);
      await waitFor(cdp, `!document.querySelector('.workspace')?.classList.contains('preview-open')`, "viewer closed");
      const stillGroup = await activeNav();
      if (stillGroup !== GROUP_NAME) throw new Error(`viewer-back left the group: ${stillGroup}`);
      // Fullscreen: the same single-step close, no extra history step.
      await dispatchDoubleClick(cdp, await cardCenter(seeded.ids[2]));
      await waitFor(cdp, `document.querySelector('.workspace')?.classList.contains('preview-open')`, "viewer open again");
      await clickCenter(cdp, `document.querySelector('.viewer-controls button[title="全屏"]')`);
      await waitFor(cdp, `document.querySelector('.viewer-controls button[aria-pressed="true"]') !== null`, "viewer fullscreen");
      await dispatchNavBackKey(cdp);
      await waitFor(cdp, `!document.querySelector('.workspace')?.classList.contains('preview-open')`, "fullscreen viewer closed");
      const stillGroup2 = await activeNav();
      if (stillGroup2 !== GROUP_NAME) throw new Error(`fullscreen viewer-back left the group: ${stillGroup2}`);
      // History still holds the group: the next ⌘[ is the real step back.
      await dispatchNavBackKey(cdp);
      await waitFor(cdp, `document.querySelector('.nav-row[aria-current="page"]')?.getAttribute('aria-label') === '所有素材'`, "second ⌘[ steps history");
      await dispatchNavForwardKey(cdp);
      await waitFor(cdp, `document.querySelector('.nav-row[aria-current="page"]')?.getAttribute('aria-label') === '${GROUP_NAME}'`, "forward back into the group");
    });

    // ── 8. Esc in a stack: no selection exits, a batch clears first ──
    await step("Esc in a stack exits without a selection, clears a batch first", async () => {
      await clickCenter(cdp, `document.querySelector('.nav-row[aria-label="所有素材"]')`);
      await waitFor(cdp, `document.querySelector('.nav-row[aria-current="page"]')?.getAttribute('aria-label') === '所有素材'`, "on 所有素材");
      await waitFor(cdp, `[...document.querySelectorAll('.asset-card')].some((el) => el.querySelector('.stack-mark'))`, "stack card in the grid");
      const findStackCard = () => cdp.evaluate(`(() => {
        const card = [...document.querySelectorAll('.asset-card')].find((el) => el.querySelector('.stack-mark'));
        if (!card) return null;
        const r = card.getBoundingClientRect();
        if (r.width === 0) return null;
        return { id: card.getAttribute('data-asset-id'), x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      const stackCard = await findStackCard();
      if (!stackCard?.id) throw new Error("no stack card in the grid");
      await dispatchDoubleClick(cdp, stackCard);
      await waitFor(cdp, `Boolean(document.querySelector('.viewer-title')) && !document.querySelector('.workspace.preview-open')`, "inside the stack view");
      // The view load seats the app's implicit focus on the first member; the
      // "no user selection" scenario needs that settled before Esc.
      await waitFor(cdp, `document.querySelectorAll('.asset-card.asset-selected').length === 1`, "implicit focus seated");
      await sleep(400);
      await pressEscape(cdp);
      await waitFor(cdp, `!document.querySelector('.viewer-title')`, "Esc left the stack");
      const nav = await activeNav();
      if (nav !== "所有素材") throw new Error(`Esc exit landed on ${nav}`);
      // Re-enter (re-measure: the restored view may place the stack card
      // elsewhere); select two members; Esc clears the batch and stays; Esc leaves.
      await waitFor(cdp, `[...document.querySelectorAll('.asset-card')].some((el) => el.querySelector('.stack-mark'))`, "stack card back in the grid");
      const stackCard2 = await findStackCard();
      if (!stackCard2?.id) throw new Error("stack card gone for re-entry");
      await dispatchDoubleClick(cdp, stackCard2);
      await waitFor(cdp, `Boolean(document.querySelector('.viewer-title')) && document.querySelectorAll('.asset-card.asset-selected').length === 1`, "back inside the stack, implicit focus seated");
      await sleep(400);
      const members = await cdp.evaluate(`(() => {
        const cards = [...document.querySelectorAll('.asset-card')].map((el) => {
          const r = el.getBoundingClientRect();
          return { id: el.getAttribute('data-asset-id'), x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }).filter((card) => card.id);
        return cards;
      })()`);
      if (members.length < 2) throw new Error(`stack members visible: ${members.length}`);
      await dispatchClick(cdp, members[0]);
      await dispatchClick(cdp, members[1], { modifiers: 4 });
      await waitFor(cdp, `document.querySelectorAll('.asset-card.asset-selected').length === 2`, "two members selected");
      await pressEscape(cdp);
      await waitFor(cdp, `document.querySelectorAll('.asset-card.asset-selected').length === 0`, "Esc cleared the batch");
      if (!(await cdp.evaluate(`Boolean(document.querySelector('.viewer-title'))`))) {
        throw new Error("Esc with a batch left the stack; it must only clear the selection");
      }
      await pressEscape(cdp);
      await waitFor(cdp, `!document.querySelector('.viewer-title')`, "second Esc left the stack");
    });

    // ── 9. group dialogs: focus lands, Tab stays in, Esc cancels ──
    await step("rename-group dialog traps Tab on its input and Esc cancels", async () => {
      const row = `document.querySelector('.nav-row.group-row[aria-label="${GROUP_NAME}"]')`;
      await dispatchClick(cdp, await centerOf(cdp, row), { button: "right" });
      await waitFor(cdp, `Boolean(document.querySelector('.context-menu'))`, "group menu open");
      await clickCenter(cdp, `[...document.querySelectorAll('.context-menu .menu-row')].find((el) => el.textContent.includes('重命名分组'))`);
      await waitFor(cdp, `Boolean(document.querySelector('.group-dialog'))`, "rename dialog open");
      await waitFor(cdp, `document.activeElement?.tagName === 'INPUT' && !!document.activeElement?.closest('.group-dialog')`, "focus on the dialog input");
      const before = await cdp.evaluate(`document.querySelector('.group-dialog input')?.value || ''`);
      for (let i = 0; i < 4; i += 1) {
        await pressTab(cdp);
        await sleep(120);
      }
      const inside = await cdp.evaluate(`(() => {
        const el = document.activeElement;
        return Boolean(el && el.closest && el.closest('.group-dialog'));
      })()`);
      if (!inside) throw new Error("Tab left the rename dialog");
      await pressEscape(cdp);
      await waitFor(cdp, `!document.querySelector('.group-dialog')`, "rename dialog closed");
      const after = await cdp.evaluate(`document.querySelector('.nav-row.group-row[aria-label="${GROUP_NAME}"]') !== null`);
      if (!after) throw new Error("group row vanished after cancelling rename");
      if (before !== GROUP_NAME) throw new Error(`dialog draft was not the current name: ${JSON.stringify(before)}`);
    });

    await step("delete-group dialog lands on 取消 and Esc keeps the group", async () => {
      const row = `document.querySelector('.nav-row.group-row[aria-label="${GROUP_NAME}"]')`;
      await dispatchClick(cdp, await centerOf(cdp, row), { button: "right" });
      await waitFor(cdp, `Boolean(document.querySelector('.context-menu'))`, "group menu open");
      await clickCenter(cdp, `[...document.querySelectorAll('.context-menu .menu-row')].find((el) => el.textContent.includes('删除分组'))`);
      await waitFor(cdp, `Boolean(document.querySelector('.group-dialog'))`, "delete dialog open");
      await waitFor(cdp, `document.activeElement?.textContent === '取消'`, "focus on 取消");
      await pressEscape(cdp);
      await waitFor(cdp, `!document.querySelector('.group-dialog')`, "delete dialog closed");
      const kept = await cdp.evaluate(`document.querySelector('.nav-row.group-row[aria-label="${GROUP_NAME}"]') !== null`);
      if (!kept) throw new Error("group was deleted by a cancelled dialog");
    });

    // ⌘A in the gallery is covered by the existing select-all-across-pages
    // flow (part of this run's MOSA_E2E_ONLY list) — no duplicate here.

    if (failures.length) throw new Error(`${failures.length} keyboard-shortcuts step(s) failed:\n- ${failures.join("\n- ")}`);
    return { seeded: SEED_COUNT, steps: "all passed" };
  } catch (error) {
    const log = await readFile(logFile, "utf8").catch(() => "");
    throw new Error(`${error.message}${log ? `\n[keyboard-shortcuts] main.log tail:\n${log.slice(-2000)}` : ""}`, { cause: error });
  } finally {
    if (cdp) cdp.close();
    const pid = Number.parseInt(await readFile(pidFile, "utf8").catch(() => "0"), 10);
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      await sleep(1500);
      try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch {}
    }
    if (launched.waiter && launched.waiter.exitCode === null) {
      try { launched.waiter.kill("SIGTERM"); } catch {}
    }
    await rm(guiRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => {});
  }
}

// ── seeds ──

async function seedAssets(ctx, port) {
  const origin = `http://127.0.0.1:${port}`;
  const ids = [];
  const paths = [];
  const prompts = [];
  for (let index = 0; index < SEED_COUNT; index += 1) {
    const tint = [(index * 53 + 40) % 256, (index * 97 + 80) % 256, (index * 131 + 120) % 256];
    const imagePath = await ctx.makePng(`kb-shortcuts-${index}.png`, tint);
    const bytes = await readFile(imagePath);
    const staged = await fetch(`${origin}/api/import/stage`, {
      method: "POST",
      headers: {
        "content-type": "image/png",
        "x-mosa-file-name": encodeURIComponent(`kb-shortcuts-${index}.png`),
        "x-mosa-client-token": ctx.token,
      },
      body: bytes,
    });
    if (!staged.ok) throw new Error(`import stage failed (${staged.status}) for seed ${index}`);
    const { path } = await staged.json();
    const prompt = `键盘快捷键 e2e 提示词 ${index} keyboard-shortcuts`;
    const created = await ctx.api(origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath: path,
      prompt,
    });
    if (!created?.asset?.id) throw new Error(`asset create failed for seed ${index}`);
    ids.push(created.asset.id);
    paths.push(String(created.asset.image_path || ""));
    prompts.push(prompt);
  }
  await sleep(1500);
  if (paths.some((p) => !p)) throw new Error(`seeded image_path missing: ${JSON.stringify(paths)}`);
  return { ids, paths, prompts };
}

// ── clipboard (the way other apps read it) ──

function readSystemClipboard() {
  if (process.platform === "darwin") {
    const script = 'ObjC.import("AppKit"); var pb = $.NSPasteboard.generalPasteboard; '
      + 'var files = []; var urls = pb.readObjectsForClassesOptions($([$.NSURL]), $({})); '
      + 'if (urls) { for (var i = 0; i < urls.count; i++) files.push(urls.objectAtIndex(i).path.js); } '
      + 'var s = pb.stringForType($.NSPasteboardTypeString); '
      + 'var text = (s && !s.isNil()) ? String(s.js) : ""; '
      + 'JSON.stringify({ files: files, text: text })';
    return JSON.parse(execFileSync("osascript", ["-l", "JavaScript", "-e", script], { encoding: "utf8" }));
  }
  const filesScript = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; ConvertTo-Json -Compress @(Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName })";
  // With no file on the clipboard, Get-Clipboard -Format FileDropList yields
  // $null, and Windows PowerShell's ForEach-Object still runs once for a piped
  // $null — the JSON comes back as [null]. Keep only real paths.
  const parsedFiles = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", filesScript], { encoding: "utf8" }) || "[]");
  const files = (Array.isArray(parsedFiles) ? parsedFiles : [parsedFiles]).filter((path) => typeof path === "string" && path);
  const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard"], { encoding: "utf8" }).replace(/\r?\n$/, "");
  return { files, text };
}

// ── input (trusted CDP only) ──

// ⌘C on macOS carries commands:["copy"] (CDP keys bypass the menu accelerator
// table, so the edit command must ride along — same trick as ⌘V in
// desktop-paste-import). A preventDefault'ed keydown handles the copy itself;
// with a text selection the command performs the browser's text copy.
async function dispatchCopyKey(cdp) {
  if (process.platform === "darwin") {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "c", code: "KeyC", windowsVirtualKeyCode: 67, modifiers: 4, commands: ["copy"] });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "c", code: "KeyC", windowsVirtualKeyCode: 67, modifiers: 4 });
    return;
  }
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "c", code: "KeyC", windowsVirtualKeyCode: 67, modifiers: 2, commands: ["copy"] });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "c", code: "KeyC", windowsVirtualKeyCode: 67, modifiers: 2 });
}

// ⌘V on macOS carries commands:["paste"] (desktop-paste-import pattern); the
// Windows side sends the plain Ctrl+V sequence.
async function dispatchPasteCommand(cdp) {
  if (process.platform === "darwin") {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 4, commands: ["paste"] });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 4 });
    return;
  }
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 2, text: "v" });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 2 });
}

// ⌘[ / ⌘] (macOS) or Alt+← / Alt+→ (elsewhere). No commands: the app's own
// keydown handler owns these keys.
async function dispatchNavBackKey(cdp) {
  if (process.platform === "darwin") {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "[", code: "BracketLeft", windowsVirtualKeyCode: 219, modifiers: 4 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "[", code: "BracketLeft", windowsVirtualKeyCode: 219, modifiers: 4 });
    return;
  }
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37, modifiers: 1 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37, modifiers: 1 });
}

async function dispatchNavForwardKey(cdp) {
  if (process.platform === "darwin") {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "]", code: "BracketRight", windowsVirtualKeyCode: 221, modifiers: 4 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "]", code: "BracketRight", windowsVirtualKeyCode: 221, modifiers: 4 });
    return;
  }
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, modifiers: 1 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, modifiers: 1 });
}

// Mouse side buttons: CDP button names map to DOM buttons 3 (back) / 4
// (forward); the app preventDefaults both phases.
async function dispatchSideButton(cdp, which) {
  const buttons = which === "back" ? 8 : 16;
  const center = await cdp.evaluate(`(() => {
    const grid = document.querySelector('.asset-grid');
    if (!grid) return null;
    const r = grid.getBoundingClientRect();
    return { x: Math.min(r.x + r.width / 2, innerWidth - 10), y: Math.min(r.y + r.height / 2, innerHeight - 10) };
  })()`);
  if (!center) throw new Error("no grid to click beside");
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: center.x, y: center.y, pointerType: "mouse" });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: center.x, y: center.y, button: which, buttons, pointerType: "mouse" });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: center.x, y: center.y, button: which, buttons: 0, pointerType: "mouse" });
}

async function pressEscape(cdp) {
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
}

async function pressTab(cdp) {
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
}

async function centerOf(cdp, elementExpression) {
  const point = await cdp.evaluate(`(() => {
    const el = ${elementExpression};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!point) throw new Error(`element not found: ${elementExpression}`);
  return point;
}

async function clickCenter(cdp, elementExpression, { button = "left" } = {}) {
  const point = await centerOf(cdp, elementExpression);
  await dispatchClick(cdp, point.x, point.y, { button });
}

async function dispatchClick(cdp, xOrPoint, yOrOptions, options = {}) {
  const isPoint = typeof xOrPoint === "object";
  const x = isPoint ? xOrPoint.x : xOrPoint;
  const y = isPoint ? xOrPoint.y : yOrOptions;
  const { button = "left", modifiers = 0 } = isPoint ? (yOrOptions || {}) : options;
  const buttons = button === "right" ? 2 : 1;
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, pointerType: "mouse" });
  // clickCount is required: a press/release pair without it never synthesizes
  // the DOM click event (the pair is silently dropped instead).
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, modifiers, clickCount: 1, pointerType: "mouse" });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, modifiers, clickCount: 1, pointerType: "mouse" });
}

async function dispatchDoubleClick(cdp, point) {
  for (const clickCount of [1, 2]) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount, pointerType: "mouse" });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount, pointerType: "mouse" });
  }
}

async function waitFor(cdp, expression, label, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`Boolean(${expression})`)) return;
    await sleep(120);
  }
  const snapshot = await cdp.evaluate(`(() => ({
    active: document.querySelector('.nav-row[aria-current="page"]')?.getAttribute('aria-label') || 'none',
    cards: document.querySelectorAll('.asset-card').length,
    selected: document.querySelectorAll('.asset-card.asset-selected').length,
    preview: Boolean(document.querySelector('.workspace.preview-open')),
    stackTitle: Boolean(document.querySelector('.viewer-title')),
    toast: document.querySelector('.toast')?.textContent || '',
  }))()`).catch(() => ({}));
  throw new Error(`timeout waiting for ${label}; state=${JSON.stringify(snapshot)}`);
}

async function waitForHealthFile(filePath, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const health = JSON.parse(await readFile(filePath, "utf8"));
      if (health?.product === "mosa") return health;
    } catch {}
    await sleep(250);
  }
  throw new Error("desktop health file timeout");
}

async function connectCdp(cdpPort, expectedUrlPrefix, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find((entry) => entry.type === "page" && String(entry.url || "").startsWith(expectedUrlPrefix));
        if (target?.webSocketDebuggerUrl) return openCdpSession(target.webSocketDebuggerUrl);
      }
    } catch {}
    await sleep(200);
  }
  throw new Error(`no desktop CDP target on port ${cdpPort}`);
}

function openCdpSession(url) {
  let idSeq = 0;
  const pending = new Map();
  const socket = new WebSocket(url);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else if (message.result?.exceptionDetails) {
        reject(new Error("evaluate failed: " + (message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text)));
      } else resolve(message.result?.result?.value);
    }
  });
  const ready = new Promise((resolveReady, rejectReady) => {
    socket.addEventListener("open", resolveReady, { once: true });
    socket.addEventListener("error", () => rejectReady(new Error("CDP socket failed")), { once: true });
  });
  return {
    async send(method, params = {}) {
      await ready;
      const id = ++idSeq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      return this.send("Runtime.evaluate", { expression, returnByValue: true });
    },
    close() {
      try { socket.close(); } catch {}
    },
  };
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
