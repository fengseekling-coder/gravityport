#!/usr/bin/env node

// Prints one version's release notes as the update-manifest text (one
// "• 条目" per line; sectioned entries carry their category prefix, legacy
// flat entries stay unprefixed). The release pipeline feeds this to the
// website release script as MOSA_RELEASE_NOTES_ZH/EN instead of assembling
// the text in a shell.

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { formatManifestNotes, notesForVersion, readReleaseNotes } from "../lib/release-notes.mjs";

const USAGE = "Usage: print-release-notes.mjs --version <version> [--lang <zh|en>] [--release-notes <release-notes.json>]";

export function parsePrintArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      version: { type: "string" },
      lang: { type: "string", default: "zh" },
      "release-notes": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const version = String(values.version || "").trim();
  if (!version) throw new Error(USAGE);
  const lang = String(values.lang || "zh").trim();
  if (lang !== "zh" && lang !== "en") throw new Error(`Invalid --lang: ${lang}. Use zh or en.`);
  return {
    version,
    lang,
    releaseNotesPath: values["release-notes"] ? resolve(String(values["release-notes"])) : undefined,
  };
}

export function main(argv = process.argv.slice(2), { log = (line) => console.log(line), error = (line) => console.error(line) } = {}) {
  try {
    const options = parsePrintArgs(argv);
    const entry = notesForVersion(readReleaseNotes(options.releaseNotesPath), options.version);
    if (!entry) {
      error(`release-notes.json 缺少 ${options.version} 的更新说明`);
      process.exitCode = 1;
      return false;
    }
    log(formatManifestNotes(entry[options.lang], options.lang));
    return true;
  } catch (cause) {
    error(`[GravityPort] print-release-notes failed: ${cause?.message || cause}`);
    process.exitCode = 1;
    return false;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main();
}
