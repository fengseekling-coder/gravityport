// Task 229: e2e/QA desktop runs on macOS must not appear in the Dock or steal
// the user's keyboard focus. This module is imported FIRST by desktop/main.mjs
// so the policy is applied before any heavy import: a process that checks in
// with Launch Services while still regular flashes a Dock icon until
// desktop/main.mjs gets a chance to run.
//
// Same gate as desktop/main.mjs's quietTestApp: a QA run of the unpackaged
// app on macOS only. The packaged input smoke (real CGEvent input) and a
// user's own copy of the app both need the normal activating behavior.
import { app } from "electron";

if (process.platform === "darwin" && process.env.MOSA_QA_RUN && !app.isPackaged) {
  app.dock?.hide();
}
