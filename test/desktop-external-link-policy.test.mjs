import assert from "node:assert/strict";
import test from "node:test";
import {
  externalLinkDecision,
  openExternalLinkByPolicy,
  openExternalLinkOutcome,
  truncateExternalLinkForDialog,
} from "../desktop/open-external-link.mjs";

test("allowlisted destinations open without a dialog", () => {
  const allowed = [
    "https://www.pinterest.com/pin/123456/",
    "https://pinterest.com/pin/1/",
    "https://gravityport.azhuilab.com/#download",
    "https://gravityport.azhuilab.com/releases/0.3.7",
    "https://github.com/fengseekling-coder/gravityport",
    "https://github.com/fengseekling-coder/gravityport/",
    "https://github.com/fengseekling-coder/gravityport/blob/main/docs/guide.zh-CN.md",
    "https://github.com/fengseekling-coder/gravityport/blob/main/docs/guide.zh-CN.md#mcp-与接口",
    "https://github.com:443/fengseekling-coder/gravityport",
  ];
  for (const url of allowed) {
    const decision = externalLinkDecision(url);
    assert.equal(decision.action, "open", url);
    assert.equal(decision.href, new URL(url).href, url);
  }
});

test("everything else http/https asks for confirmation, including http to allowlisted hosts", () => {
  const confirmed = [
    "http://www.pinterest.com/pin/1/",
    "http://gravityport.azhuilab.com/",
    "https://evil.pinterest.com.example/pin/1/",
    "https://www.pinterest.com.evil.test/pin/1/",
    "https://pinterest.example.com/",
    "https://github.com/someone-else/repo",
    "https://github.com/fengseekling-coder/other-repo",
    "https://gravityport.azhuilab.com:8443/",
    "https://example.com/",
  ];
  for (const url of confirmed) {
    const decision = externalLinkDecision(url);
    assert.equal(decision.action, "confirm", url);
    assert.equal(decision.href, new URL(url).href, url);
    assert.equal(decision.host, new URL(url).hostname, url);
  }
});

test("protocol violations, embedded credentials, and oversize URLs are denied", () => {
  const denied = [
    "https://user:pass@gravityport.azhuilab.com/",
    "https://user@gravityport.azhuilab.com/",
    "file:///etc/hosts",
    "javascript:alert(1)",
    "ftp://example.com/file",
    `https://example.com/${"a".repeat(2100)}`,
    "",
    "not a url",
    42,
    null,
    undefined,
  ];
  for (const url of denied) {
    assert.deepEqual(externalLinkDecision(url), { action: "deny" }, String(url));
  }
});

test("href is the normalized URL and internationalized hosts surface as xn--", () => {
  const decision = externalLinkDecision("https://gravityport.azhuilab.com/a b?x=1");
  assert.equal(decision.action, "open");
  assert.equal(decision.href, "https://gravityport.azhuilab.com/a%20b?x=1");

  const idn = externalLinkDecision("https://ünicode.example/pin/1/");
  assert.equal(idn.action, "confirm");
  assert.match(idn.host, /^xn--/, "the confirm dialog must show the punycode host");
});

test("the confirm dialog text truncates long URLs at 300 characters", () => {
  const short = "https://example.com/a";
  assert.equal(truncateExternalLinkForDialog(short), short);
  const long = `https://example.com/${"b".repeat(400)}`;
  const truncated = truncateExternalLinkForDialog(long);
  assert.equal(truncated.length, 301);
  assert.ok(truncated.endsWith("…"));
});

function fakeDialogText(key, values = {}) {
  return `${key}?${Object.entries(values).map(([k, v]) => `${k}=${v}`).join("&")}`;
}

test("deny decisions never touch the dialog or the shell", async () => {
  const calls = [];
  const result = await openExternalLinkByPolicy({
    url: "file:///etc/hosts",
    dialogText: fakeDialogText,
    confirmDialog: async () => { calls.push("dialog"); return { response: 0 }; },
    openExternal: async () => { calls.push("open"); },
  });
  assert.deepEqual(result, { ok: false });
  assert.deepEqual(calls, []);
});

test("open decisions skip the dialog and hand the normalized href to the shell", async () => {
  const opened = [];
  const result = await openExternalLinkByPolicy({
    url: "https://gravityport.azhuilab.com/#download",
    dialogText: fakeDialogText,
    confirmDialog: async () => { throw new Error("must not be called"); },
    openExternal: async (href) => { opened.push(href); },
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(opened, ["https://gravityport.azhuilab.com/#download"]);
});

test("confirm decisions raise the system dialog; cancelling is not a failure", async () => {
  const dialogs = [];
  const opened = [];
  const result = await openExternalLinkByPolicy({
    url: "https://example.com/some/page",
    dialogText: fakeDialogText,
    confirmDialog: async (options) => {
      dialogs.push(options);
      return { response: 1 };
    },
    openExternal: async (href) => { opened.push(href); },
  });
  assert.deepEqual(result, { ok: true, opened: false });
  assert.deepEqual(opened, [], "a cancelled confirm must not call shell.openExternal");
  assert.equal(dialogs.length, 1);
  const dialog = dialogs[0];
  assert.equal(dialog.type, "warning");
  assert.match(dialog.message, /^externalLinkConfirmTitle\?host=example\.com$/);
  assert.match(dialog.detail, /^externalLinkConfirmBody\?url=https:\/\/example\.com\/some\/page$/);
  assert.deepEqual(dialog.buttons, ["externalLinkConfirmOpen?", "externalLinkConfirmCancel?"]);
  assert.equal(dialog.defaultId, 1, "Enter lands on cancel");
  assert.equal(dialog.cancelId, 1);
  assert.equal(dialog.noLink, true);
});

test("confirming the dialog opens the normalized href", async () => {
  const opened = [];
  const result = await openExternalLinkByPolicy({
    url: "http://example.com/pin/1",
    dialogText: fakeDialogText,
    confirmDialog: async () => ({ response: 0 }),
    openExternal: async (href) => { opened.push(href); },
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(opened, ["http://example.com/pin/1"]);
});

test("a long URL is truncated before it reaches the dialog body", async () => {
  const longUrl = `https://example.com/${"c".repeat(400)}`;
  const dialogs = [];
  await openExternalLinkByPolicy({
    url: longUrl,
    dialogText: fakeDialogText,
    confirmDialog: async (options) => { dialogs.push(options); return { response: 1 }; },
    openExternal: async () => {},
  });
  assert.match(dialogs[0].detail, new RegExp(`url=${longUrl.slice(0, 300).replace(/[.*+?${}()|[\]\\]/g, "\\$&")}…$`));
});

test("shell failures resolve { ok: false } and emit a warn line", async () => {
  const warns = [];
  const result = await openExternalLinkByPolicy({
    url: "https://gravityport.azhuilab.com/",
    dialogText: fakeDialogText,
    confirmDialog: async () => { throw new Error("must not be called"); },
    openExternal: async () => { throw new Error("spawn failed"); },
    warn: (line) => warns.push(line),
  });
  assert.deepEqual(result, { ok: false });
  assert.match(warns[0], /unable to open external link: spawn failed/);
});

test("openExternalLinkOutcome keeps its original protocol/length contract", () => {
  assert.deepEqual(openExternalLinkOutcome("https://example.com/"), { ok: true });
  assert.deepEqual(openExternalLinkOutcome("http://example.com/"), { ok: true });
  assert.deepEqual(openExternalLinkOutcome("file:///etc/hosts"), { ok: false });
  assert.deepEqual(openExternalLinkOutcome(""), { ok: false });
  assert.deepEqual(openExternalLinkOutcome(`https://example.com/${"a".repeat(2100)}`), { ok: false });
});
