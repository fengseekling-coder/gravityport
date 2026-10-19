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

// prompts: conversation id -> id of the last prompt message sent there.
function globalState({ bindings = {}, prompts = {} } = {}) {
  return {
    "electron-persisted-atom-state": {
      "client-thread-bindings-v1": bindings,
      "chatgpt-conversation-resume-tokens-v1": Object.fromEntries(Object.entries(prompts).map(([id, promptMessageId]) => [
        JSON.stringify([ACCOUNT_KEY, id]),
        { token: "resume-secret", promptMessageId, expiresAtMs: 1, turnTraceId: "trace" },
      ])),
      "prompt-history": { "chatgpt-global": [{ markdown: "一只蓝色玻璃苹果" }] },
    },
  };
}

test("desktop chat signals keep only ChatGPT bindings and a hash of each conversation's last prompt id", () => {
  const signals = readDesktopChatSignals(globalState({
    bindings: {
      "local-chatgpt:a": CONVERSATION_A,
      "client-new-thread:b": CONVERSATION_B,
      "local-chatgpt:bad": "../../etc",
    },
    prompts: { [CONVERSATION_A]: "msg-1", "../bad": "msg-2" },
  }));
  assert.deepEqual(signals.bindings, [CONVERSATION_A]);
  assert.deepEqual(Object.keys(signals.promptMarks), [CONVERSATION_A]);
  assert.match(signals.promptMarks[CONVERSATION_A], /^[0-9a-f]{32}$/);
  assert.doesNotMatch(JSON.stringify(signals), /苹果|resume-secret|msg-1/);
  assert.deepEqual(readDesktopChatSignals({}), { bindings: [], promptMarks: {} });
});

test("only a newly bound conversation or a new prompt in that same conversation counts as activity", () => {
  const signals = (prompts) => readDesktopChatSignals(globalState({
    bindings: { "local-chatgpt:a": CONVERSATION_A, "local-chatgpt:b": CONVERSATION_B },
    prompts,
  }));
  const first = applyDesktopChatSignals(null, signals({ [CONVERSATION_A]: "a-1" }), 1_000);
  assert.equal(first.conversations[CONVERSATION_A].activityAt, 1_000);
  assert.equal(first.conversations[CONVERSATION_B].activityAt, 1_000);
  assert.deepEqual(pendingDesktopConversations(first, 1_000 + 89_999), []);
  assert.deepEqual(pendingDesktopConversations(first, 1_000 + 90_000), [CONVERSATION_A], "one conversation per hand-out");

  const synced = {
    ...first,
    conversations: Object.fromEntries(Object.entries(first.conversations).map(([id, entry]) => [id, { ...entry, syncedAt: 1_000 }])),
  };
  const unchanged = applyDesktopChatSignals(synced, signals({ [CONVERSATION_A]: "a-1" }), 5_000);
  assert.deepEqual(pendingDesktopConversations(unchanged, 500_000), []);

  // A prompt sent in B leaves A alone, even though A still has a resume entry.
  const sentInB = applyDesktopChatSignals(unchanged, signals({ [CONVERSATION_A]: "a-1", [CONVERSATION_B]: "b-1" }), 6_000);
  assert.equal(sentInB.conversations[CONVERSATION_A].activityAt, 1_000);
  assert.equal(sentInB.conversations[CONVERSATION_B].activityAt, 6_000);
  assert.deepEqual(pendingDesktopConversations(sentInB, 200_000), [CONVERSATION_B]);

  const sentInA = applyDesktopChatSignals(sentInB, signals({ [CONVERSATION_A]: "a-2", [CONVERSATION_B]: "b-1" }), 7_000);
  assert.equal(sentInA.conversations[CONVERSATION_A].activityAt, 7_000);
  assert.equal(sentInA.conversations[CONVERSATION_B].activityAt, 6_000);
});

test("entries written before prompt marks only record the mark instead of resyncing", () => {
  const legacy = {
    version: 1,
    initialized: true,
    promptSignature: "old",
    conversations: { [CONVERSATION_A]: { activityAt: 1_000, syncedAt: 1_000, attempts: 0, leaseUntil: 0 } },
  };
  const next = applyDesktopChatSignals(legacy, readDesktopChatSignals(globalState({
    bindings: { "local-chatgpt:a": CONVERSATION_A },
    prompts: { [CONVERSATION_A]: "a-1" },
  })), 9_000);
  assert.equal(next.conversations[CONVERSATION_A].activityAt, 1_000);
  assert.match(next.conversations[CONVERSATION_A].promptMark, /^[0-9a-f]{32}$/);
  assert.equal("promptSignature" in next, false);
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

  await write(globalState({ bindings: { "local-chatgpt:a": CONVERSATION_A }, prompts: { [CONVERSATION_A]: "a-1" } }), 100);
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
  assert.doesNotMatch(JSON.stringify(persisted), /a-1|resume-secret|苹果/);

  // After a restart nothing is replayed until the user sends another prompt there.
  const restarted = createChatgptDesktopSync({ globalStatePath, statePath, now, pollMs: 60_000, quietMs: 90_000 });
  await restarted.poll();
  clock += 200_000;
  assert.deepEqual(restarted.claimPending(), []);
  await write(globalState({ bindings: { "local-chatgpt:a": CONVERSATION_A }, prompts: { [CONVERSATION_A]: "a-2" } }), 200);
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
