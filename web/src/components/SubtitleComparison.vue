<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import AutoTextarea from './AutoTextarea.vue'
import Icon from './Icon.vue'
import { t, localize } from '../i18n'
import { languageName } from '../languages'
import { doneCount, timestamp, type Job } from '../types'
import { translationEdits } from '../workspace'
import { limits } from '../validation'

const props = defineProps<{
  job: Job
  active: boolean
  running: boolean
  phaseLabel: string
  phaseIcon: InstanceType<typeof Icon>['$props']['name']
  progressPanel?: HTMLElement
  now: number
}>()
const cueSearch = ref(''),
  cuePage = ref(1),
  followProgress = ref(true),
  browsingUntil = ref(0),
  editingTranslation = ref('')
const cueTable = ref<HTMLElement>(),
  cuePagination = ref<HTMLElement>()
const cuesPerPage = 40
const currentChunk = computed(() => props.job.chunks[props.job.completedChunks])
const followingDeferred = computed(
  () => !!cueSearch.value || !!editingTranslation.value || browsingUntil.value > props.now,
)
function inCurrentChunk(cueId: number) {
  return !!currentChunk.value && cueId > currentChunk.value.start && cueId <= currentChunk.value.end
}
function pendingLabel(cueId: number) {
  return inCurrentChunk(cueId) && props.job.status !== 'ready' ? props.phaseLabel : t('等待翻译')
}
watch(
  () => props.job.id,
  () => {
    cuePage.value = 1
    cueSearch.value = ''
    browsingUntil.value = 0
    editingTranslation.value = ''
  },
)
watch(cueSearch, () => {
  cuePage.value = 1
})
const filteredCues = computed(
  () =>
    props.job.document.cues.filter((cue) =>
      `${cue.text} ${props.job.translations[cue.id] ?? ''}`
        .toLowerCase()
        .includes(cueSearch.value.toLowerCase()),
    ) ?? [],
)
const cuePageCount = computed(() => Math.max(1, Math.ceil(filteredCues.value.length / cuesPerPage)))
const pageCues = computed(() =>
  filteredCues.value.slice((cuePage.value - 1) * cuesPerPage, cuePage.value * cuesPerPage),
)
watch(cuePageCount, (count) => {
  cuePage.value = Math.min(cuePage.value, count)
})

function comparisonTop(withColumnHeader = true) {
  const compact = window.matchMedia('(max-width: 1179px)').matches
  const topbarHeight = document.querySelector('.topbar')?.getBoundingClientRect().height ?? 72
  return (
    topbarHeight +
    (compact
      ? (props.progressPanel?.getBoundingClientRect().height ?? 0) + 24
      : (withColumnHeader
          ? (cueTable.value?.querySelector('.cue-header')?.getBoundingClientRect().height ?? 0)
          : 0) + 16)
  )
}
async function focusCurrentChunk(force = false) {
  const jobId = props.job.id,
    chunk = currentChunk.value
  if (!chunk || cueSearch.value || !props.active) return
  const mayFollow = () =>
    followProgress.value && !editingTranslation.value && Date.now() >= browsingUntil.value
  if (!force && !mayFollow()) return
  cuePage.value = Math.floor(chunk.start / cuesPerPage) + 1
  await nextTick()
  // Navigation, searching, or manual browsing can supersede this scheduled follow.
  if (jobId !== props.job.id || !props.active || cueSearch.value || (!force && !mayFollow())) return
  const row = cueTable.value?.querySelector<HTMLElement>(`[data-cue-id="${chunk.start + 1}"]`)
  if (!row) return
  const visibleTop = comparisonTop(),
    availableHeight = Math.max(
      0,
      window.innerHeight - visibleTop - (cuePagination.value?.getBoundingClientRect().height ?? 0) - 20,
    ),
    rect = row.getBoundingClientRect()
  if (force || rect.top < visibleTop || rect.top > visibleTop + availableHeight * 0.6)
    window.scrollTo({
      // Leave a little completed context above the active block when space permits.
      top: Math.max(0, window.scrollY + rect.top - visibleTop - Math.min(150, availableHeight * 0.22)),
      behavior: 'instant',
    })
}
function deferFollowing() {
  if (props.active && followProgress.value)
    // Let active browsing settle without changing the user's follow preference.
    // Only a later progress update (or explicit Locate) moves the viewport again.
    browsingUntil.value = Date.now() + 1500
}
function browseWithKeyboard(e: KeyboardEvent) {
  if (
    ['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(e.key) &&
    !(
      e.target instanceof HTMLElement &&
      e.target.closest('input, textarea, select, button, [contenteditable]')
    )
  )
    deferFollowing()
}
window.addEventListener('wheel', deferFollowing, { passive: true })
window.addEventListener('touchmove', deferFollowing, { passive: true })
window.addEventListener('keydown', browseWithKeyboard)
onUnmounted(() => {
  window.removeEventListener('wheel', deferFollowing)
  window.removeEventListener('touchmove', deferFollowing)
  window.removeEventListener('keydown', browseWithKeyboard)
})
watch(
  [() => props.job.id, () => props.active, () => props.job.completedChunks, () => props.running],
  () => {
    if (followProgress.value && props.running) void focusCurrentChunk()
  },
  { flush: 'post', immediate: true },
)
async function showCurrentChunk() {
  cueSearch.value = ''
  browsingUntil.value = 0
  await nextTick()
  await focusCurrentChunk(true)
}
function toggleFollowing(e: Event) {
  followProgress.value = (e.target as HTMLInputElement).checked
  if (followProgress.value) void showCurrentChunk()
}
async function changeCuePage(delta: number) {
  deferFollowing()
  cuePage.value = Math.max(1, Math.min(cuePageCount.value, cuePage.value + delta))
  await nextTick()
  const table = cueTable.value?.getBoundingClientRect()
  if (table)
    window.scrollTo({
      top: Math.max(0, window.scrollY + table.top - comparisonTop(false)),
      behavior: 'instant',
    })
}
function beginTranslationEdit(jobId: string, cueId: number) {
  editingTranslation.value = `${jobId}:${cueId}`
  translationEdits.begin(jobId, cueId)
}
async function finishTranslationEdit(jobId: string, cueId: number) {
  await translationEdits.blur(jobId, cueId)
  if (editingTranslation.value === `${jobId}:${cueId}`) editingTranslation.value = ''
}
function changeTranslation(jobId: string, cueId: number, e: Event) {
  translationEdits.change(jobId, cueId, (e.target as HTMLTextAreaElement).value)
}
function endTranslationComposition(jobId: string, cueId: number, e: Event) {
  translationEdits.endComposition(jobId, cueId, (e.target as HTMLTextAreaElement).value)
}

defineExpose({ showCurrentChunk })
</script>

<template>
  <div :aria-label="t('原文与译文对照')">
    <div class="preview-toolbar">
      <label class="search-field"
        ><Icon name="search" :size="16" /><input
          v-model="cueSearch"
          :aria-label="t('搜索字幕')"
          :placeholder="t('搜索原文或译文')"
      /></label>
      <div v-if="currentChunk" class="follow-controls">
        <label class="follow-toggle" :title="t('随新进度自动定位；滚动、搜索或编辑不会取消勾选')">
          <input type="checkbox" :checked="followProgress" @change="toggleFollowing" />{{
            t('跟随翻译进度')
          }}</label
        >
        <button class="text-button" @click="showCurrentChunk()">
          <Icon name="eye" :size="14" />{{ t('定位当前块') }}
        </button>
      </div>
    </div>
    <div class="comparison-caption">
      <span
        ><span class="comparison-dot" :class="{ live: running }"></span
        >{{ t('已完成的译文可随时编辑，修改后自动保存') }}</span
      >
      <span v-if="currentChunk && !followProgress">{{ t('手动浏览中') }}</span>
      <span v-else-if="currentChunk && running && followingDeferred">{{ t('暂缓定位') }}</span>
      <span v-else>{{ t('{0} / {1} 条已有译文', { 0: doneCount(job), 1: job.document.cues.length }) }}</span>
    </div>
    <div ref="cueTable" class="cue-table">
      <div class="cue-header">
        <span>{{ t('时间轴') }}</span
        ><span
          >{{ t('原文') }}<span class="compact-comparison-label"> / {{ t('译文') }}</span></span
        ><span>{{ t('译文 · {0}', { 0: languageName(job.settings.targetLanguage) }) }}</span>
      </div>
      <div
        v-for="cue in pageCues"
        :key="`${job.id}:${cue.id}`"
        class="cue-row"
        :data-cue-id="cue.id"
        :class="{
          translated: job.translations[cue.id],
          processing: inCurrentChunk(cue.id) && running,
          'failed-cue': inCurrentChunk(cue.id) && job.status === 'error',
        }"
      >
        <div class="cue-time">
          <b
            ><Icon v-if="job.translations[cue.id]" name="check" :size="10" />{{
              String(cue.id).padStart(2, '0')
            }}</b
          ><span>{{ timestamp(cue.start) }}</span
          ><small>{{ timestamp(cue.end) }}</small>
        </div>
        <p class="cue-original">
          <span class="mobile-cue-label">{{ t('原文') }}</span
          >{{ cue.text }}
        </p>
        <div class="cue-translation">
          <span class="mobile-cue-label">{{ t('译文') }}</span>
          <AutoTextarea
            v-if="job.translations[cue.id]"
            :value="translationEdits.value(job.id, cue.id)"
            :aria-label="t('第 {0} 条译文', { 0: cue.id })"
            rows="1"
            :maxlength="limits.translation"
            @focus="beginTranslationEdit(job.id, cue.id)"
            @input="changeTranslation(job.id, cue.id, $event)"
            @compositionstart="translationEdits.startComposition(job.id, cue.id)"
            @compositionend="endTranslationComposition(job.id, cue.id, $event)"
            @blur="finishTranslationEdit(job.id, cue.id)"
          ></AutoTextarea
          ><span v-else class="pending-cue">
            <Icon
              v-if="inCurrentChunk(cue.id) && job.status !== 'ready'"
              :name="phaseIcon"
              :size="14"
              :class="{ spinning: phaseIcon === 'loading' }"
            />
            <span v-else></span>{{ pendingLabel(cue.id) }}
          </span>
          <div
            v-if="
              translationEdits.get(job.id, cue.id) &&
              (translationEdits.get(job.id, cue.id).saving ||
                translationEdits.get(job.id, cue.id).value !==
                  translationEdits.get(job.id, cue.id).savedInput ||
                translationEdits.get(job.id, cue.id).error)
            "
            class="translation-edit-state"
            :class="{ 'has-error': translationEdits.get(job.id, cue.id).error }"
          >
            <p role="status">
              {{
                translationEdits.get(job.id, cue.id).error
                  ? localize(translationEdits.get(job.id, cue.id).error)
                  : translationEdits.get(job.id, cue.id).saving
                    ? t('正在保存修改…')
                    : t('编辑中，稍后自动保存')
              }}
            </p>
            <template v-if="translationEdits.get(job.id, cue.id).error">
              <div class="translation-edit-actions">
                <button class="text-button" @click="translationEdits.keepMine(job.id, cue.id)">
                  {{ t('保存我的修改') }}
                </button>
                <button class="text-button" @click="translationEdits.restore(job.id, cue.id)">
                  {{ t('恢复已保存译文') }}
                </button>
              </div>
              <details>
                <summary>{{ t('查看已保存译文') }}</summary>
                <p>{{ job.translations[cue.id] }}</p>
              </details>
            </template>
          </div>
        </div>
      </div>
      <div v-if="!pageCues.length" class="empty-search">{{ t('没有找到匹配的字幕') }}</div>
    </div>
    <div ref="cuePagination" class="pagination">
      <span>{{ t('共 {0} 条，每页 {1} 条', { 0: filteredCues.length, 1: cuesPerPage }) }}</span>
      <div>
        <button
          class="icon-button"
          :aria-label="t('上一页')"
          :disabled="cuePage <= 1"
          @click="changeCuePage(-1)"
        >
          <Icon name="left" :size="16" /></button
        ><span>{{ cuePage }} / {{ cuePageCount }}</span
        ><button
          class="icon-button"
          :aria-label="t('下一页')"
          :disabled="cuePage >= cuePageCount"
          @click="changeCuePage(1)"
        >
          <Icon name="right" :size="16" />
        </button>
      </div>
    </div>
  </div>
</template>
