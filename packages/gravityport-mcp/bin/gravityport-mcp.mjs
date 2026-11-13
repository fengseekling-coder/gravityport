#!/usr/bin/env node
/**
 * GravityPort MCP launcher (npx -y gravityport-mcp).
 *
 * With the desktop app installed, this starts the MCP server bundled inside
 * the app — the same one the Settings → Connect copy-button config uses,
 * running the app's own executable with ELECTRON_RUN_AS_NODE=1 — and hands
 * the stdio pipes straight through: stdin and stdout are never read or
 * rewritten here, the child's exit code becomes our own, and SIGINT/SIGTERM
 * are forwarded to the child.
 *
 * Without the app, this process serves a minimal stdio MCP server itself so
 * the assistant sees the real tool list and gets a clear bilingual "install
 * the desktop app first" answer on every tool call, instead of an
 * unexplained connection failure. stdout carries JSON-RPC only; logs go to
 * stderr.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findGravityPortApp } from "../lib/find-app.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

// Install notice, fixed wording: Chinese first, English second.
const NOTICE_ZH = "使用 GravityPort MCP 需要先安装 GravityPort 桌面 App（macOS：Apple 芯片和 Intel 芯片；Windows）。下载：https://gravityport.azhuilab.com/?ref=mcp 。安装后打开一次 App，再重启这个 AI 助手。如果 App 装在别的位置，请把环境变量 GRAVITYPORT_APP_PATH 设为 App 所在位置。";
const NOTICE_EN = "GravityPort MCP needs the GravityPort desktop app (macOS on Apple silicon or Intel; Windows). Download: https://gravityport.azhuilab.com/en/?ref=mcp . After installing, open the app once, then restart this AI assistant. If the app is installed somewhere else, set GRAVITYPORT_APP_PATH to its location.";
const NOTICE_TEXT = `${NOTICE_ZH}\n${NOTICE_EN}`;

const app = findGravityPortApp({ platform: process.platform, env: process.env, homedir, exists: existsSync });
if (app) launchAppServer(app);
else runFallbackServer();

function launchAppServer(app) {
  const child = spawn(app.execPath, [app.serverPath], {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  child.on("error", (error) => {
    process.stderr.write(`gravityport-mcp: could not start ${app.execPath}: ${error.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (code !== null) {
      process.exit(code);
      return;
    }
    // The child died from a signal it did not handle. Drop the forwarders so
    // the default disposition applies again, then die the same way so the
    // launcher's exit status still matches the child's.
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    process.kill(process.pid, signal);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }
}

function runFallbackServer() {
  let tools;
  try {
    tools = JSON.parse(readFileSync(join(packageRoot, "tools.json"), "utf8"));
  } catch (error) {
    process.stderr.write(`gravityport-mcp: could not read tools.json: ${error.message}\n`);
    tools = [];
  }
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const sendResult = (id, result) => send({ jsonrpc: "2.0", id, result });
  const sendError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

  process.stderr.write("gravityport-mcp: GravityPort desktop app not found; answering MCP requests with the install notice.\n");

  // Same stdio protocol as mcp/server.mjs: one JSON-RPC message per line.
  const handleMessage = (message) => {
    const { id, method, params } = message;
    // JSON-RPC notifications (no `id`) and methods under notifications/ never
    // get a reply.
    if (!Object.hasOwn(message, "id")) return;
    if (typeof method === "string" && method.startsWith("notifications/")) return;
    if (method === "initialize") {
      sendResult(id, {
        protocolVersion: params?.protocolVersion || "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "gravityport", version },
        instructions: NOTICE_EN,
      });
      return;
    }
    if (method === "ping") {
      sendResult(id, {});
      return;
    }
    if (method === "tools/list") {
      sendResult(id, { tools });
      return;
    }
    if (method === "tools/call") {
      // Every tool needs the installed app; answer with the fixed notice.
      sendResult(id, { content: [{ type: "text", text: NOTICE_TEXT }], isError: true });
      return;
    }
    sendError(id, -32601, `Method not found: ${method}`);
  };

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      handleMessage(JSON.parse(line));
    } catch (error) {
      sendError(null, -32700, error.message);
    }
  });
}
