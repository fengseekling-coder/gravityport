// Settings dialog JSX moved out of App.tsx (task 405). Pure moves; no behavior changes.
import Icon from "./Icon"
import Button from "./ui/Button"
import Switch from "./ui/Switch"
import { PinterestConnectionCard } from "./PinterestConnectionCard"
import { McpClientConfigCard } from "./McpClientConfigCard"
import { WebCaptureStatusCard } from "./WebCaptureStatusCard"
import { BridgeStatusCard } from "./BridgeStatusCard"
import { FeedbackPanel } from "./FeedbackPanel"
import { AiSettingsPanel } from "./AiSettingsPanel"
import { AI_SETTINGS_ENTRY } from "./ai-entry"
import { desktopAPI, type UpdateReadyState } from "./desktop"
import { buildUpdateText, type UpdateUiState } from "./app-lifecycle"
import { buildReleaseNoteBlocks } from "./release-notes-view"
import { handleExternalLinkClick } from "./external-link.js"
import type { Language } from "./i18n"
import type { PinterestStatus } from "./pinterest-api"
import type { MosaLibraryLocation } from "./mosa-api"

// 任务 351：关于页社区入口。Discord 只放行任务单授权的这一个邀请链接
// （desktop/open-external-link.mjs 的 allowlist 同步只放行它）。
export const DISCORD_INVITE_URL = "https://discord.gg/rArXAShSkQ"
export const GITHUB_DISCUSSIONS_URL = "https://github.com/fengseekling-coder/gravityport/discussions"

// Pinterest browsing (tasks 135/138/147). The sidebar row and Settings → 连接
// are shown, the row marked 即将上线 until Standard access; false hides
// both while the view, the connection card, and the local token API stay.
export const PINTEREST_ENTRY = true

export type SettingsDialogProps = {
  setSettings: React.Dispatch<React.SetStateAction<boolean>>
  settingTab: string
  setSettingTab: React.Dispatch<React.SetStateAction<string>>
  backgroundCapture: { supported: boolean; enabled: boolean }
  setBackgroundCapture: React.Dispatch<React.SetStateAction<{ supported: boolean; enabled: boolean }>>
  backgroundCaptureBusy: boolean
  setBackgroundCaptureBusy: React.Dispatch<React.SetStateAction<boolean>>
  appearance: string
  setAppearance: React.Dispatch<React.SetStateAction<string>>
  cardInfo: boolean
  setCardInfo: React.Dispatch<React.SetStateAction<boolean>>
  language: Language
  setLanguage: React.Dispatch<React.SetStateAction<Language>>
  savedLocally: boolean
  updateState: UpdateUiState
  updateReady: UpdateReadyState | null
  restartPending: boolean
  systemDark: boolean
  library: MosaLibraryLocation | null
  health: { productVersion: string; gitSha: string; distribution: string } | null
  tr: (text: string) => string
  notify: (text: string) => void
  onPinterestStatus: (status: PinterestStatus) => void
  checkForUpdates: () => Promise<void>
  downloadAndInstallUpdate: () => Promise<void>
  restartToUpdate: () => Promise<void>
  cancelUpdateDownload: () => void
  openDownloadPage: () => void
  changeLibraryLocation: () => Promise<void>
  openStorageLocation: () => Promise<void>
}

export function SettingsDialog(props: SettingsDialogProps) {
  const {
    setSettings, settingTab, setSettingTab,
    backgroundCapture, setBackgroundCapture, backgroundCaptureBusy, setBackgroundCaptureBusy,
    appearance, setAppearance, cardInfo, setCardInfo, language, setLanguage,
    savedLocally, updateState, updateReady, restartPending, systemDark, library, health,
    tr, notify, onPinterestStatus, checkForUpdates, downloadAndInstallUpdate, restartToUpdate,
    cancelUpdateDownload, openDownloadPage, changeLibraryLocation, openStorageLocation,
  } = props
  return (
        <div
          className="modal-layer"
          onMouseDown={(e) =>
            e.target === e.currentTarget && setSettings(false)
          }
        >
          <div
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label={tr("设置")}
            tabIndex={-1}
          >
            <aside className="settings-nav">
              {[
                ["常规与外观", "sun"],
                ["存储", "folder"],
                ["连接", "link"],
                ["AI", "sparkle"],
                ["反馈", "message"],
                ["关于", "info"],
              ].filter(([label]) => (PINTEREST_ENTRY || label !== "连接") && (AI_SETTINGS_ENTRY || label !== "AI")).map(([label, icon]) => (
                <button
                  className={settingTab === label ? "active" : ""}
                  aria-pressed={settingTab === label}
                  title={tr(label === "常规与外观" ? "常规" : label)}
                  key={label}
                  onClick={() => setSettingTab(label)}
                >
                  <Icon name={icon} size={15} />
                  {tr(label === "常规与外观" ? "常规" : label)}
                </button>
              ))}
              <div className="settings-brand">
                GravityPort
                <span>{tr("让每一次 AI 创作，有迹可循")}</span>
              </div>
            </aside>
            <div className="settings-content">
              <div className="settings-heading">
                <div className="settings-heading-copy">
                  <h3>{tr(settingTab === "常规与外观" ? "常规" : settingTab)}</h3>
                </div>
                <Button
                  variant="quiet"
                  iconOnly
                  className="modal-close"
                  aria-label={tr("关闭设置")}
                  onClick={() => setSettings(false)}
                >
                  <Icon name="close" size={16} />
                </Button>
              </div>
              <div className="settings-page" key={settingTab}>
              {settingTab === "常规与外观" ? (
                <>
                  <section className="settings-section settings-card" aria-label={tr("外观")}>
                    <div className="settings-card-header">
                      <div className="settings-card-head">
                        <strong>{tr("外观")}</strong>
                      </div>
                    </div>
                    <div className="appearance-options">
                      {["跟随系统", "浅色", "深色"].map((a, i) => (
                        <button
                          key={a}
                          aria-pressed={appearance === a}
                          className={`appearance-option ${
                            appearance === a ? "chosen" : ""
                          }`}
                          onClick={() => setAppearance(a)}
                        >
                          <div className={`theme-preview theme-${i}`}>
                            <div className="mini-sidebar" />
                            <div className="mini-content">
                              <i />
                              <i />
                              <i />
                              <i />
                            </div>
                            {appearance === a && (
                              <span>
                                <Icon name="check" size={10} />
                              </span>
                            )}
                          </div>
                          <span>{tr(a)}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                  <section className="settings-section settings-card">
                    <div className="settings-card-header">
                      <div className="settings-card-head">
                        <strong>{tr("显示素材名称")}</strong>
                        <Switch label={tr("显示素材名称")} checked={cardInfo} onCheckedChange={setCardInfo} />
                      </div>
                    </div>
                  </section>
                  <section className="settings-section settings-card">
                    <div className="settings-card-header">
                      <div className="settings-card-head">
                        <strong>{tr("界面语言")}</strong>
                        <div className="segmented" role="group" aria-label={tr("界面语言")}>
                          <button className={language === "zh" ? "on" : ""} aria-pressed={language === "zh"} onClick={() => setLanguage("zh")}>中文</button>
                          <button className={language === "en" ? "on" : ""} aria-pressed={language === "en"} onClick={() => setLanguage("en")}>English</button>
                        </div>
                      </div>
                    </div>
                  </section>
                </>
              ) : settingTab === "存储" ? (
                <>
                  <section className="settings-section settings-card">
                    <div className="settings-card-header">
                      <div className="settings-card-head">
                        <div className="settings-card-title">
                          <strong>{tr("存储位置")}</strong>
                          <span className="settings-inline-code" title={library?.path || ""}>{library?.path || "—"}</span>
                        </div>
                        <div className="settings-card-actions">
                          <button type="button" className="settings-action-btn" onClick={openStorageLocation}>{tr("打开")}</button>
                          <button type="button" className="settings-action-btn" onClick={changeLibraryLocation}>{tr("更改…")}</button>
                        </div>
                      </div>
                      <p className="settings-card-desc">{tr("素材和素材库数据均保存在此位置。")}</p>
                    </div>
                    {/* UI 审查 11-16：去掉「存储类型：sqlite」这一行，开发用的词，用户用不上。 */}
                  </section>
                </>
              ) : settingTab === "连接" ? (
                <>
                  <PinterestConnectionCard language={language} onStatusChange={onPinterestStatus} />
                  <McpClientConfigCard language={language} />
                  <WebCaptureStatusCard language={language} />
                  <BridgeStatusCard language={language} />
                  {backgroundCapture.supported && (
                    <section className="settings-section settings-card">
                      <div className="settings-card-header">
                        <div className="settings-card-head">
                          <strong>{tr("后台收录")}</strong>
                          <button
                            type="button"
                            className={`settings-switch ${backgroundCapture.enabled ? "enabled" : ""}`}
                            role="switch"
                            aria-checked={backgroundCapture.enabled}
                            aria-label={tr("后台收录")}
                            disabled={backgroundCaptureBusy}
                            onClick={async () => {
                              if (backgroundCaptureBusy) return
                              const previous = backgroundCapture.enabled
                              setBackgroundCaptureBusy(true)
                              setBackgroundCapture(s => ({ ...s, enabled: !previous }))
                              try {
                                const result = await desktopAPI()?.setBackgroundCapture?.(!previous)
                                if (!result?.ok) throw new Error("setting failed")
                                setBackgroundCapture(s => ({ ...s, enabled: result.enabled }))
                              } catch {
                                setBackgroundCapture(s => ({ ...s, enabled: previous }))
                                notify("无法更改后台收录设置")
                              } finally {
                                setBackgroundCaptureBusy(false)
                              }
                            }}
                          ><span /></button>
                        </div>
                        <p className="settings-card-desc">{tr("GravityPort 关闭后，继续接收浏览器扩展发来的素材。")}</p>
                      </div>
                    </section>
                  )}
                </>
              ) : settingTab === "AI" ? (
                <AiSettingsPanel language={language} />
              ) : settingTab === "反馈" ? (
                <FeedbackPanel language={language} />
              ) : (
                <>
                  <section className="settings-section settings-card about-card">
                    <div className="settings-card-header">
                      <div className="settings-card-head">
                        <div className="settings-card-title">
                          <img className="about-inline-logo" src={`/assets/gravityport-mark-${appearance === "深色" || (appearance === "跟随系统" && systemDark) ? "dark" : "light"}.svg`} width={18} height={18} alt="" aria-hidden="true" />
                          <strong>GravityPort</strong>
                          {(() => {
                            const text = buildUpdateText(
                              health?.productVersion || "",
                              updateState,
                              updateState.phase === "downloading" ? updateState.percent : 0,
                              tr,
                              language,
                            )
                            return <span className="settings-status-dot" title={text.badgeText}>{text.badgeText}</span>
                          })()}
                        </div>
                        <div className="settings-card-actions">
                          {(() => {
                            // Task 231 — a verified staged package wins: both entry
                            // points restart into it instead of re-downloading.
                            if (updateReady) {
                              return <button type="button" className="settings-action-btn about-update" onClick={restartToUpdate} disabled={restartPending}>{tr("重启并更新")}</button>
                            }
                            const text = buildUpdateText(
                              health?.productVersion || "",
                              updateState,
                              updateState.phase === "downloading" ? updateState.percent : 0,
                              tr,
                              language,
                            )
                            if (text.buttonLabel === null) return null
                            if (text.downloadAndInstall) {
                              return <button type="button" className="settings-action-btn about-update" onClick={downloadAndInstallUpdate} disabled={text.buttonDisabled}>{text.buttonLabel}</button>
                            }
                            if (text.secondaryLabel) {
                              return (
                                <div className="about-update about-update-actions">
                                  <button type="button" className="settings-action-btn" disabled>{text.buttonLabel}</button>
                                  <button type="button" className="settings-action-btn" onClick={cancelUpdateDownload}>{text.secondaryLabel}</button>
                                </div>
                              )
                            }
                            if (updateState.phase === "available" && !text.downloadAndInstall) {
                              return <button type="button" className="settings-action-btn about-update" onClick={openDownloadPage}>{text.buttonLabel}</button>
                            }
                            return <button type="button" className="settings-action-btn about-update" onClick={checkForUpdates} disabled={text.buttonDisabled}>{text.buttonLabel}</button>
                          })()}
                        </div>
                      </div>
                      <p className="settings-card-desc">
                        {tr("构建")} {health?.gitSha ? health.gitSha.slice(0, 7) : "—"} · {health?.distribution === "development" ? tr("开发版") : tr("正式版")}
                      </p>
                    </div>
                  </section>
                  <section className="settings-section settings-card">
                    {/* 任务 351:不放 release-notes 类——关于页流程把第一个
                        .release-notes 块当开发中分栏数行数,这里借用它会撞车。 */}
                    <p className="settings-card-desc">
                      {tr("社区：")}
                      <a href={DISCORD_INVITE_URL} target="_blank" rel="noreferrer" onClick={(event) => handleExternalLinkClick(event, DISCORD_INVITE_URL)}>Discord</a>
                      {" · "}
                      <a href={GITHUB_DISCUSSIONS_URL} target="_blank" rel="noreferrer" onClick={(event) => handleExternalLinkClick(event, GITHUB_DISCUSSIONS_URL)}>{tr("GitHub 讨论区")}</a>
                    </p>
                  </section>
                  {(() => {
                    const blocks = buildReleaseNoteBlocks({
                      productVersion: health?.productVersion || "",
                      distribution: health?.distribution || "",
                      language,
                      t: tr,
                      updateState,
                    })
                    return (
                      <>
                        {blocks.map((block, index) => (
                          <section key={`${index}-${block.title}`} className="settings-section settings-card release-notes" aria-label={block.title}>
                            <div className="settings-card-head release-heading">
                              <h4>{block.title}</h4>
                              {block.date ? <span>{block.date}</span> : null}
                            </div>
                            {block.groups.map((group, groupIndex) => (
                              <div key={groupIndex} className="release-group">
                                {group.heading ? <h5 className="release-group-heading">{group.heading}</h5> : null}
                                {/* UI 审查 11-16：只有「暂无更新记录」一行时不画列表圆点。 */}
                                <ul className={!group.heading && group.lines.length === 1 && group.lines[0] === tr("暂无更新记录") ? "release-empty" : undefined}>
                                  {group.lines.map((line, lineIndex) => <li key={lineIndex}>{line}</li>)}
                                </ul>
                              </div>
                            ))}
                          </section>
                        ))}
                      </>
                    )
                  })()}
                </>
              )}
              </div>
              {!savedLocally && <div className="settings-footnote" role="status">
                <Icon name="info" size={12} />
                {tr("无法保存偏好设置。更改将在退出 GravityPort 后失效。")}
              </div>}
            </div>
          </div>
        </div>
  )
}
