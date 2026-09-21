<script setup lang="ts">
import { t } from '../i18n'
import { computed, useId } from 'vue'
import { languages, languageName, languageValue } from '../languages'
import { type Settings } from '../types'
import Icon from './Icon.vue'
const settings = defineModel<Settings>({ required: true })
defineProps<{ locked?: boolean; disabled?: boolean }>()
const id = useId()
const sourceLanguage = computed({
  get: () => languageName(settings.value.sourceLanguage),
  set: (label: string) => {
    settings.value.sourceLanguage = languageValue(label)
  },
})
const targetLanguage = computed({
  get: () => languageName(settings.value.targetLanguage),
  set: (label: string) => {
    settings.value.targetLanguage = languageValue(label)
  },
})
</script>

<template>
  <div class="language-fields">
    <label class="field"
      ><span>{{ t('源语言') }}</span
      ><input
        v-model="sourceLanguage"
        :list="`${id}-source`"
        :disabled="disabled || locked"
        :aria-label="t('源语言')"
        :placeholder="t('自动检测')"
    /></label>
    <Icon class="language-arrow" name="arrow" :size="17" />
    <label class="field"
      ><span>{{ t('目标语言') }}</span
      ><input
        v-model="targetLanguage"
        :list="`${id}-target`"
        :disabled="disabled || locked"
        :aria-label="t('目标语言')"
        :placeholder="t('简体中文')"
    /></label>
  </div>
  <datalist :id="`${id}-source`">
    <option :value="t('自动检测')">{{ t('自动检测') }}</option>
    <option v-for="[value] in languages" :key="value" :value="languageName(value)">
      {{ languageName(value) }}
    </option>
  </datalist>
  <datalist :id="`${id}-target`">
    <option v-for="[value] in languages" :key="value" :value="languageName(value)">
      {{ languageName(value) }}
    </option>
  </datalist>
  <p class="field-hint">{{ t('可选择语言，也可直接输入其他语言名称。') }}</p>
  <label class="checkbox-label glossary-setting">
    <input
      v-model="settings.useGlossary"
      type="checkbox"
      :disabled="disabled"
      :aria-label="t('使用术语库')"
    />{{ t('使用术语库') }}
  </label>
  <p class="field-hint">
    {{ t('关闭后不向模型发送术语，也不提取新术语。已保存的词条仍保留在本地。') }}
  </p>
  <div class="field-divider"></div>
  <div class="field-title">
    <span><Icon name="list" :size="16" />{{ t('语义分块') }}</span
    ><span class="subtle">{{ t('条 / 块') }}</span>
  </div>
  <div class="form-grid two">
    <label class="field"
      ><span class="subtle">{{ t('目标条数') }}</span
      ><input
        v-model.number="settings.targetChunkSize"
        type="number"
        min="1"
        max="100"
        :aria-label="t('目标块大小')"
        :disabled="disabled"
    /></label>
    <label class="field"
      ><span class="subtle">{{ t('单块上限') }}</span
      ><input
        v-model.number="settings.maxChunkSize"
        type="number"
        min="1"
        max="100"
        :aria-label="t('分块条数上限')"
        :disabled="disabled"
    /></label>
  </div>
  <p class="field-hint">{{ t('结合源语言句界和字幕停顿，在目标条数附近切分。') }}</p>
  <label class="field rpm-field"
    ><span><Icon name="clock" :size="16" />{{ t('请求频率') }}<span class="subtle">RPM</span></span>
    <div class="input-unit">
      <input
        v-model.number="settings.rpm"
        type="number"
        min="1"
        max="600"
        :aria-label="t('每分钟请求数 RPM')"
        :disabled="disabled"
      /><span>{{ t('次 / 分钟') }}</span>
    </div></label
  >
  <details class="advanced-settings">
    <summary>
      <span><Icon name="sliders" :size="16" />{{ t('更多参数') }}</span
      ><Icon name="down" :size="16" />
    </summary>
    <div class="form-grid two">
      <label class="field"
        ><span>{{ t('前文条数') }}</span
        ><input v-model.number="settings.contextSize" type="number" min="0" max="20" :disabled="disabled"
      /></label>
      <label class="field"
        ><span>{{ t('后文条数') }}</span
        ><input
          v-model.number="settings.futureContextSize"
          type="number"
          min="0"
          max="20"
          :disabled="disabled"
      /></label>
      <label class="field"
        ><span>{{ t('失败重试次数') }}</span
        ><input v-model.number="settings.maxRetries" type="number" min="0" max="8" :disabled="disabled"
      /></label>
      <label class="field"
        ><span>{{ t('块字符上限') }}</span
        ><input
          v-model.number="settings.maxChunkCharacters"
          type="number"
          min="500"
          max="30000"
          step="500"
          :disabled="disabled"
      /></label>
      <label class="field"
        ><span>{{ t('请求超时 / 秒') }}</span
        ><input
          v-model.number="settings.timeoutSeconds"
          type="number"
          min="10"
          max="180"
          :disabled="disabled"
      /></label>
      <label class="field"
        ><span>{{ t('输出 Token 上限') }}</span
        ><input
          v-model.number="settings.maxTokens"
          type="number"
          min="256"
          max="32768"
          step="256"
          :disabled="disabled"
      /></label>
      <label class="field"
        ><span>Temperature</span
        ><input
          v-model.number="settings.temperature"
          type="number"
          min="0"
          max="2"
          step="0.1"
          :disabled="disabled || settings.temperature === null"
      /></label>
    </div>
    <p class="field-hint">{{ t('前文带原文与译文，后文仅带原文；设为 0 可关闭对应上下文。') }}</p>
    <label class="checkbox-label"
      ><input
        type="checkbox"
        :checked="settings.temperature === null"
        :disabled="disabled"
        @change="settings.temperature = ($event.target as HTMLInputElement).checked ? null : 0.1"
      />{{ t('省略 Temperature 参数') }}</label
    >
    <p class="field-hint">{{ t('部分推理模型要求省略此参数。每次重试也会计入 RPM。') }}</p>
  </details>
</template>
