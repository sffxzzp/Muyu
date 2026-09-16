<script setup lang="ts">
import { t } from '../i18n'
import { ref } from 'vue'
import { duration, type SubtitleDocument } from '../types'
import Icon from './Icon.vue'
defineProps<{
  document?: SubtitleDocument
  filename?: string
  compact?: boolean
  label?: string
  loading?: boolean
  disabled?: boolean
}>()
const emit = defineEmits<{ file: [file: File] }>()
const input = ref<HTMLInputElement>()
const dragging = ref(false)
function picked(e: Event) {
  const target = e.target as HTMLInputElement
  if (target.files?.[0]) emit('file', target.files[0])
  target.value = ''
}
function dropped(e: DragEvent) {
  dragging.value = false
  if (e.dataTransfer?.files[0]) emit('file', e.dataTransfer.files[0])
}
</script>

<template>
  <input
    ref="input"
    type="file"
    accept=".srt,.vtt"
    class="sr-only"
    :aria-label="label ?? t('上传字幕文件')"
    :disabled="disabled || loading"
    @change="picked"
  />
  <div v-if="document" class="uploaded-file" :class="{ compact }">
    <div class="file-icon"><Icon name="file" :size="25" /></div>
    <div class="file-summary">
      <strong>{{ filename }}</strong>
      <p>
        <span class="tiny-badge">{{ document.format.toUpperCase() }}</span
        ><span>{{ t('{0} 条字幕', { 0: document.cues.length }) }}</span
        ><span>{{ t('时长 {0}', { 0: duration(document) }) }}</span>
      </p>
    </div>
    <button class="text-button" :disabled="disabled || loading" @click="input?.click()">
      {{ t('更换') }}
    </button>
  </div>
  <button
    v-else
    type="button"
    class="upload-zone"
    :class="{ dragging, compact }"
    :disabled="disabled || loading"
    @click="input?.click()"
    @dragover.prevent="dragging = true"
    @dragleave.prevent="dragging = false"
    @drop.prevent="!disabled && dropped($event)"
  >
    <span class="upload-illustration"
      ><Icon :name="loading ? 'loading' : 'upload'" :size="29" :class="{ spinning: loading }"
    /></span>
    <strong>{{
      loading ? t('正在解析字幕…') : compact ? t('点击上传或拖入文件') : t('把字幕拖到这里，故事从这里开始')
    }}</strong>
    <span v-if="!compact" class="upload-link">{{ t('选择字幕文件') }}<Icon name="arrow" :size="15" /></span>
    <span class="upload-formats"
      >SRT / VTT <span>·</span>{{ t('UTF-8 编码') }}<span>·</span>{{ t('最大 2 MB') }}</span
    >
  </button>
</template>
