import { decodeHTML } from 'entities'

const encoder = new TextEncoder()
export const byteLength = (text: string) => encoder.encode(text).length
export const inlineTags = /<[^>\n]+>/g
export const trimSpace = (text: string) => text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')

// Context-independent case matching, including the dotted-I alias used by
// existing glossaries. Forms, imports and model results use the same key.
export const lower = (text: string) =>
  Array.from(text, (rune) => (rune === 'İ' ? 'i' : rune.toLowerCase())).join('')
export const termKey = (source: string) => lower(trimSpace(source))

export function plainText(text: string): string {
  return decodeHTML(text.replace(/<[^>]*>/g, ''))
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\p{White_Space}+/gu, ' ')
    .trim()
}

export function cleanText(text: string): string {
  return text.replace(/\r\n?/g, '\n').split('\n').map(trimSpace).filter(Boolean).join('\n')
}
