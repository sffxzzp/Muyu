import { test, expect, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const controlURL = 'http://127.0.0.1:19091/control'
const artifacts = path.resolve('../artifacts')

async function profile(page: Page, model = 'original-model', key = 'original-test-key') {
  await page.getByRole('button', { name: 'API 配置', exact: true }).click()
  await page.getByLabel('API Base URL', { exact: true }).fill('http://127.0.0.1:19091/v1')
  await page.getByLabel('模型名称', { exact: true }).fill(model)
  await page.getByLabel('API Key', { exact: true }).fill(key)
  await page.getByLabel('在此浏览器记住 API Key').check()
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

async function create(page: Page, name: string, rpm = 600) {
  await page.getByRole('button', { name: '字幕翻译', exact: true }).click()
  const content = Array.from(
    { length: 4 },
    (_, i) =>
      `${i + 1}\n00:00:${String(i * 2).padStart(2, '0')},000 --> 00:00:${String(i * 2 + 1).padStart(2, '0')},800\nProject Aurora continues in ${name}, cue ${i + 1}.\n`,
  ).join('\n')
  await page
    .getByLabel('上传字幕文件')
    .setInputFiles({ name: `${name}.srt`, mimeType: 'text/plain', buffer: Buffer.from(content) })
  await expect(page.getByText(`${name}.srt`, { exact: true })).toBeVisible()
  await page.getByLabel('目标块大小', { exact: true }).fill('1')
  await page.getByLabel('分块条数上限', { exact: true }).fill('1')
  await page.getByLabel('每分钟请求数 RPM', { exact: true }).fill(String(rpm))
  await page.getByLabel('背景设定', { exact: true }).fill(name)
  await page.getByRole('button', { name: '保存任务，稍后翻译' }).click()
  await expect(page.getByRole('heading', { name: `${name}.srt`, exact: true })).toBeVisible()
  return page.url().split('/').pop()!
}

async function gate(page: Page) {
  const pending: { name: string; release: () => void }[] = []
  // Playwright routing skips CORS preflight. Explicitly fail the direct route
  // when this helper is holding forwarded responses for queue assertions.
  await page.route('http://127.0.0.1:19091/v1/chat/completions', (route) => route.abort('failed'))
  await page.route('**/api/relay', async (route) => {
    const response = await route.fetch()
    await new Promise<void>((release) =>
      pending.push({
        name: JSON.parse(route.request().postDataJSON().payload.messages[1].content).background,
        release,
      }),
    )
    await route.fulfill({ response })
  })
  return {
    wait: async (name: string) => {
      await expect.poll(() => pending.some((request) => request.name === name)).toBe(true)
    },
    release: async (name: string) => {
      await expect.poll(() => pending.some((request) => request.name === name)).toBe(true)
      const index = pending.findIndex((request) => request.name === name)
      pending.splice(index, 1)[0].release()
    },
  }
}

async function stored(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('muyu.workspace.v1')!))
}
async function taskList(page: Page) {
  await page.getByRole('button', { name: /^任务记录/ }).click()
}

test.beforeEach(async ({ request }) => {
  await request.post(controlURL, { data: { reset: true, failFrom: 0, delayMs: 30, malformedAt: 0 } })
  await mkdir(artifacts, { recursive: true })
})

test('one task runs, the rest queue in order, and unrelated tools remain usable', async ({
  page,
  request,
}) => {
  const responses = await gate(page)
  await page.goto('/')
  await profile(page)
  const a = await create(page, '课程 A')
  await page.getByRole('button', { name: '开始翻译', exact: true }).click()
  await responses.wait('课程 A')
  const b = await create(page, '课程 B')
  await page.getByRole('button', { name: '加入队列', exact: true }).click()
  await expect(page.locator('.current-step')).toContainText('排队中')
  const c = await create(page, '课程 C')
  await page.getByRole('button', { name: '加入队列', exact: true }).click()
  await expect(page.locator('.current-step')).toContainText('排队中')
  await expect(page.getByRole('button', { name: 'API 配置', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: '导入任务备份', exact: true })).toBeEnabled()
  await taskList(page)
  await expect(page.locator('.queue-bar')).toContainText('1 运行 / 2 排队')
  expect((await (await request.get(controlURL)).json()).calls).toHaveLength(1)
  await expect(page.locator('.toast-message')).not.toBeVisible()
  await page.screenshot({ path: path.join(artifacts, 'tasks-queue-desktop.png'), fullPage: true })
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await page.getByRole('button', { name: 'Switch to dark mode' }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('.sidebar')).not.toBeInViewport()
  await expect(page.locator('.queue-bar')).toContainText('1 running / 2 queued')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({
    path: path.join(artifacts, 'tasks-queue-dark-en-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await page.setViewportSize({ width: 1440, height: 1024 })
  await page.getByRole('button', { name: '简体中文', exact: true }).click()
  await page.getByRole('button', { name: '暂停 课程 C.srt', exact: true }).click()
  await expect
    .poll(async () => (await stored(page)).jobs.find((job: any) => job.id === c).status)
    .toBe('paused')
  expect((await stored(page)).jobs.find((job: any) => job.id === c).requests).toBe(0)
  await page.getByRole('button', { name: '将 课程 C.srt 加入队列' }).click()
  await expect(page.locator('.queue-bar')).toContainText('1 运行 / 2 排队')
  await page.getByRole('button', { name: '暂停 课程 A.srt', exact: true }).click()
  await responses.release('课程 A')
  await responses.wait('课程 B')
  await expect
    .poll(async () => (await stored(page)).jobs.find((job: any) => job.id === a).status)
    .toBe('paused')
  const runs = await page.evaluate(() => JSON.parse(localStorage.getItem('muyu.runner.v2')!).runs)
  expect(runs[b].phase).toBe('requesting')
  expect(runs[c].phase).toBe('queued')
  expect((await stored(page)).jobs.find((job: any) => job.id === b).status).toBe('paused')

  // Importing a duplicate creates a new task without changing the running task or queue.
  const state = await stored(page)
  const backup = { kind: 'muyu-backup', version: 1, jobs: [state.jobs.find((job: any) => job.id === a)] }
  await page.getByLabel('导入任务备份文件', { exact: true }).setInputFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  })
  await expect(page.locator('.task-table-row')).toHaveCount(4)
  await page.getByRole('button', { name: '暂停 课程 B.srt', exact: true }).click()
  await responses.release('课程 B')
  await responses.wait('课程 C')
  await page.getByRole('button', { name: '暂停 课程 C.srt', exact: true }).click()
  await responses.release('课程 C')
  await expect(page.locator('.queue-bar')).toContainText('0 运行 / 0 排队')
  expect(
    (await stored(page)).jobs
      .filter((job: any) => [a, b, c].includes(job.id))
      .map((job: any) => job.completedChunks),
  ).toEqual([1, 1, 1])
  expect(
    (await (await request.get(controlURL)).json()).calls.map((call: any) => call.data.background),
  ).toEqual(['课程 A', '课程 B', '课程 C'])
})

test('two tabs share a serial queue and RPM while preserving both checkpoints', async ({
  page,
  context,
  request,
}) => {
  const firstResponses = await gate(page)
  await page.goto('/')
  await profile(page)
  const a = await create(page, '跨页 A', 20)
  const b = await create(page, '跨页 B', 120)
  await page.evaluate((id) => {
    location.hash = `/task/${id}`
  }, a)
  await page.getByRole('button', { name: '开始翻译', exact: true }).click()
  await firstResponses.wait('跨页 A')
  const second = await context.newPage()
  const secondResponses = await gate(second)
  await second.goto(`/#/task/${b}`)
  await second.getByRole('button', { name: '加入队列', exact: true }).click()
  await expect(second.locator('.current-step')).toContainText('排队中')
  expect((await (await request.get(controlURL)).json()).calls).toHaveLength(1)
  await taskList(second)
  await expect(second.locator('.queue-bar')).toContainText('1 运行 / 1 排队')
  await second.getByRole('button', { name: '暂停 跨页 A.srt', exact: true }).click()
  await expect(page.locator('.current-step')).toContainText('本块完成并保存后暂停')
  await firstResponses.release('跨页 A')
  await secondResponses.wait('跨页 B')
  const calls = (await (await request.get(controlURL)).json()).calls
  expect(calls).toHaveLength(2)
  expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(2900)
  await page.getByRole('button', { name: '加入队列', exact: true }).click()
  await expect(page.locator('.current-step')).toContainText('排队中')
  await taskList(page)
  await page.getByRole('button', { name: '暂停 跨页 B.srt', exact: true }).click()
  await secondResponses.release('跨页 B')
  await firstResponses.wait('跨页 A')
  expect((await (await request.get(controlURL)).json()).calls.at(-1).data.cues_to_translate[0].id).toBe(2)
  await page.getByRole('button', { name: '暂停 跨页 A.srt', exact: true }).click()
  await firstResponses.release('跨页 A')
  await expect(page.locator('.queue-bar')).toContainText('0 运行 / 0 排队')
  expect((await stored(page)).jobs.map((job: any) => job.status)).toEqual(['paused', 'paused'])
  await page.reload()
  const saved = await stored(page)
  for (const job of saved.jobs) {
    const count = job.id === a ? 2 : 1
    expect(job.completedChunks).toBe(count)
    expect(Object.keys(job.translations)).toHaveLength(count)
    expect(job.glossaryHistory).toHaveLength(count)
  }
  await second.close()
  await page.evaluate((id) => {
    location.hash = `/task/${id}`
  }, a)
  await page.getByRole('button', { name: '继续翻译', exact: true }).click()
  await firstResponses.wait('跨页 A')
  await page.getByRole('button', { name: '暂停翻译', exact: true }).click()
  await firstResponses.release('跨页 A')
  await expect
    .poll(async () => (await stored(page)).jobs.find((job: any) => job.id === a).completedChunks)
    .toBe(3)
  const resumed = (await (await request.get(controlURL)).json()).calls.at(-1)
  expect(resumed.data.cues_to_translate[0].id).toBe(3)
  expect((await stored(page)).jobs.find((job: any) => job.id === b).completedChunks).toBe(1)
})

test('changing default API settings preserves queued and running credentials across task handoffs', async ({
  page,
  request,
}) => {
  const responses = await gate(page)
  await page.goto('/')
  await profile(page)
  const originalId = await create(page, '旧配置', 60)
  await page.getByRole('button', { name: '开始翻译', exact: true }).click()
  await responses.wait('旧配置')
  await profile(page, 'new-model', 'new-test-key')
  await create(page, '新配置', 60)
  await page.getByRole('button', { name: '加入队列', exact: true }).click()
  await expect(page.locator('.current-step')).toContainText('排队中')
  await responses.release('旧配置')
  await responses.wait('旧配置')
  const calls = (await (await request.get(controlURL)).json()).calls
  const original = calls.filter((call: any) => call.data.background === '旧配置')
  expect(calls).toHaveLength(2)
  expect(original).toHaveLength(2)
  expect(original.every((call: any) => call.model === 'original-model')).toBe(true)
  expect(original[0].credentialFingerprint).toBe(original[1].credentialFingerprint)
  await taskList(page)
  await page.getByRole('button', { name: '暂停 旧配置.srt', exact: true }).click()
  await responses.release('旧配置')
  await responses.wait('新配置')
  const newer = (await (await request.get(controlURL)).json()).calls.at(-1)
  expect(newer.model).toBe('new-model')
  expect(newer.credentialFingerprint).not.toBe(original[0].credentialFingerprint)
  await page.evaluate((id) => {
    location.hash = `/task/${id}`
  }, originalId)
  await page.getByRole('button', { name: '加入队列', exact: true }).click()
  await expect(page.locator('.current-step')).toContainText('排队中')
  await taskList(page)
  await page.getByRole('button', { name: '暂停 新配置.srt', exact: true }).click()
  await responses.release('新配置')
  await responses.wait('旧配置')
  const resumed = (await (await request.get(controlURL)).json()).calls.at(-1)
  expect(resumed.credentialFingerprint).toBe(original[0].credentialFingerprint)
  expect(resumed.data.cues_to_translate[0].id).toBe(3)
  await page.getByRole('button', { name: '暂停 旧配置.srt', exact: true }).click()
  await responses.release('旧配置')
  await expect(page.locator('.queue-bar')).toContainText('0 运行 / 0 排队')
})

test('independent browser workspaces can translate at the same time on one server', async ({
  page,
  browser,
  request,
}) => {
  const firstResponses = await gate(page)
  await page.goto('/')
  await profile(page)
  await create(page, '使用者 A')
  const otherContext = await browser.newContext({ locale: 'zh-CN', colorScheme: 'light' })
  try {
    const other = await otherContext.newPage()
    const otherResponses = await gate(other)
    await other.goto('http://127.0.0.1:19090/')
    await profile(other, 'second-user-model', 'second-user-key')
    await create(other, '使用者 B')
    // Keep the first provider call in flight long enough to prove the server
    // accepts the second user's request before the first has completed.
    await request.post(controlURL, { data: { delayMs: 6000 } })
    await Promise.all([
      page.getByRole('button', { name: '开始翻译', exact: true }).click(),
      other.getByRole('button', { name: '开始翻译', exact: true }).click(),
    ])
    await expect
      .poll(async () => (await (await request.get(controlURL)).json()).calls.length, {
        timeout: 4000,
      })
      .toBe(2)
    const calls = (await (await request.get(controlURL)).json()).calls
    expect(calls[1].at - calls[0].at).toBeLessThan(6000)
    expect(calls.map((call: any) => call.data.background).sort()).toEqual(['使用者 A', '使用者 B'])
    await Promise.all([taskList(page), taskList(other)])
    await expect(page.locator('.queue-bar')).toContainText('1 运行 / 0 排队')
    await expect(other.locator('.queue-bar')).toContainText('1 运行 / 0 排队')
    expect((await stored(page)).jobs.map((job: any) => job.name)).toEqual(['使用者 A.srt'])
    expect((await stored(other)).jobs.map((job: any) => job.name)).toEqual(['使用者 B.srt'])
    await page.getByRole('button', { name: '暂停 使用者 A.srt', exact: true }).click()
    await other.getByRole('button', { name: '暂停 使用者 B.srt', exact: true }).click()
    await Promise.all([firstResponses.wait('使用者 A'), otherResponses.wait('使用者 B')])
    await Promise.all([firstResponses.release('使用者 A'), otherResponses.release('使用者 B')])
    await expect(page.locator('.queue-bar')).toContainText('0 运行 / 0 排队')
    await expect(other.locator('.queue-bar')).toContainText('0 运行 / 0 排队')
    expect((await stored(page)).jobs[0].completedChunks).toBe(1)
    expect((await stored(other)).jobs[0].completedChunks).toBe(1)
  } finally {
    await otherContext.close()
  }
})
