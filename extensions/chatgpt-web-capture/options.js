const DEFAULTS = {
  mosaBaseUrl: "http://127.0.0.1:43517",
  mosaToken: "",
  autoCapture: false,
};
const LEGACY_DEV_TOKEN = "mosa-web-capture-dev";

const statusEl = document.getElementById("status");
const baseUrlEl = document.getElementById("mosaBaseUrl");
const tokenEl = document.getElementById("mosaToken");
const autoCaptureEl = document.getElementById("autoCapture");

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("GravityPort 地址无效。");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.username || url.password) {
    throw new Error("地址必须是本机地址，例如 http://127.0.0.1:43517。");
  }
  return url.origin;
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Task 333 — service identity challenge, mirroring the background worker's
// verifyServiceIdentity: the service signs a fresh nonce with the Web Capture
// token and the bound port, and the page checks the proof before the token is
// sent anywhere. Verdicts: "ok" | "offline" | "mismatch" | "outdated".
const MOSA_IDENTITY_PROOF_PREFIX = "gravityport-web-capture-identity\0";

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function probeServiceIdentity(baseUrl, token) {
  const nonceBytes = new Uint8Array(32);
  crypto.getRandomValues(nonceBytes);
  const nonce = bytesToBase64Url(nonceBytes);
  let response;
  try {
    response = await fetchWithTimeout(`${baseUrl}/api/web-capture/identity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce }),
      cache: "no-cache",
    }, 3000);
  } catch {
    return "offline";
  }
  if (response.status === 404) return "outdated";
  const body = await response.json().catch(() => null);
  const proof = String(body?.proof || "");
  if (!response.ok || !proof) return "mismatch";
  let expected = "";
  try {
    const port = new URL(baseUrl).port || "80";
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const parts = [encoder.encode(MOSA_IDENTITY_PROOF_PREFIX), encoder.encode(port), new Uint8Array([0]), encoder.encode(nonce)];
    const message = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      message.set(part, offset);
      offset += part.length;
    }
    expected = bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, message)));
  } catch {
    return "mismatch";
  }
  if (expected.length !== proof.length) return "mismatch";
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ proof.charCodeAt(index);
  }
  return mismatch === 0 ? "ok" : "mismatch";
}

async function load() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "mosa.getSettings" });
    const settings = response?.ok ? response.settings : await chrome.storage.local.get(DEFAULTS);
    baseUrlEl.value = settings.mosaBaseUrl || DEFAULTS.mosaBaseUrl;
    tokenEl.value = settings.mosaToken || "";
    autoCaptureEl.checked = settings.autoCapture !== false;
    // Task 333: surface a failed service identity right away — sends are
    // paused until the user re-pairs or the App is restored.
    if (response?.serviceIdentity === "mismatch") {
      setStatus("连接到的不是你的 GravityPort，已暂停发送。如果刚重装过 GravityPort，点「重新配对」。", "error");
    } else if (response?.serviceIdentity === "outdated") {
      setStatus("GravityPort 版本太旧，请更新到最新版。", "error");
    }
  } catch (error) {
    const settings = await chrome.storage.local.get(DEFAULTS).catch(() => DEFAULTS);
    baseUrlEl.value = settings.mosaBaseUrl || DEFAULTS.mosaBaseUrl;
    tokenEl.value = settings.mosaToken || "";
    autoCaptureEl.checked = settings.autoCapture !== false;
    setStatus(`无法读取设置：${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

document.getElementById("save").addEventListener("click", async () => {
  const token = tokenEl.value.trim();
  if (token === LEGACY_DEV_TOKEN) {
    setStatus("该开发用令牌（Token）已失效。清空此项以自动连接，或填写 GravityPort 当前使用的令牌。", "error");
    return;
  }
  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl(baseUrlEl.value.trim() || DEFAULTS.mosaBaseUrl);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
    return;
  }
  await chrome.storage.local.set({
    mosaBaseUrl: baseUrl,
    mosaToken: token,
    autoCapture: autoCaptureEl.checked,
  });
  setStatus("已保存。刷新已打开的支持网站后生效。", "success");
});

// "未发现正在运行的 MOSA" lumps three very different failures together: the
// service is down, another app owns the port, or the extension is not paired.
// Task 333: diagnosis never pairs on its own (that needs the user's approval
// in the App) — with a token on hand it verifies the service identity instead.
async function diagnoseMosaConnection(baseUrl, token = "") {
  let health;
  try {
    health = await fetchWithTimeout(`${baseUrl}/api/health`, { cache: "no-cache" }, 3000);
  } catch {
    return `无法连接 GravityPort（${baseUrl}）。请确认 GravityPort 正在运行。`;
  }
  let identity = null;
  try { identity = await health.json(); } catch { /* non-JSON responder */ }
  if (!health.ok || identity?.product !== "mosa") {
    return `${baseUrl} 上的服务不是 GravityPort（HTTP ${health.status}）。请检查地址和端口。`;
  }
  const version = String(identity?.productVersion || "").trim();
  if (!token) {
    return `GravityPort 正在运行${version ? `（${version}）` : ""}，但还没有配对。点「重新配对」，然后在 GravityPort 里点「允许连接」。`;
  }
  const verdict = await probeServiceIdentity(baseUrl, token);
  if (verdict === "offline") {
    return `GravityPort 正在运行${version ? `（${version}）` : ""}，但核对服务身份失败。`;
  }
  if (verdict === "outdated") {
    return `GravityPort 正在运行${version ? `（${version}）` : ""}，但版本太旧，没有配对确认接口。请更新 GravityPort 到最新版。`;
  }
  if (verdict === "mismatch") {
    return "连接到的不是你的 GravityPort，已暂停发送。如果刚重装过 GravityPort，点「重新配对」。";
  }
  return `GravityPort 正在运行${version ? `（${version}）` : ""}，服务身份已核对。`;
}

// A deliberately incomplete ingest request exercises the real Bearer-token
// path without writing an asset. A valid token reaches image validation.
async function probeIngestToken(baseUrl, token) {
  const response = await fetchWithTimeout(`${baseUrl}/api/ingest/web-capture`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ provider: "chatgpt", mimeType: "image/png", imageBase64: "" }),
  }, 5000);
  return { status: response.status, data: await response.json() };
}

document.getElementById("test").addEventListener("click", async () => {
  setStatus("正在测试连接…", "success");
  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl(baseUrlEl.value.trim() || DEFAULTS.mosaBaseUrl);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
    return;
  }
  let token = tokenEl.value.trim();
  if (!token) {
    try {
      const response = await chrome.runtime.sendMessage({ type: "mosa.getSettings" });
      token = String(response?.settings?.mosaToken || "").trim();
      const discoveredBaseUrl = String(response?.settings?.mosaBaseUrl || "").trim();
      if (!token || !discoveredBaseUrl) {
        setStatus(await diagnoseMosaConnection(baseUrl), "error");
        return;
      }
      baseUrl = normalizeBaseUrl(discoveredBaseUrl);
      tokenEl.value = token;
      baseUrlEl.value = baseUrl;
    } catch {
      setStatus(await diagnoseMosaConnection(baseUrl).catch(() => "无法找到正在运行的 GravityPort。请先打开 GravityPort。"), "error");
      return;
    }
  }
  if (token === LEGACY_DEV_TOKEN) {
    setStatus("该开发用令牌（Token）已失效。清空此项以自动连接，或填写 GravityPort 当前使用的令牌。", "error");
    return;
  }
  try {
    // Task 333: verify the service identity before sending the token anywhere,
    // then check the token with the deliberately incomplete ingest probe.
    const verdict = await probeServiceIdentity(baseUrl, token);
    if (verdict === "offline") {
      setStatus(await diagnoseMosaConnection(baseUrl, token), "error");
      return;
    }
    if (verdict === "outdated") {
      setStatus("GravityPort 版本太旧，请更新到最新版。", "error");
      return;
    }
    if (verdict === "mismatch") {
      setStatus("连接到的不是你的 GravityPort，暂停发送。如果刚重装过 GravityPort，点「重新配对」。", "error");
      return;
    }
    const probe = await probeIngestToken(baseUrl, token);
    if (probe.status === 400 && probe.data.code === "WEB_CAPTURE_BAD_IMAGE") {
      setStatus("连接测试通过。", "success");
      return;
    }
    if (probe.status === 401 && probe.data.code === "WEB_CAPTURE_UNAUTHORIZED") {
      // No automatic re-pairing from here: pairing opens the App's
      // confirmation dialog, so it only happens on the explicit button.
      setStatus("令牌（Token）与 GravityPort 不一致。点「重新配对」，或填写 GravityPort 当前使用的令牌。", "error");
      return;
    }
    if (probe.status === 403) {
      setStatus("GravityPort 未允许此扩展连接。请将 GravityPort 和此扩展更新到最新版本。", "error");
      return;
    }
    throw new Error(probe.data.error || `HTTP ${probe.status}`);
  } catch (error) {
    setStatus(`无法连接：${error instanceof Error ? error.message : String(error)}`, "error");
  }
});

// Task 333 — pairing is user-confirmed in GravityPort, so it only starts from
// this explicit button. While the request is pending the App shows the
// authorization dialog; the answer (or the 120-second expiry) settles this.
document.getElementById("repair").addEventListener("click", async () => {
  setStatus("正在等待你在 GravityPort 里点「允许连接」…", "success");
  try {
    const response = await chrome.runtime.sendMessage({ type: "mosa.repairPairing" });
    if (response?.ok && response.settings?.mosaToken) {
      tokenEl.value = response.settings.mosaToken;
      try {
        baseUrlEl.value = normalizeBaseUrl(response.settings.mosaBaseUrl || DEFAULTS.mosaBaseUrl);
      } catch { /* keep the typed base URL */ }
      setStatus("已连接 GravityPort。", "success");
      return;
    }
    setStatus("没有完成配对。请确认 GravityPort 正在运行、没有拒绝过这次连接，然后再点一次「重新配对」。", "error");
  } catch (error) {
    setStatus(`配对失败：${error instanceof Error ? error.message : String(error)}`, "error");
  }
});

function setStatus(message, kind) {
  statusEl.textContent = message;
  // F-21：错误用独立 alert 语义，其余恢复 polite status；颜色不作唯一表达。
  statusEl.setAttribute("role", kind === "error" ? "alert" : "status");
  statusEl.style.color = kind === "error" ? "var(--mosa-error)" : "var(--mosa-success)";
}

load();
