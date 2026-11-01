#!/usr/bin/env node
// Verification script for service outbound requests through Chromium network stack (task 324).
// Exercises Electron with real Chromium network stack across 8 scenarios (A to H).
import "../lib/apply-env-aliases.mjs";

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureElectronExecutablePath } from "./desktop-runtime-paths.mjs";
import { signalProcessTree } from "./process-tree.mjs";
import {
  getDeadPort,
  startAuthProxy,
  startFakeFeedbackCollector,
  startFakePinterestServer,
  startHttpProxy,
  startPacServer,
  startRedirectTarget,
  startSocks5Proxy,
} from "../test/helpers/local-network-fakes.mjs";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const REPO_ROOT = resolve(__dirname, "..");
const LOG_JSON_PATH = resolve(REPO_ROOT, "..", "tasks", "logs", "324-electron-proxy.json");
const QA_CLIENT_TOKEN = randomBytes(32).toString("base64url");
const DISABLED_BRIDGES = "cowart,cowartDiscovery,codex,grok";
const electronBinary = ensureElectronExecutablePath({ rootDir: REPO_ROOT });

if (!existsSync(electronBinary)) {
  throw new Error(`Electron binary not found: ${electronBinary}`);
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address.port;
      server.close(() => {
        if (port === 43517) {
          freePort().then(resolvePort, reject);
        } else {
          resolvePort(port);
        }
      });
    });
  });
}

function sleep(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

// Every Electron main pid this script started. Cleanup only ever signals these
// pids and the descendants found under them, never anything matched by name.
const launchedPids = new Set();

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function listDescendants(rootPid) {
  if (process.platform === "win32") return [];
  let table = "";
  try {
    table = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const children = new Map();
  for (const line of table.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const found = [];
  const queue = [rootPid];
  while (queue.length) {
    for (const child of children.get(queue.shift()) || []) {
      if (child > 1 && !found.includes(child)) {
        found.push(child);
        queue.push(child);
      }
    }
  }
  return found;
}

async function stopPid(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  const descendants = listDescendants(pid);
  if (await signalProcessTree(pid)) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && isAlive(pid)) await sleep(100);
    if (isAlive(pid)) await signalProcessTree(pid, { force: true }).catch(() => {});
  }
  for (const child of descendants) {
    if (isAlive(child)) {
      try {
        process.kill(child, "SIGKILL");
      } catch {}
    }
  }
  launchedPids.delete(pid);
}

// Last-resort cleanup when the script itself crashes or is interrupted: the
// instances must not outlive it (task 324 left two orphaned instances).
function killLaunchedSync() {
  for (const pid of launchedPids) {
    if (!Number.isInteger(pid) || pid <= 1) continue;
    for (const child of listDescendants(pid)) {
      try {
        process.kill(child, "SIGKILL");
      } catch {}
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  launchedPids.clear();
}
process.on("exit", killLaunchedSync);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    killLaunchedSync();
    process.exit(1);
  });
}

class LaunchFailure extends Error {}

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
  if (!target?.webSocketDebuggerUrl) throw new Error(`No Electron CDP target found on port ${port}`);
  return openCdpSession(target.webSocketDebuggerUrl);
}

async function openCdpSession(wsUrl) {
  const socket = new WebSocket(wsUrl);
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
  await command("Network.enable");

  return {
    command,
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

async function waitForRendererReady(cdp, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const state = await cdp.evaluate(`({
        readyState: document.readyState,
        appShell: Boolean(document.querySelector('.app')),
        hasBridge: Boolean(window.electronAPI && typeof window.electronAPI.getClientToken === 'function'),
      })`);
      if (state?.readyState === "complete" && state.appShell && state.hasBridge) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`Renderer readiness timeout${lastError ? `: ${lastError.message}` : ""}`);
}

async function writeExpiredPinterestToken(userDataDir) {
  const tokenPath = join(userDataDir, "pinterest-auth.json");
  const token = {
    access_token: "expired_access_token_123",
    refresh_token: "valid_refresh_token_456",
    access_expires_at: new Date(Date.now() - 3600000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 86400000 * 30).toISOString(),
    scope: "boards:read,user_accounts:read,pins:read",
    username: "qa_pinterest_user",
    connected_at: new Date(Date.now() - 86400000).toISOString(),
  };
  await writeFile(tokenPath, JSON.stringify(token, null, 2), { mode: 0o600 });
}

async function launchIsolatedInstance({
  extraArgs = [],
  extraEnv = {},
  seedPinterest = false,
}) {
  const rootDir = await mkdtemp(join(tmpdir(), "mosa-service-proxy-qa-"));
  const libraryDir = join(rootDir, "library");
  const userData = join(rootDir, "user-data");
  await mkdir(libraryDir, { recursive: true });
  await mkdir(userData, { recursive: true });

  if (seedPinterest) {
    await writeExpiredPinterestToken(userData);
  }

  const servicePort = await freePort();
  const cdpPort = await freePort();
  const logFile = join(rootDir, "main.log");

  const env = {
    ...process.env,
    MOSA_RUNTIME_MODE: "qa",
    MOSA_QA_RUN: "1",
    MOSA_CLIENT_TOKEN: QA_CLIENT_TOKEN,
    MOSA_LIBRARY_DIR: libraryDir,
    MOSA_USER_DATA: userData,
    MOSA_DISABLE_BRIDGES: DISABLED_BRIDGES,
    MOSA_DESKTOP_PORT: String(servicePort),
    ...extraEnv,
  };

  const args = [
    "desktop/main.mjs",
    `--user-data-dir=${userData}`,
    `--remote-debugging-port=${cdpPort}`,
    ...extraArgs,
  ];

  const logStream = createWriteStream(logFile, { flags: "a" });
  const child = spawn(electronBinary, args, {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(logStream, { end: false });
  child.stderr?.pipe(logStream, { end: false });
  child.once("close", () => logStream.end());

  const pid = child.pid;
  if (Number.isInteger(pid) && pid > 1) launchedPids.add(pid);

  let cdp = null;
  try {
    // Poll health URL
    const healthUrl = `http://127.0.0.1:${servicePort}/api/health`;
    const deadline = Date.now() + 30000;
    let healthy = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        await sleep(100);
        const log = await readFile(logFile, "utf8").catch(() => "");
        throw new Error(`Electron exited early with code ${child.exitCode}\n--- Electron log ---\n${log}\n--------------------`);
      }
      try {
        const res = await fetch(healthUrl);
        if (res.ok) {
          healthy = true;
          break;
        }
      } catch {}
      await sleep(150);
    }
    if (!healthy) {
      const log = await readFile(logFile, "utf8").catch(() => "");
      throw new Error(`Health timeout on ${healthUrl}\nLog: ${log}`);
    }

    cdp = await connectCdp(cdpPort, `http://127.0.0.1:${servicePort}`);
    await waitForRendererReady(cdp);
  } catch (error) {
    // A failed start stops the whole run (no retries): close what we started
    // first, then let the caller abort.
    try {
      cdp?.close();
    } catch {}
    await stopPid(pid);
    await rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
    throw new LaunchFailure(`Electron test instance failed to start: ${error.message}`);
  }

  async function close() {
    try {
      cdp.close();
    } catch {}
    if (pid) await stopPid(pid);
    if (child.exitCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
    await sleep(200);
    await rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }

  return {
    rootDir,
    servicePort,
    cdpPort,
    pid,
    cdp,
    close,
  };
}

async function triggerFeedbackInPage(cdp, message = "QA feedback test") {
  return cdp.evaluate(`(async () => {
    const token = (await window.electronAPI.getClientToken?.()) || sessionStorage.getItem("mosa.client-token") || "";
    const res = await fetch("/api/feedback/submit", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mosa-client-token": token,
      },
      body: JSON.stringify({
        kind: "bug",
        message: ${JSON.stringify(message)},
        locale: "zh",
      }),
    });
    const status = res.status;
    const body = await res.json().catch(() => ({}));
    return { status, body };
  })()`);
}

async function triggerPinterestInPage(cdp) {
  return cdp.evaluate(`(async () => {
    const token = (await window.electronAPI.getClientToken?.()) || sessionStorage.getItem("mosa.client-token") || "";
    const res = await fetch("/api/pinterest/boards", {
      headers: {
        "x-mosa-client-token": token,
      },
    });
    const status = res.status;
    const body = await res.json().catch(() => ({}));
    return { status, body };
  })()`);
}

const results = {
  timestamp: new Date().toISOString(),
  allPassed: false,
  scenarios: {},
};

async function runAllScenarios() {
  console.log("=== Starting Task 324 QA Service Proxy Verification ===");

  // --- Scenario A: No Proxy ---
  console.log("\n[Scenario A] No Proxy (Direct Connection)");
  {
    const collector = await startFakeFeedbackCollector();
    const pinServer = await startFakePinterestServer();
    const proxy = await startHttpProxy();
    console.log(`  MOSA_FEEDBACK_URL=${collector.url}`);

    let inst = null;
    let passed = false;
    let detail = {};
    try {
      inst = await launchIsolatedInstance({
        extraArgs: [],
        extraEnv: {
          MOSA_FEEDBACK_URL: collector.url,
          MOSA_PINTEREST_TOKEN_URL: pinServer.tokenUrl,
          MOSA_PINTEREST_API_BASE: pinServer.apiBase,
        },
        seedPinterest: true,
      });

      const fb = await triggerFeedbackInPage(inst.cdp);
      const pin = await triggerPinterestInPage(inst.cdp);

      assert.equal(fb.status, 200, "Feedback succeeded");
      assert.equal(pin.status, 200, "Pinterest succeeded");
      assert.ok(collector.requests.length >= 1, "Collector received feedback");
      assert.ok(pinServer.requests.some((r) => r.url.includes("token")), "PinServer received token refresh");
      assert.ok(pinServer.requests.some((r) => r.url.includes("boards")), "PinServer received boards API");
      assert.equal(proxy.requests.length, 0, "Proxy received 0 requests in direct mode");

      passed = true;
      detail = {
        collectorRequests: collector.requests.length,
        pinRequests: pinServer.requests.length,
        proxyRequests: proxy.requests.length,
      };
      console.log(`  ✔ Scenario A PASSED: Collector=${collector.requests.length}, Pin=${pinServer.requests.length}, Proxy=${proxy.requests.length}`);
    } catch (err) {
      if (err instanceof LaunchFailure) throw err;
      console.error(`  ✖ Scenario A FAILED: ${err.message}`);
      detail = { error: err.message };
    } finally {
      if (inst) await inst.close();
      await collector.close();
      await pinServer.close();
      await proxy.close();
    }
    results.scenarios.A = { name: "No Proxy", passed, detail };
  }

  // --- Scenario B: HTTP Proxy ---
  console.log("\n[Scenario B] HTTP Proxy");
  {
    const collector = await startFakeFeedbackCollector();
    const pinServer = await startFakePinterestServer();
    const proxy = await startHttpProxy();
    console.log(`  MOSA_FEEDBACK_URL=${collector.url}`);
    console.log(`  Proxy URL=${proxy.url}`);

    let inst = null;
    let passed = false;
    let detail = {};
    try {
      inst = await launchIsolatedInstance({
        extraArgs: [
          `--proxy-server=${proxy.url}`,
          "--proxy-bypass-list=<-loopback>",
        ],
        extraEnv: {
          MOSA_FEEDBACK_URL: collector.url,
          MOSA_PINTEREST_TOKEN_URL: pinServer.tokenUrl,
          MOSA_PINTEREST_API_BASE: pinServer.apiBase,
        },
        seedPinterest: true,
      });

      const fb = await triggerFeedbackInPage(inst.cdp);
      const pin = await triggerPinterestInPage(inst.cdp);

      assert.equal(fb.status, 200, "Feedback succeeded");
      assert.equal(pin.status, 200, "Pinterest succeeded");

      // With <-loopback> the page's own calls to the local service also pass
      // the proxy, so only count requests addressed to the fake upstreams.
      const fbProxyReq = proxy.requests.find((r) => r.method === "POST" && r.url === collector.url);
      const tokenProxyReq = proxy.requests.find((r) => r.method === "POST" && r.url === pinServer.tokenUrl);
      const apiProxyReq = proxy.requests.find((r) => r.method === "GET" && r.url.startsWith(`${pinServer.apiBase}/boards`));

      assert.ok(fbProxyReq, "Proxy recorded the service's feedback POST to the collector");
      assert.ok(tokenProxyReq, "Proxy recorded the service's token refresh POST");
      assert.ok(apiProxyReq, "Proxy recorded the service's boards API GET");
      assert.equal(collector.requests.length, 1, "Collector received the forwarded feedback");
      assert.equal(proxy.blocked.length, 0, "No request tried to leave the machine");

      passed = true;
      detail = {
        totalProxyRequests: proxy.requests.length,
        fbProxyUrl: fbProxyReq.url,
        tokenProxyUrl: tokenProxyReq.url,
        apiProxyUrl: apiProxyReq.url,
        proxyRequests: proxy.requests.map((r) => `${r.method} ${r.url}`),
        collectorRequests: collector.requests.map((r) => `${r.method} ${r.url}`),
        pinRequests: pinServer.requests.map((r) => `${r.method} ${r.url}`),
      };
      console.log(`  ✔ Scenario B PASSED: Proxy recorded ${proxy.requests.length} requests (feedback, token refresh, and api)`);
    } catch (err) {
      if (err instanceof LaunchFailure) throw err;
      console.error(`  ✖ Scenario B FAILED: ${err.message}`);
      detail = { error: err.message };
    } finally {
      if (inst) await inst.close();
      await collector.close();
      await pinServer.close();
      await proxy.close();
    }
    results.scenarios.B = { name: "HTTP Proxy", passed, detail };
  }

  // --- Scenario C: PAC Multiple Candidates ---
  console.log("\n[Scenario C] PAC Multiple Candidates (Failover)");
  {
    const collector = await startFakeFeedbackCollector();
    const deadPort = await getDeadPort();
    const proxy = await startHttpProxy();
    const pacScript = `PROXY 127.0.0.1:${deadPort}; PROXY 127.0.0.1:${proxy.port}`;
    const pacServer = await startPacServer(pacScript);
    const feedbackUrl = `http://feedback.test:${collector.port}/api/feedback`;
    console.log(`  MOSA_FEEDBACK_URL=${feedbackUrl}`);
    console.log(`  PAC URL=${pacServer.pacUrl} (Candidates: deadPort=${deadPort}, liveProxy=${proxy.port})`);

    let inst = null;
    let passed = false;
    let detail = {};
    try {
      inst = await launchIsolatedInstance({
        extraArgs: [
          `--proxy-pac-url=${pacServer.pacUrl}`,
          "--host-resolver-rules=MAP feedback.test 127.0.0.1",
        ],
        extraEnv: {
          MOSA_FEEDBACK_URL: feedbackUrl,
        },
      });

      // Wait for PAC server to be fetched
      const pacDeadline = Date.now() + 10000;
      while (Date.now() < pacDeadline && pacServer.requests.length === 0) {
        await sleep(100);
      }

      const fb = await triggerFeedbackInPage(inst.cdp);
      assert.equal(fb.status, 200, "Feedback succeeded via PAC candidate");
      assert.equal(collector.requests.length, 1, "Collector received 1 feedback");
      assert.ok(proxy.requests.length >= 1, "Live proxy received the request after dead port failed");

      passed = true;
      detail = {
        collectorRequests: collector.requests.length,
        liveProxyRequests: proxy.requests.length,
      };
      console.log(`  ✔ Scenario C PASSED: Second candidate received request, feedback succeeded`);
    } catch (err) {
      if (err instanceof LaunchFailure) throw err;
      console.error(`  ✖ Scenario C FAILED: ${err.message}`);
      detail = { error: err.message };
    } finally {
      if (inst) await inst.close();
      await collector.close();
      await proxy.close();
      await pacServer.close();
    }
    results.scenarios.C = { name: "PAC Multiple Candidates", passed, detail };
  }

  // --- Scenario D: PAC Returns DIRECT ---
  console.log("\n[Scenario D] PAC Returns DIRECT");
  {
    const collector = await startFakeFeedbackCollector();
    const proxy = await startHttpProxy();
    const pacServer = await startPacServer("DIRECT");
    console.log(`  MOSA_FEEDBACK_URL=${collector.url}`);
    console.log(`  PAC URL=${pacServer.pacUrl}`);

    let inst = null;
    let passed = false;
    let detail = {};
    try {
      inst = await launchIsolatedInstance({
        extraArgs: [
          `--proxy-pac-url=${pacServer.pacUrl}`,
          "--proxy-bypass-list=<-loopback>",
        ],
        extraEnv: {
          MOSA_FEEDBACK_URL: collector.url,
        },
      });

      const fb = await triggerFeedbackInPage(inst.cdp);
      assert.equal(fb.status, 200, "Feedback succeeded directly");
      assert.equal(collector.requests.length, 1, "Collector received 1 feedback");
      assert.equal(proxy.requests.length, 0, "Proxy received 0 requests when PAC directs DIRECT");

      passed = true;
      detail = {
        collectorRequests: collector.requests.length,
        proxyRequests: proxy.requests.length,
      };
      console.log(`  ✔ Scenario D PASSED: Direct connection succeeded, proxy received 0 requests`);
    } catch (err) {
      if (err instanceof LaunchFailure) throw err;
      console.error(`  ✖ Scenario D FAILED: ${err.message}`);
      detail = { error: err.message };
    } finally {
      if (inst) await inst.close();
      await collector.close();
      await proxy.close();
      await pacServer.close();
    }
    results.scenarios.D = { name: "PAC Returns DIRECT", passed, detail };
  }

  // --- Scenario E: SOCKS5 ---
  console.log("\n[Scenario E] SOCKS5 Proxy");
  {
    const collector = await startFakeFeedbackCollector();
    const socks = await startSocks5Proxy();
    console.log(`  MOSA_FEEDBACK_URL=${collector.url}`);
    console.log(`  SOCKS5 Port=${socks.port}`);

    let inst = null;
    let passed = false;
    let detail = {};
    try {
      inst = await launchIsolatedInstance({
        extraArgs: [
          `--proxy-server=socks5://127.0.0.1:${socks.port}`,
          "--proxy-bypass-list=<-loopback>",
        ],
        extraEnv: {
          MOSA_FEEDBACK_URL: collector.url,
        },
      });

      const fb = await triggerFeedbackInPage(inst.cdp);
      assert.equal(fb.status, 200, "Feedback succeeded via SOCKS5");
      assert.equal(collector.requests.length, 1, "Collector received 1 feedback");

      const connectReq = socks.requests.find(
        (r) => r.cmd === "CONNECT" && r.port === collector.port,
      );
      assert.ok(connectReq, "SOCKS5 recorded CONNECT to collector port");
      assert.equal(socks.blocked.length, 0, "No connection tried to leave the machine");

      passed = true;
      detail = {
        collectorRequests: collector.requests.length,
        socksConnects: socks.requests.length,
        targetPort: connectReq?.port,
      };
      console.log(`  ✔ Scenario E PASSED: SOCKS5 recorded CONNECT to collector port, feedback succeeded`);
    } catch (err) {
      if (err instanceof LaunchFailure) throw err;
      console.error(`  ✖ Scenario E FAILED: ${err.message}`);
      detail = { error: err.message };
    } finally {
      if (inst) await inst.close();
      await collector.close();
      await socks.close();
    }
    results.scenarios.E = { name: "SOCKS5 Proxy", passed, detail };
  }

  // --- Scenario F: Proxy Auth 407 ---
  console.log("\n[Scenario F] Proxy Authentication Required (407)");
  {
    const authProxy = await startAuthProxy();
    const feedbackUrl = "http://feedback.test:9999/api/feedback";
    console.log(`  MOSA_FEEDBACK_URL=${feedbackUrl}`);
    console.log(`  Auth Proxy Port=${authProxy.port}`);

    let inst = null;
    let passed = false;
    let detail = {};
    try {
      inst = await launchIsolatedInstance({
        extraArgs: [
          `--proxy-server=${authProxy.url}`,
        ],
        extraEnv: {
          MOSA_FEEDBACK_URL: feedbackUrl,
          MOSA_FEEDBACK_TIMEOUT_MS: "3000",
        },
      });

      const t0 = Date.now();
      const fb = await triggerFeedbackInPage(inst.cdp);
      const elapsed = Date.now() - t0;

      assert.notEqual(fb.status, 200, "Feedback returned non-200");
      assert.ok(elapsed <= 5000, `Returned within timeout (${elapsed}ms <= 5000ms)`);

      // Verify Electron instance is still alive
      let isAlive = false;
      try {
        process.kill(inst.pid, 0);
        isAlive = true;
      } catch {}
      assert.ok(isAlive, "Electron process is still alive");

      // Verify no extra auth dialog windows opened
      const targetsRes = await fetch(`http://127.0.0.1:${inst.cdpPort}/json/list`);
      const targets = await targetsRes.json();
      const pageTargets = targets.filter((t) => t.type === "page");
      assert.equal(pageTargets.length, 1, "CDP target list has no extra windows");

      passed = true;
      detail = {
        feedbackStatus: fb.status,
        elapsedMs: elapsed,
        processAlive: isAlive,
        pageTargetCount: pageTargets.length,
      };
      console.log(`  ✔ Scenario F PASSED: Non-200 in ${elapsed}ms, process alive, no popup windows`);
    } catch (err) {
      if (err instanceof LaunchFailure) throw err;
      console.error(`  ✖ Scenario F FAILED: ${err.message}`);
      detail = { error: err.message };
    } finally {
      if (inst) await inst.close();
      await authProxy.close();
    }
    results.scenarios.F = { name: "Proxy Auth 407", passed, detail };
  }

  // --- Scenario G: Redirect ---
  console.log("\n[Scenario G] 302 Redirect Blocked");
  {
    const target = await startRedirectTarget();
    const collector = await startFakeFeedbackCollector({ redirectUrl: target.url });
    const proxy = await startHttpProxy();
    console.log(`  MOSA_FEEDBACK_URL=${collector.url}`);
    console.log(`  Redirect Target=${target.url}`);
    console.log(`  Proxy URL=${proxy.url}`);

    let inst = null;
    let passed = false;
    let detail = {};
    try {
      inst = await launchIsolatedInstance({
        extraArgs: [
          `--proxy-server=${proxy.url}`,
          "--proxy-bypass-list=<-loopback>",
        ],
        extraEnv: {
          MOSA_FEEDBACK_URL: collector.url,
        },
      });

      const fb = await triggerFeedbackInPage(inst.cdp);
      assert.equal(fb.status, 502, "Feedback endpoint returned 502 when redirect encountered");
      assert.equal(target.requests.length, 0, "Redirect target received 0 requests (redirect not followed)");

      passed = true;
      detail = {
        feedbackStatus: fb.status,
        targetRequests: target.requests.length,
      };
      console.log(`  ✔ Scenario G PASSED: Feedback returned 502, target received 0 requests`);
    } catch (err) {
      if (err instanceof LaunchFailure) throw err;
      console.error(`  ✖ Scenario G FAILED: ${err.message}`);
      detail = { error: err.message };
    } finally {
      if (inst) await inst.close();
      await collector.close();
      await target.close();
      await proxy.close();
    }
    results.scenarios.G = { name: "Redirect 302", passed, detail };
  }

  // --- Scenario H: Cookie Omission ---
  console.log("\n[Scenario H] Cookie Omission");
  {
    const collector = await startFakeFeedbackCollector({ setCookie: true });
    console.log(`  MOSA_FEEDBACK_URL=${collector.url}`);

    let inst = null;
    let passed = false;
    let detail = {};
    try {
      inst = await launchIsolatedInstance({
        extraArgs: [],
        extraEnv: {
          MOSA_FEEDBACK_URL: collector.url,
        },
      });

      // First request (collector sets cookie in response)
      const fb1 = await triggerFeedbackInPage(inst.cdp, "First feedback");
      assert.equal(fb1.status, 200, "First feedback succeeded");

      // Second request (outbound net.fetch should omit cookies)
      const fb2 = await triggerFeedbackInPage(inst.cdp, "Second feedback");
      assert.equal(fb2.status, 200, "Second feedback succeeded");

      assert.equal(collector.requests.length, 2, "Collector received 2 requests");
      const req2Cookie = collector.requests[1].headers.cookie;
      assert.equal(req2Cookie, undefined, "Second outbound request did not send any Cookie header");

      // Verify renderer session has no collector cookie
      const cookiesInCdp = await inst.cdp.command("Network.getCookies", { urls: [collector.url] });
      const fbCookieInCdp = cookiesInCdp.cookies.find((c) => c.name === "mosa_fb_cookie");
      assert.equal(fbCookieInCdp, undefined, "No collector cookie stored in renderer session");

      const docCookie = await inst.cdp.evaluate("document.cookie");
      assert.ok(!docCookie.includes("mosa_fb_cookie"), "document.cookie does not contain collector cookie");

      passed = true;
      detail = {
        totalRequests: collector.requests.length,
        req2CookieHeader: req2Cookie || null,
        cdpCookiesCount: cookiesInCdp.cookies.length,
      };
      console.log(`  ✔ Scenario H PASSED: Second request sent no cookie, 0 cookies in session`);
    } catch (err) {
      if (err instanceof LaunchFailure) throw err;
      console.error(`  ✖ Scenario H FAILED: ${err.message}`);
      detail = { error: err.message };
    } finally {
      if (inst) await inst.close();
      await collector.close();
    }
    results.scenarios.H = { name: "Cookie Omission", passed, detail };
  }

  // Every instance must be gone before the run counts as passed.
  const leftovers = [...launchedPids].filter(isAlive);
  results.leftoverInstances = leftovers;
  console.log(`\nLeftover Electron instances: ${leftovers.length}`);

  // Check all scenarios
  const allPassed = leftovers.length === 0 && Object.values(results.scenarios).every((s) => s.passed);
  results.allPassed = allPassed;

  await mkdir(dirname(LOG_JSON_PATH), { recursive: true });
  await writeFile(LOG_JSON_PATH, JSON.stringify(results, null, 2), "utf8");
  console.log(`\nResults written to: ${LOG_JSON_PATH}`);

  if (!allPassed) {
    console.error("❌ Some scenarios failed.");
    process.exit(1);
  } else {
    console.log("✅ All 8 scenarios passed!");
    process.exit(0);
  }
}

try {
  await runAllScenarios();
} catch (error) {
  // Launch failures and unexpected errors stop the run without retrying.
  killLaunchedSync();
  results.allPassed = false;
  results.aborted = error.message;
  console.error(`\n✖ Aborted: ${error.message}`);
  await mkdir(dirname(LOG_JSON_PATH), { recursive: true }).catch(() => {});
  await writeFile(LOG_JSON_PATH, JSON.stringify(results, null, 2), "utf8").catch(() => {});
  process.exit(1);
}
