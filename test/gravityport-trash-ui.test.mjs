// GravityPort trash UI helpers (trash-ui.ts) tests.
//
// The real module is compiled with tsc into a temp directory and imported from
// there (gravityport-library-actions.test.mjs pattern) — nothing is
// hand-copied into this file.
import { execFileSync } from "node:child_process";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");

let trashRemainingDays;

before(async () => {
  const compileRoot = await mkdtemp(join(tmpdir(), "mosa-gp-trash-ui-"));
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    join(uiRoot, "src", "trash-ui.ts"),
    "--outDir", compileRoot,
    "--module", "esnext",
    "--target", "es2022",
    "--moduleResolution", "bundler",
    "--skipLibCheck",
  ], { stdio: "pipe" });
  ({ trashRemainingDays } = await import(join(compileRoot, "trash-ui.js")));
  after(async () => {
    await rm(compileRoot, { recursive: true, force: true });
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;
const DELETED_AT = "2026-10-15T00:00:00.000Z";
const now = Date.parse(DELETED_AT);

describe("trash-ui / trashRemainingDays", () => {
  it("just deleted = 90", () => {
    assert.equal(trashRemainingDays(DELETED_AT, now), 90);
  });

  it("one millisecond after deletion is still 90 (rounds up)", () => {
    assert.equal(trashRemainingDays(DELETED_AT, now + 1), 90);
  });

  it("89 days and one hour = 1", () => {
    assert.equal(trashRemainingDays(DELETED_AT, now + 89 * DAY_MS + 60 * 60 * 1000), 1);
  });

  it("exactly 90 days = 0", () => {
    assert.equal(trashRemainingDays(DELETED_AT, now + 90 * DAY_MS), 0);
  });

  it("100 days = 0 (never negative)", () => {
    assert.equal(trashRemainingDays(DELETED_AT, now + 100 * DAY_MS), 0);
  });

  it("null, empty string and garbage dates = 0", () => {
    assert.equal(trashRemainingDays(null, now), 0);
    assert.equal(trashRemainingDays("", now), 0);
    assert.equal(trashRemainingDays("not-a-date", now), 0);
  });
});
