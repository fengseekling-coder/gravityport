import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { isQuietQaRun, createScreenGuard } from "../desktop/quiet-qa-screen.mjs";

test("isQuietQaRun: returns true only for unpackaged QA runs", () => {
  assert.equal(isQuietQaRun({ env: { MOSA_QA_RUN: "1" }, isPackaged: false }), true);
  assert.equal(isQuietQaRun({ env: { MOSA_QA_RUN: "true" }, isPackaged: false }), true);
  // Packaged app must NEVER enter quiet QA mode
  assert.equal(isQuietQaRun({ env: { MOSA_QA_RUN: "1" }, isPackaged: true }), false);
  assert.equal(isQuietQaRun({ env: { MOSA_QA_RUN: "true" }, isPackaged: true }), false);
  // Without MOSA_QA_RUN, quiet mode is false
  assert.equal(isQuietQaRun({ env: {}, isPackaged: false }), false);
  assert.equal(isQuietQaRun({ env: {}, isPackaged: true }), false);
  assert.equal(isQuietQaRun({ env: { MOSA_QA_RUN: "" }, isPackaged: false }), false);
  assert.equal(isQuietQaRun({ env: undefined, isPackaged: false }), false);
});

test("createScreenGuard (quiet mode): suppresses all UI and logs correct prefixes", async () => {
  const logs = [];
  const log = (msg) => logs.push(msg);

  const calls = {
    showErrorBox: [],
    showMessageBox: [],
    showOpenDialog: [],
    openExternal: [],
    notificationCreated: [],
    notificationShown: [],
    startDrag: [],
    show: [],
    showInactive: [],
    focus: [],
    restore: [],
  };

  class MockNotification {
    constructor(opts) {
      calls.notificationCreated.push(opts);
    }
    static isSupported() { return true; }
    on() {}
    show() { calls.notificationShown.push(true); }
  }

  const electronMock = {
    dialog: {
      showErrorBox: (...args) => calls.showErrorBox.push(args),
      showMessageBox: (...args) => { calls.showMessageBox.push(args); return Promise.resolve({ response: 99 }); },
      showOpenDialog: (...args) => { calls.showOpenDialog.push(args); return Promise.resolve({ canceled: false, filePaths: ["/real/path"] }); },
    },
    shell: {
      openExternal: (url) => { calls.openExternal.push(url); return Promise.resolve(); },
    },
    Notification: MockNotification,
  };

  const winMock = {
    show: () => calls.show.push(true),
    showInactive: () => calls.showInactive.push(true),
    focus: () => calls.focus.push(true),
    restore: () => calls.restore.push(true),
    isMinimized: () => true,
    setOpacity: () => {},
    setIgnoreMouseEvents: () => {},
    setHasShadow: () => {},
  };

  const webContentsMock = {
    startDrag: (opts) => calls.startDrag.push(opts),
  };

  const guard = createScreenGuard({
    quiet: true,
    quietWindow: true,
    electron: electronMock,
    log,
    windowMode: "p1",
  });

  // 1. errorBox
  guard.errorBox("Fatal Startup Error", "First line of failure\nSecond line with details");
  assert.equal(calls.showErrorBox.length, 0, "dialog.showErrorBox must not be called");
  assert.ok(
    logs.some((l) => l === "QA_STARTUP_FAILED: Fatal Startup Error | First line of failure"),
    "stderr must have QA_STARTUP_FAILED prefix with title and first line of body",
  );

  // 2. messageBox (with cancelId)
  const mbResult = await guard.messageBox(winMock, { title: "Confirm Action", cancelId: 2 });
  assert.equal(calls.showMessageBox.length, 0, "dialog.showMessageBox must not be called");
  assert.deepEqual(mbResult, { response: 2 }, "messageBox should return cancelId");
  assert.ok(logs.some((l) => l.startsWith("QA_UI_SUPPRESSED: messageBox Confirm Action")));

  // 2b. messageBox without owner and default cancelId
  const mbResult2 = await guard.messageBox({ message: "Default question" });
  assert.equal(calls.showMessageBox.length, 0);
  assert.deepEqual(mbResult2, { response: 0 }, "messageBox defaults to response 0");

  // 3. openDialog
  const odResult = await guard.openDialog(winMock, { title: "Pick Folder" });
  assert.equal(calls.showOpenDialog.length, 0, "dialog.showOpenDialog must not be called");
  assert.deepEqual(odResult, { canceled: true, filePaths: [] }, "openDialog returns canceled: true");
  assert.ok(logs.some((l) => l.startsWith("QA_UI_SUPPRESSED: openDialog Pick Folder")));

  // 4. openExternal (strips query string)
  const extResult = await guard.openExternal("https://www.pinterest.com/oauth/?state=SECRET_TOKEN&client_id=12345");
  assert.equal(calls.openExternal.length, 0, "shell.openExternal must not be called");
  assert.equal(extResult, undefined, "openExternal returns resolved");
  const extLog = logs.find((l) => l.startsWith("QA_UI_SUPPRESSED: openExternal"));
  assert.ok(extLog, "logs QA_UI_SUPPRESSED for openExternal");
  assert.ok(extLog.includes("https://www.pinterest.com/oauth/"), "keeps protocol, host, and path");
  assert.ok(!extLog.includes("SECRET_TOKEN") && !extLog.includes("state"), "strips query string");

  // 5. notify
  const notifResult = guard.notify({ title: "Update Ready", body: "v1.0 is available" });
  assert.equal(calls.notificationCreated.length, 0, "new Notification must not be called");
  assert.equal(calls.notificationShown.length, 0, "notification.show must not be called");
  assert.equal(notifResult, null, "notify returns null in quiet mode");
  assert.ok(logs.some((l) => l === "QA_UI_SUPPRESSED: notification Update Ready"));

  // 6. startDrag
  guard.startDrag(webContentsMock, { file: "/path/to/img.png", files: ["/path/to/img.png"] });
  assert.equal(calls.startDrag.length, 0, "webContents.startDrag must not be called");
  assert.ok(logs.some((l) => l === "QA_UI_SUPPRESSED: startDrag /path/to/img.png"));

  // 7. showWindow (P1 mode: neither show nor showInactive called)
  guard.showWindow(winMock);
  assert.equal(calls.show.length, 0, "show must not be called in P1");
  assert.equal(calls.showInactive.length, 0, "showInactive must not be called in P1");
  assert.ok(logs.some((l) => l === "QA_UI_SUPPRESSED: showWindow"));

  // 8. focusWindow
  guard.focusWindow(winMock);
  assert.equal(calls.restore.length, 0, "restore must not be called");
  assert.equal(calls.focus.length, 0, "focus must not be called");
  assert.ok(logs.some((l) => l === "QA_UI_SUPPRESSED: focusWindow"));
});

test("createScreenGuard (quiet mode P2): showWindow sets opacity 0 and calls showInactive without show", () => {
  const logs = [];
  const calls = {
    show: [],
    showInactive: [],
    setOpacity: [],
    setIgnoreMouseEvents: [],
    setHasShadow: [],
  };

  const winMock = {
    show: () => calls.show.push(true),
    showInactive: () => calls.showInactive.push(true),
    setOpacity: (val) => calls.setOpacity.push(val),
    setIgnoreMouseEvents: (val) => calls.setIgnoreMouseEvents.push(val),
    setHasShadow: (val) => calls.setHasShadow.push(val),
  };

  const guardP2 = createScreenGuard({
    quiet: true,
    quietWindow: true,
    log: (msg) => logs.push(msg),
    windowMode: "p2",
  });

  guardP2.showWindow(winMock);
  assert.equal(calls.show.length, 0, "P2 must not call show()");
  assert.equal(calls.showInactive.length, 1, "P2 must call showInactive()");
  assert.deepEqual(calls.setOpacity, [0], "P2 sets opacity to 0");
  assert.deepEqual(calls.setIgnoreMouseEvents, [true], "P2 sets ignoreMouseEvents to true");
  assert.deepEqual(calls.setHasShadow, [false], "P2 sets hasShadow to false");
});

test("createScreenGuard (non-quiet mode): calls real APIs without logging", async () => {
  const logs = [];
  const log = (msg) => logs.push(msg);

  const calls = {
    showErrorBox: [],
    showMessageBox: [],
    showOpenDialog: [],
    openExternal: [],
    notificationCreated: [],
    notificationShown: [],
    startDrag: [],
    show: [],
    showInactive: [],
    focus: [],
    restore: [],
  };

  class MockNotification {
    constructor(opts) {
      calls.notificationCreated.push(opts);
    }
    static isSupported() { return true; }
    on(event, handler) { this.clickHandler = handler; }
    show() { calls.notificationShown.push(true); }
  }

  const electronMock = {
    dialog: {
      showErrorBox: (...args) => calls.showErrorBox.push(args),
      showMessageBox: (...args) => { calls.showMessageBox.push(args); return Promise.resolve({ response: 1 }); },
      showOpenDialog: (...args) => { calls.showOpenDialog.push(args); return Promise.resolve({ canceled: false, filePaths: ["/selected/folder"] }); },
    },
    shell: {
      openExternal: (url) => { calls.openExternal.push(url); return Promise.resolve("opened"); },
    },
    Notification: MockNotification,
  };

  const winMock = {
    show: () => calls.show.push(true),
    showInactive: () => calls.showInactive.push(true),
    focus: () => calls.focus.push(true),
    restore: () => calls.restore.push(true),
    isMinimized: () => true,
  };

  const webContentsMock = {
    startDrag: (opts) => calls.startDrag.push(opts),
  };

  const guard = createScreenGuard({
    quiet: false,
    quietWindow: false,
    electron: electronMock,
    log,
  });

  // errorBox
  guard.errorBox("Real Error", "Real Body");
  assert.equal(calls.showErrorBox.length, 1);
  assert.deepEqual(calls.showErrorBox[0], ["Real Error", "Real Body"]);

  // messageBox
  const mb = await guard.messageBox(winMock, { title: "Confirm" });
  assert.equal(calls.showMessageBox.length, 1);
  assert.deepEqual(mb, { response: 1 });

  // openDialog
  const od = await guard.openDialog(winMock, { title: "Open" });
  assert.equal(calls.showOpenDialog.length, 1);
  assert.deepEqual(od, { canceled: false, filePaths: ["/selected/folder"] });

  // openExternal
  const oe = await guard.openExternal("https://example.com/?param=1");
  assert.equal(calls.openExternal.length, 1);
  assert.equal(oe, "opened");

  // notify
  const notif = guard.notify({ title: "Note", body: "Msg" });
  assert.equal(calls.notificationCreated.length, 1);
  assert.equal(calls.notificationShown.length, 1);
  assert.ok(notif instanceof MockNotification);

  // startDrag
  guard.startDrag(webContentsMock, { file: "test.png" });
  assert.equal(calls.startDrag.length, 1);

  // showWindow
  guard.showWindow(winMock);
  assert.equal(calls.show.length, 1);
  assert.equal(calls.showInactive.length, 0);

  // focusWindow
  guard.focusWindow(winMock);
  assert.equal(calls.restore.length, 1);
  assert.equal(calls.focus.length, 1);

  // No logs should be produced in non-quiet mode
  assert.equal(logs.length, 0, "No suppression logs should be emitted when not quiet");
});

// ---- Source code nail tests (源码钉子) ----

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

test("source nail: main.mjs routes all UI and window actions through screenGuard", () => {
  const mainSource = readFileSync(resolve(import.meta.dirname, "..", "desktop", "main.mjs"), "utf8");
  const cleanCode = stripComments(mainSource);

  // 1. showLibraryLocationErrorAndExit must call screenGuard.errorBox
  const showLibraryLocationMatch = cleanCode.match(/function showLibraryLocationErrorAndExit\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(showLibraryLocationMatch, "showLibraryLocationErrorAndExit function found in main.mjs");
  assert.match(
    showLibraryLocationMatch[1],
    /screenGuard\.errorBox\(/,
    "showLibraryLocationErrorAndExit must call screenGuard.errorBox",
  );

  // 2. reportStartupFailure must call screenGuard.errorBox
  const reportStartupMatch = cleanCode.match(/function reportStartupFailure\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(reportStartupMatch, "reportStartupFailure function found in main.mjs");
  assert.match(
    reportStartupMatch[1],
    /screenGuard\.errorBox\(/,
    "reportStartupFailure must call screenGuard.errorBox",
  );

  // 3. Remove the createScreenGuard call block where electron imports { dialog, shell, Notification } are passed
  const guardInitMatch = cleanCode.match(/createScreenGuard\(\{[\s\S]*?\}\)/);
  assert.ok(guardInitMatch, "createScreenGuard instantiation found in main.mjs");
  const codeWithoutGuardInit = cleanCode.replace(guardInitMatch[0], "");

  // 4. Assert direct UI symbols are not present anywhere else in main.mjs
  assert.doesNotMatch(
    codeWithoutGuardInit,
    /\bdialog\./,
    "Direct dialog.* calls are forbidden in desktop/main.mjs (must use screenGuard)",
  );
  assert.doesNotMatch(
    codeWithoutGuardInit,
    /\bnew\s+Notification\(/,
    "Direct new Notification(...) calls are forbidden in desktop/main.mjs (must use screenGuard.notify)",
  );
  assert.doesNotMatch(
    codeWithoutGuardInit,
    /\bshell\.openExternal\(/,
    "Direct shell.openExternal(...) calls are forbidden in desktop/main.mjs (must use screenGuard.openExternal)",
  );
  assert.doesNotMatch(
    codeWithoutGuardInit,
    /(?<!screenGuard)\.startDrag\(/,
    "Direct webContents/event.sender.startDrag calls are forbidden in desktop/main.mjs (must use screenGuard.startDrag)",
  );
  assert.doesNotMatch(
    codeWithoutGuardInit,
    /\.showInactive\(/,
    "Direct window.showInactive(...) calls are forbidden in desktop/main.mjs (must use screenGuard.showWindow)",
  );
  assert.doesNotMatch(
    codeWithoutGuardInit,
    /(?<!screenGuard)\.show\(/,
    "Direct window/notification.show() calls are forbidden in desktop/main.mjs (must use screenGuard.showWindow)",
  );
  assert.doesNotMatch(
    codeWithoutGuardInit,
    /(?<!screenGuard)\.focus\(/,
    "Direct window.focus() calls are forbidden in desktop/main.mjs (must use screenGuard.focusWindow)",
  );
});
