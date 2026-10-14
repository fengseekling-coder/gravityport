const DEFAULTS = {
  mosaBaseUrl: "http://127.0.0.1:43517",
  mosaToken: "",
  autoCapture: false,
  devRawDiagnostics: false,
};
const LEGACY_DEV_TOKEN = "mosa-web-capture-dev";

const statusEl = document.getElementById("status");
const baseUrlEl = document.getElementById("mosaBaseUrl");
const tokenEl = document.getElementById("mosaToken");
const autoCaptureEl = document.getElementById("autoCapture");
// DEV-ONLY(128): remove before release (the whole #dev diagnostics block).
const devPanelEl = document.getElementById("devDiagnostics");
const devRawEnabledEl = document.getElementById("devRawDiagnostics");
const devRawStatsEl = document.getElementById("devRawStats");
const devRawStatusEl = document.getElementById("devRawStatus");
const devRawExportAllEl = document.getElementById("devRawExportAll");
const devRawExportRecentEl = document.getElementById("devRawExportRecent");
const devRawClearEl = document.getElementById("devRawClear");
// The panel exists in the markup but stays hidden unless the page was opened
// with options.html#dev — normal users never see a diagnostics UI.
const devPanelVisible = window.location.hash === "#dev";

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
    devRawEnabledEl.checked = settings.devRawDiagnostics === true;
    if (devPanelVisible) await refreshDevRawStats();
  } catch (error) {
    const settings = await chrome.storage.local.get(DEFAULTS).catch(() => DEFAULTS);
    baseUrlEl.value = settings.mosaBaseUrl || DEFAULTS.mosaBaseUrl;
    tokenEl.value = settings.mosaToken || "";
    autoCaptureEl.checked = settings.autoCapture !== false;
    devRawEnabledEl.checked = settings.devRawDiagnostics === true;
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
    devRawDiagnostics: devRawEnabledEl.checked === true,
  });
  setStatus("已保存。请刷新支持的网页使内容脚本生效。", "success");
});

// DEV-ONLY(128): remove before release (the whole #dev diagnostics block).
function setDevRawStatus(message, kind = "") {
  devRawStatusEl.textContent = message;
  devRawStatusEl.style.color = kind === "error" ? "var(--mosa-error)" : "var(--mosa-success)";
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

async function refreshDevRawStats() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "mosa.devRawDiagnostics.stats" });
    if (!response?.ok) throw new Error(response?.error || "统计读取失败");
    const stats = response.stats || {};
    devRawStatsEl.textContent = "已存 "
      + `${stats.count || 0} 轮 · 其中没提示词 ${stats.missingPromptCount || 0} 轮 · 对照 ${stats.controlCount || 0} 轮 · 占用 ${formatBytes(stats.bytes)}`;
  } catch {
    devRawStatsEl.textContent = "统计读取失败";
  }
}

devRawEnabledEl.addEventListener("change", async () => {
  await chrome.storage.local.set({ devRawDiagnostics: devRawEnabledEl.checked === true });
  setDevRawStatus(devRawEnabledEl.checked
    ? "开发者诊断已开启。下次 ChatGPT 出图没拿到提示词时会按轮记录原始数据。"
    : "开发者诊断已关闭。缓冲与本机数据立即清空。");
  refreshDevRawStats();
});

async function exportDevRawRecords(onlyNewest) {
  // Page through the store so a large history never becomes one giant
  // message; each page of JSON Lines is appended to the download Blob as a
  // separate part instead of one JSON.stringify of everything. "最近 20 轮"
  // starts paging right before the newest record ids instead of reading the
  // whole store.
  let afterId = 0;
  if (typeof onlyNewest === "number") {
    const statsResponse = await chrome.runtime.sendMessage({ type: "mosa.devRawDiagnostics.stats" });
    if (!statsResponse?.ok) throw new Error(statsResponse?.error || "导出失败");
    afterId = Math.max(0, (Number(statsResponse.stats?.maxId) || 0) - onlyNewest);
  }
  const parts = [];
  for (let page = 0; page < 1000; page += 1) {
    const response = await chrome.runtime.sendMessage({
      type: "mosa.devRawDiagnostics.exportPage",
      afterId,
      limit: 10,
    });
    if (!response?.ok) throw new Error(response?.error || "导出失败");
    for (const line of response.lines || []) parts.push(`${line}\n`);
    if (!response.hasMore) break;
    afterId = response.nextAfterId;
  }
  if (!parts.length) throw new Error("没有可导出的记录。");
  const stamp = (() => {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  })();
  const blob = new Blob(parts, { type: "application/x-ndjson" });
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = `mosa-raw-diagnostics-${stamp}.jsonl`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
  return link.download;
}

async function handleDevRawExport(limit) {
  setDevRawStatus("导出中…");
  try {
    const filename = await exportDevRawRecords(limit);
    setDevRawStatus(`已导出：${filename}`);
  } catch (error) {
    setDevRawStatus(error instanceof Error ? error.message : String(error), "error");
  }
  refreshDevRawStats();
}

if (devPanelVisible) {
  devPanelEl.hidden = false;
  devRawExportAllEl.addEventListener("click", () => handleDevRawExport(null));
  devRawExportRecentEl.addEventListener("click", () => handleDevRawExport(20));
  devRawClearEl.addEventListener("click", async () => {
    if (!window.confirm("确认清空全部开发者诊断记录？此操作不可撤销。")) return;
    setDevRawStatus("清空中…");
    try {
      const response = await chrome.runtime.sendMessage({ type: "mosa.devRawDiagnostics.clear" });
      if (!response?.ok) throw new Error(response?.error || "清空失败");
      setDevRawStatus("已清空。");
    } catch (error) {
      setDevRawStatus(error instanceof Error ? error.message : String(error), "error");
    }
    refreshDevRawStats();
  });
}

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
