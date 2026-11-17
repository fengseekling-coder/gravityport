// Sidebar JSX (brandbar, project switcher, main nav, group sections, update-ready line, settings button) moved out of App.tsx (task 441). Pure moves; no behavior changes.
import Icon from "./Icon"
import ToolbarSelect from "./ToolbarSelect"
import { SMART_SOURCE_GROUPS } from "./tag-display"
import { PINTEREST_ENTRY } from "./SettingsDialog"
import type { MosaNavigation } from "./mosa-api"

export type SidebarProps = {
  tr: (text: string) => string
  projects: string[]
  project: string
  switchProject: (next: string) => void
  active: string
  goTo: (partial: Partial<{ active: string; stackId: string; stackName: string; query: string; sortOrder: string; assetType: string }>, options?: { replace?: boolean }) => void
  setSelectedIds: React.Dispatch<React.SetStateAction<string[]>>
  cardDropSide: { kind: "group"; name: string } | { kind: "ungrouped" } | null
  navigation: MosaNavigation | null
  expandedSections: boolean[]
  setExpandedSections: React.Dispatch<React.SetStateAction<boolean[]>>
  createNamedGroup: () => void
  updateReadyLine: { title: string; head: string; versionText: string; tail: string } | null
  restartPending: boolean
  restartToUpdate: () => Promise<void>
  installationId: string
  setSettings: React.Dispatch<React.SetStateAction<boolean>>
  preview: boolean
  settings: boolean
  importDroppedFiles: (dataTransfer: DataTransfer | null, groupName?: string) => void
  openGroupMenu: (name: string, x: number, y: number) => void
}

export function Sidebar(props: SidebarProps) {
  const {
    tr, projects, project, switchProject, active, goTo, setSelectedIds, cardDropSide,
    navigation, expandedSections, setExpandedSections, createNamedGroup,
    updateReadyLine, restartPending, restartToUpdate, installationId, setSettings,
    preview, settings, importDroppedFiles, openGroupMenu,
  } = props
  return (
      <aside className="sidebar">
        <div className="brandbar">
          <strong>GravityPort</strong>
        </div>
        {projects.length > 1 && (
          <div className="sidebar-project">
            <ToolbarSelect
              label={tr("项目")}
              value={project}
              onChange={switchProject}
              options={projects.map(p => ({ value: p, label: p }))}
            />
          </div>
        )}
        <nav className="main-nav" aria-label={tr("素材库")}>
          {["所有素材", "Pinterest", "待整理", "收藏", "回收站"].filter(label => PINTEREST_ENTRY || label !== "Pinterest").map(
            (label) => (
              <button
                key={label}
                title={tr(label)}
                aria-label={tr(label)}
                aria-current={active === label ? "page" : undefined}
                className={`nav-row ${active === label ? "selected" : ""} ${label === "待整理" && cardDropSide?.kind === "ungrouped" ? "side-drop-target" : ""}`}
                {...(label === "待整理" ? { "data-drop-ungroup": "" } : {})}
                onClick={() => {
                  goTo({ active: label, stackId: "", stackName: "" })
                  setSelectedIds([])
                }}
              >
                {label === "Pinterest" ? <span className="brand-icon" aria-hidden="true" /> : <Icon
                  name={label === "待整理" ? "inbox" : label === "收藏" ? "heart" : label === "回收站" ? "trash" : "grid"}
                  size={16}
                />}
                <span>{tr(label)}</span>
                <small>
                  {label === "所有素材"
                    ? navigation?.total ?? 0
                    : label === "Pinterest"
                      // Pinterest stays in Trial access (1,000 calls a day shared
                      // by every user) until Standard access is approved, so the
                      // count slot says 即将上线 even after boards have loaded.
                      ? <span className="nav-soon">{tr("即将上线")}</span>
                      : label === "待整理"
                        ? navigation?.unorganized ?? 0
                        : label === "收藏"
                          ? navigation?.favorites ?? 0
                          : navigation?.trash ?? 0}
                </small>
              </button>
            ),
          )}
        </nav>
        {[0, 1].map((section) => (
          <div className="group-section" key={section}>
            <div className="section-label">
              <button
                className="section-toggle"
                aria-label={section === 0 ? tr("智能分组") : tr("我的分组")}
                aria-expanded={expandedSections[section]}
                aria-controls={`sidebar-group-${section}`}
                onClick={() => setExpandedSections(old => old.map((value, i) => i === section ? !value : value))}
              >
                <span>{section === 0 ? tr("智能分组") : tr("我的分组")}</span>
                <Icon name={expandedSections[section] ? "down" : "right"} size={12} />
              </button>
              {section === 1 && <button
                className="add-group"
                aria-label={tr("新建分组")}
                title={tr("新建分组")}
                onClick={createNamedGroup}
              ><Icon name="plus" size={16} /></button>}
            </div>
            <nav id={`sidebar-group-${section}`} aria-label={section === 0 ? tr("智能分组") : tr("我的分组")} hidden={!expandedSections[section]}>
            {(section === 0
              ? SMART_SOURCE_GROUPS.map(([source, name]) => ({
                  id: `source:${source}`, name,
                  count: navigation?.sourceTypes.find(entry => entry[0] === source)?.[1] ?? 0,
                })).filter(entry => entry.count > 0)
              : (navigation?.groups || []).map(entry => ({ id: `group:${entry.name}`, name: entry.name, count: entry.count }))
            ).map((g) => (
              <button
                className={`nav-row group-row ${
                  active === g.id ? "selected" : ""
                } ${g.id.startsWith("group:") && cardDropSide?.kind === "group" && cardDropSide.name === g.name ? "side-drop-target" : ""}`}
                key={g.id}
                title={tr(g.name)}
                aria-label={tr(g.name)}
                aria-current={active === g.id ? "page" : undefined}
                {...(g.id.startsWith("group:") ? { "data-drop-group": g.name } : {})}
                onClick={() => { goTo({ active: g.id, stackId: "", stackName: "" }); setSelectedIds([]) }}
                onContextMenu={event => {
                  if (section !== 1) return
                  event.preventDefault()
                  openGroupMenu(g.name, event.clientX, event.clientY)
                }}
                onDragOver={event => {
                  if (g.id.startsWith("group:") && !preview && !settings) event.preventDefault()
                }}
                onDrop={event => {
                  if (!g.id.startsWith("group:") || preview || settings) return
                  event.preventDefault()
                  importDroppedFiles(event.dataTransfer, g.name)
                }}
              >
                <Icon name={section === 0 ? "layers" : "folder"} size={16} />
                <span>{tr(g.name)}</span>
                <small>{g.count}</small>
              </button>
            ))}
            </nav>
          </div>
        ))}
        {updateReadyLine && (
          <div className="update-ready-slot">
            <button
              className="update-ready-line"
              disabled={restartPending}
              title={updateReadyLine.title}
              aria-label={updateReadyLine.title}
              onClick={restartToUpdate}
            >
              <span className="update-ready-dot" aria-hidden="true" />
              <span className="update-ready-label">
                {updateReadyLine.head}
                {updateReadyLine.versionText && <strong className="update-ready-version">{updateReadyLine.versionText}</strong>}
                {updateReadyLine.tail}
              </span>
              <span className="update-ready-action">{restartPending ? tr("正在更新…") : tr("重启并更新")}</span>
            </button>
          </div>
        )}
        <button
          className={`user-button${installationId ? " has-installation-id" : ""}`}
          onClick={() => setSettings(true)}
          aria-label={installationId ? `${tr("设置")} · ${tr("安装编号")} ${installationId}` : undefined}
          title={installationId ? `${tr("安装编号")} ${installationId}` : undefined}
        >
          <Icon name="user" size={14} />
          <span>{installationId ? `${installationId.slice(0, 8)}…${installationId.slice(-4)}` : tr("设置")}</span>
          <Icon name="settings" size={14} />
        </button>
      </aside>
  )
}
