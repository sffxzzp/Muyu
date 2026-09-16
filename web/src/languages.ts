import { t } from './i18n'

export const languages = [
  ['简体中文', '简体中文'],
  ['繁體中文', '繁體中文'],
  ['English', '英语'],
  ['日本語', '日语'],
  ['한국어', '韩语'],
  ['Français', '法语'],
  ['Deutsch', '德语'],
  ['Español', '西班牙语'],
  ['Português', '葡萄牙语'],
  ['Italiano', '意大利语'],
  ['Русский', '俄语'],
  ['العربية', '阿拉伯语'],
  ['हिन्दी', '印地语'],
  ['ไทย', '泰语'],
  ['Tiếng Việt', '越南语'],
  ['Bahasa Indonesia', '印度尼西亚语'],
  ['Türkçe', '土耳其语'],
] as const

export function languageName(value: string): string {
  if (value === 'auto') return t('自动检测')
  const language = languages.find(([key]) => key === value)
  return language ? t(language[1]) : value
}

export function languageValue(label: string): string {
  if (label === 'auto' || label === t('自动检测')) return 'auto'
  return (
    languages.find(([value, name]) => label === value || label === name || label === t(name))?.[0] ?? label
  )
}
