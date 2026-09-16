<script setup lang="ts">
import { computed, ref } from 'vue'
import Icon from '../components/Icon.vue'
import Modal from '../components/Modal.vue'
import { t, localize } from '../i18n'
import { navigate } from '../navigation'
import { recent, dateLabel, safely, statusLabel, statusTone } from '../ui'
import {
  busy,
  exportBackup,
  exportRecovery,
  deleteRecovery,
  jobBusy,
  pauseJob,
  queuedCount,
  runningCount,
  runtimeFor,
  workspace,
} from '../workspace'
import { languageName } from '../languages'
import { percent, type Job } from '../types'
const emit = defineEmits<{ start: [job: Job]; delete: [id: string] }>()
const requestStart = (job: Job) => emit('start', job)
const requestDelete = (id: string) => emit('delete', id)
const removeRecovery = ref('')
async function confirmRecoveryDeletion() {
  await safely(async () => {
    await deleteRecovery(removeRecovery.value)
    removeRecovery.value = ''
  })
}
const taskSearch = ref(''),
  taskFilter = ref('all')
const filteredJobs = computed(() =>
  recent.value.filter(
    (job) =>
      job.name.toLowerCase().includes(taskSearch.value.toLowerCase()) &&
      (taskFilter.value === 'all' || taskFilter.value === 'completed'
        ? taskFilter.value === 'all' || job.status === 'completed'
        : job.status !== 'completed'),
  ),
)
</script>

<template>
  <section class="page-intro">
    <div>
      <span class="eyebrow"><span></span> YOUR WORKSPACE</span>
      <h1>
        {{ t('你的字幕，') }}<span>{{ t('接着翻译。') }}</span>
      </h1>
      <p>{{ t('每一次进度都留在这里，语境和术语也一起记住。') }}</p>
    </div>
    <button class="button primary" @click="navigate('new')"><Icon name="plus" />{{ t('新建翻译') }}</button>
  </section>
  <div class="card queue-bar">
    <strong>{{ t('任务队列') }}</strong>
    <div>
      <strong>{{ t('{0} 运行 / {1} 排队', { 0: runningCount, 1: queuedCount }) }}</strong>
      <p>{{ t('本浏览器一次翻译一个任务，其余按顺序排队。不同使用者的队列互相独立。') }}</p>
    </div>
  </div>
  <div class="tasks-toolbar">
    <div class="segmented">
      <button :class="{ active: taskFilter === 'all' }" @click="taskFilter = 'all'">
        {{ t('全部 {0}', { 0: workspace.jobs.length }) }}</button
      ><button :class="{ active: taskFilter === 'unfinished' }" @click="taskFilter = 'unfinished'">
        {{ t('未完成') }}</button
      ><button :class="{ active: taskFilter === 'completed' }" @click="taskFilter = 'completed'">
        {{ t('已完成') }}
      </button>
    </div>
    <div class="toolbar-actions">
      <label class="search-field"
        ><Icon name="search" :size="16" /><input
          v-model="taskSearch"
          :aria-label="t('搜索任务')"
          :placeholder="t('搜索任务名称')" /></label
      ><button
        class="button secondary"
        :disabled="!workspace.jobs.length && !workspace.recovery.length"
        @click="exportBackup()"
      >
        <Icon name="download" :size="16" />{{ t('全部备份') }}
      </button>
    </div>
  </div>
  <section v-if="workspace.recovery.length" class="card recovery-list">
    <h2>{{ t('需要恢复的记录') }}</h2>
    <p>{{ t('原始数据仍保留。下载后可修复并重新导入，其他任务可以正常使用。') }}</p>
    <article v-for="item in workspace.recovery" :key="item.id" class="recovery-record">
      <div>
        <strong>{{ item.name || t('未命名的恢复记录') }}</strong>
        <p>{{ localize(item.error) }}</p>
      </div>
      <button class="button secondary" @click="exportRecovery(item.id)">{{ t('下载原始记录') }}</button>
      <button
        class="icon-button danger-hover"
        :aria-label="t('删除恢复记录 {0}', { 0: item.name || item.id })"
        @click="removeRecovery = item.id"
      >
        <Icon name="trash" />
      </button>
    </article>
  </section>
  <section class="card task-list">
    <div v-if="!filteredJobs.length" class="empty-state">
      <span><Icon name="history" :size="34" /></span>
      <h2>{{ workspace.jobs.length ? t('没有找到匹配的任务') : t('还没有字幕任务') }}</h2>
      <p>
        {{
          workspace.jobs.length
            ? t('试试其他关键词或筛选条件。')
            : t('上传字幕开始翻译，也可以导入之前的任务备份。')
        }}
      </p>
      <button v-if="!workspace.jobs.length" class="button primary" @click="navigate('new')">
        {{ t('创建第一个任务') }}<Icon name="arrow" :size="16" />
      </button>
    </div>
    <div v-else class="task-table">
      <div class="task-table-header">
        <span>{{ t('字幕文件') }}</span
        ><span>{{ t('翻译进度') }}</span
        ><span>{{ t('最近更新') }}</span
        ><span></span>
      </div>
      <div v-for="job in filteredJobs" :key="job.id" class="task-table-row">
        <button class="task-name-cell" @click="navigate('detail', job.id)">
          <span class="file-icon"><Icon name="file" :size="23" /></span
          ><span
            ><strong>{{ job.name }}</strong
            ><small>{{
              t('{0} · {1} · {2} 条', {
                0: job.document.format.toUpperCase(),
                1: languageName(job.settings.targetLanguage),
                2: job.document.cues.length,
              })
            }}</small></span
          >
        </button>
        <div class="task-progress-cell">
          <div>
            <span class="status-badge" :class="statusTone(job)">{{ statusLabel(job) }}</span
            ><span>{{ percent(job) }}%</span>
          </div>
          <div class="progress-track"><span :style="{ width: `${percent(job)}%` }"></span></div>
        </div>
        <span class="task-date">{{ dateLabel(job.updatedAt) }}</span>
        <div class="row-actions">
          <button
            v-if="jobBusy(job.id)"
            class="button secondary small task-run-action"
            :disabled="runtimeFor(job.id)?.pauseRequested"
            :aria-label="t('暂停 {0}', { 0: job.name })"
            :title="t('请求已发出时，当前块完成并保存后暂停；排队或等待时立即暂停。')"
            @click="safely(() => pauseJob(job.id))"
          >
            <Icon name="pause" :size="15" />{{
              runtimeFor(job.id)?.pauseRequested ? t('正在暂停…') : t('暂停')
            }}
          </button>
          <button
            v-else-if="job.status !== 'completed'"
            class="button secondary small task-run-action"
            :aria-label="busy ? t('将 {0} 加入队列', { 0: job.name }) : t('开始或继续 {0}', { 0: job.name })"
            @click="requestStart(job)"
          >
            <Icon name="play" :size="15" />{{
              busy ? t('加入队列') : job.completedChunks || job.requests ? t('继续') : t('开始')
            }}
          </button>
          <button
            class="icon-button"
            :aria-label="t('打开 {0}', { 0: job.name })"
            @click="navigate('detail', job.id)"
          >
            <Icon name="external" /></button
          ><button
            class="icon-button danger-hover"
            :disabled="jobBusy(job.id)"
            :aria-label="t('删除 {0}', { 0: job.name })"
            @click="requestDelete(job.id)"
          >
            <Icon name="trash" :size="17" />
          </button>
        </div>
      </div>
    </div>
  </section>
  <p class="page-footnote">
    <Icon name="info" :size="14" />{{
      t('记录保存在当前浏览器，不会自动过期。清理浏览器数据前，可以先导出任务备份。')
    }}
  </p>
  <Modal v-if="removeRecovery" :title="t('删除这条恢复记录？')" @close="removeRecovery = ''">
    <p>{{ t('删除后无法在本站恢复，请先下载需要保留的原始数据。') }}</p>
    <template #footer>
      <button class="button secondary" @click="removeRecovery = ''">{{ t('取消') }}</button>
      <button class="button primary" @click="confirmRecoveryDeletion">{{ t('确认删除') }}</button>
    </template>
  </Modal>
</template>
