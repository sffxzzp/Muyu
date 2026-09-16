import { errorMessage, type Message } from './messages'
import { computed, ref } from 'vue'
import { t } from './i18n'
import { locale } from './preferences'
import { apiKeyFor, jobBusy, notice, runtimeFor, workspace } from './workspace'
import type { Job } from './types'

export const toast = ref<Message>('')
let toastTimer: ReturnType<typeof setTimeout>
export function flash(message: Message) {
  toast.value = message
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = ''
  }, 4500)
}
export function fail(error: unknown) {
  notice.value = errorMessage(error)
}
export async function safely(action: () => unknown) {
  try {
    await action()
  } catch (error) {
    fail(error)
  }
}
export const modelReady = computed(() => !!apiKeyFor(workspace.preferences))
export function hostName(url: string) {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
export function dateLabel(value: number) {
  return new Intl.DateTimeFormat(locale.value, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value)
}
export function statusLabel(job: Job) {
  const state = runtimeFor(job.id)
  if (state) {
    if (state.pauseRequested) return t('正在暂停')
    if (state.phase === 'queued') return t('排队中')
    if (state.phase === 'waiting') return state.waitReason === 'retry' ? t('等待重试') : t('等待限流')
    return t('翻译中')
  }
  return {
    ready: t('待开始'),
    paused: t('已暂停'),
    error: t('需要重试'),
    completed: t('已完成'),
  }[job.status]
}
export function statusTone(job: Job) {
  return job.status === 'completed'
    ? 'success'
    : job.status === 'error'
      ? 'error'
      : jobBusy(job.id)
        ? 'active'
        : 'neutral'
}

export const recent = computed(() => [...workspace.jobs].sort((a, b) => b.updatedAt - a.updatedAt))
