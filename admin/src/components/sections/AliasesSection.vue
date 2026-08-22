<script setup lang="ts">
import { ref, watch } from 'vue';
import { NCard, NButton, NSpace, NCollapse, NCollapseItem, NForm, NFormItem, NInput, NDynamicInput, NIcon } from 'naive-ui';
import { GitBranchOutline, SaveOutline } from '@vicons/ionicons5';
import { useConfigStore, type AliasRow } from '../../configStore';

const store = useConfigStore();

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
  store.aliases = JSON.parse(JSON.stringify(draft.value));
  await store.saveSection({ successMsg: '模型别名已保存' });
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
            :class="{ 'field-error': store.erroredAliases.has(a.name) }"
            style="border: 1px solid #eee; border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px"
          >
            <div style="display: flex; justify-content: flex-end; align-items: center">
              <n-button size="small" type="error" quaternary @click="removeAlias(i)">删除</n-button>
            </div>
            <n-form-item label="别名" style="margin-bottom: 0">
              <n-input v-model:value="a.name" placeholder="如 fast" style="width: 160px" />
            </n-form-item>
            <n-form-item label="目标（有序，failover 顺序，每行一个 provider:model）" style="margin-bottom: 0">
              <n-dynamic-input
                v-model:value="a.targets"
                placeholder="如 deepseek:deepseek-chat"
                style="width: 100%"
              />
            </n-form-item>
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
