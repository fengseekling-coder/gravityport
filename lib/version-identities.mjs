import { readFileSync } from "node:fs";

// Mirrors the app version from package.json so the MCP serverInfo and the
// health endpoint's mcpServerVersion report the same number the App shows;
// the release flow already bumps package.json, so no separate sync is needed.
function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const MCP_SERVER_VERSION = readPackageVersion();
// Versioned contract for the local desktop/web runtime health + API surface.
// A long-lived pre-contract service must never masquerade as the current
// runtime merely because it is serving freshly-written static files from disk.
export const MOSA_SERVICE_PROTOCOL_VERSION = "1";
