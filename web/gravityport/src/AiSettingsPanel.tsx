/**
 * Settings → AI panel (task 458 / 468). Self-contained like FeedbackPanel: it
 * loads its own state over the ai-* IPC channels (desktopAPI() itself, no props
 * from App.tsx) and degrades to a single card in a plain browser. Keys never
 * come back to the renderer — only the last 4 digits; the password input is
 * cleared the moment a save succeeds, and drafts never touch localStorage,
 * URLs, toasts, or the console.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import ToolbarSelect, { type ToolbarSelectGroup } from "./ToolbarSelect"
import { desktopAPI, type AiPriceLine, type AiServiceState, type AiState } from "./desktop"
import {
  ADD_CUSTOM_SERVICE_VALUE,
  addableServices,
  connectedServiceIds,
  effortChoiceFor,
  effortLabelKey,
  formatMonthUsd,
  isCustomService,
  isOllamaService,
  modelGroups,
  priceWithoutMonth,
  testPurposeFor,
  rowNoteFor,
  slotChoiceFor,
  visibleServiceIds,
  type ModelRole,
  type SlotId,
  type UseRowNote,
} from "./ai-settings-model"
import { handleExternalLinkClick } from "./external-link.js"
import { translate, type Language } from "./i18n.js"
import "./ai-settings.css"

type AddFormState = { label: string; format: "openai" | "claude"; baseUrl: string }

const EMPTY_ADD_FORM: AddFormState = { label: "", format: "openai", baseUrl: "" }

function fillTemplate(template: string, params: Record<string, string> | undefined): string {
  return template.replace(/\{(\w+)\}/g, (_match, name) => params?.[name] ?? "")
}

export function AiSettingsPanel({ language }: { language: Language }) {
  const tr = useCallback((text: string) => translate(text, language), [language])
  const api = desktopAPI()
  const [state, setState] = useState<AiState | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [opened, setOpened] = useState<string[]>([])
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({})
  const [keyEditing, setKeyEditing] = useState<Record<string, boolean>>({})
  const [keyError, setKeyError] = useState<Record<string, string>>({})
  const [savingFor, setSavingFor] = useState<string | null>(null)
  const [testingFor, setTestingFor] = useState<Record<string, boolean>>({})
  const [addFormOpen, setAddFormOpen] = useState(false)
  const [addForm, setAddForm] = useState<AddFormState>(EMPTY_ADD_FORM)
  const [addFormError, setAddFormError] = useState("")
  const [slotError, setSlotError] = useState("")
  const [focusRequest, setFocusRequest] = useState<{ serviceId: string; seq: number } | null>(null)

  const keyInputRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const serviceRowRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const focusSeqRef = useRef(0)

  const requestKeyFocus = useCallback((serviceId: string) => {
    focusSeqRef.current += 1
    setFocusRequest({ serviceId, seq: focusSeqRef.current })
  }, [])

  const refresh = useCallback(async (): Promise<AiState | null> => {
    const aiGetState = api?.aiGetState
    if (typeof aiGetState !== "function") {
      setLoadFailed(true)
      return null
    }
    try {
      const next = await aiGetState.call(api)
      setState(next)
      setLoadFailed(false)
      return next
    } catch {
      setLoadFailed(true)
      return null
    }
  }, [api])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!focusRequest) return
    const input = keyInputRefs.current[focusRequest.serviceId]
    const row = serviceRowRefs.current[focusRequest.serviceId]
    if (!input && !row) return
    row?.scrollIntoView({ block: "nearest" })
    input?.focus()
    setFocusRequest(null)
  }, [focusRequest, state, opened, keyEditing])

  if (!api) {
    return (
      <section className="settings-section settings-card">
        <p className="settings-card-desc">{tr("AI 设置只能在 GravityPort 桌面版中使用。")}</p>
      </section>
    )
  }

  const available = state?.available !== false

  const displayServiceName = (service: Pick<AiServiceState, "id" | "label" | "format">): string =>
    isOllamaService(service as AiServiceState) ? tr(service.label) : service.label

  const displayAddableLabel = (value: string, label: string): string =>
    value === ADD_CUSTOM_SERVICE_VALUE || value === "ollama" ? tr(label) : label

  const runTest = async (serviceId: string, purpose: "text" | "image") => {
    const aiTestConnection = api?.aiTestConnection
    if (typeof aiTestConnection !== "function") return
    setTestingFor((previous) => ({ ...previous, [serviceId]: true }))
    try {
      await aiTestConnection.call(api, serviceId, purpose)
      await refresh()
    } finally {
      setTestingFor((previous) => ({ ...previous, [serviceId]: false }))
    }
  }

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
        setOpened((previous) => previous.filter((id) => id !== service.id))
        setSavingFor(null)
        try {
          const nextState = await refresh()
          if (nextState) {
            await runTest(service.id, testPurposeFor(nextState, service.id))
          }
        } catch {
          // 密钥已经存好；自动测试出错只影响这一行的状态，不能报成「没有保存成功」。
        }
        return
      }
      setKeyError((previous) => ({
        ...previous,
        [service.id]:
          result.reason === "invalid-key"
            ? tr("密钥格式不对，请检查后重试。")
            : tr("密钥没有保存成功，请重试。"),
      }))
    } catch {
      setKeyError((previous) => ({ ...previous, [service.id]: tr("密钥没有保存成功，请重试。") }))
    } finally {
      setSavingFor(null)
    }
  }

  const cancelEdit = (service: AiServiceState) => {
    setKeyDraft((previous) => ({ ...previous, [service.id]: "" }))
    setKeyError((previous) => ({ ...previous, [service.id]: "" }))
    setKeyEditing((previous) => ({ ...previous, [service.id]: false }))
    if (!service.hasKey && !isCustomService(service)) {
      setOpened((previous) => previous.filter((id) => id !== service.id))
    }
  }

  const deleteKey = async (service: AiServiceState) => {
    const aiDeleteKey = api?.aiDeleteKey
    if (typeof aiDeleteKey !== "function") return
    await aiDeleteKey.call(api, service.id)
    setKeyDraft((previous) => ({ ...previous, [service.id]: "" }))
    setKeyEditing((previous) => ({ ...previous, [service.id]: false }))
    setKeyError((previous) => ({ ...previous, [service.id]: "" }))
    setOpened((previous) => previous.filter((id) => id !== service.id))
    await refresh()
  }

  const removeService = async (service: AiServiceState) => {
    const aiUpdateSettings = api?.aiUpdateSettings
    if (typeof aiUpdateSettings !== "function" || !state) return
    setSlotError("")
    try {
      const result = await aiUpdateSettings.call(api, {
        customServices: state.services
          .filter((entry) => isCustomService(entry) && entry.id !== service.id)
          .map((entry) => ({
            id: entry.id,
            label: entry.label,
            format: entry.format === "claude" ? ("claude" as const) : ("openai" as const),
            baseUrl: entry.baseUrl || "",
          })),
      })
      if (result.ok && result.state) {
        setState(result.state)
        setKeyDraft((previous) => ({ ...previous, [service.id]: "" }))
        setKeyEditing((previous) => ({ ...previous, [service.id]: false }))
        setKeyError((previous) => ({ ...previous, [service.id]: "" }))
        setOpened((previous) => previous.filter((id) => id !== service.id))
      } else {
        setSlotError(tr("设置没有保存成功，请重试。"))
      }
    } catch {
      setSlotError(tr("设置没有保存成功，请重试。"))
    }
  }

  const submitAddService = async () => {
    const aiUpdateSettings = api?.aiUpdateSettings
    if (typeof aiUpdateSettings !== "function" || !state) return
    setAddFormError("")
    try {
      const result = await aiUpdateSettings.call(api, {
        customServices: [
          ...state.services.filter(isCustomService).map((service) => ({
            id: service.id,
            label: service.label,
            format: service.format === "claude" ? ("claude" as const) : ("openai" as const),
            baseUrl: service.baseUrl || "",
          })),
          { label: addForm.label.trim(), format: addForm.format, baseUrl: addForm.baseUrl.trim() },
        ],
      })
      if (!result.ok || !result.state) {
        setAddFormError(tr("设置没有保存成功，请重试。"))
        return
      }
      const previousIds = new Set(state.services.filter(isCustomService).map((service) => service.id))
      const added = result.state.services.find(
        (service) => isCustomService(service) && !previousIds.has(service.id),
      )
      setState(result.state)
      setAddFormOpen(false)
      setAddForm(EMPTY_ADD_FORM)
      if (added) {
        requestKeyFocus(added.id)
      }
    } catch {
      setAddFormError(tr("设置没有保存成功，请重试。"))
    }
  }

  const handleAddChoice = (value: string) => {
    if (!available || !state) return
    if (value === ADD_CUSTOM_SERVICE_VALUE) {
      setAddForm(EMPTY_ADD_FORM)
      setAddFormError("")
      setAddFormOpen(true)
      return
    }
    setOpened((previous) => (previous.includes(value) ? previous : [...previous, value]))
    if (value === "ollama") {
      void runTest("ollama", testPurposeFor(state, "ollama"))
      return
    }
    setKeyDraft((previous) => ({ ...previous, [value]: "" }))
    setKeyError((previous) => ({ ...previous, [value]: "" }))
    setKeyEditing((previous) => ({ ...previous, [value]: true }))
    requestKeyFocus(value)
  }

  const openKeyEditorFor = (serviceId: string) => {
    if (!available) return
    setOpened((previous) => (previous.includes(serviceId) ? previous : [...previous, serviceId]))
    setKeyDraft((previous) => ({ ...previous, [serviceId]: "" }))
    setKeyError((previous) => ({ ...previous, [serviceId]: "" }))
    setKeyEditing((previous) => ({ ...previous, [serviceId]: true }))
    requestKeyFocus(serviceId)
  }

  const updateSlot = async (
    slot: SlotId,
    patch: Partial<{ serviceId: string; model: string; summaryModel?: string; effort?: string; summaryEffort?: string }>,
  ) => {
    const aiUpdateSettings = api?.aiUpdateSettings
    if (typeof aiUpdateSettings !== "function" || !state) return
    const current = state.slots[slot]
    const payload: Partial<{ serviceId: string; model: string; summaryModel?: string; effort?: string; summaryEffort?: string }> = {
      ...current,
      ...patch,
    }
    if (slot !== "analysis") {
      delete payload.summaryModel
      delete payload.effort
      delete payload.summaryEffort
    }
    setSlotError("")
    try {
      const result = await aiUpdateSettings.call(api, { slots: { [slot]: payload } })
      if (result.ok && result.state) setState(result.state)
      else setSlotError(tr("设置没有保存成功，请重试。"))
    } catch {
      setSlotError(tr("设置没有保存成功，请重试。"))
    }
  }

  const handleSelectModel = async (role: ModelRole, serviceId: string, modelId: string) => {
    if (!state) return
    const choice = slotChoiceFor(state, role, serviceId, modelId)
    await updateSlot(choice.slot, choice.patch)
  }

  const handleSelectEffort = async (role: "analysis" | "summary", effort: string) => {
    if (!state) return
    const choice = effortChoiceFor(state, role, effort)
    await updateSlot(choice.slot, choice.patch)
  }

  if (loadFailed) {
    return (
      <div className="ai-settings">
        <section className="settings-section settings-card">
          <p className="settings-card-desc">{tr("无法读取 AI 设置。")}</p>
        </section>
      </div>
    )
  }

  if (!state) {
    return <div className="ai-settings" />
  }

  const visibleIds = state ? visibleServiceIds(state, { opened }) : []
  const visibleServices = state
    ? visibleIds
        .map((id) => state.services.find((entry) => entry.id === id))
        .filter((entry): entry is AiServiceState => Boolean(entry))
    : []
  const addable = state ? addableServices(state, visibleIds) : []
  const allQuickAddOptions = state ? addableServices(state, []) : []
  const connectedIds = state ? connectedServiceIds(state) : []

  const renderTestStatus = (service: AiServiceState) => {
    if (testingFor[service.id]) {
      return (
        <span className="ai-status-line">
          <span className="ai-status-dot busy" aria-hidden="true" />
          <span className="ai-status-text">{tr("正在测试…")}</span>
        </span>
      )
    }
    const lastTest = service.lastTest
    if (!lastTest) {
      return (
        <span className="ai-status-line">
          <span className="ai-status-dot" aria-hidden="true" />
          <span className="ai-status-text">{tr("还没测试")}</span>
        </span>
      )
    }
    const display = lastTest.display
    const text = display
      ? fillTemplate(translate(display.template || display.message || "", language), display.params)
      : ""
    if (lastTest.ok) {
      return (
        <span className="ai-status-line">
          <span className="ai-status-dot ok" aria-hidden="true" />
          <span className="ai-status-text">
            {text}
            {display?.missingModel ? (
              <span className="ai-status-sub">
                {" · "}
                {fillTemplate(tr("这个账号的模型清单里没有 {model}"), { model: display.missingModel })}
              </span>
            ) : null}
          </span>
        </span>
      )
    }
    return (
      <span className="ai-status-line ai-status-error">
        <span className="ai-status-dot error" aria-hidden="true" />
        <span className="ai-status-text">{text}</span>
      </span>
    )
  }

  const renderServiceRow = (service: AiServiceState) => {
    const ollama = isOllamaService(service)
    const custom = isCustomService(service)
    const editing = !ollama && (keyEditing[service.id] === true || !service.hasKey)
    const testFailed = !testingFor[service.id] && service.lastTest?.ok === false

    if (editing) {
      const draft = keyDraft[service.id] ?? ""
      const canCancel = service.hasKey || !custom
      const formatLabel = service.format === "claude" ? tr("Claude 格式") : tr("OpenAI 格式")
      return (
        <div
          key={service.id}
          ref={(node) => { serviceRowRefs.current[service.id] = node }}
          className="ai-service-row editing"
          data-service-id={service.id}
        >
          <div className="ai-service-edit-head">
            <span className="ai-service-name">
              {displayServiceName(service)}
              {custom ? (
                <span className="ai-service-meta">
                  {" · "}
                  {formatLabel}
                  {service.baseUrl ? ` · ${service.baseUrl}` : ""}
                </span>
              ) : null}
            </span>
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
          </div>
          <div className="ai-service-edit-input">
            <input
              ref={(node) => { keyInputRefs.current[service.id] = node }}
              className="ai-text-input ai-key-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label={tr("密钥")}
              value={draft}
              disabled={!available}
              onChange={(event) => setKeyDraft((previous) => ({ ...previous, [service.id]: event.target.value }))}
              onKeyDown={(event) => {
                if (event.key === "Enter" && available && savingFor !== service.id) {
                  event.preventDefault()
                  void saveKey(service)
                } else if (event.key === "Escape" && canCancel) {
                  event.preventDefault()
                  event.stopPropagation()
                  cancelEdit(service)
                }
              }}
            />
            <button
              type="button"
              className="settings-action-btn"
              disabled={!available || savingFor === service.id}
              onClick={() => void saveKey(service)}
            >
              {tr("保存")}
            </button>
            {canCancel ? (
              <button
                type="button"
                className="settings-action-btn"
                onClick={() => cancelEdit(service)}
              >
                {tr("取消")}
              </button>
            ) : null}
          </div>
          <div className="ai-service-edit-foot">
            <span className="ai-service-hint">
              {tr("保存后自动测试连接。测试只要一份模型清单，不花钱。")}
            </span>
            {custom ? (
              <button
                type="button"
                className="ai-danger-link"
                disabled={!available}
                onClick={() => void removeService(service)}
              >
                {tr("删除此服务")}
              </button>
            ) : service.hasKey ? (
              <button
                type="button"
                className="ai-danger-link"
                disabled={!available}
                onClick={() => void deleteKey(service)}
              >
                {tr("删除密钥")}
              </button>
            ) : null}
          </div>
          {keyError[service.id] ? (
            <div className="ai-note ai-note-danger ai-error-line">
              <span className="ai-status-dot error" aria-hidden="true" />
              <span className="ai-note-text">{keyError[service.id]}</span>
            </div>
          ) : null}
        </div>
      )
    }

    return (
      <div
        key={service.id}
        ref={(node) => { serviceRowRefs.current[service.id] = node }}
        className="ai-service-row"
        data-service-id={service.id}
      >
        <div className={`ai-service-main${testFailed ? "" : " inline"}`}>
          <span className="ai-service-name">
            {displayServiceName(service)}
            <span className="ai-service-meta">
              {" · "}
              {ollama
                ? tr("本机运行，不需要密钥")
                : fillTemplate(tr("尾号 {last4}"), { last4: service.last4 })}
            </span>
          </span>
          {renderTestStatus(service)}
        </div>
        <div className="ai-service-actions">
          <button
            type="button"
            className="settings-action-btn"
            disabled={!available || Boolean(testingFor[service.id])}
            onClick={() => state && void runTest(service.id, testPurposeFor(state, service.id))}
          >
            {tr("测试连接")}
          </button>
          {!ollama ? (
            <button
              type="button"
              className="settings-action-btn"
              disabled={!available}
              onClick={() => {
                setKeyDraft((previous) => ({ ...previous, [service.id]: "" }))
                setKeyError((previous) => ({ ...previous, [service.id]: "" }))
                setKeyEditing((previous) => ({ ...previous, [service.id]: true }))
                requestKeyFocus(service.id)
              }}
            >
              {tr("更换")}
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  const priceLineFor = (role: ModelRole, service: AiServiceState | null): AiPriceLine | null => {
    if (!state || !available || connectedIds.length === 0 || !service) return null
    if (role === "analysis") {
      if (state.priceLines.analysis.length === 3) return state.priceLines.analysis[0]
      if (isOllamaService(service) && state.priceLines.analysis[0]) return state.priceLines.analysis[0]
      return null
    }
    if (role === "summary") {
      if (state.priceLines.analysis.length === 3) return state.priceLines.analysis[1]
      if (isOllamaService(service) && state.priceLines.analysis[0]) return state.priceLines.analysis[0]
      return null
    }
    const line = state.priceLines[role]?.[0]
    return line ? priceWithoutMonth(line) : null
  }

  const renderUseNote = (note: UseRowNote) => {
    const toneClass = note.tone === "danger" ? "ai-note-danger" : "ai-note-info"
    const dotClass = note.tone === "danger" ? "ai-status-dot error" : "ai-status-dot"

    let text = ""
    let actionButton: ReactNode = null

    switch (note.kind) {
      case "no-key":
        text = fillTemplate(tr("{service} 还没有密钥。"), note.params)
        actionButton = (
          <button
            type="button"
            className="ai-note-action"
            onClick={() => openKeyEditorFor(note.params.serviceId)}
          >
            {tr("填写密钥")}
          </button>
        )
        break
      case "test-failed":
        text = fillTemplate(tr("{service} 最近一次测试没通过，先在上面检查密钥。"), note.params)
        break
      case "learning-unsupported":
        text = tr("学习暂时只支持 Claude（含 Claude 格式的自定义服务），选这一家无法开始学习。")
        break
      case "analysis-expensive":
        text = fillTemplate(
          tr("单价是 {reference} 的 {n} 倍。逐张分析每张图调用一次，学同样多的图，花费也是 {n} 倍。"),
          note.params,
        )
        actionButton = (
          <button
            type="button"
            className="ai-note-action"
            onClick={() => void updateSlot("analysis", { model: note.params.referenceId })}
          >
            {fillTemplate(tr("换回 {reference}"), note.params)}
          </button>
        )
        break
      case "learning-unknown-price":
        text = fillTemplate(tr("{model} 不在单价表里，学习前无法估算花费，不能开始学习。"), note.params)
        break
      case "unknown-price":
        text = tr("这个模型不在单价表里，无法估算花费。")
        break
      case "image-needs-service":
        text = tr("出图要用 OpenAI 或 Gemini，填好其中一家的密钥后自动选上。")
        break
    }

    return (
      <div className={`ai-note ${toneClass}`}>
        <span className={dotClass} aria-hidden="true" />
        <div className="ai-note-body">
          <span className="ai-note-text">{text}</span>
          {actionButton ? <div className="ai-note-actions">{actionButton}</div> : null}
        </div>
      </div>
    )
  }

  const renderUseRow = (role: ModelRole, labelText: string, monthUsd?: number) => {
    const slot: SlotId = role === "summary" ? "analysis" : role
    const slotState = state?.slots[slot]
    const currentServiceId = slotState?.serviceId || ""
    const currentModelId = role === "summary" ? (slotState?.summaryModel || "") : (slotState?.model || "")
    const currentService = state?.services.find((entry) => entry.id === currentServiceId) ?? null

    const groups = state ? modelGroups(state, role, tr) : []
    const selectGroups: ToolbarSelectGroup[] = groups.map((group) => ({
      label: group.heading,
      value: group.serviceId === currentServiceId ? currentModelId : "",
      options: group.options,
      onChange: (modelId) => void handleSelectModel(role, group.serviceId, modelId),
    }))

    const rawNote = state ? rowNoteFor(state, role) : null
    const showNote = Boolean(
      rawNote && available && (connectedIds.length > 0 || Boolean(currentService)),
    )

    const noOptions = groups.every((group) => group.options.length === 0)
    const disabled =
      !available ||
      connectedIds.length === 0 ||
      (role === "image" && rawNote?.kind === "image-needs-service") ||
      noOptions

    let triggerDisplay: ReactNode
    if (!currentService || !currentModelId) {
      triggerDisplay = <span className="ai-select-placeholder">{tr("未选择")}</span>
    } else {
      const catalogEntry = state?.catalog.models.find((entry) => entry.id === currentModelId)
      const modelLabel = catalogEntry?.label || currentModelId
      const svcLabel = displayServiceName(currentService)
      const startsWithService = modelLabel.toLowerCase().startsWith(svcLabel.toLowerCase())
      triggerDisplay = startsWithService ? (
        modelLabel
      ) : (
        <>
          {modelLabel}
          <span className="ai-select-sub">
            {" · "}
            {svcLabel}
          </span>
        </>
      )
    }

    const priceLine = priceLineFor(role, currentService)
    const effortState = role === "analysis" || role === "summary" ? state?.learningEfforts?.[role] : undefined
    const showEffort = Boolean(effortState && effortState.levels.length > 0)
    const formatEffortOptionLabel = (level: string): string => {
      const base = tr(effortLabelKey(level))
      return level === effortState?.defaultEffort ? `${base}${tr("（默认）")}` : base
    }
    let effortHint = ""
    if (showEffort && effortState) {
      const valueIndex = effortState.levels.indexOf(effortState.value)
      const defaultIndex = effortState.levels.indexOf(effortState.defaultEffort)
      if (valueIndex !== -1 && defaultIndex !== -1) {
        if (valueIndex > defaultIndex) {
          const multiple = effortState.multiples[effortState.value]
          if (multiple !== undefined) {
            effortHint = fillTemplate(tr("比默认多想，这一步花费约 ×{n}"), { n: String(multiple) })
          }
        } else if (valueIndex < defaultIndex) {
          effortHint = tr("比默认少想，手册可能更粗")
        }
      }
    }

    return (
      <div className="ai-use-row" data-role={role}>
        <span className="ai-use-label">{tr(labelText)}</span>
        <div className="ai-use-control">
          <ToolbarSelect
            label={tr(labelText)}
            groups={selectGroups}
            display={triggerDisplay}
            disabled={disabled}
          />
          {showEffort && effortState && (role === "analysis" || role === "summary") ? (
            <div className="ai-effort-group">
              <ToolbarSelect
                label={tr("推理强度")}
                value={effortState.value}
                options={effortState.levels.map((level) => ({
                  value: level,
                  label: formatEffortOptionLabel(level),
                }))}
                display={fillTemplate(tr("推理强度：{level}"), {
                  level: formatEffortOptionLabel(effortState.value),
                })}
                disabled={!available}
                onChange={(nextEffort) => void handleSelectEffort(role, nextEffort)}
              />
              {effortHint ? <span className="ai-effort-hint">{effortHint}</span> : null}
            </div>
          ) : null}
          {priceLine ? (
            <span className="ai-price-line">
              {fillTemplate(translate(priceLine.template, language), priceLine.params)}
            </span>
          ) : null}
          {showNote && rawNote ? renderUseNote(rawNote) : null}
        </div>
        {monthUsd !== undefined ? (
          <span className="ai-month-text">
            {fillTemplate(tr("本月 {month}"), { month: formatMonthUsd(monthUsd) })}
          </span>
        ) : (
          <span className="ai-month-spacer" aria-hidden="true" />
        )}
      </div>
    )
  }

  const totalMonthUsd =
    (state?.monthTotals.analysis ?? 0) +
    (state?.monthTotals.brain ?? 0) +
    (state?.monthTotals.image ?? 0)

  const showHeaderAdd = available && visibleServices.length > 0
  const showEmptyState = available && visibleServices.length === 0

  return (
    <div className="ai-settings">
      <section className="settings-section settings-card ai-services" aria-label={tr("服务")}>
        <div className="settings-card-header">
          <div className="settings-card-head">
            <strong>{tr("服务")}</strong>
            {showHeaderAdd ? (
              <div className="ai-add-select">
                <ToolbarSelect
                  label={tr("添加服务")}
                  value=""
                  display={tr("添加服务")}
                  options={addable.map((option) => ({
                    value: option.value,
                    label: displayAddableLabel(option.value, option.label),
                  }))}
                  onChange={handleAddChoice}
                />
              </div>
            ) : null}
          </div>
          {available ? (
            <p className="settings-card-desc">
              {tr("密钥只保存在本机，由系统加密，不会上传到 GravityPort。")}
            </p>
          ) : (
            <div className="ai-note ai-note-danger">
              <span className="ai-status-dot error" aria-hidden="true" />
              <span className="ai-note-text">
                {tr("这台电脑无法加密保存密钥，暂时不能使用 AI 功能。GravityPort 不会用明文保存密钥。")}
              </span>
            </div>
          )}
        </div>

        {visibleServices.length > 0 ? (
          <div className="ai-service-list">{visibleServices.map(renderServiceRow)}</div>
        ) : null}

        {showEmptyState ? (
          <>
            <p className="ai-empty-line">{tr("还没有连接服务。先选一家，填好密钥就能用。")}</p>
            <div className="ai-quick-add">
              <span className="ai-quick-add-label">{tr("添加")}</span>
              {allQuickAddOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className="settings-action-btn ai-quick-add-btn"
                  onClick={() => handleAddChoice(option.value)}
                >
                  {displayAddableLabel(option.value, option.label)}
                </button>
              ))}
            </div>
          </>
        ) : null}

        {!available ? (
          <div className="ai-quick-add">
            <span className="ai-quick-add-label">{tr("添加")}</span>
            {allQuickAddOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className="settings-action-btn ai-quick-add-btn"
                disabled
              >
                {displayAddableLabel(option.value, option.label)}
              </button>
            ))}
          </div>
        ) : null}

        {addFormOpen && available ? (
          <div className="ai-add-form" role="group" aria-label={tr("添加服务")}>
            <div className="ai-form-row">
              <span className="ai-form-label">{tr("名称")}</span>
              <input
                className="ai-text-input"
                value={addForm.label}
                disabled={!available}
                maxLength={80}
                onChange={(event) => setAddForm((previous) => ({ ...previous, label: event.target.value }))}
              />
            </div>
            <div className="ai-form-row">
              <span className="ai-form-label">{tr("接口格式")}</span>
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
            <div className="ai-form-row">
              <span className="ai-form-label">{tr("地址")}</span>
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
                onClick={() => void submitAddService()}
              >
                {tr("添加")}
              </button>
              <button
                type="button"
                className="settings-action-btn"
                onClick={() => {
                  setAddFormOpen(false)
                  setAddForm(EMPTY_ADD_FORM)
                  setAddFormError("")
                }}
              >
                {tr("取消")}
              </button>
            </div>
            {addFormError ? (
              <div className="ai-note ai-note-danger ai-error-line">
                <span className="ai-status-dot error" aria-hidden="true" />
                <span className="ai-note-text">{addFormError}</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="settings-section settings-card ai-uses" aria-label={tr("用途")}>
        <div className="settings-card-header">
          <div className="settings-card-head">
            <strong>{tr("用途")}</strong>
            <span className="ai-month-total">
              {fillTemplate(tr("本月合计 {month}"), { month: formatMonthUsd(totalMonthUsd) })}
            </span>
          </div>
          <p className="settings-card-desc">
            {available && connectedIds.length === 0
              ? tr("连上第一家服务后，下面各项自动选好它的默认模型。")
              : tr("下拉里只列已连接服务的模型，选了哪家的模型就用哪家。")}
          </p>
        </div>

        <div className="ai-use-group">
          <div className="ai-use-group-head">
            <strong>{tr("学习")}</strong>
            <span className="ai-month-text">
              {fillTemplate(tr("本月 {month}"), {
                month: formatMonthUsd(state?.monthTotals.analysis ?? 0),
              })}
            </span>
          </div>
          <p className="settings-card-desc">
            {tr("学习库先逐张看图，每张图调用一次；再汇总成设计手册。两步用同一家服务。")}
          </p>
          {renderUseRow("analysis", "逐张分析")}
          {renderUseRow("summary", "汇总手册")}
        </div>

        <div className="ai-use-group ai-use-group-bordered">
          {renderUseRow("brain", "对话大脑", state?.monthTotals.brain ?? 0)}
        </div>

        <div className="ai-use-group ai-use-group-bordered">
          {renderUseRow("image", "出图", state?.monthTotals.image ?? 0)}
        </div>

        {slotError ? (
          <div className="ai-note ai-note-danger ai-error-line">
            <span className="ai-status-dot error" aria-hidden="true" />
            <span className="ai-note-text">{slotError}</span>
          </div>
        ) : null}
      </section>
    </div>
  )
}
