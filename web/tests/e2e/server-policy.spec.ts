import { test, expect, type Page } from '@playwright/test'

const controlURL = 'http://127.0.0.1:19091/control'

async function prepareSample(page: Page, baseUrl = 'http://127.0.0.1:19091/v1') {
  await page.goto('/')
  await page.getByRole('button', { name: 'API 配置', exact: true }).click()
  await page.getByLabel('API Base URL', { exact: true }).fill(baseUrl)
  await page.getByLabel('模型名称', { exact: true }).fill('mock-translator')
  await page.getByLabel('API Key', { exact: true }).fill('local-policy-test-key')
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await page.getByRole('button', { name: '试用示例字幕' }).click()
  await page.getByLabel('目标块大小', { exact: true }).fill('4')
  await page.getByLabel('分块条数上限', { exact: true }).fill('4')
  await page.getByLabel('每分钟请求数 RPM', { exact: true }).fill('600')
  await page.locator('.advanced-settings summary').click()
  await page.getByLabel('失败重试次数', { exact: true }).fill('0')
}

test.beforeEach(async ({ request }) => {
  await request.post(controlURL, { data: { reset: true, failFrom: 0, delayMs: 30, malformedAt: 0 } })
})

test('server throttling waits and resumes with zero model retries while preserving edits and progress', async ({
  page,
  request,
}) => {
  let refusals = 0
  await page.route('http://127.0.0.1:19091/v1/chat/completions', (route) => route.abort('failed'))
  await page.route('**/api/relay', async (route) => {
    if (
      JSON.parse(route.request().postDataJSON().payload.messages[1].content).cues_to_translate[0].id === 5 &&
      refusals++ < 3
    ) {
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        headers: { 'Retry-After': '1' },
        body: JSON.stringify({
          error: '服务端请求过于频繁或并发已满，请稍后重试',
          retryable: true,
          rateLimited: true,
          retryAfter: 1,
        }),
      })
      return
    }
    await route.continue()
  })
  await prepareSample(page)
  await page.getByRole('button', { name: '开始翻译', exact: true }).click()
  await expect.poll(() => refusals).toBeGreaterThan(0)
  await expect(page.getByRole('heading', { name: '已完成 4 / 12 条字幕' })).toBeVisible()
  await expect(page.locator('.job-error')).toHaveCount(0)
  const correction = '限流等待期间保存的人工修正。'
  const first = page.getByRole('textbox', { name: '第 1 条译文', exact: true })
  await first.fill(correction)
  await expect(page.getByRole('heading', { name: '每一句，都已抵达。' })).toBeVisible()
  await expect(first).toHaveValue(correction)
  await expect
    .poll(async () => JSON.parse(await page.evaluate(() => localStorage.getItem('muyu.workspace.v1')!)).jobs[0].translations[1])
    .toBe(correction)
  const { calls } = await (await request.get(controlURL)).json()
  expect(calls.map((call: any) => call.data.cues_to_translate[0].id)).toEqual([1, 5, 9])
  const job = await page.evaluate(() => JSON.parse(localStorage.getItem('muyu.workspace.v1')!).jobs[0])
  expect(job.settings.maxRetries).toBe(0)
  expect(job.completedChunks).toBe(3)
  expect(job.translations[1]).toBe(correction)
  expect(job.error).toBe('')
})

test('a failed direct connection cannot bypass the server allowlist and its error follows the interface language', async ({
  page,
  request,
}) => {
  await page.route('https://blocked.example.invalid/**', (route) => route.abort('failed'))
  await prepareSample(page, 'https://blocked.example.invalid/v1')
  await page.getByRole('button', { name: '开始翻译', exact: true }).click()
  await expect(page.locator('.job-error')).toContainText('此 API 地址不在服务器转发白名单中')
  const job = await page.evaluate(() => JSON.parse(localStorage.getItem('muyu.workspace.v1')!).jobs[0])
  expect(job.completedChunks).toBe(0)
  expect(job.requests).toBe(2)
  expect((await (await request.get(controlURL)).json()).calls).toHaveLength(0)
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await expect(page.locator('.job-error')).toContainText(
    'This API endpoint is not on the server forwarding allowlist.',
  )
})
