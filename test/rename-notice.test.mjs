// 任务 116：老用户「已更名」提示的判定/确认纯函数（desktop/rename-notice.mjs）。
// 全部用临时目录；除接线位置补钉外全部是行为断言——顺序测试用真实的
// ensureInstallationId / prepareAnonymousUsage 按真实启动顺序回放，不读源码找字符串。
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ANONYMOUS_USAGE_PROFILE_FILE,
  ensureInstallationId,
  prepareAnonymousUsage,
} from "../desktop/anonymous-usage.mjs";
import {
  acknowledgeRenameNotice,
  evaluateRenameNoticeState,
  RENAME_NOTICE_MARKER_FILE,
  RENAME_NOTICE_MARKER_VERSION,
} from "../desktop/rename-notice.mjs";
import { LIBRARY_LOCATION_FILE, resolveLibraryLocation } from "../lib/library-location.mjs";

function temporaryDir(t, prefix = "mosa-rename-notice-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

function seedUsageProfile(userDataDir) {
  writeFileSync(join(userDataDir, ANONYMOUS_USAGE_PROFILE_FILE), `${JSON.stringify({
    schemaVersion: 2,
    installationId: "123e4567-e89b-42d3-a456-426614174000",
    firstReportedAt: 1,
    lastReportedAt: 1,
    lastReportedDay: "2026-10-10",
  })}\n`, "utf8");
}

// 老版本挪素材库时写下的偏好文件；判定只看它在不在，不读内容。
function seedLibraryLocation(userDataDir) {
  writeFileSync(join(userDataDir, LIBRARY_LOCATION_FILE), `${JSON.stringify({ path: "/Volumes/External/MOSA Library" })}\n`, "utf8");
}

function writeMarker(userDataDir, content) {
  writeFileSync(join(userDataDir, RENAME_NOTICE_MARKER_FILE), content, "utf8");
}

function readMarker(userDataDir) {
  return JSON.parse(readFileSync(join(userDataDir, RENAME_NOTICE_MARKER_FILE), "utf8"));
}

test("a userData with only anonymous-usage.json is an existing user (pending, pops)", (t) => {
  const userDataDir = temporaryDir(t);
  seedUsageProfile(userDataDir);

  const result = evaluateRenameNoticeState({ userDataDir, legacyLibraryDir: "" });

  assert.equal(result.shouldShow, true);
  assert.equal(result.state, "pending");
  assert.equal(result.persisted, true);
  assert.deepEqual(readMarker(userDataDir), { version: RENAME_NOTICE_MARKER_VERSION, state: "pending" });
});

test("a legacy library directory alone is an existing user (pending, pops)", (t) => {
  const userDataDir = temporaryDir(t);
  const legacyLibraryDir = join(temporaryDir(t, "mosa-rename-legacy-"), "MOSA Library");
  mkdirSync(legacyLibraryDir, { recursive: true });

  const result = evaluateRenameNoticeState({ userDataDir, legacyLibraryDir });

  assert.equal(result.shouldShow, true);
  assert.equal(result.state, "pending");
  assert.equal(readMarker(userDataDir).state, "pending");
});

test("a userData with only library-location.json is an existing user who moved the library (pending, pops)", (t) => {
  const userDataDir = temporaryDir(t);
  seedLibraryLocation(userDataDir);
  const absentLegacyDir = join(tmpdir(), `mosa-rename-notice-absent-${Date.now()}`);

  const result = evaluateRenameNoticeState({ userDataDir, legacyLibraryDir: absentLegacyDir });

  assert.equal(result.shouldShow, true);
  assert.equal(result.state, "pending");
  assert.equal(result.persisted, true);
  assert.deepEqual(readMarker(userDataDir), { version: RENAME_NOTICE_MARKER_VERSION, state: "pending" });
});

test("none of the three signals (usage profile, library location, legacy library) is a new user", (t) => {
  const userDataDir = temporaryDir(t);
  const absentLegacyDir = join(tmpdir(), `mosa-rename-notice-absent-${Date.now()}`);
  assert.equal(existsSync(join(userDataDir, ANONYMOUS_USAGE_PROFILE_FILE)), false);
  assert.equal(existsSync(join(userDataDir, LIBRARY_LOCATION_FILE)), false);

  const result = evaluateRenameNoticeState({ userDataDir, legacyLibraryDir: absentLegacyDir });

  assert.equal(result.shouldShow, false);
  assert.equal(result.state, "not-needed");
  assert.deepEqual(readMarker(userDataDir), { version: RENAME_NOTICE_MARKER_VERSION, state: "not-needed" });
});

test("an existing not-needed marker wins over a later library-location.json (no re-evaluation)", (t) => {
  const userDataDir = temporaryDir(t);
  writeMarker(userDataDir, `{"version": 1, "state": "not-needed"}\n`);
  seedLibraryLocation(userDataDir);

  const result = evaluateRenameNoticeState({ userDataDir, legacyLibraryDir: "" });

  assert.equal(result.shouldShow, false);
  assert.equal(result.state, "not-needed");
  assert.equal(result.persisted, true);
  assert.equal(readFileSync(join(userDataDir, RENAME_NOTICE_MARKER_FILE), "utf8"), `{"version": 1, "state": "not-needed"}\n`);
});

test("with an empty legacy dir the decision rests on the userData files alone", (t) => {
  // 家目录里真有老素材库，但隔离实例传空：只有 userData 里的文件说了算。
  const legacyLibraryDir = join(temporaryDir(t, "mosa-rename-legacy-"), "MOSA Library");
  mkdirSync(legacyLibraryDir, { recursive: true });

  const withLocation = temporaryDir(t);
  seedLibraryLocation(withLocation);
  const moved = evaluateRenameNoticeState({ userDataDir: withLocation, legacyLibraryDir: "" });
  assert.equal(moved.shouldShow, true);
  assert.equal(moved.state, "pending");

  const withoutLocation = temporaryDir(t);
  const fresh = evaluateRenameNoticeState({ userDataDir: withoutLocation, legacyLibraryDir: "" });
  assert.equal(fresh.shouldShow, false);
  assert.equal(fresh.state, "not-needed");
});

test("no old-user signal is a new user: no dialog, not-needed recorded", (t) => {
  const userDataDir = temporaryDir(t);
  const absentLegacyDir = join(tmpdir(), `mosa-rename-notice-absent-${Date.now()}`);

  const result = evaluateRenameNoticeState({ userDataDir, legacyLibraryDir: absentLegacyDir });

  assert.equal(result.shouldShow, false);
  assert.equal(result.state, "not-needed");
  assert.equal(existsSync(absentLegacyDir), false, "the evaluation must never create the legacy directory");
  assert.deepEqual(readMarker(userDataDir), { version: RENAME_NOTICE_MARKER_VERSION, state: "not-needed" });
});

test("a pending marker keeps popping on the next launch and is not rewritten", (t) => {
  const userDataDir = temporaryDir(t);
  writeMarker(userDataDir, `{"state": "pending", "version": 1}\n`);

  const result = evaluateRenameNoticeState({ userDataDir, legacyLibraryDir: "" });

  assert.equal(result.shouldShow, true);
  assert.equal(result.state, "pending");
  assert.equal(result.persisted, true);
  // 原样读回（含原有空格排版）证明合法标记不会被重写。
  assert.equal(readFileSync(join(userDataDir, RENAME_NOTICE_MARKER_FILE), "utf8"), `{"state": "pending", "version": 1}\n`);
});

test("acknowledged and not-needed markers never pop again", (t) => {
  const userDataDir = temporaryDir(t);
  writeMarker(userDataDir, `{"version": 1, "state": "acknowledged"}\n`);
  assert.equal(evaluateRenameNoticeState({ userDataDir, legacyLibraryDir: "" }).shouldShow, false);

  const other = temporaryDir(t);
  writeMarker(other, `{"version": 1, "state": "not-needed"}\n`);
  assert.equal(evaluateRenameNoticeState({ userDataDir: other, legacyLibraryDir: "" }).shouldShow, false);
});

test("a corrupt marker is treated as missing and falls back to the old-user signals", (t) => {
  const withSignal = temporaryDir(t);
  writeMarker(withSignal, "{ this is not json");
  seedUsageProfile(withSignal);
  assert.deepEqual(evaluateRenameNoticeState({ userDataDir: withSignal, legacyLibraryDir: "" }), {
    shouldShow: true,
    state: "pending",
    persisted: true,
  });

  const withoutSignal = temporaryDir(t);
  writeMarker(withoutSignal, "not json at all");
  const result = evaluateRenameNoticeState({ userDataDir: withoutSignal, legacyLibraryDir: "" });
  assert.equal(result.shouldShow, false);
  assert.equal(result.state, "not-needed");
  // 损坏标记被覆盖为合法的 not-needed。
  assert.deepEqual(readMarker(withoutSignal), { version: RENAME_NOTICE_MARKER_VERSION, state: "not-needed" });
});

test("an isolated instance passes an empty legacy dir and never looks at the home directory", (t) => {
  const userDataDir = temporaryDir(t);
  const legacyLibraryDir = join(temporaryDir(t, "mosa-rename-legacy-"), "MOSA Library");
  mkdirSync(legacyLibraryDir, { recursive: true });

  const result = evaluateRenameNoticeState({ userDataDir, legacyLibraryDir: "" });

  assert.equal(result.shouldShow, false, "an existing legacy library must be invisible to an isolated instance");
  assert.equal(result.state, "not-needed");
});

test("an invalid marker shape (wrong version / unknown state / non-object) counts as corrupt", (t) => {
  for (const content of [
    `{"version": 2, "state": "pending"}`,
    `{"version": 1, "state": "mystery"}`,
    `["pending"]`,
    ``,
  ]) {
    const userDataDir = temporaryDir(t);
    writeMarker(userDataDir, content);
    const result = evaluateRenameNoticeState({ userDataDir, legacyLibraryDir: "" });
    assert.equal(result.shouldShow, false, `content ${content} must not pop`);
    assert.equal(result.state, "not-needed");
  }
});

test("write failures never throw: evaluation reports and keeps going", (t) => {
  // userData 是一个普通文件：读标记 ENOTDIR、建目录 EEXIST/ENOTDIR，两条失败路径都走到。
  const notADir = join(temporaryDir(t), "plain-file");
  writeFileSync(notADir, "not a directory", "utf8");
  const logs = [];
  const result = evaluateRenameNoticeState({ userDataDir: notADir, legacyLibraryDir: "", log: (line) => logs.push(line) });

  assert.equal(result.shouldShow, false);
  assert.equal(result.state, "not-needed");
  assert.equal(result.persisted, false);
  assert.ok(logs.length >= 1, "the write failure must be logged");

  const ackLogs = [];
  assert.equal(acknowledgeRenameNotice({ userDataDir: notADir, log: (line) => ackLogs.push(line) }), false);
  assert.ok(ackLogs.length >= 1);
});

test("a read-only userData with old-user signals still pops (write failure only logged)", (t) => {
  const userDataDir = temporaryDir(t);
  seedUsageProfile(userDataDir);
  chmodSync(userDataDir, 0o555);
  try {
    const logs = [];
    const result = evaluateRenameNoticeState({ userDataDir, legacyLibraryDir: "", log: (line) => logs.push(line) });
    assert.equal(result.shouldShow, true, "an unwritable marker must not swallow the old-user decision");
    assert.equal(result.state, "pending");
    assert.equal(result.persisted, false);
    assert.ok(logs.length >= 1, "the write failure must be logged");
  } finally {
    chmodSync(userDataDir, 0o755);
  }
});

test("acknowledgeRenameNotice flips the marker to acknowledged and later launches stay quiet", (t) => {
  const userDataDir = temporaryDir(t);
  seedUsageProfile(userDataDir);
  assert.equal(evaluateRenameNoticeState({ userDataDir, legacyLibraryDir: "" }).shouldShow, true);

  assert.equal(acknowledgeRenameNotice({ userDataDir, log: () => {} }), true);
  assert.deepEqual(readMarker(userDataDir), { version: RENAME_NOTICE_MARKER_VERSION, state: "acknowledged" });

  const nextLaunch = evaluateRenameNoticeState({ userDataDir, legacyLibraryDir: "" });
  assert.equal(nextLaunch.shouldShow, false);
  assert.equal(nextLaunch.state, "acknowledged");
});

// 顺序测试：按 desktop/main.mjs 的真实启动顺序回放——先 evaluate（此刻 userData
// 还是全新的，anonymous-usage.json 尚不存在），再走真实的 ensureInstallationId /
// prepareAnonymousUsage。结论必须是「新用户」：判定若晚于匿名使用信息的创建，
// 这里会误判成 pending。
test("the decision happens before anonymous-usage.json is created: a fresh install stays a new user", (t) => {
  const userDataDir = temporaryDir(t);
  assert.equal(existsSync(join(userDataDir, ANONYMOUS_USAGE_PROFILE_FILE)), false, "precondition: fresh userData");

  // 启动顺序第 1 步：判定（main.mjs 在 ensureInstallationId 之前调用）。
  const decision = evaluateRenameNoticeState({ userDataDir, legacyLibraryDir: "" });
  assert.equal(decision.shouldShow, false);
  assert.equal(decision.state, "not-needed");

  // 启动顺序第 2 步：真实的匿名使用信息初始化（创建 anonymous-usage.json）。
  const installationId = ensureInstallationId({ userDataDir });
  assert.match(installationId, /^[0-9a-f-]{36}$/);
  assert.equal(existsSync(join(userDataDir, ANONYMOUS_USAGE_PROFILE_FILE)), true);

  // 启动顺序第 3 步：真实的使用上报准备（读回 profile）。
  const prepared = prepareAnonymousUsage({ userDataDir, currentVersion: "0.3.0" });
  assert.notEqual(prepared.telemetry, null);

  // 整个启动序列走完，判定结果必须保持新用户，且不被随后创建的 usage 文件翻转。
  const afterBoot = evaluateRenameNoticeState({ userDataDir, legacyLibraryDir: "" });
  assert.equal(afterBoot.shouldShow, false);
  assert.equal(afterBoot.state, "not-needed");
});

// 顺序测试：main.mjs 在判定之前唯一碰 library-location.json 的是
// resolveLibraryLocation（只读）；写它的 saveLibraryDir 只在用户挪库的 IPC
// 里调用。全新 userData 走完这一步后，文件仍不存在，判定仍是新用户。
test("resolving the library location on a fresh install never creates library-location.json", (t) => {
  const userDataDir = temporaryDir(t);
  const homeDir = temporaryDir(t, "mosa-rename-home-");
  const locationFile = join(userDataDir, LIBRARY_LOCATION_FILE);

  const resolved = resolveLibraryLocation({ homeDir, envLibraryDir: undefined, locationFile });
  assert.equal(resolved.source, "new-default-fresh");
  assert.equal(existsSync(locationFile), false, "startup resolution must stay read-only");

  const decision = evaluateRenameNoticeState({ userDataDir, legacyLibraryDir: join(homeDir, "MOSA Library") });
  assert.equal(decision.shouldShow, false);
  assert.equal(decision.state, "not-needed");
});

// 接线位置补钉（配合上面的行为顺序测试）：main.mjs 里判定调用必须出现在
// ensureInstallationId（本次启动第一个 userData 写入点）之前，且隔离实例
// （userData ≠ 正式默认目录）传空 legacyLibraryDir。
test("main.mjs wires the evaluation before the first userData write and isolates moved userData", async (t) => {
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const main = await readFile(resolve(root, "desktop/main.mjs"), "utf8");

  const evaluateAt = main.indexOf("evaluateRenameNoticeState({");
  const installAt = main.indexOf("const desktopUserId = ensureInstallationId({ userDataDir: desktopDataDir })");
  assert.ok(evaluateAt > -1, "main.mjs must call evaluateRenameNoticeState");
  assert.ok(installAt > -1, "main.mjs must still mint the installation id");
  assert.ok(evaluateAt < installAt, "the rename decision must run before the first userData write");

  assert.match(main, /const renameNoticeLegacyLibraryDir = desktopDataDir === productionDefaultUserData\n  \? legacyDefaultLibraryDir\(homeDir\)\n  : "";/,
    "the moved-userData branch passes an empty legacy library dir");
});
