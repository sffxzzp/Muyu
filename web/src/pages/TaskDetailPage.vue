<script setup lang="ts">
import { message, MessageError } from '../messages'
import { computed, nextTick, onUnmounted, reactive, ref, watch } from 'vue'
import SubtitleComparison from '../components/SubtitleComparison.vue'
import MemoryField from '../components/MemoryField.vue'
import Icon from '../components/Icon.vue'
import Modal from '../components/Modal.vue'
import SettingsFields from '../components/SettingsFields.vue'
import { t, localize } from '../i18n'
import { locale } from '../preferences'
import { navigate, selectedId, view } from '../navigation'
import { fail, flash, safely, dateLabel, statusLabel, statusTone } from '../ui'
import { download } from '../files'
import { renderSubtitle } from '../subtitle'
import { termKey } from '../text'
import { memoryValue, termField } from '../storage'
import { limits, normalizeMemory } from '../validation'
import {
  busy,
  exportBackup,
  jobBusy,
  notice,
  pauseJob,
  runtimeFor,
  translationEdits,
  memoryEdits,
  unsavedEditCount,
  unsaved,
  updateJob,
  workspace,
} from '../workspace'
import { languageName } from '../languages'
import {
  updateJobSettings,
  localID,
  defaultSettings,
  doneCount,
  duration,
  percent,
  validateSettings,
  type Job,
  type Settings,
  type Term,
} from '../types'
import type { Runtime } from '../runner'
const emit = defineEmits<{ start: [job: Job]; api: [job: Job] }>()
const requestStart = (job: Job) => emit('start', job)
const openAPI = (job: Job) => emit('api', job)
const selected = computed(() => workspace.jobs.find((job) => job.id === selectedId.value))
const runtime = computed<Runtime>(
  () =>
    runtimeFor(selectedId.value) ?? {
      activeJobId: '',
      phase: 'idle',
      waitUntil: 0,
      waitReason: undefined,
      attempt: 0,
      pauseRequested: false,
    },
)
const now = ref(Date.now())
const ticker = setInterval(() => {
  now.value = Date.now()
}, 1000)
onUnmounted(() => clearInterval(ticker))
const detailTab = ref('subtitles')
const progressPanel = ref<HTMLElement>(),
  comparison = ref<InstanceType<typeof SubtitleComparison>>()
const currentChunk = computed(() => selected.value?.chunks[selected.value.completedChunks])
const selectedRunning = computed(() => !!selected.value && jobBusy(selected.value.id))
const currentRange = computed(() =>
  currentChunk.value
    ? t('第 {0}–{1} 条字幕', { 0: currentChunk.value.start + 1, 1: currentChunk.value.end })
    : '',
)
const phaseLabel = computed(() => {
  if (!selected.value || !currentChunk.value) return t('所有字幕均已完成')
  if (selectedRunning.value) {
    if (runtime.value.phase === 'pausing') return t('本块完成并保存后暂停')
    if (runtime.value.pauseRequested) return t('正在暂停…')
    if (runtime.value.phase === 'queued') return t('排队中，等待可用名额')
    if (runtime.value.phase === 'waiting')
      return runtime.value.waitReason === 'retry' ? t('等待重试') : t('等待下一轮请求')
    return runtime.value.attempt ? t('正在重试 · 第 {0} 次', { 0: runtime.value.attempt }) : t('正在翻译')
  }
  if (selected.value.status === 'error') return t('本块失败，等待重试')
  if (selected.value.status === 'paused') return t('已暂停，等待继续')
  return t('准备开始翻译')
})
const phaseIcon = computed(() => {
  if (selectedRunning.value && ['requesting', 'pausing'].includes(runtime.value.phase)) return 'loading'
  if (selectedRunning.value) return 'clock'
  if (selected.value?.status === 'error') return 'alert'
  if (!currentChunk.value) return 'success'
  if (selected.value?.status === 'ready') return 'play'
  return 'pause'
})
watch(selectedId, () => {
  detailTab.value = 'subtitles'
})
const orphanedDrafts = computed(() =>
  memoryEdits.all.value.filter(
    (draft) =>
      draft.jobId === selectedId.value &&
      memoryValue(selected.value, draft.field) === undefined &&
      draft.value !== draft.savedInput,
  ),
)
async function showCurrentChunk() {
  detailTab.value = 'subtitles'
  await nextTick()
  await comparison.value?.showCurrentChunk()
}
const newTerm = reactive({ source: '', target: '', note: '' })
function addTerm() {
  safely(async () => {
    await updateJob(selectedId.value, (job) => {
      const term: Term = {
        id: localID(),
        source: normalizeMemory('source', newTerm.source),
        target: normalizeMemory('target', newTerm.target),
        note: normalizeMemory('note', newTerm.note),
        locked: true,
      }
      if (!term.source || !term.target) throw new MessageError(message('请填写术语原文和译文'))
      if (job.glossary.some((item) => termKey(item.source) === termKey(term.source)))
        throw new MessageError(message('这个术语已存在，请直接编辑已有条目'))
      job.glossary.push(term)
    })
    Object.assign(newTerm, { source: '', target: '', note: '' })
  })
}
function removeTerm(id: string) {
  safely(() =>
    updateJob(selectedId.value, (job) => {
      job.glossary = job.glossary.filter((term) => term.id !== id)
    }),
  )
}
const editModal = ref(false),
  editSettings = ref<Settings>({ ...defaultSettings })
function openSettings() {
  notice.value = ''
  if (selected.value) {
    editSettings.value = { ...selected.value.settings }
    editModal.value = true
  }
}
function saveSettings() {
  safely(async () => {
    validateSettings(editSettings.value)
    await updateJob(selectedId.value, (job) => {
      updateJobSettings(job, editSettings.value)
    })
    editModal.value = false
    flash(message('参数已保存，将用于之后的请求'))
  })
}

const exportModal = ref(false),
  exportMode = ref('bilingual'),
  exportFormat = ref('srt'),
  exportOrder = ref('original-first'),
  exporting = ref(false)
function openExport() {
  if (selected.value) {
    exportFormat.value = selected.value.document.format
    exportModal.value = true
  }
}
async function exportSubtitle() {
  if (!selected.value) return
  const jobId = selected.value.id
  exporting.value = true
  try {
    await translationEdits.flush(jobId)
    const job = workspace.jobs.find((item) => item.id === jobId)
    if (!job) throw new MessageError(message('任务已被删除'))
    const content = renderSubtitle(
      job.document,
      job.translations,
      exportFormat.value,
      exportMode.value,
      exportOrder.value,
    )
    download(
      content,
      `${job.name.replace(/\.(srt|vtt)$/i, '')}.${exportMode.value === 'bilingual' ? 'bilingual' : job.settings.targetLanguage}.${exportFormat.value}`,
    )
    exportModal.value = false
    flash(message('字幕文件已导出'))
  } catch (error) {
    fail(error)
  } finally {
    exporting.value = false
  }
}
function exportGlossary() {
  safely(async () => {
    if (!selected.value) return
    await memoryEdits.flush(selected.value.id)
    download(
      JSON.stringify(
        {
          glossary: selected.value.glossary.map(({ source, target, note, locked }) => ({
            source,
            target,
            note,
            locked,
          })),
          styleNotes: selected.value.styleNotes,
        },
        null,
        2,
      ),
      'muyu-glossary.json',
      'application/json',
    )
  })
}

defineExpose({ showCurrentChunk })
</script>

<template>
  <template v-if="selected">
    <div class="detail-back">
      <button class="text-button" @click="navigate('tasks')">
        <Icon name="left" :size="15" />{{ t('返回任务记录') }}</button
      ><span>{{
        unsaved
          ? t('有进度尚未保存，请先备份')
          : unsavedEditCount
            ? t('有修改尚未保存')
            : t('已保存到当前浏览器')
      }}</span>
    </div>
    <section class="detail-heading">
      <div class="detail-file-title">
        <span class="file-icon large"><Icon name="captions" :size="27" /></span>
        <div>
          <h1>{{ selected.name }}</h1>
          <p>
            {{ selected.document.format.toUpperCase() }}<span>·</span
            >{{ languageName(selected.settings.sourceLanguage) }} <Icon name="arrow" :size="12" />
            {{ languageName(selected.settings.targetLanguage) }}<span>·</span
            >{{ t('时长 {0}', { 0: duration(selected.document) }) }}
          </p>
        </div>
      </div>
      <div class="detail-actions">
        <button class="button secondary" @click="exportBackup([selected])">
          <Icon name="json" :size="16" />{{ t('备份') }}</button
        ><button
          class="button primary"
          :disabled="selected.completedChunks !== selected.chunks.length"
          @click="openExport()"
        >
          <Icon name="download" :size="16" />{{ t('导出字幕') }}
        </button>
      </div>
    </section>
    <div class="detail-workspace">
      <aside ref="progressPanel" class="card progress-card" :aria-label="t('翻译进度')">
        <div class="progress-top">
          <span class="progress-label"><Icon name="list" :size="16" />{{ t('翻译进度') }}</span>
          <span class="status-badge" :class="statusTone(selected)">{{ statusLabel(selected) }}</span>
        </div>
        <h2 class="progress-count" aria-live="polite" aria-atomic="true">
          {{
            selected.status === 'completed'
              ? t('每一句，都已抵达。')
              : t('已完成 {0} / {1} 条字幕', {
                  0: doneCount(selected),
                  1: selected.document.cues.length,
                })
          }}
        </h2>
        <div class="large-progress">
          <div
            class="progress-track"
            role="progressbar"
            :aria-label="t('字幕翻译完成进度')"
            :aria-valuenow="percent(selected)"
            :aria-valuemin="0"
            :aria-valuemax="100"
            :aria-valuetext="
              t('已完成 {0} / {1} 条字幕', { 0: doneCount(selected), 1: selected.document.cues.length })
            "
          >
            <span :style="{ width: `${percent(selected)}%` }"></span>
          </div>
          <span>{{ percent(selected) }}<small>%</small></span>
        </div>
        <div class="current-step" :class="{ 'is-error': selected.status === 'error' }">
          <Icon :name="phaseIcon" :size="18" :class="{ spinning: phaseIcon === 'loading' }" />
          <div>
            <strong>{{ phaseLabel }}</strong>
            <span v-if="currentChunk">{{
              t('{0} · 第 {1} / {2} 块', {
                0: currentRange,
                1: selected.completedChunks + 1,
                2: selected.chunks.length,
              })
            }}</span>
            <span v-else>{{ t('{0} 条字幕，可逐条校对并导出', { 0: selected.document.cues.length }) }}</span>
            <span v-if="selectedRunning && runtime.transport" class="connection-route">{{
              t(runtime.transport === 'server' ? '服务器转发' : '浏览器直连')
            }}</span>
            <span v-if="selectedRunning && runtime.phase === 'waiting'" class="wait-countdown">
              {{ t('{0} 秒后继续', { 0: Math.max(0, Math.ceil((runtime.waitUntil - now) / 1000)) }) }}</span
            >
          </div>
        </div>
        <div class="progress-action">
          <button
            v-if="selectedRunning"
            class="button secondary"
            :disabled="runtime.pauseRequested"
            @click="safely(() => pauseJob(selectedId))"
          >
            <Icon name="pause" :size="16" />{{
              runtime.pauseRequested ? t('正在暂停…') : t('暂停翻译')
            }}</button
          ><button
            v-else-if="selected.completedChunks < selected.chunks.length"
            class="button primary"
            :disabled="selectedRunning"
            @click="requestStart(selected)"
          >
            <Icon :name="selected.status === 'error' ? 'retry' : 'play'" :size="16" />{{
              busy
                ? t('加入队列')
                : selected.completedChunks || selected.requests
                  ? t('继续翻译')
                  : t('开始翻译')
            }}
          </button>
          <span v-else class="progress-complete"><Icon name="success" :size="16" />{{ t('翻译完成') }}</span>
        </div>
        <p class="progress-explanation">{{ t('每完成一块，译文、术语与风格一同保存。') }}</p>
        <p v-if="selectedRunning" class="progress-explanation">
          {{ t('请求已发出时，当前块完成并保存后暂停；排队或等待时立即暂停。') }}
        </p>
        <div class="progress-details">
          <span
            ><Icon name="list" :size="14" />{{
              t('{0} / {1} 块', { 0: selected.completedChunks, 1: selected.chunks.length })
            }}</span
          ><span><Icon name="book" :size="14" />{{ t('{0} 个术语', { 0: selected.glossary.length }) }}</span
          ><span><Icon name="clock" :size="14" />{{ selected.settings.rpm }} RPM</span
          ><span><Icon name="sparkle" :size="14" />{{ t('{0} 次请求', { 0: selected.requests }) }}</span>
          <span class="progress-token-count">{{
            t('已用 {0} Token', { 0: selected.usage.total_tokens.toLocaleString(locale) })
          }}</span
          ><button :disabled="selectedRunning" class="text-button" @click="openSettings()">
            {{ t('调整参数') }}<Icon name="settings" :size="14" />
          </button>
        </div>
        <div v-if="selected.error" class="job-error">
          <Icon name="alert" :size="16" /><span>{{ localize(selected.error) }}</span
          ><button class="text-button" :disabled="selectedRunning" @click="openAPI(selected)">
            {{ t('检查 API 配置') }}
          </button>
        </div>
      </aside>
      <section class="card detail-card">
        <div class="detail-tabs" role="tablist" :aria-label="t('任务详情')">
          <button
            role="tab"
            :aria-selected="detailTab === 'subtitles'"
            :class="{ active: detailTab === 'subtitles' }"
            @click="detailTab = 'subtitles'"
          >
            <Icon name="captions" :size="17" />{{ t('字幕对照')
            }}<span>{{ selected.document.cues.length }}</span></button
          ><button
            role="tab"
            data-testid="glossary-tab"
            :aria-selected="detailTab === 'glossary'"
            :class="{ active: detailTab === 'glossary' }"
            @click="detailTab = 'glossary'"
          >
            <Icon name="book" :size="17" />{{ t('术语与风格')
            }}<span>{{ selected.glossary.length }}</span></button
          ><button
            role="tab"
            :aria-selected="detailTab === 'logs'"
            :class="{ active: detailTab === 'logs' }"
            @click="detailTab = 'logs'"
          >
            <Icon name="history" :size="17" />{{ t('运行记录') }}</button
          ><button
            role="tab"
            :aria-selected="detailTab === 'settings'"
            :class="{ active: detailTab === 'settings' }"
            @click="detailTab = 'settings'"
          >
            <Icon name="settings" :size="17" />{{ t('任务设置') }}
          </button>
        </div>
        <SubtitleComparison
          ref="comparison"
          v-show="detailTab === 'subtitles'"
          :job="selected"
          :active="view === 'detail' && detailTab === 'subtitles'"
          :running="selectedRunning"
          :phase-label="phaseLabel"
          :phase-icon="phaseIcon"
          :progress-panel="progressPanel"
          :now="now"
        />
        <div v-if="detailTab === 'glossary'" class="glossary-panel">
          <div class="panel-heading">
            <div>
              <h3>{{ t('贯穿始终的词汇约定') }}</h3>
              <p>
                {{ t('完整词表保存在本地，每轮按相关性携带。手动编辑的术语会锁定，优先沿用你的译法。') }}
              </p>
              <p v-if="!selected.settings.useGlossary" class="glossary-disabled">
                {{ t('这个任务未启用术语库。开启后才会向模型发送并积累术语。') }}
              </p>
              <p v-if="selected.lastGlossarySent !== null" class="glossary-usage" data-testid="glossary-usage">
                {{
                  t('累计 {0} 条 · 上轮携带 {1} 条', {
                    0: selected.glossary.length,
                    1: selected.lastGlossarySent,
                  })
                }}
              </p>
            </div>
            <button class="button secondary" :disabled="!selected.glossary.length" @click="exportGlossary()">
              <Icon name="download" :size="15" />{{ t('导出术语') }}
            </button>
          </div>
          <section class="glossary-history" :aria-label="t('术语发送记录')">
            <h3>{{ t('术语发送记录') }}</h3>
            <p class="field-hint">
              {{ t('保留最近 20 轮成功请求实际发给模型的词条。未携带的词条仍保存在完整术语库中。') }}
            </p>
            <details
              v-for="round in [...selected.glossaryHistory].reverse()"
              :key="round.chunk"
              class="glossary-round"
            >
              <summary>
                {{ t('第 {0} 块 · 携带 {1} 条', { 0: round.chunk, 1: round.terms.length })
                }}<time>{{ dateLabel(round.at) }}</time>
              </summary>
              <p v-if="!round.terms.length" class="field-hint">{{ t('本轮没有匹配到相关术语。') }}</p>
              <ul v-else>
                <li v-for="term in round.terms" :key="term.source">
                  <strong>{{ term.source }}</strong
                  ><span>→ {{ term.target }}</span
                  ><small v-if="term.note">{{ term.note }}</small>
                </li>
              </ul>
            </details>
            <p v-if="!selected.glossaryHistory.length" class="field-hint">
              {{ t('下一轮翻译成功后，这里会显示实际发送的术语。') }}
            </p>
          </section>
          <div v-if="selected.glossary.length" class="term-table">
            <div class="term-header">
              <span>{{ t('原文术语') }}</span
              ><span>{{ t('固定译法') }}</span
              ><span>{{ t('备注') }}</span
              ><span></span>
            </div>
            <div v-for="(term, index) in selected.glossary" :key="term.id" class="term-row">
              <div>
                <Icon v-if="term.locked" name="lock" :size="12" /><MemoryField
                  :job-id="selected.id"
                  :field="termField(term.id!, 'source')"
                  :label="t('术语 {0} 原文', { 0: index + 1 })"
                  :test-id="`term-${index + 1}-source`"
                  :disabled="selectedRunning"
                />
              </div>
              <MemoryField
                :job-id="selected.id"
                :field="termField(term.id!, 'target')"
                :label="t('术语 {0} 译法', { 0: index + 1 })"
                :test-id="`term-${index + 1}-target`"
                :disabled="selectedRunning"
              /><MemoryField
                :job-id="selected.id"
                :field="termField(term.id!, 'note')"
                :label="t('术语 {0} 备注', { 0: index + 1 })"
                :test-id="`term-${index + 1}-note`"
                :disabled="selectedRunning"
                placeholder="—"
              /><button
                class="icon-button danger-hover"
                :aria-label="t('删除术语 {0}', { 0: term.source })"
                :disabled="selectedRunning"
                @click="removeTerm(term.id!)"
              >
                <Icon name="trash" :size="15" />
              </button>
            </div>
          </div>
          <div v-for="draft in orphanedDrafts" :key="draft.field" class="form-error">
            <p>{{ t('这个术语已在其他标签页删除，草稿仍保留，可备份或复制后重新添加') }}</p>
            <textarea :value="draft.value" :aria-label="t('已删除术语的草稿')" readonly></textarea>
            <button class="text-button" @click="exportBackup([selected])">{{ t('备份') }}</button>
            <button class="text-button" @click="memoryEdits.restore(selected.id, draft.field)">
              {{ t('放弃草稿') }}
            </button>
          </div>
          <div v-if="!selected.glossary.length" class="empty-terms">
            <Icon name="book" :size="25" />
            <p>{{ t('模型会在翻译中逐步积累术语，也可以先添加你的固定译法。') }}</p>
          </div>
          <form class="add-term" @submit.prevent="addTerm">
            <input
              v-model="newTerm.source"
              :aria-label="t('新增术语原文')"
              :placeholder="t('原文术语')"
              :maxlength="limits.termSource"
              :disabled="selectedRunning"
            /><input
              v-model="newTerm.target"
              :aria-label="t('新增术语译文')"
              :placeholder="t('固定译法')"
              :maxlength="limits.termTarget"
              :disabled="selectedRunning"
            /><input
              v-model="newTerm.note"
              :aria-label="t('新增术语备注')"
              :placeholder="t('备注（可选）')"
              :maxlength="limits.termNote"
              :disabled="selectedRunning"
            /><button class="button secondary" type="submit" :disabled="selectedRunning">
              <Icon name="plus" :size="16" />{{ t('添加') }}
            </button>
          </form>
          <div class="style-memory">
            <h3><Icon name="sparkle" :size="17" />{{ t('风格备忘') }}</h3>
            <p>{{ t('模型每轮返回的风格总结会传给下一轮。你也可以手动补充语气、人称或称谓要求。') }}</p>
            <MemoryField
              :job-id="selected.id"
              field="style"
              multiline
              :disabled="selectedRunning"
              :label="t('风格备忘')"
              :placeholder="t('第一轮翻译后，这里会记录模型沿用的表达风格。')"
            />
          </div>
        </div>
        <div v-else-if="detailTab === 'logs'" class="log-panel">
          <div v-for="(entry, index) in [...selected.events].reverse()" :key="index" class="log-row">
            <span class="log-dot" :class="entry.kind"></span
            ><time>{{ new Date(entry.at).toLocaleTimeString(locale, { hour12: false }) }}</time>
            <p>{{ localize(entry.message) }}</p>
          </div>
          <p class="field-hint">{{ t('显示最近 120 条记录。Token 用量只累计成功返回的请求。') }}</p>
        </div>
        <div v-else-if="detailTab === 'settings'" class="task-settings-panel">
          <div class="panel-heading">
            <div>
              <h3>{{ t('翻译参数') }}</h3>
              <p>{{ t('已完成的译文保留不变，调整后的参数用于后续分块。') }}</p>
            </div>
            <button class="button secondary" :disabled="selectedRunning" @click="openSettings()">
              <Icon name="settings" :size="15" />{{ t('调整参数') }}
            </button>
          </div>
          <dl class="settings-summary">
            <div>
              <dt>{{ t('模型') }}</dt>
              <dd>{{ selected.profile.model }}</dd>
            </div>
            <div>
              <dt>{{ t('API 地址') }}</dt>
              <dd>
                {{ selected.profile.baseUrl }}
                <button class="text-button" :disabled="selectedRunning" @click="openAPI(selected)">
                  {{ t('修改') }}
                </button>
              </dd>
            </div>
            <div>
              <dt>{{ t('分块策略') }}</dt>
              <dd>
                {{
                  t('目标 {0} 条，上限 {1} 条 / {2} 字符', {
                    0: selected.settings.targetChunkSize,
                    1: selected.settings.maxChunkSize,
                    2: selected.settings.maxChunkCharacters,
                  })
                }}
              </dd>
            </div>
            <div>
              <dt>{{ t('上下文与频率') }}</dt>
              <dd>
                {{
                  t('前文 {0} 条 · 后文 {1} 条 · {2} RPM · 最多重试 {3} 次', {
                    0: selected.settings.contextSize,
                    1: selected.settings.futureContextSize,
                    2: selected.settings.rpm,
                    3: selected.settings.maxRetries,
                  })
                }}
              </dd>
            </div>
            <div>
              <dt>{{ t('术语库') }}</dt>
              <dd>{{ selected.settings.useGlossary ? t('已启用') : t('已关闭') }}</dd>
            </div>
            <div>
              <dt>{{ t('背景设定') }}</dt>
              <dd class="preserve-lines">
                {{ selected.settings.background || t('未设置背景，使用通用字幕翻译风格。') }}
              </dd>
            </div>
          </dl>
        </div>
      </section>
    </div>
    <p class="page-footnote">
      <Icon name="storage" :size="14" />{{
        t('关闭页面后会停止发送新请求。再次打开，点击“继续翻译”即可从已保存的分块接续。')
      }}
    </p>
  </template>
  <section v-else class="empty-state">
    <Icon name="file" :size="36" />
    <h2>{{ t('这个任务不在当前浏览器中') }}</h2>
    <p>{{ t('可以返回任务列表，或导入之前导出的备份。') }}</p>
    <button class="button primary" @click="navigate('tasks')">{{ t('查看任务记录') }}</button>
  </section>
  <Modal
    v-if="editModal && selected"
    :title="t('调整翻译参数')"
    :subtitle="t('背景、上下文和请求参数会用于之后的翻译。')"
    @close="editModal = false"
    ><p v-if="notice" class="form-error" role="alert">{{ localize(notice) }}</p>
    <SettingsFields v-model="editSettings" :locked="selected.completedChunks > 0" />
    <p v-if="selected.completedChunks" class="field-hint">
      {{ t('源语言和目标语言保持固定；调整分块只影响尚未完成的字幕。') }}
    </p>
    <label class="field edit-background"
      ><span>{{ t('背景设定') }}</span
      ><textarea
        v-model="editSettings.background"
        rows="5"
        :maxlength="limits.background"
        :aria-label="t('修改背景设定')"
      ></textarea></label
    ><template #footer
      ><button class="button secondary" @click="editModal = false">{{ t('取消') }}</button
      ><button class="button primary" @click="saveSettings">{{ t('保存参数') }}</button></template
    ></Modal
  >
  <Modal
    v-if="exportModal && selected"
    :title="t('导出你的字幕')"
    :subtitle="t('所有译文已完成，选择适合播放器的字幕格式。')"
    @close="exportModal = false"
    ><div class="export-choices">
      <button :class="{ selected: exportMode === 'bilingual' }" @click="exportMode = 'bilingual'">
        <Icon name="combine" :size="24" /><strong>{{ t('双语字幕') }}</strong
        ><span>{{ t('原文与译文同时保留') }}</span
        ><Icon v-if="exportMode === 'bilingual'" name="success" :size="16" /></button
      ><button :class="{ selected: exportMode === 'translation' }" @click="exportMode = 'translation'">
        <Icon name="languages" :size="24" /><strong>{{ t('纯译文') }}</strong
        ><span>{{ t('只显示目标语言') }}</span
        ><Icon v-if="exportMode === 'translation'" name="success" :size="16" />
      </button>
    </div>
    <div class="form-grid two">
      <label class="field"
        ><span>{{ t('字幕格式') }}</span
        ><select v-model="exportFormat" :aria-label="t('导出字幕格式')">
          <option value="srt">SRT</option>
          <option value="vtt">WebVTT</option>
        </select></label
      ><label v-if="exportMode === 'bilingual'" class="field"
        ><span>{{ t('上下排列') }}</span
        ><select v-model="exportOrder">
          <option value="original-first">{{ t('原文在上') }}</option>
          <option value="translation-first">{{ t('译文在上') }}</option>
        </select></label
      >
    </div>
    <template #footer
      ><button class="button secondary" @click="exportModal = false">{{ t('取消') }}</button
      ><button class="button primary" :disabled="exporting" @click="exportSubtitle">
        <Icon :name="exporting ? 'loading' : 'download'" :size="16" />{{ t('下载字幕') }}
      </button></template
    ></Modal
  >
</template>
