import { describe, expect, it } from 'vitest'
import { defaultProfile, defaultSettings, type TranslationRequest, updateJobSettings } from './types'
import { jobFixture } from './test-fixtures'
import { applyTranslationEdit, validateJob } from './storage'
import { parseTranslation, prepareTranslation } from './translation'
import { renderSubtitle } from './subtitle'
import { normalizeMemory, normalizeTranslation } from './validation'

const request = (): TranslationRequest => ({
  ...defaultProfile,
  ...defaultSettings,
  apiKey: 'unit-test-placeholder',
  cues: [{ id: 1, text: 'Source.' }],
  context: [],
  futureContext: [],
  glossary: [],
  styleNotes: '',
})

describe('shared input and output limits', () => {
  it.each(['a'.repeat(9000), '字'.repeat(10666), '😀'.repeat(8000)])(
    'accepts the same long translation for model output, storage, editing and export',
    (text) => {
      const req = request()
      const result = parseTranslation(
        JSON.stringify({ translations: [{ id: 1, text }], glossary: [], style_notes: '' }),
        req,
        [],
      )
      const job = jobFixture(1)
      Object.assign(job, {
        completedChunks: 1,
        translations: { 1: result.translations[0].text },
        status: 'completed',
      })
      const restored = validateJob(job)
      expect(applyTranslationEdit(restored, 1, text, text)).toBe(text)
      expect(
        renderSubtitle(restored.document, restored.translations, 'srt', 'translation', 'original-first'),
      ).toContain(text)
    },
  )

  it.each(['字'.repeat(10667), '😀'.repeat(8001), 'null\0character'])(
    'rejects overlong or null-containing translations at every boundary',
    (text) => {
      const req = request()
      expect(() => normalizeTranslation(text)).toThrow()
      expect(() =>
        parseTranslation(
          JSON.stringify({ translations: [{ id: 1, text }], glossary: [], style_notes: '' }),
          req,
          [],
        ),
      ).toThrow()
      const job = jobFixture(1)
      Object.assign(job, { completedChunks: 1, translations: { 1: text }, status: 'completed' })
      expect(() => validateJob(job)).toThrow()
      expect(() =>
        renderSubtitle(job.document, job.translations, 'srt', 'translation', 'original-first'),
      ).toThrow()
    },
  )

  it('uses the same memory limits for editing, storage and request preparation', () => {
    const req = request()
    req.styleNotes = normalizeMemory('style', 'a'.repeat(6000))
    req.glossary = [
      {
        source: normalizeMemory('source', '字'.repeat(100)),
        target: normalizeMemory('target', 'a'.repeat(500)),
        note: normalizeMemory('note', '字'.repeat(166)),
      },
    ]
    expect(() => prepareTranslation(req)).not.toThrow()
    const job = jobFixture()
    job.glossary = req.glossary
    job.styleNotes = req.styleNotes
    expect(() => validateJob(job)).not.toThrow()
    expect(() => normalizeMemory('style', '字'.repeat(2001))).toThrow()
    expect(() => normalizeMemory('source', '字'.repeat(101))).toThrow()
  })

  it('never changes completed chunk boundaries or languages when updating settings', () => {
    const job = jobFixture(6)
    Object.assign(job, { completedChunks: 1, translations: { 1: '一', 2: '二' } })
    const before = structuredClone(job)
    expect(() => updateJobSettings(job, { ...job.settings, targetLanguage: '日本語' })).toThrow()
    expect(job).toEqual(before)
    updateJobSettings(job, { ...job.settings, targetChunkSize: 1, maxChunkSize: 1 })
    expect(job.chunks[0]).toEqual(before.chunks[0])
    expect(job.translations).toEqual(before.translations)
    expect(job.completedChunks).toBe(1)
  })
})
