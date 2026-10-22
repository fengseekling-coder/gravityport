import { readGravityPortEnv } from "./env-aliases.mjs";

/**
 * Parse GRAVITYPORT_DISABLE_BRIDGES into a validated list of bridge names.
 *
 * The accepted names are the bridges whose `start()` call actually scans a
 * user-local directory and would otherwise import material into the runtime
 * library. Anything else (e.g. "webCapture") is rejected with a clear error,
 * because claiming to disable it would be a silent no-op and mis-state the
 * isolation guarantee Task 1 needs.
 *
 * Resolution order:
 *   1. `options.explicit` (an array of strings) — wins if defined.
 *   2. `options.env.GRAVITYPORT_DISABLE_BRIDGES`, or its legacy alias
 *      `MOSA_DISABLE_BRIDGES` (a comma-separated string).
 *   3. Otherwise an empty list.
 *
 * Empty entries, whitespace, and unknown names are rejected with an Error so
 * the failure surfaces immediately rather than being hidden behind a
 * successful start.
 *
 * @typedef {"cowart" | "cowartDiscovery" | "codex" | "grok"} DisableableBridge
 */

export const DISABLEABLE_BRIDGES = Object.freeze(["cowart", "cowartDiscovery", "codex", "grok"]);
const DISABLEABLE_BRIDGE_SET = new Set(DISABLEABLE_BRIDGES);

/**
 * @param {{ explicit?: readonly unknown[] | null, env?: { GRAVITYPORT_DISABLE_BRIDGES?: string, MOSA_DISABLE_BRIDGES?: string } }} [options]
 * @returns {readonly DisableableBridge[]}
 */
export function parseDisabledBridges(options = {}) {
  const explicit = options && Object.prototype.hasOwnProperty.call(options, "explicit") ? options.explicit : undefined;
  let raw;
  if (explicit !== undefined && explicit !== null) {
    if (!Array.isArray(explicit)) {
      throw new TypeError(
        `disabledBridges must be an array of ${DISABLEABLE_BRIDGES.join(", ")}; got ${typeof explicit}.`,
      );
    }
    raw = explicit;
  } else {
    const envValue = readGravityPortEnv(options?.env, "GRAVITYPORT_DISABLE_BRIDGES") ?? "";
    if (typeof envValue !== "string") {
      throw new TypeError("GRAVITYPORT_DISABLE_BRIDGES must be a comma-separated string.");
    }
    raw = envValue.split(",");
  }
  const result = [];
  const seen = new Set();
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw new TypeError(
        `disabledBridges entries must be strings; got ${typeof entry} (${JSON.stringify(entry)}).`,
      );
    }
    const name = entry.trim();
    if (!name) continue;
    if (!DISABLEABLE_BRIDGE_SET.has(name)) {
      throw new Error(
        `Unknown bridge name "${name}". Disableable bridges: ${DISABLEABLE_BRIDGES.join(", ")}.`,
      );
    }
    if (!seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
  }
  return Object.freeze(result);
}
