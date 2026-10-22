/**
 * Ready-to-paste MCP client configurations for the bundled MCP server.
 *
 * The desktop app runs mcp/server.mjs with its own executable in Node mode
 * (ELECTRON_RUN_AS_NODE), so no separate Node install or source checkout is
 * needed. Unless the desktop itself was started with GRAVITYPORT_LIBRARY_DIR, the
 * config names the desktop's library-location.json instead of a fixed library
 * path: moving the library in Settings never invalidates a copied config.
 */

export const MCP_CLIENT_SERVER_NAME = "gravityport";

function requiredPath(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`buildMcpClientConfig requires ${name}.`);
  }
  return value;
}

/** POSIX shell single-quoting: the only character to escape is ' itself. */
export function posixShellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/** Double-quoting understood by both PowerShell and cmd for path-like values. */
function windowsShellQuote(value) {
  const text = String(value);
  if (/["\r\n]/.test(text)) throw new Error("Windows paths cannot contain quotes or line breaks.");
  return `"${text}"`;
}

/** A TOML basic string; JSON string escaping is a valid subset of it. */
function tomlString(value) {
  return JSON.stringify(String(value));
}

export function buildMcpClientConfig({
  platform,
  execPath,
  serverPath,
  libraryLocationFile = "",
  managedLibraryDir = "",
} = {}) {
  const command = requiredPath(execPath, "execPath");
  const args = [requiredPath(serverPath, "serverPath")];
  const env = { ELECTRON_RUN_AS_NODE: "1" };
  if (managedLibraryDir) env.GRAVITYPORT_LIBRARY_DIR = managedLibraryDir;
  else env.GRAVITYPORT_LIBRARY_LOCATION_FILE = requiredPath(libraryLocationFile, "libraryLocationFile");

  const claudeDesktop = JSON.stringify({
    mcpServers: { [MCP_CLIENT_SERVER_NAME]: { command, args, env } },
  }, null, 2);

  let claudeCode;
  if (platform === "win32") {
    const envFlags = Object.entries(env).map(([key, value]) => `--env ${windowsShellQuote(`${key}=${value}`)}`);
    // The name goes before the variadic --env flags so they cannot swallow it.
    claudeCode = [
      "claude mcp add --scope user",
      MCP_CLIENT_SERVER_NAME,
      ...envFlags,
      "--",
      windowsShellQuote(command),
      ...args.map(windowsShellQuote),
    ].join(" ");
  } else {
    const serverJson = JSON.stringify({ type: "stdio", command, args, env });
    claudeCode = `claude mcp add-json --scope user ${MCP_CLIENT_SERVER_NAME} ${posixShellQuote(serverJson)}`;
  }

  const tomlEnv = Object.entries(env).map(([key, value]) => `${key} = ${tomlString(value)}`).join(", ");
  const codex = [
    `[mcp_servers.${MCP_CLIENT_SERVER_NAME}]`,
    `command = ${tomlString(command)}`,
    `args = [${args.map(tomlString).join(", ")}]`,
    `env = { ${tomlEnv} }`,
  ].join("\n");

  return { serverName: MCP_CLIENT_SERVER_NAME, command, args, env, claudeDesktop, claudeCode, codex };
}
