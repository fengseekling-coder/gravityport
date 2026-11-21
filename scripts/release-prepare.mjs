#!/usr/bin/env node
/**
 * One command to bump every release version string (task 437).
 *
 * Usage:
 *   npm run release:prepare -- <App 新版本> [--ext <扩展新版本>] [--date YYYY-MM-DD]
 *                            [--root <目录>] [--dry-run] [--allow-empty-notes]
 *
 * What it does (all mechanical spots verified against the real release
 * commit f061b86, 0.3.14→0.3.15 / 0.15.48→0.15.49):
 *   - package.json, package-lock.json (both "mosa" blocks),
 *     packages/gravityport-mcp/package.json (follows the app version),
 *     .github/ISSUE_TEMPLATE/bug_report.yml placeholder,
 *     test/update-service.test.mjs (appends the next compareVersions line),
 *     release-notes.json (moves `unreleased` into a new releases entry).
 *   - With --ext: extensions/chatgpt-web-capture/manifest.json, its README
 *     title, test/chatgpt-web-capture-hook.test.mjs and
 *     test/web-capture-jimeng-midjourney.test.mjs.
 * What it deliberately does NOT do: CHANGELOG.md (root and extension) are
 * hand-written prose; the script never touches them and prints a reminder.
 *
 * Safety rules: the new version must be x.y.z and strictly greater than the
 * current one; every expected old-version spot is checked in all files
 * before anything is written (a missing spot aborts with zero files
 * changed); indentation, line endings and key order are preserved
 * verbatim; --dry-run prints the plan without writing.
 */

import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readReleaseNotes, SECTION_KEYS } from "../lib/release-notes.mjs";

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_ROOT = fileURLToPath(new URL("..", import.meta.url));

const CHANGELOG_REMINDER = "还要手写 CHANGELOG：根 CHANGELOG.md 和 extensions/chatgpt-web-capture/CHANGELOG.md（脚本不生成说明文字）。";

export async function releasePrepare({
  newVersion = "",
  extVersion = "",
  date = "",
  root = DEFAULT_ROOT,
  dryRun = false,
  allowEmptyNotes = false,
  log = (line) => console.log(line),
} = {}) {
  const base = resolve(String(root || DEFAULT_ROOT));
  const requestedVersion = String(newVersion || "").trim();
  const requestedExtVersion = String(extVersion || "").trim();
  const releaseDate = String(date || "").trim() || todayLocal();
  if (!VERSION_PATTERN.test(requestedVersion)) {
    throw new Error(`App 新版本必须是 x.y.z，收到：${requestedVersion || "(空)"}`);
  }
  if (!DATE_PATTERN.test(releaseDate)) {
    throw new Error(`--date 必须是 YYYY-MM-DD，收到：${releaseDate}`);
  }

  const pkgText = await readFile(join(base, "package.json"), "utf8");
  let currentVersion = "";
  try {
    currentVersion = JSON.parse(pkgText).version;
  } catch {
    throw new Error("package.json 不是有效的 JSON");
  }
  if (!VERSION_PATTERN.test(currentVersion)) {
    throw new Error(`当前 package.json 版本 ${currentVersion} 不是 x.y.z，脚本不知道怎么比较`);
  }
  if (compareVersions(requestedVersion, currentVersion) <= 0) {
    throw new Error(`新版本 ${requestedVersion} 不比当前版本 ${currentVersion} 大，没有任何文件被改`);
  }

  let currentExtVersion = "";
  if (requestedExtVersion) {
    if (!VERSION_PATTERN.test(requestedExtVersion)) {
      throw new Error(`--ext 新版本必须是 x.y.z，收到：${requestedExtVersion}`);
    }
    const manifest = JSON.parse(await readFile(join(base, "extensions/chatgpt-web-capture/manifest.json"), "utf8"));
    currentExtVersion = String(manifest.version || "");
    if (!VERSION_PATTERN.test(currentExtVersion)) {
      throw new Error(`扩展 manifest.json 当前版本 ${currentExtVersion} 不是 x.y.z`);
    }
    if (compareVersions(requestedExtVersion, currentExtVersion) <= 0) {
      throw new Error(`扩展新版本 ${requestedExtVersion} 不比当前扩展版本 ${currentExtVersion} 大，没有任何文件被改`);
    }
  }

  // release-notes.json: `unreleased` must carry the notes for the new
  // release (both languages) unless --allow-empty-notes is passed, in which
  // case the file is left completely untouched.
  const notesPath = join(base, "release-notes.json");
  const notes = readReleaseNotes(notesPath);
  const unreleased = notes.unreleased || {};
  const zhEmpty = languageNotesEmpty(unreleased.zh);
  const enEmpty = languageNotesEmpty(unreleased.en);
  let moveUnreleased = true;
  const followUps = [];
  if (zhEmpty && enEmpty) {
    if (!allowEmptyNotes) {
      throw new Error("release-notes.json 的 unreleased 中英都是空的：先把更新说明写进 unreleased（zh 和 en），再跑发版准备；确认这次不写说明就加 --allow-empty-notes。");
    }
    moveUnreleased = false;
    followUps.push("release-notes.json 的 unreleased 中英都是空的，本次原样未动，记得之后补上并确认发布渠道上的说明。");
  } else if (zhEmpty || enEmpty) {
    followUps.push(`release-notes.json 的 unreleased ${zhEmpty ? "zh" : "en"} 是空的，已按原样搬进新版本条目，发布前补齐另一语言。`);
  }

  // Check phase: every file is read and every expected old-version spot is
  // located before a single byte is written. Any missing spot aborts the
  // whole run with zero files changed.
  const plans = [];
  const errors = [];
  const planLiteral = (rel, text, find, replace, { min = 1, max = min } = {}) => {
    const count = text.split(find).length - 1;
    if (count < min || count > max) {
      errors.push(`在 ${rel} 找不到预期的旧版本号 ${currentVersion}（${find}），期望 ${min}${max === min ? "" : `–${max}`} 处，找到 ${count} 处`);
      return null;
    }
    return { rel, find, replace, count };
  };
  const planRegex = (rel, text, pattern, replaceFn, { min = 1 } = {}) => {
    const matches = [...text.matchAll(pattern)];
    if (matches.length < min) {
      errors.push(`在 ${rel} 找不到预期的旧版本号（模式 ${pattern}），期望至少 ${min} 处，找到 ${matches.length} 处`);
      return null;
    }
    return { rel, pattern, replaceFn, count: matches.length };
  };

  const pkgPlan = planLiteral("package.json", pkgText, `"version": "${currentVersion}"`, `"version": "${requestedVersion}"`);
  if (pkgPlan) plans.push(pkgPlan);

  const lockText = await readFile(join(base, "package-lock.json"), "utf8");
  const lockPattern = new RegExp(`"name": "mosa",\\n( *)"version": "${escapeRegExp(currentVersion)}",`, "g");
  const lockPlan = planRegex("package-lock.json", lockText, lockPattern, (_match, indent) => `"name": "mosa",\n${indent}"version": "${requestedVersion}",`, { min: 2 });
  if (lockPlan) plans.push(lockPlan);

  const mcpText = await readFile(join(base, "packages/gravityport-mcp/package.json"), "utf8");
  const mcpPlan = planLiteral("packages/gravityport-mcp/package.json", mcpText, `"version": "${currentVersion}"`, `"version": "${requestedVersion}"`);
  if (mcpPlan) plans.push(mcpPlan);

  const bugText = await readFile(join(base, ".github/ISSUE_TEMPLATE/bug_report.yml"), "utf8");
  const bugPlan = planLiteral(".github/ISSUE_TEMPLATE/bug_report.yml", bugText, `placeholder: ${currentVersion} or commit SHA`, `placeholder: ${requestedVersion} or commit SHA`);
  if (bugPlan) plans.push(bugPlan);

  const updateTestText = await readFile(join(base, "test/update-service.test.mjs"), "utf8");
  const updateAnchor = new RegExp(`^(\\s*)assert\\.equal\\(compareVersions\\("${escapeRegExp(currentVersion)}", "\\d+\\.\\d+\\.\\d+"\\), 1\\);$`, "gm");
  const updateMatches = [...updateTestText.matchAll(updateAnchor)];
  if (updateMatches.length !== 1) {
    errors.push(`在 test/update-service.test.mjs 找不到 compareVersions("${currentVersion}", …) 断言行，期望恰好 1 行，找到 ${updateMatches.length} 行`);
  } else {
    const updateMatch = updateMatches[0];
    const indent = updateMatch[1];
    const inserted = `${indent}assert.equal(compareVersions("${requestedVersion}", "${currentVersion}"), 1);`;
    const insertAt = updateMatch.index + updateMatch[0].length;
    plans.push({
      rel: "test/update-service.test.mjs",
      apply: (text) => text.slice(0, insertAt) + `\n${inserted}` + text.slice(insertAt),
      describe: () => `新增断言行：${inserted.trim()}`,
    });
  }

  const extPlans = [];
  if (requestedExtVersion) {
    const manifestText = await readFile(join(base, "extensions/chatgpt-web-capture/manifest.json"), "utf8");
    const manifestPlan = planLiteral("extensions/chatgpt-web-capture/manifest.json", manifestText, `"version": "${currentExtVersion}"`, `"version": "${requestedExtVersion}"`);
    if (manifestPlan) extPlans.push(manifestPlan);

    const readmeText = await readFile(join(base, "extensions/chatgpt-web-capture/README.md"), "utf8");
    const readmePlan = planLiteral("extensions/chatgpt-web-capture/README.md", readmeText, `GravityPort Web Capture（${currentExtVersion}）`, `GravityPort Web Capture（${requestedExtVersion}）`);
    if (readmePlan) extPlans.push(readmePlan);

    const extTokenPattern = new RegExp(`(?<![\\d.])${escapeRegExp(currentExtVersion)}(?![\\d.])`, "g");
    for (const rel of ["test/chatgpt-web-capture-hook.test.mjs", "test/web-capture-jimeng-midjourney.test.mjs"]) {
      const text = await readFile(join(base, rel), "utf8");
      const plan = planRegex(rel, text, extTokenPattern, () => requestedExtVersion, { min: 1 });
      if (plan) extPlans.push(plan);
    }
  }
  plans.push(...extPlans);

  if (errors.length > 0) {
    throw new Error(`以下文件的预期旧版本号没找齐，一个文件都没有改：\n${errors.join("\n")}`);
  }

  // Write phase (skipped entirely for --dry-run).
  if (dryRun) {
    log(`[dry-run] 将把版本改齐为 App ${requestedVersion}${requestedExtVersion ? `、扩展 ${requestedExtVersion}` : ""}（日期 ${releaseDate}）`);
    for (const plan of plans) {
      if (plan.describe) {
        log(`  ${plan.rel}: ${plan.describe()}`);
        continue;
      }
      log(`  ${plan.rel}: ${plan.count} 处`);
    }
    log(`  release-notes.json: ${moveUnreleased ? `unreleased 挪成新版本条目（${requestedVersion}，${releaseDate}），unreleased 清空` : "unreleased 为空，原样不动"}`);
    return { dryRun: true, changedFiles: [], movedUnreleased: moveUnreleased };
  }

  const changedFiles = [];
  const writeText = async (rel, transform) => {
    const path = join(base, rel);
    const before = await readFile(path, "utf8");
    const after = transform(before);
    await writeFile(path, after, "utf8");
    changedFiles.push(rel);
  };

  for (const plan of plans) {
    if (plan.describe) {
      await writeText(plan.rel, plan.apply);
      continue;
    }
    if (plan.find !== undefined) {
      const find = plan.find;
      const replace = plan.replace;
      await writeText(plan.rel, (text) => text.replace(find, replace));
      continue;
    }
    const { pattern, replaceFn } = plan;
    await writeText(plan.rel, (text) => text.replace(pattern, replaceFn));
  }

  if (moveUnreleased) {
    const entry = {
      version: requestedVersion,
      date: releaseDate,
      ...(unreleased.zh !== undefined ? { zh: unreleased.zh } : {}),
      ...(unreleased.en !== undefined ? { en: unreleased.en } : {}),
    };
    const nextUnreleased = {};
    for (const key of Object.keys(unreleased)) nextUnreleased[key] = {};
    const updated = { ...notes, unreleased: nextUnreleased, releases: [entry, ...notes.releases] };
    await writeFile(notesPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    changedFiles.push("release-notes.json");
  }

  followUps.push(CHANGELOG_REMINDER);
  log(`已把版本改齐为 App ${requestedVersion}${requestedExtVersion ? `、扩展 ${requestedExtVersion}` : ""}（日期 ${releaseDate}）。`);
  for (const rel of changedFiles) log(`  已改：${rel}`);
  log("脚本没做、要人接着做的事：");
  for (const line of followUps) log(`  - ${line}`);
  return { dryRun: false, changedFiles, movedUnreleased: moveUnreleased };
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function languageNotesEmpty(value) {
  if (Array.isArray(value)) return value.length === 0;
  if (!value || typeof value !== "object") return true;
  return SECTION_KEYS.every((key) => !Array.isArray(value[key]) || value[key].length === 0);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function todayLocal() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function parseCliArgs(argv) {
  const parsed = { _: [], dryRun: false, allowEmptyNotes: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (token === "--allow-empty-notes") {
      parsed.allowEmptyNotes = true;
      continue;
    }
    if (token === "--ext" || token === "--date" || token === "--root") {
      parsed[token.slice(2)] = argv[(index += 1)];
      continue;
    }
    if (token.startsWith("--")) throw new Error(`不认识的参数：${token}`);
    parsed._.push(token);
  }
  return parsed;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args._.length !== 1) {
    throw new Error("用法：npm run release:prepare -- <App 新版本> [--ext <扩展新版本>] [--date YYYY-MM-DD] [--root <目录>] [--dry-run] [--allow-empty-notes]");
  }
  await releasePrepare({
    newVersion: args._[0],
    extVersion: args.ext || "",
    date: args.date || "",
    root: args.root || DEFAULT_ROOT,
    dryRun: args.dryRun,
    allowEmptyNotes: args.allowEmptyNotes,
  });
}

// import.meta.url carries the symlink-resolved path; realpath argv[1] the
// same way so the guard also matches when the script is invoked via a
// symlinked directory (e.g. macOS /tmp → /private/tmp).
let invokedPath = "";
try {
  invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
} catch {
  invokedPath = "";
}
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`[release-prepare] ${error?.message || error}`);
    process.exitCode = 1;
  });
}
