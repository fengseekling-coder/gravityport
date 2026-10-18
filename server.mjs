import { startMosaRuntime } from "./lib/mosa-runtime.mjs";
import { parseDisabledBridges } from "./lib/runtime-bridges.mjs";

const disabledBridges = parseDisabledBridges({ env: process.env });
// Web QA has no Electron app.getPath("userData"); the isolated userData root
// (MOSA_USER_DATA) is itself the verifiable run parameter, so it is reported
// as both expected and actual. The guard still requires it explicitly — there
// is no optional-actualUserData fallback for the web kind either.
const isolationContext = {
  runtimeMode: process.env.MOSA_RUNTIME_MODE,
  qaRun: process.env.MOSA_QA_RUN,
  expectedUserData: process.env.MOSA_USER_DATA,
  actualUserData: process.env.MOSA_USER_DATA,
  productionDefaultUserData: undefined,
  argv: process.argv,
  runtimeKind: "web",
};
let runtime;
try {
  runtime = await startMosaRuntime({
    ...(disabledBridges.length > 0 ? { disabledBridges } : {}),
    isolationContext,
    // Source/headless runtimes keep pairing disabled by default. Automation
    // that owns the process can explicitly opt into the same silent flow.
    ...(process.env.MOSA_WEB_CAPTURE_PAIR === "auto"
      ? { webCapturePairingEnabled: true }
      : {}),
  });
} catch (err) {
  if (err.code === "ERR_ISOLATION_GUARD") {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
if (process.stdout.isTTY) {
  console.log(`GravityPort: ${runtime.url}/#mosa-client-token=${encodeURIComponent(runtime.clientToken)}`);
} else {
  // Redirected output (service logs, .mosa-server.log) must not persist the
  // management capability. The URL is still delivered interactively.
  console.log(`GravityPort: ${runtime.url} (client token handoff suppressed in redirected output)`);
}

let shutdownPromise = null;

function shutdown(exitCode) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = runtime.stop().then(
    () => process.exit(exitCode),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
  return shutdownPromise;
}

process.once("SIGINT", () => { void shutdown(0); });
process.once("SIGTERM", () => { void shutdown(0); });
