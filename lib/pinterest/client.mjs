// Pinterest client for OAuth and API access.
import { createAuthStateManager } from "./auth-state.mjs";
import { createTokenStore } from "./token-store.mjs";
import {
  PINTEREST_CLIENT_ID,
  PINTEREST_REDIRECT_URI,
  PINTEREST_SCOPES,
  getPinterestTokenUrl,
  getPinterestApiBase,
  getPinterestAuthorizeUrl,
} from "./config.mjs";

const REQUIRED_PORT = 43517;
const DAILY_QUOTA_LIMIT = 1000;
const DAILY_QUOTA_SOFT_LIMIT = 900;
const TOKEN_REFRESH_THRESHOLD_DAYS = 3;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RETRY_AFTER_SEC = 10;
const MIN_RETRY_AFTER_SEC = 2;
const REQUEST_TIMEOUT_MS = 20000; // 20 seconds

/**
 * Create a Pinterest client.
 * @param {object} options
 * @param {string} options.userDataDir - User data directory for token storage.
 * @param {function} options.fetchImpl - Fetch implementation (defaults to global fetch).
 * @param {function} options.now - Function returning current timestamp.
 * @param {number} options.requestTimeoutMs - Request timeout in milliseconds.
 * @returns {object} Pinterest client.
 */
export function createPinterestClient({ userDataDir, fetchImpl = fetch, now = Date.now, requestTimeoutMs = REQUEST_TIMEOUT_MS }) {
  const tokenStore = createTokenStore(userDataDir);
  const authStateManager = createAuthStateManager({ now });
  
  // In-memory cache and quota tracking.
  let cachedToken = null;
  let needsReconnect = false;
  const cache = new Map(); // key -> { data, expiresAt }
  let quotaUsedToday = 0;
  let quotaResetDate = getUtcDate(now());
  
  // Refresh token deduplication.
  let ongoingRefresh = null;

  /**
   * Get current status.
   * @returns {Promise<object>} Status object (no tokens included).
   */
  async function status() {
    if (!cachedToken) {
      cachedToken = await tokenStore.read();
    }
    
    const connected = !!cachedToken?.access_token;
    const username = cachedToken?.username || null;
    
    // Check if refresh token is expired.
    let refreshExpired = false;
    if (cachedToken?.refresh_expires_at) {
      const refreshExpiresAt = new Date(cachedToken.refresh_expires_at).getTime();
      refreshExpired = Number.isNaN(refreshExpiresAt) || now() >= refreshExpiresAt;
    }
    
    return {
      connected,
      username,
      needsReconnect: needsReconnect || refreshExpired,
      quota: {
        usedToday: quotaUsedToday,
        limit: DAILY_QUOTA_LIMIT,
        softLimit: DAILY_QUOTA_SOFT_LIMIT,
      },
    };
  }

  /**
   * Begin OAuth connection.
   * @param {object} options
   * @param {number} options.port - Port the server is running on.
   * @returns {object} Object with authorizeUrl.
   */
  function beginConnect({ port }) {
    if (port !== REQUIRED_PORT) {
      const error = new Error(`Pinterest callback requires port ${REQUIRED_PORT}`);
      error.code = "PINTEREST_PORT_MISMATCH";
      throw error;
    }
    
    const state = authStateManager.generate();
    const params = new URLSearchParams({
      client_id: PINTEREST_CLIENT_ID,
      redirect_uri: PINTEREST_REDIRECT_URI,
      response_type: "code",
      scope: PINTEREST_SCOPES,
      state,
    });
    
    const authorizeUrl = `${getPinterestAuthorizeUrl()}?${params}`;
    return { authorizeUrl };
  }

  /**
   * Complete OAuth connection.
   * @param {object} options
   * @param {string} options.code - Authorization code.
   * @param {string} options.state - State token.
   */
  async function completeConnect({ code, state }) {
    if (!authStateManager.validateAndConsume(state)) {
      const error = new Error("Invalid or expired state");
      error.code = "PINTEREST_STATE_INVALID";
      throw error;
    }
    
    // Exchange code for tokens.
    const tokenData = await exchangeCode(code);
    
    // Get user account.
    const userAccount = await fetchPinterestApi("/user_account", tokenData.access_token);
    
    // Save to disk.
    const tokenRecord = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      access_expires_at: new Date(now() + tokenData.expires_in * 1000).toISOString(),
      // If refresh_token_expires_in is missing, store empty string (means never expires).
      refresh_expires_at: tokenData.refresh_token_expires_in 
        ? new Date(now() + tokenData.refresh_token_expires_in * 1000).toISOString()
        : "",
      scope: tokenData.scope,
      username: userAccount.username,
      connected_at: new Date(now()).toISOString(),
    };
    
    await tokenStore.write(tokenRecord);
    cachedToken = tokenRecord;
    needsReconnect = false;
    cache.clear();
  }

  /**
   * Exchange authorization code for tokens.
   * @param {string} code - Authorization code.
   * @returns {Promise<object>} Token response.
   */
  async function exchangeCode(code) {
    let response;
    try {
      response = await fetchImpl(getPinterestTokenUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant: "authorization_code",
          code,
          redirect_uri: PINTEREST_REDIRECT_URI,
        }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (err) {
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        const error = new Error("Pinterest service unreachable");
        error.code = "PINTEREST_UNREACHABLE";
        throw error;
      }
      const error = new Error("Pinterest service unreachable");
      error.code = "PINTEREST_UNREACHABLE";
      throw error;
    }
    
    if (response.status === 502) {
      let errorData;
      try {
        errorData = await response.json();
      } catch {
        errorData = {};
      }
      
      if (errorData.error === "pinterest_rejected") {
        const error = new Error("Pinterest rejected the authorization");
        error.code = "PINTEREST_REJECTED";
        throw error;
      }
      
      throw new Error(`Token service error: pinterest_bad_response`);
    }
    
    if (!response.ok) {
      throw new Error(`Token exchange failed: ${response.status}`);
    }
    
    const tokenData = await response.json();
    
    // Validate required fields.
    if (!tokenData.access_token || typeof tokenData.access_token !== "string") {
      throw new Error("Missing or invalid access_token in response");
    }
    if (typeof tokenData.expires_in !== "number" || tokenData.expires_in <= 0) {
      throw new Error("Missing or invalid expires_in in response");
    }
    if (!tokenData.refresh_token || typeof tokenData.refresh_token !== "string") {
      throw new Error("Missing or invalid refresh_token in response");
    }
    
    return tokenData;
  }

  /**
   * Refresh access token.
   * @returns {Promise<void>}
   */
  async function refreshToken() {
    // Deduplication: if refresh is already in-flight, wait for it.
    if (ongoingRefresh) {
      return ongoingRefresh;
    }
    
    if (!cachedToken) {
      cachedToken = await tokenStore.read();
    }
    
    if (!cachedToken?.refresh_token) {
      needsReconnect = true;
      const error = new Error("No refresh token available");
      error.code = "PINTEREST_RECONNECT_REQUIRED";
      throw error;
    }
    
    // Start refresh.
    ongoingRefresh = performRefresh();
    
    try {
      await ongoingRefresh;
    } finally {
      ongoingRefresh = null;
    }
  }
  
  async function performRefresh() {
    let response;
    try {
      response = await fetchImpl(getPinterestTokenUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant: "refresh_token",
          refresh_token: cachedToken.refresh_token,
        }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (err) {
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        const error = new Error("Pinterest service unreachable");
        error.code = "PINTEREST_UNREACHABLE";
        throw error;
      }
      const error = new Error("Pinterest service unreachable");
      error.code = "PINTEREST_UNREACHABLE";
      throw error;
    }
    
    if (response.status === 502) {
      let errorData;
      try {
        errorData = await response.json();
      } catch {
        errorData = {};
      }
      
      if (errorData.error === "pinterest_rejected") {
        needsReconnect = true;
        const error = new Error("Pinterest rejected token refresh");
        error.code = "PINTEREST_RECONNECT_REQUIRED";
        throw error;
      }
      
      throw new Error("Token service error");
    }
    
    if (!response.ok) {
      throw new Error(`Token refresh failed: ${response.status}`);
    }
    
    const tokenData = await response.json();
    
    // Validate required fields.
    if (!tokenData.access_token || typeof tokenData.access_token !== "string") {
      throw new Error("Missing or invalid access_token in response");
    }
    if (typeof tokenData.expires_in !== "number" || tokenData.expires_in <= 0) {
      throw new Error("Missing or invalid expires_in in response");
    }
    
    // Update token, keeping existing refresh token if not provided.
    cachedToken.access_token = tokenData.access_token;
    cachedToken.access_expires_at = new Date(now() + tokenData.expires_in * 1000).toISOString();
    cachedToken.scope = tokenData.scope || cachedToken.scope;
    
    // Only update refresh token and expiry if provided in response.
    if (tokenData.refresh_token) {
      cachedToken.refresh_token = tokenData.refresh_token;
    }
    if (tokenData.refresh_token_expires_in) {
      cachedToken.refresh_expires_at = new Date(now() + tokenData.refresh_token_expires_in * 1000).toISOString();
    }
    
    await tokenStore.write(cachedToken);
    needsReconnect = false;
  }

  /**
   * Ensure token is valid, refreshing if necessary.
   * @returns {Promise<string>} Valid access token.
   */
  async function ensureValidToken() {
    if (!cachedToken) {
      cachedToken = await tokenStore.read();
    }
    
    if (!cachedToken) {
      const error = new Error("Not connected to Pinterest");
      error.code = "PINTEREST_NOT_CONNECTED";
      throw error;
    }
    
    // Check if refresh token expired.
    const refreshExpiresAtStr = cachedToken.refresh_expires_at || "";
    if (refreshExpiresAtStr && refreshExpiresAtStr !== "") {
      const refreshExpiresAt = new Date(refreshExpiresAtStr).getTime();
      if (Number.isNaN(refreshExpiresAt) || now() >= refreshExpiresAt) {
        needsReconnect = true;
        const error = new Error("Refresh token expired");
        error.code = "PINTEREST_RECONNECT_REQUIRED";
        throw error;
      }
    } else if (refreshExpiresAtStr === "") {
      // Empty string means token never expires, treat as valid.
      // (legacy behavior for missing refresh_token_expires_in on exchange)
    } else if (cachedToken.refresh_expires_at === undefined) {
      // No refresh_expires_at field at all (old token format).
      // Don't set needsReconnect, just use the token.
    }
    
    // Check if access token needs refresh (within 3 days of expiry).
    const accessExpiresAt = new Date(cachedToken.access_expires_at).getTime();
    const threshold = TOKEN_REFRESH_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
    
    if (now() + threshold >= accessExpiresAt) {
      await refreshToken();
    }
    
    return cachedToken.access_token;
  }

  /**
   * Disconnect and clear tokens.
   */
  async function disconnect() {
    await tokenStore.clear();
    cachedToken = null;
    needsReconnect = false;
    cache.clear();
    // Do NOT reset quotaUsedToday.
  }

  /**
   * Check and update quota.
   */
  function checkQuota() {
    const currentDate = getUtcDate(now());
    if (currentDate !== quotaResetDate) {
      quotaUsedToday = 0;
      quotaResetDate = currentDate;
    }
    
    if (quotaUsedToday >= DAILY_QUOTA_SOFT_LIMIT) {
      const error = new Error("Daily quota limit reached");
      error.code = "PINTEREST_QUOTA_LOW";
      throw error;
    }
  }

  /**
   * Fetch from Pinterest API with auto-retry on 401.
   * @param {string} path - API path.
   * @param {string} accessToken - Access token (optional, will ensure valid if not provided).
   * @returns {Promise<object>} API response.
   */
  async function fetchPinterestApi(path, accessToken = null) {
    const token = accessToken || await ensureValidToken();
    
    checkQuota();
    quotaUsedToday++;
    
    const url = `${getPinterestApiBase()}${path}`;
    
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (err) {
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        const error = new Error("Pinterest service unreachable");
        error.code = "PINTEREST_UNREACHABLE";
        throw error;
      }
      const error = new Error("Pinterest service unreachable");
      error.code = "PINTEREST_UNREACHABLE";
      throw error;
    }
    
    if (response.status === 401 && !accessToken) {
      // Retry once after refresh.
      await refreshToken();
      checkQuota();
      quotaUsedToday++;
      
      let retryResponse;
      try {
        retryResponse = await fetchImpl(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${cachedToken.access_token}` },
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
      } catch (err) {
        if (err.name === "TimeoutError" || err.name === "AbortError") {
          const error = new Error("Pinterest service unreachable");
          error.code = "PINTEREST_UNREACHABLE";
          throw error;
        }
        const error = new Error("Pinterest service unreachable");
        error.code = "PINTEREST_UNREACHABLE";
        throw error;
      }
      
      if (retryResponse.status === 401) {
        needsReconnect = true;
        const error = new Error("Pinterest authentication failed");
        error.code = "PINTEREST_RECONNECT_REQUIRED";
        throw error;
      }
      
      if (retryResponse.status === 429) {
        return handleRateLimit(retryResponse, path);
      }
      
      if (!retryResponse.ok) {
        throw new Error(`Pinterest API error: ${retryResponse.status}`);
      }
      
      return retryResponse.json();
    }
    
    if (response.status === 429) {
      return handleRateLimit(response, path);
    }
    
    if (!response.ok) {
      throw new Error(`Pinterest API error: ${response.status}`);
    }
    
    return response.json();
  }

  /**
   * Handle 429 rate limit response.
   * @param {object} response - Response object.
   * @param {string} path - API path.
   * @returns {Promise<object>} API response after retry.
   */
  async function handleRateLimit(response, path) {
    let retryAfter = MIN_RETRY_AFTER_SEC;
    const retryAfterHeader = response.headers.get?.("Retry-After");
    
    if (retryAfterHeader) {
      const parsed = parseInt(retryAfterHeader, 10);
      // Only use if it's a positive integer; otherwise default to 2s.
      if (!Number.isNaN(parsed) && parsed > 0) {
        retryAfter = Math.min(parsed, MAX_RETRY_AFTER_SEC);
      }
    }
    
    const waitTime = retryAfter * 1000;
    await new Promise(resolve => setTimeout(resolve, waitTime));
    
    checkQuota();
    quotaUsedToday++;
    const token = await ensureValidToken();
    
    let retryResponse;
    try {
      retryResponse = await fetchImpl(`${getPinterestApiBase()}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (err) {
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        const error = new Error("Pinterest service unreachable");
        error.code = "PINTEREST_UNREACHABLE";
        throw error;
      }
      const error = new Error("Pinterest service unreachable");
      error.code = "PINTEREST_UNREACHABLE";
      throw error;
    }
    
    if (retryResponse.status === 429) {
      const error = new Error("Pinterest rate limit exceeded");
      error.code = "PINTEREST_RATE_LIMITED";
      throw error;
    }
    
    if (!retryResponse.ok) {
      throw new Error(`Pinterest API error: ${retryResponse.status}`);
    }
    
    return retryResponse.json();
  }

  /**
   * List boards.
   * @param {object} options
   * @param {string} options.bookmark - Pagination bookmark.
   * @returns {Promise<object>} Boards list.
   */
  async function listBoards({ bookmark = "" } = {}) {
    const cacheKey = `boards:${bookmark}`;
    const cached = cache.get(cacheKey);
    
    if (cached && now() < cached.expiresAt) {
      return cached.data;
    }
    
    const params = new URLSearchParams({
      page_size: "50",
      privacy: "ALL",
    });
    
    if (bookmark) {
      params.set("bookmark", bookmark);
    }
    
    const response = await fetchPinterestApi(`/boards?${params}`);
    
    const items = (response.items || []).map(board => ({
      id: board.id,
      name: board.name || "",
      description: board.description || "",
      privacy: board.privacy || "",
      pin_count: board.pin_count || 0,
      cover_url: board.media?.image_cover_url || "",
    }));
    
    const result = {
      items,
      bookmark: response.bookmark || "",
    };
    
    cache.set(cacheKey, { data: result, expiresAt: now() + CACHE_TTL_MS });
    return result;
  }

  /**
   * List pins in a board.
   * @param {string} boardId - Board ID.
   * @param {object} options
   * @param {string} options.bookmark - Pagination bookmark.
   * @returns {Promise<object>} Pins list.
   */
  async function listBoardPins(boardId, { bookmark = "" } = {}) {
    // Validate board ID.
    if (!/^[0-9]{1,32}$/.test(boardId)) {
      const error = new Error("Invalid board ID");
      error.code = "PINTEREST_BAD_ID";
      throw error;
    }
    
    const cacheKey = `pins:${boardId}:${bookmark}`;
    const cached = cache.get(cacheKey);
    
    if (cached && now() < cached.expiresAt) {
      return cached.data;
    }
    
    const params = new URLSearchParams({
      page_size: "50",
    });
    
    if (bookmark) {
      params.set("bookmark", bookmark);
    }
    
    const response = await fetchPinterestApi(`/boards/${boardId}/pins?${params}`);
    
    const items = (response.items || []).map(pin => normalizePin(pin));
    
    const result = {
      items,
      bookmark: response.bookmark || "",
    };
    
    cache.set(cacheKey, { data: result, expiresAt: now() + CACHE_TTL_MS });
    return result;
  }

  /**
   * Normalize a pin object.
   * @param {object} pin - Raw pin from API.
   * @returns {object} Normalized pin.
   */
  function normalizePin(pin) {
    const media = pin.media || {};
    const mediaType = media.media_type || "";
    
    let image = null;
    let thumbnail = null;
    let videoCoverUrl = "";
    
    if (mediaType === "video") {
      // Video pin.
      videoCoverUrl = media.cover_image_url || "";
      if (media.images) {
        image = media.images["1200x"] ? { url: media.images["1200x"].url, width: media.images["1200x"].width, height: media.images["1200x"].height } : null;
        thumbnail = media.images["600x"] ? { url: media.images["600x"].url, width: media.images["600x"].width, height: media.images["600x"].height } : null;
      }
      if (!image && videoCoverUrl) {
        image = { url: videoCoverUrl, width: 0, height: 0 };
      }
      if (!thumbnail && videoCoverUrl) {
        thumbnail = { url: videoCoverUrl, width: 0, height: 0 };
      }
    } else if (mediaType === "multiple_images") {
      // Multiple images pin - take first.
      const firstItem = media.items?.[0];
      if (firstItem?.images) {
        image = firstItem.images["1200x"] ? { url: firstItem.images["1200x"].url, width: firstItem.images["1200x"].width, height: firstItem.images["1200x"].height } : null;
        thumbnail = firstItem.images["600x"] ? { url: firstItem.images["600x"].url, width: firstItem.images["600x"].width, height: firstItem.images["600x"].height } : null;
      }
    } else if (media.images) {
      // Single image pin.
      image = media.images["1200x"] ? { url: media.images["1200x"].url, width: media.images["1200x"].width, height: media.images["1200x"].height } : null;
      thumbnail = media.images["600x"] ? { url: media.images["600x"].url, width: media.images["600x"].width, height: media.images["600x"].height } : null;
    }
    
    return {
      id: pin.id,
      title: pin.title || "",
      description: pin.description || "",
      link: pin.link || "",
      pin_url: `https://www.pinterest.com/pin/${pin.id}/`,
      board_id: pin.board_id || "",
      created_at: pin.created_at || "",
      media_type: mediaType,
      image,
      thumbnail,
      video_cover_url: videoCoverUrl,
    };
  }

  /**
   * Get UTC date string.
   * @param {number} timestamp - Timestamp.
   * @returns {string} YYYY-MM-DD in UTC.
   */
  function getUtcDate(timestamp) {
    const d = new Date(timestamp);
    return d.toISOString().split("T")[0];
  }

  return {
    status,
    beginConnect,
    completeConnect,
    disconnect,
    listBoards,
    listBoardPins,
  };
}
