import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { QA_FEEDBACK_TIMEOUT_MS, QA_FEEDBACK_URL, qaFeedbackEnv } from "../scripts/qa-feedback-env.mjs";

describe("qa launcher feedback env", () => {
  it("defaults to a blackhole address with a short timeout", () => {
    const env = qaFeedbackEnv({});
    assert.equal(env.MOSA_FEEDBACK_URL, "http://127.0.0.1:9");
    assert.equal(env.MOSA_FEEDBACK_URL, QA_FEEDBACK_URL);
    assert.equal(env.MOSA_FEEDBACK_TIMEOUT_MS, QA_FEEDBACK_TIMEOUT_MS);
    assert.ok(Number(env.MOSA_FEEDBACK_TIMEOUT_MS) <= 5000);
  });

  it("keeps values the caller already set", () => {
    const env = qaFeedbackEnv({ MOSA_FEEDBACK_URL: "http://127.0.0.1:4567/x", MOSA_FEEDBACK_TIMEOUT_MS: "150" });
    assert.equal(env.MOSA_FEEDBACK_URL, "http://127.0.0.1:4567/x");
    assert.equal(env.MOSA_FEEDBACK_TIMEOUT_MS, "150");
  });

  it("is spread into the child env of all three launch types, after process.env", () => {
    const source = readFileSync(new URL("../scripts/qa-launcher.mjs", import.meta.url), "utf8");
    const bridges = source.match(/MOSA_DISABLE_BRIDGES: QA_DISABLED_BRIDGES,\n\s+\.\.\.qaFeedbackEnv\(process\.env\),/g) ?? [];
    assert.equal(bridges.length, 3);
  });
});
