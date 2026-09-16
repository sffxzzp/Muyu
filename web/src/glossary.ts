import { lower, plainText } from './text'
import type { Term, TranslationRequest } from './types'

export const glossaryCharacterBudget = 6000
const glossaryText = (text: string) => lower(plainText(text))

function wordRune(rune: string): boolean {
  if (
    /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]$/u.test(
      rune,
    )
  )
    return false
  return /^[\p{L}\p{N}\p{M}_]$/u.test(rune)
}
function containsTerm(text: string, term: string): boolean {
  if (!term) return false
  const runes = Array.from(term)
  for (let offset = 0; offset < text.length;) {
    const index = text.indexOf(term, offset)
    if (index < 0) return false
    const end = index + term.length
    const previous = text.charCodeAt(index - 1)
    const before = text.slice(index - (previous >= 0xdc00 && previous <= 0xdfff ? 2 : 1), index)
    const after = String.fromCodePoint(text.codePointAt(end) ?? 0)
    if ((!wordRune(runes[0]) || !wordRune(before)) && (!wordRune(runes.at(-1)!) || !wordRune(after)))
      return true
    offset = index + (text.codePointAt(index)! > 0xffff ? 2 : 1)
  }
  return false
}

export function termMatcher(text: string): (term: string) => boolean {
  const normalized = glossaryText(text)
  return (term) => containsTerm(normalized, glossaryText(term))
}

export function selectGlossary(
  req: Pick<TranslationRequest, 'cues' | 'context' | 'futureContext' | 'glossary'>,
): Term[] {
  const current = termMatcher(req.cues.map((cue) => cue.text).join(' '))
  const previous = termMatcher(req.context.map((cue) => cue.source).join(' '))
  const future = termMatcher(req.futureContext.map((cue) => cue.text).join(' '))
  const candidates = req.glossary.flatMap((term) => {
    let priority: number
    if (current(term.source)) priority = term.locked ? 0 : 1
    else if (previous(term.source) || future(term.source)) priority = term.locked ? 2 : 3
    else return []
    const normalized: Term = { source: term.source, target: term.target }
    if (term.note) normalized.note = term.note
    if (term.locked) normalized.locked = true
    return [{ term: normalized, priority, length: Array.from(glossaryText(term.source)).length }]
  })
  candidates.sort((a, b) => a.priority - b.priority || b.length - a.length)
  const selected: Term[] = []
  let used = 2
  for (const { term } of candidates) {
    const cost = Array.from(JSON.stringify([term])).length - 1
    if (used + cost <= glossaryCharacterBudget) {
      selected.push(term)
      used += cost
    }
  }
  return selected
}
