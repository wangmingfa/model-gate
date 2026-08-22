<script setup lang="ts">
import { NCard, NButton, NSpace, NCollapse, NCollapseItem, NForm, NFormItem, NInput, NDynamicInput, NTag, NIcon } from 'naive-ui';
import { ServerOutline } from '@vicons/ionicons5';
import { useConfigStore } from '../../configStore';

const store = useConfigStore();
</script>

<template>
  <n-card size="small" class="soft-card">
    <template #header>
      <span class="card-title"><n-icon :size="16"><ServerOutline /></n-icon> 上游运营商（providers）</span>
    </template>
    <n-space vertical>
      <n-collapse v-model:expanded-names="store.expandedProviderNames">
        <n-collapse-item v-for="(p, i) in store.providers" :key="p._id" :name="p._id" arrow-placement="left">
          <template #header>
            <span style="font-weight: 600">
              provider #{{ i + 1 }}
              <span v-if="p.name" style="font-weight: 400; color: #666">（{{ p.name }}）</span>
            </span>
          </template>
          <div
            :class="{ 'field-error': store.erroredProviders.has(p.name) }"
            style="
              border: 1px solid #eee;
              border-radius: 8px;
              padding: 12px;
              margin-bottom: 8px;
              display: flex;
              flex-direction: column;
              gap: 8px;
            "
          >
            <div style="display: flex; justify-content: flex-end; align-items: center">
              <n-button size="small" type="error" quaternary @click="store.removeProvider(i)">删除</n-button>
            </div>
            <div style="display: flex; align-items: baseline; gap: 12px" class="provider-name-row">
              <div style="width: 160px; flex-shrink: 0">
                <n-form-item label="名称" style="margin-bottom: 0">
                  <n-input v-model:value="p.name" placeholder="如 deepseek" @blur="store.autoSave()" />
                </n-form-item>
              </div>
              <div style="flex: 1; min-width: 0" class="provider-base-url">
                <n-form-item label="base_url" style="margin-bottom: 0">
                  <n-input v-model:value="p.base_url" placeholder="https://api.deepseek.com/v1" style="width: 100%" @blur="store.autoSave()" />
                </n-form-item>
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: 12px">
              <div style="flex: 1; min-width: 0">
                <n-form-item label="api_key（留空保持原值）" style="margin-bottom: 0">
                  <n-input
                    v-model:value="p.api_key"
                    type="password"
                    show-password-on="click"
                    placeholder="留空保持原值"
                    style="width: 100%"
                    @blur="store.autoSave()"
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
            <n-form-item label="模型列表">
              <n-dynamic-input v-model:value="p.models" placeholder="模型 id，如 deepseek-chat" style="width: 100%" @update:value="store.scheduleAutoSave()" />
            </n-form-item>
          </div>
        </n-collapse-item>
      </n-collapse>
      <n-button size="small" @click="store.addProvider">+ 添加 provider</n-button>
    </n-space>
  </n-card>
</template>

<style>
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
