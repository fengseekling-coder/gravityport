import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const CLIENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
export const MOSA_BROWSER_CLIENT_COOKIE_PREFIX = "mosa-browser-client-";

export function normalizeMosaClientToken(value: unknown): string {
  const token = String(value || "").trim();
  if (!token) return "";
  if (!CLIENT_TOKEN_PATTERN.test(token)) {
    throw new Error("GravityPort client token must be a 32-byte-or-stronger base64url secret.");
  }
  return token;
}

export function isAuthorizedMosaClientToken(provided: unknown, configured: unknown): boolean {
  const left = String(provided || "").trim();
  const right = String(configured || "").trim();
  if (!left || !right) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function mosaClientTokenFingerprint(value: unknown): string {
  const token = normalizeMosaClientToken(value);
  return token ? createHash("sha256").update(token).digest("base64url").slice(0, 22) : "";
}

function normalizeBrowserClientPort(value: unknown): string {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 1 && numeric <= 65_535 ? String(numeric) : "";
}

export function mosaBrowserClientCookieName(port: unknown): string {
  const normalizedPort = normalizeBrowserClientPort(port);
  return normalizedPort ? `${MOSA_BROWSER_CLIENT_COOKIE_PREFIX}${normalizedPort}` : "";
}

export function mosaBrowserClientToken(value: unknown, port: unknown): string {
  const token = normalizeMosaClientToken(value);
  const normalizedPort = normalizeBrowserClientPort(port);
  if (!token || !normalizedPort) return "";
  return createHash("sha256")
    .update("mosa-browser-client\0")
    .update(normalizedPort)
    .update("\0")
    .update(token)
    .digest("base64url");
}

export function mosaBrowserClientCookieHeader(value: unknown, port: unknown): string {
  const name = mosaBrowserClientCookieName(port);
  const token = mosaBrowserClientToken(value, port);
  return name && token ? `${name}=${token}; Path=/; HttpOnly; SameSite=Strict` : "";
}

// Service-identity challenge (task 311): the desktop shell must not trust the
// public /api/health fields alone before attaching and handing out the client
// capability. The running service proves possession of the shared client token
// by signing a fresh nonce; the bound port is part of the signed message so a
// proof captured on one port never verifies for a service on another.
const SERVICE_IDENTITY_PROOF_PREFIX = "gravityport-service-identity\0";
const SERVICE_IDENTITY_NONCE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;

export function isMosaServiceIdentityNonce(value: unknown): value is string {
  return typeof value === "string" && SERVICE_IDENTITY_NONCE_PATTERN.test(value);
}

export function mosaServiceIdentityProof(
  token: unknown,
  { port, nonce }: { port: unknown; nonce: unknown },
): string {
  const key = normalizeMosaClientToken(token);
  const normalizedPort = normalizeBrowserClientPort(port);
  if (!key || !normalizedPort || !isMosaServiceIdentityNonce(nonce)) return "";
  return createHmac("sha256", key)
    .update(SERVICE_IDENTITY_PROOF_PREFIX)
    .update(normalizedPort)
    .update("\0")
    .update(nonce)
    .digest("base64url");
}

export function isAuthorizedMosaServiceIdentityProof(
  providedProof: unknown,
  token: unknown,
  { port, nonce }: { port: unknown; nonce: unknown },
): boolean {
  const expected = mosaServiceIdentityProof(token, { port, nonce });
  if (!expected) return false;
  const provided = typeof providedProof === "string" ? providedProof : "";
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);
}

function cookieValue(cookieHeader: unknown, name: string): string {
  if (!name) return "";
  const header = String(cookieHeader || "");
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return "";
}

export function isAuthorizedMosaClientRequest(
  providedToken: unknown,
  cookieHeader: unknown,
  configuredToken: unknown,
  port: unknown,
): boolean {
  if (isAuthorizedMosaClientToken(providedToken, configuredToken)) return true;
  const expectedBrowserToken = mosaBrowserClientToken(configuredToken, port);
  if (!expectedBrowserToken) return false;
  const browserToken = cookieValue(cookieHeader, mosaBrowserClientCookieName(port));
  return isAuthorizedMosaClientToken(browserToken, expectedBrowserToken);
}

/**
 * API paths reachable without the client capability (task 314). Everything
 * else under /api/ — including every GET — requires it: assets, prompts,
 * originals, and diagnostics must not be readable by other local system users
 * or sandboxed processes. The three entries are:
 *   /api/health          — non-sensitive fields only (no library path), used
 *                          by the extension, the desktop probe, and the
 *                          supervisor before any credential exists;
 *   /api/service-identity — the task 311 challenge, asked precisely before
 *                          the caller may hold the credential;
 *   /api/client-session   — exchanges the header credential for the browser
 *                          cookie, so it cannot itself require one.
 * Web Capture routes have their own bearer-token boundary and are
 * intentionally excluded by the runtime before this predicate is applied.
 */
export const PUBLIC_API_PATHS: ReadonlySet<string> = new Set([
  "/api/health",
  "/api/service-identity",
  "/api/client-session",
]);

export function requiresMosaClientToken(method: unknown, pathname: unknown): boolean {
  const verb = String(method || "GET").toUpperCase();
  if (verb === "OPTIONS") return false;
  const path = String(pathname || "");
  if (!path.startsWith("/api/")) return false;
  return !PUBLIC_API_PATHS.has(path);
}

export function isAllowedLocalOrigin(origin: unknown, port: number | string): boolean {
  if (!origin) return true;
  const allowedOrigins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]);
  return allowedOrigins.has(String(origin));
}

export function parseAllowedIngestOrigins(value: unknown): string[] {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(values
    .map((entry) => String(entry || "").trim())
    .filter((entry) => /^(chrome-extension|moz-extension):\/\/[a-z0-9-]+$/i.test(entry)))];
}

/** Origins allowed for an explicitly approved local browser extension. */
export function isAllowedIngestOrigin(
  origin: unknown,
  port: number | string,
  allowedExtensionOrigins: unknown = [],
): boolean {
  if (isAllowedLocalOrigin(origin, port)) return true;
  if (!origin) return true;
  return parseAllowedIngestOrigins(allowedExtensionOrigins).includes(String(origin));
}

/** Extension-only check used by explicit pairing routes. Unlike normal ingest
 * requests, pairing must never accept an absent/local-page Origin implicitly. */
export function isApprovedExtensionOrigin(origin: unknown, allowedExtensionOrigins: unknown = []): boolean {
  if (!origin) return false;
  return parseAllowedIngestOrigins(allowedExtensionOrigins).includes(String(origin));
}

export function resolveAllowedFolderPath(requestedPath: unknown, allowedPaths: unknown): string | null {
  if (typeof requestedPath !== "string" || !requestedPath.trim() || !Array.isArray(allowedPaths)) return null;

  let candidate: string;
  try {
    candidate = realpathSync(resolve(requestedPath));
  } catch {
    return null;
  }

  for (const allowedPath of allowedPaths) {
    if (!allowedPath) continue;
    let root;
    try {
      root = realpathSync(resolve(String(allowedPath)));
    } catch {
      continue;
    }
    const pathFromRoot = relative(root, candidate);
    if (pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))) {
      return candidate;
    }
  }
  return null;
}
