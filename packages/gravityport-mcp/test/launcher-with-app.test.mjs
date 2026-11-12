// Task 381: black-box test with a FAKE GravityPort.app in a temp dir:
// Contents/MacOS/GravityPort is a symlink to process.execPath and
// Contents/Resources/app.asar is a real folder holding mcp/server.mjs — an
// echo script (every line echoed back verbatim; the literal line "exit 7"
// exits with code 7). A folder stands in for the packed app.asar only in the
// test; the real lookup logic only checks that the file exists.
//
// The launcher must spawn it with ELECTRON_RUN_AS_NODE=1 in the child env
// (read from outside the process tree with ps -E), pass stdio through
// untouched, and turn the child's exit code into its own.
import assert from "node:assert/strict";
import { once } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const binPath = join(packageRoot, "bin", "gravityport-mcp.mjs");

// Echo fixture per the task order: echo every line back verbatim; "exit 7"
// exits with code 7.
const ECHO_SERVER = [
  'import { createInterface } from "node:readline";',
  "const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });",
  'rl.on("line", (line) => {',
  '  if (line === "exit 7") {',
  "    process.exit(7);",
  "    return;",
  "  }",
  '  process.stdout.write(`${line}\\n`);',
  "});",
].join("\n");

// The fixture is a macOS .app bundle and the env check uses macOS `ps -E`;
// on other systems the launcher (correctly) finds no app, so skip there.
test("launcher with the app spawns it as node and forwards stdio and exit codes", {
  skip: process.platform !== "darwin" && "macOS-only fixture (.app bundle, ps -E)",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-launcher-app-"));
  const appDir = join(root, "GravityPort.app");
  const asarDir = join(appDir, "Contents", "Resources", "app.asar");
  await mkdir(join(appDir, "Contents", "MacOS"), { recursive: true });
  await mkdir(join(asarDir, "mcp"), { recursive: true });
  await symlink(process.execPath, join(appDir, "Contents", "MacOS", "GravityPort"));
  await writeFile(join(asarDir, "mcp", "server.mjs"), ECHO_SERVER, "utf8");

  const launcher = spawn(process.execPath, [binPath], {
    env: { ...process.env, GRAVITYPORT_APP_PATH: appDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => {
    if (launcher.exitCode === null && launcher.signalCode === null) {
      const exited = once(launcher, "exit");
      launcher.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });

  // A line goes in, the same line comes back: the launcher neither rewrites
  // nor consumes the child's stdio.
  const echoed = await exchange(launcher, "mcp-echo-probe\n");
  assert.equal(echoed, "mcp-echo-probe\n");

  // The child process received ELECTRON_RUN_AS_NODE=1, observed from outside
  // with ps -E (macOS shows the environment of the caller's own processes).
  const childPids = execFileSync("pgrep", ["-P", String(launcher.pid)], { encoding: "utf8" }).trim();
  assert.ok(childPids, "the launcher has a child process");
  const childPid = childPids.split("\n")[0];
  const childEnvironment = execFileSync("ps", ["-E", "-p", childPid, "-o", "command="], { encoding: "utf8" });
  assert.match(childEnvironment, /ELECTRON_RUN_AS_NODE=1/);

  // The child's exit code becomes the launcher's exit code.
  launcher.stdin.write("exit 7\n");
  const [code, signal] = await once(launcher, "exit");
  assert.equal(signal, null);
  assert.equal(code, 7);
});

function exchange(launcher, line) {
  return new Promise((resolveExchange, rejectExchange) => {
    const onData = (chunk) => {
      const index = chunk.indexOf("\n");
      if (index === -1) return;
      finish(null, chunk.slice(0, index + 1));
    };
    const onExit = () => finish(new Error("launcher exited before echoing."));
    const finish = (error, value) => {
      clearTimeout(timer);
      launcher.stdout.off("data", onData);
      launcher.off("exit", onExit);
      if (error) rejectExchange(error);
      else resolveExchange(value);
    };
    const timer = setTimeout(() => finish(new Error("Timed out waiting for the echo.")), 5000);
    launcher.stdout.setEncoding("utf8");
    launcher.stdout.on("data", onData);
    launcher.once("exit", onExit);
    launcher.stdin.write(line);
  });
}
