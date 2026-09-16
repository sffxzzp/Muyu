import { asMessage, MessageError, message, type Message } from './messages'
import { termKey } from './text'
import { boundedText, limits, normalizeMemory } from './validation'
export { cleanText } from './text'
import { chunkCues } from './chunking'

export type Format = 'srt' | 'vtt'
export interface Cue {
  id: number
  identifier?: string
  start: number
  end: number
  settings?: string
  text: string
}
export interface SubtitleDocument {
  format: Format
  header?: string
  metadata?: { before: number; text: string }[]
  cues: Cue[]
}
export interface Term {
  // Local identity. Never included in the model prompt.
  id?: string
  source: string
  target: string
  note?: string
  locked?: boolean
}
export interface Chunk {
  start: number
  end: number
}
export interface APIProfile {
  baseUrl: string
  model: string
  tokenParameter: 'max_tokens' | 'max_completion_tokens'
}
export interface Settings {
  sourceLanguage: string
  targetLanguage: string
  background: string
  targetChunkSize: number
  maxChunkSize: number
  maxChunkCharacters: number
  contextSize: number
  futureContextSize: number
  rpm: number
  maxRetries: number
  temperature: number | null
  maxTokens: number
  timeoutSeconds: number
}
export interface Usage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}
export interface JobEvent {
  at: number
  message: Message
  kind: 'info' | 'success' | 'warning' | 'error'
}
export type JobStatus = 'ready' | 'paused' | 'error' | 'completed'
export interface GlossaryRound {
  chunk: number
  at: number
  terms: Term[]
}
export interface Job {
  id: string
  revision: number
  name: string
  createdAt: number
  updatedAt: number
  document: SubtitleDocument
  settings: Settings
  profile: APIProfile
  chunks: Chunk[]
  completedChunks: number
  translations: Record<string, string>
  glossary: Term[]
  lastGlossarySent: number | null
  glossaryHistory: GlossaryRound[]
  styleNotes: string
  status: JobStatus
  error: Message
  events: JobEvent[]
  requests: number
  usage: Usage
}
export interface Workspace {
  version: 3
  revision: number
  jobs: Job[]
  recovery: RecoveryRecord[]
  preferences: APIProfile & { rememberKey: boolean; apiKey: string }
}
export interface RecoveryRecord {
  id: string
  name: string
  error: Message
  data: unknown
}
export interface TranslationResult {
  translations: { id: number; text: string }[]
  glossary: Term[]
  glossarySent: number
  glossaryUsed: Term[]
  styleNotes: string
  warnings: Message[]
  usage: Usage
}

export type TranslationTransport = 'direct' | 'server'
export interface TranslationRequest extends APIProfile {
  apiKey: string
  sourceLanguage: string
  targetLanguage: string
  background: string
  styleNotes: string
  glossary: Term[]
  cues: { id: number; text: string }[]
  context: { source: string; target: string }[]
  futureContext: { id: number; text: string }[]
  temperature: number | null
  maxTokens: number
  timeoutSeconds: number
}

export const defaultProfile: APIProfile = {
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  model: 'openai/gpt-oss-20b',
  tokenParameter: 'max_tokens',
}
export const defaultSettings: Settings = {
  sourceLanguage: 'auto',
  targetLanguage: '简体中文',
  background: '',
  targetChunkSize: 15,
  maxChunkSize: 25,
  maxChunkCharacters: 6000,
  contextSize: 3,
  futureContextSize: 3,
  rpm: 20,
  maxRetries: 3,
  temperature: 0.1,
  maxTokens: 8192,
  timeoutSeconds: 120,
}

export function localID(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export function doneCount(job: Job): number {
  return job.completedChunks ? job.chunks[job.completedChunks - 1].end : 0
}
export function percent(job: Job): number {
  return Math.round((doneCount(job) / job.document.cues.length) * 100)
}
export function timestamp(ms: number, full = true): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, '0')
  const hours = Math.floor(ms / 3600000)
  const minutes = Math.floor(ms / 60000) % 60
  const seconds = Math.floor(ms / 1000) % 60
  return `${full || hours ? pad(hours) + ':' : ''}${pad(minutes)}:${pad(seconds)}${full ? '.' + pad(ms % 1000, 3) : ''}`
}
export function duration(doc: SubtitleDocument): string {
  return timestamp(
    doc.cues.reduce((max, cue) => Math.max(max, cue.end), 0),
    false,
  )
}
export function event(job: Job, message: Message, kind: JobEvent['kind'] = 'info'): void {
  job.events.push({ at: Date.now(), message: asMessage(message), kind })
  if (job.events.length > 120) job.events.splice(0, job.events.length - 120)
}

export function validateSettings(settings: Settings): void {
  if (
    !settings.sourceLanguage?.trim() ||
    !settings.targetLanguage?.trim() ||
    !boundedText(settings.sourceLanguage, limits.language) ||
    !boundedText(settings.targetLanguage, limits.language)
  )
    throw new Error('请填写有效的源语言和目标语言')
  if (settings.sourceLanguage === settings.targetLanguage) throw new Error('源语言和目标语言需要不同')
  const bounds: [keyof Settings, number, number][] = [
    ['targetChunkSize', 1, 100],
    ['maxChunkSize', 1, 100],
    ['maxChunkCharacters', 500, 30000],
    ['contextSize', 0, 20],
    ['futureContextSize', 0, 20],
    ['rpm', 1, 600],
    ['maxRetries', 0, 8],
    ['maxTokens', 256, 32768],
    ['timeoutSeconds', 10, 180],
  ]
  for (const [key, min, max] of bounds)
    if (!Number.isInteger(settings[key]) || Number(settings[key]) < min || Number(settings[key]) > max)
      throw new MessageError(message('参数 {0} 必须是 {1}～{2} 之间的整数', { 0: key, 1: min, 2: max }))
  if (settings.maxChunkSize < settings.targetChunkSize) throw new Error('块上限不能小于目标块大小')
  if (
    settings.temperature !== null &&
    (!Number.isFinite(settings.temperature) || settings.temperature < 0 || settings.temperature > 2)
  )
    throw new Error('Temperature 必须在 0～2 之间')
  if (!boundedText(settings.background, limits.background))
    throw new Error('背景设定过长，请控制在 8000 个汉字以内')
}

export function buildChunks(cues: Cue[], settings: Settings): Chunk[] {
  validateSettings(settings)
  return chunkCues(cues, settings)
}

export function updateJobSettings(job: Job, settings: Settings): void {
  validateSettings(settings)
  if (
    job.completedChunks &&
    (settings.sourceLanguage !== job.settings.sourceLanguage ||
      settings.targetLanguage !== job.settings.targetLanguage)
  )
    throw new Error('已有译文，源语言和目标语言不能更改')
  const rechunk = (['sourceLanguage', 'targetChunkSize', 'maxChunkSize', 'maxChunkCharacters'] as const).some(
    (field) => settings[field] !== job.settings[field],
  )
  if (rechunk) {
    const completed = doneCount(job)
    job.chunks = [
      ...job.chunks.slice(0, job.completedChunks),
      ...buildChunks(job.document.cues.slice(completed), settings).map(({ start, end }) => ({
        start: start + completed,
        end: end + completed,
      })),
    ]
  }
  job.settings = { ...settings }
}

export function parseSeedTerms(text: string): Term[] {
  const terms: Term[] = [],
    seen = new Set<string>()
  for (const line of text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)) {
    const separator = line.indexOf('=')
    if (separator < 1) throw new Error('预设术语请按「原文 = 译文」填写，每行一条')
    const source = normalizeMemory('source', line.slice(0, separator)),
      target = normalizeMemory('target', line.slice(separator + 1))
    const key = termKey(source)
    if (seen.has(key)) throw new Error('预设术语包含空白、重复或过长的条目')
    seen.add(key)
    terms.push({ id: localID(), source, target, locked: true })
  }
  return terms
}
