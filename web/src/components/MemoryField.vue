<script setup lang="ts">
import { computed } from 'vue'
import { t, localize } from '../i18n'
import { memoryEdits, workspace } from '../workspace'
import { memoryValue, type MemoryField } from '../storage'
import { limits } from '../validation'

const props = defineProps<{
  jobId: string
  field: MemoryField
  label: string
  disabled?: boolean
  multiline?: boolean
  placeholder?: string
  testId?: string
}>()
const draft = computed(() => memoryEdits.get(props.jobId, props.field))
const saved = computed(() =>
  memoryValue(
    workspace.jobs.find((job) => job.id === props.jobId),
    props.field,
  ),
)
const maximum = computed(() =>
  props.field === 'style'
    ? limits.style
    : props.field.endsWith(':source')
      ? limits.termSource
      : props.field.endsWith(':target')
        ? limits.termTarget
        : limits.termNote,
)
const inputValue = (event: Event) => (event.target as HTMLInputElement).value
</script>

<template>
  <div class="memory-field">
    <component
      :is="multiline ? 'textarea' : 'input'"
      :value="memoryEdits.value(jobId, field)"
      :aria-label="label"
      :data-testid="testId"
      :aria-invalid="!!draft?.error"
      :maxlength="maximum"
      :disabled="disabled"
      :placeholder="placeholder"
      :rows="multiline ? 4 : undefined"
      @focus="memoryEdits.begin(jobId, field)"
      @input="memoryEdits.change(jobId, field, inputValue($event))"
      @compositionstart="memoryEdits.startComposition(jobId, field)"
      @compositionend="memoryEdits.endComposition(jobId, field, inputValue($event))"
      @blur="memoryEdits.blur(jobId, field)"
    />
    <div v-if="draft?.error" class="edit-conflict" role="alert">
      <p>{{ localize(draft.error) }}</p>
      <p class="preserve-lines">{{ t('已保存内容：{0}', { 0: saved ?? '' }) }}</p>
      <button
        type="button"
        class="text-button"
        :disabled="draft.saving || disabled"
        @click="memoryEdits.keepMine(jobId, field)"
      >
        {{ t('保存我的修改') }}
      </button>
      <button
        type="button"
        class="text-button"
        :disabled="draft.saving"
        @click="memoryEdits.restore(jobId, field)"
      >
        {{ t('使用已保存内容') }}
      </button>
    </div>
  </div>
</template>
