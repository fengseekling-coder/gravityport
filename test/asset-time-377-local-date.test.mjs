// Task 377: date-only createdAfter/createdBefore bounds are local midnight of
// that day (user rule 2026-11-08), not UTC. The timezone must be fixed before
// node starts, so the parse-level checks run in spawned children (one per
// zone) through the real module, and the asset_search checks run against a
// real mcp/server.mjs spawned with the same TZ.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createMcpWorkspace, startMcpServer, writePngFixture } from "./helpers/mcp-server-harness.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runnerPath = join(repositoryRoot, "test", "helpers", "asset-time-377-runner.mjs");

function parseInTimezone(timezone) {
  const { status, stdout } = spawnSync(process.execPath, [runnerPath], {
    encoding: "utf8",
    env: { ...process.env, TZ: timezone },
  });
  assert.equal(status, 0, `runner failed under TZ=${timezone}`);
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

test("a date-only bound is local midnight in America/Los_Angeles (UTC-8 in November)", () => {
  const parsed = parseInTimezone("America/Los_Angeles");
  // 2026-11-07 00:00:00 PST === 2026-11-07T08:00:00.000Z — NOT UTC midnight.
  assert.equal(parsed.dateOnlyMs, Date.parse("2026-11-07T08:00:00.000Z"));
  assert.equal(parsed.utcZMs, Date.parse("2026-11-07T00:00:00.000Z"), "a bound carrying Z keeps its explicit zone");
  assert.equal(parsed.naiveLocalNoonMs, Date.parse("2026-11-07T20:00:00.000Z"), "a zoneless date-time keeps parsing as local");
  assert.equal(parsed.rolledDayMs, null, "2026-02-30 still rejects");
  assert.equal(parsed.notADateMs, null);
  assert.equal(parsed.numberPassthroughMs, 1234567890, "millis pass through untouched");
});

test("a date-only bound is local midnight in Asia/Shanghai (UTC+8)", () => {
  const parsed = parseInTimezone("Asia/Shanghai");
  // 2026-11-07 00:00:00 CST === 2026-11-06T16:00:00.000Z.
  assert.equal(parsed.dateOnlyMs, Date.parse("2026-11-06T16:00:00.000Z"));
  assert.equal(parsed.utcZMs, Date.parse("2026-11-07T00:00:00.000Z"), "a bound carrying Z keeps its explicit zone");
  assert.equal(parsed.naiveLocalNoonMs, Date.parse("2026-11-07T04:00:00.000Z"), "a zoneless date-time keeps parsing as local");
  assert.equal(parsed.rolledDayMs, null, "2026-02-30 still rejects");
});

async function seedAssetCreatedAt(t, workspace, server, createdAt) {
  const filePath = join(workspace.imagesDir, "time-bound-fixture.png");
  await writePngFixture(filePath, { color: "#1a2b3c" });
  const result = await server.callToolStrict("asset_create", {
    imagePath: filePath,
    prompt: "time bound fixture",
    created_at: createdAt,
  });
  return result.structuredContent.asset.id;
}

test("asset_search date-only bounds match the server's local day (America/Los_Angeles)", async (t) => {
  const workspace = await createMcpWorkspace(t, { prefix: "mosa-mcp-377-tz-la-" });
  const server = startMcpServer(t, workspace, { env: { TZ: "America/Los_Angeles" } });
  // 2026-11-07T04:00:00.000Z is 2026-11-06 20:00 local (PST): before the Nov 7
  // local midnight bound, after the Nov 6 one.
  const assetId = await seedAssetCreatedAt(t, workspace, server, "2026-11-07T04:00:00.000Z");

  const before = await server.callToolStrict("asset_search", { createdBefore: "2026-11-07" });
  assert.ok(
    before.structuredContent.results.some((entry) => entry.asset.id === assetId),
    `createdBefore "2026-11-07" must include an asset created 2026-11-06 20:00 local, got: ${JSON.stringify(before.structuredContent.results.map((entry) => entry.asset.id))}`,
  );

  const after = await server.callToolStrict("asset_search", { createdAfter: "2026-11-07" });
  assert.ok(
    !after.structuredContent.results.some((entry) => entry.asset.id === assetId),
    "createdAfter \"2026-11-07\" (local Nov 7 midnight) must exclude an asset created 2026-11-06 20:00 local",
  );

  const dayWindow = await server.callToolStrict("asset_search", { createdAfter: "2026-11-06", createdBefore: "2026-11-07" });
  assert.ok(dayWindow.structuredContent.results.some((entry) => entry.asset.id === assetId), "the Nov 6 local day window contains the asset");
});

test("asset_search date-only bounds match the server's local day (Asia/Shanghai)", async (t) => {
  const workspace = await createMcpWorkspace(t, { prefix: "mosa-mcp-377-tz-sh-" });
  const server = startMcpServer(t, workspace, { env: { TZ: "Asia/Shanghai" } });
  // The same wall-clock "2026-11-06 20:00" is a different instant here:
  // 2026-11-06T12:00:00.000Z.
  const assetId = await seedAssetCreatedAt(t, workspace, server, "2026-11-06T12:00:00.000Z");

  const before = await server.callToolStrict("asset_search", { createdBefore: "2026-11-07" });
  assert.ok(before.structuredContent.results.some((entry) => entry.asset.id === assetId), "createdBefore \"2026-11-07\" includes 2026-11-06 20:00 local (CST)");

  const after = await server.callToolStrict("asset_search", { createdAfter: "2026-11-07" });
  assert.ok(!after.structuredContent.results.some((entry) => entry.asset.id === assetId), "createdAfter \"2026-11-07\" excludes 2026-11-06 20:00 local (CST)");
});

test("bounds carrying Z are untouched by the server timezone", async (t) => {
  const workspace = await createMcpWorkspace(t, { prefix: "mosa-mcp-377-tz-z-" });
  const server = startMcpServer(t, workspace, { env: { TZ: "America/Los_Angeles" } });
  // 2026-11-07T09:00:00.000Z is 2026-11-07 01:00 local (PST): outside the Nov 6
  // local day-only window, but inside [00:00Z, 23:59Z] written with explicit Z.
  const assetId = await seedAssetCreatedAt(t, workspace, server, "2026-11-07T09:00:00.000Z");

  const zWindow = await server.callToolStrict("asset_search", {
    createdAfter: "2026-11-07T00:00:00.000Z",
    createdBefore: "2026-11-07T23:59:59.999Z",
  });
  assert.ok(zWindow.structuredContent.results.some((entry) => entry.asset.id === assetId), "an explicit-Z window keeps its zone");

  const localDay = await server.callToolStrict("asset_search", { createdAfter: "2026-11-06", createdBefore: "2026-11-07" });
  assert.ok(!localDay.structuredContent.results.some((entry) => entry.asset.id === assetId), "the Nov 6 local (PST) day window excludes it");
});
