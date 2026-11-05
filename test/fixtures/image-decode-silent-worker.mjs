// Task 341 test worker: accepts requests and never answers, to exercise the
// client's per-request timeout and the child restart that follows it.
function noop() {}

const electronPort = process.parentPort;
if (electronPort) {
  electronPort.on("message", () => noop());
} else {
  process.on("message", () => noop());
  process.on("disconnect", () => { process.exit(0); });
}
