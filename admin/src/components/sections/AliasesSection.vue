<script setup lang="ts">
import { ref, watch, computed, onMounted } from 'vue';
import type { SelectOption, SelectGroupOption } from 'naive-ui';
import {
  NCard, NButton, NSpace, NCollapse, NCollapseItem, NForm, NFormItem, NInput, NSelect, NIcon, NDynamicInput, NTag,
} from 'naive-ui';
import { GitBranchOutline, SaveOutline } from '@vicons/ionicons5';
import { useConfigStore, type AliasRow } from '../../configStore';
import { getAliasStatus, type AliasStatus } from '../../api';
import ItemCard from '../ItemCard.vue';

const store = useConfigStore();

// 分组下拉选项：每个提供商是 type:'group' 分组标题，children 为该提供商的模型；
// 模型 value 用 "provider:model" 与 targets 格式一致，选中直接得到该字符串；
// 额外挂 provider/model 字段供 render-tag 拼出 "提供商 / 模型"
interface ModelOption extends SelectOption {
  provider?: string;
  model?: string;
}
const baseModelOptions = computed<(SelectOption | SelectGroupOption)[]>(() => {
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

// 带禁用标记的副本：已选过（且不是当前这一行）的目标禁用，避免同一别名重复选同一模型
function optionsFor(a: AliasRow, selfIdx: number): (SelectOption | SelectGroupOption)[] {
  const taken = new Set(a.targets.filter((t, idx) => idx !== selfIdx && t));
  return (baseModelOptions.value as SelectGroupOption[]).map((g) => ({
    ...g,
    children: (g.children as ModelOption[]).map((c) => ({
      ...c,
      disabled: taken.has(c.value as string),
    })),
  }));
}

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

// 每个别名「当前实际生效」模型（来自 access.log 最近一次成功请求）
const statusMap = ref<Record<string, AliasStatus>>({});
async function loadAliasStatus(): Promise<void> {
  try {
    const res = await getAliasStatus();
    const m: Record<string, AliasStatus> = {};
    for (const s of res.aliases) m[s.name] = s;
    statusMap.value = m;
  } catch {
    statusMap.value = {};
  }
}
onMounted(loadAliasStatus);

// 每个别名：主选（targets[0]）= 标「主选」；其余 = failover 备选
function statusOf(a: AliasRow): AliasStatus | undefined {
  return a.name ? statusMap.value[a.name] : undefined;
}
function isPrimaryHit(a: AliasRow): boolean {
  const st = statusOf(a);
  return !!st && !!a.targets[0] && st.activeModel === a.targets[0];
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
  // 别名名可能变化，刷新实际生效状态
  loadAliasStatus();
}
</script>

<template>
  <n-card size="small" class="soft-card alias-card">
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
          <ItemCard
            :error="store.erroredAliases.has(a.name)"
            remove-tooltip="删除该别名"
            @remove="removeAlias(i)"
          >
            <n-form-item label="别名" style="margin-bottom: 0">
              <n-input v-model:value="a.name" placeholder="如 fast" style="width: 160px" />
            </n-form-item>
            <n-form-item style="margin-bottom: 0">
              <template #label>
                <span style="display: inline-flex; align-items: center; gap: 8px">
                  目标模型
                  <n-tag size="tiny" :bordered="false" type="default">顺序即 failover 优先级</n-tag>
                </span>
              </template>
              <n-dynamic-input
                v-model:value="a.targets"
                :on-create="() => null"
                :show-sort-button="true"
                placeholder="选择提供商下的模型"
                style="width: 100%"
              >
                <template #default="{ index }">
                  <div style="flex: 1 1 0; min-width: 0">
                    <n-select
                      v-model:value="a.targets[index]"
                      :options="optionsFor(a, index)"
                      placeholder="选择提供商下的模型"
                      class="alias-target-select"
                      style="width: 100%"
                    />
                  </div>
                </template>
                <template #create-button-default>
                  添加目标
                </template>
              </n-dynamic-input>
            </n-form-item>
            <n-form-item style="margin-bottom: 0">
              <template #label>
                <span style="display: inline-flex; align-items: center; gap: 8px">
                  当前实际生效
                  <n-tag size="tiny" :bordered="false" type="default">来自最近一次成功请求</n-tag>
                </span>
              </template>
              <div v-if="statusOf(a)" style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
                <span
                  class="status-dot"
                  :style="{ background: isPrimaryHit(a) ? '#18a058' : '#f0a020' }"
                ></span>
                <code style="font-size: 13px">{{ statusOf(a)!.activeModel }}</code>
                <n-tag
                  size="tiny"
                  :bordered="false"
                  :type="isPrimaryHit(a) ? 'success' : 'warning'"
                >
                  {{ isPrimaryHit(a) ? '主选命中' : '已 failover 到备选' }}
                </n-tag>
                <span style="color: #999; font-size: 12px">
                  {{ statusOf(a)!.lastSuccessTs ? statusOf(a)!.lastSuccessTs.replace('T', ' ').slice(0, 19) : '' }}
                </span>
              </div>
              <span v-else style="color: #999; font-size: 13px">暂无成功请求记录</span>
            </n-form-item>
          </ItemCard>
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
/* 别名卡片在移动端不被内部 n-select 长文本撑宽 */
.alias-card {
  min-width: 0;
  max-width: 100%;
}

/* n-select 内部选中的长模型名截断省略，避免撑破布局 */
.alias-target-select .n-base-selection-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 实际生效状态点 */
.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 auto;
}
</style>
