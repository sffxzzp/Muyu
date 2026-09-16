import en from './locales/en.json'

export type MessageKey = keyof typeof en
export type MessageParams = Record<string, string | number | KeyedMessage>
export interface KeyedMessage {
  key: string
  params?: MessageParams
}
export type Message = string | KeyedMessage

export function message(key: MessageKey, params?: MessageParams): KeyedMessage {
  return params ? { key, params } : { key }
}
export function asMessage(value: Message): Message {
  return typeof value === 'string' && Object.hasOwn(en, value) ? message(value as MessageKey) : value
}
export function formatMessage(value: Message, translations?: Record<string, string>): string {
  const item = asMessage(value)
  if (typeof item === 'string') return item
  const template = translations && Object.hasOwn(translations, item.key) ? translations[item.key] : item.key
  return template.replace(/\{(\w+)\}/g, (placeholder, key) => {
    const param = item.params && Object.hasOwn(item.params, key) ? item.params[key] : undefined
    return param === undefined
      ? placeholder
      : typeof param === 'object'
        ? formatMessage(param, translations)
        : String(param)
  })
}

export class MessageError extends Error {
  readonly detail: Message
  constructor(value: Message) {
    super(formatMessage(value))
    this.detail = asMessage(value)
  }
}
export function errorMessage(error: unknown): Message {
  return error instanceof MessageError
    ? error.detail
    : asMessage(error instanceof Error ? error.message : '操作失败，请重试')
}

export function isMessage(value: unknown, depth = 0): value is Message {
  if (typeof value === 'string') return value.length <= 5000
  if (depth > 3 || !value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (Object.keys(item).some((key) => key !== 'key' && key !== 'params')) return false
  // Historical message keys remain readable even after the UI dictionary changes.
  if (typeof item.key !== 'string' || !item.key || item.key.length > 5000) return false
  if (item.params === undefined) return true
  if (!item.params || typeof item.params !== 'object' || Array.isArray(item.params)) return false
  const params = Object.entries(item.params)
  return (
    params.length <= 10 &&
    params.every(
      ([key, param]) =>
        key.length <= 64 &&
        (typeof param === 'number' ? Number.isFinite(param) : isMessage(param, depth + 1)),
    ) &&
    JSON.stringify(value).length <= 5000
  )
}
