// Task 470: local CI-like e2e mode configuration and desktop window bounds helper.
// Pure module (no Electron import) so unit tests, the e2e runner, the web
// driver, and CDP helpers all share the exact same rules.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CI_LIKE_ENV = "MOSA_E2E_CI_LIKE";
const CPU_THROTTLE_ENV = "MOSA_E2E_CPU_THROTTLE";
const REPEAT_ENV = "MOSA_E2E_REPEAT";
const ONLY_ENV = "MOSA_E2E_ONLY";
const DEFAULT_CPU_THROTTLE = 4;
const BUILTIN_FLOW_NAMES = Object.freeze(["web", "electron", "stack", "trash"]);

// Actual desktop BrowserWindow viewport observed on GitHub Actions windows-2022
// runners: PR #357 second Windows CI run (run 45419848205) reported
// `"viewport":[1008,689]` because the 1024x768 display clamps the default
// 1320x860 window.
export const CI_LIKE_DESKTOP_WINDOW = Object.freeze([1008, 689]);

let activeCiLikeFlow = {
  flowName: null,
  userDataDir: null,
  lastWindowBoundsDir: null,
};

function parseIntegerInRange(raw, name, min, max) {
  const text = String(raw);
  if (!/^\d+$/.test(text)) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got ${JSON.stringify(raw)}`);
  }
  const value = Number(text);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * Parse and validate CI-like e2e and repeat-run environment switches.
 *
 * - `MOSA_E2E_CI_LIKE=1` (exact string `"1"` only): enables 4x renderer CPU
 *   throttling and the 1008x689 Windows CI desktop window size (macOS only).
 * - `MOSA_E2E_CPU_THROTTLE=<1..20>`: overrides the CPU throttle multiplier.
 * - `MOSA_E2E_REPEAT=<2..20>`: repeats each selected plugin flow N times;
 *   requires `MOSA_E2E_ONLY` with plugin flow names only, and forbids `--shard`.
 */
export function ciLikeConfig(env = process.env, { platform = process.platform, shard = null } = {}) {
  const enabled = env?.[CI_LIKE_ENV] === "1";
  if (enabled && platform !== "darwin") {
    throw new Error(
      `${CI_LIKE_ENV}=1 is only supported on macOS (darwin) where outer window bounds match content viewport, got ${platform}`,
    );
  }

  const rawThrottle = env?.[CPU_THROTTLE_ENV];
  let cpuThrottle = enabled ? DEFAULT_CPU_THROTTLE : 1;
  if (rawThrottle !== undefined && String(rawThrottle) !== "") {
    const parsedThrottle = parseIntegerInRange(rawThrottle, CPU_THROTTLE_ENV, 1, 20);
    if (enabled) cpuThrottle = parsedThrottle;
  }

  const rawRepeat = env?.[REPEAT_ENV];
  let repeat = 1;
  if (rawRepeat !== undefined && String(rawRepeat) !== "") {
    repeat = parseIntegerInRange(rawRepeat, REPEAT_ENV, 2, 20);
    if (shard) {
      throw new Error(`${REPEAT_ENV} cannot be used together with --shard`);
    }
    const onlyNames = String(env?.[ONLY_ENV] || "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    if (!onlyNames.length) {
      throw new Error(`${REPEAT_ENV} requires ${ONLY_ENV} to specify one or more plugin flows`);
    }
    const builtins = onlyNames.filter((name) => BUILTIN_FLOW_NAMES.includes(name));
    if (builtins.length) {
      throw new Error(
        `${REPEAT_ENV} only supports plugin flows; built-in flow(s) are not supported: ${builtins.join(", ")}`,
      );
    }
  }

  return {
    enabled,
    cpuThrottle,
    desktopWindow: [...CI_LIKE_DESKTOP_WINDOW],
    repeat,
  };
}

/**
 * Write `<userDataDir>/window-bounds.json` with only `{ width, height }` matching
 * `CI_LIKE_DESKTOP_WINDOW` so Electron's `loadBounds()` opens the real desktop
 * shell at the Windows CI viewport size without touching product code.
 */
export function writeCiLikeWindowBounds(userDataDir) {
  if (typeof userDataDir !== "string" || !userDataDir.trim()) {
    throw new Error(`writeCiLikeWindowBounds requires a non-empty userDataDir, got ${JSON.stringify(userDataDir)}`);
  }
  mkdirSync(userDataDir, { recursive: true });
  const boundsPath = join(userDataDir, "window-bounds.json");
  const [width, height] = CI_LIKE_DESKTOP_WINDOW;
  writeFileSync(boundsPath, JSON.stringify({ width, height }), "utf8");
  activeCiLikeFlow.lastWindowBoundsDir = userDataDir;
  return boundsPath;
}

export function formatCiLikeBanner(config) {
  const [width, height] = config.desktopWindow;
  return `[e2e] CI-like: cpu x${config.cpuThrottle}, desktop window ${width}x${height} (windows-2022 runner), page-driver window unchanged (1280x800)`;
}

export function setActiveCiLikeFlow({ flowName = null, userDataDir = null } = {}) {
  activeCiLikeFlow = {
    flowName,
    userDataDir,
    lastWindowBoundsDir: null,
  };
}

export function clearActiveCiLikeFlow() {
  activeCiLikeFlow = {
    flowName: null,
    userDataDir: null,
    lastWindowBoundsDir: null,
  };
}

export function getActiveCiLikeFlow() {
  return {
    flowName: activeCiLikeFlow.flowName,
    userDataDir: activeCiLikeFlow.lastWindowBoundsDir || activeCiLikeFlow.userDataDir,
  };
}
