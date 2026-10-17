// Task 158: diagnostic log ring buffer and redaction — real module tests.
// The console capture stubs are installed BEFORE installDiagnosticLog() so
// nothing (including CJK text) ever reaches the real node:test console.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  getDiagnosticLogText,
  installDiagnosticLog,
  isDiagnosticLogInstalled,
  redactDiagnostics,
  uninstallDiagnosticLog,
} from "../lib/diagnostic-log.mjs";

// Replaces the console methods with silent recorders for the duration of
// run(), so wrapper output never prints through the test runner.
function withSilentConsole(run) {
  const original = {
    warn: console.warn,
    error: console.error,
    info: console.info,
    log: console.log,
  };
  const calls = [];
  const record = (level) => (...args) => calls.push({ level, args });
  console.warn = record("warn");
  console.error = record("error");
  console.info = record("info");
  console.log = record("log");
  try {
    return run(calls);
  } finally {
    console.warn = original.warn;
    console.error = original.error;
    console.info = original.info;
    console.log = original.log;
  }
}

test("ring buffer captures warn/error and [MOSA]-prefixed info/log with time and level", () => {
  withSilentConsole(() => {
    installDiagnosticLog();
    try {
      console.warn("first warning");
      console.error("boom", 42);
      console.info("[MOSA] prefixed info");
      console.log("plain log must not be captured");
      console.log("[MOSA] prefixed log");
      console.info("unprefixed info must not be captured");

      const text = getDiagnosticLogText();
      const logged = text.split("\n");
      assert.equal(logged.length, 4);
      // "ISO time + level + text"
      assert.match(logged[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z warn first warning$/);
      assert.match(logged[1], /^\d{4}-\d{2}-\d{2}T\S+ error boom 42$/);
      assert.match(logged[2], / info \[MOSA\] prefixed info$/);
      assert.match(logged[3], / log \[MOSA\] prefixed log$/);
      assert.ok(!text.includes("plain log"), "plain console.log stays out");
      assert.ok(!text.includes("unprefixed info"), "unprefixed console.info stays out");
    } finally {
      uninstallDiagnosticLog();
    }
    assert.equal(isDiagnosticLogInstalled(), false);
    assert.equal(getDiagnosticLogText(), "");
  });
});

test("install is idempotent and uninstall restores capture behavior", () => {
  withSilentConsole((calls) => {
    installDiagnosticLog();
    installDiagnosticLog();
    try {
      console.warn("only once");
      assert.equal(getDiagnosticLogText().split("\n").length, 1, "double install must not double-capture");
      assert.equal(calls.length, 1, "output still flows to the real console");
    } finally {
      uninstallDiagnosticLog();
    }
    console.warn("after uninstall");
    assert.equal(getDiagnosticLogText(), "");
    assert.equal(calls.length, 2, "console works normally after uninstall");
  });
});

test("multi-line console calls occupy one buffered line per physical line", () => {
  withSilentConsole(() => {
    installDiagnosticLog();
    try {
      console.warn("a\nb\r\nc");
      assert.deepEqual(getDiagnosticLogText().split("\n").map((line) => line.replace(/^\S+ \S+ /, "")), [
        "a",
        "b",
        "c",
      ]);
    } finally {
      uninstallDiagnosticLog();
    }
  });
});

test("oldest lines drop when the 400-line cap is exceeded", () => {
  withSilentConsole(() => {
    installDiagnosticLog();
    try {
      for (let index = 0; index < 450; index += 1) console.warn(`marker-${index}`);
      const logged = getDiagnosticLogText().split("\n");
      assert.equal(logged.length, 400);
      assert.ok(!logged[0].includes("marker-0"), "oldest line dropped");
      assert.ok(logged[0].includes("marker-50"), "kept lines start at 450-400");
      assert.ok(logged.at(-1).includes("marker-449"), "newest line kept");
    } finally {
      uninstallDiagnosticLog();
    }
  });
});

test("oldest lines drop when the 120 KB byte cap is exceeded", () => {
  withSilentConsole(() => {
    installDiagnosticLog();
    try {
      for (let index = 0; index < 200; index += 1) console.warn(`big-${index} ${"x".repeat(980)}`);
      const text = getDiagnosticLogText();
      const logged = text.split("\n");
      assert.ok(logged.length < 200, `byte cap must evict lines, got ${logged.length}`);
      assert.ok(Buffer.byteLength(text, "utf8") <= 120 * 1024, "kept text stays within the byte cap");
      assert.ok(!logged[0].includes("big-0"), "oldest dropped by bytes");
      assert.ok(logged.at(-1).includes("big-199"), "newest kept");
    } finally {
      uninstallDiagnosticLog();
    }
  });
});

test("buffered lines longer than 2000 chars are truncated with a marker", () => {
  withSilentConsole(() => {
    installDiagnosticLog();
    try {
      console.warn("y".repeat(3000));
      const line = getDiagnosticLogText();
      assert.ok(line.endsWith("…(已截断)"));
      const stored = line.replace(/^\S+ \S+ /, "");
      assert.equal(stored.length, 2000 + "…(已截断)".length);
    } finally {
      uninstallDiagnosticLog();
    }
  });
});

test("redaction masks the library directory with either separator", () => {
  const options = { homeDir: "/Users/alice", libraryDir: "/Users/alice/MOSA Library" };
  assert.equal(
    redactDiagnostics("scanning /Users/alice/MOSA Library/assets/a.png done", options),
    "scanning <素材库>/assets/a.png done",
  );
  const windows = { homeDir: "C:\\Users\\bob", libraryDir: "C:\\Users\\bob\\GravityPort Library" };
  assert.equal(
    redactDiagnostics("at C:\\Users\\bob\\GravityPort Library\\cache ok", windows),
    "at <素材库>\\cache ok",
  );
  assert.equal(
    redactDiagnostics("at C:/Users/bob/GravityPort Library/cache ok", windows),
    "at <素材库>/cache ok",
  );
});

test("redaction masks the home directory as ~ with either separator", () => {
  assert.equal(redactDiagnostics("cfg /Users/alice/.mosa/x", { homeDir: "/Users/alice" }), "cfg ~/.mosa/x");
  const windows = { homeDir: "C:\\Users\\bob" };
  assert.equal(redactDiagnostics("cfg C:\\Users\\bob\\AppData", windows), "cfg ~\\AppData");
  assert.equal(redactDiagnostics("cfg C:/Users/bob/AppData", windows), "cfg ~/AppData");
  assert.equal(redactDiagnostics("cfg C:\\users\\BOB\\AppData", windows), "cfg ~\\AppData", "Windows paths match case-insensitively");
});

test("the library directory wins when it sits inside the home directory", () => {
  assert.equal(
    redactDiagnostics("at /Users/alice/MOSA Library/assets", { homeDir: "/Users/alice", libraryDir: "/Users/alice/MOSA Library" }),
    "at <素材库>/assets",
  );
});

test("redaction masks token assignments in = : and JSON forms", () => {
  const cases = [
    ["token=abc123", "token=<已隐藏>"],
    ["token: abc123", "token: <已隐藏>"],
    ['"access_token": "sk-123"', '"access_token": <已隐藏>'],
    ["refresh_token=zzz", "refresh_token=<已隐藏>"],
    ["mosa-client-token: ttt", "mosa-client-token: <已隐藏>"],
    ["code=4/0AxxABC", "code=<已隐藏>"],
    ["?code=xyz&state=ok", "?code=<已隐藏>&state=ok"],
    ["Authorization: Bearer abc.def", "Authorization: <已隐藏>"],
    ["Bearer sk-live-123", "Bearer <已隐藏>"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redactDiagnostics(input, {}), expected, input);
  }
});

test("redaction masks long hex and base64-style runs", () => {
  assert.equal(redactDiagnostics("sha 0123456789abcdef0123456789abcdef end", {}), "sha <已隐藏> end");
  assert.equal(redactDiagnostics("short 0123456789abcdef0123456789abcde stays", {}), "short 0123456789abcdef0123456789abcde stays");
  assert.equal(redactDiagnostics(`b64 ${"z".repeat(40)} end`, {}), "b64 <已隐藏> end");
  assert.equal(redactDiagnostics(`b64 ${"z".repeat(39)} stays`, {}), `b64 ${"z".repeat(39)} stays`);
});

test("redaction masks email addresses", () => {
  assert.equal(redactDiagnostics("from Alice <alice@example.com> thanks", {}), "from Alice <<邮箱>> thanks");
});

test("a line carrying prompt/instruction wording is dropped whole", () => {
  const cases = [
    "prompt: a cat in a hat",
    "user_instruction was: make it blue",
    "The INSTRUCTION field said so",
    "本次生成的提示词如下",
  ];
  for (const line of cases) {
    assert.equal(redactDiagnostics(line, {}), "<此行已省略：可能含素材文字>", line);
  }
  // Other lines on either side survive.
  assert.equal(
    redactDiagnostics("before\nprompt: secret asset wording\nafter", {}),
    "before\n<此行已省略：可能含素材文字>\nafter",
  );
});

test("redaction is idempotent on its own output", () => {
  const once = redactDiagnostics(
    "user /Users/alice/x token=abc Bearer zz alice@example.com 0123456789abcdef0123456789abcdef",
    { homeDir: "/Users/alice" },
  );
  assert.equal(redactDiagnostics(once, { homeDir: "/Users/alice" }), once);
});

test("empty input redacts to empty", () => {
  assert.equal(redactDiagnostics("", {}), "");
  assert.equal(redactDiagnostics(undefined, {}), "");
});
