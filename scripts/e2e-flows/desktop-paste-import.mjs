// GravityPort desktop paste-to-import flow (task 239): launches the REAL
// desktop shell and drives pastes through the REAL system clipboard — files
// written with NSPasteboard (macOS) / Set-Clipboard (Windows), raw image data
// written as public.png / Clipboard.SetImage — never a synthesized
// ClipboardEvent. ⌘V goes through CDP Input.dispatchKeyEvent (macOS carries
// the native paste via commands:["paste"]; Windows sends the real Ctrl+V key
// sequence), and the blank-area menu 粘贴 goes through a trusted right-click
// and the main process's paste-from-clipboard bridge.
//
// Covered: file paste (2 PNG + 1 MP4) into 所有素材 with original names and a
// video kind; raw image data into a group (renamed 粘贴的图片 …, never in
// 待整理); a file pasted from the stack blank-area menu lands in the open
// stack; paste into a focused search field imports nothing; pasting inside
// 收藏 imports without favoriting and points at 「所有素材」; a library file
// pasted back is skipped with the 已在素材库中 toast; a text-only clipboard
// offers no blank-area 粘贴; and Finder-style copies without a media file
// (webloc / txt, always carrying the file icon TIFF) offer no 粘贴 either,
// while notes.txt + a png offers exactly one import of that png (task 245).
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { copyFile, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { launchDesktopGui } from "../desktop-gui-launcher.mjs";
import { ensureElectronExecutablePath } from "../desktop-runtime-paths.mjs";

export const name = "desktop-paste-import";
export const description = "real desktop paste-to-import: system-clipboard files/images via ⌘V and the blank-area menu 粘贴 land in the browsed view (group/stack), hidden views point at 所有素材, trash-free skips stay silent, library files never import twice";

const SEED_COUNT = 4;
const GROUP_NAME = "e2e-paste-group-239";

export async function run(ctx) {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    throw new Error(`desktop-paste-import needs a real system clipboard (darwin/win32), not ${process.platform}`);
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
    cdp = await connectCdp(cdpPort, origin);

    // ── Seed the library and the fixtures ──
    // Seeds go through the HTTP staging endpoint (desktop-input pattern): the
    // macOS GUI launcher only forwards MOSA_*/ELECTRON_* env keys, so the
    // CODEX_GENERATED_IMAGES_DIR root that /api/assets/create trusts is
    // unavailable here and direct-path creates would be refused. The clipboard
    // fixtures never touch the API — they only need to exist on disk, outside
    // the library, so the already-in-library skip cannot fire on them.
    const makePng = (fileName, [r, g, b]) => new Promise((resolvePng, rejectPng) => {
      sharp({ create: { width: 32, height: 24, channels: 4, background: { r, g, b, alpha: 1 } } })
        .png()
        .toFile(join(ctx.fixturesDir, fileName))
        .then(() => resolvePng(join(ctx.fixturesDir, fileName)))
        .catch(rejectPng);
    });
    const seedIds = [];
    let libraryFilePath = "";
    for (let index = 0; index < SEED_COUNT; index += 1) {
      const imagePath = await makePng(`paste-seed-${index}.png`, [30 + index * 40, 90, 160]);
      const staged = await fetch(`${origin}/api/import/stage`, {
        method: "POST",
        headers: {
          "content-type": "image/png",
          "x-mosa-file-name": encodeURIComponent(`paste-seed-${index}.png`),
          "x-mosa-client-token": ctx.token,
        },
        body: await readFile(imagePath),
      });
      if (!staged.ok) throw new Error(`import stage failed (${staged.status}) for seed ${index}`);
      const { path: stagedPath } = await staged.json();
      const created = await ctx.api(origin, "POST", "/api/assets/create", {
        projectId: "default",
        imagePath: stagedPath,
        prompt: `desktop-paste seed ${index}`,
      });
      seedIds.push(created.asset.id);
      if (index === 0) libraryFilePath = String(created.asset.image_path || "");
    }
    if (!libraryFilePath) throw new Error(`seeded library file path missing: ${JSON.stringify(seedIds)}`);
    await ctx.api(origin, "POST", "/api/groups", { projectId: "default", name: GROUP_NAME });
    // A stack needs at least two members; it is named after its cover, so the
    // stack card carries paste-seed-2's name in its aria-label.
    const stack = await ctx.api(origin, "POST", "/api/asset-stacks", {
      projectId: "default", assetIds: [seedIds[2], seedIds[3]],
    });
    if (!stack?.stack?.id) throw new Error(`stack create failed: ${JSON.stringify(stack)}`);
    await ctx.api(origin, "POST", `/api/assets/default/${encodeURIComponent(seedIds[1])}/favorite`);
    const filePngA = await makePng("desktop-paste-alpha.png", [220, 40, 40]);
    const filePngB = await makePng("desktop-paste-beta.png", [40, 200, 60]);
    const filePngC = await makePng("desktop-paste-gamma.png", [90, 60, 210]);
    const fileMp4 = join(ctx.fixturesDir, "desktop-paste-clip.mp4");
    await copyFile(join(ctx.rootDir, "test", "fixtures", "video-first-frame.mp4"), fileMp4);


    const total = async () => {
      const page = await ctx.api(origin, "GET", "/api/assets?project=default&limit=250");
      return page.assets || [];
    };
    const waitForTotal = async (expected, label) => {
      const deadline = Date.now() + 20000;
      let assets = [];
      while (Date.now() < deadline) {
        assets = await total();
        if (assets.length >= expected) return assets;
        await sleep(200);
      }
      throw new Error(`timeout waiting for ${label}: ${assets.length} assets, expected ${expected}`);
    };
    const toastText = () => cdp.evaluate(`document.querySelector(".toast")?.textContent || ""`);
    const waitForToast = async (needle, label) => {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const text = await toastText();
        if (text.includes(needle)) return text;
        await sleep(120);
      }
      throw new Error(`timeout waiting for toast ${label}`);
    };
    const waitFor = async (expression, label, timeoutMs = 12000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await cdp.evaluate(`Boolean(${expression})`)) return;
        await sleep(150);
      }
      const snapshot = await cdp.evaluate(`(() => ({
        active: document.querySelector('.nav-row[aria-current="page"]')?.getAttribute('aria-label') || 'none',
        cards: document.querySelectorAll('.asset-card').length,
        toast: document.querySelector('.toast')?.textContent || '',
      }))()`).catch(() => ({}));
      throw new Error(`timeout waiting for ${label}; state=${JSON.stringify(snapshot)}`);
    };

    // Capture what every paste event actually delivers: file count, names and
    // types. The clipboard writers above are the first suspect whenever an
    // import comes up short.
    await cdp.evaluate(`(() => {
      window.__pasteProbe = [];
      window.addEventListener("paste", (event) => {
        const data = event.clipboardData;
        window.__pasteProbe.push({
          files: data ? data.files.length : -1,
          names: data ? [...data.files].map((file) => file.name) : [],
          types: data ? [...(data.types || [])] : [],
        });
      }, true);
      return "probe installed";
    })()`);
    const pasteProbe = async () => cdp.evaluate(`JSON.stringify(window.__pasteProbe || [])`).then((value) => JSON.parse(value));

    const failures = [];
    const step = async (label, fn) => {
      try {
        await fn();
        console.log(`[desktop-paste-import] ok: ${label}`);
      } catch (error) {
        failures.push(`${label}: ${error.message}`);
        console.error(`[desktop-paste-import] FAIL: ${label}: ${error.message}`);
      }
    };

    // ── 1) Files on the clipboard (2 PNG + 1 MP4), ⌘V in 所有素材 ──
    await step("file paste (2 png + mp4) into 所有素材 keeps names and video kind", async () => {
      await writeClipboardFiles([filePngA, filePngB, fileMp4]);
      const before = (await total()).length;
      await dispatchPasteCommand(cdp);
      await sleep(800);
      const probe = await pasteProbe();
      const assets = await waitForTotal(before + 3, `3 pasted files imported (paste events saw ${JSON.stringify(probe)})`);
      if (!probe.some((entry) => entry.files === 3)) {
        throw new Error(`paste events saw ${JSON.stringify(probe)} — expected a 3-file paste`);
      }
      // Import ids carry the slug of the pasted file name; rows may not expose
      // a display name, so match on id / name / path whichever is present.
      const byName = (stem) => assets.filter((asset) =>
        [asset.id, asset.name, asset.image_path].some((value) => String(value || "").includes(stem)));
      if (byName("desktop-paste-alpha").length !== 1) throw new Error(`desktop-paste-alpha missing: ${JSON.stringify(assets.map((a) => a.id)).slice(0, 400)}`);
      if (byName("desktop-paste-beta").length !== 1) throw new Error("desktop-paste-beta missing");
      const video = byName("desktop-paste-clip");
      if (video.length !== 1) throw new Error("desktop-paste-clip missing");
      if (video[0].media_kind !== "video" && !/\.mp4$/i.test(String(video[0].image_path || ""))) {
        throw new Error(`mp4 did not import as video: ${JSON.stringify(video[0]).slice(0, 300)}`);
      }
    });

    // ── 2) Raw image data into a group view ──
    await step("raw image data pasted in a group view joins the group with a 粘贴的图片 name", async () => {
      await clickCenter(cdp, `document.querySelector('.sidebar .group-row[aria-label="${GROUP_NAME}"]')`);
      await waitFor(`[...document.querySelectorAll('.sidebar .group-row')].some((row) => row.getAttribute('aria-current') === 'page' && row.getAttribute('aria-label') === '${GROUP_NAME}')`,
      "group view active");
      await writeClipboardImage(filePngA);
      await dispatchPasteCommand(cdp);
      await waitFor(`document.querySelectorAll('.asset-card').length === 1`, "pasted card lands in the group view");
      const assets = await total();
      // The backend slugs imported names into ids, stripping non-ASCII — so
      // the 粘贴的图片 prefix cannot survive, but the rename's timestamp can.
      // A renamed paste is the only asset whose id starts with its local
      // date+time slug.
      const todaySlug = new Date().toLocaleDateString("sv-SE").replaceAll("-", "-");
      const pasted = assets.find((asset) => /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[0-9a-z]+-[0-9a-f]+$/.test(String(asset.id || "")));
      if (!pasted) throw new Error(`no renamed-paste asset (today ${todaySlug}): ${JSON.stringify(assets.map((asset) => asset.id)).slice(0, 400)}`);
      if (pasted.group !== GROUP_NAME) throw new Error(`pasted asset group ${pasted.group}`);
      const unorganized = await ctx.api(origin, "GET", "/api/assets?project=default&limit=250&unorganized=1");
      if ((unorganized.assets || []).some((asset) => asset.id === pasted.id)) {
        throw new Error("pasted image showed up in 待整理");
      }
    });

    // ── 3) File into the open stack via the blank-area menu 粘贴 ──
    await step("blank-area menu 粘贴 imports a file into the open stack", async () => {
      await writeClipboardFiles([filePngB]);
      // Back to 所有素材, then open the stack with a real double click.
      await clickCenter(cdp, `document.querySelector('.nav-row[aria-label="所有素材"]')`);
      await waitFor(`[...document.querySelectorAll('.asset-card[aria-label]')].some((card) => card.getAttribute('aria-label').includes('堆叠'))`, "stack card visible");
      await dispatchDoubleClick(cdp, `[...document.querySelectorAll('.asset-card[aria-label]')].find((card) => card.getAttribute('aria-label').includes('堆叠'))`);
      await waitFor(`document.querySelector('.context-menu') === null`, "stack view settled");
      const membersBefore = (await stackMembers(origin, stack.stack.id, ctx.token)).length;
      await rightClickBlank(cdp);
      await waitFor(`Boolean(document.querySelector('.context-menu'))`, "stack blank menu open");
      const menuHasBack = await cdp.evaluate(`[...document.querySelectorAll('.context-menu button')].some((b) => b.textContent.includes('返回素材库'))`);
      if (!menuHasBack) throw new Error("stack blank menu missing 返回素材库 — not in a stack view");
      // The 粘贴 item patches in after the async clipboard query answers;
      // wait for it instead of racing the IPC roundtrip.
      await waitFor(`[...document.querySelectorAll('.context-menu button')].some((b) => b.textContent.trim() === '粘贴')`, "stack blank menu 粘贴 item", 4000);
      await clickCenter(cdp, `[...document.querySelectorAll('.context-menu button')].find((b) => b.textContent.trim() === '粘贴')`);
      const deadline = Date.now() + 20000;
      let members = [];
      while (Date.now() < deadline) {
        members = await stackMembers(origin, stack.stack.id, ctx.token);
        if (members.length > membersBefore) break;
        await sleep(200);
      }
      if (members.length <= membersBefore) throw new Error(`stack member count stayed ${members.length}`);
    });

    // ── 4) Focus in the search field: no import ──
    await step("paste with the search field focused imports nothing", async () => {
      await clickCenter(cdp, `document.querySelector('.nav-row[aria-label="所有素材"]')`);
      await waitFor(`document.querySelector('.search input')`, "back in the library");
      await writeClipboardImage(filePngA);
      const before = (await total()).length;
      await clickCenter(cdp, `document.querySelector('.search input')`);
      await waitFor(`document.activeElement === document.querySelector('.search input')`, "search focused");
      await dispatchPasteCommand(cdp);
      await sleep(1500);
      const after = (await total()).length;
      if (after !== before) throw new Error(`search-focused paste imported: ${before} -> ${after}`);
    });

    // ── 5) Paste inside 收藏: imports, stays unfavorited, points at 所有素材 ──
    await step("paste in 收藏 imports without favoriting and points at 所有素材", async () => {
      await writeClipboardFiles([filePngC]);
      const before = (await total()).length;
      await clickCenter(cdp, `document.querySelector('.nav-row[aria-label="收藏"]')`);
      await waitFor(`document.querySelector('.nav-row[aria-current="page"]')?.getAttribute('aria-label') === '收藏'`, "favorites view active");
      await dispatchPasteCommand(cdp);
      const assets = await waitForTotal(before + 1, "favorites paste imported");
      const pasted = assets.find((asset) =>
        [asset.id, asset.name, asset.image_path].some((value) => String(value || "").includes("desktop-paste-gamma")));
      if (!pasted) throw new Error("pasted asset missing after favorites paste");
      if (pasted.favorite) throw new Error("pasted asset was favorited");
      await waitForToast("所有素材", "hidden-view pointer");
    });

    // ── 6) A library file pasted back is skipped ──
    await step("pasting a library file back is skipped with the already-in-library toast", async () => {
      const result = await cdp.send("Runtime.evaluate", {
        expression: `window.electronAPI.writeClipboardFiles(${JSON.stringify([libraryFilePath])}).then((value) => JSON.stringify(value))`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (typeof result !== "string" || !result.includes('"ok":true')) {
        throw new Error(`writeClipboardFiles result ${JSON.stringify(result)}`);
      }
      const before = (await total()).length;
      await clickCenter(cdp, `document.querySelector('.nav-row[aria-label="所有素材"]')`);
      await waitFor(`document.querySelector('.nav-row[aria-current="page"]')?.getAttribute('aria-label') === '所有素材'`, "library view active");
      await dispatchPasteCommand(cdp);
      await waitForToast("已在素材库中", "already-in-library toast");
      await sleep(800);
      const after = (await total()).length;
      if (after !== before) throw new Error(`library file was imported again: ${before} -> ${after}`);
    });

    // ── 7) Text-only clipboard: the blank-area menu has no 粘贴 ──
    // The 粘贴 entry patches into an open menu after the async
    // clipboard-importable IPC answers, so counting the moment the menu opens
    // judges nothing — wait past the patch window first (task 245).
    const menuPasteCount = async () => cdp.evaluate(
      `[...document.querySelectorAll('.context-menu button')].filter((b) => b.textContent.trim() === '粘贴').length`,
    );
    const closeMenu = async (label) => {
      await pressEscape(cdp);
      await waitFor(`!document.querySelector('.context-menu')`, `${label} menu closed`);
    };
    await step("text-only clipboard: the blank-area menu offers no 粘贴", async () => {
      await writeClipboardText("just text, nothing to import");
      await rightClickBlank(cdp);
      await waitFor(`Boolean(document.querySelector('.context-menu'))`, "blank menu open");
      await sleep(800);
      const pasteItems = await menuPasteCount();
      if (pasteItems !== 0) throw new Error(`blank menu offered ${pasteItems} 粘贴 entries for a text clipboard`);
      await closeMenu("text-only");
    });

    // ── 8-10) Finder-style file copies (task 245, darwin only) ──
    // A Finder copy always carries the file's icon as a TIFF, so readImage()
    // is non-empty for EVERY file copy: these steps pin that the blank-area
    // 粘贴 judges by the files' extensions, not by that image. The Windows
    // clipboard writer cannot express a files+icon copy (Set-Clipboard -Path
    // has no icon), so the steps only run on macOS.
    if (process.platform === "darwin") {
      const weblocPath = join(ctx.fixturesDir, "链接 & 测试.webloc");
      await writeFile(weblocPath, [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0"><dict><key>URL</key><string>https://example.com/e2e</string></dict></plist>',
        "",
      ].join("\n"), "utf8");
      const notesPath = join(ctx.fixturesDir, "notes.txt");
      await writeFile(notesPath, "plain text, nothing to import\n", "utf8");
      const mediaPath = await makePng("desktop-paste-x.png", [10, 200, 200]);

      const assertNoPasteInMenu = async (label) => {
        await rightClickBlank(cdp);
        await waitFor(`Boolean(document.querySelector('.context-menu'))`, `${label} menu open`);
        await sleep(800);
        const pasteItems = await menuPasteCount();
        if (pasteItems !== 0) throw new Error(`${label}: blank menu offered 粘贴 for a media-less file copy`);
        await closeMenu(label);
      };

      await step("webloc-only Finder copy (with icon) offers no 粘贴", async () => {
        await writeClipboardFilesWithIcon([weblocPath]);
        await assertNoPasteInMenu("webloc");
      });

      await step("notes.txt Finder copy (with icon) offers no 粘贴", async () => {
        await writeClipboardFilesWithIcon([notesPath]);
        await assertNoPasteInMenu("notes");
      });

      await step("notes.txt + png Finder copy imports only the png via 粘贴", async () => {
        await writeClipboardFilesWithIcon([notesPath, mediaPath]);
        const before = (await total()).length;
        await rightClickBlank(cdp);
        await waitFor(`Boolean(document.querySelector('.context-menu'))`, "mixed-copy menu open");
        await waitFor(
          `[...document.querySelectorAll('.context-menu button')].some((b) => b.textContent.trim() === '粘贴')`,
          "mixed-copy menu 粘贴 item",
          4000,
        );
        await clickCenter(cdp, `[...document.querySelectorAll('.context-menu button')].find((b) => b.textContent.trim() === '粘贴')`);
        const probe = await pasteProbe();
        await waitForTotal(before + 1, "mixed-copy paste imported one asset");
        await sleep(800); // let any duplicate import land before counting
        const assets = await total();
        if (assets.length !== before + 1) {
          throw new Error(`mixed copy imported ${assets.length - before} assets (probe: ${JSON.stringify(probe)})`);
        }
        const imported = assets.filter((asset) =>
          [asset.id, asset.name, asset.image_path].some((value) => String(value || "").includes("desktop-paste-x")));
        if (imported.length !== 1) throw new Error(`desktop-paste-x import count ${imported.length}`);
        const notes = assets.filter((asset) =>
          [asset.id, asset.name, asset.image_path].some((value) => String(value || "").includes("notes")));
        if (notes.length) throw new Error("notes.txt was imported");
      });
    } else {
      console.log("[desktop-paste-import] skip task-245 steps: Finder-style files+icon clipboard copies are darwin-only (Windows Set-Clipboard cannot carry icons)");
    }

    if (failures.length) throw new Error(`${failures.length} desktop-paste-import step(s) failed:\n- ${failures.join("\n- ")}`);
    return { seeded: SEED_COUNT, steps: "all passed" };
  } catch (error) {
    const log = await readFile(logFile, "utf8").catch(() => "");
    throw new Error(`${error.message}${log ? `\n[desktop-paste-import] main.log tail:\n${log.slice(-2000)}` : ""}`, { cause: error });
  } finally {
    try { clearClipboard(); } catch {}
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

// ── System clipboard writers (macOS JXA / Windows PowerShell) ──────────────
// Windows' clipboard service occasionally refuses a write; one short retry
// rides that out (desktop-input / task 223).

function runClipboardCommand(command, args) {
  try {
    execFileSync(command, args, { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

function runClipboardOutput(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function withRetry(write) {
  if (write()) return;
  sleepSync(300);
  if (write()) return;
  throw new Error("system clipboard write failed twice");
}

function sleepSync(ms) {
  execFileSync(process.execPath, ["-e", `setTimeout(() => {}, ${ms})`]);
}

function writeClipboardFiles(paths) {
  withRetry(() => {
    if (process.platform === "darwin") {
      // The multi-file write goes through Swift: the JXA ObjC bridge drops
      // pasteboard items when writing several NSURLs (observed 1-2 of 3
      // surviving, depending on path), while Swift's writeObjects lands every
      // item. The single-item image/text writers below stay on osascript.
      execFileSync("swift", ["-", ...paths], {
        input: `import AppKit
let pb = NSPasteboard.general
pb.clearContents()
let urls: [NSURL] = CommandLine.arguments.dropFirst().map { NSURL(fileURLWithPath: $0) }
let back = pb.writeObjects(urls) ? pb.readObjects(forClasses: [NSURL.self], options: nil) as! [NSURL] : []
if back.count != urls.count {
  FileHandle.standardError.write("pasteboard holds \\(back.count) of \\(urls.count) files".data(using: .utf8)!)
  exit(1)
}
`,
        encoding: "utf8",
      });
      return true;
    }
    return runClipboardCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command",
      `Set-Clipboard -LiteralPath @(${paths.map((path) => `'${path.replace(/'/g, "''")}'`).join(",")})`]);
  });
}

// A Finder copy of files: every file's NSURL plus its icon as TIFF (task 245).
// The icon is what made readImage() non-empty for every file copy and masked
// the importable judgment. No filenames plist is written by hand — AppKit
// refuses PasteboardType("NSFilenamesPboardType") as an invalid UTI, but
// synthesizes that exact plist for legacy readers (Electron's clipboard.read)
// from the file-url items, which the Electron reader probe confirmed.
function writeClipboardFilesWithIcon(paths) {
  withRetry(() => {
    if (process.platform !== "darwin") throw new Error("files-with-icon clipboard write is darwin-only");
    execFileSync("swift", ["-", ...paths], {
      input: `import AppKit
let pb = NSPasteboard.general
pb.clearContents()
let paths = Array(CommandLine.arguments.dropFirst())
var items: [NSPasteboardItem] = []
for path in paths {
  let item = NSPasteboardItem()
  if !item.setString(NSURL(fileURLWithPath: path).absoluteString ?? "", forType: .fileURL) { exit(2) }
  guard let tiff = NSWorkspace.shared.icon(forFile: path).tiffRepresentation,
        item.setData(tiff, forType: .tiff) else { exit(3) }
  items.append(item)
}
pb.writeObjects(items)
let back = (pb.pasteboardItems ?? []).compactMap { $0.string(forType: .fileURL) }
let tiff = pb.data(forType: .tiff)
if back.count != paths.count || tiff == nil {
  FileHandle.standardError.write("pasteboard holds \\(back.count) of \\(paths.count) file urls, tiff \\(tiff?.count ?? 0) bytes".data(using: .utf8)!)
  exit(1)
}
`,
      encoding: "utf8",
    });
    return true;
  });
}

function writeClipboardImage(pngPath) {
  withRetry(() => {
    if (process.platform === "darwin") {
      return runClipboardCommand("osascript", ["-l", "JavaScript", "-e", `
        ObjC.import("AppKit");
        const pb = $.NSPasteboard.generalPasteboard;
        pb.clearContents;
        const data = $.NSData.dataWithContentsOfFile($(${JSON.stringify(pngPath)}));
        pb.setDataForType(data, $("public.png")) ? "ok" : null;
      `]);
    }
    return runClipboardCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command",
      `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; ` +
      `$img = [System.Drawing.Image]::FromFile('${pngPath.replace(/'/g, "''")}'); ` +
      `[System.Windows.Forms.Clipboard]::SetImage($img)`]);
  });
}

function writeClipboardText(text) {
  withRetry(() => {
    if (process.platform === "darwin") {
      return runClipboardCommand("osascript", ["-l", "JavaScript", "-e", `
        ObjC.import("AppKit");
        const pb = $.NSPasteboard.generalPasteboard;
        pb.clearContents;
        pb.setStringForType($(${JSON.stringify(text)}), $("public.utf8-plain-text")) ? "ok" : null;
      `]);
    }
    return runClipboardCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command",
      `Set-Clipboard -Value '${text.replace(/'/g, "''")}'`]);
  });
}

function clearClipboard() {
  if (process.platform === "darwin") {
    runClipboardCommand("osascript", ["-l", "JavaScript", "-e",
      'ObjC.import("AppKit"); $.NSPasteboard.generalPasteboard.clearContents; "ok"']);
    return;
  }
  if (process.platform === "win32") {
    runClipboardCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear()"]);
  }
}

// ── Desktop shell helpers (desktop-input.mjs pattern) ──────────────────────

async function stackMembers(origin, stackId, token) {
  const detail = await fetch(`${origin}/api/asset-stacks/${encodeURIComponent(stackId)}/assets?project=default`, {
    headers: { "x-mosa-client-token": token },
  }).then((response) => (response.ok ? response.json() : null)).catch(() => null);
  return detail?.assets || [];
}

async function clickCenter(cdp, elementExpression) {
  const point = await cdp.evaluate(`(() => {
    const el = ${elementExpression};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!point) throw new Error(`element not found: ${elementExpression.slice(0, 80)}`);
  await dispatchClick(cdp, point.x, point.y);
}

async function dispatchClick(cdp, x, y, { button = "left", clickCount = 1 } = {}) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, pointerType: "mouse" });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x, y, button, buttons: button === "right" ? 2 : 1, clickCount, pointerType: "mouse",
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x, y, button, buttons: 0, clickCount, pointerType: "mouse",
  });
}

async function dispatchDoubleClick(cdp, elementExpression) {
  const point = await cdp.evaluate(`(() => {
    const el = ${elementExpression};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!point) throw new Error("double-click target missing");
  for (const clickCount of [1, 2]) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount, pointerType: "mouse" });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount, pointerType: "mouse" });
  }
}

// Right-click a point of the asset grid that no card covers: the blank ground
// the blank-area menu lives on.
async function rightClickBlank(cdp) {
  const point = await cdp.evaluate(`(() => {
    const grid = document.querySelector(".asset-grid");
    if (!grid) return null;
    const rect = grid.getBoundingClientRect();
    const cards = [...document.querySelectorAll(".asset-card")].map((card) => card.getBoundingClientRect());
    const hits = (x, y) => cards.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
    for (let dy = 30; dy < rect.height - 10; dy += 40) {
      const x = rect.right - 40;
      const y = rect.top + dy;
      if (y < rect.bottom - 10 && !hits(x, y)) return { x, y };
    }
    return { x: rect.right - 40, y: rect.bottom - 20 };
  })()`);
  if (!point) throw new Error("asset grid missing for the blank right-click");
  await dispatchClick(cdp, point.x, point.y, { button: "right" });
}

// ⌘V / Ctrl+V as a real paste: CDP cannot go through the native menu
// accelerator, so macOS carries the editing command on the keyDown
// (commands:["paste"], the CDP-blessed way to produce a trusted paste) and
// Windows sends the plain Ctrl+V key sequence, whose default action pastes.
async function dispatchPasteCommand(cdp) {
  if (process.platform === "darwin") {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 4, commands: ["paste"],
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 4,
    });
    return;
  }
  // keyDown + keyUp only: a rawKeyDown before the keyDown makes Chromium run
  // the paste command twice and the batch imports two copies of everything.
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 2, text: "v" });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 2 });
}

async function pressEscape(cdp) {
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
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
