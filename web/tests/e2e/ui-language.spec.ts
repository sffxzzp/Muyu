import { test, expect, type Page } from '@playwright/test'

async function checkStartup(page: Page, expected: string) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const pattern = '**/assets/*.js'
  await page.route(pattern, async (route) => {
    await gate
    await route.continue()
  })
  try {
    await page.goto('/', { waitUntil: 'commit' })
    // The deployment default or saved preference must apply before Vue mounts.
    await expect(page.locator('html')).toHaveAttribute('lang', expected)
    await expect(page).toHaveTitle(expected === 'en' ? 'MUYU · Subtitle Studio' : '幕语 · 字幕翻译工作台')
    await expect(page.locator('#app')).toBeEmpty()
  } finally {
    release()
  }
  await expect(
    page.getByRole('heading', {
      name: expected === 'en' ? 'Every line, just right.' : '让每一句，都恰如其分。',
    }),
  ).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', expected)
  await page.unroute(pattern)
}

for (const config of [
  { name: 'English fallback', port: 19092, language: 'en', browser: 'zh-CN', chosen: 'zh-CN' },
  { name: 'Chinese environment override', port: 19090, language: 'zh-CN', browser: 'en-US', chosen: 'en' },
]) {
  test.describe(config.name, () => {
    test.use({ baseURL: `http://127.0.0.1:${config.port}`, locale: config.browser })

    test('applies before first paint, honors saved choices and restores the deployment default after clearing', async ({
      page,
      context,
    }) => {
      await checkStartup(page, config.language)
      expect(await page.evaluate(() => localStorage.getItem('muyu.ui.v1'))).toBeNull()
      expect(await page.evaluate(() => window.__MUYU_CONFIG__?.defaultUILanguage)).toBe(config.language)
      await page
        .getByRole('button', { name: config.chosen === 'en' ? 'English' : '简体中文', exact: true })
        .click()
      await expect(page.locator('html')).toHaveAttribute('lang', config.chosen)
      const other = await context.newPage()
      await checkStartup(other, config.chosen)
      await page.reload()
      await expect(page.locator('html')).toHaveAttribute('lang', config.chosen)
      await page.evaluate(() => localStorage.removeItem('muyu.ui.v1'))
      await expect(other.locator('html')).toHaveAttribute('lang', config.language)
      await checkStartup(page, config.language)
    })
  })
}

test('structured notifications and dynamic file errors change language without reinterpreting user text', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: '试用示例字幕' }).click()
  await expect(page.locator('.toast-message')).toContainText('已识别 12 条字幕')
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await expect(page.locator('.toast-message')).toContainText('Loaded 12 subtitle cues')
  await page.getByLabel('Upload subtitle file', { exact: true }).setInputFiles({
    name: 'invalid.srt',
    mimeType: 'text/plain',
    buffer: Buffer.from('1\ninvalid --> 00:00:04,000\nHello.\n'),
  })
  await expect(page.locator('.notice')).toContainText(
    'Cue 1 has an invalid start time: Invalid subtitle timestamp format',
  )
  await page.getByRole('button', { name: '简体中文', exact: true }).click()
  await expect(page.locator('.notice')).toContainText('第 1 条字幕开始时间无效')
})
