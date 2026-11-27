// 任务 458：AI 服务与模型目录——唯一来源。
//
// 以后模型下线、改价只改这张表。预设服务的地址写死在这里，不能改；密钥只
// 发往它所属服务的地址（见 desktop/ipc/ai.mjs 与 lib/ai/connection-test.mjs）。
// 每条模型带 source 网址和 checkedAt（2026-11-22 Claude 按官方文档核过，没有
// 真实调用过；价格单位美元）。价格不在表里的模型在设置页显示「单价未知」。
//
// slots 取值：analysis（逐张分析）、summary（汇总手册）、brain（对话大脑）、
// image（出图）。defaults 列出该模型作为哪家服务默认模型的角色；「分析和汇
// 总」卡的 model 用 analysis 角色、summaryModel 用 summary 角色。

export const AI_SLOTS = ["analysis", "brain", "image"];

// 预设服务。format 是它的接口格式；gemini 比较特殊：文字走 OpenAI 兼容入口、
// 出图走原生入口（见 connection-test），format 仅作展示与家族归类。
// ollama 是本机服务，不需要密钥，也没有 keyUrl。
export const AI_PRESET_SERVICES = Object.freeze([
  {
    id: "claude",
    label: "Claude",
    format: "claude",
    baseUrl: "https://api.anthropic.com",
    keyUrl: "https://platform.claude.com/settings/keys",
  },
  {
    id: "openai",
    label: "OpenAI",
    format: "openai",
    baseUrl: "https://api.openai.com",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "gemini",
    label: "Gemini",
    format: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "ollama",
    label: "本机 Ollama",
    format: "ollama",
    baseUrl: "http://127.0.0.1:11434",
  },
]);

const ANTHROPIC_PRICING_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";
const ANTHROPIC_EFFORT_SOURCE = "https://platform.claude.com/docs/en/build-with-claude/effort";
const OPENAI_PRICING_SOURCE = "https://developers.openai.com/api/docs/pricing";
const GEMINI_PRICING_SOURCE = "https://aistudio.google.com/docs/pricing";

export const AI_EFFORT_LEVELS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
export const AI_LEARNING_DEFAULT_EFFORT = Object.freeze({ analysis: "low", summary: "medium" });
const CLAUDE_UNKNOWN_MODEL_EFFORTS = Object.freeze(["low", "medium", "high"]);

// 模型表。service 是模型家族：claude 模型只给 Claude 和 Claude 格式的自定义
// 服务用，openai 模型给 OpenAI 和 OpenAI 格式的自定义服务用，gemini 模型只
// 给 Gemini 用；Ollama 的模型清单来自最近一次测试连接，不进这张表。
export const AI_MODELS = Object.freeze([
  {
    id: "claude-haiku-5-5",
    label: "Claude Haiku 5.5",
    service: "claude",
    slots: ["analysis", "summary", "brain"],
    defaults: ["analysis", "brain"],
    pricing: { kind: "tokens", input: 0.1, output: 0.5, tier: { thresholdTokens: 100000, input: 0.5, output: 2.5 } },
    source: ANTHROPIC_PRICING_SOURCE,
    checkedAt: "2026-11-22",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    effortSource: ANTHROPIC_EFFORT_SOURCE,
    effortCheckedAt: "2026-11-26",
  },
  {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    service: "claude",
    slots: ["analysis", "summary", "brain"],
    defaults: ["summary"],
    pricing: { kind: "tokens", input: 2, output: 10 },
    source: ANTHROPIC_PRICING_SOURCE,
    checkedAt: "2026-11-22",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    effortSource: ANTHROPIC_EFFORT_SOURCE,
    effortCheckedAt: "2026-11-26",
  },
  // 任务 480：Opus 5.5 思考不能关、默认 effort 是 medium；学习的两步一律
  // 显式传 effort、不传 thinking（主进程的 Claude 客户端），所以照常可用。
  // 不当任何用途的默认模型，逐张分析选它时界面按单价倍数提醒。
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    service: "claude",
    slots: ["analysis", "summary", "brain"],
    defaults: [],
    pricing: { kind: "tokens", input: 4, output: 20 },
    source: ANTHROPIC_PRICING_SOURCE,
    checkedAt: "2026-11-27",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    effortSource: ANTHROPIC_EFFORT_SOURCE,
    effortCheckedAt: "2026-11-27",
  },
  // 任务 480：Fable 5.2 思考恒开、默认 effort 是 high，同样只靠显式 effort
  // 控制。只给汇总手册和对话大脑：逐张分析低/中档走非流式、超时 60s/120s，
  // Fable 单次回答常要好几分钟，而且每张图单价是 Haiku 的 80 倍；汇总本来就走
  // 流式（600s）。Fable 5.2 是「受管模型」，零数据保留的组织调它会 400。
  {
    id: "claude-fable-5-2",
    label: "Claude Fable 5.2",
    service: "claude",
    slots: ["summary", "brain"],
    defaults: [],
    pricing: { kind: "tokens", input: 8, output: 40 },
    source: ANTHROPIC_PRICING_SOURCE,
    checkedAt: "2026-11-27",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    effortSource: ANTHROPIC_EFFORT_SOURCE,
    effortCheckedAt: "2026-11-27",
  },
  {
    id: "gpt-5-nano",
    label: "GPT-5 nano",
    service: "openai",
    slots: ["analysis"],
    defaults: ["analysis"],
    pricing: { kind: "tokens", input: 0.05, output: 0.4 },
    source: OPENAI_PRICING_SOURCE,
    checkedAt: "2026-11-22",
  },
  {
    id: "gpt-5-mini",
    label: "GPT-5 mini",
    service: "openai",
    slots: ["summary", "brain"],
    defaults: ["summary", "brain"],
    pricing: { kind: "tokens", input: 0.25, output: 2 },
    source: OPENAI_PRICING_SOURCE,
    checkedAt: "2026-11-22",
  },
  {
    id: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite",
    service: "gemini",
    slots: ["analysis"],
    defaults: ["analysis"],
    pricing: { kind: "tokens", input: 0.1, output: 0.4 },
    source: GEMINI_PRICING_SOURCE,
    checkedAt: "2026-11-22",
  },
  {
    id: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash-Lite",
    service: "gemini",
    slots: ["summary", "brain"],
    defaults: ["summary", "brain"],
    pricing: { kind: "tokens", input: 0.3, output: 2.5 },
    source: GEMINI_PRICING_SOURCE,
    checkedAt: "2026-11-22",
  },
  {
    id: "gpt-image-2",
    label: "GPT Image 2",
    service: "openai",
    slots: ["image"],
    defaults: ["image"],
    pricing: { kind: "openai-image", imageInput: 8, imageOutput: 30, textInput: 5 },
    source: OPENAI_PRICING_SOURCE,
    checkedAt: "2026-11-22",
  },
  {
    id: "gpt-image-2.5-sunburst",
    label: "GPT Image 2.5 Sunburst",
    service: "openai",
    slots: ["image"],
    defaults: [],
    pricing: { kind: "openai-image", imageInput: 8, imageOutput: 30, textInput: 5 },
    source: OPENAI_PRICING_SOURCE,
    checkedAt: "2026-11-22",
  },
  {
    id: "gpt-image-2.5-flare",
    label: "GPT Image 2.5 Flare",
    service: "openai",
    slots: ["image"],
    defaults: [],
    pricing: { kind: "openai-image", imageInput: 8, imageOutput: 30, textInput: 5 },
    source: OPENAI_PRICING_SOURCE,
    checkedAt: "2026-11-22",
  },
  {
    id: "gpt-image-2.6-sunburst",
    label: "GPT Image 2.6 Sunburst",
    service: "openai",
    slots: ["image"],
    defaults: [],
    pricing: { kind: "openai-image", imageInput: 8, imageOutput: 30, textInput: 5 },
    source: OPENAI_PRICING_SOURCE,
    checkedAt: "2026-11-22",
  },
  {
    id: "gpt-image-2.6-flare",
    label: "GPT Image 2.6 Flare",
    service: "openai",
    slots: ["image"],
    defaults: [],
    pricing: { kind: "openai-image", imageInput: 8, imageOutput: 30, textInput: 5 },
    source: OPENAI_PRICING_SOURCE,
    checkedAt: "2026-11-22",
  },
  {
    id: "gpt-image-1.5",
    label: "GPT Image 1.5",
    service: "openai",
    slots: ["image"],
    defaults: [],
    pricing: { kind: "openai-image", imageInput: 8, imageOutput: 32, textInput: 5, textOutput: 10 },
    source: OPENAI_PRICING_SOURCE,
    checkedAt: "2026-11-22",
  },
  {
    id: "gpt-image-1-mini",
    label: "GPT Image 1 mini",
    service: "openai",
    slots: ["image"],
    defaults: [],
    pricing: { kind: "openai-image", imageInput: 2.5, imageOutput: 8, textInput: 2 },
    source: OPENAI_PRICING_SOURCE,
    checkedAt: "2026-11-22",
  },
  {
    id: "gemini-nano-banana-2.1",
    label: "Nano Banana 2.1",
    service: "gemini",
    slots: ["image"],
    defaults: ["image"],
    pricing: { kind: "per-image", perImage: 0.0336 },
    source: GEMINI_PRICING_SOURCE,
    checkedAt: "2026-11-22",
  },
  {
    id: "gemini-3.1-flash-image",
    label: "Nano Banana 2",
    service: "gemini",
    slots: ["image"],
    defaults: [],
    pricing: { kind: "per-image", perImage: 0.067 },
    source: GEMINI_PRICING_SOURCE,
    checkedAt: "2026-11-22",
  },
  {
    id: "gemini-3-pro-image",
    label: "Nano Banana Pro",
    service: "gemini",
    slots: ["image"],
    defaults: [],
    pricing: { kind: "per-image", perImage: 0.134 },
    source: GEMINI_PRICING_SOURCE,
    checkedAt: "2026-11-22",
  },
]);

// gemini-2.5-flash（官方说 2026-12-01 起转到 3.5 Flash-Lite）、
// gemini-2.5-flash-image（2027-03-15 停服）、gpt-image-1（已下线）不进表；
// OpenAI 的 nano / mini 能不能看图官方页没写清，表里照列，由第 8 张单实测。

const AI_MODEL_BY_ID = new Map(AI_MODELS.map((model) => [model.id, model]));
const AI_PRESET_BY_ID = new Map(AI_PRESET_SERVICES.map((service) => [service.id, service]));

/** Preset service by id, or null. Custom services are not preset. */
export function aiPresetServiceById(serviceId) {
  return AI_PRESET_BY_ID.get(serviceId) || null;
}

export function aiModelById(modelId) {
  return AI_MODEL_BY_ID.get(modelId) || null;
}

// 任务 480：只用来给服务端兜底计价的模型，不进任何下拉、也不算「单价已知」
// 可选模型。汇总手册带 fallbacks: "default"，被拒时由服务端按拒绝类别换模型，
// 换到哪个不公开；这里列官方文档点名过的兜底目标（2026-11-27 核价）。
const AI_FALLBACK_BILLING_MODELS = Object.freeze([
  { id: "claude-sonnet-5", pricing: { kind: "tokens", input: 2, output: 10 }, source: ANTHROPIC_PRICING_SOURCE, checkedAt: "2026-11-27" },
  { id: "claude-opus-5", pricing: { kind: "tokens", input: 5, output: 25 }, source: ANTHROPIC_PRICING_SOURCE, checkedAt: "2026-11-27" },
  { id: "claude-opus-4-8", pricing: { kind: "tokens", input: 5, output: 25 }, source: ANTHROPIC_PRICING_SOURCE, checkedAt: "2026-11-27" },
]);
const AI_FALLBACK_BILLING_BY_ID = new Map(AI_FALLBACK_BILLING_MODELS.map((model) => [model.id, model]));
// 认不出的兜底模型按这张表里最贵的一档算：宁可多算，不让花费上限失守。
const AI_FALLBACK_BILLING_CEILING = AI_FALLBACK_BILLING_MODELS.reduce(
  (top, model) => (model.pricing.output > top.pricing.output ? model : top),
);

/**
 * 服务端兜底实际用的模型按什么单价计：可选模型照单价表；兜底目标表里有的照
 * 它；都没有就按兜底目标里最贵的一档。返回 { id, pricing }，id 是计价所用的模型。
 */
export function aiFallbackBillingModel(modelId) {
  const entry = aiModelById(modelId) || AI_FALLBACK_BILLING_BY_ID.get(modelId);
  if (entry?.pricing?.kind === "tokens") return { id: entry.id, pricing: entry.pricing };
  return { id: AI_FALLBACK_BILLING_CEILING.id, pricing: AI_FALLBACK_BILLING_CEILING.pricing };
}

/**
 * A service's model family: presets use their own id, Claude-format custom
 * services draw from the Claude table, everything else custom from OpenAI's.
 */
export function aiServiceFamily(service) {
  if (!service) return "";
  if (AI_PRESET_BY_ID.has(service.id)) return service.id;
  return service.format === "claude" ? "claude" : "openai";
}

/** Whether the service can sit in the image slot (出图块只列能出图的). */
export function aiIsImageCapable(service) {
  const family = aiServiceFamily(service);
  return family === "openai" || family === "gemini";
}

/** Catalog models the service may use in the slot ("summary" included). */
export function aiModelsForServiceSlot(service, slot) {
  const family = aiServiceFamily(service);
  if (!family) return [];
  return AI_MODELS.filter((model) => model.service === family && model.slots.includes(slot));
}

/**
 * The catalog default model for a role: analysis 逐张分析、summary 汇总手册、
 * brain 对话大脑、image 出图。Ollama has no catalog models and returns "".
 */
export function aiDefaultModel(service, role) {
  const family = aiServiceFamily(service);
  if (!family) return "";
  const model = AI_MODELS.find((entry) => entry.service === family && entry.defaults.includes(role));
  return model ? model.id : "";
}

/**
 * 该服务+模型支持的推理强度列表（任务 476）：Claude 家族在表里的模型取表里
 * 的 efforts，不在表里（测试连接发现的）给保守三档；别家与 Ollama 返回 []。
 */
export function aiEffortLevelsFor(service, modelId) {
  if (!service || !modelId) return [];
  const family = aiServiceFamily(service);
  if (family !== "claude" || service.format === "ollama") return [];
  const model = aiModelById(String(modelId));
  if (model) {
    if (model.service !== "claude" || !Array.isArray(model.efforts)) return [];
    return [...model.efforts];
  }
  return [...CLAUDE_UNKNOWN_MODEL_EFFORTS];
}

/**
 * 学习某一步（analysis / summary）实际生效的推理强度：读存着的档位，不在
 * 支持列表里就退回默认档；默认档也不在列表里则取第一档；无支持列表返回 ""。
 */
export function aiEffortFor(slotState, role, service) {
  const modelId = role === "summary"
    ? String(slotState?.summaryModel || "")
    : String(slotState?.model || "");
  const levels = aiEffortLevelsFor(service, modelId);
  if (levels.length === 0) return "";
  const stored = role === "summary"
    ? String(slotState?.summaryEffort || "")
    : String(slotState?.effort || "");
  if (stored && levels.includes(stored)) return stored;
  const fallback = AI_LEARNING_DEFAULT_EFFORT[role] || "low";
  if (levels.includes(fallback)) return fallback;
  return levels[0];
}

function formatUsdTokenPrice(value) {
  return `$${Number(value).toFixed(2)}`;
}

function formatUsdPerImage(value) {
  // 按张计价保留到厘（0.0336 → $0.034），再多的小数位对展示没有意义。
  const rounded = Math.round(Number(value) * 1000) / 1000;
  return `$${String(rounded)}`;
}

function formatMonthUsd(value) {
  return `$${(Math.round(Number(value) * 100) / 100).toFixed(2)}`;
}

/**
 * 单价那一行的文字（C.3）：返回 { template, params }，模板键在 i18n.ts 有对应
 * 英文条目，界面先翻译模板再填参数。monthCostUsd 传了才带「本月」段（分析和
 * 汇总卡的单价行不带，本月合计单独一行）。
 */
export function aiPriceLine(modelId, monthCostUsd) {
  const model = aiModelById(modelId);
  if (!model) {
    return monthCostUsd === undefined
      ? { template: "单价未知", params: {} }
      : { template: "单价未知 · 本月 {month}", params: { month: formatMonthUsd(monthCostUsd) } };
  }
  const { pricing } = model;
  if (pricing.kind === "tokens") {
    const params = { input: formatUsdTokenPrice(pricing.input), output: formatUsdTokenPrice(pricing.output) };
    if (monthCostUsd === undefined) {
      return { template: "单价 输入 {input} · 输出 {output}（每百万 token）", params };
    }
    params.month = formatMonthUsd(monthCostUsd);
    return { template: "单价 输入 {input} · 输出 {output}（每百万 token）· 本月 {month}", params };
  }
  if (pricing.kind === "openai-image") {
    const params = { output: formatUsdTokenPrice(pricing.imageOutput) };
    if (monthCostUsd === undefined) {
      return { template: "单价 图像输出 {output}（每百万 token）", params };
    }
    params.month = formatMonthUsd(monthCostUsd);
    return { template: "单价 图像输出 {output}（每百万 token）· 本月 {month}", params };
  }
  if (pricing.kind === "per-image") {
    const params = { price: formatUsdPerImage(pricing.perImage) };
    if (monthCostUsd === undefined) {
      return { template: "单价 约 {price} 一张（1K）", params };
    }
    params.month = formatMonthUsd(monthCostUsd);
    return { template: "单价 约 {price} 一张（1K）· 本月 {month}", params };
  }
  return aiPriceLine(null, monthCostUsd);
}

/** Ollama 的单价行：本机运行不收费，永远没有「本月」段。 */
export function aiFreePriceLine() {
  return { template: "本机运行，不收费", params: {} };
}

/** 「分析和汇总」卡的本月合计行。 */
export function aiMonthTotalLine(monthCostUsd) {
  return { template: "本月合计 {month}", params: { month: formatMonthUsd(monthCostUsd) } };
}
