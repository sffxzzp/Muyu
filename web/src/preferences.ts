import { computed, ref, watch } from 'vue'

export type Locale = 'zh-CN' | 'en'
export type Theme = 'light' | 'dark'
export interface UIPreferences {
  locale?: Locale
  theme?: Theme
}
declare global {
  interface Window {
    __MUYU_CONFIG__?: { defaultUILanguage?: string }
  }
}
export const UI_STORAGE_KEY = 'muyu.ui.v1'

export function parseUIPreferences(raw: string | null): UIPreferences {
  try {
    const value = JSON.parse(raw ?? '{}')
    return {
      locale: value?.locale === 'en' || value?.locale === 'zh-CN' ? value.locale : undefined,
      theme: value?.theme === 'light' || value?.theme === 'dark' ? value.theme : undefined,
    }
  } catch {
    return {}
  }
}

function readPreferences(): UIPreferences {
  try {
    return parseUIPreferences(localStorage.getItem(UI_STORAGE_KEY))
  } catch {
    return {}
  }
}

const preferences = ref(readPreferences())
const colorScheme =
  typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : undefined
const systemDark = ref(colorScheme?.matches ?? false)
const defaultLocale: Locale =
  typeof window !== 'undefined' && window.__MUYU_CONFIG__?.defaultUILanguage === 'zh-CN' ? 'zh-CN' : 'en'
export const locale = computed(() => preferences.value.locale ?? defaultLocale)
export const theme = computed(() => preferences.value.theme ?? (systemDark.value ? 'dark' : 'light'))
export const preferencesSaved = ref(true)

function savePreferences() {
  try {
    localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(preferences.value))
    preferencesSaved.value = true
  } catch {
    // The current view can still change if browser storage is unavailable.
    preferencesSaved.value = false
  }
}
export function setLocale(value: Locale) {
  preferences.value = { ...preferences.value, locale: value }
  savePreferences()
}
export function toggleTheme() {
  preferences.value = { ...preferences.value, theme: theme.value === 'dark' ? 'light' : 'dark' }
  savePreferences()
}
export function clearUIPreferences() {
  localStorage.removeItem(UI_STORAGE_KEY)
  preferences.value = {}
  preferencesSaved.value = true
}

if (typeof window !== 'undefined') {
  colorScheme?.addEventListener('change', (event) => {
    systemDark.value = event.matches
  })
  window.addEventListener('storage', (event) => {
    if (event.key === UI_STORAGE_KEY || event.key === null) preferences.value = readPreferences()
  })
  watch(
    [theme, locale],
    ([appearance, language]) => {
      document.documentElement.dataset.theme = appearance
      document.documentElement.lang = language
      document.documentElement.style.colorScheme = appearance
      document.title = language === 'en' ? 'MUYU · Subtitle Studio' : '幕语 · 字幕翻译工作台'
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', appearance === 'dark' ? '#111827' : '#f8f9fc')
    },
    { immediate: true, flush: 'sync' },
  )
}
