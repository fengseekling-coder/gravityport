import assert from "node:assert/strict";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  makeWindowsUpdateZip,
  windowsUpdateArtifactName,
  windowsUpdateArtifactPath,
  windowsUpdateZipCommand,
} from "../scripts/make-windows-update-zip.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

test("Windows update artifact naming is version-bound and release-feed compatible", () => {
  // The legacy MOSA transition build keeps the historical artifact names.
  assert.equal(windowsUpdateArtifactName("0.3.0", "x64", "MOSA"), "MOSA-win32-x64-0.3.0.zip");
  assert.equal(windowsUpdateArtifactName("0.3.0-rc.2", "x64", "MOSA"), "MOSA-win32-x64-0.3.0-rc.2.zip");
  assert.equal(windowsUpdateArtifactName("0.3.0"), "GravityPort-win32-x64-0.3.0.zip");
  assert.throws(() => windowsUpdateArtifactName("latest"), /Invalid/);
  assert.throws(() => windowsUpdateArtifactName("0.3.0", "arm64"), /Unsupported/);
});

test("Windows update ZIP commands preserve the product root directory", () => {
  const packageDir = "/tmp/build/MOSA-win32-x64";
  const output = "/tmp/build/out.zip";
  const posix = windowsUpdateZipCommand({ packageDir, output, platform: "darwin" });
  assert.equal(posix.command, "zip");
  assert.deepEqual(posix.args.slice(-1), ["MOSA-win32-x64"]);
  assert.equal(posix.options.cwd, "/tmp/build");

  const windows = windowsUpdateZipCommand({
    packageDir: "C:\\build\\MOSA-win32-x64",
    output: "C:\\build\\out.zip",
    platform: "win32",
  });
  assert.equal(windows.command, "powershell.exe");
  assert.match(windows.args.at(-1), /\$rootName \+ '\/'/);
  assert.match(windows.args.at(-1), /\$relative\.Replace\(\[char\]92, \[char\]47\)/);
  assert.doesNotMatch(windows.args.at(-1), /-replace/);
  assert.match(windows.args.at(-1), /CreateEntryFromFile/);
  assert.match(windows.options.env.MOSA_WINDOWS_UPDATE_SOURCE, /MOSA-win32-x64$/);
});

test("Windows update ZIP builder emits exact metadata and rejects flat layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-win-update-artifact-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.3.0" }));
    const packageDir = join(root, "out", "MOSA-win32-x64");
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, "MOSA.exe"), "binary");
    let flat = false;
    const runner = async (command, args) => {
      if (command === "zip") {
        await writeFile(args[2], "fake-zip-content");
        return { stdout: "", stderr: "" };
      }
      if (command === "unzip") {
        return {
          stdout: flat ? "MOSA.exe\nresources/app.asar\n" : "MOSA-win32-x64/MOSA.exe\nMOSA-win32-x64/resources/app.asar\n",
          stderr: "",
        };
      }
      throw new Error(`unexpected command: ${command}`);
    };

    const result = await makeWindowsUpdateZip({ rootDir: root, platform: "darwin", product: "MOSA", runner });
    assert.equal(result.artifactName, "MOSA-win32-x64-0.3.0.zip");
    assert.equal(result.artifactPath, windowsUpdateArtifactPath({ rootDir: root, version: "0.3.0", product: "MOSA" }));
    assert.equal((await stat(result.artifactPath)).size, result.size);
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(result.release_manifest_patch.platforms.windows, {
      platform: "Windows",
      arch: "x64",
      file: result.artifactName,
      size: result.size,
      sha256: result.sha256,
    });

    flat = true;
    await assert.rejects(
      makeWindowsUpdateZip({ rootDir: root, platform: "darwin", product: "MOSA", runner }),
      /missing MOSA-win32-x64\/MOSA\.exe/,
    );
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});
