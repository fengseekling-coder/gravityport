// gravityport-lifecycle.test.mjs — unit tests for app-lifecycle.ts pure functions.
// The module ships as TypeScript inside web/gravityport, so it is compiled to a
// temp directory with tsc before import (same approach as gravityport-interaction.test.mjs).
import { execFileSync } from "node:child_process";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");

let lifecycle;
let tempRoot;

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "mosa-gp-lifecycle-"));
  const sources = [join(uiRoot, "src", "app-lifecycle.ts")];
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    ...sources,
    "--outDir", tempRoot,
    "--module", "esnext",
    "--target", "es2022",
    "--moduleResolution", "bundler",
    "--skipLibCheck",
  ], { stdio: "pipe" });
  lifecycle = await import(join(tempRoot, "app-lifecycle.js"));
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

describe("buildUpdateText", () => {
  let buildUpdateText;

  before(() => {
    ({ buildUpdateText } = lifecycle);
  });

  const t = (key, params = {}) => {
    const map = {
      "versionUnknown": "Version unknown",
      "upToDate": "You're up to date",
      "updateCheckFailed": "Cannot check for updates",
      "updateInstallLocationUnsupported": "Drag to Applications",
      "updateAvailable": "Can update to v{version}",
      "updatePublished": "Released on {date}",
      "checkForUpdates": "Check for updates",
      "checkingForUpdates": "Checking…",
      "downloadAndInstall": "Download and update",
      "downloadLatest": "Go to website",
      "downloadingUpdate": "Downloading {percent}%",
      "cancelUpdateDownload": "Cancel download",
    };
    let text = map[key] || key;
    for (const [k, v] of Object.entries(params)) text = text.replaceAll(`{${k}}`, String(v));
    return text;
  };

  it("idle phase → check-for-updates button", () => {
    const result = buildUpdateText("1.2.3", { phase: "idle" }, 0, t);
    assert.equal(result.badgeText, "v1.2.3");
    assert.equal(result.buttonLabel, "Check for updates");
    assert.equal(result.buttonDisabled, false);
    assert.equal(result.downloadAndInstall, false);
  });

  it("checking phase → disabled button with checking label", () => {
    const result = buildUpdateText("1.2.3", { phase: "checking" }, 0, t);
    assert.equal(result.badgeText, "v1.2.3");
    assert.equal(result.buttonLabel, "Checking…");
    assert.equal(result.buttonDisabled, true);
  });

  it("current phase → up-to-date badge and check button", () => {
    const result = buildUpdateText("1.2.3", { phase: "current" }, 0, t);
    assert.equal(result.badgeText, "v1.2.3 · You're up to date");
    assert.equal(result.buttonLabel, "Check for updates");
    assert.equal(result.buttonDisabled, false);
  });

  it("available + canInstallInApp → download-and-install button", () => {
    const result = buildUpdateText("1.2.3", { phase: "available", latestVersion: "1.2.4", publishedAt: "2025-01-15", canInstallInApp: true }, 0, t);
    assert.ok(result.badgeText.includes("Can update to v1.2.4"));
    assert.ok(result.badgeText.includes("Released on 2025-01-15"));
    assert.equal(result.buttonLabel, "Download and update");
    assert.equal(result.downloadAndInstall, true);
  });

  it("available + !canInstallInApp → external download button", () => {
    const result = buildUpdateText("1.2.3", { phase: "available", latestVersion: "1.2.4", publishedAt: "", canInstallInApp: false }, 0, t);
    assert.equal(result.buttonLabel, "Go to website");
    assert.equal(result.downloadAndInstall, false);
  });

  it("downloading phase → cancel button with percent", () => {
    const result = buildUpdateText("1.2.3", { phase: "downloading" }, 67, t);
    assert.equal(result.buttonLabel, "Downloading 67% · Cancel download");
    assert.equal(result.buttonDisabled, false);
  });

  it("unavailable phase → no button, install-location message", () => {
    const result = buildUpdateText("1.2.3", { phase: "unavailable", reason: "install-location-unsupported" }, 0, t);
    assert.equal(result.badgeText, "v1.2.3 · Drag to Applications");
    assert.equal(result.buttonLabel, null);
  });

  it("error phase → check button and error badge", () => {
    const result = buildUpdateText("1.2.3", { phase: "error" }, 0, t);
    assert.equal(result.badgeText, "v1.2.3 · Cannot check for updates");
    assert.equal(result.buttonLabel, "Check for updates");
  });

  it("no current version → version unknown badge", () => {
    const result = buildUpdateText("", { phase: "idle" }, 0, t);
    assert.equal(result.badgeText, "Version unknown");
  });
});

// ---------------------------------------------------------------------------
// 24-hour interval
// ---------------------------------------------------------------------------

describe("shouldAutoCheckForUpdates", () => {
  let shouldAutoCheckForUpdates;

  before(() => {
    ({ shouldAutoCheckForUpdates } = lifecycle);
  });

  it("returns true when nothing is stored", () => {
    assert.equal(shouldAutoCheckForUpdates(() => null), true);
  });

  it("returns true when the stored value is zero", () => {
    assert.equal(shouldAutoCheckForUpdates(() => "0"), true);
  });

  it("returns true when more than 24 hours have passed", () => {
    const yesterday = String(Date.now() - (25 * 60 * 60 * 1000));
    assert.equal(shouldAutoCheckForUpdates(() => yesterday), true);
  });

  it("returns false when less than 24 hours have passed", () => {
    const recent = String(Date.now() - (1 * 60 * 60 * 1000));
    assert.equal(shouldAutoCheckForUpdates(() => recent), false);
  });

  it("returns true when stored value is not a number", () => {
    assert.equal(shouldAutoCheckForUpdates(() => "not-a-timestamp"), true);
  });
});

describe("recordUpdateCheck", () => {
  let recordUpdateCheck;

  before(() => {
    ({ recordUpdateCheck } = lifecycle);
  });

  it("stores the current timestamp under the correct key", () => {
    const stored = {};
    recordUpdateCheck((key, value) => { stored[key] = value; });
    const saved = Number(stored["mosa.update-last-checked"]);
    assert.ok(Math.abs(saved - Date.now()) < 5000);
  });
});
