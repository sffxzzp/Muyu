import { plainText } from './text'
import type { Chunk, Cue, Settings } from './types'

const locales: Record<string, string> = {
  简体中文: 'zh-Hans',
  繁體中文: 'zh-Hant',
  中文: 'zh',
  chinese: 'zh',
  english: 'en',
  英语: 'en',
  日本語: 'ja',
  日语: 'ja',
  japanese: 'ja',
  한국어: 'ko',
  韩语: 'ko',
  korean: 'ko',
  français: 'fr',
  法语: 'fr',
  french: 'fr',
  deutsch: 'de',
  德语: 'de',
  german: 'de',
  español: 'es',
  西班牙语: 'es',
  spanish: 'es',
  português: 'pt',
  葡萄牙语: 'pt',
  portuguese: 'pt',
  italiano: 'it',
  意大利语: 'it',
  italian: 'it',
  русский: 'ru',
  俄语: 'ru',
  russian: 'ru',
  العربية: 'ar',
  阿拉伯语: 'ar',
  arabic: 'ar',
  हिन्दी: 'hi',
  印地语: 'hi',
  hindi: 'hi',
  ไทย: 'th',
  泰语: 'th',
  thai: 'th',
  'tiếng việt': 'vi',
  越南语: 'vi',
  vietnamese: 'vi',
  'bahasa indonesia': 'id',
  印度尼西亚语: 'id',
  indonesian: 'id',
  türkçe: 'tr',
  土耳其语: 'tr',
  turkish: 'tr',
  فارسی: 'fa',
  波斯语: 'fa',
  persian: 'fa',
  اردو: 'ur',
  乌尔都语: 'ur',
  urdu: 'ur',
}

function segmenter(sourceLanguage: string): Intl.Segmenter | undefined {
  if (typeof Intl.Segmenter !== 'function') return
  const source = sourceLanguage.trim().toLowerCase()
  // "auto" is model-side language detection, not Intl language detection.
  // Unknown/mixed-language input uses the Unicode rules, never the UI locale.
  if (source === 'auto') return
  try {
    const locale = locales[source] ?? Intl.getCanonicalLocales(source)[0]
    if (locale && Intl.Segmenter.supportedLocalesOf([locale]).length)
      return new Intl.Segmenter(locale, { granularity: 'sentence' })
  } catch {
    // Free-form language names and older browsers use the same local fallback.
  }
}

// ICU can still split e.g. "Dr. Smith". These common abbreviation/initial
// guards supplement multilingual sentence rules; they do not claim semantic
// understanding or an exhaustive dictionary for any language.
const abbreviations = new Set([
  'dr',
  'prof',
  'mr',
  'mrs',
  'ms',
  'sr',
  'sra',
  'srta',
  'jr',
  'st',
  'vs',
  'e.g',
  'i.e',
  'etc',
  'z.b',
  'bzw',
  'usw',
  'hr',
  'fr',
  'mme',
  'mlle',
  'm',
])
const closingMarks = /[\p{Pe}\p{Pf}"'’”\s]+$/u

function periodContinues(text: string, next: string): boolean {
  if (!next || !text.endsWith('.')) return false
  const word = /([\p{L}.]+)\.$/u.exec(text)?.[1]?.toLowerCase()
  return (
    (!!word && abbreviations.has(word)) ||
    /(?:^|\s)(?:\p{Lu}\.){1,4}$/u.test(text) ||
    (/\d\.$/u.test(text) && /^\d/u.test(next)) ||
    /\.{2,}$/.test(text)
  )
}

function sentenceBoundaries(texts: string[], language: string): boolean[] {
  const icu = segmenter(language)
  const ends = new Set<number>()
  if (icu) {
    // Segment continuous text: treating every cue as a separate input would
    // incorrectly make every fragment a sentence because input-end is a break.
    const offsets = new Map<number, number>()
    let offset = 0
    texts.forEach((text, index) => {
      offset += text.length
      offsets.set(offset, index)
      offset++
    })
    const joined = texts.join(' ')
    for (const part of icu.segment(joined)) {
      const end = part.index + part.segment.trimEnd().length
      const cue = offsets.get(end)
      if (cue !== undefined && end < joined.length) ends.add(cue)
    }
  }
  return texts.map((text, i) => {
    const ending = text.replace(closingMarks, '')
    if (periodContinues(ending, texts[i + 1] ?? '')) return false
    const terminal = /\p{Sentence_Terminal}$/u.test(ending)
    // Full stops are ambiguous (abbreviations, decimals); when a source locale
    // is known, use ICU's continuous-text decision for these boundaries.
    return ends.has(i) || (terminal && (!icu || !/[.．]$/u.test(ending)))
  })
}

export function chunkCues(cues: Cue[], settings: Settings): Chunk[] {
  const chunks: Chunk[] = []
  const sentences = sentenceBoundaries(
    cues.map((cue) => plainText(cue.text)),
    settings.sourceLanguage,
  )
  const lengths = cues.map((cue) => [...cue.text].length)
  const target = settings.targetChunkSize
  const minimum = Math.max(1, Math.ceil(target * 0.75))
  let start = 0
  while (start < cues.length) {
    let hardEnd = start,
      characters = 0
    while (hardEnd < cues.length && hardEnd - start < settings.maxChunkSize) {
      if (hardEnd > start && characters + lengths[hardEnd] > settings.maxChunkCharacters) break
      characters += lengths[hardEnd++]
      // An oversized single cue remains intact, in a block of its own.
      if (characters >= settings.maxChunkCharacters) break
    }
    let end = hardEnd,
      best = -Infinity
    if (!(hardEnd === cues.length && hardEnd - start <= target)) {
      for (let candidate = start + minimum; candidate <= hardEnd; candidate++) {
        const gap = candidate < cues.length ? cues[candidate].start - cues[candidate - 1].end : 0
        const quality = (sentences[candidate - 1] ? 3 : 0) + (gap >= 3000 ? 4 : gap >= 1500 ? 2 : 0)
        if (!quality && candidate !== cues.length) continue
        const tail = cues.length - candidate
        const tailPenalty = tail > 0 && tail < minimum ? (2 * (minimum - tail)) / minimum : 0
        const score =
          quality -
          (3 * Math.abs(candidate - start - target)) / target -
          tailPenalty +
          (candidate === cues.length ? 1 : 0)
        if (score > best) {
          best = score
          end = candidate
        }
      }
    }
    chunks.push({ start, end })
    start = end
  }
  return chunks
}
