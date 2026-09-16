<script setup lang="ts">
import { computed, ref } from 'vue'
import Icon from '../components/Icon.vue'
import UploadZone from '../components/UploadZone.vue'
import { errorMessage, message, MessageError } from '../messages'
import { t, localize } from '../i18n'
import { fail, flash, safely } from '../ui'
import { download, readSubtitle } from '../files'
import { assertAlignment, mergeSubtitles as mergeDocuments } from '../subtitle'
import type { SubtitleDocument } from '../types'
const original = ref<SubtitleDocument>(),
  translated = ref<SubtitleDocument>(),
  originalName = ref(''),
  translatedName = ref('')
const mergeFormat = ref('srt'),
  mergeOrder = ref('original-first'),
  merging = ref(false)
async function mergeFile(file: File, side: 'original' | 'translated') {
  await safely(async () => {
    const doc = await readSubtitle(file)
    if (side === 'original') {
      original.value = doc
      originalName.value = file.name
      mergeFormat.value = doc.format
    } else {
      translated.value = doc
      translatedName.value = file.name
    }
  })
}
const mergeComparison = computed(() => {
  if (!original.value || !translated.value) return ''
  try {
    assertAlignment(original.value, translated.value)
    return t('条数和时间轴完全对应，可以合并。')
  } catch (error) {
    return localize(errorMessage(error))
  }
})
async function mergeSubtitles() {
  if (!original.value || !translated.value) {
    fail(new MessageError(message('请上传原文和译文两份字幕')))
    return
  }
  merging.value = true
  try {
    const content = mergeDocuments(original.value, translated.value, mergeFormat.value, mergeOrder.value)
    download(content, `${originalName.value.replace(/\.(srt|vtt)$/i, '')}.bilingual.${mergeFormat.value}`)
    flash(message('双语字幕已生成'))
  } catch (error) {
    fail(error)
  } finally {
    merging.value = false
  }
}
</script>

<template>
  <section class="page-intro">
    <div>
      <span class="eyebrow"><span></span> BILINGUAL SUBTITLES</span>
      <h1>
        {{ t('两种语言，') }}<span>{{ t('同一段故事。') }}</span>
      </h1>
      <p>{{ t('将已有的原文和译文合为一份双语字幕，时间轴保持一致。') }}</p>
    </div>
    <span class="outline-badge"><Icon name="combine" :size="16" />{{ t('无需调用模型') }}</span>
  </section>
  <div class="merge-layout">
    <section class="card merge-card">
      <div class="merge-upload-grid">
        <div>
          <div class="card-heading">
            <h2><span class="step-number">01</span>{{ t('原文字幕') }}</h2>
          </div>
          <UploadZone
            :document="original"
            :filename="originalName"
            compact
            :label="t('上传原文字幕')"
            @file="mergeFile($event, 'original')"
          />
        </div>
        <span class="merge-plus"><Icon name="plus" :size="24" /></span>
        <div>
          <div class="card-heading">
            <h2><span class="step-number">02</span>{{ t('译文字幕') }}</h2>
          </div>
          <UploadZone
            :document="translated"
            :filename="translatedName"
            compact
            :label="t('上传译文字幕')"
            @file="mergeFile($event, 'translated')"
          />
        </div>
      </div>
      <div class="merge-explanation" :class="{ 'has-files': original && translated }">
        <Icon :name="original && translated ? 'info' : 'shield'" :size="17" /><span>{{
          mergeComparison || t('自动检查条数与时间轴。两份字幕需要逐条对应，支持混合上传 SRT 和 VTT。')
        }}</span>
      </div>
      <div class="merge-options">
        <label class="field"
          ><span>{{ t('导出格式') }}</span
          ><select v-model="mergeFormat">
            <option value="srt">{{ t('SRT 字幕') }}</option>
            <option value="vtt">{{ t('WebVTT 字幕') }}</option>
          </select></label
        ><label class="field"
          ><span>{{ t('上下排列') }}</span
          ><select v-model="mergeOrder">
            <option value="original-first">{{ t('原文在上，译文在下') }}</option>
            <option value="translation-first">{{ t('译文在上，原文在下') }}</option>
          </select></label
        ><button class="button primary" :disabled="merging" @click="mergeSubtitles()">
          <Icon :name="merging ? 'loading' : 'download'" :class="{ spinning: merging }" :size="17" />{{
            t('合并并下载')
          }}
        </button>
      </div>
    </section>
    <section class="merge-example">
      <span class="small-label">{{ t('双语字幕示意') }}</span>
      <div class="subtitle-preview-art">
        <span>00:00:01,000 → 00:00:04,200</span>
        <p>Every small step counts.</p>
        <strong>{{ t('每一小步，都有意义。') }}</strong>
        <div class="art-timeline"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
      </div>
      <p>{{ t('以原文字幕的时间轴为准，保留原有条目顺序。') }}</p>
    </section>
  </div>
</template>
