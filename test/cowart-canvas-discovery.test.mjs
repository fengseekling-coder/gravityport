import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverCowartProjectsFromCodexSessions } from "../lib/cowart-canvas-discovery.js";

test("discovers only projects with a real Cowart launch call and canvas marker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-discovery-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sessionsDir = join(root, "sessions");
  const nativeProject = join(root, "native-project");
  const fallbackProject = join(root, "fallback-project");
  const incidentalProject = join(root, "incidental-project");
  await Promise.all([
    writeCanvasMarker(nativeProject),
    writeCanvasMarker(fallbackProject),
    writeCanvasMarker(incidentalProject),
    mkdir(sessionsDir, { recursive: true }),
  ]);

  await Promise.all([
    writeSession(join(sessionsDir, "native.jsonl"), nativeProject, {
      type: "mcp_tool_call",
      name: "mcp__cowart_mcp__render_cowart_canvas_widget",
      arguments: JSON.stringify({ projectDir: nativeProject }),
    }),
    writeSession(join(sessionsDir, "fallback.jsonl"), fallbackProject, {
      type: "custom_tool_call",
      name: "exec",
      arguments: `const result = await tools.exec_command({cmd:"./scripts/start-canvas.sh ${fallbackProject}",workdir:"${fallbackProject}"});`,
    }),
    writeSession(join(sessionsDir, "incidental.jsonl"), incidentalProject, {
      type: "custom_tool_call",
      name: "exec",
      arguments: "const result = await tools.exec_command({cmd:\"rg -n start-canvas.sh .\"});",
    }),
  ]);

  const discovered = await discoverCowartProjectsFromCodexSessions({ sessionsDir, fullScan: true });
  const canonicalNativeProject = await realpath(nativeProject);
  const canonicalFallbackProject = await realpath(fallbackProject);
  assert.deepEqual(
    new Set(discovered.map((entry) => entry.projectDir)),
    new Set([canonicalNativeProject, canonicalFallbackProject]),
  );
  assert.equal(discovered.every((entry) => entry.canvasDir === join(entry.projectDir, "canvas")), true);
});

test("discovers project from structured JSON arguments with workdir and no turn_context.cwd", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-workdir-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sessionsDir = join(root, "sessions");
  const workdirProject = join(root, "workdir-project");
  await Promise.all([
    writeCanvasMarker(workdirProject),
    mkdir(sessionsDir, { recursive: true }),
  ]);

  // Session with NO turn_context -- the project dir is only in structured
  // JSON arguments as { cmd, workdir }.
  await writeFile(join(sessionsDir, "workdir-only.jsonl"), [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        arguments: JSON.stringify({
          cmd: "./scripts/start-canvas.sh",
          workdir: workdirProject,
        }),
      },
    }),
  ].join("\n") + "\n", "utf8");

  const discovered = await discoverCowartProjectsFromCodexSessions({ sessionsDir, fullScan: true });
  const canonicalWorkdirProject = await realpath(workdirProject);
  assert.deepEqual(
    discovered.map((entry) => entry.projectDir),
    [canonicalWorkdirProject],
  );
  assert.equal(discovered[0].canvasDir, join(canonicalWorkdirProject, "canvas"));
});

test("discovers project from structured JSON arguments with cwd and no turn_context.cwd", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-cwd-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sessionsDir = join(root, "sessions");
  const cwdProject = join(root, "cwd-project");
  await Promise.all([
    writeCanvasMarker(cwdProject),
    mkdir(sessionsDir, { recursive: true }),
  ]);

  await writeFile(join(sessionsDir, "cwd-only.jsonl"), [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        arguments: JSON.stringify({
          cmd: "./scripts/start-canvas.sh",
          cwd: cwdProject,
        }),
      },
    }),
  ].join("\n") + "\n", "utf8");

  const discovered = await discoverCowartProjectsFromCodexSessions({ sessionsDir, fullScan: true });
  const canonicalCwdProject = await realpath(cwdProject);
  assert.deepEqual(
    discovered.map((entry) => entry.projectDir),
    [canonicalCwdProject],
  );
});

test("does not discover project when cmd only mentions start-canvas.sh in a search", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-falsepos-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sessionsDir = join(root, "sessions");
  const searchProject = join(root, "search-project");
  await Promise.all([
    writeCanvasMarker(searchProject),
    mkdir(sessionsDir, { recursive: true }),
  ]);

  // The cmd is a search/rg command that merely mentions start-canvas.sh as
  // a search term -- this must NOT be treated as a launch.
  await writeFile(join(sessionsDir, "search-mention.jsonl"), [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        arguments: JSON.stringify({
          cmd: "rg -n start-canvas.sh .",
          workdir: searchProject,
        }),
      },
    }),
  ].join("\n") + "\n", "utf8");

  const discovered = await discoverCowartProjectsFromCodexSessions({ sessionsDir, fullScan: true });
  assert.equal(discovered.length, 0);
});

test("does not discover project when arguments mention start-canvas.sh in a comment or string", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-comment-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sessionsDir = join(root, "sessions");
  const commentProject = join(root, "comment-project");
  await Promise.all([
    writeCanvasMarker(commentProject),
    mkdir(sessionsDir, { recursive: true }),
  ]);

  // The cmd is an echo/comment that mentions start-canvas.sh -- not a launch.
  await writeFile(join(sessionsDir, "comment-mention.jsonl"), [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        arguments: JSON.stringify({
          cmd: 'echo "run start-canvas.sh to open canvas"',
          workdir: commentProject,
        }),
      },
    }),
  ].join("\n") + "\n", "utf8");

  const discovered = await discoverCowartProjectsFromCodexSessions({ sessionsDir, fullScan: true });
  assert.equal(discovered.length, 0);
});

test("discovered project is the projectDir even when workdir and cwd point to other canvas-bearing projects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-priority-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sessionsDir = join(root, "sessions");
  const projectDirProject = join(root, "projectdir-project");
  const workdirProject = join(root, "workdir-project");
  const cwdProject = join(root, "cwd-project");
  // All three have a Cowart marker so the test would only show wrong-priority
  // picks if the function returned multiple fields.
  await Promise.all([
    writeCanvasMarker(projectDirProject),
    writeCanvasMarker(workdirProject),
    writeCanvasMarker(cwdProject),
    mkdir(sessionsDir, { recursive: true }),
  ]);

  await writeFile(join(sessionsDir, "priority.jsonl"), [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        arguments: JSON.stringify({
          cmd: "./scripts/start-canvas.sh",
          projectDir: projectDirProject,
          workdir: workdirProject,
          cwd: cwdProject,
        }),
      },
    }),
  ].join("\n") + "\n", "utf8");

  const discovered = await discoverCowartProjectsFromCodexSessions({ sessionsDir, fullScan: true });
  const canonicalProjectDirProject = await realpath(projectDirProject);
  assert.deepEqual(
    discovered.map((entry) => entry.projectDir),
    [canonicalProjectDirProject],
    "expected only the projectDir project to be discovered",
  );
});

test("falls back to workdir when projectDir is missing and cwd points to another canvas", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-workdir-fallback-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sessionsDir = join(root, "sessions");
  const workdirProject = join(root, "workdir-project");
  const cwdProject = join(root, "cwd-project");
  await Promise.all([
    writeCanvasMarker(workdirProject),
    writeCanvasMarker(cwdProject),
    mkdir(sessionsDir, { recursive: true }),
  ]);

  await writeFile(join(sessionsDir, "workdir-fallback.jsonl"), [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        arguments: JSON.stringify({
          cmd: "./scripts/start-canvas.sh",
          workdir: workdirProject,
          cwd: cwdProject,
        }),
      },
    }),
  ].join("\n") + "\n", "utf8");

  const discovered = await discoverCowartProjectsFromCodexSessions({ sessionsDir, fullScan: true });
  const canonicalWorkdirProject = await realpath(workdirProject);
  assert.deepEqual(
    discovered.map((entry) => entry.projectDir),
    [canonicalWorkdirProject],
    "expected only the workdir project to be discovered when projectDir is absent",
  );
});

test("regex fallback on an un-stringified JS call still picks only the first valid field by priority", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-js-priority-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sessionsDir = join(root, "sessions");
  const projectDirProject = join(root, "projectdir-project");
  const workdirProject = join(root, "workdir-project");
  const cwdProject = join(root, "cwd-project");
  await Promise.all([
    writeCanvasMarker(projectDirProject),
    writeCanvasMarker(workdirProject),
    writeCanvasMarker(cwdProject),
    mkdir(sessionsDir, { recursive: true }),
  ]);

  // The Codex session records the raw source of the tool call verbatim.
  // parseArguments() cannot turn an un-stringified JS expression into a
  // structured object, so the extractor must consult `source` via the
  // projectDir > workdir > cwd regex fallback.  All three directories
  // have valid Cowart markers; the test only passes if the regex
  // fallback honours the same priority order and stops at projectDir.
  const jsExpression = [
    "const result = await tools.exec_command({",
    `  cmd:"./scripts/start-canvas.sh",`,
    `  projectDir:"${projectDirProject}",`,
    `  workdir:"${workdirProject}",`,
    `  cwd:"${cwdProject}"`,
    "});",
  ].join("\n");

  await writeFile(join(sessionsDir, "js-call-priority.jsonl"), [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        arguments: jsExpression,
      },
    }),
  ].join("\n") + "\n", "utf8");

  const discovered = await discoverCowartProjectsFromCodexSessions({ sessionsDir, fullScan: true });
  const canonicalProjectDirProject = await realpath(projectDirProject);
  assert.deepEqual(
    discovered.map((entry) => entry.projectDir),
    [canonicalProjectDirProject],
    "expected regex fallback to discover only the projectDir project",
  );
});

test("skips an unreadable session file without failing the whole discovery round", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-unreadable-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sessionsDir = join(root, "sessions");
  const goodProject = join(root, "good-project");
  const blockedProject = join(root, "blocked-project");
  await Promise.all([
    writeCanvasMarker(goodProject),
    writeCanvasMarker(blockedProject),
    mkdir(sessionsDir, { recursive: true }),
  ]);
  await writeSession(join(sessionsDir, "good.jsonl"), goodProject, {
    type: "mcp_tool_call",
    name: "mcp__cowart_mcp__render_cowart_canvas_widget",
    arguments: JSON.stringify({ projectDir: goodProject }),
  });
  // 一个读不了的会话文件（权限 000，测完恢复权限再清理），里面也带着一次
  // 合法 launch：整轮发现不能因为它作废，它自己也不能进缓存。
  const blockedPath = join(sessionsDir, "blocked.jsonl");
  await writeSession(blockedPath, blockedProject, {
    type: "mcp_tool_call",
    name: "mcp__cowart_mcp__render_cowart_canvas_widget",
    arguments: JSON.stringify({ projectDir: blockedProject }),
  });
  await chmod(blockedPath, 0o000);
  t.after(async () => { await chmod(blockedPath, 0o644).catch(() => {}); });

  const cache = new Map();
  const discovered = await discoverCowartProjectsFromCodexSessions({ sessionsDir, fullScan: true, cache });
  const canonicalGoodProject = await realpath(goodProject);
  assert.deepEqual(discovered.map((entry) => entry.projectDir), [canonicalGoodProject]);

  // 下一轮还会再试读不了的文件（没写进缓存），整轮仍然只出好文件的项目。
  const second = await discoverCowartProjectsFromCodexSessions({ sessionsDir, fullScan: true, cache });
  assert.deepEqual(second.map((entry) => entry.projectDir), [canonicalGoodProject]);
});

async function writeCanvasMarker(projectDir) {
  const canvasDir = join(projectDir, "canvas");
  await mkdir(canvasDir, { recursive: true });
  await writeFile(join(canvasDir, "cowart-view-state.json"), "{}\n", "utf8");
}

async function writeSession(sessionPath, cwd, call) {
  await writeFile(sessionPath, [
    { type: "turn_context", payload: { cwd } },
    { type: "response_item", payload: call },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}
