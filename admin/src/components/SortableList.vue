<script setup lang="ts">
import { NButton, NIcon, NTooltip } from 'naive-ui';
import {
  ChevronUpOutline,
  ArrowUpOutline,
  ArrowDownOutline,
  TrashOutline,
} from '@vicons/ionicons5';

interface Props {
  /** 列表数据（字符串数组，如 model id 或 "provider:model"） */
  items: string[];
  /** 行级稳定 ID：用作 v-for :key，保证排序/置顶动画（FLIP）能稳定追踪每一行，
   *  且编辑内容时不会因 key 变化失焦。长度与 items 不一致时由组件自动补齐。 */
  rowIds?: string[];
  /** 底部「添加」按钮文案 */
  addLabel?: string;
  /** 是否显示「置顶」按钮 */
  showTop?: boolean;
  /** 是否显示「上移/下移」按钮 */
  showMove?: boolean;
  /** 是否显示「删除」按钮 */
  showDelete?: boolean;
  /** 底部添加按钮尺寸（默认 small，避免 tiny 太小） */
  addSize?: 'tiny' | 'small' | 'medium' | 'large';
  /** 每行操作按钮尺寸（默认 small） */
  btnSize?: 'tiny' | 'small' | 'medium' | 'large';
}
const props = withDefaults(defineProps<Props>(), {
  items: () => [],
  rowIds: undefined,
  addLabel: '+ 添加',
  showTop: true,
  showMove: true,
  showDelete: true,
  addSize: 'small',
  btnSize: 'small',
});

const emit = defineEmits<{
  'update:items': [string[]];
  'update:rowIds': [string[]];
  add: [];
}>();

function genId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `rid-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/** 以 props.items / props.rowIds 为基准，拷出一份长度对齐的副本；
 *  若 rowIds 缺失或长度不符，自动补齐，保证 TransitionGroup 的 :key 稳定。 */
function withIds(): { items: string[]; ids: string[] } {
  const items = [...props.items];
  const ids = [...(props.rowIds ?? [])];
  while (ids.length < items.length) ids.push(genId());
  if (ids.length > items.length) ids.length = items.length;
  return { items, ids };
}

function onAdd(): void {
  const { items, ids } = withIds();
  items.push('');
  ids.push(genId());
  emit('update:items', items);
  emit('update:rowIds', ids);
  emit('add');
}
function onRemove(idx: number): void {
  const { items, ids } = withIds();
  items.splice(idx, 1);
  ids.splice(idx, 1);
  emit('update:items', items);
  emit('update:rowIds', ids);
}
function onMove(idx: number, dir: -1 | 1): void {
  const t = idx + dir;
  if (t < 0 || t >= props.items.length) return;
  const { items, ids } = withIds();
  [items[idx], items[t]] = [items[t], items[idx]];
  [ids[idx], ids[t]] = [ids[t], ids[idx]];
  emit('update:items', items);
  emit('update:rowIds', ids);
}
function onTop(idx: number): void {
  if (idx <= 0) return;
  const { items, ids } = withIds();
  const m = items.splice(idx, 1)[0];
  items.unshift(m);
  const id = ids.splice(idx, 1)[0];
  ids.unshift(id);
  emit('update:items', items);
  emit('update:rowIds', ids);
}
</script>

<template>
  <div class="model-list-wrap">
    <TransitionGroup name="model-move" tag="div" class="model-list">
      <div v-for="(it, idx) in items" :key="rowIds?.[idx] ?? idx" :class="['model-row']">
        <!-- 每行内容由父级通过 #item 插槽提供（如 n-input 或 n-select），并直接双向绑定 items[index] -->
        <slot name="item" :items="items" :index="idx" :item="it" />
        <n-tooltip v-if="showTop" trigger="hover">
          <template #trigger>
            <n-button :size="btnSize" quaternary :disabled="idx === 0" @click="onTop(idx)">
              <template #icon><n-icon><ChevronUpOutline /></n-icon></template>
            </n-button>
          </template>
          置顶
        </n-tooltip>
        <n-tooltip v-if="showMove" trigger="hover">
          <template #trigger>
            <n-button :size="btnSize" quaternary :disabled="idx === 0" @click="onMove(idx, -1)">
              <template #icon><n-icon><ArrowUpOutline /></n-icon></template>
            </n-button>
          </template>
          上移
        </n-tooltip>
        <n-tooltip v-if="showMove" trigger="hover">
          <template #trigger>
            <n-button :size="btnSize" quaternary :disabled="idx === items.length - 1" @click="onMove(idx, 1)">
              <template #icon><n-icon><ArrowDownOutline /></n-icon></template>
            </n-button>
          </template>
          下移
        </n-tooltip>
        <n-tooltip v-if="showDelete" trigger="hover">
          <template #trigger>
            <n-button :size="btnSize" quaternary @click="onRemove(idx)">
              <template #icon><n-icon><TrashOutline /></n-icon></template>
            </n-button>
          </template>
          删除
        </n-tooltip>
      </div>
    </TransitionGroup>
    <!-- 添加按钮不占满宽度（去掉 block），尺寸默认 small 更清晰 -->
    <n-button :size="addSize" class="model-add-btn" @click="onAdd">{{ addLabel }}</n-button>
  </div>
</template>

<style lang="scss" scoped>
.model-list-wrap {
  width: 100%;
}
.model-list {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.model-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  background: #fff;
  border: 1px solid #eef0f3;
  border-radius: 8px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
/* 关键：naive-ui 输入框/选择器的边框由 --n-border 系列变量控制（无 borderless prop），
   必须在这里把它置空，否则行卡片边框 + 内部控件边框 = 双层边框。
   同时把 focus/active 的 box-shadow 提示环也置空——输入框/选择器始终零边框，
   focus 反馈改由整行 .model-row:focus-within 承担（见下方）。 */
.model-row {
  :deep(.n-input),
  :deep(.n-base-selection) {
    --n-border: none !important;
    --n-border-hover: none !important;
    --n-border-focus: none !important;
    --n-border-active: none !important;
    --n-border-disabled: none !important;
    --n-box-shadow-focus: none !important;
    --n-box-shadow-active: none !important;
    --n-box-shadow-focus-warning: none !important;
    --n-box-shadow-focus-error: none !important;
    --n-box-shadow-active-warning: none !important;
    --n-box-shadow-active-error: none !important;
  }
}
/* 聚焦整行高亮：当行内 input/select 获得焦点时，外层卡片边框变主色并带一圈主色光晕，
   等价于原输入框自身的 focus 环，但视觉上只作用于整行这一道边框。 */
.model-row:focus-within {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.18);
}
/* 排序/置顶时其余行平滑滑动（FLIP） */
.model-move-move {
  transition: transform 0.28s cubic-bezier(0.4, 0, 0.2, 1);
}
.model-move-enter-active,
.model-move-leave-active {
  transition: opacity 0.22s ease, transform 0.22s ease;
}
.model-move-enter-from,
.model-move-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
/* 删除时脱离文档流，避免占位导致其余行跳动异常 */
.model-move-leave-active {
  position: absolute;
  left: 0;
  right: 0;
}
.model-add-btn {
  margin-top: 8px;
}
</style>
