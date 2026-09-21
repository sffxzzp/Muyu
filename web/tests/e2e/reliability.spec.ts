import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'

const control = 'http://127.0.0.1:19091/control'
const file = (name: string, content: string) => ({
  name,
  mimeType: 'application/json',
  buffer: Buffer.from(content),
})
const savedJob = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('muyu.workspace.v1')!).jobs[0])

async function prepare(page: Page, start = true) {
  await page.goto('/')
  await page.getByRole('button', { name: 'API 配置', exact: true }).click()
  await page.getByLabel('API Base URL', { exact: true }).fill('http://127.0.0.1:19091/v1')
  await page.getByLabel('模型名称', { exact: true }).fill('mock-translator')
  await page.getByLabel('API Key', { exact: true }).fill('local-reliability-key')
  await page.getByLabel('在此浏览器记住 API Key').check()
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await page.getByRole('button', { name: '试用示例字幕' }).click()
  await page.getByLabel('目标块大小', { exact: true }).fill('4')
  await page.getByLabel('分块条数上限', { exact: true }).fill('4')
  await page.getByLabel('每分钟请求数 RPM', { exact: true }).fill('600')
  await page.getByRole('button', { name: start ? '开始翻译' : '保存任务，稍后翻译', exact: true }).click()
  await expect(page).toHaveURL(/#\/task\//)
}

test.beforeEach(async ({ request }) => {
  await request.post(control, { data: { reset: true, failFrom: 0, delayMs: 30, malformedAt: 0, cors: true } })
})

test('new glossary entries display during RPM waits and keep their identity after pausing', async ({
  page,
  request,
}) => {
  await prepare(page, false)
  await page.getByRole('button', { name: '调整参数', exact: true }).click()
  await page.getByRole('dialog').getByLabel('每分钟请求数 RPM', { exact: true }).fill('1')
  await page.getByRole('button', { name: '保存参数', exact: true }).click()
  await page.getByTestId('glossary-tab').click()
  await page.getByRole('button', { name: '开始翻译', exact: true }).click()
  await expect(page.locator('.wait-countdown')).toBeVisible()
  const terms = (await savedJob(page)).glossary
  expect(terms.map((term: { source: string; target: string }) => [term.source, term.target])).toEqual([
    ['cash flow', '现金流'],
    ['small business', '小公司'],
  ])
  const ids = terms.map((term: { id: string }) => term.id)
  expect(ids.every((id: string) => !!id)).toBe(true)
  expect(new Set(ids).size).toBe(2)
  for (const [index, term] of terms.entries()) {
    await expect(page.getByTestId(`term-${index + 1}-source`)).toHaveValue(term.source)
    await expect(page.getByTestId(`term-${index + 1}-target`)).toHaveValue(term.target)
  }
  expect((await (await request.get(control)).json()).calls).toHaveLength(1)
  await page.getByRole('button', { name: '暂停翻译', exact: true }).click()
  await expect(page.getByRole('button', { name: '继续翻译', exact: true })).toBeVisible()
  expect((await savedJob(page)).glossary.map((term: { id: string }) => term.id)).toEqual(ids)
  await page.getByTestId('term-1-target').fill('现金流（手动修正）')
  await expect.poll(async () => (await savedJob(page)).glossary[0].target).toBe('现金流（手动修正）')
  await page.reload()
  await page.getByTestId('glossary-tab').click()
  await expect(page.getByTestId('term-1-source')).toHaveValue('cash flow')
  await expect(page.getByTestId('term-1-target')).toHaveValue('现金流（手动修正）')
  expect((await savedJob(page)).glossary.map((term: { id: string }) => term.id)).toEqual(ids)
})

test('repeated start clicks share one worker and still pause immediately after flushing drafts', async ({
  page,
  request,
}) => {
  await prepare(page, false)
  await page.getByRole('button', { name: '调整参数', exact: true }).click()
  await page.getByRole('dialog').getByLabel('每分钟请求数 RPM', { exact: true }).fill('1')
  await page.getByRole('button', { name: '保存参数', exact: true }).click()
  await page.getByTestId('glossary-tab').click()
  await page.getByLabel('风格备忘', { exact: true }).fill('启动前保存这个草稿')
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('.progress-action button')!
    button.click()
    button.click()
  })
  await expect(page.locator('.wait-countdown')).toBeVisible()
  const calls = (await (await request.get(control)).json()).calls
  expect(calls).toHaveLength(1)
  expect(calls[0].data.established_style_notes).toBe('启动前保存这个草稿')
  await page.getByRole('button', { name: '暂停翻译', exact: true }).click()
  await expect(page.getByRole('button', { name: '继续翻译', exact: true })).toBeVisible({ timeout: 3000 })
  expect((await savedJob(page)).status).toBe('paused')
})

test('stops truncated output once, edits a saved cue and resumes only smaller unfinished chunks', async ({
  page,
  request,
}) => {
  await request.post(control, { data: { truncateFrom: 5 } })
  await prepare(page)
  await expect(page.locator('.job-error')).toContainText('Token 上限截断')
  const first = await (await request.get(control)).json()
  expect(first.calls).toHaveLength(2)
  const original = await savedJob(page)
  expect(original.completedChunks).toBe(1)
  await page.getByRole('textbox', { name: '第 1 条译文', exact: true }).fill('手动修正并保留')
  await expect.poll(async () => (await savedJob(page)).translations[1]).toBe('手动修正并保留')
  await page.getByRole('button', { name: '调整参数', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('源语言', { exact: true })).toBeDisabled()
  await expect(dialog.getByLabel('目标语言', { exact: true })).toBeDisabled()
  await dialog.getByLabel('目标块大小', { exact: true }).fill('1')
  await dialog.getByLabel('分块条数上限', { exact: true }).fill('1')
  await dialog.getByRole('button', { name: '保存参数' }).click()
  const updated = await savedJob(page)
  expect(updated.chunks[0]).toEqual(original.chunks[0])
  expect(updated.glossary).toEqual(original.glossary)
  expect(updated.styleNotes).toBe(original.styleNotes)
  await page.getByRole('button', { name: '继续翻译', exact: true }).click()
  await expect(page.getByRole('button', { name: '导出字幕', exact: true })).toBeEnabled()
  const done = await savedJob(page)
  expect(done.translations[1]).toBe('手动修正并保留')
  const calls = (await (await request.get(control)).json()).calls
  expect(calls.slice(2).map((call: any) => call.data.cues_to_translate.map((cue: any) => cue.id))).toEqual([
    [5],
    [6],
    [7],
    [8],
    [9],
    [10],
    [11],
    [12],
  ])
})

test('keeps translations and valid terms when auxiliary model fields fail', async ({ page, request }) => {
  await request.post(control, { data: { badMemory: true } })
  await prepare(page)
  await expect(page.getByRole('button', { name: '导出字幕', exact: true })).toBeEnabled()
  const job = await savedJob(page)
  expect(job.completedChunks).toBe(3)
  expect(job.glossary.map((term: { source: string }) => term.source)).toEqual([
    'small business',
    'positive cash flow',
    'financial literacy',
  ])
  expect(job.styleNotes).toBe('')
  expect((await (await request.get(control)).json()).calls).toHaveLength(3)
  await page.getByRole('tab', { name: '运行记录', exact: true }).click()
  await expect(page.locator('.log-panel')).toContainText('本轮跳过 1 条无效术语，译文已保留')
  await expect(page.locator('.log-panel')).toContainText('本轮跳过 1 条未在当前块原文中找到的术语，译文已保留')
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await expect(page.locator('.log-panel')).toContainText(
    'Skipped 1 invalid terms. Translations were preserved.',
  )
  await expect(page.locator('.log-panel')).toContainText(
    'Skipped 1 terms not found in the current source chunk. Translations were preserved.',
  )
})

test('isolates broken tasks while preserving readable history, editing and recovery backups', async ({
  page,
}) => {
  await prepare(page, false)
  const base = await savedJob(page)
  const healthy = {
    ...base,
    id: 'healthy-import',
    name: 'healthy.srt',
    events: [
      { at: 1, kind: 'info', message: { key: 'retired-message {0}', params: { 0: 'still readable' } } },
      null,
    ],
  }
  const broken = {
    ...base,
    id: 'broken-import',
    name: 'broken.srt',
    completedChunks: 1,
    translations: { 1: '原始成果' },
    apiKey: 'must-not-export',
  }
  await page
    .getByLabel('导入任务备份文件', { exact: true })
    .setInputFiles(
      file('mixed.json', JSON.stringify({ kind: 'muyu-backup', version: 2, jobs: [healthy, broken] })),
    )
  await expect(page.locator('.recovery-record')).toHaveCount(1)
  await expect(page.locator('.recovery-record')).toContainText('broken.srt')
  await page.locator('.task-name-cell').filter({ hasText: 'healthy.srt' }).click()
  await page.getByRole('tab', { name: '运行记录', exact: true }).click()
  await expect(page.locator('.log-panel')).toContainText('retired-message still readable')
  await page.getByTestId('glossary-tab').click()
  await page.getByLabel('风格备忘', { exact: true }).fill('记录异常不影响正常编辑')
  await expect.poll(async () => (await savedJob(page)).styleNotes).toBe('记录异常不影响正常编辑')
  await page.reload()
  await page.getByRole('button', { name: /^任务记录/ }).click()
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载原始记录', exact: true }).click()
  const text = await readFile((await (await downloaded).path())!, 'utf8')
  expect(text).toContain('原始成果')
  expect(text).not.toContain('must-not-export')
  const repaired = JSON.parse(text)
  repaired.jobs[0].translations = { 1: '原始成果', 2: '补全二', 3: '补全三', 4: '补全四' }
  await page
    .getByLabel('导入任务备份文件', { exact: true })
    .setInputFiles(file('repaired.json', JSON.stringify(repaired)))
  await expect(page.locator('.task-name-cell').filter({ hasText: 'broken.srt' })).toHaveCount(1)
  await expect(page.locator('.recovery-record')).toHaveCount(1)
})

test('preserves term identity, IME drafts and style conflicts across tabs', async ({ page, context }) => {
  await prepare(page, false)
  const base = await savedJob(page)
  const job = {
    ...base,
    id: 'edit-memory',
    name: 'memory.srt',
    glossary: [
      { source: 'Alpha', target: '甲' },
      { source: 'Bravo', target: '乙' },
      { source: 'Charlie', target: '丙' },
    ],
  }
  await page
    .getByLabel('导入任务备份文件', { exact: true })
    .setInputFiles(file('memory.json', JSON.stringify({ kind: 'muyu-backup', version: 2, jobs: [job] })))
  await page.locator('.task-name-cell').filter({ hasText: 'memory.srt' }).click()
  await page.getByTestId('glossary-tab').click()
  const other = await context.newPage()
  await other.goto(page.url())
  await other.getByTestId('glossary-tab').click()
  const bravo = page.getByTestId('term-2-target')
  await bravo.focus()
  await bravo.dispatchEvent('compositionstart')
  await bravo.fill('乙的手动修正')
  await other.getByRole('button', { name: '删除术语 Alpha', exact: true }).click()
  await expect(page.locator('.term-row')).toHaveCount(2)
  const moved = page.getByTestId('term-1-target')
  await expect(moved).toHaveValue('乙的手动修正')
  await moved.dispatchEvent('compositionend')
  await expect.poll(async () => (await savedJob(page)).glossary[0].target).toBe('乙的手动修正')
  expect((await savedJob(page)).glossary[0].source).toBe('Bravo')

  const style = page.getByLabel('风格备忘', { exact: true })
  await style.focus()
  await style.dispatchEvent('compositionstart')
  await style.fill('本页的风格草稿')
  await other.getByLabel('风格备忘', { exact: true }).fill('另一页的风格')
  await other.getByLabel('风格备忘', { exact: true }).blur()
  await expect.poll(async () => (await savedJob(page)).styleNotes).toBe('另一页的风格')
  await expect(style).toHaveValue('本页的风格草稿')
  await style.dispatchEvent('compositionend')
  await expect(page.locator('.style-memory [role="alert"]')).toContainText('已在其他标签页修改')
  await page.locator('.style-memory').getByRole('button', { name: '保存我的修改', exact: true }).click()
  await expect.poll(async () => (await savedJob(page)).styleNotes).toBe('本页的风格草稿')
  await expect(page.locator('.style-memory [role="alert"]')).toHaveCount(0)
})
