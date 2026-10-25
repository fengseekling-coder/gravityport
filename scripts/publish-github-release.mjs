#!/usr/bin/env node

// Publishes (or updates) the GitHub Release for a version that is already
// tagged and pushed. The notes come from release-notes.json, the same entry the
// About page and the signed update manifest use; whether the Release is a
// pre-release or Latest follows the version alone (a "-" suffix means a
// pre-release), so the two can never disagree with docs/releasing.md.

import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { formatNotesText, notesForVersion, readReleaseNotes } from "../lib/release-notes.mjs";

/** GitHub Release headings per section, per language (not the manifest prefixes). */
const GITHUB_SECTION_HEADINGS = {
  zh: { new: "新增", improved: "优化", fixed: "修复", other: "其他" },
  en: { new: "New", improved: "Improvements", fixed: "Fixes", other: "Other" },
};

export const DEFAULT_GITHUB_REPO = "fengseekling-coder/gravityport";
export const DOWNLOAD_PAGE_URL = "https://gravityport.azhuilab.com/#download";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const USAGE = "Usage: publish-github-release.mjs --version <version> [--title <title>] [--asset <path>]... [--release-notes <release-notes.json>] [--repo <owner/name>] [--dry-run] [--update]";

export function isPrereleaseVersion(version) {
  return String(version).includes("-");
}

/** gh flags that mark the Release; shared by create and edit so both agree. */
export function releaseChannelFlags(version) {
  return isPrereleaseVersion(version)
    ? ["--prerelease", "--latest=false"]
    : ["--prerelease=false", "--latest"];
}

/** One language's notes as body lines. Legacy flat groups keep the bullet
 * list; sectioned groups become ### headings with dash lists. */
export function releaseNotesMarkdown(groups, language) {
  if (groups.length === 1 && groups[0].key === null) {
    return ["", ...formatNotesText(groups[0].lines).split("\n"), ""];
  }
  const headings = GITHUB_SECTION_HEADINGS[language];
  const lines = [""];
  for (const group of groups) {
    lines.push(`### ${headings[group.key]}`);
    for (const line of group.lines) lines.push(`- ${line}`);
    lines.push("");
  }
  return lines;
}

export function githubReleaseBody({ zh, en }) {
  return [
    `安装包请从 ${DOWNLOAD_PAGE_URL} 下载。`,
    `Download: ${DOWNLOAD_PAGE_URL}`,
    "",
    "## 更新内容",
    ...releaseNotesMarkdown(zh, "zh"),
    "## What's new",
    ...releaseNotesMarkdown(en, "en"),
  ].join("\n");
}

export function githubReleaseBodyForVersion(data, version) {
  const entry = notesForVersion(data, version);
  if (!entry) throw new Error(`release-notes.json 缺少 ${version} 的更新说明`);
  return githubReleaseBody(entry);
}

export function githubReleaseCreateArgs({ version, title, notesFile, assets = [], repo = DEFAULT_GITHUB_REPO }) {
  return [
    "release", "create", `v${version}`, ...assets,
    "-R", repo,
    "--verify-tag",
    "--title", title,
    "--notes-file", notesFile,
    ...releaseChannelFlags(version),
  ];
}

export function githubReleaseEditArgs({ version, title, notesFile, repo = DEFAULT_GITHUB_REPO }) {
  return [
    "release", "edit", `v${version}`,
    "-R", repo,
    "--title", title,
    "--notes-file", notesFile,
    ...releaseChannelFlags(version),
  ];
}

export function githubReleaseUploadArgs({ version, assets, repo = DEFAULT_GITHUB_REPO }) {
  return ["release", "upload", `v${version}`, ...assets, "-R", repo, "--clobber"];
}

export function parsePublishArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      version: { type: "string" },
      title: { type: "string" },
      asset: { type: "string", multiple: true },
      "release-notes": { type: "string" },
      repo: { type: "string" },
      "dry-run": { type: "boolean" },
      update: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
  const version = String(values.version || "").trim();
  if (!version) throw new Error(USAGE);
  if (/^v/i.test(version)) {
    throw new Error(`Pass the version without the "v" prefix, for example --version ${version.slice(1)}.`);
  }
  if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid version: ${version}.`);
  return {
    version,
    title: String(values.title || "").trim() || `GravityPort v${version}`,
    assets: (values.asset || []).map((asset) => resolve(asset)),
    releaseNotesPath: values["release-notes"] ? resolve(values["release-notes"]) : "",
    repo: String(values.repo || "").trim() || DEFAULT_GITHUB_REPO,
    dryRun: Boolean(values["dry-run"]),
    update: Boolean(values.update),
  };
}

/** Runs a command without a shell and reports its exit code instead of throwing. */
export function runCommand(command, args, { cwd = PROJECT_ROOT } = {}) {
  return new Promise((resolvePromise) => {
    execFile(command, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolvePromise({ code, stdout: String(stdout || ""), stderr: String(stderr || error?.message || "") });
    });
  });
}

function firstLine(text) {
  return String(text || "").trim().split("\n")[0] || "(no output)";
}

function quoteArg(arg) {
  return /^[\w./:=@#-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

export function formatCommand(command, args) {
  return [command, ...args].map(quoteArg).join(" ");
}

async function assertAssetsExist(assets) {
  for (const asset of assets) {
    const info = await stat(asset).catch(() => null);
    if (!info?.isFile()) throw new Error(`Asset not found: ${asset}`);
  }
}

async function remoteTagExists(run, tag) {
  const result = await run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]);
  if (result.code !== 0) throw new Error(`git ls-remote failed: ${firstLine(result.stderr)}`);
  return result.stdout.trim().length > 0;
}

async function githubReleaseExists(run, tag, repo) {
  const result = await run("gh", ["release", "view", tag, "-R", repo, "--json", "tagName"]);
  if (result.code === 0) return true;
  if (/release not found/i.test(result.stderr)) return false;
  throw new Error(`gh release view failed: ${firstLine(result.stderr)}`);
}

export async function main(argv = process.argv.slice(2), { run = runCommand, log = (line) => console.log(line) } = {}) {
  const options = parsePublishArgs(argv);
  await assertAssetsExist(options.assets);
  const body = githubReleaseBodyForVersion(readReleaseNotes(options.releaseNotesPath || undefined), options.version);
  const tag = `v${options.version}`;

  if (!(await remoteTagExists(run, tag))) {
    throw new Error(`Tag ${tag} is not on origin. Push the release tag before publishing its GitHub Release.`);
  }
  const exists = await githubReleaseExists(run, tag, options.repo);
  if (exists && !options.update) {
    throw new Error(`GitHub Release ${tag} already exists. Pass --update to replace its title, notes and Latest flag.`);
  }

  const tempDir = await mkdtemp(join(tmpdir(), "gravityport-gh-release-"));
  try {
    const notesFile = join(tempDir, "notes.md");
    await writeFile(notesFile, body, "utf8");
    const shared = { version: options.version, title: options.title, notesFile, assets: options.assets, repo: options.repo };
    const commands = exists
      ? [
        ["gh", githubReleaseEditArgs(shared)],
        ...(options.assets.length ? [["gh", githubReleaseUploadArgs(shared)]] : []),
      ]
      : [["gh", githubReleaseCreateArgs(shared)]];

    if (options.dryRun) {
      log(`Dry run: GitHub Release ${tag} ${exists ? "exists and would be updated" : "would be created"} (${isPrereleaseVersion(options.version) ? "pre-release" : "Latest"}).`);
      for (const [command, args] of commands) log(`$ ${formatCommand(command, args)}`);
      log("--- notes ---");
      log(body);
      return { dryRun: true, exists, commands, body };
    }

    for (const [command, args] of commands) {
      const result = await run(command, args);
      if (result.code !== 0) throw new Error(`${formatCommand(command, args.slice(0, 3))} failed: ${firstLine(result.stderr)}`);
    }
    log(`GitHub Release ${tag} ${exists ? "updated" : "published"} as ${isPrereleaseVersion(options.version) ? "pre-release" : "Latest"}.`);
    return { dryRun: false, exists, commands, body };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`[GravityPort] GitHub release failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
