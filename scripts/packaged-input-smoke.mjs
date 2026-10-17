#!/usr/bin/env node
// Task 127: OS-level input smoke against the packaged macOS app.
//
// CDP Input.dispatchMouseEvent bypasses the macOS window server, so it cannot
// see the task-127 failure mode (a stale full-window drag region eats every
// real mouse press/wheel before Chromium; the page renders, CDP input works,
// JS clicks work). This script closes that gap: it drives the packaged app
// with REAL CGEvent mouse clicks and scroll wheels posted at the HID tap, then
// verifies through CDP that trusted events reached the DOM and that the UI
// actually changed. If this passes, a human with a real mouse can click.
//
// Requirements: macOS, a packaged build in out/ (npm run desktop:package), and
// Accessibility permission for the calling terminal (CGEvent posting). Without
// accessibility the script fails with instructions instead of faking a pass.
//
// All renderer interaction (readiness, seeding, assertions) goes through the
// CDP page target — the same origin the app itself uses, so no request leaves
// the app's own authenticated context. Runs fully against an isolated QA
// library; the production library is never touched.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { packagedExecutablePath } from "./desktop-runtime-paths.mjs";
import { signalProcessTree } from "./process-tree.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

let child = null;
let mainLog = "";

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("packaged-input-smoke is macOS-only (real CGEvent input).");
  }
  const binary = packagedExecutablePath({ rootDir, outDir: resolve(rootDir, process.env.MOSA_FORGE_OUT_DIR || "out") });
  if (!existsSync(binary)) throw new Error(`Missing packaged binary: ${binary}`);

  const temp = await mkdtemp(join(tmpdir(), "mosa-input-smoke-"));
  const helperBin = await buildHelper(join(temp, "helper"));
  const libraryDir = join(temp, "library");
  const userData = join(temp, "user-data");
  await mkdir(libraryDir, { recursive: true });
  await mkdir(userData, { recursive: true });

  const port = await freePort();
  // The OS can re-hand the just-closed ephemeral port to the next freePort()
  // call; the service and the DevTools endpoint must not collide.
  let cdpPort = await freePort();
  while (cdpPort === port) cdpPort = await freePort();
  child = spawn(binary, [
    `--user-data-dir=${userData}`,
    `--remote-debugging-port=${cdpPort}`,
  ], {
    env: {
      ...process.env,
      MOSA_RUNTIME_MODE: "qa",
      MOSA_LIBRARY_DIR: libraryDir,
      MOSA_DESKTOP_PORT: String(port),
      MOSA_USER_DATA: userData,
      MOSA_QA_RUN: "1",
      MOSA_DISABLE_BRIDGES: "cowart,cowartDiscovery,codex,grok",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { mainLog += chunk; });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { mainLog += chunk; });

  try {
    console.log(`[input-smoke] service port=${port} cdp=${cdpPort}`);
    const origin = `http://127.0.0.1:${port}`;
    const session = await connectCdp(cdpPort, origin);
    const seeded = await seedInPage(session, 45);
    console.log(`[input-smoke] seeded ${seeded} assets in page`);

    const ready = await session.evaluate(`(() => ({
      app: Boolean(document.querySelector(".app")),
      navs: [...document.querySelectorAll(".nav-row")].map((n) => n.getAttribute("aria-label")),
      cards: document.querySelectorAll(".asset-card").length,
    }))()`);
    if (!ready.app || !ready.cards) throw new Error(`renderer not ready: ${JSON.stringify(ready)}`);
    for (const label of ["所有素材", "收藏"]) {
      if (!ready.navs.includes(label)) throw new Error(`nav ${label} missing (got ${JSON.stringify(ready.navs)})`);
    }
    // The grid must overflow so the wheel check has something to scroll.
    const grid = await session.evaluate(`(() => {
      const el = document.querySelector(".asset-grid");
      return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    })()`);
    if (grid.scrollHeight <= grid.clientHeight) throw new Error(`gallery does not overflow: ${JSON.stringify(grid)}`);

    const windowBounds = JSON.parse(execFileSync(helperBin, ["bounds", String(child.pid)], { encoding: "utf8" }));
    console.log(`[input-smoke] window ${JSON.stringify(windowBounds)}`);
    const checks = [];

    // 1. Real click on 收藏 switches the active nav filter.
    await session.evaluate(`(() => { window.__events = []; for (const t of ["mousedown", "click"]) document.addEventListener(t, (e) => window.__events.push({ type: t, trusted: e.isTrusted }), true); return "ok"; })()`);
    const fav = await session.evaluate(`(() => {
      const r = document.querySelector('.nav-row[aria-label="收藏"]').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    execFileSync(helperBin, ["click", String(child.pid), String(fav.x), String(fav.y)], { stdio: ["ignore", "pipe", "pipe"] });
    await sleep(800);
    const navAfter = await session.evaluate(`(() => ({
      active: document.querySelector('.nav-row[aria-current="page"]')?.getAttribute("aria-label") || "none",
      trustedEvents: (window.__events || []).filter((e) => e.trusted).length,
    }))()`);
    checks.push({ name: "real click switches nav to 收藏", pass: navAfter.active === "收藏" && navAfter.trustedEvents >= 2, evidence: navAfter });
    if (navAfter.active !== "收藏") throw new Error(`real click did not switch nav: ${JSON.stringify(navAfter)}\nIf trustedEvents is 0, real mouse events are being eaten before the DOM — the task-127 regression signature.`);

    // 2. Real click on a card selects it.
    await session.evaluate(`(() => { window.__events = []; document.addEventListener("click", (e) => window.__events.push({ type: "click", trusted: e.isTrusted }), true); return "ok"; })()`);
    await session.evaluate(`document.querySelector('.nav-row[aria-label="所有素材"]')?.click(); "back"`);
    await sleep(600);
    const card = await session.evaluate(`(() => {
      const el = document.querySelector(".asset-card");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!card) throw new Error("no card to click");
    execFileSync(helperBin, ["click", String(child.pid), String(card.x), String(card.y)], { stdio: ["ignore", "pipe", "pipe"] });
    await sleep(800);
    const cardAfter = await session.evaluate(`(() => ({
      selected: document.querySelectorAll(".asset-card.asset-selected").length,
      trustedEvents: (window.__events || []).filter((e) => e.trusted).length,
    }))()`);
    checks.push({ name: "real click selects a card", pass: cardAfter.selected >= 1 && cardAfter.trustedEvents >= 1, evidence: cardAfter });
    if (cardAfter.selected < 1) throw new Error(`real card click did not select: ${JSON.stringify(cardAfter)}`);

    // 3. Real scroll wheel scrolls the gallery.
    const gridCenter = await session.evaluate(`(() => {
      const r = document.querySelector(".asset-grid").getBoundingClientRect();
      return { x: r.x + r.width / 2, y: Math.min(r.y + r.height / 2, innerHeight - 40) };
    })()`);
    execFileSync(helperBin, ["scroll", String(child.pid), String(gridCenter.x), String(gridCenter.y), "6"], { stdio: ["ignore", "pipe", "pipe"] });
    await sleep(800);
    const scrolled = await session.evaluate(`(() => {
      const el = document.querySelector(".asset-grid");
      return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    })()`);
    checks.push({ name: "real wheel scrolls the gallery", pass: scrolled.scrollTop > 0 && scrolled.scrollHeight > scrolled.clientHeight, evidence: scrolled });
    if (!(scrolled.scrollTop > 0)) throw new Error(`real wheel did not scroll: ${JSON.stringify(scrolled)}`);

    // 4. Real click on a toolbar control still lands inside the drag row.
    const sort = await session.evaluate(`(() => {
      const r = document.querySelector('.toolbar .toolbar-select[aria-label="排序"]').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    execFileSync(helperBin, ["click", String(child.pid), String(sort.x), String(sort.y)], { stdio: ["ignore", "pipe", "pipe"] });
    await sleep(800);
    const sortAfter = await session.evaluate(`Boolean(document.querySelector(".toolbar-select-menu"))`);
    checks.push({ name: "real click opens a toolbar menu", pass: sortAfter, evidence: { menuOpen: sortAfter } });
    if (!sortAfter) throw new Error("real click on the toolbar sort control did not open its menu — the drag row is eating control clicks");
    await session.evaluate(`document.querySelector('.toolbar .toolbar-select[aria-label="排序"]').click(); "closed"`);
    await sleep(400);

    // 5. Real drag on the empty toolbar strip moves the window (the page
    // covers the hiddenInset titlebar, so this is the only way to move it).
    const strip = await session.evaluate(`(() => {
      const left = document.querySelector(".toolbar-left").getBoundingClientRect();
      const right = document.querySelector(".toolbar-right").getBoundingClientRect();
      const x = (left.right + right.left) / 2, y = left.y + left.height / 2;
      return { x, y, target: document.elementFromPoint(x, y)?.className || "" };
    })()`);
    if (strip.target !== "toolbar") throw new Error(`no empty toolbar strip to drag: ${JSON.stringify(strip)}`);
    const before = await session.evaluate(`({ x: window.screenX, y: window.screenY })`);
    execFileSync(helperBin, ["drag", String(child.pid), String(strip.x), String(strip.y), "120", "60"], { stdio: ["ignore", "pipe", "pipe"] });
    await sleep(800);
    const after = await session.evaluate(`({ x: window.screenX, y: window.screenY })`);
    const moved = { before, after };
    checks.push({ name: "real drag on the toolbar moves the window", pass: after.x - before.x >= 100 && after.y - before.y >= 40, evidence: moved });
    if (!(after.x - before.x >= 100 && after.y - before.y >= 40)) throw new Error(`real toolbar drag did not move the window: ${JSON.stringify(moved)}`);

    console.log(JSON.stringify({ ok: true, checks }, null, 2));
  } finally {
    if (child) await stopChild(child);
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => {});
  }
}

// Seeds assets from INSIDE the page: same-origin requests carrying the app's
// own browser-client context, which is the one network path this environment
// guarantees (a system-local interceptor rewrites this Node process's direct
// loopback requests to the packaged service, so seeding from Node is off the
// table here).
async function seedInPage(session, count) {
  const result = await session.evaluate(`(async () => {
    const token = String(window.sessionStorage?.getItem?.("mosa.client-token") || "");
    const headers = { "x-mosa-client-token": token };
    const colors = [[74, 127, 181], [181, 68, 74], [58, 138, 87], [138, 90, 47], [96, 74, 155]];
    const canvas = document.createElement("canvas");
    canvas.width = 48; canvas.height = 48;
    const ctx = canvas.getContext("2d");
    let created = 0;
    for (let index = 0; index < ${count}; index += 1) {
      const [r, g, b] = colors[index % colors.length];
      ctx.fillStyle = "rgb(" + r + "," + g + "," + b + ")";
      ctx.fillRect(0, 0, 48, 48);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const stage = await fetch("/api/import/stage", {
        method: "POST",
        headers: { ...headers, "content-type": "image/png", "x-mosa-file-name": encodeURIComponent("input-smoke-" + index + ".png") },
        body: blob,
      });
      if (!stage.ok) throw new Error("stage failed " + stage.status);
      const { path } = await stage.json();
      const create = await fetch("/api/assets/create", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ projectId: "default", imagePath: path, prompt: "input smoke " + index }),
      });
      if (!create.ok) throw new Error("create failed " + create.status);
      created += 1;
    }
    return created;
  })()`);
  // Give the grid a moment to pick the new assets up (SSE refresh).
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const cards = await session.evaluate(`document.querySelectorAll(".asset-card").length`);
    if (cards >= count) break;
    await sleep(400);
  }
  await sleep(800);
  return result;
}

async function buildHelper(helperDir) {
  await mkdir(helperDir, { recursive: true });
  const source = `
import AppKit
import CoreGraphics
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\\n").data(using: .utf8)!)
  exit(3)
}

guard AXIsProcessTrusted() else {
  fail("ACCESSIBILITY_REQUIRED: grant the calling terminal Accessibility permission (System Settings > Privacy & Security > Accessibility)")
}

let args = CommandLine.arguments
guard args.count >= 3, let pid = pid_t(args[2]) else {
  fail("usage: realinput bounds|click|scroll|drag <pid> [x y [ticks|dx dy]]")
}

func postClick(_ point: CGPoint) {
  for type in [CGEventType.leftMouseDown, CGEventType.leftMouseUp] {
    if let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left) {
      event.setIntegerValueField(.mouseEventClickState, value: 1)
      event.post(tap: .cghidEventTap)
    }
    usleep(80_000)
  }
}

func activateAndBounds(_ pid: pid_t) -> CGRect {
  if let app = NSRunningApplication(processIdentifier: pid) {
    for _ in 0..<3 {
      _ = app.activate(options: [.activateAllWindows])
      usleep(400_000)
      if app.isActive { break }
    }
    if !app.isActive {
      // An inactive window ignores the first click (no click-through), so
      // fire one activation click on a blank gallery area below the cards.
      let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
      for window in windows {
        guard window[kCGWindowOwnerPID as String] as? Int == Int(pid) else { continue }
        guard window[kCGWindowLayer as String] as? Int == 0 else { continue }
        guard let dict = window[kCGWindowBounds as String] as? [String: NSNumber] else { continue }
        let rect = CGRect(x: dict["X"]!.doubleValue, y: dict["Y"]!.doubleValue,
                          width: dict["Width"]!.doubleValue, height: dict["Height"]!.doubleValue)
        if rect.width > 200 && rect.height > 200 {
          postClick(CGPoint(x: rect.midX, y: rect.maxY - 90))
          usleep(400_000)
          break
        }
      }
    }
  }
  let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
  for window in info {
    guard window[kCGWindowOwnerPID as String] as? Int == Int(pid) else { continue }
    guard window[kCGWindowLayer as String] as? Int == 0 else { continue }
    guard let dict = window[kCGWindowBounds as String] as? [String: NSNumber] else { continue }
    let rect = CGRect(x: dict["X"]!.doubleValue, y: dict["Y"]!.doubleValue,
                      width: dict["Width"]!.doubleValue, height: dict["Height"]!.doubleValue)
    if rect.width > 200 && rect.height > 200 { return rect }
  }
  fail("NO_WINDOW for pid \\(pid)")
}

let bounds = activateAndBounds(pid)

switch args[1] {
case "bounds":
  let encoder = JSONEncoder()
  let data = try! encoder.encode(["pid": Int(pid), "x": Int(bounds.minX), "y": Int(bounds.minY), "width": Int(bounds.width), "height": Int(bounds.height)])
  print(String(data: data, encoding: .utf8)!)
case "click":
  guard args.count >= 5, let x = Double(args[3]), let y = Double(args[4]) else { fail("click needs x y") }
  let point = CGPoint(x: bounds.minX + CGFloat(x), y: bounds.minY + CGFloat(y))
  postClick(point)
  print("clicked \\(point)")
case "scroll":
  guard args.count >= 5, let x = Double(args[3]), let y = Double(args[4]) else { fail("scroll needs x y") }
  let ticks = args.count > 5 ? Int32(args[5]) ?? 3 : 3
  let point = CGPoint(x: bounds.minX + CGFloat(x), y: bounds.minY + CGFloat(y))
  for _ in 0..<max(1, ticks) {
    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: -3, wheel2: 0, wheel3: 0) else { fail("CGEvent scroll create failed") }
    event.location = point
    event.post(tap: .cghidEventTap)
    usleep(60_000)
  }
  print("scrolled \\(point)")
case "drag":
  guard args.count >= 7, let x = Double(args[3]), let y = Double(args[4]), let dx = Double(args[5]), let dy = Double(args[6]) else { fail("drag needs x y dx dy") }
  let start = CGPoint(x: bounds.minX + CGFloat(x), y: bounds.minY + CGFloat(y))
  CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left)?.post(tap: .cghidEventTap)
  usleep(120_000)
  var end = start
  for step in 1...12 {
    end = CGPoint(x: start.x + CGFloat(dx) * CGFloat(step) / 12, y: start.y + CGFloat(dy) * CGFloat(step) / 12)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: end, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(30_000)
  }
  CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left)?.post(tap: .cghidEventTap)
  print("dragged \\(start) -> \\(end)")
default:
  fail("unknown command \\(args[1])")
}
`;
  const sourcePath = join(helperDir, "realinput.swift");
  await writeFile(sourcePath, source);
  const bin = join(helperDir, "realinput");
  execFileSync("swiftc", ["-O", "-o", bin, sourcePath], { stdio: ["ignore", "pipe", "pipe"] });
  return bin;
}

function freePort() {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function connectCdp(cdpPort, expectedOrigin) {
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`packaged app exited early with ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      const targets = await response.json();
      const target = targets.find((entry) => entry.type === "page" && String(entry.url || "").startsWith(expectedOrigin));
      if (target?.webSocketDebuggerUrl) {
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolveOpen, rejectOpen) => {
          socket.addEventListener("open", resolveOpen, { once: true });
          socket.addEventListener("error", () => rejectOpen(new Error("cdp socket")), { once: true });
        });
        let idSeq = 0;
        const pending = new Map();
        socket.addEventListener("message", (event) => {
          const message = JSON.parse(String(event.data));
          if (message.id && pending.has(message.id)) {
            const { resolveCall, rejectCall } = pending.get(message.id);
            pending.delete(message.id);
            if (message.error) rejectCall(new Error(message.error.message));
            else if (message.result?.exceptionDetails) rejectCall(new Error(`evaluate failed: ${message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text} | expr=${lastExpression.slice(0, 80)}`));
            else resolveCall(message.result?.result?.value);
          }
        });
        let lastExpression = "";
        return {
          async send(method, params = {}) {
            const id = ++idSeq;
            return new Promise((resolveCall, rejectCall) => {
              pending.set(id, { resolveCall, rejectCall });
              socket.send(JSON.stringify({ id, method, params }));
            });
          },
          async evaluate(expression) {
            lastExpression = expression;
            return this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
          },
          close() {
            try { socket.close(); } catch {}
          },
        };
      }
    } catch {}
    await sleep(250);
  }
  throw new Error("CDP target timeout (renderer never loaded the app URL)");
}

async function stopChild(childProcess) {
  if (childProcess.exitCode !== null || childProcess.signalCode) return;
  const exited = new Promise((resolveExit) => childProcess.once("exit", resolveExit));
  await signalProcessTree(childProcess.pid);
  await Promise.race([exited, sleep(5000)]);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`[input-smoke] FAIL: ${error?.message || error}`);
    if (mainLog.trim()) console.error(`[input-smoke] packaged main log tail:\n${mainLog.slice(-2000).trim()}`);
    process.exit(1);
  });
