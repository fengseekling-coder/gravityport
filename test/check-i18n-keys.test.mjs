import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { analyzeI18nKeys, extractI18nKeys, I18N_PATH } from "../scripts/check-i18n-keys.mjs";

const I18N_SOURCE = `export type Language = "zh" | "en"

const english: Record<string, string> = {
  "已用键": "Used key", "死键": "Dead key",
  "模板 {count} 项": "Template {count}",
}

export function translate(text: string, language: Language): string {
  if (language !== "en") return text
  return english[text] || text
}
`;

function analyze(files, options = {}) {
  return analyzeI18nKeys({
    files: new Map(Object.entries({ [I18N_PATH]: I18N_SOURCE, ...files })),
    ...options,
  });
}

test("flags a key nothing outside the i18n file references", () => {
  const { unusedKeys, checked } = analyze({ "web/gravityport/src/App.tsx": 'const x = tr("已用键");\n' });
  assert.deepEqual(unusedKeys, ["死键", "模板 {count} 项"]);
  assert.equal(checked, 3);
});

test("keeps keys referenced from another file", () => {
  const { unusedKeys } = analyze({
    "lib/store.mjs": 'labels.push("已用键", "死键");\n',
    "web/gravityport/src/App.tsx": 'const x = tr("已用键");\n',
  });
  assert.deepEqual(unusedKeys, ["模板 {count} 项"]);
});

test("does not count the i18n file itself as a reference", () => {
  const { unusedKeys } = analyze({});
  assert.deepEqual(unusedKeys, ["已用键", "死键", "模板 {count} 项"]);
});

test("matches placeholder templates as literal lookups", () => {
  const { unusedKeys } = analyze({
    "web/gravityport/src/App.tsx": 'notify(fill(tr("模板 {count} 项"), { count }));\n',
  });
  assert.deepEqual(unusedKeys, ["已用键", "死键"]);
});

test("keeps the real dynamic-key exceptions by default", () => {
  // The inspector header templates are built in App.tsx inspectorHeaderLine()
  // by interpolating the kind word, so no file contains the full key literal.
  // The key below is assembled from parts for the same reason: a contiguous
  // literal in this file would vouch for the key in the checker's corpus.
  const templateKey = ["图片", "{source}"].join(" · ");
  const source = I18N_SOURCE.replace('"死键": "Dead key",', `"${templateKey}": "Image · {source}", "死键": "Dead key",`);
  const { unusedKeys } = analyzeI18nKeys({
    files: new Map([
      [I18N_PATH, source],
      ["web/gravityport/src/App.tsx", 'const x = tr("已用键");\n'],
    ]),
  });
  assert.deepEqual(unusedKeys, ["死键", "模板 {count} 项"]);
});

test("comment prose without a full key-value pair is not an entry", () => {
  const source = I18N_SOURCE.replace(
    '  "已用键": "Used key",',
    '  // the singular "死" variant is handled in translate()\n  "已用键": "Used key",',
  );
  assert.deepEqual(extractI18nKeys(source).map(({ key }) => key), ["已用键", "死键", "模板 {count} 项"]);
});

test("throws on duplicate keys", () => {
  const source = I18N_SOURCE.replace('"死键": "Dead key",', '"死键": "Dead key", "死键": "Dead key 2",');
  assert.throws(() => extractI18nKeys(source), /duplicate i18n key: 死键/);
});

test("throws when the english map is missing or unclosed", () => {
  assert.throws(() => extractI18nKeys("export const dictionary = null;\n"), /no `const english` map/);
  assert.throws(() => extractI18nKeys("const english: Record<string, string> = {\n  \"键\": \"值\",\n"), /closing brace/);
});

test("parses the real i18n map and keeps the dynamic header templates", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "web", "gravityport", "src", "i18n.ts"), "utf8");
  const keys = extractI18nKeys(source).map(({ key }) => key);
  assert.ok(keys.length > 300, `expected the real map, got ${keys.length} keys`);
  assert.ok(keys.includes("图片"), "the filter-button key");
  assert.ok(keys.includes(["图片", "{source}", "{date}"].join(" · ")), "the inspector header template key");
});
