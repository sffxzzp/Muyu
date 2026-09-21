<script setup lang="ts">
import { message, MessageError } from '../messages'
import { computed, ref } from 'vue'
import Icon from '../components/Icon.vue'
import UploadZone from '../components/UploadZone.vue'
import SettingsFields from '../components/SettingsFields.vue'
import { t } from '../i18n'
import { navigate } from '../navigation'
import { fail, flash, hostName, modelReady, recent, statusLabel, statusTone } from '../ui'
import { readSubtitle } from '../files'
import { busy, createJob, workspace } from '../workspace'
import { languageName } from '../languages'
import { limits } from '../validation'
import {
  buildChunks,
  defaultSettings,
  parseSeedTerms,
  percent,
  timestamp,
  type Job,
  type Settings,
  type SubtitleDocument,
} from '../types'
const emit = defineEmits<{ start: [job: Job]; api: [] }>()
const requestStart = (job: Job) => emit('start', job)
const openAPI = () => emit('api')
const fileDocument = ref<SubtitleDocument>(),
  filename = ref(''),
  reading = ref(false),
  creating = ref(false)
const settings = ref<Settings>({ ...defaultSettings }),
  seedTerms = ref(''),
  showSeed = ref(false)
function onGlossaryToggle() {
  if (!settings.value.useGlossary) showSeed.value = false
}
const estimatedChunks = computed(() => {
  try {
    return fileDocument.value ? buildChunks(fileDocument.value.cues, settings.value).length : 0
  } catch {
    return 0
  }
})
async function chooseFile(file: File) {
  reading.value = true
  try {
    fileDocument.value = await readSubtitle(file)
    filename.value = file.name
    flash(message('已识别 {0} 条字幕', { 0: fileDocument.value.cues.length }))
  } catch (error) {
    fail(error)
  } finally {
    reading.value = false
  }
}
const sample = `1
00:00:01,000 --> 00:00:04,200
Welcome back. Today, let's talk about cash flow.

2
00:00:04,500 --> 00:00:08,300
It's not just about how much money you make.

3
00:00:08,500 --> 00:00:12,000
It's about what you keep, and where it goes.

4
00:00:12,500 --> 00:00:16,000
Think of your finances as a small business.

5
00:00:16,300 --> 00:00:20,100
Your income is only one part of the picture.

6
00:00:20,500 --> 00:00:24,200
The other part is your monthly expenses.

7
00:00:24,500 --> 00:00:28,300
Positive cash flow gives you room to breathe.

8
00:00:28,500 --> 00:00:32,200
And that room gives you more choices.

9
00:00:32,500 --> 00:00:36,200
Start small. Track one week of spending.

10
00:00:36,500 --> 00:00:40,200
Look for patterns, not perfection.

11
00:00:40,500 --> 00:00:44,200
Financial literacy is a skill you can build.

12
00:00:44,500 --> 00:00:48,200
And every small step counts.
`
function useSample() {
  return chooseFile(new File([sample], 'cash-flow-intro.srt', { type: 'text/plain' }))
}
const backgrounds = computed(() => [
  [
    t('课程讲解'),
    t('这是一段面向初学者的教学视频。请使用清晰、准确、易于理解的表达，保留专业术语，保持讲解的亲切感。'),
  ],
  [
    t('访谈对话'),
    t('这是一段人物访谈。请保留说话人的语气、幽默和情绪，使用自然的口语表达，保持人称与称谓一致。'),
  ],
  [
    t('影视对白'),
    t('这是一段影视对白。请结合语境表达人物情绪，采用简洁、自然的字幕语言，保留角色称谓和专有名词。'),
  ],
])
async function makeJob(start: boolean) {
  if (creating.value) return
  if (!fileDocument.value) {
    fail(new MessageError(message('请先上传一份字幕，或使用示例字幕')))
    return
  }
  try {
    creating.value = true
    const job = await createJob(
      filename.value,
      fileDocument.value,
      settings.value,
      parseSeedTerms(settings.value.useGlossary ? seedTerms.value : ''),
    )
    creating.value = false
    navigate('detail', job.id)
    if (start) requestStart(job)
    else flash(message('任务已保存，随时可以继续'))
  } catch (error) {
    fail(error)
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <section class="page-intro">
    <div>
      <span class="eyebrow"><span></span> SUBTITLE TRANSLATION</span>
      <h1>
        {{ t('让每一句，') }}<span>{{ t('都恰如其分。') }}</span>
      </h1>
      <p>{{ t('跨越语言，保留语境。把时间留给故事，让翻译自然发生。') }}</p>
    </div>
    <div class="intro-badges">
      <span><Icon name="captions" :size="15" />SRT / VTT</span
      ><span><Icon name="book" :size="15" />{{ t('术语记忆') }}</span>
    </div>
  </section>
  <div class="new-layout">
    <div class="new-main">
      <section class="card upload-card">
        <div class="card-heading">
          <h2><span class="step-number">01</span>{{ t('导入字幕') }}</h2>
          <span class="muted">{{ t('原始时间轴，完整保留') }}</span>
        </div>
        <UploadZone :document="fileDocument" :filename="filename" :loading="reading" @file="chooseFile" />
        <div v-if="!fileDocument" class="sample-row">
          <span>{{ t('还没准备好字幕？') }}</span
          ><button class="text-button" :disabled="reading" @click="useSample">
            {{ t('试用示例字幕') }}<Icon name="arrow" :size="14" />
          </button>
        </div>
        <div v-else class="source-preview">
          <div class="preview-label">
            <span>{{ t('字幕预览') }}</span
            ><span>{{ t('预计 {0} 个语义块', { 0: estimatedChunks || '—' }) }}</span>
          </div>
          <div v-for="cue in fileDocument.cues.slice(0, 3)" :key="cue.id" class="source-preview-row">
            <span>{{ timestamp(cue.start, false) }}</span>
            <p>{{ cue.text }}</p>
          </div>
          <div v-if="fileDocument.cues.length > 3" class="preview-more">
            {{ t('还有 {0} 条字幕，将在工作台中显示', { 0: fileDocument.cues.length - 3 }) }}
          </div>
        </div>
      </section>
      <section class="card context-card">
        <div class="card-heading">
          <h2><span class="step-number">02</span>{{ t('补充背景') }}</h2>
          <span class="optional-label">{{ t('可选，但很有帮助') }}</span>
        </div>
        <p class="card-description">
          {{ t('告诉模型故事发生在哪里、说给谁听，以及你期待的表达风格。') }}
        </p>
        <label class="sr-only" for="background-input">{{ t('背景设定') }}</label
        ><textarea
          id="background-input"
          v-model="settings.background"
          rows="4"
          :maxlength="limits.background"
          :placeholder="
            t('例如：这是一场面向初学者的投资讲座。讲者语气热情、口语化，请准确翻译金融术语，并保留互动感。')
          "
        ></textarea>
        <div class="prompt-presets">
          <span>{{ t('快速填入') }}</span
          ><button v-for="[label, text] in backgrounds" :key="label" @click="settings.background = text">
            {{ label }}<Icon name="plus" :size="12" />
          </button>
        </div>
        <div class="glossary-intro">
          <span class="glossary-icon"><Icon name="book" :size="20" /></span>
          <div>
            <strong>{{ t('一个术语，从头到尾一个译法') }}</strong>
            <p>{{ t('每轮积累专名、专业表达与风格备忘，让后续翻译沿用。') }}</p>
          </div>
          <label class="checkbox-label glossary-toggle">
            <input
              v-model="settings.useGlossary"
              type="checkbox"
              data-testid="use-glossary"
              :aria-label="t('使用术语库')"
              @change="onGlossaryToggle"
            />{{ t('使用术语库') }}
          </label>
          <button
            v-if="settings.useGlossary"
            class="text-button"
            data-testid="seed-glossary"
            :aria-expanded="showSeed"
            @click="showSeed = !showSeed"
          >
            {{ t('预设术语') }}<Icon name="down" :size="14" :class="{ rotated: showSeed }" />
          </button>
        </div>
        <div v-if="settings.useGlossary && showSeed" class="seed-terms">
          <label class="field"
            ><span>{{ t('你的术语优先级最高') }}</span
            ><textarea
              v-model="seedTerms"
              rows="3"
              :aria-label="t('预设术语')"
              :placeholder="t('cash flow = 现金流\nfinancial literacy = 财商')"
            ></textarea>
          </label>
          <p class="field-hint">{{ t('每行一个「原文 = 译文」。也可以在翻译工作台中随时调整。') }}</p>
        </div>
      </section>
      <div class="workflow-note">
        <Icon name="shield" :size="16" /><span>{{
          t('字幕与进度保存在本地。使用自己的 API Key，连接自己选择的模型。')
        }}</span>
      </div>
    </div>
    <aside class="card settings-card">
      <div class="card-heading">
        <h2><Icon name="settings" :size="18" />{{ t('翻译设置') }}</h2>
        <span class="small-label">{{ t('自定义') }}</span>
      </div>
      <button class="model-selector" @click="openAPI()">
        <span class="model-avatar"><Icon name="sparkle" :size="18" /></span
        ><span
          ><strong>{{ workspace.preferences.model }}</strong
          ><small>{{
            modelReady ? hostName(workspace.preferences.baseUrl) : t('填写 API Key 后即可开始')
          }}</small></span
        ><Icon name="right" :size="16" /></button
      ><SettingsFields v-model="settings" />
      <div class="start-section">
        <button
          class="button primary full start-button"
          :disabled="creating || reading"
          @click="makeJob(true)"
        >
          <Icon name="sparkle" :size="18" />{{ busy ? t('加入队列') : t('开始翻译')
          }}<Icon name="arrow" :size="17" /></button
        ><button class="save-later" :disabled="creating || reading" @click="makeJob(false)">
          {{ t('保存任务，稍后翻译') }}
        </button>
        <p><Icon name="lock" :size="12" />{{ t('API Key 默认仅在当前页面使用') }}</p>
      </div>
    </aside>
  </div>
  <section class="recent-section">
    <div class="section-title">
      <h2>
        {{ t('最近的任务') }}<span v-if="workspace.jobs.length">{{ workspace.jobs.length }}</span>
      </h2>
      <button class="text-button" @click="navigate('tasks')">
        {{ t('查看全部') }}<Icon name="arrow" :size="14" />
      </button>
    </div>
    <div v-if="!recent.length" class="empty-recent">
      <span class="empty-mini-icon"><Icon name="history" :size="23" /></span>
      <div>
        <strong>{{ t('第一段新故事，等你开启') }}</strong>
        <p>{{ t('创建的任务会出现在这里，中断后也能接着翻译。') }}</p>
      </div>
      <span class="empty-dashes">— — —</span>
    </div>
    <div v-else class="recent-list">
      <button
        v-for="job in recent.slice(0, 3)"
        :key="job.id"
        class="recent-row"
        @click="navigate('detail', job.id)"
      >
        <span class="file-icon small"><Icon name="file" :size="20" /></span
        ><span class="recent-name"
          ><strong>{{ job.name }}</strong
          ><small>{{
            t('{0} → {1} · {2} 条字幕', {
              0: languageName(job.settings.sourceLanguage),
              1: languageName(job.settings.targetLanguage),
              2: job.document.cues.length,
            })
          }}</small></span
        ><span class="status-badge" :class="statusTone(job)">{{ statusLabel(job) }}</span
        ><span class="recent-percent">{{ percent(job) }}%</span><Icon name="right" :size="16" />
      </button>
    </div>
  </section>
</template>
