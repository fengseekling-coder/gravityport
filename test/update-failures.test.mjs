import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  failureCodeFromLog,
  failureCountFor,
  failureRecordFor,
  recordUpdateAttempt,
  settleUpdateAttempt,
} from "../desktop/update-failures.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

const FAILED_VERSION = "0.3.8";
const OLD_VERSION = "0.3.7";
const NOW = Date.parse("2026-10-29T12:00:00.000Z");

async function userDataWithTempDir(t) {
  const userDataDir = await mkdtemp(join(tmpdir(), "mosa-update-failures-"));
  t.after(() => removeTestPath(userDataDir, { recursive: true, force: true }));
  return userDataDir;
}

async function startAttempt(userDataDir, { version = FAILED_VERSION, platform = "macos" } = {}) {
  assert.equal(await recordUpdateAttempt({ userDataDir, version, platform, now: NOW }), true);
}

async function writeHelperLog(userDataDir, { version = FAILED_VERSION, platform = "macos", text }) {
  const dir = join(userDataDir, "updates", platform, version);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "apply-update-error.log"), text, "utf8");
}

test("a failed install is counted once with the helper's reason code, and its log and attempt are removed", async (t) => {
  const userDataDir = await userDataWithTempDir(t);
  await startAttempt(userDataDir);
  await writeHelperLog(userDataDir, { text: "GP_UPDATE_FAILURE code=INSTALL_DIR_BUSY exit=1\nmacOS update helper failed (exit 1)\n" });

  const failure = await settleUpdateAttempt({ userDataDir, currentVersion: OLD_VERSION, now: NOW });
  assert.deepEqual(failure, { version: FAILED_VERSION, count: 1, code: "INSTALL_DIR_BUSY" });
  assert.equal(existsSync(join(userDataDir, "updates", "update-attempt.json")), false);
  assert.equal(existsSync(join(userDataDir, "updates", "macos", FAILED_VERSION, "apply-update-error.log")), false);
  assert.equal(failureCountFor({ userDataDir, version: FAILED_VERSION }), 1);
});

test("the second failure of the same version counts to two, and only codes and times are stored", async (t) => {
  const userDataDir = await userDataWithTempDir(t);
  const secretPath = "/Users/example-person/Library/Application Support/mosa/private-folder";
  await startAttempt(userDataDir);
  await writeHelperLog(userDataDir, { text: `GP_UPDATE_FAILURE code=VERIFY_FAILED exit=1\n${secretPath}\n` });
  await settleUpdateAttempt({ userDataDir, currentVersion: OLD_VERSION, now: NOW });

  await startAttempt(userDataDir);
  await writeHelperLog(userDataDir, { text: `GP_UPDATE_FAILURE code=REPLACE_FAILED exit=1\n${secretPath}\n` });
  const second = await settleUpdateAttempt({ userDataDir, currentVersion: OLD_VERSION, now: NOW + 1000 });
  assert.deepEqual(second, { version: FAILED_VERSION, count: 2, code: "REPLACE_FAILED" });
  assert.equal(failureRecordFor({ userDataDir, version: FAILED_VERSION }).lastCode, "REPLACE_FAILED");

  const stored = await readFile(join(userDataDir, "updates", "update-failures.json"), "utf8");
  assert.equal(stored.includes(secretPath), false, "the log text, with user paths, is never stored");
  assert.equal(stored.includes("example-person"), false);
});

test("running the recorded version or newer clears its failure count and removes the attempt", async (t) => {
  const userDataDir = await userDataWithTempDir(t);
  await startAttempt(userDataDir);
  await writeHelperLog(userDataDir, { text: "GP_UPDATE_FAILURE code=EXTRACT_FAILED exit=1\n" });
  await settleUpdateAttempt({ userDataDir, currentVersion: OLD_VERSION, now: NOW });
  assert.equal(failureCountFor({ userDataDir, version: FAILED_VERSION }), 1);

  await startAttempt(userDataDir);
  assert.equal(await settleUpdateAttempt({ userDataDir, currentVersion: FAILED_VERSION, now: NOW }), null);
  assert.equal(failureCountFor({ userDataDir, version: FAILED_VERSION }), 0);
  assert.equal(existsSync(join(userDataDir, "updates", "update-attempt.json")), false);

  await startAttempt(userDataDir, { version: "0.3.9" });
  assert.equal(await settleUpdateAttempt({ userDataDir, currentVersion: "0.4.0", now: NOW }), null, "a newer App also counts as success");
});

test("a kept-new log, a missing log and a garbled log all count as UNKNOWN", async (t) => {
  const userDataDir = await userDataWithTempDir(t);
  await startAttempt(userDataDir);
  await writeHelperLog(userDataDir, { text: "GP_UPDATE_KEPT_NEW exit=34\nkept\n" });
  assert.deepEqual(
    await settleUpdateAttempt({ userDataDir, currentVersion: OLD_VERSION, now: NOW }),
    { version: FAILED_VERSION, count: 1, code: "UNKNOWN" },
  );

  await startAttempt(userDataDir);
  assert.deepEqual(
    await settleUpdateAttempt({ userDataDir, currentVersion: OLD_VERSION, now: NOW }),
    { version: FAILED_VERSION, count: 2, code: "UNKNOWN" },
  );

  await startAttempt(userDataDir);
  await writeHelperLog(userDataDir, { text: "\u0000\u0001 not a code line" });
  assert.deepEqual(
    await settleUpdateAttempt({ userDataDir, currentVersion: OLD_VERSION, now: NOW }),
    { version: FAILED_VERSION, count: 3, code: "UNKNOWN" },
  );
});

test("failureCodeFromLog reads only a known code on the first line", () => {
  assert.equal(failureCodeFromLog("GP_UPDATE_FAILURE code=TARGET_EXISTS exit=33\nmore"), "TARGET_EXISTS");
  assert.equal(failureCodeFromLog("GP_UPDATE_FAILURE code=MADE_UP exit=1"), "UNKNOWN");
  assert.equal(failureCodeFromLog("junk\nGP_UPDATE_FAILURE code=VERIFY_FAILED exit=1"), "UNKNOWN");
  assert.equal(failureCodeFromLog("GP_UPDATE_KEPT_NEW exit=34"), "UNKNOWN");
  assert.equal(failureCodeFromLog(undefined), "UNKNOWN");
  // Windows PowerShell's Set-Content -Encoding UTF8 writes a byte-order mark first.
  assert.equal(failureCodeFromLog("\uFEFFGP_UPDATE_FAILURE code=REPLACE_FAILED exit=1\r\nmore"), "REPLACE_FAILED");
});

test("a corrupt failure record never throws and reads as no failures", async (t) => {
  const userDataDir = await userDataWithTempDir(t);
  await mkdir(join(userDataDir, "updates"), { recursive: true });
  await writeFile(join(userDataDir, "updates", "update-failures.json"), "{ not json", "utf8");
  assert.equal(failureCountFor({ userDataDir, version: FAILED_VERSION }), 0);

  await startAttempt(userDataDir);
  await writeHelperLog(userDataDir, { text: "GP_UPDATE_FAILURE code=REPLACE_FAILED exit=1\n" });
  assert.deepEqual(
    await settleUpdateAttempt({ userDataDir, currentVersion: OLD_VERSION, now: NOW }),
    { version: FAILED_VERSION, count: 1, code: "REPLACE_FAILED" },
    "a corrupt record is replaced, not fatal",
  );
});

test("an unwritable record location fails quietly at both ends", async (t) => {
  const root = await userDataWithTempDir(t);
  const blocker = join(root, "not-a-folder");
  await writeFile(blocker, "x", "utf8");
  const userDataDir = join(blocker, "userData");
  assert.equal(await recordUpdateAttempt({ userDataDir, version: FAILED_VERSION, platform: "macos", now: NOW }), false);
  assert.equal(await settleUpdateAttempt({ userDataDir, currentVersion: OLD_VERSION, now: NOW }), null);
  assert.equal(failureCountFor({ userDataDir, version: FAILED_VERSION }), 0);
});

test("only the five most recently failed versions are kept", async (t) => {
  const userDataDir = await userDataWithTempDir(t);
  for (let index = 1; index <= 6; index += 1) {
    const version = `0.3.${index}`;
    await startAttempt(userDataDir, { version });
    await writeHelperLog(userDataDir, { version, text: "GP_UPDATE_FAILURE code=UNKNOWN exit=1\n" });
    await settleUpdateAttempt({ userDataDir, currentVersion: "0.3.0", now: NOW + index * 1000 });
  }
  const stored = JSON.parse(await readFile(join(userDataDir, "updates", "update-failures.json"), "utf8"));
  assert.deepEqual(Object.keys(stored).sort(), ["0.3.2", "0.3.3", "0.3.4", "0.3.5", "0.3.6"]);
});
