import assert from "node:assert/strict";
import test from "node:test";

import { createMcpWorkspace, startMcpServer } from "./helpers/mcp-server-harness.mjs";

// Verbatim list of MCP tool names from before the GravityPort display-name
// rename. Tool names are part of the agent-facing contract and must not drift.
const LEGACY_TOOL_NAMES = [
  "asset_create",
  "asset_list",
  "asset_search",
  "asset_get",
  "asset_provenance_export",
  "asset_archive",
  "asset_duplicate",
  "asset_version_create",
  "asset_version_history",
  "asset_recipe_history",
  "asset_update_metadata",
  "asset_attach_prompt",
  "generation_record",
  "generation_list",
  "generation_relation_record",
  "generation_lineage",
];

test("MCP initialize reports the GravityPort display name and keeps the legacy tool names", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);
  const init = await server.request("initialize", { protocolVersion: "2025-11-25" });
  assert.equal(init.result.serverInfo.name, "GravityPort MCP");
  assert.equal(typeof init.result.serverInfo.version, "string");
  assert.ok(init.result.serverInfo.version.length > 0);
  const tools = await server.request("tools/list");
  assert.deepEqual(tools.result.tools.map((tool) => tool.name), LEGACY_TOOL_NAMES);
  const ping = await server.request("ping");
  assert.deepEqual(ping.result, {});
});
