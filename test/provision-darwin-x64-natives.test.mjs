import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DARWIN_X64_NATIVE_PACKAGES,
  darwinX64NativeSpecs,
  provisionDarwinX64Natives,
  tarballIntegrityMatches,
} from "../scripts/provision-darwin-x64-natives.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

const REAL_LOCKFILE = new URL("../package-lock.json", import.meta.url);

test("the darwin-x64 native specs come from the real lockfile with sha512 integrity", async () => {
  const lockfile = JSON.parse(await readFile(REAL_LOCKFILE, "utf8"));
  const specs = darwinX64NativeSpecs(lockfile);
  assert.deepEqual(specs.map((spec) => spec.name), [...DARWIN_X64_NATIVE_PACKAGES]);
  for (const spec of specs) {
    assert.match(spec.version, /^\d+\.\d+\.\d+/, `${spec.name} has a version`);
    assert.match(spec.integrity, /^sha512-/, `${spec.name} has sha512 integrity`);
  }
});

test("darwinX64NativeSpecs refuses lockfiles that cannot pin the x64 packages", () => {
  const good = { packages: { "node_modules/@img/sharp-darwin-x64": { version: "0.35.5", integrity: "sha512-AAAABBBB" } } };
  assert.deepEqual(darwinX64NativeSpecs(good, ["@img/sharp-darwin-x64"]), [
    { name: "@img/sharp-darwin-x64", version: "0.35.5", integrity: "sha512-AAAABBBB" },
  ]);
  assert.throws(() => darwinX64NativeSpecs({ packages: {} }, ["@img/sharp-darwin-x64"]), /no entry for @img\/sharp-darwin-x64/);
  assert.throws(
    () => darwinX64NativeSpecs({ packages: { "node_modules/@img/sharp-darwin-x64": { version: "0.35.5" } } }, ["@img/sharp-darwin-x64"]),
    /no sha512 integrity/,
  );
  assert.throws(
    () => darwinX64NativeSpecs({ packages: { "node_modules/@img/sharp-darwin-x64": { version: "next", integrity: "sha512-AAAABBBB" } } }, ["@img/sharp-darwin-x64"]),
    /no usable version/,
  );
});

test("tarball integrity compares the exact base64 sha512 value", () => {
  const digest = createHash("sha512").update("tarball-bytes").digest("base64");
  assert.equal(tarballIntegrityMatches(`sha512-${digest}`, digest), true);
  assert.equal(tarballIntegrityMatches("sha512-OTHER", digest), false);
  assert.equal(tarballIntegrityMatches("", digest), false);
  assert.equal(tarballIntegrityMatches("sha512-AAA", ""), false);
});

test("provisionDarwinX64Natives unpacks only integrity-verified tarballs and skips a matching install", async () => {
  const MAY_RUN_HERE = process.platform === "darwin" && !(process.getuid && process.getuid() === 0);
  if (!MAY_RUN_HERE) return;
  const root = await mkdtemp(join(tmpdir(), "mosa-provision-x64-"));
  const packCalls = [];
  try {
    // Build a real tarball per package, exactly the way npm pack lays one out
    // (a package/ root), then pin its actual sha512 into the lockfile.
    const source = await mkdtemp(join(tmpdir(), "mosa-provision-src-"));
    const tarballFor = new Map();
    for (const [index, name] of DARWIN_X64_NATIVE_PACKAGES.entries()) {
      const pkgDir = join(source, name.replace(/^@img\//, ""));
      await mkdir(join(pkgDir, "package", "lib"), { recursive: true });
      await writeFile(join(pkgDir, "package", "package.json"), JSON.stringify({ name, version: `1.0.${index}` }));
      await writeFile(join(pkgDir, "package", "lib", "native.node"), `${name} bytes`);
      const tgz = join(pkgDir, "pack.tgz");
      execFileSync("/usr/bin/tar", ["-czf", tgz, "-C", pkgDir, "package"]);
      tarballFor.set(name, tgz);
    }
    const lockfile = {
      packages: Object.fromEntries(await Promise.all(DARWIN_X64_NATIVE_PACKAGES.map(async (name) => [
        `node_modules/${name}`,
        {
          version: "placeholder",
          integrity: `sha512-${createHash("sha512").update(await readFile(tarballFor.get(name))).digest("base64")}`,
        },
      ]))),
    };
    for (const [index, name] of DARWIN_X64_NATIVE_PACKAGES.entries()) {
      lockfile.packages[`node_modules/${name}`].version = `1.0.${index}`;
    }
    await writeFile(join(root, "package-lock.json"), JSON.stringify(lockfile));

    const packImpl = async (destination) => {
      // Later calls (the mismatch case below) just fetch a throwaway tarball;
      // the integrity gate rejects it before anything is unpacked.
      const name = DARWIN_X64_NATIVE_PACKAGES[packCalls.length] || DARWIN_X64_NATIVE_PACKAGES[0];
      packCalls.push(name);
      await copyFile(tarballFor.get(name), join(destination, `img-${name.replace(/^@img\//, "")}.tgz`));
    };

    const first = await provisionDarwinX64Natives({ root, packImpl });
    assert.deepEqual(first.map((entry) => entry.action), ["provisioned", "provisioned"]);
    for (const [index, name] of DARWIN_X64_NATIVE_PACKAGES.entries()) {
      const packageDir = join(root, "node_modules", "@img", name.replace(/^@img\//, ""));
      const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
      assert.equal(manifest.version, `1.0.${index}`);
      assert.equal(await readFile(join(packageDir, "lib", "native.node"), "utf8"), `${name} bytes`);
    }
    assert.deepEqual(packCalls, [...DARWIN_X64_NATIVE_PACKAGES]);

    // A second run with the same versions skips the download entirely.
    const second = await provisionDarwinX64Natives({ root, packImpl });
    assert.deepEqual(second.map((entry) => entry.action), ["already-provisioned", "already-provisioned"]);
    assert.deepEqual(packCalls, [...DARWIN_X64_NATIVE_PACKAGES]);

    // A tarball that does not match the pinned integrity never reaches disk.
    await writeFile(join(root, "package-lock.json"), JSON.stringify({
      packages: {
        "node_modules/@img/sharp-darwin-x64": { version: "9.9.9", integrity: `sha512-${"B".repeat(86)}==` },
      },
    }));
    await assert.rejects(
      provisionDarwinX64Natives({ root, packImpl, packages: ["@img/sharp-darwin-x64"] }),
      /does not match the package-lock\.json integrity/,
    );
    assert.equal(packCalls.length, 3, "the mismatched tarball was fetched but refused");
    // The refusal happened before anything was unpacked, so the previously
    // provisioned copy is untouched.
    const surviving = JSON.parse(await readFile(join(root, "node_modules", "@img", "sharp-darwin-x64", "package.json"), "utf8"));
    assert.equal(surviving.version, "1.0.0");
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});
