import { migrateMessage } from './legacyMessages'

const record = (value: any) => value && typeof value === 'object' && !Array.isArray(value)

// Only legacy input is normalized. Current records go through strict validation.
// Saved cue boundaries are never rebuilt, even when the chunker changes.
export function migrateJob(value: any): unknown {
  if (!record(value)) return value
  return {
    ...value,
    revision: 0,
    error: typeof value.error === 'string' ? migrateMessage(value.error) : value.error,
    events: Array.isArray(value.events)
      ? value.events.map((event: any) =>
          record(event) && typeof event.message === 'string'
            ? { ...event, message: migrateMessage(event.message) }
            : event,
        )
      : value.events,
    status: ['queued', 'running'].includes(value.status) ? 'paused' : value.status,
    settings: record(value.settings)
      ? {
          ...value.settings,
          futureContextSize: value.settings.futureContextSize ?? 0,
          useGlossary: value.settings.useGlossary ?? true,
        }
      : value.settings,
    lastGlossarySent: value.lastGlossarySent ?? null,
    glossaryHistory: value.glossaryHistory ?? [],
  }
}
