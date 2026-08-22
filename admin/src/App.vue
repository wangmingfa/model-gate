<script setup lang="ts">
import { ref, onMounted, computed, h, markRaw, provide } from 'vue';
import { NIcon, NDropdown, NAlert, NButton } from 'naive-ui';
import {
  RocketOutline,
  LogOutOutline,
  SettingsOutline,
  ServerOutline,
  KeyOutline,
  GitBranchOutline,
  LinkOutline,
  PersonCircleOutline,
  CheckmarkCircleOutline,
} from '@vicons/ionicons5';
import { createAuth, authKey } from './useAuth';
import { provideConfigStore, sectionOfTarget } from './configStore';
import AuthCards from './components/AuthCards.vue';
import SectionNav from './components/SectionNav.vue';
import type { SectionItem } from './components/SectionNav.vue';
import CheckResultBox from './components/CheckResultBox.vue';
import AccessSection from './components/sections/AccessSection.vue';
import BasicSection from './components/sections/BasicSection.vue';
import KeysSection from './components/sections/KeysSection.vue';
import ProvidersSection from './components/sections/ProvidersSection.vue';
import AliasesSection from './components/sections/AliasesSection.vue';

// 共享编辑态：创建一次，provide 给各版块子组件（message/dialog 在此绑定）
const store = provideConfigStore();

// 登录态：登录成功后拉取配置进入编辑态
const auth = createAuth(store.load);
provide(authKey, auth);
onMounted(auth.checkAuth);

// 右上角用户菜单（登出收敛到菜单里）
const userMenuOptions = [
  {
    label: '登出',
    key: 'logout',
    icon: () => h(NIcon, null, { default: () => h(LogOutOutline) }),
  },
];
function onUserMenuSelect(key: string): void {
  if (key === 'logout') void auth.signOut();
}

/** ---- 分版块导航：左侧切换，一次只看一个版块，缩短页面 ---- */
const activeSection = ref('access');
const sections = computed<SectionItem[]>(() => [
  { key: 'access', label: '接入信息', icon: markRaw(LinkOutline) },
  { key: 'basic', label: '基本设置', icon: markRaw(SettingsOutline) },
  { key: 'keys', label: '下游密钥', icon: markRaw(KeyOutline), count: store.keys.length },
  { key: 'providers', label: '上游运营商', icon: markRaw(ServerOutline), count: store.providers.length },
  { key: 'aliases', label: '模型别名', icon: markRaw(GitBranchOutline), count: store.aliases.length },
]);

/** 检查配置正确性：体检在 store 里做（标红/报告），这里负责跳到第一个出错项所在版块 */
async function onCheckConfig(): Promise<void> {
  const errors = await store.runCheck();
  if (errors.length > 0) {
    const section = sectionOfTarget(errors[0]?.target);
    if (section) activeSection.value = section;
  }
}
</script>

<template>
  <div class="page-wrap">
    <!-- 未配密码 / 未登录：登录与引导卡片 -->
    <AuthCards v-if="auth.state === 'need-password' || auth.state === 'need-login'" />

    <!-- 已登录：配置编辑界面 -->
    <template v-else-if="auth.state === 'ok'">
      <div class="editor-content">
      <div class="hero-header">
        <div class="hero-left">
          <div class="hero-logo"><n-icon :size="26"><RocketOutline /></n-icon></div>
          <div>
            <h2 style="margin: 0">model-gate 配置</h2>
            <p style="margin: 2px 0 0; font-size: 12px; opacity: 0.85">
              config.json 是唯一真相源 · 改动即时保存 + 热加载生效
            </p>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 10px">
          <n-button
            size="small"
            :loading="store.checking"
            class="check-config-btn"
            @click="onCheckConfig"
          >
            <template #icon><n-icon><CheckmarkCircleOutline /></n-icon></template>
            检查配置正确性
          </n-button>
          <n-dropdown trigger="click" placement="bottom-end" :options="userMenuOptions" @select="onUserMenuSelect">
            <n-button quaternary circle size="small" aria-label="用户菜单">
              <n-icon color="#ffffff" :size="22"><PersonCircleOutline /></n-icon>
            </n-button>
          </n-dropdown>
        </div>
      </div>

      <n-alert v-if="store.loadError" type="error" :title="'加载配置失败'" style="margin-bottom: 16px">
        {{ store.loadError }}
      </n-alert>

      <!-- 配置体检结果：检查后展示，错误项会在对应字段标红 -->
      <CheckResultBox :issues="store.checkIssues" />

      <template v-if="!store.loadError">
        <!-- 分版块：左侧导航切换，一次只看一个版块，缩短页面长度 -->
        <div class="section-layout">
          <SectionNav v-model:active="activeSection" :sections="sections" />
          <div class="section-body">
            <!-- v-show 而非 v-if：切换不销毁 DOM，编辑状态/滚动位置/自动保存不受影响 -->
            <div v-show="activeSection === 'access'"><AccessSection /></div>
            <div v-show="activeSection === 'basic'"><BasicSection /></div>
            <div v-show="activeSection === 'keys'"><KeysSection /></div>
            <div v-show="activeSection === 'providers'"><ProvidersSection /></div>
            <div v-show="activeSection === 'aliases'"><AliasesSection /></div>
          </div><!-- /section-body -->
        </div><!-- /section-layout -->
      </template>

      </div>
    </template>
  </div>
</template>

<style>
/* 顶部渐变 header */
.hero-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  background: linear-gradient(120deg, #6366f1, #8b5cf6, #d946ef);
  color: #fff;
  border-radius: 14px;
  padding: 18px 22px;
  margin-bottom: 20px;
  box-shadow: 0 8px 24px rgba(99, 102, 241, 0.35);
}
.hero-left {
  display: flex;
  align-items: center;
  gap: 12px;
}
.hero-logo {
  width: 46px;
  height: 46px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.18);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

/* 卡片标题带图标 */
.card-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/* 编辑区容器：底部留白 */
.editor-content {
  padding-bottom: 24px;
}

/* 页面外层容器：分版块后左侧导航占宽，整体放宽到 980px；移动端收窄（见媒体查询） */
.page-wrap {
  max-width: 980px;
  margin: 0 auto;
  padding: 24px;
}

/* 分版块布局：左侧导航 + 右侧内容 */
.section-layout {
  display: flex;
  gap: 20px;
  align-items: flex-start;
}
.section-body {
  flex: 1;
  min-width: 0;
}

/* 体检出错的字段：红色边框 + 柔和红光，直观定位问题处（供各版块共用） */
.field-error {
  border-color: #e5484d !important;
  box-shadow: 0 0 0 3px rgba(229, 72, 77, 0.18) !important;
}

/* hero 里的检查按钮：白底半透明，适配渐变背景 */
.check-config-btn {
  color: #fff;
  background: rgba(255, 255, 255, 0.16);
  border: 1px solid rgba(255, 255, 255, 0.35);
}
.check-config-btn:hover {
  color: #fff;
  background: rgba(255, 255, 255, 0.28);
}

/* 卡片美化：圆角 + 柔和阴影 + hover 微浮起（供各版块共用） */
.soft-card {
  border-radius: 14px;
  box-shadow: 0 4px 16px rgba(99, 102, 241, 0.08);
  transition: box-shadow 0.2s ease, transform 0.2s ease;
}
.soft-card:hover {
  box-shadow: 0 8px 24px rgba(99, 102, 241, 0.16);
  transform: translateY(-2px);
}

/* ---- 移动端适配 ---- */
@media (max-width: 600px) {
  /* 充分利用空间：收窄页面边距与卡片间距 */
  .page-wrap {
    padding: 10px;
  }
  .editor-content {
    padding-bottom: 12px;
  }
  /* 卡片间距 16px -> 10px（需 !important 压过各卡片上的 inline margin-bottom） */
  .soft-card {
    margin-bottom: 10px !important;
  }
  .hero-header {
    flex-direction: column;
    align-items: flex-start;
    padding: 12px 14px;
    margin-bottom: 12px;
    border-radius: 10px;
  }
  /* 分版块：窄屏导航变横向，位于内容上方 */
  .section-layout {
    flex-direction: column;
    gap: 10px;
  }
}
</style>
