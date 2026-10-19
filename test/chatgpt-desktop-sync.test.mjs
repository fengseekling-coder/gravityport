import assert from "node:assert/strict";
import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyDesktopChatSignals,
  createChatgptDesktopSync,
  pendingDesktopConversations,
  readDesktopChatSignals,
} from "../lib/chatgpt-desktop-sync.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const CONVERSATION_A = "6ad67be1-c980-83e8-8645-a7c40099f1ca";
const CONVERSATION_B = "6ad67be1-c980-83e8-8645-a7c40099f1cb";
const ACCOUNT_KEY = JSON.stringify(["user-test", "account-test"]);

function globalState({ bindings = {}, active = [], history = [] } = {}) {
  return {
    "electron-persisted-atom-state": {
      "client-thread-bindings-v1": bindings,
      "chatgpt-conversation-resume-tokens-v1": Object.fromEntries(active.map((id) => [JSON.stringify([ACCOUNT_KEY, id]), "token"])),
      "prompt-history": { "chatgpt-global": history, global: [{ markdown: "codex prompt" }] },
    },
  };
}

test("desktop chat signals keep only ChatGPT bindings, the open conversation, and a prompt hash", () => {
  const signals = readDesktopChatSignals(globalState({
    bindings: {
      "local-chatgpt:a": CONVERSATION_A,
      "client-new-thread:b": CONVERSATION_B,
      "local-chatgpt:bad": "../../etc",
    },
    active: [CONVERSATION_A],
    history: [{ markdown: "一只蓝色玻璃苹果" }],
  }));
  assert.deepEqual(signals.bindings, [CONVERSATION_A]);
  assert.deepEqual(signals.active, [CONVERSATION_A]);
  assert.match(signals.promptSignature, /^[0-9a-f]{32}$/);
  assert.doesNotMatch(JSON.stringify(signals), /苹果/);
  assert.deepEqual(readDesktopChatSignals({}), { bindings: [], active: [], promptSignature: "" });
});

test("first observation catches up existing chats once; later only new chats and sent prompts count", () => {
  const first = applyDesktopChatSignals(null, { bindings: [CONVERSATION_A], active: [], promptSignature: "p1" }, 1_000);
  assert.equal(first.conversations[CONVERSATION_A].activityAt, 1_000);
  assert.deepEqual(pendingDesktopConversations(first, 1_000 + 89_999), []);
  assert.deepEqual(pendingDesktopConversations(first, 1_000 + 90_000), [CONVERSATION_A]);

  const synced = { ...first, conversations: { [CONVERSATION_A]: { ...first.conversations[CONVERSATION_A], syncedAt: 1_000 } } };
  const unchanged = applyDesktopChatSignals(synced, { bindings: [CONVERSATION_A], active: [CONVERSATION_A], promptSignature: "p1" }, 5_000);
  assert.deepEqual(pendingDesktopConversations(unchanged, 500_000), []);

  const sent = applyDesktopChatSignals(unchanged, { bindings: [CONVERSATION_A, CONVERSATION_B], active: [CONVERSATION_A], promptSignature: "p2" }, 6_000);
  assert.equal(sent.conversations[CONVERSATION_A].activityAt, 6_000);
  assert.equal(sent.conversations[CONVERSATION_B].activityAt, 6_000);
  assert.deepEqual(pendingDesktopConversations(sent, 200_000).sort(), [CONVERSATION_A, CONVERSATION_B].sort());

  // No open conversation: a sent prompt is attributed to the newest binding.
  const fallback = applyDesktopChatSignals(sent, { bindings: [CONVERSATION_A, CONVERSATION_B], active: [], promptSignature: "p3" }, 7_000);
  assert.equal(fallback.conversations[CONVERSATION_B].activityAt, 7_000);
  assert.equal(fallback.conversations[CONVERSATION_A].activityAt, 6_000);
});

test("desktop sync tracker leases, acknowledges, retries and persists across restarts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-chatgpt-desktop-sync-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const globalStatePath = join(root, ".codex-global-state.json");
  const statePath = join(root, "library", ".chatgpt-desktop-sync.json");
  let clock = 1_000;
  const now = () => clock;
  const write = async (state, mtimeSeconds) => {
    await writeFile(globalStatePath, JSON.stringify(state));
    await utimes(globalStatePath, mtimeSeconds, mtimeSeconds);
  };

  await write(globalState({ bindings: { "local-chatgpt:a": CONVERSATION_A }, history: [{ markdown: "one" }] }), 100);
  const sync = createChatgptDesktopSync({ globalStatePath, statePath, now, pollMs: 60_000, quietMs: 90_000, leaseMs: 300_000 });
  await sync.poll();
  assert.deepEqual(sync.claimPending(), []);
  clock += 90_000;
  assert.deepEqual(sync.claimPending(), [CONVERSATION_A]);
  assert.deepEqual(sync.claimPending(), [], "a leased conversation is not handed out twice");

  assert.deepEqual(sync.acknowledge(CONVERSATION_A, "timeout"), { ok: true });
  assert.deepEqual(sync.claimPending(), [CONVERSATION_A], "a failed attempt is retried");
  assert.deepEqual(sync.acknowledge(CONVERSATION_A, "bogus"), { ok: false });
  assert.deepEqual(sync.acknowledge(CONVERSATION_A, "captured"), { ok: true });
  assert.deepEqual(sync.claimPending(), []);
  await sync.stop();

  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(persisted.conversations[CONVERSATION_A].syncedAt, 1_000);
  assert.doesNotMatch(JSON.stringify(persisted), /one/);

  // After a restart nothing is replayed until the user sends another prompt.
  const restarted = createChatgptDesktopSync({ globalStatePath, statePath, now, pollMs: 60_000, quietMs: 90_000 });
  await restarted.poll();
  clock += 200_000;
  assert.deepEqual(restarted.claimPending(), []);
  await write(globalState({ bindings: { "local-chatgpt:a": CONVERSATION_A }, active: [CONVERSATION_A], history: [{ markdown: "one" }, { markdown: "two" }] }), 200);
  await restarted.poll();
  clock += 90_000;
  assert.deepEqual(restarted.claimPending(), [CONVERSATION_A]);
  await restarted.stop();
});

test("desktop sync tracker is a no-op without the desktop app state file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-chatgpt-desktop-sync-missing-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sync = createChatgptDesktopSync({ globalStatePath: join(root, "missing.json"), statePath: join(root, "state.json") });
  await sync.poll();
  assert.deepEqual(sync.claimPending(), []);
  assert.deepEqual(sync.status(), { tracked: 0, pending: 0 });
  await sync.stop();
});
