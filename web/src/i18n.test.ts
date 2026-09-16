import { migrateMessage } from './legacyMessages'
import { message } from './messages'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import en from './locales/en.json'
import { localize, t } from './i18n'
import { clearUIPreferences, locale, parseUIPreferences, setLocale, UI_STORAGE_KEY } from './preferences'
import { languageName, languageValue } from './languages'
import { defaultSettings } from './types'

beforeEach(() => {
  const records = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => {
      records.set(key, value)
    },
    removeItem: (key: string) => {
      records.delete(key)
    },
  })
})
afterEach(() => {
  setLocale('zh-CN')
  vi.unstubAllGlobals()
})

describe('interface localization', () => {
  it('preserves every interpolation in both languages', () => {
    for (const [source, translation] of Object.entries(en)) {
      expect(translation.trim(), source).not.toBe('')
      expect([...translation.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort(), source).toEqual(
        [...source.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort(),
      )
    }
    setLocale('en')
    expect(t('打开 {0}', { 0: '课程 $& {1}.srt' })).toBe('Open 课程 $& {1}.srt')
  })

  it('renders saved logs and nested provider errors in the selected language', () => {
    const legacy = '第 2 块：模型接口返回 HTTP 401，请检查 API Key 和模型权限；准备第 1 次重试'
    const migrated = migrateMessage(legacy)
    setLocale('en')
    expect(localize(migrated)).toBe(
      'Chunk 2 · Retry 1 scheduled: The model endpoint returned HTTP 401. Check your API key and model permissions.',
    )
    expect(localize(migrateMessage('第 1 / 3 块已完成，4 条译文与术语库通过校验'))).toBe(
      'Chunk 1 / 3 completed. 4 translations and the glossary passed validation.',
    )
    expect(localize('Custom provider error 42')).toBe('Custom provider error 42')
    expect(localize(message('术语「{0}」沿用已有译法「{1}」', { 0: '英语', 1: '原文' }))).toBe(
      'Term “英语” keeps its established translation “原文”.',
    )
    setLocale('zh-CN')
    expect(localize(migrateMessage('Completed 4 / 12 cues'))).toBe('已完成 4 / 12 条字幕')
    expect(localize(migrated)).toBe(legacy)
    const nested = message('第 {0} 块：{1}；准备第 {2} 次重试', {
      0: 2,
      1: message('模型接口返回 HTTP {0}，请检查 API Key 和模型权限', { 0: 401 }),
      2: 1,
    })
    expect(localize(nested)).toBe(legacy)
    setLocale('en')
    expect(localize(nested)).toBe(localize(migrated))
    // Rendered prose is never reverse-parsed in the current display path.
    expect(localize(legacy)).toBe(legacy)
  })

  it('localizes language labels while keeping the model language values stable', () => {
    setLocale('en')
    expect(languageName(defaultSettings.targetLanguage)).toBe('Simplified Chinese')
    expect(languageValue('Simplified Chinese')).toBe(defaultSettings.targetLanguage)
    expect(languageValue('Auto detect')).toBe('auto')
    expect(languageValue('Klingon')).toBe('Klingon')
    expect(defaultSettings.targetLanguage).toBe('简体中文')
  })

  it('recovers malformed preferences and clears only its own storage key', () => {
    expect(parseUIPreferences('{broken')).toEqual({})
    expect(parseUIPreferences('{"theme":"unknown","locale":"cn"}')).toEqual({
      theme: undefined,
      locale: undefined,
    })
    expect(parseUIPreferences('{"theme":"dark","locale":"en"}')).toEqual({ theme: 'dark', locale: 'en' })
    localStorage.setItem('another-site-key', 'keep')
    setLocale('en')
    expect(JSON.parse(localStorage.getItem(UI_STORAGE_KEY)!)).toEqual({ locale: 'en' })
    clearUIPreferences()
    expect(localStorage.getItem(UI_STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem('another-site-key')).toBe('keep')
    expect(locale.value).toBe('en')
  })
})
