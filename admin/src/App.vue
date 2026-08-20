<script setup lang="ts">
import { ref, onMounted, computed, h } from 'vue';
import { useMessage, NIcon, NDropdown } from 'naive-ui';
import {
  NCard,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NSelect,
  NButton,
  NSpace,
  NDivider,
  NDynamicInput,
  NAlert,
  NTag,
  NStatistic,
} from 'naive-ui';
import {
  SettingsOutline,
  RocketOutline,
  LogOutOutline,
  SaveOutline,
  ServerOutline,
  KeyOutline,
  GitBranchOutline,
  LinkOutline,
  LockClosedOutline,
  AlertCircleOutline,
  PersonCircleOutline,
} from '@vicons/ionicons5';
import { getConfig, saveConfig, testConnection, authStatus, login, logout, type ConfigDraft } from './api';

const message = useMessage();

// ---- 登录态：未配密码 → 提示去配置文件 / 配了未登录 → 登录表单 / 已登录 → 编辑界面 ----
const authState = ref<'checking' | 'need-password' | 'need-login' | 'ok'>('checking');
const configPath = ref('config.json');
const loginPassword = ref('');
const loginError = ref('');
const loginBusy = ref(false);

async function checkAuth(): Promise<void> {
  try {
    const st = await authStatus();
    configPath.value = st.configPath;
    if (st.loggedIn) {
      authState.value = 'ok';
      await load();
    } else if (!st.passwordConfigured) {
      authState.value = 'need-password';
    } else {
      authState.value = 'need-login';
    }
  } catch {
    authState.value = 'need-login';
  }
}

async function onLogin(): Promise<void> {
  loginBusy.value = true;
  loginError.value = '';
  try {
    await login(loginPassword.value);
    loginPassword.value = '';
    await checkAuth();
  } catch (e) {
    loginError.value = (e as Error).message;
  } finally {
    loginBusy.value = false;
  }
}

async function onLogout(): Promise<void> {
  try {
    await logout();
  } catch {
    // 忽略，前端直接回到登录页
  }
  authState.value = 'need-login';
}

// 右上角用户菜单（登出收敛到菜单里，不与保存按钮并列）
const userMenuOptions = [
  {
    label: '登出',
    key: 'logout',
    icon: () => h(NIcon, null, { default: () => h(LogOutOutline) }),
  },
];
function onUserMenuSelect(key: string): void {
  if (key === 'logout') void onLogout();
}

// ---- 编辑态（键值对象转成可编辑行）----
interface ProviderRow {
  name: string;
  base_url: string;
  api_key: string;
  models: string[];
}
interface AliasRow {
  name: string;
  targets: string[];
}

const startup = ref<{ port: number; host: string; timeout_seconds: number; access_log: boolean }>({
  port: 8787,
  host: '127.0.0.1',
  timeout_seconds: 60,
  access_log: true,
});
const defaultModel = ref('');
const keys = ref<string[]>([]);
const providers = ref<ProviderRow[]>([]);
const aliases = ref<AliasRow[]>([]);
const loading = ref(true);
const saving = ref(false);
const loadError = ref('');

const aliasOptions = computed(() => aliases.value.map((a) => ({ label: a.name, value: a.name })));
const defaultModelOptions = computed(() => aliasOptions.value);

// 测试连接状态：providerName -> { testing, result }
const testStates = ref<Record<string, { testing: boolean; result: string; ok: boolean }>>({});

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    const cfg = await getConfig();
    startup.value = {
      port: cfg.port,
      host: cfg.host,
      timeout_seconds: cfg.timeout_seconds,
      access_log: cfg.access_log,
    };
    defaultModel.value = cfg.default_model;
    keys.value = [...cfg.keys];
    providers.value = Object.entries(cfg.providers).map(([name, p]) => ({
      name,
      base_url: p.base_url,
      api_key: p.api_key,
      models: [...p.models],
    }));
    aliases.value = Object.entries(cfg.aliases).map(([name, targets]) => ({ name, targets: [...targets] }));
  } catch (e) {
    loadError.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

onMounted(checkAuth);

function addProvider(): void {
  providers.value.push({ name: '', base_url: '', api_key: '', models: [] });
}
function addAlias(): void {
  aliases.value.push({ name: '', targets: [] });
}

async function onTest(provider: ProviderRow): Promise<void> {
  const firstModel = provider.models[0];
  if (!firstModel) {
    message.warning('该 provider 还没有模型，先添加模型');
    return;
  }
  testStates.value[provider.name] = { testing: true, result: '', ok: false };
  try {
    const r = await testConnection(provider.name, firstModel);
    testStates.value[provider.name] = {
      testing: false,
      ok: r.ok,
      result: r.ok ? `连接成功（${r.ms}ms，模型 ${firstModel}）` : `失败：${r.error ?? `HTTP ${r.status}`}`,
    };
  } catch (e) {
    testStates.value[provider.name] = { testing: false, ok: false, result: (e as Error).message };
  }
}

async function onSave(): Promise<void> {
  saving.value = true;
  try {
    // 行 -> 键值对象（后端仍会做完整校验，这里只保证结构合法）
    const providerMap: ConfigDraft['providers'] = {};
    for (const p of providers.value) {
      if (!p.name) throw new Error('provider 名称不能为空');
      providerMap[p.name] = { base_url: p.base_url, api_key: p.api_key, models: p.models };
    }
    const aliasMap: ConfigDraft['aliases'] = {};
    for (const a of aliases.value) {
      if (!a.name) throw new Error('别名名称不能为空');
      aliasMap[a.name] = a.targets;
    }
    const draft: ConfigDraft = {
      ...startup.value,
      default_model: defaultModel.value,
      keys: keys.value,
      providers: providerMap,
      aliases: aliasMap,
    };
    await saveConfig(draft);
    message.success('已保存，热加载生效');
    await load(); // 重新拉取（密钥会重新掩码）
  } catch (e) {
    message.error((e as Error).message);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div style="max-width: 900px; margin: 0 auto; padding: 24px">
    <!-- 未配密码：提示去配置文件配置 admin_password -->
    <n-card v-if="authState === 'need-password'" title="需要配置密码" style="max-width: 480px; margin: 80px auto" class="auth-card">
      <div class="auth-icon warn"><n-icon :size="30"><AlertCircleOutline /></n-icon></div>
      <n-alert type="warning" style="margin-bottom: 16px">
        尚未配置管理密码。非本机访问管理界面需要密码保护，请先在配置文件
        <code style="background: #f5f5f5; padding: 0 4px; border-radius: 3px">{{ configPath }}</code>
        中设置 <code style="background: #f5f5f5; padding: 0 4px; border-radius: 3px">admin_password</code> 字段
        （支持 <code>${ENV_VAR}</code> 环境变量引用），保存后热加载生效，再刷新本页登录。
      </n-alert>
      <n-button type="primary" block @click="checkAuth">刷新</n-button>
    </n-card>

    <!-- 配了密码但未登录：登录表单 -->
    <n-card v-else-if="authState === 'need-login'" title="登录" style="max-width: 480px; margin: 80px auto" class="auth-card">
      <div class="auth-icon"><n-icon :size="30"><LockClosedOutline /></n-icon></div>
      <n-form @submit.prevent="onLogin">
        <n-form-item label="管理密码">
          <n-input
            v-model:value="loginPassword"
            type="password"
            show-password-on="click"
            placeholder="请输入 admin_password"
            @keyup.enter="onLogin"
          />
        </n-form-item>
        <n-alert v-if="loginError" type="error" style="margin-bottom: 12px">{{ loginError }}</n-alert>
        <n-button type="primary" block :loading="loginBusy" @click="onLogin">登录</n-button>
      </n-form>
    </n-card>

    <!-- 已登录：配置编辑界面 -->
    <template v-else-if="authState === 'ok'">
      <div class="hero-header">
        <div class="hero-left">
          <div class="hero-logo"><n-icon :size="26"><RocketOutline /></n-icon></div>
          <div>
            <h2 style="margin: 0">model-gate 配置</h2>
            <p style="margin: 2px 0 0; font-size: 12px; opacity: 0.85">
              config.json 是唯一真相源 · 保存即校验 + 热加载生效
            </p>
          </div>
        </div>
        <n-dropdown trigger="click" :options="userMenuOptions" @select="onUserMenuSelect">
          <n-button quaternary circle size="small" aria-label="用户菜单">
            <n-icon :size="22"><PersonCircleOutline /></n-icon>
          </n-button>
        </n-dropdown>
      </div>

      <n-alert v-if="loadError" type="error" :title="'加载配置失败'" style="margin-bottom: 16px">
        {{ loadError }}
      </n-alert>

      <template v-if="!loadError">
        <n-card size="small" style="margin-bottom: 16px" class="soft-card">
          <template #header>
            <span class="card-title"><n-icon :size="16"><SettingsOutline /></n-icon> 基本设置</span>
          </template>
          <n-space size="large">
            <n-statistic label="端口" :value="startup.port" />
            <n-statistic label="监听地址" :value="startup.host" />
            <n-statistic label="超时（秒）" :value="startup.timeout_seconds" />
            <n-statistic label="access.log" :value="startup.access_log ? '开' : '关'" />
          </n-space>
          <div style="margin-top: 12px; color: #999; font-size: 12px">
            以上为启动参数，只读展示；修改需编辑 config.json 后重启服务。
          </div>
          <n-form-item label="默认模型（agent 未指定 model 时使用）" style="margin-top: 12px">
            <n-select v-model:value="defaultModel" :options="defaultModelOptions" placeholder="选择一个别名" />
          </n-form-item>
        </n-card>

      <n-card size="small" style="margin-bottom: 16px" class="soft-card">
        <template #header>
          <span class="card-title"><n-icon :size="16"><KeyOutline /></n-icon> 下游密钥（keys，agent 连入网关用）</span>
        </template>
        <n-dynamic-input v-model:value="keys" placeholder="sk-xxx" />
      </n-card>

      <n-card size="small" style="margin-bottom: 16px" class="soft-card">
        <template #header>
          <span class="card-title"><n-icon :size="16"><ServerOutline /></n-icon> 上游运营商（providers）</span>
        </template>
        <n-space vertical>
          <div v-for="(p, i) in providers" :key="i" style="border: 1px solid #eee; border-radius: 8px; padding: 12px">
            <n-space vertical>
              <n-space justify="space-between" align="center">
                <span style="font-weight: 600">provider #{{ i + 1 }}</span>
                <n-button size="small" type="error" quaternary @click="providers.splice(i, 1)">删除</n-button>
              </n-space>
              <n-space>
                <n-form-item label="名称" style="margin-bottom: 0">
                  <n-input v-model:value="p.name" placeholder="如 deepseek" style="width: 160px" />
                </n-form-item>
                <n-form-item label="base_url" style="margin-bottom: 0; flex: 1">
                  <n-input v-model:value="p.base_url" placeholder="https://api.deepseek.com/v1" />
                </n-form-item>
              </n-space>
              <n-space align="center">
                <n-form-item label="api_key（留空保持原值）" style="margin-bottom: 0; flex: 1">
                  <n-input
                    v-model:value="p.api_key"
                    type="password"
                    show-password-on="click"
                    placeholder="留空保持原值"
                  />
                </n-form-item>
                <n-button
                  size="small"
                  :loading="testStates[p.name]?.testing"
                  :type="testStates[p.name]?.ok ? 'success' : 'default'"
                  @click="onTest(p)"
                >
                  测试连接
                </n-button>
              </n-space>
              <div v-if="testStates[p.name]?.result" style="font-size: 12px">
                <n-tag :type="testStates[p.name]?.ok ? 'success' : 'error'" size="small">
                  {{ testStates[p.name]?.result }}
                </n-tag>
              </div>
              <n-form-item label="模型列表">
                <n-dynamic-input v-model:value="p.models" placeholder="模型 id，如 deepseek-chat" style="width: 100%" />
              </n-form-item>
            </n-space>
          </div>
          <n-button size="small" @click="addProvider">+ 添加 provider</n-button>
        </n-space>
      </n-card>

      <n-card size="small" style="margin-bottom: 16px" class="soft-card">
        <template #header>
          <span class="card-title"><n-icon :size="16"><GitBranchOutline /></n-icon> 模型别名（aliases，agent 只认别名）</span>
        </template>
        <n-space vertical>
          <div v-for="(a, i) in aliases" :key="i" style="border: 1px solid #eee; border-radius: 8px; padding: 12px">
            <n-space justify="space-between" align="center">
              <span style="font-weight: 600">alias #{{ i + 1 }}</span>
              <n-button size="small" type="error" quaternary @click="aliases.splice(i, 1)">删除</n-button>
            </n-space>
            <n-space>
              <n-form-item label="别名" style="margin-bottom: 0">
                <n-input v-model:value="a.name" placeholder="如 fast" style="width: 160px" />
              </n-form-item>
            </n-space>
            <n-form-item label="目标（有序，failover 顺序，每行一个 provider:model）">
              <n-dynamic-input
                v-model:value="a.targets"
                placeholder="如 deepseek:deepseek-chat"
                style="width: 100%"
              />
            </n-form-item>
          </div>
          <n-button size="small" @click="addAlias">+ 添加别名</n-button>
        </n-space>
      </n-card>
      </template>

      <!-- 保存：页面底部固定悬浮栏，滚动时始终可见 -->
      <div class="floating-save">
        <n-button type="primary" size="large" :loading="saving" @click="onSave">
          <template #icon><n-icon><SaveOutline /></n-icon></template>
          保存
        </n-button>
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

/* 保存按钮：页面底部固定悬浮栏，滚动时始终可见 */
.floating-save {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  justify-content: center;
  padding: 14px 16px calc(14px + env(safe-area-inset-bottom, 0px));
  background: linear-gradient(to top, rgba(255, 255, 255, 0.95), rgba(255, 255, 255, 0.75));
  backdrop-filter: blur(8px);
  border-top: 1px solid rgba(99, 102, 241, 0.15);
  z-index: 100;
}
/* 内容区底部留白，避免被悬浮栏遮挡 */
.hero-header + * {
  padding-bottom: 96px;
}

/* 卡片美化：圆角 + 柔和阴影 + hover 微浮起 */
.soft-card {
  border-radius: 14px;
  box-shadow: 0 4px 16px rgba(99, 102, 241, 0.08);
  transition: box-shadow 0.2s ease, transform 0.2s ease;
}
.soft-card:hover {
  box-shadow: 0 8px 24px rgba(99, 102, 241, 0.16);
  transform: translateY(-2px);
}

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
