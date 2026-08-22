<script setup lang="ts">
import { ref, onMounted, computed, h } from 'vue';
import { useMessage, useDialog, NIcon, NDropdown } from 'naive-ui';
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
  NCollapse,
  NCollapseItem,
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
  CheckmarkCircleOutline,
  CopyOutline,
} from '@vicons/ionicons5';
import { getConfig, saveConfig, testConnection, authStatus, login, logout, generateKey, checkConfig, type ConfigDraft, type ClientKeyDraft, type ConfigIssue } from './api';

const message = useMessage();
const dialog = useDialog();

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
  /** 行级稳定 ID（本地生成，与 name 无关）：用作 v-for :key 与折叠面板 name，
   *  避免编辑 name 时 key 变化导致 Vue 重建 DOM、输入框每敲一个字符就失焦 */
  _id: string;
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

// 配置体检：检查结果的错误/告警列表；checkIssues 非空即代表已做过检查
const checking = ref(false);
const checkIssues = ref<ConfigIssue[] | null>(null);
// 由检查结果推导出的「需要标红的字段集合」
const erroredProviders = computed(
  () => new Set((checkIssues.value ?? []).filter((i) => i.target?.startsWith('provider:')).map((i) => i.target!.slice('provider:'.length))),
);
const erroredAliases = computed(
  () => new Set((checkIssues.value ?? []).filter((i) => i.target?.startsWith('alias:')).map((i) => i.target!.slice('alias:'.length))),
);
const defaultModelError = computed(() => (checkIssues.value ?? []).some((i) => i.target === 'default_model'));

/** 检查配置正确性：对服务端当前运行配置体检，结果用于页面标红与报告 */
async function onCheckConfig(): Promise<void> {
  checking.value = true;
  try {
    const r = await checkConfig();
    checkIssues.value = r.issues;
    const errors = r.issues.filter((i) => i.level === 'error');
    if (errors.length === 0) {
      if (r.issues.length === 0) message.success('配置完全正确');
      else message.success('未发现错误（仅有提示项）');
    } else {
      message.error(`发现 ${errors.length} 个错误，已在页面中标红`);
    }
  } catch (e) {
    message.error(`检查失败：${(e as Error).message}`);
  } finally {
    checking.value = false;
  }
}

const aliasOptions = computed(() => aliases.value.map((a) => ({ label: a.name, value: a.name })));
const defaultModelOptions = computed(() => aliasOptions.value);

// 测试连接状态：providerName -> { testing, result }
const testStates = ref<Record<string, { testing: boolean; result: string; ok: boolean }>>({});

// 已折叠的 provider 行 ID 集合（默认全部展开；用稳定 _id 驱动，改名/删除/重排都不错乱）
const collapsedProviders = ref(new Set<string>());

// 行级 ID 生成器（仅前端追踪用，不进配置草稿）
let providerRowSeq = 0;
function nextProviderRowId(): string {
  return `row-${++providerRowSeq}`;
}

const expandedProviderNames = computed<string[]>({
  get: () => providers.value.map((p) => p._id).filter((id) => !collapsedProviders.value.has(id)),
  set: (names) => {
    const expanded = new Set(names);
    collapsedProviders.value = new Set(providers.value.map((p) => p._id).filter((id) => !expanded.has(id)));
  },
});

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
      _id: nextProviderRowId(),
      name,
      base_url: p.base_url,
      api_key: '', // 不回填掩码：失焦保存时会把掩码串当真实密钥写回，破坏原密钥；空 = 保持原值
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
  providers.value.push({ _id: nextProviderRowId(), name: '', base_url: '', api_key: '', models: [] });
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

/** ---- 接入信息 ---- */
/** agent 用的 Base URL：admin 与网关同源部署，取浏览器 hostname + 配置端口（开发模式下
 *  页面跑在 5173，但 API 在配置端口上，不能用 location.port）；scheme 跟随当前页面
 *  （本机直连是 http，若经 https 反代访问则用 https） */
const apiBaseUrl = computed(() => {
  const scheme = window.location.protocol === 'https:' ? 'https' : 'http';
  return `${scheme}://${window.location.hostname}:${startup.value.port}/v1`;
});

async function copyApiBaseUrl(): Promise<void> {
  if (await copyText(apiBaseUrl.value)) message.success('API 地址已复制到剪贴板');
  else message.error('复制失败，请手动选择复制');
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

/** 复制完整密钥到剪贴板（后端返回原始值；列表显示时掩码，复制时用完整值） */
async function copyKey(key: string): Promise<void> {
  if (await copyText(key)) message.success('完整密钥已复制到剪贴板');
  else message.error('复制失败，请手动选择复制');
}

/** 删除密钥（已有密钥只读，只能删除），并立即保存 */
async function removeKey(index: number): Promise<void> {
  const removed = keys.value[index];
  dialog.warning({
    title: '确认删除',
    content: `确认删除密钥「${removed.name}」吗？此操作不可撤销。`,
    positiveText: '删除',
    negativeText: '取消',
    async onPositiveClick() {
      keys.value.splice(index, 1);
      await saveKeysChange(`已删除密钥 ${removed.name} 并保存`);
    },
  });
}

/** 删除 provider */
function removeProvider(index: number): void {
  const name = providers.value[index].name || `#${index + 1}`;
  dialog.warning({
    title: '确认删除',
    content: `确认删除 provider「${name}」吗？此操作不可撤销。`,
    positiveText: '删除',
    negativeText: '取消',
    async onPositiveClick() {
      providers.value.splice(index, 1);
      await autoSave({ successMsg: `已删除 provider ${name} 并保存` });
    },
  });
}

/** 删除别名 */
function removeAlias(index: number): void {
  const name = aliases.value[index].name || `#${index + 1}`;
  dialog.warning({
    title: '确认删除',
    content: `确认删除别名「${name}」吗？此操作不可撤销。`,
    positiveText: '删除',
    negativeText: '取消',
    async onPositiveClick() {
      aliases.value.splice(index, 1);
      await autoSave({ successMsg: `已删除别名 ${name} 并保存` });
    },
  });
}

/** 保存 keys 变更（添加/删除即自动保存）：委托 autoSave 统一处理 */
async function saveKeysChange(successMsg: string): Promise<void> {
  await autoSave({ successMsg });
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

/** 任意字段变更后自动保存（失焦/变更触发）；成功即落盘，失败才回滚本地编辑 */
async function autoSave(opts?: { silent?: boolean; successMsg?: string }): Promise<void> {
  saving.value = true;
  try {
    await saveConfig(buildDraft());
    if (opts?.successMsg) message.success(opts.successMsg);
    checkIssues.value = null; // 配置已变动，上一轮体检结果作废（重新检查才更新标红）
    // 成功不重新拉取：避免覆盖用户正在进行的其他编辑（连续输入/多字段同时改）
  } catch (e) {
    await load(); // 失败则拉取服务端真实状态，回滚本地编辑
    if (!opts?.silent) message.error(`保存失败：${(e as Error).message}`);
  } finally {
    saving.value = false;
  }
}

// 高频变更（动态列表逐项输入）用 400ms debounce，避免逐字符并发 PUT 造成的竞态/覆盖
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleAutoSave(opts?: { silent?: boolean; successMsg?: string }): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void autoSave(opts);
  }, 400);
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
              config.json 是唯一真相源 · 改动即时保存 + 热加载生效
            </p>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 10px">
          <n-button
            size="small"
            :loading="checking"
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

      <n-alert v-if="loadError" type="error" :title="'加载配置失败'" style="margin-bottom: 16px">
        {{ loadError }}
      </n-alert>

      <!-- 配置体检结果：检查后展示，错误项会在对应字段标红 -->
      <div v-if="checkIssues !== null" class="check-result" :class="{ 'has-error': checkIssues.some((i) => i.level === 'error') }">
        <div class="check-summary">
          <n-icon v-if="checkIssues.some((i) => i.level === 'error')" :size="18"><AlertCircleOutline /></n-icon>
          <n-icon v-else :size="18"><CheckmarkCircleOutline /></n-icon>
          <span v-if="checkIssues.some((i) => i.level === 'error')">
            发现 {{ checkIssues.filter((i) => i.level === 'error').length }} 个错误、{{ checkIssues.filter((i) => i.level === 'warning').length }} 个提示，已在下方标红
          </span>
          <span v-else-if="checkIssues.length === 0">配置完全正确</span>
          <span v-else>未发现错误（{{ checkIssues.length }} 个提示项）</span>
        </div>
        <ul v-if="checkIssues.length" class="check-list">
          <li v-for="(issue, idx) in checkIssues" :key="idx" :class="issue.level">
            <n-tag :type="issue.level === 'error' ? 'error' : 'warning'" size="small" round>
              {{ issue.level === 'error' ? '错误' : '提示' }}
            </n-tag>
            <span class="check-msg">{{ issue.message }}</span>
          </li>
        </ul>
      </div>

      <template v-if="!loadError">
        <!-- 接入信息：给 coding agent 配置用的地址，一键复制 -->
        <n-card size="small" style="margin-bottom: 16px" class="soft-card">
          <template #header>
            <span class="card-title"><n-icon :size="16"><LinkOutline /></n-icon> 接入信息（配到 coding agent 用）</span>
          </template>
          <div class="api-url-row">
            <code class="api-url">{{ apiBaseUrl }}</code>
            <n-button size="small" type="primary" @click="copyApiBaseUrl">
              <template #icon><n-icon><CopyOutline /></n-icon></template>
              复制 API 地址
            </n-button>
          </div>
          <div style="margin-top: 8px; color: #999; font-size: 12px">
            OpenAI 兼容 Base URL；API Key 在下方「下游密钥」点复制；model 填别名（未指定时用 default_model）。
          </div>
        </n-card>

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
            <div :class="{ 'field-error': defaultModelError }" style="width: 100%">
              <n-select v-model:value="defaultModel" :options="defaultModelOptions" placeholder="选择一个别名" @update:value="autoSave()" />
            </div>
          </n-form-item>
        </n-card>

      <n-card size="small" style="margin-bottom: 16px" class="soft-card">
        <template #header>
          <span class="card-title"><n-icon :size="16"><KeyOutline /></n-icon> 下游密钥（keys，agent 连入网关用）</span>
        </template>
        <!-- 添加：填名称，密钥自动生成 -->
        <n-space style="margin-bottom: 12px" class="key-add-row">
          <n-input v-model:value="newKeyName" placeholder="密钥名称，如 Claude / Cursor" style="width: 260px" @keyup.enter="addKey" />
          <n-button type="primary" @click="addKey">
            <template #icon><n-icon><SaveOutline /></n-icon></template>
            添加密钥
          </n-button>
        </n-space>
        <!-- 已有密钥：只读（名称/掩码/添加时间），只能删除；完整密钥仅在生成时弹窗展示一次 -->
        <n-space vertical>
          <div
            v-for="(k, i) in keys"
            :key="k.name"
            class="key-row"
          >
            <div class="key-top">
              <n-tag type="primary" size="small" style="width: 110px; justify-content: center" class="key-name">{{ k.name }}</n-tag>
              <code style="color: #666; font-size: 12px; word-break: break-all" class="key-value">{{ maskKey(k.key) }}</code>
            </div>
            <div class="key-bottom">
              <span style="color: #999; font-size: 12px; white-space: nowrap">{{ formatTime(k.created_at) }}</span>
              <n-button size="tiny" @click="copyKey(k.key)">复制</n-button>
              <n-button size="tiny" type="error" quaternary @click="removeKey(i)">删除</n-button>
            </div>
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
          <n-collapse v-model:expanded-names="expandedProviderNames">
            <n-collapse-item
              v-for="(p, i) in providers"
              :key="p._id"
              :name="p._id"
              arrow-placement="left"
            >
              <template #header>
                <span style="font-weight: 600">
                  provider #{{ i + 1 }}
                  <span v-if="p.name" style="font-weight: 400; color: #666">（{{ p.name }}）</span>
                </span>
              </template>
              <div
                :class="{ 'field-error': erroredProviders.has(p.name) }"
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
                  <n-button size="small" type="error" quaternary @click="removeProvider(i)">删除</n-button>
                </div>
                <div style="display: flex; align-items: baseline; gap: 12px" class="provider-name-row">
                  <div style="width: 160px; flex-shrink: 0">
                    <n-form-item label="名称" style="margin-bottom: 0">
                      <n-input v-model:value="p.name" placeholder="如 deepseek" @blur="autoSave()" />
                    </n-form-item>
                  </div>
                  <div style="flex: 1; min-width: 0" class="provider-base-url">
                    <n-form-item label="base_url" style="margin-bottom: 0">
                      <n-input
                        v-model:value="p.base_url"
                        placeholder="https://api.deepseek.com/v1"
                        style="width: 100%"
                        @blur="autoSave()"
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
                        @blur="autoSave()"
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
                  <n-dynamic-input v-model:value="p.models" placeholder="模型 id，如 deepseek-chat" style="width: 100%" @update:value="scheduleAutoSave()" />
                </n-form-item>
              </div>
            </n-collapse-item>
          </n-collapse>
          <n-button size="small" @click="addProvider">+ 添加 provider</n-button>
        </n-space>
      </n-card>

      <n-card size="small" style="margin-bottom: 16px" class="soft-card">
        <template #header>
          <span class="card-title"><n-icon :size="16"><GitBranchOutline /></n-icon> 模型别名（aliases，agent 只认别名）</span>
        </template>
        <n-space vertical>
          <div v-for="(a, i) in aliases" :key="i" :class="{ 'field-error': erroredAliases.has(a.name) }" style="border: 1px solid #eee; border-radius: 8px; padding: 12px">
            <n-space justify="space-between" align="center">
              <span style="font-weight: 600">alias #{{ i + 1 }}</span>
              <n-button size="small" type="error" quaternary @click="removeAlias(i)">删除</n-button>
            </n-space>
            <n-space>
              <n-form-item label="别名" style="margin-bottom: 0">
                <n-input v-model:value="a.name" placeholder="如 fast" style="width: 160px" @blur="autoSave()" />
              </n-form-item>
            </n-space>
            <n-form-item label="目标（有序，failover 顺序，每行一个 provider:model）">
              <n-dynamic-input
                v-model:value="a.targets"
                placeholder="如 deepseek:deepseek-chat"
                style="width: 100%"
                @update:value="scheduleAutoSave()"
              />
            </n-form-item>
          </div>
          <n-button size="small" @click="addAlias">+ 添加别名</n-button>
        </n-space>
      </n-card>
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

/* 体检出错的字段：红色边框 + 柔和红光，直观定位问题处 */
.field-error {
  border-color: #e5484d !important;
  box-shadow: 0 0 0 3px rgba(229, 72, 77, 0.18) !important;
}

/* 检查配置正确性结果框 */
.check-config-btn {
  color: #fff;
  background: rgba(255, 255, 255, 0.16);
  border: 1px solid rgba(255, 255, 255, 0.35);
}
.check-config-btn:hover {
  color: #fff;
  background: rgba(255, 255, 255, 0.28);
}
.check-result {
  border: 1px solid #e3e8ef;
  border-radius: 12px;
  padding: 12px 16px;
  margin-bottom: 16px;
  background: #fff;
}
.check-result.has-error {
  border-color: #f5b5b8;
  background: #fff7f7;
}
.check-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: #1f2937;
}
.check-result.has-error .check-summary {
  color: #c0392b;
}
.check-list {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.check-list li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  line-height: 1.5;
}
.check-list li.warning .check-msg {
  color: #8a6d3b;
}
.check-list li.error .check-msg {
  color: #b03a2e;
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

/* ---- 密钥列表行：两行布局（名称+掩码 第一行，时间+操作 第二行）---- */
.key-add-row {
  flex-wrap: wrap;
}
/* 接入信息：API 地址行 */
.api-url-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.api-url {
  flex: 1;
  font-size: 14px;
  padding: 6px 10px;
  background: #f5f5f5;
  border-radius: 6px;
  word-break: break-all;
  user-select: all;
}

.key-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid #eee;
  border-radius: 8px;
  padding: 8px 12px;
}
.key-top {
  display: flex;
  align-items: center;
  gap: 12px;
}
.key-bottom {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* ---- 移动端适配：窄屏下仍保持两行，横向放不下时自动换行，不强制竖排成一列 ---- */
@media (max-width: 600px) {
  .key-top {
    flex-wrap: wrap;
    gap: 8px;
  }
  .key-bottom {
    flex-wrap: wrap;
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
  .hero-header {
    flex-direction: column;
    align-items: flex-start;
    padding: 16px;
  }
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
