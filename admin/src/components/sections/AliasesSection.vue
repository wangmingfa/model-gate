<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import type { SelectOption, SelectGroupOption } from 'naive-ui';
import { NCard, NButton, NSpace, NCollapse, NCollapseItem, NForm, NFormItem, NInput, NSelect, NIcon, NTooltip, NEmpty } from 'naive-ui';
import { GitBranchOutline, SaveOutline } from '@vicons/ionicons5';
import { useConfigStore, type AliasRow } from '../../configStore';

const store = useConfigStore();

// 分组下拉选项：每个提供商是 type:'group' 分组标题，children 为该提供商的模型；
// 模型 value 用 "provider:model" 与 targets 格式一致，选中直接得到该字符串；
// 额外挂 provider/model 字段供 render-tag 拼出 "提供商 / 模型"
interface ModelOption extends SelectOption {
  provider?: string;
  model?: string;
}
const providerSelectOptions = computed<(SelectOption | SelectGroupOption)[]>(() => {
  const list = store.providers.length ? store.providers : draft.value;
  return list
    .filter((p) => p.name && p.models.length)
    .map((p) => ({
      type: 'group' as const,
      label: p.name,
      children: p.models.filter(Boolean).map((m) => ({
        label: `${p.name}:${m}`,
        value: `${p.name}:${m}`,
      })) as ModelOption[],
    }));
});

// 本地草稿：深拷贝，编辑不实时落盘；点「保存」才写回 store 并落盘
const draft = ref<AliasRow[]>(JSON.parse(JSON.stringify(store.aliases)));
// 折叠状态用本地驱动（默认全展开）
const expandedNames = ref<string[]>(draft.value.map((a) => a._id));

// 行级 ID 生成器（与 store 同款，仅前端追踪用）
let rowSeq = 0;
function nextRowId(): string {
  return `row-${++rowSeq}`;
}

function addAlias(): void {
  const id = nextRowId();
  draft.value.push({ _id: id, name: '', targets: [] });
  expandedNames.value.push(id); // 新行默认展开
}

// 单选 select 的临时选中值（每个别名独立，仅作「待添加」缓冲，不写回 targets）
const pendingTarget = ref<Record<string, string | null>>({});
function pendingOf(a: AliasRow): string | null {
  return pendingTarget.value[a._id] ?? null;
}
function onPendingChange(a: AliasRow, val: string | null): void {
  pendingTarget.value[a._id] = val;
}

// 添加：把单选 select 当前选中的目标追加进 targets（去重、不覆盖，顺序即 failover 顺序）
function addTarget(a: AliasRow): void {
  const val = pendingTarget.value[a._id];
  if (!val) return;
  if (!a.targets.includes(val)) a.targets.push(val);
  pendingTarget.value[a._id] = null; // 添加后清空选择，便于连续添加不同目标
}

// 已选目标：删除 / 上移 / 下移（failover 顺序由数组顺序决定）
function removeTarget(a: AliasRow, idx: number): void {
  a.targets.splice(idx, 1);
}
function moveTarget(a: AliasRow, idx: number, dir: -1 | 1): void {
  const j = idx + dir;
  if (j < 0 || j >= a.targets.length) return;
  const arr = a.targets;
  [arr[idx], arr[j]] = [arr[j], arr[idx]];
}

// 同 ProvidersSection：load() 异步填充后首次同步草稿
watch(
  () => store.aliases,
  (val) => {
    if (val.length && draft.value.length === 0) {
      draft.value = JSON.parse(JSON.stringify(val));
      expandedNames.value = draft.value.map((a) => a._id);
    }
  },
  { deep: false },
);
function removeAlias(index: number): void {
  const name = draft.value[index].name || `#${index + 1}`;
  store.removeAliasConfirm(name, async () => {
    draft.value.splice(index, 1);
    await onSave();
  });
}

async function onSave(): Promise<void> {
  // 清洗：丢弃非 "provider:model" 格式的脏目标值（如旧版多选残留的纯 provider 名）
  const cleaned = draft.value.map((a) => ({
    ...a,
    targets: a.targets.filter((t) => /^[^:]+:.+$/.test(t)),
  }));
  // 写回 store（深拷贝，避免草稿与 store 共享引用）
  store.aliases = JSON.parse(JSON.stringify(cleaned));
  await store.saveSection({ successMsg: '模型别名已保存' });
  // 同步草稿：失败也不丢内容——saveSection 不再 load 回滚，store.aliases 仍是刚写入的草稿拷贝
  draft.value = JSON.parse(JSON.stringify(store.aliases));
}
</script>

<template>
  <n-card size="small" class="soft-card">
    <template #header>
      <span class="card-title"><n-icon :size="16"><GitBranchOutline /></n-icon> 模型别名（aliases，agent 只认别名）</span>
    </template>
    <n-space vertical>
      <n-collapse v-model:expanded-names="expandedNames">
        <n-collapse-item v-for="(a, i) in draft" :key="a._id" :name="a._id" arrow-placement="left">
          <template #header>
            <span style="font-weight: 600">
              alias #{{ i + 1 }}
              <span v-if="a.name" style="font-weight: 400; color: #666">（{{ a.name }}）</span>
            </span>
          </template>
          <div
            :class="{ 'alias-item': true, 'field-error': store.erroredAliases.has(a.name) }"
            style="position: relative; border: 1px solid #eee; border-radius: 8px; padding: 12px 40px 12px 12px; display: flex; flex-direction: column; gap: 8px"
          >
            <n-tooltip trigger="hover">
              <template #trigger>
                <n-button
                  size="tiny"
                  type="error"
                  quaternary
                  circle
                  class="float-del-btn"
                  @click="removeAlias(i)"
                >
                  ✕
                </n-button>
              </template>
              删除该别名
            </n-tooltip>
            <n-form-item label="别名" style="margin-bottom: 0">
              <n-input v-model:value="a.name" placeholder="如 fast" style="width: 160px" />
            </n-form-item>
            <n-form-item label="添加目标（先选提供商，再选其下的模型，点添加可加多个）" style="margin-bottom: 4px">
              <div style="display: flex; align-items: center; gap: 8px; width: 100%">
                <n-select
                  :value="pendingOf(a)"
                  :options="providerSelectOptions"
                  placeholder="选择提供商下的模型"
                  style="flex: 1; min-width: 0"
                  @update:value="(val: string | null) => onPendingChange(a, val)"
                />
                <n-button size="small" :disabled="!pendingOf(a)" @click="addTarget(a)">+ 添加</n-button>
              </div>
            </n-form-item>
            <div v-if="a.targets.length" style="display: flex; flex-direction: column; gap: 6px">
              <div
                v-for="(t, ti) in a.targets"
                :key="t"
                style="display: flex; align-items: center; gap: 8px; border: 1px solid #eee; border-radius: 6px; padding: 4px 8px"
              >
                <span style="flex: 1; font-family: monospace; font-size: 13px">{{ t }}</span>
                <span style="color: #999; font-size: 12px">{{ ti === 0 ? '首选' : `故障转移 ${ti}` }}</span>
                <n-button size="tiny" quaternary :disabled="ti === 0" @click="moveTarget(a, ti, -1)">↑</n-button>
                <n-button size="tiny" quaternary :disabled="ti === a.targets.length - 1" @click="moveTarget(a, ti, 1)">↓</n-button>
                <n-button size="tiny" quaternary type="error" @click="removeTarget(a, ti)">✕</n-button>
              </div>
            </div>
            <n-empty v-else description="尚未添加目标模型" size="small" style="padding: 8px 0" />
          </div>
        </n-collapse-item>
      </n-collapse>
      <n-space justify="space-between">
        <n-button size="small" @click="addAlias">+ 添加别名</n-button>
        <n-button type="primary" :loading="store.saving" @click="onSave">
          <template #icon><n-icon><SaveOutline /></n-icon></template>
          保存
        </n-button>
      </n-space>
    </n-space>
  </n-card>
</template>

<style>
/* 删除按钮浮动在别名卡片右上角，不占用布局空间 */
.alias-item .float-del-btn {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 1;
}
</style>
