import { errorMessage } from './messages'
import { useTextEdits, type EditHooks } from './textEdits'
import {
  applyMemoryEdit,
  memoryValue,
  normalizeMemoryField,
  type MemoryField,
  type RestoredJobs,
} from './storage'
import type { Job } from './types'

export function useMemoryEdits(hooks: Pick<EditHooks<MemoryField>, 'read' | 'save'>) {
  const edits = useTextEdits({
    ...hooks,
    normalize: normalizeMemoryField,
    incompleteMessage: '请完成当前术语或风格输入后再继续',
  })
  return {
    ...edits,
    snapshot(jobs: Job[]): RestoredJobs {
      const result: RestoredJobs = { jobs: [], recovery: [] }
      for (const job of jobs) {
        const copy = { ...job, glossary: job.glossary.map((term) => ({ ...term })) }
        for (const draft of edits.all.value) {
          if (draft.jobId !== job.id || (draft.value === draft.savedInput && !draft.saving)) continue
          try {
            applyMemoryEdit(copy, draft.field, draft.value, memoryValue(copy, draft.field) ?? '')
          } catch (error) {
            // Deleted terms and invalid drafts remain exportable without making
            // the task itself unreadable on import.
            result.recovery.push({
              id: `draft-${result.recovery.length}`,
              name: job.name,
              error: errorMessage(error),
              data: {
                kind: 'muyu-edit-draft',
                jobId: job.id,
                field: draft.field,
                value: draft.value,
                previous: draft.previous,
              },
            })
          }
        }
        result.jobs.push(copy)
      }
      return result
    },
  }
}
