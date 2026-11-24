// 任务 468：AI 设置页的纯函数模型。
// 不依赖 DOM / React / Vite，只引用 desktop.ts 的类型；单测
// （test/ai-settings-ui.test.mjs）用 tsc 编译后直接 import。

import type { AiPriceLine, AiServiceState, AiState } from "./desktop"

export type SlotId = "analysis" | "brain" | "image"
export type ModelRole = "analysis" | "summary" | "brain" | "image"

export const ADD_CUSTOM_SERVICE_VALUE = "__add_custom__"

const PRESET_ORDER = ["claude", "openai", "gemini", "ollama"] as const

const PRICE_TEMPLATE_WITHOUT_MONTH: Record<string, string> = {
  "单价 输入 {input} · 输出 {output}（每百万 token）· 本月 {month}":
    "单价 输入 {input} · 输出 {output}（每百万 token）",
  "单价 图像输出 {output}（每百万 token）· 本月 {month}":
    "单价 图像输出 {output}（每百万 token）",
  "单价 约 {price} 一张（1K）· 本月 {month}":
    "单价 约 {price} 一张（1K）",
  "单价未知 · 本月 {month}":
    "单价未知",
}

export type AddableServiceOption = {
  value: string
  label: string
}

export type ModelOption = {
  value: string
  label: string
  hint?: string
}

export type ModelGroup = {
  serviceId: string
  heading: string
  options: ModelOption[]
}

export type CostMultiple = {
  multiple: number
  referenceId: string
  referenceLabel: string
}

export type UseRowNoteKind =
  | "no-key"
  | "test-failed"
  | "learning-unsupported"
  | "analysis-expensive"
  | "learning-unknown-price"
  | "unknown-price"
  | "image-needs-service"

export type UseRowNote = {
  kind: UseRowNoteKind
  tone: "danger" | "info"
  params: Record<string, string>
}

export function isCustomService(service: AiServiceState): boolean {
  return service.id.startsWith("custom-")
}

export function isOllamaService(service: AiServiceState): boolean {
  return service.id === "ollama" || service.format === "ollama"
}

// Presets draw from their own family; Claude-format custom services draw from
// the Claude table, everything else custom from OpenAI's (同一份规则在
// lib/ai/model-catalog.mjs，主进程校验用那份，这里只为选默认模型和单价对照)。
export function serviceFamily(service: AiServiceState): string {
  if (!isCustomService(service)) return service.id
  return service.format === "claude" ? "claude" : "openai"
}

// 出图只列 OpenAI、Gemini 和 OpenAI 格式的自定义服务；Ollama 不进出图。
export function serviceAllowedInSlot(service: AiServiceState, slot: SlotId): boolean {
  if (slot !== "image") return true
  const family = serviceFamily(service)
  return family === "openai" || family === "gemini"
}

export function defaultModelFor(state: AiState, service: AiServiceState, role: ModelRole): string {
  const family = serviceFamily(service)
  const model = state.catalog.models.find(
    (entry) => entry.service === family && entry.defaults.includes(role),
  )
  return model ? model.id : ""
}

// 学习暂时只支持 Claude（含 Claude 格式的自定义服务）；同 learning-runner.mjs:105。
export function learningSupported(service: AiServiceState): boolean {
  if (isOllamaService(service)) return false
  return serviceFamily(service) === "claude"
}

function orderedServices(state: AiState): AiServiceState[] {
  const byId = new Map<string, AiServiceState>()
  for (const service of state.services) byId.set(service.id, service)
  const ordered: AiServiceState[] = []
  const seen = new Set<string>()
  for (const presetId of PRESET_ORDER) {
    const preset = byId.get(presetId)
    if (preset) {
      ordered.push(preset)
      seen.add(preset.id)
    }
  }
  for (const service of state.services) {
    if (!seen.has(service.id)) {
      ordered.push(service)
      seen.add(service.id)
    }
  }
  return ordered
}

export function visibleServiceIds(
  state: AiState,
  options?: { opened?: Iterable<string> },
): string[] {
  const openedSet = new Set(options?.opened ?? [])
  const selectedIds = new Set(
    [state.slots.analysis?.serviceId, state.slots.brain?.serviceId, state.slots.image?.serviceId]
      .filter((id): id is string => Boolean(id)),
  )
  const result: string[] = []
  for (const service of orderedServices(state)) {
    const visible =
      service.hasKey ||
      isCustomService(service) ||
      (isOllamaService(service) && Boolean(service.lastTest)) ||
      selectedIds.has(service.id) ||
      openedSet.has(service.id)
    if (visible) result.push(service.id)
  }
  return result
}

export function addableServices(
  state: AiState,
  visibleIds: Iterable<string>,
): AddableServiceOption[] {
  const visibleSet = new Set(visibleIds)
  const byId = new Map<string, AiServiceState>()
  for (const service of state.catalog.services) byId.set(service.id, service)
  for (const service of state.services) byId.set(service.id, service)

  const options: AddableServiceOption[] = []
  for (const presetId of PRESET_ORDER) {
    if (visibleSet.has(presetId)) continue
    const service = byId.get(presetId)
    if (service) options.push({ value: service.id, label: service.label })
  }
  options.push({ value: ADD_CUSTOM_SERVICE_VALUE, label: "其它服务…" })
  return options
}

export function connectedServiceIds(state: AiState): string[] {
  const result: string[] = []
  for (const service of orderedServices(state)) {
    if (isOllamaService(service)) {
      if (service.lastTest?.ok === true) result.push(service.id)
    } else if (service.hasKey) {
      result.push(service.id)
    }
  }
  return result
}

export function analysisCostMultiple(
  state: AiState,
  serviceId: string,
  modelId: string,
): CostMultiple | null {
  if (!serviceId || !modelId) return null
  const service = state.services.find((entry) => entry.id === serviceId)
  if (!service) return null
  const family = serviceFamily(service)
  const reference = state.catalog.models.find(
    (entry) => entry.service === family && entry.defaults.includes("analysis"),
  )
  if (!reference || reference.id === modelId) return null
  const target = state.catalog.models.find((entry) => entry.id === modelId)
  if (!target) return null
  if (reference.pricing?.kind !== "tokens" || target.pricing?.kind !== "tokens") return null
  if (
    !(reference.pricing.input > 0) ||
    !(reference.pricing.output > 0) ||
    !(target.pricing.input > 0) ||
    !(target.pricing.output > 0)
  ) {
    return null
  }
  const inputRatio = target.pricing.input / reference.pricing.input
  const outputRatio = target.pricing.output / reference.pricing.output
  const multiple = Math.round(Math.min(inputRatio, outputRatio))
  if (multiple < 3) return null
  return {
    multiple,
    referenceId: reference.id,
    referenceLabel: reference.label,
  }
}

export function modelGroups(
  state: AiState,
  role: ModelRole,
  tr: (text: string) => string = (text) => text,
): ModelGroup[] {
  const allCatalogIds = new Set(state.catalog.models.map((entry) => entry.id))
  const ordered = orderedServices(state)

  let services: AiServiceState[]
  if (role === "summary") {
    const analysisServiceId = state.slots.analysis?.serviceId || ""
    const chosen = analysisServiceId ? ordered.find((entry) => entry.id === analysisServiceId) : undefined
    services = chosen ? [chosen] : []
  } else {
    const slot: SlotId = role
    const connectedSet = new Set(connectedServiceIds(state))
    const selectedServiceId = state.slots[slot]?.serviceId || ""
    services = ordered.filter((service) => {
      if (service.id === selectedServiceId) return true
      return connectedSet.has(service.id) && serviceAllowedInSlot(service, slot)
    })
  }

  return services.map((service) => {
    const baseName = isOllamaService(service) ? tr(service.label) : service.label
    const heading =
      (role === "analysis" || role === "summary") && !learningSupported(service)
        ? `${baseName} · ${tr("暂不支持学习")}`
        : baseName

    const options: ModelOption[] = []
    if (isOllamaService(service)) {
      const seen = new Set<string>()
      for (const id of service.lastTest?.models ?? []) {
        if (!id || seen.has(id)) continue
        seen.add(id)
        options.push({ value: id, label: id })
      }
    } else {
      const family = serviceFamily(service)
      const catalogEntries = state.catalog.models.filter(
        (entry) => entry.service === family && entry.slots.includes(role),
      )
      const seen = new Set<string>()
      for (const entry of catalogEntries) {
        seen.add(entry.id)
        let hint: string | undefined
        if (entry.defaults.includes(role)) {
          hint = tr("默认")
        } else if (role === "analysis") {
          const cost = analysisCostMultiple(state, service.id, entry.id)
          if (cost) {
            hint = tr("单价 {n} 倍").replace("{n}", String(cost.multiple))
          }
        }
        options.push(hint ? { value: entry.id, label: entry.label, hint } : { value: entry.id, label: entry.label })
      }

      // 预设服务只列单价表里的模型；自定义服务追加测试清单里不在表里的 id。
      if (isCustomService(service)) {
        for (const id of service.lastTest?.models ?? []) {
          if (!id || seen.has(id)) continue
          seen.add(id)
          const hint = allCatalogIds.has(id) ? undefined : tr("单价未知")
          options.push(hint ? { value: id, label: id, hint } : { value: id, label: id })
        }
      }
    }

    return { serviceId: service.id, heading, options }
  })
}

export function priceWithoutMonth(line: AiPriceLine): AiPriceLine {
  const stripped = PRICE_TEMPLATE_WITHOUT_MONTH[line.template]
  if (!stripped) return line
  return { template: stripped, params: { ...line.params } }
}

export function formatMonthUsd(value: number): string {
  const cents = Math.round(Number(value) * 100) / 100
  return `$${(cents === 0 ? 0 : cents).toFixed(2)}`
}

export function testPurposeFor(state: AiState, serviceId: string): "text" | "image" {
  const usedForImage = state.slots.image?.serviceId === serviceId
  const usedForText =
    state.slots.analysis?.serviceId === serviceId ||
    state.slots.brain?.serviceId === serviceId
  return usedForImage && !usedForText ? "image" : "text"
}

export function useRowNote(state: AiState, role: ModelRole): UseRowNote | null {
  const slot: SlotId = role === "summary" ? "analysis" : role
  const slotState = state.slots[slot]
  const serviceId = slotState?.serviceId || ""
  const modelId = role === "summary" ? (slotState?.summaryModel || "") : (slotState?.model || "")
  const service = serviceId ? (state.services.find((entry) => entry.id === serviceId) ?? null) : null

  if (service && !isOllamaService(service) && !service.hasKey) {
    return {
      kind: "no-key",
      tone: "danger",
      params: { serviceId: service.id, service: service.label },
    }
  }

  if (service && service.lastTest?.ok === false) {
    return {
      kind: "test-failed",
      tone: "danger",
      params: { serviceId: service.id, service: service.label },
    }
  }

  if (role === "analysis" && service && !learningSupported(service)) {
    return {
      kind: "learning-unsupported",
      tone: "danger",
      params: { service: service.label },
    }
  }

  if (role === "analysis" && service && modelId) {
    const cost = analysisCostMultiple(state, service.id, modelId)
    if (cost) {
      return {
        kind: "analysis-expensive",
        tone: "danger",
        params: {
          n: String(cost.multiple),
          reference: cost.referenceLabel,
          referenceId: cost.referenceId,
        },
      }
    }
  }

  const inCatalog = Boolean(modelId) && state.catalog.models.some((entry) => entry.id === modelId)

  if ((role === "analysis" || role === "summary") && service && !isOllamaService(service) && modelId && !inCatalog) {
    return {
      kind: "learning-unknown-price",
      tone: "danger",
      params: { model: modelId },
    }
  }

  if ((role === "brain" || role === "image") && service && !isOllamaService(service) && modelId && !inCatalog) {
    return {
      kind: "unknown-price",
      tone: "info",
      params: { model: modelId },
    }
  }

  if (role === "image" && !service) {
    const connected = connectedServiceIds(state)
    const hasImageService = connected.some((id) => {
      const entry = state.services.find((item) => item.id === id)
      return entry ? serviceAllowedInSlot(entry, "image") : false
    })
    if (!hasImageService) {
      return {
        kind: "image-needs-service",
        tone: "info",
        params: {},
      }
    }
  }

  return null
}
