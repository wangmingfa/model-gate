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
  /** 整列表处于不可编辑态（如正在批量测试）：禁用编辑、右侧操作按钮与添加按钮。
   *  注意：逐行「测试缓冲」覆盖层由 pendingItems 单独控制，而非 disabled —— 这样已完成的
   *  行能立即露出结果标签，未完成的行才显示缓冲条，实现实时逐行反馈。 */
  disabled?: boolean;
  /** 正处于「进行中」的行数据（如正在探测的模型 id）。列表中的这些行会覆盖一层
   *  半透明白膜 + 底部流动进度条，表示还在测试中；其余行（已出结果）正常展示。 */
  pendingItems?: string[];
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
  disabled: false,
  pendingItems: () => [],
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
      <div
        v-for="(it, idx) in items"
        :key="rowIds?.[idx] ?? idx"
        :class="['model-row', { 'is-testing': disabled, 'is-pending': pendingItems.includes(it) }]"
      >
        <!-- 每行内容由父级通过 #item 插槽提供（如 n-input 或 n-select），并直接双向绑定 items[index] -->
        <slot name="item" :items="items" :index="idx" :item="it" :disabled="disabled" :pending="pendingItems.includes(it)" />
        <n-tooltip v-if="showTop" trigger="hover">
          <template #trigger>
            <n-button :size="btnSize" quaternary :disabled="disabled || idx === 0" @click="onTop(idx)">
              <template #icon><n-icon><ChevronUpOutline /></n-icon></template>
            </n-button>
          </template>
          置顶
        </n-tooltip>
        <n-tooltip v-if="showMove" trigger="hover">
          <template #trigger>
            <n-button :size="btnSize" quaternary :disabled="disabled || idx === 0" @click="onMove(idx, -1)">
              <template #icon><n-icon><ArrowUpOutline /></n-icon></template>
            </n-button>
          </template>
          上移
        </n-tooltip>
        <n-tooltip v-if="showMove" trigger="hover">
          <template #trigger>
            <n-button :size="btnSize" quaternary :disabled="disabled || idx === items.length - 1" @click="onMove(idx, 1)">
              <template #icon><n-icon><ArrowDownOutline /></n-icon></template>
            </n-button>
          </template>
          下移
        </n-tooltip>
        <n-tooltip v-if="showDelete" trigger="hover">
          <template #trigger>
            <n-button :size="btnSize" quaternary :disabled="disabled" @click="onRemove(idx)">
              <template #icon><n-icon><TrashOutline /></n-icon></template>
            </n-button>
          </template>
          删除
        </n-tooltip>
        <!-- 测试缓冲覆盖层：仅「进行中」的行出现，覆盖整行 + 底部流动进度条；
              已返回结果的行不显示，立即露出可用/不可用标签 -->
        <div v-if="pendingItems.includes(it)" class="model-row-overlay" aria-hidden="true"></div>
        <div v-if="pendingItems.includes(it)" class="model-row-buffer" aria-hidden="true"><i></i></div>
      </div>
    </TransitionGroup>
    <!-- 添加按钮不占满宽度（去掉 block），尺寸默认 small 更清晰 -->
    <n-button :size="addSize" class="model-add-btn" :disabled="disabled" @click="onAdd">{{ addLabel }}</n-button>
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
  position: relative;
}
/* 测试中：整行铺一层半透明白膜（覆盖编辑与操作），底部加流动进度条表示「正在测试」缓冲 */
.model-row.is-testing {
  border-color: #c7d2fe;
}
.model-row-overlay {
  position: absolute;
  inset: 0;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.5);
  cursor: progress;
  z-index: 1;
}
.model-row-buffer {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  border-radius: 0 0 8px 8px;
  overflow: hidden;
  background: rgba(99, 102, 241, 0.14);
  z-index: 2;
}
.model-row-buffer > i {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 38%;
  border-radius: 3px;
  background: linear-gradient(90deg, transparent, #6366f1, transparent);
  animation: model-row-buffer-slide 1.1s ease-in-out infinite;
}
@keyframes model-row-buffer-slide {
  0% {
    left: -40%;
  }
  100% {
    left: 100%;
  }
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
