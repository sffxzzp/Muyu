import { test, expect, type Page } from '@playwright/test'
import { readFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const artifacts = path.resolve('../artifacts')
const controlURL = 'http://127.0.0.1:19091/control'
const key = 'test-key-local-only'

async function setupProfile(page: Page) {
  await page.getByRole('button', { name: 'API 配置', exact: true }).click()
  await page.getByRole('textbox', { name: 'API Base URL', exact: true }).fill('http://127.0.0.1:19091/v1')
  await page.getByRole('textbox', { name: '模型名称', exact: true }).fill('mock-translator')
  await page.getByLabel('API Key', { exact: true }).fill(key)
  await page.getByRole('checkbox', { name: '在此浏览器记住 API Key' }).check()
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

async function prepareSample(page: Page) {
  await page.getByRole('button', { name: '试用示例字幕' }).click()
  await expect(page.getByText('cash-flow-intro.srt', { exact: true })).toBeVisible()
  await page.getByLabel('目标块大小', { exact: true }).fill('4')
  await page.getByLabel('分块条数上限', { exact: true }).fill('4')
  await page.getByLabel('每分钟请求数 RPM', { exact: true }).fill('600')
  await page.getByLabel('背景设定', { exact: true }).fill('这是财务教育讲座，面向初学者，使用亲切的口语。')
  await page.getByTestId('seed-glossary').click()
  await page.getByLabel(/预设术语|Seed glossary/, { exact: true }).fill('cash flow = 现金流')
}

const savedJob = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('muyu.workspace.v1')!).jobs[0])

async function saveTask(page: Page) {
  await page.getByRole('button', { name: '保存任务，稍后翻译', exact: true }).click()
  await expect(page).toHaveURL(/#\/task\//)
  await expect.poll(async () => (await savedJob(page))?.id).toBeTruthy()
}

async function controlTranslationResponses(page: Page) {
  const pending: (() => void)[] = []
  // These cases control forwarded responses. Routing otherwise skips the
  // browser's preflight and would let a CORS-blocked model POST reach the stub.
  await page.route('http://127.0.0.1:19091/v1/chat/completions', (route) => route.abort('failed'))
  await page.route('**/api/relay', async (route) => {
    const response = await route.fetch()
    await new Promise<void>((resolve) => pending.push(resolve))
    await route.fulfill({ response })
  })
  return async () => {
    await expect.poll(() => pending.length).toBe(1)
    pending.shift()!()
  }
}

test.beforeEach(async ({ request }) => {
  await request.post(controlURL, { data: { reset: true, failFrom: 0, delayMs: 30, malformedAt: 0 } })
  await mkdir(artifacts, { recursive: true })
})

test('translate, refresh, resume, edit, export, clear and restore a real browser task', async ({
  page,
  request,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '让每一句，都恰如其分。' })).toBeVisible()
  await page.screenshot({ path: path.join(artifacts, 'home-desktop.png'), fullPage: true })
  await setupProfile(page)
  await prepareSample(page)
  await request.post(controlURL, { data: { failFrom: 2 } })
  await page.getByRole('button', { name: '开始翻译', exact: true }).click()
  await expect(page).toHaveURL(/#\/task\//)
  await expect(page.getByRole('heading', { name: '已完成 4 / 12 条字幕' })).toBeVisible()
  await expect(page.locator('.job-error')).toContainText('HTTP 401')
  await page.reload()
  await expect(page.getByRole('heading', { name: '已完成 4 / 12 条字幕' })).toBeVisible()
  await request.post(controlURL, { data: { failFrom: 0 } })
  await page.getByRole('button', { name: '继续翻译', exact: true }).click()
  await expect(page.getByRole('heading', { name: '每一句，都已抵达。' })).toBeVisible()
  const { calls } = await (await request.get(controlURL)).json()
  expect(calls.map((call: any) => call.data.cues_to_translate.map((cue: any) => cue.id))).toEqual([
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
  ])
  expect(calls[2].data.established_glossary.some((term: any) => term.source === 'small business')).toBe(true)
  expect(calls[2].data.established_glossary.some((term: any) => term.source === 'cash flow')).toBe(true)
  expect(calls[2].data.established_style_notes).toContain('当前片段 1')
  expect(calls[2].data.background).toContain('财务教育')
  expect(calls[2].data.previous_context[0].target).toBeTruthy()
  expect(calls[0].data.previous_context).toEqual([])
  expect(calls[0].data.future_context.map((cue: any) => cue.id)).toEqual([5, 6, 7])
  expect(calls[2].data.future_context.map((cue: any) => cue.id)).toEqual([9, 10, 11])
  expect(calls[3].data.future_context).toEqual([])
  const firstCorrection = '欢迎回来。今天，一起理解现金流。'
  await page.getByRole('textbox', { name: '第 1 条译文', exact: true }).fill(firstCorrection)
  await expect.poll(async () => (await savedJob(page)).translations[1]).toBe(firstCorrection)
  await page.getByRole('heading', { name: '每一句，都已抵达。' }).click()
  await page.reload()
  await expect(page.getByRole('textbox', { name: '第 1 条译文', exact: true })).toHaveValue(
    firstCorrection,
  )
  await page.screenshot({ path: path.join(artifacts, 'translation-desktop.png'), fullPage: true })
  await page.getByRole('button', { name: '导出字幕', exact: true }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载字幕', exact: true }).click()
  const subtitleDownload = await downloadPromise
  const srt = await readFile((await subtitleDownload.path())!, 'utf-8')
  expect(srt.match(/ --> /g) ?? []).toHaveLength(12)
  expect(srt).toContain('00:00:01,000 --> 00:00:04,200\nWelcome back.')
  expect(srt).toContain('欢迎回来。今天，一起理解现金流。')
  await page.getByTestId('glossary-tab').click()
  await expect(page.getByTestId('glossary-usage')).toHaveText('累计 4 条 · 上轮携带 2 条')
  await page.getByTestId('glossary-usage').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(artifacts, 'glossary-carry-cn.png') })
  await page.getByRole('textbox', { name: '新增术语原文' }).fill('asset')
  await page.getByRole('textbox', { name: '新增术语译文' }).fill('资产')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await expect(page.getByTestId('term-5-source')).toHaveValue('asset')
  const backupPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '备份', exact: true }).click()
  const backupDownload = await backupPromise
  const backup = await readFile((await backupDownload.path())!, 'utf-8')
  expect(backup).not.toContain(key)
  expect(JSON.parse(backup).jobs[0].completedChunks).toBe(3)
  await page.evaluate(() => localStorage.setItem('unrelated-site-key', 'keep-me'))
  await page.getByRole('button', { name: '清空本地数据', exact: true }).click()
  await page.getByRole('button', { name: '清空全部数据', exact: true }).click()
  await expect(page.getByRole('heading', { name: '让每一句，都恰如其分。' })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('unrelated-site-key'))).toBe('keep-me')
  expect(await page.evaluate(() => localStorage.getItem('muyu.workspace.v1'))).not.toContain(key)
  await page
    .getByLabel('导入任务备份文件', { exact: true })
    .setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(backup) })
  await expect(page).toHaveURL(/#\/tasks/)
  await expect(page.getByRole('button', { name: /cash-flow-intro.srt/ }).first()).toBeVisible()
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('muyu.workspace.v1')!))
  expect(stored.jobs[0].translations[1]).toContain('一起理解')
  expect(stored.jobs[0].glossary).toHaveLength(5)
  expect(errors).toEqual([])
})

test('a glossary beyond 400 terms stays editable, bounded in prompts and complete after refresh and export', async ({
  page,
  request,
}) => {
  await page.goto('/')
  await setupProfile(page)
  await prepareSample(page)
  await saveTask(page)
  const original = await page.evaluate(() => {
    const workspace = JSON.parse(localStorage.getItem('muyu.workspace.v1')!)
    const job = workspace.jobs[0]
    job.glossary.push(
      ...Array.from({ length: 1000 }, (_, i) => ({
        source: `Archive record ${i}`,
        target: `档案记录 ${i}`,
        note: 'Unrelated background reference. '.repeat(5),
        locked: false,
      })),
      { source: 'positive cash flow', target: '正向现金流' },
      { source: 'financial literacy', target: '财商' },
    )
    localStorage.setItem('muyu.workspace.v1', JSON.stringify(workspace))
    return job.glossary
  })
  await page.reload()
  await request.post(controlURL, { data: { failFrom: 2 } })
  await page.getByRole('button', { name: '开始翻译', exact: true }).click()
  await expect(page.locator('.job-error')).toContainText('HTTP 401')
  await expect(page.getByRole('heading', { name: '已完成 4 / 12 条字幕' })).toBeVisible()
  await page.reload()
  await request.post(controlURL, { data: { failFrom: 0 } })
  await page.getByRole('button', { name: '继续翻译', exact: true }).click()
  await expect(page.getByRole('heading', { name: '每一句，都已抵达。' })).toBeVisible()
  const { calls } = await (await request.get(controlURL)).json()
  expect(calls).toHaveLength(4)
  expect(calls[0].data.established_glossary.some((term: any) => term.source === 'positive cash flow')).toBe(
    true,
  )
  expect(calls[0].data.established_glossary.some((term: any) => term.source === 'financial literacy')).toBe(
    false,
  )
  expect(calls[3].data.established_glossary.some((term: any) => term.source === 'financial literacy')).toBe(
    true,
  )
  for (const call of calls) {
    expect(call.data.established_glossary.length).toBeLessThan(10)
    expect(call.data.established_glossary.some((term: any) => term.source.startsWith('Archive record'))).toBe(
      false,
    )
  }
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('muyu.workspace.v1')!).jobs[0])
  expect(saved.glossary).toHaveLength(original.length + 1)
  for (const term of original) {
    const kept = saved.glossary.find((item: any) => item.source === term.source)
    expect(kept?.target).toBe(term.target)
    expect(kept?.note ?? '').toBe(term.note ?? '')
    expect(!!kept?.locked).toBe(!!term.locked)
  }
  expect(saved.lastGlossarySent).toBe(calls[3].data.established_glossary.length)
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '备份', exact: true }).click()
  const backup = JSON.parse(await readFile((await (await downloadPromise).path())!, 'utf-8'))
  expect(backup.jobs[0].glossary).toHaveLength(saved.glossary.length)
  await page.reload()
  const restored = await savedJob(page)
  expect(restored.glossary).toHaveLength(saved.glossary.length)
  expect(restored.lastGlossarySent).toBe(saved.lastGlossarySent)
})

test('can skip the glossary so terms are not sent or extracted', async ({ page, request }) => {
  await page.goto('/')
  await setupProfile(page)
  await prepareSample(page)
  await page.getByTestId('use-glossary').uncheck()
  await expect(page.getByTestId('seed-glossary')).toHaveCount(0)
  await page.getByRole('button', { name: '开始翻译', exact: true }).click()
  await expect(page.getByRole('heading', { name: '每一句，都已抵达。' })).toBeVisible()
  const { calls } = await (await request.get(controlURL)).json()
  expect(calls.length).toBeGreaterThan(0)
  expect(calls.every((call: { data: { established_glossary: unknown[] } }) => call.data.established_glossary.length === 0)).toBe(true)
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('muyu.workspace.v1')!).jobs[0])
  expect(saved.settings.useGlossary).toBe(false)
  expect(saved.glossary).toEqual([])
  expect(saved.lastGlossarySent).toBe(0)
  await page.getByTestId('glossary-tab').click()
  await expect(page.locator('.glossary-disabled')).toContainText('这个任务未启用术语库')
})

test('legacy checkpoint keeps its saved blocks and zero lookahead when resuming', async ({
  page,
  request,
}) => {
  await page.goto('/')
  await setupProfile(page)
  await prepareSample(page)
  await saveTask(page)
  const original = await page.evaluate(() => {
    const workspace = JSON.parse(localStorage.getItem('muyu.workspace.v1')!)
    const job = workspace.jobs[0]
    workspace.version = 1
    workspace.nextRequestAt = 0
    delete job.revision
    delete job.settings.futureContextSize
    delete job.lastGlossarySent
    job.settings.maxChunkSize = 5
    job.chunks = [
      { start: 0, end: 3 },
      { start: 3, end: 7 },
      { start: 7, end: 12 },
    ]
    job.completedChunks = 1
    job.translations = { 1: '原有译文一', 2: '原有译文二', 3: '原有译文三' }
    job.status = 'paused'
    localStorage.setItem('muyu.workspace.v1', JSON.stringify(workspace))
    return { chunks: job.chunks, translations: job.translations }
  })
  await page.reload()
  await expect(page.getByRole('heading', { name: '已完成 3 / 12 条字幕' })).toBeVisible()
  await page.getByRole('button', { name: '调整参数', exact: true }).click()
  await page.getByRole('dialog').locator('.advanced-settings summary').click()
  await expect(page.getByLabel('后文条数', { exact: true })).toHaveValue('0')
  await expect(page.getByLabel('前文条数', { exact: true })).toHaveValue('3')
  await page.getByRole('button', { name: '保存参数', exact: true }).click()
  await page.getByRole('button', { name: '继续翻译', exact: true }).click()
  await expect(page.getByRole('heading', { name: '每一句，都已抵达。' })).toBeVisible()
  const { calls } = await (await request.get(controlURL)).json()
  expect(calls.map((call: any) => call.data.cues_to_translate.map((cue: any) => cue.id))).toEqual([
    [4, 5, 6, 7],
    [8, 9, 10, 11, 12],
  ])
  expect(calls.every((call: any) => call.data.future_context.length === 0)).toBe(true)
  expect(calls[0].data.previous_context[0].target).toBe('原有译文一')
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('muyu.workspace.v1')!).jobs[0])
  expect(saved.chunks).toEqual(original.chunks)
  expect(saved.translations).toMatchObject(original.translations)
})

test('a second tab cannot duplicate a running task and graceful pause preserves the checkpoint', async ({
  page,
  context,
  request,
}) => {
  const releaseResponse = await controlTranslationResponses(page)
  await page.goto('/')
  await setupProfile(page)
  await prepareSample(page)
  await page.getByRole('button', { name: '开始翻译', exact: true }).click()
  await expect(page.getByRole('button', { name: '暂停翻译', exact: true })).toBeVisible()
  const second = await context.newPage()
  await second.goto(page.url())
  await expect(
    second.getByText('其他标签页有活动任务。这里会同步进度，也可以暂停任务或将其他任务加入队列。'),
  ).toBeVisible()
  await expect(second.getByRole('button', { name: /^(开始|继续)翻译$/ })).toHaveCount(0)
  await expect.poll(async () => (await (await request.get(controlURL)).json()).calls.length).toBe(1)
  await second.getByRole('button', { name: '暂停翻译', exact: true }).click()
  await expect(page.locator('.current-step')).toContainText('本块完成并保存后暂停')
  await releaseResponse()
  await expect(page.getByRole('button', { name: '继续翻译', exact: true })).toBeVisible()
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('muyu.workspace.v1')!))
  expect(stored.jobs[0].completedChunks).toBe(1)
  expect(stored.jobs[0].status).toBe('paused')
  expect(stored.jobs[0].styleNotes).toContain('当前片段 1')
  expect((await (await request.get(controlURL)).json()).calls).toHaveLength(1)
  await second.close()
})

for (const mobile of [false, true]) {
  test(`live comparison keeps progress visible on ${mobile ? 'mobile' : 'desktop'}`, async ({
    page,
    request,
  }) => {
    const finishChunk = await controlTranslationResponses(page)
    await page.goto('/')
    await setupProfile(page)
    await prepareSample(page)
    if (mobile) await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: '开始翻译', exact: true }).click()
    await expect(page).toHaveURL(/#\/task\//)
    const progress = page.getByRole('progressbar', { name: '字幕翻译完成进度' })
    await expect(progress).toHaveAttribute('aria-valuenow', '0')
    await expect(page.locator('.cue-row.processing')).toHaveCount(4)
    await expect(page.locator('[data-cue-id="1"]')).toContainText('正在翻译')
    await finishChunk()
    await expect(progress).toHaveAttribute('aria-valuenow', '33')
    await expect(page.getByRole('heading', { name: '已完成 4 / 12 条字幕' })).toBeVisible()
    await expect(page.locator('.cue-row.translated')).toHaveCount(4)
    await expect(page.getByRole('textbox', { name: '第 4 条译文', exact: true })).toHaveValue(
      '试着把自己的财务当作一家小公司。',
    )
    await expect(page.locator('[data-cue-id="5"]')).toHaveClass(/processing/)
    await expect(page.locator('[data-cue-id="9"]')).toContainText('等待翻译')

    // Scroll the completed context and current block into the same viewport.
    await page.evaluate((compact) => {
      const panel = document.querySelector('.progress-card')!.getBoundingClientRect()
      const anchor = document
        .querySelector(compact ? '[data-cue-id="4"]' : '.cue-table')!
        .getBoundingClientRect()
      const offset = compact ? 60 + panel.height + 24 : 84
      window.scrollTo(0, Math.max(0, scrollY + anchor.top - offset))
    }, mobile)
    const panel = (await page.getByRole('complementary', { name: '翻译进度' }).boundingBox())!
    expect(panel.y).toBeGreaterThanOrEqual(mobile ? 60 : 72)
    expect(panel.y).toBeLessThanOrEqual(100)
    const activeRow = (await page.locator('[data-cue-id="5"]').boundingBox())!
    expect(activeRow.y).toBeGreaterThan(mobile ? panel.y + panel.height : 72)
    expect(activeRow.y).toBeLessThan(mobile ? 700 : 900)
    if (!mobile) {
      const comparison = (await page.locator('.detail-card').boundingBox())!
      expect(panel.x).toBeGreaterThan(comparison.x + comparison.width)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(page.locator('.toast-message')).toHaveCount(0)
    await page.screenshot({
      path: path.join(artifacts, `translation-live-${mobile ? 'mobile' : 'desktop'}.png`),
    })

    if (mobile) await page.getByRole('button', { name: '打开导航', exact: true }).click()
    await page.getByRole('button', { name: '双语合并', exact: true }).click()
    await expect(page.getByRole('heading', { name: '两种语言，同一段故事。' })).toBeVisible()
    await page.getByRole('button', { name: '查看正在翻译的任务', exact: true }).click()
    await expect(page).toHaveURL(/#\/task\//)
    await expect(page.locator('[data-cue-id="5"]')).toHaveClass(/processing/)
    await expect(page.getByRole('checkbox', { name: '跟随翻译进度' })).toBeChecked()
    await page.getByRole('button', { name: '暂停翻译', exact: true }).click()
    await expect(page.locator('.current-step')).toContainText('本块完成并保存后暂停')
    await finishChunk()
    await expect(page.getByRole('button', { name: '继续翻译', exact: true })).toBeVisible()
    await expect(progress).toHaveAttribute('aria-valuenow', '67')
    await expect(page.locator('.cue-row.processing')).toHaveCount(0)
    expect((await (await request.get(controlURL)).json()).calls).toHaveLength(2)
  })
}

test('follow preference survives scrolling and navigation while new progress still follows across pages', async ({
  page,
}) => {
  await page.clock.install()
  const finishChunk = await controlTranslationResponses(page)
  const time = (seconds: number) =>
    `00:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')},000`
  const srt = Array.from(
    { length: 120 },
    (_, i) => `${i + 1}\n${time(i * 2)} --> ${time(i * 2 + 1)}\nSentence ${i + 1}.\n`,
  ).join('\n')
  await page.goto('/')
  await setupProfile(page)
  await page.getByLabel('上传字幕文件', { exact: true }).setInputFiles({
    name: 'long-lecture.srt',
    mimeType: 'text/plain',
    buffer: Buffer.from(srt),
  })
  await expect(page.getByText('long-lecture.srt', { exact: true })).toBeVisible()
  await page.getByLabel('目标块大小', { exact: true }).fill('20')
  await page.getByLabel('分块条数上限', { exact: true }).fill('20')
  await page.getByLabel('每分钟请求数 RPM', { exact: true }).fill('600')
  await page.getByRole('button', { name: '开始翻译', exact: true }).click()
  await finishChunk()
  await expect(page.getByRole('heading', { name: '已完成 20 / 120 条字幕' })).toBeVisible()
  await finishChunk()
  await expect(page.getByRole('heading', { name: '已完成 40 / 120 条字幕' })).toBeVisible()
  await expect(page.locator('[data-cue-id="41"]')).toBeInViewport()
  await expect(page.locator('.pagination > div > span')).toHaveText('2 / 3')

  // Freeze the short browsing grace period so an arriving response is deterministic.
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  await page.mouse.wheel(0, -200)
  await expect(page.getByRole('checkbox', { name: '跟随翻译进度' })).toBeChecked()
  await page.locator('.cue-table').dispatchEvent('touchmove')
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
  await page.keyboard.press('PageUp')
  await expect(page.getByRole('checkbox', { name: '跟随翻译进度' })).toBeChecked()
  await page.getByRole('button', { name: '上一页', exact: true }).click()
  await expect(page.locator('.pagination > div > span')).toHaveText('1 / 3')
  await finishChunk()
  await expect(page.getByRole('heading', { name: '已完成 60 / 120 条字幕' })).toBeVisible()
  await expect(page.locator('.pagination > div > span')).toHaveText('1 / 3')
  await expect(page.locator('[data-cue-id="1"]')).toBeInViewport()
  await expect(page.getByRole('checkbox', { name: '跟随翻译进度' })).toBeChecked()
  await page.clock.runFor(1600)
  await finishChunk()
  await expect(page.getByRole('heading', { name: '已完成 80 / 120 条字幕' })).toBeVisible()
  await expect(page.locator('.pagination > div > span')).toHaveText('3 / 3')
  await expect(page.locator('[data-cue-id="81"]')).toBeInViewport()
  await page.clock.resume()

  await page.getByRole('textbox', { name: '搜索字幕', exact: true }).fill('Sentence 2.')
  await expect(page.locator('.cue-row')).toHaveCount(1)
  await expect(page.locator('[data-cue-id="2"]')).toBeVisible()
  await finishChunk()
  await expect(page.getByRole('heading', { name: '已完成 100 / 120 条字幕' })).toBeVisible()
  await expect(page.locator('.cue-row')).toHaveCount(1)
  await expect(page.getByRole('checkbox', { name: '跟随翻译进度' })).toBeChecked()
  await page.getByRole('checkbox', { name: '跟随翻译进度' }).uncheck()
  await page.getByRole('button', { name: '定位当前块', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '搜索字幕', exact: true })).toBeEmpty()
  await expect(page.locator('.pagination > div > span')).toHaveText('3 / 3')
  await expect(page.locator('[data-cue-id="101"]')).toBeInViewport()
  await expect(page.getByRole('checkbox', { name: '跟随翻译进度' })).not.toBeChecked()
  await page.getByRole('button', { name: '双语合并', exact: true }).click()
  await page.getByRole('button', { name: '查看正在翻译的任务', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: '跟随翻译进度' })).not.toBeChecked()
  await finishChunk()
  await expect(page.getByRole('heading', { name: '每一句，都已抵达。' })).toBeVisible()
  await expect(page.getByRole('progressbar', { name: '字幕翻译完成进度' })).toHaveAttribute(
    'aria-valuenow',
    '100',
  )
})

test('RPM waiting shows the real completed count and can be paused immediately', async ({
  page,
  request,
}) => {
  // Start directly so the one-minute wait follows a completed block.
  await request.post(controlURL, { data: { cors: true } })
  await page.goto('/')
  await setupProfile(page)
  await prepareSample(page)
  await page.getByLabel('每分钟请求数 RPM', { exact: true }).fill('1')
  await page.getByRole('button', { name: '开始翻译', exact: true }).click()
  await expect(page.getByRole('heading', { name: '已完成 4 / 12 条字幕' })).toBeVisible()
  await expect(page.locator('.current-step')).toContainText('等待下一轮请求')
  await expect(page.locator('.wait-countdown')).toContainText(/\d+ 秒后继续/)
  await expect(page.locator('[data-cue-id="5"] .pending-cue')).toContainText('等待下一轮请求')
  await page.getByRole('textbox', { name: '第 4 条译文', exact: true }).fill('等待下一轮请求时进行的人工修正')
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('muyu.workspace.v1')!).jobs[0].translations[4]),
    )
    .toBe('等待下一轮请求时进行的人工修正')
  await expect(page.locator('.current-step')).toContainText('等待下一轮请求')
  await page.getByRole('button', { name: '暂停翻译', exact: true }).click()
  await expect(page.getByRole('button', { name: '继续翻译', exact: true })).toBeVisible()
  await expect(page.getByRole('progressbar', { name: '字幕翻译完成进度' })).toHaveAttribute(
    'aria-valuenow',
    '33',
  )
  expect((await (await request.get(controlURL)).json()).calls).toHaveLength(1)
  await page.reload()
  await expect(page.getByRole('textbox', { name: '第 4 条译文', exact: true })).toHaveValue(
    '等待下一轮请求时进行的人工修正',
  )
})

test('VTT metadata survives mixed-format merge and mismatched timelines fail clearly', async ({ page }) => {
  await page.goto('/#/merge')
  const vtt =
    'WEBVTT - Example\n\nSTYLE\n::cue { color: lime; }\n\nscene-1\n00:01.000 --> 00:03.000 align:start\nHello.\n'
  const wrong = '1\n00:00:02,000 --> 00:00:03,000\n你好。\n'
  const srt = '1\n00:00:01,000 --> 00:00:03,000\n你好。\n'
  await page
    .getByLabel('上传原文字幕', { exact: true })
    .setInputFiles({ name: 'original.vtt', mimeType: 'text/vtt', buffer: Buffer.from(vtt) })
  await page
    .getByLabel('上传译文字幕', { exact: true })
    .setInputFiles({ name: 'wrong.srt', mimeType: 'text/plain', buffer: Buffer.from(wrong) })
  await expect(page.locator('.merge-explanation')).toContainText('时间轴不一致')
  await page.getByRole('button', { name: '合并并下载', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('时间轴不一致')
  await page
    .getByLabel('上传译文字幕', { exact: true })
    .setInputFiles({ name: 'translated.srt', mimeType: 'text/plain', buffer: Buffer.from(srt) })
  await expect(page.locator('.merge-explanation')).toContainText('完全对应')
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: '合并并下载', exact: true }).click()
  const content = await readFile((await (await pending).path())!, 'utf-8')
  expect(content).toContain('STYLE\n::cue { color: lime; }')
  expect(content).toContain('scene-1\n00:00:01.000 --> 00:00:03.000 align:start\nHello.\n你好。')
})

test('mobile workspace has no horizontal overflow and navigation works', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '让每一句，都恰如其分。' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: path.join(artifacts, 'home-mobile.png'), fullPage: true })
  await page.getByRole('button', { name: '打开导航', exact: true }).click()
  await page.getByRole('button', { name: '双语合并', exact: true }).click()
  await expect(page.getByRole('heading', { name: '两种语言，同一段故事。' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('display preferences persist, sync between tabs, and leave task data unchanged', async ({
  page,
  context,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await prepareSample(page)
  await page.getByRole('button', { name: '保存任务，稍后翻译', exact: true }).click()
  // Creation commits under a Web Lock before navigating to the saved task.
  await expect(page).toHaveURL(/#\/task\//)
  const before = await page.evaluate(() => localStorage.getItem('muyu.workspace.v1'))
  expect(before).not.toBeNull()
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.getByRole('tab', { name: /Glossary & style/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Completed 0 / 12 cues' })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('muyu.workspace.v1'))).toBe(before)
  await page.reload()
  await expect(page).toHaveTitle('MUYU · Subtitle Studio')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe(
    'rgb(17, 24, 39)',
  )
  await page.getByRole('button', { name: 'Edit settings', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Edit translation settings' })).toBeVisible()
  await expect(page.getByLabel('Target language', { exact: true })).toHaveValue('Simplified Chinese')
  await page.getByRole('dialog').locator('.advanced-settings summary').click()
  await expect(page.getByLabel('Previous context cues', { exact: true })).toHaveValue('3')
  await expect(page.getByLabel('Future context cues', { exact: true })).toHaveValue('3')
  await page.getByLabel('Future context cues', { exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(artifacts, 'context-settings-dark-en.png') })
  await expect(page.getByRole('textbox', { name: 'Edit background context', exact: true })).toHaveValue(
    '这是财务教育讲座，面向初学者，使用亲切的口语。',
  )
  expect(await page.getByRole('dialog').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    'rgb(27, 37, 55)',
  )
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click()

  const second = await context.newPage()
  await second.goto(page.url())
  await expect(second.locator('html')).toHaveAttribute('lang', 'en')
  await expect(second.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('button', { name: '简体中文', exact: true }).click()
  await expect(second.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await page.getByRole('button', { name: '切换为浅色主题', exact: true }).click()
  await expect(second.locator('html')).toHaveAttribute('data-theme', 'light')
  expect(await page.evaluate(() => localStorage.getItem('muyu.workspace.v1'))).toBe(before)
  await page.evaluate(() => localStorage.setItem('unrelated-preference', 'keep'))
  await page.getByRole('button', { name: '清空本地数据', exact: true }).click()
  await page.getByRole('button', { name: '清空全部数据', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('muyu.ui.v1'))).toBeNull()
  expect(await page.evaluate(() => localStorage.getItem('unrelated-preference'))).toBe('keep')
  await second.close()
  expect(errors).toEqual([])
})

test('theme and language can change during translation without restarting the task', async ({
  page,
  request,
}) => {
  const finishChunk = await controlTranslationResponses(page)
  await page.goto('/')
  await setupProfile(page)
  await prepareSample(page)
  await page.getByRole('button', { name: '开始翻译', exact: true }).click()
  await expect(page.locator('.cue-row.processing')).toHaveCount(4)
  await page.getByRole('button', { name: '切换为深色主题', exact: true }).click()
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pause translation', exact: true })).toBeVisible()
  await finishChunk()
  await expect(page.getByRole('heading', { name: 'Completed 4 / 12 cues' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Translation for cue 1', exact: true })).toHaveValue(
    '欢迎回来。今天，我们来聊聊现金流。',
  )
  await expect(page.locator('[data-cue-id="5"] .pending-cue')).toHaveText('Translating')
  await expect(page.locator('.toast-message')).toHaveCount(0)
  await page
    .locator('.cue-table')
    .evaluate((el) => window.scrollTo(0, scrollY + el.getBoundingClientRect().top - 84))
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: path.join(artifacts, 'translation-dark-en.png') })

  await page.getByRole('button', { name: '简体中文', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('.sidebar')).not.toBeInViewport()
  await page.locator('[data-cue-id="4"]').evaluate((el) => {
    const panel = document.querySelector('.progress-card')!.getBoundingClientRect()
    window.scrollTo(0, scrollY + el.getBoundingClientRect().top - 60 - panel.height - 24)
  })
  await expect(page.getByRole('heading', { name: '已完成 4 / 12 条字幕' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: path.join(artifacts, 'translation-dark-cn-mobile.png') })
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await page.getByRole('button', { name: 'Pause translation', exact: true }).click()
  await finishChunk()
  await expect(page.getByRole('button', { name: 'Resume translation', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Activity', exact: true }).click()
  await expect(page.locator('.log-panel')).toContainText('Translation started')
  expect(await page.locator('.log-panel').innerText()).not.toMatch(/[\u3400-\u9fff]/)
  const { calls } = await (await request.get(controlURL)).json()
  expect(calls).toHaveLength(2)
  expect(calls[0].data.background).toBe('这是财务教育讲座，面向初学者，使用亲切的口语。')
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('muyu.workspace.v1')!).jobs[0])
  expect(stored.settings.targetLanguage).toBe('简体中文')
  expect(stored.completedChunks).toBe(2)
  expect(stored.translations[1]).toBe('欢迎回来。今天，我们来聊聊现金流。')
})

test.describe('browser defaults', () => {
  test.use({
    baseURL: 'http://127.0.0.1:19092',
    locale: 'zh-CN',
    colorScheme: 'dark',
    viewport: { width: 390, height: 844 },
  })

  test('defaults to English even in a Chinese browser and follows the system theme until overridden', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByRole('heading', { name: 'Every line, just right.' })).toBeVisible()
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click()
    await page.emulateMedia({ colorScheme: 'light' })
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.getByLabel('Upload subtitle file', { exact: true }).setInputFiles({
      name: 'broken.srt',
      mimeType: 'text/plain',
      buffer: Buffer.from('1\ninvalid timing\nHello.\n'),
    })
    await expect(page.getByRole('alert')).toContainText('Cue 1')
    expect(await page.getByRole('alert').innerText()).not.toMatch(/[\u3400-\u9fff]/)
    await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click()
    for (const width of [320, 390, 760]) {
      await page.setViewportSize({ width, height: 844 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await expect(page.getByRole('button', { name: 'English', exact: true })).toBeInViewport()
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
    await page.getByRole('button', { name: 'Merge subtitles', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Two languages, one story.' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click()
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
    await page.getByRole('button', { name: 'Help', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'From a line to a story' })).toBeVisible()
    expect(await page.getByRole('dialog').innerText()).not.toMatch(/[\u3400-\u9fff]/)
  })
})
