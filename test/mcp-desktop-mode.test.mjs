import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LIBRARY_DIR_NAME, LIBRARY_LOCATION_FILE } from "../lib/library-location.mjs";
import { copyLibraryForRelocation } from "../lib/library-relocation.mjs";
import { removeTestPath } from "./test-cleanup.mjs";
import { spawnMcpServerAsClient, writePngFixture } from "./helpers/mcp-server-harness.mjs";

const SERVER_PATH = resolve(import.meta.dirname, "..", "mcp", "server.mjs");
const TOOL_COUNT = 16;

async function desktopLikeHome(t) {
  const root = await mkdtemp(join(tmpdir(), "mosa-mcp-desktop-"));
  t.after(() => removeTestPath(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const userData = join(home, "Library", "Application Support", "mosa");
  const clientCwd = join(root, "client-cwd");
  await mkdir(userData, { recursive: true });
  await mkdir(clientCwd, { recursive: true });
  return { root, home, clientCwd, locationFile: join(userData, LIBRARY_LOCATION_FILE) };
}

/** The env a config copied from Settings carries, plus the throwaway HOME. */
function copiedConfigEnv({ home, locationFile }) {
  return { ...process.env, HOME: home, MOSA_LIBRARY_LOCATION_FILE: locationFile };
}

function startAsClient(t, fixture) {
  return spawnMcpServerAsClient(t, { args: [SERVER_PATH], cwd: fixture.clientCwd, env: copiedConfigEnv(fixture) });
}

async function stop(server) {
  const exited = server.waitForExit();
  server.child.kill("SIGTERM");
  return exited;
}

async function searchIds(server, query) {
  const result = await server.callToolStrict("asset_search", { query });
  return result.structuredContent.results.map((entry) => entry.asset?.id ?? entry.id);
}

test("a copied desktop config keeps finding the library after it is moved", async (t) => {
  const fixture = await desktopLikeHome(t);
  const defaultLibrary = join(fixture.home, LIBRARY_DIR_NAME);

  // Never moved: no location file yet, so the server uses the default library.
  const first = startAsClient(t, fixture);
  const init = await first.request("initialize", { protocolVersion: "2025-11-25" });
  assert.equal(init.result.serverInfo.name, "GravityPort MCP");
  assert.equal((await first.request("tools/list")).result.tools.length, TOOL_COUNT);
  const imagePath = await writePngFixture(join(defaultLibrary, "imports", "harbor.png"), { color: "#1f6f8b" });
  const created = await first.callToolStrict("asset_create", { assetId: "harbor-dusk", imagePath, prompt: "lighthouse harbor at dusk" });
  assert.equal(created.structuredContent.asset.id, "harbor-dusk");
  assert.deepEqual(await searchIds(first, "lighthouse"), ["harbor-dusk"]);

  // The user moves the library in Settings → Storage while the assistant is
  // still running. The desktop copies it, records library-location.json, and
  // deletes the original — exactly what change-library-location does.
  const movedLibrary = join(fixture.root, "External Drive", "Art Library");
  await mkdir(movedLibrary, { recursive: true });
  await copyLibraryForRelocation({ sourceLibraryDir: defaultLibrary, destinationLibraryDir: movedLibrary });
  await writeFile(fixture.locationFile, `${JSON.stringify({ path: movedLibrary })}\n`);
  await rm(defaultLibrary, { recursive: true, force: true });

  // The still-running server refuses rather than touching the deleted library.
  const stale = await first.callTool("asset_search", { query: "lighthouse" });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.error.code, "LIBRARY_MOVED");
  assert.match(stale.content[0].text, /Restart this AI assistant/);
  assert.equal((await stop(first)).code, 0);

  // After the assistant restarts, the unchanged copied config follows the move.
  const second = startAsClient(t, fixture);
  await second.request("initialize", { protocolVersion: "2025-11-25" });
  assert.deepEqual(await searchIds(second, "lighthouse"), ["harbor-dusk"]);
  const asset = (await second.callToolStrict("asset_get", { assetId: "harbor-dusk" })).structuredContent.asset;
  assert.ok(resolve(asset.image_path).startsWith(movedLibrary), `asset resolves inside the moved library: ${asset.image_path}`);
});

test("a location file naming a missing library fails on stderr and keeps stdout clean", async (t) => {
  const fixture = await desktopLikeHome(t);
  const missing = join(fixture.root, "Unplugged Drive", "Art Library");
  await writeFile(fixture.locationFile, `${JSON.stringify({ path: missing })}\n`);

  const server = startAsClient(t, fixture);
  let stdout = "";
  server.child.stdout.on("data", (chunk) => { stdout += chunk; });
  const exit = await server.waitForExit();
  assert.equal(exit.code, 1);
  assert.match(server.stderr, /GravityPort library not found at .*Unplugged Drive/);
  assert.equal(stdout, "");
  assert.deepEqual(server.responses, []);
});

test("an unreadable location file fails closed instead of opening a fresh library", async (t) => {
  const fixture = await desktopLikeHome(t);
  await writeFile(fixture.locationFile, "not json");

  const server = startAsClient(t, fixture);
  const exit = await server.waitForExit();
  assert.equal(exit.code, 1);
  assert.match(server.stderr, /could not read its library location file/);
  assert.deepEqual(server.responses, []);
});
