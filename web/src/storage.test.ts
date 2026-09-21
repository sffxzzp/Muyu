import { describe, expect, it } from 'vitest'
import { formatMessage } from './messages'
import {
  applyTranslationEdit,
  loadWorkspace,
  makeBackup,
  mergeJobCheckpoint,
  mutateWorkspace,
  parseBackup,
  redactRecoveryRecord,
  saveWorkspace,
  STORAGE_KEY,
  StorageError,
  type Exclusive,
} from './storage'
import { jobFixture, MemoryStorage, workspaceFixture } from './test-fixtures'
import { parseSeedTerms } from './types'

describe('browser checkpoints', () => {
  it('preserves more than 400 preset terms across storage, backups and subsequent additions', () => {
    const storage = new MemoryStorage()
    const workspace = workspaceFixture()
    workspace.jobs[0].glossary = parseSeedTerms(
      Array.from({ length: 1000 }, (_, i) => `Project ${i} = 计划 ${i}`).join('\n'),
    )
    saveWorkspace(storage, workspace)
    const loaded = loadWorkspace(storage)
    expect(loaded.recovery).toEqual([])
    expect(loaded.jobs[0].glossary).toMatchObject(workspace.jobs[0].glossary)
    const restored = parseBackup(makeBackup(loaded.jobs))
    expect(restored.recovery).toEqual([])
    expect(restored.jobs[0].glossary).toEqual(loaded.jobs[0].glossary)
    restored.jobs[0].glossary.push({ source: 'Next Project', target: '下个计划' })
    saveWorkspace(storage, { ...loaded, jobs: restored.jobs })
    expect(loadWorkspace(storage).jobs[0].glossary).toHaveLength(1001)
  })

  it('keeps corrections to saved rows when a stale runner saves its next checkpoint', async () => {
    const storage = new MemoryStorage(),
      workspace = workspaceFixture()
    Object.assign(workspace.jobs[0], {
      completedChunks: 1,
      translations: { 1: '原译文一', 2: '原译文二' },
      status: 'paused',
    })
    saveWorkspace(storage, workspace)
    const checkpoint = loadWorkspace(storage).jobs[0]
    checkpoint.completedChunks = 2
    Object.assign(checkpoint.translations, { 3: '新译文三', 4: '新译文四' })
    checkpoint.glossary.push({ source: 'Project Aurora', target: '极光计划' })
    checkpoint.styleNotes = '清晰、自然的讲解语气'
    checkpoint.glossaryHistory = [{ chunk: 2, at: 200, terms: [] }]
    checkpoint.requests = 2
    checkpoint.usage.total_tokens = 1000
    let tail = Promise.resolve()
    const exclusive: Exclusive = <T>(action: () => T | Promise<T>) => {
      const result = tail.then(action)
      tail = result.then(
        () => {},
        () => {},
      )
      return result
    }
    await Promise.all([
      mutateWorkspace(storage, exclusive, (latest) => {
        applyTranslationEdit(latest.jobs[0], 1, '人工修正一', '原译文一')
      }),
      mutateWorkspace(storage, exclusive, (latest) => {
        applyTranslationEdit(latest.jobs[0], 2, '另一页修正二', '原译文二')
      }),
      mutateWorkspace(storage, exclusive, (latest) => {
        latest.jobs[0] = mergeJobCheckpoint(latest.jobs[0], checkpoint)
      }),
    ])
    const saved = loadWorkspace(storage).jobs[0]
    expect(saved.translations).toEqual({ 1: '人工修正一', 2: '另一页修正二', 3: '新译文三', 4: '新译文四' })
    expect(saved).toMatchObject({
      completedChunks: 2,
      status: 'paused',
      glossary: checkpoint.glossary,
      styleNotes: checkpoint.styleNotes,
      glossaryHistory: checkpoint.glossaryHistory,
      requests: 2,
      usage: { total_tokens: 1000 },
    })
    expect(checkpoint.translations[1]).toBe('原译文一')
  })

  it('detects same-row edit conflicts while allowing an already-saved identical correction', () => {
    const job = jobFixture()
    Object.assign(job, { completedChunks: 1, translations: { 1: '原译文', 2: '第二条' } })
    applyTranslationEdit(job, 1, '另一标签页的修正', '原译文')
    expect(() => applyTranslationEdit(job, 1, '当前标签页的草稿', '原译文')).toThrow('其他标签页修改')
    expect(job.translations[1]).toBe('另一标签页的修正')
    expect(() => applyTranslationEdit(job, 1, '另一标签页的修正', '原译文')).not.toThrow()
    applyTranslationEdit(job, 1, '当前标签页的草稿', '另一标签页的修正')
    expect(job.translations).toEqual({ 1: '当前标签页的草稿', 2: '第二条' })
  })

  it('only edits completed rows with valid text and preserves subtitle line breaks', () => {
    const job = jobFixture()
    Object.assign(job, { completedChunks: 1, translations: { 1: '原译文', 2: '第二条' } })
    for (const cueId of [0, 1.5, 3])
      expect(() => applyTranslationEdit(job, cueId, '修正', '')).toThrow('尚未完成保存')
    expect(() => applyTranslationEdit(job, 1, ' \r\n ', '原译文')).toThrow('不能为空')
    expect(() => applyTranslationEdit(job, 1, '字'.repeat(10667), '原译文')).toThrow('32000')
    expect(applyTranslationEdit(job, 1, ' 你好 \r\n\r\n 世界 ', '原译文')).toBe('你好\n世界')
    expect(job.completedChunks).toBe(1)
    expect(job.document.cues[0].text).toBe('Source cue 1.')
  })

  it('refuses to roll back a newer checkpoint or merge a different task', () => {
    const saved = jobFixture(),
      checkpoint = jobFixture()
    Object.assign(saved, { completedChunks: 1, translations: { 1: '一', 2: '二' } })
    expect(() => mergeJobCheckpoint(saved, checkpoint)).toThrow('进度已在其他标签页更新')
    checkpoint.id = 'another-job'
    checkpoint.completedChunks = 1
    expect(() => mergeJobCheckpoint(saved, checkpoint)).toThrow('进度已在其他标签页更新')
  })

  it('merges simultaneous task checkpoints and preference changes from separate tabs', async () => {
    const storage = new MemoryStorage(),
      workspace = workspaceFixture()
    const second = jobFixture()
    second.id = 'second-job'
    workspace.jobs.push(second)
    saveWorkspace(storage, workspace)
    let tail = Promise.resolve()
    const exclusive: Exclusive = <T>(action: () => T | Promise<T>) => {
      const result = tail.then(action)
      tail = result.then(
        () => {},
        () => {},
      )
      return result
    }
    await Promise.all([
      mutateWorkspace(storage, exclusive, (latest) => {
        Object.assign(latest.jobs[0], { completedChunks: 1, translations: { 1: '任务一', 2: '任务一二' } })
      }),
      mutateWorkspace(storage, exclusive, (latest) => {
        Object.assign(latest.jobs[1], { completedChunks: 1, translations: { 1: '任务二', 2: '任务二二' } })
      }),
      mutateWorkspace(storage, exclusive, (latest) => {
        latest.preferences.model = 'new-default'
      }),
    ])
    const restored = loadWorkspace(storage)
    expect(restored.jobs.map((job) => job.translations[1])).toEqual(['任务一', '任务二'])
    expect(restored.preferences.model).toBe('new-default')
    expect(restored.revision).toBe(4)
  })

  it('discards old concurrency preferences and recovers interrupted queues without dropping glossary history', () => {
    const storage = new MemoryStorage(),
      workspace = workspaceFixture()
    Object.assign(workspace.jobs[0], {
      status: 'queued',
      completedChunks: 1,
      translations: { 1: '一', 2: '二' },
      glossaryHistory: [{ chunk: 1, at: 200, terms: [{ source: 'cash flow', target: '现金流' }] }],
    })
    const legacy: any = { ...workspace }
    legacy.version = 1
    legacy.nextRequestAt = 0
    legacy.maxConcurrentJobs = 6
    storage.setItem(STORAGE_KEY, JSON.stringify(legacy))
    const restored = loadWorkspace(storage)
    expect(restored).not.toHaveProperty('maxConcurrentJobs')
    saveWorkspace(storage, restored)
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).not.toHaveProperty('maxConcurrentJobs')
    expect(restored.jobs[0].status).toBe('paused')
    expect(parseBackup(makeBackup(restored.jobs)).jobs[0].glossaryHistory).toEqual(
      restored.jobs[0].glossaryHistory,
    )
  })
  it('migrates old browser records and backups without changing saved chunks or context', () => {
    const storage = new MemoryStorage()
    const old = JSON.parse(JSON.stringify(workspaceFixture()))
    old.version = 1
    old.nextRequestAt = 0
    const job = old.jobs[0]
    delete job.settings.futureContextSize
    delete job.lastGlossarySent
    job.chunks = [
      { start: 0, end: 3 },
      { start: 3, end: 6 },
    ]
    job.completedChunks = 1
    job.translations = { 1: '旧译文一', 2: '旧译文二', 3: '旧译文三' }
    job.status = 'paused'
    job.error = 'The model endpoint returned HTTP 401. Check your API key and model permissions.'
    job.events = [{ at: 200, kind: 'info', message: '从第 2 块继续翻译' }]
    storage.setItem(STORAGE_KEY, JSON.stringify(old))
    for (const migrated of [
      loadWorkspace(storage).jobs[0],
      parseBackup(JSON.stringify({ kind: 'muyu-backup', version: 1, jobs: old.jobs })).jobs[0],
    ]) {
      expect(migrated.settings.futureContextSize).toBe(0)
      expect(migrated.settings.useGlossary).toBe(true)
      expect(migrated.settings.contextSize).toBe(job.settings.contextSize)
      expect(migrated.lastGlossarySent).toBeNull()
      expect(migrated.chunks).toEqual(job.chunks)
      expect(migrated.translations).toEqual(job.translations)
      expect(migrated.completedChunks).toBe(1)
      expect(migrated.error).toEqual({
        key: '模型接口返回 HTTP {0}，请检查 API Key 和模型权限',
        params: { 0: '401' },
      })
      expect(migrated.events[0].message).toEqual({ key: '从第 {0} 块继续翻译', params: { 0: '2' } })
      expect(parseBackup(makeBackup([migrated])).jobs[0]).toEqual(migrated)
    }
  })

  it('roundtrips the new context setting and request glossary count with the complete glossary', () => {
    const storage = new MemoryStorage(),
      workspace = workspaceFixture()
    workspace.jobs[0].settings.futureContextSize = 5
    workspace.jobs[0].lastGlossarySent = 0
    saveWorkspace(storage, workspace)
    const saved = loadWorkspace(storage).jobs[0]
    expect(saved.settings.futureContextSize).toBe(5)
    expect(saved.lastGlossarySent).toBe(0)
    expect(saved.glossary).toMatchObject(workspace.jobs[0].glossary)
  })
  it('removes API keys from recovery exports even when browser JSON is corrupt', () => {
    const valid = JSON.stringify({
      preferences: { apiKey: 'secret-with-"quotes"', model: 'model' },
      jobs: [],
    })
    expect(redactRecoveryRecord(valid)).not.toContain('secret-with-')
    expect(JSON.parse(redactRecoveryRecord(valid)).preferences.model).toBe('model')
    expect(redactRecoveryRecord('{"jobs":[],"apiKey":"truncated-secret\\')).not.toContain('truncated-secret')
  })
  it('restores completed cues, glossary and style together after a running page is closed', () => {
    const storage = new MemoryStorage(),
      workspace = workspaceFixture(),
      job = workspace.jobs[0]
    Object.assign(job, {
      status: 'running',
      completedChunks: 1,
      translations: { 1: '第一句', 2: '第二句' },
      styleNotes: '使用亲切的第二人称',
    })
    job.glossary.push({ source: 'risk', target: '风险' })
    storage.setItem(STORAGE_KEY, JSON.stringify({ ...workspace, version: 1, nextRequestAt: 0 }))
    const restored = loadWorkspace(storage).jobs[0]
    expect(restored.status).toBe('paused')
    expect(restored.completedChunks).toBe(1)
    expect(restored.translations).toEqual({ 1: '第一句', 2: '第二句' })
    expect(restored.glossary).toHaveLength(2)
    expect(restored.styleNotes).toContain('第二人称')
  })

  it('retains old jobs indefinitely and does not store expiration metadata', () => {
    const storage = new MemoryStorage(),
      workspace = workspaceFixture()
    workspace.jobs[0].createdAt = 1
    saveWorkspace(storage, workspace)
    expect(loadWorkspace(storage).jobs).toHaveLength(1)
    expect(storage.getItem(STORAGE_KEY)).not.toMatch(/expiresAt|lastVisitedAt/)
  })

  it('does not persist API keys unless explicitly remembered and never includes keys in backups', () => {
    const storage = new MemoryStorage(),
      workspace = workspaceFixture()
    workspace.preferences.apiKey = 'a-secret-only-for-test'
    saveWorkspace(storage, workspace)
    expect(storage.getItem(STORAGE_KEY)).not.toContain('a-secret-only-for-test')
    workspace.preferences.rememberKey = true
    saveWorkspace(storage, workspace)
    expect(loadWorkspace(storage).preferences.apiKey).toBe('a-secret-only-for-test')
    expect(makeBackup(workspace.jobs)).not.toContain('a-secret-only-for-test')
    expect(makeBackup(workspace.jobs)).not.toContain('apiKey')
  })

  it('preserves the previous persisted checkpoint when localStorage is full', () => {
    const storage = new MemoryStorage(),
      workspace = workspaceFixture()
    saveWorkspace(storage, workspace)
    storage.full = true
    Object.assign(workspace.jobs[0], { completedChunks: 1, translations: { 1: '一', 2: '二' } })
    expect(() => saveWorkspace(storage, workspace)).toThrow(StorageError)
    expect(loadWorkspace(storage).jobs[0].completedChunks).toBe(0)
  })

  it('validates imported checkpoints and does not accept holes or duplicated chunks', () => {
    const workspace = workspaceFixture(),
      job = workspace.jobs[0]
    job.completedChunks = 1
    job.translations = { 1: 'one' }
    const missing = parseBackup(makeBackup(workspace.jobs))
    expect(missing.jobs).toHaveLength(0)
    expect(formatMessage(missing.recovery[0].error)).toBe('断点与译文数量不一致')
    expect(missing.recovery[0].data).toEqual(job)
    job.translations[2] = 'two'
    job.chunks[1].start = 0
    const discontinuous = parseBackup(makeBackup(workspace.jobs))
    expect(discontinuous.jobs).toHaveLength(0)
    expect(formatMessage(discontinuous.recovery[0].error)).toBe('分块记录不连续')
  })

  it('leaves corrupt browser records untouched for explicit backup and cleanup', () => {
    const storage = new MemoryStorage()
    storage.setItem(STORAGE_KEY, '{not valid JSON')
    expect(() => loadWorkspace(storage)).toThrow(StorageError)
    expect(storage.getItem(STORAGE_KEY)).toBe('{not valid JSON')
  })

  it('roundtrips a backup and resets an interrupted running status', () => {
    const workspace = workspaceFixture()
    const legacy: any = structuredClone(workspace.jobs)
    legacy[0].status = 'running'
    const { jobs } = parseBackup(JSON.stringify({ kind: 'muyu-backup', version: 1, jobs: legacy }))
    expect(jobs[0].status).toBe('paused')
    expect(jobs[0].document.cues).toMatchObject(workspace.jobs[0].document.cues)
    expect(jobs[0].settings.background).toBe('财务教育背景')
  })
})
