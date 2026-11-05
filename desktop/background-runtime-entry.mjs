import "../lib/apply-env-aliases.mjs";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { parseDisabledBridges } from "../lib/runtime-bridges.mjs";
import { MOSA_WEB_CAPTURE_DEFAULT_ORIGINS } from "./web-capture-pairing.mjs";

process.on("uncaughtExceptionMonitor", (error) => {
  console.error(`[MOSA] uncaught exception ${error?.name || "Error"}: ${error?.message}\n${error?.stack || "(no stack)"}`);
});

const disabledBridges = parseDisabledBridges({ env: process.env });
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
    webCapturePairingEnabled: true,
    webCaptureOrigins: MOSA_WEB_CAPTURE_DEFAULT_ORIGINS,
  });
} catch (error) {
  if (error?.code === "ERR_ISOLATION_GUARD") {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

console.log(`GravityPort background runtime: ${runtime.url}`);
let shutdownPromise = null;
function shutdown(code) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = runtime.stop().then(
    () => process.exit(code),
    (error) => { console.error(error); process.exit(1); },
  );
  return shutdownPromise;
}
process.once("SIGINT", () => { void shutdown(0); });
process.once("SIGTERM", () => { void shutdown(0); });
