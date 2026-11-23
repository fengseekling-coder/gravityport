function readAiSettingsEntry(): boolean {
  if (import.meta.env.DEV) return true
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("gravityport.dev.ai-generation") === "1"
  } catch {
    return false
  }
}

// 任务 458：AI 生成整条线的入口开关；正式构建（DEV=false）默认关闭，仅在
// 开发模式或写入 localStorage "gravityport.dev.ai-generation"="1" 时开启。
// 459 学习库用同一个键、各自一个文件，以后合成一个。开关只管设置左栏
// 「AI」这一项露不露；IPC 通道一直在（没人调就不做事）。
export const AI_SETTINGS_ENTRY: boolean = readAiSettingsEntry()
