import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clipboardImageTarget } from "../desktop/clipboard-image-path.mjs";

function makeScratch() {
  const root = mkdtempSync(join(tmpdir(), "mosa-clipboard-image-"));
  const libraryDir = join(root, "library");
  mkdirSync(libraryDir);
  const insideFile = join(libraryDir, "inside.png");
  writeFileSync(insideFile, "png-bytes");
  const outsideFile = join(root, "outside.png");
  writeFileSync(outsideFile, "outside-bytes");
  return { root, libraryDir, insideFile, outsideFile };
}

// A fake fs that only carries the target-probing methods and records every
// call. realpathSync is deliberately absent: the literal containment check
// may realpath the LIBRARY root only, so an out-of-library request must end
// without touching this fake at all.
function probeFs(calls, { resolveLstat = false } = {}) {
  const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const fake = {
    existsSync: (path) => { calls.push(["existsSync", path]); return true; },
    statSync: (path) => { calls.push(["statSync", path]); throw enoent(); },
  };
  fake.lstatSync = resolveLstat
    ? (path) => { calls.push(["lstatSync", path]); return realFs.lstatSync(path); }
    : (path) => { calls.push(["lstatSync", path]); throw enoent(); };
  return fake;
}

test("out-of-library paths are refused without probing them, existing or not", () => {
  const { root, libraryDir, outsideFile } = makeScratch();
  const missingOutside = join(root, "never-created.png");

  const callsExisting = [];
  const existing = clipboardImageTarget(outsideFile, libraryDir, probeFs(callsExisting));
  assert.deepEqual(existing, { ok: false, reason: "not-allowed" });
  assert.deepEqual(callsExisting, [], "an out-of-library request must not touch the filesystem at all");

  const callsMissing = [];
  const missing = clipboardImageTarget(missingOutside, libraryDir, probeFs(callsMissing));
  assert.deepEqual(missing, { ok: false, reason: "not-allowed" });
  assert.deepEqual(callsMissing, []);

  // The two answers are byte-for-byte identical: no existence oracle.
  assert.deepEqual(existing, missing);

  rmSync(root, { recursive: true, force: true });
});

test("library-internal paths keep their original answers", () => {
  const { root, libraryDir, insideFile, outsideFile } = makeScratch();
  const calls = [];
  const fs = probeFs(calls, { resolveLstat: true });

  // In-library missing file → missing.
  assert.deepEqual(clipboardImageTarget(join(libraryDir, "nope.png"), libraryDir, fs), { ok: false, reason: "missing" });

  // In-library symlink pointing outside → not-allowed.
  const linkPath = join(libraryDir, "link.png");
  symlinkSync(outsideFile, linkPath);
  assert.deepEqual(clipboardImageTarget(linkPath, libraryDir, fs), { ok: false, reason: "not-allowed" });

  // In-library real file → ok with the canonical path.
  const allowed = clipboardImageTarget(insideFile, libraryDir, fs);
  assert.deepEqual(allowed, { ok: true, path: realpathSync(insideFile) });

  // Out-of-library absolute path whose target exists → still refused, and the
  // probe fs never saw the target.
  const before = calls.length;
  assert.deepEqual(clipboardImageTarget(outsideFile, libraryDir, fs), { ok: false, reason: "not-allowed" });
  assert.ok(calls.slice(before).every(([, path]) => !String(path).includes("outside.png")),
    "the literal check must precede any filesystem probe of the target");

  rmSync(root, { recursive: true, force: true });
});

test("invalid requests keep their original reason", () => {
  const { root, libraryDir } = makeScratch();
  const cases = [
    "",
    "   ",
    "relative/path.png",
    "http://example.com/a.png",
    "https://example.com/a.png",
    42,
    null,
    undefined,
  ];
  for (const requested of cases) {
    assert.deepEqual(clipboardImageTarget(requested, libraryDir), { ok: false, reason: "invalid" }, String(requested));
  }
  rmSync(root, { recursive: true, force: true });
});

test("a symlinked library directory accepts paths spelled either way", () => {
  const { root, libraryDir, insideFile, outsideFile } = makeScratch();
  const linkPath = join(root, "library-link");
  symlinkSync(libraryDir, linkPath, "dir");

  // Spelled through the symlink → ok.
  const throughLink = clipboardImageTarget(join(linkPath, "inside.png"), linkPath);
  assert.deepEqual(throughLink, { ok: true, path: realpathSync(insideFile) });

  // Spelled through the library's realpath while the configured dir is the
  // symlink → the realpath containment branch keeps it allowed.
  const throughReal = clipboardImageTarget(join(realpathSync(libraryDir), "inside.png"), linkPath);
  assert.deepEqual(throughReal, { ok: true, path: realpathSync(insideFile) });

  // An out-of-library sibling stays refused either way.
  assert.deepEqual(clipboardImageTarget(outsideFile, linkPath), { ok: false, reason: "not-allowed" });

  rmSync(root, { recursive: true, force: true });
});

test("a broken or unreadable library root fails closed", () => {
  const missingLibrary = join(tmpdir(), "mosa-clipboard-image-never", "library");
  assert.deepEqual(clipboardImageTarget("/etc/hosts", missingLibrary), { ok: false, reason: "not-allowed" });
  assert.deepEqual(clipboardImageTarget("/etc/hosts", ""), { ok: false, reason: "not-allowed" });
});
