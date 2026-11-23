/**
 * Behavior tests for the extension options page (task 460).
 *
 * Boots the real extensions/chatgpt-web-capture/options.js through
 * createOptionsHarness (vm context, real WebCrypto HMAC verification,
 * stub DOM/chrome/fetch).
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createOptionsHarness, identityProof } from "./helpers/provider-sites-harness.mjs";

const BASE_URL = "http://127.0.0.1:43517";
const DOWNLOAD_URL = "https://gravityport.azhuilab.com/#download";

function makeIdentityHandler(baseUrl, token) {
  return async (url, init) => {
    const parsed = new URL(url);
    if (parsed.origin === baseUrl && parsed.pathname === "/api/web-capture/identity") {
      const { nonce } = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ proof: await identityProof(baseUrl, token, nonce) }),
      };
    }
    return undefined;
  };
}

function makeConnectedHandler(baseUrl, token, version = "0.3.17") {
  const idHandler = makeIdentityHandler(baseUrl, token);
  return async (url, init) => {
    const idReply = await idHandler(url, init);
    if (idReply) return idReply;
    const parsed = new URL(url);
    if (parsed.origin === baseUrl && parsed.pathname === "/api/ingest/web-capture") {
      return { ok: false, status: 400, json: async () => ({ code: "WEB_CAPTURE_BAD_IMAGE" }) };
    }
    if (parsed.origin === baseUrl && parsed.pathname === "/api/health") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ product: "mosa", productVersion: version }),
      };
    }
    return undefined;
  };
}

// 1. 加载
test("1. loads settings from chrome.storage.local, defaults autoCapture off, never calls getSettings/repairPairing, starts in checking", async () => {
  let releaseHealth;
  const pendingHealth = new Promise((resolve) => {
    releaseHealth = resolve;
  });

  const harness = await createOptionsHarness({
    autoFlush: false,
    storageLocal: [
      ["mosaBaseUrl", "http://127.0.0.1:43518"],
      ["mosaToken", "saved-token"],
    ],
    fetchHandler: async () => pendingHealth,
  });

  assert.equal(harness.elements.connection.dataset.state, "checking", "page immediately starts in checking state");
  assert.equal(harness.elements.connectionTitle.textContent, "正在检查连接…");
  assert.equal(harness.elements.connectionAction.hidden, true);
  assert.equal(harness.elements.connectionQuiet.hidden, true);
  assert.equal(harness.elements.connectionLink.hidden, true);

  await harness.flush();
  assert.equal(harness.elements.mosaBaseUrl.value, "http://127.0.0.1:43518");
  assert.equal(harness.elements.mosaToken.value, "saved-token");
  assert.equal(harness.elements.autoCapture.getAttribute("aria-checked"), "false", "autoCapture defaults off when omitted");
  assert.equal(
    harness.runtimeMessages.some((msg) => msg?.type === "mosa.getSettings" || msg?.type === "mosa.repairPairing"),
    false,
    "load must never send mosa.getSettings or mosa.repairPairing",
  );

  releaseHealth(undefined);
  await harness.flush();

  const storedOn = await createOptionsHarness({
    storageLocal: [
      ["mosaBaseUrl", BASE_URL],
      ["mosaToken", ""],
      ["autoCapture", true],
    ],
  });
  assert.equal(storedOn.elements.autoCapture.getAttribute("aria-checked"), "true", "stored autoCapture=true turns switch on");
  assert.equal(storedOn.runtimeMessages.length, 0, "empty token load does not trigger background pairing");
});

// 2. 状态表每一行
test("2. renders every state row with expected data-state, title, buttons, and ARIA role", async () => {
  // connected (with version and host)
  {
    const h = await createOptionsHarness({
      storageLocal: [["mosaBaseUrl", BASE_URL], ["mosaToken", "tok-ok"]],
      fetchHandler: makeConnectedHandler(BASE_URL, "tok-ok", "0.3.17"),
    });
    assert.equal(h.elements.connection.dataset.state, "connected");
    assert.equal(h.elements.connection.getAttribute("role"), "status");
    assert.equal(h.elements.connectionTitle.textContent, "已连接 GravityPort");
    assert.ok(h.elements.connectionDetail.textContent.includes("0.3.17"), "detail includes version");
    assert.ok(h.elements.connectionDetail.textContent.includes("127.0.0.1:43517"), "detail includes host without scheme");
    assert.equal(h.elements.connectionAction.hidden, true);
    assert.equal(h.elements.connectionQuiet.hidden, false);
    assert.equal(h.elements.connectionQuiet.textContent, "重新检查");
    assert.equal(h.elements.connectionLink.hidden, true);
  }

  // connected (without version)
  {
    const h = await createOptionsHarness({
      storageLocal: [["mosaBaseUrl", BASE_URL], ["mosaToken", "tok-ok"]],
      fetchHandler: makeConnectedHandler(BASE_URL, "tok-ok", ""),
    });
    assert.equal(h.elements.connection.dataset.state, "connected");
    assert.equal(h.elements.connectionDetail.textContent, "127.0.0.1:43517。收录的图片和视频会直接存进素材库。");
  }

  // pair
  {
    const h = await createOptionsHarness({
      storageLocal: [["mosaBaseUrl", BASE_URL], ["mosaToken", ""]],
      fetchHandler: async (url) => (
        url === `${BASE_URL}/api/health`
          ? { ok: true, status: 200, json: async () => ({ product: "mosa", productVersion: "0.3.17" }) }
          : undefined
      ),
    });
    assert.equal(h.elements.connection.dataset.state, "pair");
    assert.equal(h.elements.connection.getAttribute("role"), "status");
    assert.equal(h.elements.connectionTitle.textContent, "还没有连接 GravityPort");
    assert.equal(h.elements.connectionAction.hidden, false);
    assert.equal(h.elements.connectionAction.textContent, "连接 GravityPort");
    assert.equal(h.elements.connectionNote.hidden, true);
  }

  // offline
  {
    const h = await createOptionsHarness({
      storageLocal: [["mosaBaseUrl", BASE_URL], ["mosaToken", ""]],
    });
    assert.equal(h.elements.connection.dataset.state, "offline");
    assert.equal(h.elements.connection.getAttribute("role"), "alert");
    assert.equal(h.elements.connectionTitle.textContent, "没有找到 GravityPort");
    assert.equal(h.elements.connectionAction.hidden, false);
    assert.equal(h.elements.connectionAction.textContent, "重新检查");
    assert.equal(h.elements.connectionLink.hidden, false);
    assert.equal(h.elements.connectionLink.textContent, "还没安装？前往官网下载");
    assert.equal(h.elements.connectionLink.getAttribute("href"), DOWNLOAD_URL);
  }

  // moved
  {
    const h = await createOptionsHarness({
      storageLocal: [["mosaBaseUrl", BASE_URL], ["mosaToken", "tok-moved"]],
      fetchHandler: async (url) => (
        url === "http://127.0.0.1:43519/api/health"
          ? { ok: true, status: 200, json: async () => ({ product: "mosa", productVersion: "0.3.17" }) }
          : undefined
      ),
    });
    assert.equal(h.elements.connection.dataset.state, "moved");
    assert.equal(h.elements.connection.getAttribute("role"), "alert");
    assert.equal(h.elements.connectionTitle.textContent, "需要重新连接");
    assert.ok(h.elements.connectionDetail.textContent.includes("127.0.0.1:43519"));
    assert.equal(h.elements.connectionAction.hidden, false);
    assert.equal(h.elements.connectionAction.textContent, "重新连接");
  }

  // reconnect: 401 WEB_CAPTURE_UNAUTHORIZED
  {
    const idHandler = makeIdentityHandler(BASE_URL, "stale-tok");
    const h = await createOptionsHarness({
      storageLocal: [["mosaBaseUrl", BASE_URL], ["mosaToken", "stale-tok"]],
      fetchHandler: async (url, init) => (await idHandler(url, init))
        ?? (new URL(url).pathname === "/api/ingest/web-capture"
          ? { ok: false, status: 401, json: async () => ({ code: "WEB_CAPTURE_UNAUTHORIZED" }) }
          : undefined),
    });
    assert.equal(h.elements.connection.dataset.state, "reconnect");
    assert.equal(h.elements.connection.getAttribute("role"), "alert");
    assert.equal(h.elements.connectionTitle.textContent, "需要重新连接");
    assert.equal(h.elements.connectionAction.hidden, false);
    assert.equal(h.elements.connectionAction.textContent, "重新连接");
  }

  // reconnect: identity mismatch
  {
    const h = await createOptionsHarness({
      storageLocal: [["mosaBaseUrl", BASE_URL], ["mosaToken", "my-tok"]],
      fetchHandler: makeIdentityHandler(BASE_URL, "different-tok"),
    });
    assert.equal(h.elements.connection.dataset.state, "reconnect");
    assert.equal(h.elements.connection.getAttribute("role"), "alert");
    assert.equal(h.elements.connectionTitle.textContent, "需要重新连接");
    assert.equal(h.elements.connectionAction.hidden, false);
    assert.equal(h.elements.connectionAction.textContent, "重新连接");
  }

  // reconnect: legacy dev token
  {
    const h = await createOptionsHarness({
      storageLocal: [["mosaBaseUrl", BASE_URL], ["mosaToken", "mosa-web-capture-dev"]],
    });
    assert.equal(h.elements.connection.dataset.state, "reconnect");
    assert.equal(h.elements.connection.getAttribute("role"), "alert");
    assert.equal(h.elements.connectionTitle.textContent, "需要重新连接");
    assert.equal(h.elements.connectionAction.hidden, false);
    assert.equal(h.elements.connectionAction.textContent, "重新连接");
    assert.equal(h.fetchCalls.length, 0, "legacy dev token never sends network probes");
  }

  // outdated
  {
    const h = await createOptionsHarness({
      storageLocal: [["mosaBaseUrl", BASE_URL], ["mosaToken", "tok-old"]],
      fetchHandler: async (url) => (
        new URL(url).pathname === "/api/web-capture/identity"
          ? { ok: false, status: 404, json: async () => ({ error: "not found" }) }
          : undefined
      ),
    });
    assert.equal(h.elements.connection.dataset.state, "outdated");
    assert.equal(h.elements.connection.getAttribute("role"), "alert");
    assert.equal(h.elements.connectionTitle.textContent, "GravityPort 版本太旧");
    assert.equal(h.elements.connectionAction.hidden, true);
    assert.equal(h.elements.connectionLink.hidden, false);
    assert.equal(h.elements.connectionLink.textContent, "前往官网下载");
    assert.ok(h.elements.connectionLink.className.includes("btn-primary"));
    assert.equal(h.elements.connectionQuiet.hidden, false);
    assert.equal(h.elements.connectionQuiet.textContent, "重新检查");
  }

  // forbidden
  {
    const idHandler = makeIdentityHandler(BASE_URL, "tok-403");
    const h = await createOptionsHarness({
      storageLocal: [["mosaBaseUrl", BASE_URL], ["mosaToken", "tok-403"]],
      fetchHandler: async (url, init) => (await idHandler(url, init))
        ?? (new URL(url).pathname === "/api/ingest/web-capture"
          ? { ok: false, status: 403, json: async () => ({ error: "origin rejected" }) }
          : undefined),
    });
    assert.equal(h.elements.connection.dataset.state, "forbidden");
    assert.equal(h.elements.connection.getAttribute("role"), "alert");
    assert.equal(h.elements.connectionTitle.textContent, "GravityPort 没有允许这个扩展");
    assert.equal(h.elements.connectionAction.hidden, true);
    assert.equal(h.elements.connectionLink.hidden, false);
    assert.equal(h.elements.connectionLink.textContent, "前往官网下载");
    assert.ok(h.elements.connectionLink.className.includes("btn-primary"));
    assert.equal(h.elements.connectionQuiet.hidden, false);
    assert.equal(h.elements.connectionQuiet.textContent, "重新检查");
  }

  // not-gravityport
  {
    const h = await createOptionsHarness({
      storageLocal: [["mosaBaseUrl", BASE_URL], ["mosaToken", "tok-other"]],
      fetchHandler: async (url) => (
        url === `${BASE_URL}/api/health`
          ? { ok: true, status: 200, json: async () => ({ product: "someone-else", productVersion: "9.9.9" }) }
          : undefined
      ),
    });
    assert.equal(h.elements.connection.dataset.state, "not-gravityport");
    assert.equal(h.elements.connection.getAttribute("role"), "alert");
    assert.equal(h.elements.connectionTitle.textContent, "这个地址上不是 GravityPort");
    assert.ok(h.elements.connectionDetail.textContent.includes("127.0.0.1:43517"));
    assert.equal(h.elements.connectionAction.hidden, false);
    assert.equal(h.elements.connectionAction.textContent, "重新连接");
  }

  // error
  {
    const idHandler = makeIdentityHandler(BASE_URL, "tok-500");
    const h = await createOptionsHarness({
      storageLocal: [["mosaBaseUrl", BASE_URL], ["mosaToken", "tok-500"]],
      fetchHandler: async (url, init) => (await idHandler(url, init))
        ?? (new URL(url).pathname === "/api/ingest/web-capture"
          ? { ok: false, status: 500, json: async () => ({ error: "disk full" }) }
          : undefined),
    });
    assert.equal(h.elements.connection.dataset.state, "error");
    assert.equal(h.elements.connection.getAttribute("role"), "alert");
    assert.equal(h.elements.connectionTitle.textContent, "无法检查连接");
    assert.ok(h.elements.connectionDetail.textContent.includes("disk full"));
    assert.equal(h.elements.connectionAction.hidden, false);
    assert.equal(h.elements.connectionAction.textContent, "重新检查");
  }

  // settings-error
  {
    const h = await createOptionsHarness({
      storageGetError: new Error("storage corrupted"),
    });
    assert.equal(h.elements.connection.dataset.state, "settings-error");
    assert.equal(h.elements.connection.getAttribute("role"), "alert");
    assert.equal(h.elements.connectionTitle.textContent, "无法读取扩展设置");
    assert.ok(h.elements.connectionDetail.textContent.includes("storage corrupted"));
    assert.equal(h.elements.connectionAction.hidden, false);
    assert.equal(h.elements.connectionAction.textContent, "重新加载");
    await h.click("connectionAction");
    assert.equal(h.reloadCount, 1, "reload button calls location.reload()");
  }
});

// 3. 令牌安全
test("3. verifies service identity before sending Authorization token and never calls /api/web-capture/pair", async () => {
  const happy = await createOptionsHarness({
    storageLocal: [["mosaBaseUrl", BASE_URL], ["mosaToken", "tok-1"]],
    fetchHandler: makeConnectedHandler(BASE_URL, "tok-1", "0.3.17"),
  });
  const identityIndex = happy.fetchCalls.findIndex((call) => call.url.includes("/api/web-capture/identity"));
  const probeIndex = happy.fetchCalls.findIndex((call) => call.url.includes("/api/ingest/web-capture"));
  assert.ok(identityIndex >= 0, "identity challenge runs");
  assert.ok(probeIndex > identityIndex, "identity challenge must precede ingest token probe");
  assert.equal(happy.fetchCalls[probeIndex].init.headers.authorization, "Bearer tok-1");
  assert.equal(
    happy.fetchCalls.some((call) => call.url.includes("/api/web-capture/pair")),
    false,
    "options page never calls /api/web-capture/pair directly",
  );

  const mismatch = await createOptionsHarness({
    storageLocal: [["mosaBaseUrl", BASE_URL], ["mosaToken", "tok-1"]],
    fetchHandler: makeIdentityHandler(BASE_URL, "wrong-secret"),
  });
  assert.equal(mismatch.elements.connection.dataset.state, "reconnect");
  const hasAuthHeader = mismatch.fetchCalls.some((call) => {
    const headers = call.init?.headers || {};
    return Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
  });
  assert.equal(hasAuthHeader, false, "mismatch must never send any request with Authorization header");
  assert.equal(
    mismatch.fetchCalls.some((call) => call.url.includes("/api/web-capture/pair")),
    false,
  );
});

// 4. 配对
test("4. pairing enters waiting, deduplicates double-clicks, and settles to connected, pair+pairFailed, or offline", async () => {
  // Happy path: pair -> waiting -> connected
  let resolvePair;
  let appOnline = true;
  let activeToken = "";
  const happy = await createOptionsHarness({
    storageLocal: [["mosaBaseUrl", BASE_URL], ["mosaToken", ""]],
    respond: async (msg) => {
      if (msg?.type === "mosa.repairPairing") {
        return new Promise((resolve) => {
          resolvePair = resolve;
        });
      }
      return undefined;
    },
    fetchHandler: async (url, init) => {
      if (!appOnline) return undefined;
      if (activeToken) {
        return makeConnectedHandler(BASE_URL, activeToken, "0.3.17")(url, init);
      }
      if (url === `${BASE_URL}/api/health`) {
        return { ok: true, status: 200, json: async () => ({ product: "mosa", productVersion: "0.3.17" }) };
      }
      return undefined;
    },
  });
  assert.equal(happy.elements.connection.dataset.state, "pair");

  // Double-click primary button
  happy.click("connectionAction");
  happy.click("connectionAction");
  await happy.flush();

  assert.equal(happy.elements.connection.dataset.state, "waiting");
  assert.equal(happy.elements.connectionAction.getAttribute("aria-busy"), "true");
  assert.equal(happy.elements.connectionAction.disabled, true);
  assert.equal(happy.elements.connectionAction.textContent, "正在等待…");
  assert.equal(
    happy.runtimeMessages.filter((m) => m?.type === "mosa.repairPairing").length,
    1,
    "double-clicking sends only one mosa.repairPairing message",
  );

  // Resolve pairing successfully
  activeToken = "fresh-paired-token";
  happy.storage.local.set("mosaBaseUrl", BASE_URL);
  happy.storage.local.set("mosaToken", activeToken);
  resolvePair({ ok: true, settings: { mosaBaseUrl: BASE_URL, mosaToken: activeToken } });
  await happy.flush();

  assert.equal(happy.elements.mosaBaseUrl.value, BASE_URL);
  assert.equal(happy.elements.mosaToken.value, activeToken);
  assert.equal(happy.elements.connection.dataset.state, "connected");
  assert.equal(happy.fetchCalls.some((call) => call.url.includes("/api/web-capture/pair")), false);

  // Failed pairing while App is still running -> pair + pairFailed note
  const denied = await createOptionsHarness({
    storageLocal: [["mosaBaseUrl", BASE_URL], ["mosaToken", ""]],
    respond: async (msg) => (msg?.type === "mosa.repairPairing" ? { ok: false } : undefined),
    fetchHandler: async (url) => (
      url === `${BASE_URL}/api/health`
        ? { ok: true, status: 200, json: async () => ({ product: "mosa", productVersion: "0.3.17" }) }
        : undefined
    ),
  });
  await denied.click("connectionAction");
  await denied.flush();
  assert.equal(denied.elements.connection.dataset.state, "pair");
  assert.equal(denied.elements.connectionNote.hidden, false);
  assert.ok(denied.elements.connectionNote.textContent.includes("上次没有完成连接"));

  // Failed pairing when App went offline -> offline
  let online = true;
  const wentOffline = await createOptionsHarness({
    storageLocal: [["mosaBaseUrl", BASE_URL], ["mosaToken", ""]],
    respond: async (msg) => {
      if (msg?.type === "mosa.repairPairing") {
        online = false;
        return { ok: false };
      }
      return undefined;
    },
    fetchHandler: async (url) => (
      online && url === `${BASE_URL}/api/health`
        ? { ok: true, status: 200, json: async () => ({ product: "mosa", productVersion: "0.3.17" }) }
        : undefined
    ),
  });
  await wentOffline.click("connectionAction");
  await wentOffline.flush();
  assert.equal(wentOffline.elements.connection.dataset.state, "offline");
  assert.equal(wentOffline.elements.connectionNote.hidden, true);
});

// 5. 自动重查
test("5. auto-rechecks on storage.onChanged, throttles visibilitychange within 2s, and skips checks during waiting", async () => {
  let tokenReady = false;
  const h = await createOptionsHarness({
    storageLocal: [["mosaBaseUrl", BASE_URL], ["mosaToken", ""]],
    fetchHandler: async (url, init) => {
      if (tokenReady) {
        return makeConnectedHandler(BASE_URL, "bg-paired-tok", "0.3.17")(url, init);
      }
      if (url === `${BASE_URL}/api/health`) {
        return { ok: true, status: 200, json: async () => ({ product: "mosa", productVersion: "0.3.17" }) };
      }
      return undefined;
    },
  });
  assert.equal(h.elements.connection.dataset.state, "pair");

  // storage.onChanged with new mosaToken transitions to connected
  tokenReady = true;
  h.triggerStorageChange({ mosaToken: { oldValue: "", newValue: "bg-paired-tok" } }, "local");
  await h.flush();
  assert.equal(h.elements.connection.dataset.state, "connected");
  assert.equal(h.elements.mosaToken.value, "bg-paired-tok");

  // visibilitychange fired twice within 2 seconds only runs one recheck
  const callsBeforeVis = h.fetchCalls.length;
  h.fireVisibilityChange("visible");
  await h.flush();
  const callsAfterFirst = h.fetchCalls.length;
  assert.ok(callsAfterFirst > callsBeforeVis, "first visibilitychange triggers a recheck");

  h.advanceClock(500);
  h.fireVisibilityChange("visible");
  await h.flush();
  assert.equal(h.fetchCalls.length, callsAfterFirst, "second visibilitychange within 2s is throttled");

  h.advanceClock(2000);
  h.fireVisibilityChange("visible");
  await h.flush();
  assert.ok(h.fetchCalls.length > callsAfterFirst, "visibilitychange after 2s runs again");

  // During waiting, visibilitychange must not trigger a check
  let releaseWait;
  const waiting = await createOptionsHarness({
    storageLocal: [["mosaBaseUrl", BASE_URL], ["mosaToken", ""]],
    respond: async (msg) => (
      msg?.type === "mosa.repairPairing"
        ? new Promise((resolve) => { releaseWait = resolve; })
        : undefined
    ),
    fetchHandler: async (url) => (
      url === `${BASE_URL}/api/health`
        ? { ok: true, status: 200, json: async () => ({ product: "mosa", productVersion: "0.3.17" }) }
        : undefined
    ),
  });
  waiting.click("connectionAction");
  await waiting.flush();
  assert.equal(waiting.elements.connection.dataset.state, "waiting");

  const callsDuringWait = waiting.fetchCalls.length;
  waiting.advanceClock(5000);
  waiting.fireVisibilityChange("visible");
  waiting.fireWindowFocus();
  await waiting.flush();
  assert.equal(waiting.fetchCalls.length, callsDuringWait, "no probes during waiting");
  assert.equal(waiting.elements.connection.dataset.state, "waiting");

  releaseWait({ ok: false });
  await waiting.flush();
});

// 6. 自动收录开关
test("6. auto-capture switch persists only { autoCapture } immediately and reverts on storage error", async () => {
  const h = await createOptionsHarness({
    storageLocal: [["mosaBaseUrl", BASE_URL], ["mosaToken", "tok-1"], ["autoCapture", false]],
    fetchHandler: makeConnectedHandler(BASE_URL, "tok-1"),
  });
  assert.equal(h.elements.autoCapture.getAttribute("aria-checked"), "false");

  await h.click("autoCapture");
  await h.flush();
  assert.equal(h.elements.autoCapture.getAttribute("aria-checked"), "true");
  assert.equal(h.storage.localWrites.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.storage.localWrites[0])), { autoCapture: true });
  assert.equal(h.elements.autoCaptureStatus.textContent, "已开启自动收录，刷新已打开的支持网站后生效。");
  assert.equal(h.elements.autoCaptureStatus.hidden, false);

  await h.click("autoCapture");
  await h.flush();
  assert.equal(h.elements.autoCapture.getAttribute("aria-checked"), "false");
  assert.deepEqual(JSON.parse(JSON.stringify(h.storage.localWrites[1])), { autoCapture: false });
  assert.equal(h.elements.autoCaptureStatus.textContent, "已关闭自动收录。");

  // Write failure reverts switch and surfaces alert error
  const failing = await createOptionsHarness({
    storageLocal: [["mosaBaseUrl", BASE_URL], ["autoCapture", false]],
    storageSetError: new Error("quota exceeded"),
  });
  await failing.click("autoCapture");
  await failing.flush();
  assert.equal(failing.elements.autoCapture.getAttribute("aria-checked"), "false", "switch reverts on failure");
  assert.equal(failing.elements.autoCaptureStatus.getAttribute("role"), "alert");
  assert.equal(failing.elements.autoCaptureStatus.textContent, "无法保存自动收录设置（quota exceeded）");
});

// 7. 端口一致
test("7. DISCOVERY_PORTS in options.js matches background.js and offline probes all five ports", async () => {
  const extensionDir = new URL("../extensions/chatgpt-web-capture/", import.meta.url);
  const bgSource = await readFile(new URL("background.js", extensionDir), "utf8");
  const optSource = await readFile(new URL("options.js", extensionDir), "utf8");

  const extractPorts = (source, name) => {
    const match = source.match(/const\s+DISCOVERY_PORTS\s*=\s*(\[[^\]]+\])/);
    assert.ok(match, `${name} must declare DISCOVERY_PORTS`);
    return JSON.parse(match[1]);
  };
  const bgPorts = extractPorts(bgSource, "background.js");
  const optPorts = extractPorts(optSource, "options.js");
  assert.deepEqual(optPorts, bgPorts, "options.js DISCOVERY_PORTS must match background.js");

  const offline = await createOptionsHarness({
    storageLocal: [["mosaBaseUrl", BASE_URL], ["mosaToken", ""]],
  });
  assert.equal(offline.elements.connection.dataset.state, "offline");
  const probedUrls = new Set(offline.fetchCalls.map((call) => call.url));
  for (const port of bgPorts) {
    assert.ok(probedUrls.has(`http://127.0.0.1:${port}/api/health`), `must probe port ${port}`);
  }
});

// 8. 高级保存
test("8. advanced save normalizes URL, rejects invalid/non-local URLs and legacy dev token, and triggers recheck", async () => {
  const h = await createOptionsHarness({
    storageLocal: [["mosaBaseUrl", "http://127.0.0.1:43518"], ["mosaToken", ""]],
    fetchHandler: makeConnectedHandler(BASE_URL, "tok-saved", "0.3.17"),
  });
  assert.equal(h.elements.connection.dataset.state, "pair");

  const callsBeforeSave = h.fetchCalls.length;
  h.elements.mosaBaseUrl.value = "http://127.0.0.1:43517/";
  h.elements.mosaToken.value = "tok-saved";
  await h.click("save");
  await h.flush();

  assert.deepEqual(JSON.parse(JSON.stringify(h.storage.localWrites[0])), {
    mosaBaseUrl: "http://127.0.0.1:43517",
    mosaToken: "tok-saved",
  });
  assert.equal(h.elements.advancedStatus.textContent, "已保存，正在重新检查…");
  assert.equal(h.storage.local.get("mosaToken"), "tok-saved");
  assert.ok(h.fetchCalls.length > callsBeforeSave, "save triggers a connection check");
  assert.equal(h.elements.connection.dataset.state, "connected");

  for (const [label, badUrl] of [
    ["a non-local host", "https://example.com:1"],
    ["a non-http protocol", "https://127.0.0.1:43517"],
    ["embedded credentials", "http://user:pass@127.0.0.1:43517"],
  ]) {
    const rejecting = await createOptionsHarness({
      storageLocal: [["mosaBaseUrl", BASE_URL], ["mosaToken", ""]],
    });
    rejecting.elements.mosaBaseUrl.value = badUrl;
    await rejecting.click("save");
    await rejecting.flush();
    assert.equal(rejecting.storage.localWrites.length, 0, `${label} must not be written`);
    assert.equal(rejecting.elements.advancedStatus.getAttribute("role"), "alert");
    assert.ok(
      rejecting.elements.advancedStatus.textContent.includes("地址必须")
      || rejecting.elements.advancedStatus.textContent.includes("地址无效"),
      `${label} is explained`,
    );
  }

  const legacy = await createOptionsHarness({
    storageLocal: [["mosaBaseUrl", BASE_URL], ["mosaToken", ""]],
  });
  legacy.elements.mosaBaseUrl.value = BASE_URL;
  legacy.elements.mosaToken.value = "mosa-web-capture-dev";
  await legacy.click("save");
  await legacy.flush();
  assert.equal(legacy.storage.localWrites.length, 0, "legacy dev token must not be written");
  assert.equal(legacy.elements.advancedStatus.getAttribute("role"), "alert");
  assert.ok(legacy.elements.advancedStatus.textContent.includes("已失效"));
});

// 9. 中英文
test("9. switches between English and Chinese based on chrome.i18n.getUILanguage and keeps STRINGS keys in lockstep", async () => {
  const en = await createOptionsHarness({
    uiLanguage: "en-US",
    storageLocal: [["mosaBaseUrl", BASE_URL], ["mosaToken", ""]],
    fetchHandler: async (url) => (
      url === `${BASE_URL}/api/health`
        ? { ok: true, status: 200, json: async () => ({ product: "mosa", productVersion: "0.3.17" }) }
        : undefined
    ),
  });
  assert.equal(en.context.document.documentElement.lang, "en");
  assert.equal(en.elements.connectionTitle.textContent, "Not connected to GravityPort");
  assert.equal(en.elements.connectionAction.textContent, "Connect to GravityPort");
  assert.ok(en.i18nElements.autoCaptureDesc.textContent.includes("Off by default"));
  assert.equal(en.i18nElements.save.textContent, "Save");

  const zh = await createOptionsHarness({
    uiLanguage: "zh-CN",
    storageLocal: [["mosaBaseUrl", BASE_URL], ["mosaToken", ""]],
    fetchHandler: async (url) => (
      url === `${BASE_URL}/api/health`
        ? { ok: true, status: 200, json: async () => ({ product: "mosa", productVersion: "0.3.17" }) }
        : undefined
    ),
  });
  assert.equal(zh.context.document.documentElement.lang, "zh-CN");
  assert.equal(zh.elements.connectionTitle.textContent, "还没有连接 GravityPort");
  assert.equal(zh.elements.connectionAction.textContent, "连接 GravityPort");
  assert.ok(zh.i18nElements.autoCaptureDesc.textContent.includes("默认关闭"));

  const zhKeys = Object.keys(zh.strings.zh).sort();
  const enKeys = Object.keys(zh.strings.en).sort();
  assert.deepEqual(enKeys, zhKeys, "STRINGS.zh and STRINGS.en must have identical key sets");
});
