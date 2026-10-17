/**
 * Release-notes.json reader and validator.
 *
 * release-notes.json at the repository root is the single source of user-facing
 * release notes: `unreleased` holds what the next version changes, `releases`
 * holds one entry per shipped version (newest first). The build gate
 * (scripts/write-build-identity.mjs), the release manifest writer
 * (scripts/prepare-desktop-release-manifest.mjs) and the bundled About page
 * all read from here, so malformed content must fail loudly with the exact
 * location of the problem.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const RELEASE_NOTES_PATH = resolve(fileURLToPath(new URL("../release-notes.json", import.meta.url)));

/** Reads and validates a release-notes.json file (the repo one by default). */
export function readReleaseNotes(path = RELEASE_NOTES_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`release-notes.json 不是有效的 JSON：${error?.message || error}`);
  }
  validateReleaseNotes(parsed);
  return parsed;
}

/** Returns { zh, en, date } for a version, or null when there is no entry. */
export function notesForVersion(data, version) {
  const wanted = normalizeVersion(version);
  if (!wanted) return null;
  const entry = (Array.isArray(data?.releases) ? data.releases : [])
    .find((release) => normalizeVersion(release?.version) === wanted);
  if (!entry) return null;
  return { zh: [...entry.zh], en: [...entry.en], date: entry.date };
}

/** Joins note sentences into the multi-line text used in the update manifest. */
export function formatNotesText(lines) {
  return lines.map((line) => `• ${line}`).join("\n");
}

function validateReleaseNotes(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("release-notes.json 顶层必须是一个对象");
  }
  if (data.schema !== 1) {
    throw new Error(`release-notes.json: schema 必须是 1，现在是 ${JSON.stringify(data.schema) ?? "(missing)"}`);
  }
  // `unreleased` may be an empty object (nothing recorded yet) but whatever is
  // there must be well-formed; the About page renders it verbatim.
  if (data.unreleased !== undefined) {
    validateLanguageLines(data.unreleased, "unreleased", { allowEmpty: true });
  }
  if (!Array.isArray(data.releases)) {
    throw new Error("release-notes.json: releases 必须是数组");
  }
  const seen = new Set();
  data.releases.forEach((release, index) => {
    if (!release || typeof release !== "object" || Array.isArray(release)) {
      throw new Error(`release-notes.json: releases[${index}] 必须是对象`);
    }
    const version = typeof release.version === "string" ? release.version.trim() : "";
    if (!version) {
      throw new Error(`release-notes.json: releases[${index}].version 不能为空`);
    }
    if (seen.has(version)) {
      throw new Error(`release-notes.json: releases[${index}].version ${version} 重复`);
    }
    seen.add(version);
    if (typeof release.date !== "string" || !release.date.trim()) {
      throw new Error(`release-notes.json: releases[${index}]（${version}）.date 不能为空`);
    }
    validateLanguageLines(release, `releases[${index}]（${version}）`, { allowEmpty: false });
  });
}

function validateLanguageLines(value, label, { allowEmpty }) {
  for (const language of ["zh", "en"]) {
    const lines = value?.[language];
    if (!Array.isArray(lines)) {
      throw new Error(`release-notes.json: ${label}.${language} 必须是字符串数组`);
    }
    if (!allowEmpty && lines.length === 0) {
      throw new Error(`release-notes.json: ${label}.${language} 不能为空数组`);
    }
    lines.forEach((line, lineIndex) => {
      if (typeof line !== "string" || !line.trim()) {
        throw new Error(`release-notes.json: ${label}.${language}[${lineIndex}] 不能为空`);
      }
      if (line.trim().length > 200) {
        throw new Error(`release-notes.json: ${label}.${language}[${lineIndex}] 超过 200 字`);
      }
    });
  }
}

function normalizeVersion(version) {
  return String(version ?? "").trim().replace(/^v/i, "") || null;
}
