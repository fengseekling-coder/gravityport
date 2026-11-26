const DEFAULTS = {
  mosaBaseUrl: "http://127.0.0.1:43517",
  mosaToken: "",
  autoCapture: false,
};
const DISCOVERY_PORTS = [43517, 43518, 43519, 43520, 43521];
const LEGACY_DEV_TOKEN = "mosa-web-capture-dev";
const DOWNLOAD_URL = "https://gravityport.azhuilab.com/#download";
const PROBE_TIMEOUT_MS = 3000;
const INGEST_PROBE_TIMEOUT_MS = 5000;
const VISIBILITY_RECHECK_COOLDOWN_MS = 2000;
const SELF_SAVE_ECHO_WINDOW_MS = 500;

// Task 333 — service identity challenge, mirroring the background worker's
// verifyServiceIdentity: the service signs a fresh nonce with the Web Capture
// token and the bound port, and the page checks the proof before the token is
// sent anywhere. Verdicts: "ok" | "offline" | "mismatch" | "outdated".
const MOSA_IDENTITY_PROOF_PREFIX = "gravityport-web-capture-identity\0";

const STRINGS = {
  zh: {
    docTitle: "GravityPort 浏览器扩展设置",
    pageTitle: "GravityPort 浏览器扩展",
    stateCheckingTitle: "正在检查连接…",
    stateCheckingDetail: "正在查找本机的 GravityPort。",
    stateConnectedTitle: "已连接 GravityPort",
    stateConnectedDetail: "GravityPort {version} · {host}。收录的图片和视频会直接存进素材库。",
    stateConnectedDetailNoVersion: "{host}。收录的图片和视频会直接存进素材库。",
    statePairTitle: "还没有连接 GravityPort",
    statePairDetail: "GravityPort 正在运行。点「连接 GravityPort」，再到 GravityPort 弹出的窗口里点「允许连接」。",
    statePairFailedNote: "上次没有完成连接（已拒绝或已超时）。刚点过「不允许」时，1 分钟后再试。",
    stateWaitingTitle: "请到 GravityPort 里点「允许连接」",
    stateWaitingDetail: "GravityPort 已弹出确认窗口，2 分钟内有效。没看到窗口时，切到 GravityPort 看一下。",
    stateOfflineTitle: "没有找到 GravityPort",
    stateOfflineDetail: "请先打开 GravityPort。打开后回到这里，会自动重新检查。",
    stateMovedTitle: "需要重新连接",
    stateMovedDetail: "GravityPort 换了端口（现在是 {host}），重新连接一次即可。",
    stateReconnectTitle: "需要重新连接",
    stateReconnectDetail: "GravityPort 重装或重置过，原来的连接已失效。收录已暂停，等待中的素材会保留。",
    stateOutdatedTitle: "GravityPort 版本太旧",
    stateOutdatedDetail: "这个扩展需要更新版的 GravityPort。更新后回到这里重新检查。",
    stateForbiddenTitle: "GravityPort 没有允许这个扩展",
    stateForbiddenDetail: "请把 GravityPort 和这个扩展都更新到最新版。",
    stateNotGravityPortTitle: "这个地址上不是 GravityPort",
    stateNotGravityPortDetail: "{host} 上运行的不是 GravityPort。点「重新连接」自动查找，或在「高级」里改地址。",
    stateErrorTitle: "无法检查连接",
    stateErrorDetail: "无法完成检查（{detail}）。",
    stateSettingsErrorTitle: "无法读取扩展设置",
    stateSettingsErrorDetail: "重新打开这个页面再试（{detail}）。",
    actionConnect: "连接 GravityPort",
    actionWaiting: "正在等待…",
    actionCheckAgain: "重新检查",
    actionReconnect: "重新连接",
    actionDownload: "前往官网下载",
    actionDownloadPrompt: "还没安装？前往官网下载",
    actionReload: "重新加载",
    autoCaptureLabel: "自动收录",
    autoCaptureDesc: "开启后，扩展只在支持的网站上读取与生成内容有关的页面数据，把图片、视频、提示词和来源发到本机的 GravityPort。默认关闭，不会上传到云端。也可以在网页上右键手动保存。",
    autoCaptureEnabled: "已开启自动收录，刷新已打开的支持网站后生效。",
    autoCaptureDisabled: "已关闭自动收录。",
    autoCaptureSaveError: "无法保存自动收录设置（{detail}）",
    supportedSites: "图片支持 ChatGPT、Gemini、Flow、Google AI Studio、即梦、Midjourney、Lovart；视频支持 Flow、Google AI Studio、即梦、Midjourney。",
    advancedTitle: "高级",
    advancedHint: "手动指定地址和令牌，一般不需要改",
    urlLabel: "GravityPort 地址",
    urlHint: "连接时会自动查找并填写（端口 43517–43521），一般不用改。",
    tokenLabel: "访问令牌（Token）",
    tokenHint: "连接后自动填写。",
    save: "保存",
    savedChecking: "已保存，正在重新检查…",
    invalidUrlError: "GravityPort 地址无效。",
    nonLocalUrlError: "地址必须是本机地址，例如 http://127.0.0.1:43517。",
    legacyTokenError: "该开发用令牌（Token）已失效。清空此项以自动连接，或填写 GravityPort 当前使用的令牌。",
    identityUnreachable: "GravityPort 没有回应身份核验，稍后再试",
  },
  en: {
    docTitle: "GravityPort extension settings",
    pageTitle: "GravityPort browser extension",
    stateCheckingTitle: "Checking the connection…",
    stateCheckingDetail: "Looking for GravityPort on this computer.",
    stateConnectedTitle: "Connected to GravityPort",
    stateConnectedDetail: "GravityPort {version} · {host}. Captured images and videos go straight into the library.",
    stateConnectedDetailNoVersion: "{host}. Captured images and videos go straight into the library.",
    statePairTitle: "Not connected to GravityPort",
    statePairDetail: "GravityPort is running. Click Connect to GravityPort, then click Allow Connection in the window GravityPort opens.",
    statePairFailedNote: "The last attempt didn’t finish (denied or timed out). After Don’t Allow, wait 1 minute before trying again.",
    stateWaitingTitle: "Click Allow Connection in GravityPort",
    stateWaitingDetail: "GravityPort opened a confirmation window. It stays open for 2 minutes. If it isn’t visible, switch to GravityPort.",
    stateOfflineTitle: "GravityPort not found",
    stateOfflineDetail: "Open GravityPort first. The connection is checked again when this page is shown.",
    stateMovedTitle: "Reconnection needed",
    stateMovedDetail: "GravityPort moved to another port ({host}). Reconnect once to continue.",
    stateReconnectTitle: "Reconnection needed",
    stateReconnectDetail: "GravityPort was reinstalled or reset, so the previous connection no longer works. Capture is paused; queued items are kept.",
    stateOutdatedTitle: "GravityPort is out of date",
    stateOutdatedDetail: "This extension needs a newer GravityPort. Check again after updating.",
    stateForbiddenTitle: "GravityPort doesn’t accept this extension",
    stateForbiddenDetail: "Update both GravityPort and this extension to the latest version.",
    stateNotGravityPortTitle: "This address isn’t GravityPort",
    stateNotGravityPortDetail: "The program at {host} isn’t GravityPort. Click Reconnect to search automatically, or change the address under Advanced.",
    stateErrorTitle: "Couldn’t check the connection",
    stateErrorDetail: "The check couldn’t finish ({detail}).",
    stateSettingsErrorTitle: "Couldn’t read extension settings",
    stateSettingsErrorDetail: "Reopen this page and try again ({detail}).",
    actionConnect: "Connect to GravityPort",
    actionWaiting: "Waiting…",
    actionCheckAgain: "Check again",
    actionReconnect: "Reconnect",
    actionDownload: "Download from website",
    actionDownloadPrompt: "Not installed? Download from website",
    actionReload: "Reload",
    autoCaptureLabel: "Auto-capture",
    autoCaptureDesc: "When on, the extension reads only generation-related page data on supported sites and sends images, videos, prompts, and sources to GravityPort on this computer. Off by default; nothing is uploaded to the cloud. Items can also be saved from the right-click menu.",
    autoCaptureEnabled: "Auto-capture is on. Reload open supported sites to apply it.",
    autoCaptureDisabled: "Auto-capture is off.",
    autoCaptureSaveError: "Couldn’t save the auto-capture setting ({detail})",
    supportedSites: "Images: ChatGPT, Gemini, Flow, Google AI Studio, Jimeng, Midjourney, Lovart. Videos: Flow, Google AI Studio, Jimeng, Midjourney.",
    advancedTitle: "Advanced",
    advancedHint: "Manual address and token; rarely needed",
    urlLabel: "GravityPort address",
    urlHint: "Found and filled in automatically when connecting (ports 43517–43521).",
    tokenLabel: "Access token",
    tokenHint: "Filled in automatically after connecting.",
    save: "Save",
    savedChecking: "Saved. Checking again…",
    invalidUrlError: "Enter a valid GravityPort address.",
    nonLocalUrlError: "Use a local address, such as http://127.0.0.1:43517.",
    legacyTokenError: "This development token no longer works. Clear it to connect automatically, or enter the token GravityPort uses now.",
    identityUnreachable: "GravityPort didn’t answer the identity check; try again in a moment",
  },
};

function detectLocale() {
  let lang = "";
  try {
    if (typeof chrome !== "undefined" && chrome.i18n && typeof chrome.i18n.getUILanguage === "function") {
      lang = String(chrome.i18n.getUILanguage() || "");
    }
  } catch {
    // Fall back to navigator.language when chrome.i18n is unavailable.
  }
  if (!lang && typeof navigator !== "undefined" && navigator?.language) {
    lang = String(navigator.language);
  }
  return lang.toLowerCase().startsWith("zh") ? "zh" : "en";
}

const LOCALE = detectLocale();
const COPY = STRINGS[LOCALE];

function t(key) {
  return COPY[key];
}

function formatTemplate(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? ""));
}

function formatError(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "unknown error");
}

function formatHost(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return String(baseUrl || "").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  }
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error(t("invalidUrlError"));
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.username || url.password) {
    throw new Error(t("nonLocalUrlError"));
  }
  return url.origin;
}

const connectionEl = document.getElementById("connection");
const connectionTitleEl = document.getElementById("connectionTitle");
const connectionDetailEl = document.getElementById("connectionDetail");
const connectionNoteEl = document.getElementById("connectionNote");
const connectionActionEl = document.getElementById("connectionAction");
const connectionQuietEl = document.getElementById("connectionQuiet");
const connectionLinkEl = document.getElementById("connectionLink");
const autoCaptureEl = document.getElementById("autoCapture");
const autoCaptureStatusEl = document.getElementById("autoCaptureStatus");
const baseUrlEl = document.getElementById("mosaBaseUrl");
const tokenEl = document.getElementById("mosaToken");
const saveEl = document.getElementById("save");
const advancedStatusEl = document.getElementById("advancedStatus");

function applyStaticI18n() {
  if (document.documentElement) {
    document.documentElement.lang = LOCALE === "zh" ? "zh-CN" : "en";
  }
  document.title = t("docTitle");
  if (typeof document.querySelectorAll === "function") {
    for (const node of document.querySelectorAll("[data-i18n]")) {
      const key = node.getAttribute("data-i18n");
      if (key && Object.prototype.hasOwnProperty.call(COPY, key)) {
        node.textContent = COPY[key];
      }
    }
  }
  if (autoCaptureEl) {
    autoCaptureEl.setAttribute("aria-label", t("autoCaptureLabel"));
  }
}

function buildStateView(model, copy = COPY) {
  const state = model.state;
  const host = model.host || "";
  const version = model.version || "";
  const detail = model.detail || "";

  switch (state) {
    case "checking":
      return {
        state,
        tone: "idle",
        role: "status",
        title: copy.stateCheckingTitle,
        detail: copy.stateCheckingDetail,
        note: "",
        actionLabel: "",
        actionKind: "",
        actionBusy: false,
        quietLabel: "",
        linkLabel: "",
        linkAsPrimary: false,
      };
    case "connected":
      return {
        state,
        tone: "ok",
        role: "status",
        title: copy.stateConnectedTitle,
        detail: version
          ? formatTemplate(copy.stateConnectedDetail, { version, host })
          : formatTemplate(copy.stateConnectedDetailNoVersion, { host }),
        note: "",
        actionLabel: "",
        actionKind: "",
        actionBusy: false,
        quietLabel: copy.actionCheckAgain,
        linkLabel: "",
        linkAsPrimary: false,
      };
    case "pair":
      return {
        state,
        tone: "idle",
        role: "status",
        title: copy.statePairTitle,
        detail: copy.statePairDetail,
        note: model.pairFailed ? copy.statePairFailedNote : "",
        actionLabel: copy.actionConnect,
        actionKind: "pair",
        actionBusy: false,
        quietLabel: "",
        linkLabel: "",
        linkAsPrimary: false,
      };
    case "waiting":
      return {
        state,
        tone: "wait",
        role: "status",
        title: copy.stateWaitingTitle,
        detail: copy.stateWaitingDetail,
        note: "",
        actionLabel: copy.actionWaiting,
        actionKind: "",
        actionBusy: true,
        quietLabel: "",
        linkLabel: "",
        linkAsPrimary: false,
      };
    case "offline":
      return {
        state,
        tone: "bad",
        role: "alert",
        title: copy.stateOfflineTitle,
        detail: copy.stateOfflineDetail,
        note: "",
        actionLabel: copy.actionCheckAgain,
        actionKind: "check",
        actionBusy: false,
        quietLabel: "",
        linkLabel: copy.actionDownloadPrompt,
        linkAsPrimary: false,
      };
    case "moved":
      return {
        state,
        tone: "bad",
        role: "alert",
        title: copy.stateMovedTitle,
        detail: formatTemplate(copy.stateMovedDetail, { host }),
        note: "",
        actionLabel: copy.actionReconnect,
        actionKind: "pair",
        actionBusy: false,
        quietLabel: "",
        linkLabel: "",
        linkAsPrimary: false,
      };
    case "reconnect":
      return {
        state,
        tone: "bad",
        role: "alert",
        title: copy.stateReconnectTitle,
        detail: copy.stateReconnectDetail,
        note: "",
        actionLabel: copy.actionReconnect,
        actionKind: "pair",
        actionBusy: false,
        quietLabel: "",
        linkLabel: "",
        linkAsPrimary: false,
      };
    case "outdated":
      return {
        state,
        tone: "bad",
        role: "alert",
        title: copy.stateOutdatedTitle,
        detail: copy.stateOutdatedDetail,
        note: "",
        actionLabel: "",
        actionKind: "",
        actionBusy: false,
        quietLabel: copy.actionCheckAgain,
        linkLabel: copy.actionDownload,
        linkAsPrimary: true,
      };
    case "forbidden":
      return {
        state,
        tone: "bad",
        role: "alert",
        title: copy.stateForbiddenTitle,
        detail: copy.stateForbiddenDetail,
        note: "",
        actionLabel: "",
        actionKind: "",
        actionBusy: false,
        quietLabel: copy.actionCheckAgain,
        linkLabel: copy.actionDownload,
        linkAsPrimary: true,
      };
    case "not-gravityport":
      return {
        state,
        tone: "bad",
        role: "alert",
        title: copy.stateNotGravityPortTitle,
        detail: formatTemplate(copy.stateNotGravityPortDetail, { host }),
        note: "",
        actionLabel: copy.actionReconnect,
        actionKind: "pair",
        actionBusy: false,
        quietLabel: "",
        linkLabel: "",
        linkAsPrimary: false,
      };
    case "settings-error":
      return {
        state,
        tone: "bad",
        role: "alert",
        title: copy.stateSettingsErrorTitle,
        detail: formatTemplate(copy.stateSettingsErrorDetail, { detail }),
        note: "",
        actionLabel: copy.actionReload,
        actionKind: "reload",
        actionBusy: false,
        quietLabel: "",
        linkLabel: "",
        linkAsPrimary: false,
      };
    case "error":
    default:
      return {
        state: "error",
        tone: "bad",
        role: "alert",
        title: copy.stateErrorTitle,
        detail: formatTemplate(copy.stateErrorDetail, { detail }),
        note: "",
        actionLabel: copy.actionCheckAgain,
        actionKind: "check",
        actionBusy: false,
        quietLabel: "",
        linkLabel: "",
        linkAsPrimary: false,
      };
  }
}

let currentActionKind = "";

function renderState(model) {
  const view = buildStateView(model, COPY);
  currentActionKind = view.actionKind;

  connectionEl.dataset.state = view.state;
  connectionEl.dataset.tone = view.tone;
  connectionEl.setAttribute("role", view.role);

  connectionTitleEl.textContent = view.title;
  connectionDetailEl.textContent = view.detail;

  if (view.note) {
    connectionNoteEl.textContent = view.note;
    connectionNoteEl.hidden = false;
  } else {
    connectionNoteEl.textContent = "";
    connectionNoteEl.hidden = true;
  }

  if (view.actionLabel) {
    connectionActionEl.textContent = view.actionLabel;
    connectionActionEl.hidden = false;
    connectionActionEl.disabled = Boolean(view.actionBusy);
    if (view.actionBusy) {
      connectionActionEl.setAttribute("aria-busy", "true");
    } else {
      connectionActionEl.removeAttribute("aria-busy");
    }
  } else {
    connectionActionEl.textContent = "";
    connectionActionEl.hidden = true;
    connectionActionEl.disabled = false;
    connectionActionEl.removeAttribute("aria-busy");
  }

  if (view.linkLabel) {
    connectionLinkEl.textContent = view.linkLabel;
    connectionLinkEl.setAttribute("href", DOWNLOAD_URL);
    connectionLinkEl.setAttribute("target", "_blank");
    connectionLinkEl.setAttribute("rel", "noopener");
    connectionLinkEl.className = view.linkAsPrimary ? "btn btn-primary" : "link";
    connectionLinkEl.hidden = false;
  } else {
    connectionLinkEl.textContent = "";
    connectionLinkEl.className = "link";
    connectionLinkEl.hidden = true;
  }

  if (view.quietLabel) {
    connectionQuietEl.textContent = view.quietLabel;
    connectionQuietEl.hidden = false;
  } else {
    connectionQuietEl.textContent = "";
    connectionQuietEl.hidden = true;
  }
}

function setInlineStatus(el, message, kind = "ok") {
  el.textContent = message;
  el.hidden = !message;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  if (kind === "error") {
    el.classList.add("is-error");
  } else {
    el.classList.remove("is-error");
  }
}

function setAutoCaptureChecked(checked) {
  autoCaptureEl.setAttribute("aria-checked", checked ? "true" : "false");
}

function isAutoCaptureChecked() {
  return autoCaptureEl.getAttribute("aria-checked") === "true";
}

async function fetchWithTimeout(url, init = {}, timeoutMs = PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

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
    }, PROBE_TIMEOUT_MS);
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
  }, INGEST_PROBE_TIMEOUT_MS);
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

async function probeHealth(origin) {
  try {
    const response = await fetchWithTimeout(`${origin}/api/health`, { cache: "no-cache" }, PROBE_TIMEOUT_MS);
    const data = await response.json().catch(() => null);
    const isMosa = Boolean(response.ok && data?.product === "mosa");
    const version = isMosa ? String(data?.productVersion || "").trim() : "";
    return { origin, reachable: true, isMosa, version };
  } catch {
    return { origin, reachable: false, isMosa: false, version: "" };
  }
}

async function scanDiscoveryPorts(extraOrigin = "") {
  const discoveryOrigins = DISCOVERY_PORTS.map((port) => `http://127.0.0.1:${port}`);
  const allOrigins = extraOrigin && !discoveryOrigins.includes(extraOrigin)
    ? [...discoveryOrigins, extraOrigin]
    : discoveryOrigins;
  const results = await Promise.all(allOrigins.map((origin) => probeHealth(origin)));
  const byOrigin = new Map(results.map((entry) => [entry.origin, entry]));
  const discoveryResults = discoveryOrigins.map((origin) => byOrigin.get(origin));
  const foundMosa = discoveryResults.find((entry) => entry?.isMosa) || null;
  return { foundMosa, byOrigin, discoveryResults };
}

function applySettingsToForm(settings) {
  baseUrlEl.value = settings.mosaBaseUrl || DEFAULTS.mosaBaseUrl;
  tokenEl.value = settings.mosaToken || "";
  setAutoCaptureChecked(settings.autoCapture === true);
}

async function evaluateConnection({ populateForm = false, overrideSettings = null } = {}) {
  let settings;
  try {
    settings = await chrome.storage.local.get(DEFAULTS);
  } catch (error) {
    return { state: "settings-error", detail: formatError(error) };
  }

  if (populateForm) {
    applySettingsToForm(settings);
  }

  const rawBaseUrl = String(overrideSettings?.mosaBaseUrl || settings.mosaBaseUrl || DEFAULTS.mosaBaseUrl).trim();
  const token = String(overrideSettings?.mosaToken ?? settings.mosaToken ?? "").trim();

  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl(rawBaseUrl || DEFAULTS.mosaBaseUrl);
  } catch (error) {
    return { state: "error", detail: formatError(error) };
  }

  if (token) {
    if (token === LEGACY_DEV_TOKEN) {
      return { state: "reconnect" };
    }
    const verdict = await probeServiceIdentity(baseUrl, token);
    if (verdict === "ok") {
      try {
        const probe = await probeIngestToken(baseUrl, token);
        if (probe.status === 400 && probe.data?.code === "WEB_CAPTURE_BAD_IMAGE") {
          const health = await probeHealth(baseUrl);
          return {
            state: "connected",
            host: formatHost(baseUrl),
            version: health.isMosa ? health.version : "",
          };
        }
        if (probe.status === 401 && probe.data?.code === "WEB_CAPTURE_UNAUTHORIZED") {
          return { state: "reconnect" };
        }
        if (probe.status === 403) {
          return { state: "forbidden" };
        }
        return { state: "error", detail: probe.data?.error || `HTTP ${probe.status}` };
      } catch (error) {
        return { state: "error", detail: formatError(error) };
      }
    }
    if (verdict === "mismatch") {
      return { state: "reconnect" };
    }
    if (verdict === "outdated") {
      // 身份接口 404 只说明「这个地址不认识身份核验」：旧版 GravityPort 是这样，
      // 占了这个端口的别的本机程序也是这样。先问 /api/health，确实是
      // GravityPort 才算版本太旧；不是的话按「存的地址上没有 GravityPort」往下查，
      // 免得叫用户去下载一个其实不需要的新版。
      const savedHealth = await probeHealth(baseUrl);
      if (savedHealth.isMosa) {
        return { state: "outdated" };
      }
    }
    // verdict === "offline"，或 404 但这个地址上不是 GravityPort
    const { foundMosa, byOrigin } = await scanDiscoveryPorts(baseUrl);
    const savedHealth = byOrigin.get(baseUrl);
    if (foundMosa && foundMosa.origin !== baseUrl) {
      return { state: "moved", host: formatHost(foundMosa.origin) };
    }
    if (foundMosa) {
      // 存的地址健康检查答了是 GravityPort，身份核验却没连上：多半是瞬时的，
      // 不能说「换了端口（现在还是同一个地址）」。
      return { state: "error", detail: t("identityUnreachable") };
    }
    if (savedHealth?.reachable && !savedHealth.isMosa) {
      return { state: "not-gravityport", host: formatHost(baseUrl) };
    }
    return { state: "offline" };
  }

  const { foundMosa } = await scanDiscoveryPorts();
  if (foundMosa) {
    return { state: "pair" };
  }
  return { state: "offline" };
}

let checkInFlight = false;
let checkQueued = false;
let activeCheckPromise = null;
let pairingInFlight = false;
let lastVisibilityRecheckAt = 0;
let lastSelfSave = null;

async function checkConnection(options = {}) {
  if (pairingInFlight) return;
  if (checkInFlight) {
    checkQueued = true;
    return activeCheckPromise;
  }
  checkInFlight = true;
  renderState({ state: "checking" });
  activeCheckPromise = (async () => {
    try {
      const next = await evaluateConnection(options);
      if (!pairingInFlight) {
        renderState(next);
      }
    } finally {
      checkInFlight = false;
      activeCheckPromise = null;
      if (checkQueued && !pairingInFlight) {
        checkQueued = false;
        await checkConnection();
      }
    }
  })();
  return activeCheckPromise;
}

async function startPairing() {
  if (pairingInFlight) return;
  pairingInFlight = true;
  checkQueued = false;
  renderState({ state: "waiting" });
  try {
    const response = await chrome.runtime.sendMessage({ type: "mosa.repairPairing" });
    if (response?.ok && response.settings?.mosaToken) {
      const pairedToken = String(response.settings.mosaToken);
      let pairedBaseUrl = String(response.settings.mosaBaseUrl || DEFAULTS.mosaBaseUrl);
      tokenEl.value = pairedToken;
      try {
        pairedBaseUrl = normalizeBaseUrl(pairedBaseUrl);
        baseUrlEl.value = pairedBaseUrl;
      } catch {
        // Keep the existing input if the returned URL cannot be normalized.
      }
      pairingInFlight = false;
      await checkConnection({
        overrideSettings: { mosaBaseUrl: pairedBaseUrl, mosaToken: pairedToken },
      });
      return;
    }
    const { foundMosa } = await scanDiscoveryPorts();
    pairingInFlight = false;
    if (foundMosa) {
      renderState({ state: "pair", pairFailed: true });
    } else {
      renderState({ state: "offline" });
    }
  } catch (error) {
    pairingInFlight = false;
    renderState({ state: "error", detail: formatError(error) });
  }
}

connectionActionEl.addEventListener("click", async () => {
  if (currentActionKind === "pair") {
    await startPairing();
  } else if (currentActionKind === "check") {
    await checkConnection();
  } else if (currentActionKind === "reload") {
    if (typeof location !== "undefined" && typeof location.reload === "function") {
      location.reload();
    }
  }
});

connectionQuietEl.addEventListener("click", async () => {
  await checkConnection();
});

autoCaptureEl.addEventListener("click", async () => {
  const previous = isAutoCaptureChecked();
  const next = !previous;
  setAutoCaptureChecked(next);
  try {
    await chrome.storage.local.set({ autoCapture: next });
    setInlineStatus(
      autoCaptureStatusEl,
      next ? t("autoCaptureEnabled") : t("autoCaptureDisabled"),
      "ok",
    );
  } catch (error) {
    setAutoCaptureChecked(previous);
    setInlineStatus(
      autoCaptureStatusEl,
      formatTemplate(t("autoCaptureSaveError"), { detail: formatError(error) }),
      "error",
    );
  }
});

saveEl.addEventListener("click", async () => {
  const token = tokenEl.value.trim();
  if (token === LEGACY_DEV_TOKEN) {
    setInlineStatus(advancedStatusEl, t("legacyTokenError"), "error");
    return;
  }
  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl(baseUrlEl.value.trim() || DEFAULTS.mosaBaseUrl);
  } catch (error) {
    setInlineStatus(advancedStatusEl, formatError(error), "error");
    return;
  }
  try {
    lastSelfSave = { mosaBaseUrl: baseUrl, mosaToken: token, at: Date.now() };
    await chrome.storage.local.set({
      mosaBaseUrl: baseUrl,
      mosaToken: token,
    });
    baseUrlEl.value = baseUrl;
    setInlineStatus(advancedStatusEl, t("savedChecking"), "ok");
    await checkConnection();
  } catch (error) {
    lastSelfSave = null;
    setInlineStatus(advancedStatusEl, formatError(error), "error");
  }
});

if (chrome.storage?.onChanged && typeof chrome.storage.onChanged.addListener === "function") {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName && areaName !== "local") return;
    if (!changes) return;

    if (Object.prototype.hasOwnProperty.call(changes, "mosaBaseUrl")) {
      baseUrlEl.value = changes.mosaBaseUrl.newValue || DEFAULTS.mosaBaseUrl;
    }
    if (Object.prototype.hasOwnProperty.call(changes, "mosaToken")) {
      tokenEl.value = changes.mosaToken.newValue || "";
    }
    if (Object.prototype.hasOwnProperty.call(changes, "autoCapture")) {
      setAutoCaptureChecked(changes.autoCapture.newValue === true);
    }

    const connectionChanged = Object.prototype.hasOwnProperty.call(changes, "mosaToken")
      || Object.prototype.hasOwnProperty.call(changes, "mosaBaseUrl");
    if (!connectionChanged) return;

    if (
      lastSelfSave
      && Date.now() - lastSelfSave.at < SELF_SAVE_ECHO_WINDOW_MS
      && (!Object.prototype.hasOwnProperty.call(changes, "mosaBaseUrl") || changes.mosaBaseUrl.newValue === lastSelfSave.mosaBaseUrl)
      && (!Object.prototype.hasOwnProperty.call(changes, "mosaToken") || changes.mosaToken.newValue === lastSelfSave.mosaToken)
    ) {
      return;
    }

    checkConnection();
  });
}

function handleVisibilityRecheck() {
  if (pairingInFlight) return;
  if (document.visibilityState === "hidden") return;
  const now = Date.now();
  if (now - lastVisibilityRecheckAt < VISIBILITY_RECHECK_COOLDOWN_MS) return;
  lastVisibilityRecheckAt = now;
  checkConnection();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    handleVisibilityRecheck();
  }
});

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("focus", handleVisibilityRecheck);
}

function load() {
  applyStaticI18n();
  checkConnection({ populateForm: true });
}

load();
