import { test, expect, type Page } from '@playwright/test'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const controlURL = 'http://127.0.0.1:19091/control'
const artifacts = path.resolve('../artifacts')

async function startSample(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'API 配置', exact: true }).click()
  await page.getByLabel('API Base URL', { exact: true }).fill('http://127.0.0.1:19091/v1')
  await page.getByLabel('模型名称', { exact: true }).fill('mock-translator')
  await page.getByLabel('API Key', { exact: true }).fill('local-edit-test-key')
  await page.getByLabel('在此浏览器记住 API Key').check()
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: '试用示例字幕' }).click()
  await expect(page.getByText('cash-flow-intro.srt', { exact: true })).toBeVisible()
  await page.getByLabel('目标块大小', { exact: true }).fill('4')
  await page.getByLabel('分块条数上限', { exact: true }).fill('4')
  await page.getByLabel('每分钟请求数 RPM', { exact: true }).fill('600')
  await page.locator('.advanced-settings summary').click()
  await page.getByLabel('前文条数', { exact: true }).fill('8')
  await page.getByRole('button', { name: '开始翻译', exact: true }).click()
  await expect(page).toHaveURL(/#\/task\//)
}

async function gate(page: Page) {
  const pending = new Map<number, () => void>()
  // Hold server responses without Playwright's routing bypassing CORS preflight.
  await page.route('http://127.0.0.1:19091/v1/chat/completions', (route) => route.abort('failed'))
  await page.route('**/api/relay', async (route) => {
    const firstId = JSON.parse(route.request().postDataJSON().payload.messages[1].content)
      .cues_to_translate[0].id
    const response = await route.fetch()
    await new Promise<void>((resolve) => pending.set(firstId, resolve))
    await route.fulfill({ response })
  })
  return {
    wait: async (firstId: number) => {
      await expect.poll(() => pending.has(firstId)).toBe(true)
    },
    release: async (firstId: number) => {
      await expect.poll(() => pending.has(firstId)).toBe(true)
      const release = pending.get(firstId)!
      pending.delete(firstId)
      release()
    },
  }
}

async function savedJob(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('muyu.workspace.v1')!).jobs[0])
}
const cue = (page: Page, id: number) => page.getByRole('textbox', { name: `第 ${id} 条译文`, exact: true })

test.beforeEach(async ({ request }) => {
  await request.post(controlURL, { data: { reset: true, failFrom: 0, delayMs: 30, malformedAt: 0 } })
  await mkdir(artifacts, { recursive: true })
})

test('edits completed cues during API waits without losing focus, composition or later request context', async ({
  page,
  request,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const responses = await gate(page)
  await startSample(page)
  await responses.release(1)
  await responses.wait(5)
  await expect(page.getByRole('heading', { name: '已完成 4 / 12 条字幕' })).toBeVisible()
  await expect(cue(page, 1)).toBeEnabled()
  await expect(cue(page, 5)).toHaveCount(0)
  const firstCorrection = '欢迎回来。今天，一起理解现金流。'
  await cue(page, 1).fill(firstCorrection)
  await expect.poll(async () => (await savedJob(page)).translations[1]).toBe(firstCorrection)
  await expect(page.getByRole('checkbox', { name: '跟随翻译进度' })).toBeChecked()

  // An API response and progress repaint arrive while a Chinese IME is active.
  const secondCorrection = '赚了多少钱，并不是全部。'
  await cue(page, 2).focus()
  await cue(page, 2).dispatchEvent('compositionstart')
  await cue(page, 2).fill(secondCorrection)
  await responses.release(5)
  await responses.wait(9)
  await expect(page.getByRole('heading', { name: '已完成 8 / 12 条字幕' })).toBeVisible()
  await expect(cue(page, 2)).toBeFocused()
  await expect(page.getByRole('checkbox', { name: '跟随翻译进度' })).toBeChecked()
  await expect(cue(page, 2)).toHaveValue(secondCorrection)
  expect((await savedJob(page)).translations[2]).not.toBe(secondCorrection)
  const { calls } = await (await request.get(controlURL)).json()
  expect(calls).toHaveLength(3)
  expect(calls[1].data.previous_context[0].target).not.toBe(firstCorrection)
  expect(calls[2].data.previous_context[0].target).toBe(firstCorrection)
  await page.screenshot({ path: path.join(artifacts, 'translation-live-editing.png') })
  await cue(page, 2).dispatchEvent('compositionend', { data: secondCorrection })
  await expect.poll(async () => (await savedJob(page)).translations[2]).toBe(secondCorrection)
  await responses.release(9)
  await expect(page.getByRole('heading', { name: '每一句，都已抵达。' })).toBeVisible()
  await expect(cue(page, 1)).toHaveValue(firstCorrection)
  await expect(cue(page, 2)).toHaveValue(secondCorrection)

  await page.getByRole('button', { name: '导出字幕', exact: true }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载字幕', exact: true }).click()
  const subtitle = await readFile((await (await downloadPromise).path())!, 'utf-8')
  expect(subtitle).toContain(firstCorrection)
  expect(subtitle).toContain(secondCorrection)
  await page.reload()
  await expect(cue(page, 1)).toHaveValue(firstCorrection)
  await expect(cue(page, 2)).toHaveValue(secondCorrection)
  expect((await savedJob(page)).completedChunks).toBe(3)
  expect(errors).toEqual([])
})

test('cross-tab corrections survive runner checkpoints and same-row conflicts keep both versions reviewable', async ({
  page,
  context,
  request,
}) => {
  const responses = await gate(page)
  await startSample(page)
  await responses.release(1)
  await responses.wait(5)
  const second = await context.newPage()
  await second.goto(page.url())
  await expect(second.getByRole('button', { name: '暂停翻译', exact: true })).toBeVisible()
  await cue(page, 1).focus()
  await cue(page, 1).dispatchEvent('compositionstart')
  await cue(page, 1).fill('当前页保留的修正')
  await cue(second, 1).fill('另一标签页已经保存的修正')
  await expect.poll(async () => (await savedJob(second)).translations[1]).toBe('另一标签页已经保存的修正')
  await cue(second, 2).fill('第二条的独立修正')
  await expect.poll(async () => (await savedJob(second)).translations[2]).toBe('第二条的独立修正')
  await expect(cue(page, 1)).toHaveValue('当前页保留的修正')
  await cue(page, 1).dispatchEvent('compositionend')
  const conflict = page.locator('[data-cue-id="1"] .translation-edit-state')
  await expect(conflict).toContainText('这条译文已在其他标签页修改，草稿已保留')
  await conflict.getByText('查看已保存译文', { exact: true }).click()
  await expect(conflict.locator('details p')).toHaveText('另一标签页已经保存的修正')
  await responses.release(5)
  await responses.wait(9)
  expect((await savedJob(page)).translations[1]).toBe('另一标签页已经保存的修正')
  expect((await savedJob(page)).translations[2]).toBe('第二条的独立修正')
  await expect(cue(page, 1)).toHaveValue('当前页保留的修正')
  await expect(conflict).toContainText('草稿已保留')
  const { calls } = await (await request.get(controlURL)).json()
  expect(calls[2].data.previous_context[0].target).toBe('另一标签页已经保存的修正')

  await conflict.getByRole('button', { name: '保存我的修改', exact: true }).click()
  await expect.poll(async () => (await savedJob(page)).translations[1]).toBe('当前页保留的修正')
  await expect(cue(second, 1)).toHaveValue('当前页保留的修正')
  await responses.release(9)
  await expect(second.getByRole('heading', { name: '每一句，都已抵达。' })).toBeVisible()
  const backupPromise = second.waitForEvent('download')
  await second.getByRole('button', { name: '备份', exact: true }).click()
  const backup = JSON.parse(await readFile((await (await backupPromise).path())!, 'utf-8'))
  expect(backup.jobs[0]).toMatchObject({
    completedChunks: 3,
    requests: 4, // One unavailable direct attempt, followed by three model calls.
    translations: { 1: '当前页保留的修正', 2: '第二条的独立修正' },
  })
  await page.reload()
  await second.reload()
  await expect(cue(page, 1)).toHaveValue('当前页保留的修正')
  await expect(cue(second, 2)).toHaveValue('第二条的独立修正')
})

test('storage failure keeps edited text and new translation progress recoverable in a backup', async ({
  page,
  request,
}) => {
  const responses = await gate(page)
  await startSample(page)
  await responses.release(1)
  await responses.wait(5)
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === 'muyu.workspace.v1') throw new DOMException('Test quota exceeded', 'QuotaExceededError')
      original.call(this, key, value)
    }
    ;(window as any).restoreTranslationStorage = () => {
      Storage.prototype.setItem = original
    }
  })
  await cue(page, 1).fill('存储空间恢复后也要保留这次修正')
  await expect(page.locator('[data-cue-id="1"] .translation-edit-state')).toContainText('存储空间不足')
  await page.getByRole('checkbox', { name: '跟随翻译进度' }).uncheck()
  await page.getByRole('tab', { name: /术语与风格/ }).click()
  await page.getByRole('tab', { name: /字幕对照/ }).click()
  await expect(page.getByRole('checkbox', { name: '跟随翻译进度' })).not.toBeChecked()
  await page.getByRole('button', { name: /^任务记录/ }).click()
  await page.locator('.task-name-cell').filter({ hasText: 'cash-flow-intro.srt' }).click()
  await expect(cue(page, 1)).toHaveValue('存储空间恢复后也要保留这次修正')
  await expect(page.locator('[data-cue-id="1"] .translation-edit-state')).toContainText('存储空间不足')
  await expect(page.getByRole('checkbox', { name: '跟随翻译进度' })).not.toBeChecked()
  await responses.release(5)
  await expect(page.getByRole('button', { name: '继续翻译', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '已完成 8 / 12 条字幕' })).toBeVisible()
  expect((await savedJob(page)).completedChunks).toBe(1)
  expect((await savedJob(page)).translations[1]).not.toBe('存储空间恢复后也要保留这次修正')
  const backupPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '备份', exact: true }).click()
  const raw = await readFile((await (await backupPromise).path())!, 'utf-8')
  const backup = JSON.parse(raw)
  expect(backup.jobs[0].completedChunks).toBe(2)
  expect(Object.keys(backup.jobs[0].translations)).toHaveLength(8)
  expect(backup.jobs[0].translations[1]).toBe('存储空间恢复后也要保留这次修正')
  expect(raw).not.toContain('local-edit-test-key')
  await page.evaluate(() => {
    ;(window as any).restoreTranslationStorage()
    delete (window as any).restoreTranslationStorage
  })
  await page.getByRole('button', { name: '保存我的修改', exact: true }).click()
  await expect.poll(async () => (await savedJob(page)).translations[1]).toBe('存储空间恢复后也要保留这次修正')
  expect((await savedJob(page)).completedChunks).toBe(2)
  expect((await (await request.get(controlURL)).json()).calls).toHaveLength(2)
  await page.reload()
  await expect(cue(page, 1)).toHaveValue('存储空间恢复后也要保留这次修正')
  await expect(page.getByRole('heading', { name: '已完成 8 / 12 条字幕' })).toBeVisible()
})
