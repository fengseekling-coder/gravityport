// publish-github-release.test.mjs — scripts/publish-github-release.mjs against
// a fake command runner; nothing here reaches git remotes or GitHub.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  DEFAULT_GITHUB_REPO,
  DOWNLOAD_PAGE_URL,
  githubReleaseBody,
  githubReleaseBodyForVersion,
  githubReleaseCreateArgs,
  githubReleaseEditArgs,
  main,
  parsePublishArgs,
  releaseChannelFlags,
} from "../scripts/publish-github-release.mjs";

let tempRoot;
let notesPath;
let assetPath;

const NOTES = {
  schema: 2,
  unreleased: { zh: [], en: [] },
  releases: [
    { version: "0.3.2", date: "2026-11-02", zh: { new: ["新功能一"], fixed: ["修复一"] }, en: { new: ["New one"], fixed: ["Fixed one"] } },
    { version: "0.3.1", date: "2026-11-01", zh: ["正式版第一句", "正式版第二句"], en: ["Final first", "Final second"] },
    { version: "0.3.0-rc.1", date: "2026-10-31", zh: ["过渡版说明"], en: ["Transition note"] },
  ],
};

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "gravityport-gh-release-test-"));
  notesPath = join(tempRoot, "release-notes.json");
  await writeFile(notesPath, JSON.stringify(NOTES), "utf8");
  assetPath = join(tempRoot, "GravityPort-darwin-arm64-0.3.1.dmg");
  await writeFile(assetPath, "dmg", "utf8");
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function fakeRunner({ tagOnOrigin = true, releaseExists = false } = {}) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "git" && args[0] === "ls-remote") {
      return { code: 0, stdout: tagOnOrigin ? `abc123\t${args[3]}\n` : "", stderr: "" };
    }
    if (command === "gh" && args[1] === "view") {
      return releaseExists
        ? { code: 0, stdout: "{\"tagName\":\"x\"}", stderr: "" }
        : { code: 1, stdout: "", stderr: "release not found\n" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

const mutating = (calls) => calls.filter(([command, , sub]) => command === "gh" && ["create", "edit", "upload"].includes(sub));

describe("githubReleaseBody", () => {
  it("starts with the download page and keeps the flat bullet list for legacy groups", () => {
    const body = githubReleaseBody({ zh: [{ key: null, lines: ["第一句", "第二句"] }], en: [{ key: null, lines: ["First", "Second"] }] });
    const lines = body.split("\n");
    assert.equal(lines[0], `安装包请从 ${DOWNLOAD_PAGE_URL} 下载。`);
    assert.equal(lines[1], `Download: ${DOWNLOAD_PAGE_URL}`);
    assert.ok(body.includes("## 更新内容\n\n• 第一句\n• 第二句\n"));
    assert.ok(body.includes("## What's new\n\n• First\n• Second\n"));
    assert.ok(body.indexOf("## 更新内容") < body.indexOf("## What's new"));
  });

  it("renders sectioned groups as ### headings with dash lists", () => {
    const body = githubReleaseBody({
      zh: [{ key: "new", lines: ["新功能一"] }, { key: "fixed", lines: ["修复一"] }],
      en: [{ key: "new", lines: ["New one"] }, { key: "fixed", lines: ["Fixed one"] }],
    });
    assert.ok(body.includes("## 更新内容\n\n### 新增\n- 新功能一\n\n### 修复\n- 修复一\n"));
    assert.ok(body.includes("## What's new\n\n### New\n- New one\n\n### Fixes\n- Fixed one\n"));
    assert.ok(body.indexOf("### 新增") < body.indexOf("### 修复"));
    assert.ok(body.indexOf("## 更新内容") < body.indexOf("## What's new"));
  });

  it("builds the sectioned body from the release-notes.json entry", () => {
    const body = githubReleaseBodyForVersion(NOTES, "0.3.2");
    assert.ok(body.includes("### 新增\n- 新功能一"));
    assert.ok(body.includes("### Fixes\n- Fixed one"));
  });
});

describe("release channel", () => {
  it("marks a version with a suffix as a pre-release that is never Latest", () => {
    assert.deepEqual(releaseChannelFlags("0.3.0-rc.1"), ["--prerelease", "--latest=false"]);
  });

  it("marks a final version as Latest", () => {
    assert.deepEqual(releaseChannelFlags("0.3.1"), ["--prerelease=false", "--latest"]);
  });

  it("puts the same flags on create and edit", () => {
    const shared = { version: "0.3.0-rc.1", title: "T", notesFile: "/tmp/n.md", repo: DEFAULT_GITHUB_REPO };
    const create = githubReleaseCreateArgs(shared);
    const edit = githubReleaseEditArgs(shared);
    assert.deepEqual(create.slice(-2), ["--prerelease", "--latest=false"]);
    assert.deepEqual(edit.slice(-2), ["--prerelease", "--latest=false"]);
    assert.ok(create.includes("--verify-tag"));
  });
});

describe("parsePublishArgs", () => {
  it("rejects a version with a v prefix", () => {
    assert.throws(() => parsePublishArgs(["--version", "v0.3.1"]), /without the "v" prefix/);
  });

  it("requires --version", () => {
    assert.throws(() => parsePublishArgs([]), /Usage:/);
  });

  it("defaults the title and repository", () => {
    const options = parsePublishArgs(["--version", "0.3.1"]);
    assert.equal(options.title, "GravityPort v0.3.1");
    assert.equal(options.repo, DEFAULT_GITHUB_REPO);
    assert.equal(options.dryRun, false);
    assert.equal(options.update, false);
  });
});

describe("main", () => {
  const silent = () => {};

  it("creates a Latest release with the notes for a final version", async () => {
    const { run, calls } = fakeRunner();
    const result = await main(["--version", "0.3.1", "--release-notes", notesPath], { run, log: silent });
    const writes = mutating(calls);
    assert.equal(writes.length, 1);
    const [, , sub, tag] = writes[0];
    assert.equal(sub, "create");
    assert.equal(tag, "v0.3.1");
    assert.ok(writes[0].includes("--latest"));
    assert.ok(writes[0].includes("--notes-file"));
    assert.ok(!writes[0].includes("--notes"));
    assert.ok(result.body.includes("• 正式版第一句"));
    assert.ok(result.body.includes("• Final second"));
  });

  it("creates a pre-release for an rc version", async () => {
    const { run, calls } = fakeRunner();
    await main(["--version", "0.3.0-rc.1", "--release-notes", notesPath], { run, log: silent });
    const [create] = mutating(calls);
    assert.ok(create.includes("--prerelease"));
    assert.ok(create.includes("--latest=false"));
  });

  it("fails without notes for the version", async () => {
    const { run, calls } = fakeRunner();
    await assert.rejects(
      main(["--version", "0.4.0", "--release-notes", notesPath], { run, log: silent }),
      /release-notes\.json 缺少 0\.4\.0 的更新说明/,
    );
    assert.equal(mutating(calls).length, 0);
  });

  it("stops when the tag is not on origin", async () => {
    const { run, calls } = fakeRunner({ tagOnOrigin: false });
    await assert.rejects(
      main(["--version", "0.3.1", "--release-notes", notesPath], { run, log: silent }),
      /Tag v0\.3\.1 is not on origin/,
    );
    assert.equal(mutating(calls).length, 0);
  });

  it("refuses to touch an existing release without --update", async () => {
    const { run, calls } = fakeRunner({ releaseExists: true });
    await assert.rejects(
      main(["--version", "0.3.1", "--release-notes", notesPath], { run, log: silent }),
      /already exists\. Pass --update/,
    );
    assert.equal(mutating(calls).length, 0);
  });

  it("edits an existing release and uploads assets with --update", async () => {
    const { run, calls } = fakeRunner({ releaseExists: true });
    await main(["--version", "0.3.1", "--release-notes", notesPath, "--update", "--asset", assetPath], { run, log: silent });
    const writes = mutating(calls);
    assert.deepEqual(writes.map(([, , sub]) => sub), ["edit", "upload"]);
    assert.ok(writes[0].includes("--latest"));
    assert.ok(writes[1].includes(assetPath));
    assert.ok(writes[1].includes("--clobber"));
  });

  it("only runs read-only commands in a dry run", async () => {
    const { run, calls } = fakeRunner({ releaseExists: true });
    const lines = [];
    const result = await main(
      ["--version", "0.3.1", "--release-notes", notesPath, "--update", "--dry-run"],
      { run, log: (line) => lines.push(line) },
    );
    assert.equal(result.dryRun, true);
    assert.equal(mutating(calls).length, 0);
    assert.deepEqual(calls.map(([command, sub]) => `${command} ${sub}`), ["git ls-remote", "gh release"]);
    assert.ok(lines.some((line) => line.startsWith("$ gh release edit v0.3.1")));
  });

  it("fails before calling gh when an asset is missing", async () => {
    const { run, calls } = fakeRunner();
    await assert.rejects(
      main(["--version", "0.3.1", "--release-notes", notesPath, "--asset", join(tempRoot, "missing.dmg")], { run, log: silent }),
      /Asset not found/,
    );
    assert.equal(calls.length, 0);
  });
});
