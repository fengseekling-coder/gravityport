// Regenerates packages/gravityport-mcp/tools.json from the real mcp/server.mjs
// (npm run mcp-launcher:tools). The launcher package ships that snapshot so its
// no-app fallback can answer tools/list without a library; the snapshot test
// (test/mcp-launcher-tools-snapshot.test.mjs) fails when this is stale.
//
// The server starts the same way test/generation-api-mcp.test.mjs starts it,
// except no library is pointed at: a throwaway HOME plus the same env hygiene
// as test/clean-test-env.mjs, so neither the host's library location file nor
// any MOSA/GRAVITYPORT variable can select a real library. A missing library
// does not stop the server (task 362): it still answers initialize and
// tools/list, and nothing is created anywhere.
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputPath = join(repoRoot, "packages", "gravityport-mcp", "tools.json");

const POLLUTING_VARIABLES = [
  "MOSA_LIBRARY_DIR",
  "MOSA_LIBRARY_LOCATION_FILE",
  "MOSA_DISABLE_BRIDGES",
  "MOSA_PORT",
  "MOSA_DESKTOP_PORT",
  "MOSA_COWART_REGISTRY",
  "MOSA_COWART_ENDPOINT",
  "MOSA_COWART_REGISTRY_PATH",
  "MOSA_PROJECT_DIR",
  "MOSA_WEB_CAPTURE_TOKEN",
  "MOSA_WEB_CAPTURE_ORIGINS",
  "MOSA_RUNTIME_MODE",
  "MOSA_USER_DATA",
  "MOSA_QA_RUN",
  "MOSA_CLIENT_TOKEN",
  "MOSA_BACKGROUND_RUNTIME",
  "GRAVITYPORT_LIBRARY_DIR",
  "GRAVITYPORT_LIBRARY_LOCATION_FILE",
  "GRAVITYPORT_DISABLE_BRIDGES",
  "GRAVITYPORT_DISABLE_TELEMETRY",
  "GRAVITYPORT_WEB_CAPTURE_TOKEN",
  "GRAVITYPORT_WEB_CAPTURE_ORIGINS",
  "GRAVITYPORT_APP_PATH",
];

const home = await mkdtemp(join(tmpdir(), "mosa-mcp-launcher-tools-"));
const env = { ...process.env };
for (const name of POLLUTING_VARIABLES) delete env[name];
env.HOME = home;

const server = spawn(process.execPath, ["mcp/server.mjs"], {
  cwd: repoRoot,
  env,
  stdio: ["pipe", "pipe", "pipe"],
});

try {
  const initialized = await request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "gravityport-mcp-tools-snapshot", version: "0.0.0" } },
  });
  if (initialized.error) throw new Error(`initialize failed: ${initialized.error.message}`);
  const listed = await request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  if (listed.error) throw new Error(`tools/list failed: ${listed.error.message}`);
  const tools = listed.result.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error(`tools/list returned ${tools?.length ?? "no"} tools; refusing to write an empty snapshot.`);
  }
  await writeFile(outputPath, `${JSON.stringify(tools, null, 2)}\n`, "utf8");
  console.log(`Wrote ${tools.length} tools to ${outputPath}`);
} finally {
  if (server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await exited;
  }
  await rm(home, { recursive: true, force: true });
}

function request(payload) {
  return new Promise((resolveRequest, rejectRequest) => {
    const timeout = setTimeout(() => finish(new Error("Timed out waiting for the MCP response.")), 15000);
    const onData = (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const response = JSON.parse(line);
        if (response.id === payload.id) finish(null, response);
      }
    };
    const onExit = () => finish(new Error("mcp/server.mjs exited before responding."));
    const finish = (error, response) => {
      clearTimeout(timeout);
      server.stdout.off("data", onData);
      server.off("exit", onExit);
      if (error) rejectRequest(error);
      else resolveRequest(response);
    };
    let buffer = "";
    server.stdout.setEncoding("utf8");
    server.stdout.on("data", onData);
    server.once("exit", onExit);
    server.stdin.write(`${JSON.stringify(payload)}\n`);
  });
}
