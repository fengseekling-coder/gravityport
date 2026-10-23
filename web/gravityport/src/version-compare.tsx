import { useState } from "react"
import { translate, type Language } from "./i18n"

// 任务 217：「版本对比」块的统一条目。版本家族（手动建的 parent_asset_id
// 家族）和对话轮次（网页采集）都折算成这一种再进组件：
// - id：唯一，写进下拉框的 value。
// - label：下拉选项文字，captions 开启时也是图下那一行。
// - imageUrl：并排两张图的地址（空串渲染空框）。
// - values：按字段中文键（与 i18n 键一致）存待对比的文案，空串显示「—」。
export type VersionCompareEntry = {
  id: string
  label: string
  imageUrl: string
  values: Record<string, string>
}

// 字段行：两边文案不同标 changed（外壳加 .changed）。抽成纯函数方便单测，
// 组件按它的输出逐行渲染。
export function versionCompareRows(fields: string[], base: VersionCompareEntry, target: VersionCompareEntry): Array<{ field: string; left: string; right: string; changed: boolean }> {
  return fields.map((field) => {
    const left = base.values[field] || ""
    const right = target.values[field] || ""
    return { field, left, right, changed: left !== right }
  })
}

// 两侧可以选同一条，所以图和说明按左右位置作 key，不用条目 id。
// 选择是组件内部状态：已选 id 不在条目里（换素材、列表刷新）时回落到调用
// 方给的默认；App 用 key=素材 id 在切换素材时整体重置成默认选择。
export default function VersionCompare({ language, entries, fields, defaultBaseId, defaultTargetId, captions = false }: {
  language: Language
  entries: VersionCompareEntry[]
  fields: string[]
  defaultBaseId: string
  defaultTargetId: string
  captions?: boolean
}) {
  const tr = (text: string) => translate(text, language)
  const [basePick, setBasePick] = useState("")
  const [targetPick, setTargetPick] = useState("")
  if (entries.length < 2) return null
  const base = entries.find((entry) => entry.id === basePick)
    || entries.find((entry) => entry.id === defaultBaseId)
    || entries[0]
  const target = entries.find((entry) => entry.id === targetPick)
    || entries.find((entry) => entry.id === defaultTargetId)
    || entries[entries.length - 1]
  return <div className="version-compare">
    <h4>{tr("版本对比")}</h4>
    <div className="version-compare-selectors">
      <select aria-label={tr("基准版本")} value={base.id} onChange={(event) => setBasePick(event.target.value)}>
        {entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
      </select>
      <select aria-label={tr("目标版本")} value={target.id} onChange={(event) => setTargetPick(event.target.value)}>
        {entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
      </select>
    </div>
    <div className="version-compare-images">
      {[base, target].map((entry, side) => <img key={side} alt={entry.label} src={entry.imageUrl} loading="lazy" />)}
    </div>
    {captions && <div className="version-compare-captions">
      {[base, target].map((entry, side) => <span key={side}>{entry.label}</span>)}
    </div>}
    <div className="version-compare-fields">
      {versionCompareRows(fields, base, target).map(({ field, left, right, changed }) => (
        <div key={field} className={changed ? "changed" : ""}>
          <strong>{tr(field)}</strong><span>{left || "—"}</span><span>{right || "—"}</span>
        </div>
      ))}
    </div>
  </div>
}
