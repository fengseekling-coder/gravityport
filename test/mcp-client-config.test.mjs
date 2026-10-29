import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse as parseTomlRaw } from "smol-toml";
import { buildMcpClientConfig, posixShellQuote } from "../lib/mcp-client-config.mjs";

// smol-toml 1.9 returns null-prototype objects; compare as plain data.
const parseToml = (source) => JSON.parse(JSON.stringify(parseTomlRaw(source)));

const MAC_EXEC = "/Applications/GravityPort.app/Contents/MacOS/GravityPort";
const MAC_SERVER = "/Applications/GravityPort.app/Contents/Resources/app.asar/mcp/server.mjs";

function expectedServer(config) {
  return { command: config.command, args: config.args, env: config.env };
}

/** Run the Claude Code command through a real POSIX shell with `claude` stubbed out. */
function shellArguments(command) {
  const stubbed = command.replace(/^claude /, "printf '%s\\0' ");
  const result = spawnSync("/bin/sh", ["-c", stubbed], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split("\0").slice(0, -1);
}

for (const home of ["/Users/a b", "/Users/o'neil", "/Users/$HOME `x` \"q\""]) {
  test(`macOS config survives a library-location path under ${JSON.stringify(home)}`, { skip: process.platform === "win32" }, () => {
    const libraryLocationFile = `${home}/Library/Application Support/mosa/library-location.json`;
    const config = buildMcpClientConfig({
      platform: "darwin",
      execPath: MAC_EXEC,
      serverPath: MAC_SERVER,
      libraryLocationFile,
    });

    assert.equal(config.serverName, "gravityport");
    assert.equal(config.command, MAC_EXEC);
    assert.deepEqual(config.args, [MAC_SERVER]);
    assert.deepEqual(config.env, { ELECTRON_RUN_AS_NODE: "1", GRAVITYPORT_LIBRARY_LOCATION_FILE: libraryLocationFile });

    assert.deepEqual(JSON.parse(config.claudeDesktop), { mcpServers: { gravityport: expectedServer(config) } });

    const argv = shellArguments(config.claudeCode);
    assert.deepEqual(argv.slice(0, 5), ["mcp", "add-json", "--scope", "user", "gravityport"]);
    assert.equal(argv.length, 6);
    assert.deepEqual(JSON.parse(argv[5]), { type: "stdio", ...expectedServer(config) });

    assert.deepEqual(parseToml(config.codex), { mcp_servers: { gravityport: expectedServer(config) } });
  });
}

test("a desktop started with GRAVITYPORT_LIBRARY_DIR hands out that fixed library instead of the location file", () => {
  const config = buildMcpClientConfig({
    platform: "darwin",
    execPath: MAC_EXEC,
    serverPath: MAC_SERVER,
    libraryLocationFile: "/Users/a/Library/Application Support/mosa/library-location.json",
    managedLibraryDir: "/Volumes/Art/GravityPort Library",
  });
  assert.deepEqual(config.env, { ELECTRON_RUN_AS_NODE: "1", GRAVITYPORT_LIBRARY_DIR: "/Volumes/Art/GravityPort Library" });
  assert.equal(parseToml(config.codex).mcp_servers.gravityport.env.GRAVITYPORT_LIBRARY_LOCATION_FILE, undefined);
  assert.doesNotMatch(config.claudeDesktop, /GRAVITYPORT_LIBRARY_LOCATION_FILE/);
});

test("Windows config escapes backslashes and quotes paths for PowerShell and cmd", () => {
  const execPath = "C:\\Users\\a b\\AppData\\Local\\GravityPort\\GravityPort.exe";
  const serverPath = "C:\\Users\\a b\\AppData\\Local\\GravityPort\\resources\\app.asar\\mcp\\server.mjs";
  const libraryLocationFile = "C:\\Users\\a b\\AppData\\Roaming\\mosa\\library-location.json";
  const config = buildMcpClientConfig({ platform: "win32", execPath, serverPath, libraryLocationFile });

  assert.deepEqual(JSON.parse(config.claudeDesktop).mcpServers.gravityport, {
    command: execPath,
    args: [serverPath],
    env: { ELECTRON_RUN_AS_NODE: "1", GRAVITYPORT_LIBRARY_LOCATION_FILE: libraryLocationFile },
  });
  assert.deepEqual(parseToml(config.codex).mcp_servers.gravityport, expectedServer(config));
  assert.equal(
    config.claudeCode,
    `claude mcp add --scope user gravityport --env "ELECTRON_RUN_AS_NODE=1" --env "GRAVITYPORT_LIBRARY_LOCATION_FILE=${libraryLocationFile}" -- "${execPath}" "${serverPath}"`,
  );
});

test("config generation refuses missing paths instead of emitting a broken config", () => {
  assert.throws(() => buildMcpClientConfig({ platform: "darwin", execPath: "", serverPath: MAC_SERVER, libraryLocationFile: "/x" }), /execPath/);
  assert.throws(() => buildMcpClientConfig({ platform: "darwin", execPath: MAC_EXEC, serverPath: "", libraryLocationFile: "/x" }), /serverPath/);
  assert.throws(() => buildMcpClientConfig({ platform: "darwin", execPath: MAC_EXEC, serverPath: MAC_SERVER }), /libraryLocationFile/);
});

test("POSIX quoting round-trips every awkward character", { skip: process.platform === "win32" }, () => {
  const value = "a'b\"c $d `e` \\f\ng";
  const result = spawnSync("/bin/sh", ["-c", `printf '%s' ${posixShellQuote(value)}`], { encoding: "utf8" });
  assert.equal(result.stdout, value);
});
