import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { MCP_SERVER_VERSION } from "../lib/version-identities.mjs";
import { createMcpWorkspace, startMcpServer } from "./helpers/mcp-server-harness.mjs";

// The 16 tool names must stay in lockstep with the TOOL_* constants in
// mcp/server.mjs. A tool added or removed there has to update this list.
const EXPECTED_TOOL_NAMES = [
  "asset_create",
  "asset_list",
  "asset_search",
  "asset_get",
  "asset_provenance_export",
  "asset_update_metadata",
  "asset_attach_prompt",
  "asset_archive",
  "asset_duplicate",
  "asset_version_create",
  "asset_version_history",
  "asset_recipe_history",
  "generation_record",
  "generation_list",
  "generation_relation_record",
  "generation_lineage",
];

test("initialize echoes the client protocol version, or the default when none is sent", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const echoed = await server.request("initialize", { protocolVersion: "2024-06-25" });
  assert.equal(echoed.result.protocolVersion, "2024-06-25");
  assert.equal(echoed.result.serverInfo.version, MCP_SERVER_VERSION);
  assert.equal(typeof echoed.result.capabilities.tools, "object");

  const defaulted = await server.request("initialize", {});
  assert.equal(defaulted.result.protocolVersion, "2025-11-25");
});

test("ping answers with an empty result object", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const response = await server.request("ping");
  assert.deepEqual(response.result, {});
  assert.equal(response.error, undefined);
});

test("tools/list exposes exactly the 16 registered tools with usable schemas", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const response = await server.request("tools/list");
  const tools = response.result.tools;
  assert.equal(tools.length, EXPECTED_TOOL_NAMES.length);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...EXPECTED_TOOL_NAMES].sort());
  for (const tool of tools) {
    assert.ok(tool.description?.trim().length > 0, `tool ${tool.name} has a non-empty description`);
    assert.equal(tool.inputSchema.type, "object", `tool ${tool.name} accepts an object inputSchema`);
  }
});

test("unknown methods and unknown tools get the documented JSON-RPC error codes", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const unknownMethod = await server.request("no/such/method");
  assert.equal(unknownMethod.error.code, -32601);
  assert.match(unknownMethod.error.message, /Method not found/);

  const unknownTool = await server.request("tools/call", { name: "no_such_tool", arguments: {} });
  assert.equal(unknownTool.error.code, -32602);
  assert.match(unknownTool.error.message, /Unknown tool/);
});

test("argument validation failures return -32602 for the four schema violation classes", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const cases = [
    {
      name: "missing required field",
      call: { name: "asset_get", arguments: {} },
      message: "arguments.assetId is required.",
    },
    {
      name: "wrong argument type",
      call: { name: "asset_get", arguments: { assetId: 7 } },
      message: "arguments.assetId must be a string.",
    },
    {
      name: "value outside the enum",
      call: {
        name: "generation_relation_record",
        arguments: { childGenerationId: "child", parentGenerationId: "parent", relationType: "remixed_from" },
      },
      message: "arguments.relationType must be one of: edited_from, variant_of, derived_from, based_on.",
    },
    {
      name: "field not allowed by additionalProperties: false",
      call: { name: "asset_list", arguments: { nonsense: true } },
      message: "arguments.nonsense is not allowed.",
    },
  ];
  for (const [index, failure] of cases.entries()) {
    const response = await server.request("tools/call", failure.call);
    assert.equal(response.error?.code, -32602, `${failure.name} is a JSON-RPC -32602 error`);
    assert.equal(response.error.message, failure.message, `${failure.name} names the offending path`);
    assert.equal(response.result, undefined, `${failure.name} is not reported as a tool result`);
  }
});

test("a malformed JSON line answers -32700 with null id and the server keeps serving", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  server.sendRaw("{this is not json\n");
  await server.waitForCondition("a -32700 parse error response", () =>
    server.responses.find((message) => message.error?.code === -32700));
  const parseError = server.responses.find((message) => message.error?.code === -32700);
  assert.equal(parseError.id, null);

  // Empty lines must be swallowed silently, not answered as parse errors.
  server.sendRaw("\n");
  server.sendRaw("   \n");
  const pinged = await server.request("ping");
  assert.deepEqual(pinged.result, {});
  assert.equal(server.responses.filter((message) => message.error?.code === -32700).length, 1,
    "empty lines produce no additional -32700 responses");
});

test("requests fired in parallel are each answered with their own id", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const sent = [
    { id: server.send("ping"), expect: "ping" },
    { id: server.send("tools/list"), expect: "tools" },
    { id: server.send("tools/call", { name: "asset_list", arguments: {} }), expect: "asset_list" },
    { id: server.send("ping"), expect: "ping" },
    { id: server.send("no/such/method"), expect: "error" },
  ];
  const responses = await Promise.all(sent.map((entry) => server.waitForResponse(entry.id)));

  for (const [index, entry] of sent.entries()) {
    const response = responses[index];
    assert.equal(response.id, entry.id);
    if (entry.expect === "ping") assert.deepEqual(response.result, {});
    if (entry.expect === "tools") assert.equal(response.result.tools.length, 16);
    if (entry.expect === "asset_list") assert.deepEqual(response.result.structuredContent.assets, []);
    if (entry.expect === "error") assert.equal(response.error.code, -32601);
  }
});

test("business failures surface as isError tool results, not JSON-RPC errors", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const missingGet = await server.request("tools/call", {
    name: "asset_get",
    arguments: { assetId: "does-not-exist" },
  });
  assert.equal(missingGet.error, undefined, "business errors are not JSON-RPC errors");
  assert.equal(missingGet.result.isError, true);
  assert.equal(missingGet.result.structuredContent.error.code, "ASSET_NOT_FOUND");

  const missingArchive = await server.request("tools/call", {
    name: "asset_archive",
    arguments: { assetId: "does-not-exist" },
  });
  assert.equal(missingArchive.error, undefined);
  assert.equal(missingArchive.result.isError, true);
  assert.equal(missingArchive.result.structuredContent.error.code, "ASSET_NOT_FOUND");
});

test("closing stdin mid-write lets the in-flight request finish before the store closes", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);
  await server.request("initialize", {});

  // Random pixels keep the PNG incompressible (~1 MB), so hashing, the pixel
  // digest and the managed copy are still running when stdin ends below.
  const imagePath = join(workspace.imagesDir, "in-flight.png");
  await writeFile(imagePath, await sharp(randomBytes(1024 * 1024), {
    raw: { width: 512, height: 512, channels: 4 },
  }).png().toBuffer());

  const id = server.send("tools/call", {
    name: "asset_create",
    arguments: { assetId: "in-flight", imagePath, prompt: "written while the client hangs up" },
  });
  server.child.stdin.end();

  const response = await server.waitForResponse(id);
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  assert.notEqual(response.result?.isError, true, JSON.stringify(response.result?.structuredContent));
  assert.equal(response.result.structuredContent.asset.id, "in-flight");

  // stdin is gone; after the in-flight request settled and the store closed,
  // the server exits cleanly on its own.
  const exit = await server.waitForExit();
  assert.equal(exit.code, 0);
});
