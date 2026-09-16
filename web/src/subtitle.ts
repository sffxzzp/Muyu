import { errorMessage, MessageError, message } from './messages'
import type { Format, SubtitleDocument } from './types'
import { byteLength } from './text'
import { boundedText, limits, normalizeTranslation } from './validation'

const blankLines = /\n[\t ]*\n(?:[\t ]*\n)*/
const sequence = /^\d+$/
const isMetadata = (text: string) => /^(?:STYLE|REGION|NOTE(?:[\t ].*)?)$/.test(text.split('\n', 1)[0])
const record = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const string = (value: unknown, max: number): value is string =>
  typeof value === 'string' && byteLength(value) <= max

export function parseSubtitle(filename: string, content: string): SubtitleDocument {
  const format = filename.split('.').at(-1)?.toLowerCase()
  if (format !== 'srt' && format !== 'vtt') throw new Error('请选择 .srt 或 .vtt 字幕文件')
  if (byteLength(content) > 2 * 1024 * 1024) throw new Error('单个字幕文件不能超过 2 MB')
  if (content.includes('\0')) throw new Error('字幕需要使用 UTF-8 编码，请转换编码后重试')
  const blocks = content
    .replace(/^\ufeff/, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(blankLines)
  const doc: SubtitleDocument = { format, cues: [], metadata: [] }
  if (format === 'vtt') {
    if (!/^WEBVTT(?:$|[ \t\n])/.test(blocks[0])) throw new Error('VTT 文件缺少 WEBVTT 文件头')
    doc.header = blocks.shift()!
  }
  for (const block of blocks) {
    if (!block.trim()) continue
    if (format === 'vtt' && isMetadata(block)) {
      doc.metadata!.push({ before: doc.cues.length, text: block })
      continue
    }
    const lines = block.split('\n')
    const id = doc.cues.length + 1
    const timingIndex = lines[0].includes('-->') ? 0 : 1
    const identifier = timingIndex ? lines[0].trim() : ''
    if (format === 'srt' && (!timingIndex || !sequence.test(identifier)))
      throw new MessageError(message('第 {0} 条 SRT 字幕缺少有效序号', { 0: id }))
    if (lines.length <= timingIndex + 1)
      throw new MessageError(message('第 {0} 条字幕缺少时间轴或正文', { 0: id }))
    const parts = lines[timingIndex].split('-->')
    if (parts.length !== 2) throw new MessageError(message('第 {0} 条字幕时间轴无效', { 0: id }))
    const endParts = parts[1].trim().split(/\s+/u)
    if (!endParts[0]) throw new MessageError(message('第 {0} 条字幕缺少结束时间', { 0: id }))
    let start: number, end: number
    try {
      start = parseTime(parts[0].trim(), format)
    } catch (error) {
      throw new MessageError(message('第 {0} 条字幕开始时间无效：{1}', { 0: id, 1: errorMessage(error) }))
    }
    try {
      end = parseTime(endParts[0], format)
      if (end < start) throw new Error()
    } catch {
      throw new MessageError(message('第 {0} 条字幕结束时间无效', { 0: id }))
    }
    const text = lines
      .slice(timingIndex + 1)
      .join('\n')
      .trim()
    if (!text || !boundedText(text, limits.source))
      throw new MessageError(message('第 {0} 条字幕为空或过长', { 0: id }))
    doc.cues.push({ id, identifier, start, end, settings: endParts.slice(1).join(' '), text })
    if (doc.cues.length > 20000) throw new Error('字幕最多支持 20000 条')
  }
  if (!doc.cues.length) throw new Error('文件中没有可翻译的字幕')
  return validateDocument(doc)
}

function parseTime(value: string, format: Format): number {
  const match = (
    format === 'srt' ? /^(\d{2,}):(\d{2}):(\d{2}),(\d{3})$/ : /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/
  ).exec(value)
  if (!match) throw new Error('不符合字幕时间格式')
  const [hours, minutes, seconds, milliseconds] = match.slice(1).map((part) => Number(part ?? 0))
  if (hours > 9999) throw new Error('时间超出范围')
  if (minutes >= 60 || seconds >= 60) throw new Error('分钟或秒超出范围')
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds
}

function timestamp(ms: number, format: string): string {
  const pad = (value: number, size = 2) => String(value).padStart(size, '0')
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${format === 'srt' ? ',' : '.'}${pad(ms % 1000, 3)}`
}

export function renderSubtitle(
  document: SubtitleDocument,
  translations: Record<string, string>,
  format: string,
  mode: string,
  order: string,
): string {
  const doc = validateDocument(document)
  if (format !== 'srt' && format !== 'vtt') throw new Error('导出格式必须为 SRT 或 VTT')
  if (mode !== 'translation' && mode !== 'bilingual') throw new Error('导出类型无效')
  const vttMetadata = format === 'vtt' && doc.format === 'vtt'
  const blocks: string[] =
    format === 'vtt' ? [vttMetadata && doc.header?.startsWith('WEBVTT') ? doc.header : 'WEBVTT'] : []
  const metadata = new Map<number, string[]>()
  if (vttMetadata)
    for (const entry of doc.metadata ?? []) {
      const entries = metadata.get(entry.before) ?? []
      entries.push(entry.text)
      metadata.set(entry.before, entries)
    }
  doc.cues.forEach((cue, i) => {
    if (typeof translations[cue.id] !== 'string' || !translations[cue.id].trim())
      throw new MessageError(message('第 {0} 条字幕尚未翻译，完成后再导出', { 0: cue.id }))
    const translated = normalizeTranslation(translations[cue.id])
    blocks.push(...(metadata.get(i) ?? []))
    const lines: string[] = []
    if (format === 'srt')
      lines.push(
        doc.format === 'srt' && sequence.test(cue.identifier ?? '') ? cue.identifier! : String(i + 1),
      )
    else if (vttMetadata && cue.identifier) lines.push(cue.identifier)
    lines.push(
      `${timestamp(cue.start, format)} --> ${timestamp(cue.end, format)}${cue.settings && doc.format === format ? ' ' + cue.settings : ''}`,
    )
    lines.push(
      mode === 'bilingual'
        ? order === 'translation-first'
          ? `${translated}\n${cue.text}`
          : `${cue.text}\n${translated}`
        : translated,
    )
    blocks.push(lines.join('\n'))
  })
  blocks.push(...(metadata.get(doc.cues.length) ?? []))
  return blocks.join('\n\n') + '\n\n'
}

export function assertAlignment(original: SubtitleDocument, translated: SubtitleDocument): void {
  if (original.cues.length !== translated.cues.length)
    throw new MessageError(
      message('字幕条数不同：原文 {0} 条，译文 {1} 条。请先对齐两份字幕', {
        0: original.cues.length,
        1: translated.cues.length,
      }),
    )
  for (const [i, cue] of original.cues.entries()) {
    const other = translated.cues[i]
    if (cue.start !== other.start || cue.end !== other.end)
      throw new MessageError(
        message('第 {0} 条字幕时间轴不一致（{1} / {2}），请先对齐', {
          0: i + 1,
          1: timestamp(cue.start, 'srt'),
          2: timestamp(other.start, 'srt'),
        }),
      )
  }
}

export function mergeSubtitles(
  original: SubtitleDocument,
  translated: SubtitleDocument,
  format: string,
  order: string,
): string {
  assertAlignment(original, translated)
  return renderSubtitle(
    original,
    Object.fromEntries(translated.cues.map((cue) => [cue.id, cue.text])),
    format,
    'bilingual',
    order,
  )
}

export function validateDocument(value: unknown): SubtitleDocument {
  if (
    !record(value) ||
    !['srt', 'vtt'].includes(value.format) ||
    !Array.isArray(value.cues) ||
    value.cues.length < 1 ||
    value.cues.length > 20000
  )
    throw new Error('字幕数据无效')
  const cues = value.cues.map((cue: any, i: number) => {
    if (
      !record(cue) ||
      cue.id !== i + 1 ||
      !Number.isInteger(cue.start) ||
      !Number.isInteger(cue.end) ||
      cue.start < 0 ||
      cue.end < cue.start ||
      cue.end > 36_000_000_000 ||
      !boundedText(cue.text, limits.source) ||
      !cue.text.trim() ||
      !string(cue.identifier ?? '', 300) ||
      !string(cue.settings ?? '', 1000) ||
      /[\r\n]/.test((cue.identifier ?? '') + (cue.settings ?? '')) ||
      cue.text.includes('\0')
    )
      throw new Error('字幕条目无效')
    return {
      id: cue.id,
      start: cue.start,
      end: cue.end,
      text: cue.text,
      identifier: cue.identifier ?? '',
      settings: cue.settings ?? '',
    }
  })
  if (
    !string(value.header ?? '', 5000) ||
    (value.metadata !== undefined && (!Array.isArray(value.metadata) || value.metadata.length > 20000))
  )
    throw new Error('字幕元数据无效')
  const metadata = (value.metadata ?? []).map((m: any) => {
    if (
      !record(m) ||
      !Number.isInteger(m.before) ||
      m.before < 0 ||
      m.before > cues.length ||
      !string(m.text, 100000) ||
      !isMetadata(m.text)
    )
      throw new Error('VTT 元数据无效')
    return { before: m.before, text: m.text }
  })
  return { format: value.format, header: value.header ?? '', metadata, cues }
}
