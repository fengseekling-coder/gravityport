import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { releasePrepare } from "../scripts/release-prepare.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

// Task 437: run the real script against real files copied into a temp tree.
// Nothing here re-types the version spots; the "aligned" assertions mirror
// the same checks as test/release-version-consistency.test.mjs, rooted at
// the temp copy.
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
// Versions come from the checkout so the test keeps passing after every
// release bumps them; NEXT_* is the next patch, PREV_APP the previous one.
const bumpPatch = (version, delta) => {
  const [major, minor, patch] = version.split(".").map(Number);
  return `${major}.${minor}.${patch + delta}`;
};
const CURRENT_APP = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
const CURRENT_EXT = JSON.parse(readFileSync(join(REPO_ROOT, "extensions/chatgpt-web-capture/manifest.json"), "utf8")).version;
const NEXT_APP = bumpPatch(CURRENT_APP, 1);
const PREV_APP = bumpPatch(CURRENT_APP, -1);
const NEXT_EXT = bumpPatch(CURRENT_EXT, 1);
const NEXT_EXT_2 = bumpPatch(CURRENT_EXT, 2);
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const COPY_LIST = [
  "package.json",
  "package-lock.json",
  "packages/gravityport-mcp/package.json",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  "release-notes.json",
  "test/update-service.test.mjs",
  "extensions/chatgpt-web-capture/manifest.json",
  "extensions/chatgpt-web-capture/README.md",
  "test/chatgpt-web-capture-hook.test.mjs",
  "test/web-capture-jimeng-midjourney.test.mjs",
  "CHANGELOG.md",
  "extensions/chatgpt-web-capture/CHANGELOG.md",
];

async function makeTempRepo() {
  const root = await mkdtemp(join(tmpdir(), "mosa-release-prepare-"));
  for (const relative of COPY_LIST) {
    await mkdir(dirname(join(root, relative)), { recursive: true });
    await copyFile(join(REPO_ROOT, relative), join(root, relative));
  }
  return root;
}

async function snapshot(root) {
  const contents = {};
  for (const relative of COPY_LIST) {
    contents[relative] = await readFile(join(root, relative), "utf8");
  }
  return contents;
}

// A real release run starts from an `unreleased` filled by hand first. The
// copied release-notes.json may already carry notes for the next release, so
// tests set `unreleased` explicitly instead of relying on the checkout.
async function emptyUnreleased(root) {
  const path = join(root, "release-notes.json");
  const notes = JSON.parse(await readFile(path, "utf8"));
  notes.unreleased = { zh: {}, en: {} };
  await writeFile(path, `${JSON.stringify(notes, null, 2)}\n`, "utf8");
}

async function fillUnreleased(root) {
  const path = join(root, "release-notes.json");
  const notes = JSON.parse(await readFile(path, "utf8"));
  notes.unreleased = {
    zh: { new: ["测试新增一条。"], improved: ["测试优化一条。"], fixed: ["测试修复一条。"] },
    en: { new: ["Test new entry."], improved: ["Test improvement."], fixed: ["Test fix."] },
  };
  await writeFile(path, `${JSON.stringify(notes, null, 2)}\n`, "utf8");
}

// Same checks as test/release-version-consistency.test.mjs, but rooted at
// the temp tree so they prove the copy ended up fully consistent.
async function checkVersionSpots(root) {
  const read = (relative) => readFile(join(root, relative), "utf8");
  const appVersion = JSON.parse(await read("package.json")).version;

  const lockSpots = [...(await read("package-lock.json")).matchAll(/"name": "mosa",\n( *)"version": "([^"]+)",/g)];
  assert.equal(lockSpots.length, 2);
  for (const spot of lockSpots) assert.equal(spot[2], appVersion, `package-lock.json: expected ${appVersion}, found ${spot[2]}`);

  const mcpVersion = JSON.parse(await read("packages/gravityport-mcp/package.json")).version;
  assert.equal(mcpVersion, appVersion, `packages/gravityport-mcp/package.json: expected ${appVersion}, found ${mcpVersion}`);

  assert.ok(
    (await read(".github/ISSUE_TEMPLATE/bug_report.yml")).includes(`placeholder: ${appVersion} or commit SHA`),
    `.github/ISSUE_TEMPLATE/bug_report.yml: expected placeholder ${appVersion}`,
  );

  const notes = JSON.parse(await read("release-notes.json"));
  assert.equal(notes.releases[0].version, appVersion, `release-notes.json: expected latest ${appVersion}, found ${notes.releases[0].version}`);
  assert.ok(
    (await read("test/update-service.test.mjs")).includes(`compareVersions("${appVersion}",`),
    `test/update-service.test.mjs: expected compareVersions("${appVersion}", ...)`,
  );

  const extVersion = JSON.parse(await read("extensions/chatgpt-web-capture/manifest.json")).version;
  assert.ok(
    (await read("extensions/chatgpt-web-capture/README.md")).includes(`GravityPort Web Capture（${extVersion}）`),
    `extensions/chatgpt-web-capture/README.md: expected title version （${extVersion}）`,
  );
  for (const relative of ["test/chatgpt-web-capture-hook.test.mjs", "test/web-capture-jimeng-midjourney.test.mjs"]) {
    const asserted = [...(await read(relative)).matchAll(/manifest\.version, "([^"]+)"/g)].map((match) => match[1]);
    assert.ok(asserted.length > 0, `${relative}: expected manifest.version assertions`);
    for (const found of asserted) assert.equal(found, extVersion, `${relative}: expected ${extVersion}, found ${found}`);
  }
  return { appVersion, extVersion };
}

test("release:prepare aligns every mechanical version spot in a real copy", async () => {
  const root = await makeTempRepo();
  try {
    await fillUnreleased(root);
    const report = await releasePrepare({
      newVersion: NEXT_APP,
      extVersion: NEXT_EXT,
      date: "2026-11-17",
      root,
      log: () => {},
    });
    assert.deepEqual(report.changedFiles.sort(), [
      ".github/ISSUE_TEMPLATE/bug_report.yml",
      "extensions/chatgpt-web-capture/README.md",
      "extensions/chatgpt-web-capture/manifest.json",
      "package-lock.json",
      "package.json",
      "packages/gravityport-mcp/package.json",
      "release-notes.json",
      "test/chatgpt-web-capture-hook.test.mjs",
      "test/update-service.test.mjs",
      "test/web-capture-jimeng-midjourney.test.mjs",
    ]);

    const { appVersion, extVersion } = await checkVersionSpots(root);
    assert.equal(appVersion, NEXT_APP);
    assert.equal(extVersion, NEXT_EXT);

    const notes = JSON.parse(await readFile(join(root, "release-notes.json"), "utf8"));
    assert.equal(notes.releases[0].version, NEXT_APP);
    assert.equal(notes.releases[0].date, "2026-11-17");
    assert.deepEqual(notes.releases[0].zh, { new: ["测试新增一条。"], improved: ["测试优化一条。"], fixed: ["测试修复一条。"] });
    assert.deepEqual(notes.releases[0].en, { new: ["Test new entry."], improved: ["Test improvement."], fixed: ["Test fix."] });
    assert.deepEqual(notes.unreleased, { zh: {}, en: {} });

    for (const relative of ["CHANGELOG.md", "extensions/chatgpt-web-capture/CHANGELOG.md"]) {
      assert.equal(
        await readFile(join(root, relative), "utf8"),
        await readFile(join(REPO_ROOT, relative), "utf8"),
        `${relative} is hand-written prose and must stay untouched`,
      );
    }
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("release:prepare refuses versions not greater than the current one, changing nothing", async () => {
  const root = await makeTempRepo();
  try {
    const before = await snapshot(root);
    await assert.rejects(
      () => releasePrepare({ newVersion: CURRENT_APP, extVersion: NEXT_EXT, root, log: () => {} }),
      new RegExp(`新版本 ${escapeRegExp(CURRENT_APP)} 不比当前版本 ${escapeRegExp(CURRENT_APP)} 大`),
    );
    await assert.rejects(
      () => releasePrepare({ newVersion: PREV_APP, root, log: () => {} }),
      new RegExp(`新版本 ${escapeRegExp(PREV_APP)} 不比当前版本 ${escapeRegExp(CURRENT_APP)} 大`),
    );
    assert.deepEqual(await snapshot(root), before);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("an empty unreleased blocks the run unless --allow-empty-notes, which leaves release-notes.json untouched", async () => {
  const root = await makeTempRepo();
  try {
    await emptyUnreleased(root);
    const before = await snapshot(root);
    await assert.rejects(
      () => releasePrepare({ newVersion: NEXT_APP, root, log: () => {} }),
      /unreleased 中英都是空的/,
    );
    assert.deepEqual(await snapshot(root), before);

    const report = await releasePrepare({ newVersion: NEXT_APP, root, allowEmptyNotes: true, log: () => {} });
    assert.equal(report.movedUnreleased, false);
    assert.equal(report.changedFiles.includes("release-notes.json"), false);
    assert.equal(
      await readFile(join(root, "release-notes.json"), "utf8"),
      before["release-notes.json"],
      "release-notes.json must stay byte-identical with --allow-empty-notes",
    );
    assert.equal(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version, NEXT_APP);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("a missing old-version spot aborts with zero files changed", async () => {
  const root = await makeTempRepo();
  try {
    await fillUnreleased(root);
    const bugPath = join(root, ".github/ISSUE_TEMPLATE/bug_report.yml");
    await writeFile(
      bugPath,
      (await readFile(bugPath, "utf8")).replace(`placeholder: ${CURRENT_APP} or commit SHA`, "placeholder: 9.9.9 or commit SHA"),
    );
    const before = await snapshot(root);
    await assert.rejects(
      () => releasePrepare({ newVersion: NEXT_APP, extVersion: NEXT_EXT, root, log: () => {} }),
      /bug_report\.yml/,
    );
    assert.deepEqual(await snapshot(root), before);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("--dry-run prints the plan without writing", async () => {
  const root = await makeTempRepo();
  try {
    await fillUnreleased(root);
    const before = await snapshot(root);
    const lines = [];
    const report = await releasePrepare({
      newVersion: NEXT_APP,
      extVersion: NEXT_EXT,
      date: "2026-11-17",
      root,
      dryRun: true,
      log: (line) => lines.push(line),
    });
    assert.equal(report.dryRun, true);
    assert.deepEqual(report.changedFiles, []);
    assert.deepEqual(await snapshot(root), before);
    assert.ok(lines.some((line) => line.includes("package.json")), `expected the plan to mention package.json, got:\n${lines.join("\n")}`);
    assert.ok(lines.some((line) => line.includes(NEXT_APP)), `expected the plan to mention ${NEXT_APP}, got:\n${lines.join("\n")}`);
    assert.ok(lines.some((line) => line.includes("release-notes.json")), `expected the plan to mention release-notes.json, got:\n${lines.join("\n")}`);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("a second run on the same tree reports the version is not greater", async () => {
  const root = await makeTempRepo();
  try {
    await fillUnreleased(root);
    await releasePrepare({ newVersion: NEXT_APP, extVersion: NEXT_EXT, date: "2026-11-17", root, log: () => {} });
    const after = await snapshot(root);
    await assert.rejects(
      () => releasePrepare({ newVersion: NEXT_APP, extVersion: NEXT_EXT_2, date: "2026-11-17", root, log: () => {} }),
      new RegExp(`新版本 ${escapeRegExp(NEXT_APP)} 不比当前版本 ${escapeRegExp(NEXT_APP)} 大`),
    );
    assert.deepEqual(await snapshot(root), after);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("without --ext the extension files stay untouched", async () => {
  const root = await makeTempRepo();
  try {
    await fillUnreleased(root);
    const before = await snapshot(root);
    await releasePrepare({ newVersion: NEXT_APP, date: "2026-11-17", root, log: () => {} });
    for (const relative of [
      "extensions/chatgpt-web-capture/manifest.json",
      "extensions/chatgpt-web-capture/README.md",
      "test/chatgpt-web-capture-hook.test.mjs",
      "test/web-capture-jimeng-midjourney.test.mjs",
    ]) {
      assert.equal(await readFile(join(root, relative), "utf8"), before[relative], `${relative} must stay untouched without --ext`);
    }
    assert.equal(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version, NEXT_APP);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});
