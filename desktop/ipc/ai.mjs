// 任务 458：AI 设置页的五个 IPC 通道。
//
// 每个通道第一行都过 trustedRendererEvent（desktop/main.mjs 第 646 行的唯一
// 闸门），不可信一律 { ok: false } 且不做任何事。任何返回值里都不出现密钥
// 原文（last4 除外），服务返回的原文一个字都不显示、不记日志。测试请求由
// deps.outboundFetch 发（正式运行是 serviceOutboundFetch = net.fetch，走系统
// 代理、不带 cookie）；没有 HTTP 路由，密钥不出主进程。

import {
  AI_MODELS,
  AI_PRESET_SERVICES,
  aiFreePriceLine,
  aiModelById,
  aiMonthTotalLine,
  aiPresetServiceById,
  aiPriceLine,
} from "../../lib/ai/model-catalog.mjs";
import {
  AI_CONNECTION_SUCCESS_TEMPLATE,
  buildConnectionTestRequest,
  classifyConnectionTestError,
  describeConnectionFailure,
  parseConnectionTestResponse,
  readConnectionTestBody,
} from "../../lib/ai/connection-test.mjs";
import { monthTotals } from "../ai/usage-ledger.mjs";

function serviceLabel(service) {
  return String(service?.label || service?.id || "");
}

/** 单价行（C.3）：分析和汇总两个模型各一行（不带本月）+ 本月合计一行。 */
function buildPriceLines(slots, month, resolveService) {
  const lines = {};
  for (const slot of ["analysis", "brain", "image"]) {
    const service = resolveService(slots[slot]?.serviceId);
    if (slot === "analysis") {
      if (!service) {
        lines.analysis = [aiPriceLine(null, month.analysis)];
      } else if (service.id === "ollama" || service.format === "ollama") {
        lines.analysis = [aiFreePriceLine()];
      } else {
        lines.analysis = [
          aiPriceLine(slots.analysis.model || null),
          aiPriceLine(slots.analysis.summaryModel || null),
          aiMonthTotalLine(month.analysis),
        ];
      }
      continue;
    }
    if (!service) {
      lines[slot] = [aiPriceLine(null, month[slot])];
    } else if (service.id === "ollama" || service.format === "ollama") {
      lines[slot] = [aiFreePriceLine()];
    } else {
      lines[slot] = [aiPriceLine(slots[slot]?.model || null, month[slot])];
    }
  }
  return lines;
}

function buildServiceList(settings, keyStatus) {
  const presets = AI_PRESET_SERVICES.map((service) => ({
    id: service.id,
    label: service.label,
    format: service.format,
    baseUrl: service.baseUrl,
    hasKey: keyStatus[service.id]?.hasKey === true,
    last4: String(keyStatus[service.id]?.last4 || ""),
    ...(service.keyUrl ? { keyUrl: service.keyUrl } : {}),
    lastTest: settings.lastTests[service.id] || null,
  }));
  const customs = settings.customServices.map((custom) => ({
    id: custom.id,
    label: custom.label,
    format: custom.format,
    baseUrl: custom.baseUrl,
    hasKey: keyStatus[custom.id]?.hasKey === true,
    last4: String(keyStatus[custom.id]?.last4 || ""),
    lastTest: settings.lastTests[custom.id] || null,
  }));
  return [...presets, ...customs];
}

/** 「当前选的模型不在清单里」提醒：只提醒，不算失败。 */
function findMissingModel(slots, serviceId, purpose, models) {
  if (!Array.isArray(models) || models.length === 0) return "";
  const candidates = purpose === "image"
    ? [slots.image?.serviceId === serviceId ? slots.image?.model : ""]
    : [
      slots.analysis?.serviceId === serviceId ? slots.analysis?.model : "",
      slots.analysis?.serviceId === serviceId ? slots.analysis?.summaryModel : "",
      slots.brain?.serviceId === serviceId ? slots.brain?.model : "",
    ];
  for (const modelId of candidates) {
    if (modelId && !models.includes(modelId)) return aiModelById(modelId)?.label || modelId;
  }
  return "";
}

export function registerAiIpc(deps) {
  const {
    ipcMain,
    trustedRendererEvent,
    aiCredentialStore,
    aiSettingsStore,
    desktopDataDir,
    aiOutboundFetch: outboundFetch,
  } = deps;

  async function resolveService(serviceId) {
    if (typeof serviceId !== "string" || !serviceId) return null;
    const preset = aiPresetServiceById(serviceId);
    if (preset) return preset;
    const settings = await aiSettingsStore.read();
    const custom = settings.customServices.find((entry) => entry.id === serviceId);
    return custom ? { ...custom, custom: true } : null;
  }

  async function buildAiState() {
    const settings = await aiSettingsStore.read();
    const keyStatus = await aiCredentialStore.status();
    const month = await monthTotals(desktopDataDir, new Date());
    const resolve = (serviceId) => {
      const preset = aiPresetServiceById(serviceId);
      if (preset) return preset;
      return settings.customServices.find((entry) => entry.id === serviceId) || null;
    };
    return {
      available: aiCredentialStore.isEncryptionAvailable(),
      services: buildServiceList(settings, keyStatus),
      slots: settings.slots,
      catalog: { services: AI_PRESET_SERVICES, models: AI_MODELS },
      priceLines: buildPriceLines(settings.slots, month, resolve),
      monthTotals: month,
    };
  }

  ipcMain.handle("ai-get-state", async (event) => {
    if (!trustedRendererEvent(event)) return { ok: false };
    return buildAiState();
  });

  ipcMain.handle("ai-save-key", async (event, serviceId, key) => {
    if (!trustedRendererEvent(event)) return { ok: false };
    const service = await resolveService(serviceId);
    if (!service) return { ok: false };
    const hadKey = (await aiCredentialStore.status())[serviceId]?.hasKey === true;
    const result = await aiCredentialStore.save(serviceId, key);
    if (!result.ok) return { ok: false, reason: result.reason };
    // 第一次存某一家的密钥：还「未选择」的块自动选这一家和它的默认模型
    //（出图块只在这一家能出图时才自动选），只填一家也能用。
    if (!hadKey) await aiSettingsStore.autoSelectService(serviceId);
    return { ok: true, last4: result.last4 };
  });

  ipcMain.handle("ai-delete-key", async (event, serviceId) => {
    if (!trustedRendererEvent(event)) return { ok: false };
    const service = await resolveService(serviceId);
    if (!service) return { ok: false };
    return aiCredentialStore.remove(serviceId);
  });

  ipcMain.handle("ai-test-connection", async (event, serviceId, purpose) => {
    if (!trustedRendererEvent(event)) return { ok: false };
    const service = await resolveService(serviceId);
    if (!service) return { ok: false };
    const testPurpose = purpose === "image" ? "image" : "text";
    const key = service.id === "ollama" || service.format === "ollama"
      ? ""
      : (await aiCredentialStore.readForRequest(serviceId)) || "";
    let outcome;
    try {
      const { url, init } = buildConnectionTestRequest(service, key, testPurpose);
      const response = await outboundFetch(url, init);
      const bodyText = await readConnectionTestBody(response);
      if (bodyText === null) {
        outcome = { ok: false, code: "bad-response", models: [], status: response.status };
      } else {
        outcome = parseConnectionTestResponse(service, response.status, bodyText);
      }
    } catch (error) {
      outcome = classifyConnectionTestError(service, error);
    }
    const settings = await aiSettingsStore.read();
    const described = outcome.ok
      ? {
        code: "ok",
        template: AI_CONNECTION_SUCCESS_TEMPLATE,
        params: { count: String(outcome.models.length) },
        message: AI_CONNECTION_SUCCESS_TEMPLATE.replace("{count}", String(outcome.models.length)),
      }
      : describeConnectionFailure(serviceLabel(service), outcome);
    const display = {
      message: described.message,
      template: described.template,
      params: described.params,
      modelCount: outcome.models.length,
    };
    const missingModel = findMissingModel(settings.slots, serviceId, testPurpose, outcome.models);
    if (missingModel) display.missingModel = missingModel;
    // 清单（只有模型 id，不含密钥）存进设置文件，供模型下拉框用。
    await aiSettingsStore.recordTest(serviceId, { ...outcome, display });
    return {
      ok: outcome.ok,
      code: outcome.code,
      message: described.message,
      template: described.template,
      params: described.params,
      modelCount: outcome.models.length,
      ...(missingModel ? { missingModel } : {}),
    };
  });

  ipcMain.handle("ai-update-settings", async (event, payload) => {
    if (!trustedRendererEvent(event)) return { ok: false };
    if (!payload || typeof payload !== "object") return { ok: false };
    // 自定义服务被删（或校验不过被丢）：连它的密钥一起删。
    const { removedCustomIds } = await aiSettingsStore.applyUpdate({
      slots: payload.slots,
      customServices: payload.customServices,
    });
    for (const id of removedCustomIds) {
      await aiCredentialStore.remove(id);
    }
    return { ok: true, state: await buildAiState() };
  });
}
