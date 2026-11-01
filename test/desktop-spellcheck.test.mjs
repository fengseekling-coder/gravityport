import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { disableSpellcheckDownloads } from "../desktop/spellcheck-policy.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function fakeSession() {
  const calls = [];
  return {
    calls,
    setSpellCheckerEnabled: (flag) => { calls.push(["setSpellCheckerEnabled", flag]); },
    setSpellCheckerDictionaryDownloadURL: (url) => { calls.push(["setSpellCheckerDictionaryDownloadURL", url]); },
    setSpellCheckerLanguages: (languages) => { calls.push(["setSpellCheckerLanguages", languages]); },
  };
}

test("main window keeps spellcheck disabled and stays the only BrowserWindow", async () => {
  const main = await readFile(resolve(root, "desktop", "main.mjs"), "utf8");
  assert.equal(main.match(/new BrowserWindow\(/g)?.length, 1,
    "a second window must re-check the spellcheck policy before it is added");
  assert.match(main, /spellcheck:\s*false/);
  assert.doesNotMatch(main, /spellcheck:\s*true/);
});

test("main.mjs wires disableSpellcheckDownloads next to denyBrowserPermissions", async () => {
  const main = await readFile(resolve(root, "desktop", "main.mjs"), "utf8");
  assert.match(main, /import \{ disableSpellcheckDownloads \} from "\.\/spellcheck-policy\.mjs";/);
  assert.match(
    main,
    /denyBrowserPermissions\(\);\s*\n\s*disableSpellcheckDownloads\(session\.defaultSession, process\.platform\);/,
  );
});

test("on win32 the three hardening steps run in order against a local dead port", () => {
  const session = fakeSession();
  disableSpellcheckDownloads(session, "win32");
  assert.deepEqual(session.calls, [
    ["setSpellCheckerEnabled", false],
    ["setSpellCheckerDictionaryDownloadURL", "http://127.0.0.1:9/"],
    ["setSpellCheckerLanguages", []],
  ]);
});

test("on darwin only the session switch runs (the other calls are unsupported there)", () => {
  const session = fakeSession();
  disableSpellcheckDownloads(session, "darwin");
  assert.deepEqual(session.calls, [["setSpellCheckerEnabled", false]]);
});

test("a failing step is reported and never propagates", () => {
  const warns = [];
  const throwingSession = {
    setSpellCheckerEnabled: () => { throw new Error("boom-1"); },
    setSpellCheckerDictionaryDownloadURL: () => { throw new Error("boom-2"); },
    setSpellCheckerLanguages: () => { throw new Error("boom-3"); },
  };
  assert.doesNotThrow(() => disableSpellcheckDownloads(throwingSession, "win32", { warn: (line) => warns.push(line) }));
  assert.doesNotThrow(() => disableSpellcheckDownloads(throwingSession, "darwin", { warn: (line) => warns.push(line) }));
  assert.equal(warns.filter((line) => line.includes("boom-1")).length, 2);
  assert.equal(warns.filter((line) => line.includes("boom-2")).length, 1, "the download-URL step is skipped on darwin");
  assert.equal(warns.filter((line) => line.includes("boom-3")).length, 1);
});
