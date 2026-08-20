<script setup lang="ts">
import { NConfigProvider, NMessageProvider, type GlobalThemeOverrides } from 'naive-ui';
import App from './App.vue';

// 品牌主题：靛紫渐变系，圆角更柔和
const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#6366f1',
    primaryColorHover: '#818cf8',
    primaryColorPressed: '#4f46e5',
    primaryColorSuppl: '#6366f1',
    borderRadius: '8px',
    borderRadiusSmall: '6px',
  },
  Card: {
    borderRadius: '12px',
  },
  Button: {
    borderRadiusMedium: '8px',
  },
};
</script>

<template>
  <div class="app-bg">
    <n-config-provider :theme-overrides="themeOverrides">
      <n-message-provider>
        <App />
      </n-message-provider>
    </n-config-provider>
  </div>
</template>

<style>
/* 页面背景：柔和的靛紫渐变 + 微弱网格纹理点缀 */
html,
body {
  margin: 0;
  min-height: 100%;
  background: linear-gradient(160deg, #eef2ff 0%, #f5f3ff 45%, #fdf4ff 100%);
}
.app-bg {
  min-height: 100vh;
}
</style>
