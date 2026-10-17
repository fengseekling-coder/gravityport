#!/usr/bin/env node

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import { launchDesktopGui } from "./desktop-gui-launcher.mjs";
import { ensureElectronExecutablePath } from "./desktop-runtime-paths.mjs";
import { createCriticalUiFlowSource, createTrashUiFlowSource, E2E_DROP_GROUP_NAME } from "./e2e-ui-flow.mjs";
import { signalProcessTree } from "./process-tree.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const electronBinary = ensureElectronExecutablePath({ rootDir });
const webDriver = join(rootDir, "scripts", "e2e-web-driver.mjs");
const DISABLED_BRIDGES = "cowart,cowartDiscovery,codex,grok";
const flowsDir = join(rootDir, "scripts", "e2e-flows");
// MOSA_E2E_ONLY=groups,trash runs only the named flows (built-in names: web,
// electron, stack, trash; plugin flows use their exported name). Development
// aid only — CI always runs everything.
const onlyFlows = new Set(String(process.env.MOSA_E2E_ONLY || "").split(",").map((name) => name.trim()).filter(Boolean));
// Optional verdict sink for long native CI/local runs whose process output
// cannot always be retained by the remote runner. Unset in ordinary CI.
const resultFile = process.env.MOSA_E2E_RESULT_FILE || "";
const selected = (name) => !onlyFlows.size || onlyFlows.has(name);
const ELECTRON_QA_FLAGS = process.platform === "win32" ? ["--disable-gpu"] : [];
const QA_CLIENT_TOKEN = "mosa_e2e_client_token_0123456789abcdefghijklmnop";

if (!existsSync(electronBinary)) throw new Error(`Electron binary was not installed correctly: ${electronBinary}`);

const root = await mkdtemp(join(tmpdir(), "mosa-critical-e2e-"));
const libraryDir = join(root, "library");
const desktopLibraryDir = join(root, "desktop-library");
const stackLibraryDir = join(root, "stack-library");
const trashLibraryDir = join(root, "trash-library");
const generatedDir = join(root, "generated-images");
// Seeded fixtures live outside generated-images: that folder is the Codex images
// dir, where the first sub-folder is read as one Codex task and images of the
// same task stack automatically. Flows that need a Codex source pass sourceType.
const fixturesRoot = join(root, "fixtures");
const webUserData = join(root, "web-user-data");
const desktopUserData = join(root, "desktop-user-data");
const stackUserData = join(root, "stack-user-data");
const trashUserData = join(root, "trash-user-data");
// 导入改为页面内生成的 File 拖入（沙箱渲染端读不了本地文件）；这两张 fixture
// 只剩 Stack 流程的 seedStackAssets 还在用。
const webFixturePath = join(generatedDir, "critical-flow.png");
const stackFixturePath = join(generatedDir, "stack-flow.png");
const trashFixtureDir = join(fixturesRoot, "trash-flow");
const stamp = Date.now().toString(36);
const webSearchTerm = "mosa-e2e"; // 命中拖入/粘贴导入的卡片文件名前缀
const webRecipeChange = `web-recipe-${stamp}`; // 兼容驱动签名;配方编辑已随旧界面退役
const desktopSearchTerm = "mosa-e2e";
const desktopRecipeChange = `electron-recipe-${stamp}`;
// 回收站轮的预置数据：exercise 轮 seed，verify 轮复用（同一份 userData/库目录）。
let trashFlowConfig = null;

await Promise.all([
  mkdir(libraryDir, { recursive: true }),
  mkdir(desktopLibraryDir, { recursive: true }),
  mkdir(stackLibraryDir, { recursive: true }),
  mkdir(trashLibraryDir, { recursive: true }),
  mkdir(generatedDir, { recursive: true }),
  mkdir(trashFixtureDir, { recursive: true }),
  mkdir(webUserData, { recursive: true }),
  mkdir(desktopUserData, { recursive: true }),
  mkdir(stackUserData, { recursive: true }),
  mkdir(trashUserData, { recursive: true }),
]);
const trashFixtureColors = { a: [181, 68, 74], b: [74, 127, 181], c: [58, 138, 87], d: [138, 90, 47], e: [96, 74, 155] };
await Promise.all([
  sharp({ create: { width: 32, height: 24, channels: 4, background: { r: 33, g: 77, b: 121, alpha: 1 } } }).png().toFile(webFixturePath),
  sharp({ create: { width: 32, height: 24, channels: 4, background: { r: 121, g: 77, b: 33, alpha: 1 } } }).png().toFile(stackFixturePath),
  ...Object.entries(trashFixtureColors).map(([key, [r, g, b]]) => (
    sharp({ create: { width: 32, height: 24, channels: 4, background: { r, g, b, alpha: 1 } } }).png().toFile(join(trashFixtureDir, `trash-${key}.png`))
  )),
]);

let verdict = { ok: false, storage: "sqlite", flows: [], restartVerified: false, error: "incomplete" };
try {
  const flowsRun = [];
  if (selected("web")) {
    console.log(`[e2e] Web renderer: drop import -> sidebar group drop -> paste -> search -> favorite -> recipe autosave`);
    await runWebRound("exercise", webSearchTerm, webRecipeChange);
    console.log("[e2e] Web renderer: restart -> drop-group persistence -> search -> favorite/recipe verification");
    await runWebRound("verify", webSearchTerm, webRecipeChange);
    flowsRun.push("web");
  }

  if (selected("electron")) {
    console.log(`[e2e] Electron renderer: drop import -> sidebar group drop -> search -> favorite -> recipe autosave`);
    await runElectronRound("exercise", desktopSearchTerm, desktopRecipeChange);
    console.log("[e2e] Electron renderer: restart -> drop-group persistence -> search -> favorite/recipe verification");
    await runElectronRound("verify", desktopSearchTerm, desktopRecipeChange);
    flowsRun.push("electron");
  }

  if (selected("stack")) {
    console.log("[e2e] Web renderer: bare URL -> direct-drag Stack create -> enter -> reorder cover -> return");
    await runWebStackRound();
    flowsRun.push("stack");
  }

  if (selected("trash")) {
    console.log("[e2e] Web renderer: trash -> cancel/trash/restore/permanent-delete/empty with import blocked in Trash");
    await runWebTrashRound("exercise");
    console.log("[e2e] Web renderer: trash restart -> restore E -> root layout verification");
    await runWebTrashRound("verify");
    flowsRun.push("trash");
  }

  flowsRun.push(...await runPluginFlows());

  if (!flowsRun.length) throw new Error(`MOSA_E2E_ONLY matched no flow: ${[...onlyFlows].join(",")}`);
  verdict = { ok: true, storage: "sqlite", flows: flowsRun, restartVerified: true };
  console.log(JSON.stringify(verdict));
} catch (error) {
  verdict = { ok: false, storage: "sqlite", flows: [], restartVerified: false, error: String(error?.message || error) };
  throw error;
} finally {
  if (resultFile) await writeFile(resultFile, `${JSON.stringify(verdict, null, 2)}\n`);
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

// ===== Pluggable flows (scripts/e2e-flows/*.mjs) =====
// Each module exports `name` (unique, kebab-case), `description`, and
// `async run(ctx)`; it throws on failure and may return a summary object.
// Files starting with "_" are shared helpers, never flows. The context keeps
// every flow isolated: its own library/userData/fixtures under the run root.
async function runPluginFlows() {
  const files = (await readdir(flowsDir).catch(() => []))
    .filter((file) => file.endsWith(".mjs") && !file.startsWith("_"))
    .sort();
  const names = new Set();
  const ran = [];
  for (const file of files) {
    const flow = await import(pathToFileURL(join(flowsDir, file)).href);
    if (typeof flow.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(flow.name) || typeof flow.run !== "function") {
      throw new Error(`E2E flow ${file} must export a kebab-case name and an async run(ctx)`);
    }
    if (names.has(flow.name) || ["web", "electron", "stack", "trash"].includes(flow.name)) {
      throw new Error(`Duplicate E2E flow name: ${flow.name}`);
    }
    names.add(flow.name);
    if (!selected(flow.name)) continue;
    console.log(`[e2e] flow ${flow.name}: ${flow.description || file}`);
    const ctx = createFlowContext(flow.name);
    try {
      const summary = await flow.run(ctx);
      if (summary !== undefined) console.log(`[e2e] flow ${flow.name} result ${JSON.stringify(summary)}`);
    } catch (error) {
      console.error(ctx.serverDiagnostics());
      throw new Error(`E2E flow ${flow.name} failed: ${error?.message || error}`, { cause: error });
    }
    ran.push(flow.name);
  }
  return ran;
}

function createFlowContext(flowName) {
  const flowRoot = join(root, `flow-${flowName}`);
  // Every server this flow starts, so a failed flow can report how each one
  // ended. A connection error alone cannot tell a crash from a flow bug.
  const servers = [];
  const dirs = {
    libraryDir: join(flowRoot, "library"),
    userDataDir: join(flowRoot, "user-data"),
    fixturesDir: join(fixturesRoot, `flow-${flowName}`),
  };
  let sourceCounter = 0;
  const ctx = {
    ...dirs,
    rootDir,
    token: QA_CLIENT_TOKEN,
    // Failure report for every server this flow started: whether it is still
    // running or how and when it exited, whether the flow itself stopped it,
    // and the tail of its stderr/stdout.
    serverDiagnostics() {
      if (!servers.length) return `[e2e] flow ${flowName} started no servers`;
      const now = Date.now();
      const tail = (text, limit) => {
        const value = String(text || "").trim();
        return value.length > limit ? `…${value.slice(-limit)}` : value || "(empty)";
      };
      return servers.map((server, index) => {
        const state = server.exit
          ? `exited code=${server.exit.code} signal=${server.exit.signal} ${server.exit.at - server.startedAt}ms after start, ${now - server.exit.at}ms before this report`
          : "still running";
        const stoppedBy = server.stoppedByFlowAt ? `stopped by the flow ${server.stoppedByFlowAt - server.startedAt}ms after start` : "never stopped by the flow";
        return [
          `[e2e] flow ${flowName} server #${index + 1} port ${server.port}: ${state}; ${stoppedBy}`,
          `[e2e]   stderr: ${tail(server.stderr(), 4000)}`,
          `[e2e]   stdout: ${tail(server.stdout(), 2000)}`,
        ].join("\n");
      }).join("\n");
    },
    async prepare() {
      await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })));
    },
    // Writes a solid-colour PNG inside the Codex generated-images root, which
    // /api/assets/create is allowed to read in QA runs.
    async makePng(fileName, [r, g, b] = [74, 127, 181], { width = 32, height = 24 } = {}) {
      const filePath = join(dirs.fixturesDir, fileName);
      await sharp({ create: { width, height, channels: 4, background: { r, g, b, alpha: 1 } } }).png().toFile(filePath);
      return filePath;
    },
    // Starts server.mjs on this flow's library/userData. Call stop() in a
    // finally block; start again with the same dirs to verify persistence.
    // `{ libraryDir }` runs the server against a different library directory
    // (health check included) — used by the library-relocation flow.
    // `{ env }` adds flow-specific variables on top of the QA environment
    // (e.g. MOSA_FEEDBACK_URL pointing at a flow-owned fake service).
    async startServer({ libraryDir: libraryDirOverride, env: extraEnv } = {}) {
      const activeLibraryDir = libraryDirOverride || dirs.libraryDir;
      const port = await freePort();
      const child = spawn(process.execPath, ["server.mjs"], {
        cwd: rootDir,
        env: {
          ...qaEnvironment({ portVariable: "MOSA_PORT", port, userData: dirs.userDataDir, library: activeLibraryDir }),
          ...(extraEnv || {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stderr = collect(child.stderr);
      const record = { port, startedAt: Date.now(), stoppedByFlowAt: 0, exit: null, stdout: collect(child.stdout), stderr };
      child.once("exit", (code, signal) => { record.exit = { code, signal, at: Date.now() }; });
      servers.push(record);
      const stop = () => {
        if (!record.stoppedByFlowAt) record.stoppedByFlowAt = Date.now();
        return stopProcess(child);
      };
      try {
        assertHealth(await waitForHealth(`http://127.0.0.1:${port}/api/health`, child), activeLibraryDir);
      } catch (error) {
        await stop();
        throw new Error(`${error.message}\n${stderr().trim()}`, { cause: error });
      }
      return { origin: `http://127.0.0.1:${port}`, stderr, stop };
    },
    // JSON API call with the QA client token; throws on a non-2xx status.
    // A pooled keep-alive socket can be reused just as the server's idle
    // timeout closes it, which surfaces as a bare "fetch failed". GETs are
    // idempotent, so they get one retry; other methods rethrow with the
    // socket-level cause so a recurrence is diagnosable.
    async api(origin, method, path, body) {
      const send = () => fetch(`${origin}${path}`, {
        method,
        headers: { "x-mosa-client-token": QA_CLIENT_TOKEN, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let response;
      try {
        response = await send();
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        if (method !== "GET") throw new Error(`${method} ${path} -> ${error.message} (${error.cause?.code || error.cause?.message || "no cause"})`, { cause: error });
        response = await send();
      }
      const text = await response.text();
      if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : null;
    },
    // Evaluates `source` (an async IIFE expression string) in a sandboxed
    // Electron window on the server's UI and returns the value it resolves.
    // E2E-only capability: `{ windowSize: [width, height] }` sizes the renderer
    // window (via MOSA_E2E_WEB_WINDOW_SIZE) for narrow-viewport flows; omitted
    // keeps the historical 1280x800.
    async runInPage(server, source, { windowSize } = {}) {
      const sourceFile = join(root, `flow-${flowName}-${++sourceCounter}.js`);
      await writeFile(sourceFile, source, "utf8");
      const env = {
        ...process.env,
        MOSA_E2E_WEB_TARGET_URL: `${server.origin}/#mosa-client-token=${encodeURIComponent(QA_CLIENT_TOKEN)}`,
        MOSA_E2E_WEB_USER_DATA: dirs.userDataDir,
        MOSA_E2E_WEB_SOURCE_FILE: sourceFile,
      };
      if (windowSize !== undefined) {
        if (!Array.isArray(windowSize) || windowSize.length !== 2
          || !windowSize.every((value) => Number.isInteger(value) && value > 0)) {
          throw new Error(`runInPage windowSize must be [width, height] positive integers, got ${JSON.stringify(windowSize)}`);
        }
        env.MOSA_E2E_WEB_WINDOW_SIZE = `${windowSize[0]}x${windowSize[1]}`;
      }
      const output = await runCommand(electronBinary, [...ELECTRON_QA_FLAGS, webDriver], {
        cwd: rootDir,
        env,
      });
      return JSON.parse(String(output || "null").split(/\r?\n/).filter(Boolean).at(-1) || "null");
    },
  };
  return ctx;
}

function assertTrashRoundResult(result, mode) {
  if (!result?.mode) throw new Error(`Trash UI round returned no result: ${JSON.stringify(result)}`);
  const problems = [];
  if (mode === "exercise") {
    if (result.cancelTrashKeptAsset !== true) problems.push("cancelled trash removed the asset");
    if (result.skipConfirmPersisted !== true) problems.push("不再提醒 did not persist");
    if (result.moveToTrashWorked !== true) problems.push("single move-to-trash");
    if (result.trashDropBlockedTrashView !== true) problems.push("drop/paste import not blocked in Trash view");
    if (result.allViewDropImported !== true) problems.push("drop import must work again outside Trash");
    if (result.groupRestored !== true) problems.push("group membership rebuild");
    if (result.stackRebuilt !== true) problems.push("stack rebuild (id/cover/count)");
  } else {
    if (result.restoreAfterRestartWorked !== true) problems.push("restore after restart");
    if (result.rootCountAfterRestore !== 5) problems.push(`root card count after restore (${result.rootCountAfterRestore})`);
    if (result.stackCountShown !== "2") problems.push(`stack count shown (${result.stackCountShown})`);
    if (result.stackIdStillValid !== true) problems.push("stack id/cover after restart");
  }
  if (problems.length) throw new Error(`Unexpected trash UI result (${mode}): ${problems.join("; ")} — ${JSON.stringify(result)}`);
}

function assertCriticalRoundResult(result, mode, { paste }) {
  if (!result?.mode) throw new Error(`Critical UI round returned no result: ${JSON.stringify(result)}`);
  const problems = [];
  if (mode === "exercise") {
    if (result.dropImportedCount < 1) problems.push("gallery drop import count");
    if (result.sidebarDropNavigated !== false) problems.push("sidebar group drop changed the current view");
    if (result.favorite !== true) problems.push("favorite after exercise");
    if (result.promptSectionPresent !== true) problems.push("inspector prompt section");
    if (paste && (result.pasteImported !== true || result.modalOpenAfterPaste !== false)) problems.push("paste import / no modal");
  } else {
    if (result.favorite !== true) problems.push("favorite after restart");
    if (result.promptSectionPresent !== true) problems.push("inspector prompt section after restart");
  }
  if (result.groupAssetCount !== 1) problems.push(`E2E Drop group asset count (${result.groupAssetCount})`);
  if (problems.length) throw new Error(`Unexpected critical UI result (${mode}): ${problems.join("; ")} — ${JSON.stringify(result)}`);
}

async function runWebRound(mode, searchTerm, recipeChange) {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: rootDir,
    env: qaEnvironment({
      portVariable: "MOSA_PORT",
      port,
      userData: webUserData,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = collect(child.stderr);
  try {
    const health = await waitForHealth(`http://127.0.0.1:${port}/api/health`, child);
    assertHealth(health);
    await seedDropGroup(port);
    const output = await runCommand(electronBinary, [...ELECTRON_QA_FLAGS, webDriver], {
      cwd: rootDir,
      env: {
        ...process.env,
        MOSA_E2E_WEB_TARGET_URL: `http://127.0.0.1:${port}/#mosa-client-token=${encodeURIComponent(QA_CLIENT_TOKEN)}`,
        MOSA_E2E_WEB_USER_DATA: webUserData,
        MOSA_E2E_WEB_MODE: mode,
        MOSA_E2E_WEB_SEARCH: searchTerm,
        MOSA_E2E_WEB_RECIPE_CHANGE: recipeChange,
        MOSA_E2E_WEB_GROUP: E2E_DROP_GROUP_NAME,
        MOSA_E2E_WEB_PASTE: "1",
      },
    });
    const result = JSON.parse(String(output || "{}").split(/\r?\n/).filter(Boolean).at(-1) || "{}");
    assertCriticalRoundResult(result, mode, { paste: true });
  } catch (error) {
    const detail = stderr().trim();
    throw new Error(`Web E2E ${mode} failed${detail ? `\n${detail}` : ""}`, { cause: error });
  } finally {
    await stopProcess(child);
  }
}

// 回收站轮：独立 userData / 库目录。exercise 轮先通过 API 预置
// A(分组 Trash Group) / B / C+D(Stack) / E，页面内跑完整回收站流程；
// 数据校验（API + 磁盘）在 runner 侧做，不经过界面。
async function runWebTrashRound(mode) {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: rootDir,
    env: qaEnvironment({
      portVariable: "MOSA_PORT",
      port,
      userData: trashUserData,
      library: trashLibraryDir,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = collect(child.stderr);
  try {
    const health = await waitForHealth(`http://127.0.0.1:${port}/api/health`, child);
    assertHealth(health, trashLibraryDir);
    if (mode === "exercise") trashFlowConfig = await seedTrashAssets(port);
    if (!trashFlowConfig) throw new Error("Trash flow config is missing; run the exercise round first.");
    const output = await runCommand(electronBinary, [...ELECTRON_QA_FLAGS, webDriver], {
      cwd: rootDir,
      env: {
        ...process.env,
        MOSA_E2E_WEB_TARGET_URL: `http://127.0.0.1:${port}/#mosa-client-token=${encodeURIComponent(QA_CLIENT_TOKEN)}`,
        MOSA_E2E_WEB_USER_DATA: trashUserData,
        MOSA_E2E_WEB_FLOW: "trash",
        MOSA_E2E_WEB_TRASH_CONFIG: JSON.stringify({ mode, ...trashFlowConfig }),
      },
    });
    const result = JSON.parse(String(output || "{}").split(/\r?\n/).filter(Boolean).at(-1) || "{}");
    assertTrashRoundResult(result, mode);
    if (mode === "exercise") await verifyTrashDataAfterExercise(port, trashFlowConfig);
  } catch (error) {
    const detail = stderr().trim();
    throw new Error(`Web Trash E2E ${mode} failed${detail ? `\n${detail}` : ""}`, { cause: error });
  } finally {
    await stopProcess(child);
  }
}

async function seedTrashAssets(port) {
  const origin = `http://127.0.0.1:${port}`;
  const create = async (key, { group } = {}) => {
    const response = await fetch(`${origin}/api/assets/create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mosa-client-token": QA_CLIENT_TOKEN,
      },
      body: JSON.stringify({ projectId: "default", imagePath: join(trashFixtureDir, `trash-${key}.png`), ...(group ? { group } : {}) }),
    });
    if (!response.ok) throw new Error(`Trash E2E seed failed (${response.status}): ${await response.text()}`);
    const body = await response.json();
    if (!body.asset?.id || !body.asset?.image_path) throw new Error(`Trash E2E seed returned no asset for ${key}.`);
    return { id: body.asset.id, imagePath: body.asset.image_path };
  };
  // A 在 Trash Group 分组；B、E 不放分组；C、D 建成一个 Stack（C 为封面）。
  const a = await create("a", { group: "Trash Group" });
  const b = await create("b");
  const c = await create("c");
  const d = await create("d");
  const e = await create("e");
  const stackResponse = await fetch(`${origin}/api/asset-stacks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mosa-client-token": QA_CLIENT_TOKEN,
    },
    body: JSON.stringify({ projectId: "default", assetIds: [c.id, d.id], coverAssetId: c.id }),
  });
  if (!stackResponse.ok) throw new Error(`Trash E2E stack seed failed (${stackResponse.status}): ${await stackResponse.text()}`);
  const stack = (await stackResponse.json()).stack;
  if (!stack?.id) throw new Error("Trash E2E stack seed returned no stack id.");
  return {
    groupName: "Trash Group",
    stackId: stack.id,
    coverId: c.id,
    assetIds: { a: a.id, b: b.id, c: c.id, d: d.id, e: e.id },
    imagePaths: { a: a.imagePath, b: b.imagePath, c: c.imagePath, d: d.imagePath, e: e.imagePath },
  };
}

async function verifyTrashDataAfterExercise(port, config) {
  const origin = `http://127.0.0.1:${port}`;
  const listIds = async (trash) => {
    const page = await (await fetch(`${origin}/api/assets?project=default&limit=250${trash ? "&trash=1" : ""}`)).json();
    return new Set((Array.isArray(page?.assets) ? page.assets : []).map((asset) => asset.id));
  };
  const normalIds = await listIds(false);
  const trashIds = await listIds(true);
  const problems = [];
  // 永久删除/清空回收站在新界面没有入口（设计如此，能力仍由 store/API 测试覆盖）；
  // exercise 轮移入回收站一张普通卡并保留到重启，b 是后来拖入的新素材。
  // 回收站列表按「最新优先」，被移入的不一定是种子顺序里的 a，不钉死具体 id。
  const seededIds = Object.values(config.assetIds);
  const accounted = seededIds.filter((id) => normalIds.has(id) || trashIds.has(id));
  if (accounted.length !== seededIds.length) problems.push("some seeded assets vanished from both listings");
  if (trashIds.size !== 1) problems.push(`exercise round must leave exactly one asset trashed (trash=${trashIds.size})`);
  for (const key of ["c", "d"]) {
    if (!normalIds.has(config.assetIds[key])) problems.push(`${key} (stack member) missing from the normal listing`);
  }
  for (const key of ["a", "b", "c", "d", "e"]) {
    if (!existsSync(config.imagePaths[key])) problems.push(`${key} managed file was removed unexpectedly`);
  }
  if (problems.length) throw new Error(`Trash data verification failed: ${problems.join("; ")}`);
}

async function seedDropGroup(port) {
  const origin = `http://127.0.0.1:${port}`;
  const response = await fetch(`${origin}/api/groups`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mosa-client-token": QA_CLIENT_TOKEN,
    },
    body: JSON.stringify({ projectId: "default", name: E2E_DROP_GROUP_NAME }),
  });
  if (response.ok) return;
  // verify 轮里分组已在 exercise 轮建好；只有确认它确实存在时才容忍重复创建。
  // GET /api/groups 返回 { groups: { groups: [{ name, count, ... }], ... } }。
  const payload = await (await fetch(`${origin}/api/groups?project=default`)).json();
  const groupList = Array.isArray(payload?.groups) ? payload.groups : payload?.groups?.groups;
  const names = (Array.isArray(groupList) ? groupList : [])
    .map((group) => (Array.isArray(group) ? group[0] : group?.name));
  if (!names.includes(E2E_DROP_GROUP_NAME)) {
    throw new Error(`E2E drop group seed failed (${response.status}): ${await response.text()}`);
  }
}

async function runWebStackRound() {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: rootDir,
    env: qaEnvironment({
      portVariable: "MOSA_PORT",
      port,
      userData: stackUserData,
      library: stackLibraryDir,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = collect(child.stderr);
  try {
    const health = await waitForHealth(`http://127.0.0.1:${port}/api/health`, child);
    assertHealth(health, stackLibraryDir);
    await seedStackAssets(port);
    const output = await runCommand(electronBinary, [...ELECTRON_QA_FLAGS, webDriver], {
      cwd: rootDir,
      env: {
        ...process.env,
        MOSA_E2E_WEB_TARGET_URL: `http://127.0.0.1:${port}/`,
        MOSA_E2E_WEB_USER_DATA: stackUserData,
        MOSA_E2E_WEB_FLOW: "stack",
      },
    });
    const result = JSON.parse(String(output || "{}").split(/\r?\n/).filter(Boolean).at(-1) || "{}");
    if (!result.stackId || result.stackMoved !== true || result.memberCountAfterPaste !== 3) {
      throw new Error(`Unexpected Stack UI result: ${JSON.stringify(result)}`);
    }
  } catch (error) {
    const detail = stderr().trim();
    throw new Error(`Web Stack E2E failed${detail ? `\n${detail}` : ""}`, { cause: error });
  } finally {
    await stopProcess(child);
  }
}

async function seedStackAssets(port) {
  const origin = `http://127.0.0.1:${port}`;
  // 堆叠流从页面里建两个堆叠（各含两张），需要四张裸素材。
  for (const [imagePath, prompt] of [
    [webFixturePath, "stack flow first"],
    [stackFixturePath, "stack flow second"],
    [webFixturePath, "stack flow third"],
    [stackFixturePath, "stack flow fourth"],
  ]) {
    const response = await fetch(`${origin}/api/assets/create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mosa-client-token": QA_CLIENT_TOKEN,
      },
      body: JSON.stringify({ projectId: "default", imagePath, prompt }),
    });
    if (!response.ok) throw new Error(`Stack E2E seed failed (${response.status}): ${await response.text()}`);
    const body = await response.json();
    if (!body.asset?.id) throw new Error("Stack E2E seed returned no asset id.");
  }
}

async function runElectronRound(mode, searchTerm, recipeChange) {
  const servicePort = await freePort();
  const cdpPort = await freePort();
  const runDir = join(root, `desktop-${mode}-${servicePort}`);
  await mkdir(runDir, { recursive: true });
  const pidFile = join(runDir, "pid.txt");
  const logFile = join(runDir, "main.log");
  const healthFile = join(runDir, "health.json");
  const env = qaEnvironment({
    portVariable: "MOSA_DESKTOP_PORT",
    port: servicePort,
    userData: desktopUserData,
    library: desktopLibraryDir,
  });
  const launched = await launchDesktopGui({
    platform: process.platform,
    rootDir: runDir,
    executable: electronBinary,
    args: [...ELECTRON_QA_FLAGS, "desktop/main.mjs", `--user-data-dir=${desktopUserData}`, `--remote-debugging-port=${cdpPort}`],
    env,
    cwd: rootDir,
    pidFile,
    logFile,
    healthUrl: `http://127.0.0.1:${servicePort}/api/health`,
    healthFile,
  });
  const waiter = launched.waiter;
  let pid = null;
  try {
    pid = launched.pid || await waitForPid(pidFile);
    const health = await waitForHealthFile(healthFile);
    assertHealth(health, desktopLibraryDir);
    await seedDropGroup(servicePort);
    const cdp = await connectCdp(cdpPort, `http://127.0.0.1:${servicePort}`);
    try {
      await waitForRendererReady(cdp);
      const result = await cdp.evaluate(createCriticalUiFlowSource({
        mode,
        searchTerm,
        recipeChange,
        dropGroupName: E2E_DROP_GROUP_NAME,
        pasteEnabled: false,
      }));
      assertCriticalRoundResult(result, mode, { paste: false });
    } finally {
      cdp.close();
    }
  } catch (error) {
    const log = await readFile(logFile, "utf8").catch(() => "");
    throw new Error(`Electron E2E ${mode} failed${log ? `\n${log}` : ""}`, { cause: error });
  } finally {
    if (pid) await stopPid(pid);
    if (waiter.exitCode === null) waiter.kill("SIGTERM");
  }
}

function qaEnvironment({ portVariable, port, userData, library = libraryDir }) {
  return {
    ...process.env,
    MOSA_RUNTIME_MODE: "qa",
    MOSA_QA_RUN: "1",
    MOSA_CLIENT_TOKEN: QA_CLIENT_TOKEN,
    MOSA_LIBRARY_DIR: library,
    MOSA_USER_DATA: userData,
    MOSA_DISABLE_BRIDGES: DISABLED_BRIDGES,
    MOSA_PROJECT_DIR: root,
    CODEX_GENERATED_IMAGES_DIR: generatedDir,
    CODEX_SESSIONS_DIR: join(root, "codex-sessions"),
    GROK_SESSIONS_DIR: join(root, "grok-sessions"),
    COWART_MOSA_CANVAS_DIR: join(root, "cowart-data"),
    MOSA_COWART_REGISTRY_PATH: join(root, "cowart-projects.json"),
    [portVariable]: String(port),
  };
}

function assertHealth(health, expectedLibraryDir = libraryDir) {
  if (health?.product !== "mosa") throw new Error("E2E runtime is not MOSA.");
  if (resolve(health.libraryDir) !== resolve(expectedLibraryDir)) throw new Error("E2E library isolation failed.");
  if (health.storage !== "sqlite") throw new Error(`E2E expected SQLite storage, got ${health.storage}`);
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

async function waitForHealth(url, child, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Runtime exited early with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await sleep(100);
  }
  throw new Error(`Health timeout: ${url}`);
}

async function waitForHealthFile(filePath, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(filePath, "utf8")); } catch {}
    await sleep(100);
  }
  throw new Error(`Health file timeout: ${filePath}`);
}

async function waitForPid(filePath, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt(await readFile(filePath, "utf8"), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {}
    await sleep(100);
  }
  throw new Error(`PID timeout: ${filePath}`);
}

async function connectCdp(port, expectedUrlPrefix, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let target = null;
  while (Date.now() < deadline && !target) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        target = targets.find((entry) => entry.type === "page" && String(entry.url || "").startsWith(expectedUrlPrefix));
      }
    } catch {}
    if (!target) await sleep(100);
  }
  if (!target?.webSocketDebuggerUrl) throw new Error(`No Electron CDP target found on ${port}`);
  return openCdpSession(target.webSocketDebuggerUrl);
}

async function waitForRendererReady(cdp, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const state = await cdp.evaluate(`({
        readyState: document.readyState,
        appShell: Boolean(document.querySelector('.app')),
        preload: Boolean(window.electronAPI && typeof window.electronAPI.writeClipboardText === 'function'),
      })`);
      if (state?.readyState === 'complete' && state.appShell && state.preload) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`Electron renderer readiness timeout${lastError ? `: ${lastError.message}` : ''}`);
}

async function openCdpSession(url) {
  const socket = new WebSocket(url);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP websocket failed to open")), { once: true });
  });

  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message || "CDP command failed"));
    else request.resolve(message.result);
  });

  function command(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolveCommand, rejectCommand) => {
      pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  await command("Runtime.enable");
  return {
    async evaluate(expression) {
      const response = await command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      });
      if (response.exceptionDetails) {
        const description = response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Renderer evaluation failed";
        throw new Error(description);
      }
      return response.result?.value;
    },
    close() {
      socket.close();
    },
  };
}

function collect(stream) {
  let text = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk) => { text += chunk; });
  return () => text;
}

async function runCommand(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const code = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", resolveExit);
  });
  if (code !== 0) throw new Error(`${command} exited with ${code}\n${stderr()}\n${stdout()}`);
  const output = stdout().trim();
  if (output) console.log(`[e2e] renderer ${output.split("\n").at(-1)}`);
  return output;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  await signalProcessTree(child.pid);
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    sleep(5000).then(async () => {
      if (child.exitCode === null) await signalProcessTree(child.pid, { force: true });
    }),
  ]);
}

async function stopPid(pid) {
  if (!(await signalProcessTree(pid))) return;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await sleep(100);
  }
  await signalProcessTree(pid, { force: true }).catch(() => {});
}

function sleep(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}
