// 浏览位置历史（GravityPort A3，任务 70）。纯逻辑模块：不碰 DOM、不发请求、
// 不写本地存储（上限 50 条，只存内存）。app.mjs 负责取快照与恢复；这里的
// 光标语义和浏览器一致：
//   - push 记一条新位置；在中间位置 push 时丢掉它之后的全部前进记录；
//   - back / forward 只移动光标并返回目标快照，恢复本身不产生新记录；
//   - peekBack / peekForward 供「先过未保存编辑确认、再消费光标」的调用方
//     （确认被取消时光标不能已经移动）；
//   - dropForward 丢掉光标之后的全部前进记录（不动光标）：堆叠因解散/成员
//     移空/已不存在而退出时，那条堆叠记录不能留给前进按钮。

export const NAVIGATION_HISTORY_LIMIT = 50;

export function createNavigationHistory({ limit = NAVIGATION_HISTORY_LIMIT } = {}) {
  const limitNormalized = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : NAVIGATION_HISTORY_LIMIT;
  const entries = [];
  let index = -1;

  return {
    push(snapshot) {
      entries.length = index + 1;
      entries.push(snapshot);
      if (entries.length > limitNormalized) entries.splice(0, entries.length - limitNormalized);
      index = entries.length - 1;
    },
    current() {
      return index >= 0 ? entries[index] : null;
    },
    peekBack() {
      return index > 0 ? entries[index - 1] : null;
    },
    peekForward() {
      return index >= 0 && index < entries.length - 1 ? entries[index + 1] : null;
    },
    back() {
      const entry = index > 0 ? entries[index - 1] : null;
      if (entry) index -= 1;
      return entry;
    },
    forward() {
      const entry = index >= 0 && index < entries.length - 1 ? entries[index + 1] : null;
      if (entry) index += 1;
      return entry;
    },
    canBack() {
      return index > 0;
    },
    canForward() {
      return index >= 0 && index < entries.length - 1;
    },
    dropForward() {
      if (index >= 0 && index < entries.length - 1) entries.length = index + 1;
    },
    clear() {
      entries.length = 0;
      index = -1;
    },
    get size() {
      return entries.length;
    },
  };
}
