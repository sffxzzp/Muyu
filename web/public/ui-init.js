// Apply saved preferences or server defaults before the stylesheet paints. This external script
// also works with the server's Content Security Policy (no inline scripts).
;(function () {
  let value = {}
  try {
    value = JSON.parse(localStorage.getItem('muyu.ui.v1') || '{}') || {}
  } catch {}
  const language =
    value.locale === 'en' || value.locale === 'zh-CN'
      ? value.locale
      : window.__MUYU_CONFIG__?.defaultUILanguage === 'zh-CN'
        ? 'zh-CN'
        : 'en'
  const theme =
    value.theme === 'dark' || value.theme === 'light'
      ? value.theme
      : matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
  document.documentElement.dataset.theme = theme
  document.documentElement.lang = language
  document.documentElement.style.colorScheme = theme
  document.title = language === 'en' ? 'MUYU · Subtitle Studio' : '幕语 · 字幕翻译工作台'
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#111827' : '#f8f9fc')
})()
