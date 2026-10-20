// Builds the licenses/ folder that the desktop package carries in its
// Resources directory (macOS: GravityPort.app/Contents/Resources/licenses/,
// Windows: resources\licenses\). Electron's own license files sit next to the
// .app in the packager output, which the DMG and update ZIP leave out, and the
// web bundle drops the license texts of the packages it inlines, so every text
// users are owed is gathered here.
//
// desktop/forge.config.mjs runs this from the packageAfterPrune hook: the
// pruned app tree then holds exactly the runtime packages that ship, and
// Electron's extracted template (with LICENSE and LICENSES.chromium.html) is
// the staging root above it. Packager copies extraResource after this hook and
// before signing, so the folder never has to be added to a signed bundle.

import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export const LICENSES_DIR_NAME = "licenses";
export const LICENSE_FILES = Object.freeze({
  electron: "ELECTRON-LICENSE.txt",
  chromium: "LICENSES.chromium.html",
  lgpl: "LGPL-3.0.txt",
  gpl: "GPL-3.0.txt",
  notices: "THIRD_PARTY_LICENSES.txt",
});
export const BUNDLED_PACKAGES_PATH = join("web", "gravityport", "dist", "bundled-packages.json");

const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying)(?:[.-].*)?$/i;
const LGPL_LICENSE_PATTERN = /\bLGPL-3\.0(?:-or-later|-only|\+)?\b/;
const LIBVIPS_SOURCE_URL = "https://github.com/lovell/sharp-libvips";
// versions.json keys that do not follow the "drop the lib prefix" rule.
const LIBVIPS_VERSION_KEYS = Object.freeze({ libultrahdr: "uhdr" });

export function desktopLicensesOutputDir({ outDir = "out", projectRoot = PROJECT_ROOT } = {}) {
  return resolve(projectRoot, outDir, ".desktop-licenses", LICENSES_DIR_NAME);
}

/** Root of the extracted Electron template that holds the pruned app at `buildPath`. */
export function electronStagingDir(buildPath, platform) {
  // macOS: <staging>/Electron.app/Contents/Resources/app; Windows: <staging>/resources/app.
  return platform === "darwin" ? resolve(buildPath, "..", "..", "..", "..") : resolve(buildPath, "..", "..");
}

// Plain code-unit order, so the output does not depend on the build machine's locale.
function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeText(text) {
  return String(text).replace(/\r\n?/g, "\n").replace(/\s+$/, "");
}

async function isDirectory(path) {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

async function isFile(path) {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}

export async function findLicenseFile(packageDir) {
  const names = (await readdir(packageDir).catch(() => [])).filter((name) => LICENSE_FILE_PATTERN.test(name)).sort();
  for (const name of names) {
    if (await isFile(join(packageDir, name))) return join(packageDir, name);
  }
  return null;
}

/** { name, version, license, text } for one installed package; text is null when only the LGPL files apply. */
export async function readPackageLicense(packageDir) {
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  const name = String(manifest.name || "");
  const version = String(manifest.version || "");
  const license = typeof manifest.license === "string" ? manifest.license : String(manifest.license?.type || "");
  const licenseFile = await findLicenseFile(packageDir);
  if (licenseFile) return { name, version, license, text: normalizeText(await readFile(licenseFile, "utf8")) };
  if (LGPL_LICENSE_PATTERN.test(license)) return { name, version, license, text: null };
  const error = new Error(`${name}@${version} has no license file (license: ${license || "(none)"})`);
  error.missingLicense = { name, version, license, packageDir };
  throw error;
}

/** Installed package directories under node_modules, including scoped and nested ones. */
export async function listInstalledPackages(nodeModulesDir) {
  const found = [];
  const visit = async (dir) => {
    for (const entry of (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => compareText(a.name, b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.name.startsWith("@")) {
        await visit(path);
        continue;
      }
      // Packager's ignore rules leave empty directories behind; only real packages count.
      if (!(await isFile(join(path, "package.json")))) continue;
      found.push(path);
      if (await isDirectory(join(path, "node_modules"))) await visit(join(path, "node_modules"));
    }
  };
  await visit(nodeModulesDir);
  return found;
}

/** Reads every package's license, de-duplicated by name@version, failing once with every package that has none. */
export async function collectPackageLicenses(packageDirs) {
  const byKey = new Map();
  const missing = [];
  for (const dir of packageDirs) {
    try {
      const entry = await readPackageLicense(dir);
      byKey.set(`${entry.name}@${entry.version}`, entry);
    } catch (error) {
      if (!error.missingLicense) throw error;
      missing.push(error.missingLicense);
    }
  }
  if (missing.length) {
    throw new Error(
      "These packaged dependencies have no license file and no known license text: "
      + missing.map(({ name, version, license }) => `${name}@${version} (${license || "no license field"})`).join(", "),
    );
  }
  return [...byKey.values()].sort((a, b) => compareText(a.name, b.name) || compareText(a.version, b.version));
}

/** Rows of the "Used under the terms of" table that sharp's libvips packages carry in their README. */
export function parseLibvipsLicensingTable(readme) {
  const lines = String(readme).replace(/\r\n?/g, "\n").split("\n");
  const header = lines.findIndex((line) => /^\|\s*Library\s*\|\s*Used under the terms of\s*\|/.test(line));
  if (header < 0) throw new Error("libvips README has no licensing table");
  const rows = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("|")) break;
    const [library, license] = line.split("|").slice(1, 3).map((cell) => cell.trim());
    if (!library) continue;
    rows.push({ library, license: license.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)") });
  }
  if (!rows.length) throw new Error("libvips README licensing table is empty");
  return rows;
}

export function libvipsComponents({ readme, versions }) {
  return parseLibvipsLicensingTable(readme).map(({ library, license }) => {
    const key = [LIBVIPS_VERSION_KEYS[library], library, library.replace(/^lib/, "")].find((candidate) => candidate && versions[candidate]);
    return { library, version: key ? String(versions[key]) : "", license };
  });
}

function packageSection(entries) {
  return entries.map(({ name, version, license, text }) => [
    "-".repeat(78),
    `${name} ${version}`,
    `License: ${license || "(see text)"}`,
    "",
    text ?? `Licensed under ${license}; see ${LICENSE_FILES.lgpl} and ${LICENSE_FILES.gpl} in this folder.`,
    "",
  ].join("\n")).join("\n");
}

export function renderThirdPartyLicenses({ frontend, runtime, libvips }) {
  const width = Math.max(...libvips.components.map(({ library }) => library.length));
  const versionWidth = Math.max(...libvips.components.map(({ version }) => (version || "-").length));
  return [
    "GravityPort third-party licenses",
    "",
    "This program includes the third-party components listed below, each used under",
    "its own license. The GNU LGPL and GPL texts are in LGPL-3.0.txt and GPL-3.0.txt,",
    "and Electron and Chromium's licenses are in ELECTRON-LICENSE.txt and",
    "LICENSES.chromium.html, all in this folder.",
    "",
    "=".repeat(78),
    "1. npm packages bundled into the GravityPort interface",
    "=".repeat(78),
    "",
    packageSection(frontend),
    "=".repeat(78),
    "2. npm packages in the desktop runtime",
    "=".repeat(78),
    "",
    packageSection(runtime),
    "=".repeat(78),
    `3. libvips and the libraries packaged with it (${libvips.packageName} ${libvips.packageVersion})`,
    "=".repeat(78),
    "",
    ...libvips.components.map(({ library, version, license }) => {
      const lgpl = /\bLGPL/.test(license) ? ` (full text: ${LICENSE_FILES.lgpl}, ${LICENSE_FILES.gpl})` : "";
      return `${library.padEnd(width)}  ${(version || "-").padEnd(versionWidth)}  ${license}${lgpl}`;
    }),
    "",
    `libvips ${libvips.vipsVersion} and these libraries are dynamically linked from the`,
    `${libvips.packageName} package. Their source code is available at`,
    `${LIBVIPS_SOURCE_URL} (build scripts and upstream source references).`,
    "",
  ].join("\n");
}

async function readBundledFrontendPackages(projectRoot) {
  const manifestPath = join(projectRoot, BUNDLED_PACKAGES_PATH);
  const raw = await readFile(manifestPath, "utf8").catch(() => {
    throw new Error(`${BUNDLED_PACKAGES_PATH} is missing; run npm run build before packaging.`);
  });
  const uiRoot = join(projectRoot, "web", "gravityport");
  return JSON.parse(raw).map((dir) => resolve(uiRoot, dir));
}

async function requireFile(path, description) {
  if (!(await isFile(path))) throw new Error(`Missing ${description}: ${path}`);
  return path;
}

/**
 * Writes the five license files into `outputDir` (emptied first).
 * `libvipsPackage` is the @img package whose README and versions.json describe
 * the libvips build that ships for the target.
 */
export async function writeDesktopLicenses({
  projectRoot = PROJECT_ROOT,
  buildPath,
  platform,
  libvipsPackage,
  outputDir,
}) {
  const stagingDir = electronStagingDir(buildPath, platform);
  const electronLicense = await requireFile(join(stagingDir, "LICENSE"), "Electron LICENSE in the packager staging directory");
  const chromiumLicenses = await requireFile(join(stagingDir, "LICENSES.chromium.html"), "Electron LICENSES.chromium.html in the packager staging directory");
  const lgpl = await requireFile(join(projectRoot, "desktop", "licenses", LICENSE_FILES.lgpl), "vendored LGPL-3.0 text");
  const gpl = await requireFile(join(projectRoot, "desktop", "licenses", LICENSE_FILES.gpl), "vendored GPL-3.0 text");

  const frontend = await collectPackageLicenses(await readBundledFrontendPackages(projectRoot));
  const runtime = await collectPackageLicenses(await listInstalledPackages(join(buildPath, "node_modules")));
  // The pruned tree drops READMEs, so the licensing table comes from the source install.
  const libvipsDir = join(projectRoot, "node_modules", "@img", libvipsPackage);
  const libvipsManifest = JSON.parse(await readFile(join(libvipsDir, "package.json"), "utf8"));
  const versions = JSON.parse(await readFile(join(libvipsDir, "versions.json"), "utf8"));
  const components = libvipsComponents({ readme: await readFile(join(libvipsDir, "README.md"), "utf8"), versions });

  const notices = renderThirdPartyLicenses({
    frontend,
    runtime,
    libvips: {
      packageName: libvipsManifest.name,
      packageVersion: libvipsManifest.version,
      vipsVersion: String(versions.vips || ""),
      components,
    },
  });

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await copyFile(electronLicense, join(outputDir, LICENSE_FILES.electron));
  await copyFile(chromiumLicenses, join(outputDir, LICENSE_FILES.chromium));
  await copyFile(lgpl, join(outputDir, LICENSE_FILES.lgpl));
  await copyFile(gpl, join(outputDir, LICENSE_FILES.gpl));
  await writeFile(join(outputDir, LICENSE_FILES.notices), notices, "utf8");
  return { outputDir, frontend: frontend.length, runtime: runtime.length, libvips: components.length };
}

/** Throws unless a packaged licenses/ folder holds all five files with the expected content. */
export async function verifyPackagedLicenses(licensesDir) {
  for (const name of Object.values(LICENSE_FILES)) {
    const info = await stat(join(licensesDir, name)).catch(() => null);
    if (!info?.isFile()) throw new Error(`Packaged license file is missing: ${join(LICENSES_DIR_NAME, name)}`);
    if (info.size <= 0) throw new Error(`Packaged license file is empty: ${join(LICENSES_DIR_NAME, name)}`);
  }
  const notices = await readFile(join(licensesDir, LICENSE_FILES.notices), "utf8");
  for (const required of ["libvips", "react", "better-sqlite3"]) {
    if (!notices.includes(required)) throw new Error(`${LICENSE_FILES.notices} does not mention ${required}`);
  }
}
