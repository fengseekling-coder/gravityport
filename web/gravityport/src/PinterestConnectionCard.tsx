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
import { usePinterestConnection } from "./use-pinterest-connection.js";
import type { Language } from "./i18n.js";
import "./pinterest.css";

export type PinterestConnectionCardViewProps = {
  language: Language;
  /** Null while the status request is in flight. */
  status: PinterestStatus | null;
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
  if (!status) stateLine = t("加载中");
  else if (connected) {
    stateLine = status.username
      ? pinterestFormat("已连接 {username}", { username: `@${status.username}` }, language)
      : t("已连接");
  } else if (needsReconnect) stateLine = t("需要重新连接");
  else stateLine = t("未连接");

  const connectLabel = needsReconnect ? t("重新连接") : t("连接 Pinterest");

  return (
    <section className="pinterest-connection-card">
      <div className="pinterest-connection-head">
        <div className="pinterest-connection-copy">
          <strong>{stateLine}</strong>
          <p>{t("连接后，可以在侧栏浏览你自己的 Pinterest 画板和 Pin。内容只在这台电脑上实时显示，不会上传。")}</p>
          {connected && status?.quota ? (
            <small>
              {pinterestFormat(
                "今天已用 {used} / {limit} 次",
                { used: status.quota.usedToday, limit: status.quota.limit },
                language
              )}
            </small>
          ) : null}
          {connectionError ? <p className="pinterest-error-text">{connectionError}</p> : null}
          {disconnectError ? <p className="pinterest-error-text">{disconnectError}</p> : null}
        </div>
        <div className="pinterest-connection-actions">
          {connected ? (
            <button type="button" className="pinterest-secondary" onClick={onRequestDisconnect} disabled={disconnecting}>
              {t("断开")}
            </button>
          ) : connecting ? (
            <>
              <button type="button" className="pinterest-primary" disabled>{t("等待浏览器授权…")}</button>
              <button type="button" className="pinterest-secondary" onClick={onCancel}>{t("取消")}</button>
            </>
          ) : (
            <button type="button" className="pinterest-primary" onClick={onStart}>{connectLabel}</button>
          )}
        </div>
      </div>
      {confirmOpen ? (
        <div
          className="pinterest-confirm-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) onCancelDisconnect();
          }}
        >
          <div className="pinterest-confirm" role="dialog" aria-modal="true">
            <p>{t("断开后，这台电脑上保存的 Pinterest 授权会被删除。")}</p>
            <div className="pinterest-confirm-actions">
              <button type="button" className="pinterest-danger" onClick={onConfirmDisconnect} disabled={disconnecting}>
                {t("断开")}
              </button>
              <button type="button" className="pinterest-secondary" onClick={onCancelDisconnect}>{t("取消")}</button>
            </div>
          </div>
        </div>
      ) : null}
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
      setDisconnectError(t(pinterestErrorMessage(error)));
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <PinterestConnectionCardView
      language={language}
      status={status}
      connecting={connection.phase.kind === "connecting"}
      connectionError={connection.phase.kind === "error" ? t(connection.phase.message) : ""}
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
