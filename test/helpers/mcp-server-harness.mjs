import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { createAssetStore } from "../../lib/asset-store.mjs";
import { readGravityPortEnv } from "../../lib/env-aliases.mjs";
import { removeTestPath } from "../test-cleanup.mjs";

// Every spawned MCP server must be pinned to a throwaway workspace. Without
// these variables the server falls back to the developer's real ~/MOSA Library
// and the current working directory, so a missing variable is a hard error
// instead of a silent default.
const REQUIRED_ENV_VARS = ["HOME", "MOSA_PROJECT_DIR", "MOSA_LIBRARY_DIR", "CODEX_GENERATED_IMAGES_DIR"];

export async function createMcpWorkspace(t, { prefix = "mosa-mcp-", jsonLibrary = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => removeTestPath(root, { recursive: true, force: true }));
  const workspace = {
    root,
    libraryDir: join(root, "library"),
    imagesDir: join(root, "generated-images"),
  };
  await mkdir(workspace.libraryDir, { recursive: true });
  await mkdir(workspace.imagesDir, { recursive: true });
  // The MCP server never creates a library, so every workspace seeds a real
  // fresh (completed) SQLite library before the server starts, with the same
  // layout the server resolves for an explicitly configured library. The JSON
  // variant instead seeds a genuine legacy 0.1.x JSON library (per-asset
  // metadata files, no mosa.db) so createAssetStore picks the JSON backend.
  if (jsonLibrary) {
    const metadataDir = join(workspace.libraryDir, "assets", "default", "metadata");
    await mkdir(metadataDir, { recursive: true });
    await writeFile(
      join(metadataDir, "legacy-asset.json"),
      `${JSON.stringify({ id: "legacy-asset", asset: "legacy-asset.png", created_at: "2023-01-01T00:00:00.000Z" })}\n`,
      "utf8",
    );
    await mkdir(join(workspace.libraryDir, "assets", "default", "images"), { recursive: true });
    await writeFile(join(workspace.libraryDir, "assets", "default", "images", "legacy-asset.png"), "fixture");
  } else {
    const seedStore = createAssetStore({
      projectRoot: workspace.root,
      managerDir: workspace.root,
      libraryDir: workspace.libraryDir,
      explicitLibraryDir: workspace.libraryDir,
      assetsRoot: join(workspace.libraryDir, "assets"),
      generatedImagesDir: join(workspace.libraryDir, "imports"),
    });
    seedStore.close();
  }
  return workspace;
}

export async function writePngFixture(filePath, { color = "#243047", width = 8, height = 8 } = {}) {
  await mkdir(dirname(filePath), { recursive: true });
  await sharp({ create: { width, height, channels: 4, background: color } }).png().toFile(filePath);
  return filePath;
}

function buildMcpEnv(workspace, extra = {}) {
  const env = {
    ...process.env,
    HOME: workspace.root,
    MOSA_PROJECT_DIR: workspace.root,
    MOSA_LIBRARY_DIR: workspace.libraryDir,
    CODEX_GENERATED_IMAGES_DIR: workspace.imagesDir,
    ...extra,
  };
  const missing = REQUIRED_ENV_VARS.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Refusing to spawn the MCP server without ${missing.join(", ")}; the defaults would touch the real user library.`);
  }
  return env;
}

export function startMcpServer(t, workspace, { env: extraEnv } = {}) {
  const env = buildMcpEnv(workspace, extraEnv);
  const child = spawn(process.execPath, ["mcp/server.mjs"], {
    cwd: process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const handle = new McpServerProcess(child);
  t.after(() => handle.terminateIfRunning());
  return handle;
}

/**
 * Spawn the MCP server exactly as an AI client would from a copied desktop
 * config: a chosen command, arguments, working directory, and environment.
 * HOME must still be a throwaway directory, and the library must be named
 * either directly or through a library-location file (unless the caller opts
 * out, e.g. to test the server following the desktop's own location file).
 */
export function spawnMcpServerAsClient(t, { command = process.execPath, args = ["mcp/server.mjs"], cwd = process.cwd(), env, allowMissingLibraryEnv = false }) {
  if (!env?.HOME) throw new Error("Refusing to spawn the MCP server without a throwaway HOME.");
  if (!allowMissingLibraryEnv
    && !readGravityPortEnv(env, "GRAVITYPORT_LIBRARY_DIR")
    && !readGravityPortEnv(env, "GRAVITYPORT_LIBRARY_LOCATION_FILE")) {
    throw new Error("Refusing to spawn the MCP server without GRAVITYPORT_LIBRARY_DIR or GRAVITYPORT_LIBRARY_LOCATION_FILE.");
  }
  // The server follows the desktop App's own library-location.json, which
  // lives under XDG_CONFIG_HOME on Linux and APPDATA on Windows, not under
  // HOME. Pin those (and the Windows home) inside the throwaway HOME so a real
  // App's location file can never leak into, or be written by, a test.
  const isolatedEnv = {
    ...env,
    USERPROFILE: env.HOME,
    XDG_CONFIG_HOME: join(env.HOME, ".config"),
    APPDATA: join(env.HOME, "AppData", "Roaming"),
  };
  const child = spawn(command, args, { cwd, env: isolatedEnv, stdio: ["pipe", "pipe", "pipe"] });
  const handle = new McpServerProcess(child);
  t.after(() => handle.terminateIfRunning());
  return handle;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

class McpServerProcess {
  constructor(child) {
    this.child = child;
    this.responses = [];
    this.stderr = "";
    this.nextId = 1;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          this.responses.push(JSON.parse(line));
        } catch {
          this.responses.push({ unparsableLine: line });
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { this.stderr += chunk; });
  }

  send(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    const message = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    return id;
  }

  sendRaw(text) {
    this.child.stdin.write(text);
  }

  async request(method, params) {
    const id = this.send(method, params);
    return this.waitForResponse(id);
  }

  async callTool(name, args) {
    const response = await this.request("tools/call", { name, arguments: args });
    if (response.error) throw new Error(`tools/call ${name} returned JSON-RPC error ${response.error.code}: ${response.error.message}`);
    return response.result;
  }

  async callToolStrict(name, args) {
    const result = await this.callTool(name, args);
    if (result.isError) {
      throw new Error(`tools/call ${name} failed: ${JSON.stringify(result.structuredContent?.error ?? result.content)}`);
    }
    return result;
  }

  async waitForResponse(id, { timeoutMs = 10_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.responses.find((message) => message.id === id);
      if (found) return found;
      await delay(20);
    }
    throw new Error(`MCP server produced no response for id ${id} within ${timeoutMs}ms. stderr: ${this.stderr.slice(-2000)}`);
  }

  async waitForCondition(description, predicate, { timeoutMs = 10_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let latest;
    while (Date.now() < deadline) {
      latest = await predicate();
      if (latest) return latest;
      await delay(20);
    }
    throw new Error(`Condition not met within ${timeoutMs}ms: ${description}`);
  }

  waitForExit({ timeoutMs = 15_000 } = {}) {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return Promise.resolve({ code: this.child.exitCode, signal: this.child.signalCode });
    }
    return Promise.race([
      once(this.child, "exit").then(() => ({ code: this.child.exitCode, signal: this.child.signalCode })),
      delay(timeoutMs).then(() => {
        throw new Error(`MCP server did not exit within ${timeoutMs}ms. stderr: ${this.stderr.slice(-2000)}`);
      }),
    ]);
  }

  async terminateIfRunning() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = once(this.child, "exit");
    this.child.kill("SIGTERM");
    await exited;
  }
}

export async function waitForFile(path, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await stat(path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await delay(20);
    }
  }
  throw new Error(`File did not appear within ${timeoutMs}ms: ${path}`);
}

export async function waitForFileAbsent(path, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      throw error;
    }
    await delay(20);
  }
  throw new Error(`File did not disappear within ${timeoutMs}ms: ${path}`);
}
