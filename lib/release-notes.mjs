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
 *
 * Each language of an entry is either a legacy flat array of sentences or a
 * sectioned object with the fixed keys new/improved/fixed/other (schema 2).
 * The update manifest keeps flat text, so sectioned entries are serialized
 * with a category prefix per line ("• 新增：…"), which old App versions render
 * verbatim and new ones restore into sections.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const RELEASE_NOTES_PATH = resolve(fileURLToPath(new URL("../release-notes.json", import.meta.url)));

/** Section keys in their fixed display order. */
export const SECTION_KEYS = ["new", "improved", "fixed", "other"];

/** Section labels for the update-manifest text, per language. */
const MANIFEST_SECTION_LABELS = {
  zh: { new: "新增", improved: "优化", fixed: "修复", other: "其他" },
  en: { new: "New", improved: "Improved", fixed: "Fixed", other: "Other" },
};

const MANIFEST_SECTION_COLON = { zh: "：", en: ": " };

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

/**
 * Returns { zh, en, date } for a version, or null when there is no entry.
 * zh/en are normalized to ordered section groups:
 *   [{ key: "new" | "improved" | "fixed" | "other", lines: [...] }, ...]
 * A legacy flat entry becomes a single group with key null (no section).
 */
export function notesForVersion(data, version) {
  const wanted = normalizeVersion(version);
  if (!wanted) return null;
  const entry = (Array.isArray(data?.releases) ? data.releases : [])
    .find((release) => normalizeVersion(release?.version) === wanted);
  if (!entry) return null;
  return { zh: normalizeGroups(entry.zh), en: normalizeGroups(entry.en), date: entry.date };
}

/** Joins note sentences into the multi-line text used in the update manifest. */
export function formatNotesText(lines) {
  return lines.map((line) => `• ${line}`).join("\n");
}

/**
 * Update-manifest text for one language's groups: sectioned entries become
 * "• 前缀：条目" (one line per item, so old App versions render a readable
 * flat list), legacy flat entries stay "• 条目".
 */
export function formatManifestNotes(groups, language) {
  const colon = MANIFEST_SECTION_COLON[language] ?? MANIFEST_SECTION_COLON.zh;
  const labels = MANIFEST_SECTION_LABELS[language] ?? MANIFEST_SECTION_LABELS.zh;
  const lines = [];
  for (const group of groups) {
    for (const line of group.lines) {
      lines.push(group.key ? `• ${labels[group.key]}${colon}${line}` : `• ${line}`);
    }
  }
  return lines.join("\n");
}

function normalizeGroups(value) {
  if (Array.isArray(value)) {
    return value.length > 0 ? [{ key: null, lines: [...value] }] : [];
  }
  return SECTION_KEYS
    .filter((key) => Array.isArray(value?.[key]) && value[key].length > 0)
    .map((key) => ({ key, lines: [...value[key]] }));
}

function validateReleaseNotes(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("release-notes.json 顶层必须是一个对象");
  }
  if (data.schema !== 2) {
    throw new Error(`release-notes.json: schema 必须是 2，现在是 ${JSON.stringify(data.schema) ?? "(missing)"}`);
  }
  // `unreleased` may be empty (nothing recorded yet) but whatever is there
  // must be well-formed; the About page renders it verbatim.
  if (data.unreleased !== undefined) {
    validateLanguageNotes(data.unreleased, "unreleased", { allowEmpty: true });
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
    validateLanguageNotes(release, `releases[${index}]（${version}）`, { allowEmpty: false });
  });
}

function validateLanguageNotes(value, label, { allowEmpty }) {
  validateOneLanguage(value?.zh, `${label}.zh`, { allowEmpty });
  validateOneLanguage(value?.en, `${label}.en`, { allowEmpty });
  if (isSectioned(value?.zh) !== isSectioned(value?.en)) {
    throw new Error(`release-notes.json: ${label}.zh 和 .en 必须是同一种形状（都是条目数组或都是分栏对象）`);
  }
}

function isSectioned(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateOneLanguage(value, label, { allowEmpty }) {
  if (isSectioned(value)) {
    for (const key of Object.keys(value)) {
      if (!SECTION_KEYS.includes(key)) {
        throw new Error(`release-notes.json: ${label} 只允许 ${SECTION_KEYS.join("、")} 键，发现 ${JSON.stringify(key)}`);
      }
      validateLines(value[key], `${label}.${key}`);
    }
    const total = SECTION_KEYS.reduce((sum, key) => sum + (Array.isArray(value[key]) ? value[key].length : 0), 0);
    if (!allowEmpty && total === 0) {
      throw new Error(`release-notes.json: ${label} 四个栏目不能全为空`);
    }
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error(`release-notes.json: ${label} 必须是字符串数组或分栏对象（${SECTION_KEYS.join("、")}）`);
  }
  if (!allowEmpty && value.length === 0) {
    throw new Error(`release-notes.json: ${label} 不能为空数组`);
  }
  validateLines(value, label);
}

function validateLines(lines, label) {
  if (!Array.isArray(lines)) {
    throw new Error(`release-notes.json: ${label} 必须是字符串数组`);
  }
  lines.forEach((line, lineIndex) => {
    if (typeof line !== "string" || !line.trim()) {
      throw new Error(`release-notes.json: ${label}[${lineIndex}] 不能为空`);
    }
    // Raised from 200 to 300 with schema 2: the mandated 0.3.6 English
    // paste-to-import entry is 202 characters and ships verbatim.
    if (line.trim().length > 300) {
      throw new Error(`release-notes.json: ${label}[${lineIndex}] 超过 300 字`);
    }
  });
}

function normalizeVersion(version) {
  return String(version ?? "").trim().replace(/^v/i, "") || null;
}
