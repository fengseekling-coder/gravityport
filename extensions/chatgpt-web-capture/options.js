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
    throw new Error("GravityPort 地址必须是 http://127.0.0.1:端口 或 http://localhost:端口。");
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
    setStatus(`设置读取失败：${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

document.getElementById("save").addEventListener("click", async () => {
  const token = tokenEl.value.trim();
  if (token === LEGACY_DEV_TOKEN) {
    setStatus("旧开发 Token 已失效。请填写与当前 GravityPort 服务一致的新随机 Token。", "error");
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
  setStatus("已保存。请刷新支持的网页使内容脚本生效。", "success");
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
    return `未检测到 GravityPort 服务：${baseUrl} 无法访问。请确认 GravityPort App 正在运行。`;
  }
  let identity = null;
  try { identity = await health.json(); } catch { /* non-JSON responder */ }
  if (!health.ok || identity?.product !== "mosa") {
    return `${baseUrl} 上运行的不是 GravityPort（HTTP ${health.status}）。请检查地址与端口。`;
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
      return `GravityPort 正在运行${version ? `（${version}）` : ""}，但拒绝配对本扩展（ID ${chrome.runtime.id} 不在信任列表）。请升级 GravityPort App 后重试。`;
    }
    if (pair.ok) {
      return `GravityPort 正在运行${version ? `（${version}）` : ""}，配对接口可用。请再点一次“测试连接”完成配对。`;
    }
    return `GravityPort 正在运行${version ? `（${version}）` : ""}，但配对返回 HTTP ${pair.status}。`;
  } catch {
    return `GravityPort 正在运行${version ? `（${version}）` : ""}，但配对请求失败。`;
  }
}

document.getElementById("test").addEventListener("click", async () => {
  setStatus("测试中…", "success");
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
      setStatus(await diagnoseMosaConnection(baseUrl).catch(() => "未发现正在运行的 GravityPort。请先打开 GravityPort App。"), "error");
      return;
    }
  }
  if (token === LEGACY_DEV_TOKEN) {
    setStatus("旧开发 Token 已失效。请填写与当前 GravityPort 服务一致的新随机 Token。", "error");
    return;
  }
  try {
    // A deliberately incomplete ingest request exercises the real Bearer-token
    // path without writing an asset. A valid token reaches image validation.
    const response = await fetchWithTimeout(`${baseUrl}/api/ingest/web-capture`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ provider: "chatgpt", mimeType: "image/png", imageBase64: "" }),
    }, 5000);
    const data = await response.json();
    if (response.status === 400 && data.code === "WEB_CAPTURE_BAD_IMAGE") {
      setStatus("连接和 Token 验证成功。", "success");
      return;
    }
    if (response.status === 401 && data.code === "WEB_CAPTURE_UNAUTHORIZED") {
      setStatus("Token 不匹配。请填写当前 GravityPort 服务配置的 Token。", "error");
      return;
    }
    if (response.status === 403) {
      setStatus("扩展来源未获服务端批准。请检查 MOSA_WEB_CAPTURE_ORIGINS。", "error");
      return;
    }
    throw new Error(data.error || `HTTP ${response.status}`);
  } catch (error) {
    setStatus(`连接失败：${error instanceof Error ? error.message : String(error)}`, "error");
  }
});

function setStatus(message, kind) {
  statusEl.textContent = message;
  // F-21：错误用独立 alert 语义，其余恢复 polite status；颜色不作唯一表达。
  statusEl.setAttribute("role", kind === "error" ? "alert" : "status");
  statusEl.style.color = kind === "error" ? "var(--mosa-error)" : "var(--mosa-success)";
}

load();
