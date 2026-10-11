import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  macosUpdateArtifactName,
  macosUpdateArtifactPath,
  makeMacosUpdateZip,
} from "../scripts/make-macos-update-zip.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

test("macOS update artifact naming is version-bound and release-feed compatible", () => {
  // The legacy MOSA transition build keeps the historical artifact names.
  assert.equal(macosUpdateArtifactName("0.3.0", "arm64", "MOSA"), "MOSA-darwin-arm64-0.3.0.zip");
  assert.equal(macosUpdateArtifactName("0.3.0-rc.2", "arm64", "MOSA"), "MOSA-darwin-arm64-0.3.0-rc.2.zip");
  assert.equal(macosUpdateArtifactName("0.3.0"), "GravityPort-darwin-arm64-0.3.0.zip");
  assert.throws(() => macosUpdateArtifactName("latest"), /Invalid/);
  assert.throws(() => macosUpdateArtifactName("0.3.0", "x64"), /Unsupported/);
});

test("macOS update ZIP builder emits exact size, SHA-256, and manifest patch", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-mac-update-artifact-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.3.0" }));
    const appPath = join(root, "out", "MOSA-darwin-arm64", "MOSA.app");
    await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
    await writeFile(join(appPath, "Contents", "MacOS", "MOSA"), "binary");
    const result = await makeMacosUpdateZip({
      rootDir: root,
      product: "MOSA",
      runner: async (_command, args) => {
        const output = args.at(-1);
        await writeFile(output, "fake-zip-content");
      },
    });
    assert.equal(result.artifactName, "MOSA-darwin-arm64-0.3.0.zip");
    assert.equal(result.artifactPath, macosUpdateArtifactPath({ rootDir: root, version: "0.3.0", product: "MOSA" }));
    assert.equal((await stat(result.artifactPath)).size, result.size);
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(result.release_manifest_patch.platforms.macos, {
      platform: "macOS",
      arch: "arm64",
      file: result.artifactName,
      size: result.size,
      sha256: result.sha256,
    });
    assert.equal(await readFile(result.artifactPath, "utf8"), "fake-zip-content");
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});
