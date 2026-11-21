// Fake ipcMain shared by the IPC handler behavior tests (task 447 moved it
// here from test/desktop-ipc-modules.test.mjs so the update-install-flow and
// ipc-handlers files register against the same recorder).
import assert from "node:assert/strict";

export function makeFakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    channels: () => [...handlers.keys()],
    handle(channel, fn) {
      assert.equal(handlers.has(channel), false, `duplicate IPC channel: ${channel}`);
      assert.equal(typeof fn, "function", `handler for ${channel} must be a function`);
      handlers.set(channel, fn);
    },
  };
}
