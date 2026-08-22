<script setup lang="ts">
import { NCard, NForm, NFormItem, NSelect, NSpace, NStatistic } from 'naive-ui';
import { SettingsOutline } from '@vicons/ionicons5';
import { useConfigStore } from '../../configStore';

const store = useConfigStore();

// 默认模型：直接双向绑定 store.defaultModel，切换即实时防抖保存（无需单独保存按钮）
function onDefaultModelChange(): void {
  store.scheduleAutoSave({ successMsg: '基本设置已保存' });
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
  </n-card>
</template>
