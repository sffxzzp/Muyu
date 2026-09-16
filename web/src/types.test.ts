import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildChunks, defaultSettings, parseSeedTerms, type Cue } from './types'

function cues(texts: string[]): Cue[] {
  return texts.map((text, i) => ({ id: i + 1, start: i * 1000, end: (i + 1) * 1000, text }))
}
afterEach(() => vi.unstubAllGlobals())

describe('semantic chunks', () => {
  it('waits for a sentence ending after the target but never exceeds the hard limit', () => {
    const input = cues(['one', 'two', 'three.', 'four', 'five', 'six', 'seven', 'eight!'])
    const result = buildChunks(input, { ...defaultSettings, targetChunkSize: 2, maxChunkSize: 3 })
    expect(result).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 6 },
      { start: 6, end: 8 },
    ])
    expect(result.flatMap((chunk) => input.slice(chunk.start, chunk.end).map((cue) => cue.id))).toEqual(
      input.map((cue) => cue.id),
    )
  })
  it('recognizes punctuation before closing tags and quotes', () => {
    expect(
      buildChunks(cues(['one', '<i>“Done!”</i>', 'three']), {
        ...defaultSettings,
        targetChunkSize: 2,
        maxChunkSize: 5,
      }),
    ).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 3 },
    ])
  })
  it.each(['هل نذهب؟', 'یہ اختتام ہے۔', 'यही अंत है।', 'समाप्त॥', '「終わりです。」', '“结束了！”', 'አልቋል።'])(
    'recognizes multilingual sentence endings: %s',
    (ending) => {
      expect(
        buildChunks(cues(['intro', ending, 'more context', 'last cue']), {
          ...defaultSettings,
          targetChunkSize: 2,
          maxChunkSize: 4,
        })[0],
      ).toEqual({ start: 0, end: 2 })
    },
  )

  it('uses continuous source-language sentences and avoids cutting after a title or an initial', () => {
    for (const fragment of ['to meet Dr.', 'to meet J.']) {
      const input = cues([
        'We need',
        fragment,
        'Smith today.',
        'Then we can leave',
        'after lunch.',
        'Goodbye.',
      ])
      expect(
        buildChunks(input, {
          ...defaultSettings,
          sourceLanguage: 'English',
          targetChunkSize: 2,
          maxChunkSize: 4,
        })[0],
      ).toEqual({ start: 0, end: 3 })
    }
    const fragments = cues(['We need', 'to finish', 'this sentence', 'before leaving.', 'The next sentence.'])
    expect(
      buildChunks(fragments, {
        ...defaultSettings,
        sourceLanguage: 'en-US',
        targetChunkSize: 2,
        maxChunkSize: 4,
      })[0].end,
    ).toBe(4)
  })

  it('uses Unicode fallback for unknown languages and browsers without Intl.Segmenter', () => {
    const input = cues(['بداية', '<i>&quot;هل نذهب؟&quot;</i>', 'مزيد من الكلام', 'آخر الكلام'])
    for (const sourceLanguage of ['auto', 'A mixed-language recording']) {
      expect(
        buildChunks(input, { ...defaultSettings, sourceLanguage, targetChunkSize: 2, maxChunkSize: 4 })[0]
          .end,
      ).toBe(2)
    }
    vi.stubGlobal('Intl', Object.create(Intl, { Segmenter: { value: undefined } }))
    expect(
      buildChunks(input, {
        ...defaultSettings,
        sourceLanguage: 'العربية',
        targetChunkSize: 2,
        maxChunkSize: 4,
      })[0].end,
    ).toBe(2)
  })

  it('uses a long pause near the target for subtitles without punctuation', () => {
    const input = cues(Array.from({ length: 10 }, (_, i) => `ข้อความ ${i}`))
    for (let i = 3; i < input.length; i++) {
      input[i].start += 4000
      input[i].end += 4000
    }
    expect(
      buildChunks(input, {
        ...defaultSettings,
        sourceLanguage: 'ไทย',
        targetChunkSize: 4,
        maxChunkSize: 6,
      })[0],
    ).toEqual({ start: 0, end: 3 })
  })

  it('preserves every cue and timestamp while observing both hard limits', () => {
    const input = cues(
      Array.from({ length: 150 }, (_, i) => `${'字幕😀'.repeat(15 + (i % 10))}${i % 7 === 0 ? '。' : ''}`),
    )
    const original = JSON.stringify(input)
    const chunks = buildChunks(input, {
      ...defaultSettings,
      targetChunkSize: 4,
      maxChunkSize: 7,
      maxChunkCharacters: 500,
    })
    expect(chunks.flatMap((chunk) => input.slice(chunk.start, chunk.end))).toEqual(input)
    for (const chunk of chunks) {
      const group = input.slice(chunk.start, chunk.end)
      expect(group.length).toBeLessThanOrEqual(7)
      expect(group.reduce((sum, cue) => sum + [...cue.text].length, 0)).toBeLessThanOrEqual(500)
    }
    expect(JSON.stringify(input)).toBe(original)
  })
  it('splits oversized blocks by characters without dropping an oversized cue', () => {
    expect(
      buildChunks(cues(['中'.repeat(300), '文'.repeat(300), '字'.repeat(700)]), {
        ...defaultSettings,
        maxChunkCharacters: 500,
      }),
    ).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 3 },
    ])
  })
  it('rejects impossible settings', () => {
    expect(() =>
      buildChunks(cues(['hi']), { ...defaultSettings, targetChunkSize: 20, maxChunkSize: 10 }),
    ).toThrow('块上限')
    expect(() => buildChunks(cues(['hi']), { ...defaultSettings, rpm: 0 })).toThrow('rpm')
    expect(() => buildChunks(cues(['hi']), { ...defaultSettings, futureContextSize: 21 })).toThrow(
      'futureContextSize',
    )
  })
})

it('parses user terms as locked and rejects duplicate or empty terms', () => {
  expect(parseSeedTerms('cash flow = 现金流\nrisk = 风险')).toMatchObject([
    { source: 'cash flow', target: '现金流', locked: true },
    { source: 'risk', target: '风险', locked: true },
  ])
  expect(() => parseSeedTerms('Risk = 风险\nrisk = 冒险')).toThrow('重复')
  expect(() => parseSeedTerms('risk = ')).toThrow('不能为空')
})
