<script setup lang="ts">
import { ref, watch } from 'vue';
import { NCard, NForm, NFormItem, NSelect, NSpace, NStatistic, NButton, NIcon } from 'naive-ui';
import { SettingsOutline, SaveOutline } from '@vicons/ionicons5';
import { useConfigStore } from '../../configStore';

const store = useConfigStore();

// 本地草稿：编辑不实时落盘，点「保存」才写回 store 并保存
const defaultModelDraft = ref(store.defaultModel);

// store.defaultModel 由 load() 异步填充；首次有值时同步（用户未编辑才覆盖）
watch(
  () => store.defaultModel,
  (val) => {
    if (val && !defaultModelDraft.value) defaultModelDraft.value = val;
  },
);

async function onSave(): Promise<void> {
  store.defaultModel = defaultModelDraft.value;
  await store.saveSection({ successMsg: '基本设置已保存' });
  // 保存后同步草稿（失败 load 已回滚，草稿以 store 为准）
  defaultModelDraft.value = store.defaultModel;
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
        <n-select v-model:value="defaultModelDraft" :options="store.defaultModelOptions" placeholder="选择一个别名" style="width: 100%" />
      </div>
    </n-form-item>
    <n-space justify="end">
      <n-button type="primary" :loading="store.saving" @click="onSave">
        <template #icon><n-icon><SaveOutline /></n-icon></template>
        保存
      </n-button>
    </n-space>
  </n-card>
</template>
