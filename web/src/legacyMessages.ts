import en from './locales/en.json'
import { message, type Message, type MessageKey } from './messages'

function matchers() {
  const entries = Object.entries(en)
  const englishKeys = new Map(entries.map(([key, value]) => [value, key]))
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = entries
    .flatMap(([key, english]) =>
      [key, english]
        .filter((text) => /\{\w+\}/.test(text))
        .map((text) => {
          const names: string[] = []
          let start = 0,
            pattern = '^'
          for (const match of text.matchAll(/\{(\w+)\}/g)) {
            pattern += escape(text.slice(start, match.index)) + '([\\s\\S]+?)'
            names.push(match[1])
            start = match.index! + match[0].length
          }
          return {
            key: key as MessageKey,
            names,
            regex: new RegExp(pattern + escape(text.slice(start)) + '$'),
          }
        }),
    )
    .sort((a, b) => b.key.replace(/\{\w+\}/g, '').length - a.key.replace(/\{\w+\}/g, '').length)

  return { englishKeys, patterns }
}
let cached: ReturnType<typeof matchers> | undefined

// Used only when loading version 1 records. Current messages already carry keys
// and parameters; arbitrary provider text is preserved verbatim.
export function migrateMessage(text: string, depth = 0): Message {
  const { englishKeys, patterns } = (cached ??= matchers())
  if (Object.hasOwn(en, text)) return message(text as MessageKey)
  const source = englishKeys.get(text)
  if (source) return message(source as MessageKey)
  if (depth > 2) return text
  for (const { key, names, regex } of patterns) {
    const match = regex.exec(text)
    if (match) {
      const nestedError =
        key === '第 {0} 块：{1}；准备第 {2} 次重试' || key === '第 {0} 条字幕开始时间无效：{1}'
      return message(
        key,
        Object.fromEntries(
          names.map((name, i) => [
            name,
            nestedError && name === '1' ? migrateMessage(match[i + 1], depth + 1) : match[i + 1],
          ]),
        ),
      )
    }
  }
  return text
}
