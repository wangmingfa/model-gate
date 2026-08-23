<script setup lang="ts">
import { ref, watch } from 'vue';
import { NCard, NButton, NSpace, NCollapse, NCollapseItem, NForm, NFormItem, NInput, NDynamicInput, NTag, NIcon, NTooltip } from 'naive-ui';
import { ServerOutline, SaveOutline } from '@vicons/ionicons5';
import { useConfigStore, type ProviderRow } from '../../configStore';

const store = useConfigStore();

// 本地草稿：深拷贝，编辑不实时落盘；点「保存」才写回 store 并落盘
const draft = ref<ProviderRow[]>(JSON.parse(JSON.stringify(store.providers)));
// 折叠状态用本地驱动（默认全展开）
const expandedNames = ref<string[]>(draft.value.map((p) => p._id));

// 行级 ID 生成器（与 store 同款，仅前端追踪用）
let rowSeq = 0;
function nextRowId(): string {
  return `row-${++rowSeq}`;
}

function addProvider(): void {
  const id = nextRowId();
  draft.value.push({ _id: id, name: '', base_url: '', api_key: '', models: [] });
  expandedNames.value.push(id); // 新行默认展开
}

// store.providers 由 load() 异步填充；首次有数据时把草稿同步过来（用户尚未编辑则覆盖，
// 已编辑则不覆盖，避免丢失进行中的改动）。解决「setup 时 store 还是空数组」的竞态。
watch(
  () => store.providers,
  (val) => {
    if (val.length && draft.value.length === 0) {
      draft.value = JSON.parse(JSON.stringify(val));
      expandedNames.value = draft.value.map((p) => p._id);
    }
  },
  { deep: false },
);
function removeProvider(index: number): void {
  const name = draft.value[index].name || `#${index + 1}`;
  store.removeProviderConfirm(name, async () => {
    draft.value.splice(index, 1);
    await onSave();
  });
}

async function onSave(): Promise<void> {
  // 写回 store（深拷贝，避免草稿与 store 共享引用）
  store.providers = JSON.parse(JSON.stringify(draft.value));
  await store.saveSection({ successMsg: '提供商已保存' });
  // 同步草稿：失败也不丢内容——saveSection 不再 load 回滚，store.providers 仍是刚写入的草稿拷贝
  draft.value = JSON.parse(JSON.stringify(store.providers));
}
</script>

<template>
  <n-card size="small" class="soft-card">
    <template #header>
      <span class="card-title"><n-icon :size="16"><ServerOutline /></n-icon> 提供商（providers）</span>
    </template>
    <n-space vertical>
      <n-collapse v-model:expanded-names="expandedNames">
        <n-collapse-item v-for="(p, i) in draft" :key="p._id" :name="p._id" arrow-placement="left">
          <template #header>
            <span style="font-weight: 600">
              provider #{{ i + 1 }}
              <span v-if="p.name" style="font-weight: 400; color: #666">（{{ p.name }}）</span>
            </span>
          </template>
          <div
            :class="{ 'provider-item': true, 'field-error': store.erroredProviders.has(p.name) }"
            style="
              position: relative;
              border: 1px solid #eee;
              border-radius: 8px;
              padding: 12px 40px 12px 12px;
              margin-bottom: 8px;
              display: flex;
              flex-direction: column;
              gap: 8px;
            "
          >
            <n-tooltip trigger="hover">
              <template #trigger>
                <n-button
                  size="tiny"
                  type="error"
                  quaternary
                  circle
                  class="float-del-btn"
                  @click="removeProvider(i)"
                >
                  ✕
                </n-button>
              </template>
              删除该提供商
            </n-tooltip>
            <div style="display: flex; align-items: baseline; gap: 12px" class="provider-name-row">
              <div style="width: 160px; flex-shrink: 0">
                <n-form-item label="名称" style="margin-bottom: 0">
                  <n-input v-model:value="p.name" placeholder="如 deepseek" />
                </n-form-item>
              </div>
              <div style="flex: 1; min-width: 0" class="provider-base-url">
                <n-form-item label="base_url" style="margin-bottom: 0">
                  <n-input v-model:value="p.base_url" placeholder="https://api.deepseek.com/v1" style="width: 100%" />
                </n-form-item>
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: 12px">
              <div style="flex: 1; min-width: 0">
                <n-form-item label="api_key（留空保持原值，填新值覆盖）" style="margin-bottom: 0">
                  <n-input
                    v-model:value="p.api_key"
                    type="password"
                    show-password-on="click"
                    placeholder="留空保持原值，填新值覆盖"
                    style="width: 100%"
                  />
                </n-form-item>
              </div>
              <div style="flex-shrink: 0">
                <n-button
                  size="small"
                  :loading="store.testStates[p.name]?.testing"
                  :type="store.testStates[p.name]?.ok ? 'success' : 'default'"
                  @click="store.onTest(p)"
                >
                  测试连接
                </n-button>
              </div>
            </div>
            <div v-if="store.testStates[p.name]?.result" style="font-size: 12px">
              <n-tag :type="store.testStates[p.name]?.ok ? 'success' : 'error'" size="small">
                {{ store.testStates[p.name]?.result }}
              </n-tag>
            </div>
            <n-form-item style="margin-bottom: 0">
              <template #label>
                <span style="display: inline-flex; align-items: center; gap: 8px">
                  模型列表
                  <n-button
                    size="tiny"
                    type="primary"
                    secondary
                    :loading="store.fetchStates[p.name]?.fetching"
                    @click="store.onFetchModels(p)"
                  >
                    拉取模型
                  </n-button>
                </span>
              </template>
              <n-dynamic-input v-model:value="p.models" placeholder="模型 id，如 deepseek-chat" style="width: 100%">
                <template #create-button-default>
                  添加模型
                </template>
              </n-dynamic-input>
            </n-form-item>
            <div v-if="store.fetchStates[p.name]?.result" style="font-size: 12px">
              <n-tag :type="store.fetchStates[p.name]?.ok ? 'success' : 'error'" size="small">
                {{ store.fetchStates[p.name]?.result }}
              </n-tag>
            </div>
          </div>
        </n-collapse-item>
      </n-collapse>
      <n-space justify="space-between">
        <n-button size="small" @click="addProvider">+ 添加 provider</n-button>
        <n-button type="primary" :loading="store.saving" @click="onSave">
          <template #icon><n-icon><SaveOutline /></n-icon></template>
          保存
        </n-button>
      </n-space>
    </n-space>
  </n-card>
</template>

<style>
/* 删除按钮浮动在提供商卡片右上角，不占用布局空间 */
.provider-item .float-del-btn {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 1;
}
@media (max-width: 600px) {
  /* provider 编辑区：移动端名称和 base_url 竖排，base_url 独占一行 */
  .provider-name-row {
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
  }
  .provider-name-row > div {
    width: 100% !important;
  }
}
</style>
