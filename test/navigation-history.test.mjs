// navigation-history.mjs 单测：push/back/forward/canBack/canForward、
// 中间位置 push 截断前进记录、上限 50、恢复（back/forward）不产生新记录。
import assert from "node:assert/strict";
import test from "node:test";

import { NAVIGATION_HISTORY_LIMIT, createNavigationHistory } from "../web/app/navigation-history.mjs";

const snap = (label) => ({ scope: "all", facets: {}, mediaKind: "all", query: label });

test("fresh history has no back/forward and empty current", () => {
  const history = createNavigationHistory();
  assert.equal(history.size, 0);
  assert.equal(history.current(), null);
  assert.equal(history.canBack(), false);
  assert.equal(history.canForward(), false);
  assert.equal(history.back(), null);
  assert.equal(history.forward(), null);
});

test("push records positions; the first entry cannot be backed out of", () => {
  const history = createNavigationHistory();
  history.push(snap("a"));
  assert.equal(history.size, 1);
  assert.equal(history.current().query, "a");
  assert.equal(history.canBack(), false, "the initial position has nothing behind it");
  assert.equal(history.canForward(), false);
  history.push(snap("b"));
  assert.equal(history.canBack(), true);
  assert.equal(history.canForward(), false);
  assert.equal(history.peekBack().query, "a");
});

test("back/forward move the cursor and return the target snapshot", () => {
  const history = createNavigationHistory();
  history.push(snap("a"));
  history.push(snap("b"));
  history.push(snap("c"));
  assert.equal(history.back().query, "b");
  assert.equal(history.current().query, "b");
  assert.equal(history.canBack(), true);
  assert.equal(history.canForward(), true);
  assert.equal(history.forward().query, "c");
  assert.equal(history.canForward(), false);
  assert.equal(history.back().query, "b");
  assert.equal(history.back().query, "a");
  assert.equal(history.canBack(), false);
});

test("restoring (back/forward) never grows the history", () => {
  const history = createNavigationHistory();
  history.push(snap("a"));
  history.push(snap("b"));
  for (let round = 0; round < 5; round += 1) {
    assert.equal(history.size, 2, `round ${round}: back must not push`);
    history.back();
    assert.equal(history.size, 2, `round ${round}: the restore itself must not record`);
    history.forward();
  }
  assert.equal(history.current().query, "b");
});

test("pushing at a middle position drops every forward entry", () => {
  const history = createNavigationHistory();
  history.push(snap("a"));
  history.push(snap("b"));
  history.push(snap("c"));
  history.back(); // 光标停在 b
  history.push(snap("d"));
  assert.equal(history.size, 3, "a/b stay, c is dropped, d is appended");
  assert.equal(history.current().query, "d");
  assert.equal(history.canForward(), false);
  assert.equal(history.back().query, "b", "the trail still runs through the branching position");
  assert.equal(history.back().query, "a");
  assert.equal(history.canBack(), false);
});

test("history keeps at most the last `limit` entries", () => {
  assert.equal(NAVIGATION_HISTORY_LIMIT, 50);
  const history = createNavigationHistory();
  for (let index = 0; index < 70; index += 1) history.push(snap(`p${index}`));
  assert.equal(history.size, NAVIGATION_HISTORY_LIMIT);
  assert.equal(history.current().query, "p69");
  // 最早的 20 条被丢弃：一路 back 只能回到 p20。
  let steps = 0;
  while (history.canBack()) {
    history.back();
    steps += 1;
  }
  assert.equal(steps, NAVIGATION_HISTORY_LIMIT - 1);
  assert.equal(history.current().query, "p20");
  assert.equal(history.size, NAVIGATION_HISTORY_LIMIT, "walking back never resizes the window");
});

test("custom smaller limit and clear() behave", () => {
  const history = createNavigationHistory({ limit: 2 });
  history.push(snap("a"));
  history.push(snap("b"));
  history.push(snap("c"));
  assert.equal(history.size, 2);
  assert.equal(history.back().query, "b");
  assert.equal(history.canBack(), false);
  history.clear();
  assert.equal(history.size, 0);
  assert.equal(history.current(), null);
  assert.equal(history.canBack(), false);
  assert.equal(history.canForward(), false);
});

// 任务 123：堆叠因解散/成员移空/已不存在而退出时，光标退回根位置后必须丢掉
// 那条堆叠记录——前进按钮不能再指向一个已经不存在的堆叠。
test("dropForward discards every entry after the cursor and leaves the cursor entry", () => {
  const history = createNavigationHistory();
  history.push(snap("a"));
  history.push({ ...snap("a"), stackId: "s1" });
  history.back();
  assert.equal(history.canForward(), true);
  history.dropForward();
  assert.equal(history.canForward(), false, "the stack record must be gone after dropForward");
  assert.equal(history.size, 1, "the root record stays");
  assert.equal(history.current().query, "a");
  // 空历史与光标在末尾时 dropForward 必须是安全空操作。
  createNavigationHistory().dropForward();
  history.dropForward();
  assert.equal(history.size, 1);
});

test("dropForward at a middle position drops only the forward trail", () => {
  const history = createNavigationHistory();
  history.push(snap("a"));
  history.push(snap("b"));
  history.push({ ...snap("b"), stackId: "s2" });
  history.back(); // 光标在 b
  history.dropForward();
  assert.equal(history.size, 2);
  assert.equal(history.canBack(), true, "older records behind the cursor stay");
  assert.equal(history.peekBack().query, "a");
  assert.equal(history.canForward(), false);
});

// 任务 123：堆叠记录永远紧跟在它的根位置记录后面（enterStack 成功后在根位置
// 记录上 push 一条带 stackId 的记录）。记满 50 条时 push 丢的是最旧的头，
// 「根位置 → 堆叠」这对相邻关系必须原样保留。
test("a stack record pushed right after its root stays adjacent, including when the limit is full", () => {
  const stackSnap = (label, stackId) => ({ ...snap(label), stackId });
  // 未记满：根位置记录之后 push 堆叠记录，堆叠的 peekBack 就是它的根位置。
  const fresh = createNavigationHistory();
  fresh.push(snap("root"));
  fresh.push(stackSnap("root", "s1"));
  assert.equal(fresh.size, 2);
  assert.equal(fresh.current().stackId, "s1");
  assert.equal(fresh.peekBack().stackId || "", "", "the record behind a stack record is its root position");
  assert.equal(fresh.peekBack().query, "root");

  // 已记满：先填满 50 条，再 push 根位置（挤出最旧一条），再 push 堆叠记录。
  const full = createNavigationHistory();
  for (let index = 0; index < NAVIGATION_HISTORY_LIMIT; index += 1) full.push(snap(`p${index}`));
  full.push(snap("root"));
  full.push(stackSnap("root", "s9"));
  assert.equal(full.size, NAVIGATION_HISTORY_LIMIT, "the limit still holds after the stack push");
  assert.equal(full.current().stackId, "s9");
  assert.equal(full.peekBack().query, "root", "the stack record is still preceded by its own root record");
  // 堆叠记录退回根位置后前进可再进；dropForward 后前进关闭。
  assert.equal(full.back().query, "root");
  assert.equal(full.canForward(), true);
  full.dropForward();
  assert.equal(full.canForward(), false);
});
