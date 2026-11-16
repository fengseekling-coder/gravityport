/**
 * Pinterest main view, shown when the sidebar entry is clicked.
 *
 * PinterestView is the only component the app needs to mount; the exported
 * PinterestGuide / PinterestBoardGrid / PinterestPinGrid / PinterestPinDetail
 * are stateless presentational pieces kept separate so unit tests can render
 * them without network access. No library operations live here: no context
 * menu, nothing draggable, and no Pinterest content ever reaches the asset
 * library or localStorage. A Pin can be selected (outline, shown in the
 * gallery's right column by App) and opened in the shared ImageViewer.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
import { layoutPinColumns } from "./pinterest-layout.js";
import { pinterestFormat, pinterestText } from "./pinterest-strings.js";
import { usePinterestConnection } from "./use-pinterest-connection.js";
import type { Language } from "./i18n.js";
import Icon from "./Icon";
import ImageViewer from "./ImageViewer";
import "./pinterest.css";

type BoardsPager = ReturnType<typeof createPinterestPager<PinterestBoard>>;
type PinsPager = ReturnType<typeof createPinterestPager<PinterestPin>>;

// 任务 359（SET-07o）：额度提示照定稿。
const QUOTA_LOW_TEXT = "今日 Pinterest 浏览额度即将用完，明天恢复。";

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
      {/* 任务 359（MAIN-32d）：引导页标题用名词短语，错误行另用带指令的整句。 */}
      <h2>{needsReconnect ? t("Pinterest 授权已失效") : t("连接 Pinterest")}</h2>
      <p>{t("连接后可在此浏览 Pinterest 账号里的画板和 Pin。内容直接从 Pinterest 加载。")}</p>
      {error ? <p className="pinterest-error-text">{error}</p> : null}
      <div className="pinterest-guide-actions">
        {connecting ? (
          <>
            <button type="button" className="pinterest-primary" disabled>{t("正在等待浏览器授权…")}</button>
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
  columns?: number;
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
  columns,
  loading,
  error,
  onOpenBoard,
  onRetry,
}: PinterestBoardGridProps) {
  const t = (text: string) => pinterestText(text, language);
  if (boards.length === 0) {
    if (loading) {
      return <div className="pinterest-inline-state" role="status">{t("正在加载…")}</div>;
    }
    if (error) {
      return (
        <div className="pinterest-inline-state">
          <p className="pinterest-error-text">{error}</p>
          <button type="button" className="pinterest-secondary" onClick={onRetry}>{t("重试")}</button>
        </div>
      );
    }
    return <div className="pinterest-inline-state">{t("Pinterest 账号中没有画板。在 Pinterest 创建画板后将显示在此处。")}</div>;
  }
  return (
    <div
      className="pinterest-board-grid"
      style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}
    >
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
          <span className="asset-card pinterest-board-cover">
            {board.cover_url ? (
              <img className="black-image" src={board.cover_url} alt="" draggable={false} loading="lazy" referrerPolicy="no-referrer" />
            ) : (
              <span className="black-image" aria-hidden="true" />
            )}
          </span>
          <span className="pinterest-board-meta">
            <span className="pinterest-board-name">{board.name}</span>
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
  /** The selected Pin gets the gallery's selection outline. */
  selectedPinId?: string | null;
  onSelectPin?: (pin: PinterestPin) => void;
  /** Double-click: open the Pin in the shared viewer. */
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
  selected,
  onSelectPin,
  onOpenPin,
}: {
  pin: PinterestPin;
  language: Language;
  selected: boolean;
  onSelectPin?: (pin: PinterestPin) => void;
  onOpenPin: (pin: PinterestPin) => void;
}) {
  const t = (text: string) => pinterestText(text, language);
  const src = pinCardImage(pin);
  const dims = pin.thumbnail;
  const ratio = dims && dims.width > 0 && dims.height > 0 ? `${dims.width} / ${dims.height}` : "1 / 1";
  // The title lives in the hover tooltip (tooltip.ts picks up `title`), never on the card.
  return (
    <button
      type="button"
      className={`asset-card pinterest-pin-card${selected ? " asset-selected" : ""}`}
      style={{ aspectRatio: ratio }}
      title={pin.title || undefined}
      aria-label={pin.title || undefined}
      aria-pressed={selected}
      onClick={(event) => {
        if (event.detail > 1) return;
        (onSelectPin ?? onOpenPin)(pin);
      }}
      onDoubleClick={() => onOpenPin(pin)}
      draggable={false}
    >
      {src ? (
        <img className="black-image" src={src} alt="" draggable={false} loading="lazy" referrerPolicy="no-referrer" />
      ) : (
        <span className="black-image" aria-hidden="true" />
      )}
      {isVideoPin(pin) ? (
        <span className="video-mark" title={t("视频")} aria-label={t("视频")}><Icon name="play" size={12} /></span>
      ) : null}
    </button>
  );
}

export function PinterestPinGrid({
  language,
  columns,
  loading,
  error,
  selectedPinId = null,
  onSelectPin,
  onOpenPin,
  onRetry,
}: PinterestPinGridProps) {
  const t = (text: string) => pinterestText(text, language);
  const total = columns.reduce((sum, column) => sum + column.length, 0);
  if (total === 0) {
    if (loading) {
      return <div className="pinterest-inline-state" role="status">{t("正在加载…")}</div>;
    }
    if (error) {
      return (
        <div className="pinterest-inline-state">
          <p className="pinterest-error-text">{error}</p>
          <button type="button" className="pinterest-secondary" onClick={onRetry}>{t("重试")}</button>
        </div>
      );
    }
    return <div className="pinterest-inline-state">{t("此画板中没有 Pin。在 Pinterest 保存 Pin 后将显示在此处。")}</div>;
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
              <PinterestPinCard
                key={pin.id}
                pin={pin}
                language={language}
                selected={pin.id === selectedPinId}
                onSelectPin={onSelectPin}
                onOpenPin={onOpenPin}
              />
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
  /** Open the Pin in the viewer (the summary image, like the gallery's inspector). */
  onOpenViewer?: () => void;
  /** The big-image viewer is open: hide the "open in viewer" link, like InspectorDetails. */
  viewerOpen?: boolean;
  /** Collapse the right column (its heading button, like the gallery's inspector). */
  onClose?: () => void;
};

function externalLinkHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Right-column contents for the selected Pin. Same structure and class names
 * as the gallery's InspectorDetails (detail-heading, asset-summary, asset-meta,
 * detail-section); fields a Pin does not have are simply not drawn.
 */
export function PinterestPinDetail({ language, pin, onOpen, onOpenViewer, viewerOpen = false, onClose }: PinterestPinDetailProps) {
  const [openFailed, setOpenFailed] = useState(false);
  const t = (text: string) => pinterestText(text, language);
  const thumbUrl = pin.thumbnail?.url || pin.image?.url || pin.video_cover_url;
  const externalHost = pin.link ? externalLinkHost(pin.link) : "";
  const openUrl = async (url: string) => {
    const ok = await onOpen(url);
    setOpenFailed(!ok);
  };
  return (
    <>
      <div className="detail-heading">
        <strong>{t("素材详情")}</strong>
        {onClose ? (
          <button type="button" aria-label={t("关闭素材详情")} onClick={onClose}>
            <Icon name="inspector" size={16} />
          </button>
        ) : null}
      </div>
      <div className="asset-summary">
        <button type="button" className="summary-image" aria-label={t("在查看器中打开")} onClick={onOpenViewer}>
          {thumbUrl ? (
            <img src={thumbUrl} alt="" draggable={false} referrerPolicy="no-referrer" />
          ) : null}
          {isVideoPin(pin) ? (
            <span className="video-mark" aria-hidden="true"><Icon name="play" size={12} /></span>
          ) : null}
          <Icon name="expand" />
        </button>
        <div className="asset-meta">
          {pin.title ? (
            <div className="asset-title">
              <span className="asset-name" title={pin.title}>{pin.title}</span>
            </div>
          ) : null}
          <span className="muted">{t("来自 Pinterest")}</span>
          {!viewerOpen && onOpenViewer ? (
            <button type="button" className="summary-preview" onClick={onOpenViewer}>
              {t("在查看器中打开")}
              <Icon name="right" size={12} />
            </button>
          ) : null}
        </div>
      </div>
      {pin.description ? (
        <section className="detail-section">
          <div className="detail-reading expanded">
            <p className="pinterest-detail-description">{pin.description}</p>
          </div>
        </section>
      ) : null}
      <section className="detail-section pinterest-detail-links">
        <button type="button" className="summary-preview" onClick={() => void openUrl(pin.pin_url)}>
          {t("在 Pinterest 打开")}
          <Icon name="external" size={12} />
        </button>
        {pin.link ? (
          <button type="button" className="summary-preview" onClick={() => void openUrl(pin.link)}>
            {externalHost}
            <Icon name="external" size={12} />
          </button>
        ) : null}
        {openFailed ? <p className="pinterest-error-text">{t("无法打开链接")}</p> : null}
      </section>
    </>
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

/**
 * What App's top bar and right column need to know about the view. Reported
 * through onChrome on every change; resets to PINTEREST_CHROME_IDLE on unmount.
 */
export type PinterestChrome = {
  /** Open board, null while the board list (or the guide) is shown. */
  boardName: string | null;
  pinCount: number;
  /** Selected Pin: shown in the right column. */
  pin: PinterestPin | null;
  viewing: boolean;
  viewerIndex: number;
  viewerTotal: number;
};

export const PINTEREST_CHROME_IDLE: PinterestChrome = {
  boardName: null,
  pinCount: 0,
  pin: null,
  viewing: false,
  viewerIndex: 0,
  viewerTotal: 0,
};

/** Commands App's top bar and right column send back into the view. */
export type PinterestViewHandle = {
  /** Viewer → board, board → board list. */
  back: () => void;
  openViewer: () => void;
};

export type PinterestViewProps = {
  language: Language;
  /** Gallery column count (App owns it; its ColumnControl sits in the top bar). */
  columns: number;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
  /** A dialog sits above the view: the viewer ignores keys. */
  suspended?: boolean;
  /** Clicking a Pin opens the right column if the user collapsed it. */
  onSelectPin?: () => void;
  onChrome?: (chrome: PinterestChrome) => void;
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

export const PinterestView = forwardRef<PinterestViewHandle, PinterestViewProps>(function PinterestView(
  { language, columns, fullscreen = false, onToggleFullscreen, suspended = false, onSelectPin, onChrome, onOpenSettings, onBoardCountChange },
  handleRef
) {
  const [statusPhase, setStatusPhase] = useState<"loading" | "ready" | "error">("loading");
  const [status, setStatus] = useState<PinterestStatus | null>(null);
  const [statusError, setStatusError] = useState<unknown>(null);
  const [board, setBoard] = useState<PinterestBoard | null>(null);
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [viewing, setViewing] = useState(false);
  const [boardsState, setBoardsState] = useState<PinterestPagerState<PinterestBoard>>(EMPTY_BOARDS_STATE);
  const [pinsState, setPinsState] = useState<PinterestPagerState<PinterestPin>>(EMPTY_PINS_STATE);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const boardsPagerRef = useRef<BoardsPager | null>(null);
  const pinsPagerRef = useRef<PinsPager | null>(null);
  const boardsSentinelRef = useRef<HTMLDivElement | null>(null);
  const pinsSentinelRef = useRef<HTMLDivElement | null>(null);
  const savedBoardsScrollTop = useRef(0);
  const savedPinsScrollTop = useRef(0);
  const onChromeRef = useRef(onChrome);
  onChromeRef.current = onChrome;
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
    if (code !== "PINTEREST_RECONNECT_REQUIRED" && code !== "PINTEREST_NOT_CONNECTED") return;
    // Leave the board too: after reconnecting the view starts from the board list.
    setBoard(null);
    setSelectedPinId(null);
    setViewing(false);
    setStatus(code === "PINTEREST_RECONNECT_REQUIRED" ? { connected: false, needsReconnect: true } : { connected: false });
  }, [listError]);

  // Sidebar badge: boards loaded so far, complete once paging is exhausted.
  useEffect(() => {
    if (!connected) return;
    onBoardCountChangeRef.current?.(boardsState.items.length, boardsState.done);
  }, [connected, boardsState.items.length, boardsState.done]);

  // Restore the board-list scroll position when coming back from a board, and
  // the Pin scroll position when coming back from the viewer.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = board ? (viewing ? 0 : savedPinsScrollTop.current) : savedBoardsScrollTop.current;
  }, [board, viewing]);

  const pins = pinsState.items;
  const selectedIndex = selectedPinId ? pins.findIndex((pin) => pin.id === selectedPinId) : -1;
  const selectedPin = selectedIndex >= 0 ? pins[selectedIndex] : null;

  const openViewerFor = useCallback((pin: PinterestPin) => {
    savedPinsScrollTop.current = scrollRef.current?.scrollTop ?? 0;
    setSelectedPinId(pin.id);
    setViewing(true);
  }, []);

  const navigateViewer = useCallback(
    (direction: number) => {
      if (pins.length === 0) return;
      const from = selectedIndex < 0 ? 0 : selectedIndex;
      const next = Math.min(pins.length - 1, Math.max(0, from + direction));
      setSelectedPinId(pins[next].id);
      // Close to the end of what is loaded: fetch the next page like scrolling does.
      const pager = pinsPagerRef.current;
      if (pager && next >= pins.length - 3 && errorCode(pager.state().error) !== "PINTEREST_QUOTA_LOW") void pager.loadMore();
    },
    [pins, selectedIndex]
  );

  const openBoard = useCallback((next: PinterestBoard) => {
    savedBoardsScrollTop.current = scrollRef.current?.scrollTop ?? 0;
    // Clear the previous board's pins in the same render, before the new
    // board's pager effect runs, so they never flash under the new title.
    setPinsState(EMPTY_PINS_STATE);
    setBoard(next);
    setSelectedPinId(null);
    setViewing(false);
  }, []);

  const closeBoard = useCallback(() => {
    setBoard(null);
    setSelectedPinId(null);
    setViewing(false);
  }, []);

  useImperativeHandle(
    handleRef,
    () => ({
      back: () => {
        if (viewing) setViewing(false);
        else closeBoard();
      },
      openViewer: () => {
        if (selectedPin) openViewerFor(selectedPin);
      },
    }),
    [viewing, closeBoard, selectedPin, openViewerFor]
  );

  // Report the top bar / right column state to App before paint so keyboard
  // listeners reading App's ref never see a stale viewing flag.
  const boardName = board?.name ?? null;
  const boardPinCount = board?.pin_count ?? 0;
  useLayoutEffect(() => {
    onChromeRef.current?.({
      boardName,
      pinCount: boardPinCount,
      pin: selectedPin,
      viewing: viewing && selectedPin !== null,
      viewerIndex: selectedIndex + 1,
      viewerTotal: pins.length,
    });
  }, [boardName, boardPinCount, selectedPin, viewing, selectedIndex, pins.length]);
  useEffect(() => () => onChromeRef.current?.(PINTEREST_CHROME_IDLE), []);

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
  }, [board, pinsState, viewing]);

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
    // 任务 359（MAIN-32a）：此刻只是读状态，不显示「正在连接」。
    body = <div className="pinterest-inline-state" role="status">{t("正在加载…")}</div>;
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
        error={connection.phase.kind === "error" ? t(connection.phase.message) : ""}
        onConnect={connection.start}
        onCancel={connection.cancel}
        onOpenSettings={onOpenSettings}
      />
    );
  } else if (board) {
    const pinsQuotaLow = errorCode(pinsState.error) === "PINTEREST_QUOTA_LOW";
    body = (
      <>
        <PinterestPinGrid
          language={language}
          columns={layoutPinColumns(pinsState.items, columns)}
          loading={pinsState.loading && pinsState.items.length === 0}
          error={pinsState.error && !pinsQuotaLow ? t(pinterestErrorMessage(pinsState.error)) : ""}
          selectedPinId={selectedPinId}
          onSelectPin={(pin) => {
            setSelectedPinId(pin.id);
            onSelectPin?.();
          }}
          onOpenPin={openViewerFor}
          onRetry={retryList}
        />
        {pinsState.loading && pinsState.items.length > 0 ? (
          <div className="pinterest-loading-more" role="status">{t("正在加载更多…")}</div>
        ) : null}
        {pinsQuotaLow ? <div className="pinterest-quota-note">{t(QUOTA_LOW_TEXT)}</div> : null}
        <div ref={pinsSentinelRef} className="pinterest-sentinel" aria-hidden="true" />
      </>
    );
  } else {
    const boardsQuotaLow = errorCode(boardsState.error) === "PINTEREST_QUOTA_LOW";
    body = (
      <>
        <PinterestBoardGrid
          language={language}
          boards={boardsState.items}
          columns={columns}
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

  // The viewer replaces the Pin grid (as it does the gallery); the grid's
  // scroll position is restored on the way back. Pinterest content is
  // read-only: no drag, no context menu.
  if (board && viewing && selectedPin) {
    const src = selectedPin.image?.url || selectedPin.thumbnail?.url || selectedPin.video_cover_url;
    return (
      <ImageViewer
        key={selectedPin.id}
        width={selectedPin.image?.width || 1}
        height={selectedPin.image?.height || 1}
        src={src || undefined}
        language={language}
        disabled={suspended}
        fullscreen={fullscreen}
        onNavigate={navigateViewer}
        onToggleFullscreen={() => onToggleFullscreen?.()}
        onContextMenu={() => {}}
        onOpenLocation={() => {}}
        message=""
        openLocationLabel=""
      />
    );
  }
  return (
    <div
      className="pinterest-view"
      ref={scrollRef}
      onContextMenu={(event) => event.preventDefault()}
    >
      {body}
    </div>
  );
});
