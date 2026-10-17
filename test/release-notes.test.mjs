// release-notes.test.mjs — unit tests for lib/release-notes.mjs against the
// real module, including the actual release-notes.json shipped in the repo.
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

import { formatNotesText, notesForVersion, readReleaseNotes } from "../lib/release-notes.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const repoNotesPath = join(repositoryRoot, "release-notes.json");

let tempRoot;
let fixturePath;

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "mosa-release-notes-"));
  fixturePath = async (content) => {
    const path = join(tempRoot, `fixture-${fixturePath.sequence++}.json`);
    await writeFile(path, JSON.stringify(content), "utf8");
    return path;
  };
  fixturePath.sequence = 0;
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const validData = {
  schema: 1,
  unreleased: { zh: ["下个版本的说明"], en: ["Next release note"] },
  releases: [
    { version: "1.1.0", date: "2026-10-01", zh: ["第一条"], en: ["First"] },
    { version: "1.0.0", date: "2026-09-01", zh: ["旧的一条"], en: ["Older"] },
  ],
};

describe("readReleaseNotes", () => {
  it("accepts the release-notes.json shipped in the repository", () => {
    const data = readReleaseNotes(repoNotesPath);
    assert.equal(data.schema, 1);
    assert.ok(Array.isArray(data.releases) && data.releases.length > 0);
  });

  it("accepts a well-formed fixture", async () => {
    const path = await fixturePath(validData);
    const data = readReleaseNotes(path);
    assert.equal(data.releases.length, 2);
  });

  it("rejects a missing schema with the field position", async () => {
    const { schema: _schema, ...withoutSchema } = validData;
    const path = await fixturePath(withoutSchema);
    assert.throws(() => readReleaseNotes(path), /schema/);
  });

  it("rejects an empty sentence with the exact line position", async () => {
    const path = await fixturePath({
      ...validData,
      releases: [{ version: "1.1.0", date: "2026-10-01", zh: ["  "], en: ["First"] }],
    });
    assert.throws(() => readReleaseNotes(path), /releases\[0\].*zh\[0\]/);
  });

  it("rejects a sentence longer than 200 characters with the exact line position", async () => {
    const path = await fixturePath({
      ...validData,
      releases: [{ version: "1.1.0", date: "2026-10-01", zh: ["一".repeat(201)], en: ["First"] }],
    });
    assert.throws(() => readReleaseNotes(path), /releases\[0\].*zh\[0\].*200/);
  });

  it("rejects a duplicated version with the entry position", async () => {
    const path = await fixturePath({
      ...validData,
      releases: [
        { version: "1.1.0", date: "2026-10-01", zh: ["一条"], en: ["One"] },
        { version: "1.1.0", date: "2026-10-02", zh: ["又一条"], en: ["Two"] },
      ],
    });
    assert.throws(() => readReleaseNotes(path), /releases\[1\].*1\.1\.0.*重复/);
  });

  it("rejects a zh that is not an array", async () => {
    const path = await fixturePath({
      ...validData,
      releases: [{ version: "1.1.0", date: "2026-10-01", zh: "一条", en: ["First"] }],
    });
    assert.throws(() => readReleaseNotes(path), /releases\[0\].*\.zh/);
  });

  it("accepts an empty unreleased but not an empty release entry", async () => {
    const emptyUnreleased = await fixturePath({ ...validData, unreleased: { zh: [], en: [] } });
    assert.doesNotThrow(() => readReleaseNotes(emptyUnreleased));
    const emptyRelease = await fixturePath({
      ...validData,
      releases: [{ version: "1.1.0", date: "2026-10-01", zh: [], en: ["First"] }],
    });
    assert.throws(() => readReleaseNotes(emptyRelease), /releases\[0\].*\.zh/);
  });
});

describe("notesForVersion", () => {
  it("finds an entry and returns its sentences and date", () => {
    assert.deepEqual(notesForVersion(validData, "1.1.0"), {
      zh: ["第一条"],
      en: ["First"],
      date: "2026-10-01",
    });
  });

  it("matches a v-prefixed query against a plain version", () => {
    assert.equal(notesForVersion(validData, "v1.0.0").date, "2026-09-01");
  });

  it("returns null for an unknown version", () => {
    assert.equal(notesForVersion(validData, "9.9.9"), null);
    assert.equal(notesForVersion(validData, ""), null);
  });
});

describe("formatNotesText", () => {
  it("joins one bullet-prefixed sentence per line", () => {
    assert.equal(formatNotesText(["第一条", "第二条"]), "• 第一条\n• 第二条");
    assert.equal(formatNotesText(["only"]), "• only");
  });
});

// ---------------------------------------------------------------------------
// Build gate (scripts/write-build-identity.mjs) — runs the real script as a
// subprocess inside a temp mini-repo (scripts/ + lib/ + server.mjs copied,
// minimal dist/ and package.json) so the real dist/ is never touched.
// ---------------------------------------------------------------------------

describe("write-build-identity release-notes gate", () => {
  const gateVersion = "0.0.0-gate-test";
  let gateRoot;

  before(async () => {
    gateRoot = await mkdtemp(join(tmpdir(), "mosa-release-notes-gate-"));
    await mkdir(join(gateRoot, "scripts"), { recursive: true });
    await mkdir(join(gateRoot, "web", "gravityport", "dist"), { recursive: true });
    await cp(join(repositoryRoot, "lib"), join(gateRoot, "lib"), { recursive: true });
    await cp(join(repositoryRoot, "scripts", "write-build-identity.mjs"), join(gateRoot, "scripts", "write-build-identity.mjs"));
    await cp(join(repositoryRoot, "server.mjs"), join(gateRoot, "server.mjs"));
    await writeFile(join(gateRoot, "package.json"), JSON.stringify({ version: gateVersion }), "utf8");
    await writeFile(join(gateRoot, "web", "gravityport", "dist", "index.html"), "<!doctype html>", "utf8");
  });

  after(async () => {
    await rm(gateRoot, { recursive: true, force: true });
  });

  async function runGate({ distribution, releaseNotes }) {
    if (releaseNotes === undefined) {
      await rm(join(gateRoot, "release-notes.json"), { force: true });
    } else {
      await writeFile(join(gateRoot, "release-notes.json"), JSON.stringify(releaseNotes), "utf8");
    }
    const env = { ...process.env };
    if (distribution) env.MOSA_RELEASE_DISTRIBUTION = distribution;
    else delete env.MOSA_RELEASE_DISTRIBUTION;
    try {
      const stdout = execFileSync(process.execPath, [join(gateRoot, "scripts", "write-build-identity.mjs")], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true, stdout: String(stdout) };
    } catch (error) {
      return { ok: false, stderr: String(error?.stderr || "") };
    }
  }

  const gateNotes = {
    schema: 1,
    unreleased: { zh: ["一条"], en: ["One"] },
    releases: [{ version: gateVersion, date: "2026-10-17", zh: ["说明"], en: ["Note"] }],
  };

  it("fails a preview build when the version has no release-notes entry", async () => {
    const result = await runGate({ distribution: "preview", releaseNotes: { ...gateNotes, releases: [] } });
    assert.equal(result.ok, false);
    assert.match(result.stderr, new RegExp(`release-notes\\.json 缺少 ${gateVersion} 的更新说明`));
  });

  it("writes the identity once the version has a release-notes entry", async () => {
    const result = await runGate({ distribution: "preview", releaseNotes: gateNotes });
    assert.equal(result.ok, true, result.stderr);
    const identity = JSON.parse(await readFile(join(gateRoot, "web", "gravityport", "dist", "build-identity.json"), "utf8"));
    assert.equal(identity.productVersion, gateVersion);
    assert.equal(identity.distribution, "preview");
  });

  it("does not require a version entry for a development build", async () => {
    const result = await runGate({ distribution: null, releaseNotes: { ...gateNotes, releases: [] } });
    assert.equal(result.ok, true, result.stderr);
  });

  it("still validates the file format for a development build", async () => {
    const result = await runGate({
      distribution: null,
      releaseNotes: { schema: 2, unreleased: {}, releases: [] },
    });
    assert.equal(result.ok, false);
    assert.match(result.stderr, /schema/);
  });
});
