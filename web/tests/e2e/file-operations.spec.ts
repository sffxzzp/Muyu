import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

const original = `WEBVTT - Local subtitle operations

NOTE preserved metadata
A note before the cues.

intro
00:00:01.000 --> 00:00:02.000 align:start
<i>Hello.</i>

outro
00:00:03.000 --> 00:00:04.000
See you.

NOTE ending
`
const translated = `1
00:00:01,000 --> 00:00:02,000
<i>你好。</i>

2
00:00:03,000 --> 00:00:04,000
再见。
`
const file = (name: string, content: string) => ({
  name,
  mimeType: 'text/plain',
  buffer: Buffer.from(content),
})

test('imports, restores, exports and merges subtitles locally after API access is blocked', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '让每一句，都恰如其分。' })).toBeVisible()
  const requests: string[] = []
  await page.route('**/api/**', (route) => {
    requests.push(route.request().url())
    return route.abort('failed')
  })
  await page.getByLabel('上传字幕文件', { exact: true }).setInputFiles(file('offline.vtt', original))
  await expect(page.locator('.file-summary')).toContainText('2 条字幕')
  await page.getByRole('button', { name: '保存任务，稍后翻译', exact: true }).click()
  await expect(page.locator('.cue-row')).toHaveCount(2)

  // A completed backup exercises the real exporter without a paid model call.
  const backup = await page.evaluate(() => {
    const job = JSON.parse(localStorage.getItem('muyu.workspace.v1')!).jobs[0]
    job.id = 'offline-complete'
    job.name = 'completed.vtt'
    job.status = 'completed'
    job.completedChunks = job.chunks.length
    job.translations = { 1: '<i>你好。</i>', 2: '再见。' }
    return JSON.stringify({ kind: 'muyu-backup', version: 2, jobs: [job] })
  })
  await page.getByLabel('导入任务备份文件', { exact: true }).setInputFiles(file('completed.json', backup))
  await page.locator('.task-name-cell').filter({ hasText: 'completed.vtt' }).click()
  await page.getByRole('button', { name: '导出字幕', exact: true }).click()
  const exported = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载字幕', exact: true }).click()
  const vtt = await readFile((await (await exported).path())!, 'utf8')
  expect(vtt).toContain('WEBVTT - Local subtitle operations')
  expect(vtt).toContain('NOTE preserved metadata\nA note before the cues.')
  expect(vtt).toContain('intro\n00:00:01.000 --> 00:00:02.000 align:start\n<i>Hello.</i>\n<i>你好。</i>')
  expect(vtt).toContain('NOTE ending')

  await page.getByRole('button', { name: '双语合并', exact: true }).click()
  await page.getByLabel('上传原文字幕', { exact: true }).setInputFiles(file('source.vtt', original))
  await page.getByLabel('上传译文字幕', { exact: true }).setInputFiles(file('target.srt', translated))
  await expect(page.locator('.merge-explanation')).toContainText('条数和时间轴完全对应')
  await page.getByLabel('上下排列').selectOption('translation-first')
  const merged = page.waitForEvent('download')
  await page.getByRole('button', { name: '合并并下载', exact: true }).click()
  const bilingual = await readFile((await (await merged).path())!, 'utf8')
  expect(bilingual).toContain(
    'intro\n00:00:01.000 --> 00:00:02.000 align:start\n<i>你好。</i>\n<i>Hello.</i>',
  )
  expect(bilingual.match(/ --> /g)).toHaveLength(2)
  expect(bilingual).toContain('NOTE ending')
  expect(requests).toEqual([])
})
