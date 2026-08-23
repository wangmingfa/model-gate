<script setup lang="ts">
import { NIcon } from 'naive-ui';
import type { Component } from 'vue';

export interface SectionItem {
  key: string;
  label: string;
  icon: Component;
  count?: number;
}

defineProps<{ sections: SectionItem[]; active: string }>();
const emit = defineEmits<{ (e: 'update:active', key: string): void }>();
</script>

<template>
  <aside class="section-nav">
    <button
      v-for="s in sections"
      :key="s.key"
      type="button"
      :class="{ active: active === s.key }"
      @click="emit('update:active', s.key)"
    >
      <n-icon :size="16"><component :is="s.icon" /></n-icon>
      <span>{{ s.label }}</span>
      <span v-if="s.count" class="nav-count">{{ s.count }}</span>
    </button>
  </aside>
</template>

<style>
/* ---- 分版块导航：左侧列表 ---- */
.section-nav {
  width: 168px;
  flex-shrink: 0;
  position: sticky;
  top: 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.section-nav button {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border: none;
  background: transparent;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  color: #555;
  text-align: left;
  transition: background 0.15s ease, color 0.15s ease;
}
.section-nav button:hover {
  background: rgba(99, 102, 241, 0.08);
}
.section-nav button.active {
  background: #fff;
  color: #4f46e5;
  font-weight: 600;
  box-shadow: 0 2px 8px rgba(99, 102, 241, 0.18);
}
/* 数量徽标：keys/providers/aliases 条目数 */
.nav-count {
  margin-left: auto;
  font-size: 12px;
  color: #999;
  background: #eef0f5;
  border-radius: 10px;
  padding: 0 8px;
  line-height: 18px;
}
.section-nav button.active .nav-count {
  background: #e0e7ff;
  color: #4f46e5;
}

/* ---- 移动端：导航变横向可滚动条，位于内容上方 ---- */
@media (max-width: 760px) {
  .section-nav {
    width: 100%;
    position: static;
    flex-direction: row;
    overflow-x: auto;
    gap: 6px;
    padding-bottom: 2px;
    -webkit-overflow-scrolling: touch;
  }
  .section-nav button {
    flex-shrink: 0;
    white-space: nowrap;
    padding: 7px 10px;
    font-size: 13px;
  }
  .nav-count {
    margin-left: 4px;
  }
}
</style>
