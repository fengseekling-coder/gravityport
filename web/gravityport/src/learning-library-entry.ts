import { localAiBuild } from "./local-build-flags"

// 任务 459：学习库入口开关；正式构建（DEV=false）默认关闭，仅在开发模式、本机
// 预览包（打包时设 GRAVITYPORT_LOCAL_AI=1）或写入 localStorage
// "gravityport.dev.ai-generation"="1" 时开启。与任务 458 的
// AI 设置页共用同一个 localStorage 键（两个入口随后续的整合单合成一个），
// 各自一个文件，照 version-canvas-model.ts 的写法。

function readLearningLibraryEntry(): boolean {
  if (import.meta.env.DEV || localAiBuild()) return true
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("gravityport.dev.ai-generation") === "1"
  } catch {
    return false
  }
}

export const LEARNING_LIBRARY_ENTRY: boolean = readLearningLibraryEntry()

// 学习库视图的 active 键是 `learn:<id>`（id 寻址，改名不影响）。返回空串表示
// 不在学习库视图。分组键 `group:<名字>` 的注释适用于这里：id 不含冒号，但
// 仍按前缀整段剥，语义与 groupNameForActive 一致。
export function learningLibraryIdForActive(active: string): string {
  return active.startsWith("learn:") ? active.slice("learn:".length) : ""
}

// 卡片拖放目标的解析：落点元素（或其祖先）在侧栏学习库行上时返回该行的
// id，否则返回空串。App.tsx 的 sideDropTargetAt 用它取学习库分支——放下是
// 「加入」，不是移动。
export function learningLibraryIdFromDropRow(element: Element | null | undefined): string {
  const row = element?.closest?.("[data-drop-learning-library]")
  return row ? row.getAttribute("data-drop-learning-library") || "" : ""
}
