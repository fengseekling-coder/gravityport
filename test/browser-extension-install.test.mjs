import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile, cp } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installManagedExtension, managedExtensionPaths, readManagedExtension } from "../lib/browser-extension-install.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "mosa-managed-ext-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = join(root, "source");
  const userDataDir = join(root, "user");
  await mkdir(sourceDir);
  const version = async (number) => writeFile(join(sourceDir, "manifest.json"),
    JSON.stringify({ manifest_version: 3, version: number, key: "fixed-key", background: { service_worker: "background.js" } }));
  await version("0.15.46");
  await writeFile(join(sourceDir, "background.js"), "new background");
  await writeFile(join(sourceDir, "content.js"), "new content");
  const target = managedExtensionPaths(userDataDir).target;
  return { root, sourceDir, userDataDir, target, version,
    install: (options = {}) => installManagedExtension({
      sourceDir, userDataDir, randomUUID: () => "uuid-123", now: () => new Date("2026-11-02T00:00:00Z"), ...options,
    }) };
}

async function installed(f) {
  const result = await f.install();
  assert.equal(result.action, "installed");
  assert.equal(result.installId, "uuid-123");
  const marker = JSON.parse(await readFile(join(f.target, "gravityport-managed.json"), "utf8"));
  assert.deepEqual(marker, { schema: 1, installId: "uuid-123", version: "0.15.46", installedAt: "2026-11-02T00:00:00.000Z" });
  assert.equal(await readFile(join(f.target, "background.js"), "utf8"), "new background");
  assert.deepEqual(await readManagedExtension(f.target), { version: "0.15.46", installId: "uuid-123", path: f.target });
}

test("fresh install creates a pinned-key managed folder", async (t) => {
  const f = await fixture(t);
  await installed(f);
  assert.equal((await readdir(f.target)).length, 4);
  assert.ok((await stat(f.target)).isDirectory());
});

test("same source does not write any target files", async (t) => {
  const f = await fixture(t);
  await installed(f);
  const files = await readdir(f.target);
  const before = await Promise.all(files.map(async (file) => (await stat(join(f.target, file))).mtimeMs));
  assert.equal((await f.install()).action, "unchanged");
  assert.deepEqual(await Promise.all(files.map(async (file) => (await stat(join(f.target, file))).mtimeMs)), before);
  assert.ok((await stat(f.target)).isDirectory());
});

test("upgrade retains install ID and clears staging directories", async (t) => {
  const f = await fixture(t);
  await installed(f);
  await f.version("0.15.47");
  assert.deepEqual(await f.install(), { action: "updated", installId: "uuid-123", version: "0.15.47" });
  assert.deepEqual((await readdir(join(f.userDataDir, "browser-extension"))).sort(), ["chrome"]);
  assert.ok((await stat(f.target)).isDirectory());
});

test("newer target is never downgraded or touched", async (t) => {
  const f = await fixture(t);
  await installed(f);
  await f.version("0.15.50");
  await f.install();
  await f.version("0.15.47");
  const before = await readFile(join(f.target, "manifest.json"));
  assert.equal((await f.install()).action, "skipped-newer");
  assert.deepEqual(await readFile(join(f.target, "manifest.json")), before);
  assert.ok((await stat(f.target)).isDirectory());
});

test("same version but edited bytes are repaired", async (t) => {
  const f = await fixture(t);
  await installed(f);
  await writeFile(join(f.target, "content.js"), "tampered");
  assert.equal((await f.install()).action, "updated");
  assert.equal(await readFile(join(f.target, "content.js"), "utf8"), "new content");
  assert.ok((await stat(f.target)).isDirectory());
});

test("a crashed swap recovers .previous before version comparison", async (t) => {
  const f = await fixture(t);
  await installed(f);
  await rename(f.target, f.target + ".previous");
  assert.equal((await f.install()).action, "unchanged");
  assert.ok((await stat(f.target)).isDirectory());
});

test("failed staging-to-target rename restores previous files", async (t) => {
  const f = await fixture(t);
  await installed(f);
  await f.version("0.15.47");
  const mockFs = { ...fs, rename: async (from, to) => {
    if (from === f.target + ".staging" && to === f.target) throw new Error("injected rename failure");
    return rename(from, to);
  } };
  await assert.rejects(f.install({ fs: mockFs }), /injected rename failure/);
  assert.equal((await readManagedExtension(f.target)).version, "0.15.46");
  assert.equal(await readFile(join(f.target, "content.js"), "utf8"), "new content");
  assert.ok((await stat(f.target)).isDirectory());
});

test("EBUSY fallback updates in place, drops safe extras but leaves notes", async (t) => {
  const f = await fixture(t);
  await installed(f);
  await writeFile(join(f.target, "old.js"), "obsolete");
  await writeFile(join(f.target, "notes.txt"), "retain");
  await f.version("0.15.47");
  const mockFs = { ...fs, rename: async (from, to) => {
    if (from === f.target && to === f.target + ".previous") {
      throw Object.assign(new Error("locked"), { code: "EBUSY" });
    }
    return rename(from, to);
  } };
  assert.equal((await f.install({ fs: mockFs })).action, "updated");
  assert.equal((await readManagedExtension(f.target)).version, "0.15.47");
  assert.equal(await readFile(join(f.target, "notes.txt"), "utf8"), "retain");
  assert.equal((await readdir(f.target)).includes("old.js"), false);
  assert.ok((await stat(f.target)).isDirectory());
});

test("tampered staging manifest key is rejected without changing target", async (t) => {
  const f = await fixture(t);
  await installed(f);
  await f.version("0.15.47");
  await assert.rejects(f.install({ copySource: async (source, staging) => {
    await cp(source, staging, { recursive: true });
    await writeFile(join(staging, "manifest.json"),
      JSON.stringify({ version: "0.15.47", key: "different" }));
  } }), /staging validation failed/);
  assert.equal((await readManagedExtension(f.target)).version, "0.15.46");
  assert.ok((await stat(f.target)).isDirectory());
});
