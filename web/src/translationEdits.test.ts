import { formatMessage } from './messages'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyTranslationEdit, makeBackup, parseBackup } from './storage'
import { jobFixture } from './test-fixtures'
import { useTranslationEdits } from './translationEdits'

const active: ReturnType<typeof useTranslationEdits>[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  for (const edits of active.splice(0)) edits.dispose()
  vi.useRealTimers()
})

function setup(beforeSave?: () => Promise<void>) {
  const job = jobFixture()
  Object.assign(job, { completedChunks: 1, translations: { 1: '原译文', 2: '第二条' } })
  const save = vi.fn(async (_id: string, cueId: number, value: string, previous: string) => {
    await beforeSave?.()
    applyTranslationEdit(job, cueId, value, previous)
  })
  const edits = useTranslationEdits({ read: (_id, cueId) => job.translations[cueId], save })
  active.push(edits)
  return { job, edits, save }
}

describe('translation edit drafts', () => {
  it('keeps a focused draft across incoming updates and requires explicit conflict resolution', async () => {
    const { job, edits, save } = setup()
    edits.begin(job.id, 1)
    edits.change(job.id, 1, '我的修正')
    job.translations[1] = '另一标签页的修正'
    await vi.advanceTimersByTimeAsync(500)
    expect(edits.value(job.id, 1)).toBe('我的修正')
    expect(formatMessage(edits.get(job.id, 1).error)).toContain('其他标签页修改')
    expect(edits.unsavedCount.value).toBe(1)
    await edits.blur(job.id, 1)
    expect(save).toHaveBeenCalledTimes(1)
    await edits.keepMine(job.id, 1)
    expect(save).toHaveBeenLastCalledWith(job.id, 1, '我的修正', '另一标签页的修正')
    expect(job.translations[1]).toBe('我的修正')
    expect(edits.unsavedCount.value).toBe(0)
  })

  it('saves text typed while an earlier asynchronous save is still pending', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const { job, edits, save } = setup(async () => {
      if (++calls === 1) await gate
    })
    edits.begin(job.id, 1)
    edits.change(job.id, 1, '第一版')
    await vi.advanceTimersByTimeAsync(500)
    expect(edits.get(job.id, 1).saving).toBe(true)
    edits.change(job.id, 1, '继续输入的最终版本')
    release()
    await edits.save(job.id, 1)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith(job.id, 1, '继续输入的最终版本', '第一版')
    expect(job.translations[1]).toBe('继续输入的最终版本')
    expect(edits.value(job.id, 1)).toBe('继续输入的最终版本')
    expect(edits.unsavedCount.value).toBe(0)
  })

  it('does not trim spaces or a new line under the cursor during autosave', async () => {
    const { job, edits } = setup()
    edits.begin(job.id, 1)
    edits.change(job.id, 1, 'Hello \n')
    await vi.advanceTimersByTimeAsync(500)
    expect(job.translations[1]).toBe('Hello')
    expect(edits.value(job.id, 1)).toBe('Hello \n')
    expect(edits.unsavedCount.value).toBe(0)
    edits.change(job.id, 1, 'Hello \nworld')
    await vi.advanceTimersByTimeAsync(500)
    expect(job.translations[1]).toBe('Hello\nworld')
    expect(edits.value(job.id, 1)).toBe('Hello \nworld')
    await edits.blur(job.id, 1)
    expect(edits.value(job.id, 1)).toBe('Hello\nworld')
    expect(edits.get(job.id, 1)).toBeUndefined()
  })

  it('waits for IME composition to finish even if an earlier save completes during composition', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const { job, edits, save } = setup(async () => {
      if (++calls === 1) await gate
    })
    edits.begin(job.id, 1)
    edits.change(job.id, 1, '已输入')
    await vi.advanceTimersByTimeAsync(500)
    edits.startComposition(job.id, 1)
    edits.change(job.id, 1, '已输入 zhong wen')
    release()
    await edits.save(job.id, 1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).toHaveBeenCalledTimes(1)
    expect(job.translations[1]).toBe('已输入')
    expect(edits.value(job.id, 1)).toBe('已输入 zhong wen')
    await expect(edits.flush(job.id)).rejects.toThrow('完成当前译文输入')
    edits.endComposition(job.id, 1, '已输入中文')
    await vi.advanceTimersByTimeAsync(500)
    expect(job.translations[1]).toBe('已输入中文')
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('keeps failed edits exportable in a valid backup and lets saving recover', async () => {
    let full = true
    const { job, edits } = setup(async () => {
      if (full) throw new Error('quota exceeded')
    })
    edits.change(job.id, 1, ' 尚未保存的修正 ')
    await vi.advanceTimersByTimeAsync(500)
    expect(job.translations[1]).toBe('原译文')
    expect(edits.value(job.id, 1)).toBe(' 尚未保存的修正 ')
    const restored = parseBackup(makeBackup(edits.snapshot([job]))).jobs[0]
    expect(restored.translations[1]).toBe('尚未保存的修正')
    await expect(edits.flush(job.id)).rejects.toThrow('quota exceeded')
    expect(edits.unsavedCount.value).toBe(1)
    full = false
    await edits.keepMine(job.id, 1)
    expect(job.translations[1]).toBe('尚未保存的修正')
    expect(edits.unsavedCount.value).toBe(0)
  })

  it('does not overwrite a newer saved correction when focus alone creates an untouched draft', async () => {
    const { job, edits, save } = setup()
    edits.begin(job.id, 1)
    job.translations[1] = '外部修正'
    expect(edits.snapshot([job])[0].translations[1]).toBe('外部修正')
    expect(edits.unsavedCount.value).toBe(0)
    await edits.blur(job.id, 1)
    expect(save).not.toHaveBeenCalled()
    expect(edits.value(job.id, 1)).toBe('外部修正')
  })

  it('keeps invalid text visible, blocks subtitle export, and allows restoring the saved translation', async () => {
    const { job, edits, save } = setup()
    edits.change(job.id, 1, ' \n ')
    await edits.save(job.id, 1)
    expect(edits.value(job.id, 1)).toBe(' \n ')
    expect(save).not.toHaveBeenCalled()
    expect(parseBackup(makeBackup(edits.snapshot([job]))).jobs[0].translations[1]).toBe('原译文')
    await expect(edits.flush(job.id)).rejects.toThrow('不能为空')
    edits.restore(job.id, 1)
    expect(edits.value(job.id, 1)).toBe('原译文')
    expect(edits.unsavedCount.value).toBe(0)
  })

  it('cancels a deleted task’s pending autosave without disturbing another task’s draft', async () => {
    const { job, edits, save } = setup()
    edits.change(job.id, 1, '此任务草稿')
    edits.change('other-job', 2, '另一任务草稿')
    edits.retain(new Set(['other-job']))
    await vi.advanceTimersByTimeAsync(500)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('other-job', 2, '另一任务草稿', '第二条')
    expect(edits.get(job.id, 1)).toBeUndefined()
  })
})
