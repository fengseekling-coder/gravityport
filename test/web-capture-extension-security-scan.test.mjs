/**
 * Extension-wide security scan for audit 266 [medium]-1 / supplement new-2.
 * Later 4-1 tasks will move background, content and provider negative safety
 * assertions here as well, without tying them to their original source file.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const extensionRoot = new URL("../extensions/chatgpt-web-capture/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", extensionRoot), "utf8"));
const optionsHtml = await readFile(new URL(manifest.options_ui.page, extensionRoot), "utf8");
const optionsScripts = [...optionsHtml.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)]
  .map((match) => match[1]);
const allScripts = [...new Set([
  manifest.background.service_worker,
  ...manifest.content_scripts.flatMap((entry) => entry.js || []),
  ...optionsScripts,
])];
const mainWorldScripts = [...new Set(manifest.content_scripts
  .filter((entry) => entry.world === "MAIN")
  .flatMap((entry) => entry.js || []))];
const scriptTexts = new Map(await Promise.all(allScripts.map(async (file) => [
  file,
  await readFile(new URL(file, extensionRoot), "utf8"),
])));

test("security scan covers manifest scripts and both MAIN-world hooks", () => {
  for (const file of ["background.js", "content.js", "page-hook.js", "jimeng-page-hook.js", "options.js"]) {
    assert.ok(allScripts.includes(file), `security scan must include ${file}`);
  }
  for (const file of ["page-hook.js", "jimeng-page-hook.js"]) {
    assert.ok(mainWorldScripts.includes(file), `MAIN-world scan must include ${file}`);
  }
});

test("R1: no extension script remembers or forwards ChatGPT page request headers", () => {
  for (const [file, text] of scriptTexts) {
    assert.doesNotMatch(text, /forwardedHeaders|rememberRequestHeaders|oai-device-id|oai-client-version|oai-language/i,
      `${file} must not capture or replay page request headers`);
  }
});

test("R2: MAIN-world page hooks never touch credentials or rewrite requests", () => {
  const forbidden = [
    ["setRequestHeader", /setRequestHeader/],
    ["getAllResponseHeaders", /getAllResponseHeaders/],
    ["document.cookie", /document\.cookie/],
    ["chrome.cookies", /chrome\.cookies/],
    ["authorization", /authorization/i],
  ];
  for (const file of mainWorldScripts) {
    const text = scriptTexts.get(file);
    for (const [name, pattern] of forbidden) {
      assert.doesNotMatch(text, pattern, `${file} must not use ${name}`);
    }
  }
});
