// Task 315: every process records uncaught crashes before its default exit.
// server.mjs and mcp/server.mjs must rely on uncaughtExceptionMonitor only
// (Node's default mode raises unhandled rejections through it too) — adding
// an unhandledRejection listener there would change the default exit
// behavior. The desktop main process may also listen for rejections because
// its measured default behavior for them is warn-and-keep-running anyway.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("server.mjs registers the crash monitor and no rejection listener", () => {
  const source = read("server.mjs");
  assert.match(source, /process\.on\("uncaughtExceptionMonitor"/);
  assert.doesNotMatch(source, /process\.on\("unhandledRejection"/, "a rejection listener would change the default exit");
  assert.match(source, /\[MOSA\] uncaught exception/);
});

test("mcp/server.mjs records crashes redacted on stderr, stdout stays protocol-only", () => {
  const source = read("mcp/server.mjs");
  assert.match(source, /process\.on\("uncaughtExceptionMonitor"/);
  assert.doesNotMatch(source, /process\.on\("unhandledRejection"/, "a rejection listener would change the default exit");
  assert.match(source, /redactDiagnostics\(/);
  assert.match(source, /process\.stderr\.write\(`\$\{described\}\\n`\)/);
});

test("the desktop main process installs the buffer early, attaches the file sink, and records both crash kinds", () => {
  const source = read("desktop/main.mjs");
  assert.match(source, /installDiagnosticLog\(\)/);
  assert.match(source, /attachDiagnosticLogFile\(\{/);
  assert.match(source, /process\.on\("uncaughtExceptionMonitor"/);
  assert.match(source, /process\.on\("unhandledRejection"/);
  assert.match(source, /\[MOSA\] uncaught exception/);
  assert.match(source, /\[MOSA\] uncaught rejection/);
});

test("renderer console messages are split into a summary and a console-only full line", () => {
  const source = read("desktop/main.mjs");
  assert.match(source, /writeConsoleOnly\("error", /);
  assert.match(source, /\(内容已省略\)/);
  // The dedup and the 32-entry cap stay as they were.
  assert.match(source, /MAX_RENDERER_CONSOLE_ERRORS = 32/);
  assert.match(source, /rendererConsoleErrors\.has\(entry\)/);
});
