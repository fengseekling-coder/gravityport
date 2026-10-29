// gravityport-lifecycle.test.mjs — unit tests for app-lifecycle.ts pure functions.
// The module ships as TypeScript inside web/gravityport, so it is compiled to a
// temp directory with tsc before import (same approach as gravityport-interaction.test.mjs).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");

let lifecycle;
let translate;
let tempRoot;

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "mosa-gp-lifecycle-"));
  const sources = [join(uiRoot, "src", "app-lifecycle.ts"), join(uiRoot, "src", "i18n.ts")];
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    ...sources,
    "--outDir", tempRoot,
    "--module", "esnext",
    "--target", "es2022",
    "--moduleResolution", "bundler",
    "--skipLibCheck",
  ], { stdio: "pipe" });
  lifecycle = await import(join(tempRoot, "app-lifecycle.js"));
  ({ translate } = await import(join(tempRoot, "i18n.js")));
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Version consistency check
// ---------------------------------------------------------------------------

describe("checkVersionConsistency", () => {
  let checkVersionConsistency;

  before(() => {
    ({ checkVersionConsistency } = lifecycle);
  });

  const noopFetch = () => Promise.reject(new Error("not called"));

  it("returns null when all three fields match", async () => {
    const result = await checkVersionConsistency(
      () => Promise.resolve({ productVersion: "1.2.3", uiFingerprint: "abc", runtimeFingerprint: "xyz" }),
      () => Promise.resolve({ productVersion: "1.2.3", uiFingerprint: "abc", runtimeFingerprint: "xyz" }),
    );
    assert.equal(result, null);
  });

  it("returns null when runtime is missing (empty fetch)", async () => {
    const result = await checkVersionConsistency(
      () => Promise.resolve({}),
      () => Promise.resolve({ productVersion: "1.2.3" }),
    );
    assert.equal(result, null);
  });

  it("returns null when ui is missing (empty fetch)", async () => {
    const result = await checkVersionConsistency(
      () => Promise.resolve({ productVersion: "1.2.3" }),
      () => Promise.resolve({}),
    );
    assert.equal(result, null);
  });

  it("returns null when a field is 'unknown' on the runtime side", async () => {
    const result = await checkVersionConsistency(
      () => Promise.resolve({ productVersion: "unknown", runtimeFingerprint: "xyz" }),
      () => Promise.resolve({ productVersion: "1.2.3", runtimeFingerprint: "xyz" }),
    );
    assert.equal(result, null);
  });

  it("returns null when a field is 'unknown' on the ui side", async () => {
    const result = await checkVersionConsistency(
      () => Promise.resolve({ productVersion: "1.2.3", runtimeFingerprint: "xyz" }),
      () => Promise.resolve({ productVersion: "unknown", runtimeFingerprint: "xyz" }),
    );
    assert.equal(result, null);
  });

  it("returns null when a field is empty on the runtime side", async () => {
    const result = await checkVersionConsistency(
      () => Promise.resolve({ productVersion: "", runtimeFingerprint: "xyz" }),
      () => Promise.resolve({ productVersion: "1.2.3", runtimeFingerprint: "xyz" }),
    );
    assert.equal(result, null);
  });

  it("returns Error when productVersion differs", async () => {
    const result = await checkVersionConsistency(
      () => Promise.resolve({ productVersion: "1.2.3", uiFingerprint: "abc", runtimeFingerprint: "xyz" }),
      () => Promise.resolve({ productVersion: "1.2.4", uiFingerprint: "abc", runtimeFingerprint: "xyz" }),
    );
    assert.ok(result instanceof Error);
    assert.equal(result.code, "MOSA_RUNTIME_BUILD_MISMATCH");
  });

  it("returns Error when uiFingerprint differs", async () => {
    const result = await checkVersionConsistency(
      () => Promise.resolve({ productVersion: "1.2.3", uiFingerprint: "abc", runtimeFingerprint: "xyz" }),
      () => Promise.resolve({ productVersion: "1.2.3", uiFingerprint: "different", runtimeFingerprint: "xyz" }),
    );
    assert.ok(result instanceof Error);
    assert.equal(result.code, "MOSA_RUNTIME_BUILD_MISMATCH");
  });

  it("returns Error when runtimeFingerprint differs", async () => {
    const result = await checkVersionConsistency(
      () => Promise.resolve({ productVersion: "1.2.3", uiFingerprint: "abc", runtimeFingerprint: "xyz" }),
      () => Promise.resolve({ productVersion: "1.2.3", uiFingerprint: "abc", runtimeFingerprint: "different" }),
    );
    assert.ok(result instanceof Error);
    assert.equal(result.code, "MOSA_RUNTIME_BUILD_MISMATCH");
  });

  it("returns Error when any one field differs (not all three)", async () => {
    const result = await checkVersionConsistency(
      () => Promise.resolve({ productVersion: "1.2.3", uiFingerprint: "abc", runtimeFingerprint: "xyz" }),
      () => Promise.resolve({ productVersion: "1.2.3", uiFingerprint: "abc", runtimeFingerprint: "different" }),
    );
    assert.ok(result instanceof Error);
  });

  it("tolerates fetch errors gracefully", async () => {
    const result = await checkVersionConsistency(
      () => Promise.reject(new Error("network error")),
      () => Promise.resolve({ productVersion: "1.2.3" }),
    );
    assert.equal(result, null, "silently skips on fetch error");
  });
});

// ---------------------------------------------------------------------------
// Update result mapping
// ---------------------------------------------------------------------------

describe("mapUpdateResult", () => {
  let mapUpdateResult;

  before(() => {
    ({ mapUpdateResult } = lifecycle);
  });

  it('status: ok, updateAvailable: true → available state', () => {
    const state = mapUpdateResult({ status: "ok", updateAvailable: true, latestVersion: "v1.2.4", publishedAt: "2025-01-15", canInstallInApp: true });
    assert.equal(state.phase, "available");
    assert.equal(state.latestVersion, "1.2.4");
    assert.equal(state.publishedAt, "2025-01-15");
    assert.equal(state.canInstallInApp, true);
  });

  it('status: ok, updateAvailable: true, canInstallInApp: false → available state', () => {
    const state = mapUpdateResult({ status: "ok", updateAvailable: true, latestVersion: "v1.2.4", canInstallInApp: false });
    assert.equal(state.phase, "available");
    assert.equal(state.canInstallInApp, false);
  });

  it('status: ok, updateAvailable: false → current state', () => {
    const state = mapUpdateResult({ status: "ok", updateAvailable: false });
    assert.equal(state.phase, "current");
  });

  it('status: disabled → disabled state', () => {
    const state = mapUpdateResult({ status: "disabled" });
    assert.equal(state.phase, "disabled");
  });

  it('status: unavailable, reason: install-location-unsupported → unavailable state', () => {
    const state = mapUpdateResult({ status: "unavailable", reason: "install-location-unsupported" });
    assert.equal(state.phase, "unavailable");
    assert.equal(state.reason, "install-location-unsupported");
  });

  it('status: unavailable, other reason → error state', () => {
    const state = mapUpdateResult({ status: "unavailable" });
    assert.equal(state.phase, "error");
  });

  it('throws → error state', () => {
    const fakeResult = undefined;
    const state = mapUpdateResult(fakeResult ?? {});
    assert.equal(state.phase, "error");
  });
});

describe("installResultFeedback", () => {
  let installResultFeedback;

  before(() => {
    ({ installResultFeedback } = lifecycle);
  });

  it('status: installing → installing, phase stays available, no toast', () => {
    assert.deepEqual(installResultFeedback({ status: "installing" }), { installing: true, nextPhase: "available", toast: null });
  });

  it('status: cancelled → back to available, no toast', () => {
    assert.deepEqual(installResultFeedback({ status: "cancelled" }), { installing: false, nextPhase: "available", toast: null });
  });

  it('error PREFLIGHT_DISK_SPACE → back to available, no toast (dialog already shown)', () => {
    assert.deepEqual(installResultFeedback({ status: "error", code: "PREFLIGHT_DISK_SPACE" }), { installing: false, nextPhase: "available", toast: null });
  });

  it('error PREFLIGHT_INSTALL_DIR_NOT_WRITABLE → back to available, no toast (dialog already shown)', () => {
    assert.deepEqual(installResultFeedback({ status: "error", code: "PREFLIGHT_INSTALL_DIR_NOT_WRITABLE" }), { installing: false, nextPhase: "available", toast: null });
  });

  it('error UPDATE_FAILED_TWICE → back to available, no toast (dialog already shown)', () => {
    assert.deepEqual(installResultFeedback({ status: "error", code: "UPDATE_FAILED_TWICE" }), { installing: false, nextPhase: "available", toast: null });
  });

  it('status: current → current phase with the current toast', () => {
    assert.deepEqual(installResultFeedback({ status: "current" }), { installing: false, nextPhase: "current", toast: "current" });
  });

  it('status: unavailable, reason: install-location-unsupported → unavailable phase with the move-to-applications toast', () => {
    assert.deepEqual(installResultFeedback({ status: "unavailable", reason: "install-location-unsupported" }), { installing: false, nextPhase: "unavailable", toast: "move-to-applications" });
  });

  it('status: unavailable without a reason → back to available with the failed toast', () => {
    assert.deepEqual(installResultFeedback({ status: "unavailable" }), { installing: false, nextPhase: "available", toast: "failed" });
  });

  it('error MACOS_UPDATE_FAILED → back to available with the failed toast', () => {
    assert.deepEqual(installResultFeedback({ status: "error", code: "MACOS_UPDATE_FAILED" }), { installing: false, nextPhase: "available", toast: "failed" });
  });

  it('error WINDOWS_UPDATE_FAILED → back to available with the failed toast', () => {
    assert.deepEqual(installResultFeedback({ status: "error", code: "WINDOWS_UPDATE_FAILED" }), { installing: false, nextPhase: "available", toast: "failed" });
  });

  it('status: unsupported → back to available with the failed toast', () => {
    assert.deepEqual(installResultFeedback({ status: "unsupported", reason: "release-manifest-untrusted" }), { installing: false, nextPhase: "available", toast: "failed" });
  });

  it('unknown status / null / undefined → back to available with the failed toast', () => {
    assert.deepEqual(installResultFeedback({ status: "something-new" }), { installing: false, nextPhase: "available", toast: "failed" });
    assert.deepEqual(installResultFeedback(null), { installing: false, nextPhase: "available", toast: "failed" });
    assert.deepEqual(installResultFeedback(undefined), { installing: false, nextPhase: "available", toast: "failed" });
  });

  // Contract: every preflight/failed-twice code the main process can return has
  // already raised its own system dialog, so the renderer must stay quiet for
  // each of them — and only for them (the two generic failure codes keep the
  // toast). Reads desktop/main.mjs source text (read-only) so a future preflight
  // code added there without updating the mapping is caught here.
  it('every dialog-already-shown code in desktop/main.mjs maps to toast: null', () => {
    const source = readFileSync(join(repositoryRoot, "desktop", "main.mjs"), "utf8");
    const codes = [...new Set([...source.matchAll(/code: "((?:PREFLIGHT_[A-Z_]+)|UPDATE_FAILED_TWICE)"/g)].map((match) => match[1]))];
    assert.ok(codes.length >= 3, `expected at least 3 dialog-already-shown codes in desktop/main.mjs, got ${JSON.stringify(codes)}`);
    for (const code of codes) {
      assert.equal(installResultFeedback({ status: "error", code }).toast, null, `code ${code} must not add a renderer toast`);
    }
    assert.equal(installResultFeedback({ status: "error", code: "MACOS_UPDATE_FAILED" }).toast, "failed");
    assert.equal(installResultFeedback({ status: "error", code: "WINDOWS_UPDATE_FAILED" }).toast, "failed");
  });
});

describe("buildUpdateText", () => {
  let buildUpdateText;

  before(() => {
    ({ buildUpdateText } = lifecycle);
  });

  const zh = text => translate(text, "zh");
  const en = text => translate(text, "en");

  it("renders translated text without raw keys or placeholders", () => {
    const states = [
      buildUpdateText("1.2.3", { phase: "idle" }, 0, zh),
      buildUpdateText("1.2.3", { phase: "checking" }, 0, en),
      buildUpdateText("1.2.3", { phase: "current" }, 0, en),
      buildUpdateText("1.2.3", { phase: "available", latestVersion: "1.2.4", publishedAt: "2025-01-15", canInstallInApp: true }, 0, en),
      buildUpdateText("1.2.3", { phase: "downloading", percent: 67 }, 67, zh),
      buildUpdateText("1.2.3", { phase: "unavailable", reason: "install-location-unsupported" }, 0, en),
      buildUpdateText("1.2.3", { phase: "error" }, 0, zh),
    ];
    for (const state of states) {
      const text = `${state.badgeText} ${state.buttonLabel || ""} ${state.secondaryLabel || ""}`;
      assert.doesNotMatch(text, /\{[^}]+\}/);
      assert.doesNotMatch(text, /[a-z][A-Z][a-zA-Z]+/);
    }
  });

  it("formats the update summary and actions", () => {
    const result = buildUpdateText("1.2.3", { phase: "available", latestVersion: "1.2.4", publishedAt: "2025-01-15T12:00:00Z", canInstallInApp: true }, 0, zh);
    assert.match(result.badgeText, /v1\.2\.3 · 可更新至 v1\.2\.4 · 发布于 2025年1月15日/);
    const english = buildUpdateText("1.2.3", { phase: "available", latestVersion: "1.2.4", publishedAt: "2025-01-15T12:00:00Z", canInstallInApp: true }, 0, en, "en");
    assert.match(english.badgeText, /Jan 15, 2025/);
    assert.equal(result.buttonLabel, "下载并更新");
    assert.equal(result.downloadAndInstall, true);
    const downloading = buildUpdateText("1.2.3", { phase: "downloading", percent: 67 }, 67, en);
    assert.equal(downloading.buttonLabel, "Downloading 67%");
    assert.equal(downloading.secondaryLabel, "Cancel download");
    assert.equal(downloading.buttonDisabled, true);
  });

  it("maps current, unavailable, error and unknown version text", () => {
    assert.equal(buildUpdateText("1.2.3", { phase: "current" }, 0, zh).badgeText, "v1.2.3 · 已是最新版本");
    assert.match(buildUpdateText("1.2.3", { phase: "unavailable", reason: "install-location-unsupported" }, 0, zh).badgeText, /拖进/);
    assert.equal(buildUpdateText("1.2.3", { phase: "error" }, 0, zh).buttonLabel, "检查更新");
    assert.equal(buildUpdateText("", { phase: "idle" }, 0, en).badgeText, "Version information unavailable");
  });
});

describe("createReadyGate", () => {
  it("fires once when all three signals arrive in any order", () => {
    let calls = 0;
    const gate = lifecycle.createReadyGate(() => { calls += 1; });
    gate.markSseOpen();
    gate.markVersionOk();
    assert.equal(calls, 0);
    gate.markFirstPageOk();
    gate.markVersionOk();
    gate.markSseOpen();
    assert.equal(calls, 1);
  });

  it("does not fire when a condition is missing", () => {
    let calls = 0;
    const gate = lifecycle.createReadyGate(() => { calls += 1; });
    gate.markVersionOk();
    gate.markFirstPageOk();
    assert.equal(calls, 0);
  });

  it("does not fire when version consistency never passes", () => {
    let calls = 0;
    const gate = lifecycle.createReadyGate(() => { calls += 1; });
    gate.markFirstPageOk();
    gate.markSseOpen();
    assert.equal(calls, 0);
  });
});

describe("fill", () => {
  it("fills any named placeholder present in the values, including {count}", () => {
    assert.equal(lifecycle.fill("已选 {count} 项", { count: 3 }), "已选 3 项");
    assert.equal(lifecycle.fill("正在导入 {completed}/{total}", { completed: 2, total: 40 }), "正在导入 2/40");
    assert.equal(lifecycle.fill("可更新至 v{version}", { version: "1.2.3" }), "可更新至 v1.2.3");
  });

  it("fills a zero value and repeated placeholders", () => {
    assert.equal(lifecycle.fill("{count} / {count}", { count: 0 }), "0 / 0");
  });

  it("leaves placeholders without a value visible", () => {
    assert.equal(lifecycle.fill("{count} 天后删除", {}), "{count} 天后删除");
  });
});
