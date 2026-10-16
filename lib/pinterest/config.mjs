// Pinterest OAuth and API configuration.

export const PINTEREST_CLIENT_ID = "1624448";

export const PINTEREST_REDIRECT_URI = "http://localhost:43517/api/pinterest/callback";

export const PINTEREST_SCOPES = "user_accounts:read,boards:read,boards:read_secret,pins:read,pins:read_secret";

export function getPinterestTokenUrl() {
  return process.env.MOSA_PINTEREST_TOKEN_URL || "https://mosa.azhuilab.com/api/pinterest/token";
}

export function getPinterestApiBase() {
  return process.env.MOSA_PINTEREST_API_BASE || "https://api.pinterest.com/v5";
}

export function getPinterestAuthorizeUrl() {
  return process.env.MOSA_PINTEREST_AUTHORIZE_URL || "https://www.pinterest.com/oauth/";
}
