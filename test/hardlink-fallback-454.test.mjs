import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hardLinkOrCopy } from "../lib/sqlite-store/paths.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const SOURCE_BYTES = Buffer.from("task 454 hardlink fallback fixture bytes");

async function writeSource(t, name = "source.bin") {
  const root = await mkdtemp(join(tmpdir(), "mosa-hardlink-fallback-454-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sourcePath = join(root, name);
  await writeFile(sourcePath, SOURCE_BYTES);
  return { root, sourcePath };
}

function linkDeniedEacces() {
  return async () => {
    throw Object.assign(new Error("link denied"), { code: "EACCES" });
  };
}

async function sha256Of(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

test("a plain call hard-links: the target shares the source inode", async (t) => {
  const { root, sourcePath } = await writeSource(t);
  const targetPath = join(root, "target.bin");

  const result = await hardLinkOrCopy(sourcePath, targetPath);

  assert.equal(result, "hard-link");
  const [sourceStat, targetStat] = await Promise.all([stat(sourcePath), stat(targetPath)]);
  assert.equal(targetStat.ino, sourceStat.ino, "target and source are the same inode");
});

test("a link failure for any reason falls back to a byte-identical copy", async (t) => {
  const { root, sourcePath } = await writeSource(t);
  const targetPath = join(root, "target.bin");

  const result = await hardLinkOrCopy(sourcePath, targetPath, { linkFile: linkDeniedEacces() });

  assert.equal(result, "copy");
  const [sourceStat, targetStat] = await Promise.all([stat(sourcePath), stat(targetPath)]);
  assert.notEqual(targetStat.ino, sourceStat.ino, "the fallback wrote its own file");
  assert.deepEqual(await readFile(targetPath), SOURCE_BYTES, "target bytes match the source byte for byte");
});

test("an existing target still fails the copy with EEXIST carrying the link error as cause", async (t) => {
  const { root, sourcePath } = await writeSource(t);
  const targetPath = join(root, "target.bin");
  const existingBytes = Buffer.from("older content that must survive");
  await writeFile(targetPath, existingBytes);
  const beforeDigest = await sha256Of(targetPath);
  const beforeStat = await stat(targetPath);

  await assert.rejects(
    hardLinkOrCopy(sourcePath, targetPath, { linkFile: linkDeniedEacces() }),
    (error) => error.code === "EEXIST" && error.cause?.code === "EACCES",
  );

  const afterStat = await stat(targetPath);
  assert.equal(afterStat.ino, beforeStat.ino, "the target file was not replaced");
  const afterDigest = await sha256Of(targetPath);
  assert.equal(afterDigest, beforeDigest, `target sha256 unchanged: ${beforeDigest}`);
  console.log(`target sha256 before: ${beforeDigest}`);
  console.log(`target sha256 after:  ${afterDigest}`);
  assert.deepEqual(await readFile(targetPath), existingBytes, "the target bytes are unchanged");
});

test("a missing source fails with ENOENT and leaves no target", async (t) => {
  const { root } = await writeSource(t);
  const sourcePath = join(root, "gone.bin");
  const targetPath = join(root, "target.bin");

  await assert.rejects(hardLinkOrCopy(sourcePath, targetPath), (error) => error.code === "ENOENT");

  await assert.rejects(stat(targetPath), (error) => error.code === "ENOENT", "no target was created");
});
