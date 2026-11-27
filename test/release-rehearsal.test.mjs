import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MOSA_DEVELOPMENT_UPDATE_FEED_URL, MOSA_UPDATE_FEED_URL } from "../desktop/update-service.mjs";
import { buildRehearsalPlan, resolvePrivateKeyPath, RUNTIME_FROM_VERSION, stopRehearsalAppUntilQuiet } from "../scripts/release-rehearsal/rehearse.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const script = join(repoRoot, "scripts/release-rehearsal/rehearse.mjs");
const LOCAL_STEP_IDS = [
  "clean-work-dir",
  "make-work-dirs",
  "copy-from-app",
  "read-from-version",
  "extract-asar",
  "copy-from-identity",
  "launch-isolated-app",
  "wait-for-health",
  "rehearse-update",
  "read-installed-version",
  "verify-signature",
  "stop-rehearsal-app",
];

test("C1 local mode with all defaults plans the full isolated rehearsal", () => {
  const build = mkdtempSync(join(tmpdir(), "gp-449-local-build-"));
  const privateKey = join(tmpdir(), "gp-449-local-fake-key.pem");
  const plan = buildRehearsalPlan({ build, toVersion: "0.4.0", privateKey });

  assert.deepEqual(plan.steps.map((step) => step.id), LOCAL_STEP_IDS);
  assert.equal(plan.mode, "local");
  assert.equal(plan.fromApp, "/Applications/GravityPort.app");
  assert.equal(plan.appName, "GravityPort.app");
  // Real spelling of the temp dir (/private/var/… on macOS), see C7.
  assert.equal(plan.workDir, join(realpathSync(tmpdir()), "gp-rehearsal-local"));
  assert.equal(plan.rootDir, join(realpathSync(tmpdir()), "gp-rehearsal-local", "root"));
  assert.equal(plan.port, 43617);
  assert.equal(plan.fromVersionSource, "runtime");
  assert.equal(plan.zipPath, join(build, "out/make/update/darwin/arm64/GravityPort-darwin-arm64-0.4.0.zip"));
  assert.equal(plan.identityPath, join(build, "web/gravityport/dist/build-identity.json"));
  assert.equal(plan.asarBin, join(build, "node_modules/.bin/asar"));
  assert.equal(plan.feedUrl, MOSA_UPDATE_FEED_URL);
  assert.equal(plan.privateKeyPath, privateKey);

  const [clean, makeDirs, copyApp, readVersion, extractAsar, copyIdentity, launch, health] = plan.steps;
  assert.deepEqual(clean.args, ["-rf", plan.workDir]);
  assert.deepEqual(makeDirs.args, [
    "-p",
    join(plan.workDir, "root/Applications"),
    join(plan.workDir, "root/server"),
    join(plan.workDir, "from-src"),
  ]);
  assert.deepEqual(copyApp.args, ["/Applications/GravityPort.app", join(plan.workDir, "root/Applications/GravityPort.app")]);
  assert.deepEqual(readVersion.args, ["-c", "Print CFBundleShortVersionString", join(plan.workDir, "root/Applications/GravityPort.app/Contents/Info.plist")]);
  assert.equal(readVersion.capture, "fromVersion");
  assert.equal(extractAsar.command, join(build, "node_modules/.bin/asar"));
  assert.deepEqual(extractAsar.args, ["extract", join(plan.workDir, "root/Applications/GravityPort.app/Contents/Resources/app.asar"), join(plan.workDir, "from-src")]);
  assert.deepEqual(copyIdentity.args, [
    join(plan.workDir, "from-src/web/gravityport/dist/build-identity.json"),
    join(plan.workDir, "root/from-identity.json"),
  ]);
  assert.deepEqual(launch.env, { REHEARSAL_ROOT: plan.rootDir, REHEARSAL_PORT: "43617" });
  assert.equal(health.attempts, 60);
  assert.equal(health.intervalMs, 1000);
  assert.equal(health.args.at(-1), "http://127.0.0.1:43617/api/health");

  const rehearse = plan.steps.find((step) => step.id === "rehearse-update");
  assert.equal(rehearse.command, "node");
  assert.deepEqual(rehearse.args, [
    join(repoRoot, "scripts/release-rehearsal/rehearse-update.mjs"),
    "--from-src", join(plan.workDir, "from-src"),
    "--writer-src", build,
    "--root", plan.rootDir,
    "--from-version", RUNTIME_FROM_VERSION,
    "--to-version", "0.4.0",
    "--zip", join(build, "out/make/update/darwin/arm64/GravityPort-darwin-arm64-0.4.0.zip"),
    "--identity", join(build, "web/gravityport/dist/build-identity.json"),
    "--app-name", "GravityPort.app",
    "--feed-url", MOSA_UPDATE_FEED_URL,
    "--private-key", privateKey,
    "--port", "43617",
  ]);

  const stop = plan.steps.find((step) => step.id === "stop-rehearsal-app");
  assert.equal(stop.port, 43617);
  assert.equal(stop.workDir, plan.workDir);
});

test("C2 live mode runs the live script without key, zip, identity or writer-src", () => {
  const build = mkdtempSync(join(tmpdir(), "gp-449-live-build-"));
  const plan = buildRehearsalPlan({ build, toVersion: "0.4.0", mode: "live" });

  assert.deepEqual(plan.steps.map((step) => step.id), LOCAL_STEP_IDS);
  assert.equal(plan.mode, "live");
  assert.equal(plan.workDir, join(realpathSync(tmpdir()), "gp-rehearsal-live"));
  assert.equal(plan.privateKeyPath, null);

  const rehearse = plan.steps.find((step) => step.id === "rehearse-update");
  assert.deepEqual(rehearse.args, [
    join(repoRoot, "scripts/release-rehearsal/rehearse-update-live.mjs"),
    "--from-src", join(plan.workDir, "from-src"),
    "--root", plan.rootDir,
    "--from-version", RUNTIME_FROM_VERSION,
    "--to-version", "0.4.0",
    "--app-name", "GravityPort.app",
    "--install-app", "GravityPort.app",
    "--feed-url", MOSA_UPDATE_FEED_URL,
    "--port", "43617",
  ]);
  assert.ok(!rehearse.args.includes("--private-key"));
  assert.ok(!rehearse.args.includes("--zip"));
  assert.ok(!rehearse.args.includes("--writer-src"));
  assert.ok(!rehearse.args.includes("--identity"));
});

test("C3-1 refuses the user's own app port 43517", () => {
  assert.throws(
    () => buildRehearsalPlan({ build: join(tmpdir(), "gp-449-port-build"), toVersion: "0.4.0", privateKey: "k.pem", port: "43517" }),
    /43517/,
  );
});

test("C3-2 refuses a work dir outside the system temp directory", () => {
  assert.throws(
    () => buildRehearsalPlan({ build: join(tmpdir(), "gp-449-tmp-build"), toVersion: "0.4.0", privateKey: "k.pem", workDir: join(homedir(), "gp-449-not-tmp") }),
    /system temp directory/,
  );
});

test("C3-3 refuses a work dir that overlaps the app, the build tree or the real library", () => {
  const build = join(tmpdir(), "gp-449-overlap-build");
  const buildTree = mkdtempSync(join(tmpdir(), "gp-449-buildtree-"));
  // the work dir sits inside the build tree
  assert.throws(
    () => buildRehearsalPlan({ build: buildTree, toVersion: "0.4.0", privateKey: "k.pem", workDir: join(buildTree, "rehearsal") }),
    /must not overlap/,
  );
  // the work dir contains the build
  const outer = mkdtempSync(join(tmpdir(), "gp-449-outer-"));
  assert.throws(
    () => buildRehearsalPlan({ build: join(outer, "build-inside"), toVersion: "0.4.0", privateKey: "k.pem", workDir: outer }),
    /must not overlap/,
  );
  // the work dir contains the from-app
  const appParent = mkdtempSync(join(tmpdir(), "gp-449-app-"));
  assert.throws(
    () => buildRehearsalPlan({ build, toVersion: "0.4.0", privateKey: "k.pem", workDir: appParent, fromApp: join(appParent, "GravityPort.app") }),
    /must not overlap/,
  );
});

test("C3-4 local mode without a private key is refused; live mode is not", () => {
  assert.throws(
    () => buildRehearsalPlan({ build: join(tmpdir(), "gp-449-key-build"), toVersion: "0.4.0" }),
    /MOSA_RELEASE_MANIFEST_PRIVATE_KEY_FILE/,
  );
  assert.doesNotThrow(() => buildRehearsalPlan({ build: join(tmpdir(), "gp-449-key-build"), toVersion: "0.4.0", mode: "live" }));
});

test("C3-5 refuses a --to-version that is not x.y.z", () => {
  assert.throws(
    () => buildRehearsalPlan({ build: join(tmpdir(), "gp-449-ver-build"), toVersion: "0.4", privateKey: "k.pem" }),
    /x\.y\.z/,
  );
  assert.throws(
    () => buildRehearsalPlan({ build: join(tmpdir(), "gp-449-ver-build"), toVersion: "v0.4.0", privateKey: "k.pem" }),
    /x\.y\.z/,
  );
});

test("C4 derives --to-version from the build's package.json when not given", () => {
  const build = mkdtempSync(join(tmpdir(), "gp-449-pkgjson-"));
  assert.throws(() => buildRehearsalPlan({ build, privateKey: "k.pem" }), /package\.json/);
  writeFileSync(join(build, "package.json"), JSON.stringify({ name: "gravityport", version: "9.9.9" }));
  const plan = buildRehearsalPlan({ build, privateKey: "k.pem" });
  assert.equal(plan.toVersion, "9.9.9");
  const rehearse = plan.steps.find((step) => step.id === "rehearse-update");
  assert.equal(rehearse.args[rehearse.args.indexOf("--to-version") + 1], "9.9.9");
  assert.equal(
    rehearse.args[rehearse.args.indexOf("--zip") + 1],
    join(build, "out/make/update/darwin/arm64/GravityPort-darwin-arm64-9.9.9.zip"),
  );
});

test("C5 --dry-run prints the derived plan and creates nothing", () => {
  const parent = mkdtempSync(join(tmpdir(), "gp-449-dryrun-"));
  const build = join(parent, "build");
  mkdirSync(build);
  writeFileSync(join(build, "package.json"), JSON.stringify({ version: "0.4.1" }));
  const fakeKey = join(parent, "dry-run-fake-key.pem");
  writeFileSync(fakeKey, "dry-run placeholder, not a real key\n");
  const before = readdirSync(parent).sort();
  const workDirTarget = join(tmpdir(), "gp-rehearsal-local");
  const workDirExistedBefore = existsSync(workDirTarget);

  const result = spawnSync(process.execPath, [script, "--build", build, "--private-key", fakeKey, "--dry-run"], { encoding: "utf8" });
  assert.equal(result.status, 0, `exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.ok(
    result.stdout.includes(join(build, "out/make/update/darwin/arm64/GravityPort-darwin-arm64-0.4.1.zip")),
    `plan did not print the derived zip path\n${result.stdout}`,
  );
  assert.ok(result.stdout.includes("运行时读取"), `plan did not print the runtime from-version marker\n${result.stdout}`);
  // dry-run must not execute anything: no folder appears in the temp build area,
  // and the default work dir is not created either.
  assert.deepEqual(readdirSync(parent).sort(), before);
  if (!workDirExistedBefore) assert.equal(existsSync(workDirTarget), false);
});

test("C6 the signing key is taken only as a file path; inline key content is refused and never printed", () => {
  assert.equal(resolvePrivateKeyPath("arg.pem", { MOSA_RELEASE_MANIFEST_PRIVATE_KEY_FILE: "env.pem" }), "arg.pem");
  assert.equal(resolvePrivateKeyPath(undefined, { MOSA_RELEASE_MANIFEST_PRIVATE_KEY_FILE: " env.pem " }), "env.pem");
  assert.equal(resolvePrivateKeyPath(undefined, {}), undefined);
  const inline = "inline key content gp449fakeinlinecontent";
  assert.throws(
    () => resolvePrivateKeyPath(undefined, { MOSA_RELEASE_MANIFEST_PRIVATE_KEY: inline }),
    (error) => /MOSA_RELEASE_MANIFEST_PRIVATE_KEY_FILE/.test(error.message) && !error.message.includes("gp449fakeinlinecontent"),
  );

  const parent = mkdtempSync(join(tmpdir(), "gp-449-inline-key-"));
  const build = join(parent, "build");
  mkdirSync(build);
  writeFileSync(join(build, "package.json"), JSON.stringify({ version: "0.4.1" }));
  const env = { ...process.env, MOSA_RELEASE_MANIFEST_PRIVATE_KEY: inline };
  delete env.MOSA_RELEASE_MANIFEST_PRIVATE_KEY_FILE;
  const result = spawnSync(process.execPath, [script, "--build", build, "--dry-run"], { encoding: "utf8", env });
  assert.equal(result.status, 1, `exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, /MOSA_RELEASE_MANIFEST_PRIVATE_KEY_FILE/);
  assert.equal(`${result.stdout}${result.stderr}`.includes("gp449fakeinlinecontent"), false);
});

test("C7 the work dir is planned in its real spelling, so the updated app's userData matches it (11-22 exit 32)", () => {
  const build = mkdtempSync(join(tmpdir(), "gp-1123-real-build-"));
  const privateKey = join(tmpdir(), "gp-1123-real-fake-key.pem");
  const realBase = mkdtempSync(join(tmpdir(), "gp-1123-real-base-"));
  const linkBase = join(tmpdir(), `gp-1123-link-${process.pid}-${Date.now()}`);
  symlinkSync(realBase, linkBase);
  // The tail does not exist yet; only the existing ancestor is resolved.
  const plan = buildRehearsalPlan({ build, toVersion: "0.4.0", privateKey, workDir: join(linkBase, "not-yet", "work") });
  assert.equal(plan.workDir, join(realpathSync(realBase), "not-yet", "work"));
  assert.equal(plan.rootDir, join(realpathSync(realBase), "not-yet", "work", "root"));
  const stop = plan.steps.find((step) => step.id === "stop-rehearsal-app");
  assert.equal(stop.workDir, plan.workDir, "the stop rule matches the same spelling the app is launched from");
});

test("C8 after a failure, stopping keeps going until the rollback relaunch is gone and the port stays quiet", async () => {
  // Simulated port: the first check stops the failed app, the install helper
  // relaunches the old app one check later, then everything stays down.
  const sequence = [1, 0, 1, 0, 0, 0];
  const calls = [];
  const total = await stopRehearsalAppUntilQuiet({ port: 43617, workDir: "/private/tmp/w" }, {
    stop: (step) => { calls.push(step.port); return sequence.shift() ?? 0; },
    wait: async () => {},
    intervalMs: 1000,
    quietChecks: 3,
  });
  assert.equal(total, 2, "both the failed app and the rollback relaunch were stopped");
  assert.equal(calls.length, 6, "it stops only after three quiet checks in a row");

  // A port that never goes quiet still ends at the timeout.
  let checks = 0;
  await stopRehearsalAppUntilQuiet({ port: 43617, workDir: "/private/tmp/w" }, {
    stop: () => { checks += 1; return 1; },
    wait: async () => {},
    intervalMs: 1000,
    timeoutMs: 5000,
  });
  assert.equal(checks, 6, "bounded by the timeout");
});

test("479 a development-channel build rehearses against the development feed with its dev version", () => {
  const build = mkdtempSync(join(tmpdir(), "gp-479-dev-build-"));
  mkdirSync(join(build, "web", "gravityport", "dist"), { recursive: true });
  writeFileSync(join(build, "package.json"), JSON.stringify({ name: "mosa", version: "0.3.19-dev.202611272130" }));
  // Before the build exists the plan assumes a release feed.
  assert.equal(buildRehearsalPlan({ build, privateKey: "k.pem" }).feedUrl, MOSA_UPDATE_FEED_URL);
  writeFileSync(join(build, "web", "gravityport", "dist", "build-identity.json"), JSON.stringify({ distribution: "development" }));
  const plan = buildRehearsalPlan({ build, privateKey: "k.pem" });
  assert.equal(plan.toVersion, "0.3.19-dev.202611272130");
  assert.equal(plan.feedUrl, MOSA_DEVELOPMENT_UPDATE_FEED_URL);
  assert.equal(plan.zipPath, join(build, "out/make/update/darwin/arm64/GravityPort-darwin-arm64-0.3.19-dev.202611272130.zip"));
  const rehearse = plan.steps.find((step) => step.id === "rehearse-update");
  assert.equal(rehearse.args[rehearse.args.indexOf("--feed-url") + 1], MOSA_DEVELOPMENT_UPDATE_FEED_URL);
  // Only the development stamp is accepted beyond x.y.z.
  assert.throws(() => buildRehearsalPlan({ build, toVersion: "0.3.19-rc.1", privateKey: "k.pem" }), /x\.y\.z/);
  assert.equal(buildRehearsalPlan({ build, toVersion: "0.3.19", privateKey: "k.pem", feedUrl: MOSA_UPDATE_FEED_URL }).feedUrl, MOSA_UPDATE_FEED_URL);
});
