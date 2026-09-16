<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{ value: string }>()
const field = ref<HTMLTextAreaElement>()
let observer: ResizeObserver | undefined
let width = 0

function fit() {
  const element = field.value
  if (!element) return
  element.style.height = 'auto'
  const border = element.offsetHeight - element.clientHeight
  element.style.height = `${element.scrollHeight + border}px`
}

watch(() => props.value, fit, { flush: 'post' })
onMounted(() => {
  fit()
  observer = new ResizeObserver(([entry]) => {
    // Respond to line wrapping without reacting to our own height changes.
    if (entry.contentRect.width === width) return
    width = entry.contentRect.width
    fit()
  })
  if (field.value) observer.observe(field.value)
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <textarea ref="field" :value="value" @input="fit"></textarea>
</template>
