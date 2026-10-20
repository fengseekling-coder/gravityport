// third-party-licenses.test.mjs — the license folder that ships in the desktop
// package (scripts/third-party-licenses.mjs), the Vite plugin that records the
// bundled UI packages, and the forge step that ties them to the pruned app.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

import { finalizePrunedApp, resolveDesktopPackagingTarget } from "../desktop/forge.config.mjs";
import {
  LICENSE_FILES,
  collectPackageLicenses,
  electronStagingDir,
  findLicenseFile,
  libvipsComponents,
  listInstalledPackages,
  parseLibvipsLicensingTable,
  readPackageLicense,
  writeDesktopLicenses,
} from "../scripts/third-party-licenses.mjs";
import {
  BUNDLED_PACKAGES_FILE,
  bundledPackageDirs,
  bundledPackagesPlugin,
  packageRootForModuleId,
} from "../web/gravityport/bundled-packages-plugin.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

const LIBVIPS_README = [
  "# `@img/sharp-libvips-darwin-arm64`",
  "",
  "## Licensing",
  "",
  "| Library       | Used under the terms of                                   |",
  "|---------------|-----------------------------------------------------------|",
  "| aom           | BSD 2-Clause + [AOM Patent License](https://aomedia.org/) |",
  "| cairo         | Mozilla Public License 1.1                                |",
  "| libnsgif      | MIT License                                               |",
  "| libultrahdr   | MIT License                                               |",
  "| libvips       | LGPLv3                                                    |",
  "",
  "Use of libraries under the terms of the LGPLv3 is via the",
  "\"any later version\" clause of the LGPLv2 or LGPLv2.1.",
  "",
].join("\n");
const LIBVIPS_VERSIONS = { aom: "3.15.1", cairo: "1.18.6", uhdr: "2.0.2", vips: "8.18.7" };

let tempRoot;
let sequence = 0;

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "gravityport-licenses-test-"));
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

async function freshDir(label) {
  const dir = join(tempRoot, `${label}-${sequence++}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeFixture(root, relativePath, contents) {
  const path = join(root, ...relativePath.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  return path;
}

async function writePackage(nodeModules, name, { version = "1.0.0", license = "MIT", licenseFile = "LICENSE", text = `${name} license text` } = {}) {
  await writeFixture(nodeModules, `${name}/package.json`, JSON.stringify({ name, version, license }));
  if (licenseFile) await writeFixture(nodeModules, `${name}/${licenseFile}`, `${text}\r\n\r\n`);
  return join(nodeModules, ...name.split("/"));
}

/** A project root plus a packager staging tree that mirror the real macOS layout. */
async function createPackagingFixture({ electronLicense = true, gpl = true, buildOnlyPackage = false } = {}) {
  const projectRoot = await freshDir("project");
  const uiModules = join(projectRoot, "web", "gravityport", "node_modules");
  await writePackage(uiModules, "react", { version: "19.0.0" });
  await writePackage(uiModules, "scheduler", { version: "0.25.0" });
  await writeFixture(projectRoot, "web/gravityport/dist/bundled-packages.json", JSON.stringify(["node_modules/react", "node_modules/scheduler"]));
  await writeFixture(projectRoot, "desktop/licenses/LGPL-3.0.txt", "GNU LESSER GENERAL PUBLIC LICENSE\n");
  if (gpl) await writeFixture(projectRoot, "desktop/licenses/GPL-3.0.txt", "GNU GENERAL PUBLIC LICENSE\n");
  const sourceLibvips = join(projectRoot, "node_modules", "@img", "sharp-libvips-darwin-arm64");
  await writeFixture(sourceLibvips, "package.json", JSON.stringify({ name: "@img/sharp-libvips-darwin-arm64", version: "1.3.4", license: "LGPL-3.0-or-later" }));
  await writeFixture(sourceLibvips, "README.md", LIBVIPS_README);
  await writeFixture(sourceLibvips, "versions.json", JSON.stringify(LIBVIPS_VERSIONS));

  const staging = await freshDir("staging");
  if (electronLicense) await writeFixture(staging, "LICENSE", "Copyright (c) Electron contributors\n");
  await writeFixture(staging, "LICENSES.chromium.html", "<html>Chromium credits</html>\n");
  const buildPath = join(staging, "Electron.app", "Contents", "Resources", "app");
  await writeFixture(buildPath, "package.json", JSON.stringify({ name: "mosa", version: "0.3.0-test", dependencies: {} }));
  const runtimeModules = join(buildPath, "node_modules");
  await writePackage(runtimeModules, "better-sqlite3", { version: "12.0.0" });
  await writeFixture(runtimeModules, "better-sqlite3/prebuilds/darwin-arm64.node", "native");
  await writePackage(runtimeModules, "@img/sharp-darwin-arm64", { version: "0.35.5", license: "Apache-2.0" });
  await writeFixture(runtimeModules, "@img/sharp-darwin-arm64/README.md", "readme");
  await writeFixture(runtimeModules, "@img/sharp-libvips-darwin-arm64/package.json", JSON.stringify({ name: "@img/sharp-libvips-darwin-arm64", version: "1.3.4", license: "LGPL-3.0-or-later" }));
  if (buildOnlyPackage) {
    // Build-only: pruned by preparePackagedRuntime, and it has no license file,
    // so generating the folder before pruning would fail.
    await writePackage(runtimeModules, "node-addon-api", { licenseFile: null });
  }
  // Packager's ignore rules leave empty directories behind.
  await mkdir(join(runtimeModules, "adm-zip"), { recursive: true });
  return { projectRoot, staging, buildPath, outputDir: join(await freshDir("out"), "licenses") };
}

describe("bundled packages plugin", () => {
  it("finds the package root of a module, including scoped and nested packages", () => {
    assert.equal(packageRootForModuleId("/ui/node_modules/react/index.js"), "/ui/node_modules/react");
    assert.equal(packageRootForModuleId("/ui/node_modules/@scope/pkg/dist/a.js?commonjs-exports"), "/ui/node_modules/@scope/pkg");
    assert.equal(packageRootForModuleId("/ui/node_modules/a/node_modules/b/lib/c.js"), "/ui/node_modules/a/node_modules/b");
    assert.equal(packageRootForModuleId("C:\\ui\\node_modules\\react-dom\\client.js"), "C:/ui/node_modules/react-dom");
  });

  it("ignores project sources, virtual modules and tool caches", () => {
    assert.equal(packageRootForModuleId("/ui/src/App.tsx"), null);
    assert.equal(packageRootForModuleId("\0vite/modulepreload-polyfill"), null);
    assert.equal(packageRootForModuleId("/ui/node_modules/.vite/deps/react.js"), null);
  });

  it("lists package directories relative to the UI root, sorted and de-duplicated", () => {
    const dirs = bundledPackageDirs([
      "/ui/node_modules/scheduler/index.js",
      "/ui/src/main.tsx",
      "/ui/node_modules/react/index.js",
      "/ui/node_modules/react/cjs/react.production.js",
      "/repo/node_modules/shared/index.js",
    ], "/ui");
    assert.deepEqual(dirs, ["../repo/node_modules/shared", "node_modules/react", "node_modules/scheduler"]);
  });

  it("emits the list from output chunks plus the inlined packages", async () => {
    const root = await freshDir("ui");
    await writePackage(join(root, "node_modules"), "tailwindcss");
    const emitted = [];
    const plugin = bundledPackagesPlugin({ root, inlinedPackages: ["tailwindcss"] });
    plugin.generateBundle.call({ emitFile: (file) => emitted.push(file) }, {}, {
      "index.js": { type: "chunk", moduleIds: [join(root, "node_modules/react/index.js"), join(root, "src/main.tsx")] },
      "index.css": { type: "asset" },
    });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].fileName, BUNDLED_PACKAGES_FILE);
    assert.deepEqual(JSON.parse(emitted[0].source), ["node_modules/react", "node_modules/tailwindcss"]);
  });

  it("fails the build when an inlined package is not installed", async () => {
    const root = await freshDir("ui");
    const plugin = bundledPackagesPlugin({ root, inlinedPackages: ["tailwindcss"] });
    assert.throws(() => plugin.generateBundle.call({ emitFile() {} }, {}, {}), /Inlined package tailwindcss is not installed/);
  });
});

describe("package licenses", () => {
  it("recognizes the usual license file names", async () => {
    const modules = await freshDir("modules");
    for (const [name, file] of [["a", "LICENSE"], ["b", "license.md"], ["c", "LICENCE-MIT"], ["d", "COPYING"]]) {
      const dir = await writePackage(modules, name, { licenseFile: file });
      assert.equal(await findLicenseFile(dir), join(dir, file));
    }
    const none = await writePackage(modules, "e", { licenseFile: null });
    assert.equal(await findLicenseFile(none), null);
  });

  it("normalizes the text and falls back to the LGPL files only for LGPL packages", async () => {
    const modules = await freshDir("modules");
    const withText = await readPackageLicense(await writePackage(modules, "a", { text: "MIT text" }));
    assert.equal(withText.text, "MIT text");
    const lgpl = await readPackageLicense(await writePackage(modules, "b", { license: "LGPL-3.0-or-later", licenseFile: null }));
    assert.equal(lgpl.text, null);
    await assert.rejects(readPackageLicense(await writePackage(modules, "c", { licenseFile: null })), /c@1\.0\.0 has no license file \(license: MIT\)/);
  });

  it("reports every package without a license in one error", async () => {
    const modules = await freshDir("modules");
    const dirs = [
      await writePackage(modules, "ok"),
      await writePackage(modules, "first", { licenseFile: null }),
      await writePackage(modules, "second", { license: "ISC", licenseFile: null }),
    ];
    await assert.rejects(collectPackageLicenses(dirs), /first@1\.0\.0 \(MIT\), second@1\.0\.0 \(ISC\)/);
  });

  it("de-duplicates by name and version and sorts by name", async () => {
    const modules = await freshDir("modules");
    const b = await writePackage(modules, "b");
    const a = await writePackage(modules, "a");
    const entries = await collectPackageLicenses([b, a, b]);
    assert.deepEqual(entries.map(({ name }) => name), ["a", "b"]);
  });

  it("walks scoped and nested packages and skips empty or hidden directories", async () => {
    const modules = await freshDir("modules");
    await writePackage(modules, "sharp");
    await writePackage(modules, "@img/colour");
    await writePackage(join(modules, "sharp", "node_modules"), "detect-libc");
    await mkdir(join(modules, "adm-zip"), { recursive: true });
    await writePackage(modules, ".bin");
    const found = (await listInstalledPackages(modules)).map((dir) => dir.slice(modules.length + 1).replaceAll("\\", "/"));
    assert.deepEqual(found, ["@img/colour", "sharp", "sharp/node_modules/detect-libc"]);
  });
});

describe("libvips licensing table", () => {
  it("parses every row and keeps link targets", () => {
    const rows = parseLibvipsLicensingTable(LIBVIPS_README);
    assert.equal(rows.length, 5);
    assert.deepEqual(rows[0], { library: "aom", license: "BSD 2-Clause + AOM Patent License (https://aomedia.org/)" });
    assert.equal(rows[4].library, "libvips");
  });

  it("matches versions.json keys, including the renamed ones", () => {
    const byLibrary = Object.fromEntries(libvipsComponents({ readme: LIBVIPS_README, versions: LIBVIPS_VERSIONS }).map((row) => [row.library, row.version]));
    assert.deepEqual(byLibrary, { aom: "3.15.1", cairo: "1.18.6", libnsgif: "", libultrahdr: "2.0.2", libvips: "8.18.7" });
  });

  it("refuses a README without the table", () => {
    assert.throws(() => parseLibvipsLicensingTable("# no table\n"), /no licensing table/);
  });

  it("reads every row of the installed libvips package README", async (t) => {
    const target = resolveDesktopPackagingTarget({ platform: process.platform === "win32" ? "win32" : "darwin", env: {}, argv: [] });
    const readmePath = join(repositoryRoot, "node_modules", "@img", target.libvipsPackage, "README.md");
    if (!existsSync(readmePath)) {
      t.skip(`@img/${target.libvipsPackage} is not installed on this platform`);
      return;
    }
    const readme = await readFile(readmePath, "utf8");
    const tableLines = readme.split("\n").filter((line) => /^\| \S/.test(line) && !/^\| Library\b/.test(line));
    assert.equal(parseLibvipsLicensingTable(readme).length, tableLines.length);
  });
});

describe("desktop license folder", () => {
  it("locates the Electron template above the pruned app on both platforms", () => {
    assert.equal(electronStagingDir("/s/Electron.app/Contents/Resources/app", "darwin"), resolve("/s"));
    assert.equal(electronStagingDir("/s/resources/app", "win32"), resolve("/s"));
  });

  it("prunes first and then writes all five files with three sections", async () => {
    const fixture = await createPackagingFixture({ buildOnlyPackage: true });
    const target = resolveDesktopPackagingTarget({ platform: "darwin", arch: "arm64", env: {}, argv: [] });
    await finalizePrunedApp(fixture.buildPath, target, { licensesDir: fixture.outputDir, projectRoot: fixture.projectRoot });

    assert.deepEqual((await readdir(fixture.outputDir)).sort(), Object.values(LICENSE_FILES).sort());
    assert.equal(await readFile(join(fixture.outputDir, LICENSE_FILES.electron), "utf8"), "Copyright (c) Electron contributors\n");
    const notices = await readFile(join(fixture.outputDir, LICENSE_FILES.notices), "utf8");
    const sections = ["1. npm packages bundled", "2. npm packages in the desktop runtime", "3. libvips and the libraries packaged with it"];
    const positions = sections.map((heading) => notices.indexOf(heading));
    assert.ok(positions.every((position) => position >= 0), "all three sections are present");
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, "sections keep their order");
    const [frontend, runtime, libvips] = [
      notices.slice(positions[0], positions[1]),
      notices.slice(positions[1], positions[2]),
      notices.slice(positions[2]),
    ];
    assert.match(frontend, /react 19\.0\.0/);
    assert.match(frontend, /scheduler 0\.25\.0/);
    assert.match(runtime, /better-sqlite3 12\.0\.0/);
    assert.match(runtime, /@img\/sharp-darwin-arm64 0\.35\.5/);
    assert.match(runtime, /@img\/sharp-libvips-darwin-arm64 1\.3\.4\nLicense: LGPL-3\.0-or-later\n\nLicensed under LGPL-3\.0-or-later; see LGPL-3\.0\.txt/);
    assert.doesNotMatch(runtime, /node-addon-api|adm-zip/);
    assert.equal(libvips.split("\n").filter((line) => /^\S+ {2,}\S+ {2,}\S/.test(line)).length, 5);
    assert.match(libvips, /libvips\s+8\.18\.7\s+LGPLv3 \(full text: LGPL-3\.0\.txt, GPL-3\.0\.txt\)/);
    assert.match(libvips, /https:\/\/github\.com\/lovell\/sharp-libvips/);
    assert.ok(!notices.includes("\r"), "line endings are normalized");
  });

  it("writes byte-identical output on every run", async () => {
    const fixture = await createPackagingFixture();
    const options = { projectRoot: fixture.projectRoot, buildPath: fixture.buildPath, platform: "darwin", libvipsPackage: "sharp-libvips-darwin-arm64", outputDir: fixture.outputDir };
    await writeDesktopLicenses(options);
    const first = await readFile(join(fixture.outputDir, LICENSE_FILES.notices));
    await writeFixture(fixture.outputDir, "stale.txt", "left over");
    await writeDesktopLicenses(options);
    assert.deepEqual(await readFile(join(fixture.outputDir, LICENSE_FILES.notices)), first);
    assert.equal(existsSync(join(fixture.outputDir, "stale.txt")), false, "the folder is emptied before writing");
  });

  it("fails when Electron's license is not in the staging directory", async () => {
    const fixture = await createPackagingFixture({ electronLicense: false });
    await assert.rejects(
      writeDesktopLicenses({ projectRoot: fixture.projectRoot, buildPath: fixture.buildPath, platform: "darwin", libvipsPackage: "sharp-libvips-darwin-arm64", outputDir: fixture.outputDir }),
      /Missing Electron LICENSE in the packager staging directory/,
    );
  });

  it("fails when a vendored GNU license text is missing", async () => {
    const fixture = await createPackagingFixture({ gpl: false });
    await assert.rejects(
      writeDesktopLicenses({ projectRoot: fixture.projectRoot, buildPath: fixture.buildPath, platform: "darwin", libvipsPackage: "sharp-libvips-darwin-arm64", outputDir: fixture.outputDir }),
      /Missing vendored GPL-3\.0 text/,
    );
  });

  it("fails before packaging when the UI build has not recorded its packages", async () => {
    const fixture = await createPackagingFixture();
    await rm(join(fixture.projectRoot, "web", "gravityport", "dist", "bundled-packages.json"));
    await assert.rejects(
      writeDesktopLicenses({ projectRoot: fixture.projectRoot, buildPath: fixture.buildPath, platform: "darwin", libvipsPackage: "sharp-libvips-darwin-arm64", outputDir: fixture.outputDir }),
      /bundled-packages\.json is missing; run npm run build/,
    );
  });

  it("vendors the unmodified GNU texts", async () => {
    const lgpl = await readFile(join(repositoryRoot, "desktop", "licenses", "LGPL-3.0.txt"), "utf8");
    const gpl = await readFile(join(repositoryRoot, "desktop", "licenses", "GPL-3.0.txt"), "utf8");
    assert.match(lgpl, /GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/);
    assert.match(gpl, /GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/);
  });
});
