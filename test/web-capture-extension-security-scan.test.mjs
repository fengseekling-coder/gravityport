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

test("R3: no extension script hardcodes the legacy dev token as default or active token", () => {
  for (const [file, text] of scriptTexts) {
    assert.doesNotMatch(text, /mosaToken:\s*["']mosa-web-capture-dev["']/,
      `${file} must not hardcode mosa-web-capture-dev as a token default`);
  }
});

test("R4: video transfer does not retain monolithic in-memory chunk buffers across the extension", () => {
  for (const [file, text] of scriptTexts) {
    assert.doesNotMatch(text, /chunks:\s*new Array\(totalChunks\)/,
      `${file} must not allocate monolithic video chunk arrays`);
  }
});

// Task 390 (review 4-1 丙): the content.js negative safety assertions moved
// here, scanned across every manifest-referenced script instead of one file.

const contentScripts = [...new Set(manifest.content_scripts.flatMap((entry) => entry.js || []))];

test("R5: content scripts read their settings from local storage, never chrome.storage.sync", () => {
  for (const file of contentScripts) {
    const text = scriptTexts.get(file);
    assert.doesNotMatch(text, /chrome\.storage\.sync/,
      `${file} must not read or write chrome.storage.sync (settings live in storage.local/session)`);
  }
});

test("R6: the deleted cookie-only conversation re-read machinery stays deleted", () => {
  // Task 353 removed the extension-issued conversation re-read and its prompt
  // wait; a return of any of these identifiers would reintroduce a request
  // that could replay page authentication state (see
  // "no extension-originated conversation request exists…").
  const forbidden = [
    ["refresh-current-conversation", /refresh-current-conversation/],
    ["conversation-refresh-failed", /conversation-refresh-failed/],
    ["requestCurrentConversationRefresh", /requestCurrentConversationRefresh/],
    ["schedulePromptRecovery", /schedulePromptRecovery/],
    ["promptWaitMs", /promptWaitMs/],
    ["mosaPageHookChannel", /mosaPageHookChannel/],
  ];
  for (const [file, text] of scriptTexts) {
    for (const [name, pattern] of forbidden) {
      assert.doesNotMatch(text, pattern, `${file} must not resurrect the deleted ${name} recovery machinery`);
    }
  }
});

test("R7: content scripts never touch page Authorization values", () => {
  for (const file of contentScripts) {
    const text = scriptTexts.get(file);
    assert.doesNotMatch(text, /authorization/i,
      `${file} must not read or forward page Authorization credentials`);
  }
});

// Task 397 (review 4-1 丁): the provider-script negative safety assertions
// moved here from chatgpt-web-capture-hook.test.mjs.

test("R8: content scripts never touch cookies", () => {
  for (const file of contentScripts) {
    const text = scriptTexts.get(file);
    assert.doesNotMatch(text, /chrome\.cookies|document\.cookie/,
      `${file} must not read or write cookies`);
  }
});

test("R9: provider-sites.js never scans page-wide text and never logs to the console", () => {
  const text = scriptTexts.get("provider-sites.js");
  // Comments legitimately narrate page anatomy; scan the executable shape.
  const code = text.replace(/\/\/[^\n]*/g, "");
  // The only querySelectorAll in the adapter is the video query of the video
  // loop; everything else stays on document.images and injected media events.
  const withoutVideoQuery = code.replace(/document\.querySelectorAll\?\.\("video"\)/g, "");
  assert.doesNotMatch(withoutVideoQuery, /innerText|textContent|innerHTML|querySelectorAll|conversation/,
    "provider-sites.js must not scrape page-wide text or query beyond the video loop");
  assert.doesNotMatch(code, /console\.log/, "provider-sites.js must not log to the page console");
});
