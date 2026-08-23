<script setup lang="ts">
import { NButton, NTooltip } from 'naive-ui';

// 统一的列表项卡片：负责外框样式、右上角浮动删除按钮、可选的底部「添加」按钮。
// 内容通过 #default 插槽传入；删除 emit 'remove'，添加 emit 'add'。
defineProps<{
  title?: string;
  error?: boolean;
  // 底部添加按钮文案；不传则不显示添加按钮（用于纯展示/单个 item）
  addLabel?: string;
  // 删除按钮的 tooltip 文案
  removeTooltip?: string;
  // 添加按钮是否为主要样式（primary）
  addPrimary?: boolean;
}>();

const emit = defineEmits<{
  (e: 'remove'): void;
  (e: 'add'): void;
}>();
</script>

<template>
  <div :class="{ 'item-card': true, 'field-error': !!error }">
    <n-tooltip v-if="!addLabel" trigger="hover">
      <template #trigger>
        <n-button
          size="tiny"
          type="error"
          quaternary
          circle
          class="item-card-del"
          @click="emit('remove')"
        >
          ✕
        </n-button>
      </template>
      {{ removeTooltip ?? '删除' }}
    </n-tooltip>

    <div v-if="title" class="item-card-title">{{ title }}</div>

    <div class="item-card-body">
      <slot />
    </div>

    <div v-if="addLabel" class="item-card-footer">
      <n-button size="small" :type="addPrimary ? 'primary' : 'default'" @click="emit('add')">
        {{ addLabel }}
      </n-button>
    </div>
  </div>
</template>

<style>
/* 列表项卡片外框：边框 + 圆角 + 统一 padding + 相对定位（给删除按钮做锚点） */
.item-card {
  position: relative;
  border: 1px solid #eee;
  border-radius: 8px;
  padding: 12px;
  /* 防止内部 n-select 等控件长文本撑宽卡片（移动端关键） */
  min-width: 0;
  overflow: hidden;
}
/* 错误态：红边提示 */
.item-card.field-error {
  border-color: var(--n-error-color, #e88080);
}
/* 删除按钮浮动在卡片右上角，压在边框上，不占内容布局空间 */
.item-card .item-card-del {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 1;
}
.item-card-title {
  font-weight: 600;
  margin-bottom: 8px;
  /* 给右上角删除按钮让位，避免标题文字被压 */
  padding-right: 28px;
}
.item-card-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.item-card-footer {
  margin-top: 8px;
}
</style>
