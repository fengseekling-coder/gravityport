// Task 461: e2e flows that touch the REAL system clipboard must declare it,
// and the runner keeps them off machines people are using. A "flow"
// declaration takes the clipboard for the whole run (desktop-paste-import);
// "steps" marks flows whose individual steps gate on ctx.systemClipboard.
// Nothing here imports Electron — the runner and the gate test
// (test/e2e-system-clipboard.test.mjs) both load this module directly.
export const SYSTEM_CLIPBOARD_ENV = "MOSA_E2E_SYSTEM_CLIPBOARD";

// Only the exact string "1" grants the clipboard: "true", "yes" and empty
// values do not, so a habit of writing truthy env flags elsewhere cannot
// silently hand out this machine's clipboard.
export function systemClipboardAllowed(env) {
  return env?.[SYSTEM_CLIPBOARD_ENV] === "1";
}

// The decision for one flow: "run" it here, "skip" it loudly (the verdict
// records the skip), or "refuse" — an explicitly named system-clipboard flow
// fails the run instead of taking the clipboard over. A misspelled
// declaration must never be read as "undeclared": it throws.
export function systemClipboardPlan({ flow = "unknown flow", declared, allowed, explicitlyNamed }) {
  if (declared === undefined) return "run";
  if (declared !== "flow" && declared !== "steps") {
    throw new Error(`E2E flow ${flow} declares systemClipboard: ${JSON.stringify(declared)} — expected "flow" or "steps"`);
  }
  if (allowed) return "run";
  if (declared === "steps") return "run";
  return explicitlyNamed ? "refuse" : "skip";
}
