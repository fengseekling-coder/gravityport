#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeReleaseManifestTrust } from "../lib/release-manifest-signature.mjs";
import { normalizeDesktopDistribution } from "../lib/release-distribution.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function assertReleaseProvenance({
  version,
  head,
  status,
  tags = [],
  remoteBranches = [],
  remoteTagSha = "",
  buildIdentity,
} = {}) {
  const cleanVersion = String(version || "").trim();
  const cleanHead = String(head || "").trim();
  const expectedTag = `v${cleanVersion}`;
  const normalizedTags = (Array.isArray(tags) ? tags : []).map((value) => String(value).trim()).filter(Boolean);
  const normalizedRemoteBranches = (Array.isArray(remoteBranches) ? remoteBranches : [])
    .map((value) => String(value).trim())
    .filter(Boolean);

  if (!cleanVersion) throw new Error("Release provenance requires package.json version.");
  if (!SHA_PATTERN.test(cleanHead)) throw new Error("Release provenance requires a full Git HEAD SHA.");
  if (String(status || "").trim()) throw new Error("Release provenance requires a clean Git worktree.");
  if (!normalizedTags.includes(expectedTag)) {
    throw new Error(`Release commit must carry immutable tag ${expectedTag}.`);
  }
  if (!normalizedRemoteBranches.length) {
    throw new Error("Release commit is not reachable from any fetched remote branch; push it before building artifacts.");
  }
  if (String(remoteTagSha || "").trim() !== cleanHead) {
    throw new Error(`Remote release tag ${expectedTag} must resolve to HEAD ${cleanHead}; push the immutable tag before building artifacts.`);
  }
  if (!buildIdentity || typeof buildIdentity !== "object") {
    throw new Error("Release build identity is missing. Run npm run build first.");
  }
  if (buildIdentity.productVersion !== cleanVersion) {
    throw new Error(`Build identity version ${buildIdentity.productVersion || "(missing)"} does not match ${cleanVersion}.`);
  }
  if (buildIdentity.gitSha !== cleanHead) {
    throw new Error(`Build identity gitSha ${buildIdentity.gitSha || "(missing)"} does not match HEAD ${cleanHead}.`);
  }
  for (const field of ["uiFingerprint", "runtimeFingerprint"]) {
    if (!/^[0-9a-f]{64}$/i.test(String(buildIdentity[field] || ""))) {
      throw new Error(`Build identity ${field} is missing or invalid.`);
    }
  }
  const distribution = normalizeDesktopDistribution(buildIdentity.distribution, { releaseOnly: true });
  normalizeReleaseManifestTrust(buildIdentity.releaseManifestTrust);
  return { version: cleanVersion, head: cleanHead, tag: expectedTag, remoteBranches: normalizedRemoteBranches, distribution };
}

function gitLines(args, cwd = rootDir) {
  return execFileSync("git", args, { cwd, encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function readReleaseProvenance(projectRoot = rootDir) {
  const root = resolve(projectRoot);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  // Desktop and web releases share the built UI's build-identity.json
  const buildIdentity = JSON.parse(readFileSync(join(root, "web", "gravityport", "dist", "build-identity.json"), "utf8"));
  const head = gitLines(["rev-parse", "HEAD"], root)[0] || "";
  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
  const tags = gitLines(["tag", "--points-at", "HEAD"], root);
  const remoteBranches = gitLines(["branch", "-r", "--contains", "HEAD"], root);
  const expectedTag = `v${pkg.version}`;
  const remoteTagLines = gitLines([
    "ls-remote",
    "--tags",
    "origin",
    `refs/tags/${expectedTag}`,
    `refs/tags/${expectedTag}^{}`,
  ], root);
  const peeled = remoteTagLines.find((line) => line.endsWith(`refs/tags/${expectedTag}^{}`));
  const direct = remoteTagLines.find((line) => line.endsWith(`refs/tags/${expectedTag}`));
  const remoteTagSha = String((peeled || direct || "").split(/\s+/)[0] || "").trim();
  return { version: pkg.version, head, status, tags, remoteBranches, remoteTagSha, buildIdentity };
}

async function main() {
  const result = assertReleaseProvenance(readReleaseProvenance(rootDir));
  console.log(`[MOSA] Release provenance verified: ${result.tag} ${result.head}; remote refs: ${result.remoteBranches.join(", ")}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`[MOSA] release provenance verification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
