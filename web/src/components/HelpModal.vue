<script setup lang="ts">
import Icon from './Icon.vue'
import Modal from './Modal.vue'
import { t } from '../i18n'
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <Modal
    :title="t('从一句字幕，到一段好故事')"
    :subtitle="t('关于幕语工作台的几个小提示。')"
    @close="emit('close')"
    ><div class="help-list">
      <section>
        <Icon name="key" />
        <div>
          <h3>{{ t('使用自己的模型') }}</h3>
          <p>
            {{ t('填写兼容接口地址、模型名和 API Key。翻译用量由你选择的服务商计费，幕语不内置共享 Key。') }}
          </p>
        </div>
      </section>
      <section>
        <Icon name="history" />
        <div>
          <h3>{{ t('随时暂停，接着翻译') }}</h3>
          <p>
            {{
              t(
                '每个成功分块的译文、术语和风格备忘一起保存。刷新或关闭页面后，重新打开任务并继续即可。在途请求若未保存，恢复时可能重新发送。',
              )
            }}
          </p>
        </div>
      </section>
      <section>
        <Icon name="book" />
        <div>
          <h3>{{ t('让表达保持一致') }}</h3>
          <p>
            {{
              t(
                '每轮按相关性带入已有术语，同时提取当前块的新专名和专业表达。前后文与风格备忘帮助保持连贯，手动译法优先。',
              )
            }}
          </p>
        </div>
      </section>
      <section>
        <Icon name="storage" />
        <div>
          <h3>{{ t('数据留在当前浏览器') }}</h3>
          <p>
            {{
              t(
                '使用 localStorage，不会自动过期。可以删除单个任务或清空本站数据；换浏览器时先导出任务备份。浏览器空间有限，写入失败时会暂停，保留页面中的结果供备份。',
              )
            }}
          </p>
        </div>
      </section>
      <section>
        <Icon name="captions" />
        <div>
          <h3>{{ t('时间轴保持不变') }}</h3>
          <p>
            {{
              t(
                '支持 UTF-8 的 SRT 和 VTT。保留条目、时间点、格式标签与 VTT 元数据。字幕合并会检查条数和时间轴，出现差异时提示修正。',
              )
            }}
          </p>
        </div>
      </section>
    </div>
    <template #footer
      ><button class="button primary" @click="emit('close')">
        {{ t('知道了') }}<Icon name="check" :size="16" /></button></template
  ></Modal>
</template>
