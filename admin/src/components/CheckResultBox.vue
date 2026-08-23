<script setup lang="ts">
import { NIcon, NTag } from 'naive-ui';
import { AlertCircleOutline, CheckmarkCircleOutline } from '@vicons/ionicons5';
import type { ConfigIssue } from '../../api';

defineProps<{ issues: ConfigIssue[] | null }>();
</script>

<template>
  <!-- 配置体检结果：检查后展示，错误项会在对应字段标红；issues 为 null 表示尚未检查 -->
  <div v-if="issues !== null" class="check-result" :class="{ 'has-error': issues.some((i) => i.level === 'error') }">
    <div class="check-summary">
      <n-icon v-if="issues.some((i) => i.level === 'error')" :size="18"><AlertCircleOutline /></n-icon>
      <n-icon v-else :size="18"><CheckmarkCircleOutline /></n-icon>
      <span v-if="issues.some((i) => i.level === 'error')">
        发现 {{ issues.filter((i) => i.level === 'error').length }} 个错误、{{ issues.filter((i) => i.level === 'warning').length }} 个提示，已在下方标红
      </span>
      <span v-else-if="issues.length === 0">配置完全正确</span>
      <span v-else>未发现错误（{{ issues.length }} 个提示项）</span>
    </div>
    <ul v-if="issues.length" class="check-list">
      <li v-for="(issue, idx) in issues" :key="idx" :class="issue.level">
        <n-tag :type="issue.level === 'error' ? 'error' : 'warning'" size="small" round>
          {{ issue.level === 'error' ? '错误' : '提示' }}
        </n-tag>
        <span class="check-msg">{{ issue.message }}</span>
      </li>
    </ul>
  </div>
</template>

<style>
/* 检查配置正确性结果框 */
.check-result {
  border: 1px solid #e3e8ef;
  border-radius: 12px;
  padding: 12px 16px;
  margin-bottom: 16px;
  background: #fff;
}
.check-result.has-error {
  border-color: #f5b5b8;
  background: #fff7f7;
}
.check-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: #1f2937;
}
.check-result.has-error .check-summary {
  color: #c0392b;
}
.check-list {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.check-list li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  line-height: 1.5;
}
.check-list li.warning .check-msg {
  color: #8a6d3b;
}
.check-list li.error .check-msg {
  color: #b03a2e;
}

@media (max-width: 760px) {
  .check-result {
    margin-bottom: 10px;
    padding: 10px 12px;
  }
}
</style>
