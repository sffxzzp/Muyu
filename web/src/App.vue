<script setup lang="ts">
import { message } from './messages'
import { computed, nextTick, onUnmounted, ref } from 'vue'
import Icon from './components/Icon.vue'
import Modal from './components/Modal.vue'
import APIConfigModal from './components/APIConfigModal.vue'
import HelpModal from './components/HelpModal.vue'
import NewTaskPage from './pages/NewTaskPage.vue'
import TaskListPage from './pages/TaskListPage.vue'
import TaskDetailPage from './pages/TaskDetailPage.vue'
import MergePage from './pages/MergePage.vue'
import { t, localize } from './i18n'
import { locale, theme, preferencesSaved, setLocale, toggleTheme } from './preferences'
import { navigate, selectedId, sidebarOpen, view, watchNavigation } from './navigation'
import { fail, flash, modelReady, safely, toast } from './ui'
import {
  apiKeyFor,
  busy,
  clearWorkspace,
  deleteJob,
  exportBackup,
  importBackup,
  notice,
  remoteBusy,
  jobBusy,
  runningCount,
  queuedCount,
  startJob,
  unsaved,
  usedBytes,
  workspace,
} from './workspace'
import { percent, type Job } from './types'
onUnmounted(watchNavigation())
const selected = computed(() => workspace.jobs.find((job) => job.id === selectedId.value))
const detailPage = ref<InstanceType<typeof TaskDetailPage>>()
const workspaceEpoch = ref(0)
const runningJobs = computed(() => workspace.jobs.filter((job) => jobBusy(job.id)))
const runningJob = computed(() => runningJobs.value[0])
const pageTitle = computed(
  () =>
    ({ new: t('字幕翻译'), tasks: t('任务记录'), merge: t('双语合并'), detail: t('翻译工作台') })[view.value],
)
const storageSize = computed(() =>
  usedBytes.value < 1024
    ? `${usedBytes.value} B`
    : usedBytes.value < 1024 * 1024
      ? `${Math.round(usedBytes.value / 1024)} KB`
      : `${(usedBytes.value / 1024 / 1024).toFixed(1)} MB`,
)
const apiModal = ref(false),
  apiJobId = ref(''),
  pendingStartId = ref('')
function openAPI(job?: Job, thenStart = false) {
  notice.value = ''
  apiJobId.value = job?.id ?? ''
  pendingStartId.value = thenStart ? apiJobId.value : ''
  apiModal.value = true
}
function closeAPI() {
  apiModal.value = false
  pendingStartId.value = ''
}
async function requestStart(job: Job) {
  if (!apiKeyFor(job.profile, job.id)) {
    openAPI(job, true)
    return
  }
  await beginJob(job.id)
}
async function beginJob(id: string) {
  try {
    notice.value = ''
    await startJob(id)
    if (workspace.jobs.find((job) => job.id === id)?.status === 'completed')
      flash(message('翻译完成，字幕与术语库已保存'))
  } catch (error) {
    fail(error)
  }
}

const importInput = ref<HTMLInputElement>()
async function importFile(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files?.[0])
    await safely(async () => {
      const count = await importBackup(input.files![0])
      flash(message('已恢复 {0} 个任务', { 0: count }))
      navigate('tasks')
    })
  input.value = ''
}
const confirm = ref<{ kind: 'clear' | 'delete'; jobId?: string }>()
async function confirmAction() {
  await safely(async () => {
    if (confirm.value?.kind === 'clear') {
      await clearWorkspace()
      workspaceEpoch.value++
      navigate('new')
      flash(message('本站保存的任务与 API 配置已清空'))
    } else if (confirm.value?.jobId) {
      await deleteJob(confirm.value.jobId)
      if (!selected.value) navigate('tasks')
      flash(message('任务已删除'))
    }
    confirm.value = undefined
  })
}
const helpModal = ref(false)

async function openRunningJob() {
  if (runningJobs.value.length > 1) {
    navigate('tasks')
    return
  }
  if (!runningJob.value) return
  navigate('detail', runningJob.value.id)
  await nextTick()
  await detailPage.value?.showCurrentChunk()
}
</script>

<template>
  <div class="app-shell">
    <div v-if="sidebarOpen" class="sidebar-overlay" @click="sidebarOpen = false"></div>
    <aside class="sidebar" :class="{ open: sidebarOpen }">
      <a class="brand" href="#/new" :aria-label="t('幕语首页')"
        ><span class="brand-mark"><Icon name="captions" :size="26" /></span
        ><span class="brand-name">{{ t('幕语') }}<span>MUYU STUDIO</span></span></a
      >
      <div class="workspace-label">{{ t('你的字幕工作空间') }}</div>
      <nav class="main-nav" :aria-label="t('主导航')">
        <button :class="{ active: view === 'new' || view === 'detail' }" @click="navigate('new')">
          <Icon name="languages" /><span>{{ t('字幕翻译') }}</span
          ><Icon name="right" :size="14" />
        </button>
        <button :class="{ active: view === 'merge' }" @click="navigate('merge')">
          <Icon name="combine" /><span>{{ t('双语合并') }}</span>
        </button>
        <button :class="{ active: view === 'tasks' }" @click="navigate('tasks')">
          <Icon name="history" /><span>{{ t('任务记录') }}</span
          ><span class="nav-count">{{ workspace.jobs.length }}</span>
        </button>
      </nav>
      <div class="nav-separator"></div>
      <div class="workspace-label">{{ t('偏好与工具') }}</div>
      <nav class="main-nav secondary-nav" :aria-label="t('工具')">
        <button @click="openAPI()">
          <Icon name="key" /><span>{{ t('API 配置') }}</span
          ><span v-if="modelReady" class="ready-dot"></span>
        </button>
        <button @click="importInput?.click()">
          <Icon name="json" /><span>{{ t('导入任务备份') }}</span>
        </button>
        <button @click="helpModal = true">
          <Icon name="help" /><span>{{ t('使用说明') }}</span>
        </button>
      </nav>
      <div class="sidebar-bottom">
        <div class="local-card">
          <span class="local-card-icon"><Icon name="storage" :size="19" /></span
          ><strong>{{ t('只留在你的浏览器') }}</strong>
          <p>{{ t('无需账号。进度自动保存在本地，随时回来，接着翻译。') }}</p>
          <div class="storage-usage">
            <span>{{ t('{0} 个任务', { 0: workspace.jobs.length }) }}</span
            ><span>{{ t('约 {0}', { 0: storageSize }) }}</span>
          </div>
          <div class="storage-track">
            <span :style="{ width: `${Math.min(100, (usedBytes / (5 * 1024 * 1024)) * 100)}%` }"></span>
          </div>
          <button :disabled="busy" class="clear-storage" @click="confirm = { kind: 'clear' }">
            <Icon name="trash" :size="14" />{{ t('清空本地数据') }}
          </button>
        </div>
        <div class="sidebar-foot">
          <span class="mini-logo">{{ t('幕') }}</span
          ><span>{{ t('每一句，都值得好好翻译。') }}</span>
        </div>
      </div>
    </aside>

    <div class="main-shell">
      <header class="topbar">
        <div class="breadcrumb">
          <button class="icon-button mobile-menu" :aria-label="t('打开导航')" @click="sidebarOpen = true">
            <Icon name="menu" /></button
          ><span>{{ t('工作空间') }}</span
          ><Icon name="right" :size="13" /><strong>{{ pageTitle }}</strong>
        </div>
        <div class="topbar-right">
          <button
            v-if="runningJob"
            class="running-task-link"
            :aria-label="t('查看正在翻译的任务')"
            :title="runningJob.name"
            @click="openRunningJob()"
          >
            <Icon name="loading" :size="14" class="spinning" /><span class="running-task-label">{{
              t('翻译进度')
            }}</span
            ><strong>{{
              runningJobs.length > 1
                ? t('{0} 运行 / {1} 排队', { 0: runningCount, 1: queuedCount })
                : `${percent(runningJob)}%`
            }}</strong
            ><Icon name="arrow" :size="14" />
          </button>
          <span v-else class="anonymous"><span></span>{{ t('匿名使用 · 本地保存') }}</span
          ><button class="icon-button" :aria-label="t('使用说明')" @click="helpModal = true">
            <Icon name="help" :size="19" />
          </button>
          <div class="display-controls" :aria-label="t('界面偏好')" role="group">
            <button
              class="icon-button theme-toggle"
              :aria-label="theme === 'dark' ? t('切换为浅色主题') : t('切换为深色主题')"
              :title="theme === 'dark' ? t('切换为浅色主题') : t('切换为深色主题')"
              @click="toggleTheme()"
            >
              <Icon :name="theme === 'dark' ? 'sun' : 'moon'" :size="17" />
            </button>
            <div class="language-switch" role="group" :aria-label="t('界面语言')">
              <button
                lang="zh-CN"
                aria-label="简体中文"
                :aria-pressed="locale === 'zh-CN'"
                @click="setLocale('zh-CN')"
              >
                CN
              </button>
              <button lang="en" aria-label="English" :aria-pressed="locale === 'en'" @click="setLocale('en')">
                EN
              </button>
            </div>
          </div>
        </div>
      </header>
      <main class="main-content">
        <div v-if="notice || unsaved" class="notice" role="alert">
          <Icon name="alert" :size="18" /><span>{{
            unsaved
              ? t('有进度尚未成功写入浏览器。请先备份当前任务，再清理旧任务腾出空间。')
              : localize(notice)
          }}</span
          ><button v-if="unsaved" class="text-button" @click="exportBackup()">{{ t('导出备份') }}</button
          ><button v-if="!unsaved" class="icon-button" :aria-label="t('关闭提示')" @click="notice = ''">
            <Icon name="close" :size="16" />
          </button>
        </div>
        <div v-if="!preferencesSaved" class="info-banner" role="status">
          <Icon name="info" :size="17" />{{ t('浏览器未能保存界面偏好，当前选择仅在本页生效。') }}
        </div>
        <div v-if="remoteBusy" class="info-banner">
          <Icon name="info" :size="17" />{{
            t('其他标签页有活动任务。这里会同步进度，也可以暂停任务或将其他任务加入队列。')
          }}
        </div>

        <KeepAlive :key="workspaceEpoch">
          <NewTaskPage v-if="view === 'new'" @start="requestStart" @api="openAPI()" />
          <TaskListPage
            v-else-if="view === 'tasks'"
            @start="requestStart"
            @delete="confirm = { kind: 'delete', jobId: $event }"
          />
          <TaskDetailPage
            v-else-if="view === 'detail'"
            ref="detailPage"
            @start="requestStart"
            @api="openAPI"
          />
          <MergePage v-else />
        </KeepAlive>
        <footer class="main-footer">
          <span>{{ t('幕语 MUYU') }}<span>·</span>{{ t('在语言之间，找到共鸣。') }}</span
          ><span>{{ t('由你选择模型，由你掌握数据。') }}</span>
        </footer>
      </main>
    </div>
    <input
      ref="importInput"
      class="sr-only"
      type="file"
      accept=".json,application/json"
      :aria-label="t('导入任务备份文件')"
      @change="importFile"
    />
    <Transition name="toast"
      ><div v-if="toast" class="toast-message" role="status">
        <Icon name="success" :size="18" />{{ localize(toast) }}
      </div></Transition
    >

    <APIConfigModal
      v-if="apiModal"
      :job-id="apiJobId"
      :start="!!pendingStartId"
      @close="closeAPI"
      @saved="
        (id) => {
          if (id) void beginJob(id)
        }
      "
    />

    <Modal
      v-if="confirm"
      :title="confirm.kind === 'clear' ? t('清空本地数据？') : t('删除这个任务？')"
      @close="confirm = undefined"
      ><div class="confirm-content">
        <span class="confirm-icon"><Icon name="trash" :size="25" /></span>
        <p>
          {{
            confirm.kind === 'clear'
              ? t(
                  '这会删除本站保存在当前浏览器中的所有字幕、翻译进度、术语库、API 配置和界面偏好。其他网站的数据不会受到影响。',
                )
              : t('任务的字幕、翻译进度和术语库将从当前浏览器中删除。')
          }}
        </p>
        <p>{{ t('删除后无法撤销，需要保留的话请先导出备份。') }}</p>
        <button
          class="text-button"
          @click="
            exportBackup(
              confirm.kind === 'delete'
                ? workspace.jobs.filter((job) => job.id === confirm?.jobId)
                : undefined,
            )
          "
        >
          <Icon name="download" :size="15" />{{ t('先导出备份') }}
        </button>
      </div>
      <template #footer
        ><button class="button secondary" @click="confirm = undefined">{{ t('取消') }}</button
        ><button
          class="button danger"
          :disabled="confirm?.kind === 'clear' ? busy : jobBusy(confirm?.jobId ?? '')"
          @click="confirmAction"
        >
          {{ confirm.kind === 'clear' ? t('清空全部数据') : t('删除任务') }}
        </button></template
      ></Modal
    >
    <HelpModal v-if="helpModal" @close="helpModal = false" />
  </div>
</template>
