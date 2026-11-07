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

async function load() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "mosa.getSettings" });
    const settings = response?.ok ? response.settings : await chrome.storage.local.get(DEFAULTS);
    baseUrlEl.value = settings.mosaBaseUrl || DEFAULTS.mosaBaseUrl;
    tokenEl.value = settings.mosaToken || "";
    autoCaptureEl.checked = settings.autoCapture !== false;
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
// service is down, another app owns the port, or MOSA is running but refuses
// to pair with this extension's origin. Distinguish them here so the user
// sees the actual blocker instead of a wrong "please open MOSA App".
async function diagnoseMosaConnection(baseUrl) {
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
  try {
    const pair = await fetchWithTimeout(`${baseUrl}/api/web-capture/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      cache: "no-cache",
    }, 3000);
    if (pair.status === 403) {
      return `GravityPort${version ? ` ${version}` : ""} 不接受此扩展（扩展 ID：${chrome.runtime.id}）。请将 GravityPort 更新到最新版本后重试。`;
    }
    if (pair.ok) {
      return `GravityPort 正在运行${version ? `（${version}）` : ""}，配对接口可用。请再点一次“测试连接”完成配对。`;
    }
    return `无法完成连接（HTTP ${pair.status}）。请重新启动 GravityPort 后重试。`;
  } catch {
    return "无法完成连接。请确认 GravityPort 正在运行，然后重试。";
  }
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
    let probe = await probeIngestToken(baseUrl, token);
    if (probe.status === 401 && probe.data.code === "WEB_CAPTURE_UNAUTHORIZED") {
      // The saved Token is often just stale after GravityPort re-paired. Ask the
      // background to pair once more and retest with the Token it got back.
      const repaired = await chrome.runtime.sendMessage({ type: "mosa.repairPairing" }).catch(() => null);
      if (repaired?.ok && repaired.settings?.mosaToken) {
        baseUrl = normalizeBaseUrl(repaired.settings.mosaBaseUrl || baseUrl);
        token = repaired.settings.mosaToken;
        tokenEl.value = token;
        baseUrlEl.value = baseUrl;
        probe = await probeIngestToken(baseUrl, token);
        if (probe.status === 400 && probe.data.code === "WEB_CAPTURE_BAD_IMAGE") {
          setStatus("已重新连接，连接测试通过。", "success");
          return;
        }
      }
    }
    if (probe.status === 400 && probe.data.code === "WEB_CAPTURE_BAD_IMAGE") {
      setStatus("连接测试通过。", "success");
      return;
    }
    if (probe.status === 401 && probe.data.code === "WEB_CAPTURE_UNAUTHORIZED") {
      setStatus("令牌（Token）与 GravityPort 不一致。清空此项以自动连接，或填写 GravityPort 当前使用的令牌。", "error");
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

function setStatus(message, kind) {
  statusEl.textContent = message;
  // F-21：错误用独立 alert 语义，其余恢复 polite status；颜色不作唯一表达。
  statusEl.setAttribute("role", kind === "error" ? "alert" : "status");
  statusEl.style.color = kind === "error" ? "var(--mosa-error)" : "var(--mosa-success)";
}

load();
