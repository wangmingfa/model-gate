<script setup lang="ts">
import { NCard, NAlert, NForm, NFormItem, NInput, NButton, NIcon } from 'naive-ui';
import { AlertCircleOutline, LockClosedOutline } from '@vicons/ionicons5';
import { useAuth } from '../useAuth';

const auth = useAuth();
</script>

<template>
  <!-- 未配密码：提示去配置文件配置 admin_password -->
  <n-card v-if="auth.state === 'need-password'" title="需要配置密码" style="max-width: 480px; margin: 80px auto" class="auth-card">
    <div class="auth-icon warn"><n-icon :size="30"><AlertCircleOutline /></n-icon></div>
    <n-alert type="warning" style="margin-bottom: 16px">
      尚未配置管理密码。非本机访问管理界面需要密码保护，请先在配置文件
      <code style="background: #f5f5f5; padding: 0 4px; border-radius: 3px">{{ auth.configPath }}</code>
      中设置 <code style="background: #f5f5f5; padding: 0 4px; border-radius: 3px">admin_password</code> 字段
      （支持 <code>${ENV_VAR}</code> 环境变量引用），保存后热加载生效，再刷新本页登录。
    </n-alert>
    <n-button type="primary" block @click="auth.checkAuth">刷新</n-button>
  </n-card>

  <!-- 配了密码但未登录：登录表单 -->
  <n-card v-else-if="auth.state === 'need-login'" title="登录" style="max-width: 480px; margin: 80px auto" class="auth-card">
    <div class="auth-icon"><n-icon :size="30"><LockClosedOutline /></n-icon></div>
    <n-form @submit.prevent="auth.submit">
      <n-form-item label="管理密码">
        <n-input
          v-model:value="auth.password"
          type="password"
          show-password-on="click"
          placeholder="请输入 admin_password"
          @keyup.enter="auth.submit"
        />
      </n-form-item>
      <n-alert v-if="auth.error" type="error" style="margin-bottom: 12px">{{ auth.error }}</n-alert>
      <n-button type="primary" block :loading="auth.busy" @click="auth.submit">登录</n-button>
    </n-form>
  </n-card>
</template>

<style>
/* 登录/提示卡片：顶部居中图标 */
.auth-card {
  border-radius: 14px;
  box-shadow: 0 12px 32px rgba(99, 102, 241, 0.15);
}
.auth-icon {
  width: 64px;
  height: 64px;
  margin: 0 auto 16px;
  border-radius: 50%;
  background: linear-gradient(135deg, #e0e7ff, #fae8ff);
  color: #6366f1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.auth-icon.warn {
  background: linear-gradient(135deg, #fef3c7, #fce7f3);
  color: #d97706;
}
</style>
