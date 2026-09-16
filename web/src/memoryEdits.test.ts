import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyMemoryEdit,
  makeBackup,
  memoryValue,
  parseBackup,
  termField,
  validateJob,
  type MemoryField,
} from './storage'
import { formatMessage } from './messages'
import { jobFixture } from './test-fixtures'
import { useMemoryEdits } from './memoryEdits'

const active: ReturnType<typeof useMemoryEdits>[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  active.splice(0).forEach((edits) => edits.dispose())
  vi.useRealTimers()
})
function setup() {
  const job = validateJob(jobFixture())
  job.glossary.push({ id: 'second-term', source: 'Second Term', target: '第二项', note: '' })
  const save = vi.fn(async (_jobId: string, field: MemoryField, value: string, previous: string) => {
    applyMemoryEdit(job, field, value, previous)
  })
  const edits = useMemoryEdits({ read: (_jobId, field) => memoryValue(job, field), save })
  active.push(edits)
  return { job, edits, save }
}

describe('glossary and style drafts', () => {
  it('edits the same term after another tab deletes a preceding row or renames it', async () => {
    const { job, edits } = setup()
    const field = termField('second-term', 'target')
    edits.begin(job.id, field)
    edits.startComposition(job.id, field)
    edits.change(job.id, field, '我的译法')
    job.glossary.shift()
    job.glossary[0].source = 'Renamed Term'
    await vi.advanceTimersByTimeAsync(1000)
    expect(edits.value(job.id, field)).toBe('我的译法')
    expect(job.glossary[0].target).toBe('第二项')
    edits.endComposition(job.id, field, '我的译法')
    await vi.advanceTimersByTimeAsync(500)
    expect(job.glossary[0]).toMatchObject({
      id: 'second-term',
      source: 'Renamed Term',
      target: '我的译法',
      locked: true,
    })
  })

  it.each<MemoryField>(['style', 'term:second-term:target'])(
    'retains conflicting %s edits until the user resolves them',
    async (field) => {
      const { job, edits } = setup()
      edits.begin(job.id, field)
      edits.change(job.id, field, '本页内容 ')
      applyMemoryEdit(job, field, '其他标签页内容', memoryValue(job, field)!)
      await vi.advanceTimersByTimeAsync(500)
      expect(edits.value(job.id, field)).toBe('本页内容 ')
      expect(formatMessage(edits.get(job.id, field).error)).toContain('其他标签页修改')
      expect(memoryValue(job, field)).toBe('其他标签页内容')
      await edits.keepMine(job.id, field)
      expect(memoryValue(job, field)).toBe('本页内容')
      expect(edits.value(job.id, field)).toBe('本页内容 ')
      await edits.blur(job.id, field)
      expect(edits.unsavedCount.value).toBe(0)
      expect(edits.value(job.id, field)).toBe('本页内容')
    },
  )

  it('waits for style IME composition and keeps the unsaved draft in backups', async () => {
    const { job, edits, save } = setup()
    edits.begin(job.id, 'style')
    edits.startComposition(job.id, 'style')
    edits.change(job.id, 'style', '正在输入中文')
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).not.toHaveBeenCalled()
    await expect(edits.flush(job.id)).rejects.toThrow('完成当前术语或风格输入')
    const snapshot = edits.snapshot([job])
    expect(parseBackup(makeBackup(snapshot.jobs, snapshot.recovery)).jobs[0].styleNotes).toBe('正在输入中文')
    edits.endComposition(job.id, 'style', '完成中文输入')
    await edits.flush(job.id)
    expect(job.styleNotes).toBe('完成中文输入')
  })

  it('does not recreate a deleted term automatically and keeps its draft exportable', async () => {
    const { job, edits } = setup()
    const field = termField('second-term', 'target')
    edits.change(job.id, field, '仍需保留的内容')
    job.glossary = job.glossary.filter((term) => term.id !== 'second-term')
    await vi.advanceTimersByTimeAsync(500)
    expect(formatMessage(edits.get(job.id, field).error)).toContain('已在其他标签页删除')
    expect(job.glossary).toHaveLength(1)
    const snapshot = edits.snapshot([job])
    const backup = parseBackup(makeBackup(snapshot.jobs, snapshot.recovery))
    expect(backup.jobs).toHaveLength(1)
    expect(backup.recovery[0].data).toMatchObject({ field, value: '仍需保留的内容' })
    edits.restore(job.id, field)
    expect(edits.unsavedCount.value).toBe(0)
  })

  it('backs up valid drafts on save failure while isolating invalid drafts', async () => {
    const { job, edits, save } = setup()
    save.mockRejectedValue(new Error('storage full'))
    edits.change(job.id, 'style', '尚未保存的风格')
    edits.change(job.id, termField('second-term', 'target'), '')
    await vi.advanceTimersByTimeAsync(500)
    const snapshot = edits.snapshot([job])
    expect(snapshot.jobs[0].styleNotes).toBe('尚未保存的风格')
    expect(snapshot.jobs[0].glossary[1].target).toBe('第二项')
    expect(snapshot.recovery).toHaveLength(1)
    expect(edits.unsavedCount.value).toBe(2)
  })
})
