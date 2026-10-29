import assert from "node:assert/strict";
import test from "node:test";
import { PROMPT_STATUS_RANK, promptRank, promptStatusLevel, shouldUpgradePrompt } from "../lib/prompt-rank.mjs";

test("every known prompt status has the agreed level in the single rank table", () => {
  // Level 0: unavailable in any shape, plus anything missing from the table.
  for (const status of ["not-available", "not-available-in-session", "image-generation-prompt-unavailable", ""]) {
    assert.equal(promptStatusLevel(status), 0, `${status || "(empty)"} ranks 0`);
  }
  assert.equal(promptStatusLevel("some-status-nobody-defined"), 0, "unknown statuses rank 0");
  // Level 1: user-typed or page-visible unverified prompts.
  for (const status of ["user-message", "provider-visible-prompt", "session-user-prompt", "task-user-prompt", "canvas-alt-text-only"]) {
    assert.equal(promptStatusLevel(status), 1, `${status} ranks 1`);
  }
  // Level 2: caption text around the image.
  assert.equal(promptStatusLevel("visible-caption"), 2);
  // Level 3: the tool/revised prompt the generator actually ran.
  assert.equal(promptStatusLevel("generation-tool-prompt"), 3);
  assert.equal(promptStatusLevel("image-generation-revised-prompt"), 3);
  // Level 4: a human edit through a marked entry point.
  assert.equal(promptStatusLevel("user-edited"), 4);
  assert.equal(Object.getPrototypeOf(PROMPT_STATUS_RANK), Object.prototype);
});

test("an empty incoming prompt never replaces the stored one", () => {
  const stored = { prompt: "a poster of Bangkok", status: "visible-caption", priority: 0 };
  assert.equal(shouldUpgradePrompt(stored, { prompt: "", status: "generation-tool-prompt", priority: 0 }), false);
  assert.equal(shouldUpgradePrompt(stored, { prompt: "   ", status: "generation-tool-prompt", priority: 0 }), false);
  assert.equal(shouldUpgradePrompt(stored, { status: "generation-tool-prompt" }), false);
  assert.equal(shouldUpgradePrompt(stored, null), false);
});

test("within one level only a longer candidate wins; a shorter or equal one does not", () => {
  const stored = { prompt: "a poster of Bangkok", status: "visible-caption", priority: 0 };
  const longer = `${stored.prompt}, now with extra composition detail`;
  assert.equal(shouldUpgradePrompt(stored, { prompt: shorter(stored.prompt), status: "visible-caption", priority: 0 }), false);
  assert.equal(shouldUpgradePrompt(stored, { prompt: stored.prompt, status: "visible-caption", priority: 0 }), false);
  assert.equal(shouldUpgradePrompt(stored, { prompt: longer, status: "visible-caption", priority: 0 }), true);
});

test("a higher level wins even when its text is shorter", () => {
  const stored = { prompt: "a poster of Bangkok with bold typography and limited red and cream palette", status: "visible-caption", priority: 0 };
  assert.equal(
    shouldUpgradePrompt(stored, { prompt: "short tool prompt", status: "generation-tool-prompt", priority: 0 }),
    true,
    "generation-tool-prompt outranks visible-caption regardless of length",
  );
  assert.equal(
    shouldUpgradePrompt({ prompt: "tool prompt text", status: "generation-tool-prompt", priority: 0 }, { prompt: "u", status: "user-edited", priority: 0 }),
    true,
    "a user edit outranks the tool prompt",
  );
});

test("a caller-assigned priority outranks the status level", () => {
  const stored = { prompt: "tool prompt", status: "generation-tool-prompt", priority: 0 };
  assert.equal(
    shouldUpgradePrompt(stored, { prompt: "page caption", status: "visible-caption", priority: 1 }),
    true,
    "priority 1 lifts a caption above the unprioritized tool prompt",
  );
  assert.equal(
    shouldUpgradePrompt({ prompt: "caption", status: "visible-caption", priority: 1 }, { prompt: "longer tool prompt text", status: "generation-tool-prompt", priority: 0 }),
    false,
    "without priority the tool prompt cannot beat a prioritized caption",
  );
});

test("promptRank keeps the agreed formula: priority, then level, then length", () => {
  assert.equal(promptRank("visible-caption", "abc", 0), 2 * 10000 + 3);
  assert.equal(promptRank("visible-caption", "  abc  ", 0), 2 * 10000 + 3, "length is measured after trimming");
  assert.equal(promptRank("visible-caption", "abc", 2), 2 * 1_000_000 + 2 * 10000 + 3);
  assert.equal(promptRank("visible-caption", "x".repeat(9000), 0), 2 * 10000 + 5000, "length is capped at 5000");
  assert.equal(promptRank("visible-caption", "abc", -5), 2 * 10000 + 3, "negative priorities clamp to 0");
  assert.equal(promptRank(undefined, undefined, undefined), 0);
});

test("dropping the legacy same-rank +40-chars clause does not change reachable behavior", () => {
  // The old rule also upgraded when the rank merely tied but the text grew by
  // more than 40 characters. Because length is part of the score, a tie with
  // the same status and priority implies the same capped length, so the extra
  // clause could only fire where it was already covered — or beyond the 5000
  // length cap, which is not a real prompt. The reachable cases behave
  // identically without it.
  const stored = { prompt: "a", status: "visible-caption", priority: 0 };
  assert.equal(shouldUpgradePrompt(stored, { prompt: longerBy(stored.prompt, 41), status: "visible-caption", priority: 0 }), true);
  assert.equal(shouldUpgradePrompt(stored, { prompt: longerBy(stored.prompt, 1), status: "visible-caption", priority: 0 }), true, "any real length growth upgrades within a level");
  assert.equal(shouldUpgradePrompt(stored, { prompt: stored.prompt, status: "visible-caption", priority: 0 }), false, "an identical candidate does not");
});

function shorter(text) {
  return String(text).slice(0, Math.max(1, String(text).length - 1));
}

function longerBy(text, extra) {
  return `${text}${"x".repeat(extra)}`;
}
