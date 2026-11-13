// The browser extension cannot import lib/prompt-rank.mjs, so it keeps its own
// copy of the prompt rank order (background.js promptPayloadRank, content.js
// promptQuality). A drifting copy would let the extension send — or keep — a
// different prompt than the server would have ranked first, so this test calls
// the real functions through the vm harnesses (task 411: no more reading the
// sources) and locks every mirrored status to the shared table.
//
// Both functions fold the status rank into a composite score:
//   promptQuality(promptStatus, prompt) = rank * 10_000 + min(len, 5_000)
//   promptPayloadRank(payload)          = promptPriority * 100 + rank
// An empty prompt / a zero priority isolates the rank term.
import assert from "node:assert/strict";
import test from "node:test";
import { PROMPT_STATUS_RANK } from "../lib/prompt-rank.mjs";
import { createContentHarness } from "./helpers/content-harness.mjs";
import { createBackgroundHarness } from "./helpers/background-harness.mjs";

// The statuses the capture pipeline can put on a payload or candidate — the
// mirror set the extension's tables cover (anything else answers with the
// shared "not-available" rank of 0 via the functions' fallback).
const REPORTED_STATUSES = [
  "not-available",
  "user-message",
  "provider-visible-prompt",
  "visible-caption",
  "generation-tool-prompt",
];

const content = await createContentHarness({});
const background = await createBackgroundHarness({});

test("the background rank function matches the shared PROMPT_STATUS_RANK", () => {
  for (const status of REPORTED_STATUSES) {
    const rank = background.context.promptPayloadRank({ promptStatus: status, promptPriority: 0 });
    assert.equal(rank, PROMPT_STATUS_RANK[status], `background.js ranks ${status} ${rank}, the shared table says ${PROMPT_STATUS_RANK[status]}`);
  }
});

test("the content-script rank function matches the shared PROMPT_STATUS_RANK", () => {
  for (const status of REPORTED_STATUSES) {
    const quality = content.context.promptQuality(status, "");
    const rank = quality / 10_000;
    assert.equal(rank, PROMPT_STATUS_RANK[status], `content.js ranks ${status} ${rank}, the shared table says ${PROMPT_STATUS_RANK[status]}`);
  }
});

test("both extension rank functions cover every status the extension reports upstream", () => {
  for (const status of REPORTED_STATUSES) {
    assert.equal(
      background.context.promptPayloadRank({ promptStatus: status, promptPriority: 0 }),
      PROMPT_STATUS_RANK[status],
      `background.js must rank ${status}`,
    );
    assert.equal(
      content.context.promptQuality(status, "") / 10_000,
      PROMPT_STATUS_RANK[status],
      `content.js must rank ${status}`,
    );
  }
});
