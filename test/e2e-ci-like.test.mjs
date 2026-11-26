// Task 470: unit tests for scripts/e2e-ci-like.mjs (real module import, no copies).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CI_LIKE_DESKTOP_WINDOW,
  ciLikeConfig,
  formatCiLikeBanner,
  writeCiLikeWindowBounds,
} from "../scripts/e2e-ci-like.mjs";

test("MOSA_E2E_CI_LIKE only recognizes exact string '1'", () => {
  for (const value of [undefined, "", "0", "true", "yes", " 1 ", "2"]) {
    const cfg = ciLikeConfig({ MOSA_E2E_CI_LIKE: value }, { platform: "darwin" });
    assert.deepEqual(cfg, {
      enabled: false,
      cpuThrottle: 1,
      desktopWindow: [1008, 689],
      repeat: 1,
    }, `${JSON.stringify(value)} must not enable CI-like mode`);
  }

  const enabled = ciLikeConfig({ MOSA_E2E_CI_LIKE: "1" }, { platform: "darwin" });
  assert.deepEqual(enabled, {
    enabled: true,
    cpuThrottle: 4,
    desktopWindow: [1008, 689],
    repeat: 1,
  });
  assert.equal(
    formatCiLikeBanner(enabled),
    "[e2e] CI-like: cpu x4, desktop window 1008x689 (windows-2022 runner), page-driver window unchanged (1280x800)",
  );
});

test("MOSA_E2E_CI_LIKE=1 rejects non-macOS platforms", () => {
  for (const platform of ["win32", "linux"]) {
    assert.throws(
      () => ciLikeConfig({ MOSA_E2E_CI_LIKE: "1" }, { platform }),
      /only supported on macOS/,
      `${platform} must be rejected`,
    );
  }
  // Disabled mode is allowed on any platform.
  assert.equal(ciLikeConfig({}, { platform: "win32" }).enabled, false);
  assert.equal(ciLikeConfig({}, { platform: "linux" }).enabled, false);
});

test("MOSA_E2E_CPU_THROTTLE validates integer range 1..20", () => {
  assert.equal(
    ciLikeConfig({ MOSA_E2E_CI_LIKE: "1", MOSA_E2E_CPU_THROTTLE: "1" }, { platform: "darwin" }).cpuThrottle,
    1,
  );
  assert.equal(
    ciLikeConfig({ MOSA_E2E_CI_LIKE: "1", MOSA_E2E_CPU_THROTTLE: "8" }, { platform: "darwin" }).cpuThrottle,
    8,
  );
  assert.equal(
    ciLikeConfig({ MOSA_E2E_CI_LIKE: "1", MOSA_E2E_CPU_THROTTLE: "20" }, { platform: "darwin" }).cpuThrottle,
    20,
  );
  for (const bad of ["0", "-1", "21", "4.5", "abc", " 4 "]) {
    assert.throws(
      () => ciLikeConfig({ MOSA_E2E_CI_LIKE: "1", MOSA_E2E_CPU_THROTTLE: bad }, { platform: "darwin" }),
      /MOSA_E2E_CPU_THROTTLE/,
      `${JSON.stringify(bad)} must be rejected`,
    );
  }
});

test("MOSA_E2E_REPEAT validates integer range 2..20 and pairing rules", () => {
  const plainRepeat = ciLikeConfig(
    { MOSA_E2E_REPEAT: "3", MOSA_E2E_ONLY: "learning-guide,settings-ai" },
    { platform: "darwin" },
  );
  assert.deepEqual(plainRepeat, {
    enabled: false,
    cpuThrottle: 1,
    desktopWindow: [1008, 689],
    repeat: 3,
  });

  assert.equal(
    ciLikeConfig(
      { MOSA_E2E_CI_LIKE: "1", MOSA_E2E_REPEAT: "2", MOSA_E2E_ONLY: "e2e-cdp-tools" },
      { platform: "darwin" },
    ).repeat,
    2,
  );
  assert.equal(
    ciLikeConfig(
      { MOSA_E2E_REPEAT: "20", MOSA_E2E_ONLY: "e2e-cdp-tools" },
      { platform: "darwin" },
    ).repeat,
    20,
  );

  for (const bad of ["0", "1", "-2", "21", "3.5", "abc"]) {
    assert.throws(
      () => ciLikeConfig({ MOSA_E2E_REPEAT: bad, MOSA_E2E_ONLY: "learning-guide" }, { platform: "darwin" }),
      /MOSA_E2E_REPEAT/,
      `repeat=${JSON.stringify(bad)} must be rejected`,
    );
  }

  // Missing or blank MOSA_E2E_ONLY -> throws.
  assert.throws(
    () => ciLikeConfig({ MOSA_E2E_REPEAT: "3" }, { platform: "darwin" }),
    /MOSA_E2E_ONLY/,
  );
  assert.throws(
    () => ciLikeConfig({ MOSA_E2E_REPEAT: "3", MOSA_E2E_ONLY: " , " }, { platform: "darwin" }),
    /MOSA_E2E_ONLY/,
  );

  // Built-in flow names (solo or mixed) -> throws.
  for (const builtin of ["web", "electron", "stack", "trash"]) {
    assert.throws(
      () => ciLikeConfig({ MOSA_E2E_REPEAT: "3", MOSA_E2E_ONLY: builtin }, { platform: "darwin" }),
      /built-in flow/,
      `built-in ${builtin} must be rejected`,
    );
    assert.throws(
      () => ciLikeConfig({ MOSA_E2E_REPEAT: "3", MOSA_E2E_ONLY: `learning-guide,${builtin}` }, { platform: "darwin" }),
      /built-in flow/,
      `mixed list containing ${builtin} must be rejected`,
    );
  }

  // Combined with --shard -> throws.
  assert.throws(
    () => ciLikeConfig(
      { MOSA_E2E_REPEAT: "3", MOSA_E2E_ONLY: "learning-guide" },
      { platform: "darwin", shard: { k: 1, n: 2 } },
    ),
    /--shard/,
  );
});

test("writeCiLikeWindowBounds writes exact {width:1008,height:689} within desktop minimum bounds", () => {
  const dir = mkdtempSync(join(tmpdir(), "mosa-470-bounds-"));
  try {
    const filePath = writeCiLikeWindowBounds(dir);
    assert.equal(filePath, join(dir, "window-bounds.json"));
    const raw = readFileSync(filePath, "utf8");
    assert.equal(raw, '{"width":1008,"height":689}');
    const parsed = JSON.parse(raw);
    assert.deepEqual(Object.keys(parsed), ["width", "height"]);
    assert.deepEqual([parsed.width, parsed.height], [...CI_LIKE_DESKTOP_WINDOW]);
    // Minimum desktop window dimensions enforced by loadBounds() in
    // desktop/window-menu.mjs lines 39-40 (width >= 960, height >= 640).
    assert.ok(parsed.width >= 960, `width ${parsed.width} must be >= 960 (desktop/window-menu.mjs:39)`);
    assert.ok(parsed.height >= 640, `height ${parsed.height} must be >= 640 (desktop/window-menu.mjs:40)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
