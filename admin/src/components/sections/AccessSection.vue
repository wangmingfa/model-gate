<script setup lang="ts">
import { NCard, NButton, NIcon } from 'naive-ui';
import { LinkOutline, CopyOutline } from '@vicons/ionicons5';
import { useConfigStore } from '../../configStore';

const store = useConfigStore();
</script>

<template>
  <!-- 接入信息：给 coding agent 配置用的地址，一键复制 -->
  <n-card size="small" class="soft-card">
    <template #header>
      <span class="card-title"><n-icon :size="16"><LinkOutline /></n-icon> 接入信息（配到 coding agent 用）</span>
    </template>
    <div class="api-url-row">
      <code class="api-url">{{ store.apiBaseUrl }}</code>
      <n-button size="small" type="primary" @click="store.copyApiBaseUrl">
        <template #icon><n-icon><CopyOutline /></n-icon></template>
        复制 API 地址
      </n-button>
    </div>
    <div style="margin-top: 8px; color: #999; font-size: 12px">
      OpenAI 兼容 Base URL；API Key 在下方「下游密钥」点复制；model 填别名（未指定时用 default_model）。
    </div>
  </n-card>
</template>

<style>
/* 接入信息：API 地址行 */
.api-url-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.api-url {
  flex: 1;
  font-size: 14px;
  padding: 6px 10px;
  background: #f5f5f5;
  border-radius: 6px;
  word-break: break-all;
  user-select: all;
}
</style>
