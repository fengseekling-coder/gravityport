/**
 * Pinterest main view, shown when the sidebar entry is clicked.
 *
 * PinterestView is the only component the app needs to mount; the exported
 * PinterestGuide / PinterestBoardGrid / PinterestPinGrid / PinterestPinDetail
 * are stateless presentational pieces kept separate so unit tests can render
 * them without network access. No library operations live here: nothing is
 * selectable, no context menu, nothing draggable, and no Pinterest content
 * ever reaches the asset library or localStorage.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  createPinterestPager,
  fetchPinterestStatus,
  listPinterestBoardPins,
  listPinterestBoards,
  pinterestErrorMessage,
  type PinterestBoard,
  type PinterestPagerState,
  type PinterestPin,
  type PinterestStatus,
} from "./pinterest-api.js";
import { desktopAPI } from "./desktop.js";
import { layoutPinColumns, pinterestColumnCount } from "./pinterest-layout.js";
import { pinterestFormat, pinterestText } from "./pinterest-strings.js";
import { usePinterestConnection } from "./use-pinterest-connection.js";
import type { Language } from "./i18n.js";
import "./pinterest.css";

type BoardsPager = ReturnType<typeof createPinterestPager<PinterestBoard>>;
type PinsPager = ReturnType<typeof createPinterestPager<PinterestPin>>;

const QUOTA_LOW_TEXT = "今天的 Pinterest 浏览额度快用完了，明天再来看看";

function errorCode(error: unknown): string {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : "";
}

// ============================================================================
// Presentational components (props only, no fetching)
// ============================================================================

export type PinterestGuideProps = {
  language: Language;
  needsReconnect: boolean;
  connecting: boolean;
  error: string;
  onConnect: () => void;
  onCancel: () => void;
  onOpenSettings?: () => void;
};

export function PinterestGuide({
  language,
  needsReconnect,
  connecting,
  error,
  onConnect,
  onCancel,
  onOpenSettings,
}: PinterestGuideProps) {
  const t = (text: string) => pinterestText(text, language);
  return (
    <div className="pinterest-guide">
      <h2>{needsReconnect ? t("Pinterest 授权已失效，请重新连接") : t("连接 Pinterest")}</h2>
      <p>{t("连接后，可以在这里浏览你自己的画板和 Pin。内容只在这台电脑上实时显示，不会存进素材库。")}</p>
      {error ? <p className="pinterest-error-text">{error}</p> : null}
      <div className="pinterest-guide-actions">
        {connecting ? (
          <>
            <button type="button" className="pinterest-primary" disabled>{t("等待浏览器授权…")}</button>
            <button type="button" className="pinterest-secondary" onClick={onCancel}>{t("取消")}</button>
          </>
        ) : (
          <button type="button" className="pinterest-primary" onClick={onConnect}>
            {needsReconnect ? t("重新连接") : t("连接 Pinterest")}
          </button>
        )}
      </div>
      {onOpenSettings ? (
        <button type="button" className="pinterest-link" onClick={onOpenSettings}>{t("打开设置")}</button>
      ) : null}
    </div>
  );
}

export type PinterestBoardGridProps = {
  language: Language;
  boards: PinterestBoard[];
  loading: boolean;
  error: string;
  onOpenBoard: (board: PinterestBoard) => void;
  onRetry: () => void;
};

function isSecretBoard(board: PinterestBoard): boolean {
  const privacy = board.privacy.toUpperCase();
  return privacy === "SECRET" || privacy === "PROTECTED";
}

export function PinterestBoardGrid({
  language,
  boards,
  loading,
  error,
  onOpenBoard,
  onRetry,
}: PinterestBoardGridProps) {
  const t = (text: string) => pinterestText(text, language);
  if (boards.length === 0) {
    if (loading) {
      return <div className="pinterest-inline-state" role="status">{t("加载中")}</div>;
    }
    if (error) {
      return (
        <div className="pinterest-inline-state">
          <p className="pinterest-error-text">{error}</p>
          <button type="button" className="pinterest-secondary" onClick={onRetry}>{t("重试")}</button>
        </div>
      );
    }
    return <div className="pinterest-inline-state">{t("你的 Pinterest 账号里还没有画板")}</div>;
  }
  return (
    <div className="pinterest-board-grid">
      {error ? (
        <div className="pinterest-error-row" role="alert">
          <span>{error}</span>
          <button type="button" className="pinterest-secondary" onClick={onRetry}>{t("重试")}</button>
        </div>
      ) : null}
      {boards.map((board) => (
        <button
          type="button"
          key={board.id}
          className="pinterest-board-card"
          onClick={() => onOpenBoard(board)}
          draggable={false}
        >
          {board.cover_url ? (
            <img className="pinterest-board-cover" src={board.cover_url} alt="" draggable={false} loading="lazy" />
          ) : (
            <span className="pinterest-board-cover pinterest-cover-empty" aria-hidden="true" />
          )}
          <span className="pinterest-board-name">{board.name}</span>
          <span className="pinterest-board-meta">
            {isSecretBoard(board) ? <span className="pinterest-badge">{t("私密")}</span> : null}
            <span>
              {board.pin_count === 1
                ? t("1 个 Pin")
                : pinterestFormat("{count} 个 Pin", { count: board.pin_count }, language)}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

export type PinterestPinGridProps = {
  language: Language;
  columns: PinterestPin[][];
  loading: boolean;
  error: string;
  onOpenPin: (pin: PinterestPin) => void;
  onRetry: () => void;
};

function isVideoPin(pin: PinterestPin): boolean {
  return /video/i.test(pin.media_type);
}

function pinCardImage(pin: PinterestPin): string {
  if (isVideoPin(pin) && pin.video_cover_url) return pin.video_cover_url;
  return pin.thumbnail?.url || "";
}

function PinterestPinCard({
  pin,
  language,
  onOpenPin,
}: {
  pin: PinterestPin;
  language: Language;
  onOpenPin: (pin: PinterestPin) => void;
}) {
  const t = (text: string) => pinterestText(text, language);
  const src = pinCardImage(pin);
  return (
    <button type="button" className="pinterest-pin-card" onClick={() => onOpenPin(pin)} draggable={false}>
      {src ? (
        <img className="pinterest-pin-cover" src={src} alt={pin.title} draggable={false} loading="lazy" />
      ) : (
        <span className="pinterest-pin-cover pinterest-cover-empty" aria-hidden="true" />
      )}
      {isVideoPin(pin) ? (
        <span className="pinterest-badge pinterest-pin-video-badge">{t("视频")}</span>
      ) : null}
      {pin.title ? <span className="pinterest-pin-title">{pin.title}</span> : null}
    </button>
  );
}

export function PinterestPinGrid({
  language,
  columns,
  loading,
  error,
  onOpenPin,
  onRetry,
}: PinterestPinGridProps) {
  const t = (text: string) => pinterestText(text, language);
  const total = columns.reduce((sum, column) => sum + column.length, 0);
  if (total === 0) {
    if (loading) {
      return <div className="pinterest-inline-state" role="status">{t("加载中")}</div>;
    }
    if (error) {
      return (
        <div className="pinterest-inline-state">
          <p className="pinterest-error-text">{error}</p>
          <button type="button" className="pinterest-secondary" onClick={onRetry}>{t("重试")}</button>
        </div>
      );
    }
    return <div className="pinterest-inline-state">{t("这个画板里还没有 Pin")}</div>;
  }
  return (
    <div className="pinterest-pin-flow">
      {error ? (
        <div className="pinterest-error-row" role="alert">
          <span>{error}</span>
          <button type="button" className="pinterest-secondary" onClick={onRetry}>{t("重试")}</button>
        </div>
      ) : null}
      <div className="pinterest-pin-columns">
        {columns.map((column, index) => (
          <div className="pinterest-pin-column" key={index}>
            {column.map((pin) => (
              <PinterestPinCard key={pin.id} pin={pin} language={language} onOpenPin={onOpenPin} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export type PinterestPinDetailProps = {
  language: Language;
  pin: PinterestPin;
  onOpen: (url: string) => Promise<boolean>;
};

function externalLinkHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function PinterestPinDetail({ language, pin, onOpen }: PinterestPinDetailProps) {
  const [openFailed, setOpenFailed] = useState(false);
  const t = (text: string) => pinterestText(text, language);
  const bigUrl = pin.image?.url || pin.thumbnail?.url || pin.video_cover_url;
  const externalHost = pin.link ? externalLinkHost(pin.link) : "";
  const openUrl = async (url: string) => {
    const ok = await onOpen(url);
    setOpenFailed(!ok);
  };
  return (
    <div className="pinterest-detail" role="dialog" aria-modal="true">
      <div className="pinterest-detail-media">
        {bigUrl ? (
          <img className="pinterest-detail-image" src={bigUrl} alt={pin.title} draggable={false} />
        ) : (
          <span className="pinterest-detail-image pinterest-cover-empty" aria-hidden="true" />
        )}
        <span className="pinterest-badge pinterest-detail-source">{t("来自 Pinterest")}</span>
      </div>
      <aside className="pinterest-detail-side">
        {pin.title ? <h3 className="pinterest-detail-title">{pin.title}</h3> : null}
        {pin.description ? <p className="pinterest-detail-description">{pin.description}</p> : null}
        <div className="pinterest-detail-actions">
          <button type="button" className="pinterest-primary" onClick={() => void openUrl(pin.pin_url)}>
            {t("在 Pinterest 打开")}
          </button>
          {pin.link ? (
            <button type="button" className="pinterest-link" onClick={() => void openUrl(pin.link)}>
              {externalHost}
            </button>
          ) : null}
        </div>
        {openFailed ? <p className="pinterest-error-text">{t("无法打开链接")}</p> : null}
      </aside>
    </div>
  );
}

// ============================================================================
// External links
// ============================================================================

/**
 * Open a plain web page: through the desktop bridge when available, falling
 * back to window.open in a browser. Returns false when nothing opened, which
 * the UI reports as "无法打开链接".
 */
export async function openExternalPinterestLink(url: string): Promise<boolean> {
  const desktop = desktopAPI();
  if (desktop?.openExternalLink) {
    try {
      const result = await desktop.openExternalLink(url);
      return Boolean(result?.ok);
    } catch {
      return false;
    }
  }
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  return Boolean(opened);
}

// ============================================================================
// Container
// ============================================================================

export type PinterestViewProps = {
  language: Language;
  onOpenSettings?: () => void;
  onBoardCountChange?: (count: number, complete: boolean) => void;
};

const EMPTY_BOARDS_STATE: PinterestPagerState<PinterestBoard> = {
  items: [],
  loading: false,
  done: false,
  error: null,
};
const EMPTY_PINS_STATE: PinterestPagerState<PinterestPin> = {
  items: [],
  loading: false,
  done: false,
  error: null,
};

export function PinterestView({ language, onOpenSettings, onBoardCountChange }: PinterestViewProps) {
  const [statusPhase, setStatusPhase] = useState<"loading" | "ready" | "error">("loading");
  const [status, setStatus] = useState<PinterestStatus | null>(null);
  const [statusError, setStatusError] = useState<unknown>(null);
  const [board, setBoard] = useState<PinterestBoard | null>(null);
  const [detailPin, setDetailPin] = useState<PinterestPin | null>(null);
  const [boardsState, setBoardsState] = useState<PinterestPagerState<PinterestBoard>>(EMPTY_BOARDS_STATE);
  const [pinsState, setPinsState] = useState<PinterestPagerState<PinterestPin>>(EMPTY_PINS_STATE);
  const [columnCount, setColumnCount] = useState(3);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const boardsPagerRef = useRef<BoardsPager | null>(null);
  const pinsPagerRef = useRef<PinsPager | null>(null);
  const boardsSentinelRef = useRef<HTMLDivElement | null>(null);
  const pinsSentinelRef = useRef<HTMLDivElement | null>(null);
  const savedBoardsScrollTop = useRef(0);
  const onBoardCountChangeRef = useRef(onBoardCountChange);
  onBoardCountChangeRef.current = onBoardCountChange;

  const t = (text: string) => pinterestText(text, language);
  const connected = statusPhase === "ready" && status?.connected === true && status.needsReconnect !== true;

  const loadStatus = useCallback(async () => {
    setStatusPhase("loading");
    setStatusError(null);
    try {
      const next = await fetchPinterestStatus();
      setStatus(next);
      setStatusPhase("ready");
    } catch (error) {
      setStatusError(error);
      setStatusPhase("error");
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // Board list pager lives at the container level so coming back from a board
  // keeps the loaded pages and never refetches.
  useEffect(() => {
    if (!connected) return;
    const pager = createPinterestPager(listPinterestBoards);
    boardsPagerRef.current = pager;
    const unsubscribe = pager.subscribe((state) => setBoardsState(state));
    setBoardsState(pager.state());
    void pager.loadFirst();
    return () => {
      unsubscribe();
      pager.dispose();
      boardsPagerRef.current = null;
    };
  }, [connected]);

  // One pager per board; leaving a board aborts its in-flight request so a
  // late response from an old board can never land on the new board's list.
  useEffect(() => {
    if (!board) return;
    const pager = createPinterestPager((bookmark, signal) =>
      listPinterestBoardPins(board.id, bookmark, signal)
    );
    pinsPagerRef.current = pager;
    const unsubscribe = pager.subscribe((state) => setPinsState(state));
    setPinsState(pager.state());
    void pager.loadFirst();
    return () => {
      unsubscribe();
      pager.dispose();
      pinsPagerRef.current = null;
    };
  }, [board]);

  // Reconnect / not-connected errors send the whole view back to the guide.
  const listError = board ? pinsState.error : boardsState.error;
  useEffect(() => {
    const code = errorCode(listError);
    if (code === "PINTEREST_RECONNECT_REQUIRED") {
      setStatus({ connected: false, needsReconnect: true });
    } else if (code === "PINTEREST_NOT_CONNECTED") {
      setStatus({ connected: false });
    }
  }, [listError]);

  // Sidebar badge: boards loaded so far, complete once paging is exhausted.
  useEffect(() => {
    if (!connected) return;
    onBoardCountChangeRef.current?.(boardsState.items.length, boardsState.done);
  }, [connected, boardsState.items.length, boardsState.done]);

  // Restore the board-list scroll position when coming back from a board.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = board ? 0 : savedBoardsScrollTop.current;
  }, [board]);

  // Column count follows the container width, 220px per column at minimum.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => setColumnCount(pinterestColumnCount(el.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [board]);

  // Esc closes the pin detail overlay.
  useEffect(() => {
    if (!detailPin) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetailPin(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailPin]);

  const openBoard = useCallback((next: PinterestBoard) => {
    savedBoardsScrollTop.current = scrollRef.current?.scrollTop ?? 0;
    setBoard(next);
    setDetailPin(null);
  }, []);

  const closeBoard = useCallback(() => {
    setBoard(null);
    setDetailPin(null);
  }, []);

  // Infinite scroll sentinels; QUOTA_LOW stops automatic paging.
  useEffect(() => {
    if (board || !connected) return;
    const root = scrollRef.current;
    const sentinel = boardsSentinelRef.current;
    if (!root || !sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        const pager = boardsPagerRef.current;
        if (!pager || errorCode(pager.state().error) === "PINTEREST_QUOTA_LOW") return;
        void pager.loadMore();
      },
      { root, rootMargin: "240px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [board, connected, boardsState]);

  useEffect(() => {
    if (!board) return;
    const root = scrollRef.current;
    const sentinel = pinsSentinelRef.current;
    if (!root || !sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        const pager = pinsPagerRef.current;
        if (!pager || errorCode(pager.state().error) === "PINTEREST_QUOTA_LOW") return;
        void pager.loadMore();
      },
      { root, rootMargin: "240px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [board, pinsState]);

  const connection = usePinterestConnection({ onConnected: (next) => setStatus(next) });

  const retryList = () => {
    const pager = board ? pinsPagerRef.current : boardsPagerRef.current;
    const hasContent = board ? pinsState.items.length > 0 : boardsState.items.length > 0;
    if (!pager) return;
    if (hasContent) void pager.loadMore();
    else void pager.loadFirst();
  };

  let body: ReactNode;
  if (statusPhase === "loading") {
    body = <div className="pinterest-inline-state" role="status">{t("正在连接 Pinterest…")}</div>;
  } else if (statusPhase === "error") {
    body = (
      <div className="pinterest-inline-state">
        <p className="pinterest-error-text">{t(pinterestErrorMessage(statusError))}</p>
        <button type="button" className="pinterest-secondary" onClick={() => void loadStatus()}>
          {t("重试")}
        </button>
      </div>
    );
  } else if (!status?.connected || status.needsReconnect) {
    body = (
      <PinterestGuide
        language={language}
        needsReconnect={status?.needsReconnect === true}
        connecting={connection.phase.kind === "connecting"}
        error={connection.phase.kind === "error" ? connection.phase.message : ""}
        onConnect={connection.start}
        onCancel={connection.cancel}
        onOpenSettings={onOpenSettings}
      />
    );
  } else if (board) {
    const pinsQuotaLow = errorCode(pinsState.error) === "PINTEREST_QUOTA_LOW";
    body = (
      <>
        <div className="pinterest-board-header">
          <button type="button" className="pinterest-secondary" onClick={closeBoard}>
            <span aria-hidden="true">‹</span> {t("全部画板")}
          </button>
          <strong className="pinterest-board-header-name">{board.name}</strong>
        </div>
        <PinterestPinGrid
          language={language}
          columns={layoutPinColumns(pinsState.items, columnCount)}
          loading={pinsState.loading && pinsState.items.length === 0}
          error={pinsState.error && !pinsQuotaLow ? t(pinterestErrorMessage(pinsState.error)) : ""}
          onOpenPin={setDetailPin}
          onRetry={retryList}
        />
        {pinsState.loading && pinsState.items.length > 0 ? (
          <div className="pinterest-loading-more" role="status">{t("正在加载更多…")}</div>
        ) : null}
        {pinsQuotaLow ? <div className="pinterest-quota-note">{t(QUOTA_LOW_TEXT)}</div> : null}
        <div ref={pinsSentinelRef} className="pinterest-sentinel" aria-hidden="true" />
        {detailPin ? (
          <div
            className="pinterest-detail-backdrop"
            onClick={(event) => {
              if (event.target === event.currentTarget) setDetailPin(null);
            }}
          >
            <PinterestPinDetail language={language} pin={detailPin} onOpen={openExternalPinterestLink} />
          </div>
        ) : null}
      </>
    );
  } else {
    const boardsQuotaLow = errorCode(boardsState.error) === "PINTEREST_QUOTA_LOW";
    body = (
      <>
        <PinterestBoardGrid
          language={language}
          boards={boardsState.items}
          loading={boardsState.loading && boardsState.items.length === 0}
          error={boardsState.error && !boardsQuotaLow ? t(pinterestErrorMessage(boardsState.error)) : ""}
          onOpenBoard={openBoard}
          onRetry={retryList}
        />
        {boardsState.loading && boardsState.items.length > 0 ? (
          <div className="pinterest-loading-more" role="status">{t("正在加载更多…")}</div>
        ) : null}
        {boardsQuotaLow ? <div className="pinterest-quota-note">{t(QUOTA_LOW_TEXT)}</div> : null}
        <div ref={boardsSentinelRef} className="pinterest-sentinel" aria-hidden="true" />
      </>
    );
  }

  // Pinterest content is read-only: no selection, no drag, no context menu.
  return (
    <div
      className="pinterest-view"
      ref={scrollRef}
      onContextMenu={(event) => event.preventDefault()}
    >
      {body}
    </div>
  );
}
