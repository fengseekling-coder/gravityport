/**
 * Pinterest connection card for the settings window.
 *
 * PinterestConnectionCard is the container (status fetching, connect flow,
 * disconnect confirmation); PinterestConnectionCardView is the props-only
 * presentation half that unit tests render directly. The copy deliberately
 * never mentions MCP.
 */

import { useEffect, useRef, useState } from "react";
import {
  disconnectPinterest,
  fetchPinterestStatus,
  pinterestErrorMessage,
  type PinterestStatus,
} from "./pinterest-api.js";
import { pinterestFormat, pinterestText } from "./pinterest-strings.js";
import { pinterestConnectAvailable, usePinterestConnection } from "./use-pinterest-connection.js";
import type { Language } from "./i18n.js";
import Dialog from "./ui/Dialog.js";
import Button from "./ui/Button.js";
import "./pinterest.css";

export type PinterestConnectionCardViewProps = {
  language: Language;
  /** Null while the status request is in flight. */
  status: PinterestStatus | null;
  /** False while first connections are closed: 即将上线 replaces the button. */
  connectAvailable: boolean;
  connecting: boolean;
  connectionError: string;
  disconnecting: boolean;
  disconnectError: string;
  confirmOpen: boolean;
  onStart: () => void;
  onCancel: () => void;
  onRequestDisconnect: () => void;
  onConfirmDisconnect: () => void;
  onCancelDisconnect: () => void;
};

export function PinterestConnectionCardView({
  language,
  status,
  connectAvailable,
  connecting,
  connectionError,
  disconnecting,
  disconnectError,
  confirmOpen,
  onStart,
  onCancel,
  onRequestDisconnect,
  onConfirmDisconnect,
  onCancelDisconnect,
}: PinterestConnectionCardViewProps) {
  const t = (text: string) => pinterestText(text, language);
  const connected = status?.connected === true && status.needsReconnect !== true;
  const needsReconnect = status?.needsReconnect === true;

  let stateLine: string;
  if (!status) stateLine = t("正在加载…");
  else if (connected) {
    stateLine = status.username
      ? pinterestFormat("已连接 {username}", { username: `@${status.username}` }, language)
      : t("已连接");
  } else if (needsReconnect) stateLine = t("需要重新连接");
  else if (!connectAvailable && !connecting) stateLine = t("即将上线");
  else stateLine = t("未连接");

  const connectLabel = needsReconnect ? t("重新连接") : t("连接 Pinterest");
  const badgeClass = [
    "pinterest-status-badge",
    connected ? "is-connected" : "",
    needsReconnect ? "is-warning" : "",
  ].filter(Boolean).join(" ");

  return (
    <section className="settings-section settings-card pinterest-connection-card" aria-label="Pinterest">
      {/* 连接页重排（11-26）：卡头只放名称、状态和操作；今日用量是次要信息，放到说明下一行。 */}
      <div className="settings-card-header">
        <div className="settings-card-head">
          <div className="settings-card-title with-status">
            <strong>Pinterest</strong>
            <span className={badgeClass}>{stateLine}</span>
          </div>
          <div className="settings-card-actions">
            {connected ? (
              <button type="button" className="settings-action-btn pinterest-card-secondary" onClick={onRequestDisconnect} disabled={disconnecting}>
                {t("断开")}
              </button>
            ) : connecting ? (
              <>
                <button type="button" className="settings-action-btn pinterest-card-primary" disabled>{t("等待浏览器授权…")}</button>
                <button type="button" className="settings-action-btn pinterest-card-secondary" onClick={onCancel}>{t("取消")}</button>
              </>
            ) : connectAvailable ? (
              <button type="button" className="settings-action-btn pinterest-card-primary" onClick={onStart}>{connectLabel}</button>
            ) : null}
          </div>
        </div>
        <p className="settings-card-desc">{t("浏览 Pinterest 账号里的画板和 Pin。内容直接从 Pinterest 加载。")}</p>
        {connected && status?.quota ? (
          <p className="settings-card-desc pinterest-connection-quota">
            {pinterestFormat(
              "今天已用 {used} / {limit} 次",
              { used: status.quota.usedToday, limit: status.quota.limit },
              language
            )}
          </p>
        ) : null}
        {connectionError ? <p className="pinterest-error-text">{t(connectionError)}</p> : null}
        {disconnectError && !confirmOpen ? <p className="pinterest-error-text">{t(disconnectError)}</p> : null}
      </div>
      {/* 连接页重排（11-26）：原来的确认框是贴在卡片上的浮层，比卡片高，会被设置页的
          滚动区裁掉；改用公共确认框（任务 359 DLG-22a 的标题与正文照旧）。断开失败时
          框不关，原因显示在框里。 */}
      <Dialog
        open={confirmOpen}
        title={t("断开 Pinterest？")}
        description={t("此电脑上保存的 Pinterest 授权将被移除，需要时可重新连接。")}
        closeLabel={t("关闭")}
        onClose={() => { if (!disconnecting) onCancelDisconnect() }}
        actions={
          <>
            <Button variant="neutral" autoFocus disabled={disconnecting} onClick={onCancelDisconnect}>
              {t("取消")}
            </Button>
            <Button variant="danger" loading={disconnecting} onClick={onConfirmDisconnect}>
              {t("断开")}
            </Button>
          </>
        }
      >
        {disconnectError ? <p className="pinterest-error-text">{t(disconnectError)}</p> : null}
      </Dialog>
    </section>
  );
}

export type PinterestConnectionCardProps = {
  language: Language;
  onStatusChange?: (status: PinterestStatus) => void;
};

export function PinterestConnectionCard({ language, onStatusChange }: PinterestConnectionCardProps) {
  const [status, setStatus] = useState<PinterestStatus | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState("");
  const t = (text: string) => pinterestText(text, language);
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  const connection = usePinterestConnection({
    onConnected: (next) => {
      setStatus(next);
      onStatusChangeRef.current?.(next);
    },
  });

  // Read the current connection when the card opens. A failed read shows the
  // card as not connected so the user can still start a connection.
  useEffect(() => {
    const controller = new AbortController();
    fetchPinterestStatus(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setStatus(next);
        onStatusChangeRef.current?.(next);
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus({ connected: false });
      });
    return () => controller.abort();
  }, []);

  const confirmDisconnect = async () => {
    setDisconnecting(true);
    setDisconnectError("");
    try {
      await disconnectPinterest();
      const next: PinterestStatus = { connected: false };
      setStatus(next);
      onStatusChangeRef.current?.(next);
      setConfirmOpen(false);
    } catch (error) {
      // 任务 359（HC-20）：错误存码出的话，渲染时再翻译，切换语言跟着变。
      setDisconnectError(pinterestErrorMessage(error));
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <PinterestConnectionCardView
      language={language}
      status={status}
      connectAvailable={pinterestConnectAvailable(status)}
      connecting={connection.phase.kind === "connecting"}
      connectionError={connection.phase.kind === "error" ? connection.phase.message : ""}
      disconnecting={disconnecting}
      disconnectError={disconnectError}
      confirmOpen={confirmOpen}
      onStart={connection.start}
      onCancel={connection.cancel}
      onRequestDisconnect={() => setConfirmOpen(true)}
      onConfirmDisconnect={() => void confirmDisconnect()}
      onCancelDisconnect={() => setConfirmOpen(false)}
    />
  );
}
