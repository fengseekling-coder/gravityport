/**
 * Settings → AI panel (task 458). Self-contained like FeedbackPanel: it loads
 * its own state over the ai-* IPC channels (desktopAPI() itself, no props from
 * App.tsx) and degrades to a single card in a plain browser. Keys never come
 * back to the renderer — only the last 4 digits; the password input is cleared
 * the moment a save succeeds, and the draft never touches localStorage, URLs,
 * toasts, or the console.
 */

import { useCallback, useEffect, useState } from "react"
import ToolbarSelect from "./ToolbarSelect"
import { desktopAPI, type AiServiceState, type AiSlotState, type AiState } from "./desktop"
import { handleExternalLinkClick } from "./external-link.js"
import { translate, type Language } from "./i18n.js"
import "./ai-settings.css"
type SlotId = "analysis" | "brain" | "image"
// A slot's model field role: the analysis card holds two fields with separate
// model lists (逐张分析 uses "analysis", 汇总手册 uses "summary").
type ModelRole = "analysis" | "summary" | "brain" | "image"

const ADD_SERVICE_VALUE = "__add__"

const SLOT_CARDS: { slot: SlotId; title: string; desc: string }[] = [
  { slot: "analysis", title: "分析和汇总", desc: "学习时逐张看图，再把要点汇总成设计手册。" },
  { slot: "brain", title: "对话大脑", desc: "在对话中理解需求、写提示词。" },
  { slot: "image", title: "出图", desc: "按提示词和参考图出图。" },
]

function isCustomService(service: AiServiceState): boolean {
  return service.id.startsWith("custom-")
}

function isOllamaService(service: AiServiceState): boolean {
  return service.id === "ollama" || service.format === "ollama"
}

// Presets draw from their own family; Claude-format custom services draw from
// the Claude table, everything else custom from OpenAI's (同一份规则在
// lib/ai/model-catalog.mjs，主进程校验用那份，这里只为选默认模型)。
function serviceFamily(service: AiServiceState): string {
  if (!isCustomService(service)) return service.id
  return service.format === "claude" ? "claude" : "openai"
}

// 出图块只列 OpenAI、Gemini 和 OpenAI 格式的自定义服务；Ollama 只在分析和大脑。
function serviceAllowedInSlot(service: AiServiceState, slot: SlotId): boolean {
  if (slot !== "image") return true
  const family = serviceFamily(service)
  return family === "openai" || family === "gemini"
}

function fillTemplate(template: string, params: Record<string, string> | undefined): string {
  return template.replace(/\{(\w+)\}/g, (_match, name) => params?.[name] ?? "")
}

function defaultModelFor(state: AiState, service: AiServiceState, role: ModelRole): string {
  const family = serviceFamily(service)
  const model = state.catalog.models.find(
    (entry) => entry.service === family && entry.defaults.includes(role),
  )
  return model ? model.id : ""
}

type AddFormState = { label: string; format: "openai" | "claude"; baseUrl: string }

const EMPTY_ADD_FORM: AddFormState = { label: "", format: "openai", baseUrl: "" }

export function AiSettingsPanel({ language }: { language: Language }) {
  const tr = useCallback((text: string) => translate(text, language), [language])
  const api = desktopAPI()
  const [state, setState] = useState<AiState | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({})
  const [keyEditing, setKeyEditing] = useState<Record<string, boolean>>({})
  const [keyError, setKeyError] = useState<Record<string, string>>({})
  const [savingFor, setSavingFor] = useState<string | null>(null)
  const [testingFor, setTestingFor] = useState<string | null>(null)
  const [addFormFor, setAddFormFor] = useState<SlotId | null>(null)
  const [addForm, setAddForm] = useState<AddFormState>(EMPTY_ADD_FORM)
  const [addFormError, setAddFormError] = useState("")
  const [slotError, setSlotError] = useState("")

  const refresh = useCallback(async () => {
    const aiGetState = api?.aiGetState
    if (typeof aiGetState !== "function") {
      setLoadFailed(true)
      return
    }
    try {
      const next = await aiGetState.call(api)
      setState(next)
      setLoadFailed(false)
    } catch {
      setLoadFailed(true)
    }
  }, [api])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!api) {
    return (
      <section className="settings-section settings-card">
        <p className="settings-card-desc">{tr("AI 设置只能在 GravityPort 桌面版中使用。")}</p>
      </section>
    )
  }

  const available = state?.available !== false

  const saveKey = async (service: AiServiceState) => {
    const aiSaveKey = api?.aiSaveKey
    if (typeof aiSaveKey !== "function") return
    const draft = keyDraft[service.id] ?? ""
    setSavingFor(service.id)
    try {
      const result = await aiSaveKey.call(api, service.id, draft)
      if (result.ok) {
        // 保存成功立刻清空输入框；密钥不进 localStorage、网址、提示条、console。
        setKeyDraft((previous) => ({ ...previous, [service.id]: "" }))
        setKeyEditing((previous) => ({ ...previous, [service.id]: false }))
        setKeyError((previous) => ({ ...previous, [service.id]: "" }))
        await refresh()
      } else {
        setKeyError((previous) => ({
          ...previous,
          [service.id]: result.reason === "invalid-key" ? tr("密钥格式不对，请检查后重试。") : tr("密钥没有保存成功，请重试。"),
        }))
      }
    } catch {
      setKeyError((previous) => ({ ...previous, [service.id]: tr("密钥没有保存成功，请重试。") }))
    } finally {
      setSavingFor(null)
    }
  }

  const deleteKey = async (service: AiServiceState) => {
    const aiDeleteKey = api?.aiDeleteKey
    if (typeof aiDeleteKey !== "function") return
    await aiDeleteKey.call(api, service.id)
    setKeyDraft((previous) => ({ ...previous, [service.id]: "" }))
    setKeyEditing((previous) => ({ ...previous, [service.id]: false }))
    setKeyError((previous) => ({ ...previous, [service.id]: "" }))
    await refresh()
  }

  const runTest = async (service: AiServiceState, purpose: "text" | "image") => {
    const aiTestConnection = api?.aiTestConnection
    if (typeof aiTestConnection !== "function") return
    setTestingFor(service.id)
    try {
      await aiTestConnection.call(api, service.id, purpose)
      await refresh()
    } finally {
      setTestingFor(null)
    }
  }

  const updateSlot = async (slot: SlotId, patch: Partial<AiSlotState>) => {
    const aiUpdateSettings = api?.aiUpdateSettings
    if (typeof aiUpdateSettings !== "function" || !state) return
    const current = state.slots[slot]
    const payload: Partial<AiSlotState> = { ...current, ...patch }
    if (slot !== "analysis") delete payload.summaryModel
    setSlotError("")
    try {
      const result = await aiUpdateSettings.call(api, { slots: { [slot]: payload } })
      if (result.ok && result.state) setState(result.state)
      else setSlotError(tr("设置没有保存成功，请重试。"))
    } catch {
      setSlotError(tr("设置没有保存成功，请重试。"))
    }
  }

  const chooseService = async (slot: SlotId, value: string) => {
    if (value === ADD_SERVICE_VALUE) {
      setAddForm(EMPTY_ADD_FORM)
      setAddFormError("")
      setAddFormFor(slot)
      return
    }
    if (!state) return
    const service = state.services.find((entry) => entry.id === value)
    if (!service) return
    // 选了服务就带上它的默认模型（Ollama 没有目录模型，等测试连接后再选）。
    if (slot === "analysis") {
      await updateSlot(slot, {
        serviceId: value,
        model: defaultModelFor(state, service, "analysis"),
        summaryModel: defaultModelFor(state, service, "summary"),
      })
    } else {
      await updateSlot(slot, { serviceId: value, model: defaultModelFor(state, service, slot) })
    }
  }

  const submitAddService = async (slot: SlotId) => {
    const aiUpdateSettings = api?.aiUpdateSettings
    if (typeof aiUpdateSettings !== "function" || !state) return
    setAddFormError("")
    try {
      const result = await aiUpdateSettings.call(api, {
        customServices: [
          ...state.services.filter(isCustomService).map((service) => ({
            id: service.id,
            label: service.label,
            format: service.format === "claude" ? "claude" as const : "openai" as const,
            baseUrl: service.baseUrl || "",
          })),
          { label: addForm.label.trim(), format: addForm.format, baseUrl: addForm.baseUrl.trim() },
        ],
      })
      if (!result.ok || !result.state) {
        setAddFormError(tr("设置没有保存成功，请重试。"))
        return
      }
      setState(result.state)
      // 就地添加后在本卡选中新服务 + 默认模型（新服务只在 result.state 里，
      // 不能走 chooseService 的旧 state 查找）。
      const previousIds = new Set(state.services.filter(isCustomService).map((service) => service.id))
      const added = result.state.services.find((service) => isCustomService(service) && !previousIds.has(service.id))
      setAddFormFor(null)
      setAddForm(EMPTY_ADD_FORM)
      if (added) {
        if (slot === "analysis") {
          await updateSlot(slot, {
            serviceId: added.id,
            model: defaultModelFor(result.state, added, "analysis"),
            summaryModel: defaultModelFor(result.state, added, "summary"),
          })
        } else {
          await updateSlot(slot, { serviceId: added.id, model: defaultModelFor(result.state, added, slot) })
        }
      }
    } catch {
      setAddFormError(tr("设置没有保存成功，请重试。"))
    }
  }

  const removeService = async (service: AiServiceState) => {
    const aiUpdateSettings = api?.aiUpdateSettings
    if (typeof aiUpdateSettings !== "function" || !state) return
    setSlotError("")
    try {
      // C.1：删掉自定义服务时连它的密钥一起删（主进程级联），用到它的块退回「未选择」。
      const result = await aiUpdateSettings.call(api, {
        customServices: state.services
          .filter((entry) => isCustomService(entry) && entry.id !== service.id)
          .map((entry) => ({
            id: entry.id,
            label: entry.label,
            format: entry.format === "claude" ? "claude" as const : "openai" as const,
            baseUrl: entry.baseUrl || "",
          })),
      })
      if (result.ok && result.state) setState(result.state)
      else setSlotError(tr("设置没有保存成功，请重试。"))
    } catch {
      setSlotError(tr("设置没有保存成功，请重试。"))
    }
  }

  const modelOptions = (serviceId: string, role: ModelRole): { value: string; label: string }[] => {
    if (!state) return []
    const service = state.services.find((entry) => entry.id === serviceId)
    if (!service) return []
    const family = serviceFamily(service)
    const catalog = state.catalog.models
      .filter((entry) => entry.service === family && entry.slots.includes(role))
      .map((entry) => ({ value: entry.id, label: entry.label }))
    const tested = service.lastTest?.models ?? []
    const extra = tested
      .filter((id) => !catalog.some((entry) => entry.value === id))
      .map((id) => ({ value: id, label: id }))
    return [...catalog, ...extra]
  }

  const renderTestStatus = (service: AiServiceState) => {
    if (testingFor === service.id) {
      return (
        <span className="ai-status-line">
          <span className="ai-status-dot busy" aria-hidden="true" />
          {tr("正在测试…")}
        </span>
      )
    }
    const lastTest = service.lastTest
    if (!lastTest) return null
    const display = lastTest.display
    const text = display
      ? fillTemplate(translate(display.template || display.message || "", language), display.params)
      : ""
    if (lastTest.ok) {
      return (
        <span className="ai-status-line">
          <span className="ai-status-dot ok" aria-hidden="true" />
          {text}
          {display?.missingModel ? (
            <span className="ai-status-sub">
              {fillTemplate(tr("这个账号的模型清单里没有 {model}"), { model: display.missingModel })}
            </span>
          ) : null}
        </span>
      )
    }
    return (
      <span className="ai-status-line">
        <span className="ai-status-dot error" aria-hidden="true" />
        {text}
      </span>
    )
  }

  const renderKeyRow = (service: AiServiceState) => {
    if (isOllamaService(service)) return null
    const draft = keyDraft[service.id] ?? ""
    const editing = keyEditing[service.id] === true || !service.hasKey
    const busy = savingFor === service.id || !available
    return (
      <div className="ai-row ai-key-row">
        <span className="ai-row-label">{tr("密钥")}</span>
        {editing ? (
          <>
            <input
              className="ai-text-input ai-key-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label={tr("密钥")}
              value={draft}
              disabled={!available}
              onChange={(event) => setKeyDraft((previous) => ({ ...previous, [service.id]: event.target.value }))}
            />
            <button
              type="button"
              className="settings-action-btn"
              disabled={!available || savingFor === service.id}
              onClick={() => void saveKey(service)}
            >
              {tr("保存")}
            </button>
            {service.keyUrl ? (
              <a
                className="ai-key-link"
                href={service.keyUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => handleExternalLinkClick(event, service.keyUrl as string)}
              >
                {tr("获取密钥")}
              </a>
            ) : null}
          </>
        ) : (
          <>
            <span className="ai-key-saved">{fillTemplate(tr("已保存 · 尾号 {last4}"), { last4: service.last4 })}</span>
            <button
              type="button"
              className="settings-action-btn"
              disabled={!available}
              onClick={() => setKeyEditing((previous) => ({ ...previous, [service.id]: true }))}
            >
              {tr("更换")}
            </button>
            <button
              type="button"
              className="settings-action-btn"
              disabled={!available}
              onClick={() => void deleteKey(service)}
            >
              {tr("删除")}
            </button>
          </>
        )}
        {keyError[service.id] ? <span className="ai-error-line">{keyError[service.id]}</span> : null}
      </div>
    )
  }

  const renderModelRow = (slot: SlotId, service: AiServiceState) => {
    const slotState = state?.slots[slot]
    if (slot === "analysis") {
      const analysisOptions = modelOptions(service.id, "analysis")
      const summaryOptions = modelOptions(service.id, "summary")
      const analysisModel = slotState?.model || ""
      const summaryModel = slotState?.summaryModel || ""
      return (
        <div className="ai-row ai-model-row">
          <span className="ai-row-label">{tr("模型")}</span>
          <div className="ai-model-pair">
            <ToolbarSelect
              label={tr("逐张分析")}
              value={analysisModel}
              display={analysisModel
                ? analysisOptions.find((option) => option.value === analysisModel)?.label || analysisModel
                : tr("未选择")}
              options={analysisOptions}
              onChange={(value) => void updateSlot("analysis", { model: value })}
            />
            <ToolbarSelect
              label={tr("汇总手册")}
              value={summaryModel}
              display={summaryModel
                ? summaryOptions.find((option) => option.value === summaryModel)?.label || summaryModel
                : tr("未选择")}
              options={summaryOptions}
              onChange={(value) => void updateSlot("analysis", { summaryModel: value })}
            />
          </div>
        </div>
      )
    }
    const options = modelOptions(service.id, slot)
    const model = slotState?.model || ""
    return (
      <div className="ai-row ai-model-row">
        <span className="ai-row-label">{tr("模型")}</span>
        <ToolbarSelect
          label={tr("模型")}
          value={model}
          display={model ? options.find((option) => option.value === model)?.label || model : tr("未选择")}
          options={options}
          onChange={(value) => void updateSlot(slot, { model: value })}
        />
      </div>
    )
  }

  return (
    <>
      <p className="settings-card-desc ai-panel-desc">
        {available
          ? tr("密钥只保存在本机，由系统加密，不会上传到 GravityPort。")
          : tr("这台电脑无法加密保存密钥，暂时不能使用 AI 功能。")}
      </p>
      {loadFailed ? (
        <section className="settings-section settings-card">
          <p className="settings-card-desc">{tr("无法读取 AI 设置。")}</p>
        </section>
      ) : (
        SLOT_CARDS.map(({ slot, title, desc }) => {
          const slotState = state?.slots[slot]
          const service = state?.services.find((entry) => entry.id === slotState?.serviceId) || null
          const serviceOptions = (state?.services ?? [])
            .filter((entry) => serviceAllowedInSlot(entry, slot))
            .map((entry) => ({ value: entry.id, label: entry.label }))
          const purpose: "text" | "image" = slot === "image" ? "image" : "text"
          return (
            <section key={slot} className="settings-section settings-card ai-card" aria-label={tr(title)}>
              <div className="settings-card-header">
                <div className="settings-card-head">
                  <strong>{tr(title)}</strong>
                </div>
                <p className="settings-card-desc">{tr(desc)}</p>
              </div>
              <div className="ai-card-body">
                <div className="ai-row">
                  <span className="ai-row-label">{tr("服务")}</span>
                  <ToolbarSelect
                    label={tr(title)}
                    value={service?.id || ""}
                    display={service ? service.label : tr("未选择")}
                    options={[...serviceOptions, { value: ADD_SERVICE_VALUE, label: tr("添加其它服务…") }]}
                    onChange={(value) => void chooseService(slot, value)}
                  />
                  {service && isCustomService(service) && (
                    <button
                      type="button"
                      className="settings-action-btn"
                      disabled={!available}
                      onClick={() => void removeService(service)}
                    >
                      {tr("删除此服务")}
                    </button>
                  )}
                </div>
                {addFormFor === slot && (
                  <div className="ai-add-form" role="group" aria-label={tr("添加服务")}>
                    <div className="ai-row">
                      <span className="ai-row-label">{tr("名称")}</span>
                      <input
                        className="ai-text-input"
                        value={addForm.label}
                        disabled={!available}
                        maxLength={80}
                        onChange={(event) => setAddForm((previous) => ({ ...previous, label: event.target.value }))}
                      />
                    </div>
                    <div className="ai-row">
                      <span className="ai-row-label">{tr("接口格式")}</span>
                      <div className="segmented" role="group" aria-label={tr("接口格式")}>
                        <button
                          type="button"
                          className={addForm.format === "openai" ? "on" : ""}
                          aria-pressed={addForm.format === "openai"}
                          disabled={!available}
                          onClick={() => setAddForm((previous) => ({ ...previous, format: "openai" }))}
                        >
                          {tr("OpenAI 格式")}
                        </button>
                        <button
                          type="button"
                          className={addForm.format === "claude" ? "on" : ""}
                          aria-pressed={addForm.format === "claude"}
                          disabled={!available}
                          onClick={() => setAddForm((previous) => ({ ...previous, format: "claude" }))}
                        >
                          {tr("Claude 格式")}
                        </button>
                      </div>
                    </div>
                    <div className="ai-row">
                      <span className="ai-row-label">{tr("地址")}</span>
                      <input
                        className="ai-text-input"
                        type="url"
                        value={addForm.baseUrl}
                        placeholder="https://…"
                        disabled={!available}
                        onChange={(event) => setAddForm((previous) => ({ ...previous, baseUrl: event.target.value }))}
                      />
                    </div>
                    <div className="ai-add-actions">
                      <button
                        type="button"
                        className="settings-action-btn"
                        disabled={!available || !addForm.label.trim() || !addForm.baseUrl.trim()}
                        onClick={() => void submitAddService(slot)}
                      >
                        {tr("添加")}
                      </button>
                      <button
                        type="button"
                        className="settings-action-btn"
                        onClick={() => {
                          setAddFormFor(null)
                          setAddForm(EMPTY_ADD_FORM)
                        }}
                      >
                        {tr("取消")}
                      </button>
                      {addFormError ? <span className="ai-error-line">{addFormError}</span> : null}
                    </div>
                  </div>
                )}
                {service ? renderKeyRow(service) : null}
                {service ? (
                  <div className="ai-row ai-test-row">
                    <button
                      type="button"
                      className="settings-action-btn"
                      disabled={!available || testingFor === service.id}
                      onClick={() => void runTest(service, purpose)}
                    >
                      {tr("测试连接")}
                    </button>
                    {renderTestStatus(service)}
                  </div>
                ) : null}
                {service ? renderModelRow(slot, service) : null}
                <div className="ai-price-row">
                  {(state?.priceLines[slot] ?? []).map((line, index) => (
                    <span key={index} className="ai-price-line">
                      {fillTemplate(translate(line.template, language), line.params)}
                    </span>
                  ))}
                </div>
                {slotError ? <span className="ai-error-line">{slotError}</span> : null}
              </div>
            </section>
          )
        })
      )}
    </>
  )
}
