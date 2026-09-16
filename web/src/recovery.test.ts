import { describe, expect, it } from 'vitest'
import { formatMessage, isMessage } from './messages'
import {
  loadWorkspace,
  makeBackup,
  mutateWorkspace,
  parseBackup,
  saveWorkspace,
  validateJob,
} from './storage'
import { MemoryStorage, workspaceFixture } from './test-fixtures'

describe('workspace recovery boundaries', () => {
  it('reads unknown message keys safely, including object prototype names', () => {
    const workspace = workspaceFixture()
    workspace.jobs[0].events = ['retired {0}', '__proto__', 'constructor'].map((key) => ({
      at: 1,
      kind: 'info',
      message: { key, params: { 0: 'value' } },
    }))
    const storage = new MemoryStorage()
    saveWorkspace(storage, workspace)
    const restored = loadWorkspace(storage)
    expect(restored.jobs).toHaveLength(1)
    expect(restored.recovery).toHaveLength(0)
    expect(restored.jobs[0].events.map((event) => formatMessage(event.message, {}))).toEqual([
      'retired value',
      '__proto__',
      'constructor',
    ])
    expect(isMessage({ key: '__proto__' })).toBe(true)
  })

  it('drops only damaged auxiliary records and preserves valid events and checkpoints', () => {
    const workspace = workspaceFixture()
    const job: any = workspace.jobs[0]
    Object.assign(job, {
      completedChunks: 1,
      translations: { 1: '人工修正', 2: '已保存译文' },
      status: 'paused',
    })
    job.events = [
      { at: 1, kind: 'info', message: { key: 'old message' } },
      null,
      { at: 2, kind: 'info', message: [] },
    ]
    job.glossaryHistory = [
      { chunk: 1, at: 1, terms: [] },
      { chunk: 999, at: 1, terms: [] },
    ]
    job.lastGlossarySent = -1
    job.error = { invalid: true }
    job.requests = 'broken'
    job.usage.completion_tokens = -1
    const storage = new MemoryStorage()
    saveWorkspace(storage, workspace)
    const restored = loadWorkspace(storage)
    expect(restored.recovery).toHaveLength(0)
    expect(restored.jobs[0].translations).toEqual(job.translations)
    expect(restored.jobs[0].chunks).toEqual(job.chunks)
    expect(restored.jobs[0].glossaryHistory).toHaveLength(1)
    expect(restored.jobs[0].events).toHaveLength(2)
    expect(formatMessage(restored.jobs[0].events[1].message)).toContain('字幕与翻译断点已保留')
    expect(restored.jobs[0].lastGlossarySent).toBeNull()
    expect(restored.jobs[0].requests).toBe(0)
    expect(restored.jobs[0].usage.completion_tokens).toBe(0)
    saveWorkspace(storage, restored)
    expect(loadWorkspace(storage).jobs[0].events).toHaveLength(2)
  })

  it('isolates unreadable tasks without losing their original data on later writes or backups', async () => {
    const workspace = workspaceFixture()
    const bad: any = structuredClone(workspace.jobs[0])
    Object.assign(bad, {
      id: 'broken-task',
      completedChunks: 1,
      translations: { 1: '已花费请求得到的译文' },
      apiKey: 'must-not-export',
    })
    workspace.jobs.push(bad)
    const storage = new MemoryStorage()
    saveWorkspace(storage, workspace)
    const restored = loadWorkspace(storage)
    expect(restored.jobs).toHaveLength(1)
    expect(restored.recovery).toHaveLength(1)
    expect(restored.recovery[0].data).toEqual(bad)
    await mutateWorkspace(
      storage,
      (action) => Promise.resolve(action()),
      (latest) => {
        latest.jobs[0].name = 'Still editable'
      },
    )
    expect(loadWorkspace(storage).recovery[0].data).toEqual(bad)
    const backup = makeBackup(restored.jobs, restored.recovery)
    expect(backup).not.toContain('must-not-export')
    const imported = parseBackup(backup)
    expect(imported.jobs).toHaveLength(1)
    expect(imported.recovery).toHaveLength(1)
    expect((imported.recovery[0].data as any).translations[1]).toBe(bad.translations[1])
    const repaired = { ...bad, translations: { ...bad.translations, 2: '补回缺失的译文' } }
    expect(
      parseBackup(JSON.stringify({ kind: 'muyu-backup', version: 3, jobs: [repaired] })).jobs[0]
        .completedChunks,
    ).toBe(1)
  })

  it('assigns stable identities to legacy terms and preserves them after deletion and rename', () => {
    const workspace = workspaceFixture()
    workspace.jobs[0].glossary.push({ source: 'Second Term', target: '第二项' })
    const first = validateJob(workspace.jobs[0])
    expect(validateJob(workspace.jobs[0]).glossary.map((term) => term.id)).toEqual(
      first.glossary.map((term) => term.id),
    )
    const id = first.glossary[1].id
    first.glossary.shift()
    first.glossary[0].source = 'Renamed Term'
    expect(validateJob(first).glossary[0].id).toBe(id)
  })
})
