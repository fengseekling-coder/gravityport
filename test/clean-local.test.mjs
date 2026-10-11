import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { cleanLocal, DEFAULT_TARGETS, parseArgs, PRESERVED_RELEASE_PATHS, resolveCleanTarget } from "../scripts/clean-local.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

async function makeTemporaryRoot(t, prefix) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  deferTestPathRemoval(root, { recursive: true, force: true });
  return root;
}

async function write(filePath, contents = "x") {
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, contents);
}

// Builds a repository-shaped fixture: release artifacts that must survive,
// scratch namespaces and regenerable roots that may be deleted, and an
// unrelated directory outside the repository root.
async function makeFixture(t) {
  const root = await makeTemporaryRoot(t, "mosa-clean-fixture-");
  const outside = await makeTemporaryRoot(t, "mosa-clean-outside-");
  await write(join(root, "coverage", "report.html"));
  await write(join(root, ".nyc_output", "out.json"));
  await write(join(root, "out", "tmp", "scratch-1", "repack.bin"));
  await write(join(root, "out", "qa", "capture.bin"));
  await write(join(root, "out", "inspect", "asar.bin"));
  await write(join(root, "out", "make", "rc.9", "MOSA.dmg"), "installer");
  await write(join(root, "out", "MOSA-darwin-arm64", "MOSA.app", "Contents", "Info.plist"));
  await write(join(root, "out", "MOSA-win32-x64", "MOSA.exe"));
  await write(join(root, "out", "GravityPort-darwin-arm64", "GravityPort.app", "Contents", "Info.plist"));
  await write(join(root, "out", "GravityPort-win32-x64", "GravityPort.exe"));
  await write(join(root, "out", "store", "extension.zip"));
  await write(join(outside, "sentinel.txt"), "keep me");
  return { root, outside };
}

test("clean:local deletes declared scratch namespaces and coverage roots", async (t) => {
  const { root } = await makeFixture(t);
  const report = await cleanLocal({ root });
  const removedRels = report.removed.map((entry) => entry.rel).sort();
  assert.deepEqual(removedRels, [".nyc_output", "coverage", "out/inspect", "out/qa", "out/tmp"]);
  assert.equal(existsSync(join(root, "out", "tmp")), false);
  assert.equal(existsSync(join(root, "coverage")), false);
  assert.equal(report.bytesReclaimed > 0, true);
});

test("clean:local never deletes out/make", async (t) => {
  const { root } = await makeFixture(t);
  await cleanLocal({ root });
  assert.equal(await readFile(join(root, "out", "make", "rc.9", "MOSA.dmg"), "utf8"), "installer");
});

test("clean:local never deletes the packaged macOS app", async (t) => {
  const { root } = await makeFixture(t);
  await cleanLocal({ root });
  assert.equal(existsSync(join(root, "out", "MOSA-darwin-arm64", "MOSA.app", "Contents", "Info.plist")), true);
  assert.equal(existsSync(join(root, "out", "GravityPort-darwin-arm64", "GravityPort.app", "Contents", "Info.plist")), true);
});

test("clean:local never deletes the packaged Windows app", async (t) => {
  const { root } = await makeFixture(t);
  await cleanLocal({ root });
  assert.equal(existsSync(join(root, "out", "MOSA-win32-x64", "MOSA.exe")), true);
  assert.equal(existsSync(join(root, "out", "GravityPort-win32-x64", "GravityPort.exe")), true);
});

test("clean:local never deletes out/store", async (t) => {
  const { root } = await makeFixture(t);
  await cleanLocal({ root });
  assert.equal(existsSync(join(root, "out", "store", "extension.zip")), true);
});

test("release artifact paths are rejected even when requested explicitly", async (t) => {
  const { root } = await makeFixture(t);
  for (const requested of ["out", "out/make", "out/store", "out/MOSA-darwin-arm64", "out/MOSA-win32-x64", "out/GravityPort-darwin-arm64", "out/GravityPort-win32-x64", "out/make/rc.9", "out/unknown-dir"]) {
    const verdict = resolveCleanTarget(root, requested);
    assert.ok(verdict.reason, `expected rejection for ${requested}`);
    assert.equal(verdict.path, undefined);
  }
  const report = await cleanLocal({ root, targets: ["out/make", "out"] });
  assert.equal(report.rejected.length, 2);
  assert.equal(existsSync(join(root, "out", "make", "rc.9", "MOSA.dmg")), true);
  assert.equal(existsSync(join(root, "coverage", "report.html")), true);
});

test("paths outside the repository cannot be deleted", async (t) => {
  const { root, outside } = await makeFixture(t);
  const verdicts = [
    resolveCleanTarget(root, outside),
    resolveCleanTarget(root, join(outside, "sentinel.txt")),
    resolveCleanTarget(root, "../mosa-clean-outside-escape"),
    resolveCleanTarget(root, ".."),
    resolveCleanTarget(root, "/etc"),
  ];
  for (const verdict of verdicts) {
    assert.equal(verdict.path, undefined, `expected rejection for ${verdict.requested}`);
    assert.match(verdict.reason, /outside the repository|escapes the repository|repository root/);
  }
  const report = await cleanLocal({ root, targets: [outside, "../escape-attempt"] });
  assert.equal(report.removed.length, 0);
  assert.equal(await readFile(join(outside, "sentinel.txt"), "utf8"), "keep me");
});

test("clean:local CLI cannot replace the repository root", () => {
  assert.deepEqual(parseArgs([]), { dryRun: false });
  assert.deepEqual(parseArgs(["--dry-run"]), { dryRun: true });
  assert.throws(() => parseArgs(["--root", "/tmp"]), /Unknown option: --root/);
});

test("symlinks cannot cause deletions outside the repository", async (t) => {
  const { root, outside } = await makeFixture(t);
  const outsideKeep = join(outside, "escape-target");
  await write(join(outsideKeep, "payload.txt"), "keep me");
  await rm(join(root, "out", "inspect"), { recursive: true, force: true });
  await symlink(outsideKeep, join(root, "out", "inspect"), "dir");
  await symlink(outsideKeep, join(root, "out", "tmp", "inside-link"), "dir");

  const report = await cleanLocal({ root });

  const inspect = report.results.find((entry) => entry.rel === "out/inspect");
  assert.equal(inspect.status, "skipped");
  assert.match(inspect.reason, /resolved target escapes the repository/);
  assert.equal(existsSync(join(outsideKeep, "payload.txt")), true);
  assert.equal(existsSync(join(root, "out", "inspect")), true);

  assert.equal(await readFile(join(outsideKeep, "payload.txt"), "utf8"), "keep me");
  assert.equal(existsSync(join(root, "out", "tmp")), false);
});

test("a symlinked parent directory cannot redirect cleanup outside the repository", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-clean-parent-link-root-");
  const outside = await makeTemporaryRoot(t, "mosa-clean-parent-link-outside-");
  await write(join(outside, "tmp", "payload.txt"), "keep me");
  await symlink(outside, join(root, "out"), "dir");

  const report = await cleanLocal({ root, targets: ["out/tmp"] });

  const result = report.results[0];
  assert.equal(result.status, "skipped");
  assert.match(result.reason, /resolved target escapes the repository/);
  assert.equal(await readFile(join(outside, "tmp", "payload.txt"), "utf8"), "keep me");
  assert.equal(existsSync(join(root, "out")), true);
});

test("dry-run removes nothing and reports what would be removed", async (t) => {
  const { root, outside } = await makeFixture(t);
  const report = await cleanLocal({ root, dryRun: true });
  assert.equal(report.dryRun, true);
  assert.equal(report.removed.length, DEFAULT_TARGETS.length);
  assert.equal(report.bytesReclaimed > 0, true);
  for (const rel of ["coverage/report.html", ".nyc_output/out.json", "out/tmp/scratch-1/repack.bin", "out/qa/capture.bin", "out/inspect/asar.bin", "out/make/rc.9/MOSA.dmg", "out/store/extension.zip"]) {
    assert.equal(existsSync(join(root, ...rel.split("/"))), true, `${rel} must survive a dry-run`);
  }
  assert.equal(await readFile(join(outside, "sentinel.txt"), "utf8"), "keep me");
});

test("missing targets are skipped without failing the cleanup", async (t) => {
  const { root } = await makeFixture(t);
  await rm(join(root, "coverage"), { recursive: true, force: true });
  const report = await cleanLocal({ root });
  assert.equal(report.results.find((entry) => entry.rel === "coverage").status, "missing");
  assert.equal(report.removed.some((entry) => entry.rel === "out/tmp"), true);
});

test("repeated runs are idempotent", async (t) => {
  const { root } = await makeFixture(t);
  const first = await cleanLocal({ root });
  assert.equal(first.removed.length, DEFAULT_TARGETS.length);
  const second = await cleanLocal({ root });
  assert.equal(second.removed.length, 0);
  assert.deepEqual(second.results.map((entry) => entry.status), new Array(DEFAULT_TARGETS.length).fill("missing"));
  assert.equal(second.bytesReclaimed, 0);
  assert.equal(existsSync(join(root, "out", "make", "rc.9", "MOSA.dmg")), true);
});

test("declared target set matches the documented allowlist", () => {
  assert.deepEqual([...DEFAULT_TARGETS].sort(), [".nyc_output", "coverage", "out/inspect", "out/qa", "out/tmp"]);
  assert.deepEqual([...PRESERVED_RELEASE_PATHS], [
    "out/make",
    "out/MOSA-darwin-arm64",
    "out/MOSA-win32-x64",
    "out/GravityPort-darwin-arm64",
    "out/GravityPort-win32-x64",
    "out/store",
  ]);
});
