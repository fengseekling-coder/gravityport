// 任务 458：AI 设置与最近一次测试结果（userData 里的 ai-settings.json）。
//
// 这个文件不含密钥：只有服务 id、模型 id、自定义服务地址、最近一次测试的
// 归类结果和模型清单（只有模型 id）。主进程逐项校验渲染层发来的更新，不认
// 识的字段丢掉；预设服务的地址写死在 lib/ai/model-catalog.mjs，不能改。

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AI_PRESET_SERVICES,
  aiDefaultModel,
  aiIsImageCapable,
  aiModelsForServiceSlot,
} from "../../lib/ai/model-catalog.mjs";

const SETTINGS_FILE_NAME = "ai-settings.json";
const MAX_URL_LENGTH = 2048;
const MAX_LABEL_LENGTH = 80;
const CUSTOM_SERVICE_ID_RE = /^custom-[0-9a-f]{8}$/;
const CUSTOM_URL_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function emptyAiSettings() {
  return {
    version: 1,
    slots: {
      analysis: { serviceId: "", model: "", summaryModel: "" },
      brain: { serviceId: "", model: "" },
      image: { serviceId: "", model: "" },
    },
    customServices: [],
    lastTests: {},
  };
}

/**
 * 自定义服务地址：只收 https://，或 http:// 且主机是 localhost / 127.0.0.1 /
 * [::1]；不许带 user:pass@；最长 2048。file:///、javascript: 等一律拒。
 */
export function isValidCustomServiceUrl(url) {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return false;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:") return CUSTOM_URL_LOOPBACK_HOSTS.has(parsed.hostname);
  return false;
}

function normalizeCustomService(entry, index) {
  if (!entry || typeof entry !== "object") return null;
  const label = String(entry.label ?? "").trim().slice(0, MAX_LABEL_LENGTH);
  const format = entry.format === "claude" ? "claude" : entry.format === "openai" ? "openai" : "";
  const baseUrl = String(entry.baseUrl ?? "").trim();
  if (!label || !format || !isValidCustomServiceUrl(baseUrl)) return null;
  const id = typeof entry.id === "string" && CUSTOM_SERVICE_ID_RE.test(entry.id)
    ? entry.id
    : `custom-${randomBytes(4).toString("hex")}`;
  // id 冲突不可能出现（randomBytes(4)），但同一次提交里重复的 id 收敛为一条。
  return { id, label, format, baseUrl: baseUrl.replace(/\/+$/, ""), index };
}

function slotAllowedModels(service, slot, lastTests) {
  const catalogIds = aiModelsForServiceSlot(service, slot).map((model) => model.id);
  const tested = Array.isArray(lastTests?.[service.id]?.models) ? lastTests[service.id].models : [];
  return new Set([...catalogIds, ...tested.map((id) => String(id)), ""]);
}

function normalizeSlotUpdate(role, incoming, previous, knownServices, lastTests) {
  const next = { ...previous };
  if (!incoming || typeof incoming !== "object") return next;
  if ("serviceId" in incoming) {
    const serviceId = String(incoming.serviceId ?? "");
    const service = knownServices.get(serviceId);
    const capable = serviceId === "" || (service && (role !== "image" || aiIsImageCapable(service)));
    if (capable) {
      // 换了服务就把原服务的模型清掉（模型属于服务家族，跨家沿用没有意义）。
      if (next.serviceId !== serviceId) {
        next.model = "";
        next.summaryModel = "";
      }
      next.serviceId = serviceId;
    } // 不可用的服务（如出图块选了 Claude）丢弃这项，保留原值。
  }
  const service = knownServices.get(next.serviceId);
  if ("model" in incoming) {
    const allowed = service ? slotAllowedModels(service, role, lastTests) : new Set([""]);
    const model = String(incoming.model ?? "");
    if (allowed.has(model)) next.model = model;
  }
  if (role === "analysis" && "summaryModel" in incoming) {
    // 「汇总手册」用 summary 角色的模型表，和逐张分析分开校验。
    const allowedSummary = service ? slotAllowedModels(service, "summary", lastTests) : new Set([""]);
    const summaryModel = String(incoming.summaryModel ?? "");
    if (allowedSummary.has(summaryModel)) next.summaryModel = summaryModel;
  }
  return next;
}

/**
 * @param {{ dir: string }} options - dir 传 desktopDataDir（userData）。
 */
export function createAiSettingsStore({ dir }) {
  const filePath = join(dir, SETTINGS_FILE_NAME);

  async function readRaw() {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  async function writeSettings(data) {
    await mkdir(dir, { recursive: true });
    const tempPath = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(tempPath, JSON.stringify(data, null, 2), { mode: 0o600 });
      await chmod(tempPath, 0o600); // Ensure mode on all platforms.
      await rename(tempPath, filePath);
    } catch (error) {
      await unlink(tempPath).catch(() => {});
      throw error;
    }
  }

  function mergeDefaults(stored) {
    const defaults = emptyAiSettings();
    const merged = {
      ...defaults,
      ...(stored && typeof stored === "object" ? stored : {}),
      slots: {
        analysis: { ...defaults.slots.analysis, ...(stored?.slots?.analysis || {}) },
        brain: { ...defaults.slots.brain, ...(stored?.slots?.brain || {}) },
        image: { ...defaults.slots.image, ...(stored?.slots?.image || {}) },
      },
      customServices: Array.isArray(stored?.customServices)
        ? stored.customServices.filter((entry) => entry && typeof entry === "object" && CUSTOM_SERVICE_ID_RE.test(entry.id))
        : [],
      lastTests: stored?.lastTests && typeof stored.lastTests === "object" ? stored.lastTests : {},
    };
    return merged;
  }

  async function knownServiceMap(customServices) {
    const map = new Map(AI_PRESET_SERVICES.map((service) => [service.id, service]));
    for (const custom of customServices) {
      map.set(custom.id, { id: custom.id, label: custom.label, format: custom.format, baseUrl: custom.baseUrl, custom: true });
    }
    return map;
  }

  return {
    /** 当前设置（合并过默认值）。 */
    async read() {
      return mergeDefaults(await readRaw());
    },

    /** 第一次存某一家的密钥后调用：还「未选择」的块自动选这一家和它的默认模型。 */
    async autoSelectService(serviceId) {
      const settings = await this.read();
      const isPreset = AI_PRESET_SERVICES.some((preset) => preset.id === serviceId);
      const custom = settings.customServices.find((entry) => entry.id === serviceId);
      if (!isPreset && !custom) return settings;
      const service = custom ? { ...custom, custom: true } : { id: serviceId, format: serviceId };
      const slots = settings.slots;
      if (!slots.analysis.serviceId) {
        slots.analysis = {
          serviceId,
          model: aiDefaultModel(service, "analysis"),
          summaryModel: aiDefaultModel(service, "summary"),
        };
      }
      if (!slots.brain.serviceId) {
        slots.brain = { serviceId, model: aiDefaultModel(service, "brain") };
      }
      if (!slots.image.serviceId && aiIsImageCapable(service)) {
        slots.image = { serviceId, model: aiDefaultModel(service, "image") };
      }
      await writeSettings(settings);
      return settings;
    },

    /** 记录最近一次测试连接的结果（models 只有模型 id，不含密钥）。 */
    async recordTest(serviceId, result) {
      const settings = await this.read();
      settings.lastTests[serviceId] = {
        ok: result.ok === true,
        code: String(result.code || ""),
        at: new Date().toISOString(),
        models: Array.isArray(result.models) ? result.models.map((id) => String(id)) : [],
        ...(result.display && typeof result.display === "object" ? { display: result.display } : {}),
      };
      await writeSettings(settings);
      return settings;
    },

    /**
     * 应用渲染层发来的更新：customServices 逐条校验（无效条目丢弃、新条目
     * 发 id），slots 逐项校验（不认识的服务/模型丢弃该项、保留原值）。
     * 被删掉（或校验不过被丢）的自定义服务：用到它的槽位退回「未选择」；
     * 返回值带 removedCustomIds，调用方（desktop/ipc/ai.mjs）负责连密钥一起删。
     */
    async applyUpdate({ slots, customServices } = {}) {
      const settings = await this.read();
      const previousCustomIds = settings.customServices.map((entry) => entry.id);

      if (Array.isArray(customServices)) {
        const seen = new Set();
        const next = [];
        for (const entry of customServices) {
          const normalized = normalizeCustomService(entry, next.length);
          if (!normalized || seen.has(normalized.id)) continue;
          seen.add(normalized.id);
          next.push({ id: normalized.id, label: normalized.label, format: normalized.format, baseUrl: normalized.baseUrl });
        }
        settings.customServices = next;
      }

      const removedCustomIds = previousCustomIds.filter((id) => !settings.customServices.some((entry) => entry.id === id));
      const removed = new Set(removedCustomIds);

      // 删掉的自定义服务：用到它的槽位退回「未选择」。
      for (const role of ["analysis", "brain", "image"]) {
        if (removed.has(settings.slots[role]?.serviceId)) {
          settings.slots[role] = role === "analysis"
            ? { serviceId: "", model: "", summaryModel: "" }
            : { serviceId: "", model: "" };
        }
      }

      const knownServices = await knownServiceMap(settings.customServices);
      if (slots && typeof slots === "object") {
        settings.slots.analysis = normalizeSlotUpdate("analysis", slots.analysis, settings.slots.analysis, knownServices, settings.lastTests);
        settings.slots.brain = normalizeSlotUpdate("brain", slots.brain, settings.slots.brain, knownServices, settings.lastTests);
        settings.slots.image = normalizeSlotUpdate("image", slots.image, settings.slots.image, knownServices, settings.lastTests);
      }

      await writeSettings(settings);
      return { settings, removedCustomIds };
    },
  };
}
