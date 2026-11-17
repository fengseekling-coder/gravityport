import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Task 428: the rename notice and the schema-upgrade notice open on their own
// (startup check, live post-upgrade verdict), not from a key or click. The
// App's Escape listener is re-armed by a passive effect after the commit that
// paints them, so an Escape landing in between saw the stale closure and was
// swallowed (CI run 43628176321). Their Escape branches read the render-time
// refs, the same way the authorization branch reads its queue ref.
const appSource = readFileSync(new URL("../web/gravityport/src/App.tsx", import.meta.url), "utf8");
const chainStart = appSource.indexOf('if (e.key === "Escape")');
const chain = appSource.slice(chainStart, appSource.indexOf("else applySelection([], \"\")", chainStart));

test("the Escape chain reads the notice refs, not the render-time notice flags", () => {
  assert.ok(chainStart >= 0, "the App keydown listener has an Escape chain");
  assert.match(chain, /else if \(renameNoticeRef\.current\) dismissRenameNotice\(\)/);
  assert.match(chain, /else if \(schemaNoticeRef\.current\) dismissSchemaUpgradeNotice\(\)/);
  assert.doesNotMatch(chain, /else if \(renameNoticeOpen\)/);
  assert.doesNotMatch(chain, /else if \(schemaNoticeOpen\)/);
});

test("the notice refs are written during render, so they are current before paint", () => {
  assert.match(appSource, /\n  renameNoticeRef\.current = renameNoticeOpen\n/);
  assert.match(appSource, /\n  schemaNoticeRef\.current = schemaNoticeOpen\n/);
});
