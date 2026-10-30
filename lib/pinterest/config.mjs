// Pinterest OAuth and API configuration.

export const PINTEREST_CLIENT_ID = "1628239";

// The local server listens on 127.0.0.1 only; the literal IPv4 address keeps
// the OAuth redirect from landing on a ::1 squatter when "localhost" resolves
// to IPv6.
export const PINTEREST_REDIRECT_URI = "http://127.0.0.1:43517/api/pinterest/callback";

export const PINTEREST_SCOPES = "user_accounts:read,boards:read,boards:read_secret,pins:read,pins:read_secret";

/**
 * Accept an environment override only when it points at this machine, so a
 * wrong or tampered value can never steer tokens or feedback off-device
 * (task 312). Returns the trimmed override when it parses as an http(s) URL
 * with a loopback host (127.0.0.1, localhost, or [::1]); anything else —
 * including empty, unparseable, non-http(s), or external values — falls back
 * to the built-in default.
 */
export function loopbackUrlOr(envValue, fallback) {
  const value = String(envValue ?? "").trim();
  if (!value) return fallback;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return fallback;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return fallback;
  const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") return fallback;
  return value;
}

export function getPinterestTokenUrl() {
  return loopbackUrlOr(process.env.MOSA_PINTEREST_TOKEN_URL, "https://gravityport.azhuilab.com/api/pinterest/token");
}

export function getPinterestApiBase() {
  return loopbackUrlOr(process.env.MOSA_PINTEREST_API_BASE, "https://api.pinterest.com/v5");
}

export function getPinterestAuthorizeUrl() {
  return loopbackUrlOr(process.env.MOSA_PINTEREST_AUTHORIZE_URL, "https://www.pinterest.com/oauth/");
}
