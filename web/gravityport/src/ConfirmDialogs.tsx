// Confirmation dialogs (delete-to-trash, permanent delete, empty trash, extension authorization queue, rename notice, schema-upgrade notice) moved out of App.tsx (task 455). Pure moves; no behavior changes.
import Icon from "./Icon"
import { AuthorizationModal, type AuthorizationResult } from "./AuthorizationModal"
import { openLibraryFolder, type MosaWebCapturePairRequest, type MosaLiveDeletionRequest } from "./mosa-api"
import type { Language } from "./i18n"

export type ConfirmDialogsProps = {
  deleting: boolean
  setDeleting: React.Dispatch<React.SetStateAction<boolean>>
  skipConfirm: boolean
  setSkipConfirm: React.Dispatch<React.SetStateAction<boolean>>
  remove: () => Promise<void>
  permanentDeleteIds: string[] | null
  setPermanentDeleteIds: React.Dispatch<React.SetStateAction<string[] | null>>
  confirmPermanentDelete: () => Promise<void>
  emptyTrashConfirm: boolean
  setEmptyTrashConfirm: React.Dispatch<React.SetStateAction<boolean>>
  confirmEmptyTrash: () => Promise<void>
  authorizationQueue: Array<{ kind: "pair"; row: MosaWebCapturePairRequest } | { kind: "delete"; row: MosaLiveDeletionRequest }>
  liveDeleteServerNow: number
  language: Language
  handlePairDecision: (id: string, result: AuthorizationResult) => void
  handleLiveDeleteDecision: (id: string, result: AuthorizationResult) => void
  renameNoticeOpen: boolean
  dismissRenameNotice: () => void
  schemaNotice: { backupPath: string; targetVersion: number | null; checkedAt: string | null } | null
  dismissSchemaUpgradeNotice: () => void
  notify: (text: string) => void
  isMacPlatform: () => boolean
  tr: (text: string) => string
  fillNamed: (text: string, values: Record<string, string | number>) => string
}

export function ConfirmDialogs(props: ConfirmDialogsProps) {
  const {
    deleting, setDeleting, skipConfirm, setSkipConfirm, remove, permanentDeleteIds, setPermanentDeleteIds,
    confirmPermanentDelete, emptyTrashConfirm, setEmptyTrashConfirm, confirmEmptyTrash, authorizationQueue,
    liveDeleteServerNow, language, handlePairDecision, handleLiveDeleteDecision, renameNoticeOpen,
    dismissRenameNotice, schemaNotice, dismissSchemaUpgradeNotice, notify, isMacPlatform, tr, fillNamed,
  } = props
  return (
      <>
      {deleting && (
        <div className="modal-layer delete-layer">
          <div className="delete-modal" role="alertdialog" aria-modal="true">
            <div className="delete-icon">
              <Icon name="trash" size={26} />
            </div>
            <h3>{tr("移到回收站？")}</h3>
            <p>{tr("移到回收站的素材保留 90 天，期间可恢复。")}</p>
            <div className="delete-actions">
              <label>
                <input
                  type="checkbox"
                  checked={skipConfirm}
                  onChange={(e) => setSkipConfirm(e.target.checked)}
                />
                {tr("不再询问")}</label>
              <button
                className="neutral-button"
                onClick={() => setDeleting(false)}
              >
                {tr("取消")}</button>
              <button className="primary-button" onClick={remove}>
                {tr("移到回收站")}</button>
            </div>
          </div>
        </div>
      )}
      {permanentDeleteIds && (
        <div className="modal-layer delete-layer">
          <div className="delete-modal" role="alertdialog" aria-modal="true">
            <div className="delete-icon">
              <Icon name="trash" size={26} />
            </div>
            <h3>{permanentDeleteIds.length > 1 ? fillNamed("永久删除 {count} 个素材？", { count: permanentDeleteIds.length }) : tr("永久删除素材？")}</h3>
            <p>{tr("此操作无法撤销。")}</p>
            <div className="delete-actions">
              <button className="neutral-button" onClick={() => setPermanentDeleteIds(null)}>
                {tr("取消")}</button>
              <button className="primary-button" onClick={confirmPermanentDelete}>
                {tr("永久删除")}</button>
            </div>
          </div>
        </div>
      )}
      {emptyTrashConfirm && (
        <div className="modal-layer delete-layer">
          <div className="delete-modal" role="alertdialog" aria-modal="true">
            <div className="delete-icon">
              <Icon name="trash" size={26} />
            </div>
            <h3>{tr("清空回收站？")}</h3>
            <p>{tr("回收站中的所有素材将被永久删除。此操作无法撤销。")}</p>
            <div className="delete-actions">
              <button className="neutral-button" onClick={() => setEmptyTrashConfirm(false)}>
                {tr("取消")}</button>
              <button className="primary-button" onClick={confirmEmptyTrash}>
                {tr("清空回收站")}</button>
            </div>
          </div>
        </div>
      )}
      {/* Task 333 — authorization dialog; since task 385 the queue holds both
          pairing requests and live deletion requests (pairing first). The key
          prefix tells the two kinds apart in the shared onResult. */}
      {authorizationQueue.length > 0 && (
        <AuthorizationModal
          requests={authorizationQueue.map(({ kind, row }) => (
            kind === "pair" ? {
              key: `pair:${row.id}`,
              title: "允许这个浏览器扩展连接 GravityPort 吗？",
              consequence: "允许后，这个扩展可以把网页上生成的图和视频存进素材库。",
              source: row.knownExtension
                ? (row.extensionVersion
                  ? fillNamed("来自：GravityPort Web Capture {version}", { version: row.extensionVersion })
                  : "来自：GravityPort Web Capture")
                : "来自：一个浏览器扩展",
              primaryLabel: "允许连接",
            } : {
              key: `delete:${row.id}`,
              title: row.requesterKind === "jimeng"
                ? "允许「即梦删除同步」删除这张素材吗？"
                : (row.requesterName
                  ? fillNamed("允许 {name} 删除这张素材吗？", { name: row.requesterName })
                  : "允许一个 AI 助手删除这张素材吗？"),
              consequence: "允许后，这张素材会被移进回收站。",
              source: row.requesterKind === "jimeng"
                ? "来自：即梦删除同步"
                : (row.requesterName
                  ? fillNamed("来自：{name}（MCP）", { name: row.requesterName })
                  : "来自：AI 助手（MCP）"),
              primaryLabel: "允许删除",
              // One clock: the countdown runs against the server's expiresAt.
              timeoutSeconds: Math.max(1, Math.ceil((row.expiresAt - (liveDeleteServerNow || Date.now())) / 1000)),
            }
          ))}
          language={language}
          onResult={(key, result) => {
            const [kind, id] = key.startsWith("pair:") ? ["pair", key.slice(5)] : ["delete", key.slice(7)]
            if (kind === "pair") handlePairDecision(id, result)
            else handleLiveDeleteDecision(id, result)
          }}
        />
      )}
      {renameNoticeOpen && (
        <div className="modal-layer" onClick={(e) => { if (e.target === e.currentTarget) dismissRenameNotice() }}>
          <div className="delete-modal" role="alertdialog" aria-modal="true" aria-labelledby="rename-notice-title">
            <div className="delete-icon">
              <Icon name="info" size={26} />
            </div>
            <h3 id="rename-notice-title">{tr("MOSA 已更名为 GravityPort")}</h3>
            <p>{tr("素材、设置和浏览器扩展均保持不变，无需任何操作。")}</p>
            <div className="delete-actions">
              <button
                className="primary-button"
                onClick={dismissRenameNotice}
              >
                {tr("好")}
              </button>
            </div>
          </div>
        </div>
      )}
      {schemaNotice && (
        // Task 350: the post-upgrade check failed. Clicking the backdrop does
        // NOT dismiss (only 知道了 / Esc does) — the kept backup must be seen.
        <div className="modal-layer">
          <div className="delete-modal" role="alertdialog" aria-modal="true" aria-labelledby="schema-upgrade-notice-title">
            <div className="delete-icon">
              <Icon name="info" size={26} />
            </div>
            <h3 id="schema-upgrade-notice-title">{tr("素材库升级检查未通过")}</h3>
            <p>{tr("GravityPort 可以继续使用。升级前的备份已保留，请勿删除，并在「设置 > 反馈」中报告此问题。")}</p>
            <div className="delete-actions">
              <button
                className="neutral-button"
                onClick={() => {
                  openLibraryFolder(schemaNotice.backupPath, true).catch(() => {
                    // 404 (file gone) and friends keep the dialog open; the
                    // existing light toast says so.
                    notify("无法打开此位置")
                  })
                }}
              >
                {isMacPlatform() ? tr("在访达中显示备份") : tr("在文件资源管理器中显示备份")}
              </button>
              <button className="primary-button" onClick={dismissSchemaUpgradeNotice}>
                {tr("好")}
              </button>
            </div>
          </div>
        </div>
      )}
      </>
  )
}
