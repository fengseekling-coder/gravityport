/**
 * Settings → 连接: "AI assistants (MCP)" card (task 208).
 *
 * The desktop main process builds ready-to-paste configs that run the bundled
 * MCP server with the app's own executable. The card only shows them and
 * copies the selected one. McpClientConfigCardView is the props-only half that
 * unit tests render directly.
 */

import { useEffect, useRef, useState } from "react"
import { desktopAPI, type McpClientConfig } from "./desktop.js"
import { translate, type Language } from "./i18n.js"
import "./mcp-config.css"

export type McpClientId = "claudeDesktop" | "claudeCode" | "codex"

export const MCP_CLIENTS: ReadonlyArray<{ id: McpClientId; label: string; hint: string }> = [
  {
    id: "claudeDesktop",
    label: "Claude Desktop",
    hint: "粘贴到 claude_desktop_config.json（Claude 设置 → 开发者 → 编辑配置）。里面已有 mcpServers 的，只把 gravityport 这一段并进去。",
  },
  { id: "claudeCode", label: "Claude Code", hint: "在终端里运行这条命令。" },
  { id: "codex", label: "Codex", hint: "粘贴到 ~/.codex/config.toml 末尾。" },
]

export const MCP_GUIDE_URL = "https://github.com/fengseekling-coder/gravityport/blob/main/docs/guide.zh-CN.md#mcp-与接口"

const COPIED_RESET_MS = 2000

export type McpClientConfigCardViewProps = {
  language: Language
  /** undefined while loading; null in a plain browser, where there is no bundled server to point at. */
  config: McpClientConfig | null | undefined
  client: McpClientId
  copied: boolean
  onSelectClient: (client: McpClientId) => void
  onCopy: () => void
}

export function McpClientConfigCardView({ language, config, client, copied, onSelectClient, onCopy }: McpClientConfigCardViewProps) {
  const t = (text: string) => translate(text, language)
  const selected = MCP_CLIENTS.find((entry) => entry.id === client) || MCP_CLIENTS[0]
  const text = config?.[selected.id] || ""

  return (
    <section className="mcp-config-card" aria-label={t("AI 助手（MCP）")}>
      <div className="mcp-config-copy">
        <strong>{t("AI 助手（MCP）")}</strong>
        <p>{t("让 Claude、Codex 等 AI 助手直接搜索、查看和记录你的素材库。复制下面的配置，粘贴到对应 AI 助手里，再重启它。")}</p>
      </div>
      {config === undefined ? null : config?.available ? (
        <>
          {config.installWarning === "not-in-applications" ? (
            <p className="mcp-config-warning" role="alert">{t("请先把 GravityPort 拖进「应用程序」文件夹再复制，不然这段路径会失效。")}</p>
          ) : null}
          <div className="segmented mcp-config-clients" role="group" aria-label={t("AI 助手（MCP）")}>
            {MCP_CLIENTS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={entry.id === selected.id ? "on" : ""}
                aria-pressed={entry.id === selected.id}
                onClick={() => onSelectClient(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <p className="mcp-config-hint">{t(selected.hint)}</p>
          <div className="mcp-config-code">
            <pre data-mcp-client={selected.id}><code>{text}</code></pre>
            <button type="button" className="neutral-button mcp-config-copy-button" onClick={onCopy} disabled={!text}>
              {copied ? t("已复制") : t("复制")}
            </button>
          </div>
          <p className="mcp-config-note">{t("挪了素材库也不用改配置，重启 AI 助手就会跟过去。GravityPort 不用开着。")}</p>
        </>
      ) : (
        <p className="mcp-config-note">
          <a href={MCP_GUIDE_URL} target="_blank" rel="noreferrer">{t("从源码运行时的配置方法见使用指南。")}</a>
        </p>
      )}
    </section>
  )
}

async function writeClipboardText(text: string) {
  const api = desktopAPI()
  if (api?.writeClipboardText) {
    const result = await api.writeClipboardText(text) as { ok?: boolean } | undefined
    if (result?.ok === false) throw new Error("clipboard write refused")
    return
  }
  await navigator.clipboard?.writeText(text)
}

export function McpClientConfigCard({ language }: { language: Language }) {
  const [config, setConfig] = useState<McpClientConfig | null | undefined>(() => (desktopAPI()?.getMcpClientConfig ? undefined : null))
  const [client, setClient] = useState<McpClientId>("claudeDesktop")
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const api = desktopAPI()
    if (!api?.getMcpClientConfig) return
    let active = true
    api.getMcpClientConfig()
      .then((next) => { if (active) setConfig(next) })
      .catch(() => { if (active) setConfig(null) })
    return () => { active = false }
  }, [])

  useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current) }, [])

  const selectClient = (next: McpClientId) => {
    setClient(next)
    setCopied(false)
  }

  const copy = () => {
    const text = config?.[client]
    if (!text) return
    void writeClipboardText(text).then(() => {
      setCopied(true)
      if (resetTimer.current) clearTimeout(resetTimer.current)
      resetTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS)
    }).catch(() => setCopied(false))
  }

  return <McpClientConfigCardView language={language} config={config} client={client} copied={copied} onSelectClient={selectClient} onCopy={copy} />
}
