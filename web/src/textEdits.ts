import { errorMessage, MessageError, type Message } from './messages'
import { computed, reactive, shallowReactive } from 'vue'

export interface EditHooks<Field extends string | number> {
  read(jobId: string, field: Field): string | undefined
  save(jobId: string, field: Field, value: string, previous: string): Promise<void>
  normalize(field: Field, value: string): string
  incompleteMessage: string
}
export interface TextDraft<Field extends string | number> {
  jobId: string
  field: Field
  value: string
  previous: string
  savedInput: string
  focused: boolean
  composing: boolean
  saving: boolean
  error: Message
}

export function useTextEdits<Field extends string | number>(hooks: EditHooks<Field>) {
  const drafts = shallowReactive<Record<string, TextDraft<Field>>>({})
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const pending = new Map<string, Promise<void>>()
  const key = (jobId: string, cueId: Field) => `${jobId}:${cueId}`
  const get = (jobId: string, cueId: Field) => drafts[key(jobId, cueId)]
  const unsavedCount = computed(
    () => Object.values(drafts).filter((draft) => draft.saving || draft.value !== draft.savedInput).length,
  )

  function cancelTimer(id: string) {
    clearTimeout(timers.get(id))
    timers.delete(id)
  }
  function ensure(jobId: string, cueId: Field) {
    const id = key(jobId, cueId)
    if (!drafts[id]) {
      const value = hooks.read(jobId, cueId)
      if (value === undefined) return
      drafts[id] = reactive({
        jobId,
        field: cueId,
        value,
        previous: value,
        savedInput: value,
        focused: false,
        composing: false,
        saving: false,
        error: '',
      }) as TextDraft<Field>
    }
    return drafts[id]
  }
  function begin(jobId: string, cueId: Field) {
    const draft = ensure(jobId, cueId)
    if (draft) draft.focused = true
  }
  function change(jobId: string, cueId: Field, value: string) {
    const draft = ensure(jobId, cueId)
    if (!draft) return
    draft.value = value
    draft.error = ''
    const id = key(jobId, cueId)
    cancelTimer(id)
    if (!draft.composing)
      timers.set(
        id,
        setTimeout(() => void save(jobId, cueId), 500),
      )
  }
  function startComposition(jobId: string, cueId: Field) {
    const draft = ensure(jobId, cueId)
    if (draft) draft.composing = true
    cancelTimer(key(jobId, cueId))
  }
  function endComposition(jobId: string, cueId: Field, value: string) {
    const draft = ensure(jobId, cueId)
    if (draft) draft.composing = false
    change(jobId, cueId, value)
  }
  async function blur(jobId: string, cueId: Field) {
    const draft = get(jobId, cueId)
    if (draft) {
      draft.focused = false
      draft.composing = false
      // Keep recovery actions stable when clicking them blurs the editor.
      if (draft.error) return
    }
    await save(jobId, cueId)
  }
  async function save(jobId: string, cueId: Field): Promise<void> {
    const id = key(jobId, cueId)
    cancelTimer(id)
    if (pending.has(id)) return pending.get(id)
    const draft = drafts[id]
    if (!draft || draft.composing) return
    const task = (async () => {
      draft.saving = true
      draft.error = ''
      try {
        while (drafts[id] === draft && !draft.composing && draft.value !== draft.savedInput) {
          const input = draft.value
          const value = hooks.normalize(cueId, input)
          await hooks.save(jobId, cueId, value, draft.previous)
          draft.previous = value
          // Keep the raw field text while focused. Trimming a trailing space
          // or newline during autosave would change the next word being typed.
          draft.savedInput = input
        }
        if (drafts[id] === draft && !draft.focused && !draft.composing) delete drafts[id]
      } catch (error) {
        draft.error = errorMessage(error)
      } finally {
        draft.saving = false
      }
    })()
    pending.set(id, task)
    try {
      await task
    } finally {
      pending.delete(id)
    }
  }
  function restore(jobId: string, cueId: Field) {
    const id = key(jobId, cueId)
    if (drafts[id]?.saving) return
    cancelTimer(id)
    delete drafts[id]
  }
  async function keepMine(jobId: string, cueId: Field) {
    const draft = get(jobId, cueId)
    if (!draft || draft.saving) return
    draft.previous = hooks.read(jobId, cueId) ?? draft.previous
    await save(jobId, cueId)
  }
  async function flush(jobId: string) {
    await Promise.all(
      Object.values(drafts)
        .filter((draft) => draft.jobId === jobId)
        .map((draft) => save(draft.jobId, draft.field)),
    )
    const failed = Object.values(drafts).find((draft) => draft.jobId === jobId && draft.error)
    if (failed) throw new MessageError(failed.error)
    if (Object.values(drafts).some((draft) => draft.jobId === jobId && draft.value !== draft.savedInput))
      throw new Error(hooks.incompleteMessage)
  }
  function retain(jobIds: Set<string>) {
    for (const [id, draft] of Object.entries(drafts)) {
      if (!jobIds.has(draft.jobId)) {
        cancelTimer(id)
        delete drafts[id]
      }
    }
  }
  function dispose() {
    for (const id of timers.keys()) cancelTimer(id)
  }
  return {
    get,
    begin,
    change,
    blur,
    startComposition,
    endComposition,
    save,
    restore,
    keepMine,
    flush,
    all: computed(() => Object.values(drafts)),
    retain,
    dispose,
    unsavedCount,
    value: (jobId: string, cueId: Field) => get(jobId, cueId)?.value ?? hooks.read(jobId, cueId) ?? '',
  }
}
