import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MOSA_WEB_CAPTURE_DEVELOPMENT_EXTENSION_ID = "hjcildpmialbefmcdpdooenlojecjpli";
export const MOSA_WEB_CAPTURE_STORE_EXTENSION_ID = "bhjibabaiccjjfcdbimeeaoaikhcfncc";
export const MOSA_WEB_CAPTURE_EXTENSION_IDS = Object.freeze([
  MOSA_WEB_CAPTURE_DEVELOPMENT_EXTENSION_ID,
  MOSA_WEB_CAPTURE_STORE_EXTENSION_ID,
]);
export const MOSA_WEB_CAPTURE_EXTENSION_ORIGINS = Object.freeze(
  MOSA_WEB_CAPTURE_EXTENSION_IDS.map((id) => `chrome-extension://${id}`),
);
export const MOSA_WEB_CAPTURE_DEFAULT_ORIGINS = MOSA_WEB_CAPTURE_EXTENSION_ORIGINS.join(",");

// Backward-compatible aliases for tooling/tests that still refer to the
// unpacked development extension as the singular official identity.
export const MOSA_WEB_CAPTURE_EXTENSION_ID = MOSA_WEB_CAPTURE_DEVELOPMENT_EXTENSION_ID;
export const MOSA_WEB_CAPTURE_EXTENSION_ORIGIN = `chrome-extension://${MOSA_WEB_CAPTURE_EXTENSION_ID}`;

const TOKEN_FILE_NAME = "web-capture-token";
const CLIENT_TOKEN_FILE_NAME = "desktop-client-token";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

/**
 * Returns the desktop-owned Web Capture secret, creating it on first launch.
 * The secret stays inside Electron userData and is never written into the
 * extension package or project checkout.
 */
export async function loadOrCreateWebCaptureToken(userDataDir) {
  const root = String(userDataDir || "").trim();
  if (!root) throw new Error("Desktop userData directory is required for Web Capture pairing.");

  await mkdir(root, { recursive: true });
  const tokenPath = join(root, TOKEN_FILE_NAME);
  const existing = await readStoredToken(tokenPath);
  if (existing) {
    await chmod(tokenPath, 0o600).catch(() => {});
    return existing;
  }

  const token = randomBytes(32).toString("base64url");
  await writeFile(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(tokenPath, 0o600).catch(() => {});
  return token;
}

export async function loadOrCreateMosaClientToken(userDataDir) {
  const root = String(userDataDir || "").trim();
  if (!root) throw new Error("Desktop userData directory is required for the GravityPort client token.");

  await mkdir(root, { recursive: true });
  const tokenPath = join(root, CLIENT_TOKEN_FILE_NAME);
  const existing = await readStoredToken(tokenPath);
  if (existing) {
    await chmod(tokenPath, 0o600).catch(() => {});
    return existing;
  }

  const token = randomBytes(32).toString("base64url");
  await writeFile(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(tokenPath, 0o600).catch(() => {});
  return token;
}

async function readStoredToken(tokenPath) {
  try {
    const token = String(await readFile(tokenPath, "utf8")).trim();
    return TOKEN_PATTERN.test(token) ? token : "";
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}
