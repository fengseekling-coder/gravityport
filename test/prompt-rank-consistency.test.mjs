// The browser extension cannot import lib/prompt-rank.mjs, so it keeps its own
// copy of the prompt rank order (background.js promptPayloadRank, content.js
// promptQuality). A drifting copy would let the extension send — or keep — a
// different prompt than the server would have ranked first, so this test reads
// the two sources and locks every entry to the shared table.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PROMPT_STATUS_RANK } from "../lib/prompt-rank.mjs";

const extensionRoot = fileURLToPath(new URL("../extensions/chatgpt-web-capture/", import.meta.url));

function tableOf(source, functionName) {
  const start = source.indexOf(`function ${functionName}`);
  assert.notEqual(start, -1, `${functionName} must exist in the extension source`);
  const bodyStart = source.indexOf("const rank = {", start);
  assert.notEqual(bodyStart, -1, `${functionName} must carry a rank table`);
  const bodyEnd = source.indexOf("} [", bodyStart) !== -1 ? source.indexOf("} [", bodyStart) : source.indexOf("}[", bodyStart);
  assert.notEqual(bodyEnd, -1, `${functionName}'s rank table must close`);
  const table = {};
  for (const [, status, value] of source.slice(bodyStart, bodyEnd).matchAll(/"([a-z0-9-]+)":\s*(\d+)/g)) {
    table[status] = Number(value);
  }
  return table;
}

test("the background rank table matches the shared PROMPT_STATUS_RANK", async () => {
  const source = await readFile(`${extensionRoot}background.js`, "utf8");
  const table = tableOf(source, "promptPayloadRank");
  assert.ok(Object.keys(table).length >= 5, "the background table must still cover the statuses it reports");
  for (const [status, level] of Object.entries(table)) {
    assert.equal(level, PROMPT_STATUS_RANK[status], `background.js ranks ${status} ${level}, the shared table says ${PROMPT_STATUS_RANK[status]}`);
  }
});

test("the content-script rank table matches the shared PROMPT_STATUS_RANK", async () => {
  const source = await readFile(`${extensionRoot}content.js`, "utf8");
  const table = tableOf(source, "promptQuality");
  for (const [status, level] of Object.entries(table)) {
    assert.equal(level, PROMPT_STATUS_RANK[status], `content.js ranks ${status} ${level}, the shared table says ${PROMPT_STATUS_RANK[status]}`);
  }
});

test("both extension tables cover every status the extension reports upstream", async () => {
  const background = tableOf(await readFile(`${extensionRoot}background.js`, "utf8"), "promptPayloadRank");
  const content = tableOf(await readFile(`${extensionRoot}content.js`, "utf8"), "promptQuality");
  // The statuses the capture pipeline can put on a payload or candidate.
  for (const status of ["not-available", "user-message", "provider-visible-prompt", "visible-caption", "generation-tool-prompt"]) {
    assert.ok(status in background, `background.js must rank ${status}`);
    assert.ok(status in content, `content.js must rank ${status}`);
  }
});
