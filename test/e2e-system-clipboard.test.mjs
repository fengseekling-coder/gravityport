// Task 461: the gate for system-clipboard e2e coverage. Scans the real e2e
// sources for every way a test can reach the real system clipboard and fails
// unless each hitting file is a flow that declares `systemClipboard`
// ("flow" or "steps") — so a future clipboard-touching test cannot slip past
// the runner's skip/refuse logic. Also pins the CI grant (desktop.yml e2e
// jobs only, never ci.yml) and the runner's decision function. Everything
// here loads the real modules and reads the real workflow text; nothing is
// copied into the test.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { SYSTEM_CLIPBOARD_ENV, systemClipboardAllowed, systemClipboardPlan } from "../scripts/e2e-system-clipboard.mjs";
import * as desktopPasteImport from "../scripts/e2e-flows/desktop-paste-import.mjs";
import * as keyboardShortcuts from "../scripts/e2e-flows/keyboard-shortcuts.mjs";
import * as desktopInput from "../scripts/e2e-flows/desktop-input.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const flowsDir = join(rootDir, "scripts", "e2e-flows");

// Every way a test source can reach the real system clipboard: native
// writers/readers (macOS NSPasteboard, Windows Set-/Get-Clipboard, .NET
// Forms.Clipboard, pbcopy/pbpaste), trusted paste/copy/cut key commands,
// execCommand on text, renderer clipboard APIs, and the desktop bridge calls
// that proxy them. Extend here when a new route shows up — any hit outside a
// declared flow fails the gate.
const FEATURE_PATTERNS = [
  /NSPasteboard/,
  /Set-Clipboard/,
  /Get-Clipboard/,
  /Forms\.Clipboard/,
  /pbcopy/,
  /pbpaste/,
  /commands:\s*\["(?:paste|copy|cut)"\]/,
  /execCommand\(\s*["'](copy|cut|paste)/,
  /navigator\.clipboard\.(write|read)/,
  /electronAPI\.(writeClipboard\w*|pasteFromClipboard|pasteImage)\(/,
];

// The pinned set: exactly these flows may touch the real system clipboard.
// Adding one means landing it here too — the point is to make the author see
// this rule, not to let it pass quietly.
const PINNED_DECLARATIONS = { "desktop-paste-import": "flow", "keyboard-shortcuts": "steps", "desktop-input": "steps" };

// Scan every e2e source a flow can run from: all of scripts/e2e-flows/
// (helpers included) plus the runner and the two page-driver scripts.
function clipboardHits() {
  const files = readdirSync(flowsDir)
    .filter((file) => file.endsWith(".mjs"))
    .sort()
    .map((file) => join(flowsDir, file));
  for (const name of ["e2e-ui-flow.mjs", "e2e-web-driver.mjs", "e2e-critical-flows.mjs"]) {
    files.push(join(rootDir, "scripts", name));
  }
  const hits = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const matched = FEATURE_PATTERNS.map((pattern) => text.match(pattern)?.[0]).filter(Boolean);
    if (matched.length) hits.push({ file, text, matched });
  }
  return hits;
}

async function importFlow(file) {
  return import(pathToFileURL(file).href);
}

test("the three declared flow modules export their declarations", () => {
  assert.equal(desktopPasteImport.systemClipboard, "flow");
  assert.equal(keyboardShortcuts.systemClipboard, "steps");
  assert.equal(desktopInput.systemClipboard, "steps");
});

test("every source that touches the real system clipboard is a declared flow", async () => {
  const problems = [];
  for (const { file, text, matched } of clipboardHits()) {
    const displayPath = relative(rootDir, file);
    if (!file.startsWith(flowsDir + "/")) {
      problems.push(`${displayPath} touches the system clipboard (${matched.join(", ")}) but is not an e2e flow file`);
      continue;
    }
    const base = file.slice(flowsDir.length + 1);
    if (base.startsWith("_")) {
      problems.push(`${displayPath} is a shared helper and must never touch the system clipboard (${matched.join(", ")})`);
      continue;
    }
    const flow = await importFlow(file);
    if (flow.systemClipboard !== "flow" && flow.systemClipboard !== "steps") {
      problems.push(`${displayPath} touches the system clipboard (${matched.join(", ")}) but does not declare systemClipboard: "flow" | "steps"`);
      continue;
    }
    if (flow.systemClipboard === "steps" && !text.includes("ctx.systemClipboard")) {
      problems.push(`${displayPath} declares systemClipboard: "steps" but never checks ctx.systemClipboard`);
    }
  }
  assert.deepEqual(problems, [], `undeclared system-clipboard usage:\n- ${problems.join("\n- ")}`);
});

test("the flows that touch the real system clipboard are exactly the pinned set", async () => {
  const declared = {};
  for (const { file } of clipboardHits()) {
    const flow = await importFlow(file);
    declared[flow.name] = flow.systemClipboard;
  }
  assert.deepEqual(declared, PINNED_DECLARATIONS,
    `system-clipboard flows changed: got ${JSON.stringify(declared)}, expected ${JSON.stringify(PINNED_DECLARATIONS)} — a new one must be judged and pinned here (task 461)`);
});

// desktop.yml jobs are top-level keys at exactly two-space indent; the e2e
// step is the "Run e2e shard" step inside the job. Slice both so the grant
// cannot hide somewhere job-wide or in another workflow.
function desktopJobText(jobName) {
  const lines = readFileSync(join(rootDir, ".github", "workflows", "desktop.yml"), "utf8").split("\n");
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  assert.ok(start !== -1, `desktop.yml defines the ${jobName} job`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^  \S.*:$/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join("\n");
}

function jobStepText(jobText, nameNeedle) {
  const lines = jobText.split("\n");
  const start = lines.findIndex((line) => line.includes(`- name: ${nameNeedle}`));
  assert.ok(start !== -1, `job has a "${nameNeedle}" step`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s+- name:/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join("\n");
}

test("both desktop.yml e2e jobs grant the system clipboard on their e2e step", () => {
  for (const jobName of ["desktop-macos-e2e", "desktop-windows-e2e"]) {
    const stepText = jobStepText(desktopJobText(jobName), "Run e2e shard");
    assert.match(stepText, /^\s+env:\s*$/m, `${jobName} e2e step declares an env block`);
    assert.ok(stepText.includes(`${SYSTEM_CLIPBOARD_ENV}: "1"`),
      `${jobName} e2e step must set ${SYSTEM_CLIPBOARD_ENV}: "1" — it is the only place system-clipboard flows may run (task 461)`);
  }
});

test("ci.yml never grants the system clipboard", () => {
  const text = readFileSync(join(rootDir, ".github", "workflows", "ci.yml"), "utf8");
  assert.ok(!text.includes(SYSTEM_CLIPBOARD_ENV),
    `ci.yml must not set ${SYSTEM_CLIPBOARD_ENV}: it runs e2e on shared/unknowable machines`);
});

test("systemClipboardAllowed grants only the exact string 1", () => {
  assert.equal(systemClipboardAllowed({ [SYSTEM_CLIPBOARD_ENV]: "1" }), true);
  assert.equal(systemClipboardAllowed({}), false);
  for (const value of [undefined, "", "0", "true"]) {
    assert.equal(systemClipboardAllowed({ [SYSTEM_CLIPBOARD_ENV]: value }), false,
      `${JSON.stringify(value)} must not grant the system clipboard`);
  }
});

test("systemClipboardPlan: undeclared flows run everywhere", () => {
  assert.equal(systemClipboardPlan({ declared: undefined, allowed: false, explicitlyNamed: true }), "run");
  assert.equal(systemClipboardPlan({ declared: undefined, allowed: false, explicitlyNamed: false }), "run");
});

test("systemClipboardPlan: an explicit grant runs any declared flow", () => {
  assert.equal(systemClipboardPlan({ declared: "flow", allowed: true, explicitlyNamed: false }), "run");
  assert.equal(systemClipboardPlan({ declared: "flow", allowed: true, explicitlyNamed: true }), "run");
  assert.equal(systemClipboardPlan({ declared: "steps", allowed: true, explicitlyNamed: false }), "run");
});

test("systemClipboardPlan: steps-declared flows run and skip their own steps", () => {
  assert.equal(systemClipboardPlan({ declared: "steps", allowed: false, explicitlyNamed: true }), "run");
  assert.equal(systemClipboardPlan({ declared: "steps", allowed: false, explicitlyNamed: false }), "run");
});

test("systemClipboardPlan: an explicitly named flow-declaration refuses", () => {
  assert.equal(systemClipboardPlan({ declared: "flow", allowed: false, explicitlyNamed: true }), "refuse");
});

test("systemClipboardPlan: an unnamed flow-declaration skips loudly", () => {
  assert.equal(systemClipboardPlan({ declared: "flow", allowed: false, explicitlyNamed: false }), "skip");
});

test("systemClipboardPlan: a misspelled declaration throws with the flow name", () => {
  assert.throws(
    () => systemClipboardPlan({ flow: "keyboard-shortcuts", declared: "Flow", allowed: false, explicitlyNamed: true }),
    /keyboard-shortcuts/,
    "the error must name the offending flow",
  );
  assert.throws(
    () => systemClipboardPlan({ flow: "typo-flow", declared: "flows", allowed: true, explicitlyNamed: false }),
    /typo-flow/,
    "a misspelled value throws even when the clipboard would be granted",
  );
});
