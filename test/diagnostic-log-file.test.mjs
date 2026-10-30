// Task 315: the desktop-only local log file — warn/error only, redacted at
// write time with the caller-provided context, rotated at ~2 MB with two kept
// generations, mode 0700/0600, and every write failure swallowed quietly.
// Real module, real files in a temporary directory.

import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  attachDiagnosticLogFile,
  detachDiagnosticLogFile,
  installDiagnosticLog,
  uninstallDiagnosticLog,
  writeConsoleOnly,
} from "../lib/diagnostic-log.mjs";

const LOG_NAME = "gravityport.log";

function withSilentConsole(run) {
  const original = { warn: console.warn, error: console.error, info: console.info, log: console.log };
  console.warn = () => {};
  console.error = () => {};
  console.info = () => {};
  console.log = () => {};
  try {
    return run();
  } finally {
    console.warn = original.warn;
    console.error = original.error;
    console.info = original.info;
    console.log = original.log;
  }
}

function makeLogDir() {
  return mkdtempSync(join(tmpdir(), "mosa-diag-log-"));
}

test("the file sink writes warn/error only, redacted, with live context", async () => {
  const logDir = makeLogDir();
  let libraryDir = "/Users/zhangsan/first-library";
  try {
    await withSilentConsole(async () => {
      installDiagnosticLog();
      attachDiagnosticLogFile({ dir: logDir, redactContext: () => ({ homeDir: "/Users/zhangsan", libraryDir }) });
      try {
        console.warn(`warn line token=secret123 at ${libraryDir}/a.png`);
        console.error("error line alice@example.com");
        console.info("[MOSA] prefixed info must not land in the file");
        console.log("[MOSA] prefixed log must not land in the file");
        // Give the synchronous append a moment; writes are sync, this only
        // keeps the test honest about ordering.
        await delay(10);
        const content = readFileSync(join(logDir, LOG_NAME), "utf8");
        const written = content.trim().split("\n");
        assert.equal(written.length, 2, `only warn and error are written, got: ${JSON.stringify(written)}`);
        assert.match(written[0], / warn /);
        assert.ok(!written[0].includes("secret123"), "token masked at write time");
        assert.ok(written[0].includes("token=<已隐藏>"), written[0]);
        assert.ok(!written[0].includes("/Users/zhangsan"), "library path masked at write time");
        assert.ok(written[0].includes("<素材库><路径>.png"), written[0]);
        assert.ok(written[1].includes("<邮箱>"), written[1]);
        assert.ok(!content.includes("prefixed info"), "info stays out of the file");

        // The context function is re-read on every write, so a moved library
        // is followed without re-attaching.
        libraryDir = "/Users/zhangsan/second-library";
        console.warn(`after move ${libraryDir}/b.png`);
        await delay(10);
        const after = readFileSync(join(logDir, LOG_NAME), "utf8");
        assert.ok(after.includes("<素材库>"), after);
        assert.ok(!after.includes("second-library"), after);
      } finally {
        detachDiagnosticLogFile();
        uninstallDiagnosticLog();
      }
    });
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("the directory is 0700 and the file 0600", () => {
  const logDir = makeLogDir();
  try {
    withSilentConsole(() => {
      installDiagnosticLog();
      try {
        attachDiagnosticLogFile({ dir: logDir, redactContext: () => ({}) });
        assert.equal(statSync(logDir).mode & 0o777, 0o700, "directory mode");
        assert.equal(statSync(join(logDir, LOG_NAME)).mode & 0o777, 0o600, "file mode");
      } finally {
        detachDiagnosticLogFile();
        uninstallDiagnosticLog();
      }
    });
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("a full log rotates into .1, and .1 shifts into .2", () => {
  const logDir = makeLogDir();
  const firstBlock = Buffer.alloc(2 * 1024 * 1024, 0x61);
  const secondBlock = Buffer.alloc(2 * 1024 * 1024, 0x62);
  try {
    withSilentConsole(() => {
      installDiagnosticLog();
      try {
        attachDiagnosticLogFile({ dir: logDir, redactContext: () => ({}) });
        writeFileSync(join(logDir, LOG_NAME), firstBlock);
        console.warn("first rotation marker");
        assert.ok(existsSync(join(logDir, `${LOG_NAME}.1`)), "the full file became .1");
        assert.ok(!existsSync(join(logDir, `${LOG_NAME}.2`)), "no .2 after the first rotation");
        assert.ok(readFileSync(join(logDir, `${LOG_NAME}.1`)).equals(firstBlock), ".1 is the rotated full file");
        assert.ok(readFileSync(join(logDir, LOG_NAME), "utf8").includes("first rotation marker"), "the new line went into a fresh log");

        writeFileSync(join(logDir, LOG_NAME), secondBlock);
        console.warn("second rotation marker");
        assert.ok(readFileSync(join(logDir, `${LOG_NAME}.2`)).equals(firstBlock), ".2 holds the first full file");
        assert.ok(readFileSync(join(logDir, `${LOG_NAME}.1`)).equals(secondBlock), ".1 holds the second full file");
        assert.ok(readFileSync(join(logDir, LOG_NAME), "utf8").includes("second rotation marker"));
      } finally {
        detachDiagnosticLogFile();
        uninstallDiagnosticLog();
      }
    });
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("leftover .3-and-up generations are swept on attach", () => {
  const logDir = makeLogDir();
  try {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, `${LOG_NAME}.3`), "old3");
    writeFileSync(join(logDir, `${LOG_NAME}.7`), "old7");
    writeFileSync(join(logDir, `${LOG_NAME}.2`), "keep2");
    writeFileSync(join(logDir, "unrelated.txt"), "keep");
    withSilentConsole(() => {
      installDiagnosticLog();
      try {
        attachDiagnosticLogFile({ dir: logDir, redactContext: () => ({}) });
        assert.ok(!existsSync(join(logDir, `${LOG_NAME}.3`)), ".3 swept");
        assert.ok(!existsSync(join(logDir, `${LOG_NAME}.7`)), ".7 swept");
        assert.ok(existsSync(join(logDir, `${LOG_NAME}.2`)), ".2 kept");
        assert.ok(existsSync(join(logDir, "unrelated.txt")), "unrelated files kept");
      } finally {
        detachDiagnosticLogFile();
        uninstallDiagnosticLog();
      }
    });
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("a write failure switches the sink off quietly and never throws", () => {
  const logDir = makeLogDir();
  try {
    withSilentConsole(() => {
      installDiagnosticLog();
      try {
        attachDiagnosticLogFile({ dir: logDir, redactContext: () => ({}) });
        unlinkSync(join(logDir, LOG_NAME)); // statSync in the sink now fails
        console.warn("this write must fail without throwing");
        console.error("and this one too, with no file recreated");
        assert.ok(!existsSync(join(logDir, LOG_NAME)), "the sink gave up instead of recreating the file");
        console.warn("still no throw after the sink is gone");
      } finally {
        detachDiagnosticLogFile();
        uninstallDiagnosticLog();
      }
    });
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("an unwritable directory leaves the sink off without throwing", () => {
  const logDir = makeLogDir();
  const blocked = join(logDir, "blocked");
  try {
    mkdirSync(blocked, { recursive: true });
    chmodSync(blocked, 0o500); // read+execute only: mkdir/files inside must fail
    withSilentConsole(() => {
      installDiagnosticLog();
      try {
        attachDiagnosticLogFile({ dir: join(blocked, "logs"), redactContext: () => ({}) });
        console.warn("must not throw even though the directory is unwritable");
        assert.ok(!existsSync(join(blocked, "logs", LOG_NAME)), "no file was created");
      } finally {
        detachDiagnosticLogFile();
        uninstallDiagnosticLog();
      }
    });
  } finally {
    chmodSync(blocked, 0o700);
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("writeConsoleOnly never touches the file", () => {
  const logDir = makeLogDir();
  try {
    withSilentConsole(() => {
      installDiagnosticLog();
      try {
        attachDiagnosticLogFile({ dir: logDir, redactContext: () => ({}) });
        writeConsoleOnly("error", "real console only");
        assert.equal(readFileSync(join(logDir, LOG_NAME), "utf8"), "", "the file stays empty");
      } finally {
        detachDiagnosticLogFile();
        uninstallDiagnosticLog();
      }
    });
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("reattaching replaces the previous sink instead of double-writing", () => {
  const logDir = makeLogDir();
  try {
    withSilentConsole(() => {
      installDiagnosticLog();
      try {
        attachDiagnosticLogFile({ dir: logDir, redactContext: () => ({}) });
        attachDiagnosticLogFile({ dir: logDir, redactContext: () => ({}) });
        console.warn("exactly once");
        const written = readFileSync(join(logDir, LOG_NAME), "utf8").trim().split("\n");
        assert.equal(written.length, 1, JSON.stringify(written));
      } finally {
        detachDiagnosticLogFile();
        uninstallDiagnosticLog();
      }
    });
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("rotation never accumulates more than three files", () => {
  const logDir = makeLogDir();
  try {
    withSilentConsole(() => {
      installDiagnosticLog();
      try {
        attachDiagnosticLogFile({ dir: logDir, redactContext: () => ({}) });
        for (let round = 0; round < 4; round += 1) {
          writeFileSync(join(logDir, LOG_NAME), Buffer.alloc(2 * 1024 * 1024, 0x61 + round));
          console.warn(`round ${round}`);
        }
        const names = readdirSync(logDir).sort();
        assert.ok(names.length <= 3, `at most three files, got ${JSON.stringify(names)}`);
        assert.deepEqual(names, [LOG_NAME, `${LOG_NAME}.1`, `${LOG_NAME}.2`]);
        copyFileSync(join(logDir, LOG_NAME), join(logDir, "snapshot.log"));
      } finally {
        detachDiagnosticLogFile();
        uninstallDiagnosticLog();
      }
    });
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});
