<script setup lang="ts">
import { message } from '../messages'
import { reactive, ref } from 'vue'
import Icon from './Icon.vue'
import Modal from './Modal.vue'
import { t, localize } from '../i18n'
import { fail, flash } from '../ui'
import { apiKeyFor, notice, saveProfile, workspace } from '../workspace'
const props = defineProps<{ jobId: string; start: boolean }>()
const emit = defineEmits<{ close: []; saved: [startId: string] }>()
const job = workspace.jobs.find((job) => job.id === props.jobId)
const profile = job?.profile ?? workspace.preferences
const apiForm = reactive({
  ...profile,
  apiKey: apiKeyFor(profile, job?.id),
  rememberKey: workspace.preferences.rememberKey,
})
const pendingStartId = props.start ? props.jobId : ''
const showKey = ref(false)
function closeAPI() {
  apiForm.apiKey = ''
  emit('close')
}
function providerPreset(e: Event) {
  const value = (e.target as HTMLSelectElement).value
  if (value === 'nvidia')
    Object.assign(apiForm, { baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'openai/gpt-oss-20b' })
  if (value === 'deepseek')
    Object.assign(apiForm, { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' })
  apiForm.apiKey = apiKeyFor(apiForm)
}
async function submitAPI() {
  try {
    const job = workspace.jobs.find((job) => job.id === props.jobId)
    await saveProfile(
      { baseUrl: apiForm.baseUrl, model: apiForm.model, tokenParameter: apiForm.tokenParameter },
      apiForm.apiKey,
      apiForm.rememberKey,
      job,
    )
    const id = pendingStartId
    closeAPI()
    flash(message('接口配置已保存'))
    emit('saved', id)
  } catch (error) {
    fail(error)
  }
}
</script>

<template>
  <Modal
    :title="t('连接你的翻译模型')"
    :subtitle="t('兼容 Chat Completions 接口，使用你自己的 API Key。')"
    @close="closeAPI"
  >
    <form id="api-form" class="modal-form" @submit.prevent="submitAPI">
      <p v-if="notice" class="form-error" role="alert">{{ localize(notice) }}</p>
      <label class="field"
        ><span>{{ t('快速选择') }}</span
        ><select :aria-label="t('API 服务商')" @change="providerPreset">
          <option value="">{{ t('自定义 / 当前配置') }}</option>
          <option value="nvidia">NVIDIA NIM</option>
          <option value="deepseek">DeepSeek</option>
        </select></label
      ><label class="field"
        ><span>API Base URL</span
        ><input
          v-model="apiForm.baseUrl"
          type="url"
          required
          placeholder="https://example.com/v1"
          aria-label="API Base URL" /></label
      ><label class="field"
        ><span>{{ t('模型名称') }}</span
        ><input
          v-model="apiForm.model"
          required
          placeholder="openai/gpt-oss-20b"
          :aria-label="t('模型名称')" /></label
      ><label class="field"
        ><span>API Key</span>
        <div class="password-field">
          <input
            v-model="apiForm.apiKey"
            :type="showKey ? 'text' : 'password'"
            autocomplete="off"
            spellcheck="false"
            :placeholder="t('输入你的 API Key')"
            aria-label="API Key"
            :required="!!pendingStartId"
          /><button
            type="button"
            class="icon-button"
            :aria-label="showKey ? t('隐藏 API Key') : t('显示 API Key')"
            @click="showKey = !showKey"
          >
            <Icon :name="showKey ? 'eyeOff' : 'eye'" :size="17" />
          </button></div></label
      ><label class="checkbox-label"
        ><input v-model="apiForm.rememberKey" type="checkbox" />{{ t('在此浏览器记住 API Key') }}</label
      >
      <p class="field-hint">
        {{ t('默认刷新后需要重新填写。勾选后以明文保存在本地；任务备份始终不包含 Key。') }}
      </p>
      <details class="api-advanced">
        <summary>{{ t('接口兼容选项') }}<Icon name="down" :size="14" /></summary>
        <label class="field"
          ><span>{{ t('输出 Token 参数名称') }}</span
          ><select v-model="apiForm.tokenParameter">
            <option value="max_tokens">{{ t('max_tokens（多数兼容接口）') }}</option>
            <option value="max_completion_tokens">{{ t('max_completion_tokens（部分推理模型）') }}</option>
          </select></label
        >
      </details>
      <div class="privacy-note">
        <Icon name="shield" :size="17" />
        <p>
          {{
            t(
              '优先由浏览器直连接口，不限制 API 域名。跨域或网络连接失败时自动改用服务器转发，转发受本站白名单与限速约束。',
            )
          }}
          {{ t('直连时 Key 仅发送给模型接口；回退时会经过本站服务器，服务器不保存。') }}
        </p>
      </div>
    </form>
    <template #footer
      ><button class="button secondary" @click="closeAPI">{{ t('取消') }}</button
      ><button class="button primary" type="submit" form="api-form">
        {{ pendingStartId ? t('保存并开始翻译') : t('保存配置') }}<Icon name="arrow" :size="16" /></button
    ></template>
  </Modal>
</template>
