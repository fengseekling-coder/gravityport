// Task 158: diagnostic log ring buffer and redaction — real module tests.
// Task 315: one console call is one entry (embedded newlines become ⏎), the
// 11 redaction leak classes from the audit are covered, and writeConsoleOnly
// must bypass the buffer. The console capture stubs are installed BEFORE
// installDiagnosticLog() so nothing (including CJK text) ever reaches the
// real node:test console.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { hostname } from "node:os";
import test from "node:test";

import {
  getDiagnosticLogText,
  installDiagnosticLog,
  isDiagnosticLogInstalled,
  redactDiagnostics,
  uninstallDiagnosticLog,
  writeConsoleOnly,
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

test("one console call is one entry: embedded newlines become visible ⏎", () => {
  withSilentConsole(() => {
    installDiagnosticLog();
    try {
      console.warn("a\nb\r\nc");
      assert.deepEqual(
        getDiagnosticLogText().split("\n").map((line) => line.replace(/^\S+ \S+ /, "")),
        ["a⏎b⏎c"],
      );
    } finally {
      uninstallDiagnosticLog();
    }
  });
});

test("a multi-line call whose second line carries private text is redacted whole", () => {
  withSilentConsole(() => {
    installDiagnosticLog();
    try {
      console.error("Error: prompt failed\n张三在北京市朝阳区某某路8号");
      const redacted = redactDiagnostics(getDiagnosticLogText(), {});
      assert.ok(!redacted.includes("张三"), "the second physical line must not survive");
      assert.ok(!redacted.includes("prompt failed"), "the whole entry is replaced");
      assert.ok(redacted.includes("<此行已省略：可能含素材文字>"));
    } finally {
      uninstallDiagnosticLog();
    }
  });
});

test("writeConsoleOnly reaches the real console but never the buffer", () => {
  withSilentConsole((calls) => {
    installDiagnosticLog();
    try {
      writeConsoleOnly("error", "full renderer text /Users/alice/x.png");
      assert.ok(!getDiagnosticLogText().includes("full renderer text"), "buffer stays clean");
      assert.equal(calls.length, 1, "the real console received the line");
      assert.ok(calls[0].args.join(" ").includes("full renderer text"));
    } finally {
      uninstallDiagnosticLog();
    }
  });
});

test("oldest entries drop when the 400-entry cap is exceeded", () => {
  withSilentConsole(() => {
    installDiagnosticLog();
    try {
      for (let index = 0; index < 450; index += 1) console.warn(`marker-${index}`);
      const logged = getDiagnosticLogText().split("\n");
      assert.equal(logged.length, 400);
      assert.ok(!logged[0].includes("marker-0"), "oldest entry dropped");
      assert.ok(logged[0].includes("marker-50"), "kept entries start at 450-400");
      assert.ok(logged.at(-1).includes("marker-449"), "newest entry kept");
    } finally {
      uninstallDiagnosticLog();
    }
  });
});

test("oldest entries drop when the 120 KB byte cap is exceeded", () => {
  withSilentConsole(() => {
    installDiagnosticLog();
    try {
      for (let index = 0; index < 200; index += 1) console.warn(`big-${index} ${"x".repeat(980)}`);
      const text = getDiagnosticLogText();
      const logged = text.split("\n");
      assert.ok(logged.length < 200, `byte cap must evict entries, got ${logged.length}`);
      assert.ok(Buffer.byteLength(text, "utf8") <= 120 * 1024, "kept text stays within the byte cap");
      assert.ok(!logged[0].includes("big-0"), "oldest dropped by bytes");
      assert.ok(logged.at(-1).includes("big-199"), "newest kept");
    } finally {
      uninstallDiagnosticLog();
    }
  });
});

test("buffered entries longer than 2000 chars are truncated with a marker", () => {
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

// ---- Leak class 1: object args JSON-encode the backslashes ----------------

test("leak 1: an object arg with a Windows path is masked after JSON encoding", () => {
  withSilentConsole(() => {
    installDiagnosticLog();
    try {
      console.warn({ path: "C:\\Users\\ZhangSan\\Pictures\\a.png" });
      const redacted = redactDiagnostics(getDiagnosticLogText(), {});
      assert.ok(!redacted.includes("ZhangSan"), "JSON-escaped user path must not survive");
      assert.ok(redacted.includes("<路径>.png"), JSON.stringify(redacted));
    } finally {
      uninstallDiagnosticLog();
    }
  });
});

test("leak 2: Windows 8.3 short paths are masked without any context", () => {
  const redacted = redactDiagnostics("C:\\Users\\ZHANGS~1\\AppData\\Local\\Temp\\x.png", {});
  assert.ok(!redacted.includes("ZHANGS~1"), JSON.stringify(redacted));
  assert.equal(redacted, "<路径>.png");
});

test("leak 3: percent-encoded paths are masked and keep their extension", () => {
  const redacted = redactDiagnostics("%2FUsers%2Fzhangsan%2FPictures%2Fa.png", {});
  assert.ok(!redacted.includes("zhangsan"), JSON.stringify(redacted));
  assert.equal(redacted, "<路径>.png");
});

test("leak 4: absolute paths outside library and home are masked", () => {
  const cases = [
    "/Volumes/ZhangSan-SSD/素材/a.png",
    "/Users/Shared/张三/a.png",
    "D:\\张三的图\\a.png",
    "/private/tmp/x.png",
  ];
  for (const text of cases) {
    const redacted = redactDiagnostics(text, {});
    assert.ok(!redacted.includes("张三"), `${text} -> ${redacted}`);
    assert.ok(!redacted.includes("ZhangSan"), `${text} -> ${redacted}`);
    assert.ok(redacted.includes("<路径>.png"), `${text} -> ${redacted}`);
  }
});

test("leak 5: usernames with spaces are masked, quoted and unquoted", () => {
  assert.equal(
    redactDiagnostics("scanning /Users/Zhang San/My Pictures/a.png done", { homeDir: "/Users/Zhang San" }),
    "scanning ~<路径>.png done",
  );
  const json = redactDiagnostics("{\"p\":\"C:\\\\Users\\\\Zhang San\\\\a.png\"}", {});
  assert.ok(!json.includes("Zhang San"), JSON.stringify(json));
  assert.ok(json.includes("<路径>.png"), JSON.stringify(json));
});

test("leak 7: file names and JSON name-like fields are masked", () => {
  // A file under the library root whose name carries no keyword.
  const underLibrary = redactDiagnostics(
    "staged /Users/alice/MOSA Library/import-staging/1a2b-张三-身份证正面.png",
    { homeDir: "/Users/alice", libraryDir: "/Users/alice/MOSA Library" },
  );
  assert.ok(!underLibrary.includes("张三"), JSON.stringify(underLibrary));
  assert.ok(!underLibrary.includes("import-staging"), JSON.stringify(underLibrary));
  assert.ok(underLibrary.includes("<素材库><路径>.png"), JSON.stringify(underLibrary));

  const named = redactDiagnostics("{\"name\":\"张三和李四的婚礼草图\"}", {});
  assert.ok(!named.includes("张三"), JSON.stringify(named));
  assert.equal(named, "{\"name\":\"<已隐藏>\"}");
  const snake = redactDiagnostics('{"group_name":"家人照片"}', {});
  assert.ok(!snake.includes("家人"), JSON.stringify(snake));
});

test("leak 8: mainland phone numbers and 18-digit IDs are masked, timestamps survive", () => {
  const redacted = redactDiagnostics("call 13800138000 id 11010119900101123X ts 1753849200000 ok", {});
  assert.ok(!redacted.includes("13800138000"), JSON.stringify(redacted));
  assert.ok(!redacted.includes("11010119900101123X"), JSON.stringify(redacted));
  assert.ok(redacted.includes("1753849200000"), "millisecond timestamps must survive");
  assert.equal(redacted, "call <号码> id <号码> ts 1753849200000 ok");
});

test("leak 9: path matching respects the segment boundary", () => {
  const redacted = redactDiagnostics("/Users/zhangsan2/Pictures/a.png", { homeDir: "/Users/zhangsan" });
  assert.ok(!redacted.includes("~"), JSON.stringify(redacted));
  assert.ok(!redacted.includes("zhangsan2"), JSON.stringify(redacted));
  assert.equal(redacted, "<路径>.png");
});

test("leak 10: file:// URLs and UNC paths are masked", () => {
  const fileUrl = redactDiagnostics("file:///Users/zhangsan/a.png", { homeDir: "/Users/zhangsan" });
  assert.ok(!fileUrl.includes("zhangsan"), JSON.stringify(fileUrl));
  assert.equal(fileUrl, "<路径>.png");
  const unc = redactDiagnostics("\\\\NAS\\share\\张三\\a.png", {});
  assert.ok(!unc.includes("张三"), JSON.stringify(unc));
  assert.equal(unc, "<路径>.png");
  const uncJson = redactDiagnostics("{\"u\":\"\\\\\\\\NAS\\\\share\\\\张三\\\\a.png\"}", {});
  assert.ok(!uncJson.includes("张三"), JSON.stringify(uncJson));
});

test("leak 11: session and conversation keys, and the host name, are masked", () => {
  const keys = redactDiagnostics('{"sessionKey":"conv-8f3a9","conversationId":"thread_99887"}', {});
  assert.ok(!keys.includes("conv-8f3a9"), JSON.stringify(keys));
  assert.ok(!keys.includes("thread_99887"), JSON.stringify(keys));
  const host = hostname();
  if (host.trim().length >= 3) {
    const redacted = redactDiagnostics(`host ${host} joined`, {});
    assert.ok(!redacted.includes(host), JSON.stringify(redacted));
    assert.ok(redacted.includes("<主机名>"), JSON.stringify(redacted));
  }
});

test("http(s) URL paths are not treated as local paths", () => {
  const line = "GET https://example.com/a/b?id=1 ok";
  assert.equal(redactDiagnostics(line, {}), line);
  const local = "wss://127.0.0.1:9/feed";
  assert.equal(redactDiagnostics(local, {}), local);
});

test("CJK 「」『』 quoted contents are hidden", () => {
  assert.equal(redactDiagnostics("检测到「张三的分组」和『李四堆叠』", {}), "检测到「<已隐藏>」和『<已隐藏>』");
});

test("stack traces keep their line/column suffixes", () => {
  assert.equal(
    redactDiagnostics("at Object.<anonymous> (/Users/alice/app.mjs:12:9)", { homeDir: "/Users/alice" }),
    "at Object.<anonymous> (~<路径>.mjs:12:9)",
  );
});

test("redaction masks the library directory with either separator", () => {
  const options = { homeDir: "/Users/alice", libraryDir: "/Users/alice/MOSA Library" };
  // Task 315: the part behind a known root is masked too — file names are
  // private — so only the placeholder and the extension survive.
  assert.equal(
    redactDiagnostics("scanning /Users/alice/MOSA Library/assets/a.png done", options),
    "scanning <素材库><路径>.png done",
  );
  const windows = { homeDir: "C:\\Users\\bob", libraryDir: "C:\\Users\\bob\\GravityPort Library" };
  assert.equal(
    redactDiagnostics("at C:\\Users\\bob\\GravityPort Library\\cache ok", windows),
    "at <素材库><路径> ok",
  );
  assert.equal(
    redactDiagnostics("at C:/Users/bob/GravityPort Library/cache ok", windows),
    "at <素材库><路径> ok",
  );
});

test("redaction masks the home directory as ~ with either separator", () => {
  assert.equal(redactDiagnostics("cfg /Users/alice/.mosa/x", { homeDir: "/Users/alice" }), "cfg ~<路径>");
  const windows = { homeDir: "C:\\Users\\bob" };
  assert.equal(redactDiagnostics("cfg C:\\Users\\bob\\AppData", windows), "cfg ~<路径>");
  assert.equal(redactDiagnostics("cfg C:/Users/bob/AppData", windows), "cfg ~<路径>");
  assert.equal(redactDiagnostics("cfg C:\\users\\BOB\\AppData", windows), "cfg ~<路径>", "Windows paths match case-insensitively");
});

test("the library directory wins when it sits inside the home directory", () => {
  assert.equal(
    redactDiagnostics("at /Users/alice/MOSA Library/assets", { homeDir: "/Users/alice", libraryDir: "/Users/alice/MOSA Library" }),
    "at <素材库><路径>",
  );
  assert.equal(
    redactDiagnostics("lib at /Users/alice/MOSA Library", { homeDir: "/Users/alice", libraryDir: "/Users/alice/MOSA Library" }),
    "lib at <素材库>",
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
