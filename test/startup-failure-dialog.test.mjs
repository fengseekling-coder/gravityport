// 任务 359 返工 1：库比 App 新的提示框必须等用户点完再关停退出。
// 真模块 desktop/startup-failure-flow.mjs 直接 import（文件名不用单子原定的
// startup-failure-dialog.mjs：desktop-quiet-qa-screen 的源码钉禁止 main.mjs
// 出现 \bdialog\.，import 路径里的 dialog.mjs 会误中）；messageBox /
// openExternal / shutdown 全部注入（照 startup-shutdown.mjs 的注入写法）。
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { showLibrarySchemaNewerDialogThenShutdown } from "../desktop/startup-failure-flow.mjs";

const DIALOG_OPTIONS = {
  type: "warning",
  title: "素材库比这个 App 新",
  message: "正文",
  buttons: ["前往官网下载", "取消"],
  defaultId: 0,
  cancelId: 1,
  noLink: true,
};
const DOWNLOAD_URL = "https://gravityport.app/download/";

test("dialog pending: shutdown waits; 取消 (response 1) shuts down without opening the download page", async () => {
  let releaseDialog;
  const messageBox = () => new Promise((resolveDialog) => { releaseDialog = resolveDialog; });
  const calls = [];
  const openExternal = async (url) => { calls.push(["openExternal", url]); };
  const shutdown = () => { calls.push(["shutdown"]); };

  const done = showLibrarySchemaNewerDialogThenShutdown({
    messageBox, openExternal, shutdown, owner: null, dialogOptions: DIALOG_OPTIONS, downloadUrl: DOWNLOAD_URL,
  });

  await delay(20);
  assert.deepEqual(calls, [], "shutdown must not run while the dialog is still open");

  releaseDialog({ response: 1 });
  await done;
  assert.deepEqual(calls, [["shutdown"]], "exactly one shutdown, no download-page open on 取消");
});

test("前往官网下载 (response 0): openExternal runs once with the download URL, before shutdown", async () => {
  const calls = [];
  const messageBox = async () => ({ response: 0 });
  const openExternal = async (url) => { calls.push(["openExternal", url]); };
  const shutdown = () => { calls.push(["shutdown"]); };

  await showLibrarySchemaNewerDialogThenShutdown({
    messageBox, openExternal, shutdown, owner: null, dialogOptions: DIALOG_OPTIONS, downloadUrl: DOWNLOAD_URL,
  });

  assert.deepEqual(calls, [["openExternal", DOWNLOAD_URL], ["shutdown"]]);
});

test("openExternal throwing does not stop the shutdown", async () => {
  let shutdowns = 0;
  const messageBox = async () => ({ response: 0 });
  const openExternal = async () => { throw new Error("no browser"); };
  const shutdown = () => { shutdowns += 1; };

  await showLibrarySchemaNewerDialogThenShutdown({
    messageBox, openExternal, shutdown, owner: null, dialogOptions: DIALOG_OPTIONS, downloadUrl: DOWNLOAD_URL,
  });

  assert.equal(shutdowns, 1, "shutdown still runs after a failed openExternal");
});

test("messageBox itself rejecting still shuts the process down (fail-safe, no lingering process)", async () => {
  let shutdowns = 0;
  let opens = 0;
  const messageBox = async () => { throw new Error("dialog could not be shown"); };
  const openExternal = async () => { opens += 1; };
  const shutdown = () => { shutdowns += 1; };

  await showLibrarySchemaNewerDialogThenShutdown({
    messageBox, openExternal, shutdown, owner: null, dialogOptions: DIALOG_OPTIONS, downloadUrl: DOWNLOAD_URL,
  });

  assert.equal(shutdowns, 1, "shutdown runs when the dialog never appears");
  assert.equal(opens, 0, "no download-page open without a user answer");
});
