import { locale } from './preferences'
import en from './locales/en.json'
import { formatMessage, message, type Message, type MessageKey, type MessageParams } from './messages'
export type { MessageKey } from './messages'

export function t(key: MessageKey, params?: MessageParams): string {
  return localize(message(key, params))
}

// Parameters are data, not text to guess or translate. Only nested keyed
// messages (such as a retry's cause) are translated recursively.
export function localize(value: Message): string {
  return formatMessage(value, locale.value === 'en' ? en : undefined)
}
