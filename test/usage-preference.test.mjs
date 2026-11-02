import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readUsagePreference, writeUsagePreference, usageReportAllowed } from "../desktop/usage-preference.mjs";

const defaultPreference = { enabled: true, noticeAcknowledgedAt: null };
const directory = () => mkdtempSync(join(tmpdir(), "mosa-usage-preference-"));

test("missing preference defaults to enabled but unacknowledged", () => {
  assert.deepEqual(readUsagePreference(directory()), defaultPreference);
});

test("malformed preference is not overwritten", () => {
  const dir = directory();
  const path = join(dir, "usage-preference.json");
  writeFileSync(path, "not json");
  assert.deepEqual(readUsagePreference(dir), defaultPreference);
  assert.equal(readFileSync(path, "utf8"), "not json");
});

test("preference writes atomically with private permissions", () => {
  const dir = directory();
  const preference = { enabled: false, noticeAcknowledgedAt: 1730000000000 };
  writeUsagePreference(dir, preference);
  assert.deepEqual(readUsagePreference(dir), preference);
  if (process.platform !== "win32") {
    assert.equal(statSync(join(dir, "usage-preference.json")).mode & 0o777, 0o600);
  }
});

test("preference does not modify installation ID profile", () => {
  const dir = directory();
  const profilePath = join(dir, "anonymous-usage.json");
  const original = '{"installationId":"not-an-actual-id","firstReportedAt":0}\n';
  writeFileSync(profilePath, original);
  writeUsagePreference(dir, { enabled: false, noticeAcknowledgedAt: 1730000000000 });
  assert.equal(readFileSync(profilePath, "utf8"), original);
});

test("usageReportAllowed requires environment, preference and acknowledgement", () => {
  const examples = [
    [{ envDisabled: true, preference: { enabled: true, noticeAcknowledgedAt: 1 } }, false],
    [{ envDisabled: false, preference: { enabled: false, noticeAcknowledgedAt: 1 } }, false],
    [{ envDisabled: false, preference: { enabled: true, noticeAcknowledgedAt: null } }, false],
    [{ envDisabled: false, preference: { enabled: true, noticeAcknowledgedAt: 1 } }, true],
  ];
  for (const [input, expected] of examples) assert.equal(usageReportAllowed(input), expected);
});
