// Real Electron check for the update requests: they go through net.fetch (Chromium's
// network stack, so the system proxy applies) and not Node's globalThis.fetch.
//
// Opt-in: it needs a display, the Electron binary and the live update feed.
//   MOSA_NET_FETCH_LIVE=1 node --test test/update-net-fetch-electron.test.mjs
// Only GET/HEAD (plus a 1 KiB Range read) go to the live feed and download host.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { removeTestPath as rm } from "./test-cleanup.mjs";

const root = resolve(import.meta.dirname, "..");
const electronPath = process.platform === "darwin"
  ? resolve(root, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron")
  : process.platform === "win32"
    ? resolve(root, "node_modules", "electron", "dist", "electron.exe")
    : resolve(root, "node_modules", "electron", "dist", "electron");
const FEED_HOST = "gravityport.azhuilab.com";
const FEED_KEY_ID = "235d3651f80176bed99098cab6a4c6fe0581d0206e23f691af2c8bf88aa9839f";

// The Electron main process: runs one probe and writes its result to a file.
const PROBE_MAIN = `
const { app, net, session } = require("electron");
const { writeFileSync } = require("node:fs");
const { pathToFileURL } = require("node:url");

const FEED_URL = "https://${FEED_HOST}/releases/gravityport/latest.json";

app.whenReady().then(async () => {
  const result = { mode: process.env.MOSA_NET_FETCH_MODE, errors: [] };
  try {
    if (process.env.MOSA_NET_FETCH_PROXY_PORT) {
      const port = process.env.MOSA_NET_FETCH_PROXY_PORT;
      await session.defaultSession.setProxy({ proxyRules: "http=127.0.0.1:" + port + ";https=127.0.0.1:" + port });
    }
    const update = await import(pathToFileURL(process.env.MOSA_NET_FETCH_UPDATE_SERVICE).href);
    const macos = await import(pathToFileURL(process.env.MOSA_NET_FETCH_MACOS_UPDATER).href);
    const fetchImpl = result.mode === "node"
      ? globalThis.fetch
      : (url, init) => net.fetch(url, init);
    const check = await update.checkForMosaUpdate({ currentVersion: "0.3.0", fetchImpl, timeoutMs: 30000 });
    result.latestVersion = check.latestVersion;
    result.updateAvailable = check.updateAvailable;
    const feedResponse = await fetchImpl(FEED_URL, { method: "GET", headers: { accept: "application/json" }, redirect: "error" });
    const feed = JSON.parse(await feedResponse.text());
    result.feedKeyId = feed.signature && feed.signature.keyId;
    result.macFile = feed.platforms && feed.platforms.macos && feed.platforms.macos.file;
    if (result.mode === "net" && result.macFile) {
      const url = macos.macosUpdateDownloadUrl({ file: result.macFile });
      // Same headers the real downloader sends, plus a Range so only 1 KiB moves.
      const range = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/zip, application/octet-stream", "accept-encoding": "identity", "cache-control": "no-cache", Range: "bytes=0-1023" },
        redirect: "error",
      });
      result.rangeStatus = range.status;
      result.rangeBytes = (await range.arrayBuffer()).byteLength;
    }
  } catch (error) {
    result.errors.push(String(error && error.stack || error));
  }
  writeFileSync(process.env.MOSA_NET_FETCH_RESULT, JSON.stringify(result));
  app.exit(0);
});
`;

function versionAtLeast(version, floor) {
  const a = String(version).split(/[.-]/).slice(0, 3).map(Number);
  const b = floor.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] || 0) !== b[index]) return (a[index] || 0) > b[index];
  }
  return true;
}

// Minimal CONNECT proxy: records every tunnel target and relays it.
function startConnectProxy() {
  const tunnels = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  server.on("connect", (request, clientSocket, head) => {
    tunnels.push(request.url);
    const [host, port] = request.url.split(":");
    const upstream = connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
    sockets.add(upstream);
  });
  return new Promise((resolveStart) => {
    server.listen(0, "127.0.0.1", () => {
      resolveStart({
        port: server.address().port,
        tunnels,
        close: () => new Promise((resolveClose) => {
          for (const socket of sockets) socket.destroy();
          server.close(resolveClose);
        }),
      });
    });
  });
}

async function runProbe({ mode, proxyPort = null }) {
  const dir = await mkdtemp(join(tmpdir(), "mosa-net-fetch-probe-"));
  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "mosa-net-fetch-probe", main: "main.cjs" }), "utf8");
    await writeFile(join(dir, "main.cjs"), PROBE_MAIN, "utf8");
    const resultPath = join(dir, "result.json");
    const env = {
      ...process.env,
      MOSA_NET_FETCH_MODE: mode,
      MOSA_NET_FETCH_RESULT: resultPath,
      MOSA_NET_FETCH_UPDATE_SERVICE: join(root, "desktop", "update-service.mjs"),
      MOSA_NET_FETCH_MACOS_UPDATER: join(root, "desktop", "macos-updater.mjs"),
      MOSA_NET_FETCH_PROXY_PORT: proxyPort ? String(proxyPort) : "",
    };
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
    delete env.http_proxy;
    delete env.https_proxy;
    const child = spawn(electronPath, [`--user-data-dir=${join(dir, "user-data")}`, dir], { env, stdio: "ignore" });
    const exited = new Promise((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", resolveExit);
    });
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    await exited;
    clearTimeout(killTimer);
    return JSON.parse(await readFile(resultPath, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("update requests pass through the system proxy on real Electron", { skip: process.env.MOSA_NET_FETCH_LIVE !== "1" }, async () => {
  const proxy = await startConnectProxy();
  try {
    const viaNet = await runProbe({ mode: "net", proxyPort: proxy.port });
    assert.deepEqual(viaNet.errors, [], viaNet.errors.join("\n"));
    assert.equal(viaNet.feedKeyId, FEED_KEY_ID, "the live feed is signed by the pinned primary key");
    assert.equal(versionAtLeast(viaNet.latestVersion, "0.3.7"), true, `latest version ${viaNet.latestVersion}`);
    assert.ok(
      proxy.tunnels.includes(`${FEED_HOST}:443`),
      `proxy saw CONNECT ${FEED_HOST}:443 (saw: ${proxy.tunnels.join(", ") || "none"})`,
    );
    assert.equal(viaNet.rangeStatus, 206, "the download host honors Range");
    assert.equal(viaNet.rangeBytes, 1024);

    const before = proxy.tunnels.length;
    const viaNode = await runProbe({ mode: "node", proxyPort: proxy.port });
    assert.deepEqual(viaNode.errors, [], viaNode.errors.join("\n"));
    const nodeTunnels = proxy.tunnels.slice(before);
    assert.equal(
      nodeTunnels.some((target) => target.startsWith(FEED_HOST)),
      false,
      "globalThis.fetch bypasses the Electron system proxy (the bug this change fixes)",
    );
  } finally {
    await proxy.close();
  }
});
