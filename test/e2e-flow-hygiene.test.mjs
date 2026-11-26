// Task 469: e2e flow hygiene gate.
//
// Why these rules exist (PR #357 CI failure lessons):
// 1. Windows CI run 1/2 (learning-guide): at 1008px width the sort dropdown
//    (button.toolbar-select) covered .learn-filter-clear. A raw mouse click
//    without hit-testing landed on the dropdown and produced only a misleading
//    gallery timeout until hit-testing named the covering element.
// 2. macOS CI run 2 (learning-guide): clearing Emulation.setDeviceMetricsOverride
//    applies asynchronously; measuring and clicking right away hit stale
//    coordinates before layout settled.
// 3. macOS CI run 4 (settings-ai): clicking .user-button after reload failed to
//    open settings and gave only a bare timeout without hit/scene diagnostics.
// 4. Duplicated CDP helpers and ad-hoc sleeps/page waitFor loops across flows
//    made every timing fix only land in one file at a time.
//
// How to fix violations:
// - Rule 1 (raw `Input.dispatchMouseEvent`): use `clickCenter`, `doubleClick`,
//   or `hover` from `scripts/e2e-flows/_cdp.mjs`; for intentional raw-coordinate
//   actions (drags, wheel, blank-area right-clicks, side buttons, shadow DOM),
//   use `dispatchMouse(cdp, params, { reason })`.
// - Rule 2 (local CDP helper re-definitions): delete the local helper and
//   import `connectCdp`, `openCdpSession`, `waitForRendererReady`, `waitFor`,
//   `pointOf`, `clickCenter`, `doubleClick`, `hover`, or `clickAndWait` from
//   `scripts/e2e-flows/_cdp.mjs`.
// - Rule 3 (fixed waits >= 300ms): prefer a condition wait (`waitFor`). If a
//   fixed delay >= 300ms is genuinely required (e.g. asserting nothing changes
//   over a window), add a block comment on the SAME line:
//   `await sleep(500); /* e2e-sleep: 至少四个字的理由 */`
//   (use block comments, never `//`, because page scripts sometimes collapse
//   newlines to spaces). When you remove old sleeps, lower the file's count in
//   `test/e2e-flow-hygiene.baseline.json`.
// - Rule 4 (in-page `async function waitFor(check|predicate...)`): use
//   `${PAGE_WAIT_SOURCE}` from `scripts/e2e-flows/_shared.mjs`. When you migrate
//   a listed file off its custom `waitFor`, remove it from `pageWaitForOwners`
//   in `test/e2e-flow-hygiene.baseline.json`.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const flowsDir = join(rootDir, "scripts", "e2e-flows");
const baselinePath = join(rootDir, "test", "e2e-flow-hygiene.baseline.json");

const EXCLUDED_FILES = new Set(["_cdp.mjs", "_shared.mjs"]);

const FORBIDDEN_HELPER_PATTERNS = [
  /(?:async\s+)?function\s+(clickCenter|centerOf|pointOf|dispatchClick|connectCdp|openCdpSession|waitForRendererReady)\s*\(/,
  /(?:const|let|var)\s+(clickCenter|pointOf|dispatchClick|connectCdp|openCdpSession|waitForRendererReady)\s*=\s*(?:async\s*)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/,
  /(?:const|let|var)\s+centerOf\s*=\s*(?:async\s*(?:function\b|\()|(?:function\s*\(\s*cdp\b|\(\s*cdp\b))/,
  /(?:async\s+)?function\s+(waitFor|waitForExpression)\s*\(\s*cdp\b/,
  /(?:const|let|var)\s+(waitFor|waitForExpression)\s*=\s*(?:async\s*)?(?:function\s*)?\(\s*cdp\b/,
];

const SLEEP_CALL_RE = /\bsleep\s*\(\s*([\d_]+)\s*\)/g;
const SET_TIMEOUT_CALL_RE = /\bsetTimeout\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*([\d_]+)\s*\)/g;
const E2E_SLEEP_REASON_RE = /\/\*\s*e2e-sleep:\s*([\s\S]*?)\*\//;
const PAGE_WAITFOR_RE = /\basync\s+function\s+waitFor\s*\(\s*(?:check|predicate)\b/;

function hasValidSleepReason(line) {
  const match = E2E_SLEEP_REASON_RE.exec(line);
  if (!match) return false;
  const reason = match[1].replace(/\s+/g, " ").trim();
  return Array.from(reason).length >= 4;
}

function countUnjustifiedFixedWaitsOnLine(line) {
  if (hasValidSleepReason(line)) return 0;
  let count = 0;
  for (const regex of [SLEEP_CALL_RE, SET_TIMEOUT_CALL_RE]) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(line)) !== null) {
      const value = Number(match[1].replace(/_/g, ""));
      if (Number.isFinite(value) && value >= 300) count += 1;
    }
  }
  return count;
}

function analyzeHygiene({ files, baseline }) {
  const rawMouseViolations = [];
  const helperDefViolations = [];
  const fixedWaitViolations = [];
  const pageWaitViolations = [];

  const baselineWaits = baseline?.fixedWaits || {};
  const baselineOwners = new Set(baseline?.pageWaitForOwners || []);
  const observedOwners = new Map();

  const fileNames = [...files.keys()].sort();
  for (const file of fileNames) {
    if (EXCLUDED_FILES.has(file)) continue;
    const text = files.get(file);
    const lines = text.split("\n");
    const fixedWaitLines = [];
    let firstPageWaitHit = null;

    for (let i = 0; i < lines.length; i += 1) {
      const lineNumber = i + 1;
      const line = lines[i];

      if (line.includes("Input.dispatchMouseEvent")) {
        rawMouseViolations.push(`${file}:${lineNumber}: ${line}`);
      }

      if (FORBIDDEN_HELPER_PATTERNS.some((pattern) => pattern.test(line))) {
        helperDefViolations.push(`${file}:${lineNumber}: ${line}`);
      }

      const waitHits = countUnjustifiedFixedWaitsOnLine(line);
      for (let k = 0; k < waitHits; k += 1) {
        fixedWaitLines.push(`${file}:${lineNumber}: ${line}`);
      }

      if (!firstPageWaitHit && PAGE_WAITFOR_RE.test(line)) {
        firstPageWaitHit = `${file}:${lineNumber}: ${line}`;
      }
    }

    const expectedWaits = Object.prototype.hasOwnProperty.call(baselineWaits, file) ? baselineWaits[file] : 0;
    const actualWaits = fixedWaitLines.length;
    if (actualWaits > expectedWaits) {
      fixedWaitViolations.push(
        `${file}: 新增 ≥300ms 的固定等待要写 /* e2e-sleep: 理由 */ (基线 ${expectedWaits}，实测 ${actualWaits})\n  `
          + fixedWaitLines.join("\n  "),
      );
    } else if (actualWaits < expectedWaits) {
      fixedWaitViolations.push(
        `${file}: 基线该降到 ${actualWaits} (当前基线 ${expectedWaits})`,
      );
    }

    if (firstPageWaitHit) {
      observedOwners.set(file, firstPageWaitHit);
      if (!baselineOwners.has(file)) {
        pageWaitViolations.push(`未在基线 pageWaitForOwners 中的页面端 waitFor: ${firstPageWaitHit}`);
      }
    }
  }

  for (const file of Object.keys(baselineWaits).sort()) {
    if (!files.has(file) && baselineWaits[file] > 0) {
      fixedWaitViolations.push(`${file}: 文件已不存在，基线该降到 0 (当前基线 ${baselineWaits[file]})`);
    }
  }

  for (const owner of [...baselineOwners].sort()) {
    if (!observedOwners.has(owner)) {
      pageWaitViolations.push(`${owner}: 已不再自带页面端 waitFor，请从 pageWaitForOwners 基线移除`);
    }
  }

  return {
    rawMouseViolations,
    helperDefViolations,
    fixedWaitViolations,
    pageWaitViolations,
  };
}

function loadRealFlows() {
  const files = new Map();
  for (const name of readdirSync(flowsDir).filter((file) => file.endsWith(".mjs")).sort()) {
    files.set(name, readFileSync(join(flowsDir, name), "utf8"));
  }
  return files;
}

function loadBaseline() {
  return JSON.parse(readFileSync(baselinePath, "utf8"));
}

test("real e2e flows contain no raw Input.dispatchMouseEvent", () => {
  const result = analyzeHygiene({ files: loadRealFlows(), baseline: loadBaseline() });
  assert.deepEqual(
    result.rawMouseViolations,
    [],
    `direct Input.dispatchMouseEvent is forbidden outside _cdp.mjs:\n${result.rawMouseViolations.join("\n")}`,
  );
});

test("real e2e flows define no duplicate CDP click/session/wait helpers", () => {
  const result = analyzeHygiene({ files: loadRealFlows(), baseline: loadBaseline() });
  assert.deepEqual(
    result.helperDefViolations,
    [],
    `duplicate CDP helper definitions found (import from ./_cdp.mjs instead):\n${result.helperDefViolations.join("\n")}`,
  );
});

test("real e2e flows match fixed-wait (>=300ms) baseline exactly (ratchet only down)", () => {
  const result = analyzeHygiene({ files: loadRealFlows(), baseline: loadBaseline() });
  assert.deepEqual(
    result.fixedWaitViolations,
    [],
    `fixed-wait (>=300ms) baseline mismatch:\n${result.fixedWaitViolations.join("\n")}`,
  );
});

test("real e2e flows match pageWaitForOwners baseline exactly (ratchet only down)", () => {
  const result = analyzeHygiene({ files: loadRealFlows(), baseline: loadBaseline() });
  assert.deepEqual(
    result.pageWaitViolations,
    [],
    `pageWaitForOwners baseline mismatch:\n${result.pageWaitViolations.join("\n")}`,
  );
});

// ---- Self-tests with string fixtures (rules 1-4 negative & positive cases) ----

test("fixture: rule 1 catches raw Input.dispatchMouseEvent with file:line and allows dispatchMouse", () => {
  const bad = analyzeHygiene({
    files: new Map([
      ["sample.mjs", 'const x = 1;\nawait cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 2 });\n'],
    ]),
    baseline: { fixedWaits: {}, pageWaitForOwners: [] },
  });
  assert.equal(bad.rawMouseViolations.length, 1);
  assert.match(bad.rawMouseViolations[0], /^sample\.mjs:2:/);

  const good = analyzeHygiene({
    files: new Map([
      ["sample.mjs", 'import { dispatchMouse } from "./_cdp.mjs";\nawait dispatchMouse(cdp, { type: "mouseMoved", x: 1, y: 2 }, { reason: "drag" });\n'],
    ]),
    baseline: { fixedWaits: {}, pageWaitForOwners: [] },
  });
  assert.deepEqual(good.rawMouseViolations, []);
});

test("fixture: rule 2 catches every forbidden CDP helper definition and allows imports/calls", () => {
  const badSource = [
    "async function clickCenter(cdp, expr) {}",
    "async function centerOf(cdp, expr) {}",
    "const pointOf = async (expr) => {};",
    "function dispatchClick(cdp, x, y) {}",
    "async function connectCdp(port, prefix) {}",
    "function openCdpSession(url) {}",
    "async function waitForRendererReady(cdp) {}",
    "async function waitFor(cdp, expr, label) {}",
    "async function waitForExpression(cdp, expr, label) {}",
  ].join("\n");
  const bad = analyzeHygiene({
    files: new Map([["bad-helpers.mjs", badSource]]),
    baseline: { fixedWaits: {}, pageWaitForOwners: [] },
  });
  assert.equal(bad.helperDefViolations.length, 9);
  assert.match(bad.helperDefViolations[0], /^bad-helpers\.mjs:1:/);
  assert.match(bad.helperDefViolations[8], /^bad-helpers\.mjs:9:/);

  const goodSource = [
    'import { clickCenter, connectCdp, openCdpSession, pointOf, waitFor, waitForRendererReady } from "./_cdp.mjs";',
    "await clickCenter(cdp, 'document.body');",
    "const centerOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y }; };",
    "async function waitFor(ctx, server, id) { return id; }",
  ].join("\n");
  const good = analyzeHygiene({
    files: new Map([["good-helpers.mjs", goodSource]]),
    baseline: { fixedWaits: {}, pageWaitForOwners: [] },
  });
  assert.deepEqual(good.helperDefViolations, []);
});

test("fixture: rule 3 catches new >=300ms waits, enforces block-comment reasons >=4 chars, and requires lowering stale baselines", () => {
  const added = analyzeHygiene({
    files: new Map([
      ["waits.mjs", "await sleep(250);\nawait sleep(500);\nawait new Promise((r) => setTimeout(r, 1_000));\n"],
    ]),
    baseline: { fixedWaits: {}, pageWaitForOwners: [] },
  });
  assert.equal(added.fixedWaitViolations.length, 1);
  assert.match(added.fixedWaitViolations[0], /新增 ≥300ms 的固定等待要写 \/\* e2e-sleep: 理由 \*\//);
  assert.match(added.fixedWaitViolations[0], /waits\.mjs:2:/);
  assert.match(added.fixedWaitViolations[0], /waits\.mjs:3:/);

  // Line comment `//` or too-short reason (<4 chars) must NOT exempt.
  const badComments = analyzeHygiene({
    files: new Map([
      ["waits.mjs", "await sleep(500); // e2e-sleep: 行注释不算\nawait sleep(400); /* e2e-sleep: 短 */\n"],
    ]),
    baseline: { fixedWaits: {}, pageWaitForOwners: [] },
  });
  assert.equal(badComments.fixedWaitViolations.length, 1);
  assert.match(badComments.fixedWaitViolations[0], /waits\.mjs:1:/);
  assert.match(badComments.fixedWaitViolations[0], /waits\.mjs:2:/);

  // Valid block-comment reason (>=4 chars) and <300ms waits are allowed.
  const valid = analyzeHygiene({
    files: new Map([
      ["waits.mjs", "await sleep(299);\nawait sleep(500); /* e2e-sleep: 确认防抖窗口内无重复触发 */\n"],
    ]),
    baseline: { fixedWaits: {}, pageWaitForOwners: [] },
  });
  assert.deepEqual(valid.fixedWaitViolations, []);

  // Fewer waits than baseline requires ratcheting baseline down.
  const lowered = analyzeHygiene({
    files: new Map([["waits.mjs", "await sleep(100);\n"]]),
    baseline: { fixedWaits: { "waits.mjs": 2 }, pageWaitForOwners: [] },
  });
  assert.equal(lowered.fixedWaitViolations.length, 1);
  assert.match(lowered.fixedWaitViolations[0], /基线该降到 0/);
});

test("fixture: rule 4 catches unlisted page waitFor definitions and stale pageWaitForOwners entries", () => {
  const added = analyzeHygiene({
    files: new Map([
      ["a.mjs", "async function waitFor(check, label) {}\n"],
      ["b.mjs", "async function waitFor(predicate, label) {}\n"],
    ]),
    baseline: { fixedWaits: {}, pageWaitForOwners: ["c.mjs"] },
  });
  assert.equal(added.pageWaitViolations.length, 3);
  assert.match(added.pageWaitViolations[0], /a\.mjs:1:/);
  assert.match(added.pageWaitViolations[1], /b\.mjs:1:/);
  assert.match(added.pageWaitViolations[2], /c\.mjs/);

  const matched = analyzeHygiene({
    files: new Map([
      ["a.mjs", "async function waitFor(check, label) {}\n"],
      ["clean.mjs", "${PAGE_WAIT_SOURCE}\n"],
    ]),
    baseline: { fixedWaits: {}, pageWaitForOwners: ["a.mjs"] },
  });
  assert.deepEqual(matched.pageWaitViolations, []);
});
