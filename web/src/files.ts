import { parseSubtitle } from './subtitle'
import type { SubtitleDocument } from './types'

export async function readSubtitle(file: File): Promise<SubtitleDocument> {
  if (!/\.(srt|vtt)$/i.test(file.name)) throw new Error('请选择 SRT 或 VTT 字幕文件')
  if (file.size > 2 * 1024 * 1024)
    throw new Error('单个文件不能超过 2 MB；localStorage 的空间有限，建议及时导出已完成任务')
  const buffer = await file.arrayBuffer()
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new Error('字幕需要使用 UTF-8 编码，请转换编码后重试')
  }
  return parseSubtitle(file.name, content)
}

export function download(content: string, filename: string, mime = 'text/plain;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
