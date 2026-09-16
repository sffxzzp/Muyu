import { describe, expect, it } from 'vitest'
import { selectGlossary } from './glossary'

describe('multilingual glossary matching', () => {
  it.each([
    ['Meet <i>ANN</i> tomorrow.', 'Ann', true],
    ['The annual report is ready.', 'Ann', false],
    ['Meet Anna tomorrow.', 'Ann', false],
    ['Project\nAurora has started.', 'project aurora', true],
    ['They visited CAFÉ LUMIÈRE.', 'Café Lumière', true],
    ['请前往玄武门集合。', '玄武门', true],
    ['エレンは調査兵団に入った。', '調査兵団', true],
    ['그들은 서울에서 만났다.', '서울', true],
    ['وصلنا إلى قلعة النور؟', 'قلعة النور', true],
    ['The A&amp;B Institute opens.', 'A&B Institute', true],
  ])('matches %s / %s', (text, source, matches) => {
    const term = { source, target: '译文', locked: true }
    const selected = selectGlossary({
      cues: [{ id: 1, text }],
      context: [],
      futureContext: [],
      glossary: [term],
    })
    expect(selected).toEqual(matches ? [term] : [])
    if (selected[0]) selected[0].target = '修改副本'
    expect(term.target).toBe('译文')
  })
})
