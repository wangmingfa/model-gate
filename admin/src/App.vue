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
  NModal,
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
import { getConfig, saveConfig, testConnection, authStatus, login, logout, generateKey, type ConfigDraft, type ClientKeyDraft } from './api';

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
const keys = ref<ClientKeyDraft[]>([]);
const newKeyName = ref(''); // 添加密钥时填写的名称
// 新密钥弹窗（完整密钥只在弹窗中展示一次）
const showNewKeyModal = ref(false);
const pendingKeyName = ref('');
const pendingKeyValue = ref('');
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

/** 添加密钥：填名称 → 自动生成 sk- + 32 位随机十六进制密钥 */
/** 密钥掩码：保留前 3 后 3，如 sk-****abc；短密钥全掩（与后端一致，避免明文展示） */
function maskKey(key: string): string {
  if (key.length <= 6) return '****';
  return `${key.slice(0, 3)}****${key.slice(-3)}`;
}

/** 添加密钥：填名称 → 自动生成 sk- + 32 位随机十六进制密钥，并立即保存（完整密钥只在弹窗中展示一次） */
async function addKey(): Promise<void> {
  const name = newKeyName.value.trim();
  if (!name) {
    message.warning('请先填写密钥名称');
    return;
  }
  if (keys.value.some((k) => k.name === name)) {
    message.warning(`名称 "${name}" 已存在`);
    return;
  }
  const newKey: ClientKeyDraft = { name, key: generateKey(), created_at: new Date().toISOString() };
  keys.value.push(newKey);
  newKeyName.value = '';
  await saveKeysChange(`已生成密钥 ${name} 并保存`);
  // 保存失败时 saveKeysChange 已回滚；成功则弹窗展示完整密钥（一次性，供复制）
  if (!keys.value.includes(newKey)) return;
  pendingKeyName.value = newKey.name;
  pendingKeyValue.value = newKey.key;
  showNewKeyModal.value = true;
}

/** 弹窗中的"复制"按钮：优先 Clipboard API，失败降级 execCommand */
async function copyPendingKey(): Promise<void> {
  if (await copyText(pendingKeyValue.value)) message.success('完整密钥已复制到剪贴板');
  else message.error('复制失败，请手动选择复制');
}

/** 删除密钥（已有密钥只读，只能删除），并立即保存 */
async function removeKey(index: number): Promise<void> {
  const [removed] = keys.value.splice(index, 1);
  await saveKeysChange(`已删除密钥 ${removed.name} 并保存`);
}

/** 保存 keys 变更（添加/删除即自动保存）：成功后提示，失败则拉取服务端状态回滚本地编辑 */
async function saveKeysChange(successMsg: string): Promise<void> {
  saving.value = true;
  try {
    await saveConfig(buildDraft());
    message.success(successMsg);
  } catch (e) {
    await load(); // 拉取服务端真实状态，回滚本地编辑
    message.error(`保存失败：${(e as Error).message}`);
  } finally {
    saving.value = false;
  }
}

/** 复制文本到剪贴板：优先 Clipboard API，不可用（非 HTTPS/localhost）时降级 execCommand */
async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 降级到 execCommand
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** 复制完整密钥到剪贴板（UI 不展示明文） */
async function copyKey(key: string): Promise<void> {
  if (await copyText(key)) message.success('完整密钥已复制到剪贴板');
  else message.error('复制失败，请手动选择复制');
}

/** 格式化添加时间为本地可读形式 */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

/** 由当前编辑态构造完整配置草稿（保存用） */
function buildDraft(): ConfigDraft {
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
  return {
    ...startup.value,
    default_model: defaultModel.value,
    keys: keys.value,
    providers: providerMap,
    aliases: aliasMap,
  };
}

async function onSave(): Promise<void> {
  saving.value = true;
  try {
    await saveConfig(buildDraft());
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
      <div class="editor-content">
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
        <!-- 添加：填名称，密钥自动生成 -->
        <n-space style="margin-bottom: 12px">
          <n-input v-model:value="newKeyName" placeholder="密钥名称，如 Claude / Cursor" style="width: 260px" @keyup.enter="addKey" />
          <n-button type="primary" @click="addKey">
            <template #icon><n-icon><SaveOutline /></n-icon></template>
            添加密钥
          </n-button>
        </n-space>
        <!-- 已有密钥：只读（名称/掩码/添加时间），只能删除；完整密钥仅复制不展示 -->
        <n-space vertical>
          <div
            v-for="(k, i) in keys"
            :key="k.name"
            style="display: flex; align-items: center; gap: 12px; border: 1px solid #eee; border-radius: 8px; padding: 8px 12px"
          >
            <n-tag type="primary" size="small" style="width: 110px; justify-content: center">{{ k.name }}</n-tag>
            <code style="flex: 1; min-width: 0; color: #666; font-size: 12px; word-break: break-all">{{ maskKey(k.key) }}</code>
            <span style="color: #999; font-size: 12px; white-space: nowrap">{{ formatTime(k.created_at) }}</span>
            <n-button size="tiny" @click="copyKey(k.key)">复制</n-button>
            <n-button size="tiny" type="error" quaternary @click="removeKey(i)">删除</n-button>
          </div>
          <div v-if="keys.length === 0" style="color: #999; font-size: 12px">还没有密钥，填名称添加一个（密钥自动生成）</div>
        </n-space>
      </n-card>

      <!-- 新密钥弹窗：完整密钥只在此时展示一次，供复制 -->
      <n-modal
        v-model:show="showNewKeyModal"
        preset="card"
        :style="{ width: '520px', borderRadius: '14px' }"
        :mask-closable="false"
        :close-on-esc="false"
        :title="`密钥「${pendingKeyName}」已生成`"
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
          <code style="color: #4f46e5">{{ pendingKeyValue }}</code>
        </div>
        <n-space justify="end">
          <n-button @click="showNewKeyModal = false">关闭</n-button>
          <n-button type="primary" @click="copyPendingKey">
            <template #icon><n-icon><SaveOutline /></n-icon></template>
            复制密钥
          </n-button>
        </n-space>
      </n-modal>

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
              <div style="display: flex; align-items: baseline; gap: 12px">
                <div style="width: 160px; flex-shrink: 0">
                  <n-form-item label="名称" style="margin-bottom: 0">
                    <n-input v-model:value="p.name" placeholder="如 deepseek" />
                  </n-form-item>
                </div>
                <div style="flex: 1; min-width: 0">
                  <n-form-item label="base_url" style="margin-bottom: 0">
                    <n-input
                      v-model:value="p.base_url"
                      placeholder="https://api.deepseek.com/v1"
                      style="width: 100%"
                    />
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
                    />
                  </n-form-item>
                </div>
                <div style="flex-shrink: 0">
                  <n-button
                    size="small"
                    :loading="testStates[p.name]?.testing"
                    :type="testStates[p.name]?.ok ? 'success' : 'default'"
                    @click="onTest(p)"
                  >
                    测试连接
                  </n-button>
                </div>
              </div>
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
/* 编辑区容器：底部留白，避免内容被固定悬浮的保存栏遮挡 */
.editor-content {
  padding-bottom: 110px;
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
