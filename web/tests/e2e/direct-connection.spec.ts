import { test, expect, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import path from 'node:path'

const controlURL = 'http://127.0.0.1:19091/control'
const directURL = 'http://127.0.0.1:19093/v1' // Deliberately absent from API_HOSTS.
const testKey = 'browser-direct-test-only-key'

async function prepare(page: Page, base = directURL) {
  await page.goto('/')
  await page.getByRole('button', { name: 'API 配置', exact: true }).click()
  await page.getByLabel('API Base URL', { exact: true }).fill(base)
  await page.getByLabel('模型名称', { exact: true }).fill('mock-translator')
  await page.getByLabel('API Key', { exact: true }).fill(testKey)
  await expect(page.getByRole('dialog')).toContainText('直连时 Key 仅发送给模型接口')
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await page.getByRole('button', { name: '试用示例字幕' }).click()
  await page.getByLabel('目标块大小', { exact: true }).fill('4')
  await page.getByLabel('分块条数上限', { exact: true }).fill('4')
  await page.getByLabel('每分钟请求数 RPM', { exact: true }).fill('600')
  await page.getByTestId('seed-glossary').click()
  await page.getByLabel(/预设术语|Seed glossary/, { exact: true }).fill('cash flow = 现金流\nUnrelated Order = 其他骑士团')
  await page.locator('.advanced-settings summary').click()
  await page.getByLabel('失败重试次数', { exact: true }).fill('0')
}

test.beforeEach(async ({ request }) => {
  await request.post(controlURL, { data: { reset: true, failFrom: 0, delayMs: 650, malformedAt: 0 } })
})

test('a browser translates through an API outside the server allowlist without sending keys or model requests to this server', async ({
  page,
  request,
  context,
}) => {
  const forwarded: string[] = []
  page.on('request', (request) => {
    if (request.url().endsWith('/api/relay')) forwarded.push(request.url())
  })
  await context.addCookies([
    { name: 'provider-cookie', value: 'must-not-send', domain: '127.0.0.1', path: '/' },
  ])
  await prepare(page)
  await page.getByRole('button', { name: '开始翻译', exact: true }).click()
  await expect(page.locator('.connection-route')).toHaveText('浏览器直连')
  await expect(page.getByRole('heading', { name: '已完成 4 / 12 条字幕' })).toBeVisible()
  await page.screenshot({ path: path.resolve('../artifacts/browser-direct-desktop.png') })
  const first = page.getByRole('textbox', { name: '第 1 条译文', exact: true })
  await first.fill('浏览器直连期间的人工修正。')
  await first.blur()
  await expect(page.getByRole('heading', { name: '每一句，都已抵达。' })).toBeVisible()
  expect(forwarded).toEqual([])
  const { calls } = await (await request.get(controlURL)).json()
  expect(calls).toHaveLength(3)
  expect(calls.every((call: any) => call.transport === 'direct' && !call.cookie && !call.referer)).toBe(true)
  expect(
    calls.every(
      (call: any) =>
        call.credentialFingerprint ===
        createHash('sha256')
          .update('Bearer ' + testKey)
          .digest('hex'),
    ),
  ).toBe(true)
  expect(calls[0].data.established_glossary).toEqual([
    { source: 'cash flow', target: '现金流', locked: true },
  ])
  expect(calls[1].data.previous_context[0].source).toContain('not just about')
  expect(calls[1].data.established_style_notes).toContain('当前片段 1')
  const job = await page.evaluate(() => JSON.parse(localStorage.getItem('muyu.workspace.v1')!).jobs[0])
  expect(job).toMatchObject({ status: 'completed', completedChunks: 3, requests: 3 })
  expect(job.translations[1]).toBe('浏览器直连期间的人工修正。')
  expect(job.glossary).toContainEqual(
    expect.objectContaining({ source: 'Unrelated Order', target: '其他骑士团', locked: true }),
  )
  expect(JSON.stringify(await page.evaluate(() => ({ ...localStorage })))).not.toContain(testKey)
})

test('a CORS refusal falls back once and the mobile progress panel shows the forwarding route', async ({
  page,
  request,
}) => {
  // Use desktop navigation to configure the task, then check the mobile route.
  await page.setViewportSize({ width: 1440, height: 1024 })
  await prepare(page, 'http://127.0.0.1:19091/v1')
  await page.getByRole('button', { name: '开始翻译', exact: true }).click()
  await expect(page.locator('.connection-route')).toHaveText('服务器转发')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click()
  await expect(page.locator('.connection-route')).toHaveText('Server forwarding')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: path.resolve('../artifacts/browser-fallback-mobile.png') })
  await expect(page.getByRole('heading', { name: 'Every line, translated.' })).toBeVisible()
  const { calls, preflights } = await (await request.get(controlURL)).json()
  expect(preflights).toHaveLength(1)
  expect(calls.map((call: any) => call.transport)).toEqual(['server', 'server', 'server'])
  const job = await page.evaluate(() => JSON.parse(localStorage.getItem('muyu.workspace.v1')!).jobs[0])
  expect(job.requests).toBe(4)
  expect(
    job.events.filter(
      (event: any) => event.message.key === '浏览器直连因跨域或网络问题失败，将尝试服务器转发',
    ),
  ).toHaveLength(1)
})

for (const status of [401, 429]) {
  test(`a readable direct HTTP ${status} does not trigger forwarding`, async ({ page, request }) => {
    await request.post(controlURL, {
      data: { failFrom: 1, failureStatus: status, retryAfterSeconds: 3, delayMs: 10 },
    })
    let forwarded = 0
    page.on('request', (request) => {
      if (request.url().endsWith('/api/relay')) forwarded++
    })
    await prepare(page)
    await page.getByRole('button', { name: '开始翻译', exact: true }).click()
    await expect(page.locator('.job-error')).toContainText(`HTTP ${status}`)
    expect(forwarded).toBe(0)
    const { calls } = await (await request.get(controlURL)).json()
    expect(calls).toHaveLength(1)
    const job = await page.evaluate(() => JSON.parse(localStorage.getItem('muyu.workspace.v1')!).jobs[0])
    expect(job.requests).toBe(1)
    expect(job.completedChunks).toBe(0)
    expect(job.error.params).toEqual({ 0: status })
    expect(JSON.stringify(job)).not.toContain('mock failure body')
  })
}

test('resuming a paused fallback run tries the browser again and preserves its checkpoint', async ({
  page,
  request,
}) => {
  await request.post(controlURL, { data: { delayMs: 1200 } })
  await prepare(page, 'http://127.0.0.1:19091/v1')
  await page.getByRole('button', { name: '开始翻译', exact: true }).click()
  await expect.poll(async () => (await (await request.get(controlURL)).json()).calls.length).toBe(1)
  await page.getByRole('button', { name: '暂停翻译', exact: true }).click()
  await expect(page.getByRole('button', { name: '继续翻译', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '已完成 4 / 12 条字幕' })).toBeVisible()
  await request.post(controlURL, { data: { cors: true, delayMs: 500 } })
  await page.getByRole('button', { name: '继续翻译', exact: true }).click()
  await expect(page.locator('.connection-route')).toHaveText('浏览器直连')
  await expect(page.getByRole('heading', { name: '每一句，都已抵达。' })).toBeVisible()
  const { calls } = await (await request.get(controlURL)).json()
  expect(calls.map((call: any) => call.transport)).toEqual(['server', 'direct', 'direct'])
  expect(calls.map((call: any) => call.data.cues_to_translate[0].id)).toEqual([1, 5, 9])
  expect(calls[1].systemPromptHash).toBe(calls[0].systemPromptHash)
  expect(calls[1].data.previous_context[0].target).toBe('重要的不只是你赚了多少钱。')
})
