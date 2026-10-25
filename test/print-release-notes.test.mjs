// print-release-notes.test.mjs — runs the real script as a subprocess against
// fixture release-notes.json files (the repo file shape is already covered by
// release-notes.test.mjs).
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const scriptPath = join(repositoryRoot, "scripts", "print-release-notes.mjs");

let tempRoot;
let notesPath;

const FIXTURE = {
  schema: 2,
  unreleased: { zh: [], en: [] },
  releases: [
    {
      version: "0.4.0",
      date: "2026-10-25",
      zh: { new: ["新功能一"], fixed: ["修复一"] },
      en: { new: ["New one"], fixed: ["Fixed one"] },
    },
    { version: "0.3.5", date: "2026-10-23", zh: ["旧版平铺"], en: ["Legacy flat"] },
  ],
};

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "gravityport-print-notes-"));
  notesPath = join(tempRoot, "release-notes.json");
  await writeFile(notesPath, JSON.stringify(FIXTURE), "utf8");
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function run(args) {
  return execFileSync(process.execPath, [scriptPath, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

describe("print-release-notes", () => {
  it("prints sectioned zh notes as one prefixed bullet per line", () => {
    const stdout = run(["--version", "0.4.0", "--lang", "zh", "--release-notes", notesPath]);
    assert.equal(stdout, "• 新增：新功能一\n• 修复：修复一\n");
  });

  it("prints English prefixes with --lang en", () => {
    const stdout = run(["--version", "0.4.0", "--lang", "en", "--release-notes", notesPath]);
    assert.equal(stdout, "• New: New one\n• Fixed: Fixed one\n");
  });

  it("prints legacy flat notes without prefixes", () => {
    assert.equal(run(["--version", "0.3.5", "--lang", "zh", "--release-notes", notesPath]), "• 旧版平铺\n");
    assert.equal(run(["--version", "0.3.5", "--lang", "en", "--release-notes", notesPath]), "• Legacy flat\n");
  });

  it("defaults --lang to zh", () => {
    assert.equal(run(["--version", "0.4.0", "--release-notes", notesPath]), "• 新增：新功能一\n• 修复：修复一\n");
  });

  it("fails with a non-zero exit for an unknown version", () => {
    assert.throws(
      () => run(["--version", "9.9.9", "--release-notes", notesPath]),
      (error) => error.status !== 0 && /缺少 9\.9\.9 的更新说明/.test(String(error.stderr)),
    );
  });

  it("fails for an invalid --lang", () => {
    assert.throws(
      () => run(["--version", "0.4.0", "--lang", "jp", "--release-notes", notesPath]),
      (error) => error.status !== 0 && /Invalid --lang/.test(String(error.stderr)),
    );
  });
});
