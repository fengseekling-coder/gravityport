// Task 229 / Task 325 / Task 346: e2e/QA desktop runs on macOS must not appear
// in the Dock, steal focus, or show any window on the user screen.
// This module is imported FIRST by desktop/main.mjs so the policy is applied
// before any heavy import: a process that checks in with Launch Services while
// still regular flashes a Dock icon until desktop/main.mjs gets a chance to run.
//
// Same gate as desktop/main.mjs's quietTestApp, decided here through the one
// shared evaluateQuietQaRunForElectronApp call. Dev (unpackaged) runs: MOSA_QA_RUN
// only. Packaged runs: the gated packaged quiet switch (task 346, spelled out
// in desktop/quiet-qa-screen.mjs and at its launch sites), which a production
// launch never carries. The packaged input smoke (real CGEvent input) and a
// user's own copy of the app both need the normal activating behavior and pass
// no switch, so they stay visible.
import { join } from "node:path";
import { app } from "electron";
import { evaluateQuietQaRunForElectronApp } from "./quiet-qa-screen.mjs";

const quietGate = evaluateQuietQaRunForElectronApp(app);

if (quietGate.rejectReason) {
  // A quiet run whose gate failed must never fall back to a visible window:
  // hide whatever already checked in with Launch Services, report, and exit
  // non-zero before main.mjs body runs (no window, no service, no writes).
  app.dock?.hide();
  process.stderr.write(`QA_STARTUP_FAILED: packaged-quiet-gate ${quietGate.rejectReason}\n`);
  app.exit(1);
  // app.exit does not halt synchronous execution in all Electron versions.
  process.exit(1);
}

if (quietGate.quiet && app.isPackaged) {
  process.stderr.write("QA_QUIET: packaged on\n");
}

if (process.platform === "darwin" && quietGate.quiet) {
  app.dock?.hide();
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
}
