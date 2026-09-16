import { describe, expect, it } from 'vitest'
import { assertAlignment, mergeSubtitles, parseSubtitle, renderSubtitle, validateDocument } from './subtitle'

const srt =
  '7\r\n00:00:01,200 --> 00:00:03,456\r\nHello,\r\n<i>world.</i>\r\n\r\n12\r\n00:00:03,600 --> 00:00:05,000\r\nNext cue.\r\n'
const vtt =
  'WEBVTT - Example\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0\n\nSTYLE\n::cue { color: lime; }\n\nNOTE keep this note\n\nspeaker-1\n00:01.200 --> 00:03.456 line:90% align:start\nHello,\n<i>world.</i>\n\nsecond\n00:03.600 --> 00:05.000\nNext cue.\n\nNOTE trailing note\n'
const translations = { 1: '你好，\n<i>世界。</i>', 2: '下一条。' }

describe('local subtitle files', () => {
  it('preserves SRT BOM, multiline text, original identifiers and exact timing', () => {
    const doc = parseSubtitle('example.SRT', '\ufeff' + srt)
    expect(doc.cues).toHaveLength(2)
    expect(doc.cues[0]).toMatchObject({
      id: 1,
      identifier: '7',
      start: 1200,
      end: 3456,
      text: 'Hello,\n<i>world.</i>',
    })
    const content = renderSubtitle(doc, translations, 'srt', 'bilingual', 'original-first')
    expect(content).toBe(
      '7\n00:00:01,200 --> 00:00:03,456\nHello,\n<i>world.</i>\n你好，\n<i>世界。</i>\n\n12\n00:00:03,600 --> 00:00:05,000\nNext cue.\n下一条。\n\n',
    )
    const parsed = parseSubtitle('output.srt', content)
    expect(parsed.cues.map(({ id, identifier, start, end }) => ({ id, identifier, start, end }))).toEqual(
      doc.cues.map(({ id, identifier, start, end }) => ({ id, identifier, start, end })),
    )
  })

  it('preserves VTT metadata positions, settings and identifiers and strips them only on SRT conversion', () => {
    const doc = parseSubtitle('video.vtt', vtt)
    expect(doc.metadata).toHaveLength(3)
    expect(doc.metadata?.at(-1)?.before).toBe(2)
    expect(doc.cues[0].settings).toBe('line:90% align:start')
    const content = renderSubtitle(doc, translations, 'vtt', 'translation', 'original-first')
    for (const fragment of [
      doc.header!,
      'STYLE\n::cue { color: lime; }',
      'NOTE keep this note',
      'speaker-1\n00:00:01.200 --> 00:00:03.456 line:90% align:start',
      'NOTE trailing note',
    ])
      expect(content).toContain(fragment)
    const parsed = parseSubtitle('out.vtt', content)
    expect(parsed.metadata).toEqual(doc.metadata)
    expect(parsed.cues[1].text).toBe(translations[2])
    const converted = renderSubtitle(doc, translations, 'srt', 'translation', 'original-first')
    expect(converted).not.toMatch(/STYLE|line:90%|speaker-1/)
    expect(converted).toMatch(/^1\n00:00:01,200/)
  })

  it.each([
    ['x.ass', srt],
    ['x.srt', ''],
    ['x.vtt', '00:01.000 --> 00:02.000\nHi'],
    ['x.srt', '1\n00:99:01,000 --> 00:00:04,000\nHi'],
    ['x.srt', '1\n00:00:03,000 --> 00:00:01,000\nHi'],
    ['x.srt', '1\n00:00:01,000 --> 00:00:02,000'],
    ['x.srt', '\0' + srt],
  ])('rejects malformed %s input', (name, content) => {
    expect(() => parseSubtitle(name, content)).toThrow()
  })

  it('shares count/timeline validation between preview and cross-format merging', () => {
    const original = parseSubtitle('x.srt', srt),
      translated = parseSubtitle('x.vtt', vtt)
    translated.cues.forEach((cue) => {
      cue.text = translations[cue.id as 1 | 2]
    })
    const content = mergeSubtitles(original, translated, 'srt', 'translation-first')
    expect(content).toContain('你好，\n<i>世界。</i>\nHello,\n<i>world.</i>')
    translated.cues[1].start++
    expect(() => assertAlignment(original, translated)).toThrow('时间轴')
    expect(() => mergeSubtitles(original, translated, 'srt', 'original-first')).toThrow('时间轴')
    translated.cues.pop()
    expect(() => mergeSubtitles(original, translated, 'srt', 'original-first')).toThrow('条数')
  })

  it('requires complete translations and normalizes text without breaking cue boundaries', () => {
    const doc = parseSubtitle('x.srt', srt)
    expect(() => renderSubtitle(doc, { 1: '只有一条' }, 'srt', 'translation', '')).toThrow('尚未翻译')
    const normalized = renderSubtitle(doc, { 1: '段落\n\n破坏结构', 2: '下一条' }, 'srt', 'translation', '')
    const parsed = parseSubtitle('normalized.srt', normalized)
    expect(parsed.cues).toHaveLength(2)
    expect(parsed.cues[0].text).toBe('段落\n破坏结构')
    doc.cues[0].identifier = '7\nextra'
    expect(() => validateDocument(doc)).toThrow('字幕条目无效')
  })
})
