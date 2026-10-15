/**
 * Pinterest data layer — independent of React.
 *
 * Provides types, API functions, connection flow, paging, and error messages.
 * All requests route through mosa-api.ts requestJson.
 */

import { requestJson } from "./mosa-api.js";
import { desktopAPI } from "./desktop.js";

const e = encodeURIComponent;

// ============================================================================
// Types
// ============================================================================

export type PinterestStatus = {
  connected: boolean;
  username?: string;
  needsReconnect?: boolean;
  quota?: {
    usedToday: number;
    limit: number;
    softLimit: number;
  };
};

export type PinterestBoard = {
  id: string;
  name: string;
  description: string;
  privacy: string;
  pin_count: number;
  cover_url: string;
};

export type PinterestPin = {
  id: string;
  title: string;
  description: string;
  link: string;
  pin_url: string;
  board_id: string;
  created_at: string;
  media_type: string;
  image: { url: string; width: number; height: number } | null;
  thumbnail: { url: string; width: number; height: number } | null;
  video_cover_url: string;
};

export type PinterestPage<T> = {
  items: T[];
  bookmark: string;
};

// ============================================================================
// API Functions
// ============================================================================

export async function fetchPinterestStatus(signal?: AbortSignal): Promise<PinterestStatus> {
  const data = await requestJson<PinterestStatus>("/api/pinterest/status", { signal });
  return data || { connected: false };
}

export async function disconnectPinterest(): Promise<void> {
  await requestJson<{ ok?: boolean }>("/api/pinterest/disconnect", { method: "POST" });
}

export async function listPinterestBoards(
  bookmark = "",
  signal?: AbortSignal
): Promise<PinterestPage<PinterestBoard>> {
  const params = new URLSearchParams();
  if (bookmark) params.set("bookmark", bookmark);
  const data = await requestJson<{ items?: unknown; bookmark?: unknown }>(
    `/api/pinterest/boards${params.toString() ? "?" + params : ""}`,
    { signal }
  );
  return normalizePinterestPage(data, normalizeBoard);
}

export async function listPinterestBoardPins(
  boardId: string,
  bookmark = "",
  signal?: AbortSignal
): Promise<PinterestPage<PinterestPin>> {
  if (!/^\d{1,32}$/.test(boardId)) {
    const error = new Error("Invalid board ID");
    (error as Error & { code?: string }).code = "PINTEREST_BAD_ID";
    throw error;
  }

  const params = new URLSearchParams();
  if (bookmark) params.set("bookmark", bookmark);
  const data = await requestJson<{ items?: unknown; bookmark?: unknown }>(
    `/api/pinterest/boards/${e(boardId)}/pins${params.toString() ? "?" + params : ""}`,
    { signal }
  );
  return normalizePinterestPage(data, normalizePin);
}

export async function startPinterestConnect(): Promise<{ opened: true }> {
  const response = await requestJson<{ authorizeUrl?: string }>("/api/pinterest/connect", {
    method: "POST",
  });
  const authorizeUrl = response?.authorizeUrl;
  if (!authorizeUrl) throw new Error("No authorize URL returned");

  // Validate URL
  let url: URL;
  try {
    url = new URL(authorizeUrl);
  } catch {
    const error = new Error("Invalid authorize URL");
    (error as Error & { code?: string }).code = "PINTEREST_BAD_AUTHORIZE_URL";
    throw error;
  }

  if (url.protocol !== "https:") {
    const error = new Error("Invalid authorize URL protocol");
    (error as Error & { code?: string }).code = "PINTEREST_BAD_AUTHORIZE_URL";
    throw error;
  }

  if (url.hostname !== "www.pinterest.com") {
    const error = new Error("Invalid authorize URL host");
    (error as Error & { code?: string }).code = "PINTEREST_BAD_AUTHORIZE_URL";
    throw error;
  }

  if (url.pathname !== "/oauth/") {
    const error = new Error("Invalid authorize URL path");
    (error as Error & { code?: string }).code = "PINTEREST_BAD_AUTHORIZE_URL";
    throw error;
  }

  // Try to open
  const desktop = desktopAPI();
  if (desktop?.openPinterestAuthorize) {
    const result = await desktop.openPinterestAuthorize(authorizeUrl);
    if (!result?.ok) {
      const error = new Error("Failed to open authorization page");
      (error as Error & { code?: string }).code = "PINTEREST_OPEN_FAILED";
      throw error;
    }
  } else {
    const opened = window.open(authorizeUrl, "_blank", "noopener,noreferrer");
    if (!opened) {
      const error = new Error("Failed to open authorization page");
      (error as Error & { code?: string }).code = "PINTEREST_OPEN_FAILED";
      throw error;
    }
  }

  return { opened: true };
}

export async function waitForPinterestConnection({
  intervalMs = 2000,
  timeoutMs = 5 * 60_000,
  signal,
  fetchStatus = fetchPinterestStatus,
  sleep,
}: {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchStatus?: (signal?: AbortSignal) => Promise<PinterestStatus>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
} = {}): Promise<PinterestStatus> {
  const startTime = Date.now();
  const defaultSleep = async (ms: number, sig?: AbortSignal) => {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(resolve, ms);
      sig?.addEventListener("abort", () => {
        clearTimeout(timeout);
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  };
  const sleepFn = sleep || defaultSleep;

  for (;;) {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    try {
      const status = await fetchStatus(signal);
      if (status?.connected) {
        return status;
      }
    } catch (error) {
      // Single poll error does not interrupt; continue next round
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
    }

    const elapsed = Date.now() - startTime;
    if (elapsed >= timeoutMs) {
      const error = new Error("Connection timeout");
      (error as Error & { code?: string }).code = "PINTEREST_CONNECT_TIMEOUT";
      throw error;
    }

    try {
      await sleepFn(intervalMs, signal);
    } catch (error) {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      throw error;
    }
  }
}

// ============================================================================
// Pager
// ============================================================================

export type PinterestPagerState<T> = {
  items: T[];
  loading: boolean;
  done: boolean;
  error: Error | null;
};

export function createPinterestPager<T extends { id: string }>(
  fetchPage: (bookmark: string, signal: AbortSignal) => Promise<PinterestPage<T>>
) {
  let items: T[] = [];
  let loading = false;
  let done = false;
  let error: Error | null = null;
  let lastBookmark = "";
  let generation = 0;
  let currentRequest: Promise<void> | null = null;
  let currentController: AbortController | null = null;
  const listeners = new Set<(state: PinterestPagerState<T>) => void>();

  function notifyListeners() {
    const state = { items, loading, done, error };
    listeners.forEach((listener) => listener(state));
  }

  function state(): PinterestPagerState<T> {
    return { items, loading, done, error };
  }

  function loadFirst(): void {
    generation++;
    const currentGen = generation;
    if (currentController) {
      currentController.abort();
    }
    items = [];
    lastBookmark = "";
    done = false;
    error = null;
    loading = false;
    currentRequest = null;
    currentController = null;
    notifyListeners();
  }

  function loadMore(): Promise<void> {
    if (done || loading) {
      return currentRequest || Promise.resolve();
    }

    const gen = generation;
    const controller = new AbortController();
    currentController = controller;

    const request = (async () => {
      try {
        loading = true;
        error = null;
        notifyListeners();

        const page = await fetchPage(lastBookmark, controller.signal);
        if (gen !== generation) return; // Response from old generation

        const newItems = Array.isArray(page?.items) ? page.items : [];
        const seenIds = new Set<string>(items.map((item) => item.id));
        for (const item of newItems) {
          if (!seenIds.has(item.id)) {
            items.push(item);
            seenIds.add(item.id);
          }
        }

        lastBookmark = typeof page?.bookmark === "string" ? page.bookmark : "";
        done = !lastBookmark;
        error = null;
      } catch (err) {
        if (
          err instanceof DOMException &&
          err.name === "AbortError" &&
          gen !== generation
        ) {
          return; // Aborted by newer generation
        }
        error = err instanceof Error ? err : new Error(String(err));
      } finally {
        if (gen === generation) {
          loading = false;
          currentRequest = null;
          notifyListeners();
        }
      }
    })();

    currentRequest = request;
    return request;
  }

  function subscribe(listener: (state: PinterestPagerState<T>) => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { state, loadFirst, loadMore, subscribe };
}

// ============================================================================
// Error Messages
// ============================================================================

export function pinterestErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "";
  }

  const code = (error as Error & { code?: string }).code;

  const messages: Record<string, string> = {
    PINTEREST_NOT_CONNECTED: "尚未连接 Pinterest",
    PINTEREST_RECONNECT_REQUIRED: "Pinterest 授权已失效，请重新连接",
    PINTEREST_QUOTA_LOW: "今天的 Pinterest 浏览额度快用完了，明天再来看看",
    PINTEREST_RATE_LIMITED: "Pinterest 请求太频繁，请稍后再试",
    PINTEREST_PORT_MISMATCH: "本机服务端口被占用，暂时无法连接 Pinterest",
    PINTEREST_UNAVAILABLE: "Pinterest 连接服务不可用",
    PINTEREST_UNREACHABLE: "暂时连不上 Pinterest，请检查网络",
    PINTEREST_BAD_ID: "画板地址无效",
    PINTEREST_BAD_AUTHORIZE_URL: "无法打开 Pinterest 授权页",
    PINTEREST_OPEN_FAILED: "无法打开 Pinterest 授权页",
    PINTEREST_CONNECT_TIMEOUT: "没等到 Pinterest 授权完成，请重试",
  };

  if (code && code in messages) {
    return messages[code];
  }

  return "加载 Pinterest 内容失败";
}

// ============================================================================
// Helpers
// ============================================================================

function normalizePinterestPage<T>(
  data: unknown,
  normalize: (item: unknown) => T
): PinterestPage<T> {
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const items = Array.isArray(obj.items)
    ? obj.items.map(normalize)
    : [];
  const bookmark = typeof obj.bookmark === "string" ? obj.bookmark : "";
  return { items, bookmark };
}

function normalizeBoard(item: unknown): PinterestBoard {
  const obj = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
  return {
    id: String(obj.id || ""),
    name: String(obj.name || ""),
    description: String(obj.description || ""),
    privacy: String(obj.privacy || ""),
    pin_count: Number(obj.pin_count || 0),
    cover_url: String(obj.cover_url || ""),
  };
}

function normalizePin(item: unknown): PinterestPin {
  const obj = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
  const image = obj.image && typeof obj.image === "object" ? (obj.image as Record<string, unknown>) : null;
  const thumbnail = obj.thumbnail && typeof obj.thumbnail === "object" ? (obj.thumbnail as Record<string, unknown>) : null;

  return {
    id: String(obj.id || ""),
    title: String(obj.title || ""),
    description: String(obj.description || ""),
    link: String(obj.link || ""),
    pin_url: String(obj.pin_url || ""),
    board_id: String(obj.board_id || ""),
    created_at: String(obj.created_at || ""),
    media_type: String(obj.media_type || ""),
    image: image
      ? {
          url: String(image.url || ""),
          width: Number(image.width || 0),
          height: Number(image.height || 0),
        }
      : null,
    thumbnail: thumbnail
      ? {
          url: String(thumbnail.url || ""),
          width: Number(thumbnail.width || 0),
          height: Number(thumbnail.height || 0),
        }
      : null,
    video_cover_url: String(obj.video_cover_url || ""),
  };
}
