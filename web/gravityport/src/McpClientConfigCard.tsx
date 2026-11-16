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
import { handleExternalLinkClick } from "./external-link.js"
import { translate, type Language } from "./i18n.js"
import "./mcp-config.css"

export type McpClientId = "claudeDesktop" | "claudeCode" | "codex" | "other"

export const MCP_CLIENTS: ReadonlyArray<{ id: McpClientId; label: string; hint: string }> = [
  {
    id: "claudeDesktop",
    label: "Claude Desktop",
    hint: "粘贴到 claude_desktop_config.json（Claude 设置 > 开发者 > 编辑配置）。若文件中已有 mcpServers，仅合并 gravityport 这一段。",
  },
  { id: "claudeCode", label: "Claude Code", hint: "复制下面这段话，发给 Claude Code，它会自动完成安装。" },
  { id: "codex", label: "Codex", hint: "复制下面这段话，发给 Codex，它会自动完成安装。" },
  {
    id: "other",
    label: "其他",
    hint: "Cursor、Windsurf、Cline 等多数助手通用。粘贴到该助手的 MCP 设置中；若已有 mcpServers，仅合并 gravityport 这一段。",
  },
]

// 11-16：Cursor、Windsurf、Cline 等多数助手认的就是 Claude Desktop 那段
// mcpServers 配置，「其他」直接复用它，不另生成。
const CONFIG_SOURCE: Record<McpClientId, "claudeDesktop" | "claudeCode" | "codex"> = {
  claudeDesktop: "claudeDesktop",
  claudeCode: "claudeCode",
  codex: "codex",
  other: "claudeDesktop",
}

/** The raw config text behind a client tab. */
export function mcpClientConfigText(config: McpClientConfig | null | undefined, client: McpClientId): string {
  return config?.[CONFIG_SOURCE[client]] || ""
}

// UI 审查 11-16：Claude Code、Codex 能自己跑命令、改文件，所以给一段发给它的话，
// 由它安装（含重名时先替换）；Claude Desktop 改不了自己的配置文件，仍给配置原文。
const AGENT_PROMPTS: Partial<Record<McpClientId, string>> = {
  claudeCode: "请为我安装 GravityPort 的 MCP 服务器：在终端运行下面的命令。若已存在名为 gravityport 的 MCP 服务器，先将其移除再添加。完成后告诉我结果，我会开启新会话使其生效。\n\n```\n{config}\n```",
  codex: "请为我安装 GravityPort 的 MCP 服务器：将下面的配置写入 ~/.codex/config.toml。若文件中已有 [mcp_servers.gravityport] 一段，用下面的内容替换它，不要改动文件中的其他内容。完成后告诉我结果，我会重启 Codex 使其生效。\n\n```toml\n{config}\n```",
}

/** What the card shows and copies for a client: the message for an agent, or the raw config. */
export function mcpClientCopyText(client: McpClientId, configText: string, language: Language): string {
  const template = AGENT_PROMPTS[client]
  if (!template || !configText) return configText
  return translate(template, language).replace("{config}", () => configText)
}

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
  const text = mcpClientCopyText(selected.id, mcpClientConfigText(config, selected.id), language)

  return (
    <section className="mcp-config-card" aria-label={t("AI 助手（MCP）")}>
      <div className="mcp-config-header">
        <div className="mcp-config-head">
          <strong>{t("AI 助手（MCP）")}</strong>
          {config !== undefined && !config?.available ? (
            <div className="mcp-config-actions">
              <a
                className="mcp-guide-button"
                href={MCP_GUIDE_URL}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => handleExternalLinkClick(event, MCP_GUIDE_URL)}
              >
                {t("使用指南")}
              </a>
            </div>
          ) : config?.available ? (
            // UI 审查 11-16：助手切换放在标题右侧（没配置时那里是「使用指南」）。
            // 任务 359（SET-09c）：按钮组读屏名与卡片标题区分开。
            <div className="segmented mcp-config-clients" role="group" aria-label={t("AI 助手")}>
              {MCP_CLIENTS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={entry.id === selected.id ? "on" : ""}
                  aria-pressed={entry.id === selected.id}
                  onClick={() => onSelectClient(entry.id)}
                >
                  {t(entry.label)}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <p className="mcp-config-desc">{t("支持 Claude、Codex 等 AI 助手直接连接与管理素材库。将下方配置粘贴到 AI 助手中，然后重启该助手。")}</p>
      </div>
      {config === undefined ? null : config?.available ? (
        <>
          {config.installWarning === "not-in-applications" ? (
            <p className="mcp-config-warning" role="alert">{t("请先将 GravityPort 移到「应用程序」文件夹，再复制配置，否则其中的路径将失效。")}</p>
          ) : null}
          {/* UI 审查 11-16：说明和复制按钮同一行，复制不再压在代码上。 */}
          <div className="mcp-config-toolbar">
            <p className="mcp-config-hint">{t(selected.hint)}</p>
            <button type="button" className="neutral-button mcp-config-copy-button" onClick={onCopy} disabled={!text}>
              {copied ? t("已复制") : t("复制")}
            </button>
          </div>
          <div className="mcp-config-code">
            <pre data-mcp-client={selected.id}><code>{codeLines(text)}</code></pre>
          </div>
          <p className="mcp-config-note">{t("更改存储位置后无需修改此配置，重启 AI 助手即可。GravityPort 无需保持打开。")}</p>
        </>
      ) : (
        <p className="mcp-config-note">
          <a href={MCP_GUIDE_URL} target="_blank" rel="noreferrer" onClick={(event) => handleExternalLinkClick(event, MCP_GUIDE_URL)}>{t("当前环境无法自动生成配置，配置方法见使用指南。")}</a>
        </p>
      )}
    </section>
  )
}

// UI 审查 11-16：每行一块，缩进用留白画（原空格藏起来但仍在文本里），
// 折出来的部分再退两格，层次不乱；复制拿的是整段配置原文。
function codeLines(text: string) {
  const lines = text.split("\n")
  return lines.map((line, index) => {
    const body = line.trimStart()
    const indent = line.length - body.length
    return (
      <span key={index} className="mcp-config-line" style={{ paddingLeft: `${indent + 2}ch`, textIndent: "-2ch" }}>
        {indent > 0 ? <span className="mcp-config-indent">{line.slice(0, indent)}</span> : null}
        {index < lines.length - 1 ? `${body}\n` : body}
      </span>
    )
  })
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
    const text = mcpClientCopyText(client, mcpClientConfigText(config, client), language)
    if (!text) return
    void writeClipboardText(text).then(() => {
      setCopied(true)
      if (resetTimer.current) clearTimeout(resetTimer.current)
      resetTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS)
    }).catch(() => setCopied(false))
  }

  return <McpClientConfigCardView language={language} config={config} client={client} copied={copied} onSelectClient={selectClient} onCopy={copy} />
}
