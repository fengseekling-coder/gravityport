#!/usr/bin/env node
// Provisions the two optional darwin-x64 Sharp packages that `npm ci` does not
// install on an Apple-silicon Mac (npm resolves optional dependencies by the
// host platform/arch). The Intel desktop package needs them, so the darwin-x64
// packaging and release scripts run this first.
//
// The tarball is downloaded with `npm pack <name>@<version>` and its sha512
// must match the `integrity` recorded in package-lock.json before anything is
// unpacked. The script never edits package.json or package-lock.json and never
// touches the rest of the dependency tree (it deliberately avoids
// `npm install --cpu/--os`, which would rewrite the whole tree).

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DARWIN_X64_NATIVE_PACKAGES = Object.freeze([
  "@img/sharp-darwin-x64",
  "@img/sharp-libvips-darwin-x64",
]);

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function darwinX64NativeSpecs(lockfile, packages = DARWIN_X64_NATIVE_PACKAGES) {
  const specs = [];
  for (const name of packages) {
    const entry = lockfile?.packages?.[`node_modules/${name}`];
    if (!entry || typeof entry !== "object") {
      throw new Error(`package-lock.json has no entry for ${name}; cannot provision the darwin-x64 Sharp runtime.`);
    }
    const version = String(entry.version || "").trim();
    const integrity = String(entry.integrity || "").trim();
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error(`package-lock.json has no usable version for ${name}.`);
    }
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
      throw new Error(`package-lock.json has no sha512 integrity for ${name}.`);
    }
    specs.push(Object.freeze({ name, version, integrity }));
  }
  return specs;
}

// npm integrity strings are `sha512-<base64>`; the tarball digest must match
// that exact base64 value, not merely decode to the same bytes.
export function tarballIntegrityMatches(integrity, digestBase64) {
  const expected = String(integrity || "").replace(/^sha512-/, "");
  const actual = String(digestBase64 || "");
  return expected.length > 0 && actual.length > 0 && expected === actual;
}

async function sha512Base64(filePath) {
  const hash = createHash("sha512");
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash());
  });
  return hash.digest("base64");
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    execFile(command, args, { cwd: rootDir, ...options }, (error, stdout, stderr) => {
      if (error) {
        rejectRun(new Error(`${command} ${args.join(" ")} failed: ${String(stderr || error.message).trim()}`));
        return;
      }
      resolveRun(String(stdout || ""));
    });
  });
}

async function installedVersion(packageDir) {
  const manifestPath = join(packageDir, "package.json");
  const manifest = await readFile(manifestPath, "utf8").then(
    (text) => JSON.parse(text),
    () => null,
  );
  return typeof manifest?.version === "string" ? manifest.version : "";
}

async function provisionPackage(spec, { root = rootDir, runImpl = run, packImpl = null } = {}) {
  const packageDir = join(root, "node_modules", "@img", spec.name.replace(/^@img\//, ""));
  if ((await installedVersion(packageDir)) === spec.version) {
    return { name: spec.name, action: "already-provisioned", version: spec.version };
  }

  const scratch = await mkdtemp(join(tmpdir(), "mosa-provision-x64-"));
  try {
    const pack = packImpl || ((destination) => runImpl("npm", ["pack", `${spec.name}@${spec.version}`, "--pack-destination", destination], { cwd: root }));
    await pack(scratch);
    const tarballs = (await readdir(scratch)).filter((name) => name.endsWith(".tgz"));
    if (tarballs.length !== 1) {
      throw new Error(`npm pack for ${spec.name}@${spec.version} produced ${tarballs.length} tarballs, expected exactly one.`);
    }
    const tarballPath = join(scratch, tarballs[0]);
    const digest = await sha512Base64(tarballPath);
    if (!tarballIntegrityMatches(spec.integrity, digest)) {
      throw new Error(
        `Downloaded ${spec.name}@${spec.version} does not match the package-lock.json integrity; refusing to unpack it.`,
      );
    }
    await rm(packageDir, { recursive: true, force: true });
    await mkdir(packageDir, { recursive: true });
    await runImpl("/usr/bin/tar", ["-xzf", tarballPath, "-C", packageDir, "--strip-components", "1"]);
    const unpackedVersion = await installedVersion(packageDir);
    if (unpackedVersion !== spec.version) {
      throw new Error(`Provisioned ${spec.name} reports version ${unpackedVersion || "(missing)"}, expected ${spec.version}.`);
    }
    return { name: spec.name, action: "provisioned", version: spec.version };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function provisionDarwinX64Natives(options = {}) {
  if (process.platform !== "darwin") {
    throw new Error("darwin-x64 Sharp natives are provisioned on macOS only.");
  }
  const projectRoot = resolve(options.root || rootDir);
  const lockfile = JSON.parse(await readFile(join(projectRoot, "package-lock.json"), "utf8"));
  const specs = darwinX64NativeSpecs(lockfile, options.packages);
  const results = [];
  for (const spec of specs) {
    results.push(await provisionPackage(spec, { ...options, root: projectRoot }));
  }
  return results;
}

async function main() {
  const results = await provisionDarwinX64Natives();
  for (const result of results) {
    console.log(`[MOSA] ${result.name}@${result.version}: ${result.action}`);
  }
  console.log("[MOSA] darwin-x64 Sharp natives ready.");
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`[MOSA] darwin-x64 native provisioning failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
