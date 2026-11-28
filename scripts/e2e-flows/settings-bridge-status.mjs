// GravityPort React UI flow (task 452): Settings → 连接 本机 AI 工具 card.
//
// This flow's own server keeps the Codex and Grok bridges ON (the default e2e
// environment disables all of them) with both data roots pointed at a temp
// directory; the Grok root is never created, so its row must read
// 未找到生图记录. A real PNG lands in the Codex images root and is imported
// through the running bridge. Then the images root goes chmod 000: the
// session watcher triggers a scan, the card must show 无法收录 plus the
// permission reason, the 复制详细信息 button's payload must carry EACCES
// (the clipboard write is captured through a window.electronAPI stub, so the
// real system clipboard is never touched), and light/dark screenshots of the
// error state are taken through CDP. Restoring the permission must flip the
// row back to 正在收录.
//
// Assertions run in a persistent hidden Electron window
// (scripts/e2e-flows/_bridge-status-window.mjs) driven over CDP: the flow
// needs to change files on disk between page checks, which the one-shot
// web driver cannot do, and the screenshots need Page.captureScreenshot.
// The desktop shell itself is not used because the macOS GUI launcher strips
// CODEX_* environment variables — a desktop round would scan the real
// ~/.codex, which this flow must never touch.
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { writeFlowArtifact } from "./_artifacts.mjs";
import { connectCdp, waitForCdpExpression } from "./_cdp.mjs";
import { ensureElectronExecutablePath } from "../desktop-runtime-paths.mjs";
import { signalProcessTree } from "../process-tree.mjs";

export const name = "settings-bridge-status";
export const description = "codex/grok bridges live on a temp root: grok missing dir -> 未找到生图记录, codex png import -> 正在收录 · 最近收到; chmod 000 -> 无法收录 + permission reason + 复制详细信息 carries EACCES (stubbed clipboard) + light/dark screenshots; chmod back -> 正在收录 again";

const QA_FLAGS = process.platform === "win32" ? ["--disable-gpu"] : [];

export async function run(ctx) {
  // The failure rounds inject EACCES with chmod 000 on the Codex images
  // folder, which does not block reads on Windows, and the standalone
  // CDP window never reported ready on the Windows runner (PR 353). The card
  // text and Windows path handling are covered by bridge-status-card unit
  // tests; this flow runs on macOS.
  if (process.platform === "win32") {
    console.log(`[e2e] flow ${name} skipped on win32: chmod-based EACCES injection is POSIX-only`);
    return;
  }
  await ctx.prepare();
  const root = await mkdtemp(join(tmpdir(), "mosa-bridge-status-e2e-"));
  const codexImagesDir = join(root, "codex", "generated_images");
  const codexSessionsDir = join(root, "codex", "sessions");
  const grokSessionsDir = join(root, "grok", "sessions");
  const windowUserData = join(root, "window-user-data");
  await mkdir(join(codexSessionsDir, "2026", "11", "20"), { recursive: true });
  // Codex is "installed": its images root exists before the bridge starts (the bridge no longer creates it).
  await mkdir(codexImagesDir, { recursive: true });
  await mkdir(windowUserData, { recursive: true });
  try {
    const server = await ctx.startServer({
      env: {
        MOSA_DISABLE_BRIDGES: "cowart,cowartDiscovery",
        CODEX_GENERATED_IMAGES_DIR: codexImagesDir,
        CODEX_SESSIONS_DIR: codexSessionsDir,
        GROK_SESSIONS_DIR: grokSessionsDir,
      },
    });
    try {
      // Grok 目录不建: the bridge must be up, scanning, and reporting
      // sourceFound:false without any error.
      await waitForBridgeStatus(server.origin, ctx.api, (status) =>
        status.codex?.enabled === true
        && status.grok?.enabled === true
        && status.grok?.sourceFound === false
        && status.grok?.lastError === null,
      "grok bridge up with sourceFound:false");

      // A real PNG inside the Codex images root; the running bridge imports it.
      await mkdir(join(codexImagesDir, "task-e2e"), { recursive: true });
      await writeFile(join(codexImagesDir, "task-e2e", "e2e-capture.png"), await pngFixture(640, 400));
      await waitForBridgeStatus(server.origin, ctx.api, (status) => Boolean(status.codex?.lastImportedAt),
        "codex imports the png");

      const round = await runWindowRound(ctx, server, { codexSessionsDir, codexImagesDir, windowUserData });
      return { tempRoot: root, ...round };
    } finally {
      await server.stop();
    }
  } finally {
    // The chmod restore happens inside the window round too; this is the
    // last-resort guard so the temp root can always be removed.
    await chmodCodexImages(codexImagesDir, 0o755);
    await rm(root, { recursive: true, force: true });
  }
}

async function runWindowRound(ctx, server, { codexSessionsDir, codexImagesDir, windowUserData }) {
  const electronBinary = ensureElectronExecutablePath({ rootDir: ctx.rootDir });
  const cdpPort = await freePort();
  const windowUrl = `${server.origin}/#mosa-client-token=${encodeURIComponent(ctx.token)}`;
  const child = spawn(electronBinary, [
    ...QA_FLAGS,
    `--remote-debugging-port=${cdpPort}`,
    join(ctx.rootDir, "scripts", "e2e-flows", "_bridge-status-window.mjs"),
    windowUrl,
    windowUserData,
  ], {
    cwd: ctx.rootDir,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutChunks = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(String(chunk)));
  const stderrChunks = [];
  child.stderr.on("data", (chunk) => stderrChunks.push(String(chunk)));
  let cdp = null;
  try {
    await waitForReadyLine(stdoutChunks, stderrChunks);
    cdp = await connectCdp(cdpPort, server.origin);

    await openConnectionsPage(cdp);
    // ① Codex 行「正在收录 · 最近收到…」、Grok 行「未找到生图记录」。
    await waitForCdpExpression(cdp, badgeOfRow("Codex"), "codex 正在收录 badge", {
      match: (value) => String(value || "").startsWith("正在收录 · 最近收到"),
    });
    const grokBadgeBefore = await cdp.evaluate(badgeOfRow("Grok"));
    if (grokBadgeBefore !== "未找到生图记录") {
      throw new Error(`grok badge before the failure is ${JSON.stringify(grokBadgeBefore)}`);
    }

    // ② Codex 目录 chmod 000,动一下会话目录触发下一轮扫描。
    await chmodCodexImages(codexImagesDir, 0o000);
    await writeFile(join(codexSessionsDir, "2026", "11", "20", "rollout-e2e-touch.jsonl"), `${JSON.stringify({ type: "e2e-touch" })}\n`);
    await waitForBridgeStatus(server.origin, ctx.api, (status) =>
      String(status.codex?.lastError || "").includes("EACCES") && status.codex?.lastErrorCode === "EACCES",
    "codex scan records EACCES");

    // 换一个设置页再回来,卡片重新挂载并立即取一次状态。
    await reopenConnectionsPage(cdp);
    await waitForCdpExpression(cdp, badgeOfRow("Codex"), "codex 无法收录 badge", {
      match: (value) => String(value || "") === "无法收录",
    });
    const cardText = await cdp.evaluate(`document.querySelector('.bridge-status-card')?.textContent || ''`);
    const problems = [];
    if (!cardText.includes("无法读取 Codex 的文件夹（没有权限）")) problems.push(`permission reason missing: ${JSON.stringify(cardText.slice(0, 400))}`);
    // macOS EACCES → the Finder Get Info steps, pointing at the images/sessions shared parent (…/codex). Checked with the trailing 「，」 so a deeper or shallower folder cannot pass as a prefix.
    if (!cardText.includes(`在访达中按 ⇧⌘G 前往 ${resolve(codexImagesDir, "..")}，按 ⌘I 打开简介`)) problems.push(`fix line missing the shared parent: ${JSON.stringify(cardText.slice(0, 600))}`);
    if (!cardText.includes("问题解决后会自动恢复收录。")) problems.push("fix line missing");
    if (problems.length) throw new Error(`bridge status error state: ${problems.join("; ")}`);

    // 复制详细信息 through a stubbed desktop bridge: the payload must carry
    // EACCES, and the real system clipboard is never involved.
    await cdp.evaluate(`(() => {
      window.__bridgeStatusCopied = [];
      window.electronAPI = {
        writeClipboardText: async (text) => { window.__bridgeStatusCopied.push(String(text)); return { ok: true }; },
      };
      return true;
    })()`);
    await cdp.evaluate(`document.querySelector('.bridge-status-card .bridge-status-copy-btn').click()`);
    await waitForCdpExpression(cdp, `document.querySelector('.bridge-status-card .bridge-status-copy-btn')?.textContent.trim()`, "已复制 button state", {
      match: (value) => String(value || "") === "已复制",
    });
    const copiedPayload = await cdp.evaluate(`(window.__bridgeStatusCopied || []).join("\\n---\\n")`);
    if (!copiedPayload.includes("EACCES")) {
      throw new Error(`copied details missing EACCES: ${JSON.stringify(copiedPayload.slice(0, 400))}`);
    }

    // ③ 出错状态的卡片截图,浅色一张、深色一张。隐藏窗口跟随系统外观,所以
    // 两张都从真正的外观按钮走,不靠系统状态。
    await switchAppearanceAndBack(cdp, "浅色");
    await waitForCdpExpression(cdp, badgeOfRow("Codex"), "codex 无法收录 badge (light)", {
      match: (value) => String(value || "") === "无法收录",
    });
    await cdp.evaluate(`document.querySelector('.bridge-status-card').scrollIntoView({ block: 'center' })`);
    await sleep(300);
    const lightShot = Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64");
    const lightPath = await writeFlowArtifact(ctx, "452-card-error.png", lightShot);

    await switchAppearanceAndBack(cdp, "深色");
    await waitForCdpExpression(cdp, badgeOfRow("Codex"), "codex 无法收录 badge (dark)", {
      match: (value) => String(value || "") === "无法收录",
    });
    await cdp.evaluate(`document.querySelector('.bridge-status-card').scrollIntoView({ block: 'center' })`);
    await sleep(300);
    const darkShot = Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64");
    const darkPath = await writeFlowArtifact(ctx, "452-card-error-dark.png", darkShot);

    // 恢复权限后卡片回到 正在收录。
    await chmodCodexImages(codexImagesDir, 0o755);
    await writeFile(join(codexSessionsDir, "2026", "11", "20", "rollout-e2e-touch-2.jsonl"), `${JSON.stringify({ type: "e2e-touch-2" })}\n`);
    await waitForBridgeStatus(server.origin, ctx.api, (status) =>
      status.codex?.lastError === null && status.codex?.lastErrorCode === null,
    "codex scan clears the error");
    await reopenConnectionsPage(cdp);
    await waitForCdpExpression(cdp, badgeOfRow("Codex"), "codex recovered badge", {
      match: (value) => String(value || "").startsWith("正在收录"),
    });

    return {
      grokBadgeBefore,
      copiedEACCES: true,
      screenshots: { light: lightPath, dark: darkPath },
    };
  } finally {
    cdp?.close();
    await stopWindowProcess(child);
  }
}

async function stopWindowProcess(child) {
  const pid = child.pid;
  if (!pid || pid <= 1) return;
  if (!(await signalProcessTree(pid))) child.kill("SIGTERM");
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && child.exitCode === null) await sleep(100);
  if (child.exitCode === null) await signalProcessTree(pid, { force: true }).catch(() => {});
}

async function openConnectionsPage(cdp) {
  await waitForCdpExpression(cdp, `Boolean(document.querySelector('.app'))`, "app shell");
  await cdp.evaluate(`document.querySelector('.user-button').click()`);
  await waitForCdpExpression(cdp, `Boolean(document.querySelector('.settings-modal'))`, "settings open");
  await clickConnectionNav(cdp);
  await waitForCdpExpression(cdp, `Boolean(document.querySelector('.bridge-status-card'))`, "bridge status card");
}

// Leaving and re-entering 连接 unmounts and remounts the card, which fetches
// /api/bridges immediately instead of waiting for the 30-second poll.
async function reopenConnectionsPage(cdp) {
  await cdp.evaluate(`(() => {
    const navs = Array.from(document.querySelectorAll('.settings-nav button'));
    (navs.find((b) => b.textContent.trim() === '存储') || navs[0])?.click();
    return true;
  })()`);
  await waitForCdpExpression(cdp, `!document.querySelector('.bridge-status-card')`, "card unmounted");
  await clickConnectionNav(cdp);
  await waitForCdpExpression(cdp, `Boolean(document.querySelector('.bridge-status-card'))`, "bridge status card remounted");
}

async function clickConnectionNav(cdp) {
  await cdp.evaluate(`(() => {
    const nav = Array.from(document.querySelectorAll('.settings-nav button')).find((b) => b.textContent.trim() === '连接');
    if (!nav) throw new Error('连接 nav missing: ' + Array.from(document.querySelectorAll('.settings-nav button')).map((b) => b.textContent.trim()).join('|'));
    nav.click();
    return true;
  })()`);
}

// 浅色/深色 goes through the real 常规 tab: click the appearance option, then
// back to 连接 so the card remounts with the new palette already applied.
async function switchAppearanceAndBack(cdp, optionLabel) {
  await cdp.evaluate(`(() => {
    const navs = Array.from(document.querySelectorAll('.settings-nav button'));
    const general = navs.find((b) => b.textContent.trim() === '常规');
    (general || navs[0]).click();
    return true;
  })()`);
  await waitForCdpExpression(cdp, `Boolean(document.querySelector('.appearance-options'))`, "appearance options");
  await cdp.evaluate(`(() => {
    const option = Array.from(document.querySelectorAll('.appearance-option')).find((b) => b.textContent.trim() === '${optionLabel}');
    if (!option) throw new Error('${optionLabel} option missing');
    option.click();
    return true;
  })()`);
  const wantsDark = optionLabel === "深色";
  await waitForCdpExpression(cdp, `document.querySelector('.app')?.className.includes('dark') === ${wantsDark}`, `${optionLabel} class applied`);
  await clickConnectionNav(cdp);
  await waitForCdpExpression(cdp, `Boolean(document.querySelector('.bridge-status-card'))`, `bridge status card in ${optionLabel}`);
}

function badgeOfRow(toolName) {
  return `(() => {
    const rows = Array.from(document.querySelectorAll('.bridge-status-row'));
    const row = rows.find((el) => el.querySelector('.bridge-status-name')?.textContent.trim() === '${toolName}');
    return row?.querySelector('.bridge-status-badge')?.textContent.trim() || '';
  })()`;
}

async function waitForBridgeStatus(origin, api, predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      lastStatus = await api(origin, "GET", "/api/bridges");
      if (predicate(lastStatus)) return lastStatus;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}: last=${JSON.stringify(lastStatus).slice(0, 600)}${lastError ? ` lastError=${lastError.message}` : ""}`);
}

async function chmodCodexImages(imagesDir, mode) {
  await chmod(imagesDir, mode).catch(() => {});
}

async function pngFixture(width, height) {
  const raw = Buffer.alloc(width * height * 3);
  for (let index = 0; index < raw.length; index += 1) raw[index] = (index * 37 + (index % 251)) & 255;
  return sharp(raw, { raw: { width, height, channels: 3 } }).png({ quality: 90 }).toBuffer();
}

function sleep(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForReadyLine(stdoutChunks, stderrChunks, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stdoutChunks.join("").includes("BRIDGE_STATUS_WINDOW_READY")) return;
    await sleep(100);
  }
  throw new Error(`bridge status window never became ready: stdout=${stdoutChunks.join("").slice(-500)} stderr=${stderrChunks.join("").slice(-1200)}`);
}
