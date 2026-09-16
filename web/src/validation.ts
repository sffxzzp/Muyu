import { cleanText, byteLength, trimSpace } from './text'

// Text limits use UTF-8 bytes throughout import, editing and model requests.
// HTML maxlength may provide a loose input bound; these checks are authoritative.
export const limits = {
  source: 16000,
  translation: 32000,
  termSource: 300,
  termTarget: 500,
  termNote: 500,
  style: 6000,
  background: 24000,
  language: 100,
  model: 200,
  baseUrl: 1500,
  apiKey: 4096,
  newTerms: 40,
} as const

export function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && byteLength(value) <= max && !value.includes('\0')
}

export function normalizeTranslation(text: string): string {
  const value = cleanText(text)
  if (!value.trim()) throw new Error('译文不能为空')
  if (!boundedText(value, limits.translation))
    throw new Error('单条译文不能超过 32000 字节，且不能包含空字符')
  return value
}

export function normalizeMemory(field: 'source' | 'target' | 'note' | 'style', text: string): string {
  const value = trimSpace(text)
  const max =
    field === 'style'
      ? limits.style
      : field === 'source'
        ? limits.termSource
        : field === 'target'
          ? limits.termTarget
          : limits.termNote
  if ((field === 'source' || field === 'target') && !value.trim()) throw new Error('术语原文和译文不能为空')
  if (!boundedText(value, max))
    throw new Error(
      field === 'style'
        ? '风格备忘不能超过 6000 字节，且不能包含空字符'
        : '术语原文、译文或备注过长，或包含空字符',
    )
  return value
}
