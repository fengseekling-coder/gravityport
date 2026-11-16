import { fill } from "./app-lifecycle"
import { translate, type Language } from "./i18n"
import {
  edgeCurve,
  NODE_HEIGHT,
  NODE_WIDTH,
  nodeBox,
  type CanvasEdge,
  type CanvasMark,
  type CanvasNode,
} from "./version-canvas-model"

type ExportOptions = {
  prompts: boolean
  sources: boolean
  notes: boolean
}

function loadImage(url: string, errorText: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = "anonymous"
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(errorText))
    image.src = url
  })
}

/** A share-safe, raster export: no filesystem paths or hidden source metadata. */
export async function renderCanvasExport(
  title: string,
  inputNodes: CanvasNode[],
  edges: CanvasEdge[],
  options: ExportOptions,
  language: Language = "zh",
) {
  const tr = (text: string) => translate(text, language)
  const extra =
    (options.prompts || options.sources ? 84 : 0) +
    (options.notes
      ? Math.max(0, ...inputNodes.map((node) => node.marks.length)) * 40
      : 0)
  const exportY = new Map<string, number>()
  for (const column of new Set(inputNodes.map((node) => node.column))) {
    inputNodes
      .filter((node) => node.column === column)
      .sort((a, b) => a.y - b.y)
      .forEach((node, index) => exportY.set(node.id, node.y + index * extra))
  }
  const nodes = inputNodes.map((node) => ({ ...node, y: exportY.get(node.id)! }))
  const images = await Promise.all(
    nodes.map((node) => loadImage(node.image, tr("图片加载失败，请稍后重试。"))),
  )
  const width = Math.max(760, ...nodes.map((node) => node.x + NODE_WIDTH + 42))
  const height = Math.max(
    520,
    ...nodes.map((node) => node.y + NODE_HEIGHT + 90 + extra),
  )
  const canvas = document.createElement("canvas")
  canvas.width = width * 2
  canvas.height = height * 2
  const ctx = canvas.getContext("2d")!
  ctx.scale(2, 2)
  ctx.fillStyle = "#f4f4f2"
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = "#292929"
  ctx.font = "600 22px sans-serif"
  ctx.fillText(title, 30, 42)
  ctx.font = "12px sans-serif"
  ctx.fillStyle = "#707070"
  ctx.fillText(`GravityPort · ${tr("版本树")}`, 30, 65)
  ctx.translate(0, 36)
  for (const edge of edges) {
    const from = nodes.find((node) => node.id === edge.from)
    const to = nodes.find((node) => node.id === edge.to)
    if (!from || !to) continue
    ctx.strokeStyle = "#92968e"
    ctx.lineWidth = 1.5
    ctx.setLineDash(edge.suggested ? [5, 5] : [])
    ctx.stroke(new Path2D(edgeCurve(from, to)))
  }
  ctx.setLineDash([])
  const wrap = (text: string, x: number, y: number, maxLines: number) => {
    let line = "",
      row = 0
    for (const char of text) {
      if (ctx.measureText(line + char).width > NODE_WIDTH - 20) {
        ctx.fillText(line, x, y + row * 17)
        line = char
        if (++row >= maxLines) return
      } else line += char
    }
    ctx.fillText(line, x, y + row * 17)
  }
  nodes.forEach((node, index) => {
    ctx.fillStyle = "#fff"
    ctx.beginPath()
    ctx.roundRect(
      node.x - 6,
      node.y - 6,
      NODE_WIDTH + 12,
      NODE_HEIGHT + 12 + extra,
      10,
    )
    ctx.fill()
    // 导出图按原比例画在格子正中，不再拉伸成 3:4（同画布卡片，UI 审查 11-16）。
    const box = nodeBox(node)
    ctx.drawImage(images[index], box.x, box.y, box.width, box.height)
    if (options.notes)
      node.marks.forEach((mark, markIndex) => {
        const x = node.x + mark.x * NODE_WIDTH
        const y = node.y + mark.y * 254
        ctx.strokeStyle = "#b34f30"
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.ellipse(x, y, 27, 18, -0.2, 0, Math.PI * 2)
        ctx.stroke()
        ctx.fillStyle = "#b34f30"
        ctx.font = "600 12px sans-serif"
        ctx.fillText(String(markIndex + 1), x + 27, y - 17)
      })
    ctx.fillStyle = "#292929"
    ctx.font = "500 12px sans-serif"
    const roundPrefix = node.round ? `${fill(tr("第 {n} 轮"), { n: node.round })} · ` : ""
    ctx.fillText(
      `${roundPrefix}${node.name}${node.final ? `  ✓ ${tr("定稿")}` : ""}`,
      node.x + 4,
      node.y + 276,
    )
    ctx.font = "11px sans-serif"
    ctx.fillStyle = "#707070"
    if (options.notes && node.note) wrap(node.note, node.x + 4, node.y + 295, 2)
    if (options.prompts && node.prompt)
      wrap(node.prompt, node.x + 4, node.y + NODE_HEIGHT + 24, 3)
    if (options.sources && node.provider)
      ctx.fillText(node.provider, node.x + 4, node.y + NODE_HEIGHT + 68)
    if (options.notes)
      node.marks.forEach((mark, markIndex) =>
        wrap(
          `${markIndex + 1}. ${mark.text}`,
          node.x + 4,
          node.y + NODE_HEIGHT + (options.prompts || options.sources ? 90 : 32) + markIndex * 40,
          2,
        ),
      )
  })
  return canvas
}

export async function renderAnnotationSheet(
  node: CanvasNode,
  marks: CanvasMark[],
  language: Language = "zh",
) {
  const tr = (text: string) => translate(text, language)
  const image = await loadImage(node.image, tr("图片加载失败，请稍后重试。"))
  const canvas = document.createElement("canvas")
  const width = 1000
  const imageHeight = (width * image.naturalHeight) / image.naturalWidth
  canvas.width = width
  canvas.height = imageHeight + 90 + marks.length * 90
  const ctx = canvas.getContext("2d")!
  ctx.fillStyle = "#fafafa"
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(image, 0, 0, width, imageHeight)
  marks.forEach((mark, index) => {
    const x = mark.x * width,
      y = mark.y * imageHeight
    ctx.strokeStyle = "#b34f30"
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.ellipse(x, y, 70, 48, -0.2, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = "#fafafa"
    ctx.beginPath()
    ctx.arc(
      Math.min(width - 22, x + 64),
      Math.max(22, y - 44),
      22,
      0,
      Math.PI * 2,
    )
    ctx.fill()
    ctx.fillStyle = "#b34f30"
    ctx.font = "600 24px sans-serif"
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText(
      String(index + 1),
      Math.min(width - 22, x + 64),
      Math.max(22, y - 44),
    )
  })
  ctx.textAlign = "left"
  ctx.textBaseline = "alphabetic"
  ctx.fillStyle = "#292929"
  ctx.font = "600 26px sans-serif"
  ctx.fillText(`GravityPort · ${tr("修改说明")}`, 36, imageHeight + 50)
  ctx.font = "24px sans-serif"
  marks.forEach((mark, index) => {
    const text = `${index + 1}. ${mark.text || "—"}`
    let line = "",
      row = 0
    for (const char of text) {
      if (ctx.measureText(line + char).width > width - 72) {
        ctx.fillText(line, 36, imageHeight + 105 + index * 90 + row * 30)
        line = char
        if (++row > 1) break
      } else line += char
    }
    if (row < 2)
      ctx.fillText(line, 36, imageHeight + 105 + index * 90 + row * 30)
  })
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error(tr("导出失败，请重试。"))),
      "image/png",
    ),
  )
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  // Some embedded Chromium hosts drop non-ASCII download names, including the extension.
  const safe = filename.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
  const extension = safe.split(".").pop()?.replace(/[^a-zA-Z0-9]/g, "") || "png"
  const stem = safe.slice(0, safe.lastIndexOf(".")).normalize("NFKD")
    .replace(/[^a-zA-Z0-9 _-]/g, "").replace(/^[-_ ]+|[-_ ]+$/g, "")
  anchor.download = `${stem || "gravityport-export"}.${extension}`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** One landscape PDF page containing the exact export preview, with no remote service. */
export function canvasPdf(canvas: HTMLCanvasElement): Blob {
  const jpeg = Uint8Array.from(
    atob(canvas.toDataURL("image/jpeg", 0.94).split(",")[1]),
    (char) => char.charCodeAt(0),
  )
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  let length = 0
  const offsets = [0]
  const push = (value: string | Uint8Array) => {
    const bytes = typeof value === "string" ? encoder.encode(value) : value
    chunks.push(bytes)
    length += bytes.length
  }
  const pageWidth = 1000
  const pageHeight = (pageWidth * canvas.height) / canvas.width
  const stream = `q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Im0 Do Q`
  push("%PDF-1.4\n")
  const object = (number: number, value: string) => {
    offsets.push(length)
    push(`${number} 0 obj\n${value}\nendobj\n`)
  }
  object(1, "<< /Type /Catalog /Pages 2 0 R >>")
  object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
  object(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
  )
  offsets.push(length)
  push(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
  )
  push(jpeg)
  push("\nendstream\nendobj\n")
  object(
    5,
    `<< /Length ${encoder.encode(stream).length} >>\nstream\n${stream}\nendstream`,
  )
  const xref = length
  push(
    `xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
      .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`,
  )
  return new Blob(chunks as BlobPart[], { type: "application/pdf" })
}
