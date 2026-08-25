<script setup lang="ts">
import { ref } from 'vue';
import { NCard, NForm, NFormItem, NSelect, NSpace, NStatistic, NButton, NIcon, useMessage } from 'naive-ui';
import { SettingsOutline, DownloadOutline, ArrowUpOutline } from '@vicons/ionicons5';
import { useConfigStore } from '../../configStore';
import { exportConfig, importConfig, type ConfigDraft } from '../../api';

const store = useConfigStore();
const message = useMessage();

// 默认模型：直接双向绑定 store.defaultModel，切换即实时防抖保存（无需单独保存按钮）
function onDefaultModelChange(): void {
  store.scheduleAutoSave({ successMsg: '基本设置已保存' });
}

const exporting = ref(false);
const importing = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

async function onExport(): Promise<void> {
  exporting.value = true;
  try {
    const cfg = await exportConfig();
    const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `model-gate-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    message.success('配置已导出');
  } catch (e) {
    message.error(`导出失败：${(e as Error).message}`);
  } finally {
    exporting.value = false;
  }
}

function triggerImport(): void {
  fileInput.value?.click();
}

async function onFileChange(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  importing.value = true;
  try {
    const text = await file.text();
    const draft = JSON.parse(text) as ConfigDraft;
    await importConfig(draft);
    message.success('配置已导入并保存（热加载生效）');
    await store.load();
  } catch (e) {
    message.error(`导入失败：${(e as Error).message}`);
  } finally {
    importing.value = false;
    input.value = '';
  }
}
</script>

<template>
  <n-card size="small" class="soft-card">
    <template #header>
      <span class="card-title"><n-icon :size="16"><SettingsOutline /></n-icon> 基本设置</span>
    </template>
    <n-space size="large">
      <n-statistic label="端口" :value="store.startup.port" />
      <n-statistic label="监听地址" :value="store.startup.host" />
      <n-statistic label="超时（秒）" :value="store.startup.timeout_seconds" />
      <n-statistic label="access.log" :value="store.startup.access_log ? '开' : '关'" />
    </n-space>
    <div style="margin-top: 12px; color: #999; font-size: 12px">
      以上为启动参数，只读展示；修改需编辑 config.json 后重启服务。
    </div>
    <n-form-item label="默认模型（agent 未指定 model 时使用）" style="margin-top: 12px">
      <div :class="{ 'field-error': store.defaultModelError }" style="width: 100%">
        <n-select
          v-model:value="store.defaultModel"
          :options="store.defaultModelOptions"
          placeholder="选择一个别名"
          style="width: 100%"
          @update:value="onDefaultModelChange"
        />
      </div>
    </n-form-item>
    <div style="margin-top: 16px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap">
      <n-button size="small" :loading="exporting" @click="onExport">
        <template #icon><n-icon><DownloadOutline /></n-icon></template>
        导出配置
      </n-button>
      <n-button size="small" :loading="importing" @click="triggerImport">
        <template #icon><n-icon><ArrowUpOutline /></n-icon></template>
        导入配置
      </n-button>
      <span style="color: #9ca3af; font-size: 12px">导出为 JSON 备份；导入将覆盖当前配置并热加载</span>
      <input ref="fileInput" type="file" accept="application/json,.json" style="display: none" @change="onFileChange" />
    </div>
  </n-card>
</template>
