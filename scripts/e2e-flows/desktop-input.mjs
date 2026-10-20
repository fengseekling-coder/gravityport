// GravityPort desktop-window input flow (task 127): launches the REAL desktop
// shell (desktop/main.mjs with preload) and drives the UI exclusively through
// CDP Input.dispatchMouseEvent / dispatchKeyEvent — trusted browser input that
// goes through Chromium's hit-testing, not element.click(). This is the layer
// the web-driver flows (plain Electron window, no desktop chain) never cover:
// preload wiring, the brandbar safe area, the real toolbar layout.
//
// What this flow deliberately cannot see: a window-server drag region that
// eats OS-level input before Chromium (the task-127 startup.html regression).
// CDP input bypasses that layer, so the guard for it lives in
// test/desktop-shell-contract.test.mjs plus the OS-level
// scripts/packaged-input-smoke.mjs check.
import { createServer } from "node:http";
import { readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopGui } from "../desktop-gui-launcher.mjs";
import { ensureElectronExecutablePath } from "../desktop-runtime-paths.mjs";

export const name = "desktop-input";
export const description = "real desktop window: trusted CDP input drives nav/cards/viewer/search/sort/settings/scroll/context-menu/keyboard; 56px top strip, no simulated traffic lights";

const SEED_COUNT = 60;

export async function run(ctx) {
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
    const seededIds = await seedAssets(ctx, port);
    cdp = await connectCdp(cdpPort, `http://127.0.0.1:${port}`);
    await cdp.evaluate(`(() => {
      window.__inputLog = [];
      for (const type of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "keydown", "wheel", "contextmenu"]) {
        document.addEventListener(type, (event) => {
          window.__inputLog.push({ type, trusted: event.isTrusted });
        }, true);
      }
      return "probe installed";
    })()`);

    const failures = [];
    const step = async (label, fn) => {
      try {
        await fn();
        console.log(`[desktop-input] ok: ${label}`);
      } catch (error) {
        failures.push(`${label}: ${error.message}`);
        console.error(`[desktop-input] FAIL: ${label}: ${error.message}`);
      }
    };
    // Wraps a step so it fails unless at least one trusted input event reached
    // the DOM while it ran — the point of this flow is real input, and a
    // silently-dead input path must not pass by way of some fallback.
    const trusted = (fn) => async () => {
      const before = await cdp.evaluate(`window.__inputLog.filter((e) => e.trusted).length`);
      await fn();
      await sleep(250);
      const after = await cdp.evaluate(`window.__inputLog.filter((e) => e.trusted).length`);
      if (after <= before) throw new Error("no trusted input event reached the DOM during this step");
    };

    await step("top strip is 56px with no simulated traffic lights", async () => {
      const layout = await cdp.evaluate(`(() => {
        const rect = (selector) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { top: r.top, height: r.height };
        };
        return {
          traffic: document.querySelectorAll(".traffic").length,
          brandbar: rect(".brandbar"),
          toolbar: rect(".toolbar"),
          detail: rect(".detail-heading"),
        };
      })()`);
      if (layout.traffic !== 0) throw new Error(`simulated traffic lights present: ${layout.traffic}`);
      if (!layout.brandbar || !layout.toolbar) throw new Error(`layout missing: ${JSON.stringify(layout)}`);
      if (Math.round(layout.brandbar.height) !== 56 || Math.round(layout.brandbar.top) !== 0) {
        throw new Error(`brandbar ${JSON.stringify(layout.brandbar)}`);
      }
      if (Math.round(layout.toolbar.height) !== 56 || Math.round(layout.toolbar.top) !== 0) {
        throw new Error(`toolbar ${JSON.stringify(layout.toolbar)}`);
      }
      if (layout.detail && (Math.round(layout.detail.height) !== 56 || Math.round(layout.detail.top) !== 0)) {
        throw new Error(`detail-heading ${JSON.stringify(layout.detail)}`);
      }
    });

    await step("sidebar overflow (40 groups) must not squash the brandbar", async () => {
      // Real libraries have long sidebars; a flex column without scroll
      // protection squeezes the brandbar down to its 16px text (task 127 on
      // the production library), which shoves the nav under the native
      // traffic lights. Force the overflow and re-assert the 56px strip.
      for (let index = 0; index < 40; index += 1) {
        const name = `desktop-input-group-${index}`;
        await ctx.api(origin, "POST", "/api/groups", { projectId: "default", name });
        await ctx.api(origin, "POST", "/api/assets/batch", {
          action: "group", projectId: "default", assetIds: [seededIds[index % seededIds.length]], group: name,
        });
      }
      // The new groups reach the sidebar through the live refresh; a fixed
      // 500ms pause sometimes measured before they rendered (macOS CI).
      await waitFor(cdp, `document.querySelector(".sidebar").scrollHeight > document.querySelector(".sidebar").clientHeight`, "sidebar overflow from 40 groups");
      const layout = await cdp.evaluate(`(() => {
        const el = document.querySelector(".brandbar");
        const r = el.getBoundingClientRect();
        return { top: r.top, height: r.height, sidebarScroll: document.querySelector(".sidebar").scrollHeight > document.querySelector(".sidebar").clientHeight };
      })()`);
      if (Math.round(layout.height) !== 56 || Math.round(layout.top) !== 0) {
        throw new Error(`brandbar squashed under sidebar overflow: ${JSON.stringify(layout)}`);
      }
      if (!layout.sidebarScroll) throw new Error("sidebar did not overflow; the fixture no longer reproduces the squeeze");
    });

    await step("trusted click switches nav to 收藏 and back to 所有素材", trusted(async () => {
      await clickCenter(cdp, `document.querySelector('.nav-row[aria-label="收藏"]')`);
      await waitFor(cdp, `document.querySelector('.nav-row[aria-current="page"]')?.getAttribute('aria-label') === '收藏'`, "nav 收藏 active");
      await clickCenter(cdp, `document.querySelector('.nav-row[aria-label="所有素材"]')`);
      await waitFor(cdp, `document.querySelector('.nav-row[aria-current="page"]')?.getAttribute('aria-label') === '所有素材'`, "nav 所有素材 active");
    }));

    await step("trusted click selects a card and updates the inspector", trusted(async () => {
      const info = await cdp.evaluate(`(() => {
        const card = document.querySelector(".asset-card");
        if (!card) return null;
        const r = card.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (!info) throw new Error("no asset card rendered");
      await dispatchClick(cdp, info.x, info.y);
      await waitFor(cdp, `document.querySelectorAll(".asset-card.asset-selected").length === 1`, "card selected");
      await waitFor(cdp, `Boolean(document.querySelector(".detail-heading"))`, "inspector heading visible");
    }));

    await step("trusted double click opens the preview and Escape closes it", trusted(async () => {
      await dispatchDoubleClick(cdp);
      await waitFor(cdp, `document.querySelector(".workspace")?.classList.contains("preview-open")`, "preview open");
      await pressEscape(cdp);
      await waitFor(cdp, `!document.querySelector(".workspace")?.classList.contains("preview-open")`, "preview closed");
    }));

    await step("trusted click focuses search and keyboard types into it", trusted(async () => {
      await clickCenter(cdp, `document.querySelector(".search input")`);
      await waitFor(cdp, `document.activeElement === document.querySelector(".search input")`, "search focused");
      for (const char of "g1") {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: char, text: char });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: char });
      }
      await waitFor(cdp, `document.querySelector(".search input").value === "g1"`, "search value g1");
      for (let i = 0; i < 2; i += 1) {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
      }
      await waitFor(cdp, `document.querySelector(".search input").value === ""`, "search cleared");
    }));

    await step("trusted click opens the sort menu and selects an option", trusted(async () => {
      await clickCenter(cdp, `document.querySelector('.toolbar-select[aria-haspopup="listbox"]')`);
      await waitFor(cdp, `Boolean(document.querySelector(".toolbar-select-menu"))`, "sort menu open");
      await clickCenter(cdp, `document.querySelector(".toolbar-select-option")`);
      await waitFor(cdp, `!document.querySelector(".toolbar-select-menu")`, "sort menu closed");
    }));

    await step("trusted click opens settings and Escape closes them", trusted(async () => {
      // The overflow sidebar pushes the user entry below the fold; scroll it
      // into view like a real user would.
      await cdp.evaluate(`(() => { const sidebar = document.querySelector(".sidebar"); sidebar.scrollTop = sidebar.scrollHeight; return sidebar.scrollTop; })()`);
      await sleep(200);
      await clickCenter(cdp, `document.querySelector(".user-button")`);
      await waitFor(cdp, `Boolean(document.querySelector(".settings-modal"))`, "settings open");
      await pressEscape(cdp);
      await waitFor(cdp, `!document.querySelector(".settings-modal")`, "settings closed");
    }));

    await step("mouse wheel scrolls the gallery", async () => {
      const center = await cdp.evaluate(`(() => {
        const grid = document.querySelector(".asset-grid");
        const r = grid.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: Math.min(r.y + r.height / 2, innerHeight - 40) };
      })()`);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: center.x, y: center.y, pointerType: "mouse" });
      for (let tick = 0; tick < 3; tick += 1) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: center.x, y: center.y, deltaX: 0, deltaY: 400, pointerType: "mouse" });
        await sleep(120);
      }
      await sleep(300);
      const scrolled = await cdp.evaluate(`(() => {
        const grid = document.querySelector(".asset-grid");
        return { scrollTop: grid.scrollTop, scrollHeight: grid.scrollHeight, clientHeight: grid.clientHeight };
      })()`);
      if (!(scrolled.scrollTop > 0)) throw new Error(`gallery did not scroll: ${JSON.stringify(scrolled)}`);
    });

    await step("right click opens the context menu and Escape closes it", trusted(async () => {
      const card = await cdp.evaluate(`(() => {
        const cards = [...document.querySelectorAll(".asset-card")];
        const el = cards.find((c) => { const r = c.getBoundingClientRect(); return r.top > 60 && r.bottom < innerHeight - 20; });
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (!card) throw new Error("no on-screen card to right-click");
      await dispatchClick(cdp, card.x, card.y, { button: "right" });
      await waitFor(cdp, `Boolean(document.querySelector(".context-menu"))`, "context menu open");
      await pressEscape(cdp);
      await waitFor(cdp, `!document.querySelector(".context-menu")`, "context menu closed");
    }));

    await step("trusted Tab moves keyboard focus", trusted(async () => {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await sleep(150);
      const focused = await cdp.evaluate(`document.activeElement ? document.activeElement.tagName : "none"`);
      if (focused === "BODY" || focused === "none") throw new Error(`focus stayed on ${focused}`);
    }));

    if (failures.length) throw new Error(`${failures.length} desktop-input step(s) failed:\n- ${failures.join("\n- ")}`);
    return { seeded: SEED_COUNT, steps: "all passed" };
  } catch (error) {
    const log = await readFile(logFile, "utf8").catch(() => "");
    throw new Error(`${error.message}${log ? `\n[desktop-input] main.log tail:\n${log.slice(-2000)}` : ""}`, { cause: error });
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

async function seedAssets(ctx, port) {
  const origin = `http://127.0.0.1:${port}`;
  const seededIds = [];
  for (let index = 0; index < SEED_COUNT; index += 1) {
    const tint = [(index * 37) % 256, (index * 71 + 30) % 256, (index * 113 + 90) % 256];
    const imagePath = await ctx.makePng(`desktop-input-${index}.png`, tint);
    const bytes = await readFile(imagePath);
    const staged = await fetch(`${origin}/api/import/stage`, {
      method: "POST",
      headers: {
        "content-type": "image/png",
        "x-mosa-file-name": encodeURIComponent(`desktop-input-${index}.png`),
        "x-mosa-client-token": ctx.token,
      },
      body: bytes,
    });
    if (!staged.ok) throw new Error(`import stage failed (${staged.status}) for seed ${index}`);
    const { path } = await staged.json();
    const created = await ctx.api(origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath: path,
      prompt: `desktop-input seed ${index}`,
    });
    if (!created?.asset?.id) throw new Error(`asset create failed for seed ${index}`);
    seededIds.push(created.asset.id);
  }
  // Give the derivative worker a moment so the grid has real thumbnails.
  await sleep(1500);
  return seededIds;
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

async function clickCenter(cdp, elementExpression) {
  const point = await centerOf(cdp, elementExpression);
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

async function dispatchDoubleClick(cdp) {
  const point = await centerOf(cdp, `document.querySelector(".asset-card.asset-selected") || document.querySelector(".asset-card")`);
  for (const clickCount of [1, 2]) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount, pointerType: "mouse" });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount, pointerType: "mouse" });
  }
}

async function pressEscape(cdp) {
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
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
    bodyClass: document.body.className,
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
