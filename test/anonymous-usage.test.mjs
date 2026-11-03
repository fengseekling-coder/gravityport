import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ANONYMOUS_USAGE_PROFILE_SCHEMA_VERSION,
  ANONYMOUS_USAGE_PROFILE_FILE,
  ANONYMOUS_USAGE_TELEMETRY_VERSION,
  ensureInstallationId,
  prepareAnonymousUsage,
} from "../desktop/anonymous-usage.mjs";

const FIXED_ID = "123e4567-e89b-42d3-a456-426614174000";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("anonymous usage creates one random install id and reports first launch once", () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "mosa-usage-"));
  const now = Date.parse("2026-08-28T12:00:00Z");
  const prepared = prepareAnonymousUsage({
    userDataDir,
    now,
    platform: "darwin",
    arch: "arm64",
    currentVersion: "0.2.0",
    makeInstallationId: () => FIXED_ID,
  });

  assert.deepEqual(prepared.telemetry, {
    event: "first_launch",
    telemetryVersion: ANONYMOUS_USAGE_TELEMETRY_VERSION,
    installationId: FIXED_ID,
    platform: "macos",
    arch: "arm64",
    version: "0.2.0",
  });
  assert.equal(prepared.commit(), true);

  const profile = JSON.parse(readFileSync(join(userDataDir, ANONYMOUS_USAGE_PROFILE_FILE), "utf8"));
  assert.equal(profile.installationId, FIXED_ID);
  assert.equal(profile.schemaVersion, ANONYMOUS_USAGE_PROFILE_SCHEMA_VERSION);
  assert.equal(profile.firstReportedAt, now);
  assert.equal(profile.lastReportedAt, now);
  assert.equal(profile.lastReportedDay, "2026-08-28");

  const sameDay = prepareAnonymousUsage({ userDataDir, now: now + 60_000, currentVersion: "0.2.0" });
  assert.equal(sameDay.telemetry, null, "manual update checks must not multiply daily-active pings");
});

test("anonymous usage reports once per analytics day and can be disabled", () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "mosa-usage-"));
  const now = Date.parse("2026-08-28T06:55:00Z");
  const first = prepareAnonymousUsage({ userDataDir, now, currentVersion: "0.2.0", makeInstallationId: () => FIXED_ID });
  first.commit();

  const next = prepareAnonymousUsage({
    userDataDir,
    now: Date.parse("2026-08-28T07:05:00Z"),
    platform: "win32",
    arch: "x64",
    currentVersion: "0.2.1",
  });
  assert.equal(next.telemetry.event, "daily_active");
  assert.equal(next.telemetry.installationId, FIXED_ID);
  assert.equal(next.telemetry.platform, "windows");
  assert.equal(next.telemetry.version, "0.2.1");

  next.commit();
  const sameAnalyticsDay = prepareAnonymousUsage({ userDataDir, now: Date.parse("2026-08-29T06:59:00Z"), currentVersion: "0.2.1" });
  assert.equal(sameAnalyticsDay.telemetry, null);

  const disabled = prepareAnonymousUsage({ userDataDir, enabled: false, now: Date.parse("2026-08-29T07:05:00Z") });
  assert.equal(disabled.telemetry, null);
});

test("ensureInstallationId mints a valid UUID, persists it, and reuses it", () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "mosa-usage-"));
  const first = ensureInstallationId({ userDataDir });
  assert.match(first, UUID_PATTERN);

  const profile = JSON.parse(readFileSync(join(userDataDir, ANONYMOUS_USAGE_PROFILE_FILE), "utf8"));
  assert.equal(profile.installationId, first);
  assert.equal(profile.schemaVersion, ANONYMOUS_USAGE_PROFILE_SCHEMA_VERSION);
  assert.equal(profile.firstReportedAt, 0);
  assert.equal(profile.lastReportedAt, 0);
  assert.equal(profile.lastReportedDay, "");

  assert.equal(ensureInstallationId({ userDataDir }), first, "a second call must return the stored id");
});

test("ensureInstallationId keeps an existing legacy profile untouched", () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "mosa-usage-"));
  const legacyProfile = {
    schemaVersion: 1,
    installationId: FIXED_ID,
    firstReportedAt: 111,
    lastReportedAt: 222,
  };
  const profileFile = join(userDataDir, ANONYMOUS_USAGE_PROFILE_FILE);
  const legacyContent = `${JSON.stringify(legacyProfile, null, 2)}\n`;
  writeFileSync(profileFile, legacyContent, "utf8");

  assert.equal(ensureInstallationId({ userDataDir }), FIXED_ID);
  assert.equal(readFileSync(profileFile, "utf8"), legacyContent, "an existing profile must not be rewritten");
});

test("ensureInstallationId returns an empty string instead of throwing when userData cannot be written", () => {
  const parent = mkdtempSync(join(tmpdir(), "mosa-usage-"));
  const notADirectory = join(parent, "blocker");
  writeFileSync(notADirectory, "a file, not a directory", "utf8");
  assert.equal(ensureInstallationId({ userDataDir: notADirectory }), "");
  assert.equal(ensureInstallationId({ userDataDir: "" }), "");
});

test("prepareAnonymousUsage reuses the minted id and still reports first_launch once", () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "mosa-usage-"));
  const now = Date.parse("2026-08-28T12:00:00Z");
  const installationId = ensureInstallationId({ userDataDir });
  assert.match(installationId, UUID_PATTERN);

  const prepared = prepareAnonymousUsage({ userDataDir, now, currentVersion: "0.2.0" });
  assert.equal(prepared.telemetry.event, "first_launch");
  assert.equal(prepared.telemetry.installationId, installationId);
  assert.equal(prepared.commit(), true);

  const profile = JSON.parse(readFileSync(join(userDataDir, ANONYMOUS_USAGE_PROFILE_FILE), "utf8"));
  assert.equal(profile.installationId, installationId);
  assert.equal(profile.firstReportedAt, now, "the pre-minted profile must still report first_launch exactly once");
});
