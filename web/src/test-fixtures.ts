import { buildChunks, defaultProfile, defaultSettings, type Job } from './types'
import { emptyWorkspace, type StorageLike } from './storage'

export class MemoryStorage implements StorageLike {
  values = new Map<string, string>()
  full = false
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    if (this.full) throw new Error('quota exceeded')
    this.values.set(key, value)
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
}

export function jobFixture(count = 6): Job {
  const settings = {
    ...defaultSettings,
    targetChunkSize: 2,
    maxChunkSize: 2,
    background: '财务教育背景',
    rpm: 20,
  }
  const cues = Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    start: i * 2000,
    end: i * 2000 + 1800,
    text: `Source cue ${i + 1}.`,
  }))
  return {
    id: 'test-job-1',
    revision: 0,
    name: 'lesson.srt',
    createdAt: 100,
    updatedAt: 100,
    document: { format: 'srt', cues },
    settings,
    profile: { ...defaultProfile },
    chunks: buildChunks(cues, settings),
    completedChunks: 0,
    translations: {},
    glossary: [{ source: 'cash flow', target: '现金流', locked: true }],
    lastGlossarySent: null,
    glossaryHistory: [],
    styleNotes: '',
    status: 'ready',
    error: '',
    events: [],
    requests: 0,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

export function workspaceFixture(count = 6) {
  const workspace = emptyWorkspace()
  workspace.jobs = [jobFixture(count)]
  return workspace
}
