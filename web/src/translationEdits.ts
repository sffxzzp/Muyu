import { useTextEdits, type EditHooks } from './textEdits'
import { normalizeTranslation } from './validation'
import type { Job } from './types'

export function useTranslationEdits(hooks: Pick<EditHooks<number>, 'read' | 'save'>) {
  const edits = useTextEdits({
    ...hooks,
    normalize: (_field, text) => normalizeTranslation(text),
    incompleteMessage: '请完成当前译文输入后再导出',
  })
  return {
    ...edits,
    snapshot: (jobs: Job[]): Job[] =>
      jobs.map((job) => {
        const copy = { ...job, translations: { ...job.translations } }
        for (const draft of edits.all.value) {
          if (
            draft.jobId !== job.id ||
            !copy.translations[draft.field] ||
            (draft.value === draft.savedInput && !draft.saving)
          )
            continue
          try {
            copy.translations[draft.field] = normalizeTranslation(draft.value)
          } catch {
            /* An invalid draft cannot replace a valid saved translation. */
          }
        }
        return copy
      }),
  }
}
