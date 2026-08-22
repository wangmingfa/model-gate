<script setup lang="ts">
import { NCard, NButton, NSpace, NCollapse, NCollapseItem, NForm, NFormItem, NInput, NDynamicInput, NIcon } from 'naive-ui';
import { GitBranchOutline } from '@vicons/ionicons5';
import { useConfigStore } from '../../configStore';

const store = useConfigStore();
</script>

<template>
  <n-card size="small" class="soft-card">
    <template #header>
      <span class="card-title"><n-icon :size="16"><GitBranchOutline /></n-icon> 模型别名（aliases，agent 只认别名）</span>
    </template>
    <n-space vertical>
      <n-collapse v-model:expanded-names="store.expandedAliasNames">
        <n-collapse-item v-for="(a, i) in store.aliases" :key="a._id" :name="a._id" arrow-placement="left">
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
              <n-button size="small" type="error" quaternary @click="store.removeAlias(i)">删除</n-button>
            </div>
            <n-form-item label="别名" style="margin-bottom: 0">
              <n-input v-model:value="a.name" placeholder="如 fast" style="width: 160px" @blur="store.autoSave()" />
            </n-form-item>
            <n-form-item label="目标（有序，failover 顺序，每行一个 provider:model）" style="margin-bottom: 0">
              <n-dynamic-input
                v-model:value="a.targets"
                placeholder="如 deepseek:deepseek-chat"
                style="width: 100%"
                @update:value="store.scheduleAutoSave()"
              />
            </n-form-item>
          </div>
        </n-collapse-item>
      </n-collapse>
      <n-button size="small" @click="store.addAlias">+ 添加别名</n-button>
    </n-space>
  </n-card>
</template>
