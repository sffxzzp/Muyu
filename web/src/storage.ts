import { errorMessage, isMessage, MessageError, message } from './messages'
import { termKey } from './text'
import { boundedText, limits, normalizeMemory, normalizeTranslation } from './validation'
export { normalizeTranslation } from './validation'
import {
  defaultProfile,
  defaultSettings,
  validateSettings,
  type Workspace,
  type Job,
  type Term,
  type APIProfile,
  type Settings,
  type RecoveryRecord,
} from './types'
import { migrateJob } from './migrations'
import { validateDocument } from './subtitle'

export const STORAGE_KEY = 'muyu.workspace.v1'
export const WRITE_LOCK = 'muyu-workspace-write'
export const GLOSSARY_HISTORY_LIMIT = 20
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export class StorageError extends MessageError {}

export function emptyWorkspace(): Workspace {
  return {
    version: 3,
    revision: 0,
    jobs: [],
    recovery: [],
    preferences: { ...defaultProfile, rememberKey: false, apiKey: '' },
  }
}

function record(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function string(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function profile(value: unknown): APIProfile {
  if (
    !record(value) ||
    !boundedText(value.baseUrl, limits.baseUrl) ||
    !boundedText(value.model, limits.model) ||
    !value.model.trim() ||
    !['max_tokens', 'max_completion_tokens'].includes(value.tokenParameter)
  )
    throw new Error('接口配置无效')
  let url: URL
  try {
    url = new URL(value.baseUrl)
  } catch {
    throw new Error('接口地址无效')
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('接口地址无效')
  return { baseUrl: value.baseUrl, model: value.model, tokenParameter: value.tokenParameter }
}

function terms(value: unknown, identities = false): Term[] {
  if (!Array.isArray(value)) throw new Error('术语库无效')
  const seen = new Set<string>()
  const ids = new Set<string>()
  const reserved = new Set(
    value.flatMap((term) => (record(term) && typeof term.id === 'string' ? [term.id] : [])),
  )
  return value.map((term, index) => {
    if (
      !record(term) ||
      !boundedText(term.source, limits.termSource) ||
      !term.source.trim() ||
      !boundedText(term.target, limits.termTarget) ||
      !term.target.trim() ||
      !boundedText(term.note ?? '', limits.termNote) ||
      seen.has(termKey(term.source))
    )
      throw new Error('术语条目无效')
    seen.add(termKey(term.source))
    const result: Term = {
      source: term.source,
      target: term.target,
      note: term.note ?? '',
      locked: !!term.locked,
    }
    if (identities) {
      let id = term.id
      if (id === undefined) {
        id = `legacy-${index}`
        while (reserved.has(id) || ids.has(id)) id += '-new'
      }
      if (!string(id, 100) || !/^[a-zA-Z0-9-]+$/.test(id) || ids.has(id)) throw new Error('术语标识无效')
      ids.add(id)
      result.id = id
    }
    return result
  })
}

export function validateJob(value: unknown): Job {
  if (
    !record(value) ||
    !string(value.id, 100) ||
    !/^[a-zA-Z0-9-]+$/.test(value.id) ||
    !string(value.name, 500) ||
    !finite(value.createdAt) ||
    !finite(value.updatedAt) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  )
    throw new Error('任务标识无效')
  const doc = validateDocument(value.document),
    apiProfile = profile(value.profile)
  if (!record(value.settings)) throw new Error('任务参数无效')
  const settings = Object.fromEntries(
    Object.keys(defaultSettings).map((key) => [key, value.settings[key]]),
  ) as unknown as Settings
  validateSettings(settings)
  if (!Array.isArray(value.chunks) || value.chunks.length < 1 || value.chunks.length > doc.cues.length)
    throw new Error('分块记录无效')
  let end = 0
  const chunks = value.chunks.map((chunk: any) => {
    if (
      !record(chunk) ||
      chunk.start !== end ||
      !Number.isInteger(chunk.end) ||
      chunk.end <= end ||
      chunk.end - end > 100 ||
      chunk.end > doc.cues.length
    )
      throw new Error('分块记录不连续')
    end = chunk.end
    return { start: chunk.start, end: chunk.end }
  })
  if (
    end !== doc.cues.length ||
    !Number.isInteger(value.completedChunks) ||
    value.completedChunks < 0 ||
    value.completedChunks > chunks.length
  )
    throw new Error('翻译断点无效')
  const completed = value.completedChunks > 0 ? chunks[value.completedChunks - 1].end : 0
  if (!record(value.translations) || Object.keys(value.translations).length !== completed)
    throw new Error('断点与译文数量不一致')
  const translations: Record<string, string> = {}
  for (let id = 1; id <= completed; id++) {
    const text = value.translations[id]
    if (typeof text !== 'string') throw new Error('断点包含缺失的译文')
    translations[id] = normalizeTranslation(text)
  }
  const glossary = terms(value.glossary, true)
  if (!Array.isArray(value.glossaryHistory) || value.glossaryHistory.length > GLOSSARY_HISTORY_LIMIT)
    throw new Error('术语携带记录无效')
  const glossaryHistory = value.glossaryHistory.map((round: any) => {
    if (
      !record(round) ||
      !Number.isInteger(round.chunk) ||
      round.chunk < 1 ||
      round.chunk > value.completedChunks ||
      !finite(round.at)
    )
      throw new Error('术语携带记录无效')
    return { chunk: round.chunk, at: round.at, terms: terms(round.terms) }
  })
  const lastGlossarySent = value.lastGlossarySent ?? null
  if (
    lastGlossarySent !== null &&
    (!Number.isSafeInteger(lastGlossarySent) || lastGlossarySent < 0)
  )
    throw new Error('术语携带数量无效')
  if (
    !boundedText(value.styleNotes, limits.style) ||
    !isMessage(value.error ?? '') ||
    !Array.isArray(value.events) ||
    value.events.length > 120 ||
    !finite(value.requests) ||
    !record(value.usage)
  )
    throw new Error('任务状态无效')
  const events = value.events.map((e: any) => {
    if (
      !record(e) ||
      !finite(e.at) ||
      !isMessage(e.message) ||
      !['info', 'success', 'warning', 'error'].includes(e.kind)
    )
      throw new Error('运行记录无效')
    return { at: e.at, message: e.message, kind: e.kind as Job['events'][number]['kind'] }
  })
  const usage = {
    prompt_tokens: value.usage.prompt_tokens,
    completion_tokens: value.usage.completion_tokens,
    total_tokens: value.usage.total_tokens,
  }
  if (!Object.values(usage).every(finite)) throw new Error('用量记录无效')
  const status = completed === doc.cues.length ? 'completed' : value.status
  if (
    !['ready', 'paused', 'error', 'completed'].includes(status) ||
    (status === 'completed' && completed !== doc.cues.length)
  )
    throw new Error('任务状态无效')
  return {
    id: value.id,
    revision: value.revision,
    name: value.name,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    document: doc,
    settings,
    profile: apiProfile,
    chunks,
    completedChunks: value.completedChunks,
    translations,
    glossary,
    lastGlossarySent,
    glossaryHistory,
    styleNotes: value.styleNotes,
    status,
    error: value.error ?? '',
    events,
    requests: value.requests,
    usage,
  }
}

function validEvent(value: unknown): boolean {
  return (
    record(value) &&
    finite(value.at) &&
    isMessage(value.message) &&
    ['info', 'success', 'warning', 'error'].includes(value.kind)
  )
}

// Auxiliary history is recoverable. A damaged log must not make paid results
// inaccessible; document, translations, glossary and checkpoints remain strict.
function restoreJob(raw: unknown, version: number): Job {
  const input = version === 1 ? migrateJob(raw) : raw
  if (!record(input)) return validateJob(input)
  const value = { ...input }
  let repaired = false
  const events = Array.isArray(value.events) ? value.events.filter(validEvent).slice(-120) : []
  if (!Array.isArray(value.events) || events.length !== value.events.length) repaired = true
  value.events = events
  if (!isMessage(value.error ?? '')) {
    value.error = ''
    repaired = true
  }
  const history = Array.isArray(value.glossaryHistory) ? value.glossaryHistory : []
  value.glossaryHistory = history
    .filter((round) => {
      try {
        if (
          !record(round) ||
          !Number.isInteger(round.chunk) ||
          round.chunk < 1 ||
          round.chunk > value.completedChunks ||
          !finite(round.at)
        )
          return false
        terms(round.terms)
        return true
      } catch {
        return false
      }
    })
    .slice(-GLOSSARY_HISTORY_LIMIT)
  if (!Array.isArray(input.glossaryHistory) || history.length !== value.glossaryHistory.length)
    repaired = true
  if (
    value.lastGlossarySent != null &&
    (!Number.isSafeInteger(value.lastGlossarySent) || value.lastGlossarySent < 0)
  ) {
    value.lastGlossarySent = null
    repaired = true
  }
  if (!finite(value.requests)) {
    value.requests = 0
    repaired = true
  }
  value.usage = { ...value.usage }
  for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (!finite(value.usage[field])) {
      value.usage[field] = 0
      repaired = true
    }
  }
  if (repaired) {
    value.events = [
      ...events.slice(-119),
      {
        at: Date.now(),
        kind: 'warning',
        message: message('读取时已忽略损坏的运行记录或统计，字幕与翻译断点已保留'),
      },
    ]
  }
  return validateJob(value)
}

export interface RestoredJobs {
  jobs: Job[]
  recovery: RecoveryRecord[]
}

function restoreJobs(input: unknown[], version: number, savedRecovery: unknown = []): RestoredJobs {
  const jobs: Job[] = [],
    recovery: RecoveryRecord[] = []
  const ids = new Set<string>()
  const quarantine = (data: unknown, error: unknown, name?: string, id?: string) => {
    let recordID =
      typeof id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(id) ? id : `recovery-${recovery.length}`
    while (recovery.some((item) => item.id === recordID)) recordID += '-copy'
    recovery.push({
      id: recordID,
      name: name ?? (record(data) && string(data.name, 500) ? data.name : ''),
      error: errorMessage(error),
      data,
    })
  }
  for (const raw of input) {
    try {
      const job = restoreJob(raw, version)
      if (ids.has(job.id)) throw new Error('任务 ID 重复')
      ids.add(job.id)
      jobs.push(job)
    } catch (error) {
      quarantine(raw, error)
    }
  }
  if (Array.isArray(savedRecovery)) {
    for (const item of savedRecovery) {
      if (record(item) && 'data' in item && isMessage(item.error) && string(item.name, 500))
        quarantine(item.data, new MessageError(item.error), item.name, item.id)
      else quarantine(item, new Error('恢复记录格式无效'))
    }
  } else quarantine(savedRecovery, new Error('恢复记录格式无效'))
  return { jobs, recovery }
}

export function loadWorkspace(storage: StorageLike): Workspace {
  let raw: string | null
  try {
    raw = storage.getItem(STORAGE_KEY)
  } catch {
    throw new StorageError('浏览器禁止了 localStorage，启用本站存储后才能保存翻译进度')
  }
  if (!raw) return emptyWorkspace()
  try {
    const value: unknown = JSON.parse(raw)
    if (!record(value) || ![1, 2, 3].includes(value.version)) throw new Error('记录格式无效')
    if (!Array.isArray(value.jobs) || value.jobs.length > 100) throw new Error('任务数量无效')
    const restored = restoreJobs(value.jobs, value.version, value.recovery)
    const p = profile(value.preferences)
    if (!finite(value.revision)) throw new Error('记录格式无效')
    return {
      version: 3,
      revision: value.revision,
      ...restored,
      preferences: {
        ...p,
        rememberKey: !!value.preferences.rememberKey,
        apiKey:
          value.preferences.rememberKey && boundedText(value.preferences.apiKey, limits.apiKey)
            ? value.preferences.apiKey
            : '',
      },
    }
  } catch (error) {
    if (error instanceof StorageError) throw error
    throw new StorageError('浏览器中的任务记录无法读取，原始数据仍保留；可先导出备份，再清空重建')
  }
}

export function saveWorkspace(storage: StorageLike, workspace: Workspace): number {
  const value = {
    ...workspace,
    revision: workspace.revision + 1,
    preferences: {
      ...workspace.preferences,
      apiKey: workspace.preferences.rememberKey ? workspace.preferences.apiKey : '',
    },
  }
  const serialized = JSON.stringify(value)
  try {
    storage.setItem(STORAGE_KEY, serialized)
  } catch {
    throw new StorageError(
      '浏览器存储空间不足或不可写，翻译已暂停。请导出任务备份，清理旧任务后再继续；当前页面保留了尚未保存的结果',
    )
  }
  workspace.revision = value.revision
  return new Blob([serialized]).size
}

export type Exclusive = <T>(action: () => T | Promise<T>) => Promise<T>

// Human edits only touch saved cues. A stale editor must not silently replace
// another tab's correction to the same line.
export function applyTranslationEdit(job: Job, cueId: number, text: string, previous: string): string {
  const completed = job.completedChunks ? job.chunks[job.completedChunks - 1].end : 0
  if (!Number.isInteger(cueId) || cueId < 1 || cueId > completed || !job.translations[cueId])
    throw new Error('这条字幕尚未完成保存，请稍后再编辑')
  const value = normalizeTranslation(text)
  if (job.translations[cueId] !== previous && job.translations[cueId] !== value)
    throw new Error('这条译文已在其他标签页修改，草稿已保留，请核对后再保存')
  job.translations[cueId] = value
  job.revision++
  job.updatedAt = Date.now()
  return value
}

// The runner adds new cues, while saved cues may have been corrected during
// its request. Read and merge under WRITE_LOCK, never from a stale snapshot.
export function mergeJobCheckpoint(saved: Job, checkpoint: Job): Job {
  if (saved.id !== checkpoint.id || saved.completedChunks > checkpoint.completedChunks)
    throw new Error('任务进度已在其他标签页更新，请刷新后继续')
  return {
    ...checkpoint,
    revision: saved.revision + 1,
    updatedAt: Math.max(saved.updatedAt, checkpoint.updatedAt),
    translations: { ...checkpoint.translations, ...saved.translations },
  }
}

// Reload under a short write lock and apply only the caller's changes. A tab
// must never save its stale, entire in-memory workspace over another tab's work.
export async function mutateWorkspace(
  storage: StorageLike,
  exclusive: Exclusive,
  change: (latest: Workspace) => void,
): Promise<{ workspace: Workspace; bytes: number }> {
  return exclusive(() => {
    const latest = loadWorkspace(storage)
    change(latest)
    const bytes = saveWorkspace(storage, latest)
    return { workspace: latest, bytes }
  })
}

export function makeBackup(jobs: Job[], recovery: RecoveryRecord[] = []): string {
  return JSON.stringify(
    { kind: 'muyu-backup', version: 3, exportedAt: new Date().toISOString(), jobs, recovery },
    (key, value) => (/^api[_-]?key$/i.test(key) ? undefined : value),
    2,
  )
}

export function redactRecoveryRecord(raw: string): string {
  try {
    return JSON.stringify(
      JSON.parse(raw),
      (key, value) => (/^api[_-]?key$/i.test(key) ? undefined : value),
      2,
    )
  } catch {
    /* Malformed JSON still gets credential redaction below. */
  }
  // Recovery exports may contain malformed JSON. Remove credential fields
  // even when an interrupted/corrupt string has no closing quote.
  return raw.replace(/("apiKey"\s*:\s*)(?:"(?:\\[\s\S]|[^"\\])*"|[\s\S]*$)/g, '$1"[removed]"')
}

export function parseBackup(raw: string): RestoredJobs {
  if (raw.length > 15 * 1024 * 1024) throw new Error('备份文件过大')
  const value: unknown = JSON.parse(raw)
  if (
    !record(value) ||
    value.kind !== 'muyu-backup' ||
    ![1, 2, 3].includes(value.version) ||
    !Array.isArray(value.jobs) ||
    value.jobs.length > 100
  )
    throw new Error('请选择幕语导出的任务备份文件')
  return restoreJobs(value.jobs, value.version, value.recovery)
}

export type MemoryField = 'style' | `term:${string}:${'source' | 'target' | 'note'}`
export const termField = (id: string, field: 'source' | 'target' | 'note'): MemoryField =>
  `term:${id}:${field}`
export function memoryValue(job: Job | undefined, field: MemoryField): string | undefined {
  if (!job) return
  if (field === 'style') return job.styleNotes
  const [, id, property] = field.split(':')
  const term = job.glossary.find((term) => term.id === id)
  return term ? (term[property as 'source' | 'target' | 'note'] ?? '') : undefined
}
export const normalizeMemoryField = (field: MemoryField, text: string) =>
  normalizeMemory(field === 'style' ? 'style' : (field.split(':')[2] as 'source' | 'target' | 'note'), text)

export function applyMemoryEdit(job: Job, field: MemoryField, input: string, previous: string): void {
  const current = memoryValue(job, field)
  if (current === undefined) throw new Error('这个术语已在其他标签页删除，草稿仍保留，可备份或复制后重新添加')
  const value = normalizeMemoryField(field, input)
  if (current !== previous && current !== value)
    throw new Error('此内容已在其他标签页修改，草稿已保留，请核对后再保存')
  if (field === 'style') job.styleNotes = value
  else {
    const [, id, property] = field.split(':')
    const term = job.glossary.find((term) => term.id === id)!
    if (
      property === 'source' &&
      job.glossary.some((other) => other !== term && termKey(other.source) === termKey(value))
    )
      throw new Error('这个术语已存在')
    term[property as 'source' | 'target' | 'note'] = value
    term.locked = true
  }
}
