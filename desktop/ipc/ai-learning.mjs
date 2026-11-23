// 任务 463：学习后台的六个 IPC 通道。
//
// 每个通道第一行都过 trustedRendererEvent（desktop/main.mjs 的唯一闸门），
// 不可信一律 { ok: false } 且不做任何事。runner 在这里用 deps 建一次；deps
// 不含任何素材库目录（ai-key-isolation 的同款要求）：密钥、请求、花费都留在
// 主进程，学习流程经服务 HTTP 读写，服务永远看不到密钥。
import { createLearningRunner } from "../ai/learning-runner.mjs";

function isShortString(value, max = 200) {
  return typeof value === "string" && value.length <= max;
}

function isQuoteToken(value) {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

export function registerAiLearningIpc(deps) {
  const {
    ipcMain,
    trustedRendererEvent,
    aiCredentialStore,
    aiSettingsStore,
    aiOutboundFetch,
    getService,
    desktopDataDir,
    getCurrentLocale,
  } = deps;

  const runner = createLearningRunner({
    getService,
    credentialStore: aiCredentialStore,
    settingsStore: aiSettingsStore,
    ledgerDir: desktopDataDir,
    outboundFetch: aiOutboundFetch,
  });

  ipcMain.handle("ai-learning-quote", async (event, payload) => {
    if (!trustedRendererEvent(event)) return { ok: false };
    if (!payload || typeof payload !== "object") return { ok: false };
    const project = isShortString(payload.project) ? payload.project : "";
    const libraryId = isShortString(payload.libraryId) ? payload.libraryId : "";
    const runId = isShortString(payload.runId) ? payload.runId : null;
    if (!project || !libraryId) return { ok: false };
    const language = typeof getCurrentLocale === "function" ? String(getCurrentLocale() || "en") : "en";
    return runner.quote({ project, libraryId, runId, language });
  });

  ipcMain.handle("ai-learning-start", async (event, payload) => {
    if (!trustedRendererEvent(event)) return { ok: false };
    if (!payload || typeof payload !== "object") return { ok: false };
    if (!isQuoteToken(payload.quoteToken)) return { ok: false, reason: "quote-expired" };
    return runner.start({ quoteToken: payload.quoteToken });
  });

  ipcMain.handle("ai-learning-pause", async (event, payload) => {
    if (!trustedRendererEvent(event)) return { ok: false };
    if (!payload || typeof payload !== "object") return { ok: false };
    if (!isShortString(payload.runId)) return { ok: false };
    return runner.pause({ runId: payload.runId });
  });

  ipcMain.handle("ai-learning-resume", async (event, payload) => {
    if (!trustedRendererEvent(event)) return { ok: false };
    if (!payload || typeof payload !== "object") return { ok: false };
    if (!isShortString(payload.runId)) return { ok: false };
    if (!isQuoteToken(payload.quoteToken)) return { ok: false, reason: "quote-expired" };
    return runner.resume({ runId: payload.runId, quoteToken: payload.quoteToken });
  });

  ipcMain.handle("ai-learning-abandon", async (event, payload) => {
    if (!trustedRendererEvent(event)) return { ok: false };
    if (!payload || typeof payload !== "object") return { ok: false };
    if (!isShortString(payload.runId)) return { ok: false };
    return runner.abandon({ runId: payload.runId });
  });

  ipcMain.handle("ai-learning-status", async (event, payload) => {
    if (!trustedRendererEvent(event)) return { ok: false };
    if (!payload || typeof payload !== "object") return { ok: false };
    const project = isShortString(payload.project) ? payload.project : "";
    const libraryId = isShortString(payload.libraryId) ? payload.libraryId : "";
    if (!project || !libraryId) return { ok: false };
    return runner.status({ project, libraryId });
  });
}
