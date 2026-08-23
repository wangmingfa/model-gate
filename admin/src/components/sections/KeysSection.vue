<script setup lang="ts">
import { NCard, NButton, NSpace, NInput, NTag, NModal, NIcon } from 'naive-ui';
import { KeyOutline, SaveOutline } from '@vicons/ionicons5';
import { useConfigStore } from '../../configStore';
import { maskKey, formatTime } from '../../utils';

const store = useConfigStore();
</script>

<template>
  <n-card size="small" class="soft-card">
    <template #header>
      <span class="card-title"><n-icon :size="16"><KeyOutline /></n-icon> 下游密钥（keys，agent 连入网关用）</span>
    </template>
    <!-- 添加：填名称，密钥自动生成 -->
    <n-space style="margin-bottom: 12px" class="key-add-row">
      <n-input v-model:value="store.newKeyName" placeholder="密钥名称，如 Claude / Cursor" style="width: 260px" @keyup.enter="store.addKey" />
      <n-button type="primary" @click="store.addKey">
        <template #icon><n-icon><SaveOutline /></n-icon></template>
        添加密钥
      </n-button>
    </n-space>
    <!-- 已有密钥：只读（名称/掩码/添加时间），只能删除；完整密钥仅在生成时弹窗展示一次 -->
    <n-space vertical>
      <div v-for="(k, i) in store.keys" :key="k.name" class="key-row">
        <div class="key-top">
          <n-tag type="primary" size="small" style="width: 110px; justify-content: center" class="key-name">{{ k.name }}</n-tag>
          <code style="color: #666; font-size: 12px; word-break: break-all" class="key-value">{{ maskKey(k.key) }}</code>
        </div>
        <div class="key-bottom">
          <span style="color: #999; font-size: 12px; white-space: nowrap">{{ formatTime(k.created_at) }}</span>
          <n-button size="tiny" @click="store.copyKey(k.key)">复制</n-button>
          <n-button size="tiny" type="error" quaternary @click="store.removeKey(i)">删除</n-button>
        </div>
      </div>
      <div v-if="store.keys.length === 0" style="color: #999; font-size: 12px">还没有密钥，填名称添加一个（密钥自动生成）</div>
    </n-space>
  </n-card>

  <!-- 新密钥弹窗：完整密钥只在此时展示一次，供复制 -->
  <n-modal
    v-model:show="store.showNewKeyModal"
    preset="card"
    :style="{ width: '520px', borderRadius: '14px' }"
    :mask-closable="false"
    :close-on-esc="false"
    :title="`密钥「${store.pendingKeyName}」已生成`"
  >
    <p style="margin: 0 0 12px; color: #666; font-size: 13px">
      请立即复制并妥善保存。此完整密钥仅在本次展示，关闭后页面只显示掩码，无法再查看。
    </p>
    <div
      style="
        background: #f5f5f5;
        border: 1px dashed #c4b5fd;
        border-radius: 8px;
        padding: 12px;
        font-size: 13px;
        word-break: break-all;
        user-select: all;
        margin-bottom: 16px;
      "
    >
      <code style="color: #4f46e5">{{ store.pendingKeyValue }}</code>
    </div>
    <n-space justify="end">
      <n-button @click="store.showNewKeyModal = false">关闭</n-button>
      <n-button type="primary" @click="store.copyPendingKey">
        <template #icon><n-icon><SaveOutline /></n-icon></template>
        复制密钥
      </n-button>
    </n-space>
  </n-modal>
</template>

<style>
/* ---- 密钥列表行：默认一行（名称+掩码 与 时间+操作 并排），移动端才折成两行 ---- */
.key-add-row {
  flex-wrap: wrap;
}
.key-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 12px;
  border: 1px solid #eee;
  border-radius: 8px;
  padding: 8px 12px;
}
.key-top {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1 1 auto;
  min-width: 0;
}
.key-bottom {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
}

/* ---- 移动端适配：窄屏下折成两行（名称+掩码 第一行，时间+操作 第二行）---- */
@media (max-width: 760px) {
  .key-row {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
  }
  .key-top {
    flex-wrap: wrap;
    gap: 8px;
  }
  .key-bottom {
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 8px;
  }
  .key-add-row {
    flex-direction: column;
    align-items: stretch;
  }
  .key-add-row > * {
    width: 100%;
  }
  .key-name {
    width: auto !important;
    min-width: 0;
  }
  .key-value {
    word-break: break-all;
  }
}
</style>
