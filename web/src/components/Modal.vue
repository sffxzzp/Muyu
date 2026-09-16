<script setup lang="ts">
import { t } from '../i18n'
import { onMounted, onUnmounted, ref, useId } from 'vue'
import Icon from './Icon.vue'
defineProps<{ title: string; subtitle?: string; wide?: boolean }>()
const emit = defineEmits<{ close: [] }>()
const panel = ref<HTMLElement>()
const titleId = useId()
let previous: HTMLElement | null = null
function keydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
  if (e.key !== 'Tab') return
  const elements = [
    ...(panel.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
    ) ?? []),
  ].filter((el) => el.offsetParent !== null)
  if (!elements.length) {
    e.preventDefault()
    return
  }
  const first = elements[0],
    last = elements[elements.length - 1]
  if (e.shiftKey && document.activeElement === first) {
    last.focus()
    e.preventDefault()
  } else if (!e.shiftKey && document.activeElement === last) {
    first.focus()
    e.preventDefault()
  }
}
onMounted(() => {
  previous = document.activeElement as HTMLElement
  document.body.style.overflow = 'hidden'
  panel.value?.focus()
  document.addEventListener('keydown', keydown)
})
onUnmounted(() => {
  document.body.style.overflow = ''
  document.removeEventListener('keydown', keydown)
  previous?.focus()
})
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @click.self="emit('close')">
      <section
        ref="panel"
        class="modal"
        :class="{ wide }"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
      >
        <div class="modal-heading">
          <div>
            <h2 :id="titleId">{{ title }}</h2>
            <p v-if="subtitle">{{ subtitle }}</p>
          </div>
          <button class="icon-button" :aria-label="t('关闭弹窗')" @click="emit('close')">
            <Icon name="close" />
          </button>
        </div>
        <div class="modal-body"><slot /></div>
        <div v-if="$slots.footer" class="modal-footer"><slot name="footer" /></div>
      </section>
    </div>
  </Teleport>
</template>
