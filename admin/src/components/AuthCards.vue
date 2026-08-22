<script setup lang="ts">
import { NCard, NAlert, NForm, NFormItem, NInput, NButton, NIcon } from 'naive-ui';
import { AlertCircleOutline, LockClosedOutline } from '@vicons/ionicons5';
import { useAuth } from '../useAuth';

const auth = useAuth();
</script>

<template>
  <!-- 外层：全屏渐变背景 + 居中布局 -->
  <div class="auth-screen">
    <div class="auth-panel">
      <!-- 品牌区：logo + 标题 + 副标题 -->
      <div class="auth-brand">
        <div class="auth-logo">
          <svg viewBox="0 0 256 256" width="40" height="40" xmlns="http://www.w3.org/2000/svg" aria-label="model-gate logo">
            <defs>
              <linearGradient id="mg-g" x1="32" y1="32" x2="224" y2="224" gradientUnits="userSpaceOnUse">
                <stop offset="0" stop-color="#6366F1"/><stop offset="0.55" stop-color="#8B5CF6"/><stop offset="1" stop-color="#D946EF"/>
              </linearGradient>
              <linearGradient id="mg-g2" x1="64" y1="64" x2="192" y2="192" gradientUnits="userSpaceOnUse">
                <stop offset="0" stop-color="#A5B4FC"/><stop offset="1" stop-color="#E879F9"/>
              </linearGradient>
            </defs>
            <rect x="16" y="16" width="224" height="224" rx="56" fill="url(#mg-g)"/>
            <g stroke="#ffffff" stroke-width="14" stroke-linecap="round" fill="none" opacity="0.95">
              <path d="M78 184 L78 96 Q78 70 104 70 L152 70 Q178 70 178 96 L178 184"/>
            </g>
            <g fill="#ffffff">
              <path d="M70 104 L120 118" stroke="#ffffff" stroke-width="9" stroke-linecap="round" opacity="0.9"/>
              <path d="M186 104 L136 118" stroke="#ffffff" stroke-width="9" stroke-linecap="round" opacity="0.9"/>
              <path d="M128 92 L156 124 L128 156 L100 124 Z" fill="url(#mg-g2)"/>
              <circle cx="128" cy="124" r="9" fill="#ffffff"/>
            </g>
            <path d="M128 156 L128 192" stroke="#ffffff" stroke-width="11" stroke-linecap="round" opacity="0.9"/>
          </svg>
        </div>
        <h1 class="auth-title">model-gate</h1>
        <p class="auth-subtitle">OpenAI 兼容 API 网关 · 管理面板</p>
      </div>

      <!-- 未配密码：提示去配置文件配置 admin_password -->
      <n-card v-if="auth.state === 'need-password'" class="auth-card" :bordered="false">
        <div class="auth-icon warn"><n-icon :size="28"><AlertCircleOutline /></n-icon></div>
        <n-alert type="warning" class="auth-alert">
          尚未配置管理密码。非本机访问管理界面需要密码保护，请先在配置文件
          <code class="inline-code">{{ auth.configPath }}</code>
          中设置 <code class="inline-code">admin_password</code> 字段
          （支持 <code class="inline-code">${ENV_VAR}</code> 环境变量引用），保存后热加载生效，再刷新本页登录。
        </n-alert>
        <n-button type="primary" block class="auth-btn" @click="auth.checkAuth">刷新</n-button>
      </n-card>

      <!-- 配了密码但未登录：登录表单 -->
      <n-card v-else-if="auth.state === 'need-login'" class="auth-card" :bordered="false">
        <div class="auth-icon"><n-icon :size="28"><LockClosedOutline /></n-icon></div>
        <h2 class="auth-card-title">登录管理面板</h2>
        <p class="auth-card-desc">请输入配置文件中设置的 admin_password</p>
        <n-form @submit.prevent="auth.submit">
          <n-form-item label="管理密码" :show-label="false">
            <n-input
              v-model:value="auth.password"
              type="password"
              size="large"
              placeholder="请输入 admin_password"
              class="auth-input"
              @keyup.enter="auth.submit"
            />
          </n-form-item>
          <n-alert v-if="auth.error" type="error" class="auth-alert">{{ auth.error }}</n-alert>
          <n-button type="primary" block size="large" class="auth-btn" :loading="auth.busy" @click="auth.submit">登录</n-button>
        </n-form>
      </n-card>
    </div>
  </div>
</template>

<style>
/* 全屏渐变背景 + 居中。
   用 min-height:100dvh（而非 fixed）跟随动态视口，避免 fixed 在移动端
   软键盘/地址栏伸缩时的整体抖动。关键：本层 padding:0，且登录态时父级
   .page-wrap 的 padding 也被清零（见 App.vue .page-wrap--auth），否则
   父级 24px*2 + 本层 padding 会让 100dvh 超出屏幕产生滚动条。
   内容超高时本层内部滚动（overflow:auto）。 */
.auth-screen {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  box-sizing: border-box;
  overflow: auto;
  background: linear-gradient(135deg, #eef2ff 0%, #faf0ff 45%, #fdf2f8 100%);
}
/* 居中面板：限制宽度，内容纵向排列 */
.auth-panel {
  width: 100%;
  max-width: 420px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
/* 品牌区 */
.auth-brand {
  text-align: center;
  margin-bottom: 22px;
}
.auth-logo {
  width: 72px;
  height: 72px;
  margin: 0 auto 14px;
  border-radius: 18px;
  background: #ffffff;
  box-shadow: 0 10px 28px rgba(99, 102, 241, 0.28);
  display: flex;
  align-items: center;
  justify-content: center;
}
.auth-title {
  margin: 0;
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 0.5px;
  background: linear-gradient(120deg, #6366f1, #8b5cf6, #d946ef);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
.auth-subtitle {
  margin: 6px 0 0;
  font-size: 13px;
  color: #6b7280;
}

/* 卡片：玻璃拟态 + 圆角阴影 */
.auth-card {
  width: 100%;
  border-radius: 18px;
  box-shadow: 0 18px 48px rgba(99, 102, 241, 0.18);
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(8px);
  padding: 6px 4px;
}
/* 卡片内顶部图标 */
.auth-icon {
  width: 56px;
  height: 56px;
  margin: 6px auto 14px;
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
.auth-card-title {
  margin: 0 0 4px;
  text-align: center;
  font-size: 18px;
  font-weight: 600;
  color: #1f2937;
}
.auth-card-desc {
  margin: 0 0 18px;
  text-align: center;
  font-size: 13px;
  color: #6b7280;
}
/* 按钮：与品牌渐变一致 */
.auth-btn {
  margin-top: 6px;
  background: linear-gradient(120deg, #6366f1, #8b5cf6);
  border: none;
  box-shadow: 0 8px 20px rgba(99, 102, 241, 0.35);
}
.auth-btn:hover {
  background: linear-gradient(120deg, #5457e5, #7c4ddb);
  box-shadow: 0 10px 24px rgba(99, 102, 241, 0.45);
}
.auth-input {
  border-radius: 10px;
}
.auth-alert {
  margin-bottom: 14px;
}
/* 行内代码 */
.inline-code {
  background: #f3f4f6;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 12px;
  color: #4338ca;
}

/* 移动端：收紧边距 */
@media (max-width: 600px) {
  .auth-screen {
    padding: 16px;
  }
  .auth-title {
    font-size: 23px;
  }
  .auth-card {
    border-radius: 16px;
  }
}
</style>
